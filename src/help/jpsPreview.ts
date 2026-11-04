/**
 * help/jpsPreview.ts — ` ```jps ` 块的「脚本 / 预览」渲染与挂载（adj882）
 *
 * 两个消费方共用这一个模块，行为必然一致：
 *   · 官网文档页（`/manual/`、`/syntax/`）—— Markdown 里的每个 ` ```jps ` 块都变成可切换的小组件；
 *   · 官网首页「看看它长什么样」—— 同一套 DOM 结构，外面多一排示例按钮。
 *
 * ## 为什么引擎按需加载
 *
 * 引擎 chunk 约 204KB（gzip 约 68KB）。文档页里可能有几十个 ` ```jps ` 块，
 * 但用户不会每个都点「预览」⇒ **点预览时才 `import()`**，不点的人一分钱不花。
 *
 * ## 裁切与缩放：沿用**插件**的代码块参数
 *
 * `m=` 显示范围、`z=` 缩放（口径见 `markdown.ts` 的 `parseJpsInfo`），
 * 裁切用引擎自己的 `inkBoxOfLayout` + `rangeBox` + `applyRangeToSvg` ——
 * 与 Obsidian 插件、应用导出**同源**，不在这里另写几何。
 *
 * ## adj914：`playground` 可调示例也挂在这里
 *
 * 「代码块参数」那一节要有"调一下就看变化"的控件（用户要求）。控件只是**把选择写回块参数**
 * 再走同一个重排路径（`previewJpsBlock`）——没有第二份渲染器、也没有第二套几何 ⇒
 * 文档里写 ` ```jps v=w z=150 playground ` 就是可调示例，其它块完全不受影响。
 */
import type { JpsBlockParams } from './markdown'
// 组件样式只有这一份：官网文档页、官网首页、**应用内帮助**三处共用（见该文件的说明）
import './jpsPreview.css'

type EngineModule = typeof import('@ijipu/engine')

/** 引擎模块只在第一次真正要渲染时加载，之后复用 */
let enginePromise: Promise<EngineModule> | null = null
function loadEngine(): Promise<EngineModule> {
  enginePromise ??= import('@ijipu/engine')
  return enginePromise
}

export interface JpsRenderResult {
  /** 每页一个 SVG（已按 `m=` 裁好） */
  svgs: string[]
  /** 可直接显示给用户的问题行（错误阻断渲染；告警只提示） */
  problems: string[]
}

/** 把引擎的诊断行整理成"第 N 行：消息（正确写法…）" */
function formatProblems(rows: readonly { line: number; message: string; hint?: string }[], max: number): string[] {
  return rows.slice(0, max).map((r) => `${r.line > 0 ? `第 ${r.line} 行：` : ''}${r.message}${r.hint ? `（正确写法：${r.hint}）` : ''}`)
}

/**
 * 渲染一段 `.jps` 并按 `m=` 裁切。
 * 错误级问题**不渲染**（与应用一致：错误阻断渲染、告警只提示）。
 */
export async function renderJps(src: string, params: JpsBlockParams): Promise<JpsRenderResult> {
  const e = await loadEngine()
  const parsed = e.parseJps(src)
  const { errors, warnings } = e.splitParseIssues(parsed)
  if (errors.length > 0) return { svgs: [], problems: formatProblems(errors, 3) }
  const cfg = e.mergeJpsConfig(src, e.defaultPageConfig)
  const layout = e.layoutScore(parsed, cfg)
  const raw = e.renderScoreToSvg(layout)
  const svgs = raw.map((svg, i) => {
    if (params.mode === 'p') return svg // 整页：原样（含页边距）
    const page = layout.pages[i]
    if (!page) return svg
    const ink = e.inkBoxOfLayout(layout, i)
    if (params.mode === 'w') {
      // 满宽：只裁掉左右页边距（上下保留整页高度），内容横向更大
      if (!ink) return svg
      return e.applyRangeToSvg(svg, { x: ink.x, y: 0, w: ink.w, h: page.height })
    }
    // 谱面（默认）：裁到墨迹 ± 2px；rangeBox 自带三重兜底（量不到 / 退化 / 近整页 ⇒ 退回整页）
    const out = e.rangeBox({ range: 'score', pageW: page.width, pageH: page.height, ink: ink ?? undefined })
    return e.applyRangeToSvg(svg, out.box)
  })
  const problems = formatProblems(warnings, 2)
  return { svgs, problems }
}

/** 读块上的参数（`data-jps-mode` / `data-jps-zoom`，由 Markdown 渲染器写上去） */
function paramsOf(block: HTMLElement): JpsBlockParams {
  const mode = block.dataset.jpsMode
  const zoomRaw = block.dataset.jpsZoom ?? '100'
  return {
    mode: mode === 'w' || mode === 'p' ? mode : 's',
    zoom: zoomRaw === '*' ? '*' : Number(zoomRaw) || 100,
  }
}

