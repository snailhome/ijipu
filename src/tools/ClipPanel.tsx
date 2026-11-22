/**
 * tools/ClipPanel.tsx — 「音频片段截取」页签（adj1316）
 *
 * 用户要的是爱出片对拍页那套"波形 + 播放 + 微小跳跃 + 标记段"，但这里不排谱、不看视频，
 * 只做一件事：把一首歌里的一段（或几段）切出来存成 WAV / MP3。
 *
 * 交互口径（每一条都有理由，别随手改）：
 *  · 在波形上**按住拖** = 选一段；**点一下** = 只把播放头挪到那儿，**不动选区**（adj1317 用户要求：
 *    先选好一段、再点波形定位，原来的选区要留着）；
 *  · 起点与终点是**各自独立**的两个点：可以「起点＝播放头」「终点＝播放头」分别落，也可以在波形上
 *    抓住选区的那条边单独拖（抓手画在波形顶上），或者用起点/终点各自那 4 个微调按钮（10ms / 100ms）；
 *  · 选区可以「加成一段」存进标记段列表；列表里每段能**单独播放**、单独导出，也能一次打成一包 zip；
 *  · 全部在本机算：`audioBufferOf` 解码 → `peaksOf` 抽样 → `sliceBuffer` 切片 → WAV/MP3。
 */
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as PointerEventOf } from 'react'
import { toolsCopy } from './copy'
import { baseNameOf, clockOf, downloadBytes, safeName } from './files'
import { probeCapability } from './capability'
import { drawWave, peaksOf, type WaveSpan } from './waveform'
import type { PeakBucket } from './wavePeaks'
import {
  VIEW_ALL,
  VIEW_PRESETS_MS,
  clampView,
  scrollThumb,
  viewWindow,
  zoomView,
  type WaveView,
} from './waveRuler'
import { encodeClip, fileTypeOf, type ClipFormat } from './clipAudio'
import { createPlayer, type ClipPlayer } from './clipPlayer'
import { writeZipStore, type ZipEntry } from './zip'
import { FileRow, Notice, ProgressBar } from './ui'

const C = toolsCopy.clip
/** 微调按钮的步子（秒）：10 毫秒对齐"卡点"，100 毫秒用来粗调 */
const NUDGES = [-0.1, -0.01, 0.01, 0.1]
/** 太短的选区没有意义（1 个采样也可能，但导出体验很差） */
const MIN_LEN = 0.01

interface Mark {
  id: string
  name: string
  start: number
  end: number
}

let markSeq = 0

