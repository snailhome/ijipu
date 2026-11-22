/**
 * tools/mux.ts — 视频容器读写：合并音轨 / 拆出无声视频 / 拆出音频（adj1316）
 *
 * 从 `ijipu-cp/src/media/mediaTool.ts` **移植**（cp 是独立私仓，网页不能 import 它的源码），
 * 逻辑与注释基本照搬，只换了两处依赖 —— cp 那边用的 `decodeAccompaniment` / `mixAudioBuffers`
 * 在本文件里重写成 `decodeAudioBytes` / `mixBuffers`，免得把出片的渲染模块拖进来。
 *
 * 核心口径（cp 2026-11-17 用真素材定下来的，别改回去）：
 *  · 视频**能搬就搬**：`EncodedPacketSink` 读原始编码包 → `EncodedVideoPacketSource` 写进新容器，
 *    等于 ffmpeg 的 `-c:v copy`：不解码、不重编码、不掉画质，体积≈源文件；
 *  · 音频同样能搬就搬：没混音、换进来的本来就是 AAC/MP3 时整包搬，54 kbps 的 m4a 合进去还是 54 kbps；
 *  · 只有混音（必须解成 PCM）或换进来的格式搬不了（WAV）才重编 AAC，码率跟随源文件；
 *    **浏览器的 AAC 编码器只认 96k/128k/160k/192k**（64k 直接被拒），所以就近往上取一档；
 *  · 输出统一 MP4（H.264/HEVC/AV1 + AAC），旋转信息随轨道写进去（竖屏素材不会躺倒）。
 */
import {
  ALL_FORMATS,
  AudioBufferSource,
  AudioSampleSink,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSampleSink,
  VideoSampleSource,
} from 'mediabunny'
import type { AudioCodec, InputAudioTrack, InputVideoTrack, Rotation, VideoCodec } from 'mediabunny'
import { toolsCopy } from './copy'

const SAMPLE_RATE = 44_100
/** 重编 AAC 的保底码率：源文件码率读不出来时用它 */
const FALLBACK_AUDIO_BITRATE = 192_000
/** 重编 AAC 时尝试的码率档（浏览器实测可用值） */
const AUDIO_ENCODE_LADDER: readonly number[] = [96_000, 128_000, 160_000, 192_000]
const AUDIO_BITRATE_MIN = 48_000
const AUDIO_BITRATE_MAX = 320_000
const AUDIO_BITRATE_SAMPLE_PACKETS = 400
/** 能直接搬进 MP4、Windows 自带播放器也认的视频编码 */
const COPYABLE_VIDEO_CODECS: readonly VideoCodec[] = ['avc', 'hevc', 'av1']
/** 同样能直接搬进 MP4 的音频编码 */
const COPYABLE_AUDIO_CODECS: readonly AudioCodec[] = ['aac', 'mp3']
const REENCODE_MIN_BITRATE = 600_000
const REENCODE_MAX_BITRATE = 12_000_000
/** 同码率重编也会掉一点画质，给源留 25% 余量 */
const REENCODE_HEADROOM = 1.25
const FALLBACK_BITRATE = 4_000_000
const BITRATE_SAMPLE_PACKETS = 120

export type AudioMergeMode = 'replace' | 'mix'

/** 重编 AAC 用多大码率：`'source'` = 跟随源文件（默认） */
export type AudioBitratePreference = 'source' | number

export interface MergeOptions {
  audioBitrate?: AudioBitratePreference
}

export interface MediaProgress {
  (ratio: number, label: string): void
}

export async function openInput(file: File): Promise<Input> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  if (!(await input.canRead())) {
    input.dispose()
    throw new Error(toolsCopy.common.errors.unreadable)
  }
  return input
}

/** 用 WebAudio 解码一整块音频（wav / mp3 / m4a / flac / ogg 都行） */
export async function decodeAudioBytes(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
  const Ctx = w.AudioContext ?? w.webkitAudioContext
  if (Ctx === undefined) throw new Error(toolsCopy.capability.noAudio)
  const ctx = new Ctx()
  try {
    return await ctx.decodeAudioData(bytes.slice(0))
  } finally {
    void ctx.close().catch(() => undefined)
  }
}

