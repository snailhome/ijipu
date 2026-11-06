/**
 * landing/playground.ts — 首页「看看它长什么样」区块（adj877 建、adj882 改）
 *
 * ## 为什么从"自己改一段"改成"切示例"
 *
 * 用户口径：首页放一个能编辑的输入框**没有意义** —— 真想改代码，直接进应用不更直接？
 * 首页要的是**直观感受**：给几个例子，切「脚本 / 预览」看这段代码长什么样。
 *
 * ## 数据源（2026-11-06 用户口径）
 *
 * 首页示例列表和源码也直接取线上 `scores/index.json`（tag 含「示例谱」的发布中乐谱），
 * 不再把 `scores-library` 的示例打包进 landing bundle。断网时用上次缓存；无缓存则提示联网。
 *
 * ## 渲染交给共用模块
 *
 * 「脚本 / 预览」的结构、引擎按需加载、`m=` / `z=` 裁切缩放，全部在 `help/jpsPreview.ts` 里
 * —— 与**文档页里的每个 ` ```jps ` 块**是同一份实现。
 */
import { loadOnlineScores, type OnlineScore } from '../samples/online'
import { mountJpsBlocks, previewJpsBlock } from '../help/jpsPreview'

export function mountPlayground(): void {
  const root = document.getElementById('playground')
  const block = document.getElementById('pg-block')
  const codeEl = block?.querySelector<HTMLElement>('.jps-block-code code')
  if (!root || !block || !codeEl) return

  // 挂上「脚本 / 预览」（与文档页同一套挂载逻辑）
  mountJpsBlocks(root)

  const bar = root.querySelector<HTMLElement>('.pg-samples')
  const openApp = document.getElementById('pg-open-app') as HTMLAnchorElement | null
  const note = document.createElement('p')
  note.className = 'pg-online-note'
  note.setAttribute('role', 'status')
  note.setAttribute('aria-live', 'polite')
  if (bar) bar.before(note)

  let samples: OnlineScore[] = []

  /**
   * 换示例。
   * `jumpToPreview`：点了示例按钮就直接给看效果；首屏 `false`（还停在「脚本」）。
   */
  const select = (idx: number, jumpToPreview: boolean): void => {
    const sample = samples[idx]
    if (!sample) return
    codeEl.textContent = sample.code
    if (jumpToPreview) previewJpsBlock(block)
    if (openApp) openApp.href = `/app/?jps=${encodeURIComponent(sample.code)}`
  }

  const render = (): void => {
    if (!bar) return
    bar.replaceChildren()
    samples.forEach((sample, idx) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('role', 'tab')
      b.dataset.pgSample = String(idx)
      b.className = idx === 0 ? 'active' : ''
      b.setAttribute('aria-selected', idx === 0 ? 'true' : 'false')
      b.textContent = sample.title
      b.addEventListener('click', () => {
        bar.querySelectorAll<HTMLButtonElement>('[data-pg-sample]').forEach((x) => {
          const on = x === b
          x.classList.toggle('active', on)
          x.setAttribute('aria-selected', on ? 'true' : 'false')
        })
        select(idx, true)
      })
      bar.appendChild(b)
    })
  }

  void loadOnlineScores()
    .then(({ data, warning }) => {
      samples = data.samples
      if (warning !== '') note.textContent = warning
      else note.textContent = ''
      if (samples.length === 0) {
        note.textContent = '线上暂无示例谱。'
        if (bar) bar.replaceChildren()
        return
      }
      render()
      select(0, false)
    })
    .catch((e: unknown) => {
      if (bar) bar.replaceChildren()
      note.textContent = e instanceof Error ? e.message : '需要联网获取示例谱，请检查网络后重试。'
    })
}
