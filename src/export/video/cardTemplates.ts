/**
 * 动态谱视频的片头/片尾卡片模板（adj1073）。
 *
 * 为什么单独抽出来：用户要求把卡片风格提炼成模板，后面做“卡片风格”设置，
 * 再后面允许用户自定义。这里只放**可序列化的数据**，渲染器（renderer.ts）只消费，
 * 不再把颜色/水印/字体写死在绘制函数里。
 *
 * 三层关系：
 *  - `CardStyle`：一个完整的卡片样式（背景、光晕、水印、文字色、字体、动效、印章…）；
 *  - `CARD_TEMPLATES`：预设模板（深空蓝 / 纸面 / 水墨 / 极简），每个模板就是一份 CardStyle；
 *  - `custom`：以后设置界面产出的另一份 CardStyle，与预设走同一个渲染入口。
 *
 * 所有模板的片尾都必须展示品牌（中文名 + 英文名 + 标语 + 网址），这是用户明确要求；
 * `CardStyle` 不提供“隐藏品牌”的开关。
 */
import { normalizeFontStack } from '@ijipu/engine'

export type CardTitleFont = 'score' | 'serif' | 'sans'

/** 预设模板的稳定 id；用户模板用 `tpl-…` 之类的自造 id（adj1176 起） */
export type CardTemplateId = 'brand' | 'paper' | 'ink' | 'minimal'

/** 卡片背景/文字/装饰的完整样式；可 JSON 序列化，供以后的“自定义”保存 */
export interface CardStyle {
  /** 稳定 id；预设用固定值，自定义用 `custom` */
  id: string
  /**
   * adj1182：这份模板是从哪个**内置预设**起手改的（只用于对话框里「起点模板」的回显）。
   *
   * 为什么单独存：样式本身已经烘焙进 `CardStyle`，但用户重开模板时希望看到
   * "我这套是从纸面改的"，而不是每次都被重置成"深空蓝"。
   */
  baseId?: CardTemplateId
  /** 设置里显示的名字 */
  name: string
  /** 设置里显示的一句话说明 */
  description: string
  /** 背景三段渐变（上/中/下） */
  bg: [string, string, string]
  /** 两团径向光晕（颜色含 alpha） */
  glow: [string, string]
  /** 五线谱细线 */
  staff: { color: string; alpha: number }
  /**
   * 大号水印：片头/片尾各一段文字，空串表示不画。
   *
   * adj1176（用户 2026-11-01）：**不限于一个字**——可以是歌名、两三个字的题字；
   * 渲染时按可用宽度自动收字号，不会溢出画面。`font` 缺省 = 无衬线（与旧行为一致）。
   */
  watermark: {
    intro: string
    end: string
    color: string
    alpha: number
    scale: number
    font?: CardTitleFont
    /** adj1179：本机字体族（有值优先于 `font` 预设） */
    fontFamily?: string
  }
  /** 细点粒子 / 斜向扫光 */
  particles: boolean
  sweep: boolean
  /** 暗角强度（0~0.8）与暗角色（`r,g,b`） */
  vignette: number
  vignetteColor: string
  /** 四角取景括号 */
  bracket: { color: string; alpha: number }
  /** 标题：冷白/墨色渐变、辉光、字体来源（谱面标题字体 / 衬线 / 无衬线 / 本机字体） */
  title: { from: string; to: string; glow: string; font: CardTitleFont; fontFamily?: string }
  subtitle: string
  author: string
  info: string
  brand: string
  url: string
  accent: string
  /** 是否播放淡入/展开等动效（自定义模板可关） */
  motion: boolean
  /**
   * 角落印章（纸面/水墨用）；null 不画。
   *
   * adj1176：`text` 可以是多个字（最多 6 个，纵向排列）；`font` 缺省 = 衬线。
   * adj1178（用户 2026-11-01）：**也可以用图片**——`image` 有值就画图（不再画文字），
   * 并用 `size` / `x` / `y` 指定大小与位置；文字印章同样吃这三个参数。
   */
  seal: {
    text: string
    color: string
    font?: CardTitleFont
    /** adj1179：本机字体族（有值优先于 `font` 预设；图片印章不需要字体） */
    fontFamily?: string
    /** 印章图片（`ijipu-blob:` 引用或 data URL）；空 = 用文字 */
    image?: string | null
    /** 大小倍数（0.4~2.5，以画面短边的 12% 为基准；缺省 1） */
    size?: number
    /** 中心位置（0~1 画布相对坐标；缺省 0.86 / 0.84） */
    x?: number
    y?: number
  } | null
  /** 以后“换背景图片”的入口：data URL/文件 URL；null/缺省不画 */
  backgroundImage?: string | null
  /**
   * adj1176（用户 2026-11-01）：背景图的**取景位置**（0~1，0.5 = 居中）与**额外放大**（1~2）。
   *
   * 为什么不用 CSS `object-position` 的百分比直接塞进渲染器：canvas 里要自己算；
   * 抽成纯函数 `cardImageRect` 后，预览（对话框）与出片（renderer）共用同一套几何。
   */
  backgroundImagePos?: { x: number; y: number }
  backgroundImageZoom?: number
}

