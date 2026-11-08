/**
 * store/syncStore.ts — 「对拍」的**内存状态**（sidecar 的副本 + 当前伴奏 AudioBuffer）
 *
 * 为什么单独一个 store 而不是塞进 `uiStore`：
 *  · `uiStore` 是"界面偏好"（模态、缩放、主题…），对拍是**一份文档级数据**（跟 `.jps` 走）；
 *  · 这里还握着几十 MB 的 `AudioBuffer`（不能进 localStorage、不能进 React 状态树）；
 *  · 相机位（读）与对拍台（写）都要订阅同一份，**以 `rev` 作为"变了没"的信号**。
 *
 * 持久化分层（用户 2026-10-24 定）：
 *  · 正式落点是**同目录 sidecar** `赤伶.jps.sync.json`（写盘要 Rust 命令，下一步接）；
 *  · 在 Rust 接上之前，先用 L1（`ijipu.mvSync.last`）兜住"关掉重开还能接着调"，
 *    并在键里带 `fileName`——换一份谱就不会错用别的谱的锚点；
 *  · 伴奏本身**不持久化**（同目录文件，重开时按名字找；找不到就提示重选）。
 */
import { create } from 'zustand'
import type { SyncAnchor, SyncTrim } from '@ijipu/engine'
import { fitSync, bpmOfFit } from '@ijipu/engine'
import {
  DEFAULT_SYNC_MIX,
  makeSyncDoc,
  parseSyncDoc,
  serializeSyncDoc,
  type SyncCard,
  type SyncDoc,
  type SyncLinear,
  type SyncMix,
  type SyncPracticeMark,
  type SyncRange,
} from '../export/video/syncDoc'

/** L1 兜底键（Rust sidecar 读写接上后仍保留：先把"临时状态"救回来用） */
export const SYNC_L1_KEY = 'ijipu.mvSync.last'

/** 重算 `tempo`/`segments`（不改 codeHash/时间戳——那是"保存"才做的事） */
function recompute(doc: SyncDoc): SyncDoc {
  const fit = fitSync(doc.anchors)
  return {
    ...doc,
    tempo: fit === null ? null : { beatMs: fit.beatMs, offsetMs: fit.offsetMs, bpm: bpmOfFit(fit) },
    segments: fit?.segments ?? [],
  }
}

interface SyncState {
  /** 当前谱的对拍文档（`null` = 还没建过） */
  doc: SyncDoc | null
  /** 解码好的伴奏（内存；`null` = 还没选/重开未选） */
  audio: AudioBuffer | null
  /** 变化计数（相机位据此重建会话/作废音轨） */
  rev: number
  /** 打开对拍台时调用：先恢复 L1 里同名谱的副本（伴奏仍需重选）；没有就新建一份空的 */
  ensureFor: (fileName: string, code: string) => void
  /**
   * adj1128：用**磁盘上的 sidecar** 整个替换内存副本。
   * 打开台面时会先读同目录的 `.jps.sync.json`（比 L1 兜底更权威）。
   */
  replaceDoc: (doc: SyncDoc) => void
  setAudio: (name: string, buf: AudioBuffer | null) => void
  /**
   * adj1150：相机位「加载伴奏…」用——只换内存里的 AudioBuffer，**保留 sidecar 的保留段**
   * （`setAudio` 会把 `trim.endMs` 拉到整段，那是"换了一首伴奏"的口径，这里不能那么做）。
   */
  setAudioBuffer: (buf: AudioBuffer) => void
  /**
   * adj1264：连续动态谱台面导入背景视频后，把**视频时长**当主时间轴长度写进 doc。
   *
   * 只在没有外部伴奏时调用（有伴奏时伴奏长度才是权威）；保留段的终点会被夹到新长度，
   * 起点保留（用户可能已经从某处起拍）。
   */
  setMediaDuration: (ms: number) => void
  addAnchor: (a: SyncAnchor) => void
  updateAnchor: (i: number, patch: Partial<SyncAnchor>) => void
  removeAnchor: (i: number) => void
  setTrim: (t: SyncTrim) => void
  setMix: (m: Partial<SyncMix>) => void
  /**
   * adj1155：把**练习段/选中段/相机导出段**写进同一份 sidecar doc。
   * 只更新内存并 `rev+1`；落盘由自动保存（或手动保存）统一做。
   */
  setExtras: (patch: {
    marks?: SyncPracticeMark[]
    markId?: string
    range?: SyncRange | null
    /** adj1176：这首歌用的卡片模板（只记 id） */
    card?: SyncCard
    /** adj1264：背景视频名（只记名字，不复制文件） */
    video?: string
    /** adj1264：连续谱台面外观（主题/谱带位置/色块位置/缩放） */
    linear?: SyncLinear
  }) => void
  setKey: (k: string) => void
  setAudioName: (n: string) => void
  /** 保存：刷新 codeHash/时间戳 → 写 L1（sidecar 写盘下一步接） */
  save: (code: string, fileName: string) => void
  /** adj1155：换文件时清掉内存 doc/audio（**不删 L1**，与 `clear` 区分） */
  resetDoc: () => void
  clear: () => void
}

