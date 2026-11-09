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
  /**
   * 这个源小节第几次被演奏（1 起）。
   *
   * `adj1267`：多段歌词按它换行（第 2 次演奏用第 2 条 `C:` 行）。
   * 注意是**按小节**统计的 —— 不是"整首第几遍"（只反复一小段时，后面的段落也处在第 2 遍里）。
   */
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
  /**
   * 源谱里最多有**几段歌词**（`adj1267`）。
   *
   * 1 = 只有一条 `C:` 行（多遍唱同一段词）；>1 = 一个曲行下有多条 `C:` 行 ⇒
   * 条带按**这个源小节第几次被演奏**换行（第 2 次演奏显示第 2 行）。
   */
  lyricLines: number
  /**
   * adj1274：**曲部 / 词部**那条分界线在条带里的 y（台面画可拖的虚线用）。
   *
   * 位置取"谱表下沿"与"歌词字上沿"的中间；没有歌词时就是谱表下沿。
   */
  guideQuciY: number
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
  /**
   * 是否带歌词（缺省 true）。
   *
   * `adj1267`：**多段歌词按演奏遍次自动换行** —— 第 k 次演奏这个源小节就用第 k 条 `C:` 行
   * （超过段数就停在最后一段）。只画**主声部**那几行：第二声部的歌词行不参与换行，
   * 免得"第 2 遍"把另一个声部的词搬到主旋律下面。
   *
   * 关掉只**少画字**，不缩谱带（`height` 不变）——否则一按开关整条带跟着缩、字号也变了。
   */
  lyrics?: boolean
  /**
   * 是否在小节线**正上方**画小节号（缺省 false = 不画，用户 P3）。
   *
   * `adj1268`（用户 2026-11-09 拍板"小节号可放在小节线上方"）：A4 版里序号画在小节线**下方**，
   * 而条带下方正是歌词区 ⇒ 这里改画在上方（序号框底 = 小节线顶端）。
   * 第 1 段 run 没有小节线，也就不画号；反复段每出现一次都画（同一个源小节号）。
   */
  barNumbers?: boolean
  /**
   * adj1274（用户 2026-11-09）：**曲/词行间距**的额外量（px，正 = 词往下挪）。
   *
   * 用户在台面上拖"曲部/词部"那条虚线改的就是它；默认 0 = 完全按谱面排版来。
   * 为什么不用改 `height_quci`：那是**谱面级**（L2，跟着 .jps 走）的设置，
   * 这里只是"这条连续谱想怎么摆"，属于这首歌的台面外观（sidecar）。
   */
  lyricGap?: number
}
