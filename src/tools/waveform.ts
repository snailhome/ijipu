/**
 * tools/waveform.ts — 把音轨画成"波形 + 时间标尺 + 选区 + 标记段 + 播放头"
 *
 * **画法是从爱出片搬过来的**：源文件 `ijipu-cp/src/sync/SyncTab.tsx` 的音频轨绘制
 * （第 1793-2041 行）。搬过来的部分，与原文件一一对应：
 *  · 按 CSS 尺寸 × DPR 设置位图、坐标用 CSS 像素（1813-1819）——避免窗口拉伸带来的取整误差；
 *  · 每像素取一个桶、用 `peaksOf` 的 min/max 画竖线（1870-1885）；
 *  · 选中段之外**压暗**，突出真正要导出的那一段（1910-1918）；
 *  · 段的两端画橙色虚线 + `[` `]` 两个字（1920-1939），与"播放头"一眼分得开；
 *  · 底部一条时间标尺：底色 + 刻度短线 + `m:ss` 文字，刻度密度交给 `waveRuler.timeScaleOf`
 *    （2020-2041）；
 *  · 播放头一根品红线（1955-1959）。
 * 只去掉了对拍台专有的东西（音符格、锚点三角、小节线、留白、锁定色），因为工具页没有谱面。
 *
 * 我这边只多两样（adj1317，用户要的"起止点可各自调"）：
 *  · 选区两条边顶上各画一个抓手，正在调的那条更亮（`grip`）；
 *  · 已存下的标记段画成细橙线，位置一眼看得见。
 */

import { PEAK_BUCKETS, peaksOf as computePeaks, type PeakBucket } from './wavePeaks'
import { audioClockOf, timeScaleOf, viewWindow, type WaveView } from './waveRuler'

/** 底部标尺高度（CSS 像素），与爱出片的 `RULER_H` 同一个量级 */
const RULER_H = 16

export interface WaveSpan {
  /** 秒 */
  start: number
  /** 秒 */
  end: number
}

export interface WaveFrame {
  peaks: PeakBucket[]
  /** 音轨总长（秒） */
  duration: number
  /** 视野（缩放/平移）；`spanMs = 0` = 整曲 */
  view: WaveView
  /** 当前选区（秒）；null = 没选 */
  selection: WaveSpan | null
  /** 播放头（秒） */
  head: number
  /** 已保存的标记段（秒） */
  marks: readonly WaveSpan[]
  /** 正在调的那条边 —— 画得实一点，让人知道在动哪一边 */
  grip?: 'start' | 'end' | null
  /**
   * adj1319：复听的"临时时点"（秒）。点「复听」那一刻播放头在哪，就在这里竖一根虚线，
   * 让人看清"我上一次听到的是哪一点"；正常播放（播放 / 播放选区 / 拖播放头）就取消。
   */
  anchor?: number | null
}

interface Palette {
  wave: string
  centre: string
  mask: string
  sel: string
  selEdge: string
  mark: string
  head: string
  /** adj1319：复听临时时点的金色 */
  anchor: string
  rulerBg: string
  rulerTick: string
  rulerText: string
}

/** 配色：深色/浅色各一套（浅色那套与爱出片 1820-1838 的取法一致，色值按本站在调） */
function palette(): Palette {
  const light = document.documentElement.dataset.siteMode === 'light'
  return light
    ? {
        wave: '#2b7b96',
        centre: 'rgba(28, 37, 64, 0.18)',
        mask: 'rgba(255, 255, 255, 0.66)',
        sel: 'rgba(8, 145, 166, 0.16)',
        selEdge: '#0891a6',
        mark: '#c25e00',
        head: '#d6008c',
        anchor: '#b8860b',
        rulerBg: '#e9eef7',
        rulerTick: '#bcc8dc',
        rulerText: '#5d6a85',
      }
    : {
        wave: '#2fd6c4',
        centre: 'rgba(147, 160, 200, 0.2)',
        mask: 'rgba(4, 8, 18, 0.62)',
        sel: 'rgba(0, 240, 255, 0.14)',
        selEdge: '#00f0ff',
        mark: '#ff9f43',
        head: '#ff2fb0',
        anchor: '#ffd166',
        rulerBg: '#121933',
        rulerTick: '#2a3560',
        rulerText: '#6b78a3',
      }
}

/** 把画布按 CSS 尺寸 × 设备像素比调好，返回已经 scale 过的 2D 上下文 */
function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

