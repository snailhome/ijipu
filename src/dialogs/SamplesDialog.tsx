/**
 * dialogs/SamplesDialog.tsx — 打开示例 / 打开线上乐谱库
 *
 * 2026-11-06 用户口径：线下版也直接取线上内容。列表和源码来自
 * `https://ijipu.pages.dev/scores/index.json`，断网用上次缓存；没有缓存就提示联网，
 * 不再回退到随包内置示例。
 */
import { useCallback, useEffect, useState } from 'react'
import { loadOnlineScores, type OnlineScore, type OnlineScores } from '../samples/online'
import { Modal } from '../ui/Modal'
import { useDocStore } from '../store/docStore'
import { useUiStore } from '../store/uiStore'

interface State {
  loading: boolean
  error: string
  data: OnlineScores | null
  warning: string
}

export function SamplesDialog() {
  const loadSample = useDocStore((s) => s.loadSample)
  const closeModal = useUiStore((s) => s.closeModal)
  const [state, setState] = useState<State>({ loading: true, error: '', data: null, warning: '' })

  const load = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, loading: true, error: '' }))
    try {
      const result = await loadOnlineScores()
      setState({ loading: false, error: '', data: result.data, warning: result.warning })
    } catch (e) {
      setState({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
        data: null,
        warning: '',
      })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const open = (score: OnlineScore): void => {
    loadSample(score.code, score.title)
    closeModal()
  }

  const scoreRow = (score: OnlineScore) => (
    <div
      key={score.slug || score.short || score.title}
      onClick={() => open(score)}
      title="点击载入这份谱（会替换当前编辑内容）"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 10,
        padding: '9px 12px',
        border: '1px solid var(--jp-border)',
        borderRadius: 8,
        cursor: 'pointer',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {score.title}
          {score.short && (
            <span style={{ marginLeft: 8, color: 'var(--jp-text-muted)', fontWeight: 400, fontSize: 12 }}>
              s/{score.short}
            </span>
          )}
        </div>
        {(score.composer || score.subtitle) && (
          <div style={{ color: 'var(--jp-text-muted)', fontSize: 12 }}>
            {[score.subtitle, score.composer].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
      <div style={{ color: 'var(--jp-text-muted)', fontSize: 12, flexShrink: 0 }}>
        {score.code.length} 字符
      </div>
    </div>
  )

  return (
    <Modal title="打开示例 / 乐谱" width="min(720px, 100%)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 'min(65vh, 580px)', overflow: 'auto' }}>
        {state.loading && (
          <div style={{ color: 'var(--jp-text-muted)', fontSize: 13 }}>正在从官网获取列表…</div>
        )}
        {state.error !== '' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ color: 'var(--jp-danger, #e5484d)', fontSize: 13, flex: 1 }}>{state.error}</div>
            <button type="button" className="btn" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}
        {state.warning !== '' && (
          <div
            style={{
              padding: '7px 10px',
              border: '1px solid var(--jp-warning, #d97706)',
              borderRadius: 7,
              color: 'var(--jp-warning, #d97706)',
              fontSize: 12,
            }}
          >
            {state.warning}
          </div>
        )}
        {state.data && (
          <>
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--jp-text-secondary)' }}>
              示例谱
            </div>
            {state.data.samples.length > 0 ? (
              state.data.samples.map(scoreRow)
            ) : (
              <div style={{ color: 'var(--jp-text-muted)', fontSize: 13 }}>线上暂无示例谱。</div>
            )}
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--jp-text-secondary)', marginTop: 4 }}>
              乐谱库
            </div>
            {state.data.library.length > 0 ? (
              state.data.library.map(scoreRow)
            ) : (
              <div style={{ color: 'var(--jp-text-muted)', fontSize: 13 }}>线上暂无乐谱。</div>
            )}
          </>
        )}
        <div style={{ color: 'var(--jp-text-muted)', fontSize: 12, marginTop: 4 }}>
          内容直接来自官网，需要联网获取；断网时显示上次缓存。打开后可直接改，也可另存为自己的谱（`Ctrl+Shift+S`）。
        </div>
      </div>
    </Modal>
  )
}
