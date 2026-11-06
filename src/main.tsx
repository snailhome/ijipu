import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { trackAppVisit } from './analytics/trackVisit'
import './index.css'
/**
 * adj810（方案 B / B3）：**嵌入版侧的入站 RPC** —— 只被 Obsidian 嵌入时生效（`window.parent !== window` ✓）。
 * 依赖用引擎**直算**（`renderSvg` = parse→layout→SVG ✓；`exportMidi` = 播放序列→MIDI ✓）：
 * 这样不必依赖 store，且在"还没有打开任何谱"时也能应答 ✓。
 * ⚠ 与 GUI 导出的差别：这里没走 canvas 实测角标墨迹 ⇒ 与 CLI 同口径（**估算宽**，亚像素差异 ✓）。
 */
import { installObsidianBridge } from './ipc/obsidianBridge'
import {
  parseJps,
  splitParseIssues,
  layoutScore,
  renderScoreToSvg,
  buildPlaySequence,
  eventsToMidi,
  mergeJpsConfig,
  defaultPageConfig,
  type PageConfig,
} from '@ijipu/engine'
import { UPDATE_CHECK_INTERVAL_MS, shouldPromptUpdate } from './pwa/swUpdate'
import { APP_VERSION_FULL } from './brand/version'
// adj927/adj928：外部改动提示与差异框的文案（不再笼统说"外部变更"）
import { externalChangeCopy } from './brand/copy'
// adj927：外部改动的判据与基准（纯模块：无 DOM/存储依赖）
//  · `getBaseline` 给下面的排错探针用（排"又提示外部变更"时必须一眼看到"应用手里的基准"）；
//  · `probeExternalChange` / `baselineKeyOf` 给 `fileChanged` 用；
//  · adj966f：`getBaselineText` 取"共同祖先原文"，给三路合并（`planMerge`）当 `base`。
// 一律**静态**引入（既静态又动态 import 会让打包器报 INEFFECTIVE_DYNAMIC_IMPORT）。
import { getBaseline, getBaselineText, probeExternalChange, baselineKeyOf } from './store/externalChange'
// adj966f：三路合并的纯函数（块级采纳 / 自动合并）——提示条文案与「应用」按钮都要它
import { applyMergePlan, planMerge } from './diff/merge'
import { installAppHeight } from './pwa/appHeight'
// adj954：运行环境判定收敛到 `brand/env.ts` 唯一出处 —— 本文件原先自己写了两份
//（`isTauriDesktop` / `isEmbeddedFrame`），与 brand、playback、preview 里那几份是同一个判据。
import { isHostFrame, isTauriShell } from './brand/env'

// adj404：应用高度跟随可视视口——软键盘弹出时（浏览器/PWA/自建外壳）编辑区自动让位，
// 不再被键盘盖住（`.app { height: var(--app-h, 100dvh) }`，见 index.css）
installAppHeight()

/**
 * adj724b（用户实测）：「嵌入版 iJipu 深浅主题设置没有记住」。
 *
 * 根因：这里原先**无条件**调 `setThemeMode(宿主主题)`——
 *  · 用户自己选过深/浅，每次启动都被盖掉；
 *  · 更糟的是 `setThemeMode` 会**写进存储** ⇒ 这个覆盖值被当成"用户的选择"持久化。
 *
 * 正确做法：**不碰用户的 `themeMode`**，而是把 Obsidian 的深浅当成"系统深浅"喂给
 * `setSystemLight()` —— 应用本来就有这个语义（`effectiveMode = themeMode === 'auto' ? systemLight : themeMode`）。
 * 于是：
 *  · 用户选「跟随系统（auto）」 ⇒ 跟随 Obsidian 的深浅（这正是"跟随 Obsidian 主题"该有的行为）；
 *  · 用户**显式**选了浅/深 ⇒ 那是他的选择，宿主不再覆盖它。
 *
 * 插件设置里关掉「跟随 Obsidian 主题」时（`followTheme === false`）**完全不动**应用的深浅相关状态。
 */
function applyHostTheme(
  ui: {
    getState: () => {
      setSystemLight?: (b: boolean) => void
      setThemeMode?: (m: 'dark' | 'light') => void
    }
  },
  bridge: { welcome: { theme: 'dark' | 'light'; followTheme?: boolean } },
  mode?: 'dark' | 'light',
): void {
  if (bridge.welcome.followTheme === false) return
  const dark = (mode ?? bridge.welcome.theme) === 'dark'
  ui.getState().setSystemLight?.(!dark)
}

/**
 * adj724b：**首屏前先完成"嵌入版握手 + 偏好预载"**。
 *
 * 为什么必须串行、且必须在**求值 store 模块之前**：
 *  · `uiStore` / `editorPrefs` 在**模块求值阶段**就读 `localStorage`
 *    （主题、缩放、拆分比例、音色库选择…）；而 store 模块由 `App.tsx` 的 import 链带进来
 *    ——只要 `App` 还是静态 import，就会在我们拿到宿主数据之前先跑一遍，
 *    于是那份"空快照"会被当成用户设置、还可能把默认值回写覆盖掉真值（用户实测 bug 的放大版）。
 *  · 所以：握手 → 预载 → **再**动态 import store 与 App → 渲染。真正嵌入时这只是本机
 *    回环的两次往返（毫秒级）；非嵌入（`window.parent === window`）时握手直接返回 `null`，零开销。
 */
/**
 * ⚠⚠ adj857（**真正的修法** ✓，别再往下移 ✗）：
 * 上一版我以为放在"模块顶层"就够了 ✗ —— 但从下面这行 `void (async () => {` 起到文件末尾是
 * **一整段 async IIFE**，启动日志与我的安装调用**都在这段 IIFE 里面** ✗ ⇒
 * 安装仍排在 `await initHostBridge()` / `await preloadEmbedStorage()` 等**await 之后** ✓
 * ⇒ 链上有一步不返回/时序不对，安装就永远轮不到 ✗（现象：启动日志有 ✓、`bridge-installed` 没有 ✗）。
 * ⇒ **必须在进入 async IIFE 之前调用** ✓（就是这一行 ✓）。
 */
