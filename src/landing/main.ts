/**
 * landing/main.ts — 官网**介绍首页**的脚本（adj876）
 *
 * 设计取舍（为什么首页只做这么点事）：
 *   首页正文全部写在 `index.html` 里，不走 JS 渲染 —— 一是搜索引擎（尤其中文场景的百度）
 *   对不执行 JS 的抓取更友好，二是首屏不依赖 JS、没有"先白屏再出内容"的闪烁。
 *   所以这个文件的职责被刻意压到最小，只有六件事：
 *     ① 把品牌色注入 CSS 变量（色值只在 `brand/tokens.ts` 定义一处）；
 *     ② 填外部链接地址（GitHub / 下载 / 插件 —— 同样只在 tokens 里定义）；
 *     ③ 填版本号（`data-app-version` 占位，发版即自动更新）；
 *     ④ 一点交互：顶栏滚动加背景、窄屏菜单、赞赏弹层；
 *     ⑤ 「你以前用过 → 直接进应用」提示条；
 *     ⑥ adj930：等 CSS / 字体就绪后揭示**首屏启动层**（消灭"先出没格式的文字再闪一下"）。
 *   首页**没有**引入 React 或引擎，JS 体积保持在一个很小的量级。
 */
import { injectSiteColors, currentSiteMode, saveSiteMode, type SiteMode } from '../brand/siteVars'
import { fillExternalLinks } from '../brand/siteLinks'
// adj930（用户要求「先显示背景 + 一个转圈，等资源加载完再显示正文」）：
// 接管的时机与兜底见该文件头说明 —— 它等外链样式表 + 字体就绪后**只淡出透明度**再移除。
import { revealSiteBoot } from '../brand/siteBoot'
import { APP_VERSION } from '../brand/version'
import { LATEST_ADJ } from '../brand/adj'
import './landing.css'
// adj877：首页「自己改一段试试」区块（引擎按需加载，见该文件头说明）
import { mountPlayground } from './playground'

/**
 * 首页自己的存储键前缀。
 * 判定「以前用过」时要**排除**这一族键 —— 否则用户点一次"关闭提示"，
 * 首页自己写下的键就会被当成"用过应用"的证据，下次访问又弹出来。
 */
const SITE_KEY_PREFIX = 'ijipu.site.'
const TIP_DISMISSED_KEY = `${SITE_KEY_PREFIX}tipDismissed`

/**
 * 版本号占位符：`<b data-app-version>` 在首页出现三处 —— 顶栏品牌名右侧（adj971 用户要求：
 * 「版本信息显示在……官网首页的**左边**」）、首屏 Hero 小字、页脚。
 */
function fillVersion(): void {
  document.querySelectorAll('[data-app-version]').forEach((el) => {
    el.textContent = `v${APP_VERSION}`
  })
}

/** 页脚「调优 N」：数字只来自 brand/adj.ts 的 LATEST_ADJ */
function fillAdj(): void {
  document.querySelectorAll('[data-adj]').forEach((el) => {
    el.textContent = String(LATEST_ADJ)
  })
}

/** 顶栏：滚动过一点就加背景，避免内容从顶栏底下透出来 */
function bindTopbar(): void {
  const topbar = document.getElementById('topbar')
  if (!topbar) return
  const sync = () => topbar.classList.toggle('scrolled', window.scrollY > 8)
  sync()
  window.addEventListener('scroll', sync, { passive: true })
}

/** 窄屏菜单：点汉堡展开导航，点任一链接后收起 */
function bindBurger(): void {
  const burger = document.getElementById('burger')
  const nav = document.getElementById('nav')
  if (!burger || !nav) return
  const setOpen = (open: boolean) => {
    nav.classList.toggle('open', open)
    burger.setAttribute('aria-expanded', open ? 'true' : 'false')
  }
  burger.addEventListener('click', () => setOpen(!nav.classList.contains('open')))
  nav.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) setOpen(false)
  })
}

/** 赞赏弹层：用原生 `<dialog>`（无需第三方库，Esc 关闭是内建行为） */
function bindDonate(): void {
  const dlg = document.getElementById('donate') as HTMLDialogElement | null
  const open = document.getElementById('donate-open')
  if (!dlg || !open) return
  open.addEventListener('click', (e) => {
    // 保留 `href="#donate"` 作为无 JS 时的兜底（会跳到页面末尾的弹层锚点）
    e.preventDefault()
    dlg.showModal()
  })
  // 点遮罩（dialog 自身）也关闭 —— 原生行为只覆盖 Esc
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close()
  })
}

