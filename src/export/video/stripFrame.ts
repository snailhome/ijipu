/**
 * export/video/stripFrame.ts — 单行谱「一帧的几何」（adj1260）
 *
 * 只回答"这一帧谱带滚到哪、定位色块在哪、球在哪"，不画任何像素 ——
 * 因此可以在 Node 里断言（预览与出片必须同一个口径，否则音画/球位会漂）。
 *
 * 用户 2026-11-08 的口径：
 *  · 定位色块在**画面左 1/3**；当前演奏时点与它对应；
 *  · 谱带纵向位置**可调**，默认**上 1/4**；
 *  · 球在**色块的固定位置**弹。
 */
import { stripBallAt, stripXAt, type LinearStrip, type PageConfig, type StripBall } from '@ijipu/engine'
import { locatorBlockWidthOf } from './linearSync'

export interface StripLayOptions {
  /** 画布宽 */
  viewW: number
  /** 画布高 */
  viewH: number
  /** 谱带高（= `strip.height`） */
  stripH: number
  /** 谱带顶在画布上的比例（0~1；用户口径默认 0.25 = 上 1/4） */
  topRatio?: number
  /** 定位色块中心在画布上的比例（默认 1/3） */
  blockRatio?: number
  /** 视觉提前量（ms）：让谱面比声音早一点到定位块 */
  leadMs?: number
}

export interface StripFrameGeom {
  /** 谱带顶的 y（画布坐标） */
  bandTop: number
  /** 视口左缘对应的条带 x（可为负：曲首让第一拍正好落在定位块上） */
  scrollX: number
  /** 定位色块中心 x */
  blockX: number
  /**
   * 定位色块宽（adj1264：**一个音符宽、固定**，不再按谱带高算）。
   * 放在几何里是因为"预览/出片/断言"要用同一个值（AGENTS「数值口径同源」）。
   */
  blockW: number
  /** 色块上下沿 */
  blockTop: number
  blockBottom: number
  /** 球（球心） */
  ballX: number
  ballY: number
  squash: number
  dwelling: boolean
}

/** 谱带顶：按比例放，但保证整条带不出画 */
export function bandTopOf(viewH: number, stripH: number, topRatio: number): number {
  const r = Math.min(1, Math.max(0, topRatio))
  const maxTop = Math.max(0, viewH - stripH)
  return Math.round(Math.min(maxTop, viewH * r) * 10) / 10
}

/**
 * 某一帧的几何。
 *
 * `scrollX = x(t + leadMs) − blockX`：不夹到 0 ——
 * 曲首就需要负值，否则第一拍到不了定位块（会出现"球已经跳了、谱还没到"）。
 */
export function stripFrameAt(tMs: number, strip: LinearStrip, o: StripLayOptions): StripFrameGeom {
  const blockRatio = Math.min(0.9, Math.max(0.1, o.blockRatio ?? 1 / 3))
  const blockX = o.viewW * blockRatio
  const bandTop = bandTopOf(o.viewH, o.stripH, o.topRatio ?? 0.25)
  const scrollX = stripXAt(strip, tMs + (o.leadMs ?? 0)) - blockX
  const blockTop = bandTop
  const blockBottom = bandTop + o.stripH
  /**
   * adj1264（用户 2026-11-09「定位色块以一个音符宽度，固定宽度即可」）：
   * `o.stripH` 是**画布上的**谱带高（已乘 `bandScale`），而 `strip.height` 是排版高 ⇒
   * 两者之比就是缩放系数，用 `strip.noteSize × 缩放 × 0.62` 得到"一个数字"的宽。
   */
  const scale = o.stripH / Math.max(1, strip.height)
  const blockW = locatorBlockWidthOf(strip.noteSize, scale)
  const ball: StripBall = stripBallAt(tMs, {
    beatMs: strip.beatMs,
    blockTop,
    radius: Math.max(6, o.stripH * 0.16),
    hopPx: Math.max(18, o.stripH * 0.55),
  })
  return {
    bandTop,
    scrollX: Math.round(scrollX * 10) / 10,
    blockX: Math.round(blockX * 10) / 10,
    blockW,
    blockTop: Math.round(blockTop * 10) / 10,
    blockBottom: Math.round(blockBottom * 10) / 10,
    ballX: Math.round(blockX * 10) / 10,
    ballY: Math.round(ball.y * 10) / 10,
    squash: Math.round(ball.squash * 100) / 100,
    dwelling: ball.dwelling,
  }
}

/**
 * adj1270：**条带的排版配置**——把"谱面字号"抬到条带字号时，字号类配置要**一起按比例放大**。
 *
 * 为什么不能只改 `note_size`（`adj1258` 起就是这么干的）：`note_size` 只决定数字/减时线/高八度点，
 * **歌词字号 `geci_size` 是独立一项**。出片画布 1920 宽时 13px 的谱太小，所以要抬到 64px；
 * 但只抬 `note_size` 的结果是"64px 的谱 + 11px 的词"——真图里歌词糊成一排小点（`adj1269` 截图发现）。
 *
 * 只放大**与字号同量纲**的那几项；`height_*` 这类行间距只影响行与行的距离，
 * 而条带把所有行压到同一条基线上，抬不抬都不影响条带上的样子（抬了反而会改动行判定）。
 */
export function stripCfgOf(cfg: PageConfig, noteSize: number): PageConfig {
  const from = cfg.note_size > 0 ? cfg.note_size : 13
  const scale = Math.max(0.1, noteSize / from)
  const scaled = (v: number): number => Math.max(1, Math.round(v * scale))
  return { ...cfg, note_size: Math.max(1, Math.round(noteSize)), geci_size: scaled(cfg.geci_size) }
}
