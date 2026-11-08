/**
 * export/video/linearExport.ts — 连续动态谱**出片**（adj1264）
 *
 * 只做两件事：
 *  ① **混音**：把视频原声 / 外部伴奏 / 合成音按 `linearMixPlanOf` 的计划，裁到保留段、按各自音量
 *     混成一条 `AudioBuffer`（同一条时间轴：媒体时刻）；
 *  ② **编码**：交给现成的 `encodeMp4`（它已经处理了 WebCodecs、关键帧、背压、音轨等长）。
 *
 * 为什么不自己写一套编码：`mp4.ts` 的注释里写过理由（Mediabunny + WebCodecs 现成路），
 * 单行谱只在"每帧画什么"上不同；编码循环复制一份就会有两套时间戳。
 *
 * 为什么用 `OfflineAudioContext` 混音而不是逐采样相加：三路音源可能采样率不同（视频音轨常见 48k，
 * 合成音 44.1k），`AudioBufferSourceNode` 会自动重采样；逐采样相加就得自己写重采样。
 */

import { ACCOMP_SAMPLE_RATE } from './accompaniment'
import { encodeMp4, type EncodableSession } from './mp4'
import type { LinearMixPlan, LinearRange } from './linearSync'

/** 一条要混进去的轨 */
export interface LinearAudioTrack {
  buffer: AudioBuffer
  /** 音量（0~2） */
  gain: number
  /** 这条轨在**媒体时间轴**上的起点（ms）；伴奏/视频原声 = 0，合成音 = 谱面第 1 拍的媒体时刻 */
  startAtMs: number
  /** 变速（合成音按谱面拍速渲染，与对拍拍速不同时用；缺省 1） */
  rate?: number
}

/**
 * 把音轨按"从媒体时刻 `fromMs` 起播"排成 AudioContext 的排点参数（纯函数，Node 可断言）。
 *
 * 台面试听与出片混音**必须用同一套**（预览一套、出片一套 ⇒ 音画必错）。
 */
export function playbackWindowsOf(
  tracks: LinearAudioTrack[],
  fromMs: number,
): { whenSec: number; skipSec: number }[] {
  return tracks.map((t) => ({
    whenSec: Math.max(0, (t.startAtMs - fromMs) / 1000),
    skipSec: Math.max(0, (fromMs - t.startAtMs) / 1000),
  }))
}

/**
 * 按混音计划挑出要放的轨（纯函数，Node 可断言）。
 *
 * 顺序固定：视频原声 → 伴奏 → 合成音。**同一条音源不重复**（否则会叠成回声）。
 */
export function audioTracksOf(
  plan: LinearMixPlan,
  src: { video: AudioBuffer | null; accomp: AudioBuffer | null; synth: AudioBuffer | null },
  synthStartMs = 0,
  synthRate = 1,
): LinearAudioTrack[] {
  const out: LinearAudioTrack[] = []
  if (plan.video && src.video !== null) out.push({ buffer: src.video, gain: plan.videoGain, startAtMs: 0 })
  if (plan.accomp && src.accomp !== null) out.push({ buffer: src.accomp, gain: plan.accompGain, startAtMs: 0 })
  if (plan.synth && src.synth !== null) {
    out.push({ buffer: src.synth, gain: plan.synthGain, startAtMs: Math.max(0, synthStartMs), rate: synthRate })
  }
  return out
}

/**
 * 把若干轨混成一条（媒体时间轴 `[range.startMs, range.endMs]`，两端可各补一段静音）。
 *
 * adj1265：带片头/片尾卡时，画面比音乐长——`pad.headMs` = 片头、`pad.tailMs` = 片尾，
 * 音轨按它们在**会话时间轴**上对齐。不补的话播放器会把视频时长算短，卡片段直接没有声音轨。
 *
 * 没有可用轨 ⇒ `null`（无声视频；不要造一条空音轨，那会让播放器把时长算错）。
 */
export async function mixLinearAudio(
  tracks: LinearAudioTrack[],
  range: LinearRange,
  pad: { headMs?: number; tailMs?: number } = {},
): Promise<AudioBuffer | null> {
  const used = tracks.filter((t) => t.gain > 0 && t.buffer.numberOfChannels > 0)
  if (used.length === 0) return null
  const head = Math.max(0, Math.round(pad.headMs ?? 0))
  const tail = Math.max(0, Math.round(pad.tailMs ?? 0))
  const totalMs = Math.max(1, head + range.durationMs + tail)
  const len = Math.max(1, Math.ceil((totalMs / 1000) * ACCOMP_SAMPLE_RATE))
  const ctx = new OfflineAudioContext(2, len, ACCOMP_SAMPLE_RATE)
  let scheduled = 0
  for (const t of used) {
    const rate = t.rate !== undefined && t.rate > 0 ? t.rate : 1
    // 媒体时刻 → 这条轨自己的时刻（合成音可能"晚于保留段起点"；片头段整体往后挪 `head`）
    const when = (head + Math.max(0, t.startAtMs - range.startMs)) / 1000
    const skip = Math.max(0, (range.startMs - t.startAtMs) / 1000)
    if (when >= totalMs / 1000) continue
    const dur = Math.min(
      totalMs / 1000 - when,
      Math.max(0, t.buffer.duration - skip),
      Math.max(0, (head + range.durationMs) / 1000 - when),
    )
    if (dur <= 0) continue
    const src = ctx.createBufferSource()
    src.buffer = t.buffer
    src.playbackRate.value = rate
    const gain = ctx.createGain()
    gain.gain.value = t.gain
    src.connect(gain)
    gain.connect(ctx.destination)
    src.start(when, skip, dur)
    scheduled += 1
  }
  if (scheduled === 0) return null
  return ctx.startRendering()
}

export interface LinearEncodeOptions {
  fps?: number
  audio?: AudioBuffer | null
  onProgress?: (p: number) => void
  signal?: AbortSignal
  /** 码率（缺省沿用 `mp4.ts` 的 8 Mbps） */
  bitrate?: number
  /** 封面取哪一刻（缺省 0；带片头卡时取"卡片最完整"的那一帧） */
  coverMs?: number
}

/**
 * 编一段连续动态谱。
 *
 * 会话由台面建（`createLinearSession` + 把总长/时间映射包成保留段），
 * 这里只负责"给编码器一条等长的音轨"。
 */
export async function encodeLinearMp4(session: EncodableSession, opts: LinearEncodeOptions = {}): Promise<Blob> {
  return encodeMp4(session, {
    fps: opts.fps ?? 30,
    audio: opts.audio ?? null,
    // 连续谱默认抓第 0 帧；带片头卡时由调用方传"卡片最完整"的那一刻
    coverMs: opts.coverMs ?? 0,
    ...(opts.bitrate !== undefined ? { bitrate: opts.bitrate } : {}),
    ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  })
}
