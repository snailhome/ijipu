/**
 * ui/ProblemsDrawer.tsx — 告警抽屉（adj1290）
 *
 * 由来（用户 2026-11-16 拍板）：告警原先挂在底栏 9 个页签里，与「工作区 / 导入 / 试听 / 导出…」
 * 这些**操作台**同质摆放。但告警是**信息反馈**，不是操作台——用户得先想起"去哪个页签看"，
 * 而告警的价值恰恰是"不用找就看见"。另外宽屏左右拆分时底栏只占编辑列（`adj552`），
 * 预览那一侧完全看不到告警。
 *
 * 所以独立成**贯穿窗口底部**的抽屉：
 *  · **默认收起**——状态栏那行「5告警」始终在，信息不丢；
 *  · 点状态栏那行 / `Ctrl+`` 展开，从状态栏往上长、整幅宽度；
 *  · 再点 / ESC 收起；**有错也不自动展开**（自动弹会顶起编辑区、打断打字）；
 *  · 高度由 CSS `max-height` 收口（面板头 + 5 行），超出由列表自己滚——
 *    **不再做 JS 测高**，于是 `ui/dock/problemsHeight.ts` 整套算式下线（本 adj 删除）。
 *
 * 与操作底栏（`ui/ToolDock.tsx`）是**两条独立的栏**：抽屉常在最下面、紧贴状态栏，
 * 底栏在它上面，两者各自 `flex: 0 0 auto`，互不挤压。
 *
 * 内容行仍复用原 `.problem-*` 那套样式（点击跳转 / 正确写法按需展开 / 语法速查），
 * 只把最外层容器从 `.problem-panel` 换成 `.problems-drawer`。
 */
import { useEffect, useMemo, useState } from 'react'
import { useDocStore } from '../store/docStore'
import { useUiStore } from '../store/uiStore'
import { problemCopy, dockCopy } from '../brand/copy'
import { offsetOf, summarizeProblems } from './problems'

export function ProblemsDrawer() {
  const open = useUiStore((s) => s.problemsDrawerOpen)
  const setOpen = useUiStore((s) => s.setProblemsDrawer)
  const setModal = useUiStore((s) => s.openModal)
  const code = useDocStore((s) => s.code)
  const errors = useDocStore((s) => s.parseResult.errors)
  const jumpCursor = useDocStore((s) => s.jumpCursor)
  // adj462：每条「正确写法」的展开态（默认全收起）；键用行/列/级别，与数组下标无关
  const [hintOpen, setHintOpen] = useState<Set<string>>(new Set())

  const summary = useMemo(() => summarizeProblems(errors), [errors])

  /**
   * adj1290：**ESC 收起抽屉**。
   *
   * 为什么用**捕获阶段**：`ToolDock` 的 ESC（最小化底栏）挂在冒泡阶段（`adj608`），
   * 同一次按键里两者都会收到。抽屉是更内层的东西，得先处理并 `preventDefault()`——
   * 那边看到 `defaultPrevented` 就会让路（同一个交接约定，见 `ToolDock` 的 `onKey` 守卫）。
   *
   * 有对话框时不抢：让对话框先处理（与 `ToolDock` 的 `modal` 判据一致）。
   */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (useUiStore.getState().modal) return
      e.preventDefault()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setOpen])

  // 收起状态**整块不渲染**：它不占任何高度，也不参与布局计算
  if (!open) return null

  const isError = summary.worst === 'error'
  const title = summary.total === 0 ? problemCopy.clean : problemCopy.title(summary.total, summary.errorCount, summary.warnCount)
  const toggleHint = (key: string) => {
    setHintOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div
      className={`problems-drawer is-${isError ? 'error' : 'warn'}`}
      role="region"
      aria-label={dockCopy.tabProblems}
    >
      <div className="problems-head">
        {/*
          点头部 = 收起（与点状态栏那行、按 Ctrl+` 同一条路）。
          原 ProblemPanel 这里是「点头部折叠列表」的两级开合；抽屉本身只有一级，
          所以那个语义直接并进来，不再多一个 toggle 按钮。
        */}
        <button
          type="button"
          className="problems-head-main"
          onClick={() => setOpen(false)}
          title={`${title}（点此收起）`}
        >
          <span className="problems-icon" aria-hidden="true">
            {isError ? '✕' : '!'}
          </span>
          <span className="problems-title">{title}</span>
        </button>
        {/* adj394：直接跳到内置语法速查（每条还会按需给出具体规则与示例） */}
        <button type="button" className="problems-syntax" onClick={() => setModal('syntax')} title="打开内置语法速查">
          {problemCopy.syntaxHelp}
        </button>
      </div>

      {summary.total === 0 ? (
        <div className="dock-empty">{dockCopy.noProblems}</div>
      ) : (
        <ul className="problems-list">
          {summary.rows.map((r, i) => {
            const key = `${r.line}-${r.col}-${r.severity}-${i}`
            const expanded = hintOpen.has(key)
            return (
              <li key={key}>
                <div className="problem-line">
                  {/* adj462：行首展开按钮——只显示「告警」本身，正确写法按需展开 */}
                  {r.hint ? (
                    <button
                      type="button"
                      className={`problem-expand is-${r.severity}${expanded ? ' is-open' : ''}`}
                      onClick={() => toggleHint(key)}
                      title={expanded ? problemCopy.collapseHint : problemCopy.expandHint}
                      aria-expanded={expanded}
                    >
                      {/* adj512/adj532：单字符 `▶` + rotate(90deg)，收起右指、展开下指（详见原 ProblemPanel 的说明） */}
                      <span className="problem-expand-glyph" aria-hidden="true">▶</span>
                    </button>
                  ) : (
                    <span className="problem-expand is-placeholder" aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    className={`problem-row is-${r.severity}`}
                    title={problemCopy.jumpHint}
                    onClick={() => jumpCursor(offsetOf(code, r.line, r.col))}
                  >
                    <span className="problem-tag">{r.label}</span>
                    <span className="problem-pos">
                      第{r.line}行 第{r.col}列
                    </span>
                    <span className="problem-msg">{r.message}</span>
                  </button>
                </div>
                {expanded && r.hint && (
                  <div className={`problem-hint is-${r.severity}`}>
                    <span className="problem-hint-label">{problemCopy.correctPrefix}</span>
                    {r.hint}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
