/**
 * ui/ToolDock.tsx — 底部 dock（adj462，adj465 起加"按面板的默认高度"）
 *
 * 把原先散在**对话框**里的四块内容集中到编辑区底部的一条 dock 里，**同一时间只显示一块**：
 *   告警 / 试听 / 导出 / 设置   —— 互斥切换，避免同时铺开占掉编辑区。
 *
 * ## 入口即开关（用户规格）
 * 入口保持原位：**告警**在状态栏的告警文本、**试听/导出/设置**在顶栏按钮。
 * 点入口 = 开关：dock 关 → 展开并切到该面板；已开且是该面板 → 收起 dock；已开但不是 → 只切面板。
 * 标题栏右侧另有 **× 显式关闭**（只关不切，与入口开关区分）。
 *
 * ## 状态保留（用户规格）
 * 面板**首次被激活才挂载**（避免试听面板一进编辑器就自动下载音源之类的副作用），
 * 之后**一直保持挂载**、切换只用 CSS 隐藏（`hidden` 属性）。于是面板内部的 React 状态
 * （播放进度、导出选项、设置页签…）**天然跨切换保留**，不必把它们逐个提升到 store。
 *
 * ## 高度（adj465，用户规格）
 * 每个面板有**自己的默认高度**，并且**用户当次的拖拽调整按面板各自记住**：
 *  · 告警：默认 **5 行**高（adj555：4 → 5）；设置：默认与告警同高（先这样，后续可调）；
 *  · 试听 / 导出：默认**最小高度**；
 *  · 工作区：窄屏按"列表 5 项 + 面板头"算（adj554），宽屏直接给满；
 *  · 拖拽调整 → 只影响**当次**（切走再切回该面板仍是你的高度）；
 *  · **重新打开**（关闭后再次通过入口打开）→ 清掉所有当次调整、回到各自默认。
 * 高度用**内联 px** 落到 `.tool-dock`，并同步一个 CSS 变量 `--dock-cols-h` 给设置面板的三栏当
 * `max-height` —— 这样"各栏独立滚动"是**算出来的确定值**，不依赖 flex 链的隐式收窄
 * （此前依赖 flex 链，在部分情况下栏不会收窄 → 内容溢出被 overflow:hidden 裁掉、无法操作）。
 */
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { useUiStore, type DockPanelKey } from '../store/uiStore'
import { useDocStore } from '../store/docStore'
// adj724b：嵌入版里隐藏「工作区」页签（文件操作交给 Obsidian）
import { isHostEmbedded } from '../store/hostBridge'
import { dockCopy } from '../brand/copy'
import { ToolIcon } from './ToolIcon'
import type { ToolIconName } from './toolIcons'
import { beginDrag } from './dragGesture'
// adj609：ESC 最小化底栏后把焦点交回编辑区（选择器留在编辑层，见该模块说明）
import { focusEditorTextarea } from '../editor/editorFocus'
// adj617（用户要求）：快捷键提示的唯一出处（页签 / 收起 / 档位按钮的 title 都引它）
import { KBD, withKbd } from '../brand/shortcuts'// adj528：告警面板的高度常量与算式（单一来源 + 纯函数，smoke 有断言）
import * as PROBS from './dock/problemsHeight'
// adj528：告警条数（用于"条数 × 单行实测"算出内容自然高）——纯函数，留在主包
import { summarizeProblems } from './problems'

/**
 * adj497（用户要求"各页签做成懒加载、首次打开才加载，以加快启动"）：**五个面板全部走 `React.lazy`**。
 *
 * 此前只有试听/设置/关于是 lazy，**告警与导出是静态 import** ⇒ 它们的代码（以及导出侧那串重依赖：
 * `export/export` 的 PDF 链、`export/audio` 的 WAV/MP3 编码、`playback/spessaCache` 等）
 * 会**在启动时就进主包并被加载**，白白拖慢首屏。
 *
 * 懒加载只在**首次渲染到该面板**时触发（`PANELS.filter(p => everActive.includes(p.key))` 保证
 * 只有"被打开过"的面板才渲染）⇒ 没点开过的页签，其 chunk 永远不会被下载。
 * `Suspense` 的 fallback（`.dock-empty`「加载中…」）只会在首次打开的那一瞬出现。
 */
const TryoutPanel = lazy(() => import('../dialogs/PlaybackDialog').then((m) => ({ default: () => <m.PlaybackDialog inline /> })))
// adj603（用户要求）：原「设置」一个页签拆成两个——「全局」（视图/主题/音色库）与「谱面」（布局/字体）。
// 同一个 PageConfigDialog 渲染**两份**（各带 section），子页签状态因此各自独立。
const SettingsPanel = lazy(() => import('../dialogs/PageConfigDialog').then((m) => ({ default: () => <m.PageConfigDialog inline section="global" /> })))
const ScoreSettingsPanel = lazy(() => import('../dialogs/PageConfigDialog').then((m) => ({ default: () => <m.PageConfigDialog inline section="score" /> })))
// adj492：「关于」从弹窗迁入 dock（与原「试听/导出/设置」同一套路）
const AboutPanel = lazy(() => import('../dialogs/AboutDialog').then((m) => ({ default: () => <m.AboutDialog inline /> })))
// adj497：告警 / 导出改为懒加载（原为静态 import）
const ProblemPanel = lazy(() => import('./dock/ProblemPanel').then((m) => ({ default: m.ProblemPanel })))
const ExportPanel = lazy(() => import('./dock/ExportPanel').then((m) => ({ default: m.ExportPanel })))
// adj540：工作区（移动端的"文件管理器"：选文件夹当工作区 + 子目录 + 打开/新建/重命名/移动/删除）
const WorkspacePanel = lazy(() => import('./dock/WorkspacePanel').then((m) => ({ default: m.WorkspacePanel })))
// adj562：「粘贴源码导入」迁入底栏（页签排在工作区之后）——原弹窗入口下线，与 adj492「关于」同套路
const ImportPanel = lazy(() => import('../dialogs/PasteImportDialog').then((m) => ({ default: () => <m.PasteImportDialog inline /> })))
// adj641（用户要求）：查找替换（编辑区 Ctrl+F 的落点；查找与替换整合在一个页签里）
const FindPanel = lazy(() => import('./dock/FindPanel').then((m) => ({ default: m.FindPanel })))

/** 面板（顺序即标签栏顺序）；adj540：工作区**排第一**（手机端文件操作主入口，用户要求）；
 *  adj562：导入**紧跟在它后面**（用户要求"就在工作区后面加一个「导入」页签"）；
 *  adj641：查找替换**再紧跟导入**（同属"改内容"的动作，且它与导入一样是编辑期的操作面板）；
 *  adj603：「谱面」紧跟在「全局」（原「设置」）后面（用户要求拆分后再成对出现） */
const PANELS: readonly { key: DockPanelKey; render: ComponentType }[] = [
  { key: 'workspace', render: WorkspacePanel },
  { key: 'import', render: ImportPanel },
  { key: 'find', render: FindPanel },
  { key: 'problems', render: ProblemPanel },
  { key: 'tryout', render: TryoutPanel },
  { key: 'export', render: ExportPanel },
  { key: 'settings', render: SettingsPanel },
  { key: 'score', render: ScoreSettingsPanel },
  { key: 'about', render: AboutPanel },
]

/**
 * dock 高度 = 外壳（抓手 + 页签栏）+ 内容区（上下内边距 + 内容本身）。
 * 这些值要和 `index.css` 里的实际样式对齐：
 *  · 抓手 `.tool-dock-resize` = 5px（**桌面**；粗指针设备上 CSS 把 `--jp-resize-h` 加到 14px）；
 *  · 页签栏（adj509：参照顶栏按钮样式 + 固定高度）= 38px（`.tool-dock-tabs` 高度固定，内含
 *    上下 padding 2×2 + 下边框 1 + 内置页签 28px）；
 *  · 内容区 `.tool-dock-pane` 上下内边距 = 8 + 10 = 18px。
 *
 * ⚠ adj521：下面这几个常量只是**首帧兜底**——真正参与计算的外壳高度是**运行时实测**的
 * `chromeH`（见组件内的测量 effect）。原因：抓手高度由 CSS 变量 `--jp-resize-h` 决定，而它在
 * `@media (pointer: coarse)`（手机/平板）下是 **14px** 而不是 5px ⇒ 写死的 `CHROME_H=43`
 * 在手机上比真实外壳（14+38=52）**矮 9px**，最小档会把页签栏压掉一截（用户报"底栏最小化时
 * 下压、显示的最小高度小于页签栏高度"）。实测后这类"常量与 CSS 悄悄不一致"的坑从根上消失。
 */
const RESIZE_H = 5
const TABS_H = 38
const CHROME_H = RESIZE_H + TABS_H
/**
 * 告警面板的各项高度常量与算式**统一来自 `ui/dock/problemsHeight.ts`**（adj528）——
 * 那里是"单一来源 + 纯函数"，并被 `scripts/smoke.mts` 直接断言；
 * 本文件只做"读 DOM 数值 → 调用"的薄接线。
 */
const PANE_PAD_H = PROBS.PANE_PAD_H
const ROW_H = PROBS.ROW_H
const PROBLEMS_HEAD_H = PROBS.PROBLEMS_HEAD_H
/**
 * adj554（v0.28.2，用户要求）：工作区窄屏建议高度 = 列表**5 项** + 面板头 + 结构间隙；
 *  宽屏仍走 `maxH()`（adj540 "宽屏一次看全"口径不变）。
 *  这些是**结构常数**——`.ws-row` / `.ws-head` 的具体像素由运行时实测（见下面 `workspaceRowH` /
 *  `workspaceHeadH`），常量仅保留 5 项 + 盒子自身 padding/border/gap。
 *  列出来的目的是：哪几个像素是"盒子自身的"、哪几个是"列表行数 × 单行高"，一眼能分清，
 *  改的时候不至于把测量与硬编码混在一起调。
 */
