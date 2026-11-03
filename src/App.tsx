/**
 * App.tsx — iJipu（爱记谱）应用外壳
 * 布局（adj281）：
 *   TopBar（合并原菜单栏 + 工具栏）/ 主区域（编码·拆分·预览）/
 *   ToolDock（adj462：底部 dock，告警/试听/导出/设置互斥切换）/
 *   EditorFootBar（合并原脚本编辑器顶栏 + 状态栏）+ 模态框
 */
import { Suspense, lazy, useEffect, useRef, useSyncExternalStore } from 'react'
import { TopBar } from './ui/TopBar'
import { EditorFootBar } from './ui/EditorFootBar'
import { ToolDock } from './ui/ToolDock'
import { beginDrag } from './ui/dragGesture'
import { Toast } from './ui/Toast'
import { ConfirmBar } from './ui/ConfirmBar'
// adj968：拖放高亮层（把 .jps 拖进窗口就能打开，见 store/dropOpen.ts）
import { DropOverlay } from './ui/DropOverlay'
import { UpdatePrompt } from './ui/UpdatePrompt'
import { EditorPane } from './editor/EditorPane'
// adj642（用户要求）：Ctrl+F 用编辑区选中文本预填查找框（纯函数，冒烟有断言）
import { seedQueryFromSelection } from './editor/findReplace'
import { PreviewPane } from './preview/PreviewPane'
import { useDocStore } from './store/docStore'
import { useUiStore } from './store/uiStore'
// adj1155：打开文件时读 sidecar extras，并在改动时自动写回（练习段/相机段/音量不再刷新即丢）
import { useSyncSidecarExtras } from './store/syncExtras'
// adj538：桌面壳「外部打开」（双击 .jps）——拉取待打开队列 + 监听后续打开请求
import { drainExternalFiles, hasShell, onExternalOpen } from './store/externalOpen'
// adj900：从 URL 文本串导入源码（官网首页「在应用里试听这段」带过来的）
import { fetchJpsFromUrl, readJpsFromSearch, readSrcFromSearch, withoutJpsParam } from './store/urlImport'
// adj969：「资源目录」授权（网页 / PWA 用文件句柄打开的谱，浏览器不给父目录）
import { getAssetDirRevision, subscribeAssetDir } from './store/assetDirAuth'
// adj969：判"这份谱需不需要基准目录"的唯一口径（引擎里，两端共用）
import { localAssetRefs } from '@ijipu/engine'
import { startWorkspaceIndexWarmup } from './store/workspaceIndexWarm'
// adj610：Ctrl+D / Ctrl+H 的"有告警先看告警"判据与「展开底栏」按钮同一份（`ui/problems.ts`）
import { summarizeProblems } from './ui/problems'
// adj614：Ctrl+M 的视图循环顺序（与顶栏「视图」下拉同一份，见 `ui/viewCycle.ts`）
import { nextViewType } from './ui/viewCycle'
// adj614：Ctrl+T 的深浅模式循环（与顶栏「深浅模式」按钮同一份）
import { nextThemeMode } from './brand/themes'
// adj621/adj971：应用标题统一来源（浏览器页签 + PWA + 桌面窗口标题共用 `appTitleOf(文件名)`）
import { appTitleOf } from './brand/version'
// adj954：`__TAURI__` 的读取收敛到品牌层唯一出处（本文件原先自己写了一段类型体操）
import { tauriInvokeOrNull } from './brand/env'
// adj350：对话框懒加载（React.lazy）——首屏不加载它们，显著减小主包、加快首屏显示
// adj492：「关于」已迁入底栏 dock（见 ui/ToolDock），此处不再需要弹窗版懒加载
const SamplesDialog = lazy(() => import('./dialogs/SamplesDialog').then((m) => ({ default: m.SamplesDialog })))
// adj462：试听/导出/设置的对话框内容已移到底部 dock（ToolDock 里的 registry 懒加载它们），
// 不再从 App 作为模态渲染
const ShortcutsDialog = lazy(() => import('./dialogs/ShortcutsDialog').then((m) => ({ default: m.ShortcutsDialog })))
const DocDialog = lazy(() => import('./dialogs/DocDialog').then((m) => ({ default: m.DocDialog })))
const DonateDialog = lazy(() => import('./dialogs/DonateDialog').then((m) => ({ default: m.DonateDialog })))
// adj562：「粘贴源码导入」已迁入底栏（ToolDock 的「导入」页签）⇒ 不再从 App 作为模态渲染
// adj509：试听音色选择对话框（从音色库面板的「指定音色」按钮触发）
const VoicePickerDialog = lazy(() => import('./dialogs/VoicePickerDialog').then((m) => ({ default: m.VoicePickerDialog })))
// adj928：两栏源码差异框（确认条的「查看差异」打开；数据在 uiStore.fileDiff）
const FileDiffDialog = lazy(() => import('./dialogs/FileDiffDialog').then((m) => ({ default: m.FileDiffDialog })))
// adj963（用户要求）：「保存到工作区」专用对话框（插件嵌入版的保存主入口）
const SaveAsDialog = lazy(() => import('./dialogs/SaveAsDialog').then((m) => ({ default: m.SaveAsDialog })))
const CardStyleDialog = lazy(() => import('./dialogs/CardStyleDialog').then((m) => ({ default: m.CardStyleDialog })))
// adj1119：对拍台（应用内独立台面；相机位「对拍…」触发）
const SyncDialog = lazy(() => import('./dialogs/SyncDialog').then((m) => ({ default: m.SyncDialog })))

