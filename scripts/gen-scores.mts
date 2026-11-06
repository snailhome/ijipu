/**
 * scripts/gen-scores.mts — 曲库构建器（adj1190，方案 `docs/SCORE-SHARING-PLAN.md`）
 *
 * 输入：`scores-library/<path>/<slug>/meta.json`（发布区镜像；同目录 score.jps）
 *  `public/scores/` 仅保留给应用欢迎页 `?raw` 引用，不再作为站点条目。
 * 输出（全部落在 `dist/`，不写回 `public/`）：
 *
 *   dist/scores/index.html            列表（静态卡片 + 客户端筛选）
 *   dist/scores/<slug>/index.html     详情（谱面 SVG 内联 + 源码 + 复制/下载/进应用）
 *   dist/scores/<slug>/cover.svg      自动封面（第一页裁到墨迹）
 *   dist/scores/index.json            列表数据（以后应用也能读）
 *   dist/copyright/index.html         版权与投诉页
 *   dist/sitemap.xml / robots.txt     收录
 *   dist/_redirects                   短链（`/s/<short>` → 详情页，精确匹配）
 *   dist/404.html                     兜底页
 *
 * ## 为什么是"构建期生成静态 HTML"
 *
 * 曲库要能被搜索、能被微信/QQ 转发、能在抖音/小红书的内置浏览器里秒开。
 * 客户端渲染要等 JS，分享卡也没有内容 ⇒ 这里直接用引擎在 Node 里排版、把 SVG 内联进 HTML。
 * 首屏**不加载引擎、不加载 React**；「在应用里编辑」才跳到 `/app/`。
 *
 * ## 为什么这个脚本单独走一次 Vite 构建
 *
 * 它要 import `@ijipu/engine` 与 `src/brand/*`、`src/help/markdown.ts`（都是 TS + 别名）。
 * 照 `vite.smoke.config.ts` 的老办法：先 `vite build` 打成 CJS，再 `node dist-scores/gen-scores.cjs` 跑。
 *
 * ⚠ 这个文件里的 HTML 全部用**模板字符串**拼；不要在模板字符串的注释里写反引号
 *   （`E-2026-396` 同族：反引号会提前终止字符串，报错行号还指向几百行外）。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import {
  applyRangeToSvg,
  defaultPageConfig,
  highlightModel,
  inkBoxOfLayout,
  JPS_HIGHLIGHT_COLORS,
  JPS_PLAIN_COLORS,
  layoutScore,
  mergeJpsConfig,
  parseJps,
  rangeBox,
  renderScoreToSvg,
  splitParseIssues,
  tempoLabel,
  validateScoreMeta,
  videoPlatformOf,
  SCORE_META_LICENSES,
} from '@ijipu/engine'
import type { OverlayMeta, ScoreMetaDoc, ScoreMetaLicense, ScoreRights } from '@ijipu/engine'
import type { RenderAssets } from '@ijipu/engine'
import { brand } from '../src/brand/tokens'
import { SITE_THEME_KEY, SITE_VARS } from '../src/brand/siteVars'
import { writeZip } from '../src/export/zip'
import { mdToHtml } from '../src/help/markdown'

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const ROOT = process.cwd()
const PUBLIC = join(ROOT, 'public')
/** adj1194：本地乐谱库（工作格式 = 每首一个目录；zip 只在 _inbox/_packages） */
const LIB = join(ROOT, 'scores-library')
const DIST = join(ROOT, 'dist')
const SITE = brand.siteUrl.replace(/\/+$/, '')
/** 内容许可（用户 2026-11-03 拍板：只标"记谱/排版"，不加"旋律：公版"那一行） */
const CONTENT_LICENSE = 'CC BY-NC-SA 4.0'

/** `meta.license` 允许值（作品状态，不是内容许可）—— 模型在引擎，站点只做展示 */
type License = ScoreMetaLicense
const LICENSES: readonly License[] = SCORE_META_LICENSES

const LICENSE_LABEL: Record<License, string> = {
  PD: '公版',
  ORIGINAL: '原创',
  AUTHORIZED: '已授权',
  CC: 'CC',
}

/** 短码保留字：不能和站点将来可能出现的路径打架 */
const RESERVED_SHORT = new Set([
  's',
  'api',
  'admin',
  'scores',
  'score',
  'app',
  'index',
  'sitemap',
  'robots',
  'copyright',
  'manual',
  'syntax',
  'plugin',
  'cli',
  'soundfonts',
  'assets',
  'icons',
  'site',
  'samples',
])

/** 允许的 meta 键（未知键直接报错，防手滑） */
const META_KEYS = new Set([
  'format',
  'version',
  'slug',
  'title',
  'subtitle',
  'composer',
  'license',
  'source',
  'short',
  'tags',
  'difficulty',
  'order',
  'status',
  'retiredReason',
  'retiredAt',
  'excerpt',
  'card',
  'watermark',
  'cover',
  'file',
  'note',
  'videoUrl',
  'videos',
  'publishedAt',
  'updatedAt',
  'assets',
  'overlay',
  'rights',
  'exportedAt',
  'exportedBy',
  'contentHash',
  'importedAt',
  'sourceZip',
])

/** 站点内部用同一份引擎模型；构建时必须已有发布时间/更新时间 */
interface ScoreMeta extends Omit<ScoreMetaDoc, 'publishedAt' | 'updatedAt'> {
  publishedAt: string
  updatedAt: string
}

interface ScoreSource {
  dir: string
  kind: 'public' | 'library'
}

interface EntryAsset {
  /** zip / 页面资源路径（`assets/bg.webp`） */
  path: string
  role: 'background' | 'watermark' | 'cover'
  bytes: Buffer
  mime: string
  w: number
  h: number
}

