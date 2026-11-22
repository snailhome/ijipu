/**
 * verify-tools.mjs — `/tools/`（音视频工具页）的**真浏览器实测**（`adj1316`）
 *
 * ## 为什么单独一个脚本
 *
 * `smoke` 只能钉住"源码长什么样"（文件在、文案在、不 import 引擎）。可这一页的四件事
 * 全在**浏览器里**才成立：
 *   · 三个页签点得动、切过去不卸载（`hidden` 而不是条件渲染）；
 *   · 拖一段音频进来**真的画出波形**（`decodeAudioData` + canvas，Node 里没有这些）；
 *   · 在波形上拖出选区 → 加一段标记 → 导出**真的落下一个文件**（`<a download>` 这条路
 *     源码级断言永远证明不了"点了有东西下来"）；
 *   · 没选视频就点「生成」，要给一句人话，不许白屏或抛到控制台。
 *
 * 与 `verify-app-ui.mjs` 同一套底座（自起静态服务 + headless Chrome + 极简 CDP），
 * 只是**不碰应用**：这一页刻意不 import `@ijipu/engine`、也不读应用的 store。
 *
 * ## 前置
 *
 * 先 `npm run build`（脚本只读 `dist/`）。跑法：`npm run verify:tools`。
 */
import { createServer } from 'node:http'
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const DL = path.join(tmpdir(), `ijipu-tools-dl-${Date.now()}`)
const SHOT = path.join(ROOT, '.dsh-tmp', 'tools-clip.png')
const SHOT_LIGHT = path.join(ROOT, '.dsh-tmp', 'tools-clip-light.png')
/** adj1319：复听时那根金色定位虚线，单独留一张（汇报时看得到） */
const SHOT_ANCHOR = path.join(ROOT, '.dsh-tmp', 'tools-anchor.png')

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
let passed = 0
function check(label, ok, extra = '') {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
}

/** `dist/` 里按 URL 找文件；目录回退 `index.html`；越界/不存在一律 null */
function resolveDistFile(urlPath) {
  let rel = urlPath.split('?')[0]
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html'
  const abs = path.join(DIST, decodeURIComponent(rel).replace(/^\//, ''))
  if (!abs.startsWith(DIST) || !existsSync(abs) || !statSync(abs).isFile()) return null
  return abs
}

/** 极简 CDP over WebSocket（Node 22 内置 WebSocket），与 verify-app-ui / verify-site 同一套 */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
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
    }
  })
  return {
    ready,
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

async function waitFor(c, expression, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(c, expression)) return true
    await sleep(150)
  }
  throw new Error(`等待超时：${label}`)
}

/** 元素中心的视口坐标（`Input.dispatchMouseEvent` 用的是视口坐标，不是文档坐标） */
async function centerOf(c, selector, index = 0) {
  return evalJs(
    c,
    `(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height }
    })()`,
  )
}

/** 真点一下（走浏览器原生输入路径，不用 element.click()） */
async function tap(c, selector, index = 0) {
  const p = await centerOf(c, selector, index)
  if (p === null) throw new Error(`点不到：${selector}[${index}]`)
  const base = { button: 'left', clickCount: 1, buttons: 1 }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, ...base, buttons: 0 })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, ...base })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, ...base, buttons: 0 })
  await sleep(120)
}

/** 在波形上从 `from` 拖到 `to`（都是画布内的相对比例 0..1） */
async function dragWave(c, from, to) {
  const p = await evalJs(
    c,
    `(() => {
      const el = document.querySelector('.t-wave')
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, w: r.width, h: r.height }
    })()`,
  )
  if (p === null) throw new Error('拖不到：.t-wave')
  const y = Math.round(p.top + p.h / 2)
  const x0 = Math.round(p.left + p.w * from)
  const x1 = Math.round(p.left + p.w * to)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y, button: 'left', buttons: 0 })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 6; i++) {
    await c.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x0 + ((x1 - x0) * i) / 6),
      y,
      button: 'left',
      buttons: 1,
    })
    await sleep(30)
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(200)
}

/**
 * 选区文案（`0:01.049 → 0:01.799（0:00.750）`）→ 秒数。像素取整会差几毫秒，断言必须带容差。
 */
function secsOf(text) {
  const hits = String(text ?? '').match(/\d+:\d+\.\d+/g) ?? []
  return hits.map((s) => {
    const [m, rest] = s.split(':')
    return Number(m) * 60 + Number(rest)
  })
}

