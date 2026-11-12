/**
 * store/uiStore.ts — UI 状态（模态框、排版辅助、主题、拆分比例、编辑器字号）
 */
import './localStorageMigration'
import { create } from 'zustand'
import { clampEditorFontSize, normalizeFontStack, HQ_LIBRARIES, resolveActiveLibrary } from '@ijipu/engine'
// adj1028：民族乐器勾选的引擎开关（走深路径 import：本仓库 index.ts 正被另一条工作流改动，
// 不往那里加导出行，避免把无关改动卷进提交；这条 API 稳定后再提回 index）
import { setEnabledEthnicVoices } from '@ijipu/engine/playback/ethnicVoices'
import { DEFAULT_THEME, DEFAULT_THEME_MODE, type ThemeMode } from '../brand/themes'
// adj954：运行环境/设备判据统一走品牌层唯一出处（原先本文件自己写了一份 matchMedia）
import { getRuntimeEnv, isCoarsePointerDevice } from '../brand/env'
// adj966g：底栏默认页按**本端能力档**决定（要权限的那一档展开在工作区，PC/插件收起）
import { hostProfile, shouldOpenWorkspaceDock } from './fileHost'
// adj1173：节拍器音色（L1 用户偏好；取值域与合成音在 playback/metronome）
// adj987（用户需求）：试听「练习段」的数据类型与命名（标记本身按文档存，见 practiceMarks.ts）
import { defaultMarkName, nextMarkId, type PracticeMark } from './practiceMarks'
// L1「用户个性」：编辑器偏好 + 字体覆盖（不进谱面；详见 docs/SETTINGS-AUDIT.md 分层）
import { loadEditorFont, loadEditorFontSize, loadFontOverride, saveEditorFont, saveEditorFontSize, saveFontOverride } from './editorPrefs'
import type { FontOverride } from '@ijipu/engine'
// adj965d：`OverlayLayer`（`'wm' | 'bg'`）的唯一出处是**引擎**（`overlayGesture.ts`）——
// 它是"水印层/背景层"这个领域概念，应用与插件共用；store 只在这里给它一个"用户选中的那层"的槽位
export type { OverlayLayer } from '@ijipu/engine'
import type { OverlayLayer } from '@ijipu/engine'

/**
 * adj563：**只保留 App 里真的还有渲染分支的模态**（原来还躺着 'about' / 'pageConfig' / 'playback' /
 * 'export' 四个"已经迁进底栏 dock、却仍留在联合类型里"的残留）——它们让
 * `openModal('pageConfig')`、`openModal('playback')` 这类**死调用**能通过类型检查：
 * 运行时什么都没发生（没有渲染分支），编译期也一言不发，于是"更多里的字体项点了没反应"、
 * "Ctrl+Q 试听假的"两个 bug 一直没人发现。收窄后这类调用**直接编译报错**。
 * 需要打开底栏面板请用 `toggleDock(key)`；需要弹窗请用下面这些。
 */
// adj957（用户裁定）：加上 `'cli'` —— 命令行手册改用应用内 `DocDialog` 打开
// （原先只能靠"系统默认程序打开随包 MD"，Windows 默认没有 .md 关联程序 ⇒ 多半弹「如何打开」）
// adj963（用户要求）：加上 `'saveAs'` —— 「保存到工作区」专用对话框（插件模式的保存主入口）
export type ModalKind = 'samples' | 'shortcuts' | 'manual' | 'syntax' | 'cli' | 'donate' | 'voicePicker' | 'saveAs' | 'package'


/**
 * adj462：底部 dock 的面板（互斥，同一时间只显示一块）。
 * 入口：告警=状态栏告警文本；试听/导出/设置/关于=顶栏对应按钮与菜单。均为「开关」：关→开+切到该面板；
 * 已开且是该面板→收起 dock；已开但不是该面板→只切面板。
 * adj492：'about'（关于）从弹窗迁入 dock（与原「试听/导出/设置」同一套路）。
 * adj540：'workspace'（工作区）排第一（手机端文件操作主入口）。
 * adj562：'import'（粘贴源码导入）**排在工作区之后**（用户要求"把粘贴源码导入对话框也加到底栏，
 *   就在工作区后面加一个「导入」页签"）——原 `ModalKind` 的 `pasteImport` 弹窗入口随之**下线**
 *   （同一份内容改由 dock 承载，避免"弹窗 + 页签"两条路并存让用户犯选择困难，与 adj492 关于同策）。
 * adj603（用户要求）：原 'settings' 一个页签**拆成两个**——'settings' = 全局（视图/主题/音色库，
 *   本机偏好，页签文本「全局」）、'score' = 谱面（布局/字体，随谱保存，页签文本「谱面」）。
 * adj641（用户要求）：新增 'find'（查找替换）——编辑区 `Ctrl+F` 的落点，把查找与替换整合在一个页签里。
 */
export type DockPanelKey =
  | 'problems'
  | 'tryout'
  | 'export'
  | 'settings'
  | 'score'
  | 'about'
  | 'workspace'
  | 'import'
  | 'find'

/** 轻量浮动提示（toast）：kind 决定配色；nonce 用于同文案重复触发时重置隐藏计时 */
export type NoticeKind = 'ok' | 'warn' | 'error'
/**
 * adj728（用户要求）：提示上的**一个动作按钮**。
 *
 * 场景（用户原话）：「无法下载音色库的提示显示时间不长，应有个按钮链接用户打开全局的音色库」——
 * 这类"要用户去别处做一件事"的提示，光有文字、几秒就消失是不够的：
 * **有动作按钮的提示不自动隐藏**（见 `ui/Toast.tsx`），用户点它或点别处才消失。
 */
export interface NoticeAction {
  /** 按钮文字（短，≤6 字为宜） */
  label: string
  /** 点击后执行（例如打开「设置 → 音色库」） */
  run: () => void
}
export interface Notice {
  text: string
  kind: NoticeKind
  nonce: number
  /** adj728：可选动作按钮（有它时提示**不自动消失**） */
  action?: NoticeAction
  /** adj1183：多个动作按钮（如导出成功后的「打开文件 / 打开文件夹」） */
  actions?: NoticeAction[]
}

/** adj728：设置对话框的页签 id（`PageConfigDialog` 与 uiStore 共用一份，避免两处漂移） */
export type SettingsTabId = 'global' | 'theme' | 'soundbank' | 'score' | 'font'

const THEME_KEY = 'ijipu.theme'
const THEME_MODE_KEY = 'ijipu.themeMode'
const SPLIT_KEY = 'ijipu.splitPct'
const PREVIEW_ZOOM_KEY = 'ijipu.previewZoom'
/**
 * 预览缩放的**手动调节范围**（%）：顶栏 `−`/`+` 与"按住上下拖"用它定边界。
 * adj51 起就是这个范围，本轮**不动**（用户的直接操作保持在"好用"的区间内）。
 */
export const PREVIEW_ZOOM_RANGE: readonly [number, number] = [50, 200]
/** 顶栏缩放步进/拖动一档的比例（%） */
export const PREVIEW_ZOOM_STEP = 10
/**
 * 预览缩放的**绝对范围**（%）：`setPreviewZoom` 的钳制用它，即"允许被存储/生效的值"。
 *
 * adj529（用户确认按建议放宽）：**"按宽度适配"（双击比率）需要越出手动范围**——
 * 预览区很窄时（如手机上分屏、只剩 ~340px）要贴合就得小于 50%，很宽时（4K 全宽）又可能要大于 200%；
 * 若沿用 `PREVIEW_ZOOM_RANGE` 钳制，适配结果就贴不上（窄屏偏宽出横向滚动条 / 宽屏留大片空白）。
 * 于是分两层：**手动操作守 [50,200]，适配结果可到 [30,400]**。
 */
