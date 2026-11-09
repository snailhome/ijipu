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
 *
 * ## 歌词（adj1267）
 *
 * 一个曲行下有多条 `C:` 行 = 多段词。条带**按这个源小节第几次被演奏**换行：
 * 第 1 次画第 1 行、第 2 次画第 2 行……（`StripRun.pass`）。只画这段主声部的词，
 * 第二声部的歌词行不参与换行（`C1:`/`C2:` 也占 `line` 序号，会串段）。
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
  /** 这个源小节第几次被演奏（1 起）—— 多段歌词按它换行（`adj1267`） */
  pass: number
}

/**
 * 演奏顺序里的小节出现表。
 *
 * `barStartsMs` 末尾那条是**「曲末」时刻**（不是小节起点，见 `sequence.ts:3295`），
 * 且 `barNos` 只在小节起点记 ⇒ 取 `barNos.length` 为准，`t1` 用下一条起点/曲末。
 *
 * `pass` 的口径（`adj1267` 改）：**同一个小节号第几次出现**，不是"整首第几遍"。
 * 为什么不能用"整首第几遍"：反复只覆盖一小段时，后面的段落也处在第 2 遍里
 * （`… |: 5-8 :| 9-12` 里 9-12 的 pass 会是 2），那段明明只唱一次却会被换成第 2 段词。
 */
function occurrencesOf(seq: PlaySequence): Occurrence[] {
  const starts = seq.barStartsMs ?? []
  const nos = seq.barNos ?? starts.map((_, i) => i + 1)
  const out: Occurrence[] = []
  const seen = new Map<number, number>()
  for (let i = 0; i < nos.length; i++) {
    const t0 = starts[i] ?? 0
    const t1 = starts[i + 1] ?? seq.totalMs
    if (t1 - t0 < 0.5) continue
    const times = (seen.get(nos[i]) ?? 0) + 1
    seen.set(nos[i], times)
    out.push({ no: nos[i], t0, t1, pass: times })
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
 * 每条曲行有几段歌词（`adj1267`）：只看**主声部**、`line > 0` 的那几行。
 *
 * 为什么按**行**统计而不是按小节：多段歌词里某一小节可能只有一个长音、第二段词在那儿没有新字，
 * 按小节算就会让那一小节退回第 1 段词（同一句歌前后两段混着出来）。
 * 为什么只认主声部：`C1:`/`C2:` 这类按声部写的歌词行也占 `line` 序号，
 * 拿它换行会把第二声部的词搬到主旋律下面（条带只画主声部）。
 */
function verseLinesOfRows(measures: SrcMeasure[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of measures) {
    const mainVoice = mainVoiceOf(m.notes)
    let max = 0
    for (const l of m.lyrics) {
      const line = l.line ?? 0
      if (line <= 0) continue
      if (l.id.voice !== mainVoice) continue
      max = Math.max(max, line)
    }
    if (max === 0) continue
    const key = rowKeyOf(m)
    out.set(key, Math.max(out.get(key) ?? 0, max))
  }
  return out
}

/** 曲行身份（页 + 行）：歌词行序号是**每个曲部**各自从 0 数的（`layout/index.ts:6377`） */
const rowKeyOf = (m: SrcMeasure): string => `${m.pageIndex}|${m.rowIndex}`

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
  /** 每条曲行有几段歌词（`adj1267`；没有多段就是 0） */
  const verseLines = verseLinesOfRows(measures)

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
      /**
       * `adj1267`（用户 P2 的后续）：多段歌词**按这个源小节第几次演奏**换行。
       * `o.pass` = 1 用第 1 条 `C:` 行、= 2 用第 2 条……；超过段数就停在最后一段。
       * 这一小节在这一遍里没有那一段的字（长音跨过了）⇒ 就不画（不退回上一段，免得"串词"）。
       */
      const wantLine = Math.min(Math.max(0, o.pass - 1), verseLines.get(rowKeyOf(m)) ?? 0)
      for (const l of m.lyrics) {
        if ((l.line ?? 0) !== wantLine) continue
        page.lyrics.push({
          ...l,
          id: { ...l.id, index: noteIdx++ },
          // 第 1 个字的字左缘本来会比内容左缘再往左 1px 左右（字居中放在数字下），夹到 0 免得被裁掉
          x: Math.max(0, Math.round((x0 + (l.x - m.x0) * k) * 10) / 10),
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

  /**
   * 高度**与歌词开关无关**（`adj1267`）：关掉歌词只少画字，谱带不缩——
   * 条带在画布上的缩放是按 `height` 算的，一缩字号就跟着变（开关一按整幅画面跳一下）。
   */
  const height = baselineY + Math.round(noteSize * 1.9) + Math.round(cfg.geci_size * 1.4)
  let lyricLines = 1
  for (const v of verseLines.values()) lyricLines = Math.max(lyricLines, v + 1)

  return {
    page: { ...page, width: Math.max(1, cursor), height },
    width: Math.max(1, cursor),
    height,
    baselineY,
    lyricLines,
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