void (async () => {
  /**
   * adj724b：**启动横幅**。
   *
   * 为什么需要：多轮"改了没生效"里，我**无法排除"测的是旧产物"**这个可能——
   * 日志里没有任何版本指纹。加上这行后，一眼就能确认跑的是哪一版嵌入版
   * （`BUILD_STAMP` 是构建期生成的时间戳+commit，见 `src/gen/buildInfo.ts`）。
   */
  console.info(
    `[iJipu] 嵌入版启动 ${APP_VERSION_FULL}` +
      `${window.parent !== window ? '（宿主内）' : '（独立页）'}`,
  )
  /**
   * adj1084：命令行 `ijipu cli render -t mp4` 起的**隐藏出片窗口**。
   *
   * 判据在 Rust 那边（有没有 `--cli-video-job`）：`cli_video_job` 回 `null` 就是普通启动，
   * 本段零开销、照旧进界面；有任务就不渲染 App，跑完出片直接退出（用户只看到命令行）。
   *
   * 必须排在最前面：后面那串 `await initHostBridge()` 是给 Obsidian 嵌入版用的，
   * 命令行窗口不嵌在任何宿主里，不该为它等一步。
   */
  if (isTauriShell()) {
    /**
     * 先问一句"有没有出片任务"，再决定要不要动态加载出片模块。
     *
     * 为什么不在 `runCliVideoJob` 里问：失败处理需要知道"这到底是不是出片窗口"——
     * 是的话，任何异常都必须**回报给父进程**（否则命令行会一直等，用户只看到卡住）；
     * 不是的话，异常只该是一条警告，界面照常启动。
     */
    let jobText: string | null = null
    try {
      const { tauriCore } = await import('./brand/env')
      jobText = ((await tauriCore()?.invoke?.('cli_video_job')) as string | null) ?? null
    } catch {
      jobText = null
    }
    if (jobText !== null && jobText !== '') {
      try {
        const { runCliVideoJob } = await import('./export/video/cliWorker')
        await runCliVideoJob(jobText)
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        console.error('[iJipu] 命令行出片失败：', e)
        try {
          const { tauriCore } = await import('./brand/env')
          await tauriCore()?.invoke?.('cli_video_result', { ok: false, bytes: 0, audio: false, message: `出片窗口启动失败：${msg}` })
        } catch {
          /* 连回报都失败：父进程会在"首次响应"超时里报错 */
        }
      }
      return
    }
  }
  /**
   * adj1085：**桌面壳的本机配置**（`%APPDATA%\iJipu\settings.json`）。
   *
   * 必须排在任何 store 模块求值之前：`uiStore` / `docStore` 在模块顶层就会读主题、缩放、草稿。
   * 这里只做"读文件 + 替换 localStorage 门面"，失败就退回浏览器存储，绝不挡启动。
   * （命令行出片窗口在上面已经 return，不会走到这里 —— 它是第二个进程，不该写配置。）
   */
  if (isTauriShell()) {
    try {
      const { preloadDesktopPrefs } = await import('./store/prefs')
      await preloadDesktopPrefs()
    } catch (e) {
      console.warn('[iJipu] 本机配置未接管，继续使用浏览器存储：', e)
    }
  }
  let bridge: Awaited<ReturnType<typeof import('./store/hostBridge').initHostBridge>> = null
  try {
    const { initHostBridge } = await import('./store/hostBridge')
    bridge = await initHostBridge()
    if (bridge) {
      const { preloadEmbedStorage } = await import('./store/embedStorage')
      await preloadEmbedStorage()
    }
  } catch (e) {
    // 不是嵌入环境、或宿主不可用：照旧走 fsa/path 后端
    console.warn('[iJipu] 宿主桥初始化失败：', e)
  }

  // adj1085：卡片背景图外置（旧的 data URL 在这里迁成 `ijipu-blob:`，必须早于 uiStore 求值）
  try {
    const { migrateInlineCardImageInLocalStorage } = await import('./store/cardImageStore')
    await migrateInlineCardImageInLocalStorage()
  } catch (e) {
    console.warn('[iJipu] 卡片背景图迁移未完成（保留原样）：', e)
  }
  // 存储就绪后才求值 store 模块（见上面的说明）
  const { syncEthnicVoicesToEngine } = await import('./store/uiStore')
  /**
   * adj1028：把「民族乐器（拟）」的勾选交给引擎 —— **只在这里做一次**。
   * 放在 store 模块里做模块级副作用会连带影响单测/CLI（它们的 localStorage 是桩），
   * 已在 smoke 里踩过一次；入口处调用，宿主边界才清楚。
   */
  syncEthnicVoicesToEngine()
  /**
   * adj965（方案「OVL」，EP-10）：装配**图片通道**与**解码器**。
   *
   * · 放在 `initHostBridge()` **之后**：宿主形态（`isHostEmbedded()`）此时才确定；
   * · 桌面端用默认的 Rust 通道（`read_asset_file` / `ws_read_binary`）；嵌入版那条宿主桥
   *   等 EP-09 接（届时它会**后装**并覆盖这里 ⇒ `setAssetReader` 是"后装者生效"）；
   *   纯网页版暂时没有通道 ⇒ 图片字段会给出**明确提示**（不静默少画一层）。
   */
  {
    const { installAssetReader, installAssetDecoder } = await import('./store/overlayAssets')
    const { isHostEmbedded } = await import('./store/hostBridge')
    const { isTauriShell } = await import('./brand/env')
    if (bridge !== null || isHostEmbedded()) {
      // 嵌入版（Obsidian）：走**宿主桥的 readAsset op**（EP-09）——相对本谱的路径 = vault 里的路径、
      // `[[双链]]` 交给宿主的链接解析；越界/非图片/超限由宿主明确报错
      const { vaultAssetReader } = await import('./store/assetReaderVault')
      installAssetReader(vaultAssetReader)
    } else if (isTauriShell()) {
      // 桌面端：Rust 的 `read_asset_file`（绝对路径）/ `ws_read_binary`（工作区相对路径）
      installAssetReader()
    } else {
      // **网页版：工作区目录句柄**（EP-14）——没有它，`npm run dev` 里图片永远不显示
      const { fsaAssetReader } = await import('./store/assetReaderFsa')
      installAssetReader(fsaAssetReader)
    }
    installAssetDecoder()
  }
  const { default: App } = await import('./App.tsx')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  trackAppVisit()

  /**
   * adj1010：音色库注册表的**一次性迁移**（v1 的"只有字节" → v2 的元数据表）。
   *
   * 为什么放在 `render()` **之后**、且不 await：迁移要读（并可能搬）一份 32–141 MB 的音源，
   * 挡在首屏前面会让"升级后第一次启动"明显变慢。而试听是用户点击后才发生，
   * 迁移在几百毫秒内就跑完了，实际不会撞上。
   * 失败只记日志、绝不阻断启动（没有音源最多是没声音，不能连编辑器都进不去）。
   */
  void (async () => {
    try {
      const { ensureBankRegistry } = await import('./playback/bankRegistry')
      const r = await ensureBankRegistry()
      if (r.ran) {
        console.info(`[iJipu] 音色库迁移完成：搬键 ${r.moved.length} 个、登记 ${r.records} 个库`)
      }
    } catch (e) {
      console.warn('[iJipu] 音色库迁移失败（不影响启动）：', e)
    }
  })()

  if (!bridge) return
  try {
    const { setWorkspace, makeVaultWorkspaceRecord, isVaultWorkspace, getWorkspace } = await import('./store/workspace')
    const { useUiStore } = await import('./store/uiStore')
    const rec = makeVaultWorkspaceRecord(bridge.welcome.vaultName, bridge.welcome.root)
    // 已有同源工作区且是 vault 后端 ⇒ 不重复设置（避免刷掉用户当前所在目录）
    const cur = await getWorkspace()
    if (!(cur && isVaultWorkspace(cur))) await setWorkspace(rec)
    // 跟随 Obsidian 主题 ⇒ 把它的深浅喂给应用的 `systemLight`（走应用自己的 auto 语义）
    applyHostTheme(useUiStore, bridge)
    bridge.on({
      theme: (mode) => applyHostTheme(useUiStore, bridge, mode),
      /**
       * 宿主推来"要打开的文件"（双击 `.jps` 时）。
       *
       * 传的是**工作区相对路径**（宿主已按工作区根换算好）⇒ 直接切段交给
       * `openWorkspaceFile`（它收 `string[]`，相对当前工作区根）。
       */
      openFile: (path) => {
        void (async () => {
          /**
           * adj724b（用户实测）：**先立"宿主即将推文件"的标记，再打开**。
           *
           * 不立标记的话，`docStore` 那条"启动时自动恢复上次绑定"（模块加载时就开始跑）
           * 会与这次打开**竞争**——谁后到谁赢，表现为「我点了 A，界面显示的是上一次那份 B」。
           */
          const { notifyHostWillOpenFile } = await import('./store/hostBridge')
          const release = notifyHostWillOpenFile()
          const { useDocStore } = await import('./store/docStore')
          const segs = path.split('/').filter((s) => s !== '')
          if (segs.length === 0) {
            release()
            return
          }
          console.info(`[iJipu] 宿主推来文件，开始打开：${path}`)
          const ok = await useDocStore.getState().openWorkspaceFile(segs)
          console.info(`[iJipu] 宿主推来的文件打开${ok ? '成功' : '失败'}：${path}`)
          release()
        })()
      },
      /**
       * adj728（用户要求）：**宿主让应用直接打开「设置 → 音色库」**。
       *
       * 用于插件侧那条"试听失败"的提示——它的按钮要能把用户送到能**手动导入音源**的地方
       * （自动下载在部分网络下不可达，唯一出路就是自己下、再导入）。
       */
      openSoundbankSettings: () => {
        void (async () => {
          const { useUiStore } = await import('./store/uiStore')
          useUiStore.getState().openSettings('soundbank')
        })()
      },
      /**
       * adj724b/adj927（用户口径 2026-10）：**检测 `.jps` 的内容被别处改了**，
       * 并让用户选「载入外部 / 保留本地」。
       *
       * ## 为什么不能拿"磁盘内容 vs 当前缓冲区"比（旧写法的假提示根因）
       *
       * 嵌入版是**随输随存**：编辑 400ms 后写回文库（`docStore.scheduleEmbedAutosave`），
       * 这次写盘也会让 Obsidian 触发 `modify` ⇒ 插件把 `fileChanged` 推回来。旧写法在这里拿
       * `disk === st.code`（`st.code` = **当前编辑器缓冲区**）判断"是不是我们自己写的"，
       * 可缓冲区**每敲一个字都在变**，而宿主推来的事件不是零延迟 ⇒ 事件一到，
       * 缓冲区早就不是我们刚写下去的那份了 ⇒ **假提示**（用户报的"经常提示外部变更"）。
       *
       * ## 新口径（adj927）
       *
       * 参照物换成**基准**（`store/externalChange.ts`：我们最后一次写出去/读进来的内容指纹 + mtime）：
       *  ① mtime 一模一样 ⇒ 直接判"没变"（不读文件）；
       *  ② mtime 不同（或拿不到）⇒ 读一次内容比指纹 ⇒ **内容真变了才提示**；一样就静默刷新基准。
       *
       * ⚠ 嵌入版宿主目前只在事件里带 `path`（不带 mtime，见 `hostBridge.ts` 的 `HostEvents`），
       * 所以这里 `mtimeOf: null` ⇒ 实际走第②段（一次本地回环读，短谱毫秒级）。
       * 将来宿主把 mtime 一起推来，把 `mtimeOf` 换成"取宿主给的 mtime"即可自动启用快筛。
       *
       * ## adj943（用户实报：弹条说"变了"、差异框说"改动 0 处"）
       *
       * adj927 的基准只在"写盘**成功结算之后**"刷新，而宿主在 `adapter.write` 落地时就广播
       * `fileChanged` ⇒ "文件已落地、基准还没跟上"这段窗口里，事件读到的正是**我们自己刚写下去
       * 的那份**，于是弹了条；而差异框比的是「本地缓冲区 vs 文件」⇒ 两边逐字相同 ⇒ "改动 0 处"。
       * ⇒ 口径改成：与**我们手里的内容**（基准 / 在途写 / **本地缓冲区**）归一化后任一同，
       * 就静默刷新基准、永不弹条（详见 `store/externalChange.ts` 文件头）。
       * `localText` 与差异框的 `diff.localText` **是同一个来源**（都是为了"两处同一套判据"）。
       */
      fileChanged: (path) => {
        void (async () => {
          const segs = path.split('/').filter((s) => s !== '')
          if (segs.length === 0) return
          const { useDocStore } = await import('./store/docStore')
          const { readWorkspaceText, getWorkspace } = await import('./store/workspace')
          const st = useDocStore.getState()
          // 只关心"当前正在编辑的这个文件"
          const bind = st.binding
          if (!bind || bind.segs.join('/') !== segs.join('/')) return
          const ws = await getWorkspace()
          if (!ws) return
          let verdict: Awaited<ReturnType<typeof probeExternalChange>>
          try {
            verdict = await probeExternalChange({
              key: baselineKeyOf(ws.id, segs),
              /**
               * 本地内容**按取值函数传**（不是事件那一刻的快照）：事件与判定之间用户可能还在敲字，
               * 判定要用此刻的内容；且与差异框（`diff.localText`）取的是**同一处**。
               */
              localText: () => useDocStore.getState().code,
              mtimeOf: null, // 宿主不回传 mtime ⇒ 走内容判据（见上面的说明）
              readText: () => readWorkspaceText(ws, segs),
            })
          } catch {
            return // 读不到（刚被删/被移走等）交给其它路径处理，这里不打扰
          }
          if (verdict.kind !== 'external') return
          const name = segs[segs.length - 1]
          const key = baselineKeyOf(ws.id, segs)
          // adj966：提示与差异框**只有一处实现**（`askLoadExternalChange`），宿主事件与轮询共用
          askLoadExternalChange(
            name,
            verdict.externalText,
            // adj966f：共同祖先 = 基准里留下的原文（换文件即对不上 ⇒ 退化为逐块采纳）
            getBaselineText(key),
            () => {
              // 用文件里的内容替换当前文档（仍走 store 的打开逻辑，历史会记一步，可撤销）
              void useDocStore.getState().openWorkspaceFile(segs)
            },
            // 保留本地 ⇒ 立刻写回原文件（写回成功即刷新基准，提示随之停止；用户口径见 `askLoadExternalChange`）
            () => void useDocStore.getState().saveFile(),
          )
        })()
      },
    })
    // 监听已就绪 ⇒ 告诉宿主可以下发"本页签要打开的文件"了
    bridge.signalReady()
    /**
     * **预热一次文库根目录**。
     *
     * 为什么需要：底栏默认是收起的（`dockOpen:false` / `dockPanel:'problems'`），
     * 而列目录只发生在"工作区面板被画出来"的时候 ⇒ 嵌入版刚打开时**一次桥调用都不会发生**，
     * 用户点开「工作区」才现拉（还会先闪一下空列表）。
     * 这里主动拉一次，既让文件树/整树搜索立刻可用，也给"桥是否真的通了"留下可验证的痕迹。
     *
     * 失败**不影响**其它功能（面板打开时会自己再拉一次），故只在控制台留痕。
     */
    void (async () => {
      const { readDirEntries } = await import('./store/workspace')
      await readDirEntries(rec, [])
    })().catch((e) => console.warn('[iJipu] 预热文库目录失败：', e))
    /**
     * 排错探针：把"嵌入版是否生效"的关键状态挂到 window 上。
     *
     * 嵌入版失败时的表现是"页面能开、但显示的不是文库"，而控制台里往往什么都看不到
     * （初始化在动态 import 里，宿主侧也无从观察）⇒ 留一个可读探针，
     * 供自动化冒烟与真机排错直接读取（`scripts/embed-smoke.mjs` 用的就是它）。
     */
    ;(window as unknown as { __ijipuDebug?: () => string }).__ijipuDebug = () =>
      JSON.stringify({
        vaultName: bridge.welcome.vaultName,
        root: bridge.welcome.root,
        calls: bridge.callCount,
        lastOps: bridge.recentOps.slice(-8),
        // adj724b：深浅相关的现场（排错"设置没记住"时必须能看到）
        themeMode: localStorage.getItem('ijipu.themeMode'),
        hostTheme: bridge.welcome.theme,
        followTheme: bridge.welcome.followTheme,
        /**
         * adj927：**外部改动的基准**（内容指纹 + mtime）。
         *
         * 排"又提示外部变更了"这种问题时，必须能一眼看到"应用手里的基准"和"文件实际内容"
         * 到底谁对不上——只靠事件日志看不出是判据错了还是文件真变了。
         */
        baseline: getBaseline(),
      })
  } catch (e) {
    // 忽略：不是嵌入环境（或宿主不可用）时，走原有的 fsa/path 后端。
    // 但**要留痕**：嵌入版初始化失败会表现为"打开了但显示的不是文库"，
    // 静默吞掉会让排错无从下手（冒烟脚本也靠这条日志定位）。
    console.warn('[iJipu] 嵌入版初始化失败：', e)
  }
})()
/**
 * adj966：**冲突提示只有一处实现** —— 宿主事件（`fileChanged`）与轮询（`startExternalWatch`）共用它，
 * 将来加原生 notify 也走它。三端一致：文案 `externalChangeCopy` + 差异框 `FileDiffDialog`。
 *
 * adj966f（P1 块级采纳 + P2 自动三路合并，用户 2026-10-16 拍板）：
 *  · `baseText` = **共同祖先**（`externalChange.getBaselineText`，键对不上就是 `null`）；
 *    有它 ⇒ 差异框能判"两边改的是不是同一块"、能把互不重叠的块**自动合好**；
 *    没有 ⇒ 退化成二路逐块采纳（P1），照常可用；
 *  · **无冲突块时提示条换一句话**（用户口径："已自动合好（N 块互不重叠），点「应用」即用合并结果"），
 *    并直接给一个「应用」按钮 —— 合并结果此时是确定的，不必让用户先点查看差异再点应用两跳；
 *  · 应用 = `docStore.applyMergeResult`（写回文件 + 立刻保存 + 刷基准 + 一步历史）。
 */
