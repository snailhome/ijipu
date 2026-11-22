/**
 * tools/clipAudio.ts — 片段截取与编码（adj1316）
 *
 * 「截取」就是按采样点取子区间，不再过一次 OfflineAudioContext：
 * 起止都在同一个 AudioBuffer 上算，不重采样、不改音质，也快得多。
 */
import { mp3Bytes, wavBytes } from './audioOut'

export type ClipFormat = 'wav' | 'mp3'

/** 取 `[from, to)` 这一段（秒），越界自动夹住；至少返回 1 个采样 */
export function sliceBuffer(buffer: AudioBuffer, from: number, to: number): AudioBuffer {
  const rate = buffer.sampleRate
  const i0 = Math.max(0, Math.floor(Math.min(from, to) * rate))
  const i1 = Math.min(buffer.length, Math.ceil(Math.max(from, to) * rate))
  const len = Math.max(1, i1 - i0)
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: len, sampleRate: rate })
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    out.getChannelData(c).set(buffer.getChannelData(c).subarray(i0, i0 + len))
  }
  return out
}

/** 截一段并编码成文件字节 */
export async function encodeClip(
  buffer: AudioBuffer,
  from: number,
  to: number,
  format: ClipFormat,
): Promise<Uint8Array> {
  const slice = sliceBuffer(buffer, from, to)
  return format === 'wav' ? wavBytes(slice) : await mp3Bytes(slice)
}

/** 导出格式对应的 MIME 与扩展名 */
export function fileTypeOf(format: ClipFormat): { ext: string; mime: string } {
  return format === 'wav' ? { ext: 'wav', mime: 'audio/wav' } : { ext: 'mp3', mime: 'audio/mpeg' }
}
