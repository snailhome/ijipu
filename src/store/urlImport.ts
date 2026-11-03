/**
 * store/urlImport.ts — 从 URL 文本串导入源码（adj900，用户要求）
 *
 * ## 用途
 *
 * 官网首页示例区的「在应用里试听这段」按钮，把**用户正在看的那段 .jps 源码**
 * 用查询串带进应用（`/app/?jps=<encodeURIComponent(源码)>`）。
 *
 * ## 为什么用 URL 文本串，而不是写 localStorage 草稿
 *
 * · **无残留**：不去改用户的 `ijipu.draft*`。localStorage 那条路必须自己清 `ijipu.draftSrc`，
 *   漏了就会让应用以为示例仍绑着用户上次打开的文件 —— 之后他按 Ctrl+S 就可能
 *   把示例写进自己的谱里（`docStore` 里记过这个坑）；
 * · **可分享**：链接自带谱，发给别人打开就是同一段（这是白捡的好处）；
 * · **渐进增强**：首页那个入口是 `<a href>`，**没有 JS 也能进应用**。
 *
 * ## 载入动作复用现成的「文本串导入」
 *
 * 应用里本来就有 `docStore.importSource`（adj406，粘贴源码导入），该做的它都做了：
 * 清洗内容、清磁盘句柄、**清来源绑定**、与工作区解绑、标记 dirty。
 * 所以这里**不另写一套载入逻辑**，只负责"把源码从 URL 里取出来 / 用完把参数抹掉"。
 */

/** 查询串里承载源码的键名 */
export const JPS_PARAM = 'jps'

/** 查询串里承载"谱面地址"的键名（adj1191） */
export const SRC_PARAM = 'src'

/**
 * URL 长度上限：超过就不导入。
 *
 * 浏览器本身能吞很长的 URL，但**经过代理 / CDN / 日志**时可能被截断，
 * 而截断后的半段源码比"不导入"更糟 —— 用户会拿到一段坏谱，还以为是自己的问题。
 * 首页那几个示例都只有几百字符，离这个上限很远；
 * 真遇到超长的（有人把整本书贴进链接），退回"正常打开应用"即可。
 */
export const JPS_PARAM_MAX_LEN = 8000

/**
 * 从 `location.search` 取出待导入的源码；没有 / 空串 / 超长一律返回 `null`
 * （调用方据此"什么都不做"，按正常启动走）。
 *
 * ⚠ 返回值**有意** `trim()` 掉首尾空白：网址里常带无意义的尾随换行
 * （压行时多一个 `%0A`），而源码首尾的空行对 `.jps` 语义毫无影响。
 * 纯函数 ⇒ 可在 Node 里直接断言（不依赖 `window`）。
 */
export function readJpsFromSearch(search: string): string | null {
  let raw: string | null = null
  try {
    raw = new URLSearchParams(search).get(JPS_PARAM)
  } catch {
    return null
  }
  if (raw === null) return null
  if (raw.length > JPS_PARAM_MAX_LEN) return null
  const code = raw.trim()
  return code === '' ? null : code
}

/**
 * 去掉 `jps` / `src` 参数后的查询串（没有别的参数时返回空串，调用方拼回 `pathname`）。
 *
 * 为什么要清掉：不清的话用户**一刷新就又被打回示例**，
 * 他在应用里改的那几笔全白改 —— 而且会以为"链接参数根本没生效"。
 */
export function withoutJpsParam(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(JPS_PARAM)
  params.delete(SRC_PARAM)
  const rest = params.toString()
  return rest === '' ? '' : `?${rest}`
}

/** ------------------------------------------------------------------ */
/* adj1191（P1）：`?src=<站内 .jps 地址>` —— 曲库详情页的「在应用里编辑」 */
/* ------------------------------------------------------------------ */

/** 地址长度上限（不是源码长度；URL 不该长到离谱） */export const SRC_URL_MAX_LEN = 2048

/** 下载上限：512KB（正常 `.jps` 只有几 KB；超过基本是拿错了文件） */
export const SRC_MAX_BYTES = 512 * 1024

/**
 * 从查询串里取 `.jps` 的地址；只做**粗筛**（协议 / 长度），真正的同源判断在
 * `fetchJpsFromUrl()` 里用真实 `location` 再做一次。
 *
 * 为什么不在这个纯函数里判同源：它要在 Node 冒烟里直接跑，不能读 `window`；
 * 而"相对地址 `/scores/...`"必须由浏览器解析成绝对地址。
 */
export function readSrcFromSearch(search: string): string | null {
  let raw: string | null = null
  try {
    raw = new URLSearchParams(search).get(SRC_PARAM)
  } catch {
    return null
  }
  if (raw === null) return null
  const src = raw.trim()
  if (src === '' || src.length > SRC_URL_MAX_LEN) return null
  // 协议相对地址（`//evil.com`）不接受：它看起来像站内路径，实际是另一个域
  if (src.startsWith('//')) return null
  if (src.startsWith('/')) return src
  if (/^https:\/\//i.test(src)) return src
  // 只有本机开发地址允许 http（生产站点一律 https）
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(src)) return src
  return null
}

/**
 * 这个地址能不能读。判据（**宁严勿松**）：
 *  · `https:` —— 可以（跨域要对方给 CORS，失败会明确报错）；
 *  · `http:` —— 只允许**同源**（开发服务器）或 localhost/127.0.0.1；
 *  · 其它协议（`javascript:` / `data:` / `file:`）一律拒绝。
 *
 * 纯函数、显式传 base ⇒ 可在 Node 里直接断言。
 */
export function isAllowedJpsSrc(raw: string, baseHref: string): boolean {
  try {
    const url = new URL(raw, baseHref)
    if (url.protocol === 'https:') return true
    if (url.protocol !== 'http:') return false
    const base = new URL(baseHref)
    if (url.origin === base.origin) return true
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

/**
 * 把 `?src=` 指向的 `.jps` 读成文本。
 *
 * 读回来之后**仍然走 `docStore.importSource`**（与 `?jps=` 同一条路）：
 * 清洗、清句柄、清来源绑定、标记 dirty，一步都不少。
 */
export async function fetchJpsFromUrl(raw: string, baseHref?: string): Promise<string> {
  const base = baseHref ?? window.location.href
  if (!isAllowedJpsSrc(raw, base)) throw new Error('链接必须是站内地址或 https 地址')
  const url = new URL(raw, base)
  const res = await fetch(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > SRC_MAX_BYTES) throw new Error('文件超过 512KB')
  const text = await res.text()
  if (text.length > SRC_MAX_BYTES) throw new Error('文件超过 512KB')
  if (text.trim() === '') throw new Error('文件是空的')
  return text
}
