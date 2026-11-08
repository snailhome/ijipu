/**
 * export/video/stripTheme.ts — 单行谱的配色/描边/阴影主题（adj1260）
 *
 * 用户 2026-11-08 要求：「简谱文本应显示加边框/阴影，文本/边框/阴影颜色可调，
 * 确保简谱在背景视频中清晰可见。可预设主题模板」。
 *
 * 为什么单独一层：主题要同时被 **预览** 与 **出片** 消费，而且颜色写错（非法色串、
 * 透明度越界）不该让整条视频崩——所以取值一律过 `normalizeStripStyle` 钳制。
 * 预设只给"能直接用的四套"，自定义走同一结构（以后加模板库）。
 */
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

export function stripThemeOf(id: StripThemeId | string | null | undefined): StripStyle {
  const hit = STRIP_THEMES.find((t) => t.id === id)
  return normalizeStripStyle((hit ?? STRIP_THEMES[0]).style)
}

/** 颜色是否是可安全写进 canvas 的色串（十六进制 / rgb(a) / 常见关键字） */
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]{3,20})$/

function safeColor(v: unknown, fallback: string): string {
  return typeof v === 'string' && COLOR_RE.test(v.trim()) ? v.trim() : fallback
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
