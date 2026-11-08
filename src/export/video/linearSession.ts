/**
 * export/video/linearSession.ts — 连续动态谱的**一帧**（adj1261）
 *
 * 只做一件事：`draw(ctx, t)` 把「背景 → 谱带 → 定位色块 → 跳跳球」画出来。
 * 与 `renderer.ts` 的 `DynamicSession` 同一个口径：**纯的**（同样的 t 画同样的画面），
 * 预览与出片都调它，所以成片必然和框里看到的一致。
 *
 * 背景来源三种（用户 2026-11-08 口径）：
 *  · `video`：外部逐帧画（视频解码交给 `mediaDecode`，本文件只调回调）；
 *  · `image`：一张背景图（cover 铺满）；
 *  · 都没有：纯色兜底。
 */
import type { LinearStrip, ScorePageMeta } from '@ijipu/engine'
import { StripRasterCache } from './stripRaster'
import { stripSvgOf } from './stripSvg'
import { stripFrameAt, type StripFrameGeom, type StripLayOptions } from './stripFrame'
import { normalizeStripStyle, type StripStyle } from './stripTheme'
import {
  linearCardFrameAt,
  linearCardTimelineOf,
  mediaMsOfSession,
  type LinearCards,
  type LinearCardTimeline,
} from './linearSync'
import { createCardPainter, type CardPainter } from './cardPainter'
import type { CardStyle } from './cardTemplates'
import type { PageConfig } from '@ijipu/engine'

export type StripBackground =
  | { kind: 'color'; color: string }
  | { kind: 'image'; image: CanvasImageSource; w: number; h: number }
  | { kind: 'video'; draw: (ctx: DrawCtx, tMs: number) => void }

export type DrawCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface LinearSession {
  width: number
  height: number
  /** 会话总长（ms）：带卡片时 = 片头 + 音乐 + 片尾 */
  totalMs: number
  /** 画一帧（同步：位图块没准备好时该块先空着）；`tMs` 是**会话时刻**（0 = 片头卡开头） */
  draw: (ctx: DrawCtx, tMs: number) => StripFrameGeom
  /** 预热某一时刻附近（预览 rAF 前调；返回后立刻 draw 就有图） */
  warm: (tMs: number) => Promise<void>
  /** 会话时刻 → 媒体时刻（对话框要按它预热视频帧；没有卡片时是恒等映射） */
  mediaMsOf: (tMs: number) => number
  /** 三段式时间轴（没有卡片时 `introMs = endMs = 0`） */
  timeline: LinearCardTimeline
  /** 谱带底图（排查用：把整条 SVG 拿走） */
  svg: string
}

/** adj1265：出片带片头/片尾卡（M4「卡片适配」） */
export interface LinearCardSetup {
  /** 两段时长（`linearCardsOf` 算好再传；0/0 = 不带） */
  cards: LinearCards
  /** 音乐段在**媒体时间轴**上的起止（= 导出段） */
  range: { startMs: number; endMs: number }
  /** 卡片样式（与相机位共用模板库） */
  cardStyle: CardStyle
  /** 片头卡上的文字（排版结果第 1 页描述头） */
  meta?: ScorePageMeta | null
  /** 片头卡速度行用的拍速（对拍后的实际值） */
  bpm: number
  /** 片尾短链（可空） */
  shortCode?: string
}

export interface CreateLinearSessionOptions {
  strip: LinearStrip
  cfg: PageConfig
  width: number
  height: number
  style: StripStyle
  background?: StripBackground
  /** 谱带纵向位置与色块位置；缺省上 1/4、左 1/3 */
  lay?: Omit<StripLayOptions, 'viewW' | 'viewH' | 'stripH'>
  /** 谱带整体缩放（谱带高 / 字号；1 = 用 `strip.noteSize`） */
  bandScale?: number
  /**
   * 媒体时间轴总长（ms）。没有卡片时必须给：它决定"会话时刻 = 媒体时刻"这条映射，
   * 也决定预览能拖到哪。
   */
  mediaTotalMs?: number
  /** 卡片；不传 = 不带片头片尾（行为与 adj1264 完全一致） */
  cards?: LinearCardSetup
}

/** 把谱带按 cover 方式铺到画布（背景图用） */
function drawCover(ctx: DrawCtx, src: CanvasImageSource, sw: number, sh: number, w: number, h: number): void {
  const scale = Math.max(w / Math.max(1, sw), h / Math.max(1, sh))
  const dw = sw * scale
  const dh = sh * scale
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh)
}

