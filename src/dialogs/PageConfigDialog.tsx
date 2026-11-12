/**
 * dialogs/PageConfigDialog.tsx — 页面设置（谱面：纸张/边距/布局/间距/连音线 + 字体 + 全局）
 *
 * adj282：各分组改为标签页（tab）形式切换，节省纵向空间、便于放入更多设置。
 * adj315：新增「全局」标签页（应用级 uiStore；不写入谱面 # jps-config）。
 *         页面级设置改为「即刻预览 + 保存持久化 + X 恢复」：调整时临时应用到 store
 *         （setPageConfig(next,false) 预览非持久化），保存才写入 .jps，关闭未保存则恢复快照。
 * adj418：①「页面 / 音符布局 / 间距 / 连音线」四个标签页**合并为「谱面」**一个（分小节标题）；
 *         ②标签页**等分对话框宽度**、面板内容铺满页签宽度（不留右侧空白、不横向溢出）；
 *         ③底部三个按钮**固定在对话框底部**（只有中间的页签内容区滚动），永远不用滚动去找。
 *
 * 标签页顺序：全局 → 主题 → 音色库 → 谱面 → 字体。
 *
 * adj944（用户需求）：「全局」下新增子页签**「命令行」**——把 iJipu 注册进当前用户 PATH，
 * 之后在**新开的终端**里就能直接 `ijipu cli …`（未注册显示「注册」、已注册显示「解除」；
 * 状态**每次现读系统实况**，不记在我们自己的配置里 ✓）。文案在 `brand/copy.ts` 的 `cliPathCopy`。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Modal } from '../ui/Modal'
import { useDocStore } from '../store/docStore'
import { useUiStore } from '../store/uiStore'
import { clampEditorFontSize, EDITOR_FONT_OPTIONS, EDITOR_FONT_SIZE_RANGE, localAssetRefs, nonDefaultConfigKeys, SCORE_FONT_OPTIONS, SEGMENT_ROW_GAP_DEFAULT } from '@ijipu/engine'
// adj629x：恢复默认的草稿**整份替换**（纯函数，见该文件头的踩坑说明）
import { draftAfterReset } from './pageConfigReset'
import { THEMES, type ThemeMode } from '../brand/themes'
import { uiCopy, numCopy, cliPathCopy } from '../brand/copy'
// adj944：桌面版判定（网页版没有读写 PATH 的能力 ⇒ 界面如实禁用并说明）
// adj954：环境判定统一走 brand/env.ts（原 brand/platform.ts 已合并删除）
import { isDesktopShell } from '../brand/env'
// adj944：注册/解除 iJipu CLI（IO 接线在 store/cliPath.ts；**纯逻辑与命令行共用一份** ✓）
import { applyCliPath, readCliPathStatus } from '../store/cliPath'
import { PATH_MAX_CHARS, type CliPathStatus } from '../../packages/ijipu-cli/src/envPath'
import { SoundBankPanel } from './SoundBankPanel'
import type { PageConfig } from '@ijipu/engine'
// adj1089：平移方式的取值域（与 uiStore / 出片同一份）
// adj426：主题按钮用 ToolIcon（与顶栏三状态按钮共用图标：自动主题/浅色主题/深色主题）
import { ToolIcon } from '../ui/ToolIcon'
// adj526：数值"按住上下拖"+`−`/`+` 步进（手机端没有原生上下小按钮，靠这两条路径改数）
import { useNumberScrub, useHoldRepeat } from '../ui/numberScrubGesture'
// adj526：谱面数值字段的 [min,max] 单一来源（逐项引用引擎 GUIDE_LIMITS / GUIDE_LIMITS_EX）
import { PAGE_NUM_RANGES as RANGE, coarseFor } from '../ui/numFieldRanges'
// adj965（方案「OVL」，EP-10）：水印/背景图解析失败要就地提示（订阅资源快照）
import { getOverlaySnapshot, subscribeOverlayAssets } from '../store/overlayAssets'
import { overlayCopy, settingsCopy } from '../brand/copy'
import { LocalDataPanel } from './LocalDataPanel'

type TabId = 'global' | 'theme' | 'soundbank' | 'cli' | 'local' | 'score' | 'font' | 'watermark' | 'background'

/**
 * adj603（用户要求）：设置**拆成两个底栏页签**——
 *   · 「全局」= 版面 / 主题 / 音色库（本机偏好，改完即时生效、**不写谱面**）
 *   · 「谱面」= 布局 / 字体（这份谱长什么样，**随谱保存**进 `# jps-config`）
 * 所以子页签按 `section` 分组，同一个组件渲染两次（两个 dock 页签各一份，子页签状态各自独立）。
 */
export type SettingsSection = 'global' | 'score'

// adj463：页签带图标 —— dock 里页签**竖向排在左侧**，窄屏时只留图标（文字用容器查询隐藏）
// adj603：子页签改名——原「全局」→ **版面**（避免与父页签「全局」同名）、原「谱面」→ **布局**
const ALL_TABS: { id: TabId; label: string; icon: string; section: SettingsSection }[] = [
  { id: 'global', label: '版面', icon: '⚙', section: 'global' },
  // adj383：主题组从顶栏菜单移入设置，紧跟在「版面」之后
  { id: 'theme', label: '主题', icon: '◐', section: 'global' },
  // adj384：音色库从顶栏按钮移入设置，紧跟「主题」之后
  { id: 'soundbank', label: '音色库', icon: '♪', section: 'global' },
  // adj944（用户需求）：**注册 iJipu CLI** —— 把安装目录加进当前用户 PATH，
  // 之后新开的终端里就能直接 `ijipu cli …`。文案走 copy.ts（标签也走，别再硬编码 ✓）。
  { id: 'cli', label: cliPathCopy.tabLabel, icon: '>_', section: 'global' },
  // adj1085（用户要求）：本机配置的落点 / 打开目录 / 导出导入（桌面落个人目录，网页走浏览器存储）
  { id: 'local', label: '本机', icon: '⌂', section: 'global' },
  // adj418：原「页面 / 音符布局 / 间距 / 连音线」四个标签合并为「布局」（都是"这份谱长什么样"）
  { id: 'score', label: '布局', icon: '▤', section: 'score' },
  { id: 'font', label: '字体', icon: 'Aa', section: 'score' },
  // adj965（用户需求，方案 docs/OVERLAY-PLAN.md「OVL」）：水印层与背景层各占一个子页签。
  // 都是"这份谱长什么样" ⇒ L2、随谱走（与「布局/字体」同一半）。
  { id: 'watermark', label: overlayCopy.layerWm, icon: '◈', section: 'score' },
  { id: 'background', label: overlayCopy.layerBg, icon: '▧', section: 'score' },
]

/** adj482：内容是「字段行」的子页签——dock 里套 `.pcfg-fields` 网格，按当页最长标签对齐；
 *  主题（主题色块列表）与音色库（自带面板）不套该层，保持各自布局
 *  adj944：「命令行」也是字段行（状态行 + 两个按钮）⇒ 参与网格 ✓ */
const FIELDS_TABS: TabId[] = ['global', 'cli', 'local', 'score', 'font', 'watermark', 'background']

/** adj482：字段网格的三个常量——标签与控件之间的间隙（与 CSS 的 row `gap` 一致）、
 *  一格至少给控件留的宽度、格与格之间的列间距（与 CSS 的 `column-gap` 一致，用于算跨格数） */
const ROW_GAP = 8
const CTL_MIN_W = 140
const COL_GAP = 18

/**
 * adj955（用户要求）：**非桌面端整条隐藏「命令行」子页签**。
 *
 * 用户原话：「CLI 只对于桌面端有效，因此全局设置下的命令行设置组在非桌面端时连显示都不应该显示，
 * 完全没用呀！」——`cli_path_status` / `cli_path_register` / `cli_path_unregister` 这三条 Rust
 * 命令在网页版里**根本不存在**（要读写 `HKCU\Environment\Path`）。原先的做法是"页签照常出现、
 * 里面的状态写一句「网页版不支持」并把按钮禁用"：用户白点一次，还得读一段解释才知道这页对他没用。
 *
 * 现在：**不可用就不出现**（入口都不给）。
 *
 * ⚠ 必须是**函数**、不能写成模块级常量 —— `__TAURI__` 是宿主注入的全局，判定要在**调用时**求值
 * （同一课教训见 `brand/shortcuts.ts` 的 `newDocKbd`：状态在模块加载那一刻就被钉死是会出错的）。
 */
function visibleTabs(section: SettingsSection): typeof ALL_TABS {
  return ALL_TABS.filter((t) => t.section === section && (t.id !== 'cli' || isDesktopShell()))
}

/**
 * adj605（用户要求）：**谱面级字段的登记表**——「布局」「字体」两个子页签各自有哪些 `PageConfig` 字段。
 * 用途：① 判断当前子页签里有没有"非默认项"，决定底部图例是否出现；② smoke 用它核对
 * "登记表里的每个字段都真的有一行在用它"（`isNonDefault('键')`），防止加了字段忘了登记。
 * 只列 `PageConfig` 字段——「版面/主题/音色库」是本机偏好（uiStore），不参与这套标记。
 */