/** 画一帧 */
export function drawWave(canvas: HTMLCanvasElement, frame: WaveFrame): void {
  const ctx = contextOf(canvas)
  if (ctx === null) return
  const W = canvas.clientWidth
  const H = canvas.clientHeight
  const waveTopH = Math.max(40, H - RULER_H)
  const color = palette()
  const durMs = Math.max(1, frame.duration * 1000)
  const { v0, winMs } = viewWindow(frame.view, durMs)
  /** 毫秒 → 画布 x（爱出片 1818 行同一条公式） */
  const toX = (ms: number): number => ((ms - v0) / Math.max(1, winMs)) * W

  ctx.clearRect(0, 0, W, H)

  const mid = waveTopH / 2
  // 中线
  ctx.fillStyle = color.centre
  ctx.fillRect(0, mid - 0.5, W, 1)

  // 波形：每像素取一个桶（爱出片 1870-1885）
  const peaks = frame.peaks
  const bucketOf = (tMs: number): number =>
    Math.min(peaks.length - 1, Math.max(0, Math.floor((tMs / durMs) * peaks.length)))
  ctx.strokeStyle = color.wave
  ctx.beginPath()
  for (let x = 0; x < W; x += 1) {
    const tMs = v0 + (x / Math.max(1, W)) * winMs
    if (tMs < 0 || tMs > durMs) continue
    const p = peaks[bucketOf(tMs)]
    if (p === undefined) continue
    ctx.moveTo(x + 0.5, mid - p.max * mid * 0.92)
    ctx.lineTo(x + 0.5, mid - p.min * mid * 0.92)
  }
  ctx.stroke()

  // 已保存的标记段：细橙线（工具页没有锚点，用它标出"已经切好的段"）
  for (const m of frame.marks) {
    ctx.fillStyle = color.mark
    const x0 = toX(m.start * 1000)
    const x1 = toX(m.end * 1000)
    if (x0 >= 0 && x0 <= W) ctx.fillRect(x0 - 0.5, 0, 1, waveTopH)
    if (x1 >= 0 && x1 <= W) ctx.fillRect(x1 - 0.5, 0, 1, waveTopH)
  }

  // 选区之外压暗（爱出片 1910-1918 的口径：突出真正会导出的那一段）
  if (frame.selection !== null) {
    const a = Math.min(frame.selection.start, frame.selection.end)
    const b = Math.max(frame.selection.start, frame.selection.end)
    const sx = Math.max(0, Math.min(W, toX(a * 1000)))
    const ex = Math.max(0, Math.min(W, toX(b * 1000)))
    ctx.fillStyle = color.mask
    if (sx > 0) ctx.fillRect(0, 0, sx, waveTopH)
    if (ex < W) ctx.fillRect(ex, 0, W - ex, waveTopH)
    ctx.fillStyle = color.sel
    ctx.fillRect(sx, 0, Math.max(1, ex - sx), waveTopH)
  }

  // 选区的两条边：橙色虚线 + `[` `]`（爱出片 1920-1939），再叠抓手（adj1317）
  if (frame.selection !== null) {
    const a = Math.min(frame.selection.start, frame.selection.end)
    const b = Math.max(frame.selection.start, frame.selection.end)
    const edge = (sec: number, bracket: '[' | ']'): number => {
      const x = toX(sec * 1000)
      if (x < -4 || x > W + 4) return x
      ctx.strokeStyle = color.selEdge
      ctx.lineWidth = 2
      ctx.setLineDash([5, 3])
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, waveTopH)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = color.selEdge
      ctx.font = 'bold 11px system-ui, sans-serif'
      ctx.textAlign = bracket === '[' ? 'left' : 'right'
      ctx.textBaseline = 'top'
      ctx.fillText(bracket, bracket === '[' ? x + 2 : x - 2, 2)
      return x
    }
    const xa = edge(a, '[')
    const xb = edge(b, ']')
    const knob = (x: number, active: boolean): void => {
      if (x < -4 || x > W + 4) return
      ctx.globalAlpha = active ? 1 : 0.55
      ctx.fillStyle = color.selEdge
      ctx.fillRect(Math.max(0, x - 4), 0, 8, 14)
      ctx.globalAlpha = 1
    }
    knob(xa, frame.grip === 'start')
    knob(xb, frame.grip === 'end')
  }

  // 复听的临时时点（adj1319）：金色虚线 + 顶部一个小三角，跟选区边（青色）和播放头（品红）都分得开
  if (frame.anchor !== null && frame.anchor !== undefined) {
    const ax = toX(Math.min(Math.max(0, frame.anchor), frame.duration) * 1000)
    if (ax >= -4 && ax <= W + 4) {
      ctx.strokeStyle = color.anchor
      ctx.lineWidth = 1.5
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(ax, 0)
      ctx.lineTo(ax, waveTopH)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = color.anchor
      ctx.beginPath()
      ctx.moveTo(ax - 4, 0)
      ctx.lineTo(ax + 4, 0)
      ctx.lineTo(ax, 6)
      ctx.closePath()
      ctx.fill()
    }
  }

  // 播放头（爱出片 1955-1959：品红，够醒目）
  const px = toX(Math.min(Math.max(0, frame.head), frame.duration) * 1000)
  if (px >= 0 && px <= W) {
    ctx.fillStyle = color.head
    ctx.fillRect(px - 1, 0, 2.5, waveTopH)
  }

  // 时间标尺（爱出片 2020-2041）
  ctx.fillStyle = color.rulerBg
  ctx.fillRect(0, waveTopH, W, RULER_H)
  const scale = timeScaleOf(v0, v0 + winMs, W)
  ctx.strokeStyle = color.rulerTick
  ctx.beginPath()
  for (const t of scale.ticks) {
    const x = toX(t)
    if (x < -2 || x > W + 2) continue
    ctx.moveTo(x + 0.5, waveTopH)
    ctx.lineTo(x + 0.5, waveTopH + 5)
  }
  ctx.stroke()
  ctx.fillStyle = color.rulerText
  ctx.font = '10px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  for (const t of scale.ticks) {
    const x = toX(t)
    if (x < 0 || x > W - 18) continue
    ctx.fillText(audioClockOf(t), x + 3, waveTopH + RULER_H / 2 + 1)
  }
}

/** 峰值缓存入口（换文件/换桶数才重算）：`peaksOf` 是纯函数，放这里方便组件一处调用 */
export { computePeaks as peaksOf, PEAK_BUCKETS }
