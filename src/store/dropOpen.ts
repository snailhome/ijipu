/**
 * store/dropOpen.ts — **把 `.jps` 拖进窗口就打开**（adj968，用户要求）
 *
 * ## 两端两套机制（本模块把差别收在一处）
 *
 * | 端 | 事件源 | 拿到的东西 | 打开后能不能写回 |
 * |---|---|---|---|
 * | 网页 / PWA（Chromium） | 页面里的 HTML5 `drop` | `DataTransferItem.getAsFileSystemHandle()` ⇒ **真句柄** | **能**（与「打开」同一档：写回、轮询、持久授权） |
 * | 网页 / PWA（Firefox、Safari） | 同上，但只有 `getAsFile()` | `File` | 不能（与「打开=上传」同一档 ⇒ 草稿 + 另存为） |
 * | 桌面壳（Tauri/WebView2） | **原生拖放**（`lib.rs` 的 `WindowEvent::DragDrop`） | **绝对路径** | **能**（复用双击关联那条链） |
 *
 * 桌面端**故意不在页面里监听 HTML5 拖放**：WebView2 默认由原生层接管（Tauri `dragDropEnabled`
 * 默认 `true`），页面里的 `dragover/drop` 根本收不到——所以那一端由 Rust 把路径塞进既有的
 * `PendingOpen` 队列并 emit `ijipu://open-files`（见 `App.tsx` 的接线），本模块只负责**高亮层**
 * （听 `ijipu://drag-hover`）。
 *
 * ## 两条铁律（都是踩过的坑）
 *
 * ① **网页里必须 `preventDefault()`**：不拦的话浏览器会把拖进来的 `.jps` 当成"导航到这个文件"，
 *    直接把整个应用页替换成纯文本 —— 用户看到的是"应用没了"。
 * ② **`getAsFileSystemHandle()` 只能在 drop 事件里同步调起**：`DataTransferItemList` 在事件处理
 *    返回后就被"脱敏"，晚一步拿就永远 null ⇒ 先把返回的 Promise 收集起来，再 `await`。
 */
import { dropOpenCopy } from '../brand/copy'
import { isDesktopShell, tauriGlobal } from '../brand/env'
import { useDocStore } from './docStore'
// adj968：**纯判据**单独一个模块（`dropPick.ts`）—— 本文件 import 了 store，Node 里跑不起来，
// 而"该打开哪一个"这条口径必须能被 `npm run smoke` 直接断言。
import { classifyDropNames } from './dropPick'
import { useUiStore } from './uiStore'

/** 桌面端原生拖放的高亮事件（Rust 侧 `emit("ijipu://drag-hover", nameOrNull)`） */
export const DRAG_HOVER_EVENT = 'ijipu://drag-hover'

export type { DropPick } from './dropPick'
export { classifyDropNames } from './dropPick'

/** 这次拖动是不是"带着文件"（没有文件就不拦，免得挡住页面里其它拖放用途） */
function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  if (dt.items && dt.items.length > 0) {
    return [...dt.items].some((it) => it.kind === 'file')
  }
  return (dt.types ?? []).includes('Files')
}

/** 拖动中能读到的第一个文件名（Chromium 允许在 dragover 里 `getAsFile()`；读不到就返回 null） */
function peekName(dt: DataTransfer | null): string | null {
  try {
    const it = dt?.items ? [...dt.items].find((x) => x.kind === 'file') : undefined
    return it?.getAsFile()?.name ?? null
  } catch {
    return null // 某些实现会在这里抛，读不到名字不影响拖放本身
  }
}

/** 桌面端：听原生"拖入/拖走"事件（网页端这条恒空转） */
export function onDragHover(handler: (name: string | null) => void): () => void {
  if (!isDesktopShell()) return () => {}
  const g = tauriGlobal()
  if (!g?.event?.listen) return () => {}
  let unlisten: (() => void) | null = null
  let cancelled = false
  void g.event
    .listen(DRAG_HOVER_EVENT, (e) => {
      // 上游类型是 `unknown`（`brand/env.ts` 只声明用到的子树，不引 `@tauri-apps/api`）
      const payload = (e as { payload?: unknown } | null)?.payload
      handler(typeof payload === 'string' ? payload : null)
    })
    .then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    .catch(() => {})
  return () => {
    cancelled = true
    if (unlisten) unlisten()
  }
}

