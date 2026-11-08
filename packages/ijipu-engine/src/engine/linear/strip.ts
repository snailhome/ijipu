/**
 * engine/linear/strip.ts — 多行谱 → 单行谱（方案 A：坐标重排），adj1258
 *
 * ## 做什么
 *
 * 拿**正常排版**的结果当"字形底稿"，按**演奏顺序**（`PlaySequence` 已展开反复/跳转）
 * 把每个源小节克隆出来，按时间横着排成一条线：
 *
 * ```
 * x(小节) = 累计宽度；小节内 x ∝ 时刻（每拍 W 像素）
 * ```
 *
 * ## 为什么不重排字形
 *
 * 数字、减时线、高低八度点、变音、倚音、歌词都是既有渲染画的；这里只做**仿射变换**
 * （平移 + 每小节一个横向量纲 k），字号与纵向层级一个字都不动 ——
 * 于是"A4 里什么样，条带上就什么样"，也天然满足"墨迹不重叠"那套规则。
 *
 * ## 反复/跳转怎么进来的
 *
 * 不在源码层展开（那是解析器的事），也不自己算反复——直接吃 `seq.barNos`
 * （逐遍记录、同一个源小节号会出现多次）：
 * 每出现一次就克隆一次，x 往后接。于是条带上**不存在**反复记号/跳房子/`&ds`/`&dc`/`&fine`。
 *
 * ## 行首小节线（用户 2026-11-08 点出的坑）
 *
 * 排版里行首的普通 `|` 不画、`|/` 隐藏线不画也不占位 ⇒ 拼接处会缺一根线。
 * 这里在**每个小节起点**补一根线（第一小节除外），类型按源线降级：
 * `|: :| :|:` → `|`（反复已展开，不再画反复记号）、`|/ |*` → `|`、`|| ||/` → `||`。
 */
import type {
  BarlineType,
  PageConfig,
  PlacedBarline,
  PlacedToken,
  ScoreLayout,
  ScorePage,
} from '../types'
import type { PlaySequence } from '../playback/sequence'
import { extractMeasures, type SrcMeasure } from './measures'
import type { LinearStrip, LinearStripOptions, StripNote, StripRun } from './types'

/** 一次演奏（一个小节的一条） */
interface Occurrence {
  no: number
  t0: number
  t1: number
  pass: number
}

/**
 * 演奏顺序里的小节出现表。
 *
 * `barStartsMs` 末尾那条是**「曲末」时刻**（不是小节起点，见 `sequence.ts:3295`），
 * 且 `barNos` 只在小节起点记 ⇒ 取 `barNos.length` 为准，`t1` 用下一条起点/曲末。
 */
function occurrencesOf(seq: PlaySequence): Occurrence[] {
  const starts = seq.barStartsMs ?? []
  const nos = seq.barNos ?? starts.map((_, i) => i + 1)
  const out: Occurrence[] = []
  let pass = 1
  for (let i = 0; i < nos.length; i++) {
    const t0 = starts[i] ?? 0
    const t1 = starts[i + 1] ?? seq.totalMs
    if (t1 - t0 < 0.5) continue
    if (i > 0 && nos[i] < nos[i - 1]) pass += 1
    out.push({ no: nos[i], t0, t1, pass })
  }
  return out
}

/** 源线条 → 条带上的线条（反复/跳房子一律降级；双线保留） */
export function stripBarlineTypeOf(type: BarlineType | undefined): BarlineType {
  if (type === '||' || type === '||/') return '||'
  // `|:` / `:|` / `:|:` / `|/` / `|*` / `|` 在单行谱里都只是"小节边界"
  return '|'
}

/** 主声部：一小节里最小的声部号（多声部块里 Q1 是主旋律） */
function mainVoiceOf(notes: PlacedToken[]): number {
  let v = Infinity
  for (const n of notes) v = Math.min(v, n.id.voice)
  return v === Infinity ? 1 : v
}

/** 取一小节里真正上条带的音符：只要主声部、且不是临时段层（`{bz}`/`{dsb}`/`{tp}`） */
function mainNotesOf(m: SrcMeasure): { notes: PlacedToken[]; skipped: number } {
  const v = mainVoiceOf(m.notes)
  const notes: PlacedToken[] = []
  let skipped = 0
  for (const n of m.notes) {
    if (n.segment !== undefined || n.id.voice !== v) {
      skipped += 1
      continue
    }
    notes.push(n)
  }
  return { notes, skipped }
}