function askLoadExternalChange(
  name: string,
  externalText: string,
  baseText: string | null,
  loadExternal: () => void,
  keepLocal: () => void,
): void {
  void (async () => {
    const { useUiStore } = await import('./store/uiStore')
    const { useDocStore } = await import('./store/docStore')
    // 提示条文案要"先跑一遍 planMerge"：有没有冲突块，决定了问法（也是 P2 的判据所在）
    const plan = planMerge(baseText, useDocStore.getState().code, externalText)
    const clean = plan.conflicts === 0 && plan.changeCount > 0
    /**
     * 「应用」按钮：**点击那一刻**再算一次（用户可能还在编辑器里敲字，用的是此刻的本地内容），
     * 选择全用默认（口径③"以本地为底"：只有外部一方改过的块用外部）。
     */
    const applyAuto = (): void => {
      const cur = useDocStore.getState()
      cur.applyMergeResult(applyMergePlan(planMerge(baseText, cur.code, externalText)), externalText)
    }
    /** 差异框底部「应用（并保存）」也走同一条收尾（用户逐块选完后按它） */
    const applyMerged = (merged: string): void =>
      useDocStore.getState().applyMergeResult(merged, externalText)
    useUiStore.getState().showAsk({
      text: clean ? externalChangeCopy.mergedAskText(name, plan.changeCount) : externalChangeCopy.askText(name),
      confirmLabel: externalChangeCopy.loadExternal,
      cancelLabel: externalChangeCopy.keepLocal,
      onConfirm: loadExternal,
      /**
       * adj966b（**用户实报**：「选了保留本地后一直提示」）：保留本地**不能只写日志** ——
       * 必须把"本地这份"落到文件上（写回成功即刷新基准）⇒ 下一轮轮询判"没变"，提示自然停 ✓。
       * 用户看过了差异、明确选了保留本地，此时**写回原文件正是他要的语义**（不是静默覆盖别人：
       * 提示里已写明"下次保存会写回文件"，这里只是把它立刻做掉）。
       * 写失败的兜底由轮询侧负责（同一份外部内容只提示一次，见 `externalChangeWatch.ts`）。
       */
      onCancel: () => {
        console.info('[iJipu] 保留本地修改：立刻写回原文件（覆盖外部改动）')
        keepLocal()
      },
      // adj928：多一个「查看差异」——本地内容**点开时再取**（用户可能还在编辑）
      diff: { name, baseText, localText: () => useDocStore.getState().code, externalText, onApplyMerge: applyMerged },
      // adj966f：无冲突块时多给一个「应用」（同样的收尾：关提示条 + 关差异框 + 落盘）
      extra: clean ? { label: externalChangeCopy.applyMergeShort, run: applyAuto } : undefined,
    })
  })()
}

