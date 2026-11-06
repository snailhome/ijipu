/**
 * store/docStore.ts — 文档状态（zustand）
 * 数据流：code → parse（同步）→ parseResult；layout/render 由渲染管线消费。
 */
import './localStorageMigration'
import { create } from 'zustand'
import { parseJps, defaultPageConfig, applyFontOverride, mergeJpsConfig, mergeConfigEdits, writeJpsConfig, layoutScore, renderScoreToSvg, localAssetRefs } from '@ijipu/engine'
import type { PageConfig, ParseResult } from '@ijipu/engine'
// adj647：宿主字体实测（打印与预览共用同一份；见 preview/fontMeta.ts）
import { measureFontMeta } from '../preview/fontMeta'
import { defaultSample } from '../samples'
import {
  recordEdit,
  undoHistory,
  redoHistory,
  DEFAULT_HISTORY_LIMIT,
  type HistoryEntry,
  type HistoryState,
} from '../editor/history'
import { saveFileHandle, loadFileHandle } from './fileHandleDb'
// adj969：文件方式打开的谱 ⇒ 相对路径的图要靠"额外授权一次所在文件夹"（见该模块文件头）
import { askAssetDirOnOpen, askSensitiveDirOnNativeOpen, refOfFile, type AssetFileRef } from './assetDirAuth'
import {
  classifySaveError,
  createSavePhaseLog,
  fileBaseName,
  fileInputAccept,
  isUserCancel,
  saveTextToHandle,
  shouldUseFileInputPicker,
  type SavePhaseLog,
} from './saveSupport'
// adj954：设备判据迁到品牌层唯一出处（原在 store/saveSupport.ts）
import { isCoarsePointerDevice, isTauriShell, getRuntimeEnv } from '../brand/env'
// adj966：文件宿主能力与降级决策（纯函数；"要不要引导持久权限"也在这里判）
import { hostProfile, shouldGuidePersistPermission, type PermState } from './fileHost'
import { useUiStore, enabledVoicesOf } from './uiStore'
// adj724b：`shouldYieldBindingRestore` 用于"给宿主的 openFile 让路"（见文件末尾）
import { isHostEmbedded, shouldYieldBindingRestore } from './hostBridge'
import { loadFontOverride, migrateLegacyEditorPrefs, hasShownPermGuide, markPermGuideShown } from './editorPrefs'
import { normalizePastedSource } from './importSource'
// adj538：桌面壳的「外部打开」（双击 .jps）——纯网页下这些函数一律惰性/空转，见该模块注释
import { pickPrimary, pickJpsFile, readNativeProbe, saveJpsFileNative, writeExternalFile, type ExternalFile } from './externalOpen'
// adj1158：另存为成功后把内存 sync doc「接管」到新路径（不清掉锚点/音量）
import { adoptSyncDocOwner } from './syncOwner'
// adj540：工作区目录（Android/移动端"选一个文件夹当工作区"，纯网页，不需要壳）
import {
  createFile,
  createSubdir,
  getWorkspace,
  hasEntry,
  isValidEntryName,
  isWorkspaceAvailable,
  isPathWorkspace,
  joinPath,
  moveFile,
  normalizeRelPath,
  queryWorkspacePermission,
  readWorkspaceText,
  rememberWorkspacePath,
  removeEmptyDir,
  removeFile,
  renameFile,
  writeWorkspaceText,
} from './workspace'

/** adj200：用户是否已主导过文件状态（新建/打开/保存/另存为）。「启动恢复」异步读 IndexedDB，
 *  必须只在用户还未进行任何文件操作时应用，避免它在用户新建/另存为之后才完成，从而把
 *  fileHandle / fileName 覆盖回旧文件（旧值 A）。 */
let fileStateTouched = false
import { uiCopy, savePhaseCopy, pasteImportCopy, externalOpenCopy, workspaceCopy, exportCopy, persistPermissionCopy, dropOpenCopy } from '../brand/copy'
// adj927：外部改动的**基准**（我们最后一次写出去/读进来的内容指纹 + mtime）——见 externalChange.ts
// adj943：写盘**发出前**还要登记"在途写"（写盘落地与基准刷新之间有窗口，见该文件头说明）
import { baselineKeyOf, bindingKeyOf, setBaseline, markWriteInFlight } from './externalChange'
// adj965（方案 OVL，EP-10）：打印页也要带水印/背景层 —— 与预览/导出共用同一份资源
import { withOverlay } from './overlayAssets'
// adj615：打印（菜单「打印」/ Ctrl+P）——浏览器侧原语在 export/print.ts，页面在这里现算
import { installPrintHooks, printPages } from '../export/print'
import { printFileNameOfResult } from '../export/printName'
// adj615：与预览/导出面板同一个"默认音色"口径（只用到 `gmVoiceRef`，不拉进合成器实现，故不增包体）
import { firstEnabledInstrumentRef } from '../playback/spessaSynthBackend'

export type ViewType = 'code' | 'split' | 'splitH' | 'splitHE' | 'preview'

/**
 * adj615（用户要求：菜单「打印」+ `Ctrl+P`）：**当前文档的打印页**（每页一段 SVG）。
 *
 * 与导出面板同一口径（`ExportPanel.getPages`）：
 *  · 用**引擎现算**的布局与渲染，与当前视图无关（纯代码视图下也能打印，不必先切到预览）；
 *  · **有语法错误就返回空**（宁可什么都不打，也别打出半张谱——调用方负责提示）。
 */
function currentPrintPages(s: DocState): string[] {
  if (s.parseResult.errors.some((e) => e.severity === 'error')) return []
  const instrumentRef = firstEnabledInstrumentRef(enabledVoicesOf(useUiStore.getState()))
  // adj647：打印与预览共用同一份宿主实测（否则打印出来的角标间距/占宽与预览不一致）
  const fm = measureFontMeta(s.pageConfig)
  // adj965（方案 OVL，EP-10）：打印与预览/导出**共用同一份**水印/背景资源
  return renderScoreToSvg(layoutScore(s.parseResult, s.pageConfig, instrumentRef, fm.layout), withOverlay(fm.render))
}

/**
 * adj626（用户要求）：**打印 / 另存 PDF 的默认文件名** = **第一个描述头 `B:` 的值**（标题）。
 *
 * 浏览器与桌面壳都拿 `document.title` 当"另存为 PDF"的默认文件名，所以打印期由
 * `export/print.ts` 临时改标题、`afterprint` 还原；这里只负责**算出那个名字**
 * （没有 `B:` 时退回文件名，规则与用例见 `export/printName.ts`）。
 */
function currentPrintTitle(s: DocState): string {
  return printFileNameOfResult(s.parseResult, s.fileName)
}

interface DocState {
  code: string
  fileName: string
  /** 是否未保存（本地草稿对比） */
  dirty: boolean
  viewType: ViewType
  /** 自动格式化（输入防抖后格式化） */
  autoFormat: boolean
  pageConfig: PageConfig
  parseResult: ParseResult
  /** 编辑器光标（行/列，1-based 行，0-based 列） */
  cursor: { line: number; col: number }
  /** 编辑器选区（0-based，历史记录与恢复用） */
  sel: { start: number; end: number }
  /** 当前高亮音符 id（notepos 契约），编辑器↔谱面联动 */
  activeNoteId: string | null
  /** adj258：播放高亮——同一组多声部同时演奏的音符 id 列表，预览区同时高亮 */
  activeNoteIds: string[]
  /** adj263：播放当前 ms（PlaybackDialog RAF 驱动），PreviewPane 用其渲染平滑移动的整列竖向色框 */
  currentMs: number
  /** adj282：播放轨道（事件 atMs 单调，含反复展开），PreviewPane 跟随色块定位用。
   *  adj299：group 唯一标识曲行（多声部 Q1 与单声部行可共用 voice 号，必须用 group 定位）；
   *  adj427：色块改为**按音色（instrument）着色**——不同音色不同颜色，播放中切换音色能看到变色；
   *  voice 保留用于「主声部保持既有红色」的判定
   *  adj429：`yTopMin` / `yBottomMax` = 色块按曲行几何动态定界的上下绝对 y（多声部/临时段自动避开重叠、压歌词）
   *  adj432：`playVoice` = 段内声部角色（bz upper = 'accomp' / dsb upper = 'main' / dsb lower = 'second'）→ 预览层颜色区分
   *  adj451：`gain` = 该拍段所属事件的**力度倍率**（与音频事件同源，缺省 1）——目前由 adj427 写入
   *  （重叠伴奏/第二声部 0.75），**预留给强弱单（渐强/渐弱）与力度记号**：后续算出逐音力度后，
   *  音频与色块轨道自动同步，无需再改数据结构 */
  playheadTrack: { atMs: number; durationMs: number; pageIndex: number; x: number; y: number; width: number; voice: number; group: number; instrument?: string; yTopMin?: number; yBottomMax?: number; playVoice?: 'accomp' | 'main' | 'second'; gain?: number; interlude?: boolean }[]
  /**
   * adj1048：试听「拍网格」——跳跳球要按**拍**落，不能按音落（一拍可能有两个八分音符）。
   * `playheadBeatMs` = 一拍多少毫秒；`playheadAnchorMs` = 第一拍对应的时刻。
   */
  playheadBeatMs: number
  playheadAnchorMs: number
  /** adj1058/adj1061：小节起点时刻（**展开后逐遍、逐 Q 行**；末尾一条是「曲末」，球自由落体的时刻） */
  playheadBarStartsMs: number[]
  /** adj262：多声部 voiceBlocks（纯曲部 yTop/yBottom/x）——播放时渲染竖向色框覆盖整列 */
  voiceBlocks: { x: number; yTop: number; yBottom: number; pageIndex: number; voices: number[] }[]
  /** adj291：布局后的「全局音符 index → 物理页 page」映射（自动分页一致）——光标联动定位音符 id.page */
  noteIndexToPage: Map<number, number> | null
  /** 编辑器光标跳转请求（点击谱面音符 / 撤销重做恢复选区时触发） */
  cursorJump: { start: number; end: number; nonce: number } | null

  /** 撤销历史（栈顶 = 最近一步） */
  undoStack: HistoryEntry[]
  /** 重做历史 */
  redoStack: HistoryEntry[]
  /** 历史合并时间戳（内部） */
  lastEditAt: number
  /** 历史步数上限（默认 50） */
  historyLimit: number

  setCode: (code: string) => void
  setViewType: (v: ViewType) => void
  setAutoFormat: (b: boolean) => void
  /**
   * 更新页面设置；persist=true 时同时写回源码 # jps-config（谱面级持久化，adj83；默认差量写入）。
   * adj454：`base` = 本次编辑**开始前**的生效配置快照（对话框打开时 / 虚线按下时）——
   * 传了它就只把「用户本次真正改动」的字段写进谱面（本机缓存来源的值不再被固化）；
   * 不传则退回旧行为（写回整份生效配置的差量）。
   */
  setPageConfig: (cfg: PageConfig, persist?: boolean, base?: PageConfig) => void
  setCursor: (line: number, col: number) => void
  setSelection: (start: number, end: number) => void
  setActiveNoteId: (id: string | null) => void
  /** adj258：设置预览区同时高亮的音符 id 列表（多声部同步演奏） */
  setActiveNoteIds: (ids: string[]) => void
  /** adj262：设置多声部 voiceBlocks（layout 后由 PlaybackDialog 写入） */
  setVoiceBlocks: (vbs: { x: number; yTop: number; yBottom: number; pageIndex: number; voices: number[] }[]) => void
  /** adj291：设置布局后的音符 index→页映射（PreviewPane 布局后回填，EditorPane 光标联动用） */
  setNoteIndexToPage: (m: Map<number, number> | null) => void
  /** adj282：设置播放轨道（PlaybackDialog 播放时写入、停止时清空） */
  setPlayheadTrack: (t: { atMs: number; durationMs: number; pageIndex: number; x: number; y: number; width: number; voice: number; group: number }[]) => void
  /** adj263：设置播放当前 ms（RAF 驱动，PreviewPane 渲染平滑色框） */
  setCurrentMs: (ms: number) => void
  /** adj1048：拍网格（跳跳球按拍落，不按音落） */
  setPlayheadBeat: (beatMs: number, anchorMs: number, barStartsMs?: number[]) => void
  jumpCursor: (pos: number, end?: number) => void
  undo: () => void
  redo: () => void
  /** 载入线上示例/乐谱（列表与源码由 `samples/online.ts` 从官网获取） */
  loadSample: (code: string, name: string) => void
  newDoc: () => void
  /**
   * adj963（**用户要求：规范新建/保存的行为**）：把"按运行环境选哪条保存路"收进 store **一处**。
   *
   * 为什么必须收口：改造前"模式判定"散在 `TopBar` 的 `runSaveSmart`，而 `App` 的 **Ctrl+S 直接调
   * `saveFile()`**（绕过判定）⇒ 插件里对未绑定文档按 Ctrl+S 会走 `saveFileAs()` →
   * 跨源子框架弹系统选择器必然被拒（`SecurityError`）。菜单与快捷键**两条入口两套判定**，
   * 就是"必然漂"的老毛病（同 adj960 的 `%FILE%`）。现在菜单/快捷键都只调这三个动作。
   */
  requestNewDoc: () => void
  requestSave: () => Promise<void>
  requestSaveAs: () => Promise<void>
  markSaved: () => void
  /** adj406：粘贴源码导入（返回 false = 内容为空、未替换） */
  importSource: (raw: string) => boolean
  /**
   * adj615（用户要求）：**打印当前谱面**——菜单「打印」与 `Ctrl+P` 共用。
   * 与导出同一口径：有语法错误就提示并**不打**（别打出半张谱）。
   */
  printScore: () => void
  /**
   * adj615：注册 `beforeprint` / `afterprint`（**幂等**，`App` 挂载时一次）——
   * 兜住"平台自己弹打印对话框"那条路（那时代码里谁都跑不到，只有 `beforeprint` 会触发）。
   */
  installPrintSupport: () => void

