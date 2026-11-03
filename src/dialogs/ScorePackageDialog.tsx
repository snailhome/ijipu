/**
 * dialogs/ScorePackageDialog.tsx — 导出乐谱包（zip，adj1195）
 *
 * 乐谱包是**发布/交流单元**，不是普通图片导出：
 *   meta.json + README.md + score.jps + assets/（背景/水印）
 *
 * 规则见官网仓 `docs/SCORE-PKG.md`。应用侧只负责"把当前文档和已解析的图上打成包"，
 * 校验/入库/同步交给私有乐谱库工具。
 */
import { useEffect, useMemo, useState } from 'react'
import { mimeOf } from '@ijipu/engine'
import { Modal } from '../ui/Modal'
import { useDocStore } from '../store/docStore'
import { useUiStore } from '../store/uiStore'
import { getOverlaySnapshot } from '../store/overlayAssets'
import { loadScoreMetaFor, type ScoreRights } from '../store/scoreMeta'
import { base64ToBytes, writeZip, type ZipEntry } from '../export/zip'
import { scoreMetaCopy as M, scorePackageCopy as C } from '../brand/copy'

type Role = 'background' | 'watermark'
type License = 'PD' | 'ORIGINAL' | 'AUTHORIZED' | 'CC'

interface FormState {
  title: string
  composer: string
  license: License
  source: string
  tags: string
  slug: string
  short: string
  difficulty: string
  excerpt: string
  note: string
  arrangement: string
  ccLicense: string
  attribution: string
  sourceUrl: string
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

function readmeOf(meta: {
  title: string
  composer: string
  source: string
  license: string
  slug: string
  assets: { path: string; role: string }[]
}): string {
  const license = meta.license === 'PD' ? '公版' : meta.license === 'CC' ? 'CC' : meta.license === 'ORIGINAL' ? '原创' : '已授权'
  return [
    `# ${meta.title}`,
    '',
    `- 作曲 / 作词：${meta.composer}`,
    `- 来源：${meta.source}`,
    `- 许可：${license}（记谱/排版 CC BY-NC-SA 4.0；商用请联系作者）`,
    `- 页面：https://ijipu.pages.dev/scores/${meta.slug}/`,
    '',
    '用「爱记谱 iJipu」打开 `score.jps` 即可查看 / 试听 / 编辑。',
    '应用：https://ijipu.pages.dev/app/',
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
  const nativePath = useDocStore((s) => s.nativePath)
  const binding = useDocStore((s) => s.binding)

  const defaults = useMemo<FormState>(() => {
    const title = (parseResult.header.titles[0] ?? '').trim() || stripExt(fileName || '未命名') || '未命名'
    const composer = (parseResult.header.authors[0] ?? '').trim() || '佚名'
    const slug = slugify(stripExt(fileName || '') || title)
    return {
      title,
      composer,
      license: 'ORIGINAL',
      source: '原创',
      tags: '',
      slug,
      short: shortify(slug),
      difficulty: '',
      excerpt: '',
      note: '',
      arrangement: '',
      ccLicense: '',
      attribution: '',
      sourceUrl: '',
    }
  }, [parseResult.header.titles, parseResult.header.authors, fileName])

  const [form, setForm] = useState<FormState>(defaults)
  const [rightsBase, setRightsBase] = useState<ScoreRights | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // adj1198：有 .jps.meta.json 就优先用维护好的发布信息预填
  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await loadScoreMetaFor(nativePath, binding)
      if (!alive || !r.meta) return
      const m = r.meta
      setForm((prev) => ({
        ...prev,
        title: m.title,
        composer: m.composer,
        license: m.license,
        source: m.source,
        tags: m.tags.join(', '),
        slug: m.slug,
        short: m.short,
        difficulty: m.difficulty ? String(m.difficulty) : '',
        excerpt: m.excerpt ?? '',
        note: m.note ?? '',
        arrangement: m.rights?.arrangement ?? '',
        ccLicense: m.rights?.ccLicense ?? '',
        attribution: m.rights?.attribution ?? '',
        sourceUrl: m.rights?.sourceUrl ?? '',
      }))
      setRightsBase(m.rights)
    })()
    return () => {
      alive = false
    }
  }, [nativePath, binding])

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

  const set = <K extends keyof FormState,>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const doExport = async (): Promise<void> => {
    setErr(null)
    const title = form.title.trim()
    const composer = form.composer.trim()
    const source = form.source.trim()
    if (title === '') return setErr(C.needTitle)
    if (composer === '') return setErr(C.needComposer)
    if (source === '') return setErr(C.needSource)
    if (!/^[a-z0-9-]+$/.test(form.slug)) return setErr(C.badSlug)
    if (!/^[a-z]{3,6}$/.test(form.short)) return setErr(C.badShort)
    const difficulty = form.difficulty === '' ? undefined : Number(form.difficulty)
    if (difficulty !== undefined && (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5)) {
      return setErr('难度只能是 1-5 的整数')
    }
    if (form.license === 'CC' && form.ccLicense.trim() === '') {
      return setErr('许可选 CC 时必须填写 CC 协议（如 CC-BY-NC-SA-4.0）')
    }
    if (form.license === 'CC' && form.attribution.trim() === '' && form.sourceUrl.trim() === '') {
      return setErr('许可选 CC 时必须填写署名或来源链接')
    }
    const snap = getOverlaySnapshot()
    if (pageConfig.bgEnabled && pageConfig.bgImage.trim() === '') {
      return setErr('背景已开启，但还没选择背景图')
    }
    if (pageConfig.bgEnabled && pageConfig.bgImage.trim() !== '' && !snap.assets?.bg) {
      return setErr('背景图开启了但没解析到图片：请先在图层面板里重新选择背景图')
    }
    if (
      pageConfig.wmEnabled &&
      pageConfig.wmType === 'image' &&
      pageConfig.wmImage.trim() === ''
    ) {
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

      const date = today()
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
      const rights: ScoreRights = {
        ...(rightsBase ?? {}),
        work: form.license,
        notation: 'CC-BY-NC-SA-4.0',
        ...(form.arrangement !== ''
          ? { arrangement: form.arrangement as NonNullable<ScoreRights['arrangement']> }
          : {}),
        ...(form.ccLicense.trim() !== '' ? { ccLicense: form.ccLicense.trim() } : {}),
        ...(form.attribution.trim() !== '' ? { attribution: form.attribution.trim() } : {}),
        ...(form.sourceUrl.trim() !== '' ? { sourceUrl: form.sourceUrl.trim() } : {}),
      }
      const meta = {
        format: 'ijipu-score-package',
        version: 1,
        slug: form.slug,
        short: form.short,
        title,
        composer,
        license: form.license,
        source,
        tags: form.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        ...(difficulty !== undefined ? { difficulty } : {}),
        ...(form.excerpt.trim() !== '' ? { excerpt: form.excerpt.trim() } : {}),
        ...(form.note.trim() !== '' ? { note: form.note.trim() } : {}),
        publishedAt: date,
        updatedAt: date,
        ...(assets.length > 0 ? { assets } : {}),
        overlay,
        rights,
      }

      const encoder = new TextEncoder()
      files.unshift(
        { name: 'meta.json', data: encoder.encode(JSON.stringify(meta, null, 2) + '\n') },
        { name: 'README.md', data: encoder.encode(readmeOf({ ...meta, assets })) },
        { name: 'score.jps', data: encoder.encode(code) },
      )

      const zip = writeZip(files)
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
            <span>{C.fieldLicense}</span>
            <select
              className="score-pkg-input"
              value={form.license}
              onChange={(e) => set('license', e.target.value as License)}
            >
              <option value="PD">{C.licensePD}</option>
              <option value="ORIGINAL">{C.licenseOriginal}</option>
              <option value="AUTHORIZED">{C.licenseAuthorized}</option>
              <option value="CC">CC</option>
            </select>
          </label>
          <label className="score-pkg-field">
            <span>{C.fieldDifficulty}</span>
            <input
              className="score-pkg-input"
              type="number"
              min={1}
              max={5}
              value={form.difficulty}
              onChange={(e) => set('difficulty', e.target.value)}
            />
          </label>
          <label className="score-pkg-field score-pkg-span2">
            <span>{C.fieldSource}</span>
            <input className="score-pkg-input" value={form.source} onChange={(e) => set('source', e.target.value)} />
          </label>
          <label className="score-pkg-field">
            <span>{M.arrangement}</span>
            <select
              className="score-pkg-input"
              value={form.arrangement}
              onChange={(e) => set('arrangement', e.target.value)}
            >
              <option value="">{M.arrangementNone}</option>
              <option value="NONE">无（不单独主张）</option>
              <option value="PD">公版</option>
              <option value="ORIGINAL">原创</option>
              <option value="AUTHORIZED">已授权</option>
              <option value="CC">CC</option>
            </select>
          </label>
          <label className="score-pkg-field score-pkg-span2">
            <span>{C.fieldTags}</span>
            <input className="score-pkg-input" value={form.tags} onChange={(e) => set('tags', e.target.value)} />
          </label>
          {(form.license === 'CC' || form.arrangement === 'CC') && (
            <>
              <label className="score-pkg-field">
                <span>{M.ccLicense}</span>
                <input
                  className="score-pkg-input"
                  placeholder="CC-BY-NC-SA-4.0"
                  value={form.ccLicense}
                  onChange={(e) => set('ccLicense', e.target.value)}
                />
              </label>
              <label className="score-pkg-field">
                <span>{M.attribution}</span>
                <input
                  className="score-pkg-input"
                  value={form.attribution}
                  onChange={(e) => set('attribution', e.target.value)}
                />
              </label>
              <label className="score-pkg-field score-pkg-span2">
                <span>{M.sourceUrl}</span>
                <input
                  className="score-pkg-input"
                  value={form.sourceUrl}
                  onChange={(e) => set('sourceUrl', e.target.value)}
                />
              </label>
              <p className="score-pkg-hint score-pkg-span2">{M.ccHint}</p>
            </>
          )}
          <label className="score-pkg-field">
            <span>{C.fieldSlug}</span>
            <input className="score-pkg-input" value={form.slug} onChange={(e) => set('slug', e.target.value)} />
          </label>
          <label className="score-pkg-field">
            <span>{C.fieldShort}</span>
            <input className="score-pkg-input" value={form.short} onChange={(e) => set('short', e.target.value)} />
          </label>
          <label className="score-pkg-field score-pkg-span2">
            <span>{C.fieldExcerpt}</span>
            <input className="score-pkg-input" value={form.excerpt} onChange={(e) => set('excerpt', e.target.value)} />
          </label>
          <label className="score-pkg-field score-pkg-span2">
            <span>{C.fieldNote}</span>
            <textarea className="score-pkg-input" value={form.note} onChange={(e) => set('note', e.target.value)} />
          </label>
        </div>
        <div className="score-pkg-assets">
          {assetPlan.length > 0 ? C.assetsOn(assetPlan.length) : C.assetsNone}
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