const TAB_CONFIG_KEYS: Partial<Record<TabId, readonly string[]>> = {
  score: [
    'page',
    'margin_top',
    'margin_bottom',
    'margin_left',
    'margin_right',
    'descAreaH',
    'body_margin_top',
    'height_ciqu',
    'height_quci',
    'height_cici',
    'height_ciqu_lyric',
    'height_shengbu',
    'segmentRowGap',
    'noteSpaceLayout',
    'lianyinxian_type',
    'align_min_bars',
    // adj629z：方框小节序号两项（adj625 加的行）此前漏登记 —— 漏了只是"当页非默认计数"少算这两项
    // （红色 `*` 仍会亮，图例可能因此不出现），补上并由 smoke 反向断言守住。
    'showBarCount',
    'barCountInterval',
  ],
  font: [
    'miaoshu_font',
    'miaoshu_size',
    'biaoti_font',
    'biaoti_size',
    'fubiaoti_font',
    'fubiaoti_size',
    'shuzi_font',
    'note_size',
    'showInstrument',
    'geci_font',
    'geci_size',
    'lyricShrink',
    'notes_font',
    'notes_size',
  ],
  /**
   * adj965（方案 OVL）：水印层与背景层的 15 个字段。
   * ⚠ 登记表必须与源码里的 `isNonDefault('键')` **双向一致**（smoke 两条闸门各管一个方向）：
   *   这里列了却没行在用 ⇒ 判红；行在用却没登记 ⇒ 也判红。
   */
  watermark: [
    'wmEnabled',
    'wmType',
    'wmText',
    'wmImage',
    'wmSize',
    'wmScale',
    'wmRotate',
    'wmRepeat',
    'wmRepeatGap',
    'wmOpacity',
    'wmOffsetX',
    'wmOffsetY',
  ],
  background: ['bgEnabled', 'bgImage', 'bgScale', 'bgRotate', 'bgOpacity', 'bgOffsetX', 'bgOffsetY'],
}

