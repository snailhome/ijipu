/**
 * preview/PreviewPane.tsx — 乐谱预览区（真实渲染 + 光标联动 + 排版辅助虚线）
 *
 * 渲染管线：parseResult → layoutScore → renderScoreToSvg → 多页 SVG。
 * 联动（M3）：activeNoteId 高亮对应音符并滚动；点击音符/歌词跳转编辑器光标。
 * 辅助虚线（adj7）：页面四边距 + 每行行距虚线，按住拖拽直接调整页面设置。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { useDocStore } from '../store/docStore'
import { useUiStore, enabledVoicesOf } from '../store/uiStore'
// adj529：预览页基准宽（与顶栏"双击比率按宽度适配"的反算算式同源）
import { PREVIEW_BASE_W, isFullyVisibleIn } from './zoomFit'
// adj987h（用户需求）：试听「标记段」的标记线覆盖层
import { PracticeMarkLayer } from './PracticeMarkLayer'
// adj895：播放跟随滚动的「安全区」判定（纯函数，见该文件的口径说明）
// adj1089：按拍/按小节的居中 + "左右露白 ≤10%"夹紧（与出片同一个 clampRowCenter）
import {
  followScrollTargetX,
  followScrollTargetY,
  panFocusAt,
  panScrollTargetX,
  safetyPanTargetX,
  spanLastBarStart,
} from './followScroll'
import { openExternalUrl } from './openUrl'
import { beginDrag } from '../ui/dragGesture'
// adj723：音符点击（单击 / Ctrl+单击）的动作判定（纯模块，便于 smoke 断言）
import { noteClickAction, noteClickKind } from './noteClickAction'
import { tempoLabel } from '@ijipu/engine/parser/parser'
// adj758（清单 B1）：色块的**分组/定位/配色**都来自引擎 —— 应用与 Obsidian 插件共用一份实现
import {
  layoutScore,
  renderScoreToSvg,
  noteIdToCodePos,
  buildIndexToPage,
  mergeJpsConfig,
  SEGMENT_ROW_GAP_DEFAULT,
  notesRowBaseline,
  trackKeysOf,
  playheadPosIn,
  instrumentColorMap,
  playheadBaseOf,
  ballAt,
  beatPhaseOf,
  primaryVoiceOf,
  BALL_LANDING_TIMING,
  BALL_LEAD_MS,
  BALL_SQUASH_X,
  BALL_SQUASH_Y,
} from '@ijipu/engine'
import type { ScorePage, PageConfig, BallAnchor } from '@ijipu/engine'
// adj965（方案「OVL」，EP-10）：水印/背景图的资源状态（订阅 + 并进渲染参数）
import { getOverlaySnapshot, subscribeOverlayAssets, withOverlay } from '../store/overlayAssets'
// adj965d（方案「OVL」，EP-13）：预览区里调水印/背景层的 **Alt 手势**——判定与换算在**引擎**里
// （`@ijipu/engine` 的 `overlayGesture.ts`，与 Obsidian 插件共用一份），这里只负责接线与写盘时机
import {
  activeOverlayLayer,
  applyOverlayDrag,
  applyOverlayWheel,
  bothOverlayLayersVisible,
  overlayGestureBase,
  overlayLayerPersisted,
  overlayLayerVisible,
  overlayOffsetOf,
  overlayWheelMode,
  overlayWheelSteps,
  wheelDeltaPx,
  OVERLAY_COMMIT_DELAY_MS,
} from '@ijipu/engine'
// adj965d：预览区角落的「调整对象」与键位提示文案（面向用户的文案一律集中在 brand/copy.ts）
import { overlayCopy } from '../brand/copy'
import { computeRowTops, computeRowGuides, rowSpansOfPage, dragDelta, clamp, metaAreaH, GUIDE_LIMITS, GUIDE_LIMITS_EX } from '@ijipu/engine/layout/guides'
// adj1090：曲行的纵向范围（曲部 + 词部，多声部块合成一组）
import type { RowSpan } from '@ijipu/engine/layout/guides'
// adj905q：预览可视调试的边界虚线几何（时值格 / 墨迹 / 段层）——几何在引擎侧算好，这里只消费
import { computeDebugBounds } from '@ijipu/engine/layout/guides'
import { clampMetaPos, metaAnchorOf, metaAnchorPt } from '@ijipu/engine/layout/metaAnchors'
import { firstEnabledInstrumentRef, enabledInstrumentRefs } from '../playback/spessaSynthBackend'
import { measureFontMeta } from './fontMeta'
import { brand, ui as uiColors } from '../brand/tokens'
// adj1033：动态谱取景框（固定框 + 框内相机画面）
import { DynamicFrameOverlay } from './DynamicFrameOverlay'

/**
 * adj380：播放高亮元素「加/去」高亮——**除 class 外直接写 fill 属性**。
 * 只靠 CSS 类（`.note-active { fill: var(--jp-danger) !important }`）在部署版里有失效风险
 * （样式表/主题变量未就绪、PWA 缓存与 bundle 版本不一致时，类加了也不变色——表现就是
 * "数字变红而增时线不变红"这类局部不变色）。直接写属性后，高亮与 CSS 层叠解耦；
 * 原始 fill 值暂存在 data-hl-fill，去掉高亮时精确还原（歌词等元素的 fill 与音符不同）。
 * 颜色取自品牌 tokens 的 ui.danger（与 CSS 的 --jp-danger 同值）。
 */
function applyNoteHighlight(el: Element, on: boolean): void {
  if (on) {
    if (!el.hasAttribute('data-hl-fill')) el.setAttribute('data-hl-fill', el.getAttribute('fill') ?? '')
    el.classList.add('note-active')
    el.setAttribute('fill', uiColors.danger)
    return
  }
  el.classList.remove('note-active')
  const orig = el.getAttribute('data-hl-fill')
  if (orig === null) return
  if (orig === '') el.removeAttribute('fill')
  else el.setAttribute('fill', orig)
  el.removeAttribute('data-hl-fill')
}

/**
 * 预览 SVG 基准显示宽度（与渲染容器一致）；实际显示宽度 = 基准宽 × zoom%（adj51）。
 * adj529：基准宽搬到 `preview/zoomFit.ts`（与"按宽度适配"的反算算式同处一地，单一来源）。
 */
const PREVIEW_W = PREVIEW_BASE_W

/**
 * adj1062：预览页与页之间的间距（CSS px）。
 *
 * 为什么要放进 TS：跳跳球现在**跨页**飞（从本页末飞进下一页首），得把各页换算到同一套
 * 纵向坐标里；这个间距是换算的一环。`.pages` 的内联 `gap` 与这里**同一个常量**，
 * CSS 里的 `gap: 24px` 只作兜底（不写两份数）。
 */
const PAGE_GAP_PX = 24

/**
 * adj965d（EP-13）：滚轮手势的"停顿落盘"延时 —— 取值来自**引擎**，与 Obsidian 插件同源
 * （同一套交互口径，两端不各写一个数；语义见 `engine/overlayGesture.ts` 里那段说明）。
 */

