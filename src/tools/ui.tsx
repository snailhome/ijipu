/**
 * tools/ui.tsx — 三个页签共用的几块小零件（adj1316）
 *
 * 只有"文件行 / 进度条 / 提示条"三样，不值得各写一遍；样式全在 `tools.css` 的 `.t-*` 类上。
 */
import { useRef } from 'react'

/** 一行「标签 + 选文件按钮」；选中后按钮上显示文件名 */
export function FileRow({
  label,
  accept,
  file,
  placeholder,
  disabled,
  onPick,
}: {
  label: string
  accept: string
  file: File | null
  placeholder: string
  disabled?: boolean
  onPick: (file: File | null) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  return (
    <div className="t-row">
      <span className="t-row-label">{label}</span>
      <button
        type="button"
        className="t-btn t-btn-pick"
        disabled={disabled === true}
        onClick={() => inputRef.current?.click()}
        title={file === null ? placeholder : file.name}
      >
        {file === null ? placeholder : file.name}
      </button>
      <input
        ref={inputRef}
        className="t-hidden-input"
        type="file"
        accept={accept}
        onChange={(e) => {
          onPick(e.target.files?.[0] ?? null)
          e.target.value = ''
        }}
      />
    </div>
  )
}

/** 进度条 + 一行状态字（0~1） */
export function ProgressBar({ ratio, label }: { ratio: number; label: string }) {
  return (
    <div className="t-progress" role="status" aria-live="polite">
      <div className="t-progress-track">
        <i style={{ width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%` }} />
      </div>
      <span className="t-progress-label">{label}</span>
    </div>
  )
}

/** 一行说明 / 警告（不弹窗、不挡操作） */
export function Notice({ tone = 'info', text }: { tone?: 'info' | 'warn' | 'error'; text: string }) {
  return <p className={`t-notice t-notice-${tone}`}>{text}</p>
}
