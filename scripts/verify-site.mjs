#!/usr/bin/env node
/**
 * scripts/verify-site.mjs — 官网四页的**实机验证** + 首页素材截图（adj876）
 *
 * 为什么需要它：
 *   `npm run smoke` 是**源码级**断言（快、不依赖浏览器），它能守住"配置指向对不对"，
 *   但守不住"页面打开后到底长什么样"——例如文档页的目录锚点点不动、首页图片 404、
 *   应用挂载失败白屏。这些只有真的用浏览器打开过才知道。
 *
 * 做法（与 `embed-smoke.mjs` 同一套）：
 *   ① 用 `node:http` 起一个只读静态服务托管 `dist/`，**按 Cloudflare Pages 的口径路由**
 *      （目录请求 → 目录下的 `index.html`；带扩展名按文件；越界拒绝）；
 *   ② 用系统 Chrome 的**无头 + CDP** 逐页打开，检查 title / 关键 DOM / 控制台错误与失败请求；
 *   ③ 顺手把首页要用的素材图截出来（`public/site/*.webp` 与 `dist/site/*.webp` 各写一份）。
 *
 * 用法：
 *   npm run build && npm run verify:site
 *   加 `--no-shots` 只验证不截图（CI 里用这个，省时间）
 *   加 `--shots-only` 只截图不验证
 *
 * 产物：
 *   · 提交进仓库的素材：`public/site/{hero,view-*,voice-multi,playback}.webp`、`public/site/og.png`
 *     （`demo-score.webp` 在 adj898 删除 —— 示例区改成现场渲染后它就是多余的了）
 *   · 仅供人工检查的整页图：`dist-site-shots/*.webp`（**不入库**，见 .gitignore）
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, statSync, readFileSync, mkdirSync } from 'node:fs'
import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const SITE_ASSETS = path.join(ROOT, 'public', 'site') // 提交进仓库的素材
const DIST_SHOTS = path.join(ROOT, 'dist-site-shots') // 仅供人工检查（不入库）
/**
 * adj890（用户决定）：仓库**整体开源** ⇒ 对外链接全部指主仓库（不再用单独的发布仓库）。
 * `adj889` 那套"源码私有 ⇒ 指向 `ijipu-releases`"已撤销。
 */
const SITE_REPO = 'https://github.com/snailhome/ijipu'
const SITE_PLUGIN = 'https://github.com/snailhome/obsidian-ijipu'

const ARGS = new Set(process.argv.slice(2))
const DO_SHOTS = !ARGS.has('--no-shots')
const DO_CHECKS = !ARGS.has('--shots-only')

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

let passed = 0
let failed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) passed++
  else {
    failed++
    failures.push(`${name}${detail ? ` ← ${detail}` : ''}`)
  }
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ← ${detail}`}`)
}

// ---------------------------------------------------------------------------
// adj913：文档里「字面反引号」的判据
//
// 由来（用户实测）：文档要"在句子中间显示字面的三个反引号"时只能用**转义写法**
// （`docs/PLUGIN-GUIDE.md` 4 处 / `docs/SYNTAX.md` 2 处，源码里就是「反斜杠 + 反引号」）。
// Obsidian 认这个转义，而站点渲染器**原来不认** ⇒ 网页上把反斜杠原样显示出来、后面还跟着一个代码片。
//
// 判据写成**纯函数**：负对照可以直接把"修之前的渲染结果"（＝文档原文那一行）喂进来，
// 证明判据真的在量东西，而不是形同虚设。
//
// ⚠ 三个反引号用 charCode 拼：本文件里注入页面的 JS 片段是**模板字符串**，
//   模板字符串里（**注释里也不行**）出现反引号会提前终止字符串（E-2026-393/396）。
// ---------------------------------------------------------------------------
const TICK = String.fromCharCode(96)
const TICKS3 = TICK.repeat(3)
/** 「反斜杠 + 反引号」——渲染器没做转义处理时，页面正文里就是它 */
const BSLASH_TICK = '\\' + TICK

/** 判据①：正文文本里有**字面**的 ```jps，且没有「反斜杠 + 反引号」残留 */
function hasLiteralFenceJps(text) {
  if (typeof text !== 'string') return false
  return text.includes(TICKS3 + 'jps') && !text.includes(BSLASH_TICK)
}

/** 判据②：页面上有**行内**代码片（`<code>` 且不在 `<pre>` 里）、文本逐字是 `.jps` */
function hasInlineCodeJps(codes) {
  return Array.isArray(codes) && codes.some((c) => !c.inPre && c.text === '.jps')
}

/** 判据②的**放宽版**（只给负对照用）：只要有 `<code>` 就算 */
function hasAnyCode(codes) {
  return Array.isArray(codes) && codes.length > 0
}

/** 红灯时说明"到底坏在哪"：给出残留位置，或"整页都没有字面围栏" */
function fenceDetail(text) {
  const s = typeof text === 'string' ? text : ''
  const i = s.indexOf(BSLASH_TICK)
  if (i >= 0) return `残留「反斜杠+反引号」@${i}：…${s.slice(Math.max(0, i - 24), i + 24)}…`
  return `没有字面的 ${TICKS3}jps`
}

/**
 * 负对照用的样本：**文档原文**里含「反斜杠 + 反引号」的那几行。
 * 它们就是"渲染器不做转义处理"时页面正文里会出现的文本
 * （`esc()` 只动 `& < >`，反斜杠原样输出）⇒ 判据①必须为**假**。
 */
function rawEscapedLines(relPath) {
  return readFileSync(path.join(ROOT, relPath), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes(BSLASH_TICK))
}
/**
 * 文档页 → 它的 md 源文件。**这是唯一一张表**（adj914 起）：下面的转义断言与负对照
 * 都从这里**自动发现**要查哪些页 —— 不再"按页写死 `if (url === '/plugin/' || …)`"。
 * 于是将来 `/manual/` 或新文档页用了转义写法，**不用回来改断言就自动被守住**。
 */
const DOC_PAGE_MD = {
  '/manual/': 'docs/USER-GUIDE.md',
  '/syntax/': 'docs/SYNTAX.md',
  '/plugin/': 'docs/PLUGIN-GUIDE.md',
  /* adj948：新增 `/cli/` 命令行手册（正文就是随安装包发布的那一份手册） */
  '/cli/': 'docs/CLI-手册.md',
  /* adj1026（用户要求「音色库推荐不放首页，窄屏表格效果不佳」）：独立页，正文不用表格 */
  '/soundfonts/': 'docs/SOUNDFONTS.md',
}
const RAW_ESCAPED_LINES = Object.fromEntries(
  Object.entries(DOC_PAGE_MD).map(([url, rel]) => [url, rawEscapedLines(rel)]),
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 静态服务（按 Cloudflare Pages 的口径）
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.jps': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

/** 把 URL 路径映射到 dist 下的实际文件（目录 → index.html；无扩展名也试 index.html） */
function resolveDistFile(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0])
  if (p.endsWith('/')) p += 'index.html'
  const abs = path.join(DIST, p)
  // 越界保护：必须仍在 dist 内（`..` 之类一律拒绝）
  if (!abs.startsWith(DIST + path.sep)) return null
  if (existsSync(abs) && statSync(abs).isFile()) return abs
  // `/app` 这种没带尾斜杠的：Pages 会 308 到 `/app/`，这里直接给出它的 index.html
  if (!path.extname(abs) && existsSync(path.join(abs, 'index.html'))) return path.join(abs, 'index.html')
  return null
}