/** `.ws-list` 上下内边距（4 + 4 = 8） */
const WS_LIST_PAD_V = 8
/** `.ws-list` 上下边框（1 + 1 = 2） */
const WS_LIST_BORDER_V = 2
/** `.ws-panel` `gap`（面板头与列表之间的间距） */
const WS_PANEL_GAP = 8
/** 窄屏下"建议档"要显示多少项（用户口径：与告警 adj555 保持一致的"5"） */
const WORKSPACE_VISIBLE_ROWS = 5
/** adj554：`.ws-row` 高度实测未到位时的兜底（`padding: 9px 8px; font-size: 13px` 实测 ≈ 36） */
const WORKSPACE_ROW_H_FALLBACK = 36
/** adj554：`.ws-head` 高度实测未到位时的兜底（28px 按钮 + 面包屑 → 取大者） */
const WORKSPACE_HEAD_H_FALLBACK = 28
/**
 * adj520：dock 的**绝对最小高度** = 外壳高度（抓手 + 页签栏）——「最小高度」档位与拖拽/键盘的
 * 下限都用它：最小化后**仍能看到并点击页签 / 关闭 / 档位按钮**，随时可点回建议档、或向上拖回来。
 *
 * 为什么不再是 `MIN_H`(=95) / `MIN_H_SETTINGS`(=133)（adj468-adj516 的"留出可交互内容"兜底）：
 *   它们是**拖拽下限**，会让"最小高度"这一档**根本到不了**——用户点"最小"时高度被钳回 95/133，
 *   看起来就是"只有两段在切换"（用户报的就是这个）。adj513/516 又给告警面板开了"无告警时可低于
 *   MIN_H"的口子，导致同一份下限**按面板/告警数给出 0 / 95 / 133 三种结果**，语义已经混乱。
 *   现在统一成一个物理下限（外壳高度），既让三段都真正可达，也顺带让"始终允许调整高度"成立。
 *
 * adj521：**没有对应的常量**——下限一律取组件内**实测的 `chromeH`**（原因见其状态说明：
 * 手机上抓手是 14px 而非 5px）。`CHROME_H` 只作为"尚未测量"时的首帧兜底。
 *
 * adj509：调整上限——宽屏下让"设置左栏页签"能**至少显示 3 个**（之前的鼠标滚动一档=3 项，
 * 但宽屏只能看到 2 个 ⇒ 第 3 个"音色库"一直显示不到）。把上限从 420 提到 460，让宽屏的
 * `dock-height` 默认值相应抬升。
 */
const maxH = () => Math.min(Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * 0.55), 460)

/** adj520：三段高度的三个档位名 */
type SizePreset = 'max' | 'suggested' | 'min'

/**
 * adj520：档位按钮的**4 相位循环表**（用户规格，见 `ToolDock` 内 `cycleDockHeight` 的说明）。
 * 高度序列：`建议 → 最大 → 建议 → 最小 → 建议 → 最大 → …`
 * `icon` 是该相位下按钮要显示的图标（`上.png` / `下.png`，见 `toolIcons.ts` 的 `up` / `down`），
 * 语义 = "点一下会往哪走"：向上（变高）显示上箭头、向下（变矮）显示下箭头。
 */
const SIZE_PHASES: readonly { cur: SizePreset; next: SizePreset; icon: 'up' | 'down' }[] = [
  { cur: 'suggested', next: 'max', icon: 'up' },
  { cur: 'max', next: 'suggested', icon: 'down' },
  { cur: 'suggested', next: 'min', icon: 'down' },
  { cur: 'min', next: 'suggested', icon: 'up' },
]

/** 与 CSS 里设置面板的窄屏断点（`@container (max-width: 720px)`）保持一致 */
const DOCK_NARROW_W = 720

/**
 * adj554（v0.28.2，用户要求）：工作区窄屏建议高度 = "**刚好装下列表 5 项 + 面板头**"。
 *
 * 此前（adj540）沿用 `settingsDefaultH + 44px` 的近似——能装下右侧那列操作按钮，却把列表压成
 * "看不到几条"。改为按面板真实结构算：chrome + pane padding + 面板头 + 8px gap + 5 × 行高
 * + list 自身 padding/border；行高/面板头都用实测值（见下面的 `workspaceRowH` / `workspaceHeadH`），
 * 实测不到位则用 `*_FALLBACK`。宽屏走 `maxH()`（adj540 口径不变），所以这个函数只在窄屏被调。
 *
 * adj587（用户要求"将导入、设置页的底栏高度设置为与工作区页的高度相同"）：这个算式现在也是
 * **导入 / 设置**两个页签的建议高度 ⇒ 三者同高；各自面板内部自己滚动。
 */
const workspaceDefaultH = (rowH: number, headH: number, chromeH: number): number =>
  chromeH
    + PANE_PAD_H
    + headH
    + WS_PANEL_GAP
    + (rowH * WORKSPACE_VISIBLE_ROWS + WS_LIST_PAD_V + WS_LIST_BORDER_V)

/**
 * 各面板**兜底**默认高度（实测 AUTO_FIT 前的占位；AUTO_FIT 项在 `measured` 到位后会被覆盖）。
 * · 告警/试听/导出/关于：实测"能显示全内容的最小高度"（AUTO_FIT）；
 * · **工作区 / 导入 / 设置：同一个高度**（adj587，见下）。
 *
 * adj510：告警的兜底改为「**最多 `PROBLEMS_MAX_VISIBLE_ROWS` 条**可见」的高度
 * （= 外壳 + `PANE_PAD_H` + `ROW_H × PROBLEMS_MAX_VISIBLE_ROWS` + problems-head），
 * ——用户要求"打开告警页签时底栏 dock 最高只显示两个告警的高度"（adj524：4 行 ⇒ adj555：5 行）。
 * 多于 `PROBLEMS_MAX_VISIBLE_ROWS` 条时面板内部滚动查看（`problems-list` 的 `overflow-y: auto`）。
 * adj521：外壳高度改为**传入**（实测 `chromeH`）。
 */
const defaultH = (
  key: DockPanelKey,
  narrow: boolean,
  chromeH: number,
  // adj554：工作区面板的"实测行高 + 面板头高"——由 `forPanel` 把组件内的 useState 传进来；
  // 不能直接读模块外作用域（`defaultH` 是模块级函数、不是组件）。
  workspaceRowH: number,
  workspaceHeadH: number,
): number => {
  // adj510：告警**兜底** = `PROBLEMS_MAX_VISIBLE_ROWS` 行告警 + 面板头（problems-head ≈ 28px）；
  // AUTO_FIT 实测接管后会按"内容自然高" 调整，但始终 cap 在同一行数（`measured` 已在 `forPanel`
  // 里钳制过；详见 `capProblemsContentHeight`）。
  if (key === 'problems') return chromeH + PANE_PAD_H + PROBLEMS_HEAD_H + ROW_H * PROBLEMS_MAX_VISIBLE_ROWS
  /**
   * adj587（用户要求）：**工作区 / 导入 / 设置三个页签的建议高度完全一致**——用户原话"将导入、
   * 设置页的底栏高度设置为与工作区页的高度相同"。
   *
   * 三个面板原来各算各的：工作区 = 5 项列表 + 面板头（窄屏）/ `maxH()`（宽屏）；设置 = 内容区
   * `SETTINGS_ROWS` 行（窄屏）/ `maxH()`（宽屏）；导入 = 固定的 `IMPORT_DEFAULT_CONTENT_H`。
   * 结果是"切页签时底栏高度乱跳"，用户要的是**一个高度**。
   *
   * 所以这里统一成**工作区那一套**（窄屏 = 列表 5 项 + 面板头；宽屏 = `maxH()`），
   * 三个面板的内容区各自 `overflow-y: auto` 兜住放不下的部分：
   *  · 工作区/导入都是**动态列表/填满型**内容（进出子目录、增删改、粘贴框随高度变），走 AUTO_FIT
   *    会让高度每次导航都跳，故一律**固定默认 + 内部滚动**（adj523/adj562 的口径不变）；
   *  · 设置面板同理（它本来就不在 `AUTO_FIT` 里，见 `AUTO_FIT` 常量的说明）。
   */
  // adj603：'score'（谱面设置）与 'settings'（全局设置）同一套高度口径
  if (key === 'workspace' || key === 'settings' || key === 'score' || key === 'import')
    return narrow ? workspaceDefaultH(workspaceRowH, workspaceHeadH, chromeH) : maxH()
  // adj494：关于/试听/导出走 AUTO_FIT（实测内容高）；这里的值是**首次测量前的兜底**
  return chromeH
}

/**
 * 夹紧到 [**外壳最小高度**, 上限]。
 *
 * adj520：下限统一为**外壳高度**（抓手 + 页签栏），**不再按面板/告警数给不同的下限**
 * （adj468/adj513/adj516 曾给出 0 / 95 / 133 三种结果，把"能到多小"变成了面板相关的隐式规则，
 *  直接后果是"最小高度"档永远到不了、以及"只有两段在切换"）。物理下限之外由内容区的
 * `overflow-y: auto` 兜底——高度不够就滚动，不需要用"抬高下限"来保护内容。
 *
 * adj521：下限不再取写死的 `MIN_DOCK_H`，而是**由调用方传入实测的 `chromeH`**——粗指针设备
 * （手机）上 CSS 把抓手 `--jp-resize-h` 从 5px 加到 14px，写死的 43px 会比真实外壳（52px）矮，
 * 最小档因此把页签栏压掉一截（用户报"下压、显示的最小高度小于页签栏高度"）。
 * 上限同时兜一道 `Math.max(maxH(), chromeH)`：视口极矮时 `maxH()` 可能比外壳还小，
 * 不兜会出现"下限 > 上限"的反向钳制（三档排序与档位判定都会失真）。
 */
const clampH = (v: number, chromeH: number) => {
  const hi = Math.max(maxH(), chromeH)
  return Math.min(Math.max(Math.round(v), chromeH), hi)
}