interface Entry {
  meta: ScoreMeta
  /** 谱面原文 */
  code: string
  /** 下载 / 在应用里打开用的 URL（`/scores/<slug>/score.jps` 或 `meta.file`） */
  srcUrl: string
  /** 页面 URL（相对带尾斜杠） */
  pageUrl: string
  /** 封面 URL */
  coverUrl: string
  /** 分享卡 PNG（本地 `npm run score:og` 生成；没有就用站点图标兜底） */
  ogUrl: string
  /** 来源目录（`public/scores/<slug>` 或 `scores-library/**\/<slug>`） */
  sourceDir: string
  /** 来源：老内容在 public/scores，新的在 scores-library */
  kind: 'public' | 'library'
  /** 背景/水印/封面（按 meta.assets 或 assets/bg.*、assets/wm.* 解析） */
  assets: EntryAsset[]
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function fail(message: string): never {
  console.error(`\n[scores] 构建失败：${message}\n`)
  process.exit(1)
}

function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function writePage(file: string, html: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, html, 'utf8')
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function needString(value: unknown, field: string, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where}/meta.json 的 ${field} 必须是非空字符串`)
  }
  return value.trim()
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

/**
 * adj1196：Node 里没有 canvas，读图片宽高只能看文件头。
 * 只支持包规范允许的 png/jpg/jpeg/webp/gif/bmp；读不出就报错（不静默不画）。
 */
function imageSizeOf(bytes: Buffer, ext: string): { w: number; h: number } | null {
  try {
    if (ext === 'png') {
      if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return null
      return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) }
    }
    if (ext === 'gif') {
      if (bytes.length < 10) return null
      const sig = bytes.toString('ascii', 0, 3)
      if (sig !== 'GIF') return null
      return { w: bytes.readUInt16LE(6), h: bytes.readUInt16LE(8) }
    }
    if (ext === 'bmp') {
      if (bytes.length < 26 || bytes.toString('ascii', 0, 2) !== 'BM') return null
      return { w: Math.abs(bytes.readInt32LE(18)), h: Math.abs(bytes.readInt32LE(22)) }
    }
    if (ext === 'jpg' || ext === 'jpeg') {
      let i = 2
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i += 1
          continue
        }
        const marker = bytes[i + 1]
        i += 2
        if (marker === 0xd8 || marker === 0xd9) continue
        if (i + 2 > bytes.length) return null
        const len = bytes.readUInt16BE(i)
        if (len < 2) return null
        const isSof =
          marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3 ||
          marker === 0xc5 || marker === 0xc6 || marker === 0xc7 ||
          marker === 0xc9 || marker === 0xca || marker === 0xcb ||
          marker === 0xcd || marker === 0xce || marker === 0xcf
        if (isSof) {
          if (i + 7 > bytes.length) return null
          return { w: bytes.readUInt16BE(i + 5), h: bytes.readUInt16BE(i + 3) }
        }
        i += len
      }
      return null
    }
    if (ext === 'webp') {
      if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
        return null
      }
      const chunk = bytes.toString('ascii', 12, 16)
      if (chunk === 'VP8X') {
        const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
        const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
        return { w, h }
      }
      if (chunk === 'VP8L') {
        if (bytes[20] !== 0x2f) return null
        const b1 = bytes[21]
        const b2 = bytes[22]
        const b3 = bytes[23]
        const b4 = bytes[24]
        const w = 1 + (((b2 & 0x3f) << 8) | b1)
        const h = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | (b2 >> 6))
        return { w, h }
      }
      if (chunk === 'VP8 ') {
        return { w: bytes.readUInt16LE(26) & 0x3fff, h: bytes.readUInt16LE(28) & 0x3fff }
      }
      return null
    }
  } catch {
    return null
  }
  return null
}

/** 从 meta.assets 或 assets/bg.*、assets/wm.* 解析实际要画的资源 */
function loadEntryAssets(dir: string, meta: ScoreMeta): EntryAsset[] {
  const out: EntryAsset[] = []
  const seen = new Set<string>()
  const add = (relPath: string, role: EntryAsset['role']): void => {
    const normalized = relPath.replace(/^\.\//, '')
    if (!normalized.startsWith('assets/') || normalized.includes('..')) {
      fail(`${meta.slug} 的 asset 路径必须是 assets/…（不许 ..）：${relPath}`)
    }
    const file = resolve(dir, normalized)
    if (!file.startsWith(dir)) fail(`${meta.slug} 的 asset 越出了条目目录：${relPath}`)
    if (!existsSync(file)) fail(`${meta.slug} 的 asset 不存在：${relPath}`)
    const ext = extname(file).slice(1).toLowerCase()
    if (!IMAGE_EXT.has(ext)) fail(`${meta.slug} 的 asset 扩展名不允许：${relPath}`)
    const bytes = readFileSync(file)
    if (bytes.length > 16 * 1024 * 1024) fail(`${meta.slug} 的 asset 超过 16MB：${relPath}`)
    const size = imageSizeOf(bytes, ext)
    if (!size || size.w <= 0 || size.h <= 0) fail(`${meta.slug} 的 asset 读不出宽高：${relPath}`)
    if (seen.has(normalized)) return
    seen.add(normalized)
    out.push({ path: normalized, role, bytes, mime: IMAGE_MIME[ext] ?? 'application/octet-stream', w: size.w, h: size.h })
  }

  for (const a of meta.assets ?? []) add(a.path, a.role)
  const roles = new Set(out.map((a) => a.role))
  const assetsDir = join(dir, 'assets')
  if (existsSync(assetsDir)) {
    for (const name of readdirSync(assetsDir)) {
      const rel = `assets/${name}`
      if (!roles.has('background') && /^bg\./i.test(name)) {
        add(rel, 'background')
        roles.add('background')
      } else if (!roles.has('watermark') && /^wm\./i.test(name)) {
        add(rel, 'watermark')
        roles.add('watermark')
      }
    }
  }
  return out
}

/** 两套 `--site-*` 变量写成 CSS 声明串（来源 `src/brand/siteVars.ts`，不在这里另抄色值） */
function varsOf(mode: 'dark' | 'light'): string {
  return Object.entries(SITE_VARS[mode])
    .map(([name, value]) => `${name}:${value};`)
    .join('')
}

/* ------------------------------------------------------------------ */
/* 读取与校验                                                          */
/* ------------------------------------------------------------------ */

/** 递归扫库：`_inbox` / `_packages` / `_trash` 与点目录不参与 */
function listLibrarySources(): ScoreSource[] {
  if (!existsSync(LIB)) return []
  const out: ScoreSource[] = []
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      if (d.name.startsWith('_') || d.name.startsWith('.')) continue
      const p = join(dir, d.name)
      if (existsSync(join(p, 'meta.json'))) out.push({ dir: p, kind: 'library' })
      else walk(p)
    }
  }
  walk(LIB)
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

function readEntries(): Entry[] {
  // 站点条目只来自发布区镜像 scores-library；public/scores 只保留给欢迎页 ?raw 引用
  const sources = listLibrarySources()
  if (sources.length === 0) fail('scores-library/ 没有条目（先由乐谱库工具同步发布区）')

  const entries: Entry[] = []
  const shortOwner = new Map<string, string>()
  const slugOwner = new Map<string, string>()

  for (const src of sources) {
    const dir = src.dir
    const where = relative(ROOT, dir).replace(/\\/g, '/')
    const metaPath = join(dir, 'meta.json')
    if (!existsSync(metaPath)) fail(`${where}/ 缺少 meta.json`)

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(metaPath, 'utf8'))
    } catch (e) {
      fail(`${where}/meta.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail(`${where}/meta.json 顶层必须是对象`)
    }
    const obj = raw as Record<string, unknown>

    const unknown = Object.keys(obj).filter((k) => !META_KEYS.has(k))
    if (unknown.length > 0) fail(`${where}/meta.json 有未知字段：${unknown.join('、')}`)
    if (obj.format !== undefined && obj.format !== 'ijipu-score-package') {
      fail(`${where}/meta.json 的 format 只能是 ijipu-score-package`)
    }
    if (obj.version !== undefined && obj.version !== 1) fail(`${where}/meta.json 的 version 只能是 1`)

    const slug = needString(obj.slug, 'slug', where)
    if (!/^[a-z0-9-]+$/.test(slug)) fail(`slug「${slug}」只能用小写字母、数字、连字符（${where}）`)
    if (slug !== basename(dir)) fail(`目录名「${basename(dir)}」与 slug「${slug}」不一致（${where}）`)
    const slugPrev = slugOwner.get(slug)
    if (slugPrev !== undefined) fail(`slug「${slug}」同时出现在 ${slugPrev} 和 ${where}`)
    slugOwner.set(slug, where)

    const title = needString(obj.title, 'title', where)
    const composer = needString(obj.composer, 'composer', where)
    const source = needString(obj.source, 'source', where)
    const short = needString(obj.short, 'short', where)
    if (!/^[a-z0-9]{3,6}$/.test(short)) fail(`${slug} 的 short「${short}」必须是 3-6 位小写字母或数字`)
    if (RESERVED_SHORT.has(short)) fail(`${slug} 的 short「${short}」是保留字`)
    const owner = shortOwner.get(short)
    if (owner !== undefined) fail(`短码「${short}」被 ${owner} 和 ${slug} 同时占用`)
    shortOwner.set(short, slug)

    const license = obj.license as License
    if (!LICENSES.includes(license)) fail(`${slug} 的 license 必须是 ${LICENSES.join(' / ')}`)

    const status = obj.status ?? 'published'
    if (status !== 'published' && status !== 'retired') fail(`${slug} 的 status 只能是 published / retired`)
    if (status === 'retired') {
      needString(obj.retiredReason, 'retiredReason', where)
      if (!isDate(obj.retiredAt)) fail(`${slug} 下架时必须写 retiredAt（YYYY-MM-DD）`)
    }

    if (!isDate(obj.publishedAt)) fail(`${slug} 的 publishedAt 必须是 YYYY-MM-DD`)
    if (!isDate(obj.updatedAt)) fail(`${slug} 的 updatedAt 必须是 YYYY-MM-DD`)

    const tags = obj.tags
    if (tags !== undefined) {
      if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || t.trim() === '')) {
        fail(`${slug} 的 tags 必须是非空字符串数组`)
      }
    } else if (src.kind === 'library') {
      fail(`${slug}：scores-library 的条目必须有 tags（哪怕是空数组）`)
    }
    // 示例谱只出现在首页示例区，不进入网站「乐谱库」列表/详情/短链
    if (Array.isArray(tags) && tags.includes('示例谱')) continue

    const difficulty = obj.difficulty
    if (difficulty !== undefined && (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5)) {
      fail(`${slug} 的 difficulty 必须是 1-5 的整数`)
    }
    const order = obj.order
    if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) {
      fail(`${slug} 的 order 必须是数字`)
    }

    const card = obj.card
    if (card !== undefined && !['paper', 'ink', 'brand', 'minimal'].includes(String(card))) {
      fail(`${slug} 的 card 只能是 paper / ink / brand / minimal`)
    }
    const watermark = obj.watermark
    if (watermark !== undefined && !['corner', 'tile', 'none'].includes(String(watermark))) {
      fail(`${slug} 的 watermark 只能是 corner / tile / none`)
    }

    const file = obj.file
    if (file !== undefined) {
      if (typeof file !== 'string' || !file.startsWith('/') || file.includes('..')) {
        fail(`${slug} 的 file 必须是以 / 开头、相对 public/ 的路径（不许出现 ..）`)
      }
      if (src.kind === 'library') fail(`${slug}：scores-library 的条目必须自带 score.jps，不能用 file 引用`)
    }

    let assets: ScoreMeta['assets']
    if (obj.assets !== undefined) {
      if (!Array.isArray(obj.assets)) fail(`${slug} 的 assets 必须是数组`)
      assets = obj.assets.map((a, i) => {
        if (typeof a !== 'object' || a === null || Array.isArray(a)) fail(`${slug} 的 assets[${i}] 必须是对象`)
        const item = a as Record<string, unknown>
        const path = item.path
        const role = item.role
        if (typeof path !== 'string' || !path.startsWith('assets/') || path.includes('..')) {
          fail(`${slug} 的 assets[${i}].path 必须是 assets/…（不许 ..）`)
        }
        if (role !== 'background' && role !== 'watermark' && role !== 'cover') {
          fail(`${slug} 的 assets[${i}].role 只能是 background / watermark / cover`)
        }
        return { path, role }
      })
    }

    let rights: ScoreRights | undefined
    if (obj.rights !== undefined) {
      if (typeof obj.rights !== 'object' || obj.rights === null || Array.isArray(obj.rights)) {
        fail(`${slug} 的 rights 必须是对象`)
      }
      const r = obj.rights as Record<string, unknown>
      const allowed = new Set([
        'work', 'arrangement', 'notation', 'pdReason', 'rightsHolder', 'evidence',
        'territory', 'commercial', 'ccLicense', 'attribution', 'sourceUrl', 'expires',
      ])
      const unknownRights = Object.keys(r).filter((k) => !allowed.has(k))
      if (unknownRights.length > 0) fail(`${slug} 的 rights 有未知字段：${unknownRights.join('、')}`)
      const isLicense = (v: unknown): v is License =>
        v === 'PD' || v === 'ORIGINAL' || v === 'AUTHORIZED' || v === 'CC'
      if (r.work !== undefined && !isLicense(r.work)) fail(`${slug} 的 rights.work 不合法`)
      if (r.arrangement !== undefined && r.arrangement !== 'NONE' && !isLicense(r.arrangement)) {
        fail(`${slug} 的 rights.arrangement 不合法`)
      }
      if (r.work !== undefined && r.work !== license) fail(`${slug} 的 rights.work 必须与 license 一致`)
      for (const k of ['notation', 'rightsHolder', 'evidence', 'territory', 'ccLicense', 'attribution', 'sourceUrl', 'expires'] as const) {
        if (r[k] !== undefined && typeof r[k] !== 'string') fail(`${slug} 的 rights.${k} 必须是字符串`)
      }
      if (r.commercial !== undefined && typeof r.commercial !== 'boolean') fail(`${slug} 的 rights.commercial 必须是布尔值`)
      const pd = r.pdReason
      if (pd !== undefined && !['author-death', 'public-domain-dedication', 'government', 'cc0', 'other'].includes(String(pd))) {
        fail(`${slug} 的 rights.pdReason 不合法`)
      }
      rights = {
        ...(r.work !== undefined ? { work: r.work } : {}),
        ...(r.arrangement !== undefined ? { arrangement: r.arrangement as ScoreRights['arrangement'] } : {}),
        ...(typeof r.notation === 'string' ? { notation: r.notation } : {}),
        ...(pd !== undefined ? { pdReason: pd as ScoreRights['pdReason'] } : {}),
        ...(typeof r.rightsHolder === 'string' ? { rightsHolder: r.rightsHolder } : {}),
        ...(typeof r.evidence === 'string' ? { evidence: r.evidence } : {}),
        ...(typeof r.territory === 'string' ? { territory: r.territory } : {}),
        ...(typeof r.commercial === 'boolean' ? { commercial: r.commercial } : {}),
        ...(typeof r.ccLicense === 'string' ? { ccLicense: r.ccLicense } : {}),
        ...(typeof r.attribution === 'string' ? { attribution: r.attribution } : {}),
        ...(typeof r.sourceUrl === 'string' ? { sourceUrl: r.sourceUrl } : {}),
        ...(typeof r.expires === 'string' ? { expires: r.expires } : {}),
      }
    }
    if (license === 'CC') {
      if ((rights?.ccLicense ?? '').trim() === '') fail(`${slug} 的 license 为 CC 时必须写 rights.ccLicense`)
      if ((rights?.attribution ?? '').trim() === '' && (rights?.sourceUrl ?? '').trim() === '') {
        fail(`${slug} 的 license 为 CC 时必须写 rights.attribution 或 rights.sourceUrl`)
      }
    }

    let overlay: OverlayMeta | undefined
    if (obj.overlay !== undefined) {
      if (typeof obj.overlay !== 'object' || obj.overlay === null || Array.isArray(obj.overlay)) {
        fail(`${slug} 的 overlay 必须是对象`)
      }
      const o = obj.overlay as Record<string, unknown>
      const numOr = (v: unknown, dflt: number, field: string): number => {
        if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${slug} 的 overlay.${field} 必须是数字`)
        return v
      }
      const boolOr = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt)
      const next: OverlayMeta = {}
      if (typeof o.bg === 'object' && o.bg !== null && !Array.isArray(o.bg)) {
        const b = o.bg as Record<string, unknown>
        next.bg = {
          enabled: boolOr(b.enabled, true),
          scale: numOr(b.scale, 100, 'bg.scale'),
          rotate: numOr(b.rotate, 0, 'bg.rotate'),
          opacity: numOr(b.opacity, 100, 'bg.opacity'),
          offsetX: numOr(b.offsetX, 0, 'bg.offsetX'),
          offsetY: numOr(b.offsetY, 0, 'bg.offsetY'),
        }
      }
      if (typeof o.wm === 'object' && o.wm !== null && !Array.isArray(o.wm)) {
        const w = o.wm as Record<string, unknown>
        if (w.type !== 'text' && w.type !== 'image') fail(`${slug} 的 overlay.wm.type 只能是 text / image`)
        next.wm = {
          enabled: boolOr(w.enabled, true),
          type: w.type,
          ...(typeof w.text === 'string' ? { text: w.text } : {}),
          size: numOr(w.size, 22, 'wm.size'),
          scale: numOr(w.scale, 100, 'wm.scale'),
          rotate: numOr(w.rotate, -45, 'wm.rotate'),
          opacity: numOr(w.opacity, 15, 'wm.opacity'),
          repeat: w.repeat !== false,
          repeatGap: numOr(w.repeatGap, 300, 'wm.repeatGap'),
          offsetX: numOr(w.offsetX, 0, 'wm.offsetX'),
          offsetY: numOr(w.offsetY, 0, 'wm.offsetY'),
        }
      }
      overlay = next.bg !== undefined || next.wm !== undefined ? next : undefined
    }

    const meta: ScoreMeta = {
      slug,
      title,
      subtitle: typeof obj.subtitle === 'string' ? obj.subtitle : undefined,
      composer,
      license,
      source,
      short,
      tags: (tags as string[] | undefined)?.map((t) => t.trim()) ?? [],
      difficulty: difficulty as number | undefined,
      order: order as number | undefined,
      status,
      retiredReason: obj.retiredReason as string | undefined,
      retiredAt: obj.retiredAt as string | undefined,
      excerpt: obj.excerpt as string | undefined,
      card: card as ScoreMeta['card'],
      watermark: watermark as ScoreMeta['watermark'],
      cover: obj.cover as string | undefined,
      file: file as string | undefined,
      note: obj.note as string | undefined,
      videoUrl: typeof obj.videoUrl === 'string' ? obj.videoUrl : undefined,
      videos: Array.isArray(obj.videos) ? (obj.videos as unknown as ScoreMeta['videos']) : undefined,
      assets,
      overlay,
      rights,
      importedAt: obj.importedAt as string | undefined,
      publishedAt: obj.publishedAt,
      updatedAt: obj.updatedAt,
    }

    const engineMetaError = validateScoreMeta(meta)
    if (engineMetaError !== '') fail(`${slug}：${engineMetaError}`)

    const scorePath = meta.file ? resolve(PUBLIC, '.' + meta.file) : join(dir, 'score.jps')
    if (meta.file) {
      if (!scorePath.startsWith(PUBLIC)) fail(`${slug} 的 file 越出了 public/`)
    }
    if (!existsSync(scorePath)) fail(`${slug} 的谱面文件不存在：${scorePath}`)

    const coverUrl =
      typeof meta.cover === 'string' && meta.cover.trim() !== ''
        ? meta.cover.startsWith('/')
          ? meta.cover
          : `/scores/${slug}/${meta.cover.replace(/^\.\//, '')}`
        : `/scores/${slug}/cover.svg`

    const entryAssets = loadEntryAssets(dir, meta)
    if (meta.overlay?.bg?.enabled === true && !entryAssets.some((a) => a.role === 'background')) {
      fail(`${slug} 的 overlay.bg 开启了，但 meta.assets 里没有 background 资源`)
    }
    if (meta.overlay?.wm?.enabled === true && meta.overlay.wm.type === 'image' && !entryAssets.some((a) => a.role === 'watermark')) {
      fail(`${slug} 的 overlay.wm 是 image，但 meta.assets 里没有 watermark 资源`)
    }
    if (meta.overlay?.wm?.enabled === true && meta.overlay.wm.type === 'text' && (meta.overlay.wm.text ?? '').trim() === '') {
      fail(`${slug} 的 overlay.wm 是 text，但 wm.text 为空`)
    }

    entries.push({
      meta,
      code: readFileSync(scorePath, 'utf8'),
      srcUrl: meta.file ?? `/scores/${slug}/score.jps`,
      pageUrl: `/scores/${slug}/`,
      coverUrl,
      ogUrl: existsSync(join(dir, 'og.png')) ? `/scores/${slug}/og.png` : '',
      sourceDir: dir,
      kind: src.kind,
      assets: entryAssets,
    })
  }

  entries.sort((a, b) => {
    const oa = a.meta.order ?? 100
    const ob = b.meta.order ?? 100
    return oa - ob || a.meta.slug.localeCompare(b.meta.slug)
  })

  return entries
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

interface Rendered {
  entry: Entry
  /** 整页 SVG（保留着，以后做「整页」视图用） */
  svgs: string[]
  /** 裁到墨迹的 SVG（详情页默认显示这个：短谱不会留一大片 A4 白纸） */
  previewSvgs: string[]
  cover: string
  lines: number
}

/**
 * 封面 = 详情页预览的**第一页**（裁到墨迹）。
 *
 * 用户 2026-11-03 口径：「卡片里的预览建议使用预览页面的第一页，而不是头两行，
 * 可以看到整体的效果」。所以不再按行裁；卡片容器改成竖版 3:4（见 `scores.css`），
 * 一首 8 行的《茉莉花》能整体看到，而不是只有前两行。
 */
function renderEntry(entry: Entry): Rendered {
  const { meta, code } = entry
  const parsed = parseJps(code)
  const { errors, warnings } = splitParseIssues(parsed)

  if (errors.length > 0) {
    const text = errors.slice(0, 5).map((e) => `第 ${e.line} 行：${e.message}`).join('；')
    fail(`${meta.slug} 的谱面有解析错误：${text}`)
  }
  if (warnings.length > 0) {
    const text = warnings.slice(0, 5).map((w) => `第 ${w.line} 行：${w.message}`).join('；')
    fail(`${meta.slug} 的谱面有告警（站点不发布带告警的谱）：${text}`)
  }

  const cfg = mergeJpsConfig(code, defaultPageConfig)
  const bg = entry.assets.find((a) => a.role === 'background')
  const wm = entry.assets.find((a) => a.role === 'watermark')
  const ov = meta.overlay
  /**
   * adj1196/adj1200（P2c）：资源角色来自 meta.assets，缩放/位置/透明度来自 meta.overlay
   * （应用导出时原样复制 pageConfig）；只靠图片文件会退回默认 100%/居中。
   */
  const effectiveCfg = {
    ...cfg,
    ...(ov?.bg
      ? {
          bgEnabled: ov.bg.enabled,
          bgScale: ov.bg.scale,
          bgRotate: ov.bg.rotate,
          bgOpacity: ov.bg.opacity,
          bgOffsetX: ov.bg.offsetX,
          bgOffsetY: ov.bg.offsetY,
        }
      : {}),
    ...(ov?.wm
      ? {
          wmEnabled: ov.wm.enabled,
          wmType: ov.wm.type,
          wmText: ov.wm.text ?? '',
          wmSize: ov.wm.size,
          wmScale: ov.wm.scale,
          wmRotate: ov.wm.rotate,
          wmOpacity: ov.wm.opacity,
          wmRepeat: ov.wm.repeat,
          wmRepeatGap: ov.wm.repeatGap,
          wmOffsetX: ov.wm.offsetX,
          wmOffsetY: ov.wm.offsetY,
        }
      : {}),
    ...(bg ? { bgEnabled: ov?.bg ? ov.bg.enabled : true, bgImage: bg.path } : {}),
    ...(wm && (!ov?.wm || ov.wm.type === 'image')
      ? { wmEnabled: ov?.wm ? ov.wm.enabled : true, wmType: 'image' as const, wmImage: wm.path }
      : {}),
  }
  const renderAssets: RenderAssets = {}
  if (bg) renderAssets.bg = { href: `data:${bg.mime};base64,${bg.bytes.toString('base64')}`, w: bg.w, h: bg.h }
  if (wm) renderAssets.wm = { href: `data:${wm.mime};base64,${wm.bytes.toString('base64')}`, w: wm.w, h: wm.h }
  const layout = layoutScore(parsed, effectiveCfg)
  const svgs = renderScoreToSvg(layout, bg || wm ? { assets: renderAssets } : undefined)
  const page = layout.pages[0]
  if (page === undefined || svgs[0] === undefined) fail(`${meta.slug} 没有排出任何页面`)

  /**
   * 详情页默认显示**裁到墨迹**的版本。
   * 为什么不用整页：4 小节的小星星在 A4 上只占顶部一小条，整页会留一大片白纸，
   * 手机上要滚很久才看到按钮（实测截图就是这个样子）。整页版仍然保留在 `svgs` 里。
   */
  /**
   * adj1200：有背景/水印（或包里带了 assets/overlay）时**展示整页**——
   * 作者按 A4 页面设置图片的缩放/位置，裁到墨迹会把背景裁掉一大块，看起来像"设置没生效"。
   * 纯谱（无 overlay/assets）仍裁到墨迹，保持原来的紧凑详情页。
   */
  const hasOverlay =
    entry.assets.length > 0 ||
    meta.overlay?.bg?.enabled === true ||
    meta.overlay?.wm?.enabled === true
  const previewSvgs = hasOverlay
    ? svgs
    : svgs.map((svg, i) => {
        const p = layout.pages[i]
        if (p === undefined) return svg
        const ink = inkBoxOfLayout(layout, i)
        const out = rangeBox({ range: 'score', pageW: p.width, pageH: p.height, ink: ink ?? undefined })
        return applyRangeToSvg(svg, out.box)
      })

  /**
   * 封面直接用「预览的第一页」——与详情页看到的是同一份 SVG，不另算一次裁切。
   * （旧版按"前两行"裁，卡片上只剩一个横条；用户要求改成看整体。）
   *
   * 但"第一页"有两种取法，按内容比例选：
   *  · 竖长（墨迹高/宽 ≥ 0.85，如《茉莉花》《送别》）：用**裁到墨迹**的版本，
   *    卡片 3:4 里能放得尽量大；
   *  · 扁平（一行/两行的小谱）：用**整页 A4**，否则裁到墨迹只剩一条横带、上下大片白，
   *    看起来不像"一页谱"。
   */
  const firstCropped = previewSvgs[0] ?? svgs[0]
  const firstInk = inkBoxOfLayout(layout, 0)
  const inkRatio = firstInk === null || firstInk === undefined || firstInk.w <= 0 ? 1 : firstInk.h / firstInk.w
  const cover = inkRatio >= 0.85 ? firstCropped : svgs[0]

  return { entry, svgs, previewSvgs, cover, lines: code.split('\n').length }
}

function licenseBadge(meta: ScoreMeta): string {
  return `<span class="badge license">${esc(LICENSE_LABEL[meta.license])}</span>`
}

/** 卡片页脚的小图标：只占一个字符宽，文字提示放 title */
function cardIcon(kind: 'excerpt' | 'video'): string {
  const label = kind === 'excerpt' ? '片段' : '视频'
  const path =
    kind === 'excerpt'
      ? '<path d="M2 3h12v2H2zm0 4h8v2H2zm0 4h10v2H2z"/>'
      : '<path d="M4 2.5v11l9-5.5z"/>'
  return `<span class="tag card-icon" title="${label}" aria-label="${label}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${path}</svg></span>`
}

function difficultyDots(value: number | undefined): string {
  const n = value ?? 1
  return '●'.repeat(n) + '○'.repeat(Math.max(0, 5 - n))
}

/**
 * adj1192（用户要求）：右侧源码要**用应用同款的脚本高亮颜色**。
 *
 * 规则与颜色都从引擎来（`highlightModel` + `JPS_HIGHLIGHT_COLORS`），不在这里另写一套；
 * 深/浅两套各一份，跟着页面 `data-site-mode` 切。
 */
function highlightCSS(): string {
  const dark = JPS_HIGHLIGHT_COLORS.dark
  const light = JPS_HIGHLIGHT_COLORS.light
  const classes = Object.keys(dark) as (keyof typeof dark)[]
  const darkRules = classes.map((c) => `.hl-${c}{color:${dark[c]}}`).join('')
  const lightRules = classes
    .map((c) => `:root[data-site-mode="light"] .hl-${c}{color:${light[c]}}`)
    .join('')
  return `<style>${darkRules}.hl-plain{color:${JPS_PLAIN_COLORS.dark}}${lightRules}:root[data-site-mode="light"] .hl-plain{color:${JPS_PLAIN_COLORS.light}}</style>`
}

function headHTML(options: {
  title: string
  description: string
  canonical: string
  ogImage?: string
  extra?: string
}): string {
  const { title, description, canonical, extra = '' } = options
  const ogImage = options.ogImage ?? `${SITE}/icons/pwa-512.png`
  return `<!doctype html>
<html lang="zh-CN" data-site-mode="dark" data-theme-key="${esc(SITE_THEME_KEY)}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="icon" type="image/x-icon" href="/icons/Jianpu.ico" />
<link rel="icon" type="image/png" href="/icons/Jianpu.png" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="爱记谱 iJipu" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="${esc(ogImage)}" />
<style>
:root[data-site-mode="dark"]{${varsOf('dark')}}
:root[data-site-mode="light"]{${varsOf('light')}}
html{background:var(--site-bg)}
/* adj1218：旧 scores.css 缓存 / 手机 WebView 下的深色预览兜底（与应用同一套反相） */
html[data-site-mode="dark"] .paper{background:#191a1a!important;--paper-bg:#191a1a;--paper-ink:#1b1b1b}
html[data-site-mode="dark"] .paper svg{filter:invert(1) contrast(.88) brightness(1.03) saturate(1)!important}
html[data-site-mode="dark"] .paper svg rect[data-page-bg]{fill:#fff!important}
html[data-site-mode="dark"] .paper svg text:not([data-overlay]){fill:#1b1b1b!important}
html[data-site-mode="dark"] .paper svg line:not([data-overlay]),
html[data-site-mode="dark"] .paper svg path:not([data-overlay]){stroke:#1b1b1b!important}
html[data-site-mode="dark"] .paper svg path[fill]:not([fill="none"]):not([data-overlay]),
html[data-site-mode="dark"] .paper svg rect:not([data-page-bg]):not([data-overlay]):not([fill="none"]){fill:#1b1b1b!important}
html[data-site-mode="light"] .paper{background:#fff!important}
html[data-site-mode="light"] .paper svg{filter:none!important}
</style>
<script>
try{
  var m=localStorage.getItem(${JSON.stringify(SITE_THEME_KEY)});
  if(m!=='light'&&m!=='dark'){
    try{m=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}catch(e){m='dark'}
  }
  document.documentElement.dataset.siteMode=m;
}catch(e){}
try{if(/[?&]plain=1(?:&|$)/.test(location.search))document.documentElement.dataset.plain='1'}catch(e){}
</script>
<script>
/* adj1193：深浅主题切换（与首页同一个 localStorage 键，回首页也保持一致） */
document.addEventListener('DOMContentLoaded', function () {
  var btn = document.getElementById('theme-toggle');
  if (!btn) return;
  var root = document.documentElement;
  var key = root.getAttribute('data-theme-key') || 'ijipu.site.theme';
  function sync() {
    var light = root.dataset.siteMode === 'light';
    btn.setAttribute('aria-label', light ? '切换深色主题' : '切换浅色主题');
    btn.title = light ? '切换深色主题' : '切换浅色主题';
  }
  sync();
  btn.addEventListener('click', function () {
    var next = root.dataset.siteMode === 'light' ? 'dark' : 'light';
    root.dataset.siteMode = next;
    try { localStorage.setItem(key, next); } catch (e) {}
    sync();
  });
});
</script>
<link rel="stylesheet" href="/scores/scores.css" />
${extra}
</head>`
}

function topbarHTML(active: 'scores' | 'copyright' | ''): string {
  const on = (key: 'scores' | 'copyright') => (active === key ? ' class="nav-on"' : '')
  return `<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/"><img src="/icons/Jianpu.png" alt="" width="26" height="26" /><span>爱记谱 <b>iJipu</b></span></a>
    <nav class="nav">
      <a${on('scores')} href="/scores/">乐谱库</a>
      <a class="nav-doc" href="/manual/">文档</a>
      <a href="/app/">打开应用</a>
    </nav>
    <button class="theme-toggle" id="theme-toggle" type="button" title="切换深浅主题" aria-label="切换深浅主题">
      <span class="ico-sun" aria-hidden="true">🌞</span>
      <span class="ico-moon" aria-hidden="true">🌙</span>
    </button>
  </div>
</header>`
}

function footerHTML(): string {
  return `<footer class="footer">
  <p>记谱 / 排版：${CONTENT_LICENSE} · 商用请联系 <a href="mailto:${esc(brand.authorEmail)}">${esc(brand.authorEmail)}</a></p>
  <p><a href="/scores/">全部乐谱</a> · <a href="/copyright/">版权与投诉</a> · <a href="/">爱记谱 iJipu</a> · 代码 AGPL-3.0</p>
</footer>`
}

function detailHTML(rendered: Rendered): string {
  const { entry, previewSvgs: svgs, lines } = rendered
  const { meta, code, srcUrl } = entry
  /**
   * adj1191（P1）：编辑入口改用 `?src=<.jps 地址>`，不再把整份源码塞进 URL。
   * 好处：不受 8000 字符限制、长谱也能带过去；代价：应用要多发一次同源请求（几 KB）。
   */
  const appHref = `/app/?src=${encodeURIComponent(srcUrl)}`
  const shortUrl = `${SITE}/s/${meta.short}`
  const tags = (meta.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')
  const description = `${meta.title} · ${meta.composer}。用 .jps 脚本写的简谱，可看源码、预览，或在爱记谱里编辑。`
  const note = meta.note ? `<div class="note">${mdToHtml(meta.note)}</div>` : ''
  const videos = videosOf(meta)
  const title = `${meta.title} · 乐谱 · 爱记谱 iJipu`
  /**
   * adj1192（用户要求）：右侧源码用**应用同款语法高亮**（引擎 `highlightModel` 分词，
   * 颜色来自 `JPS_HIGHLIGHT_COLORS`），并加行号。渲染只做"token → span"，不另写规则。
   */
  const hl = highlightModel(code)
  const sourceHtml = hl.lines
    .map((line) => {
      const inner = line.tokens
        .map((t) => (t.cls === 'plain' ? esc(t.text) : `<span class="hl-${t.cls}">${esc(t.text)}</span>`))
        .join('')
      return `<span class="src-line">${inner}</span>`
    })
    .join('\n')

  const body = `<body>
${topbarHTML('scores')}
<main class="wrap">
  <header class="page-head">
    <h1>${esc(meta.title)}</h1>
    <p class="sub">${esc(meta.composer)}</p>
    <div class="meta-row">
      ${licenseBadge(meta)}
      ${meta.excerpt ? `<span class="badge">片段 · ${esc(meta.excerpt)}</span>` : ''}
      <span class="badge">难度 <b class="diff">${difficultyDots(meta.difficulty)}</b></span>
      ${tags}
      <span class="badge">更新于 ${esc(meta.updatedAt)}</span>
    </div>
  </header>

  <div class="layout">
    <div class="paper">
      ${svgs.join('\n')}
      <span class="site-mark"><a href="${esc(SITE)}/">${esc(SITE)}/</a> · ${esc(brand.author)}</span>
    </div>

    <aside class="source">
      <div class="source-head"><span>源码 · ${lines} 行</span><span class="spacer"></span><a href="${esc(srcUrl)}" download>.jps</a></div>
      <pre><code id="src">${sourceHtml}</code></pre>
    </aside>

    <div class="actions no-plain">
      <a class="btn btn-primary" href="${esc(appHref)}">在应用里编辑</a>
      <a class="btn" href="${esc(srcUrl)}" download>下载 .jps</a>
      <a class="btn" href="/scores/${esc(meta.slug)}/score.zip" download>下载 .zip</a>
      ${videos.map((v) => `<a class="btn" href="${esc(v.url)}" target="_blank" rel="noreferrer">${esc(videoLabelOf(v.platform))}</a>`).join('')}
      <button class="btn" type="button" id="copy">复制源码</button>
      <button class="btn" type="button" id="copy-short" title="${esc(meta.short)}" data-short="${esc(meta.short)}">复制短链</button>
    </div>
    <div class="copy-tip" id="copy-tip" role="status" aria-live="polite" hidden></div>
  </div>

  ${note}

  <div class="note no-plain">
    <p><strong>来源：</strong>${esc(meta.source)}</p>
  </div>

  ${footerHTML()}
</main>
<script>
(function () {
  var btn = document.getElementById('copy');
  var shortBtn = document.getElementById('copy-short');
  var tip = document.getElementById('copy-tip');
  var src = document.getElementById('src');
  if (!btn || !src) return;
  var sourceText = src.textContent || '';
  var shortUrl = ${JSON.stringify(shortUrl)};
  var tipTimer = 0;
  function done(msg, isError) {
    if (!tip) return;
    tip.textContent = msg;
    tip.className = 'copy-tip' + (isError ? ' is-error' : '') + ' show';
    tip.hidden = false;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function () {
      tip.className = 'copy-tip';
      setTimeout(function () { tip.hidden = true; }, 180);
    }, 2200);
  }
  function copyText(text, okMsg, failMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(okMsg, false); }
      catch (e) { done(failMsg, true); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(okMsg, false); }, fallback);
    } else {
      fallback();
    }
  }
  btn.addEventListener('click', function () {
    copyText(sourceText, '已复制源码', '复制失败：请长按源码手动复制');
  });
  if (shortBtn) {
    shortBtn.addEventListener('click', function () {
      copyText(shortUrl, '已复制短链', '复制失败：请手动复制地址');
    });
  }
})();
</script>
</body>
</html>`

  return headHTML({
    title,
    description,
    canonical: `${SITE}${entry.pageUrl}`,
    ogImage: entry.ogUrl ? `${SITE}${entry.ogUrl}` : undefined,
    extra: highlightCSS(),
  }) + body
}

function retiredHTML(entry: Entry): string {
  const { meta } = entry
  const title = `${meta.title} · 已下架 · 爱记谱 iJipu`
  return `${headHTML({
    title,
    description: `${meta.title} 已下架。`,
    canonical: `${SITE}${entry.pageUrl}`,
    extra: '<meta name="robots" content="noindex" />',
  })}
<body>
${topbarHTML('scores')}
<main class="wrap">
  <header class="page-head">
    <p class="kicker">乐谱 · 已下架</p>
    <h1>${esc(meta.title)}</h1>
    <p class="sub">这份谱已经下架：${esc(meta.retiredReason ?? '')}（${esc(meta.retiredAt ?? '')}）</p>
  </header>
  <div class="note">
    <p>链接仍然保留，避免分享出去的地址变成 404。原因或授权问题请联系 ${esc(brand.authorEmail)}。</p>
    <p><a href="/scores/">返回全部乐谱</a></p>
  </div>
  ${footerHTML()}
</main>
</body>
</html>`
}

function videosOf(meta: ScoreMeta): { platform: string; url: string }[] {
  if (Array.isArray(meta.videos) && meta.videos.length > 0) {
    return meta.videos.map((v) => ({ platform: v.platform, url: v.url }))
  }
  return meta.videoUrl ? [{ platform: videoPlatformOf(meta.videoUrl), url: meta.videoUrl }] : []
}

function videoLabelOf(platform: string): string {
  if (platform === 'douyin') return '抖音视频'
  if (platform === 'xiaohongshu') return '小红书视频'
  if (platform === 'wechat') return '微信视频'
  return '看视频'
}

function listHTML(entries: Entry[]): string {
  const timeOf = (meta: ScoreMeta): string => meta.importedAt ?? meta.publishedAt ?? meta.updatedAt ?? ''
  const updateTimeOf = (meta: ScoreMeta): string => meta.updatedAt ?? meta.importedAt ?? meta.publishedAt ?? ''
  const published = entries
    .filter((e) => e.meta.status !== 'retired')
    .sort((a, b) => updateTimeOf(b.meta).localeCompare(updateTimeOf(a.meta)) || a.meta.title.localeCompare(b.meta.title, 'zh-Hans-CN'))
  const tags: string[] = []
  for (const e of published) for (const t of e.meta.tags ?? []) if (!tags.includes(t)) tags.push(t)
  tags.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  const cards = published
    .map((e) => {
      const { meta } = e
      const videos = videosOf(meta)
      const header = parseJps(e.code).header
      const titleMeta = [header.key ? `1=${header.key}` : '', tempoLabel(header.tempoNum, header.tempoText)].filter(Boolean).join(' · ')
      const search =
        `${meta.title} ${meta.composer} ${(meta.tags ?? []).join(' ')} ${header.key ?? ''} ${header.meter ?? ''} ${header.tempoNum ?? ''}`.toLowerCase()
      const imported = timeOf(meta)
      const updated = meta.updatedAt ?? ''
      const updatedLabel = updated.length >= 10 ? updated.slice(5) : updated
      return `<a class="card" href="${esc(e.pageUrl)}" data-tags="${esc((meta.tags ?? []).join(' '))}" data-search="${esc(search)}" data-imported="${esc(imported)}" data-updated="${esc(meta.updatedAt)}" data-title="${esc(meta.title)}" data-composer="${esc(meta.composer)}" data-difficulty="${esc(String(meta.difficulty ?? ''))}">
  <div class="cover"><img src="${esc(e.coverUrl)}" alt="${esc(meta.title)} 的谱面缩略" loading="lazy" width="320" height="200" /></div>
  <div class="card-body">
    <h2 class="card-title">${esc(meta.title)}${titleMeta ? `<span class="card-title-meta">${esc(titleMeta)}</span>` : ''}</h2>
    <p class="card-sub">${esc(meta.composer)}</p>
    <div class="card-tags">${(meta.tags ?? []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <div class="card-foot">${licenseBadge(meta)}${meta.short ? `<span class="tag card-short" role="button" tabindex="0" data-short="${esc(meta.short)}" title="点击复制短链链接">s/${esc(meta.short)}</span>` : ''}${meta.excerpt ? cardIcon('excerpt') : ''}${videos.length > 0 ? cardIcon('video') : ''}${updatedLabel ? `<span class="card-updated" title="更新 ${esc(updated)}">${esc(updatedLabel)}</span>` : ''}</div>
  </div>
</a>`
    })
    .join('\n')

  const chips = tags.map((t) => `<button class="chip" type="button" data-chip="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join('')

  const initialPages = Math.max(1, Math.ceil(published.length / 20))
  const pagerHTML = (position: string): string => `<div class="pager pager-${position}">
    <label class="page-size-label">每页
      <select class="page-size" data-page-size aria-label="每页显示卡片数">
        <option value="10">10</option>
        <option value="20" selected>20</option>
        <option value="50">50</option>
        <option value="100">100</option>
      </select>
      张
    </label>
    <span class="page-info" data-page-info>第 1 / ${initialPages} 页</span>
    <button class="chip" data-page-prev type="button">上一页</button>
    <button class="chip" data-page-next type="button">下一页</button>
  </div>`

  const title = '乐谱 · 爱记谱 iJipu'
  const description = '用 .jps 脚本写的简谱：点开可看源码、预览谱面，或进应用继续编辑。全部为公版 / 原创 / 授权内容。'

  return `${headHTML({ title, description, canonical: `${SITE}/scores/` })}
<body>
${topbarHTML('scores')}
<main class="wrap">
  <header class="page-head">
    <h1>码即成，谱自现</h1>
    <p class="sub">每份都能看到完整的 .jps 源码和渲染效果；想改就点「在应用里编辑」，谱会带过去。</p>
  </header>

  <div class="toolbar">
    <input class="search" id="q" type="search" placeholder="搜索曲名、作者、调号、标签……" aria-label="搜索乐谱" autocomplete="off" />
    <span class="count" id="count">共 ${published.length} 首</span>
    <label class="sort-label">排序
      <select class="sort-select" id="sort" aria-label="排序字段">
        <option value="updated" selected>更新时间</option>
        <option value="imported">导入时间</option>
        <option value="title">标题</option>
        <option value="composer">作曲 / 作词</option>
        <option value="difficulty">难度</option>
      </select>
    </label>
    <button class="chip sort-dir" id="sort-dir" type="button" aria-pressed="true">↓ 倒序</button>
  </div>
  <div class="chips" id="chips">${chips}</div>
  ${pagerHTML('top')}

  <div class="cards" id="cards">
${cards}
  </div>
  <div class="copy-tip" id="copy-tip" role="status" aria-live="polite" hidden></div>
  ${pagerHTML('bottom')}
  ${published.length === 0 ? '<p class="empty">还没有收录乐谱。</p>' : ''}
  <noscript><p class="empty">筛选需要 JavaScript；上面的乐谱卡片仍然可以直接打开。</p></noscript>

  ${footerHTML()}
</main>
<script>
(function () {
  var q = document.getElementById('q');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var chips = Array.prototype.slice.call(document.querySelectorAll('[data-chip]'));
  var count = document.getElementById('count');
  var sort = document.getElementById('sort');
  var sortDir = document.getElementById('sort-dir');
  var cardsBox = document.getElementById('cards');
  var pageInfos = Array.prototype.slice.call(document.querySelectorAll('[data-page-info]'));
  var pageSizes = Array.prototype.slice.call(document.querySelectorAll('[data-page-size]'));
  var pagePrevs = Array.prototype.slice.call(document.querySelectorAll('[data-page-prev]'));
  var pageNexts = Array.prototype.slice.call(document.querySelectorAll('[data-page-next]'));
  var active = {};
  var desc = true;
  var page = 1;
  var pageSize = 20;
  var site = ${JSON.stringify(SITE)};
  var copyTip = document.getElementById('copy-tip');
  var copyTipTimer = 0;
  function showCopyTip(message, isError) {
    if (!copyTip) return;
    copyTip.textContent = message;
    copyTip.className = 'copy-tip' + (isError ? ' is-error' : '') + ' show';
    copyTip.hidden = false;
    clearTimeout(copyTipTimer);
    copyTipTimer = setTimeout(function () {
      copyTip.className = 'copy-tip';
      setTimeout(function () { copyTip.hidden = true; }, 180);
    }, 2200);
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showCopyTip('已复制短链：' + text, false);
    } catch (e) {
      showCopyTip('复制短链失败，请手动复制', true);
    }
  }
  function copyShort(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showCopyTip('已复制短链：' + text, false);
      }, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }
  function shortTagOf(target) {
    while (target && target !== document) {
      if (target.classList && target.classList.contains('card-short')) return target;
      target = target.parentNode;
    }
    return null;
  }
  document.addEventListener('click', function (e) {
    var el = shortTagOf(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    copyShort(site + '/s/' + (el.getAttribute('data-short') || ''));
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var el = shortTagOf(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    copyShort(site + '/s/' + (el.getAttribute('data-short') || ''));
  });
  function compareCards(a, b, key) {
    if (key === 'title' || key === 'composer') {
      return (a.getAttribute('data-' + key) || '').localeCompare(b.getAttribute('data-' + key) || '', 'zh-Hans-CN');
    }
    if (key === 'difficulty') {
      return (Number(a.getAttribute('data-difficulty')) || 0) - (Number(b.getAttribute('data-difficulty')) || 0);
    }
    return (a.getAttribute('data-' + key) || '').localeCompare(b.getAttribute('data-' + key) || '');
  }
  function sortCards() {
    if (!sort || !cardsBox) return;
    var key = sort.value;
    cards.sort(function (a, b) {
      var by = compareCards(a, b, key);
      if (by === 0) by = (a.getAttribute('data-title') || '').localeCompare(b.getAttribute('data-title') || '', 'zh-Hans-CN');
      return desc ? -by : by;
    });
    cards.forEach(function (card) { cardsBox.appendChild(card); });
  }
  function apply(reset) {
    if (reset) page = 1;
    sortCards();
    var s = q && q.value ? q.value.trim().toLowerCase() : '';
    var matched = [];
    cards.forEach(function (card) {
      var okS = !s || (card.getAttribute('data-search') || '').indexOf(s) >= 0;
      var list = (card.getAttribute('data-tags') || '').split(' ');
      var okT = Object.keys(active).every(function (t) { return list.indexOf(t) >= 0; });
      if (okS && okT) matched.push(card);
      card.hidden = true;
    });
    var totalPages = Math.max(1, Math.ceil(matched.length / pageSize));
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    var start = (page - 1) * pageSize;
    matched.slice(start, start + pageSize).forEach(function (card) { card.hidden = false; });
    if (count) count.textContent = '共 ' + matched.length + ' 首';
    pageInfos.forEach(function (el) { el.textContent = '第 ' + page + ' / ' + totalPages + ' 页'; });
    pagePrevs.forEach(function (btn) { btn.disabled = page <= 1; });
    pageNexts.forEach(function (btn) { btn.disabled = page >= totalPages; });
  }
  if (q) q.addEventListener('input', function () { apply(true); });
  if (sort) sort.addEventListener('change', function () { apply(true); });
  pageSizes.forEach(function (sel) {
    sel.addEventListener('change', function () {
      pageSize = Number(sel.value) || 20;
      pageSizes.forEach(function (other) { other.value = String(pageSize); });
      apply(true);
    });
  });
  pagePrevs.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (page > 1) { page--; apply(false); }
    });
  });
  pageNexts.forEach(function (btn) {
    btn.addEventListener('click', function () {
      page++; apply(false);
    });
  });
  if (sortDir) sortDir.addEventListener('click', function () {
    desc = !desc;
    sortDir.textContent = desc ? '↓ 倒序' : '↑ 正序';
    sortDir.setAttribute('aria-pressed', desc ? 'true' : 'false');
    apply(true);
  });
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var t = chip.getAttribute('data-chip');
      if (active[t]) delete active[t]; else active[t] = 1;
      chip.setAttribute('aria-pressed', active[t] ? 'true' : 'false');
      apply(true);
    });
  });
  apply(true);

  /**
   * adj1223：卡片封面反相由 JS 按当前主题写死，避免手机旧 CSS 缓存把
   * 浅色主题也套上 invert。JS 的 inline !important 比旧缓存更优先。
   */
  var coverImgs = Array.prototype.slice.call(document.querySelectorAll('.cover img'));
  function syncCoverTheme() {
    var dark = document.documentElement.dataset.siteMode === 'dark';
    coverImgs.forEach(function (img) {
      img.style.setProperty('filter', dark ? 'invert(1) contrast(0.88) brightness(1.03) saturate(1)' : 'none', 'important');
      var cover = img.closest('.cover');
      if (cover) cover.style.setProperty('background', dark ? '#191a1a' : '#fff', 'important');
    });
  }
  syncCoverTheme();
  new MutationObserver(syncCoverTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-site-mode'],
  });
})();
</script>
</body>
</html>`
}

function copyrightHTML(entries: Entry[]): string {
  const title = '版权与投诉 · 爱记谱 iJipu'
  const description = '乐谱的许可说明、来源记录与版权投诉渠道。'
  return `${headHTML({ title, description, canonical: `${SITE}/copyright/` })}
