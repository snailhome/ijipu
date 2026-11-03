/**
 * scripts/gen-scores.mts — 曲库构建器（adj1190，方案 `docs/SCORE-SHARING-PLAN.md`）
 *
 * 输入：`public/scores/<slug>/meta.json`（+ 同目录 `score.jps`，或 `meta.file` 指向已有 `.jps`）
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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  applyRangeToSvg,
  computeRowTops,
  defaultPageConfig,
  inkBoxOfLayout,
  layoutScore,
  mergeJpsConfig,
  parseJps,
  rangeBox,
  renderScoreToSvg,
  splitParseIssues,
} from '@ijipu/engine'
import { brand } from '../src/brand/tokens'
import { SITE_THEME_KEY, SITE_VARS } from '../src/brand/siteVars'
import { writeZip } from '../src/export/zip'
import { mdToHtml } from '../src/help/markdown'

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const ROOT = process.cwd()
const PUBLIC = join(ROOT, 'public')
const SRC = join(PUBLIC, 'scores')
const DIST = join(ROOT, 'dist')
const SITE = brand.siteUrl.replace(/\/+$/, '')

/** 内容许可（用户 2026-11-03 拍板：只标"记谱/排版"，不加"旋律：公版"那一行） */
const CONTENT_LICENSE = 'CC BY-NC-SA 4.0'

/** `meta.license` 允许值（作品状态，不是内容许可） */
type License = 'PD' | 'ORIGINAL' | 'AUTHORIZED' | 'CC-BY-4.0' | 'CC-BY-NC-SA-4.0' | 'EXCERPT'
const LICENSES: readonly License[] = ['PD', 'ORIGINAL', 'AUTHORIZED', 'CC-BY-4.0', 'CC-BY-NC-SA-4.0', 'EXCERPT']

const LICENSE_LABEL: Record<License, string> = {
  PD: '公版',
  ORIGINAL: '原创',
  AUTHORIZED: '已授权',
  'CC-BY-4.0': 'CC BY 4.0',
  'CC-BY-NC-SA-4.0': 'CC BY-NC-SA 4.0',
  EXCERPT: '教学片段',
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
  'slug',
  'title',
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
  'publishedAt',
  'updatedAt',
])

interface ScoreMeta {
  slug: string
  title: string
  composer: string
  license: License
  source: string
  short: string
  tags?: string[]
  difficulty?: number
  order?: number
  status?: 'published' | 'retired'
  retiredReason?: string
  retiredAt?: string
  excerpt?: string
  card?: 'paper' | 'ink' | 'brand' | 'minimal'
  watermark?: 'corner' | 'tile' | 'none'
  cover?: string
  file?: string
  note?: string
  publishedAt: string
  updatedAt: string
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

function needString(value: unknown, field: string, dir: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`public/scores/${dir}/meta.json 的 ${field} 必须是非空字符串`)
  }
  return value.trim()
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