/**
 * 底栏面板页签（adj486：图标改用**顶栏同一套矢量图标**；adj492：新增「关于」；adj562：新增「导入」）。
 *
 * 由来（用户报）：这几个页签此前用的是 **Unicode 字符**（`⚠ ▶ ⬇ ⚙`）当图标——与顶栏按钮那套
 * "用户设计的线稿图标"不是一路货：字形粗细/留白/基线各不相同，与面板里的其它图标摆在一起显得杂，
 * 而同一个"试听/导出/设置"在顶栏是设计图标、在底栏却是个字符。现统一为 `ToolIcon`（同一套 PNG + mask 上色）。
 *
 * adj565（用户要求）：**最后一个字符兜底也没了**——告警用 `public/icons/告警.png`、关于用
 * `public/icons/关于.png`。至此 7 个页签**全部**是设计图标，于是把 `glyph` 字段与
 * `t.icon ? <ToolIcon/> : t.glyph` 那个分支一并删掉（类型上 `icon` 变为**必填**），
 * 从结构上杜绝"再借某个字符当图标"（与 adj458 删掉 `rotate` 复用同一思路）。
 */
const TABS: { key: DockPanelKey; label: string; icon: ToolIconName; kbd?: string }[] = [
  // adj540：工作区排第一（手机端文件操作主入口，用户要求）；图标用 `public/icons/工作区.png`
  // adj617（用户要求）：页签的提示文本后面带上快捷键（键名来自 `brand/shortcuts.ts` 一处定义）
  //
  // adj724b（用户实测反馈 #2）：**嵌入版里不显示"工作区"页签**。
  // 理由（用户原话）：「工作区已没有存在的意义，除了保存，所有与文件相关的操作都可以由 ob 代劳」。
  // 实现：`visibleTabs` 过滤掉它（见下方），其它形态（网页版 / 桌面版）保持原样。
  { key: 'workspace', label: dockCopy.tabWorkspace, icon: 'workspace', kbd: KBD.workspace },
  // adj562：导入紧跟工作区（用户要求）；adj564：图标用设计图 `public/icons/导入.png`
  { key: 'import', label: dockCopy.tabImport, icon: 'import', kbd: KBD.import },
  // adj641（用户要求）：查找替换紧跟导入（同属"改内容"的动作）；图标是本次新画的放大镜（`public/icons/查找.png`）
  { key: 'find', label: dockCopy.tabFind, icon: 'find', kbd: KBD.find },
  // adj565：告警图标由 `⚠` 字符换成设计图 `public/icons/告警.png`
  { key: 'problems', label: dockCopy.tabProblems, icon: 'problems', kbd: KBD.problems },
  { key: 'tryout', label: dockCopy.tabTryout, icon: 'play', kbd: KBD.tryout },
  { key: 'export', label: dockCopy.tabExport, icon: 'export', kbd: KBD.export },
  // adj603：原「设置」页签改名为「全局」（本机偏好），紧跟其后新增「谱面」（谱面设置）
  { key: 'settings', label: dockCopy.tabSettings, icon: 'settings' },
  { key: 'score', label: dockCopy.tabScore, icon: 'scoreSettings' },
  // adj565：关于图标由 `ⓘ` 字符换成设计图 `public/icons/关于.png`
  { key: 'about', label: dockCopy.tabAbout, icon: 'about' },
]

/**
 * adj469：**内容较少的面板默认高度 = "能显示全内容的最小高度"**。
 * 这几块的内容高度随 dock 宽度重排而变（导出按钮是 auto-fit 网格、关于是「品牌 + 正文」两栏），
 * 常量定不准，所以实测：取 `pane.scrollHeight` 作为"内容自然高"。
 *
 * ⚠ adj523：这里原写的是"`pane.scrollHeight` 不受当前可视高度影响，恒为内容自然高度"——**这句是错的**，
 * 也正是"建议高度随切过来的方向而变"的根因：`scrollHeight === max(内容高, clientHeight)`，
 * 而当时 `.tool-dock-pane` 是 `flex: 1 1 auto`（被拉伸到 dock 高度）⇒ **内容比可用高度小时候，
 * 读数就等于"当前 dock 有多高"**。于是从"最大"切"建议"时量到的是 417px（拉伸后的可用高度）、
 * 从"最小"切过来量到的才是真实内容高（用户报：从最大切不正好、从最小切正好）。
 * 现由 CSS 保证 pane **按内容取高**（`.tool-dock-pane { flex: 0 0 auto }`，设置/告警两条例外
 * 各自覆盖回 `1 1 auto` 且不依赖这个读数），`scrollHeight` 才真正恒等于内容自然高。
 * 告警**也**用它（adj510：与试听/导出/关于同一套机制 ——
 * "能装下内容的最小高度"），但**内容本身高度被 cap**（见 `PROBLEMS_MAX_VISIBLE_ROWS`）：
 * 告警自然内容 > `PROBLEMS_MAX_VISIBLE_ROWS` 行时，列表内部可滚动，dock 自身只装这么多行的可见高度。
 * 设置/导入/工作区不走 AUTO_FIT（三者按 adj587 的同一个建议高度定高，内容各自内部滚动）。
 * adj494：加入 `about` —— 用户要求"打开关于时应以能够显示全内容为宜"。
 * adj510：告警（`problems`）加入 AUTO_FIT，与试听/导出/关于统一按"内容自然高"定 dock 高度。
 * adj641（用户要求）：**查找替换（`find`）也走 AUTO_FIT** —— 它是一个两行输入 + 一行按钮的小面板，
 *   按内容自然高最合适（拖高之后输入框跟着变宽、内容仍在上沿，不会像工作区那样需要"列表 5 项"的口径）。
 * （内容再长也受 `maxH()` 上限约束，超长时仍可滚动。）
 */
const AUTO_FIT: readonly DockPanelKey[] = ['problems', 'tryout', 'export', 'about', 'find']

/**
 * 告警面板在**建议档**下最多显示几行（超出部分由列表自身滚动查看）。
 *
 * adj510：定为 **2 行** —— 当时底栏高度只能靠拖拽调整，"默认就给很高"会挤占编辑区，
 * 所以取一个保守值，让用户需要时自己拖高。
 * adj524（用户要求）：**2 → 4 行** —— 底栏有了高度档位按钮（adj519/adj520）之后，
 * "默认给多一点"不再是负担：嫌高按一下就能切到最小（只留页签栏），想要更高按一下切到最大。
 * adj555（v0.28.2，用户要求）：**4 → 5 行** —— 与工作区窄屏"列表 5 项"保持一致；
 * 建议档可以承担"一次看全 5 条告警"的职责，减少"还得先拖大才看得见"的次数。
 * （0/1/2 条告警仍按内容自然高收缩，不受本上限影响；只有超过本行数才滚动。）
 * adj528：常量搬到 `ui/dock/problemsHeight.ts`（与算式同处一地，smoke 直接断言）。
 */
const PROBLEMS_MAX_VISIBLE_ROWS = PROBS.PROBLEMS_MAX_VISIBLE_ROWS

