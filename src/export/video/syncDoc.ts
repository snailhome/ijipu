/**
 * export/video/syncDoc.ts — 「对拍边车文件」的读写与校验（`赤伶.jps.sync.json`）
 *
 * 用户口径（2026-10-24 拍板）：
 *  · `.jps` **自成一体**（显示/打印/播放/出片都靠它）；伴奏对拍只是**附加** ⇒ 存 sidecar，
 *    与 `.jps` 同目录、文件名 = 原名 + `.sync.json`（不造新扩展名）；
 *  · 伴奏只记**文件名**（"伴奏一般随谱文件"）；不在同目录时记绝对路径；
 *  · `anchors` 是用户打的**原始输入**（含 `locked`）；`tempo`/`segments` 是**解算结果**，
 *    每次保存都重算（机读，不要手改）；
 *  · 谱面 `J:` 一个字不改（sidecar 只提供对齐基准）。
 *
 * 为什么这一层要单独抽：对拍台（写）、相机位（读）、`exportDynamicVideo`（读）、
 * 以后的 CLI `--sync`（读）**必须用同一套解析规则**——容错、版本、夹紧都在这里定义一次，
 * 不许各处 `JSON.parse` 一把梭。
 *
 * 纯函数（无 DOM、无 node:path）：路径拼接是手写的字符串运算，因为渲染进程里没有 `node:path`，
 * 而 Windows 的 `\` 与 `/` 都要认。
 */
import { fitSync, bpmOfFit, effectiveFitOf } from '@ijipu/engine'
import type { SyncAnchor, SyncSegmentStat, SyncTrim } from '@ijipu/engine'
import {
  STRIP_STYLE_KEYS,
  normalizeStripStyle,
  stripThemeOf,
  type StripStyle,
  type StripStyleOverride,
} from './stripTheme'

/** sidecar 后缀：`赤伶.jps` → `赤伶.jps.sync.json` */
export const SYNC_SUFFIX = '.sync.json'

/** 当前格式版本（读到更高的版本 ⇒ 明确报错，不做"猜着读"） */
export const SYNC_VERSION = 1

/** 声音来源与两条音量（"这首歌用伴奏还是合成音"是**这首歌**的决定 ⇒ 存 sidecar） */
export interface SyncMix {
  source: 'file' | 'synth' | 'mix'
  /** 伴奏音量（0~2，缺省 1） */
  accomp: number
  /** 合成音音量（0~2，缺省 0.5） */
  synth: number
  /**
   * adj1264：**视频原声音量**（0~2，缺省 1）。
   *
   * 连续动态谱的"单独音频"是**视频自带音轨**（用户 2026-11-08 口径：没加外部伴奏 ⇒ 用视频的音频）；
   * 它也要有音量，所以与伴奏/合成音并列。旧 sidecar 没有这个字段 ⇒ 按 1 处理（不是 0，
   * 否则老文件一打开就"没声音"）。
   */
  video?: number
}

/**
 * adj1264：连续动态谱台面的外观（**跟着这首歌走** ⇒ 存 sidecar）。
 *
 * 为什么不放 L1：条带位置/主题是"这首曲子配这个背景视频好看"的决定，
 * 换首歌应当各自不同（与卡片模板引用同一层）。
 */
export interface SyncLinear {
  /** 主题 id（`stripTheme.ts` 的四套之一） */
  theme?: string
  /** 谱带纵向位置（0~1，默认 0.25 = 上 1/4） */
  topRatio?: number
  /** 定位色块中心（0.1~0.9，默认 1/3） */
  blockRatio?: number
  /** 谱带缩放（0.3~3，1 = 按字号） */
  bandScale?: number
  /**
   * adj1265（M4 主题编辑器）：**用户改过的那几项配色**。
   *
   * 只记覆盖项（缺省 / 某键不存在 = 跟随主题预设），理由见 `stripTheme.ts`
   * 的 `StripStyleOverride`。`theme` 决定基准，这一份只记"哪几笔不一样"。
   */
  style?: StripStyleOverride
  /** adj1265：出片带片头/片尾卡（默认不带；卡片样式复用 `card.template`） */
  cards?: boolean
}

