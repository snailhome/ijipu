/**
 * verify-video.mjs — **真视频**端到端实测（连续动态谱，`adj1264` 起）
 *
 * ## 为什么要有这个脚本（而不是只靠 `verify:app-ui`）
 *
 * 用户 2026-11-09 点明：**视频解码是 M3 最大的未知**。而"能解码"这件事，
 * 源码级断言（`npm run smoke`）一条都证不了：`canRead` / `canDecode` / `getSample` / `draw`
 * 全在浏览器里，且依赖 WebCodecs。`verify:app-ui` 只喂了一个**假 mp4**（验"坏视频有明确提示"），
 * 真解码路径一条没走。
 *
 * ## 这个脚本怎么造样例
 *
 * 仓库里没有视频、本机也没有 ffmpeg ⇒ 直接用 **headless Chrome 的 WebCodecs 现编**两段
 * （mediabunny 的 `CanvasSource` + `AudioBufferSource`，各 2 秒、带音轨）：
 *  ① 640×360 横屏（左右两半绿/红）——验解码/播放/出片/闭环；
 *  ② **1920×1080 + 旋转 90° 元数据**（左蓝右黄）——模拟手机竖屏视频（显示 1080×1920），
 *    验"按显示宽高定画布、方向正确、谱带不被放大裁切"（`adj1265`，见 `E-2026-562`）。
 * 再把它当用户选的视频喂给台面。于是整条链都是真的：
 * 编出 mp4 → 导入 → 解码 → 画到画布 → 播放（音频时钟在走）→ 出片 → **再导入自己出的片**（闭环），
 * 最后在竖屏素材上开"带片头片尾"→ 看卡片真的画出来 / 总长 +4.5s / 出片时长 ≈ 6.5s。
 *
 * ## 一个测试环境的坑（不是应用的问题）
 *
 * 无头 Chrome 在 `Page.setDownloadBehavior` 下，**同名文件已存在**时第二次下载会被**静默丢弃**
 * （不报错、不出现 `(1)`）。所以本脚本在第一次出片后把它改名成 `landscape-out.mp4`，
 * 让卡片那次导出能用回原名（`E-2026-565`）。
 *
 * ## 前置
 *
 * 1. `npm run build`（要 `dist/app/` 与 `dist/assets/`）；
 * 2. 本机有 Chrome/Edge；
 * 3. **能编 H.264**：headless Chrome 需要 WebCodecs 编码器（实测 Windows 上可用；
 *    跑不了会在第 1 条就红，并打印原因）。
 *
 * 用法：`npm run verify:video`（不属于 `npm run smoke`：它依赖浏览器与编码器）。
 */
