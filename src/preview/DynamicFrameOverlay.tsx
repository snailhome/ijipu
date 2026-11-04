/**
 * preview/DynamicFrameOverlay.tsx — 预览区的**动态谱相机位**（adj1065，合并 adj1033 + adj1031）
 *
 * 用户口径：
 *  - 取消独立的「动态视频预览」弹窗；导出菜单的「动态谱视频」和试听里的「导出标记段」
 *    都只打开**预览区这块相机位**；
 *  - 框里是成片画面（同一份 `createDynamicSession`，与导出逐像素同源），
 *    后方静态预览压暗做背景；播放/进度/比例/时长/声音/生成视频都在**框外暗部**；
 *  - 片头先**静止 3 秒描述头**，再用 0.7 秒推近/平移到第一拍（第一拍在 3.7s）；
 *  - 预览播完整片尾（含品牌落版），与导出内容一致（adj1068）。
 *  - 片头/片尾卡片模板由“卡片”下拉框选择（adj1073），默认品牌深空蓝，样式可持久化。
 *
 * ## 为什么不直接变换后方预览的 DOM
 *
 * 动态相机的推近/换行/球在静态预览里不存在；拿静态预览做 CSS 变换等于把动态渲染
 * 再实现一遍，无法保证"框里看到的 = 导出的"。这里复用导出的那份会话画布，
 * 只做等比缩放——这才是"不重复造轮子"。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseJps, inferBpm, gmVoiceRef, type DynamicPresetId } from '@ijipu/engine'
import { playbackVoiceOptions } from '@ijipu/engine/playback/voiceOptions'
import { useDocStore } from '../store/docStore'
import { useUiStore, enabledVoicesOf, type DynamicAspect, type DynamicMode } from '../store/uiStore'
import { dynamicVideoCopy, syncCopy } from '../brand/copy'
import { createDynamicSession, type DynamicSession } from '../export/video/renderer'
import { CARD_TEMPLATES, resolveCardStyle, type CardStyle } from '../export/video/cardTemplates'
import { resolveCardImage } from '../store/cardImageStore'
import { canGenerateVideo, canUseDynamicVideo } from '../export/video/capability'
// adj1183：桌面壳导出走原生保存对话框，MP4 字节以 base64 过 IPC
import { bytesToBase64 } from '../export/zip'
import { EXPORT_MAX_MS, LEAD_IN_MS, exportDynamicVideo } from '../export/video/exportDynamic'
import { DynamicAudioPlayer } from '../export/video/audioPlayer'
import { renderToAudioBuffer } from '../export/audio'
import { createHqCache, resolveHqBank } from '../playback/spessaCache'
import { resolveActiveLibrary } from '../playback/spessaSynthBackend'
import { hostBankUrl } from '../store/hostBridge'
// adj1119：对拍（sidecar）——相机位按它重建会话、带上伴奏
import { useSyncStore } from '../store/syncStore'
import { buildAccompanimentTrack, decodeAccompaniment, mixAudioBuffers, preRollMsOf } from '../export/video/accompaniment'
import type { SyncMix } from '../export/video/syncDoc'
import { audioRefOf, effectiveSyncFitOf } from '../export/video/syncDoc'
import { pickAudioFileNative, readSidecarAudio } from '../export/video/syncIo'
import { isTauriShell, tauriInvoke } from '../brand/env'
// adj1150：相机位打开时自己找同目录的 sidecar（与对拍台共用路径规则）
import { loadSidecarAudioFor, loadSidecarFor } from '../store/syncSidecar'
// adj1155：sidecar 里的练习段/相机段也灌回 UI
import { applySyncExtrasToUi, recordCardTemplate } from '../store/syncExtras'

/**
 * adj1097（用户 2026-10-23 实报「卡片加了背景图片，但导出的视频没有背景图片」）：
 * 把自定义卡片样式里的**背景图引用**解析成能直接 `new Image().decode()` 的 data URL。
 *
 * 为什么要一个共用入口：预览与导出**都必须**先解析——大图在 `CardStyleDialog` 里存的是
 * `ijipu-blob:` 引用（`cardImageStore.saveCardImage`），渲染进程直接拿它当 `src` 加载不了，
 * `renderer.ts` 的 `decode()` 失败就退成"没有背景图"。上一版只有预览解析了，导出漏了。
 */
async function withResolvedCardImage(style: CardStyle): Promise<CardStyle> {
  return {
    ...style,
    backgroundImage: await resolveCardImage(style.backgroundImage),
    // adj1178：图片印章也是 `ijipu-blob:` 引用——预览/导出前同样解析成 data URL
    seal: style.seal
      ? { ...style.seal, image: await resolveCardImage(style.seal.image) }
      : style.seal,
  }
}

/** 文件名本身就是 3-6 位小写字母时，直接当短链默认值（如 `star.jps`） */
function guessShortOf(name: string | null | undefined): string {
  const base = (name ?? '').replace(/\.[^.]+$/, '').toLowerCase()
  return /^[a-z]{3,6}$/.test(base) ? base : ''
}

const ASPECTS: { id: DynamicAspect; label: string; ratio: number }[] = [  { id: '9x16', label: '9:16', ratio: 9 / 16 },
  { id: '1x1', label: '1:1', ratio: 1 },
  { id: '16x9', label: '16:9', ratio: 16 / 9 },
]
const MODES: { id: DynamicMode; label: string }[] = [
  { id: '3min', label: dynamicVideoCopy.mode3min },
  { id: 'full', label: dynamicVideoCopy.modeFull },
]

/** 单支视频上限 / 片头时长：**唯一来源**在 `export/video/exportDynamic.ts`（界面与命令行同口径） */

