/**
 * ui/RightDock.tsx — **右侧操作栏**外壳（adj1295）
 *
 * ## 它是什么
 *
 * 底栏（`ui/ToolDock.tsx`）的**另一种壳**：面板集合、页签顺序、当前页签（`uiStore.dockPanel`）
 * 全部共用（见 `ui/dock/dockPanels.tsx`），只有**布局**不同——
 * 底栏是"矮而宽"、右栏是"高而窄"。三种操作方式里右栏占两种：
 *
 * | 模式 | 布局 | 关闭方式 |
 * |---|---|---|
 * | 插入（`dockFloat === false`）| `.app-body` 的 flex 子项，**挤窄**编辑/预览 | 顶栏图标 / 设置里换回底栏 |
 * | 浮动（`dockFloat === true`）| 绝对定位贴右、通高，**盖住**内容 | 同上 + **点栏外区域** + ESC |
 *
 * ## 三条硬口径（来自方案 `docs/DOCK-LAYOUT-PLAN.md` §三/§六·阶段 B）
 *
 * 1. **整幅高度**：右栏从 TopBar 下沿一直到状态栏/告警抽屉上沿，**不受 `adj552`**
 *    「底栏只占编辑列」影响——那一条只管底栏。
 * 2. **宽度只有两档，没有"最小化"**（用户拍板）：窄/宽一按即切，PC 320/480、手机 1/2、2/3 屏宽
 *    （换算在 `store/fileHost.ts` 的 `dockWidthPx`，纯函数有闸门）。
 * 3. **页签组两种位置**：底部横排（同底栏观感）/ 右侧竖排（图标在上、中文竖排、超出上下滚）。
 *    右栏页签条**只有页签项 + 两端溢出箭头**——「收起 / 高度档位 / ✕」都不跟过来
 *    （关闭归顶栏那个常驻图标按钮，不留第二个关闭入口）。
 *
 * ## 为什么这里自己写了一份页签溢出逻辑（而不是抽成共用组件）
 *
 * 底栏那一份（`adj556/adj561/adj567`）承载了「箭头始终占位」「当前页签滚进视界」
 * 「滚轮转横向」等**已被真机反复校准**的行为，并且有 19 处源码断言钉着它的写法。
 * 阶段 B 的目标是"新增一个壳"，不是"重构底栏"——**底栏行为必须与改造前完全一致**（验收负向③）。
 * 两壳的页签条本就不一样（右栏没有三个常驻按钮、方向还可能竖起来），
 * 所以这里保留一份**只含页签项 + 箭头**的精简实现，把回归风险留给零。
 * 若日后要合并：先改方案文档，再一起改两处与那 19 条断言。
 *
 * ## 面板状态
 *
 * 与底栏同一套：**首次激活才挂载**、之后用 `hidden` 隐藏（面板内部状态不丢）。
 * 切壳（底栏 ⇄ 右栏）时组件会重新挂载，面板内部状态**会重建**——但"当前是哪一块面板"
 * 存在 `uiStore.dockPanel` 里，所以切壳后看到的仍是同一块面板（用户口径："面板状态互通"）。
 */
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useUiStore } from '../store/uiStore'
import type { DockMode, DockPanelKey } from '../store/uiStore'
import { dockCopy, dockRightCopy } from '../brand/copy'
import { withKbd } from '../brand/shortcuts'
import { ToolIcon } from './ToolIcon'
// adj1293：页签定义 / 面板映射与底栏共用同一份（两壳只在布局上不同）
import { PANELS, dockVisibleTabs } from './dock/dockPanels'
// adj1294：宽度换算（纯函数：PC 320/480 夹 45vw；手机 1/2、2/3 屏宽）
import { dockWidthPx } from '../store/fileHost'
import type { DockTabsPos, DockWidth } from '../store/fileHost'
// adj974 口径：只看"是不是真手机/触屏"，不含窗口宽度
import { isCoarsePointerDevice } from '../brand/env'

