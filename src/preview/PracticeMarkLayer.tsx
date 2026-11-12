/**
 * preview/PracticeMarkLayer.tsx — 试听「标记段」在谱面上的**标记线**（adj987h，用户 2026-10-18 需求）
 *
 * ## 用户口径
 *
 * · 「点击音符，点击起始按钮，在标记的音符**下**添加起始音符标记」；停止同理；
 * · 「起止音符都标记后，这段音符下显示一个不同底色/底线的标记块/线，颜色与当前焦点音符（红）
 *    和试听色块颜色区分开」；
 * · 后续追加：「**建议用线，不抢眼**」⇒ 本层只画**一条细线**（每行一段）+ 两端小竖头，
 *    不铺底色块（底色会抢播放色块的视觉）；
 * · 「点击开启循环开关按钮后标记块/线**两端显示循环标识**」⇒ 两端各画一个 ⟲；
 * · **允许跨行**：「每行一段」由 `markBandsOf` 按行切好。
 *
 * ## 为什么单独一个层（而不是画进 SVG）
 *
 * 与 `PlayheadLayer` 同理由：SVG 是 `dangerouslySetInnerHTML` 注进去的静态串，逐帧/随状态重画要重建整页；
 * 覆盖层用绝对定位 div，**只重画自己**，且不参与点击（`pointerEvents: none`）不抢音符的点击。
 */
import { markBandsOf, splitIntoRuns } from '../store/practiceMarks'
import { useUiStore } from '../store/uiStore'

