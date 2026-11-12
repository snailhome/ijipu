/**
 * dialogs/PracticeMarkBar.tsx — 试听对话框里的「练习段」按钮组（adj987，用户 2026-10-18 需求）
 *
 * ## 用户口径（逐条）
 *
 * 「添加个按钮组，分别是选择标记段下拉列表，起始、停止、添加、删除、循环图标按钮，分别用于
 *   选择标记段、标记起始音符、标记停止音符、添加标记段到标记段列表、删除当前列表项、循环播放开关按钮」
 * 「标记段针对做标记的 jps 文件/jps 代码块有效，缓存级保存」
 * 「选择标记段下拉列表默认（第一个）为无，默认为演奏全曲，不可删除，其它用户标记段可删除」
 * 「可以对这个标记段组的左上角再加一个收起/显示整个段组的小按钮」（追加）
 *
 * ## 交互
 *
 * ① 在预览里点一个音符（`docStore.activeNoteId` 变成它）→ 按「起始」/「停止」登记端点；
 * ② 两端都登记后按「添加」⇒ 生成 `段 N` 并自动选中；
 * ③ 「循环」是开关，「收起」只折起本组（不改变任何标记）。
 *
 * ## 遍次（用户追问的歧义）
 *
 * 起止都在公共段、中间被跳跃分开时，同一对 id 在展开序列里会有**多个候选**；
 * 这里在「候选 > 1」时才显示第二个下拉（第 1 遍 / 第 2 遍 …，含跳越的标 `(含跳越)`），
 * 选过之后写回标记的 `pass`（持久化）。
 */
import { useEffect, useMemo, useState } from 'react'
import { buildPlaySequence, layoutScore, noteIdStringOf, resolvePracticeRange, slicePlaySequenceByRange, flattenScoreNotes, spotOfIn, hasNoteId } from '@ijipu/engine'
import { useDocStore } from '../store/docStore'
import { useUiStore } from '../store/uiStore'
import { docKeyOf, loadMarks, saveMarks } from '../store/practiceMarks'
// adj1101：下拉项「段1 [ 33:1 - 34:2 ]」的文本（纯函数，smoke 直接断言）
import { markOptionText } from './practiceMarkText'
import { playbackCopy } from '../brand/copy'


