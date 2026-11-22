/**
 * tools/waveRuler.ts — 波形**下方时间标尺**的刻度选择 + 视野（缩放/平移）
 *
 * **这份是从爱出片（ijipu-cp）原样搬过来的**：源文件 `ijipu-cp/src/sync/syncRuler.ts`，
 * 逐字复制，只改了文件头这几行。爱出片里它服务「对拍台」，这里服务「音频片段截取」——
 * 两者都是"一条音轨 + 时间轴 + 要精确到毫秒的定位"，口径完全一样，所以不再另写一套。
 *
 * 用户 2026-11-18 明确：「就不能直接把 cp 里的这一套搬过来吗？非得我再说一遍」
 * ⇒ 以后遇到"播放 / 试听 / 定位 / 标记"这类音频时间轴的东西，先看 cp 有没有，有就搬。
 *
 * 原文件说明（爱出片）：
 *  用户 2026-10-24：「在音频波形图下侧显示时间标尺，以方便定位」。
 *  为什么单独一个模块：标尺的"该画多密"是一个**纯数学**决定（可视时长 ÷ 像素宽），
 *  抽出来才能在 Node 里断言（`npm run smoke` 的 `adj1122`），也不会散落在画布代码里。
 *  口径：
 *   - 只从**好看的步长**里挑（0.1/0.2/0.25/0.5/1/2/5/10/15/30/60/120/300/600 秒）；
 *   - 保证**标签之间至少 `minLabelPx` 像素**（默认 64，够放 `12:34`）；
 *   - 整曲（几分钟）走 `m:ss`，放大到 1 秒以内走 `m:ss.s` / `m:ss.ss`；
 *   - 次刻度 = 主刻度 4 等分（≥1 秒）或 5 等分（<1 秒），只画短线不写字。
 */

/** 候选步长（秒），从细到粗 */
const NICE_STEPS_SEC = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600] as const

export interface TimeScale {
  /** 主刻度间隔（ms） */
  stepMs: number
  /** 落在可视区间内的刻度时刻（ms，整数） */
  ticks: number[]
  /** 次刻度间隔（ms） */
  minorMs: number
}

/**
 * 按可视窗口与像素宽挑刻度。
 *
 * @param viewStartMs 可视左缘（ms，≥0）
 * @param viewEndMs   可视右缘（ms，> start）
 * @param widthPx     画布 CSS 宽度
 * @param minLabelPx  两个标签之间至少多少像素（默认 64）
 */
export function timeScaleOf(
  viewStartMs: number,
  viewEndMs: number,
  widthPx: number,
  minLabelPx = 64,
): TimeScale {
  const start = Math.max(0, Math.min(viewStartMs, viewEndMs - 1))
  const spanMs = Math.max(1, viewEndMs - start)
  const perPx = spanMs / Math.max(1, widthPx)
  const minStepMs = perPx * Math.max(16, minLabelPx)
  const stepSec =
    NICE_STEPS_SEC.find((s) => s * 1000 >= minStepMs) ?? NICE_STEPS_SEC[NICE_STEPS_SEC.length - 1]
  const stepMs = stepSec * 1000
  const first = Math.ceil(start / stepMs) * stepMs
  const ticks: number[] = []
  // 上限 400 个：宽度极小或时长极长时也不会画出天量刻度
  for (let t = first; t <= viewEndMs + 1e-6 && ticks.length < 400; t += stepMs) {
    ticks.push(Math.round(t))
  }
  const minorMs = stepMs / (stepSec >= 1 ? 4 : 5)
  return { stepMs, ticks, minorMs }
}

/** 刻度文字：`m:ss` / `m:ss.s` / `m:ss.ss`（按步长决定小数位，不多写） */
export function timeLabelOf(ms: number, stepMs: number): string {
  const total = Math.max(0, ms)
  const min = Math.floor(total / 60000)
  const restMs = total - min * 60000
  const sec = Math.floor(restMs / 1000)
  const decimals = stepMs >= 1000 ? 0 : stepMs % 100 === 0 ? 1 : 2
  const secText =
    decimals === 0
      ? String(sec).padStart(2, '0')
      : (restMs / 1000).toFixed(decimals).padStart(decimals === 1 ? 4 : 5, '0')
  return `${min}:${secText}`
}

/**
 * 波形的**视野**（用户 2026-10-24：「波形也要能缩放，单位宽度上显示的波形时长，默认整曲」）。
 *
 * 口径：`spanMs === 0` **表示整曲**（默认），此时不存 `startMs`——
 * 这样"换了伴奏/时长变了"之后不用重新算，天然还是整曲。
 */
