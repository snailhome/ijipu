/**
 * store/saveSupport.ts — 「保存到磁盘」底层支撑（adj363）
 *
 * 纯逻辑模块：只操作传入的 FileSystemFileHandle，不碰 store / React / DOM，
 * 因此可在 Node（scripts/smoke.mts）中用假句柄直接断言失败分类与写回校验。
 *
 * 背景（用户反馈「按保存有时没生效、必须另存为才有效」）：
 *  1. 恢复自 IndexedDB 的句柄在应用重启后写入权限可能失效，`createWritable()` 直接抛
 *     NotAllowedError；旧代码把该失败静默转「另存为」，而 `showSaveFilePicker()` 必须在
 *     **用户手势**内调用——前一次 await 已消耗手势，选择器随即抛 NotAllowedError，
 *     旧代码又把 NotAllowedError 当作「用户取消」静默吞掉 → 按保存毫无反应、文件未变。
 *  2. 写入流程本身没有回读校验：close() 成功不代表磁盘内容就是刚写的内容（写入流被中断、
 *     目标被换走等），用户会看到「已保存」但文件没变。
 *
 * 因此本模块的规则：写入前先查询/申请权限；写入后回读校验；只有 AbortError 才算用户取消。
 */

/** 保存失败分类（决定给用户什么提示、句柄是否断开） */
export type SaveFailKind = 'cancel' | 'permission' | 'gone' | 'busy' | 'verify' | 'unknown'

/** 回读校验失败时抛出的异常名（自定义，便于 classifySaveError 归类） */
const VERIFY_ERROR_NAME = 'SaveVerifyError'

/** 带权限方法的句柄视图（lib.dom 未声明 queryPermission/requestPermission，需自行收窄） */
interface PermissionCapableHandle {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
}

function errorName(e: unknown): string {
  const n = (e as { name?: unknown } | null | undefined)?.name
  return typeof n === 'string' ? n : ''
}

/** 是否用户主动取消（只有 AbortError 才算；NotAllowedError 不算——它是权限/手势问题） */
export function isUserCancel(e: unknown): boolean {
  return errorName(e) === 'AbortError'
}

/**
 * 归类保存失败：
 *  - cancel     用户取消（静默）
 *  - permission 权限失效 / 缺少用户手势（提示重新授权）
 *  - gone       文件已被移动或删除（提示另存为）
 *  - busy       文件被占用/只读/写入流状态非法（提示关闭占用程序）
 *  - verify     写入成功但回读内容不一致（提示另存为，绝不谎报已保存）
 */
export function classifySaveError(e: unknown): SaveFailKind {
  switch (errorName(e)) {
    case 'AbortError':
      return 'cancel'
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission'
    case 'NotFoundError':
      return 'gone'
    case 'NoModificationAllowedError':
    case 'InvalidModificationError':
    case 'InvalidStateError':
    case 'NotReadableError':
      return 'busy'
    case VERIFY_ERROR_NAME:
      return 'verify'
    default:
      return 'unknown'
  }
}

/** 构造一个带标准错误名的异常（避免依赖 DOMException 构造函数） */
export function namedError(name: string, message: string): Error {
  const e = new Error(message)
  e.name = name
  return e
}

/** 去掉 UTF-8 BOM（有的编辑器/系统写入时会带 BOM，比对时忽略） */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/** 写入内容与磁盘回读内容是否一致（容忍 BOM） */
export function sameContent(a: string, b: string): boolean {
  return stripBom(a) === stripBom(b)
}

/** 文件名去掉 .jps/.md/.txt/.musicxml/.xml 后缀（显示名统一不带扩展名） */
export function fileBaseName(name: string | undefined | null): string {
  return (name || '未命名').replace(/\.(jps|md|txt|musicxml|xml)$/i, '')
}

/**
 * adj399：`<input type="file">` 的 accept 过滤串；返回 null 表示**不设过滤**（全部文件可见）。
 *
 * 为什么移动端不设：`.jps` 是自定义扩展，系统没有对应 MIME 记录——Android SAF / iOS 文件 App
 * 一律**按 MIME 过滤**，accept 里无论写扩展名（`.jps`）还是 `application/octet-stream`，
 * 自家的 .jps 文件都会被隐藏或置灰（用户反馈「手机端打开对话框里看不到 .jps 文件」）。
 * 桌面浏览器按**文件名后缀**匹配（Firefox/Safari 还会额外给「所有文件」入口），过滤安全可用。
 */
export function fileInputAccept(coarsePointer: boolean): string | null {
  return coarsePointer
    ? null
    : '.jps,.musicxml,.xml,text/plain,.txt,application/xml,text/xml,application/octet-stream'
}

