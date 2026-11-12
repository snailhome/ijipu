/**
 * adj987o（**用户 2026-10-18 口径**）：标记段开始 / 每次循环重来前的 **3-2-1 倒数**。
 *
 * 为什么做成模块级纯时序函数：① 时限逻辑（每 1 秒跳一个数、结束清空）一处写清；
 * ② 组件只负责把数字写进 store（预览层据此在起始音上画），不掺时序细节；
 * ③ 传 `stale()` 进来：倒数期间若用户按了停止 / 又发起新的播放，本次倒数**立刻放弃**。
 *
 * @param stale 代次守卫（返回 true = 这次播放已被作废）
 */
async function runCountdown3(stale: () => boolean): Promise<void> {
  for (const n of [3, 2, 1]) {
    if (stale()) {
      useUiStore.getState().setPracticeCountdown(null)
      return
    }
    useUiStore.getState().setPracticeCountdown(n)
    await new Promise((r) => setTimeout(r, 1000))
  }
  useUiStore.getState().setPracticeCountdown(null)
}

/**
 * dialogs/PlaybackDialog.tsx — 试听播放（adj344：固定 SpessaSynth 高保真，移除合成/midi-js 试听）
 *
 * 能力：速度 30~240 拍/分（默认取 J 描述头）；固定 SpessaSynth 高保真音源（桌面为随安装包
 * 内置在安装目录的 SF2，直接读取；Web 首次打开即自动下载并缓存到 IndexedDB，后续直接读缓存；
 * 需要下载时显示进度提示）；「音色」下拉
 * 仅列用户启用的收藏音色（GM program，默认含常用音色，由「设置 → 音色库」勾选）；播放/停止；
 * 播放中音符高亮 + 自动滚屏（复用 M3 联动）；反复记号展开。
 * adj347：① 打开试听即自动下载音源（不再要求用户先手动点下载，点播放即可用）；
 * ② 音色默认启用一组常用音色（首次即可选）。
 * adj344：试听简化：①去掉「模式/音色库」下拉（不再提供合成/采样切换），固定 SpessaSynth
 * 高保真；②play() 收敛为高保真，移除合成/midi-js 采样分支；③「音色」只列启用收藏音色。
 * adj416：桌面端音源随安装包内置在**安装目录**（`generaluser_gs.sf2`）——直接读文件、不提示下载；
 * 音源来源统一走 resolveHqBank（缓存 → 内置 → 联网）。
 * adj158：① 内容压缩缩小对话框；② 播放时停靠窗口右下角让开预览区；
 * ③ 播放中双击谱面音符 → 快速跳到该处重新播放（PreviewPane 通过 playbackTick 触发）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '../ui/Modal'
import { ToolIcon } from '../ui/ToolIcon'
import { useDocStore } from '../store/docStore'
import { useUiStore, enabledVoicesOf } from '../store/uiStore'
// adj729：嵌入版里音源优先取**插件目录**那份（宿主给的 URL；随文库一起走）
import { hostBankUrl } from '../store/hostBridge'
import { playbackCopy } from '../brand/copy'
import { createHqCache, prefetchHqLibraryProgress, resolveHqBank } from '../playback/spessaCache'
// adj1011：`resolveActiveLibrary` = "当前用哪个库"的唯一判据（与导出/面板同源）
import { SpessaSynthBackend, resolveActiveLibrary, hasBuiltinBank, firstEnabledInstrumentRef, enabledInstrumentRefs, hqBankFailureText } from '../playback/spessaSynthBackend'
// adj1030：底栏音色下拉 = GM 勾选 + 民乐勾选（同一张表、按 program 去重）
import { playbackVoiceOptions } from '@ijipu/engine/playback/voiceOptions'
// adj409：暂停/续播的剩余事件平移（纯函数）
import { shiftEventsFrom } from '../playback/playbackTimeline'
// adj647：宿主字体实测（与预览同一份 ⇒ 色块位置一致；见 preview/fontMeta.ts）
import { measureFontMeta } from '../preview/fontMeta'
// adj722：`mm:ss` 进度读数（纯函数，便于 smoke 断言）
import { fmtClock } from './playbackClock'
// adj996（用户 2026-10-19 要求）：遍次读数（纯函数，见该文件头）
import { passLabel } from './playbackPass'
// adj723d：试听**单实例**保证（代次守卫，纯模块便于 smoke 断言）
import { createPlaybackGeneration, shouldAutoPlay } from './playbackSession'
// adj987（用户需求）：标记段组的按钮组（收起/段选择/起始/停止/添加/删除/循环）+ 收起时的"歌名前展开"按钮
import { PracticeMarkBar, PracticeMarkExpandButton } from './PracticeMarkBar'

// adj764（清单 B6）：试听时钟来自引擎 —— 与 Obsidian 插件共用"推进/暂停续播/取消/到点一次"的语义
import { layoutScore, buildPlaySequence, inferBpm, schedulePlay, resolvePracticeRange, slicePlaySequenceByRange, hasNoteId, gmVoiceRef, countScoreInstrumentSwitches, createPlaybackClock, type PlaybackClock } from '@ijipu/engine'

const BPM_OPTIONS = [60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120]
/**
 * adj987（**用户 2026-10-18 口径**）：标记段**循环之间的等待** = 3 秒 —— 由 **3-2-1 倒数**实现
 * （`runCountdown3` 每秒跳一个数，正好 3 秒）。用户原话：「每次循环前加一个 3s 的等待，
 * 一个是区分出循环位置，一个是给用户循环练习时喘口气」。
 *
 * ⇒ 循环定时器只等"这一遍奏完 + 60ms 余量"；**不要再额外加 3 秒**（否则一共要等 6 秒）。
 */
const LOOP_RESTART_DELAY_MS = 60