export const PREVIEW_ZOOM_LIMITS: readonly [number, number] = [30, 400]
/** 与上面的范围常量之间留一行，避免与存储键混在一起（`AUTO_WRAP_KEY` 起为存储键区） */
const AUTO_WRAP_KEY = 'ijipu.autoWrap'
const SHOW_SCRIPT_PAD_KEY = 'ijipu.showScriptPad'
const SHOW_GUIDES_KEY = 'ijipu.showGuides'
// adj315：应用级视图偏好——左右拆分排列方向（默认视图已取消，改为记住顶栏上次设置）
const SPLITH_DIR_KEY = 'ijipu.splitHDir'
// adj330：SpessaSynth 高质量采样——音源库 + 全局音色（GM program）
const PLAYBACK_HQ_LIBRARY_KEY = 'ijipu.playbackHqLibrary'
/**
 * adj448：试听「音色」**不再持久化**（会话级）：每次打开试听都从「自动」开始。
 *
 * 原因：选定具体音色会**覆盖谱面里的 `Y:` 乐器**（按设计），而它又会被记住 ⇒
 * 用户下次打开带多声部 `Y:` 的谱子时，音色仍是上次选的那个，看起来像「谱面 Y: 不生效」
 * （用户实测反馈）。此键仅用于**清理旧版本残留**。
 */
const PLAYBACK_HQ_VOICE_KEY = 'ijipu.playbackHqVoice'
/**
 * adj1012：收藏音色**按库分开存**（`{ [库 id]: number[] }`）。
 *
 * 为什么必须分开：两个库的 program 名字不一样（实测同一份 128 个 program 里有 33 个名字不同），
 * 共用一套会让人以为"我明明勾了长笛，怎么名字变了"；而且某个库缺某个 program 时，
 * 共用一套会留下"勾了但库里没有"的悬空项。
 */
const PLAYBACK_HQ_ENABLED_BY_LIB_KEY = 'ijipu.playbackHqEnabledByLib'
/** adj1012：旧版是**一个** `number[]`（那时只有一个库）——只在迁移时读它，读走即删 */
const PLAYBACK_HQ_ENABLED_LEGACY_KEY = 'ijipu.playbackHqEnabled'
/**
 * adj1028（用户 2026-10-21）：「指定音色」的**民族乐器（拟）**页签勾选了哪些名字。
 *
 * 口径：**勾选后，这个名字在脚本里才可用**（`@二胡@` ⇒ 110 民谣提琴）；没勾 ⇒ 不生效。
 * 存的是名字（不是 program）：同一个名字的映射可能在引擎里调整，用户勾的是"我要用二胡"。
 */
const ETHNIC_VOICES_KEY = 'ijipu.ethnicVoices'
/**
 * adj987（**用户 2026-10-18 需求**）：试听「练习段」的三项界面偏好（L1 本机，与谱无关）：
 *  · 循环开关（`practiceLoop`）——用户练一句时基本总想循环，记住它省一次点击；
 *  · 段组收起（`practiceCollapsed`，用户追加要求「左上角加一个收起/显示整个段组的小按钮」）；
 *  · 标记数据本身**按文档**存，见 `store/practiceMarks.ts`（不在 uiStore 里持久化）。
 */
const PRACTICE_LOOP_KEY = 'ijipu.practiceLoop'
const PRACTICE_COLLAPSED_KEY = 'ijipu.practiceCollapsed'
/**
 * adj1000（用户 2026-10-19 要求）：深色主题下预览区"黑底白字"对比过强 ⇒ **柔化档位**（L1 本机偏好）。
 * 取值 `off` / `light` / `mid`，默认 **light**；实现见 `styles/theme.css` 的 `[data-soften]` 规则。
 */
const PREVIEW_SOFTEN_KEY = 'ijipu.previewSoften'
export type PreviewSoften = 'off' | 'light' | 'mid'
/**
 * adj1002（用户 2026-10-19 要求）：**导出背景**两项独立开关（L1 本机偏好）。
 *
 * · `exportBg`：导出**底色** —— `none`（透明，默认）/ `white` / `paper`（跟随当前纸色档位）；
 * · `exportBgImage`：是否**带背景图/水印**（默认不带）——与底色分开，
 *   因为"页面只有部分背景图"时，边距露出来的应是**纸色**而不是白块。
 */
const EXPORT_BG_KEY = 'ijipu.exportBg'
const EXPORT_BG_IMAGE_KEY = 'ijipu.exportBgImage'
export type ExportBg = 'none' | 'white' | 'paper'
// adj347：默认启用的常用音色（初次用户打开试听即可选）——大钢琴/八音盒/小提琴/弦乐/小号/单簧管/长笛
const DEFAULT_HQ_ENABLED: number[] = [0, 10, 40, 48, 56, 71, 73]
/** 默认库 id（旧数据迁移的落点；库清单非空，兜底串只为类型安全） */
const DEFAULT_HQ_LIB_ID = HQ_LIBRARIES[0]?.id ?? 'generaluser_gs'

/** 合法 GM program 过滤（0–127 整数；越界/非数字一律丢弃——缓存可能被手改坏） */
function sanitizePrograms(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null
  return v.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < 128)
}

/** 写 `{ [库 id]: number[] }` */
function saveHqEnabledByLib(map: Record<string, number[]>): void {
  try {
    localStorage.setItem(PLAYBACK_HQ_ENABLED_BY_LIB_KEY, JSON.stringify(map))
  } catch {
    /* 忽略 */
  }
}

/**
 * adj1028：读勾选的民族乐器名。
 *
 * 返回 `null` 表示"**这个环境没有本机存储**"（Node 单测 / 无 localStorage）——
 * 这时**不要**把引擎切到"只有勾选的可用"，否则单测里 `二胡` 会突然失效（不是被测引擎的问题）。
 * 返回 `[]` 才是"应用里一个都没勾"。
 */
function loadEthnicVoices(): string[] | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(ETHNIC_VOICES_KEY)
    if (raw === null) return []
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
  } catch {
    return []
  }
}

/** adj1028：写勾选列表（同一份也同步给引擎，让 `instrumentToProgram` 立刻按它判） */
function saveEthnicVoices(names: string[]): void {
  try {
    localStorage.setItem(ETHNIC_VOICES_KEY, JSON.stringify(names))
  } catch {
    /* 忽略 */
  }
}

/**
 * 读 `{ [库 id]: number[] }`（adj1012）——含**旧版单数组迁移**。
 *
 * 旧版（adj330–adj1011）只有一个库，所以那个数组的归属是确定的：默认库。
 * 迁移时**先写新键、再删旧键**：中途崩溃也只会多读一次旧值，不会把用户的收藏弄丢。
 */
function loadHqEnabledByLib(): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  try {
    const raw = localStorage.getItem(PLAYBACK_HQ_ENABLED_BY_LIB_KEY)
    if (raw !== null) {
      const v: unknown = JSON.parse(raw)
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, arr] of Object.entries(v as Record<string, unknown>)) {
          const list = sanitizePrograms(arr)
          if (list) out[k] = list
        }
        return out
      }
    }
    const legacy = localStorage.getItem(PLAYBACK_HQ_ENABLED_LEGACY_KEY)
    if (legacy !== null) {
      const list = sanitizePrograms(JSON.parse(legacy))
      if (list) out[DEFAULT_HQ_LIB_ID] = list
      saveHqEnabledByLib(out)
      localStorage.removeItem(PLAYBACK_HQ_ENABLED_LEGACY_KEY)
    }
  } catch {
    /* 缓存不可用/内容损坏：回退空表（读取时按库回落到默认 7 个） */
  }
  return out
}