export interface SyncDoc {
  version: number
  /** 伴奏文件名（相对 `.jps` 所在目录）或绝对路径 */
  audio: string
  audioDurationMs: number
  /** 掐头去尾（文件绝对毫秒） */
  trim: SyncTrim
  /** 用户打的锚点（原始输入） */
  anchors: SyncAnchor[]
  /** 解算结果（anchors < 2 时为 null） */
  tempo: { beatMs: number; offsetMs: number; bpm: number } | null
  /** 段诊断（相邻两锚点；只显示，不参与时间轴） */
  segments: SyncSegmentStat[]
  /** 手选的伴奏调性（只做提示） */
  key?: string
  mix: SyncMix
  /**
   * adj1155（用户 2026-10-25 选方案 B）：**试听练习段列表**。
   *
   * 它本身不是"对拍数据"，但用户要求把"不适合进谱面设置"的东西集中到这份
   * `xxx.jps.sync.json`（跟着谱走、刷新不丢）。字段可选：
   *  · **没有这个字段** = 这份 sidecar 不管理练习段（旧文件，回退 localStorage）；
   *  · **`[]`** = 明确"没有练习段"（用户删光了，必须能持久化删除）。
   */
  marks?: SyncPracticeMark[]
  /** 当前选中的练习段 id（`''` = 无；缺字段 = 不管理） */
  markId?: string
  /**
   * 相机位当前导出的标记段（来自练习段；`null` = 整曲）。
   * 缺字段 = 这份 sidecar 还没管过它。
   */
  range?: SyncRange | null
  /**
   * adj1176（用户 2026-11-01）：**这首歌用哪套卡片模板**。
   *
   * 为什么只记引用、不记样式本体：样式在用户模板库里（L1，公共一份），
   * 这里记全量的话，换首歌就复制一份、背景图还是本机附件引用（换机器打不开），
   * 想统一微调还得逐首改。只记 id ⇒ 换回上一曲能恢复，改模板一处全生效。
   *
   * 缺字段 = 这份 sidecar 还没记过（打开时沿用上次选的模板）。
   */
  card?: SyncCard
  /**
   * adj1264：**背景视频文件名**（只记名字，不复制文件）。
   *
   * 为什么不存路径/不复制文件：视频几十上百 MB，与伴奏同一口径 —— 记名字，
   * 下次打开时提示"上次用的视频：xxx，请重新选择"；换台机器/挪目录也不会写出死路径。
   */
  video?: string
  /** adj1264：连续谱台面的外观（主题/谱带位置/色块位置） */
  linear?: SyncLinear
  /** 存盘时谱面的 FNV-1a 指纹（改了谱 ⇒ 提示"锚点请复核"） */
  codeHash: string
  updatedAt: string
}

/** adj1176：sidecar 里的卡片引用（只存模板 id） */
export interface SyncCard {
  /** 内置模板 id（brand/paper/ink/minimal）或用户模板库里的 id（tpl-…） */
  template: string
}

/** 练习段（与 `store/practiceMarks.ts` 的 `PracticeMark` 结构一致；export 层不反向依赖 store） */
export interface SyncPracticeMark {
  id: string
  name: string
  startId: string
  endId: string
  pass?: number
}

/** 相机位导出的标记段（与 `uiStore.dynamicCamera.range` 结构一致） */
export interface SyncRange {
  startId: string
  endId: string
  pass?: number
}

/** 默认声音设置 */
export const DEFAULT_SYNC_MIX: SyncMix = { source: 'file', accomp: 1, synth: 0.5, video: 1 }

/** `赤伶.jps` → `赤伶.jps.sync.json` */
export function sidecarPathOf(jpsPath: string): string {
  return `${jpsPath}${SYNC_SUFFIX}`
}

/** 这个路径是不是 sidecar（给"打开文件"过滤用） */
export function isSidecarPath(path: string): boolean {
  return path.toLowerCase().endsWith(SYNC_SUFFIX)
}