export function DynamicFrameOverlay() {
  const on = useUiStore((s) => s.dynamicCamera.on)
  const aspect = useUiStore((s) => s.dynamicCamera.aspect)
  const range = useUiStore((s) => s.dynamicCamera.range)
  const mode = useUiStore((s) => s.dynamicCamera.mode)
  /** adj1165：相机位也能直接选标记段（不再只靠试听入口把段带进来） */
  const practiceMarks = useUiStore((s) => s.practiceMarks)
  const setPracticeMarkId = useUiStore((s) => s.setPracticeMarkId)
  const selectedMarkId = useMemo(() => {
    if (range === null) return ''
    const hit = practiceMarks.find(
      (m) =>
        m.startId === range.startId &&
        m.endId === range.endId &&
        (m.pass ?? undefined) === (range.pass ?? undefined),
    )
    return hit?.id ?? ''
  }, [practiceMarks, range])
  /** adj1164：相机位音色下拉（L3 会话级，默认自动随谱） */
  const instrument = useUiStore((s) => s.dynamicCamera.instrument)
  const playbackHqEnabled = useUiStore(enabledVoicesOf)
  const ethnicVoicesEnabled = useUiStore((s) => s.ethnicVoicesEnabled)
  const instrumentOptions = useMemo(
    () => playbackVoiceOptions(playbackHqEnabled, ethnicVoicesEnabled),
    [playbackHqEnabled, ethnicVoicesEnabled],
  )
  const instrumentOverride = gmVoiceRef(instrument)
  const setDynamicCamera = useUiStore((s) => s.setDynamicCamera)
  // 用户可能在相机位开着时取消勾选某个音色：失效选择退回归自动，不留下一个空下拉
  useEffect(() => {
    if (instrument !== null && !instrumentOptions.some((v) => v.program === instrument)) {
      setDynamicCamera({ instrument: null })
    }
  }, [instrument, instrumentOptions, setDynamicCamera])
  const cardStyle = useUiStore((s) => s.dynamicCardStyle)
  const setDynamicCardStyle = useUiStore((s) => s.setDynamicCardStyle)
  /** adj1176：用户模板库（相机位下拉列出"我的模板"；换谱时按 sidecar 恢复） */
  const cardTemplates = useUiStore((s) => s.cardTemplates)
  /** adj1135：进对拍台时要把相机位的预览音**停下来**（用户实报"合成音停不住、两路声音叠在一起"） */
  const modal = useUiStore((s) => s.modal)
  /**
   * adj1089：平移方式虽然是**引擎读**的（`renderer.ts` 里取 `uiStore.getState().panMode`），
   * 但这里必须也订阅它并放进"重建会话"的依赖里 —— 否则用户在设置里换了平移方式，
   * 已经打开的相机位仍播着旧 `pans`（看起来就是"设置没生效"）。
   */
  const panMode = useUiStore((s) => s.panMode)
  /**
   * adj1094：行末提前平移量（L1，单位拍）——同样要订阅并进重建依赖，
   * 否则改了设置，已经打开的相机位不会按新提前量重建 `pans`。
   */
  const rowLeadBeats = useUiStore((s) => s.rowLeadBeats)
  const openModal = useUiStore((s) => s.openModal)
  /** adj1183：导出成功/取消的提示（toast 可带「打开文件 / 打开文件夹」两个按钮） */
  const showNotice = useUiStore((s) => s.showNotice)
  /**
   * adj1176：模板解析走「内置 → 用户模板库 → 默认」。
   * `useMemo` 很重要：每次渲染都新建对象会让下面的"重建会话"effect 每帧都跑。
   */
  const effectiveCardStyle = useMemo(() => resolveCardStyle(cardStyle, cardTemplates), [cardStyle, cardTemplates])
  /** 下拉里当前选中的值：模板被删/本机没有时显示默认项，而不是让 `<select>` 变成空白 */
  const cardStyleValue = effectiveCardStyle.id
  /**
   * adj1078：网站/插件整块不显示相机位（连预览也不并入）；桌面壳才显示。
   * adj1077：桌面壳里生成视频还要 WebCodecs；缺 WebCodecs 时只保留预览并禁用生成。
   */
  const dynamicVideoEnabled = canUseDynamicVideo()
  const videoExportEnabled = canGenerateVideo()
  const code = useDocStore((s) => s.code)
  const pageConfig = useDocStore((s) => s.pageConfig)
  /**
   * adj1119：对拍结果（sidecar）。`rev` = 对拍台的改动计数：
   * 它一变就作废音轨、重建会话（`bpm` 可能变了）。
   */
  const syncDoc = useSyncStore((s) => s.doc)
  const syncRev = useSyncStore((s) => s.rev)
  /**
   * adj1152（用户 2026-10-25 的锚点口径）：
   *  · **0 条锚点**：谱面按 `J:`（或默认拍速），伴奏与合成音都从头、默认对齐（偏移 0）；
   *  · **1 条锚点**：拍速仍取谱面 `J:`，这条只解偏移（引擎 `effectiveFitOf`）；
   *  · **2 条及以上**：由锚点解实际拍速（`doc.tempo`，最小二乘）。
   *
   * 所以相机位**不能**再要求 `doc.tempo !== null`（那等于要求 ≥2 条锚点）。
   */
  const scoreBeatMs = useMemo(() => 60000 / inferBpm(parseJps(code)), [code])
  const syncFit = useMemo(() => effectiveSyncFitOf(syncDoc, scoreBeatMs), [syncDoc, scoreBeatMs])
  const syncBpm = syncFit !== null ? 60000 / syncFit.beatMs : null
  /**
   * adj1148：**前奏等待**——伴奏比谱面长、谱面第 1 拍在音频 `offsetMs` 时，
   * 视频开头先把这段伴奏放出来、谱面定格第 1 拍。标记段（`range`）没有前奏，不等待。
   */
  const headWaitMs =
    range === null && syncDoc !== null && syncDoc.audio !== '' && syncFit !== null
      ? preRollMsOf(syncFit, syncDoc.trim)
      : 0
  /**
   * adj1150（用户 2026-10-25）：相机位要能**直接决定成片用哪条声音**（伴奏 / 伴奏+合成 / 合成音）
   * 与两条音量——和台面里那排是同一份 `syncDoc.mix`（存 sidecar），不是另造一套设置。
   */
  const syncAudio = useSyncStore((s) => s.audio)
  const setMix = useSyncStore((s) => s.setMix)
  const setExtras = useSyncStore((s) => s.setExtras)
  const setAudioBuffer = useSyncStore((s) => s.setAudioBuffer)
  const setAudio = useSyncStore((s) => s.setAudio)
  const replaceSyncDoc = useSyncStore((s) => s.replaceDoc)
  const nativePath = useDocStore((s) => s.nativePath)
  const binding = useDocStore((s) => s.binding)
  const [mixNotice, setMixNotice] = useState('')

  const [rect, setRect] = useState<DOMRect | null>(null)
  const [status, setStatus] = useState<'busy' | 'ready' | 'error'>('busy')
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [preparingAudio, setPreparingAudio] = useState(false)
  const [encoding, setEncoding] = useState(false)
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState('')
  const [withAudio, setWithAudio] = useState(true)
  /**
   * adj1113（用户 2026-10-23）：**带片头片尾**复选框 —— 不勾选就只导出动态谱。
   *
   * 为什么是"建会话"的开关而不是"导出"的开关：框里看到的必须就是导出的（adj1065 那条口径），
   * 所以关掉之后预览也从第一拍开始；与「带声音」一样是**本次会话**的选项（L3，关掉相机位即回默认）。
   */
  const [withCards, setWithCards] = useState(true)
  const fileName = useDocStore((s) => s.fileName)
  /**
   * adj1226：片尾短链代码。应用里没有保存站点 short（short 由乐谱库工具分配），
   * 所以这里按文件记住：导出过乐谱包会写入；没写过就默认文件名（若恰好是 3-6 位小写字母）。
   */
  const shortStorageKey = `ijipu.videoShort.${fileName || 'untitled'}`
  const [shortCode, setShortCode] = useState(() => {
    try {
      return localStorage.getItem(shortStorageKey) ?? guessShortOf(fileName)
    } catch {
      return guessShortOf(fileName)
    }
  })
  useEffect(() => {
    try {
      setShortCode(localStorage.getItem(shortStorageKey) ?? guessShortOf(fileName))
    } catch {
      setShortCode(guessShortOf(fileName))
    }
  }, [shortStorageKey, fileName])
  useEffect(() => {
    try {
      localStorage.setItem(shortStorageKey, shortCode)
    } catch {
      /* 存不下只影响下次默认值 */
    }
  }, [shortStorageKey, shortCode])
  /**
   * adj1185（用户实报「导出后还是没有提示」）：除了右上角 toast，在**相机位控制条里**也留一条
   * 导出结果（路径 + 打开文件/文件夹）。相机位浮层 z-index 60，toast 若被别的浮层盖住，
   * 这里的提示仍然看得见。
   */
  const [exportDone, setExportDone] = useState<{ path: string } | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const seekRef = useRef<HTMLInputElement | null>(null)
  const metaRef = useRef<HTMLSpanElement | null>(null)
  /** adj1150：sidecar 有伴奏文件名、但内存里还没有 AudioBuffer 时的"加载伴奏…"入口 */
  const mixFileRef = useRef<HTMLInputElement | null>(null)
  const sessionRef = useRef<DynamicSession | null>(null)
  const cursorRef = useRef(0)
  const lastTsRef = useRef(0)
  const rafRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const cacheRef = useRef<ReturnType<typeof createHqCache> | null>(null)

  const audioPlayerRef = useRef<DynamicAudioPlayer | null>(null)
  const audioBufferRef = useRef<AudioBuffer | null>(null)
  const audioLoadRef = useRef<Promise<AudioBuffer | null> | null>(null)
  const withAudioRef = useRef(withAudio)

  // 跟着预览区的位置走（窗口缩放、布局拆分都会变）
  useEffect(() => {
    if (!on) return
    const el = document.querySelector('.preview-pane')
    if (!el) return
    const update = () => setRect(el.getBoundingClientRect())
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [on])

  // 播放器：AudioContext 在第一次播放的点击栈里才创建
  useEffect(() => {
    const player = new DynamicAudioPlayer()
    audioPlayerRef.current = player
    return () => {
      player.destroy()
      audioPlayerRef.current = null
    }
  }, [])

  useEffect(() => {
    withAudioRef.current = withAudio
  }, [withAudio])

  /**
   * adj1150/adj1154（用户 2026-10-25：「已经有 xxx.jps.sync.json，相机位却没有声音选项」/
   * 「自动读伴奏，手动选太繁琐」）：
   * 打开相机位时**自己找同目录 sidecar**，并按 sidecar 记的文件名**自动读伴奏**（桌面壳）。
   *  · 只在内存里还没有对拍结果时读 sidecar；读不到就保持现状；
   *  · 伴奏不在内存里时自动读 + 解码；失败（网页/文件不在/扩展名不认）保留「加载伴奏…」。
   */
  useEffect(() => {
    if (!on) return
    let cancelled = false
    void (async () => {
      let d = useSyncStore.getState().doc
      if (d === null) {
        d = await loadSidecarFor(nativePath, binding)
        if (cancelled || d === null) return
        if (useSyncStore.getState().doc !== null) return
        replaceSyncDoc(d)
      }
      if (d !== null) applySyncExtrasToUi(d)
      if (d.audio === '' || useSyncStore.getState().audio !== null) return
      const bytes = await loadSidecarAudioFor(nativePath, binding, d)
      if (cancelled || bytes === null) return
      try {
        const buf = await decodeAccompaniment(bytes)
        if (cancelled) return
        useSyncStore.getState().setAudioBuffer(buf)
      } catch {
        // 自动加载失败不挡相机位：那一排会显示「加载伴奏…」
      }
    })()
    return () => {
      cancelled = true
    }
  }, [on, nativePath, binding, replaceSyncDoc])

  /** 画某一帧；进度条/读数走 ref，避免 60fps 重渲染整棵树 */
  const paint = useCallback((t: number) => {
    const s = sessionRef.current
    const c = canvasRef.current
    if (!s || !c) return
    if (c.width !== s.width || c.height !== s.height) {
      c.width = s.width
      c.height = s.height
    }
    const ctx = c.getContext('2d')
    if (!ctx) return
    const res = s.draw(ctx, t)
    if (seekRef.current) seekRef.current.value = String(Math.round(t))
    if (metaRef.current) {
      metaRef.current.textContent =
        `${(t / 1000).toFixed(1)}s / ${(s.totalMs / 1000).toFixed(1)}s` +
        ` · ${res.frame.zoom.toFixed(1)}×`
    }
  }, [])

  /**
   * 音源按会话渲染（预览与生成视频共用）。
   *
   * adj1119：有对拍结果时**优先用伴奏**（`mix.source = 'file'`）——
   * 不调 SpessaSynth，出片更快、也不依赖音色库；`mix` 时再叠一条合成音。
   * 没对拍 / 选了"合成音" ⇒ 完全走今天的路径。
   */
  const renderAudioFor = useCallback(async (session: DynamicSession): Promise<AudioBuffer> => {
    const sd = useSyncStore.getState()
    const doc = sd.doc
    /**
     * adj1152/adj1153：**0 条锚点也要能放伴奏**（用户口径：保留段起点 = 谱面第 1 拍）。
     * 有 sidecar + 伴奏 ⇒ 有效拟合统一走 `effectiveSyncFitOf`（0 条 `{J:, trim.start}`、
     * 1 条 `effectiveFitOf`、2+ `doc.tempo`）。
     */
    const fit = effectiveSyncFitOf(doc, 60000 / session.bpm)
    if (doc !== null && fit !== null && sd.audio !== null && doc.audio !== '' && doc.mix.source !== 'synth') {
      // adj1129：收尾淡出——最后一拍渐小到无声（用户口径：不要停得太突兀）
      const acc = await buildAccompanimentTrack(sd.audio, fit, doc.trim, session, 60000 / session.bpm)
      /**
       * adj1150：相机位的两条音量也要**真的进成片/预览**——
       * 以前 `file` 直接返回原始伴奏（音量被忽略）、`synth` 也是满音量；现在按 `mix` 缩放。
       */
      if (doc.mix.source === 'file') {
        return doc.mix.accomp === 1 ? acc : mixAudioBuffers([{ buffer: acc, gain: doc.mix.accomp }], session.totalMs)
      }
      const lib = resolveActiveLibrary(useUiStore.getState().playbackHqLibrary).lib
      const cache = (cacheRef.current ??= createHqCache())
      const { bank } = await resolveHqBank(lib, cache, hostBankUrl(lib.id))
      const synth = await renderToAudioBuffer(session.events, bank, { bpm: session.bpm })
      return mixAudioBuffers(
        [
          { buffer: synth, gain: doc.mix.synth },
          { buffer: acc, gain: doc.mix.accomp },
        ],
        session.totalMs,
      )
    }
    const lib = resolveActiveLibrary(useUiStore.getState().playbackHqLibrary).lib
    const cache = (cacheRef.current ??= createHqCache())
    const { bank } = await resolveHqBank(lib, cache, hostBankUrl(lib.id))
    const synth = await renderToAudioBuffer(session.events, bank, { bpm: session.bpm })
    // 没有 sidecar 时保持原来的满音量（默认 0.5 不该把"纯谱面合成音"固定调小）
    const gain = doc !== null && doc.mix.source === 'synth' ? doc.mix.synth : 1
    return gain === 1 ? synth : mixAudioBuffers([{ buffer: synth, gain }], session.totalMs)
  }, [])

  const prepareAudio = useCallback(async (): Promise<AudioBuffer | null> => {
    if (audioBufferRef.current) return audioBufferRef.current
    if (audioLoadRef.current) return audioLoadRef.current
    const s = sessionRef.current
    if (!s) return null
    const job = (async () => {
      const buffer = await renderAudioFor(s)
      if (sessionRef.current !== s) return null
      audioBufferRef.current = buffer
      audioPlayerRef.current?.setBuffer(buffer)
      return buffer
    })()
    audioLoadRef.current = job
    try {
      return await job
    } finally {
      audioLoadRef.current = null
    }
  }, [renderAudioFor])

  /**
   * 事件序列真的换了（源码/页面/标记段/3 分钟口径/对拍改动）才作废音轨；
   * 换比例不算——比例只影响相机画布，不影响声音。
   */
  useEffect(() => {
    audioPlayerRef.current?.stop()
    audioPlayerRef.current?.setBuffer(null)
    audioBufferRef.current = null
    audioLoadRef.current = null
  }, [code, pageConfig, range, mode, syncRev, instrument])

  // 打开 / 换比例 / 换源码或页面 / 换范围 / 换时长 ⇒ 重建会话
  useEffect(() => {
    if (!on) return
    let cancelled = false
    cancelAnimationFrame(rafRef.current)
    audioPlayerRef.current?.stop()
    setPlaying(false)
    setPreparingAudio(false)
    setStatus('busy')
    setError('')
    cursorRef.current = 0
    lastTsRef.current = 0
    sessionRef.current = null
    void (async () => {
      // adj1085 / adj1097：背景图引用（`ijipu-blob:`）在**建会话前**解析成 data URL（与导出共用入口）
      // adj1119：有对拍结果 ⇒ 用 sidecar 的拍速重建播放序列（相机/球/音轨同一个速度）
      return createDynamicSession(code, aspect as DynamicPresetId, pageConfig, syncBpm ?? undefined, {
        range,
        leadInMs: withCards ? LEAD_IN_MS : 0,
        // adj1148：前奏等待（伴奏照放、谱面定格第 1 拍）
        ...(headWaitMs > 0 ? { headWaitMs } : {}),
        // adj1113：不勾"带片头片尾" ⇒ 片尾也 0；勾着就按默认 2.5 秒品牌落版
        ...(withCards ? {} : { endCardMs: 0 }),
        maxMs: mode === '3min' ? EXPORT_MAX_MS : undefined,
        cardStyle: await withResolvedCardImage(effectiveCardStyle),
        shortCode,
        // adj1089：平移方式（订阅了 ⇒ 切下拉会重建会话；见上面的依赖数组）
        panMode,
        // adj1094：行末提前平移量（拍）
        rowLeadBeats,
        // adj1164：相机位音色（自动随谱时不传）
        ...(instrumentOverride === undefined ? {} : { instrumentOverride }),
      })
    })()
      .then((s) => {
        if (cancelled) return
        sessionRef.current = s
        setStatus('ready')
        if (seekRef.current) {
          seekRef.current.max = String(Math.round(s.totalMs))
          seekRef.current.value = '0'
        }
        paint(0)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [on, aspect, code, pageConfig, range, mode, effectiveCardStyle, shortCode, panMode, rowLeadBeats, withCards, syncBpm, headWaitMs, instrumentOverride, paint])

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  /**
   * adj1135（用户 2026-10-24 实报「合成音停不住、只能回试听里停」）：
   * 打开对拍台时把**相机位的预览音**停下来——它是另一条音轨（伴奏 + 合成音混音），
   * 不停的话会和台面里的播放叠在一起，而且台面的暂停按钮管不到它。
   */
  useEffect(() => {
    if (modal !== 'sync') return
    audioPlayerRef.current?.stop()
    cancelAnimationFrame(rafRef.current)
    setPlaying(false)
  }, [modal])

  const tick = useCallback(
    (ts: number) => {
      const s = sessionRef.current
      if (!s) return
      const previewEnd = s.totalMs
      const audioMs = audioPlayerRef.current?.currentMs() ?? null
      let next: number
      if (audioMs !== null) {
        next = Math.min(previewEnd, audioMs)
      } else {
        if (lastTsRef.current === 0) lastTsRef.current = ts
        const dt = ts - lastTsRef.current
        lastTsRef.current = ts
        next = Math.min(previewEnd, cursorRef.current + dt)
      }
      cursorRef.current = next
      paint(next)
      if (next >= previewEnd) {
        setPlaying(false)
        audioPlayerRef.current?.pause()
        lastTsRef.current = 0
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [paint],
  )

  const startPlayback = useCallback(
    async (from: number) => {
      const s = sessionRef.current
      if (!s) return
      const start = Math.max(0, Math.min(from, s.totalMs))
      // 首次要等离线渲染好几秒：必须在点击的同步栈里先解锁 AudioContext
      if (withAudioRef.current) {
        try {
          audioPlayerRef.current?.unlock()
        } catch {
          // 不支持/被策略拦 ⇒ 静音播放
        }
      }
      setPreparingAudio(true)
      let audioStarted = false
      try {
        if (withAudioRef.current) {
          const buffer = await prepareAudio()
          if (buffer) audioStarted = (await audioPlayerRef.current?.play(start)) ?? false
        }
      } catch (e) {
        setError(
          `${dynamicVideoCopy.previewAudioFailed}：${e instanceof Error ? e.message : String(e)}`,
        )
      }
      if (!audioStarted) audioPlayerRef.current?.stop()
      if (start >= s.totalMs) {
        setPlaying(false)
        setPreparingAudio(false)
        return
      }
      setPlaying(true)
      setPreparingAudio(false)
      lastTsRef.current = 0
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(tick)
    },
    [prepareAudio, tick],
  )

  const toggle = () => {
    const s = sessionRef.current
    if (!s || preparingAudio) return
    if (playing) {
      audioPlayerRef.current?.pause()
      setPlaying(false)
      cancelAnimationFrame(rafRef.current)
      lastTsRef.current = 0
      return
    }
    if (cursorRef.current >= s.totalMs) cursorRef.current = 0
    void startPlayback(cursorRef.current)
  }

  /**
   * adj1150：相机位改"输出声音"。
   *
   * 声音是**离线混出来的一整条 buffer**（预览与出片共用），所以要作废重渲——改完先暂停，
   * 下一次播放/生成就用新设置；不假装"正在播的这条也能立刻变"（离线重渲可能要几秒）。
   */
  const pauseForMixChange = () => {
    if (!playing) return
    audioPlayerRef.current?.pause()
    setPlaying(false)
    cancelAnimationFrame(rafRef.current)
    lastTsRef.current = 0
  }

  const changeMix = (patch: Partial<SyncMix>) => {
    setMix(patch)
    setMixNotice('')
    pauseForMixChange()
  }

  /** adj1165：相机位切换标记段；同步写 sidecar（range + markId），下次打开仍是这一段 */
  const changeCameraRange = (id: string) => {
    if (id === '__current__') return
    if (id === '') {
      setDynamicCamera({ range: null })
      setPracticeMarkId('')
      setExtras({ range: null, markId: '' })
      return
    }
    const m = practiceMarks.find((x) => x.id === id)
    if (!m) return
    const next = { startId: m.startId, endId: m.endId, ...(m.pass !== undefined ? { pass: m.pass } : {}) }
    setDynamicCamera({ range: next })
    setPracticeMarkId(id)
    setExtras({ range: next, markId: id })
  }

  /** sidecar 有文件名、但内存里没有伴奏（重开应用后）⇒ 在相机位里直接选一次 */
  const onPickMixAudio = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const buf = await decodeAccompaniment(await f.arrayBuffer())
      setAudioBuffer(buf)
      setMixNotice(dynamicVideoCopy.audioLoaded)
      pauseForMixChange()
    } catch (err) {
      setMixNotice(`${dynamicVideoCopy.audioLoadFailed}：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * adj1157：桌面壳走原生对话框，拿**真实路径**写回 `doc.audio`——
   * 这样下次刷新自动读的就是这个位置，而不是只记得一个文件名。
   */
  const onPickMixAudioNative = async () => {
    const path = await pickAudioFileNative()
    if (path === null) return
    try {
      const bytes = await readSidecarAudio(path)
      if (bytes === null) {
        setMixNotice(dynamicVideoCopy.audioLoadFailed)
        return
      }
      const buf = await decodeAccompaniment(bytes)
      setAudio(audioRefOf(path, nativePath), buf)
      setMixNotice(dynamicVideoCopy.audioLoaded)
      pauseForMixChange()
    } catch (err) {
      setMixNotice(`${dynamicVideoCopy.audioLoadFailed}：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const exportVideo = async () => {
    const s = sessionRef.current
    if (!videoExportEnabled || !s || encoding) return
    setPlaying(false)
    audioPlayerRef.current?.pause()
    cancelAnimationFrame(rafRef.current)
    setEncoding(true)
    setProgress(0)
    setExportDone(null)
    const ac = new AbortController()
    abortRef.current = ac
    try {
      /**
       * adj1097：导出与预览走**同一个** `withResolvedCardImage`——自定义样式的大图存的是
       * `ijipu-blob:` 引用，不解析就交给 `renderer.ts` 会 `decode()` 失败 ⇒ 成片丢背景图。
       */
      const res = await exportDynamicVideo({
        code,
        pageConfig,
        aspect: aspect as DynamicPresetId,
        mode,
        range,
        cardStyle: await withResolvedCardImage(effectiveCardStyle),
        shortCode,
        // adj1113：不带片头片尾 ⇒ 只出动态谱（片头 0 / 片尾 0 / 封面取第一拍）
        cards: withCards,
        // adj1089：出片与预览同一份平移方式（设置 → 本机 的 L1 偏好）
        panMode,
        // adj1094：行末提前平移量（拍）
        rowLeadBeats,
        // adj1164：出片与预览同一份音色（自动随谱时不传）
        ...(instrumentOverride === undefined ? {} : { instrumentOverride }),
        // adj1119：对拍拍速（有 sidecar 才传；出片与预览同一份速度）
        ...(syncBpm !== null ? { bpm: syncBpm } : {}),
        // adj1148：前奏等待与预览同口径（导出也把那段伴奏放出来）
        ...(headWaitMs > 0 ? { headWaitMs } : {}),
        // 逐次导出都重新按会话渲音轨：分段/遍次变了，事件序列就不同（缓存只能按会话建）
        ...(withAudio ? { makeAudio: renderAudioFor } : {}),
        onProgress: (p, ph) => {
          setProgress(p)
          setPhase(ph)
        },
        signal: ac.signal,
      })
      /**
       * adj1183（用户 2026-11-02）：「桌面壳导出后无提示，建议添加导出成功的提示，
       * 并提示打开文件/文件夹」。
       *
       * 桌面壳：走 Rust 原生保存对话框（能拿到真实路径）→ 成功提示带两个按钮；
       * 用户取消保存 ⇒ 明确提示"已取消"，不再静默。
       * 网页/开发浏览器：仍走 `<a download>`（拿不到路径），给一句"已开始下载"。
       */
      if (isTauriShell()) {
        const bytes = new Uint8Array(await res.blob.arrayBuffer())
        const savedPath = await tauriInvoke<string | null>('save_mp4_file', {
          name: `动态谱-${aspect}.mp4`,
          b64: bytesToBase64(bytes),
        })
        if (savedPath === null || savedPath === '') {
          showNotice(dynamicVideoCopy.exportCanceled, 'warn')
          return
        }
        setExportDone({ path: savedPath })
        const openPath = (reveal: boolean) => {
          void tauriInvoke('open_local_path', { path: savedPath, reveal }).catch((e: unknown) => {
            showNotice(dynamicVideoCopy.openFailed(e instanceof Error ? e.message : String(e)), 'error')
          })
        }
        showNotice(dynamicVideoCopy.exportedVideo(savedPath), 'ok', [
          { label: dynamicVideoCopy.openFile, run: () => openPath(false) },
          { label: dynamicVideoCopy.openFolder, run: () => openPath(true) },
        ])
        return
      }
      const url = URL.createObjectURL(res.blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `动态谱-${aspect}.mp4`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      showNotice(dynamicVideoCopy.exportedWeb, 'ok')
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setEncoding(false)
      setPhase('')
      abortRef.current = null
    }
  }

  const close = () => {
    if (encoding) abortRef.current?.abort()
    audioPlayerRef.current?.pause()
    cancelAnimationFrame(rafRef.current)
    setPlaying(false)
    setDynamicCamera({ on: false })
  }

  /** adj1185：相机位里的导出结果条也能直接打开文件/文件夹 */
  const openExportPath = (reveal: boolean) => {
    const path = exportDone?.path
    if (path === undefined) return
    void tauriInvoke('open_local_path', { path, reveal }).catch((e: unknown) => {
      showNotice(dynamicVideoCopy.openFailed(e instanceof Error ? e.message : String(e)), 'error')
    })
  }

  if (!on || !rect || !dynamicVideoEnabled) return null

  const spec = ASPECTS.find((a) => a.id === aspect) ?? ASPECTS[0]
  /**
   * adj1150：有「输出声音」那一排时，控制条多一行——画布要让出高度，
   * 否则 controls 会超出预览区被 `.dyn-frame-layer { overflow:hidden }` 裁掉。
   * 控制条自身再加 `maxHeight + overflow:auto` 兜底（窄/矮预览区也能滚到）。
   */
  // adj1176：只记了卡片模板、没有伴奏的 sidecar 不算"有混音排"（别白让一块高度）
  const hasMixRow = syncDoc !== null && syncDoc.audio !== ''
  /**
   * adj1189（用户 2026-11-03）：「让相机位的预览界面更大一些，以显示更多的细节」。
   * 放大取景框：高度上限从 66%/55% 提到 78%/68%，宽度从 90% 提到 96%，
   * 同时给下方控制条预留固定高度（不够时控制条自己滚动，见 controlsMaxH/overflow）。
   */
  const maxH = Math.min(
    rect.height * (hasMixRow ? 0.68 : 0.78),
    rect.height - (hasMixRow ? 220 : 160),
  )
  const maxW = rect.width * 0.96
  let h = Math.max(120, maxH)
  let w = h * spec.ratio
  if (w > maxW) {
    w = maxW
    h = w / spec.ratio
  }
  const left = rect.left + (rect.width - w) / 2
  const top = rect.top + 6
  const boxH = Math.max(h, 120)
  /**
   * adj1227（用户要求）：控制条别再只给 560px 下限、和窄相机框对齐；
   * 直接铺满预览区宽度（左右各留 8px），让一行能放下更多控件、减少行数。
   */
  const controlsW = Math.max(240, rect.width - 16)
  const controlsLeft = rect.left + 8
  const controlsTop = top + boxH + 10
  const controlsMaxH = Math.max(120, rect.height - (controlsTop - rect.top) - 8)
  return (
    <div
      className="dyn-frame-layer"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      <div
        className="dyn-frame-box"
        style={{ left: left - rect.left, top: top - rect.top, width: w, height: boxH }}
      >
        <canvas ref={canvasRef} />
        {status !== 'ready' && (
          <div className="dyn-frame-mask">
            {status === 'busy' ? dynamicVideoCopy.preparing : error || dynamicVideoCopy.empty}
          </div>
        )}
      </div>

      <div
        className="dyn-frame-controls"
        style={{
          left: controlsLeft - rect.left,
          top: controlsTop - rect.top,
          width: controlsW,
          maxHeight: controlsMaxH,
          overflowY: 'auto',
        }}
      >
        <div className="dyn-frame-controls-row">
          <button
            type="button"
            className="btn dyn-frame-play"
            onClick={toggle}
            disabled={status !== 'ready' || preparingAudio}
          >
            {preparingAudio
              ? dynamicVideoCopy.preparingAudio
              : playing
                ? dynamicVideoCopy.pause
                : dynamicVideoCopy.play}
          </button>
          <input
            ref={seekRef}
            type="range"
            min={0}
            max={1000}
            step={10}
            disabled={status !== 'ready'}
            onChange={(e) => {
              const t = Number(e.target.value)
              cursorRef.current = t
              paint(t)
              if (playing) {
                audioPlayerRef.current?.pause()
                void startPlayback(t)
              }
            }}
          />
          <span ref={metaRef} className="dyn-frame-meta" />
          <button type="button" className="btn dyn-frame-close" onClick={close} title="关闭相机位">
            ✕
          </button>
        </div>

        <div className="dyn-frame-controls-row">
          {/* adj1113：复选框紧挨「卡片」前，不占一行字；说明放悬浮提示（adj1116 用户口径） */}
          <label className="dock-field dyn-frame-cards" title={dynamicVideoCopy.cardsHint}>
            <input
              type="checkbox"
              checked={withCards}
              disabled={encoding || preparingAudio}
              aria-label={dynamicVideoCopy.cards}
              onChange={(e) => setWithCards(e.target.checked)}
            />
          </label>
          <span className="dyn-frame-label">{dynamicVideoCopy.cardStyle}</span>
          <select
            className="dyn-frame-select"
            value={cardStyleValue}
            disabled={encoding || preparingAudio || !withCards}
            aria-label={dynamicVideoCopy.cardStyle}
            onChange={(e) => {
              const id = e.target.value
              setDynamicCardStyle(id)
              // adj1176：选择记到**这首歌**的 sidecar 里，换回来还能恢复
              recordCardTemplate(id)
            }}
          >
            <optgroup label={dynamicVideoCopy.cardBuiltin}>
              {CARD_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </optgroup>
            {cardTemplates.length > 0 && (
              <optgroup label={dynamicVideoCopy.cardMine}>
                {cardTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            type="button"
            className="btn dyn-frame-card-edit"
            disabled={encoding || preparingAudio || !withCards}
            onClick={() => openModal('cardStyle')}
          >
            {dynamicVideoCopy.cardManage}
          </button>
          <span className="dyn-frame-meta">
            {withCards ? effectiveCardStyle.description : dynamicVideoCopy.cardsOffHint}
          </span>
          <label className="dock-field dyn-frame-short" title={dynamicVideoCopy.shortHint}>
            <span className="dyn-frame-label">{dynamicVideoCopy.shortLabel}</span>
            <input
              className="dyn-frame-short-input"
              value={shortCode}
              maxLength={6}
              disabled={encoding || preparingAudio || !withCards}
              placeholder="star"
              aria-label={dynamicVideoCopy.shortHint}
              onChange={(e) => {
                const raw = e.target.value.trim()
                const hit = raw.match(/\/s\/([a-z]{3,6})\/?$/i)
                const next = (hit ? hit[1] : raw).toLowerCase().replace(/[^a-z]/g, '').slice(0, 6)
                setShortCode(next)
              }}
            />
          </label>
        </div>

        {/* adj1150（用户 2026-10-25）：对拍文件存在时，相机位直接给「输出声音」——
            声音档 + 两条音量，与台面共用同一份 `syncDoc.mix`，出片/预览都按它混音。
            adj1176：只记了卡片模板、还没有伴奏的 sidecar 不该冒出这一排。 */}
        {syncDoc !== null && syncDoc.audio !== '' && (
          <div className="dyn-frame-controls-row dyn-frame-mix" data-sync="dyn-mix">
            <span className="dyn-frame-label" title={dynamicVideoCopy.outputSoundHint}>
              {dynamicVideoCopy.outputSound}
            </span>
            <select
              className="dyn-frame-select"
              data-sync="dyn-mix-source"
              value={syncDoc.mix.source}
              disabled={encoding || preparingAudio}
              title={dynamicVideoCopy.outputSoundHint}
              aria-label={dynamicVideoCopy.outputSound}
              onChange={(e) => changeMix({ source: e.target.value as SyncMix['source'] })}
            >
              <option value="file" disabled={syncAudio === null}>{syncCopy.mixFile}</option>
              <option value="mix" disabled={syncAudio === null}>{syncCopy.mixBoth}</option>
              <option value="synth">{syncCopy.mixSynth}</option>
            </select>
            <span className="dyn-frame-label">{syncCopy.accompGain}</span>
            <input
              className="dyn-frame-range"
              data-sync="dyn-mix-accomp"
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={syncDoc.mix.accomp}
              disabled={encoding || preparingAudio}
              aria-label={syncCopy.accompGain}
              onChange={(e) => changeMix({ accomp: Number(e.target.value) })}
            />
            <span className="dyn-frame-meta dyn-frame-mix-val">{Math.round(syncDoc.mix.accomp * 100)}%</span>
            <span className="dyn-frame-label">{syncCopy.synthGain}</span>
            <input
              className="dyn-frame-range"
              data-sync="dyn-mix-synth"
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={syncDoc.mix.synth}
              disabled={encoding || preparingAudio}
              aria-label={syncCopy.synthGain}
              onChange={(e) => changeMix({ synth: Number(e.target.value) })}
            />
            <span className="dyn-frame-meta dyn-frame-mix-val">{Math.round(syncDoc.mix.synth * 100)}%</span>
            {syncAudio === null && (
              <>
                <span className="dyn-frame-meta">
                  {dynamicVideoCopy.outputSoundNoAudio}
                  {syncDoc.audio !== '' ? `：${syncDoc.audio}` : ''}
                </span>
                <input
                  ref={mixFileRef}
                  className="sync-file"
                  type="file"
                  accept="audio/*,.mp3,.m4a,.wav,.flac"
                  onChange={(e) => void onPickMixAudio(e)}
                />
                <button
                  type="button"
                  className="btn"
                  data-sync="dyn-mix-pick"
                  disabled={encoding}
                  onClick={() => {
                    // adj1157：桌面壳原生选伴奏拿路径；网页仍走 <input>
                    if (isTauriShell()) void onPickMixAudioNative()
                    else mixFileRef.current?.click()
                  }}
                >
                  {dynamicVideoCopy.pickAccompaniment}
                </button>
              </>
            )}
            {mixNotice !== '' && <span className="dyn-frame-meta">{mixNotice}</span>}
          </div>
        )}

        {/* adj1185（用户实报「导出后还是没有提示」）：相机位里再留一条结果，不依赖 toast 的层级 */}
        {exportDone && (
          <div className="dyn-frame-controls-row dyn-frame-export-done" data-sync="dyn-export-done">
            <span className="dyn-frame-meta dyn-frame-export-path">
              {dynamicVideoCopy.exportedVideo(exportDone.path)}
            </span>
            <button type="button" className="btn" onClick={() => openExportPath(false)}>
              {dynamicVideoCopy.openFile}
            </button>
            <button type="button" className="btn" onClick={() => openExportPath(true)}>
              {dynamicVideoCopy.openFolder}
            </button>
            <button type="button" className="btn" onClick={() => setExportDone(null)}>
              {dynamicVideoCopy.exportDoneClose}
            </button>
          </div>
        )}

        <div className="dyn-frame-controls-row">
          <span className="dyn-frame-label">{dynamicVideoCopy.presetLabel}</span>
          {ASPECTS.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`btn dyn-frame-ratio${a.id === aspect ? ' is-on' : ''}`}
              disabled={encoding || preparingAudio}
              onClick={() => setDynamicCamera({ aspect: a.id })}
            >
              {a.label}
            </button>
          ))}
          <span className="dyn-frame-label">时长</span>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`btn dyn-frame-ratio${m.id === mode ? ' is-on' : ''}`}
              disabled={encoding || preparingAudio}
              onClick={() => setDynamicCamera({ mode: m.id })}
            >
              {m.label}
            </button>
          ))}
          <span className="dyn-frame-label" title={dynamicVideoCopy.instrumentHint}>
            {dynamicVideoCopy.instrumentLabel}
          </span>
          <select
            className="dyn-frame-select"
            data-sync="dyn-instrument"
            value={instrument ?? ''}
            disabled={encoding || preparingAudio}
            title={dynamicVideoCopy.instrumentHint}
            aria-label={dynamicVideoCopy.instrumentLabel}
            onChange={(e) => setDynamicCamera({ instrument: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">{dynamicVideoCopy.instrumentAuto}</option>
            {instrumentOptions.map((v) => (
              <option key={v.program} value={v.program}>
                {v.label}
              </option>
            ))}
          </select>
          <label className="dock-field dyn-frame-audio">
            <input
              type="checkbox"
              checked={withAudio}
              disabled={encoding || preparingAudio}
              onChange={(e) => {
                const next = e.target.checked
                withAudioRef.current = next
                setWithAudio(next)
                if (!next) {
                  audioPlayerRef.current?.pause()
                } else if (playing) {
                  audioPlayerRef.current?.pause()
                  setPlaying(false)
                  cancelAnimationFrame(rafRef.current)
                  void startPlayback(cursorRef.current)
                }
              }}
            />
            <span>带声音</span>
          </label>
          <span className="dyn-frame-label">{dynamicVideoCopy.rangeSegment}</span>
          <select
            className="dyn-frame-select"
            data-sync="dyn-range"
            value={range === null ? '' : selectedMarkId || '__current__'}
            disabled={encoding || preparingAudio}
            aria-label={dynamicVideoCopy.rangeSegment}
            onChange={(e) => changeCameraRange(e.target.value)}
          >
            <option value="">{dynamicVideoCopy.rangeAll}</option>
            {practiceMarks.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            {range !== null && selectedMarkId === '' && <option value="__current__">{dynamicVideoCopy.rangeUnlisted}</option>}
          </select>
          {/* adj1121：对拍入口**挪到试听栏**（对拍是边听边对的活）；相机位只保留当前对拍状态
              adj1176：只记了卡片模板的 sidecar 没有对拍，别显示一个假的「对拍 ♩=」徽标 */}
          {syncDoc !== null && syncDoc.audio !== '' && syncBpm !== null && (
            <span className="dyn-frame-meta dyn-frame-sync-badge">
              {syncCopy.syncBadge} ♩={Math.round(syncBpm)}
              {syncFit ? ` · 偏移 ${(syncFit.offsetMs / 1000).toFixed(2)}s` : ''}
              {syncDoc?.mix.source === 'synth' ? ` · ${syncCopy.mixSynth}` : ''}
            </span>
          )}
          <button
            type="button"
            className="btn dyn-frame-generate"
            onClick={encoding ? () => abortRef.current?.abort() : exportVideo}
            disabled={!videoExportEnabled || status !== 'ready'}
          >
            {encoding
              ? `取消（${Math.round(progress * 100)}%）`
              : dynamicVideoCopy.exportMp4}
          </button>
          {!videoExportEnabled && (
            <span className="dyn-frame-meta dyn-frame-desktop-only">
              {dynamicVideoCopy.desktopOnly}
            </span>
          )}
          {preparingAudio && <span className="dyn-frame-meta">{dynamicVideoCopy.preparingAudio}</span>}
          {phase && <span className="dyn-frame-meta">{phase}</span>}
        </div>
        {error && <div className="dyn-frame-error">✗ {error}</div>}
      </div>
    </div>
  )
}