/** 若干条同采样率的音轨按增益相加（超出 ±1 就夹住，不静默爆音） */
export function mixBuffers(tracks: { buffer: AudioBuffer; gain: number }[], totalMs: number): AudioBuffer {
  const rate = SAMPLE_RATE
  const len = Math.max(1, Math.ceil((totalMs / 1000) * rate))
  const out = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: rate })
  const left = out.getChannelData(0)
  const right = out.getChannelData(1)
  for (const t of tracks) {
    const l = t.buffer.getChannelData(0)
    const r = t.buffer.getChannelData(Math.min(1, t.buffer.numberOfChannels - 1))
    for (let i = 0; i < len; i += 1) {
      const gl = (i < l.length ? l[i] : 0) * t.gain
      const gr = (i < r.length ? r[i] : 0) * t.gain
      left[i] = Math.max(-1, Math.min(1, left[i] + gl))
      right[i] = Math.max(-1, Math.min(1, right[i] + gr))
    }
  }
  return out
}

/** 把视频自带音轨解成一条 AudioBuffer（时长按视频时长补静音） */
export async function mediaAudioToBuffer(input: Input, durationSec: number): Promise<AudioBuffer | null> {
  const track = await input.getPrimaryAudioTrack()
  if (track === null) return null
  const sink = new AudioSampleSink(track)
  const samples: AudioBuffer[] = []
  const stamps: number[] = []
  let rate = SAMPLE_RATE
  let channels = 2
  for await (const s of sink.samples()) {
    stamps.push(s.timestamp)
    if (samples.length === 0) {
      rate = s.sampleRate
      channels = Math.max(1, Math.min(2, s.numberOfChannels))
    }
    samples.push(s.toAudioBuffer())
    s.close()
  }
  if (samples.length === 0) return null
  const len = Math.max(1, Math.ceil(durationSec * rate))
  const out = new AudioBuffer({ numberOfChannels: channels, length: len, sampleRate: rate })
  for (let i = 0; i < samples.length; i += 1) {
    const at = Math.max(0, Math.round(stamps[i] * rate))
    const src = samples[i]
    const n = Math.min(src.length, len - at)
    if (n <= 0) continue
    for (let ch = 0; ch < channels; ch += 1) {
      out
        .getChannelData(ch)
        .set(src.getChannelData(Math.min(ch, src.numberOfChannels - 1)).subarray(0, n), at)
    }
  }
  return out
}

/** 转成 44.1k 双声道，并裁/补到目标时长（混音与编码共用） */
async function conform(buffer: AudioBuffer, durationSec: number): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.ceil(durationSec * SAMPLE_RATE))
  const ctx = new OfflineAudioContext(2, frames, SAMPLE_RATE)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(ctx.destination)
  src.start(0)
  return await ctx.startRendering()
}

/** 视频轨的处理计划：能搬就搬（不解码），不能搬才重编 */
type TrackPlan =
  | { kind: 'copy'; codec: VideoCodec; decoderConfig: VideoDecoderConfig; rotation: Rotation }
  | { kind: 'encode'; bitrate: number }

/**
 * 音频轨的处理计划：
 *  · `copy`   —— 整包搬（原声没动，或换进来的本来就是 AAC/MP3），码率一个比特都不变；
 *  · `encode` —— 必须重编（混音、或换进来的是 WAV 这类搬不动的格式）。
 * `limitSec` 是搬运时的时间上限：换进来的音频比视频长时，多出来的那截不写。
 */
type AudioPlan =
  | { kind: 'copy'; codec: AudioCodec; decoderConfig: AudioDecoderConfig; track: InputAudioTrack; limitSec: number }
  | { kind: 'encode'; buffer: AudioBuffer; bitrate: number }

/** 估算「照原样重编」该用多大码率：先问容器头，读不到再抽包统计 */
async function reencodeBitrateOf(track: InputVideoTrack): Promise<number> {
  let raw: number | null = null
  try {
    raw = await track.getAverageBitrate()
    if (raw === null) raw = (await track.computePacketStats(BITRATE_SAMPLE_PACKETS)).averageBitrate
  } catch {
    raw = null
  }
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return FALLBACK_BITRATE
  return Math.min(REENCODE_MAX_BITRATE, Math.max(REENCODE_MIN_BITRATE, Math.round(raw * REENCODE_HEADROOM)))
}