/** 目录部分（末尾无分隔符；`C:\a\b.jps` → `C:\a`；没有目录 → ''） */
export function dirNameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return i < 0 ? '' : path.slice(0, i)
}

/** 是否绝对路径（Windows 盘符 / UNC / Unix 根） */
export function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path) || path.startsWith('/')
}

/** 拼接（自动识别两边已有的分隔符；`name` 为绝对路径时直接返回它） */
export function joinPath(dir: string, name: string): string {
  if (isAbsolutePath(name)) return name
  if (dir === '') return name
  const sep = dir.includes('\\') ? '\\' : '/'
  const left = dir.endsWith('\\') || dir.endsWith('/') ? dir.slice(0, -1) : dir
  const right = name.startsWith('\\') || name.startsWith('/') ? name.slice(1) : name
  return `${left}${sep}${right}`
}

/** 伴奏的完整路径：绝对路径原样，相对路径拼到 `.jps` 所在目录 */
export function resolveAudioPath(jpsPath: string, audio: string): string {
  return joinPath(dirNameOf(jpsPath), audio)
}

/**
 * adj1157：把选中的伴奏绝对路径写成 sidecar 里的 `audio`。
 *
 *  · 与 `.jps` 同目录（含子目录）⇒ 存**相对路径**（整个文件夹搬走仍能用）；
 *  · 在别处 ⇒ 存**绝对路径**（下次刷新按它自动读）。
 */
export function audioRefOf(audioPath: string, jpsPath: string | null): string {
  if (jpsPath === null || jpsPath === '') return audioPath
  const dir = dirNameOf(jpsPath)
  if (dir === '') return audioPath
  for (const sep of ['\\', '/']) {
    const prefix = `${dir}${sep}`
    if (audioPath.startsWith(prefix)) return audioPath.slice(prefix.length)
  }
  return audioPath
}

/** FNV-1a 32 位（与 `diff/textDiff` 同一族；这里只给 sidecar 做"谱面改过没"的指纹） */
export function codeFingerprint(code: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const clampGain = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(2, Math.max(0, n))
}

const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * 解析 sidecar 文本。
 *
 * **容错原则**：能救的救（缺字段给默认、锚点排序、夹紧裁剪区间），不能救的明确报错
 * （JSON 坏了 / 版本更高 / 没有 `audio` / 锚点不足 2 条只警告不报错——用户可能还没打完）。
 *
 * `tempo`/`segments` **一律重算**（不信文件里的解算结果：手改过 `anchors` 后就该刷新）。
 */
