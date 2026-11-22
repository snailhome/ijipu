/**
 * tools/clipPlayer.ts — 音频播放器（从某一秒起放、可指定到哪里停、报告当前秒）
 *
 * **从爱出片搬过来**：源文件 `ijipu-cp/src/render/video/audioPlayer.ts` 的 `DynamicAudioPlayer`。
 * 类结构、50 毫秒启动余量、`stopSource()` 里吞掉"已自然结束的源再 stop 会抛"的细节、都要
 * `unlock()` 在用户点击那一帧先把 `AudioContext` 唤醒（否则等解码几秒后再建，浏览器认为不是
 * 用户手势 ⇒ 上下文 suspended、没声）—— 全是爱出片踩出来的，原样保留。
 *
 * 这里只加两件事（工具页需要、爱出片那里用不上的）：
 *  1. `play(from, to)` 的 **`to`**：播到 `to` 秒自动停（对拍台靠 rAF 判段尾，这里交给
 *     `AudioBufferSourceNode.start()` 的 duration 参数，更准且不用每帧比较）；
 *  2. 时间单位用**秒**（爱出片用毫秒），因为工具页到处都是 `AudioBuffer.duration` 的秒。
 */

interface Handle {
  /** 计划开始播放的 AudioContext 时间（秒） */
  startAt: number
  /** 开始播放时对应的音频秒 */
  from: number
  /** 播到哪一秒停；null = 放到文件结尾 */
  to: number | null
}

export interface ClipPlayer {
  /** 从 `from` 秒开始放，到 `to` 秒（不含）停；`to = null` 表示放到结尾 */
  play(from: number, to: number | null): void
  stop(): void
  /** 当前播放头（秒）；没在放时返回 `fallback` 传入的那个值 */
  position(): number
  playing(): boolean
  /** 连 buffer 一起扔掉（换文件/卸载组件时调） */
  dispose(): void
}

export function createPlayer(buffer: AudioBuffer): ClipPlayer {
  let ctx: AudioContext | null = null
  let source: AudioBufferSourceNode | null = null
  let handle: Handle | null = null

  const stopSource = (): void => {
    const src = source
    source = null
    handle = null
    if (src === null) return
    try {
      src.stop()
    } catch {
      // 已经自然结束的源再 stop 会抛 InvalidStateError；忽略
    }
    src.disconnect()
  }

  const now = (): number => (ctx === null ? 0 : ctx.currentTime)

  return {
    play(from: number, to: number | null): void {
      const started = Math.max(0, Math.min(from, Math.max(0, buffer.duration - 0.01)))
      const end = to === null ? null : Math.min(Math.max(started + 0.001, to), buffer.duration)
      if (end !== null && end - started < 0.001) return
      ctx ??= new AudioContext()
      void ctx.resume()
      stopSource()
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      /**
       * 留 50 毫秒启动余量（爱出片的原注释）：`startAt` 之前 `position()` 停在起点，
       * 否则 `currentTime` 已经越过 0，第一帧会往前跳一点点。
       */
      const startAt = ctx.currentTime + 0.05
      const duration = end === null ? undefined : end - started
      if (duration === undefined) src.start(startAt, started)
      else src.start(startAt, started, duration)
      src.onended = () => {
        if (source === src) {
          source = null
          handle = null
        }
      }
      source = src
      handle = { startAt, from: started, to: end }
    },
    stop(): void {
      stopSource()
    },
    position(): number {
      if (handle === null) return 0
      const played = Math.max(0, now() - handle.startAt)
      const at = handle.from + played
      const cap = handle.to === null ? buffer.duration : handle.to
      return Math.min(at, cap)
    },
    playing(): boolean {
      if (handle === null || ctx === null) return false
      const cap = handle.to === null ? buffer.duration : handle.to
      return now() < handle.startAt + (cap - handle.from)
    },
    dispose(): void {
      stopSource()
      if (ctx !== null) {
        void ctx.close().catch(() => undefined)
        ctx = null
      }
    },
  }
}
