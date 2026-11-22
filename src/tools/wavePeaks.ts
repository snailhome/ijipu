/**
 * tools/wavePeaks.ts — 波形包络抽样（每个桶取所有声道的最小/最大值）
 *
 * **从爱出片原样搬过来**：源文件 `ijipu-cp/src/render/video/accompaniment.ts` 的
 * `waveformPeaks()`（第 126-157 行），函数体逐字复制，只把参数名保持不变。
 * 爱出片那边它同时服务对拍台的波形与出片音轨，这里只用来画波形。
 *
 * 用户 2026-11-18：「播放、试听、定位、标记的那一套」——指的正是爱出片对拍台这一套；
 * 波形抽样是它的地基，所以直接搬，不再自己写第二份。
 */

/** 一个桶的上下界（波形竖线的两个端点，取值 -1..1） */
export interface PeakBucket {
  min: number
  max: number
}

/**
 * 波形包络：把整条音频压成 `buckets` 个桶，每桶取 min/max（画竖线用）。
 *
 * **纯函数**（只吃 `Float32Array`）⇒ Node 里可断言。
 * 多声道取**全部声道**的 min/max（不是"绝对值更大"——那样会丢掉负向峰值，
 * 左右声道反相时包络会凭空变平）。
 */
export function waveformPeaks(channels: Float32Array[], buckets: number): PeakBucket[] {
  const out: PeakBucket[] = []
  const n = channels[0]?.length ?? 0
  const count = Math.max(1, Math.floor(buckets))
  if (n === 0) return Array.from({ length: count }, () => ({ min: 0, max: 0 }))
  const step = n / count
  for (let b = 0; b < count; b++) {
    const i0 = Math.floor(b * step)
    const i1 = Math.min(n, Math.max(i0 + 1, Math.floor((b + 1) * step)))
    let min = 0
    let max = 0
    for (let i = i0; i < i1; i++) {
      for (let c = 0; c < channels.length; c++) {
        const x = channels[c][i]
        if (x < min) min = x
        if (x > max) max = x
      }
    }
    out.push({ min, max })
  }
  return out
}

/** 桶数：2048 个桶在 1400px 宽下已经够细，滚轮放大到 10 秒时再按需要加密（见 waveform.ts） */
export const PEAK_BUCKETS = 4096

/**
 * `AudioBuffer` → 桶数组（取前两个声道，与爱出片一致：对拍台也只吃 0/1 声道）。
 */
export function peaksOf(buffer: AudioBuffer, buckets = PEAK_BUCKETS): PeakBucket[] {
  const channels: Float32Array[] = [buffer.getChannelData(0)]
  if (buffer.numberOfChannels > 1) channels.push(buffer.getChannelData(1))
  return waveformPeaks(channels, buckets)
}