export function PracticeMarkBar(): React.JSX.Element {
  const marks = useUiStore((s) => s.practiceMarks)
  const markId = useUiStore((s) => s.practiceMarkId)
  const loop = useUiStore((s) => s.practiceLoop)
  const collapsed = useUiStore((s) => s.practiceCollapsed)
  const selStart = useUiStore((s) => s.practiceSelStart)
  const selStop = useUiStore((s) => s.practiceSelStop)
  const setMarks = useUiStore((s) => s.setPracticeMarks)
  const setMarkId = useUiStore((s) => s.setPracticeMarkId)
  const setPass = useUiStore((s) => s.setPracticeMarkPass)
  const setSel = useUiStore((s) => s.setPracticeSel)
  const addMark = useUiStore((s) => s.addPracticeMark)
  const deleteMark = useUiStore((s) => s.deletePracticeMark)
  const setLoop = useUiStore((s) => s.setPracticeLoop)
  const toggleCollapsed = useUiStore((s) => s.togglePracticeCollapsed)
  const showNotice = useUiStore((s) => s.showNotice)

  const activeNoteId = useDocStore((s) => s.activeNoteId)
  const fileName = useDocStore((s) => s.fileName)
  const binding = useDocStore((s) => s.binding)
  const nativePath = useDocStore((s) => s.nativePath)
  const parseResult = useDocStore((s) => s.parseResult)
  const pageConfig = useDocStore((s) => s.pageConfig)

  /** 文档身份（换文档 ⇒ 换一批标记）；对话框打开时从缓存载入 */
  const docKey = useMemo(() => docKeyOf({ fileName, binding, nativePath }), [fileName, binding, nativePath])
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(false)
    setMarks(loadMarks(docKey))
    setMarkId('')
    setReady(true)
  }, [docKey, setMarks, setMarkId])
  /** 标记一变就落盘（本机缓存；空列表会删键） */
  useEffect(() => {
    if (!ready) return
    saveMarks(docKey, marks)
  }, [docKey, marks, ready])

  const chooseMark = (id: string) => {
    setMarkId(id)
  }

  const setPracticeRangeIds = useUiStore((s) => s.setPracticeRangeIds)
  const cur = marks.find((m) => m.id === markId)

  /**
   * adj1101 / adj1107（用户 2026-10-23 实报「只有段1带 []，其它段没带」）：
   * 逐段算「段名 [ 起 - 止 ]」。端点直接查不到时（旧标记的 id 与当前排版对不上、
   * 端点在休止符/段层上），退回**播放端同一套解析**（`resolvePracticeRange` + 切片）取首末音再查一次。
   */
  const optionTextById = useMemo(() => {
    const map = new Map<string, string>()
    if (marks.length === 0) return map
    const layout = layoutScore(parseResult, pageConfig)
    const notes = flattenScoreNotes(layout, { includeRests: true })
    const seq = buildPlaySequence(parseResult, layout, 90)
    for (const m of marks) {
      let a = spotOfIn(notes, m.startId)
      let b = spotOfIn(notes, m.endId)
      if (a === null || b === null) {
        const res = resolvePracticeRange(seq, m.startId, m.endId, { endInLayout: hasNoteId(layout, m.endId) })
        const c = res.candidates[res.pick] ?? res.candidates[0]
        const ids = c ? (slicePlaySequenceByRange(seq, c.i0, c.i1)?.events.map((e) => noteIdStringOf(e.placed.id)) ?? []) : []
        const first = ids.find((id) => spotOfIn(notes, id) !== null)
        const last = [...ids].reverse().find((id) => spotOfIn(notes, id) !== null)
        if (a === null && first !== undefined) a = spotOfIn(notes, first)
        if (b === null && last !== undefined) b = spotOfIn(notes, last)
      }
      map.set(m.id, markOptionText(m.name, a, b))
    }
    return map
  }, [marks, parseResult, pageConfig])

  /**
   * 候选遍次 + **这一段实际演奏到的音符 id**（adj987k）。
   *
   * 后者给预览层画线用：跨 `:|` 回跳/跳房子时线要**跟着演奏顺序**走
   * （用户口径 #5：「允许起始在停止后，且要跟着演奏顺序画线」）。
   */
  const resolved = useMemo(() => {
    /** 解析结果的形状（`missing`/`totalEvents` 供"找不到"读数用） */
    interface Resolved {
      candidates: { i0: number; i1: number; startOccurrence: number; containsJump: boolean }[]
      ids: string[]
      rangeMs: number
      lastNote: string
      missing: '' | 'start' | 'end'
      totalEvents: number
      i0: number
      i1: number
      eventCount: number
    }
    const empty: Resolved = { candidates: [], ids: [], rangeMs: 0, lastNote: '', missing: '', totalEvents: 0, i0: -1, i1: -1, eventCount: 0 }
    if (!cur) return empty
    const layoutForResolve = layoutScore(parseResult, pageConfig)
    const seq = buildPlaySequence(parseResult, layoutForResolve, 90)
    // adj1102：终点在排版里存在 ⇒ 告诉引擎"没有事件是被合并了"，按紧邻的前一个音配
    const res = resolvePracticeRange(seq, cur.startId, cur.endId, {
      endInLayout: hasNoteId(layoutForResolve, cur.endId),
    })
    if (res.candidates.length === 0) {
      return { ...empty, missing: res.missing ?? '', totalEvents: seq.events.length }
    }
    const idx = Math.min(Math.max(cur.pass ?? res.pick, 0), res.candidates.length - 1)
    const c = res.candidates[idx]
    // 用户口径（2026-10-18 最后确认）：连音线**不自动判断**，想连到线尾就把「停止」标在最后一个主音上
    // ⇒ 画线范围与实际演奏一致，都不再做连音线延长（附点/增时线本来就在事件的时值里）
    const sliced = slicePlaySequenceByRange(seq, c.i0, c.i1)
    const evs = sliced?.events ?? []
    const lastEv = evs.length > 0 ? evs[evs.length - 1] : null
    /**
     * adj992（**用户 2026-10-19 实报**：「两个端点都对，但一按添加，停止位就回缩一个音——线少画一个音，
     * 播放却是对的」）：
     *
     * 画线用的是"切片里的事件 id"；而切片会做两件可能让**端点音**不在列表里的事：
     *  ① 终点那个音若没有独立事件（被并进前一个音的时值）⇒ 列表最后一个是它**前面**那个音；
     *  ② "向前多吃"可能把后面别的事件也纳进来，端点音的先后位置就被打乱。
     * ⇒ 画线列表**强制包含用户标的两个端点**（起点已在前就跳过，终点不在末尾就补上），
     *   这样"线覆盖你标的那一对端点"永远成立；**播放区间（i0/i1）不动**，所以听到的不会变。
     */
    const ids = evs.map((e) => noteIdStringOf(e.placed.id))
    if (!ids.includes(cur.startId)) ids.unshift(cur.startId)
    if (!ids.includes(cur.endId)) ids.push(cur.endId)
    /**
     * adj1108（用户 2026-10-23 截图：「红框处是连音线的后段，标记线不该断开」）：
     * 连音线/同音合并会让中间那个音**没有独立事件** ⇒ 画线时出现一个"假缺口"。
     * 这里只补**同组内序号恰好差 2**（中间正好漏一个音）的那一个 —— 大跳越（跳房子/反复跳过整段）
     * 的序号差远大于 2，不会被补上，仍然断线。
     */
    const layoutIds = new Set<string>()
    for (const p of layoutForResolve.pages) for (const n of p.notes) layoutIds.add(noteIdStringOf(n.id))
    const filled: string[] = []
    for (let i = 0; i < ids.length; i++) {
      filled.push(ids[i])
      const a = /^(\d+)_(\d+)_(\d+)_(\d+)$/.exec(ids[i])
      const b = /^(\d+)_(\d+)_(\d+)_(\d+)$/.exec(ids[i + 1] ?? '')
      if (a !== null && b !== null && a[3] === b[3] && Number(b[4]) - Number(a[4]) === 2) {
        const mid = `${a[1]}_${a[2]}_${a[3]}_${Number(a[4]) + 1}`
        if (layoutIds.has(mid)) filled.push(mid)
      }
    }
    return {
      candidates: res.candidates,
      ids: filled,
      rangeMs: sliced?.rangeMs ?? 0,
      /**
       * adj987t（用户实报「少了停止位的那个音」）：**这一段最后一个音**的 `g组#序号`。
       * 与标记的终点（同一格式）一比对，就能看出是不是"少了一个音"。
       */
      lastNote: lastEv ? `g${lastEv.placed.id.group}#${lastEv.placed.id.index}` : '',
      i0: c.i0,
      i1: c.i1,
      eventCount: seq.events.length,
      missing: '' as const,
      totalEvents: seq.events.length,
    } satisfies Resolved
  }, [cur, parseResult, pageConfig])
  const candidates = resolved.candidates
  useEffect(() => {
    // adj991：把"画线用的区间"连同**下标与序列长度**一起发布 —— 播放端优先照它裁段（所见即所听）
    setPracticeRangeIds(resolved.ids, resolved.i0, resolved.i1, resolved.eventCount)
  }, [resolved, setPracticeRangeIds])


  const canAdd = !!selStart && !!selStop
  /**
   * adj987e（**用户 2026-10-18 口径**）：**收起时整组不占地方** —— 这里直接不渲染，
   * 改由歌名前的 `PracticeMarkExpandButton` 提供"展开"入口（否则这一行光放一个按钮太浪费）。
   */
  if (collapsed) return <></>
  return (
    <div className="practice-bar">
      {/* 左上角的收起小按钮（用户追加要求；展开入口在歌名前，见 `PracticeMarkExpandButton`） */}
      <button
        className="practice-collapse"
        onClick={toggleCollapsed}
        title={playbackCopy.practiceCollapse}
        aria-expanded={true}
        aria-label={playbackCopy.practiceCollapse}
      >
        ▾
      </button>
      {(
        <>
          <span className="practice-title">{playbackCopy.practiceTitle}</span>
          <select
            className="dock-select practice-select"
            value={markId}
            onChange={(e) => chooseMark(e.target.value)}
            title={playbackCopy.practiceSelectTitle}
          >
            {/* 第一项恒为「无」＝演奏全曲，不可删除 */}
            <option value="">{playbackCopy.practiceNone}</option>
            {marks.map((m) => (
              <option key={m.id} value={m.id}>
                {optionTextById.get(m.id) ?? m.name}
              </option>
            ))}
          </select>
          <button
            className={`btn practice-btn${selStart ? ' is-on' : ''}`}
            onClick={() => setSel('start', activeNoteId)}
            disabled={!activeNoteId}
            title={playbackCopy.practiceStartHint}
            aria-label={playbackCopy.practiceStart}
          >
            <span aria-hidden="true">⇤</span>
          </button>
          <button
            className={`btn practice-btn${selStop ? ' is-on' : ''}`}
            onClick={() => {
              /**
               * adj987j（用户口径 #2）：「停止音符如果有**连音线**，应该播放到覆盖该音符的连音线完为止」。
               *
               * ⚠ adj987m（**用户 2026-10-18 实报「又出现添加了标记段不按段播放」**）：
               * 这里原先**当场把端点改成连音线终点再存**，但 `slurPairs` 的序号与音符 id 的序号
               * 在有多声部/段层时**未必一致** ⇒ 存进去的 id 可能对不上任何音符 ⇒ 播放时解析失败、
               * 退回"全曲" ✗。现在**只记用户点的那个音**，延长交给播放时算（见 PlaybackDialog 的注释）。
               */
              setSel('stop', activeNoteId)
            }}
            disabled={!activeNoteId}
            title={playbackCopy.practiceStopHint}
            aria-label={playbackCopy.practiceStop}
          >
            <span aria-hidden="true">⇥</span>
          </button>
          <button
            className="btn practice-btn"
            onClick={() => {
              const m = addMark()
              if (!m) showNotice(playbackCopy.practiceNeedBoth, 'warn')
            }}
            disabled={!canAdd}
            title={playbackCopy.practiceAddHint}
            aria-label={playbackCopy.practiceAdd}
          >
            <span aria-hidden="true">＋</span>
          </button>
          <button
            className="btn practice-btn"
            onClick={() => {
              deleteMark(markId)
            }}
            disabled={markId === ''}
            title={playbackCopy.practiceDeleteHint}
            aria-label={playbackCopy.practiceDelete}
          >
            <span aria-hidden="true">－</span>
          </button>
          <button
            className={`btn practice-btn${loop ? ' is-on' : ''}`}
            onClick={() => setLoop(!loop)}
            title={playbackCopy.practiceLoopHint}
            aria-label={playbackCopy.practiceLoop}
            aria-pressed={loop}
          >
            <span aria-hidden="true">⟲</span>
          </button>
          {candidates.length > 1 && cur && (
            <select
              className="dock-select practice-pass"
              value={String(cur.pass ?? 0)}
              onChange={(e) => {
                setPass(cur.id, Number(e.target.value))
              }}
              title={playbackCopy.practicePassTitle}
            >
              {candidates.map((c, i) => (
                <option key={i} value={String(i)}>
                  {`第 ${c.startOccurrence} 遍${c.containsJump ? '（含跳越）' : ''}`}
                </option>
              ))}
            </select>
          )}
        </>
      )}
    </div>
  )
}

/**
 * adj987e（**用户 2026-10-18 口径**）：**收起状态下的"展开"入口** —— 放在**歌名前**，
 * 这样收起时标记段组**不占任何行**（用户原话：「不然还要占一行的位置」）。
 *
 * 展开状态下它自己返回空（组本身已经在试听区下方显示了 ▾ 收起按钮）。
 */
export function PracticeMarkExpandButton(): React.JSX.Element {
  const collapsed = useUiStore((s) => s.practiceCollapsed)
  const toggleCollapsed = useUiStore((s) => s.togglePracticeCollapsed)
  if (!collapsed) return <></>
  return (
    <button
      className="practice-collapse practice-expand-inline"
      onClick={toggleCollapsed}
      title={playbackCopy.practiceExpand}
      aria-expanded={false}
      aria-label={playbackCopy.practiceExpand}
    >
      ▸
    </button>
  )
}
