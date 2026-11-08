/**
 * export/video/stripTheme.ts — 单行谱的配色/描边/阴影主题（adj1260）
 *
 * 用户 2026-11-08 要求：「简谱文本应显示加边框/阴影，文本/边框/阴影颜色可调，
 * 确保简谱在背景视频中清晰可见。可预设主题模板」。
 *
 * 为什么单独一层：主题要同时被 **预览** 与 **出片** 消费，而且颜色写错（非法色串、
 * 透明度越界）不该让整条视频崩——所以取值一律过 `normalizeStripStyle` 钳制。
 * 预设只给"能直接用的四套"，自定义走同一结构（以后加模板库）。
 *
 * adj1266（用户 2026-11-09 拍板「配色随卡片模板」）：默认不再是某套固定预设，而是
 * **`auto` = 从卡片模板的调色板推出来**——卡片和谱带在同一个画面里，用户直觉是
 * "这套模板就是这支片子的样子"；两处各自挑色最容易出现"深蓝卡片 + 金色谱带"这种不搭。
 * 四套预设仍保留，供用户明确指定（这时就不跟卡片走）。
 */
import type { CardStyle } from './cardTemplates'

export interface StripStyle {
  /** 文本（墨色） */
  ink: string
  /** 描边色 */
  halo: string
  /** 描边宽度（px；0 = 不描边） */
  haloWidth: number
  /** 阴影色 */
  shadow: string
  /** 阴影模糊（px；0 = 不投影） */
  shadowBlur: number
  /** 定位色块填充色 */
  blockColor: string
  /** 定位色块不透明度（0~1） */
  blockAlpha: number
  /** 跳跳球颜色 */
  ballColor: string
}

export type StripThemeId = 'night' | 'paper' | 'gold' | 'brand'

export interface StripThemePreset {
  id: StripThemeId
  label: string
  style: StripStyle
}

/** 内置四套：按"背景视频最常见的样子"配的（深色实拍 / 浅色纸面 / 暖调舞台 / 品牌色） */
export const STRIP_THEMES: StripThemePreset[] = [
  {
    id: 'night',
    label: '夜（白字黑边）',
    style: {
      ink: '#ffffff',
      halo: 'rgba(0,0,0,0.85)',
      haloWidth: 3,
      shadow: 'rgba(0,0,0,0.55)',
      shadowBlur: 0,
      blockColor: '#ff5d6c',
      blockAlpha: 0.22,
      ballColor: '#ff5d6c',
    },
  },
  {
    id: 'paper',
    label: '纸（黑字白边）',
    style: {
      ink: '#1b1b1b',
      halo: 'rgba(255,255,255,0.92)',
      haloWidth: 3,
      shadow: 'rgba(0,0,0,0.28)',
      shadowBlur: 0,
      blockColor: '#2f6fed',
      blockAlpha: 0.18,
      ballColor: '#2f6fed',
    },
  },
  {
    id: 'gold',
    label: '金（暖调舞台）',
    style: {
      ink: '#ffd36b',
      halo: 'rgba(60,32,0,0.9)',
      haloWidth: 3,
      shadow: 'rgba(0,0,0,0.6)',
      shadowBlur: 2,
      blockColor: '#ffb024',
      blockAlpha: 0.2,
      ballColor: '#ffb024',
    },
  },
  {
    id: 'brand',
    label: '品牌红',
    style: {
      ink: '#ffffff',
      halo: 'rgba(120,10,24,0.92)',
      haloWidth: 3,
      shadow: 'rgba(0,0,0,0.5)',
      shadowBlur: 0,
      blockColor: '#ff5d6c',
      blockAlpha: 0.3,
      ballColor: '#ffffff',
    },
  },
]

export const DEFAULT_STRIP_THEME_ID: StripThemeId = 'night'

/**
 * adj1266：`auto` = **跟随卡片模板**（用户 2026-11-09 拍板）。
 *
 * 为什么用一个字符串而不是 `undefined`：sidecar 里"没写过 theme"与"明确选了跟卡片走"
 * 在界面上要显示成同一项（`auto`），所以解析层统一归一成它；写盘时 `auto` 不落字段
 * （缺字段就是 auto，旧文件天然兼容）。
 */
export const STRIP_THEME_AUTO = 'auto'