/**
 * adj966：**外部改动轮询**（桌面壳 / 网页 / PWA）。
 *
 * 为什么需要：一份 `.jps` 被同步端改过之后，本端"编辑内容来自缓存"并不知道 ⇒ 下次保存会覆盖最新内容。
 * 插件端有宿主 `modify` 事件（能力档 `watch: 'event'`），桌面壳与网页端没有事件源 ⇒ **轮询**。
 *
 * 分工（判据都只有一处）：
 *  · 「查不查 / 什么档」→ `store/fileHost.ts` 的 `decideWatch`（按宿主能力降级；宿主事件档与受限档**不轮询**）；
 *  · 「变没变」→ `store/externalChange.ts` 的 `probeExternalChange`（基准指纹 + mtime 快筛）；
 *  · 本段只做**接线**：把三种绑定（FSA 句柄 / 原生路径 / 工作区）各自接到同一套 IO 形状上。
 */
void (async () => {
  /**
   * adj1085：**先等本机配置接管完**，再碰 store。
   *
   * 这个 IIFE 在模块求值时就启动（与上面的主 IIFE 并行），而它下面会 `import('./store/docStore')`
   * → docStore 静态 import 了 uiStore ⇒ uiStore 会在"读配置文件"的 IPC 还没回来时先求值，
   * 用浏览器 localStorage 的旧值把主题/缩放定死（实测：文件里是 dark、界面是 light，刷新才对）。
   */
  if (isTauriShell()) {
    const { prefsReady } = await import('./store/prefs')
    await prefsReady
  }
  try {
    const { getRuntimeEnv } = await import('./brand/env')
    const { hostProfile, decideWatch } = await import('./store/fileHost')
    const { startExternalWatch } = await import('./store/externalChangeWatch')
    const { useDocStore } = await import('./store/docStore')
    const { baselineKeyOf, bindingKeyOf, probeExternalChange, getWriteInFlight } = await import('./store/externalChange')
    const { readNativeProbe } = await import('./store/externalOpen')
    const { readWorkspaceText, getWorkspace } = await import('./store/workspace')
    const visible = (): boolean => document.visibilityState === 'visible'
    const fsa = typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function'
    const profile = hostProfile(getRuntimeEnv(), fsa)
    /**
     * adj966f：当前绑定对应的**基准键**（三种绑定各一档，与 `docStore` 记基准时同源）。
     *
     * 抽出来的理由：有两处必须用**同一把键** —— 轮询取 IO（`io()`）与提示时取"共同祖先原文"
     * （`getBaselineText(key)`）。各写一份就会漂（"一个判据两处实现"是本项目的老毛病）。
     */
    const keyOfState = (s: ReturnType<typeof useDocStore.getState>): string | null =>
      s.fileHandle
        ? bindingKeyOf({ kind: 'handle', name: s.fileName })
        : s.nativePath
          ? bindingKeyOf({ kind: 'native', path: s.nativePath })
          : s.binding && s.binding.segs.length > 0
            ? baselineKeyOf(s.binding.wsId, s.binding.segs)
            : null
    startExternalWatch({
      mode: () => decideWatch(profile, visible()),
      visible,
      hasBinding: () => {
        const s = useDocStore.getState()
        return !!(s.fileHandle || s.nativePath || (s.binding && s.binding.segs.length > 0))
      },
      io: () => {
        const s = useDocStore.getState()
        const key = keyOfState(s)
        if (!key) return null
        if (s.fileHandle) {
          const h = s.fileHandle
          return {
            key,
            mtimeOf: async () => (await h.getFile()).lastModified,
            readText: async () => (await h.getFile()).text(),
          }
        }
        if (s.nativePath) {
          const path = s.nativePath
          return {
            key,
            mtimeOf: async () => (await readNativeProbe(path)).mtimeMs,
            readText: async () => (await readNativeProbe(path)).text,
          }
        }
        const bind = s.binding
        if (bind && bind.segs.length > 0) {
          const segs = bind.segs
          return {
            key,
            mtimeOf: async () => null, // 宿主/工作区不回传 mtime ⇒ 走内容判据
            readText: async () => {
              const ws = await getWorkspace()
              if (!ws) throw new Error('没有工作区')
              return readWorkspaceText(ws, segs)
            },
          }
        }
        return null
      },
      localText: () => useDocStore.getState().code,
      // adj966c：写盘期间让路（避免读句柄把"原子替换"那段最慢的 commit 拖得更慢）
      paused: () => getWriteInFlight() !== null,
      onExternal: (externalText) => {
        const s = useDocStore.getState()
        const name = s.binding?.segs?.[s.binding.segs.length - 1] ?? `${s.fileName}.jps`
        const key = keyOfState(s)
        askLoadExternalChange(
          name,
          externalText,
          // adj966f：共同祖先 = 基准里留下的原文（拿不到就退化为逐块采纳）
          key ? getBaselineText(key) : null,
          () => {
            const cur = useDocStore.getState()
            if (cur.binding && cur.binding.segs.length > 0) void cur.openWorkspaceFile(cur.binding.segs)
            else void cur.openFile()
          },
          // 保留本地 ⇒ 立刻写回原文件（与宿主事件那条同口径，见 `askLoadExternalChange`）
          () => void useDocStore.getState().saveFile(),
        )
      },
      startInterval: (fn, ms) => {
        const t = window.setInterval(fn, ms)
        return () => window.clearInterval(t)
      },
      onVisible: (fn) => {
        /**
         * ⚠ 契约（见 `externalChangeWatch.ts`）：回调被调用时 `visible()` 必须已返回**新的**可见性。
         * `visibilitychange` 天然满足；`focus` 也满足（此刻页面已可见）。
         */
        const h = (): void => fn()
        document.addEventListener('visibilitychange', h)
        window.addEventListener('focus', h)
        return () => {
          document.removeEventListener('visibilitychange', h)
          window.removeEventListener('focus', h)
        }
      },
      probe: probeExternalChange,
    })
  } catch (e) {
    // 轮询起不来不该影响主流程（只留痕）
    console.warn('[iJipu] 外部改动轮询未启动：', e)
  }
})()

