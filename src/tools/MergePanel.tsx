/**
 * tools/MergePanel.tsx — 「音视频合并」页签（adj1316）
 *
 * 交互与爱出片的「拆合」页签一致（用户要的正是把那里搬出来）：选视频 + 可选音频 →
 * 选「替换原声 / 与原声混音」→ 选音频码率 → 生成 MP4。
 * 这里的实现走 `./mux`（动态 import）：mediabunny 有几百 KB，不点"生成"就不下载。
 */
import { useState } from 'react'
import { toolsCopy } from './copy'
import { downloadBlob, baseNameOf, safeName } from './files'
import { probeCapability } from './capability'
import { FileRow, Notice, ProgressBar } from './ui'

const M = toolsCopy.merge

/** 码率下拉：`'source'` = 跟随源文件（整包搬时它不起作用，因为压根不重编） */
const BITRATES: { value: string; label: string }[] = [
  { value: 'source', label: M.bitrateSource },
  { value: '96000', label: '96 kbps' },
  { value: '128000', label: '128 kbps' },
  { value: '192000', label: '192 kbps' },
]

export function MergePanel() {
  const cap = probeCapability()
  const [video, setVideo] = useState<File | null>(null)
  const [audio, setAudio] = useState<File | null>(null)
  const [mode, setMode] = useState<'replace' | 'mix'>('replace')
  const [bitrate, setBitrate] = useState('source')
  const [busy, setBusy] = useState(false)
  const [ratio, setRatio] = useState(0)
  const [status, setStatus] = useState('')
  const disabled = busy || !cap.mux || video === null

  const run = async (): Promise<void> => {
    if (video === null || busy) return
    setBusy(true)
    setRatio(0)
    setStatus(M.running)
    try {
      const { mergeVideoAudio } = await import('./mux')
      const blob = await mergeVideoAudio(video, audio, mode, (r, label) => {
        setRatio(r)
        setStatus(label)
      }, { audioBitrate: bitrate === 'source' ? 'source' : Number(bitrate) })
      const suffix = mode === 'mix' ? M.suffixMix : M.suffixReplace
      const name = `${safeName(baseNameOf(video.name))}${suffix}.mp4`
      setStatus(toolsCopy.common.saving)
      downloadBlob(blob, name)
      setRatio(1)
      setStatus(M.done(name))
    } catch (e) {
      setStatus(toolsCopy.common.failed(e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="t-card">
      <h2>{M.title}</h2>
      <p className="t-hint">{M.hint}</p>
      {cap.mux ? null : <Notice tone="warn" text={toolsCopy.capability.noMux} />}
      {cap.reencode ? null : <Notice tone="warn" text={toolsCopy.capability.noReencode} />}
      <FileRow label={M.video} accept="video/*" file={video} placeholder={M.pickVideo} disabled={busy} onPick={setVideo} />
      <FileRow label={M.audio} accept="audio/*" file={audio} placeholder={M.pickAudio} disabled={busy} onPick={setAudio} />
      <div className="t-row">
        <span className="t-row-label">{M.mode}</span>
        <select className="t-select" value={mode} disabled={busy} onChange={(e) => setMode(e.target.value === 'mix' ? 'mix' : 'replace')}>
          <option value="replace">{M.modeReplace}</option>
          <option value="mix" disabled={!cap.reencode}>
            {cap.reencode ? M.modeMix : M.modeMixSlow}
          </option>
        </select>
      </div>
      <div className="t-row">
        <span className="t-row-label">{M.bitrate}</span>
        <select className="t-select" value={bitrate} disabled={busy} onChange={(e) => setBitrate(e.target.value)}>
          {BITRATES.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </div>
      <button type="button" className="t-btn t-btn-run" disabled={disabled || video === null} onClick={() => void run()}>
        {busy ? M.running : M.run}
      </button>
      {video === null ? <p className="t-muted">{M.needVideo}</p> : null}
      {busy || status !== '' ? <ProgressBar ratio={ratio} label={status} /> : null}
    </section>
  )
}