import { createServer } from 'node:http'
import { existsSync, statSync, readFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { rm, readdir, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(REPO, 'dist')
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
let failed = 0
function check(label, ok, extra = '') {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' }

/** 造样例的那一页（mediabunny 用 node_modules 里的 ESM 模块，直接给浏览器加载） */
const ENCODE_PAGE = `<!doctype html><meta charset="utf-8"><title>encode</title>
<script type="module">
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, Quality } from '/node_modules/mediabunny/dist/bundles/mediabunny.mjs'
const FPS = 30, SEC = 2
window.__stage = 'start'
/**
 * 编一段"整个画面只有两种颜色（左右各半）"的 mp4。
 * 两半的颜色差得远，台面画布上数像素就能判断"解码帧真的画上去了"以及**旋转方向**。
 */
async function clip(o) {
  const canvas = new OffscreenCanvas(o.w, o.h)
  const ctx = canvas.getContext('2d')
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const video = new CanvasSource(canvas, { codec: 'avc', quality: new Quality({ bitrate: 2000000 }) })
  output.addVideoTrack(video, { frameRate: FPS, ...(o.rotation ? { rotation: o.rotation } : {}) })
  const audio = new AudioBufferSource({ codec: 'aac', quality: new Quality({ bitrate: 96000 }) })
  output.addAudioTrack(audio)
  await output.start()
  for (let i = 0; i < FPS * SEC; i++) {
    ctx.fillStyle = o.a
    ctx.fillRect(0, 0, o.w / 2, o.h)
    ctx.fillStyle = o.b
    ctx.fillRect(o.w / 2, 0, o.w / 2, o.h)
    await video.add(i / FPS, 1 / FPS, { keyFrame: i % 60 === 0 })
  }
  video.close()
  const rate = 44100, len = rate * SEC
  const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: rate })
  const ch0 = buf.getChannelData(0), ch1 = buf.getChannelData(1)
  for (let i = 0; i < len; i++) { ch0[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / rate); ch1[i] = ch0[i] }
  await audio.add(buf)
  audio.close()
  await output.finalize()
  const bytes = new Uint8Array(output.target.buffer)
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(s)
}
try {
  window.__stage = 'landscape'
  window.__mp4 = await clip({ w: 640, h: 360, a: '#20a060', b: '#e04020' })
  window.__stage = 'portrait'
  // adj1265：手机竖屏素材——编码 1920×1080 + 旋转 90° 元数据（真实手机视频常见的样子）
  window.__mp4Portrait = await clip({ w: 1920, h: 1080, rotation: 90, a: '#2050e0', b: '#f0d020' })
  window.__stage = 'done'
  window.__done = true
} catch (e) {
  window.__err = String(e && e.stack ? e.stack : e)
  window.__done = true
}
</script>`

const chrome = CHROME_CANDIDATES.find((p) => p !== '' && existsSync(p))
if (!chrome) { console.error('找不到 Chrome'); process.exit(2) }
if (!existsSync(path.join(DIST, 'app', 'index.html'))) { console.error('先跑 npm run build'); process.exit(2) }

const server = createServer((req, res) => {
  const url = String(req.url ?? '/')
  if (url.startsWith('/probe')) {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
    res.end(ENCODE_PAGE)
    return
  }
  const rel0 = url.split('?')[0].replace(/^\//, '')
  const rel = rel0 === '' || rel0.endsWith('/') ? `${rel0}index.html` : rel0
  const base = rel.startsWith('node_modules/') ? REPO : DIST
  const abs = path.resolve(base, decodeURIComponent(rel))
  const root = path.resolve(base)
  const inside = abs === root || abs.startsWith(root + path.sep)
  if (!inside || !existsSync(abs) || !statSync(abs).isFile()) {
    res.writeHead(404); res.end('404'); return
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(abs))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const profile = path.join(tmpdir(), `ijipu-video-e2e-${Date.now()}`)
const DL = path.join(tmpdir(), `ijipu-video-e2e-dl-${Date.now()}`)
mkdirSync(DL, { recursive: true })
const port = 9700 + Math.floor(Math.random() * 150)
const child = spawn(chrome, ['--headless=new', '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })

let ws
let send
const cleanup = async (code) => {
  try { child.kill() } catch { /* */ }
  try { ws?.close() } catch { /* */ }
  server.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {})
  await rm(DL, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {})
  process.exit(code)
}

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval 失败')
  return r.result?.value
}
const waitFor = async (expression, label, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(expression)) return true
    await sleep(200)
  }
  throw new Error(`等待超时：${label}`)
}

try {
  let target = null
  for (let i = 0; i < 40 && target === null; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page') ?? null
    } catch { /* 端口未起 */ }
  }
  if (target === null) throw new Error('连不上调试端口')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  let id = 0
  const pending = new Map()
  send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params }))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP 超时 ${method}`)) } }, 120000)
  })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res } = pending.get(msg.id)
      pending.delete(msg.id)
      res(msg.result)
    }
  })
  await send('Page.enable')
  await send('Runtime.enable')
  // 应用里"动态谱视频/对拍台"整块只在桌面壳显示；真浏览器测里注入同一个开关（与 verify-app-ui 一致）
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__IJIPU_FORCE_DESKTOP__ = true' })

  // ---------- ① 造两段真 mp4（横屏 + 手机竖屏/旋转元数据） ----------
  console.log('— 造样例：headless Chrome 用 WebCodecs 编 2s 真 mp4（640×360 横屏 / 1920×1080 旋转 90°）—')
  await send('Page.navigate', { url: `${origin}/probe` })
  await waitFor('window.__done === true', '编码完成', 240)
  const err = await evalJs('window.__err ?? null')
  check('WebCodecs 能在 headless Chrome 里编 H.264 + AAC', err === null, err ?? '')
  const b64 = await evalJs('window.__mp4 ?? ""')
  const samplePath = path.join(DL, 'sample-video.mp4')
  await writeFile(samplePath, Buffer.from(b64, 'base64'))
  const size = statSync(samplePath).size
  check('样例 mp4 落到磁盘（有内容，不是空壳）', size > 20000, `${size} 字节`)
  const b64p = await evalJs('window.__mp4Portrait ?? ""')
  const portraitPath = path.join(DL, 'sample-portrait.mp4')
  await writeFile(portraitPath, Buffer.from(b64p, 'base64'))
  const sizeP = statSync(portraitPath).size
  check(
    '手机竖屏样例落到磁盘（1920×1080 + 旋转 90° 元数据，不是空壳）',
    sizeP > 20000,
    `${sizeP} 字节`,
  )

  // ---------- ② 喂给应用的连续动态谱台面 ----------
  console.log('— 端到端：导入真 mp4 → 解码 → 播放 → 出片 —')
  const code = `V: 1.0\nB: 连续谱\nQ: 1 2 3 4 | 5 6 7 1' | 2 3 4 5 |\n`
  await send('Page.navigate', { url: `${origin}/app/?jps=${encodeURIComponent(code)}` })
  await waitFor(`!!document.querySelector('.app')`, '应用首屏')
  await sleep(900)
  await evalJs(`[...document.querySelectorAll('.topbar-btn')].find((el) => (el.textContent || '').includes('试听'))?.click(), true`)
  await waitFor(`!!document.querySelector('.playback-actions')`, '试听面板')
  await evalJs(`[...document.querySelectorAll('.playback-actions .btn')].find((el) => (el.textContent || '').includes('连续动态谱'))?.click(), true`)
  await waitFor(`!!document.querySelector('.linear-panel')`, '连续谱台面')
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }).catch(() => {})
  await send('DOM.enable')
  const root = await send('DOM.getDocument', { depth: -1 })
  const input = await send('DOM.querySelector', { nodeId: root.root.nodeId, selector: 'input[accept="video/*"]' })
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [samplePath] })
  await waitFor(`document.body.innerText.includes('带原声')`, '视频解码成功（显示"带原声"）', 120)
  check('真 mp4 解码成功：台面显示「…（带原声）」', true)
  check('解码成功时没有"打不开这个视频"的报错', await evalJs(`!document.body.innerText.includes('打不开这个视频')`), '')
  const dur = await evalJs(`(document.body.innerText.match(/0:0\\d\\.\\d\\d \\/ 0:0\\d\\.\\d\\d/) ?? [''])[0]`)
  check('台面读到视频时长（读数不是 0:00.0）', /0:0[1-9]\.\d\d/.test(dur), dur)
  await sleep(1200)
  const painted = await evalJs(`(() => {
    const cv = document.querySelector('[data-role="linear-stage"]')
    const g = cv.getContext('2d')
    const d = g.getImageData(0, 0, cv.width, cv.height).data
    let green = 0, red = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 80 && d[i + 1] > 120 && d[i + 2] < 120) green++
      if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 90) red++
    }
    return { green, red }
  })()`)
  check('画面里真的有视频帧（整屏都是样例的绿/红底色，说明解码帧画上去了）', painted.green + painted.red > 100000, JSON.stringify(painted))
  // 播放：读数要往前走（音频时钟真的在跑）——读的是台面那个**每帧用 textContent 更新**的读数
  const readPos = `document.querySelector('[data-role="linear-pos"]')?.textContent ?? ''`
  const before = await evalJs(readPos)
  await evalJs(`[...document.querySelectorAll('.linear-panel .btn')].find((el) => (el.textContent || '').trim() === '播放')?.click(), true`)
  await sleep(1200)
  const after = await evalJs(readPos)
  check('播放时读数在走（音频时钟真的在跑）', before !== after && after !== '', `${before} → ${after}`)
  await evalJs(`[...document.querySelectorAll('.linear-panel .btn')].find((el) => (el.textContent || '').trim() === '暂停')?.click(), true`)
  // 出片：真编一段（2 秒 640×360）
  const filesBefore = new Set(await readdir(DL))
  await evalJs(`[...document.querySelectorAll('.linear-panel .btn')].find((el) => (el.textContent || '').trim() === '出片')?.click(), true`)
  let outFile = null
  for (let i = 0; i < 300 && outFile === null; i++) {
    await sleep(300)
    for (const f of await readdir(DL)) {
      if (f.endsWith('.mp4') && f !== 'sample-video.mp4' && !filesBefore.has(f)) outFile = f
    }
  }
  const outPath = outFile === null ? null : path.join(DL, outFile)
  const outSize = outPath !== null ? statSync(outPath).size : 0
  check('出片产出真 mp4（下载目录里出现新文件且不是空壳）', outFile !== null && outSize > 20000, outFile === null ? '没出现' : `${outFile} ${outSize} 字节`)
  if (outFile !== null) {
    // 出片结果回头再当"视频"喂一次：证明我们自己编的视频也能被自己的解码器读回来
    const bytes = readFileSync(outPath)
    await writeFile(path.join(DL, 'reimport.mp4'), bytes)
    await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path.join(DL, 'reimport.mp4')] })
    await sleep(4000)
    check('自己出的片能被自己的解码器读回来（闭环）', await evalJs(`!document.body.innerText.includes('打不开这个视频') && document.body.innerText.includes('带原声')`), '')
    const dur2 = await evalJs(`(document.body.innerText.match(/ \\/ (0:0\\d\\.\\d\\d)/) ?? ['', ''])[1]`)
    check('自己出的片时长 ≈ 2s（画面与音轨等长，没有"视频 2s、声音 3s"那种错位）', /0:02\./.test(dur2), dur2)
    /**
     * 把这条横屏成片**改名**：下面的卡片导出用同名文件，而无头 Chrome 的下载通道
     * 遇到"目标文件已存在"会**静默丢弃**（实测，与应用无关）；改名后第二条下载才落得下来。
     */
    await rename(outPath, path.join(DL, 'landscape-out.mp4'))
  }

  // ---------- ③ 手机竖屏素材回归（1920×1080 + 旋转 90° → 台面 1080×1920） ----------
  console.log('— 手机竖屏素材：1920×1080 + 旋转 90° 元数据 → 解码 / 方向 / 画布尺寸 —')
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [portraitPath] })
  await waitFor(`document.body.innerText.includes('带原声')`, '竖屏视频解码成功', 200)
  await sleep(1600)
  const stageSize = await evalJs(`(() => {
    const cv = document.querySelector('[data-role="linear-stage"]')
    return { w: cv.width, h: cv.height }
  })()`)
  check(
    '手机竖屏：台面画布按**显示宽高** 1080×1920（旋转元数据算进去了，不是编码尺寸 1920×1080）',
    stageSize.w === 1080 && stageSize.h === 1920,
    JSON.stringify(stageSize),
  )
  const halves = await evalJs(`(() => {
    const cv = document.querySelector('[data-role="linear-stage"]')
    const g = cv.getContext('2d')
    const px = (x, y) => { const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]] }
    // 避开谱带（默认上 1/4、约一两百像素高）：取画面上缘/下缘各一处
    return { top: px(cv.width / 2, cv.height * 0.08), bottom: px(cv.width / 2, cv.height * 0.92) }
  })()`)
  // 编码时左半 #2050e0（蓝）、右半 #f0d020（黄）；顺时针旋转 90° 后左半应转到**上**半。
  // 这条同时兜住"用旋转前尺寸算 cover"的错法（那样画面会被放大裁切，上下两半就同色了）。
  const nearBlue = (p) => p[2] > 140 && p[0] < 120
  const nearYellow = (p) => p[0] > 180 && p[1] > 150 && p[2] < 120
  check(
    '手机竖屏：旋转方向正确（编码时的左半 → 画面上半、右半 → 下半）',
    nearBlue(halves.top) && nearYellow(halves.bottom),
    JSON.stringify(halves),
  )

  // ---------- ④ 片头/片尾卡适配（在竖屏 1080×1920 画布上按比例排） ----------
  console.log('— 片头片尾卡：竖屏画布上打开卡片 → 画布出卡 / 总长 +4.5s / 出片 —')
  const totalBefore = await evalJs(`document.querySelector('[data-role="linear-total"]')?.textContent ?? ''`)
  // 先把播放头拖到 0（片头卡起点），再勾"带片头片尾"
  await evalJs(`(() => {
    const cv = document.querySelector('[data-role="linear-wave"]')
    const r = cv.getBoundingClientRect()
    cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 1, clientY: r.top + 10, bubbles: true }))
    return true
  })()`)
  await sleep(300)
  await evalJs(`document.querySelector('[data-role="linear-cards"]')?.click(), true`)
  await sleep(1800)
  const totalAfter = await evalJs(`document.querySelector('[data-role="linear-total"]')?.textContent ?? ''`)
  check(
    '开卡片后会话总长变长（片头 2s + 音乐 2s + 片尾 2.5s ≈ 6.5s）',
    /0:06\.[0-9]{2}/.test(totalAfter) && totalBefore !== totalAfter,
    `${totalBefore} → ${totalAfter}`,
  )
  const cardPixel = await evalJs(`(() => {
    const cv = document.querySelector('[data-role="linear-stage"]')
    const g = cv.getContext('2d')
    const d = g.getImageData(8, 8, 1, 1).data
    return [d[0], d[1], d[2]]
  })()`)
  check(
    '片头卡的画面真的画出来了（左上角是深空蓝卡底，不是视频的蓝/黄）',
    cardPixel[0] < 70 && cardPixel[1] < 80 && cardPixel[2] < 110 && !nearBlue(cardPixel) && !nearYellow(cardPixel),
    JSON.stringify(cardPixel),
  )
  const filesBefore2 = new Set(await readdir(DL))
  await evalJs(`[...document.querySelectorAll('.linear-panel .btn')].find((el) => (el.textContent || '').trim() === '出片')?.click(), true`)
  let cardOut = null
  let exportState = ''
  const EXCLUDE = ['sample-video.mp4', 'sample-portrait.mp4', 'reimport.mp4', 'landscape-out.mp4', 'card-reimport.mp4']
  for (let i = 0; i < 500 && cardOut === null; i++) {
    await sleep(300)
    if (i % 10 === 0) {
      exportState = await evalJs(`(() => {
        const btn = [...document.querySelectorAll('.linear-panel .btn')].find((el) => /出片|取消/.test((el.textContent || '').trim()))
        return JSON.stringify({
          btn: btn?.textContent ?? '',
          prog: document.querySelector('[data-role="linear-progress"]')?.textContent ?? '',
          notice: document.querySelector('.linear-notice')?.textContent ?? '',
        })
      })()`)
    }
    for (const f of await readdir(DL)) {
      if (f.endsWith('.mp4') && !filesBefore2.has(f) && !EXCLUDE.includes(f)) cardOut = f
    }
  }
  const cardOutPath = cardOut === null ? null : path.join(DL, cardOut)
  const cardOutSize = cardOutPath !== null ? statSync(cardOutPath).size : 0
  check(
    '带卡片的竖屏成片能产出（真 mp4、不是空壳；尺寸 1080×1920 + 卡片段）',
    cardOut !== null && cardOutSize > 20000,
    cardOut === null ? `没出现；最后状态：${exportState}` : `${cardOut} ${cardOutSize} 字节`,
  )
  if (cardOutPath !== null) {
    // 再读回自己出的片：总长应 ≈ 6.5s（说明片头/片尾段真的进了文件，不是只改了读数）
    // 先把卡片关掉，否则"画面总长"= 新片 6.5s + 再一层片头片尾 = 11s，读数就不是 6.5 了。
    await evalJs(`document.querySelector('[data-role="linear-cards"]')?.click(), true`)
    await sleep(600)
    await writeFile(path.join(DL, 'card-reimport.mp4'), readFileSync(cardOutPath))
    await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path.join(DL, 'card-reimport.mp4')] })
    await sleep(5000)
    const durCard = await evalJs(`(document.body.innerText.match(/ \\/ (0:0\\d\\.\\d\\d)/) ?? ['', ''])[1]`)
    check('带卡片的成片读回来时长 ≈ 6.5s（片头/片尾段真的编进文件了）', /0:06\./.test(durCard), durCard)
  }
  ws.close()
} catch (e) {
  check(`脚本自身出错：${e instanceof Error ? e.message : String(e)}`, false)
} finally {
  console.log('')
  console.log(failed === 0 ? `[verify-video] 全部通过 ✅（${passed} 项）` : `[verify-video] 失败 ${failed} 项 ❌`)
  await cleanup(failed === 0 ? 0 : 1)
}
