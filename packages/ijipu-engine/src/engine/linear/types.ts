/**
 * engine/linear/types.ts — 「连续动态谱」（单行滚动谱）的数据结构（adj1258）
 *
 * 和 `engine/dynamic` 的区别：
 *  - `dynamic` 是**竖着滚**（一行一行往下走，靠相机取景）；
 *  - `linear` 是**横着滚**（把全曲展开成一条单行谱，按时间从左往右排，靠视口平移）。
 *
 * 这里只放"一帧要用的纯数据"，出片与预览共用同一份（与 `dynamic` 同一条规矩：
 * 视频必须帧级可复现，所以时间轴上的每个数都得由 `t` 算出来，不读时钟、不读 DOM）。
 */
import type { ScorePage } from '../types'

/** 一次演奏里的一个小节（反复/跳转会带来多条） */
export interface StripRun {
  /** 源小节号（1 起；与 `PlaySequence.barNos` 同一个编号） */
  sourceBar: number
  /** 第几遍（1 起，便于排查与"第 N 遍换歌词"以后用） */
  pass: number
  /** 这一小节在时间轴上的起止（ms；已含片头位移） */
  t0: number
  t1: number
  /** 这一小节在条带上的 x 区间 */
  x0: number
  x1: number
  pageIndex: number
  rowIndex: number
}

/** 时间 → x 的样本（升序；滑到某一刻时用二分 + 线性插值） */
export interface StripNote {
  t0: number
  t1: number
  /** 数字左缘（条带坐标） */
  x: number
  /** 占宽（条带坐标） */
  w: number
  sourceBar: number
}

/** 单行谱丢弃了哪些元素（诊断与断言用；不是"静默丢"） */
export interface StripDropped {
  /** 跨小节、v1 不画的连音线/渐强记号（条数） */
  crossMeasure: number
  /** 超长小节被排版拆成多行时的后续碎片（条数） */
  fragment: number
  /** 非主声部的音符（条数） */
  extraVoice: number
}

/**
 * 一条单行谱。
 *
 * `page` 是**合成出来的一整页**（宽 = 全曲长度、高 = 一行），故意做成 `ScorePage`
 * 的形状，就是为了让 `renderScoreToSvg` 原样渲染 —— 字形、减时线、高低八度点、
 * 变音、倚音、歌词全部走既有渲染，不另造一套。
 */
export interface LinearStrip {
  page: ScorePage
  /** 条带总宽（px） */
  width: number
  /** 条带高（px；含高低八度点、歌词） */
  height: number
  /** 主基线在条带里的 y（数字基线） */
  baselineY: number
  runs: StripRun[]
  notes: StripNote[]
  /** 谱带字号（= 排版用的 note_size） */
  noteSize: number
  /** 每拍基准像素（界面显示"速度"、断言用它算密度） */
  pxPerBeat: number
  /** 一拍的毫秒数（与 `seq.bpm` 同源） */
  beatMs: number
  dropped: StripDropped
}

export interface LinearStripOptions {
  /**
   * 每拍像素。缺省按字号推（`note_size × 1.6`）。
   * 这是"谱面显示宽度"的主旋钮：越大越慢、一屏看到的拍数越少。
   */
  pxPerBeat?: number
  /** 主基线 y（缺省 = 字号 × 2.2，给上方高八度点与装饰记号留位） */
  baselineY?: number
  /** 是否带歌词（缺省 true；v1 只画第 1 条 C 行） */
  lyrics?: boolean
}