  // ---- 文件读写（adj70：Web File System Access API 打开/保存对话框） ----
  /** 当前已打开文件的句柄（null = 未关联磁盘文件） */
  fileHandle: FileSystemFileHandle | null
  /**
   * adj538：当前文档的**外部路径**（双击 `.jps` / 文件关联打开时由桌面壳给出；浏览器里恒为 null）。
   * 它与 `fileHandle` 是同一件事的两种来源，故**互斥**：设了 nativePath 就清掉 fileHandle，反之亦然。
   * 只存内存、不持久化——重启后原文件可能已被移走/改名，静默写回旧路径比重开一次更危险。
   */
  nativePath: string | null
  /**
   * adj540 / adj544：当前文档**绑定在哪个工作区的哪个文件**上。
   *
   * adj544 的关键修正：绑定必须带**工作区身份**（`wsId`）。此前只存相对路径，
   * 于是"换了工作区后按保存"会拿**新根句柄 + 旧相对路径**去写——没同名就新建、有同名就覆盖，
   * **静默写错文件**（用户以为存回了原文件）。详见 E-2026-251 与 `saveFile` 的三道校验。
   *
   * 与 `fileHandle` / `nativePath` 是"同一个文档存在哪"的三种来源，**三者互斥**。
   * adj544：现在会随草稿**持久化**（`ijipu.draftSrc`），重启后能"想起这份代码来自哪个文件"，
   * 但恢复出来的是**待校验绑定**（`pendingBinding`）——权限与文件存在性核对通过后才真正生效。
   */
  binding: WorkspaceBinding | null
  /**
   * adj544：从草稿恢复出来的绑定（**尚未校验**：权限可能未授予、文件可能已被移走）。
   * 校验通过后由 `resolvePendingBinding` 转成正式 `binding`；否则只用于提示"这份谱来自哪里"。
   */
  pendingBinding: WorkspaceBinding | null
  /**
   * adj540：从工作区打开一个 `.jps`（`path` 含子目录，最后一段是文件名）。
   * 读失败/无工作区时给提示并返回 false。
   */
  openWorkspaceFile: (path: string[]) => Promise<boolean>
  /**
   * adj540：把当前谱**另存到工作区**的指定位置（`path` 最后一段是文件名，缺失的子目录会创建）。
   * 写入后回读校验；成功即把本文档与该路径绑定（后续「保存」写回它）。
   * 若目标位置**已有同名文件且它不是本文档当前绑定的那个** ⇒ 拒绝并提示（不静默覆盖别人的谱）。
   */
  saveToWorkspace: (path: string[]) => Promise<boolean>
  /** adj540：在工作区里新建子目录 */
  createWorkspaceDir: (dirPath: string[], name: string) => Promise<boolean>
  /** adj540：重命名工作区里的 `.jps`（同目录换名；当前文档绑定会跟着改）。一次只改一个。 */
  renameWorkspaceFile: (dirPath: string[], fromName: string, toName: string) => Promise<boolean>
  /**
   * adj540：把若干个 `.jps` 移到另一个目录（列表支持**多选**）。当前文档绑定会跟着改。
   * 目录不在支持范围（递归搬运风险大）——调用方只传文件路径。
   */
  moveWorkspaceFiles: (fromSegsList: string[][], toDirSegs: string[]) => Promise<boolean>
  /**
   * adj540：删除若干个条目（文件 / **空**目录，支持多选）。
   * 逐个执行并汇总结果：全成功给"已删除 N 项"，部分失败如实报出失败项与原因（不假装全成功）。
   */
  deleteWorkspaceEntries: (items: { segs: string[]; kind: 'file' | 'dir' }[]) => Promise<boolean>
  /**
   * adj540：在工作区里**新建一份空谱**（内容取「新建」模板 `src/samples/未命名.jps`）并打开它。
   * 手机上"新建一份谱"最自然的落点就是工作区当前目录——不用先去系统文件选择器里找地方。
   * 同名已存在 ⇒ 拒绝并提示（不覆盖已有谱）。
   */
  newWorkspaceScore: (segs: string[]) => Promise<boolean>
  /**
   * adj538：载入桌面壳送来的外部文件（双击打开）。
   * 取第一个载入编辑器；返回是否载入成功（读失败时给提示并返回 false）。
   */
  openExternalFiles: (files: ExternalFile[]) => boolean
  /** 打开文件对话框：读取 .jps 载入；用户取消返回 false */
  openFile: () => Promise<boolean>
  /**
   * adj968（用户要求）：**把拖进来的 `.jps` 载入编辑器**（`store/dropOpen.ts` 调它）。
   *
   * 两种输入都接（拖放的两种能力档）：
   *  · `handle` 有值（Chromium 的 `getAsFileSystemHandle()`）⇒ 与「打开」同一档：**绑定句柄、能写回、能轮询**；
   *  · 只有 `file`（Firefox/Safari，或浏览器不给句柄）⇒ 与「打开=上传」同一档：读入内容、**不绑定**（走草稿）。
   * 当前文档**有未保存修改时先问一句**（拖入是替换文档的动作，与「新建」同一套确认条）——绝不静默丢编辑。
   */
  openDropped: (input: { handle: FileSystemFileHandle | null; file: File | null }) => Promise<boolean>
  /** 保存：已有句柄直接写入；否则走另存为对话框 */
  saveFile: () => Promise<boolean>
  /** 另存为对话框：选择保存位置与文件名后写入 */
  saveFileAs: () => Promise<boolean>
  /**
   * adj966f（P1 块级采纳 + P2 自动三路合并，用户 2026-10-16 口径③④）：**应用合并结果**。
   *
   * 差异框底部「应用（并保存）」按下时调它（`merged` 由 `diff/merge.ts` 的 `applyMerge` 算出）。
   * 一趟做完四件事，顺序是刻意的：
   *  ① **备份两侧**（本地那份 + 外部那份，各写一份 L1 键）——护栏"两侧都不丢"；
   *  ② `setCode(merged)` ⇒ **一步历史**（可撤销）+ 解析器重算（**体检**：有问题直接进问题面板）；
   *  ③ **立刻写回同一个文件**（`saveFile`）⇒ 写前登记在途写、写后刷基准（口径④）；
   *  ④ 基准刷新后状态自然从 `bound-conflict` 回到"已保存"（`fileHost.docStateOf`）。
   */
  applyMergeResult: (merged: string, externalText: string) => void
}

/** 本地草稿（localStorage，自动保存） */
const DRAFT_KEY = 'ijipu.draft'
const DRAFT_NAME_KEY = 'ijipu.draftName'
/**
 * adj544：草稿的**来源绑定**（`{wsId, wsName, segs}` 或 null）——"这份代码是从哪个工作区的哪个文件来的"。
 * 与草稿一起写/读，重启后能恢复（校验通过前只是 `pendingBinding`）。属于 L3 会话态，不是设置项。
 */
const DRAFT_SRC_KEY = 'ijipu.draftSrc'
/**
 * adj985（**用户 2026-10-18 实报**）：草稿的**原生路径**（桌面壳双击 / 关联打开时那份文件的绝对路径）。
 *
 * 症状：「桌面壳，在桌面已加入到工作区的情况下，**双击 `.jps`** 打开有背景；**直接开桌面壳**
 * （上次关掉时还是这份谱）**没有背景**」。
 *
 * 根因：双击走 `openExternalFiles` ⇒ 记下 `nativePath` ⇒ `App.tsx` 用它推出
 * `{kind:'native', dir}` 基准、背景图读取正常 ✓；而"直接开壳"是**恢复落盘草稿**，
 * 只恢复了 `code` / `name` / 工作区绑定（`DRAFT_SRC_KEY`），**没恢复 `nativePath`** ⇒
 * 基准退化成 `none` ⇒ 相对路径的背景图/水印图读不出来 ✗。
 *
 * ⇒ 与草稿一起写/读（L3 会话态，不是设置项）。恢复后它仍是"上次那份文件在哪"，
 * 由 `App.tsx` 的基准判定照旧使用（图片读取失败时按既有口径降级提示，不会报错）。
 */
const DRAFT_NATIVE_KEY = 'ijipu.draftNative'
const PAGE_CONFIG_KEY = 'ijipu.pageConfig'
/**
 * adj966f（护栏①：**两侧都不丢**）：应用冲突合并前，把"本地那份"与"外部那份"各留一份备份。
 *
 * 为什么用 localStorage 而不是内存：合并**紧接着就写盘**了，用户若事后发现合错了，
 * 需要的是"当时那两份原文"，而内存里那份会被后续编辑覆盖。谱面文本量级很小（几十 KB），
 * 用 L1 机器级缓存足够；键停在 `ijipu.` 前缀下（`docs/SETTINGS-AUDIT.md` 的口径）。
 */
const MERGE_BACKUP_LOCAL_KEY = 'ijipu.mergeBackupLocal'
const MERGE_BACKUP_EXTERNAL_KEY = 'ijipu.mergeBackupExternal'
/** 备份里同时记下"什么时候、哪份文件"——排错时能对上（纯文本，不参与判据） */
const MERGE_BACKUP_AT_KEY = 'ijipu.mergeBackupAt'

/** adj544：文档在工作区里的绑定（身份 + 相对路径） */
export interface WorkspaceBinding {
  /** 工作区身份（`WorkspaceRecord.id`）——保存前必须与当前工作区比对 */
  wsId: string
  /** 工作区名（`handle.name`），仅用于提示文案 */
  wsName: string
  /** 区内相对路径（最后一段是文件名） */
  segs: string[]
}

function loadDraft(): { code: string; name: string; src: WorkspaceBinding | null; nativePath: string | null } | null {
  try {
    const code = localStorage.getItem(DRAFT_KEY)
    if (code === null) return null
    const name = localStorage.getItem(DRAFT_NAME_KEY) ?? '未命名'
    return { code, name, src: loadDraftSrc(), nativePath: loadDraftNative() }
  } catch {
    return null
  }
}

/** adj985：读草稿的原生路径（缺失/损坏 → null，绝不抛） */
function loadDraftNative(): string | null {
  try {
    const v = localStorage.getItem(DRAFT_NATIVE_KEY)
    return v && v.trim() !== '' ? v : null
  } catch {
    return null
  }
}

/** adj985：写草稿的原生路径（null = 清除；存储不可用时静默） */
function saveDraftNative(p: string | null): void {
  try {
    if (!p) localStorage.removeItem(DRAFT_NATIVE_KEY)
    else localStorage.setItem(DRAFT_NATIVE_KEY, p)
  } catch {
    /* 忽略 */
  }
}

/** 读草稿的来源绑定（损坏/缺失 → null，绝不抛） */
function loadDraftSrc(): WorkspaceBinding | null {
  try {
    const raw = localStorage.getItem(DRAFT_SRC_KEY)
    if (!raw) return null
    const o = JSON.parse(raw) as Partial<WorkspaceBinding>
    if (!o || typeof o.wsId !== 'string' || !Array.isArray(o.segs) || o.segs.length === 0) return null
    return { wsId: o.wsId, wsName: typeof o.wsName === 'string' ? o.wsName : '', segs: o.segs.map(String) }
  } catch {
    return null
  }
}

/** 写草稿的来源绑定（null = 清除；存储不可用时静默） */
function saveDraftSrc(b: WorkspaceBinding | null): void {
  try {
    if (!b) localStorage.removeItem(DRAFT_SRC_KEY)
    else localStorage.setItem(DRAFT_SRC_KEY, JSON.stringify(b))
  } catch {
    /* 忽略 */
  }
}

/**
 * adj480 一次性迁移：删除旧版的「本机页面设置」缓存层。
 *
 * 背景（用户确认的目标）：`.jps` 应当**自包含**——"我把源码复制给别人，别人看到的效果一样"。
 * 旧版把"本机页面设置"存在 `localStorage`，并套用到**未自带该设置**的谱面；而 `setPageConfig`
 * 无论是否持久化都会把**整份生效配置**写回缓存（对话框实时预览、取消回写快照都算）⇒ 这一层
 * 实际是"上一份谱的整份配置"，于是"你看到的"取决于本机历史，复制给他人必然不一致。
 *
 * 现在生效配置只有两层：**代码默认值 ← 谱面 `# jps-config`**（新建文档从 adj214 起本就不吃缓存，
 * 故去掉这一层几乎没有便利性损失）。这里只做：删键 + 若旧值与默认不同则提示一次
 * （不静默吞掉用户的历史设置而不告知）。
 */
function migrateLegacyPageConfig(): void {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(PAGE_CONFIG_KEY)
    if (raw === null) return
    localStorage.removeItem(PAGE_CONFIG_KEY)
  } catch {
    return
  }
  let diffCount = 0
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const def = defaultPageConfig as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(parsed)) {
      if (k in def && JSON.stringify(def[k]) !== JSON.stringify(v)) diffCount++
    }
  } catch {
    /* 坏值：只删键 */
  }
  if (diffCount > 0) {
    useUiStore
      .getState()
      .showNotice(
        `已停用「本机页面设置」缓存（原 ${diffCount} 项非默认值）：版面设置现在只认谱面自带的 # jps-config，源码没写的项按默认值渲染——这样把谱复制给别人显示才一致`,
        'warn',
      )
  }
}

/**
 * 解析**生效配置**（分层见 docs/SETTINGS-AUDIT.md）：
 *   L0 引擎默认 < L2 谱面源码 # jps-config
 * 之后再叠加 L1 的「用我的字体覆盖谱面字体」（默认关，跨机缺字体时用；它**不随谱走**，
 * 会让"我看到的字体"与别人不同，故只作本机回退）。
 *
 * adj480：**不再有"本机页面设置"这一层**——谱面自包含是分享保真的前提（见 migrateLegacyPageConfig）。
 *
 * 顺带做一次性迁移：早期版本把编辑器偏好写进了谱面（`# jps-config` 里的 editorFont/editorFontSize），
 * 首次解析时搬到本机 L1 偏好（仅当本机从未设置过）；此后任何保存都会以差量写入自动清除它们。
 */
function resolveConfig(code: string): PageConfig {
  if (code) {
    migrateLegacyEditorPrefs(code, (p) => {
      const ui = useUiStore.getState()
      if (p.font) ui.setEditorFont(p.font)
      if (typeof p.fontSize === 'number') ui.setEditorFontSize(p.fontSize)
    })
  }
  return applyFontOverride(mergeJpsConfig(code, null), loadFontOverride())
}
migrateLegacyPageConfig()
const draft = loadDraft()

