/**
 * dialogs/CardStyleDialog.tsx — 片头/片尾卡片的**模板库**与编辑（adj1074 / adj1176）
 *
 * 用户 2026-11-01 的需求（这条是重新设计的由来）：
 *  「每个曲子都有其适合的风格，换个曲子就调整为合适的风格，但再换回上一曲，并不会恢复」——
 *  所以卡片样式拆成两层：
 *   · **模板库**（这里编辑）：可命名、可保存/另存为/删除、可导入导出；公共一份，不随谱复制；
 *   · **每首谱用哪套**：记在 `xxx.jps.sync.json` 的 `card.template`（见 `store/syncExtras.ts`），
 *     相机位换模板时自动写入，换回那首谱再打开就恢复。
 *
 * 另外两条（同一次需求）：
 *  · 背景图不只"铺满居中"——可调左右/上下取景与放大（几何与出片共用 `cardImageRect`）；
 *  · 水印、印章不再限一个字——可写多字，水印/印章各自可选字体。
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Modal } from '../ui/Modal'
import { cardStyleCopy } from '../brand/copy'
import {
  CARD_TEMPLATES,
  cardFontStack,
  cardImageRect,
  cardStyleById,
  isBuiltInCardStyleId,
  normalizeCardStyle,
  resolveCardStyle,
  sealFramePoints,
  sealLayoutOf,
  type CardStyle,
  type CardTitleFont,
} from '../export/video/cardTemplates'
import { cardTemplateZipNameOf, createCardTemplateZip, readCardTemplateZip } from '../export/video/cardTemplateZip'
// adj1179：读本机已安装字体（Chromium Local Font Access；读不到可手打字体名）
import { COMMON_LOCAL_FONTS, canQueryLocalFonts, listLocalFontFamilies } from '../export/video/localFonts'
// adj1085：背景图外置（桌面落 files/、网页落 IndexedDB），配置里只留 `ijipu-blob:` 引用
import { dataUrlToBytes, imageBlobOf, resolveCardImage, saveCardImage } from '../store/cardImageStore'
import { recordCardTemplate } from '../store/syncExtras'
import { isTauriShell } from '../brand/env'
import { openPrefsDir } from '../store/prefs'
import { useDocStore } from '../store/docStore'
import { useUiStore, type DynamicCardStyleId } from '../store/uiStore'

const MAX_IMAGE_BYTES = 2_500_000
/** 水印字数上限（渲染端还会按宽度自动收字号） */
const WATERMARK_MAX_CHARS = 12
/** 印章字数上限（与 `sealLayoutOf` 一致；竖排多了排不下） */
const SEAL_MAX_CHARS = 6

/**
 * 系统“另存为”对话框的最小类型（File System Access API）。
 * 非 Chromium 内核 / 不支持该 API 的 WebView 会没有这个函数，走浏览器下载兜底。
 */
interface CardSaveHandle {
  name: string
  createWritable: () => Promise<{
    write: (data: ArrayBuffer) => Promise<void>
    close: () => Promise<void>
  }>
}
interface CardSavePickerOptions {
  suggestedName: string
  types: { description: string; accept: Record<string, string[]> }[]
}
type CardSavePicker = (opts: CardSavePickerOptions) => Promise<CardSaveHandle>

function cloneStyle(style: CardStyle): CardStyle {
  return {
    ...style,
    bg: [...style.bg],
    glow: [...style.glow],
    staff: { ...style.staff },
    watermark: { ...style.watermark },
    bracket: { ...style.bracket },
    title: { ...style.title },
    seal: style.seal ? { ...style.seal } : null,
    backgroundImagePos: { ...(style.backgroundImagePos ?? { x: 0.5, y: 0.5 }) },
  }
}

/** `#rgb` / `#rrggbb` / `rgb()` / `rgba()` → 颜色选择器要的 hex + 原 alpha */
function splitColor(value: string): { hex: string; alpha: number } {
  const rgba = /^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)(?:\D+([\d.]+))?\s*\)$/i.exec(value.trim())
  if (rgba) {
    const hex = `#${[rgba[1], rgba[2], rgba[3]]
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')}`
    return { hex, alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) }
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) return { hex: value, alpha: 1 }
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return {
      hex: `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`,
      alpha: 1,
    }
  }
  return { hex: '#000000', alpha: 1 }
}

function withAlpha(hex: string, alpha: number): string {
  if (alpha >= 1) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function ColorField({
  label,
  value,
  onChange,
  keepAlpha = false,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  keepAlpha?: boolean
}) {
  const { hex, alpha } = splitColor(value)
  return (
    <label className="card-style-color">
      <span>{label}</span>
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(keepAlpha ? withAlpha(e.target.value, alpha) : e.target.value)}
      />
    </label>
  )
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label className="card-style-range">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <em>{value.toFixed(2)}</em>
    </label>
  )
}

/**
 * 字体选择：预设三档 + **本机字体**（adj1179）。
 *
 * 为什么不是"下拉里列一堆系统字体"：系统装了什么只有本机知道；这里用
 * `<input list>` 做成可输入的下拉——读到本机字体列表就能挑，读不到也能手打字体名。
 * 本机字体留空时用上面的预设，所以旧模板/旧观感不变。
 */
