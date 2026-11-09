/**
 * export/video/stripSvg.ts — 单行谱 → 超宽 SVG → 分块（adj1259）
 *
 * ## 为什么要分块
 *
 * 一条 3 分钟的单行谱按每拍 60px 算约 2 万 px 宽。整张 SVG 交给浏览器光栅会：
 * ① 超过画布尺寸上限（Chrome 单边 ≈ 32767）；② 一帧就吃掉几百 MB。
 * 所以：**一次排版、出一张 SVG**（文本，几 MB 无所谓），**渲染时按可视窗口裁块**。
 *
 * 裁块用的是引擎现成的 `applyRangeToSvg`（只改 `width/height/viewBox`，不动内容）——
 * 它本来就是为"从整页 SVG 里取一段"写的，这里正好复用，不另造一套坐标裁剪。
 *
 * ## 配色为什么是"替换字符串"
 *
 * 引擎渲染把墨色写死成了 `#1b1b1b`（数字/歌词/小节线）、`#333`、`#555`、`#888`。
 * 单行谱要"文本色可调"，最省、最准的办法就是渲染完把这几档墨色换成主题色——
 * 不改引擎渲染（改了会影响谱面预览），也不会漏掉某个 `<text>`。
 */
import { renderScoreToSvg, type LinearStrip, type PageConfig, type ScoreLayout } from '@ijipu/engine'

/**
 * 引擎渲染里出现的**谱面墨色**（顺序无关；替换成一个主题色）。
 *
 * adj1263：`#101010`（歌词）/ `#999`（歌词注释里的音名）/ `#8a8a8a`（页码）之前漏登记，
 * 于是歌词在深色背景上**仍是黑字**（截图里只剩一圈若有若无的轮廓）。
 * 这份清单必须"全"，有闸门守着：`rawSvg` 里出现的 `fill` 若不在清单里（`none`/`#ffffff` 除外）就红灯。
 */
export const STRIP_INK_COLORS = ['#1b1b1b', '#333', '#555', '#888', '#101010', '#999', '#8a8a8a'] as const

/** 一块（条带坐标） */
export interface StripChunk {
  x: number
  w: number
}

/**
 * 把条带切成等宽块（最后一块按剩余宽）。
 *
 * 为什么不是"按小节切"：块宽只跟**渲染成本**有关（一张位图多大），
 * 与小节无关；等宽块让缓存命中率稳定、也不会因为某小节特别宽而爆内存。
 */
export function chunkPlanOf(totalW: number, chunkW: number): StripChunk[] {
  const cw = Math.max(16, Math.round(chunkW))
  const out: StripChunk[] = []
  for (let x = 0; x < totalW; x += cw) {
    out.push({ x, w: Math.min(cw, totalW - x) })
  }
  if (out.length === 0) out.push({ x: 0, w: Math.max(1, totalW) })
  return out
}

/**
 * 把 SVG 里写死的墨色换成主题色。
 *
 * 只认 `STRIP_INK_COLORS` 这几个**精确色串**（大小写不敏感），
 * 不做"任意颜色都换"——谱面里还有高亮色/水印色，那些不该被文本色覆盖。
 */
export function tintSvg(svg: string, ink: string): string {
  let out = svg
  for (const c of STRIP_INK_COLORS) {
    out = out.split(`fill="${c}"`).join(`fill="${ink}"`)
    out = out.split(`fill="${c.toUpperCase()}"`).join(`fill="${ink}"`)
    out = out.split(`stroke="${c}"`).join(`stroke="${ink}"`)
  }
  return out
}

/** 单行谱 → 合成布局（`renderScoreToSvg` 要的壳） */
export function stripLayoutOf(strip: LinearStrip, cfg: PageConfig): ScoreLayout {
  /**
   * ⚠ adj1276（用户 2026-11-09「滚动谱还有水印，没有取消，去掉」）：
   * 条带**一律不画谱面水印/背景层**。
   *
   * 为什么会漏：`renderScoreToSvg` 的水印层只要 `wmEnabled !== false` 就会画**文字水印**
   * （不需要图片资源），所以"没传 assets"只挡住了背景图和图片水印。用户谱里开着水印时，
   * 滚动谱就会带着一排半透明的「爱记谱・iJipu」。
   */
  return {
    pages: [strip.page],
    config: { ...cfg, wmEnabled: false, bgEnabled: false },
    configKey: 'linear',
  }
}

/**
 * 去掉引擎画的**整页白底**（`data-page-bg`，见 `render/index.ts`）。
 *
 * 为什么必须去掉（adj1263，看真图才发现的）：
 *  · 条带是**盖在背景视频上的图层**，白底会把视频整块遮住；
 *  · 更要命的是描边：`stripRaster` 用 `source-in` 把整块染成剪影，白底是**不透明矩形**
 *    ⇒ 剪影 = 整块矩形，8 方向偏移画出来就是一块大黑影（实测第一块上出现深色方块 + 白带）。
 * 引擎给这个 rect 打了 `data-page-bg` 标记，就是给宿主"要透明化时按它选"的（别用 `rect:first-child`）。
 */
export function stripOverlaySvg(svg: string): string {
  return svg.replace(/<rect\s+data-page-bg="1"[^>]*\/>/g, '')
}

/**
 * 出 SVG（一条字符串）。
 *
 * `ink` 给了就顺手换色；不给就保持引擎原色（便于排查"是配色错了还是渲染错了"）。
 * 不论换不换色，**整页白底一律去掉**（条带是透明图层，见 `stripOverlaySvg`）。
 */
export function stripSvgOf(strip: LinearStrip, cfg: PageConfig, ink?: string): string {
  const svgs = renderScoreToSvg(stripLayoutOf(strip, cfg))
  const svg = stripOverlaySvg(svgs[0] ?? '')
  return ink !== undefined && ink !== '' ? tintSvg(svg, ink) : svg
}
