/**
 * export/video/mp4.ts — 动态谱 → MP4（WebCodecs 编码 + Mediabunny 封装）
 *
 * ## 为什么不用 ffmpeg
 *
 * 浏览器自带 H.264 / AAC 编码（Windows 上走系统硬件编码器）。实测（本机 Chrome）：
 * `VideoEncoder` 支持 `avc1.640028`（H.264 High）、`AudioEncoder` 支持 `mp4a.40.2`（AAC）。
 * 于是不必让用户下 80MB 的 ffmpeg，也不用起子进程。
 *
 * ## 为什么用 Mediabunny
 *
 * 它把"编码 + 封装"合成了两个现成的源：
 *  - `CanvasSource`：给画布 + 时间戳，内部自己调 VideoEncoder；
 *  - `AudioBufferSource`：直接吃 `AudioBuffer`，内部自己调 AudioEncoder。
 * 换成手接 WebCodecs + 第三方 muxer 也能做，但代码量翻倍、还要自己搬 decoder config。
 * （先前用的 `mp4-muxer` 已被作者标记 superseded，推荐的就是 Mediabunny。）
 *
 * ## 为什么仍然是"确定性"的
 *
 * 每一帧都是 `session.draw(ctx, n/fps)` 现画出来的，时间戳由帧号算出，不是录屏、
 * 不依赖机器快慢 ⇒ 同一份谱两次导出逐帧一致。
 */
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, Quality } from 'mediabunny'
import type { AttachedImage } from 'mediabunny'

/**
 * 能被 `encodeMp4` 编成片的最小会话结构（adj1264）。
 *
 * 为什么放宽：连续动态谱的会话（`createLinearSession`）与相机位会话（`DynamicSession`）
 * 是**两条不同的画法**，但"逐帧 draw + 编 H.264"这段完全一样。原来签名写死
 * `DynamicSession`（相机/页位图/事件…），单行谱只能复制一份编码循环 ⇒ 两套编码时间戳一旦
 * 不一致，成片就会一半对一半错。现在只要求编码真正用到的四个字段。
 */
export interface EncodableSession {
  width: number
  height: number
  totalMs: number
  draw: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, tMs: number) => unknown
  /**
   * 预热某一时刻（可选）。视频背景要**先解码再画**——出片循环每帧前 `await` 它，
   * 否则解不出来就是上一帧/黑屏（`adj1264` 的负向判据之一）。
   */
  warm?: (tMs: number) => Promise<void>
}

export interface Mp4Options {
  /** 帧率（缺省 30） */
  fps?: number
  /** 视频码率（缺省 8 Mbps） */
  bitrate?: number
  /** 音轨（离线渲染好的整曲；缺省 = 无声视频） */
  audio?: AudioBuffer | null
  /** 音频码率（缺省 128 kbps） */
  audioBitrate?: number
  /** 只编前 N 毫秒（导出范围 / 试编一段用） */
  maxMs?: number
  /**
   * 封面帧的时刻（ms）。缺省 = 片头卡**完全显现**的那一刻（`LEAD_IN_MS − INTRO_PAN_MS` = 3000）。
   * 传 `null` = 不写封面（测试 / 极短片段用）。
   *
   * 为什么要封面：mp4 自身不带"封面"时，系统与播放器抽哪一帧全凭各自实现
   * （Windows 资源管理器常用第 0 帧 ⇒ 只显示动画开头的背景），于是缩略图看不出是什么曲子。
   */
  coverMs?: number | null
  /** 进度回调（0~1） */
  onProgress?: (p: number) => void
  /** 取消 */
  signal?: AbortSignal
}

/** 关键帧间隔（秒）——seek/播放器拖动更稳 */
const KEYFRAME_SEC = 2

/** 封面缺省时刻：片头卡完整显现的最后一刻（= `LEAD_IN_MS 3700 − INTRO_PAN_MS 700`） */
export const DEFAULT_COVER_MS = 3000

/** 封面图的 MIME（JPEG：体积小，各类缩略图实现都认） */
export const COVER_MIME = 'image/jpeg'

/**
 * 把一帧 JPEG 包成 Mediabunny 的封面图 —— MP4 会写成 `moov/udta/meta/ilst/covr`（`kind: coverFront`）。
 *
 * 为什么抽成纯函数：冒烟跑在 Node 里、没有 WebCodecs，编不出真视频；
 * 但"封面标签的形状对不对（coverFront / image/jpeg / 字节原样）"可以单独断言。
 */
