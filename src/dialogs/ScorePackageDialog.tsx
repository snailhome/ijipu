/**
 * dialogs/ScorePackageDialog.tsx — 导出乐谱包（zip，adj1195 / adj1205）
 *
 * 乐谱包是**运输单元**，不是发布信息编辑器：
 *   meta.json（slug/short/title/composer/assets/overlay）+ README.md + score.jps + assets/
 *
 * 许可 / 来源 / rights / tags / 难度 等发布信息由**私有乐谱库工具**维护；
 * 应用不再维护 `.jps.meta.json`，导出时也不带这些字段。
 * 规则见官网仓 `docs/SCORE-PKG.md`。
 */
import { useMemo, useState } from 'react'
import { mimeOf } from '@ijipu/engine'
import { Modal } from '../ui/Modal'
import { useDocStore } from '../store/docStore'
import { useUiStore } from '../store/uiStore'
import { getOverlaySnapshot } from '../store/overlayAssets'
import { base64ToBytes, writeZip, type ZipEntry } from '../export/zip'
import { scorePackageCopy as C } from '../brand/copy'
import { APP_VERSION } from '../brand/version'

type Role = 'background' | 'watermark'

interface FormState {
  title: string
  composer: string
  slug: string
  short: string
}

function stripExt(name: string): string {
  return name.replace(/\.(jps|md|txt)$/i, '')
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s !== '' ? s : `score-${Date.now().toString(36)}`
}

function shortify(slug: string): string {
  const letters = slug.replace(/[^a-z]/g, '')
  if (letters.length >= 3) return letters.slice(0, 6)
  return `pkg${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 1) || 'x'}`
}