/** 决定这条视频轨是「直通搬运」还是「解码重编」（白名单只放 MP4 通行的编码） */
async function planVideo(track: InputVideoTrack): Promise<TrackPlan> {
  const codec = track.codec
  if (codec !== null && COPYABLE_VIDEO_CODECS.includes(codec)) {
    const decoderConfig = await track.getDecoderConfig()
    // 没有 decoder config 就写不出 avcC/hvcC 盒子，搬出来的片子解不了 ⇒ 只能重编
    if (decoderConfig !== null) return { kind: 'copy', codec, decoderConfig, rotation: await track.getRotation() }
  }
  return { kind: 'encode', bitrate: await reencodeBitrateOf(track) }
}

function clampAudioBitrate(bps: number): number {
  if (!Number.isFinite(bps) || bps <= 0) return FALLBACK_AUDIO_BITRATE
  return Math.min(AUDIO_BITRATE_MAX, Math.max(AUDIO_BITRATE_MIN, Math.round(bps)))
}

/** 量一条音轨的平均码率：先问容器头（不读数据），读不到再抽包统计 */
async function averageAudioBitrateOf(track: InputAudioTrack): Promise<number | null> {
  try {
    const head = await track.getAverageBitrate()
    if (head !== null && Number.isFinite(head) && head > 0) return head
    const sampled = (await track.computePacketStats(AUDIO_BITRATE_SAMPLE_PACKETS)).averageBitrate
    return sampled !== null && Number.isFinite(sampled) && sampled > 0 ? sampled : null
  } catch {
    return null
  }
}

/** 挑一个这个环境真能编出来的 AAC 码率（浏览器只认固定几档，往上找最近的一档） */
async function encodeBitrateNear(desired: number): Promise<number> {
  if (typeof AudioEncoder === 'undefined') return AUDIO_ENCODE_LADDER[0]
  const usable: number[] = []
  for (const bitrate of AUDIO_ENCODE_LADDER) {
    try {
      const res = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 2,
        bitrate,
      })
      if (res.supported === true) usable.push(bitrate)
    } catch {
      /* 这一档这个环境不认识，跳过 */
    }
  }
  if (usable.length === 0) return AUDIO_ENCODE_LADDER[0]
  return usable.find((b) => b >= desired) ?? usable[usable.length - 1]
}

async function resolveAudioBitrate(
  preference: AudioBitratePreference,
  measured: number | null,
): Promise<number> {
  const desired = clampAudioBitrate(preference === 'source' ? (measured ?? FALLBACK_AUDIO_BITRATE) : preference)
  return await encodeBitrateNear(desired)
}

/** 这条音轨能不能整包搬（搬不了返回 null，调用方退到重编） */
async function planAudioCopy(track: InputAudioTrack | null, limitSec: number): Promise<AudioPlan | null> {
  if (track === null) return null
  const codec = track.codec
  if (codec === null || !COPYABLE_AUDIO_CODECS.includes(codec)) return null
  const decoderConfig = await track.getDecoderConfig()
  if (decoderConfig === null) return null
  return { kind: 'copy', codec, decoderConfig, track, limitSec }
}