export function RightDock() {
  const open = useUiStore((s) => s.dockOpen)
  const side = useUiStore((s) => s.dockSide)
  const float = useUiStore((s) => s.dockFloat)
  const width = useUiStore((s) => s.dockWidth)
  const tabsPos = useUiStore((s) => s.dockTabsPos)
  const panel = useUiStore((s) => s.dockPanel)
  const setDockPanel = useUiStore((s) => s.setDockPanel)
  const closeDock = useUiStore((s) => s.closeDock)
  const setDockWidth = useUiStore((s) => s.setDockWidth)
  const setDockTabsPos = useUiStore((s) => s.setDockTabsPos)
  const setDockFloat = useUiStore((s) => s.setDockFloat)

  const rootRef = useRef<HTMLElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  /** 本端是否手机/平板（粗指针）——只影响**宽度换算**（手机按屏宽比例给） */
  const [mobile] = useState(isCoarsePointerDevice)
  /** 视口宽（宽度换算的输入；窗口拖动/旋转屏都要跟着变） */
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  /** 首次激活才挂载（与底栏同一口径，见文件头"面板状态"） */
  const [everActive, setEverActive] = useState<readonly DockPanelKey[]>([panel])
  /** 页签条溢出状态：`start`/`end` = 两端还能不能滚；`overflowing` = 是否真的溢出（决定箭头占不占位） */
  const [ov, setOv] = useState({ start: false, end: false, overflowing: false })

  const vertical = tabsPos === 'right'
  /** 只有"当前在右栏 + 已展开"才算真的在显示（否则整块不渲染） */
  const active = open && side === 'right'
  const px = dockWidthPx(width, vw, mobile)

  // 视口宽跟随（旋转屏 / 拖窗口 / 缩放）
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  /**
   * 把当前宽度写进 CSS 变量 `--jp-right-dock-w`（挂在 `<html>` 上）。
   *
   * 为什么用变量而不是只给本元素 inline `width`：**右上角的 Toast / 更新提示也要让位**
   * （它们是 `position: fixed`，会贴在右栏上面）。变量挂在根上，`.toast` 的
   * `right: calc(20px + var(--jp-right-dock-w, 0px))` 就能跟着走——不需要 JS 再算一次。
   * 关闭/切回底栏时**必须摘掉**，否则提示会一直偏左。
   */
  useEffect(() => {
    const root = document.documentElement
    if (!active) {
      root.style.removeProperty('--jp-right-dock-w')
      return
    }
    root.style.setProperty('--jp-right-dock-w', `${px}px`)
    return () => {
      root.style.removeProperty('--jp-right-dock-w')
    }
  }, [active, px])

  useEffect(() => {
    setEverActive((prev) => (prev.includes(panel) ? prev : [...prev, panel]))
  }, [panel])

  /**
   * adj1295：**ESC 只在浮动模式关闭右栏**（验收负向②：插入模式的右栏是布局的一部分，
   * 按 ESC 关掉它会让人以为"编辑器崩了"；而且右栏没有"最小化"这一档）。
   *
   * 捕获阶段 + `preventDefault()`：与 `ProblemsDrawer` 同一套交接约定——
   * 更内层的东西先处理，`ToolDock` 的冒泡监听看到 `defaultPrevented` 就让路
   * （两壳互斥，正常不会同时存在，但这个约定不依赖"互斥"这个前提）。
   */
  useEffect(() => {
    if (!active || !float) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (useUiStore.getState().modal) return // 对话框先处理
      e.preventDefault()
      closeDock()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, float, closeDock])

  /**
   * adj1295：**点栏外关闭**（只对浮动模式；插入模式是布局的一部分，不因点外面而消失）。
   *
   * 两条限定（都是方案 §八·1 那条坑的落地）：
   *  ① 只认「**工作区/编辑/预览那一片**」（`.app-body` 之内）——顶栏、状态栏、告警抽屉、
   *     以及 portal 到 `body` 的菜单（工作区「操作▾」的 `.ws-menu`、顶栏下拉）**都不算栏外**。
   *     用 `composedPath()` 而不是 `contains()` 一判了事：portal 菜单与右栏是**兄弟**关系，
   *     也根本不在 `.app-body` 里，靠"路径里有没有 .app-body"这一个判据就同时挡住它们。
   *  ② 顶栏那个开关按钮自己负责开合——它在 `.app-body` 之外，天然不会被这里误关
   *     （否则"先关再开"看起来就是点不动）。
   *
   * 用 `pointerdown`（按下即关，与系统里其它"点外面"一致），不 `preventDefault`，
   * 于是"点编辑区"这一下仍然照常落到编辑器上（不会白点一下）。
   */
  useEffect(() => {
    if (!active || !float) return
    const onDown = (e: PointerEvent) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : []
      if (rootRef.current && path.includes(rootRef.current)) return // 点在栏内
      if (path.some((n) => n instanceof Element && n.closest('.ws-menu, .menu-dropdown, .modal, [data-dock-portal]')))
        return // portal 浮层：工作区菜单 / 顶栏下拉 / 对话框
      if (!path.some((n) => n instanceof Element && n.classList.contains('app-body'))) return // 只有内容区算"栏外"
      closeDock()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [active, float, closeDock])

  // ---- 页签条：溢出判定 / 溢出箭头翻页 / 当前页签滚进视界 -------------------------
  const syncOv = useCallback(() => {
    const el = stripRef.current
    if (!el) return
    const max = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth
    const pos = vertical ? el.scrollTop : el.scrollLeft
    const start = pos > 1
    const end = max > 1 && pos < max - 1
    const overflowing = max > 1
    // 同值短路：RO 回调里无条件 setState 会多一轮渲染（底栏 adj561 同款处理）
    setOv((prev) =>
      prev.start === start && prev.end === end && prev.overflowing === overflowing
        ? prev
        : { start, end, overflowing },
    )
  }, [vertical])

  useLayoutEffect(() => {
    if (!active) return
    const el = stripRef.current
    if (!el) return
    const sync = () => syncOv()
    sync()
    const raf = requestAnimationFrame(sync)
    /**
     * 滚轮：**横排**才把纵向滚轮转成横向（与底栏 adj556 同款三条：只在确实溢出时接管、
     * 触控板横向滚动放行、Shift+滚轮交给浏览器原生）。**竖排**什么都不做——
     * 原生滚轮本来就是上下滚，劫持反而会挡住正常滚动。
     */
    const onWheel = (e: WheelEvent) => {
      if (vertical) return
      if (el.scrollWidth <= el.clientWidth) return
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    // 观察容器 + 全部页签：容器盒宽变（拖窗口）与页签内容变宽（字体就绪）都要重算
    const observeAll = () => {
      ro.disconnect()
      ro.observe(el)
      for (const child of Array.from(el.children)) ro.observe(child)
    }
    observeAll()
    const mo = new MutationObserver(() => {
      observeAll()
      sync()
    })
    mo.observe(el, { childList: true })
    void document.fonts?.ready.then(sync).catch(() => {})
    window.addEventListener('resize', sync)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
      ro.disconnect()
      mo.disconnect()
    }
  }, [active, vertical, syncOv])

  /**
   * **当前面板的页签必须可见**（底栏 adj567 的同一条诉求）：
   * 面板可能是从顶栏按钮 / 快捷键 / 状态栏打开的，那条路不经过页签的 `onClick`，
   * 所以对齐函数在「当前面板变化」与「点页签」两处都要调。
   */
  const alignActive = useCallback(() => {
    const strip = stripRef.current
    if (!strip) return
    const pass = () => {
      const btn = strip.querySelector<HTMLElement>(`[data-key="${panel}"]`)
      if (!btn) return
      const br = btn.getBoundingClientRect()
      const sr = strip.getBoundingClientRect()
      if (vertical) {
        const delta = br.top < sr.top - 1 ? br.top - sr.top : br.bottom > sr.bottom + 1 ? br.bottom - sr.bottom : 0
        if (delta !== 0) strip.scrollTo({ top: strip.scrollTop + delta, behavior: 'auto' })
        return
      }
      const delta = br.left < sr.left - 1 ? br.left - sr.left : br.right > sr.right + 1 ? br.right - sr.right : 0
      if (delta !== 0) strip.scrollTo({ left: strip.scrollLeft + delta, behavior: 'auto' })
    }
    pass()
    // 一次延迟补正（布局/字体就绪、栏宽变化带动重排），幂等
    window.setTimeout(pass, 60)
  }, [panel, vertical])

  useEffect(() => {
    if (!active) return
    alignActive()
  }, [active, panel, vertical, alignActive])

  const pageBy = (dir: -1 | 1) => {
    const el = stripRef.current
    if (!el) return
    const size = vertical ? el.clientHeight : el.clientWidth
    const delta = dir * Math.max(80, size * 0.8)
    el.scrollBy(vertical ? { top: delta, behavior: 'smooth' } : { left: delta, behavior: 'smooth' })
  }

  // 只有"右侧栏 + 已展开"才渲染（底栏模式下整块不存在，`ToolDock` 同理自锁）
  if (!active) return null

  // adj1293：可见页签判据共用（嵌入版过滤「工作区」；右栏同源）
  const visibleTabs = dockVisibleTabs()
  const nextWidth: DockWidth = width === 'narrow' ? 'wide' : 'narrow'
  const nextTabsPos: DockTabsPos = vertical ? 'bottom' : 'right'
  const mode: DockMode = float ? 'float' : 'insert'
  const nextMode: DockMode = float ? 'insert' : 'float'

  const tabStrip = (
    <div className={`right-dock-tabs${vertical ? ' is-vert' : ''}`}>
      {/* 溢出时箭头**始终占位**、只切 visibility（底栏 adj567 同款）：
          箭头一增一减会改变页签区可用宽，把"刚对齐好的页签"又挤出去 */}
      {ov.overflowing && (
        <button
          type="button"
          className="tool-dock-tab-arrow right-dock-tab-arrow"
          style={{ visibility: ov.start ? 'visible' : 'hidden' }}
          disabled={!ov.start}
          tabIndex={ov.start ? 0 : -1}
          aria-hidden={!ov.start}
          title={vertical ? dockRightCopy.tabsUpTitle : dockCopy.tabsLeftTitle}
          aria-label={vertical ? dockRightCopy.tabsUpTitle : dockCopy.tabsLeftTitle}
          onClick={() => pageBy(-1)}
        >
          <ToolIcon name={vertical ? 'up' : 'left'} size={14} />
        </button>
      )}
      <div
        className={`right-dock-tabstrip${vertical ? ' is-vert' : ''}`}
        role="tablist"
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        ref={stripRef}
      >
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={panel === t.key}
            className={`tool-dock-tab right-dock-tab${panel === t.key ? ' is-active' : ''}`}
            data-key={t.key}
            title={t.kbd ? withKbd(t.label, t.kbd) : t.label}
            onClick={() => {
              setDockPanel(t.key)
              // 点的是**已激活**的页签时 `panel` 不变、effect 不跑 ⇒ 这里也补一次对齐
              alignActive()
            }}
          >
            <span className="tool-dock-tab-icon" aria-hidden="true">
              <ToolIcon name={t.icon} />
            </span>
            <span className="tool-dock-tab-label">{t.label}</span>
          </button>
        ))}
      </div>
      {ov.overflowing && (
        <button
          type="button"
          className="tool-dock-tab-arrow right-dock-tab-arrow"
          style={{ visibility: ov.end ? 'visible' : 'hidden' }}
          disabled={!ov.end}
          tabIndex={ov.end ? 0 : -1}
          aria-hidden={!ov.end}
          title={vertical ? dockRightCopy.tabsDownTitle : dockCopy.tabsRightTitle}
          aria-label={vertical ? dockRightCopy.tabsDownTitle : dockCopy.tabsRightTitle}
          onClick={() => pageBy(1)}
        >
          <ToolIcon name={vertical ? 'down' : 'right'} size={14} />
        </button>
      )}
    </div>
  )

  return (
    <aside
      ref={rootRef}
      // 复用 `tool-dock` 是为了让 8 个面板的既有 CSS（`.tool-dock .pcfg-*` 等）继续生效——
      // 右栏与底栏装的**是同一批组件**，样式不该有两套。`.right-dock` 只覆盖"壳"的几项
      // （宽度/高度上限/边框/浮动定位），见 index.css 末尾那一节。
      className={`tool-dock right-dock is-${float ? 'float' : 'insert'}${vertical ? ' tabs-vert' : ''}`}
      aria-label={dockRightCopy.wrapLabel}
      data-dock-side="right"
      data-dock-float={float ? '1' : '0'}
      data-dock-tabs={tabsPos}
      data-dock-width={width}
    >
      {/* 顶部工具条：三个按钮（宽度档 / 页签位置 / 插入⇄浮动）——
          全部**显示当前状态**，提示里写"点击 → 下一档"（与底栏那个"显示下一步"的档位按钮不同：
          这里三个都是**二态**，显示当前态更不容易误读） */}
      <div className="right-dock-bar" role="toolbar" aria-label={dockRightCopy.wrapLabel}>
        <button
          type="button"
          className="right-dock-btn"
          data-right-dock-width={width}
          title={dockRightCopy.widthTitle(dockRightCopy.widthName[width], px, dockRightCopy.widthName[nextWidth])}
          aria-label={dockRightCopy.widthTitle(dockRightCopy.widthName[width], px, dockRightCopy.widthName[nextWidth])}
          onClick={() => setDockWidth(nextWidth)}
        >
          {dockRightCopy.widthName[width]}
        </button>
        <button
          type="button"
          className="right-dock-btn"
          data-right-dock-tabs={tabsPos}
          title={dockRightCopy.tabsPosTitle(dockRightCopy.tabsPosName[tabsPos], dockRightCopy.tabsPosName[nextTabsPos])}
          aria-label={dockRightCopy.tabsPosTitle(dockRightCopy.tabsPosName[tabsPos], dockRightCopy.tabsPosName[nextTabsPos])}
          onClick={() => setDockTabsPos(nextTabsPos)}
        >
          {dockRightCopy.tabsPosShort[tabsPos]}
        </button>
        <button
          type="button"
          className="right-dock-btn"
          data-right-dock-mode={mode}
          title={dockRightCopy.modeTitle(dockRightCopy.modeName[mode], dockRightCopy.modeName[nextMode])}
          aria-label={dockRightCopy.modeTitle(dockRightCopy.modeName[mode], dockRightCopy.modeName[nextMode])}
          onClick={() => setDockFloat(nextMode === 'float')}
        >
          {dockRightCopy.modeShort[mode]}
        </button>
      </div>
      {/* 内容区 + （竖排时）右侧竖条：`right-dock-main` 是横向 flex，DOM 顺序 = 视觉顺序 */}
      <div className="right-dock-main">
        <div className="right-dock-body">
          {PANELS.filter((p) => everActive.includes(p.key)).map((p) => {
            const Pane = p.render
            return (
              <div key={p.key} className={`tool-dock-pane pane-${p.key}`} hidden={panel !== p.key} role="tabpanel">
                <Suspense fallback={<div className="dock-empty">加载中…</div>}>
                  <Pane />
                </Suspense>
              </div>
            )
          })}
        </div>
        {vertical && tabStrip}
      </div>
      {/* 横排时页签条在整栏底部（内容之下、栏底之上） */}
      {!vertical && tabStrip}
    </aside>
  )
}
