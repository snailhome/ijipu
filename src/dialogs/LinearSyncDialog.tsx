/**
 * dialogs/LinearSyncDialog.tsx — 连续动态谱「对拍台」（adj1264）
 *
 * ## 这块台面做什么
 *
 * 用户 2026-11-08 的 M3：导入背景视频 → 对拍（打点/微调/保留段）→ 选标记段 →
 * 混音（视频原声 / 外部伴奏 / 合成音）→ 出片。方案见 `docs/CONTINUOUS-SCORE-PLAN.md` §六。
 *
 * ## 为什么另开一个台面而不是塞进 `SyncDialog`
 *
 * `SyncDialog` 的"预览"是 A4 版面的相机位（`PreviewPane` + `DynamicFrameOverlay` 那一路），
 * 连续谱的预览是**一整块视频画布 + 一条横滚的谱带**（`linearSession.draw`）。
 * 两者的对拍、混音、保留段是同一份 `syncStore` 数据，所以这里只重写"看的那一半"，
 * 对拍数据/口径全部复用（`syncDoc` / `fitSync` / `syncRuler` / 同一份 sidecar）。
 *
 * ## 三条硬约束（方案 §二）
 *
 *  · `draw(t)` 是纯函数：画面全由 `t` 算，视频帧按"时间桶"缓存 ⇒ 同一个 t 画两次一致；
 *  · 解码失败**必须明确提示**（`VIDEO_ERRORS` 的人话），不许静默黑屏；
 *  · 没视频时用**背景图/纯色**兜底（用户 P5）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildLinearStrip,
  buildPlaySequence,
  inferBpm,
  layoutScore,
  resolvePracticeRange,
  stripEndMs,
  type LinearStrip,
  type PageConfig,
} from '@ijipu/engine'
import { useDocStore } from '../store/docStore'
import { useSyncStore } from '../store/syncStore'
import { useUiStore } from '../store/uiStore'
import { renderToAudioBuffer } from '../export/audio'
import { createHqCache, resolveHqBank } from '../playback/spessaCache'
import { resolveActiveLibrary } from '../playback/spessaSynthBackend'
import { hostBankUrl } from '../store/hostBridge'
import { decodeAccompaniment, waveformPeaks } from '../export/video/accompaniment'
import { DEFAULT_SYNC_MIX, syncDocStale, audioRefOf, effectiveSyncFitOf } from '../export/video/syncDoc'
import { pickAudioFileNative, readSidecarAudio } from '../export/video/syncIo'
import { loadSidecarAudioFor } from '../store/syncSidecar'
import { stripThemeOf, STRIP_THEMES, type StripThemeId } from '../export/video/stripTheme'
import { createLinearSession, type LinearSession } from '../export/video/linearSession'
import {
  audioTracksOf,
  encodeLinearMp4,
  mixLinearAudio,
  playbackWindowsOf,
  type LinearAudioTrack,
} from '../export/video/linearExport'
import {
  evenSizeOf,
  exportRangeOf,
  linearClockOf,
  linearMixPlanOf,
  mediaMsAt,
  scoreMsAt,
} from '../export/video/linearSync'
import { LinearVideoSource } from '../export/video/videoSource'
import { canUseDynamicVideo } from '../export/video/capability'
import { bytesToBase64 } from '../export/zip'
import { isTauriShell, tauriInvoke } from '../brand/env'
import { dynamicVideoCopy, linearSyncCopy, syncCopy } from '../brand/copy'
import { audioClockOf, timeLabelOf, timeScaleOf } from './syncRuler'

/** 台面里谱带字号（出片宽高由视频决定；字号只决定"一屏几拍"的疏密） */
const STRIP_NOTE_SIZE = 64

/** 波形画布：波形本体 + 下侧标尺 */
const WAVE_H = 118
const RULER_H = 18

/** 出片帧率（与 `mp4.ts` 缺省一致） */
const FPS = 30

/** 混音三档的中文名（写在这里而不是 copy 里，是因为它跟 `source` 值一一对应） */
const MIX_SOURCES = ['file', 'mix', 'synth'] as const

/** 主时间轴长度（ms）：有外部伴奏用伴奏，否则用视频时长（`audioDurationMs` 由两者写入） */
function baseNameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return i < 0 ? path : path.slice(i + 1)
}

/**
 * 把音轨按"从媒体时刻 `fromMs` 起播"排出来（纯计算，便于断言与排错）。
 *
 * 与 `linearExport.mixLinearAudio` 的口径**必须一致**：预览与出片各算一套，音画必错。
 */
