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
 * ## 口径（`adj1284`，用户 2026-11-09 定稿）
 *
 * > 「谱子在移动，跳跳球落下时，谱子刚好移到拍位上……由于是空间优先，谱子的移动可能不是匀速的，
 * >  而是要根据下一拍的占宽和一拍的时值来计算下一拍谱子的移动速度，以保证一拍结束后，
 * >  谱子刚好移动到下一拍，然后重算下下拍」
 *
 * 所以**按拍**插值，不按音符、也不按小节：
 *  · `strip.beatXs[k]` = 第 k 拍的谱面位置（该拍第一个音的中心；由 `strip.ts` 建表）；
 *  · 本拍到下一拍之间**匀速**：`f = 拍内进度`，`x = beatXs[k] + (beatXs[k+1] − beatXs[k]) × f`；
 *  · 于是每一拍结束时（球落地那一刻）谱面**正好**到下一拍，速度逐拍重算。
 *
 * ## 这条为什么必须机器化（走过的两次错）
 *
 * · `adj1282` 按"音符"插值：每到一个音就落位，但一个音符的**起点**并不是拍点
 *   （十六分音符的起点在拍中间），滚动速度被音距牵着走；
 * · `adj1283` 把音符时刻改成按拍位算，可插值跨度还是"本音时值"，且 `strip.ts` 把不足一拍的
 *   时值钳成了 1 拍 ⇒ 八分音符慢 2 倍、十六分音符慢 **4 倍**，用户看到「合成音走了 8 拍、
 *   谱子才走 2 拍」。现在时值不再参与插值（它只表示"这个音多长"），拍点才是唯一的时间锚。
 */
export function stripXAt(strip: LinearStrip, tMs: number): number {
  const bx = strip.beatXs
  if (bx.length === 0) {
    // 兜底（历史数据/空条带）：仍按段内 x ∝ t，绝不返回 NaN
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
  const beatMs = strip.beatMs > 1 ? strip.beatMs : 1
  const beat = tMs / beatMs
  if (beat <= 0) return bx[0]
  const k = Math.floor(beat)
  if (k >= bx.length - 1) return bx[bx.length - 1]
  const f = beat - k
  return bx[k] + (bx[k + 1] - bx[k]) * f
}

/** 条带总时长（= 最后一段的结束时刻） */
export function stripEndMs(strip: LinearStrip): number {
  const runs = strip.runs
  return runs.length === 0 ? 0 : runs[runs.length - 1].t1
}
