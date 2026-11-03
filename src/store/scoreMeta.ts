/**
 * store/scoreMeta.ts — 乐谱发布信息（`.jps.meta.json` 边车）的读取/保存
 *
 * 与 `.jps.sync.json` 分开：
 *  · `.sync.json` 是对拍/伴奏/卡片等**机器状态**，会被自动写；
 *  · `.meta.json` 是**发布信息**（标题/来源/许可/tags/slug…），供「乐谱信息」菜单
 *    与「导出乐谱包」共用，人工维护。
 *
 * 文件名：`foo.jps` → `foo.jps.meta.json`（与谱同目录）。
 * 桌面/工作区有真实路径时写同目录；网页模式没有文件系统 ⇒ 下载一份，由用户放回同目录。
 */
import { joinPath } from '../export/video/syncDoc'
import { downloadSidecarText, readSidecarText, writeSidecarText } from '../export/video/syncIo'
import { listWorkspaces } from './workspace'
import type { WorkspaceBinding } from './docStore'

export type ScoreMetaLicense = 'PD' | 'ORIGINAL' | 'AUTHORIZED'

export interface ScoreMetaAsset {
  path: string
  role: 'background' | 'watermark' | 'cover'
}

export interface ScoreMetaDoc {
  format?: 'ijipu-score-meta' | 'ijipu-score-package'
  version?: number
  slug: string
  short: string
  title: string
  composer: string
  license: ScoreMetaLicense
  source: string
  tags: string[]
  difficulty?: number
  excerpt?: string
  note?: string
  assets?: ScoreMetaAsset[]
}

export interface LoadedScoreMeta {
  path: string | null
  meta: ScoreMetaDoc | null
}

/** `foo.jps` → `foo.jps.meta.json`；非 .jps 路径（理论上不会）补 `.jps.meta.json` */
export function metaPathOf(jpsPath: string): string {
  return /\.jps$/i.test(jpsPath) ? `${jpsPath}.meta.json` : `${jpsPath}.jps.meta.json`
}

/** 网页模式下载用的文件名 */
export function metaDownloadName(fileName: string): string {
  const base = (fileName || '未命名.jps').replace(/\.jps$/i, '')
  return `${base}.jps.meta.json`
}

/** 当前谱的 meta 边车绝对路径；没有磁盘落点返回 null（与 syncSidecar 同口径） */
export async function resolveMetaPath(
  nativePath: string | null,
  binding: WorkspaceBinding | null,
): Promise<string | null> {
  if (nativePath !== null && nativePath !== '') return metaPathOf(nativePath)
  if (binding === null) return null
  try {
    const list = await listWorkspaces()
    const rec = list.find((r) => r.id === binding.wsId)
    const dir = typeof rec?.dir === 'string' && rec.dir !== '' ? rec.dir : ''
    if (dir === '') return null
    return metaPathOf(joinPath(dir, binding.segs.join('\\')))
  } catch {
    return null
  }
}

function parseMeta(text: string): ScoreMetaDoc | null {
  try {
    const raw = JSON.parse(text) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    if (typeof o.slug !== 'string' || typeof o.title !== 'string') return null
    return {
      format: o.format === 'ijipu-score-package' ? 'ijipu-score-package' : 'ijipu-score-meta',
      version: 1,
      slug: o.slug,
      short: typeof o.short === 'string' ? o.short : '',
      title: o.title,
      composer: typeof o.composer === 'string' ? o.composer : '',
      license:
        o.license === 'PD' || o.license === 'AUTHORIZED' || o.license === 'ORIGINAL'
          ? o.license
          : 'ORIGINAL',
      source: typeof o.source === 'string' ? o.source : '',
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
      ...(typeof o.difficulty === 'number' ? { difficulty: o.difficulty } : {}),
      ...(typeof o.excerpt === 'string' ? { excerpt: o.excerpt } : {}),
      ...(typeof o.note === 'string' ? { note: o.note } : {}),
      ...(Array.isArray(o.assets) ? { assets: o.assets as ScoreMetaAsset[] } : {}),
    }
  } catch {
    return null
  }
}

export async function loadScoreMetaFor(
  nativePath: string | null,
  binding: WorkspaceBinding | null,
): Promise<LoadedScoreMeta> {
  const path = await resolveMetaPath(nativePath, binding)
  if (path === null) return { path: null, meta: null }
  const r = await readSidecarText(path)
  if (!r.ok || r.text === null) return { path, meta: null }
  return { path, meta: parseMeta(r.text) }
}

export type SaveMetaResult =
  | { ok: true; path: string; downloaded?: false }
  | { ok: true; path: null; downloaded: true }
  | { ok: false; error: string }

export async function saveScoreMetaFor(
  nativePath: string | null,
  binding: WorkspaceBinding | null,
  fileName: string,
  meta: ScoreMetaDoc,
): Promise<SaveMetaResult> {
  const text = JSON.stringify({ ...meta, format: 'ijipu-score-meta', version: 1 }, null, 2) + '\n'
  const path = await resolveMetaPath(nativePath, binding)
  if (path !== null) {
    const r = await writeSidecarText(path, text)
    return r.ok ? { ok: true, path } : { ok: false, error: r.error }
  }
  downloadSidecarText(metaDownloadName(fileName), text)
  return { ok: true, path: null, downloaded: true }
}

/** 表单校验；返回中文错误（空串 = 通过） */
export function validateScoreMeta(meta: ScoreMetaDoc): string {
  if (!/^[a-z0-9-]+$/.test(meta.slug)) return 'slug 只能用小写字母、数字、连字符'
  if (!/^[a-z]{3,6}$/.test(meta.short)) return 'short 必须是 3-6 位小写字母'
  if (meta.title.trim() === '') return '标题不能为空'
  if (meta.composer.trim() === '') return '作曲 / 作词不能为空'
  if (meta.source.trim() === '') return '来源不能为空（公版写「传统」/ 授权写授权方）'
  if (!Array.isArray(meta.tags) || meta.tags.some((t) => t.trim() === '')) return 'tags 不能有空项'
  if (meta.difficulty !== undefined && (!Number.isInteger(meta.difficulty) || meta.difficulty < 1 || meta.difficulty > 5)) {
    return '难度只能是 1-5 的整数'
  }
  return ''
}

/** 标题/文件名 → 可用的 slug/short 默认值（中文会退到时间戳） */
export function slugifyMeta(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s !== '' ? s : `score-${Date.now().toString(36)}`
}

export function shortifyMeta(slug: string): string {
  const letters = slug.replace(/[^a-z]/g, '')
  if (letters.length >= 3) return letters.slice(0, 6)
  return `pkg${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 1) || 'x'}`
}

export function todayMeta(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 用描述头/文件名生成默认发布信息 */
export function defaultScoreMeta(titles: string[], authors: string[], fileName: string): ScoreMetaDoc {
  const title = (titles[0] ?? '').trim() || fileName.replace(/\.(jps|md|txt)$/i, '') || '未命名'
  const composer = (authors[0] ?? '').trim() || '佚名'
  const slug = slugifyMeta(fileName.replace(/\.(jps|md|txt)$/i, '') || title)
  return {
    format: 'ijipu-score-meta',
    version: 1,
    slug,
    short: shortifyMeta(slug),
    title,
    composer,
    license: 'ORIGINAL',
    source: '原创',
    tags: [],
    difficulty: undefined,
    excerpt: '',
    note: '',
  }
}