export function PageConfigDialog({
  inline = false,
  section = 'global',
}: { inline?: boolean; section?: SettingsSection } = {}) {
  /** 本实例负责的子页签（按 section 过滤；两个 dock 页签各渲染一份，互不干扰）。
   *  adj955：再按"这台机器上真的能用吗"过滤 —— 非桌面端不出现「命令行」页签。 */
  const TABS = visibleTabs(section)
  const pageConfig = useDocStore((s) => s.pageConfig)
  const setPageConfig = useDocStore((s) => s.setPageConfig)
  // adj462：设置面板已移入底部 dock——保存/固化后收起 dock（原为关闭弹窗）
  const closeDock = useUiStore((s) => s.closeDock)
  // adj315：全局标签页是应用级偏好（uiStore，全局生效），不写入谱面 pageConfig
  const splitHDir = useUiStore((s) => s.splitHDir)
  const setSplitHDir = useUiStore((s) => s.setSplitHDir)
  const showScriptPad = useUiStore((s) => s.showScriptPad)
  const setShowScriptPad = useUiStore((s) => s.setShowScriptPad)
  const autoWrap = useUiStore((s) => s.autoWrap)
  const setAutoWrap = useUiStore((s) => s.setAutoWrap)
  const showGuides = useUiStore((s) => s.showGuides)
  const setShowGuides = useUiStore((s) => s.setShowGuides)
  // adj905q：预览可视调试开关（L3 会话级，不落盘）
  const debugBounds = useUiStore((s) => s.debugBounds)
  const setDebugBounds = useUiStore((s) => s.setDebugBounds)
  const editorFontSize = useUiStore((s) => s.editorFontSize)
  const setEditorFontSize = useUiStore((s) => s.setEditorFontSize)
  const editorFont = useUiStore((s) => s.editorFont)
  const setEditorFont = useUiStore((s) => s.setEditorFont)
  // adj383：主题（中国色主题 + 深浅模式）——从顶栏菜单移入设置「主题」标签（本机界面偏好，不随谱保存）
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const themeMode = useUiStore((s) => s.themeMode)
  const setThemeMode = useUiStore((s) => s.setThemeMode)
  // adj1000：深色预览柔化档位（L1 本机偏好，默认「轻」）
  const previewSoften = useUiStore((s) => s.previewSoften)
  const setPreviewSoften = useUiStore((s) => s.setPreviewSoften)
  // adj-font：字体覆盖（L1 用户个性；跨机缺字体时用我的字体，不改谱面文件）
  const fontOverride = useUiStore((s) => s.fontOverride)
  const setFontOverride = useUiStore((s) => s.setFontOverride)
  // adj1089：动态视频/试听的行中平移方式（L1 本机偏好，默认跟随）


  const [draft, setDraft] = useState<PageConfig>({ ...pageConfig })
  // adj603：默认子页签取本 section 的第一个（全局 → 版面、谱面 → 布局）
  // adj955：走 `visibleTabs`（非桌面端没有「命令行」，不能把它当默认值选出来）
  const [tab, setTab] = useState<TabId>(() => visibleTabs(section)[0]?.id ?? 'global')
  /**
   * adj728（用户要求）：**"跳到某个页签"的一次性意图**（`uiStore.openSettings(tab)`）。
   *
   * 起因：「无法下载音色库」那条提示需要一个按钮，点了直接落到「设置 → 音色库」。
   * ⚠ 本面板是**常驻挂载**在底栏 dock 里的（不是每次打开都重新挂载）⇒ 不能在 `useState`
   * 初值里读它（只有首次挂载会跑），必须在它变化时**响应**一次；
   * 而且**只有负责该页签的这份实例**才消费它（另一个 section 的实例读了会把它清掉，
   * 面板顺序在前的那个先跑，就会把意图吃掉 ⇒ 另一个实例永远等不到）。
   */
  const settingsTabRequest = useUiStore((s) => s.settingsTab)
  const consumeSettingsTab = useUiStore((s) => s.consumeSettingsTab)
  useEffect(() => {
    if (!settingsTabRequest) return
    // adj955：守卫也走 `visibleTabs` —— 非桌面端没有「命令行」，不能把意图落在一个不存在的页签上
    if (!visibleTabs(section).some((t) => t.id === settingsTabRequest && t.section === section)) return
    setTab(settingsTabRequest)
    consumeSettingsTab()
  }, [settingsTabRequest, section, consumeSettingsTab])

  /**
   * adj944：**注册 iJipu CLI** 的状态与动作。
   *
   * 关键口径（用户要求）：
   *  · 状态**读系统实况**（`cli_path_status` 现读 `HKCU\Environment\Path`）——
   *    **不记在我们自己的配置里** ✗，用户手动改过 PATH 也如实反映 ✓；
   *  · 切到本页签时（以及点「重新读取」时）重新读一次：用户完全可能刚在
   *    「环境变量」对话框里手改过 ✓；
   *  · 操作期间禁用按钮 + 给忙碌文案；失败把**原因原文**显示出来（不写"失败了" ✗）。
   */
  const cliDesktop = isDesktopShell()
  const [cliStatus, setCliStatus] = useState<CliPathStatus | null>(null)
  const [cliBusy, setCliBusy] = useState(false)
  const [cliNote, setCliNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /**
   * adj969（**用户实报**）：网页 / PWA 用**文件方式**打开的谱，浏览器不给文件句柄的父目录
   * ⇒ 相对路径的背景图 / 水印图读不到。这里就地给一个「授权所在文件夹」按钮
   * （点了会弹 `showDirectoryPicker`，必须由用户手势触发 ⇒ 只能放在按钮里，不能在后台自动弹）。
   */
  const assetFile = useDocStore((s) => s.fileHandle)
  /** adj979：桌面壳才有真实路径 —— 用它判"谱是不是在桌面/文档/下载里"（那三个目录浏览器不让授权） */
  const assetNativePath = useDocStore((s) => s.nativePath)
  const [authBusy, setAuthBusy] = useState(false)
  const authAssetDir = (): void => {
    setAuthBusy(true)
    void (async () => {
      try {
        const { requestAssetDirNow, refOfHandle } = await import('../store/assetDirAuth')
        // "需不需要目录"的判据与 `App.tsx` 用同一份（引擎的 `localAssetRefs`），
        // 判的是**面板正在显示的值** `draft`（用户刚把路径填进去、还没保存设置也应能授权）
        await requestAssetDirNow(localAssetRefs(draft).length > 0, await refOfHandle(assetFile), assetNativePath)
      } finally {
        setAuthBusy(false)
      }
    })()
  }

  const refreshCliStatus = async () => {
    const r = await readCliPathStatus()
    if (r.ok) {
      setCliStatus(r.status)
      return
    }
    // 网页版：如实说"不支持"（不冒充"未注册" ✗）；桌面版读失败：把原因显示出来
    setCliStatus(null)
    if (r.reason !== 'web') setCliNote({ kind: 'err', text: cliPathCopy.failed(r.reason) })
  }
  useEffect(() => {
    if (tab !== 'cli' || !cliDesktop) return
    void refreshCliStatus()
    // 只在"切到本页签"时读一次；`cliStatus` 不进依赖（否则写完会立刻被旧值盖回去）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, cliDesktop])

  /** 点「注册」或「解除」：动作名按**当前实况**决定（已注册 ⇒ 解除） */
  const onCliPathAction = async () => {
    if (cliBusy) return
    const mode = cliStatus?.registered === true ? 'unregister' : 'register'
    setCliBusy(true)
    setCliNote(null)
    try {
      const r = await applyCliPath(mode)
      if (!r.ok) {
        setCliNote({
          kind: 'err',
          text:
            r.error.kind === 'too-long'
              ? cliPathCopy.tooLong(r.error.length, r.error.limit)
              : cliPathCopy.failed(r.error.detail),
        })
        return
      }
      setCliStatus(r.status)
      setCliNote({
        kind: 'ok',
        text:
          mode === 'register'
            ? // adj946：这两句给的是**命令行入口目录**（真正写进 PATH 的那一条），不是安装目录 ✓
              cliPathCopy.okRegistered(r.status.binDir, r.changed)
            : cliPathCopy.okUnregistered(r.status.binDir, r.changed),
      })
    } finally {
      setCliBusy(false)
    }
  }
  /**
   * adj957（用户裁定）：原先这里还有一段「查看 CLI 手册」——用**系统默认程序**打开随包放在
   * 安装目录里的 `docs/iJipu-CLI-手册.md`。已删除，理由两条：
   *  ① Windows **默认没有 `.md` 关联程序**，这个按钮在多数机器上会弹「你要如何打开此文件」；
   *  ② 命令行手册现在与操作手册/语法说明一样，走**应用内 `DocDialog`**（顶栏「帮助 → 命令行手册」）
   *     —— 应用内渲染，不依赖外部关联，也不必有随包 MD。
   * 相关文案（`cliPathCopy.manual*`）与 Rust 命令（`cli_manual_open`）一并撤掉。
   */

  // adj315：页面设置"即刻预览 + 保存持久化 + X 恢复"——
  // 打开时快照原值，调整时临时应用（预览非持久化），保存才写 .jps；关闭未保存则恢复快照。
  const snapRef = useRef<PageConfig>({ ...pageConfig })
  const committedRef = useRef(false)
  /**
   * adj600（用户反馈）：本面板**常驻挂载**在底栏 dock 里，`draft`/`snapRef` 原先只在挂载那一刻取种子
   * ⇒ **打开另一份谱（或手改源码里的 `# jps-config`）后，面板还停在上一份谱/默认值上**：
   *   · 面板显示的不是这份谱的设置（用户："谱面的设置没有更新覆盖设置里的默认值"）；
   *   · 用户一动任何字段，`setPageConfig({...draft, ...patch}, false)` 就把那套**错值**当主体应用，
   *     预览立刻被打回默认观感；保存时基线（`snapRef`）也是错的 ⇒ 谱面设置被打乱。
   *
   * 判据：`pageConfig` 变了、而且**不是本面板自己刚写进去的那一份**（`lastAppliedRef`）⇒ 说明
   * 变化来自外部（打开文件 / 源码改设置 / 预览里拖辅助虚线并已固化）⇒ 重新取种子。
   * 用引用比较 + JSON 兜底：本面板自己写的值就是同一个对象，不会被误判成"外部变化"而清掉用户正在改的内容。
   */
  const lastAppliedRef = useRef<PageConfig>({ ...pageConfig })
  useEffect(() => {
    const same =
      pageConfig === lastAppliedRef.current || JSON.stringify(pageConfig) === JSON.stringify(lastAppliedRef.current)
    if (same) return
    setDraft({ ...pageConfig })
    snapRef.current = { ...pageConfig }
    lastAppliedRef.current = { ...pageConfig }
    committedRef.current = false
  }, [pageConfig])
  // adj482：字段区容器（dock 里按「当页最长标签」对齐，见下面的测量 effect）
  const fieldsRef = useRef<HTMLDivElement | null>(null)

  /**
   * adj605（用户要求）：**"这一项与代码默认值不同"**的红色 `*` 标记。
   *
   * 判据来自引擎 `nonDefaultConfigKeys`——与 `writeJpsConfig` 的**差量写出**是同一份口径，
   * 于是"标签后带 `*`"严格等价于"点「保存设置」后会写进这份谱的 `# jps-config`"，
   * 不会出现"标了却没写"或"写了却没标"。
   *
   * 比较的是**面板正在显示的值**（`draft`）而不是"存盘那一刻的源码"：
   *   ① 打开一份谱时，亮着的正是这份谱自己写过的项；
   *   ② 用户改一项 → `*` 立刻出现（保存后它就会进谱面），等于改动预览；
   *   ③ 改回默认值 → `*` 消失（"回到默认"这件事一眼可见）。
   */
  const nonDefaultKeys = useMemo(() => new Set(nonDefaultConfigKeys(draft)), [draft])
  const isNonDefault = (key: string) => nonDefaultKeys.has(key)
  /**
   * adj965（方案「OVL」优化 7）：水印/背景图的**解析失败**要就地告诉用户（"图不在/太大/类型不对"），
   * 而不是静默少画一层让人以为"设置了没用"。按前缀分给各自的页签。
   */
  const overlaySnap = useSyncExternalStore(subscribeOverlayAssets, getOverlaySnapshot)
  const overlayErrors = (prefix: string): string[] => overlaySnap.errors.filter((e) => e.startsWith(prefix))
  /**
   * adj969：缺"资源目录"授权时的**处置按钮**（两个页签都用同一份）。
   *
   * 为什么值得单独给按钮：那条错误（"浏览器不提供文件所在目录…"）用户看懂了也**做不了什么**，
   * 必须有一个点了就弹选择器的入口；否则等于把用户堵在一句提示上。
   */
  const assetDirAuthNote = overlaySnap.needsDirAuth ? (
    <div className="pcfg-note pcfg-asset-err">
      <button className="btn" disabled={authBusy} onClick={authAssetDir}>
        {overlayCopy.authDirButton}
      </button>
    </div>
  ) : null
  /** 当前子页签里"非默认"的项数——>0 才在面板末尾给出图例（没标记时不占地方） */
  const tabNonDefaultCount = (TAB_CONFIG_KEYS[tab] ?? []).filter((k) => nonDefaultKeys.has(k)).length

  /**
   * adj482：测量「当页最长标签宽」与**每个字段的自然宽**，据此在 dock 里排出**等宽字段网格**：
   *   · `--pcfg-label-w` = 当页最长标签 ⇒ 每格的标签列一样宽、控件左缘对齐；
   *   · `--pcfg-field-w` = 一格的基本宽（= 标签列 + 控件区最小宽 `CTL_MIN_W`）⇒ 各格等宽、跨格成列；
   *   · 每行 `--pcfg-span` = 该字段自然宽需要跨几格 ⇒ 宽字段（如「边距」四个数值框、带长说明的勾选项）
   *     跨 2 格，既**不折行**、也不把整页格子撑宽（配合 `grid-auto-flow` 的默认行优先放置）。
   *
   * 手法：把字段区**离屏克隆**一份探针（`.pcfg-measure-probe`：每行 `width: max-content` + 不换行），
   * 读自然宽后立即丢弃——不碰真实 DOM、不依赖"测量态"覆盖规则，也不会闪。
   * （先试过"给真实面板临时加 class 摊开字段"：控件容器是 `flex: 1`，`max-content` 会算成几千 px 的假值；
   *   也试过直接读容器宽度：说明文字那类长块会把容器撑大 → 都不可靠。）
   */
  const measureFields = () => {
    const el = fieldsRef.current
    if (!el || !el.closest('.tool-dock')) return
    const liveRows = Array.from(el.querySelectorAll<HTMLElement>('.pcfg-row'))
    const probe = el.cloneNode(true) as HTMLElement
    probe.className = 'pcfg-measure-probe'
    probe.removeAttribute('style') // 丢掉上一轮写进去的 CSS 变量，避免影响本轮测量
    el.parentElement?.appendChild(probe)
    const probeRows = Array.from(probe.querySelectorAll<HTMLElement>('.pcfg-row'))
    let labelW = 0
    for (const row of probeRows) {
      labelW = Math.max(labelW, Math.ceil(row.querySelector<HTMLElement>('.pcfg-row-label')?.offsetWidth ?? 0))
    }
    const rowWs = probeRows.map((r) => Math.ceil(r.offsetWidth))
    probe.remove()
    if (labelW === 0 || rowWs.length === 0) return
    const cellW = labelW + ROW_GAP + CTL_MIN_W
    /**
     * adj483：跨格数必须**钳到当前实际列数**——`grid-column: span N` 在"显式列数 < N"时会**新建隐式列**
     * （`grid-auto-columns: auto`），于是标题的 `grid-column: 1 / -1` 只跨显式列、其余元素被塞进隐式列
     * ⇒ 窄 dock（单列）下"标题与字段挤在同一行"（用户报）。列数按容器宽推出来，故宽度变化要重测。
     */
    const cols = Math.max(1, Math.floor((el.clientWidth + COL_GAP) / (cellW + COL_GAP)))
    el.style.setProperty('--pcfg-label-w', `${labelW}px`)
    el.style.setProperty('--pcfg-field-w', `${cellW}px`)
    liveRows.forEach((row, i) => {
      const need = rowWs[i] ?? 0
      const span = Math.min(cols, Math.max(1, Math.ceil((need + COL_GAP) / (cellW + COL_GAP))))
      row.style.setProperty('--pcfg-span', String(span))
    })
  }

  useLayoutEffect(measureFields, [tab])
  useEffect(() => {
    const el = fieldsRef.current
    if (!el || !el.closest('.tool-dock')) return
    // 字段增删（条件行：如「字体覆盖」开启后的"覆盖为"）或控件文本变化（选项变长变短）→ 重算；
    // rAF 合并连续变化（测量用离屏探针，不会反过来触发本观察者）
    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => measureFields())
    }
    const mo = new MutationObserver(schedule)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    // adj483：容器宽度变化（dock 拖宽/窗口 resize）→ 列数变了，跨格数要跟着重算
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
      ro.disconnect()
    }
  }, [tab])

  const updateDraft = (patch: Partial<PageConfig>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    // adj600：记下"这份值是本面板写进 store 的" ⇒ 上面的重新取种子 effect 不会把用户正在改的内容清掉
    lastAppliedRef.current = next
    setPageConfig(next, false) // 预览（临时应用，不持久化）；保存才持久化
  }

  /**
   * adj629x：**恢复默认 = 整份替换草稿**（不能走 `updateDraft` 的浅合并）。
   * `defaultConfigForReset()` 是"默认值 + 移除可选字段"——浅合并进旧草稿时，旧草稿里的
   * `metaPos`/`heights`/`segmentRowGap`… 会原样留下，保存时又写回 `# jps-config`
   * （用户复报："点击恢复默认时，还是没有清空"）。语义见 `dialogs/pageConfigReset.ts`。
   */
  const resetDraft = () => {
    const next = draftAfterReset(draft)
    setDraft(next)
    lastAppliedRef.current = next
    // 预览态应用默认值（不落盘）；`snapRef` 保持"打开时快照"不动 —— 它是保存时的差量基线
    setPageConfig(next, false)
  }

  // adj315：取消（X/遮罩/Esc）未保存 → 恢复快照到 store（预览层），丢弃 draft
  const onCancelReset = () => {
    if (!committedRef.current) {
      lastAppliedRef.current = snapRef.current
      setPageConfig(snapRef.current, false)
    }
  }

  /** 当前标签页面板内容（各组原字段，去掉 fieldset 边框——标签已表达分组边界） */
  const renderPanel = () => {
    switch (tab) {
      case 'global':
        // adj315：应用级全局设置（uiStore，全局生效；不写入谱面 # jps-config）
        return (
          <>
            <Row label="左右排列">
              <select
                value={splitHDir}
                onChange={(e) => setSplitHDir(e.target.value as 'previewLeft' | 'editorLeft')}
              >
                <option value="previewLeft">左预览 / 右编辑</option>
                <option value="editorLeft">左编辑 / 右预览</option>
              </select>
            </Row>
            <Row label="输入条">
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={showScriptPad} onChange={(e) => setShowScriptPad(e.target.checked)} />
                <span style={{ fontSize: 12 }}>显示简谱输入工具条（移动端默认开）</span>
              </label>
            </Row>
            <Row label="折行">
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={autoWrap} onChange={(e) => setAutoWrap(e.target.checked)} />
                <span style={{ fontSize: 12 }}>编辑器自动折行（长行软折行）</span>
              </label>
            </Row>
            <Row label="排版">
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />
                <span style={{ fontSize: 12 }}>预览排版辅助虚线</span>
              </label>
            </Row>
            {/**
              * adj905q（用户规格见 `docs/PREVIEW-DEBUG-BOUNDARIES.md`）：**预览可视调试** ——
              * 在预览里叠加「时值格 / 墨迹 / 段层」三套边界虚线，用来判断"实际画在哪"。
              *
              * ⚠ 它是 **L3 会话级**：默认关、**只在一个运行期里有效**、**下次运行恢复默认关**
              * （`uiStore.debugBounds` 刻意不落盘，见那里的注释）——故此处**不显示"记住"字样**。
              */}
            <Row label="调试">
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={debugBounds} onChange={(e) => setDebugBounds(e.target.checked)} />
                <span style={{ fontSize: 12 }}>预览可视调试：边界虚线（时值格 / 墨迹 / 段层）</span>
              </label>
            </Row>
            <Row label="编辑器字号">
              {/* adj526：范围取引擎的 EDITOR_FONT_SIZE_RANGE（与 clampEditorFontSize 同源），
                  这样"按住拖 / 步进钮"知道边界，不会拖出可输入范围 */}
              <NumInput
                label=""
                range={EDITOR_FONT_SIZE_RANGE}
                value={editorFontSize}
                onChange={(v) => setEditorFontSize(clampEditorFontSize(Number.isFinite(v) ? v : 14))}
              />
            </Row>
            <Row label="编辑器字体">
              <select value={editorFont} onChange={(e) => setEditorFont(e.target.value)}>
                {EDITOR_FONT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Row>
            {/* adj-font：L1 用户个性——跨机缺字体时的兜底：用我的字体覆盖谱面六项字体（默认关，不改写谱面） */}
            <Row label="字体覆盖">
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="checkbox"
                  checked={fontOverride.enabled}
                  onChange={(e) => setFontOverride({ ...fontOverride, enabled: e.target.checked })}
                />
                <span style={{ fontSize: 12 }}>用我的字体覆盖谱面字体（跨机缺字体时勾选）</span>
              </label>
            </Row>
            {fontOverride.enabled && (
              <Row label="覆盖为">
                <FontSelect value={fontOverride.font} onChange={(v) => setFontOverride({ ...fontOverride, font: v })} />
              </Row>
            )}
            <div className="pcfg-note">
              {settingsCopy.hostPrefNote}
              {fontOverride.enabled && `　${settingsCopy.fontOverrideOn}`}
            </div>
          </>
        )
      case 'theme':
        // adj383：主题组（原顶栏菜单「主题」）——深浅模式 + 中国色主题；本机界面偏好，即时生效、不随谱保存
        return (
          <>
            {/* adj581（用户要求）：底栏内容标题统一成"行标题"样式（与设置→谱面里「纸张与边距」一致） */}
            <div className="pcfg-group-title">深浅模式</div>
            <div className="theme-mode-row" style={{ padding: 0 }}>
              {/* adj426：设置面板三个按钮改用 ToolIcon（自动主题/浅色主题/深色主题），
                  与顶栏新加的深浅模式三状态按钮视觉一致；点击直接选中该档（不走循环） */}
              {(
                [
                  { key: 'auto' as ThemeMode, label: '跟随系统', icon: 'themeAuto' as const },
                  { key: 'light' as ThemeMode, label: '浅色', icon: 'themeLight' as const },
                  { key: 'dark' as ThemeMode, label: '深色', icon: 'themeDark' as const },
                ]
              ).map((m) => (
                <button
                  key={m.key}
                  className={`theme-mode-btn${themeMode === m.key ? ' active' : ''}`}
                  onClick={() => setThemeMode(m.key)}
                  title={m.label}
                  aria-label={m.label}
                >
                  {/* adj484：图标用 14（对话框按钮口径，见 ToolIcon 注释）——与 12px 文本同高更像一对；
                      垂直居中与两侧留白由 CSS 的 `.theme-mode-btn`（inline-flex + padding）保证 */}
                  <ToolIcon name={m.icon} size={14} />
                  <span>{m.label}</span>
                </button>
              ))}
            </div>
            <div className="ijipu-form-hint">
              {themeMode === 'auto'
                ? '自动跟随系统深浅色设置'
                : themeMode === 'light'
                  ? '固定使用浅色配色'
                  : '固定使用深色配色'}
            </div>

            {/*
              adj1000（**用户 2026-10-19 要求**）：深色主题下预览区"黑底白字"对比过强，
              给一个**柔化档位**（关 / 轻 / 中）。默认「轻」。
              实现见 `styles/theme.css`：深色本来就是 `filter: invert(1)` 造"暗纸"，
              这里只是在那条滤镜后面追加 `contrast/brightness/saturate`，按档位取值。
            */}
            <div className="pcfg-group-title">深色预览柔化</div>
            <div className="theme-mode-row" style={{ padding: 0 }}>
              {(
                [
                  { key: 'off' as const, label: uiCopy.previewSoftenOff },
                  { key: 'light' as const, label: uiCopy.previewSoftenLight },
                  { key: 'mid' as const, label: uiCopy.previewSoftenMid },
                ]
              ).map((m) => (
                <button
                  key={m.key}
                  className={`theme-mode-btn${previewSoften === m.key ? ' active' : ''}`}
                  onClick={() => setPreviewSoften(m.key)}
                  title={m.label}
                  aria-label={m.label}
                >
                  <span>{m.label}</span>
                </button>
              ))}
            </div>
            <div className="ijipu-form-hint">{uiCopy.previewSoftenHint}</div>

            {/* adj581（用户要求）：同上——统一成行标题样式 */}
            <div className="pcfg-group-title">主题配色</div>
            {/* adj509：取消原来的「竖向列表 + 单选」布局，改为**流式复选框**——
                 · 与全局页签里的复选框（输入条/折行/排版等）保持一致的手感；
                 · 流式 = flex-wrap 自动换行，窄 dock 下也不会把整页撑高；
                 · 但主题在 store 仍是**单选**（`setTheme(id)`），所以行为不变。 */}
            <div className="theme-list">
              {THEMES.map((t) => (
                <label key={t.id} className="theme-entry" title={t.desc}>
                  <input
                    type="radio"
                    name="ijipu-theme"
                    checked={theme === t.id}
                    onChange={() => setTheme(t.id)}
                  />
                  <span
                    className="theme-swatch"
                    style={{
                      background: themeMode === 'light' ? t.bgLight : t.bg,
                      borderColor: themeMode === 'light' ? t.accentLight : t.accent,
                    }}
                  />
                  <span className="theme-name">{t.name}</span>
                  <span className="theme-desc" style={{ color: themeMode === 'light' ? t.accentLight : t.accent }}>
                    {t.desc}
                  </span>
                </label>
              ))}
            </div>
            <div className="ijipu-form-hint" style={{ marginTop: 8 }}>
              主题属本机界面偏好，不随谱保存。
            </div>
          </>
        )
      case 'soundbank':
        // adj384：音色库管理（原顶栏「音色库」按钮 + 独立对话框）——本机偏好，不随谱保存
        return (
          <>
            <SoundBankPanel />
            <div className="ijipu-form-hint">
              音源库/试听音色属本机偏好（L1），不随谱保存；试听对话框只列这里勾选的音色。
            </div>
          </>
        )
      case 'local':
        // adj1085：本机配置（桌面个人目录 / 网页浏览器存储；导出导入 zip）
        // adj1089：上面再挂一组"本机偏好"——动态视频/试听的平移方式（L1，随「导出设置」一起备份）
        return (
          <>
            <LocalDataPanel />
          </>
        )
      case 'cli':
        // adj944（用户需求）：**注册 iJipu CLI** —— 未注册显示「注册」、已注册显示「解除」。
        // 状态从 `cliStatus` 来（`cli_path_status` **现读系统实况**，不读我们自己的配置 ✓）；
        // 文案全部走 `cliPathCopy`（组件里不写字面量 ✓）。
        return (
          <>
            <div className="pcfg-group-title">{cliPathCopy.groupTitle}</div>
            <div className="pcfg-note">{cliPathCopy.intro}</div>
            <Row label={cliPathCopy.statusLabel}>
              <span className="cli-path-state">
                {!cliDesktop
                  ? cliPathCopy.statusWebOnly
                  : cliStatus === null
                    ? cliPathCopy.statusLoading
                    : cliStatus.registered
                      ? cliPathCopy.statusRegistered
                      : cliPathCopy.statusNotRegistered}
              </span>
              <button
                className={`btn${cliStatus?.registered === true ? '' : ' primary'}`}
                // 网页版没有这个能力 / 首次状态还没读回来 / 正在操作 ⇒ 禁用（并给忙碌文案 ✓）
                disabled={!cliDesktop || cliBusy || cliStatus === null}
                onClick={() => void onCliPathAction()}
              >
                {cliBusy
                  ? cliStatus?.registered === true
                    ? cliPathCopy.busyUnregister
                    : cliPathCopy.busyRegister
                  : cliStatus?.registered === true
                    ? cliPathCopy.unregisterButton
                    : cliPathCopy.registerButton}
              </button>
              <button className="btn" disabled={!cliDesktop || cliBusy} onClick={() => void refreshCliStatus()}>
                {cliPathCopy.refresh}
              </button>
            </Row>
            {cliDesktop && cliStatus !== null && (
              // 状态明细（adj946：**注册的是命令行入口目录 `<安装目录>\bin`**，不是安装目录本身）：
              // 安装目录 / 命令行入口目录 / PATH 用量（离 2047 上限还有多少）/ App Paths（可选便利）
              <div className="pcfg-note">
                {cliPathCopy.installDirLabel}：{cliStatus.installDir}
                <br />
                {cliPathCopy.binDirLabel}：{cliStatus.binDir}
                <br />
                {cliPathCopy.pathUsage(cliStatus.pathLength, PATH_MAX_CHARS)}
                <br />
                {cliPathCopy.appPathsLabel}：{cliStatus.appPaths ?? cliPathCopy.appPathsNone}
              </div>
            )}
            {/* adj946：PATH 里还留着旧形态（安装目录本身）⇒ 必须说出来（它会跟垫片抢 ijipu）；
                文案走 `cliPathCopy`（组件里不写字面量 ✓） */}
            {cliDesktop && cliStatus?.legacy === true && (
              <div className="pcfg-note cli-path-note err">{cliPathCopy.legacyHint}</div>
            )}
            <div className="pcfg-note">
              ⚠ {cliPathCopy.hintNewTerminal}
              <br />
              {cliPathCopy.hintCurrentUser}
            </div>
            {/* adj957：原先这里还有一个「查看 CLI 手册」按钮（用系统默认程序打开随包 MD）。
                已删除 —— 命令行手册改走应用内 `DocDialog`（顶栏「帮助 → 命令行手册」），
                既不依赖 Windows 的 `.md` 关联程序，也不必再有随包 MD。 */}
            {cliNote && (
              <div className={`pcfg-note cli-path-note ${cliNote.kind}`} role="status">
                {cliNote.text}
              </div>
            )}
          </>
        )
      case 'score':
        // adj418：合并原「页面 / 音符布局 / 间距 / 连音线」四个标签——都是"这份谱长什么样"，
        // 分组用小节标题体现；间距类设置两列排布（省纵向空间，且铺满页签宽度）。
        return (
          <>
            <div className="pcfg-group-title">纸张与边距</div>
            <Row label="纸张" mark={isNonDefault('page')}>
              <select
                value={draft.page}
                onChange={(e) => updateDraft({ page: e.target.value as PageConfig['page'] })}
              >
                <option value="A4">A4</option>
                <option value="A5">A5</option>
                <option value="A4_horizontal">横版 A4</option>
                <option value="A5_horizontal">横版 A5</option>
              </select>
            </Row>
            <Row
              label="边距(px)"
              mark={
                isNonDefault('margin_top') ||
                isNonDefault('margin_bottom') ||
                isNonDefault('margin_left') ||
                isNonDefault('margin_right')
              }
            >
              <NumInput label="上" range={RANGE.margin_top} value={draft.margin_top} onChange={(v) => updateDraft({ margin_top: v })} />
              <NumInput label="下" range={RANGE.margin_bottom} value={draft.margin_bottom} onChange={(v) => updateDraft({ margin_bottom: v })} />
              <NumInput label="左" range={RANGE.margin_left} value={draft.margin_left} onChange={(v) => updateDraft({ margin_left: v })} />
              <NumInput label="右" range={RANGE.margin_right} value={draft.margin_right} onChange={(v) => updateDraft({ margin_right: v })} />
            </Row>

            <div className="pcfg-group-title">间距(px)</div>
            {/* adj105：间距项两列排列，节省纵向空间；adj418：铺满页签宽度（不再右侧留白） */}
            <div className="pcfg-grid2">
              <Row label="描述头高" mark={isNonDefault('descAreaH')}>
                <NumInput label="" range={RANGE.descAreaH} value={draft.descAreaH} onChange={(v) => updateDraft({ descAreaH: v })} />
              </Row>
              <Row label="首行至描述头间距" mark={isNonDefault('body_margin_top')}>
                <NumInput label="" range={RANGE.body_margin_top} value={draft.body_margin_top} onChange={(v) => updateDraft({ body_margin_top: v })} />
              </Row>
              <Row label="曲部与曲部间距" mark={isNonDefault('height_ciqu')}>
                <NumInput label="" range={RANGE.height_ciqu} value={draft.height_ciqu} onChange={(v) => updateDraft({ height_ciqu: v })} />
              </Row>
              <Row label="曲部与词部间距" mark={isNonDefault('height_quci')}>
                <NumInput label="" range={RANGE.height_quci} value={draft.height_quci} onChange={(v) => updateDraft({ height_quci: v })} />
              </Row>
              <Row label="词部与词部间距" mark={isNonDefault('height_cici')}>
                <NumInput label="" range={RANGE.height_cici} value={draft.height_cici} onChange={(v) => updateDraft({ height_cici: v })} />
              </Row>
              <Row label="曲部与上词部间距" mark={isNonDefault('height_ciqu_lyric')}>
                <NumInput label="" range={RANGE.height_ciqu_lyric} value={draft.height_ciqu_lyric} onChange={(v) => updateDraft({ height_ciqu_lyric: v })} />
              </Row>
              {/* adj479：多声部块内声部行之间的额外间距——此前只挂在预览虚线拖拽上，
                  设置里没有输入框，用户报「同一组的多个声部之间间距无法调整」。 */}
              <Row label={uiCopy.shengbuGapLabel} mark={isNonDefault('height_shengbu')}>
                <NumInput label="" range={RANGE.height_shengbu} value={draft.height_shengbu} onChange={(v) => updateDraft({ height_shengbu: v })} />
              </Row>
            </div>

            {/* adj428：临时叠加段（{bz … } / {dsb … }）上下两行纵向间距——谱面级设置，
                跟随 .jps 走（与「间距」同一类，挨着放在它后面）。显示缺省回退 SEGMENT_ROW_GAP_DEFAULT。 */}
            <div className="pcfg-group-title">{uiCopy.segmentRowGapGroup}</div>
            <div className="pcfg-grid2">
              <Row label={uiCopy.segmentRowGapBzLabel} mark={isNonDefault('segmentRowGap')}>
                <NumInput
                  label=""
                  range={RANGE.segmentRowGap_bz}
                  value={draft.segmentRowGap?.bz ?? SEGMENT_ROW_GAP_DEFAULT.bz}
                  onChange={(v) => updateDraft({ segmentRowGap: { ...draft.segmentRowGap, bz: clampGap(v) } })}
                />
              </Row>
              <Row label={uiCopy.segmentRowGapDsbLabel} mark={isNonDefault('segmentRowGap')}>
                <NumInput
                  label=""
                  range={RANGE.segmentRowGap_dsb}
                  value={draft.segmentRowGap?.dsb ?? SEGMENT_ROW_GAP_DEFAULT.dsb}
                  onChange={(v) => updateDraft({ segmentRowGap: { ...draft.segmentRowGap, dsb: clampGap(v) } })}
                />
              </Row>
              {/* adj629：替谱段（歌词行里的 `{tp … }`）与**它所属那条歌词行**的间距 */}
              <Row label={uiCopy.segmentRowGapTpLabel} mark={isNonDefault('segmentRowGap')}>
                <NumInput
                  label=""
                  range={RANGE.segmentRowGap_tp}
                  value={draft.segmentRowGap?.tp ?? SEGMENT_ROW_GAP_DEFAULT.tp}
                  onChange={(v) => updateDraft({ segmentRowGap: { ...draft.segmentRowGap, tp: clampGap(v) } })}
                />
              </Row>
            </div>
            <div className="pcfg-note">
              {uiCopy.segmentRowGapHint}
            </div>

            {/* adj419：音符布局组挪到「间距」下面（用户要求：先看纸张/边距，再调间距，最后是排布方式） */}
            <div className="pcfg-group-title">音符布局</div>
            <Row label="布局模式" mark={isNonDefault('noteSpaceLayout')}>
              <select
                value={draft.noteSpaceLayout}
                onChange={(e) => updateDraft({ noteSpaceLayout: e.target.value as PageConfig['noteSpaceLayout'] })}
              >
                {/* adj289：空间优先设为默认并置于首位；时值优先保留可选 */}
                <option value="space">空间优先</option>
                <option value="duration">时值优先</option>
              </select>
            </Row>
            <Row label="连音线样式" mark={isNonDefault('lianyinxian_type')}>
              <select
                value={draft.lianyinxian_type}
                onChange={(e) => updateDraft({ lianyinxian_type: Number(e.target.value) as 0 | 1 | 2 })}
              >
                <option value={0}>自动</option>
                <option value={1}>圆弧</option>
                <option value={2}>平顶</option>
              </select>
            </Row>
            {/* adj297/adj602：两端对齐最小小节数。
                adj925（用户裁定）：**只对末行生效** —— 非末行一律两端对齐（撑满），
                只有**末行**才按它判（小节数 < 该值 ⇒ 自然对齐、行尾留白）。
                adj602（用户要求）：从「间距」组挪到**音符布局**组——它决定的是"行内怎么排"，
                与间距无关（放在间距里会被当成"调间隙"去找）。 */}
            <Row label="两端对齐最小小节数" mark={isNonDefault('align_min_bars')}>
              <NumInput label="" value={draft.align_min_bars} onChange={(v) => updateDraft({ align_min_bars: v })} />
            </Row>
            {/* adj625（用户要求）：**方框小节序号**——复选框开关 + 序号的"每隔几个小节"。
                位置口径：画在小节**左侧小节线下方**（行首隐藏小节线 ⇒ 边距线位置；
                多声部块首 ⇒ 大括号与音符之间），字号与音符注释一致。 */}
            <Row label="显示小节计数" mark={isNonDefault('showBarCount')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={draft.showBarCount === true}
                  onChange={(e) => updateDraft({ showBarCount: e.target.checked })}
                />
                在小节线下方显示带方框的小节序号
              </label>
            </Row>
            <Row label="序号间隔" mark={isNonDefault('barCountInterval')}>
              <NumInput
                label="小节"
                range={RANGE.barCountInterval}
                value={draft.barCountInterval}
                onChange={(v) => updateDraft({ barCountInterval: Math.round(v) })}
              />
            </Row>
            {tabNonDefaultCount > 0 && (
              <div className="pcfg-note pcfg-def-legend">
                <span className="pcfg-def-mark on" aria-hidden="true">*</span>
                {settingsCopy.defLegend}
              </div>
            )}
          </>
        )
      case 'font':
        return (
          <>
            <Row label="描述头" mark={isNonDefault('miaoshu_font') || isNonDefault('miaoshu_size')}>
              <FontSelect value={draft.miaoshu_font} onChange={(v) => updateDraft({ miaoshu_font: v })} />
              <NumInput label="字号" value={draft.miaoshu_size} onChange={(v) => updateDraft({ miaoshu_size: v })} />
            </Row>
            <Row label="标题" mark={isNonDefault('biaoti_font') || isNonDefault('biaoti_size')}>
              <FontSelect value={draft.biaoti_font} onChange={(v) => updateDraft({ biaoti_font: v })} />
              <NumInput label="字号" value={draft.biaoti_size} onChange={(v) => updateDraft({ biaoti_size: v })} />
            </Row>
            <Row label="副标题" mark={isNonDefault('fubiaoti_font') || isNonDefault('fubiaoti_size')}>
              <FontSelect value={draft.fubiaoti_font} onChange={(v) => updateDraft({ fubiaoti_font: v })} />
              <NumInput label="字号" value={draft.fubiaoti_size} onChange={(v) => updateDraft({ fubiaoti_size: v })} />
            </Row>
            <Row label="音符" mark={isNonDefault('shuzi_font') || isNonDefault('note_size')}>
              <FontSelect value={draft.shuzi_font} onChange={(v) => updateDraft({ shuzi_font: v })} />
              <NumInput label="字号" value={draft.note_size} onChange={(v) => updateDraft({ note_size: v })} />
            </Row>
            {/* adj303：显示乐器名——@乐器名 / @@ 切换后的下一个音符正上方标注乐器名（默认不显示）
                adj606：取消勾选写 `undefined`（= 未设置）而不是 `false`——可选字段的"关"就是"没写"，
                这样红 `*` 会熄灭、保存时也不会往谱面里留一条冗余的 `false` */}
            <Row label="乐器显示" mark={isNonDefault('showInstrument')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={draft.showInstrument === true}
                  onChange={(e) => updateDraft({ showInstrument: e.target.checked ? true : undefined })}
                />
                显示乐器名（@切换处音符上方标注）
              </label>
            </Row>
            <Row label="歌词" mark={isNonDefault('geci_font') || isNonDefault('geci_size')}>
              <FontSelect value={draft.geci_font} onChange={(v) => updateDraft({ geci_font: v })} />
              <NumInput label="字号" value={draft.geci_size} onChange={(v) => updateDraft({ geci_size: v })} />
            </Row>
            {/* adj292：歌词宽度不足时压缩字宽（默认不压缩允许重叠，选中才压缩）
                adj606：同「乐器显示」——取消勾选写 `undefined`（可选字段的"关"= 没写） */}
            <Row label="歌词压缩" mark={isNonDefault('lyricShrink')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={draft.lyricShrink === true}
                  onChange={(e) => updateDraft({ lyricShrink: e.target.checked ? true : undefined })}
                />
                宽度不足时压缩文字宽度
              </label>
            </Row>
            {/* adj154：说明（S 行）字体独立于描述头 */}
            <Row label="说明" mark={isNonDefault('notes_font') || isNonDefault('notes_size')}>
              <FontSelect value={draft.notes_font ?? draft.miaoshu_font} onChange={(v) => updateDraft({ notes_font: v })} />
              <NumInput label="字号" value={draft.notes_size ?? draft.miaoshu_size} onChange={(v) => updateDraft({ notes_size: v })} />
            </Row>
            {tabNonDefaultCount > 0 && (
              <div className="pcfg-note pcfg-def-legend">
                <span className="pcfg-def-mark on" aria-hidden="true">*</span>
                {settingsCopy.defLegend}
              </div>
            )}
          </>
        )
      /**
       * adj965（用户需求，方案 docs/OVERLAY-PLAN.md「OVL」）：**水印层**。
       *
       * 层序：曲谱（最上）→ 水印 → 背景。所有字段都是 L2（随谱走），默认值等于默认时**一个键都不写**。
       * 两处口径容易被误解，所以标签里写明：
       *  · "显示比率"以**页宽**为 100%（图形的宽度 = 页宽 × 比率，高度按原图比例）；
       *  · "位置"是**元素中心相对页面中心**的偏移（0,0 = 正中）。
       */
      case 'watermark':
        return (
          <>
            <div className="pcfg-group-title">水印</div>
            {/* adj965c（用户要求）：页内**开头**的总开关 —— 决定这份谱是否画水印 */}
            <Row label="启用水印" mark={isNonDefault('wmEnabled')}>
              <label className="pcfg-check">
                <input
                  type="checkbox"
                  checked={draft.wmEnabled === true}
                  onChange={(e) => updateDraft({ wmEnabled: e.target.checked })}
                />
                {overlayCopy.wmEnableDesc}
              </label>
            </Row>
            <Row label="类型" mark={isNonDefault('wmType')}>
              <select value={draft.wmType} onChange={(e) => updateDraft({ wmType: e.target.value as PageConfig['wmType'] })}>
                <option value="text">文字</option>
                <option value="image">图形</option>
              </select>
            </Row>
            <Row label="文本" mark={isNonDefault('wmText')}>
              {/* 用 textarea 而非 input：`wmText` 支持换行（引擎按多行整块居中绘制），
                  而 `<input>` **根本打不进换行** ⇒ 写"可多行"就成了假话 */}
              <textarea
                className="pcfg-text pcfg-textarea"
                rows={1}
                value={draft.wmText}
                placeholder={overlayCopy.wmTextPlaceholder}
                spellCheck={false}
                onChange={(e) => updateDraft({ wmText: e.target.value })}
              />
            </Row>
            <Row label="图形文件" mark={isNonDefault('wmImage')}>
              <input
                className="pcfg-text"
                value={draft.wmImage}
                placeholder={overlayCopy.imagePathPlaceholder}
                spellCheck={false}
                onChange={(e) => updateDraft({ wmImage: e.target.value })}
              />
            </Row>
            {/* 下面两行**始终渲染**（不按类型隐藏）：否则"按类型切换"会让脏标记计数漏项、也让用户以为字段消失了 */}
            <Row label="文本字号(pt)" mark={isNonDefault('wmSize')}>
              <NumInput label="" range={[6, 400]} value={draft.wmSize} onChange={(v) => updateDraft({ wmSize: v })} />
            </Row>
            <Row label="图形宽度(%)" mark={isNonDefault('wmScale')}>
              <NumInput label="" range={[10, 1000]} value={draft.wmScale} onChange={(v) => updateDraft({ wmScale: v })} />
            </Row>
            <Row label="旋转(°)" mark={isNonDefault('wmRotate')}>
              <NumInput label="" range={[-180, 180]} value={draft.wmRotate} onChange={(v) => updateDraft({ wmRotate: v })} />
            </Row>
            {/* adj965b（用户 2026-10-15）：**重复水印**（平铺满页面）+ 行列间隔 */}
            <Row label="重复铺满" mark={isNonDefault('wmRepeat')}>
              <label className="pcfg-check">
                <input
                  type="checkbox"
                  checked={draft.wmRepeat === true}
                  onChange={(e) => updateDraft({ wmRepeat: e.target.checked })}
                />
                {overlayCopy.wmRepeatDesc}
              </label>
            </Row>
            <Row label="平铺间隔(%)" mark={isNonDefault('wmRepeatGap')}>
              <NumInput
                label=""
                range={[0, 1000]}
                value={draft.wmRepeatGap}
                onChange={(v) => updateDraft({ wmRepeatGap: v })}
              />
            </Row>
            <Row label="透明度(0-100)" mark={isNonDefault('wmOpacity')}>
              <NumInput label="" range={[0, 100]} value={draft.wmOpacity} onChange={(v) => updateDraft({ wmOpacity: v })} />
            </Row>
            <Row label="位置(px)" mark={isNonDefault('wmOffsetX') || isNonDefault('wmOffsetY')}>
              <NumInput label="X" value={draft.wmOffsetX} onChange={(v) => updateDraft({ wmOffsetX: v })} />
              <NumInput label="Y" value={draft.wmOffsetY} onChange={(v) => updateDraft({ wmOffsetY: v })} />
            </Row>
            <div className="pcfg-note">{overlayCopy.wmNote}</div>
            {/* adj965c：同上（水印侧）。文本/图形任一有内容都算"已填" */}
            {draft.wmEnabled !== true && (draft.wmText.trim() !== '' || draft.wmImage.trim() !== '') && (
              <div className="pcfg-note">{overlayCopy.wmDisabledHint}</div>
            )}
            {/* adj965（方案优化 7）：图片解析失败**就地显示**，不静默少画一层 */}
            {overlayErrors(overlayCopy.wmErrorPrefix).map((e) => (
              <div key={e} className="pcfg-note pcfg-asset-err">
                ⚠ {e}
              </div>
            ))}
            {/* adj969：缺"资源目录"授权时给按钮（换个文件夹就行，别只留一句提示） */}
            {assetDirAuthNote}
          </>
        )
      /**
       * adj965：**背景层**（最底层，只显示页面内的部分）。
       * 空路径 ⇒ 什么都不画；默认值等于默认 ⇒ 不用这功能的谱一个键都不多。
       */
      case 'background':
        return (
          <>
            <div className="pcfg-group-title">背景</div>
            {/* adj965c（用户要求）：同上，背景也有总开关 */}
            <Row label="启用背景" mark={isNonDefault('bgEnabled')}>
              <label className="pcfg-check">
                <input
                  type="checkbox"
                  checked={draft.bgEnabled === true}
                  onChange={(e) => updateDraft({ bgEnabled: e.target.checked })}
                />
                {overlayCopy.bgEnableDesc}
              </label>
            </Row>
            <Row label="图形文件" mark={isNonDefault('bgImage')}>
              <input
                className="pcfg-text"
                value={draft.bgImage}
                placeholder={overlayCopy.imagePathPlaceholder}
                spellCheck={false}
                onChange={(e) => updateDraft({ bgImage: e.target.value })}
              />
            </Row>
            <Row label="位置(px)" mark={isNonDefault('bgOffsetX') || isNonDefault('bgOffsetY')}>
              <NumInput label="X" value={draft.bgOffsetX} onChange={(v) => updateDraft({ bgOffsetX: v })} />
              <NumInput label="Y" value={draft.bgOffsetY} onChange={(v) => updateDraft({ bgOffsetY: v })} />
            </Row>
            <Row label="宽度(%)" mark={isNonDefault('bgScale')}>
              <NumInput label="" range={[10, 1000]} value={draft.bgScale} onChange={(v) => updateDraft({ bgScale: v })} />
            </Row>
            <Row label="旋转(°)" mark={isNonDefault('bgRotate')}>
              <NumInput label="" range={[-180, 180]} value={draft.bgRotate} onChange={(v) => updateDraft({ bgRotate: v })} />
            </Row>
            <Row label="透明度(0-100)" mark={isNonDefault('bgOpacity')}>
              <NumInput label="" range={[0, 100]} value={draft.bgOpacity} onChange={(v) => updateDraft({ bgOpacity: v })} />
            </Row>
            <div className="pcfg-note">{overlayCopy.bgNote}</div>
            {/* adj965c（用户实报"背景没有显示"）：开关关着但路径已填 ⇒ 必须说明"是没启用，不是坏了" */}
            {draft.bgEnabled !== true && draft.bgImage.trim() !== '' && (
              <div className="pcfg-note">{overlayCopy.bgDisabledHint}</div>
            )}
            {overlayErrors(overlayCopy.bgErrorPrefix).map((e) => (
              <div key={e} className="pcfg-note pcfg-asset-err">
                ⚠ {e}
              </div>
            ))}
            {/* adj969：同上（背景侧） */}
            {assetDirAuthNote}
          </>
        )
    }
  }

  return (
    // adj418：fill —— 对话框内容撑满高度（页签与面板放中间滚动区，底部按钮固定可见）；
    // width 用 min(700px, 100%) 固定成"桌面满宽上限 / 窄屏铺满"——此前没给宽度，
    // 弹窗宽度由内容撑开，切页签时**弹窗宽度会跟着跳**（各页签内容宽度不同），页签与面板也就对不齐。
    // adj422：标题与菜单统一为「设置」（里面包含 全局/主题/音色库/谱面/字体 五个标签）
    <Modal
      // adj603：弹窗模式按 section 给标题（dock 内联时由底栏页签表达，不显示标题）
      title={section === 'score' ? '谱面设置' : '全局设置'}
      fill
      width="min(700px, 100%)"
      onClose={onCancelReset}
      inline={inline}
    >
      <div className="pcfg-root">
        {/* 中间滚动区：页签 + 面板（只有这里滚动，底部按钮永远可见） */}
        <div className="pcfg-scroll">
          <div className="jp-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`jp-tab${tab === t.id ? ' active' : ''}`}
                onClick={() => setTab(t.id)}
                title={t.label}
              >
                {/* adj463：图标常驻；文字在窄 dock 下由容器查询隐藏（只留图标） */}
                <span className="jp-tab-icon" aria-hidden="true">{t.icon}</span>
                <span className="jp-tab-label">{t.label}</span>
              </button>
            ))}
          </div>
          {/* adj463：内容区包一层容器；adj482：字段类页签再包一层 `.pcfg-fields`——
              dock 里它是**等宽字段网格**（按当页最长标签对齐，见 measureFields），
              主题/音色库这类自带排版的内容不套该层，保持各自布局。 */}
          <div className="pcfg-panel">
            {FIELDS_TABS.includes(tab) ? (
              // adj605：`data-nondefault` 把"当前被算作非默认的字段"暴露到 DOM——
              // 真机验证/回归脚本据此判断标记是否**随值变化同步**（不必反推视觉效果）
              <div className="pcfg-fields" ref={fieldsRef} data-nondefault={[...nonDefaultKeys].join(',')}>{renderPanel()}</div>
            ) : renderPanel()}
          </div>
        </div>

        {/* adj603：底部「恢复默认 / 保存设置」**只属于「谱面」这一半**——
            它们读写的是 `# jps-config`（谱面级）；而「全局」（版面/主题/音色库）是本机偏好，
            改一下就即时生效，不需要（也不该有）"保存"这一步。
            ⚠️ 这段**必须是 JSX 注释**（花括号包起来的块注释）：写成裸的块注释会被当成文本节点渲染，
            成为 `.pcfg-root` 网格里的匿名项 → 它的 max-content 宽把 `minmax(0,1fr)` 的内容列挤成 0 宽，
            表现为"只看得见子页签和按钮、子页签内容全不见了"（见 E-2026-293）。 */}
        {section === 'score' && (
          <div className="modal-foot pcfg-foot">
          <button
            className="btn"
            onClick={resetDraft}
          >
            恢复默认
          </button>
          <button
            className="btn primary"
            title={settingsCopy.saveConfigTitle}
            onClick={() => {
              // adj83：保存设置时持久化到源码 # jps-config 注释（每首谱用自己的设置）
              // adj-font（D1）：默认**差量写入**（只写与默认不同的字段；全部为默认时删除设置行）
              // adj454：传入打开时的快照 snapRef 作为基线——只固化**用户本次真正改动**的字段
              // adj480：本机页面设置缓存层已取消 ⇒ 生效配置 = 代码默认 ← 谱面，
              //   于是"保存"就等于"把这份谱补成自包含"，不再需要单独的「固化到谱面」动作。
              committedRef.current = true
              // adj600：保存的基线随之推进（本面板自己写的这份不算"外部变化"，不必重新取种子）
              lastAppliedRef.current = draft
              setPageConfig(draft, true, snapRef.current)
              closeDock()
            }}
          >
            保存设置
          </button>
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * 谱面字体候选（adj-font：改由引擎 `SCORE_FONT_OPTIONS` 统一提供——每项都是**含通用族的完整栈**，
 * 避免旧版"裸字体名"换机器掉到浏览器默认字体；跨机可用/适合简谱/保证有 fallback 三原则）。
 */
const FONT_OPTIONS: { label: string; value: string }[] = SCORE_FONT_OPTIONS

// adj428：临时段间距范围——bz 段至少要大于一行音符高（≈ 13 + 减时线 + 间距 ≈ 18），
// 上限取 80（再大就跟上一行曲部挤到一起，反而比"上间距"还大，破坏排版层级）。
const SEGMENT_ROW_GAP_MIN = 10
const SEGMENT_ROW_GAP_MAX = 80
const clampGap = (v: number): number => Math.max(SEGMENT_ROW_GAP_MIN, Math.min(SEGMENT_ROW_GAP_MAX, Math.round(v)))

function FontSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const opts = value && !FONT_OPTIONS.some((o) => o.value === value) ? [{ label: value, value }, ...FONT_OPTIONS] : FONT_OPTIONS
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ maxWidth: 160 }}
    >
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/**
 * 一行设置：标签 + 控件。
 *
 * adj605（用户要求）：`mark` 表达**"这一项与代码默认值不同"**——
 *   · `true`  → 标签后一个**红色 `*`**（`title` 说明含义）；
 *   · `false` → **空占位**（宽度固定）：标记出现/消失都不会改变标签列宽，
 *               否则字段网格会随 `*` 的亮灭左右横跳（`--pcfg-label-w` 是"当页最长标签"）；
 *   · `undefined`（不给）→ 该页不参与标记（「版面/主题/音色库」是本机偏好，没有"谱面默认值"一说），
 *               连占位都不渲染，不给这些页白添宽度。
 */
function Row({ label, mark, children }: { label: string; mark?: boolean; children: React.ReactNode }) {
  return (
    // adj418：标签列给足宽度且不换行（「两端对齐最小小节数」这类长标签不再折成两行）。
    // adj482：布局**全部交给 CSS**（`.pcfg-row` / `.pcfg-row-label` / `.pcfg-row-ctl` 已从内联搬到
    // index.css）——内联样式会压过 dock 里的覆盖规则，导致"按当页最长标签对齐"的规则无法生效。
    <div className="pcfg-row">
      <span className="pcfg-row-label">
        {label}
        {mark !== undefined && (
          <span
            className={`pcfg-def-mark${mark ? ' on' : ''}`}
            aria-hidden="true"
            title={mark ? settingsCopy.defMarkTitle : undefined}
          >
            {mark ? '*' : ''}
          </span>
        )}
      </span>
      <div className="pcfg-row-ctl">{children}</div>
    </div>
  )
}

/**
 * 数值输入框（adj526 重写）——三类操作并存，桌面/手机都顺手：
 *  1. **键盘输入**（点一下即可）：编辑期间用**本地草稿文本**，**不再"输入即钳制"**。
 *     这是手机端"数字改不动"的直接原因——受控值 + 每次按键立即钳制，想输 `50` 打到 `5` 就被钳成 `10`；
 *     现在改为**失焦 / 回车才提交并钳制**，中途可以自由打完整数字；
 *  2. **`−`/`+` 步进**：点一下一步，**按住连续**（长按 420ms 后每 90ms 一步）——手机上可见
 *     （桌面靠原生 spinner，故用 `(pointer: coarse)` 只在触屏显示，见 CSS）；
 *  3. **按住上下拖**（`useNumberScrub`）：上拖增大、下拖减小，横向位移转粗调（×10）；
 *     触屏需先长按 250ms（给"滚面板"留出通道），鼠标按住即拖。
 * `range` 来自 `PAGE_NUM_RANGES`（谱面字段 = 引擎 `GUIDE_LIMITS` 的同一份范围）；不给就是"不限范围"，
 * 拖动只做相对增量（保住设置里可填极值的能力）。
 */
function NumInput(props: {
  label?: string
  value: number
  onChange: (v: number) => void
  /** [min,max]；缺省 = 不限范围（拖动只做相对增量，输入也不钳制） */
  range?: readonly [number, number]
  /** 步长（默认 1） */
  step?: number
}) {
  const { label = '', value, onChange, range, step = 1 } = props
  const min = range?.[0]
  const max = range?.[1]
  const clampV = (v: number): number => {
    let n = Math.round(v)
    if (min !== undefined) n = Math.max(min, n)
    if (max !== undefined) n = Math.min(max, n)
    return n
  }
  /** 编辑中的文本；非 null = 正在输入（此时**不**钳制、也不回写） */
  const [draft, setDraft] = useState<string | null>(null)
  /**
   * adj608：**ESC = 放弃这次输入**用的标记。
   *
   * 为什么需要它：按 ESC 会 `blur()`，而 blur 触发 `commit()`——`commit` 读的是**本次渲染的
   * `draft`**（还是刚敲进去的那串），于是"按 ESC 取消"实际会把值提交上去（实测：输入 `999`
   * 按 ESC，被钳成 `26` 写进了设置）。加一个"这次 blur 别提交"的一次性标记，
   * ESC 才真的只是回退到已提交的值。
   */
  const skipCommitRef = useRef(false)
  /** 把草稿提交到配置（失焦 / 回车）：空串视为"放弃编辑"，不把 0 写进去 */
  const commit = () => {
    // adj608：ESC 之后的这次 blur 不提交（标记一次性）
    if (skipCommitRef.current) {
      skipCommitRef.current = false
      setDraft(null)
      return
    }
    if (draft === null) return
    const raw = draft.trim()
    if (raw !== '') {
      const n = Number(raw)
      if (Number.isFinite(n)) onChange(clampV(n))
    }
    setDraft(null)
  }
  const scrub = useNumberScrub(value, onChange, { step, min, max, coarse: coarseFor(range) })
  const dec = useHoldRepeat(() => onChange(clampV(value - step)))
  const inc = useHoldRepeat(() => onChange(clampV(value + step)))
  return (
    <span className="num-input">
      {label && <span className="num-input-label">{label}</span>}
      <button type="button" className="num-step" title={numCopy.decrease} aria-label={numCopy.decrease} {...dec}>
        −
      </button>
      <input
        className={`num-field${scrub.scrubbing ? ' is-scrubbing' : ''}`}
        type="number"
        // 手机弹数字键盘（并给出"完成"键）；桌面仍是普通数字框（保留原生上下小按钮）
        inputMode="numeric"
        enterKeyHint="done"
        step={step}
        min={min}
        max={max}
        value={draft ?? String(value)}
        title={numCopy.scrubHint}
        onFocus={() => setDraft(String(value))}
        // 只改本地草稿：**这是"手机能正常输入"的关键**（不即时钳制）
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            // adj608：ESC = **放弃这次输入**（回退到已提交的值）；`preventDefault` 同时告诉底栏
            // "这个 ESC 我用了"（别顺手最小化底栏，见 ToolDock 的 `escMinimizeDock`）。
            e.preventDefault()
            skipCommitRef.current = true
            e.currentTarget.blur()
          }
        }}
        onPointerDown={scrub.onPointerDown}
        onClickCapture={scrub.onClickCapture}
      />
      <button type="button" className="num-step" title={numCopy.increase} aria-label={numCopy.increase} {...inc}>
        +
      </button>
    </span>
  )
}
