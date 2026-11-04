/**
 * store/scoreMeta.ts — 乐谱发布信息（`.jps.meta.json` 边车）的读取/保存
 *
 * 与 `.jps.sync.json` 分开：
 *  · `.sync.json` 是对拍/伴奏/卡片等**机器状态**，会被自动写；
 *  · `.meta.json` 是**发布信息**（标题/来源/许可/tags/slug/rights…），供「乐谱信息」菜单
 *    与「导出乐谱包」共用，人工维护。
 *
 * **字段模型与校验统一在引擎 `@ijipu/engine` 的 `scoreMeta`**（应用、曲库站点、本地工具共用）；
 * 这个文件只负责应用侧的 IO：
 *  · 文件名 `foo.jps` → `foo.jps.meta.json`（与谱同目录）；
 *  · 桌面/工作区有真实路径时写同目录；网页模式没有文件系统 ⇒ 下载一份，由用户放回同目录。
 */
import { parseScoreMeta } from '@ijipu/engine'
import type { ScoreMetaDoc } from '@ijipu/engine'
import { joinPath } from '../export/video/syncDoc'
import { downloadSidecarText, readSidecarText, writeSidecarText } from '../export/video/syncIo'
import { listWorkspaces, readWorkspaceTextById, writeWorkspaceTextById } from './workspace'
import type { WorkspaceBinding } from './docStore'

export type {
  OverlayMeta,
  PdReason,
  ScoreArrangementLicense,
  ScoreMetaAsset,
  ScoreMetaDoc,
  ScoreMetaLicense,
  ScoreRights,
} from '@ijipu/engine'
export {
  defaultScoreMeta,
  normalizeScoreMeta,
  parseScoreMeta,
  shortifyMeta,
  slugifyMeta,
  todayMeta,
  validateScoreMeta,
} from '@ijipu/engine'

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

export async function loadScoreMetaFor(
  nativePath: string | null,
  binding: WorkspaceBinding | null,
): Promise<LoadedScoreMeta> {
  const path = await resolveMetaPath(nativePath, binding)
  if (path === null) {
    // 网页工作区（FSA）没有磁盘路径，但目录句柄能读同目录边车
    if (binding !== null) {
      const text = await readWorkspaceTextById(binding.wsId, metaRelSegsOf(binding))
      return { path: null, meta: text === null ? null : parseScoreMeta(text) }
    }
    return { path: null, meta: null }
  }
  const r = await readSidecarText(path)
  if (!r.ok || r.text === null) return { path, meta: null }
  return { path, meta: parseScoreMeta(r.text) }
}

export type SaveMetaResult =
  | { ok: true; path: string; workspace?: false; downloaded?: false }
  | { ok: true; path: null; workspace: true; downloaded?: false }
  | { ok: true; path: null; downloaded: true }
  | { ok: false; error: string }

/** `binding` 的目录 + 同目录边车文件名（`foo.jps` → `foo.jps.meta.json`） */
function metaRelSegsOf(binding: WorkspaceBinding): string[] {
  const segs = [...binding.segs]
  const last = segs.pop() ?? '未命名.jps'
  return [...segs, metaDownloadName(last)]
}

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
  if (binding !== null) {
    // 网页工作区：目录句柄能写，写的就是 `.jps` 同目录，不再退回"下载到 Downloads"
    try {
      await writeWorkspaceTextById(binding.wsId, metaRelSegsOf(binding), text)
      return { ok: true, path: null, workspace: true }
    } catch (e) {
      return { ok: false, error: `写入工作区失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }
  downloadSidecarText(metaDownloadName(fileName), text)
  return { ok: true, path: null, downloaded: true }
}