export function parseSyncDoc(text: string): { doc: SyncDoc | null; error?: string; warnings?: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { doc: null, error: '对拍文件不是合法 JSON' }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { doc: null, error: '对拍文件的内容不是对象' }
  }
  const o = raw as Record<string, unknown>
  const version = finiteOr(o.version, SYNC_VERSION)
  if (version > SYNC_VERSION) {
    return { doc: null, error: `对拍文件是更新版本（v${version}）生成的，请升级应用` }
  }
  const audio = typeof o.audio === 'string' ? o.audio.trim() : ''
  /**
   * adj1167：**只有标记段的 sidecar** 也要能读回来。
   *
   * 用户口径：`.jps` 打开时标记段应自动恢复到试听列表；如果 sidecar 里只有
   * `marks`/`markId`/`range`、还没有伴奏（`audio` 为空），旧解析直接报"没有 audio"，
   * 整份文件被丢弃 ⇒ 标记段设置失去意义。
   *
   * 现在：没有 audio 但有 extras ⇒ 允许解析（audio 留空，不参与对拍/伴奏；
   * `syncDocIsUsable` 仍为 false，相机/对拍不会误把它当可用音轨）；
   * 没有 audio 且没有任何 extras ⇒ 仍按旧口径明确报错。
   */
  const cardRaw = o.card
  const hasCardRef =
    cardRaw !== null &&
    typeof cardRaw === 'object' &&
    !Array.isArray(cardRaw) &&
    typeof (cardRaw as Record<string, unknown>).template === 'string' &&
    ((cardRaw as Record<string, unknown>).template as string).trim() !== ''
  const hasExtras =
    Array.isArray(o.marks) ||
    o.range !== undefined ||
    typeof o.markId === 'string' ||
    hasCardRef ||
    // adj1264：只选了背景视频 / 只调了连续谱外观的 sidecar 同样有意义（不必先有伴奏）
    (typeof o.video === 'string' && o.video.trim() !== '') ||
    (o.linear !== null && typeof o.linear === 'object' && !Array.isArray(o.linear))
  if (audio === '' && !hasExtras) return { doc: null, error: '对拍文件里没有记伴奏文件名（audio）' }

  const warnings: string[] = []
  if (audio === '') warnings.push('没有音频（audio 为空）：只恢复标记段，不参与对拍/伴奏')
  const audioDurationMs = Math.max(0, finiteOr(o.audioDurationMs, 0))
  const trimRaw = (o.trim ?? {}) as Record<string, unknown>
  let startMs = Math.max(0, finiteOr(trimRaw.startMs, 0))
  let endMs = finiteOr(trimRaw.endMs, audioDurationMs > 0 ? audioDurationMs : Number.POSITIVE_INFINITY)
  if (audioDurationMs > 0) endMs = Math.min(endMs, audioDurationMs)
  if (endMs <= startMs) {
    warnings.push('裁剪区间无效（结束不晚于开始），已按"不裁剪"处理')
    startMs = 0
    endMs = audioDurationMs > 0 ? audioDurationMs : Number.POSITIVE_INFINITY
  }
  const trim: SyncTrim = { startMs, endMs }

  const anchorsRaw = Array.isArray(o.anchors) ? o.anchors : []
  const anchors: SyncAnchor[] = []
  for (const a of anchorsRaw) {
    if (a === null || typeof a !== 'object') continue
    const r = a as Record<string, unknown>
    const beat = finiteOr(r.beat, Number.NaN)
    const audioMs = finiteOr(r.audioMs, Number.NaN)
    if (!Number.isFinite(beat) || !Number.isFinite(audioMs)) continue
    anchors.push({ beat, audioMs, ...(r.locked === true ? { locked: true } : {}) })
  }
  anchors.sort((a, b) => a.beat - b.beat)
  // 同拍位重复：保留第一条（后面那条没有意义，也不该让 fitSync 返回 null 把整份文件变成"不可用"）
  const uniq: SyncAnchor[] = []
  for (const a of anchors) {
    if (uniq.length > 0 && Math.abs(a.beat - uniq[uniq.length - 1].beat) < 1e-9) {
      warnings.push(`有两条锚点落在同一拍（${a.beat}），已忽略后一条`)
      continue
    }
    uniq.push(a)
  }
  if (uniq.length < 2) warnings.push('锚点不足 2 条：还没法定速度（只调偏移）')

  const fit = fitSync(uniq)
  const tempo = fit === null ? null : {
    beatMs: fit.beatMs,
    offsetMs: fit.offsetMs,
    bpm: bpmOfFit(fit),
  }

  const mixRaw = (o.mix ?? {}) as Record<string, unknown>
  const source = mixRaw.source === 'synth' || mixRaw.source === 'mix' ? mixRaw.source : 'file'
  const mix: SyncMix = {
    source,
    accomp: clampGain(mixRaw.accomp, DEFAULT_SYNC_MIX.accomp),
    synth: clampGain(mixRaw.synth, DEFAULT_SYNC_MIX.synth),
    // adj1264：旧 sidecar 没有 video ⇒ 按 1（不是 0，否则老的连续谱一打开就没声音）
    video: clampGain(mixRaw.video, 1),
  }

  const key = typeof o.key === 'string' && o.key.trim() !== '' ? o.key.trim() : undefined
  /**
   * adj1155：练习段 / 选中段 / 相机导出段（可选字段）。
   *
   * 三种状态必须分清（见 `SyncDoc` 的注释）：
   *  · 字段不存在 ⇒ `undefined`（旧 sidecar：调用方回退 localStorage）；
   *  · 字段存在但为空 ⇒ `[]` / `''` / `null`（用户明确删光/选中"无"/整曲）。
   */
  let marks: SyncPracticeMark[] | undefined
  if (Array.isArray(o.marks)) {
    marks = []
    const seen = new Set<string>()
    for (const v of o.marks) {
      if (v === null || typeof v !== 'object') continue
      const m = v as Record<string, unknown>
      const id = typeof m.id === 'string' ? m.id : ''
      const startId = typeof m.startId === 'string' ? m.startId : ''
      const endId = typeof m.endId === 'string' ? m.endId : ''
      if (id === '' || startId === '' || endId === '' || seen.has(id)) continue
      seen.add(id)
      const pass =
        typeof m.pass === 'number' && Number.isInteger(m.pass) && m.pass >= 0 ? m.pass : undefined
      marks.push({
        id,
        name: typeof m.name === 'string' && m.name !== '' ? m.name : `段 ${marks.length + 1}`,
        startId,
        endId,
        ...(pass !== undefined ? { pass } : {}),
      })
    }
  }
  const markId = typeof o.markId === 'string' ? o.markId : undefined
  let range: SyncRange | null | undefined
  if (o.range === null) {
    range = null
  } else if (o.range !== null && typeof o.range === 'object' && !Array.isArray(o.range)) {
    const r = o.range as Record<string, unknown>
    const startId = typeof r.startId === 'string' ? r.startId : ''
    const endId = typeof r.endId === 'string' ? r.endId : ''
    if (startId !== '' && endId !== '') {
      const pass =
        typeof r.pass === 'number' && Number.isInteger(r.pass) && r.pass >= 0 ? r.pass : undefined
      range = { startId, endId, ...(pass !== undefined ? { pass } : {}) }
    }
  }
  /**
   * adj1176：卡片引用（可选）。空对象/空字符串都当"没记过"——
   * 不能把一个空模板 id 灌回 UI，那会让相机位选中一个不存在的项。
   */
  let card: SyncCard | undefined
  if (hasCardRef) {
    card = { template: ((cardRaw as Record<string, unknown>).template as string).trim() }
  }
  /**
   * adj1264：背景视频名 + 连续谱外观。
   *
   * 两侧都要"能救的救、不能救的丢"：名字只是提示用（文件本身不跟着走），
   * 外观里越界的数值一律夹紧（与 `stripTheme` 同一套范围），不让坏值进渲染。
   */
  const video = typeof o.video === 'string' && o.video.trim() !== '' ? o.video.trim() : undefined
  const linearRaw = o.linear
  let linear: SyncLinear | undefined
  if (linearRaw !== null && typeof linearRaw === 'object' && !Array.isArray(linearRaw)) {
    const l = linearRaw as Record<string, unknown>
    const out: SyncLinear = {}
    if (typeof l.theme === 'string' && l.theme.trim() !== '') out.theme = l.theme.trim()
    const ratio = (v: unknown, lo: number, hi: number): number | undefined => {
      const n = finiteOr(v, Number.NaN)
      return Number.isFinite(n) ? Math.round(Math.min(hi, Math.max(lo, n)) * 1000) / 1000 : undefined
    }
    const topRatio = ratio(l.topRatio, 0, 1)
    const blockRatio = ratio(l.blockRatio, 0.1, 0.9)
    const bandScale = ratio(l.bandScale, 0.3, 3)
    if (topRatio !== undefined) out.topRatio = topRatio
    if (blockRatio !== undefined) out.blockRatio = blockRatio
    if (bandScale !== undefined) out.bandScale = bandScale
    /**
     * adj1265：自定义配色的**逐项钳制**。
     *
     * 只保留"真与预设不同"的项：色串写坏了会被 `normalizeStripStyle` 回退成预设色，
     * 那就等于没改，不写进 sidecar（否则看起来像"用户改过"，其实画出来一模一样）。
     */
    const styleRaw = l.style
    if (styleRaw !== null && typeof styleRaw === 'object' && !Array.isArray(styleRaw)) {
      const sIn = styleRaw as Record<string, unknown>
      const base = stripThemeOf(out.theme)
      const partial: Partial<StripStyle> = {}
      const keys: string[] = []
      for (const k of STRIP_STYLE_KEYS) {
        if (sIn[k] === undefined || sIn[k] === null) continue
        ;(partial as Record<string, unknown>)[k] = sIn[k]
        keys.push(k)
      }
      if (keys.length > 0) {
        const norm = normalizeStripStyle(partial, base)
        const keep: StripStyleOverride = {}
        for (const k of STRIP_STYLE_KEYS) {
          if (!keys.includes(k)) continue
          if (norm[k] !== base[k]) (keep as Record<string, unknown>)[k] = norm[k]
        }
        if (Object.keys(keep).length > 0) out.style = keep
      }
    }
    if (typeof l.cards === 'boolean') out.cards = l.cards
    if (Object.keys(out).length > 0) linear = out
  }
  const doc: SyncDoc = {
    version: SYNC_VERSION,
    audio,
    audioDurationMs,
    trim,
    anchors: uniq,
    tempo,
    segments: fit?.segments ?? [],
    ...(key !== undefined ? { key } : {}),
    mix,
    ...(marks !== undefined ? { marks } : {}),
    ...(markId !== undefined ? { markId } : {}),
    ...(range !== undefined ? { range } : {}),
    ...(card !== undefined ? { card } : {}),
    ...(video !== undefined ? { video } : {}),
    ...(linear !== undefined ? { linear } : {}),
    codeHash: typeof o.codeHash === 'string' ? o.codeHash : '',
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : new Date().toISOString(),
  }
  return { doc, ...(warnings.length > 0 ? { warnings } : {}) }
}

