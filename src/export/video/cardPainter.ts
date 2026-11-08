/**
 * export/video/cardPainter.ts — 片头卡 / 片尾卡的**画笔**（adj1265，从 `renderer.ts` 抽出）
 *
 * ## 为什么抽出来
 *
 * 原来这两张卡只画在"相机位（A4 竖屏）"那一路里，`paintCardBackdrop` / `paintCardBrackets` /
 * `paintCardSeal` / 标题正文全写在 `createDynamicSession` 的闭包里。M4 要让**连续动态谱**
 * （横滚谱、画布宽高取自视频）也带片头片尾 —— 如果照抄一份，两处迟早不同步
 * （本项目已经为"两套口径"付过多次代价）。
 *
 * 所以这里把"画一张卡"收成一个函数：**尺寸全从 `W`/`H` 算**，不认"9:16 相机位"，
 * 于是 640×360 的横屏视频、1080×1920 的竖屏手机视频、1:1 方图都走同一段代码。
 * 版式系数本来就按 `min(W,H)` 与宽高比分支（见 `cardLayout.ts`），这也是 §9.3 里
 * 「卡片怎么和视频宽高适配」的答案：**适配靠比例，不靠另做一套竖屏卡**。
 *
 * ## 纯不纯
 *
 * 与 `stripFrame` 一样，"画什么"只由入参 `t` 决定（扫光/粒子/淡入全部按 `t` 算，无随机数），
 * 因此预览与出片逐帧一致；位图（背景图/图片印章）由调用方**一次性解码**后传进来。
 */
import { brand } from '../../brand/tokens'
import { keySignatureOf, type ScorePageMeta } from '@ijipu/engine'
import {
  CARD_SANS,
  cardFontStack,
  cardImageRect,
  fitFontSize,
  sealFramePoints,
  sealImageRectOf,
  sealLayoutOf,
  type CardStyle,
} from './cardTemplates'
import { endCardLayout, tempoLineOf } from './cardLayout'

export type CardDrawCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface CardPainterOptions {
  /** 卡片样式（预设或用户模板） */
  card: CardStyle
  /** 已解码的背景图（没有 = null） */
  cardImage?: HTMLImageElement | null
  /** 已解码的图片印章（没有 = null；会退回文字印章） */
  sealImage?: HTMLImageElement | null
  /** 模板没指定字体时，标题用页面标题字体 */
  titleFont: string
  /** 正文字体（缺省 = 黑体系 `CARD_SANS`） */
  bodyFont?: string
}

/** 片头卡上的文字内容（从排版结果的第 1 页描述头来） */
export type CardIntroMeta = Pick<
  ScorePageMeta,
  'titles' | 'authors' | 'key' | 'meter' | 'tempo' | 'tempoNum' | 'tempoText'
>

export interface CardPainter {
  /** 背景层（渐变 / 背景图 / 光晕 / 五线谱 / 水印 / 粒子 / 扫光 / 暗角） */
  backdrop: (ctx: CardDrawCtx, W: number, H: number, t: number, mark: string) => void
  /** 四角取景括号 */
  brackets: (ctx: CardDrawCtx, W: number, H: number) => void
  /** 角落印章（图片优先，退回文字） */
  seal: (ctx: CardDrawCtx, W: number, H: number, t: number) => void
  /** 卡片文字的淡入/上浮曲线（0→1） */
  reveal: (t: number, delay: number, dur: number) => number
  /** 整张片头卡（含背景 + 括号 + 标题/副标题/作者/调号拍速/品牌 + 印章） */
  intro: (ctx: CardDrawCtx, W: number, H: number, t: number, alpha: number, meta: CardIntroMeta | null | undefined, bpm: number) => void
  /** 整张片尾卡（背景 + 括号 + 品牌名/强调线/标语/网址/短链 + 印章） */
  end: (ctx: CardDrawCtx, W: number, H: number, t: number, alpha: number, shortCode: string) => void
}

/**
 * 建一个卡片画笔。背景图/印章图只在建的时候取一次（不在每帧 `new Image`）。
 */
