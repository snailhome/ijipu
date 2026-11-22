/**
 * playback/spaceToggle.ts — 「空格 = 试听播放/暂停」的**目标判定**（adj1321）
 *
 * 用户口径（2026-11-22）：「当焦点未在编辑区或未在右栏/底栏页签中时使用空格操作播放/暂停」。
 *
 * 判定顺序：
 *  ① **区域**：编辑区（`.editor-main`）、右栏/底栏（`.tool-dock` / `.right-dock`）、
 *     模态框（`.modal`）里的按键**不接管**——那里空格有原生含义（打字、点按钮、滚动文档）；
 *  ② **原生控件**：输入框 / 文本域 / 下拉 / 按钮 / 链接 / contenteditable / 常见带
 *     `role` 的控件**不接管**（键盘用户还要用空格激活它们）；
 *  ③ 其余（预览、页面空白等）⇒ 允许；调用方还要确认"**已有播放会话**"（`playbackBridge`），
 *     否则空格照常滚动页面——不能随手按一下空格就触发音源下载。
 *
 * 抽成纯函数（`spacePlaybackAllowed`）是为了 `npm run smoke` 能在 Node 里直接断言；
 * 依赖 DOM 的 `closest` 只放在 `spaceTargetOf` 里，Node 侧不调用它。
 */

/** 一个按键目标对判据有用的全部信息（纯数据，便于 Node 断言） */
export interface SpaceTargetInfo {
  /** 最近的"有原生空格语义"元素（或目标自己）的标签名，大写 */
  tag: string
  /** 显式 role（小写；没有则 null） */
  role: string | null
  /** contenteditable / isContentEditable */
  editable: boolean
  /** 带 href 的链接 */
  link: boolean
  /** 落在编辑区（`.editor-main`） */
  inEditor: boolean
  /** 落在右栏/底栏（`.tool-dock` / `.right-dock`） */
  inDock: boolean
  /** 落在模态框（`.modal`） */
  inModal: boolean
}

/** 空格有原生语义的标签（contenteditable / 链接单独判） */
const NATIVE_SPACE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY'])

/** 空格有原生语义的 role（自定义控件也要让开） */
const NATIVE_SPACE_ROLES = new Set([
  'button',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'link',
])

/** 纯判据：这个目标允许用空格控制播放吗？（不负责判断"有没有播放会话"） */
export function spacePlaybackAllowed(t: SpaceTargetInfo): boolean {
  if (t.inEditor || t.inDock || t.inModal) return false
  if (t.editable || t.link) return false
  if (NATIVE_SPACE_TAGS.has(t.tag)) return false
  return t.role === null || !NATIVE_SPACE_ROLES.has(t.role)
}

/** 这些区域里的空格一律不接管（见文件头 ①） */
const BLOCKED_REGION = '.editor-main, .tool-dock, .right-dock, .modal'
/** 找"最近的有原生空格语义的控件"（SVG 图标在按钮里时也要认到按钮） */
const NATIVE_SPACE_SELECTOR = 'input, textarea, select, button, summary, a[href], [contenteditable], [role]'

/** 从 DOM 目标取判据信息（只在浏览器里调用；Node 里不要调） */
export function spaceTargetOf(target: EventTarget | null): SpaceTargetInfo | null {
  if (!(target instanceof Element)) return null
  const el = target
  const native = el.closest(NATIVE_SPACE_SELECTOR) ?? el
  const tag = native.tagName.toUpperCase()
  const region = el.closest(BLOCKED_REGION)
  return {
    tag,
    role: (native.getAttribute('role') ?? '').trim().toLowerCase() || null,
    editable: native instanceof HTMLElement && native.isContentEditable,
    link: tag === 'A' && native.hasAttribute('href'),
    inEditor: region?.classList.contains('editor-main') === true,
    inDock: region?.classList.contains('tool-dock') === true || region?.classList.contains('right-dock') === true,
    inModal: region?.classList.contains('modal') === true,
  }
}

/**
 * 组合判据：事件目标允许空格控制播放吗？
 * **播放会话是否存在由调用方另判**（`getPlaybackBridge() !== null`）。
 */
export function canSpaceTogglePlayback(target: EventTarget | null): boolean {
  const t = spaceTargetOf(target)
  return t !== null && spacePlaybackAllowed(t)
}
