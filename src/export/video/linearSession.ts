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
import type { LinearStrip } from '@ijipu/engine'
import { StripRasterCache } from './stripRaster'
import { stripSvgOf } from './stripSvg'
import { stripFrameAt, type StripFrameGeom, type StripLayOptions } from './stripFrame'
import { normalizeStripStyle, type StripStyle } from './stripTheme'
import type { PageConfig } from '@ijipu/engine'

export type StripBackground =
  | { kind: 'color'; color: string }
  | { kind: 'image'; image: CanvasImageSource; w: number; h: number }
  | { kind: 'video'; draw: (ctx: DrawCtx, tMs: number) => void }

export type DrawCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface LinearSession {
  width: number
  height: number
  totalMs: number
  /** 画一帧（同步：位图块没准备好时该块先空着） */
  draw: (ctx: DrawCtx, tMs: number) => StripFrameGeom
  /** 预热某一时刻附近（预览 rAF 前调；返回后立刻 draw 就有图） */
  warm: (tMs: number) => Promise<void>
  /** 谱带底图（排查用：把整条 SVG 拿走） */
  svg: string
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

  return {
    width: opts.width,
    height: opts.height,
    totalMs: opts.strip.runs.length === 0 ? 0 : opts.strip.runs[opts.strip.runs.length - 1].t1,
    svg,
    warm: (tMs) => cache.ensure(stripFrameAt(tMs, opts.strip, lay).scrollX, opts.width),
    draw(ctx, tMs) {
      const g = stripFrameAt(tMs, opts.strip, lay)
      // ① 背景
      const bg = opts.background ?? { kind: 'color', color: '#000000' }
      if (bg.kind === 'color') {
        ctx.fillStyle = bg.color
        ctx.fillRect(0, 0, opts.width, opts.height)
      } else if (bg.kind === 'image') {
        drawCover(ctx, bg.image, bg.w, bg.h, opts.width, opts.height)
      } else {
        bg.draw(ctx, tMs)
      }
      // ② 谱带
      cache.blit(ctx, g.scrollX, g.bandTop)
      // ③ 定位色块（左 1/3，短宽：宽 ≈ 谱带高的 0.55）
      const bw = Math.max(10, Math.round(stripH * 0.55))
      const bh = stripH
      ctx.save()
      ctx.globalAlpha = style.blockAlpha
      ctx.fillStyle = style.blockColor
      roundRect(ctx, g.blockX - bw / 2, g.blockTop, bw, bh, Math.min(8, bw / 2))
      ctx.fill()
      ctx.restore()
      // ④ 跳跳球（x 固定；落地压扁）
      const r = Math.max(6, stripH * 0.16)
      ctx.save()
      ctx.fillStyle = style.ballColor
      ctx.beginPath()
      ctx.ellipse(g.ballX, g.ballY, r * (1 + 0.35 * g.squash), r * (1 - 0.45 * g.squash), 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      return g
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
