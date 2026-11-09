/**
 * export/video/stripRaster.ts — 单行谱分块光栅 + 描边/阴影（adj1259）
 *
 * ## 为什么是"块"而不是一张大图
 *
 * 条带可能有 2 万 px 宽（见 `stripSvg.ts` 头注释）。这里按视口把条带切成若干块：
 * 只光栅**可视 ±1 块**，超出就丢（LRU）。内存与"一屏"成正比，与曲子长度无关。
 *
 * ## 描边怎么来
 *
 * SVG 里的墨色是实心字。做"白字黑边"最稳的办法不是给每个 `<text>` 加 stroke
 * （会压细笔画、不同字体差异大），而是：
 *  ① 正常渲染一张**墨色版**；
 *  ② 再复制一张、用 `source-in` 整片染成描边色 → 得到**剪影**；
 *  ③ 合成时把剪影按 8 个方向偏移画一圈，再把墨色版压上去。
 * 影子同理：剪影模糊后垫在下面。
 *
 * 这样"文本色 / 边框色 / 阴影色"三个颜色各自独立，且换色不需要重新排版。
 */
import { applyRangeToSvg } from '@ijipu/engine'

export interface StripStyleLike {
  ink: string
  halo: string
  haloWidth: number
  shadow: string
  shadowBlur: number
}

export interface RasterOptions {
  /** 块宽（**条带排版坐标** px） */
  chunkW?: number
  /** 光栅倍数（缺省按 devicePixelRatio 与 2 取小，至少 1） */
  scale?: number
  style?: StripStyleLike
  /** 同时缓存几块（缺省 6） */
  maxChunks?: number
  /**
   * adj1277：**条带在画布上的放大倍数**（`bandScale`）。
   *
   * 条带按**谱面原尺寸**排版（13px 也好、20px 也好，就是预览那一套），
   * 画到视频里要放大几倍 —— 放大在**光栅化**这一步做（SVG 是矢量，放大后仍然清晰），
   * 不是把位图拉大。所有几何量都在"排版坐标"里，只有这里乘 zoom。
   */
  zoom?: number
}

const DEFAULT_STYLE: StripStyleLike = {
  ink: '#ffffff',
  halo: 'rgba(0,0,0,0.85)',
  haloWidth: 3,
  shadow: 'rgba(0,0,0,0.55)',
  shadowBlur: 0,
}

/** 一块的位图（墨色版 + 剪影版） */
interface ChunkBitmap {
  x: number
  w: number
  ink: HTMLCanvasElement
  halo: HTMLCanvasElement | null
}

/**
 * 条带位图缓存。
 *
 * 用法：`await cache.ensure(scrollX)` 保证可视范围已就绪，然后 `cache.blit(ctx, scrollX, y)`。
 * 首帧之前要 `await document.fonts.ready`（否则第一帧字形会回退，与后面不一致）。
 */
export class StripRasterCache {
  private readonly bitmaps = new Map<number, ChunkBitmap>()
  private readonly order: number[] = []
  private readonly chunkW: number
  private readonly scale: number
  private readonly style: StripStyleLike
  private readonly maxChunks: number
  private readonly svg: string
  private readonly h: number
  private readonly totalW: number
  /** adj1277：条带在画布上的放大倍数（排版坐标 → 画布坐标） */
  private readonly zoom: number
  private loading = new Set<number>()

  constructor(svg: string, width: number, height: number, opts: RasterOptions = {}) {
    this.svg = svg
    this.totalW = Math.max(1, width)
    this.h = Math.max(1, height)
    this.zoom = Math.max(0.1, opts.zoom ?? 1)
    this.chunkW = Math.max(64, Math.round(opts.chunkW ?? 960))
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    this.scale = Math.max(1, Math.min(opts.scale ?? Math.min(2, dpr), 3))
    this.style = opts.style ?? DEFAULT_STYLE
    this.maxChunks = Math.max(2, opts.maxChunks ?? 6)
  }

  /** 块下标（0 起） */
  private indexOf(x: number): number {
    return Math.floor(x / this.chunkW)
  }

  /** 块在条带上的起点 x */
  private startOf(index: number): number {
    return index * this.chunkW
  }

  /** 可视范围 [x, x + viewW] 覆盖的块下标 */
  private visibleIndexes(x: number, viewW: number): number[] {
    const last = Math.max(0, Math.ceil(this.totalW / this.chunkW) - 1)
    const a = Math.max(0, this.indexOf(x) - 1)
    const b = Math.min(last, this.indexOf(x + viewW) + 1)
    const out: number[] = []
    for (let i = a; i <= b; i++) out.push(i)
    return out
  }

