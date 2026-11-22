/**
 * tools/SplitPanel.tsx — 「有声视频拆分」页签（adj1316）
 *
 * 一个带声音的视频，拆成三样可选的东西：
 *  · 无声视频（MP4）：画面整包搬，不掉画质；
 *  · 原样音频（m4a）：音频包一字节不动，体积 = 原音轨（搬不动才重编 AAC）；
 *  · WAV：解成 PCM 另存，拿去别的软件处理（体积大）。
 */
import { useState } from 'react'
import { toolsCopy } from './copy'
import { downloadBlob, downloadBytes, baseNameOf, safeName } from './files'
import { probeCapability } from './capability'
import { FileRow, Notice, ProgressBar } from './ui'
// WAV 编码器只有 40 行、且 `clipAudio.ts` 已经静态引了它 ⇒ 这里也静态引，
// 免得构建报 INEFFECTIVE_DYNAMIC_IMPORT（真正的大块 mediabunny 仍在 `./mux` 里动态引）
import { wavBytes } from './audioOut'

const S = toolsCopy.split

type Kind = 'video' | 'audio' | 'wav'

export function SplitPanel() {
  const cap = probeCapability()
  const [video, setVideo] = useState<File | null>(null)
  const [busy, setBusy] = useState<Kind | null>(null)
  const [ratio, setRatio] = useState(0)
  const [status, setStatus] = useState('')
  const idle = busy === null && cap.mux && video !== null

  const run = async (kind: Kind): Promise<void> => {
    if (video === null || busy !== null) return
    setBusy(kind)
    setRatio(0)
    setStatus('')
    try {
      const onProgress = (r: number, label: string): void => {
        setRatio(r)
        setStatus(label)
      }
      const base = safeName(baseNameOf(video.name))
      let name = `${base}${S.suffixVideo}.mp4`
      if (kind === 'video') {
        const { extractVideoOnly } = await import('./mux')
        downloadBlob(await extractVideoOnly(video, onProgress), name)
      } else if (kind === 'audio') {
        const { extractAudioCopy } = await import('./mux')
        name = `${base}${S.suffixAudio}.m4a`
        downloadBlob(await extractAudioCopy(video, onProgress), name)
      } else {
        const { audioBufferOf } = await import('./mux')
        const buffer = await audioBufferOf(video, onProgress)
        onProgress(0.9, toolsCopy.common.progress.writeWav)
        name = `${base}${S.suffixAudio}.wav`
        downloadBytes(wavBytes(buffer), name, 'audio/wav')
      }
      setRatio(1)
      setStatus(S.done(name))
    } catch (e) {
      setStatus(toolsCopy.common.failed(e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="t-card">
      <h2>{S.title}</h2>
      <p className="t-hint">{S.hint}</p>
      {cap.mux ? null : <Notice tone="warn" text={toolsCopy.capability.noMux} />}
      <FileRow label={S.video} accept="video/*" file={video} placeholder={S.pickVideo} disabled={busy !== null} onPick={setVideo} />
      <div className="t-actions">
        <button type="button" className="t-btn t-btn-run" disabled={!idle} onClick={() => void run('video')}>
          {busy === 'video' ? S.runVideoBusy : S.runVideo}
        </button>
        <button type="button" className="t-btn" disabled={!idle} onClick={() => void run('audio')}>
          {busy === 'audio' ? S.runAudioBusy : S.runAudio}
        </button>
        <button type="button" className="t-btn" disabled={!idle} onClick={() => void run('wav')}>
          {S.runWav}
        </button>
      </div>
      {video === null ? <p className="t-muted">{S.needVideo}</p> : null}
      {busy !== null || status !== '' ? <ProgressBar ratio={ratio} label={status} /> : null}
    </section>
  )
}