export const CARD_SANS = '"Microsoft YaHei", "PingFang SC", sans-serif'
export const CARD_SERIF = '"Songti SC", "SimSun", "Noto Serif CJK SC", serif'

export const CARD_TEMPLATES: CardStyle[] = [
  {
    id: 'brand',
    name: '深空蓝',
    description: '品牌深空蓝 + 霓虹青，五线谱/粒子/扫光',
    bg: ['#0f1526', '#1e2a5e', '#0a1024'],
    glow: ['rgba(0,240,255,0.16)', 'rgba(90,120,255,0.12)'],
    staff: { color: '#ffffff', alpha: 0.05 },
    watermark: { intro: '♪', end: 'i', color: '#ffffff', alpha: 0.03, scale: 0.52 },
    particles: true,
    sweep: true,
    vignette: 0.55,
    vignetteColor: '2,6,16',
    bracket: { color: '#00f0ff', alpha: 0.3 },
    title: { from: '#ffffff', to: '#d6fbff', glow: 'rgba(0,240,255,0.32)', font: 'score' },
    subtitle: '#00f0ff',
    author: 'rgba(255,255,255,0.86)',
    info: 'rgba(255,255,255,0.68)',
    brand: 'rgba(255,255,255,0.52)',
    url: 'rgba(255,255,255,0.72)',
    accent: '#00f0ff',
    motion: true,
    seal: null,
    backgroundImage: null,
  },
  {
    id: 'paper',
    name: '纸面',
    description: '暖白纸色 + 墨字 + 朱砂线，跟谱面同色系',
    bg: ['#fbf7ee', '#f3ead7', '#e8dbc2'],
    glow: ['rgba(255,255,255,0.55)', 'rgba(180,140,80,0.14)'],
    staff: { color: '#8a7a5f', alpha: 0.06 },
    watermark: { intro: '♪', end: 'i', color: '#6b5a3e', alpha: 0.05, scale: 0.5 },
    particles: false,
    sweep: false,
    vignette: 0.18,
    vignetteColor: '58,42,24',
    bracket: { color: '#b23a2b', alpha: 0.28 },
    title: { from: '#241f19', to: '#4a3a28', glow: 'rgba(255,250,235,0.9)', font: 'serif' },
    subtitle: '#b23a2b',
    author: '#4a4238',
    info: '#6b5f4e',
    brand: '#8a7d68',
    url: '#6b5f4e',
    accent: '#b23a2b',
    motion: true,
    seal: { text: '爱记谱', color: '#b23a2b' },
    backgroundImage: null,
  },
  {
    id: 'ink',
    name: '水墨',
    description: '墨黑 + 米色字 + 朱砂印，东方感',
    bg: ['#0a0a0a', '#171411', '#050505'],
    glow: ['rgba(190,160,110,0.08)', 'rgba(180,60,40,0.08)'],
    staff: { color: '#d8c8a8', alpha: 0.04 },
    watermark: { intro: '♪', end: 'i', color: '#f0e4c8', alpha: 0.04, scale: 0.55 },
    particles: false,
    sweep: false,
    vignette: 0.6,
    vignetteColor: '0,0,0',
    bracket: { color: '#b23a2b', alpha: 0.25 },
    title: { from: '#f5ecd8', to: '#d9c9a8', glow: 'rgba(180,60,40,0.25)', font: 'serif' },
    subtitle: '#c0392b',
    author: '#d9c9a8',
    info: '#a8997c',
    brand: '#8a7a5f',
    url: '#a8997c',
    accent: '#c0392b',
    motion: true,
    seal: { text: '爱记谱', color: '#b23a2b' },
    backgroundImage: null,
  },
  {
    id: 'minimal',
    name: '极简',
    description: '纯深底 + 一条强调线，无装饰',
    bg: ['#0d1117', '#111823', '#0a0e14'],
    glow: ['rgba(0,240,255,0.06)', 'rgba(0,0,0,0)'],
    staff: { color: '#ffffff', alpha: 0.02 },
    watermark: { intro: '', end: '', color: '#ffffff', alpha: 0, scale: 0.5 },
    particles: false,
    sweep: false,
    vignette: 0.4,
    vignetteColor: '2,6,16',
    bracket: { color: '#00f0ff', alpha: 0.2 },
    title: { from: '#ffffff', to: '#ffffff', glow: 'rgba(0,0,0,0)', font: 'sans' },
    subtitle: '#8ffbff',
    author: '#c7d4f0',
    info: '#8fa3cc',
    brand: '#5a6a99',
    url: 'rgba(255,255,255,0.6)',
    accent: '#00f0ff',
    motion: true,
    seal: null,
    backgroundImage: null,
  },
]

