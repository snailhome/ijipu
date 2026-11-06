/**
 * store/scorePackageImport.ts — 把应用导出的 `.zip` 乐谱包解到工作区
 *
 * 应用侧只负责「运输」：meta.json + README.md + score.jps + assets/**。
 * 这里解析 zip、取标题、校验路径；真正写工作区由对话框按用户确认的目录名完成。
 */
import { readZip } from '../export/zip'

export interface PackageFile {
  path: string
  bytes: Uint8Array
}

export interface ScorePackageContents {
  /** 主标题（meta.title，缺失时回退 score.jps 第一个 B） */
  title: string
  files: PackageFile[]
}

const decoder = new TextDecoder('utf-8')

function firstTitleOf(code: string): string {
  for (const line of code.split(/\r?\n/)) {
    const m = /^\s*B\s*:\s*(.+?)\s*$/.exec(line)
    if (m) return m[1].trim()
  }
  return ''
}

/** 目录名清洗：只去掉文件系统非法字符，不改变正常标题 */
export function safePackageDirName(title: string): string {
  let s = title
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  if (s === '') s = '乐谱包'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = `_${s}`
  return s
}

/** 默认的新目录名：标题 (2)、(3)…… */
export function suggestNewDirName(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base} (${attempt})`
}

/** 读取 zip；缺 meta.json / score.jps 或路径不安全时抛错 */
export function readScorePackage(bytes: Uint8Array): ScorePackageContents {
  const files = readZip(bytes)
  const metaBytes = files.get('meta.json')
  const scoreBytes = files.get('score.jps')
  if (!metaBytes || !scoreBytes) throw new Error('missing-meta-or-score')

  let title = ''
  try {
    const meta = JSON.parse(decoder.decode(metaBytes)) as { title?: unknown }
    if (typeof meta.title === 'string') title = meta.title.trim()
  } catch {
    /* meta 坏了还有 score.jps 的 B 行兜底 */
  }
  if (title === '') title = firstTitleOf(decoder.decode(scoreBytes))

  const out: PackageFile[] = []
  for (const [name, data] of files) {
    if (name.endsWith('/')) continue
    if (name.includes('\\') || name.startsWith('/')) throw new Error('bad-path')
    const parts = name.split('/')
    if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error('bad-path')
    out.push({ path: name, bytes: data })
  }
  return { title: title || '乐谱包', files: out }
}
