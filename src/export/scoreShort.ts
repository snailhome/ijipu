/**
 * export/scoreShort.ts — 乐谱包 short 代码的自动生成（纯函数）
 *
 * 站点要求 short 为 3-6 位小写字母。旧实现取 slug 的前 6 个字母，
 * 而应用生成的中文谱 slug 全是 `score-<base36>` 开头 ⇒ 每首都得到 `scorem`。
 *
 * 这里改用 slug 的 FNV-1a 哈希映射成 6 位字母：同一个 slug 稳定不变，
 * 不同 slug 几乎不会撞；真正的“本地已用过”去重由对话框的 localStorage 注册表负责，
 * 不把浏览器状态塞进这个纯函数。
 */

const LETTERS = 26
const CODE_LEN = 6

function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 同一 slug 稳定生成 6 位小写字母；不同 slug 落在 26^6 的空间里 */
export function shortFromSlug(slug: string): string {
  let n = fnv1a(slug)
  let out = ''
  for (let i = 0; i < CODE_LEN; i += 1) {
    out += String.fromCharCode(97 + (n % LETTERS))
    n = Math.floor(n / LETTERS)
  }
  return out
}

/** 在“本地已用过”的集合里找一个不重复的 short；找不到极端情况再退化为追加序号 */
export function uniqueShortFromSlug(slug: string, used: Iterable<string>): string {
  const taken = new Set(used)
  let candidate = shortFromSlug(slug)
  let attempt = 1
  while (taken.has(candidate)) {
    candidate = shortFromSlug(`${slug}#${attempt}`)
    attempt += 1
    if (attempt > 1000) {
      // 26^6 空间下几乎不可能走到；仍给一个合法的 6 位兜底
      candidate = `pkg${String(Date.now()).slice(-3)}`
      break
    }
  }
  return candidate
}

/** 站点校验口径：3-6 位小写字母 */
export function isScoreShort(value: string): boolean {
  return /^[a-z]{3,6}$/.test(value)
}