export const DEFAULT_CARD_STYLE = CARD_TEMPLATES[0]

const BY_ID = new Map(CARD_TEMPLATES.map((t) => [t.id, t]))

/** 按 id 取预设；未知 id 回退默认模板，避免旧缓存把预览打空 */
export function cardStyleById(id: string | null | undefined): CardStyle {
  return (id && BY_ID.get(id)) || DEFAULT_CARD_STYLE
}

/** 这个 id 是不是内置模板（`brand` / `paper` / `ink` / `minimal`） */
export function isBuiltInCardStyleId(id: string | null | undefined): boolean {
  return typeof id === 'string' && BY_ID.has(id)
}

/**
 * adj1176：从「内置模板 + 用户模板库」里解析一份样式。
 *
 * - 先找内置，再找模板库（用户模板允许与内置同名，但 id 不会撞）；
 * - 都找不到 ⇒ 回退默认模板（相机位会提示"这台电脑没有这套模板"）。
 *
 * 放在这里而不是 store：渲染器、命令行、对话框都要用同一套解析口径。
 */
export function resolveCardStyle(id: string | null | undefined, templates: readonly CardStyle[] = []): CardStyle {
  if (typeof id === 'string' && id !== '') {
    const builtIn = BY_ID.get(id)
    if (builtIn) return builtIn
    const mine = templates.find((t) => t.id === id)
    if (mine) return mine
  }
  return DEFAULT_CARD_STYLE
}