/**
 * 克隆一个音符：x/占宽/拍段按 k 缩放、y 平移到条带基线。
 *
 * ⚠ `barIndex` **必须重编**（adj1263，看真图才发现的坑）：
 * 渲染端的 `computeBeams()` 按 `y|barIndex` 分组算减时线；条带把所有行压到**同一条基线**
 * （y 全一样）又原样继承了源小节的 `barIndex` ⇒ 一整行的小节被并成一组，
 * 减时线会从第 1 小节一路连到第 4 小节（实测出现过 1469px / 2912px 的横线）。
 * 条带上"一小节 = 一段 run"，所以每个 run 给一个唯一序号，减时线就只在本小节内连。
 */
function cloneNote(
  n: PlacedToken,
  x0: number,
  m: SrcMeasure,
  k: number,
  yShift: number,
  index: number,
  barIndex: number,
): PlacedToken {
  const mapX = (x: number): number => Math.round((x0 + (x - m.x0) * k) * 10) / 10
  const out: PlacedToken = {
    ...n,
    id: { ...n.id, index },
    x: mapX(n.x),
    y: Math.round((n.y + yShift) * 10) / 10,
    width: Math.round(n.width * k * 10) / 10,
    barIndex,
  }
  if (n.rightX !== undefined) out.rightX = mapX(n.rightX)
  if (n.inkLeftX !== undefined) out.inkLeftX = mapX(n.inkLeftX)
  if (n.segments !== undefined) {
    out.segments = n.segments.map((s) => ({
      ...s,
      x: mapX(s.x),
      perBeat: Math.round(s.perBeat * k * 10) / 10,
    }))
  }
  return out
}

/** 一条小节线（条带坐标） */
function barlineAt(x: number, yTop: number, yBottom: number, type: BarlineType): PlacedBarline {
  return {
    id: { page: 0, voice: 1, group: 1, index: 0 },
    type,
    x: Math.round(x * 10) / 10,
    yTop: Math.round(yTop * 10) / 10,
    yBottom: Math.round(yBottom * 10) / 10,
  } as PlacedBarline
}

/**
 * 建一条单行谱。
 *
 * @param layout 用**条带字号**排出来的版面（`note_size` 就是要显示的字号）
 * @param seq    整曲的播放序列（已展开反复/跳转）
 * @param cfg    与 layout 同一份页面配置
 */