/** 序列化（2 空格缩进、末尾一个换行；与 `.jps` 同规矩：UTF-8 无 BOM、LF） */
export function serializeSyncDoc(doc: SyncDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** 由"用户输入"生成一份完整 doc（`tempo`/`segments` 现算） */
export function makeSyncDoc(input: {
  audio: string
  audioDurationMs: number
  trim?: SyncTrim
  anchors: SyncAnchor[]
  key?: string
  mix?: SyncMix
  /** adj1155：练习段/选中段/相机导出段（缺省 = 不写这些字段，保持旧文件形状） */
  marks?: SyncPracticeMark[]
  markId?: string
  range?: SyncRange | null
  /** adj1176：这首歌用的卡片模板（缺省 = 不写，保持旧文件形状） */
  card?: SyncCard
  /** adj1264：背景视频名（缺省 = 不写） */
  video?: string
  /** adj1264：连续谱台面外观（缺省 = 不写） */
  linear?: SyncLinear
  code: string
  now?: string
}): SyncDoc {
  const trim = input.trim ?? {
    startMs: 0,
    endMs: input.audioDurationMs > 0 ? input.audioDurationMs : 0,
  }
  const fit = fitSync(input.anchors)
  return {
    version: SYNC_VERSION,
    audio: input.audio,
    audioDurationMs: input.audioDurationMs,
    trim,
    anchors: [...input.anchors].sort((a, b) => a.beat - b.beat),
    tempo: fit === null ? null : { beatMs: fit.beatMs, offsetMs: fit.offsetMs, bpm: bpmOfFit(fit) },
    segments: fit?.segments ?? [],
    ...(input.key !== undefined && input.key !== '' ? { key: input.key } : {}),
    mix: input.mix ?? DEFAULT_SYNC_MIX,
    ...(input.marks !== undefined ? { marks: input.marks } : {}),
    ...(input.markId !== undefined ? { markId: input.markId } : {}),
    ...(input.range !== undefined ? { range: input.range } : {}),
    ...(input.card !== undefined ? { card: input.card } : {}),
    ...(input.video !== undefined && input.video !== '' ? { video: input.video } : {}),
    ...(input.linear !== undefined ? { linear: input.linear } : {}),
    codeHash: codeFingerprint(input.code),
    updatedAt: input.now ?? new Date().toISOString(),
  }
}

/** 能不能拿去出片（要有音频 + 至少 2 条锚点解出拍速） */
export function syncDocIsUsable(doc: SyncDoc | null | undefined): doc is SyncDoc & { tempo: { beatMs: number; offsetMs: number; bpm: number } } {
  return doc !== null && doc !== undefined && doc.tempo !== null && doc.audio !== ''
}

/**
 * adj1128：混音三档 → "这次到底放哪几条轨"。
 *
 * 用户 2026-10-24 实报「选合成音还是伴奏、选伴奏+合成也是伴奏」——根因是台面试听
 * **根本没看这个设置**（直接放了伴奏）。抽成纯函数后，台面试听与相机位/出片共用一张表，
 * 且能在 Node 里断言（改坏了立刻红灯）。
 */
export function mixPlanOf(mix: SyncMix): { playAcc: boolean; playSynth: boolean } {
  return {
    playAcc: mix.source !== 'synth',
    playSynth: mix.source !== 'file',
  }
}

/**
 * adj1153：**有效拟合（含 0 锚点的默认对齐）**——相机位、出片、台面共用。
 *
 * 用户 2026-10-25 确认：**0 条锚点时，保留段起点 = 谱面第 1 拍**。
 * 所以默认偏移不是 0，而是 `trim.startMs`（保留段从哪开始，谱面就从哪开始）。
 *
 *  | 锚点数 | 拍速 | 偏移 |
 *  |---|---|---|
 *  | 0 | 谱面 `J:`（`scoreBeatMs`） | **`trim.startMs`**（默认对齐） |
 *  | 1 | 谱面 `J:`（`effectiveFitOf`） | 由这条锚点解 |
 *  | 2+ | `fitSync` 最小二乘 | 由锚点解 |
 *
 * 返回 `null` 只代表"没有对拍文档"（`doc === null`）；有文档就一定有可用拟合。
 */
export interface EffectiveSyncFit {
  beatMs: number
  offsetMs: number
}

export function effectiveSyncFitOf(doc: SyncDoc | null, scoreBeatMs: number): EffectiveSyncFit | null {
  if (doc === null || !(scoreBeatMs > 0)) return null
  const fit = doc.tempo ?? effectiveFitOf(doc.anchors, scoreBeatMs)
  if (fit !== null) return { beatMs: fit.beatMs, offsetMs: fit.offsetMs }
  // 0 条锚点：保留段起点 = 谱面第 1 拍
  return { beatMs: scoreBeatMs, offsetMs: Math.max(0, doc.trim.startMs) }
}

/**
 * adj1151（用户 2026-10-25：「设了保留段，播放应该从保留段开头开始，别从音频 0 开始 /
 * 只播放保留段」）：把播放起点**夹进保留段**。
 *
 *  - 起点在保留段之前 ⇒ 从保留段开头播；
 *  - 起点已经到/过了保留段末尾 ⇒ 从头再播一遍保留段（否则按播放只会"停在末尾什么都不发生"）；
 *  - 在段内 ⇒ 从当前位置继续。
 *
 * 纯函数（Node 可断言）。末尾留 1ms 的旧口径保留在半开区间判断里。
 */
export function playStartMsOf(fromMs: number, trim: SyncTrim): number {
  const start = Math.max(0, trim.startMs)
  const end = Math.max(start, trim.endMs)
  if (fromMs <= start) return start
  if (fromMs >= end - 1) return start
  return fromMs
}

/** 谱面改过没有（codeHash 不同 ⇒ 相机位要提示"锚点请复核"） */
export function syncDocStale(doc: SyncDoc | null | undefined, code: string): boolean {
  if (!doc) return false
  if (doc.codeHash === '') return false
  return doc.codeHash !== codeFingerprint(code)
}