/**
 * 拖进来之后真正把文件打开（句柄优先 ⇒ 可写回；只有 `File` 就按"上传"读入）。
 * 已绑定文件/未保存修改的处理都在 `docStore.openDropped` 里（一处收口）。
 */
async function openDroppedItems(items: DataTransferItem[]): Promise<void> {
  const ui = useUiStore.getState()
  const fileItems = items.filter((it) => it.kind === 'file')
  if (fileItems.length === 0) return
  /**
   * 先把 `getAsFileSystemHandle()` 的 Promise **同步**收集起来（见文件头铁律②），
   * 再逐个 await —— 晚一步拿，`items` 已经被脱敏、永远拿不到句柄。
   */
  const handles = fileItems.map((it) => {
    const get = (it as unknown as { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })
      .getAsFileSystemHandle
    if (typeof get !== 'function') return Promise.resolve(null)
    return get.call(it).catch(() => null)
  })
  const files = fileItems.map((it) => it.getAsFile())
  const names = files.map((f) => f?.name ?? '')
  void handles
  const pick = classifyDropNames(names.filter((n) => n !== ''))
  // 名字读不到（极少数实现）：不猜，直接报一句"没认出 .jps"
  if (pick.primary === null && names.some((n) => n !== '')) {
    ui.showNotice(dropOpenCopy.onlyJps(pick.ignored), 'warn')
    return
  }
  if (pick.primary === null) return
  const idx = names.indexOf(pick.primary)
  const resolved = await handles[idx]
  const handle = resolved && resolved.kind === 'file' ? (resolved as FileSystemFileHandle) : null
  const file = files[idx] ?? null
  if (!handle && !file) {
    ui.showNotice(dropOpenCopy.failed(pick.primary), 'error')
    return
  }
  const ok = await useDocStore.getState().openDropped({ handle, file })
  // adj1302（用户 2026-11-16 拍板）：拖进来的谱打开成功 ⇒ 展开操作栏并落在**试听**
  if (ok) useUiStore.getState().openDockForIncomingFile()
  if (ok && pick.extraCount > 0) ui.showNotice(dropOpenCopy.extraIgnored(pick.extraCount), 'ok')
}

/**
 * 装上拖放（网页端）：返回卸载函数。
 *
 * `onHint` 用来驱动覆盖层（`null` = 没在拖）。桌面端的高亮事件也一并转发给它 ——
 * 调用方只需接这一处。
 */
export function attachDropOpen(onHint: (name: string | null) => void): () => void {
  const clear = (): void => onHint(null)
  const onDragOver = (e: DragEvent): void => {
    if (!hasFiles(e.dataTransfer)) return
    // 铁律①：不 preventDefault 就会被浏览器当成"导航到该文件"（等于把应用页替换掉）
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    onHint(peekName(e.dataTransfer) ?? '')
  }
  const onDragLeave = (e: DragEvent): void => {
    // 只有真的离开窗口才清（子元素之间移动也会冒 dragleave ⇒ 不清会闪）
    if (e.relatedTarget === null) clear()
  }
  const onDrop = (e: DragEvent): void => {
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    clear()
    const items = e.dataTransfer ? [...e.dataTransfer.items] : []
    void openDroppedItems(items)
  }
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
  window.addEventListener('dragend', clear)
  // 桌面壳：页面里的 HTML5 拖放收不到（原生层接管）⇒ 高亮改听原生事件
  const offNative = onDragHover(onHint)
  return () => {
    window.removeEventListener('dragover', onDragOver)
    window.removeEventListener('dragleave', onDragLeave)
    window.removeEventListener('drop', onDrop)
    window.removeEventListener('dragend', clear)
    offNative()
  }
}
