/**
 * store/externalOpen.ts — 「外部打开」桥（adj538）
 *
 * 场景：用户在资源管理器里双击 `.jps`（或右键 → 打开方式 → iJipu），Windows 会用
 * `"ijipu.exe" "%1"` 启动我们；应用已在运行时则由单实例插件把路径转交给已有窗口。
 * 这条链路的**应用侧**就在这里：拉取待打开文件、监听后续打开请求、写回原文件。
 *
 * 设计要点：
 *  - **纯网页构建下完全惰性**：所有 Tauri 访问都在函数内部进行（模块顶层不碰 `window`/全局），
 *    因此纯浏览器里 `hasShell()` 恒为 false、`drainExternalFiles()` 恒返回空数组，行为与从前一致。
 *  - 纯逻辑（`pickPrimary`）单独导出，便于 smoke 直接断言（无需 DOM / Tauri）。
 *  - 与 FSA 路径**同口径**：写回也做回读校验（Rust 侧做），失败如实报错，绝不谎报已保存。
 */
import { fileBaseName } from './saveSupport'

/** 一个外部文件（Rust 侧 `ExternalFile` 的镜像） */
export interface ExternalFile {
  /** 绝对路径（写回时用） */
  path: string
  /** 文件名（已去扩展名） */
  name: string
  /** 文本内容；读失败时为空串 */
  code: string
  /** 读失败原因（不为 null 时前端应提示而不是静默打不开） */
  error: string | null
}

/** 外部打开事件名（Rust 侧 `app.emit("ijipu://open-files", paths)`） */
export const EXTERNAL_OPEN_EVENT = 'ijipu://open-files'

// adj628：环境判定收敛到品牌层（快捷键按键名依赖它，见该文件说明）；
// adj954：再收敛一步 —— 读 `__TAURI__` 这个动作只允许发生在 `brand/env.ts` 一处
import { isDesktopShell, tauriGlobal, type TauriGlobal } from '../brand/env'

function tauri(): TauriGlobal | null {
  const g = tauriGlobal()
  return g && g.core && typeof g.core.invoke === 'function' ? g : null
}

/** 是否运行在桌面壳里（Tauri 由 `withGlobalTauri: true` 注入 `window.__TAURI__`）
 *  adj628：判定收敛到品牌层（快捷键要按平台给键名，两处各判一次必然漂移） */
export function hasShell(): boolean {
  return isDesktopShell()
}

/**
 * 一次打开多个文件时取"要载入的那个"和"多余的个数"。
 * 之所以单独成纯函数：双选/多选（例如在资源管理器里选中 3 个 .jps 一起打开）下
 * "载入第一个 + 提示还有几个没打开"这条规则要可测、且不依赖 Tauri。
 */
export function pickPrimary(files: readonly ExternalFile[]): { primary: ExternalFile | null; extraCount: number } {
  if (files.length === 0) return { primary: null, extraCount: 0 }
  return { primary: files[0], extraCount: files.length - 1 }
}

/** 拉取并清空"待打开"队列（幂等：取走即清空，重复调用不会重复打开） */
export async function drainExternalFiles(): Promise<ExternalFile[]> {
  const g = tauri()
  if (!g?.core?.invoke) return []
  try {
    const files = (await g.core.invoke('take_pending_open_files')) as ExternalFile[]
    return Array.isArray(files) ? files : []
  } catch {
    return []
  }
}

/**
 * 写回外部文件（Ctrl+S 存回双击打开的那个原文件）。
 * Rust 侧写完会**回读校验**；失败抛错（由 docStore 归类成保存失败提示）。
 */
export async function writeExternalFile(path: string, text: string): Promise<void> {
  const g = tauri()
  if (!g?.core?.invoke) throw new Error('当前环境不支持写回外部文件')
  await g.core.invoke('write_external_file', { path, text })
}

