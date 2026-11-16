/**
 * store/fileHost.ts — 「文件宿主能力」与「降级决策」的**唯一口径**（adj966）
 *
 * ## 为什么单独一个模块
 *
 * 三种宿主（桌面壳 Tauri / 插件嵌入版 / 网页版与 PWA）对"文件"的能力不同，但**交互必须一样**：
 * 打开 → 编辑 → 保存 → 冲突三选。把「宿主 → 能力 → 决策」抽成**纯函数**，好处有两个：
 *  ① smoke 能**逐端逐档**断言（含负对照），不必真跑三端；
 *  ② 各端只提供适配器（`readText` / `mtimeOf` / `watch`），**判据不许各写一套**
 *     ——与 `store/externalChange.ts`（比对判据）、`store/saveSupport.ts`（写盘与权限）同一口径。
 *
 * 口径与能力矩阵见 `docs/FILE-MODEL.md`；**改这张表就要同步那份文档**。
 *
 * ## 三条不变量（本模块只负责把它们变成可断言的决定）
 *
 * 1. 打开/读入 ⇒ 记基准（`externalChange.setBaseline`）；
 * 2. **写盘前必比基准**：有外部改动 ⇒ **先问用户**（`decideWriteGate` 返回 `'ask'`），任何端都不许静默覆盖；
 * 3. 写盘后刷基准 + 登记在途写 ⇒ 自己的回环不提示（`externalChange.markWriteInFlight`）。
 */
import type { RuntimeEnv } from '../brand/env'
import type { ChangeVerdict } from './externalChange'

/** 宿主身份（决定默认能力档） */
export type FileHostId = 'desktop' | 'plugin' | 'web' | 'pwa' | 'limited'
/** 打开一个文件的方式 */
export type OpenMode = 'native-picker' | 'fsa-picker' | 'host-file' | 'upload-only'
/** 外部改动检测方式 */
export type WatchMode = 'event' | 'poll' | 'focus-only' | 'none'
/** 绑定的跨会话保存方式 */
export type PersistMode = 'native-path' | 'host-record' | 'indexeddb-handle' | 'none'

/** 一个宿主的能力档（**静态**能力；写权限那种"运行时才知道"的另走 `decideWriteMode`） */
export interface FileHostProfile {
  id: FileHostId
  open: OpenMode
  /** 无手势读到"文件此刻的内容" */
  readWithoutGesture: boolean
  /** 无手势写回（静态能力；Web 记 `false`，实际能不能写看 `decideWriteMode`） */
  writeWithoutGesture: boolean
  watch: WatchMode
  /** 能否拿到 mtime（拿不到就只能比内容，见 `externalChange.ts` 头注释） */
  hasMtime: boolean
  persistBinding: PersistMode
  /** 写回是否**可能**需要一次用户手势（Web 未持久授权时） */
  needsGestureForWrite: boolean
}

/** 桌面壳：原生对话档 + 原生读写 + 原生 mtime；监视先用轮询（原生事件源后续再升级为 `event`，判据不变） */
const DESKTOP: FileHostProfile = {
  id: 'desktop',
  open: 'native-picker',
  readWithoutGesture: true,
  writeWithoutGesture: true,
  watch: 'poll',
  hasMtime: true,
  persistBinding: 'native-path',
  needsGestureForWrite: false,
}

/** 插件嵌入版：一切经宿主桥；**没有 mtime**（宿主只推 path ⇒ 走内容判据）；有宿主 `modify` 事件 */
const PLUGIN: FileHostProfile = {
  id: 'plugin',
  open: 'host-file',
  readWithoutGesture: true,
  writeWithoutGesture: true,
  watch: 'event',
  hasMtime: false,
  persistBinding: 'host-record',
  needsGestureForWrite: false,
}

/** 网页版 / PWA（Chromium 且有 FSA）：句柄存 IndexedDB，能读；能不能写看权限（`decideWriteMode`） */
function webProfile(id: 'web' | 'pwa'): FileHostProfile {
  return {
    id,
    open: 'fsa-picker',
    readWithoutGesture: true,
    writeWithoutGesture: false, // 静态"看你授权了没" ⇒ 交给 decideWriteMode
    watch: 'poll',
    hasMtime: true, // File.lastModified
    persistBinding: 'indexeddb-handle',
    needsGestureForWrite: true,
  }
}

/**
 * 受限档：**Firefox / Safari（含 iOS 上一切浏览器与 PWA）没有 FSA**，以及手机端
 * （`adj405`：已安装 PWA 里 `showOpenFilePicker` 不可靠 ⇒ 一律走 `<input type=file>`）。
 * 这一档"打开 = 上传、保存 = 下载"，**必须保留草稿**（刷新即失去内容）。
 */