function today(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function mimeOfHref(href: string, fallbackPath: string): string {
  const m = /^data:([^;,]+)/.exec(href)
  if (m) return m[1]
  return mimeOf(fallbackPath)
}

function extOfMime(mime: string): string {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/bmp') return 'bmp'
  return ''
}

async function bytesOfHref(href: string): Promise<Uint8Array> {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(href)
  if (m) {
    if (m[2] === ';base64') return base64ToBytes(m[3])
    return new TextEncoder().encode(decodeURIComponent(m[3]))
  }
  const res = await fetch(href)
  if (!res.ok) throw new Error('图片读取失败')
  return new Uint8Array(await res.arrayBuffer())
}

/** 包里的 README 只讲“这是什么、怎么打开”，不讲发布信息 */
function readmeOf(meta: {
  title: string
  composer: string
  slug: string
  assets: { path: string; role: string }[]
}): string {
  return [
    `# ${meta.title}`,
    '',
    `- 作曲 / 作词：${meta.composer}`,
    `- 页面：https://ijipu.pages.dev/scores/${meta.slug}/`,
    '',
    '用「爱记谱 iJipu」打开 `score.jps` 即可查看 / 试听 / 编辑。',
    '应用：https://ijipu.pages.dev/app/',
    '',
    '发布信息（许可 / 来源 / rights / tags 等）由「爱记谱乐谱库管理工具」在导入后维护。',
    '',
    '资源：',
    ...(meta.assets.length > 0 ? meta.assets.map((a) => `- ${a.path}（${a.role}）`) : ['- 无']),
    '',
  ].join('\n')
}

export function ScorePackageDialog() {
  const closeModal = useUiStore((s) => s.closeModal)
  const showNotice = useUiStore((s) => s.showNotice)
  const code = useDocStore((s) => s.code)
  const fileName = useDocStore((s) => s.fileName)
  const parseResult = useDocStore((s) => s.parseResult)
  const pageConfig = useDocStore((s) => s.pageConfig)

  const defaults = useMemo<FormState>(() => {
    const title = (parseResult.header.titles[0] ?? '').trim() || stripExt(fileName || '未命名') || '未命名'
    const composer = (parseResult.header.authors[0] ?? '').trim() || '佚名'
    const slug = slugify(stripExt(fileName || '') || title)
    return { title, composer, slug, short: shortify(slug) }
  }, [parseResult.header.titles, parseResult.header.authors, fileName])

  const [form, setForm] = useState<FormState>(defaults)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const assetPlan = useMemo(() => {
    const snap = getOverlaySnapshot()
    const out: { role: Role; href: string; source: string }[] = []
    if (pageConfig.bgEnabled && pageConfig.bgImage.trim() !== '' && snap.assets?.bg) {
      out.push({ role: 'background', href: snap.assets.bg.href, source: pageConfig.bgImage })
    }
    if (
      pageConfig.wmEnabled &&
      pageConfig.wmType === 'image' &&
      pageConfig.wmImage.trim() !== '' &&
      snap.assets?.wm
    ) {
      out.push({ role: 'watermark', href: snap.assets.wm.href, source: pageConfig.wmImage })
    }
    return out
  }, [pageConfig])

  const assetSummary = useMemo(() => {
    const parts: string[] = []
    if (assetPlan.length > 0) parts.push(C.assetsOn(assetPlan.length))
    const text = pageConfig.wmText.trim()
    if (pageConfig.wmEnabled && pageConfig.wmType === 'text' && text !== '') {
      parts.push(C.assetsText(text))
    }
    return parts.length > 0 ? parts.join('；') : C.assetsNone
  }, [assetPlan, pageConfig.wmEnabled, pageConfig.wmType, pageConfig.wmText])

  const set = <K extends keyof FormState,>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const doExport = async (): Promise<void> => {
    setErr(null)
    const title = form.title.trim()
    const composer = form.composer.trim()
    if (title === '') return setErr(C.needTitle)
    if (composer === '') return setErr(C.needComposer)
    if (!/^[a-z0-9-]+$/.test(form.slug)) return setErr(C.badSlug)
    if (!/^[a-z]{3,6}$/.test(form.short)) return setErr(C.badShort)
    const snap = getOverlaySnapshot()
    if (pageConfig.bgEnabled && pageConfig.bgImage.trim() === '') {
      return setErr('背景已开启，但还没选择背景图')
    }
    if (pageConfig.bgEnabled && pageConfig.bgImage.trim() !== '' && !snap.assets?.bg) {
      return setErr('背景图开启了但没解析到图片：请先在图层面板里重新选择背景图')
    }
    if (pageConfig.wmEnabled && pageConfig.wmType === 'image' && pageConfig.wmImage.trim() === '') {
      return setErr('图形水印已开启，但还没选择水印图')
    }
    if (
      pageConfig.wmEnabled &&
      pageConfig.wmType === 'image' &&
      pageConfig.wmImage.trim() !== '' &&
      !snap.assets?.wm
    ) {
      return setErr('图形水印开启了但没解析到图片：请先重新选择水印图')
    }

    setBusy(true)
    try {
      const files: ZipEntry[] = []
      const assets: { path: string; role: Role }[] = []
      for (const plan of assetPlan) {
        const bytes = await bytesOfHref(plan.href)
        const mime = mimeOfHref(plan.href, plan.source)
        const ext = extOfMime(mime)
        if (ext === '') throw new Error(`不支持的图片类型：${mime}`)
        const path = `assets/${plan.role === 'background' ? 'bg' : 'wm'}.${ext}`
        files.push({ name: path, data: bytes })
        assets.push({ path, role: plan.role })
      }

      const overlay = {
        bg: {
          enabled: pageConfig.bgEnabled,
          scale: pageConfig.bgScale,
          rotate: pageConfig.bgRotate,
          opacity: pageConfig.bgOpacity,
          offsetX: pageConfig.bgOffsetX,
          offsetY: pageConfig.bgOffsetY,
        },
        wm: {
          enabled: pageConfig.wmEnabled,
          type: pageConfig.wmType,
          text: pageConfig.wmText,
          size: pageConfig.wmSize,
          scale: pageConfig.wmScale,
          rotate: pageConfig.wmRotate,
          opacity: pageConfig.wmOpacity,
          repeat: pageConfig.wmRepeat,
          repeatGap: pageConfig.wmRepeatGap,
          offsetX: pageConfig.wmOffsetX,
          offsetY: pageConfig.wmOffsetY,
        },
      }
      // 只带“运输信息”；许可/rights/source/tags 等发布信息由乐谱库工具维护
      const meta = {
        format: 'ijipu-score-package',
        version: 1,
        slug: form.slug,
        short: form.short,
        title,
        composer,
        exportedAt: today(),
        exportedBy: `iJipu ${APP_VERSION}`,
        ...(assets.length > 0 ? { assets } : {}),
        overlay,
      }

      const encoder = new TextEncoder()
      files.unshift(
        { name: 'meta.json', data: encoder.encode(JSON.stringify(meta, null, 2) + '\n') },
        { name: 'README.md', data: encoder.encode(readmeOf({ ...meta, assets })) },
        { name: 'score.jps', data: encoder.encode(code) },
      )

      const zip = writeZip(files)
      // adj1226：记住这首歌的短链，动态谱视频片尾直接拿来用
      try {
        localStorage.setItem(`ijipu.videoShort.${fileName || 'untitled'}`, form.short)
      } catch {
        /* 存不下只影响视频片尾默认值 */
      }
      const out = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer
      const blob = new Blob([out], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${form.slug}.zip`
      a.click()
      URL.revokeObjectURL(url)
      showNotice(C.done)
      closeModal()
    } catch (e) {
      setErr(C.fail(e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={C.title} width={720} fill>
      <div className="score-pkg">
        <div className="score-pkg-scroll">
          <p className="score-pkg-intro">{C.intro}</p>
          <div className="score-pkg-grid">
            <label className="score-pkg-field">
              <span>{C.fieldTitle}</span>
              <input className="score-pkg-input" value={form.title} onChange={(e) => set('title', e.target.value)} />
            </label>
            <label className="score-pkg-field">
              <span>{C.fieldComposer}</span>
              <input className="score-pkg-input" value={form.composer} onChange={(e) => set('composer', e.target.value)} />
            </label>
            <label className="score-pkg-field">
              <span>{C.fieldSlug}</span>
              <input className="score-pkg-input" value={form.slug} onChange={(e) => set('slug', e.target.value)} />
            </label>
            <label className="score-pkg-field">
              <span>{C.fieldShort}</span>
              <input className="score-pkg-input" value={form.short} onChange={(e) => set('short', e.target.value)} />
            </label>
          </div>
          <div className="score-pkg-assets">
            {assetSummary}
          </div>
          <p className="score-pkg-hint">{C.hint}</p>
          {err !== null && <div className="score-pkg-err">{err}</div>}
        </div>
        <div className="score-pkg-actions">
          <button type="button" className="btn" onClick={closeModal} disabled={busy}>
            {C.cancelBtn}
          </button>
          <button type="button" className="btn primary" onClick={() => void doExport()} disabled={busy}>
            {busy ? C.busy : C.exportBtn}
          </button>
        </div>
      </div>
    </Modal>
  )
}