function loadBool(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === null) return def
    return v === '1' || v === 'true'
  } catch {
    return def
  }
}

function loadTheme(): string {
  try {
    return localStorage.getItem(THEME_KEY) ?? DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

function loadThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_MODE_KEY)
    return v === 'light' || v === 'dark' || v === 'auto' ? v : DEFAULT_THEME_MODE
  } catch {
    return DEFAULT_THEME_MODE
  }
}

function loadNum(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : fallback
  } catch {
    return fallback
  }
}

/** 当前系统深浅色偏好（无 matchMedia 时默认深色） */
function detectSystemLight(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches
  } catch {
    return false
  }
}

/**
 * adj974（**用户 2026-10-18 口径**）：「PC 端默认输入条设为**关闭**，手机端默认设为**开**」。
 *
 * 于是这里**删掉了旧的 `detectTouch()`**（= `isCoarsePointerDevice() || detectNarrow()`）：
 * 它把"**窗口 ≤1024px**"也算进"该默认打开输入条"，于是**PC 上把窗口拉窄、或在 Obsidian 的窄侧栏里**
 * 打开时会**默认弹出输入条**（用户要的正是关掉这一档）。现在只看"**是不是真手机/触屏**"
 * （`brand/env.ts` 的 `isCoarsePointerDevice()`：粗指针 + UA 兜底，**不含窗口宽度**）。
 *
 * ⚠ 与文件选择策略用的那个判据**仍然不是一回事**（那边连"触屏"都不算，见 `store/saveSupport.ts`）；
 * 而 `detectNarrow()` 继续只表示"布局走窄屏形态"（分屏方向那一档在用）。
 */
/**
 * adj966g（用户 2026-10-17 口径）：**底栏一开始开在哪个面板**。
 *
 * 「需要权限确认」的那一档（手机端 Web / PWA，且能选文件夹）⇒ 一进来就展开在「**工作区**」
 * （那是它唯一的文件入口：`<input type=file>` 只能"打开=上传"，保存走导出；工作区才是主入口）；
 * 其余（PC 各档 / 插件 / 无 FSA 的桌面浏览器）⇒ 照旧**收起**、面板留给「问题」
 * （PC 直接操作系统文件，不需要先把人推到工作区）。
 *
 * 判据在 `store/fileHost.ts` 的 `shouldOpenWorkspaceDock`（纯函数、有闸门断言），本文件只负责接线。
 * 只在**模块初始化时算一次**（面板不持久化 ⇒ 每次会话按本端能力给默认值）。
 */
function initialDock(): { open: boolean; panel: DockPanelKey } {
  try {
    const w = window as unknown as { showOpenFilePicker?: unknown; showDirectoryPicker?: unknown }
    const profile = hostProfile(getRuntimeEnv(), typeof w.showOpenFilePicker === 'function')
    const canPickDir = typeof w.showDirectoryPicker === 'function'
    if (shouldOpenWorkspaceDock(profile, canPickDir)) return { open: true, panel: 'workspace' }
  } catch {
    /* 环境探测失败 ⇒ 退回"收起 + 问题"（最保守的观感） */
  }
  return { open: false, panel: 'problems' }
}

/** adj322：宽/窄屏分界（≤1024px = 窄屏）。matchMedia 支持时用 mq，否则读 innerWidth。
 * 统一「≤1024px = 窄屏」语义；⚠ `adj974` 起它**不再**参与"输入条默认开不开"（那只按真手机/触屏）。 */
const NARROW_MQ = '(max-width: 1024px)'
function detectNarrow(): boolean {
  try {
    if (window.matchMedia(NARROW_MQ).matches) return true
  } catch {
    /* 忽略 */
  }
  try {
    return window.innerWidth <= 1024
  } catch {
    return false
  }
}

