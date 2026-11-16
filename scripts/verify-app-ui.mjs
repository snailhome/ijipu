/**
 * verify-app-ui.mjs — **应用内 UI 的真浏览器实测**（`adj959` 起）
 *
 * ## 为什么要有这个脚本（而不是只写源码级断言）
 *
 * `adj959`（**用户实报**「手册的目录打开后，点击其它地方，菜单不会隐藏」）暴露了一类
 * **源码级断言守不住**的缺陷："**事件挂错了地方**" ——
 *   · 代码里**确实**挂了监听、`tsc` / `lint` / `smoke` 全绿，但那个监听**收不到事件**：
 *     ① 挂在冒泡阶段 `document` 上的"点外面就关"，被 `ui/Modal.tsx` 给 `.modal` 挂的
 *        `onClick={(e) => e.stopPropagation()}` 掐断（React 的 `stopPropagation()` 会连带调用原生那次）；
 *     ② 挂在 `.doc-content` 上的事件委托收不到目录浮层的点击（浮层是它的**兄弟节点**）。
 *   · 源码级判据只能钉住"结构长什么样"（捕获阶段 / 处理器挂在 `<nav>` 上），**钉不住"点得动"**。
 * ⇒ 所以留一个**真点**的脚本。冒烟（`npm run smoke`）刻意**不含**它：那是 Node 纯逻辑套件，
 *   不该依赖 Chrome；这里与 `npm run verify:site`（官网）并列，按需 / 发布前跑。
 *
 * ## 前置
 *
 * 必须先有**当前源码构建出来的** `dist/`：`npm run build`（或至少 `npx vite build`）。
 * 脚本只**读** `dist/`、只**写**临时 user-data-dir（跑完删掉），不碰仓库。
 *
 * ## 判据为什么这么写
 *
 * · **点浮层自己的标题行 ⇒ 不许关**：这条是"负向判据"——只测"点别处能关"的话，把实现写成
 *   "任何点击都关"也能过，而那会把浮层变成一点就消失的废按钮。
 * · **点条目要真的滚动**：只看"浮层关掉了"不够（关掉可能是别的原因）；这里比对跳转前后的
 *   `scrollTop`，要求**明显变大**（实测 0 → 11500）⇒ 证明确实跳到了后面某一节。
 * · 每一条都对应 `adj959` 的一个真实症状，改坏任何一条都会当场判红。
 *
 * ## 复现反证（脚本外的手工操作，写在这里备查）
 *
 * 把 `src/dialogs/DocDialog.tsx` 里那两处 `, true)` 去掉（＝退回冒泡阶段）→ `npx vite build` → 再跑本脚本
 * ⇒ 「点正文里的一段文字 ⇒ 目录浮层收起」**判红**（这正是用户实报的现象），加回 `true` 即全绿。
 * 本轮就是这么确认根因的。
 *
 * ## adj965d（EP-13）那一段：预览区调水印/背景的 Alt 手势
 *
 * 同一类"源码级断言守不住"的缺陷，而且更隐蔽：`wheel` 监听**挂错容器 / 挂成被动监听**时，
 * 代码看着全对、`tsc`/`lint`/`smoke` 全绿，但用户按下去要么没反应、要么页面跟着滚。
 * 所以这一段一律走 CDP 的 `Input.dispatchMouseEvent`（**浏览器原生输入路径**，
 * `modifiers` 位掩码：Alt=1、Ctrl=2、Shift=8），并**双向**判：
 *   · 正向：`Alt+滚轮` / `Alt+Shift+滚轮` / `Alt+拖动` ⇒ 预览产物**与** `# jps-config` **都真的变了**；
 *   · 负向：关掉「排版辅助」后按 Alt ⇒ 一个字都不许变（前提①）；
 *   · 回归：`Ctrl+单击音符` 仍能从这里试听（不能被同区域的新手势抢走）。
 *
 * ## adj966f 那一段：两边都改了 ⇒ 逐块采纳 / 自动三路合并（`docs/FILE-MODEL.md` §9）
 *
 * 同一类问题的第三次应用：差异框里「用左 / 用右」按钮、底部「应用（并保存）」是否**真的生效**
 * （点了有没有反应、结果有没有写回文件、提示条有没有收口），源码级断言一个都证明不了。
 * 做法：`Page.addScriptToEvaluateOnNewDocument` 注入一个**假 FSA 句柄**
 * （`showOpenFilePicker` + `getFile` / `createWritable`）⇒ 应用走正常的"网页版 FSA 档"，
 * 打开 = 真句柄、监视 = 真轮询（4 秒一跳）；"外部改动"= 直接改那个假文件的内容与 mtime。
 * 两个场景：① 两边改**不同块** ⇒ 确认条应说"已自动合好…互不重叠"并给「应用」，点完**假文件里真出现合并结果**；
 * ② 两边改**同一块** ⇒ 确认条应走"要你决定"、差异框里标"冲突"，选「用右」+ 应用后**外部那一版进文件、本地那版被换掉**。
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
/** adj1129：下载目录（验证"保存真的产出文件"，跑完清掉） */
const DL = path.join(tmpdir(), `ijipu-verify-dl-${Date.now()}`)

/** 只列 `dist/` 里真会出现的扩展名（少了哪个，那个资源就是 404、页面会静默缺东西） */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.jps': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.sf2': 'application/octet-stream',
}

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
let passed = 0
function check(label, ok, extra = '') {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
}

/** `dist/` 里按 URL 找文件；目录（`/app/`）回退 `index.html`。越界/不存在一律 null（由调用方 404） */
function resolveDistFile(urlPath) {
  let rel = urlPath.split('?')[0]
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html'
  const abs = path.join(DIST, decodeURIComponent(rel).replace(/^\//, ''))
  if (!abs.startsWith(DIST) || !existsSync(abs) || !statSync(abs).isFile()) return null
  return abs
}

// ---- 极简 CDP over WebSocket（Node 22 内置 WebSocket）—— 与 verify-site.mjs / embed-smoke.mjs 同一套 ----
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

/** 轮询等条件成立；超时抛错（比"睡固定时间"稳：慢机器上不会假红） */
async function waitFor(c, expression, label, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(c, expression)) return true
    await sleep(150)
  }
  throw new Error(`等待超时：${label}`)
}

/** 打开应用内手册对话框（走真实的「菜单 → 帮助 → 命令行手册」，不绕过 UI 直接调 store） */
async function openCliManualDialog(c) {
  await waitFor(c, `!!document.querySelector('.topbar-hamburger-btn')`, '应用首屏（顶栏菜单按钮）')
  await evalJs(c, `document.querySelector('.topbar-hamburger-btn').click(), true`)
  // ⚠ 菜单项是 `div.menu-entry`（不是 `button`，见 TopBar 的 MenuPanel）
  await waitFor(
    c,
    `[...document.querySelectorAll('.menu-entry')].some((el) => el.textContent.includes('命令行手册'))`,
    '菜单里有「命令行手册」',
  )
  await evalJs(
    c,
    `[...document.querySelectorAll('.menu-entry')].find((el) => el.textContent.includes('命令行手册')).click(), true`,
  )
  await waitFor(c, `!!document.querySelector('.doc-toc-toggle')`, '帮助对话框 + 目录按钮')
}