/**
 * adj724b：**嵌入版「即时保存」**。
 *
 * 用户口径（实测反馈 #5）：「嵌入版的保存即时保存到 jps 文件中，**不使用缓存保存方式**，
 * 但**修改历史还要有**」。
 *
 * 于是分成两件事，各归其位：
 *  · **撤销/重做历史** —— 仍由 `history.ts` 的 `recordEdit` 维护（`setCode` 里那段），完全不动；
 *  · **落盘** —— 编辑后直接把内容写回**文库里的那个 `.jps`**，与 `saveFile()` 走**同一个原语**
 *    （`writeWorkspaceText`，宿主侧写完**回读校验**，不一致会报错，不谎报已保存）。
 *
 * 两点取舍（都写在注释里，免得后人"优化"掉）：
 *  ① **仍然保留 localStorage 草稿**：它只用于"重新打开应用时恢复"，不参与嵌入版的正确性；
 *  ② **做了一个 400ms 的合并窗口**：嵌入版每次按键都过 `postMessage` 往返宿主，
 *     逐键写文件既浪费又会让宿主的 `vault` 频繁触发 modify 事件（每个事件都会让
 *     Obsidian 的其它视图跟着重渲染）。合并窗口只影响"写盘节奏"，不影响历史。
 */
const EMBED_AUTOSAVE_DEBOUNCE_MS = 400
let embedAutosaveTimer = 0
/** 正在进行的自动保存（避免与用户手动 Ctrl+S 同时写同一个文件） */
let embedAutosaveInFlight: Promise<void> | null = null

/** 是否处于"嵌入版 + 已绑定工作区文件"（= 应当即时保存）的状态 */
function embedInstantSaveReady(): boolean {
  if (!isHostEmbedded()) return false
  const bind = useDocStore.getState().binding
  return !!bind && bind.segs.length > 0
}

/**
 * 排一次即时保存（合并窗口内多次编辑只写一次）。
 * 只做写入；失败**不弹窗**（编辑过程中弹窗太吵），只在控制台留痕。
 */
function scheduleEmbedAutosave(): void {
  if (!embedInstantSaveReady()) return
  if (embedAutosaveTimer !== 0) window.clearTimeout(embedAutosaveTimer)
  embedAutosaveTimer = window.setTimeout(() => {
    embedAutosaveTimer = 0
    void runEmbedAutosave()
  }, EMBED_AUTOSAVE_DEBOUNCE_MS)
}

async function runEmbedAutosave(): Promise<void> {
  if (!embedInstantSaveReady()) return
  // 上一次还没写完 ⇒ 等它写完再排一次（不丢最后一次编辑）
  if (embedAutosaveInFlight) {
    await embedAutosaveInFlight
    scheduleEmbedAutosave()
    return
  }
  const task = (async () => {
    const bind = useDocStore.getState().binding
    if (!bind || bind.segs.length === 0) return
    const ws = await getWorkspace()
    if (!ws) return
    // adj544 的同一道校验：绑定里的工作区身份必须与当前工作区一致，否则绝不写盘
    if (ws.id !== bind.wsId) return
    const code = useDocStore.getState().code
    try {
      // adj943：**写盘发出前**先登记"在途写"——宿主在 `adapter.write` 落地时就广播 `fileChanged`，
      // 事件可能早于下面这次 await 的结算；不登记的话，事件读到的正是我们刚写下去的内容，
      // 而基准还是上一版 ⇒ 会弹"文件内容已在其它地方被改动"（用户实报的假提示，E-2026-428）。
      markWriteInFlight(baselineKeyOf(ws.id, bind.segs), code)
      await writeWorkspaceText(ws, bind.segs, code)
      // adj927：**自己写完立刻刷新基准**（内容指纹）——否则宿主推回我们自己这次写盘的
      // `modify` 时，基准还停在上一版内容上，会被当成"外部改动"（这正是用户报的假提示）。
      setBaseline(baselineKeyOf(ws.id, bind.segs), code, null)
      // 写入期间用户可能继续输入 ⇒ 内容变了就保留未保存标记
      useDocStore.setState({ dirty: useDocStore.getState().code !== code })
    } catch (e) {
      console.warn('[iJipu] 嵌入版即时保存失败', e)
      useDocStore.setState({ dirty: true })
    }
  })()
  embedAutosaveInFlight = task
  try {
    await task
  } finally {
    embedAutosaveInFlight = null
  }
}

/** 撤销/重做：将历史快照恢复到文档（code/解析/脏标记/选区/光标跳转） */
function restoreEntry(
  entry: HistoryEntry,
  historyNext: HistoryState,
  set: (partial: Partial<DocState>) => void,
  s: DocState,
) {
  const code = entry.code
  const selStart = Math.max(0, Math.min(entry.selStart, code.length))
  const selEnd = Math.max(0, Math.min(entry.selEnd, code.length))
  try {
    localStorage.setItem(DRAFT_KEY, code)
  } catch {
    /* 存储不可用时静默 */
  }
  set({
    code,
    parseResult: parseJps(code),
    // adj454：撤销/重做也必须走 resolveConfig——此前直接用 mergeJpsConfig 少了 L1「字体覆盖」
    // 这一层，开了该开关时撤销一步会让覆盖短暂失效（其它入口都走 resolveConfig）
    pageConfig: resolveConfig(code),
    dirty: true,
    sel: { start: selStart, end: selEnd },
    ...historyNext,
    cursorJump: { start: selStart, end: selEnd, nonce: (s.cursorJump?.nonce ?? 0) + 1 },
  })
  // adj724b：撤销/重做同样要即时落盘（嵌入版口径：内容始终与文件一致）
  scheduleEmbedAutosave()
}

