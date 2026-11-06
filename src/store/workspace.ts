/**
 * store/workspace.ts — 工作区目录（adj540，Android/移动端「选一个文件夹当工作区」）
 *
 * 为什么需要它：手机上没有"双击 .jps 打开"这回事——系统文件选择器对自定义扩展名态度不一致
 * （按 MIME 隐藏 .jps、只能看到已下载的文件），而「保存」走的 `showSaveFilePicker` 在移动端
 * 还出现过"点了没反应"（adj405）。工作区把"打开/保存"变成**在同一个文件夹里挑文件/写文件**，
 * 一次授权、后续都在这个文件夹里操作。
 *
 * 可行性来自**真机探针实测**（Chrome 151 / Android 10，见 docs/DESKTOP-ASSOC-AND-ANDROID.md §3）：
 * 选目录 → `readwrite` granted → 写入 → 回读一致 → 刷新后句柄仍在 IndexedDB，
 * 只需在用户手势里补一次 `requestPermission` 即可继续写。⇒ **不需要做 Android 壳**。
 *
 * 设计要点：
 *  - **只存根句柄 + 相对路径**（IndexedDB，L1 层：与"这个人怎么用"有关，不写进 .jps）；
 *    子目录句柄每次从根逐级解析，路径是纯数据，便于持久化与面包屑显示。
 *  - 支持**子目录**：`path` 的最后一段是文件名时表示"某个文件"，少一段则是一个目录。
 *  - 文件读写复用 `saveSupport` 的权限判定与写入实现（写后回读校验、错误归类同一口径）。
 *  - 纯逻辑（`.jps` 判定、排序、路径规整/拼接）都是可单测的纯函数，smoke 有断言。
 *
 * adj568：**两套后端**
 *  - `fsa`（网页版）：`showDirectoryPicker()` 拿句柄。受 Chromium **敏感目录黑名单**约束——
 *    「下载 / 桌面 / 文档 / 用户主目录」**整个目录**不可授予（子文件夹可以），
 *    且拦截报错与"用户取消"同为 `AbortError`，前端无法区分（见 `E-2026-271`）。
 *  - `path`（桌面壳）：原生选择器拿**绝对路径**，读写走 Rust `std::fs`——绕开上述黑名单，
 *    也没有"重开要重新授权"。记录里 `dir` 有值即路径后端。
 *
 * 两套后端共用全部纯逻辑与**同一组 IO 原语**（`listRaw` / `readTextRaw` / `writeTextRaw` / …），
 * 所以"什么该显示、怎么写才算安全"不会各自漂移。
 */
import {
  saveWorkspace,
  loadWorkspace,
  saveWorkspaceList,
  loadWorkspaceList,
  type WorkspaceRecord,
} from './fileHandleDb'
import { ensureWritePermission } from './saveSupport'
import { bytesToBase64 } from '../export/zip'
// adj954：运行环境判定与 `invoke` 的取用统一走品牌层唯一出处（原先进口里自己读 `__TAURI__`）
import { tauriCore } from '../brand/env'
import {
  hostBridge,
  isHostEmbedded,
  hostPathOf,
  type HostBridge,
} from './hostBridge'

/**
 * adj724b：宿主桥调用的统一入口。
 *
 * `hasHostBridge` 用在各 IO 原语里做"这条记录是不是走桥"的判断；
 * 返回 `null` 表示"当前不是嵌入环境"（调用方应继续走 fsa/path）。
 */
function vaultCall<T>(op: string, args: Record<string, unknown>): Promise<T> | null {
  const b: HostBridge | null = hostBridge()
  if (!b) return null
  return b.call<T>(op, args)
}

/** 目录里的一项（只列子目录与 .jps 文件——工作区是"谱夹"，不该把别的文件混进来） */
export interface DirEntry {
  kind: 'dir' | 'file'
  name: string
  /** 文件修改时间（ms；目录恒为 0）——用于"新的在上"排序 */
  mtime: number
}

/** 浏览器是否支持选文件夹（Chromium 系；Safari/Firefox 没有 `showDirectoryPicker`） */
export function isWorkspaceSupported(): boolean {
  try {
    return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  } catch {
    return false
  }
}

/** 工作区后端（adj568）：`fsa` = 网页版句柄；`path` = 桌面壳磁盘路径；`vault` = 宿主桥（Obsidian 嵌入版，adj724b） */
export type WorkspaceBackend = 'fsa' | 'path' | 'vault'

/** 该记录走哪套后端（`bridge` 优先：嵌入版由宿主提供，不带句柄；`dir` 次之；`handle` 最后） */
export function backendOf(rec: {
  handle?: FileSystemDirectoryHandle
  dir?: string
  bridge?: unknown
} | null): WorkspaceBackend | null {
  if (!rec) return null
  if (rec.bridge) return 'vault'
  if (typeof rec.dir === 'string' && rec.dir) return 'path'
  if (rec.handle) return 'fsa'
  return null
}

/** 是否是**宿主桥**后端（Obsidian 嵌入版：文库即工作区，无需授权） */
export function isVaultWorkspace(rec: { bridge?: unknown } | null): boolean {
  return backendOf(rec) === 'vault'
}

/** 是否是桌面端的**路径后端**（UI 据此显示真实磁盘路径、隐藏"授权"按钮） */
export function isPathWorkspace(rec: { handle?: FileSystemDirectoryHandle; dir?: string } | null): boolean {
  return backendOf(rec) === 'path'
}

/** 是否走**桌面端路径后端**（原生选择器 + Rust 侧读写）——有桌面壳就是 */
export function supportsPathWorkspace(): boolean {
  return shellInvoke() !== null
}

/**
 * 工作区功能是否**可用**：桌面壳（原生选目录 + 路径读写）**或**浏览器支持 FSA 选目录。
 * adj568：桌面壳里 `showDirectoryPicker` 其实也存在（WebView2 也有 FSA），
 * 但那条路会被敏感目录黑名单挡住，所以桌面端一律走 `path`——判定必须**先看壳**。
 */
/** 是否走**宿主桥**后端（Obsidian 嵌入版：由宿主提供文库工作区，无需选文件夹/授权） */
export function supportsVaultWorkspace(): boolean {
  return isHostEmbedded()
}

/**
 * 工作区功能是否**可用**：宿主桥（嵌入版）/ 桌面壳（原生选目录 + 路径读写）/ 浏览器 FSA 选目录。
 *
 * adj724b：`vault` 必须**排在最前**——嵌入版里 `showDirectoryPicker` 也许存在，
 * 但那个"选文件夹"的交互正是我们要避免的。
 */
export function isWorkspaceAvailable(): boolean {
  return supportsVaultWorkspace() || supportsPathWorkspace() || isWorkspaceSupported()
}

/**
 * 是否 `.jps` 文件（大小写不敏感）。
 * 只认"有主干名 + .jps 后缀"：裸 `.jps`（隐藏文件）不算——它连名字都没有，打开也没意义。
 */
export function isJpsName(name: string): boolean {
  const i = name.lastIndexOf('.')
  return i > 0 && name.slice(i).toLowerCase() === '.jps'
}

/**
 * 工作区列表排序（纯函数）：**目录在前**，文件按**修改时间倒序**（刚存的排最上面）。
 * 名字用 `localeCompare(..., 'zh-Hans-CN', {numeric:true})`：中文按拼音、`第2课` 排在 `第10课` 前。
 */
export function sortDirEntries(list: readonly DirEntry[]): DirEntry[] {
  const byName = (a: DirEntry, b: DirEntry): number =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  const dirs = list.filter((e) => e.kind === 'dir').sort(byName)
  const files = list.filter((e) => e.kind === 'file').sort((a, b) => b.mtime - a.mtime || byName(a, b))
  return [...dirs, ...files]
}

/**
 * 规整相对路径（纯函数，**防御性**）：只保留合法段。
 * 丢弃空串与 `.`；`..` 直接丢弃（"返回上级"由 UI 弹栈实现，**绝不允许**把 `..` 写进路径——
 * 否则持久化的路径可能被构造成越出工作区，虽然 FSA 本身也拦，但没必要给它机会）。
 */