export function PracticeMarkLayer({ page, noteSize }: { page: ScorePageLike; noteSize: number }) {
  const marks = useUiStore((s) => s.practiceMarks)
  const markId = useUiStore((s) => s.practiceMarkId)
  const loop = useUiStore((s) => s.practiceLoop)
  const selStart = useUiStore((s) => s.practiceSelStart)
  const selStop = useUiStore((s) => s.practiceSelStop)
  /** adj987k：这一段**实际演奏到的音符 id**（跨反复/跳跃时按播放顺序给） */
  const rangeIds = useUiStore((s) => s.practiceRangeIds)
  /** adj987o：开始 / 循环重来前的倒数（3/2/1；null = 不显示） */
  const countdown = useUiStore((s) => s.practiceCountdown)
  /** adj987l（用户口径 #4）：标记段线**只在试听面板打开时**显示（底栏的「试听」页签） */
  const showInDialog = useUiStore((s) => s.dockOpen && s.dockPanel === 'tryout')
  /** adj1168：对拍台已迁到爱出片，应用内不再有对拍浮层 */
  const cur = marks.find((m) => m.id === markId) ?? null
  /** 画哪一段：优先"已选中的标记"，其次"正在标的两端"；只有一个端点时只画那个小竖头 */
  const startId = cur?.startId ?? selStart ?? null
  const endId = cur?.endId ?? selStop ?? null
  if (!showInDialog) return null
  if (!startId && !endId) return null
  /**
   * 画法优先级：
   *  ① 有"实际演奏到的音符 id"（选中了标记时由按钮组算好）⇒ **按它画**——
   *     跨 `:|` 回跳、跳房子时线跟着演奏顺序走（用户口径 #5：起在止之后也能画对）；
   *  ② 否则退回"起止之间按序号取区间"（用于还没添加、只在标两端的时候）。
   */
  const bands =
    rangeIds.length > 0
      ? bandsFromIds(page, rangeIds, noteSize)
      : startId && endId
        ? markBandsOf(
            // `rightX` 在类型上是可选的（跨行/段层音符可能没有）⇒ 兜底成 `x + 1`，只影响线的右端点
            page.notes.map((n) => ({ id: n.id, x: n.x, y: n.y, rightX: n.rightX ?? n.x + 1 })),
            startId,
            endId,
            (n) => n.y,
            // adj1106/adj1108：跳过不演奏的那一段（跳房子/反复）把线断开；
            // 但**连音线后段**这种"同一段里被合并掉的音"只有约一个音距，不能断 ⇒ 阈值放宽到 3.8 个字号
            noteSize * 3.8,
          )
        : []
  const pct = (v: number) => `${((v / page.width) * 100).toFixed(3)}%`
  const pctY = (v: number) => `${((v / page.height) * 100).toFixed(3)}%`
  /** 线画在音符**下方**（数字基线 + 1.15 倍字号 ≈ 减时线之下、歌词之上） */
  const lineY = (baseline: number) => baseline + noteSize * 1.15
  const lineH = Math.max(1.5, noteSize * 0.12)
  const tickH = noteSize * 0.55
  /**
   * adj987y（**用户 2026-10-18 实报**：「起始点标记错了，标记在第 1 个 Q 行的第一个音符上了，
   * 倒数数字也在这」）：竖头/倒数原来取的是"**本页所有段内音符**里最靠上/最靠右"的那条带的端点，
   * 而跨 `:|` 回跳的段落会覆盖多行、多页 ⇒ 竖头跑到**最靠上的那一行**（第 1 个 Q 行）去了 ✗。
   *
   * ⇒ 竖头与倒数必须落在**实际演奏的第一个音 / 最后一个音**上（按演奏顺序取首末）：
   *  · 有 `rangeIds`（选中标记时由按钮组算好）⇒ 首 = `rangeIds[0]`，末 = 最后一个；
   *  · 否则（还在标两端）⇒ 首 = 起点 id，末 = 终点 id。
   * 本页只有"拥有该音"时才画对应的竖头/标识（另一页自己会画另一头）。
   */
  const firstId = rangeIds.length > 0 ? rangeIds[0] : startId
  const lastId = rangeIds.length > 0 ? rangeIds[rangeIds.length - 1] : endId
  const startPt = firstId ? posOfNoteId(page, firstId) : null
  const endPt = lastId ? posOfNoteId(page, lastId) : null
  /**
   * adj1109（用户 2026-10-23 截图：「这里的跳房子没补上」——线从第二个音才开始，起点那个音被漏掉）：
   * 画线的点数来自"实际演奏到的 id"，起点/终点音若因为合并/序号跳变没被列进去，线就会缩一小截。
   * ⇒ 线**必须覆盖用户标的两个端点**（离得近才补，绝不跨页/跨大段去连）。
   */
  if (startPt) {
    const b = bands.find((x) => x.y === startPt.y && startPt.x <= x.x0 + 0.5)
    if (b && b.x0 - startPt.x <= noteSize * 6) b.x0 = startPt.x
  }
  if (endPt) {
    const b = bands.find((x) => x.y === endPt.y && endPt.rightX >= x.x1 - 0.5)
    if (b && endPt.rightX - b.x1 <= noteSize * 6) b.x1 = endPt.rightX
  }
  return (
    <>
      {bands.map((b, i) => (
        <div
          key={`pm-line-${i}`}
          className="practice-mark-line"
          style={{
            left: pct(b.x0),
            top: pctY(lineY(b.y)),
            width: pct(Math.max(1, b.x1 - b.x0)),
            height: `${lineH}px`,
          }}
        />
      ))}
      {/*
        adj993（**用户 2026-10-19 口径**）：「有循环时，用**循环标志代替端点**；没有循环时用现在的短竖线，
        这样更明确」⇒ 竖头与 ⟲ **二选一**，不再同时画。
      */}
      {!loop && startPt && (
        <div
          className="practice-mark-tick practice-mark-tick-start"
          style={{ left: pct(startPt.x), top: pctY(lineY(startPt.y) - tickH / 2), height: `${tickH}px` }}
        />
      )}
      {!loop && endPt && (
        <div
          className="practice-mark-tick practice-mark-tick-stop"
          style={{ left: pct(endPt.rightX), top: pctY(lineY(endPt.y) - tickH / 2), height: `${tickH}px` }}
        />
      )}
      {/*
        adj987q（**用户 2026-10-18 口径**）：「倒数数字放在起始线头**左边**，更大些、有白底以便凸显」
        —— 放上方会遮住音符；挪到起始竖头的**左侧**（垂直居中于竖头），白底 + 描边保证看得清。
      */}
      {countdown !== null && startPt && (
        <span
          className="practice-countdown"
          style={{ left: pct(startPt.x), top: pctY(lineY(startPt.y) - tickH / 2) }}
        >
          {countdown}
        </span>
      )}
      {/* adj993：循环开启 ⇒ 两端的**循环标志**直接坐在线端（代替短竖头，见上） */}
      {loop && startPt && (
        <span className="practice-mark-loop" style={{ left: pct(startPt.x), top: pctY(lineY(startPt.y)) }}>
          ⟲
        </span>
      )}
      {loop && endPt && (
        <span className="practice-mark-loop" style={{ left: pct(endPt.rightX), top: pctY(lineY(endPt.y)) }}>
          ⟲
        </span>
      )}
      {/* 只标了单端（还没按另一个）时，也给它一个竖头，让用户看到"这个音记下了" */}
      {!endId && startId && bands.length === 0 && <SingleTick page={page} id={startId} noteSize={noteSize} kind="start" />}
      {!startId && endId && bands.length === 0 && <SingleTick page={page} id={endId} noteSize={noteSize} kind="stop" />}
    </>
  )
}

