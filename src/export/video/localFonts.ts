/**
 * export/video/localFonts.ts — 读取**本机已安装字体**（adj1179）
 *
 * 用户口径（2026-11-02）：「因为视频导出只在桌面壳上实现，要求使用的卡片风格上的字体
 * 能够选择本地的字体」。卡片模板里因此允许标题 / 水印 / 印章各存一个**本机字体族**
 * （`fontFamily`），在预设（跟谱面 / 衬线 / 无衬线）之上优先使用。
 *
 * 怎么拿列表：Chromium 的 Local Font Access API `navigator.queryLocalFonts()`。
 * 桌面壳（WebView2）与桌面 Chrome 支持时能直接读系统字体；不支持（Firefox/Safari/部分 WebView2、
 * 或用户拒绝授权）时**不阻断**：界面仍可手动输入字体名（只要系统装了就能渲染）。
 *
 * 为什么不做成"下拉里写死一堆字体名"：用户装的是哪套字体只有本机能知道；
 * 写死的清单换台机器多半对不上，反而制造"选了却没生效"的假象。
 */
import { isTauriShell, tauriCore } from '../../brand/env'

/** `queryLocalFonts()` 返回项里我们只用到 `family` */
interface LocalFontData {
  family?: string
}

type QueryLocalFonts = () => Promise<LocalFontData[]>

/**
 * 常见中文字体（**只作输入提示**，不代表本机一定装了）。
 *
 * 为什么要给：`queryLocalFonts()` 在部分 WebView 里不可用；没有提示时用户只能凭记忆
 * 手打字体名。这些名字只是 `<datalist>` 的候选，真正生效与否仍由系统按名字找。
 */
export const COMMON_LOCAL_FONTS: string[] = [
  '微软雅黑',
  'Microsoft YaHei',
  '宋体',
  'SimSun',
  '黑体',
  'SimHei',
  '楷体',
  'KaiTi',
  '仿宋',
  'FangSong',
  '等线',
  'DengXian',
  '思源黑体',
  'Source Han Sans SC',
  '思源宋体',
  'Source Han Serif SC',
  '华文行楷',
  'STXingkai',
  '华文楷体',
  'STKaiti',
]

/** 当前环境有没有读本机字体的 API（不代表一定会授权成功） */
export function canQueryLocalFonts(): boolean {
  if (typeof navigator === 'undefined') return false
  return typeof (navigator as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === 'function'
}

/** 去空白、去重、按中文习惯排序（桌面 GDI 与浏览器 API 共用同一份收口） */
function cleanNames(names: readonly unknown[]): string[] {
  const set = new Set<string>()
  for (const n of names) {
    const s = typeof n === 'string' ? n.trim() : ''
    if (s !== '') set.add(s)
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/**
 * 桌面壳：走 Rust 的 `list_system_fonts`（GDI 枚举，含中文族名）。
 * 非桌面壳 / 命令不存在 / 调用失败 ⇒ `null`，由调用方退回浏览器 API。
 */
async function desktopSystemFonts(): Promise<string[] | null> {
  if (!isTauriShell()) return null
  const invoke = tauriCore()?.invoke
  if (typeof invoke !== 'function') return null
  try {
    const list = await invoke('list_system_fonts')
    return Array.isArray(list) ? cleanNames(list) : null
  } catch {
    return null
  }
}

/**
 * 读本机字体族（去重、排序；读不到/被拒绝时抛中文错误）。
 *
 * 顺序：**桌面壳先走 Rust GDI 枚举**（最全、含中文族名），再退回浏览器
 * `queryLocalFonts()`（网站/开发浏览器）。只返回 family，不返回字体文件——
 * 渲染仍由系统按 family 找字体，与浏览器普通的 `font-family` 行为一致；
 * 这样卡片模板里存的只是一个名字，换机器能落到 fallback。
 */
export async function listLocalFontFamilies(): Promise<string[]> {
  const desktop = await desktopSystemFonts()
  if (desktop !== null && desktop.length > 0) return desktop
  if (typeof navigator === 'undefined') throw new Error('当前环境没有浏览器字体接口')
  const fn = (navigator as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts
  if (typeof fn !== 'function') throw new Error('当前环境读取不到本机字体列表')
  const fonts = await fn.call(navigator)
  return cleanNames(fonts.map((f) => f?.family))
}