async function main() {
  if (!existsSync(DIST) || !existsSync(path.join(DIST, 'app', 'index.html'))) {
    console.error(`[verify-app-ui] 找不到 ${path.join(DIST, 'app', 'index.html')} —— 先跑 npm run build`)
    process.exit(2)
  }
  const chrome = CHROME_CANDIDATES.find((p) => p !== '' && existsSync(p))
  if (!chrome) {
    console.error('[verify-app-ui] 找不到 Chrome（本脚本只走真浏览器，不替代 smoke）')
    process.exit(2)
  }

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

  const profile = path.join(tmpdir(), `ijipu-app-ui-${Date.now()}`)
  const debugPort = 9600 + Math.floor(Math.random() * 300)
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

  try {
    let target = null
    for (let i = 0; i < 40 && target === null; i++) {
      await sleep(250)
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
        target = list.find((t) => t.type === 'page') ?? null
      } catch {
        /* 调试端口还没起来 */
      }
    }
    if (target === null) throw new Error('连不上 Chrome 调试端口')

    const c = cdp(target.webSocketDebuggerUrl)
    await c.ready
    await c.send('Page.enable')
    await c.send('Runtime.enable')
    // adj1078：动态谱视频整块只在桌面壳显示；测试里注入一个全局模拟桌面壳，真实的网站/插件没有它
    await c.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__IJIPU_FORCE_DESKTOP__ = true',
    })
    // adj1129：把下载目录指到临时目录——"保存真的产出一个文件"要能落到磁盘上核对
    try {
      rmSync(DL, { recursive: true, force: true })
      mkdirSync(DL, { recursive: true })
      await c.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL })
    } catch {
      /* 老版本 CDP 没有这个命令：后续断言会退化为"只看到提示" */
    }
    await c.send('Page.navigate', { url: `${origin}/app/` })

    console.log('[verify-app-ui] adj959：应用内手册的「目录」浮层（真点）')

    // ---- ① 从真实入口打开对话框 ----
    await openCliManualDialog(c)
    check('顶栏「菜单 → 帮助 → 命令行手册」能打开应用内手册对话框', true)
    const scrollable = await evalJs(
      c,
      `(() => { const el = document.querySelector('.doc-content'); return el ? el.scrollHeight > el.clientHeight + 50 : false })()`,
    )
    check('手册正文确实是一份长文档（内容可滚动）', scrollable === true)

    // ---- ② 「目录」按钮弹出浮层，且条目来自正文标题 ----
    await evalJs(c, `document.querySelector('.doc-toc-toggle').click(), true`)
    await waitFor(c, `!!document.querySelector('.doc-toc-pop')`, '目录浮层出现')
    const itemCount = await evalJs(c, `document.querySelectorAll('.doc-toc-pop a').length`)
    check('点「目录」按钮弹出浮层，且里面有可点条目', itemCount > 0, `条目 ${itemCount} 条`)

    // ---- ③ **用户实报的那条**：点正文里的一段文字 ⇒ 收起 ----
    //      （修复前这里是红的：冒泡阶段的监听被 Modal 的 stopPropagation 掐断）
    await evalJs(c, `document.querySelector('.doc-content p').click(), true`)
    await sleep(250)
    check(
      '点正文里的一段文字 ⇒ 目录浮层收起（**用户实报的那条**）',
      (await evalJs(c, `!!document.querySelector('.doc-toc-pop')`)) === false,
    )

    // ---- ④ 点正文容器本身 ⇒ 收起 ----
    await evalJs(c, `document.querySelector('.doc-toc-toggle').click(), true`)
    await waitFor(c, `!!document.querySelector('.doc-toc-pop')`, '浮层再次出现')
    await evalJs(c, `document.querySelector('.doc-content').click(), true`)
    await sleep(250)
    check('点正文容器本身 ⇒ 目录浮层收起', (await evalJs(c, `!!document.querySelector('.doc-toc-pop')`)) === false)

    // ---- ⑤ 点对话框内的空白（`.modal-body` 的 padding 区）⇒ 收起 ----
    await evalJs(c, `document.querySelector('.doc-toc-toggle').click(), true`)
    await waitFor(c, `!!document.querySelector('.doc-toc-pop')`, '浮层第三次出现')
    await evalJs(c, `document.querySelector('.modal-body').click(), true`)
    await sleep(250)
    check('点对话框内的空白处 ⇒ 目录浮层收起', (await evalJs(c, `!!document.querySelector('.doc-toc-pop')`)) === false)

    // ---- ⑥ 负向判据：点浮层**自己** ⇒ 不许关（否则浮层是一点就没的废按钮）----
    await evalJs(c, `document.querySelector('.doc-toc-toggle').click(), true`)
    await waitFor(c, `!!document.querySelector('.doc-toc-pop')`, '浮层第四次出现')
    await evalJs(c, `document.querySelector('.doc-toc-pop-title').click(), true`)
    await sleep(250)
    check(
      '点浮层自己的标题行 ⇒ **不**收起（不能误关）',
      (await evalJs(c, `!!document.querySelector('.doc-toc-pop')`)) === true,
    )

    // ---- ⑦ **查③时发现的第二个 bug**：点条目要真的跳（比对 scrollTop）+ 收起 ----
    const before = await evalJs(c, `document.querySelector('.doc-content').scrollTop`)
    const clicked = await evalJs(
      c,
      `(() => {
         const items = [...document.querySelectorAll('.doc-toc-pop a.doc-toc-item')]
         const el = items[items.length - 1]
         if (!el) return 'no-item'
         el.scrollIntoView()   // 先滚进浮层的可视区，再点（模拟真人）
         el.click()
         return 'clicked'
       })()`,
    )
    await sleep(400)
    const after = await evalJs(c, `document.querySelector('.doc-content').scrollTop`)
    const stillOpen = await evalJs(c, `!!document.querySelector('.doc-toc-pop')`)
    check(
      '点最后一节目录条目 ⇒ 正文**真的滚动**且浮层收起（**查③时发现的第二个 bug**）',
      clicked === 'clicked' && after > before + 100 && stillOpen === false,
      `跳前 scrollTop=${before} 跳后=${after} 浮层还在=${stillOpen}`,
    )

    // ---- ⑧ 再点一次「目录」按钮 ⇒ 收起（按钮在豁免名单里，不会被"点别处"逻辑抢跑）----
    await evalJs(c, `document.querySelector('.doc-toc-toggle').click(), true`)
    await waitFor(c, `!!document.querySelector('.doc-toc-pop')`, '浮层第五次出现')
    await evalJs(c, `document.querySelector('.doc-toc-toggle').click(), true`)
    await sleep(250)
    check(
      '再点一次「目录」按钮 ⇒ 收起（按钮本身在豁免名单里）',
      (await evalJs(c, `!!document.querySelector('.doc-toc-pop')`)) === false,
    )

    // ================= adj963：新建/保存的入口与行为（用户要求） =================
    await evalJs(c, `document.querySelector('.modal-close').click(), true`)
    await sleep(250)
    check(
      '关掉帮助对话框后回到编辑器（后面的用例要在编辑器上做）',
      (await evalJs(c, `!!document.querySelector('.editor-main textarea')`)) === true,
    )


    // ---- ⑨ 窄屏菜单**常驻**「新建 / 保存 / 另存为」----
    //   来源：用户实报"菜单里没有新建和保存了" —— 窄屏分支（adj540）曾把这三项收进工作区面板，
    //   而嵌入版又隐藏了「工作区」项 ⇒ 窄的插件面板里一个文件操作入口都没有。
    //   这里把视口调窄（`isNarrow` 由视口宽度驱动）再打开菜单，**真看**这三个词在不在。
    await c.send('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 820,
      deviceScaleFactor: 2,
      mobile: true,
    })
    await sleep(500)
    await evalJs(c, `document.querySelector('.topbar-hamburger-btn').click(), true`)
    await waitFor(c, `!!document.querySelector('.topbar-hamburger.open .menu-dropdown')`, '窄屏菜单打开')
    const narrowLabels = await evalJs(
      c,
      `[...document.querySelectorAll('.topbar-hamburger.open .menu-entry')].map((el) => el.textContent.trim())`,
    )
    check(
      '窄屏菜单里有「新建 / 保存 / 另存为」（**用户要求恢复**；adj540 曾把三项收进工作区面板）',
      narrowLabels.some((l) => l.startsWith('新建')) &&
        narrowLabels.some((l) => l.startsWith('保存')) &&
        narrowLabels.some((l) => l.startsWith('另存为')),
      narrowLabels.slice(0, 4).join(' ／ '),
    )

    // ---- ⑩ 有未保存修改时点「新建」⇒ 先问一句；确认后才真的新建 ----
    //   为什么要这条：`newDoc()` 会直接换掉草稿槽（原文件不动，但当前的未保存编辑就此消失）⇒
    //   没有这一问，"点错一下"就等于丢内容（E-2026-310 同族）。
    await evalJs(c, `document.querySelector('.topbar-hamburger-btn').click(), true`) // 先收起菜单
    await sleep(150)
    await evalJs(c, `document.querySelector('.editor-main textarea').focus(), true`)
    await c.send('Input.insertText', { text: '\nQ: 5 6 7 1 |' }) // 真打字 ⇒ 走 React 的 onChange
    await sleep(300)
    const dirtyShown = await evalJs(c, `!!document.querySelector('.dirty-dot')`)
    check('在编辑器里真打字之后出现未保存标记（`.dirty-dot`）', dirtyShown === true)
    const beforeNew = await evalJs(c, `document.querySelector('.editor-main textarea').value`)

    await evalJs(c, `document.querySelector('.topbar-hamburger-btn').click(), true`)
    await waitFor(c, `!!document.querySelector('.topbar-hamburger.open .menu-dropdown')`, '菜单再开（准备点新建）')
    await evalJs(
      c,
      `[...document.querySelectorAll('.topbar-hamburger.open .menu-entry')].find((el) => el.textContent.includes('新建')).click(), true`,
    )
    await waitFor(c, `!!document.querySelector('.confirm-bar')`, '确认条出现')
    const askText = String(await evalJs(c, `document.querySelector('.confirm-bar-text').textContent`))
    const afterAsk = await evalJs(c, `document.querySelector('.editor-main textarea').value`)
    check(
      '有未保存修改时点「新建」⇒ 出现确认条，且**此时还没有**真的新建（内容原封不动）',
      askText.includes('未保存') && afterAsk === beforeNew,
      askText.slice(0, 28),
    )

    /**
     * adj967e（用户截图实报"布局很不好看"）：确认条必须**文字在上、按钮在下面一排**。
     * 为什么这条要真浏览器量：症状纯由 CSS 布局造成（`position: fixed` 不设宽 ⇒ 按内容收缩，
     * 三个按钮把长文案挤成一条窄柱）。源码里"改没改 CSS"看不出来，只有量 DOM 盒模型才作数。
     */
    const barGeom = await evalJs(
      c,
      `(() => {
        const bar = document.querySelector('.confirm-bar')
        const txt = document.querySelector('.confirm-bar-text')
        const acts = document.querySelector('.confirm-bar-actions')
        if (!bar || !txt || !acts) return null
        const b = bar.getBoundingClientRect(), t = txt.getBoundingClientRect(), a = acts.getBoundingClientRect()
        const btns = [...acts.querySelectorAll('.confirm-bar-btn')].map((x) => x.getBoundingClientRect())
        return {
          barW: Math.round(b.width), textW: Math.round(t.width),
          textBelow: Math.round(t.bottom) <= Math.round(a.top) + 1,
          sameRow: btns.length >= 2 ? btns.every((r) => Math.abs(r.top - btns[0].top) < 1) : false,
          inside: t.left >= b.left - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1,
        }
      })()`,
    )
    check(
      'adj967e 确认条：**文字在上、按钮在下面一排**（按钮同一行、都在条内；文字不再被挤成窄柱）',
      barGeom !== null &&
        barGeom.textBelow === true &&
        barGeom.sameRow === true &&
        barGeom.inside === true &&
        barGeom.textW > 260,
      JSON.stringify(barGeom),
    )

    await evalJs(c, `document.querySelector('.confirm-bar-btn.is-primary').click(), true`)
    await sleep(400)
    const afterOk = await evalJs(c, `document.querySelector('.editor-main textarea').value`)
    const footText = String(await evalJs(c, `document.querySelector('.footer-file')?.textContent ?? ''`))
    check(
      '确认后真的新建：内容换成未命名模板、状态栏回到「未命名」、未保存标记消失（新文档＝缓存里的无主之物）',
      afterOk !== beforeNew &&
        afterOk.includes('B: 未命名') &&
        footText.includes('未命名') &&
        (await evalJs(c, `!!document.querySelector('.dirty-dot')`)) === false,
      `${footText.trim()} ／ 首行 ${afterOk.split('\n')[0]}`,
    )

    // ============ adj965：水印设置 → 预览 → 写进谱面（端到端真点） ============
    //   这条覆盖的是"设置界面 → 引擎渲染 → 差量写盘"整整一条链，只靠源码级闸门是证明不了的：
    //   源码级只能证明"有那一行"，证明不了"点了真的出层、保存真的落键"。
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    const dockBtn = await evalJs(
      c,
      `(() => {
         const b = [...document.querySelectorAll('.topbar-btn')].find((el) => (el.getAttribute('title') || '').includes('谱面'))
         if (!b) return 'no-btn'
         b.click()
         return 'ok'
       })()`,
    )
    check('顶栏能找到「谱面设置」按钮并点开', dockBtn === 'ok')
    await waitFor(c, `!!document.querySelector('.pcfg-root')`, '谱面设置面板出现')
    await waitFor(
      c,
      `[...document.querySelectorAll('.jp-tab')].some((t) => t.textContent.includes('水印'))`,
      '「水印」子页签出现',
    )
    await evalJs(
      c,
      `[...document.querySelectorAll('.jp-tab')].find((t) => t.textContent.includes('水印')).click(), true`,
    )
    await waitFor(c, `!!document.querySelector('.pcfg-text')`, '水印页签内容出现（文本/路径输入框）')

    // 先勾「启用水印」——adj965c 起两个总开关**默认关**（用户裁定），不勾就不会画
    await evalJs(
      c,
      `(() => {
         const box = [...document.querySelectorAll('.pcfg-check input[type=checkbox]')][0]
         box.click()
         return box.checked
       })()`,
    )
    await sleep(250)

    // 真打字：聚焦水印文本输入框后走 CDP 输入（React 的 onChange 才会触发）
    // adj1189：默认文本已不是空串 ⇒ 先全选，再输入，避免把默认文字拼在前面
    await evalJs(
      c,
      `(() => { const el = document.querySelector('.pcfg-text'); el.focus(); el.setSelectionRange(0, el.value.length); return true })()`,
    )
    await c.send('Input.insertText', { text: '内部草稿' })
    await sleep(400)
    const wmInPreview = await evalJs(c, `!!document.querySelector('.score-page svg [data-overlay="wm"]')`)
    const wmText = await evalJs(
      c,
      `document.querySelector('.score-page svg [data-overlay="wm"] tspan')?.textContent ?? ''`,
    )
    check(
      '在「水印」页签里勾「启用水印」并打字 ⇒ **预览里真的出现了水印层**（且文字对得上）',
      wmInPreview === true && wmText === '内部草稿',
      `tspan="${wmText}"`,
    )

    // 保存设置 ⇒ 真的差量写进 # jps-config（默认关的开关必须落键，否则换台机器打开就又不显示了）
    await evalJs(
      c,
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存设置').click(), true`,
    )
    await sleep(500)
    const codeNow = String(await evalJs(c, `document.querySelector('.editor-main textarea').value`))
    const cfgLine = (codeNow.match(/# jps-config:(.*)/) ?? [])[1] ?? ''
    const cfgKeys = Object.keys(JSON.parse(cfgLine || '{}')).sort()
    check(
      '点「保存设置」⇒ 真的写进 `# jps-config`，且**只写改过的那两项**（启用开关 + 文本）',
      cfgKeys.length === 2 && cfgKeys[0] === 'wmEnabled' && cfgKeys[1] === 'wmText',
      cfgLine,
    )

    // ---- ⑫ adj965：图片路径解析不了时**就地提示**（方案优化 7：绝不静默少画一层）----
    //   本用例里的文档是"未命名模板"（既没绑定工作区、也没有 nativePath）⇒ 相对路径必然解析不了，
    //   而**恰好**能验证"解析失败要说话"这一条 —— 这正是最容易做错的地方：
    //   悄悄不画，用户只会以为"设置了没用"。
    //   走「背景」页签（只填一个路径框即可触发解析），不必去动下拉框。
    //   ⚠ 上一步「保存设置」会**收起底栏** ⇒ 这里必须重新打开面板，否则 `.jp-tab` 已经不在 DOM 里。
    await evalJs(
      c,
      `[...document.querySelectorAll('.topbar-btn')].find((el) => (el.getAttribute('title') || '').includes('谱面')).click(), true`,
    )
    await waitFor(c, `!!document.querySelector('.pcfg-root')`, '谱面设置面板重新出现')
    await waitFor(
      c,
      `[...document.querySelectorAll('.jp-tab')].some((t) => t.textContent.includes('背景'))`,
      '「背景」子页签出现',
    )
    await evalJs(c, `[...document.querySelectorAll('.jp-tab')].find((t) => t.textContent.includes('背景')).click(), true`)
    await waitFor(c, `!!document.querySelector('.pcfg-text')`, '背景页签内容出现')
    // ⚠ 「启用背景」默认关（用户裁定）⇒ 关着时**连解析都不做**（不产生噪音提示），
    //   所以要先勾上，才谈得上"填了路径但解析不了"这个被测场景
    await evalJs(
      c,
      `(() => {
         const box = [...document.querySelectorAll('.pcfg-check input[type=checkbox]')][0]
         box.click()
         return box.checked
       })()`,
    )
    await sleep(250)
    await evalJs(c, `document.querySelector('.pcfg-text').focus(), true`)
    await c.send('Input.insertText', { text: '图.png' })
    await sleep(800)
    const errText = String(await evalJs(c, `document.querySelector('.pcfg-asset-err')?.textContent ?? ''`))
    check(
      '图片路径解析不了时**就地提示**（不静默少画一层）',
      errText.includes('尚未保存') || errText.includes('不支持读取图片'),
      errText.trim().slice(0, 40),
    )

    // ============ adj965d（EP-13）：预览区调「水印 / 背景」的 Alt 手势（**真派发鼠标事件**）============
    //   为什么必须真派发：`adj959` 的教训 —— "代码里挂了监听"与"事件真收得到"是两件事
    //   （监听挂错层、被 `stopPropagation` 掐断、wheel 挂成被动监听…源码级断言全都看不见）。
    //   这里走 CDP 的 `Input.dispatchMouseEvent`（浏览器原生输入路径），不是 `dispatchEvent(new Event(...))`。
    //
    //   本用例开工时的状态（承接上面 ⑫）：水印 = 已启用 + 文本「内部草稿」（已落盘）；
    //   背景 = 草稿里勾了启用 + 填了 `图.png`（未落盘，解析不了但**配置上有内容**）
    //   ⇒ 三层前提齐、且**两层都可用** ⇒ 角落应当出现「调整对象」切换器。
    await sleep(400)
    check(
      'adj965d 两层都可用 ⇒ 预览角落出现「调整对象」切换器（水印 / 背景）',
      (await evalJs(c, `!!document.querySelector('.preview-overlay-hint .poh-chip')`)) === true,
    )
    check(
      'adj965d 切换器默认选中「背景」（两层都可用时，手势默认作用在背景层）',
      (await evalJs(c, `document.querySelector('.poh-chip.is-active')?.textContent ?? ''`)) === '背景',
    )
    check(
      'adj965d 角落提示确实落在**预览区**里（`position: sticky` 生效，矩形在 `.preview-pane` 范围内）',
      await evalJs(
        c,
        `(() => {
           const h = document.querySelector('.preview-overlay-hint')
           const p = document.querySelector('.preview-pane')
           if (!h || !p) return false
           const a = h.getBoundingClientRect(), b = p.getBoundingClientRect()
           return a.height > 0 && a.bottom <= b.bottom + 1 && a.right <= b.right + 1 && a.top >= b.top - 1
         })()`,
      ),
    )
    // 切到「水印」：文本水印**在预览里真的画着** ⇒ 后面的断言既看配置、也看产物
    await evalJs(c, `[...document.querySelectorAll('.poh-chip')].find((el) => el.textContent === '水印').click(), true`)
    await sleep(200)
    check(
      'adj965d 点「水印」⇒ 它成为当前调整对象（切换器是真的在切）',
      (await evalJs(c, `document.querySelector('.poh-chip.is-active')?.textContent ?? ''`)) === '水印',
    )
    /**
     * adj965d：**只读自检钩子**。三条前提不满足时"什么都不发生"是设计使然，
     * 而远程看不见用户机器上的实况（真机上已经踩过一次）⇒ 留一个一句话取证的入口
     * （同 `__ijipuPlayhead` 的套路）。这里真调一次，确认它报的就是"此刻调哪一层"。
     */
    const overlayDiag = String(
      await evalJs(c, `typeof window.__ijipuOverlay === 'function' ? window.__ijipuOverlay() : '（没有自检钩子）'`),
    )
    check(
      'adj965d 自检钩子 `__ijipuOverlay()` 一句话说清"此刻调的是哪一层 / 三条前提各是什么"',
      overlayDiag.includes('排版辅助（前提①）=是') &&
        overlayDiag.includes('当前调整对象=水印') &&
        overlayDiag.includes('配置行=# jps-config'),
      overlayDiag.split('\n')[1] ?? '',
    )

    /** 取一个"同时落在预览容器与第一页里"的屏幕坐标（真鼠标事件必须有坐标，且必须落在监听的那个容器内） */
    const pointInPage = async (xFrac = 0.5, yFrac = 0.35) =>
      await evalJs(
        c,
        `(() => {
           const pane = document.querySelector('.preview-pane')?.getBoundingClientRect()
           const page = document.querySelector('.score-page')?.getBoundingClientRect()
           if (!pane || !page) return null
           const l = Math.max(pane.left, page.left, 0), r = Math.min(pane.right, page.right, window.innerWidth)
           const t = Math.max(pane.top, page.top, 0), b = Math.min(pane.bottom, page.bottom, window.innerHeight)
           if (r - l < 8 || b - t < 8) return null
           return { x: Math.round(l + (r - l) * ${xFrac}), y: Math.round(t + (b - t) * ${yFrac}) }
         })()`,
      )
    /** 预览里文本水印的三个可观测量：字号 / 旋转 / 中心 x（平移就看 tspan 的 x） */
    const wmVisual = async () =>
      await evalJs(
        c,
        `(() => {
           const t = document.querySelector('.score-page svg [data-overlay="wm"] text')
           if (!t) return null
           const span = t.querySelector('tspan')
           return { font: t.getAttribute('font-size'), transform: t.getAttribute('transform'), x: span ? Number(span.getAttribute('x')) : null }
         })()`,
      )
    /** 谱面源码里的 `# jps-config`（手势落盘后看它） */
    const cfgNow = async () => {
      const src = String(await evalJs(c, `document.querySelector('.editor-main textarea').value`))
      const line = (src.match(/# jps-config:(.*)/) ?? [])[1] ?? '{}'
      try {
        return JSON.parse(line)
      } catch {
        return {}
      }
    }
    /** 派发一次滚轮（`modifiers`：Alt=1、Ctrl=2、Shift=8，CDP 位掩码） */
    const wheel = (pt, deltaY, modifiers) =>
      c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY, modifiers })

    const pt = await pointInPage()
    check('adj965d 夹具自检：取到了"落在预览页内"的坐标（否则下面的真派发等于没发）', pt !== null, JSON.stringify(pt))

    // ---- ① `Alt+滚轮` ⇒ 缩放该层 ----
    const vis0 = await wmVisual()
    const cfg0 = await cfgNow()
    await wheel(pt, -120, 1)
    await sleep(700) // 手势停顿后自动落盘（实现里 OVERLAY_COMMIT_DELAY_MS = 400）
    const vis1 = await wmVisual()
    const cfg1 = await cfgNow()
    check(
      'adj965d **Alt+滚轮 ⇒ 缩放该层**：预览里的水印**真的变了**（文本水印缩的是字号）',
      vis0 !== null && vis1 !== null && Number(vis1.font) > Number(vis0.font),
      `字号 ${vis0?.font} → ${vis1?.font}`,
    )
    check(
      'adj965d 缩放**停顿后落盘**：`# jps-config` 里真的写进了 `wmSize`',
      cfg1.wmSize !== undefined && cfg1.wmSize !== cfg0.wmSize,
      `wmSize ${cfg0.wmSize ?? '（无）'} → ${cfg1.wmSize}`,
    )

    // ---- ② `Alt+Shift+滚轮` ⇒ 旋转该层 ----
    await wheel(pt, -120, 1 | 8)
    await sleep(700)
    const vis2 = await wmVisual()
    const cfg2 = await cfgNow()
    check(
      'adj965d **Alt+Shift+滚轮 ⇒ 旋转该层**：预览里的 `rotate(...)` 角度真的变了（绕元素自身中心由引擎保证）',
      vis2 !== null && /rotate\(/.test(String(vis2.transform)) && vis2.transform !== vis1?.transform,
      `${vis1?.transform ?? '（无）'} → ${vis2?.transform ?? '（无）'}`,
    )
    check(
      'adj965d 旋转停顿后落盘：`# jps-config` 里多了 `wmRotate`',
      cfg2.wmRotate !== undefined && cfg2.wmRotate !== cfg1.wmRotate,
      `wmRotate ${cfg1.wmRotate ?? '（无）'} → ${cfg2.wmRotate}`,
    )

    // ---- ②b 滚轮**累计**（用户 2026-10-15 确认）：不足一档不动，攒够一档才走一步 ----
    //   为什么必须真派发：这是"触控板一次滑动连跳好几档"的修法，纯逻辑断言只能证明函数，
    //   证明不了"事件接线里真的在累计"（余数没留 / 每事件都重置，都会在这里露出来）。
    const sizeBefore = (await cfgNow()).wmSize
    const stepOfSize = Math.max(1, Math.round(Number(sizeBefore) * 0.05))
    await wheel(pt, -50, 1)
    await sleep(700) // 停够时间：证明"不足一档 ⇒ 连落盘都不发生"（不是被吞掉后再补写）
    check(
      'adj965d 滚轮累计：**单次不足一档（50px）⇒ 配置一个字都没动**（余数留着，等下一次）',
      (await cfgNow()).wmSize === sizeBefore,
      `wmSize ${sizeBefore} → ${(await cfgNow()).wmSize}`,
    )
    await wheel(pt, -50, 1)
    await sleep(700)
    check(
      'adj965d 滚轮累计：**再补 50px（累计正好一档）⇒ 正好走一档**（余数没被丢掉）',
      (await cfgNow()).wmSize === Number(sizeBefore) + stepOfSize,
      `wmSize ${sizeBefore} → ${(await cfgNow()).wmSize}（应 +${stepOfSize}）`,
    )
    // 「preventDefault 真的生效」的真派发证据：Alt+滚轮**向下**滚三档，预览区不该跟着滚。
    // （挂成被动监听时 `preventDefault()` 被忽略 ⇒ 这里立刻变红；源码级闸门只是第二道保险。）
    // ⚠ 先把预览区滚回顶：否则"没滚"可能只是"本来就到底了"（空跑判真）。
    await evalJs(c, `(() => { const p = document.querySelector('.preview-pane'); p.scrollTop = 0; return true })()`)
    await sleep(150)
    const st0 = await evalJs(c, `document.querySelector('.preview-pane').scrollTop`)
    await wheel(pt, 300, 1)
    await sleep(700)
    const st1 = await evalJs(c, `document.querySelector('.preview-pane').scrollTop`)
    check(
      'adj965d Alt+滚轮**不会把预览区滚走**（`{ passive: false }` + preventDefault 真的生效）',
      st0 === 0 && st1 === 0,
      `预览区 scrollTop ${st0} → ${st1}（起始必须是 0，否则那条判据是空跑）`,
    )

    // ---- ③ `Alt+左键拖动` ⇒ 平移该层（按下 → 两次移动 → 松手，全走原生输入）----
    const vis3 = await wmVisual()
    const cfg3 = await cfgNow()
    const drag0 = await pointInPage(0.4, 0.4)
    const dragSteps = [
      [40, 26],
      [80, 52],
    ]
    await c.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: drag0.x,
      y: drag0.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      modifiers: 1,
    })
    for (const [dx, dy] of dragSteps) {
      await c.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: drag0.x + dx,
        y: drag0.y + dy,
        button: 'left',
        buttons: 1,
        modifiers: 1,
      })
    }
    const [lastDx, lastDy] = dragSteps[dragSteps.length - 1]
    await c.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: drag0.x + lastDx,
      y: drag0.y + lastDy,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      modifiers: 1,
    })
    await sleep(500)
    const vis4 = await wmVisual()
    const cfg4 = await cfgNow()
    check(
      'adj965d **Alt+左键拖动 ⇒ 平移该层**：wmOffsetX/Y 都变大，预览里水印仍在',
      vis3 !== null && vis4 !== null &&
        Number(cfg4.wmOffsetX ?? 0) > Number(cfg3.wmOffsetX ?? 0) &&
        Number(cfg4.wmOffsetY ?? 0) > Number(cfg3.wmOffsetY ?? 0),
      `offset ${cfg3.wmOffsetX ?? 0},${cfg3.wmOffsetY ?? 0} → ${cfg4.wmOffsetX},${cfg4.wmOffsetY}；tspan x ${vis3?.x} → ${vis4?.x}`,
    )
    check(
      'adj965d 拖动**松手即落盘**：`# jps-config` 里多了 `wmOffsetX` / `wmOffsetY`（且都是整数）',
      Number.isInteger(cfg4.wmOffsetX) && Number.isInteger(cfg4.wmOffsetY) && cfg4.wmOffsetX > 0 && cfg4.wmOffsetY > 0,
      `offset = ${cfg4.wmOffsetX}, ${cfg4.wmOffsetY}`,
    )

    // ---- ④ 切到「背景」再滚一次：证明切换器**真的换了作用对象**（改的是 `bgScale`，不是 `wmScale`）----
    //   背景图在本夹具里解析不了（未保存的谱 + 相对路径）⇒ 预览里没有 bg 层可看，
    //   所以这一条只判**配置**：那正是"背景图能不能摆"的唯一凭据。
    const cfgWmLayer = await cfgNow()
    await evalJs(c, `[...document.querySelectorAll('.poh-chip')].find((el) => el.textContent === '背景').click(), true`)
    await sleep(200)
    /**
     * adj965d（用户要求"加一层保险"）：背景层此刻**只在面板草稿里**（从没点过「保存设置」）
     * ⇒ 角落必须当面说一句"尚未写入谱面"，而不是让用户过一会儿发现"条没了、手势也不动了"。
     * 紧跟着滚一下（下面那条）会把它整层固化 ⇒ 提醒应当随即消失。
     */
    check(
      'adj965d 该层只在草稿里 ⇒ 角落给出「尚未写入谱面」提醒（**加的那层保险**）',
      String(await evalJs(c, `document.querySelector('.poh-unsaved')?.textContent ?? ''`)).includes('尚未写入谱面'),
      String(await evalJs(c, `document.querySelector('.poh-unsaved')?.textContent ?? ''`)).slice(0, 30),
    )
    await wheel(pt, -120, 1)
    await sleep(700)
    const cfgBgLayer = await cfgNow()
    check(
      'adj965d 切到「背景」后 Alt+滚轮 ⇒ 改的是 **`bgScale`**（水印那几个键**原封不动**，两层不串台）',
      cfgBgLayer.bgScale !== undefined &&
        cfgBgLayer.bgScale !== cfgWmLayer.bgScale &&
        cfgBgLayer.wmSize === cfgWmLayer.wmSize &&
        cfgBgLayer.wmRotate === cfgWmLayer.wmRotate &&
        cfgBgLayer.wmOffsetX === cfgWmLayer.wmOffsetX,
      `bgScale ${cfgWmLayer.bgScale ?? '（无）'} → ${cfgBgLayer.bgScale}`,
    )
    /**
     * adj965d（**用户在真机上踩到的那个坑**）：手势落盘**不许留"半截配置"**。
     *
     * 本用例到这一步为止，背景层只在**面板草稿**里开着（`bgEnabled`/`bgImage` 从没点过「保存设置」）
     * ⇒ 生效配置里有、源码层里没有。落盘走的是 `mergeConfigEdits(code, base, cfg)`
     * ——「只并 base 与 cfg 不同的键」：若基线取"按下时的完整快照"，那就**只有 `bgScale`** 被写进去，
     * 源码里留下"一个没启用的背景层 + 一个孤零零的宽度值"；用户随后在编辑器里打字/刷新一次
     * （生效配置重新从源码派生）⇒ 这一层连提示条带手势**一起消失**，而配置行里还留着那个孤儿键。
     *
     * 正确口径：**一次手势 = 把被调的那一层按现在看到的样子固化进谱面**
     * （该层自己的键在基线里置回默认 ⇒ 它们都算"本次改动"），同时**仍然不碰**别的东西。
     */
    check(
      'adj965d **不许留半截配置**：该层自己的键（启用 + 内容）跟手势**一起固化**（`bgEnabled`/`bgImage` 只在草稿里，也得写进去）',
      cfgBgLayer.bgEnabled === true && cfgBgLayer.bgImage === '图.png' && cfgBgLayer.bgScale !== undefined,
      `bgEnabled=${String(cfgBgLayer.bgEnabled)} bgImage=${String(cfgBgLayer.bgImage)} bgScale=${String(cfgBgLayer.bgScale)}`,
    )
    check(
      'adj965d 手势把它写进谱面之后 ⇒ 「尚未写入谱面」提醒**自己消失**（保险不是恒亮的）',
      (await evalJs(c, `!!document.querySelector('.poh-unsaved')`)) === false,
    )

    // ---- ⑤ 负向判据：**非排版辅助模式下按 Alt 什么都不该发生** ----
    await evalJs(
      c,
      `[...document.querySelectorAll('.topbar-btn')].find((el) => (el.getAttribute('title') || '').includes('排版辅助')).click(), true`,
    )
    await sleep(300)
    check(
      'adj965d 关掉「排版辅助」⇒ 角落提示与切换器一并消失（前提①）',
      (await evalJs(c, `!!document.querySelector('.preview-overlay-hint')`)) === false,
    )
    const cfgBeforeNeg = await cfgNow()
    const visBeforeNeg = await wmVisual()
    await wheel(pt, -120, 1)
    await sleep(900)
    const cfgAfterNeg = await cfgNow()
    const visAfterNeg = await wmVisual()
    check(
      'adj965d **负向判据**：排版辅助关着时 Alt+滚轮 ⇒ 配置与预览**一个字都没变**（手势完全不介入）',
      JSON.stringify(cfgAfterNeg) === JSON.stringify(cfgBeforeNeg) &&
        visAfterNeg?.font === visBeforeNeg?.font &&
        visAfterNeg?.transform === visBeforeNeg?.transform,
      `wmSize ${cfgBeforeNeg.wmSize} → ${cfgAfterNeg.wmSize}`,
    )

    // ---- ⑥ 正向回归：`Ctrl+单击音符` = 从这里试听，**照旧可用**（没被 Alt 手势抢走）----
    //     刻意在**排版辅助打开**（手势生效的模式）下测——这才是"两套交互并存"的真实场景。
    await evalJs(
      c,
      `[...document.querySelectorAll('.topbar-btn')].find((el) => (el.getAttribute('title') || '').includes('排版辅助')).click(), true`,
    )
    await sleep(300)
    await evalJs(c, `(() => { const p = document.querySelector('.preview-pane'); p.scrollTop = 0; p.scrollLeft = 0; return true })()`)
    await sleep(250)
    const notePt = await evalJs(
      c,
      `(() => {
         const pane = document.querySelector('.preview-pane')?.getBoundingClientRect()
         if (!pane) return null
         for (const el of document.querySelectorAll('.score-page svg [data-notepos]')) {
           const r = el.getBoundingClientRect()
           const x = r.left + r.width / 2, y = r.top + r.height / 2
           if (r.width > 0 && r.height > 0 && x > pane.left + 4 && x < pane.right - 4 && y > pane.top + 4 && y < pane.bottom - 4) {
             return { x: Math.round(x), y: Math.round(y) }
           }
         }
         return null
       })()`,
    )
    check('adj965d 夹具自检：取到了预览里可见音符的坐标', notePt !== null, JSON.stringify(notePt))
    // `Ctrl+单击`：modifiers=2（Ctrl）
    await c.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: notePt.x,
      y: notePt.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      modifiers: 2,
    })
    await c.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: notePt.x,
      y: notePt.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      modifiers: 2,
    })
    await sleep(800)
    check(
      'adj965d **Ctrl+单击音符 ⇒ 照旧从这里试听**（底栏切到「试听」；Alt 手势没有把这条路抢走）',
      (await evalJs(
        c,
        `[...document.querySelectorAll('.tool-dock-tab')].find((t) => t.textContent.includes('试听'))?.classList.contains('is-active') === true`,
      )) === true,
    )
    // ---- adj987d（用户 2026-10-18 口径）：标记段组的位置 / 纯图标 / 收起、文案 ----
    check(
      'adj987d 标记段组**在试听区下方**（DOM 里 `.practice-bar` 排在 `.playback-actions` 之后；不再插在曲目信息与播放按钮中间）',
      (await evalJs(
        c,
        `(() => {
          const bar = document.querySelector('.practice-bar')
          const actions = document.querySelector('.playback-actions')
          if (!bar || !actions) return 'missing'
          const rel = actions.compareDocumentPosition(bar)
          return (rel & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        })()`,
      )) === true,
    )
    check(
      'adj987d 组内按钮**只用图标**（起始/停止/添加/删除/循环，五个按钮都不含中文文本），中文只留在 title/aria-label',
      (await evalJs(
        c,
        `(() => {
          const btns = [...document.querySelectorAll('.practice-bar .practice-btn')]
          if (btns.length !== 5) return 'count:' + btns.length
          const cjk = /[\\u4e00-\\u9fa5]/
          const bad = btns.filter((b) => cjk.test(b.textContent || ''))
          const labelled = btns.every((b) => (b.getAttribute('aria-label') || '').length > 0)
          return bad.length === 0 && labelled
        })()`,
      )) === true,
    )
    check(
      'adj987d 组标题文案是「**标记段**」（不再是「练习段」）',
      (await evalJs(c, `document.querySelector('.practice-bar .practice-title')?.textContent`)) === '标记段',
    )

    // ============ adj966f：两边都改了 ⇒ 逐块采纳 / 自动三路合并（**真点一遍**） ============
    //
    // 为什么这段必须真点（而不是只写源码级断言）：`adj959` 的教训 —— "事件挂错地方"这类缺陷
    // 源码里看着全对（`tsc`/`lint`/`smoke` 全绿），点下去却没反应：差异框里按钮点了不生效、
    // 「应用（并保存）」没把结果写回文件、状态没收口（提示条不走），冒烟全都看不见。
    //
    // 做法：**注入一个假 FSA 句柄**（`showOpenFilePicker` + `getFile` / `createWritable`），
    // 于是应用走的是正常的"网页版 FSA 档"：打开 = 真句柄、监视 = 真轮询（4 秒一跳）、
    // "外部改动" = 我们直接改那个假文件的内容与 mtime ⇒ 从头到尾走完整条链，
    // 直到差异框里逐块点「用左 / 用右」与底部「应用（并保存）」——**并核对假文件真的被写回**。
    const BASE_JPS = [
      'V: 1.0',
      'B: 合并测试',
      'D: C',
      'P: 4/4',
      'Q: 1 2 3 | 4 5 6 |',
      'Q: 1 1 1 | 2 2 2 |',
      'Q: 3 3 3 | 4 4 4 |',
      'Q: 5 5 5 | 6 6 6 |',
      '',
    ].join('\n')
    /** 本地那份：把第 6 行改成 `…2 2 9 |`（`withLocal` 用于两个场景各改一次） */
    const LOCAL_LINE = 'Q: 1 1 1 | 2 2 9 |'
    const CONFLICT_LINE = 'Q: 1 1 1 | 8 8 8 |'
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(300)
    await c.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.__fakeFile = { name: '合并测试.jps', text: ${JSON.stringify(BASE_JPS)}, mtime: 1000 }
        window.showOpenFilePicker = async () => [{
          kind: 'file',
          name: window.__fakeFile.name,
          getFile: async () => new File([window.__fakeFile.text], window.__fakeFile.name, { lastModified: window.__fakeFile.mtime }),
          createWritable: async () => ({
            write: async (t) => { window.__fakeFile.text = String(t) },
            close: async () => { window.__fakeFile.mtime += 1000 },
            abort: async () => {},
          }),
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
        }]
      })()`,
    })
    await c.send('Page.reload')
    await sleep(700)
    await waitFor(
      c,
      `typeof window.showOpenFilePicker === 'function' && !!document.querySelector('.editor-main textarea')`,
      '重载后：假 FSA 就位 + 应用首屏',
    )
    console.log('[verify-app-ui] adj966f：两边都改了 —— 块级采纳 / 自动三路合并（真点）')

    /** 走真实菜单打开那个假文件（用「打开（系统文件选择器）」这一项：它必然调 `openFile`） */
    const openFakeFile = async () => {
      await evalJs(c, `document.querySelector('.topbar-hamburger-btn').click(), true`)
      await waitFor(c, `!!document.querySelector('.topbar-hamburger.open .menu-dropdown')`, '菜单打开')
      const hit = await evalJs(
        c,
        `(() => {
           const el = [...document.querySelectorAll('.topbar-hamburger.open .menu-entry')].find((x) => x.textContent.includes('系统文件选择器'))
           if (!el) return 'no-entry'
           el.click()
           return 'ok'
         })()`,
      )
      if (hit !== 'ok') throw new Error('菜单里找不到「打开（系统文件选择器）」')
      await waitFor(
        c,
        `document.querySelector('.editor-main textarea').value.includes('合并测试')`,
        '假文件已打开（内容进编辑器）',
      )
    }
    /** 把编辑器内容整份换成 `text`（真输入事件，走 React 的 onChange） */
    const retypeEditor = async (text) => {
      await evalJs(
        c,
        `(() => { const ta = document.querySelector('.editor-main textarea'); ta.focus(); ta.setSelectionRange(0, ta.value.length); return true })()`,
      )
      await c.send('Input.insertText', { text })
      await sleep(700)
    }
    const fakeSetText = (text) =>
      evalJs(c, `(window.__fakeFile.text = ${JSON.stringify(text)}, window.__fakeFile.mtime += 5000, true)`)

    // ---- 场景一：两边改**不同块**（互不重叠）⇒ P2 自动合 + 一键「应用」 ----
    await openFakeFile()
    await retypeEditor(BASE_JPS.replace('Q: 1 1 1 | 2 2 2 |', LOCAL_LINE))
    const localNow = String(await evalJs(c, `document.querySelector('.editor-main textarea').value`))
    check(
      'adj966f 夹具自检：本地那行改动已进编辑器（没被自动格式化改掉）',
      localNow.includes('2 2 9'),
      localNow.split('\n').slice(4, 7).join(' ／ '),
    )
    await fakeSetText(BASE_JPS.replace('Q: 5 5 5 | 6 6 6 |', 'Q: 5 5 5 | 6 6 7 |'))
    await waitFor(c, `!!document.querySelector('.confirm-bar')`, '轮询发现外部改动 ⇒ 确认条出现', 60)
    const autoAsk = String(await evalJs(c, `document.querySelector('.confirm-bar-text').textContent`))
    const autoBtns = await evalJs(c, `[...document.querySelectorAll('.confirm-bar-btn')].map((b) => b.textContent.trim())`)
    check(
      'adj966f **P2 自动合**：两边改的块互不重叠 ⇒ 确认条说"已自动合好…互不重叠"，并给出「应用」按钮',
      autoAsk.includes('互不重叠') && autoBtns.includes('应用'),
      JSON.stringify({ 文案: autoAsk.slice(0, 34), 按钮: autoBtns }),
    )
    await evalJs(
      c,
      `[...document.querySelectorAll('.confirm-bar-btn')].find((b) => b.textContent.trim() === '应用').click(), true`,
    )
    await sleep(900)
    const autoFile = String(await evalJs(c, `window.__fakeFile.text`))
    const autoEditor = String(await evalJs(c, `document.querySelector('.editor-main textarea').value`))
    check(
      'adj966f **点「应用」⇒ 合并结果真的写回了文件**（假句柄收到的文本 == 编辑器），且**两边都没丢**（本地那行 + 外部那行都在）',
      autoFile === autoEditor && autoFile.includes('2 2 9') && autoFile.includes('6 6 7'),
      JSON.stringify({ 文件尾: autoFile.split('\n').slice(-4).join(' ／ ') }),
    )

    // ---- 场景二：两边改**同一块** ⇒ 必须逐块选（不许自动合并吞掉），选「用右」再应用 ----
    await fakeSetText(BASE_JPS) // 假文件恢复成共同祖先那份（同时推进 mtime）
    await c.send('Page.reload')
    await sleep(700)
    await waitFor(
      c,
      `typeof window.showOpenFilePicker === 'function' && !!document.querySelector('.editor-main textarea')`,
      '重载（冲突场）',
    )
    await openFakeFile()
    await retypeEditor(BASE_JPS.replace('Q: 1 1 1 | 2 2 2 |', LOCAL_LINE)) // 本地改第 6 行
    await fakeSetText(BASE_JPS.replace('Q: 1 1 1 | 2 2 2 |', CONFLICT_LINE)) // 外部改**同一行**（另一种改法）
    await waitFor(c, `!!document.querySelector('.confirm-bar')`, '轮询发现外部改动（冲突场）', 60)
    const clashAsk = String(await evalJs(c, `document.querySelector('.confirm-bar-text').textContent`))
    const clashBtns = await evalJs(c, `[...document.querySelectorAll('.confirm-bar-btn')].map((b) => b.textContent.trim())`)
    check(
      'adj966f **冲突**：两边改同一块 ⇒ 确认条走"要你决定"的说法（不是"已自动合好"），且**不给**「应用」快捷按钮',
      clashAsk.includes('查看差异') && !clashAsk.includes('互不重叠') && !clashBtns.includes('应用'),
      JSON.stringify({ 文案: clashAsk.slice(0, 34), 按钮: clashBtns }),
    )
    await evalJs(
      c,
      `[...document.querySelectorAll('.confirm-bar-btn')].find((b) => b.textContent.trim() === '查看差异').click(), true`,
    )
    await waitFor(c, `!!document.querySelector('.file-diff')`, '差异框打开')
    await waitFor(c, `document.querySelectorAll('.diff-bar').length > 0`, '差异框里有块操作条')
    const barCount = await evalJs(c, `document.querySelectorAll('.diff-bar').length`)
    const barLabels = await evalJs(c, `[...new Set([...document.querySelectorAll('.diff-bar-btn')].map((b) => b.textContent.trim()))]`)
    const barTags = String(await evalJs(c, `[...document.querySelectorAll('.diff-bar-tag')].map((t) => t.textContent).join(' ｜ ')`))
    check(
      'adj966f 差异框：每个改动块给出「用左 / 用右」（两栏各一条 ⇒ 块数 ×2），冲突块标出"两边都改了同一块"',
      barCount >= 2 && barCount % 2 === 0 && barLabels.includes('用左') && barLabels.includes('用右') && barTags.includes('冲突'),
      JSON.stringify({ 操作条: barCount, 按钮: barLabels, 标签: barTags.slice(0, 40) }),
    )
    /**
     * adj967c（**用户截图实报**「有变化处看不到两侧各修改的是什么，遮住了」）：
     * 块操作条早先与"块首那一行"是**同一条 item** ⇒ 那一行被吃掉；单行改动块里"改动的那一行"
     * 正好是块首行 ⇒ 用户只看到操作条、看不到改了什么。这条判据盯的就是"改动的行必须真的在 DOM 里、
     * 两栏各显示自己那一版"，光看"操作条在不在"是抓不住的。
     */
    const changeLines = await evalJs(
      c,
      `[...document.querySelectorAll('.file-diff-pane')].map((p) => [...p.querySelectorAll('.diff-line[data-kind="change"]')].map((l) => l.textContent.trim()).join('\\n'))`,
    )
    const leftChange = String(changeLines?.[0] ?? '')
    const rightChange = String(changeLines?.[1] ?? '')
    check(
      'adj967c **改动的行必须可见**：左栏显示本地那一版、右栏显示外部那一版（不是被操作条盖住/吃掉）',
      leftChange.includes('2 2 9') && rightChange.includes('8 8 8') && !leftChange.includes('8 8 8') && !rightChange.includes('2 2 9'),
      JSON.stringify({ 左栏改动行: leftChange.slice(0, 40), 右栏改动行: rightChange.slice(0, 40) }),
    )
    const barOverRow = await evalJs(
      c,
      `(() => {
         const bars = [...document.querySelectorAll('.diff-bar')].map((b) => b.getBoundingClientRect())
         const rows = [...document.querySelectorAll('.diff-line')].map((r) => r.getBoundingClientRect())
         // 操作条与任何**行**都不许在纵向上相互覆盖
         return bars.some((b) => rows.some((r) => b.top < r.bottom - 1 && r.top < b.bottom - 1))
       })()`,
    )
    check('adj967c 操作条与代码行**不重叠**（几何上各占各的高度）', barOverRow === false, String(barOverRow))
    // 点**第一条**操作条里的「用右」（= 那个冲突块改用外部那一版）
    await evalJs(c, `document.querySelectorAll('.diff-bar')[0].querySelectorAll('.diff-bar-btn')[1].click(), true`)
    await sleep(250)
    const onCls = String(
      await evalJs(c, `document.querySelectorAll('.diff-bar')[0].querySelectorAll('.diff-bar-btn')[1].className`),
    )
    check('adj966f 差异框：点「用右」⇒ 该块选中态真的切过去（按钮挂在该块上，不是点了没反应）', onCls.includes('is-on'), onCls)
    await evalJs(
      c,
      `[...document.querySelectorAll('.file-diff-foot button')].find((b) => b.textContent.includes('应用')).click(), true`,
    )
    await sleep(900)
    const clashFile = String(await evalJs(c, `window.__fakeFile.text`))
    const clashEditor = String(await evalJs(c, `document.querySelector('.editor-main textarea').value`))
    check(
      'adj966f 冲突场：选「用右」+「应用（并保存）」⇒ **外部那一版进了文件、本地那一版被换掉**，编辑器与文件一致',
      clashFile === clashEditor && clashFile.includes('8 8 8') && !clashFile.includes('2 2 9'),
      JSON.stringify({ 第6行: (clashFile.split('\n')[5] ?? '').trim() }),
    )
    check(
      'adj966f 收口：应用并保存后**确认条与差异框都关掉了**（基准已刷新 ⇒ 不会反复提示）',
      (await evalJs(c, `!!document.querySelector('.confirm-bar')`)) === false &&
        (await evalJs(c, `!!document.querySelector('.file-diff')`)) === false,
    )

    // ============ adj968：把 .jps 拖进窗口就能打开（**真拖一次**） ============
    //
    // 为什么这段必须真跑：拖放的坑全在"事件与默认行为"上 —— 不 `preventDefault()` 浏览器会把拖进来的
    // 文件当成"导航到该文件"、直接把应用页替换掉；`getAsFileSystemHandle()` 晚一步收集就永远拿不到句柄。
    // 源码级断言只能证明"写了这几行"，证明不了"拖进去真的打开了"。
    // 构造方式：页面里 `new DataTransfer()` + `new File(...)` + `new DragEvent('dragover'/'drop')`
    // ——真实拖放的 `dataTransfer.files/items` 正是这样被填充的（本机无 OS 级拖放模拟通道）。
    console.log('[verify-app-ui] adj968：拖放打开 .jps（真拖）')
    const DROP_TEXT = 'V: 1.0\nB: 拖放测试\nD: C\nP: 4/4\nQ: 1 2 3 |\n'
    const fireDrag = (name, text, phase) => `(() => {
      const dt = new DataTransfer()
      dt.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: 'text/plain' }))
      const ev = new DragEvent(${JSON.stringify(phase)}, { dataTransfer: dt, bubbles: true, cancelable: true })
      window.dispatchEvent(ev)
      return { prevented: ev.defaultPrevented }
    })()`
    const overInfo = await evalJs(c, fireDrag('拖放测试.jps', DROP_TEXT, 'dragover'))
    // ⚠ 覆盖层是 React 状态驱动的 ⇒ 必须等一次渲染再读 DOM（同一次 JS 回合里读只会拿到 null）
    await sleep(250)
    const hintText = String(await evalJs(c, `document.querySelector('.drop-overlay-main')?.textContent ?? ''`))
    const subText = String(await evalJs(c, `document.querySelector('.drop-overlay-sub')?.textContent ?? ''`))
    check(
      'adj968 dragover **必须被拦**（否则浏览器会把拖进来的文件当成"导航到该文件"，把应用页替换掉）+ 覆盖层显示"松开即打开「拖放测试.jps」"',
      overInfo?.prevented === true && hintText.includes('拖放测试.jps') && subText.includes('替换'),
      JSON.stringify({ ...overInfo, hint: hintText }),
    )
    await evalJs(c, fireDrag('拖放测试.jps', DROP_TEXT, 'drop'))
    await waitFor(c, `document.querySelector('.editor-main textarea').value.includes('拖放测试')`, '拖入的谱已进编辑器')
    const dropNotice = String(await evalJs(c, `document.querySelector('.toast-text')?.textContent ?? ''`))
    const overlayGone = await evalJs(c, `!!document.querySelector('.drop-overlay')`)
    check(
      'adj968 拖入 ⇒ **真的打开了**（内容进编辑器 + 提示里点名这份文件）、且覆盖层收掉了',
      dropNotice.includes('拖放测试') && overlayGone === false,
      JSON.stringify({ 提示: dropNotice.slice(0, 34) }),
    )
    // ---- adj1013（用户要求）：提示改到**右上角、顶栏下方**（原来在右下角，被常用操作底栏 dock 遮住）----
    // 为什么要在真浏览器里量：源码里断言"CSS 写了 top"证明不了实际落点（高度 token、父级定位、动画位移都可能让它跑偏）。
    await sleep(200) // 尽量等入场动画（0.18s）走完再量；即便没走完，下面判据也留了 8px 容差（动画只有 -6px）
    const toastBox = await evalJs(c, `(() => {
      const el = document.querySelector('.toast')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const tb = document.querySelector('.topbar')?.getBoundingClientRect()
      // adj1295：右栏占着右边一列时，提示贴的是**右栏的左缘**而不是视口右缘
      const dock = document.querySelector('.right-dock')
      const dockW = dock ? Math.round(dock.getBoundingClientRect().width) : 0
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, height: r.height, vw: innerWidth, vh: innerHeight, topbarBottom: tb ? tb.bottom : null, dockW }
    })()`)
    check(
      'adj1013 提示真的落在**右上角、顶栏下方**（顶边在顶栏之下、右缘贴右——adj1295 起若有右栏则贴右栏左缘、不越到下半区 ⇒ 不再压住底部 dock）',
      !!toastBox &&
        toastBox.topbarBottom !== null &&
        toastBox.top >= toastBox.topbarBottom - 8 &&
        Math.abs(toastBox.vw - toastBox.dockW - toastBox.right) <= 30 &&
        toastBox.left > (toastBox.vw - toastBox.dockW) / 2 &&
        toastBox.bottom < toastBox.vh / 2,
      JSON.stringify(toastBox),
    )
    // 多行文案：顶边不动、高度往下长（用户说的「多行信息向下延伸」）。
    // 现造一条长提示来量：同一条 CSS 类、同一定位，只是文案变长。
    const multilineBox = await evalJs(c, `(() => {
      const host = document.querySelector('.app')
      const el = document.createElement('div')
      el.className = 'toast toast-warn'
      el.style.animation = 'none' // 量静态落点，别被入场位移干扰
      const span = document.createElement('span')
      span.className = 'toast-text'
      span.textContent = '这是一条很长的提示，用来确认多行时向下方延伸而不是向上顶到顶栏。'.repeat(3)
      el.appendChild(span)
      host.appendChild(el)
      const r = el.getBoundingClientRect()
      const lh = parseFloat(getComputedStyle(el).lineHeight)
      const out = { top: r.top, height: r.height, lineHeight: lh }
      el.remove()
      return out
    })()`)
    check(
      'adj1013 多行提示**向下延伸**（换行后高度 > 两行，顶边与单行提示同高）',
      !!multilineBox && multilineBox.height > multilineBox.lineHeight * 2 && Math.abs(multilineBox.top - toastBox.top) < 8,
      JSON.stringify(multilineBox),
    )
    // ---- 脏文档闸：有未保存修改时先问一句，确认之前一个字都不许变 ----
    await retypeEditor(`${DROP_TEXT}Q: 5 5 5 |\n`)
    const dirtyNow = await evalJs(c, `!!document.querySelector('.dirty-dot')`)
    const beforeDrop = String(await evalJs(c, `document.querySelector('.editor-main textarea').value`))
    await evalJs(c, fireDrag('第二次拖入.jps', 'V: 1.0\\nB: 第二次拖入\\nD: C\\nP: 4/4\\nQ: 6 6 6 |\\n', 'drop'))
    await waitFor(c, `!!document.querySelector('.confirm-bar')`, '脏文档拖入 ⇒ 确认条')
    const dropAskText = String(await evalJs(c, `document.querySelector('.confirm-bar-text').textContent`))
    const stillOld = String(await evalJs(c, `document.querySelector('.editor-main textarea').value`))
    check(
      'adj968 **脏文档先问一句**：拖入时弹出确认条（文案点明"未保存 + 打开并替换"），且**此时内容原封不动**',
      dirtyNow === true && dropAskText.includes('未保存') && dropAskText.includes('第二次拖入') && stillOld === beforeDrop,
      JSON.stringify({ 脏标记: dirtyNow, 文案: dropAskText.slice(0, 30) }),
    )
    await evalJs(c, `document.querySelector('.confirm-bar-btn.is-primary').click(), true`)
    await waitFor(c, `document.querySelector('.editor-main textarea').value.includes('第二次拖入')`, '确认后真的替换了文档')
    check('adj968 确认后按用户选的做：文档换成拖入的那一份（没有静默丢、也不是"点了没反应"）', true)
    // ---- 负对照：拖进来的不是 .jps ⇒ 什么都不做（内容不变、不弹确认条） ----
    const beforePng = String(await evalJs(c, `document.querySelector('.editor-main textarea').value`))
    await evalJs(c, fireDrag('图片.png', 'not a score', 'drop'))
    await sleep(400)
    check(
      'adj968 **负对照**：拖进来的不是 .jps ⇒ 什么都不做（内容不变、不弹确认条）',
      (await evalJs(c, `document.querySelector('.editor-main textarea').value`)) === beforePng &&
        (await evalJs(c, `!!document.querySelector('.confirm-bar')`)) === false,
    )

    // ============ adj969：**文件方式打开的谱**里相对路径背景图（真授权一次文件夹） ============
    //
    // 用户实报："拖入 / 文件选择器打开的 .jps 里，文件方式的相对路径背景图找不到。"
    // 根因：浏览器**不给文件句柄的父目录**（Web 的硬限制）⇒ 基准算不出来 ⇒ 相对路径解析必然失败，
    // 而且失败只在「设置 → 水印/背景」页签里显示（怕每次重排刷屏）⇒ 用户等于没有提示。
    //
    // 为什么这段必须真点（源码级断言守不住）：`showDirectoryPicker()` **必须在用户手势里**调，
    // 而"打开动作那个手势还在不在"只有真浏览器 + 真点击能回答 —— 这里用
    // `navigator.userActivation.isActive` 在假选择器里**当场记下**，证明我们确实是在手势里弹的。
    //
    // 三段：
    //  ① 打开 ⇒ **自动弹一次**文件夹选择器（且在手势里）；用户选了个**不含这份谱的目录** ⇒ 不采信；
    //  ② 负对照：此时预览里**没有**背景层（假目录不采信 ⇒ 绝不拿它去读同名图）；
    //  ③ 去「设置 → 背景」页签点「授权所在文件夹」⇒ 这次选对 ⇒ **背景图真的画出来了**，提示也收掉了。
    console.log('[verify-app-ui] adj969：文件方式打开的谱 + 相对路径背景图（真授权）')
    const ASSET_JPS =
      'V: 1.0\nB: 授权测试\nD: C\nP: 4/4\nQ: 1 2 3 4 | 5 6 7 1 |\n# jps-config:{"bgEnabled":true,"bgImage":"img/底纹.png"}\n'
    /** 1×1 透明 PNG（真图片字节 ⇒ 走 `Image`/`decode` 那条真解码路径） */
    const TINY_PNG_B64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
    await c.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const JPS = ${JSON.stringify(ASSET_JPS)}
        const PNG = Uint8Array.from(atob(${JSON.stringify(TINY_PNG_B64)}), (ch) => ch.charCodeAt(0))
        const MTIME = 424242
        window.__assetProbe = { dirCalls: 0, activation: [], picked: [] }
        // 假"文件句柄"：getFile() 给出与 .jps 完全一致的 name/size/lastModified
        const jpsHandle = {
          kind: 'file',
          name: '授权测试.jps',
          getFile: async () => new File([JPS], '授权测试.jps', { lastModified: MTIME }),
          createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }),
        }
        const imgHandle = {
          kind: 'file',
          name: '底纹.png',
          getFile: async () => ({ arrayBuffer: async () => PNG.buffer, type: 'image/png', lastModified: 1 }),
        }
        // 假目录：correct = 本谱所在目录（含同名 .jps + img/底纹.png）；wrong = 别的目录
        const dir = (name, children) => ({
          kind: 'directory',
          name,
          getDirectoryHandle: async (n) => {
            const c = children[n]
            if (c === undefined) throw Object.assign(new Error('不在'), { name: 'NotFoundError' })
            return c
          },
          getFileHandle: async (n) => {
            const c = children[n]
            if (c === undefined) throw Object.assign(new Error('不在'), { name: 'NotFoundError' })
            return c
          },
        })
        window.__assetDirs = {
          correct: dir('正确的目录', { '授权测试.jps': jpsHandle, img: dir('img', { '底纹.png': imgHandle }) }),
          wrong: dir('错误的目录', { '别的谱.jps': jpsHandle }),
        }
        window.showOpenFilePicker = async () => [jpsHandle]
        /**
         * 第 1 次（打开时自动弹的那次）返回**错的目录**（用来做负对照），之后返回对的目录。
         * 同时把"弹出时用户手势还在不在"记下来。
         */
        window.showDirectoryPicker = async (opts) => {
          window.__assetProbe.dirCalls += 1
          window.__assetProbe.activation.push(!!(navigator.userActivation && navigator.userActivation.isActive))
          const pick = window.__assetProbe.dirCalls === 1 ? 'wrong' : 'correct'
          window.__assetProbe.picked.push(pick)
          return window.__assetDirs[pick]
        }
      })()`,
    })
    await c.send('Page.reload')
    await sleep(800)
    await waitFor(
      c,
      `typeof window.showDirectoryPicker === 'function' && !!document.querySelector('.editor-main textarea')`,
      '重载后：假文件/文件夹选择器就位 + 应用首屏',
    )
    // ① 走真实菜单打开那个假文件
    await evalJs(c, `document.querySelector('.topbar-hamburger-btn').click(), true`)
    await waitFor(c, `!!document.querySelector('.topbar-hamburger.open .menu-dropdown')`, '菜单打开')
    const opened = await evalJs(
      c,
      `(() => {
         const el = [...document.querySelectorAll('.topbar-hamburger.open .menu-entry')].find((x) => x.textContent.includes('系统文件选择器'))
         if (!el) return 'no-entry'
         el.click()
         return 'ok'
       })()`,
    )
    if (opened !== 'ok') throw new Error('菜单里找不到「打开（系统文件选择器）」')
    await waitFor(c, `document.querySelector('.editor-main textarea').value.includes('授权测试')`, '假文件已打开')
    // 打开后**立刻问一句**（顶部确认条）——注意：**不能**在这里直接弹文件夹对话框，
    // 因为 `showOpenFilePicker()` 已经把这次"用户手势"用掉了（下面那条断言就是量这个的：
    // 点确认条按钮时 `userActivation.isActive` 必须为真，而打开动作之后它已经是 false）。
    await waitFor(c, `!!document.querySelector('.confirm-bar')`, '打开后立刻在确认条里问一句', 40)
    const dirAskText = String(await evalJs(c, `document.querySelector('.confirm-bar-text')?.textContent ?? ''`))
    const dirAskBtns = await evalJs(c, `[...document.querySelectorAll('.confirm-bar-btn')].map((b) => b.textContent.trim())`)
    check(
      'adj969 打开后**立刻问一句**：确认条说明"文件方式打开的谱 + 浏览器不给目录"，并给出「授权所在文件夹」按钮',
      dirAskText.includes('相对路径的图片') && dirAskText.includes('浏览器不提供文件所在目录') && dirAskBtns.includes('授权所在文件夹'),
      JSON.stringify({ 文案: dirAskText.slice(0, 40), 按钮: dirAskBtns }),
    )
    const probe0 = await evalJs(c, `JSON.parse(JSON.stringify(window.__assetProbe))`)
    check(
      'adj969 夹具自检：**打开动作本身没有弹过任何文件夹对话框**（否则下面"点按钮那一下才有手势"是空跑）',
      probe0?.dirCalls === 0,
      JSON.stringify(probe0),
    )
    /**
     * 真点一个按钮（走 CDP 原生鼠标路径）。
     *
     * ⚠ 这里**必须**用真鼠标：`el.click()` 是**合成点击**，**不会产生用户手势**
     * （本轮实测：合成点击时 `navigator.userActivation.isActive === false`）。本段的判据正是
     * "点按钮那一下有没有手势"，用合成点击等于把判据自己做成恒假。
     *
     * ⚠ 还必须**先把元素滚进视口**：设置面板在底栏 dock 里、内容可滚动，而"背景"页签底部那个
     * 按钮很可能落在视口外（`getBoundingClientRect().top > 视口高`）—— 合成点击照样能触发，
     * 真鼠标点击则会点到窗口外面（本轮实测：`dirCalls` 一直停在 1，看起来像"按钮没反应"）。
     */
    const realClickText = async (selector, text) => {
      const found = await evalJs(
        c,
        `(() => {
           const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.includes(${JSON.stringify(text)}))
           if (!el) return false
           el.scrollIntoView({ block: 'center', inline: 'center' })
           return true
         })()`,
      )
      if (!found) throw new Error(`找不到按钮：${selector} × ${text}`)
      await sleep(250) // 等滚动/重排落定再量坐标
      const pt = await evalJs(
        c,
        `(() => {
           const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.includes(${JSON.stringify(text)}))
           if (!el) return null
           const r = el.getBoundingClientRect()
           return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), vw: innerWidth, vh: innerHeight }
         })()`,
      )
      if (!pt || pt.x < 0 || pt.y < 0 || pt.x > pt.vw || pt.y > pt.vh) {
        throw new Error(`按钮不在视口内，点不到：${JSON.stringify(pt)}`)
      }
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 })
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1 })
      return pt
    }
    // 点确认条上的按钮 ⇒ **这一下才是合法手势**（假选择器里当场记下 userActivation）
    await realClickText('.confirm-bar-btn', '授权所在文件夹')
    await waitFor(c, `window.__assetProbe.dirCalls >= 1`, '按钮真的弹出了文件夹选择器', 40)
    await sleep(600)
    const probe1 = await evalJs(c, `JSON.parse(JSON.stringify(window.__assetProbe))`)
    check(
      'adj969 **真点**「授权所在文件夹」⇒ 选择器真的弹出，且这一下 `userActivation.isActive` 为真（真浏览器里不会被 `SecurityError` 顶掉）',
      probe1?.dirCalls === 1 && probe1?.activation?.[0] === true && probe1?.picked?.[0] === 'wrong',
      JSON.stringify(probe1),
    )
    // ② 负对照：选的是**不含这份谱**的目录 ⇒ 不采信 ⇒ 预览里不许出现背景层
    const bgBefore = await evalJs(c, `!!document.querySelector('.score-page svg [data-overlay="bg"]')`)
    check(
      'adj969 **负对照**：所选目录里没有这份谱 ⇒ **不采信**（预览里没有背景层，绝不拿它去读同名图）',
      bgBefore === false,
    )
    // ③ 去「背景」页签点「授权所在文件夹」⇒ 这次选对 ⇒ 背景图真的画出来
    await evalJs(
      c,
      `(() => {
         const b = [...document.querySelectorAll('.topbar-btn')].find((el) => (el.getAttribute('title') || '').includes('谱面'))
         if (b) b.click()
         return true
       })()`,
    )
    await waitFor(c, `!!document.querySelector('.pcfg-root')`, '谱面设置面板出现')
    await waitFor(
      c,
      `[...document.querySelectorAll('.jp-tab')].some((t) => t.textContent.includes('背景'))`,
      '「背景」子页签出现',
    )
    await evalJs(c, `[...document.querySelectorAll('.jp-tab')].find((t) => t.textContent.includes('背景')).click(), true`)
    await waitFor(c, `!!document.querySelector('.pcfg-asset-err')`, '页签里就地显示"取不到图"的提示')
    const assetErrText = String(await evalJs(c, `document.querySelector('.pcfg-asset-err')?.textContent ?? ''`))
    check(
      'adj969 提示能照着做：页签里说明"浏览器不给文件所在目录"，并给出「授权所在文件夹」按钮',
      assetErrText.includes('浏览器不提供文件所在目录') && assetErrText.includes('授权所在文件夹'),
      assetErrText.slice(0, 60),
    )
    // 设置页签里那个按钮也**真点**（同上：合成点击没有手势；真机上是用户手指/鼠标点的）
    //
    // ⚠ 这一步要**量准了再点**：这个面板是常驻在底栏 dock 里的，切页签后 `measureFields()` 会按
    // 容器宽重排字段网格（`useLayoutEffect` + `MutationObserver`）⇒ 按钮位置可能在"量"与"点"
    // 之间挪一点。所以这里带**重试**（最多 3 次），而不是只点一下 —— 否则就会像本轮第一次那样
    // 报"等待超时：按钮真的弹出了文件夹选择器"，而其实只是点空了。
    let dirHit = false
    for (let i = 0; i < 3 && !dirHit; i++) {
      await sleep(400)
      await realClickText('.pcfg-asset-err button', '授权所在文件夹')
      await sleep(600)
      dirHit = (await evalJs(c, `window.__assetProbe.dirCalls`)) >= 2
    }
    check('adj969 页签里的「授权所在文件夹」按钮真的弹出了文件夹选择器（最多重试 3 次，避开面板重排）', dirHit)
    await waitFor(
      c,
      `!!document.querySelector('.score-page svg [data-overlay="bg"] image')`,
      '授权后背景图真的画出来了',
      60,
    )
    const bgHref = String(
      await evalJs(c, `document.querySelector('.score-page svg [data-overlay="bg"] image')?.getAttribute('href') ?? ''`),
    )
    check(
      'adj969 **授权所在文件夹之后，相对路径的背景图真的画出来**（是内嵌 data URI，导出/打印同一份）',
      bgHref.startsWith('data:image/'),
      bgHref.slice(0, 30),
    )
    await sleep(300)
    check(
      'adj969 授权成功后提示**收掉**（不留着一条已经解决的红字）',
      (await evalJs(c, `!!document.querySelector('.pcfg-asset-err')`)) === false,
    )

    // ============ adj971/adj978：标题 = **文件名**（应用名交给外壳）、版本在状态栏（**真读 DOM**）============
    //
    // 为什么必须真读：标题与状态栏都是"运行时才写上去"的东西 —— 源码里写了 `document.title = title`
    // 不等于**这一份文件**的名字真的进了标题（可能是空、可能没跟着换文件变）。这里就着上一步已经
    // 打开的 `授权测试.jps` 直接读页面状态。
    console.log('[verify-app-ui] adj971：标题（文件名 + 应用名）+ 状态栏版本')
    const titleNow = String(await evalJs(c, `document.title`))
    const footVer = String(await evalJs(c, `document.querySelector('.footer-version')?.textContent ?? ''`))
    const footVerTitle = String(await evalJs(c, `document.querySelector('.footer-version')?.getAttribute('title') ?? ''`))
    check(
      'adj978 **标题 = 文件名**（当前打开的是「授权测试.jps」⇒ 标题逐字 `授权测试.jps`，**不带应用名**：应用名由壳去显示）',
      titleNow === '授权测试.jps' && !titleNow.includes('爱记谱 iJipu'),
      titleNow,
    )
    check(
      'adj971 标题里**不再带版本号**（版本已挪到状态栏与官网首页）——负对照式的判据：标题里不该出现 `vX.Y.Z`',
      !/v\d+\.\d+\.\d+/.test(titleNow),
      titleNow,
    )
    check(
      'adj971/adj975 **版本显示在状态栏**：可见文本是 `vX.Y.Z (日期 @commit)`（adj975：日期与指纹**直接显示**，不再只在悬停里），悬停 title 同样是完整串',
      /^v\d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2} @[0-9a-f]{7,8}\)$/.test(footVer.trim()) &&
        /^v\d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2} @[0-9a-f]{7,8}\)$/.test(footVerTitle),
      JSON.stringify({ 可见: footVer.trim(), 悬停: footVerTitle }),
    )
    {
      /**
       * 结构判据（adj975 用户口径）：它在 `footer-spacer` **之后**（真在右半边），且**在「官网首页」链接的左边**。
       * 只按源码顺序不够 —— 这里量**真实几何**：版本的右缘 ≤ 官网链接的左缘，两者同一行。
       */
      const onRight = await evalJs(
        c,
        `(() => {
           const v = document.querySelector('.footer-version')
           const bar = document.querySelector('.footer')
           const site = document.querySelector('.footer-site')
           if (!v || !bar) return null
           const vr = v.getBoundingClientRect()
           const br = bar.getBoundingClientRect()
           const spacer = document.querySelector('.footer-spacer')
           const sr = spacer ? spacer.getBoundingClientRect() : null
           const gr = site ? site.getBoundingClientRect() : null
           const meta = document.querySelector('.footer-version-meta')
           const mr = meta ? meta.getBoundingClientRect() : null
           return {
             版本左缘: Math.round(vr.left),
             版本右缘: Math.round(vr.right),
             官网左缘: gr ? Math.round(gr.left) : null,
             同一行: gr ? Math.abs((vr.top + vr.bottom) / 2 - (gr.top + gr.bottom) / 2) <= 2 : null,
             状态栏中线: Math.round(br.left + br.width / 2),
             在spacer右侧: sr ? vr.left >= sr.right - 1 : null,
             日期指纹宽: mr ? Math.round(mr.width) : 0,
           }
         })()`,
      )
      check(
        'adj971 版本徽标**真在状态栏右半边**（左缘越过状态栏中线，且在 `footer-spacer` 右侧）',
        onRight !== null && onRight.版本左缘 > onRight.状态栏中线 && onRight.在spacer右侧 === true,
        JSON.stringify(onRight),
      )
      check(
        'adj975 版本徽标**真在「官网首页」链接的左边**（版本的右缘 ≤ 官网链接的左缘，且两者同一行）——用户要求"放在官网链接的左边"',
        onRight !== null && onRight.官网左缘 !== null && onRight.版本右缘 <= onRight.官网左缘 && onRight.同一行 === true,
        JSON.stringify(onRight),
      )
      check(
        'adj975 日期与指纹那一段**真的可见**（宽 > 0，不是只写在 `title` 里）',
        onRight !== null && onRight.日期指纹宽 > 20,
        JSON.stringify({ 日期指纹宽: onRight?.日期指纹宽 }),
      )
      /** 负对照（真环境）：窄屏（≤720px）下那一段必须**收起来**，只留版本号 */
      await c.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false })
      await sleep(300)
      const narrowVer = await evalJs(
        c,
        `(() => {
           const v = document.querySelector('.footer-version')
           const meta = document.querySelector('.footer-version-meta')
           if (!v) return null
           return {
             /* ⚠ 用 innerText（＝真正看得见的文本）：textContent 会把 display:none 的那段也算进来，
                那样"窄屏已收起"就会被判成"还在"。 */
             可见文本: (v.innerText || '').trim(),
             版本宽: Math.round(v.getBoundingClientRect().width),
             日期指纹可见: meta ? getComputedStyle(meta).display !== 'none' : null,
           }
         })()`,
      )
      check(
        'adj975 **负对照（窄屏 ≤720px）**：只留版本号（看得见的文本里没有日期/指纹、宽度也缩回去了）——否则手机上状态栏会被挤爆',
        narrowVer !== null && narrowVer.日期指纹可见 === false && /^v\d+\.\d+\.\d+$/.test(narrowVer.可见文本) && narrowVer.版本宽 < 80,
        JSON.stringify(narrowVer),
      )
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
      await sleep(200)
    }
    // ---- 负对照：换一份文件（拖入）⇒ 标题必须跟着换 ----
    {
      const before = String(await evalJs(c, `document.title`))
      await evalJs(c, fireDrag('标题跟随.jps', 'V: 1.0\nB: 标题跟随\nD: C\nP: 4/4\nQ: 1 2 3 |\n', 'drop'))
      // 万一这份文档此刻有未保存修改，拖入会先弹确认条（那是 adj968 的口径）⇒ 按主按钮继续
      await sleep(400)
      if (await evalJs(c, `!!document.querySelector('.confirm-bar')`)) {
        await evalJs(c, `document.querySelector('.confirm-bar-btn.is-primary')?.click(), true`)
      }
      await waitFor(c, `document.querySelector('.editor-main textarea').value.includes('标题跟随')`, '拖入的新文件已打开')
      await sleep(300)
      const after = String(await evalJs(c, `document.title`))
      check(
        'adj971/adj978 **换文件 ⇒ 标题跟着换**（不是只在 mount 时写一次）：`标题跟随.jps`',
        after === '标题跟随.jps' && after !== before,
        JSON.stringify({ 前: before, 后: after }),
      )
    }

    // ============ adj972：「保存到工作区」对话框 —— 目录多时**列表内滚动**，整框不滚 ============
    //
    // 用户截图实报（插件里那个对话框）：「目录列表，目录较多时，使用列表内滚动，不要整个对话框滚动」。
    // 根因是**滚动归属**：`.modal` 自己 `max-height:80vh; overflow:auto`，而 `.save-as-list` 的
    // `flex:1` 在"父链没有高度约束"时不生效 ⇒ 列表被条目撑到自然高 ⇒ 溢出的部分由**整个对话框**去滚。
    //
    // 为什么用**同构 DOM 探针**（而不是真打开那个对话框）：那个对话框只在**嵌入版**（Obsidian 宿主）
    // 这条路上弹（`docStore.requestSaveAs` 的 `isHostEmbedded()` 分支），而本脚本跑的是网页版
    // （保存走系统对话框）⇒ 没法定点"点开它"。这里按**组件里那串类名**造一份同构 DOM（同一份 CSS 生效），
    // 量的正是"滚动归属于谁"这件布局事实；再用**不带 `fill`** 的那一版当负对照，
    // 证明判据分得清改前/改后（否则它就是恒绿）。
    console.log('[verify-app-ui] adj972：保存到工作区对话框的滚动归属（列表内滚，整框不滚）')
    {
      const probe = (fill) => `(() => {
        const old = document.getElementById('adj972-probe'); if (old) old.remove()
        const mask = document.createElement('div')
        mask.className = 'modal-mask'; mask.id = 'adj972-probe'
        const modal = document.createElement('div')
        modal.className = 'modal' + (${JSON.stringify(fill)} ? ' fill' : '')
        modal.innerHTML =
          '<div class="modal-head">保存到工作区</div>' +
          '<div class="modal-body"><div class="save-as">' +
            '<div class="save-as-field"><label class="save-as-label">文件名</label>' +
              '<input class="save-as-input" value="闲庭絮"></div>' +
            '<div class="save-as-where"><span class="save-as-label">保存到</span>' +
              '<span class="save-as-path">2.曲谱集/安和桥</span></div>' +
            '<div class="save-as-hint">只列当前这一层</div>' +
            /* 目录条目按用户截图里的量级给足 40 条 */
            '<div class="save-as-list" role="listbox">' +
              '<button class="save-as-item is-up">↑ 上一层</button>' +
              Array.from({ length: 40 }, (_, i) => '<button class="save-as-item">📁 目录 ' + (i + 1) + '</button>').join('') +
              '<div class="save-as-files"><button class="save-as-file">安和桥.jps</button></div>' +
            '</div>' +
            '<div class="save-as-actions"><button class="btn">取消</button>' +
              '<button class="btn primary">保存</button></div>' +
          '</div></div>'
        mask.appendChild(modal)
        document.body.appendChild(mask)
        const list = modal.querySelector('.save-as-list')
        const actions = modal.querySelector('.save-as-actions')
        return {
          整框溢出: modal.scrollHeight - modal.clientHeight,
          列表溢出: list.scrollHeight - list.clientHeight,
          列表高: Math.round(list.getBoundingClientRect().height),
          整框底: Math.round(modal.getBoundingClientRect().bottom),
          按钮底: Math.round(actions.getBoundingClientRect().bottom),
          视口高: innerHeight,
        }
      })()`
      const fixed = await evalJs(c, probe(true))
      check(
        'adj972 目录 40 条时**列表自己滚**（`scrollHeight > clientHeight`，且列表高被对话框高度封住）',
        fixed.列表溢出 > 20 && fixed.列表高 < 700,
        JSON.stringify(fixed),
      )
      check(
        'adj972 且**整个对话框不滚**（整框没有可滚余量）——这正是用户要的那一条',
        fixed.整框溢出 <= 1,
        JSON.stringify(fixed),
      )
      check(
        'adj972 底部「取消 / 保存」**仍在视口内**（没被目录列表推到屏幕外）',
        fixed.按钮底 <= fixed.视口高 + 1,
        JSON.stringify({ 按钮底: fixed.按钮底, 视口高: fixed.视口高 }),
      )
      const broke = await evalJs(c, probe(false))
      check(
        'adj972 **负对照**：不带 `fill`（＝改前的类名链）⇒「整框会滚、列表不滚」，判据能分辨两种实现',
        broke.整框溢出 > 20 && broke.列表溢出 <= 1,
        JSON.stringify(broke),
      )
      await evalJs(c, `document.getElementById('adj972-probe')?.remove(), true`)
    }

    // ============ adj974：输入条（`.script-pad`）的**默认**开关 —— PC 关、手机开 ============
    //
    // 用户口径（2026-10-18）：「PC 端默认输入条设为**关闭**，手机端默认设为**开**」。
    // 旧口径是 `isCoarsePointerDevice() || detectNarrow()` —— **窗口 ≤1024px 也算** ⇒ PC 把窗口拉窄
    // （或插件在 Obsidian 窄侧栏里）打开时会默认弹出输入条。判据改只看"真手机/触屏"。
    //
    // 为什么必须**真浏览器 + 真重载**：这是"**没存过值时**的默认"，只有让 store **重新初始化**
    // 才能量到它（源码级断言只证明"那行字写了什么"）。所以每一档都：清掉 `ijipu.showScriptPad`
    // ⇒ 模拟该端环境 ⇒ `Page.reload` ⇒ 看 `.script-pad` 在不在。
    //
    // 三档：① 手机（移动 UA + 触屏 + 390 宽）⇒ **在**；② PC 常规 1440 宽 ⇒ **不在**；
    //      ③ **窄窗口的 PC（700 宽、无触屏、桌面 UA）⇒ 也不在** —— 这一档正是用户要修的那个情形
    //      （旧口径下它是"在"，所以它同时是这条判据的负对照）。
    console.log('[verify-app-ui] adj974：输入条默认开关（PC 关 / 手机开，含"窄窗口 PC 也要关"）')
    {
      const DESKTOP_UA = await evalJs(c, 'navigator.userAgent')
      const MOBILE_UA =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      /** 换一套环境 + 清掉"用户存过的值" ⇒ 重载 ⇒ 量"默认给了什么" */
      const bootWith = async ({ width, height, mobile, touch, ua }) => {
        await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile })
        // ⚠ `maxTouchPoints` 只在**开**的时候传（CDP 要求 1–16，传 0 会 `-32602` 报错）
        await c.send('Emulation.setTouchEmulationEnabled', touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
        await c.send('Emulation.setUserAgentOverride', { userAgent: ua })
        await evalJs(c, `localStorage.removeItem('ijipu.showScriptPad'), true`)
        await c.send('Page.reload')
        await sleep(500)
        await waitFor(c, `!!document.querySelector('.editor-main textarea')`, `重载后应用首屏（${width}×${height}）`)
        return await evalJs(
          c,
          `({
             pad: !!document.querySelector('.script-pad'),
             stored: localStorage.getItem('ijipu.showScriptPad'),
             coarse: window.matchMedia('(pointer: coarse)').matches,
             ua: /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent),
             w: window.innerWidth,
           })`,
        )
      }
      const phone = await bootWith({ width: 390, height: 844, mobile: true, touch: true, ua: MOBILE_UA })
      check(
        'adj974 **手机端默认开**：移动 UA + 触屏环境重载后，输入条 `.script-pad` **在页面上**，且 `localStorage` 里**没有**存过的值（证明看到的是"默认"而不是残留）',
        phone.pad === true && phone.stored === null,
        JSON.stringify(phone),
      )
      const pc = await bootWith({ width: 1440, height: 900, mobile: false, touch: false, ua: DESKTOP_UA })
      check(
        'adj974 **PC 默认关**：桌面环境重载后输入条**不在页面上**（`localStorage` 同样没有存过的值）',
        pc.pad === false && pc.stored === null,
        JSON.stringify(pc),
      )
      const pcNarrow = await bootWith({ width: 700, height: 900, mobile: false, touch: false, ua: DESKTOP_UA })
      check(
        'adj974 **负对照（用户要修的那一档）**：**窄窗口的 PC**（700 宽、无触屏、桌面 UA）重载后输入条**也不在** —— 旧口径（"触屏或窄屏"）下这里是"在"，所以这条能分辨新旧实现',
        pcNarrow.pad === false && pcNarrow.w <= 1024 && pcNarrow.coarse === false,
        JSON.stringify(pcNarrow),
      )
      // 收尾：恢复桌面环境（后面的用例若还要用视口，不至于停在手机档）
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await c.send('Emulation.setUserAgentOverride', { userAgent: DESKTOP_UA })
      await evalJs(c, `localStorage.removeItem('ijipu.showScriptPad'), true`)
    }

    // ============ adj977：已安装的手机 PWA（Android WebAPK）标题**不许重复应用名** ============
    //
    // 用户截图（安卓）：那层窗口标题栏显示 `<manifest name> - <页面标题>`，于是变成
    // `爱记谱 iJipu - 望月.jps - 爱记谱 iJipu`。⇒ 这一档标题只放文件名（应用名由外壳显示）。
    //
    // ⚠ 怎么"装成"已安装 PWA：CDP 的 `Emulation.setEmulatedMedia({features:[display-mode]})`
    // **实测无效**（量到 `matchMedia('(display-mode: standalone)').matches === false`），
    // 所以用本脚本既有的套路 —— `Page.addScriptToEvaluateOnNewDocument` 在**页面脚本之前**改掉
    // `matchMedia`（伪 `showOpenFilePicker` 用的也是这一招），再用 `remove` 撤回做负对照。

    // ============ adj1290：告警抽屉（贯穿窗口底部 / 默认收起 / 状态栏那行开关）============
    //
    // 为什么必须有这一段：抽屉是**新的交互**——从底栏 9 个页签里搬出来、独立一级开关、ESC 收起；
    // 而且"贯穿整幅宽度"正是本次要解决的痛点（原来底栏在左右拆分时只占编辑列）。
    // 源码断言能钉住"结构长什么样"，钉不住"点得动、量得准"（`adj959` 的教训）。
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await evalJs(c, `localStorage.clear(), true`)
    await c.send('Page.navigate', { url: `${origin}/app/` })
    await waitFor(c, `!!document.querySelector('.footer-problems')`, '首屏：状态栏告警按钮')

    const drawerAbsent = await evalJs(c, `!!document.querySelector('.problems-drawer')`)
    check(
      'adj1290 默认**收起**：首屏没有 `.problems-drawer`（告警不再常驻占高度）',
      drawerAbsent === false,
      JSON.stringify(drawerAbsent),
    )

    await evalJs(c, `document.querySelector('.footer-problems').click(), true`)
    await waitFor(c, `!!document.querySelector('.problems-drawer')`, '点状态栏那行 → 抽屉出现')
    const drawerBox = await evalJs(
      c,
      `(() => {
        const d = document.querySelector('.problems-drawer')
        const r = d.getBoundingClientRect()
        const f = document.querySelector('.footer').getBoundingClientRect()
        return {
          left: Math.round(r.left),
          right: Math.round(r.right),
          vw: window.innerWidth,
          bottom: Math.round(r.bottom),
          footerTop: Math.round(f.top),
          empty: !!d.querySelector('.dock-empty'),
        }
      })()`,
    )
    check(
      'adj1290 抽屉**贯穿整幅宽度**（左缘贴 0、右缘贴窗口右边——不是编辑列宽）',
      drawerBox.left <= 1 && Math.abs(drawerBox.right - drawerBox.vw) <= 1,
      JSON.stringify(drawerBox),
    )
    check(
      'adj1290 抽屉紧贴状态栏上方（底边 = 状态栏顶边，不压状态栏）',
      Math.abs(drawerBox.bottom - drawerBox.footerTop) <= 1,
      JSON.stringify(drawerBox),
    )
    check('adj1290 0 条告警时抽屉能打开并显示空态（不崩、不空白）', drawerBox.empty === true, JSON.stringify(drawerBox))

    await evalJs(c, `document.querySelector('.footer-problems').click(), true`)
    await waitFor(c, `!document.querySelector('.problems-drawer')`, '再点状态栏那行 → 抽屉收起')
    const closedAgain = await evalJs(c, `!!document.querySelector('.problems-drawer')`)
    check('adj1290 再点同一入口 ⇒ 收起（开关语义，不是"只能开"）', closedAgain === false, JSON.stringify(closedAgain))

    // 有告警时：真打字制造一个语法错误（`Input.insertText` 走 React 的 onChange）
    await evalJs(c, `document.querySelector('.editor-main textarea')?.focus(), true`)
    await c.send('Input.insertText', { text: '{' })
    await waitFor(
      c,
      `!!document.querySelector('.footer-problems .dot.err, .footer-problems .dot.warn')`,
      '打字后状态栏出现告警色点',
      60,
    )
    await evalJs(c, `document.querySelector('.footer-problems').click(), true`)
    await waitFor(c, `!!document.querySelector('.problems-drawer .problems-list')`, '有告警时抽屉里有列表')
    const drawerH = await evalJs(c, `Math.round(document.querySelector('.problems-drawer').getBoundingClientRect().height)`)
    check(
      'adj1290 有告警时抽屉高度被封顶（≤160px = 面板头 + 5 行，超出由列表自己滚）',
      typeof drawerH === 'number' && drawerH > 0 && drawerH <= 161,
      JSON.stringify(drawerH),
    )

    // ESC 收起（走捕获阶段那条监听：比底栏的 ESC 先跑并 preventDefault）
    await evalJs(c, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
    await waitFor(c, `!document.querySelector('.problems-drawer')`, 'ESC → 抽屉收起')
    const closedByEsc = await evalJs(c, `!!document.querySelector('.problems-drawer')`)
    check('adj1290 ESC 收起抽屉（捕获阶段监听到、没被底栏的 ESC 抢走）', closedByEsc === false, JSON.stringify(closedByEsc))

    // ============ adj1294 / adj1295：操作栏三种壳（底栏 / 右侧栏 / 右侧浮动栏）============
    //
    // 为什么要真浏览器：这一整块是**新交互**——宽度两档、页签两种位置、点栏外关闭、
    // ESC 只关浮动栏。源码断言能钉住"结构长什么样"，钉不住"点得动、量得准、关得对"
    // （`adj959` 的教训）。
    //
    // 顺序：① 默认（PC 无存档 = 右侧浮动栏）→ ② 顶栏按钮开关 → ③ 宽度档 → ④ 插入模式
    //      → ⑤ 竖排页签 → ⑥ ESC 三态 → ⑦ 点栏外关闭 → ⑧ 负向：portal 菜单不许误关
    //      → ⑨ 切壳不丢面板 → ⑩ 手机档（默认底栏 + 没有「右侧栏」选项）。
    console.log('[verify-app-ui] adj1294/1295：右侧栏（三种壳 / 宽度两档 / 页签两种位置 / 负向判据）')
    {
      /** 量一个元素的盒（`null` = 不存在）；`pos` 是 computed position，用来分辨浮动/插入 */
      const boxOf = async (sel) =>
        await evalJs(
          c,
          `(() => {
             const el = document.querySelector('${sel}')
             if (!el) return null
             const r = el.getBoundingClientRect()
             const s = getComputedStyle(el)
             return { w: Math.round(r.width), l: Math.round(r.left), r: Math.round(r.right),
                      t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height), pos: s.position }
           })()`,
        )
      /** 真鼠标点（CDP 原生事件路径；合成 `.click()` 拿不到"按下"这一类指针事件） */
      const realClickAt = async (x, y) => {
        await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        await sleep(250)
      }
      /**
       * adj1301：右栏关闭后**仍留在 DOM 里**（关而不卸，为了播放不中断）⇒ 判断"开没开"
       * 不能再写 `!!querySelector('.right-dock')`，要看 `hidden`。
       */
      const dockVisible = async () =>
        await evalJs(c, `(() => { const d = document.querySelector('.right-dock'); return !!d && !d.hidden })()`)
      /** 点某元素的正中（先按它自己的 rect 算坐标） */
      const realClickOn = async (sel) => {
        const b = await boxOf(sel)
        if (!b) throw new Error(`点不到：${sel} 不存在`)
        await realClickAt((b.l + b.r) / 2, (b.t + b.b) / 2)
      }
      /** 走真实菜单打开「全局设置」（底栏/右栏都会切到 settings 面板） */
      const openGlobalSettings = async () => {
        await evalJs(c, `document.querySelector('.topbar-hamburger-btn').click(), true`)
        await waitFor(
          c,
          `[...document.querySelectorAll('.menu-entry')].some((el) => el.textContent.includes('全局设置'))`,
          '菜单里有「全局设置」',
        )
        await evalJs(
          c,
          `[...document.querySelectorAll('.menu-entry')].find((el) => el.textContent.includes('全局设置')).click(), true`,
        )
        await sleep(400)
      }

      // ---- 清存档 + 桌面视口重载：量"首次默认" ----
      await c.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await evalJs(c, `localStorage.clear(), true`)
      await c.send('Page.navigate', { url: `${origin}/app/` })
      await waitFor(c, `!!document.querySelector('.editor-main textarea')`, '三壳用例：应用首屏')
      await sleep(500)

      /**
       * adj1302（用户 2026-11-16 拍板）：**直接打开应用一律不展开**操作栏（所有端）；
       * `adj1297` 的"桌面首次收起"是这条的前身，`adj1289` 的"手机 Web + 线上谱"自动展开也已删除。
       * 带谱进来（`?jps=` / 拖放 / 双击）才展开到试听（阶段 F 有专门用例）。
       * 所以这里先钉"两块壳都不在、但顶栏开关在"（入口不能一起消失），再手工点开继续量。
       */
      const firstOpen = await evalJs(
        c,
        `({
           right: !!document.querySelector('.right-dock'),
           bottom: !!document.querySelector('.tool-dock:not(.right-dock)'),
           topbarBtn: !!document.querySelector('.topbar-right-dock'),
         })`,
      )
      check(
        'adj1297 PC 首次（无存档）**默认收起**底栏/右栏（空间留给预览/编辑），但顶栏那个常驻开关在',
        firstOpen.right === false && firstOpen.bottom === false && firstOpen.topbarBtn === true,
        JSON.stringify(firstOpen),
      )
      await realClickOn('.topbar-right-dock')
      await sleep(300)

      const rd0 = await boxOf('.right-dock')
      check(
        'adj1295 PC 首次（无存档）默认**右侧浮动栏**：右栏在、`position: absolute`、宽度 320',
        rd0 !== null && rd0.pos === 'absolute' && rd0.w === 320,
        JSON.stringify(rd0),
      )
      const main0 = await boxOf('.app-main')
      check(
        'adj1295 浮动模式**不挤占内容**（`.app-main` 仍是整幅宽度 1440）',
        main0 !== null && main0.w === 1440,
        JSON.stringify(main0),
      )
      /**
       * adj1298（用户第四轮）：浮动栏**周边留 10px**、四角圆角——看起来是"独立悬浮的一块"。
       * 这条断言的旧口径是"顶边贴 TopBar 下沿、底边贴状态栏上沿"（`adj1295`）。改成新口径
       * **不是放宽**：三条边都按像素钉死（顶 = 内容区顶 + 10、底 = 内容区底 − 10、右 = 视口右 − 10）。
       */
      check(
        'adj1298 浮动右栏**整幅高度但四周留 10px**（顶/右/底各 10px，不再贴边）',
        rd0 !== null && main0 !== null && rd0.t === main0.t + 10 && rd0.b === main0.b - 10 && rd0.r === 1440 - 10,
        JSON.stringify({ 右栏: rd0, 内容区: main0 }),
      )

      // ---- ② 顶栏那个**常驻**按钮能开合（且它自己不被"点栏外关闭"误伤）----
      await realClickOn('.topbar-right-dock')
      check(
        'adj1301 顶栏常驻按钮能**关**右栏（点它不会被"点栏外关闭"抢跑成"关了又开"；关=hidden，不卸载）',
        (await dockVisible()) === false &&
          (await evalJs(c, `!!document.querySelector('.right-dock[hidden]')`)) === true,
        '',
      )
      await realClickOn('.topbar-right-dock')
      check(
        'adj1295 再点一次能**开**',
        (await dockVisible()) === true,
        '',
      )

      // ---- ③ 宽度档：320 → 480（浮动档下内容宽不变）----
      await realClickOn('.right-dock-bar button[data-right-dock-width]')
      const rdWide = await boxOf('.right-dock')
      check('adj1295 宽度档切换生效（320 → 480），且浮动模式下内容宽**仍然不受影响**',
        rdWide !== null && rdWide.w === 480 && (await boxOf('.app-main')).w === 1440,
        JSON.stringify(rdWide),
      )

      // ---- ④ 模式：浮动 → 插入（内容真的被挤窄）----
      await realClickOn('.right-dock-bar button[data-right-dock-mode]')
      const rdIns = await boxOf('.right-dock')
      const mainIns = await boxOf('.app-main')
      check(
        'adj1295 插入模式**真的挤窄内容**（内容宽 = 视口 − 右栏宽；右栏不再是绝对定位）',
        rdIns !== null && rdIns.pos !== 'absolute' && mainIns.w === 1440 - rdIns.w,
        JSON.stringify({ 右栏: rdIns, 内容区: mainIns }),
      )

      // ---- ⑤ 页签位置：底部 → 右侧竖排 ----
      await realClickOn('.right-dock-bar button[data-right-dock-tabs]')
      const vert = await evalJs(
        c,
        `(() => {
           const t = document.querySelector('.right-dock-tabs.is-vert')
           if (!t) return null
           const lab = t.querySelector('.tool-dock-tab-label')
           const r = t.getBoundingClientRect()
           return {
             inMain: !!t.closest('.right-dock-main'),
             writing: lab ? getComputedStyle(lab).writingMode : '',
             tabs: t.querySelectorAll('.right-dock-tab').length,
             w: Math.round(r.width),
           }
         })()`,
      )
      check(
        'adj1295 页签组切到**右侧竖排**：竖条在 `.right-dock-main` 里、文字 `vertical-rl`、8 个页签都在',
        vert !== null && vert.inMain === true && vert.writing === 'vertical-rl' && vert.tabs === 8,
        JSON.stringify(vert),
      )

      // ---- ⑤b 阶段 B 的「手工核对」机器化：**三种壳 × 8 个面板**逐个点开 ----
      //
      // 方案 §十 要求"三种操作方式 × 8 个页签，逐个点开看有没有崩、有没有被裁"。
      // 这一步曾经只能靠人眼，现在扫一遍：每个页签点开 ⇒ 对应 `.pane-<key>` 必须**露出来**
      // （`hidden` 去掉）且**有真实尺寸**（宽高都 > 0——被裁成 0 就是这么被发现的）。
      const TAB_KEYS = ['workspace', 'import', 'find', 'tryout', 'export', 'settings', 'score', 'about']
      const sweep = async (scopeSel) => {
        const bad = []
        for (const k of TAB_KEYS) {
          const clicked = await evalJs(
            c,
            `(() => {
               const b = document.querySelector('${scopeSel} [data-key="${k}"]')
               if (!b) return 'no-tab'
               b.click()
               return true
             })()`,
          )
          await sleep(450) // 懒加载 chunk 首次要点一下才下载
          const st = await evalJs(
            c,
            `(() => {
               const p = document.querySelector('${scopeSel} .pane-${k}')
               if (!p) return { pane: false }
               const r = p.getBoundingClientRect()
               return { pane: true, shown: p.hidden !== true, w: Math.round(r.width), h: Math.round(r.height) }
             })()`,
          )
          if (clicked !== true || !st.pane || st.shown !== true || st.w <= 0 || st.h <= 0) bad.push({ k, clicked, st })
        }
        return bad
      }
      const rightSweep = await sweep('.right-dock')
      check(
        'adj1295 右栏能进**全部 8 个面板**（逐个点开：面板露出来、宽高都 > 0、没有崩）',
        rightSweep.length === 0,
        JSON.stringify(rightSweep),
      )
      check(
        'adj1295 扫完 8 个面板后应用仍活着（编辑区 + 右栏都在，没被某个面板的异常带走）',
        (await evalJs(c, `!!document.querySelector('.editor-main textarea') && !!document.querySelector('.right-dock')`)) ===
          true,
        '',
      )

      // ---- ⑥ 负向②：右栏没有"最小化"，ESC 只在浮动模式关它 ----
      check(
        'adj1295 **负向②**：右栏里没有「最小化 / 高度档位 / ✕」这些底栏控件',
        (await evalJs(
          c,
          `(() => {
             const d = document.querySelector('.right-dock')
             return !!d && !d.querySelector('.tool-dock-size-btn') && !d.querySelector('.tool-dock-collapse') && !d.querySelector('.tool-dock-close')
           })()`,
        )) === true,
        '',
      )
      await evalJs(c, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
      await sleep(250)
      check(
        'adj1301 **负向②**：**插入模式**下 ESC **不关**右栏（它是布局的一部分）',
        (await dockVisible()) === true,
        '',
      )
      await realClickOn('.right-dock-bar button[data-right-dock-mode]') // 插回浮动
      await sleep(200)
      await evalJs(c, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
      await sleep(250)
      check(
        'adj1301 **负向②**：**浮动模式**下 ESC 关右栏（关=hidden，面板树仍挂着）',
        (await dockVisible()) === false &&
          (await evalJs(c, `!!document.querySelector('.right-dock[hidden]')`)) === true,
        '',
      )

      // ---- ⑦ 点栏外关闭（浮动模式）----
      await realClickOn('.topbar-right-dock') // 重新打开（浮动档是记着的）
      await sleep(200)
      const beforeOutside = await dockVisible()
      /**
       * 点哪儿才算"栏外"：**内容区里、且不在右栏下面的那一点**。
       * 不能直接拿 `.editor-main textarea` 的中心——右栏是浮在上面的，中心点很可能正好落在
       * 右栏里（那按设计就不该关）。所以按 `.app-main` 的盒、扣掉右栏宽，取左半边的中心。
       */
      const clickPt = await evalJs(
        c,
        `(() => {
           const m = document.querySelector('.app-main').getBoundingClientRect()
           const dw = document.querySelector('.right-dock')?.getBoundingClientRect().width ?? 0
           const x = Math.round(m.left + Math.max(60, (m.width - dw) / 2))
           const y = Math.round(m.top + m.height / 2)
           const hit = document.elementFromPoint(x, y)
           return { x, y, hit: hit ? hit.tagName + '.' + String(hit.className) : null }
         })()`,
      )
      await realClickAt(clickPt.x, clickPt.y)
      check(
        'adj1295 浮动栏**点栏外关闭**（在内容区左半边点一下 ⇒ 右栏收起来）',
        beforeOutside === true && (await dockVisible()) === false,
        JSON.stringify({ 点之前: beforeOutside, 点击点: clickPt }),
      )

      // ---- ⑧ 负向①：点**portal 到 body 的菜单**（.ws-menu）不许误关 ----
      //
      // 真工作区菜单需要先授权一个文件夹（本轮不铺那个夹具）；这里补的是**同一个判据**：
      // 往 `body` 里放一个 `.ws-menu`（真实 portal 菜单就是这个位置，`adj540` 有断言钉着），
      // 用真鼠标点它 ⇒ 右栏必须还在。判据本身（`composedPath` + `.ws-menu` 豁免 + 只认
      // `.app-body` 之内）与真菜单走的是同一条代码路径。
      await realClickOn('.topbar-right-dock')
      await sleep(200)
      const menuPlaced = await evalJs(
        c,
        `(() => {
           const d = document.createElement('div')
           d.className = 'ws-menu'
           d.id = 'adj1295-ws-menu'
           d.textContent = '操作菜单（模拟 portal）'
           Object.assign(d.style, { position: 'fixed', left: '160px', top: '320px', width: '180px',
                                    height: '40px', zIndex: '90', background: '#333', color: '#fff' })
           document.body.appendChild(d)
           return {
             portal: d.closest('.app-body') === null,
             insideDock: !!d.closest('.right-dock'),
           }
         })()`,
      )
      await realClickAt(250, 340)
      check(
        'adj1295 **负向①**：点工作区那种 **portal 到 body 的菜单**（`.ws-menu`）**不关**浮动栏',
        menuPlaced.portal === true &&
          menuPlaced.insideDock === false &&
          (await dockVisible()) === true,
        JSON.stringify(menuPlaced),
      )
      await evalJs(c, `document.getElementById('adj1295-ws-menu')?.remove(), true`)

      // ---- ⑨ 切壳不丢当前面板：右栏里选「导出」→ 走菜单进设置 → 换回底栏 → 底栏停在同一块面板 ----
      await evalJs(
        c,
        `[...document.querySelectorAll('.right-dock .right-dock-tab')].find((b) => b.dataset.key === 'export').click(), true`,
      )
      await waitFor(c, `!!document.querySelector('.right-dock .pane-export:not([hidden])')`, '右栏里打开「导出」面板', 60)
      await openGlobalSettings()
      /** 切壳**前**右栏高亮的页签（openGlobalSettings 会把面板切到「设置」） */
      const beforeSwitch = await evalJs(
        c,
        `document.querySelector('.right-dock .right-dock-tab.is-active')?.dataset.key ?? ''`,
      )
      const changed = await evalJs(
        c,
        `(() => {
           const row = [...document.querySelectorAll('.pcfg-row')].find((r) => r.textContent.includes('操作方式'))
           if (!row) return 'no-row'
           const s = row.querySelector('select')
           if (!s) return 'no-select'
           // 走原生 setter 再派发 change：React 的 value 追踪器才会认为值真的变了
           Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'bottom')
           s.dispatchEvent(new Event('change', { bubbles: true }))
           return [...s.options].map((o) => o.value).join(',')
         })()`,
      )
      await sleep(500)
      const afterSwitch = await evalJs(
        c,
        `({
           right: !!document.querySelector('.right-dock'),
           bottom: !!document.querySelector('.tool-dock:not(.right-dock)'),
           activeTab: document.querySelector('.tool-dock-tab.is-active')?.dataset.key ?? '',
         })`,
      )
      check(
        'adj1295 设置里换回**底栏**：右栏消失、底栏出现，且当前面板**没变**（切壳不丢面板）',
        changed === 'bottom,insert,float' &&
          beforeSwitch === 'settings' &&
          afterSwitch.right === false &&
          afterSwitch.bottom === true &&
          afterSwitch.activeTab === beforeSwitch,
        JSON.stringify({ 选项: changed, 切前页签: beforeSwitch, 切后: afterSwitch }),
      )
      const bottomSweep = await sweep('.tool-dock')
      check(
        'adj1295 底栏也照样能进**全部 8 个面板**（切壳后没有"少一个 / 坏一个"——负向③回归的一部分）',
        bottomSweep.length === 0,
        JSON.stringify(bottomSweep),
      )
      /**
       * adj1297 **负向判据（底栏不许跟着变）**：阶段 C 只把**右栏**里的三处"左右排列"改成
       * 上下排列，底栏（矮而宽）必须仍是原来的左右两栏——`adj471/adj545/adj549` 那一套
       * 是按底栏校准的，动了就是"顺手改坏了没要求改的地方"。
       */
      await evalJs(c, `document.querySelector('.tool-dock:not(.right-dock) [data-key="workspace"]').click(), true`)
      await waitFor(
        c,
        `!!document.querySelector('.tool-dock:not(.right-dock) .pane-workspace:not([hidden]) .ws-body')`,
        '底栏里打开工作区',
      )
      const bottomLayout = await evalJs(
        c,
        `(() => {
           const b = document.querySelector('.tool-dock:not(.right-dock) .ws-body')
           const a = document.querySelector('.tool-dock:not(.right-dock) .ws-side')
           if (!b || !a) return null
           return { dir: getComputedStyle(b).flexDirection, sideW: Math.round(a.getBoundingClientRect().width) }
         })()`,
      )
      check(
        'adj1297 **负向**：底栏里工作区仍是**左右两栏**（`.ws-body` 横排 + 操作列固定 112px）——阶段 C 只改右栏',
        bottomLayout !== null && bottomLayout.dir === 'row' && bottomLayout.sideW === 112,
        JSON.stringify(bottomLayout),
      )

      // ---- ⑫ 宽屏左右拆分：底栏那条 `adj552` 不变、抽屉仍**贯穿整幅**、右栏仍**整幅高度** ----
      //
      // 这是本轮两个痛点的**交集**：① 宽屏左右拆分时底栏只占编辑列（adj552 的现状，要保住）；
      // ② 告警抽屉与右栏必须是整幅高度/整幅宽度（不受那条影响）。三者共存这一档
      // 之前没人钉过——`splitH` 下点一遍才算数。
      await evalJs(c, `document.querySelector('.topbar-view-btn').click(), true`)
      await waitFor(c, `!!document.querySelector('.topbar-view-dropdown')`, '视图下拉打开')
      await evalJs(
        c,
        `[...document.querySelectorAll('.topbar-view-dropdown .menu-entry')].find((e) => e.textContent.includes('左右拆分')).click(), true`,
      )
      await sleep(500)
      const splitH = await evalJs(
        c,
        `(() => {
           const main = document.querySelector('.app-main')
           const dock = document.querySelector('.tool-dock:not(.right-dock)')
           return {
             isH: !!main && main.classList.contains('app-main-h'),
             bottomInEditorCol: !!dock && !!dock.closest('.editor-col'),
             rightDock: !!document.querySelector('.right-dock'),
           }
         })()`,
      )
      check(
        'adj1295 左右拆分下底栏那条 `adj552` **不变**：底栏仍在编辑列里（负向③的回归面）',
        splitH.isH === true && splitH.bottomInEditorCol === true,
        JSON.stringify(splitH),
      )
      await evalJs(c, `document.querySelector('.footer-problems').click(), true`)
      await waitFor(c, `!!document.querySelector('.problems-drawer')`, '左右拆分下打开告警抽屉')
      const splitHBox = await evalJs(
        c,
        `(() => {
           const d = document.querySelector('.problems-drawer').getBoundingClientRect()
           return { left: Math.round(d.left), right: Math.round(d.right), vw: window.innerWidth }
         })()`,
      )
      check(
        'adj1295 左右拆分下告警抽屉仍**贯穿整幅宽度**（不是编辑列宽）——阶段 A 的痛点在这一档成立',
        splitHBox.left <= 1 && Math.abs(splitHBox.right - splitHBox.vw) <= 1,
        JSON.stringify(splitHBox),
      )
      await evalJs(c, `document.querySelector('.footer-problems').click(), true`) // 收起抽屉
      await sleep(200)

      // ---- ⑬ 左右拆分 + **右侧浮动栏**：右栏整幅高度、内容不被挤窄；插入档则挤窄 ----
      await openGlobalSettings() // 底栏里打开设置（它在编辑列里，照样能用）
      const toFloat = await evalJs(
        c,
        `(() => {
           const row = [...document.querySelectorAll('.pcfg-row')].find((r) => r.textContent.includes('操作方式'))
           const s = row?.querySelector('select')
           if (!s) return 'no-select'
           Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'float')
           s.dispatchEvent(new Event('change', { bubbles: true }))
           return [...s.options].map((o) => o.value).join(',')
         })()`,
      )
      await sleep(500)
      const rdSplit = await evalJs(
        c,
        `(() => {
           const d = document.querySelector('.right-dock')
           const m = document.querySelector('.app-main')
           const f = document.querySelector('.footer')
           if (!d || !m || !f) return null
           const dr = d.getBoundingClientRect()
           const mr = m.getBoundingClientRect()
           return {
             w: Math.round(dr.width), top: Math.round(dr.top), bottom: Math.round(dr.bottom),
             footerTop: Math.round(f.getBoundingClientRect().top), mainW: Math.round(mr.width), vw: window.innerWidth,
             bottomDockGone: !document.querySelector('.tool-dock:not(.right-dock)'),
             pos: getComputedStyle(d).position,
           }
         })()`,
      )
      check(
        'adj1298 左右拆分 + 右侧浮动栏：右栏仍是整幅高度（上/下各留 10px）、浮动不挤窄内容、底栏已让位',
        toFloat === 'bottom,insert,float' &&
          rdSplit !== null &&
          rdSplit.pos === 'absolute' &&
          rdSplit.bottom === rdSplit.footerTop - 10 &&
          rdSplit.mainW === rdSplit.vw &&
          rdSplit.bottomDockGone === true,
        JSON.stringify({ 选项: toFloat, 右栏: rdSplit }),
      )

      // ---- ⑭ 阶段 C：**面板窄栏适配**（adj1297）----
      //
      // 用户 2026-11-16 拍板：右栏（高而窄）里原本"左右排列"的三处改成**上下排列**——
      //   ① 工作区的列表 ⇄ 操作区；② 试听的信息区 ⇄ 操作区；③ 全局/谱面的子页签 ⇄ 内容。
      // 阶段 B 收尾时肉眼看到的两处真问题也在这里钉住：
      //   · 设置面板 @320 标签与控件压在一起、字体下拉右端被裁；
      //   · 工作区面板 @195（手机 1/2 屏宽）空态文字被压成一字一行、与按钮列重叠。
      // 判据分三层：**不裁内容**（容器 scrollWidth 不许超过 clientWidth）、**上下排列**（算出来的
      // `flex-direction` / `grid-template-columns`）、**功能一个不少**（按钮/子页签个数）。
      await c.send('Page.reload')
      await sleep(900)
      await waitFor(c, `!!document.querySelector('.editor-main textarea')`, '阶段 C：重载后首屏')
      // adj1297：重载后底栏/右栏是**收起**的（新默认）；宽度档与页签位置是 L1 存档，上次停在别的档，
      // 所以这里显式点回「窄档 + 页签在底部」再开量。
      await realClickOn('.topbar-right-dock')
      await sleep(300)
      const dockBarState = () =>
        evalJs(
          c,
          `(() => {
             const d = document.querySelector('.right-dock')
             return d ? { w: d.dataset.dockWidth, t: d.dataset.dockTabs } : null
           })()`,
        )
      const setDockBar = async (width, tabs) => {
        for (let i = 0; i < 5; i++) {
          const st = await dockBarState()
          if (!st) return null
          if (st.w === width && st.t === tabs) return st
          if (st.w !== width) {
            await realClickOn('.right-dock-bar button[data-right-dock-width]')
            await sleep(220)
          }
          if (st.t !== tabs) {
            await realClickOn('.right-dock-bar button[data-right-dock-tabs]')
            await sleep(220)
          }
        }
        return await dockBarState()
      }
      /** 量一块面板：不裁清单 + 三处排列 + 控件个数 */
      const scanPaneC = async (k) =>
        evalJs(
          c,
          `(() => {
             const pane = document.querySelector('.right-dock .pane-${k}')
             if (!pane) return { pane: false }
             // "被裁"的判据：**自己会裁/会滚**的容器里，内容比可视宽还宽 ⇒ 一定有东西露不出来。
             // 只看 overflowX !== visible 的元素（overflow visible 的溢出会撑出滚动条，不是裁）。
             const clipped = []
             for (const el of pane.querySelectorAll('*')) {
               const cs = getComputedStyle(el)
               if (cs.overflowX === 'visible') continue
               if (el.clientWidth <= 0) continue
               if (el.scrollWidth > el.clientWidth + 2) {
                 clipped.push({
                   cls: typeof el.className === 'string' ? el.className.slice(0, 60) : el.tagName,
                   sw: el.scrollWidth,
                   cw: el.clientWidth,
                 })
               }
             }
             const q = (s) => pane.querySelector(s)
             const csOf = (s) => { const e = q(s); return e ? getComputedStyle(e) : null }
             const box = (s) => { const e = q(s); return e ? e.getBoundingClientRect() : null }
             const tabsBox = box('.jp-tabs')
             const panelBox = box('.pcfg-panel')
             return {
               pane: true,
               w: Math.round(pane.getBoundingClientRect().width),
               clipped: clipped.slice(0, 6),
               wsBodyDir: csOf('.ws-body') ? csOf('.ws-body').flexDirection : null,
               wsSideW: box('.ws-side') ? Math.round(box('.ws-side').width) : null,
               wsSideTop: box('.ws-side') ? Math.round(box('.ws-side').top) : null,
               wsLeftBottom: box('.ws-left') ? Math.round(box('.ws-left').bottom) : null,
               wsBtns: pane.querySelectorAll('.ws-side-btn').length,
               splitDir: csOf('.playback-panel .dock-split') ? csOf('.playback-panel .dock-split').flexDirection : null,
               actionsW: box('.playback-actions') ? Math.round(box('.playback-actions').width) : null,
               playBtns: pane.querySelectorAll('.playback-actions > button').length,
               pcfgCols: csOf('.pcfg-root') ? csOf('.pcfg-root').gridTemplateColumns : null,
               tabsAboveContent: tabsBox && panelBox ? Math.round(tabsBox.bottom) <= Math.round(panelBox.top) + 1 : null,
               jpTabs: pane.querySelectorAll('.jp-tab').length,
             }
           })()`,
        )

      /** 两档宽度下逐个面板扫一遍 */
      const stageC = { 320: {}, 480: {} }
      for (const [slot, width] of [
        ['320', 'narrow'],
        ['480', 'wide'],
      ]) {
        await setDockBar(width, 'bottom')
        stageC[slot].__w = await evalJs(
          c,
          `Math.round(document.querySelector('.right-dock').getBoundingClientRect().width)`,
        )
        for (const k of TAB_KEYS) {
          await evalJs(c, `document.querySelector('.right-dock [data-key="${k}"]').click(), true`)
          await sleep(420)
          stageC[slot][k] = await scanPaneC(k)
        }
      }
      const clippedOf = (slot) =>
        TAB_KEYS.filter((k) => !stageC[slot][k]?.pane || (stageC[slot][k].clipped ?? [1]).length > 0).map((k) => ({
          k,
          ...stageC[slot][k],
        }))
      check(
        'adj1297 右栏窄档（PC 320）**8 个面板都不裁内容**：没有"内容比可视宽、被 overflow 剪掉"的容器',
        stageC[320].__w === 320 && clippedOf('320').length === 0,
        JSON.stringify({ 宽: stageC[320].__w, 问题: clippedOf('320') }),
      )
      check(
        'adj1297 右栏宽档（PC 480）**8 个面板也都不裁**（换档不许把内容挤出可视区）',
        stageC[480].__w === 480 && clippedOf('480').length === 0,
        JSON.stringify({ 宽: stageC[480].__w, 问题: clippedOf('480') }),
      )
      {
        // ① 工作区：列表与操作区上下排（`.ws-body` 竖排 + 操作区占整宽、**落在列表下方**）
        const ws = stageC[320].workspace
        check(
          'adj1297 右栏 @320 **工作区：列表在上、操作区在下**（`.ws-body` 竖排、操作列占整宽且在列表下方）+ 操作按钮还在',
          !!ws &&
            ws.wsBodyDir === 'column' &&
            ws.wsSideW !== null &&
            ws.wsSideW >= 320 * 0.8 &&
            ws.wsSideTop !== null &&
            ws.wsLeftBottom !== null &&
            ws.wsSideTop >= ws.wsLeftBottom - 1 &&
            ws.wsBtns >= 1,
          JSON.stringify(ws),
        )
        // ② 试听：信息区与操作区上下排，播放/停止按钮一个不少
        const pb = stageC[320].tryout
        check(
          'adj1297 右栏 @320 **试听：信息区在上、操作按钮在下**（`.dock-split` 竖排、按钮行占整宽）+ 播放/停止还在',
          !!pb &&
            pb.splitDir === 'column' &&
            pb.actionsW !== null &&
            pb.actionsW >= 320 * 0.8 &&
            pb.playBtns >= 2,
          JSON.stringify(pb),
        )
        // ③ 全局 / 谱面：子页签在上、内容在下（单列网格），子页签一个不少
        //    网页版两半各 4 个（settings = 版面/主题/音色库/本机；score = 布局/字体/水印/背景；
        //    「命令行」在非桌面端整条隐藏，见 `adj955`）
        const st = stageC[320].settings
        const sc = stageC[320].score
        check(
          'adj1297 右栏 @320 **全局/谱面的子页签与内容上下排**（`.pcfg-root` 变单列、页签行在内容之上）+ 两半各 4 个子页签都在',
          !!st &&
            !!sc &&
            typeof st.pcfgCols === 'string' &&
            !st.pcfgCols.includes(' ') &&
            st.tabsAboveContent === true &&
            st.jpTabs === 4 &&
            typeof sc.pcfgCols === 'string' &&
            !sc.pcfgCols.includes(' ') &&
            sc.tabsAboveContent === true &&
            sc.jpTabs === 4,
          JSON.stringify({ 全局: st, 谱面: sc }),
        )
        // 宽档 @480 同样要上下排（不是只在小屏成立）
        const ws4 = stageC[480].workspace
        const pb4 = stageC[480].tryout
        const st4 = stageC[480].settings
        check(
          'adj1297 右栏 @480（宽档）三处**同样是上下排列**（工作区竖排 / 试听竖排 / 设置单列）',
          !!ws4 &&
            !!pb4 &&
            !!st4 &&
            ws4.wsBodyDir === 'column' &&
            pb4.splitDir === 'column' &&
            typeof st4.pcfgCols === 'string' &&
            !st4.pcfgCols.includes(' ') &&
            st4.tabsAboveContent === true,
          JSON.stringify({ 工作区: ws4, 试听: pb4, 全局: st4 }),
        )
      }

      // ---- ⑮ 阶段 D：右栏收尾（adj1298）----
      //
      // 用户 2026-11-16 第四轮点了 6 条，加上方案 §六·阶段 C 末尾「看出来了但没修」的 3 条：
      //   ① 顶部三个按钮换图标（原来"窄/宽""底/右""插/浮"单字，看不出含义）
      //   ② 顶部按钮**右对齐**　③ 195px 档设置标签列收窄　④「导出乐谱包」zip 说明不再折半截
      //   ⑤ 页签在右侧时**条宽 = 页签在底部时的高**（28px）　⑥ 浮动栏**周边留白 + 圆角**
      //   ⑦ 工作区**操作区钉在栏底、列表高度自适应**　⑧ 试听**播放/停止挪到整块内容下方**
      //   ⑨ 全局/谱面**子页签满宽**　⑩ 浅色主题下真量一遍右栏（阶段 D 那条"没能验的"）
      // 每条都量"算出来的样式/几何"，不靠源码正则。
      await setDockBar('narrow', 'bottom')
      const barOf = () =>
        evalJs(
          c,
          `(() => {
             const bar = document.querySelector('.right-dock-bar')
             if (!bar) return null
             const btns = [...bar.querySelectorAll('button')]
             const br = bar.getBoundingClientRect()
             const pick = (b) => {
               const ic = b.querySelector('.tool-icon')
               return { icon: !!ic, text: (b.textContent || '').trim(), mask: ic ? getComputedStyle(ic).maskImage : '' }
             }
             return {
               n: btns.length,
               items: btns.map(pick),
               rightGap: Math.round(br.right - btns[btns.length - 1].getBoundingClientRect().right),
               leftGap: Math.round(btns[0].getBoundingClientRect().left - br.left),
             }
           })()`,
        )
      const bar0 = await barOf()
      check(
        'adj1298 右上三个按钮**全是图标、没有文字**（宽/底/浮 的单字下线）',
        !!bar0 &&
          bar0.n === 3 &&
          bar0.items.every((it) => it.icon === true && it.text === '') &&
          new Set(bar0.items.map((it) => it.mask)).size === 3,
        JSON.stringify(bar0),
      )
      check(
        'adj1298 右上三个按钮**右对齐**（右缘贴栏内边距 ≤8px、左端至少空 40px）',
        !!bar0 && bar0.rightGap <= 8 && bar0.leftGap >= 40,
        JSON.stringify(bar0 ? { 右间隙: bar0.rightGap, 左间隙: bar0.leftGap } : null),
      )
      // 图标随状态换（三枚都是二态、显示当前态——这是原来单字按钮承载的信息，换图标后不许丢）
      const maskNow = async () => String((await barOf())?.items[0].mask ?? '')
      const maskWidth0 = await maskNow()
      await realClickOn('.right-dock-bar button[data-right-dock-width]')
      await sleep(300)
      const maskWidth1 = await maskNow()
      await realClickOn('.right-dock-bar button[data-right-dock-width]')
      await sleep(300)
      check(
        'adj1298 宽度档图标随状态换（窄栏 ⇄ 宽栏），换回来与原来一致',
        maskWidth0.length > 0 && maskWidth1.length > 0 && maskWidth0 !== maskWidth1 && (await maskNow()) === maskWidth0,
        JSON.stringify({ 窄: maskWidth0, 宽: maskWidth1 }),
      )
      {
        // ⑤ 页签在右侧时的**条宽**要等于页签在底部时的**高**（28px）
        const bottomTabH = await evalJs(
          c,
          `Math.round(document.querySelector('.right-dock .right-dock-tabstrip .right-dock-tab').getBoundingClientRect().height)`,
        )
        await realClickOn('.right-dock-bar button[data-right-dock-tabs]')
        await sleep(350)
        const vertStrip = await evalJs(
          c,
          `(() => {
             const s = document.querySelector('.right-dock-tabs.is-vert')
             if (!s) return null
             const r = s.getBoundingClientRect()
             const tab = s.querySelector('.right-dock-tab')
             const icon = tab && tab.querySelector('.tool-icon')
             return {
               stripW: Math.round(r.width),
               tabs: s.querySelectorAll('.right-dock-tab').length,
               iconOverflow: icon ? Math.round(icon.getBoundingClientRect().right - tab.getBoundingClientRect().right) : null,
               tabW: Math.round(tab.getBoundingClientRect().width),
             }
           })()`,
        )
        check(
          'adj1298 页签放右侧时**条宽 = 放底部时的高**（28px），8 个页签在、图标没被竖条裁到',
          bottomTabH === 28 &&
            vertStrip !== null &&
            vertStrip.stripW === bottomTabH &&
            vertStrip.tabs === 8 &&
            vertStrip.iconOverflow !== null &&
            vertStrip.iconOverflow <= 1,
          JSON.stringify({ 底部页签高: bottomTabH, 竖排: vertStrip }),
        )
        await realClickOn('.right-dock-bar button[data-right-dock-tabs]')
        await sleep(300)
      }

      {
        // ⑨ 全局/谱面的子页签**满宽**：四枚等分页签行，不再缩在左边留空白
        await evalJs(c, `document.querySelector('.right-dock [data-key="settings"]').click(), true`)
        await waitFor(c, `!!document.querySelector('.right-dock .pane-settings:not([hidden]) .jp-tabs')`, '阶段 D：全局设置')
        const subTabs = await evalJs(
          c,
          `(() => {
             const row = document.querySelector('.right-dock .pane-settings .jp-tabs')
             const tabs = [...row.querySelectorAll('.jp-tab')]
             const rr = row.getBoundingClientRect()
             const ws = tabs.map((t) => Math.round(t.getBoundingClientRect().width))
             return {
               rowW: Math.round(rr.width),
               n: tabs.length,
               widths: ws,
               spread: Math.max(...ws) - Math.min(...ws),
               filled: Math.round(ws.reduce((a, b) => a + b, 0) + 4 * (tabs.length - 1)),
             }
           })()`,
        )
        check(
          'adj1298 全局/谱面的子页签**满宽**（四枚等分、合计铺满页签行，不再缩在左侧留空白）',
          subTabs.n === 4 && subTabs.spread <= 2 && Math.abs(subTabs.filled - subTabs.rowW) <= 4,
          JSON.stringify(subTabs),
        )
        // ② 标签列从"当页最长标签"（可到 108px）定到 108px：320 档下控件拿到 ≥150px
        //    （adj1299 从 76px 放宽到 96px、adj1300 再定到 108px——见下面阶段 E 那一段的实测表）
        const setRow = await evalJs(
          c,
          `(() => {
             const pane = document.querySelector('.right-dock .pane-settings')
             const row = pane && pane.querySelector('.pcfg-fields .pcfg-row')
             if (!row) return null
             const label = row.querySelector('.pcfg-row-label')
             const ctl = row.querySelector('.pcfg-row-ctl')
             return {
               cols: getComputedStyle(row).gridTemplateColumns,
               labelW: Math.round(label.getBoundingClientRect().width),
               ctlW: Math.round(ctl.getBoundingClientRect().width),
             }
           })()`,
        )
        check(
          'adj1300 右栏 @320 设置行的**标签列 108px**（8 字标签自然宽 106 + 2 余量），控件仍有 ≥150px',
          !!setRow && setRow.labelW >= 106 && setRow.labelW <= 110 && setRow.ctlW >= 150,
          JSON.stringify(setRow),
        )
      }

      {
        // ⑦ 工作区：操作区**钉在栏底**、列表吃剩余高度（窗口变矮 200 ⇒ 列表跟着矮 200）
        await evalJs(c, `document.querySelector('.right-dock [data-key="workspace"]').click(), true`)
        await waitFor(c, `!!document.querySelector('.right-dock .pane-workspace:not([hidden]) .ws-side')`, '阶段 D：工作区')
        const wsPin = () =>
          evalJs(
            c,
            `(() => {
               const pane = document.querySelector('.right-dock .pane-workspace')
               const side = pane.querySelector('.ws-side')
               const left = pane.querySelector('.ws-left')
               const list = pane.querySelector('.ws-list')
               if (!side || !left || !list) return null
               const pr = pane.getBoundingClientRect(), sr = side.getBoundingClientRect()
               const lr = left.getBoundingClientRect(), li = list.getBoundingClientRect()
               return {
                 bottomGap: Math.round(pr.bottom - sr.bottom),
                 sideTop: Math.round(sr.top),
                 leftBottom: Math.round(lr.bottom),
                 listH: Math.round(li.height),
                 listOverflow: getComputedStyle(list).overflowY,
                 paneH: Math.round(pr.height),
               }
             })()`,
          )
        const wsTall = await wsPin()
        await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 700, deviceScaleFactor: 1, mobile: false })
        await sleep(450)
        const wsShort = await wsPin()
        check(
          'adj1298 工作区：操作区**钉在右栏底部**（离栏底只有 pane 的 10px 内边距）、列表在它上方且**高度自适应**（窗口矮 200 ⇒ 列表矮 ~200）',
          !!wsTall &&
            !!wsShort &&
            wsTall.bottomGap >= 8 &&
            wsTall.bottomGap <= 12 &&
            wsShort.bottomGap >= 8 &&
            wsShort.bottomGap <= 12 &&
            wsShort.sideTop >= wsShort.leftBottom - 1 &&
            wsTall.listH - wsShort.listH >= 150 &&
            wsTall.listOverflow === 'auto',
          JSON.stringify({ 高900: wsTall, 高700: wsShort }),
        )
        await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
        await sleep(350)
      }

      {
        // ⑧ 试听：播放/停止在**整块内容的最下面**（原来夹在信息区与其后的标记段/提示之间）
        await evalJs(c, `document.querySelector('.right-dock [data-key="tryout"]').click(), true`)
        await sleep(600)
        const pbOrder = await evalJs(
          c,
          `(() => {
             const pane = document.querySelector('.right-dock .pane-tryout')
             const panel = pane && pane.querySelector('.playback-panel')
             const acts = panel && panel.querySelector('.playback-actions')
             if (!pane || !panel || !acts) return null
             const ar = acts.getBoundingClientRect()
             const split = panel.querySelector('.dock-split')
             const others = [...panel.querySelectorAll('.dock-split-main, .practice-bar, .playback-hints')].map((e) => ({
               cls: String(e.className).slice(0, 40),
               bottom: Math.round(e.getBoundingClientRect().bottom),
             }))
             return {
               splitDisplay: split ? getComputedStyle(split).display : null,
               actsTop: Math.round(ar.top),
               actsBottom: Math.round(ar.bottom),
               btns: acts.querySelectorAll('button').length,
               others,
               bottomGap: Math.round(pane.getBoundingClientRect().bottom - ar.bottom),
             }
           })()`,
        )
        check(
          'adj1298 试听：**播放/停止在整块内容的最下面**（信息区/标记段/提示都在它上方、按钮离栏底只有内边距）',
          !!pbOrder &&
            pbOrder.splitDisplay === 'contents' &&
            pbOrder.btns >= 2 &&
            pbOrder.others.every((o) => o.bottom <= pbOrder.actsTop + 1) &&
            pbOrder.bottomGap >= 8 &&
            pbOrder.bottomGap <= 22,
          JSON.stringify(pbOrder),
        )
      }

      {
        // ④「导出乐谱包」：按钮一整行、zip 说明一整行（不再挤在按钮右边折半截）
        await evalJs(c, `document.querySelector('.right-dock [data-key="export"]').click(), true`)
        await sleep(450)
        const pkg = await evalJs(
          c,
          `(() => {
             const pane = document.querySelector('.right-dock .pane-export')
             const row = pane && pane.querySelector('.export-package')
             if (!row) return null
             const btn = row.querySelector('button')
             const note = row.querySelector('.export-package-note')
             if (!btn || !note) return null
             const br = btn.getBoundingClientRect(), nr = note.getBoundingClientRect(), rr = row.getBoundingClientRect()
             return {
               dir: getComputedStyle(row).flexDirection,
               noteBelow: Math.round(nr.top) >= Math.round(br.bottom) - 1,
               noteW: Math.round(nr.width),
               rowW: Math.round(rr.width),
               noteOverflow: Math.round(nr.scrollWidth - nr.clientWidth),
             }
           })()`,
        )
        check(
          'adj1298 「导出乐谱包」在右栏里=**按钮一行 + zip 说明一行**（说明占整宽、没有被横向裁掉）',
          !!pkg &&
            pkg.dir === 'column' &&
            pkg.noteBelow === true &&
            pkg.noteW >= pkg.rowW * 0.8 &&
            pkg.noteOverflow <= 2,
          JSON.stringify(pkg),
        )
      }

      {
        // ⑬ 谱面页签底部「恢复默认 / 保存设置」：**图标 + 文字都在**，图标垂直居中
        await evalJs(c, `document.querySelector('.right-dock [data-key="score"]').click(), true`)
        await sleep(700)
        const foot = await evalJs(
          c,
          `(() => {
             const pane = document.querySelector('.right-dock .pane-score')
             const btns = [...(pane ? pane.querySelectorAll('.pcfg-foot > button') : [])]
             if (!btns.length) return null
             return btns.map((b) => {
               const r = b.getBoundingClientRect()
               const ic = b.querySelector('.tool-icon')
               const ir = ic ? ic.getBoundingClientRect() : null
               return {
                 text: (b.textContent || '').trim(),
                 icon: !!ic,
                 iconCy: ir ? Math.round((ir.top + ir.bottom) / 2) : null,
                 btnCy: Math.round((r.top + r.bottom) / 2),
                 h: Math.round(r.height),
               }
             })
           })()`,
        )
        check(
          'adj1298 谱面页签底部「恢复默认 / 保存设置」**各带一个图标、文字还在**，图标垂直居中（不贴基线）',
          Array.isArray(foot) &&
            foot.length === 2 &&
            foot.every((b) => b.icon === true && b.text.length > 0 && Math.abs(b.iconCy - b.btnCy) <= 2),
          JSON.stringify(foot),
        )
      }

      {
        // ⑫ 导入页签：四个按钮 = 图标 + 悬浮提示，且**排在一行**（adj1298 用户第六轮）
        await evalJs(c, `document.querySelector('.right-dock [data-key="import"]').click(), true`)
        await sleep(600)
        const impActs = await evalJs(
          c,
          `(() => {
             const pane = document.querySelector('.right-dock .pane-import')
             const row = pane && pane.querySelector('.import-acts')
             if (!row) return null
             const btns = [...row.querySelectorAll('button')]
             const rects = btns.map((b) => {
               const r = b.getBoundingClientRect()
               return { w: Math.round(r.width), h: Math.round(r.height), t: Math.round(r.top), l: Math.round(r.left) }
             })
             return {
               n: btns.length,
               icons: btns.filter((b) => b.querySelector('.tool-icon')).length,
               texts: btns.map((b) => (b.textContent || '').trim()),
               titles: btns.map((b) => (b.getAttribute('title') || '').length > 0),
               labels: btns.map((b) => (b.getAttribute('aria-label') || '').length > 0),
               wrap: getComputedStyle(row).flexWrap,
               rects,
             }
           })()`,
        )
        check(
          'adj1298 导入页签：四个按钮**只有图标、没有文字**（都有 title/aria-label），且**排在一行**（同一顶边、宽=高）',
          !!impActs &&
            impActs.n === 4 &&
            impActs.icons === 4 &&
            impActs.texts.every((t) => t === '') &&
            impActs.titles.every(Boolean) &&
            impActs.labels.every(Boolean) &&
            impActs.wrap === 'nowrap' &&
            new Set(impActs.rects.map((r) => r.t)).size === 1 &&
            impActs.rects.every((r) => r.w === r.h && r.w > 0),
          JSON.stringify(impActs),
        )
      }

      {
        // ⑥ 浮动栏：周边 10px 留白 + 四边圆角 + 圆角真的裁到子元素
        //    先读当前模式再点（这一段之前游走过换壳/换模式，别假设现在一定是插入档）
        if ((await evalJs(c, `String(document.querySelector('.right-dock').dataset.dockFloat)`)) !== '1') {
          await realClickOn('.right-dock-bar button[data-right-dock-mode]')
          await sleep(400)
        }
        const floatBox = await evalJs(
          c,
          `(() => {
             const d = document.querySelector('.right-dock')
             const m = document.querySelector('.app-main')
             if (!d || !m) return null
             const cs = getComputedStyle(d), r = d.getBoundingClientRect(), mr = m.getBoundingClientRect()
             return {
               pos: cs.position,
               radius: cs.borderTopLeftRadius,
               overflow: cs.overflowX,
               top: Math.round(r.top - mr.top),
               right: Math.round(innerWidth - r.right),
               bottom: Math.round(mr.bottom - r.bottom),
               borderW: cs.borderTopWidth,
             }
           })()`,
        )
        check(
          'adj1298 浮动栏**四周留 10px、四角圆角 10px、圆角裁到子元素**（看起来是一块独立悬浮的面板）',
          !!floatBox &&
            floatBox.pos === 'absolute' &&
            floatBox.radius === '10px' &&
            floatBox.overflow === 'hidden' &&
            floatBox.top === 10 &&
            floatBox.right === 10 &&
            floatBox.bottom === 10 &&
            floatBox.borderW === '1px',
          JSON.stringify(floatBox),
        )
      }

      {
        // ⑩ 浅色主题下的右栏（阶段 D 那条"我没能验的"之一）：切浅色重载，真量右栏底色与文字色
        await evalJs(c, `localStorage.setItem('ijipu.themeMode', 'light'), true`)
        await c.send('Page.reload')
        await sleep(900)
        await waitFor(c, `!!document.querySelector('.editor-main textarea')`, '阶段 D：浅色主题首屏')
        await realClickOn('.topbar-right-dock')
        await sleep(450)
        const lightDock = await evalJs(
          c,
          `(() => {
             const d = document.querySelector('.right-dock')
             if (!d) return null
             const bar = d.querySelector('.right-dock-bar')
             const btn = bar && bar.querySelector('.right-dock-btn')
             const cs = getComputedStyle(d)
             const bcs = btn ? getComputedStyle(btn) : null
             const rgb = (s) => {
               const m = /rgba?\\(([^)]+)\\)/.exec(s || '')
               return m ? m[1].split(',').slice(0, 3).map((v) => Number(v.trim())) : null
             }
             const lum = (c3) => (c3 ? (0.2126 * c3[0] + 0.7152 * c3[1] + 0.0722 * c3[2]) / 255 : null)
             return {
               mode: document.documentElement.getAttribute('data-mode'),
               bg: cs.backgroundColor,
               bgLum: lum(rgb(cs.backgroundColor)),
               fgLum: bcs ? lum(rgb(bcs.color)) : null,
               iconMask: btn && btn.querySelector('.tool-icon') ? getComputedStyle(btn.querySelector('.tool-icon')).maskImage.length : 0,
             }
           })()`,
        )
        check(
          'adj1298 **浅色主题**下右栏跟着走：`data-mode=light`、底色是浅色（亮度 >0.75）、按钮文字是深色（<0.5）、图标仍在',
          !!lightDock &&
            lightDock.mode === 'light' &&
            lightDock.bgLum !== null &&
            lightDock.bgLum > 0.75 &&
            lightDock.fgLum !== null &&
            lightDock.fgLum < 0.5 &&
            lightDock.iconMask > 0,
          JSON.stringify(lightDock),
        )
      }

      {
        // **负向**：底栏里播放/停止仍在信息区**右侧**（阶段 D 的 `display: contents` 只作用在 `.right-dock` 之下）
        await openGlobalSettings()
        const toBottom = await evalJs(
          c,
          `(() => {
             const row = [...document.querySelectorAll('.pcfg-row')].find((r) => r.textContent.includes('操作方式'))
             const s = row && row.querySelector('select')
             if (!s) return 'no-select'
             Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'bottom')
             s.dispatchEvent(new Event('change', { bubbles: true }))
             return true
           })()`,
        )
        await sleep(500)
        await evalJs(
          c,
          `(() => {
             const dock = document.querySelector('.tool-dock:not(.right-dock)')
             const tab = dock && dock.querySelector('[data-key="tryout"]')
             if (tab) tab.click()
             return true
           })()`,
        )
        await sleep(600)
        const pbBottom = await evalJs(
          c,
          `(() => {
             const dock = document.querySelector('.tool-dock:not(.right-dock)')
             const panel = dock && dock.querySelector('.playback-panel')
             if (!panel) return null
             const split = panel.querySelector('.dock-split')
             const acts = panel.querySelector('.playback-actions')
             const main = panel.querySelector('.dock-split-main')
             if (!split || !acts || !main) return null
             return {
               display: getComputedStyle(split).display,
               actsLeft: Math.round(acts.getBoundingClientRect().left),
               mainRight: Math.round(main.getBoundingClientRect().right),
               actsTop: Math.round(acts.getBoundingClientRect().top),
               mainTop: Math.round(main.getBoundingClientRect().top),
             }
           })()`,
        )
        check(
          'adj1298 **负向**：底栏里播放/停止仍在信息区**右侧**（`display: contents` 不越到 `.tool-dock` 这一层）',
          toBottom === true &&
            !!pbBottom &&
            pbBottom.display !== 'contents' &&
            Math.abs(pbBottom.actsTop - pbBottom.mainTop) <= 12 &&
            pbBottom.actsLeft >= pbBottom.mainRight - 1,
          JSON.stringify({ 切底栏: toBottom, 底栏试听: pbBottom }),
        )
      }

      // ---- ⑩ 手机档：默认**右侧浮动栏 + 宽档** + 设置里没有「右侧栏」 ----
      const DESKTOP_UA2 = await evalJs(c, 'navigator.userAgent')
      const MOBILE_UA2 =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      await c.send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA2 })
      await evalJs(c, `localStorage.clear(), true`)
      await c.send('Page.reload')
      await sleep(700)
      await waitFor(c, `!!document.querySelector('.editor-main textarea')`, '手机档首屏')
      const mobileShell = await evalJs(
        c,
        `({ right: !!document.querySelector('.right-dock'), bottom: !!document.querySelector('.tool-dock:not(.right-dock)'),
            w: window.innerWidth, coarse: window.matchMedia('(pointer: coarse)').matches })`,
      )
      check(
        'adj1302 手机直接打开**不展开**操作栏（用户拍板：所有端一致；底栏/右栏都不在）',
        mobileShell.right === false && mobileShell.bottom === false && mobileShell.coarse === true,
        JSON.stringify(mobileShell),
      )
      await openGlobalSettings()
      const mobileOpts = await evalJs(
        c,
        `(() => {
           const row = [...document.querySelectorAll('.pcfg-row')].find((r) => r.textContent.includes('操作方式'))
           if (!row) return null
           const s = row.querySelector('select')
           return s ? [...s.options].map((o) => o.value) : null
         })()`,
      )
      check(
        'adj1294 **负向④**：手机设置里**没有「右侧栏」**（只剩底栏 / 右侧浮动栏两项）',
        mobileOpts !== null && mobileOpts.join(',') === 'bottom,float',
        JSON.stringify(mobileOpts),
      )
      /**
       * adj1301（用户 2026-11-16 拍板）：手机默认 **右侧浮动栏 + 宽档**——
       * 390 宽的屏 ⇒ 宽档 = 2/3 = **260px**（浮动，absolute）。
       * 上面的「全局设置」入口已经把 dock 展开（浮动着、落在全局面板），这里直接量默认档；
       * 再点一次宽度档切到窄档 **195**（1/2 屏宽），后半段"最窄一档"的用例继续用 195。
       */
      const mDefault = await evalJs(
        c,
        `(() => {
           const d = document.querySelector('.right-dock:not([hidden])')
           if (!d) return null
           return { w: Math.round(d.getBoundingClientRect().width), float: d.dataset.dockFloat, width: d.dataset.dockWidth, pos: getComputedStyle(d).position }
         })()`,
      )
      check(
        'adj1301 手机（390 宽）默认**右侧浮动栏 + 宽档**：260px（2/3 屏宽）、position absolute',
        !!mDefault && mDefault.float === '1' && mDefault.width === 'wide' && mDefault.w === 260 && mDefault.pos === 'absolute',
        JSON.stringify(mDefault),
      )
      await realClickOn('.right-dock-bar button[data-right-dock-width]')
      await sleep(350)
      const mNarrow = await evalJs(
        c,
        `Math.round(document.querySelector('.right-dock:not([hidden])')?.getBoundingClientRect().width ?? 0)`,
      )
      check(
        'adj1301 手机切窄档 ⇒ 195px（1/2 屏宽，与 `dockWidthPx` 纯函数一致）',
        mNarrow === 195,
        JSON.stringify({ 窄档: mNarrow }),
      )
      // 最窄一档（195px）下工作区也得是上下排（阶段 B 收尾肉眼看到的那处"一字一行"就出在这一档）
      await evalJs(c, `document.querySelector('.right-dock [data-key="workspace"]').click(), true`)
      await waitFor(c, `!!document.querySelector('.right-dock .pane-workspace:not([hidden]) .ws-body')`, '手机上右栏打开工作区')
      const mWs = await evalJs(
        c,
        `(() => {
           const b = document.querySelector('.right-dock .ws-body')
           const pane = document.querySelector('.right-dock .pane-workspace')
           if (!b || !pane) return null
           const clipped = [...pane.querySelectorAll('*')].filter((el) => {
             const cs = getComputedStyle(el)
             return cs.overflowX !== 'visible' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2
           }).length
           return {
             dir: getComputedStyle(b).flexDirection,
             sideW: Math.round(document.querySelector('.right-dock .ws-side').getBoundingClientRect().width),
             paneW: Math.round(pane.getBoundingClientRect().width),
             clipped,
           }
         })()`,
      )
      check(
        'adj1297 手机右栏最窄档（195px）**工作区仍是上下排、且不裁**（操作列占整宽、没有溢出被剪的元素）',
        mWs !== null && mWs.dir === 'column' && mWs.sideW >= mWs.paneW * 0.6 && mWs.clipped === 0,
        JSON.stringify(mWs),
      )
      /**
       * adj1298：195px 档设置面板（阶段 C 遗留的"标签列固定 96px、控件只剩 ~70px"）。
       * 极窄档（容器 ≤240px）改成**标签一行、控件一行**，控件拿整宽；顺带扫一遍不裁。
       * ⚠ 先把宽度档点回**窄档**（上一段刚量过 260 宽档）——容器查询看的是 dock 宽，
       *   停在 260 就不会命中 ≤240 那档（第一版漏了这句，判据自己把 260 当 195 量）。
       */
      await realClickOn('.right-dock-bar button[data-right-dock-width]')
      await sleep(350)
      if ((await evalJs(c, `String(document.querySelector('.right-dock').dataset.dockWidth)`)) !== 'narrow') {
        await realClickOn('.right-dock-bar button[data-right-dock-width]')
        await sleep(350)
      }
      await evalJs(c, `document.querySelector('.right-dock [data-key="settings"]').click(), true`)
      await sleep(700)
      const mSet = await evalJs(
        c,
        `(() => {
           const pane = document.querySelector('.right-dock .pane-settings')
           if (!pane) return null
           const row = pane.querySelector('.pcfg-fields .pcfg-row')
           const label = row && row.querySelector('.pcfg-row-label')
           const ctl = row && row.querySelector('.pcfg-row-ctl')
           if (!label || !ctl) return null
           const lr = label.getBoundingClientRect(), cr = ctl.getBoundingClientRect()
           const clipped = [...pane.querySelectorAll('*')].filter((el) => {
             const cs = getComputedStyle(el)
             return cs.overflowX !== 'visible' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2
           }).length
           return {
             cols: getComputedStyle(row).gridTemplateColumns,
             labelBottom: Math.round(lr.bottom),
             ctlTop: Math.round(cr.top),
             ctlW: Math.round(cr.width),
             paneW: Math.round(pane.getBoundingClientRect().width),
             dockW: Math.round(document.querySelector('.right-dock').getBoundingClientRect().width),
             clipped,
           }
         })()`,
      )
      check(
        'adj1298 手机最窄档（195px）设置面板：**标签一行、控件一行**（控件拿整宽，不再左右挤）+ 不裁内容',
        mSet !== null &&
          mSet.dockW === 195 &&
          !mSet.cols.includes(' ') &&
          mSet.ctlTop >= mSet.labelBottom - 1 &&
          mSet.ctlW >= mSet.paneW * 0.55 &&
          mSet.clipped === 0,
        JSON.stringify(mSet),
      )
      // 收尾：恢复桌面视口与 UA（这段是本脚本最后一段，但保持"跑完不留脏环境"的习惯）
      await c.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await c.send('Emulation.setUserAgentOverride', { userAgent: DESKTOP_UA2 })
      await evalJs(c, `localStorage.clear(), true`)
    }

      // ---- ⑯ 阶段 E（adj1299）：标签列 96 / 260 档单列 / 工作区列表态夹具 ----
      //
      // 用户 2026-11-16 拍板四条：
      //   ① 标签列 76 → 96px（用户原话 88，实测 88 仍折两行——见 index.css 那一节的实测表）
      //   ② 单列门槛 240 → 280px（260 档原来控件反而比 195 档窄）
      //   ③ 工作区「有列表」时的过滤行：**headless 里 showDirectoryPicker 拿不到真句柄**，
      //      面板永远停在"选择工作区" ⇒ 以前只有源码级断言。这里注入一个**假 FSA 目录句柄**
      //      （`Page.addScriptToEvaluateOnNewDocument`，页面加载前就位），真点「新工作区」
      //      进列表态，再量过滤行的顺序 / 一行 / 正方形 / 不裁。
      //   ④ 过滤行 ✕ 换成「取消」图标（`*` 仍是字符——图标集里没有"匹配任意串"的图形）
      const FAKE_FS = `
        (() => {
          const mkFile = (name, mtime, text) => ({
            kind: 'file',
            name,
            getFile: async () => ({ name, lastModified: mtime, size: text.length, text: async () => text }),
            createWritable: async () => ({ write: async () => {}, truncate: async () => {}, close: async () => {} }),
          })
          const mkDir = (name, children) => ({
            kind: 'directory',
            name,
            values: async function* () { for (const c of children) yield c },
            entries: async function* () { for (const c of children) yield [c.name, c] },
            getDirectoryHandle: async (n, o) => {
              const hit = children.find((c) => c.name === n && c.kind === 'directory')
              if (hit) return hit
              if (o && o.create) { const d = mkDir(n, []); children.push(d); return d }
              throw new DOMException('NotFound', 'NotFoundError')
            },
            getFileHandle: async (n, o) => {
              const hit = children.find((c) => c.name === n && c.kind === 'file')
              if (hit) return hit
              if (o && o.create) { const f = mkFile(n, Date.now(), ''); children.push(f); return f }
              throw new DOMException('NotFound', 'NotFoundError')
            },
            removeEntry: async () => {},
            queryPermission: async () => 'granted',
            requestPermission: async () => 'granted',
            isSameEntry: async () => false,
          })
          const root = mkDir('测试工作区', [
            mkDir('子目录', [mkFile('子谱.jps', 1700000003000, '1 2 3')]),
            mkFile('小星星.jps', 1700000001000, '1 1 5 5'),
            mkFile('茉莉花.jps', 1700000002000, '3 2 1'),
            mkFile('说明.txt', 1700000004000, 'nope'),
          ])
          window.showDirectoryPicker = async () => root
        })()
      `
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_FS })
      const goDock = async (w, float, stamp) => {
        await evalJs(
          c,
          "localStorage.setItem('ijipu.dockSide','right'), localStorage.setItem('ijipu.dockFloat','" +
            float +
            "'), localStorage.setItem('ijipu.dockWidth','" +
            w +
            "'), localStorage.setItem('ijipu.dockTabsPos','bottom'), true",
        )
        await c.send('Page.navigate', { url: `${origin}/app/?m=${stamp}` })
        await waitFor(c, `location.search.includes('m=${stamp}')`, '阶段 E 新文档', 80)
        await waitFor(c, `!!document.querySelector('.topbar-right-dock')`, '阶段 E 顶栏', 80)
        await sleep(300)
        // 手机档首次可能已自动展开（shouldOpenWorkspaceDock）⇒ 只在没开时点（adj1301：关着时元素仍在，看 hidden）
        if ((await evalJs(c, `(() => { const d = document.querySelector('.right-dock'); return !d || d.hidden })()`)) === true) {
          await evalJs(c, `document.querySelector('.topbar-right-dock').click(), true`)
          await waitFor(c, `!!document.querySelector('.right-dock:not([hidden])')`, '阶段 E 右栏', 80)
        }
        await sleep(300)
      }
      const openScoreLayout = async () => {
        await evalJs(c, `document.querySelector('.right-dock [data-key="score"]').click(), true`)
        await waitFor(
          c,
          `!!document.querySelector('.right-dock .pane-score:not([hidden]) .jp-tabs')`,
          '阶段 E 谱面面板',
        )
        await evalJs(
          c,
          `(() => { const t = document.querySelectorAll('.right-dock .pane-score:not([hidden]) .jp-tab'); if (t[0]) t[0].click(); return true })()`,
        )
        await sleep(500)
      }
      const labelLines = () =>
        evalJs(
          c,
          `(() => {
             const pane = document.querySelector('.right-dock .pane-score:not([hidden])')
             if (!pane) return null
             const hit = [...pane.querySelectorAll('.pcfg-row-label')].find((l) => (l.textContent || '').includes('曲部与词部间距'))
             if (!hit) return null
             const lh = parseFloat(getComputedStyle(hit).lineHeight) || 15
             const r = hit.getBoundingClientRect()
             return { lines: Math.round(r.height / lh), h: Math.round(r.height), w: Math.round(r.width), text: (hit.textContent || '').trim() }
           })()`,
        )
      await goDock('narrow', '0', 'stageE1')
      await openScoreLayout()
      const fit108 = await labelLines()
      check(
        'adj1300 右栏 @320 谱面「曲部与词部间距」**一行放得下**（标签列 108 ≥ 自然宽 94：文字 84 + 红 `*` 占位 10）',
        !!fit108 && fit108.lines === 1 && fit108.w >= 106 && fit108.w <= 110,
        JSON.stringify(fit108),
      )
      // adj1300：改短两个 8 字标签 + 列宽 96 → 108 ⇒ 320 档标签**全部一行**
      // （adj1304 新增「描述头 → 作者两端对齐」行后 17 → 18 个字段）
      const allLabels = await evalJs(
        c,
        `(() => {
           const pane = document.querySelector('.right-dock .pane-score:not([hidden])')
           if (!pane) return null
           const items = [...pane.querySelectorAll('.pcfg-row-label')].map((l) => {
             const lh = parseFloat(getComputedStyle(l).lineHeight) || 15
             const r = l.getBoundingClientRect()
             return { text: (l.textContent || '').trim(), lines: Math.round(r.height / lh) }
           })
           return {
             n: items.length,
             wrapped: items.filter((x) => x.lines >= 2).map((x) => x.text),
             renamed: items
               .filter((x) => x.text.includes('两端对齐') || x.text.includes('替谱'))
               .map((x) => x.text + '/' + x.lines + '行'),
           }
         })()`,
      )
      check(
        'adj1300 右栏 @320 谱面**18 个字段的标签全部一行**（两个 8 字标签改短 + 列宽 108；最长自然宽 106）',
        !!allLabels && allLabels.n === 18 && allLabels.wrapped.length === 0 && allLabels.renamed.length === 3,
        JSON.stringify(allLabels),
      )
      // **负对照**：同一套 DOM 把标签列临时压回 76px ⇒ 这个标签必须变两行（证明上面那条不是白绿）
      await evalJs(
        c,
        `(() => {
           const el = document.createElement('style')
           el.id = 'tmp-label-76'
           el.textContent = '.right-dock .pcfg-fields .pcfg-row{grid-template-columns:minmax(0,76px) minmax(0,1fr) !important}'
           document.head.appendChild(el)
           return true
         })()`,
      )
      await sleep(400)
      const fit76 = await labelLines()
      await evalJs(c, `(() => { const el = document.getElementById('tmp-label-76'); if (el) el.remove(); return true })()`)
      await sleep(300)
      check(
        'adj1300 **负对照**：标签列压回 76px 时同一个标签变两行（108px 这条判据真的在量东西）',
        !!fit76 && fit76.lines >= 2,
        JSON.stringify(fit76),
      )
      // 工作区列表态（假句柄）：过滤行 = `*` → 搜索框 → ✕（图标），三件套同一行、两枚按钮正方形
      await evalJs(c, `document.querySelector('.right-dock [data-key="workspace"]').click(), true`)
      await waitFor(
        c,
        `!!document.querySelector('.right-dock .pane-workspace:not([hidden]) .ws-choose-side')`,
        '阶段 E 工作区（选择态）',
      )
      await evalJs(
        c,
        `(() => { const b = document.querySelector('.right-dock .pane-workspace:not([hidden]) .ws-choose-side button.btn'); if (b) b.click(); return !!b })()`,
      )
      await waitFor(
        c,
        `!!document.querySelector('.right-dock .pane-workspace:not([hidden]) .ws-filter-row')`,
        '阶段 E 工作区列表态（假 FSA 句柄）',
        120,
      )
      await sleep(800)
      const wsRow = await evalJs(
        c,
        `(() => {
           const pane = document.querySelector('.right-dock .pane-workspace:not([hidden])')
           const row = pane && pane.querySelector('.ws-filter-row')
           if (!row) return null
           const kids = [...row.children]
           const all = row.querySelector('.ws-filter-all')
           const input = row.querySelector('.ws-filter')
           const clear = row.querySelector('.ws-filter-clear')
           const icon = clear && clear.querySelector('.tool-icon')
           const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), t: Math.round(r.top) } }
           return {
             n: kids.length,
             cls: kids.map((k) => String(k.className)),
             all: all ? rect(all) : null,
             input: input ? rect(input) : null,
             clear: clear ? rect(clear) : null,
             clearIcon: !!icon,
             clearMask: icon ? getComputedStyle(icon).maskImage : '',
             clearText: clear ? (clear.textContent || '').trim() : '',
             listRows: pane.querySelectorAll('.ws-list .ws-row').length,
             clipped: [...pane.querySelectorAll('*')].filter((el) => {
               const cs = getComputedStyle(el)
               return cs.overflowX !== 'visible' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2
             }).length,
           }
         })()`,
      )
      check(
        'adj1299 工作区**列表态**（假 FSA 句柄）过滤行：`*` → 搜索框 → ✕ 三件套同一行（顶边一致）',
        !!wsRow &&
          wsRow.n === 3 &&
          wsRow.cls[0].includes('ws-filter-all') &&
          wsRow.cls[1].includes('ws-filter') &&
          wsRow.cls[2].includes('ws-filter-clear') &&
          Math.abs(wsRow.all.t - wsRow.input.t) <= 1 &&
          Math.abs(wsRow.clear.t - wsRow.input.t) <= 1,
        JSON.stringify(wsRow && { cls: wsRow.cls, all: wsRow.all, input: wsRow.input, clear: wsRow.clear }),
      )
      check(
        'adj1299 工作区列表态：两枚按钮**正方形**（28×28）、搜索框吃掉剩余宽、面板**不裁内容**、列表真有假工作区的条目',
        !!wsRow &&
          wsRow.all.w === wsRow.all.h &&
          wsRow.clear.w === wsRow.clear.h &&
          wsRow.all.w === 28 &&
          wsRow.clear.w === 28 &&
          wsRow.input.w >= 80 &&
          wsRow.clipped === 0 &&
          wsRow.listRows >= 3,
        JSON.stringify(wsRow && { all: wsRow.all, clear: wsRow.clear, input: wsRow.input, listRows: wsRow.listRows, clipped: wsRow.clipped }),
      )
      check(
        'adj1299 过滤行的 ✕ 换成了「取消」图标（不再是字符；`title` / `aria-label` 仍在）',
        !!wsRow && wsRow.clearIcon === true && wsRow.clearText === '' && wsRow.clearMask.length > 0,
        JSON.stringify(wsRow && { clearIcon: wsRow.clearIcon, clearText: wsRow.clearText }),
      )
      // 260 档（手机宽档）：单列门槛 280 ⇒ 标签一行、控件一行、控件拿整宽（不再 76 + 146）
      const DESKTOP_UA5 = await evalJs(c, 'navigator.userAgent')
      const MOBILE_UA5 =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      await c.send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA5 })
      await evalJs(c, `localStorage.clear(), true`)
      await goDock('wide', '1', 'stageE2')
      await evalJs(c, `document.querySelector('.right-dock [data-key="settings"]').click(), true`)
      await waitFor(
        c,
        `!!document.querySelector('.right-dock .pane-settings:not([hidden]) .jp-tabs')`,
        '阶段 E 260 档全局设置',
      )
      await sleep(500)
      const m260 = await evalJs(
        c,
        `(() => {
           const pane = document.querySelector('.right-dock .pane-settings:not([hidden])')
           const row = pane && pane.querySelector('.pcfg-fields .pcfg-row')
           const label = row && row.querySelector('.pcfg-row-label')
           const ctl = row && row.querySelector('.pcfg-row-ctl')
           if (!label || !ctl) return null
           const lr = label.getBoundingClientRect()
           const cr = ctl.getBoundingClientRect()
           return {
             dockW: Math.round(document.querySelector('.right-dock').getBoundingClientRect().width),
             cols: getComputedStyle(row).gridTemplateColumns,
             labelBottom: Math.round(lr.bottom),
             ctlTop: Math.round(cr.top),
             ctlW: Math.round(cr.width),
           }
         })()`,
      )
      check(
        'adj1299 手机 260 档（宽档）设置行改成**单列**：标签一行、控件一行且控件 ≥200px（原来 76+146 两列）',
        !!m260 && m260.dockW === 260 && !m260.cols.includes(' ') && m260.ctlTop >= m260.labelBottom - 1 && m260.ctlW >= 200,
        JSON.stringify(m260),
      )
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await c.send('Emulation.setUserAgentOverride', { userAgent: DESKTOP_UA5 })
      await evalJs(c, `localStorage.clear(), true`)

      // ---- ⑰ 阶段 F（adj1301）：关栏不停播 + 顶栏试听按钮下方的小工具条 ----
      {
        // headless 里不真下 30MB 音源：只把 `.sf2` 的 fetch 拦成快速失败（其余请求照常），
        // 播放会走"无声降级"（色块/时钟照常走），正好用来验"关栏不停播"。
        await c.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `(() => {
            // headless 没有音频输出：AudioContext.resume() 会永远悬着，backend.ready() 因此卡住
            // ⇒ 这里只把 resume 改成立即成功（状态仍是"无声"），让播放走"无声降级"的视觉路径。
            try { if (window.AudioContext) window.AudioContext.prototype.resume = () => Promise.resolve() } catch (e) {}
            const orig = window.fetch
            window.fetch = function (input, init) {
              const url = typeof input === 'string' ? input : (input && input.url) || ''
              if (/\\.sf2(\\?|$)/i.test(url)) return Promise.reject(new Error('stage F: 跳过音源下载'))
              return orig.call(this, input, init)
            }
          })()`,
        })
        await evalJs(c, `localStorage.clear(), true`)
        // adj1302：**带谱进来**才展开——链接带谱（`?jps=`）⇒ 自动展开右栏并落在试听
        await c.send('Page.navigate', { url: `${origin}/app/?jps=${encodeURIComponent('1 2 3 | 4 5 6')}` })
        await waitFor(
          c,
          `!!document.querySelector('.right-dock:not([hidden]) .pane-tryout:not([hidden])')`,
          '阶段 F 链接带谱自动展开试听',
          100,
        )
        check('adj1302 链接带谱（`?jps=`）打开应用 ⇒ **自动展开右栏并落在试听**（直接打开则不展开）', true)
        // 回到"直接打开"：默认不展开（两块壳都不在）
        await evalJs(c, `localStorage.clear(), true`)
        await c.send('Page.navigate', { url: `${origin}/app/?m=stageF` })
        await waitFor(c, `location.search.includes('m=stageF')`, '阶段 F 新文档', 80)
        await waitFor(c, `!!document.querySelector('.topbar-right-dock')`, '阶段 F 顶栏', 80)
        await sleep(400)
        const directOpen = await evalJs(
          c,
          `({ right: !!document.querySelector('.right-dock:not([hidden])'), bottom: !!document.querySelector('.tool-dock:not(.right-dock)') })`,
        )
        check(
          'adj1302 **直接打开**应用（无 `?jps=` / 拖放 / 双击）⇒ 操作栏不展开（底栏与右栏都不在）',
          directOpen.right === false && directOpen.bottom === false,
          JSON.stringify(directOpen),
        )
        // 默认壳 = 右浮动栏 + 窄档（320）
        await evalJs(c, `document.querySelector('.topbar-right-dock').click(), true`)
        await waitFor(c, `!!document.querySelector('.right-dock:not([hidden])')`, '阶段 F 右栏')
        const shellF = await evalJs(
          c,
          `(() => {
             const d = document.querySelector('.right-dock:not([hidden])')
             if (!d) return null
             return { float: d.dataset.dockFloat, width: d.dataset.dockWidth, w: Math.round(d.getBoundingClientRect().width) }
           })()`,
        )
        check(
          'adj1301 桌面默认壳：**右侧浮动栏 + 窄档 320**（打开后；"首屏两块壳都不在"由前面的用例守着）',
          !!shellF && shellF.float === '1' && shellF.width === 'narrow' && shellF.w === 320,
          JSON.stringify(shellF),
        )
        // 打开试听并开始播放
        await evalJs(c, `document.querySelector('.right-dock [data-key="tryout"]').click(), true`)
        await waitFor(
          c,
          `!!document.querySelector('.right-dock .pane-tryout:not([hidden]) .playback-actions .playback-btn')`,
          '阶段 F 试听面板',
          80,
        )
        await evalJs(
          c,
          `document.querySelector('.right-dock .pane-tryout .playback-actions .playback-btn').click(), true`,
        )
        await waitFor(
          c,
          `(() => { const b = document.querySelector('.right-dock .pane-tryout .playback-actions .playback-btn'); return !!b && /暂停\\(A\\)/.test(b.textContent || '') })()`,
          '阶段 F 进入播放态',
          120,
        )
        // 关栏 ⇒ 面板树仍在（hidden）、小工具条出现
        await evalJs(c, `document.querySelector('.topbar-right-dock').click(), true`)
        await waitFor(c, `!!document.querySelector('.right-dock[hidden]')`, '阶段 F 关栏后元素仍在')
        await waitFor(c, `!!document.querySelector('.playback-mini')`, '阶段 F 小工具条')
        const mini = await evalJs(
          c,
          `(() => {
             const bar = document.querySelector('.playback-mini')
             const topbar = document.querySelector('.topbar')
             const btn = document.querySelector('.topbar-toolbar button[data-tool-key="playback"]')
             if (!bar || !topbar || !btn) return null
             const br = bar.getBoundingClientRect(), tr = topbar.getBoundingClientRect(), kr = btn.getBoundingClientRect()
             const btns = [...bar.querySelectorAll('.playback-mini-btn')]
             return {
               n: btns.length,
               gapBelowTopbar: Math.round(br.top - tr.bottom),
               centerDelta: Math.round(Math.abs((br.left + br.right) / 2 - (kr.left + kr.right) / 2)),
               icons: bar.querySelectorAll('.tool-icon').length,
               titles: btns.map((b) => b.getAttribute('title') || ''),
             }
           })()`,
        )
        check(
          'adj1301 关栏后小工具条出现：**三个按钮**（播放·暂停 / 停止 / 设置）、图标齐全、位置在顶栏「试听」按钮正下方',
          !!mini &&
            mini.n === 3 &&
            mini.icons === 3 &&
            mini.gapBelowTopbar >= 4 &&
            mini.gapBelowTopbar <= 12 &&
            mini.centerDelta <= 2,
          JSON.stringify(mini),
        )
        // 播放·暂停（第一个按钮）
        await evalJs(c, `document.querySelectorAll('.playback-mini-btn')[0].click(), true`)
        await waitFor(
          c,
          `(document.querySelectorAll('.playback-mini-btn')[0]?.getAttribute('title') || '').includes('继续播放')`,
          '阶段 F 工具条暂停',
        )
        await evalJs(c, `document.querySelectorAll('.playback-mini-btn')[0].click(), true`)
        await waitFor(
          c,
          `(document.querySelectorAll('.playback-mini-btn')[0]?.getAttribute('title') || '').includes('暂停')`,
          '阶段 F 工具条继续',
        )
        // 设置（第三个按钮）⇒ 重新展开右栏、落在试听面板；仍是播放态 ⇒ 证明关栏期间会话没断
        await evalJs(c, `document.querySelectorAll('.playback-mini-btn')[2].click(), true`)
        await waitFor(
          c,
          `!!document.querySelector('.right-dock:not([hidden]) .pane-tryout:not([hidden])')`,
          '阶段 F 设置打开试听面板',
        )
        const stillPlaying = await evalJs(
          c,
          `(() => { const b = document.querySelector('.right-dock .pane-tryout .playback-actions .playback-btn'); return !!b && /暂停\\(A\\)/.test(b.textContent || '') })()`,
        )
        check(
          'adj1301 关栏期间**播放会话没断**：经小工具条「设置」重新展开，试听按钮仍是「暂停(A)」（没有被卸载重置）',
          stillPlaying === true,
        )
        // adj1303（用户追加）：点「停止」**不隐藏**工具条（只把会话收尾）；
        // 只有右栏**切到别的页签**时才隐藏。
        await evalJs(c, `document.querySelector('.topbar-right-dock').click(), true`)
        await waitFor(c, `!!document.querySelector('.playback-mini')`, '阶段 F 第二次关栏工具条')
        await evalJs(c, `document.querySelectorAll('.playback-mini-btn')[1].click(), true`)
        await sleep(450)
        const afterStop = await evalJs(
          c,
          `(() => {
             const bar = document.querySelector('.playback-mini')
             const btns = bar ? [...bar.querySelectorAll('.playback-mini-btn')] : []
             const panelBtn = document.querySelector('.right-dock[hidden] .pane-tryout .playback-actions .playback-btn')
             return {
               bar: !!bar,
               first: btns[0]?.getAttribute('title') ?? '',
               stopDisabled: btns[1] ? btns[1].disabled : null,
               panelText: panelBtn ? panelBtn.textContent || '' : '',
             }
           })()`,
        )
        check(
          'adj1303 点「停止」后小工具条**不隐藏**（播放键回到「播放」、停止键置灰，面板回到「播放(A)」）',
          afterStop.bar === true && afterStop.first.includes('播放') && afterStop.stopDisabled === true && /播放\(A\)/.test(afterStop.panelText),
          JSON.stringify(afterStop),
        )
        // 切到别的页签（导出）再收起 ⇒ 工具条隐藏（只有试听页签才显示）
        await evalJs(c, `document.querySelector('.topbar-right-dock').click(), true`)
        await waitFor(c, `!!document.querySelector('.right-dock:not([hidden])')`, '阶段 F 重开右栏')
        await evalJs(c, `document.querySelector('.right-dock [data-key="export"]').click(), true`)
        await sleep(350)
        await evalJs(c, `document.querySelector('.topbar-right-dock').click(), true`)
        await sleep(400)
        check(
          'adj1303 右栏切到**别的页签**（导出）再收起 ⇒ 小工具条隐藏（不在试听页签且没在播）',
          (await evalJs(c, `!!document.querySelector('.playback-mini')`)) === false,
        )
        // adj1303：**正在播放**时即使切到别的页签、再收起 ⇒ 工具条仍显示（"试听页签 **或** 正在播放"）
        await evalJs(c, `document.querySelector('.topbar-right-dock').click(), true`)
        await waitFor(c, `!!document.querySelector('.right-dock:not([hidden])')`, '阶段 F 再开右栏')
        await evalJs(c, `document.querySelector('.right-dock [data-key="tryout"]').click(), true`)
        await waitFor(
          c,
          `!!document.querySelector('.right-dock .pane-tryout:not([hidden]) .playback-actions .playback-btn')`,
          '阶段 F 再开试听',
          80,
        )
        await evalJs(c, `document.querySelector('.right-dock .pane-tryout .playback-actions .playback-btn').click(), true`)
        await waitFor(
          c,
          `(() => { const b = document.querySelector('.right-dock .pane-tryout .playback-actions .playback-btn'); return !!b && /暂停\\(A\\)/.test(b.textContent || '') })()`,
          '阶段 F 再次播放',
          120,
        )
        await evalJs(c, `document.querySelector('.right-dock [data-key="export"]').click(), true`)
        await sleep(350)
        await evalJs(c, `document.querySelector('.topbar-right-dock').click(), true`)
        await waitFor(c, `!!document.querySelector('.playback-mini')`, '播放中切页签仍显示工具条')
        check(
          'adj1303 **播放中**切到别的页签再收起 ⇒ 小工具条仍显示（"试听页签 或 正在播放"）',
          (await evalJs(c, `(() => { const b = document.querySelectorAll('.playback-mini-btn')[0]; return !!b && (b.getAttribute('title') || '').includes('暂停') })()`)) === true,
        )
        await evalJs(c, `document.querySelectorAll('.playback-mini-btn')[1].click(), true`)
        await waitFor(c, `!document.querySelector('.playback-mini')`, '停止后（非试听页签）工具条隐藏')
        check(
          'adj1303 停掉后且不在试听页签 ⇒ 小工具条隐藏',
          (await evalJs(c, `!!document.querySelector('.playback-mini')`)) === false,
        )
      }

    c.close()
  } catch (e) {
    check(`脚本自身出错：${e instanceof Error ? e.message : String(e)}`, false)
  }

  console.log('')
  console.log(failed === 0 ? `[verify-app-ui] 全部通过 ✅（${passed} 项）` : `[verify-app-ui] 失败 ${failed} 项 ❌`)
  await cleanup(failed === 0 ? 0 : 1)
}

void main()