/**
 * adj966：按绝对路径读**系统文件此刻的内容**（外加 mtime）——外部改动检测的轮询 IO。
 *
 * 与 `writeExternalFile` 成对：桌面端"直接操作系统文件"时，编辑中要能发现"文件被同步端改过"。
 * 读失败**抛错**（不返回空内容）——否则前端会把"读不到"当成"文件被清空"。
 */
export async function readNativeProbe(path: string): Promise<{ text: string; mtimeMs: number | null }> {
  const g = tauri()
  if (!g?.core?.invoke) throw new Error('当前环境不支持按路径读文件')
  const r = (await g.core.invoke('read_native_probe', { path })) as { text?: unknown; mtime_ms?: unknown }
  return {
    text: typeof r?.text === 'string' ? r.text : '',
    mtimeMs: typeof r?.mtime_ms === 'number' ? r.mtime_ms : null,
  }
}

/**
 * adj1156：桌面壳的「打开」——走**原生文件对话框**，返回真实绝对路径。
 *
 * 为什么不用 WebView2 的 `showOpenFilePicker()`：浏览器文件句柄**不暴露所在目录**，
 * 桌面壳拿不到路径就写不了同目录的 `xxx.jps.sync.json`（只能下载一份）。
 * 纯网页/非桌面壳返回 `null`（调用方继续走 FSA）。
 */
export async function pickJpsFile(): Promise<string | null> {
  const g = tauri()
  if (!g?.core?.invoke) return null
  const r = await g.core.invoke('pick_jps_file')
  return typeof r === 'string' && r !== '' ? r : null
}

/**
 * adj1158：桌面壳「另存为」——原生保存对话框 + 同命令写盘 + 回读校验，返回**绝对路径**。
 *
 * 为什么不让前端拿到路径再用 FSA 写：那样存完 sidecar 还要用户"重新打开一次"，
 * 用户明确说"太复杂"。一次做完，前端只负责把 `nativePath` 设上。
 * 用户取消返回 `null`；写盘/回读失败抛错（调用方提示 `saveAsFailed`）。
 */
export async function saveJpsFileNative(name: string, text: string): Promise<string | null> {
  const g = tauri()
  if (!g?.core?.invoke) throw new Error('当前环境不支持原生另存为')
  const r = await g.core.invoke('save_jps_file', { name, text })
  return typeof r === 'string' && r !== '' ? r : null
}

/**
 * adj1288：桌面壳导出乐谱包（zip）——原生保存对话框 + 返回绝对路径。
 * 用户取消返回 `null`；写盘/回读失败抛错。
 */
export async function saveZipFileNative(name: string, b64: string): Promise<string | null> {
  const g = tauri()
  if (!g?.core?.invoke) throw new Error('当前环境不支持原生保存')
  const r = await g.core.invoke('save_zip_file', { name, b64 })
  return typeof r === 'string' && r !== '' ? r : null
}

/** adj1288：打开刚导出的文件，或在资源管理器里定位（reveal=true）。 */
export async function openLocalPath(path: string, reveal: boolean): Promise<void> {
  const g = tauri()
  if (!g?.core?.invoke) throw new Error('当前环境不支持打开本地文件')
  await g.core.invoke('open_local_path', { path, reveal })
}

/**
 * 监听"后续再有文件要打开"（应用已运行时再次双击）：返回取消监听的函数。
 * 注意：**冷启动**那一次不走这里（事件可能早于本函数注册），而是由调用方在挂载时
 * 先 `drainExternalFiles()` 拉取一次——两条路都指向同一个队列，故不会漏也不会重。
 */
export function onExternalOpen(handler: () => void): () => void {
  const g = tauri()
  if (!g?.event?.listen) return () => {}
  let unlisten: (() => void) | null = null
  let cancelled = false
  void g.event
    .listen(EXTERNAL_OPEN_EVENT, () => handler())
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

/** 外部文件 → 显示用文件名（统一走 saveSupport 的口径，避免两处各写一遍） */
export function externalFileName(file: ExternalFile): string {
  return fileBaseName(file.name)
}