<body>
${topbarHTML('copyright')}
<main class="wrap">
  <header class="page-head">
    <p class="kicker">版权</p>
    <h1>版权与投诉</h1>
    <p class="sub">本站只收录公版、原创或已授权的乐谱；每份谱都标了来源与许可证。</p>
  </header>

  <div class="note">
    <p><strong>许可：</strong>除另有标注外，本站乐谱的<strong>记谱与排版</strong>采用 ${CONTENT_LICENSE}（署名 · 非商业 · 相同方式共享）。
      商用请先联系 ${esc(brand.authorEmail)}。</p>
    <p>旋律本身的状态写在每份谱的「来源」里（例如作者卒年、传统民歌）；本页的许可只覆盖本站的记谱与排版。</p>
    <p>代码（引擎与应用）是 AGPL-3.0，和乐谱内容不是同一套许可。</p>
  </div>

  <h2>投诉</h2>
  <p>如果你是权利人，认为某份谱侵犯了你的权利，请发邮件到
    <a href="mailto:${esc(brand.authorEmail)}">${esc(brand.authorEmail)}</a>，主题写
    <code>【版权投诉】&lt;作品名&gt;</code>。</p>
  <p>请附上：</p>
  <ul>
    <li>页面链接（哪个 URL）；</li>
    <li>你的权利证明（著作权登记、授权文件、出版物信息等）；</li>
    <li>你的联系方式。</li>
  </ul>
  <p>我们会在 <strong>48 小时内先下架</strong>，再核实。核实可能更久，但不会让内容一直挂着。</p>

  <h2>收录原则</h2>
  <ul>
    <li><strong>公版</strong>：作者去世满 50 年（中国口径），或传统民歌且无现代编配。</li>
    <li><strong>原创 / 授权</strong>：作者本人或已取得书面授权。</li>
    <li><strong>教学片段</strong>：仍在版权期的作品只放短片段，附来源与购买 / 收听链接，不提供下载。</li>
  </ul>

  <h2>下架记录</h2>
  <p>${entries.some((e) => e.meta.status === 'retired') ? '见各谱页面。' : '暂无。'}</p>

  ${footerHTML()}