/** 有没有这套模板（内置或模板库） */
export function hasCardStyle(id: string | null | undefined, templates: readonly CardStyle[] = []): boolean {
  if (typeof id !== 'string' || id === '') return false
  return BY_ID.has(id) || templates.some((t) => t.id === id)
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const finite = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

function fontOf(v: unknown, fallback: CardTitleFont): CardTitleFont {
  return v === 'score' || v === 'serif' || v === 'sans' ? v : fallback
}

/** adj1179：本机字体名（去空白、限长；空 = 没选） */
function localFamilyOf(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim().slice(0, 120) : ''
  return s === '' ? undefined : s
}

/**
 * 字体来源 → 真正交给 canvas 的字体栈。
 *
 * `score` = 跟谱面标题字体（`PageConfig.biaoti_font`）；没有谱面字体时退回无衬线。
 * adj1179：`fontFamily`（本机字体）优先——用户明确选了一个系统里装着的字体，
 * 就走 `normalizeFontStack` 补上通用族兜底；留空才用上面的预设。
 * 渲染器与对话框预览共用这一处，避免"选的字体和画出来的不一样"。
 */
export function cardFontStack(
  font: CardTitleFont | null | undefined,
  scoreFont?: string | null,
  fontFamily?: string | null,
): string {
  const local = typeof fontFamily === 'string' ? fontFamily.trim() : ''
  if (local !== '') return normalizeFontStack(local)
  if (font === 'score') return scoreFont !== null && scoreFont !== undefined && scoreFont.trim() !== '' ? scoreFont : CARD_SANS
  if (font === 'serif') return CARD_SERIF
  return CARD_SANS
}

/**
 * adj1176：背景图的「cover + 取景位置 + 缩放」几何（纯函数）。
 *
 * `pos` 是**取景点在图片里的相对位置**（0 = 左/上边缘，1 = 右/下边缘，0.5 = 居中）；
 * `zoom` 在 cover 的基础上再放大（1 = 刚好铺满）。返回值是画到 `W×H` 画布上的矩形。
 *
 * 为什么不直接在渲染器里写：对话框的小预览也要按同一套几何摆，两边必须同源。
 */
export function cardImageRect(
  iw: number,
  ih: number,
  W: number,
  H: number,
  pos?: { x: number; y: number } | null,
  zoom?: number,
): { x: number; y: number; w: number; h: number } {
  const sw = iw > 0 ? iw : Math.max(1, W)
  const sh = ih > 0 ? ih : Math.max(1, H)
  const z = Math.max(W / sw, H / sh) * clamp(finite(zoom, 1), 1, 3)
  const w = sw * z
  const h = sh * z
  const px = clamp(finite(pos?.x, 0.5), 0, 1)
  const py = clamp(finite(pos?.y, 0.5), 0, 1)
  return { x: (W - w) * px, y: (H - h) * py, w, h }
}

/**
 * adj1176 / adj1177：印章里多个字怎么排，以及**外框该多大**（纯函数）。
 *
 * adj1177（用户 2026-11-01）：「印章外框以适配文字大小的不规则椭圆形状为宜」——
 * 不再画固定正方形：
 *  · 单字 ⇒ 近圆（宽 ≈ 高）；
 *  · 多字竖排 ⇒ 外框变成竖长的圆角轮廓，字数越多越高；
 *  · 字数很多时只把字号收到上限内，不把印章撑到画面外。
 *
 * `measure` 由调用方给（canvas `measureText`）；不给就按"一个字＝一个字号宽"估算，
 * 让 Node 里的断言不依赖画布。
 */
export interface SealLayout {
  chars: string[]
  /** 字号（px） */
  font: number
  /** 每个字的纵向步进（px） */
  lineHeight: number
  /** 外框包围盒（宽/高，含内边距） */
  boxW: number
  boxH: number
}

export function sealLayoutOf(
  text: string,
  size: number,
  measure?: (text: string, size: number) => number,
): SealLayout {
  const chars = [...text.replace(/\s+/g, '')].slice(0, 6)
  if (chars.length === 0) return { chars, font: 0, lineHeight: 0, boxW: 0, boxH: 0 }
  const single = chars.length === 1
  const base = single ? size * 0.52 : size * 0.46
  /** 印章最高不超过 size 的 2.6 倍（6 个字也不会顶出画面） */
  const maxH = size * 2.6
  const padRatio = 0.34
  let font = Math.min(base, (maxH - base * padRatio * 2) / (chars.length * 1.04))
  const measureOne = (ch: string, px: number): number => (measure ? measure(ch, px) : px)
  let widest = Math.max(...chars.map((ch) => measureOne(ch, font)))
  const padX = (px: number) => px * 0.42
  const maxW = size * 1.35
  if (widest + padX(font) * 2 > maxW) {
    font *= Math.max(0.35, (maxW - padX(font) * 2) / widest)
    widest = Math.max(...chars.map((ch) => measureOne(ch, font)))
  }
  const lineHeight = font * 1.04
  const padY = font * padRatio
  const boxW = Math.max(widest + padX(font) * 2, size * (single ? 0.82 : 0.62))
  const boxH = chars.length * lineHeight + padY * 2
  return { chars, font, lineHeight, boxW, boxH }
}

/**
 * adj1177 / adj1181：印章外框的**贴合文字的不规则弧线**顶点（纯函数，确定性）。
 *
 * 用户 2026-11-02 口径：「印章外框改为不规则弧线，贴合文字（预留一定间距）即可，不再用椭圆」。
 * 所以这里不是椭圆，而是**超椭圆**（|x/rx|⁴ + |y/ry|⁴ = 1，圆角矩形观感）：
 *  · 包围盒 `boxW/boxH` 已按文字 + 内边距算好 ⇒ 单字近方、多字竖长，弧线始终贴着文字；
 *  · 在半径上叠两层很小的确定性起伏（±3.6%），同一个文字每次画出来一样，像手盖的印。
 *
 * 96 个采样点连成闭合曲线；渲染端的 `lineTo` 在这个密度下看不出折线。
 */
export function sealFramePoints(
  layout: SealLayout,
  cx: number,
  cy: number,
  segments = 96,
): { x: number; y: number }[] {
  const rx = layout.boxW / 2
  const ry = layout.boxH / 2
  const seedText = layout.chars.join('')
  let seed = 7
  for (const ch of seedText) seed = (seed * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  const phase1 = (seed % 360) * (Math.PI / 180)
  const phase2 = ((seed >>> 8) % 360) * (Math.PI / 180)
  /** 超椭圆指数：n=2 是椭圆，n→∞ 是矩形；4 是"圆角矩形/印章边"的观感 */
  const exponent = 2 / 4
  const superAxis = (v: number): number => Math.sign(v) * Math.pow(Math.abs(v), exponent)
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < segments; i += 1) {
    const t = (i / segments) * Math.PI * 2
    const wobble = 1 + 0.022 * Math.sin(3 * t + phase1) + 0.014 * Math.sin(5 * t + phase2)
    out.push({
      x: cx + superAxis(Math.cos(t)) * rx * wobble,
      y: cy + superAxis(Math.sin(t)) * ry * wobble,
    })
  }
  return out
}

/**
 * adj1178：**图片印章**的画布矩形（纯函数）。
 *
 * 尺寸口径：以画面短边的 12% 为基准 × `size`（宽），高度按图片原始比例；
 * 位置是图片**中心**在画布里的相对坐标（0~1）；最后整体夹进画布（不裁掉大半）。
 */
export function sealImageRectOf(
  iw: number,
  ih: number,
  W: number,
  H: number,
  size?: number,
  x?: number,
  y?: number,
): { x: number; y: number; w: number; h: number } {
  const unit = Math.min(W, H)
  const safeIw = iw > 0 ? iw : 1
  const safeIh = ih > 0 ? ih : 1
  const w0 = unit * 0.12 * clamp(finite(size, 1), 0.4, 2.5)
  const h0 = w0 * (safeIh / safeIw)
  // 太大的图（很长的竖图）按画布缩小，保证至少完整落在画面里
  const k = Math.min(1, (W * 0.92) / w0, (H * 0.92) / h0)
  const w = w0 * k
  const h = h0 * k
  const cx = W * clamp(finite(x, 0.86), 0, 1)
  const cy = H * clamp(finite(y, 0.84), 0, 1)
  // 放得下就整枚留在画面里（0 = 贴左/上，1 = 贴右/下），比"一半在画外"好操作
  const left = w >= W ? cx - w / 2 : clamp(cx - w / 2, 0, W - w)
  const top = h >= H ? cy - h / 2 : clamp(cy - h / 2, 0, H - h)
  return { x: left, y: top, w, h }
}

/**
 * adj1176：文字按可用宽度自动收字号（水印不限定字数，不能溢出画面）。
 *
 * `measure` 由调用方给（canvas `measureText` 或测试里的假函数），纯逻辑在这里。
 */
export function fitFontSize(
  measure: (text: string, size: number) => number,
  text: string,
  base: number,
  maxWidth: number,
  min = 10,
): number {
  let size = Math.round(base)
  const floor = Math.max(1, Math.round(min))
  while (size > floor && measure(text, size) > maxWidth) size -= 2
  return size
}

/** 把「用户编辑出来的一份样式」兜成合法值（旧缓存、导入的 zip 都可能缺字段） */
export function normalizeCardStyle(style: Partial<CardStyle> | null | undefined): CardStyle {
  if (!style) return DEFAULT_CARD_STYLE
  const d = DEFAULT_CARD_STYLE
  const bg = Array.isArray(style.bg) && style.bg.length === 3 ? style.bg : d.bg
  const glow = Array.isArray(style.glow) && style.glow.length === 2 ? style.glow : d.glow
  const staff = { ...d.staff, ...(style.staff ?? {}) }
  const watermark = { ...d.watermark, ...(style.watermark ?? {}) }
  const bracket = { ...d.bracket, ...(style.bracket ?? {}) }
  const title = { ...d.title, ...(style.title ?? {}) }
  const seal = style.seal === null ? null : style.seal === undefined ? d.seal : { ...style.seal }
  const pos = style.backgroundImagePos
  return {
    ...d,
    ...style,
    id: style.id || 'custom',
    baseId: isBuiltInCardStyleId(style.baseId) ? style.baseId : undefined,
    name: (style.name || '自定义').slice(0, 40),
    description: style.description || '用户自定义卡片',
    bg: [String(bg[0]), String(bg[1]), String(bg[2])],
    glow: [String(glow[0]), String(glow[1])],
    staff: { color: String(staff.color), alpha: clamp(finite(staff.alpha, d.staff.alpha), 0, 0.3) },
    watermark: {
      intro: String(watermark.intro ?? ''),
      end: String(watermark.end ?? ''),
      color: String(watermark.color),
      alpha: clamp(finite(watermark.alpha, d.watermark.alpha), 0, 1),
      scale: clamp(finite(watermark.scale, d.watermark.scale), 0.1, 1),
      font: fontOf(watermark.font, 'sans'),
      fontFamily: localFamilyOf(watermark.fontFamily),
    },
    particles: style.particles ?? d.particles,
    sweep: style.sweep ?? d.sweep,
    vignette: clamp(finite(style.vignette, d.vignette), 0, 0.8),
    vignetteColor: String(style.vignetteColor ?? d.vignetteColor),
    bracket: { color: String(bracket.color), alpha: clamp(finite(bracket.alpha, d.bracket.alpha), 0, 1) },
    title: {
      from: String(title.from),
      to: String(title.to),
      glow: String(title.glow),
      font: fontOf(title.font, 'score'),
      fontFamily: localFamilyOf(title.fontFamily),
    },
    subtitle: String(style.subtitle ?? d.subtitle),
    author: String(style.author ?? d.author),
    info: String(style.info ?? d.info),
    brand: String(style.brand ?? d.brand),
    url: String(style.url ?? d.url),
    accent: String(style.accent ?? d.accent),
    motion: style.motion ?? d.motion,
    seal:
      seal === null
        ? null
        : {
            text: String(seal.text ?? '爱记谱').slice(0, 6),
            color: String(seal.color ?? d.accent),
            font: fontOf(seal.font, 'serif'),
            fontFamily: localFamilyOf(seal.fontFamily),
            // adj1178：图片印章；空串/非字符串都当"没有图"
            image: typeof seal.image === 'string' && seal.image !== '' ? seal.image : null,
            size: clamp(finite(seal.size, 1), 0.4, 2.5),
            x: clamp(finite(seal.x, 0.86), 0, 1),
            y: clamp(finite(seal.y, 0.84), 0, 1),
          },
    backgroundImage: style.backgroundImage ?? null,
    backgroundImagePos: {
      x: clamp(finite(pos?.x, 0.5), 0, 1),
      y: clamp(finite(pos?.y, 0.5), 0, 1),
    },
    backgroundImageZoom: clamp(finite(style.backgroundImageZoom, 1), 1, 3),
  }
}
