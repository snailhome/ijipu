/**
 * export/video/renderer.ts — 把「相机 + 页面」画成画面（宿主层）
 *
 * 分工：**引擎**算"这一刻相机在哪、多大"（`cameraAt`，纯函数）；
 * **这里**把页面图画出来（SVG → 位图 → 按相机取景）。
 *
 * ## 为什么按"页面"光栅，而不是拼一条大图
 *
 * 3 分钟的谱有 30+ 页；拼整条带会得到几万像素高的画布，WebView 里分配失败。
 * 这里每页一张位图（按 `RASTER_SCALE` 放大，保证推近不糊），逐帧只画当前页的一块。
 *
 * ## 为什么用用户自己的页面配置
 *
 * 相机方案的全部意义就在这：**不重排**。用户看到什么样的 A4 版面，视频里就是什么样，
 * 只是镜头推近/平移。所以这里吃 `pageConfig`（来自文档），不吃"视频预设"——
 * 预设只决定**输出画布多大**。
 */
import {
  parseJps,
  layoutScore,
  renderScoreToSvg,
  buildPlaySequence,
  inferBpm,
  buildRectTrack,
  buildFlowView,
  rectsActiveAt,
  buildCameraTrack,
  cameraAt,
  resolvePracticeRange,
  slicePlaySequenceByRange,
  ballAt,
  beatPhaseOf,
  // adj1095：多声部色块按"声部 + 音色"分色（与试听同一套盘），跳跳球只落第一声部
  instrumentColorMap,
  playheadBaseOf,
  primaryVoiceOf,
  hasNoteId,
  BALL_LANDING_TIMING,
  BALL_SQUASH_X,
  BALL_SQUASH_Y,
  DYNAMIC_PRESETS,
  type DynamicPresetId,
  type PageConfig,
  type CameraFrame,
  type CameraTrack,
  type PanMode,
  type PlayEvent,
} from '@ijipu/engine'
import { svgToCanvas } from '../export'
import { withOverlay } from '../../store/overlayAssets'
import { pickPracticeCandidate } from './practicePick'
import { CARD_SANS, DEFAULT_CARD_STYLE, type CardStyle } from './cardTemplates'
// adj1265：片头/片尾卡的画笔抽到 `cardPainter.ts`（连续动态谱复用同一份，尺寸按视频宽高）
import { createCardPainter } from './cardPainter'
// adj1148：前奏等待的两条纯计算（时间轴后移 / 定格帧时刻；smoke 直接断言这一份）
import { preRollFrameMs, shiftSequenceBy } from './preRoll'

/**
 * 页面位图的放大倍数：4 倍跟拍时，取景框宽 = 1080/4 = 270 页面单位，
 * 而位图按 3 倍存（595×3 = 1786px 宽）⇒ 取 270 宽那段约 810px，再放大到 1080，
 * 略软但可接受；再高会吃内存（每页 ≈ 18MB）。
 */
export const RASTER_SCALE = 3

/** 高亮块配色：**按声部 + 音色**取色（`playheadBaseOf`），这两个常量只留作单声部默认/排查参照 */
export const HIGHLIGHT_FILL = 'rgba(255, 93, 108, 0.20)'
export const HIGHLIGHT_STROKE = 'rgba(255, 93, 108, 0.85)'
/** 跳跳球颜色（同一套强调色，落地那一刻最显眼） */
export const BALL_FILL = 'rgba(255, 93, 108, 0.95)'

/** 2D 上下文（离屏画布与页面画布都行；编码时用 OffscreenCanvas 不占可见画布） */
export type DrawCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * 片头卡最后 0.7 秒：从"完整卡片"淡入/推近到第一拍（`adj1067` 定下的口径）。
 *
 * 为什么要导出这个常量：**视频封面**要取"卡片最完整"的那一刻，而那一刻正是
 * `leadInMs − 本值`（默认 `3700 − 700 = 3000ms`）。封面时间必须与这里同源，
 * 否则改了片头节奏、封面就会取到淡出中途的半透明帧（见 `mp4.ts` 的 `coverMs`）。
 */