export function createCardPainter(opts: CardPainterOptions): CardPainter {
  const card = opts.card
  const cardImage = opts.cardImage ?? null
  const sealImage = opts.sealImage ?? null
  const font = opts.bodyFont ?? CARD_SANS
  /** 标题字体：模板指定 > 页面标题字体 > 内置黑体 */
  const titleFamily = cardFontStack(card.title.font, opts.titleFont, card.title.fontFamily)

  const reveal = (t: number, delay: number, dur: number): number => {
    const k = Math.max(0, Math.min(1, (t - delay) / dur))
    return k * k * (3 - 2 * k)
  }

  const backdrop = (ctx: CardDrawCtx, W: number, H: number, t: number, mark: string): void => {
    const unit = Math.min(W, H)
    const baseAlpha = ctx.globalAlpha
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, card.bg[0])
    g.addColorStop(0.55, card.bg[1])
    g.addColorStop(1, card.bg[2])
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    if (cardImage) {
      /**
       * 自定义背景图：cover 裁切 + 取景位置 + 额外放大，再压一层主题色，保证任何图上标题都可读。
       * adj1176：几何抽到 `cardImageRect`（与卡片对话框的小预览同源）。
       */
      const iw = cardImage.naturalWidth || W
      const ih = cardImage.naturalHeight || H
      const rect = cardImageRect(iw, ih, W, H, card.backgroundImagePos, card.backgroundImageZoom)
      ctx.drawImage(cardImage, rect.x, rect.y, rect.w, rect.h)
      ctx.fillStyle = card.bg[1]
      ctx.globalAlpha = baseAlpha * 0.55
      ctx.fillRect(0, 0, W, H)
      ctx.globalAlpha = baseAlpha
    }

    const glow = (x: number, y: number, r: number, color: string): void => {
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r)
      rg.addColorStop(0, color)
      rg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = rg
      ctx.fillRect(0, 0, W, H)
    }
    glow(W * 0.72, H * 0.26, H * 0.6, card.glow[0])
    glow(W * 0.16, H * 0.84, H * 0.52, card.glow[1])

    // 五线谱：横向细线，压在偏下位置，和音乐主题呼应
    if (card.staff.alpha > 0) {
      ctx.save()
      ctx.globalAlpha = baseAlpha * card.staff.alpha
      ctx.strokeStyle = card.staff.color
      ctx.lineWidth = 1
      for (let i = 0; i < 5; i++) {
        const y = H * 0.6 + i * H * 0.026
        ctx.beginPath()
        ctx.moveTo(W * 0.06, y)
        ctx.lineTo(W * 0.94, y)
        ctx.stroke()
      }
      ctx.restore()
    }

    // 大号水印：每个模板决定文字/颜色/透明度/大小/字体；空串不画
    // adj1176：允许不止一个字——按可用宽度自动收字号，长歌名也不会溢出画面
    if (mark && card.watermark.alpha > 0) {
      ctx.save()
      ctx.globalAlpha = baseAlpha * card.watermark.alpha
      ctx.fillStyle = card.watermark.color
      ctx.textAlign = 'right'
      const family = cardFontStack(card.watermark.font, opts.titleFont, card.watermark.fontFamily)
      const base = Math.max(8, Math.round(H * card.watermark.scale))
      const size = fitFontSize(
        (text, px) => {
          ctx.font = `700 ${px}px ${family}`
          return ctx.measureText(text).width
        },
        mark,
        base,
        W * 0.62,
      )
      ctx.font = `700 ${size}px ${family}`
      ctx.fillText(mark, W * 0.98, H * 0.84)
      ctx.restore()
    }

    // 细点粒子，缓慢明暗；位置固定，不随机
    if (card.particles) {
      ctx.save()
      ctx.fillStyle = card.accent
      for (let i = 0; i < 18; i++) {
        const x = (((i * 73) % 100) / 100) * W
        const y = (((i * 41) % 100) / 100) * H
        const a = 0.1 + 0.09 * Math.sin(t / 900 + i * 1.7)
        ctx.globalAlpha = baseAlpha * Math.max(0, a)
        ctx.beginPath()
        ctx.arc(x, y, Math.max(1, unit * 0.0015), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

    // 斜向扫光，6 秒一轮
    if (card.sweep) {
      ctx.save()
      ctx.globalAlpha = baseAlpha * 0.05
      const sx = ((t / 6000) % 1) * W * 1.6 - W * 0.3
      const sg = ctx.createLinearGradient(sx, 0, sx + W * 0.26, H)
      sg.addColorStop(0, 'rgba(0,0,0,0)')
      sg.addColorStop(0.5, card.accent)
      sg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = sg
      ctx.fillRect(0, 0, W, H)
      ctx.restore()
    }

    // 暗角：把视线收在中间；纸面模板只给一点点暖暗角
    if (card.vignette > 0) {
      const vg = ctx.createRadialGradient(
        W / 2,
        H / 2,
        Math.min(W, H) * 0.18,
        W / 2,
        H / 2,
        Math.max(W, H) * 0.72,
      )
      vg.addColorStop(0, `rgba(${card.vignetteColor},0)`)
      vg.addColorStop(1, `rgba(${card.vignetteColor},${card.vignette})`)
      ctx.fillStyle = vg
      ctx.fillRect(0, 0, W, H)
    }
  }

  /** adj1072：四角取景括号；颜色/强度由模板决定 */
  const brackets = (ctx: CardDrawCtx, W: number, H: number): void => {
    if (card.bracket.alpha <= 0) return
    const unit = Math.min(W, H)
    const baseAlpha = ctx.globalAlpha
    const pad = unit * 0.06
    const len = unit * 0.055
    ctx.save()
    ctx.globalAlpha = baseAlpha * card.bracket.alpha
    ctx.strokeStyle = card.bracket.color
    ctx.lineWidth = Math.max(1.2, unit * 0.0018)
    const corners: [number, number, number, number][] = [
      [pad, pad, 1, 1],
      [W - pad, pad, -1, 1],
      [pad, H - pad, 1, -1],
      [W - pad, H - pad, -1, -1],
    ]
    for (const [x, y, sx, sy] of corners) {
      ctx.beginPath()
      ctx.moveTo(x, y + sy * len)
      ctx.lineTo(x, y)
      ctx.lineTo(x + sx * len, y)
      ctx.stroke()
    }
    ctx.restore()
  }

  /**
   * adj1073：纸面/水墨的角落印章；品牌模板不画。
   *
   * adj1177（用户 2026-11-01）：「印章外框以适配文字大小的不规则椭圆形状为宜」。
   * 外框不再是固定正方形：`sealLayoutOf` 按文字算出包围盒（单字近圆、多字竖长），
   * `sealFramePoints` 再给一圈贴合文字、带轻微起伏的弧线——同一个印章每次渲染完全一致。
   */
  const seal = (ctx: CardDrawCtx, W: number, H: number, t: number): void => {
    if (!card.seal) return
    const unit = Math.min(W, H)
    const k = card.motion ? reveal(t, 1000, 500) : 1
    /**
     * adj1178：印章可以是一张图——有图就画图，大小/位置同样由 `size` / `x` / `y` 决定。
     * 图没解码成功（引用失效/图坏了）⇒ 退回下面的文字印章，不让片尾缺一块。
     */
    if (sealImage) {
      const rect = sealImageRectOf(
        sealImage.naturalWidth || 1,
        sealImage.naturalHeight || 1,
        W,
        H,
        card.seal.size,
        card.seal.x,
        card.seal.y,
      )
      ctx.save()
      ctx.globalAlpha = Math.max(0, Math.min(1, ctx.globalAlpha)) * k
      ctx.drawImage(sealImage, rect.x, rect.y, rect.w, rect.h)
      ctx.restore()
      return
    }
    const family = cardFontStack(card.seal.font, opts.titleFont, card.seal.fontFamily)
    /** 文字印章也吃 `size`：字号、外框、内边距一起按比例缩放 */
    const size = unit * 0.075 * (card.seal.size ?? 1)
    const layout = sealLayoutOf(card.seal.text, size, (text, px) => {
      ctx.font = `${px}px ${family}`
      return ctx.measureText(text).width
    })
    if (layout.chars.length === 0) return
    // 与图片印章同一口径：放得下就整枚留在画面里（0=贴左/上，1=贴右/下）
    const boxW = layout.boxW
    const boxH = layout.boxH
    const wantX = W * (card.seal.x ?? 0.86)
    const wantY = H * (card.seal.y ?? 0.84)
    const cx = boxW >= W ? W / 2 : Math.min(W - boxW / 2, Math.max(boxW / 2, wantX))
    const cy = boxH >= H ? H / 2 : Math.min(H - boxH / 2, Math.max(boxH / 2, wantY))
    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, ctx.globalAlpha)) * k
    ctx.strokeStyle = card.seal.color
    ctx.fillStyle = card.seal.color
    ctx.lineWidth = Math.max(1.4, unit * 0.0028)
    ctx.lineJoin = 'round'
    ctx.beginPath()
    const points = sealFramePoints(layout, cx, cy)
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    })
    ctx.closePath()
    ctx.stroke()
    ctx.font = `${Math.round(layout.font)}px ${family}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // 多字竖排：整列在外框里居中（单字就是中心）
    const top = cy - (layout.lineHeight * layout.chars.length) / 2
    layout.chars.forEach((ch, i) => {
      ctx.fillText(ch, cx, top + layout.lineHeight * (i + 0.5))
    })
    ctx.restore()
  }

  /**
   * 自制片头卡：深空蓝底 + 霓虹青强调线 + 描述头信息。
   * 版式只依赖 `min(W,H)` 与宽高比，因此 9:16 / 1:1 / 16:9 / 手机横竖屏看到的是同一张卡。
   */
  const intro = (
    ctx: CardDrawCtx,
    W: number,
    H: number,
    t: number,
    alpha: number,
    meta: CardIntroMeta | null | undefined,
    bpm: number,
  ): void => {
    const unit = Math.min(W, H)
    const title = (meta?.titles[0] ?? '').trim() || '未命名'
    const subtitle = (meta?.titles.slice(1).join(' ') ?? '').trim()
    const authors = (meta?.authors.join(' / ') ?? '').trim()
    /**
     * adj1118：速度那一行交给纯函数 `tempoLineOf`——
     * 对拍过（`beat` ≠ 谱面 `J:`）时写 **实际拍速 + （原谱 X）**，没对拍就写谱面的值。
     */
    const tempo = tempoLineOf(meta ?? undefined, bpm)
    const key = keySignatureOf(meta?.key ?? '')
    const rest = [meta?.meter ?? '', tempo].filter((p) => p.length > 0)
    /**
     * adj1072：三种比例不再只靠 min(W,H) 一套字号。
     * 9:16 内容宽、字号收一点；1:1 居中；16:9 标题更大、内容列收窄，避免"宽画布里一行太长"。
     */
    const aspect = W / H
    const tall = aspect < 0.8
    const wide = aspect > 1.3
    const titleScale = wide ? 1.14 : tall ? 1.0 : 1.04
    const maxW = W * (wide ? 0.78 : tall ? 0.86 : 0.84)
    const titleBase = Math.round(unit * 0.1 * titleScale)
    const subBase = Math.round(unit * (wide ? 0.048 : tall ? 0.042 : 0.045))
    const authorBase = Math.round(unit * (wide ? 0.034 : tall ? 0.031 : 0.033))
    const infoBase = Math.round(unit * (wide ? 0.027 : tall ? 0.025 : 0.026))
    const brandBase = Math.round(unit * (wide ? 0.021 : tall ? 0.02 : 0.021))
    const titleY = H * (wide ? 0.42 : tall ? 0.38 : 0.4)
    const lineRatio = wide ? 0.16 : tall ? 0.2 : 0.18
    const revealAt = (delay: number, dur: number): number => (card.motion ? reveal(t, delay, dur) : 1)
    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
    backdrop(ctx, W, H, t, card.watermark.intro)
    brackets(ctx, W, H)

    /** 先按宽度缩字号；`fillText` 再带 maxWidth 兜底，极长标题也不会溢出卡片 */
    const fit = (text: string, base: number, bold = false, family = font): number => {
      let size = Math.round(base)
      const min = Math.max(10, Math.round(base * 0.5))
      while (size > min) {
        ctx.font = `${bold ? 'bold ' : ''}${size}px ${family}`
        if (ctx.measureText(text).width <= maxW) break
        size -= 2
      }
      return size
    }

    ctx.textAlign = 'center'

    const titleSize = fit(title, titleBase, true, titleFamily)
    const titleE = revealAt(120, 650)
    const lineE = revealAt(420, 650)
    const subE = revealAt(560, 650)
    const authorE = revealAt(680, 650)
    const infoE = revealAt(800, 650)
    const brandE = revealAt(920, 650)

    // 标题：淡入 + 上浮 + 模板辉光 + 模板渐变
    ctx.save()
    ctx.globalAlpha = alpha * titleE
    ctx.shadowColor = card.title.glow
    ctx.shadowBlur = titleSize * 0.22
    const tg = ctx.createLinearGradient(0, titleY - titleSize, 0, titleY)
    tg.addColorStop(0, card.title.from)
    tg.addColorStop(1, card.title.to)
    ctx.fillStyle = tg
    ctx.font = `bold ${titleSize}px ${titleFamily}`
    ctx.fillText(title, W / 2, titleY + (1 - titleE) * unit * 0.025, maxW)
    ctx.restore()

    /**
     * adj1069：强调线放在**标题下方、下面内容之前**，位置按 `titleSize` 算。
     * adj1072：线从中间向两侧展开，并带一点光晕；宽度按比例（16:9 收窄、9:16 放宽）。
     */
    const accentY = titleY + titleSize * 0.6
    const lineW = W * lineRatio * lineE
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = card.accent
    ctx.shadowColor = card.accent
    ctx.shadowBlur = unit * 0.025
    ctx.fillRect(W / 2 - lineW / 2, accentY, lineW, Math.max(2, unit * 0.004))
    ctx.restore()

    let y = titleY + titleSize * 0.85
    if (subtitle) {
      const size = fit(subtitle, subBase)
      y += size * 1.2
      ctx.save()
      ctx.globalAlpha = alpha * subE
      ctx.fillStyle = card.subtitle
      ctx.font = `${size}px ${font}`
      ctx.fillText(subtitle, W / 2, y, maxW)
      ctx.restore()
    }
    if (authors) {
      const size = fit(authors, authorBase)
      y += size * 1.8
      ctx.save()
      ctx.globalAlpha = alpha * authorE
      ctx.fillStyle = card.author
      ctx.font = `${size}px ${font}`
      ctx.fillText(authors, W / 2, y, maxW)
      ctx.restore()
    }
    if (key.letter || rest.length > 0) {
      const base = infoBase
      /** 量整行宽（调号前缀 + 小角标 + 字母 + 拍号 + 速度），用于居中与缩放 */
      const measureLine = (size: number): number => {
        ctx.font = `${size}px ${font}`
        let w = 0
        if (key.letter) {
          w += ctx.measureText(key.prefix).width
          if (key.accidental) {
            ctx.font = `${Math.round(size * 0.75)}px ${font}`
            w += ctx.measureText(key.accidental).width
            ctx.font = `${size}px ${font}`
          }
          w += ctx.measureText(key.letter).width
        }
        for (const part of rest) {
          if (w > 0) w += ctx.measureText('   ').width
          w += ctx.measureText(part).width
        }
        return w
      }
      let size = base
      const min = Math.max(10, Math.round(base * 0.6))
      while (size > min && measureLine(size) > maxW) size -= 1
      const total = measureLine(size)
      y += size * 2.0
      let x = W / 2 - total / 2
      ctx.save()
      ctx.globalAlpha = alpha * infoE
      ctx.textAlign = 'left'
      if (key.letter) {
        ctx.font = `${size}px ${font}`
        const prefixW = ctx.measureText(key.prefix).width
        ctx.fillStyle = card.author
        ctx.fillText(key.prefix, x, y)
        x += prefixW
        if (key.accidental) {
          const symSize = Math.round(size * 0.75)
          ctx.font = `${symSize}px ${font}`
          ctx.fillStyle = card.accent
          ctx.fillText(key.accidental, x, y - size * 0.35)
          x += ctx.measureText(key.accidental).width
          ctx.font = `${size}px ${font}`
        }
        ctx.fillStyle = card.author
        ctx.fillText(key.letter, x, y)
        x += ctx.measureText(key.letter).width
      }
      ctx.fillStyle = card.info
      const separator = '   '
      let first = !key.letter
      for (const part of rest) {
        if (!first) {
          ctx.fillText(separator, x, y)
          x += ctx.measureText(separator).width
        }
        ctx.fillText(part, x, y)
        x += ctx.measureText(part).width
        first = false
      }
      ctx.textAlign = 'center'
      ctx.restore()
    }
    ctx.save()
    ctx.globalAlpha = alpha * brandE
    ctx.fillStyle = card.brand
    ctx.font = `${brandBase}px ${font}`
    ctx.fillText(`${brand.nameZh} ${brand.name}`, W / 2, H * 0.9, maxW)
    ctx.restore()
    seal(ctx, W, H, t)
    ctx.restore()
  }

  /** 品牌落版：模板背景 + 中英文名 + slogan + 网址；所有模板都必须展示品牌 */
  const end = (ctx: CardDrawCtx, W: number, H: number, t: number, alpha: number, shortCode: string): void => {
    const endTitleFont = titleFamily
    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
    backdrop(ctx, W, H, t, card.watermark.end)
    brackets(ctx, W, H)

    ctx.textAlign = 'center'
    /**
     * adj1066（用户 2026-10-22 实报「16:9 片尾内容重叠」）：字号按 `min(W,H)` 定、纵向位置按**字号**
     * 留足行距。adj1096：排版抽到纯函数 `cardLayout.ts`，按字号成比例给间距（可被 smoke 断言，不用渲位图）。
     */
    const unit = Math.min(W, H)
    const layout = endCardLayout(W, H)
    const titleSize = layout.titleSize
    const sloganSize = layout.sloganSize
    const urlSize = layout.urlSize
    const shortSize = layout.shortSize
    const titleY = layout.titleY
    const sloganY = layout.sloganY
    const urlY = layout.urlY
    const shortY = layout.shortY
    const maxW = layout.maxW
    const rawShort = (shortCode ?? '').trim()
    const shortPath = rawShort.match(/^(?:https?:\/\/[^/]+)?\/?s\/([a-z0-9]{3,6})\/?$/i)
    const shortUrl = /^https?:\/\/\S+$/i.test(rawShort)
      ? rawShort
      : shortPath
        ? `${brand.siteUrl}/s/${shortPath[1].toLowerCase()}`
        : /^[a-z0-9]{3,6}$/i.test(rawShort)
          ? `${brand.siteUrl}/s/${rawShort.toLowerCase()}`
          : ''
    // adj1069：强调线放在标题与标语之间，距离按 titleSize（三种比例同值），不再固定在标题上方
    const accentY = layout.accentY
    const lineRatio = layout.lineRatio
    const lineH = layout.lineH
    const revealAt = (delay: number, dur: number): number => (card.motion ? reveal(t, delay, dur) : 1)
    const titleE = revealAt(100, 650)
    const lineE = revealAt(380, 650)
    const sloganE = revealAt(500, 650)
    const urlE = revealAt(700, 650)

    // 品牌名：淡入 + 上浮 + 模板辉光 + 模板渐变
    ctx.save()
    ctx.globalAlpha = alpha * titleE
    ctx.shadowColor = card.title.glow
    ctx.shadowBlur = titleSize * 0.22
    const tg = ctx.createLinearGradient(0, titleY - titleSize, 0, titleY)
    tg.addColorStop(0, card.title.from)
    tg.addColorStop(1, card.title.to)
    ctx.fillStyle = tg
    ctx.font = `bold ${titleSize}px ${endTitleFont}`
    ctx.fillText(`${brand.nameZh} ${brand.name}`, W / 2, titleY + (1 - titleE) * unit * 0.025, maxW)
    ctx.restore()

    // 强调线：从中间展开 + 光晕
    const lineW = W * lineRatio * lineE
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = card.accent
    ctx.shadowColor = card.accent
    ctx.shadowBlur = unit * 0.025
    // adj1098：线高用排版函数给的值，保证"线中心 = 标题与标语墨迹的中点"只在一处定义
    ctx.fillRect(W / 2 - lineW / 2, accentY, lineW, lineH)
    ctx.restore()

    ctx.save()
    ctx.globalAlpha = alpha * sloganE
    ctx.fillStyle = card.subtitle
    ctx.font = `${sloganSize}px ${font}`
    ctx.fillText(brand.taglineMain, W / 2, sloganY + (1 - sloganE) * unit * 0.015)
    ctx.restore()

    ctx.save()
    ctx.globalAlpha = alpha * urlE
    ctx.fillStyle = card.url
    ctx.font = `${urlSize}px ${font}`
    /**
     * adj1112（用户 2026-10-23 反馈）：网址要**写完整**，不再剥掉 `https://`。
     * 原因：官网走的是 https，而人手动输入域名时浏览器默认补 `http://`
     * ⇒ 抄片尾那行「ijipu.pages.dev」可能打不开。这一行是给观众照抄的落款，就得能直接抄。
     */
    ctx.fillText(brand.siteUrl, W / 2, urlY)
    if (shortUrl) {
      ctx.font = `${shortSize}px ${font}`
      ctx.globalAlpha = alpha * urlE * 0.9
      ctx.fillText(shortUrl, W / 2, shortY)
    }
    ctx.restore()
    seal(ctx, W, H, t)
    ctx.restore()
  }

  return { backdrop, brackets, seal, reveal, intro, end }
}