export async function createLinearSession(opts: CreateLinearSessionOptions): Promise<LinearSession> {
  const style = normalizeStripStyle(opts.style)
  const svg = stripSvgOf(opts.strip, opts.cfg, style.ink)
  const bandScale = Math.min(3, Math.max(0.3, opts.bandScale ?? 1))
  const stripH = Math.round(opts.strip.height * bandScale)
  const cache = new StripRasterCache(svg, opts.strip.width * bandScale, stripH, {
    chunkW: Math.max(480, Math.round(opts.width)),
    style,
  })
  const lay = { ...(opts.lay ?? {}), viewW: opts.width, viewH: opts.height, stripH }
  const stripEndMs = opts.strip.runs.length === 0 ? 0 : opts.strip.runs[opts.strip.runs.length - 1].t1

  /**
   * adj1265：三段式时间轴。
   *  · 带卡片：`[片头][导出段][片尾]`，音乐段只覆盖**导出段**（与出片一致）；
   *  · 不带卡片：片头片尾都是 0、音乐段就是整条媒体 —— 此时"会话时刻 = 媒体时刻"，与 adj1264 行为一致。
   */
  const cardSetup = opts.cards
  const timeline: LinearCardTimeline =
    cardSetup !== undefined && (cardSetup.cards.introMs > 0 || cardSetup.cards.endMs > 0)
      ? linearCardTimelineOf(
          {
            startMs: cardSetup.range.startMs,
            endMs: cardSetup.range.endMs,
            durationMs: Math.max(0, cardSetup.range.endMs - cardSetup.range.startMs),
          },
          cardSetup.cards,
        )
      : (() => {
          const musicMs = Math.max(0, opts.mediaTotalMs ?? stripEndMs)
          return {
            introMs: 0,
            musicMs,
            endMs: 0,
            totalMs: musicMs,
            rangeStartMs: 0,
            rangeEndMs: musicMs,
          }
        })()

  /** 卡片里的两张图（背景图 / 图片印章）**一次性解码**；坏了就退回纯色/文字印章 */
  const decodeCardImage = async (src: string | null | undefined): Promise<HTMLImageElement | null> => {
    if (src === undefined || src === null || src === '') return null
    try {
      const img = new Image()
      img.src = src
      await img.decode()
      return img
    } catch {
      return null
    }
  }
  const painter: CardPainter | null =
    cardSetup !== undefined && timeline.introMs + timeline.endMs > 0
      ? createCardPainter({
          card: cardSetup.cardStyle,
          cardImage: await decodeCardImage(cardSetup.cardStyle.backgroundImage),
          sealImage: await decodeCardImage(cardSetup.cardStyle.seal?.image),
          titleFont: opts.cfg.biaoti_font,
        })
      : null

  /** 画"谱面那一帧"（背景 → 色块 → 谱带 → 球）；`alpha<1` 用于片头卡的最后一段交叉淡化 */
  const drawMusic = (ctx: DrawCtx, mediaMs: number, alpha = 1): StripFrameGeom => {
    const g = stripFrameAt(mediaMs, opts.strip, lay)
    if (alpha < 1) {
      ctx.save()
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
    }
    // ① 背景
    const bg = opts.background ?? { kind: 'color', color: '#000000' }
    if (bg.kind === 'color') {
      ctx.fillStyle = bg.color
      ctx.fillRect(0, 0, opts.width, opts.height)
    } else if (bg.kind === 'image') {
      drawCover(ctx, bg.image, bg.w, bg.h, opts.width, opts.height)
    } else {
      bg.draw(ctx, mediaMs)
    }
    // ② 定位色块（左 1/3；宽 = **一个音符宽**，见 `stripFrame` 的 `blockW`）
    //    ⚠ 先画色块、再画谱带（adj1263 看真图后调整）：色块是**底衬高亮**，
    //    盖在字上面会把当前音染成粉色（截图里"0 0"就是粉的），字就不"白"了。
    //    adj1264（用户 2026-11-09）：宽度改成一个数字的墨迹宽、固定不随段落变化。
    const bw = Math.max(4, g.blockW)
    ctx.save()
    ctx.globalAlpha = ctx.globalAlpha * style.blockAlpha
    ctx.fillStyle = style.blockColor
    roundRect(ctx, g.blockX - bw / 2, g.blockTop, bw, stripH, Math.min(6, bw / 2))
    ctx.fill()
    ctx.restore()
    // ③ 谱带
    cache.blit(ctx, g.scrollX, g.bandTop)
    // ④ 跳跳球（x 固定；落地压扁）
    const r = Math.max(6, stripH * 0.16)
    ctx.save()
    ctx.fillStyle = style.ballColor
    ctx.beginPath()
    ctx.ellipse(g.ballX, g.ballY, r * (1 + 0.35 * g.squash), r * (1 - 0.45 * g.squash), 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    if (alpha < 1) ctx.restore()
    return g
  }

  return {
    width: opts.width,
    height: opts.height,
    totalMs: timeline.totalMs,
    timeline,
    svg,
    mediaMsOf: (tMs) => mediaMsOfSession(timeline, tMs),
    warm: (tMs) => {
      const mediaMs = mediaMsOfSession(timeline, tMs)
      return cache.ensure(stripFrameAt(mediaMs, opts.strip, lay).scrollX, opts.width)
    },
    draw(ctx, tMs) {
      const f = linearCardFrameAt(tMs, timeline)
      if (f.phase === 'intro') {
        /**
         * 片头段：最后 `LINEAR_INTRO_FADE_MS` 里卡片淡出、谱面淡入（与相机位同一节奏）。
         * 画之前先清空：两层的 alpha 必须叠在同一张透明画布上，不能叠到上一帧。
         */
        ctx.clearRect(0, 0, opts.width, opts.height)
        if (f.introFade > 0) drawMusic(ctx, f.mediaMs, f.introFade)
        painter?.intro(ctx, opts.width, opts.height, tMs, 1 - f.introFade, cardSetup?.meta ?? null, cardSetup?.bpm ?? 0)
        return stripFrameAt(f.mediaMs, opts.strip, lay)
      }
      if (f.phase === 'end') {
        // 片尾：先画最后一帧，再把品牌落版淡上来（音乐已经停了）
        drawMusic(ctx, f.mediaMs, 1)
        const endT = tMs - (timeline.introMs + timeline.musicMs)
        painter?.end(ctx, opts.width, opts.height, Math.max(0, endT), f.endFade, cardSetup?.shortCode ?? '')
        return stripFrameAt(f.mediaMs, opts.strip, lay)
      }
      return drawMusic(ctx, f.mediaMs, 1)
    },
  }
}

function roundRect(ctx: DrawCtx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}
