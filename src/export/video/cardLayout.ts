/**
 * export/video/cardLayout.ts — 片尾卡的**纵向排版**（纯函数，可断言）
 *
 * 为什么单独抽出来：片尾的三行（品牌名 / 标语 / 网址）原来各写各的 `H × 百分比`，
 * 结果"标题贴着标语、标语到网址一大片空"。这里按**字号**成比例排，同一套系数三种画布居中，
 * 并且能被 smoke 直接断言（不用渲染位图）。
 *
 * 口径（用户 2026-10-23）：「标题和内容之间间距可以均衡点，有点太挤了」——
 *   · 品牌名基线 → 强调线：线**居中**在"标题墨迹下沿 ↔ 标语墨迹上沿"的空白带里（adj1098）；
 *   · 标题墨迹下沿 → 标语墨迹上沿：`1.1 × 标题字号`（adj1099；旧口径约 0.72×，用户要求再大些）；
 *   · 标语 → 网址：网址仍按 `H` 的百分比作"落款"（旧位置不变，不制造下半片空白）。
 *
 * 三个尺寸（9:16 / 1:1 / 16:9）的系数不同：16:9 标题更大、9:16 内容更宽，见下。
 */
export interface EndCardLayout {
  /** 品牌名字号 */
  titleSize: number
  /** 标语字号 */
  sloganSize: number
  /** 网址字号 */
  urlSize: number
  /** 短链字号（比网址小一档） */
  shortSize: number
  /** 品牌名基线 y */
  titleY: number
  /** 强调线 y（线的高点） */
  accentY: number
  /** 标语基线 y */
  sloganY: number
  /** 网址基线 y */
  urlY: number
  /** 短链基线 y */
  shortY: number
  /** 强调线高度（px）——渲染端用它画线，保证"线中心 = 中点"的口径只有一处 */
  lineH: number
  /** 文本最大宽度 */
  maxW: number
  /** 强调线长度占画布宽的比例 */
  lineRatio: number
}

/** 片尾卡纵向排版（W×H 为成片画布像素） */
export function endCardLayout(W: number, H: number): EndCardLayout {
  const unit = Math.min(W, H)
  const aspect = W / H
  const tall = aspect < 0.8
  const wide = aspect > 1.3
  const titleScale = wide ? 1.14 : tall ? 1.0 : 1.04
  const titleSize = Math.round(unit * 0.1 * titleScale)
  const sloganSize = Math.round(unit * (wide ? 0.05 : tall ? 0.043 : 0.045))
  const urlSize = Math.round(unit * (wide ? 0.034 : tall ? 0.03 : 0.032))
  /**
   * adj1099（用户 2026-10-23：「片尾标题与内容之间的间距还可以再大一些」）：
   * 把"标题墨迹下沿 → 标语墨迹上沿"的空白当成**设计参数**（`inkGap`），不再由两个乘数间接得到。
   *
   * 旧口径的空白 = `0.55×标题字号 + 0.4×标语字号` ≈ 0.72×标题字号（9:16 时 78px），用户觉得还挤；
   * 现在直接给 **1.1×标题字号**（9:16 时 119px，+53%）。线跟着两者中点走（adj1098），不用另调。
   */
  const titleY = H * (wide ? 0.42 : tall ? 0.4 : 0.42)
  const inkGap = titleSize * 1.1
  /** 标语基线：标题下伸部 + 空白带 + 标语上伸部 */
  const sloganY = titleY + titleSize * 0.2 + inkGap + sloganSize * 0.8
  const lineH = Math.max(2, unit * 0.004)
  const titleInkBottom = titleY + titleSize * 0.2
  const sloganInkTop = sloganY - sloganSize * 0.8
  const accentY = (titleInkBottom + sloganInkTop) / 2 - lineH / 2
  // 网址仍是"落款"，位置不动（旧版 0.8/0.72/0.76），免得片尾下沿空一片
  const urlY = H * (wide ? 0.8 : tall ? 0.72 : 0.76)
  const shortSize = Math.round(urlSize * 0.82)
  const shortY = urlY + urlSize * 1.8
  const maxW = W * (wide ? 0.8 : 0.86)
  const lineRatio = wide ? 0.14 : tall ? 0.18 : 0.16
  return { titleSize, sloganSize, urlSize, shortSize, titleY, accentY, sloganY, urlY, shortY, maxW, lineRatio, lineH }
}

/**
 * adj1118（用户 2026-10-24 定）：片头卡上的**速度那一行**怎么写。
 *
 * 规则（与"sidecar 只做对齐、不改谱面"同一口径）：
 *  - 没对拍（`usedBpm` 与谱面 `J:` 相同，误差 < 0.5）⇒ 就写谱面的值：`♩=80`；
 *  - 对拍了（不同）⇒ 写**实际**并标原值：`♩=96（原谱 80）`；
 *  - 谱面本来没有 `J:` ⇒ 有实际值就写实际值，没有就空串（不硬造）。
 *
 * 为什么取整：96.4 → 96；误差 <1 拍/分肉耳无感，写小数反而像机器输出。
 * 为什么保留 `tempoText`（`稍慢` 之类）：那是谱面作者的意图，跟"对拍得到的实际速度"不冲突，
 * 放在括号外面。
 *
 * 纯函数 ⇒ smoke 直接断言（不用渲染位图）。
 */
export function tempoLineOf(
  meta:
    | { tempoNum?: string | number | null; tempoText?: string | null; tempo?: string | null }
    | undefined,
  usedBpm: number,
): string {
  const rawNum = meta?.tempoNum
  const num =
    typeof rawNum === 'number'
      ? rawNum
      : typeof rawNum === 'string' && rawNum.trim() !== ''
        ? Number(rawNum)
        : Number.NaN
  const textRaw = meta?.tempoText
  const text = typeof textRaw === 'string' ? textRaw.trim() : ''
  const tail = text !== '' ? ` ${text}` : ''
  if (!Number.isFinite(num) || num <= 0) {
    return meta?.tempo ?? ''
  }
  const used = Math.round(usedBpm)
  if (!Number.isFinite(usedBpm) || usedBpm <= 0) return `♩=${Math.round(num)}${tail}`
  // 没对拍（或差不到半拍）⇒ 与谱面一致，不写"原谱"
  if (Math.abs(usedBpm - num) < 0.5) return `♩=${Math.round(num)}${tail}`
  return `♩=${used}（原谱 ${Math.round(num)}）${tail}`
}
