/**
 * store/syncExtras.ts — 把「练习段 / 选中段 / 相机导出段」与 `.jps.sync.json` 绑在一起（adj1155）
 *
 * 用户 2026-10-25 选方案 B：`.sync.json` 不只放对拍，也放"这首歌的附属设置"——
 *  · 练习段列表（`marks`）+ 当前选中（`markId`）—— 试听栏里增删/选择时保存；
 *  · 相机位当前导出的标记段（`range`）—— 从练习段导出时保存；
 *  · `mix`（声音档 + 两条音量）本来就在 sidecar 里，这里补上**自动保存**。
 *
 * 为什么需要这一层：
 *  · 之前只有对拍台的「保存」按钮写盘；相机改音量、试听加段都只改内存 ⇒ 刷新回默认；
 *  · 这里统一「**改动 → 防抖写 sidecar**」，并负责打开文件时把 sidecar 里的 extras 灌回 UI。
 *
 * 边界：自动保存**只在桌面壳**真正落盘（`sync_write_file`）；网页/开发浏览器仍只写 L1
 * （`ijipu.mvSync.last`），不反复触发下载。
 */
import { useEffect } from 'react'
import type { SyncDoc } from '../export/video/syncDoc'
import { serializeSyncDoc } from '../export/video/syncDoc'
import { hasCardStyle } from '../export/video/cardTemplates'
import { syncCopy } from '../brand/copy'
import { useDocStore, type WorkspaceBinding } from './docStore'
import { useSyncStore } from './syncStore'
import { useUiStore } from './uiStore'
import { docKeyOf } from './practiceMarks'
import { resolveSidecarPath, loadSidecarFor } from './syncSidecar'
import { writeSidecarText } from '../export/video/syncIo'
import { setSyncDocOwner, syncDocOwnerOf } from './syncOwner'

/** 自动保存防抖（ms）——混音滑杆会连续触发，拖完再写一次 */
const SAVE_DEBOUNCE_MS = 600

/** 当前文件身份（与练习段 localStorage 同一口径；换文件/换目录都能分开） */
function identityOf(d: { fileName: string; nativePath: string | null; binding: WorkspaceBinding | null }): string {
  return docKeyOf(d)
}

/** 这份内存 doc 是从哪个文件加载的：owner 状态在 `syncOwner.ts`（避免 docStore ↔ 本模块成环） */
/** 是否允许自动保存（打开文件、读 sidecar 期间先关，防止把空状态写出去） */
let saveEnabled = false
/** 加载期间发生过的改动（读完后补写一次，别让"刚打开就加段"丢掉） */
let pendingWhileDisabled = false
/** 抑制计数（加载 sidecar 回灌 UI 时不要反过来触发保存） */
let suppressDepth = 0
let timer: ReturnType<typeof setTimeout> | null = null
/** 这次待保存对应的文件身份（flush 时若已切文件就放弃，避免写错文件） */
let pendingIdentity = ''
let warnedWriteFailed = false

/**
 * 把 sidecar 里保存的 extras 灌回 UI（0/1/2+ 锚点与它无关，只处理这三样）。
 *
 * 语义（与 `SyncDoc` 的可选字段一一对应）：
 *  · `marks === undefined` ⇒ 旧文件，不碰练习段（调用方回退 localStorage）；
 *  · `marks === []` ⇒ 用户删光了，明确清空；
 *  · `range === null` ⇒ 整曲。
 */
export function applySyncExtrasToUi(doc: SyncDoc): void {
  const ui = useUiStore.getState()
  if (doc.marks !== undefined) {
    ui.setPracticeMarks(doc.marks)
    const keep =
      doc.markId !== undefined && doc.marks.some((m) => m.id === doc.markId) ? doc.markId : ''
    ui.setPracticeMarkId(keep)
  }
  if (doc.range !== undefined) ui.setDynamicCamera({ range: doc.range })
  /**
   * adj1176（用户 2026-11-01「换个曲子就变风格，换回来却不会恢复」）：
   * sidecar 里记了这套谱用的卡片模板，打开时切回去。
   *
   * 本机没有这套模板（别人发来的谱 / 模板删了）⇒ **不要**灌一个不存在的 id，
   * 保持当前模板并明确提示一句，用户重新导入模板 zip 即可。
   */
  if (doc.card !== undefined) {
    if (hasCardStyle(doc.card.template, ui.cardTemplates)) {
      ui.setDynamicCardStyle(doc.card.template)
    } else {
      ui.showNotice(syncCopy.cardTemplateMissing(doc.card.template), 'warn')
    }
  }
}

/** 当前 UI 里的 extras（写进 sidecar 用） */
export function currentSyncExtras(): {
  marks?: SyncDoc['marks']
  markId?: string
  range?: SyncDoc['range']
  card?: SyncDoc['card']
} {
  const ui = useUiStore.getState()
  return {
    marks: ui.practiceMarks,
    markId: ui.practiceMarkId,
    range: ui.dynamicCamera.range,
    card: { template: ui.dynamicCardStyle },
  }
}

/**
 * adj1176：用户改了卡片模板 ⇒ 记到**这首歌**的 sidecar 里（没 sidecar 就先建一份）。
 *
 * 为什么不放在"应用打开的瞬间"：那样只是打开相机位就会把上次的模板盖到这首歌头上；
 * 这里只在**用户真的选了模板**时调用（相机位下拉 / 模板对话框保存）。
 * 值没变就直接返回，避免和 sidecar 回灌互相触发。
 */