</main>
</body>
</html>`
}

function notFoundHTML(): string {
  return `${headHTML({
    title: '页面不存在 · 爱记谱 iJipu',
    description: '这个地址没有对应的页面。',
    canonical: `${SITE}/404.html`,
    extra: '<meta name="robots" content="noindex" />',
  })}
<body>
${topbarHTML('')}
<main class="wrap">
  <header class="page-head">
    <p class="kicker">404</p>
    <h1>这个地址没有页面</h1>
    <p class="sub">可能是链接写错了，或者这份谱已经换了地址。</p>
  </header>
  <div class="actions">
    <a class="btn btn-primary" href="/">回首页</a>
    <a class="btn" href="/scores/">全部乐谱</a>
    <a class="btn" href="/app/">打开应用</a>
  </div>
</main>
</body>
</html>`
}

/** zip 里的说明文件：让别人拿到 zip 也知道来源与许可（不把 `.jps` 变成"来历不明的文件"） */
function scoreReadme(entry: Entry): string {
  const m = entry.meta
  return [
    `曲名：${m.title}`,
    `作曲/作词：${m.composer}`,
    `来源：${m.source}`,
    `许可：记谱 / 排版 ${CONTENT_LICENSE}（商用请联系 ${brand.authorEmail}）`,
    `页面：${SITE}${entry.pageUrl}`,
    '',
    '用「爱记谱 iJipu」打开 score.jps 即可编辑、试听、导出。',
    `应用：${SITE}/app/`,
  ].join('\n') + '\n'
}

function sitemapXML(entries: Entry[], today: string): string {  const pages = ['/', '/app/', '/manual/', '/syntax/', '/plugin/', '/cli/', '/soundfonts/', '/scores/', '/copyright/']
  const rows: string[] = []
  for (const p of pages) rows.push(`  <url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod></url>`)
  for (const e of entries) {
    if (e.meta.status === 'retired') continue
    rows.push(`  <url><loc>${SITE}${e.pageUrl}</loc><lastmod>${e.meta.updatedAt}</lastmod></url>`)
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.join('\n')}
</urlset>
`
}