export const useDocStore = create<DocState>()((set, get) => ({
  code: draft?.code ?? defaultSample().code,
  fileName: draft?.name ?? defaultSample().name,
  dirty: false,
  // adj315：视图记住顶栏上次设置——持久化 localStorage，下次打开恢复上一次的视图
  viewType: (localStorage.getItem('ijipu.viewType') as ViewType) || 'split',
  autoFormat: true,
  // adj83：谱面级设置优先（源码 # jps-config 注释），无则回退公共设置
  pageConfig: resolveConfig(draft?.code ?? defaultSample().code),
  parseResult: parseJps(draft?.code ?? defaultSample().code),
  cursor: { line: 1, col: 0 },
  sel: { start: 0, end: 0 },
  activeNoteId: null,
  activeNoteIds: [],
  currentMs: 0,
  playheadTrack: [],
  // adj1048：拍网格（0 = 未知，跳跳球不画）
  playheadBeatMs: 0,
  playheadAnchorMs: 0,
  playheadBarStartsMs: [],
  voiceBlocks: [],
  noteIndexToPage: null,
  cursorJump: null,
  undoStack: [],
  redoStack: [],
  lastEditAt: 0,
  historyLimit: DEFAULT_HISTORY_LIMIT,

  setCode: (code) => {
    const s = get()
    if (code === s.code) return // 无变化不产生历史
    const current: HistoryEntry = { code: s.code, selStart: s.sel.start, selEnd: s.sel.end }
    const { next } = recordEdit(
      { undoStack: s.undoStack, redoStack: s.redoStack, lastEditAt: s.lastEditAt },
      current,
      Date.now(),
      s.historyLimit,
    )
    try {
      localStorage.setItem(DRAFT_KEY, code)
    } catch {
      /* 存储不可用时静默 */
    }
    // adj83：源码 # 设置变化时同步 pageConfig（谱面级设置优先，无则回退公共）
    set({
      code,
      parseResult: parseJps(code),
      pageConfig: resolveConfig(code),
      dirty: true,
      ...next,
    })
    // adj724b：嵌入版 ⇒ 即时落盘到文库里的那个 .jps（撤销/重做历史仍由上面的 recordEdit 维护）
    scheduleEmbedAutosave()
  },
  setViewType: (v) => {
    // adj315：视图持久化——记住顶栏上次设置，重启恢复
    localStorage.setItem('ijipu.viewType', v)
    set({ viewType: v })
  },
  setAutoFormat: (b) => set({ autoFormat: b }),
  setPageConfig: (cfg, persist, base) => {
    // adj480：**不再写本机缓存**。生效配置只有「代码默认 ← 谱面」两层，页面设置属于谱面（L2）：
    //  · 预览态（persist=false）：只更新内存，不落盘（此前会把"当前文档的整份生效配置"写进
    //    localStorage，等于把本机设置变成"上一份谱的配置"，是分享不一致的根源）；
    //  · 持久态（persist=true）：写回源码 # jps-config —— 差量写入（只写与默认不同的字段），
    //    于是"我看到的非默认部分"都在谱面里 ⇒ 文件自包含 ⇒ 复制给别人效果一致。
    // adj454：传了 base（本次编辑开始前的生效配置）时，只把**用户本次改动**并入源码层
    // （mergeConfigEdits）；没传 base 时退回"整份生效配置按差量写"——两者在无缓存层后等价。
    if (persist) {
      const code = get().code
      const newCode = base
        ? writeJpsConfig(code, mergeConfigEdits(code, base, cfg))
        : writeJpsConfig(code, cfg)
      if (newCode !== code) {
        try {
          localStorage.setItem(DRAFT_KEY, newCode)
        } catch {
          /* 存储不可用时静默 */
        }
        set({ code: newCode, pageConfig: cfg, parseResult: parseJps(newCode), dirty: true })
        return
      }
    }
    set({ pageConfig: cfg })
  },
  setCursor: (line, col) => set({ cursor: { line, col } }),
  setSelection: (start, end) => set({ sel: { start, end } }),
  setActiveNoteId: (id) => set({ activeNoteId: id }),
  setActiveNoteIds: (ids) => set({ activeNoteIds: ids }),
  setVoiceBlocks: (vbs) => set({ voiceBlocks: vbs }),
  setNoteIndexToPage: (m) => set({ noteIndexToPage: m }),
  setPlayheadTrack: (t) => set({ playheadTrack: t }),
  setPlayheadBeat: (beatMs, anchorMs, barStartsMs = []) =>
    set({ playheadBeatMs: beatMs, playheadAnchorMs: anchorMs, playheadBarStartsMs: barStartsMs }),
  setCurrentMs: (ms) => set({ currentMs: ms }),
  jumpCursor: (pos, end) =>
    set((s) => ({
      cursorJump: { start: pos, end: end ?? pos, nonce: (s.cursorJump?.nonce ?? 0) + 1 },
    })),
  undo: () => {
    const s = get()
    const current: HistoryEntry = { code: s.code, selStart: s.sel.start, selEnd: s.sel.end }
    const { next, restored } = undoHistory(
      { undoStack: s.undoStack, redoStack: s.redoStack, lastEditAt: s.lastEditAt },
      current,
    )
    if (restored) restoreEntry(restored, next, set, s)
  },
  redo: () => {
    const s = get()
    const current: HistoryEntry = { code: s.code, selStart: s.sel.start, selEnd: s.sel.end }
    const { next, restored } = redoHistory(
      { undoStack: s.undoStack, redoStack: s.redoStack, lastEditAt: s.lastEditAt },
      current,
    )
    if (restored) restoreEntry(restored, next, set, s)
  },
  loadSample: (code, name) => {
    // 线上数据直接带源码；不再从随包 SAMPLES 里按 id 查
    const s = { code, name }
    localStorage.setItem(DRAFT_KEY, s.code)
    localStorage.setItem(DRAFT_NAME_KEY, s.name)
    // adj161：载入示例不是磁盘文件——清除文件句柄，避免误写回旧文件
    void saveFileHandle(null)
    // adj628：**同时清掉落盘的来源绑定**（见 newDoc 里那段说明）——否则重启/新开窗口会把老工作区文件重新绑回来
    saveDraftSrc(null)
    saveDraftNative(null)
    set({
      code: s.code,
      fileName: s.name,
      parseResult: parseJps(s.code),
      pageConfig: resolveConfig(s.code),
      dirty: false,
      fileHandle: null,
      nativePath: null,
      // adj540：三者互斥——与工作区里的任何文件解绑
      binding: null,
      pendingBinding: null,
      activeNoteId: null,
      activeNoteIds: [],
      playheadTrack: [],
      voiceBlocks: [],
      cursorJump: null,
      undoStack: [],
      redoStack: [],
      lastEditAt: 0,
      sel: { start: 0, end: 0 },
    })
  },
  newDoc: () => {
    fileStateTouched = true
    const template = defaultSample().code
    localStorage.setItem(DRAFT_KEY, template)
    localStorage.setItem(DRAFT_NAME_KEY, '未命名')
    // adj161：新建文档不关联磁盘文件——清除句柄
    void saveFileHandle(null)
    /**
     * adj628（用户报"Ctrl+N 新建后状态栏还是上一个文件名，会不会覆盖原文件"）：**这里是真凶**。
     *
     * `pendingBinding` 是从**落盘草稿的来源**（`DRAFT_SRC_KEY`）恢复的（见文件末尾 `draft?.src`），
     * 而新建原先只写了 `DRAFT_KEY`/`DRAFT_NAME_KEY`、**没清来源** ⇒ 内存里虽然解绑了，
     * 但只要重新加载（浏览器 Ctrl+N 开的新窗口 / 新标签 / 重启桌面应用），`resolvePendingBinding()`
     * 就会把这**老文件重新绑回到这份新草稿**上：状态栏显示老文件名、而内容是新建的空谱，
     * 此时「保存」直接把原文件覆盖成空谱（真机复现见 E-2026-310）。
     * 所以"解绑"必须**同时落到草稿记录里**——下列每个"非工作区来源"的载入路径都要清。
     */
    saveDraftSrc(null)
    saveDraftNative(null)
    // adj214：新建文档强制使用 defaultPageConfig——不再被本机历史设置覆盖
    // （当时的问题是新建谱仍显示旧的本机设置；adj480 更进一步：本机页面设置层已整体取消）
    // 模板无 # jps-config，merge(null) 即纯默认
    set({
      code: template,
      fileName: '未命名',
      parseResult: parseJps(template),
      // adj214：新建文档强制使用 defaultPageConfig（不吃公共设置），仅叠加 L1 字体覆盖
      pageConfig: applyFontOverride(mergeJpsConfig(template, null), loadFontOverride()),
      dirty: false,
      fileHandle: null,
      nativePath: null,
      // adj540：三者互斥——与工作区里的任何文件解绑
      binding: null,
      pendingBinding: null,
      activeNoteId: null,
      activeNoteIds: [],
      playheadTrack: [],
      voiceBlocks: [],
      cursorJump: null,
      undoStack: [],
      redoStack: [],
      lastEditAt: 0,
      sel: { start: 0, end: 0 },
    })
    // adj628：新建后**明说一句**——用户报过"Ctrl+N 之后状态栏还是上一个文件名"，而根因是
    // 浏览器把 Ctrl+N 收走（它自己开新窗口，新窗口恢复上次草稿与绑定）。这条提示让两件事都看得见：
    // "新建真的生效了" + "这份谱未关联任何文件（保存会走另存为）"。
    useUiStore.getState().showNotice(uiCopy.newDocDone, 'ok')
  },
  markSaved: () => set({ dirty: false }),

  /**
   * adj963：模式感知的「新建」——有未保存修改时先问一句（口径见接口上的说明）。
   *
   * `newDoc()` 会把草稿槽换成模板，**当前未保存的编辑就此消失、撤销也回不去**；
   * 原文件不动（这点写进文案，免得用户以为文件被删了）。
   * 确认走应用内确认条（`showAsk`），与 `main.tsx` 里"外部改动是否重新载入"同一套路。
   */
  requestNewDoc: () => {
    if (!get().dirty) {
      get().newDoc()
      return
    }
    useUiStore.getState().showAsk({
      text: uiCopy.newDocDirtyAsk,
      confirmLabel: uiCopy.newDocDirtyConfirm,
      cancelLabel: uiCopy.newDocDirtyCancel,
      onConfirm: () => get().newDoc(),
      onCancel: () => {},
    })
  },

  /** adj963：模式感知的「保存」（口径见接口上的说明）——**Ctrl+S 与菜单项都走这里** */
  requestSave: async () => {
    const st = get()
    // 嵌入版：未绑定 ⇒ 专用对话框（跨源子框架不能弹系统选择器；工作区页签在嵌入版又是隐藏的）
    if (isHostEmbedded() && !st.binding) {
      useUiStore.getState().openModal('saveAs')
      return
    }
    // 手机端：未绑定 ⇒ 引导到工作区另存（`showSaveFilePicker` 在移动端不可靠）
    if (isCoarsePointerDevice() && isWorkspaceAvailable() && !st.binding) {
      const ui = useUiStore.getState()
      ui.requestWorkspaceSave()
      ui.toggleDock('workspace')
      return
    }
    await st.saveFile()
  },

  /** adj963：模式感知的「另存为」——嵌入版与「保存未绑定文档」是同一件事（同一个对话框） */
  requestSaveAs: async () => {
    const st = get()
    if (isHostEmbedded()) {
      useUiStore.getState().openModal('saveAs')
      return
    }
    if (isCoarsePointerDevice() && isWorkspaceAvailable()) {
      const ui = useUiStore.getState()
      ui.requestWorkspaceSave()
      ui.toggleDock('workspace')
      return
    }
    await st.saveFileAs()
  },

  /**
   * adj406：粘贴源码导入——不依赖系统文件选择器的兜底入口
   * （手机端网盘/微信里的 .jps 常看不到：选择器只列本机文件，未知扩展还可能被按类型隐藏）。
   * 与「打开文件」的区别：不关联磁盘句柄（保存仍走「导出」），内容按文本清洗后替换当前文档。
   */
  importSource: (raw) => {
    const code = normalizePastedSource(raw)
    if (!code) return false
    fileStateTouched = true
    try {
      localStorage.setItem(DRAFT_KEY, code)
      localStorage.setItem(DRAFT_NAME_KEY, pasteImportCopy.name)
    } catch {
      /* 存储不可用时静默 */
    }
    // adj161：粘贴导入不是磁盘文件——清除句柄，避免误写回旧文件
    void saveFileHandle(null)
    // adj628：来源绑定同样要落盘清掉（否则重启后又把老工作区文件绑到这份粘贴稿上）
    saveDraftSrc(null)
    saveDraftNative(null)
    set({
      code,
      fileName: pasteImportCopy.name,
      parseResult: parseJps(code),
      pageConfig: resolveConfig(code),
      dirty: true, // 内容尚未落到任何文件，提醒用户用「导出」保存
      fileHandle: null,
      nativePath: null,
      // adj540：三者互斥——与工作区里的任何文件解绑
      binding: null,
      pendingBinding: null,
      activeNoteId: null,
      activeNoteIds: [],
      playheadTrack: [],
      voiceBlocks: [],
      cursorJump: null,
      undoStack: [],
      redoStack: [],
      lastEditAt: 0,
      sel: { start: 0, end: 0 },
    })
    return true
  },
  // adj615（用户要求）：菜单「打印」与 `Ctrl+P` 共用这一条
  printScore: () => {
    const s = get()
    const pages = currentPrintPages(s)
    // 有语法错误 / 算不出页面 ⇒ 如实提示、不打（与导出面板同一口径）
    if (pages.length === 0) {
      useUiStore.getState().showNotice(exportCopy.blockedByError, 'warn')
      return
    }
    printPages(pages, currentPrintTitle(s))
  },
  installPrintSupport: () => installPrintHooks(() => currentPrintPages(get()), () => currentPrintTitle(get())),

  // ---- 文件读写（adj70） ----
  fileHandle: null,
  /**
   * adj985（用户实报）：**恢复草稿时要把原生路径也恢复** —— 否则"直接开桌面壳"这条路
   * 拿不到 `{kind:'native', dir}` 这个基准，相对路径的背景图就画不出来（双击打开却正常）。
   */
  nativePath: draft?.nativePath ?? null,
  // adj540：工作区相对路径（见类型注释；同样只存内存）
  // adj544：`binding` 带工作区身份；`pendingBinding` 是随草稿恢复出来的**待校验**绑定
  binding: null,
  pendingBinding: draft?.src ?? null,
  /**
   * adj538：桌面壳送来"要打开的文件"（双击 `.jps`）——与"打开对话框"共用同一段装载逻辑，
   * 差别只有两点：① 文本已由 Rust 侧读好；② 记下 `nativePath`（后续 Ctrl+S 写回原文件）。
   */
  openExternalFiles: (files) => {
    const { primary, extraCount } = pickPrimary(files)
    if (!primary) return false
    const ui = useUiStore.getState()
    if (primary.error) {
      // 读失败（权限/文件被移走/不是文本）如实提示，不静默
      ui.showNotice(externalOpenCopy.openFailed(primary.name, primary.error), 'error')
      return false
    }
    fileStateTouched = true
    const name = fileBaseName(primary.name)
    try {
      localStorage.setItem(DRAFT_KEY, primary.code)
      localStorage.setItem(DRAFT_NAME_KEY, name)
    } catch {
      /* 存储不可用时静默 */
    }
    // 与「打开对话框」同款装载：解析 + 页面设置 + 清空历史/联动状态；
    // 数据源是外部路径 ⇒ 清掉 FSA 句柄（两者互斥），避免"保存写到了上一个文件"
    disconnectFileHandle()
    /**
     * adj966：双击打开的**系统文件**也要记**基准**（内容指纹）——这是"写盘前必比基准"的前提。
     * 没有基准时判据会退化成"拿磁盘内容比编辑器缓冲区"，用户一打字就会被误判成"外部改动" ⇒ **假提示**。
     * mtime 传 `null`：宿主把文件读好交给前端时没带 mtime（与嵌入版同一取舍，走内容判据）。
     */
    setBaseline(bindingKeyOf({ kind: 'native', path: primary.path }), primary.code, null)
    /**
     * adj979（用户 2026-10-18 实报）：**这条路有真实路径**（`primary.path`）⇒ 如果谱写在
     * 桌面 / 文档 / 下载里、又用了相对路径的图，就**当场把原因说清楚**（Chromium 禁止授权那三个目录），
     * 别让用户对着"图就是不显示"猜。判据见 `store/assetDirSensitive.ts`，提示见 `brand/copy.ts`。
     */
    void askSensitiveDirOnNativeOpen(localAssetRefs(resolveConfig(primary.code)).length > 0, name, primary.path)
    // adj628：工作区来源同样要落盘清掉（外部路径与工作区互斥，见下面 binding: null）
    saveDraftSrc(null)
    // adj985（用户实报）：**这条路的原生路径要随草稿一起落盘** —— 下次"直接开桌面壳"恢复草稿时
    // 靠它推出 `{kind:'native', dir}` 基准，相对路径的背景图/水印图才画得出来（此前恢复后没有它 ⇒ 无背景）。
    saveDraftNative(primary.path)
    set({
      code: primary.code,
      fileName: name,
      parseResult: parseJps(primary.code),
      pageConfig: resolveConfig(primary.code),
      dirty: false,
      nativePath: primary.path,
      // adj540：外部路径与工作区互斥
      binding: null,
      pendingBinding: null,
      activeNoteId: null,
      activeNoteIds: [],
      voiceBlocks: [],
      cursorJump: null,
      undoStack: [],
      redoStack: [],
      lastEditAt: 0,
      sel: { start: 0, end: 0 },
    })
    ui.showNotice(
      extraCount > 0 ? externalOpenCopy.openedWithExtra(name, extraCount) : externalOpenCopy.opened(name),
      'ok',
    )
    return true
  },
  openDropped: async ({ handle, file }) => {
    const ui = useUiStore.getState()
    let name = ''
    let code = ''
    let mtime: number | null = null
    /** adj969：这份文件的身份（两条档都能给：句柄读到的 `File`，或拖进来的 `File`） */
    let fileRef: AssetFileRef | null = null
    try {
      if (handle) {
        const f = await handle.getFile()
        name = fileBaseName(f.name)
        code = await f.text()
        mtime = f.lastModified
        fileRef = refOfFile(f)
      } else if (file) {
        name = fileBaseName(file.name)
        code = await file.text()
        fileRef = refOfFile(file)
      } else {
        return false
      }
    } catch (e) {
      // 读不出来如实报错（不是静默打不开）
      ui.showNotice(dropOpenCopy.failed(e instanceof Error ? e.message : String(e)), 'error')
      return false
    }
    /** 真正装载那一下（确认之后才执行） */
    const run = (): void =>
      adoptDoc(
        handle
          ? { name, code, handle, mtime, fileRef, notice: `${uiCopy.openOkPrefix}${name}.jps` }
          : // 拿不到可写句柄 ⇒ 说清"保存请用另存为"，别让用户以为能存回原文件
            { name, code, fileRef, notice: dropOpenCopy.uploadedReadOnly(name), noticeKind: 'warn' },
      )
    /**
     * 拖入是**替换当前文档**的动作：有未保存修改就先问一句（与「新建」同一套确认条，
     * 见 `requestNewDoc`）——绝不静默丢编辑。确认条是异步的，故这里先返回 true。
     */
    if (get().dirty) {
      useUiStore.getState().showAsk({
        text: dropOpenCopy.replaceDirtyAsk(`${name}.jps`),
        confirmLabel: dropOpenCopy.replaceDirtyConfirm,
        cancelLabel: dropOpenCopy.replaceDirtyCancel,
        onConfirm: run,
        onCancel: () => {},
      })
      return true
    }
    run()
    return true
  },
  openFile: async () => {
    fileStateTouched = true
    // adj1156：桌面壳走原生文件对话框 ⇒ 拿到真实路径，sidecar 才能写到 .jps 同目录
    if (isTauriShell()) return openFileNative()
    const picker = (window as any).showOpenFilePicker
    // adj281：非安全上下文（http:// 或 file://）或非 Chromium 内核下无 showOpenFilePicker，
    // 降级用 <input type=file> 读取 .jps 文本——打开本质只读文本，不依赖文件系统 API
    // adj405：**移动端一律走 input 路径**——真机上已安装的 PWA 里 showOpenFilePicker 可能
    // "点了没反应"（浏览器同一地址却正常），且 Android 拿不到可写回句柄（移动端保存走「导出」）。
    if (shouldUseFileInputPicker(isCoarsePointerDevice(), typeof picker === 'function')) return openFileViaInput()
    try {
      const [handle] = await picker({
        types: [{ description: 'iJipu 乐谱', accept: { 'text/plain': ['.jps'] } }],
        multiple: false,
      })
      const file = await handle.getFile()
      const code = await file.text()
      const name = fileBaseName(file.name)
      // adj968：装载 + 记基准（带 mtime）+ 句柄持久化 + 持久权限引导都收在 `adoptDoc`（与"拖入"同一份实现）
      adoptDoc({
        name,
        code,
        handle,
        mtime: file.lastModified,
        // adj969：这份文件的身份（拿它去核对"用户授权的文件夹里是不是就是这一份"）
        fileRef: refOfFile(file),
        notice: `${uiCopy.openOkPrefix}${name}.jps`,
      })
      // adj370：打开成功给出明确反馈（含实际文件名与句柄名），避免"打开了没打开"无从判断
      console.info(`[iJipu] 打开文件：name=${name} handle=${handle.name}`)
      return true
    } catch (e) {
      // adj370：打开失败不再静默——此前 catch 直接 return false，用户只看到"没反应"；
      // 用户主动取消（AbortError）仍静默
      if (isUserCancel(e)) return false
      const reason = e instanceof Error ? `${e.name}${e.message ? `: ${e.message}` : ''}` : String(e)
      console.warn('[iJipu] 打开文件失败', e)
      useUiStore.getState().showNotice(`${uiCopy.openFailedPrefix}${reason}`, 'error')
      return false
    }
  },

  // ---- adj540：工作区（Android/移动端的"文件夹当工作区"；含子目录） ----
  openWorkspaceFile: async (path) => {
    fileStateTouched = true
    const ui = useUiStore.getState()
    const segs = normalizeRelPath(path)
    if (segs.length === 0) return false
    const ws = await getWorkspace()
    if (!ws) {
      ui.showNotice(workspaceCopy.noWorkspace, 'warn')
      return false
    }
    // adj724b：给底层 catch 用（失败时要回滚这次"同步认领"）
    const prevBinding = useDocStore.getState().binding
    const prevPending = useDocStore.getState().pendingBinding
    try {
      const code = await readWorkspaceText(ws, segs)
      // adj927：读进来就是当前基准（外部改动的判据拿它当参照；「载入外部」也走这条路 ⇒ 自动对齐）
      setBaseline(baselineKeyOf(ws.id, segs), code, null)
      const name = fileBaseName(segs[segs.length - 1])
      try {
        localStorage.setItem(DRAFT_KEY, code)
        localStorage.setItem(DRAFT_NAME_KEY, name)
      } catch {
        /* 存储不可用时静默 */
      }
      /**
       * adj724b（用户实测，**本轮真正的根因**）：**先把绑定"认领"下来，再往下走**。
       *
       * 现象（日志顺序确凿）：
       * ```
       * [iJipu] 宿主推来的文件打开成功：…痴情冢.jps
       * [iJipu] 已恢复工作区绑定：…茶花开了.jps      ← 又被改回去
       * ```
       *
       * 根因是**并发 + 认领太晚**：`resolvePendingBinding()` 开头有 `if (st.binding) return false`，
       * 但它跑的时候绑定**还是空的**，因为本函数此前是在**末尾**才 `set({ binding: bind })`，
       * 而 `await readWorkspaceText(...)` 在它之前 ⇒ 恢复路径先通过守卫、后完成，把结果覆盖掉。
       *
       * ⇒ 这里在**第一个 await 之前**就把绑定与"待恢复"一并定下来（同步认领）：
       * 之后任何 `resolvePendingBinding()` 都会在开头那道 `st.binding` 判断上直接返回。
       * 后面成功时再写一遍 `binding: bind`（幂等），失败时**回滚**这两项。
       */
      const bind: WorkspaceBinding = { wsId: ws.id, wsName: ws.name, segs }
      set({ binding: bind, pendingBinding: null })
      saveDraftSrc(bind)
      saveDraftNative(null)
      // 数据源是工作区 ⇒ 断开磁盘句柄（三者互斥），避免"保存写到了上一个文件"
      disconnectFileHandle()
      set({
        code,
        fileName: name,
        parseResult: parseJps(code),
        pageConfig: resolveConfig(code),
        dirty: false,
        fileHandle: null,
        nativePath: null,
        binding: bind,
        pendingBinding: null,
        activeNoteId: null,
        activeNoteIds: [],
        voiceBlocks: [],
        cursorJump: null,
        undoStack: [],
        redoStack: [],
        lastEditAt: 0,
        sel: { start: 0, end: 0 },
      })
      // 记住所在子目录：下次打开对话框直接落回原处（用户要求支持子目录）
      void rememberWorkspacePath(segs.slice(0, -1))
      console.info(`[iJipu] 从工作区打开：${joinPath(segs)}`)
      ui.showNotice(workspaceCopy.opened(joinPath(segs)), 'ok')
      return true
    } catch (e) {
      // adj724b：读取失败 ⇒ **回滚**上面那次"同步认领"，别把绑定停在一份没打开的文件上
      set({ binding: prevBinding, pendingBinding: prevPending })
      const reason = e instanceof Error ? `${e.name}${e.message ? `: ${e.message}` : ''}` : String(e)
      console.warn('[iJipu] 从工作区打开失败', e)
      ui.showNotice(workspaceCopy.openFailed(joinPath(segs), reason), 'error')
      return false
    }
  },
  saveToWorkspace: async (path) => {
    fileStateTouched = true
    const ui = useUiStore.getState()
    const segs = normalizeRelPath(path)
    if (segs.length === 0) return false
    const ws = await getWorkspace()
    if (!ws) {
      ui.showNotice(workspaceCopy.noWorkspace, 'warn')
      return false
    }
    const cancelHint = armSavingHint()
    try {
      const code = get().code
      // 重名保护：目标位置已有同名文件、且**不是本文档当前绑定的那个** ⇒ 拒绝（不静默覆盖别人的谱）
      // adj544：绑定带工作区身份 ⇒ 只有"同属当前工作区且路径相同"才算同一个文件
      const cur = get().binding
      const same = !!cur && cur.wsId === ws.id && joinPath(cur.segs) === joinPath(segs)
      if (!same && (await hasEntry(ws, segs.slice(0, -1), segs[segs.length - 1]))) {
        ui.showNotice(workspaceCopy.exists(segs[segs.length - 1]), 'warn')
        return false
      }
      // adj943：写盘发出前登记"在途写"（与随输随存同一口径；见 externalChange.ts 文件头）
      markWriteInFlight(baselineKeyOf(ws.id, segs), code)
      await writeWorkspaceText(ws, segs, code)
      // adj927：自己写完立刻刷新基准（另存到工作区同样是"我们写下去的那份"）
      setBaseline(baselineKeyOf(ws.id, segs), code, null)
      const name = fileBaseName(segs[segs.length - 1])
      const bind: WorkspaceBinding = { wsId: ws.id, wsName: ws.name, segs }
      saveDraftSrc(bind)
      saveDraftNative(null)
      set({
        fileName: name,
        fileHandle: null,
        nativePath: null,
        binding: bind,
        pendingBinding: null,
        // 写入期间用户可能继续输入 ⇒ 内容变了就保留未保存标记（与句柄路径同一口径）
        dirty: get().code !== code,
      })
      void saveFileHandle(null)
      void rememberWorkspacePath(segs.slice(0, -1))
      console.info(`[iJipu] 另存到工作区：${joinPath(segs)}`)
      ui.showNotice(workspaceCopy.saved(joinPath(segs)), 'ok')
      return true
    } catch (e) {
      const reason = e instanceof Error ? `${e.name}${e.message ? `: ${e.message}` : ''}` : String(e)
      console.warn('[iJipu] 另存到工作区失败', e)
      ui.showNotice(workspaceCopy.saveFailed(joinPath(segs), reason), 'error')
      return false
    } finally {
      cancelHint()
    }
  },
  createWorkspaceDir: async (dirPath, name) => {
    const ui = useUiStore.getState()
    const ws = await getWorkspace()
    if (!ws) {
      ui.showNotice(workspaceCopy.noWorkspace, 'warn')
      return false
    }
    if (!isValidEntryName(name)) {
      ui.showNotice(workspaceCopy.invalidName, 'warn')
      return false
    }
    try {
      await createSubdir(ws, dirPath, name)
      console.info(`[iJipu] 工作区新建目录：${joinPath([...dirPath, name])}`)
      ui.showNotice(workspaceCopy.dirCreated(name), 'ok')
      return true
    } catch (e) {
      console.warn('[iJipu] 新建目录失败', e)
      ui.showNotice(workspaceOpErrorText(name, e), 'error')
      return false
    }
  },
  renameWorkspaceFile: async (dirPath, fromName, toName) => {
    const ui = useUiStore.getState()
    const ws = await getWorkspace()
    if (!ws) {
      ui.showNotice(workspaceCopy.noWorkspace, 'warn')
      return false
    }
    if (!isValidEntryName(toName)) {
      ui.showNotice(workspaceCopy.invalidName, 'warn')
      return false
    }
    const dir = normalizeRelPath(dirPath)
    const from = [...dir, fromName]
    const to = [...dir, toName]
    try {
      await renameFile(ws, dir, fromName, toName)
      // 正在编辑的就是这个文件 ⇒ 绑定跟着改名（否则「保存」会指向一个已不存在的名字）
      // adj544：绑定现在带身份，改路径时**保留 wsId/wsName**，并同步持久化的草稿来源
      const cur = get().binding
      if (cur && cur.wsId === ws.id && joinPath(cur.segs) === joinPath(from)) {
        const next: WorkspaceBinding = { ...cur, segs: to }
        saveDraftSrc(next)
        set({ binding: next, fileName: fileBaseName(toName) })
      }
      console.info(`[iJipu] 工作区重命名：${joinPath(from)} → ${joinPath(to)}`)
      ui.showNotice(workspaceCopy.renamed(fromName, toName), 'ok')
      return true
    } catch (e) {
      console.warn('[iJipu] 重命名失败', e)
      ui.showNotice(workspaceOpErrorText(toName, e), 'error')
      return false
    }
  },
  moveWorkspaceFiles: async (fromSegsList, toDirSegs) => {
    const ui = useUiStore.getState()
    const ws = await getWorkspace()
    if (!ws) {
      ui.showNotice(workspaceCopy.noWorkspace, 'warn')
      return false
    }
    const toDir = normalizeRelPath(toDirSegs)
    let ok = 0
    let firstErr = ''
    let failedName = ''
    for (const raw of fromSegsList) {
      const from = normalizeRelPath(raw)
      if (from.length === 0) continue
      const name = from[from.length - 1]
      if (joinPath(from.slice(0, -1)) === joinPath(toDir)) {
        ok++ // 原地不动也算成功
        continue
      }
      try {
        await moveFile(ws, from, toDir)
        // adj544：绑定带身份 ⇒ 只更新路径（保留 wsId/wsName）并同步持久化的草稿来源
        const cur = get().binding
        if (cur && cur.wsId === ws.id && joinPath(cur.segs) === joinPath(from)) {
          const next: WorkspaceBinding = { ...cur, segs: [...toDir, name] }
          saveDraftSrc(next)
          set({ binding: next })
        }
        ok++
      } catch (e) {
        if (!firstErr) {
          firstErr = e instanceof Error ? e.message : String(e)
          failedName = name
        }
      }
    }
    console.info(`[iJipu] 工作区移动：成功 ${ok} / 失败 ${fromSegsList.length - ok} → ${joinPath(toDir) || '根目录'}`)
    if (ok === 0) {
      ui.showNotice(workspaceOpErrorText(failedName, new Error(firstErr)), 'error')
      return false
    }
    if (firstErr) ui.showNotice(workspaceCopy.opPartial(ok, fromSegsList.length - ok, firstErr), 'warn')
    else ui.showNotice(workspaceCopy.movedMany(ok, joinPath(toDir)), 'ok')
    return true
  },
  deleteWorkspaceEntries: async (items) => {
    const ui = useUiStore.getState()
    const ws = await getWorkspace()
    if (!ws) {
      ui.showNotice(workspaceCopy.noWorkspace, 'warn')
      return false
    }
    let ok = 0
    let firstErr = ''
    let failedName = ''
    let unbound = false
    for (const it of items) {
      const segs = normalizeRelPath(it.segs)
      if (segs.length === 0) continue
      const name = segs[segs.length - 1]
      try {
        if (it.kind === 'dir') await removeEmptyDir(ws, segs.slice(0, -1), name)
        else await removeFile(ws, segs)
        // 当前文档正被删掉的那一项 ⇒ 解绑（内容仍留在编辑器里）
        // adj544：解绑要连**持久化的草稿来源**一起清掉，否则重启后又"以为"绑定在已删的文件上
        const cur = get().binding
        const target = joinPath(segs)
        if (cur && cur.wsId === ws.id && (joinPath(cur.segs) === target || (it.kind === 'dir' && joinPath(cur.segs).startsWith(`${target}/`)))) {
          saveDraftSrc(null)
          saveDraftNative(null)
          set({ binding: null, pendingBinding: null })
          unbound = true
        }
        ok++
      } catch (e) {
        if (!firstErr) {
          firstErr = e instanceof Error ? e.message : String(e)
          failedName = name
        }
      }
    }
    console.info(`[iJipu] 工作区删除：成功 ${ok} / 失败 ${items.length - ok}${unbound ? '（含当前文档，已解绑）' : ''}`)
    if (ok === 0) {
      ui.showNotice(workspaceOpErrorText(failedName, new Error(firstErr)), 'error')
      return false
    }
    if (unbound) ui.showNotice(workspaceCopy.deletedOpenFile(failedName || '当前文件'), 'warn')
    else if (firstErr) ui.showNotice(workspaceCopy.opPartial(ok, items.length - ok, firstErr), 'warn')
    else ui.showNotice(workspaceCopy.deletedMany(ok), 'ok')
    return true
  },
  newWorkspaceScore: async (segs) => {
    const ui = useUiStore.getState()
    const ws = await getWorkspace()
    if (!ws) {
      ui.showNotice(workspaceCopy.noWorkspace, 'warn')
      return false
    }
    const target = normalizeRelPath(segs)
    if (target.length === 0) return false
    const name = target[target.length - 1]
    try {
      // 内容用「新建」模板（`src/samples/未命名.jps`，adj481 文件驱动），同名则拒绝
      await createFile(ws, target.slice(0, -1), name, defaultSample().code)
      console.info(`[iJipu] 工作区新建谱：${joinPath(target)}`)
      ui.showNotice(workspaceCopy.created(name), 'ok')
    } catch (e) {
      console.warn('[iJipu] 新建谱失败', e)
      ui.showNotice(workspaceOpErrorText(name, e), 'error')
      return false
    }
    // 新建完直接打开它（用户的下一步必然是编辑）
    return get().openWorkspaceFile(target)
  },
  saveFile: async () => {
    fileStateTouched = true
    // adj363：并发合并——连按两次 Ctrl+S 会同时对同一句柄 createWritable()，
    // 后一次可能 InvalidStateError 失败（间歇性「保存没生效」），此处复用进行中的保存
    if (saveInFlight) return saveInFlight
    const task = doSaveFile()
    saveInFlight = task
    try {
      return await task
    } catch {
      // doSaveFile 内部已归类提示；此处兜底避免未处理 rejection
      useUiStore.getState().showNotice(uiCopy.saveFailed, 'error')
      return false
    } finally {
      saveInFlight = null
    }
  },
  /**
   * adj966f：**应用合并结果**（差异框底部「应用（并保存）」/ 无冲突块时提示条上的「应用」）。
   *
   * 四步（顺序刻意，见接口处的说明）：备份两侧 → 一步历史 + 解析器体检 → 立刻写回文件 → 基准收口。
   */
  applyMergeResult: (merged, externalText) => {
    const s = get()
    // ① 备份"当时那两份原文"（护栏①：两侧都不丢；合错了还能回看）
    try {
      localStorage.setItem(MERGE_BACKUP_LOCAL_KEY, s.code)
      localStorage.setItem(MERGE_BACKUP_EXTERNAL_KEY, externalText)
      localStorage.setItem(MERGE_BACKUP_AT_KEY, `${new Date().toISOString()} ${s.fileName}`)
    } catch {
      /* 存储不可用时静默：备份是护栏，不是主路径 */
    }
    /**
     * ② **一步历史**：先把合并窗口的时间戳清零 —— `recordEdit` 会把 1.2s 内的连续编辑并成一步，
     * 不清零的话"刚敲完字就点应用"会把合并并进上一次输入里，用户撤销时**跨过**这一步 ✗
     * （用户口径④要求"应用 = 一步历史，可撤销"）。
     */
    set({ lastEditAt: 0 })
    get().setCode(merged)
    // ③ 立刻写回同一个文件（口径④）；写回成功即刷新基准 ⇒ 状态从"两边都改过"回到"已保存"
    void get().saveFile()
  },
  saveFileAs: async () => {
    fileStateTouched = true
    // adj1158：桌面壳「另存为」也走原生对话框，存完就有 nativePath（sidecar 直接同目录）
    if (isTauriShell()) return saveFileAsNative()
    const ui = useUiStore.getState()
    const picker = (window as any).showSaveFilePicker
    if (typeof picker !== 'function') {
      // 当前 WebView/浏览器不支持 File System Access API → 无法保存到磁盘
      ui.showNotice(uiCopy.saveUnsupported, 'error')
      return false
    }
    try {
      // adj357：未命名文件保存/另存时，默认用描述头第一个 B: 标题作为文件名（省得输入）
      const nm = get().fileName
      const isNamed = !!nm && nm !== '未命名'
      const bTitle = get().parseResult.header.titles[0]
      const defaultName = isNamed ? nm : bTitle && bTitle !== '未命名' ? bTitle : '未命名'
      const handle = await picker({
        suggestedName: `${defaultName}.jps`,
        types: [{ description: 'iJipu 乐谱', accept: { 'text/plain': ['.jps'] } }],
      })
      // adj364：最快路径写入（刚选定的句柄权限本就授予；仅权限失败时才申请并重试）
      const code = get().code
      // adj371：文件名乐观更新——选完文件名字就定了，先切到新名（写盘可能要几秒），
      // 未保存标记与句柄仍等写盘成功后才落定；失败回滚。
      const prevName = get().fileName
      const name = fileBaseName(handle.name)
      const optimistic = prevName !== name
      if (optimistic) applyOptimisticName(name)
      // adj966：另存为之后，基准要跟到**新文件**上（写前登记在途写、写成功刷基准）——
      // 否则轮询还在盯旧键，且"刚写完"会被当成外部改动
      const asKey = bindingKeyOf({ kind: 'handle', name })
      markWriteInFlight(asKey, code)
      // adj365：选完文件后才武装「保存中…」提示（选文件期间提示会误导）
      const t0 = performance.now()
      const cancelHint = armSavingHint()
      const phaseLog = collectSavePhases()
      try {
        await saveTextToHandle(handle, code, { trace: phaseLog.trace })
        setBaseline(asKey, code, null)
      } catch (e) {
        if (optimistic) rollbackOptimisticName(prevName)
        throw e
      } finally {
        cancelHint()
      }
      const tStore = performance.now()
      phaseLog.tail('store', performance.now() - tStore)
      void saveFileHandle(handle)
      // adj363：写入期间用户可能继续输入，内容已变则保留未保存标记
      const tUi = performance.now()
      set({ fileHandle: handle, fileName: name, dirty: get().code !== code, nativePath: null, binding: null })
      // adj1158：网页 FSA 另存为同样接管 sync doc（同一份谱换了文件名，别清掉锚点）
      adoptSyncDocOwner({ fileName: name, nativePath: null, binding: null })
      phaseLog.tail('ui', performance.now() - tUi)
      reportSaved(t0, phaseLog, name)
      return true
    } catch (e) {
      const kind = classifySaveError(e)
      // adj363：只有 AbortError 是「用户取消」（静默）；NotAllowedError 是缺少用户手势/权限，
      // 此前被当成取消静默吞掉 → 按保存毫无反应、文件未变（用户反馈的「保存没生效」）
      if (kind === 'cancel') return false
      ui.showNotice(kind === 'permission' ? uiCopy.saveAsNoGesture : uiCopy.saveAsFailed, 'error')
      return false
    }
  },
}))

