/**
 * export/video/videoSource.ts — 背景视频解码（Mediabunny，adj1264）
 *
 * ## 为什么要单独一层
 *
 * 用户 2026-11-09 说的「视频解码是最大未知」指的是两件事：
 *  ① **能不能解**（编码/容器认不认、有没有音轨）；
 *  ② **解不出来时会不会黑屏**——负向判据：**解码失败必须明确提示，不许静默黑屏**。
 *
 * 所以这里把"打开/取帧/取音轨"包成一个小对象，失败一律返回**人话错误**（`error` 字段），
 * 由台面显示出来；画面取不到帧时 `drawFrame()` 返回 `false`，台面据此画兜底背景 + 提示，
 * 而不是留一块黑。
 *
 * ## 为什么帧要缓存、且按"时间桶"取
 *
 * `draw(ctx, t)` 必须是**纯函数**（同一个 t 画两次逐像素一致）。视频帧是异步解码的，
 * 所以这里按 `t / 帧桶` 缓存已解出来的帧：同一个 t 命中同一个桶 ⇒ 同一帧 ⇒ 同样的像素。
 *
 * 桶宽取 1/30 秒（出片帧率），与 `stripFrame` 的"时刻→x"互不影响（谱面仍按真实 t 算）。
 */

import { ALL_FORMATS, AudioBufferSink, BlobSource, Input, VideoSampleSink, type VideoSample } from 'mediabunny'

/** 一帧的桶宽（ms）：出片 30fps，桶与帧一一对应 */
export const VIDEO_FRAME_MS = 1000 / 30

/** 同时缓存多少帧（≈ 3 秒；预览够用，出片是顺序读、命中率更高） */
const MAX_CACHED_FRAMES = 90

/** 打开失败时给用户看的话（都要说清"下一步怎么办"） */
export const VIDEO_ERRORS = {
  unreadable: '打不开这个视频：不是视频文件，或格式不认（试试 mp4 / mov）',
  noVideoTrack: '这个文件里没有画面轨（只有声音？）——可以当伴奏用，但不能当背景视频',
  noDecoder: '这个视频的编码本机解不了（常见的是 HEVC/H.265）；换成 H.264 的 mp4 再试',
  unknown: '视频解码失败（原因不明）；谱面/对拍不受影响，可以换一个视频或只用伴奏',
} as const

export interface LinearVideoInfo {
  name: string
  /** 显示宽高（已按旋转/像素比换算；出片按它定画布） */
  width: number
  height: number
  durationMs: number
  /** 有没有音轨（有 ⇒ 可以"用视频原声"） */
  hasAudio: boolean
}

export type VideoOpenResult =
  | { ok: true; source: LinearVideoSource }
  | { ok: false; error: string }

/**
 * 一个已打开的视频：取帧（同步命中缓存）+ 取音轨（异步，一次解成 AudioBuffer）。
 *
 * 生命周期：`open()` → 台面里用 → `close()`（`input.dispose()`）。
 */
export class LinearVideoSource {
  readonly info: LinearVideoInfo
  private readonly input: Input
  private readonly sink: VideoSampleSink | null
  private readonly audioSink: AudioBufferSink | null
  /** 帧桶下标 → 帧 */
  private readonly frames = new Map<number, VideoSample>()
  /** LRU 顺序（先入先出；帧数量小，用数组足够） */
  private readonly order: number[] = []
  /** 正在解的桶（避免同一桶并发解两次） */
  private readonly loading = new Set<number>()
  /** 最近解出来的一帧（新帧还没到时先用它顶着，避免闪烁成黑屏） */
  private last: { index: number; sample: VideoSample } | null = null

  private constructor(
    info: LinearVideoInfo,
    input: Input,
    sink: VideoSampleSink | null,
    audioSink: AudioBufferSink | null,
  ) {
    this.info = info
    this.input = input
    this.sink = sink
    this.audioSink = audioSink
  }

  /**
   * 打开一个视频文件（`File`/`Blob` 都行；Tauri 的 `<input type=file>` 也给 `File`）。
   *
   * 失败时**不抛**，返回 `{ ok:false, error }`——调用方直接把 `error` 显示在台面上。
   */
  static async open(file: Blob, name: string): Promise<VideoOpenResult> {
    let input: Input | null = null
    try {
      input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
      const canRead = await input.canRead()
      if (!canRead) {
        input.dispose()
        return { ok: false, error: VIDEO_ERRORS.unreadable }
      }
      const track = await input.getPrimaryVideoTrack()
      if (track === null) {
        input.dispose()
        return { ok: false, error: VIDEO_ERRORS.noVideoTrack }
      }
      // 编码能不能解：解不了要**提前**说（否则就是一帧帧的"黑屏 + 什么都没发生"）
      if (!(await track.canDecode())) {
        input.dispose()
        return { ok: false, error: VIDEO_ERRORS.noDecoder }
      }
      const width = await track.getDisplayWidth()
      const height = await track.getDisplayHeight()
      const durationSec = await input.computeDuration()
      const audioTrack = await input.getPrimaryAudioTrack()
      const info: LinearVideoInfo = {
        name,
        width: Math.max(2, Math.round(width)),
        height: Math.max(2, Math.round(height)),
        durationMs: Math.max(0, Math.round(durationSec * 1000)),
        hasAudio: audioTrack !== null,
      }
      return {
        ok: true,
        source: new LinearVideoSource(
          info,
          input,
          new VideoSampleSink(track),
          audioTrack !== null ? new AudioBufferSink(audioTrack) : null,
        ),
      }
    } catch {
      try {
        input?.dispose()
      } catch {
        /* 已经废了 */
      }
      return { ok: false, error: VIDEO_ERRORS.unknown }
    }
  }