function redirectsFile(entries: Entry[]): string {
  const manualPath = join(PUBLIC, '_redirects')
  const manual = existsSync(manualPath) ? readFileSync(manualPath, 'utf8').trimEnd() : ''
  const lines = entries.map((e) => {
    const target = e.pageUrl
    return `/s/${e.meta.short} ${target} 301\n/s/${e.meta.short}/ ${target} 301`
  })
  const head = '# 曲库短链（构建期生成；改 meta.json 的 short 后重新构建）'
  return [manual, head, ...lines].filter((s) => s !== '').join('\n') + '\n'
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function readAppScores(): {
  samples: Record<string, unknown>[]
  library: Record<string, unknown>[]
} {
  const rows: Record<string, unknown>[] = []
  for (const src of listLibrarySources()) {
    try {
      const meta = JSON.parse(readFileSync(join(src.dir, 'meta.json'), 'utf8')) as Record<string, unknown>
      if ((meta.status ?? 'published') !== 'published') continue
      const code = readFileSync(join(src.dir, 'score.jps'), 'utf8')
      rows.push({
        slug: String(meta.slug ?? ''),
        short: typeof meta.short === 'string' ? meta.short : '',
        title: String(meta.title ?? ''),
        subtitle: typeof meta.subtitle === 'string' ? meta.subtitle : '',
        composer: String(meta.composer ?? ''),
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        order: typeof meta.order === 'number' ? meta.order : 100,
        updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : '',
        code,
      })
    } catch {
      /* 坏条目已由 readEntries 报错；这里不让应用数据再崩一次 */
    }
  }
  const isSample = (row: Record<string, unknown>): boolean =>
    Array.isArray(row.tags) && row.tags.includes('示例谱')
  return {
    samples: rows.filter(isSample).sort((a, b) => Number(a.order) - Number(b.order)),
    library: rows.filter((row) => !isSample(row)),
  }
}

function main(): void {
  mkdirSync(DIST, { recursive: true })

  const entries = readEntries()
  const rendered = entries.map(renderEntry)
  const today = new Date().toISOString().slice(0, 10)

  for (const r of rendered) {
    const { meta } = r.entry
    const dir = join(DIST, 'scores', meta.slug)
    mkdirSync(dir, { recursive: true })
    /**
     * adj1194：`scores-library/` 不在 `public/` 里，Vite 不会自动复制。
     * 这里把下载与 `?src=` 需要的文件搬进 `dist`；`public/scores/` 的旧条目仍由 Vite 复制。
     */
    if (r.entry.kind === 'library') {
      copyFileSync(join(r.entry.sourceDir, 'score.jps'), join(dir, 'score.jps'))
      copyFileSync(join(r.entry.sourceDir, 'meta.json'), join(dir, 'meta.json'))
      const assetsDir = join(r.entry.sourceDir, 'assets')
      if (existsSync(assetsDir)) cpSync(assetsDir, join(dir, 'assets'), { recursive: true })
      const ogPath = join(r.entry.sourceDir, 'og.png')
      if (existsSync(ogPath)) copyFileSync(ogPath, join(dir, 'og.png'))
    }
    writeFileSync(join(dir, 'cover.svg'), r.cover, 'utf8')
    /**
     * adj1191（P1）：`.jps + README.txt` 的小 zip（store 不压缩；复用 `export/zip.ts`）。
     * 为什么不把图片也打进去：P1 的 8 份谱都没有附属图片；等 P2 的 URL 取图通道上线后，
     * 再把 `assets/**` 一起收进来（那时才需要处理路径与大小）。
     */
    const encoder = new TextEncoder()
    writeFileSync(
      join(dir, 'score.zip'),
      writeZip([
        { name: 'meta.json', data: readFileSync(join(r.entry.sourceDir, 'meta.json')) },
        { name: 'README.md', data: encoder.encode(scoreReadme(r.entry)) },
        { name: 'score.jps', data: encoder.encode(r.entry.code) },
        ...r.entry.assets.map((a) => ({ name: a.path, data: a.bytes })),
      ]),
    )
    writePage(join(dir, 'index.html'), meta.status === 'retired' ? retiredHTML(r.entry) : detailHTML(r))
    console.log(
      `[scores] ${meta.slug}: ${r.svgs.length} 页, ${r.lines} 行源码, 封面 ${meta.status === 'retired' ? '(下架)' : 'ok'}`,
    )
  }

  writePage(join(DIST, 'scores', 'index.html'), listHTML(entries))
  writePage(join(DIST, 'copyright', 'index.html'), copyrightHTML(entries))
  writePage(join(DIST, '404.html'), notFoundHTML())
  writeFileSync(join(DIST, 'sitemap.xml'), sitemapXML(entries, today), 'utf8')
  writeFileSync(
    join(DIST, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`,
    'utf8',
  )
  writeFileSync(join(DIST, '_redirects'), redirectsFile(entries), 'utf8')

  const appScores = readAppScores()
  const index = {
    version: 1,
    site: SITE,
    count: entries.filter((e) => e.meta.status !== 'retired').length,
    scores: entries
      .filter((e) => e.meta.status !== 'retired')
      .map((e) => ({
        slug: e.meta.slug,
        title: e.meta.title,
        composer: e.meta.composer,
        license: e.meta.license,
        source: e.meta.source,
        tags: e.meta.tags ?? [],
        difficulty: e.meta.difficulty ?? 1,
        excerpt: e.meta.excerpt ?? '',
        short: e.meta.short,
        url: e.pageUrl,
        src: e.srcUrl,
        zip: `/scores/${e.meta.slug}/score.zip`,
        cover: e.coverUrl,
        publishedAt: e.meta.publishedAt,
        updatedAt: e.meta.updatedAt,
      })),
    samples: appScores.samples,
    library: appScores.library,
  }
  writeFileSync(join(DIST, 'scores', 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')

  console.log(
    `[scores] 完成：${index.count} 首，列表 / 详情 / 封面 / sitemap / 短链 / 版权页已写入 dist/`,
  )
}

main()