/** 往输出里加视频轨，返回一个"把包喂完"的函数 */
async function videoFeedOf(
  output: Output,
  track: InputVideoTrack,
  plan: TrackPlan,
  span: number,
  onProgress: MediaProgress,
): Promise<() => Promise<void>> {
  if (plan.kind === 'copy') {
    const source = new EncodedVideoPacketSource(plan.codec)
    // 旋转信息存在容器里、不在帧里：不带下去，竖屏素材会被当成横屏播
    output.addVideoTrack(source, { rotation: plan.rotation, decoderConfig: plan.decoderConfig })
    const meta = { decoderConfig: plan.decoderConfig }
    return async () => {
      let count = 0
      for await (const packet of new EncodedPacketSink(track).packets()) {
        await source.add(packet, meta)
        count += 1
        if (count % 60 === 0) {
          const at = Math.max(0, packet.timestamp + packet.duration)
          onProgress(Math.min(0.92, (at / span) * 0.92), toolsCopy.common.progress.copyVideo)
        }
      }
    }
  }
  const source = new VideoSampleSource({ codec: 'avc', quality: new Quality({ bitrate: plan.bitrate }) })
  output.addVideoTrack(source)
  return async () => {
    let count = 0
    for await (const sample of new VideoSampleSink(track).samples()) {
      await source.add(sample)
      const at = Math.max(0, sample.timestamp)
      sample.close()
      count += 1
      if (count % 20 === 0) onProgress(Math.min(0.9, (at / span) * 0.9), toolsCopy.common.progress.encodeVideo)
    }
  }
}

/** 往输出里加音频轨，返回一个"把包/缓冲喂完"的函数 */
async function audioFeedOf(
  output: Output,
  audio: AudioPlan,
  span: number,
  onProgress: MediaProgress,
): Promise<() => Promise<void>> {
  if (audio.kind === 'encode') {
    const source = new AudioBufferSource({ codec: 'aac', bitrate: audio.bitrate })
    output.addAudioTrack(source)
    return async () => {
      onProgress(0.95, toolsCopy.common.progress.encodeAudio)
      await source.add(audio.buffer)
    }
  }
  const source = new EncodedAudioPacketSource(audio.codec)
  output.addAudioTrack(source, { decoderConfig: audio.decoderConfig })
  const meta = { decoderConfig: audio.decoderConfig }
  return async () => {
    onProgress(0.94, toolsCopy.common.progress.copyAudio)
    let count = 0
    for await (const packet of new EncodedPacketSink(audio.track).packets()) {
      // 换进来的音频可能比视频长：超出视频时长的那截不写，免得成片尾多出黑屏
      if (packet.timestamp >= audio.limitSec) break
      await source.add(packet, meta)
      count += 1
      if (count % 400 === 0) {
        const at = Math.max(0, packet.timestamp + packet.duration)
        onProgress(Math.min(0.96, 0.94 + Math.min(0.02, (at / span) * 0.02)), toolsCopy.common.progress.copyAudio)
      }
    }
  }
}

/** 按给定计划把视频（+可选音频）写成一个 MP4；中途出错会取消 output，不留下半成品 */
async function muxOnce(
  track: InputVideoTrack,
  durationSec: number,
  audio: AudioPlan | null,
  plan: TrackPlan,
  onProgress: MediaProgress,
): Promise<Blob> {
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat(), target })
  const span = Math.max(0.1, durationSec)
  const feedVideo = await videoFeedOf(output, track, plan, span, onProgress)
  const feedAudio = audio === null ? null : await audioFeedOf(output, audio, span, onProgress)
  await output.start()
  try {
    await feedVideo()
  } catch (error) {
    await output.cancel()
    // 给这个错误打个记号：只有"视频搬运"失败才值得退回重编码，音频出错重试也没用
    const tagged = error instanceof Error ? error : new Error(String(error))
    throw Object.assign(tagged, { videoFeedFailed: true })
  }
  try {
    await feedAudio?.()
    onProgress(0.98, toolsCopy.common.progress.muxMp4)
    await output.finalize()
  } catch (error) {
    await output.cancel()
    throw error
  }
  if (target.buffer === null) throw new Error(toolsCopy.common.errors.noOutput)
  return new Blob([target.buffer], { type: 'video/mp4' })
}

/** 先试直通搬运；搬运中途才炸（坏包、时间戳乱序）就整段退回重编码 */
async function muxVideo(
  track: InputVideoTrack,
  durationSec: number,
  audio: AudioPlan | null,
  onProgress: MediaProgress,
): Promise<Blob> {
  const plan = await planVideo(track)
  if (plan.kind === 'copy') {
    try {
      return await muxOnce(track, durationSec, audio, plan, onProgress)
    } catch (error) {
      if ((error as { videoFeedFailed?: boolean }).videoFeedFailed !== true) throw error
      console.warn('[tools/mux] 视频直通失败，改为重编码：', error)
      onProgress(0.02, toolsCopy.common.progress.reencodeVideo)
      const fallback: TrackPlan = { kind: 'encode', bitrate: await reencodeBitrateOf(track) }
      return await muxOnce(track, durationSec, audio, fallback, onProgress)
    }
  }
  return await muxOnce(track, durationSec, audio, plan, onProgress)
}