export function coverImageOf(jpeg: Uint8Array): AttachedImage {
  return {
    data: jpeg,
    mimeType: COVER_MIME,
    kind: 'coverFront',
    name: 'cover.jpg',
    description: '视频封面（片头卡完整帧）',
  }
}

/**
 * 把音轨截到与画面等长。
 *
 * 为什么必须截：画面有 3 分钟上限（`maxMs`），音轨却是整曲 ⇒ 导出文件会出现
 * "视频 3:00、声音 3:42"（用户实测）。音轨比画面长时，播放器会继续放声音或直接把时长算成音频长度。
 */
export function trimAudio(buffer: AudioBuffer, ms: number): AudioBuffer {
  const want = Math.min(buffer.length, Math.ceil((ms / 1000) * buffer.sampleRate))
  if (want >= buffer.length) return buffer
  const out = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: want,
    sampleRate: buffer.sampleRate,
  })
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(buffer.getChannelData(c).subarray(0, want), c)
  }
  return out
}

/**
 * 把一次放映会话编成 MP4。
 *
 * @param session `createDynamicSession()` / `createLinearSession()` 的结果
 *                （只要求 `width/height/totalMs/draw`，可带 `warm`）
 * @returns MP4 字节（Blob，可直接触发下载）
 */
export async function encodeMp4(session: EncodableSession, opts: Mp4Options = {}): Promise<Blob> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('当前环境不支持 WebCodecs（请更新 WebView2 / 换 Chrome）')
  }
  const fps = opts.fps ?? 30
  const { width, height, totalMs } = session
  const spanMs = Math.min(totalMs, opts.maxMs ?? totalMs)
  const frameCount = Math.max(1, Math.round((spanMs / 1000) * fps))

  // 离屏画布：不占可见画布，也不需要往 DOM 里挂节点
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建离屏画布')

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const video = new CanvasSource(canvas, {
    codec: 'avc',
    quality: new Quality({ bitrate: opts.bitrate ?? 8_000_000 }),
  })
  output.addVideoTrack(video, { frameRate: fps })

  // 音轨：有 AudioBuffer 才加，否则就是无声视频（v1 的默认路径）
  const audio =
    opts.audio && opts.audio.numberOfChannels > 0
      ? new AudioBufferSource({ codec: 'aac', quality: new Quality({ bitrate: opts.audioBitrate ?? 128_000 }) })
      : null
  if (audio) output.addAudioTrack(audio)

  /**
   * 封面：抓片头卡**完整显现**的那一帧（`adj1111`）。
   *
   * 为什么不拿第 0 帧：片头是"先出背景、再淡入标题"，第 0 帧基本只有底色 ——
   * 系统缩略图（Windows 资源管理器常取首帧）就成了一张空背景。
   * 取 3 秒这一帧，缩略图直接就是"标题 + 曲目信息"的完整卡片。
   */
  const coverMs = opts.coverMs === undefined ? DEFAULT_COVER_MS : opts.coverMs
  if (coverMs !== null && coverMs < spanMs) {
    await session.warm?.(coverMs)
    session.draw(ctx, coverMs)
    const jpeg = await canvas.convertToBlob({ type: COVER_MIME, quality: 0.9 })
    output.setMetadataTags({ images: [coverImageOf(new Uint8Array(await jpeg.arrayBuffer()))] })
  }

  await output.start()
  try {
    const keyEvery = Math.max(1, Math.round(fps * KEYFRAME_SEC))
    for (let i = 0; i < frameCount; i++) {
      if (opts.signal?.aborted) throw new DOMException('已取消', 'AbortError')
      const tMs = (i * 1000) / fps
      // adj1264：视频背景要先解码再画（`warm` 不存在的会话直接跳过）
      if (session.warm !== undefined) await session.warm(tMs)
      session.draw(ctx, tMs)
      // `add` 返回的 Promise 就是背压：等它 resolve 再画下一帧，内存不会被撑爆
      await video.add(i / fps, 1 / fps, { keyFrame: i % keyEvery === 0 })
      opts.onProgress?.(((i + 1) / frameCount) * (audio ? 0.85 : 1))
    }
    video.close()
    if (audio && opts.audio) {
      // 与画面等长（超出 3 分钟上限时两侧同时截断，避免"画面 3:00、声音 3:42"）
      await audio.add(trimAudio(opts.audio, spanMs))
      audio.close()
      opts.onProgress?.(1)
    }
    await output.finalize()
  } catch (e) {
    await output.cancel()
    throw e
  }

  const buffer = output.target.buffer
  if (!buffer) throw new Error('封装失败：没有产出数据')
  return new Blob([buffer], { type: 'video/mp4' })
}
