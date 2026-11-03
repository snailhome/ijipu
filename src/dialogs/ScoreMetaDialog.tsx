/**
 * dialogs/ScoreMetaDialog.tsx — 「文件 → 乐谱信息」维护 `.jps.meta.json`（adj1198）
 *
 * 与「导出乐谱包」共用字段，但这里**只维护**发布信息，不打包：
 *  · 桌面/工作区：读写 `.jps` 同目录的 `foo.jps.meta.json`；
 *  · 网页：没有文件系统 ⇒ 保存时下载一份，提示放回同目录。
 *
 * 乐谱包导出对话框会优先读这份 sidecar 预填；没有才用描述头/文件名兜底。
 */
import { useEffect, useState } from 'react'
import { Modal } from '../ui/Modal'
import { useDocStore } from '../store/docStore'
import { useUiStore } from '../store/uiStore'
import { scoreMetaCopy as M, scorePackageCopy as C } from '../brand/copy'
import {
  defaultScoreMeta,
  loadScoreMetaFor,
  saveScoreMetaFor,
  validateScoreMeta,
  type ScoreMetaDoc,
  type ScoreMetaLicense,
} from '../store/scoreMeta'

interface FormState {
  title: string
  composer: string
  license: ScoreMetaLicense
  source: string
  tags: string
  slug: string
  short: string
  difficulty: string
  excerpt: string
  note: string
}

export function ScoreMetaDialog() {
  const closeModal = useUiStore((s) => s.closeModal)
  const showNotice = useUiStore((s) => s.showNotice)
  const nativePath = useDocStore((s) => s.nativePath)
  const binding = useDocStore((s) => s.binding)
  const fileName = useDocStore((s) => s.fileName)
  const parseResult = useDocStore((s) => s.parseResult)

  const base = defaultScoreMeta(parseResult.header.titles, parseResult.header.authors, fileName)
  const [form, setForm] = useState<FormState>({
    title: base.title,
    composer: base.composer,
    license: base.license,
    source: base.source,
    tags: '',
    slug: base.slug,
    short: base.short,
    difficulty: '',
    excerpt: '',
    note: '',
  })
  const [assets, setAssets] = useState<ScoreMetaDoc['assets']>(undefined)
  const [path, setPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await loadScoreMetaFor(nativePath, binding)
        if (!alive) return
        setPath(r.path)
        if (r.meta) {
          setForm({
            title: r.meta.title,
            composer: r.meta.composer,
            license: r.meta.license,
            source: r.meta.source,
            tags: r.meta.tags.join(', '),
            slug: r.meta.slug,
            short: r.meta.short,
            difficulty: r.meta.difficulty ? String(r.meta.difficulty) : '',
            excerpt: r.meta.excerpt ?? '',
            note: r.meta.note ?? '',
          })
          setAssets(r.meta.assets)
        }
      } catch (e) {
        if (alive) setErr(M.loadFailed(e instanceof Error ? e.message : String(e)))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [nativePath, binding])

  const set = <K extends keyof FormState,>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const save = async (): Promise<void> => {
    setErr(null)
    const difficulty = form.difficulty === '' ? undefined : Number(form.difficulty)
    const meta: ScoreMetaDoc = {
      format: 'ijipu-score-meta',
      version: 1,
      slug: form.slug.trim(),
      short: form.short.trim(),
      title: form.title.trim(),
      composer: form.composer.trim(),
      license: form.license,
      source: form.source.trim(),
      tags: form.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      ...(difficulty !== undefined ? { difficulty } : {}),
      ...(form.excerpt.trim() !== '' ? { excerpt: form.excerpt.trim() } : {}),
      ...(form.note.trim() !== '' ? { note: form.note.trim() } : {}),
      ...(assets !== undefined ? { assets } : {}),
    }
    const bad = validateScoreMeta(meta)
    if (bad !== '') {
      setErr(bad)
      return
    }
    setBusy(true)
    try {
      const r = await saveScoreMetaFor(nativePath, binding, fileName, meta)
      if (!r.ok) {
        setErr(M.saveFailed(r.error))
        return
      }
      setPath(r.path)
      showNotice(r.downloaded ? M.downloaded : M.saved)
      closeModal()
    } catch (e) {
      setErr(M.saveFailed(e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={M.title} width={720} fill>
      <div className="score-pkg">
        <div className="score-pkg-scroll">
          <p className="score-pkg-intro">{M.intro}</p>
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
              onChange={(e) => set('license', e.target.value as ScoreMetaLicense)}
            >
              <option value="PD">{C.licensePD}</option>
              <option value="ORIGINAL">{C.licenseOriginal}</option>
              <option value="AUTHORIZED">{C.licenseAuthorized}</option>
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
          <label className="score-pkg-field score-pkg-span2">
            <span>{C.fieldTags}</span>
            <input className="score-pkg-input" value={form.tags} onChange={(e) => set('tags', e.target.value)} />
          </label>
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
        <div className="score-pkg-assets">{path !== null ? M.pathHint(path) : M.noPathHint}</div>
        <p className="score-pkg-hint">{C.hint}</p>
        {err !== null && <div className="score-pkg-err">{err}</div>}
        </div>
        <div className="score-pkg-actions">
          <button type="button" className="btn" onClick={closeModal} disabled={busy}>
            {M.cancelBtn}
          </button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={busy || loading}>
            {busy ? M.saving : M.saveBtn}
          </button>
        </div>
      </div>
    </Modal>
  )
}