export function PreviewPane({ disableGuides = false }: { disableGuides?: boolean } = {}) {
  const parseResult = useDocStore((s) => s.parseResult)
  const pageConfig = useDocStore((s) => s.pageConfig)
  const setPageConfig = useDocStore((s) => s.setPageConfig)
  const code = useDocStore((s) => s.code)
  const activeNoteId = useDocStore((s) => s.activeNoteId)
  const setActiveNoteId = useDocStore((s) => s.setActiveNoteId)
  const setNoteIndexToPage = useDocStore((s) => s.setNoteIndexToPage)
  // adj258：批量高亮播放中同时演奏的音符（多声部同步）
  const activeNoteIds = useDocStore((s) => s.activeNoteIds)
  const jumpCursor = useDocStore((s) => s.jumpCursor)
  const showGuides = useUiStore((s) => s.showGuides)
  /** adj1169：对拍窗口里**关掉排版辅助**（不可拖动页边距/行距，避免误操作改乱谱面） */
  const guidesEnabled = showGuides && !disableGuides
  // adj965d（EP-13）：Alt 手势调的是哪一层（L3 会话级；两层都可用时由预览角落的切换器决定）
  const overlayEditLayer = useUiStore((s) => s.overlayEditLayer)
  const setOverlayEditLayer = useUiStore((s) => s.setOverlayEditLayer)
  // adj905q：预览可视调试开关（L3 会话级，不落盘；关着时不计算几何）
  const debugBounds = useUiStore((s) => s.debugBounds)
  const previewZoom = useUiStore((s) => s.previewZoom)
  /**
   * adj723g：`dockOpen` / `dockPanel` 的订阅**已删除**——原先只服务于 `isPlaybackOpen`
   * （"试听开着时单击音符就重播"），而用户要求单击**只定位光标** ⇒ 该判据没有使用者了。
   * 少两个 store 订阅也顺带少两次无谓重渲染。
   */
  const setPlaybackStart = useUiStore((s) => s.setPlaybackStart)
  const bumpPlaybackTick = useUiStore((s) => s.bumpPlaybackTick)
  // adj723d：`Ctrl+单击音符` 要**打开并聚焦试听**（`requestDockPanel` 在 ToolDock 里落地为
  // "打开并聚焦"；不能是"开关"，否则试听已开着时会被收起来）
  const requestDockPanel = useUiStore((s) => s.requestDockPanel)
  // adj354：@@ 显示默认音色名——无 Y 时用试听音色列表第一个启用音色（与播放端一致）
  const playbackHqEnabled = useUiStore(enabledVoicesOf)
  const defaultInstrumentRef = useMemo(() => firstEnabledInstrumentRef(playbackHqEnabled), [playbackHqEnabled])
  // adj908：整份启用音色列表（与试听同一个来源）——没写 `Y:` 的声部按序取音色，
  // 使 `showInstrument` 标注的默认乐器名与实际演奏的音色一致（两处共用引擎的同一个纯函数）
  const enabledInstRefs = useMemo(() => enabledInstrumentRefs(playbackHqEnabled), [playbackHqEnabled])

  const containerRef = useRef<HTMLDivElement>(null)
  const pageConfigRef = useRef(pageConfig)
  pageConfigRef.current = pageConfig

  // ---- adj965d（EP-13）：Alt 手势要用到的引用（全部只在手势里读写，不参与渲染）----
  /** 预览滚动容器（滚轮监听挂在它上面：`{ passive: false }` 才能 `preventDefault`） */
  const paneRef = useRef<HTMLDivElement>(null)
  /**
   * 本轮手势**开始前**的生效配置快照。写盘时以它为基线（`setPageConfig(cur, true, base)`）⇒
   * 一次拖动/一次连续滚动只固化本次改动、只产生一条撤销（与描述头、辅助虚线拖拽同一口径，adj454）。
   */
  const gestureBaseRef = useRef<PageConfig | null>(null)
  /** 滚轮的"停顿落盘"定时器（滚轮没有松手事件，只能靠停顿判定一次手势结束） */
  const gestureTimerRef = useRef<number | null>(null)
  /**
   * 滚轮位移的**累计值**（CSS px，未满一档的余数留到下一次事件）。
   * 为什么要有它：鼠标滚一格恰好约 100px ⇒ 一格一档；触控板一次滑动会派发很多个小 delta，
   * "一个事件一档"会连跳好几档。累计到 `OVERLAY_WHEEL_STEP_PX` 才走一档（用户 2026-10-15 确认）。
   */
  const wheelAccRef = useRef(0)
  /**
   * 刚做完一次 `Alt+拖动` ⇒ 抑制紧随其后的那次 `click`。
   * 为什么需要：`Alt+拖动` 落在音符上时，松手仍会派发一次 `click`，
   * 而那会被 `onClick` 当成"单击音符"把编辑器光标跳走 —— 用户只是在摆背景图。
   */
  const suppressClickRef = useRef(false)

  /**
   * adj965d：**源码层**的生效配置——只按谱面里的 `# jps-config` 算，**不含设置面板的草稿**。
   * 用来回答"这一层到底写进谱面没有"（见下面的 `overlayUnsaved`）。
   * 应用侧没有 L1 页面设置层（adj480），所以 `mergeJpsConfig(code, null)` 就是"这份谱自己说的"。
   */
  const sourceConfig = useMemo(() => mergeJpsConfig(code, null), [code])

  /**
   * adj965d：当前手势作用在哪一层（`null` = 三条前提不齐 ⇒ 完全不介入）。
   * ①「排版辅助」关 ⇒ 直接 `null`（负向判据）；②该层已启用 ③该层有内容 ⇒ 在纯模块里判。
   */
  const overlayTarget = guidesEnabled ? activeOverlayLayer(pageConfig, overlayEditLayer) : null
  /** 两层都可用时才显示「调整对象」切换器（用户口径：只有一层或都没有，不显示切换器） */
  const overlaySwitcher = overlayTarget !== null && bothOverlayLayersVisible(pageConfig)
  /**
   * adj965d（用户要求"加一层保险"）：**这一层还只活在面板草稿里**（谱面源码里还没有它）。
   *
   * 为什么要当面说：只在面板里勾了开关、没点「保存设置」时，**除手势以外**的任何动作都可能让它消失
   * （在编辑器里打字、刷新页面、宿主整页重载都会让生效配置重新从源码派生）
   * —— 上一次就是这样"莫名其妙条没了、手势也不动了"。所以角落提示里加一句，
   * 并且在它旁边就能看到"点「保存设置」"这个动作（或者直接用手势调一下，落盘会整层固化）。
   *
   * `mergeJpsConfig(code, null)` = **只按源码层**算的生效配置（应用侧没有 L1 页面设置层，adj480）。
   */
  const overlayUnsaved = overlayTarget !== null && !overlayLayerPersisted(sourceConfig, overlayTarget)

  /**
   * adj965（方案「OVL」，EP-10）：水印/背景图的资源来自**异步解析**（读字节 + 解码），
   * 所以预览要订阅它——资源到位后才重画一次。`overlay` 也进下面 useMemo 的依赖。
   */
  const overlay = useSyncExternalStore(subscribeOverlayAssets, getOverlaySnapshot)
  const { layout, pagesHtml, summary } = useMemo(() => {
    const musicLines = parseResult.groups.length
    const notes = parseResult.groups.reduce((n, g) => n + g.music.tokens.length, 0)
    const sum = {
      title: parseResult.header.titles[0] ?? '未命名',
      authors: parseResult.header.authors.join('；'),
      key: parseResult.header.key,
      meter: parseResult.header.meter,
      // 多条 J（数字+文字）时显示合并标签 ♩=80 欢快地（与乐谱一致）
      tempo:
        parseResult.header.tempoNum || parseResult.header.tempoText
          ? tempoLabel(parseResult.header.tempoNum, parseResult.header.tempoText)
          : parseResult.header.tempo,
      musicLines,
      notes,
      errors: parseResult.errors.length,
    }
    // adj208：不因语法错误清空预览——layout/render 对错误输入安全（错误行已在
    // 解析阶段跳过：引号未闭合吞剩余内容、歌词缺曲行不挂载、未知符号降级为装饰），
    // 始终渲染可解析部分，避免预览在正常显示与错误提示之间闪动
    // adj199/adj629v/adj638/adj647：宿主实测的字体度量（布局侧 + 渲染侧一次量好，预览/导出/打印同一份）
    //  · 渲染侧：`1 = ` / ♯ 占宽 / ♯ 墨迹右缘（内联排版 + 右侧留白补偿 ⇒ 墨迹净距 0.2px，adj638）
    //            与 `1 ` / `♩` 宽（D 行与 J 行的 = 对齐，adj629v）
    //  · 布局侧：变音角标 #/b/♮ 的墨迹宽与左偏（adj647）——**必须在 layoutScore 之前**测好
    const cfg = pageConfig
    const fm = measureFontMeta(cfg)
    const lay = layoutScore(parseResult, pageConfig, defaultInstrumentRef, fm.layout, enabledInstRefs)
    // adj199/adj629v/adj638/adj647：宿主实测的字体度量（渲染侧）——见 preview/fontMeta.ts
    return {
      layout: lay,
      // adj965：`withOverlay` 把当前解析好的图片资源并进渲染参数（与导出/打印**共用同一份**）；
      // 这里**显式传**订阅到的那份，`useMemo` 的依赖才是真的（不然依赖藏在模块状态里）
      pagesHtml: renderScoreToSvg(lay, withOverlay(fm.render, overlay.assets)),
      summary: sum,
    }
  }, [parseResult, pageConfig, defaultInstrumentRef, enabledInstRefs, overlay])

  // adj291：布局后把「音符 index → 物理页」映射回填 store，供编辑器光标联动对齐音符 id.page（自动分页一致）
  useEffect(() => {
    if (layout) setNoteIndexToPage(buildIndexToPage(layout))
  }, [layout, setNoteIndexToPage])

  const rowTops = useMemo(() => (layout ? computeRowTops(layout, pageConfig.note_size) : []), [layout, pageConfig.note_size])
  const rowGuides = useMemo(
    () =>
      guidesEnabled && layout
        ? computeRowGuides(
            layout,
            { quci: pageConfig.height_quci, geci: pageConfig.geci_size },
            pageConfig.note_size,
          )
        : [],
    [guidesEnabled, layout, pageConfig.height_quci, pageConfig.geci_size, pageConfig.note_size],
  )
  /**
   * adj1090（用户口径）：**每页每个曲行的纵向范围**（曲部 + 词部）。
   *
   * 口径在引擎 `rowSpansOfPage`：多声部块（`page.voiceBlocks`）内的所有声部行合成一组，
   * 段层（`{bz}`/`{dsb}`/`{tp}`）并入所属曲行，行底取到**最后一行歌词** —— 多行歌词都在里面。
   * 试听换行时据此把整组滚进视界（高度），与横向跟随互不相干。
   */
  const rowSpansByPage = useMemo(
    () =>
      layout
        ? layout.pages.map((_, i) =>
            rowSpansOfPage(layout, i, {
              quci: pageConfig.height_quci,
              geci: pageConfig.geci_size,
              noteSize: pageConfig.note_size,
            }),
          )
        : [],
    [layout, pageConfig.height_quci, pageConfig.geci_size, pageConfig.note_size],
  )
  /**
   * adj905q（用户规格见 `docs/PREVIEW-DEBUG-BOUNDARIES.md`）：**预览可视调试**的边界虚线几何。
   * 按页给出「时值格 / 墨迹 / 段层」三套边界；**几何全部来自引擎**（`computeDebugBounds`），
   * 这里**只消费、不重算**（`AGENTS.md` 五·3 / 六之二·4 的"数值口径同源"）。
   * 开关是 **L3 会话级**（`uiStore.debugBounds`，不落盘），关着时不计算。
   */
  const debugBoundsByPage = useMemo(() => {
    if (!layout || !debugBounds) return []
    return layout.pages.map((p) => computeDebugBounds(p.notes, pageConfig.note_size))
  }, [layout, debugBounds, pageConfig.note_size])


  // adj258：批量高亮播放中同时演奏的音符（多声部同步演奏——同一组多声部同 atMs 音符同时高亮）
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    root.querySelectorAll('.note-active').forEach((el) => applyNoteHighlight(el, false))
    if (!activeNoteIds || activeNoteIds.length === 0) return
    for (const id of activeNoteIds) {
      // adj374：一个音符可能有多个视觉元素共用同一 data-notepos（数字 + 各条增时线），需全部高亮
      const els = root.querySelectorAll(
        `[data-notepos="${CSS.escape(id)}"], [data-cipos="${CSS.escape(id)}"]`,
      )
      els.forEach((el) => applyNoteHighlight(el, true))
    }
  }, [activeNoteIds, pagesHtml])

  // 高亮当前音符（M3）
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    root.querySelectorAll('.note-active').forEach((el) => applyNoteHighlight(el, false))
    if (!activeNoteId) return
    const els = root.querySelectorAll(
      `[data-notepos="${CSS.escape(activeNoteId)}"], [data-cipos="${CSS.escape(activeNoteId)}"]`,
    )
    els.forEach((el) => applyNoteHighlight(el, true))
    const el = els[0]
    if (el) {
      // adj237/238：居中滚动但以页面区域为界——scrollIntoView 会把音符滚到视口中心，
      // 页面较小时视口中心落在页面外的预览空白上；改为手动滚动（垂直+水平）：
      //  - 页面 ≥ 视口：音符居中，滚动范围钳在页面内（页面始终铺满视口，不露空白）
      //  - 页面 < 视口：不为了居中而滚出页面——垂直页面顶对齐视口顶、
      //    水平页面居中排布不滚动（align-items:center）
      const scroller = root.parentElement // 滚动容器（.preview-pane）
      if (scroller) {
        const scRect = scroller.getBoundingClientRect()
        /**
         * adj723y（用户报「双击音符从当前音符播放又失效了」）：**音符已完整可见时不要滚动**。
         *
         * 原因：单击音符会触发本 effect 的"居中滚动"，把音符挪走（实测 `scrollLeft/Top`
         * `0 → 24`，音符屏幕坐标随之偏 24px）。而**双击的两次点击落在同一位置**是浏览器的
         * 判定条件，第二次点击因音符已移走而落到 `.preview-zoom-scale`（空处）
         * ⇒ **浏览器不派发 `dblclick`**（实测 `e.target = DIV.preview-zoom-scale`、
         * 音符祖先查不到即 `null`）⇒ 用户观感"双击播放失效"。
         *
         * 修法：**已完整可见 ⇒ 原地不动**（这才是"把目标音符带进视野"的本意；
         * 只有真的看不到时才需要滚）。既保住居中能力的初衷，又让双击的第二击仍落在音符上。
         */
        const elRect0 = el.getBoundingClientRect()
        if (isFullyVisibleIn(elRect0, scRect)) return
        // 垂直
        const viewH = scroller.clientHeight
        const noteY = el.getBoundingClientRect().top - scRect.top + scroller.scrollTop
        let targetY = noteY - viewH / 2
        // 水平（adj238：预览放大后页面宽于视口，点击两侧音符需水平滚动居中）
        const viewW = scroller.clientWidth
        const noteX = el.getBoundingClientRect().left - scRect.left + scroller.scrollLeft
        let targetX = noteX - viewW / 2
        const pageEl = el.closest('.score-page')
        if (pageEl) {
          // 水平边界用 preview-zoom-scale（实际放大内容区）——score-page 的
          // maxWidth:100% 会被视口裁剪，音符实际 x 位于 zoom-scale 内
          const boundsEl = pageEl.querySelector('.preview-zoom-scale') ?? pageEl
          const pageTop = pageEl.getBoundingClientRect().top - scRect.top + scroller.scrollTop
          const pageH = pageEl.getBoundingClientRect().height
          const bLeft = boundsEl.getBoundingClientRect().left - scRect.left + scroller.scrollLeft
          const bW = boundsEl.getBoundingClientRect().width
          if (pageH >= viewH) {
            targetY = Math.max(pageTop, Math.min(targetY, pageTop + pageH - viewH))
          } else {
            targetY = pageTop
          }
          if (bW >= viewW) {
            targetX = Math.max(bLeft, Math.min(targetX, bLeft + bW - viewW))
          } else {
            targetX = 0 // 内容窄于视口（居中排布），无需横向滚动
          }
        }
        const maxScrollY = scroller.scrollHeight - viewH
        scroller.scrollTop = Math.max(0, Math.min(targetY, maxScrollY))
        const maxScrollX = scroller.scrollWidth - viewW
        scroller.scrollLeft = Math.max(0, Math.min(targetX, maxScrollX))
      } else {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    }
  }, [activeNoteId, pagesHtml])

  /**
   * adj723g（用户要求）：**"试听是否开着"不再参与预览区点击的判定**。
   *
   * 历史：`adj490` 引入 `isPlaybackOpen = dockOpen && dockPanel === 'tryout'`，
   * 用途是"试听开着时**单击**音符就从该处重播"；用户现在要求
   * 「点击**只保留**定位编辑器到该音符位置，播放只在**双击**时发生」⇒ 该判据已无使用者，删除。
   * （`adj490` 的另一半价值——"底栏试听页签也要算可达"——由双击/`Ctrl+单击` 的 `tryoutFromNote`
   *   全盘接管：它根本不再需要"是否已开"这个前提。）
   */

  /**
   * adj723e（用户要求）：**从这里试听**——抽成一个动作，供 `Ctrl+单击` 与（新增的）**双击**共用。
   *
   * 语义（与 `noteClickAction` 的 `ctrl-tryout` 一致）：
   *  · 把该音符设为试听起点；
   *  · **打开并聚焦**试听页签（`requestDockPanel` 在 `ToolDock` 里是"打开并聚焦"，
   *    已开着则**保持**，不会把底栏收起来）；
   *  · 递增 `playbackTick` 让 `PlaybackDialog` 从该音符播放
   *    （底栏**原本没开**时由对话框挂载后的"待播起点"逻辑接手，见 `adj723e`）。
   */
  const tryoutFromNote = (id: string) => {
    setActiveNoteId(id)
    setPlaybackStart(id)
    requestDockPanel('tryout')
    bumpPlaybackTick()
  }

  // 点击谱面音符/歌词 → 编辑器光标跳转（M3）
  // adj284：试听可达时单击音符 → 从该音符开始/重播（跳转到该处演奏）
  // adj652：点**谱面文本里的链接**（引擎把 URL 包成了 `a.jp-link`，如 S: 谱尾说明里的官网）
  //   → 用系统浏览器打开，不走"音符跳转"那条路。
  const onClick = (e: React.MouseEvent) => {
    /**
     * adj965d（EP-13）：刚做完一次 `Alt+拖动` ⇒ **吞掉这一次 click**。
     * 松手时若指针正好停在音符上，这次 click 会被下面当成"单击音符"把光标跳走——
     * 而用户只是在摆水印/背景图。标记由 `startOverlayDrag` 在**真的移动过**时置上，
     * 并在每次 `pointerdown` 重置（所以"没移动的 Alt+单击"照旧落到正常分支）。
     */
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const link = (e.target as Element).closest('a.jp-link')
    if (link) {
      e.preventDefault()
      e.stopPropagation()
      void openExternalUrl(link.getAttribute('data-href') ?? link.getAttribute('href') ?? '')
      return
    }
    const target = (e.target as Element).closest('[data-notepos], [data-cipos]')
    if (!target) return
    const id = target.getAttribute('data-notepos') ?? target.getAttribute('data-cipos')
    if (!id) return
    /**
     * adj723（用户要求）：**`Ctrl + 鼠标左键` 点音符 ⇒ 立即打开试听对话框，并从该音符开始播放**。
     *
     * 与另外两条路的区别（判定收敛在纯模块 `noteClickAction.ts`，便于 smoke 断言）：
     *  · **单击**（`adj284`）= 光标跳转；试听**已经可达时**顺带从该音重播；
     *  · **双击**（`adj723e` 起）= **与 `Ctrl+单击` 完全相同**（用户要求）；
     *  · **`Ctrl+单击`（`adj723`）= 显式"从这里试听"**：不管试听是否开着都打开并从此处播放
     *    （**不跳光标**——用户按的是"听"不是"改"）。
     */
    const action = noteClickAction(noteClickKind(e))
    if (action.openTryout) {
      e.preventDefault()
      tryoutFromNote(id)
      return
    }
    setActiveNoteId(id)
    // adj634（用户要求）：光标落在**音符块末尾**（与后一块之间的空格之前），而不是块首——
    // 修饰符（& 编码、注释、倚音括号）都跟在主音符后面，落在块末就可以直接接着写。
    /**
     * adj723g（用户要求）：「试听对话框打开的情况下，**取消**"点击音符从该音符播放"的操作，
     * 只在**双击**时播放；点击**只保留**定位编辑器到该音符位置的操作」。
     *
     * 故这里**不再**有 `if (isPlaybackOpen) { setPlaybackStart(id); bumpPlaybackTick() }` 那段——
     * 单击一律只干两件事：把该音符设为高亮 + 光标跳到源码里该音符处。
     * 想"从这里听"请用**双击**或 **`Ctrl+单击`**（两者都走 `tryoutFromNote`）。
     */
    const pos = noteIdToCodePos(code, id, 'end')
    if (pos !== null && action.jumpCursor) jumpCursor(pos)
  }

  /**
   * adj723e（用户要求）：「**双击音符执行与 Ctrl+点击音符同样的操作**」——
   * 即"打开试听（有则保持）+ 从该音符播放 + 焦点落到播放按钮"。
   *
   * 与旧口径（`adj88`/`adj166`）的差别：旧口径**只在试听已经可达时**才动作，
   * 未打开试听时双击**不弹窗**（当年是为防误触）。现在用户明确要求双击等同于 `Ctrl+单击`，
   * 故去掉"必须已可达"这条前置。
   *
   * 注：一次双击必然先触发两轮 `click`（`noteClickAction` 的 `single` 分支：光标跳转），
   * 然后才是本回调——起点/`playbackTick` 因此会被置两次，但 `PlaybackDialog` 里的
   * **代次守卫**（`adj723d`）保证只有最后一次落地，不会同时跑两个播放进程。
   */
  const onDoubleClick = (e: React.MouseEvent) => {
    const target = (e.target as Element).closest('[data-notepos]')
    if (!target) return
    const id = target.getAttribute('data-notepos')
    if (!id) return
    e.preventDefault()
    tryoutFromNote(id)
  }

  // ---- 描述头元素拖拽（adj9） ----
  const metaDragRef = useRef<{
    key: string
    startX: number
    startY: number
    baseX: number
    baseY: number
    /** adj454：按下时的生效配置快照——松手写回谱面时以它为基线，只固化本次拖拽的改动 */
    baseCfg: PageConfig
  } | null>(null)

  const onMetaPointerDown = (e: React.PointerEvent) => {
    const el = (e.target as Element).closest('[data-meta]')
    if (!el) return
    e.stopPropagation()
    const key = el.getAttribute('data-meta')!
    if (!layout) return
    // adj51：拖拽换算缩放需含预览 zoom（实际显示宽 = PREVIEW_W × zoom）
    const scale = (PREVIEW_W / layout.pages[0].width) * (previewZoom / 100)
    const cfg = pageConfigRef.current
    const pageW = layout.pages[0].width
    const base = cfg.metaPos?.[key]
    // 基准 = 相对各自锚点的偏移（adj16）；无 metaPos 时由元素绝对坐标减去锚点得出
    // notes_i（说明文字，谱尾，adj151 左对齐）：基准 = 左边距 + 默认 y（下边距线上方 24px 起逐行）
    let bx: number
    let by: number
    if (key.startsWith('notes')) {
      const lineIdx = Number(el.getAttribute('data-notes-line') ?? '0')
      // adj153：换行后的子行（data-notes-sub）基准 y 也要计入，避免把子行偏移混进 metaPos
      const subIdx = Number(el.getAttribute('data-notes-sub') ?? '0')
      /**
       * adj630b：说明的默认 y 改为**自下而上**（末行贴下边距线、往上逐行）⇒ 基准 y 由
       * 引擎的 `notesRowBaseline()` 给出（渲染端同一函数）。行序号/总行数由渲染端写在
       * `data-notes-row` / `data-notes-total` 上（跨 `S:` 段与换行子行连续编号）——
       * **不能**再用 `lineIdx + subIdx` 推（多段时它不是整块行号）。
       */
      const row = Number(el.getAttribute('data-notes-row') ?? String(lineIdx + subIdx))
      const totalRows = Number(el.getAttribute('data-notes-total') ?? '1')
      const baseY = notesRowBaseline({
        pageH: layout.pages[0].height,
        marginBottom: cfg.margin_bottom,
        nSize: cfg.notes_size ?? cfg.miaoshu_size,
        row,
        totalRows,
      })
      if (key === 'notes') {
        // 旧 metaPos["notes"]（adj83 语义）：基准 = 页面居中（兼容旧配置拖拽）
        const baseX = pageW / 2
        bx = base ? base.x : Number(el.getAttribute('x')) - baseX
        by = base ? base.y : Number(el.getAttribute('y')) - baseY
      } else {
        // 新 metaPos["notes_i"]（adj151）：基准 = 左边距（左对齐）
        const baseX = cfg.margin_left
        bx = base ? base.x : Number(el.getAttribute('x')) - baseX
        by = base ? base.y : Number(el.getAttribute('y')) - baseY
      }
    } else {
      const anchor = metaAnchorPt(metaAnchorOf(key), pageW, cfg)
      bx = base ? base.x : Number(el.getAttribute('x')) - anchor.x
      by = base ? base.y : Number(el.getAttribute('y')) - anchor.y
    }
    metaDragRef.current = { key, startX: e.clientX, startY: e.clientY, baseX: bx, baseY: by, baseCfg: { ...cfg } }
    // adj487：描述头拖拽改用 Pointer Events（此前只监听 mousemove/mouseup，手机上拖不动）
    beginDrag(e, {
      onMove: (dx, dy) => {
        const d = metaDragRef.current
        if (!d) return
        const next = { ...(pageConfigRef.current.metaPos ?? {}) }
        // 相对锚点保存（adj16），钳制在区域内
        const pos = clampMetaPos(
          d.key,
          d.baseX + dx / scale,
          d.baseY + dy / scale,
          pageW,
          pageConfigRef.current,
        )
        next[d.key] = {
          // adj413：描述头位置同样按整数 px 存（原为 0.1px 精度，与"px 一律整数"不符）
          x: Math.round(pos.x),
          y: Math.round(pos.y),
        }
        setPageConfig({ ...pageConfigRef.current, metaPos: next })
      },
      onEnd: () => {
        // adj454：先取出按下时的基线快照（下面会清空 ref），写回时只固化本次拖拽改动的字段
        const baseCfg = metaDragRef.current?.baseCfg
        metaDragRef.current = null
        // adj83：拖拽结束把 metaPos 持久化到源码 # jps-config（每首谱用自己的设置）
        if (pageConfigRef.current.metaPos) {
          setPageConfig(pageConfigRef.current, true, baseCfg)
        }
      },
    })
  }

  // ---- 辅助虚线拖拽（adj7/adj10） ----
  const [drag, setDrag] = useState<{
    spec: { key: string; dir: 'v' | 'h'; invert?: boolean }
    startX: number
    startY: number
    startVal: number
    /** adj454：按下时的生效配置快照——松手写回谱面时以它为基线，只固化本次拖拽的改动 */
    baseCfg: PageConfig
  } | null>(null)

  const startDrag = (
    spec: { key: string; dir: 'v' | 'h'; invert?: boolean },
    e: React.PointerEvent, // adj487：Pointer Events（鼠标 / 触屏 / 触控笔同一套）
    startVal: number,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setDrag({ spec, startX: e.clientX, startY: e.clientY, startVal, baseCfg: { ...pageConfigRef.current } })
  }

  useEffect(() => {
    if (!drag || !layout) return
    // adj51：拖拽换算缩放需含预览 zoom
    const scale = (PREVIEW_W / layout.pages[0].width) * (previewZoom / 100)
    const limitsOf = (key: string): [number, number] =>
      (GUIDE_LIMITS as Record<string, [number, number]>)[key] ??
      (GUIDE_LIMITS_EX as Record<string, [number, number]>)[key] ??
      [0, 400]
    const onMove = (ev: PointerEvent) => {
      const delta = dragDelta(drag.spec, drag.startX, drag.startY, ev.clientX, ev.clientY, scale)
      const [min, max] = limitsOf(drag.spec.key)
      // adj413：位移是浮点（鼠标位移 ÷ 预览缩放），取整后再写入——px 一律整数（与设置界面一致）
      const val = Math.round(clamp(drag.startVal + delta, min, max))
      // adj432：段层间距写在 `PageConfig.segmentRowGap.{bz,dsb}` 子对象里（不是顶层字段）
      // adj629：加 `tp`（替谱段与所属歌词行的间距）——三者同为子对象里的键
      if (drag.spec.key.startsWith('segmentRowGap_')) {
        const which = drag.spec.key.slice('segmentRowGap_'.length) as 'bz' | 'dsb' | 'tp'
        const cur = pageConfigRef.current.segmentRowGap ?? {}
        setPageConfig({ ...pageConfigRef.current, segmentRowGap: { ...cur, [which]: val } })
        return
      }
      const next = { ...pageConfigRef.current, [drag.spec.key]: val }
      setPageConfig(next)
    }
    const onUp = () => {
      setDrag(null)
      // adj83：拖拽结束把调整后的设置持久化到源码 # jps-config
      // adj454：以按下时的快照为基线（drag.baseCfg）——只固化本次拖拽改动的字段
      setPageConfig(pageConfigRef.current, true, drag.baseCfg)
    }
    // adj487：改 Pointer Events（触屏可拖）；pointercancel 处理"来电话 / 手势打断"
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [drag, layout, setPageConfig, previewZoom])

  // ==================== adj965d（EP-13）：水印层 / 背景层的 Alt 手势 ====================
  /**
   * 键位（用户 2026-10-15 终裁＝方案 A「Alt 一族全包」，见方案裁定记录 9）：
   *   `Alt+滚轮` 缩放该层、`Alt+Shift+滚轮` 旋转该层、`Alt+左键拖动` 平移该层。
   * 旋转绕**元素自身中心**——引擎 `overlay.ts` 的 `rotateAttr(θ, cx, cy)` 的 `cx/cy` 就是元素中心
   * （裁定 9.1），所以这里**只改角度值**，不需要传任何旋转中心。
   *
   * 不用 `Ctrl`：那是**页面缩放**的热键（用户指出），而且 `Ctrl+单击` 已经是"从这里试听"
   * （`noteClickAction`）⇒ 拖动改用 `Alt` 后两者完全不冲突，也就不需要"4px 位移阈值"那套判据。
   *
   * ## 写盘时机（与描述头 / 辅助虚线拖拽**同一口径**）
   *  · 手势期间只 `setPageConfig(next, false)`：只做预览、不写源码；
   *  · **松手**才 `setPageConfig(cur, true, baseCfg)` 落盘 ⇒ 一次拖动 = 一条撤销；
   *  · 滚轮**没有"松手"事件** ⇒ 停顿 `OVERLAY_COMMIT_DELAY_MS` 再落盘，一次连续滚动同样只一条撤销。
   *
   * ⚠ 基线**不是**"按下时的完整快照"，而是 `overlayGestureBase(...)`（该层自己的键置回默认）——
   * 这样差量里除了手势动过的那一项，还包括**被调那一层自己的键**（启用 + 内容 + 参数），
   * 否则会在谱面里留下"半截的水印/背景"（详见 `overlayGesture.ts` 里那段说明；真机上踩到过）。
   * 别的东西（页边距、字体、另一层）依旧**不会被带进谱面**。
   */
  const cancelGestureTimer = () => {
    if (gestureTimerRef.current === null) return
    clearTimeout(gestureTimerRef.current)
    gestureTimerRef.current = null
  }
  /** 把本轮手势的改动并进 `# jps-config`（基线取"手势开始前"的那份快照） */
  const commitOverlayGesture = () => {
    cancelGestureTimer()
    // 一轮手势结束 ⇒ 滚轮累计值归零（下一次滚动重新攒够一档才动）
    wheelAccRef.current = 0
    const base = gestureBaseRef.current
    gestureBaseRef.current = null
    if (base !== null) setPageConfig(pageConfigRef.current, true, base)
  }
  /** 指针位移(px) → 谱面 pt 的换算系数（含预览 zoom；与描述头/辅助虚线拖拽同一算式） */
  const ptScale = (): number => (layout ? (PREVIEW_W / layout.pages[0].width) * (previewZoom / 100) : 1)

  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    // 目标层换了（或布局/缩放变了）⇒ 累计值重来，别把"替上一层攒的位移"带到另一层
    wheelAccRef.current = 0
    const onWheel = (ev: WheelEvent) => {
      // ① 没按 Alt ⇒ 直接返回（**绝不 preventDefault**：普通滚动、`Ctrl+滚轮` 页面缩写照旧）
      const mode = overlayWheelMode(ev)
      if (mode === null) return
      // ②③ 该层已启用且有内容（`overlayTarget` 已把「排版辅助」也算进去了）
      const layer = overlayTarget
      if (layer === null) return
      const deltaPx = wheelDeltaPx(ev, pane.clientHeight)
      if (deltaPx === 0) return
      // 手上有这一层 ⇒ 滚轮归手势：**即使这一刻还没攒够一档也不滚页面**
      ev.preventDefault()
      // 累计位移：够一档才动（鼠标一格 ≈ 100px 正好一档；触控板小 delta 攒起来）
      const { steps, rest } = overlayWheelSteps(wheelAccRef.current, deltaPx)
      wheelAccRef.current = rest
      if (steps === 0) return
      // 基线：**该层自己的键置回默认**（`overlayGestureBase` 的说明）——这样落盘时会
      // 把这一层整层固化进谱面，而不是只写手势动过的那一个键（"半截配置"就是这么来的）
      if (gestureBaseRef.current === null) gestureBaseRef.current = overlayGestureBase(pageConfigRef.current, layer)
      // 一次事件可能攒够多档（快滑）；正 = 向下滚 = 值变小
      const sign = steps > 0 ? 1 : -1
      let next = pageConfigRef.current
      for (let i = 0; i < Math.abs(steps); i += 1) next = applyOverlayWheel(next, layer, mode, sign)
      setPageConfig(next, false)
      cancelGestureTimer()
      gestureTimerRef.current = window.setTimeout(commitOverlayGesture, OVERLAY_COMMIT_DELAY_MS)
    }
    // ⚠ 必须 `{ passive: false }`：React 的合成 `onWheel` 与浏览器默认监听都是 passive 的，
    // 里面调 `preventDefault()` 会被忽略（控制台只丢一句警告，页面照滚）——adj965d 实测确认。
    pane.addEventListener('wheel', onWheel, { passive: false })
    return () => pane.removeEventListener('wheel', onWheel)
    // 依赖全是原始值/稳定引用 ⇒ 一次连续滚动期间**不会**反复装卸监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, setPageConfig, overlayTarget, previewZoom])

  /** 组件卸载时把"还没到停顿点"的那次滚轮改动固化掉（否则最后一下会丢） */
  useEffect(
    () => () => {
      if (gestureTimerRef.current !== null) clearTimeout(gestureTimerRef.current)
      const base = gestureBaseRef.current
      gestureBaseRef.current = null
      if (base !== null) setPageConfig(pageConfigRef.current, true, base)
    },
    [setPageConfig],
  )

  /**
   * `Alt+左键按下` ⇒ 开始平移该层；返回 `true` 表示"这次按下归手势管"（描述头拖拽不再接手）。
   * 不满足条件时返回 `false`，**不 `preventDefault`、不捕获指针** ⇒ 试听/光标/描述头拖拽一字不变。
   */  const startOverlayDrag = (e: React.PointerEvent): boolean => {
    if (overlayTarget === null || e.altKey !== true) return false
    if (e.pointerType === 'mouse' && e.button !== 0) return false
    const layer = overlayTarget
    const start = overlayOffsetOf(pageConfigRef.current, layer)
    // 基线同上：该层自己的键置回默认 ⇒ 松手落盘时把这一层整层固化（不是只写偏移那两个键）
    gestureBaseRef.current = overlayGestureBase(pageConfigRef.current, layer)
    beginDrag(e, {
      onMove: (dx, dy, ev) => {
        if (dx === 0 && dy === 0) return
        suppressClickRef.current = true
        // `Shift` 吸附页面中心（方案优化 6）——读**当时的**修饰键，中途按下也生效
        setPageConfig(applyOverlayDrag(pageConfigRef.current, layer, start, dx, dy, ptScale(), ev.shiftKey), false)
      },
      onEnd: () => commitOverlayGesture(),
    })
    return true
  }

  /**
   * 预览区的 `pointerdown` 只有这一个入口：**先给手势，再给描述头拖拽**。
   * （分两个 prop 是做不到的——同一个事件只有一个 handler；这里显式表达优先级。）
   */
  const onPointerDown = (e: React.PointerEvent) => {
    // 每次按下都重置"抑制 click"标记：上一次手势若没真的移动过，就不该影响后面的正常点击
    suppressClickRef.current = false
    if (startOverlayDrag(e)) return
    onMetaPointerDown(e)
  }

  /**
   * adj965d：Alt 手势的**只读自检** —— 控制台里 `__ijipuOverlay()` 一句话取回"为什么没生效"
   * （同 `adj723b` 的 `window.__ijipuPlayhead()` 套路，见 `PlayheadDiag` 的说明）。
   *
   * 为什么必须有：这套手势有**三条前提**，任一条不满足时"什么都不发生"是**设计使然**，
   * 而远程看不见用户机器上的实况 —— 真机上已经踩过一次（"面板里看着都开着，条和手势却都没了"，
   * 根因是那一层只活在草稿里、又从源码重新派生过一次）。有了它，下一次一句话就能定位。
   * 生产构建同样保留：只读、无副作用、只多一个函数引用。
   */
  useEffect(() => {
    const yn = (b: boolean) => (b ? '是' : '否')
    const label = (l: 'wm' | 'bg') => `${l === 'wm' ? overlayCopy.layerWm : overlayCopy.layerBg}（${l}）`
    const dump = (): string =>
      [
        `排版辅助（前提①）=${yn(guidesEnabled)}`,
        `当前调整对象=${overlayTarget === null ? '（无：三条前提不齐 ⇒ 手势完全不介入）' : label(overlayTarget)}`,
        `切换器=${yn(overlaySwitcher)}　尚未写入谱面提醒=${yn(overlayUnsaved)}`,
        `水印　手势可用=${yn(overlayLayerVisible(pageConfig, 'wm'))}　已写入谱面=${yn(overlayLayerPersisted(sourceConfig, 'wm'))}` +
          `　wmEnabled=${String(pageConfig.wmEnabled)}　wmType=${pageConfig.wmType}` +
          `　文本长度=${String(pageConfig.wmText ?? '').length}　图形=${pageConfig.wmImage || '（空）'}`,
        `背景　手势可用=${yn(overlayLayerVisible(pageConfig, 'bg'))}　已写入谱面=${yn(overlayLayerPersisted(sourceConfig, 'bg'))}` +
          `　bgEnabled=${String(pageConfig.bgEnabled)}　图形=${pageConfig.bgImage || '（空）'}`,
        `配置行=${(/# jps-config:.*/.exec(code) ?? ['（没有这一行）'])[0]}`,
      ].join('\n')
    ;(window as unknown as { __ijipuOverlay?: () => string }).__ijipuOverlay = dump
  }, [guidesEnabled, overlayTarget, overlaySwitcher, overlayUnsaved, pageConfig, sourceConfig, code])

  if (!layout || pagesHtml.length === 0) {
    return (
      <div className="preview-pane">
        <div className="preview-placeholder">
          <div className="ph-icon">🎼</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--jp-text-primary)' }}>
            {summary.title}
          </div>
          {summary.authors && (
            <div style={{ color: 'var(--jp-text-secondary)' }}>{summary.authors}</div>
          )}
          <div style={{ color: 'var(--jp-text-muted)', fontSize: 12 }}>
            调式 {summary.key ?? '—'} · 拍号 {summary.meter ?? '—'} · 节拍 {summary.tempo ?? '—'}
          </div>
          <div
            style={{
              marginTop: 8,
              padding: '10px 18px',
              border: '1px solid var(--jp-border)',
              borderRadius: 8,
              background: 'var(--jp-bg-panel)',
              color: 'var(--jp-text-secondary)',
              fontSize: 13,
              lineHeight: 1.9,
            }}
          >
            {/* adj208：预览不再提示语法错误（避免正常预览与错误提示闪动）——
                错误行已在解析阶段跳过，预览始终渲染可解析部分 */}
            <>解析完成：{summary.musicLines} 个曲行 · {summary.notes} 个乐符 · {summary.errors} 个问题</>
          </div>
          <div style={{ color: 'var(--jp-text-muted)', fontSize: 12, marginTop: 10 }}>
            {brand.taglineMain}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="preview-pane" ref={paneRef}>
      {/* adj1033：动态谱取景框（固定在视口上，不随内容滚动；开关在 uiStore） */}
      <DynamicFrameOverlay />
      <div className="pages" ref={containerRef} style={{ gap: PAGE_GAP_PX }} onClick={onClick} onDoubleClick={onDoubleClick} onPointerDown={onPointerDown}>
        {pagesHtml.map((svg, i) => {
          const page = layout.pages[i]
          const pct = (v: number) => `${((v / page.width) * 100).toFixed(2)}%`
          const pctY = (v: number) => `${((v / page.height) * 100).toFixed(2)}%`
          const rowTopsOfPage = rowTops[i] ?? []
          const rowGuidesOfPage = rowGuides[i] ?? []
          const dbgOfPage = debugBoundsByPage[i] ?? []
          void rowTopsOfPage
          return (
            // adj286：去掉 maxWidth:100%——放大后该限制把 score-page 白底裁到视口宽，
            // 页面右侧区域露出容器深色背景（变黑）；宽度跟随 preview-zoom-scale 内容
            <div key={i} className="score-page" style={{ position: 'relative' }}>
              <div
                className="preview-zoom-scale"
                style={{
                  /**
                   * adj529（用户报"预览区越窄，按页宽算出的比率差异越大／缩得更小"）：
                   * **这里不能再把 width 乘一次 zoom**。CSS `zoom` 会把**本元素自己声明的 width 也乘一遍**
                   * （见 MDN `zoom` 的示例：`width:25px` + `zoom:200%` ⇒ 实际 50px），
                   * 所以"`width: 760×z` + `zoom: z`"的实际渲染宽是 **760×z²（平方关系）**：
                   *   · 可用宽 952px → z=125% → 实际 1187px（偏宽）；
                   *   · 可用宽 552px → z=73%  → 实际 **405px**，只有容器的 73% ⇒ 越窄越"缩得更小"；
                   * 而拖拽换算 `scale = (PREVIEW_W / page.width) × z%`（见下方两处）用的正是**线性**模型
                   * ⇒ 作者本意就是线性，`width` 上那次乘法是多余的。
                   * 现在只声明 `width: PREVIEW_BASE_W`（基准宽），由 `zoom` 负责缩放：
                   * 实际显示宽 = `760 × z%`（线性），"按宽度适配"的反算（`preview/zoomFit.ts`）因此精确。
                   * `zoom` 必须保留：虚线线宽、播放头等**用 px 定位的子元素**要靠它一起缩放
                   * （它们的位置已经是百分比，只有粗细/偏移是 px）。
                   */
                  width: PREVIEW_W,
                  position: 'relative',
                  zoom: previewZoom / 100,
                }}
              >
                {/* adj226：SVG 层提到虚线层之上且默认不拦截命中——音符/歌词/描述头
                    （data-notepos/cipos/meta）各自 pointer-events: all 可点，
                    虚线的拖拽在音符外区域仍可用；此前 SVG 在虚线之下，
                    音符数字中心与行虚线重叠处点击被虚线拦截（拖拽而非联动）
                    adj244：SVG 自带页面白底 rect 会盖住虚线层，预览层将其透明化，
                    白底由 .score-page 提供——音符仍可点，虚线透过透明 SVG 可见 */}
                <div
                  className="preview-svg"
                  dangerouslySetInnerHTML={{ __html: svg }}
                  style={{ position: 'relative', zIndex: 1, pointerEvents: 'none' }}
                />
                {/* adj282：播放进度跟随色块（接近透明，随播放时钟滑动；未播放时自身不渲染） */}
                <PlayheadLayer
                  page={page}
                  pages={layout.pages}
                  noteSize={pageConfig.note_size}
                  rowSpans={rowSpansByPage}
                  scrollerRef={paneRef}
                />
                {/* adj987h（用户需求）：试听「标记段」的标记线（每行一段 + 两端小竖头 + 循环 ⟲） */}
                <PracticeMarkLayer page={page} noteSize={pageConfig.note_size} />
                {/* adj723b：**只读自检**（见 `PlayheadDiag` 说明；不参与渲染） */}
                <PlayheadDiag pageIndex={page.index} noteSize={pageConfig.note_size} />
                {/* adj905q 预览可视调试：三套边界虚线（时值格 / 墨迹 / 段层）。
                    ⚠ **刻意放在"排版辅助虚线"开关之外** —— 用户实测：只开调试开关时看不到线，
                    会以为调试开关无效（渲染块原本被 `showGuides &&` 包住了）。
                    画法按用户口径：**左边界只画上半部、右边界只画下半部**，
                    长度、分界与配色由引擎的 `computeDebugBounds` 给出（此处只消费）。 */}
                {dbgOfPage.map((b, bi) => {
                  /**
                   * adj905q 配色修正（用户看第一版图后暴露的问题）：原来"拍子=暖橙 `#e0533d`"与
                   * "增时线=金橙 `#c9922b`"**太接近**，图上分不出哪条是哪条 —— 调试线的首要要求是
                   * **一眼可辨**。改成高对比：拍子=红、增时线=青。
                   */
                  const palette =
                    b.kind === 'beat'
                      ? ['#d92b2b', '#f26060'] // 拍子边界：红
                      : b.kind === 'aug'
                        ? ['#0f9aa8', '#48c4d0'] // 增时线边界：青
                        : b.kind === 'note'
                          ? ['#8e5bd0', '#b28ae0'] // 音符时值边界：紫
                          : b.kind === 'ink'
                            ? ['#2f7fd0', '#5aa9e6'] // 本体（墨迹）边界：蓝
                            : ['#3f9e5a', '#7fc98f'] // 段层：绿
                  const stroke = palette[b.colorIndex % palette.length]
                  const top = b.side === 'L' ? b.yTop : b.yMid
                  const bottom = b.side === 'L' ? b.yMid : b.yBottom
                  return (
                    <div
                      key={`dbg${bi}`}
                      style={{
                        position: 'absolute',
                        left: pct(b.x),
                        top: pctY(top),
                        width: 0,
                        height: pctY(bottom - top),
                        borderLeft: `1px dashed ${stroke}`,
                        pointerEvents: 'none',
                      }}
                    />
                  )
                })}
                {guidesEnabled && (
                  <div
                    className="guide-layer"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      pointerEvents: 'none',
                      // adj226：isolation 封住内部 guide-line 的 z-index（否则 z-index:5
                      // 的虚线会越过 z-index:1 的 SVG 层拦截音符点击）
                      isolation: 'isolate',
                    }}
                  >
                    {/* 四边距 */}
                    <div
                      className="guide-line guide-h"
                      style={{ top: pctY(pageConfig.margin_top), left: 0, right: 0, cursor: 'ns-resize', pointerEvents: 'auto' }}
                      onPointerDown={(e) => startDrag({ key: 'margin_top', dir: 'v' }, e, pageConfig.margin_top)}
                      title="上边距（拖动调整）"
                    />
                    <div
                      className="guide-line guide-h"
                      style={{ top: pctY(page.height - pageConfig.margin_bottom), left: 0, right: 0, cursor: 'ns-resize', pointerEvents: 'auto' }}
                      onPointerDown={(e) => startDrag({ key: 'margin_bottom', dir: 'v', invert: true }, e, pageConfig.margin_bottom)}
                      title="下边距（拖动调整）"
                    />
                    <div
                      className="guide-line guide-v"
                      style={{ left: pct(pageConfig.margin_left), top: 0, bottom: 0, cursor: 'ew-resize', pointerEvents: 'auto' }}
                      onPointerDown={(e) => startDrag({ key: 'margin_left', dir: 'h' }, e, pageConfig.margin_left)}
                      title="左边距（拖动调整）"
                    />
                    <div
                      className="guide-line guide-v"
                      style={{ left: pct(page.width - pageConfig.margin_right), top: 0, bottom: 0, cursor: 'ew-resize', pointerEvents: 'auto' }}
                      onPointerDown={(e) => startDrag({ key: 'margin_right', dir: 'h', invert: true }, e, pageConfig.margin_right)}
                      title="右边距（拖动调整）"
                    />
                    {/*
                      adj1004（**用户 2026-10-19 要求**）：「排版模式下，第二页开始，页面上部不要显示描述头区那个虚框，
                      第二页开始边距以内都是词曲部的内容」。
                      ⇒ 描述头**只存在于第一页**：它的下端线与区域中线在**第 2 页起一律不画**
                      （否则页面上部凭空一个"描述头框"，看着像留了一块空白区）。
                    */}
                    {page.index === 0 && (
                      <>
                        {/* 描述头区域下端线（adj30：调整描述头内容区高度，与第一行曲部上端线区分） */}
                        <div
                          className="guide-line guide-h guide-desc"
                          style={{
                            top: pctY(metaAreaH(pageConfig) - pageConfig.body_margin_top),
                            left: pct(pageConfig.margin_left),
                            right: pct(pageConfig.margin_right),
                            cursor: 'ns-resize',
                            pointerEvents: 'auto',
                          }}
                          onPointerDown={(e) => startDrag({ key: 'descAreaH', dir: 'v' }, e, pageConfig.descAreaH)}
                          title="描述头高度（拖动调整）"
                        />
                        {/* adj304：描述头区域水平中线——浅灰竖向虚线（纯标注，居中参考，不可拖拽） */}
                        <div
                          className="guide-line guide-v guide-desc-mid"
                          style={{
                            left: pct((pageConfig.margin_left + (page.width - pageConfig.margin_right)) / 2),
                            top: pctY(pageConfig.margin_top),
                            bottom: pctY(page.height - (metaAreaH(pageConfig) - pageConfig.body_margin_top)),
                          }}
                          title="描述头区域中线（标注）"
                        />
                      </>
                    )}
                    {/* 行结构虚线：曲部行虚线（数字中心）/ 曲词间距 / 词曲间距 / 词部行虚线 */}
                    {rowGuidesOfPage.map((rg, ri) => (
                      <div key={ri} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                        {/* 曲部行虚线（adj72：数字中心为基准；多声部块内第 2+ 声部拖 height_shengbu 独立调声部间距）
                            adj79：行尾间距拆分——上一行有歌词（底部是词部）→ 曲部与上一行词部间距 height_ciqu_lyric；
                            上一行无歌词（底部是曲部）→ 曲部与曲部间距 height_ciqu
                            adj432：临时叠加段（{bz}/{dsb}）的段层行**换色 + 拖 segmentRowGap**——
                            段层是叠加层，拖它调的是"段层与主旋律的间距"，不是谱面行距（混用会破坏排版） */}
                        {(() => {
                          const isSeg = rg.segType !== undefined
                          const isUpper = rg.segLayer === 'upper'
                          // 段层：拖 segmentRowGap.{bz,dsb,tp}；bz 只有上层，dsb 有上下层（拖离中线 = 增大间距）
                          // adj629：tp（替谱段）画在所属歌词行上方，拖它调"与那条歌词行的间距"
                          const key = isSeg
                            ? rg.segType === 'bz'
                              ? 'segmentRowGap_bz'
                              : rg.segType === 'tp'
                                ? 'segmentRowGap_tp'
                                : 'segmentRowGap_dsb'
                            : ri === 0
                              ? 'body_margin_top'
                              : rg.voiceIdx > 0
                                ? 'height_shengbu'
                                : (rowGuidesOfPage[ri - 1]?.lyricRows.length ?? 0) > 0
                                  ? 'height_ciqu_lyric'
                                  : 'height_ciqu'
                          // 段层上层往上拖 = 增大间距（invert）；dsb 下层往下拖 = 增大间距（不 invert）
                          // adj629e：替谱层挂在其下方歌词行之上，`tp` 越大层越高 ⇒ 往上拖增大（同 isUpper）
                          const invert = isSeg && isUpper
                          const startVal = isSeg
                            ? rg.segType === 'bz'
                              ? (pageConfig.segmentRowGap?.bz ?? SEGMENT_ROW_GAP_DEFAULT.bz)
                              : rg.segType === 'tp'
                                ? (pageConfig.segmentRowGap?.tp ?? SEGMENT_ROW_GAP_DEFAULT.tp)
                                : (pageConfig.segmentRowGap?.dsb ?? SEGMENT_ROW_GAP_DEFAULT.dsb)
                            : ri === 0
                              ? pageConfig.body_margin_top
                              : rg.voiceIdx > 0
                                ? pageConfig.height_shengbu
                                : (rowGuidesOfPage[ri - 1]?.lyricRows.length ?? 0) > 0
                                  ? pageConfig.height_ciqu_lyric
                                  : pageConfig.height_ciqu
                          return (
                            <div
                              className={`guide-line guide-h guide-row${isSeg ? ' guide-seg' : ''}`}
                              style={{
                                top: pctY(rg.yCenter),
                                left: pct(pageConfig.margin_left),
                                right: pct(pageConfig.margin_right),
                                cursor: 'ns-resize',
                                pointerEvents: 'auto',
                              }}
                              onPointerDown={(e) => startDrag({ key, dir: 'v', invert }, e, startVal)}
                              title={
                                isSeg
                                  ? rg.segType === 'tp'
                                    ? '替谱段（第 k 段歌词 = 第 k 遍）与所属歌词行的间距（拖动调整）'
                                    : `${rg.segType === 'bz' ? '临时伴奏' : '临时多声部'}${isUpper ? '上层' : '下层'}间距（拖动调整）`
                                  : ri === 0
                                    ? '曲部上间距（与描述头间距，拖动调整）'
                                    : rg.voiceIdx > 0
                                      ? '声部行间距（拖动调整）'
                                      : (rowGuidesOfPage[ri - 1]?.lyricRows.length ?? 0) > 0
                                        ? '曲部与上一行词部间距（拖动调整）'
                                        : '曲部与曲部间距（拖动调整）'
                              }
                            />
                          )
                        })()}
                        {/* 词部行虚线（adj72/73：每行歌词一条，歌词行区域中心；第 1 行拖曲词距、后续行拖歌词行距；quci/cici 独立线已移除） */}
                        {rg.lyricRows.map((lr, k) => (
                          <div
                            key={`lc${k}`}
                            className="guide-line guide-h guide-lyric-row"
                            style={{
                              top: pctY(lr.center),
                              left: pct(pageConfig.margin_left),
                              right: pct(pageConfig.margin_right),
                              cursor: 'ns-resize',
                              pointerEvents: 'auto',
                            }}
                            onPointerDown={(e) =>
                              startDrag(
                                // adj629g：按键**歌词行序号**选目标：第 1 行 = 歌词区↔曲部（quci），
                                // 第 2 行及以后 = 歌词行之间（cici）。不能按"在本行里的序号"判——
                                // 替谱层插进来后，第 2 行歌词会被归到替谱那一行、序号又变 0（用户报）。
                                { key: (lr.line ?? k) === 0 ? 'height_quci' : 'height_cici', dir: 'v' },
                                e,
                                (lr.line ?? k) === 0 ? pageConfig.height_quci : pageConfig.height_cici,
                              )
                            }
                            title={
                              (lr.line ?? k) === 0
                                ? '歌词行 1（与曲部间距，拖动调整）'
                                : `歌词行 ${(lr.line ?? k) + 1} 间距（与上一行歌词，拖动调整）`
                            }
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {/* adj965d（EP-13）：角落的手势提示 + 「调整对象」切换器。
          显示条件 = 三条前提齐（排版辅助开 + 该层已启用 + 有内容）；**切换器**只在两层都可用时出现
          （用户口径：只有一层或都没有，不需要切换器）。
          `position: sticky` 而不是 absolute：`.preview-pane` 本身是滚动容器，
          绝对定位会随内容滚走，sticky 才能始终贴在预览区右下角。 */}
      {overlayTarget !== null && (
        <div className="preview-overlay-hint">
          <span className="poh-title">
            {overlaySwitcher
              ? overlayCopy.editTargetTitle
              : overlayCopy.editTargetOne(overlayTarget === 'wm' ? overlayCopy.layerWm : overlayCopy.layerBg)}
          </span>
          {overlaySwitcher &&
            (['wm', 'bg'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={`poh-chip${overlayTarget === k ? ' is-active' : ''}`}
                aria-pressed={overlayTarget === k}
                onClick={() => setOverlayEditLayer(k)}
              >
                {k === 'wm' ? overlayCopy.layerWm : overlayCopy.layerBg}
              </button>
            ))}
          {/* 该层还只在面板草稿里 ⇒ 当面说一句（"加一层保险"，用户 2026-10-15 要求） */}
          {overlayUnsaved && <span className="poh-unsaved">⚠ {overlayCopy.notInScore}</span>}
          <span className="poh-keys">{overlayCopy.gestureKeys}</span>
        </div>
      )}
    </div>
  )
}


/**
 * adj427：把播放轨道按「**页 + 曲行 + 声部 + 音色**」分组，供每组建一个色块。
 *
 * 为什么必须按这个键分组：重叠区（bz 伴奏 / dsb 第二声部）与主旋律在**同一曲行（group）**内
 * **同时发声**——旧实现「每个 group 只取一个当前段」，于是重叠区**只画出一个色块**。
 * （既有 Q1/Q2 多声部之所以能显示多块，是因为它们是**不同的 group**。）
 * 按 (页, 曲行, 声部, 音色) 分组后，重叠区上下两层各有自己的色块、同步移动，
 * 与多声部的表现一致。
 *
 * 结果按 track 引用缓存（track 每次开播才换新对象），避免逐帧重建分组。
 */



/**
 * adj723b：色块链路的**只读自检**。
 *
 * 背景：用户报「播放时 `{dsb}` 那两行没有任何色块」，但引擎侧审计（`_r1` 临时脚本，用其原谱逐字）
 * 显示"**可发声事件 0 个缺色块、全曲 69 个采样点 0 次无块**"——即问题只在"引擎 → 屏幕"这一段，
 * 而远程无法看到用户浏览器里的真实状态。这里把**链路上每一步的实况**挂到 `window.__ijipuPlayhead()`，
 * 用户在控制台一句话就能取回：数据到了吗 / 定位算出来了吗 / DOM 里画出来了吗 / 画在哪。
 *
 * 为什么不在 `PlayheadLayer` 里做：那一层在"未播放"时会 `return null`（不渲染），
 * 挂不上任何东西；本组件**恒渲染**（`null` 输出），因此任何时刻都能被调用。
 *
 * 生产构建同样保留（只读、无副作用、仅一个函数引用），因为下次再出这类"只有用户环境复现"
 * 的问题时它是唯一能取证的手段；体积代价是一个闭包。
 */
function PlayheadDiag({ pageIndex, noteSize }: { pageIndex: number; noteSize: number }) {
  const currentMs = useDocStore((s) => s.currentMs)
  const track = useDocStore((s) => s.playheadTrack)
  useEffect(() => {
    const dump = (): string => {
      const groups = trackKeysOf(track)
      const mine = [...groups].filter(([k]) => k.startsWith(`${pageIndex}|`))
      const lines: string[] = [
        `track=${track.length} 段  currentMs=${currentMs.toFixed(1)}`,
        `本页组数=${mine.length}（全部 ${groups.size}）  noteSize=${noteSize}`,
      ]
      for (const [k, segs] of mine) {
        const pos = playheadPosIn(segs, currentMs, pageIndex, noteSize)
        lines.push(
          `  ${k}  段=${segs.length}  ${pos ? `★可见 x=${pos.x.toFixed(1)} y=[${pos.yTop.toFixed(1)}, ${pos.yBottom.toFixed(1)}] w=${pos.width.toFixed(1)}` : '（当前不可见）'}`,
        )
      }
      const dom = document.querySelectorAll('.playhead-marker')
      lines.push(`DOM 里 .playhead-marker = ${dom.length} 个`)
      dom.forEach((el, i) => {
        const st = (el as HTMLElement).style
        lines.push(
          `  #${i} left=${st.left} top=${st.top} w=${st.width} h=${st.height} bg=${st.background} box=${st.boxShadow}`,
        )
      })
      lines.push(`轨道前 3 项：${track.slice(0, 3).map((t) => `${t.group}/${t.instrument ?? ''}/${t.playVoice ?? ''}@${t.atMs.toFixed(0)}ms yTopMin=${t.yTopMin ?? '-'}`).join(' | ')}`)
      return lines.join('\n')
    }
    ;(window as unknown as { __ijipuPlayhead?: () => string }).__ijipuPlayhead = dump
  }, [track, currentMs, pageIndex, noteSize])
  return null
}

/** 色块/曲行定位只关心这几个字段（`docStore.playheadTrack` 的一项） */
type PlayheadSegLike = {
  pageIndex: number
  group: number
  x: number
  width: number
  /** 音符基线 y（页面坐标）——纵向行判定用它 */
  y: number
  atMs: number
  durationMs: number
  playVoice?: 'accomp' | 'main' | 'second'
}

/**
 * 此刻正在响的**主声部**段（多声部同时响时取最晚开始的那条，与色块/球同口径）。
 *
 * 为什么要有它：行归属不能按"行时间"猜（多声部/跨行连音时行时间与发声不同步），
 * 只能由当前发声的那条段反推它在哪一行（同 `camera.ts` 的 `rowAt` 口径）。
 */
function currentMainSeg(
  track: readonly PlayheadSegLike[],
  pageIndex: number,
  t: number,
): PlayheadSegLike | null {
  let best: PlayheadSegLike | null = null
  for (const s of track) {
    if (s.pageIndex !== pageIndex) continue
    if (s.playVoice !== undefined && s.playVoice !== 'main') continue
    if (!(s.atMs <= t && t < s.atMs + s.durationMs)) continue
    if (!best || s.atMs >= best.atMs) best = s
  }
  return best
}

/**
 * adj1094：`t` 之前**最后开始**的主声部段（不要求此刻仍在响）。
 *
 * 用途：纵向滚动按"行末提前量"提前切到下一行——行首前 `leadMs` 就已经要看到新行了，
 * 而那时当前行可能还在响、新行还没开始，所以不能只认"正在响的段"。
 */
function lastMainSegAtOrBefore(
  track: readonly PlayheadSegLike[],
  pageIndex: number,
  t: number,
): PlayheadSegLike | null {
  let best: PlayheadSegLike | null = null
  for (const s of track) {
    if (s.pageIndex !== pageIndex) continue
    if (s.playVoice !== undefined && s.playVoice !== 'main') continue
    if (s.atMs <= t && (!best || s.atMs >= best.atMs)) best = s
  }
  return best
}

/**
 * adj282：跟随色块渲染层——仅订阅 currentMs/playheadTrack，避免 PreviewPane 主组件
 * 随播放逐帧重渲染（SVG 层不重建，仅本轻量色块刷新）。
 * adj299：每曲行（group）独立一个色块（按各自拍段滑动、按 voice 配色、各自行高）。
 */
function PlayheadLayer({
  page,
  pages,
  noteSize,
  rowSpans,
  scrollerRef,
}: {
  page: ScorePage
  pages: ScorePage[]
  noteSize: number
  /**
   * adj1090：每页**每个曲行**的纵向范围（引擎 `rowSpansOfPage`）——
   * 曲部（同组多声部 + 段层）到它最后一行歌词。试听换行时据此把整组滚进视界。
   */
  rowSpans: RowSpan[][]
  /** adj1171：本预览自己的滚动容器；对拍台里同时挂着主预览，不能再用 document 全局找 */
  scrollerRef: RefObject<HTMLDivElement | null>
}) {
  const currentMs = useDocStore((s) => s.currentMs)
  const track = useDocStore((s) => s.playheadTrack)
  // adj1048：拍网格（跳跳球按**拍**落，不按音落）；相位由 beatPhaseOf 投票得出
  const beatMs = useDocStore((s) => s.playheadBeatMs)
  const beatBars = useDocStore((s) => s.playheadBarStartsMs)
  // adj1089：试听跟随滚动读**同一个**平移方式（出片侧是 `renderer.ts` 读的同一个键）
  const panMode = useUiStore((s) => s.panMode)
  // adj1089：`beat` 模式的拍网格起点（第一拍的时刻）
  const anchorMs = useDocStore((s) => s.playheadAnchorMs)
  // adj1089：同一拍 / 同一小节里只居中一次（逐帧都算就退化成连续跟随）
  const panKeyRef = useRef('')
  // adj1092：本页的段（按拍/小节平移要用它判断"行变了"与"新行的第一块"）
  const segsOfPage = useMemo(() => track.filter((s) => s.pageIndex === page.index), [track, page.index])
  // adj1094：行末提前平移量（拍 → ms）；10:00 起默认半拍，最多 2 拍
  const rowLeadBeats = useUiStore((s) => s.rowLeadBeats)
  const rowLeadMs = Math.max(0, Math.min(2, rowLeadBeats)) * Math.max(0, beatMs)
  // adj1090：同一视觉行里只按"行"滚一次（首次播放 / 换行各一次）
  const rowKeyRef = useRef('')
  // adj1062：跨页球的纵向换算要用到预览缩放（与 `.preview-zoom-scale` 的 zoom 同源）
  const previewZoom = useUiStore((s) => s.previewZoom)

  /**
   * adj1062：各页顶在**同一套纵向坐标**里的位置（引擎单位）。
   *
   * 预览是把多页竖排、页间留 `PAGE_GAP_PX` 的。球的锚点本来是"页内坐标"，
   * 跨页时会从本页末直接跳到下一页首（= 用户看到的"消失再在其它地方出现"）。
   * 把所有页的 `top` 加上各自的页顶偏移，球就能从上一页末**飞进**下一页首；
   * 落地那一刻再交接给下一页的图层（`BallPos.pageIndex`）。
   *
   * 换算：页内容按 `PREVIEW_W × zoom% / page.width` 缩放，页间距是**未缩放**的 CSS px，
   * 所以先除以缩放比折回引擎单位。
   */
  const pageOffsets = useMemo(() => {
    const out: number[] = []
    let acc = 0
    for (const p of pages) {
      out.push(acc)
      const scale = ((PREVIEW_W * previewZoom) / 100) / Math.max(1, p.width)
      acc += p.height + (scale > 0 ? PAGE_GAP_PX / scale : 0)
    }
    return out
  }, [pages, previewZoom])

  /**
   * adj1062：**全曲**的主声部落点（跨页），按 `t0` 升序。
   *
   * `trackKeysOf` 的键里带页号，遍历全部页才能拿到"下一页的第一个色块"；
   * 逐帧重建代价大，故按 `track / pageOffsets / noteSize` 记忆（播放中它们不变）。
   */
  const ballAnchors = useMemo(() => {
    // adj1095：球只落在**第一声部**（主声部）上——多声部同时起音时不再落到 Q2/Q3 上
    const ballVoice = primaryVoiceOf(track)
    const out: BallAnchor[] = []
    for (const [, segs] of trackKeysOf(track)) {
      for (const s of segs) {
        if (s.playVoice !== undefined && s.playVoice !== 'main') continue
        if (s.voice !== ballVoice) continue
        if (s.durationMs <= 0) continue
        const off = pageOffsets[s.pageIndex] ?? 0
        out.push({
          t0: s.atMs,
          t1: s.atMs + s.durationMs,
          cx: s.x + s.width / 2,
          top: (s.yTopMin ?? s.y - noteSize * 1.6) + off,
          x: s.x,
          w: s.width,
          pageIndex: s.pageIndex,
        })
      }
    }
    out.sort((a, b) => a.t0 - b.t0)
    return out
  }, [track, pageOffsets, noteSize])

  /**
   * adj895（用户要求）：**播放跟随滚动**——把色块保持在"安全区"内，而不是等它贴到视界边上。
   *
   * 为什么单独放在这里、而不是改 `PreviewPane` 里原来那条滚动 effect：
   *   那条 effect 是**单击音符居中**用的，且被 `adj723y` 加过一道"已完整可见就不滚"的保护
   *   （为了修"双击播放失效"）。两者诉求相反：单击要"别乱动"，播放要"提前跟着走"。
   *   合在一起改必然伤到另一边 ⇒ **各管各的**。
   *
   * 为什么放在本组件：主组件订阅 `currentMs` 会让整层 SVG 逐帧重建（`adj282` 明确避免），
   * 而本组件本来就每帧渲染 ⇒ 多一条 effect 不扩大重渲染面。
   *
   * adj1089（用户 2026-10-23 口径）：按 `uiStore.panMode` 分两条路——
   *   · `follow`（默认）：下面这套安全带，**行为与 adj895 完全一致**；
   *   · `beat` / `bar`：每拍 / 每小节把色块滚到画面中间，再做同一套"左右露白 ≤10%"夹紧
   *     （算式直接调引擎 `clampRowCenter`，与出片同源，见 `followScroll.ts`）。
   *
   * adj1092（用户实报「按小节时，从行末移到行首不会平移，行首那一小节看不到」）：
   * `beat` / `bar` 的节流键里**加上行**——行变了就滚，且用**新行的第一块**居中。
   * 只按小节序号节流时，行首那一下会被上一行最后一个小节吃掉（或与小节网格差几毫秒而错过）。
   *
   * adj1093（用户实报「按小节时上一小节读得太晚、接不上」）：`bar` 模式再加一道
   * **行内 4/5 安全推**——色块越过安全带右沿就按跟随规则推（本行最后一个小节不推）。
   *
   * ⚠ hook 必须在下面那两个 `return null` **之前**（条件调用 hooks 会破坏顺序）。
   */
  useEffect(() => {
    if (track.length === 0 || currentMs <= 0) return
    if (panMode === 'follow') {
      // 色块由本层渲染 ⇒ 直接量它在屏幕上的位置最省事（不用把 SVG 坐标换算回视口坐标）
      const scroller = scrollerRef.current
      const marker = scroller?.querySelector('.playhead-marker')
      if (!(marker instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return
      const scRect = scroller.getBoundingClientRect()
      const scrollLeft = scroller.scrollLeft
      const target = followScrollTargetX({
        xInView: marker.getBoundingClientRect().left - scRect.left,
        viewW: scroller.clientWidth,
        scrollW: scroller.scrollWidth,
        scrollLeft,
      })
      // `null` = 还在安全区里 ⇒ 什么都不做（这正是"顺滑"的来源：极少真的调滚动）
      if (target === null) return
      // 目标几乎没变就不打扰 —— 免得连续两次 `smooth` 互相打断（那才会看出"一跳一跳"）
      if (Math.abs(target - scroller.scrollLeft) < 1) return
      scroller.scrollTo({ left: target, behavior: 'smooth' })
      return
    }

    /**
     * beat / bar（adj1092）：**同一拍/小节 + 同一行内只滚一次**；行变了也滚。
     *
     * 行也进 key 是这次的关键：只按小节序号节流时，行首那一下会被上一行最后一个小节吃掉
     * （或与小节网格错开几毫秒），于是"行末 → 行首"不发生平移、行首那一小节留在视界外。
     * `panFocusAt` 里"行变了就用新行的第一块居中"，行首因此一定进视界。
     */
    const spans = rowSpans[page.index] ?? []
    /**
     * 页面元素按**序号**取、再按"这一页实际渲染宽 / 页宽"折成内容 px：
     * 预览的缩放有两层（pageConfig 字号 + 用户预览比率），逐处自己算缩放迟早算错。
     */
    const scroller = scrollerRef.current
    const pageEl = scroller?.querySelectorAll('.preview-zoom-scale')[page.index]
    if (!(pageEl instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return
    const scRect = scroller.getBoundingClientRect()
    const pageRect = pageEl.getBoundingClientRect()
    if (!(pageRect.width > 0) || !(page.width > 0)) return
    const scale = pageRect.width / page.width
    const pageLeft = pageRect.left - scRect.left + scroller.scrollLeft

    // ① 拍/小节 + 行：行变了也滚（adj1092）；行末提前（adj1094）由 `leadMs` 控制
    const focus = panFocusAt({
      mode: panMode === 'bar' ? 'bar' : 'beat',
      t: currentMs,
      beatMs,
      anchorMs,
      bars: beatBars,
      segs: segsOfPage,
      spans,
      leadMs: rowLeadMs,
    })
    if (focus !== null && panKeyRef.current !== `${panMode}:${focus.key}`) {
      panKeyRef.current = `${panMode}:${focus.key}`
      const target = panScrollTargetX({
        blockCenterX: pageLeft + focus.blockCenterX * scale,
        rowX0: pageLeft + focus.rowX0 * scale,
        rowX1: pageLeft + focus.rowX1 * scale,
        viewW: scroller.clientWidth,
        scrollW: scroller.scrollWidth,
      })
      if (target !== null && Math.abs(target - scroller.scrollLeft) >= 1) {
        scroller.scrollTo({ left: target, behavior: 'smooth' })
      }
    }

    /**
     * ② adj1093：**行内 4/5 安全推**——按小节时，若色块在"下一小节到来之前"就快贴到右视界，
     * 也按跟随的规则推一次，免得上一小节读得太晚、接不上。
     * 本行**最后一个小节不推**（那里由"行末右侧露白 ≤10%"接管；只推右沿，不推左沿）。
     */
    if (panMode !== 'bar') return
    const cur = currentMainSeg(track, page.index, currentMs)
    if (cur === null) return
    const span = spans.find((s) => cur.y >= s.top - 0.5 && cur.y <= s.bottom + 0.5)
    if (span === undefined) return
    const inSpan = segsOfPage.filter((s) => s.y >= span.top - 0.5 && s.y <= span.bottom + 0.5)
    const lastBar = spanLastBarStart(beatBars, inSpan)
    const target = safetyPanTargetX({
      xInView: pageLeft + cur.x * scale - scroller.scrollLeft,
      viewW: scroller.clientWidth,
      scrollW: scroller.scrollWidth,
      scrollLeft: scroller.scrollLeft,
      inLastBar: cur.atMs >= lastBar - 0.5,
    })
    if (target !== null && Math.abs(target - scroller.scrollLeft) >= 1) {
      scroller.scrollTo({ left: target, behavior: 'smooth' })
    }
  }, [currentMs, track, segsOfPage, rowSpans, panMode, beatMs, beatBars, anchorMs, rowLeadMs, page.index, page.width, scrollerRef])

  /**
   * adj1090（用户 2026-10-23 口径）：**纵向**滚动——首次播放 / 换行时，判断"曲部 + 词部"
   * 整行是否在**高度**上进视界（多行歌词、同组多声部都算同一行），没显示全就把页面滚上去。
   *
   * 与横向的分工：横向（adj895/adj1089）管"这一行左右看得到哪一段"，纵向只管"这一行上下
   * 看不看得全"，两个轴各滚各的。
   *
   * 触发时机：**每个曲行一次**（`rowKeyRef` 记住当前曲行）。不能逐帧算——那会在播放中
   * 把用户手动滚到的位置一直抢回去；也必须"行没变就不动"，否则观感是页面在抖。
   * 首次播放（key 从 `''` 变成某一行）同样算一次，正是用户说的"首次开始播放"。
   */
  useEffect(() => {
    if (track.length === 0 || currentMs <= 0) return
    const spans = rowSpans[page.index] ?? []
    if (spans.length === 0) return
    const seg = lastMainSegAtOrBefore(track, page.index, currentMs + rowLeadMs)
    if (!seg) return
    // 行归属：当前发声段的**基线 y** 落在哪个曲行的纵向范围里（同组多声部落在同一个 span）
    const spanIdx = spans.findIndex((s) => seg.y >= s.top - 0.5 && seg.y <= s.bottom + 0.5)
    if (spanIdx < 0) return
    const key = `${page.index}:${spanIdx}`
    if (rowKeyRef.current === key) return
    /**
     * 页面元素按**序号**取，不按色块反查：跨页那一刻可能两页同时有色块，
     * `document.querySelector('.playhead-marker')` 会拿到前一页的块 ⇒ 页面顶算错。
     */
    const scroller = scrollerRef.current
    const pageEl = scroller?.querySelectorAll('.preview-zoom-scale')[page.index]
    if (!(pageEl instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return
    const scRect = scroller.getBoundingClientRect()
    const pageRect = pageEl.getBoundingClientRect()
    if (!(pageRect.height > 0) || !(page.height > 0)) return
    // 预览缩放有两层（字号 + 预览比率）⇒ 一律按"实际渲染高 / 页高"折回内容 px，不自己算
    const scale = pageRect.height / page.height
    const pageTop = pageRect.top - scRect.top + scroller.scrollTop
    const target = followScrollTargetY({
      top: pageTop + spans[spanIdx].top * scale,
      bottom: pageTop + spans[spanIdx].bottom * scale,
      viewH: scroller.clientHeight,
      scrollH: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
    })
    rowKeyRef.current = key
    // `null` = 这一行本来就整行可见（含留边）⇒ 什么都不做
    if (target === null) return
    if (Math.abs(target - scroller.scrollTop) < 1) return
    scroller.scrollTo({ top: target, behavior: 'smooth' })
  }, [currentMs, track, rowSpans, rowLeadMs, page.index, page.height, scrollerRef])

  if (track.length === 0 || currentMs <= 0) return null
  // adj427：按「本页 + 曲行 + 声部 + 音色」**逐组**定位——重叠区（bz 伴奏 / dsb 第二声部）
  // 与主旋律**同曲行同时发声**，故各有自己的色块、同步移动（与多声部同理）；
  // 旧实现「每个 group 只取一个当前段」在重叠区只画得出一块。
  const items = [...trackKeysOf(track)].filter(([k]) => k.startsWith(`${page.index}|`))
  const colorMap = instrumentColorMap(track)
  const pct = (v: number) => `${((v / page.width) * 100).toFixed(3)}%`
  const pctY = (v: number) => `${((v / page.height) * 100).toFixed(3)}%`

  /**
   * adj1047：试听时的**跳跳球**（用户要求）。
   * 与出片同一条口径：每拍一条抛物线，落点 = 色块上沿，弹起高度 = 色块高度。
   * 只画主声部那一颗（多声部各画一颗会打架）。
   *
   * adj1062：锚点用**全曲、跨页**的 `ballAnchors`，并按 `BallPos.pageIndex`（这一拍从哪页起飞）
   * 决定哪一层画——跨页飞行时只有起飞页那一层画球（`top` 会超出 100%，正好飞过页间空隙），
   * 落地那拍 `pageIndex` 换成下一页 ⇒ 由下一页的图层接着画，**不再"旧页落下、新页冒出"**。
   * （前提：各页等宽，预览就是这么排的；页宽不同时 x 需要再加页左偏移。）
   */
  let ball: React.JSX.Element | null = null
  if (beatMs > 0 && ballAnchors.length > 0) {
    /**
     * adj1061：`beatBars` 现在是**展开后逐遍**的小节起点（反复/跳转每一遍都有），
     * 拍网格由它逐小节给出；`beatPhaseOf` 只作"没有小节起点"时的兜底
     * （它逐帧遍历全部锚点投票，能省则省）。
     * 末尾那条「曲末」不是小节开头，`ballAt` 自己会跳过它（只当自由落体的时刻）。
     */
    const beatAnchor = beatBars.length > 0 ? 0 : beatPhaseOf(ballAnchors, beatMs)
    const bp = ballAt(
      ballAnchors,
      currentMs,
      beatMs,
      beatAnchor,
      noteSize * 3.2,
      beatBars,
      BALL_LANDING_TIMING,
      // adj1286：整体提前 100ms（落点原本比色块切换晚约 100ms）
      BALL_LEAD_MS,
    )
    if (bp && (bp.pageIndex === undefined || bp.pageIndex === page.index)) {
      const rad = noteSize * 0.28
      // `bp.y` 是跨页坐标；减掉本页页顶才是本页内的 top（跨页飞行时会 <0 或 >page.height）
      const localTop = bp.y - (pageOffsets[page.index] ?? 0)
      /**
       * adj1062：球**底边**贴在色块上沿（与出片 `renderer.ts` 同口径）。
       * 旧写法 `localTop − rad` 把**球心**放在色块上沿 ⇒ 球有一半陷进色块，
       * 看起来会比实际落地早半个球（用户截图里"球已落下"的观感来源之一）。
       * `squash` 以**球底**为不动点压扁（预览/出片共用 `BALL_SQUASH_X/Y`）。
       */
      const squash = bp.squash ?? 0
      ball = (
        <div
          className="beat-ball"
          style={{
            left: pct(bp.x - rad),
            top: pctY(localTop - rad * 2),
            width: pct(rad * 2),
            transform: `scaleX(${1 + BALL_SQUASH_X * squash}) scaleY(${1 - BALL_SQUASH_Y * squash})`,
            transformOrigin: '50% 100%',
          }}
          aria-hidden="true"
        />
      )
    }
  }

  return (
    <>
      {items.map(([key, segs]) => {
        const pos = playheadPosIn(segs, currentMs, page.index, noteSize)
        if (!pos) return null
        // adj427：按**音色**取色（不同音色不同颜色；同一音色恒定同色）
        const base = playheadBaseOf(pos, colorMap)
        return (
          <div
            key={key}
            className="playhead-marker"
            style={{
              left: pct(pos.x),
              top: pctY(pos.yTop),
              width: pct(pos.width),
              height: pctY(pos.yBottom - pos.yTop),
              background: `${base} 0.32)`,
              boxShadow: `inset 0 0 0 1px ${base} 0.5)`,
            }}
          />
        )
      })}
      {/* adj1047：跳跳球（色块上方，拍点落地） */}
      {ball}
    </>
  )
}