export function ToolDock() {
  const dockOpen = useUiStore((s) => s.dockOpen)
  const dockPanel = useUiStore((s) => s.dockPanel)
  const setDockPanel = useUiStore((s) => s.setDockPanel)
  const closeDock = useUiStore((s) => s.closeDock)
  /** adj610：Ctrl+H 发来的"按一下档位按钮"请求（nonce 自增；见 `cycleDockHeightRef` 处的消费逻辑） */
  const dockSizeStep = useUiStore((s) => s.dockSizeStep)
  // 首次激活即挂载；此后常挂载（切换仅用 hidden 隐藏）→ 面板内部状态天然保留
  const [everActive, setEverActive] = useState<readonly DockPanelKey[]>([])
  /** adj465：各面板"当次"被拖拽调整过的高度（未调整则用 DEFAULT_H） */
  const [heights, setHeights] = useState<Partial<Record<DockPanelKey, number>>>({})
  /**
   * adj469：试听 / 导出 的默认高度取「**能显示全内容的最小高度**」（见 AUTO_FIT 说明）。
   * 内容是懒加载的（React.lazy），首次打开时先渲染 Suspense 占位，chunk 到位后内容才真正出现，
   * 所以除了 resize 复测，还用 MutationObserver 盯住 pane 的子树变化再复测一次。
   */
  const [measured, setMeasured] = useState<Partial<Record<DockPanelKey, number>>>({})
  /**
   * adj520：档位按钮的**循环相位**（0..3，见模块级 `SIZE_PHASES`）。
   * 声明在这里（而非使用处附近）是因为下面几个 effect 也要重置它。
   */
  const [sizePhase, setSizePhase] = useState(0)
  /**
   * adj611（用户要求）：**"最小化"是底栏的一个状态，不是某个面板记住的高度**。
   *
   * 用户口径："底栏最小化的情况下点击底栏页签，应该切换到该页签并切换建议高度，
   * 底栏高度调整按钮状态同步调整。"
   *
   * 为什么必须做成独立状态（而不是像 adj608 那样写 `heights[dockPanel] = 外壳高`）：
   *  · 写进 `heights` 等于**那个面板"记住了"外壳高** ⇒ 从最小档切走、再切回该面板时，
   *    内容区仍是 0 高（用户看到的是"这个页签坏掉了"）；实测就是这么撞出来的：
   *    在「导出」上按 ESC 最小化 → 切到别的页签 → 再切回「导出」，高度是 43px 而不是它的内容高。
   *  · 独立状态还有一个好处：最小化**不破坏**用户给该面板拖出来的高度——退出最小化后
   *    回到的就是"他自己那个高度"（没拖过则是建议高度）。
   *
   * 于是 `dockH = minimized ? 外壳高 : clamp(heights[panel] ?? forPanel(panel))`；
   * 任何"落具体高度"的动作（拖拽 / 键盘 bump / 档位循环 / 点页签）都经 `applyHeight()` 退出该状态。
   */
  const [minimized, setMinimized] = useState(false)
  /**
   * adj521：**实测的外壳高度**（抓手 `.tool-dock-resize` + 页签栏 `.tool-dock-tabs`）。
   *
   * 为什么必须实测：抓手高度来自 CSS 变量 `--jp-resize-h`，桌面是 5px、而 `@media (pointer: coarse)`
   * （手机/平板）下是 **14px** ⇒ 写死的 `CHROME_H=43` 在手机上比真实外壳（14+38=**52**）矮 9px。
   * 后果：最小档把 dock 设成 43px 时，容器比"抓手+页签栏"的需要还矮，页签栏被 `overflow: hidden`
   * 裁掉一截（用户报"手机端底栏最小化时下压、显示的最小高度小于页签栏高度"）。
   * 同一处偏差还会污染所有按 `CHROME_H` 算出来的高度（告警 cap、设置 6 行、建议档……），
   * 所以统一改为"量出来再用"。首帧未量到之前用常量兜底。
   */
  const [chromeH, setChromeH] = useState(CHROME_H)
  /**
   * adj478：判断"是否窄屏布局"。CSS 用的是**容器查询**（按 dock 自身宽度，断点 720px），
   * 但设置面板的默认高度需要在 JS 里算（窄屏要额外留出下方按钮行），所以这里量一下 dock 宽度，
   * 阈值与 CSS 的 `DOCK_NARROW_W` 保持同一个数。
   */
  const dockRef = useRef<HTMLElement | null>(null)
  const [dockW, setDockW] = useState(0)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ y: number; h: number } | null>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    const el = dockRef.current
    if (!el) return
    const measure = () => setDockW(el.getBoundingClientRect().width)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [dockOpen])
  const narrow = dockW > 0 && dockW <= DOCK_NARROW_W
  /**
   * adj521：实测外壳高度（抓手 + 页签栏）——见 `chromeH` 状态的说明。
   * 观察这两个元素自身的尺寸：`--jp-resize-h` 随 `(pointer: coarse)` 变化（5px ↔ 14px）时
   * ResizeObserver 会触发重测；窗口 resize / 旋转屏 / 缩放也一并覆盖（外加 `resize` 监听兜底）。
   * 这两个元素都是 `flex: 0 0 auto`（不随 dock 高度收缩），所以"量它们"不会与"设置 dock 高度"
   * 形成互相触发；量到之后只在变化超过 0.5px 时才 setState，进一步避免抖动。
   */
  useLayoutEffect(() => {
    if (!dockOpen) return
    const root = dockRef.current
    if (!root) return
    const resizeEl = root.querySelector<HTMLElement>('.tool-dock-resize')
    const tabsEl = root.querySelector<HTMLElement>('.tool-dock-tabs')
    const measure = () => {
      const h =
        (resizeEl?.getBoundingClientRect().height ?? RESIZE_H) + (tabsEl?.getBoundingClientRect().height ?? TABS_H)
      if (h <= 0) return
      setChromeH((prev) => (Math.abs(prev - h) > 0.5 ? h : prev))
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (resizeEl) ro.observe(resizeEl)
    if (tabsEl) ro.observe(tabsEl)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [dockOpen])
  /**
   * adj554：工作区面板的**列表行高**（实测 `.ws-list .ws-row`）——用于算"窄屏显示 5 项"的高度。
   * `.ws-row` 在窄屏时是图标 + 文件名一行文字（搜索结果可能两行兜底），行高在不同视口下会随
   * 字号/dpi 变化，所以必须实测；空目录没有行可量，未测到前用 `WORKSPACE_ROW_H_FALLBACK` 兜底。
   */
  const [workspaceRowH, setWorkspaceRowH] = useState(WORKSPACE_ROW_H_FALLBACK)
  /**
   * adj554：工作区面板**顶部行**（切换工作区按钮 + 路径面包屑）的实测高度——
   * 也是"5 项"高度里的固定开销之一；未测到前用 `WORKSPACE_HEAD_H_FALLBACK` 兜底。
   */
  const [workspaceHeadH, setWorkspaceHeadH] = useState(WORKSPACE_HEAD_H_FALLBACK)
  useEffect(() => {
    if (!dockOpen || dockPanel !== 'workspace') return
    const pane = bodyRef.current?.querySelector<HTMLElement>('.pane-workspace')
    if (!pane) return
    const head = pane.querySelector<HTMLElement>('.ws-head')
    const row = pane.querySelector<HTMLElement>('.ws-list .ws-row')
    if (head) {
      const h = head.getBoundingClientRect().height
      if (h > 0 && Math.abs(h - workspaceHeadH) > 0.5) setWorkspaceHeadH(h)
    }
    if (row) {
      const h = row.getBoundingClientRect().height
      if (h > 0 && Math.abs(h - workspaceRowH) > 0.5) setWorkspaceRowH(h)
    }
  }, [dockOpen, dockPanel, everActive.length, workspaceHeadH, workspaceRowH, narrow])

  /**
   * adj556（用户要求"页签始终显示图标，靠左右滚动查看视界外的页签"）：
   * `.tool-dock-tabstrip` 的**横向溢出状态**——左右两端是否还能再滚。
   * 两个箭头按钮（`.tool-dock-tab-arrow`）只在"该方向还有内容"时才渲染，滚到尽头就消失。
   * 与输入条 adj553 的 `padOverflow` 同思路，但去掉了移动端触摸滑动的部分（移动端本就可触摸滑动；
   * 这里补的是**桌面端**鼠标路径——滚轮转横向 + 箭头翻页）。
   */
  const tabstripRef = useRef<HTMLDivElement | null>(null)
  /**
   * adj567：`overflowing` = **页面是否真的溢出**（与滚动位置无关），用来决定"要不要预留两个箭头槽位"。
   * 见下面 JSX：一旦溢出，两个箭头按钮就**始终占位**、只切换 `visibility`
   * ⇒ tabstrip 的宽度在滚动过程中**恒定**。
   *
   * 为什么必须这样：箭头是 tabstrip 的**兄弟节点**（adj557：左右两侧不随页签滚动），
   * 所以"箭头出现/消失"会**改变 tabstrip 的可用宽**（每个 21px，两个都出现就是 42px）。
   * 于是"把当前页签滚进视界"这类**按当前宽度算出目标位置**的操作会被自己触发的变化推翻：
   * 对齐后箭头才出现 → 可滚区变窄 → 刚对齐的页签又被挤出 21~42px。
   * 预留槽位把这个反馈彻底切掉（本轮真机测试就是这样抓到的：顶栏点「设置」后差 21px）。
   */
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false, overflowing: false })
  const syncTabOverflow = useCallback(() => {
    const el = tabstripRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    // 与 adj553 同款容差：1px 之内视作"贴边"，避免 sub-pixel 抖动。
    // adj561：**只在真的变化时才 setState**——箭头出现/消失会改变 tabstrip 的可用宽，
    // 进而再触发一次 RO 回调；若无条件 `setState({...})` 每次都换新对象引用，会多一轮渲染
    // （虽不会死循环，但没必要），用"同值返回 prev"直接短路。
    const left = el.scrollLeft > 1
    const right = max > 1 && el.scrollLeft < max - 1
    const overflowing = max > 1
    setTabOverflow((prev) =>
      prev.left === left && prev.right === right && prev.overflowing === overflowing ? prev : { left, right, overflowing },
    )
  }, [])
  /**
   * adj561（用户报"手机端页签过多/滚动时**没有适时显示** `<` `>` 按钮，PC 端却有"）：
   * **依赖必须含 `dockOpen`**——底栏关着时组件走 `if (!dockOpen) return null`，
   * `.tool-dock-tabstrip` 根本没进 DOM，而本 effect 原先只依赖稳定的 `syncTabOverflow`
   * ⇒ 首次（也是唯一一次）运行发生在底栏关闭时，`tabstripRef.current === null` 直接 early
   * return，**之后永不重跑** ⇒ 箭头状态、scroll 监听、滚轮转横向**全都没装上**。
   * PC 端之所以"看起来正常"，是因为中途切过视图/分屏时 `ToolDock` 被重挂载、而那时底栏恰好开着。
   *
   * adj561 第二处：**同时观察每个页签子元素**——`ResizeObserver` 只盯"被观察元素自身的盒尺寸"，
   * 页签内容变宽（字体加载完成、文案变化）时 tabstrip 的**盒宽不变**、`scrollWidth` 却变了，
   * 只观察容器就收不到回调（手机上首次打开时 webfont 还没就绪，正是这种情况）。
   * 另外补一次 `fonts.ready` 与首帧后的 rAF，兜住"测量时字体/布局尚未稳定"。
   */
  useLayoutEffect(() => {
    if (!dockOpen) return // 底栏关着 ⇒ tabstrip 未渲染，无 DOM 可测（见上）
    const el = tabstripRef.current
    if (!el) return
    const sync = () => syncTabOverflow()
    sync()
    // 首帧之后（含字体子集加载、容器查询命中后的重排）再补测一次
    const raf = requestAnimationFrame(sync)
    // adj556：滚轮转横向——只在容器**确实溢出**时接管；触摸板横向滚动（`deltaX` 已占主导）
    // 与 Shift+滚轮（浏览器原生已支持横向）原样放行，不劫持正常滚动（adj553 同款三条）。
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    /** 观察容器 + 全部页签：容器盒宽变（拖宽/旋转屏）与内容宽变（页签变宽）都要重算溢出 */
    const observeAll = () => {
      ro.disconnect()
      ro.observe(el)
      for (const child of Array.from(el.children)) ro.observe(child)
    }
    observeAll()
    // 页签增删（当前 TABS 静态，将来若变）⇒ 重新登记观察对象并立刻重算
    const mo = new MutationObserver(() => {
      observeAll()
      sync()
    })
    mo.observe(el, { childList: true })
    // 字体就绪后页签宽度会变（首次打开时 webfont 往往还没加载完）——这是手机上最常踩的一次
    void document.fonts?.ready.then(sync).catch(() => {})
    window.addEventListener('resize', sync)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
      ro.disconnect()
      mo.disconnect()
    }
  }, [syncTabOverflow, dockOpen])
  /** adj556：箭头翻页——按"一屏的 80%"翻；滚到尽头自动禁用（箭头消失） */
  const pageTabsBy = (dir: -1 | 1) => {
    const el = tabstripRef.current
    if (!el) return
    el.scrollBy({ left: dir * Math.max(80, el.clientWidth * 0.8), behavior: 'smooth' })
  }

  /**
   * adj567（用户反馈）：**当前面板的页签必须可见**。
   *
   * ⚠ 第一版把这段逻辑写在页签自己的 `onClick` 里 —— **只覆盖"用户用手点页签"这一条路**，
   * 而用户报的场景恰恰是"**页签在视界外**（所以根本点不到它），我是从顶栏按钮 / 菜单 /
   * 状态栏把面板打开的"：那条路不经过任何页签的 `onClick` ⇒ 修复等于没做（用户实测确认）。
   * 所以对齐函数由**两处**调用：① `dockPanel` / `dockOpen` 变化的 effect（覆盖顶栏/菜单/状态栏/快捷键）；
   * ② 页签自身的 `onClick`（覆盖"点的是**已激活**的那个页签"——此时 `dockPanel` 没变，effect 不会跑）。
   *
   * 实现要点：
   *  · **绝对** `scrollTo`（不是 `scrollBy`）：重复调用幂等；相对位移会叠加成双倍。
   *  · 用 `behavior: 'auto'`（立即到位）而不是 `'smooth'`：下面那次"延迟补正"如果撞上平滑动画，
   *    会因为"动画还没走完就算目标"而算错；立即到位则每遍都是确定性的。
   *  · 溢出时箭头**始终占位**（见 `tabOverflow.overflowing` 的说明）⇒ 宽度恒定、一遍就准；
   *    那个 60ms 的补正只是兜底（布局/字体就绪、dock 高度变化带动重排等），且**幂等**。
   *  · 只做**一次**延迟补正，不做循环——避免和用户手动滚动打架。
   */
  const alignActiveTab = useCallback(() => {
    const strip = tabstripRef.current
    if (!strip) return
    const pass = () => {
      const btn = strip.querySelector<HTMLElement>(`[data-key="${dockPanel}"]`)
      if (!btn) return
      const br = btn.getBoundingClientRect()
      const sr = strip.getBoundingClientRect()
      // 已在视界内（1px 容差）⇒ 就地不动，符合"就近"语义
      const delta = br.left < sr.left - 1 ? br.left - sr.left : br.right > sr.right + 1 ? br.right - sr.right : 0
      if (delta === 0) return
      strip.scrollTo({ left: strip.scrollLeft + delta, behavior: 'auto' })
    }
    pass()
    window.setTimeout(pass, 60)
  }, [dockPanel])

  useEffect(() => {
    if (!dockOpen) return
    alignActiveTab()
  }, [dockOpen, dockPanel, alignActiveTab])

  useEffect(() => {
    if (!dockOpen) return
    setEverActive((prev) => (prev.includes(dockPanel) ? prev : [...prev, dockPanel]))
  }, [dockOpen, dockPanel])

  // adj465：只在**重新打开**（关 → 开）时清掉当次调整；切换面板不清（切回该面板仍是你的高度）
  useEffect(() => {
    if (dockOpen && !wasOpenRef.current) {
      setHeights({})
      setMeasured({})
      // adj611：重新打开 ⇒ 退出"最小化"状态（与"清掉当次调整"同一时机）
      setMinimized(false)
      // adj520：重新打开 = 各面板回到默认高度 ⇒ 档位循环也回到起点（相位 0 = 建议，图标上箭头）
      setSizePhase(0)
    }
    wasOpenRef.current = dockOpen
  }, [dockOpen])

  // adj520：切换面板时档位循环回到起点（相位 0）——各面板高度互相独立，
  // 上一个面板循环走到哪一格不该带到下一个面板（否则新面板的"当前档"与图标指示会对不上）。
  useEffect(() => {
    setSizePhase(0)
  }, [dockPanel])

  // adj510：告警**始终**走 AUTO_FIT（与试听/导出/关于同源）——实测 pane.scrollHeight，
  // 并在 `capProblemsContentHeight` 里把"内容自然高"钳到「头 + `PROBLEMS_MAX_VISIBLE_ROWS` 行告警」的高度上限。
  // 因此：0 条 = 一行占位；1 条 = 头 + 1 行；≥ 2 条 = 头 + 2 行（面板内可滚动）。
  // adj520：不再需要订阅"告警条数"——下限统一为 `MIN_DOCK_H` 后，"少于 2 条告警要按内容自然高收缩"
  // 由 AUTO_FIT 的自然结果直接给出（73px / 64px 都 ≥ 43px 的下限，不会被钳），无需特判。
  /** 当前面板是否要按"能显示全内容的最小高度"定高（AUTO_FIT 机制） */
  const fitAllNow = AUTO_FIT.includes(dockPanel)
  /**
   * adj528：**告警条数**（渲染出的行数）。
   * "告警面板的内容自然高"现在由它（数据）× 单行实测算出，而不再读 `pane.scrollHeight`
   * —— 那条 pane 为了列表能滚必须填满 dock，读总量会被"可用高度"充气，
   * 于是"从最大切建议"会得到一个虚高的建议高度（用户连报两次，见 `ui/dock/problemsHeight.ts`）。
   */
  const errors = useDocStore((s) => s.parseResult.errors)
  const problemCount = useMemo(() => summarizeProblems(errors).total, [errors])

  /**
   * adj518（用户报"底栏 dock 应始终允许通过高度调整线调整 dock 的高度；目前除了设置页签
   * 是可以调整高度的外，其它几个页签都不能调整"）：
   *   1. 上面 `baseH` 改为 `heights[dockPanel] ?? forPanel(dockPanel)`，去掉 AUTO_FIT
   *      的"完全忽略用户拖拽值"分支（这是用户拖拽不生效的根因）。
   *   2. 本 effect 由"切换面板 / 重新打开时清掉 AUTO_FIT 面板的拖拽值"改为**只在 dock
   *      重新打开时清掉所有当次调整**（沿用 `wasOpenRef` 的"关 → 开"判定 ——见下方的
   *      `useEffect`，adj465 设计），**切换面板不再清掉用户拖拽的高度**。
   *   ⇒ 用户拖到任意高度后会**保留**到面板切换/重新打开 dock；
   *   重新打开 dock = 清掉所有当次调整 → 各面板回到各自的"内容自然高"默认。
   *   设置面板本来就不在此列（adj587：与工作区/导入同一个建议高度），保持原行为。
   */
  // 注：原 adj474 的"切换面板也清掉"分支已删除——保留会导致用户拖拽的值在切走再切回时
  // 被无意义地清掉，与"始终允许调整"的诉求冲突。

  // adj469/510：实测当前面板的内容高度（告警/试听/导出/关于均走 AUTO_FIT）。
  // 宽度变化会重排 → resize 复测；内容是懒加载的，chunk 到位后才真正出现 → MutationObserver 复测。
  useLayoutEffect(() => {
    if (!dockOpen || !fitAllNow) return
    const pane = bodyRef.current?.querySelector<HTMLElement>(`.pane-${dockPanel}`)
    if (!pane) return
    /**
     * adj522/adj528：取"内容自然高"（与当前 dock 多高**无关**）。
     *
     * 非告警面板：pane 已按内容取高（`.tool-dock-pane { flex: 0 0 auto }`，adj523）
     * ⇒ `pane.scrollHeight` 恒等于内容自然高。
     *
     * 告警面板**不能这么量**：它那条 pane 必须"填满 dock"（列表要受限高度才能滚），
     * 于是 dock 高时 `pane.scrollHeight` 会退化成"可用高度"（充气）。**adj528 起彻底不读总量**，
     * 改为「**条数（数据）× 单行实测**」——见 `ui/dock/problemsHeight.ts`：
     * 行数来自 store（不来自布局），单行高实测 `.problem-line`（**不含**展开的「正确写法」，
     * 那是它的兄弟节点），面板头/占位块也都是内容尺寸的弹性项。
     * 这样"从最大切建议"与"从最小切建议"必然算出同一个高度（用户连报两次的正是这一点）。
     */
    const measureNatural = (): number => {
      if (dockPanel !== 'problems') return pane.scrollHeight
      const head = pane.querySelector<HTMLElement>('.problems-head')
      const list = pane.querySelector<HTMLElement>('.problems-list')
      const empty = pane.querySelector<HTMLElement>('.dock-empty')
      const line = list?.querySelector<HTMLElement>('.problem-line')
      return PROBS.problemsContentHeight({
        problemCount,
        headH: head?.getBoundingClientRect().height ?? 0,
        rowH: line?.getBoundingClientRect().height ?? 0,
        emptyH: empty?.getBoundingClientRect().height ?? 0,
        // 面板"收起"（`open === false`）时只剩面板头、不渲染列表
        collapsed: !!head && !list,
      })
    }
    const measure = () => {
      const nat = measureNatural()
      if (nat <= 0) return
      setMeasured((prev) => (Math.abs((prev[dockPanel] ?? 0) - nat) > 2 ? { ...prev, [dockPanel]: nat } : prev))
    }
    measure()
    const mo = new MutationObserver(measure)
    mo.observe(pane, { childList: true, subtree: true })
    const ro = new ResizeObserver(measure)
    ro.observe(pane)
    window.addEventListener('resize', measure)
    return () => {
      mo.disconnect()
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [dockOpen, dockPanel, everActive.length, fitAllNow, problemCount])

  /**
   * adj528：cap 算式搬到 `ui/dock/problemsHeight.ts`（与"内容自然高"同一处、smoke 可断言）。
   * 说明：`problemsContentHeight()` 已经按 `PROBLEMS_MAX_VISIBLE_ROWS` 收口，
   * 所以 cap 对它是**幂等**的；留着它是为了兜住"实测值异常偏大"的输入。
   */
  const forPanel = (key: DockPanelKey): number => {
    // 实测值已含内容区上下内边距，所以这里只加外壳（adj521：外壳用实测值）
    if (AUTO_FIT.includes(key) && measured[key]) {
      const measuredContent = key === 'problems' ? PROBS.capProblemsContentHeight(measured[key]!) : measured[key]!
      return chromeH + measuredContent
    }
    // adj554：工作区的"5 项"算式需要实测的 `.ws-row` / `.ws-head` 高度，从模块外传入
    // adj587：导入 / 设置也走同一条（三者在 `defaultH` 里已经统一）
    return defaultH(key, narrow, chromeH, workspaceRowH, workspaceHeadH)
  }
  // adj518：baseH **始终优先用用户拖拽后的高度** `heights[dockPanel]`（仅当未设置才回退到
  // `forPanel`）。此前 bug：`fitKeys=true` 时 `baseH` 永远用 `forPanel(dockPanel)`，**完全忽略**
  // `heights[dockPanel]` ⇒ 告警/试听/导出/关于的手工拖拽不会生效，用户侧的表现是"除设置页签
  // 外其它几个页签都不能调整高度"。修法：把"是否 AUTO_FIT"的判断从 baseH 来源里去掉——
  // AUTO_FIT 仍负责"初始默认值 = 实测内容自然高"，但**一旦用户拖了**就以用户值为准。
  const baseH = heights[dockPanel] ?? forPanel(dockPanel)
  // adj611：最小化是"状态"而不是某面板记住的高度（见 `minimized` 的说明）
  const dockH = minimized ? chromeH : clampH(baseH, chromeH)

  // ---- adj520：三段高度的单按钮循环 ------------------------------------------------
  /**
   * 「建议高度」——"刚好装下当前面板内容"的高度。
   *
   * adj587（用户要求）：**工作区 / 导入 / 设置三个页签同一个建议高度**（`forPanel` 已经统一成
   * 工作区那一套），所以这里不再按面板分叉；原来那个"设置面板特例"（改用 `settingsDefaultH`
   * 以免宽屏下 `建议 === 最大`）不再需要——宽屏下三者都是 `maxH()`，末尾那道
   * `(min+8, max−8)` 夹逼本来就会把建议压到 `max−8`，三档依然严格单调。
   *
   * 末尾夹一道 `(min+8, max−8)`：极矮视口下（`maxH()` 会随视口缩到很小）"内容自然高"可能贴到
   * 上限或下限，与相邻档重合 ⇒ 又变成"只有两段"。夹一下就能把"三档两两不同"变成**结构性保证**，
   * 而不是靠数值凑巧。夹到偏小时内容不会丢——内容区本来就有 `overflow-y: auto`。
   */
  const suggestedH = (): number => {
    const raw = forPanel(dockPanel)
    const lo = chromeH + 8
    const hi = Math.max(lo, maxH() - 8)
    return Math.min(Math.max(raw, lo), hi)
  }

  /**
   * 三档目标高度（**语义严格单调**：min < suggested < max）：
   * · max       = `maxH()`（与抓手拖拽上限一致）
   * · suggested = `suggestedH()` = "刚好装下当前面板内容"的高度
   * · min       = `chromeH`（实测外壳 = 抓手 + 页签栏），内容区收起到 0
   */
  const dockHeightFor = (size: SizePreset): number =>
    size === 'max' ? maxH() : size === 'min' ? chromeH : suggestedH()

  /**
   * **4 相位**循环表（用户规格）——每点一次按钮**走一步**：
   * ```
   *   相位 0：当前=建议 → 点击后=最大，图标 上.png（向上＝变高）
   *   相位 1：当前=最大 → 点击后=建议，图标 下.png（向下＝变矮）
   *   相位 2：当前=建议 → 点击后=最小，图标 下.png
   *   相位 3：当前=最小 → 点击后=建议，图标 上.png
   * ```
   * ⇒ 高度序列 `建议 → 最大 → 建议 → 最小 → 建议 → 最大 …`，图标始终指示"点一下会往哪走"。
   *
   * ⚠ 为什么必须是 4 相位、而不是"记住当前档位就够"：序列里**"建议"出现了两次**，
   * 但两次的下一步方向相反（先→最大、后→最小）。只按"当前高度是哪一档"推下一步是**推不出来的**
   * ——之前那版就是栽在这里：`lastSizeRef` 的两分支（suggested↔max）永远解不出 `min`，
   * 于是"只有两段在切换"（用户报）。相位计数器把这段历史显式记下来，问题自然消失。
   */
  const sizeStep = SIZE_PHASES[sizePhase] ?? SIZE_PHASES[0]

  const cycleDockHeight = () => {
    // 先按"当前相位声明的下一步"落高度，再把相位推进一格（4 步一循环）
    if (sizeStep.next === 'min') {
      /**
       * adj611：最小档 = **状态**（`minimized`），不写进该面板的高度记忆（见 `minimized` 的说明）。
       * ⚠ 这里刻意**不调 `minimizeDock()`**：那个函数自己会把相位拨到"最小"那一格（ESC 那条路
       * 需要），而本函数末尾还要再自增一格 ⇒ 拨两次就跳过了"最小 → 建议"这一格
       * （实测：循环到最小时按钮显示的是「建议（点击 → 最大）」，与实际高度不符）。
       */
      setMinimized(true)
      blurCollapsedPane()
    } else {
      applyHeight(dockHeightFor(sizeStep.next))
    }
    setSizePhase((p) => (p + 1) % SIZE_PHASES.length)
  }

  /**
   * adj608：内容区被收起来时，把**焦点从内容区里挪走**。
   *
   * 最小档只留外壳（抓手 + 页签栏），内容区高度为 0 且 `overflow: hidden`——若焦点还停在里面的
   * 输入框上，界面看不见光标、接着敲键盘却在往看不见的框里打字（点了"最小"或按了 ESC 之后都会撞上）。
   * 只处理**内容区**（`.tool-dock-body`）里的焦点：页签栏上的按钮是可见的，不动它。
   */
  const blurCollapsedPane = () => {
    const active = document.activeElement
    if (active instanceof HTMLElement && bodyRef.current?.contains(active)) active.blur()
  }

  /**
   * adj611（用户要求）：**落实一个具体高度**（拖拽 / 键盘 bump / 档位循环共用）——
   * 写入该面板的"当次高度"，同时**退出最小化状态**。
   *
   * ⚠ 最小化**不再**写成"该面板的高度 = 外壳高"（见 `minimized` 的说明）：那样一来
   * "最小化时所在的那个面板"会**记住**外壳高，切走再切回时内容区仍是 0 高（看起来就是"坏掉了"）。
   */
  const applyHeight = (next: number, key: DockPanelKey = dockPanel) => {
    setMinimized(false)
    setHeights((prev) => ({ ...prev, [key]: clampH(next, chromeH) }))
  }

  /**
   * 手动调整（拖拽 / 键盘 bump）落到一个高度：**落到外壳高就当作"最小化"**（不写面板高度记忆），
   * 否则落具体高度；两种情况都把相位拨到"下一步回建议"（见 `syncPhaseFromManualHeight`）。
   */
  const applyManualHeight = (next: number) => {
    const h = clampH(next, chromeH)
    if (h <= chromeH + 0.5) minimizeDock(false)
    else applyHeight(h)
    syncPhaseFromManualHeight(h)
  }

  /**
   * adj608（用户要求）：**把底栏最小化** = 切到"最小高度"档（只留抓手 + 页签栏），
   * 并让**高度档位按钮的状态跟着变**：相位拨到"当前 = 最小、下一按 = 建议高度"
   * （图标上箭头、title 显示「底栏高度：最小（点击 → 建议）」）。
   *
   * 为什么拨相位而不是"只改高度"：档位循环是**4 相位**（`建议 → 最大 → 建议 → 最小 → 建议`），
   * 序列里"建议"出现两次、两次的下一步方向相反，所以"当前高度"推不出"下一按去哪"——
   * 用户要的"下一按为建议高度"只能靠把相位显式拨到 `min` 那一格（`syncPhaseFromManualHeight`
   * 与手动拖到最小是同一个处理）。
   *
   * adj609（用户要求）：`toEditor = true` 时把焦点**交给编辑区**——用户口径"最小化 dock 就是
   * dock 碍事不方便编辑"，所以收完之后焦点应当在编辑区里，接着就能打字。
   * 只给 **ESC 这条路**（`toEditor = true`）用：档位按钮是个"连点循环"的控件，
   * 点完一下还可能再点第二下（建议 → 最大 → 建议 → 最小），焦点不该被抢走。
   * 编辑区不在 DOM 里（预览视图）时退回"只把焦点从被收起的内容区里挪开"。
   */
  const minimizeDock = (toEditor: boolean) => {
    setMinimized(true)
    syncPhaseFromManualHeight(chromeH)
    if (!toEditor || !focusEditorTextarea()) blurCollapsedPane()
  }

  /**
   * adj612（用户反馈"焦点在底栏**内容区**时不响应 ESC，在页签上可以"）：
   * **ESC 的判据从"焦点在底栏里"改成"底栏开着、且没有更内层的东西用掉它"**。
   *
   * 真机实测的现象与根因（`_tmp_esc_content_probe`）：
   *  · 焦点在**页签 / 抓手 / 内容里的按钮、勾选框、下拉、子页签**上 ⇒ ESC 有效；
   *  · 焦点在**内容里的不可聚焦元素**（面板容器、`.pcfg-row`、"空白处"）⇒ **点击根本不会移动焦点**，
   *    它仍停在编辑器文本域上 ⇒ 挂在 `<section>` 上的 `onKeyDown` 收不到事件，表现为"内容区不响应 ESC"
   *    （底栏越高、内容区越大，越容易点在空白上——所以用户先在"高度最高"时撞到）。
   *
   * 为什么这个更宽的判据是安全的：
   *  · **内层优先靠 `defaultPrevented`**：输入框（设置数字框 / 工作区过滤、改名）取消输入、
   *    顶栏菜单关闭、对话框关闭都会标记（前两者本来就标了，对话框那条在 `App.tsx` 里补上）；
   *    工作区「操作▾」菜单在**捕获阶段** `stopPropagation`，本监听在**冒泡阶段**、压根收不到；
   *  · 挂在 **window 冒泡**：所有内层消费者都先有机会处理；
   *  · 最小化是**非破坏**动作（只收内容区、页签栏留着，点页签即回建议高度）。
   *
   * `escMinimizeDock`（原来挂在 `<section>` 上那版）随之删除——**同一个按键只保留一条处理路径**，
   * 免得"焦点在底栏里"那条与这条各判一次、日后又漂移。
   */
  const minimizeDockRef = useRef(minimizeDock)
  minimizeDockRef.current = minimizeDock
  /**
   * adj613（用户要求）：`isTextEntry` = "这个元素正在接受键盘输入"。
   * 焦点在**底栏内容区的输入框**里时，ESC 的第一次只应"退出输入框"（blur），第二次才最小化底栏。
   * （各个输入框自己的 ESC 语义——清空过滤 / 放弃输入 / 回退数值——由它们自己的 handler 处理，
   * 这里兜的是"没有自带 ESC 处理的输入框"，比如导入页的粘贴框。）
   */
  const isTextEntry = (el: HTMLElement): boolean =>
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range', 'file'].includes(el.type)) ||
    el.isContentEditable
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (useUiStore.getState().modal) return // 对话框还没被关掉时（极端时序）也不抢
      if (!useUiStore.getState().dockOpen) return
      // adj613：底栏内容区里的输入框 ⇒ 这一下先退出输入（第二下才最小化）
      const active = document.activeElement
      if (active instanceof HTMLElement && isTextEntry(active) && dockRef.current?.contains(active)) {
        active.blur()
        return
      }
      // adj609：ESC 最小化之后焦点归编辑区（见 `minimizeDock` 的说明）
      minimizeDockRef.current(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * adj610（用户要求）：`Ctrl+H` = "按一下底栏高度档位按钮"。
   *
   * 档位循环的状态（相位 / 各面板当次高度 / 实测外壳高）都在本组件里，所以 App 只发一个
   * 一次性请求（`uiStore.requestDockSizeStep()`，nonce 自增），这里消费它并执行**同一个**
   * `cycleDockHeight()` —— 快捷键与鼠标点击走的是同一条代码，不会各自漂移。
   *
   * 用 ref 拿"最新的 cycleDockHeight"：它每次渲染都是新函数，直接进依赖数组会让本 effect
   * 每次渲染都跑（就变成"每渲染按一下按钮"了）；只依赖 nonce 才是"按一次跑一次"。
   */
  const cycleDockHeightRef = useRef(cycleDockHeight)
  cycleDockHeightRef.current = cycleDockHeight
  useEffect(() => {
    if (dockSizeStep === 0) return // 初始值（没按过 Ctrl+H）不触发
    cycleDockHeightRef.current()
  }, [dockSizeStep])

  /**
   * 当前 dock 高度处于哪一档（±2px 容差）；用户手动拖到的中间值记为 `custom`。
   * 只有几次比较、极廉价，**不用 `useMemo`** —— 它的依赖里有 `dockHeightFor`（每次渲染新建的函数），
   * 用 memo 反而要么漏依赖、要么每帧重算，是纯粹的负担（lint 也会报 exhaustive-deps）。
   */
  const heightPresetActive: SizePreset | 'custom' =
    Math.abs(dockH - chromeH) <= 2
      ? 'min'
      : Math.abs(dockH - maxH()) <= 2
        ? 'max'
        : Math.abs(dockH - suggestedH()) <= 2
          ? 'suggested'
          : 'custom'

  /**
   * 手动调整（拖拽 / 键盘 bump）落到 **min / max** 后，把相位拨到"下一步回建议"的那一格   * （min → 相位 3、max → 相位 1），使下一次点击的方向符合直觉。
   *
   * 刻意**不用 effect 监听高度**去做同步：那会让"点击按钮"与"高度变化"互相触发
   * （点击设了相位 → 高度变了 → effect 又按高度把相位改回去 ⇒ 循环卡死在同一档）。
   * 只在**用户明确的手动路径**里拨相位，按钮点击就绝不会被覆盖。
   * 落到 `suggested` 时刻意**不拨**——它对应相位 0 / 2 两格，拨哪一个都是猜。
   */
  const syncPhaseFromManualHeight = (h: number) => {
    if (Math.abs(h - chromeH) <= 2) setSizePhase(3)
    else if (Math.abs(h - maxH()) <= 2) setSizePhase(1)
  }

  /**
   * adj611（用户要求）：最小化状态下点页签 = "**我要看这个面板**" ⇒ 退出最小化，
   * 让**目标面板**回到它自己的高度（用户当次拖过的值，没拖过则建议高度），
   * 并把档位按钮的相位拨回 **0**（当前=建议、下一按=最大、图标上箭头）——用户要的
   * "底栏高度调整按钮状态同步调整"就是指这个：不能停在「最小（点击 → 建议）」那一格。
   *
   * 为什么相位也在这里显式拨（明明 `dockPanel` 一变就有个 effect 会拨到 0）：
   * 用户点的是**当前已激活**的那个页签时 `dockPanel` 不变、effect 不跑，相位会留在"最小"那格。
   */
  const exitMinimized = () => {
    setMinimized(false)
    setSizePhase(0)
  }

  /**
   * adj619（用户要求）：**底栏入口快捷键**（`Ctrl+Q/Y/B/I/\`` → 试听/导出/工作区/导入/告警）
   * 发来的"打开这个页签"请求。
   *
   * 用户口径："底栏按钮响应快捷键时，如果此时底栏 dock 为最小化，则应是展开到建议高度。"
   *
   * 语义与**点页签**完全一致（adj611：最小档下点页签 = 切页签 + 回建议高度）：
   *  · **最小化时** ⇒ 退出最小化（回到该面板自己的高度 = 建议高度 / 用户拖过的值）+ 切到该页签，
   *    **不走**"同页签就收起"那套开关语义（否则用户按下去看到的是"没反应"，甚至"底栏没了"）；
   *  · **没最小化时** ⇒ 保持原有开关语义（关 → 开；已开且正是它 → 收起；已开但不是 → 只切页签）。
   *
   * "是否最小化"是本组件的内部状态，所以 App 只发请求、由这里决定语义——与 `requestDockSizeStep`
   * 同一套路。实现上**只依赖 nonce 这个数字**，请求对象 / `minimized` / `exitMinimized` 都经 ref
   * 取最新值：否则 effect 会因为"捕获了对象/函数"被 lint 判为每次渲染都要重跑
   * （那会变成"渲染一次就开一次底栏"）。
   */
  const dockPanelRequest = useUiStore((s) => s.dockPanelRequest)
  const dockPanelNonce = dockPanelRequest?.nonce ?? 0
  const dockPanelRequestRef = useRef(dockPanelRequest)
  dockPanelRequestRef.current = dockPanelRequest
  const minimizedRef = useRef(minimized)
  minimizedRef.current = minimized
  const exitMinimizedRef = useRef(exitMinimized)
  exitMinimizedRef.current = exitMinimized
  useEffect(() => {
    if (dockPanelNonce === 0) return // 初始值（没人按过）不触发
    const req = dockPanelRequestRef.current
    if (!req) return
    const ui = useUiStore.getState()
    if (minimizedRef.current) {
      exitMinimizedRef.current()
      ui.setDockPanel(req.panel)
      return
    }
    /**
     * adj723d（用户要求「Ctrl+点音符不要另起播放，同一谱子只能有一个试听态」）：
     * **这里必须是"打开并聚焦"，不能是"开关"**。
     *
     * 原实现落地为 `toggleDock`（开关语义）：试听**已经开着**时再 `Ctrl+点音符`，
     * 会把底栏**收起来**（试听面板 `lazy` 卸载、卸载副作用里 `dispose()` 掉音频后端并清空色块轨道），
     * 而调用方紧接着又 `bumpPlaybackTick()` 要求播放 ⇒ 表现就是"另起一个播放态"、
     * 现场的高亮/色块被打断重建。`requestDockPanel` 的语义本就是"**打开并聚焦**"
     * （见 `uiStore` 里该 action 的注释），旧的开关落地与它矛盾。
     */
    ui.setDockPanel(req.panel)
  }, [dockPanelNonce])

  // adj487：拖拽改用 Pointer Events（鼠标 + 触屏 + 触控笔）——此前只监听 mousemove/mouseup，
  // 手机上拖不动。位移与结束回调都在手势里处理，不再常驻 window 监听。
  const startDrag = (e: React.PointerEvent) => {
    /**
     * adj612：`beginDrag` 会 `preventDefault()`（免得拖拽时选中文字/触发原生拖放），
     * 连带**把"按下即聚焦"也挡掉了** ⇒ 抓手从来拿不到焦点：鼠标拖过之后
     * ① 抓手上的 ↑↓/PageUp/PageDown（文档里写明的键盘调高度）用不了；② 焦点还留在原处。
     * 这里补一次显式聚焦（抓手是 `tabIndex=0` 的 `role="separator"`，本就该可聚焦）。
     */
    ;(e.currentTarget as HTMLElement).focus?.()
    beginDrag(e, {
      onStart: () => {
        dragRef.current = { y: e.clientY, h: dockH }
        document.body.style.userSelect = 'none'
      },
      onMove: (_dx, dy) => {
        const d = dragRef.current
        if (!d) return
        // 手指/鼠标向上拖（dy < 0）→ dock 变高；拖到底（外壳高）= 最小化（adj611：不写面板高度记忆）
        applyManualHeight(d.h - dy)
      },
      onEnd: () => {
        dragRef.current = null
        document.body.style.userSelect = ''
      },
    })
  }
  const bump = (delta: number) => {
    applyManualHeight(dockH + delta)
  }

  // adj491：dock 关闭时**不渲染**。⚠ 这条守卫曾在 adj487（把拖拽从 mouse 改 Pointer Events）时
  // 被连带删除——后果是「点 ✕ 后 `dockOpen` 已置 false，但组件照样渲染」⇒ 关闭按钮看着"失灵"（用户报）。
  // 凡是"按状态决定渲染与否"的早退守卫，重构它前后的代码块时必须单独核对有没有被一起删掉。
  if (!dockOpen) return null

  /**
   * adj724b（用户实测反馈 #2）：**嵌入版里隐藏「工作区」页签**。
   *
   * 用户原话：「嵌入版 iJipu 工作区已没有存在的意义，除了保存，所有与文件相关的操作都可以由 ob 代劳，
   * 因此工作区可以取消」。范围经用户确认为**仅嵌入版**——网页版 / 桌面版仍以工作区做文件管理。
   */
  const visibleTabs = isHostEmbedded() ? TABS.filter((t) => t.key !== 'workspace') : TABS

  return (    <section
      ref={dockRef}
      className={`tool-dock${dockPanel === 'settings' || dockPanel === 'score' ? ' dock-settings' : ''}`}
      // adj476：高度用内联 px 落到 `.tool-dock`。设置面板的"各栏独立滚动"改由 CSS grid 的
      // `minmax(0,1fr)` 行高保证（不再依赖 flex 链，也不再需要 --dock-cols-h 兜底）。
      style={{ height: `${dockH}px` }}
      aria-label="底部工具面板"
    >
      {/* 顶部抓手（拖拽调整高度；键盘 ↑/↓ /PageUp/PageDown）
         * adj518：抓手**总是可拖**。
         * adj520/adj521：`aria-valuemin` 取 `chromeH`（**实测**外壳高度）——与 `clampH` 共用**同一个取值**，
         * 不再出现"ARIA 报 95、实际能拖到 43"或"手机上 ARIA 报 43、实际外壳 52"这类两处各写一份的漂移。 */}
      <div
        className="tool-dock-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label={dockCopy.resizeTitle}
        aria-valuenow={dockH}
        aria-valuemin={chromeH}
        aria-valuemax={maxH()}
        tabIndex={0}
        title={dockCopy.resizeTitle}
        onPointerDown={startDrag}
        onKeyDown={(e) => {
          const big = e.key === 'PageUp' || e.key === 'PageDown'
          if (e.key === 'ArrowUp' || e.key === 'PageUp') {
            e.preventDefault()
            bump(big ? 32 : 8)
          } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
            e.preventDefault()
            bump(big ? -32 : -8)
          }
        }}
      />
      {/* 标题栏：**左端**常驻的档位/收起按钮 + 可横向滑动的面板页签 + **右端**常驻的关闭按钮
       *
       * adj525（用户要求"档位按钮和关闭按钮固定在右侧，如顶栏的主题/支持；其它页签超出视界可左右滑动"）：
       * 结构拆成「**可滚的页签区** + **三个常驻按钮**」——页签多了只在页签区内滚动，
       * 三个按钮永远可见、永远点得到。
       * 与顶栏 adj453 的修法同源：**"必须始终可见"的元素不要放进会溢出的滚动容器**，
       * 否则它们会被内容顶出可视区（此前正是如此：页签一溢出，两个按钮就被推到右边看不见，
       * 得先滑到最后才能点）。`role="tablist"` 随之移到页签区（它才是"页签的容器"）。
       * adj531（用户要求"把高度调整按钮移到最左边，手机上左边操作更顺手，也避免误按关闭按钮"）：
       * 档位按钮从 ✕ 左侧移到**页签区左边**，顺序成为「收起 → 档位 → 页签 → ✕」（DOM 顺序与视觉一致，
       * Tab 序也随之，不做 `order` 反转以免视觉与读屏/焦点序不一致）。于是：
       *   · 手机单手拇指在左半屏就能切高度；
       *   · ✕ 独自留在最右端、与档位按钮之间隔着**整条页签区**，够不到也就按不到。
       * adj541：多加一个「收起底栏」按钮（更靠左），让"收起"与"调高度"两件事在手机上都能单手点。
       * 三个按钮**仍在可滚页签区之外**（adj525 的口径完全不变），页签溢出只推动页签区内部滚动。
       * adj557（用户要求"左 / 右两侧不随页签滚动"）：这条**结构性保证**——常驻按钮在 DOM 上
       * 就是 `.tool-dock-tabstrip` 的兄弟节点、不是子节点 ⇒ 物理上不可能被页签溢出顶走。 */}
      <div className="tool-dock-tabs">
        {/* adj541（用户要求）：**收起底栏**按钮，位置在高度档位按钮**左边**。
            点它 = 收起底栏，并在编辑区左下角浮出「展开底栏」按钮（见 EditorPane 的 `.dock-fab`）。
            与档位/✕ 一样常驻（在可滚页签区之外），页签再多也不影响。 */}
        <button
          type="button"
          className="tool-dock-collapse"
          onClick={closeDock}
          // adj617（用户要求）：提示文本后面带上快捷键（Ctrl+D 展开/收起；Esc 最小化）
          title={withKbd(dockCopy.collapseTitle, KBD.dock)}
          aria-label={withKbd(dockCopy.collapseTitle, KBD.dock)}
        >
          <ToolIcon name="dockCollapse" size={16} />
        </button>
        {/* adj520：底栏高度档位切换按钮（单按钮，4 相位循环）——
            循环表见模块级 `SIZE_PHASES`；高度序列
            `建议 → 最大 → 建议 → 最小 → 建议 → …`，
            图标（`上.png` / `下.png`）指示"点一下会往哪走"：
            相位 0（建议→最大）上、1（最大→建议）下、2（建议→最小）下、3（最小→建议）上。
            adj525：移出页签区 ⇒ 常驻（不被溢出的页签顶走）；adj531：常驻在**最左端**。 */}
        <button
          type="button"
          className="tool-dock-size-btn"
          onClick={cycleDockHeight}
          // adj617（用户要求）：档位按钮的提示后面带 Ctrl+H（Esc 最小化也写在这条上）
          title={withKbd(dockCopy.sizeTitle(dockCopy.sizeName[sizeStep.cur], dockCopy.sizeName[sizeStep.next]), `${KBD.dockSize}／${KBD.dockMin}`)}
          aria-label={withKbd(
            dockCopy.sizeTitle(dockCopy.sizeName[sizeStep.cur], dockCopy.sizeName[sizeStep.next]),
            `${KBD.dockSize}／${KBD.dockMin}`,
          )}
          data-size={sizeStep.cur}
          data-current={heightPresetActive}
        >
          <ToolIcon name={sizeStep.icon} size={14} />
        </button>
        {/* adj556（用户要求"页签始终显示图标"）：图标不再窄屏隐藏，靠这条可滚页签区
            + 滚轮转横向 + 左右翻页箭头兜住视界外的页签。三个固定按钮（档位 / ✕）放在
            tabstrip 之外 ⇒ 永远不被页签溢出顶走（adj557：用户要求"左右两侧不随页签滚动"）。
            adj567：**一旦溢出，两个箭头就始终占位、只切 `visibility`**——见 `tabOverflow.overflowing`
            的说明（箭头一增一减会改变 tabstrip 可用宽，把"刚对齐好的页签"又挤出去）。 */}
        {tabOverflow.overflowing && (
          <button
            type="button"
            className="tool-dock-tab-arrow"
            // 占位但不可见/不可点（`visibility` 保留布局，`disabled` + `tabIndex=-1` 保持可访问性正确）
            style={{ visibility: tabOverflow.left ? 'visible' : 'hidden' }}
            disabled={!tabOverflow.left}
            tabIndex={tabOverflow.left ? 0 : -1}
            aria-hidden={!tabOverflow.left}
            title={dockCopy.tabsLeftTitle}
            aria-label={dockCopy.tabsLeftTitle}
            onClick={() => pageTabsBy(-1)}
          >
            {/* adj564（用户要求）：滚动指示改用设计图标 `public/icons/左.png`（原来用 `‹` 字符） */}
            <ToolIcon name="left" size={14} />
          </button>
        )}
        <div className="tool-dock-tabstrip" role="tablist" ref={tabstripRef}>
          {visibleTabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={dockPanel === t.key}
              className={`tool-dock-tab${dockPanel === t.key ? ' is-active' : ''}`}
              // adj567：`data-key` 供"把当前面板的页签滚进视界"按 key 找 DOM
              data-key={t.key}
              onClick={() => {
                setDockPanel(t.key)
                // adj611（用户要求）：最小档下点页签 = "我要看这个面板" ⇒ 回到建议高度
                //（否则内容区是 0 高，点了只有高亮变化、像"没反应"）
                if (minimized) exitMinimized()
                // adj567：点**已激活**的那个页签时 `dockPanel` 不变 ⇒ 上面那个 effect 不会跑，
                // 于是"我把页签栏手动滚开、再点回当前页签"就永远回不来 ⇒ 这里也补一次对齐。
                alignActiveTab()
              }}
              // adj617（用户要求）：提示文本后面带上快捷键（有快捷键的页签才有）
              title={t.kbd ? withKbd(t.label, t.kbd) : t.label}
            >
              <span className="tool-dock-tab-icon" aria-hidden="true">
                {/* adj486：设计图标（顶栏同一套）。
                    adj514：**与顶栏按钮图标同尺寸**（`ToolIcon` 默认 size=16，与顶栏一致）——
                    此前 `size={14}` 比顶栏小 2px，视觉"虚"（用户报）。
                    adj556：图标**窄屏也不再隐藏**——与 `.tool-dock-tab-label` 同显。
                    adj565：7 个页签全部有设计图标 ⇒ 删掉字符兜底分支（`icon` 现在是必填）。 */}
                <ToolIcon name={t.icon} />
              </span>
              <span className="tool-dock-tab-label">{t.label}</span>
            </button>
          ))}
        </div>
        {tabOverflow.overflowing && (
          <button
            type="button"
            className="tool-dock-tab-arrow"
            style={{ visibility: tabOverflow.right ? 'visible' : 'hidden' }}
            disabled={!tabOverflow.right}
            tabIndex={tabOverflow.right ? 0 : -1}
            aria-hidden={!tabOverflow.right}
            title={dockCopy.tabsRightTitle}
            aria-label={dockCopy.tabsRightTitle}
            onClick={() => pageTabsBy(1)}
          >
            {/* adj564：同左箭头，改用 `public/icons/右.png` */}
            <ToolIcon name="right" size={14} />
          </button>
        )}
        <button type="button" className="tool-dock-close" onClick={closeDock} title={dockCopy.closeTitle} aria-label={dockCopy.closeTitle}>
          ✕
        </button>
      </div>
      {/* 内容区：只渲染"已激活过"的面板；非当前面板用 hidden 隐藏（保住内部状态） */}
      <div className="tool-dock-body" ref={bodyRef}>
        {PANELS.filter((p) => everActive.includes(p.key)).map((p) => {
          const Pane = p.render
          return (
            <div key={p.key} className={`tool-dock-pane pane-${p.key}`} hidden={dockPanel !== p.key} role="tabpanel">
              {/* 懒加载面板（试听/导出/设置）首次打开时下载 chunk */}
              <Suspense fallback={<div className="dock-empty">加载中…</div>}>
                <Pane />
              </Suspense>
            </div>
          )
        })}
      </div>
    </section>
  )
}
