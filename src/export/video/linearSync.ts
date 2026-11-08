/**
 * export/video/linearSync.ts — 连续动态谱「对拍台」的时间轴与混音口径（adj1264，纯函数）
 *
 * ## 为什么单独一个纯模块
 *
 * 台面里的四件事都是**同一套口径**在不同地方的消费：
 *  · 预览：媒体时刻 → 谱面时刻（`scoreMsAt`）；
 *  · 打点：谱面拍位 ← 媒体时刻（同一个映射的逆运算是 `mediaMsAt`）；
 *  · 出片：保留段 [start,end] 夹进媒体长度、再决定编多少帧（`exportRangeOf`）；
 *  · 混音：视频原声 / 外部伴奏 / 合成音三路谁响、各多少音量（`linearMixPlanOf`）。
 *
 * 这四件事只要有一处各算一套，"框里看到的"和"出片出来的"就会错位（本项目多次踩过）。
 * 所以这里**只放纯函数**：Node 里能断言，台面与出片共用同一份。
 *
 * ## 时间轴口径（用户 2026-11-08 定）
 *
 *  · 主时间轴 = **视频**（没视频时退化成伴奏/纯谱面）；
 *  · `offsetMs` = 谱面第 1 拍落在主时间轴上的时刻（对拍解出来的）；
 *  · 谱面时刻 `0` = 谱面第 1 拍；谱面时刻 = 媒体时刻 − `offsetMs`；
 *  · 媒体比谱面先开始的那一段（`offsetMs > 0`）= **前奏等待**，谱面定格在第 1 拍；
 *  · 时长上限**按视频长度**（P6），不套 3 分钟。
 */

/** 混音三档（与 `syncDoc.SyncMix.source` 同一套值，这里不反向依赖它） */
export type LinearMixSource = 'file' | 'synth' | 'mix'

/** 台面/出片要的时钟 */
export interface LinearClock {
  /** 谱面第 1 拍在主时间轴上的时刻（ms） */
  offsetMs: number
  /** 主时间轴总长（ms；0 = 没有视频也没有伴奏） */
  mediaMs: number
  /** 条带最后一个音的结束时刻（谱面时间轴，0 = 第 1 拍） */
  scoreEndMs: number
  /** 谱面一拍多少毫秒 */
  scoreBeatMs: number
  /** 会话总长（ms）：有媒体用媒体长，没有就用"前奏 + 谱面" */
  totalMs: number
  /** 前奏等待（ms）：谱面第 1 拍之前那段媒体时间 */
  headWaitMs: number
}

export interface LinearClockInput {
  /** 谱面第 1 拍在主时间轴上的时刻（没对拍时传 0） */
  offsetMs: number
  /** 视频/伴奏时长（0 = 都没有） */
  mediaMs: number
  /** 条带结束时刻（谱面时间轴） */
  scoreEndMs: number
  /** 谱面一拍（ms；非法值按 500 兜底，不把 NaN 传下去） */
  scoreBeatMs: number
}

const finite = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback)

/** 建时钟（把非法值兜住，台面直接拿去用不会出现 NaN） */
export function linearClockOf(input: LinearClockInput): LinearClock {
  const beatMs = Math.max(20, finite(input.scoreBeatMs, 500))
  const scoreEnd = Math.max(0, finite(input.scoreEndMs, 0))
  const media = Math.max(0, finite(input.mediaMs, 0))
  const offset = finite(input.offsetMs, 0)
  /**
   * 没有媒体（没视频、没伴奏）时也要能画：总长 = 谱面自己的长度（`offset` 归零，
   * 否则"没有媒体却有前奏"会多出一段静止画面）。
   */
  const totalMs = media > 0 ? media : scoreEnd
  const headWait = media > 0 ? Math.max(0, offset) : 0
  return { offsetMs: media > 0 ? offset : 0, mediaMs: media, scoreEndMs: scoreEnd, scoreBeatMs: beatMs, totalMs, headWaitMs: headWait }
}

/**
 * 媒体时刻 → 谱面时刻（夹在 `[0, scoreEndMs]`）。
 *
 * 前奏等待里返回 0（谱面定格第 1 拍）——与「出片前奏谱面定格」同一口径（`adj1148`）。
 */
export function scoreMsAt(clock: LinearClock, mediaMs: number): number {
  const t = finite(mediaMs, 0) - clock.offsetMs
  if (!(t > 0)) return 0
  return Math.min(t, clock.scoreEndMs)
}

/** 谱面时刻 → 媒体时刻（`scoreMsAt` 的逆；同样夹在 `[0, totalMs]`） */
export function mediaMsAt(clock: LinearClock, scoreMs: number): number {
  const t = clock.offsetMs + finite(scoreMs, 0)
  return Math.max(0, Math.min(t, clock.totalMs))
}

/** 导出范围（媒体时间轴，已夹进 `[0, totalMs]`） */
export interface LinearRange {
  startMs: number
  endMs: number
  /** 长度（ms；至少 1 帧，免得编出 0 帧文件） */
  durationMs: number
}

/**
 * 保留段 → 导出范围。
 *
 * 口径：结束 ≤ 开始 ⇒ 当"整曲"（用户还没设终点时不该出空片）；
 * 长度至少 34ms（≈ 1 帧 30fps），否则 `frameCount` 会算成 0。
 */
