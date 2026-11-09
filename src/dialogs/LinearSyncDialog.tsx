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
import {
  stripStyleOf,
  stripBaseStyleOf,
  stripStyleOverrideOf,
  colorSwatchOf,
  STRIP_THEMES,
  STRIP_THEME_AUTO,
  type StripStyle,
} from '../export/video/stripTheme'
import { createLinearSession, type LinearSession } from '../export/video/linearSession'
import { stripCfgOf } from '../export/video/stripFrame'
import { CARD_TEMPLATES, resolveCardStyle } from '../export/video/cardTemplates'
import { recordCardTemplate } from '../store/syncExtras'
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
  linearAudioPadOf,
  linearCardTimelineOf,
  linearCardsOf,
  linearClockOf,
  linearExportWindowOf,
  LINEAR_INTRO_FADE_MS,
  linearMixPlanOf,
  mediaMsAt,
  mediaMsOfSession,
  scoreMsAt,
  sessionMsOfMedia,
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
  /** adj1265：卡片模板库（与相机位共用一份；片头片尾卡跟着这套样式走） */
  const cardTemplates = useUiStore((s) => s.cardTemplates)
  const dynamicCardStyle = useUiStore((s) => s.dynamicCardStyle)

  const available = canUseDynamicVideo()

  // ---------- 谱面 → 条带 ----------
  const scoreBpm = useMemo(() => inferBpm(parseResult), [parseResult])
  const scoreBeatMs = 60000 / scoreBpm
  const scoreSeq = useMemo(() => {
    const lay = layoutScore(parseResult, pageConfig)
    return buildPlaySequence(parseResult, lay, scoreBpm)
  }, [parseResult, pageConfig, scoreBpm])
  /**
   * 条带的排版配置：字号固定（出片分辨率与字号无关，字号只影响"一屏几拍"）。
   * adj1270：歌词字号跟着一起放大（只抬 `note_size` 会让歌词按原值画，真图里糊成小点）。
   */
  const stripCfg = useMemo<PageConfig>(() => stripCfgOf(pageConfig, STRIP_NOTE_SIZE), [pageConfig])
  /** adj1265：排版结果留着算片头卡的文字（标题/作者/调号/拍速） */
  const scoreLayout = useMemo(() => layoutScore(parseResult, stripCfg), [parseResult, stripCfg])
  /**
   * adj1267：谱带画不画歌词（缺字段 = 画；只记"关掉"这一笔）。
   * 直接读 `doc.linear` 而不是等到下面那份 `linearStyle`——谱带在这之前就要建好。
   */
  const showLyrics = doc?.linear?.lyrics !== false
  /** adj1268：小节号（默认不画；勾上时画在小节线正上方） */
  const showBarNumbers = doc?.linear?.barNumbers === true
  const strip: LinearStrip = useMemo(() => {
    return buildLinearStrip(scoreLayout, scoreSeq, stripCfg, {
      pxPerBeat: Math.round(STRIP_NOTE_SIZE * 1.6),
      lyrics: showLyrics,
      barNumbers: showBarNumbers,
    })
  }, [scoreLayout, stripCfg, scoreSeq, showLyrics, showBarNumbers])
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
  const linearStyle = useMemo(() => doc?.linear ?? {}, [doc?.linear])
  /** adj1266：缺字段 = `auto`（跟随卡片模板），旧 sidecar 天然兼容 */
  const themeId = linearStyle.theme ?? STRIP_THEME_AUTO
  const topRatio = linearStyle.topRatio ?? 0.25
  const blockRatio = linearStyle.blockRatio ?? 1 / 3
  const bandScale = linearStyle.bandScale ?? 1
  /** 卡片样式与相机位共用模板库（sidecar 记的模板优先，没有就用当前选中的） */
  const effectiveCardStyle = useMemo(
    () => resolveCardStyle(doc?.card?.template ?? dynamicCardStyle, cardTemplates),
    [cardTemplates, doc?.card?.template, dynamicCardStyle],
  )
  /**
   * adj1266（用户 2026-11-09 拍板「配色随卡片模板」）：默认 `auto` ⇒ 谱带配色由卡片模板推出来；
   * 明确选了四套预设才不跟卡片。**这是唯一入口**（预览/出片/编辑器/断言都读它）。
   */
  const styleOverride = linearStyle.style
  const linearStripStyle = useMemo(
    () => stripStyleOf(themeId, styleOverride, effectiveCardStyle),
    [effectiveCardStyle, styleOverride, themeId],
  )
  /** 编辑器的"恢复预设"要能拿到当前基准（auto 时是卡片模板算出来的那份） */
  const presetStyle = useMemo(() => stripBaseStyleOf(themeId, effectiveCardStyle), [effectiveCardStyle, themeId])
  /** 片头/片尾卡（跟着这首歌走：存 sidecar 的 `linear.cards`） */
  const cardsOn = linearStyle.cards === true
  const cards = useMemo(() => linearCardsOf(cardsOn), [cardsOn])
  const cardTimeline = useMemo(() => linearCardTimelineOf(range, cards), [cards, range])
  /** 会话总长（带卡片 = 片头 + 导出段 + 片尾；不带 = 媒体总长） */
  const sessionTotalMs = cardsOn ? cardTimeline.totalMs : clock.totalMs
  /**
   * adj1266：**出片窗口**——不带卡片时只编保留段（画面从 `range.startMs` 起画）。
   * 预览仍用整条 `sessionTotalMs`（播放头要能在整首歌里拖），两者不是一回事。
   */
  const exportWindow = useMemo(
    () => linearExportWindowOf({ range, cardsOn, cardTotalMs: cardTimeline.totalMs }),
    [cardsOn, cardTimeline.totalMs, range],
  )
  /** 片头卡上的文字（第 1 页描述头） */
  const cardMeta = scoreLayout.pages[0]?.meta ?? null
  const cardBpm = fit !== null ? 60000 / fit.beatMs : scoreBpm

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

  // ---------- 会话（一帧合成：背景 → 谱带 → 色块 → 球；带卡片时两端各加一段） ----------
  const sessionRef = useRef<LinearSession | null>(null)
  const stageRef = useRef<HTMLCanvasElement | null>(null)
  const waveRef = useRef<HTMLCanvasElement | null>(null)
  const [sessionReady, setSessionReady] = useState(false)

  useEffect(() => {
    let alive = true
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
      style: linearStripStyle,
      background,
      lay: { topRatio, blockRatio },
      bandScale,
      mediaTotalMs: clock.totalMs,
      ...(cardsOn
        ? {
            cards: {
              cards,
              range: { startMs: range.startMs, endMs: range.endMs },
              cardStyle: effectiveCardStyle,
              meta: cardMeta,
              bpm: cardBpm,
              shortCode: '',
            },
          }
        : {}),
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
  }, [bgColor, bgImage, bandScale, blockRatio, cardBpm, cardMeta, cards, cardsOn, clock.totalMs, effectiveCardStyle, linearStripStyle, out.height, out.width, range.endMs, range.startMs, strip, stripCfg, topRatio, video])

  // ---------- 绘制 ----------
  /**
   * adj1265：**会话时刻 ⇄ 媒体时刻**。
   *
   * 带卡片时会话时间轴是 `[片头][导出段][片尾]`；不带卡片时两者恒等（adj1264 行为不变）。
   * 播放头一律存**会话时刻**（屏幕上看到的是哪一帧，就按它算），波形/打点/保留段仍用媒体时刻。
   */
  const mediaOfSession = useCallback(
    (tMs: number): number => (cardsOn ? mediaMsOfSession(cardTimeline, tMs) : tMs),
    [cardTimeline, cardsOn],
  )
  const sessionOfMedia = useCallback(
    (mediaMs: number): number => (cardsOn ? sessionMsOfMedia(cardTimeline, mediaMs) : mediaMs),
    [cardTimeline, cardsOn],
  )
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
    // ⑤ 播放头（媒体时间轴；会话时刻要换算，带卡片时播放头会先停在片头那一段）
    const px = xOf(Math.max(0, Math.min(total, mediaOfSession(playheadRef.current))))
    ctx.strokeStyle = 'var(--jp-danger, #ff5d6c)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, WAVE_H)
    ctx.stroke()
    ctx.lineWidth = 1
  }, [clock.totalMs, doc?.anchors, mediaOfSession, peaks, range.endMs, range.startMs])

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
          // 视频帧按**媒体时刻**解（片头/片尾段停在两端的定格帧）
          await videoRef.current?.warm(mediaOfSession(tMs))
          await sessionRef.current?.warm(tMs)
          paintStage(tMs)
          paintWave()
        } finally {
          drawingRef.current = false
        }
      })()
    },
    [mediaOfSession, paintStage, paintWave],
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
      const from = Math.max(0, Math.min(fromMs, sessionTotalMs))
      /** 片头卡里还没走完的那一段：音频要晚这么久才响（等价于相机位的 leadIn 静音） */
      const introLeadMs = cardsOn ? Math.max(0, cardTimeline.introMs - from) : 0
      const fromMedia = mediaOfSession(from)
      const at = ctx.currentTime
      const windows = playbackWindowsOf(usable, fromMedia)
      const beatMs = fit?.beatMs ?? scoreBeatMs
      /** 收尾淡出在**会话时间轴**上的两刻（= 保留段末一拍 → 保留段末） */
      const fadeStartSession = sessionOfMedia(Math.max(range.startMs, range.endMs - beatMs))
      const endSession = sessionOfMedia(range.endMs)
      for (let i = 0; i < usable.length; i++) {
        const t = usable[i]
        const w = windows[i]
        const src = ctx.createBufferSource()
        src.buffer = t.buffer
        src.playbackRate.value = t.rate !== undefined && t.rate > 0 ? t.rate : 1
        const gain = ctx.createGain()
        gain.gain.value = t.gain
        // 收尾淡出（与出片音轨同一口径：最后一拍线性到 0）
        if (endSession - fadeStartSession > 20) {
          gain.gain.setValueAtTime(t.gain, at + Math.max(0, (fadeStartSession - from) / 1000))
          gain.gain.linearRampToValueAtTime(0, at + Math.max(0, (endSession - from) / 1000))
        }
        src.connect(gain)
        gain.connect(ctx.destination)
        src.start(at + (introLeadMs + w.whenSec * 1000) / 1000, w.skipSec)
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
        // 播到**会话末尾**（含片尾卡）：卡要放完，不能到音乐结束就停
        if (t >= sessionTotalMs) {
          stopPlayback()
          paintAt(sessionTotalMs)
          return
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [cardsOn, cardTimeline.introMs, currentMs, ensureCtx, fit?.beatMs, mediaOfSession, paintAt, plan.silent, range.endMs, range.startMs, scoreBeatMs, sessionOfMedia, sessionTotalMs, stopPlayback, tracks],
  )

  const seekTo = useCallback(
    (mediaMs: number) => {
      stopPlayback()
      paintAt(Math.max(0, Math.min(sessionTotalMs, sessionOfMedia(mediaMs))))
      if (posRef.current !== null) posRef.current.textContent = audioClockOf(playheadRef.current)
    },
    [paintAt, sessionOfMedia, sessionTotalMs, stopPlayback],
  )

  /** 保留段 / 卡片一改，总长可能变短：把播放头夹回去，别停在一条不存在的时间轴上 */
  useEffect(() => {
    const t = Math.max(0, Math.min(sessionTotalMs, playheadRef.current))
    if (t !== playheadRef.current) {
      playheadRef.current = t
      paintAt(t)
    }
  }, [paintAt, sessionTotalMs])

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

  // ---------- 主题编辑器（adj1265） ----------
  const [styleOpen, setStyleOpen] = useState(false)
  const [styleDraft, setStyleDraft] = useState<Record<string, string>>({})

  /**
   * 写一笔自定义配色：先把"实际样式"合并出来，再只把**与预设不同**的项写进 sidecar。
   * 这样用户在编辑器里改回预设值时，那一项会自动消失（不会留下"看起来改过、其实一样"的脏项）。
   */
  const writeStyle = useCallback(
    (patch: Partial<StripStyle>) => {
      const next: StripStyle = { ...linearStripStyle, ...patch }
      setExtras({ linear: { ...linearStyle, style: stripStyleOverrideOf(next, presetStyle) } })
    },
    [linearStripStyle, linearStyle, presetStyle, setExtras],
  )
  /** 文字输入框：敲的时候用本地草稿，失焦/回车才落盘（否则输入 `#ff` 会被钳制回旧值，光标跳） */
  const commitStyleText = useCallback(
    (key: keyof StripStyle) => {
      const raw = styleDraft[key]
      if (raw === undefined) return
      const next = { ...styleDraft }
      delete next[key]
      setStyleDraft(next)
      writeStyle({ [key]: raw } as Partial<StripStyle>)
    },
    [styleDraft, writeStyle],
  )

  /**
   * adj1266：选配色主题。`auto` = 跟随卡片模板 ⇒ 不写 `theme` 字段（缺字段就是 auto，
   * 这样旧 sidecar 天然是"跟卡片走"，也不必为一个"默认值"往每份文件里写字符串）。
   */
  const setThemeChoice = useCallback(
    (v: string) => {
      if (v === STRIP_THEME_AUTO) {
        const next = { ...linearStyle }
        delete next.theme
        setExtras({ linear: next })
        return
      }
      setExtras({ linear: { ...linearStyle, theme: v } })
    },
    [linearStyle, setExtras],
  )

  /**
   * adj1267：歌词开关。**只记"关掉"这一笔**（缺字段 = 画）——与 `theme` 缺省即 `auto` 同一个口径：
   * 旧 sidecar 天然兼容，也不为一个默认值往每份文件里写 `true`。
   */
  const setLyricsOn = useCallback(
    (on: boolean) => {
      const next = { ...linearStyle }
      if (on) delete next.lyrics
      else next.lyrics = false
      setExtras({ linear: next })
    },
    [linearStyle, setExtras],
  )

  /** adj1268：小节号开关。默认**不画**，所以只记"打开"这一笔（缺字段 = 不画） */
  const setBarNumbersOn = useCallback(
    (on: boolean) => {
      const next = { ...linearStyle }
      if (on) next.barNumbers = true
      else delete next.barNumbers
      setExtras({ linear: next })
    },
    [linearStyle, setExtras],
  )

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
    const sessionMs = currentMs()
    const ms = mediaOfSession(sessionMs)
    stopPlayback()
    playheadRef.current = Math.max(0, Math.min(sessionMs, sessionTotalMs))
    paintAt(playheadRef.current)
    setPending({ mediaMs: Math.round(ms) })
    // 默认谱位：当前位置对应的拍（取整，避免造出"第 1.33 拍"的半拍锚点）
    const scoreMs = scoreMsAt(clock, ms)
    const beats = scoreMs / scoreBeatMs
    const label = barBeatLabel(beats)
    const [b, k] = label.split(':').map(Number)
    if (Number.isFinite(b)) setBar(b)
    if (Number.isFinite(k)) setBeat(Math.max(1, Math.round(k)))
  }, [barBeatLabel, clock, currentMs, mediaOfSession, paintAt, scoreBeatMs, sessionTotalMs, stopPlayback])

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
    /**
     * 会话是异步建的（谱带光栅 / 卡片图解码）。按钮虽然会禁用，但"刚好在重建"
     * 那一瞬点下去会**静默什么都不发生**（用户只会觉得点了没反应）——
     * 所以这里等一小会儿；等不到就明说，别假装成功。
     */
    let s = sessionRef.current
    for (let i = 0; s === null && i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100))
      s = sessionRef.current
    }
    if (s === null) {
      setNotice(linearSyncCopy.notReady)
      return
    }
    if (exporting) return
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
      /**
       * adj1265：带卡片时音轨两端各补一段静音（片头/片尾），
       * 画面总长也变成"片头 + 导出段 + 片尾"——不补的话播放器会把视频时长算短。
       */
      const pad = cardsOn ? linearAudioPadOf(cardTimeline) : { headMs: 0, tailMs: 0 }
      const mixed = await mixLinearAudio(tracks, range, pad)
      /**
       * adj1266：出片只编**窗口**（不带卡片 = 保留段），画面由媒体时刻 `t + 偏移` 画出来。
       *
       * 原来这里给的是 `sessionTotalMs`（整首）：保留段只裁了音轨，画面还是整首歌——
       * 真机素材上表现为"导 2 秒却要编 3:56"。`E-2026-566`。
       */
      const off = exportWindow.mediaOffsetMs
      const outSession = {
        width: out.width,
        height: out.height,
        totalMs: exportWindow.totalMs,
        draw: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, t: number): void => {
          s.draw(ctx, t + off)
        },
        warm: async (t: number): Promise<void> => {
          await videoRef.current?.warm(s.mediaMsOf(t + off))
          await s.warm(t + off)
        },
      }
      const blob = await encodeLinearMp4(outSession, {
        fps: FPS,
        audio: mixed,
        // 带片头卡时封面取"卡片最完整"的那一刻（淡出开始前；与相机位同一个口径）
        coverMs:
          cardsOn && cardTimeline.introMs > 0
            ? Math.max(0, cardTimeline.introMs - LINEAR_INTRO_FADE_MS)
            : 0,
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
      /**
       * adj1265：**挂到 DOM 再点**。原来是不挂 DOM 直接 `a.click()`（浏览器多数情况也认），
       * 但无头 Chrome 下实测"第二次同名下载"会被静默丢掉；挂上 DOM 是各处都稳的写法。
       */
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      showNotice(linearSyncCopy.exportedWeb, 'ok')
    } catch (e) {
      if (ac.signal.aborted) showNotice(linearSyncCopy.exportCanceled, 'warn')
      else setNotice(linearSyncCopy.exportFailed(e instanceof Error ? e.message : String(e)))
    } finally {
      abortRef.current = null
      setExporting(false)
    }
  }, [cardTimeline, cardsOn, exportWindow, exporting, fileName, out.height, out.width, range, showNotice, tracks])

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
              <span className="sync-meta" data-role="linear-total">
                {audioClockOf(playheadRef.current)} / {audioClockOf(sessionTotalMs)}
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
            <button type="button" className="btn sync-mini" onClick={() => setTrim({ startMs: mediaOfSession(playheadRef.current), endMs: Math.max(mediaOfSession(playheadRef.current) + 34, range.endMs) })}>
              {syncCopy.trimStartNow}
            </button>
            <button type="button" className="btn sync-mini" onClick={() => setTrim({ startMs: Math.min(range.startMs, mediaOfSession(playheadRef.current)), endMs: mediaOfSession(playheadRef.current) })}>
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
              data-role="linear-theme"
              value={themeId}
              aria-label={linearSyncCopy.theme}
              title={linearSyncCopy.themeHint}
              onChange={(e) => setThemeChoice(e.target.value)}
            >
              <option value={STRIP_THEME_AUTO}>{linearSyncCopy.themeAuto(effectiveCardStyle.name)}</option>
              {STRIP_THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn sync-mini"
              data-role="linear-style-toggle"
              aria-expanded={styleOpen}
              onClick={() => setStyleOpen((v) => !v)}
              title={linearSyncCopy.styleHint}
            >
              {styleOpen ? linearSyncCopy.styleHide : linearSyncCopy.styleEdit}
            </button>
            <button
              type="button"
              className="btn sync-mini"
              disabled={styleOverride === undefined || Object.keys(styleOverride).length === 0}
              onClick={() => setExtras({ linear: { ...linearStyle, style: {} } })}
              title={linearSyncCopy.styleHint}
            >
              {linearSyncCopy.styleReset}
            </button>
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
            <label className="sync-label" title={linearSyncCopy.lyricsHint}>
              <input
                type="checkbox"
                checked={showLyrics}
                data-role="linear-lyrics"
                aria-label={linearSyncCopy.lyrics}
                onChange={(e) => setLyricsOn(e.target.checked)}
              />
              {linearSyncCopy.lyrics}
            </label>
            {showLyrics && strip.lyricLines > 1 && (
              <span className="sync-dim" data-role="linear-lyrics-multi">
                {linearSyncCopy.lyricsMulti(strip.lyricLines)}
              </span>
            )}
            <label className="sync-label" title={linearSyncCopy.barNumbersHint}>
              <input
                type="checkbox"
                checked={showBarNumbers}
                data-role="linear-barnumbers"
                aria-label={linearSyncCopy.barNumbers}
                onChange={(e) => setBarNumbersOn(e.target.checked)}
              />
              {linearSyncCopy.barNumbers}
            </label>
            <span className="sync-grow" />
            <label className="sync-label" title={linearSyncCopy.cardsHint}>
              <input
                type="checkbox"
                checked={cardsOn}
                data-role="linear-cards"
                aria-label={linearSyncCopy.cards}
                onChange={(e) => setExtras({ linear: { ...linearStyle, cards: e.target.checked } })}
              />
              {linearSyncCopy.cards}
            </label>
            {cardsOn && (
              <>
                <span className="sync-label">{linearSyncCopy.cardTemplate}</span>
                <select
                  className="sync-select"
                  value={effectiveCardStyle.id}
                  aria-label={linearSyncCopy.cardTemplate}
                  onChange={(e) => recordCardTemplate(e.target.value)}
                >
                  {[...CARD_TEMPLATES, ...cardTemplates].map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <span className="sync-dim">
                  {linearSyncCopy.cardsOnHint(
                    `${(cardTimeline.introMs / 1000).toFixed(1)}s`,
                    `${(cardTimeline.endMs / 1000).toFixed(1)}s`,
                    out.width,
                    out.height,
                  )}
                </span>
              </>
            )}
          </div>

          {styleOpen && (
            <div className="sync-row linear-style-row" data-role="linear-style">
              <StyleColorField
                label={linearSyncCopy.styleInk}
                value={linearStripStyle.ink}
                text={styleDraft.ink}
                onText={(v) => setStyleDraft((d) => ({ ...d, ink: v }))}
                onCommit={() => commitStyleText('ink')}
                onPick={(v) => writeStyle({ ink: v })}
              />
              <StyleColorField
                label={linearSyncCopy.styleHalo}
                value={linearStripStyle.halo}
                text={styleDraft.halo}
                onText={(v) => setStyleDraft((d) => ({ ...d, halo: v }))}
                onCommit={() => commitStyleText('halo')}
                onPick={(v) => writeStyle({ halo: v })}
              />
              <StyleColorField
                label={linearSyncCopy.styleShadow}
                value={linearStripStyle.shadow}
                text={styleDraft.shadow}
                onText={(v) => setStyleDraft((d) => ({ ...d, shadow: v }))}
                onCommit={() => commitStyleText('shadow')}
                onPick={(v) => writeStyle({ shadow: v })}
              />
              <StyleColorField
                label={linearSyncCopy.styleBlock}
                value={linearStripStyle.blockColor}
                text={styleDraft.blockColor}
                onText={(v) => setStyleDraft((d) => ({ ...d, blockColor: v }))}
                onCommit={() => commitStyleText('blockColor')}
                onPick={(v) => writeStyle({ blockColor: v })}
              />
              <StyleColorField
                label={linearSyncCopy.styleBall}
                value={linearStripStyle.ballColor}
                text={styleDraft.ballColor}
                onText={(v) => setStyleDraft((d) => ({ ...d, ballColor: v }))}
                onCommit={() => commitStyleText('ballColor')}
                onPick={(v) => writeStyle({ ballColor: v })}
              />
              <label className="sync-label" title={linearSyncCopy.styleHaloWidth}>
                {linearSyncCopy.styleHaloWidth}
                <input
                  className="sync-mix-range"
                  type="range"
                  min={0}
                  max={12}
                  step={0.5}
                  value={linearStripStyle.haloWidth}
                  aria-label={linearSyncCopy.styleHaloWidth}
                  onChange={(e) => writeStyle({ haloWidth: Number(e.target.value) })}
                />
                <span className="sync-meta">{linearStripStyle.haloWidth}</span>
              </label>
              <label className="sync-label" title={linearSyncCopy.styleShadowBlur}>
                {linearSyncCopy.styleShadowBlur}
                <input
                  className="sync-mix-range"
                  type="range"
                  min={0}
                  max={24}
                  step={1}
                  value={linearStripStyle.shadowBlur}
                  aria-label={linearSyncCopy.styleShadowBlur}
                  onChange={(e) => writeStyle({ shadowBlur: Number(e.target.value) })}
                />
                <span className="sync-meta">{linearStripStyle.shadowBlur}</span>
              </label>
              <label className="sync-label" title={linearSyncCopy.styleBlockAlpha}>
                {linearSyncCopy.styleBlockAlpha}
                <input
                  className="sync-mix-range"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={linearStripStyle.blockAlpha}
                  aria-label={linearSyncCopy.styleBlockAlpha}
                  onChange={(e) => writeStyle({ blockAlpha: Number(e.target.value) })}
                />
                <span className="sync-meta">{Math.round(linearStripStyle.blockAlpha * 100)}%</span>
              </label>
              <span className="sync-dim linear-style-hint">{linearSyncCopy.styleHint}</span>
            </div>
          )}

          <div className="sync-row">
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

/**
 * adj1265：主题编辑器里的一格颜色。
 *
 * 为什么是两个输入框：原生取色器只认 `#rrggbb`（半透明色要走 `colorSwatchOf` 换算，
 * 否则一碰就变成纯黑），而 `rgba(0,0,0,0.85)` 这类色串得能原样手改、也得能看见当前值。
 * 文本框用"敲的时候存草稿、失焦/回车才落盘"，否则输入 `#ff` 会被钳制回旧值、光标乱跳。
 */
function StyleColorField(props: {
  label: string
  /** 实际生效的色串（编辑器显示用） */
  value: string
  /** 本地草稿（没在编辑时是 undefined） */
  text: string | undefined
  onText: (v: string) => void
  onCommit: () => void
  onPick: (v: string) => void
}): React.JSX.Element {
  return (
    <label className="sync-label linear-style-cell" title={props.label}>
      {props.label}
      <input
        type="color"
        value={colorSwatchOf(props.value)}
        onChange={(e) => props.onPick(e.target.value)}
        aria-label={`${props.label}（取色）`}
      />
      <input
        className="sync-text linear-style-text"
        value={props.text ?? props.value}
        onChange={(e) => props.onText(e.target.value)}
        onBlur={props.onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onCommit()
        }}
        aria-label={props.label}
      />
    </label>
  )
}