/** 两个秒数是否在 `tol` 之内（缺值一律算不匹配） */
function near(a, b, tol = 0.02) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol
}

/**
 * 在波形上按一下（可选挪到 `moveTo` 再抬起）。
 * `ratio` / `moveTo` 都是画布内的相对位置（0..1）。只有按下-抬起而没移动 ⇒ 就是"点一下"。
 */
async function pressWave(c, ratio, moveTo = null) {
  const p = await evalJs(
    c,
    `(() => {
      const el = document.querySelector('.t-wave')
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, w: r.width, h: r.height }
    })()`,
  )
  if (p === null) throw new Error('点不到：.t-wave')
  const y = Math.round(p.top + p.h / 2)
  const x0 = Math.round(p.left + p.w * ratio)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y, button: 'left', buttons: 0 })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y, button: 'left', buttons: 1, clickCount: 1 })
  if (moveTo !== null) {
    const x1 = Math.round(p.left + p.w * moveTo)
    for (let i = 1; i <= 6; i++) {
      await c.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(x0 + ((x1 - x0) * i) / 6),
        y,
        button: 'left',
        buttons: 1,
      })
      await sleep(30)
    }
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y, button: 'left', buttons: 0, clickCount: 1 })
  } else {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  await sleep(200)
}

/** 造一段 3 秒的 440Hz WAV 塞进文件框（等于用户选了文件；走 input.files + change 这条真路） */
const INJECT_WAV = `(() => {
  const sr = 44100
  const seconds = 3
  const n = sr * seconds
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const put = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  put(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); put(8, 'WAVE')
  put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  put(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 2000, (n - i) / 2000)
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000 * fade), true)
  }
  const file = new File([buf], '测试音.wav', { type: 'audio/wav' })
  const input = document.querySelectorAll('.t-panel')[2].querySelector('input[type=file]')
  if (!input) return 'no-input'
  const dt = new DataTransfer()
  dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
})()`