/**
 * adj881（用户要求）：**插图跟随深浅主题**——切到浅色时换成浅色主题下截的那套图。
 *
 * 为什么不用 `<picture>` + `media="(prefers-color-scheme: light)"`：
 * 那个媒体查询只反映**系统**偏好，而官网的主题是**用户点出来的**（存在 `ijipu.site.theme`），
 * 两者完全可以不一致（系统深色 + 用户选了浅色）⇒ 只能用 JS 换 `src`。
 *
 * 命名约定（与 `scripts/verify-site.mjs` 的截图输出一一对应，改一处要改两处）：
 *   `<名字>.webp`（深色） / `<名字>-light.webp`（浅色）
 * 参与切换的都是**应用界面截图**——只有应用也切成浅色主题时它们才该换。
 * 不参与的：分享卡 `og.png`，以及**没有任何 `data-shot`** 的图（示例区的谱面现在由引擎现场渲染，
 * 已经没有静态谱面图了 —— `demo-score.webp` 在 adj898 随两个区块的整合一并删除）。
 */
function applyShots(mode: SiteMode): void {
  document.querySelectorAll<HTMLImageElement>('img[data-shot]').forEach((img) => {
    const name = img.dataset.shot
    if (!name) return
    const next = mode === 'light' ? `/site/${name}-light.webp` : `/site/${name}.webp`
    // `img.src` 是绝对地址，用 endsWith 比；相同就别写，免得触发多余的加载判断
    if (!img.src.endsWith(next)) img.src = next
  })
}

/**
 * adj878（用户要求）：右上角的深浅主题开关。
 *
 * 两个图标由 CSS 按 `data-site-mode` 显示（**无 JS 时也显示正确的那个**），
 * 这里只做"点一下切过去 + 记住"。
 * 初始模式由 `<head>` 里那段内联脚本定好（防闪烁），这里读它并注入完整配色。
 */
function bindThemeToggle(): void {
  const btn = document.getElementById('theme-toggle')
  if (!btn) return
  btn.addEventListener('click', () => {
    const next: SiteMode = currentSiteMode() === 'light' ? 'dark' : 'light'
    injectSiteColors(next)
    saveSiteMode(next)
    // adj881：配色与插图一起换（用户口径"切浅色时插图也换成浅色的"）
    applyShots(next)
  })
}

/**
 * 「以前用过 → 直接进应用」提示条。
 *
 * 判据：localStorage 里有**应用**写入的 `ijipu.*` 键（草稿、主题、缩放…都是它写的），
 * 且用户没有手动关过这条提示。这样老用户回访首页能一键进应用，而第一次来的人
 * 不会被"你已经用过了"这种莫名其妙的话打扰。
 */
function bindReturningTip(): void {
  const tip = document.getElementById('tip')
  if (!tip) return
  let dismissed = false
  let visited = false
  try {
    dismissed = localStorage.getItem(TIP_DISMISSED_KEY) === '1'
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('ijipu.') && !k.startsWith(SITE_KEY_PREFIX)) {
        visited = true
        break
      }
    }
  } catch {
    // 无痕模式等禁用存储的环境：当作"没用过"，不弹提示（也绝不因此报错）
    return
  }
  if (!visited || dismissed) return
  tip.hidden = false
  document.getElementById('tip-close')?.addEventListener('click', () => {
    tip.hidden = true
    try {
      localStorage.setItem(TIP_DISMISSED_KEY, '1')
    } catch {
      /* 存不下就只关掉本次，不强求 */
    }
  })
}

/** 页脚总 PV：只读统计接口的公开总数；失败保留「—」，不显示假数据 */
async function fillVisitPV(): Promise<void> {
  const el = document.getElementById('site-pv')
  if (!el) return
  try {
    const r = await fetch('/api/pv', { cache: 'no-store' })
    if (!r.ok) return
    const data = (await r.json()) as { pv?: unknown }
    const pv = Number(data.pv)
    if (Number.isFinite(pv)) el.textContent = pv.toLocaleString('zh-CN')
  } catch {
    /* 统计不可用不影响首页 */
  }
}

/**
 * adj930：**第一件事**就是接管启动层（不是最后）。
 *
 * 理由：`revealSiteBoot` 的揭示是异步的（等 `load` 事件 / `fonts.ready`），而模块这一串
 * 同步初始化必须在**这一轮同步执行结束**前做完 —— 把接管放最前面，后面任何一步抛错
 * 都不会让用户对着转圈（那时链条照样会走到淡出）。
 *
 * ⚠ 首页正文是**静态写在 HTML 里**的（SEO / 首屏），所以这里没有"等正文注入"这一步；
 *   文档页要额外等正文（见 `docs/render.ts`）。
 */
revealSiteBoot()
// 主题：`<head>` 的内联脚本已经把模式定在 `<html>` 上（防闪烁），这里注入完整配色并接上开关
injectSiteColors(currentSiteMode())
// adj881：插图也要与主题一致（首屏就得对，不能等用户点一下才换）
applyShots(currentSiteMode())
bindThemeToggle()
fillExternalLinks()
fillVersion()
fillAdj()
bindTopbar()
bindBurger()
bindDonate()
bindReturningTip()
mountPlayground()
void fillVisitPV()
