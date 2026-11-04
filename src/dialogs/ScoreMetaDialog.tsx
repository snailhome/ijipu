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
  arrangement: string
  rightsHolder: string
  evidence: string
  territory: string
  commercial: boolean
  pdReason: string
  ccLicense: string
  attribution: string
  sourceUrl: string
}

export function ScoreMetaDialog({ inline = false }: { inline?: boolean }) {
  const closeModal = useUiStore((s) => s.closeModal)
  const closeDock = useUiStore((s) => s.closeDock)
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
    arrangement: '',
    rightsHolder: '',
    evidence: '',
    territory: '',
    commercial: false,
    pdReason: '',
    ccLicense: '',
    attribution: '',
    sourceUrl: '',
  })
  const [assets, setAssets] = useState<ScoreMetaDoc['assets']>(undefined)
  const [overlay, setOverlay] = useState<ScoreMetaDoc['overlay']>(undefined)
  const [path, setPath] = useState<string | null>(null)
  const [savedInfo, setSavedInfo] = useState<string | null>(null)
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
            arrangement: r.meta.rights?.arrangement ?? '',
            rightsHolder: r.meta.rights?.rightsHolder ?? '',
            evidence: r.meta.rights?.evidence ?? '',
            territory: r.meta.rights?.territory ?? '',
            commercial: r.meta.rights?.commercial === true,
            pdReason: r.meta.rights?.pdReason ?? '',
            ccLicense: r.meta.rights?.ccLicense ?? '',
            attribution: r.meta.rights?.attribution ?? '',
            sourceUrl: r.meta.rights?.sourceUrl ?? '',
          })
          setAssets(r.meta.assets)
          setOverlay(r.meta.overlay)
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
    setSavedInfo(null)
    const difficulty = form.difficulty === '' ? undefined : Number(form.difficulty)
    const rights: NonNullable<ScoreMetaDoc['rights']> = {
      work: form.license,
      notation: 'CC-BY-NC-SA-4.0',
      ...(form.arrangement !== '' ? { arrangement: form.arrangement as NonNullable<ScoreMetaDoc['rights']>['arrangement'] } : {}),
      ...(form.rightsHolder.trim() !== '' ? { rightsHolder: form.rightsHolder.trim() } : {}),
      ...(form.evidence.trim() !== '' ? { evidence: form.evidence.trim() } : {}),
      ...(form.territory.trim() !== '' ? { territory: form.territory.trim() } : {}),
      ...(form.commercial ? { commercial: true } : {}),
      ...(form.pdReason !== '' ? { pdReason: form.pdReason as NonNullable<ScoreMetaDoc['rights']>['pdReason'] } : {}),
      ...(form.ccLicense.trim() !== '' ? { ccLicense: form.ccLicense.trim() } : {}),
      ...(form.attribution.trim() !== '' ? { attribution: form.attribution.trim() } : {}),
      ...(form.sourceUrl.trim() !== '' ? { sourceUrl: form.sourceUrl.trim() } : {}),
    }
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
      ...(overlay !== undefined ? { overlay } : {}),
      rights,
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
      if (r.downloaded) setSavedInfo(M.downloaded)
      else if (r.workspace) setSavedInfo(M.saveWorkspace)
      else if (r.path !== null) setSavedInfo(M.saveTo(r.path))
      else setSavedInfo(M.saved)
      showNotice(M.saved)
      if (!inline) closeModal()
    } catch (e) {
      setErr(M.saveFailed(e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={M.title} width={720} fill inline={inline}>
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

          <div className="score-pkg-group-title score-pkg-span2">{M.rightsTitle}</div>
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
          <label className="score-pkg-field">
            <span>{M.pdReason}</span>
            <select className="score-pkg-input" value={form.pdReason} onChange={(e) => set('pdReason', e.target.value)}>
              <option value="">{M.pdNone}</option>
              <option value="author-death">{M.pdAuthorDeath}</option>
              <option value="public-domain-dedication">{M.pdDedication}</option>
              <option value="government">{M.pdGovernment}</option>
              <option value="cc0">{M.pdCc0}</option>
              <option value="other">{M.pdOther}</option>
            </select>
          </label>
          <label className="score-pkg-field">
            <span>{M.rightsHolder}</span>
            <input
              className="score-pkg-input"
              value={form.rightsHolder}
              onChange={(e) => set('rightsHolder', e.target.value)}
            />
          </label>
          <label className="score-pkg-field">
            <span>{M.territory}</span>
            <input className="score-pkg-input" value={form.territory} onChange={(e) => set('territory', e.target.value)} />
          </label>
          <label className="score-pkg-field score-pkg-span2">
            <span>{M.evidence}</span>
            <input className="score-pkg-input" value={form.evidence} onChange={(e) => set('evidence', e.target.value)} />
          </label>
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
            <input className="score-pkg-input" value={form.sourceUrl} onChange={(e) => set('sourceUrl', e.target.value)} />
          </label>
          <label className="score-pkg-field score-pkg-span2 score-pkg-check">
            <input
              type="checkbox"
              checked={form.commercial}
              onChange={(e) => set('commercial', e.target.checked)}
            />
            <span>{M.commercial}</span>
          </label>
          <p className="score-pkg-hint score-pkg-span2">{M.rightsHint}</p>
        </div>
        <div className="score-pkg-assets">{path !== null ? M.pathHint(path) : M.noPathHint}</div>
        <p className="score-pkg-hint">{C.hint}</p>
        </div>
        <div className="score-pkg-actions">
          <div className="score-pkg-status" role="status" aria-live="polite">
            {err !== null ? (
              <span className="score-pkg-err">{err}</span>
            ) : savedInfo !== null ? (
              <span className="score-pkg-ok">{savedInfo}</span>
            ) : null}
          </div>
          <button type="button" className="btn" onClick={inline ? closeDock : closeModal} disabled={busy}>
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