export function PlaybackDialog({ inline = false }: { inline?: boolean } = {}) {
  const parseResult = useDocStore((s) => s.parseResult)
  const pageConfig = useDocStore((s) => s.pageConfig)
  const setActiveNoteId = useDocStore((s) => s.setActiveNoteId)
  // adj258：批量高亮播放中同时演奏的音符
  const setActiveNoteIds = useDocStore((s) => s.setActiveNoteIds)
  const setVoiceBlocks = useDocStore((s) => s.setVoiceBlocks)
  // adj282：播放轨道 + 当前 ms（RAF 驱动）——PreviewPane 渲染跟随色块
  const setPlayheadTrack = useDocStore((s) => s.setPlayheadTrack)
  // adj1048：拍网格（跳跳球按拍落，不按音落）
  const setPlayheadBeat = useDocStore((s) => s.setPlayheadBeat)
  const setCurrentMs = useDocStore((s) => s.setCurrentMs)
  // adj326：编辑区方位（左右拆分的排列方向），决定试听对话框停靠到左下/右下角
  const viewType = useDocStore((s) => s.viewType)
  const playbackStartId = useUiStore((s) => s.playbackStartId)
  const setPlaybackStart = useUiStore((s) => s.setPlaybackStart)
  const playbackTick = useUiStore((s) => s.playbackTick)
  // adj1121：试听栏的「对拍…」入口（桌面专属；试听是底栏面板，关掉对拍台它还在）
  // adj332：已启用音色集合——试听音色下拉只列这些（避免 128 项全列）
  const playbackHqEnabled = useUiStore(enabledVoicesOf)
  /** adj1030：民乐页签勾选的名字 —— 底栏音色列表要把它们并进来，否则"勾了却看不到" */
  const ethnicVoicesEnabled = useUiStore((s) => s.ethnicVoicesEnabled)
  const voiceOptions = useMemo(
    () => playbackVoiceOptions(playbackHqEnabled, ethnicVoicesEnabled),
    [playbackHqEnabled, ethnicVoicesEnabled],
  )
  const playbackHqVoice = useUiStore((s) => s.playbackHqVoice)
  const setPlaybackHqVoice = useUiStore((s) => s.setPlaybackHqVoice)
  /** adj1011：当前选中的音色库（L1 偏好）；库被删/换机器时自动回退默认库并标 fallback */
  const playbackHqLibrary = useUiStore((s) => s.playbackHqLibrary)
  const activeLib = useMemo(() => resolveActiveLibrary(playbackHqLibrary), [playbackHqLibrary])
  // adj354：@@ 恢复默认音色=第一音色——无描述头 Y 时取试听音色列表第一个启用音色（GM program 名）
  const defaultInstrumentRef = useMemo(() => firstEnabledInstrumentRef(playbackHqEnabled), [playbackHqEnabled])
  /**
   * adj908（用户报「未设置音色的情况下，声部之间没有用不同的音色区分开，色块也没有区分」）：
   * 把**整份**启用音色列表传进引擎——描述头没写 `Y:`（或行数不够）时，第 n 声部取第 n 个启用音色，
   * 使声部之间音色不同（色块颜色按音色去重分配，随之区分开）。
   * 「自动」模式下才需要它；选定具体音色时由 `voiceOverrideRef` 全篇统一（优先级更高，见引擎注释）。
   */
  const enabledInstRefs = useMemo(() => enabledInstrumentRefs(playbackHqEnabled), [playbackHqEnabled])
  /**
   * adj455：选定具体音色时传给 `buildPlaySequence` 的**全篇乐器覆盖**（音色名 ref）——
   * 「自动」（null）时为 undefined，引擎完全不介入、按谱面路由。
   * 与 `backend.setVoice(playbackHqVoice)` 同源（同一张 GM 表：program ↔ 音色名 ref 互逆，smoke 有断言）。
   */
  const voiceOverrideRef = useMemo(() => gmVoiceRef(playbackHqVoice), [playbackHqVoice])
  /** adj455：谱面里 `@乐器名@` 显式切换的处数——>0 且选了具体音色时提示"已被统一覆盖" */
  const voiceSwitchCount = useMemo(() => countScoreInstrumentSwitches(parseResult), [parseResult])
  // adj326：左右拆分方位（previewLeft=左预览右编辑 / editorLeft=左编辑右预览）
  const splitHDir = useUiStore((s) => s.splitHDir)
  // adj323：宽/窄屏（≤1024px 视为窄屏模式，adj322）——角落停靠仅宽屏生效，窄屏保持原样
  const isNarrowMode = useUiStore((s) => s.isNarrow)
  // adj327：加载失败时用 toast 明确告知原因（不再仅复位后静默）
  const showNotice = useUiStore((s) => s.showNotice)

  const defaultBpm = useMemo(() => inferBpm(parseResult), [parseResult])
  const [bpm, setBpm] = useState(defaultBpm)
  const [playing, setPlaying] = useState(false)
  // adj409：暂停态——`playing` 表示"会话仍在进行（含暂停）"，`paused` 表示音频已停住但可续播。
  // 二者分开：播放中按钮显示「暂停」，暂停后显示「继续」，会话未结束时「停止」始终可用、对话框保持停靠。
  const [paused, setPaused] = useState(false)
  // adj409：按播放后的准备期（音源加载/序列构建）——此间按钮置灰，避免连点重入
  const [starting, setStarting] = useState(false)
  const [samplerState, setSamplerState] = useState<string>('idle')
  const [totalMs, setTotalMs] = useState(0)
  /**
   * adj722：`mm:ss` 进度读数用的**本地**时钟（不订阅 docStore 的 `currentMs`）。
   *
   * 为什么不直接读 `currentMs`：它由 RAF **每帧**写入，组件订阅它就会 60fps 重渲染；
   * 读数只需到秒 ⇒ 搭在已有的 **50ms 高亮定时器**上更新即可（那个定时器本来就在跑）。
   */
  const [clockMs, setClockMs] = useState(0)
  // adj347/348：音源下载中（首次打开自动后台下载；前台仅文字提示，不阻塞其它交互）
  const [downloading, setDownloading] = useState(false)
  // adj416：音源随安装包内置（安装目录 generaluser_gs.sf2）→ 直接读文件，不显示下载提示
  const [builtinBank, setBuiltinBank] = useState(false)
  // adj293：播放异常提示（async play 若中途抛错此前被静默吞掉 → 无声无色块无法定位）
  const [playError, setPlayError] = useState<string | null>(null)
  // adj：窄屏（≤640px）下对话框已是 bottom-sheet 靠底，播放时不再 dock 到 bottom-right
  // （避免窄屏下还在屏幕中下位置来回移动；只有宽屏播放时才停靠右下角让出预览区）
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const onChange = () => setIsNarrow(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const backendRef = useRef<SpessaSynthBackend | null>(null)
  // adj331：SpessaSynth 音源缓存（IndexedDB，音源仅首次使用时下载并缓存，后续直接读缓存）
  const hqCacheRef = useRef<ReturnType<typeof createHqCache> | null>(null)
  // adj347：音源就绪 Promise（初次自动下载/缓存；播放与下载共享，避免重复下载）
  const bankPromiseRef = useRef<Promise<void> | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)
  // adj158：播完自动复位（playing=false → 对话框回中央）
  const doneTimerRef = useRef<number | null>(null)
  /** adj987（用户需求）：练习段循环——"到点重播这一段"的定时器 */
  const loopTimerRef = useRef<number | null>(null)
  /** adj989：这一段的总长（ms）——续播时要据此算'还剩多长'，循环才不会断 */
  const practiceRangeMsRef = useRef(0)
  /**
   * adj1100（用户 2026-10-23 实报）：选了**练习段**时，「共 M 遍」要用**这一段的遍数**
   * （= 同一对起止配出的候选个数），而不是整曲遍数。
   *
   * 用户原话：`33:1→34:2` 要进跳房子 1，「必然只有一遍」，界面却显示"共 3 遍"。
   * `null` = 没选段（全曲播放）⇒ 仍按整曲 `maxPass`。
   */
  const practicePassTotalRef = useRef<number | null>(null)
  // adj258：播放序列 + 启动时间（本地计时），高亮定时器按当前 atMs 设 activeNoteIds
  const seqRef = useRef<ReturnType<typeof buildPlaySequence> | null>(null)
  /** adj409：暂停时已播到的位置（原时间轴毫秒）= 续播起点 */
  const pausedAtRef = useRef<number>(0)
  const highlightTimerRef = useRef<number | null>(null)
  /**
   * adj723d（用户报「Ctrl+点音符不要启动另一播放进程，同一谱子只能有一个试听态」）：
   * **播放代次守卫**——规则与理由见 `playbackSession.ts`（抽成纯模块供 smoke 断言）。
   * 任何异步等待之后都要 `isStale(gen)` 核对自己是否还是最新一次，过期就放弃且不落地。
   */
  const playGenRef = useRef(createPlaybackGeneration())
  // adj409：播放/暂停按钮——点击后把焦点留在这里，空格即可暂停/继续
  const playBtnRef = useRef<HTMLButtonElement>(null)

  const header = parseResult.header
  // adj326：打开试听对话框即按编辑区方位停靠——编辑区在左（左右拆分 editorLeft）→ 左下角；
  // 编辑区在右/下/全屏（含上下拆分、纯 preview/code）→ 右下角。仅在宽屏模式生效。
  const editorCorner: 'bottom-left' | 'bottom-right' =
    (viewType === 'splitH' || viewType === 'splitHE') && splitHDir === 'editorLeft'
      ? 'bottom-left'
      : 'bottom-right'
  // adj326：最终停靠位置——宽屏模式（>1024）打开即按编辑区方位停靠角落；
  // 窄屏模式（≤1024）保持 adj158 原逻辑（播放时停靠右下让开预览区；≤640 移动端 bottom-sheet 靠底）
  const dockPos = isNarrowMode
    ? (playing && !isNarrow ? 'bottom-right' : undefined)
    : editorCorner
  // adj331：SpessaSynth 音源缓存（IndexedDB，供试听/导出复用；音源首次使用时下载并缓存）
  const hqCache = (hqCacheRef.current ??= createHqCache())

  // adj347：确保音源就绪（优先读缓存；未缓存则自动下载并缓存，带进度提示）。
  // 用共享 Promise：打开试听即自动下载，点播放时复用同一下载，避免重复下载。
  // adj416：桌面端音源随安装包内置在安装目录——先探测（极快），有就直接用、不显示下载提示。
  // adj953：嵌入版还要**问一次宿主（插件目录）**——宿主有那份音源时下 0 次 CDN（见 spessaCache 的说明）。
  const ensureBank = (): Promise<void> => {
    if (!bankPromiseRef.current) {
      // adj1011：取**当前选中的库**（不再是无参默认库）
      const hqLib = activeLib.lib
      setSamplerState('loading')
      bankPromiseRef.current = (async () => {
        // adj416：桌面随安装包内置音源（安装目录 SF2）→ 直接读文件即可，不必再走缓存/下载流程
        if (await hasBuiltinBank(hqLib)) {
          setBuiltinBank(true)
          setSamplerState('ready')
          return
        }
        // adj953：**先去缓存、再去宿主（插件目录）、最后才联网**——
        // `onRemote` 只在真的要走联网那一刻回调，于是嵌入版有宿主音源时
        // **不会**出现「正在后台下载音色库」那句（用户实报的假提示：宿主那份没被用上，回回联网下 32MB）。
        // 不需要百分比读数 ⇒ `onProgress` 传 `undefined`（签名第 3 位不变，既有调用点不受影响）。
        const source = await prefetchHqLibraryProgress(
          hqLib,
          hqCache,
          undefined,
          hostBankUrl(hqLib.id),
          { onRemote: () => setDownloading(true) },
        )
        setDownloading(false)
        if (source === 'builtin') setBuiltinBank(true)
        setSamplerState('ready')
      })()
        .catch((e) => {
          setSamplerState('failed')
          throw e
        })
        .finally(() => {
          setDownloading(false)
          bankPromiseRef.current = null
        })
    }
    return bankPromiseRef.current
  }

  // adj347/349：打开试听即后台自动下载音源——延迟到 UI 渲染后再触发，保证打开/交互秒响应
  // adj1011：**切库要重新预取**——依赖 `playbackHqLibrary`，并先作废上一个库的 Promise 与状态
  //          （否则会沿用旧库的"已就绪"，点播放还是老声音）
  useEffect(() => {
    bankPromiseRef.current = null
    setBuiltinBank(false)
    setDownloading(false)
    setSamplerState('idle')
    const t = window.setTimeout(() => {
      void ensureBank().catch((e) => {
        // adj724b：提示要说清"地址不可达、可手动导入一次（之后走缓存）"，见 `hqBankFailureText`
        // adj728：并**带一个按钮**直接跳到「设置 → 音色库」（该提示因此不自动消失）
        // adj1011：文案里的库名必须是**当前库**（原来钉死默认库，切库后提示仍说 GeneralUser）
        showNotice(hqBankFailureText(activeLib.lib, e), 'error', {
          label: '打开音色库',
          run: () => useUiStore.getState().openSettings('soundbank'),
        })
      })
    }, 60)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackHqLibrary])

  // adj448：试听「音色」是**会话级**（store 初值恒为「自动」，不落盘）——选定具体音色会覆盖
  // 谱面 `Y:` 乐器，若被持久化，用户下次打开带多声部 `Y:` 的谱子时音色仍是上次那个，
  // 看起来像「谱面 Y: 不生效」（用户实测反馈）。adj450（用户要求）：**本次运行内记住**选择，
  // 不再每次打开对话框都重置——只有重启应用才回到「自动」。

  // 关闭时停止播放
  useEffect(() => {
    return () => {
      cancelRef.current?.()
      if (doneTimerRef.current !== null) window.clearTimeout(doneTimerRef.current)
      if (highlightTimerRef.current !== null) window.clearInterval(highlightTimerRef.current)
      clockRef.current?.cancel()
      backendRef.current?.dispose()
      setActiveNoteId(null)
      setActiveNoteIds([])
      setVoiceBlocks([])
      setPlayheadTrack([])
      setCurrentMs(0)
    }
  }, [setActiveNoteId, setActiveNoteIds, setVoiceBlocks, setPlayheadTrack, setCurrentMs])

  // ---- adj409：播放驱动（RAF 色块 + 50ms 高亮 + 收尾复位）统一在这里启停，暂停/续播复用同一套 ----

  /**
   * adj764（清单 B6：用户要求「播放及色块显示等共性的功能都可以独立到引擎层面」，且"应用端也应同样处理"）：
   * 时间轴推进改用**引擎时钟** `createPlaybackClock` —— 与 Obsidian 插件共用同一套
   * "推进 / 暂停续播 / 取消后不再回调 / 到点恰好一次"的语义。
   *
   * 原来这里用 `timeBaseRef + (performance.now() - startTimeRef)` 自己算（adj409 的三 ref 方案），
   * 语义与引擎时钟**完全一致**，只是各写一份 ⇒ 现在只留 `clockRef` 一个来源。
   * `curMs()` 保留为薄封装（调用点不动）：它就是时钟的当前时间轴位置。
   */
  const clockRef = useRef<PlaybackClock | null>(null)
  const clock = (): PlaybackClock =>
    (clockRef.current ??= createPlaybackClock({ onTick: (ms) => setCurrentMs(ms) }))
  /** 当前（**原时间轴**）播放位置，毫秒 */
  const curMs = () => clock().ms()

  /** 清掉三个驱动定时器（收尾 / 高亮 / RAF） */
  const clearTimers = () => {
    if (doneTimerRef.current !== null) {
      window.clearTimeout(doneTimerRef.current)
      doneTimerRef.current = null
    }
    // adj987：练习段循环的"到点重播"定时器也要一起清（否则停止后还会自己再播一遍）
    if (loopTimerRef.current !== null) {
      window.clearTimeout(loopTimerRef.current)
      loopTimerRef.current = null
    }
    if (highlightTimerRef.current !== null) {
      window.clearInterval(highlightTimerRef.current)
      highlightTimerRef.current = null
    }
  }

  /** 清空播放期的界面态（高亮 / 声部色框 / 色块轨道 / 播放位置） */
  const clearPlaybackUi = () => {
    setActiveNoteId(null)
    setActiveNoteIds([])
    setVoiceBlocks([])
    setPlayheadTrack([])
    setCurrentMs(0)
    setClockMs(0)
  }

  /**
   * 启动驱动：**引擎时钟每帧**回调刷新 `currentMs`（色块滑动）、50ms 比对高亮、
   * 到点（job.totalMs + 100）自动复位。
   * 暂停后重排的序列是"相对现在"的，故收尾时间直接用 job.totalMs —— 与首次播放同一套语义。
   */
  /**
   * 启动三种驱动定时器。`loopRangeMs` 是"这一段还剩多长"（0 = 不循环/无标记段）。
   *
   * adj989（**用户 2026-10-19 实报**「暂停后继续播放位置有点乱」）：这里原来**无条件** `clock().start()`，
   * 而 `Clock.start()` 会把 `base` **清零**；`resume()` 又是"先 `seek(from)` 再 `startTimers`" ⇒
   * 暂停点被抹掉 ✗。后果有两个且都很难看出：
   *  ① 续播后色块/高亮**跳回开头**（但声音是对的，因为音频是另排的）；
   *  ② 更糟：**下一次暂停**取到的是"从续播点算起"的小值 ⇒ 再续播就从错的位置开始 ⇒ 越暂停越乱。
   * ⇒ 改成把"从哪儿起"作为参数传进来：`start()` 之后立刻 `seek(fromMs)`，`base` 才是暂停点。
   */
  const startTimers = (job: { totalMs: number }, loopRangeMs = 0, fromMs = 0) => {
    clearTimers()
    /**
     * adj764：位置推进交给引擎时钟 —— `onTick` 里 `setCurrentMs(ms)`（色块平滑滑动），
     * 原来的 `rafLoop` 递归已删除（那是"自己实现的时钟"）。首次播放 `base = 0`；
     * 续播时靠 `seek(from)` 把 `base` 抬到暂停点（adj989：必须在 `start()` **之后** seek）。
     */
    clock().start()
    if (fromMs > 0) clock().seek(fromMs)
    const computeActive = () => {
      const cur = curMs()
      const ids: string[] = []
      for (const e of seqRef.current?.events ?? []) {
        if (e.atMs <= cur && cur < e.atMs + e.durationMs) {
          ids.push(e.placed.id.page + '_' + e.placed.id.voice + '_' + e.placed.id.group + '_' + e.placed.id.index)
        }
      }
      setActiveNoteIds(ids)
      // adj722：进度读数与色块/高亮**同一时间轴**（`curMs()`），50ms 刷新足够（显示到秒）
      setClockMs(cur)
      // adj285：播放跟随滚动——设当前活动音符 id（首个），使色块/高亮区域保持在视口内
      if (ids.length > 0) setActiveNoteId(ids[0])
    }
    computeActive()
    highlightTimerRef.current = window.setInterval(computeActive, 50)
    /**
     * adj987i（**用户 2026-10-18 实测**：「有选择循环，但实际没有循环播放」）：
     * 这里原来**无条件**设"播完复位"定时器——它到点会 `clearTimers()`，把循环那个"到点重播"定时器
     * 一起清掉（`clearTimers` 会清 `loopTimerRef`）⇒ 循环永远不触发 ✗。
     * ⇒ **循环模式下不设收尾定时器**（这一遍结束时由循环定时器接上）。
     */
    if (!(loopRangeMs > 0 && useUiStore.getState().practiceLoop)) {
      doneTimerRef.current = window.setTimeout(() => {
        doneTimerRef.current = null
        clearTimers()
        clock().cancel()
        setPlaying(false)
        setPaused(false)
        pausedAtRef.current = 0
        clearPlaybackUi()
      }, job.totalMs + 100)
    }
  }

  const stop = () => {
    // adj723d：作废一切在途的 `play()`（含还卡在音源 await 里的那些）
    playGenRef.current.invalidate()
    cancelRef.current?.()
    cancelRef.current = null
    clearTimers()
    backendRef.current?.stop()
    setPlaying(false)
    setPaused(false)
    pausedAtRef.current = 0
    // adj989：段长同时清掉（否则下次"续播"会拿旧段长算剩余，循环会错位）
    practiceRangeMsRef.current = 0
    clock().cancel()
    clearPlaybackUi()
  }

  /**
   * adj409：暂停——记住已播位置、撤掉音频调度（后端用 `setTimeout` 排程，只能"撤掉重排"）、
   * 停住三个驱动定时器；**保持 `playing = true`**（会话未结束：「停止」仍可用、对话框保持停靠）。
   * 界面保留暂停瞬间的高亮与色块（不清空），位置定格在暂停点。
   */
  const pause = () => {
    if (!playing || paused) return
    pausedAtRef.current = Math.max(0, clock().pause())
    cancelRef.current?.()
    cancelRef.current = null
    clearTimers()
    setCurrentMs(pausedAtRef.current)
    setPaused(true)
  }

  /**
   * adj409：续播——把**剩余事件**整体平移到 0 重新调度：
   *  · 已播完的事件丢弃；
   *  · 暂停瞬间正在发声的音符从 0 起重排（时长取它在原时间轴上的**剩余部分**）——
   *    后端没有"从中间起声"的能力，故该音会从头再响一次，这是暂停/续播的已知取舍。
   */
  const resume = () => {
    const seq = seqRef.current
    const backend = backendRef.current
    if (!seq || !backend || !paused) return
    const from = pausedAtRef.current
    // adj409：剩余事件的平移/裁剪收敛在纯函数里（`playbackTimeline.ts`，带 smoke 断言）
    const events = shiftEventsFrom(seq.events, from)
    if (events.length === 0) {
      stop()
      return
    }
    const job = schedulePlay({ events }, backend, undefined, undefined, 0)
    cancelRef.current = job.cancel
    setPaused(false)
    /**
     * adj989：续播要把 `from` 交给 `startTimers`（它负责 `start()` 后 `seek(from)`）——
     * 原来在这里先 `seek(from)` 再 `startTimers(job)`，而 `start()` 会把 `base` 清零 ⇒ 暂停点被抹掉。
     * 循环中续播也要把"这一段还剩多长"传进去，否则续播后循环就不再触发了。
     */
    const total = practiceRangeMsRef.current
    const remainLoop = total > from ? total - from : 0
    startTimers(job, remainLoop, from)
  }

  /** 播放键（开关语义）：未播放 → 播放；播放中 → 暂停；暂停中 → 继续 */
  const onPlayToggle = () => {
    if (starting) return
    if (!playing) {
      void play()
      return
    }
    if (paused) resume()
    else pause()
  }

  const play = async () => {
    stop()
    // adj723d：本代次（`stop()` 已作废旧的，这里取本次播放的身份）
    const gen = playGenRef.current.begin()
    /** 本次播放是否已被更新的一次（或"停止"）取代——**任何 await 之后都要问** */
    const stale = (): boolean => playGenRef.current.isStale(gen)
    // adj409：准备期置位——按钮暂时置灰，避免连点重入（音源加载 + 序列构建要几百毫秒）
    setStarting(true)
    // adj293：整个播放流程包 try/catch——异常不再静默（此前 async 抛错 → 无声无色块）
    try {
      /**
       * adj723c（用户报「播放时 `{dsb}` 那两行完全没有色块」）：
       *
       * **把「序列 / 色块 / 高亮」与「音源」解耦**——原顺序是「先取音源、加载成功才建序列」，
       * 而音源那条链有**三个环境依赖**（IndexedDB 缓存 / 安装目录内置 SF2 / 联网下载）。
       * 任一步失败就 `return` ⇒ `setPlayheadTrack` **永不执行** ⇒ 谱面上一个色块都不出现、
       * 播放位置高亮也全无，用户看到的只是"点了播放但什么都没动"。
       * 实测（Chrome DevTools Protocol 驱动 dev 页面）：`track=0 段 currentMs=0`，而按钮已切到播放态。
       *
       * 现在：**先建序列 → 写字形轨道/高亮 → 再取音源 → 最后调度发声**。
       * 音源失败只降级为「**无声**」：色块与高亮照常走完。
       * （与 `AGENTS` 九/十条同精神：视觉反馈不应成为音频环境的附属。）
       */
      let bankError = ''
      // ---- ① 音源后端实例（不加载音色库）----
      // adj344：固定 SpessaSynth 高保真后端（不再提供合成/midi-js 切换）
      let backend = backendRef.current
      let backendReady = backend !== null && backend.hq
      if (!backendReady) {
        backendRef.current?.dispose()
        backend = new SpessaSynthBackend()
        backendRef.current = backend
        try {
          await (backend as unknown as { ready?: () => Promise<void> }).ready?.()
          // adj723d：等待期间可能已有更新的一次播放（或用户点了停止）⇒ 作废本次
          if (stale()) return
          await new Promise((r) => setTimeout(r, 200))
          if (stale()) return
          backendReady = true
        } catch (e) {
          backendReady = false
          bankError = e instanceof Error ? e.message : String(e)
        }
      }
      // ---- ② 音源字节（失败只置错误文本，**不再 return**）----
      if (backendReady && backend !== null) {
        try {
          // adj1011：取**当前选中的库**（同一个 id 也传给后端，它据此判断要不要重建）
          const hqLib = activeLib.lib
          // adj347：先确保音源就绪（初次自动下载/缓存；已缓存直接读）；点播放不再重复下载
          await ensureBank()
          // adj723d：音源这一步最慢（可能下载 30MB）——等待期间用户完全可能再次 Ctrl+点音符或按停止
          if (stale()) return
          // adj416：取音源字节——缓存优先，其次**安装目录内置 SF2**（桌面直接读文件），最后才是联网下载
          // adj729：嵌入版里最优先取**插件目录**那份（宿主给的 URL；随文库一起走）
          const { bank } = await resolveHqBank(hqLib, hqCache, hostBankUrl(hqLib.id))
          if (stale()) return
          await backend.load(bank, undefined, hqLib.id)
          if (stale()) return
          backend.setVoice(playbackHqVoice)
          setSamplerState('ready')
        } catch (e) {
          backendReady = false
          bankError = e instanceof Error ? e.message : String(e)
          setSamplerState('failed')
        }
      } else {
        setSamplerState('failed')
      }
      // adj723d：音源就绪（或已确认不可得）后再核对一次代次——**只有最新一次播放能落地**
      if (stale()) return
      /**
       * adj987o（**用户 2026-10-18 口径**）：「在起始点处加一个动态 **321** 的倒数数字机制，
       * 在开始或重新循环开始之前进行倒数计数」。
       *
       * 只在**选了标记段**时倒数（全曲播放不倒数——每按一次播就等 3 秒会很烦）。
       * 倒数期间界面在起始音上显示 3→2→1（`practiceCountdown`），音频在这之后才开始。
       */
      const uiNow0 = useUiStore.getState()
      const markNow0 = uiNow0.practiceMarks.find((m) => m.id === uiNow0.practiceMarkId) ?? null
      if (markNow0) await runCountdown3(stale)
      if (!backendReady) {
        /**
         * 音源不可得：**保留视觉**（色块 + 高亮 + 进度读数照常），只是没有声音。
         *
         * adj728（用户要求）：「无法下载音色库的提示显示时间不长，应有个按钮链接用户打开全局的音色库」
         * ⇒ 这条提示**带一个动作按钮**（跳到「设置 → 音色库」去手动导入）。
         * 带按钮的提示在 `ui/Toast.tsx` 里**不自动消失**（几秒读完做不到），用户点按钮后收起。
         */
        showNotice(`音源加载失败，本次试听**无声**（色块与播放位置照常显示）：${bankError}`, 'error', {
          label: '打开音色库',
          run: () => useUiStore.getState().openSettings('soundbank'),
        })
      }
      // 构建序列（含反复展开；adj88：双击谱面音符定位试听起点）
      // adj310：声音/色块统一的准备延迟（毫秒）——按下播放后延迟才出第一声，色块同步
      const PLAY_FIRST_DELAY_MS = 200
      // adj647：与预览共用同一份宿主字体实测 ⇒ 色块位置与预览逐像素一致
      const fm = measureFontMeta(pageConfig)
      const layout = layoutScore(parseResult, pageConfig, defaultInstrumentRef, fm.layout, enabledInstRefs)
      // adj455：选定具体音色 → **全篇统一音色**（含伴奏/第二声部与曲内 `@乐器名@`）；
      // 「自动」时传 undefined，完全按谱面路由。音色名 ref 由 GM 表逆映射得到（与 setVoice 的 program 同源）
      // adj908：末位 = 整份启用音色列表 —— 没写 `Y:` 的声部按序取（各声部音色/色块不再相同）
      const fullSeq = buildPlaySequence(parseResult, layout, bpm, playbackStartId, defaultInstrumentRef, voiceOverrideRef, enabledInstRefs)
      /**
       * adj987（用户 2026-10-18 需求）：选了「练习段」就只播这一段，并按「循环」开关决定是否重复。
       *
       * · 候选（同一对起止在多处）由 `resolvePracticeRange` 给出，用户选过的 `pass` 优先；
       * · 失效（端点音符在本次排版里找不到）⇒ **退回全曲**，并提示一句 —— 不静默播半段。
       */
      const markNow = markNow0
      let seq = fullSeq
      let practiceRangeMs = 0
      /** adj1100：选了练习段 ⇒ 记下"这一段有几遍"（候选个数）；整曲播放 ⇒ null */
      practicePassTotalRef.current = null
      if (markNow) {
        /**
         * adj987（用户 2026-10-18 需求）：选了标记段就只播这一段。
         *
         * **口径变化（用户 2026-10-18 最后确认）**：「如果连音线的判断有难度，可以只考虑附点和增时线就好，
         * 连音线部分可以指定到连音线最后一个主音符，不再自动判断，由用户来判断应该的位置」。
         *
         * ⇒ 不再自动向连音线末尾延长（`extendRangeEndToSlurEnd` 保留在引擎里、有断言，但**界面不再调用**）。
         * 停止音自己的**附点 / 增时线**仍然完整：它们并进了该事件的 `durationMs`，
         * 而 `slicePlaySequenceByRange` 会把它时值窗口内的事件一并纳入。
         * 想连到连音线末尾 ⇒ 把「停止」标在那条线的**最后一个主音**上（界面提示已写明）。
         */
        /**
         * adj991（**用户 2026-10-19 实报**「画线是正确的，但播放不对」）：
         * 画线与播放各算了一套区间 ⇒ 一旦两边的排版参数有差异（试听多传乐器/字体实测），
         * 就可能出现"线画在你标的那几小节、声音却不是那几小节"。
         *
         * ⇒ **所见即所听**：只要画线那套解析记下的**序列长度**与本次序列相同，就直接用它给的 `i0/i1`；
         * 长度不同（极少数排版差异）才退回自己解析。
         */
        let used = false
        /**
         * adj1100：**先解析一次**——「这一段的遍数」要按候选个数算（用户口径：进跳房子 1 ⇒ 只有 1 遍），
         * 不能拿整曲的 `maxPass`（这首有反复 + `&ds` 共 3 遍）。解析结果两条分支共用。
         */
        const res = resolvePracticeRange(fullSeq, markNow.startId, markNow.endId, {
          // adj1102：终点在排版里存在 ⇒ 没有事件是被合并了，按"紧邻的前一个音"配
          endInLayout: hasNoteId(layout, markNow.endId),
        })
        practicePassTotalRef.current = Math.max(1, res.candidates.length)
        const { practiceRangeI0: i0s, practiceRangeI1: i1s, practiceRangeEventCount: nS } = useUiStore.getState()
        if (i0s >= 0 && i1s >= i0s && nS === fullSeq.events.length) {
          const sliced = slicePlaySequenceByRange(fullSeq, i0s, i1s)
          if (sliced) {
            seq = sliced
            practiceRangeMs = sliced.rangeMs
            practiceRangeMsRef.current = practiceRangeMs
            used = true
          }
        }
        if (!used) {
          if (res.candidates.length === 0) {
            showNotice(playbackCopy.practiceMarkInvalid, 'warn')
          } else {
            const idx = Math.min(Math.max(markNow.pass ?? res.pick, 0), res.candidates.length - 1)
            const c = res.candidates[idx]
            const sliced = slicePlaySequenceByRange(fullSeq, c.i0, c.i1)
            if (sliced) {
              seq = sliced
              practiceRangeMs = sliced.rangeMs
              practiceRangeMsRef.current = practiceRangeMs
            }
          }
        }
      }
      setTotalMs(seq.totalMs)
      // adj262：layout 后写入 voiceBlocks（纯曲部 yTop/yBottom）供预览色框覆盖整列
      setVoiceBlocks(
        layout.pages.flatMap((p) =>
          p.voiceBlocks.map((vb) => ({
            x: vb.x,
            yTop: vb.yTop,
            yBottom: vb.yBottom,
            pageIndex: p.index,
            voices: vb.voices.map((v) => v.voice),
          })),
        ),
      )
      // adj282：写入播放轨道（atMs 单调、含反复展开），PreviewPane 跟随色块定位
      // adj299/300：按「拍段」拆分——色块以音符宽度为单位、最大 1 拍（playheadSegs 每段 ≤1 拍）
      const beatMs = 60000 / bpm
      setPlayheadTrack(
        seq.events.flatMap((e) =>
          (e.playheadSegs ?? []).map((s) => ({
            atMs: e.atMs + s.beat * beatMs,
            durationMs: s.beats * beatMs,
            pageIndex: s.pageIndex,
            x: s.x,
            y: s.y,
            width: s.width,
            voice: s.voice,
            group: s.group,
            // adj427：色块按**音色**着色（切换音色时颜色跟着变）
            instrument: s.instrument,
            // adj429：色块按曲行几何动态定界（多声部/临时段不再互相覆盖、不压歌词）
            ...(s.yTopMin !== undefined ? { yTopMin: s.yTopMin } : {}),
            ...(s.yBottomMax !== undefined ? { yBottomMax: s.yBottomMax } : {}),
            // adj432：声部角色（bz upper / dsb upper / dsb lower）→ 预览层颜色区分
            ...(s.playVoice !== undefined ? { playVoice: s.playVoice } : {}),
            // adj451：力度倍率（与音频事件同源）——预留给强弱单/力度记号，先透传备用
            ...(s.gain !== undefined ? { gain: s.gain } : {}),
            // adj1118：间奏块（中性灰）——试听时色块停在 `0` 上也是灰的
            ...(s.interlude === true ? { interlude: true } : {}),
          })),
        ),
      )
      // adj1048：拍网格（跳跳球按拍落，不按音落）
      // adj1061（用户 2026-10-22 实报「反复后球落点漂移」）：`seq.barStartsMs` 现在是
      // **展开后逐遍**的小节起点（含练习段/起点切片的重新基），这里原样写进 store；
      // 锚点也取第一条小节起点（切片落点正好是 0），不再用"第一个事件"兜底。
      setPlayheadBeat(beatMs, seq.barStartsMs?.[0] ?? seq.events[0]?.atMs ?? 0, seq.barStartsMs ?? [])
      // adj258：保存序列 + 启动位置，启动高亮定时器按当前 atMs 设 activeNoteIds
      // adj764：位置一律由引擎时钟管 —— 首次播放从 0 起（`cancel()` 会把时钟置回 0），
      // 起播延迟由下面的音频调度与 `startTimers` 共同体现（旧写法是把 startTime 往后推 200ms）
      seqRef.current = seq
      clock().cancel()
      pausedAtRef.current = 0
      // adj344：高保真音色由 setVoice(GM program) 决定，无需全局乐器覆盖参数（globalInstrument）
      // adj285：不再用 onNote 同步设置 activeNoteId（循环内逐事件 set → 批处理后为最后一事件）
      // adj309：按下播放后延迟 200ms 才出第一声——给听者准备时间 + 让 ctx resume 完成
      // adj723d：**最后一票否决**——就在调度发声之前。多等一步就可能有过期的那次跑完全程，
      // 与最新一次同时 `schedulePlay` ⇒ 用户听到"两个播放进程"（本条规则的由来）。
      if (stale()) return
      // adj723c：音源不可得时**不调度发声**，但仍启动视觉定时器（用 seq 构造一个"空调度" job）——
      // `startTimers` 只依赖 `job.totalMs`（收尾复位），色块/高亮/进度读数因此照常走完。
      const job =
        backendReady && backend !== null
          ? schedulePlay(seq, backend, undefined, undefined, PLAY_FIRST_DELAY_MS)
          : { totalMs: seq.totalMs, cancel: () => {} }
      cancelRef.current = job.cancel
      setPlaying(true)
      setPaused(false)
      setPlayError(null)
      // adj282/adj409：驱动定时器（RAF 色块 + 高亮 + 收尾复位）统一由 startTimers 启停
      startTimers(job, practiceRangeMs)
      /**
       * adj987（**用户 2026-10-18 需求**）：选了标记段且开着「循环」⇒ 到点**自动重播这一段**。
       *
       * 用户追加口径：「每次循环前加一个 **3s 的等待**，一个是**区分出循环位置**，
       * 一个是给用户循环练习时**喘口气**」。
       *
       * ⚠ adj987o：这 3 秒**由倒数接管**（`play()` 一进来就会走 `runCountdown3`：3→2→1 各 1 秒），
       * 所以这里只需要等"这一遍奏完 + 60ms"，**不要再额外加 3 秒**（否则一共要等 6 秒）。
       */
      if (practiceRangeMs > 0 && useUiStore.getState().practiceLoop) {
        loopTimerRef.current = window.setTimeout(
          () => {
            loopTimerRef.current = null
            void play()
          },
          practiceRangeMs + LOOP_RESTART_DELAY_MS,
        )
      }
      // 起点播放后清除标记，下次播放从头开始
      if (playbackStartId) setPlaybackStart(null)
    } catch (e) {
      // adj293：异常显示在对话框（不再静默失败）
      setPlayError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  /**
   * adj723e（用户报「`Ctrl+点击符` 在**底栏未打开**时只打开了试听对话框，没有从该音符播放」）：
   *
   * **根因**：`firstTick` 在**挂载时**就把当前 `playbackTick` 记为基准，而"打开底栏 + 播放"是
   * **同一次 React 渲染**里完成的（`setDockPanel('tryout')` 与 `bumpPlaybackTick()` 同一批），
   * 所以试听面板**挂载时 tick 已经是新值** ⇒ 这个 effect 认为"没有新变化"、直接返回
   * ⇒ 只剩"打开对话框"，不播放。
   *
   * **修法**：把"**挂载时就存在待播起点**（`playbackStartId` 非空）"也当成本次待播。
   * 这样两类情形都正确：
   *  · `Ctrl+点击符`（未开底栏）⇒ 起点已置 ⇒ **挂载即从该音符播放**；
   *  · 用户从顶栏/快捷键**手动打开**试听 ⇒ 起点为空 ⇒ **不自动播放**（保持原设计）。
   * `bumpPlaybackTick` 那条路（底栏已开、或单击/双击音符）照旧。
   */
  const firstTick = useRef(playbackTick)
  /**
   * adj723e：**同一个播放请求只消费一次**。
   *
   * 为什么需要：React 在开发模式（StrictMode）下会**刻意把 effect 跑两遍**（挂载→卸载→再挂载），
   * 实测日志 `[adj723e-debug] … autoplay=true` 连续两条 ⇒ `play()` 被调用两次；
   * 第二次会把第一次作废（代次守卫 `adj723d`）⇒ 用户观感是"打开试听但半天不播"
   * （实际是起了两次、第二次要重新加载音源）。
   *
   * 修法：记住"已经为哪个请求播过了"（`tick`+`起点` 二元组），同一个请求再来就直接跳过。
   * 用**起点也进键**：连续两次点**同一个音符**时 `tick` 会变，仍应重播。
   */
  const lastAutoPlayRef = useRef<string | null>(null)
  useEffect(() => {
    if (!shouldAutoPlay(firstTick.current, playbackTick, playbackStartId)) return
    const key = `${playbackTick}|${playbackStartId ?? ''}`
    if (lastAutoPlayRef.current === key) return
    lastAutoPlayRef.current = key
    firstTick.current = playbackTick
    void play()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackTick, playbackStartId])

  /**
   * adj409/adj723e：播放/暂停后把焦点留在播放按钮上——按钮获得焦点后**空格/回车**即等于再点一次，
   * 于是「按一下空格」就能暂停或恢复，不必去点按钮（用户要求）。
   *
   * adj723e（用户要求「`Ctrl+点击符` / 双击音符 ⇒ 焦点移到播放按钮上」）：**准备期结束后再抢一次**。
   * 为什么需要这一手：一次**双击**必然先触发两轮 `click`（走 `single` 分支的 `jumpCursor`）
   * ⇒ 焦点先落到编辑器 textarea；紧接着自动播放进入"准备中"，若只在 `starting` 置位那一刻聚焦，
   * 会被后面的编辑器聚焦盖掉。改为在 `starting` **由真转假**（准备结束）时再聚焦一次，
   * 保证无论前面发生过多少次抢焦点，最终都停在播放按钮上。
   *
   * 打开对话框本身**不抢焦点**（避免影响谱面/编辑器操作）——这条只在"本次确实开始播放"后生效。
   */
  useEffect(() => {
    if (playing || starting) playBtnRef.current?.focus()
  }, [playing, paused, starting])
  const wasStarting = useRef(false)
  useEffect(() => {
    if (wasStarting.current && !starting) playBtnRef.current?.focus()
    wasStarting.current = starting
  }, [starting])

  return (
    // adj87：试听时保持看谱——背景不遮罩（maskDim=0）、点击遮罩不关闭（仅 ✕ / Esc）
    // adj158/326：宽屏按编辑区方位停靠到左下/右下角（打开即停靠）；窄屏保持原样；用户可拖动自定义位置
    <Modal title="试听播放" maskDim={0} closeOnMaskClick={false} dock={dockPos} compact inline={inline}>
      {/* adj462：**流式布局**（原为「设置框竖排 + 播放/停止上下两行」的弹窗布局，宽度变化不重排、
          在底栏里高度压不下来）。现在：
            · 曲目信息一行；
            · 控制区（播放 / 停止 / 速度 / 音色 / 状态）走 `.dock-fields`（flex-wrap）——
              **宽屏就是整整一行**，窄屏才自动折行；
            · 提示/警告/错误/总时长只有存在时才占一行，同样随宽度折行。
          逻辑（状态机、播放/暂停/续播、音源加载、提示文案）一行未改。 */}
      <div className="playback-panel">
        {/* adj463：一排 = 左「曲目信息 + 设置（速度/音色）」、右「播放/停止」。
            宽屏整条压成**一行**；窄屏自动折行，按钮仍贴右。 */}
        <div className="dock-split">
          <div className="dock-split-main playback-meta">
            {/* adj987e（**用户 2026-10-18 口径**）：标记段组**收起时**，展开按钮挪到**歌名前**——
                否则它自己还要占一整行。展开后这里自动消失（组本身在下方出现）。 */}
            <PracticeMarkExpandButton />
            <span className="playback-title">{header.titles[0] ?? '未命名'}</span>
            {/* adj488：曲目信息里"调式拍号"与"作者"位置对调——作者写在前面更显眼
                （看谱时先想"谁写的"再看"什么调"），调式拍号放进次级灰色行 */}
            {(header.key || header.meter) && (
              <span className="dock-muted playback-key">
                {header.key ? `${header.key}调` : ''}
                {header.meter ? ` ${header.meter}` : ''}
              </span>
            )}
            {header.authors.length > 0 && <span className="dock-muted">{header.authors.join('；')}</span>}

            <label className="dock-field">
              <span className="dock-field-label">速度</span>
              <select className="dock-select" value={bpm} onChange={(e) => setBpm(Number(e.target.value))} disabled={playing}>
                {!BPM_OPTIONS.includes(bpm) && <option value={bpm}>{bpm} 拍/分（按乐谱）</option>}
                {BPM_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {v} 拍/分
                  </option>
                ))}
              </select>
            </label>

            {/* 音色：固定 SpessaSynth 高保真——只列用户启用的收藏音色（adj332/344） */}
            <label className="dock-field">
              <span className="dock-field-label">{playbackCopy.synthLabel}</span>
              <select
                className="dock-select"
                value={playbackHqVoice ?? ''}
                onChange={(e) => setPlaybackHqVoice(e.target.value === '' ? null : Number(e.target.value))}
                disabled={playing}
              >
                {/* adj366：默认项 = 自动（跟随谱面声部/乐器） */}
                <option value="">{playbackCopy.voiceAuto}</option>
                {/* adj1030：选项 = 「音色清单」勾选的 GM 音色 + 「民族乐器（拟）」勾选的名字，
                    按 program 合并去重；民乐名旁标出它落到哪个 GM 音色（`二胡（拟 · 110 民谣提琴）`） */}
                {voiceOptions.map((v) => (
                  <option key={v.program} value={v.program}>{v.label}</option>
                ))}
              </select>
            </label>

            {samplerState === 'loading' && <span className="dock-muted">{playbackCopy.loading}</span>}
            {samplerState === 'failed' && <span className="dock-warn">{playbackCopy.failedFallback}</span>}
          </div>

          {/* 右：操作按钮（adj471：**竖排、靠上固定**，与设置面板右侧按钮列同一习惯；
              左侧曲目信息与设置项流式排列，两者顶部对齐） */}
          <div className="dock-split-actions playback-actions">
            {/* adj170：播放/停止风格一致；adj408：图标用 public/icons/*.png（mask + currentColor）
                adj409：播放键是**开关**——播放中显示「暂停」，暂停后显示「继续」；焦点留在本按钮，
                       空格即可暂停/继续；准备期用 aria-busy（不用 disabled，避免丢焦点） */}
            <button
              ref={playBtnRef}
              className="btn playback-btn"
              onClick={onPlayToggle}
              aria-busy={starting}
              aria-label={playing && !paused ? '暂停' : playing && paused ? '继续播放' : '播放'}
              // adj622（用户要求）：播放按钮加 mnemonics + accessKey="a" 让浏览器原生响应 Alt+A 触发；
              // adj622b（用户口径"按相应热键可操作按钮即可"）：按钮文本里去 `&`，只留 `(A)`——直接告诉
              // 用户这个字母是触发它的快捷键；accessKey 本身保留（按下 Alt+A 直接激活按钮，不走两步）。
              // 同时提示文本加上热键说明，与菜单项 kbd 角标口径一致。
              accessKey="a"
              title={
                starting
                  ? '正在准备音源…（Alt+A 可激活）'
                  : playing && !paused
                    ? '暂停（或按空格 / Alt+A）'
                    : playing && paused
                      ? '继续播放（或按空格 / Alt+A）'
                      : '开始试听（或按空格 / Alt+A）'
              }
              style={{ opacity: starting ? 0.7 : 1, cursor: starting ? 'default' : 'pointer' }}
            >
              <ToolIcon name={playing && !paused ? 'pause' : 'play'} size={14} />
              {/* adj622b：按钮文本按用户口径去 `&`（因为 Chromium 系 accessKey 是 Alt+A 直接触发，
                  不需要"按 Alt 看到下划线再按 A"的两步引导）。两态共用 `(A)`，accessKey 是按钮的属性。 */}
              {starting ? '准备中…' : playing && !paused ? '暂停(A)' : playing && paused ? '继续(A)' : '播放(A)'}
            </button>
            {/* adj622b：停止按钮同款去掉 `&`，accessKey="s" 让 Alt+S 直接激活；
                disabled 时浏览器不响应 accessKey（没在播就别响应停止，符合直觉）。 */}
            <button className="btn playback-btn" onClick={stop} disabled={!playing} accessKey="s" title="停止并回到开头（Alt+S）">
              <ToolIcon name="stop" size={14} />
              停止(S)
            </button>
            {/* 对拍/连续谱已迁到爱出片（iJipu CP），应用内不再提供入口 */}
          </div>
        </div>

        {/* adj987d（**用户 2026-10-18 口径**）：标记段组放在**试听区下方**（曲目信息 + 播放/停止**之上**的
            那一整块之后），不再是"插在信息与按钮中间" */}
        <PracticeMarkBar />

        {/* 提示区：只在确有内容时占行 */}
        {(playbackHqVoice !== null || playbackHqEnabled.length === 0 || downloading || builtinBank || playError || totalMs > 0) && (
          <div className="dock-bar playback-hints">
            {playbackHqVoice !== null && (
              // adj448/adj455：选定具体音色 = **全篇统一音色**；谱面确有 `@` 时再补一句"已被覆盖"
              <span className="dock-muted">
                {playbackCopy.voiceOverrideHint}
                {voiceSwitchCount > 0 && (
                  <span className="dock-warn"> {playbackCopy.voiceOverrideAtHint(voiceSwitchCount)}</span>
                )}
              </span>
            )}
            {playbackHqEnabled.length === 0 && (
              <span className="dock-warn">尚未启用音色——请到「设置 → 音色库」勾选要试听的音色</span>
            )}
            {/* adj347/348：首次自动下载音源（后台进行，仅文字提示） */}
            {downloading && <span className="dock-warn">⏳ 正在后台下载音色库（约30MB，仅首次）…</span>}
            {/* adj416：桌面端随安装包内置音源（安装目录 generaluser_gs.sf2）→ 不提示下载 */}
            {builtinBank && !downloading && <span className="dock-muted">{playbackCopy.builtinBankHint(`${activeLib.lib.id}.sf2`)}</span>}
            {/* adj293：播放异常提示（不再静默失败） */}
            {playError && <span className="dock-error-inline">✗ 播放失败：{playError}</span>}
            {/*
              adj722（用户要求）：**`mm:ss / mm:ss` 进度读数**——播放中显示"已播 / 总长"，
              暂停时停在暂停位置，未播放时显示 `00:00 / 总长`（与旧口径的"总时长 xx.xs"同一位置）。

              `currentMs` 来自 docStore（`adj282` 起由 RAF 每帧刷新，色块与高亮共用它）
              ⇒ 读数与色块/高亮**同一时间轴**，不会出现"读数与色块不同步"。
            */}
            {totalMs > 0 && (
              <span className="dock-muted" title="播放进度 / 总时长">
                {fmtClock(Math.min(clockMs, totalMs))} / {fmtClock(totalMs)}
              </span>
            )}
            {/*
              adj996（**用户 2026-10-19 要求**）：「在试听对话框里加一个**遍次数字**，
              实时显示当前播放在第几个反复遍次上」。
              取引擎 `passMarks` 里"最后一条 start ≤ 当前时刻"的遍号；只有一遍时不显示（免得恒为 1 抢眼）。
            */}
            {totalMs > 0 &&
              (() => {
                const label = passLabel(
                  seqRef.current?.passMarks,
                  Math.min(clockMs, totalMs),
                  // adj1100：选了练习段 ⇒ 用**这一段**的遍数（候选个数）；全曲播放 ⇒ 整曲遍数
                  practicePassTotalRef.current ?? seqRef.current?.maxPass,
                )
                return label ? (
                  <span className="dock-muted playback-pass" title="当前在第几遍反复（共几遍）">
                    {label}
                  </span>
                ) : null
              })()}
          </div>
        )}
      </div>
    </Modal>
  )
}