// ---- adj363/adj364：保存到磁盘的可靠性补强 ----
// 用户反馈「按保存有时没生效，必须另存为才有效」。根因链条：
//   ① 恢复自 IndexedDB 的句柄重启后写权限失效 → createWritable() 抛 NotAllowedError；
//   ② 旧代码静默回退 saveFileAs()，但 showSaveFilePicker() 必须在**用户手势**内调用，
//      前面的 await 已消耗手势 → 选择器再抛 NotAllowedError；
//   ③ 旧代码把 NotAllowedError 当「用户取消」静默吞掉 → 按保存毫无反应、文件未变。
// 现在：只有 AbortError 算取消，其余失败一律给出可操作提示；权限/文件失效时断开句柄，
// 下次「保存」直接走另存为。
//
// adj364（用户续报「Ctrl+S / 菜单保存响应很慢」）：上一版把「主动查权限 + 写入后回读」放进
// 了每次保存的必经路径，每次都多出 2~3 次文件系统往返（权限为 prompt 时 requestPermission
// 还要等权限提示）→ 保存明显变慢。现改为 **失败才申请权限**：先直接写（一次往返），
// 只有因权限失败才申请权限并重试一次（saveTextToHandle 内部处理），回读校验默认关闭。
// 于是权限正常的保存与旧版一样快，同时保留「不会静默不生效」。