export const INTRO_PAN_MS = 700

export interface DynamicSession {
  camera: CameraTrack
  /** 每页一张已光栅化的画布 */
  pages: HTMLCanvasElement[]
  totalMs: number
  /** 音乐结束（最后一拍结束） */
  musicEndMs: number
  /** 片尾卡开始：预览播到这里就淡出（导出继续到 totalMs，含完整片尾） */
  cardStartMs: number
  width: number
  height: number
  /** 播放事件（给音轨离线渲染用，与画面同一份序列） */
  events: PlayEvent[]
  /** 拍速（音轨渲染要用同一个值，否则音画对不上） */
  bpm: number
  /**
   * adj1119：会话实际用的**片头时长**（`cards:false` 时是 0）。
   * 伴奏轨要按它在最前面补静音（`buildAccompanimentTrack`）。
   */
  leadInMs: number
  /**
   * adj1148：**前奏等待**（片头卡之后、谱面第 1 拍之前那段音频）。
   *
   * 这段时间里伴奏已经在放，画面**定格在谱面第 1 拍**（不画片头卡）；
   * 伴奏轨据此把"起放时刻"提到 `leadInMs`（见 `accompanimentPlan`）。
   */
  headWaitMs: number
  /**
   * adj1119：**标记段被切掉的那段时长**（整曲 = 0）。
   * 伴奏轨的起点 = `offsetMs + sourceStartMs`，不能只按 `offsetMs` 从曲首算。
   */
  sourceStartMs: number
  /** 画一帧，返回相机位置与"是否在跟拍"（供界面显示） */
  draw: (ctx: DrawCtx, tMs: number) => { frame: CameraFrame; following: boolean }
}

/**
 * 建一次放映会话。
 *
 * @param code       `.jps` 源码
 * @param presetId   输出画布（只决定宽高与比例）
 * @param pageConfig **用户自己的**页面配置（决定版面，绝不能被预设覆盖）
 * @param bpm        覆盖拍速（缺省按谱面推断）
 */