export function LinearSyncDialog() {
  const closeModal = useUiStore((s) => s.closeModal)
  const showNotice = useUiStore((s) => s.showNotice)
  const practiceMarks = useUiStore((s) => s.practiceMarks)
  const practiceMarkId = useUiStore((s) => s.practiceMarkId)
  const setPracticeMarkId = useUiStore((s) => s.setPracticeMarkId)

  const code = useDocStore((s) => s.code)
  const fileName = useDocStore((s) => s.fileName)
  const parseResult = useDocStore((s) => s.parseResult)
  const pageConfig = useDocStore((s) => s.pageConfig)

  const doc = useSyncStore((s) => s.doc)
  const audio = useSyncStore((s) => s.audio)
  const ensureFor = useSyncStore((s) => s.ensureFor)
  const setAudio = useSyncStore((s) => s.setAudio)
  const setAudioBuffer = useSyncStore((s) => s.setAudioBuffer)
  const setMediaDuration = useSyncStore((s) => s.setMediaDuration)
  const addAnchor = useSyncStore((s) => s.addAnchor)
  const removeAnchor = useSyncStore((s) => s.removeAnchor)
  const setTrim = useSyncStore((s) => s.setTrim)
  const setMix = useSyncStore((s) => s.setMix)
  const setExtras = useSyncStore((s) => s.setExtras)

  const available = canUseDynamicVideo()

  // ---------- 谱面 → 条带 ----------
  const scoreBpm = useMemo(() => inferBpm(parseResult), [parseResult])
  const scoreBeatMs = 60000 / scoreBpm
  const scoreSeq = useMemo(() => {
    const lay = layoutScore(parseResult, pageConfig)
    return buildPlaySequence(parseResult, lay, scoreBpm)
  }, [parseResult, pageConfig, scoreBpm])
  /** 条带的排版配置：字号固定（出片分辨率与字号无关，字号只影响"一屏几拍"） */
  const stripCfg = useMemo<PageConfig>(() => ({ ...pageConfig, note_size: STRIP_NOTE_SIZE }), [pageConfig])
  const strip: LinearStrip = useMemo(() => {
    const lay = layoutScore(parseResult, stripCfg)
    return buildLinearStrip(lay, scoreSeq, stripCfg, { pxPerBeat: Math.round(STRIP_NOTE_SIZE * 1.6) })
  }, [parseResult, stripCfg, scoreSeq])
  const scoreEndMs = useMemo(() => stripEndMs(strip), [strip])
  const barStartBeats = useMemo(() => (scoreSeq.barStartsMs ?? []).map((ms) => ms / scoreBeatMs), [scoreSeq, scoreBeatMs])
  const barNoOf = useCallback((i: number): number => scoreSeq.barNos?.[i] ?? i + 1, [scoreSeq])

  // ---------- 对拍（sidecar 里的同一份数据） ----------
  useEffect(() => {
    ensureFor(fileName, code)
  }, [ensureFor, fileName, code])

  const fit = useMemo(() => effectiveSyncFitOf(doc, scoreBeatMs), [doc, scoreBeatMs])
  const mediaMs = doc?.audioDurationMs ?? 0
  const clock = useMemo(
    () => linearClockOf({ offsetMs: fit?.offsetMs ?? 0, mediaMs, scoreEndMs, scoreBeatMs }),
    [fit?.offsetMs, mediaMs, scoreEndMs, scoreBeatMs],
  )
  const trim = useMemo(() => doc?.trim ?? { startMs: 0, endMs: mediaMs }, [doc?.trim, mediaMs])
  const range = useMemo(() => exportRangeOf(clock, trim), [clock, trim])
  const linearStyle = doc?.linear ?? {}

  // ---------- 媒体（视频 / 背景图 / 纯色） ----------
  const [video, setVideo] = useState<LinearVideoSource | null>(null)
  const [videoAudio, setVideoAudio] = useState<AudioBuffer | null>(null)
  const [videoBusy, setVideoBusy] = useState(false)
  const [bgImage, setBgImage] = useState<{ bitmap: ImageBitmap; w: number; h: number } | null>(null)
  const [bgColor, setBgColor] = useState('#101014')
  const [notice, setNotice] = useState('')
  const [frameMiss, setFrameMiss] = useState(false)

  const videoRef = useRef<LinearVideoSource | null>(null)
  useEffect(() => {
    videoRef.current = video
  }, [video])
  useEffect(() => () => video?.close(), [video])

  /** 出片/预览画布尺寸（视频宽高，奇数往下取偶；没视频用 9:16） */
  const out = useMemo(
    () => (video !== null ? evenSizeOf(video.info.width, video.info.height) : { width: 1080, height: 1920 }),
    [video],
  )

  // ---------- 合成音 ----------
  const [synthBuf, setSynthBuf] = useState<AudioBuffer | null>(null)
  const [synthState, setSynthState] = useState<'idle' | 'loading' | 'error'>('idle')
  const synthKeyRef = useRef('')
  const ensureSynth = useCallback(async (): Promise<AudioBuffer | null> => {
    const key = `${scoreBpm}|${code.length}`
    if (synthBuf !== null && synthKeyRef.current === key) return synthBuf
    if (synthState === 'loading') return null
    setSynthState('loading')
    try {
      const lib = resolveActiveLibrary(useUiStore.getState().playbackHqLibrary).lib
      const cache = createHqCache()
      const { bank } = await resolveHqBank(lib, cache, hostBankUrl(lib.id))
      const buf = await renderToAudioBuffer(scoreSeq.events, bank, { bpm: scoreBpm })
      synthKeyRef.current = key
      setSynthBuf(buf)
      setSynthState('idle')
      return buf
    } catch {
      setSynthState('error')
      return null
    }
  }, [code.length, scoreBpm, scoreSeq.events, synthBuf, synthState])

  // ---------- 混音计划（三路：视频原声 / 伴奏 / 合成音） ----------
  const mix = doc?.mix ?? DEFAULT_SYNC_MIX
  const plan = useMemo(
    () =>
      linearMixPlanOf({
        hasVideoAudio: videoAudio !== null,
        hasAccomp: audio !== null,
        hasSynth: synthBuf !== null,
        source: mix.source,
        videoGain: mix.video ?? 1,
        accompGain: mix.accomp,
        synthGain: mix.synth,
      }),
    [audio, mix, synthBuf, videoAudio],
  )
  /** 合成音变速：合成音按谱面 `J:` 渲染，对拍拍速不同就要按比例放 */
  const synthRate = fit !== null ? scoreBeatMs / fit.beatMs : 1
  const tracks = useMemo<LinearAudioTrack[]>(
    () => audioTracksOf(plan, { video: videoAudio, accomp: audio, synth: synthBuf }, clock.offsetMs, synthRate),
    [audio, clock.offsetMs, plan, synthBuf, synthRate, videoAudio],
  )
  /** 选到合成音才现渲染（几秒），渲染失败按文案回退（`plan.synthFallback`） */
  useEffect(() => {
    if (mix.source === 'file') return
    if (synthBuf !== null || synthState === 'loading' || synthState === 'error') return
    void ensureSynth()
  }, [ensureSynth, mix.source, synthBuf, synthState])

  /** 波形用哪条音轨：外部伴奏优先，其次视频原声 */
  const soundtrack = audio ?? videoAudio
  const peaks = useMemo(() => {
    if (soundtrack === null) return [] as { min: number; max: number }[]
    const chans = [0, 1].map((c) => soundtrack.getChannelData(Math.min(c, soundtrack.numberOfChannels - 1)))
    return waveformPeaks(chans, 1200)
  }, [soundtrack])

  // ---------- 会话（一帧合成：背景 → 谱带 → 色块 → 球） ----------
  const sessionRef = useRef<LinearSession | null>(null)
  const stageRef = useRef<HTMLCanvasElement | null>(null)
  const waveRef = useRef<HTMLCanvasElement | null>(null)
  const themeId = (linearStyle.theme ?? 'night') as StripThemeId
  const topRatio = linearStyle.topRatio ?? 0.25
  const blockRatio = linearStyle.blockRatio ?? 1 / 3
  const bandScale = linearStyle.bandScale ?? 1
  const [sessionReady, setSessionReady] = useState(false)

  useEffect(() => {
    let alive = true
    const style = stripThemeOf(themeId)
    const background =
      video !== null
        ? {
            kind: 'video' as const,
            draw: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, tMs: number) => {
              // 帧没解出来时先铺底色（负向判据：不许静默黑屏；台面同时给一句提示）
              ctx.fillStyle = bgColor
              ctx.fillRect(0, 0, out.width, out.height)
              const ok = videoRef.current?.drawFrame(ctx, tMs, out.width, out.height) ?? false
              if (!ok) setFrameMiss(true)
            },
          }
        : bgImage !== null
          ? { kind: 'image' as const, image: bgImage.bitmap, w: bgImage.w, h: bgImage.h }
          : { kind: 'color' as const, color: bgColor }
    void createLinearSession({
      strip,
      cfg: stripCfg,
      width: out.width,
      height: out.height,
      style,
      background,
      lay: { topRatio, blockRatio },
      bandScale,
    }).then((s) => {
      if (!alive) return
      sessionRef.current = s
      setSessionReady(true)
    })
    return () => {
      alive = false
      sessionRef.current = null
      setSessionReady(false)
    }
  }, [bgColor, bgImage, bandScale, blockRatio, out.height, out.width, strip, stripCfg, themeId, topRatio, video])

  // ---------- 绘制 ----------
  const playheadRef = useRef(0)
  const [, forcePaint] = useState(0)
  const drawingRef = useRef(false)

  const paintWave = useCallback(() => {
    const c = waveRef.current
    if (c === null) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(200, c.clientWidth)
    c.width = Math.round(w * dpr)
    c.height = Math.round((WAVE_H + RULER_H) * dpr)
    const ctx = c.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, WAVE_H + RULER_H)
    const total = Math.max(1, clock.totalMs)
    const xOf = (ms: number): number => (ms / total) * w
    // ① 保留段之外压暗（"只导这一段"一眼可见）
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.fillRect(0, 0, xOf(range.startMs), WAVE_H)
    ctx.fillRect(xOf(range.endMs), 0, w - xOf(range.endMs), WAVE_H)
    // ② 波形
    const mid = WAVE_H / 2
    ctx.strokeStyle = 'var(--jp-accent, #2f6fed)'
    ctx.globalAlpha = 0.85
    ctx.beginPath()
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / Math.max(1, peaks.length - 1)) * w
      const p = peaks[i]
      ctx.moveTo(x, mid - p.max * mid * 0.92)
      ctx.lineTo(x, mid - p.min * mid * 0.92)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
    // ③ 保留段两端的竖线 + 标尺
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'
    ctx.beginPath()
    ctx.moveTo(xOf(range.startMs), 0)
    ctx.lineTo(xOf(range.startMs), WAVE_H)
    ctx.moveTo(xOf(range.endMs), 0)
    ctx.lineTo(xOf(range.endMs), WAVE_H)
    ctx.stroke()
    const scale = timeScaleOf(0, total, w)
    ctx.fillStyle = 'var(--jp-text-secondary, #aaa)'
    ctx.font = '10px system-ui, sans-serif'
    ctx.textBaseline = 'top'
    for (const tick of scale.ticks) {
      const x = xOf(tick)
      ctx.fillRect(x, WAVE_H, 1, 3)
      ctx.fillText(timeLabelOf(tick, scale.stepMs), x + 3, WAVE_H + 4)
    }
    // ④ 锚点（打点位置）
    ctx.strokeStyle = 'var(--jp-warning, #e0a020)'
    ctx.beginPath()
    for (const a of doc?.anchors ?? []) {
      const x = xOf(Math.max(0, Math.min(total, a.audioMs)))
      ctx.moveTo(x, 0)
      ctx.lineTo(x, WAVE_H)
    }
    ctx.stroke()
    // ⑤ 播放头
    const px = xOf(Math.max(0, Math.min(total, playheadRef.current)))
    ctx.strokeStyle = 'var(--jp-danger, #ff5d6c)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, WAVE_H)
    ctx.stroke()
    ctx.lineWidth = 1
  }, [clock.totalMs, doc?.anchors, peaks, range.endMs, range.startMs])

  const paintStage = useCallback(
    (tMs: number) => {
      const s = sessionRef.current
      const c = stageRef.current
      if (s === null || c === null) return
      const ctx = c.getContext('2d')
      if (ctx === null) return
      s.draw(ctx, tMs)
    },
    [],
  )

  /** 一帧：先解码视频（`warm`），再画；同一个 t 画两次结果一致（帧按时间桶缓存） */
  const paintAt = useCallback(
    (tMs: number) => {
      playheadRef.current = tMs
      if (drawingRef.current) return
      drawingRef.current = true
      void (async () => {
        try {
          await videoRef.current?.warm(tMs)
          await sessionRef.current?.warm(tMs)
          paintStage(tMs)
          paintWave()
        } finally {
          drawingRef.current = false
        }
      })()
    },
    [paintStage, paintWave],
  )

  // 没在播（改设置、拖播放头）时也要重画
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      paintAt(playheadRef.current)
      forcePaint((n) => n + 1)
    })
    return () => cancelAnimationFrame(id)
  }, [paintAt, sessionReady])

  // ---------- 播放器 ----------
  const ctxRef = useRef<AudioContext | null>(null)
  const startRef = useRef<{ at: number; from: number } | null>(null)
  const playingRef = useRef(false)
  const [playing, setPlaying] = useState(false)
  const sourcesRef = useRef<AudioBufferSourceNode[]>([])
  const gainsRef = useRef<GainNode[]>([])
  const rafRef = useRef(0)
  const posRef = useRef<HTMLSpanElement | null>(null)

  const ensureCtx = useCallback((): AudioContext => {
    ctxRef.current ??= new AudioContext()
    return ctxRef.current
  }, [])

  const currentMs = useCallback((): number => {
    const ctx = ctxRef.current
    const si = startRef.current
    if (ctx === null || si === null || !playingRef.current) return playheadRef.current
    return si.from + (ctx.currentTime - si.at) * 1000
  }, [])

  const stopPlayback = useCallback(() => {
    for (const s of sourcesRef.current) {
      try {
        s.stop()
      } catch {
        /* 已自然结束 */
      }
      s.disconnect()
    }
    sourcesRef.current = []
    gainsRef.current = []
    playingRef.current = false
    startRef.current = null
    cancelAnimationFrame(rafRef.current)
    setPlaying(false)
  }, [])

  const startPlayback = useCallback(
    (fromMs: number) => {
      stopPlayback()
      const usable = tracks.filter((t) => t.gain > 0)
      if (usable.length === 0) {
        setNotice(plan.silent ? linearSyncCopy.noSound : linearSyncCopy.noMedia)
        return
      }
      const ctx = ensureCtx()
      void ctx.resume()
      const from = Math.max(0, Math.min(fromMs, clock.totalMs))
      const at = ctx.currentTime
      const windows = playbackWindowsOf(usable, from)
      const beatMs = fit?.beatMs ?? scoreBeatMs
      const fadeStart = Math.max(from, range.endMs - beatMs)
      for (let i = 0; i < usable.length; i++) {
        const t = usable[i]
        const w = windows[i]
        const src = ctx.createBufferSource()
        src.buffer = t.buffer
        src.playbackRate.value = t.rate !== undefined && t.rate > 0 ? t.rate : 1
        const gain = ctx.createGain()
        gain.gain.value = t.gain
        // 收尾淡出（与出片音轨同一口径：最后一拍线性到 0）
        if (range.endMs - fadeStart > 20) {
          gain.gain.setValueAtTime(t.gain, at + Math.max(0, (fadeStart - from) / 1000))
          gain.gain.linearRampToValueAtTime(0, at + Math.max(0, (range.endMs - from) / 1000))
        }
        src.connect(gain)
        gain.connect(ctx.destination)
        src.start(at + w.whenSec, w.skipSec)
        sourcesRef.current.push(src)
        gainsRef.current.push(gain)
      }
      startRef.current = { at, from }
      playheadRef.current = from
      playingRef.current = true
      setPlaying(true)
      setFrameMiss(false)
      const tick = () => {
        if (!playingRef.current) return
        const t = currentMs()
        playheadRef.current = t
        if (posRef.current !== null) posRef.current.textContent = audioClockOf(t)
        paintAt(t)
        if (t >= range.endMs) {
          stopPlayback()
          paintAt(range.endMs)
          return
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [clock.totalMs, currentMs, ensureCtx, fit?.beatMs, paintAt, plan.silent, range.endMs, scoreBeatMs, stopPlayback, tracks],
  )

  const seekTo = useCallback(
    (ms: number) => {
      stopPlayback()
      paintAt(Math.max(0, Math.min(clock.totalMs, ms)))
      if (posRef.current !== null) posRef.current.textContent = audioClockOf(playheadRef.current)
    },
    [clock.totalMs, paintAt, stopPlayback],
  )

  // 播放中改音量要立刻听到
  useEffect(() => {
    const ctx = ctxRef.current
    if (ctx === null || !playingRef.current) return
    const now = ctx.currentTime
    const values = [plan.videoGain, plan.accompGain, plan.synthGain]
    gainsRef.current.forEach((g, i) => {
      const v = values[Math.min(i, values.length - 1)]
      try {
        g.gain.setTargetAtTime(v, now, 0.02)
      } catch {
        g.gain.value = v
      }
    })
  }, [plan.accompGain, plan.synthGain, plan.videoGain])

  // 卸载：停声、关上下文、关视频
  useEffect(
    () => () => {
      stopPlayback()
      const ctx = ctxRef.current
      ctxRef.current = null
      if (ctx !== null) void ctx.close().catch(() => {})
      videoRef.current?.close()
    },
    [stopPlayback],
  )

  // ---------- 导入 ----------
  const videoInputRef = useRef<HTMLInputElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const audioInputRef = useRef<HTMLInputElement | null>(null)

  const adoptVideo = useCallback(
    async (file: Blob, name: string) => {
      setVideoBusy(true)
      setNotice('')
      const r = await LinearVideoSource.open(file, name)
      if (!r.ok) {
        setVideoBusy(false)
        setNotice(r.error)
        return
      }
      const src = r.source
      setVideo(src)
      // 视频名字进 sidecar（只记名字）；时长当主时间轴（有伴奏时伴奏说话）
      setExtras({ video: name })
      if ((useSyncStore.getState().doc?.audio ?? '') === '') setMediaDuration(src.info.durationMs)
      // 视频自带音轨：解出来给波形/试听/出片用（失败不致命：那就只出无声画面）
      const buf = src.info.hasAudio ? await src.decodeAudio() : null
      setVideoAudio(buf)
      setVideoBusy(false)
      if (src.info.hasAudio && buf === null) setNotice(linearSyncCopy.videoAudioFailed)
      paintAt(playheadRef.current)
    },
    [paintAt, setExtras, setMediaDuration],
  )

  const onPickVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f === undefined) return
    await adoptVideo(f, f.name)
    e.target.value = ''
  }

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f === undefined) return
    try {
      const bitmap = await createImageBitmap(f)
      setBgImage({ bitmap, w: bitmap.width, h: bitmap.height })
      setVideo(null)
      setVideoAudio(null)
      setExtras({ video: '' })
      setNotice('')
    } catch {
      setNotice(linearSyncCopy.imageFailed)
    }
    e.target.value = ''
  }

  const onPickAudio = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f === undefined) return
    try {
      const buf = await decodeAccompaniment(await f.arrayBuffer())
      setAudio(f.name, buf)
      setNotice('')
    } catch {
      setNotice(syncCopy.decodeFailed)
    }
    e.target.value = ''
  }

  /** 桌面壳：伴奏走原生对话框（能拿到真实路径，写进 sidecar） */
  const onPickAudioNative = async () => {
    const path = await pickAudioFileNative()
    if (path === null) return
    const bytes = await readSidecarAudio(path)
    if (bytes === null) {
      setNotice(syncCopy.decodeFailed)
      return
    }
    try {
      const buf = await decodeAccompaniment(bytes)
      setAudio(audioRefOf(path, useDocStore.getState().nativePath), buf)
      setNotice('')
    } catch {
      setNotice(syncCopy.decodeFailed)
    }
  }

  /** 打开台面时：sidecar 里记过视频名 ⇒ 提示"上次用的那个请重选" */
  useEffect(() => {
    if (video !== null || doc?.video === undefined || doc.video === '') return
    setNotice(linearSyncCopy.videoRemembered(baseNameOf(doc.video)))
  }, [doc?.video, video])

  // 桌面壳：打开时自动读同目录伴奏（与 `SyncDialog` 同一口径）
  useEffect(() => {
    if (audio !== null) return
    const cur = doc
    if (cur === null || cur.audio === '') return
    const nativePath = useDocStore.getState().nativePath
    const binding = useDocStore.getState().binding
    let cancelled = false
    void (async () => {
      const bytes = await loadSidecarAudioFor(nativePath, binding, cur)
      if (cancelled || bytes === null) return
      try {
        const buf = await decodeAccompaniment(bytes)
        if (!cancelled) setAudioBuffer(buf)
      } catch {
        /* 解不出来就保持"没伴奏"，台面另有提示与「选伴奏…」入口 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [audio, doc, setAudioBuffer])

  // ---------- 对拍 ----------
  const [pending, setPending] = useState<{ mediaMs: number } | null>(null)
  const [bar, setBar] = useState(1)
  const [beat, setBeat] = useState(1)

  const barBeatLabel = useCallback(
    (b: number): string => {
      for (let i = barStartBeats.length - 1; i >= 0; i--) {
        if (b >= barStartBeats[i] - 1e-6) return `${barNoOf(i)}:${Math.round((b - barStartBeats[i]) * 100) / 100 + 1}`
      }
      return `${Math.round(b * 100) / 100}`
    },
    [barNoOf, barStartBeats],
  )
  const beatOfBarBeat = useCallback(
    (barNo: number, beatNo: number): number | null => {
      const i = barStartBeats.findIndex((_, idx) => barNoOf(idx) === barNo)
      const start = i >= 0 ? barStartBeats[i] : undefined
      return start === undefined ? null : start + (beatNo - 1)
    },
    [barNoOf, barStartBeats],
  )

  const tap = useCallback(() => {
    if (clock.totalMs <= 0) {
      setNotice(linearSyncCopy.noMedia)
      return
    }
    const ms = currentMs()
    stopPlayback()
    playheadRef.current = Math.max(0, Math.min(ms, clock.totalMs))
    paintAt(playheadRef.current)
    setPending({ mediaMs: Math.round(ms) })
    // 默认谱位：当前位置对应的拍（取整，避免造出"第 1.33 拍"的半拍锚点）
    const scoreMs = scoreMsAt(clock, ms)
    const beats = scoreMs / scoreBeatMs
    const label = barBeatLabel(beats)
    const [b, k] = label.split(':').map(Number)
    if (Number.isFinite(b)) setBar(b)
    if (Number.isFinite(k)) setBeat(Math.max(1, Math.round(k)))
  }, [barBeatLabel, clock, currentMs, paintAt, scoreBeatMs, stopPlayback])

  const confirmTap = useCallback(() => {
    if (pending === null) return
    if (!Number.isFinite(bar) || !Number.isFinite(beat) || bar < 1 || beat < 1) {
      setNotice(syncCopy.beatPosInvalid)
      return
    }
    const b = beatOfBarBeat(bar, beat)
    if (b === null) {
      setNotice(linearSyncCopy.noSuchBar(bar))
      return
    }
    if ((doc?.anchors ?? []).some((a) => Math.abs(a.beat - b) < 1e-6)) {
      setNotice(linearSyncCopy.dupAnchor)
      return
    }
    addAnchor({ beat: b, audioMs: pending.mediaMs })
    setPending(null)
    setNotice('')
  }, [addAnchor, bar, beat, beatOfBarBeat, doc?.anchors, pending])

  const nudgeTrim = useCallback(
    (which: 'start' | 'end', delta: number) => {
      const cur = useSyncStore.getState().doc?.trim ?? { startMs: 0, endMs: clock.totalMs }
      setTrim({
        startMs: which === 'start' ? cur.startMs + delta : cur.startMs,
        endMs: which === 'end' ? cur.endMs + delta : cur.endMs,
      })
    },
    [clock.totalMs, setTrim],
  )

  // ---------- 标记段（练习段列表）→ 保留段 ----------
  const onPickMark = useCallback(
    (id: string) => {
      setPracticeMarkId(id)
      if (id === '') {
        setTrim({ startMs: 0, endMs: clock.totalMs })
        setExtras({ range: null, markId: '' })
        return
      }
      const m = practiceMarks.find((x) => x.id === id)
      if (m === undefined) return
      const r = resolvePracticeRange(scoreSeq, m.startId, m.endId, { endInLayout: true })
      const cand = r.candidates[m.pass ?? r.pick] ?? r.candidates[0]
      if (cand === undefined) {
        setNotice(linearSyncCopy.markMissing)
        return
      }
      const e0 = scoreSeq.events[cand.i0]
      const e1 = scoreSeq.events[cand.i1]
      if (e0 === undefined || e1 === undefined) {
        setNotice(linearSyncCopy.markMissing)
        return
      }
      const startMs = mediaMsAt(clock, e0.atMs)
      const endMs = mediaMsAt(clock, Math.min(scoreEndMs, e1.atMs + e1.durationMs))
      setTrim({ startMs, endMs })
      setExtras({
        range: { startId: m.startId, endId: m.endId, ...(m.pass !== undefined ? { pass: m.pass } : {}) },
        markId: id,
      })
      seekTo(startMs)
      setNotice('')
    },
    [clock, practiceMarks, scoreEndMs, scoreSeq, seekTo, setExtras, setPracticeMarkId, setTrim],
  )

  // ---------- 出片 ----------
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  const onExport = useCallback(async () => {
    const s = sessionRef.current
    if (s === null || exporting) return
    if (typeof VideoEncoder === 'undefined') {
      setNotice(linearSyncCopy.noWebCodecs)
      return
    }
    setExporting(true)
    setProgress(0)
    setNotice('')
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const mixed = await mixLinearAudio(tracks, range)
      const outSession = {
        width: out.width,
        height: out.height,
        totalMs: range.durationMs,
        draw: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, t: number): void => {
          s.draw(ctx, range.startMs + t)
        },
        warm: async (t: number): Promise<void> => {
          await videoRef.current?.warm(range.startMs + t)
          await s.warm(range.startMs + t)
        },
      }
      const blob = await encodeLinearMp4(outSession, {
        fps: FPS,
        audio: mixed,
        onProgress: (p) => setProgress(p),
        signal: ac.signal,
      })
      const file = baseNameOf(fileName).replace(/\.jps$/i, '')
      const name = `连续动态谱-${file}.mp4`
      if (isTauriShell()) {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const savedPath = await tauriInvoke<string | null>('save_mp4_file', { name, b64: bytesToBase64(bytes) })
        if (savedPath === null || savedPath === '') {
          showNotice(linearSyncCopy.exportCanceled, 'warn')
          return
        }
        showNotice(linearSyncCopy.exported(savedPath), 'ok', [
          { label: dynamicVideoCopy.openFile, run: () => void tauriInvoke('open_local_path', { path: savedPath, reveal: false }) },
          { label: dynamicVideoCopy.openFolder, run: () => void tauriInvoke('open_local_path', { path: savedPath, reveal: true }) },
        ])
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      showNotice(linearSyncCopy.exportedWeb, 'ok')
    } catch (e) {
      if (ac.signal.aborted) showNotice(linearSyncCopy.exportCanceled, 'warn')
      else setNotice(linearSyncCopy.exportFailed(e instanceof Error ? e.message : String(e)))
    } finally {
      abortRef.current = null
      setExporting(false)
    }
  }, [exporting, fileName, out.height, out.width, range, showNotice, tracks])

  // ---------- 键盘 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') {
        stopPlayback()
        closeModal()
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        tap()
      } else if (e.key === ' ') {
        e.preventDefault()
        if (playingRef.current) stopPlayback()
        else startPlayback(playheadRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeModal, startPlayback, stopPlayback, tap])

  // ---------- 渲染 ----------
  if (!available) {
    return (
      <div className="sync-layer" role="dialog" aria-label={linearSyncCopy.title}>
        <div className="sync-panel sync-pad">
          <div className="sync-head">
            <b>{linearSyncCopy.title}</b>
            <span className="sync-grow" />
            <button type="button" className="btn" onClick={closeModal}>
              {syncCopy.close}
            </button>
          </div>
          <div className="sync-dim sync-pad">{linearSyncCopy.desktopOnly}</div>
        </div>
      </div>
    )
  }

  const stale = syncDocStale(doc, code)
  const selectedMark = practiceMarkId

  return (
    <div className="sync-layer" role="dialog" aria-label={linearSyncCopy.title}>
      <div className="sync-panel linear-panel">
        <div className="sync-head">
          <b>{linearSyncCopy.title}</b>
          <span className="sync-dim sync-name">{fileName}</span>
          {stale && <span className="sync-warn">{syncCopy.stale}</span>}
          <span className="sync-grow" />
          <button
            type="button"
            className="btn"
            onClick={() => {
              stopPlayback()
              closeModal()
            }}
            title={syncCopy.closeHint}
          >
            {syncCopy.close}
          </button>
        </div>

        <div className="linear-body">
          <div className="linear-stage">
            <canvas
              ref={stageRef}
              className="linear-stage-canvas"
              width={out.width}
              height={out.height}
              data-role="linear-stage"
              title={linearSyncCopy.stageHint}
            />
            <div className="linear-stage-info">
              <span className="sync-meta">
                {audioClockOf(playheadRef.current)} / {audioClockOf(clock.totalMs)}
              </span>
              <span className="sync-dim">
                {out.width}×{out.height} · {FPS}fps
              </span>
              {video === null && <span className="sync-dim">{bgImage === null ? linearSyncCopy.fallbackColor : linearSyncCopy.fallbackImage}</span>}
              {frameMiss && <span className="sync-warn">{linearSyncCopy.frameMissing}</span>}
              {notice !== '' && <span className="sync-warn linear-notice">{notice}</span>}
            </div>
          </div>

          <div className="sync-row">
            <input ref={videoInputRef} type="file" accept="video/*" className="sync-file" onChange={onPickVideo} />
            <button type="button" className="btn sync-mini" onClick={() => videoInputRef.current?.click()} disabled={videoBusy}>
              {videoBusy ? linearSyncCopy.videoBusy : video === null ? linearSyncCopy.pickVideo : linearSyncCopy.repickVideo}
            </button>
            <input ref={imageInputRef} type="file" accept="image/*" className="sync-file" onChange={onPickImage} />
            <button type="button" className="btn sync-mini" onClick={() => imageInputRef.current?.click()}>
              {linearSyncCopy.pickImage}
            </button>
            <label className="sync-label" title={linearSyncCopy.bgColorHint}>
              {linearSyncCopy.bgColor}
              <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} aria-label={linearSyncCopy.bgColor} />
            </label>
            {video !== null && (
              <span className="sync-dim">
                {linearSyncCopy.videoLoaded(video.info.name, video.info.hasAudio)}
              </span>
            )}
            <span className="sync-grow" />
            <button type="button" className="btn sync-mini" onClick={() => (playing ? stopPlayback() : startPlayback(playheadRef.current))}>
              {playing ? linearSyncCopy.pause : linearSyncCopy.play}
            </button>
            <button type="button" className="btn sync-mini" onClick={tap} title={linearSyncCopy.tapHint}>
              {linearSyncCopy.tap}
            </button>
            <span className="sync-meta" ref={posRef} data-role="linear-pos">
              {audioClockOf(playheadRef.current)}
            </span>
          </div>

          <canvas
            ref={waveRef}
            className="linear-wave"
            data-role="linear-wave"
            style={{ height: WAVE_H + RULER_H }}
            onPointerDown={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const x = Math.min(Math.max(0, e.clientX - rect.left), Math.max(1, rect.width))
              seekTo((x / Math.max(1, rect.width)) * clock.totalMs)
            }}
            onPointerMove={(e) => {
              if (e.buttons !== 1) return
              const rect = e.currentTarget.getBoundingClientRect()
              const x = Math.min(Math.max(0, e.clientX - rect.left), Math.max(1, rect.width))
              seekTo((x / Math.max(1, rect.width)) * clock.totalMs)
            }}
            title={linearSyncCopy.waveHint}
          />

          <div className="sync-row">
            <span className="sync-label">{linearSyncCopy.audioLabel}</span>
            <input ref={audioInputRef} type="file" accept="audio/*" className="sync-file" onChange={onPickAudio} />
            <button type="button" className="btn sync-mini" onClick={() => void onPickAudioNative()}>
              {audio !== null ? linearSyncCopy.repickAudio : linearSyncCopy.pickAudio}
            </button>
            {audio !== null && <span className="sync-dim">{linearSyncCopy.accompLoaded}</span>}
            {audio === null && videoAudio !== null && <span className="sync-dim">{linearSyncCopy.videoSound}</span>}
            {audio === null && videoAudio === null && <span className="sync-warn">{linearSyncCopy.noSound}</span>}
            <span className="sync-grow" />
            <span className="sync-label">{linearSyncCopy.rangeLabel}</span>
            <span className="sync-meta">
              {audioClockOf(range.startMs)} → {audioClockOf(range.endMs)}（{audioClockOf(range.durationMs)}）
            </span>
            <button type="button" className="btn sync-mini" onClick={() => setTrim({ startMs: playheadRef.current, endMs: Math.max(playheadRef.current + 34, range.endMs) })}>
              {syncCopy.trimStartNow}
            </button>
            <button type="button" className="btn sync-mini" onClick={() => setTrim({ startMs: Math.min(range.startMs, playheadRef.current), endMs: playheadRef.current })}>
              {syncCopy.trimEndNow}
            </button>
            <button type="button" className="btn sync-mini" onClick={() => setTrim({ startMs: 0, endMs: clock.totalMs })}>
              {syncCopy.trimAll}
            </button>
            <button type="button" className="btn sync-mini" onClick={() => nudgeTrim('start', -10)} title={linearSyncCopy.nudgeHint}>
              ◀10ms
            </button>
            <button type="button" className="btn sync-mini" onClick={() => nudgeTrim('start', 10)} title={linearSyncCopy.nudgeHint}>
              10ms▶
            </button>
          </div>

          <div className="sync-row">
            <span className="sync-label">{linearSyncCopy.markLabel}</span>
            <select
              className="sync-select"
              value={selectedMark}
              aria-label={linearSyncCopy.markLabel}
              onChange={(e) => onPickMark(e.target.value)}
            >
              <option value="">{linearSyncCopy.markAll}</option>
              {practiceMarks.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span className="sync-dim">{linearSyncCopy.markHint}</span>
            <span className="sync-grow" />
            <button
              type="button"
              className="btn sync-mini"
              onClick={() => (exporting ? abortRef.current?.abort() : void onExport())}
              disabled={!exporting && (range.durationMs <= 0 || !sessionReady)}
            >
              {exporting ? linearSyncCopy.cancelExport : linearSyncCopy.export}
            </button>
            {exporting && (
              <span className="sync-meta" data-role="linear-progress">
                {Math.round(progress * 100)}%
              </span>
            )}
          </div>

          <div className="sync-row">
            <span className="sync-label">{syncCopy.mixSource}</span>
            <select
              className="sync-select"
              value={mix.source}
              aria-label={syncCopy.mixSource}
              onChange={(e) => setMix({ source: e.target.value as 'file' | 'synth' | 'mix' })}
            >
              {MIX_SOURCES.map((s) => (
                <option key={s} value={s} disabled={s !== 'file' && videoAudio === null && audio === null}>
                  {s === 'file' ? syncCopy.mixFile : s === 'mix' ? syncCopy.mixBoth : syncCopy.mixSynth}
                </option>
              ))}
            </select>
            {synthState === 'loading' && <span className="sync-dim">{syncCopy.synthLoading}</span>}
            {synthState === 'error' && <span className="sync-warn">{syncCopy.synthFailed}</span>}
            <span className="sync-label">{linearSyncCopy.videoGain}</span>
            <input
              className="sync-mix-range"
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={mix.video ?? 1}
              aria-label={linearSyncCopy.videoGain}
              onChange={(e) => setMix({ video: Number(e.target.value) })}
            />
            <span className="sync-label">{syncCopy.accompGain}</span>
            <input
              className="sync-mix-range"
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={mix.accomp}
              aria-label={syncCopy.accompGain}
              onChange={(e) => setMix({ accomp: Number(e.target.value) })}
            />
            <span className="sync-label">{syncCopy.synthGain}</span>
            <input
              className="sync-mix-range"
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={mix.synth}
              aria-label={syncCopy.synthGain}
              onChange={(e) => setMix({ synth: Number(e.target.value) })}
            />
            <span className="sync-dim">{linearSyncCopy.mixRule}</span>
          </div>

          <div className="sync-row">
            <span className="sync-label">{linearSyncCopy.theme}</span>
            <select
              className="sync-select"
              value={themeId}
              aria-label={linearSyncCopy.theme}
              onChange={(e) => setExtras({ linear: { ...linearStyle, theme: e.target.value } })}
            >
              {STRIP_THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="sync-label">{linearSyncCopy.bandTop}</span>
            <input
              className="sync-mix-range"
              type="range"
              min={0}
              max={0.6}
              step={0.01}
              value={topRatio}
              aria-label={linearSyncCopy.bandTop}
              onChange={(e) => setExtras({ linear: { ...linearStyle, topRatio: Number(e.target.value) } })}
            />
            <span className="sync-label">{linearSyncCopy.bandScale}</span>
            <input
              className="sync-mix-range"
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={bandScale}
              aria-label={linearSyncCopy.bandScale}
              onChange={(e) => setExtras({ linear: { ...linearStyle, bandScale: Number(e.target.value) } })}
            />
            <span className="sync-grow" />
            <span className="sync-label">{syncCopy.bpm}</span>
            <span className="sync-meta">♩={fit !== null ? Math.round(60000 / fit.beatMs) : '—'}（{Math.round(scoreBpm)}）</span>
            <span className="sync-label">{syncCopy.offset}</span>
            <span className="sync-meta">{fit !== null ? `${(fit.offsetMs / 1000).toFixed(3)}s` : '—'}</span>
            <span className="sync-label">{syncCopy.anchors}</span>
            <span className="sync-meta">{doc?.anchors.length ?? 0}</span>
          </div>

          {(pending !== null || (doc?.anchors.length ?? 0) > 0) && (
            <div className="sync-row sync-row-tight">
              {pending !== null && (
                <>
                  <span className="sync-label">{syncCopy.tapTitle}</span>
                  <input className="sync-num" type="number" min={1} value={bar} onChange={(e) => setBar(Number(e.target.value))} aria-label={syncCopy.barLabel} />
                  <span className="sync-dim">:</span>
                  <input className="sync-num" type="number" min={1} value={beat} onChange={(e) => setBeat(Number(e.target.value))} aria-label={syncCopy.beatLabel} />
                  <button type="button" className="btn sync-mini" onClick={confirmTap}>
                    {syncCopy.tapConfirm}
                  </button>
                  <button type="button" className="btn sync-mini" onClick={() => setPending(null)}>
                    {syncCopy.tapCancel}
                  </button>
                </>
              )}
              {(doc?.anchors ?? []).map((a, i) => (
                <span key={`${a.beat}-${i}`} className="sync-anchor">
                  <span className="sync-anchor-pos">{barBeatLabel(a.beat)}</span>
                  <span className="sync-dim">{audioClockOf(a.audioMs)}</span>
                  <button type="button" className="btn sync-mini" onClick={() => removeAnchor(i)}>
                    {syncCopy.remove}
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