/**
 * adj405：是否走 `<input type="file">` 降级路径（而不是 `showOpenFilePicker`）。
 *
 * 移动端**一律走 input**，两个真机理由（用户反馈）：
 *  ① 已安装的 PWA 里 `showOpenFilePicker` 可能"点了没反应"（菜单「打开」无响应），而同一个地址在浏览器里正常；
 *  ② Android 上即便该 API 存在，打开的文件也拿不到可写回的句柄，移动端本来就走「导出」保存。
 * input 路径在所有移动环境都可靠（浏览器/PWA/自建外壳一致），桌面端仍优先用 File System Access API。
 */
export function shouldUseFileInputPicker(coarsePointer: boolean, hasFileSystemAccess: boolean): boolean {
  return coarsePointer || !hasFileSystemAccess
}

/**
 * adj399/adj540：是否**触屏/移动端**（粗指针 = 手机/PAD，另加 UA 兜底）。
 *
 * adj954：**实现已迁到 `brand/env.ts`**（那里是运行环境判定的唯一出处），本文件不再自己判、
 * 也不再转出——调用方直接 `import { isCoarsePointerDevice } from '../brand/env'`。
 * 迁移的理由与原来一样：这个判据被"文件选择策略"和"打开/另存为分流"两处共用，
 * **不许各写一份**；而它同时又属于"这台机器是什么设备"这一类事实，与 `isTauriShell()` 同源更合适。
 *
 * 两条用途（保持原样，供阅读者一眼看懂为什么要它）：
 *  ① 移动端文件管理器**按 MIME 过滤**（adj399）：`.jps` 是自定义扩展，系统没有对应 MIME 记录
 *     （Android SAF / iOS 文件 App 会当作未知类型隐藏或置灰），所以移动端 `<input type=file>` 不设 accept；
 *  ② adj540：移动端**以工作区优先**——系统选择器在手机上不可靠（adj405 + Chromium 457203705），
 *     工作区（`showDirectoryPicker`）才是主路径。
 * 注意与"输入条默认开关"那个判据的区别（`adj974` 之前是 `uiStore.detectTouch()` = 触屏**或**窄屏，
 * 现已按用户口径收成只看真手机/触屏）：无论如何都**不能**把"窄屏"算进文件选择策略 ——
 * 窄窗口的桌面 Chrome 里系统选择器是好的。
 */

/**
 * 确认句柄可写：先 queryPermission，未授权时在**用户手势内** requestPermission。
 * 返回最终状态；环境不支持权限 API 时返回 'unknown'（交给真正的写入判定）。
 * 注意：requestPermission 必须在用户手势（Ctrl+S / 菜单点击）尚未被消耗时调用。
 *
 * adj540：参数放宽到**目录句柄**也用同一个实现——工作区（`showDirectoryPicker`）授权是**目录级**的，
 * 子目录/文件句柄权限随之继承，所以只要在根目录上拿到 granted 即可（真机实测：刷新后先 `prompt`、
 * 在用户手势里 `requestPermission` 变 `granted`，再写就成功）。
 */