/** 外部音频文件 → 一条能直接编码的 AudioBuffer（44.1k 双声道、按视频时长裁补） */
async function externalBufferOf(audioFile: File, durationSec: number): Promise<AudioBuffer> {
  return await conform(await decodeAudioBytes(await audioFile.arrayBuffer()), durationSec)
}

/** 视频自带音轨 → 重编计划（混音 / 搬不了时的保底路径） */
async function originalAudioPlan(
  input: Input,
  audioTrack: InputAudioTrack | null,
  durationSec: number,
  preference: AudioBitratePreference,
): Promise<AudioPlan | null> {
  if (audioTrack === null) return null
  const original = await mediaAudioToBuffer(input, durationSec)
  if (original === null) return null
  return {
    kind: 'encode',
    buffer: original,
    bitrate: await resolveAudioBitrate(preference, await averageAudioBitrateOf(audioTrack)),
  }
}

/** 视频 + 可选外部音频 → MP4；外部音频可替换原声或与原声混音 */
export async function mergeVideoAudio(
  videoFile: File,
  audioFile: File | null,
  mode: AudioMergeMode,
  onProgress: MediaProgress = () => undefined,
  options: MergeOptions = {},
): Promise<Blob> {
  const input = await openInput(videoFile)
  let external: Input | null = null
  try {
    const track = await input.getPrimaryVideoTrack()
    if (track === null) throw new Error(toolsCopy.common.errors.videoTrack)
    const durationSec = await input.computeDuration()
    const audioTrack = await input.getPrimaryAudioTrack()
    const preference = options.audioBitrate ?? 'source'
    let externalTrack: InputAudioTrack | null = null
    if (audioFile !== null) {
      external = await openInput(audioFile)
      externalTrack = await external.getPrimaryAudioTrack()
      if (externalTrack === null) throw new Error(toolsCopy.common.errors.audioTrack)
    }
    // 用户明确选了码率时就按那个码率重编；默认的 'source' 才是"能搬就搬、搬不了跟随源文件"
    const explicit = preference === 'source' ? null : preference
    let audio: AudioPlan | null = null
    if (audioFile === null) {
      audio = explicit === null ? await planAudioCopy(audioTrack, Number.POSITIVE_INFINITY) : null
      if (audio === null) audio = await originalAudioPlan(input, audioTrack, durationSec, preference)
    } else if (mode === 'replace') {
      audio = explicit === null ? await planAudioCopy(externalTrack, durationSec) : null
      if (audio === null && externalTrack !== null) {
        audio = {
          kind: 'encode',
          buffer: await externalBufferOf(audioFile, durationSec),
          bitrate: await resolveAudioBitrate(preference, await averageAudioBitrateOf(externalTrack)),
        }
      }
    } else if (externalTrack !== null) {
      // 混音必须解成 PCM 才能叠，这条路径一定要重编
      const ext = await externalBufferOf(audioFile, durationSec)
      const original = await mediaAudioToBuffer(input, durationSec)
      audio = {
        kind: 'encode',
        bitrate: await resolveAudioBitrate(preference, await averageAudioBitrateOf(externalTrack)),
        buffer:
          original === null
            ? ext
            : mixBuffers(
                [
                  { buffer: await conform(original, durationSec), gain: 1 },
                  { buffer: ext, gain: 1 },
                ],
                durationSec * 1000,
              ),
      }
    }
    return await muxVideo(track, durationSec, audio, onProgress)
  } finally {
    external?.dispose()
    input.dispose()
  }
}

export interface ExtractProgress {
  (ratio: number, label: string): void
}