/**
 * adj443：**桌面端绝不注册 Service Worker，并主动注销 + 清缓存**。
 *
 * adj954：本节的两个环境判据（"是不是 Tauri 桌面端" / "是不是在宿主 iframe 里"）
 * 已收敛到 `brand/env.ts` 的 `isTauriShell()` / `isHostFrame()`，本文件不再自己读 `__TAURI__`。
 *
 * 问题（用户报）：PC 版重新安装后打开还是**旧界面**，要按 Ctrl+R 才更新 —— 普通用户会以为"没更新"。
 *
 * 根因：Tauri v2 在 Windows 用 `http(s)://tauri.localhost`，**是安全上下文、SW 能正常注册**
 * （原注释以为"自定义协议下注册会静默失败"，与实际不符）。于是重装后磁盘上虽是新 bundle，
 * **SW 仍从 Cache Storage 返回旧的 index.html / JS / CSS** ⇒ 界面停在旧版。
 *
 * 为什么桌面端不需要 SW：PWA 的离线能力是为**网页版**服务的；桌面端资源已随安装包落盘
 * （`tauri://localhost` 下本地读取），SW 只会带来"装了新版还显示旧界面"的陈旧缓存。
 *
 * 处理：① 桌面端**不注册**；② 若此前版本已注册过（老用户），**主动 unregister + 清空
 * cacheStorage + 重载一次**，把被污染的缓存一次性摘掉（否则老用户仍然看到旧界面）。
 */