/** 颜色亮度（0~1，WCAG 相对亮度的简化版；只用来区分"深底/浅底"）。认不出按深色算。 */
export function colorLuminanceOf(color: string): number {
  const c = (color ?? '').trim().toLowerCase()
  if (c === 'white') return 1
  if (c === 'black') return 0
  const hex = /^#([0-9a-f]{3,8})$/.exec(c)
  if (hex !== null) {
    let h = hex[1]
    // #rgb / #rgba 先展开；#rrggbbaa 只看前 6 位（底色不透明度不影响"深/浅"判断）
    if (h.length === 3 || h.length === 4) h = `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
    else if (h.length === 8) h = h.slice(0, 6)
    const r = Number.parseInt(h.slice(0, 2), 16)
    const g = Number.parseInt(h.slice(2, 4), 16)
    const b = Number.parseInt(h.slice(4, 6), 16)
    if (![r, g, b].every((n) => Number.isFinite(n))) return 0
    const lin = (v: number): number => {
      const s = v / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(c)
  if (rgb !== null) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number)
    if (![r, g, b].every((n) => Number.isFinite(n))) return 0
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  }
  return 0
}

/** 这套卡片是不是浅底（纸面）；用来决定谱带描边走白边还是黑边 */
export function isLightCard(card: Pick<CardStyle, 'bg'>): boolean {
  return colorLuminanceOf(card.bg[1]) > 0.5
}

/**
 * adj1266：**卡片模板 → 谱带配色**（用户 2026-11-09 拍板「配色随卡片模板」）。
 *
 * 规则只有四条，全部确定性（同一套模板每次算出同一份样式，可直接断言）：
 *  ① 墨色 = 卡片标题色 `title.from`——深底模板本来就是亮字、纸面本来就是墨字，
 *     这套搭配是卡片自己"在底上可读"的答案，直接复用；
 *  ② 描边 = 与底色相反的半透明色（深底黑边 / 浅底白边）——**它才是"任何背景都读得清"的保险**，
 *     所以纸面模板（墨字）落在深色视频上也不会糊成一团；
 *  ③ 色块 / 跳跳球 = 卡片强调色 `accent`（片子的高亮与卡片同一支色）；
 *  ④ 色块浓淡：浅底 0.18 / 深底 0.22（与四套预设同一量级，不抢字）。
 */
export function stripStyleFromCard(card: CardStyle): StripStyle {
  const light = isLightCard(card)
  const accent = colorSwatchOf(card.accent)
  return normalizeStripStyle({
    ink: card.title.from,
    halo: light ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.85)',
    haloWidth: 3,
    shadow: light ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.55)',
    shadowBlur: 0,
    blockColor: accent,
    blockAlpha: light ? 0.18 : 0.22,
    ballColor: accent,
  })
}

/**
 * adj1266：主题选择的**基准样式**——`auto`（缺省）走卡片模板，其它走四套预设。
 *
 * 这是"配色从哪来"的唯一入口：界面、sidecar 判重、断言都调它，不许各写一套。
 * `card` 缺省（拿不到模板时）退回默认预设，行为与 adj1265 一致。
 */
export function stripBaseStyleOf(theme: string | null | undefined, card?: CardStyle | null): StripStyle {
  const id = (theme ?? '').trim()
  if (id === '' || id === STRIP_THEME_AUTO) {
    return card !== null && card !== undefined ? stripStyleFromCard(card) : stripThemeOf(DEFAULT_STRIP_THEME_ID)
  }
  return stripThemeOf(id)
}

/**
 * adj1265：**用户自定义的那几项**（M4 主题编辑器）。
 *
 * 为什么存"覆盖"而不是整份样式：整份存下来会把当时预设的值一起冻进 sidecar，
 * 以后调预设（比如把"夜"的描边从 3 改 4）对老歌就不生效了；只存用户真动过的字段，
 * 主题仍是那套主题，只是被改了几笔。
 */
export type StripStyleOverride = Partial<StripStyle>

/** 可自定义的字段清单（顺序 = 编辑器里的顺序；解析 sidecar 时只认这些键） */
export const STRIP_STYLE_KEYS = [
  'ink',
  'halo',
  'haloWidth',
  'shadow',
  'shadowBlur',
  'blockColor',
  'blockAlpha',
  'ballColor',
] as const satisfies readonly (keyof StripStyle)[]

/** 某套预设的"标准样式"（已钳制） */
export function stripThemeOf(id: StripThemeId | string | null | undefined): StripStyle {
  const hit = STRIP_THEMES.find((t) => t.id === id)
  return normalizeStripStyle((hit ?? STRIP_THEMES[0]).style)
}

/**
 * adj1265：主题 + 自定义覆盖 ⇒ 实际要画的样式（**预览/出片/断言共用的唯一入口**）。
 *
 * 覆盖里的非法色串/越界数值一律回退到该主题预设的值（`normalizeStripStyle` 的 `base`），
 * 所以用户手抖写坏一个色串，最多那一项没生效，不会整条视频崩。
 *
 * adj1266：第三个参数 `card` 是"跟随卡片模板"（`auto`）时的调色板来源；
 * 明确选了四套预设时它不影响结果。缺省省略 ⇒ 等价于旧行为。
 */
export function stripStyleOf(
  id: string | null | undefined,
  override?: StripStyleOverride | null,
  card?: CardStyle | null,
): StripStyle {
  const base = stripBaseStyleOf(id, card)
  return normalizeStripStyle(override ?? null, base)
}

/** 覆盖里到底改了哪几项（空 ⇒ 等于"没动过"，编辑器可以显示"跟随预设"） */
export function stripStyleOverrideOf(style: StripStyle, base: StripStyle): StripStyleOverride {
  const out: StripStyleOverride = {}
  for (const k of STRIP_STYLE_KEYS) {
    if (style[k] !== base[k]) (out as Record<string, unknown>)[k] = style[k]
  }
  return out
}

/** 覆盖里有没有值（`{}` / 全是 undefined ⇒ false） */
export function hasStripStyleOverride(override: StripStyleOverride | null | undefined): boolean {
  if (override === null || override === undefined) return false
  return STRIP_STYLE_KEYS.some((k) => override[k] !== undefined)
}

/** 编辑器里"恢复预设"：返回该主题的标准样式（整份，方便直接灌进草稿） */
export function stripPresetStyleOf(id: StripThemeId | string | null | undefined): StripStyle {
  return stripThemeOf(id)
}

/**
 * adj1265：色串 → `<input type="color">` 能显示的 `#rrggbb`。
 *
 * 为什么需要：预设里描边/阴影是 `rgba(...)`（要半透明），而原生取色器只认 `#rrggbb`；
 * 不转的话取色器会闪成黑色，用户一碰就把半透明描边换成纯黑。
 * 取不到就回白色（只影响取色器**显示**，不动真实色串）。
 */
export function colorSwatchOf(color: string): string {
  const c = (color ?? '').trim()
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(c)
  if (hex !== null) {
    const h = hex[1]
    return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase() : `#${h.toLowerCase()}`
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(c)
  if (rgb !== null) {
    const to = (v: string): string =>
      Math.max(0, Math.min(255, Math.round(Number(v))))
        .toString(16)
        .padStart(2, '0')
    return `#${to(rgb[1])}${to(rgb[2])}${to(rgb[3])}`
  }
  return '#ffffff'
}

/**
 * 颜色是否是可安全写进 canvas 的色串。
 *
 * adj1265：从"看起来像颜色就行"收紧为**按分量校验**——`rgb(1,2)` 这种少分量的串
 * 正则原来也放行，可 canvas 会**静默忽略**它（保持上一次的 fillStyle），
 * 于是"用户改了个颜色、画面没变、也不报错"。现在校验不过就回退到预设色。
 */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const RGB_RE =
  /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*(\d{1,3}%|0?\.\d+|0|1)\s*)?\)$/i
const HSL_RE = /^hsla?\(\s*[-+]?\d{1,3}(?:\.\d+)?(?:deg|turn|rad)?\s*[, ]\s*\d{1,3}%\s*[, ]\s*\d{1,3}%\s*(?:[,/]\s*(\d{1,3}%|0?\.\d+|0|1)\s*)?\)$/i
const KEYWORD_RE = /^[a-zA-Z]{3,20}$/

function safeColor(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const c = v.trim()
  if (HEX_RE.test(c) || KEYWORD_RE.test(c)) return c
  const rgb = RGB_RE.exec(c)
  if (rgb !== null) {
    const ok = [rgb[1], rgb[2], rgb[3]].every((n) => Number(n) >= 0 && Number(n) <= 255)
    return ok ? c : fallback
  }
  return HSL_RE.test(c) ? c : fallback
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo
}

/** 钳制一份样式（非法色串回退、数值越界夹紧）——预览/出片共用这一条口径 */
export function normalizeStripStyle(p: Partial<StripStyle> | null | undefined, base: StripStyle = STRIP_THEMES[0].style): StripStyle {
  const s = { ...base, ...(p ?? {}) }
  return {
    ink: safeColor(s.ink, base.ink),
    halo: safeColor(s.halo, base.halo),
    haloWidth: Math.round(clamp(s.haloWidth, 0, 12) * 10) / 10,
    shadow: safeColor(s.shadow, base.shadow),
    shadowBlur: Math.round(clamp(s.shadowBlur, 0, 24) * 10) / 10,
    blockColor: safeColor(s.blockColor, base.blockColor),
    blockAlpha: Math.round(clamp(s.blockAlpha, 0, 1) * 100) / 100,
    ballColor: safeColor(s.ballColor, base.ballColor),
  }
}
