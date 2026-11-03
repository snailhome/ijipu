/**
 * brand/siteVars.ts — 官网页面（首页 + 文档页）的主题色注入与深浅切换
 *
 * ## 背景（adj876 建、adj878 扩成两套）
 *
 * 官网这两类页面都**不加载应用的主题系统**（`src/styles/theme.css` 那套 `--jp-*` 由应用的 JS
 * 按用户选的 6 个中国色主题 + 深浅模式写到根元素上），但它们要用同一套品牌色。
 * 于是这里统一注入 `--site-*` 变量，CSS 只消费变量：**色值集中在 brand 层**。
 *
 * adj878（用户要求「首页右上角要有深浅主题切换」）：从"一套深色"扩成**深浅两套** +
 * 一个模式判定。官网上只做两态（深 / 浅），不做应用那套 `auto + 6 主题`——
 * 官网是介绍页，用户要的是"别刺眼"，不是配色方案。
 *
 * ## 为什么"防闪烁"要单独存在 HTML 里
 *
 * 变量是 JS 注入的 ⇒ 选了浅色的人会先看到一帧深色。所以每个页面的 `<head>` 里都有一小段
 * 内联脚本**先**把 `data-site-mode` 写到 `<html>` 上（并配一条用属性选择器的兜底背景色）。
 * 那段脚本是模式的**唯一权威**，JS 这边只读它（`currentSiteMode()`）并注入完整配色。
 *
 * ⚠ 浅色那一套的**逐值对齐**应用浅色主题（`src/styles/theme.css` 的 `[data-mode='light']`，黛蓝）：
 *   尤其是强调色——深色下用霓虹青 `#00F0FF`，浅色下必须换成 `#0891a6`，否则亮青压在浅底上根本看不清。
 *   应用那边改浅色配色时，这里要跟着改（属"两处都算品牌配色"的情况）。
 */
import { palette, ui } from './tokens'

/** 官网主题模式：只有深浅两态 */
export type SiteMode = 'dark' | 'light'

/**
 * 用户选择的存储键。
 * ⚠ 用 `ijipu.site.` 前缀：首页判定「你以前用过 → 直接进应用」时要**排除**这一族键
 * （见 `landing/main.ts` 的 `SITE_KEY_PREFIX`），否则用户点一下主题切换就会被当成"用过应用"。
 */
export const SITE_THEME_KEY = 'ijipu.site.theme'

/** 深色（品牌默认）——值与应用的深色语义色一致（`brand/tokens.ts` 的 `ui`） */
const DARK_VARS: Record<string, string> = {
  '--site-bg': ui.bgApp,
  '--site-panel': ui.bgPanel,
  '--site-panel-hover': ui.bgPanelHover,
  '--site-border': ui.border,
  '--site-text': ui.textPrimary,
  '--site-text-2': ui.textSecondary,
  '--site-muted': ui.textMuted,
  '--site-accent': ui.accent,
  '--site-accent-hover': '#6ff5ff',
  /** 强调色底上的文字（霓虹青底配深字才够对比） */
  '--site-on-accent': '#06222a',
  '--site-primary': palette.deepSpaceBlue,
  '--site-warn': ui.warning,
  '--site-danger': ui.danger,
  /** 代码块底色（比面板再暗一档） */
  '--site-code-bg': '#0b1020',
  /** 行内 code 的浅色底 */
  '--site-inline-bg': 'rgba(255, 255, 255, 0.07)',
  /** 行内 code 的字色（深色下是暖橙；浅色下要换成深橙才看得见） */
  '--site-code-ink': '#ffd8a8',
  /** 卡片/图片阴影 */
  '--site-shadow': 'rgba(0, 0, 0, 0.45)',
  /** 吸顶栏滚动后的半透明底（要跟页面底色同色系，否则滚动时"糊"一块深色） */
  '--site-topbar-bg': 'rgba(15, 21, 38, 0.88)',
}

/** 浅色——逐值对齐 `src/styles/theme.css` 的 `[data-mode='light']`（黛蓝） */
const LIGHT_VARS: Record<string, string> = {
  '--site-bg': '#f2f5fb',
  '--site-panel': '#ffffff',
  '--site-panel-hover': '#e9eef8',
  '--site-border': '#d5dcee',
  '--site-text': '#1c2540',
  '--site-text-2': '#46537a',
  '--site-muted': '#7a86a8',
  '--site-accent': '#0891a6',
  '--site-accent-hover': '#0aa6bd',
  '--site-on-accent': '#ffffff',
  '--site-primary': palette.deepSpaceBlue,
  '--site-warn': '#c98a00',
  '--site-danger': '#d64550',
  '--site-code-bg': '#fbfcff',
  '--site-inline-bg': 'rgba(28, 37, 64, 0.06)',
  '--site-code-ink': '#a15c00',
  '--site-shadow': 'rgba(28, 37, 64, 0.14)',
  '--site-topbar-bg': 'rgba(242, 245, 251, 0.88)',
}

/**
 * 两套变量的只读快照。
 *
 * adj1190（曲库）：`/scores/` 的列表页与详情页是**构建期生成的静态 HTML**（不走 Vite 入口、
 * 也不加载 `landing/main.ts`），但必须和首页用同一套品牌色 ⇒ 生成器从这里取两套变量，
 * 直接写进页面的 `:root[data-site-mode=…]`。**不要在运行时改它**，也不要在别处另抄一份色值。
 */
export const SITE_VARS: Readonly<Record<SiteMode, Readonly<Record<string, string>>>> = {
  dark: DARK_VARS,
  light: LIGHT_VARS,
}

/**
 * 兜底背景色：与各 HTML `<head>` 里那段"防闪烁"内联样式**必须一致**（两处都改）。
 *
 * adj930：它同时是**首屏启动层**的底色（`brand/siteBoot.ts` 的 `SITE_BOOT_COLORS` 直接取它），
 * 而"内联值 == 这里的值 == `styles/theme.css` 的主题 token"这三处一致性
 * **已有机器闸门**（`npm run smoke` 的 `[168]` 段 + `scripts/verify-site.mjs` 的同名段）；
 * 原文那句"两处都改"从此不再依赖人的记性。
 */
export const SITE_BG: Record<SiteMode, string> = {
  dark: ui.bgApp,
  light: '#f2f5fb',
}

/**
 * 当前模式：**读 `<html data-site-mode>`**。
 *
 * 权威是各页面 `<head>` 里那段内联脚本（它必须在样式生效前跑，见文件头说明）——
 * 这里**不再自己判一遍**：同一条判定写两处，迟早因为只改了一处而漂移。
 */
export function currentSiteMode(): SiteMode {
  return document.documentElement.dataset.siteMode === 'light' ? 'light' : 'dark'
}

/** 记住用户的选择（只有显式点击才写） */
export function saveSiteMode(mode: SiteMode): void {
  try {
    localStorage.setItem(SITE_THEME_KEY, mode)
  } catch {
    // 存不下就只影响本次访问，不打扰用户
  }
}

/**
 * 注入某个模式的整套变量，并把模式写到 `<html data-site-mode>`。
 * 切换时**重新调用**即可（同步生效，不需要重载页面）；
 * 那个属性供 CSS 处理"看着色不一样"的细节（按钮图标、浅色下的图片阴影…）。
 */
export function injectSiteColors(mode: SiteMode): void {
  const vars = mode === 'light' ? LIGHT_VARS : DARK_VARS
  const root = document.documentElement
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  root.dataset.siteMode = mode
}
