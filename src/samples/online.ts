/**
 * samples/online.ts — 应用「打开示例」的线上数据源
 *
 * 列表和源码都从官网 `/scores/index.json` 取：
 *  · samples = tag 含「示例谱」的发布中乐谱；
 *  · library = 其余发布中乐谱。
 *
 * 用户 2026-11-06 口径：线下版也直接取线上内容；断网时用**上次缓存**，
 * 没有缓存就明确提示需要联网，**不再回退到随包内置示例**。
 */
import { brand } from '../brand/tokens'

export interface OnlineScore {
  slug: string
  short: string
  title: string
  subtitle?: string
  composer: string
  tags: string[]
  updatedAt: string
  code: string
}

export interface OnlineScores {
  samples: OnlineScore[]
  library: OnlineScore[]
}

export interface OnlineScoresResult {
  data: OnlineScores
  cached: boolean
  warning: string
}

const CACHE_KEY = 'ijipu.onlineScores.v1'
const DATA_URL = `${brand.siteUrl}/scores/index.json`

function normalizeScore(raw: unknown): OnlineScore | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const code = typeof o.code === 'string' ? o.code : ''
  if (code.trim() === '') return null
  return {
    slug: typeof o.slug === 'string' ? o.slug : '',
    short: typeof o.short === 'string' ? o.short : '',
    title: typeof o.title === 'string' && o.title !== '' ? o.title : '未命名',
    subtitle: typeof o.subtitle === 'string' ? o.subtitle : '',
    composer: typeof o.composer === 'string' ? o.composer : '',
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
    code,
  }
}

function normalizePayload(raw: unknown): OnlineScores | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.samples) || !Array.isArray(o.library)) return null
  const samples = o.samples.map(normalizeScore).filter((s): s is OnlineScore => s !== null)
  const library = o.library.map(normalizeScore).filter((s): s is OnlineScore => s !== null)
  if (samples.length === 0 && library.length === 0) return null
  return { samples, library }
}

function readCache(): { data: OnlineScores; savedAt: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Record<string, unknown> | null
    if (!raw) return null
    const data = normalizePayload(raw.data)
    if (!data) return null
    return { data, savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0 }
  } catch {
    return null
  }
}

function writeCache(data: OnlineScores): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }))
  } catch {
    /* 缓存写不下不影响本次使用 */
  }
}

/** 拉线上列表；失败时用上次缓存；都没有则抛"需要联网" */
export async function loadOnlineScores(): Promise<OnlineScoresResult> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    let res: Response
    try {
      res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = normalizePayload(await res.json())
    if (!data) throw new Error('线上数据格式不对')
    writeCache(data)
    return { data, cached: false, warning: '' }
  } catch {
    const cache = readCache()
    if (cache) {
      const at = cache.savedAt > 0 ? new Date(cache.savedAt).toLocaleString('zh-CN') : '上次'
      return {
        data: cache.data,
        cached: true,
        warning: `无法联网，当前显示上次缓存（${at}）。请联网后重试获取最新内容。`,
      }
    }
    throw new Error('需要联网获取示例谱和乐谱库，请检查网络后重试。')
  }
}