/** 仅保留视频轨（无声 MP4）；同样优先直通搬运，不重编码 */
export async function extractVideoOnly(file: File, onProgress: ExtractProgress = () => undefined): Promise<Blob> {
  const input = await openInput(file)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (track === null) throw new Error(toolsCopy.common.errors.videoTrack)
    const durationSec = await input.computeDuration()
    return await muxVideo(track, durationSec, null, onProgress)
  } finally {
    input.dispose()
  }
}

/** 只把一条 AudioBuffer 编成 MP4（m4a）：格式搬不动时的保底路径 */
async function encodeAudioOnly(buffer: AudioBuffer, durationSec: number, onProgress: ExtractProgress): Promise<Blob> {
  onProgress(0.5, toolsCopy.common.progress.encodeAudio)
  const bitrate = await resolveAudioBitrate('source', null)
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat(), target })
  const source = new AudioBufferSource({ codec: 'aac', bitrate })
  output.addAudioTrack(source)
  await output.start()
  await source.add(await conform(buffer, durationSec))
  onProgress(0.95, toolsCopy.common.progress.muxM4a)
  await output.finalize()
  if (target.buffer === null) throw new Error(toolsCopy.common.errors.noOutput)
  return new Blob([target.buffer], { type: 'audio/mp4' })
}

/**
 * 提取音频**原样搬**（m4a/aac；mp3 音轨也原样放进 MP4）。
 * 搬不了（opus / vorbis / pcm）才退到重编 AAC，不静默报错。
 */
export async function extractAudioCopy(file: File, onProgress: ExtractProgress = () => undefined): Promise<Blob> {
  const input = await openInput(file)
  try {
    const track = await input.getPrimaryAudioTrack()
    if (track === null) throw new Error(toolsCopy.split.noAudioTrack)
    const durationSec = await input.computeDuration()
    const codec = track.codec
    const config = codec === null ? null : await track.getDecoderConfig()
    if (codec === null || config === null || !COPYABLE_AUDIO_CODECS.includes(codec)) {
      const buffer = await mediaAudioToBuffer(input, durationSec)
      if (buffer === null) throw new Error(toolsCopy.split.noAudioTrack)
      return await encodeAudioOnly(buffer, durationSec, onProgress)
    }
    const target = new BufferTarget()
    const output = new Output({ format: new Mp4OutputFormat(), target })
    const source = new EncodedAudioPacketSource(codec)
    output.addAudioTrack(source, { decoderConfig: config })
    await output.start()
    const meta = { decoderConfig: config }
    let count = 0
    for await (const packet of new EncodedPacketSink(track).packets()) {
      await source.add(packet, meta)
      count += 1
      if (count % 400 === 0) {
        const at = Math.max(0, packet.timestamp + packet.duration)
        onProgress(Math.min(0.95, (at / Math.max(0.1, durationSec)) * 0.95), toolsCopy.common.progress.copyAudio)
      }
    }
    onProgress(0.97, toolsCopy.common.progress.muxM4a)
    await output.finalize()
    if (target.buffer === null) throw new Error(toolsCopy.common.errors.noOutput)
    return new Blob([target.buffer], { type: 'audio/mp4' })
  } finally {
    input.dispose()
  }
}

/** 提取音频并解成 AudioBuffer（WAV 导出、片段页读视频音轨都用它） */
export async function audioBufferOf(file: File, onProgress: ExtractProgress = () => undefined): Promise<AudioBuffer> {
  // 先走 WebAudio：纯音频文件（mp3/wav/m4a/flac/ogg）这一步最快，也不用解容器
  try {
    onProgress(0.3, toolsCopy.common.progress.readAudio)
    return await decodeAudioBytes(await file.arrayBuffer())
  } catch {
    /* 视频文件 / WebAudio 不认识的容器 ⇒ 退到 mediabunny 解音轨 */
  }
  const input = await openInput(file)
  try {
    const durationSec = await input.computeDuration()
    onProgress(0.5, toolsCopy.common.progress.decodeAudio)
    const buffer = await mediaAudioToBuffer(input, durationSec)
    if (buffer === null) throw new Error(toolsCopy.split.noAudioTrack)
    return buffer
  } finally {
    input.dispose()
  }
}