/**
 * adj724b：是否运行在**宿主 iframe** 里（Obsidian 嵌入版 / 其它宿主嵌入）。
 *
 * 用途：iframe 里**不注册 Service Worker**——SW 的作用域是 origin（嵌入版是
 * `http://127.0.0.1:<port>`），而那个服务只为本次会话提供单文件页面，
 * 完全没有 `/sw.js`；更糟的是 SW 会跨会话存活，可能在下次打开时把页面搞坏。
 * PWA 的离线能力只对**独立网页版**有意义。
 *
 * adj954：函数体已收敛到 `brand/env.ts` 的 `isHostFrame()`（判据与注释都留在那边，避免两处漂移）。
 */

/**
 * ⚠⚠ adj859（**真正的根因与修法** ✓，别再改动这个位置 ✗）：
 * 我前几轮以为"放在模块顶层"就够了 ✗ —— 实际上那段 `installBridgeOnce` 被我插进了**下面的
 * Service Worker IIFE 里面** ✗，而那段 IIFE 的守卫是
 * `import.meta.env.PROD && 'serviceWorker' in navigator && !isHostFrame()` ✓
 * ⇒ **在嵌入版（iframe）里 `isHostFrame() === true` ⇒ 整段永不执行** ✗✓✓
 * （adj954：函数已改名并收敛到 `brand/env.ts`，判据一字未变）
 * ⇒ 这正好解释了两个铁证：① 服务端发的**确实是含桥的新产物**（插件侧 ② 自检 = 是 ✓）；
 * ② 嵌入版 Console 里**从来没有** `bridge-installed` 日志 ✗（那段代码根本不跑 ✓）。
 *
 * ⇒ 本函数与它的调用**必须在模块作用域**（SW 块之外 ✓、任何 IIFE 之外 ✓）。
 * 判断方法（本次教训 ✓）：改前先 `grep -n '^void (async\|^})()' src/main.tsx` 打印作用域地图 ✓，
 * 别靠目测 ✗（我因此白改了两次，均被 `tsc` 拦下 ✓）。
 */