export interface WaveView {
  /** 视野长度（ms）；**0 = 整曲** */
  spanMs: number
  /** 视野左缘（ms）；整曲时忽略 */
  startMs: number
}

export const VIEW_ALL: WaveView = { spanMs: 0, startMs: 0 }

/**
 * adj1136（用户 2026-10-24：「当前位置可以显示 小节:拍位 + 绝对时点位置(s)」）：
 * 绝对时点写成 **`m:ss.ss`**（固定两位小数，宽度不跳）。
 */
export function audioClockOf(ms: number): string {
  const total = Math.max(0, ms)
  const min = Math.floor(total / 60000)
  const restSec = (total - min * 60000) / 1000
  return `${min}:${restSec.toFixed(2).padStart(5, '0')}`
}

/**
 * 可能为负的音频时刻：负的显示成 `-m:ss.xx`。
 * 负偏移时谱面 1:1 落在音频 0 之前，时间刻度/音符格标题会出现负值。
 */
export function audioClockSigned(ms: number): string {
  return ms < 0 ? `-${audioClockOf(-ms)}` : audioClockOf(ms)
}

/**
 * 视野预设（0 = 整曲）
 */
export const VIEW_PRESETS_MS = [0, 300000, 120000, 60000, 30000, 10000] as const

/** 视野过短没意义（低于 1 秒就看不清波形了） */
export const VIEW_MIN_MS = 1000

/**
 * 夹进合法范围：`spanMs ≥ durMs` 视为整曲；否则把左缘夹到 `[0, dur − span]`。
 */
export function clampView(view: WaveView, durMs: number): WaveView {
  const dur = Math.max(1, durMs)
  const span = Number.isFinite(view.spanMs) ? view.spanMs : 0
  if (span <= 0 || span >= dur) return VIEW_ALL
  const want = Math.max(VIEW_MIN_MS, span)
  const start = Math.min(
    Math.max(0, Number.isFinite(view.startMs) ? view.startMs : 0),
    Math.max(0, dur - want),
  )
  return { spanMs: want, startMs: start }
}

/** 视口 → 实际窗口（`v0` 左缘、`winMs` 长度） */
export function viewWindow(view: WaveView, durMs: number): { v0: number; winMs: number } {
  const v = clampView(view, durMs)
  if (v.spanMs === 0) return { v0: 0, winMs: Math.max(1, durMs) }
  return { v0: v.startMs, winMs: v.spanMs }
}

/**
 * 缩放：保持 `anchorMs`（鼠标那一处的时刻）**在屏幕上的位置不动**。
 * `factor > 1` = 放大（视野变短），`< 1` = 缩小；缩到比整曲还长 ⇒ 回整曲。
 */
export function zoomView(view: WaveView, durMs: number, factor: number, anchorMs: number): WaveView {
  const { v0, winMs } = viewWindow(view, durMs)
  const dur = Math.max(1, durMs)
  const ratio = Math.min(1, Math.max(0, (anchorMs - v0) / winMs))
  const next = winMs * factor
  if (!(next > 0) || next >= dur) return VIEW_ALL
  const span = Math.max(VIEW_MIN_MS, next)
  return clampView({ spanMs: span, startMs: anchorMs - ratio * span }, dur)
}

/** 平移：`dxMs > 0` = 往右看（视野起点变大） */
export function panView(view: WaveView, durMs: number, dxMs: number): WaveView {
  const v = clampView(view, durMs)
  if (v.spanMs === 0) return VIEW_ALL
  return clampView({ spanMs: v.spanMs, startMs: v.startMs + dxMs }, durMs)
}

/**
 * adj1319（用户 2026-11-19：「波形放大后，应添加滚动条来移动波形显示位置」）：
 * 视野滑块在整条音轨上的位置与宽度（百分比）。整曲时不显示滑块。
 *
 * 这段也是从爱出片 `ijipu-cp/src/sync/syncRuler.ts` 的 `scrollThumb` 搬过来的，
 * 连注释一起：**右端不许越界**（浮点误差会让滑块跑出轨道 0.01px，看着像"还能再动一点"）。
 */
export function scrollThumb(
  view: WaveView,
  durMs: number,
): { leftPct: number; widthPct: number; visible: boolean } {
  const v = clampView(view, durMs)
  const dur = Math.max(1, durMs)
  if (v.spanMs === 0) return { leftPct: 0, widthPct: 100, visible: false }
  const widthPct = Math.min(100, (v.spanMs / dur) * 100)
  const leftPct = Math.max(0, Math.min(100 - widthPct, (v.startMs / dur) * 100))
  return { leftPct, widthPct, visible: true }
}