const LIMITED: FileHostProfile = {
  id: 'limited',
  open: 'upload-only',
  readWithoutGesture: false,
  writeWithoutGesture: false,
  watch: 'none',
  hasMtime: false,
  persistBinding: 'none',
  needsGestureForWrite: true,
}

/** 当前宿主的身份（`fsa` = 探测到 `showOpenFilePicker`；由调用方传入，便于断言） */
export function hostIdOf(env: RuntimeEnv, fsa: boolean): FileHostId {
  if (env.shell === 'tauri') return 'desktop'
  if (env.shell === 'host') return 'plugin'
  if (env.device === 'mobile' || !fsa) return 'limited'
  return env.installed ? 'pwa' : 'web'
}

/** 身份 → 能力档 */
export function profileOf(id: FileHostId): FileHostProfile {
  switch (id) {
    case 'desktop':
      return DESKTOP
    case 'plugin':
      return PLUGIN
    case 'web':
    case 'pwa':
      return webProfile(id)
    default:
      return LIMITED
  }
}

/** 一步到位：当前宿主的完整能力档 */
export function hostProfile(env: RuntimeEnv, fsa: boolean): FileHostProfile {
  return profileOf(hostIdOf(env, fsa))
}

/** 句柄/绑定的权限状态（Web 用 `queryPermission`；原生与宿主恒为 `granted`） */
export type PermState = 'granted' | 'prompt' | 'denied'

/** 保存该怎么走 */
export type WriteMode =
  | { kind: 'write-now' } // 无手势直接写（桌面 / 宿主 / Web 已授权）
  | { kind: 'need-gesture' } // 需要一次用户手势重新授权（Web 未授权）
  | { kind: 'need-pick' } // 还没有绑定对象 ⇒ 让用户选一个文件（另存为）
  | { kind: 'save-as-only' } // 本端没有原位写回能力 ⇒ 只能另存为下载

/**
 * **能不能现在写**（纯决策）：
 *  · 没有绑定 ⇒ 必须先选文件；
 *  · 静态就不能无手势写（受限档）⇒ 只能另存为；
 *  · 有绑定且静态能写（桌面/宿主）⇒ 直接写；
 *  · 有绑定但静态不能写（Web）⇒ 看权限：`granted`（本会话已授权或用户选了「每次访问都允许」）⇒ 直接写；
 *    `prompt` ⇒ 要一次手势；`denied` ⇒ 只能另存为。
 */
export function decideWriteMode(p: FileHostProfile, perm: PermState, hasBinding: boolean): WriteMode {
  if (!hasBinding) return p.open === 'upload-only' ? { kind: 'save-as-only' } : { kind: 'need-pick' }
  if (p.writeWithoutGesture) return { kind: 'write-now' }
  if (p.open !== 'fsa-picker') return { kind: 'save-as-only' }
  if (perm === 'granted') return { kind: 'write-now' }
  if (perm === 'denied') return { kind: 'save-as-only' }
  return { kind: 'need-gesture' }
}

/** 外部改动该怎么查（隐藏标签页不轮询，改为"回到前台/可见时查一次"） */
export function decideWatch(p: FileHostProfile, visible: boolean): WatchMode {
  if (p.watch === 'none') return 'none'
  if (p.watch === 'event') return 'event'
  return visible ? 'poll' : 'focus-only'
}

/**
 * **写盘前的最后一道闸**（数据安全的保底，任何端都一样）：
 *  · 有外部改动 ⇒ `'ask'`（由 UI 弹"保留本地 / 载入外部 / 查看差异"，**不许直接写**）；
 *  · 还没读过内容 ⇒ `'read-first'`（先读一次再定，不许拿 mtime 不同就当真外部改动）；
 *  · 没变 ⇒ `'write'`。
 */
export function decideWriteGate(verdict: ChangeVerdict, mode: WriteMode): 'write' | 'ask' | 'read-first' | 'blocked' {
  if (mode.kind === 'save-as-only') return 'blocked' // 不是"有冲突"，是本端写不回去 ⇒ 走另存为
  if (verdict === 'external') return 'ask'
  if (verdict === 'need-read') return 'read-first'
  return 'write'
}

/**
 * **要不要引导用户选「每次访问都允许」**（纯判据，用户口径："把权限选择交给用户"）。
 *
 * 只在这种情况提示：本端是 **FSA 档**（网页 / PWA）、刚刚成功打开了一个文件（`perm === 'prompt'`
 * = 还没拿到持久授权）、而且**这一台机器上还没提示过**。
 * 桌面壳 / 插件 / 受限档一律不提示（它们本来就能无手势写，或在能力上根本做不到）。
 * 提示**只是告知**，不阻断：用户点「仅此次」照样能用（降级为草稿 + 手动保存）。
 */