/** 进行中的保存（并发合并用） */
let saveInFlight: Promise<boolean> | null = null

/** adj365：慢保存的即时反馈阈值——超过该毫秒数仍未写完才提示「保存中…」（快保存不闪烁） */
const SAVE_HINT_DELAY_MS = 150
/** adj365：超过该毫秒数视为慢保存——控制台记录耗时，提示里带上实际耗时（便于定位是写盘慢还是反馈慢） */
const SAVE_SLOW_MS = 400
/** adj369：提交（原子替换文件）超过该毫秒数 = 异常——附上「文件被占用」的可操作提示 */
const SAVE_SLOW_COMMIT_MS = 2000

/** adj365：武装「保存中…」提示，返回清理函数（保存结束即撤销未触发的计时器） */
function armSavingHint(): () => void {
  const ui = useUiStore.getState()
  const timer = window.setTimeout(() => ui.showNotice(uiCopy.saving, 'warn'), SAVE_HINT_DELAY_MS)
  return () => window.clearTimeout(timer)
}

/** adj367：阶段耗时收集器（阶段名文案集中在 brand/copy.ts 的 savePhaseCopy） */
function collectSavePhases(): SavePhaseLog {
  return createSavePhaseLog((phase) => savePhaseCopy[phase])
}

/**
 * adj365/adj367/adj369：保存成功提示。
 *  - <400ms：仅「已保存」；
 *  - ≥400ms：给出总耗时 + **最耗时那一段**（如「已保存 · 7.1s（提交文件 7140ms）」），完整阶段明细
 *    进 `console.info`（便于判断延迟出在文件系统哪一步还是主线程）；
 *  - adj369：「提交文件」是瓶颈且 ≥2s 时附一句可操作提示——这一步是**浏览器把临时文件原子替换成目标文件**，
 *    应用代码不参与，常见原因是目标文件被云同步客户端 / 杀毒软件 / 其它程序占用（替换被反复重试）。
 */
function reportSaved(t0: number, log?: SavePhaseLog, savedName?: string): void {
  const ms = Math.round(performance.now() - t0)
  // adj370：提示带上实际写入的文件名，一眼确认"保存到了哪个文件"
  const who = savedName ? `：${savedName}.jps` : ''
  if (ms < SAVE_SLOW_MS) {
    useUiStore.getState().showNotice(`${uiCopy.saveOk}${who}`, 'ok')
    return
  }
  const detail = log?.text() ?? ''
  const worst = log?.worst() ?? null
  const worstSex = worst ? `（${worst.label} ${Math.round(worst.ms)}ms）` : ''
  const commitStuck = worst?.phase === 'commit' && worst.ms >= SAVE_SLOW_COMMIT_MS
  console.info(
    `[iJipu] 保存耗时 ${ms}ms → ${savedName ?? '?'}.jps（${detail || '无阶段明细'} · 收尾 ${Math.max(0, ms - (log?.total() ?? 0))}ms）`,
  )
  // 带排查建议时用 warn（toast 停留 4s，够读完），否则 ok（1.8s）
  useUiStore
    .getState()
    .showNotice(
      `${uiCopy.saveOk}${who} · ${(ms / 1000).toFixed(1)}s${worstSex}${commitStuck ? ` · ${uiCopy.saveSlowCommitHint}` : ''}`,
      commitStuck ? 'warn' : 'ok',
    )
}

/** adj966：「PC 不再自动接管工作区」的告知**每个会话只弹一次**（避免启动竞态里重复提示） */
let pcWorkspaceNoticeShown = false

/**
 * adj966：首次成功打开 FSA 文件后**提示一次**「想免手点保存就选『每次访问都允许』」。
 *
 * 判据在 `fileHost.shouldGuidePersistPermission`（只 FSA 档 + 权限仍是 `prompt` + 这台机器没提示过）；
 * 文案在 `brand/copy.ts` 的 `persistPermissionCopy`。**不阻断**：用户点「仅此次」照样能用
 * （那时降级为草稿 + 手动保存，且"写盘前必比基准"照样生效）。任何一步失败都静默——它只是告知。
 */
async function guidePersistPermissionOnce(handle: FileSystemFileHandle, name: string): Promise<void> {
  try {
    if (hasShownPermGuide()) return
    const fsa = typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function'
    const profile = hostProfile(getRuntimeEnv(), fsa)
    const q = (handle as unknown as { queryPermission?: (d: { mode: string }) => Promise<PermissionState> }).queryPermission
    const perm: PermState = q ? ((await q.call(handle, { mode: 'readwrite' })) as PermState) : 'granted'
    if (!shouldGuidePersistPermission(profile, perm, false)) return
    markPermGuideShown()
    useUiStore.getState().showNotice(persistPermissionCopy.notice(name), persistPermissionCopy.level)
  } catch {
    /* 引导失败不影响打开 */
  }
}