/** og 分享卡片：用 Chrome 渲染一张 1200×630 的卡片（比 PIL 拼图更可控、也更好看） */
function ogCardHtml(heroDataUri) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:1200px;height:630px;background:#0F1526;color:#E8ECF8;overflow:hidden;
       font-family:system-ui,"Microsoft YaHei",sans-serif;
       background-image:radial-gradient(900px 420px at 88% -10%,rgba(0,240,255,.20),transparent 62%),
                        radial-gradient(700px 380px at 4% 108%,rgba(30,42,94,.95),transparent 60%)}
  .wrap{display:flex;height:100%;padding:56px 60px;gap:44px;align-items:center}
  .left{flex:1 1 auto;min-width:0}
  .brand{display:flex;align-items:center;gap:12px;font-size:24px;color:#93A0C8;margin-bottom:22px}
  .brand b{color:#00F0FF}
  h1{font-size:74px;letter-spacing:.05em;line-height:1.16;
     background:linear-gradient(96deg,#fff 22%,#00F0FF 104%);-webkit-background-clip:text;background-clip:text;color:transparent}
  p.sub{margin-top:20px;font-size:25px;line-height:1.6;color:#93A0C8}
  .meta{margin-top:30px;font-size:20px;color:#5A6A99}
  .right{flex:0 0 400px;height:330px;border:1px solid #24315E;border-radius:14px;overflow:hidden;background:#161D3A}
  .right img{width:100%;height:100%;object-fit:cover;object-position:top left}
  </style></head><body><div class="wrap">
    <div class="left">
      <div class="brand"><img src="/icons/Jianpu.png" width="34" height="34" alt=""> 爱记谱 <b>iJipu</b></div>
      <h1>码即成，谱自现</h1>
      <p class="sub">用文本写简谱：左边敲代码，右边立刻出谱。<br>实时试听、一键导出，免安装、免费开源。</p>
      <div class="meta">ijipu.pages.dev · Windows 桌面版 · Obsidian 插件</div>
    </div>
    <div class="right">${heroDataUri ? `<img src="${heroDataUri}" alt="">` : ''}</div>
  </div></body></html>`
}

// ---------------------------------------------------------------------------
// 极简 CDP over WebSocket（Node 22 内置 WebSocket）—— 与 embed-smoke.mjs 同一套
// ---------------------------------------------------------------------------
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const events = []
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res())
    ws.addEventListener('error', (e) => rej(new Error(`WS 连接失败: ${e.message ?? e.type}`)))
  })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(JSON.stringify(msg.error)))
      else res(msg.result)
    } else if (msg.method) {
      events.push(msg)
    }
  })
  return {
    ready,
    events,
    send(method, params = {}) {
      const mid = ++id
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej })
        ws.send(JSON.stringify({ id: mid, method, params }))
        setTimeout(() => {
          if (pending.has(mid)) {
            pending.delete(mid)
            rej(new Error(`CDP 超时: ${method}`))
          }
        }, 30000)
      })
    },
    close: () => ws.close(),
  }
}

async function evalJs(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  }
  return r.result.value
}

// ---------------------------------------------------------------------------
// 截图用的谱面（都用仓库里**已经有断言守着**的示例——避免截图里出现语法错误提示）
// ---------------------------------------------------------------------------
const SONG_SONG = String(readFileSync(path.join(ROOT, 'public', 'samples', '送别.jps'), 'utf8'))
/**
 * 首页示例区的**预置源码**（adj898 起就是《小星星》，原来的"最小示例"一行谱已被替换）。
 *
 * ⚠ 必须与 `src/landing/samples.ts` 的 `BRAND_SAMPLES[0]` **逐字一致** ——
 * 用户第一眼看到的、和点第一个示例按钮得到的，应当是同一段。
 * 那条一致性由 smoke 的 `[164]` 段守着（verify 是独立脚本，读不了 TS 模块）。
 */
const HOME_SAMPLE_STARS = [
  'B: 小星星',
  'D: C',
  'P: 4/4',
  "Q: 1 1 5 5 | 6 6 5 - | 4 4 3 3 | 2 2 1 - ||",
  'C: 一 闪 一 闪 亮 晶 晶 满 天 都 是 小 星 星',
].join('\n') + '\n'
/** 多声部/临时段（取自 docs/SYNTAX.md §2.12 的示例，smoke 有"文档示例零错误"的断言） */
const SONG_DSB = "V: 1.0\nB: 临时多声部\nD: C\nP: 4/4\nQ: 3 4 | {dsb 1 2 3 4 | 5 6 7 1'} 5 6 7 1' | 1' 7 6 5 | 5 5\n"
/** Obsidian 示意图里的谱（取自 obsidian-ijipu 的 README 示例，短、歌词好认） */
const SONG_TIGER =
  'V: 1.0\nB: 两只老虎\nZ: 法国童谣 词曲\nD: C\nP: 4/4\nJ: 120\nQ: 1 2 3 1 | 1 2 3 1 | 3 4 5 - | 3 4 5 - |\nC: 两 只 老 虎 两 只 老 虎 跑 得 快 跑 得 快\n'

/**
 * Obsidian 插件示意图（adj877）。
 *
 * **诚实说明**：本机没有 Obsidian，所以窗口外壳（侧栏、笔记正文、代码块）是我用 HTML/CSS 画的；
 * 但**谱面部分是把引擎真实渲染出的 SVG 内联进来的**——不是画的、也不是贴图。
 * 这样既不用假装有真截图，又能保证"插件里长什么样"这件事是可信的。
 */
function obsidianCardHtml(scoreSvg, theme) {
  /** 代码块围栏：`String.fromCharCode(96)` 拼出来，避免在本文件的模板字符串里写出反引号字面量 */
  const FENCE = String.fromCharCode(96).repeat(3)
  /**
   * 两套配色（adj881）。
   * 跟的是 **Obsidian 自己的深浅主题**，不是 iJipu 官网的主题——但这张图要贴在官网首页上，
   * 官网切浅色时留一张深色截图会很跳，所以两套都出一份、由 `applyShots()` 跟着换。
   * 写成 CSS 变量注入到 `<body style>`：样式表里只留 `var(--ob-*)`，加/改配色不必动 CSS。
   */
  const palette =
    theme === 'light'
      ? {
          bg: '#ffffff', side: '#f6f6f6', border: '#e3e5e8', text: '#2e3338', dim: '#8b8f95',
          file: '#4b5058', cur: '#e8e9eb', curText: '#1a1a1a', h1: '#1a1a1a',
          code: '#f5f6f7', codeBorder: '#e3e5e8', codeText: '#3c4149', fence: '#7c3aed',
        }
      : {
          bg: '#1e1e1e', side: '#262626', border: '#333333', text: '#dcddde', dim: '#8a8a8a',
          file: '#b9b9b9', cur: '#333333', curText: '#ffffff', h1: '#e8e8e8',
          code: '#1a1a1a', codeBorder: '#2f2f2f', codeText: '#cfcfcf', fence: '#a882ff',
        }
  const vars = Object.entries(palette)
    .map(([k, v]) => `--ob-${k}:${v}`)
    .join(';')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:1200px;height:780px;overflow:hidden;background:var(--ob-bg);color:var(--ob-text);
       font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:14px}
  .win{display:flex;height:100%}
  .side{width:196px;flex:0 0 196px;background:var(--ob-side);border-right:1px solid var(--ob-border);padding:14px 10px}
  .side .vault{font-size:12px;color:var(--ob-dim);padding:0 6px 12px;letter-spacing:.04em}
  .side .f{padding:5px 8px;border-radius:5px;color:var(--ob-file);font-size:13px}
  .side .f.on{background:var(--ob-cur);color:var(--ob-curText)}
  .main{flex:1;min-width:0;padding:30px 44px;overflow:hidden}
  .main h1{font-size:25px;color:var(--ob-h1);margin-bottom:12px}
  .main p{color:var(--ob-file);line-height:1.8;margin-bottom:12px}
  .cb{background:var(--ob-code);border:1px solid var(--ob-codeBorder);border-radius:7px;padding:11px 14px;margin:12px 0;
      font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.8;color:var(--ob-codeText);white-space:pre}
  .cb .k{color:var(--ob-fence)}
  .score{background:#fff;border-radius:7px;padding:10px 12px;position:relative}
  .score svg{width:100%;height:auto;display:block}
  .play{position:absolute;right:10px;top:10px;background:rgba(0,0,0,.05);border:1px solid rgba(0,0,0,.14);
        border-radius:6px;padding:3px 9px;font-size:12px;color:#333}
  </style></head><body style="${vars}"><div class="win">
    <div class="side">
      <div class="vault">我的音乐笔记</div>
      <div class="f">乐理笔记.md</div>
      <div class="f on">儿歌练习.md</div>
      <div class="f">两只老虎.jps</div>
      <div class="f">送别.jps</div>
    </div>
    <div class="main">
      <h1>儿歌练习</h1>
      <p>记几首简单的儿歌，方便带孩子唱。下面这个代码块由 iJipu 插件渲染成简谱：</p>
      <div class="cb"><span class="k">${FENCE}jps</span>
V: 1.0
B: 两只老虎
D: C
P: 4/4
Q: 1 2 3 1 | 1 2 3 1 | 3 4 5 - | 3 4 5 - |
C: 两只老虎 两只老虎 跑得快 跑得快
<span class="k">${FENCE}</span></div>
      <div class="score"><span class="play">▶ 试听</span>${scoreSvg}</div>
    </div>
  </div></body></html>`
}

async function main() {
  if (!existsSync(DIST)) {
    console.error('[verify-site] 找不到 dist/ —— 先跑 npm run build')
    process.exit(1)
  }
  const chrome = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!chrome) {
    console.error('[verify-site] 未找到 Chrome/Edge —— 跳过（请手动在浏览器里打开 dist/ 验证）')
    process.exit(0)
  }
  mkdirSync(SITE_ASSETS, { recursive: true })
  mkdirSync(DIST_SHOTS, { recursive: true })
  mkdirSync(path.join(DIST, 'site'), { recursive: true })

  let ogHtml = null
  let obsidianHtml = null
  const server = createServer((req, res) => {
    const urlPath = String(req.url ?? '/')
    // 两张"卡片页"（分享卡 / Obsidian 示意图）由本脚本现拼 HTML，不走 dist
    if (urlPath === '/__og' || urlPath === '/__obsidian') {
      const html = urlPath === '/__og' ? ogHtml : obsidianHtml
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(html ?? '<!doctype html><html><body></body></html>')
      return
    }
    const file = resolveDistFile(urlPath)
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('404')
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.end(readFileSync(file))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`

  const profile = path.join(tmpdir(), `ijipu-site-${Date.now()}`)
  const debugPort = 9400 + Math.floor(Math.random() * 120)
  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const cleanup = async (code) => {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
    server.close()
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {})
    process.exit(code)
  }

  let target = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
      if (target) break
    } catch {
      /* 还没起来 */
    }
  }
  if (!target) {
    console.error('[verify-site] ❌ Chrome CDP 未就绪')
    return cleanup(1)
  }

  const c = cdp(target.webSocketDebuggerUrl)
  await c.ready
  await c.send('Runtime.enable')
  await c.send('Log.enable')
  await c.send('Page.enable')
  await c.send('Network.enable')

  /** 当前页面的运行时错误（控制台 error + 未捕获异常 + 本站失败请求） */
  let pageErrors = []
  /** requestId → URL：`Network.loadingFailed` 只给 requestId，没有这张表就查不出是哪个请求失败 */
  const reqUrls = new Map()
  const noteEvents = () => pageErrors.length
  const collectErrors = (from) => {
    const out = []
    for (const m of c.events.slice(from)) {
      if (m.method === 'Network.requestWillBeSent') {
        reqUrls.set(m.params.requestId, m.params.request.url)
        continue
      }
      if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
        const e = m.params.entry
        const u = e.url ?? ''
        /**
         * 网络类控制台错误（`Failed to load resource: …`）**带 url**：
         * 非本站的一律不计——音色库的 CDN 在离网/受限网络下必然失败，
         * 那不是"站点坏了"。真正要抓的是本站资源 404 / 脚本异常（后者没有 url）。
         */
        if (u && !u.startsWith(origin)) continue
        out.push(`[console] ${e.text}${u ? ` ${u}` : ''}`)
      }
      if (m.method === 'Runtime.exceptionThrown') {
        out.push(`[exception] ${m.params?.exceptionDetails?.text ?? ''} ${m.params?.exceptionDetails?.exception?.description ?? ''}`)
      }
      if (m.method === 'Network.loadingFailed' && !m.params?.canceled) {
        // 只看**本站**请求：跨域（音色库 CDN 等）在离网/受限环境必然失败，不是"站点坏了"
        const u = reqUrls.get(m.params.requestId) ?? ''
        if (u.startsWith(origin)) out.push(`[net] ${m.params.errorText} ${u}`)
      }
      if (m.method === 'Network.responseReceived' && (m.params?.response?.status ?? 0) >= 400) {
        const u = m.params.response.url
        if (u.startsWith(origin)) out.push(`[http ${m.params.response.status}] ${u}`)
      }
    }
    return [...new Set(out)]
  }

  const setupShotEnv = (source, name, view) =>
    c.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        if (!localStorage.getItem('__siteShotInit')) {
          localStorage.setItem('__siteShotInit', '1')
          localStorage.setItem('ijipu.draft', ${JSON.stringify(source)})
          localStorage.setItem('ijipu.draftName', ${JSON.stringify(name)})
          localStorage.setItem('ijipu.viewType', ${JSON.stringify(view)})
          /**
           * 关掉**排版辅助虚线**（页边距线、行距线…）。
           * 它们是编辑时的参考线，出现在宣传图里会像"瑕疵"（本轮实测：
           * demo 图裁到墨迹后，虚线仍贯穿整张图——因为它们不是 SVG 元素，
           * 而是盖在预览区上的 HTML 覆盖层，按 SVG 遍历根本筛不掉）。
           * 键的取值口径见 uiStore 的 loadBool：只认 '1'/'true' 为真，故写 '0'。
           */
          localStorage.setItem('ijipu.showGuides', '0')
        }
      } catch (e) {}`,
    })

  const setView = async (view) => {
    await evalJs(c, `localStorage.setItem('ijipu.viewType', ${JSON.stringify(view)})`)
  }
  const reload = async () => {
    await c.send('Page.reload', { ignoreCache: false })
    await sleep(900)
  }
  const viewport = (width, height, dsf) =>
    c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile: false })

  const shoot = async (format, extra = {}) => {
    const r = await c.send('Page.captureScreenshot', { format, fromSurface: true, ...extra })
    return Buffer.from(r.data, 'base64')
  }
  /** 素材图：同时写 `public/site/`（要提交）与 `dist/site/`（首页马上要用） */
  const saveAsset = async (name, buf) => {
    await writeFile(path.join(SITE_ASSETS, name), buf)
    await writeFile(path.join(DIST, 'site', name), buf)
    console.log(`    · public/site/${name}  ${(buf.length / 1024).toFixed(0)} KB`)
  }
  /** 仅供人工检查的整页图 */
  const saveShot = async (name, buf) => {
    await writeFile(path.join(DIST_SHOTS, name), buf)
    console.log(`    · dist-site-shots/${name}  ${(buf.length / 1024).toFixed(0)} KB`)
  }
  /**
   * 首页的插图大多是 `loading="lazy"`（首屏只留 Hero 一张），而懒加载的图**进入视口才会真的去取**。
   * 所以无论是"整页截图"还是"检查有没有破图"，都得先滚到底把它们都触发一遍。
   * 不做这一步会得到两个假象：整页图下半部分是空白；"无破图"断言把没加载当成加载失败。
   *
   * ⚠ 还必须**等 `decode()`**：`img.complete` 只说明"下载完了"，
   *   位图解码是异步的，没解完就截图 ⇒ 截出来是一排**空框**（本轮实测踩到，图上像是"图都没了"）。
   */
  const primeLazyImages = async () => {
    /**
     * ⚠ 必须**分段**滚到底，不能一步 `scrollTo(0, scrollHeight)`：
     * 一步跳过去时中间那些区块**从未进入视口**，`loading="lazy"` 的图压根不会开始下载
     * （本轮实测：一步滚动之后 voice-multi / export 两张图始终是破图）。
     */
    await evalJs(
      c,
      `(async () => {
        const h = document.body.scrollHeight
        for (let y = 0; y <= h; y += 500) {
          window.scrollTo(0, y)
          await new Promise((r) => setTimeout(r, 70))
        }
        window.scrollTo(0, h)
      })()`,
    )
    await evalJs(
      c,
      `(async () => {
        /**
         * ⚠ 每一步等待都要**自带上限**：
         *   ① 轮询「complete」最多 8 秒；
         *   ② 「decode()」必须包一层超时——实测它在个别情况下**永不 resolve**
         *      （已解码过的图 / 懒加载边界），会让整次「Runtime.evaluate」一直挂着，
         *      直到 CDP 自己的 30 秒超时才报错（本轮就是这么炸的）。
         *   ⚠ 本段是**模板字符串**：里面（注释里也算）不能出现反引号，一律用「」。
         */
        const race = (p, ms) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))])
        const t0 = Date.now()
        while (Date.now() - t0 < 8000) {
          if ([...document.images].every((i) => i.complete)) break
          await new Promise((r) => setTimeout(r, 150))
        }
        await Promise.all([...document.images].map((i) => race(i.decode(), 2500)))
        return document.images.length
      })()`,
    )
    await evalJs(c, `window.scrollTo(0, 0)`)
    await sleep(300)
  }

  try {
    /**
     * 注入"上次编辑的谱面"到 localStorage（应用启动时会读它）。
     * ⚠ 必须在**任何模式**下都做：截图要让画面里有真谱面，而验证阶段要靠它断言
     *   "应用确实读到了草稿"（真实场景：关掉浏览器再打开，还在上次那份谱上）。
     *   只放在截图分支里的话，`--no-shots` 模式会拿不到草稿、把一条正常的功能判红。
     */
    await setupShotEnv(SONG_SONG, '送别', 'split')

    // =====================================================================
    // 第一阶段：截图（首页要用的素材先落地，后面验证首页时图片才不是 404）
    // =====================================================================
    if (DO_SHOTS) {
      console.log('[verify-site] 生成素材图…')

      /**
       * ---- 应用界面截图：**深色 / 浅色各截一套**（adj881，用户要求）----
       * 为什么要两套：官网切到浅色主题时插图也要跟着换——图展示的是"应用长什么样"，
       * 应用已经换成浅色主题了、图却还是深色的，就自相矛盾了。
       * 命名约定（与 `landing/main.ts` 的 `applyShots()` 一一对应，改一处要改两处）：
       *   `<名字>.webp`（深色） / `<名字>-light.webp`（浅色）
       * ⚠ 每轮开始**必须**先设 `ijipu.themeMode`——否则两套图会一模一样，
       *   而"两套图长得一样"恰恰是最难一眼看出来的缺陷。
       */
      for (const theme of ['dark', 'light']) {
        const sfx = theme === 'light' ? '-light' : ''
        /**
         * ⚠ 顺序要紧：**先 navigate 再动 localStorage**。
         * Chrome 刚起来时当前页是 `about:blank`，在那里读 localStorage 会抛
         * `SecurityError: Access is denied for this document`（本轮实测踩到）。
         */
        await c.send('Page.navigate', { url: `${origin}/app/` })
        await sleep(1300)
        await evalJs(c, `localStorage.setItem('ijipu.themeMode', ${JSON.stringify(theme)})`)
        await reload()
        await sleep(1300)

        // ---- /app/ 拆分视图 = 首页 Hero（最大的一张，2 倍图） ----
        await viewport(1440, 880, 2)
        await saveAsset(`hero${sfx}.webp`, await shoot('webp', { quality: 82 }))

        // ---- 三个视图的小图（1.6 倍够用，省体积） ----
        for (const [file, view] of [
          ['view-code', 'code'],
          ['view-split', 'split'],
          ['view-preview', 'preview'],
        ]) {
          await setView(view)
          await reload()
          await sleep(700)
          await saveAsset(`${file}${sfx}.webp`, await shoot('webp', { quality: 76 }))
        }
        // 上面的循环结束在 preview 视图，接着用它截多声部示例
        await viewport(1440, 880, 1.6)
        await evalJs(
          c,
          `localStorage.setItem('ijipu.draft', ${JSON.stringify(SONG_DSB)});
           localStorage.setItem('ijipu.draftName', '临时多声部');
           localStorage.setItem('ijipu.viewType', 'preview')`,
        )
        await reload()
        await sleep(900)
        await saveAsset(`voice-multi${sfx}.webp`, await shoot('webp', { quality: 78 }))
        // 状态栏里若带告警，宣传图上会出现一个「⚠」——把原文打出来，好回去修示例谱
        console.log(`    · [${theme}] 状态栏：${await evalJs(c, `(document.querySelector('footer, [class*="status"]')?.textContent ?? '').trim().slice(0, 80)`)}`)

        /**
         * ---- 导出面板 ----
         * ⚠ 这里**不要**去点「试听」：截图环境离网，应用会尝试下载 30MB 音色库，
         *   拍出来的是「正在后台下载音色库…」+ 一条下载失败提示（本轮实测踩过）。
         *   导出面板不依赖网络，展示的信息（PDF/图片/音频各档格式）也更有用。
         * ⚠ 必须先 `Page.navigate` 回 `/app/`：`reload` 重载的是**当前页**，
         *   上一轮循环结束时停在别处就会拍错页面（见 `E-2026-397`）。
         */
        await c.send('Page.navigate', { url: `${origin}/app/` })
        await sleep(900)
        await evalJs(c, `localStorage.setItem('ijipu.draft', ${JSON.stringify(SONG_SONG)})`)
        await reload()
        await sleep(800)
        const opened = await evalJs(
          c,
          `(() => {
            const btns = [...document.querySelectorAll('button, a')]
            const b = btns.find((el) => /导出/.test((el.textContent || '') + (el.title || '') + (el.getAttribute('aria-label') || '')))
            if (!b) return false
            b.click()
            return true
          })()`,
        )
        if (opened) {
          await sleep(1000)
          await evalJs(c, `document.querySelectorAll('.toast').forEach((el) => el.remove())`)
          await sleep(300)
          await saveAsset(`export${sfx}.webp`, await shoot('webp', { quality: 78 }))
        } else {
          console.log(`    · 跳过 export${sfx}.webp（没找到「导出」按钮）`)
        }
      }

      /**
       * ---- 首页 demo 区那张静态谱面图：**adj898 起不再生成** ----
       *
       * 由来：原来首页有一段「一行文本，就是一段旋律」，是"左边源码 + 右边一张截图"。
       * 那张截图（`public/site/demo-score.webp`）是用下面这套办法裁出来的：
       * 临时把《小星星》写进 `ijipu.draft`、切浅色主题、reload，再遍历谱面 SVG 的
       * `text` / `path` 求墨迹并集，剔掉铺满整页的纸张背景与 `stroke-dasharray` 辅助线。
       *
       * adj898（用户要求把两个区块**整合成一个**）：示例区改成**现场用引擎渲染**，
       * 静态图没有存在意义了（而且它只能表现《小星星》这一段，新的 7 个示例它一个都覆盖不了）
       * ⇒ 整套裁图逻辑连同那张图一起删掉。
       *
       * ⚠ 浅色主题那一步不再需要：后面的 og 图直接用首页截图，而首页默认就是深色。
       */

      // 后面的 og 缩略图回到深色主题（与应用默认一致）
      await evalJs(c, `localStorage.setItem('ijipu.themeMode', 'dark')`)

      // ---- og 分享卡片（1200×630）：先把首页截图缩进去当配图 ----
      await viewport(1440, 880, 1)
      await setView('split')
      await evalJs(
        c,
        `localStorage.setItem('ijipu.draft', ${JSON.stringify(SONG_SONG)});
         localStorage.setItem('ijipu.viewType', 'split')`,
      )
      await reload()
      await sleep(900)
      const thumb = await shoot('webp', { quality: 70, clip: { x: 720, y: 60, width: 700, height: 560, scale: 1 } })
      ogHtml = ogCardHtml(`data:image/webp;base64,${thumb.toString('base64')}`)
      await viewport(1200, 630, 1)
      await c.send('Page.navigate', { url: `${origin}/__og` })
      await sleep(800)
      await saveAsset('og.png', await shoot('png'))

      /**
       * ---- Obsidian 插件示意图（adj877，adj881 起出深浅两套）----
       * 谱面从 `/app/` 里**取引擎真实渲染出的 SVG**（`outerHTML`），再内联进"仿笔记"卡片里截图。
       * 于是：窗口是我画的、**乐谱是真的**——比"贴一张来路不明的截图"诚实，也不用假装有 Obsidian。
       * 谱面本身是白底黑字，所以两套图**共用同一份 SVG**，只有卡片外壳的配色不同。
       */
      for (const theme of ['dark', 'light']) {
        const sfx = theme === 'light' ? '-light' : ''
        await viewport(1440, 900, 1.6)
        await evalJs(
          c,
          `localStorage.setItem('ijipu.draft', ${JSON.stringify(SONG_TIGER)});
           localStorage.setItem('ijipu.draftName', '两只老虎');
           localStorage.setItem('ijipu.viewType', 'preview');
           localStorage.setItem('ijipu.themeMode', ${JSON.stringify(theme)})`,
        )
        /**
         * ⚠ 这里必须是 `Page.navigate` 回 `/app/`，**不能** `reload()`：
         * 上一轮已经把页面导航到卡片页（`/__og` 或 `/__obsidian`）了，而 `reload` 重载的是**当前页**
         * ⇒ 会把卡片页再加载一遍，应用一个元素都没有（本轮实测：`svgs:0, text:""`，图被跳过）。
         * localStorage 是同源的，所以"在卡片页上写设置"没问题，问题只在"回哪一页"。
         */
        await c.send('Page.navigate', { url: `${origin}/app/` })
        await sleep(1200)
        /** 轮询等谱面渲染出来（不要只 sleep 一次就取——本轮第一版就是这么"取不到"的） */
        let scoreSvg = ''
        for (let i = 0; i < 20 && !scoreSvg; i++) {
          await sleep(300)
          scoreSvg = await evalJs(
            c,
            `(() => {
              const svgs = [...document.querySelectorAll('#root svg')]
              if (svgs.length === 0) return ''
              return svgs.sort((a, b) => b.querySelectorAll('text').length - a.querySelectorAll('text').length)[0].outerHTML
            })()`,
          )
        }
        if (scoreSvg && scoreSvg.length > 500) {
          obsidianHtml = obsidianCardHtml(scoreSvg, theme)
          await viewport(1200, 780, 1.6)
          await c.send('Page.navigate', { url: `${origin}/__obsidian` })
          await sleep(900)
          await saveAsset(`obsidian${sfx}.webp`, await shoot('webp', { quality: 84 }))
        } else {
          const diag = await evalJs(
            c,
            `JSON.stringify({ svgs: document.querySelectorAll('#root svg').length, len: ${JSON.stringify(scoreSvg.length)}, text: (document.querySelector('#root')?.textContent ?? '').slice(0, 160) })`,
          )
          console.log(`    · 跳过 obsidian${sfx}.webp（取不到谱面 SVG）：${diag}`)
        }
      }

      // ---- 仅供检查：五个页面的整页图（adj948：加入新增的 `/cli/`） ----
      await viewport(1440, 900, 1)
      await c.send('Page.navigate', { url: `${origin}/` })
      await sleep(900)
      await primeLazyImages()
      await saveShot('home.png', await shoot('png', { captureBeyondViewport: true }))
      /* adj948：首页**首屏**（视口图，不含整页）—— 报告里要给用户看的就是这一张 */
      await saveShot('home-first-screen.png', await shoot('png'))

      /**
       * 浅色版首页（**仅供人工检查**）：浅色下最容易出问题的是"对比度"与"深色截图贴在浅底上"，
       * 这两样都不是断言能判的，只能看图。用完把用户选择清掉，别把状态留给后面的断言。
       */
      await evalJs(c, `localStorage.setItem('ijipu.site.theme', 'light')`)
      await c.send('Page.navigate', { url: `${origin}/` })
      await sleep(900)
      await primeLazyImages()
      await saveShot('home-light.png', await shoot('png', { captureBeyondViewport: true }))
      await evalJs(c, `localStorage.removeItem('ijipu.site.theme')`)
      await c.send('Page.navigate', { url: `${origin}/manual/` })
      await sleep(900)
      await saveShot('manual.png', await shoot('png', { captureBeyondViewport: true }))
      await c.send('Page.navigate', { url: `${origin}/syntax/` })
      await sleep(1200)
      await saveShot('syntax.png', await shoot('png', { captureBeyondViewport: true }))
      /* adj905x：插件手册（新增页）的整页图 */
      await c.send('Page.navigate', { url: `${origin}/plugin/` })
      await sleep(1200)
      await saveShot('plugin.png', await shoot('png', { captureBeyondViewport: true }))
      /**
       * adj948：命令行手册（新增页）的整页图 + **首屏图**。
       * 首屏单独拍一张是因为整页图很长（手册 500+ 行），报告里要给人看"页首那段面向访客的引言"
       * 长什么样 —— 那正是本次新增的东西。
       */
      await c.send('Page.navigate', { url: `${origin}/cli/` })
      await sleep(1400)
      /**
       * adj949（用户要求「手册中可以有更多的示例和截图」）：`docs/CLI-手册.md` 正文里嵌了一张
       * **"这一页长什么样"**的截图（`/docs/cli/manual-page.png`，素材就是下面这张 `cli-first-screen.png`）。
       * 出图前先把它摘掉 ⇒① 免得**自己截自己**（图里套图）；② 免得"这张素材还没生成"时截到一个破图。
       * 只影响这两张**仅供人工检查 / 供手册引用**的图，任何断言都不看它们 ✓。
       */
      await evalJs(c, `document.querySelectorAll('#doc-body img').forEach((el) => el.remove())`)
      await saveShot('cli-first-screen.png', await shoot('png'))
      await saveShot('cli.png', await shoot('png', { captureBeyondViewport: true }))
      /**
       * adj911（用户反馈「手机端脚本/预览块会变得很宽」）：**手机视口**下的文档页整页图。
       * 修前这张图长这样：页面宽 4347px、` ```jps ` 块 4327px，一屏只看得到左边一小条。
       * 现在它是"窄屏下脚本/预览块被限制在视口内"的直观证据（顺手点开「预览」让谱面也在图里）。
       */
      await viewport(390, 844, 2)
      await c.send('Page.navigate', { url: `${origin}/syntax/` })
      await sleep(1400)
      /**
       * ⚠ 别用整页图（`captureBeyondViewport`）：390×844 @2x 的整页 PNG 有 **15MB**，
       * 拿来看"块有没有被限制在视口内"也没法看。改成把第一个 ` ```jps ` 块滚到视口中间、
       * 各拍一张 390×844 的**视口图**（脚本 / 预览各一张），体积小、一眼能看清。
       */
      await evalJs(
        c,
        `document.querySelector('#doc-body .jps-block')?.scrollIntoView({ block: 'center', behavior: 'instant' })`,
      )
      await sleep(400)
      await saveShot('syntax-mobile-code.png', await shoot('png'))
      await evalJs(
        c,
        `document.querySelector('#doc-body .jps-block [data-jps-tab="preview"]')?.click()`,
      )
      await sleep(1800)
      await saveShot('syntax-mobile-preview.png', await shoot('png'))
    }

    // =====================================================================
    // 第二阶段：逐页功能验证
    // =====================================================================
    if (DO_CHECKS) {
      // ---------------- 首页 ----------------
      console.log('[verify-site] 验证 `/`（介绍首页）…')
      await viewport(1440, 900, 1)
      pageErrors = []
      let mark = noteEvents()
      await c.send('Page.navigate', { url: `${origin}/` })
      await sleep(1200)
      await primeLazyImages()
      const home = await evalJs(
        c,
        `(() => {
          const q = (s) => document.querySelector(s)
          const qa = (s) => [...document.querySelectorAll(s)]
          const ver = q('[data-app-version]')?.textContent ?? ''
          /* adj971（用户口径「版本信息显示在……官网首页的左边」）：不只核对文本，还要**量位置** ——
             徽标必须在顶栏左半边、紧挨品牌名（只看文本时"放页脚了"也会过）。 */
          const verRect = q('.topbar-version')?.getBoundingClientRect() ?? null
          const brandRect = q('.brand')?.getBoundingClientRect() ?? null
          const verPos = verRect
            ? {
                left: Math.round(verRect.left),
                vw: innerWidth,
                brandRight: brandRect ? Math.round(brandRect.right) : null,
              }
            : null
          const imgs = qa('img').map((i) => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 }))
          const links = Object.fromEntries(qa('a[data-l]').map((a) => [a.dataset.l, a.getAttribute('href')]))
          return {
            title: document.title,
            h1: q('.hero h1')?.textContent ?? '',
            cards: qa('.cards .card').length,
            entries: qa('.link-grid .link-card').length,
            navLinks: qa('.nav a').length,
            cta: q('.hero-actions a.btn-primary')?.getAttribute('href') ?? '',
            ver,
            verPos,
            verCount: qa('[data-app-version]').filter((e) => /^v\\d+\\.\\d+\\.\\d+$/.test(e.textContent.trim())).length,
            verTotal: qa('[data-app-version]').length,
            imgs,
            links,
            hasDialog: !!q('dialog#donate'),
            donateImg: q('dialog#donate img')?.getAttribute('src') ?? '',
            faq: qa('.faq details').length,
            /* adj877：Obsidian 插件专区 与 playground */
            obPoints: qa('.ob-points li').length,
            obMarket: q('.ob-actions a[data-l="obsidianMarketUrl"]')?.getAttribute('href') ?? '',
            obRepo: q('.ob-actions a[data-l="obsidianRepoUrl"]')?.getAttribute('href') ?? '',
            /* adj882：首页「看看它长什么样」—— 示例按钮 + 一个 jps 块 */
            pgSamples: qa('[data-pg-sample]').length,
            pgBlocks: qa('#playground .jps-block').length,
            /* adj878：右上角的深浅主题开关 */
            hasTheme: !!q('#theme-toggle'),
            /* adj1080：顶栏文档收敛成一个入口（五份文档从 /manual/ 切换条进） */
            navDocs: qa('.nav a').find((a) => (a.textContent || '').trim() === '文档')?.getAttribute('href') ?? '',
            /* adj948：入口卡里也要有一条（用户口径"首页底部「从哪儿开始」也加一张卡"） */
            cardCli: qa('.link-grid .link-card').find((a) => (a.textContent || '').includes('命令行手册'))?.getAttribute('href') ?? '',
            /* adj1322：首页入口卡挂爱扒谱 */
            cardBp: qa('.link-grid .link-card').find((a) => (a.textContent || '').includes('爱扒谱'))?.getAttribute('href') ?? '',
          }
        })()`,
      )
      check('首页 title 含 Slogan「码即成，谱自现」', home.title.includes('码即成，谱自现'), home.title)
      check('首页 H1 = 码即成，谱自现', home.h1 === '码即成，谱自现', home.h1)
      check('首页特性卡 8 张', home.cards === 8, String(home.cards))
      /**
       * adj898：首页示例区**预置的源码**必须是《小星星》。
       * 用户第一眼看到的那段，就是"一行文本，就是一段旋律"这句话的证据 ——
       * 它要是还停在过去那行 `Q: 1 2 3 4 | 5 6 7 1' |`，整段文案就说不通了。
       */
      const pgCode = await evalJs(c, `document.querySelector('#pg-block .jps-block-code code')?.textContent ?? ''`)
      check('adj898 首页示例区预置的源码就是《小星星》（含 `D:` / `P:` 与收尾 `||`）',
        pgCode.replace(/\s+$/, '') === HOME_SAMPLE_STARS.replace(/\s+$/, ''),
        JSON.stringify(pgCode.slice(0, 80)))
      /**
       * adj897（用户反馈）：功能卡的**图标与标题必须在同一行**。
       * 原来图标 / 标题 / 内容各占一行，手机上卡片窄 ⇒ 三行显得很散。
       * 这条**在手机视口下量真实几何**（用户说的正是那个场景），桌面也量一遍（是统一改的）。
       *
       * ⚠ adj948（**用户反馈**）：「首页那些卡片的图标怎么不见了？是不要了吗？」
       *   —— 那排 emoji 图标**已逐字恢复**（8 张功能卡 + 9 张入口卡，含新增的命令行卡 ⌨️、音视频工具卡 🎬、爱扒谱卡 🎙️）。
       *   本段判据因此**保持 adj897 的原口径**（图标在、与标题同一行、内容落下一行），
       *   只把入口卡的数量从 6 提到 7（新增一张），并补一条"卡片数 + 图标齐全"的断言。
       */
      const measureCard = () =>
        evalJs(
          c,
          `(() => {
            const out = []
            // adj897：**两类卡都要量** —— 功能卡（.features .card）与入口卡（.links .link-card）
            for (const sel of ['.features .card', '.links .link-card']) {
              const root = document.querySelector(sel)
              if (!root) { out.push({ sel, missing: true }); continue }
              const ico = root.querySelector('[class$="-ico"]')            // .card-ico / .link-ico
              const title = root.querySelector('h3, b')                    // 功能卡是 h3、入口卡是 b
              const body =
                root.querySelector('p:not(.card-ico)') ?? root.querySelector('span:last-child')
              if (!ico || !title || !body) { out.push({ sel, missing: true }); continue }
              const a = ico.getBoundingClientRect(), b = title.getBoundingClientRect(), d = body.getBoundingClientRect()
              out.push({
                sel,
                ico: (ico.textContent || '').trim(),
                sameRow: Math.abs(a.top - b.top) <= 12,
                icoLeftOfTitle: b.left >= a.right - 2,
                bodyBelow: d.top >= Math.max(a.bottom, b.bottom) - 2,
                icoTop: Math.round(a.top), titleTop: Math.round(b.top), bodyTop: Math.round(d.top),
              })
            }
            return out
          })()`,
        )
      const cardsOk = (r) =>
        Array.isArray(r) && r.length === 2 &&
        r.every((x) => !x.missing && x.ico.length > 0 && x.sameRow && x.icoLeftOfTitle && x.bodyBelow)
      /** 卡片总数与图标齐全度（用户口径：图标是页面的一部分，不能被顺手删掉） */
      const iconsOf = () =>
        evalJs(
          c,
          `(() => ({
            feature: [...document.querySelectorAll('.features .card .card-ico')].map((e) => (e.textContent || '').trim()),
            link: [...document.querySelectorAll('.links .link-card .link-ico')].map((e) => (e.textContent || '').trim()),
          }))()`,
        )
      await viewport(390, 844, 2)
      await sleep(350)
      const cardMobile = await measureCard()
      check('adj897 手机视口（390px）下：**功能卡与入口卡**的图标、标题都在同一行，内容落在下一行',
        cardsOk(cardMobile), JSON.stringify(cardMobile))
      await viewport(1440, 900, 1)
      await sleep(350)
      const cardDesktop = await measureCard()
      check('adj897 桌面视口下同样成立（两类卡都是图标与标题一行，不是只在手机上改的）',
        cardsOk(cardDesktop), JSON.stringify(cardDesktop))
      const cardIcons = await iconsOf()
      check('adj948/adj1316/adj1322 首页两排卡片的 emoji 图标都还在（功能卡 8 个 + 入口卡 9 个，含命令行、音视频工具、爱扒谱卡）—— 用户明确要求图标不动',
        cardIcons?.feature.length === 8 && cardIcons.feature.every((s) => s.length > 0) &&
          cardIcons.link.length === 9 && cardIcons.link.every((s) => s.length > 0),
        `功能卡 ${JSON.stringify(cardIcons?.feature)} / 入口卡 ${JSON.stringify(cardIcons?.link)}`)
      /**
       * 负对照（**必须为假**）：在活 DOM 上把第一张功能卡的图标删掉 ——
       * 等价于"图标又不见了"（用户这次报的就是这个）⇒ 同一对判据必须判假。
       */
      const cardNeg = await evalJs(
        c,
        `(() => {
          const ico = document.querySelector('.features .card .card-ico')
          if (!ico) return null
          ico.remove()
          return { feature: document.querySelectorAll('.features .card .card-ico').length }
        })()`,
      )
      check('adj948 负对照：把第一张卡的图标删掉 ⇒ "图标都在"判据判假（证明它真的在量图标，而不是恒真）',
        !!cardNeg && cardNeg.feature === 7, JSON.stringify(cardNeg))
      // ⚠ adj899 的换行测试放在下面"切示例"那组**之后**（它要点击示例，会改变初始状态）
      check('adj1322 首页入口链接 9 个（应用/手册/语法/命令行/音视频工具/爱扒谱/桌面/插件/赞赏）', home.entries === 9, String(home.entries))
      check('首页顶栏导航 ≥ 4 条（文档收敛后：功能/文档/下载/GitHub + 打开应用）', home.navLinks >= 4, String(home.navLinks))
      check('adj1080 首页顶栏「文档」入口指向 `/manual/`（五份文档从那里切换）',
        home.navDocs === '/manual/', home.navDocs)
      check('adj948 首页入口卡里有「命令行手册」（指向 `/cli/`，用户要求"底部也加一张卡"）',
        home.cardCli === '/cli/', home.cardCli)
      check('adj1322 首页入口卡有「爱扒谱」（指向 ijipu-bp.pages.dev）',
        home.cardBp === 'https://ijipu-bp.pages.dev/' && home.links.bpUrl === 'https://ijipu-bp.pages.dev/',
        JSON.stringify({ cardBp: home.cardBp, navBp: home.links.bpUrl }))
      check('首页主按钮指向 `/app/`', home.cta === '/app/', home.cta)
      check('首页版本号占位全部填成 vX.Y.Z（没有漏成「·」）',
        home.verTotal > 0 && home.verCount === home.verTotal, `${home.verCount}/${home.verTotal}：${home.ver}`)
      /**
       * adj971（**用户 2026-10-18 口径**）：「版本信息显示在……官网首页的**左边**」。
       *
       * 为什么量几何而不是只看源码顺序：源码里写在品牌名后面、CSS 一改（`order`/`flex-direction`）
       * 就可能跑到右边去 —— 用户要的正是"左边"这件事本身。
       * 判据两条：① 在视口**左半边**；② 紧挨品牌名（在其右侧、间距 < 120px，允许窄屏换行时略微拉开）。
       */
      check('adj971 版本徽标在**首页顶栏左侧**（视口左半边、紧挨品牌名）',
        home.verPos !== null && home.verPos.left > 0 && home.verPos.left < home.verPos.vw / 2 &&
          home.verPos.brandRight !== null && home.verPos.left >= home.verPos.brandRight - 2 &&
          home.verPos.left - home.verPos.brandRight < 120,
        JSON.stringify(home.verPos))
      check('adj971 **负对照**：版本徽标**不在**页面右半边（放右半边就判假 —— 证明上面那条真的在量"左边"）',
        home.verPos !== null && home.verPos.left < home.verPos.vw / 2 && home.verPos.left < home.verPos.vw * 0.6,
        JSON.stringify(home.verPos))
      const brokenImgs = home.imgs.filter((i) => !i.ok).map((i) => i.src)
      check('首页所有图片都真的加载出来了（无破图）', brokenImgs.length === 0, brokenImgs.join(', '))
      // ⚠ 首页**没有** `feedbackUrl`（那是文档页页脚的键）⇒ 这里只查首页真正用到的三个
      check('首页外部链接都由 brand/tokens.ts 填好（不是 `#`）',
        home.links.repoUrl === SITE_REPO &&
          home.links.desktopDownloadUrl === `${SITE_REPO}/releases/latest` &&
          home.links.obsidianRepoUrl === SITE_PLUGIN,
        JSON.stringify(home.links))
      /**
       * adj896 原口径是「顶栏与页脚**都**要有『更新记录』」。
       * **adj933（用户要求）已改**：顶栏那一条**按用户要求删除**（它本就指向 GitHub、与两条 GitHub 入口重复）
       * ⇒ 判据改成"**顶栏里没有**、全页只剩页脚那一条"，并仍然钉住"指向**全部发布**页而非 latest"。
       * ⚠ 这不是把判据放宽：条数从 `>= 2` 收紧成 `=== 1`，同时新增"顶栏里 0 条"。
       * ⚠ 为什么页脚那条没删：用户交代过"只删首页顶栏这一个、别顺手删别处"，页脚那条已列进报告请其拍板。
       */
      const releasesLinks = await evalJs(
        c,
        `[...document.querySelectorAll('a[data-l="releasesUrl"]')].map((a) => a.href)`,
      )
      const releasesInNav = await evalJs(c, `[...document.querySelectorAll('.nav a[data-l="releasesUrl"]')].length`)
      check('adj933 首页**顶栏**里已经没有「更新记录」了（用户要求删掉；页脚那条按"别顺手删别处"暂时保留），且剩下的仍指向**全部发布**页',
        releasesInNav === 0 && releasesLinks.length === 1 && releasesLinks.every((h) => h === `${SITE_REPO}/releases`),
        `顶栏 ${releasesInNav} 条 / 全页 ${releasesLinks.length} 条：${JSON.stringify(releasesLinks)}`)
      /**
       * ---- adj933（用户要求）：顶栏两条 GitHub 入口的**标签 ↔ 地址**与**DOM 顺序** ----
       *
       * 用户原话：「首页上面那排，ob插件标 插件Github，下一个标 应用 Github，或者再把两个github链接对调一下」，
       * 随后澄清：「**链接没串，我是说把应用放前面、插件放后面**」。
       * ⇒ 两个 href **一个都不动**（各自指向正确的仓库），要动的是**顺序**：应用在前、插件在后。
       * 下面两条判据都写成纯函数 ⇒ 负对照（对调 href / 对调顺序）复用同一份，
       * 分别证明它们真的在量"对应关系"与"顺序"，而不是"页面上有没有这两个链接"。
       */
      const navGhList = await evalJs(
        c,
        `[...document.querySelectorAll('.nav a[data-l]')].map((a) => ({ key: a.dataset.l, text: (a.textContent || '').trim(), href: a.href }))`,
      )
      const pluginRepoLink = await evalJs(
        c,
        `document.querySelector('a[data-l="obsidianRepoUrl"]')?.href ?? ''`,
      )
      const navAppGh = navGhList.find((a) => a.key === 'repoUrl') ?? {}
      /** adj1080：顶栏只留应用仓库一个 GitHub；插件仓库入口在「Obsidian 插件」区 */
      const navGhMinimalOk = (list) => {
        if (!Array.isArray(list)) return false
        const app = list.find((a) => a.key === 'repoUrl')
        return app?.text === 'GitHub' && app?.href === SITE_REPO &&
          !list.some((a) => a.key === 'obsidianRepoUrl')
      }
      check('adj1080 首页顶栏只留一个 GitHub（应用仓库）；插件仓库入口在「Obsidian 插件」区',
        navGhMinimalOk(navGhList) && pluginRepoLink === SITE_PLUGIN,
        JSON.stringify({ 顶栏: navGhList, 插件仓库: pluginRepoLink, 应用仓库: SITE_REPO }))
      check('adj1080 负对照：把插件仓库链接塞回顶栏 / 把应用 GitHub 指向插件仓库 ⇒ 判据为假',
        !navGhMinimalOk([...navGhList, { key: 'obsidianRepoUrl', text: '插件 Github', href: SITE_PLUGIN }]) &&
          !navGhMinimalOk([{ ...navAppGh, href: SITE_PLUGIN }]))
      /**
       * 负对照（**保留 adj889 的修正**）：原来那条是 `'#'.startsWith(SITE_REPO) === false`，
       * 而 `'#'` 不以任何地址开头 ⇒ **恒为真、证不了任何事**。换成真正有风险的那件事：
       * 下载地址必须是"主仓库 + `/releases/latest`"这个确定形态，且**不能被插件仓库的地址匹配上**
       * —— 判据写错前缀（少个 `/` 之类）在这里就会露出来。
       */
      check('首页链接负对照：`repoUrl` 与 `desktopDownloadUrl` 的判据能区分开（判据真的在量东西）',
        `${SITE_REPO}/releases/latest` !== SITE_REPO &&
          `${SITE_REPO}/releases/latest`.startsWith(`${SITE_REPO}/`) &&
          !`${SITE_PLUGIN}/releases/latest`.startsWith(`${SITE_REPO}/`))
      check('首页赞赏弹层用微信赞赏码 `/icons/good.png`', home.hasDialog && home.donateImg === '/icons/good.png', home.donateImg)
      check('首页 FAQ 至少 4 条', home.faq >= 4, String(home.faq))
      check('首页有 Obsidian 插件专区（功能清单 ≥ 6 条）', home.obPoints >= 6, String(home.obPoints))
      /**
       * adj888（用户口径「**原则上先应用的功能介绍，再插件介绍**」）：
       * 这条顺序被用户调过两次（adj884 先放到最前、adj884b 退回一个位置、adj888 再对调一次），
       * 所以钉成断言 —— 以后谁打乱它，这里会红，而不是等用户再说一遍。
       *
       * adj948：标题按用户「正式、规范、优雅、简洁」的要求改过（口语化标题 ⇒ 名词化表述），
       * 判据跟着换成新标题的**逐字**（顺序不变：两个应用功能段 → 插件 → 适用人群）。
       */
      const deepOrder = await evalJs(
        c,
        `[...document.querySelectorAll('.deep h2, .obsidian h2')].map((h) => h.textContent.trim())`,
      )
      check('首页「先应用功能、再插件介绍」：Obsidian 段排在两个应用功能段**之后**（标题为 adj948 名词化后的新写法）',
        JSON.stringify(deepOrder) ===
          JSON.stringify(['以代码的方式写谱', '复杂谱面的排版', '在笔记中编写简谱', '适用人群']),
        JSON.stringify(deepOrder))
      check('插件专区两个按钮地址正确（社区市场 / GitHub 仓库）',
        home.obMarket === 'https://obsidian.md/plugins?id=ijipu' && home.obRepo === SITE_PLUGIN,
        `${home.obMarket} | ${home.obRepo}`)
      check('首页示例区：7 个示例按钮 + 恰好一个 ```jps 块',
        home.pgSamples === 7 && home.pgBlocks === 1, `${home.pgSamples} 个示例 / ${home.pgBlocks} 个块`)

      // ---- adj878：右上角的深浅主题开关（点一下要真的换掉配色，不只是改个属性） ----
      check('首页右上角有深浅主题开关', home.hasTheme)
      const themeBefore = await evalJs(c, `document.documentElement.dataset.siteMode ?? ''`)
      const themeAfter = await evalJs(
        c,
        `(() => {
          document.getElementById('theme-toggle')?.click()
          return document.documentElement.dataset.siteMode ?? ''
        })()`,
      )
      const themeVars = await evalJs(
        c,
        `(() => {
          const cs = getComputedStyle(document.documentElement)
          return { bg: cs.getPropertyValue('--site-bg').trim(), accent: cs.getPropertyValue('--site-accent').trim() }
        })()`,
      )
      check('点主题开关后模式翻转（深 ⇄ 浅）',
        (themeBefore === 'dark' || themeBefore === 'light') && themeAfter !== themeBefore,
        `${themeBefore} → ${themeAfter}`)
      // 判据取"强调色"：深色是霓虹青 #00f0ff、浅色必须换成 #0891a6（亮青压浅底根本看不见）
      check('切换后配色真的换了（浅色下强调色不再是霓虹青）',
        themeAfter === 'light'
          ? themeVars.accent.toLowerCase() === '#0891a6' && themeVars.bg.toLowerCase() === '#f2f5fb'
          : themeVars.accent.toLowerCase() === '#00f0ff',
        JSON.stringify(themeVars))
      // 点回去：后面的检查与截图都按深色预期，别留下副作用
      await evalJs(c, `document.getElementById('theme-toggle')?.click()`)
      const themeBack = await evalJs(c, `document.documentElement.dataset.siteMode ?? ''`)
      check('再点一下能切回原模式（开关是双向的）', themeBack === themeBefore, `${themeBack} vs ${themeBefore}`)

      // ---- adj881（用户要求）：插图也要跟着主题换 ----
      const shotsDark = await evalJs(c, `[...document.querySelectorAll('img[data-shot]')].map((i) => i.getAttribute('src'))`)
      check('首页插图带 data-shot 标记，且默认是深色那套',
        shotsDark.length >= 6 && shotsDark.every((s) => s && !s.includes('-light.')), shotsDark.join(', '))
      await evalJs(c, `document.getElementById('theme-toggle')?.click()`)
      await sleep(400)
      const shotsLight = await evalJs(c, `[...document.querySelectorAll('img[data-shot]')].map((i) => i.getAttribute('src'))`)
      check('切到浅色后插图**全部**换成浅色那套（`-light.webp`）',
        shotsLight.length === shotsDark.length && shotsLight.every((s) => s.includes('-light.')),
        shotsLight.join(', '))
      // 换完还要真的能加载（截图阶段没生成浅色图的话，这里就是破图）
      await primeLazyImages()
      const lightBroken = await evalJs(
        c,
        `[...document.images].filter((x) => x.getAttribute('data-shot') && !(x.naturalWidth > 0)).map((x) => x.getAttribute('src'))`,
      )
      check('浅色那套插图都能加载（没有因为缺文件而破图）', lightBroken.length === 0, lightBroken.join(', '))
      await evalJs(c, `document.getElementById('theme-toggle')?.click()`)
      await sleep(400)
      const shotsBack = await evalJs(c, `[...document.querySelectorAll('img[data-shot]')].map((i) => i.getAttribute('src'))`)
      check('切回深色后插图还原（可逆）',
        JSON.stringify(shotsBack) === JSON.stringify(shotsDark), shotsBack.join(', '))

      /**
       * ---- adj882：首页「看看它长什么样」——一排示例 + 一个 ` ```jps ` 块 ----
       * 用户口径：首页不该让使用者自己改代码（那还不如直接进应用），
       * 而是给几个例子让他切着看 —— 所以这里**没有 textarea**。
       * 下面这条"真的点一下「预览」"是"引擎能在首页跑"的**唯一硬证据**（源码级断言做不到）。
       */
      const pgTabsOk = await evalJs(
        c,
        `(() => {
          const block = document.getElementById('pg-block')
          if (!block) return -1
          return block.querySelectorAll('[data-jps-tab]').length
        })()`,
      )
      check('首页有这个 ```jps 块，且带「脚本 / 预览」两个标签', pgTabsOk === 2, String(pgTabsOk))
      const pgInitial = await evalJs(
        c,
        `(() => {
          const b = document.getElementById('pg-block')
          if (!b) return null
          return {
            codeHidden: b.querySelector('.jps-block-code')?.hidden ?? null,
            prevHidden: b.querySelector('.jps-block-preview')?.hidden ?? null,
            mode: b.dataset.jpsMode ?? '',
            zoom: b.dataset.jpsZoom ?? '',
            samples: [...document.querySelectorAll('[data-pg-sample]')].length,
          }
        })()`,
      )
      check('首页示例按钮 7 个（小星星 / 茉莉花 / 倚音与连音 / 跳房子与反复 / 临时伴奏 / 临时多声部 / 多声部）',
        pgInitial?.samples === 7, JSON.stringify(pgInitial))
      /**
       * adj900（用户决定「用文本串导入功能」）：示例区那个「在应用里试听这段」
       * 把**当前示例的完整源码**挂在 `?jps=` 上带进应用 ——
       * 于是首页不用下 30MB 音色库，用户又能在应用里看到（并试听）自己刚看的那段。
       * ⚠ 这条要在"切示例"那组**之前**量：那时 href 里装的才是首屏的小星星。
       */
      const handoff = await evalJs(
        c,
        `(() => {
          const a = document.getElementById('pg-open-app')
          if (!a) return null
          const href = a.getAttribute('href') ?? ''
          let decoded = ''
          try { decoded = decodeURIComponent(href.replace('/app/?jps=', '')) } catch { decoded = '' }
          return { href: href.slice(0, 60), decoded, text: (a.textContent ?? '').trim() }
        })()`,
      )
      check('adj900 示例区有「在应用里试听」入口，链接指向 `/app/?jps=…`',
        !!handoff && handoff.href.startsWith('/app/?jps='), JSON.stringify(handoff))
      check('adj900 链接里带的是**当前示例（小星星）的完整源码**（含标题行与收尾 `||`）',
        !!handoff && handoff.decoded.includes('B: 小星星') && handoff.decoded.includes('||'),
        JSON.stringify(handoff?.decoded?.slice(0, 70)))
      /**
       * adj900b（用户要求）：首页那个入口**不许**出现"要下载音色库 / 30MB"这类说明 ——
       * 「要提示也是到应用后，在试听里没有音色库时再提示」。
       * 钉成**负向断言**：以后谁"好心"把它加回来，这里会红。
       */
      const pgOpenText = await evalJs(c, `document.querySelector('.pg-open')?.textContent ?? ''`)
      check('adj900b 首页试听入口**不提**音色库 / 30MB / 下载（该提示的地方是应用）',
        !/30\s*MB|音色库|下载|音源/i.test(pgOpenText), JSON.stringify(pgOpenText))
      check('adj900b 那个入口就是一个按钮，文案逐字是「在应用里试听」',
        pgOpenText.trim() === '在应用里试听', JSON.stringify(pgOpenText))
      check('首屏停在「脚本」标签（预览要按需下引擎，不该在首屏发生）',
        pgInitial?.codeHidden === false && pgInitial?.prevHidden === true, JSON.stringify(pgInitial))
      check('首页这个块声明了显示范围与缩放（`v=` / `z=`，与插件同口径）',
        pgInitial?.mode === 's' && pgInitial?.zoom === '*', JSON.stringify(pgInitial))

      const pgClicked = await evalJs(
        c,
        `(() => {
          const b = document.querySelector('#pg-block [data-jps-tab="preview"]')
          if (!b) return false
          b.click()
          return true
        })()`,
      )
      let pgSvg = 0
      for (let i = 0; i < 30 && pgSvg === 0; i++) {
        await sleep(300)
        pgSvg = await evalJs(c, `document.querySelectorAll('#pg-block .jps-block-preview svg').length`)
      }
      const pgMsg = await evalJs(c, `document.querySelector('#pg-block .jps-block-msg')?.textContent ?? ''`)
      check('点「预览」后首页的块真的渲染出谱面（引擎在首页加载并跑通了）',
        pgClicked && pgSvg > 0, `svg=${pgSvg} msg=${pgMsg}`)
      check('首页块的渲染结果无错误/告警提示', pgMsg === '', pgMsg.slice(0, 120))

      // ---- 切示例：源码与预览都要跟着换（这是这个区块的核心用途） ----
      const swap = await evalJs(
        c,
        `(async () => {
          const btns = [...document.querySelectorAll('[data-pg-sample]')]
          const code = document.querySelector('#pg-block .jps-block-code code')
          if (btns.length < 2 || !code) return null
          const before = code.textContent
          btns[1].click()
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 200))
            if (code.textContent !== before && document.querySelectorAll('#pg-block .jps-block-preview svg').length > 0) break
          }
          return { before: before.length, after: code.textContent.length, active: btns[1].classList.contains('active') }
        })()`,
      )
      check('点另一个示例后：源码换了、预览重渲染了、按钮高亮跟着走',
        !!swap && swap.after > 0 && swap.after !== swap.before && swap.active === true, JSON.stringify(swap))
      await evalJs(c, `document.querySelectorAll('[data-pg-sample]')[0]?.click()`)
      await sleep(900)

      /**
       * adj899（用户反馈「示例的脚本块没有允许自动换行，应开启自动换行，不然脚本看不全」）：
       * 量**真实溢出**而不是只看 CSS 属性 —— 切到曲行最长的「茉莉花（完整）」，
       * 若脚本块不折行，它的 `scrollWidth` 必然远大于 `clientWidth`。
       *
       * ⚠ 这段必须待在"切示例"那组**之后**：它自身要点击示例，会把块的初始状态改掉。
       * 跑完**切回索引 0**，不给后面的断言留副作用。
       */
      await evalJs(c, `document.querySelectorAll('[data-pg-sample]')[1]?.click()`)
      await sleep(500)
      const codeBox = await evalJs(
        c,
        `(() => {
          const pre = document.querySelector('#pg-block .jps-block-code')
          if (!pre) return null
          return {
            ws: getComputedStyle(pre).whiteSpace,
            wrap: getComputedStyle(pre).overflowWrap,
            scrollW: pre.scrollWidth,
            clientW: pre.clientWidth,
          }
        })()`,
      )
      check('adj899 示例脚本块会**自动换行**（`pre-wrap`，长曲行不再被横向截掉）',
        codeBox?.ws === 'pre-wrap', JSON.stringify(codeBox))
      check('adj899 长曲行（茉莉花）不再横向溢出：`scrollWidth ≤ clientWidth`（用户要求"不然看不全"）',
        !!codeBox && codeBox.scrollW <= codeBox.clientW + 2, JSON.stringify(codeBox))
      await evalJs(c, `document.querySelectorAll('[data-pg-sample]')[0]?.click()`)
      await sleep(500)

      const pgErrs = collectErrors(mark)
      check('首页（含示例切换与引擎加载）无控制台错误 / 无本站 4xx',
        pgErrs.length === 0, pgErrs.slice(0, 4).join(' | '))

      const homeErrs = collectErrors(mark)
      check('首页无控制台错误 / 无本站 4xx（含图片与脚本）', homeErrs.length === 0, homeErrs.slice(0, 4).join(' | '))

      // ---------------- 应用页 ----------------
      console.log('[verify-site] 验证 `/app/`（应用）…')
      /**
       * 截图阶段把 `viewType` 留在 `preview`（demo 图与 Obsidian 图要它）——
       * 验证前**显式设回**应用默认的「左右拆分」：断言不该依赖"上一步碰巧留下的状态"，
       * 否则截图顺序一改，这里就会莫名其妙地红（本轮实测就是这个）。
       */
      await evalJs(c, `localStorage.setItem('ijipu.viewType', 'split')`)
      /**
       * adj900（用户决定「用文本串导入功能」）：**端到端**验一次 ——
       * 首页那个链接带过来的 `?jps=` 到底有没有被应用载入。
       *
       * 不能只靠纯函数断言：`App.tsx` 里那个 effect 有没有跑、
       * 会不会被 docStore 启动时读的本地草稿盖掉，**只有真打开一次才知道**。
       */
      await c.send('Page.navigate', { url: `${origin}/app/?jps=${encodeURIComponent(HOME_SAMPLE_STARS)}` })
      await sleep(2200)
      const urlImport = await evalJs(
        c,
        `(() => {
          const ta = document.querySelector('textarea')
          const val = ta ? ta.value : ''
          return {
            loaded: val.includes('B: 小星星') && val.includes('||'),
            len: val.length,
            // 地址栏里的 jps 参数应当已被抹掉（否则一刷新又被打回示例）
            search: location.search,
          }
        })()`,
      )
      check('adj900 打开 `/app/?jps=…` 后编辑器里**确实载入了那段示例**（端到端）',
        urlImport?.loaded === true, JSON.stringify(urlImport))
      check('adj900 载入后地址栏参数被抹掉（不然用户一刷新又被打回示例）',
        urlImport?.search === '', JSON.stringify(urlImport))

      pageErrors = []
      mark = noteEvents()
      await c.send('Page.navigate', { url: `${origin}/app/` })
      await sleep(2200)
      const app = await evalJs(
        c,
        `(() => {
          const q = (s) => document.querySelector(s)
          return {
            title: document.title,
            rootKids: q('#root')?.children.length ?? 0,
            hasEditor: !!q('textarea'),
            svgCount: document.querySelectorAll('#root svg').length,
            draftLen: (localStorage.getItem('ijipu.draft') || '').length,
            /* adj877（用户要求）：应用里回官网的路 */
            siteHref: q('.footer-site')?.getAttribute('href') ?? '',
            siteText: (q('.footer-site')?.textContent ?? '').trim(),
            /* adj971（用户口径）：版本信息显示在**状态栏右侧** */
            footVer: (q('.footer-version')?.textContent ?? '').trim(),
          }
        })()`,
      )
      /**
       * adj971（**用户 2026-10-18 口径反转**）：应用标题不再是 `爱记谱 iJipu - vX.Y.Z (…)`；
       * adj978 起**只显示文件名**（应用名交给壳，浏览器页签 / PWA / 桌面窗口都不再拼应用名）。
       * 版本在状态栏右侧，且 adj975 起**日期 + 指纹也可见**（`vX.Y.Z (日期 @commit)`）。
       */
      check('adj971/adj978 应用 title = **只有文件名**（`xx.jps`），且**不带版本号**',
        /^.+\.jps$/.test(app.title) && !/v\d+\.\d+\.\d+/.test(app.title), app.title)
      check('adj971/adj975 应用状态栏右侧显示版本号（`.footer-version` 可见 `vX.Y.Z (日期 @commit)`）',
        /^v\d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2} @[0-9a-f]{7,}\)$/.test(String(app.footVer).trim()),
        JSON.stringify({ 版本: app.footVer }))
      check('应用挂载成功（#root 有内容）', app.rootKids > 0, String(app.rootKids))
      check('应用编辑器在位（textarea 存在）', app.hasEditor)
      check('应用谱面渲染出来了（有 svg）', app.svgCount > 0, String(app.svgCount))
      check('应用读到了注入的谱面草稿（说明 localStorage 草稿链路正常）', app.draftLen > 0, String(app.draftLen))
      // adj877（用户要求「要有返回首页的链接点」）：应用自己的界面里原本没有任何回官网的路
      check('应用状态栏有「官网首页」链接（网页版 href = `/`）',
        app.siteHref === '/' && app.siteText.includes('官网'), `${app.siteHref} / ${app.siteText}`)
      const appErrs = collectErrors(mark).filter((e) => !/音色|soundfont|sampler|sf2|midi-js/i.test(e))
      check('应用无本站资源错误（音色库等跨域资源失败不计）', appErrs.length === 0, appErrs.slice(0, 4).join(' | '))

      // ---------------- 文档页（四份都要：正文 + 目录 + 锚点） ----------------
      // 元组：标签 / 路径 / 目录条数下限 / 正文子节点下限 / 需要表格 / **有没有 ` ```jps ` 示例**
      // ⚠ 最后一列是 adj948 加的：`/cli/`（命令行手册）里的代码块全是 ` ```text ` 输出片段，
      //   一个 ` ```jps ` 都没有 ⇒ "示例块能切预览"那一组对它**不适用**，要单独判（见下）。
      for (const [label, url, minToc, minKids, needTable, hasJps] of [
        ['操作手册', '/manual/', 5, 20, false, true],
        ['脚本语法说明', '/syntax/', 8, 40, true, true],
        /* adj905x（用户要求）：插件功能介绍 + 使用手册 */
        ['插件手册', '/plugin/', 8, 30, true, true],
        /* adj948（用户要求）：CLI 命令使用手册（正文 = 随安装包发布的那一份手册） */
        ['命令行手册', '/cli/', 5, 30, true, false],
      ]) {
        console.log(`[verify-site] 验证 \`${url}\`（${label}）…`)
        mark = noteEvents()
        await c.send('Page.navigate', { url: `${origin}${url}` })
        await sleep(1500)
        /**
         * 检查页内锚点。⚠ 两个坑都踩过了，写在这里免得下次重犯：
         *
         * ① **判据必须用 `getElementById`，不能用 `querySelector`**：
         *    中文标题 slug 可能是 `1-1-什么是-jps` 这种**数字开头**的（标题里的 `1.1` 去标点后如此），
         *    而 `querySelector` 拿 `#1-1-…` 当 CSS 选择器时是**非法的**，会直接抛异常。
         *    浏览器自己的锚点跳转走的是 getElementById 语义，所以"数字开头"对用户没问题。
         * ② 下面这段是**模板字符串**，里面（**注释里也不行**）不能出现反引号——
         *    一出现就提前终止字符串，报一个跟真实位置差很远的语法错。
         *    `embed-smoke.mjs` 为此专门有 `assertNoBackticksInTemplates()` 自检。
         */
        const doc = await evalJs(
          c,
          `(() => {
            const q = (s) => document.querySelector(s)
            const qa = (s) => [...document.querySelectorAll(s)]
            const toc = qa('#doc-toc a.toc-item').map((a) => a.getAttribute('href'))
            const dead = toc.filter((h) => !document.getElementById(h.slice(1)))
            return {
              title: document.title,
              kids: q('#doc-body')?.children.length ?? 0,
              tocCount: toc.length,
              dead: dead.slice(0, 3),
              tables: qa('#doc-body table.doc-md-table').length,
              codes: qa('#doc-body pre').length,
              firstHead: q('#doc-body h1')?.textContent ?? '',
              bodyHasContent: (q('#doc-body')?.textContent ?? '').trim().length > 300,
              /* adj877（用户要求）：顶栏的返回首页链接 */
              docHome: q('.doc-home')?.getAttribute('href') ?? '',
              /* adj878：顶栏的深浅主题开关 */
              hasTheme: !!q('.theme-toggle'),
            }
          })()`,
        )
        check(`${label}：title 正确`, doc.title.includes(label), doc.title)
        check(`${label}：顶栏有「返回首页」链接（adj877 用户要求）`, doc.docHome === '/', doc.docHome)
        check(`${label}：顶栏有深浅主题开关（adj878，与首页同一套）`, doc.hasTheme)
        check(`${label}：正文渲染出来了（子节点 ≥ ${minKids}）`, doc.kids >= minKids, String(doc.kids))
        check(`${label}：正文有实质内容`, doc.bodyHasContent)
        check(`${label}：左侧目录条目 ≥ ${minToc}`, doc.tocCount >= minToc, String(doc.tocCount))
        check(`${label}：目录锚点**全部**能在正文里找到（不会点不动）`, doc.dead.length === 0, doc.dead.join(', '))
        /**
         * adj886（用户反馈「左侧栏一级菜单无链接、不可点击」）：
         * 目录里**每一行**都必须是能跳的链接（`dead === 0`）。
         * ⚠ 不要求"一定有一级"：**操作手册本来就没有一级标题**（它用「一、二、三」当二级），
         *   只有语法说明才有 `# 第一部分` 这类一级 —— 所以"有没有一级"单独对语法说明断言。
         */
        const tocAll = await evalJs(
          c,
          `(() => {
            const links = [...document.querySelectorAll('#doc-toc a')]
            const dead = links.filter((a) => !document.getElementById((a.getAttribute('href') || '').slice(1)))
            return { total: links.length, groups: document.querySelectorAll('#doc-toc a.toc-group').length, dead: dead.length }
          })()`,
        )
        check(`${label}：目录里每一行都是可点链接（共 ${tocAll?.total ?? 0} 行，其中一级 ${tocAll?.groups ?? 0} 个）`,
          !!tocAll && tocAll.dead === 0 && tocAll.total > 0, JSON.stringify(tocAll))
        if (label === '脚本语法说明') {
          check('语法说明的目录里，一级标题也是链接（用户反馈过"一级不可点"）',
            (tocAll?.groups ?? 0) > 0, JSON.stringify(tocAll))
        }
        check(`${label}：代码块渲染成 <pre>`, doc.codes > 0, String(doc.codes))
        if (needTable) check(`${label}：表格渲染成真 <table>`, doc.tables > 0, String(doc.tables))

        /**
         * ---- adj913（用户实测）：文档里的**反引号转义**必须被渲染器还原 ----
         *
         * 现象：文档里"句子中间显示字面三个反引号"的地方改用了**转义写法**（源码里是
         * 「反斜杠 + 反引号」）—— Obsidian 里正常显示成字面围栏，
         * **网页这边却把反斜杠原样显示出来**、后面再跟一个代码片。
         * 根因是站点渲染器的行内解析没处理反引号转义（应用内帮助与站点共用同一个渲染器，
         * 所以这一修两处都跟着好）。
         *
         * 判据：
         *   ① 正文里出现**字面的**三个反引号 + jps；
         *   ② 正文里**不得**残留「反斜杠 + 反引号」；
         *   ③ 回归：普通行内代码（`.jps`）仍要渲染成 `<code>`（转义逻辑不许误伤行内代码）。
         * 三条都配负对照，证明判据不是形同虚设。
         *
         * adj914（顺带收紧）：判据的**适用范围**由"按页写死"改成
         * **"凡源码里出现「反斜杠 + 反引号」的文档页都要查"** ——
         * 样本从 `DOC_PAGE_MD` 那张表自动发现（现在命中 `/plugin/`、`/syntax/`；
         * 将来 `/manual/` 或新页面用了转义写法，**不用回来改断言**就自动被守住）。
         */
        const escapedSampleLines = RAW_ESCAPED_LINES[url] ?? []
        if (escapedSampleLines.length > 0) {
          const docText = await evalJs(
            c,
            `(() => {
              const body = document.getElementById('doc-body')
              const codes = [...document.querySelectorAll('#doc-body code')].map((el) => ({
                text: (el.textContent || '').trim(),
                inPre: !!el.closest('pre'),
              }))
              /* 正文块：段落 / 列表项 / 表格单元格 / 引用 —— 示例块里的 .jps 源码不算"正文文本" */
              const blocks = [...document.querySelectorAll('#doc-body p, #doc-body li, #doc-body td, #doc-body th, #doc-body blockquote')]
              return {
                body: body ? body.textContent : '',
                blocks: blocks.map((el) => el.textContent).join('\\n'),
                codes,
              }
            })()`,
          )
          check(
            label + '：正文里出现**字面**的 ' + TICKS3 + 'jps（转义写法被渲染器还原；用户报的就是这条）',
            hasLiteralFenceJps(docText?.body),
            fenceDetail(docText?.body),
          )
          check(
            label + '：正文里没有「反斜杠 + 反引号」残留（正文块文本，避开示例块里的源码）',
            !(docText?.blocks ?? '').includes(BSLASH_TICK),
            fenceDetail(docText?.blocks),
          )
          check(
            label + '：回归 —— 普通行内代码 .jps 仍渲染成 <code>（没被转义逻辑吃掉）',
            hasInlineCodeJps(docText?.codes),
            JSON.stringify((docText?.codes ?? []).slice(0, 5)),
          )
          /**
           * 负对照 ①：**在断言里模拟"渲染器没做转义处理"**（不动实现文件）——
           * 把文档原文里含「反斜杠 + 反引号」的那几行喂给同一条判据；那正是修之前页面上的文本。
           */
          const negLines = escapedSampleLines
          check(
            label + '：负对照 —— 去掉转义处理（文档原文 ＝ 修前页面文本）时判据①为假',
            negLines.length > 0 && negLines.every((l) => !hasLiteralFenceJps(l)),
            `${negLines.length} 行样本：${(negLines[0] ?? '').slice(0, 40)}…`,
          )
          /**
           * 负对照 ②：判据③若**放宽成"任何 <code> 都算"**，在"只有代码块（pre > code）"的样本上
           * 照样为真 ⇒ 它量不出"行内代码有没有被吃掉"（同一份样本上严格版为假 ⇒ 严格版能红）。
           */
          const preOnly = [{ text: 'V: 1.0', inPre: true }, { text: 'C: 1 2 3', inPre: true }]
          check(
            label + '：负对照 —— 判据③放宽成「任何 <code> 都算」在"只有代码块"样本上仍为真（故不许放宽）',
            hasInlineCodeJps(preOnly) === false && hasAnyCode(preOnly) === true,
            JSON.stringify(preOnly),
          )
          /**
           * 人工看图用：把"句子中间那段字面围栏"滚到视口中间，拍一张 1440×900 的桌面图
           * （整页图 `plugin.png` / `syntax.png` 太长，这一句在图上很难找）。
           */
          if (DO_SHOTS) {
            // adj914：文件名由**页面路径**推出来（不按页写死名字 ⇒ 新增页面也自动有图）
            const shotName = `${url.replace(/^\/|\/$/g, '').replace(/\//g, '-')}-escape.png`
            const found = await evalJs(
              c,
              `(() => {
                const hit = [...document.querySelectorAll('#doc-body p, #doc-body li, #doc-body td, #doc-body th, #doc-body blockquote')]
                  .find((el) => (el.textContent || '').includes(String.fromCharCode(96).repeat(3) + 'jps'))
                if (!hit) return false
                hit.scrollIntoView({ block: 'center', behavior: 'instant' })
                return true
              })()`,
            )
            if (found) {
              await sleep(350)
              await saveShot(shotName, await shoot('png'))
            }
          }
        }

        /**
         * 真点一下目录（第 3 条）：断言 hash 变了、页面滚动了、且目标标题就落在视口上方附近。
         * 只查"元素存在"不够——`scroll-padding-top` 配错、`scroll-behavior` 失效、
         * 或 id 与 toc 的 href 差一个字符，都会表现为"点了没反应"。
         */
        const hit = await evalJs(
          c,
          `(() => {
            const a = document.querySelectorAll('#doc-toc a.toc-item')[2]
            if (!a) return null
            a.click()
            return a.getAttribute('href').slice(1)
          })()`,
        )
        await sleep(900)
        /**
         * ⚠ 这里必须 `decodeURIComponent`：`location.hash` 里中文是**百分号编码**的
         * （`#%E4%B8%89-…`），直接拿它去 `getElementById` 一定找不到 ——
         * 而"找不到"会被读成"目录点不动"，把一个正常的跳转判成红灯（本轮就先判错了一次）。
         */
        const jumped = await evalJs(
          c,
          `(() => {
            const raw = location.hash.slice(1)
            const id = decodeURIComponent(raw)
            const el = document.getElementById(id)
            return {
              id,
              y: Math.round(window.scrollY),
              top: el ? Math.round(el.getBoundingClientRect().top) : null,
            }
          })()`,
        )
        check(`${label}：点目录真的会跳（hash 指向该标题 + 滚到目标标题附近）`,
          !!hit && jumped.id === hit && jumped.y > 0 && jumped.top !== null && jumped.top >= -20 && jumped.top < 240,
          `目标 ${hit} → ${JSON.stringify(jumped)}`)

        /**
         * adj905x（用户要求）：「**操作手册 / 脚本语法说明 的页眉要浮动固定在顶部**，不随内容上滚，
         * 这样随时可以点目录、跳到需要的标题 —— 类似首页的显示方式」。
         *
         * 判据用**实测矩形**，不看 CSS 里写了什么（"写了 sticky 却没生效"正是这类问题的形态：
         * 祖先有 overflow、被 transform/filter 生成包含块、或 sticky 的容器高度不对，都会静默失效）。
         * 此刻页面已经被上面那步滚过了（`jumped.y > 0`）⇒ 正好是量它的时机。
         * 顺带量"目录是否仍在视口内" —— 用户要的是"随时可以点目录"。
         */
        const sticky = await evalJs(
          c,
          `(() => {
            const tb = document.querySelector('.doc-topbar')
            const toc = document.querySelector('.doc-toc')
            const tr = tb ? tb.getBoundingClientRect() : null
            const cr = toc ? toc.getBoundingClientRect() : null
            return {
              y: Math.round(window.scrollY),
              vh: window.innerHeight,
              pos: tb ? getComputedStyle(tb).position : '',
              top: tr ? Math.round(tr.top) : null,
              bottom: tr ? Math.round(tr.bottom) : null,
              tocTop: cr ? Math.round(cr.top) : null,
              tocInView: !!cr && cr.bottom > 0 && cr.top < window.innerHeight,
            }
          })()`,
        )
        check(`${label}：滚到 ${sticky?.y ?? 0}px 后页眉**仍固定在顶部**（不随内容上滚）`,
          !!sticky && sticky.y > 0 && sticky.top === 0 && sticky.bottom > 0 &&
            (sticky.pos === 'sticky' || sticky.pos === 'fixed'),
          JSON.stringify(sticky))
        check(`${label}：滚动中目录仍在视口内（"随时可以点目录"）`,
          !!sticky && sticky.tocInView, JSON.stringify(sticky))

        /**
         * ---- adj882（用户要求）：文档里的 ` ```jps ` 示例要变成「脚本 / 预览」块 ----
         * 这是这个功能的**核心验收**：语法说明里几十个示例，页面上都该是可切换的。
         *
         * adj948：`/cli/`（命令行手册）**没有** ` ```jps ` 示例（它的代码块全是 ` ```text ` 输出片段）
         * ⇒ 这一组对它换成**反向判据**：页面里确实一个 jps 块都没有、但 ` ```text ` 代码块都在。
         * （不是"跳过不查"—— 跳过的话，"误把 text 块变成 jps 块"这种坏味道就没人守。）
         */
        if (!hasJps) {
          const noJps = await evalJs(
            c,
            `(() => ({
              jps: document.querySelectorAll('#doc-body .jps-block').length,
              pre: document.querySelectorAll('#doc-body pre').length,
            }))()`,
          )
          check(`${label}：正文里**没有** \`\`\`jps 示例块，但 \`\`\`text 输出片段都渲染成 <pre>（共 ${noJps?.pre ?? 0} 个）`,
            !!noJps && noJps.jps === 0 && noJps.pre > 5, JSON.stringify(noJps))
          const docFeedback0 = await evalJs(
            c,
            `(() => { const a = document.querySelector('.doc-foot a[data-l="repoUrl"]'); return a ? a.href : '' })()`,
          )
          check(`${label}：页脚反馈链接指向公开的源码仓库`, docFeedback0 === SITE_REPO, docFeedback0)
          const docErrs0 = collectErrors(mark)
          check(`${label}：无控制台错误 / 无本站 4xx`, docErrs0.length === 0, docErrs0.slice(0, 4).join(' | '))
          continue
        }
        const jpsBlocks = await evalJs(c, `document.querySelectorAll('#doc-body .jps-block').length`)
        check(`${label}：正文里的 \`\`\`jps 示例都变成了「脚本 / 预览」块（共 ${jpsBlocks} 个）`,
          jpsBlocks > 0, String(jpsBlocks))
        const jpsInit = await evalJs(
          c,
          `(() => {
            const b = document.querySelector('#doc-body .jps-block')
            if (!b) return null
            return {
              codeHidden: b.querySelector('.jps-block-code')?.hidden ?? null,
              prevHidden: b.querySelector('.jps-block-preview')?.hidden ?? null,
              mode: b.dataset.jpsMode ?? '',
              zoom: b.dataset.jpsZoom ?? '',
            }
          })()`,
        )
        check(`${label}：jps 块默认停在「脚本」（预览要按需加载引擎，不该在打开文档时就下）`,
          jpsInit?.codeHidden === false && jpsInit?.prevHidden === true, JSON.stringify(jpsInit))
        const docClicked = await evalJs(
          c,
          `(() => {
            const b = document.querySelector('#doc-body .jps-block [data-jps-tab="preview"]')
            if (!b) return false
            b.click()
            return true
          })()`,
        )
        let docSvg = 0
        for (let i = 0; i < 30 && docSvg === 0; i++) {
          await sleep(300)
          docSvg = await evalJs(c, `document.querySelectorAll('#doc-body .jps-block .jps-block-preview svg').length`)
        }
        check(`${label}：点示例块的「预览」真的渲染出谱面（引擎按需加载跑通）`,
          docClicked && docSvg > 0, `svg=${docSvg}`)

        /**
         * adj890：文档页页脚的「发现问题 / 提建议」指向源码仓库 —— 仓库已开源 ⇒ 访客点得开、也提得了 Issue。
         */
        const docFeedback = await evalJs(
          c,
          `(() => { const a = document.querySelector('.doc-foot a[data-l="repoUrl"]'); return a ? a.href : '' })()`,
        )
        check(`${label}：页脚反馈链接指向公开的源码仓库`, docFeedback === SITE_REPO, docFeedback)

        const docErrs = collectErrors(mark)
        check(`${label}：无控制台错误 / 无本站 4xx`, docErrs.length === 0, docErrs.slice(0, 4).join(' | '))
      }

      /**
       * ---------------- adj948：新增的 `/cli/` 命令行手册（用户要求「官网补 CLI 命令使用手册」） ----------------
       *
       * 用户口径：与 `/manual/` `/syntax/` `/plugin/` **同构**、正文用**同一份真源**
       * （`docs/CLI-手册.md`，就是随安装包发布的那一份）、页首加一段**面向访客**的引言、
       * 命令集齐全（**13 个命令都能在页面里找到**）。
       *
       * 上面那个文档页循环已经覆盖了"正文渲染出来 / 目录点得动 / 表格 / 页脚 / 无控制台报错"这些**通用项**，
       * 这里只补这一页**独有**的三件事，每条配负对照：
       *   ① 页首引言真的在（在正文**之前**、布局可见、内容写到"未注册 PATH 时用完整路径调用"）；
       *   ② 命令集齐全 —— 名单**从源码读**（`cli.ts` 的 `known` 集合），逐个要求页面里出现
       *      `<code>命令</code>`（在 Node 侧比对页面**实际渲染**的 code 文本，不是比对源码）；
       *   ③ 顶栏切换条认得出"当前就是这一页"（`body[data-doc=cli]`，docs.css 靠它高亮）。
       */
      console.log('[verify-site] 验证 `/cli/`（命令行手册，adj948）…')
      {
        /** 命令名单从**源码**读（唯一一处名单）⇒ 以后加命令，这条自动要求页面跟上 */
        const CLI_COMMANDS = (() => {
          const src = readFileSync(path.join(ROOT, 'packages', 'ijipu-cli', 'src', 'cli.ts'), 'utf8')
          const m = src.match(/const known = new Set\(\[([^\]]*)\]\)/)
          return m === null ? [] : Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1])
        })()
        await viewport(1440, 900, 1)
        mark = noteEvents()
        await c.send('Page.navigate', { url: `${origin}/cli/` })
        await sleep(1600)
        const cliPage = await evalJs(
          c,
          `(() => {
            const intro = document.querySelector('.doc-intro')
            const body = document.getElementById('doc-body')
            const ir = intro ? intro.getBoundingClientRect() : null
            const codes = [...document.querySelectorAll('#doc-body code')].map((el) => (el.textContent || '').trim())
            return {
              hasIntro: !!intro,
              introVisible: !!ir && ir.width > 0 && ir.height > 0 && getComputedStyle(intro).display !== 'none',
              introText: intro ? (intro.textContent || '').trim() : '',
              /* 引言必须在正文**之前**（DOCUMENT_POSITION_FOLLOWING ⇒ body 排在 intro 后面） */
              introBeforeBody: !!intro && !!body &&
                (intro.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
              codes,
              docKind: document.body.dataset.doc || '',
              switchHrefs: [...document.querySelectorAll('.doc-switch a')].map((a) => a.getAttribute('href')),
            }
          })()`,
        )
        check('adj948 `/cli/`：页首引言存在、可见、且排在正文**之前**（用户要求"页首加一段面向访客的引言"）',
          !!cliPage && cliPage.hasIntro && cliPage.introVisible && cliPage.introBeforeBody,
          JSON.stringify({ has: cliPage?.hasIntro, vis: cliPage?.introVisible, before: cliPage?.introBeforeBody }))
        check('adj948 `/cli/`：引言写明"未注册 PATH 时用完整路径调用"（访客最需要的那句）',
          !!cliPage && cliPage.introText.includes('PATH') && cliPage.introText.includes('完整路径'),
          (cliPage?.introText ?? '').slice(0, 80))
        const noCodeCmd = CLI_COMMANDS.filter((cmd) => !(cliPage?.codes ?? []).includes(cmd))
        check(`adj948 \`/cli/\`：**命令集齐全** —— 源码里的 ${CLI_COMMANDS.length} 个命令逐个在页面里渲染成 \`<code>命令</code>\``,
          CLI_COMMANDS.length >= 13 && noCodeCmd.length === 0, noCodeCmd.join(' '))
        check('adj948 `/cli/`：顶栏切换条认得出"当前是这一页"（`body[data-doc=cli]`，五份文档都在条上）',
          cliPage?.docKind === 'cli' &&
            JSON.stringify(cliPage?.switchHrefs) === JSON.stringify(['/manual/', '/syntax/', '/plugin/', '/cli/', '/soundfonts/']),
          `${cliPage?.docKind} / ${JSON.stringify(cliPage?.switchHrefs)}`)
        /**
         * 负对照（**必须为假**）：直接在活页面上"拆掉"证据 —— 不改实现文件、不动服务端。
         *   · 删掉引言元素 ⇒ ①的外形判据为假；
         *   · 把某一处 `<code>batch</code>` 的文字改成别的 ⇒ ②为假。
         * 两处都改完后再核对原判据仍为真（证明上面量的确实是这两样东西，而不是恒真）。
         */
        const neg = await evalJs(
          c,
          `(() => {
            const intro = document.querySelector('.doc-intro')
            if (intro) intro.remove()
            /* ⚠ 手册里同一个命令会出现**多次**（表格一次、小节标题一次…）⇒ 必须**全部**改掉，
               只改第一个的话判据仍然为真，负对照就成了"假绿"（第一次就是这么写错的）。 */
            let touched = 0
            for (const el of document.querySelectorAll('#doc-body code')) {
              if ((el.textContent || '').trim() === 'batch') { el.textContent = 'b4tch'; touched++ }
            }
            const codes = [...document.querySelectorAll('#doc-body code')].map((el) => (el.textContent || '').trim())
            return {
              introGone: !document.querySelector('.doc-intro'),
              batchTouched: touched,
              batchGone: !codes.includes('batch'),
            }
          })()`,
        )
        check('adj948 负对照：在活页面上删掉引言 / 改掉**全部** `<code>batch</code>` ⇒ ①与②各自判假（判据不是恒真）',
          neg?.introGone === true && neg?.batchTouched >= 1 && neg?.batchGone === true &&
            CLI_COMMANDS.includes('batch') && noCodeCmd.length === 0,
          JSON.stringify(neg))
        const cliErrs = collectErrors(mark)
        check('adj948 `/cli/`：无控制台错误 / 无本站 4xx', cliErrs.length === 0, cliErrs.slice(0, 4).join(' | '))

        /**
         * adj949（用户追加要求「手册中可以有更多的示例和截图」）：**图片真的取得到**。
         *
         * 判据两层，缺一不可：
         *   ① **服务端**：手册里 `![…](/docs/cli/x.png)` 引用的每个路径，在 `dist/` 里都得是真文件
         *      （`npm run build` 会把 `public/` 复制进 `dist/`）—— 这一层抓"图片忘了提交/忘了放对目录"；
         *   ② **页面里**：正文每个 `<img>` 的 `naturalWidth > 0`（真的下载 + 解码成功），
         *      而不是"DOM 里有个 img 标签"—— 这一层抓"路径写错 / 大小写不符 / 被 SW 拦掉"。
         *
         * 负对照（**必须为假**，放在最后做、且**不能**影响上面那条"无本站 4xx"）：
         * 把某一处 `src` 换成一个**坏掉的 `data:` URL**（不是网络路径）⇒ 该图解码失败、
         * `naturalWidth === 0` ⇒ 判据判假。用 `data:` 是刻意的：**不产生任何网络请求**，
         * 否则这次故意的失败会被后面那些"无本站 4xx"断言记在账上
         * （`collectErrors` 看的是整段事件流，实测一个 404 会串到好几页的检查里 ✗）。
         */
        const imgPathsOf = (md) => Array.from(md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)).map((m) => m[1])
        const CLI_IMG_PATHS = imgPathsOf(readFileSync(path.join(ROOT, 'docs', 'CLI-手册.md'), 'utf8'))
        const missingImgFiles = CLI_IMG_PATHS.filter((p) => !existsSync(path.join(DIST, p.replace(/^\//, ''))))
        /**
         * adj957（用户裁定 "删掉"）：`/cli/` 那份手册原先开头有一张 `manual-page.png`
         * ——**手册自己网页的截图**（1440×900、95.6 KB），既帮不上"怎么用"，又在应用内对话框里
         * 必然是一块巨幅图（Markdown 限不了宽）⇒ 连文件一起删了。
         * 所以判据从"至少 1 张"改成"**引用了就必须在 `dist/` 里是真文件**"：0 张合法 ✓。
         */
        check(`adj957 \`/cli/\`：手册引用的 ${CLI_IMG_PATHS.length} 张图片在 \`dist/\` 里都是真文件（手册不放图时 0 张）`,
          missingImgFiles.length === 0, missingImgFiles.join(' '))
        const imgState = await evalJs(
          c,
          `(() => {
            const imgs = [...document.querySelectorAll('#doc-body img')]
            return {
              n: imgs.length,
              ok: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
              srcs: imgs.map((i) => i.getAttribute('src')),
            }
          })()`,
        )
        check(`adj949 \`/cli/\`：正文里 ${imgState?.n ?? 0} 张图**全部真的取到了**（naturalWidth > 0）`,
          (imgState?.ok ?? 0) === (imgState?.n ?? 0), JSON.stringify(imgState))
        const imgNeg = await evalJs(
          c,
          `(async () => {
            /**
             * adj957：手册里现在**一张图都没有**（那张网页截图已删）⇒ 不能再去 querySelector 现成的图，
             * 否则这条负对照会因为"没图可测"而空跑（skip 被当成通过）——那是假绿 ✗。
             * 改成**自己塞一张真图进去**再测：判据与手册里有没有图彻底无关，永远真的在跑 ✓。
             * 用的是站点里已有的 /icons/Jianpu.png（不额外产生本站 4xx）；
             * 故意弄坏的那张是 data: URL（**不产生任何网络请求**，免得被后面"无本站 4xx"的断言记在账上）。
             * ⚠ 这段是**模板字符串**：里面不能出现反引号（会提前结束模板、整份文件语法错误 ✗），
             *   所以上面这些符号一律不加反引号。
             */
            const host = document.getElementById('doc-body')
            if (!host) return { skip: true }
            const img = document.createElement('img')
            img.src = '/icons/Jianpu.png'
            host.appendChild(img)
            await new Promise((r) => setTimeout(r, 700))
            const okBefore = img.complete && img.naturalWidth > 0
            img.src = 'data:image/png;base64,___adj949_broken___'
            await new Promise((r) => setTimeout(r, 700))
            const okAfter = img.complete && img.naturalWidth > 0
            img.remove()
            return { okBefore, okAfter }
          })()`,
        )
        check('adj949 负对照：把图片 src 换成一个坏掉的 `data:` URL（不产生网络请求）⇒ 判据判假（不是"有 img 标签就算过"）',
          imgNeg?.okBefore === true && imgNeg?.okAfter === false,
          JSON.stringify(imgNeg))
      }

      /**
       * ---------------- 窄屏（手机视口）的目录抽屉 ----------------
       *
       * adj905x（**用户实测反馈**）：「手机上点『目录』，面板开在离我很远的上方 —— 点了没反应」。
       *
       * 根因：窄屏下目录是抽屉，而它是 `position: static` 的普通块、DOM 排序在正文**之前** ⇒
       * 你滚到第 5 节再点「目录」，面板其实是展开在**文档最顶部**，视口里什么都没发生。
       * 现在它是**贴在吸顶页眉之下的浮层**（`position: fixed` + `top: var(--site-topbar-h)`），
       * 与首页手机菜单同一手法。
       *
       * 判据都在 390×844 的手机视口下**实测**（不看 CSS 写了什么）：
       *  ① 滚过之后页眉仍吸顶；
       *  ② **滚到中部**点「目录」⇒ 面板必须出现在**视口内**（用户报的就是这一条）；
       *  ③ 点面板里的一条 ⇒ 跳到该标题 + 面板自动收起。
       */
      console.log('[verify-site] 验证窄屏（手机视口）的目录抽屉…')
      await viewport(390, 844, 2)
      /* adj948：四份文档页都过一遍（新增的 `/cli/` 也要有抽屉，否则新页面在手机上点不了目录） */
      for (const [label, url] of [
        ['操作手册', '/manual/'],
        ['脚本语法说明', '/syntax/'],
        ['命令行手册', '/cli/'],
      ]) {
        mark = noteEvents()
        await c.send('Page.navigate', { url: `${origin}${url}` })
        await sleep(1400)
        // 注意：`html` 上有 `scroll-behavior: smooth` ⇒ 必须显式 instant，否则量到的是动画中间态
        await evalJs(c, `window.scrollTo({ top: 1500, behavior: 'instant' })`)
        await sleep(400)
        const scrolled = await evalJs(
          c,
          `(() => {
            const tb = document.querySelector('.doc-topbar')
            return {
              y: Math.round(window.scrollY),
              top: tb ? Math.round(tb.getBoundingClientRect().top) : null,
              btnVisible: !!document.getElementById('toc-toggle'),
            }
          })()`,
        )
        check(`窄屏 ${label}：页眉仍吸顶（滚到 ${scrolled?.y ?? 0}px、top=${scrolled?.top ?? 'n/a'}），且「目录」按钮在手边`,
          !!scrolled && scrolled.y > 0 && scrolled.top === 0 && scrolled.btnVisible, JSON.stringify(scrolled))
        const opened = await evalJs(
          c,
          `(() => {
            const btn = document.getElementById('toc-toggle')
            const toc = document.getElementById('doc-toc')
            if (!btn || !toc) return null
            btn.click()
            const r = toc.getBoundingClientRect()
            return {
              open: toc.classList.contains('open'),
              pos: getComputedStyle(toc).position,
              top: Math.round(r.top),
              bottom: Math.round(r.bottom),
              vh: window.innerHeight,
              inView: r.bottom > 0 && r.top < window.innerHeight,
              links: toc.querySelectorAll('a').length,
            }
          })()`,
        )
        check(`窄屏 ${label}：滚到中部点「目录」⇒ 面板出现在**视口内**（修前它开在文档顶部，看着像点不动）`,
          !!opened && opened.open && opened.inView && opened.links > 0,
          JSON.stringify(opened))
        const tapped = await evalJs(
          c,
          `(() => {
            const a = document.querySelectorAll('#doc-toc a.toc-item')[2]
            if (!a) return null
            const href = a.getAttribute('href')
            a.click()
            return href
          })()`,
        )
        await sleep(1000)
        const afterTap = await evalJs(
          c,
          `(() => {
            const toc = document.getElementById('doc-toc')
            const id = decodeURIComponent(location.hash.slice(1))
            const el = document.getElementById(id)
            return {
              id,
              open: toc ? toc.classList.contains('open') : false,
              y: Math.round(window.scrollY),
              top: el ? Math.round(el.getBoundingClientRect().top) : null,
            }
          })()`,
        )
        check(`窄屏 ${label}：点面板里的条目会跳过去、并且面板自动收起`,
          !!tapped && afterTap.id === tapped.slice(1) && afterTap.y > 0 && !afterTap.open,
          `${tapped} → ${JSON.stringify(afterTap)}`)
        const narrowErrs = collectErrors(mark)
        check(`窄屏 ${label}：无控制台错误 / 无本站 4xx`, narrowErrs.length === 0, narrowErrs.slice(0, 3).join(' | '))
      }

      /**
       * ---------------- adj911（**用户反馈**）：手机端 ` ```jps ` 块被撑得很宽 ----------------
       *
       * 用户原话：「在手机端，网站使用手册的脚本/预览块会变得很宽，这个应限制在窄屏的宽度上」。
       *
       * 这条量的是**真实几何**（不看 CSS 里写了什么）。修前实测（390×844 手机视口，
       * 与上面那组目录抽屉检查同一尺寸）：
       *   `/syntax/`：页面宽 **4347px**、` ```jps ` 块 **4327px** —— 溢出视口 3972px ✗；
       *   `/manual/`：1822px / 1802px。
       *
       * 根因**不在** ` ```jps ` 组件（`help/jpsPreview.css`）：把 `.jps-block` 整块 `display:none`
       * 页面宽度一个字都不变（4347 → 4347）⇒ 它是**受害者**，宽度只是 100% 跟随了被撑宽的列。
       * 源头在 `docs/docs.css` 的**窄屏列定义**（裸 `1fr` 的自动下限 = 内容 min-content），
       * 详见那里 adj911 的注释。所以下面只断言**几何结果**，不锁 CSS 写法。
       *
       * 判据：
       *  ① 页面无横向溢出：`documentElement.scrollWidth ≤ innerWidth + 1`；
       *  ② 页面上**每一个** ` ```jps ` 块的宽度 ≤ 视口宽（取最大值判）；
       *  ③ 「脚本」「预览」**两个标签都量** —— 预览标签会插入引擎渲染的 SVG，是另一条路径。
       */
      console.log('[verify-site] 验证窄屏（手机视口）下 ```jps 块不撑宽页面…')
      await viewport(390, 844, 2)
      /** 量当前页的溢出与所有 ` ```jps ` 块的宽度（`offenders` 只报**未被滚动容器裁掉**的那些） */
      const measureNarrowJps = () =>
        evalJs(
          c,
          `(() => {
            const vw = window.innerWidth
            const cw = document.documentElement.clientWidth
            const blocks = [...document.querySelectorAll('#doc-body .jps-block')]
            const widths = blocks.map((b) => Math.round(b.getBoundingClientRect().width))
            const svgs = blocks.map((b) => Math.round(b.querySelector('.jps-block-preview svg')?.getBoundingClientRect().width ?? 0))
            // 滚动容器（表格、代码块）内部超宽是**设计如此**（自己横滚），不算页面溢出
            const clipped = (el) => {
              for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                if (getComputedStyle(p).overflowX !== 'visible') return true
              }
              return false
            }
            const over = []
            for (const el of document.querySelectorAll('#doc-body *')) {
              const r = el.getBoundingClientRect()
              if (r.width > 0 && r.right > cw + 1 && !clipped(el)) {
                over.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 24) + '@' + Math.round(r.right))
              }
            }
            return {
              vw, cw,
              scrollW: document.documentElement.scrollWidth,
              blocks: widths.length,
              maxBlockW: widths.length ? Math.max(...widths) : null,
              maxSvgW: svgs.length ? Math.max(...svgs) : null,
              svgCount: blocks.filter((b) => b.querySelector('.jps-block-preview svg')).length,
              overCount: over.length,
              offenders: over.slice(0, 4),
            }
          })()`,
        )
      const narrowJpsFits = (m) => !!m && m.scrollW <= m.vw + 1 && m.maxBlockW !== null && m.maxBlockW <= m.vw + 1
      for (const [label, url] of [['操作手册', '/manual/'], ['脚本语法说明', '/syntax/']]) {
        mark = noteEvents()
        await c.send('Page.navigate', { url: `${origin}${url}` })
        await sleep(1600)
        const codeTab = await measureNarrowJps()
        check(`窄屏 ${label}：手机视口（390px）下**没有横向溢出**（判据 scrollWidth ≤ innerWidth + 1）`,
          !!codeTab && codeTab.scrollW <= codeTab.vw + 1,
          `scrollWidth=${codeTab?.scrollW} / 视口=${codeTab?.vw} / 客户端宽=${codeTab?.cw} / 未被裁掉的溢出元素 ${codeTab?.overCount} 个 ${JSON.stringify(codeTab?.offenders)}`)
        check(`窄屏 ${label}：「脚本」标签下**每个** \`\`\`jps 块宽度 ≤ 视口宽（修前 /syntax/ 是 4327px）`,
          !!codeTab && codeTab.blocks > 0 && codeTab.maxBlockW <= codeTab.vw + 1,
          `共 ${codeTab?.blocks} 块，最宽 ${codeTab?.maxBlockW}px / 视口 ${codeTab?.vw}px`)
        const previewClicked = await evalJs(
          c,
          `(() => {
            const b = document.querySelector('#doc-body .jps-block [data-jps-tab="preview"]')
            if (!b) return false
            b.click()
            return true
          })()`,
        )
        let previewSvg = 0
        for (let i = 0; i < 30 && previewSvg === 0; i++) {
          await sleep(300)
          previewSvg = await evalJs(c, `document.querySelectorAll('#doc-body .jps-block .jps-block-preview svg').length`)
        }
        const prevTab = await measureNarrowJps()
        check(`窄屏 ${label}：点「预览」渲染出谱面后**仍然**不溢出（谱面 SVG 也 ≤ 视口宽）`,
          previewClicked && previewSvg > 0 && narrowJpsFits(prevTab) && (prevTab?.maxSvgW ?? 0) <= (prevTab?.vw ?? 0) + 1,
          `svg=${previewSvg} scrollWidth=${prevTab?.scrollW} / 视口=${prevTab?.vw} / 最宽块=${prevTab?.maxBlockW}px / 最宽谱面=${prevTab?.maxSvgW}px`)
      }
      /**
       * 负对照（**必须为假**）：把守这件事的那两条规则"人为放开"（列退回裸 `1fr`、行内代码不折行），
       * 同一判据必须重新变成假 —— 否则说明上面那几条是恒真的空断言。
       */
      const negRules = await evalJs(
        c,
        `(() => {
          const found = []
          const walk = (parent, inNarrow) => {
            const list = parent.cssRules
            if (!list) return
            for (const r of list) {
              /**
               * ⚠ 断点写法要认**两种**：源码里写的是 max-width: 860px，
               * 而构建时 esbuild 会把它压成 width<=860px —— 只认前者，这条在产物上就是**恒假**（本轮实测踩到）。
               */
              if (typeof r.conditionText === 'string') {
                walk(r, inNarrow || /max-width:\\s*860px|width\\s*<=\\s*860px/.test(r.conditionText))
                continue
              }
              if (inNarrow && r.selectorText && /^\\.doc-layout$|^\\.doc-body code$/.test(r.selectorText.trim())) found.push(r.selectorText)
            }
          }
          for (const sheet of document.styleSheets) {
            try { walk(sheet, false) } catch (e) {}
          }
          return found
        })()`,
      )
      check('adj911 守这件事的两条规则确实躺在 **860px 的媒体查询**里（CSSOM 里查得到，没写到桌面规则上）',
        Array.isArray(negRules) && negRules.length >= 2, JSON.stringify(negRules))
      await evalJs(
        c,
        `(() => {
          const s = document.createElement('style')
          s.id = '__negJps'
          s.textContent = '.doc-layout{grid-template-columns:1fr !important}#doc-body code{overflow-wrap:normal !important}'
          document.head.append(s)
        })()`,
      )
      await sleep(250)
      const negMeasured = await measureNarrowJps()
      await evalJs(c, `document.getElementById('__negJps')?.remove()`)
      check('adj911 负对照：把那两条"放开"（列退回裸 `1fr` + 行内代码不折行）⇒ 同一判据为假（证明它真的在守）',
        !narrowJpsFits(negMeasured), JSON.stringify(negMeasured))
      await viewport(1440, 900, 1)

      /**
       * ---------------- adj914（用户要求）：插件手册 / 语法说明的「代码块参数」要能**调着看** ----------------
       *
       * 用户原话：「**插件手册中，代码块参数（`v=` 视图 / `z=` 缩放）这块最好能有调整设置项直观看到
       * 预览效果的设置**」。于是文档里多了一种写法 —— ```jps … playground：
       * 渲染成「控件 + 实时预览」，控件初值取同一行写的 `v=` / `z=`，点「重置」回到它。
       *
       * 这一组量的是**绑定与几何**（不看实现里写了什么）：
       *   ① 控件齐全：三档视图下拉 + 缩放滑块 + 数字输入 + 自适应（`z=*`）勾选 + 重置；
       *   ② 控件初值来自那一行 info string（本例 `v=w z=150`）；
       *   ③ 滚到它就看得见谱面（引擎仍是"进视口才下"）；
       *   ④ 切「满宽」⇒ 实测 SVG 视框**高度**明显变大（满宽保留整页高，谱面裁到墨迹）；
       *   ⑤ 切「整页」⇒ 实测 SVG 视框**宽度**明显变大（整页含左右页边距，满宽把左右裁掉）；
       *   ⑥ 改 `z=` ⇒ 预览的**显示宽度**（实测像素）随之变化；
       *   ⑦ 「重置」把控件与块参数一起拨回初值；
       *   ⑧ **负对照**：把控件与预览的绑定去掉（在断言里 `cloneNode` 一份 —— 克隆不带事件监听，
       *      不是真改文件），同样的"切视图 / 改缩放"动作 ⇒ ④⑤⑥ 的判据必须**全为假**。
       *   另有**手机视口（390）**两条：控件不横向溢出、预览不横向溢出（照 adj911 的写法）。
       *
       * ⚠ 判据一律写成**纯函数**（入参是"实测到的状态"）—— 负对照才能复用同一份判据，
       *   这正是"证明判据真的在量绑定、而不是页面里有没有控件"。
       */
      console.log('[verify-site] 验证 ```jps playground（控件 + 实时预览，adj914）…')
      const PG_ROOT = '#doc-body .jps-playground'
      const PG_NEG = '#doc-body .jps-playground.jps-pg-neg'
      /** 驱动一个控件：`input` 与 `change` 都发（下拉 / 滑块 / 数字 / 勾选四条路都覆盖） */
      const pgDrive = (rootSel, ctrl, value) =>
        evalJs(
          c,
          `(() => {
            const root = document.querySelector(${JSON.stringify(rootSel)})
            const el = root ? root.querySelector(${JSON.stringify(ctrl)}) : null
            if (!el) return null
            if (el.type === 'checkbox') el.checked = ${value ? 'true' : 'false'}
            else el.value = ${JSON.stringify(String(value))}
            for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true }))
            return el.type === 'checkbox' ? String(el.checked) : el.value
          })()`,
        )
      /** 量一份 playground 的当前状态（控件值 + 块参数 + 预览的实测几何） */
      const pgMeasure = (rootSel) =>
        evalJs(
          c,
          `(() => {
            const root = document.querySelector(${JSON.stringify(rootSel)})
            if (!root) return null
            const q = (s) => root.querySelector(s)
            const block = q('.jps-block')
            const svg = q('.jps-block-preview svg')
            const ctl = q('.jps-playground-controls')
            const sel = q('select[data-jps-view]')
            const rng = q('input[type=range][data-jps-zoom-range]')
            const num = q('input[type=number][data-jps-zoom-num]')
            /* viewBox = [x, y, w, h]：④⑤ 两条判据就量它（视框 = 屏幕上真正显示的那块） */
            const vb = (svg ? svg.getAttribute('viewBox') || '' : '').trim().split(/[\\s,]+/).map(Number)
            return {
              hasSelect: !!sel,
              views: sel ? [...sel.options].map((o) => o.value) : [],
              selView: sel ? sel.value : '',
              hasRange: !!rng,
              hasNum: !!num,
              hasAuto: !!q('input[type=checkbox][data-jps-auto]'),
              hasReset: !!q('button[data-jps-reset]'),
              rangeVal: rng ? Number(rng.value) : null,
              numVal: num ? Number(num.value) : null,
              mode: block ? block.dataset.jpsMode : '',
              zoom: block ? block.dataset.jpsZoom : '',
              previewHidden: block ? !!block.querySelector('.jps-block-preview').hidden : null,
              blockCount: root.querySelectorAll('.jps-block').length,
              svgCount: root.querySelectorAll('.jps-block-preview svg').length,
              vb: vb.length === 4 && vb.every((n) => Number.isFinite(n)) ? vb : [],
              svgW: Math.round(svg ? svg.getBoundingClientRect().width : 0),
              ctrlW: ctl ? Math.round(ctl.getBoundingClientRect().width) : 0,
              maxSvgW: Math.max(0, ...[...root.querySelectorAll('.jps-block-preview svg')].map((s) => Math.round(s.getBoundingClientRect().width))),
              pageScrollW: document.documentElement.scrollWidth,
              vw: window.innerWidth,
            }
          })()`,
        )
      /* 纯判据（桌面）：④ 满宽 = 高度明显变大；⑤ 整页 = 宽度明显变大；⑥ 缩放 = 显示宽度真的变了 */
      const pgFullWidthOk = (base, cur) =>
        !!base && !!cur && cur.mode === 'w' && cur.vb.length === 4 && base.vb.length === 4 && cur.vb[3] > base.vb[3] + 20
      const pgPageOk = (base, cur) =>
        !!base && !!cur && cur.mode === 'p' && cur.vb.length === 4 && base.vb.length === 4 && cur.vb[2] > base.vb[2] + 20
      const pgZoomOk = (before, after) => !!before && !!after && after.svgW > before.svgW + 20
      /* 纯判据（窄屏）：控件与预览都不许横向溢出视口 */
      const pgControlsFit = (m) => !!m && m.vw > 0 && m.ctrlW <= m.vw + 1 && m.pageScrollW <= m.vw + 1
      const pgPreviewFit = (m) => !!m && m.vw > 0 && m.maxSvgW <= m.vw + 1 && m.pageScrollW <= m.vw + 1
      const pgBrief = (m) => (m ? JSON.stringify({ mode: m.mode, zoom: m.zoom, vb: m.vb, svgW: m.svgW, ctrlW: m.ctrlW, vw: m.vw }) : 'null')
      /**
       * ---------------- adj916（用户反馈）：可调示例的谱子要**够长** ----------------
       *
       * 用户原话：「插件手册的 代码块参数（`v=` 视图 / `z=` 缩放）这个可测试的示例用一个比较长的示例会更好，
       * 如好茉莉花」。两小节 / 四小节的片段（`Q: 5 5 6 6 | 5 - - - ||`）三档视图几乎一样、缩放也看不出取舍。
       *
       * 量的是**实测几何**：`v=s`（裁到墨迹）下 SVG 视框的**高度** `vb[3]` ——
       * 它单位是谱面像素、**与 `z=` 无关**（缩放只改显示宽度）⇒ 判据不会随控件状态漂。
       * 实测基线（本轮）：两小节片段 **133.6** / 四小节片段 **141.3**；整首《茉莉花》**408.7**。
       * 阈值取 **300**：旧片段连一半都不到（判据真的在量"长度"），新示例留约 1/4 余量
       * （将来排版微调不至于误报，但真要缩回短片必定红灯）。
       */
      const PG_MIN_VB_H = 300
      const pgLongEnough = (m) => !!m && m.mode === 's' && m.vb.length === 4 && m.vb[3] >= PG_MIN_VB_H
      /** 等实测几何满足 pred（重排是异步的，靠固定 sleep 会偶发假红） */
      const pgWaitFor = async (rootSel, pred, tries = 20) => {
        let m = await pgMeasure(rootSel)
        for (let i = 0; i < tries && !pred(m); i++) {
          await sleep(300)
          m = await pgMeasure(rootSel)
        }
        return m
      }
      /**
       * 把 playground 的**源码**在 DOM 里换成另一段（**不改文件**），并触发一次重排；返回换之前的源码。
       * ⚠ 只发**一次** `change`：`applyControls → previewJpsBlock → refreshBlock` 的渲染是异步的，
       *   连发两次会让两份渲染赛跑，先回来的可能是旧参数那一份。
       */
      const pgSwapSource = (text) =>
        evalJs(
          c,
          `(() => {
            const root = document.querySelector(${JSON.stringify(PG_ROOT)})
            if (!root) return null
            const code = root.querySelector('.jps-block-code')
            const sel = root.querySelector('select[data-jps-view]')
            if (!code || !sel) return null
            const before = code.textContent
            code.textContent = ${JSON.stringify(text)}
            sel.value = 's'
            sel.dispatchEvent(new Event('change', { bubbles: true }))
            return before
          })()`,
        )
      /** 负对照用的"旧片段"：adj914 时文档里那两小节 */
      const PG_SHORT_SRC = 'V: 1.0\nB: 参数示例\nD: C\nP: 4/4\nQ: 5 5 6 6 | 5 - - - ||\n'
      /** 滚到 playground 并等它渲染出来（首次渲染是"进视口才下引擎"） */
      const pgReveal = async () => {
        const scrolled = await evalJs(
          c,
          `(() => {
            const root = document.querySelector(${JSON.stringify(PG_ROOT)})
            if (!root) return false
            root.scrollIntoView({ block: 'center', behavior: 'instant' })
            return true
          })()`,
        )
        let seen = 0
        for (let i = 0; i < 30 && seen === 0; i++) {
          await sleep(300)
          // ⚠ 选择器整串交给 JSON.stringify（别写成 `${…} .x'` —— 双引号开、单引号收 = 语法错）
          seen = await evalJs(c, `document.querySelectorAll(${JSON.stringify(PG_ROOT + ' .jps-block-preview svg')}).length`)
        }
        return { scrolled, seen }
      }
      const PG_PAGES = [
        ['插件手册', '/plugin/'],
        ['脚本语法说明', '/syntax/'],
      ]

      // ---- 桌面：控件 + 初值 + 三档视图 + 缩放 + 重置 + 负对照 ----
      await viewport(1440, 900, 1)
      for (const [label, url] of PG_PAGES) {
        mark = noteEvents()
        await c.send('Page.navigate', { url: `${origin}${url}` })
        await sleep(1600)
        const reveal = await pgReveal()
        const init = await pgMeasure(PG_ROOT)
        check(
          `${label}：` + TICKS3 + `jps playground 里有「可调」控件（三档视图下拉 + 缩放滑块 + 数字输入 + 自适应勾选 + 重置）`,
          !!init && init.hasSelect && JSON.stringify(init.views) === JSON.stringify(['s', 'w', 'p']) &&
            init.hasRange && init.hasNum && init.hasAuto && init.hasReset && init.blockCount === 1,
          pgBrief(init) + ' views=' + JSON.stringify(init?.views),
        )
        check(`${label}：控件初值取自这一行的 info string（v=s z=150 ⇒ 下拉 s、滑块与数字 150）`,
          !!init && init.selView === 's' && init.rangeVal === 150 && init.numVal === 150 &&
            init.mode === 's' && init.zoom === '150',
          pgBrief(init))
        check(`${label}：滚到它就直接看得见谱面（预览已渲染、且默认切在「预览」标签）`,
          !!reveal.scrolled && reveal.seen > 0 && !!init && init.svgCount > 0 && init.previewHidden === false,
          `svg=${reveal.seen} hidden=${init?.previewHidden}`)
        /**
         * 负对照（**必须为假**）：克隆一份 playground —— `cloneNode(true)` 只复制 DOM、
         * **不带事件监听**，等价于"把控件与预览的绑定去掉"（不改文件、也不动原控件）。
         * 在克隆上做与下面**完全一样**的两个动作（切「整页」+ 缩放改 200），
         * 然后 **同一对判据**必须都为假。
         */
        const cloned = await evalJs(
          c,
          `(() => {
            const root = document.querySelector(${JSON.stringify(PG_ROOT)})
            if (!root) return false
            const copy = root.cloneNode(true)
            copy.classList.add('jps-pg-neg')
            root.after(copy)
            return true
          })()`,
        )
        const negBefore = await pgMeasure(PG_NEG)
        await pgDrive(PG_NEG, 'select[data-jps-view]', 'p')
        await pgDrive(PG_NEG, 'input[data-jps-zoom-num]', '200')
        await sleep(400)
        const negAfter = await pgMeasure(PG_NEG)
        // 把实测值打出来：负对照"确实为假"要能被人看到（不只靠一个 ✓）
        console.log(`    · 负对照（克隆一份 ⇒ 去掉绑定）实测：${pgBrief(negBefore)} → ${pgBrief(negAfter)}`)
        check(`${label}：负对照 —— 去掉绑定（克隆一份、不带监听）后同样的动作 ⇒ 「整页 / 缩放」两条判据都为假`,
          cloned && !!negBefore && !!negAfter && !pgPageOk(init, negAfter) && !pgZoomOk(negBefore, negAfter),
          `克隆前 ${pgBrief(negBefore)} → 克隆后 ${pgBrief(negAfter)}`)
        await evalJs(c, `document.querySelector(${JSON.stringify(PG_NEG)})?.remove()`)

        // ④ 谱面 ⇒ 满宽（视框高度明显变大）
        await pgDrive(PG_ROOT, 'select[data-jps-view]', 's')
        await sleep(450)
        const scoreView = await pgMeasure(PG_ROOT)
        await pgDrive(PG_ROOT, 'select[data-jps-view]', 'w')
        await sleep(450)
        const fullView = await pgMeasure(PG_ROOT)
        check(`${label}：切「满宽」⇒ 预览真的换成满宽口径（实测 SVG 视框高度明显变大：谱面裁到墨迹、满宽保留整页高）`,
          pgFullWidthOk(scoreView, fullView),
          `谱面 ${pgBrief(scoreView)} → 满宽 ${pgBrief(fullView)}`)
        // ⑤ 满宽 ⇒ 整页（视框宽度明显变大）
        await pgDrive(PG_ROOT, 'select[data-jps-view]', 'p')
        await sleep(450)
        const pageView = await pgMeasure(PG_ROOT)
        check(`${label}：切「整页」⇒ 预览真的换成整页口径（实测 SVG 视框宽度变大：整页含左右页边距，满宽把左右裁掉）`,
          pgPageOk(fullView, pageView),
          `满宽 ${pgBrief(fullView)} → 整页 ${pgBrief(pageView)}`)
        // ⑥ 改 z= ⇒ 显示宽度随之变化（实测像素）
        await pgDrive(PG_ROOT, 'select[data-jps-view]', 'w')
        await sleep(400)
        await pgDrive(PG_ROOT, 'input[data-jps-zoom-num]', '40')
        await sleep(450)
        const zSmall = await pgMeasure(PG_ROOT)
        await pgDrive(PG_ROOT, 'input[data-jps-zoom-num]', '200')
        await sleep(450)
        const zBig = await pgMeasure(PG_ROOT)
        check(`${label}：改 z= ⇒ 预览的**显示宽度**随之变化（实测像素：z=40 与 z=200 不同）`,
          pgZoomOk(zSmall, zBig),
          `z=40 ${pgBrief(zSmall)} → z=200 ${pgBrief(zBig)}`)
        check(`${label}：改 z= 时滑块与数字框**同步**（两个控件是同一个值，不是各写各的）`,
          !!zSmall && !!zBig && zSmall.numVal === 40 && zSmall.rangeVal === 40 && zBig.numVal === 200 && zBig.rangeVal === 200,
          `z=40 range=${zSmall?.rangeVal}/num=${zSmall?.numVal}；z=200 range=${zBig?.rangeVal}/num=${zBig?.numVal}`)
        // ⑦ 「重置」把控件与块参数一起拨回初值
        await pgDrive(PG_ROOT, 'select[data-jps-view]', 'p')
        await sleep(300)
        const resetClicked = await evalJs(
          c,
          `(() => {
            const b = document.querySelector(${JSON.stringify(PG_ROOT)} + ' button[data-jps-reset]')
            if (!b) return false
            b.click()
            return true
          })()`,
        )
        await sleep(450)
        const afterReset = await pgMeasure(PG_ROOT)
        // 三档视图与缩放的**实测几何**（视框 = [x,y,w,h]）——"真的变了"看得见，不必只信 ✓
        console.log(
          `    · 实测几何：谱面 vb=${JSON.stringify(scoreView?.vb)} → 满宽 vb=${JSON.stringify(fullView?.vb)}` +
            ` → 整页 vb=${JSON.stringify(pageView?.vb)}；z=40 ${zSmall?.svgW}px → z=200 ${zBig?.svgW}px`,
        )
        check(`${label}：「重置」把控件与块参数一起拨回这一行写的初值（v=s z=150）`,
          resetClicked && !!afterReset && afterReset.mode === 's' && afterReset.zoom === '150' &&
            afterReset.selView === 's' && afterReset.numVal === 150 && afterReset.rangeVal === 150,
          pgBrief(afterReset))
        const pgErrs = collectErrors(mark)
        check(`${label}：控件区无控制台错误 / 无本站 4xx`, pgErrs.length === 0, pgErrs.slice(0, 3).join(' | '))
        /**
         * ⑧ adj916：示例**够长**（整首《茉莉花》）+ 负对照。
         * 负对照是**真的在浏览器里换源码**（只动 DOM、不改文件）：把示例换成 adj914 那两小节片段 ⇒
         * 同一条判据必须为假；再换回原文 ⇒ 必须又为真（这才证明它量的是**渲染结果**，
         * 而不是"页面上有没有 playground"）。
         */
        const longScore = await pgWaitFor(PG_ROOT, pgLongEnough)
        check(
          `${label}：adj916 可调示例的谱子**够长**（v=s 实测 SVG 视框高度 ≥ ${PG_MIN_VB_H} —— 两小节片段实测只有 134/141，看不出三档视图与缩放的差别）`,
          pgLongEnough(longScore),
          `实测视框高 ${longScore?.vb?.[3]}（阈值 ${PG_MIN_VB_H}）vb=${JSON.stringify(longScore?.vb)}`,
        )
        const origSrc = await pgSwapSource(PG_SHORT_SRC)
        const shortScore = await pgWaitFor(PG_ROOT, (m) => !pgLongEnough(m))
        console.log(`    · 负对照（浏览器里把示例换成两小节片段）实测视框高：${longScore?.vb?.[3]} → ${shortScore?.vb?.[3]}`)
        const restoredSrc = origSrc ? await pgSwapSource(origSrc) : null
        const backScore = await pgWaitFor(PG_ROOT, pgLongEnough)
        check(
          `${label}：adj916 负对照 —— 在浏览器里把示例换成两小节片段（**不改文件**）⇒ 判据为假；换回原文 ⇒ 又为真`,
          !!origSrc && origSrc.includes('茉莉花') && !!shortScore && !pgLongEnough(shortScore) &&
            restoredSrc === PG_SHORT_SRC && pgLongEnough(backScore),
          `原文 ${longScore?.vb?.[3]} → 片段 ${shortScore?.vb?.[3]} → 换回 ${backScore?.vb?.[3]}`,
        )
        if (DO_SHOTS && url === '/plugin/') {
          /**
           * adj916：谱子变长 ⇒ 截图前把可调示例**顶到视口上沿**（原来 `block:'center'` 会上下都切掉），
           * 上沿留 90px 让读者还能看到这一节的说明文字。
           */
          await evalJs(c, `document.querySelector(${JSON.stringify(PG_ROOT)})?.scrollIntoView({ block: 'start', behavior: 'instant' })`)
          await sleep(300)
          await evalJs(c, `window.scrollBy({ top: -90, behavior: 'instant' })`)
          await sleep(300)
          await saveShot('plugin-playground.png', await shoot('png'))
        }
      }

      // ---- 手机视口（390）：控件不溢出、预览不溢出 ----
      await viewport(390, 844, 2)
      for (const [label, url] of PG_PAGES) {
        mark = noteEvents()
        await c.send('Page.navigate', { url: `${origin}${url}` })
        await sleep(1600)
        const reveal = await pgReveal()
        const narrow = await pgMeasure(PG_ROOT)
        check(`窄屏 ${label}：可调示例的**控件不横向溢出**（实测控件条宽与页面 scrollWidth 都 ≤ 视口宽）`,
          !!reveal.scrolled && pgControlsFit(narrow),
          `控件条 ${narrow?.ctrlW}px / 页面 ${narrow?.pageScrollW}px / 视口 ${narrow?.vw}px`)
        check(`窄屏 ${label}：可调示例的**预览不横向溢出**（实测谱面 SVG 宽 ≤ 视口宽，页面不溢出）`,
          reveal.seen > 0 && pgPreviewFit(narrow),
          `谱面 ${narrow?.maxSvgW}px / 页面 ${narrow?.pageScrollW}px / 视口 ${narrow?.vw}px`)
        if (DO_SHOTS && url === '/plugin/') {
          await evalJs(c, `window.scrollBy({ top: -60, behavior: 'instant' })`)
          await sleep(300)
          await saveShot('plugin-playground-mobile.png', await shoot('png'))
        }
      }
      await viewport(1440, 900, 1)

      /**
       * ---------------- adj930（**用户实测反馈**）：官网首屏启动层（消灭 FOUC） ----------------
       *
       * 用户原话：「首页、手册页等这些页面，在 css 还没加载完就开始显示了，结果就是先显示没有格式的
       * 文字版，再闪一下，显示 css 加持的正常版，不美观，建议**先显示背景，一个进度转转，
       * css 所有资源加载完后再正常显示出来**」；追加口径：「背景要与要显示的背景一致，以免又是背景闪动」。
       *
       * 这一组在**真浏览器**里量四件事（每件都配负对照，且判据都是纯函数 ⇒ 负对照复用同一份）：
       *   ① 启动层在**服务端返回的原始 HTML** 里：元素 + **内联** `<style>` 规则 + 深浅两套字面色值，
       *      且外链 CSS 里**没有**它（放外链就等于没防 —— 那正是 FOUC 的形态）；
       *   ② 页面加载完成后启动层**已从 DOM 移除**、正文可见、外部 CSS 真的生效（用 `display:grid` 当探针）；
       *   ③ **慢资源**（CDP `Fetch` 把外链 CSS 扣住约 1s）：这段窗口里启动层**必须还在**、
       *      不透明、铺满视口、与 `html` 同色；放行后**才**揭示（证明"等资源就绪再显示"，不是碰巧）；
       *   ④ **资源失败**（挡掉 `*.css`）与**模块没跑起来**（挡掉 `*.js`）⇒ 照样揭示（超时/失败兜底），
       *      绝不让人对着转圈。
       *
       * ⚠ 启动层的 CSS 是**内联**在各页 `<head>` 里的（唯一口径在 `src/brand/siteBoot.ts`），
       *   所以这里判的是"产物 HTML 里到底有没有" —— 源码级那一半在 `npm run smoke` 的 `[168]` 段。
       * ⚠ 本段会挡 CSS/JS 并产生同源加载失败事件，故**放在所有"无控制台错误"断言之后**（文件末尾附近）。
       */
      console.log('[verify-site] 验证首屏启动层（adj930）…')
      const BOOT_ID = 'ijipu-boot'
      const BOOT_SITES = [
        ['首页', '/'],
        ['操作手册', '/manual/'],
        ['脚本语法说明', '/syntax/'],
        ['插件手册', '/plugin/'],
        /* adj948：新增的 `/cli/` 也要有首屏启动层（那段内联块五页逐字相同） */
        ['命令行手册', '/cli/'],
      ]
      /** 页面里**内联**的 `<style>` 块（外链 CSS 不在此列） */
      const inlineCssOf = (html) =>
        [...String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')
      const externalCssOf = (html) =>
        [...String(html).matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/gi)].map((m) => m[1])
      /** 判据①（纯函数）：启动层内联在 HTML 里，且不依赖 `var(--…)` */
      const bootInlineOk = (html) => {
        const css = inlineCssOf(html).toLowerCase()
        return (
          new RegExp('<div id="' + BOOT_ID + '"[^>]*role="status"[^>]*aria-busy="true"').test(String(html)) &&
          css.includes('#' + BOOT_ID) &&
          css.includes('#0f1526') &&
          css.includes('#f2f5fb') &&
          !css.includes('var(--')
        )
      }
      /** 量当前页的启动层状态（探测外部 CSS 是否生效用 `display:grid`：只有外链样式表里有这条） */
      const bootMeasure = () =>
        evalJs(
          c,
          `(() => {
            const el = document.getElementById(${JSON.stringify(BOOT_ID)})
            const cs = el ? getComputedStyle(el) : null
            const r = el ? el.getBoundingClientRect() : null
            const grid = document.querySelector('.link-grid') || document.querySelector('.doc-layout')
            return {
              present: !!el,
              opacity: cs ? cs.opacity : null,
              bg: cs ? cs.backgroundColor : null,
              /* ⚠ 跟**布局视口**比（documentElement.clientWidth/clientHeight），不要跟 window.innerWidth/Height 比：
                 position: fixed + inset: 0 铺的是布局视口，而 innerWidth 含竖向滚动条
                 ⇒ 首页那种"没 CSS 时很长、一定有滚动条"的页面会被判成"没铺满"（本轮实测踩到） */
              covers:
                !!r &&
                r.width >= document.documentElement.clientWidth - 1 &&
                r.height >= document.documentElement.clientHeight - 1,
              htmlBg: getComputedStyle(document.documentElement).backgroundColor,
              bodyBg: getComputedStyle(document.body).backgroundColor,
              cssApplied: grid ? getComputedStyle(grid).display === 'grid' : null,
              textLen: (document.body.innerText || '').length,
              /* 淡出路径的证据：「prefers-reduced-motion」两态下的 transition 时长（CSS 里两条媒体查询定的） */
              fade: cs ? cs.transitionDuration : null,
              reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
            }
          })()`,
        )
      /** 判据③：揭示前 —— 启动层在、不透明、铺满视口、与 html 同色（同色 ⇒ 淡出时不会二次闪动） */
      const bootVisibleOk = (m) =>
        !!m && m.present === true && m.opacity === '1' && m.covers === true && m.bg === m.htmlBg
      /** 判据②：揭示后 —— 已从 DOM 移除、正文可见、外部 CSS 生效、底色与内联兜底色一致 */
      const bootRevealedOk = (m) =>
        !!m && m.present === false && m.textLen > 200 && m.cssApplied === true && m.bodyBg === m.htmlBg
      const bootBrief = (m) =>
        m
          ? JSON.stringify({
              present: m.present, opacity: m.opacity, bg: m.bg, htmlBg: m.htmlBg, covers: m.covers,
              cssApplied: m.cssApplied, textLen: m.textLen, fade: m.fade, reduce: m.reduce,
            })
          : 'null'
      /** 采样器：从文档一开始就盯着启动层（"首屏就有它"的证据 —— 不是 JS 事后造的） */
      const BOOT_TRACE_SOURCE = `(() => {
        const trace = { seen: false, firstOpacity: null, firstBg: null, htmlBg: null, gone: false, samples: 0 }
        window.__bootTrace = trace
        const tick = () => {
          trace.samples++
          const el = document.getElementById(${JSON.stringify(BOOT_ID)})
          if (el) {
            if (!trace.seen) {
              trace.seen = true
              const cs = getComputedStyle(el)
              trace.firstOpacity = cs.opacity
              trace.firstBg = cs.backgroundColor
              trace.htmlBg = getComputedStyle(document.documentElement).backgroundColor
            }
          } else if (trace.seen) {
            trace.gone = true
          }
        }
        tick()
        const timer = setInterval(tick, 40)
        setTimeout(() => clearInterval(timer), 30000)
      })()`
      /** 等某个实测状态满足判据（重排/揭示都是异步的，靠固定 sleep 会偶发假红） */
      const bootWait = async (pred, tries = 25, gap = 200) => {
        let m = await bootMeasure()
        for (let i = 0; i < tries && !pred(m); i++) {
          await sleep(gap)
          m = await bootMeasure()
        }
        return m
      }
      /** 控制台警告（收集"揭示原因"用）：`console.warn` 一般走 `Runtime.consoleAPICalled`；顺带也扫 `Log` */
      const bootWarnings = (from) => {
        const out = []
        for (const m of c.events.slice(from)) {
          if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'warning') {
            out.push((m.params.args ?? []).map((a) => (a.value != null ? String(a.value) : a.description ?? '')).join(' '))
          }
          if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'warning') {
            out.push(String(m.params.entry.text ?? ''))
          }
        }
        return out
      }

      /**
       * ⚠ **先把 Service Worker 让开**（本轮实测踩到的坑，记在这里免得下次重踩）：
       * `/app/` 那几条检查会注册 `public/sw.js`，它一接管本 origin，外链请求就由 **SW 发起** ——
       * CDP 的 `Fetch` 拦截与 `Network.setBlockedURLs` **都作用不到它**。
       * 实测后果：`Fetch` 扣到 **0** 个请求、CSS 却"已生效"（SW 缓存直接给了），于是
       * "启动层还挡着"与"失败要告警"两条判据一红一假绿。⇒ 这一段开始前：
       * ① 注销该页已注册的 SW 并清掉它的 Cache Storage；② 让网络层**绕过** SW。
       */
      await evalJs(
        c,
        `navigator.serviceWorker && navigator.serviceWorker.getRegistrations().then(function (rs) {
          return Promise.all(rs.map(function (r) { return r.unregister() }))
        }).then(function () {
          return caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k) })) })
        })`,
      )
      await c.send('Network.setBypassServiceWorker', { bypass: true })

      // ---- ① + ②：四页都要有内联启动层，且加载完成后已移除、正文可见 ----
      await viewport(1440, 900, 1)
      for (const [label, url] of BOOT_SITES) {
        const html = await (await fetch(`${origin}${url}`)).text()
        const externals = externalCssOf(html)
        const leaked = []
        for (const href of externals) {
          const body = await (await fetch(href.startsWith('http') ? href : `${origin}${href}`)).text()
          if (body.includes(BOOT_ID)) leaked.push(href)
        }
        check(`adj930 ${label}：启动层**内联**在 HTML 里（元素 + 内联 <style> 的规则 + 深浅两套字面色值，且不用 var(--…)）`,
          bootInlineOk(html), `内联块 ${inlineCssOf(html).length} 字符`)
        check(`adj930 ${label}：启动层样式**不在外链 CSS** 里（外链样式表自己要等网络 ⇒ 放那儿防不住 FOUC）`,
          externals.length > 0 && leaked.length === 0,
          `外链 CSS ${externals.length} 个${leaked.length ? `，其中含启动层的：${leaked.join(', ')}` : ''}`)

        await c.send('Page.navigate', { url: `${origin}${url}` })
        const shown = await bootWait(bootRevealedOk)
        check(`adj930 ${label}：加载完成后启动层**已从 DOM 移除**、正文可见、外部 CSS 真的生效`,
          bootRevealedOk(shown), bootBrief(shown))
      }

      /**
       * ③ 慢资源：把外链 CSS 扣住 ~1.5s，量"这段窗口里启动层必须还在"，
       * 放行后**才**揭示 —— 这是"先显示背景 + 转圈、CSS 到了再显示正文"的直接证据。
       * 顺带出两张图（启动层长什么样 / 揭示后是什么样），首页与 /manual/ 各一对。
       */
      const bootTraceScript = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT_TRACE_SOURCE })
      /** 扣住某类资源：返回 harvest() / continueAll()（全部放行）/ failAll()（全部判失败） */
      const startHold = async (urlPattern) => {
        await c.send('Fetch.enable', { patterns: [{ urlPattern, requestStage: 'Request' }] })
        const held = []
        let cursor = c.events.length
        const harvest = () => {
          for (let i = cursor; i < c.events.length; i++) {
            const m = c.events[i]
            if (m.method === 'Fetch.requestPaused') held.push(m.params.requestId)
          }
          cursor = c.events.length
        }
        return {
          harvest,
          continueAll: async () => {
            harvest()
            for (const requestId of held) await c.send('Fetch.continueRequest', { requestId }).catch(() => {})
            await c.send('Fetch.disable').catch(() => {})
            return held.length
          },
          failAll: async () => {
            harvest()
            for (const requestId of held) {
              await c.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {})
            }
            await c.send('Fetch.disable').catch(() => {})
            return held.length
          },
        }
      }
      /**
       * ③ 慢资源（用户口径的直接证据）：把外链 CSS 扣住约 1s ⇒ 这段窗口里启动层必须还在；
       * 放行后**才**揭示。顺带出两张图（启动层长什么样 / 揭示后是什么样），首页与 /manual/ 各一对。
       *
       * ⚠ 这里把 `prefers-reduced-motion` 模拟成 `no-preference`：本机无头 Chrome **默认就是 `reduce`**
       *   （实测 `matchMedia('(prefers-reduced-motion: reduce)').matches === true`），而那条路径是
       *   "不淡出、直接移除" ⇒ 不模拟就永远量不到"淡出"这条用户口径（实测踩到过一次）。
       */
      await c.send('Emulation.setEmulatedMedia', {
        media: 'screen',
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      })
      for (const [label, url, shotName] of [
        ['首页', '/', 'home'],
        ['操作手册', '/manual/', 'manual'],
      ]) {
        const warnFrom = c.events.length
        const hold = await startHold('*.css')
        await c.send('Page.navigate', { url: `${origin}${url}` })
        /**
         * ⚠ 扣住的总时长必须明显短于启动层的 2.5s 超时：超过就走"超时兜底"那条路，
         *   下面的"没有启动层告警"会红（而那不是缺陷）。
         * ⚠ 这一段**不截图**：外链 CSS 是**渲染阻塞**资源，扣住它浏览器**根本不画第一帧**
         *   ⇒ `Page.captureScreenshot` 会一直等不到帧（本轮实测：CDP 30s 超时把整轮跑挂掉）。
         *   "启动层长什么样"的图改在下面用**扣住模块脚本**（CSS 正常、页面已画出来）的方式拍。
         */
        await sleep(500)
        hold.harvest()
        const held = await bootMeasure()
        check(`adj930 ${label}：**CSS 还没到**时启动层挡在前面（不透明、铺满视口、与 html 同色 ⇒ 看不到没格式的正文）`,
          bootVisibleOk(held), bootBrief(held))
        check(`adj930 ${label}：揭示方式配的是**淡出透明度**（实测 transition 时长 = ${held?.fade}）`,
          !!held && held.fade === '0.22s' && held.reduce === false, bootBrief(held))
        const trace = await evalJs(c, `window.__bootTrace || null`)
        check(`adj930 ${label}：首屏采样确认启动层**一开始就在**（不是 JS 事后造的），且底色与 html 同色`,
          !!trace && trace.seen === true && trace.firstOpacity === '1' && trace.firstBg === trace.htmlBg,
          JSON.stringify(trace))
        const stillHeld = await bootMeasure()
        check(`adj930 ${label}：CSS 一直被扣着时**始终没揭示**（不是"先显示正文、再补样式"）`,
          bootVisibleOk(stillHeld), bootBrief(stillHeld))
        const released = await hold.continueAll()
        check(`adj930 ${label}：这一步真的扣住了外链 CSS（扣 0 个 ⇒ 下面的结论不成立；SW 绕过没生效时就是这样）`,
          released > 0, `扣住 ${released} 个 CSS 请求`)
        const revealed = await bootWait(bootRevealedOk)
        check(`adj930 ${label}：放行 CSS 后**才**揭示（等资源就绪，不是碰巧），且此时外部 CSS 已生效`,
          bootRevealedOk(revealed), bootBrief(revealed))
        const warns = bootWarnings(warnFrom).filter((t) => t.includes('启动层'))
        check(`adj930 ${label}：这一程走的是"资源就绪"正常路径（没有启动层的超时/失败告警）`,
          warns.length === 0, warns.slice(0, 2).join(' | '))
      }
      await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: bootTraceScript.identifier })

      /**
       * ③c **出图**（`--no-shots` 时跳过）：给用户看"启动层长什么样 / 揭示后是什么样"，
       * 首页与 `/manual/` 各一对，落在 `dist-site-shots/boot-*.png`（不入库）。
       *
       * ⚠ 为什么这里扣的是**模块脚本**而不是外链 CSS：CSS 是渲染阻塞资源，扣住它页面**不画第一帧**，
       *   截不到图（③ 那一段已说明）。扣住 `*.js` 时 CSS 正常生效、页面已经画出来了，启动层盖在
       *   **真实的页面**上 —— 这正是用户实际看到的"加载中"那一屏（也顺便证明启动层真的会**被画出来**，
       *   而不只是"计算样式说它在"）。
       */
      if (DO_SHOTS) {
        for (const [label, url, shotName] of [
          ['首页', '/', 'home'],
          ['操作手册', '/manual/', 'manual'],
        ]) {
          const hold = await startHold('*.js')
          await c.send('Page.navigate', { url: `${origin}${url}` })
          await sleep(700)
          hold.harvest()
          const m = await bootMeasure()
          check(`adj930 ${label}（出图）：扣住模块脚本时启动层**盖在已经画出来的页面上**（不透明、铺满、与 html 同色）`,
            bootVisibleOk(m), bootBrief(m))
          await saveShot(`boot-loading-${shotName}.png`, await shoot('png'))
          const released = await hold.continueAll()
          const revealed = await bootWait(bootRevealedOk)
          check(`adj930 ${label}（出图）：放行脚本（${released} 个）后揭示，再拍一张"揭示后"的首屏`,
            released > 0 && bootRevealedOk(revealed), bootBrief(revealed))
          await saveShot(`boot-revealed-${shotName}.png`, await shoot('png'))
        }
      }

      /**
       * ③b `prefers-reduced-motion: reduce`（用户口径：**不淡出、直接移除**）。
       * 量的是"过渡时长实测为 0"（那正是那条 CSS 的作用），而不是"源码里有没有写"。
       */
      {
        await c.send('Emulation.setEmulatedMedia', {
          media: 'screen',
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        })
        const hold = await startHold('*.css')
        await c.send('Page.navigate', { url: `${origin}/` })
        await sleep(500)
        hold.harvest()
        const held = await bootMeasure()
        const released = await hold.continueAll()
        const gone = await bootWait((x) => !!x && x.present === false, 20, 200)
        check('adj930 reduced-motion：模拟 `reduce` 时过渡时长实测为 `0s`（不淡出、直接移除）',
          !!held && held.reduce === true && held.fade === '0s' && released > 0 && !!gone && gone.present === false,
          `扣住 ${released} 个 / ${bootBrief(held)} → ${bootBrief(gone)}`)
        await c.send('Emulation.setEmulatedMedia', {
          media: 'screen',
          features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
        })
      }

      /**
       * ④ 失败兜底 A（**资源失败**）：让外链 CSS 在模块**装上监听之后**失败（`Fetch.failRequest`）——
       * 走的是"任一资源失败 ⇒ 照样揭示"那条路（而不是 2.5s 超时那条）。判据里带上耗时：
       * 超时路径至少要 2.5s+，失败路径应当在 1s 量级就揭示。
       */
      {
        const warnFrom = c.events.length
        const hold = await startHold('*.css')
        const t0 = Date.now()
        await c.send('Page.navigate', { url: `${origin}/manual/` })
        await sleep(450)
        const failed = await hold.failAll()
        const m = await bootWait((x) => !!x && x.present === false, 20, 200)
        const elapsed = Date.now() - t0
        const warns = bootWarnings(warnFrom).filter((t) => t.includes('启动层'))
        check('adj930 资源失败兜底：外链 CSS 加载失败时**照样揭示**（不让用户对着转圈），页面不白屏',
          failed > 0 && !!m && m.present === false && m.textLen > 200,
          `让 ${failed} 个 CSS 请求失败；${bootBrief(m)}`)
        check(`adj930 资源失败兜底：走的是**失败**那条路（${elapsed}ms 就揭示了，明显早于 2.5s 超时）`,
          failed > 0 && elapsed < 2200, `${elapsed}ms`)
        check('adj930 资源失败兜底：失败原因被写进 console（`console.warn` 里点了启动层与失败）',
          warns.length > 0 && warns.some((t) => t.includes('失败')), warns.slice(0, 2).join(' | '))
        await c.send('Page.navigate', { url: `${origin}/manual/` })
        const back = await bootWait(bootRevealedOk)
        check('adj930 资源失败兜底：下一次正常打开就恢复（启动层移除 + CSS 生效，可逆）',
          bootRevealedOk(back), bootBrief(back))
      }

      /**
       * ⑤ 失败兜底 B（**模块压根没跑起来**）：挡掉 `*.js` ⇒ `siteBoot.ts` 永远不会执行，
       * 那 2.5s 的超时定时器根本不存在 —— 这时靠的是 `<head>` 内联脚本里那条 8s 硬兜底。
       * 这一条量的是"绝不卡死"的最后一道保险（所以它**必然**要等 8s 以上）。
       */
      {
        await c.send('Network.setBlockedURLs', { urls: ['*.js'] })
        await c.send('Page.navigate', { url: `${origin}/` })
        await sleep(400)
        const early = await bootMeasure()
        const late = await bootWait((x) => !!x && x.present === false, 60, 300)
        check('adj930 模块没跑起来兜底：脚本被挡掉时启动层一开始在、约 8s 后由**内联硬兜底**摘掉（绝不永远转圈）',
          !!early && early.present === true && !!late && late.present === false,
          `一开始 present=${early?.present} → 之后 ${bootBrief(late)}`)
        await c.send('Network.setBlockedURLs', { urls: [] })
        await c.send('Page.navigate', { url: `${origin}/` })
        await bootWait(bootRevealedOk, 15, 200)
      }

      /**
       * ⑥ 负对照（**必须为假**）：判据必须真的在量"HTML 里那份内联块"与"DOM 里那个元素"，
       * 而不是恒真的空话。两条：
       *   · 把服务端返回的 HTML 里的内联样式删掉（＝"改成依赖外部 CSS"的形态）⇒ 判据①为假；
       *   · 在**活的 DOM** 里塞一个假的 `#ijipu-boot`（模拟"揭示后没删干净"）⇒ 判据②为假。
       */
      {
        const html = await (await fetch(`${origin}/`)).text()
        const noInline = html.replace(/<style[\s\S]*?<\/style>/gi, '')
        check('adj930 负对照：删掉内联样式（改成依赖外部 CSS）⇒ "启动层内联"判据为假（内联是硬要求）',
          noInline !== html && !bootInlineOk(noInline) && bootInlineOk(html))
        const injected = await evalJs(
          c,
          `(() => {
            const el = document.createElement('div')
            el.id = ${JSON.stringify(BOOT_ID)}
            document.body.append(el)
            return true
          })()`,
        )
        const dirty = await bootMeasure()
        await evalJs(c, `document.getElementById(${JSON.stringify(BOOT_ID)})?.remove()`)
        const clean = await bootMeasure()
        check('adj930 负对照：往 DOM 里塞一个残留启动层 ⇒ "已从 DOM 移除"判据为假（这条真的在看 DOM）',
          injected === true && !bootRevealedOk(dirty) && bootRevealedOk(clean),
          `残留时 ${bootBrief(dirty)} → 清掉后 ${bootBrief(clean)}`)
      }

      // ---------------- 负对照：确认"验证器真的在量东西" ----------------
      console.log('[verify-site] 负对照…')
      const missing = await fetch(`${origin}/definitely-not-a-page/`)
      check('负对照：不存在的路径确实 404（说明静态服务没有偷偷兜底成 200）', missing.status === 404, String(missing.status))
      const shellRes = await fetch(`${origin}/app/`)
      const shellBody = await shellRes.text()
      // 用产物里的特征判断（首页产物有 `class="hero"`，应用外壳有 `id="root"`）
      check('负对照：`/app/` 返回的是**应用外壳**而不是首页',
        shellBody.includes('id="root"') && !shellBody.includes('class="hero"'))
    }
  } catch (e) {
    console.error(`[verify-site] ❌ 脚本异常：${e?.message ?? e}`)
    await cleanup(1)
    return
  }

  c.close()
  console.log('')
  if (DO_CHECKS) {
    console.log(`[verify-site] 断言 ${passed} 通过 / ${failed} 失败`)
    if (failed > 0) {
      console.log('失败项：')
      for (const f of failures) console.log(`  · ${f}`)
    } else {
      console.log('[verify-site] 全部通过 ✅')
    }
  } else {
    console.log('[verify-site] 只截图模式：完成')
  }
  await cleanup(failed > 0 ? 1 : 0)
}

main()