export function shouldGuidePersistPermission(p: FileHostProfile, perm: PermState, shownBefore: boolean): boolean {
  if (shownBefore) return false
  if (p.open !== 'fsa-picker') return false
  if (!p.needsGestureForWrite) return false
  return perm === 'prompt'
}

/**
 * adj966g（用户 2026-10-17 口径）：**底栏默认展开「工作区」的档**。
 *
 * 用户原话：「需要权限确认的（可能就手机端 Web 这种模式）**还继续使用工作区底栏**；
 * 其它可以直接使用文件系统的 **PC 端的各模式**，还是继续使用系统文件操作（这样更习惯）；
 * **插件还继续使用 OB 端的文件管理方式**」。
 *
 * ⇒ 分层的判据就是能力表里那一格：**受限档（`limited`：手机端 / 没有 FSA 的浏览器）
 * 且本端确实能选文件夹**（`canPickDir` = 有 `showDirectoryPicker`）时，底栏默认**展开在「工作区」**。
 *  · 桌面壳（`desktop`）/ 网页与 PWA（`web`/`pwa`）能直接对系统文件读写 ⇒ **不展开**（PC 习惯是开系统文件）；
 *  · 桌面版 Firefox / Safari 虽然是 `limited`，但**连 `showDirectoryPicker` 都没有**
 *    （`canPickDir === false`）⇒ 展开也没用（那一档是"打开=上传、保存=下载"，必须留草稿）；
 *  · 插件（`plugin`，文库即工作区）由宿主自己在侧栏管文件 ⇒ 不展开。
 */
export function shouldOpenWorkspaceDock(p: FileHostProfile, canPickDir: boolean): boolean {
  return p.id === 'limited' && canPickDir
}

/* =====================================================================================
 * adj1294：**操作栏「壳」的按端默认与宽度换算**（底栏 / 右侧栏 / 右侧浮动栏）
 *
 * 为什么放在这个文件：它和上面的 `shouldOpenWorkspaceDock` 是同一族判据——
 * 「**这台设备该默认怎么摆**」，而且都必须能在 Node 里逐端断言（smoke 有闸门）。
 * 一旦写进组件里，三端就只能靠真机一个个试，且"手机默认底栏"这条规则会散成好几处 if。
 *
 * ⚠ `FileHostProfile` 判不出"手机 vs 桌面版 Firefox"（两者都是 `limited`），所以
 * 默认值的判据**用 `RuntimeEnv`**（`device` 是粗指针判据、`shell` 是壳），不是 profile。
 * 方案文档 §4.3 原写的是 `defaultDockMode(profile)`，落地时改成 `RuntimeEnv`——
 * 理由就是这一句（改法已先同步进 `docs/DOCK-LAYOUT-PLAN.md`）。
 * ===================================================================================== */

/** 操作栏在哪一侧：底栏（现状） / 右侧栏（adj1294 新增） */
export type DockSide = 'bottom' | 'right'
/** 右栏宽度档（PC：窄 320 / 宽 480；手机：1/2 屏宽 / 2/3 屏宽） */
export type DockWidth = 'narrow' | 'wide'
/** 右栏里页签组的位置（底部横排 / 右侧竖排） */
export type DockTabsPos = 'bottom' | 'right'

/** 首次（没有任何存档时）该用哪种壳 */
export interface DockModeDefault {
  side: DockSide
  /** 只在 `side === 'right'` 时有意义：true = 浮动（盖住内容），false = 插入（挤窄内容） */
  float: boolean
}

/**
 * adj1294：**按端算默认壳**（纯函数，只在"没有存档"时用；用户改过设置就以存档为准）。
 *
 * adj1301（用户 2026-11-16，手机实测后拍板）：**所有端默认「右侧浮动栏」**——
 * 手机上原来默认底栏，用户实机试过"右浮动栏效果也可以"，于是统一成浮动栏（不挤占内容、
 * 点栏外即收）。原来的「手机 ⇒ 底栏」「插件嵌入版 ⇒ 底栏」两条特例**一并下线**。
 * 宽度档的默认值另见 `defaultDockWidth`（窄屏默认宽档）。
 *
 * ⚠ 与**首次开不开**互不影响（`adj1302`：直接打开一律收起；只有带谱进来才由
 * `openDockForIncomingFile()` 展开到试听）——那个说"开不开"，这个说"壳摆在哪一边"。
 */
export function defaultDockMode(_env: RuntimeEnv): DockModeDefault {
  return { side: 'right', float: true }
}

/**
 * adj1301：**按端算默认宽度档**（只在"没有存档"时用）。
 *
 * 用户 2026-11-16 拍板：「窄屏模式下为右栏宽栏，其它模式为窄栏」——
 * 窄屏（粗指针：手机/平板）默认 **wide**（2/3 屏宽；390 屏 = 260px），
 * 其它（桌面壳 / 桌面浏览器 / PWA）默认 **narrow**（320px，45vw 夹紧）。
 * 用户手切过档位就以存档（`ijipu.dockWidth`）为准，不受这里影响。
 */