/** 「保存」主流程：有可用句柄直接写回；否则走另存为 */
async function doSaveFile(): Promise<boolean> {
  const st = useDocStore.getState()
  // adj538：双击 `.jps` 打开（externalPath 有值）⇒ Ctrl+S **写回原文件**（用户确认的桌面标准行为）。
  // 写入与回读校验都在 Rust 侧（`write_external_file`），与 FSA 路径同口径；失败如实提示、
  // **不自动弹另存为**——外部文件写失败多是"被移走/改名/无权限"，静默换个对话框反而更迷惑，
  // 提示里已写明可改用「另存为」。
  if (st.nativePath) {
    const path = st.nativePath
    const ui = useUiStore.getState()
    const t0 = performance.now()
    const cancelHint = armSavingHint()
    try {
      const code = useDocStore.getState().code
      // adj966：写之前登记"在途写"、写成功后刷基准 ⇒ 自己的写盘回环不弹"外部变更"（与工作区那条同口径）
      markWriteInFlight(bindingKeyOf({ kind: 'native', path }), code)
      await writeExternalFile(path, code)
      setBaseline(bindingKeyOf({ kind: 'native', path }), code, null)
      // 写入期间用户可能继续输入 ⇒ 内容变了就保留未保存标记（与句柄路径同一口径）
      useDocStore.setState({ dirty: useDocStore.getState().code !== code })
      console.info(`[iJipu] 保存到原文件：${path}（${Math.round(performance.now() - t0)}ms）`)
      ui.showNotice(externalOpenCopy.savedToSource(st.fileName), 'ok')
      return true
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      console.warn('[iJipu] 保存到原文件失败', e)
      ui.showNotice(externalOpenCopy.saveToSourceFailed(st.fileName, reason), 'error')
      return false
    } finally {
      cancelHint()
    }
  }
  // adj540：工作区文档 ⇒ 写回工作区里的**同一个文件**（含子目录），与桌面 nativePath 同语义。
  // 权限用根目录句柄申请（工作区授权是目录级的），必须在用户手势内完成 ⇒ 放在这里、写入之前。
  //
  // adj544：写之前**三道校验**，任一不过就绝不写盘（E-2026-251）：
  //   ① 绑定里的工作区身份 == 当前工作区？否 ⇒ 说明用户换了工作区，**不能**拿新根 + 旧相对路径去写
  //      （否则没同名就新建、有同名就覆盖，静默写错文件）；给出明确指引后放弃。
  //   ② 文件**仍然存在**？否 ⇒ 原文件被外部移走/删了；**不静默重建同名文件**，转另存让用户确认位置。
  //   ③ 权限由 `writeWorkspaceText` 内部在用户手势内申请（保持原样）。
  if (st.binding && st.binding.segs.length > 0) {
    const bind = st.binding
    const wsPath = bind.segs
    const ui = useUiStore.getState()
    const t0 = performance.now()
    const cancelHint = armSavingHint()
    try {
      const ws = await getWorkspace()
      if (!ws) {
        ui.showNotice(workspaceCopy.noWorkspace, 'warn')
        return false
      }
      // ① 工作区身份校验：换了工作区就绝不写（这是本轮修掉的数据风险）
      if (ws.id !== bind.wsId) {
        console.warn(`[iJipu] 绑定的工作区(${bind.wsId})与当前工作区(${ws.id})不一致，拒绝写盘`)
        ui.showNotice(workspaceCopy.boundToOtherWorkspace(bind.wsName || '另一个工作区', ws.name, joinPath(wsPath)), 'warn')
        return false
      }
      // ② 存在性校验：原文件不在了 ⇒ 转另存（用户确认位置），不静默重建
      if (!(await hasEntry(ws, wsPath.slice(0, -1), wsPath[wsPath.length - 1]))) {
        console.warn(`[iJipu] 绑定的工作区文件已不存在：${joinPath(wsPath)}`)
        ui.showNotice(workspaceCopy.sourceMissing(joinPath(wsPath)), 'warn')
        return false
      }
      const code = useDocStore.getState().code
      // adj943：写盘发出前登记"在途写"（Ctrl+S 写回工作区同样在我们的窗口里）
      markWriteInFlight(baselineKeyOf(ws.id, wsPath), code)
      await writeWorkspaceText(ws, wsPath, code)
      // adj927：Ctrl+S 写回工作区后同样刷新基准
      setBaseline(baselineKeyOf(ws.id, wsPath), code, null)
      useDocStore.setState({ dirty: useDocStore.getState().code !== code })
      console.info(`[iJipu] 保存到工作区：${joinPath(wsPath)}（${Math.round(performance.now() - t0)}ms）`)
      ui.showNotice(workspaceCopy.saved(joinPath(wsPath)), 'ok')
      return true
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      console.warn('[iJipu] 保存到工作区失败', e)
      ui.showNotice(workspaceCopy.saveFailed(joinPath(wsPath), reason), 'error')
      return false
    } finally {
      cancelHint()
    }
  }
  const handle = useDocStore.getState().fileHandle
  if (!handle) return useDocStore.getState().saveFileAs()
  const ui = useUiStore.getState()
  const t0 = performance.now()
  const cancelHint = armSavingHint()
  const phaseLog = collectSavePhases()
  // adj371：文件名「乐观更新」——写盘（尤其 close() 的原子替换）可能要好几秒，
  // 名称在按下保存时就已知，先切过去，未保存标记仍保留到写盘成功；失败则回滚。
  const prevName = useDocStore.getState().fileName
  const name = fileBaseName(handle.name)
  const optimistic = prevName !== name
  if (optimistic) applyOptimisticName(name)
  try {
    const code = useDocStore.getState().code
    // adj966：写前登记"在途写"、写成功后刷基准（与 nativePath / 工作区两条同口径）⇒ 自己的回环不弹提示
    const hKey = bindingKeyOf({ kind: 'handle', name })
    markWriteInFlight(hKey, code)
    // adj364：最快路径——直接写；权限失效时才申请权限并重试（不再每次前置查权限/回读）
    await saveTextToHandle(handle, code, { trace: phaseLog.trace })
    setBaseline(hKey, code, null)
    const tStore = performance.now()
    phaseLog.tail('store', performance.now() - tStore)
    // 句柄与显示名保持一致（句柄持久化已在获取/打开该文件时完成，保存热路径不再重复写库）
    const tUi = performance.now()
    useDocStore.setState({ dirty: useDocStore.getState().code !== code })
    phaseLog.tail('ui', performance.now() - tUi)
    reportSaved(t0, phaseLog, name)
    return true
  } catch (e) {
    if (optimistic) rollbackOptimisticName(prevName)
    const kind = classifySaveError(e)
    if (kind === 'cancel') return false
    if (kind === 'permission' || kind === 'gone') {
      // 句柄已失效：断开它——下次「保存」直接弹另存为（全新用户手势，选择器不会被拒），
      // 不会再卡在同一条静默失败的路径上；本次先尝试直接转另存为
      disconnectFileHandle()
      return useDocStore.getState().saveFileAs()
    }
    ui.showNotice(
      kind === 'busy' ? uiCopy.saveBusy : kind === 'verify' ? uiCopy.saveVerifyFailed : uiCopy.saveFailed,
      'error',
    )
    return false
  } finally {
    cancelHint()
  }
}

/** adj371：乐观切名（同步写草稿名，保证下次启动「句柄名 ↔ 草稿名」仍对得上） */
function applyOptimisticName(name: string): void {
  try {
    localStorage.setItem(DRAFT_NAME_KEY, name)
  } catch {
    /* 忽略 */
  }
  useDocStore.setState({ fileName: name })
}

/** adj371：写盘失败时回滚乐观切名 */
function rollbackOptimisticName(prevName: string): void {
  try {
    localStorage.setItem(DRAFT_NAME_KEY, prevName)
  } catch {
    /* 忽略 */
  }
  useDocStore.setState({ fileName: prevName })
}

/** 断开与磁盘文件的关联（句柄失效时：下次保存 = 另存为） */
function disconnectFileHandle(): void {
  useDocStore.setState({ fileHandle: null })
  void saveFileHandle(null)
}

/**
 * adj540：把工作区 IO 抛出的**错误码**翻译成给用户看的一句话。
 * 这些是"预期内的失败"（重名 / 目录非空 / 校验不一致），必须给人话，不能把原始异常抛给用户。
 */
function workspaceOpErrorText(name: string, e: unknown): string {
  const code = e instanceof Error ? e.message : String(e)
  if (code === 'EXISTS') return workspaceCopy.exists(name)
  if (code === 'NOT_EMPTY') return workspaceCopy.dirNotEmpty(name)
  if (code === 'VERIFY') return workspaceCopy.verifyFailed(name)
  return workspaceCopy.opFailed(name, code)
}

// ---- adj281：降级打开（无 Web File System Access API 时） ----
// 非安全上下文（http://、file://）或非 Chromium 内核下没有 showOpenFilePicker；
// 打开本身只需读取 .jps 文本，改用标准 <input type="file"> 任何环境都可用。
// 该环境无法写回磁盘，故 fileHandle 置 null，并提示改走「导出」保存成果。

/**
 * adj399/adj540：是否触屏/移动端 —— 判据已收敛到 `saveSupport.isCoarsePointerDevice()`
 * （「打开/另存为」在手机端要**以工作区优先**，两处必须用同一个判断，见该函数注释）。
 */
/**
 * adj968（用户要求"拖进窗口就打开"）：**把一份刚拿到手的内容装载成当前文档**——三处入口共用一份实现。
 *
 * 三处入口的差别**只在"绑定什么"**，装载动作（解析、页面设置、清空历史与联动、写草稿）必须一字不差：
 *  · 打开对话框（FSA 句柄）／拖入（拿得到句柄）⇒ 记基准（带 mtime）+ 持久化句柄 + 持久权限引导；
 *  · 拖入（只有 `File`）／`<input>` 上传降级 ⇒ **不绑定**（草稿 + 另存为/导出）。
 * 收在一处的原因与项目里其它"一处口径"一样：三份实现必然漂（此前"打开对话框"与"上传降级"就是两份）。
 */
function adoptDoc(input: {
  name: string
  code: string
  /** 可写句柄；拿不到就 `null`（那一档不绑定，保存走另存为） */
  handle?: FileSystemFileHandle | null
  /** 句柄那次读到的 `lastModified`（走 mtime 快筛）；没有就 `null` */
  mtime?: number | null
  /**
   * adj969：这份 `.jps` 自己的**身份**（真实文件名 + 字节数 + 修改时间）。
   *
   * 为什么要它：网页 / PWA 里浏览器**不给文件句柄的父目录** ⇒ 相对路径的背景图读不到，
   * 唯一出路是让用户额外授权一次所在文件夹；而"用户选的目录对不对"只能靠
   * **同名 + 同字节数 + 同修改时间**来反证（见 `store/assetDirAuth.ts`）。
   */
  fileRef?: AssetFileRef | null
  /**
   * adj979：**桌面壳**才有的真实文件路径（如 `C:\Users\…\Desktop\望月.jps`）。
   *
   * 只用于一件事：判断"谱是不是放在**桌面 / 文档 / 下载**里" —— 那三个目录 Chromium
   * **直接禁止**网页授权（抛 `AbortError`，与"用户取消"同码、区分不出来），所以提示里要把
   * **原因**说清楚，而不是让用户对着"点了没反应"猜。判据是纯函数
   * `store/assetDirSensitive.ts` 的 `sensitiveDirLabelOf()`。
   * 网页 / PWA 一档永远是 `null`（浏览器不给路径，那一档也没有"被拦"这回事）。
   */
  nativePath?: string | null
  notice: string
  noticeKind?: 'ok' | 'warn' | 'error'
}): void {
  const { name, code, handle = null } = input
  const nativePath = input.nativePath ?? null
  const effectiveHandle = nativePath !== null ? null : handle
  fileStateTouched = true
  if (nativePath !== null) {
    // adj1156：原生路径 = 系统文件；基准键与双击打开同一口径（后续写盘前要比基准）
    setBaseline(bindingKeyOf({ kind: 'native', path: nativePath }), code, input.mtime ?? null)
    // 与原生路径互斥：清掉可能残留的浏览器句柄，避免"保存写回上一个文件"
    disconnectFileHandle()
  } else if (effectiveHandle) {
    /**
     * adj966：句柄绑定的**系统文件**要记基准 —— 这里能拿到 `lastModified`，
     * 所以基准带 mtime ⇒ 轮询可先走"mtime 快筛"，连内容都不用读（`probeFileChange` ①）。
     */
    setBaseline(bindingKeyOf({ kind: 'handle', name }), code, input.mtime ?? null)
    // adj161：打开的文件成为操作主体，句柄持久化（下次保存直接写回）
    void saveFileHandle(effectiveHandle)
    /**
     * adj966：**网页 / PWA 的持久权限引导**（用户口径：把权限选择交给用户）——
     * 刚打开一个文件时是唯一合适的时机（权限气泡刚出现过）。只提示一次、**不阻断**任何操作。
     */
    void guidePersistPermissionOnce(effectiveHandle, name)
  }
  try {
    localStorage.setItem(DRAFT_KEY, code)
    localStorage.setItem(DRAFT_NAME_KEY, name)
  } catch {
    /* 存储不可用时静默 */
  }
  // adj628：来源换成了这个本地文件 ⇒ 落盘的工作区来源必须清掉（否则下次加载又绑回老工作区文件）
  saveDraftSrc(null)
  // adj1156：原生路径要随草稿落盘（下次启动才恢复得回来）
  saveDraftNative(nativePath)
  // adj212：打开文件时同步 pageConfig——此前漏了 mergeJpsConfig，
  // 其它浏览器打开带 # jps-config 的谱时页面设置仍是打开前的旧值
  const cfg = resolveConfig(code)
  setDocState({
    code,
    fileName: name,
    parseResult: parseJps(code),
    pageConfig: cfg,
    dirty: false,
    fileHandle: effectiveHandle,
    // adj1156：原生打开时记真实路径；FSA 打开时保持 null（两者互斥）
    nativePath,
    // adj540：ditto，与工作区解绑
    binding: null,
    pendingBinding: null,
    activeNoteId: null,
    activeNoteIds: [],
    voiceBlocks: [],
    cursorJump: null,
    undoStack: [],
    redoStack: [],
    lastEditAt: 0,
    sel: { start: 0, end: 0 },
  })
  /**
   * adj969（**用户 2026-10-17 拍板**）：这份谱若写了**相对本谱的**背景图 / 水印图，而当前没有
   * 可用的"基准目录"，就**立刻问一句**"要不要授权它所在的文件夹"。
   *
   * 为什么必须在这里、而不是在别处：
   *  · 要读了配置才知道"这份谱到底需不需要目录" ⇒ 只能在装载之后；
   *  · 但**不能在这里直接弹文件夹对话框**：`showOpenFilePicker()` 已经把"用户手势"用掉了
   *    （`verify:app-ui` 真浏览器实测 `navigator.userActivation.isActive === false`）⇒ 直接弹必被拒。
   *    所以走"**应用内先问、用户点那一下再弹**"（见 `assetDirAuth.askAssetDirOnOpen` 的说明）；
   *  · 收在这一处：三条打开入口（对话框 / 拖入 / input 降级）都汇到本函数 ⇒ 不必各写一遍。
   * 不 await：装载动作是同步返回的，问那一句是"后台再问"，用户点「暂不」也不影响已经打开的文档。
   */
  const needAssets = localAssetRefs(cfg).length > 0
  if (nativePath !== null) {
    // 原生路径：只有"桌面/文档/下载"这三个浏览器禁授权目录需要解释原因；其它目录直接按路径读
    void askSensitiveDirOnNativeOpen(needAssets, name, nativePath)
  } else {
    void askAssetDirOnOpen(needAssets, input.fileRef ?? null, null)
  }
  useUiStore.getState().showNotice(input.notice, input.noticeKind ?? 'ok')
}

/** `adoptDoc` 用的 setter（模块级函数里拿不到 store 工厂的 `set`，走 zustand 的静态 setState） */
function setDocState(partial: Partial<DocState>): void {
  useDocStore.setState(partial)
}

/**
 * adj1156：桌面壳「打开」= 原生文件对话框 + 按绝对路径读文本。
 *
 * 与 FSA 路径的差别只有一点，但很关键：**知道文件在哪**。后续 Ctrl+S 写回原文件、
 * sidecar 写同目录、按路径读伴奏、相对图片基准都靠 `nativePath`。
 */
async function openFileNative(): Promise<boolean> {
  try {
    const path = await pickJpsFile()
    if (path === null) return false // 用户取消：静默
    const probe = await readNativeProbe(path)
    const name = fileBaseName(path)
    adoptDoc({
      name,
      code: probe.text,
      nativePath: path,
      mtime: probe.mtimeMs,
      notice: `${uiCopy.openOkPrefix}${name}.jps`,
    })
    console.info(`[iJipu] 原生打开文件：${path}`)
    return true
  } catch (e) {
    const reason = e instanceof Error ? `${e.name}${e.message ? `: ${e.message}` : ''}` : String(e)
    console.warn('[iJipu] 原生打开文件失败', e)
    useUiStore.getState().showNotice(`${uiCopy.openFailedPrefix}${reason}`, 'error')
    return false
  }
}

/**
 * adj1158：桌面壳「另存为」= 原生保存对话框 + Rust 一次写盘（含回读校验）→ 设置 `nativePath`。
 *
 * 用户口径（2026-10-25）：操作要简单统一，不能"另存为之后还要重开一次才能存 sidecar"。
 * 所以这里存完就是**普通原生文件**：Ctrl+S、sidecar、伴奏自动读全部按真实路径走，
 * 用户不需要再做任何额外动作。
 */