export async function ensureWritePermission(
  handle: FileSystemFileHandle | FileSystemDirectoryHandle,
): Promise<'granted' | 'denied' | 'unknown'> {
  const h = handle as unknown as PermissionCapableHandle
  if (typeof h.queryPermission !== 'function') return 'unknown'
  let state: PermissionState
  try {
    state = await h.queryPermission({ mode: 'readwrite' })
  } catch {
    return 'unknown'
  }
  if (state === 'granted') return 'granted'
  if (typeof h.requestPermission !== 'function') return 'denied'
  try {
    const asked = await h.requestPermission({ mode: 'readwrite' })
    return asked === 'granted' ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}

/** 回读磁盘内容做校验；读不到（无读权限等）返回 null 表示「无法校验」，不影响保存结论 */
async function readBack(handle: FileSystemFileHandle): Promise<string | null> {
  try {
    const file = await handle.getFile()
    if (typeof file.text !== 'function') return null
    return await file.text()
  } catch {
    return null
  }
}

/** 保存阶段标识（adj367：用于定位"保存耗时好几秒"卡在哪一步）
 *  - `open`/`write`/`commit`：浏览器文件写入的三步（打开写入流 / 写入数据 / 提交替换文件）
 *  - `perm`：写入被拒后申请权限
 *  - `store`/`ui`：调用方补充的尾部（写草稿名 / 更新界面状态） */
export type SavePhase = 'open' | 'write' | 'commit' | 'perm' | 'store' | 'ui'

/** 阶段耗时回调（毫秒） */
export type SaveTrace = (phase: SavePhase, ms: number) => void

/** 阶段耗时收集器（adj369：明细给控制台、瓶颈给提示） */
export interface SavePhaseLog {
  trace: SaveTrace
  /** 尾部阶段计时（与 trace 同一收集器，语义上属于调用方补充的收尾动作） */
  tail: SaveTrace
  /** 阶段明细文案（如「打开写入流 12ms · 写入数据 3ms · 提交文件 7180ms」） */
  text: () => string
  /** 已计时阶段的毫秒合计（用于推「收尾」= 总耗时 − 各阶段） */
  total: () => number
  /** 最耗时的那一段（提示里只点瓶颈，避免长文案）；无记录返回 null */
  worst: () => { phase: SavePhase; label: string; ms: number } | null
}

/** 创建阶段耗时收集器；label 由调用方提供（文案集中在 brand/copy.ts） */
export function createSavePhaseLog(label: (phase: SavePhase) => string): SavePhaseLog {
  const parts: { phase: SavePhase; label: string; ms: number }[] = []
  const push: SaveTrace = (phase, ms) => parts.push({ phase, label: label(phase), ms })
  return {
    trace: push,
    tail: push,
    text: () => parts.map((p) => `${p.label} ${Math.round(p.ms)}ms`).join(' · '),
    total: () => parts.reduce((sum, p) => sum + p.ms, 0),
    worst: () => parts.reduce<(typeof parts)[number] | null>((w, p) => (!w || p.ms > w.ms ? p : w), null),
  }
}

/**
 * 写入文本；可选回读校验 + 阶段计时。
 * 失败时抛原始异常（由 classifySaveError 归类）；`verify` 且内容不一致时抛 name='SaveVerifyError'。
 * 写入中途失败会 abort 写入流——createWritable() 默认在临时文件上写、close() 才替换原文件，
 * abort() 丢弃临时文件，避免原文件被截断成空。
 *
 * verify 默认 **关闭**（adj364）：回读要额外 getFile()+text()，每次保存多一到两次文件系统往返，
 * 用户可感知到保存变慢；写入失败本身会抛异常，因此默认走最快路径，仅诊断时开启。
 * trace 默认不传（adj367：仅排查"保存秒级延迟"时由调用方收集阶段耗时）。
 */
export async function writeTextToHandle(
  handle: FileSystemFileHandle,
  text: string,
  opts?: { verify?: boolean; trace?: SaveTrace },
): Promise<void> {
  const now = () => performance.now()
  const t0 = now()
  let w: FileSystemWritableFileStream
  try {
    w = await handle.createWritable()
  } catch (e) {
    // adj367：打开失败同样要报耗时——否则这段会被算进笼统的"收尾"，看不出是谁慢
    opts?.trace?.('open', now() - t0)
    throw e
  }
  opts?.trace?.('open', now() - t0)
  try {
    const t1 = now()
    await w.write(text)
    opts?.trace?.('write', now() - t1)
    const t2 = now()
    await w.close()
    opts?.trace?.('commit', now() - t2)
  } catch (e) {
    try {
      await w.abort()
    } catch {
      /* 写入流已失效时 abort 也会抛，忽略 */
    }
    throw e
  }
  if (!opts?.verify) return
  const back = await readBack(handle)
  if (back !== null && !sameContent(back, text)) {
    throw namedError(VERIFY_ERROR_NAME, '写入后回读内容与预期不一致')
  }
}

/**
 * 保存文本到已有句柄（adj364：最快路径优先）。
 *  1. 直接写——与浏览器原生保存等价的一次往返，不做任何前置权限查询；
 *  2. 仅当**因权限失败**（NotAllowedError/SecurityError：句柄重启后权限失效）时，
 *     才申请一次权限并重试一次（此时通常仍在用户手势窗口内，不会静默失败）；
 *  3. 其余失败原样抛出，由调用方按类型提示。
 * 这样「权限正常」（绝大多数情况）的保存速度与旧版一致，不再为权限检查/回读付代价。
 */
export async function saveTextToHandle(
  handle: FileSystemFileHandle,
  text: string,
  opts?: { verify?: boolean; trace?: SaveTrace },
): Promise<void> {
  try {
    await writeTextToHandle(handle, text, opts)
  } catch (e) {
    if (classifySaveError(e) !== 'permission') throw e
    // adj367：权限申请（可能等权限提示）也单独计时，避免与"写盘慢"混淆
    const tp = performance.now()
    const perm = await ensureWritePermission(handle)
    opts?.trace?.('perm', performance.now() - tp)
    if (perm !== 'granted') throw e
    await writeTextToHandle(handle, text, opts)
  }
}