// adj859：幂等标记（必须在**模块作用域** ✓）
let obsidianBridgeInstalled = false

function installBridgeOnce(): void {
  if (obsidianBridgeInstalled) return
  obsidianBridgeInstalled = true
  installObsidianBridge({
    renderSvg: (source, pageConfig, assets) => {
      const { errors } = splitParseIssues(parseJps(source))
      if (errors.length > 0) return { ok: false, svgs: [], error: `${errors.length} 个语法错误（先修好再渲染）` }
      const cfg = mergeJpsConfig(source, { ...defaultPageConfig, ...(pageConfig as Partial<PageConfig> | undefined) })
      return { ok: true, svgs: renderScoreToSvg(layoutScore(parseJps(source), cfg), assets === undefined ? undefined : { assets }) }
    },
    exportMidi: (source) => {
      const { errors } = splitParseIssues(parseJps(source))
      if (errors.length > 0) return { ok: false, error: `${errors.length} 个语法错误（先修好再导出）` }
      const parsed = parseJps(source)
      const layout = layoutScore(parsed, mergeJpsConfig(source, defaultPageConfig))
      const bytes = eventsToMidi(buildPlaySequence(parsed, layout, 60).events, { bpm: 60, title: 'iJipu' })
      return { ok: true, bytes }
    },
  })
  // adj854：ASCII 标记（中文会被打包转义 ⇒ 检索不到 ✗）
  console.info(`[iJipu] bridge-installed host=${window.parent !== window ? 'yes' : 'no'}`)
  console.info(`[iJipu] Obsidian 桥已安装${window.parent !== window ? '（宿主内 ✓）' : '（独立页：按设计空转 ✓）'}`)
}

// ⚠ 模块作用域调用 ✓（在 SW 块之外 ✓、在任何 async IIFE 之外 ✓）—— 这就是本 bug 的修法 ✓
installBridgeOnce()