export function defaultDockWidth(env: RuntimeEnv): DockWidth {
  return env.device === 'mobile' ? 'wide' : 'narrow'
}

/**
 * adj1294：**右栏宽度换算**（纯函数，smoke 逐档断言）。
 *
 * · **PC**：窄 320 / 宽 480，并且**夹到 45vw**（窗口很窄时 480 会把内容挤没）；
 * · **手机**：不用 320/480 这种硬值——375 宽的手机上 320 几乎是整屏 ⇒ 改成 **1/2** 与 **2/3** 屏宽。
 * · PC 档的 `45vw` 夹紧自身再兜一道 180px 下限（窗口窄到 400px 以下时，45vw 已经不到 180，
 *   再按比例收就完全看不清面板内容了）。手机档不夹——它本来就按屏宽比例给。
 *   两条兜底都只在"极端视口"下生效，正常桌面档就是 320/480。
 *
 * 返回**整数像素**（写进 CSS 变量后要做像素级断言，浮点会带来 0.5px 抖动）。
 */
export function dockWidthPx(w: DockWidth, viewportW: number, mobile: boolean): number {
  const vw = Math.max(240, Math.round(viewportW || 0))
  if (mobile) return Math.round(vw * (w === 'wide' ? 2 / 3 : 1 / 2))
  const base = w === 'wide' ? 480 : 320
  const cap = Math.max(180, Math.round(vw * 0.45))
  return Math.min(base, cap)
}

/**
 * **文档状态**（adj966d，用户要求：状态栏要能看出"这份是草稿还是已存到文件 / 手里是新版还是旧版"）。
 *
 * 为什么要一个纯函数：这三个问题（绑没绑文件 · 与文件一致吗 · 文件被外部改了吗）分别散在
 * `fileHandle`/`nativePath`/`binding`、`dirty`、以及 `externalChange` 的基准判据里，
 * 状态栏各写一套就会漂移。这里把三处事实**收成一组可枚举的状态**，UI 只管照着渲染、判据只管断言这组状态。
 *
 * | 状态 | 含义（给用户的说法） |
 * |---|---|
 * | `draft-only` | 没绑定文件：现在编辑的是**草稿**（新建 / 粘贴导入 / 示例） |
 * | `bound-clean` | 已绑定文件，且内容与文件一致（= 已保存） |
 * | `bound-dirty` | 已绑定文件，但**有未保存改动**（文件里还是旧内容） |
 * | `bound-stale` | 已绑定文件，且**文件已被外部改动**（手里这份没有本地改动；提示条与「重新载入」在这里最有用） |
 * | `bound-conflict` | 已绑定文件，**两边都改了**（外部改了、本地也有未保存改动）⇒ 交给块级采纳 / 三路合并（`diff/merge.ts`） |
 * | `bound-unknown` | 已绑定文件，但**还没核对过**（启动恢复那一瞬间；不谎称"一致"） |
 *
 * adj966f：新增第六态 `bound-conflict`（"两边都改过"）—— 用户口径见 `docs/FILE-MODEL.md` §9 护栏 5。
 * 它与 `bound-stale` 的差别只有一个事实：**本地有没有未保存改动**。两者都要提示，
 * 但"两边都改了"才谈得上逐块采纳 / 自动合并（三路合并的入口就在这一态）。
 */
export type DocStateKind = 'draft-only' | 'bound-clean' | 'bound-dirty' | 'bound-stale' | 'bound-conflict' | 'bound-unknown'

/** 由"三处事实"推文档状态（纯函数：`verdict` 来自 `externalChange` 的比对，不用本模块自己算） */
export function docStateOf(i: {
  /** 是否绑定了文件（句柄 / 原生路径 / 工作区文件，三者任一） */
  bound: boolean
  /** 是否有未保存改动（编辑器与"我们写出去的那份"不一致） */
  dirty: boolean
  /** 与文件的比对结论：`'unknown'` = 还没核对过 */
  verdict: 'unchanged' | 'external' | 'unknown'
}): DocStateKind {
  if (!i.bound) return 'draft-only'
  // ⚠ 顺序要紧：**"文件被外部改了"优先于"我有改动"** ——
  // 用户最需要知道的是"我这份可能已经过时"，而不是"我改过几个字"；
  // 而"两边都改了"是其中最需要用户做决定的一种（逐块采纳 / 自动合并），比单独的"外部改了"更具体
  if (i.verdict === 'external') return i.dirty ? 'bound-conflict' : 'bound-stale'
  if (i.dirty) return 'bound-dirty'
  if (i.verdict === 'unknown') return 'bound-unknown'
  return 'bound-clean'
}
