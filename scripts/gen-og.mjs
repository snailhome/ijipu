/**
 * scripts/gen-og.mjs — 给每份曲库条目生成 1200×630 的分享卡 `og.png`（adj1191，P1）
 *
 * 为什么是**本地脚本**而不是构建期生成：
 *  · 分享卡要真浏览器排版（字体、渐变、`object-fit`），Node 里没有 canvas；
 *  · Cloudflare Pages 的构建镜像里有没有 Chrome 我没验证，不该把构建押在它身上。
 * ⇒ 本地 `npm run build` 之后跑 `npm run score:og`，把 PNG 生成到
 *   `public/scores/<slug>/og.png` **并提交**；CI 只检查文件存在、原样复制。
 *
 * 用法：
 *   npm run build        # 先有 dist（详情页/封面）
 *   npm run score:og     # 生成 8 张 og.png
 *   npm run build        # 让 og:image 指到刚生成的 PNG
 *
 * ⚠ 本文件是 `.mjs`，用 Node 22 内置的 WebSocket / fetch，不引依赖。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = process.cwd()
const DIST = join(ROOT, 'dist')
const SCORES = join(ROOT, 'public/scores')
const PORT = 9336
const WIDTH = 1200
const HEIGHT = 630

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('[og] 找不到 dist/index.html；先跑 `npm run build` 再生成分享卡。')
  process.exit(1)
}

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
const CHROME = chromeCandidates.find((p) => existsSync(p))
if (!CHROME) {
  console.error('[og] 没找到 Chrome/Edge，无法生成分享卡。')
  process.exit(1)
}

/** 读条目（只读 title/composer/tags/license/source/slug） */
const entries = readdirSync(SCORES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map((dir) => {
    const meta = JSON.parse(readFileSync(join(SCORES, dir, 'meta.json'), 'utf8'))
    return { dir, meta }
  })
  .filter((e) => e.meta.status !== 'retired')

const LICENSE_LABEL = {
  PD: '公版',
  ORIGINAL: '原创',
  AUTHORIZED: '已授权',
  'CC-BY-4.0': 'CC BY 4.0',
  'CC-BY-NC-SA-4.0': 'CC BY-NC-SA 4.0',
  EXCERPT: '教学片段',
}

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 分享卡 HTML：左文字 + 右谱面缩略；全部内联，只有封面图走站点相对路径 */
function cardHtml(meta) {
  const tags = (meta.tags ?? []).slice(0, 4)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#0F1526;color:#E8ECF8;
       font-family:system-ui,"Microsoft YaHei","PingFang SC",sans-serif;
       background-image:radial-gradient(900px 420px at 92% -12%,rgba(0,240,255,.22),transparent 62%),
                        radial-gradient(760px 400px at 2% 110%,rgba(30,42,94,.98),transparent 62%)}
  .wrap{display:flex;height:100%;padding:54px 58px;gap:40px;align-items:center}
  .left{flex:1 1 auto;min-width:0}
  .brand{display:flex;align-items:center;gap:12px;font-size:22px;color:#93A0C8;margin-bottom:18px}
  .brand img{width:32px;height:32px;border-radius:7px}
  .brand b{color:#00F0FF}
  .kicker{font-size:16px;letter-spacing:.18em;color:#00F0FF;margin-bottom:12px}
  h1{font-size:62px;line-height:1.16;letter-spacing:.02em;
     background:linear-gradient(96deg,#fff 24%,#00F0FF 104%);-webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{margin-top:16px;font-size:25px;color:#93A0C8}
  .tags{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
  .tag{padding:5px 14px;border:1px solid #24315E;border-radius:999px;color:#93A0C8;font-size:17px}
  .badge{display:inline-block;margin-top:22px;padding:5px 15px;border:1px solid rgba(0,240,255,.6);border-radius:999px;
         color:#00F0FF;font-size:17px}
  .foot{margin-top:26px;font-size:16px;color:#5A6A99}
  .right{flex:0 0 430px;height:392px;border:1px solid #24315E;border-radius:16px;overflow:hidden;
         background:#fff;box-shadow:0 18px 50px rgba(0,0,0,.45);padding:16px}
  .right img{width:100%;height:100%;object-fit:contain}
  </style></head><body><div class="wrap">
    <div class="left">
      <div class="brand"><img src="/icons/Jianpu.png" alt=""> 爱记谱 <b>iJipu</b></div>
      <div class="kicker">JPS 乐谱</div>
      <h1>${esc(meta.title)}</h1>
      <p class="sub">${esc(meta.composer)}</p>
      <div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="badge">${esc(meta.license === 'PD' ? '公版 · 记谱 CC BY-NC-SA 4.0' : (LICENSE_LABEL[meta.license] ?? '查看许可证'))}</div>
      <div class="foot">https://ijipu.pages.dev · 看源码 / 听效果 / 在应用里编辑</div>
    </div>
    <div class="right"><img src="/scores/${esc(meta.slug)}/cover.svg" alt=""></div>
  </div></body></html>`
}

/* ---------------- 静态服务器：dist + 动态 /__card/<slug> ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const m = /^\/__card\/([a-z0-9-]+)\/?$/.exec(url.pathname)
  if (m) {
    const meta = entries.find((e) => e.dir === m[1])?.meta
    if (!meta) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(cardHtml(meta))
    return
  }
  let p = decodeURIComponent(url.pathname)
  if (p.endsWith('/')) p += 'index.html'
  const abs = normalize(join(DIST, p))
  if (!abs.startsWith(DIST + sep) || !existsSync(abs) || !statSync(abs).isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream' })
  res.end(readFileSync(abs))
})

await new Promise((res) => server.listen(PORT, '127.0.0.1', res))
console.log(`[og] 本地服务 http://127.0.0.1:${PORT}/`)

/* ---------------- CDP ---------------- */
const child = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT + 1}`,
    '--user-data-dir=' + join(tmpdir(), 'ijipu-og-chrome'),
    '--no-first-run',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function tabs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)
      if (r.ok) return await r.json()
    } catch {
      /* wait */
    }
    await sleep(200)
  }
  throw new Error('[og] Chrome CDP 没起来')
}
const list = await tabs()
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let nextId = 1
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
    else p.resolve(msg.result)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(nextId, { resolve, reject })
    ws.send(JSON.stringify({ id: nextId++, method, params }))
  })

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
})

for (const { dir, meta } of entries) {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/__card/${dir}` })
  await sleep(1200)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const out = join(SCORES, dir, 'og.png')
  mkdirSync(join(SCORES, dir), { recursive: true })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`[og] ${dir}: ${meta.title} → public/scores/${dir}/og.png`)
}

ws.close()
child.kill()
server.close()
console.log(`[og] 完成：${entries.length} 张。再跑一次 \`npm run build\` 让 og:image 指到它们。`)
