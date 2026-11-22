/**
 * tools/capability.ts — 这个浏览器能不能干活（adj1316）
 *
 * 口径（工作区 AGENTS 五·3：「整块功能的能力闸门放模块自己的 capability.ts」）：
 *  · `mux`  —— 能不能读写视频容器。合并 / 拆分全靠它（mediabunny 的拆封装 + 写封装），
 *              底层要 WebCodecs 的 `VideoDecoder`；没有就整块不可用，页面给一行说明；
 *  · `reencode` —— 能不能重编码。只有「与原声混音」和「换成 WAV 再塞进视频」需要它；
 *              不支持时这两条路禁用，但"原样搬运"照旧能用（这是绝大多数情况）；
 *  · `webaudio` —— 能不能解码音频、画波形、导出片段。缺了片段页就没法用。
 *
 * 只探测一次（模块级缓存）：探测要建 AudioContext，反复建会被浏览器限流。
 */
export interface ToolsCapability {
  mux: boolean
  reencode: boolean
  webaudio: boolean
}

type MaybeCodec = { VideoDecoder?: unknown; AudioEncoder?: unknown; VideoEncoder?: unknown }

function hasWebAudio(): boolean {
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown }
  return typeof w.AudioContext !== 'undefined' || typeof w.webkitAudioContext !== 'undefined'
}

/** 探测一次并缓存（页面生命周期内不会变） */
let cached: ToolsCapability | null = null

export function probeCapability(): ToolsCapability {
  if (cached !== null) return cached
  const codec = globalThis as unknown as MaybeCodec
  cached = {
    mux: typeof codec.VideoDecoder !== 'undefined',
    reencode: typeof codec.VideoEncoder !== 'undefined' && typeof codec.AudioEncoder !== 'undefined',
    webaudio: hasWebAudio(),
  }
  return cached
}