interface UiState {
  modal: ModalKind | null
  /** 试听起始音符 id（双击谱面音符定位试听起点，adj88；null = 从头播放） */
  playbackStartId: string | null
  /** 双击谱面音符请求重新播放的计数（adj158：播放中双击快速跳到该处，每次 +1） */
  playbackTick: number
  /** 预览页排版辅助虚线开关 */
  showGuides: boolean
  /**
   * adj905q（用户规格见 `docs/PREVIEW-DEBUG-BOUNDARIES.md`）：**预览可视调试**开关。
   * 开启后在预览里叠加「时值格 / 墨迹 / 段层」三套边界虚线（几何来自引擎
   * `engine/layout/guides.ts` 的 `computeDebugBounds`，预览层只消费不重算）。
   *
   * ⚠ **L3 会话级**（`AGENTS.md` §七）：默认关、**只在一个运行期里有效**、
   * **下次运行恢复默认关** ⇒ **内存态、不写 localStorage**（不要用 `loadBool`）。
   */
  debugBounds: boolean
  /**
   * adj965d（方案「OVL」EP-13）：预览区里 `Alt+滚轮 / Alt+Shift+滚轮 / Alt+拖动` 调的是**哪一层**。
   *
   * 只在**水印与背景都可用**（各自已启用且有内容）时才有意义——那时预览角落会显示
   * 「调整对象」切换器；只有一层可用时手势直接作用在它身上，用户选的值被忽略
   * （判定见引擎 `overlayGesture.ts` 的 `activeOverlayLayer`）。
   *
   * ⚠ **L3 会话级**（`AGENTS.md` §七）：这是"我正在调哪一层"的临时意图，不是个性偏好，
   * 也不随谱走 ⇒ **内存态，不写 localStorage**（同 `debugBounds` 的做法）。
   */
  overlayEditLayer: OverlayLayer
  /** 中国色主题 id */
  theme: string
  /** 深浅色模式：auto=跟随系统 prefers-color-scheme（adj48） */
  themeMode: ThemeMode
  /** 系统当前是否浅色（auto 模式下决定实际深浅色） */
  systemLight: boolean
  /** 拆分视图上（预览）窗格高度占比（%），下（编辑器）窗格占剩余 */
  splitPct: number
  /** 脚本编辑器字号（px，L1 用户个性；不写入谱面） */
  editorFontSize: number
  /** 脚本编辑器字体（L1 用户个性；等宽栈，含 fallback；不写入谱面） */
  editorFont: string
  /** L1：用我的字体覆盖谱面字体（标题/副标题/描述头/说明/歌词/数字六项；默认关） */
  fontOverride: FontOverride
  /** 预览缩放（%，50~200，adj51） */
  previewZoom: number
  /** 编辑器自动折行（adj233 默认关闭；adj234 曾默认开启——用户确认保持默认关闭，
   *  关闭时 wrap=off 横向滚动对位正确；开启时 break-word 空格后折行） */
  autoWrap: boolean
  /** adj314：嵌入式简谱输入工具条显示开关（移动端/PAD 默认开、PC 默认关） */
  showScriptPad: boolean
  /** adj322：当前是否窄屏（视口宽度 ≤1024px）。由 matchMedia 同步更新,
   *  用于：① 进入拆分视图时按视口选上下/左右；② 拆分类视图下视口跨阈值实时切换。 */
  isNarrow: boolean
  /** adj315：左右拆分的排列方向（previewLeft=左预览右编辑 / editorLeft=左编辑右预览） */
  splitHDir: 'previewLeft' | 'editorLeft'
  /** adj330：SpessaSynth 音源库 id（HQ_LIBRARIES，空=默认库） */
  playbackHqLibrary: string
  /** adj330：SpessaSynth 全局音色（GM program；null=按声部名自动路由） */
  playbackHqVoice: number | null
  /** adj332/adj1012：**每个库一套**已启用（收藏）的音色 program —— 试听只列这些。
   *  键=库 id；读一律走 `enabledVoicesOf(state)`（它会解析"当前库"并处理默认值）。 */
  playbackHqEnabledByLib: Record<string, number[]>
  /* ---- adj987（用户 2026-10-18 需求）：试听「练习段」 ---- */
  /** 当前文档的练习段（按文档缓存载入；`[]` = 只有「无」） */
  practiceMarks: PracticeMark[]
  /** 选中的标记 id（`''` = 无 ⇒ 演奏全曲；**不可删除**） */
  practiceMarkId: string
  /** 循环播放开关（L1 记住） */
  practiceLoop: boolean
  /** 段组是否收起（用户追加要求：左上角小按钮；L1 记住） */
  practiceCollapsed: boolean
  /** adj1000：深色主题下预览区柔化档位（off / light / mid；默认 light） */
  previewSoften: PreviewSoften
  /** adj1002：导出底色（`none` 透明 / `white` / `paper` 跟随纸色档位；默认 `none`） */
  exportBg: ExportBg
  /** adj1002：导出是否带**背景图/水印**（默认不带；与底色独立） */
  exportBgImage: boolean
  /** 待添加的起点 / 终点音符 id（点音符后再按「起始」「停止」） */
  practiceSelStart: string | null
  practiceSelStop: string | null
  /**
   * adj987k（用户 2026-10-18 口径 #5）：当前标记段**实际会演奏到的音符 id**（按**播放顺序**）。
   *
   * 预览层照它画线：跨 `:|` 回跳/跳房子时，线要**跟着演奏顺序**走（起在止之后也能画对），
   * 而不是简单取"起点到停止点的源码区间"。
   */
  practiceRangeIds: string[]
  /**
   * adj991（**用户 2026-10-19 实报**「画线是正确的，但播放不对」）：
   * 画线时那套解析算出的**区间下标** + 当时的**序列长度**。
   *
   * 播放端**优先用它们**：只要序列长度一致，就保证"**所见即所听**"；
   * 长度不一致（音源/乐器参数导致排版差异）才自己重算。
   */
  practiceRangeI0: number
  practiceRangeI1: number
  practiceRangeEventCount: number
  /**
   * adj987o（**用户 2026-10-18 口径**）：「在起始点处加一个动态 321 的倒数数字机制，
   * 在开始或重新循环开始之前进行倒数计数」⇒ 当前显示的倒数秒数（3 / 2 / 1；`null` = 不显示）。
   */
  practiceCountdown: number | null
  /** 轻量浮动提示（null = 无提示） */
  notice: Notice | null
  /** adj379：检测到 SW 新版本（页面仍在跑旧 bundle）——右下角提示「点击刷新」 */
  updateReady: boolean
  // ---- adj462：底部 dock（告警 / 试听 / 导出 / 设置 共用一个 dock，互斥切换） ----
  /** dock 是否展开（false = 整条隐藏，由入口按钮或标题栏 × 关闭） */
  dockOpen: boolean
  /** 当前显示哪一块面板 */
  dockPanel: DockPanelKey
  /**
   * 入口按钮统一语义（开关）：关 → 开 + 切到 panel；已开且是 panel → 收起 dock；
   * 已开但不是 panel → 只切面板（保持展开）。
   */
  toggleDock: (panel: DockPanelKey) => void
  /** dock 内部 tab 切换（保持展开）；dock 已关时同时展开 */
  setDockPanel: (panel: DockPanelKey) => void
  /**
   * adj610：**展开底栏**（已展开时是幂等的无操作）。`preferProblems` = "当前有告警"，
   * 由调用方传入（告警条数在 docStore，这里不做跨 store 读取）：
   * 有告警就切到告警页签（adj591 口径："告警是需要处理的东西，展开时优先让人看见"），
   * 否则保留上次用的页签。
   *
   * 为什么放进 store：**这条规则只能有一处实现**——用它的入口已有三个
   * （编辑区左下角「展开底栏」按钮 / `Ctrl+D` / `Ctrl+H`），各写一份必然会漂移
   * （E-2026-076 同类教训：同一个"展开给哪个页签"的判据两处维护）。
   */
  expandDock: (preferProblems: boolean) => void
  /** dock 标题栏 × 关闭：只关，不切面板（下次任意入口 toggle 会重新开） */
  closeDock: () => void
  /**
   * adj610（用户要求）：`Ctrl+H` = "按一下底栏高度档位按钮"。
   *
   * 档位循环的状态（相位 / 各面板当次高度 / 实测外壳高）都在 `ToolDock` 组件内部，
   * 所以这里**只发一个一次性"请求"**（nonce 自增），由 `ToolDock` 消费后执行它自己的
   * `cycleDockHeight()`——与 `workspaceSaveIntent` 同一套路：描述"这一次动作"，不持久化。
   */
  dockSizeStep: number
  requestDockSizeStep: () => void
  /**
   * adj619（用户要求）：**底栏入口快捷键的一次性请求**（`Ctrl+Q/O/B/I/\`` 各自对应一个底栏页签）。
   *
   * 用户口径："底栏按钮响应快捷键时，如果此时底栏 dock 为最小化，则应是展开到建议高度。"
   *
   * 为什么要发请求而不是直接 `toggleDock`：**"是否最小化"是 `ToolDock` 的内部状态**
   * （`minimized`，见 `ToolDock` 里那段说明），只有它知道该"展开到建议高度"还是走普通开关语义
   * ——最小化时若走 `toggleDock`，同页签会把底栏**收起来**、异页签会**静默切页签但内容区仍是 0 高**
   * （用户看到的正是"按了没反应"）。与 `dockSizeStep` 同一套路：只描述"这一次动作"，不持久化。
   */
  dockPanelRequest: { panel: DockPanelKey; nonce: number } | null
  requestDockPanel: (panel: DockPanelKey) => void
  /**
   * adj641（用户要求）：**`Ctrl+F` = 打开底栏「查找替换」并聚焦查找框**。
   *
   * 为什么不直接用 `requestDockPanel('find')`：那个请求的语义是"开关"（已开着同一个面板再按会**收起**底栏），
   * 而用户连按 Ctrl+F 的预期是"回到查找框继续找"，不是把面板收起来。另外"已经在本页签再按一次"时
   * `dockPanel` 没变，单靠 effect 收不到信号 ⇒ 这里用一个自增 nonce 描述"这一次要我聚焦"。
   * 于是 `requestFind()` = 打开底栏 + 切到查找页签 + nonce 自增（面板据此聚焦并全选输入框）。
   */
  findFocus: number
  /**
   * adj642（用户要求："按下 Ctrl+F 时编辑区选中的文本自动成为查找框的内容，并完成查找，
   * 同时高亮编辑区里已找到的内容"）：
   * **查找内容与大小写开关放在 store 里**，而不是面板自己的 useState——
   * 因为编辑区的高亮（`editor/findHighlight.ts`）也要读同一份查找内容；两份状态必然漂移。
   * 替换内容仍留在面板内（它只影响替换动作，与高亮无关）。
   */
  findQuery: string
  findCaseSensitive: boolean
  setFindQuery: (q: string) => void
  setFindCaseSensitive: (v: boolean) => void
  /**
   * 发一次"打开查找替换并聚焦查找框"的请求。`seed` 非空时**同时**把查找内容换成它
   * （`Ctrl+F` 带选区文本；由 `App` 算出后传入——本 store 不跨读 docStore，与其他入口同口径）。
   */
  requestFind: (seed?: string | null) => void
  /** adj462：导出任务指示（状态栏动态提示用；null = 无任务）。dock 切走/关闭时仍在，导出照常进行。 */
  exportJob: string | null
  setExportJob: (label: string | null) => void
  openModal: (m: ModalKind) => void
  closeModal: () => void
  /**
   * adj728（用户要求）：**打开「设置」并直接落在指定页签**（一次性的"意图"标记）。
   *
   * 用它的入口目前是"音色库自动下载失败"那条提示上的按钮（跳到「设置 → 音色库」去手动导入）；
   * 与 `workspaceSaveIntent` 同一套路：`PageConfigDialog` 在挂载时消费掉它再清空，
   * 不做持久化（它描述的是"这一次动作"，不是设置本身）。
   */
  settingsTab: SettingsTabId | null
  openSettings: (tab: SettingsTabId) => void
  consumeSettingsTab: () => void
  /**
   * adj540：**手机端「另存为」= 打开工作区面板并把文件名输入框直接展开**（少点一步）。
   * 一次性的"意图"标记：面板在激活时消费掉它再清空（不做持久化——它描述的是"这一次动作"）。
   */
  workspaceSaveIntent: boolean
  requestWorkspaceSave: () => void
  clearWorkspaceSaveIntent: () => void
  setPlaybackStart: (id: string | null) => void
  bumpPlaybackTick: () => void
  setShowGuides: (b: boolean) => void
  /** adj905q：预览可视调试开关（L3 会话级，不持久化） */
  setDebugBounds: (b: boolean) => void
  /** adj965d：预览区 Alt 手势"调哪一层"（L3 会话级，不持久化；只在两层都可用时才由用户选） */
  setOverlayEditLayer: (l: OverlayLayer) => void
  setTheme: (id: string) => void
  setThemeMode: (m: ThemeMode) => void
  setSystemLight: (b: boolean) => void
  setSplitPct: (pct: number) => void
  setEditorFontSize: (px: number) => void
  setEditorFont: (f: string) => void
  setFontOverride: (o: FontOverride) => void
  setPreviewZoom: (z: number) => void
  setAutoWrap: (b: boolean) => void
  setShowScriptPad: (b: boolean) => void
  /** adj322：宽窄屏变化同步（matchMedia 'change' 回调） */
  setIsNarrow: (b: boolean) => void
  setSplitHDir: (d: 'previewLeft' | 'editorLeft') => void
  /** adj330：SpessaSynth 试听偏好 setter */
  setPlaybackHqLibrary: (id: string) => void
  setPlaybackHqVoice: (program: number | null) => void
  /** adj332：切换某音色是否启用（收藏），试听只列启用的 */
  togglePlaybackHqVoice: (program: number) => void
  /** adj340：批量设置**当前库**的启用音色集合（全选/全消/导入音色配置用） */
  setPlaybackHqEnabled: (programs: number[]) => void
  /** adj1012：整份替换"每库收藏"（导入收藏 JSON 用；逐库做合法性过滤） */
  replacePlaybackHqEnabledByLib: (map: Record<string, number[]>) => void
  /**
   * adj1028：「民族乐器（拟）」里勾选了哪些名字。
   * 勾选后脚本写 `@二胡@` 才会按 110 民谣提琴播放；没勾的名字不生效。
   */
  ethnicVoicesEnabled: string[]
  /** adj1028：替换整份勾选（全选/全消/单个切换都走它；同时落盘并同步引擎） */
  setEthnicVoicesEnabled: (names: string[]) => void
  /* ---- adj987（用户 2026-10-18 需求）：试听「练习段」 ---- */
  /** 换一整批标记（打开文档 / 文档切换时由对话框载入） */
  setPracticeMarks: (marks: PracticeMark[]) => void
  /** 选中某个标记（`''` = 无 ⇒ 全曲） */
  setPracticeMarkId: (id: string) => void
  /** 改某个标记的"候选遍次"（用户在下拉里选过之后写回标记） */
  setPracticeMarkPass: (id: string, pass: number) => void
  /** 点音符后按「起始」/「停止」：登记待添加的端点 */
  setPracticeSel: (which: 'start' | 'stop', noteId: string | null) => void
  /** adj987k：写入"这一段实际演奏到的音符 id"（`[]` = 只按起止范围画） */
  setPracticeRangeIds: (ids: string[], i0?: number, i1?: number, eventCount?: number) => void
  /** adj987o：设置倒数秒数（`null` = 收起倒数） */
  setPracticeCountdown: (n: number | null) => void
  /** 用当前两个端点**新增**一段（名 `段 N`），并自动选中它 */
  addPracticeMark: () => PracticeMark | null
  /** 删除当前选中的标记（「无」不可删） */
  deletePracticeMark: (id: string) => void
  /** 循环开关（L1 记住） */
  setPracticeLoop: (b: boolean) => void
  /** 段组收起/展开（左上角小按钮；L1 记住） */
  togglePracticeCollapsed: () => void
  /** adj1000：深色主题下预览区**柔化档位**（off / light / mid；L1 记住） */
  setPreviewSoften: (v: PreviewSoften) => void
  /** adj1002：设置导出底色（L1，落 localStorage） */
  setExportBg: (v: ExportBg) => void
  /** adj1002：设置导出是否带背景图（L1，落 localStorage） */
  setExportBgImage: (v: boolean) => void
  /** adj379：设置「检测到新版本」状态（PWA 更新提示） */
  setUpdateReady: (b: boolean) => void
  /** adj728：`action` 非空时提示带一个按钮，且**不自动消失**（见 `NoticeAction`） */
  showNotice: (text: string, kind?: NoticeKind, action?: NoticeAction | NoticeAction[]) => void
  clearNotice: () => void
  /**
   * adj724b：**确认条**（顶部横幅，两个动作）。
   *
   * 用途：嵌入版检测到"当前 `.jps` 被 Obsidian 外部修改"时，问用户
   * 「重新载入 / 保留我的修改」。这是应用里第一个需要**用户二选一**的提示——
   * 既有的 `notice` 只是自动消失的提示，不能承担这个语义。
   * 同一时刻只允许一条（后者覆盖前者），确认后必须 `clearAsk()`。
   */
  ask: AskState | null
  showAsk: (ask: AskState) => void
  clearAsk: () => void
  /**
   * adj928（用户要求）：**两栏源码差异框**的数据（`null` = 不显示）。
   *
   * 从确认条的「查看差异」按钮打开，用来"看清差异再决定接受哪一边"——
   * 所以它带着两个动作（保留本地 / 载入外部），在差异框里也能直接做决定；
   * 只关掉差异框则回到原来的确认条（`ask` 不动）。
   */
  fileDiff: FileDiffState | null
  showFileDiff: (d: FileDiffState) => void
  closeFileDiff: () => void
}