export const useSyncStore = create<SyncState>((set, get) => ({
  doc: null,
  audio: null,
  rev: 0,

  ensureFor: (fileName, code) => {
    // 同一份谱已经在编辑：不要覆盖（否则关掉台面再打开会丢掉未保存的改动）
    if (get().doc !== null) return
    try {
      const raw = localStorage.getItem(SYNC_L1_KEY)
      if (raw !== null) {
        const parsed = JSON.parse(raw) as { fileName?: unknown; doc?: unknown }
        if (typeof parsed.fileName === 'string' && parsed.fileName === fileName) {
          const r = parseSyncDoc(JSON.stringify(parsed.doc))
          if (r.doc !== null) {
            set({ doc: recompute(r.doc), rev: get().rev + 1 })
            return
          }
        }
      }
    } catch {
      /* L1 坏了就当没有（不阻塞打开台面） */
    }
    set({
      doc: makeSyncDoc({ audio: '', audioDurationMs: 0, anchors: [], code }),
      rev: get().rev + 1,
    })
  },

  replaceDoc: (doc) => {
    set({ doc: recompute(doc), rev: get().rev + 1 })
  },

  setAudio: (name, buf) => {
    const cur = get().doc
    if (cur === null) return
    const next: SyncDoc = {
      ...cur,
      audio: name,
      audioDurationMs: buf ? Math.round(buf.duration * 1000) : cur.audioDurationMs,
      // 换了伴奏：原来的裁剪区间按新长度夹紧（不改锚点——锚点是文件绝对时刻，用户自己调）
      trim: buf
        ? { startMs: Math.min(cur.trim.startMs, Math.round(buf.duration * 1000)), endMs: Math.round(buf.duration * 1000) }
        : cur.trim,
    }
    set({ doc: recompute(next), audio: buf, rev: get().rev + 1 })
  },

  setAudioBuffer: (buf) => {
    const cur = get().doc
    if (cur === null) return
    const dur = Math.round(buf.duration * 1000)
    // 只把保留段的**终点**夹到新长度内，起点与终点都保留（sidecar 里的裁剪是用户的决定）
    const end = cur.trim.endMs > 0 ? Math.min(cur.trim.endMs, dur) : dur
    const start = Math.min(cur.trim.startMs, end)
    set({
      audio: buf,
      doc: { ...cur, audioDurationMs: dur, trim: { startMs: start, endMs: end } },
      rev: get().rev + 1,
    })
  },

  setMediaDuration: (ms) => {
    const cur = get().doc
    if (cur === null) return
    const dur = Math.max(0, Math.round(ms))
    if (dur === cur.audioDurationMs) return
    const end = dur > 0 ? Math.min(cur.trim.endMs > 0 ? cur.trim.endMs : dur, dur) : cur.trim.endMs
    const start = Math.min(cur.trim.startMs, end)
    set({ doc: { ...cur, audioDurationMs: dur, trim: { startMs: start, endMs: end } }, rev: get().rev + 1 })
  },

  addAnchor: (a) => {
    const cur = get().doc
    if (cur === null) return
    const sorted = [...cur.anchors, a].sort((x, y) => x.beat - y.beat)
    set({ doc: recompute({ ...cur, anchors: sorted }), rev: get().rev + 1 })
  },

  updateAnchor: (i, patch) => {
    const cur = get().doc
    if (cur === null) return
    const anchors = cur.anchors.map((a, k) => (k === i ? { ...a, ...patch } : a))
    set({ doc: recompute({ ...cur, anchors }), rev: get().rev + 1 })
  },

  removeAnchor: (i) => {
    const cur = get().doc
    if (cur === null) return
    set({
      doc: recompute({ ...cur, anchors: cur.anchors.filter((_, k) => k !== i) }),
      rev: get().rev + 1,
    })
  },

  setTrim: (t) => {
    const cur = get().doc
    if (cur === null) return
    const end = cur.audioDurationMs > 0 ? Math.min(t.endMs, cur.audioDurationMs) : t.endMs
    const start = Math.max(0, Math.min(t.startMs, end))
    set({ doc: { ...cur, trim: { startMs: start, endMs: end } }, rev: get().rev + 1 })
  },

  setMix: (m) => {
    const cur = get().doc
    if (cur === null) return
    set({ doc: { ...cur, mix: { ...cur.mix, ...m } }, rev: get().rev + 1 })
  },

  setExtras: (patch) => {
    const cur = get().doc
    if (cur === null) return
    set({
      doc: {
        ...cur,
        ...(patch.marks !== undefined ? { marks: patch.marks } : {}),
        ...(patch.markId !== undefined ? { markId: patch.markId } : {}),
        ...(patch.range !== undefined ? { range: patch.range } : {}),
        ...(patch.card !== undefined ? { card: patch.card } : {}),
        ...(patch.video !== undefined ? { video: patch.video } : {}),
        ...(patch.linear !== undefined ? { linear: patch.linear } : {}),
      },
      rev: get().rev + 1,
    })
  },

  setKey: (k) => {
    const cur = get().doc
    if (cur === null) return
    set({ doc: { ...cur, key: k.trim() === '' ? undefined : k.trim() }, rev: get().rev + 1 })
  },

  setAudioName: (n) => {
    const cur = get().doc
    if (cur === null) return
    set({ doc: { ...cur, audio: n }, rev: get().rev + 1 })
  },

  save: (code, fileName) => {
    const cur = get().doc
    if (cur === null) return
    const doc = makeSyncDoc({
      audio: cur.audio,
      audioDurationMs: cur.audioDurationMs,
      trim: cur.trim,
      anchors: cur.anchors,
      ...(cur.key !== undefined ? { key: cur.key } : {}),
      mix: cur.mix,
      // adj1155：练习段/选中段/相机导出段跟着 sidecar 一起存（"没有这个字段"要保持没有）
      ...(cur.marks !== undefined ? { marks: cur.marks } : {}),
      ...(cur.markId !== undefined ? { markId: cur.markId } : {}),
      ...(cur.range !== undefined ? { range: cur.range } : {}),
      // adj1176：卡片模板引用跟着 sidecar 一起存（每首谱记住自己那套）
      ...(cur.card !== undefined ? { card: cur.card } : {}),
      // adj1264：背景视频名与连续谱外观（只记名字/数值，文件不复制）
      ...(cur.video !== undefined ? { video: cur.video } : {}),
      ...(cur.linear !== undefined ? { linear: cur.linear } : {}),
      code,
    })
    set({ doc, rev: get().rev + 1 })
    try {
      localStorage.setItem(SYNC_L1_KEY, JSON.stringify({ fileName, doc: JSON.parse(serializeSyncDoc(doc)) }))
    } catch {
      /* 配额满/隐私模式：保存失败不影响本次对拍 */
    }
  },

  resetDoc: () => {
    // adj1155：换文件时只清内存（L1 留给"打开台面时按文件名恢复"）
    set({ doc: null, audio: null, rev: get().rev + 1 })
  },

  clear: () => {
    set({ doc: null, audio: null, rev: get().rev + 1 })
    try {
      localStorage.removeItem(SYNC_L1_KEY)
    } catch {
      /* 忽略 */
    }
  },
}))

/**
 * 相机位/导出用的"有效拍速"：有可用的 sidecar 才返回，否则 `null`（用谱面 `J:`） */
export function effectiveSyncBpm(doc: SyncDoc | null): number | null {
  if (doc === null || doc.tempo === null || doc.audio === '') return null
  return 60000 / doc.tempo.beatMs
}

export { DEFAULT_SYNC_MIX }