async function main() {
  if (!existsSync(path.join(DIST, 'tools', 'index.html'))) {
    console.error(`[verify-tools] 找不到 ${path.join(DIST, 'tools', 'index.html')} —— 先跑 npm run build`)
    process.exit(2)
  }
  const chrome = CHROME_CANDIDATES.find((p) => p !== '' && existsSync(p))
  if (!chrome) {
    console.error('[verify-tools] 找不到 Chrome（本脚本只走真浏览器，不替代 smoke）')
    process.exit(2)
  }
  rmSync(DL, { recursive: true, force: true })
  mkdirSync(DL, { recursive: true })

  const server = createServer((req, res) => {
    const file = resolveDistFile(String(req.url ?? '/'))
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

  const profile = path.join(tmpdir(), `ijipu-tools-ui-${Date.now()}`)
  const debugPort = 9900 + Math.floor(Math.random() * 90)
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
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,900',
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
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    process.exit(code)
  }

  let target = null
  for (let i = 0; i < 60 && target === null; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      target = list.find((t) => t.type === 'page') ?? null
    } catch {
      await sleep(200)
    }
  }
  if (target === null) {
    console.error('[verify-tools] 连不上 headless Chrome')
    await cleanup(2)
  }

  const c = cdp(target.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  await c.send('Runtime.enable')
  await c.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL })

  try {
    await c.send('Page.navigate', { url: `${origin}/tools/` })
    await waitFor(c, `document.querySelectorAll('.t-tab').length === 3`, '三个页签')

    const tabs = await evalJs(c, `[...document.querySelectorAll('.t-tab')].map((b) => b.textContent.trim())`)
    check(
      'adj1316 页签三条：音视频合并 / 有声视频拆分 / 音频片段截取',
      JSON.stringify(tabs) === JSON.stringify(['音视频合并', '有声视频拆分', '音频片段截取']),
      JSON.stringify(tabs),
    )

    const defaultTab = await evalJs(
      c,
      `(() => {
        const ps = [...document.querySelectorAll('.t-panel')]
        return { count: ps.length, visible: ps.findIndex((p) => !p.hidden) }
      })()`,
    )
    check('adj1316 首屏落在「音视频合并」，三个面板都在 DOM 里（切页签不卸载）',
      defaultTab.count === 3 && defaultTab.visible === 0, JSON.stringify(defaultTab))

    await tap(c, '.t-tab', 2)
    check('adj1316 点「音频片段截取」⇒ 切过去的是第 3 个面板（且前两个只是 hidden）',
      await evalJs(c, `(() => {
        const ps = [...document.querySelectorAll('.t-panel')]
        return ps[2].hidden === false && ps[0].hidden === true && ps[1].hidden === true && ps.length === 3
      })()`))

    // ---- 载入一段合成音频：波形必须真的画出来 ----
    const injected = await evalJs(c, INJECT_WAV)
    check('adj1316 文件框塞进一段 3 秒 WAV（走 input.files + change，等于用户选了文件）', injected === 'ok', injected)
    await waitFor(c, `!!document.querySelector('.t-wave')`, '波形出现')
    await waitFor(c, `document.body.textContent.includes('已载入')`, '载入完成提示')

    const wavePainted = await evalJs(
      c,
      `(() => {
        const cv = document.querySelector('.t-wave')
        const ctx = cv.getContext('2d')
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data
        let dark = 0
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 250) dark++
        return { painted: dark, w: cv.width, h: cv.height }
      })()`,
    )
    check('adj1316 波形真的画在 canvas 上（不是空白画布）',
      wavePainted.painted > 500, JSON.stringify(wavePainted))

    // ---- 拖出选区 → 加一段标记 ----
    await dragWave(c, 0.2, 0.6)
    const selText = await evalJs(c, `document.querySelector('.t-sel .t-mono').textContent.trim()`)
    check('adj1316 在波形上按住拖一下 ⇒ 出现选区（不再是"还没有选区"）',
      selText !== '' && !selText.includes('还没有选区'), selText)

    /**
     * adj1317（用户 2026-11-18）：「标记段的起止点应该单独可添加、可选取调整，播放标记段；
     * 现在选择后再点波形，原来的选取又没了」。下面几条把新口径逐条量一遍。
     */
    const selBefore = await evalJs(c, `document.querySelector('.t-sel .t-mono').textContent.trim()`)
    await pressWave(c, 0.9)
    const selAfterClick = await evalJs(c, `document.querySelector('.t-sel .t-mono').textContent.trim()`)
    check('adj1317 选区定好后再点一下波形 ⇒ 只挪播放头，选区原样留着',
      selAfterClick === selBefore, `${selBefore} → ${selAfterClick}`)

    // 抓起点那条边（0.2 处）拖到 0.35：终点不许跟着动
    await pressWave(c, 0.2, 0.35)
    const afterGrip = await evalJs(c, `document.querySelector('.t-sel .t-mono').textContent.trim()`)
    const gripSecs = secsOf(afterGrip)
    check('adj1317 抓住起点边拖 ⇒ 起点变、终点不动（两条边各自独立）',
      near(gripSecs[0], 1.05) && near(gripSecs[1], 1.799), afterGrip)

    // 把播放头点到 1.5 秒（还在选区内），再按「起点＝播放头」
    await pressWave(c, 0.5)
    const dropHead = await evalJs(
      c,
      `(() => {
        const b = [...document.querySelectorAll('.t-panel')[2].querySelectorAll('button')]
          .find((x) => x.textContent.includes('起点＝播放头'))
        if (!b) return 'no-button'
        b.click()
        return 'clicked'
      })()`,
    )
    const afterHead = await evalJs(c, `document.querySelector('.t-sel .t-mono').textContent.trim()`)
    const headSecs = secsOf(afterHead)
    check('adj1317 「起点＝播放头」把起点单独落到播放头（不先拖选区也能定，终点不动）',
      dropHead === 'clicked' && near(headSecs[0], 1.5) && near(headSecs[1], 1.799),
      `${dropHead} / ${afterHead}`)

    const addLabel = await evalJs(
      c,
      `(() => {
        const b = [...document.querySelectorAll('.t-panel')[2].querySelectorAll('button')]
          .find((x) => x.textContent.includes('把选区加成一段'))
        if (!b) return 'no-button'
        b.click()
        return 'clicked'
      })()`,
    )
    check('adj1316 有「把选区加成一段」按钮', addLabel === 'clicked', addLabel)
    await waitFor(c, `document.querySelectorAll('.t-marks li').length === 1`, '标记段出现')
    const markName = await evalJs(c, `document.querySelector('.t-marks li .t-input').value`)
    check('adj1316 新标记段自动叫「段 1」', markName === '段 1', markName)

    // ---- 标记段能单独播放（adj1317 用户要求）----
    await tap(c, '.t-panel:nth-child(3) .t-marks li .t-btn', 0)
    const playingText = await evalJs(
      c,
      `document.querySelectorAll('.t-panel')[2].querySelector('.t-btn-run').textContent.trim()`,
    )
    check('adj1317 点标记段那一行的「播放」⇒ 主播放键变成「暂停」（确实在放这一段）',
      playingText === '暂停', playingText)

    /**
     * adj1318：播放/试听/定位这一套从爱出片搬过来 —— 复听按钮（前 3 秒 / 后 5 秒循环）
     * 点下去要亮起（`is-on`），时间标尺要真画在画布上（标尺底色在画布最下 16 像素内）：
     * 判据用"画布底部那一行的像素里有标尺底色"，而不是只看 DOM，避免退化成空画布。
     */
    const auditionClicked = await evalJs(
      c,
      `(() => {
        const b = [...document.querySelectorAll('.t-panel:nth-child(3) .t-btn')].find((x) => x.textContent.includes('复听'))
        if (b === undefined) return 'missing'
        b.click()
        return 'clicked'
      })()`,
    )
    // 点完要等 React 重渲染完再读 className（同一个 tick 里读到的还是旧 class）
    await new Promise((r) => setTimeout(r, 200))
    const auditionOn = await evalJs(
      c,
      `(() => {
        const b = [...document.querySelectorAll('.t-panel:nth-child(3) .t-btn')].find((x) => x.textContent.includes('复听'))
        return b === undefined ? 'missing' : b.className
      })()`,
    )
    const rulerPainted = await evalJs(
      c,
      `(() => {
        const cv = document.querySelector('.t-panel:nth-child(3) canvas.t-wave')
        const ctx = cv.getContext('2d')
        const d = ctx.getImageData(0, cv.height - 4, cv.width, 1).data
        let nonzero = 0
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 0) nonzero += 1
        return { row: nonzero, width: cv.width }
      })()`,
    )
    check(
      'adj1318 复听点下去要亮起（前 3 秒 / 后 5 秒循环），波形底部有画出来的时间标尺',
      auditionClicked === 'clicked' &&
        auditionOn.includes('is-on') &&
        rulerPainted.row > rulerPainted.width * 0.9,
      `${auditionOn} / 标尺像素 ${rulerPainted.row}/${rulerPainted.width}`,
    )
    /**
     * adj1319（用户：「点击复听时，应在开始点击按钮前的当前位置添加一个临时时点定位虚线」）：
     * 复听按钮亮着的时候，画布顶部要有一小撮**金色**像素 —— 那就是锚点虚线的三角头
     * （深色主题 `#ffd166` = 255,209,102）。纯 DOM 看不出来，只能读画布。
     */
    const anchorPixels = await evalJs(
      c,
      `(() => {
        const cv = document.querySelector('.t-panel:nth-child(3) canvas.t-wave')
        const d = cv.getContext('2d').getImageData(0, 1, cv.width, 1).data
        let gold = 0
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 220 && d[i + 1] > 170 && d[i + 1] < 232 && d[i + 2] < 150) gold += 1
        }
        return gold
      })()`,
    )
    check('adj1319 点「复听」会在当时的位置留一根金色定位虚线（画布顶部读得到金色像素）',
      anchorPixels > 0, `金色像素 ${anchorPixels}`)
    // 顺手留一张"复听中"的截图，汇报用（此时波形上有金色虚线、复听按钮是亮的）
    const shotAnchor = await c.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(SHOT_ANCHOR, Buffer.from(shotAnchor.data, 'base64'))

    // 关掉复听，别影响后面的用例
    await evalJs(
      c,
      `(() => {
        const b = [...document.querySelectorAll('.t-panel:nth-child(3) .t-btn')].find((x) => x.textContent.includes('复听'))
        if (b !== undefined && b.className.includes('is-on')) b.click()
      })()`,
    )
    await new Promise((r) => setTimeout(r, 150))
    const anchorGone = await evalJs(
      c,
      `(() => {
        const cv = document.querySelector('.t-panel:nth-child(3) canvas.t-wave')
        const d = cv.getContext('2d').getImageData(0, 1, cv.width, 1).data
        let gold = 0
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 220 && d[i + 1] > 170 && d[i + 1] < 232 && d[i + 2] < 150) gold += 1
        }
        return gold
      })()`,
    )
    check('adj1319 关重复听 ⇒ 那根金色虚线跟着消失（不再留一根看不懂的线）', anchorGone === 0, `金色像素 ${anchorGone}`)

    /**
     * adj1319（用户：「波形放大后，应添加滚动条来移动波形显示位置」）：
     * Ctrl + 滚轮放大 ⇒ 出现 `.t-scroll`；拖滑块 ⇒ `aria-valuenow`（视野左缘）真的变了。
     */
    const waveCenter = await centerOf(c, '.t-panel:nth-child(3) canvas.t-wave')
    await c.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: waveCenter.x,
      y: waveCenter.y,
      button: 'left',
      buttons: 0,
    })
    for (let i = 0; i < 2; i += 1) {
      await c.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: waveCenter.x,
        y: waveCenter.y,
        deltaX: 0,
        deltaY: -120,
        modifiers: 2,
      })
      await sleep(90)
    }
    await sleep(200)
    const scrollBefore = await evalJs(
      c,
      `(() => {
        const el = document.querySelector('.t-panel:nth-child(3) .t-scroll')
        if (!el) return null
        const t = el.querySelector('.t-scroll-thumb').getBoundingClientRect()
        return { now: Number(el.getAttribute('aria-valuenow')), thumbW: Math.round(t.width), trackW: Math.round(el.getBoundingClientRect().width) }
      })()`,
    )
    let scrollAfter = null
    if (scrollBefore !== null) {
      const thumb = await centerOf(c, '.t-panel:nth-child(3) .t-scroll-thumb')
      const x1 = thumb.x + 90
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: thumb.x, y: thumb.y, button: 'left', buttons: 0 })
      await c.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: thumb.x,
        y: thumb.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })
      for (let i = 1; i <= 5; i += 1) {
        await c.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(thumb.x + ((x1 - thumb.x) * i) / 5),
          y: thumb.y,
          button: 'left',
          buttons: 1,
        })
        await sleep(30)
      }
      await c.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: x1,
        y: thumb.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
      await sleep(250)
      scrollAfter = await evalJs(
        c,
        `(() => {
          const el = document.querySelector('.t-panel:nth-child(3) .t-scroll')
          return el === null ? null : Number(el.getAttribute('aria-valuenow'))
        })()`,
      )
    }
    check(
      'adj1319 放大后出现滚动条，拖滑块能把波形挪到右边（视野左缘变大）',
      scrollBefore !== null && scrollAfter !== null && scrollAfter > scrollBefore.now + 50,
      `${JSON.stringify(scrollBefore)} → ${String(scrollAfter)}`,
    )

    /**
     * adj1319（用户：「点在波形上时，空格未实现播放/暂停」）：
     * 点一下波形让它拿到焦点 → 空格开始放 → 再空格停下。
     */
    await tap(c, '.t-panel:nth-child(3) canvas.t-wave')
    const pressSpace = async () => {
      for (const type of ['keyDown', 'keyUp']) {
        await c.send('Input.dispatchKeyEvent', {
          type,
          key: ' ',
          code: 'Space',
          windowsVirtualKeyCode: 32,
          nativeVirtualKeyCode: 32,
          ...(type === 'keyDown' ? { text: ' ' } : {}),
        })
      }
      await sleep(280)
    }
    const playLabel = () =>
      evalJs(c, `document.querySelectorAll('.t-panel')[2].querySelector('.t-btn-run').textContent.trim()`)
    await pressSpace()
    const afterSpace1 = await playLabel()
    await pressSpace()
    const afterSpace2 = await playLabel()
    check(
      'adj1319 点过波形之后：空格开始播放、再按一次暂停',
      afterSpace1 === '暂停' && afterSpace2 === '播放',
      `${afterSpace1} → ${afterSpace2}`,
    )

    // ---- 导出当前选区：真落下一个文件 ----
    const before = readFileSize(DL)
    const runIndex = await evalJs(
      c,
      `[...document.querySelectorAll('.t-panel')[2].querySelectorAll('button')]
        .findIndex((b) => b.textContent.includes('导出当前选区'))`,
    )
    await tap(c, '.t-panel:nth-child(3) button', runIndex)
    const got = await waitForFile(DL, '.wav')
    check('adj1316 点「导出当前选区」⇒ 下载目录里真的出现 .wav（体积 > 1000 字节）',
      got !== null && got.size > 1000, got === null ? '没有文件' : `${got.name} ${got.size} 字节`)
    check('adj1316 导出前目录是空的（这份 .wav 确实是这次点出来的）', before === 0, `before=${before}`)

    // ---- 切回合并页签：没选文件时那只按钮必须是 disabled，且旁边写着要选视频 ----
    await tap(c, '.t-tab', 0)
    const mergeState = await evalJs(
      c,
      `(() => {
        const p = document.querySelectorAll('.t-panel')[0]
        const b = p.querySelector('.t-btn-run')
        return { disabled: b ? b.disabled : null, hint: p.textContent.includes('先选一个视频文件') }
      })()`,
    )
    check('adj1316 合并页签没选视频 ⇒「生成」按钮 disabled，并显示「先选一个视频文件」（不会点了没反应）',
      mergeState.disabled === true && mergeState.hint === true, JSON.stringify(mergeState))

    // ---- 截图留档（`.dsh-tmp/` 是本地临时目录，不进 git）----
    mkdirSync(path.dirname(SHOT), { recursive: true })
    await tap(c, '.t-tab', 2)
    await sleep(400)
    const shot = await c.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
    console.log(`  ⤷ 截图：${path.relative(ROOT, SHOT)}`)

    /**
     * 浅色主题（adj1316）：站点有深/浅两套，这一页自带一份 `--t-*` 变量 ——
     * 变量漏一条就会在浅色下出现"深底白字块"或"浅底白字看不见"，源码级断言看不出来，
     * 所以这里真切一次主题、量一遍底色，顺便留一张浅色截图给人工看。
     */
    await evalJs(c, `(() => { try { localStorage.setItem('ijipu.site.theme', 'light') } catch {} return 'ok' })()`)
    await c.send('Page.navigate', { url: `${origin}/tools/` })
    await waitFor(c, `document.querySelectorAll('.t-tab').length === 3`, '浅色下三个页签')
    const light = await evalJs(
      c,
      `(() => {
        const card = document.querySelector('.t-card')
        const name = document.querySelector('.t-brand-name')
        const avg = (el, prop) => {
          const m = getComputedStyle(el)[prop].match(/[0-9.]+/g)
          if (!m || m.length < 3) return null
          return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3
        }
        return { mode: document.documentElement.dataset.siteMode, card: avg(card, 'backgroundColor'), text: avg(name, 'color') }
      })()`,
    )
    // 顶栏本身透明（靠页面底色），所以量"卡片底色浅 + 文字颜色深"这一对才说明变量整套换了
    check('adj1316 切到浅色主题后卡片是浅底、字是深色（不是深底浅字的深色套）',
      light.mode === 'light' && light.card !== null && light.card > 150 && light.text !== null && light.text < 140,
      JSON.stringify(light))
    const shotLight = await c.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(SHOT_LIGHT, Buffer.from(shotLight.data, 'base64'))
    console.log(`  ⤷ 浅色截图：${path.relative(ROOT, SHOT_LIGHT)}`)

  } catch (e) {
    failed++
    console.log(`  ✗ 跑挂了：${e instanceof Error ? e.message : String(e)}`)
  }

  console.log(`\n[verify-tools] ${failed === 0 ? '全部通过 ✅' : `失败 ${failed} 项 ❌`}（${passed} 项通过）`)
  await cleanup(failed === 0 ? 0 : 1)
}

/** 目录里的文件总字节数（用来证明"这份产物是这次点出来的"） */
function readFileSize(dir) {
  try {
    return readdirSync(dir).reduce((sum, f) => sum + statSync(path.join(dir, f)).size, 0)
  } catch {
    return 0
  }
}

/** 等下载目录里出现指定扩展名的文件（Chrome 下载是异步的，先写 `.crdownload`） */
async function waitForFile(dir, ext, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const files = readdirSync(dir).filter((f) => f.endsWith(ext) && !f.endsWith('.crdownload'))
    if (files.length > 0) {
      const name = files[0]
      return { name, size: statSync(path.join(dir, name)).size }
    }
    await sleep(150)
  }
  return null
}

await main()