/** adj928：确认条上「查看差异」的数据来源（"本地"内容**延迟取**：用户可能还在编辑） */
export interface AskDiffSource {
  name: string
  /**
   * adj966f：**共同祖先的原文**（基准里保留的那份，`externalChange.getBaselineText`）。
   * 拿不到（旧基准 / 没有基准）就是 `null` ⇒ 差异框退化为二路逐块采纳（P1）。
   */
  baseText: string | null
  /** 点开差异框那一刻的本地内容（当前编辑器里的） */
  localText: () => string
  /** 文件里现在的内容（外部那侧；原始文本，未归一化） */
  externalText: string
  /**
   * adj966f（口径④）：**应用合并结果**——差异框底部「应用（并保存）」按下时调它。
   * 由 `main.tsx` 的 `askLoadExternalChange` 提供（落到 `docStore.applyMergeResult`：
   * 备份两侧 + 一步历史 + 写回文件 + 刷基准 + 解析器体检）。
   */
  onApplyMerge: (merged: string) => void
}

/** adj928：差异框要显示的内容与几个决定 */
export interface FileDiffState {
  name: string
  /** 左栏：本地（正在编辑的这份） */
  local: string
  /** 右栏：外部（文件里的新内容） */
  external: string
  /** adj966f：共同祖先原文（`null` = 没有 ⇒ 只能逐块采纳，不能自动合并） */
  base: string | null
  onKeepLocal: () => void
  onLoadExternal: () => void
  /**
   * adj966f（口径④）：**应用合并结果**——把逐块选择拼出来的文本写回文件并立刻保存
   * （落到编辑器、刷新基准、跑解析器体检）。
   */
  onApplyMerge: (merged: string) => void
}