export function recordCardTemplate(templateId: string): void {
  const st = useSyncStore.getState()
  if (st.doc !== null && st.doc.card?.template === templateId) return
  const ds = useDocStore.getState()
  if (st.doc === null) st.ensureFor(ds.fileName, ds.code)
  const cur = useSyncStore.getState()
  if (cur.doc === null) return
  // 相机位比 App 的 sidecar 钩子更早动起来时，owner 可能还没登记；补一次，否则自动保存会放弃
  if (syncDocOwnerOf() === '') setSyncDocOwner(identityOf(ds))
  cur.setExtras({ card: { template: templateId } })
}

/** 包一层"别触发自动保存"（加载 sidecar 回灌 UI 时用） */
export function suppressSyncAutoSave<T>(fn: () => T): T {
  suppressDepth += 1
  try {
    return fn()
  } finally {
    suppressDepth = Math.max(0, suppressDepth - 1)
  }
}

function scheduleSave(delay = SAVE_DEBOUNCE_MS): void {
  if (suppressDepth > 0) return
  const d = useDocStore.getState()
  if (useSyncStore.getState().doc === null) return
  pendingIdentity = identityOf(d)
  if (!saveEnabled) {
    // 读 sidecar 期间先记下；读完后由 enableAutoSave 补写，别把"刚打开就加段"丢掉
    pendingWhileDisabled = true
    return
  }
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void flushSidecarSave()
  }, delay)
}

function disableAutoSave(): void {
  saveEnabled = false
  if (timer !== null) clearTimeout(timer)
  timer = null
}

function enableAutoSave(): void {
  saveEnabled = true
  if (!pendingWhileDisabled) return
  pendingWhileDisabled = false
  scheduleSave(0)
}

/**
 * 立刻写一次 sidecar（试听里**添加/删除练习段**时调用，用户口径"这时保存"）。
 * 返回 Promise 便于测试/调用方不关心也行。
 */
export async function flushSyncAutoSave(): Promise<void> {
  if (suppressDepth > 0) return
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  await flushSidecarSave()
}

async function flushSidecarSave(): Promise<void> {
  if (!saveEnabled || suppressDepth > 0) return
  const ds = useDocStore.getState()
  const identity = identityOf(ds)
  // 已经切到别的文件：放弃这次写入（宁可丢一次自动保存，也不能把旧谱写进新谱的 sidecar）
  if (pendingIdentity !== '' && pendingIdentity !== identity) return
  if (syncDocOwnerOf() !== identity) return
  const st = useSyncStore.getState()
  if (st.doc === null) return

  // 先 save：刷 codeHash/updatedAt、写 L1；suppress 防它自己的 doc 变更再触发一轮
  suppressSyncAutoSave(() => st.save(ds.code, ds.fileName))
  const latest = useSyncStore.getState().doc
  if (latest === null) return
  // 没有伴奏时也可以只为 marks/range/card 写 sidecar（adj1167：打开 .jps 要恢复标记段；
  // adj1176：只记了卡片模板的 sidecar 同样有意义；三者都没有的空文件没有意义，不写）
  if (
    latest.audio === '' &&
    latest.marks === undefined &&
    latest.range === undefined &&
    latest.card === undefined
  ) {
    return
  }

  const target = await resolveSidecarPath(ds.nativePath, ds.binding)
  if (target === null) return // 网页/没有磁盘落点：L1 已写，别反复下载
  const r = await writeSidecarText(target, serializeSyncDoc(latest))
  if (!r.ok && !warnedWriteFailed) {
    warnedWriteFailed = true
    useUiStore.getState().showNotice(syncCopy.saveFailed(r.error), 'warn')
  }
}

/** 开始监听（App 挂载时调用一次；返回清理函数） */
export function startSyncAutoSave(): () => void {
  const unsub = useSyncStore.subscribe((s, prev) => {
    if (s.doc !== prev.doc) scheduleSave()
  })
  return () => {
    unsub()
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
}

/**
 * App 级同步桥：
 *  ① 打开文件/切文件时读同目录 sidecar（**Sidecar 是 extras 的权威来源**）；
 *  ② 把 marks/markId/range 灌回 uiStore（`mix` 等由 doc 本身带回来）；
 *  ③ 读期间关自动保存，读完再开，避免"空 marks 把盘上的段删了"。
 */
export function useSyncSidecarExtras(): void {
  const fileName = useDocStore((s) => s.fileName)
  const nativePath = useDocStore((s) => s.nativePath)
  const binding = useDocStore((s) => s.binding)
  const key = identityOf({ fileName, nativePath, binding })

  useEffect(() => startSyncAutoSave(), [])

  useEffect(() => {
    let cancelled = false
    disableAutoSave()
    pendingWhileDisabled = false
    if (pendingIdentity !== '' && pendingIdentity !== key) {
      // 切文件前的最后一次改动已经来不及写；清掉挂起标记，别再串到新文件
      if (timer !== null) clearTimeout(timer)
      timer = null
      pendingIdentity = ''
    }
    void (async () => {
      // 内存里的 doc 属于别的文件（上一个谱）⇒ 清掉，避免把它的音量/锚点写进新 sidecar
      const owner = syncDocOwnerOf()
      if (owner !== '' && owner !== key) {
        suppressSyncAutoSave(() => useSyncStore.getState().resetDoc())
      }
      const d = await loadSidecarFor(nativePath, binding)
      if (cancelled) return
      suppressSyncAutoSave(() => {
        const cur = useSyncStore.getState().doc
        if (d !== null && cur === null) useSyncStore.getState().replaceDoc(d)
        if (d !== null) applySyncExtrasToUi(d)
        setSyncDocOwner(key)
      })
      enableAutoSave()
    })()
    return () => {
      cancelled = true
      disableAutoSave()
    }
  }, [key, nativePath, binding])
}

/** 仅测试/调试用：当前内存 doc 的 owner（不参与 UI） */
export function syncDocOwnerForTest(): string {
  return syncDocOwnerOf()
}