function readEntries(): Entry[] {
  if (!existsSync(SRC)) fail('找不到 public/scores/')
  const dirs = readdirSync(SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  const entries: Entry[] = []
  const shortOwner = new Map<string, string>()

  for (const dir of dirs) {
    const metaPath = join(SRC, dir, 'meta.json')
    if (!existsSync(metaPath)) fail(`public/scores/${dir}/ 缺少 meta.json`)

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(metaPath, 'utf8'))
    } catch (e) {
      fail(`public/scores/${dir}/meta.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail(`public/scores/${dir}/meta.json 顶层必须是对象`)
    }
    const obj = raw as Record<string, unknown>

    const unknown = Object.keys(obj).filter((k) => !META_KEYS.has(k))
    if (unknown.length > 0) fail(`public/scores/${dir}/meta.json 有未知字段：${unknown.join('、')}`)

    const slug = needString(obj.slug, 'slug', dir)
    if (!/^[a-z0-9-]+$/.test(slug)) fail(`slug「${slug}」只能用小写字母、数字、连字符`)
    if (slug !== dir) fail(`目录名「${dir}」与 slug「${slug}」不一致`)

    const title = needString(obj.title, 'title', dir)
    const composer = needString(obj.composer, 'composer', dir)
    const source = needString(obj.source, 'source', dir)
    const short = needString(obj.short, 'short', dir)
    if (!/^[a-z]{3,6}$/.test(short)) fail(`${slug} 的 short「${short}」必须是 3-6 位小写字母`)
    if (RESERVED_SHORT.has(short)) fail(`${slug} 的 short「${short}」是保留字`)
    const owner = shortOwner.get(short)
    if (owner !== undefined) fail(`短码「${short}」被 ${owner} 和 ${slug} 同时占用`)
    shortOwner.set(short, slug)

    const license = obj.license as License
    if (!LICENSES.includes(license)) fail(`${slug} 的 license 必须是 ${LICENSES.join(' / ')}`)

    const status = obj.status ?? 'published'
    if (status !== 'published' && status !== 'retired') fail(`${slug} 的 status 只能是 published / retired`)
    if (status === 'retired') {
      needString(obj.retiredReason, 'retiredReason', dir)
      if (!isDate(obj.retiredAt)) fail(`${slug} 下架时必须写 retiredAt（YYYY-MM-DD）`)
    }

    if (!isDate(obj.publishedAt)) fail(`${slug} 的 publishedAt 必须是 YYYY-MM-DD`)
    if (!isDate(obj.updatedAt)) fail(`${slug} 的 updatedAt 必须是 YYYY-MM-DD`)

    const tags = obj.tags
    if (tags !== undefined) {
      if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || t.trim() === '')) {
        fail(`${slug} 的 tags 必须是非空字符串数组`)
      }
    }

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
    }

    const meta: ScoreMeta = {
      slug,
      title,
      composer,
      license,
      source,
      short,
      tags: (tags as string[] | undefined)?.map((t) => t.trim()),
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
      publishedAt: obj.publishedAt,
      updatedAt: obj.updatedAt,
    }

    const scorePath = meta.file ? resolve(PUBLIC, '.' + meta.file) : join(SRC, dir, 'score.jps')
    if (!scorePath.startsWith(PUBLIC)) fail(`${slug} 的 file 越出了 public/`)
    if (!existsSync(scorePath)) fail(`${slug} 的谱面文件不存在：${scorePath}`)

    /**
     * 封面：允许 `meta.cover` 覆盖自动封面。
     * 相对路径按"本条目目录"解释（`assets/cover.webp` ⇒ `/scores/<slug>/assets/cover.webp`），
     * 绝对路径原样用；这样以后加作者封面不用改生成器。
     */
    const coverUrl =
      typeof meta.cover === 'string' && meta.cover.trim() !== ''
        ? meta.cover.startsWith('/')
          ? meta.cover
          : `/scores/${slug}/${meta.cover.replace(/^\.\//, '')}`
        : `/scores/${slug}/cover.svg`

    entries.push({
      meta,
      code: readFileSync(scorePath, 'utf8'),
      srcUrl: meta.file ?? `/scores/${slug}/score.jps`,
      pageUrl: `/scores/${slug}/`,
      coverUrl,
      /**
       * adj1191：分享卡由本地脚本生成并提交（CI 里没有 Chrome）⇒ 这里只**检查存在**。
       * 没有就退回站点图标，`og:image` 永远是一个合法 PNG，不会 404。
       */
      ogUrl: existsSync(join(PUBLIC, 'scores', slug, 'og.png')) ? `/scores/${slug}/og.png` : '',
    })
  }

  if (entries.length === 0) fail('public/scores/ 里一个条目都没有')

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
 * 把 `computeRowTops` 的基线 y 聚成"真正的行"。
 *
 * 为什么不能直接取第 1/3 个值：`computeRowTops` 收的是**每个音符的基线**，
 * 倚音/装饰音会比主音高十几像素 ⇒ 直接取 `tops[2]` 可能落在第 1 行的倚音上，
 * 封面就会从某一行中间切断（《茉莉花》第一版就是这样）。
 * 同一行内的值相差不会超过约 2 个字号；行与行之间通常更远。
 */
function clusterRowTops(tops: number[], gap: number): number[] {
  const out: number[] = []
  for (const y of tops) {
    const last = out[out.length - 1]
    if (last === undefined || y - last > gap) out.push(y)
  }
  return out
}

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
  const layout = layoutScore(parsed, cfg)
  const svgs = renderScoreToSvg(layout)
  const page = layout.pages[0]
  if (page === undefined || svgs[0] === undefined) fail(`${meta.slug} 没有排出任何页面`)

  /**
   * 详情页默认显示**裁到墨迹**的版本。
   * 为什么不用整页：4 小节的小星星在 A4 上只占顶部一小条，整页会留一大片白纸，
   * 手机上要滚很久才看到按钮（实测截图就是这个样子）。整页版仍然保留在 `svgs` 里。
   */
  const previewSvgs = svgs.map((svg, i) => {
    const p = layout.pages[i]
    if (p === undefined) return svg
    const ink = inkBoxOfLayout(layout, i)
    const out = rangeBox({ range: 'score', pageW: p.width, pageH: p.height, ink: ink ?? undefined })
    return applyRangeToSvg(svg, out.box)
  })

  /**
   * 封面：取「前两行」，而不是整页墨迹。
   * 整页墨迹对《茉莉花》这种 8 行谱是竖长条，塞进 16:10 的卡片会非常小；
   * 前两行是横的，卡上看得清。行顶来自引擎的 `computeRowTops`（与排版虚线同源）。
   */
  const ink = inkBoxOfLayout(layout, 0)
  const noteSize = cfg.note_size ?? 18
  const rows = clusterRowTops(computeRowTops(layout, noteSize)[0] ?? [], noteSize * 2.2)
  const y0 = Math.max(0, (rows[0] ?? ink?.y ?? 0) - 16)
  /**
   * 裁到"第 3 行行顶再往上 0.6 个字号"：行顶是**基线减 1.1 个字号**，
   * 而数字字形会从基线上方约 1 个字号处开始 ⇒ 正好切在行顶会把下一行的字头切进来
   * （第一版封面上那排"半个 3"就是这么来的）。
   */
  const y1 = Math.min(page.height, (rows[2] ?? ((ink?.y ?? 0) + (ink?.h ?? page.height) + 4)) - noteSize * 0.6)
  const x = Math.max(0, (ink?.x ?? 0) - 6)
  const coverBox = {
    x,
    y: y0,
    w: Math.min((ink?.w ?? page.width) + 12, page.width - x),
    h: Math.max(80, y1 - y0),
  }
  const cover = applyRangeToSvg(svgs[0], coverBox)

  return { entry, svgs, previewSvgs, cover, lines: code.split('\n').length }
}

function licenseBadge(meta: ScoreMeta): string {
  return `<span class="badge license">${esc(LICENSE_LABEL[meta.license])}</span>`
}

function difficultyDots(value: number | undefined): string {
  const n = value ?? 1
  return '●'.repeat(n) + '○'.repeat(Math.max(0, 5 - n))
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
<html lang="zh-CN" data-site-mode="dark">
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
</style>
<script>
try{var m=localStorage.getItem(${JSON.stringify(SITE_THEME_KEY)});document.documentElement.dataset.siteMode=m==='light'?'light':'dark'}catch(e){}
try{if(/[?&]plain=1(?:&|$)/.test(location.search))document.documentElement.dataset.plain='1'}catch(e){}
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
      <a${on('scores')} href="/scores/">乐谱</a>
      <a class="nav-doc" href="/manual/">文档</a>
      <a href="/app/">打开应用</a>
    </nav>
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
  const tags = (meta.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')
  const description = `${meta.title} · ${meta.composer}。用 .jps 脚本写的简谱，可看源码、预览，或在爱记谱里编辑。`
  const note = meta.note ? `<div class="note">${mdToHtml(meta.note)}</div>` : ''
  const title = `${meta.title} · 乐谱 · 爱记谱 iJipu`

  const body = `<body>
${topbarHTML('scores')}
<main class="wrap">
  <header class="page-head">
    <p class="kicker">乐谱 · ${esc(LICENSE_LABEL[meta.license])}</p>
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
    <section>
      <div class="paper">
        ${svgs.join('\n')}
        <span class="site-mark">${esc(SITE.replace(/^https?:\/\//, ''))} · ${esc(brand.author)}</span>
      </div>
      <div class="actions no-plain">
        <a class="btn btn-primary" href="${esc(appHref)}">在应用里编辑</a>
        <a class="btn" href="${esc(srcUrl)}" download>下载 .jps</a>
        <a class="btn" href="/scores/${esc(meta.slug)}/score.zip" download>下载 .zip</a>
        <button class="btn" type="button" id="copy">复制源码</button>
        <a class="btn" href="/scores/">全部乐谱</a>
      </div>
      <p class="copy-note" id="copy-note" aria-live="polite"></p>
    </section>

    <aside class="source">
      <div class="source-head"><span>源码 · ${lines} 行</span><span class="spacer"></span><a href="${esc(srcUrl)}" download>.jps</a></div>
      <pre><code id="src">${esc(code)}</code></pre>
    </aside>
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
  var note = document.getElementById('copy-note');
  var src = document.getElementById('src');
  if (!btn || !src) return;
  var text = src.textContent || '';
  function done(msg) { if (note) note.textContent = msg; }
  function fallback() {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done('已复制源码'); }
    catch (e) { done('复制失败：请长按源码手动复制'); }
    document.body.removeChild(ta);
  }
  btn.addEventListener('click', function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done('已复制源码'); }, fallback);
    } else { fallback(); }
  });
})();
</script>
</body>
</html>`

  return headHTML({
    title,
    description,
    canonical: `${SITE}${entry.pageUrl}`,
    ogImage: entry.ogUrl ? `${SITE}${entry.ogUrl}` : undefined,
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

function listHTML(entries: Entry[]): string {
  const published = entries.filter((e) => e.meta.status !== 'retired')
  const tags: string[] = []
  for (const e of published) for (const t of e.meta.tags ?? []) if (!tags.includes(t)) tags.push(t)
  tags.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  const cards = published
    .map((e) => {
      const { meta } = e
      const search = `${meta.title} ${meta.composer} ${(meta.tags ?? []).join(' ')}`.toLowerCase()
      return `<a class="card" href="${esc(e.pageUrl)}" data-tags="${esc((meta.tags ?? []).join(' '))}" data-search="${esc(search)}">
  <div class="cover"><img src="${esc(e.coverUrl)}" alt="${esc(meta.title)} 的谱面缩略" loading="lazy" width="320" height="200" /></div>
  <div class="card-body">
    <h2 class="card-title">${esc(meta.title)}</h2>
    <p class="card-sub">${esc(meta.composer)}</p>
    <div class="card-tags">${(meta.tags ?? []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <div class="card-foot">${licenseBadge(meta)}${meta.excerpt ? '<span class="tag">片段</span>' : ''}<span>更新 ${esc(meta.updatedAt)}</span></div>
  </div>
</a>`
    })
    .join('\n')

  const chips = tags.map((t) => `<button class="chip" type="button" data-chip="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join('')

  const title = '乐谱 · 爱记谱 iJipu'
  const description = '用 .jps 脚本写的简谱：点开可看源码、预览谱面，或进应用继续编辑。全部为公版 / 原创 / 授权内容。'

  return `${headHTML({ title, description, canonical: `${SITE}/scores/` })}
<body>
${topbarHTML('scores')}
<main class="wrap">
  <header class="page-head">
    <p class="kicker">乐谱库</p>
    <h1>用脚本写的谱</h1>
    <p class="sub">每份都能看到完整的 .jps 源码和渲染效果；想改就点「在应用里编辑」，谱会带过去。</p>
  </header>

  <div class="toolbar">
    <input class="search" id="q" type="search" placeholder="搜索曲名、作者、标签……" aria-label="搜索乐谱" autocomplete="off" />
    <span class="count" id="count">共 ${published.length} 首</span>
  </div>
  <div class="chips" id="chips">${chips}</div>

  <div class="cards" id="cards">
${cards}
  </div>
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
  var active = {};
  function apply() {
    var s = q && q.value ? q.value.trim().toLowerCase() : '';
    var n = 0;
    cards.forEach(function (card) {
      var okS = !s || (card.getAttribute('data-search') || '').indexOf(s) >= 0;
      var list = (card.getAttribute('data-tags') || '').split(' ');
      var okT = Object.keys(active).every(function (t) { return list.indexOf(t) >= 0; });
      var show = okS && okT;
      card.hidden = !show;
      if (show) n++;
    });
    if (count) count.textContent = '共 ' + n + ' 首';
  }
  if (q) q.addEventListener('input', apply);
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var t = chip.getAttribute('data-chip');
      if (active[t]) delete active[t]; else active[t] = 1;
      chip.setAttribute('aria-pressed', active[t] ? 'true' : 'false');
      apply();
    });
  });
  apply();
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

function main(): void {
  mkdirSync(DIST, { recursive: true })

  const entries = readEntries()
  const rendered = entries.map(renderEntry)
  const today = new Date().toISOString().slice(0, 10)

  for (const r of rendered) {
    const { meta } = r.entry
    const dir = join(DIST, 'scores', meta.slug)
    mkdirSync(dir, { recursive: true })
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
        { name: 'score.jps', data: encoder.encode(r.entry.code) },
        { name: 'README.txt', data: encoder.encode(scoreReadme(r.entry)) },
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
  }
  writeFileSync(join(DIST, 'scores', 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')

  console.log(
    `[scores] 完成：${index.count} 首，列表 / 详情 / 封面 / sitemap / 短链 / 版权页已写入 dist/`,
  )
}

main()