function App() {
  const viewType = useDocStore((s) => s.viewType)
  const modal = useUiStore((s) => s.modal)
  // adj928：两栏源码差异框（与 `modal` 分开：它是在确认条之上叠一层，关掉它确认条还在）
  const fileDiff = useUiStore((s) => s.fileDiff)
  const theme = useUiStore((s) => s.theme)
  const themeMode = useUiStore((s) => s.themeMode)
  // adj1000：深色预览柔化档位（挂到 <html data-soften>，由 styles/theme.css 消费）
  const previewSoften = useUiStore((s) => s.previewSoften)
  // adj1155：sidecar extras（练习段/相机段/音量）—打开时读、改动时自动写回
  useSyncSidecarExtras()
  const systemLight = useUiStore((s) => s.systemLight)
  const setSystemLight = useUiStore((s) => s.setSystemLight)
  const splitPct = useUiStore((s) => s.splitPct)
  const setSplitPct = useUiStore((s) => s.setSplitPct)
  // adj322：宽/窄屏实时同步
  const isNarrow = useUiStore((s) => s.isNarrow)
  const setIsNarrow = useUiStore((s) => s.setIsNarrow)
  // adj315：左右拆分排列方向（全局设置——预览/编辑在 splitH 时的左右方位）
  const splitHDir = useUiStore((s) => s.splitHDir)
  const mainRef = useRef<HTMLDivElement>(null)

  /**
   * adj900（用户决定「用文本串导入功能」）：**从 URL 文本串导入源码**。
   *
   * 官网首页示例区的「在应用里试听这段」把用户正在看的那段 `.jps` 挂在
   * `?jps=<encodeURIComponent(源码)>` 上带进来 —— 于是首页不需要下载 30MB 音色库，
   * 用户又能在应用里直接看到（并试听）自己刚才看的那段。
   *
   * **载入动作复用现成的 `importSource`**（adj406「粘贴源码导入」）：清洗内容、清磁盘句柄、
   * **清来源绑定**、与工作区解绑、标记 dirty —— 这些它都做过了，不另写一套。
   * （自己写 localStorage 的话，漏清 `ijipu.draftSrc` 就会让应用以为这份草稿绑着
   * 用户上次打开的文件，之后 Ctrl+S 可能把示例写进他自己的谱里。）
   *
   * ⚠ 优先次序：**URL 参数（用户刚点的，最明确）> 外部打开的文件 > 本地草稿**。
   * 所以这段放在下面 `drainExternalFiles` 的 effect **之前**（React 按声明顺序执行）。
   *
   * ⚠ 导入后**立刻把参数从地址栏抹掉**：不清的话用户一刷新就又被打回示例，
   * 他在应用里改的那几笔全白改 —— 而且会以为"链接参数根本没生效"。
   */
  useEffect(() => {
    const search = window.location.search
    const incoming = readJpsFromSearch(search)
    const src = readSrcFromSearch(search)
    if (incoming === null && src === null) return
    const strip = () => {
      const rest = withoutJpsParam(search)
      window.history.replaceState(null, '', `${window.location.pathname}${rest}${window.location.hash}`)
    }
    if (incoming !== null) {
      useDocStore.getState().importSource(incoming)
      strip()
      return
    }
    if (src === null) return
    /**
     * adj1191（P1）：曲库详情页的「在应用里编辑」用 `?src=<站内 .jps 地址>`。
     * 读回来之后仍然走 `importSource`（与 `?jps=` 同一条路），不另写载入逻辑。
     * 失败**不抹掉参数**：用户刷新一次就能重试，提示里也写清原因。
     */
    let alive = true
    void fetchJpsFromUrl(src)
      .then((code) => {
        if (!alive) return
        useDocStore.getState().importSource(code)
        strip()
      })
      .catch((e: unknown) => {
        if (!alive) return
        useUiStore
          .getState()
          .showNotice(`打不开链接里的谱：${e instanceof Error ? e.message : String(e)}`, 'error')
      })
    return () => {
      alive = false
    }
  }, [])

  /**
   * adj538：桌面壳「外部打开」（双击 `.jps` / 文件关联）接线。
   * 两条路都指向 Rust 侧同一个**取走即清空**的队列，因此既不会漏也不会重复打开：
   *   ① 冷启动：双击时应用还没起，事件可能早于我此刻注册监听 ⇒ mount 时**主动拉取一次**；
   *   ② 热启动：应用已在运行，单实例插件把路径入队并 emit `ijipu://open-files` ⇒ 监听后拉取。
   * 纯浏览器里 `hasShell()` 恒为 false，这段整体空转（不影响网页版行为）。
   */
  useEffect(() => {
    if (!hasShell()) return
    const load = () => {
      void drainExternalFiles().then((files) => {
        if (files.length > 0) useDocStore.getState().openExternalFiles(files)
      })
    }
    load() // ① 冷启动：处理启动参数带来的文件
    return onExternalOpen(load) // ② 热启动：后续再有双击就再拉一次
  }, [])

  /**
   * adj599（用户要求）：**启动后在后台空闲时段预热历史工作区的索引**。
   * 用户口径："打开网站后就在后台异步进行，对历史工作区的目录进行索引缓存，先当前工作区，
   * 再其它工作区，这样在用户点击工作区时，基本就已索引完成；当然对于新工作区，就只能立即索引缓存。"
   * 细节（空闲调度、当前优先、只扫已授权且索引过期的、写操作作废在跑的扫描、不弹提示）都在
   * `startWorkspaceIndexWarmup()` 里；这里只负责"启动一次"（幂等）。
   */
  useEffect(() => {
    startWorkspaceIndexWarmup()
  }, [])

  /**
   * adj615（用户要求）：注册**打印钩子**（`beforeprint` / `afterprint`，幂等，只装一次）。
   *
   * 为什么要它：`Ctrl+P` 在浏览器里会被内核收去**弹自己的打印对话框**（页面收不到 keydown ⇒
   * 应用里的打印处理跑不到）；但那种情况仍会触发 `beforeprint` ⇒ 在这里补上"打印用页面 + 隐藏应用界面"，
   * 打出来的才是谱面而不是整个应用界面（见 `export/print.ts`）。
   */
  useEffect(() => {
    useDocStore.getState().installPrintSupport()
  }, [])

  /**
   * adj965（方案「OVL」，EP-10）+ adj969：**水印/背景图的解析触发**。
   *
   * 何时需要重新解析：① `wmImage` / `bgImage` / `wmType` 变了（用户改了设置）；
   * ② 文档换了"基准"（打开了别的文件、从桌面双击打开、切了工作区）；
   * ③ adj969：**资源目录授权状态变了**（`assetDirRev`）——用户刚授权完文件夹，图要立刻出来。
   *
   * 基准四态（方案 §四.1 的三态 + adj969 补的第四态）：
   *   工作区绑定 → `nativePath` 目录 → **已授权的"本谱所在目录"（文件方式打开的谱）** → 都没有。
   * 第四态就是用户实报的那条：网页 / PWA 用文件句柄打开的谱，浏览器**不给父目录**，
   * 只能靠用户额外授权一次所在文件夹（`store/assetDirAuth.ts`）。
   *
   * ⚠ 解析失败**不在这里弹提示**（每次重排都会重跑，会把用户烦死）——
   * 错误存在快照里，由「水印 / 背景」两个设置页签就地显示（`overlaySnapshot.errors`）。
   * （唯一会弹的那一次是"打开后自动问一句要不要授权文件夹"，它发生在打开动作的手势里，
   *  见 `docStore.adoptDoc` —— 这里这条路只**核对**记忆，绝不弹。）
   */
  const assetPageConfig = useDocStore((s) => s.pageConfig)
  const assetBinding = useDocStore((s) => s.binding)
  const assetNativePath = useDocStore((s) => s.nativePath)
  // adj969：文件方式打开时的一句柄 + 文件名（算基准的第四态要用）
  const assetFileHandle = useDocStore((s) => s.fileHandle)
  const assetFileName = useDocStore((s) => s.fileName)
  /**
   * adj969：这份谱**需不需要**"基准目录"（写了相对路径的水印/背景图才算）。
   *
   * 在**渲染体**里算成一个布尔量（而不是把整个 `assetPageConfig` 对象塞进 effect 的依赖）：
   * 那个对象每次改设置都换引用，带进依赖会让 effect 每敲一个字就重跑一次 IO。
   */
  const assetNeedDir = localAssetRefs(assetPageConfig).length > 0
  const assetDirRev = useSyncExternalStore(subscribeAssetDir, getAssetDirRevision)
  useEffect(() => {
    let alive = true
    void (async () => {
      const { getWorkspace } = await import('./store/workspace')
      const { syncOverlayAssets } = await import('./store/overlayAssets')
      // adj969：资源目录那一层（授权状态 + 基准对象）
      const { adoptRememberedAssetDir, getAssetBase, refOfHandle } = await import('./store/assetDirAuth')
      const rec = assetBinding !== null ? await getWorkspace() : null
      const fileOnly = assetBinding === null && assetNativePath === null && assetFileHandle !== null
      /**
       * adj969：**只核对记忆，不弹选择器**（这条路不是用户手势）。
       * 弹的那一次在打开动作里（`docStore.adoptDoc` → `autoEnsureAssetDir`）；
       * 启动时恢复草稿、或用户手改设置触发的重算都走这里 ⇒ 没授权时只留提示，不骚扰。
       */
      if (fileOnly && getAssetBase() === null) {
        await adoptRememberedAssetDir(assetNeedDir, await refOfHandle(assetFileHandle))
      }
      if (!alive) return
      const picked = fileOnly ? getAssetBase() : null
      const base =
        assetBinding !== null && rec !== null
          ? ({ kind: 'workspace', rec, segs: assetBinding.segs } as const)
          : assetNativePath !== null
            ? ({ kind: 'native', dir: assetNativePath.replace(/[\\/][^\\/]*$/, '') } as const)
            : picked !== null
              ? picked
              : fileOnly
                ? ({ kind: 'fileNoDir', name: assetFileName } as const)
                : ({ kind: 'none' } as const)
      await syncOverlayAssets(
        {
          wmEnabled: assetPageConfig.wmEnabled !== false,
          wmType: assetPageConfig.wmType,
          wmImage: assetPageConfig.wmImage,
          bgEnabled: assetPageConfig.bgEnabled !== false,
          bgImage: assetPageConfig.bgImage,
        },
        base,
      )
    })()
    return () => {
      alive = false
    }
  }, [
    assetPageConfig.wmEnabled,
    assetPageConfig.wmType,
    assetPageConfig.wmImage,
    assetPageConfig.bgEnabled,
    assetPageConfig.bgImage,
    assetBinding,
    assetNativePath,
    assetFileHandle,
    assetFileName,
    assetNeedDir,
    assetDirRev,
  ])

  /**
   * adj621 + adj971（**用户 2026-10-18 口径**）：**统一应用标题**——四处宿主共用一份：
   * 桌面壳（Tauri）窗口标题、PWA 窗口/页签、网页版页签、Obsidian 嵌入版。
   *
   * **口径已改**（用户原话）：「壳端、PWA 标题、网站页签、插件的嵌入版 ijipu 的标题信息改为
   * "文件名.jps - 爱记谱 iJipu"，而版本信息显示在**状态栏的右侧**、**官网首页的左边**」。
   *  ① 标题 = `brand/version.ts` 的 `appTitleOf(fileName)`（单一来源），**不再带版本**；
   *  ② `document.title`：浏览器页签 + PWA 页签（同一份 window.title，无副作用）；
   *  ③ `core.invoke('plugin:window|set_title', { label, value })`：桌面 OS 窗口标题栏 / 任务栏
   *     —— 用裸 IPC 而非 `getCurrentWindow().setTitle()` JS API，因为后者在 React mount 时
   *     可能撞上 `window.__TAURI__` 注入时机（adj621 实测：mount 那一刻 `__TAURI__.window`
   *     子树可能还没 ready，JS API 包装的 setTitle 静默失败、document.title 改对了但 OS 窗口标题
   *     没动；用户实测看到的 OS 任务栏一直是 `tauri.conf.json` 里的硬编码「爱记谱 iJipu」）。
   *     用 `core.invoke` 走短路径更稳：capability 已声明 `core:window:allow-set-title`，
   *     IPC 参数 `{ label: 'main', value: <标题> }`（v2 命令签名是 `value` 不是 `title`）。
   *  ④ 初始 `app/index.html` <title> 仍是 `爱记谱 iJipu`，挂载前那一瞬的占位——几十毫秒内被覆盖。
   *
   * 设置 OS 窗口标题放在 `requestAnimationFrame` 之后跑，确保 WebView 的 `withGlobalTauri`
   * 注入窗口标题 IPC 通道就绪（adj621 实测：mount 那一刻直接调会被静默吞掉，延一帧就好）。
   *
   * 失败（非 Tauri 环境 / 权限缺失）静默忽略——浏览器里没这个 IPC。
   *
   * adj954：`__TAURI__` 的读取收敛到 `brand/env.ts`；`tauriInvokeOrNull` 在非桌面壳里直接返回 `null`，
   * 于是这里连"先判环境"都不用写（静默忽略的语义与原先一致）。
   *
   * ⚠ adj971 起**依赖 `fileName`**：换文件 / 另存为 / 新建都要跟着改标题
   * （所以效果从"mount 时一次"变成"文件名变一次就跟一次"）。
   */
  const titleFile = useDocStore((s) => s.fileName)
  useEffect(() => {
    /**
     * adj978（**用户 2026-10-18 最终口径**）：「**直接显示文件名**，壳有加应用名就加，没有的就只显示
     * 文件名，**重复显示反而不美**」⇒ 标题**只有文件名**（`appTitleOf` 不再拼应用名）。
     *
     * 为什么最终这么定（`adj977` 实测）：安卓已安装 PWA（WebAPK）的标题栏格式是
     * `<manifest 的 name>` + ` - ` + `<页面标题>` ⇒ 我们无论把应用名放前面还是后面，都会重复一次；
     * 而"应用名"本来就该由**显示它的那一层**去显示（安卓有，桌面壳/浏览器页签没有，那就没有）。
     */
    const title = appTitleOf(titleFile)
    document.title = title
    const raf = requestAnimationFrame(() => {
      void tauriInvokeOrNull('plugin:window|set_title', { label: 'main', value: title })
      /* setTitle 失败不影响页面功能 —— document.title 已生效，至少页签/任务栏 tooltip
         用的是页面 title（多数浏览器/Win 任务栏 hover 都看这个） */
    })
    return () => cancelAnimationFrame(raf)
  }, [titleFile])

  // adj48：跟随系统深浅色——监听 prefers-color-scheme 变化
  useEffect(() => {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: light)')
      const onChange = () => setSystemLight(mq.matches)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    } catch {
      return
    }
  }, [setSystemLight])

  // adj322：宽/窄屏实时同步——matchMedia 'change' 回调驱动 uiStore.isNarrow
  useEffect(() => {
    try {
      const mq = window.matchMedia('(max-width: 1024px)')
      // 初始值可能与已加载的 draft 视图不同 → 用 mq 当前值纠正一次
      setIsNarrow(mq.matches)
      const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    } catch {
      /* matchMedia 不支持时,detectNarrow 已用 innerWidth 兜底 */
    }
  }, [setIsNarrow])

  // adj322：宽窄屏 → 拆分模式自动切换。
  // 设计：仅依赖 isNarrow（视口跨阈值时触发）。
  // 每次跑通过 store.getState() 取最新值,避免把 viewType/splitHDir 放进 deps
  // —— 这样用户主动改 viewType 时本 effect 不会重入拉回。
  // 首次加载兼容：组件挂载时 effect 首跑,按当前视口纠正持久化的 viewType。
  // 校正规则：
  //   - 仅作用于拆分类视图（split / splitH / splitHE）;
  //   - 窄屏 → 上下 'split'；宽屏 → 左右（按 splitHDir 选 splitH/splitHE）;
  //   - splitH ↔ splitHE 之间不自动切换（保留用户设置的左右方位）。
  useEffect(() => {
    const v = useDocStore.getState().viewType
    if (v !== 'split' && v !== 'splitH' && v !== 'splitHE') return
    const dir = useUiStore.getState().splitHDir
    if (isNarrow && v !== 'split') {
      useDocStore.getState().setViewType('split')
    } else if (!isNarrow && v === 'split') {
      useDocStore.getState().setViewType(dir === 'editorLeft' ? 'splitHE' : 'splitH')
    }
  }, [isNarrow])

  // 实际深浅色：auto 模式下跟随系统偏好
  const effectiveMode = themeMode === 'auto' ? (systemLight ? 'light' : 'dark') : themeMode

  // 全局快捷键（adj185：capture 阶段监听——bubble 阶段可能被子元素 stopPropagation 拦截，
  // 导致 Ctrl+S/Ctrl+N 等在编辑器聚焦时失效；capture 最优先且处理即阻断，保证始终响应）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useDocStore.getState()
      const ui = useUiStore.getState()
      if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        // adj70：撤销 Ctrl+Z（重做原为 Ctrl+Y；adj619b 起挪到 Ctrl+Shift+Z）
        e.preventDefault()
        e.stopPropagation()
        st.undo()
      } else if (e.ctrlKey && e.key.toLowerCase() === 'z' && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        /**
         * adj619b：`Ctrl+Y` 让给「导出」之后，**重做改用跨平台惯例 `Ctrl+Shift+Z`**
         * （`Ctrl+Z` 撤销那条带 `!e.shiftKey`，两条互不抢键；速查表与菜单提示同步改了）。
         */
        st.redo()
      } else if (e.ctrlKey && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        e.stopPropagation()
        /**
         * adj619b（用户要求）：**`Ctrl+Y` = 导出开关**（用户口径"导出的快捷键改为 Ctrl+Y"）。
         * ⚠ 这个键原来是"重做" ⇒ 重做已挪到 `Ctrl+Shift+Z`（见上一条分支与速查表），
         * 一个键不能既重做又开导出。
         */
        ui.requestDockPanel('export')
      } else if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        e.stopPropagation()
        // adj963：走**模式感知**的保存（嵌入版/手机端未绑定文档时要开专用对话框或工作区面板，
        // 直接调 saveFile() 会在插件里弹系统选择器 ⇒ 跨源子框架 SecurityError）
        void st.requestSave()
      } else if ((e.ctrlKey || e.altKey) && !e.shiftKey && e.key.toLowerCase() === 'n') {
        /**
         * adj628：**新建**同时接受 `Ctrl+N` 与 `Alt+N`。
         *
         * 为什么两条都要：`Ctrl+N` 是**浏览器自己占的快捷键**（开新窗口）——网页版页面收不到它，
         * 于是"看着像新建、其实新窗口恢复了上次的草稿与文件绑定"，在新窗口里编辑保存会**覆盖原文件**
         * （用户报的正是这个：Ctrl+N 后状态栏还是上一个文件名；真机复现见 E-2026-310）。
         * 网页版因此改用页面能拦下的 `Alt+N`（菜单/速查显示的也是它，见 `brand/shortcuts.ts`）；
         * 桌面壳（wry 关掉了 WebView2 的浏览器快捷键）照旧 `Ctrl+N`，两条都收，省得用户换机时按错。
         */
        e.preventDefault()
        e.stopPropagation()
        // adj963：走 `requestNewDoc()` —— 有未保存修改时先经确认条问一句（见 docStore 里的说明）
        st.requestNewDoc()
      } else if (e.ctrlKey && e.key.toLowerCase() === 'q') {
        e.preventDefault()
        e.stopPropagation()
        // adj563：原为 `openModal('playback')`，但试听早在 adj462 迁进底栏 dock
        // ⇒ `modal === 'playback'` 没有渲染分支、**Ctrl+Q 是死的**（菜单上还印着 Ctrl+Q）。
        // 与菜单项 `entryTryout` 同口径：开关「试听」底栏。
        // adj619（用户要求）：底栏入口快捷键走 `requestDockPanel`——**最小化时先展开到建议高度**
        //（"是否最小化"只有 ToolDock 自己知道，故只发请求，见 uiStore 里那条说明）。
        ui.requestDockPanel('tryout')
      } else if (e.ctrlKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        e.stopPropagation()
        /**
         * adj619b（用户要求）：**`Ctrl+O` 改回「打开文件」**——用户口径"对于 Ctrl+O 还是保持
         * 对应打开对话框吧"。于是 adj615 那次"改挂导出"整体回退：菜单里「打开」的 `Ctrl+O`
         * 角标也回来了，导出改用 `Ctrl+Y`（见上面的分支）。
         */
        void st.openFile()
      } else if (e.ctrlKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        e.stopPropagation()
        /**
         * adj615（用户要求）：**Ctrl+P = 打印**（打开打印对话框，打印当前谱面）。
         * 与菜单「打印(&D)…」共用 `printScore()`：现算布局与 SVG、有语法错误就提示不打。
         *
         * ⚠ 平台差异（实测见 E-2026-301）：**浏览器**把 `Ctrl+P` 留给了自己的打印对话框
         * （页面收不到 keydown）——不过那条路同样会走 `beforeprint`，打印内容一样正确
         * （`installPrintSupport()` 在那里补页面）；桌面壳里本 handler 正常生效。
         */
        st.printScore()
      } else if (e.ctrlKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        e.stopPropagation()
        /**
         * adj614（用户要求）：**Ctrl+T = 深浅模式循环**（`auto → light → dark → auto`）。
         * 循环表在 `brand/themes.ts` 的 `nextThemeMode()`，与顶栏「深浅模式」按钮**同一份**
         * （按钮的提示文案"点击切到哪一档"说的就是它的结果）。
         *
         * ⚠ **平台限制（实测）**：浏览器把 `Ctrl+T` 留给了"新标签页"，`preventDefault` 拦不住
         * ⇒ 网页版这一条按不动（`Ctrl+L` / `Ctrl+K` / `Ctrl+M` 浏览器里都能拦下）；
         * 桌面壳（WebView2 没有标签页 UI）**四条都可用**——含 Ctrl+T 在内已用真机 CDP 验过，见 E-2026-300。
         */
        ui.setThemeMode(nextThemeMode(ui.themeMode))
      } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        e.stopPropagation()
        // adj614（用户要求）：Ctrl+L = 折行开关（与顶栏「折行」按钮同一个 store 字段）
        ui.setAutoWrap(!ui.autoWrap)
      } else if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        // adj614（用户要求）：Ctrl+K = 输入条开关（与顶栏「输入条」按钮同一个 store 字段）
        ui.setShowScriptPad(!ui.showScriptPad)
      } else if (e.ctrlKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        e.stopPropagation()
        /**
         * adj614（用户要求）：**Ctrl+M = 视图循环**（编码 → 拆分 → 左右拆分 → 预览 → 编码）。
         * 顺序与"下一个是谁"收敛在 `ui/viewCycle.ts`，与顶栏「视图」下拉**同一份**
         * （窄屏跳过「左右拆分」、`splitHE`/`splitH` 按 `splitHDir` 选方向，两处口径一致）。
         */
        st.setViewType(nextViewType(st.viewType, { narrow: ui.isNarrow, splitHDir: ui.splitHDir }))
      } else if (e.ctrlKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        e.stopPropagation()
        /**
         * adj616（用户要求）：**Ctrl+E = 排版开关**（排版辅助虚线；与顶栏「排版」按钮、
         * 菜单「排版」同一件事）——直接翻 `uiStore.showGuides` 这一个字段（顶栏那个按钮也是
         * 这么做的），不另建一份状态。
         */
        ui.setShowGuides(!ui.showGuides)
      } else if (e.ctrlKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        e.stopPropagation()
        // adj616（用户要求）：Ctrl+B = 工作区开关（与菜单「工作区」、底栏「工作区」页签同一条入口）
        ui.requestDockPanel('workspace')
      } else if (e.ctrlKey && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        e.stopPropagation()
        // adj616（用户要求）：Ctrl+I = 导入开关（与菜单「粘贴源码导入」、底栏「导入」页签同一条入口）
        ui.requestDockPanel('import')
      } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        /**
         * adj641（用户要求）：**Ctrl+F = 查找替换**。
         *
         * 用户口径："编辑区只有 Ctrl+F 搜索操作，还缺少一个替换操作……在底栏 dock 里增加一个查找替换页签，
         * 将查找和替换进行整合"。此前 Ctrl+F 落在**浏览器原生查找**上（只查、不能替换，也只在网页版有）。
         * 这里把它接管到应用自己的「查找替换」面板：
         *  · `preventDefault` 挡掉原生查找条（否则两条查找并存、各说各的）；
         *  · 走 `ui.requestFind()` 而**不是** `requestDockPanel('find')`——后者是开关语义，
         *    连按会把底栏收起来；查找键应当是"回到查找框"（见 uiStore 里 `findFocus` 的说明）。
         *
         * adj642（用户要求"编辑区选中的文本自动成为查找框的内容，并完成查找，同时高亮…"）：
         * 有选区时把**选中文本**当查找内容一起带进去（`seedQueryFromSelection` 是纯函数，冒烟有断言）；
         * 没选区就只聚焦、保持上次的查找内容不动（避免把用户刚查的内容洗掉）。
         */
        ui.requestFind(seedQueryFromSelection(st.code, st.sel))
      } else if (e.ctrlKey && (e.code === 'Backquote' || e.key === '`' || e.key === '~')) {
        e.preventDefault()
        e.stopPropagation()
        /**
         * adj618（用户要求）：**`Ctrl+`` = 告警开关**——与底栏「告警」页签、状态栏里那条告警文本按钮
         * 共用同一条入口。按 Shift 的那一档（`Ctrl+~`）**同样走告警**（同一个物理键，不给它留死键）。
         *
         * 用 `e.code === 'Backquote'`（物理键）而不是只看 `e.key`：这个键在中文/其它布局下
         * 产出的字符各不相同，认物理键才不会"换个输入法就按不动"。
         *
         * （原先 `Ctrl+~` 兼作"快捷键速查"，adj619c 起速查改成 `Alt+F1`，见下一条分支。）
         */
        ui.requestDockPanel('problems')
      } else if (e.altKey && e.key === 'F1') {
        e.preventDefault()
        e.stopPropagation()
        /**
         * adj619c（用户要求）：**`Alt+F1` = 快捷键速查**（用户口径"快捷键速查改为 Alt+F1"）。
         * 与菜单「快捷键速查(&K)…」共用同一个 `openModal('shortcuts')`。
         */
        ui.openModal('shortcuts')
      } else if (e.ctrlKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        e.stopPropagation()
        /**
         * adj610（用户要求）：**Ctrl+D = 底栏展开 / 收起**。
         *
         * 展开走 `ui.expandDock()`（**唯一实现**，含 adj591「有告警先切到告警页签」的口径），
         * 收起就是 `closeDock()`——与左下角「展开底栏」按钮 / 页签栏「收起底栏」按钮**完全同路**，
         * 不会出现"按快捷键打开看到的页签与点按钮不一样"。
         *
         * ⚠ 与 Ctrl+N/Ctrl+T 不同：Ctrl+D（书签）与 Ctrl+H（历史）**在浏览器里可以被
         * `preventDefault()` 拦下**，所以网页版里这两条也能用（Ctrl+N 在 Chrome 里拦不住）。
         */
        if (ui.dockOpen) ui.closeDock()
        else ui.expandDock(summarizeProblems(st.parseResult.errors).total > 0)
      } else if (e.ctrlKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        e.stopPropagation()
        /**
         * adj610（用户要求）：**Ctrl+H = 按一下底栏高度档位按钮**（建议 → 最大 → 建议 → 最小 → …）。
         *
         * 档位状态在 `ToolDock` 内部，所以这里只发一次性请求（`requestDockSizeStep`），
         * 由它执行自己的 `cycleDockHeight()`——与点按钮走的是同一条代码。
         * 底栏**没展开时那个按钮不存在** ⇒ 先按「展开底栏」同一条路展开（建议高度），
         * 让这个键不会"按了没反应"。
         */
        if (ui.dockOpen) ui.requestDockSizeStep()
        else ui.expandDock(summarizeProblems(st.parseResult.errors).total > 0)
      } else if (e.key === 'Tab' && !ui.modal && !(e.target as HTMLElement | null)?.closest?.('.editor-main')) {
        // 编辑器内 Tab 留给自动补全/默认行为（completion 时补全），其余区域切换视图
        e.preventDefault()
        e.stopPropagation()
        st.setViewType(st.viewType === 'preview' ? 'split' : 'preview')
      } else if (e.key === 'Escape' && ui.modal) {
        /**
         * adj612：关对话框时**标记"这个 ESC 我用掉了"**——底栏那侧的全局 ESC（最小化底栏）挂在
         * **window 冒泡**阶段，而本 handler 是**捕获**阶段（先跑）：此刻 `ui.modal` 已被置空，
         * 底栏那边再读 state 就看不到"刚才有对话框"，`preventDefault` 是唯一可靠的交接方式。
         */
        e.preventDefault()
        ui.closeModal()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // 拆分视图：拖动分隔条调整窗格占比（adj46 上下；adj315 左右）。
  // dir='v' 上下（分隔条在上/下窗格间，按高度占比）；dir='h' 左右（按宽度占比）。
  // 上下/左右共用同一 splitPct（"第一个窗格"占比）。
  // adj487：改用 Pointer Events（见 ui/dragGesture）——此前只监听 mousemove/mouseup，手机上拖不动。
  const startSplitDrag = (dir: 'v' | 'h') => (e: React.PointerEvent) => {
    const main = mainRef.current
    if (!main) return
    const rect = main.getBoundingClientRect()
    const size = dir === 'v' ? rect.height : rect.width
    if (size <= 0) return
    const startPct = splitPct
    beginDrag(e, {
      onMove: (dx, dy) => setSplitPct(startPct + ((dir === 'v' ? dy : dx) / size) * 100),
    })
  }

  // 左右拆分布局（adj315）：方位由全局设置 splitHDir 决定
  // （previewLeft=左预览右编辑 / editorLeft=左编辑右预览）。
  // 改 splitHDir 后立即生效（renderSplitH 响应式读 uiStore）。
  const isSplitHView = viewType === 'splitH' || viewType === 'splitHE'
  const previewOnLeft = splitHDir !== 'editorLeft'

  /**
   * adj552（用户要求）：**宽屏左右拆分时，底栏 dock 是"编辑区的底栏"**——只占编辑那一侧，
   * 布局成为「左：预览（通高） | 右：上编辑 / 下底栏」。
   *
   * ⚠️ **窄屏模式不变**（用户明确要求）：上下拆分 / 纯编辑 / 纯预览这三种视图里，
   * 底栏仍在**窗口底部**（原行为，整幅宽度），不受本次改动影响。
   * （窄屏走的是 `split`；`splitH/splitHE` 只在宽屏成立。）
   *
   * ⚠️ 必须**包一层列容器** `.editor-col`：`.split-pane-h` 是 `flex-direction: row`
   * （左右两栏就靠它），直接把编辑区和底栏并列进去会变成**横向**排、底栏被挤成 0 宽（实测 x=1280,w=0）。
   *
   * 为什么必须放进列里（而不是给整幅底栏加左右偏移）：预览那一列要**通高到底**——
   * 若底栏仍是整幅宽度、只把右侧让出来，预览列下方会留一块空白，两列高度关系就断了。
   */
  const editorWithDock = (
    <div className="editor-col">
      <EditorPane />
      <ToolDock />
    </div>
  )
  const renderSplitH = () => (
    <>
      <div className="split-pane split-pane-h" style={{ flex: `0 0 ${splitPct}%` }}>
        {previewOnLeft ? <PreviewPane /> : editorWithDock}
      </div>
      <div className="split-divider split-divider-h" onPointerDown={startSplitDrag('h')} title="拖动调整左右窗格宽度" />
      <div className="split-pane split-pane-h">
        {previewOnLeft ? editorWithDock : <PreviewPane />}
      </div>
    </>
  )

  /**
   * adj483：主题/浅色模式的 `data-theme` / `data-mode` 同步到 **`<html>`** 上。
   *
   * 为什么必须挂到 html：主题变量（`styles/theme.css` 的 `[data-theme]`/`[data-mode='light']`）是
   * **按属性选择器**生效的，而 `index.css` 里 `body { color: var(--jp-text-primary) }` 是在 `body`
   * 处**求值**的——属性此前挂在 `.app`（body 的子元素）上，于是 body 只能拿到 `:root` 的**深色**默认值，
   * 所有"没有显式设色"的文本（如音色库的库名 span）在**浅色主题**下继承到深色主题的浅字 ⇒ 白底浅字看不清
   * （用户报「通用音源（GeneralUser GS）在浅色主题下与背景过近」）。
   * 挂到 `html` 后，`:root` 与主题属性落在同一元素上、变量从根上就是对的（浅色块在后，同特异性后者胜）。
   * `.app` 上的属性保留：个别样式/嵌入方可能仍按 `.app[data-mode]` 取用。
   */
  useEffect(() => {
    const el = document.documentElement
    el.setAttribute('data-theme', theme)
    el.setAttribute('data-mode', effectiveMode)
    // adj1000：深色预览柔化档位（`styles/theme.css` 的 `[data-soften]` 规则消费它）
    el.setAttribute('data-soften', previewSoften)
  }, [theme, effectiveMode, previewSoften])

  return (
    <div className="app" data-theme={theme} data-mode={effectiveMode} data-soften={previewSoften}>
      <TopBar />
      <div className={`app-main${isSplitHView ? ' app-main-h' : ''}`} ref={mainRef}>
        {viewType === 'code' && <EditorPane />}
        {viewType === 'preview' && <PreviewPane />}
        {viewType === 'split' && (
          <>
            <div className="split-pane" style={{ flex: `0 0 ${splitPct}%` }}>
              <PreviewPane />
            </div>
            <div className="split-divider" onPointerDown={startSplitDrag('v')} title="拖动调整上下窗格高度" />
            <div className="split-pane">
              <EditorPane />
            </div>
          </>
        )}
        {/* adj552：**只有**宽屏左右拆分把底栏放进编辑列（见 editorWithDock） */}
        {(viewType === 'splitH' || viewType === 'splitHE') && renderSplitH()}
      </div>
      {/* adj462/adj552：底部 dock（告警/试听/导出/设置 共用一个 dock，同一时间只显示一块）。
          **窄屏及非左右拆分的视图保持原样**：底栏仍在窗口底部、整幅宽度。 */}
      {!isSplitHView && <ToolDock />}
      <EditorFootBar />
      <Toast />
      {/* adj724b：需要用户二选一的确认条（嵌入版"文件已被外部修改"） */}
      <ConfirmBar />
      {/* adj968：把 .jps 拖进窗口时的"松开即打开"高亮层（桌面壳由原生拖放事件驱动） */}
      <DropOverlay />
      {/* adj379：检测到 SW 新版本时的「点击刷新」提示 */}
      <UpdatePrompt />

      {modal === 'samples' && <Suspense fallback={null}><SamplesDialog /></Suspense>}
      {modal === 'shortcuts' && <Suspense fallback={null}><ShortcutsDialog /></Suspense>}
      {modal === 'manual' && <Suspense fallback={null}><DocDialog kind="manual" /></Suspense>}
      {modal === 'syntax' && <Suspense fallback={null}><DocDialog kind="syntax" /></Suspense>}
      {/* adj957（用户裁定）：命令行手册与另外两本同路 —— 应用内渲染，不再依赖随包 MD */}
      {modal === 'cli' && <Suspense fallback={null}><DocDialog kind="cli" /></Suspense>}
      {modal === 'donate' && <Suspense fallback={null}><DonateDialog /></Suspense>}
      {/* adj562：「粘贴源码导入」已迁入底栏「导入」页签（原 adj406 的弹窗入口下线） */}
      {/* adj509：试听音色选择对话框（音色库「指定音色」按钮触发） */}
      {modal === 'voicePicker' && <Suspense fallback={null}><VoicePickerDialog /></Suspense>}
      {modal === 'saveAs' && <Suspense fallback={null}><SaveAsDialog /></Suspense>}
      {/* adj1074：自定义卡片风格（相机位「自定义…」触发） */}
      {modal === 'cardStyle' && <Suspense fallback={null}><CardStyleDialog /></Suspense>}
      {/* adj1119：对拍台（独立台面） */}
      {modal === 'sync' && <Suspense fallback={null}><SyncDialog /></Suspense>}
      {/* adj928：两栏源码差异框（确认条 → 「查看差异」；左本地 / 右外部，可直接做决定） */}
      {fileDiff && <Suspense fallback={null}><FileDiffDialog /></Suspense>}
    </div>
  )
}

export default App