/** 块的三个部位（缺任何一个就认为结构不完整，不挂交互） */
interface BlockDom {
  code: HTMLElement
  host: HTMLElement
  msg: HTMLElement
  tabs: HTMLButtonElement[]
}

function domOf(block: HTMLElement): BlockDom | null {
  const code = block.querySelector<HTMLElement>('.jps-block-code')
  const host = block.querySelector<HTMLElement>('.jps-block-preview')
  if (!code || !host) return null
  let msg = block.querySelector<HTMLElement>('.jps-block-msg')
  if (!msg) {
    msg = document.createElement('div')
    msg.className = 'jps-block-msg'
    host.after(msg)
  }
  return { code, host, msg, tabs: [...block.querySelectorAll<HTMLButtonElement>('[data-jps-tab]')] }
}

/** 按 `z=` 把结果宽度钉住：数字 = 自然宽 × z/100；`*` = 交给 CSS 铺满容器 */
function applyZoom(host: HTMLElement, zoom: number | '*'): void {
  if (zoom === '*') {
    host.style.removeProperty('--jps-w')
    return
  }
  const first = host.querySelector('svg')
  const natural = first ? Number(first.getAttribute('width')) || 0 : 0
  if (natural > 0) host.style.setProperty('--jps-w', `${Math.round((natural * zoom) / 100)}px`)
  else host.style.removeProperty('--jps-w')
}

/** 渲染一个块（按当前 `data-jps-*` 参数；同一份源码 + 同一套参数不重复渲染） */
function refreshBlock(block: HTMLElement, force = false): void {
  const dom = domOf(block)
  if (!dom) return
  const src = dom.code.textContent ?? ''
  const params = paramsOf(block)
  const key = `${params.mode}|${params.zoom}|${src}`
  if (!force && block.dataset.jpsRendered === key) return
  block.dataset.jpsRendered = key
  dom.msg.textContent = '正在渲染…'
  dom.msg.dataset.kind = 'info'
  void renderJps(src, params)
    .then(({ svgs, problems }) => {
      dom.host.innerHTML = svgs.join('\n')
      applyZoom(dom.host, params.zoom)
      if (problems.length > 0) {
        dom.msg.textContent = `⚠ ${problems.join('　')}`
        dom.msg.dataset.kind = 'warn'
      } else {
        dom.msg.textContent = ''
        dom.msg.dataset.kind = 'ok'
      }
    })
    .catch((err: unknown) => {
      // 引擎加载失败（离线且没缓存、产物缺失）——如实说明，不假装渲染成功
      dom.host.innerHTML = ''
      dom.msg.textContent = `渲染不出来：${err instanceof Error ? err.message : String(err)}`
      dom.msg.dataset.kind = 'warn'
    })
}

/** 源码区用与曲库详情相同的 highlightModel 分词 + hl-* 色 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

function paintSource(block: HTMLElement): void {
  const codeEl = block.querySelector<HTMLElement>('.jps-block-code code')
  if (!codeEl) return
  const src = codeEl.textContent ?? ''
  if (codeEl.dataset.jpsPainted === src) return
  void loadEngine()
    .then((e) => {
      if ((codeEl.textContent ?? '') !== src) return
      const hl = e.highlightModel(src)
      codeEl.innerHTML = hl.lines
        .map((line) => {
          const inner = line.tokens
            .map((t) => (t.cls === 'plain' ? escapeHtml(t.text) : `<span class="hl-${t.cls}">${escapeHtml(t.text)}</span>`))
            .join('')
          return `<span class="src-line">${inner}</span>`
        })
        .join('\n')
      codeEl.dataset.jpsPainted = src
    })
    .catch(() => {
      /* 引擎不可用：保留纯文本源码 */
    })
}

/** 切「源码 / 预览」两个标签（切到预览才真的渲染——引擎按需加载） */
function showTab(block: HTMLElement, tab: 'code' | 'preview'): void {
  const dom = domOf(block)
  if (!dom) return
  for (const b of dom.tabs) {
    const on = b.dataset.jpsTab === tab
    b.classList.toggle('active', on)
    b.setAttribute('aria-selected', on ? 'true' : 'false')
  }
  dom.code.hidden = tab !== 'code'
  dom.host.hidden = tab !== 'preview'
  dom.msg.hidden = tab !== 'preview'
  if (tab === 'code') paintSource(block)
  else refreshBlock(block)
}

/** 给一个块挂交互；已挂过的打标记跳过（幂等，可重复调用） */
function mountBlock(block: HTMLElement): void {
  if (block.dataset.jpsMounted === '1') return
  const dom = domOf(block)
  if (!dom) return
  block.dataset.jpsMounted = '1'
  for (const b of dom.tabs) {
    b.addEventListener('click', () => showTab(block, b.dataset.jpsTab === 'preview' ? 'preview' : 'code'))
  }
  // 初始：显示「预览」（用户要求先看效果；源码切过去时再上色）
  showTab(block, 'preview')
}