export async function createDynamicSession(
  code: string,
  presetId: DynamicPresetId,
  pageConfig: PageConfig,
  bpm?: number,
  opts?: {
    followZoom?: number
    /** 只导某个标记段（起止音符 id + 用户选过的候选遍次）；缺省 = 整曲 */
    range?: { startId: string; endId: string; pass?: number } | null
    /** 片头时长（ms，默认 2000；0 = 不要片头）。片头是**前置静音**，音画一起后移 */
    leadInMs?: number
    /**
     * adj1148：**前奏等待**（ms；0 = 没有）。谱面第 1 拍之前那段伴奏要照放，
     * 画面定格在第 1 拍（片头卡之后、不画卡）。标记段导出没有"前奏"这回事，传了也忽略。
     */
    headWaitMs?: number
    /** 片尾时长（ms，默认 2500；0 = 不要片尾）。片尾是品牌落版，给个入口要人 */
    endCardMs?: number
    /**
     * **整片时长上限**（ms，含片头/片尾；adj1064）。超出时先把音乐裁短，
     * 保证片头、片尾卡都在上限之内——不能像以前那样在 `encodeMp4` 末尾硬截，
     * 那会把片尾卡截掉（用户实报：「不管 3 分钟、标记段还是整首，都要有片头片尾」）。
     */
    maxMs?: number
    /** 跳跳球（节拍指示，默认开） */
    ball?: boolean
    /** adj1073：片头/片尾卡片模板（预设或以后的自定义样式；缺省 = 品牌深空蓝） */
    cardStyle?: CardStyle
    /**
     * adj1089：行中平移方式（`follow` / `beat` / `bar`）。
     *
     * 由**调用方**从 `uiStore.panMode`（L1 偏好）取来传进来，本文件不读 store：
     * 预览（`DynamicFrameOverlay`）会订阅它、导出与命令行出片在调用时取一次，
     * 这样"设置里改了下拉"能立刻触发会话重建，而不是继续放旧 `pans`。
     * 缺省 `beat`（adj1094 起宿主默认按拍；跟随仍可选）。
     */
    panMode?: PanMode
    /**
     * adj1094：**行末提前平移量**（单位：拍，默认半拍、最多 2 拍）。
     *
     * 三种平移模式共用：换到下一行（横向 + 纵向）提前这么多拍完成，好提前看到下一行。
     * 与 `panMode` 一样由调用方从 `uiStore.rowLeadBeats`（L1）取来传进来，本文件不读 store。
     */
    rowLeadBeats?: number
    /**
     * adj1164：相机位选定的**全篇统一音色**（音色名 ref；不传/空 = 自动随谱）。
     *
     * 只影响播放序列里的 `instrument`（音频与色块配色同源），不改谱面/排版；
     * 传进来时由 `buildPlaySequence` 覆盖所有声部与曲内 `@` 切换。
     */
    instrumentOverride?: string
    /** 乐谱库短链代码（3-6 位小写字母）；空 = 片尾不画短链 */
    shortCode?: string
  },
): Promise<DynamicSession> {
  const preset = DYNAMIC_PRESETS[presetId]
  const card = opts?.cardStyle ?? DEFAULT_CARD_STYLE
  /**
   * adj1074：自定义卡片可以带一张背景图（data URL/文件 URL）。
   * 在这里一次性解码，之后预览与导出都画同一张，不在每帧 new Image。
   */
  let cardImage: HTMLImageElement | null = null
  if (card.backgroundImage) {
    try {
      cardImage = new Image()
      cardImage.src = card.backgroundImage
      await cardImage.decode()
    } catch {
      cardImage = null
    }
  }
  /**
   * adj1178：图片印章也**一次性解码**（与背景图同口径，不在每帧 new Image）。
   * 解码失败 ⇒ 退回文字印章（如果还写了字）。
   */
  let sealImage: HTMLImageElement | null = null
  if (card.seal?.image) {
    try {
      sealImage = new Image()
      sealImage.src = card.seal.image
      await sealImage.decode()
    } catch {
      sealImage = null
    }
  }
  const parsed = parseJps(code)
  const layout = layoutScore(parsed, pageConfig)
  const beat = bpm !== undefined && bpm > 0 ? bpm : inferBpm(parsed)
  let seq = buildPlaySequence(parsed, layout, beat, undefined, undefined, opts?.instrumentOverride)

  // 标记段：用与试听**完全相同**的口径切出这一段（时间归零），并跳过满宽片头
  let skipIntro = false
  /**
   * adj1119：标记段被切掉的那段时长（**切片之前**取）。
   * 伴奏轨的起点 = `offsetMs + sourceStartMs`——整曲时它是 0；只按 `offsetMs` 算的话，
   * 标记段导出会从曲首的伴奏开始放（音画整体错开）。
   */
  let sourceStartMs = 0
  if (opts?.range) {
    // adj1102：终点在排版里存在但没有事件 ⇒ 是被连音线/同音合并了，按"紧邻的前一个音"配
    const res = resolvePracticeRange(seq, opts.range.startId, opts.range.endId, {
      endInLayout: hasNoteId(layout, opts.range.endId),
    })
    if (res.missing) throw new Error('标记段已失效（起止音符找不到），请重新标记')
    // adj1083：用户在下拉里选过「第 N 遍」就按那个候选导；否则才用解析器默认的第一个候选。
    // 此前只传 note id，多遍次时永远取第 1 个候选，用户选的第 2/3 遍不会生效。
    const cand = pickPracticeCandidate(res.candidates, res.pick, opts.range.pass)
    if (cand) sourceStartMs = Math.max(0, seq.events[cand.i0]?.atMs ?? 0)
    const sliced = cand ? slicePlaySequenceByRange(seq, cand.i0, cand.i1) : null
    if (!sliced) throw new Error('标记段无效，请重新标记')
    seq = sliced
    skipIntro = true
  }

  // 片头：整条时间轴后移 + 前置静音（音轨用同一份事件，所以天然同步）
  const leadInMs = Math.max(0, opts?.leadInMs ?? 2000)
  seq = shiftSequenceBy(seq, leadInMs)

  /**
   * adj1148：**前奏等待**（谱面第 1 拍之前那段伴奏）。
   *
   * 与片头卡分开：片头卡是"没声音 + 卡片"，这段是"有伴奏 + 谱面定格第 1 拍"。
   * 事件整体再后移 `headWaitMs`，`totalMs` 也加——负向判据：offsetMs=1200 时，
   * `totalMs` 必须比不等待长 1200（见 `preRoll.ts` 的 `shiftSequenceBy` 断言）。
   *
   * 标记段（`range`）本身从曲中间开始，没有"前奏"这回事 ⇒ 忽略传入值。
   */
  const headWaitMs = opts?.range ? 0 : Math.max(0, Math.round(opts?.headWaitMs ?? 0))
  seq = shiftSequenceBy(seq, headWaitMs)
  /** 片头卡 + 前奏等待：其后所有"相对时间"（小节起点等）统一加它 */
  const shiftMs = leadInMs + headWaitMs

  /**
   * adj1064：整片上限（3 分钟）**先裁音乐、不裁片尾**。
   *
   * 以前 `maxMs` 只在 `encodeMp4` 末尾截帧：整首超过 180s 时，片尾卡在 180s 之后，
   * 直接被切掉。这里按「上限 − 片尾 − 自由落体」反推音乐能用到哪，并优先切在
   * **最后一个完整小节的起点**（避免切进小节中间）；剩余时间给片头/片尾。
   * 音轨用同一份（已裁）事件序列，所以声音也在切点结束，不会在片尾卡里继续唱。
   */
  const endCardMs = Math.max(0, opts?.endCardMs ?? 2500)
  const fallMs = 600
  if (opts?.maxMs && opts.maxMs > 0) {
    const contentCap = opts.maxMs - endCardMs - fallMs
    if (seq.totalMs > contentCap) {
      let cut = Math.max(0, contentCap)
      for (const b of seq.barStartsMs ?? []) {
        const abs = b + shiftMs
        if (abs <= contentCap && abs > 0) cut = abs
      }
      const events = seq.events
        .filter((e) => e.atMs < cut)
        .map((e) => ({
          ...e,
          durationMs: Math.max(1, Math.min(e.durationMs, cut - e.atMs)),
        }))
      seq = {
        ...seq,
        events,
        totalMs: cut,
        // `barStartsMs` 是相对时间（出片时统一 +shiftMs），这里也按相对值过滤
        barStartsMs: (seq.barStartsMs ?? []).filter((b) => b + shiftMs <= cut),
      }
    }
  }

  const track = buildRectTrack(seq, { noteSize: pageConfig.note_size })
  const view = buildFlowView(layout, track, pageConfig)
  if (view.rows.length === 0) throw new Error('这份谱没有可播放的音符')

  /**
   * 一拍多少毫秒（相机 `beat` 模式与跳跳球共用；必须与 `buildPlaySequence` 用同一个 beat）。
   */
  const beatMs = 60000 / beat
  /**
   * 小节起点（按小节重置拍网格；片头后移所以要加 `leadIn`）。
   *
   * adj1061（用户 2026-10-22 实报「反复后球落点漂移」）：`seq.barStartsMs` 现在是
   * **展开后逐遍**的小节起点（练习段切片已重基），末尾那条「曲末」不是小节开头，
   * `ballAt` 只把它当"球自由落体"的时刻。
   *
   * adj1089：相机的 `bar` 模式读**同一份**数组。末尾那条"曲末"保留：
   * 球要拿它做自由落体；相机会按 `t <= endMs` 过滤，且那一刻没有色块在响（`rectIndexAt` 返回 -1），
   * 不会多出一条 pans。
   */
  const ballBars = (seq.barStartsMs ?? []).map((s) => s + shiftMs)
  /**
   * adj1089：平移方式由调用方给（`uiStore.panMode` 的 L1 偏好；缺省 follow = 既有行为）。
   * 这里不读 store：预览要订阅它才能"改了下拉立刻重建会话"，所以依赖必须是显式的。
   */
  const panMode = opts?.panMode ?? 'beat'
  /**
   * adj1094：行末提前平移量（拍 → ms）。默认半拍、最多 2 拍；宿主（预览/导出/命令行）从
   * `uiStore.rowLeadBeats` 取来传进来，改了就重建会话。
   */
  const rowLeadBeats = Math.min(2, Math.max(0, opts?.rowLeadBeats ?? 0.5))
  const rowLeadMs = rowLeadBeats * beatMs

  const camera = buildCameraTrack(view, track, pageConfig, {
    viewW: preset.width,
    viewH: preset.height,
    // 片头对准描述头（页顶 → margin_top + descAreaH 的中点）
    headerCy: pageConfig.margin_top + pageConfig.descAreaH / 2,
    ...(opts?.followZoom !== undefined ? { followZoom: opts.followZoom } : {}),
    ...(skipIntro ? { skipIntro: true } : {}),
    // adj1089：按拍/按小节平移（都受"左右露白 ≤10%"夹紧；见引擎 clampRowCenter）
    panMode,
    beatMs,
    bars: ballBars,
    // adj1094：换到下一行提前这么多毫秒完成（三种模式共用）
    rowLeadMs,
  })
  const ball = opts?.ball !== false
  const musicEndMs = track.endMs
  const cardStartMs = musicEndMs + fallMs
  /**
   * 跳跳球的落点表：只取**第一声部**的主声部（多声部各飞一颗会打架；用户 adj1095：
   * 「通常跳跳球应该在第一声部上跳，这才是主声部」）。
   * 球是**抛体**：每拍落下一次，落点 = 那一拍开始时色块上沿的中心。
   */
  const ballVoice = primaryVoiceOf(track.rects)
  const ballAnchors = track.rects
    .filter(
      (r) => (r.playVoice === undefined || r.playVoice === 'main') && r.voice === ballVoice,
    )
    .map((r) => ({ t0: r.t0, t1: r.t1, cx: r.x + r.w / 2, top: r.y, x: r.x, w: r.w }))
  /** adj1095：色块按"声部 + 音色"取色（与试听 `PreviewPane` 共用引擎的调色盘） */
  const colorMap = instrumentColorMap(track.rects)
  /** 拍网格相位：只作"没有小节起点"时的兜底（有 `ballBars` 时 `ballAt` 不看它） */
  const beatPhase = ballBars.length > 0 ? 0 : beatPhaseOf(ballAnchors, beatMs)
  /**
   * adj1067（用户 2026-10-22）：片头改成**自制标题卡**，信息直接取第 1 页描述头。
   *
   * 为什么不继续用页面描述头的截图：16:9 取景框比页高矮，页面居中的标题卡会把页顶裁掉；
   * 9:16/1:1/16:9 三种比例看到的“描述头”范围也不一样。自制卡按 `min(W,H)` 排版、
   * 按宽度自动缩字，三种尺寸同一套版式；3 秒卡 + 0.7 秒淡入/推近到第一拍。
   */
  const introMeta = layout.pages[0]?.meta

  // 字体没就绪就光栅化 ⇒ 字形回退，第一帧和后面不一样
  await document.fonts.ready
  // adj1081：动态谱的页位图必须和预览/静态导出同源——带上谱面背景图与水印（`withOverlay()`）。
  // 以前只传 `layout`，背景图没进 SVG ⇒ 视频里整页是白的。用户实报：谱面用了背景图，导出视频却没有。
  const svgs = renderScoreToSvg(layout, withOverlay())
  const pages: HTMLCanvasElement[] = []
  for (const svg of svgs) pages.push(await svgToCanvas(svg, RASTER_SCALE, '#ffffff'))

  const CARD_FONT = CARD_SANS

  /**
   * adj1265：卡片的**画笔**抽到 `cardPainter.ts`（连续动态谱也用它，尺寸按视频宽高涨缩）。
   * 这里只把"模板 / 已解码的图 / 标题字体"交给它；下面的时间轴与内容仍由本文件决定。
   */
  const cardPainter = createCardPainter({
    card,
    cardImage,
    sealImage,
    titleFont: pageConfig.biaoti_font,
    bodyFont: CARD_FONT,
  })

  const draw = (ctx: DrawCtx, tMs: number) => {
    const frame = cameraAt(camera, tMs)
    const W = camera.viewW
    const H = camera.viewH
    const noteSize = pageConfig.note_size
    // 每帧先清空：片头卡与首帧的交叉淡入必须叠在同一张透明画布上，不能叠到上一帧
    ctx.clearRect(0, 0, W, H)

    /** 按给定相机画一帧（alpha<1 用于片头交叉淡入） */
    const paintCamera = (c: CameraFrame, alpha: number, t: number) => {
      const z = c.zoom
      const left = c.cx - W / z / 2
      const top = c.cy - H / z / 2
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, W, H)

      const page = pages[c.pageIndex]
      if (page) {
        // 只画"取景框 ∩ 页面"这一块：满宽片头时取景框比页面高，两侧/上下会露白，属正常
        const ix = Math.max(0, left)
        const iy = Math.max(0, top)
        const iw = Math.min(camera.pageW, left + W / z) - ix
        const ih = Math.min(camera.pageH, top + H / z) - iy
        if (iw > 0 && ih > 0) {
          ctx.drawImage(
            page,
            ix * RASTER_SCALE,
            iy * RASTER_SCALE,
            iw * RASTER_SCALE,
            ih * RASTER_SCALE,
            (ix - left) * z,
            (iy - top) * z,
            iw * z,
            ih * z,
          )
        }
      }

      // 高亮：只画当前页上的（跨页时不会把上一页的块贴过来）；颜色按"声部 + 音色"（adj1095）
      const active = rectsActiveAt(track, t).filter((r) => r.pageIndex === c.pageIndex)
      for (const r of active) {
        const x = (r.x - left) * z
        const y = (r.y - top) * z
        const w = r.w * z
        const h = r.h * z
        const base = playheadBaseOf(r, colorMap)
        ctx.beginPath()
        ctx.roundRect(x - 4, y - 3, w + 8, h + 6, Math.max(4, 8 * (z / 4)))
        ctx.fillStyle = `${base} 0.20)`
        ctx.fill()
        ctx.lineWidth = Math.max(2, 3 * (z / 4))
        ctx.strokeStyle = `${base} 0.85)`
        ctx.stroke()
      }

      /**
       * 跳跳球：每拍弹一次，落地 = 拍点前的 `lead`，随后压扁保持 `dwell`（adj1062）。
       * 高度用抛物线 `4u(1-u)`；落地后按 `squash` 压成椭圆（球底仍贴色块上沿）。
       */
      if (ball) {
        const bp = ballAt(ballAnchors, t, beatMs, beatPhase, noteSize * 3.2, ballBars, BALL_LANDING_TIMING)
        if (bp && bp.x >= 0 && bp.x <= camera.pageW) {
          const rad = Math.max(4, noteSize * z * 0.28)
          const s = bp.squash ?? 0
          const rx = rad * (1 + BALL_SQUASH_X * s)
          const ry = rad * (1 - BALL_SQUASH_Y * s)
          const bx = (bp.x - left) * z
          // 压扁以**球底**为不动点：中心 = 落点 − 当前纵向半径
          const by = (bp.y - top) * z - ry
          ctx.beginPath()
          ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI * 2)
          ctx.fillStyle = BALL_FILL
          ctx.fill()
          // 白圈：压在浅色谱面上也能看清边界
          ctx.lineWidth = Math.max(1.5, rad * 0.18)
          ctx.strokeStyle = 'rgba(255,255,255,0.9)'
          ctx.stroke()
        }
      }
      ctx.restore()
    }

    /**
     * 自制片头卡（adj1067）：深空蓝底 + 霓虹青强调线 + 描述头信息。
     * 版式只依赖 `min(W,H)`，因此 9:16 / 1:1 / 16:9 看到的是同一张卡，不会出现裁切差异。
     */
    /**
     * 自制片头卡（adj1067）：深空蓝底 + 霓虹青强调线 + 描述头信息。
     * adj1265：版式与画笔挪到 `cardPainter.ts`（连续动态谱复用同一张卡，尺寸按视频宽高）。
     */
    const paintIntroCard = (alpha: number, t: number) => {
      cardPainter.intro(ctx, W, H, t, alpha, introMeta, beat)
    }

    /**
     * adj1067：片头卡 3 秒，最后 0.7 秒把画面淡入/推近到第一拍。
     * 不再区分整首/标记段——两者都用同一张自制卡，标记段也不会因为跨页而丢掉片头。
     *
     * adj1148：有**前奏等待**时，卡在 `leadInMs` 就结束（前奏段不画卡），
     * 淡入目标是**谱面第 1 拍**（`musicStartMs`，即 leadIn + headWait 那一帧）。
     */
    const musicStartMs = leadInMs + headWaitMs
    const cardEndMs = headWaitMs > 0 ? leadInMs : camera.firstT
    const introTargetMs = headWaitMs > 0 ? musicStartMs : camera.firstT
    if (tMs < cardEndMs) {
      const introEnd = Math.max(0, cardEndMs - INTRO_PAN_MS)
      const raw =
        introEnd <= 0 ? 1 : Math.max(0, Math.min(1, (tMs - introEnd) / INTRO_PAN_MS))
      const k = raw * raw * (3 - 2 * raw)
      if (k < 1) paintIntroCard(1 - k, tMs)
      if (k > 0) {
        const target = cameraAt(camera, introTargetMs)
        // 0.94→1 的轻微推近，观感是"卡缩进谱面"，不是硬切
        paintCamera({ ...target, zoom: target.zoom * (0.94 + 0.06 * k) }, k, introTargetMs)
      }
      return { frame, following: false }
    }

    /**
     * adj1148：前奏等待段——**谱面定格在第 1 拍**、伴奏照放。
     *
     * 画面时间只取第 1 拍内的相位（`% beatMs`）：色块位置与第 0 帧完全相同（负向判据），
     * 跳跳球仍原地弹（观感不是"死画面"）。
     */
    if (headWaitMs > 0 && tMs < musicStartMs) {
      const ft = preRollFrameMs(tMs, leadInMs, headWaitMs, beatMs) ?? musicStartMs
      const frozen = cameraAt(camera, ft)
      paintCamera(frozen, 1, ft)
      return { frame: frozen, following: true }
    }

    /**
     * 片尾：音乐结束后定格最后一帧，淡入品牌落版（推本应用）。
     * 音频不额外补声——视频比音轨长，播放器就是自然静音。
     */
    if (endCardMs > 0 && tMs >= cardStartMs) {
      const lastT = Math.max(0, musicEndMs - 1)
      paintCamera(cameraAt(camera, lastT), 1, lastT)
      const k = Math.min(1, (tMs - cardStartMs) / 300)
      paintEndCard(ctx, k, tMs - cardStartMs)
      return { frame, following: false }
    }

    paintCamera(frame, 1, tMs)
    return { frame, following: tMs >= camera.firstT }
  }

  /**
   * 品牌落版：模板背景 + 中英文名 + slogan + 网址；所有模板都必须展示品牌。
   * adj1265：画笔挪到 `cardPainter.ts`（连续动态谱复用；`endCardLayout` 已按宽高比排版）。
   */
  const paintEndCard = (ctx: DrawCtx, alpha: number, t: number) => {
    cardPainter.end(ctx, camera.viewW, camera.viewH, t, alpha, opts?.shortCode ?? '')
  }

  return {
    camera,
    pages,
    totalMs: cardStartMs + endCardMs,
    musicEndMs,
    cardStartMs,
    width: camera.viewW,
    height: camera.viewH,
    events: seq.events,
    bpm: beat,
    // adj1119：伴奏轨用它补片头静音 / 定位标记段起点
    leadInMs,
    // adj1148：前奏等待（伴奏要提前到 leadIn 起放）
    headWaitMs,
    sourceStartMs,
    draw,
  }
}
