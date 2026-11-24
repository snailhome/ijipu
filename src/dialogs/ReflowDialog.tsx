/**
 * dialogs/ReflowDialog.tsx — 乐谱重排（adj1324）
 *
 * 用户 2026-11-23 拍板：顶栏「重排」/ 文件菜单打开本对话框；
 * 三种模式（最多 N 小节 / 固定占宽超过 X% / 目标行数）可组合；
 * 应用后用 `docStore.setCode` **一步撤销**替换源码，不自动保存。
 *
 * 真正的重排逻辑在引擎 `reflowJps()`；这里只收集参数、显示预览与告警。
 */
import { useMemo, useState } from 'react'
import { reflowJps } from '@ijipu/engine'
import { reflowCopy } from '../brand/copy'
import { useDocStore } from '../store/docStore'
import { useUiStore } from '../store/uiStore'
import { Modal } from '../ui/Modal'

export function ReflowDialog() {
  const code = useDocStore((s) => s.code)
  const parseResult = useDocStore((s) => s.parseResult)
  const pageConfig = useDocStore((s) => s.pageConfig)
  const setCode = useDocStore((s) => s.setCode)
  const closeModal = useUiStore((s) => s.closeModal)
  const showNotice = useUiStore((s) => s.showNotice)

  const [useMax, setUseMax] = useState(true)
  const [maxMeasures, setMaxMeasures] = useState(4)
  const [useRatio, setUseRatio] = useState(false)
  const [ratioPct, setRatioPct] = useState(80)
  const [useLines, setUseLines] = useState(false)
  const [targetLines, setTargetLines] = useState(10)

  const result = useMemo(
    () =>
      reflowJps(code, {
        maxMeasuresPerLine: useMax ? Math.max(1, Math.round(maxMeasures)) : undefined,
        fixedInkRatio: useRatio ? Math.min(1, Math.max(0.1, ratioPct / 100)) : undefined,
        targetLineCount: useLines ? Math.max(1, Math.round(targetLines)) : undefined,
        pageConfig,
      }),
    [code, useMax, maxMeasures, useRatio, ratioPct, useLines, targetLines, pageConfig],
  )
  const hasError = parseResult.errors.some((e) => e.severity === 'error')
  const lineCount = result.breaks.length

  const apply = (): void => {
    if (hasError) return
    setCode(result.source, true)
    closeModal()
    showNotice(reflowCopy.applied(lineCount), 'ok')
  }

  return (
    <Modal title={reflowCopy.title}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, minWidth: 320, maxWidth: 520 }}>
        <p style={{ margin: 0, color: 'var(--jp-text-dim, #666)', lineHeight: 1.5 }}>{reflowCopy.hint}</p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input type="checkbox" checked={useMax} onChange={(e) => setUseMax(e.target.checked)} />
          <span>{reflowCopy.modeMax}</span>
          <input
            type="number"
            min={1}
            max={99}
            value={maxMeasures}
            disabled={!useMax}
            onChange={(e) => setMaxMeasures(Number(e.target.value) || 1)}
            style={{ width: 64 }}
          />
          <span>{reflowCopy.maxSuffix}</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input type="checkbox" checked={useRatio} onChange={(e) => setUseRatio(e.target.checked)} />
          <span>{reflowCopy.modeRatio}</span>
          <input
            type="number"
            min={10}
            max={100}
            value={ratioPct}
            disabled={!useRatio}
            onChange={(e) => setRatioPct(Number(e.target.value) || 80)}
            style={{ width: 64 }}
          />
          <span>{reflowCopy.ratioSuffix}</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input type="checkbox" checked={useLines} onChange={(e) => setUseLines(e.target.checked)} />
          <span>{reflowCopy.modeLines}</span>
          <input
            type="number"
            min={1}
            max={999}
            value={targetLines}
            disabled={!useLines}
            onChange={(e) => setTargetLines(Number(e.target.value) || 10)}
            style={{ width: 64 }}
          />
          <span>{reflowCopy.linesSuffix}</span>
        </label>

        <p style={{ margin: 0, color: 'var(--jp-text-dim, #666)', fontSize: 12, lineHeight: 1.5 }}>
          {reflowCopy.modeCombineHint}
        </p>

        <div style={{ borderTop: '1px solid var(--jp-border, #ddd)', paddingTop: 10, lineHeight: 1.6 }}>
          <div>{reflowCopy.preview(lineCount, result.measures)}</div>
          {lineCount > 0 && (
            <div style={{ color: 'var(--jp-text-dim, #666)', fontSize: 12 }}>
              {result.breaks.slice(0, 8).map((b) => `第 ${b.measure} 小节起`).join(' · ')}
              {result.breaks.length > 8 ? ' …' : ''}
            </div>
          )}
          {result.warnings.map((w) => (
            <div key={w} style={{ color: 'var(--jp-warning, #d97706)', fontSize: 12 }}>
              {w}
            </div>
          ))}
          {hasError && (
            <div style={{ color: 'var(--jp-danger, #e5484d)', fontSize: 12 }}>{reflowCopy.needFixErrors}</div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={closeModal}>
            {reflowCopy.cancel}
          </button>
          <button type="button" className="btn primary" disabled={hasError} onClick={apply}>
            {reflowCopy.apply}
          </button>
        </div>
      </div>
    </Modal>
  )
}
