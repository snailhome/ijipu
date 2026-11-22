/**
 * tools/audioOut.ts — AudioBuffer → WAV / MP3 字节（adj1316）
 *
 * 为什么不复用 `src/export/audio.ts` 里的同名函数：那份文件**静态** `import ... from '@ijipu/engine'`
 * （`eventsToMidi` / `pcmToWav`），一旦被这个独立页面引进来，整个简谱引擎（几百 KB）就跟着进了工具页首包 ——
 * 而这页只需要"把 PCM 写成文件"。所以这里留一份最小的：WAV 头 20 行，MP3 走 lamejs（动态 import，
 * 只有真导出 MP3 时才下载那 100 多 KB）。
 */

const ENC = new TextEncoder()

/** AudioBuffer → WAV（PCM16，双声道以内）字节 */
export function wavBytes(buffer: AudioBuffer): Uint8Array {
  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels))
  const frames = buffer.length
  const bytes = 44 + frames * channels * 2
  const out = new Uint8Array(bytes)
  const view = new DataView(out.buffer)
  const write = (offset: number, text: string): void => {
    out.set(ENC.encode(text), offset)
  }
  write(0, 'RIFF')
  view.setUint32(4, bytes - 8, true)
  write(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, frames * channels * 2, true)
  const data = Array.from({ length: channels }, (_, c) =>
    buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)),
  )
  let at = 44
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const s = Math.max(-1, Math.min(1, data[c][i]))
      view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      at += 2
    }
  }
  return out
}

/** Float32（-1~1）→ Int16 */
function toInt16(data: Float32Array): Int16Array {
  const out = new Int16Array(data.length)
  for (let i = 0; i < data.length; i += 1) {
    const s = Math.max(-1, Math.min(1, data[i]))
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
  }
  return out
}

/**
 * AudioBuffer → MP3 字节（lamejs，按帧编码控制内存峰值）。
 * `kbps` 用 128：语音/伴奏都够，3 分钟的片段约 2.8 MB。
 */
export async function mp3Bytes(buffer: AudioBuffer, kbps = 128): Promise<Uint8Array> {
  const { Mp3Encoder } = await import('@breezystack/lamejs')
  const channels = Math.min(2, buffer.numberOfChannels)
  const enc = new Mp3Encoder(channels, buffer.sampleRate, kbps)
  const left = toInt16(buffer.getChannelData(0))
  const right = channels > 1 ? toInt16(buffer.getChannelData(1)) : undefined
  const parts: Uint8Array[] = []
  const block = 1152
  for (let i = 0; i < left.length; i += block) {
    parts.push(enc.encodeBuffer(left.subarray(i, i + block), right?.subarray(i, i + block)))
  }
  parts.push(enc.flush())
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