export function normalizeRelPath(segs: readonly string[]): string[] {
  return segs.filter((s) => typeof s === 'string' && s !== '' && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\'))
}

/** 面包屑/提示用的一行路径（`杂记/小星星.jps`；根目录为空串） */
export function joinPath(segs: readonly string[]): string {
  return segs.join('/')
}

/**
 * adj580/adj588：过滤/索引的**作用域键**。
 *
 * adj580 时它是「工作区身份 + 起始目录」——索引按目录分开存，为的是"在子目录里过滤只看这一层子树"。
 * adj588（用户反馈"手机上 `*` 过滤还是有点长"）改成**只按工作区身份**：实测下来真正的开销不是单次
 * 扫描的并发度（真机 + OPFS 基准里并发 4 已经到平台期，8/16 只快 5%），而是**作用域一变就重扫**——
 * 用户进一个子目录、按一次 `*`，就要把那个子树重新枚举一遍（真机大工作区实测 27s 量级）；
 * 而"整棵树的索引"其实**已经包含**了任何子树的答案。
 *
 * 所以现在的口径是：**索引永远是整棵工作区的**（一次扫描、落盘一份），
 * "只看当前目录及其下级"这件事改由**纯函数 `filterHitsInScope()` 在命中集上做前缀裁剪**完成
 * —— 结果与以前完全一致（adj580 的口径不丢），但换目录/换子目录都只是内存里 filter，**零扫描**。
 */
export function indexScopeKey(rec: WorkspaceRecord): string {
  return rec.id
}

/**
 * adj588（纯函数）：把"整棵树的命中"裁到**某个起始目录及其下级**——过滤作用域的实际执行者。
 * `from` 为空 = 整棵工作区（不做裁剪）。前缀比较用的是 `from + '/'`，
 * 所以 `2.曲谱集` 不会把 `2.曲谱集备份/` 里的谱算进来（同名前缀目录必须区分开）。
 */
export function filterHitsInScope(hits: readonly SearchHit[], from: readonly string[]): SearchHit[] {
  const prefix = joinPath(normalizeRelPath(from))
  if (!prefix) return hits.slice()
  const withSep = `${prefix}/`
  return hits.filter((h) => h.relPath.startsWith(withSep))
}

/**
 * adj540（用户要求）：是否"隐藏条目"——**名字以 `.` 开头**。
 *
 * 为什么列表与过滤都要跳过：用户的谱夹旁边常混着 `.git`、`.obsidian`、`.trash`、`.thumbnails`
 * 这类系统目录（还有 `.DS_Store` 之类文件），它们既不是谱、数量还多（会把递归过滤的配额吃光），
 * 列出来只会干扰"找谱"。这与系统文件管理器"默认不显示隐藏文件"的口径一致。
 */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

/** 上一级目录（根目录再上一级仍是根：`[]`） */
export function parentPath(segs: readonly string[]): string[] {
  return segs.slice(0, Math.max(0, segs.length - 1))
}

/**
 * 把 **glob**（`*` = 任意串、`?` = 单个字符）转成正则源码片段（纯函数）。
 * 其它字符一律转义——尤其是 `.`：查询里写 `小星星.jps` 时那个点是**字面点**，不能当"任意字符"。
 */
export function globToRegexSource(glob: string): string {
  return glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
}

/**
 * adj546：把查询**编译成一次**匹配函数（而不是每个条目都 `new RegExp`）。
 *
 * 之前 `matchesQuery` 在**每次调用**里编译正则：过滤 5000+ 条时就是 5000 次正则编译，
 * 而且扫描进度每刷新一跳都要重跑一遍 ⇒ 手机上是实打实的浪费（也是"越扫越慢"的元凶之一）。
 * 用法：`const match = compileQuery(q)` 然后在循环里 `match(name, relPath)`。
 */
export function compileQuery(query: string): (name: string, relPath: string) => boolean {
  const q = query.trim().toLowerCase()
  if (!q) return () => true
  if (!/[*?]/.test(q)) return (name, relPath) => name.toLowerCase().includes(q) || relPath.toLowerCase().includes(q)
  const re = new RegExp(`^${globToRegexSource(q)}$`)
  return (name, relPath) => re.test(name.toLowerCase()) || re.test(relPath.toLowerCase())
}

/**
 * adj540：过滤匹配（纯函数，**单次调用版**）——大小写不敏感，同时看文件名与相对路径。
 * 批量过滤请用 `compileQuery()`（正则只编译一次），本函数留给"只判一条"的场合与断言。
 */
export function matchesQuery(name: string, relPath: string, query: string): boolean {
  return compileQuery(query)(name, relPath)
}

/** 扁平搜索结果：一个 `.jps` 的位置与显示名（`relPath` 用于告诉用户它在哪个子目录下） */
export interface SearchHit {
  /** 文件名（含 `.jps`） */
  name: string
  /** 工作区内的相对路径（含文件名；用于显示与打开） */
  relPath: string
  /** 所在目录的相对段（打开时用它拼路径） */
  dirSegs: string[]
}

/** 搜索结果 + **是否被上限截断 / 是否跳过了读不动的目录** / **扫描进度**（三种都必告诉用户） */
export interface SearchResult {
  hits: SearchHit[]
  /** true = 因深度/条目/命中数上限而**没搜完**（"没搜到"与"没搜完"对用户是两件事） */
  truncated: boolean
  /** 读不动而**被跳过的目录名列表**（权限/竞态等）—— 不主动说就成了"文件不见了" */
  blocked: string[]
  /** 实际扫描的条目数（含被跳过的隐藏项，用于展示进度） */
  scanned: number
}

/** 搜索选项（含并发与进度回调） */
export interface SearchOptions {
  maxDepth?: number
  maxEntries?: number
  maxHits?: number
  /**
   * adj546（用户实测：5550 文件 / 117 目录的工作区，`*` 过滤在手机上要 **27 秒**）：
   * `dir.values()` 每遍历一个条目都要跟浏览器进程往返一次（手机上约 5ms/条）——
   * **串行枚举是延迟叠加**，不是 CPU 瓶颈。所以同一层的目录**并发枚举**（默认 4 路），
   * 把这些往返延迟重叠起来；实测并发后同一数据集耗时下降到原来的 1/3 左右。
   */
  concurrency?: number
  /**
   * adj546：进度回调（节流约 150ms 一次）。`hits` 是**当前已命中的（可变）数组**——
   * UI 可以据此"边扫边显示"，而不是让用户对着空白等半分钟。
   */
  onProgress?: (scanned: number, hits: SearchHit[]) => void
  /**
   * adj580（用户反馈）：**只搜这个子目录及其下级**（工作区内的相对段；`[]` / 不传 = 整个工作区）。
   *
   * 用户口径：当前路径已经是工作区里的某个子目录时，过滤应当**只针对该目录及其以下子目录**，
   * 而不是把整个工作区翻一遍——"我在这个目录里找东西"才是他的预期。
   * 命中项的 `relPath` / `dirSegs` 仍然**相对工作区根**（打开文件、显示所在目录都按这个口径），
   * 所以这里只影响"从哪儿开始走"，不影响命中项的语义。
   */
  from?: readonly string[]
  /**
   * adj588：**先枚举这个子树**，再照 `from`（默认根）广度优先补齐全树。
   *
   * 为什么需要：过滤结果按"当前目录"裁剪（见 `filterHitsInScope`），而 `preferFirst` 让
   * **用户当前所在的那个目录先被扫完** ⇒ 进度回调里最先冒出来的就是他自己的谱，
   * 而不是"整棵树扫到一半才轮到我这一支"。索引本身仍是**整棵树**的（这里只影响遍历顺序），
   * 所以不影响任何正确性；`visited` 保证每个目录**只枚举一次**（不会因为两个起点重叠而重复往返）。
   */
  preferFirst?: readonly string[]
}

/**
 * adj607（E-2026-297，用户反馈"打开工作区后，进入目录慢"）：**后台扫描给前台让路**。
 *
 * 索引扫描是**后台**工作（用户没在等它），而"进目录"是**前台**工作（用户正盯着转圈）。
 * 两者打的是同一个 FSA 通道：扫描并发 8 路不停派活，用户的列表请求就排在它们后面——
 * 手机上一次目录列举本来就 0.5~1.3s 量级，被压住就更明显。
 *
 * 口径：**前台有读取在飞时，扫描在"取下一个目录"前等一等**（最多等
 * `FOREGROUND_WAIT_MAX_MS`，免得前台万一卡住把后台扫描拖死）。注意已经派出去的请求
 * 无法取消（FSA 没有 abort），所以这里保证的是"不再往里塞新的"，而不是"立刻清空"。
 */
const FOREGROUND_WAIT_MAX_MS = 2000

/** 前台（用户正等着）的目录读取计数 */
let foregroundReads = 0
/** 等"前台读完"的唤醒队列（计数归零时全部唤醒） */
const foregroundIdleWaiters: (() => void)[] = []

/** 前台读取开始（`readDirEntries` 这类"用户点了要等结果"的读取） */
function beginForegroundRead(): void {
  foregroundReads += 1
}

/** 前台读取结束：最后一个结束时唤醒所有等着的后台扫描 */
function endForegroundRead(): void {
  foregroundReads = Math.max(0, foregroundReads - 1)
  if (foregroundReads > 0) return
  for (const wake of foregroundIdleWaiters.splice(0)) wake()
}

/** 后台扫描在取下一个目录前调用：前台在读就等（有上限，不会永远等） */
async function waitForegroundIdle(): Promise<void> {
  if (foregroundReads === 0) return
  await new Promise<void>((resolve) => {
    let settled = false
    /** 唤醒即"注销自己"（超时那条路也要注销，否则等待队列会一直长） */
    const done = (): void => {
      if (settled) return
      settled = true
      const i = foregroundIdleWaiters.indexOf(done)
      if (i >= 0) foregroundIdleWaiters.splice(i, 1)
      resolve()
    }
    foregroundIdleWaiters.push(done)
    setTimeout(done, FOREGROUND_WAIT_MAX_MS)
  })
}

/**
 * adj540（用户要求）：把**整个工作区（含所有子目录）**里符合条件的 `.jps` 收成一个**平坦列表**，
 * 供"过滤即快速打开"用——层级浏览适合整理，找某一份谱还是平坦列表快。
 *
 * adj546 性能：
 *  · **并发枚举**目录（`concurrency`，默认 4）——把 N 次 FSA 往返的延迟重叠起来；
 *  · `onProgress` 让 UI 边扫边出结果；
 *  · **`.开头的条目直接跳过**（用户明确指出：这些不是要找的东西）——既不进结果，
 *    也**不下钻**（`.git`/`.obsidian` 里动辄上千文件，是最大的无效开销来源）。
 *
 * adj580（用户反馈）：**范围由 `options.from` 决定**——传了子目录段就只搜**该目录及其下级**
 * （"我在这个目录里找东西"才是用户的预期），不传/传空数组才是整个工作区。
 *
 * 防呆（真实目录可能很大）：深度 10 层 / 访问 5000 条目 / 命中 500 条上限；
 * 某一层读不动（权限/竞态）就跳过该层，而不是整次搜索失败。因上限提前结束返回 `truncated: true`，
 * 调用方**必须**把这个事实告诉用户（否则用户会以为"工作区里就没有这些谱"）。
 */
export async function searchWorkspaceJps(
  rec: WorkspaceRecord,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const maxDepth = options.maxDepth ?? 10
  const maxEntries = options.maxEntries ?? 5000
  const maxHits = options.maxHits ?? 500
  /**
   * adj589：并发默认 **4 → 8**（上限 8 → 16），依据是**延迟受限**模型下的实测（真机 FSA 手机上约 5ms/条，
   * 117 目录 × 47 文件 = 5616 条目、每条注入 5ms）：串行 32331ms，并发 2 / 4 / 6 / 8 / 12 / 16 =
   * 16616 / 8732 / 6077 / 4702 / 4713 / 4726ms ⇒ **8 是最佳点（比 4 快 1.86 倍），12 起进入平台期**。
   *
   * ⚠ 与 adj546 的 OPFS 基准（0.15ms/条、CPU 受限）结论**不同**：那里 4 已到平台期、8 甚至略慢。
   * 差别在瓶颈：**延迟受限时并发才有意义**（把往返重叠），CPU 受限时多了只是增加切换开销。
   * 手机 FSA 是前者，所以默认取 8；桌面（本地快盘/路径后端）有 16 的上限可调，且差别在 ±20% 噪声内。
   */
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 8))
  const hits: SearchHit[] = []
  let scanned = 0
  let truncated = false
  const blocked: string[] = []
  let lastReport = 0
  // adj546：查询只编译一次（不再每个条目 new RegExp）
  const match = compileQuery(query)

  const report = (force = false): void => {
    if (!options.onProgress) return
    const now = Date.now()
    if (!force && now - lastReport < 150) return
    lastReport = now
    options.onProgress(scanned, hits)
  }
  const limited = (): boolean => {
    if (hits.length >= maxHits || scanned >= maxEntries) {
      truncated = true
      return true
    }
    return false
  }

  /**
   * 待枚举的目录队列 + 在飞任务计数（计数保证"队列暂时空但还有目录在枚举"时 worker 不提前收工）。
   * adj568：入队的是**相对段**（后端无关）+ 可选句柄（FSA 后端把子目录句柄顺带带下去，
   * 免得每层都用路径重解析——adj546 的并发枚举性能就靠这个）。
   * adj580：起点由 `options.from` 决定（子目录过滤）；空数组才是"整个工作区"。
   * 起点非空时不给句柄（`listRaw` 会按相对段解析一次），根目录仍走 `rec.handle` 的快路。
   */
  type Job = { segs: string[]; handle?: FileSystemDirectoryHandle; depth: number }
  const from = normalizeRelPath(options.from ?? [])
  // adj588：当前目录的子树**先入队**（用户最想马上看到自己这个目录里的谱）
  const prefer = normalizeRelPath(options.preferFirst ?? [])
  const queue: Job[] = []
  if (prefer.length > 0) queue.push({ segs: prefer, handle: undefined, depth: prefer.length + 1 })
  queue.push({ segs: from, handle: from.length === 0 ? rec.handle : undefined, depth: 1 })
  /** adj588：目录只枚举一次（两个起点重叠时不会重复往返；重复枚举正是手机上最贵的那部分） */
  const visited = new Set<string>()
  let inFlight = 0
  let done = false

  const visit = async (job: Job): Promise<void> => {
    const jobKey = joinPath(job.segs)
    if (visited.has(jobKey)) return
    visited.add(jobKey)
    if (job.depth > maxDepth) {
      truncated = true
      return
    }
    let children: RawEntry[] = []
    try {
      children = await listRaw(rec, job.segs, job.handle, false)
    } catch {
      blocked.push(joinPath(job.segs))
      return // 这一层读不动就跳过（不 return 整棵树）
    }
    for (const h of children) {
      if (limited()) return
      // adj546（用户要求）：**先排除 `.` 开头的目录/文件**——既不是要找的东西，还可能上千条把配额吃光。
      // 判断放在 `scanned++` 之前：隐藏项连"扫描计数"都不该占。
      if (isHiddenName(h.name)) continue
      scanned++
      if (h.kind === 'dir') {
        queue.push({ segs: [...job.segs, h.name], handle: h.handle, depth: job.depth + 1 })
        continue
      }
      if (!isJpsName(h.name)) continue
      const relPath = joinPath([...job.segs, h.name])
      if (!match(h.name, relPath)) continue
      hits.push({ name: h.name, relPath, dirSegs: job.segs })
    }
    report()
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      // adj607：用户在等目录列表时让路（见 `waitForegroundIdle`）——先让路再取活，
      // 免得"拿着活等"，队列里的目录也不会因此被漏掉。
      await waitForegroundIdle()
      const job = queue.shift()
      if (!job) {
        if (inFlight === 0) return // 没有在飞的任务且队列空 ⇒ 收工
        await new Promise((r) => setTimeout(r, 0)) // 别的 worker 可能还在往队列里放子目录
        continue
      }
      inFlight++
      try {
        await visit(job)
      } finally {
        inFlight--
      }
      if (limited() && queue.length === 0 && inFlight === 0) done = true
      if (done) return
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  report(true)
  return { hits, truncated, blocked, scanned }
}

