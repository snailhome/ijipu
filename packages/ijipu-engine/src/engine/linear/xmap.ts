/**
 * engine/linear/xmap.ts — 单行谱的「时刻 → 横坐标」（adj1258）
 *
 * 条带是**分段线性**的：每个 `StripRun` 内部 x 与时间成比例，段与段之间首尾相接。
 * 所以查一个时刻的位置 = 二分找到所在段 + 段内线性插值。
 *
 * 为什么要单独一层：滚动位置（定位色块要对准当前音）、相机/预览、断言都读它；
 * 只允许这一个口径，不许渲染端自己再按 `t × 像素` 现算（那样密集小节就会偏）。
 */
import type { LinearStrip } from './types'

/** 落在哪一段（-1 = 在所有段之外） */
export function stripRunAt(strip: LinearStrip, tMs: number): number {
  const runs = strip.runs
  if (runs.length === 0) return -1
  if (tMs < runs[0].t0) return -1
  let lo = 0
  let hi = runs.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (runs[mid].t0 <= tMs) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * `t` 时刻谱面走到哪（条带坐标 x）。
 *
 * - `t` 在曲前 ⇒ 第一个音的中心；在曲后 ⇒ 最后一个音的中心（不外推）；
 * - **按音符插值**（`adj1282`，用户 2026-11-09「定位色块处的音符与合成音没对齐」）：
 *   原来按"小节内 x ∝ t"插值，可是空间优先排版里音符的 x **不跟时值成比例**，
 *   于是色块压不到正在响的那个音。现在：
 *   · 每个音符**起点** ⇔ 它自己的中心（`x + w/2`）；
 *   · 音符进行中，从本音中心线性走到**下一个音的中心**（滚动仍然连续，只是在下一音起点精确落位）。
 */
export function stripXAt(strip: LinearStrip, tMs: number): number {
  const notes = strip.notes
  if (notes.length === 0) {
    const runs = strip.runs
    if (runs.length === 0) return 0
    if (tMs <= runs[0].t0) return runs[0].x0
    const last = runs[runs.length - 1]
    if (tMs >= last.t1) return last.x1
    const r = runs[Math.max(0, stripRunAt(strip, tMs))]
    const span = r.t1 - r.t0
    if (span <= 0) return r.x0
    const f = Math.min(1, Math.max(0, (tMs - r.t0) / span))
    return r.x0 + (r.x1 - r.x0) * f
  }
  const centerOf = (i: number): number => notes[i].x + notes[i].w / 2
  if (tMs <= notes[0].t0) return centerOf(0)
  const lastIdx = notes.length - 1
  if (tMs >= notes[lastIdx].t1) return centerOf(lastIdx)
  // 二分：最后一个 t0 <= t 的音
  let lo = 0
  let hi = lastIdx
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (notes[mid].t0 <= tMs) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const n = notes[ans]
  const span = Math.max(1, n.t1 - n.t0)
  const f = Math.min(1, Math.max(0, (tMs - n.t0) / span))
  return centerOf(ans) + (centerOf(Math.min(lastIdx, ans + 1)) - centerOf(ans)) * f
}

/** 条带总时长（= 最后一段的结束时刻） */
export function stripEndMs(strip: LinearStrip): number {
  const runs = strip.runs
  return runs.length === 0 ? 0 : runs[runs.length - 1].t1
}