function newMarkId(): string {
  markSeq += 1
  return `mark-${markSeq}`
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/** `[from, to)` 的秒 → 选区文案（左边永远是起点） */
function spanText(span: WaveSpan): string {
  const a = Math.min(span.start, span.end)
  const b = Math.max(span.start, span.end)
  return C.selRange(clockOf(a), clockOf(b), clockOf(b - a))
}

/** 载入文件 → 解码 → 算峰值；换文件时旧请求作废（用递增的 token 认） */
function useClipBuffer() {
  const [file, setFile] = useState<File | null>(null)
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [peaks, setPeaks] = useState<PeakBucket[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const tokenRef = useRef(0)

  const pick = (next: File | null): void => {
    tokenRef.current += 1
    const token = tokenRef.current
    setFile(next)
    setBuffer(null)
    setPeaks(null)
    setStatus('')
    if (next === null) return
    setLoading(true)
    setStatus(C.loading)
    void (async () => {
      try {
        const { audioBufferOf } = await import('./mux')
        const decoded = await audioBufferOf(next, () => undefined)
        if (tokenRef.current !== token) return
        setBuffer(decoded)
        setPeaks(peaksOf(decoded))
        setStatus(C.loaded(clockOf(decoded.duration), `${Math.round(decoded.sampleRate / 100) / 10} kHz`))
      } catch (e) {
        if (tokenRef.current === token) setStatus(toolsCopy.common.failed(e instanceof Error ? e.message : String(e)))
      } finally {
        if (tokenRef.current === token) setLoading(false)
      }
    })()
  }

  return { file, buffer, peaks, loading, status, pick }
}

/**
 * 播放器 + 播放头（口径从爱出片对拍台搬过来）：
 *  · 播放头读 `AudioContext` 的时钟，不用墙钟 —— 否则画面和声音会慢慢漂开；
 *  · `repeat()` 返回一段就表示"这段放完接着重放它"（循环选区 / 复听），返回 null 就停；
 *  · 段尾停下由播放器自己负责（`start(when, offset, duration)`），这里只判"还在放吗"。
 */
function usePlayer(buffer: AudioBuffer | null, repeat: () => WaveSpan | null) {
  const playerRef = useRef<ClipPlayer | null>(null)
  const repeatRef = useRef(repeat)
  repeatRef.current = repeat
  const [playing, setPlaying] = useState(false)
  const [head, setHead] = useState(0)

  useEffect(() => {
    setHead(0)
    setPlaying(false)
    if (buffer === null) return
    const player = createPlayer(buffer)
    playerRef.current = player
    return () => {
      player.dispose()
      playerRef.current = null
    }
  }, [buffer])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      const player = playerRef.current
      if (player === null) return
      if (player.playing()) {
        setHead(player.position())
        raf = requestAnimationFrame(tick)
        return
      }
      const span = repeatRef.current()
      if (span === null) {
        setPlaying(false)
        return
      }
      const from = Math.min(span.start, span.end)
      const to = Math.max(span.start, span.end)
      player.play(from, to)
      setHead(from)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const play = (from: number, to: number | null): void => {
    const player = playerRef.current
    if (player === null) return
    setHead(from)
    player.play(from, to)
    setPlaying(true)
  }

  const stop = (): void => {
    playerRef.current?.stop()
    setPlaying(false)
  }

  const seek = (at: number): void => {
    playerRef.current?.stop()
    setPlaying(false)
    setHead(at)
  }

  return { playing, head, play, stop, seek }
}

export function ClipPanel() {
  const cap = probeCapability()
  const { file, buffer, peaks, loading, status: loadStatus, pick } = useClipBuffer()
  const [sel, setSel] = useState<WaveSpan | null>(null)
  /** adj1317：现在在调哪一边（高亮抓手；点中某一侧后微调只动它） */
  const [grip, setGrip] = useState<'start' | 'end'>('start')
  const [marks, setMarks] = useState<Mark[]>([])
  const [selMarkId, setSelMarkId] = useState<string | null>(null)
  const [format, setFormat] = useState<ClipFormat>('wav')
  const [loop, setLoop] = useState(false)
  /** adj1318：视野（缩放/平移），口径与爱出片对拍台同一个 `WaveView` */
  const [view, setView] = useState<WaveView>(VIEW_ALL)
  /** adj1318：复听的那一段（前 3 秒 / 后 5 秒，爱出片 `toggleAuditionLoop` 的口径） */
  const [audition, setAudition] = useState<WaveSpan | null>(null)
  /**
   * adj1319（用户：「点击复听时，应在开始点击按钮前的当前位置添加一个临时时点定位虚线，
   * 正常播放时取消该虚线」）：复听那一刻播放头在哪 —— 画成金色虚线，正常播放就收掉。
   */
  const [anchor, setAnchor] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [ratio, setRatio] = useState(0)
  const [status, setStatus] = useState('')
  const player = usePlayer(buffer, () => audition ?? (loop && sel !== null ? sel : null))

  const duration = buffer?.duration ?? 0
  const base = safeName(baseNameOf(file?.name ?? toolsCopy.common.fallback.audio))

  const saveOne = async (from: number, to: number, label: string): Promise<void> => {
    if (buffer === null) return
    setBusy(true)
    setRatio(0)
    setStatus(C.encoding)
    try {
      const bytes = await encodeClip(buffer, from, to, format)
      const type = fileTypeOf(format)
      const name = `${base}-${safeName(label)}.${type.ext}`
      downloadBytes(bytes, name, type.mime)
      setRatio(1)
      setStatus(C.saved(name))
    } catch (e) {
      setStatus(toolsCopy.common.failed(e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const saveAll = async (): Promise<void> => {
    if (buffer === null) return
    if (marks.length === 0) {
      setStatus(C.emptyMarks)
      return
    }
    setBusy(true)
    setStatus(C.encoding)
    try {
      const type = fileTypeOf(format)
      const entries: ZipEntry[] = []
      for (let i = 0; i < marks.length; i += 1) {
        const mark = marks[i]
        setRatio(i / marks.length)
        entries.push({
          name: `${base}-${String(i + 1).padStart(2, '0')} ${safeName(mark.name)}.${type.ext}`,
          data: await encodeClip(buffer, mark.start, mark.end, format),
        })
      }
      const zip = writeZipStore(entries)
      const name = `${base}${C.suffixZip}.zip`
      downloadBytes(zip, name, 'application/zip')
      setRatio(1)
      setStatus(C.packed(entries.length, name))
    } catch (e) {
      setStatus(toolsCopy.common.failed(e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const addMark = (): void => {
    if (sel === null) {
      setStatus(C.noSel)
      return
    }
    const a = Math.min(sel.start, sel.end)
    const b = Math.max(sel.start, sel.end)
    if (b - a < MIN_LEN) {
      setStatus(C.tooShort)
      return
    }
    const mark: Mark = { id: newMarkId(), name: C.defaultMark(marks.length + 1), start: a, end: b }
    setMarks([...marks, mark])
    setSelMarkId(mark.id)
    setStatus('')
  }

  /** adj1317：把某一边直接落到播放头（没有选区就先起一个零长度的，另一边随后再定） */
  const dropAtHead = (side: 'start' | 'end'): void => {
    const at = clamp(player.head, 0, duration)
    setGrip(side)
    setSel((cur) => {
      if (cur === null) return { start: at, end: at }
      return side === 'start' ? { start: at, end: cur.end } : { start: cur.start, end: at }
    })
  }

  const nudge = (which: 'start' | 'end', delta: number): void => {
    if (sel === null) return
    setGrip(which)
    const a = Math.min(sel.start, sel.end)
    const b = Math.max(sel.start, sel.end)
    if (which === 'start') setSel({ start: clamp(a + delta, 0, Math.max(0, b - MIN_LEN)), end: b })
    else setSel({ start: a, end: clamp(b + delta, a + MIN_LEN, duration) })
  }

  /** 播放某一段标记段（用户要求：列表里直接能听；播到段尾由播放器自己停） */
  const playMark = (mark: Mark): void => {
    endAudition()
    setSelMarkId(mark.id)
    setSel({ start: mark.start, end: mark.end })
    setGrip('start')
    player.play(mark.start, mark.end)
  }

  /** adj1319：任何"正常播放"都先收掉复听与它留下的临时时点 */
  function endAudition(): void {
    setAudition(null)
    setAnchor(null)
  }

  /** adj1319：空格＝播放 / 暂停（用户：「点在波形上时，空格未实现播放/暂停」） */
  const togglePlay = (): void => {
    if (player.playing) {
      player.stop()
      return
    }
    endAudition()
    player.play(player.head, null)
  }

  /**
   * 复听（从爱出片 `toggleAuditionLoop` 搬的口径）：当前时点前 3 秒到后 5 秒循环。
   * 太短（<0.2 秒）不响应，免得在曲尾点出个 0.01 秒的死循环。
   */
  const toggleAudition = (): void => {
    if (audition !== null) {
      endAudition()
      player.stop()
      return
    }
    const at = player.head
    const from = Math.max(0, at - 3)
    const to = Math.min(duration, at + 5)
    if (to - from < 0.2) return
    setAudition({ start: from, end: to })
    // adj1319：把"点复听时听到的那一点"记下来画成金色虚线（正常播放时由 endAudition 收掉）
    setAnchor(at)
    player.play(from, to)
  }

  /** 换视野：整曲 or 以播放头为中心取一段（ms） */
  const pickView = (spanMs: number): void => {
    if (spanMs <= 0) {
      setView(VIEW_ALL)
      return
    }
    setView(clampView({ spanMs, startMs: Math.max(0, player.head * 1000 - spanMs / 2) }, duration * 1000))
  }

  return (
    <section className="t-card">
      <h2>{C.title}</h2>
      <p className="t-hint">{C.hint}</p>
      {cap.webaudio ? null : <Notice tone="warn" text={toolsCopy.capability.noAudio} />}
      <FileRow label={C.file} accept="audio/*,video/*" file={file} placeholder={C.pick} disabled={loading} onPick={pick} />
      {loadStatus === '' ? null : <p className={loading ? 't-muted t-loading' : 't-muted'}>{loadStatus}</p>}
      {buffer !== null && peaks !== null ? (
        <>
          <ClipWave
            buffer={buffer}
            peaks={peaks}
            view={view}
            sel={sel}
            grip={grip}
            head={player.head}
            marks={marks}
            anchor={anchor}
            onSel={setSel}
            onSeek={(at) => {
              // adj1319：点了波形就离开"复听"状态（复听是围绕旧位置的），临时虚线一起收
              if (audition !== null) endAudition()
              player.seek(at)
            }}
            onGrip={setGrip}
            onTogglePlay={togglePlay}
            onZoom={(factor, anchorSec) =>
              setView(zoomView(view, buffer.duration * 1000, factor, anchorSec * 1000))
            }
          />
          <ViewScroll view={view} duration={buffer.duration} onChange={setView} />
        </>
      ) : null}
      {buffer === null ? <p className="t-muted">{C.needFile}</p> : null}
      {buffer === null ? null : (
        <>
          <ClipTransport
            playing={player.playing}
            loop={loop}
            audition={audition !== null}
            viewMs={view.spanMs}
            canPlaySel={sel !== null && Math.abs(sel.end - sel.start) >= MIN_LEN}
            onTogglePlay={togglePlay}
            onPlaySel={() => {
              if (sel === null) return
              endAudition()
              player.play(Math.min(sel.start, sel.end), Math.max(sel.start, sel.end))
            }}
            onStop={() => {
              endAudition()
              player.stop()
              player.seek(0)
            }}
            onToggleLoop={() => setLoop(!loop)}
            onToggleAudition={toggleAudition}
            onPickView={pickView}
          />
          <p className="t-muted t-note">
            {C.spaceHint}
            {anchor === null ? '' : ` ${C.anchorHint}`}
          </p>
          <div className="t-sel">
            <span className="t-row-label">{C.selection}</span>
            <span className="t-mono">{sel === null ? C.noSelection : spanText(sel)}</span>
            {sel === null ? null : (
              <div className="t-nudges">
                <span className="t-muted">{C.nudgeStart}</span>
                {NUDGES.map((d) => (
                  <button key={`s${d}`} type="button" className="t-btn t-btn-mini" onClick={() => nudge('start', d)}>
                    {d > 0 ? `+${String(Math.round(d * 1000))}` : String(Math.round(d * 1000))}
                  </button>
                ))}
                <span className="t-muted">{C.nudgeEnd}</span>
                {NUDGES.map((d) => (
                  <button key={`e${d}`} type="button" className="t-btn t-btn-mini" onClick={() => nudge('end', d)}>
                    {d > 0 ? `+${String(Math.round(d * 1000))}` : String(Math.round(d * 1000))}
                  </button>
                ))}
              </div>
            )}
            <p className="t-muted t-note">{C.nudgeHint}</p>
          </div>
          <div className="t-actions">
            <button type="button" className="t-btn" disabled={busy} onClick={() => dropAtHead('start')}>
              {C.headStart}
            </button>
            <button type="button" className="t-btn" disabled={busy} onClick={() => dropAtHead('end')}>
              {C.headEnd}
            </button>
            <button type="button" className="t-btn" disabled={busy} onClick={addMark}>
              {C.addMark}
            </button>
            <button
              type="button"
              className="t-btn"
              disabled={busy || sel === null || Math.abs(sel.end - sel.start) < MIN_LEN}
              onClick={() => {
                if (sel === null) return
                void saveOne(Math.min(sel.start, sel.end), Math.max(sel.start, sel.end), C.selLabel)
              }}
            >
              {C.exportSel}
            </button>
            <select className="t-select" value={format} disabled={busy} onChange={(e) => setFormat(e.target.value === 'mp3' ? 'mp3' : 'wav')}>
              <option value="wav">{C.formatWav}</option>
              <option value="mp3">{C.formatMp3}</option>
            </select>
          </div>
          <ClipMarks
            marks={marks}
            selMarkId={selMarkId}
            busy={busy}
            onPick={(mark) => {
              setSelMarkId(mark.id)
              setSel({ start: mark.start, end: mark.end })
              setGrip('start')
              player.seek(mark.start)
            }}
            onPlay={playMark}
            onRename={(id, name) => setMarks(marks.map((m) => (m.id === id ? { ...m, name } : m)))}
            onDelete={(id) => {
              setMarks(marks.filter((m) => m.id !== id))
              if (selMarkId === id) setSelMarkId(null)
            }}
            onExport={(mark) => void saveOne(mark.start, mark.end, mark.name)}
          />
          <div className="t-actions">
            <button type="button" className="t-btn t-btn-run" disabled={busy || marks.length === 0} onClick={() => void saveAll()}>
              {C.exportAll}
            </button>
          </div>
          {busy || status !== '' ? <ProgressBar ratio={ratio} label={status} /> : null}
          <p className="t-muted t-note">{toolsCopy.common.privacy}</p>
        </>
      )}
    </section>
  )
}

/**
 * 波形 + 指针交互（adj1317 改了三条，都是用户踩出来的）：
 *  1. 按住拖 = 选一段；**点一下 = 只挪播放头，选区留着**（以前点一下会把选区清掉）；
 *  2. 选区两端各有一个抓手：在边的附近按下，就只拖那一条边（另一端不动）；
 *  3. 拖得太短（<10ms）不算数，恢复拖动前的选区，免得手抖把辛苦调好的段弄没了。
 */
function ClipWave({
  buffer,
  peaks,
  view,
  sel,
  grip,
  head,
  marks,
  anchor,
  onSel,
  onSeek,
  onGrip,
  onTogglePlay,
  onZoom,
}: {
  buffer: AudioBuffer
  peaks: PeakBucket[]
  view: WaveView
  sel: WaveSpan | null
  grip: 'start' | 'end'
  head: number
  marks: readonly WaveSpan[]
  anchor: number | null
  onSel: (span: WaveSpan | null) => void
  onSeek: (at: number) => void
  onGrip: (side: 'start' | 'end') => void
  onTogglePlay: () => void
  onZoom: (factor: number, anchorSec: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<{
    mode: 'range' | 'start' | 'end'
    from: number
    to: number
    moved: boolean
    prev: WaveSpan | null
  } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    drawWave(canvas, { peaks, duration: buffer.duration, view, selection: sel, head, marks, grip, anchor })
  }, [peaks, buffer, view, sel, head, marks, grip, anchor])

  /**
   * Ctrl + 滚轮缩放（爱出片对拍台的视野口径）：锚点放在**鼠标那一处**，缩放后它不动。
   * 必须用原生监听并显式 `passive: false` —— React 的 `onWheel` 挂在 root 上、默认被动，
   * `preventDefault()` 不生效，会连带把整页滚走。
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const ratio = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
      const { v0, winMs } = viewWindow(view, buffer.duration * 1000)
      onZoom(e.deltaY < 0 ? 0.7 : 1.4, (v0 + ratio * winMs) / 1000)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [view, buffer, onZoom])

  /** 指针位置 → 音频秒（按**当前视野**换算，不是整曲） */
  const timeAt = (e: PointerEventOf<HTMLCanvasElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = clamp(e.clientX - rect.left, 0, rect.width)
    const { v0, winMs } = viewWindow(view, buffer.duration * 1000)
    return clamp((v0 + (x / Math.max(1, rect.width)) * winMs) / 1000, 0, buffer.duration)
  }

  /** 按下的位置是不是落在某条边的抓手上（8 像素以内算抓住） */
  const edgeAt = (e: PointerEventOf<HTMLCanvasElement>, at: number): 'start' | 'end' | null => {
    if (sel === null) return null
    const rect = e.currentTarget.getBoundingClientRect()
    const { winMs } = viewWindow(view, buffer.duration * 1000)
    const tol = (8 / Math.max(1, rect.width)) * (winMs / 1000)
    const dStart = Math.abs(at - sel.start)
    const dEnd = Math.abs(at - sel.end)
    if (Math.min(dStart, dEnd) > tol) return null
    return dStart <= dEnd ? 'start' : 'end'
  }

  return (
    /* adj1319：让波形自己拿焦点 —— 点过波形之后按空格＝播放/暂停（以前快捷键根本没地方接）。
       用 tabIndex 而不是全局 window 监听：只有在波形上操作时才抢空格，输入段名时照常打字。 */
    <canvas
      ref={canvasRef}
      className="t-wave"
      tabIndex={0}
      title={`${C.nudgeHint} ${C.viewHint} ${C.spaceHint}`}
      onKeyDown={(e) => {
        if (e.key !== ' ' && e.key !== 'Spacebar') return
        e.preventDefault()
        onTogglePlay()
      }}
      onPointerDown={(e) => {
        e.currentTarget.focus()
        e.currentTarget.setPointerCapture(e.pointerId)
        const t = timeAt(e)
        const edge = edgeAt(e, t)
        if (edge !== null) {
          onGrip(edge)
          dragRef.current = { mode: edge, from: t, to: t, moved: false, prev: sel }
          return
        }
        dragRef.current = { mode: 'range', from: t, to: t, moved: false, prev: sel }
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current
        if (drag === null) return
        const t = timeAt(e)
        drag.to = t
        if (drag.mode === 'range') {
          if (Math.abs(t - drag.from) * buffer.sampleRate <= 2) return
          drag.moved = true
          onSel({ start: drag.from, end: t })
          return
        }
        if (Math.abs(t - drag.from) * buffer.sampleRate <= 0) return
        drag.moved = true
        const base = drag.prev ?? sel
        if (base === null) return
        onSel(drag.mode === 'start' ? { start: t, end: base.end } : { start: base.start, end: t })
      }}
      onPointerUp={() => {
        const drag = dragRef.current
        dragRef.current = null
        if (drag === null) return
        if (drag.mode !== 'range') return
        if (!drag.moved) {
          onSeek(drag.from)
          return
        }
        if (Math.abs(drag.to - drag.from) < MIN_LEN) onSel(drag.prev)
      }}
      onPointerCancel={() => {
        dragRef.current = null
      }}
    />
  )
}

/**
 * adj1319（用户：「波形放大后，应添加滚动条来移动波形显示位置」）：
 * 滑块的位置与宽度用爱出片 `scrollThumb` 的口径（右端不越界）；拖滑块 = 平移视野，
 * 点轨道 = 把滑块中心挪到那一点。整曲时整条不出现，免得占地方。
 */
function ViewScroll({
  view,
  duration,
  onChange,
}: {
  view: WaveView
  duration: number
  onChange: (next: WaveView) => void
}) {
  const durMs = Math.max(1, duration * 1000)
  const thumb = scrollThumb(view, durMs)
  const dragRef = useRef<{ x0: number; startMs0: number; spanMs: number } | null>(null)
  if (!thumb.visible) return null
  const winMs = Math.max(1, (thumb.widthPct / 100) * durMs)
  return (
    <div
      className="t-scroll"
      title={C.scrollHint}
      role="scrollbar"
      aria-label={C.scrollHint}
      aria-valuemin={0}
      aria-valuemax={Math.round(durMs)}
      aria-valuenow={Math.round((thumb.leftPct / 100) * durMs)}
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const ratio = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
        const onThumb = e.target instanceof HTMLElement && e.target.classList.contains('t-scroll-thumb')
        e.currentTarget.setPointerCapture(e.pointerId)
        if (!onThumb) {
          // 点轨道：滑块中心跳到点击处（比"翻一屏"更符合直觉）
          onChange(clampView({ spanMs: winMs, startMs: ratio * durMs - winMs / 2 }, durMs))
          return
        }
        dragRef.current = { x0: e.clientX, startMs0: (thumb.leftPct / 100) * durMs, spanMs: winMs }
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current
        if (drag === null) return
        const rect = e.currentTarget.getBoundingClientRect()
        const dxMs = ((e.clientX - drag.x0) / Math.max(1, rect.width)) * durMs
        onChange(clampView({ spanMs: drag.spanMs, startMs: drag.startMs0 + dxMs }, durMs))
      }}
      onPointerUp={() => {
        dragRef.current = null
      }}
      onPointerCancel={() => {
        dragRef.current = null
      }}
    >
      <div className="t-scroll-thumb" style={{ left: `${thumb.leftPct}%`, width: `${thumb.widthPct}%` }} />
    </div>
  )
}

/** 播放控制条（播放 / 播放选区 / 回到开头 / 循环选区 / 复听 / 视野） */
function ClipTransport({
  playing,
  loop,
  audition,
  viewMs,
  canPlaySel,
  onTogglePlay,
  onPlaySel,
  onStop,
  onToggleLoop,
  onToggleAudition,
  onPickView,
}: {
  playing: boolean
  loop: boolean
  audition: boolean
  viewMs: number
  canPlaySel: boolean
  onTogglePlay: () => void
  onPlaySel: () => void
  onStop: () => void
  onToggleLoop: () => void
  onToggleAudition: () => void
  onPickView: (spanMs: number) => void
}) {
  return (
    <div className="t-actions">
      <button type="button" className="t-btn t-btn-run" onClick={onTogglePlay}>
        {playing ? C.pause : C.play}
      </button>
      <button type="button" className="t-btn" disabled={!canPlaySel} onClick={onPlaySel}>
        {C.playSel}
      </button>
      <button type="button" className="t-btn" onClick={onStop}>
        {C.stop}
      </button>
      <button
        type="button"
        className={audition ? 't-btn is-on' : 't-btn'}
        title={C.auditionHint}
        onClick={onToggleAudition}
      >
        {C.audition}
      </button>
      <label className="t-check">
        <input type="checkbox" checked={loop} onChange={onToggleLoop} />
        {C.loop}
      </label>
      <label className="t-check" title={C.viewHint}>
        {C.viewLabel}
        <select
          className="t-select"
          value={String(viewMs)}
          onChange={(e) => onPickView(Number(e.target.value))}
        >
          {VIEW_PRESETS_MS.map((ms) => (
            <option key={ms} value={String(ms)}>
              {ms === 0 ? C.viewAll : `${ms / 1000} 秒`}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

/** 标记段列表：播放 / 选中 / 改名 / 单独导出 / 删掉 */
function ClipMarks({
  marks,
  selMarkId,
  busy,
  onPick,
  onPlay,
  onRename,
  onDelete,
  onExport,
}: {
  marks: Mark[]
  selMarkId: string | null
  busy: boolean
  onPick: (mark: Mark) => void
  onPlay: (mark: Mark) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onExport: (mark: Mark) => void
}) {
  return (
    <div className="t-marks">
      <h3>{C.marks}</h3>
      {marks.length === 0 ? <p className="t-muted">{C.noMarks}</p> : null}
      <ol>
        {marks.map((mark) => (
          <li key={mark.id} className={mark.id === selMarkId ? 'is-sel' : ''}>
            <input
              className="t-input"
              value={mark.name}
              aria-label={C.markName}
              onChange={(e) => onRename(mark.id, e.target.value)}
            />
            <span className="t-mono">{spanText(mark)}</span>
            <button type="button" className="t-btn t-btn-mini" onClick={() => onPlay(mark)}>
              {C.playMark}
            </button>
            <button type="button" className="t-btn t-btn-mini" onClick={() => onPick(mark)}>
              {C.pickMark}
            </button>
            <button type="button" className="t-btn t-btn-mini" disabled={busy} onClick={() => onExport(mark)}>
              {C.exportMark}
            </button>
            <button type="button" className="t-btn t-btn-mini" disabled={busy} onClick={() => onDelete(mark.id)}>
              {C.deleteMark}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