/** 单端竖头（起止只标了一个时用；位置从该页音符里查） */
function SingleTick({
  page,
  id,
  noteSize,
  kind,
}: {
  page: ScorePageLike
  id: string
  noteSize: number
  kind: 'start' | 'stop'
}) {
  const m = /^(\d+)_(\d+)_(\d+)_(\d+)$/.exec(id)
  const idx = m ? Number(m[4]) : -1
  const n = page.notes.find((x) => x.id.index === idx)
  if (!n) return null
  const pct = (v: number) => `${((v / page.width) * 100).toFixed(3)}%`
  const pctY = (v: number) => `${((v / page.height) * 100).toFixed(3)}%`
  const y = n.y + noteSize * 1.15
  const h = noteSize * 0.55
  return (
    <div
      className={`practice-mark-tick practice-mark-tick-${kind}`}
      style={{ left: pct(kind === 'start' ? n.x : (n.rightX ?? n.x + 1)), top: pctY(y - h / 2), height: `${h}px` }}
    />
  )
}

/** 本层用到的页面形状（只取需要的字段，避免把 engine 的整套类型拖进来） */
export interface ScorePageLike {
  width: number
  height: number
  notes: readonly { id: { index: number; page?: number; voice?: number; group?: number }; x: number; y: number; rightX?: number }[]
}

/**
 * adj987k：按"**实际演奏到的音符 id 列表**"算出这一页上的线（按行切段）。
 *
 * 为什么不用"起止序号区间"：跨 `:|` 回跳/跳房子时，演奏顺序与源码顺序不一致
 * （用户口径 #5：「起始在停止后」也允许），按 id 列表画才能**跟着演奏走**。
 */
function bandsFromIds(page: ScorePageLike, ids: readonly string[], noteSize: number): { row: number; x0: number; x1: number; y: number }[] {
  const exact = new Set(ids)
  /** 宽松匹配的"组号+序号"尾巴（与引擎 `resolvePracticeRange` 同一口径：页号/声部号可能不一致） */
  const tails = new Set(
    ids.map((id) => {
      const m = /^(\d+)_(\d+)_(\d+)_(\d+)$/.exec(id)
      return m ? `_${m[3]}_${m[4]}` : id
    }),
  )
  const matchOf = (n: ScorePageLike['notes'][number]): boolean =>
    exact.has(noteIdOf(n)) || tails.has(`_${(n.id as { group?: number }).group ?? 0}_${n.id.index}`)
  const picked = page.notes.filter(matchOf)
  if (picked.length === 0) return []
  /**
   * adj1106 / adj1108（用户两次截图）：同一行里"没演奏的那一段"不能被一条长线横穿（跳房子/反复跳过）；
   * 但**连音线后段**（被合并进前一个音、没有独立事件）不能断——那里只有约一个音距。
   * ⇒ 用 3.8 个字号作阈值：整段跳过（≥4 个音）会断，连音线后段（≈1 个音）仍连上。
   */
  return splitIntoRuns(
    picked.map((n) => ({ x: n.x, y: n.y, rightX: n.rightX ?? n.x + 1 })),
    (n) => n.y,
    noteSize * 3.8,
  )
}

/** 音符 id 串（与引擎 `noteIdStringOf` 同形；这里只在本页里比对用） */
function noteIdOf(n: { id: { page?: number; voice?: number; group?: number; index: number } }): string {
  return `${n.id.page ?? 0}_${n.id.voice ?? 0}_${n.id.group ?? 0}_${n.id.index}`
}

/**
 * adj987y：在**本页**里找某个音符（用于定位"实际演奏的第一个音 / 最后一个音"）。
 *
 * 匹配口径与引擎一致：先整串，再退到"组号 + 序号"（预览与试听排版可能页号/声部号不同）。
 * 本页没有这个音就返回 `null` ⇒ 该页不画竖头/倒数（由拥有它的那一页画）。
 */
function posOfNoteId(
  page: ScorePageLike,
  id: string,
): { x: number; y: number; rightX: number } | null {
  const m = /^(\d+)_(\d+)_(\d+)_(\d+)$/.exec(id)
  const wantTail = m ? `_${m[3]}_${m[4]}` : null
  const n =
    page.notes.find((t) => noteIdOf(t) === id) ??
    (wantTail ? page.notes.find((t) => `_${(t.id as { group?: number }).group ?? 0}_${t.id.index}` === wantTail) : undefined)
  if (!n) return null
  return { x: n.x, y: n.y, rightX: n.rightX ?? n.x + 1 }
}