export function buildLinearStrip(
  layout: ScoreLayout,
  seq: PlaySequence,
  cfg: PageConfig,
  opts: LinearStripOptions = {},
): LinearStrip {
  const noteSize = cfg.note_size
  const baselineY = opts.baselineY ?? Math.round(noteSize * 2.2)
  const withLyrics = opts.lyrics !== false
  const beatMs = seq.bpm > 0 ? 60000 / seq.bpm : 500
  const pxPerBeat = opts.pxPerBeat ?? Math.round(noteSize * 1.6)

  const measures = extractMeasures(layout, cfg)
  const byNo = new Map<number, SrcMeasure>()
  for (const m of measures) if (!byNo.has(m.no)) byNo.set(m.no, m)

  const occ = occurrencesOf(seq)
  const notes: StripNote[] = []
  const runs: StripRun[] = []
  const page: ScorePage = {
    index: 0,
    width: 1,
    height: 1,
    notes: [],
    lyrics: [],
    barlines: [],
    voiceBlocks: [],
    slurs: [],
    dynamics: [],
    brackets: [],
    barNumbers: [],
    meta: {
      titles: [],
      authors: [],
      key: null,
      meter: null,
      tempo: null,
      tempoNum: null,
      tempoText: null,
      instruments: [],
      notes: [],
    },
  }
  let cursor = 0
  let noteIdx = 0
  let droppedVoice = 0
  let droppedCross = 0
  const crossCounted = new Set<string>()

  for (let i = 0; i < occ.length; i++) {
    const o = occ[i]
    const m = byNo.get(o.no)
    if (m === undefined) continue
    const { notes: src, skipped } = mainNotesOf(m)
    droppedVoice += skipped
    if (src.length === 0) continue

    const srcW = Math.max(0.5, m.x1 - m.x0)
    const timeW = ((o.t1 - o.t0) / beatMs) * pxPerBeat
    // 只放大不压缩：密集小节按自己的自然宽走（宁可这一段慢一点，也不让字叠在一起）
    const k = Math.max(1, timeW / srcW)
    const yShift = baselineY - m.baselineY
    const x0 = cursor
    const x1 = x0 + srcW * k

    for (const n of src) {
      const c = cloneNote(n, x0, m, k, yShift, noteIdx, runs.length)
      noteIdx += 1
      page.notes.push(c)
      // 音符时刻：小节内按"离左边界多远"折算（与 x 的仿射同源，保证图和声对得上）
      const t0 = o.t0 + ((n.x - m.x0) / srcW) * (o.t1 - o.t0)
      const t1 = Math.min(o.t1, t0 + Math.max(1, n.duration) * beatMs)
      notes.push({
        t0: Math.round(t0 * 10) / 10,
        t1: Math.round(t1 * 10) / 10,
        x: c.x,
        w: c.width,
        sourceBar: m.no,
      })
    }

    if (withLyrics) {
      for (const l of m.lyrics) {
        if ((l.line ?? 0) !== 0) continue
        page.lyrics.push({
          ...l,
          id: { ...l.id, index: noteIdx++ },
          x: Math.round((x0 + (l.x - m.x0) * k) * 10) / 10,
          y: Math.round((l.y + yShift) * 10) / 10,
        })
      }
    }

    // 小节线：第一小节不画（条带从内容开始）；其余在小节起点补一根
    if (i > 0) {
      const prev = byNo.get(occ[i - 1].no)
      const type = prev?.endType === '||' || prev?.endType === '||/' ? '||' : stripBarlineTypeOf(m.leadType)
      page.barlines.push(barlineAt(x0, baselineY - noteSize * 1.75, baselineY + noteSize * 0.55, type))
    }

    runs.push({
      sourceBar: m.no,
      pass: o.pass,
      t0: Math.round(o.t0 * 10) / 10,
      t1: Math.round(o.t1 * 10) / 10,
      x0: Math.round(x0 * 10) / 10,
      x1: Math.round(x1 * 10) / 10,
      pageIndex: m.pageIndex,
      rowIndex: m.rowIndex,
    })
    cursor = x1
  }

  // 曲末的终止线（`||`）
  const lastOcc = occ[occ.length - 1]
  const lastMeasure = lastOcc ? byNo.get(lastOcc.no) : undefined
  if (lastMeasure?.endType === '||' || lastMeasure?.endType === '||/') {
    page.barlines.push(barlineAt(cursor, baselineY - noteSize * 1.75, baselineY + noteSize * 0.55, '||'))
  }

  // 跨小节的连音线/渐强：v1 不画（记数，别静默丢）
  for (const p of layout.pages) {
    for (const s of p.slurs) {
      const a = measureOfX(measures, p.index, s.x1)
      const b = measureOfX(measures, p.index, s.x2)
      if (a !== b && a >= 0) {
        const key = `${p.index}|${a}|${b}|${Math.round(s.x1)}`
        if (!crossCounted.has(key)) {
          crossCounted.add(key)
          droppedCross += 1
        }
      }
    }
  }

  const height = baselineY + Math.round(noteSize * 1.9) + (withLyrics ? Math.round(cfg.geci_size * 1.4) : 0)

  return {
    page: { ...page, width: Math.max(1, cursor), height },
    width: Math.max(1, cursor),
    height,
    baselineY,
    runs,
    notes,
    noteSize,
    pxPerBeat,
    beatMs,
    dropped: { crossMeasure: droppedCross, fragment: 0, extraVoice: droppedVoice },
  }
}

/** 某个页面坐标 x 落在第几号源小节（找不到 -1） */
function measureOfX(measures: SrcMeasure[], pageIndex: number, x: number): number {
  for (const m of measures) {
    if (m.pageIndex !== pageIndex) continue
    if (x >= m.x0 - 0.5 && x < m.x1 + 0.5) return m.no
  }
  return -1
}