  /** 确保某一横坐标附近已光栅化（异步；失败静默，下一帧还会再试） */
  async ensure(x: number, viewW: number): Promise<void> {
    const jobs = this.visibleIndexes(x, viewW)
      .filter((i) => !this.bitmaps.has(i) && !this.loading.has(i))
      .map((i) => this.load(i))
    if (jobs.length > 0) await Promise.all(jobs)
  }

  private async load(index: number): Promise<void> {
    if (this.loading.has(index)) return
    this.loading.add(index)
    try {
      const x = this.startOf(index)
      const w = Math.min(this.chunkW, this.totalW - x)
      if (w <= 0) return
      const one = applyRangeToSvg(this.svg, { x, y: 0, w, h: this.h })
      /**
       * adj1277：把切片的**根宽高**改成"目标尺寸"（= 排版宽 × zoom）。
       *
       * 为什么要改写：浏览器画 SVG 图片时按**固有尺寸**光栅化再缩放 —— 固有尺寸还是 427×65 的话，
       * 放大 4.5 倍就是一张糊图（截图里字形边缘全是锯齿）。改写成 1922×292 后，
       * 浏览器直接在目标分辨率渲染矢量 ⇒ 清晰。
       */
      const scaled = one
        .replace(/width="[\d.]+"/, `width="${Math.round(w * this.zoom)}"`)
        .replace(/height="[\d.]+"/, `height="${Math.round(this.h * this.zoom)}"`)
      const img = await svgToImage(scaled)
      const ink = paint(img, w * this.zoom, this.h * this.zoom, this.scale)
      const halo = this.style.haloWidth > 0 ? silhouette(ink, this.style.halo) : null
      this.bitmaps.set(index, { x, w, ink, halo })
      this.order.push(index)
      this.trim()
    } catch {
      /* 单块失败不影响整帧：下一帧重试 */
    } finally {
      this.loading.delete(index)
    }
  }

  /** LRU：只留最近用过的 N 块 */
  private trim(): void {
    while (this.order.length > this.maxChunks) {
      const drop = this.order.shift()
      if (drop !== undefined) this.bitmaps.delete(drop)
    }
  }

  /**
   * 把条带画到画布上（`scrollX` = 视口左缘对应的条带 x）。
   *
   * `dstY` 是条带顶在画布上的 y。块没准备好就跳过（首帧允许一闪）。
   */
  blit(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, scrollX: number, dstY: number): void {
    const s = this.style
    const z = this.zoom
    for (const [, b] of this.bitmaps) {
      // adj1277：块坐标是排版坐标，画到画布上要乘 zoom
      const dx = (b.x - scrollX) * z
      const dw = b.w * z
      const dh = this.h * z
      if (dx > ctx.canvas.width || dx + dw < 0) continue
      if (b.halo !== null) {
        /**
         * ⚠ 描边粗细 / 阴影模糊是**画布像素**（用户调的是"看起来多粗"），不随 zoom 放大。
         * 早先这里乘了 zoom（4.5×）⇒ 描边变成 13px 的大黑边，字形被糊成一团（看真图才发现）。
         */
        const hw = Math.max(1, s.haloWidth)
        for (let i = 0; i < 8; i++) {
          const ang = (i * Math.PI) / 4
          ctx.drawImage(b.halo, dx + Math.cos(ang) * hw, dstY + Math.sin(ang) * hw, dw, dh)
        }
      }
      if (s.shadowBlur > 0) {
        ctx.save()
        ctx.shadowColor = s.shadow
        ctx.shadowBlur = s.shadowBlur
        ctx.drawImage(b.ink, dx, dstY, dw, dh)
        ctx.restore()
      }
      ctx.drawImage(b.ink, dx, dstY, dw, dh)
    }
  }
}

/** SVG 字符串 → 图片（等字体就绪；否则首帧字形会回退） */
async function svgToImage(svg: string): Promise<HTMLImageElement> {
  if (typeof document !== 'undefined' && document.fonts?.ready) await document.fonts.ready
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'sync'
    img.src = url
    await img.decode()
    return img
  } finally {
    // 解码完即可释放（图片已经把像素留在内部）
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

/** 画到离屏画布（`scale` 倍） */
function paint(img: HTMLImageElement, w: number, h: number, scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(w * scale))
  c.height = Math.max(1, Math.ceil(h * scale))
  const ctx = c.getContext('2d')
  if (ctx !== null) {
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0, w, h)
  }
  return c
}

/** 把一张位图整片染成一个颜色（= 剪影，供描边/阴影用） */
function silhouette(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = src.width
  c.height = src.height
  const ctx = c.getContext('2d')
  if (ctx !== null) {
    ctx.drawImage(src, 0, 0)
    ctx.globalCompositeOperation = 'source-in'
    ctx.fillStyle = color
    ctx.fillRect(0, 0, c.width, c.height)
  }
  return c
}