/**
 * adj914：给「可调示例」（` ```jps … playground `，见 `markdown.ts` 的 `jpsPlaygroundHtml`）挂控件。
 *
 * 控件的**唯一职责**是把选择写回内层 `.jps-block` 的 `data-jps-mode` / `data-jps-zoom`，
 * 然后走**同一个** `previewJpsBlock()` 重排 —— 不在这里算任何几何、也不另造预览节点
 * （那会变成第二份渲染器，两端迟早漂）。
 *
 * 三个消费方（官网文档页 / 官网首页 / 应用内帮助）共用这一份挂载逻辑。
 */
function mountJpsPlayground(root: HTMLElement): void {
  if (root.dataset.jpsPgMounted === '1') return
  const block = root.querySelector<HTMLElement>('.jps-block')
  const view = root.querySelector<HTMLSelectElement>('[data-jps-view]')
  const range = root.querySelector<HTMLInputElement>('[data-jps-zoom-range]')
  const num = root.querySelector<HTMLInputElement>('[data-jps-zoom-num]')
  const auto = root.querySelector<HTMLInputElement>('[data-jps-auto]')
  const reset = root.querySelector<HTMLButtonElement>('[data-jps-reset]')
  // 结构不全（老产物 / 别人手写的 DOM）⇒ 一个都不挂，绝不留"点不动的控件"
  if (!block || !view || !range || !num || !auto || !reset) return
  root.dataset.jpsPgMounted = '1'
  /** 初值 = 文档那一行写的 `v=` / `z=`（`markdown.ts` 已经写在块上）——「重置」回到它 */
  const init = paramsOf(block)
  const sliderBounds = { min: Number(range.min) || 25, max: Number(range.max) || 300 }

  /** 把滑块/数字两个控件对齐到同一个值（滑块只覆盖常用段，越界只影响滑块外观） */
  const syncZoomWidgets = (z: number): void => {
    num.value = String(z)
    range.value = String(Math.min(sliderBounds.max, Math.max(sliderBounds.min, z)))
  }

  /**
   * 控件 → 块参数（**唯一**一处写这两个 `dataset` 的地方，两个入口共用 ⇒ 永不打架）。
   * 参数一变 `refreshBlock` 的缓存 key 就变了 ⇒ 真的重排（不是"看起来变了"）。
   */
  const applyControls = (): void => {
    const mode: JpsBlockParams['mode'] = view.value === 'w' || view.value === 'p' ? view.value : 's'
    const isAuto = auto.checked
    if (!isAuto) {
      const n = Number(num.value)
      syncZoomWidgets(Number.isFinite(n) ? Math.min(1000, Math.max(1, Math.round(n))) : 100)
    }
    range.disabled = isAuto
    num.disabled = isAuto
    block.dataset.jpsMode = mode
    block.dataset.jpsZoom = isAuto ? '*' : num.value
    previewJpsBlock(block)
  }

  view.addEventListener('change', applyControls)
  // 滑块 + 数字框：改任一个就把它同步给另一个，再重排（用户要的是"拉一下就看变化"）
  range.addEventListener('input', () => {
    num.value = range.value
    auto.checked = false
    applyControls()
  })
  // 数字框：清空重打时先不动（否则会抢着回写成 100，输入体验很糟）
  num.addEventListener('input', () => {
    if (num.value.trim() !== '') applyControls()
  })
  auto.addEventListener('change', applyControls)
  reset.addEventListener('click', () => {
    view.value = init.mode
    auto.checked = init.zoom === '*'
    if (init.zoom !== '*') syncZoomWidgets(init.zoom)
    applyControls()
  })

  /**
   * 首次渲染：**滚进视口才下引擎**（与"不点预览就不下那 68KB"同一条口径）——
   * 文档页上可能有好几处可调示例，不该在打开页面时全部加载。
   * 没抛 `IntersectionObserver` 的老浏览器直接渲染（功能优先，代价只是一次下载）。
   */
  const reveal = (): void => previewJpsBlock(block)
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        io.disconnect()
        reveal()
      },
      // 提前 160px 就开始渲染：用户滚到时已经出图，不会看到"空的等"
      { rootMargin: '160px' },
    )
    io.observe(root)
  } else {
    reveal()
  }
}

/**
 * 给 root 下所有还没挂过的 `.jps-block` / `.jps-playground` 挂上交互（正文渲染完后调一次）。
 *
 * ⚠ **顺序有意义**：先挂块本身（它会把初始标签切到「脚本」），再挂控件
 * （控件要把可调示例切到「预览」）—— 反过来的话，块的 `showTab(…, 'code')` 会把预览盖掉。
 */
export function mountJpsBlocks(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('.jps-block').forEach(mountBlock)
  root.querySelectorAll<HTMLElement>('.jps-playground').forEach(mountJpsPlayground)
}

/** 单块刷新（首页换示例后调用：源码变了，需要强制重渲染） */
export function refreshJpsBlock(block: HTMLElement): void {
  refreshBlock(block, true)
}

/** 主动切到「预览」（首页点示例时直接看效果） */
export function previewJpsBlock(block: HTMLElement): void {
  showTab(block, 'preview')
}
