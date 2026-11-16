/**
 * ui/dock/dockPanels.tsx — 底栏 / 右栏**共用**的页签定义、面板懒加载映射、可见页签判据（adj1293）
 *
 * ## 为什么单独成文件
 *
 * · 两个壳（`ui/ToolDock.tsx` 底栏、`ui/RightDock.tsx` 右栏）必须用**同一份**面板集合与页签顺序，
 *   否则「切壳之后页签位置/面板状态对不上」——用户口径是"右栏内容与底栏完全一样，只换布局"。
 * · 这些是**数据 + 组件映射**，不是 ToolDock 的实现细节。放在组件文件里导出会触发 oxlint 的
 *   `react/only-export-components`（与 `ui/toolIcons.ts` 单独成文件同一原因）。
 *
 * ## 只管"有哪些页签、每个页签渲染什么"
 *
 * **不管**尺寸模型（底栏是高度四相位、右栏是宽度两档）、不管页签条长什么样
 * （底栏那条带「收起 / 高度档位 / ✕」，右栏那条只有页签项 + 溢出箭头）。
 * 那些留在各自的壳里——两个壳的差异**只在布局**，不在内容。
 */
import { lazy } from 'react'
import type { ComponentType } from 'react'
import type { DockPanelKey } from '../../store/uiStore'
import { dockCopy } from '../../brand/copy'
import { KBD } from '../../brand/shortcuts'
import type { ToolIconName } from '../toolIcons'
import { isHostEmbedded } from '../../store/hostBridge'

/**
 * adj497（用户要求"各页签做成懒加载、首次打开才加载，以加快启动"）：面板全部走 `React.lazy`。
 * adj1290：告警面板已移出页签集合（独立成 `ui/ProblemsDrawer.tsx`），这里没有它。
 */
export const TryoutPanel = lazy(() =>
  import('../../dialogs/PlaybackDialog').then((m) => ({ default: () => <m.PlaybackDialog inline /> })),
)
// adj603（用户要求）：原「设置」一个页签拆成两个——「全局」（视图/主题/音色库）与「谱面」（布局/字体）。
// 同一个 PageConfigDialog 渲染**两份**（各带 section），子页签状态因此各自独立。
export const SettingsPanel = lazy(() =>
  import('../../dialogs/PageConfigDialog').then((m) => ({ default: () => <m.PageConfigDialog inline section="global" /> })),
)
export const ScoreSettingsPanel = lazy(() =>
  import('../../dialogs/PageConfigDialog').then((m) => ({ default: () => <m.PageConfigDialog inline section="score" /> })),
)
// adj492：「关于」从弹窗迁入 dock（与原「试听/导出/设置」同一套路）
export const AboutPanel = lazy(() => import('../../dialogs/AboutDialog').then((m) => ({ default: () => <m.AboutDialog inline /> })))
export const ExportPanel = lazy(() => import('./ExportPanel').then((m) => ({ default: m.ExportPanel })))
// adj540：工作区（移动端的"文件管理器"：选文件夹当工作区 + 子目录 + 打开/新建/重命名/移动/删除）
export const WorkspacePanel = lazy(() => import('./WorkspacePanel').then((m) => ({ default: m.WorkspacePanel })))
// adj562：「粘贴源码导入」迁入底栏（页签排在工作区之后）——原弹窗入口下线，与 adj492「关于」同套路
export const ImportPanel = lazy(() =>
  import('../../dialogs/PasteImportDialog').then((m) => ({ default: () => <m.PasteImportDialog inline /> })),
)
// adj641（用户要求）：查找替换（编辑区 Ctrl+F 的落点；查找与替换整合在一个页签里）
export const FindPanel = lazy(() => import('./FindPanel').then((m) => ({ default: m.FindPanel })))

/**
 * 面板（顺序即标签栏顺序）；adj540：工作区**排第一**（手机端文件操作主入口，用户要求）；
 * adj562：导入**紧跟在它后面**（用户要求"就在工作区后面加一个「导入」页签"）；
 * adj641：查找替换**再紧跟导入**（同属"改内容"的动作，且它与导入一样是编辑期的操作面板）；
 * adj603：「谱面」紧跟在「全局」（原「设置」）后面（用户要求拆分后再成对出现）。
 * adj1290：告警移出（独立成抽屉）⇒ 现在 8 个页签。
 */
export const PANELS: readonly { key: DockPanelKey; render: ComponentType }[] = [
  { key: 'workspace', render: WorkspacePanel },
  { key: 'import', render: ImportPanel },
  { key: 'find', render: FindPanel },
  { key: 'tryout', render: TryoutPanel },
  { key: 'export', render: ExportPanel },
  { key: 'settings', render: SettingsPanel },
  { key: 'score', render: ScoreSettingsPanel },
  { key: 'about', render: AboutPanel },
]

/**
 * 底栏 / 右栏的页签定义（图标一律 `ToolIcon` 的设计图标，不用字符兜底——`adj565` 的口径）。
 *
 * adj724b：嵌入版里**不显示"工作区"**页签（用户原话「工作区已没有存在的意义，除了保存，
 * 所有与文件相关的操作都可以由 ob 代劳」）——过滤逻辑在下面的 `dockVisibleTabs()`，
 * 其它形态（网页版 / 桌面版）保持原样。
 */
export const TABS: { key: DockPanelKey; label: string; icon: ToolIconName; kbd?: string }[] = [
  // adj540：工作区排第一（手机端文件操作主入口，用户要求）；图标用 `public/icons/工作区.png`
  // adj617（用户要求）：页签的提示文本后面带上快捷键（键名来自 `brand/shortcuts.ts` 一处定义）
  { key: 'workspace', label: dockCopy.tabWorkspace, icon: 'workspace', kbd: KBD.workspace },
  // adj562：导入紧跟工作区（用户要求）；adj564：图标用设计图 `public/icons/导入.png`
  { key: 'import', label: dockCopy.tabImport, icon: 'import', kbd: KBD.import },
  // adj641（用户要求）：查找替换紧跟导入（同属"改内容"的动作）；图标是本次新画的放大镜（`public/icons/查找.png`）
  { key: 'find', label: dockCopy.tabFind, icon: 'find', kbd: KBD.find },
  { key: 'tryout', label: dockCopy.tabTryout, icon: 'play', kbd: KBD.tryout },
  { key: 'export', label: dockCopy.tabExport, icon: 'export', kbd: KBD.export },
  // adj603：原「设置」页签改名为「全局」（本机偏好），紧跟其后新增「谱面」（谱面设置）
  { key: 'settings', label: dockCopy.tabSettings, icon: 'settings' },
  { key: 'score', label: dockCopy.tabScore, icon: 'scoreSettings' },
  // adj565：关于图标由 `ⓘ` 字符换成设计图 `public/icons/关于.png`
  { key: 'about', label: dockCopy.tabAbout, icon: 'about' },
]

/** 本端实际可见的页签（嵌入版过滤掉「工作区」；判据见 `TABS` 的说明） */
export function dockVisibleTabs(): typeof TABS {
  return isHostEmbedded() ? TABS.filter((t) => t.key !== 'workspace') : TABS
}
