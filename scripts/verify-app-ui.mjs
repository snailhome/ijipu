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

/**
 * adj1179（用户 2026-11-02）：「在菜单上添加卡片模板菜单项」。
 *
 * 走真实路径：点顶栏「菜单」→ 在「设置」分组里点「卡片模板」→ 模板对话框打开 → 取消。
 * 这条只能真点：`hidden` 闸门（非桌面端不显示）与菜单分组渲染都在运行时。
 */
async function openCardStyleFromMenu(c) {
  await waitFor(c, `!!document.querySelector('.topbar-hamburger-btn')`, '顶栏菜单按钮')
  await evalJs(c, `document.querySelector('.topbar-hamburger-btn').click(), true`)
  await waitFor(c, `!!document.querySelector('.topbar-hamburger.open .menu-dropdown')`, '菜单打开')
  const hasEntry = await evalJs(
    c,
    `[...document.querySelectorAll('.topbar-hamburger.open .menu-entry')].some((el) => el.textContent.includes('卡片模板'))`,
  )
  check('adj1179 菜单「设置」分组里有「卡片模板」', hasEntry === true)
  await evalJs(
    c,
    `[...document.querySelectorAll('.topbar-hamburger.open .menu-entry')].find((el) => el.textContent.includes('卡片模板')).click(), true`,
  )
  await waitFor(c, `!!document.querySelector('.card-style-form')`, '卡片模板对话框（从菜单打开）')
  check('adj1179 从菜单能打开卡片模板对话框', true)
  // adj1186：朱砂印章分区右侧必须有效果预览框
  const sealEffectUi = await evalJs(
    c,
    `(() => {
      const el = document.querySelector('[data-card="seal-effect"]')
      return { has: !!el, text: el ? el.textContent : '' }
    })()`,
  )
  check(
    'adj1186 朱砂印章框内右侧有效果预览（未启用时显示提示）',
    sealEffectUi.has && sealEffectUi.text.includes('效果预览'),
    JSON.stringify(sealEffectUi),
  )
  // adj1180：「读取本机字体」不能因为接口缺失就静默禁用；界面必须写明可以手打字体名
  const fontUi = await evalJs(
    c,
    `(() => {
      const form = document.querySelector('.card-style-form')
      if (!form) return { has: false, enabled: false, manual: false }
      const btn = [...form.querySelectorAll('button')].find((b) => b.textContent.includes('读取本机字体'))
      return {
        has: !!btn,
        enabled: btn ? !btn.disabled : false,
        manual: (form.textContent || '').includes('没列出来也能直接输入字体名')
      }
    })()`,
  )
  check(
    'adj1180 「读取本机字体」按钮可用，且界面写明"没列出来也能直接输入字体名"',
    fontUi.has && fontUi.enabled && fontUi.manual,
    JSON.stringify(fontUi),
  )
  await evalJs(
    c,
    `[...document.querySelectorAll('.card-style-footer .btn')].find((b) => b.textContent.trim() === '取消')?.click(), true`,
  )
  await waitFor(c, `!document.querySelector('.card-style-form')`, '卡片模板对话框关闭')
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

    // ---- adj1179：菜单 → 设置 → 卡片模板（桌面闸门下）----
    console.log('[verify-app-ui] adj1179：菜单 → 卡片模板（真点）')
    await openCardStyleFromMenu(c)

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
      'adj987d 组内按钮**只用图标**（起始/停止/添加/删除/循环 + adj1044 的导出动态谱，六个按钮都不含中文文本），中文只留在 title/aria-label',
      (await evalJs(
        c,
        `(() => {
          const btns = [...document.querySelectorAll('.practice-bar .practice-btn')]
          if (btns.length !== 6) return 'count:' + btns.length
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
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, height: r.height, vw: innerWidth, vh: innerHeight, topbarBottom: tb ? tb.bottom : null }
    })()`)
    check(
      'adj1013 提示真的落在**右上角、顶栏下方**（顶边在顶栏之下、右缘贴右、不越到下半区 ⇒ 不再压住底部 dock）',
      !!toastBox &&
        toastBox.topbarBottom !== null &&
        toastBox.top >= toastBox.topbarBottom - 8 &&
        toastBox.vw - toastBox.right <= 30 &&
        toastBox.left > toastBox.vw / 2 &&
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
    // ============ adj1065：动态谱视频 = 预览区相机位（真点入口 → 画布/控制条 → 关闭）============
    const dynTab = await evalJs(
      c,
      `(() => {
        const b = [...document.querySelectorAll('.topbar-btn')].find((el) => (el.getAttribute('title') || '').includes('导出'))
        if (!b) return 'no-tab'
        b.click()
        return 'ok'
      })()`,
    )
    check('adj1065 能找到顶栏「导出」按钮', dynTab === 'ok', dynTab)
    if (dynTab === 'ok') {
      await waitFor(c, `!!document.querySelector('.export-panel')`, '导出面板出现')
      const dynClicked = await evalJs(
        c,
        `(() => {
          const btn = [...document.querySelectorAll('.export-panel .btn')].find((b) => b.textContent.includes('动态谱视频'))
          if (!btn) return 'no-btn'
          btn.click()
          return 'ok'
        })()`,
      )
      check('adj1065 导出面板的「动态谱视频」能点开相机位', dynClicked === 'ok', dynClicked)
      if (dynClicked === 'ok') {
        await waitFor(c, `!!document.querySelector('.dyn-frame-layer')`, '相机位层出现')
        await waitFor(c, `!!document.querySelector('.dyn-frame-controls')`, '相机位控制条出现')
        // 画布由 createDynamicSession 建好并 paint(0) 后才有 1080×1920 的真实尺寸
        await waitFor(
          c,
          `(() => { const c = document.querySelector('.dyn-frame-box canvas'); return !!c && c.width >= 1000 && c.height >= 1000 })()`,
          '相机位动态画布（9:16）',
          60,
        )
        const frame = await evalJs(
          c,
          `(() => {
            const box = document.querySelector('.dyn-frame-box')
            const cvs = box?.querySelector('canvas')
            const ctl = document.querySelector('.dyn-frame-controls')
            const b = box?.getBoundingClientRect()
            const r = ctl?.getBoundingClientRect()
            return {
              w: cvs?.width ?? 0,
              h: cvs?.height ?? 0,
              controls: !!ctl,
              outside: !!b && !!r && r.top >= b.bottom - 2
            }
          })()`,
        )
        check(
          'adj1065 相机位里是动态视频画布，控制条在框外暗部',
          frame.w >= 1000 && frame.h >= 1000 && frame.controls && frame.outside,
          JSON.stringify(frame),
        )
        // adj1164：相机位音色下拉——默认自动随谱，选具体音色后真的切换
        const instSel = await evalJs(
          c,
          `(() => {
            const el = document.querySelector('[data-sync="dyn-instrument"]')
            if (!el) return { exists: false }
            return { exists: true, value: el.value, labels: [...el.options].map((o) => o.textContent.trim()) }
          })()`,
        )
        check(
          'adj1164 相机位有音色下拉，默认「自动（随谱）」，且列出可用音色',
          instSel.exists && instSel.value === '' && instSel.labels[0] === '自动（随谱）' && instSel.labels.length >= 2,
          JSON.stringify(instSel),
        )
        const instPicked = await evalJs(
          c,
          `(() => {
            const el = document.querySelector('[data-sync="dyn-instrument"]')
            if (!el || el.options.length < 2) return ''
            const target = el.options[1].value
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
            setter.call(el, target)
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return target
          })()`,
        )
        await waitFor(
          c,
          `document.querySelector('[data-sync="dyn-instrument"]')?.value === ${JSON.stringify(instPicked)}`,
          '相机位音色选中',
        )
        check('adj1164 相机位选具体音色真的生效（不是只改下拉显示）', instPicked !== '', instPicked)
        // adj1165：入口统一后，标记段也收进相机位（整曲 + 练习段列表）
        const rangeSel = await evalJs(
          c,
          `(() => {
            const el = document.querySelector('[data-sync="dyn-range"]')
            if (!el) return { exists: false }
            return { exists: true, value: el.value, labels: [...el.options].map((o) => o.textContent.trim()) }
          })()`,
        )
        check(
          'adj1165 相机位有「标记段」下拉（含整曲；入口统一后不再只能靠试听带段）',
          rangeSel.exists && rangeSel.labels[0] === '整曲',
          JSON.stringify(rangeSel),
        )
        // 换音色会重建会话；等生成按钮重新可用后再做后面的出片门断言（否则会把"重建中"误判成"不能用"）
        await waitFor(
          c,
          `(() => { const b = document.querySelector('.dyn-frame-generate'); return !!b && !b.disabled })()`,
          '相机位换音色后重建完成',
          60,
        )
        // adj1077：网站/插件只保留预览，生成视频禁用并提示仅桌面版
        const videoGate = await evalJs(
          c,
          `(() => {
            const b = document.querySelector('.dyn-frame-generate')
            return {
              disabled: !!b && b.disabled,
              hint: document.querySelector('.dyn-frame-desktop-only')?.textContent ?? ''
            }
          })()`,
        )
        check(
          'adj1077 桌面壳模拟（测试注入）里生成视频可用',
          !videoGate.disabled && videoGate.hint === '',
          JSON.stringify(videoGate),
        )
        // 卡片模板会持久化：先固定为 brand，避免上次选过纸面让片头像素断言不稳定
        await evalJs(
          c,
          `(() => {
            const el = document.querySelector('.dyn-frame-select')
            if (!el) return false
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
            setter.call(el, 'brand')
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          })()`,
        )
        await waitFor(
          c,
          `(() => {
            const c = document.querySelector('.dyn-frame-box canvas')
            return !!c && c.width === 1080 && c.height === 1920 &&
              document.querySelector('.dyn-frame-select')?.value === 'brand'
          })()`,
          '相机位品牌卡片会话',
          60,
        )
        // adj1067：t=0 必须是自制深色标题卡；旧实现是白纸谱页（同一像素会接近 255）
        const introPixel = await evalJs(
          c,
          `(() => {
            const cvs = document.querySelector('.dyn-frame-box canvas')
            const ctx = cvs.getContext('2d')
            const d = ctx.getImageData(20, 20, 1, 1).data
            return [d[0], d[1], d[2]]
          })()`,
        )
        check(
          'adj1067 片头是自制深色标题卡（不是白纸谱页）',
          introPixel[0] < 80 && introPixel[1] < 100,
          JSON.stringify(introPixel),
        )
        /**
         * adj1113（用户 2026-10-23）：卡片前的「带片头片尾」复选框。
         * 真点一遍：默认勾选 → 取消 ⇒ 会话重建、t=0 不再是深色片头卡（而是白纸谱页）→ 再勾回 ⇒ 片头回来。
         * 这不只是"控件在不在"：像素变化证明复选框真的接进了建会话那条链（预览 = 成片口径）。
         */
        const cardsToggle = await evalJs(
          c,
          `(() => {
            const el = document.querySelector('.dyn-frame-cards input[type=checkbox]')
            if (!el) return null
            const label = el.closest('label')
            return {
              checked: el.checked,
              text: label?.textContent?.trim() ?? '',
              title: label?.title ?? '',
              aria: el.getAttribute('aria-label') ?? ''
            }
          })()`,
        )
        check(
          'adj1113/adj1116 卡片前只有一个复选框（**不带文字**），默认勾选；含义在悬浮提示与无障碍名里',
          !!cardsToggle &&
            cardsToggle.checked === true &&
            cardsToggle.text === '' &&
            (cardsToggle.title + cardsToggle.aria).includes('带片头片尾'),
          JSON.stringify(cardsToggle),
        )
        const cornerPixel = `(() => {
          const d = document.querySelector('.dyn-frame-box canvas').getContext('2d').getImageData(20, 20, 1, 1).data
          return [d[0], d[1], d[2]]
        })()`
        await evalJs(c, `document.querySelector('.dyn-frame-cards input[type=checkbox]')?.click(), true`)
        await waitFor(
          c,
          `(() => {
            const d = document.querySelector('.dyn-frame-box canvas').getContext('2d').getImageData(20, 20, 1, 1).data
            return d[0] > 200 && d[1] > 200
          })()`,
          '关掉片头后 t=0 是谱页',
          60,
        )
        const noIntroPixel = await evalJs(c, cornerPixel)
        check(
          'adj1113 不勾选「带片头片尾」⇒ 预览从第一拍开始（t=0 是白纸谱页，不是片头卡）',
          noIntroPixel[0] > 200 && noIntroPixel[1] > 200,
          JSON.stringify(noIntroPixel),
        )
        const cardControls = await evalJs(
          c,
          `(() => {
            const s = document.querySelector('.dyn-frame-select')
            const b = document.querySelector('.dyn-frame-card-edit')
            return { sel: !!s && s.disabled, btn: !!b && b.disabled }
          })()`,
        )
        check(
          'adj1113 关掉片头片尾时卡片下拉与「自定义…」禁用（不是还能选模板却不出卡片）',
          cardControls.sel && cardControls.btn,
          JSON.stringify(cardControls),
        )
        await evalJs(c, `document.querySelector('.dyn-frame-cards input[type=checkbox]')?.click(), true`)
        await waitFor(
          c,
          `(() => {
            const d = document.querySelector('.dyn-frame-box canvas').getContext('2d').getImageData(20, 20, 1, 1).data
            return d[0] < 80 && d[1] < 100
          })()`,
          '重新勾上后片头卡回来',
          60,
        )
        check('adj1113 再勾回 ⇒ 片头卡回来（复选框两个方向都真的重建会话）', true)
        // adj1073：卡片模板下拉框；选纸面后片头背景应变亮、选择持久化；最后恢复品牌
        const cardSelect = await evalJs(
          c,
          `(() => {
            const el = document.querySelector('.dyn-frame-select')
            return el ? { value: el.value, options: [...el.options].map((o) => o.value) } : null
          })()`,
        )
        check(
          'adj1073 相机位有卡片模板选择（4 个预设）',
          !!cardSelect &&
            cardSelect.value === 'brand' &&
            ['brand', 'paper', 'ink', 'minimal'].every((id) => cardSelect.options.includes(id)),
          JSON.stringify(cardSelect),
        )
        await evalJs(
          c,
          `(() => {
            const el = document.querySelector('.dyn-frame-select')
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
            setter.call(el, 'paper')
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          })()`,
        )
        await waitFor(
          c,
          `(() => {
            const c = document.querySelector('.dyn-frame-box canvas')
            return !!c && c.width === 1080 && c.height === 1920 &&
              document.querySelector('.dyn-frame-select')?.value === 'paper'
          })()`,
          '相机位纸面卡片会话',
          60,
        )
        await evalJs(
          c,
          `(() => {
            const el = document.querySelector('.dyn-frame-controls input[type=range]')
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(el, '1500')
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          })()`,
        )
        await new Promise((r) => setTimeout(r, 300))
        const paperPixel = await evalJs(
          c,
          `(() => {
            const ctx = document.querySelector('.dyn-frame-box canvas').getContext('2d')
            const d = ctx.getImageData(20, 20, 1, 1).data
            return [d[0], d[1], d[2]]
          })()`,
        )
        check(
          'adj1073 纸面模板的片头背景是浅色（模板确实生效）',
          paperPixel[0] > 200 && paperPixel[1] > 190,
          JSON.stringify(paperPixel),
        )
        const storedCardStyle = await evalJs(c, `localStorage.getItem('ijipu.dynamicCardStyle')`)
        check('adj1073 卡片模板选择已持久化', storedCardStyle === 'paper', String(storedCardStyle))
        // 恢复品牌，后面的 16:9 用品牌模板
        await evalJs(
          c,
          `(() => {
            const el = document.querySelector('.dyn-frame-select')
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
            setter.call(el, 'brand')
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          })()`,
        )
        await waitFor(
          c,
          `(() => {
            const c = document.querySelector('.dyn-frame-box canvas')
            return !!c && c.width === 1080 && c.height === 1920 &&
              document.querySelector('.dyn-frame-select')?.value === 'brand'
          })()`,
          '相机位品牌卡片会话',
          60,
        )
        // adj1074 / adj1176：打开“卡片模板”对话框 → 保存 → 成为当前模板并发进下拉
        await evalJs(c, `document.querySelector('.dyn-frame-card-edit')?.click(), true`)
        await waitFor(c, `!!document.querySelector('.card-style-form')`, '卡片模板对话框', 30)
        check(
          'adj1074 相机位能打开卡片模板对话框',
          await evalJs(c, `!!document.querySelector('.card-style-save')`),
        )
        const cardDialog = await evalJs(
          c,
          `(() => {
            const form = document.querySelector('.card-style-form')
            const scroll = document.querySelector('.card-style-scroll')
            return {
              scroll: !!scroll,
              overflow: scroll ? getComputedStyle(scroll).overflowY : '',
              save: !!document.querySelector('.card-style-save'),
              library: !!document.querySelector('.card-style-templates'),
              name: !!form && !!form.querySelector('input[type=text]'),
              exportZip: !!document.querySelector('.card-style-export'),
              importZip: !!form && !!form.querySelector('input[type=file][accept*="zip"]')
            }
          })()`,
        )
        check(
          'adj1075/adj1176 卡片对话框可滚动、底部保存固定、含模板库与导入/导出 zip',
          cardDialog.scroll &&
            cardDialog.overflow === 'auto' &&
            cardDialog.save &&
            cardDialog.library &&
            cardDialog.name &&
            cardDialog.exportZip &&
            cardDialog.importZip,
          JSON.stringify(cardDialog),
        )
        const cardName = await evalJs(
          c,
          `(() => {
            const input = document.querySelector('.card-style-form input[type=text]')
            if (!input) return ''
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(input, '真机模板')
            input.dispatchEvent(new Event('input', { bubbles: true }))
            return input.value
          })()`,
        )
        check('adj1176 模板可以起名字（保存进列表时用这个名字）', cardName === '真机模板', String(cardName))
        // adj1182（用户 2026-11-02）：换起点模板 → 保存后不关窗；重开后起点模板要生效
        const baseAfter = await evalJs(
          c,
          `(() => {
            const sel = document.querySelector('.card-style-form select[data-card="base"]')
            if (!sel) return ''
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
            setter.call(sel, 'paper')
            sel.dispatchEvent(new Event('change', { bubbles: true }))
            return sel.value
          })()`,
        )
        check('adj1182 卡片对话框可以更换「起点模板」', baseAfter === 'paper', String(baseAfter))
        await evalJs(c, `document.querySelector('.card-style-save')?.click(), true`)
        await waitFor(c, `!!document.querySelector('.card-style-ok')`, '保存成功提示', 30)
        const saveStatus = await evalJs(
          c,
          `(() => {
            const el = document.querySelector('[data-card="save-status"]')
            return { has: !!el, text: el ? el.textContent : '', inFooter: !!el?.closest('.card-style-footer') }
          })()`,
        )
        check(
          'adj1187 保存后在**底栏**（保存按钮旁）显示成功提示',
          saveStatus.has && saveStatus.inFooter && saveStatus.text.includes('已保存模板'),
          JSON.stringify(saveStatus),
        )
        check(
          'adj1182 保存模板后**不关闭窗口**（还能继续调整/连续保存）',
          (await evalJs(c, `!!document.querySelector('.card-style-form')`)) === true,
        )
        await evalJs(
          c,
          `[...document.querySelectorAll('.card-style-footer .btn')].find((b) => b.textContent.trim() === '取消')?.click(), true`,
        )
        await waitFor(c, `!document.querySelector('.card-style-form')`, '卡片模板对话框关闭', 30)
        await waitFor(
          c,
          `(() => {
            const c = document.querySelector('.dyn-frame-box canvas')
            return !!c && c.width === 1080 && c.height === 1920 &&
              (document.querySelector('.dyn-frame-select')?.value ?? '').startsWith('tpl-')
          })()`,
          '相机位新模板会话',
          60,
        )
        const savedCard = await evalJs(
          c,
          `(() => {
            const v = document.querySelector('.dyn-frame-select')?.value ?? ''
            const c = document.querySelector('.dyn-frame-box canvas')
            const raw = localStorage.getItem('ijipu.cardTemplates')
            return { value: v, w: c ? c.width : 0, h: c ? c.height : 0, raw: raw ?? '' }
          })()`,
        )
        check(
          'adj1176 保存后成为当前模板，并出现在卡片下拉（id 是 tpl- 开头）',
          String(savedCard.value).startsWith('tpl-') && savedCard.w === 1080 && savedCard.h === 1920,
          JSON.stringify(savedCard),
        )
        check(
          'adj1176 模板存进公共模板库（ijipu.cardTemplates），带名字',
          String(savedCard.raw).includes('真机模板') && String(savedCard.raw).includes('tpl-'),
          String(savedCard.raw).slice(0, 120),
        )
        check(
          'adj1182 起点模板随模板保存（`baseId: "paper"`）',
          String(savedCard.raw).includes('"baseId":"paper"'),
          String(savedCard.raw).slice(0, 200),
        )
        // 再打开：起点模板应回到「纸面」，而不是被重置成「深空蓝」
        await evalJs(c, `document.querySelector('.dyn-frame-card-edit')?.click(), true`)
        await waitFor(c, `!!document.querySelector('.card-style-form')`, '卡片模板对话框（重开）', 30)
        const reopened = await evalJs(
          c,
          `(() => ({
            base: document.querySelector('.card-style-form select[data-card="base"]')?.value ?? '',
            name: document.querySelector('.card-style-form input[type=text]')?.value ?? ''
          }))()`,
        )
        check(
          'adj1182 重开对话框后起点模板仍是「纸面」（用户实报：之前会被重置成深空蓝）',
          reopened.base === 'paper' && reopened.name === '真机模板',
          JSON.stringify(reopened),
        )
        await evalJs(
          c,
          `[...document.querySelectorAll('.card-style-footer .btn')].find((b) => b.textContent.trim() === '取消')?.click(), true`,
        )
        await waitFor(c, `!document.querySelector('.card-style-form')`, '卡片模板对话框关闭（重开）', 30)
        // adj1071：控制条必须跟随主题变量（深/浅两套都验），不能写死深色
        const camBtnStyles = await evalJs(
          c,
          `(() => {
            const themeOf = () => {
              const probe = document.createElement('div')
              probe.style.position = 'absolute'
              probe.style.left = '-9999px'
              document.body.appendChild(probe)
              const bg = (name) => {
                probe.style.background = 'var(' + name + ')'
                return getComputedStyle(probe).backgroundColor
              }
              const panel = bg('--jp-bg-panel')
              const accent = bg('--jp-accent')
              probe.style.background = 'transparent'
              probe.style.color = 'var(--jp-on-accent)'
              const onAccent = getComputedStyle(probe).color
              probe.remove()
              const controls = getComputedStyle(document.querySelector('.dyn-frame-controls'))
              const gen = getComputedStyle(document.querySelector('.dyn-frame-generate'))
              const sel = getComputedStyle(document.querySelector('.dyn-frame-ratio.is-on'))
              return {
                panel, accent, onAccent,
                controlsBg: controls.backgroundColor,
                genBg: gen.backgroundColor,
                genColor: gen.color,
                selBg: sel.backgroundColor,
                selColor: sel.color
              }
            }
            const root = document.documentElement
            const orig = root.getAttribute('data-mode')
            const dark = themeOf()
            root.setAttribute('data-mode', 'light')
            const light = themeOf()
            if (orig === null) root.removeAttribute('data-mode')
            else root.setAttribute('data-mode', orig)
            return { dark, light }
          })()`,
        )
        const themeOk = (t) =>
          t.controlsBg === t.panel &&
          t.genBg === t.accent &&
          t.genColor === t.onAccent &&
          t.selBg === t.accent &&
          t.selColor === t.onAccent
        check(
          'adj1071 相机位控制条跟随主题（深/浅两套：面板/强调色/on-accent 同源）',
          themeOk(camBtnStyles.dark) && themeOk(camBtnStyles.light),
          JSON.stringify(camBtnStyles),
        )
        // adj1066：用户实报的 16:9 —— 相机位必须真的重建为 1920×1080 会话
        await evalJs(
          c,
          `[...document.querySelectorAll('.dyn-frame-controls .dyn-frame-ratio')].find((b) => b.textContent.trim() === '16:9')?.click(), true`,
        )
        await waitFor(
          c,
          `(() => { const c = document.querySelector('.dyn-frame-box canvas'); return !!c && c.width === 1920 && c.height === 1080 })()`,
          '相机位 16:9 画布',
          60,
        )
        check('adj1066 16:9 相机位真的重建为 1920×1080 画布', true)
        await evalJs(c, `document.querySelector('.dyn-frame-close')?.click(), true`)
        await waitFor(c, `!document.querySelector('.dyn-frame-layer')`, '相机位关闭')
        check('adj1065 关闭相机位后层消失', true)
      }
    }

    /**
     * adj1121（用户 2026-10-24 实报「打开对拍是空白窗口」）：**对拍台能真的出来**。
     *
     * 那次的根因是 React #310 —— `useMemo` 写在了 `if (!doc) return null` **之后**，
     * 第一帧少跑一个 hook、第二帧多跑一个 ⇒ 整个应用白屏。
     * `tsc` 与 `smoke` 都是源码级，**一条都拦不住**；只有"真点一次 + 看 DOM 在不在"能拦住。
     * 所以这里钉三件事：① 从试听栏的入口点得开；② 台面里该有的东西都在（面板/波形画布/按钮）；
     * ③ 关掉之后层真的没了（不是关不掉）。
     */
    console.log('[verify-app-ui] adj1121：试听栏「对拍…」→ 对拍台能出来')
    const syncEntry = await evalJs(
      c,
      `(() => {
        const b = [...document.querySelectorAll('.topbar-btn')].find((el) => (el.textContent || '').includes('试听'))
        if (!b) return 'no-tab'
        b.click()
        return 'ok'
      })()`,
    )
    check('adj1121 顶栏「试听」点得开（底栏试听面板）', syncEntry === 'ok', syncEntry)
    if (syncEntry === 'ok') {
      await waitFor(c, `!!document.querySelector('.playback-actions')`, '试听面板')
      const syncClicked = await evalJs(
        c,
        `(() => {
          const b = [...document.querySelectorAll('.playback-actions .btn')].find((el) => el.textContent.includes('对拍'))
          if (!b) return 'no-btn'
          b.click()
          return 'ok'
        })()`,
      )
      check('adj1121 试听栏里有「对拍…」按钮（桌面/开发态）', syncClicked === 'ok', syncClicked)
      if (syncClicked === 'ok') {
        await waitFor(c, `!!document.querySelector('.sync-panel')`, '对拍台出现')
        const syncUi = await evalJs(
          c,
          `(() => {
            const p = document.querySelector('.sync-panel')
            const r = p ? p.getBoundingClientRect() : null
            const cvs = document.querySelector('.sync-wave canvas')
            return {
              panel: !!p,
              h: r ? Math.round(r.height) : 0,
              w: r ? Math.round(r.width) : 0,
              canvas: !!cvs && cvs.width > 100,
              // adj1122：波形 172 + 下侧时间标尺 20 = 192（dpr 1 时）；这里只要"够高"就算有标尺
              canvasH: cvs ? cvs.height : 0,
              text: p ? p.innerText.slice(0, 40) : '',
            }
          })()`,
        )
        check(
          'adj1121/adj1122/adj1139 对拍台真的渲染出来（面板有尺寸、波形画布 + 下侧时间标尺都在；不是白屏）',
          syncUi.panel && syncUi.h > 300 && syncUi.w > 600 && syncUi.canvas && syncUi.canvasH >= 120,
          JSON.stringify(syncUi),
        )
        // adj1123：波形**上方**要有动态谱预览（会话异步建好 ⇒ 轮询等它出图）
        // adj1133：预览＝应用自己的 `PreviewPane`（真 SVG 谱面 + 自己的滚动容器），不再是我们画的画布
        const previewReady = await waitFor(
          c,
          `(() => {
            const pane = document.querySelector('.sync-preview-box .preview-pane')
            if (!pane) return false
            const svg = pane.querySelector('.preview-svg svg')
            const sc = pane.querySelector('.preview-zoom-scale')
            return !!svg && !!sc && svg.getBoundingClientRect().height > 40
          })()`,
          '应用预览（SVG 谱面）',
          80,
        )
        check('adj1133 预览用的是应用自己的 PreviewPane（.preview-pane 里有 SVG 谱面 + 缩放层）', previewReady)
        // adj1173：节拍器音色下拉真的在台面里，且四种音色齐全（木鱼/梆子/齿轮/电子）
        const timbreSel = await evalJs(
          c,
          `(() => {
            const s = document.querySelector('[data-sync="metronome-timbre"]')
            if (!s) return null
            return {
              values: [...s.options].map((o) => o.value),
              labels: [...s.options].map((o) => o.textContent),
              selected: s.value,
            }
          })()`,
        )
        check(
          'adj1173 对拍台有节拍器音色下拉（4 种：木鱼/梆子/齿轮/电子）',
          timbreSel !== null &&
            timbreSel.values.join(',') === 'woodblock,bangzi,gear,electronic' &&
            timbreSel.labels.join(',') === '木鱼,梆子,齿轮,电子',
          JSON.stringify(timbreSel),
        )
        // 下拉真的接了状态：切到梆子 ⇒ 本机偏好落盘（不是只画了一个下拉）
        const timbreChanged = await evalJs(
          c,
          `(() => {
            const s = document.querySelector('[data-sync="metronome-timbre"]')
            if (!s) return null
            s.value = 'bangzi'
            s.dispatchEvent(new Event('change', { bubbles: true }))
            return s.value
          })()`,
        )
        const timbrePersisted = await waitFor(
          c,
          `localStorage.getItem('ijipu.metronomeTimbre') === 'bangzi'`,
          '节拍器音色落盘',
          20,
        )
        check(
          'adj1173 切换音色真的生效并记住（bangzi ⇒ localStorage ijipu.metronomeTimbre）',
          timbreChanged === 'bangzi' && timbrePersisted,
          JSON.stringify({ timbreChanged, timbrePersisted }),
        )
        // 预览能滚动（谱面比预览区高 ⇒ 必须有滚动条）
        const scrollable = await evalJs(
          c,
          `(() => { const p = document.querySelector('.sync-preview-box .preview-pane'); if (!p) return null; return { sh: p.scrollHeight, ch: p.clientHeight, overflow: getComputedStyle(p).overflowY } })()`,
        )
        check(
          'adj1133 预览区可以滚动（内容比可视区高 ⇒ 出现滚动条）',
          scrollable !== null && scrollable.sh > scrollable.ch && scrollable.overflow === 'auto',
          JSON.stringify(scrollable),
        )

        // adj1128（用户 2026-10-24：「这些按钮放到波形下面、跟下面的按钮整合，节省上面空间」）
        // adj1140：伴奏挪到预览下面那一排、当前位置挪到波形下面那一排，缩放挪到右上角
        const orderCheck = await evalJs(
          c,
          `(() => {
            const top = (el) => (el ? Math.round(el.getBoundingClientRect().top) : -1)
            const info = document.querySelector('.sync-preview-info')
            const audioRow = document.querySelector('.sync-audio-row')
            return {
              preview: top(document.querySelector('.sync-preview')),
              strip: top(document.querySelector('[data-sync="note-strip"]')),
              wave: top(document.querySelector('.sync-wave')),
              audio: top(audioRow),
              infoHasAudio: !!info && (info.textContent || '').includes('伴奏'),
              infoHasPick: !!info && !!info.querySelector('button'),
              nowInAudioRow: !!audioRow?.querySelector('.sync-audio-left .sync-preview-pos'),
              nowText: audioRow?.querySelector('.sync-audio-left')?.textContent?.trim().slice(0, 24) ?? '',
              zoomInHead: !!document.querySelector('.sync-head [data-sync="zoom-value"]'),
            }
          })()`,
        )
        check(
          'adj1128 预览 → 格子排 → 波形 → 参数行（垂直顺序对）',
          orderCheck.preview > 0 &&
            orderCheck.strip > orderCheck.preview &&
            orderCheck.wave > orderCheck.strip &&
            orderCheck.wave < orderCheck.audio,
          JSON.stringify(orderCheck),
        )
        check(
          'adj1140 伴奏在预览下面那一排、当前位置在波形下面那一排、谱面缩放在右上角',
          orderCheck.infoHasAudio &&
            orderCheck.infoHasPick &&
            orderCheck.nowInAudioRow &&
            orderCheck.nowText.includes('当前位置') &&
            orderCheck.zoomInHead,
          JSON.stringify(orderCheck),
        )

        /**
         * adj1126（用户 2026-10-24「波形也要能缩放，默认整曲」）：真滚轮缩一次，看视野选择器变没变；
         * 再按 `0` 回整曲。
         *
         * 为什么先造一条 4 秒 WAV 喂进去：视野是"时长比例"，**没有音频时全长只有 1ms**，
         * 缩放当然什么也不会变（那是正确行为，不是 bug）。这里在页面里现造一个 WAV `File`
         * （不依赖本机文件），喂给 `.sync-file` 走真实的解码路径。
         */
        const fixture = await evalJs(
          c,
          `(() => {
            const sr = 8000
            const secs = 60
            const n = sr * secs
            const ab = new ArrayBuffer(44 + n * 2)
            const dv = new DataView(ab)
            const ws = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)) }
            ws(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ')
            dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
            dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
            ws(36, 'data'); dv.setUint32(40, n * 2, true)
            for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(i / 20) * 12000), true)
            const input = document.querySelector('.sync-file')
            if (!input) return 'no-input'
            const dt = new DataTransfer()
            dt.items.add(new File([ab], 'verify-fixture.wav', { type: 'audio/wav' }))
            input.files = dt.files
            input.dispatchEvent(new Event('change', { bubbles: true }))
            return 'ok'
          })()`,
        )
        const decoded = await waitFor(
          c,
          `(() => { const t = document.querySelector('.sync-meta')?.textContent || ''; return t.includes('/') && !t.startsWith('0.000s / 0.001') })()`,
          '临时伴奏解码完成（4 秒）',
          60,
        )
        check('adj1126 临时 WAV 能走真实解码路径（60 秒）', fixture === 'ok' && decoded, String(fixture))
        const waveRect = await evalJs(
          c,
          `(() => { const el = document.querySelector('.sync-wave canvas'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`,
        )
        const viewBefore = await evalJs(c, `document.querySelector('[data-sync="view"]')?.value ?? '?'`)
        if (waveRect) {
          await c.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: waveRect.x,
            y: waveRect.y,
            deltaX: 0,
            deltaY: -120,
          })
          await sleep(400)
        }
        const afterWheel = await evalJs(
          c,
          `(() => ({
            span: document.querySelector('[data-sync="view"]')?.value ?? '?',
            readout: document.querySelector('.sync-view-readout')?.textContent?.trim() ?? '',
          }))()`,
        )
        check(
          'adj1126 滚轮缩放真的生效（60s → 48s，视野选择器给出具体时长，读数给出可视区间）',
          afterWheel.span === '48000' && /s\s*[–-]\s*\d/.test(afterWheel.readout),
          JSON.stringify({ before: viewBefore, ...afterWheel }),
        )
        /**
         * adj1124（用户 2026-10-24 实报「窗口无法调整大小，和最大化」「波形/预览高度要能调」）：
         * 这些全是**交互**，源码断言证明不了，只能真拖。
         */
        const mouse = async (type, x, y) =>
          c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
        const dragBy = async (selector, dx, dy) => {
          const r = await evalJs(
            c,
            `(() => { const el = document.querySelector('${selector}'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`,
          )
          if (!r) return false
          await mouse('mousePressed', r.x, r.y)
          for (let i = 1; i <= 5; i++) {
            await mouse('mouseMoved', r.x + (dx * i) / 5, r.y + (dy * i) / 5)
            await sleep(40)
          }
          await mouse('mouseReleased', r.x + dx, r.y + dy)
          return true
        }
        const panelBox = async () =>
          evalJs(
            c,
            `(() => { const p = document.querySelector('.sync-panel').getBoundingClientRect(); const pv = document.querySelector('.sync-preview').getBoundingClientRect(); return { w: Math.round(p.width), h: Math.round(p.height), preview: Math.round(pv.height) } })()`,
          )
        const before = await panelBox()

        /**
         * adj1127（用户 2026-10-24「波形放大后要一个横向滚动条」）：
         * 放大后必须出现滚动条；拖滑块能平移视野（读数变）；按 `0` 回整曲后滚动条消失。
         */
        const scrollShown = await evalJs(c, `!!document.querySelector('.sync-scroll')`)
        const readoutBefore = await evalJs(c, `document.querySelector('.sync-view-readout')?.textContent ?? ''`)
        // adj1135：当前位置必须是**定长**两位数（`11:2.72（第 42 拍）`），否则整行会左右晃
        const posText = await evalJs(c, `document.querySelector('.sync-preview-pos')?.textContent?.trim() ?? ''`)
        check(
          'adj1135 当前位置读数定长（拍号两位小数、无浮点尾巴）',
          /\d+:\d+\.\d{2}（第 \d+ 拍）/.test(posText) && !/\d{6,}/.test(posText),
          JSON.stringify(posText),
        )
        const thumbDragged = await dragBy('.sync-scroll-thumb', -80, 0)
        await sleep(350)
        const afterThumb = await evalJs(c, `document.querySelector('.sync-view-readout')?.textContent ?? ''`)
        check(
          'adj1127 放大后出现横向滚动条，拖滑块能平移视野（读数跟着变）',
          scrollShown && thumbDragged && afterThumb !== readoutBefore,
          JSON.stringify({ scrollShown, thumbDragged, before: readoutBefore, after: afterThumb }),
        )
        /**
         * adj1131（用户 2026-10-24）：滚轮的修饰键分工——
         *  · 无修饰 = 缩放；**Shift = 左右平移**；Ctrl/Alt = 不接管（交给浏览器，别把波形缩了）。
         * CDP 的 modifiers 位：Alt=1、Ctrl=2、Meta=4、Shift=8。
         */
        const wheelAt = async (modifiers, deltaY) => {
          const r = await evalJs(
            c,
            `(() => { const el = document.querySelector('.sync-wave canvas'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()`,
          )
          if (!r) return
          await c.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: r.x,
            y: r.y,
            deltaX: 0,
            deltaY,
            modifiers,
          })
          await sleep(300)
        }
        const spanOf = () =>
          evalJs(c, `document.querySelector('[data-sync="view"]')?.value ?? '?'`)
        const readoutOf = () =>
          evalJs(c, `document.querySelector('.sync-view-readout')?.textContent?.trim() ?? ''`)
        const spanBeforeShift = await spanOf()
        const readBeforeShift = await readoutOf()
        await wheelAt(8, 120) // Shift + 滚轮 ⇒ 平移
        const spanAfterShift = await spanOf()
        const readAfterShift = await readoutOf()
        check(
          'adj1131 Shift+滚轮 = 左右平移（视野长度不变、左缘变了）',
          spanAfterShift === spanBeforeShift && readAfterShift !== readBeforeShift,
          JSON.stringify({ spanBeforeShift, spanAfterShift, readBeforeShift, readAfterShift }),
        )
        const spanBeforeCtrl = await spanOf()
        await wheelAt(2, -120) // Ctrl + 滚轮 ⇒ 不接管
        const spanAfterCtrl = await spanOf()
        check(
          'adj1131 Ctrl+滚轮不再缩放波形（交给浏览器缩放页面）',
          spanAfterCtrl === spanBeforeCtrl,
          JSON.stringify({ spanBeforeCtrl, spanAfterCtrl }),
        )
        const spanBeforeAlt = await spanOf()
        await wheelAt(1, -120) // Alt + 滚轮 ⇒ 不接管
        const spanAfterAlt = await spanOf()
        check(
          'adj1131 Alt+滚轮不再缩放波形',
          spanAfterAlt === spanBeforeAlt,
          JSON.stringify({ spanBeforeAlt, spanAfterAlt }),
        )
        // 按 0 回整曲 ⇒ 滚动条消失
        for (const type of ['keyDown', 'keyUp']) {
          await c.send('Input.dispatchKeyEvent', {
            type,
            key: '0',
            code: 'Digit0',
            windowsVirtualKeyCode: 48,
            nativeVirtualKeyCode: 48,
          })
        }
        await sleep(350)
        const afterZero = await evalJs(
          c,
          `({ span: document.querySelector('[data-sync="view"]')?.value ?? '?', scroll: !!document.querySelector('.sync-scroll') })`,
        )
        check('adj1126/adj1127 按 0 回「整曲」，横向滚动条随之消失', afterZero.span === '0' && afterZero.scroll === false, JSON.stringify(afterZero))

        // ① 最大化 / 还原
        await evalJs(c, `[...document.querySelectorAll('.sync-head .btn')].find((b) => b.textContent.includes('最大化'))?.click(), true`)
        await sleep(350)
        const maxed = await panelBox()
        const winW = await evalJs(c, `window.innerWidth`)
        check(
          'adj1124 最大化：面板铺到窗口（≈视口宽 − 16~40）',
          maxed.w > before.w + 50 && Math.abs(maxed.w - (winW - 16)) < 60,
          JSON.stringify({ before: before.w, maxed: maxed.w, winW }),
        )
        await evalJs(c, `[...document.querySelectorAll('.sync-head .btn')].find((b) => b.textContent.includes('还原'))?.click(), true`)
        await sleep(350)
        const restored = await panelBox()
        check('adj1124 还原：回到原来的大小', restored.w === before.w && restored.h === before.h, JSON.stringify(restored))
        // ② 拖右下角把手：宽 +80
        await dragBy('.sync-resize', 80, 0)
        await sleep(350)
        const resized = await panelBox()
        check(
          'adj1124 拖右下角：面板真的变宽（+80 左右）',
          Math.abs(resized.w - (before.w + 80)) <= 4,
          JSON.stringify({ w: resized.w }),
        )
        await dragBy('.sync-resize', -80, 0)
        await sleep(300)
        // ③ 拖"预览↔波形"分隔条：预览变高
        const okSplit = await dragBy('.sync-split', 0, 50)
        await sleep(350)
        const afterSplit = await panelBox()
        check(
          'adj1124 拖分隔条：预览真的变高（+50 左右，面板跟着长高）',
          okSplit && afterSplit.preview > before.preview + 30,
          JSON.stringify({ preview: afterSplit.preview }),
        )
        await dragBy('.sync-split', 0, -50)
        await sleep(300)
        // ④ adj1133：缩放**跟顶栏同一个偏好**——点台面里的 `+` 要看到百分比变化、
        //    而且应用预览的缩放层（`.preview-zoom-scale`）真的跟着变
        const zoomBefore = await evalJs(
          c,
          `(() => {
            const v = document.querySelector('[data-sync="zoom-value"]')?.textContent?.trim() ?? ''
            const sc = document.querySelector('.sync-preview-box .preview-zoom-scale')
            return { value: v, zoom: sc ? sc.style.zoom : '' }
          })()`,
        )
        await evalJs(c, `document.querySelector('[data-sync="zoom-in"]')?.click(), true`)
        await sleep(400)
        const zoomAfter = await evalJs(
          c,
          `(() => {
            const v = document.querySelector('[data-sync="zoom-value"]')?.textContent?.trim() ?? ''
            const sc = document.querySelector('.sync-preview-box .preview-zoom-scale')
            const stored = localStorage.getItem('ijipu.previewZoom')
            return { value: v, zoom: sc ? sc.style.zoom : '', stored }
          })()`,
        )
        check(
          'adj1133 台面里的 ± 改的是**顶栏同一个缩放**（百分比 100%→110%、缩放层 zoom 1→1.1、落盘同一个键）',
          zoomBefore.value === '100%' &&
            zoomAfter.value === '110%' &&
            zoomBefore.zoom === '1' &&
            zoomAfter.zoom === '1.1' &&
            zoomAfter.stored === '110',
          JSON.stringify({ zoomBefore, zoomAfter }),
        )
        // 收尾：缩回 100%
        await evalJs(c, `document.querySelector('[data-sync="zoom-out"]')?.click(), true`)
        await sleep(300)

        /**
         * adj1137（用户 2026-10-24 的想法）：波形上方要有**音符格子排**；点一格要让播放头跳过去。
         */
        const strip = await evalJs(
          c,
          `(() => {
            const el = document.querySelector('[data-sync="note-strip"]')
            if (!el) return { cells: 0, w: 0 }
            const cells = [...el.querySelectorAll('.sync-note-cell')]
            return { cells: cells.length, w: Math.round(el.getBoundingClientRect().width), widths: cells.slice(0, 3).map((x) => Math.round(x.getBoundingClientRect().width)) }
          })()`,
        )
        check(
          'adj1137 波形上方有音符格子排（每格一个主音符；宽度=时值，见冒烟的几何断言）',
          strip.cells >= 3 && strip.w > 300 && strip.widths.some((w) => w > 0),
          JSON.stringify(strip),
        )
        const beforeCell = await evalJs(c, `document.querySelector('.sync-preview-pos')?.textContent?.trim() ?? ''`)
        const cellRect = await evalJs(
          c,
          `(() => {
            const cells = [...document.querySelectorAll('[data-sync="note-strip"] .sync-note-cell')]
            const el = cells[Math.min(cells.length - 1, Math.floor(cells.length * 0.6))]
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { x: Math.round(r.left + Math.min(4, r.width / 2)), y: Math.round(r.top + r.height / 2) }
          })()`,
        )
        if (cellRect) {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await c.send('Input.dispatchMouseEvent', { type, x: cellRect.x, y: cellRect.y, button: 'left', clickCount: 1 })
          }
        }
        await sleep(400)
        const afterCell = await evalJs(c, `document.querySelector('.sync-preview-pos')?.textContent?.trim() ?? ''`)
        check(
          'adj1137 点格子 ⇒ 播放头/色块跳到那个音（当前位置跟着变）',
          cellRect !== null && afterCell !== beforeCell,
          JSON.stringify({ beforeCell, afterCell }),
        )
        /**
         * adj1143（用户 2026-10-24）：「音符格子条也要跟波形一样响应滚轮和 Shift+滚轮」。
         * 把鼠标放在**格子条**上滚（不是波形），视野与读数都要跟着动。
         */
        const stripCenter = await evalJs(
          c,
          `(() => {
            const el = document.querySelector('[data-sync="note-strip"]')
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
          })()`,
        )
        const spanBeforeStripWheel = await evalJs(c, `document.querySelector('[data-sync="view"]')?.value ?? '?'`)
        if (stripCenter) {
          await c.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: stripCenter.x,
            y: stripCenter.y,
            deltaX: 0,
            deltaY: -120,
          })
        }
        await sleep(400)
        const spanAfterStripWheel = await evalJs(c, `document.querySelector('[data-sync="view"]')?.value ?? '?'`)
        check(
          'adj1143 音符格子条上滚轮也能缩放（视野长度变了，和波形同一套）',
          stripCenter !== null && spanAfterStripWheel !== spanBeforeStripWheel,
          JSON.stringify({ spanBeforeStripWheel, spanAfterStripWheel }),
        )
        const readBeforeStripPan = await evalJs(c, `document.querySelector('.sync-view-readout')?.textContent?.trim() ?? ''`)
        if (stripCenter) {
          await c.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: stripCenter.x,
            y: stripCenter.y,
            deltaX: 0,
            deltaY: 120,
            modifiers: 8, // Shift
          })
        }
        await sleep(400)
        const readAfterStripPan = await evalJs(c, `document.querySelector('.sync-view-readout')?.textContent?.trim() ?? ''`)
        check(
          'adj1143 音符格子条上 Shift+滚轮也能左右平移（读数左缘变了）',
          readAfterStripPan !== readBeforeStripPan,
          JSON.stringify({ readBeforeStripPan, readAfterStripPan }),
        )

        /**
         * adj1128（用户 2026-10-24 实报的三条）：
         *  ① 「保存没有实现」——点保存要看得到结果提示（桌面写文件 / 网页只有本机缓存，两者都要如实说）；
         *  ② 「音量调整无效」——真点播放，量一下 GainNode 上设的增益（必须等于滑杆值）；
         *  ③ 「节拍器关不掉」——关掉之后不能再有新排的"嗒"（计数不再增长）。
         */
        const saveClicked = await evalJs(c, `(() => { const b = document.querySelector('[data-sync="save"]'); if (!b) return false; b.click(); return true })()`)
        const saveNotice = await waitFor(
          c,
          `(() => { const t = document.querySelector('.sync-status')?.textContent ?? ''; return /已下载|已保存：|保存失败|已存本机缓存/.test(t) })()`,
          '保存后的提示',
          40,
        )
        check('adj1128 点「保存」有明确结果提示（不是静默无反应）', saveClicked && saveNotice, '')
        /**
         * adj1129（用户实报「提示存本机缓存，没看到对拍文件」）：
         * 网页/开发模式下保存必须**真的产出文件**（下载 JSON），不能只写 localStorage。
         * 这里把下载目录指到临时目录，再看文件到底有没有落地、内容像不像对拍文件。
         */
        let downloaded = ''
        let dlText = ''
        // 下载是异步落盘：轮询最多 ~3 秒
        for (let i = 0; i < 15 && downloaded === ''; i++) {
          try {
            const files = await readdir(DL)
            downloaded = files.find((f) => f.endsWith('.sync.json')) ?? ''
          } catch {
            downloaded = ''
          }
          if (downloaded === '') await sleep(200)
        }
        if (downloaded !== '') {
          try {
            dlText = await readFile(path.join(DL, downloaded), 'utf8')
          } catch {
            dlText = ''
          }
        }
        check(
          'adj1129 「保存」在网页/开发模式下真的下载出 `*.sync.json`（里面有 anchors/tempo 字段）',
          downloaded !== '' && /"anchors"/.test(dlText) && /"tempo"/.test(dlText),
          JSON.stringify({ downloaded, head: dlText.slice(0, 40) }),
        )
        // adj1129：双击「保存」不能变成最大化（用户实报）
        const headBoxBefore = await evalJs(c, `Math.round(document.querySelector('.sync-panel').getBoundingClientRect().width)`)
        const saveRect = await evalJs(
          c,
          `(() => { const b = document.querySelector('[data-sync="save"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`,
        )
        if (saveRect) {
          for (const count of [1, 2]) {
            await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: saveRect.x, y: saveRect.y, button: 'left', clickCount: count })
            await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: saveRect.x, y: saveRect.y, button: 'left', clickCount: count })
            await sleep(60)
          }
        }
        await sleep(400)
        const headBoxAfter = await evalJs(c, `Math.round(document.querySelector('.sync-panel').getBoundingClientRect().width)`)
        check(
          'adj1129 双击「保存」不会把窗口最大化（双击只在标题条空白处生效）',
          headBoxAfter === headBoxBefore,
          JSON.stringify({ before: headBoxBefore, after: headBoxAfter }),
        )

        // ② 音量：把伴奏音量拖到 0.6，再真播放，看 GainNode 的值
        await evalJs(
          c,
          `(() => {
            window.__gains = []
            window.__oscCount = 0
            if (!window.__gainPatched) {
              window.__gainPatched = true
              const orig = AudioContext.prototype.createGain
              AudioContext.prototype.createGain = function (...a) {
                const g = orig.apply(this, a)
                window.__gains.push(g)
                return g
              }
              const origOsc = AudioContext.prototype.createOscillator
              AudioContext.prototype.createOscillator = function (...a) {
                window.__oscCount++
                return origOsc.apply(this, a)
              }
            }
            const ranges = [...document.querySelectorAll('.sync-row input[type=range]')]
            const acc = ranges[0]
            if (!acc) return false
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(acc, '0.6')
            acc.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          })()`,
        )
        await sleep(200)
        // 先把节拍器打开（要在播放**之前**开，才看得到它排"嗒"）
        await evalJs(c, `(() => { const cb = [...document.querySelectorAll('.sync-check input')][0]; if (!cb) return false; if (!cb.checked) cb.click(); return cb.checked })()`)
        await sleep(200)
        const playRect = await evalJs(
          c,
          `(() => { const b = [...document.querySelectorAll('.sync-row .btn')].find((el) => el.textContent.trim() === '播放'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`,
        )
        if (playRect) {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await c.send('Input.dispatchMouseEvent', { type, x: playRect.x, y: playRect.y, button: 'left', clickCount: 1 })
          }
        }
        await sleep(1400)
        const gains = await evalJs(c, `(window.__gains || []).map((g) => Math.round(g.gain.value * 100) / 100)`)
        check(
          'adj1128 伴奏音量真的进了音频图（拖到 0.6 ⇒ GainNode = 0.6，不再是死滑杆）',
          Array.isArray(gains) && gains.includes(0.6),
          JSON.stringify(gains),
        )
        /**
         * adj1149（用户 2026-10-25：「滑条滑了没什么变化」「选合成音还是伴奏，都是伴奏」）：
         *
         * 上一代只在**开播那一刻**读一次音量/声音档 ⇒ 播放中怎么拖都不变。这里在**播放中**做两件事：
         *  ① 拖伴奏滑杆到 0.3 ⇒ 同一个 GainNode 的 value 要立刻变成 0.3（不重播）；
         *  ② 把声音档切到「合成音」⇒ 旧轨要真的 stop、并且重新起播（不是继续放伴奏）。
         */
        await evalJs(
          c,
          `(() => {
            const el = document.querySelector('[data-sync="mix-accomp"]')
            if (!el) return false
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(el, '0.3')
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          })()`,
        )
        await sleep(500)
        const gainsLive = await evalJs(c, `(window.__gains || []).map((g) => Math.round(g.gain.value * 100) / 100)`)
        check(
          'adj1149 播放中拖「伴奏音量」⇒ 音频图里的增益立刻变 0.3（不用暂停再播）',
          Array.isArray(gainsLive) && gainsLive.includes(0.3),
          JSON.stringify(gainsLive),
        )
        const switchState = await evalJs(
          c,
          `(() => {
            if (!window.__srcPatched) {
              window.__srcPatched = true
              const oStart = AudioBufferSourceNode.prototype.start
              AudioBufferSourceNode.prototype.start = function (...a) {
                window.__srcStarts = (window.__srcStarts || 0) + 1
                return oStart.apply(this, a)
              }
              const oStop = AudioBufferSourceNode.prototype.stop
              AudioBufferSourceNode.prototype.stop = function (...a) {
                window.__srcStops = (window.__srcStops || 0) + 1
                return oStop.apply(this, a)
              }
            }
            window.__srcStarts = 0
            window.__srcStops = 0
            const el = document.querySelector('[data-sync="mix-source"]')
            if (!el) return null
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
            setter.call(el, 'mix')
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return { value: el.value }
          })()`,
        )
        let restarted = false
        try {
          // 换档会从当前播放头重开：先停旧轨、再起新轨（mix 会立刻起伴奏，合成音稍后接进来）
          restarted = await waitFor(c, `(window.__srcStarts || 0) > 0`, '换档后重新起播', 120)
        } catch {
          restarted = false
        }
        const srcCounts = await evalJs(c, `({ starts: window.__srcStarts || 0, stops: window.__srcStops || 0 })`)
        check(
          'adj1149 播放中把声音切到「伴奏+合成」⇒ 旧伴奏真的停掉、播放重新开始（选择不再被忽略）',
          switchState !== null && switchState.value === 'mix' && restarted && srcCounts.stops > 0 && srcCounts.starts > 0,
          JSON.stringify({ switchState, srcCounts }),
        )
        // 切回「伴奏」再继续后面的节拍器用例（失败也没关系，别把状态留成"正在渲染合成音"）
        await evalJs(
          c,
          `(() => {
            const el = document.querySelector('[data-sync="mix-source"]')
            if (!el) return false
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
            setter.call(el, 'file')
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          })()`,
        )
        await sleep(700)
        // ③ 节拍器：此刻已排了 4 秒窗口 ⇒ 关掉之后计数必须停
        const oscOn = await evalJs(c, `window.__oscCount || 0`)
        await evalJs(c, `(() => { const cb = [...document.querySelectorAll('.sync-check input')][0]; if (!cb) return false; if (cb.checked) cb.click(); return !cb.checked })()`)
        await sleep(1500)
        const oscOff1 = await evalJs(c, `window.__oscCount || 0`)
        await sleep(1200)
        const oscOff2 = await evalJs(c, `window.__oscCount || 0`)
        check(
          'adj1128 关掉节拍器后不再排新的"嗒"（计数停止增长）',
          oscOn > 0 && oscOff1 === oscOff2,
          JSON.stringify({ 开着: oscOn, 关掉后1: oscOff1, 关掉后2: oscOff2 }),
        )
        // 停止播放，别把声音带进后面的用例
        await evalJs(c, `[...document.querySelectorAll('.sync-row .btn')].find((el) => el.textContent.trim() === '暂停')?.click(), true`)
        await sleep(300)
        /**
         * adj1150：相机位要有「输出声音」（声音档 + 两条音量）。
         *
         * 先补一条锚点（1 条就够：速度取谱面 `J:`），否则 `tempo === null`、相机位那排会禁用。
         * 然后关台面 → 打开相机位，真点一遍三档与音量滑杆。
         */
        await evalJs(c, `document.querySelector('[data-sync="align-head"]')?.click(), true`)
        await sleep(500)
        await evalJs(c, `[...document.querySelectorAll('.sync-head .btn')].find((b) => b.textContent.includes('关闭'))?.click(), true`)
        await waitFor(c, `!document.querySelector('.sync-layer')`, '对拍台关闭')
        check('adj1121 对拍台关得掉（层消失，底下试听还在）', true)

        const exportTab = await evalJs(
          c,
          `(() => {
            const b = [...document.querySelectorAll('.topbar-btn')].find((el) => (el.textContent || '').includes('导出'))
            if (!b) return 'no-tab'
            b.click()
            return 'ok'
          })()`,
        )
        if (exportTab === 'ok') {
          await waitFor(c, `!!document.querySelector('.export-panel')`, '导出面板')
          await evalJs(
            c,
            `[...document.querySelectorAll('.export-panel .btn')].find((b) => b.textContent.includes('动态谱视频'))?.click(), true`,
          )
          await waitFor(c, `!!document.querySelector('.dyn-frame-layer')`, '相机位层')
          const mixReady = await waitFor(
            c,
            `!!document.querySelector('[data-sync="dyn-mix-source"]')`,
            '相机位「输出声音」',
            80,
          )
          const mixUi = await evalJs(
            c,
            `(() => {
              const sel = document.querySelector('[data-sync="dyn-mix-source"]')
              const acc = document.querySelector('[data-sync="dyn-mix-accomp"]')
              const syn = document.querySelector('[data-sync="dyn-mix-synth"]')
              return {
                row: !!document.querySelector('[data-sync="dyn-mix"]'),
                value: sel ? sel.value : '',
                options: sel ? [...sel.options].map((o) => o.textContent.trim()) : [],
                acc: acc ? acc.value : '',
                syn: syn ? syn.value : '',
                pcts: [...document.querySelectorAll('.dyn-frame-mix-val')].map((x) => (x.textContent || '').trim()),
              }
            })()`,
          )
          check(
            'adj1150 相机位真的有「输出声音」：三档 + 两条音量 + 百分比（不是只在台面里）',
            mixReady &&
              mixUi.row &&
              mixUi.value === 'file' &&
              mixUi.options.join('/') === '伴奏/伴奏+合成/合成音' &&
              mixUi.acc === '0.3' &&
              mixUi.syn === '0.5' &&
              mixUi.pcts.includes('30%') &&
              mixUi.pcts.includes('50%'),
            JSON.stringify(mixUi),
          )
          // 真改一次：切「合成音」+ 把伴奏音量拖到 0.7，看值/百分比都跟着变
          const mixChanged = await evalJs(
            c,
            `(() => {
              const sel = document.querySelector('[data-sync="dyn-mix-source"]')
              const acc = document.querySelector('[data-sync="dyn-mix-accomp"]')
              if (!sel || !acc) return null
              const setSel = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
              setSel.call(sel, 'synth')
              sel.dispatchEvent(new Event('change', { bubbles: true }))
              const setNum = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
              setNum.call(acc, '0.7')
              acc.dispatchEvent(new Event('change', { bubbles: true }))
              return true
            })()`,
          )
          await sleep(400)
          const mixAfter = await evalJs(
            c,
            `(() => {
              const sel = document.querySelector('[data-sync="dyn-mix-source"]')
              const pcts = [...document.querySelectorAll('.dyn-frame-mix-val')].map((x) => (x.textContent || '').trim())
              return { value: sel ? sel.value : '', pcts }
            })()`,
          )
          check(
            'adj1150 相机位改声音档/音量真的生效（值变了、百分比跟着变）',
            mixChanged === true && mixAfter.value === 'synth' && mixAfter.pcts.includes('70%'),
            JSON.stringify(mixAfter),
          )
          // 改回「伴奏」，别把后面的用例留在合成音
          await evalJs(
            c,
            `(() => {
              const sel = document.querySelector('[data-sync="dyn-mix-source"]')
              if (!sel) return false
              const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
              setter.call(sel, 'file')
              sel.dispatchEvent(new Event('change', { bubbles: true }))
              return true
            })()`,
          )
          await sleep(300)
          await evalJs(c, `document.querySelector('.dyn-frame-close')?.click(), true`)
          await waitFor(c, `!document.querySelector('.dyn-frame-layer')`, '相机位关闭')
          check('adj1150 相机位关得掉（输出声音改完不影响别的用例）', true)
          // 关掉导出面板（只在它真的开着时才点，别把它反过来点开），后面的设置用例从干净界面开始
          await evalJs(
            c,
            `(() => {
              if (!document.querySelector('.export-panel')) return false
              const b = [...document.querySelectorAll('.topbar-btn')].find((el) => (el.textContent || '').includes('导出'))
              if (b) b.click()
              return true
            })()`,
          )
          await sleep(300)
        }
      }
    }

    /**
     * adj1089（用户口径"下拉要真点一遍"）：设置 → 本机 → 「平移方式」下拉。
     *
     * 源码级断言只能证明"代码里挂了 onChange / 有写 localStorage"，
     * 证明不了"点得动、真的记住"。这里走真浏览器：
     *  ① 打开「全局设置」→「本机」子页签，按**行标签**找到下拉（不按序号，避免上下一加行就点错）；
     *  ② 真改值（原生 setter + change 事件，React 的 onChange 才收得到）；
     *  ③ 读 localStorage 确认落盘；④ 重载后确认**还是「按拍」**（L1 偏好真的记住了）；
     *  ⑤ 改回「跟随」，不影响后面的用例。
     */
    console.log('[verify-app-ui] adj1089：设置 → 本机 →「平移方式」下拉')
    {
      /**
       * 打开「全局设置 → 本机」。
       *
       * ⚠ 两个坑都在这条链上，别退回旧写法：
       *  ① 子页签的 `textContent` 是「**⌂本机**」（图标 span 也是文本）⇒ 只能用 `includes('本机')`，
       *     判等会永远等不到（第一版就是这么超时的）；
       *  ② 顶栏「全局设置」是**开关**（再点一次会收起底栏）⇒ 已经在这一页时**不许再点**。
       */
      const openLocalTab = async () => {
        const already = await evalJs(
          c,
          `[...document.querySelectorAll('.jp-tab')].some((t) => t.textContent.includes('本机'))`,
        )
        if (already !== true) {
          const hit = await evalJs(
            c,
            `(() => {
               const b = [...document.querySelectorAll('.topbar-btn')].find((el) => el.getAttribute('title') === '全局设置')
               if (b) b.click()
               return !!b
             })()`,
          )
          if (hit !== true) {
            // 顶栏按钮可能被折进「更多」⇒ 退到菜单里的同一项
            await evalJs(
              c,
              `(() => {
                 const more = document.querySelector('.topbar-more')
                 if (more) more.click()
                 return true
               })()`,
            )
            await sleep(200)
            await evalJs(
              c,
              `[...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('全局设置'))?.click(), true`,
            )
          }
          await waitFor(c, `!!document.querySelector('.pcfg-root')`, '设置面板出现')
        }
        await waitFor(
          c,
          `[...document.querySelectorAll('.jp-tab')].some((t) => t.textContent.includes('本机'))`,
          '「本机」子页签出现',
        )
        await evalJs(
          c,
          `[...document.querySelectorAll('.jp-tab')].find((t) => t.textContent.includes('本机'))?.click(), true`,
        )
        await waitFor(c, `!!document.querySelector('.pcfg-fields select')`, '本机页签内容出现（含下拉）')
      }
      /** 按行标签找一个下拉控件；可选地改成某个值（不按序号找，避免上下一加行就点错） */
      const selectByLabel = async (label, setTo) =>
        evalJs(
          c,
          `(() => {
             const row = [...document.querySelectorAll('.pcfg-row')].find((r) => (r.textContent || '').includes(${JSON.stringify(label)}))
             const sel = row && row.querySelector('select')
             if (!sel) return null
             const labels = [...sel.options].map((o) => o.textContent.trim())
             if (${JSON.stringify(setTo)} !== null) {
               const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
               setter.call(sel, ${JSON.stringify(setTo)})
               sel.dispatchEvent(new Event('change', { bubbles: true }))
             }
             return { value: sel.value, labels }
           })()`,
        )
      const panSelect = (setTo) => selectByLabel('平移方式', setTo)
      const rowLeadSelect = (setTo) => selectByLabel('行末提前', setTo)

      await openLocalTab()
      // adj1094：**默认平移方式已改成"按拍"**（新装/没有任何配置时）
      const initialPan = await panSelect(null)
      check(
        'adj1094 默认平移方式 = **按拍**（没有存过这个键时）',
        initialPan?.value === 'beat',
        JSON.stringify(initialPan),
      )
      const first = await panSelect('follow')
      check(
        'adj1089 设置 → 本机 的「平移方式」下拉有三项：跟随（4/5→1/5）/ 按拍 / 按小节',
        first?.labels?.length === 3 &&
          first.labels[0].includes('跟随') &&
          first.labels[0].includes('4/5') &&
          first.labels[1] === '按拍' &&
          first.labels[2] === '按小节',
        JSON.stringify(first),
      )
      await sleep(300)
      const stored = await evalJs(c, `localStorage.getItem('ijipu.panMode')`)
      check('adj1089 选「跟随」⇒ 真的写进本机偏好（`ijipu.panMode = follow`）', stored === 'follow', String(stored))

      // adj1094：行末提前平移量（默认半拍、5 档）
      const leadInit = await rowLeadSelect(null)
      check(
        'adj1094 「行末提前」下拉默认 **0.5 拍**、共 5 档（0 / 0.5 / 1 / 1.5 / 2）',
        leadInit?.value === '0.5' &&
          leadInit.labels.length === 5 &&
          leadInit.labels[0].includes('0 拍') &&
          leadInit.labels[4].includes('2 拍'),
        JSON.stringify(leadInit),
      )
      await rowLeadSelect('1')
      await sleep(250)
      const leadStored = await evalJs(c, `localStorage.getItem('ijipu.rowLeadBeats')`)
      check('adj1094 选 1 拍 ⇒ 真的落盘（`ijipu.rowLeadBeats = 1`）', leadStored === '1', String(leadStored))

      // 重载：两项 L1 偏好都要记住，并且界面上的下拉要显示回来
      await c.send('Page.reload')
      await sleep(600)
      await waitFor(c, `!!document.querySelector('.editor-main textarea')`, '重载后应用首屏')
      await openLocalTab()
      const after = await panSelect(null)
      const leadAfter = await rowLeadSelect(null)
      check(
        'adj1089/adj1094 重载后两项都记住（平移方式=跟随、行末提前=1 拍）',
        after?.value === 'follow' && leadAfter?.value === '1',
        JSON.stringify({ pan: after?.value, lead: leadAfter?.value }),
      )
      // 恢复默认（按拍 / 半拍），不影响后面的用例
      await panSelect('beat')
      await rowLeadSelect('0.5')
      await sleep(250)
      const back = await evalJs(c, `({ pan: localStorage.getItem('ijipu.panMode'), lead: localStorage.getItem('ijipu.rowLeadBeats') })`)
      check(
        'adj1094 恢复默认也真的生效（按拍 / 0.5 拍）',
        back?.pan === 'beat' && back?.lead === '0.5',
        JSON.stringify(back),
      )
    }

    console.log('[verify-app-ui] adj977：已安装手机 PWA 的标题不重复应用名')
    {
      const boot = async (label) => {
        await c.send('Page.reload')
        await sleep(600)
        await waitFor(c, `!!document.querySelector('.editor-main textarea')`, `重载后应用首屏（${label}）`)
        await sleep(300)
        return await evalJs(
          c,
          `({ title: document.title, standalone: (() => { try { return matchMedia('(display-mode: standalone)').matches } catch { return null } })(), coarse: matchMedia('(pointer: coarse)').matches })`,
        )
      }
      // 手机视口 + 触屏（⇒ `(pointer: coarse)` 为真）
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      // ① 装成"已安装 PWA" ⇒ 标题只放文件名
      const fake = await c.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
          const orig = window.matchMedia.bind(window)
          window.matchMedia = (q) => /display-mode:\\s*standalone/.test(String(q))
            ? { matches: true, media: String(q), onchange: null, addEventListener() {}, removeEventListener() {},
                addListener() {}, removeListener() {}, dispatchEvent() { return false } }
            : orig(q)
        })()`,
      })
      const pwa = await boot('已安装 PWA')
      check(
        'adj978 **已安装手机 PWA**（安卓 WebAPK）：标题**只有文件名**（`xx.jps`）、不带应用名 —— 那层标题栏自己会拼 `爱记谱 iJipu`，我们再带就重复了',
        pwa.title.endsWith('.jps') && !pwa.title.includes('爱记谱 iJipu') && pwa.standalone === true && pwa.coarse === true,
        JSON.stringify(pwa),
      )
      // ② 撤掉伪造 + 退回桌面浏览器 ⇒ **同一个标题**（不再按宿主分档：应用名交给各层外壳自己决定要不要显示）
      await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: fake.identifier })
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      const desk = await boot('桌面浏览器')
      check(
        'adj978 **不分档（负对照）**：桌面浏览器的标题与 PWA 档**完全一致**（都是文件名、都不含应用名）—— 证明 `adj977` 那套"按宿主决定带不带应用名"已经删掉',
        desk.standalone === false &&
          desk.title === pwa.title &&
          desk.title.endsWith('.jps') &&
          !desk.title.includes('爱记谱 iJipu'),
        JSON.stringify({ 桌面: desk, PWA: pwa }),
      )
    }

    /**
     * adj1264（M3）：连续动态谱**对拍台**（横滚）。
     *
     * 源码级断言拦不住的三件事，这里真点一遍：
     *  ① 入口在试听栏点得开、台面真的渲染（面板/预览画布都在，不是白屏）；
     *  ② 没有视频时**纯色兜底**，画布上真的有谱带墨迹（不是一片黑）——负向判据；
     *  ③ **视频解码失败必须有明确提示**（喂一个假 mp4），不许静默黑屏。
     */
    console.log('[verify-app-ui] adj1264：连续动态谱对拍台（横滚）')
    {
      /**
       * adj1267：给这份样例谱加**两段歌词**——台面的歌词开关与"多段按遍次换行"要有东西可验。
       * 两段字完全不同，条带上画的是哪一段一眼能对上（源码级判据在 smoke 里）。
       * adj1268/adj1269：再加一条跨小节连音线 `( 1 2 | 3 4 )` 与一条跨小节渐强 `6< … 3!`，
       * 让"号画在线上方""线跨过小节线"这两件在真浏览器里也走一遍（截图核对用 `IJIPU_SHOT`）。
       */
      const syncCode = `V: 1.0\nB: 连续谱\nQ: ( 1 2 | 3 4 ) 5 6< | 7 1' 2 3! | 4 5 6 7 |\nC: 一 二 三 四 五 六 七 八 九 十 百 千 万 亿 兆 京\nC: 甲 乙 丙 丁 戊 己 庚 辛 壬 癸 子 丑 寅 卯 辰 巳\n`
      await c.send('Page.navigate', { url: `${origin}/app/?jps=${encodeURIComponent(syncCode)}` })
      await waitFor(c, `!!document.querySelector('.app')`, '应用首屏（连续谱用例）')
      await sleep(800)
      const linearTab = await evalJs(
        c,
        `(() => {
          const b = [...document.querySelectorAll('.topbar-btn')].find((el) => (el.textContent || '').includes('试听'))
          if (!b) return 'no-tab'
          b.click()
          return 'ok'
        })()`,
      )
      check('adj1264 顶栏「试听」点得开（连续谱用例）', linearTab === 'ok', linearTab)
      await waitFor(c, `!!document.querySelector('.playback-actions')`, '试听面板（连续谱用例）')
      const linearClicked = await evalJs(
        c,
        `(() => {
          const b = [...document.querySelectorAll('.playback-actions .btn')].find((el) => (el.textContent || '').includes('连续动态谱'))
          if (!b) return 'no-btn'
          b.click()
          return 'ok'
        })()`,
      )
      check('adj1264 试听栏里有「连续动态谱（横滚）」入口（桌面/开发态）', linearClicked === 'ok', linearClicked)
      if (linearClicked === 'ok') {
        await waitFor(c, `!!document.querySelector('.linear-panel')`, '连续谱台面出现')
        const linearUi = await evalJs(
          c,
          `(() => {
            const p = document.querySelector('.linear-panel')
            const r = p ? p.getBoundingClientRect() : null
            const cv = document.querySelector('[data-role="linear-stage"]')
            return {
              panel: !!p,
              w: r ? Math.round(r.width) : 0,
              h: r ? Math.round(r.height) : 0,
              canvas: !!cv,
              cw: cv ? cv.width : 0,
              ch: cv ? cv.height : 0,
              wave: !!document.querySelector('[data-role="linear-wave"]'),
            }
          })()`,
        )
        check(
          'adj1264 台面真的渲染出来（面板有尺寸、预览画布 + 波形画布都在；不是白屏）',
          linearUi.panel && linearUi.w > 600 && linearUi.h > 300 && linearUi.canvas && linearUi.cw >= 100 && linearUi.ch >= 100 && linearUi.wave,
          JSON.stringify(linearUi),
        )
        // 谱带是异步光栅的（SVG → 位图块），等它出来再数墨迹像素
        await sleep(1800)
        /**
         * 画出来的东西要**亲眼看**（`adj1263` 的教训：四条断言全绿、肉眼看才现形的硬伤）。
         * 设 `IJIPU_SHOT=<png 路径>` 就把台面画布存一张图，人工核对用；平时不写盘。
         */
        if (process.env.IJIPU_SHOT) {
          const dataUrl = await evalJs(c, `document.querySelector('[data-role="linear-stage"]').toDataURL('image/png')`)
          writeFileSync(process.env.IJIPU_SHOT, Buffer.from(String(dataUrl).split(',')[1] ?? '', 'base64'))
          console.log(`  （已截图：${process.env.IJIPU_SHOT}）`)
        }
        const ink = await evalJs(
          c,
          `(() => {
            const cv = document.querySelector('[data-role="linear-stage"]')
            if (!cv) return -1
            const g = cv.getContext('2d')
            const d = g.getImageData(0, 0, cv.width, cv.height).data
            let bright = 0
            for (let i = 0; i < d.length; i += 4) {
              if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) bright++
            }
            return bright
          })()`,
        )
        check(
          'adj1264 没有视频 ⇒ 纯色兜底，画布上真有谱带墨迹（负向判据：不是一片黑）',
          ink > 200,
          `亮像素 ${ink}`,
        )
        check(
          'adj1264 台面写明"没有视频：用纯色背景"（兜底不是静默的）',
          await evalJs(c, `document.body.innerText.includes('没有视频：用纯色背景')`),
          '',
        )
        /**
         * adj1267：歌词开关 + 多段歌词（真点一遍）。
         *
         * 判据用"离底色的像素数"而不是"白色像素数"：`adj1267` 起关掉歌词**不缩谱带**
         * （`height` 与音符几何都不变）⇒ 画布上除歌词外一字不差，墨迹像素必然变少。
         */
        const lyricInk = `(() => {
          const cv = document.querySelector('[data-role="linear-stage"]')
          const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
          let n = 0
          for (let i = 0; i < d.length; i += 4) {
            if (Math.abs(d[i] - 16) + Math.abs(d[i + 1] - 16) + Math.abs(d[i + 2] - 20) > 60) n++
          }
          return n
        })()`
        const lyricsUi = await evalJs(
          c,
          `(() => {
            const box = document.querySelector('[data-role="linear-lyrics"]')
            return {
              box: !!box,
              checked: box ? box.checked : null,
              multi: !!document.querySelector('[data-role="linear-lyrics-multi"]'),
              hint: document.body.innerText.includes('这首歌有 2 段歌词'),
            }
          })()`,
        )
        check(
          'adj1267 台面有「歌词」开关（默认勾上），两段词的谱会写出"这首歌有 2 段歌词"',
          lyricsUi.box && lyricsUi.checked === true && lyricsUi.multi && lyricsUi.hint,
          JSON.stringify(lyricsUi),
        )
        const inkWithLyrics = Number(await evalJs(c, lyricInk))
        await evalJs(c, `(document.querySelector('[data-role="linear-lyrics"]')?.click(), true)`)
        await sleep(1800)
        const inkNoLyrics = Number(await evalJs(c, lyricInk))
        check(
          'adj1267 关掉歌词后画布上真的少了一层字（谱带其余部分不变 ⇒ 墨迹像素变少）',
          inkNoLyrics < inkWithLyrics && inkWithLyrics - inkNoLyrics > 300,
          `墨迹像素 ${inkWithLyrics} → ${inkNoLyrics}`,
        )
        // 再打开（开关不是单向的），免得后面的用例在"没有歌词"的画面上跑
        await evalJs(c, `(document.querySelector('[data-role="linear-lyrics"]')?.click(), true)`)
        await sleep(1200)
        const inkBack = Number(await evalJs(c, lyricInk))
        check(
          'adj1267 再打开 ⇒ 歌词回来（同一个开关来回都生效）',
          inkBack >= inkWithLyrics * 0.95,
          `${inkNoLyrics} → ${inkBack}（原 ${inkWithLyrics}）`,
        )
        /**
         * adj1268（用户 2026-11-09）：「小节号」默认不画，勾上后画在小节线正上方。
         * 判据同样用墨迹像素：序号框 + 数字是实打实画上去的，像素必然变多。
         */
        const numUi = await evalJs(
          c,
          `(() => {
            const box = document.querySelector('[data-role="linear-barnumbers"]')
            return { box: !!box, checked: box ? box.checked : null }
          })()`,
        )
        check('adj1268 台面有「小节号」开关且默认不勾（P3：默认不画）', numUi.box && numUi.checked === false, JSON.stringify(numUi))
        const inkBeforeNums = Number(await evalJs(c, lyricInk))
        await evalJs(c, `(document.querySelector('[data-role="linear-barnumbers"]')?.click(), true)`)
        await sleep(1800)
        const inkWithNums = Number(await evalJs(c, lyricInk))
        if (process.env.IJIPU_SHOT) {
          const shot2 = String(process.env.IJIPU_SHOT).replace(/\.png$/, '') + '-bars.png'
          const dataUrl2 = await evalJs(c, `document.querySelector('[data-role="linear-stage"]').toDataURL('image/png')`)
          writeFileSync(shot2, Buffer.from(String(dataUrl2).split(',')[1] ?? '', 'base64'))
          console.log(`  （已截图：${shot2}）`)
        }
        check(
          'adj1268 勾上「小节号」后画布上真的多出一排序号（不是只改了复选框）',
          inkWithNums > inkBeforeNums + 150,
          `墨迹像素 ${inkBeforeNums} → ${inkWithNums}`,
        )
        // 关回去：后面的用例仍在"不画小节号"的画面上跑
        await evalJs(c, `(document.querySelector('[data-role="linear-barnumbers"]')?.click(), true)`)
        await sleep(900)
        /**
         * adj1265（M4）：主题编辑器与片头片尾卡——真浏览器里点一遍。
         * 纯函数/带 sidecar 的判据在 smoke 里；这里只验"界面真的接上了、改动真的进了画布"。
         */
        const styleToggle = await evalJs(
          c,
          `(() => {
            const b = document.querySelector('[data-role="linear-style-toggle"]')
            if (!b) return 'no-btn'
            b.click()
            return 'ok'
          })()`,
        )
        await sleep(350)
        const styleUi = await evalJs(
          c,
          `(() => {
            const row = document.querySelector('[data-role="linear-style"]')
            return {
              open: !!row,
              colors: row ? row.querySelectorAll('input[type="color"]').length : 0,
              sliders: row ? row.querySelectorAll('input[type="range"]').length : 0,
            }
          })()`,
        )
        check(
          'adj1265 主题编辑器能打开：5 个取色器 + 3 条滑条（描边粗细/阴影模糊/色块浓淡）',
          styleToggle === 'ok' && styleUi.open && styleUi.colors === 5 && styleUi.sliders === 3,
          JSON.stringify(styleUi),
        )
        // 改「墨色」为纯绿：画布上的谱带字应当真的变绿（不是只改了输入框）
        const whiteBefore = await evalJs(
          c,
          `(() => {
            const cv = document.querySelector('[data-role="linear-stage"]')
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
            let n = 0
            for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++
            return n
          })()`,
        )
        await evalJs(
          c,
          `(() => {
            const input = document.querySelectorAll('[data-role="linear-style"] input[type="color"]')[0]
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(input, '#00ff00')
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          })()`,
        )
        await sleep(1600)
        const greenAfter = await evalJs(
          c,
          `(() => {
            const cv = document.querySelector('[data-role="linear-stage"]')
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
            let n = 0
            for (let i = 0; i < d.length; i += 4) if (d[i] < 110 && d[i + 1] > 190 && d[i + 2] < 110) n++
            return n
          })()`,
        )
        check(
          'adj1265 改「墨色」后画布上的字真的变绿（预览与编辑器同一个样式入口）',
          greenAfter > 100 && whiteBefore > 100,
          `白 ${whiteBefore} → 绿 ${greenAfter}`,
        )
        // 恢复预设：自定义项清掉，按钮自己变灰
        await evalJs(
          c,
          `[...document.querySelectorAll('.linear-panel .btn')].find((b) => (b.textContent || '').includes('恢复预设'))?.click(), true`,
        )
        await sleep(1200)
        check(
          'adj1265 「恢复预设」清掉自定义（按钮随即不可点）',
          await evalJs(
            c,
            `(() => {
              const b = [...document.querySelectorAll('.linear-panel .btn')].find((el) => (el.textContent || '').includes('恢复预设'))
              return !!b && b.disabled
            })()`,
          ),
          '',
        )
        // 片头片尾卡：勾上后总长 +4.5s、并写出卡片模板与时长
        const totalBefore = await evalJs(c, `document.querySelector('[data-role="linear-total"]')?.textContent ?? ''`)
        await evalJs(c, `document.querySelector('[data-role="linear-cards"]')?.click(), true`)
        await sleep(1500)
        const cardsUi = await evalJs(
          c,
          `(() => ({
            total: document.querySelector('[data-role="linear-total"]')?.textContent ?? '',
            hint: document.body.innerText.includes('片头 2.0s + 片尾 2.5s'),
            template: !!document.querySelector('.linear-panel select[aria-label="卡片模板"]'),
          }))()`,
        )
        check(
          'adj1265 勾「带片头片尾」后总长变长、写出片头/片尾时长与卡片模板下拉',
          cardsUi.total !== totalBefore && cardsUi.hint && cardsUi.template,
          `${totalBefore} → ${cardsUi.total}`,
        )
        /**
         * adj1266（用户 2026-11-09 拍板「配色随卡片模板」）：真浏览器里换模板，看谱带配色跟着换。
         * 这里读**编辑器里的墨色输入框**（它就是 `linearStripStyle.ink`），比数画布像素稳：
         * 深色视频/底色下"墨字 + 白描边"与"白字 + 黑描边"的像素数受抗锯齿影响，不适合当唯一判据。
         */
        const themeUi = await evalJs(
          c,
          `(() => {
            const sel = document.querySelector('[data-role="linear-theme"]')
            const ink = document.querySelectorAll('[data-role="linear-style"] input[type="color"]')[0]
            return {
              value: sel ? sel.value : '',
              label: sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '',
              ink: ink ? ink.value : '',
              template: !!document.querySelector('.linear-panel select[aria-label="卡片模板"]'),
            }
          })()`,
        )
        check(
          'adj1266 配色默认是「跟随卡片模板」（下拉第一项带当前模板名，不是某套固定预设）',
          themeUi.value === 'auto' && themeUi.label.startsWith('跟随卡片模板'),
          JSON.stringify(themeUi),
        )
        const setSelect = (sel, val) => `(() => {
            const s = document.querySelector(${JSON.stringify(sel)})
            if (!s) return 'no-select'
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
            setter.call(s, ${JSON.stringify(val)})
            s.dispatchEvent(new Event('change', { bubbles: true }))
            return s.value
          })()`
        const toBrand = await evalJs(c, setSelect('.linear-panel select[aria-label="卡片模板"]', 'brand'))
        await sleep(700)
        const brandInk = await evalJs(
          c,
          `(() => {
            const ink = document.querySelectorAll('[data-role="linear-style"] input[type="color"]')[0]
            return ink ? ink.value : ''
          })()`,
        )
        check(
          'adj1266 换成深空蓝模板 ⇒ 墨色变成白字（配色真的跟着卡片调色板走）',
          toBrand === 'brand' && brandInk === '#ffffff',
          `${toBrand} / ${brandInk}`,
        )
        const toPaper = await evalJs(c, setSelect('.linear-panel select[aria-label="卡片模板"]', 'paper'))
        await sleep(700)
        const paperUi = await evalJs(
          c,
          `(() => {
            const sel = document.querySelector('[data-role="linear-theme"]')
            const ink = document.querySelectorAll('[data-role="linear-style"] input[type="color"]')[0]
            return {
              label: sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '',
              ink: ink ? ink.value : '',
            }
          })()`,
        )
        check(
          'adj1266 换成纸面模板 ⇒ 谱带墨色跟着变成卡片的墨字、下拉项也写明「纸面」',
          toPaper === 'paper' && paperUi.ink === '#241f19' && paperUi.label.includes('纸面'),
          `${toPaper} / ${JSON.stringify(paperUi)}`,
        )
        // 明确指定一套预设 ⇒ 不跟卡片；再选回 auto ⇒ 又跟卡片
        await evalJs(c, setSelect('[data-role="linear-theme"]', 'gold'))
        await sleep(500)
        const goldInk = await evalJs(c, `(() => {
            const ink = document.querySelectorAll('[data-role="linear-style"] input[type="color"]')[0]
            return ink ? ink.value : ''
          })()`)
        await evalJs(c, setSelect('[data-role="linear-theme"]', 'auto'))
        await sleep(500)
        const backInk = await evalJs(c, `(() => {
            const ink = document.querySelectorAll('[data-role="linear-style"] input[type="color"]')[0]
            return ink ? ink.value : ''
          })()`)
        check(
          'adj1266 显式选「金」就按金色的字（不跟卡片）；选回「跟随卡片模板」又回到纸面墨字',
          goldInk === '#ffd36b' && backInk === '#241f19',
          `${goldInk} → ${backInk}`,
        )
        await evalJs(c, setSelect('.linear-panel select[aria-label="卡片模板"]', 'brand'))
        await sleep(500)
        await evalJs(c, `document.querySelector('[data-role="linear-cards"]')?.click(), true`)
        await sleep(500)
        await evalJs(c, `document.querySelector('[data-role="linear-style-toggle"]')?.click(), true`)
        await sleep(300)
        // ③ 喂一个假视频：解码失败必须明确提示，画布与对拍不受影响
        const fakeMp4 = path.join(DL, 'fake-video.mp4')
        writeFileSync(fakeMp4, Buffer.from('this is not a video file at all'))
        await c.send('DOM.enable')
        const domRoot = await c.send('DOM.getDocument', { depth: -1 })
        const inputNode = await c.send('DOM.querySelector', {
          nodeId: domRoot.root.nodeId,
          selector: 'input[accept="video/*"]',
        })
        check('adj1264 台面里有视频导入框（隐藏的 file input）', inputNode.nodeId > 0, String(inputNode.nodeId))
        if (inputNode.nodeId > 0) {
          await c.send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [fakeMp4] })
          await waitFor(c, `document.body.innerText.includes('打不开这个视频')`, '视频解码失败的明确提示', 80)
          const msg = await evalJs(c, `(document.body.innerText.match(/打不开这个视频[^\\n]*/) ?? [''])[0]`)
          check('adj1264 视频解码失败有明确提示（不许静默黑屏）', msg.includes('打不开这个视频'), msg)
          check(
            'adj1264 解码失败不连累谱面（台面还在，还能继续对拍/选段）',
            await evalJs(c, `!!document.querySelector('[data-role="linear-stage"]') && !!document.querySelector('.linear-panel')`),
            '',
          )
        }
        // 关掉（Esc）——App 的全局 ESC 在捕获阶段收口，这里验"层真的没了"
        for (const type of ['keyDown', 'keyUp']) {
          await c.send('Input.dispatchKeyEvent', {
            type,
            key: 'Escape',
            code: 'Escape',
            windowsVirtualKeyCode: 27,
            nativeVirtualKeyCode: 27,
          })
        }
        await waitFor(c, `!document.querySelector('.linear-panel')`, '连续谱台面关闭')
        check('adj1264 台面关得掉（Esc），底下的应用还在', true)
      }
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