/** 确认条的内容与动作（adj724b） */
export interface AskState {
  text: string
  /** 主按钮（强调色） */
  confirmLabel: string
  onConfirm: () => void
  /** 次按钮（普通样式） */
  cancelLabel: string
  onCancel: () => void
  /** adj928：非空则确认条上多一个「查看差异」按钮（打开两栏差异框） */
  diff?: AskDiffSource
  /**
   * adj966f（P2）：**额外的第三个动作**（在「查看差异」与主/次按钮之外）。
   *
   * 用途只有一个但很关键：两边都改了、且改动**互不重叠**时（`MergePlan.conflicts === 0`），
   * 合并结果是确定的 ⇒ 确认条上直接给一个「应用」按钮（=`externalChangeCopy.applyMergeShort`），
   * 用户不必"先点查看差异、再点应用"两跳。文案里写明"以本地为底、未被采纳的外部内容不会写进来"。
   */
  extra?: { label: string; run: () => void }
}

/**
 * adj1012：**当前库**的启用音色（全应用唯一的读取口）。
 *
 * 三件事收在这一处，避免 6 个调用点各自"猜"：
 *  ① 先把 `playbackHqLibrary` 解析成真正的库 id（空/失效会回退默认库，见 `resolveActiveLibrary`）；
 *  ② 该库**从没配过** ⇒ 回落常用 7 个（`DEFAULT_HQ_ENABLED`）；配过但**全消** ⇒ 就是空数组
 *     （用 `hasOwnProperty` 区分"没配过"和"配成空"——写成 `?? DEFAULT` 会让"全消"点不动）；
 *  ③ 返回的数组引用稳定（来自 state 或模块常量）⇒ zustand 选择器不会每次都判"变了"。
 */
export function enabledVoicesOf(
  s: Pick<UiState, 'playbackHqEnabledByLib' | 'playbackHqLibrary'>,
): number[] {
  const libId = resolveActiveLibrary(s.playbackHqLibrary).lib.id
  const map = s.playbackHqEnabledByLib
  return Object.prototype.hasOwnProperty.call(map, libId) ? (map[libId] ?? []) : DEFAULT_HQ_ENABLED
}