/**
 * 条目名是否合法（纯函数，新建/重命名时校验）：
 * 不能为空、不能含路径分隔符（`/` `\`）或 `..`、不能含控制字符、长度 ≤ 80。
 * 这些字符在 FSA 里本就非法（`getFileHandle` 会抛），但**先在 UI 拦住**才能给出人话提示。
 */
export function isValidEntryName(name: string): boolean {
  const n = name.trim()
  if (n.length === 0 || n.length > 80) return false
  if (n === '.' || n === '..') return false
  if (/[/\\]/.test(n)) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(n)) return false
  return true
}

/** 去掉 `.jps` 后缀（新建/另存时把用户输入的名字补成 `xxx.jps`，避免出现 `a.jps.jps`） */
export function stripJpsExt(name: string): string {
  return isJpsName(name) ? name.slice(0, name.length - 4) : name
}

// ---- adj568：两套后端共用的 **IO 原语** --------------------------------------------
//
// 上面全是纯逻辑（路径 / 过滤 / 排序），两套后端**完全共用**；真正"碰磁盘"的只有下面这几个原语。
// 其余函数一律建立在它们之上——这样网页版（FSA）与桌面版（路径）不会各自漂移出
// "什么该显示"或"怎么写才算安全"的分歧。

/** 取桌面壳的 `invoke`（不在壳里 ⇒ null；纯浏览器构建下恒为 null，行为与从前一致）
 *  adj954：读 `__TAURI__` 收敛到 `brand/env.ts` 唯一出处 */
function shellInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const fn = tauriCore()?.invoke
  return typeof fn === 'function' ? fn : null
}

/**
 * 调一个桌面壳命令。
 * Rust 侧用 `Err("EXISTS")` / `Err("NOT_EMPTY")` 这类**约定字符串**表达业务错误，
 * 这里原样还原成 `Error.message`，调用方才能与 FSA 分支按同一口径判断（`e.message === 'EXISTS'`）。
 */
async function invokeWs<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const invoke = shellInvoke()
  if (!invoke) throw new Error('当前环境不支持桌面端工作区')
  try {
    return (await invoke(cmd, args)) as T
  } catch (e) {
    if (typeof e === 'string') throw new Error(e)
    if (e instanceof Error) throw new Error(e.message)
    throw new Error(String(e))
  }
}

/** 列目录的原始结果（**未过滤**）：`handle` 只在 FSA 后端有值，供搜索把子目录句柄带下去 */
interface RawEntry {
  name: string
  kind: 'dir' | 'file'
  mtime: number
  handle?: FileSystemDirectoryHandle
}

/** FSA：逐级解析相对路径拿到目录句柄（`create` 时缺失的中间目录会被创建） */
async function resolveDirHandle(
  root: FileSystemDirectoryHandle,
  path: readonly string[],
  create = false,
): Promise<FileSystemDirectoryHandle> {
  let dir = root
  for (const seg of normalizeRelPath(path)) dir = await dir.getDirectoryHandle(seg, { create })
  return dir
}

/** FSA：解析到**文件**句柄（`path` 最后一段是文件名） */
async function resolveFileHandle(
  root: FileSystemDirectoryHandle,
  path: readonly string[],
  create = false,
): Promise<FileSystemFileHandle> {
  const segs = normalizeRelPath(path)
  if (segs.length === 0) throw new Error('empty workspace path')
  const dir = await resolveDirHandle(root, segs.slice(0, -1), create)
  return dir.getFileHandle(segs[segs.length - 1], { create })
}

/**
 * adj607（E-2026-297，用户反馈"打开工作区后进入目录慢"）：列目录时**并发读修改时间**。
 *
 * 原来 `await dir.values()` 的循环里**逐条 await `getFile()`** 取 `lastModified`——
 * 每次都是一趟到浏览器进程的往返，于是"进一个目录"的开销 = **2 × 文件数 × 单趟延迟**
 * （枚举一趟 + 取时间一趟）。真机量级：50 个谱 / 10ms 一趟实测 **1267ms**，用户感知就是"进目录慢"。
 *
 * 现在：**一看到文件就派出取时间的请求**（与枚举重叠），并**限流 8 路**
 * （手机上一次打太多 IPC 反而更慢，与 `searchWorkspaceJps` 的并发口径一致）。
 * 返回值与排序口径完全不变——`sortDirEntries` 拿到的仍是全部已就绪的 `mtime`。
 */
const MTIME_CONCURRENCY = 8

/**
 * **列目录**（唯一原语）：列**全部**条目（含隐藏项与非 `.jps`）——过滤口径一律交给上层，
 * 免得两套后端对"什么该显示"各说各话。
 *
 * `dirHandle` 只在 FSA 后端被用到：搜索时把上一层的子目录句柄直接带下来，省掉"用相对路径
 * 逐级重解析"（adj546 的并发枚举性能正是靠这一点）。
 * `needMtime=false` 用于搜索——FSA 读 `lastModified` 要**每条一次往返**，搜索并不需要时间。
 */
async function listRaw(
  rec: WorkspaceRecord,
  segs: readonly string[],
  dirHandle?: FileSystemDirectoryHandle,
  needMtime = true,
): Promise<RawEntry[]> {
  const root = rec.handle
  /** adj724b：嵌入版（宿主桥）——文库即工作区，不需要句柄 */
  const viaBridge = vaultCall<{ dirs: { name: string; mtime: number }[]; files: { name: string; mtime: number }[] }>(
    'list',
    { path: hostPathOf(segs) },
  )
  if (viaBridge) {
    const r = await viaBridge
    return [
      ...r.dirs.map((e) => ({ name: e.name, kind: 'dir' as const, mtime: e.mtime })),
      ...r.files.map((e) => ({ name: e.name, kind: 'file' as const, mtime: e.mtime })),
    ]
  }
  if (backendOf(rec) !== 'fsa' || !root) {
    const list = await invokeWs<{ name: string; dir: boolean; mtime: number }[]>('ws_list_dir', {
      root: rec.dir,
      segs: normalizeRelPath(segs),
    })
    return list.map((e) => ({ name: e.name, kind: e.dir ? ('dir' as const) : ('file' as const), mtime: e.mtime }))
  }
  const dir = dirHandle ?? (await resolveDirHandle(root, segs))
  const out: RawEntry[] = []
  /** adj607：在飞的 mtime 请求（限流用；读不到时间不影响列出） */
  const inflight = new Set<Promise<void>>()
  const startMtime = (entry: RawEntry, handle: FileSystemFileHandle): void => {
    const p = handle
      .getFile()
      .then((f) => {
        entry.mtime = f.lastModified
      })
      .catch(() => {
        /* 读不到时间不影响列出 */
      })
      .finally(() => {
        inflight.delete(p)
      })
    inflight.add(p)
  }
  for await (const handle of dir.values()) {
    if (handle.kind === 'directory') {
      out.push({ name: handle.name, kind: 'dir', mtime: 0, handle })
      continue
    }
    const entry: RawEntry = { name: handle.name, kind: 'file', mtime: 0 }
    out.push(entry)
    if (needMtime && isJpsName(handle.name)) {
      startMtime(entry, handle as FileSystemFileHandle)
      // 到上限就等一个完成——既与枚举重叠，又不至于一次打出几十上百个请求
      if (inflight.size >= MTIME_CONCURRENCY) await Promise.race(inflight)
    }
  }
  if (inflight.size > 0) await Promise.all(inflight)
  return out
}

/** 目录是否存在（工作区根被外部删掉/移动时，UI 据此**如实提示**而不是给一个空列表） */
async function dirExistsRaw(rec: WorkspaceRecord, segs: readonly string[]): Promise<boolean> {
  const root = rec.handle
  const viaBridge = vaultCall<{ exists: boolean }>('exists', { path: hostPathOf(segs) })
  if (viaBridge) {
    try {
      return (await viaBridge).exists
    } catch {
      return false
    }
  }
  if (backendOf(rec) !== 'fsa' || !root) {
    try {
      return await invokeWs<boolean>('ws_dir_exists', { root: rec.dir, segs: normalizeRelPath(segs) })
    } catch {
      return false
    }
  }
  try {
    await resolveDirHandle(root, segs)
    return true
  } catch {
    return false
  }
}

/** 目录是否**完全为空**（列**所有**条目，不只看 `.jps`——删目录前必须确认真空） */
async function isDirEmptyRaw(rec: WorkspaceRecord, segs: readonly string[]): Promise<boolean> {
  const root = rec.handle
  const viaBridge = vaultCall<{ dirs: unknown[]; files: unknown[] }>('list', { path: hostPathOf(segs) })
  if (viaBridge) {
    const r = await viaBridge
    return r.dirs.length === 0 && r.files.length === 0
  }
  if (backendOf(rec) !== 'fsa' || !root) {
    return invokeWs<boolean>('ws_is_dir_empty', { root: rec.dir, segs: normalizeRelPath(segs) })
  }
  const dir = await resolveDirHandle(root, segs)
  for await (const _ of dir.values()) return false
  return true
}