function FontField({
  label,
  value,
  onChange,
  family,
  onFamilyChange,
}: {
  label: string
  value: CardTitleFont
  onChange: (v: CardTitleFont) => void
  family?: string
  onFamilyChange: (v: string) => void
}) {
  return (
    <>
      <label className="card-style-field">
        <span>{label}</span>
        <select value={value} onChange={(e) => onChange(e.target.value as CardTitleFont)}>
          <option value="score">{cardStyleCopy.fontScore}</option>
          <option value="serif">{cardStyleCopy.fontSerif}</option>
          <option value="sans">{cardStyleCopy.fontSans}</option>
        </select>
      </label>
      <label className="card-style-field">
        <span>{cardStyleCopy.localFont}</span>
        <input
          type="text"
          list="ijipu-card-local-fonts"
          value={family ?? ''}
          maxLength={120}
          placeholder={cardStyleCopy.localFontPlaceholder}
          onChange={(e) => onFamilyChange(e.target.value)}
        />
      </label>
    </>
  )
}

export function CardStyleDialog() {
  const current = useUiStore((s) => s.dynamicCardStyle)
  const cardTemplates = useUiStore((s) => s.cardTemplates)
  /** adj1186：印章效果预览要用与成片相同的标题字体（"跟谱面标题"时） */
  const pageConfig = useDocStore((s) => s.pageConfig)
  /** adj1176：背景图预览按相机位当前画布比例（9:16 / 1:1 / 16:9），看到的就是导出会用的取景 */
  const aspect = useUiStore((s) => s.dynamicCamera.aspect)
  const previewDims =
    aspect === '9x16' ? { w: 270, h: 480 } : aspect === '1x1' ? { w: 360, h: 360 } : { w: 480, h: 270 }
  const saveCardTemplate = useUiStore((s) => s.saveCardTemplate)
  const deleteCardTemplate = useUiStore((s) => s.deleteCardTemplate)
  const setDynamicCardStyle = useUiStore((s) => s.setDynamicCardStyle)
  const closeModal = useUiStore((s) => s.closeModal)

  /** 当前在编辑哪一套：`''` = 还没入库（保存时才生成 id） */
  const initial = resolveCardStyle(current, cardTemplates)
  const initialOwned = cardTemplates.some((t) => t.id === initial.id)
  const [draftId, setDraftId] = useState<string>(initialOwned ? initial.id : '')
  const [draft, setDraft] = useState<CardStyle>(() => cloneStyle(initial))
  const [name, setName] = useState(initialOwned ? initial.name : '')
  /**
   * adj1182：起点模板要**跟着模板存**。旧模板没有 `baseId`（样式已烘焙），
   * 回退到"当前就是内置预设就用它，否则 brand"。
   */
  const initialBase: DynamicCardStyleId =
    initial.baseId !== undefined && isBuiltInCardStyleId(initial.baseId)
      ? initial.baseId
      : isBuiltInCardStyleId(current)
        ? current
        : 'brand'
  const [base, setBase] = useState<DynamicCardStyleId>(initialBase)
  const [imageError, setImageError] = useState('')
  const [sealImageError, setSealImageError] = useState('')
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [sealPreviewSrc, setSealPreviewSrc] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [msgError, setMsgError] = useState(false)
  /** adj1179：本机字体列表（先给常见字体提示，读到系统列表再合并；不落盘） */
  const [localFonts, setLocalFonts] = useState<string[]>(COMMON_LOCAL_FONTS)
  const [fontMsg, setFontMsg] = useState('')
  /** 当前环境有没有 Local Font Access 接口（用于把"为什么列不出来"直接写在界面上） */
  const localFontApi = canQueryLocalFonts()
  const previewRef = useRef<HTMLCanvasElement | null>(null)
  /** adj1186：朱砂印章效果预览（右侧小画布，文字印章按成片同一套几何画） */
  const sealCanvasRef = useRef<HTMLCanvasElement | null>(null)
  /** adj1176：在预览上按住拖动 = 调取景位置（与滑块同一份 `backgroundImagePos`） */
  const dragRef = useRef<{ x: number; y: number; pos: { x: number; y: number }; w: number; h: number } | null>(null)
  const zipInputRef = useRef<HTMLInputElement | null>(null)

  /** 背景图可能是 `ijipu-blob:` 引用：预览要先解析成 data URL（旧 data URL 原样用） */
  useEffect(() => {
    let alive = true
    void resolveCardImage(draft.backgroundImage).then((url) => {
      if (alive) setPreviewSrc(url)
    })
    return () => {
      alive = false
    }
  }, [draft.backgroundImage])

  /** adj1178：印章图片同样是 `ijipu-blob:` 引用，缩略图要先解析 */
  useEffect(() => {
    let alive = true
    void resolveCardImage(draft.seal?.image).then((url) => {
      if (alive) setSealPreviewSrc(url)
    })
    return () => {
      alive = false
    }
  }, [draft.seal?.image])

  /**
   * adj1186（用户 2026-11-02）：卡片模板对话框的「朱砂印章」右侧显示**效果预览**。
   *
   * 用与成片完全相同的 `sealLayoutOf` / `sealFramePoints` / `cardFontStack` 画到小画布上：
   * 文字、字体、颜色、字号、字数变化都能当场看到；图片印章则直接显示图片。
   */
  useEffect(() => {
    const canvas = sealCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)
    const seal = draft.seal
    if (!seal || seal.image) return
    const family = cardFontStack(seal.font, pageConfig.biaoti_font, seal.fontFamily)
    const scale = Math.min(2.5, Math.max(0.4, seal.size ?? 1))
    const layout = sealLayoutOf(seal.text, Math.min(W, H) * 0.36 * scale, (text, px) => {
      ctx.font = `${px}px ${family}`
      return ctx.measureText(text).width
    })
    if (layout.chars.length === 0) return
    // 放大后可能超出画布：等比缩到 82% 以内（预览只负责看效果，不改变保存值）
    const fit = Math.min(1, (W * 0.82) / Math.max(1, layout.boxW), (H * 0.82) / Math.max(1, layout.boxH))
    const boxW = layout.boxW * fit
    const boxH = layout.boxH * fit
    const font = layout.font * fit
    const lineHeight = layout.lineHeight * fit
    const cx = W / 2
    const cy = H / 2
    const points = sealFramePoints({ ...layout, boxW, boxH }, cx, cy)
    ctx.save()
    ctx.strokeStyle = seal.color
    ctx.fillStyle = seal.color
    ctx.lineWidth = Math.max(1.6, Math.min(W, H) * 0.009)
    ctx.lineJoin = 'round'
    ctx.beginPath()
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    })
    ctx.closePath()
    ctx.stroke()
    ctx.font = `${Math.round(font)}px ${family}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const top = cy - (lineHeight * layout.chars.length) / 2
    layout.chars.forEach((ch, i) => {
      ctx.fillText(ch, cx, top + lineHeight * (i + 0.5))
    })
    ctx.restore()
  }, [draft.seal, pageConfig.biaoti_font])

  /**
   * 背景图取景预览：直接按出片同一套几何（`cardImageRect`）画到小画布上。
   * 不拿 CSS `object-position` 近似——"框里看到的 = 导出的"是本项目一贯的口径。
   */
  useEffect(() => {
    const canvas = previewRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (previewSrc === null) return
    let alive = true
    const img = new Image()
    img.onload = () => {
      if (!alive) return
      const W = canvas.width
      const H = canvas.height
      ctx.clearRect(0, 0, W, H)
      const r = cardImageRect(img.naturalWidth, img.naturalHeight, W, H, draft.backgroundImagePos, draft.backgroundImageZoom)
      ctx.drawImage(img, r.x, r.y, r.w, r.h)
    }
    img.src = previewSrc
    return () => {
      alive = false
    }
  }, [previewSrc, draft.backgroundImagePos, draft.backgroundImageZoom, aspect])

  const patch = (p: Partial<CardStyle>) => setDraft((d) => ({ ...d, ...p }))

  /** adj1179：按需读本机字体列表；失败/不支持时只提示，不挡手打字体名 */
  const loadLocalFonts = useCallback(async () => {
    try {
      const list = await listLocalFontFamilies()
      setLocalFonts([...new Set([...COMMON_LOCAL_FONTS, ...list])])
      setFontMsg(cardStyleCopy.localFontsLoaded(list.length))
    } catch {
      setLocalFonts(COMMON_LOCAL_FONTS)
      setFontMsg(cardStyleCopy.localFontsUnavailable)
    }
  }, [])

  /**
   * adj1181：桌面壳打开对话框就**自动**读一次系统字体（GDI 命令，不弹权限框），
   * 这样用户要的字体直接就在候选里；网站/开发浏览器仍要点按钮（浏览器 API 需要授权）。
   */
  useEffect(() => {
    if (isTauriShell()) void loadLocalFonts()
  }, [loadLocalFonts])

  /** 预览上拖动：手指/鼠标往哪拖，图片跟着往哪走（取景点反向移动） */
  const onPreviewDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = previewRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const pos = draft.backgroundImagePos ?? { x: 0.5, y: 0.5 }
    dragRef.current = { x: e.clientX, y: e.clientY, pos: { ...pos }, w: rect.width, h: rect.height }
    canvas.setPointerCapture(e.pointerId)
  }
  const onPreviewMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d) return
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
    const dx = (e.clientX - d.x) / Math.max(1, d.w)
    const dy = (e.clientY - d.y) / Math.max(1, d.h)
    patch({ backgroundImagePos: { x: clamp01(d.pos.x - dx), y: clamp01(d.pos.y - dy) } })
  }
  const onPreviewUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  const applyBase = (id: DynamicCardStyleId) => {
    setBase(id)
    setImageError('')
    // 起点模板跟着草稿走（保存时写进 `baseId`，下次打开还能看到是从哪个预设起手的）
    setDraft({ ...cloneStyle(cardStyleById(id)), baseId: id as CardStyle['baseId'] })
  }

  const selectTemplate = (t: CardStyle) => {
    setDraftId(t.id)
    setName(t.name)
    setDraft(cloneStyle(t))
    setBase(isBuiltInCardStyleId(t.baseId) ? (t.baseId as DynamicCardStyleId) : 'brand')
    setMsg('')
    setMsgError(false)
  }

  /** 新开一份草稿（不入库）：基于当前起点模板 */
  const newDraft = () => {
    setDraftId('')
    setName('')
    setDraft({ ...cloneStyle(resolveCardStyle(base, cardTemplates)), baseId: base as CardStyle['baseId'] })
    setMsg('')
    setMsgError(false)
  }

  const remember = (id: string) => {
    setDynamicCardStyle(id)
    // adj1176：把"这首歌用哪套"写进 sidecar（换回这首谱时会恢复）
    recordCardTemplate(id)
  }

  const doSave = () => {
    const finalName = name.trim() || '我的卡片'
    // adj1182：保存后**不关窗**（用户要求继续调整/连续保存）；起点模板一起存
    // adj1187：把"是否真的落盘"如实反馈到保存按钮旁边
    const res = saveCardTemplate({ ...draft, id: draftId, name: finalName, baseId: base as CardStyle['baseId'] })
    setDraftId(res.id)
    setName(finalName)
    remember(res.id)
    setMsgError(!res.persisted)
    setMsg(res.persisted ? cardStyleCopy.savedOk(finalName) : cardStyleCopy.saveFailed(finalName))
  }

  const doSaveAs = () => {
    const finalName = `${(name.trim() || '我的卡片').slice(0, 34)} 副本`
    const res = saveCardTemplate({ ...draft, id: '', name: finalName, baseId: base as CardStyle['baseId'] })
    setDraftId(res.id)
    setName(finalName)
    remember(res.id)
    setMsgError(!res.persisted)
    setMsg(res.persisted ? cardStyleCopy.savedOk(finalName) : cardStyleCopy.saveFailed(finalName))
  }

  const doDelete = () => {
    if (draftId === '') return
    const hit = cardTemplates.find((t) => t.id === draftId)
    if (hit === undefined) return
    if (!window.confirm(cardStyleCopy.deleteConfirm(hit.name))) return
    const wasCurrent = current === draftId
    deleteCardTemplate(draftId)
    const next = { ...cloneStyle(cardStyleById('brand')), baseId: 'brand' as CardStyle['baseId'] }
    setDraftId('')
    setName('')
    setDraft(next)
    setBase('brand')
    // 正在用这套 ⇒ store 已切回 brand，sidecar 也同步改成 brand（别留下一个指向已删模板的引用）
    if (wasCurrent) remember('brand')
    setMsgError(false)
    setMsg(cardStyleCopy.deleted(hit.name))
  }

  const onPickImage = async (file: File | null) => {
    if (!file) return
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(cardStyleCopy.imageTooLarge)
      return
    }
    setImageError('')
    try {
      // adj1085：存到「附件」（桌面 files/、网页 IndexedDB），配置里只留引用
      const ref = await saveCardImage(file)
      setDraft((d) => ({ ...d, backgroundImage: ref }))
    } catch (e) {
      setImageError(e instanceof Error ? e.message : String(e))
    }
  }

  /** adj1178：选择印章图片（同样存成外置引用；旧图在保存模板时再回收） */
  const onPickSealImage = async (file: File | null) => {
    if (!file) return
    if (file.size > MAX_IMAGE_BYTES) {
      setSealImageError(cardStyleCopy.imageTooLarge)
      return
    }
    setSealImageError('')
    try {
      const ref = await saveCardImage(file)
      setDraft((d) => (d.seal ? { ...d, seal: { ...d.seal, image: ref } } : d))
    } catch (e) {
      setSealImageError(e instanceof Error ? e.message : String(e))
    }
  }

  const exportZip = async () => {
    try {
      // 导出 zip 里要放**图片本体**：引用先解析回 data URL（旧格式原样返回）
      const resolved = await resolveCardImage(draft.backgroundImage)
      // adj1178：印章图片也一起解析，zip 里单独放 seal-image.*
      const resolvedSeal = draft.seal
        ? { ...draft.seal, image: await resolveCardImage(draft.seal.image) }
        : null
      const bytes = createCardTemplateZip({
        ...draft,
        backgroundImage: resolved,
        seal: resolvedSeal,
        name: name.trim() || draft.name,
      })
      // TS 6 的 BlobPart 只认 ArrayBuffer；这里复制一份，避开 Uint8Array<ArrayBufferLike> 的类型冲突
      const buffer = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(buffer).set(bytes)

      // 优先系统“另存为”：让用户选目录和文件名，默认名已填好
      const picker = (window as unknown as { showSaveFilePicker?: CardSavePicker }).showSaveFilePicker
      // adj1184：默认文件名 = `ijipu-card-<模板名>.zip`（非法字符替换、空名用「未命名」）
      const suggested = cardTemplateZipNameOf(name.trim() || draft.name)
      if (typeof picker === 'function') {
        try {
          const handle = await picker({
            suggestedName: suggested,
            types: [{ description: 'iJipu 卡片模板', accept: { 'application/zip': ['.zip'] } }],
          })
          const writable = await handle.createWritable()
          await writable.write(buffer)
          await writable.close()
          setMsgError(false)
          setMsg(`${cardStyleCopy.exported}：${handle.name}`)
          return
        } catch (e) {
          if ((e as { name?: string } | null)?.name === 'AbortError') {
            setMsgError(false)
            setMsg(cardStyleCopy.cancelled)
            return
          }
          // 权限/不支持该 API → 退回浏览器下载（不能再谎报“已保存”）
        }
      }

      const blob = new Blob([buffer], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = suggested
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setMsgError(false)
      setMsg(cardStyleCopy.exported)
    } catch (e) {
      setMsgError(true)
      setMsg(`${cardStyleCopy.exportFailed}：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * 导入 = **直接加入模板库**（用户口径："保存后可加入卡片列表"）。
   * 导入的图片从 data URL 转成外置引用，避免又把几 MB 塞回配置。
   */
  const onPickZip = async (file: File | null) => {
    if (!file) return
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const style = readCardTemplateZip(bytes)
      let backgroundImage = style.backgroundImage
      if (backgroundImage?.startsWith('data:image/')) {
        const parsed = dataUrlToBytes(backgroundImage)
        if (parsed !== null) backgroundImage = await saveCardImage(imageBlobOf(parsed.bytes, parsed.mime))
      }
      // adj1178：印章图片也从 data URL 转成外置引用
      let seal = style.seal
      if (seal?.image?.startsWith('data:image/')) {
        const parsed = dataUrlToBytes(seal.image)
        if (parsed !== null) seal = { ...seal, image: await saveCardImage(imageBlobOf(parsed.bytes, parsed.mime)) }
      }
      const finalName = (style.name || '导入的模板').slice(0, 40)
      const res = saveCardTemplate({ ...style, id: '', name: finalName, backgroundImage, seal })
      const saved = normalizeCardStyle({ ...style, id: res.id, name: finalName, backgroundImage, seal })
      setDraftId(res.id)
      setName(finalName)
      setDraft(cloneStyle(saved))
      setBase(isBuiltInCardStyleId(saved.baseId) ? (saved.baseId as DynamicCardStyleId) : 'brand')
      remember(res.id)
      setMsgError(!res.persisted)
      setMsg(
        res.persisted
          ? `${cardStyleCopy.imported}：${finalName}`
          : `${cardStyleCopy.importedUnsaved}：${finalName}`,
      )
    } catch (e) {
      setMsgError(true)
      setMsg(`${cardStyleCopy.importFailed}：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (zipInputRef.current) zipInputRef.current.value = ''
    }
  }

  const owned = cardTemplates.find((t) => t.id === draftId)

  return (
    <Modal title={cardStyleCopy.title} fill width={720}>
      <div className="card-style-form">
        <div className="card-style-scroll">
          <p className="card-style-intro">{cardStyleCopy.intro}</p>

          {/* adj1176：模板库（新建 / 选中 / 另存为 / 删除）；保存后立刻出现在相机位下拉里 */}
          <section className="card-style-section" data-card="library">
            <h3>{cardStyleCopy.library}</h3>
            <div className="card-style-templates">
              {cardTemplates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`card-style-template${t.id === draftId ? ' is-on' : ''}`}
                  data-template={t.id}
                  onClick={() => selectTemplate(t)}
                >
                  {t.name}
                </button>
              ))}
              {cardTemplates.length === 0 && (
                <span className="card-style-intro">{cardStyleCopy.noTemplates}</span>
              )}
            </div>
            <div className="card-style-grid card-style-name-row">
              <label className="card-style-field">
                <span>{cardStyleCopy.nameLabel}</span>
                <input
                  type="text"
                  value={name}
                  maxLength={40}
                  placeholder={cardStyleCopy.namePlaceholder}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            </div>
            <div className="card-style-row">
              <button type="button" className="btn card-style-new" onClick={newDraft}>
                {cardStyleCopy.newTemplate}
              </button>
              <button type="button" className="btn card-style-copy" onClick={doSaveAs}>
                {cardStyleCopy.saveAs}
              </button>
              <button
                type="button"
                className="btn card-style-delete"
                onClick={doDelete}
                disabled={draftId === '' || owned === undefined}
              >
                {cardStyleCopy.deleteTemplate}
              </button>
              {isTauriShell() && (
                <button
                  type="button"
                  className="btn card-style-open-dir"
                  onClick={() => {
                    void openPrefsDir().catch((e: unknown) => {
                      setMsgError(true)
                      setMsg(`${cardStyleCopy.openConfigDirFailed}${e instanceof Error ? e.message : String(e)}`)
                    })
                  }}
                >
                  {cardStyleCopy.openConfigDir}
                </button>
              )}
            </div>
            <p className="card-style-intro">{cardStyleCopy.nameHint}</p>
          </section>

          <section className="card-style-section">
            <div className="card-style-grid">
              <label className="card-style-field">
                <span>{cardStyleCopy.base}</span>
                <select data-card="base" value={base} onChange={(e) => applyBase(e.target.value)}>
                  {CARD_TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <FontField
                label={cardStyleCopy.font}
                value={draft.title.font}
                onChange={(v) => setDraft((d) => ({ ...d, title: { ...d.title, font: v } }))}
                family={draft.title.fontFamily}
                onFamilyChange={(v) => setDraft((d) => ({ ...d, title: { ...d.title, fontFamily: v } }))}
              />
            </div>
            <p className="card-style-intro">{cardStyleCopy.fontHint}</p>
            {/* adj1179：读本机字体列表（读不到不挡手打字名） */}
            <div className="card-style-row">
              <button
                type="button"
                className="btn"
                onClick={() => void loadLocalFonts()}
                title={cardStyleCopy.localFontHint}
              >
                {cardStyleCopy.loadLocalFonts}
              </button>
              <span className="card-style-intro">
                {fontMsg || (localFontApi ? cardStyleCopy.localFontHint : cardStyleCopy.localFontsUnavailable)}
              </span>
            </div>
            <p className="card-style-intro">{cardStyleCopy.localFontManual}</p>
            <datalist id="ijipu-card-local-fonts">
              {localFonts.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </section>

          <section className="card-style-section">
            <h3>{cardStyleCopy.background}</h3>
            <div className="card-style-grid">
              <ColorField
                label={cardStyleCopy.bgTop}
                value={draft.bg[0]}
                onChange={(v) => patch({ bg: [v, draft.bg[1], draft.bg[2]] })}
              />
              <ColorField
                label={cardStyleCopy.bgMid}
                value={draft.bg[1]}
                onChange={(v) => patch({ bg: [draft.bg[0], v, draft.bg[2]] })}
              />
              <ColorField
                label={cardStyleCopy.bgBottom}
                value={draft.bg[2]}
                onChange={(v) => patch({ bg: [draft.bg[0], draft.bg[1], v] })}
              />
              <ColorField
                label={cardStyleCopy.accent}
                value={draft.accent}
                onChange={(v) => patch({ accent: v })}
              />
            </div>
          </section>

          <section className="card-style-section">
            <h3>{cardStyleCopy.textColors}</h3>
            <div className="card-style-grid">
              <ColorField
                label={cardStyleCopy.titleFrom}
                value={draft.title.from}
                onChange={(v) => setDraft((d) => ({ ...d, title: { ...d.title, from: v } }))}
              />
              <ColorField
                label={cardStyleCopy.titleTo}
                value={draft.title.to}
                onChange={(v) => setDraft((d) => ({ ...d, title: { ...d.title, to: v } }))}
              />
              <ColorField
                label={cardStyleCopy.subtitle}
                value={draft.subtitle}
                keepAlpha
                onChange={(v) => patch({ subtitle: v })}
              />
              <ColorField
                label={cardStyleCopy.author}
                value={draft.author}
                keepAlpha
                onChange={(v) => patch({ author: v })}
              />
              <ColorField
                label={cardStyleCopy.info}
                value={draft.info}
                keepAlpha
                onChange={(v) => patch({ info: v })}
              />
              <ColorField
                label={cardStyleCopy.brand}
                value={draft.brand}
                keepAlpha
                onChange={(v) => patch({ brand: v })}
              />
              <ColorField
                label={cardStyleCopy.url}
                value={draft.url}
                keepAlpha
                onChange={(v) => patch({ url: v })}
              />
            </div>
          </section>

          <section className="card-style-section">
            <h3>{cardStyleCopy.watermark}</h3>
            <div className="card-style-grid">
              <label className="card-style-field">
                <span>{cardStyleCopy.watermarkIntro}</span>
                <input
                  type="text"
                  maxLength={WATERMARK_MAX_CHARS}
                  value={draft.watermark.intro}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      watermark: { ...d.watermark, intro: e.target.value },
                    }))
                  }
                />
              </label>
              <label className="card-style-field">
                <span>{cardStyleCopy.watermarkEnd}</span>
                <input
                  type="text"
                  maxLength={WATERMARK_MAX_CHARS}
                  value={draft.watermark.end}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, watermark: { ...d.watermark, end: e.target.value } }))
                  }
                />
              </label>
              <ColorField
                label={cardStyleCopy.watermarkColor}
                value={draft.watermark.color}
                onChange={(v) => setDraft((d) => ({ ...d, watermark: { ...d.watermark, color: v } }))}
              />
              <FontField
                label={cardStyleCopy.watermarkFont}
                value={draft.watermark.font ?? 'sans'}
                onChange={(v) => setDraft((d) => ({ ...d, watermark: { ...d.watermark, font: v } }))}
                family={draft.watermark.fontFamily}
                onFamilyChange={(v) =>
                  setDraft((d) => ({ ...d, watermark: { ...d.watermark, fontFamily: v } }))
                }
              />
            </div>
            <div className="card-style-row">
              <RangeField
                label={cardStyleCopy.watermarkAlpha}
                value={draft.watermark.alpha}
                min={0}
                max={0.2}
                step={0.005}
                onChange={(v) => setDraft((d) => ({ ...d, watermark: { ...d.watermark, alpha: v } }))}
              />
              <RangeField
                label={cardStyleCopy.watermarkScale}
                value={draft.watermark.scale}
                min={0.2}
                max={0.9}
                step={0.01}
                onChange={(v) => setDraft((d) => ({ ...d, watermark: { ...d.watermark, scale: v } }))}
              />
            </div>
            <p className="card-style-intro">{cardStyleCopy.watermarkHint}</p>
          </section>

          <section className="card-style-section">
            <h3>{cardStyleCopy.effects}</h3>
            <div className="card-style-row">
              <label className="card-style-check">
                <input
                  type="checkbox"
                  checked={draft.particles}
                  onChange={(e) => patch({ particles: e.target.checked })}
                />
                <span>{cardStyleCopy.particles}</span>
              </label>
              <label className="card-style-check">
                <input
                  type="checkbox"
                  checked={draft.sweep}
                  onChange={(e) => patch({ sweep: e.target.checked })}
                />
                <span>{cardStyleCopy.sweep}</span>
              </label>
              <label className="card-style-check">
                <input
                  type="checkbox"
                  checked={draft.motion}
                  onChange={(e) => patch({ motion: e.target.checked })}
                />
                <span>{cardStyleCopy.motion}</span>
              </label>
            </div>
            <div className="card-style-row">
              <RangeField
                label={cardStyleCopy.staffAlpha}
                value={draft.staff.alpha}
                min={0}
                max={0.12}
                step={0.005}
                onChange={(v) => setDraft((d) => ({ ...d, staff: { ...d.staff, alpha: v } }))}
              />
              <RangeField
                label={cardStyleCopy.vignette}
                value={draft.vignette}
                min={0}
                max={0.8}
                step={0.02}
                onChange={(v) => patch({ vignette: v })}
              />
            </div>
          </section>

          <section className="card-style-section" data-card="seal">
            <h3>{cardStyleCopy.seal}</h3>
            <div className="card-style-seal-layout">
              <div className="card-style-seal-controls">
            <div className="card-style-row">
              <label className="card-style-check">
                <input
                  type="checkbox"
                  checked={!!draft.seal}
                  onChange={(e) =>
                    patch({
                      // 勾上时保留已经调过的图片/大小/位置（从 null 打开才用默认值）
                      seal: e.target.checked
                        ? { text: '谱', color: draft.accent, font: 'serif', ...draft.seal }
                        : null,
                    })
                  }
                />
                <span>{cardStyleCopy.seal}</span>
              </label>
              {draft.seal && (
                <>
                  <label className="card-style-field">
                    <span>{cardStyleCopy.sealText}</span>
                    <input
                      type="text"
                      maxLength={SEAL_MAX_CHARS}
                      value={draft.seal.text}
                      onChange={(e) => patch({ seal: { ...draft.seal!, text: e.target.value } })}
                    />
                  </label>
                  <FontField
                    label={cardStyleCopy.sealFont}
                    value={draft.seal.font ?? 'serif'}
                    onChange={(v) => patch({ seal: { ...draft.seal!, font: v } })}
                    family={draft.seal.fontFamily}
                    onFamilyChange={(v) => patch({ seal: { ...draft.seal!, fontFamily: v } })}
                  />
                  <ColorField
                    label={cardStyleCopy.sealColor}
                    value={draft.seal.color}
                    onChange={(v) => patch({ seal: { ...draft.seal!, color: v } })}
                  />
                </>
              )}
            </div>
            {draft.seal && (
              <>
                <p className="card-style-intro">{cardStyleCopy.sealHint}</p>
                {/* adj1178：印章也可以直接用图片（有图时优先画图） */}
                <div className="card-style-row">
                  <label className="btn card-style-file">
                    {cardStyleCopy.chooseSealImage}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => void onPickSealImage(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  {draft.seal.image && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => patch({ seal: { ...draft.seal!, image: null } })}
                    >
                      {cardStyleCopy.clearSealImage}
                    </button>
                  )}
                  {sealPreviewSrc && (
                    <img className="card-style-seal-thumb" src={sealPreviewSrc} alt={cardStyleCopy.seal} />
                  )}
                </div>
                <p className="card-style-intro">{cardStyleCopy.sealImageHint}</p>
                <div className="card-style-pos">
                  <RangeField
                    label={cardStyleCopy.sealSize}
                    value={draft.seal.size ?? 1}
                    min={0.4}
                    max={2.5}
                    step={0.05}
                    onChange={(v) => patch({ seal: { ...draft.seal!, size: v } })}
                  />
                  <RangeField
                    label={cardStyleCopy.sealX}
                    value={draft.seal.x ?? 0.86}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(v) => patch({ seal: { ...draft.seal!, x: v } })}
                  />
                  <RangeField
                    label={cardStyleCopy.sealY}
                    value={draft.seal.y ?? 0.84}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(v) => patch({ seal: { ...draft.seal!, y: v } })}
                  />
                </div>
                <p className="card-style-intro">{cardStyleCopy.sealPosHint}</p>
              </>
            )}
            {sealImageError && <p className="card-style-error">{sealImageError}</p>}
              </div>
              {/* adj1186：右侧效果预览（背景取模板的中间色，红印直接看得出对比） */}
              <div
                className="card-style-seal-effect"
                data-card="seal-effect"
                style={{ background: draft.bg[1] }}
              >
                <span className="card-style-seal-effect-label">{cardStyleCopy.sealEffect}</span>
                {!draft.seal ? (
                  <span className="card-style-seal-effect-off">{cardStyleCopy.sealEffectOff}</span>
                ) : draft.seal.image ? (
                  sealPreviewSrc ? (
                    <img
                      className="card-style-seal-effect-img"
                      src={sealPreviewSrc}
                      alt={cardStyleCopy.sealEffect}
                      style={{ width: `${Math.round(96 * Math.min(2.5, Math.max(0.4, draft.seal.size ?? 1)))}px` }}
                    />
                  ) : (
                    <span className="card-style-seal-effect-off">{cardStyleCopy.sealEffectOff}</span>
                  )
                ) : (
                  <canvas ref={sealCanvasRef} className="card-style-seal-effect-canvas" width={320} height={320} />
                )}
              </div>
            </div>
          </section>

          <section className="card-style-section" data-card="image">
            <h3>{cardStyleCopy.backgroundImage}</h3>
            <div className="card-style-image">
              {draft.backgroundImage ? (
                <canvas
                  ref={previewRef}
                  className="card-style-image-canvas"
                  width={previewDims.w}
                  height={previewDims.h}
                  title={cardStyleCopy.imagePosHint}
                  onPointerDown={onPreviewDown}
                  onPointerMove={onPreviewMove}
                  onPointerUp={onPreviewUp}
                  onPointerCancel={onPreviewUp}
                />
              ) : (
                <span>{cardStyleCopy.imageHint}</span>
              )}
            </div>
            <div className="card-style-row">
              <label className="btn card-style-file">
                {cardStyleCopy.chooseImage}
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => onPickImage(e.target.files?.[0] ?? null)}
                />
              </label>
              {draft.backgroundImage && (
                <button type="button" className="btn" onClick={() => patch({ backgroundImage: null })}>
                  {cardStyleCopy.clearImage}
                </button>
              )}
            </div>
            {draft.backgroundImage && (
              <div className="card-style-pos">
                <RangeField
                  label={cardStyleCopy.imagePosX}
                  value={draft.backgroundImagePos?.x ?? 0.5}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(v) =>
                    patch({ backgroundImagePos: { x: v, y: draft.backgroundImagePos?.y ?? 0.5 } })
                  }
                />
                <RangeField
                  label={cardStyleCopy.imagePosY}
                  value={draft.backgroundImagePos?.y ?? 0.5}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(v) =>
                    patch({ backgroundImagePos: { x: draft.backgroundImagePos?.x ?? 0.5, y: v } })
                  }
                />
                <RangeField
                  label={cardStyleCopy.imageZoom}
                  value={draft.backgroundImageZoom ?? 1}
                  min={1}
                  max={3}
                  step={0.01}
                  onChange={(v) => patch({ backgroundImageZoom: v })}
                />
                <p className="card-style-intro">{cardStyleCopy.imagePosHint}</p>
              </div>
            )}
            {imageError && <p className="card-style-error">{imageError}</p>}
          </section>

          <section className="card-style-section">
            <h3>{cardStyleCopy.migrate}</h3>
            <div className="card-style-row">
              <button type="button" className="btn card-style-export" onClick={exportZip}>
                {cardStyleCopy.exportZip}
              </button>
              <label className="btn card-style-file">
                {cardStyleCopy.importZip}
                <input
                  ref={zipInputRef}
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(e) => void onPickZip(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>
            <p className="card-style-intro">{cardStyleCopy.migrateHint}</p>
          </section>
        </div>

        <div className="card-style-footer">
          {/* adj1187：保存/导入结果固定显示在**底栏**，不用滚到最下面才看得到 */}
          {msg && (
            <span
              className={`card-style-footer-status ${msgError ? 'card-style-error' : 'card-style-ok'}`}
              data-card="save-status"
              role="status"
              aria-live="polite"
            >
              {msg}
            </span>
          )}
          <button type="button" className="btn" onClick={() => applyBase(base)}>
            {cardStyleCopy.reset}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setDraftId('')
              setName('')
              setBase('brand')
              setDraft({ ...cloneStyle(cardStyleById('brand')), baseId: 'brand' as CardStyle['baseId'] })
            }}
          >
            {cardStyleCopy.resetAll}
          </button>
          <button type="button" className="btn" onClick={closeModal}>
            {cardStyleCopy.cancel}
          </button>
          <button type="button" className="btn card-style-save" onClick={doSave}>
            {cardStyleCopy.save}
          </button>
        </div>
      </div>
    </Modal>
  )
}