export function exportRangeOf(clock: LinearClock, trim: { startMs: number; endMs: number }): LinearRange {
  const total = Math.max(1, clock.totalMs)
  let start = Math.max(0, Math.min(finite(trim.startMs, 0), total))
  let end = Math.max(0, Math.min(finite(trim.endMs, total), total))
  if (!(end > start)) {
    start = 0
    end = total
  }
  if (end - start < 34) end = Math.min(total, start + 34)
  return { startMs: Math.round(start), endMs: Math.round(end), durationMs: Math.round(end - start) }
}

/** 混音输入：三路"有没有料"与三条音量 */
export interface LinearMixInput {
  /** 视频自带音轨（解码成功才算） */
  hasVideoAudio: boolean
  /** 外部伴奏（用户另外加的那条） */
  hasAccomp: boolean
  /** 合成音（按谱面渲染出来了） */
  hasSynth: boolean
  source: LinearMixSource
  /** 视频原声音量（0~2，缺省 1） */
  videoGain: number
  /** 伴奏音量（0~2，缺省 1） */
  accompGain: number
  /** 合成音音量（0~2，缺省 0.5） */
  synthGain: number
}

/** 混音计划：这一档到底放哪几条、各多少音量 */
export interface LinearMixPlan {
  video: boolean
  accomp: boolean
  synth: boolean
  videoGain: number
  accompGain: number
  synthGain: number
  /** 合成音渲染失败时回退到哪一路（`'none'` = 没回退） */
  synthFallback: 'none' | 'video' | 'accomp'
  /** 三路都没声（台面要明确提示，不许"点了播放没反应"） */
  silent: boolean
}

const gainOf = (v: number, fallback: number): number => {
  const n = finite(v, fallback)
  return Math.min(2, Math.max(0, n))
}

/**
 * 混音计划（用户 2026-11-08 口径：**没加单独音频 ⇒ 用视频的音频；加了 ⇒ 用单独那条**）。
 *
 * 判定顺序：
 *  ① 有外部伴奏 ⇒ 视频原声**不再出声**（避免两路同一段声音叠成回声）；
 *     `file`/`mix` 放伴奏，`mix` 再加合成音，`synth` 只要合成音；
 *  ② 没有外部伴奏、但视频有音轨 ⇒ 视频原声就是"这一条"：
 *     `file` 只放它，`mix` 再加合成音；`synth` 也只要合成音，**渲染失败**才回退到视频原声；
 *  ③ 两样都没有 ⇒ 只剩合成音（没有就静音，台面按 `silent` 提示）。
 */
export function linearMixPlanOf(input: LinearMixInput): LinearMixPlan {
  const videoGain = gainOf(input.videoGain, 1)
  const accompGain = gainOf(input.accompGain, 1)
  const synthGain = gainOf(input.synthGain, 0.5)
  const base = { videoGain, accompGain, synthGain, synthFallback: 'none' as const }

  if (input.hasAccomp) {
    const playSynth = input.source !== 'file' && input.hasSynth
    const playAcc = input.source !== 'synth' || !input.hasSynth
    return {
      ...base,
      video: false,
      accomp: playAcc,
      synth: playSynth,
      // 选了合成音却渲染不出来 ⇒ 按文案回退到伴奏（不是"什么都不响"）
      synthFallback: input.source === 'synth' && !input.hasSynth ? 'accomp' : 'none',
      silent: !playAcc && !playSynth,
    }
  }
  if (input.hasVideoAudio) {
    const wantsSynth = input.source !== 'file' && input.hasSynth
    const synthOnly = input.source === 'synth'
    const fallback = synthOnly && !input.hasSynth
    return {
      ...base,
      video: !synthOnly || fallback,
      accomp: false,
      synth: synthOnly ? false : wantsSynth,
      synthFallback: fallback ? 'video' : 'none',
      silent: false,
    }
  }
  const synth = input.hasSynth
  return { ...base, video: false, accomp: false, synth, synthFallback: 'none', silent: !synth }
}

/** 输出宽高（H.264 要偶数；奇数往下取偶，最小 2） */
export function evenSizeOf(width: number, height: number): { width: number; height: number } {
  const even = (v: number): number => {
    const n = Math.max(2, Math.round(finite(v, 2)))
    return n % 2 === 0 ? n : n - 1
  }
  return { width: even(width), height: even(height) }
}

/**
 * 定位色块的**固定宽度** = 一个音符（一个数字）的宽度。
 *
 * 用户 2026-11-09：「定位色块以一个音符宽度，固定宽度即可」——
 * 原来是 `谱带高 × 0.55`（≈ 两个多字宽，把当前音连同后面的音一起罩住），
 * 现在按**字号 × 0.62** 算：这才是"一个数字"的墨迹宽（与 `strip.notes[].w` 同量级），
 * 而且**不随小节/时值变化**（长音不会把色块拉长，用户要的是"固定宽度"）。
 *
 * @param noteSize 谱带字号（`strip.noteSize`，未乘 bandScale）
 * @param scale    谱带在画布上的缩放（`stripH / strip.height`）
 */
export const LOCATOR_NOTE_RATIO = 0.62

export function locatorBlockWidthOf(noteSize: number, scale = 1): number {
  const s = Math.max(0.05, finite(scale, 1))
  const w = Math.max(4, finite(noteSize, 16) * s * LOCATOR_NOTE_RATIO)
  return Math.max(6, Math.round(w))
}