  /** 某一时刻对应的帧桶下标（0 起，夹到合法范围） */
  bucketOf(tMs: number): number {
    const n = Math.max(0, Math.round(tMs / VIDEO_FRAME_MS))
    return Math.min(n, Math.max(0, Math.round(this.info.durationMs / VIDEO_FRAME_MS)))
  }

  /** 桶下标对应的时间（秒；给 `getSample` 用） */
  private secOf(index: number): number {
    return (index * VIDEO_FRAME_MS) / 1000
  }

  /**
   * 预热某一时刻（异步）。预览在 rAF 里"先 warm 再 draw"，
   * 出片每帧前 `await` 它 ⇒ 成片不会因为解码慢而丢帧。
   */
  async warm(tMs: number): Promise<void> {
    if (this.sink === null) return
    const index = this.bucketOf(tMs)
    if (this.frames.has(index) || this.loading.has(index)) return
    this.loading.add(index)
    try {
      const sample = await this.sink.getSample(this.secOf(index))
      if (sample !== null) this.store(index, sample)
    } catch {
      /* 单帧失败不算致命：下一帧会再试（台面另有"取不到帧"的提示） */
    } finally {
      this.loading.delete(index)
    }
  }

  private store(index: number, sample: VideoSample): void {
    const old = this.frames.get(index)
    if (old !== undefined && old !== sample) old.close()
    this.frames.set(index, sample)
    if (!this.order.includes(index)) this.order.push(index)
    this.last = { index, sample }
    while (this.order.length > MAX_CACHED_FRAMES) {
      const drop = this.order.shift()
      if (drop === undefined) break
      const s = this.frames.get(drop)
      this.frames.delete(drop)
      if (s !== undefined && s !== this.last?.sample) s.close()
    }
  }

  /** 帧缓存里离 `tMs` 最近的一帧（没有就 null） */
  private nearest(tMs: number): VideoSample | null {
    const want = this.bucketOf(tMs)
    for (const d of [0, 1, -1, 2, -2, 3, -3]) {
      const s = this.frames.get(want + d)
      if (s !== undefined) return s
    }
    return this.last?.sample ?? null
  }

  /**
   * 把 `tMs` 那一帧按 **cover** 铺到画布上。
   *
   * @returns 画上了 = true；还没有帧 = false（调用方要画兜底背景并提示）
   */
  drawFrame(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    tMs: number,
    width: number,
    height: number,
  ): boolean {
    const sample = this.nearest(tMs)
    if (sample === null) return false
    /**
     * adj1265（手机竖屏素材回归）：**必须用 `displayWidth/displayHeight`**（已含旋转）。
     *
     * 手机拍的竖屏视频常见"1920×1080 + 旋转 90°"：`squarePixelWidth/Height` 是**旋转前**的，
     * 拿它算 cover 会得到 3413×1920 的绘制尺寸（画面被放大 3 倍、横向裁掉一大块），
     * 而 `sample.draw` 自己会按旋转画——尺寸与内容就对不上。`display*` 才是"眼睛看到的多宽多高"。
     */
    const sw = sample.displayWidth || this.info.width
    const sh = sample.displayHeight || this.info.height
    const scale = Math.max(width / Math.max(1, sw), height / Math.max(1, sh))
    const dw = sw * scale
    const dh = sh * scale
    try {
      sample.draw(ctx, (width - dw) / 2, (height - dh) / 2, dw, dh)
      return true
    } catch {
      return false
    }
  }

  /**
   * 把视频自带音轨解成一条 `AudioBuffer`（时长 = 视频时长，缺的部分补静音）。
   *
   * 为什么要整条解出来：台面的波形、试听、出片音轨都要它；而 Mediabunny 是按块给的，
   * 拼一次比每处各拼一次省事，也保证"听到的"和"出片的"是同一条。
   */
  async decodeAudio(): Promise<AudioBuffer | null> {
    if (this.audioSink === null) return null
    const chunks: { buffer: AudioBuffer; timestamp: number }[] = []
    try {
      for await (const w of this.audioSink.buffers()) chunks.push({ buffer: w.buffer, timestamp: w.timestamp })
    } catch {
      return null
    }
    if (chunks.length === 0) return null
    const rate = chunks[0].buffer.sampleRate
    const channels = Math.max(1, Math.min(2, chunks[0].buffer.numberOfChannels))
    const len = Math.max(1, Math.ceil((this.info.durationMs / 1000) * rate))
    const out = new AudioBuffer({ numberOfChannels: channels, length: len, sampleRate: rate })
    for (const c of chunks) {
      const start = Math.max(0, Math.round(c.timestamp * rate))
      const n = Math.min(c.buffer.length, len - start)
      if (n <= 0) continue
      for (let ch = 0; ch < channels; ch++) {
        const src = c.buffer.getChannelData(Math.min(ch, c.buffer.numberOfChannels - 1)).subarray(0, n)
        out.getChannelData(ch).set(src, start)
      }
    }
    return out
  }

  /** 释放解码器与缓存的帧 */
  close(): void {
    for (const [, s] of this.frames) {
      try {
        s.close()
      } catch {
        /* 已经关了 */
      }
    }
    this.frames.clear()
    this.order.length = 0
    this.last = null
    try {
      this.input.dispose()
    } catch {
      /* 已经废了 */
    }
  }
}