async function saveFileAsNative(): Promise<boolean> {
  const ui = useUiStore.getState()
  const st = useDocStore.getState()
  const nm = st.fileName
  const isNamed = !!nm && nm !== '未命名'
  const bTitle = st.parseResult.header.titles[0]
  const defaultName = isNamed ? nm : bTitle && bTitle !== '未命名' ? bTitle : '未命名'
  const code = st.code
  let path: string | null
  try {
    path = await saveJpsFileNative(`${defaultName}.jps`, code)
  } catch (e) {
    console.warn('[iJipu] 原生另存为失败', e)
    ui.showNotice(uiCopy.saveAsFailed, 'error')
    return false
  }
  if (path === null) return false // 用户取消：静默
  const name = fileBaseName(path)
  // 写盘成功：基准跟到新文件（以后"写盘前比基准"认的是它）
  setBaseline(bindingKeyOf({ kind: 'native', path }), code, null)
  saveDraftSrc(null)
  saveDraftNative(path)
  void saveFileHandle(null)
  useDocStore.setState({
    fileName: name,
    fileHandle: null,
    nativePath: path,
    binding: null,
    pendingBinding: null,
    // 保存对话框期间用户可能继续输入：内容变了就保留未保存标记
    dirty: useDocStore.getState().code !== code,
  })
  // 同一份谱换了路径：sync doc（锚点/音量/练习段）跟着接管，别被"换文件清理"清掉
  adoptSyncDocOwner({ fileName: name, nativePath: path, binding: null })
  ui.showNotice(`${uiCopy.saveOk} ${name}`, 'ok')
  console.info(`[iJipu] 原生另存为：${path}`)
  return true
}

function openFileViaInput(): Promise<boolean> {
  return new Promise((resolve) => {
    const mobile = isCoarsePointerDevice()
    const input = document.createElement('input')
    input.type = 'file'
    // adj281：桌面降级路径保留过滤（未知扩展在桌面浏览器上按文件名后缀匹配，能正常筛出 .jps）；
    // adj399：移动端（粗指针）不设 accept——见 fileInputAccept 注释（MIME 过滤会把 .jps 藏起来）
    const accept = fileInputAccept(mobile)
    if (accept !== null) input.accept = accept
    input.style.display = 'none'
    document.body.appendChild(input)
    let settled = false
    let gotFile = false
    let hinted = false
    /**
     * adj401：手机端**放弃选择**（关掉对话框没选文件）时给出可操作指引——
     * 用户实测「列表里能看到 .md 却看不到 .jps」：文件还在网盘/微信里（没落到本机）、
     * 或所选目录/网盘 SAF 按类型隐藏了未知扩展。这三条指引覆盖全部情况。
     * 只在移动端、且用户确实没选到文件时提示一次，不打扰正常流程。
     */
    const hintMobile = () => {
      if (!mobile || hinted) return
      hinted = true
      useUiStore.getState().showNotice(uiCopy.openPickHint, 'warn')
    }
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(ok)
    }
    // 用户取消（现代 Chrome/Edge/Firefox 触发 cancel 事件）
    input.addEventListener('cancel', () => {
      hintMobile()
      finish(false)
    })
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) {
        finish(false)
        return
      }
      gotFile = true
      try {
        const code = await file.text()
        const name = fileBaseName(file.name)
        // adj968：与"拖入"共用同一份装载实现（差别只是这里拿不到可写句柄 ⇒ 不绑定）
        // adj969：`fileRef` 仍要给——图是相对路径的话，用户还能额外授权一次所在文件夹
        adoptDoc({ name, code, fileRef: refOfFile(file), notice: uiCopy.openFallbackNotice, noticeKind: 'warn' })
        finish(true)
      } catch {
        finish(false)
      }
    })
    // 兜底：老内核无 cancel 事件时，窗口从文件选择框重新获焦且未选文件 → 视为取消
    const onFocus = () => {
      setTimeout(() => {
        if (!gotFile) {
          hintMobile() // adj401：老内核走这条兜底，同样给「找不到 .jps」的指引
          finish(false)
        }
      }, 300)
    }
    window.addEventListener('focus', onFocus)
    input.click()
    // adj405：兜底——个别移动外壳/PWA 里 `input.click()` 静默失败（既不弹选择器、也不触发
    // change/cancel，用户看到的就是"点了没反应"）。若 4 秒后仍无任何动静且页面始终有焦点
    // （说明我们从未被选择器抢走焦点），给一条可操作提示，别让用户干等。
    window.setTimeout(() => {
      if (settled || gotFile) return
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) return
      useUiStore.getState().showNotice(uiCopy.openPickerSilent, 'warn')
    }, 4000)
  })
}

// adj161：启动时恢复上次保存/打开的文件句柄（IndexedDB 持久化），
// 之后直接按保存即写回该文件（无需重新选文件）；恢复失败静默（走另存为）
void loadFileHandle().then((h) => {
  if (!h || fileStateTouched) return
  const name = fileBaseName(h.name)
  // adj363：句柄与草稿必须属于同一文件才恢复。句柄持久化是异步 fire-and-forget，
  // 若「新建/载入示例」后立刻退出应用，清空句柄的写入可能没落盘，下次启动会恢复出旧句柄，
  // 此时草稿已是另一份谱 → 按保存会把新谱写进旧文件。草稿名（DRAFT_NAME_KEY）始终标识
  // 草稿所属文件，与句柄名不一致即视为不同文件，不恢复句柄（下次保存走另存为）。
  const draftName = useDocStore.getState().fileName
  if (draftName && draftName !== name) return
  useDocStore.setState({ fileHandle: h, fileName: name })
  // adj628：新窗口/新标签（含浏览器自己开的那种）会走到这里 ⇒ **明确告知"这份草稿仍绑在它上面"**，
  // 否则用户会把它当成"新建出来的空谱"，改完一保存就把原文件覆盖了（真机复现见 E-2026-310）。
  useUiStore.getState().showNotice(uiCopy.restoredFile(name), 'warn')
})

// adj544：启动时恢复「这份草稿来自哪个工作区文件」——但只作为**待校验绑定**。
// 校验（工作区身份一致 + 权限已授予 + 文件仍在）通过后才真正绑定，之后「保存」才能写回原文件。
// 权限通常在重启后是 prompt ⇒ 这一步会"什么都不做"，等用户在面板里点一次授权后由
// `resolvePendingBinding()` 再试一次（申请权限必须在用户手势内，不能在这里硬要）。
//
// adj724b（用户实测）：**嵌入版里要给宿主的 `openFile` 让路**。
// 宿主推来的文件是异步到的，而这里是模块加载时立刻跑的 ⇒ 两边都会设置"当前文件"，
// 谁后到谁赢，表现为「我点了 A，界面显示的是上一次那份 B」。
void getWorkspace()
  .then(() => {
    if (shouldYieldBindingRestore()) {
      console.info('[iJipu] 嵌入版：宿主将推来文件 ⇒ 跳过启动时的"恢复上次绑定"')
      return false
    }
    return resolvePendingBinding()
  })
  .catch(() => {
    /* 无工作区/读库失败：保持未绑定，保存走另存 */
  })

/**
 * adj544：把**待校验绑定**升级成正式绑定（不改内容，只决定"保存能不能写回原文件"）。
 *
 * 三个条件全满足才升级：① 当前工作区就是绑定里那个（`wsId` 相同）；
 * ② 目录权限已授予（`queryWorkspacePermission`，只查不申请）；③ 绑定的那个文件仍然存在。
 * 任一不满足就保持 `pendingBinding`（界面据此提示"这份谱来自哪里"），**绝不**猜测性地写盘。
 */
export async function resolvePendingBinding(): Promise<boolean> {
  const st = useDocStore.getState()
  const pending = st.pendingBinding
  if (!pending) return false
  /**
   * adj724b（用户实测，**最终定位**）：**判断必须用"写之前"的实时状态，不能用开头那份快照。**
   *
   * 这段函数在 `await getWorkspace()` / `await queryWorkspacePermission()` / `await hasEntry()`
   * 之间会**让出主线程**，而宿主的 `openWorkspaceFile()`（用户点了库里的 `.jps`）正是在这些
   * 间隙里认领了绑定。此前本函数用的是**函数开头取的那份快照** `st`：
   *
   * | 时刻 | 本函数 | `openWorkspaceFile()`（宿主推来） |
   * |---|---|---|
   * | t1 | 读快照 `st`（binding 空）⇒ 通过守卫 | — |
   * | t2 | `await getWorkspace()` 挂起 | 认领 `binding = 痴情冢` |
   * | t3 | 恢复仍用**旧快照**判断 ⇒ 覆盖成茶花开了 | 已结束 |
   *
   * ⇒ 用户看到"点了 A 显示 B"。修法：在**落笔之前**重新读一次实时状态；
   * 只要此刻已经有绑定了（通常是宿主的 openFile 刚认领的），就放弃恢复。
   * 下面那次 `st.binding` 检查保留（早退，省掉后面的异步开销）。
   */
  if (st.binding) return false
  const ws = await getWorkspace()
  if (!ws) {
    console.info('[iJipu] 未恢复工作区绑定：当前没有工作区')
    return false
  }
  if (ws.id !== pending.wsId) {
    console.info(`[iJipu] 未恢复工作区绑定：绑定属于工作区 ${pending.wsName || pending.wsId}，当前是 ${ws.name}`)
    return false
  }
  const perm = await queryWorkspacePermission(ws)
  if (perm !== 'granted') {
    console.info(`[iJipu] 未恢复工作区绑定：目录权限为 ${perm}（需用户手势里重新授权）`)
    return false
  }
  const segs = pending.segs
  /**
   * adj628（纵深防御）：**草稿名必须与绑定文件名一致**才恢复——与 `loadFileHandle()` 那条口径相同。
   *
   * 为什么还要这道保险：来源绑定是**另一把键**（`DRAFT_SRC_KEY`）落盘的，任何"解绑了内存但没落盘"
   * 的路径（新建/载入示例/粘贴导入/换本地文件……）都会让它活到下一次加载，把老文件重新绑到**别的**草稿上。
   * 本轮已给那些路径都补了 `saveDraftSrc(null)`；这里再按"草稿属于哪个文件"复核一次，
   * 万一以后又新增一条载入路径漏了清，也不会静默地把新内容写进老文件（E-2026-310）。
   */
  const draftName = st.fileName
  const bindBaseName = fileBaseName(segs[segs.length - 1] ?? '')
  if (draftName && bindBaseName && draftName !== bindBaseName) {
    console.info(
      `[iJipu] 不恢复工作区绑定：草稿名(${draftName})与绑定文件(${joinPath(segs)})不是同一份` +
        `（多半是新建/换文件后残留的来源记录）`,
    )
    useDocStore.setState({ pendingBinding: null })
    return false
  }
  if (!(await hasEntry(ws, segs.slice(0, -1), segs[segs.length - 1]))) {
    console.info(`[iJipu] 未恢复工作区绑定：${joinPath(segs)} 已不在工作区里`)
    return false
  }
  /**
   * adj724b：**落笔前再读一次实时状态**（关键，见函数开头的说明）。
   *
   * 上面的 `await` 期间，宿主的 `openWorkspaceFile()` 可能刚刚认领了绑定
   * （用户点了库里的另一份 `.jps`）——那时**它才是用户要的**，恢复必须让路。
   * 否则会把刚打开的那份覆盖成"上一次的那份"（用户实测：「点 A 显示 B」）。
   */
  const now = useDocStore.getState()
  if (now.binding) {
    console.info(
      `[iJipu] 放弃恢复绑定：${joinPath(segs)}（期间已有更新的绑定：${joinPath(now.binding.segs)}）`,
    )
    // 清掉过期的待恢复项，避免它下次又冒出来覆盖
    useDocStore.setState({ pendingBinding: null })
    return false
  }
  /**
   * adj966（用户口径）：**PC 端逐步退出"工作区"这种操作方式** —— 打开/保存一律走系统文件，
   * 所以桌面壳里**不再自动接管**上次的"原生目录工作区"绑定（`'path'` 后端）。
   *
   * 为什么只挡 `'path'`：插件嵌入版的"工作区"就是 OB 文库（`'vault'`，用户口径是"默认以文库为主工作区"），
   * 网页版的目录句柄（`'fsa'`）也还没轮到 —— 按"逐步逐端退出"的顺序，本轮只动桌面壳。
   * 不自动恢复 ≠ 不能用：在工作区面板里**显式**打开一个文件，绑定照样建立（那条路不经这里）。
   */
  if (isPathWorkspace(ws)) {
    console.info(`[iJipu] 不自动接管原生目录工作区绑定：${joinPath(segs)}（PC 已改为默认直接操作系统文件）`)
    /**
     * **明确告知一次**（本会话只提示一次）：用户不该因为"没自动打开"而以为文件丢了。
     * 这不是错误 ⇒ 用 `ok` 级提示；工作区仍然可用（面板里显式打开）。
     */
    if (!pcWorkspaceNoticeShown) {
      pcWorkspaceNoticeShown = true
      useUiStore.getState().showNotice(workspaceCopy.pcNoAutoOpen, 'ok')
    }
    useDocStore.setState({ pendingBinding: null })
    return false
  }
  useDocStore.setState({ binding: pending, pendingBinding: null })
  // adj628：**成功恢复绑定**时给一句"保存会写回它"的明确提示——新窗口/新标签（含浏览器自己开的窗口）
  // 都会走到这里，用户很容易把这种窗口当成"新建出来的空谱"，改完一保存就覆盖了原文件
  // （用户报的正是"Ctrl+N 后状态栏还是上一个文件名"，真机复现见 E-2026-310）。
  // `bindingRestored`（"重新授权后即可写回"）留给**待授权**那种情况（见 WorkspacePanel 的提示行）。
  useUiStore.getState().showNotice(uiCopy.restoredFile(joinPath(segs)), 'warn')
  console.info(`[iJipu] 已恢复工作区绑定：${joinPath(segs)}`)
  return true
}