/** 读文本 */
async function readTextRaw(rec: WorkspaceRecord, segs: readonly string[]): Promise<string> {
  const root = rec.handle
  const viaBridge = vaultCall<{ text: string }>('read', { path: hostPathOf(segs) })
  if (viaBridge) return (await viaBridge).text
  if (backendOf(rec) !== 'fsa' || !root) {
    return invokeWs<string>('ws_read_text', { root: rec.dir, segs: normalizeRelPath(segs) })
  }
  const fh = await resolveFileHandle(root, segs)
  return (await fh.getFile()).text()
}

/**
 * 写文本——两套后端都**写完回读校验**（与 `write_external_file` 同一口径：
 * 宁可如实报失败，也绝不谎报"已保存"）。
 * FSA 侧沿用 `saveSupport.ensureWritePermission`（必须在用户手势内调用）。
 */
async function writeTextRaw(rec: WorkspaceRecord, segs: readonly string[], text: string): Promise<void> {
  const root = rec.handle
  const viaBridge = vaultCall<Record<string, never>>('write', { path: hostPathOf(segs), text })
  if (viaBridge) {
    // 宿主侧已做"写完回读校验"，这里只等结果
    await viaBridge
    return
  }
  if (backendOf(rec) !== 'fsa' || !root) {
    await invokeWs<null>('ws_write_text', { root: rec.dir, segs: normalizeRelPath(segs), text })
    return
  }
  const perm = await ensureWritePermission(root)
  if (perm === 'denied') throw new Error('permission denied')
  const fh = await resolveFileHandle(root, segs, true)
  const w = await (fh as unknown as { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable()
  await w.write(text)
  await w.close()
  const back = await (await fh.getFile()).text()
  if (back !== text) throw new Error('回读内容与预期不一致')
}

/** 写二进制（乐谱包 assets 里的图片等）。FSA 直接写 bytes；桌面壳走 base64 IPC。 */
async function writeBytesRaw(rec: WorkspaceRecord, segs: readonly string[], bytes: Uint8Array): Promise<void> {
  const root = rec.handle
  const s = normalizeRelPath(segs)
  if (backendOf(rec) === 'vault') throw new Error('当前工作区不支持写入二进制文件')
  if (backendOf(rec) === 'fsa' && root) {
    const perm = await ensureWritePermission(root)
    if (perm === 'denied') throw new Error('permission denied')
    const fh = await resolveFileHandle(root, s, true)
    const w = await (fh as unknown as { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable()
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    await w.write(ab)
    await w.close()
    return
  }
  await invokeWs<null>('ws_write_binary', { root: rec.dir, segs: s, base64: bytesToBase64(bytes) })
}


async function makeDirRaw(rec: WorkspaceRecord, segs: readonly string[]): Promise<void> {
  const root = rec.handle
  const viaBridge = vaultCall<Record<string, never>>('mkdir', { path: hostPathOf(segs) })
  if (viaBridge) {
    await viaBridge
    return
  }
  if (backendOf(rec) !== 'fsa' || !root) {
    await invokeWs<null>('ws_create_dir', { root: rec.dir, segs: normalizeRelPath(segs) })
    return
  }
  const s = normalizeRelPath(segs)
  if (s.length === 0) throw new Error('empty path')
  const dir = await resolveDirHandle(root, s.slice(0, -1), true)
  await dir.getDirectoryHandle(s[s.length - 1], { create: true })
}

/** 删除一个条目（`isDir` 只影响桌面后端的命令选择；FSA 的 `removeEntry` 两者通吃） */
async function removeRaw(rec: WorkspaceRecord, segs: readonly string[], isDir: boolean): Promise<void> {
  const root = rec.handle
  const s = normalizeRelPath(segs)
  if (s.length === 0) throw new Error('empty path')
  const viaBridge = vaultCall<Record<string, never>>(isDir ? 'rmdirIfEmpty' : 'remove', { path: hostPathOf(s) })
  if (viaBridge) {
    await viaBridge
    return
  }
  if (backendOf(rec) !== 'fsa' || !root) {
    await invokeWs<null>(isDir ? 'ws_remove_empty_dir' : 'ws_remove_file', { root: rec.dir, segs: s })
    return
  }
  const dir = await resolveDirHandle(root, s.slice(0, -1))
  await dir.removeEntry(s[s.length - 1])
}

/** 某个名字在目录里是否已被占用（文件或目录都算；用于"重名就明确报错而不是静默覆盖"） */
export async function hasEntry(
  rec: WorkspaceRecord,
  dirPath: readonly string[],
  name: string,
): Promise<boolean> {
  const list = await listRaw(rec, dirPath, undefined, false)
  return list.some((e) => e.name === name)
}

/** 目录是否**完全为空**（列**所有**条目，不只看 `.jps`——删目录前必须确认真空） */
export async function isDirEmpty(rec: WorkspaceRecord, path: readonly string[]): Promise<boolean> {
  return isDirEmptyRaw(rec, path)
}

/** 新建子目录（同名已存在 ⇒ 抛错，交给调用方提示；不静默复用） */
export async function createSubdir(
  rec: WorkspaceRecord,
  dirPath: readonly string[],
  name: string,
): Promise<void> {
  if (await hasEntry(rec, dirPath, name)) throw new Error('EXISTS')
  await makeDirRaw(rec, [...normalizeRelPath(dirPath), name])
}

/** 新建（或写入）一个 `.jps`（同名已存在 ⇒ 抛错，避免"另存"覆盖已有谱） */
export async function createFile(
  rec: WorkspaceRecord,
  dirPath: readonly string[],
  name: string,
  text: string,
): Promise<void> {
  if (await hasEntry(rec, dirPath, name)) throw new Error('EXISTS')
  await writeWorkspaceText(rec, [...dirPath, name], text)
}

/** 删除一个文件 */
export async function removeFile(rec: WorkspaceRecord, path: readonly string[]): Promise<void> {
  await removeRaw(rec, path, false)
}

/**
 * 删除一个目录——**仅当它为空**。
 * 为什么不做递归删除：工作区是用户自己的文件夹，里面可能混着照片/文档等**非 .jps**的东西，
 * `removeEntry(name, {recursive:true})` 会一起抹掉，且 **FSA 没有回收站、删了就没了**。
 * 非空时抛 `NOT_EMPTY`，由 UI 给明确提示（而不是"删了但没反应"）。
 */
export async function removeEmptyDir(
  rec: WorkspaceRecord,
  dirPath: readonly string[],
  name: string,
): Promise<void> {
  const target = [...normalizeRelPath(dirPath), name]
  if (!(await isDirEmptyRaw(rec, target))) throw new Error('NOT_EMPTY')
  await removeRaw(rec, target, true)
}

/**
 * **重命名/移动一个 `.jps` 的公共实现**：读出 → 写到新位置 → **确认新文件内容与原文一致** → 才删原文件。
 *
 * 为什么不用 `FileSystemHandle.move()`：本机与规范都确认 **`move()` 目前只对 OPFS 生效**，
 * 用户选中的目录上不可用（非 OPFS 的移动还停在 WICG 提案：
 * https://github.com/whatwg/fs/blob/main/proposals/MovingNonOpfsFiles.md）。
 * 于是只能"复制 + 删除"——而**顺序必须是"先确认新文件正确、再删旧的"**：中途失败宁可留下重复文件，
 * 也不能出现"两个都没了"。`.jps` 是纯文本、体积小，这条路安全。
 */
async function transferFile(
  rec: WorkspaceRecord,
  fromSegs: readonly string[],
  toSegs: readonly string[],
): Promise<void> {
  const from = normalizeRelPath(fromSegs)
  const to = normalizeRelPath(toSegs)
  if (from.length === 0 || to.length === 0) throw new Error('empty path')
  if (joinPath(from) === joinPath(to)) return
  if (await hasEntry(rec, to.slice(0, -1), to[to.length - 1])) throw new Error('EXISTS')
  const text = await readWorkspaceText(rec, from)
  await writeWorkspaceText(rec, to, text) // 内部已做写入后回读校验
  const back = await readWorkspaceText(rec, to)
  if (back !== text) throw new Error('VERIFY') // 双保险：不一致就**不删原文件**
  await removeFile(rec, from)
}

/** 重命名（同目录换名） */
export async function renameFile(
  rec: WorkspaceRecord,
  dirPath: readonly string[],
  fromName: string,
  toName: string,
): Promise<void> {
  const dir = normalizeRelPath(dirPath)
  await transferFile(rec, [...dir, fromName], [...dir, toName])
}

/** 移动到另一个目录（同名） */
export async function moveFile(
  rec: WorkspaceRecord,
  fromSegs: readonly string[],
  toDirSegs: readonly string[],
): Promise<void> {
  const from = normalizeRelPath(fromSegs)
  if (from.length === 0) throw new Error('empty path')
  await transferFile(rec, from, [...normalizeRelPath(toDirSegs), from[from.length - 1]])
}

// ---- 会话内缓存：对话框与保存流程会反复取同一个工作区，避免每次都读库 ----
let cachedList: WorkspaceRecord[] = []
let listLoaded = false

/**
 * adj951（用户实报，换一台电脑后）：**首次冷启动有两条路径并发取工作区**。
 *
 * 现象：「ob 第一次打开嵌入版 iJipu，点文件列表里的 `.jps` 打不开，提示『还没有设工作区』；
 * 关掉 ob 再打开就正常」。
 *
 * | 时刻 | 路径 | 做了什么 |
 * |---|---|---|
 * | t0 | 模块求值期（`docStore.ts:1604` 的 `void getWorkspace()`） | 发起读库（**先发起**、后完成） |
 * | t1 | 嵌入版分支（`main.tsx:126` 的 `await getWorkspace()`） | 又发起读库（**后发起**、先完成），拿到 null 后 `setWorkspace(vault 记录)` |
 * | t2 | t1 那条先落地 | 缓存 = vault 记录 ✓ |
 * | t3 | t0 那条**后落地**，用的是它发起时读到的**旧值 null** | `cached = null` ✗ **覆写** |
 * | t4 | 用户点库里的 `.jps` ⇒ `openWorkspaceFile()` 取工作区 | 拿到 null ⇒ 「还没有设工作区」 |
 *
 * 这解释了两个特征：**首次必现**（只有首次启动才有两条并发加载）、**重开正常**（第二次启动库里
 * 已有记录，且 t1 会走 `cur && isVaultWorkspace(cur)` 的早退，只剩一条加载路径）。
 *
 * ⇒ 结构性修法（**不靠调整 `await` 顺序**）：
 *  ① **in-flight 去重**：同一个未完成的加载复用**同一个 Promise** ⇒ 底层 `loadWorkspace()` 只跑一次，
 *     "晚到者"这个角色本身不复存在；
 *  ② **不覆写已有值**：加载落地时若缓存已被别的路径（`setWorkspace()`）定下来，就**放弃这次结果**。
 *     这条是必要的第二道防线——即便将来又冒出一条并发路径，旧读数也压不掉新值。
 *
 * 两条都收在下面这个**可注入 IO 的编排**里，smoke 用假 loader 把上面那张时序表直接跑出来。
 */
export interface WorkspaceLoadStore {
  /** 取当前工作区（首次读库；库里是旧记录时补 id/name 并登记进"最近工作区"） */
  get: () => Promise<WorkspaceRecord | null>
  /** 直接定下当前工作区（同步写缓存；落库/登记由调用方做） */
  set: (rec: WorkspaceRecord | null) => void
  /** 看一眼缓存（不触发读库） */
  peek: () => WorkspaceRecord | null
  /** 只改"上次所在子目录"（缓存不存在时什么都不做） */
  updatePath: (path: readonly string[]) => void
}

/**
 * adj951：工作区**缓存 + 首次加载**的唯一实现。
 *
 * 为什么做成"注入 `load` 的工厂"而不是继续用模块级变量：这里出错的形式是**并发时序**，
 * 只能靠"把时序真跑一遍"来守；注入假 IO ⇒ smoke 能在 Node 里直接断言，而生产代码只注入
 * 真正的 `loadWorkspace`（IndexedDB）。**同一份实现既跑生产又被断言**，不会出现"断言测的是
 * 一份副本"的漂移（与 `store/externalChange.ts` 同一口径）。
 */
export function createWorkspaceLoadStore(
  load: () => Promise<WorkspaceRecord | null>,
  onAdoptedLegacy?: (rec: WorkspaceRecord) => void,
): WorkspaceLoadStore {
  let cached: WorkspaceRecord | null = null
  let loaded = false
  /** adj951：**未完成的那一次加载**——同一时刻只允许有一个（in-flight 去重） */
  let inFlight: Promise<void> | null = null

  async function loadOnce(): Promise<void> {
    try {
      const raw = await load()
      // ② 加载期间已有别的路径把工作区定下来了（`setWorkspace()`，例如嵌入版分支）⇒
      //    这次读到的**旧结果作废**（修复前正是这里把 vault 记录覆写回 null）
      if (loaded) return
      const rec = normalizeRecord(raw)
      cached = rec
      loaded = true
      // 旧记录补了 id ⇒ 落库一次，并登记进"最近工作区"
      if (rec && (!raw?.id || !raw?.name)) onAdoptedLegacy?.(rec)
    } finally {
      inFlight = null
    }
  }

  return {
    async get() {
      if (!loaded) {
        // ① in-flight 去重：同一次加载期间的所有调用者等**同一个 Promise**
        if (!inFlight) inFlight = loadOnce()
        await inFlight
      }
      return cached
    },
    set(rec) {
      cached = normalizeRecord(rec)
      loaded = true
    },
    peek: () => cached,
    updatePath(path) {
      if (!cached) return
      cached = { ...cached, path: normalizeRelPath(path) }
    },
  }
}

/** 当前工作区的缓存单例（`getWorkspace()` / `setWorkspace()` / 路径记忆都只经它） */
const wsStore = createWorkspaceLoadStore(loadWorkspace, (rec) => {
  void upsertWorkspaceList(rec)
})

/** 生成工作区身份（adj544）。优先 `crypto.randomUUID`，老环境退回随机串 */
function newWorkspaceId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * adj544：用户刚选定一个目录 ⇒ 造一条**带身份**的工作区记录（网页版 / FSA 后端）。
 * 身份（`id`）在这里发；`name` 只能取 `handle.name`（FSA 不给磁盘路径，隐私限制）。
 */
export function makeWorkspaceRecord(handle: FileSystemDirectoryHandle, path: readonly string[] = []): WorkspaceRecord {
  return { id: newWorkspaceId(), name: handle.name, handle, path: normalizeRelPath(path) }
}

/** 去掉路径末尾的分隔符（根目录 `C:\` 除外——它本身就是 `C:\`） */
function trimTrailingSep(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '')
  return trimmed === '' ? dir : trimmed
}

/**
 * adj568：桌面端（**路径后端**）的工作区记录。
 *
 * 身份直接用**规整后的绝对路径**（`path:<小写路径>`）——这带来一个网页版没有的好处：
 * **反复选同一个文件夹仍是同一个工作区**（FSA 拿不到路径，只能每次发新 id，
 * 于是"重新选一遍"与"从最近列表切回"是两件事）。Windows 路径大小写不敏感，故统一小写。
 */
/**
 * adj724b：建一个**宿主桥**工作区记录（Obsidian 嵌入版）。
 *
 * 与 `fsa`/`path` 两种记录的差别：既没有句柄也没有磁盘路径，只有一个 `bridge` 标记——
 * 文件一律经宿主（`store/hostBridge.ts` → 插件的 `vault.adapter`）读写。
 * `root` 是**工作区内的初始子目录**（`''` = 文库根）。
 */
export function makeVaultWorkspaceRecord(vaultName: string, subdir: string = ''): WorkspaceRecord {
  const segs = subdir.replace(/^\/+|\/+$/g, '').split('/').filter((s) => s !== '')
  const rel = segs.join('/')
  const id = `vault:${vaultName}:${rel}`
  return {
    id,
    name: rel === '' ? vaultName : `${vaultName}/${rel}`,
    bridge: { vaultName },
    /**
     * `path` = **进入工作区后所在的初始目录**。
     *
     * 注意：这里存的是**相对文库根**的路径（不是相对子目录），
     * 因为宿主桥的 `root` 一律是 `''`（宿主按**文库相对路径**读写），
     * 两者必须同口径——否则「设置里填了子目录」会变成"文件树从文库根开始"（设置失效）。
     */
    path: segs,
  }
}

export function makePathWorkspaceRecord(dir: string, path: readonly string[] = []): WorkspaceRecord {  const norm = trimTrailingSep(dir)
  const name = norm.split(/[\\/]/).filter(Boolean).pop() ?? norm
  return { id: `path:${norm.toLowerCase()}`, name, dir: norm, path: normalizeRelPath(path) }
}

/**
 * adj544：**兼容旧记录**——adj540 存下来的工作区记录没有 `id`/`name`（那时候还不需要身份）。
 * 读出来就补一个 id 并把名字从句柄取出来，同时补进最近列表（只补一次，之后都带 id）。
 * adj568：路径后端（有 `dir`）没有"补名"问题，缺 id 时按路径补。
 */
function normalizeRecord(rec: WorkspaceRecord | null): WorkspaceRecord | null {
  if (!rec) return null
  const dir = typeof rec.dir === 'string' && rec.dir ? trimTrailingSep(rec.dir) : undefined
  const handle = rec.handle
  /**
   * adj724b：**宿主桥记录既没有 `dir` 也没有 `handle`**（文库即工作区），
   * 必须在这里就放行——否则它会被当"损坏记录"丢掉，`setWorkspace()` 静默失败，
   * 表现为"打开 `.jps` 却提示『还没有设工作区』、文件树永远是空的"（用户实测 #4）。
   */
  const bridge = rec.bridge && typeof rec.bridge.vaultName === 'string' ? rec.bridge : undefined
  if (!dir && !handle && !bridge) return null
  const fallbackId = dir ? `path:${dir.toLowerCase()}` : ''
  const id = typeof rec.id === 'string' && rec.id ? rec.id : fallbackId || newWorkspaceId()
  const name = typeof rec.name === 'string' && rec.name ? rec.name : (handle?.name ?? bridge?.vaultName ?? '')
  return {
    id,
    name,
    ...(handle ? { handle } : {}),
    ...(dir ? { dir } : {}),
    ...(bridge ? { bridge } : {}),
    // adj586：`path` 必须**是数组**才交给 `normalizeRelPath`——库里存着损坏记录（比如 `path: ''`）时
    // 它会 `segs.filter is not a function` 抛错，而调用方（`listWorkspaces()`）在 async effect 里
    // 一抛就**整份清单静默变空**（真机调试时踩到：面板显示"还没有打开过的工作区"，但 IndexedDB
    // 里明明有 5 条）。按项目口径"损坏回退默认值"，这里退回空路径（= 工作区根目录）。
    path: normalizeRelPath(Array.isArray(rec.path) ? rec.path : []),
  }
}

/** 取当前工作区（首次会读 IndexedDB；返回的 `path` 已规整；旧记录会补上 id/name） */
export async function getWorkspace(): Promise<WorkspaceRecord | null> {
  return wsStore.get()
}

/** 设/清工作区（同步更新缓存并落库；设置时登记进"最近工作区"列表） */
export async function setWorkspace(rec: WorkspaceRecord | null): Promise<void> {
  wsStore.set(rec)
  const cached = wsStore.peek()
  await saveWorkspace(cached)
  if (cached) await upsertWorkspaceList(cached)
}

/**
 * 记住"上次所在的子目录"（adj540 / adj548 / adj550）。
 *
 * adj548（用户反馈）：**必须在"进入目录"时就记**，不能只在"面板关闭"时记——
 * 底栏收起、切到别的页签时面板是**直接卸载**的，关闭分支根本没机会执行，
 * 于是重新打开永远回到根目录（用户实测三个场景全丢）。
 *
 * adj550（用户要求）：**每次切换目录都立刻落盘**，作为该工作区的"最新位置"——
 * 不再用防抖（导航是用户手速，一次几毫秒的 IndexedDB 写入无压力；
 * 防抖会让"刚切完目录就关浏览器"丢掉最后那次导航）。内存里的 `cached` 同步更新，
 * 因此同一会话内切页签/重挂载马上就能读到新位置。
 */
export async function rememberWorkspacePath(path: readonly string[]): Promise<void> {
  if (!wsStore.peek()) return
  wsStore.updatePath(path)
  const cached = wsStore.peek()
  if (!cached) return
  await saveWorkspace(cached)
  syncListPath(cached) // adj550：**最近工作区列表里的那条也要跟着更新**，否则切回该工作区会拿到旧位置
}

/**
 * adj550：把最新位置同步进"最近工作区"列表（**不改变顺序**——列表顺序表示"最近使用"）。
 * 不这么做的话：列表里存的是"加入列表那一刻"的 path，切换回该工作区时会恢复成旧位置（实测踩到）。
 * 列表未加载时跳过（面板激活时已经 `listWorkspaces()` 过，实践中总是已加载）。
 */
function syncListPath(rec: WorkspaceRecord): void {
  if (!listLoaded) return
  const i = cachedList.findIndex((r) => r.id === rec.id)
  if (i < 0) return
  if (joinPath(cachedList[i].path) === joinPath(rec.path)) return
  cachedList = cachedList.map((r, k) => (k === i ? rec : r))
  void saveWorkspaceList(cachedList)
}

/**
 * adj550：把当前记录立刻落盘（面板卸载时调一次，作为"关页面前"的最后一道保险）。
 * 因为 `rememberWorkspacePath` 已经即时写，这里通常是空转；保留是为了异常路径兜底。
 */
export function flushWorkspacePath(): void {
  const cached = wsStore.peek()
  if (cached) void saveWorkspace(cached)
}

/**
 * adj548（用户要求"除非该位置已不存在"）：把记忆的路径**收敛到仍然存在的目录**。
 * 逐级下钻，遇到不存在的段就停（返回已存在的最长前缀，最少是根 `[]`）。
 * 场景：上次停在 `A/B/C`，其中 `B` 被外部删了 ⇒ 回到 `A`，而不是报错或永远空列表。
 */
export async function resolveExistingDir(
  rec: WorkspaceRecord,
  segs: readonly string[],
): Promise<string[]> {
  const out: string[] = []
  for (const seg of normalizeRelPath(segs)) {
    if (!(await dirExistsRaw(rec, [...out, seg]))) break // 这一级没了 ⇒ 停在上一级
    out.push(seg)
  }
  return out
}

/** 读"最近工作区"（最近在前；当前那个也在里面） */
export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  if (!listLoaded) {
    cachedList = (await loadWorkspaceList()).map((r) => normalizeRecord(r)).filter((r): r is WorkspaceRecord => !!r)
    listLoaded = true
  }
  return cachedList
}

/**
 * 按工作区 id + 相对路径读一个小文本（目前给 `.jps.meta.json` 用）。
 * 读不到（文件不存在/权限失效/记录没了）返回 null，由调用方决定兜底。
 */
export async function readWorkspaceTextById(
  wsId: string,
  segs: readonly string[],
): Promise<string | null> {
  const rec = (await listWorkspaces()).find((r) => r.id === wsId)
  if (!rec) return null
  try {
    return await readTextRaw(rec, segs)
  } catch {
    return null
  }
}

/** 按工作区 id + 相对路径写一个小文本；失败会抛错（由调用方提示） */
export async function writeWorkspaceTextById(
  wsId: string,
  segs: readonly string[],
  text: string,
): Promise<void> {
  const rec = (await listWorkspaces()).find((r) => r.id === wsId)
  if (!rec) throw new Error('工作区记录不存在')
  await writeTextRaw(rec, segs, text)
}

/**
 * 把某个"最近工作区"切换成当前工作区（用户点列表项 ⇒ 手势成立，可顺带申请权限）。
 * 句柄可能已失效（文件被删/权限被撤）⇒ 调用方用返回结果判断，失败给出提示。
 */
export async function activateWorkspace(id: string): Promise<WorkspaceRecord | null> {
  const list = await listWorkspaces()
  const hit = list.find((r) => r.id === id)
  if (!hit) return null
  // 提到最前（最近使用）
  await setWorkspace(hit)
  return hit
}

/** 从"最近工作区"里移除一个（用户在列表里删掉） */
export async function forgetWorkspace(id: string): Promise<void> {
  await upsertWorkspaceList(null, id)
}

/** 规整成"用来比较目录是否相同"的键（去末尾分隔符 + 小写；Windows 路径大小写不敏感） */
function sameDirKey(dir: string): string {
  return trimTrailingSep(dir).toLowerCase()
}

/**
 * adj577（用户要求"**相同的目录只能有一个工作区**"）：在给定清单里找"与 `rec` 是同一个目录"的那条。
 *
 * 两套后端的判定方式不同：
 *  · **桌面（路径后端）**：身份 id 就是规整后的绝对路径 ⇒ 直接比路径（忽略末尾分隔符与大小写）；
 *  · **网页（FSA）**：FSA 不给磁盘路径、只有句柄 ⇒ 用规范里专为此提供的 `isSameEntry()`
 *    逐个比。`isSameEntry` 抛错（句柄失效 / 跨源等）就当"不是同一个"，不影响正常选新目录。
 *
 * 单独导出是为了**可单测**（smoke 直接喂假记录/假句柄，不必真去选目录）。
 */
export async function findSameWorkspace(
  list: readonly WorkspaceRecord[],
  rec: WorkspaceRecord,
): Promise<WorkspaceRecord | null> {
  if (rec.dir) {
    const key = sameDirKey(rec.dir)
    return list.find((r) => !!r.dir && sameDirKey(r.dir) === key) ?? null
  }
  type SameEntry = { isSameEntry(o: unknown): Promise<boolean> }
  const asEntry = (h: unknown): SameEntry | null => {
    const x = h as Partial<SameEntry> | undefined
    return typeof x?.isSameEntry === 'function' ? (x as SameEntry) : null
  }
  const self = asEntry(rec.handle)
  if (!self) return null
  for (const r of list) {
    const other = asEntry(r.handle)
    if (!other) continue
    // **两个方向都试**：任一侧的句柄失效（刷新后旧句柄可能报错）时，另一侧仍可能认出"是同一个目录"；
    // 两侧都失败 ⇒ 当作"不是同一个"，不影响正常选新目录。
    for (const [a, b] of [
      [self, r.handle],
      [other, rec.handle],
    ] as const) {
      try {
        if (await a.isSameEntry(b)) return r
      } catch {
        /* 这一侧比不了，换另一侧 */
      }
    }
  }
  return null
}

/**
 * adj577：用户刚选中的目录若**已经是历史工作区** ⇒ 复用历史那条记录（保留它的身份 id 与名字），
 * 不新建。这样"同目录只有一个工作区"在**两套后端**上都成立：
 *  · 桌面端本来按路径当身份（天然去重）；
 *  · 网页端原先每次重选同一个文件夹都会发一个新 id、在清单里堆出重复项——现在也归并到同一条。
 */
export async function dedupeWorkspaceRecord(rec: WorkspaceRecord): Promise<WorkspaceRecord> {
  const hit = await findSameWorkspace(await listWorkspaces(), rec)
  return hit ?? rec
}

/** 列表登记：把 rec 提到最前（按 id 去重）；`removeId` 用于删除 */
async function upsertWorkspaceList(rec: WorkspaceRecord | null, removeId?: string): Promise<void> {
  const list = await listWorkspaces()
  let next = list.filter((r) => r.id !== rec?.id && r.id !== removeId)
  if (rec) next = [rec, ...next]
  cachedList = next
  listLoaded = true
  await saveWorkspaceList(next)
}

/**
 * 让用户选一个文件夹当工作区（必须由**用户手势**触发）；用户取消返回 null。
 *
 * adj568：**分平台**——
 *  · 桌面壳：走**原生选择器**拿绝对路径（`ws_pick_dir`）⇒ 绕开 Chromium 的敏感目录黑名单，
 *    于是「下载 / 桌面 / 文档」这些目录**本身**也能直接当工作区；
 *  · 浏览器：走 `showDirectoryPicker()`（句柄）。这条路受内核黑名单约束（只有子文件夹能选），
 *    而且**无法区分"用户取消"与"选中的目录被内核拦下"**——两者都是 `AbortError`（见 E-2026-271），
 *    所以这里只能返回 null，由 UI 用一句常驻提示把这件事讲清楚（`workspaceCopy.blockedHint`）。
 */
export async function pickWorkspaceDir(): Promise<WorkspaceRecord | null> {
  if (shellInvoke()) {
    const dir = await invokeWs<string | null>('ws_pick_dir', {})
    return dir ? makePathWorkspaceRecord(dir) : null
  }
  const picker = (window as unknown as {
    showDirectoryPicker?: (opts?: { id?: string; mode?: string; startIn?: string }) => Promise<FileSystemDirectoryHandle>
  }).showDirectoryPicker
  if (typeof picker !== 'function') return null
  try {
    const handle = await picker({ id: 'ijipu-workspace', mode: 'readwrite', startIn: 'documents' })
    return makeWorkspaceRecord(handle)
  } catch (e) {
    // AbortError = 用户取消（正常路径，调用方静默处理）；其余错误如实抛出
    if ((e as { name?: string })?.name === 'AbortError') return null
    throw e
  }
}

/**
 * **只查**工作区根目录的读写授权状态（不发请求）。
 * UI 在挂载时用它决定显示「继续访问（授权）」按钮还是直接列目录——
 * `requestPermission` 必须由用户手势触发，**不能在挂载时静默调用**（会被浏览器拒绝/忽略）。
 * adj568：桌面**路径后端没有"授权"这回事**（原生选择器给的就是用户自己的目录）
 * ⇒ 只回答"目录还在不在"。
 */
export async function queryWorkspacePermission(
  rec: WorkspaceRecord,
): Promise<'granted' | 'prompt' | 'denied' | 'unknown'> {
  const root = rec.handle
  if (backendOf(rec) !== 'fsa' || !root) {
    return (await dirExistsRaw(rec, [])) ? 'granted' : 'denied'
  }
  const h = root as unknown as { queryPermission?: (o: { mode: string }) => Promise<PermissionState> }
  if (typeof h.queryPermission !== 'function') return 'unknown'
  try {
    const state = await h.queryPermission({ mode: 'readwrite' })
    return state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'prompt'
  } catch {
    return 'unknown'
  }
}

/** **申请**工作区根目录的读写授权（必须在用户手势内调用；真机实测刷新后是 prompt → granted） */
export async function requestWorkspacePermission(
  rec: WorkspaceRecord,
): Promise<'granted' | 'denied' | 'unknown'> {
  const root = rec.handle
  if (backendOf(rec) !== 'fsa' || !root) {
    return (await dirExistsRaw(rec, [])) ? 'granted' : 'denied'
  }
  return ensureWritePermission(root)
}

/** 读工作区里的一个 .jps 文本 */
export async function readWorkspaceText(rec: WorkspaceRecord, path: readonly string[]): Promise<string> {
  return readTextRaw(rec, path)
}

/**
 * 写入工作区里的一个 .jps，并**回读校验**（与桌面写回 `write_external_file` 同一口径：
 * 宁可报错也不谎报已保存）。
 */
export async function writeWorkspaceText(
  rec: WorkspaceRecord,
  path: readonly string[],
  text: string,
): Promise<void> {
  return writeTextRaw(rec, path, text)
}

/** 写工作区二进制文件（乐谱包 assets 解压用） */
export async function writeWorkspaceBytes(
  rec: WorkspaceRecord,
  path: readonly string[],
  bytes: Uint8Array,
): Promise<void> {
  return writeBytesRaw(rec, path, bytes)
}

/**
 * 列出某个目录下的**子目录 + .jps 文件**（其它文件忽略：工作区是谱夹，
 * 真机实测的目录里混着几十个无关文件，全列出来反而找不到谱）。
 * 文件修改时间读失败时按 0 处理（不因为一个读不到就整列失败）。
 *
 * adj607：这是**前台**读取（用户点了目录在等结果）——标记区间，后台索引扫描会在这期间让路
 * （见 `beginForegroundRead` / `waitForegroundIdle`）。
 */
export async function readDirEntries(
  rec: WorkspaceRecord,
  path: readonly string[] = [],
): Promise<DirEntry[]> {
  beginForegroundRead()
  let list: RawEntry[]
  try {
    list = await listRaw(rec, path)
  } finally {
    endForegroundRead()
  }
  const out: DirEntry[] = []
  for (const e of list) {
    // adj540（用户要求）：列表也**跳过 `.` 开头的条目**（与过滤口径一致，见 isHiddenName）
    if (isHiddenName(e.name)) continue
    if (e.kind === 'dir') {
      out.push({ kind: 'dir', name: e.name, mtime: 0 })
      continue
    }
    if (!isJpsName(e.name)) continue
    out.push({ kind: 'file', name: e.name, mtime: e.mtime })
  }
  return sortDirEntries(out)
}