if (import.meta.env.PROD && 'serviceWorker' in navigator && !isHostFrame()) {
  if (isTauriShell()) {
    // 老版本可能已注册过 SW：注销 + 清缓存 + 重载一次（仅在确有注册/缓存时重载，避免每次启动都刷新）
    void (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations()
        const names = 'caches' in window ? await caches.keys() : []
        if (regs.length === 0 && names.length === 0) return
        await Promise.all(regs.map((r) => r.unregister()))
        await Promise.all(names.map((n) => caches.delete(n)))
        // 只重载一次：用 sessionStorage 标记，避免"注销失败→无限刷新"
        if (sessionStorage.getItem('ijipu.swPurged') !== '1') {
          sessionStorage.setItem('ijipu.swPurged', '1')
          window.location.reload()
        }
      } catch {
        /* 忽略：注销失败也不影响本次会话（下次启动再试） */
      }
    })()
  } else {
    // 网页版 / PWA：注册 SW 以获得离线能力 + 新版接管提示
    /**
 * adj846（用户实测决定性证据：`render.svg 探针也不通` ⇒ 应用侧桥**根本没在应答** ✗）：
 *
 * 真因：`installObsidianBridge(...)` 原来挂在 **`window.load` 事件回调里** ✗ ——
 * 而嵌入版是**单文件内联 HTML**（`embed-emit` 产物 ✓），其模块可能在 `load` **之后**才执行 ⇒
 * 回调再也不会被调用 ⇒ 桥**永远装不上** ✓（于是所有请求都超时 ✓）。
 *
 * 修法：**在模块顶层直接安装** ✓ —— 它自带"只在被嵌入时生效"的守卫
 * （`window.parent !== window` ✓），且只做"挂一个 message 监听" ✓，无需等待任何资源 ✓。
 * ⚠ 不要再移回 `load` 回调里 ✗（这正是本 bug 的由来）。
 */
installObsidianBridge({
  renderSvg: (source, pageConfig, assets) => {
    const { errors } = splitParseIssues(parseJps(source))
    if (errors.length > 0) return { ok: false, svgs: [], error: `${errors.length} 个语法错误（先修好再渲染）` }
    const cfg = mergeJpsConfig(source, { ...defaultPageConfig, ...(pageConfig as Partial<PageConfig> | undefined) })
    return { ok: true, svgs: renderScoreToSvg(layoutScore(parseJps(source), cfg), assets === undefined ? undefined : { assets }) }
  },
  exportMidi: (source) => {
    const { errors } = splitParseIssues(parseJps(source))
    if (errors.length > 0) return { ok: false, error: `${errors.length} 个语法错误（先修好再导出）` }
    const parsed = parseJps(source)
    const layout = layoutScore(parsed, mergeJpsConfig(source, defaultPageConfig))
    const bytes = eventsToMidi(buildPlaySequence(parsed, layout, 60).events, { bpm: 60, title: 'iJipu' })
    return { ok: true, bytes }
  },
})

/** adj852：幂等标记 —— 安装只做一次（下面顶部与旧位置各留一个调用点也不重复挂监听 ✓） */
let obsidianBridgeInstalled = false

/**
 * adj852（**真正的根因** ✓，用户 Console 证据）：
 * 「嵌入版启动 v0.52.1（宿主内）」这行日志**打印了** ✓，但它后面紧跟着**一大段顶层 `await` 链**
 * （`initHostBridge()` / `preloadEmbedStorage()` … ✓），而 `installObsidianBridge(...)` 原来排在
 * 那条链**之后** ✗ ⇒ 只要链上有一步不返回/抛错/时序不对 ✓，安装就**永远轮不到** ✗
 * ⇒ 于是"自动 hello 从未到达"✓（而手动从 iframe 里发的 hello 能到达 ✓ ⇒ 通道本身没问题 ✓）。
 *
 * 修法：**在最前面安装** ✓（早于任何 await ✓），并打一行可见日志 ✓
 * ⇒ 从此 Console 里能直接看到"桥已安装"✓ / "没装"✗，不再靠推断 ✓。
 */
function installBridgeOnce(): void {
  if (obsidianBridgeInstalled) return
  obsidianBridgeInstalled = true
  installObsidianBridge({
    renderSvg: (source, pageConfig, assets) => {
      const { errors } = splitParseIssues(parseJps(source))
      if (errors.length > 0) return { ok: false, svgs: [], error: `${errors.length} 个语法错误（先修好再渲染）` }
      const cfg = mergeJpsConfig(source, { ...defaultPageConfig, ...(pageConfig as Partial<PageConfig> | undefined) })
      return { ok: true, svgs: renderScoreToSvg(layoutScore(parseJps(source), cfg), assets === undefined ? undefined : { assets }) }
    },
    exportMidi: (source) => {
      const { errors } = splitParseIssues(parseJps(source))
      if (errors.length > 0) return { ok: false, error: `${errors.length} 个语法错误（先修好再导出）` }
      const parsed = parseJps(source)
      const layout = layoutScore(parsed, mergeJpsConfig(source, defaultPageConfig))
      const bytes = eventsToMidi(buildPlaySequence(parsed, layout, 60).events, { bpm: 60, title: 'iJipu' })
      return { ok: true, bytes }
    },
  })
  // ⚠ adj854：这行日志刻意用**纯 ASCII** 写成 `bridge-installed` —— 中文串在打包时会被转义成 `\uXXXX`，
  //    导致"在产物里 grep 中文"永远失败 ✗（本轮就因此误判过一次 ✓）。ASCII 标记能被可靠检索 ✓。
  console.info(`[iJipu] bridge-installed host=${window.parent !== window ? 'yes' : 'no'}`)
  console.info(`[iJipu] 嵌入版启动日志：Obsidian 桥已安装${window.parent !== window ? '（宿主内 ✓）' : '（独立页：按设计空转 ✓）'}`)
}

// ⚠ 必须在**任何 await 之前**调用 ✓（这条就是本 bug 的修法，别往下移 ✗）
installBridgeOnce()

window.addEventListener('load', () => {
    // 快照：注册前页面是否已有 SW 控制者（决定这次接管是不是"更新"）
    const hadController = !!navigator.serviceWorker.controller
    navigator.serviceWorker
      // adj400：updateViaCache:'none' —— SW 脚本本身也绕开 HTTP 缓存，保证 reg.update() 每次
      // 都真的拿到线上最新 sw.js（配合 scripts/stamp-sw.mjs 给每个构建打指纹 → 一定能检出更新）
      .register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!shouldPromptUpdate(hadController)) return
          /**
           * adj724b：**动态**导入而不是顶部静态导入——
           * 静态导入会让 `uiStore` 在"嵌入版偏好预载完成之前"就求值（读到空设置）。
           * 这条路径只在**网页版**触发，动态导入的额外一步可忽略。
           */
          void import('./store/uiStore').then((m) => m.useUiStore.getState().setUpdateReady(true))
        })
        // SPA/PWA 可能长期不重载：定期 + 每次窗口重新获焦时主动检查是否有新版
        const check = () => {
          void reg.update().catch(() => {
            /* 离线/网络异常时忽略 */
          })
        }
        window.addEventListener('focus', check)
        window.setInterval(check, UPDATE_CHECK_INTERVAL_MS)
      })
      .catch(() => {
        /* 注册失败（如自定义协议/离线环境）静默忽略 */
      })
    })
  }
}