export const useUiStore = create<UiState>()((set) => ({
  modal: null,
  playbackStartId: null,
  playbackTick: 0,
  showGuides: loadBool(SHOW_GUIDES_KEY, true),
  // adj905q：预览可视调试 —— **L3 会话级**，刻意不读 localStorage（重开即恢复默认关）
  debugBounds: false,
  // adj965d（EP-13）：预览区 Alt 手势默认调**背景层**（L3 会话级，不落盘）
  overlayEditLayer: 'bg',
  theme: loadTheme(),
  themeMode: loadThemeMode(),
  systemLight: detectSystemLight(),
  splitPct: loadNum(SPLIT_KEY, 50),
  editorFontSize: loadEditorFontSize(),
  editorFont: loadEditorFont(),
  fontOverride: loadFontOverride(),
  previewZoom: loadNum(PREVIEW_ZOOM_KEY, 100),
  // adj311：自动折行改为默认开启——Textarea 与显示层折行同步已修复
  //（mirror div 与 textarea 折行点一致），开启后长行软折行对位正确无横向滚动
  autoWrap: loadBool(AUTO_WRAP_KEY, true),
  /**
   * adj314 立、**adj974（用户 2026-10-18 口径）改**：输入条默认开关 =
   * **手机/触屏 ⇒ 开**（`isCoarsePointerDevice()`：粗指针 + UA 兜底）、**PC ⇒ 关**。
   *
   * ⚠ 旧口径是 `isCoarsePointerDevice() || detectNarrow()`（"窄屏也算"）⇒ **PC 把窗口拉窄、
   * 或插件在 Obsidian 的窄侧栏里打开时会默认弹出输入条**；用户明确要求那两档也**默认关**
   * （输入条是手机上没有物理键盘才需要的东西）。判据的取舍写在文件上方那段注释里。
   *
   * 用户手动开/关过就按它存的值走（`setShowScriptPad` 落 `ijipu.showScriptPad`）——
   * 这里只影响**没存过值**的首次默认。
   */
  showScriptPad: loadBool(SHOW_SCRIPT_PAD_KEY, isCoarsePointerDevice()),
  // adj322：宽/窄屏（≤1024px 视为窄屏）—— matchMedia 实时同步
  isNarrow: detectNarrow(),
  // adj315：左右拆分排列方向（previewLeft=左预览右编辑，默认）
  splitHDir: (() => {
    try {
      const v = localStorage.getItem(SPLITH_DIR_KEY)
      return v === 'editorLeft' ? 'editorLeft' : 'previewLeft'
    } catch {
      return 'previewLeft'
    }
  })(),
  // adj330：SpessaSynth 音源库 id（空=默认库）+ 全局音色（GM program，null=自动）
  playbackHqLibrary: (() => {
    try {
      return localStorage.getItem(PLAYBACK_HQ_LIBRARY_KEY) ?? ''
    } catch {
      return ''
    }
  })(),
  /**
   * adj448：试听音色 = **会话级**（默认「自动」，每次打开试听重置，见 PlaybackDialog）。
   * 旧版本曾把它记在 `ijipu.playbackHqVoice`——这里顺手清掉残留，避免"明明没选却仍按旧音色演奏"。
   */
  playbackHqVoice: (() => {
    try {
      localStorage.removeItem(PLAYBACK_HQ_VOICE_KEY)
    } catch {
      /* 缓存不可用：忽略 */
    }
    return null
  })() as number | null,
  // adj332/347：已启用音色集合（试听只列这些）；按库分开存，读取走 `enabledVoicesOf`
  playbackHqEnabledByLib: loadHqEnabledByLib(),
  // adj1028：民族乐器（拟）的勾选；`setEthnicVoicesEnabled` 会同步给引擎
  ethnicVoicesEnabled: loadEthnicVoices() ?? [],
  openModal: (m) => set({ modal: m }),
  // adj728：一次性"跳到某个设置页签"的意图（见接口处说明；由 PageConfigDialog 消费）
  settingsTab: null,
  /**
   * adj728：**打开「设置」并落在指定页签**（`PageConfigDialog` 消费 `settingsTab`）。
   * 设置面板住在底栏 dock 里，所以这里同时把 dock 展开到对应那一份面板：
   * 版面/主题/音色库 → 「全局」面板；布局/字体 → 「谱面」面板。
   */
  openSettings: (tab) =>
    set({
      dockOpen: true,
      dockPanel: tab === 'score' || tab === 'font' ? 'score' : 'settings',
      settingsTab: tab,
    }),
  consumeSettingsTab: () => set({ settingsTab: null }),
  workspaceSaveIntent: false,
  requestWorkspaceSave: () => set({ workspaceSaveIntent: true }),
  clearWorkspaceSaveIntent: () => set({ workspaceSaveIntent: false }),
  closeModal: () => set({ modal: null, playbackStartId: null }),
  setPlaybackStart: (id) => set({ playbackStartId: id }),
  bumpPlaybackTick: () => set((s) => ({ playbackTick: s.playbackTick + 1 })),
  // adj905q：预览可视调试开关（L3 会话级）——**不落盘**，重开应用即回到默认关
  setDebugBounds: (b) => set({ debugBounds: b }),
  // adj965d：Alt 手势调哪一层（L3 会话级）——**不落盘**；默认背景层：
  // 需要摆位置的通常是垫进来的那张背景图（水印多为居中一个）
  setOverlayEditLayer: (l) => set({ overlayEditLayer: l }),
  setShowGuides: (b) => {
    try {
      localStorage.setItem(SHOW_GUIDES_KEY, b ? '1' : '0')
    } catch {
      /* 忽略 */
    }
    set({ showGuides: b })
  },
  setTheme: (id) => {
    try {
      localStorage.setItem(THEME_KEY, id)
    } catch {
      /* 忽略 */
    }
    set({ theme: id })
  },
  setThemeMode: (m) => {
    try {
      localStorage.setItem(THEME_MODE_KEY, m)
    } catch {
      /* 忽略 */
    }
    set({ themeMode: m })
  },
  setSystemLight: (b) => set({ systemLight: b }),
  setSplitPct: (pct) => {
    const v = Math.min(85, Math.max(15, pct))
    try {
      localStorage.setItem(SPLIT_KEY, String(v))
    } catch {
      /* 忽略 */
    }
    set({ splitPct: v })
  },
  setEditorFontSize: (px) => {
    // L1 用户个性：只写本机偏好（**不再写谱面**；早期版本会 setPageConfig(cfg,true) 写进 # jps-config）
    const v = clampEditorFontSize(px)
    saveEditorFontSize(v)
    set({ editorFontSize: v })
  },
  setEditorFont: (f) => {
    const v = normalizeFontStack(f)
    saveEditorFont(v)
    set({ editorFont: v })
  },
  setFontOverride: (o) => {
    const next: FontOverride = { enabled: o.enabled === true, font: normalizeFontStack(o.font) }
    saveFontOverride(next)
    set({ fontOverride: next })
  },
  setPreviewZoom: (z) => {
    // adj529：钳到**绝对范围**（含适配允许的越界值）；手动边界由顶栏的 ±/拖动守 [50,200]
    const v = Math.min(PREVIEW_ZOOM_LIMITS[1], Math.max(PREVIEW_ZOOM_LIMITS[0], Math.round(z)))
    try {
      localStorage.setItem(PREVIEW_ZOOM_KEY, String(v))
    } catch {
      /* 忽略 */
    }
    set({ previewZoom: v })
  },
  setAutoWrap: (b) => {
    try {
      localStorage.setItem(AUTO_WRAP_KEY, b ? '1' : '0')
    } catch {
      /* 忽略 */
    }
    set({ autoWrap: b })
  },
  setShowScriptPad: (b) => {
    try {
      localStorage.setItem(SHOW_SCRIPT_PAD_KEY, b ? '1' : '0')
    } catch {
      /* 忽略 */
    }
    set({ showScriptPad: b })
  },
  // adj322：宽窄屏实时同步（不持久化——视口宽度本身是运行时状态）
  setIsNarrow: (b) => set({ isNarrow: b }),
  setSplitHDir: (d) => {
    try {
      localStorage.setItem(SPLITH_DIR_KEY, d)
    } catch {
      /* 忽略 */
    }
    set({ splitHDir: d })
  },
  // adj330：SpessaSynth 音源库 / 全局音色持久化
  setPlaybackHqLibrary: (id) => {
    try {
      localStorage.setItem(PLAYBACK_HQ_LIBRARY_KEY, id)
    } catch {
      /* 忽略 */
    }
    set({ playbackHqLibrary: id })
  },
  // adj448：会话级（不落盘）——每次打开试听都从「自动」开始，见 PlaybackDialog 的挂载重置
  setPlaybackHqVoice: (program) => set({ playbackHqVoice: program }),
  /**
   * adj1028：「民族乐器（拟）」页签的勾选（全选/全消/单个切换都走这里）。
   * 同一份**立刻同步给引擎**（`setEnabledEthnicVoices`）——否则要等下次重载才生效，
   * 用户勾完马上去试听会发现"没反应"。
   */
  setEthnicVoicesEnabled: (names) =>
    set(() => {
      const next = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
      saveEthnicVoices(next)
      setEnabledEthnicVoices(next)
      return { ethnicVoicesEnabled: next }
    }),
  // adj332/adj1012：切换音色启用（收藏）——只改**当前库**那一份
  togglePlaybackHqVoice: (program) =>
    set((s) => {
      const libId = resolveActiveLibrary(s.playbackHqLibrary).lib.id
      const cur = enabledVoicesOf(s)
      const next = cur.includes(program) ? cur.filter((n) => n !== program) : [...cur, program]
      const map = { ...s.playbackHqEnabledByLib, [libId]: next }
      saveHqEnabledByLib(map)
      return { playbackHqEnabledByLib: map }
    }),
  // adj340/adj1012：批量设置**当前库**的启用音色（全选/全消/导入），持久化
  setPlaybackHqEnabled: (programs) =>
    set((s) => {
      const libId = resolveActiveLibrary(s.playbackHqLibrary).lib.id
      const next = (sanitizePrograms(programs) ?? []).slice()
      const map = { ...s.playbackHqEnabledByLib, [libId]: next }
      saveHqEnabledByLib(map)
      return { playbackHqEnabledByLib: map }
    }),
  // adj1012：整份替换（导入收藏 JSON v2）——逐库过滤越界/非整数，坏数据不落盘
  replacePlaybackHqEnabledByLib: (incoming) =>
    set(() => {
      const map: Record<string, number[]> = {}
      for (const [key, value] of Object.entries(incoming ?? {})) {
        const list = sanitizePrograms(value)
        if (list) map[key] = list
      }
      saveHqEnabledByLib(map)
      return { playbackHqEnabledByLib: map }
    }),
  // adj1000：默认「轻」（用户指定）；缓存里的非法值一律回退 light
  previewSoften: ((): PreviewSoften => {
    try {
      const v = localStorage.getItem(PREVIEW_SOFTEN_KEY)
      return v === 'off' || v === 'mid' || v === 'light' ? v : 'light'
    } catch {
      return 'light'
    }
  })(),
  setPreviewSoften: (v) => {
    try {
      localStorage.setItem(PREVIEW_SOFTEN_KEY, v)
    } catch {
      /* 忽略 */
    }
    set({ previewSoften: v })
  },
  // adj1002：导出底色默认**透明**、背景图默认**不带**（用户 2026-10-19 指定）
  exportBg: ((): ExportBg => {
    try {
      const v = localStorage.getItem(EXPORT_BG_KEY)
      return v === 'white' || v === 'paper' || v === 'none' ? v : 'none'
    } catch {
      return 'none'
    }
  })(),
  setExportBg: (v) => {
    try {
      localStorage.setItem(EXPORT_BG_KEY, v)
    } catch {
      /* 忽略 */
    }
    set({ exportBg: v })
  },
  exportBgImage: loadBool(EXPORT_BG_IMAGE_KEY, false),
  setExportBgImage: (v) => {
    try {
      localStorage.setItem(EXPORT_BG_IMAGE_KEY, v ? '1' : '0')
    } catch {
      /* 忽略 */
    }
    set({ exportBgImage: v })
  },
  notice: null,
  /**
   * adj728：可带**动作按钮**（`action`）——有按钮的提示**不自动消失**，
   * 因为它是"要你去别处做一件事"（如"打开音色库手动导入"），几秒读完做不到。
   */
  showNotice: (text, kind = 'ok', action) => {
    // adj1183：允许一次给多个动作（「打开文件 / 打开文件夹」）；单个 action 保持旧用法
    const actions = action === undefined ? undefined : Array.isArray(action) ? action : [action]
    set((s) => ({
      notice: {
        text,
        kind,
        nonce: (s.notice?.nonce ?? 0) + 1,
        ...(actions !== undefined && actions.length > 0 ? { actions } : {}),
      },
    }))
  },
  clearNotice: () => set({ notice: null }),
  /* ---- adj987（用户 2026-10-18 需求）：试听「练习段」 ---- */
  practiceMarks: [],
  practiceMarkId: '',
  // 循环与"段组收起"是**本机偏好**（L1），下次打开还是这个状态
  practiceLoop: loadBool(PRACTICE_LOOP_KEY, false),
  practiceCollapsed: loadBool(PRACTICE_COLLAPSED_KEY, false),
  practiceSelStart: null,
  practiceSelStop: null,
  practiceRangeIds: [],
  practiceRangeI0: -1,
  practiceRangeI1: -1,
  practiceRangeEventCount: -1,
  practiceCountdown: null,
  setPracticeMarks: (marks) =>
    set((s) => {
      // 当前选中的标记若不在新列表里（换文档了）⇒ 退回「无」
      const keep = marks.some((m) => m.id === s.practiceMarkId) ? s.practiceMarkId : ''
      return { practiceMarks: marks, practiceMarkId: keep }
    }),
  setPracticeMarkId: (id) => set({ practiceMarkId: id }),
  setPracticeMarkPass: (id, pass) =>
    set((s) => ({ practiceMarks: s.practiceMarks.map((m) => (m.id === id ? { ...m, pass } : m)) })),
  setPracticeSel: (which, noteId) => set(which === 'start' ? { practiceSelStart: noteId } : { practiceSelStop: noteId }),
  setPracticeRangeIds: (ids, i0, i1, eventCount) =>
    set({
      practiceRangeIds: ids,
      practiceRangeI0: i0 ?? -1,
      practiceRangeI1: i1 ?? -1,
      practiceRangeEventCount: eventCount ?? -1,
    }),
  setPracticeCountdown: (n) => set({ practiceCountdown: n }),
  addPracticeMark: () => {
    const s = useUiStore.getState()
    if (!s.practiceSelStart || !s.practiceSelStop) return null
    const mark: PracticeMark = {
      id: nextMarkId(s.practiceMarks.length + 1),
      name: defaultMarkName(s.practiceMarks),
      startId: s.practiceSelStart,
      endId: s.practiceSelStop,
    }
    // adj987k：添加后清掉"待标端点"，否则预览层会继续按旧端点画线
    set({
      practiceMarks: [...s.practiceMarks, mark],
      practiceMarkId: mark.id,
      practiceSelStart: null,
      practiceSelStop: null,
    })
    return mark
  },
  deletePracticeMark: (id) =>
    set((s) => {
      const removing = s.practiceMarkId === id
      return {
        practiceMarks: s.practiceMarks.filter((m) => m.id !== id),
        practiceMarkId: removing ? '' : s.practiceMarkId,
        // adj987k（用户实报「标记段删除了，线还在」）：删掉后连"实际演奏范围"与"待标端点"一起清
        practiceRangeIds: removing ? [] : s.practiceRangeIds,
        practiceSelStart: removing ? null : s.practiceSelStart,
        practiceSelStop: removing ? null : s.practiceSelStop,
      }
    }),
  setPracticeLoop: (b) => {
    try {
      localStorage.setItem(PRACTICE_LOOP_KEY, b ? '1' : '0')
    } catch {
      /* 忽略 */
    }
    set({ practiceLoop: b })
  },
  togglePracticeCollapsed: () =>
    set((s) => {
      const next = !s.practiceCollapsed
      try {
        localStorage.setItem(PRACTICE_COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        /* 忽略 */
      }
      return { practiceCollapsed: next }
    }),
  // adj724b：确认条（嵌入版"文件被外部修改"等需要用户二选一的场景）
  ask: null,
  showAsk: (ask) => set({ ask }),
  clearAsk: () => set({ ask: null }),
  // adj928：两栏源码差异框（从确认条的「查看差异」打开；只关它不会动确认条）
  fileDiff: null,
  showFileDiff: (d) => set({ fileDiff: d }),
  closeFileDiff: () => set({ fileDiff: null }),
  // adj379：SW 新版本提示状态（部署新版后页面仍跑旧 bundle 时置 true）
  updateReady: false,
  setUpdateReady: (b) => set({ updateReady: b }),
  // adj462：底部 dock 状态机 + 导出任务指示
  //
  // adj966g（用户口径）：**底栏默认展开「工作区」**只发生在"需要权限确认、拿不到可写句柄"的那一档
  // （手机端 Web / PWA 且本端能选文件夹）；PC（桌面壳 / 桌面浏览器）与插件照旧**默认收起**
  // （PC 的习惯是直接操作系统文件，插件由 OB 自己管文件）。判据只有一处：`fileHost.shouldOpenWorkspaceDock`。
  dockOpen: initialDock().open,
  dockPanel: initialDock().panel,
  exportJob: null,
  toggleDock: (panel) =>
    set((s) => {
      // 关 → 开 + 切到该面板；已开且正是该面板 → 收起；已开但不是该面板 → 只切面板
      if (!s.dockOpen) return { dockOpen: true, dockPanel: panel }
      if (s.dockPanel === panel) return { dockOpen: false }
      return { dockPanel: panel }
    }),
  setDockPanel: (panel) => set({ dockOpen: true, dockPanel: panel }),
  // adj610：展开底栏的唯一实现（有告警先看告警；见接口处的说明）
  expandDock: (preferProblems) => set((s) => ({ dockOpen: true, dockPanel: preferProblems ? 'problems' : s.dockPanel })),
  closeDock: () => set({ dockOpen: false }),
  // adj610：Ctrl+H 的"按一下档位按钮"请求（nonce 自增，由 ToolDock 消费）
  dockSizeStep: 0,
  requestDockSizeStep: () => set((s) => ({ dockSizeStep: s.dockSizeStep + 1 })),
  // adj619：底栏入口快捷键的"打开某个页签"请求（nonce 自增，由 ToolDock 按自己的 minimized 决定语义）
  dockPanelRequest: null,
  requestDockPanel: (panel) => set((s) => ({ dockPanelRequest: { panel, nonce: (s.dockPanelRequest?.nonce ?? 0) + 1 } })),
  // adj641：Ctrl+F = 打开「查找替换」并聚焦查找框（**不走开关语义**，连按只重新聚焦；
  // 见接口处 `findFocus` 的说明）
  findFocus: 0,
  findQuery: '',
  findCaseSensitive: true,
  setFindQuery: (findQuery) => set({ findQuery }),
  setFindCaseSensitive: (findCaseSensitive) => set({ findCaseSensitive }),
  // adj642：带 seed 时连查找内容一起换掉（Ctrl+F 有选区 ⇒ 选中文本即查找内容，随即完成查找）
  requestFind: (seed) =>
    set((s) => ({
      dockOpen: true,
      dockPanel: 'find',
      findFocus: s.findFocus + 1,
      ...(seed ? { findQuery: seed } : {}),
    })),
  setExportJob: (label) => set({ exportJob: label }),
}))

/**
 * adj1028：启动时把"勾选的民族乐器"交给引擎 —— **由应用入口调用**（见 `src/main.tsx`）。
 *
 * 为什么不在这里做模块级副作用：单测/CLI 会 import 这个 store（它们的 `localStorage`
 * 要么没有、要么是桩），模块一加载就把引擎切成"只有勾选的可用"，会**意外**改掉解析结果。
 * 入口里调一次，宿主边界清楚：应用用勾选，其它宿主保持 `null`（全部可用）。
 */
export function syncEthnicVoicesToEngine(): void {
  setEnabledEthnicVoices(useUiStore.getState().ethnicVoicesEnabled)
}
