/**
 * ui/dock/WorkspacePanel.tsx — 工作区面板（adj540，dock 内）
 *
 * 为什么放在**底栏 dock** 而不是弹窗：与「试听 / 导出 / 设置 / 关于」保持同一套操作行为
 * （面板互斥、可调高度、不遮谱面）——这正是 adj462/adj492 定下的约定（用户要求一致）。
 *
 * 它是移动端的"文件管理器"：手机上没有双击打开这回事，系统文件选择器对 `.jps` 这种自定义扩展名
 * 态度不一致（按 MIME 隐藏、只能看到已下载的文件），保存用的 `showSaveFilePicker` 在移动端还
 * 出现过"点了没反应"（adj405）。工作区一次授权后就都在这个文件夹里操作，**支持子目录**。
 *
 * 布局（adj540 用户要求）：**左侧列表 + 右侧操作按钮**——
 * 此前"每行展开操作菜单 + 底部按钮行"会吃掉列表的行数（手机上尤其明显）；
 * 现在操作集中到右侧，行数全留给文件列表。
 *
 * 交互模型（用户要求加复选框后定型）：
 *  · **点文件名/图标 = 打开（目录则进入）** —— 一步到位，不需要点两次；
 *  · **点前面的复选框 = 选中**（可多选）—— 右侧「操作」里的 改名/移动/删除 作用在选中项上。
 *    两件事互不打架：想删就勾，想看就点。
 *
 * 右侧按钮用**分组下拉**（用户建议"按钮别铺太多"）：默认 打开 / 保存▾ / 新建▾ / 操作▾ 四个，
 * 同一时刻只展开一组，最多 5 个按钮 ⇒ 窄屏不用滚动，按钮高度也保持与其它按钮一致（不靠压扁）。
 *
 * 文件操作与安全约束（都是用户确认的行为）：
 *  · 打开 / 保存 / 另存 / 新建（空谱）/ 新建目录 / 改名 / 移动 / 删除；
 *  · **改名与移动**：FSA 对用户选中的目录**没有 `move()`**（只对 OPFS 生效）⇒ 实现是
 *    "读出 → 写新位置 → 回读校验一致 → 才删原文件"，中途失败宁可留重复也不丢内容；
 *  · **删除是永久的**（浏览器文件 API 没有回收站）⇒ 必须二次确认；目录**只允许删空的**
 *    （递归删目录会把用户放在里面的照片/文档一起删掉）；
 *  · 列表**每次打开都重读**（用户确认）：手机上刚用系统工具/微信存进来的 `.jps` 能立刻看到。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { resolvePendingBinding, useDocStore } from '../../store/docStore'
import { useUiStore } from '../../store/uiStore'
import { workspaceCopy } from '../../brand/copy'
import { fileBaseName } from '../../store/saveSupport'
// adj723z：「最近…」二级菜单的登记（文件菜单里那一项的数据源）
import { recordRecentFile } from '../../store/recentFiles'
import type { WorkspaceRecord } from '../../store/fileHandleDb'
import { ToolIcon } from '../ToolIcon'
// adj585（用户要求）：长说明收进可点击展开的 `?` 徽标（触屏也能看），不再常驻占高度
import { HelpBadge } from '../HelpBadge'
import {
  absoluteDirOf,
  activateWorkspace,
  dedupeWorkspaceRecord,
  filterHitsInScope,
  flushWorkspacePath,
  forgetWorkspace,
  getWorkspace,
  indexScopeKey,
  isJpsName,
  isPathWorkspace,
  isWorkspaceAvailable,
  joinPath,
  listWorkspaces,
  compileQuery,
  parentPath,
  pickWorkspaceDir,
  queryWorkspacePermission,
  readDirEntries,
  rememberWorkspacePath,
  requestWorkspacePermission,
  resolveExistingDir,
  searchWorkspaceJps,
  setWorkspace,
  stripJpsExt,
  supportsPathWorkspace,
  type DirEntry,
  type SearchHit,
  type SearchResult,
} from '../../store/workspace'
import { isHostEmbedded } from '../../store/hostBridge'
// adj1305：桌面壳"在文件管理器打开当前目录"（Tauri 命令 open_local_path）
import { openLocalPath } from '../../store/externalOpen'
import { loadWorkspaceIndex, saveWorkspaceIndex } from '../../store/fileHandleDb'
import { INDEX_STALE_MS, getInflightWarmScan, markWorkspaceDataChanged } from '../../store/workspaceIndexWarm'

/** 「选择文件夹」静默失败的判定时间（超过它还没弹选择框就提示，而不是让用户干等） */
const PICKER_NO_RESPONSE_MS = 5000

/**
 * adj546：过滤结果**最多渲染多少行**（索引仍是全量）。
 * 手机上一次渲染 5499 行要 ~600ms（实测），而用户不可能靠滚动翻 5000 行——
 * 封顶后 `*`/过滤都是"秒出"，余量让他用关键词缩小范围（列表底部有提示）。
 */
const RESULT_RENDER_MAX = 300

/**
 * adj546：落盘索引的**保鲜期**——过期才在后台重扫。
 * 为什么不是"每次打开面板都重扫"：手机上扫一遍 5550 文件要几十秒（用户实测 27s），
 * 每次进面板都跑一遍是灾难。30 分钟内直接用落盘索引（秒开），过期或用户手动「重新扫描」才重扫。
 *
 * adj599：常量移到 `store/workspaceIndexWarm.ts`（启动后台预热也用同一个）——**一处维护**。
 */

/** 正在编辑的输入框：重命名 / 新建夹 / 另存 / 新建谱（四者共用同一个输入区） */
type EditState = { kind: 'rename' | 'newFolder' | 'saveAs' | 'newScore'; value: string; name?: string }

/** 输入区的标题与占位符（四种用途只差这两个字段，避免在 JSX 里堆三元） */
const EDIT_META: Record<EditState['kind'], { label: string; placeholder: string }> = {
  rename: { label: workspaceCopy.actRename, placeholder: workspaceCopy.renamePlaceholder },
  newFolder: { label: workspaceCopy.actNewFolder, placeholder: workspaceCopy.folderNamePlaceholder },
  saveAs: { label: workspaceCopy.actSaveAs, placeholder: workspaceCopy.namePlaceholder },
  newScore: { label: workspaceCopy.actNewScore, placeholder: workspaceCopy.newScorePlaceholder },
}

/** "移动到…"模式：**开跑时就把要搬的路径定下来**（随后可自由进子目录选目标，选中项不再变） */
type MoveState = { list: string[][] }

/** 删除确认：待删条目 + 摘要文案（单个显示名字，多个显示条数） */
type DelState = { items: { segs: string[]; kind: 'file' | 'dir' }[]; label: string }

export function WorkspacePanel() {
  const showNotice = useUiStore((s) => s.showNotice)
  const closeDock = useUiStore((s) => s.closeDock)
  const active = useUiStore((s) => s.dockOpen && s.dockPanel === 'workspace')
  const openWorkspaceFile = useDocStore((s) => s.openWorkspaceFile)
  const saveFile = useDocStore((s) => s.saveFile)
  const saveToWorkspace = useDocStore((s) => s.saveToWorkspace)
  const newWorkspaceScore = useDocStore((s) => s.newWorkspaceScore)
  const createWorkspaceDir = useDocStore((s) => s.createWorkspaceDir)
  const renameWorkspaceFile = useDocStore((s) => s.renameWorkspaceFile)
  const moveWorkspaceFiles = useDocStore((s) => s.moveWorkspaceFiles)
  const deleteWorkspaceEntries = useDocStore((s) => s.deleteWorkspaceEntries)

  const [ws, setWs] = useState<WorkspaceRecord | null>(null)
  const [path, setPath] = useState<string[]>([])
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [perm, setPerm] = useState<'granted' | 'prompt' | 'denied' | 'unknown'>('unknown')
  const [busy, setBusy] = useState(false)
  /**
   * adj547（用户反馈）：**进行中的提示文案**——点目录/文件、重新读取列表这些"要等"的动作，
   * 必须**立刻**在界面上显示"在做什么"（转圈 + 文案），否则用户分不清是"不能点/没响应/在忙"。
   * `busy` 负责禁用控件，`busyLabel` 负责把原因说出来。
   */
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  /**
   * **选中的条目名**（当前目录内，支持多选）。每行前面的复选框控制它；
   * 右侧「操作」里的 改名/移动/删除 作用在这些选中项上（用户要求）。
   */
  const [selected, setSelected] = useState<string[]>([])
  const [edit, setEdit] = useState<EditState | null>(null)
  const [moving, setMoving] = useState<MoveState | null>(null)
  const [confirmDel, setConfirmDel] = useState<DelState | null>(null)
  /**
   * adj540（用户报告"手机上打开进入子目录有点慢"）：**进入子目录的列表缓存**——用过一遍的路径
   * 留着，再次访问时（"上级目录"返回、子目录之间跳转）**直接用缓存**。同时**减少 IndexedDB 写入**：
   * `rememberWorkspacePath` 只在面板打开/关闭时写一次，**不在每次导航时都写**（IndexedDB 写在 Android 上动辄 20-50ms，
   * 是慢的次要来源）。整张缓存只在任何写操作（重命名/删除/新建/移动）后清空——写之后缓存里的列表已过期。
   */
  const entriesCacheRef = useRef<Map<string, DirEntry[]>>(new Map())
  /** 当前路径的 ref（供 effect 读取，避免把 `path` 加进依赖导致 effect 反复重跑） */
  const pathRef = useRef<string[]>([])
  pathRef.current = path
  /** adj540（用户报告 `*` 列不出文件）：搜索期间读不动的目录名——**主动告知**而非静默 */
  const [, setBlockedDirs] = useState<string[]>([])
  /**
   * adj540（用户要求）：**过滤框**——默认为层级列表（进目录逐级浏览）；一旦输入过滤词，
   * 就把**整个工作区（含子目录）**里符合条件的 `.jps` 收成**平坦列表**，点一条直接打开。
   * `hits === null` 表示"当前没在过滤"（走层级模式）。
   */
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  /** 命中数被上限截断（"没搜到"与"没搜完"要分开告诉用户，见 E-2026-247） */
  const [hitsTruncated, setHitsTruncated] = useState(false)
  const searching = query.trim().length > 0
  /**
   * adj543：**整个工作区 `.jps` 的索引**（首次过滤时走一次树建好，之后输入只在内存里 filter）。
   * 写操作后作废（`invalidateCache` 一并清掉）。
   */
  const indexRef = useRef<SearchHit[] | null>(null)
  const idxMetaRef = useRef<{ truncated: boolean; blocked: string[] }>({ truncated: false, blocked: [] })
  /**
   * adj580（用户反馈）：`indexRef` 里那份索引覆盖的**作用域**（`工作区id|起始目录`）。
   * 用户切到别的目录/别的工区后，旧索引不能再拿来过滤（否则看到的是别的目录的命中）。
   */
  const indexKeyRef = useRef<string | null>(null)
  /** adj546/adj588：扫描进度（让 UI 边扫边显示，不再干等）；"是否在扫"由 `scanPromiseRef` 判断 */
  const [scanInfo, setScanInfo] = useState<{ scanned: number; found: number; ms: number } | null>(null)
  /**
   * adj589：当前内存索引的**时间戳**（落盘索引的 `at` 或本次扫描完成时刻）——
   * 决定"打开面板时要不要空闲重扫"（见 `ensureIndexFresh`）。
   */
  const indexAtRef = useRef(0)
  /** 索引版本号：索引内容变化（载入缓存/扫描进度/重扫完成）就 +1，驱动过滤重新计算 */
  const [indexVersion, setIndexVersion] = useState(0)

  /**
   * adj546/adj588：**扫描整棵工作区**并把命中写进 `indexRef` + 落盘索引。
   *
   * adj588（用户反馈"手机上 `*` 过滤还是有点长"）改了三件事：
   *  ① **索引不再按目录分**（见 `indexScopeKey`）——进子目录不再重扫，只做前缀裁剪；
   *  ② **首次扫描也走这条**（以前"没有索引"那条路是"前台静默扫"，界面上什么都不显示，
   *     用户对着空列表等几十秒 ⇒ 现在从一开始就有"已扫描 N 项 / 找到 M 个"和渐进结果）；
   *  ③ **同一个扫描只跑一份**（`scanPromiseRef`）：前台首次扫描与后台刷新用同一个诺言，
   *     不再出现"用户一输入就前台扫一遍、同时后台又扫一遍"的双份枚举。
   *
   * 进度回调**节流到 1.2s 且只更新计数**（不复制数组、不触发过滤重算）——扫描过程被 UI 自己拖慢
   * 是 adj546 记过的坑（手机上尤其明显）。
   */
  const scanPromiseRef = useRef<Promise<SearchResult> | null>(null)
  /**
   * adj588：扫描**代际**。写操作（改名/新建/移动/删除/换工作区）会让正在跑的扫描结果作废——
   * 否则"扫描期间删除的文件"会被扫描结果重新写回索引（越写越错）。
   */
  const scanGenRef = useRef(0)
  const runScan = useCallback((rec: WorkspaceRecord, wsId: string, preferFirst: readonly string[] = []): Promise<SearchResult> => {
    if (scanPromiseRef.current) return scanPromiseRef.current
    /**
     * adj599：**启动后台预热可能正在扫同一个工作区** —— 直接复用那一次枚举
     * （同一份数据没必要跑两遍，E-2026-277 同类教训）。代价是这次没有"已扫描 N 项"的渐进显示，
     * 但预热本来就已经扫了一部分，用户看到的是"稍等一下就出结果"。
     */
    const warm = getInflightWarmScan(wsId)
    if (warm) {
      setScanInfo({ scanned: 0, found: indexRef.current?.length ?? 0, ms: 0 })
      const reuse = (async (): Promise<SearchResult> => {
        try {
          const r = await warm
          /**
           * adj607（E-2026-296）：预热那次同样可能是"整棵树都没读到"（它只在已授权时才扫，
           * 但授权可能在扫描途中被撤）——与下面主路径同一口径：**空结果不许装进索引**。
           */
          if (r.blocked.includes('')) return { hits: indexRef.current ?? [], ...idxMetaRef.current, scanned: r.scanned }
          indexRef.current = r.hits
          indexKeyRef.current = indexScopeKey(rec)
          indexAtRef.current = Date.now()
          idxMetaRef.current = { truncated: r.truncated, blocked: r.blocked }
          setIndexVersion((v) => v + 1)
          return r
        } catch {
          return { hits: indexRef.current ?? [], ...idxMetaRef.current, scanned: 0 }
        } finally {
          scanPromiseRef.current = null
          setScanInfo(null)
        }
      })()
      scanPromiseRef.current = reuse
      return reuse
    }
    const gen = scanGenRef.current
    const t0 = Date.now()
    setScanInfo({ scanned: 0, found: indexRef.current?.length ?? 0, ms: 0 })
    let lastShown = 0
    const p = (async (): Promise<SearchResult> => {
      try {
        /**
         * adj607（E-2026-296，用户反馈"`*` 过滤无索引内容出来，要点进有 jps 的目录后才有"）：
         * **没授权就别扫**。
         *
         * 未授权的目录句柄（刷新/重开后浏览器把权限重置成 `prompt`）读取原语一律抛
         * `NotAllowedError` ⇒ 整棵树每个目录都会进 `blocked`、`hits` 为 0。而这份"0 命中"的结果
         * 以前会被当成**扫描成功**：装进内存索引 + 落盘 + 弹"索引完成：0 个谱"，
         * 于是 `filterFromIndex()` 认它（空数组也是"有索引"）⇒ **后续按 `*` 永远不再重扫**，
         * 用户看到的就只有 `patchIndexDir` 顺路攒下的"自己点进去过的目录"的谱。
         *
         * 授权只能由用户手势触发（启动/挂载时静默申请会被浏览器拒绝），所以这里只能**如实拒绝扫描**；
         * 授权成功后三条入口（点当前工作区项授权 / 选新目录 / 从清单切过去）都会重新准备索引。
         */
        const perm = await queryWorkspacePermission(rec)
        if (perm === 'denied' || perm === 'prompt') {
          useUiStore.getState().showNotice(workspaceCopy.indexNeedGrant, 'warn')
          return { hits: indexRef.current ?? [], ...idxMetaRef.current, scanned: 0 }
        }
        const r = await searchWorkspaceJps(rec, '', {
          maxHits: 20000,
          maxEntries: 200000,
          // adj588：先扫**用户当前所在目录**那一支——整树索引照旧，只是让"我自己的谱"最先出来
          preferFirst,
          onProgress: (scanned, partial) => {
            setScanInfo({ scanned, found: partial.length, ms: Date.now() - t0 })
            const now = Date.now()
            // 第一次报告一定通过（`lastShown` 从 0 起）⇒ 用户刚授权就按 `*` 时，第一份部分结果
            // 立刻可见、之后每 1.2s 越长越多；节流只为限制"扫描期间"的重渲染频率（adj546）。
            if (now - lastShown < 1200) return
            lastShown = now
            if (gen !== scanGenRef.current) return // 扫描期间动过文件 ⇒ 这批部分结果已过期
            indexRef.current = partial // 引用即可（不改动它），慢节流地让用户看到部分结果
            indexKeyRef.current = indexScopeKey(rec)
            setIndexVersion((v) => v + 1)
          },
        })
        if (gen !== scanGenRef.current) {
          // 扫描期间用户改过文件 ⇒ 这份结果已经不代表磁盘现状：丢掉，交给下一次过滤重扫
          indexRef.current = null
          indexKeyRef.current = null
          return { hits: [], truncated: false, blocked: [], scanned: r.scanned }
        }
        /**
         * adj607（E-2026-296）：**整棵树都没读到** ⇒ 这不是"工作区里没有谱"，而是"根本没扫到"
         * （根目录被拒 / 目录被删 / 授权被撤）。这种结果**绝不能装进索引、更不能落盘**：
         * 一份空索引会让过滤一直短路，用户再按 `*` 也不会重扫（正是上面那个现象的另一半）。
         * 保留已有索引（哪怕旧）比换成"空"要好，所以这里直接原样返回、什么都不改。
         */
        if (r.blocked.includes('')) {
          useUiStore.getState().showNotice(workspaceCopy.indexUnreadable, 'warn')
          return { hits: indexRef.current ?? [], truncated: false, blocked: [], scanned: r.scanned }
        }
        indexRef.current = r.hits
        indexKeyRef.current = indexScopeKey(rec)
        indexAtRef.current = Date.now()
        idxMetaRef.current = { truncated: r.truncated, blocked: r.blocked }
        const ms = Date.now() - t0
        await saveWorkspaceIndex({ wsId, from: '', at: Date.now(), relPaths: r.hits.map((h) => h.relPath) })
        // adj546：把"扫了多少、花了多久、每条多少钱"打出来——真机排查速度问题要靠这个数
        console.info(
          `[iJipu] 工作区索引完成：扫描 ${r.scanned} 项 / 命中 ${r.hits.length} 个 / ${ms}ms` +
            `（${r.scanned > 0 ? (ms / r.scanned).toFixed(2) : '0'}ms 每项）`,
        )
        // adj590（用户要求"索引操作时应该有提示消息"）：**建完说一声**——
        // 现在索引会在"打开面板/切工作区"后空闲时自己跑，不提示的话用户只看到列表突然变全。
        // 用 getState() 取 store action（不进依赖数组，保持 runScan 引用稳定）。
        useUiStore.getState().showNotice(workspaceCopy.indexReady(r.hits.length, (ms / 1000).toFixed(1)), 'ok')
        setIndexVersion((v) => v + 1)
        return r
      } catch {
        // 扫失败：保留已有索引（可能是落盘的旧索引），不打断用户——但要说一声（否则以为"就是没有这些谱"）
        useUiStore.getState().showNotice(workspaceCopy.indexFailed, 'warn')
        return { hits: indexRef.current ?? [], ...idxMetaRef.current, scanned: 0 }
      } finally {
        scanPromiseRef.current = null
        setScanInfo(null)
      }
    })()
    scanPromiseRef.current = p
    return p
  }, [])

  /**
   * adj588：**过期索引的后台重扫挪到浏览器空闲时段**——用户在手机上刚打开面板就点 `*` 时，
   * 那一下最需要的是"立刻看到上次的列表"，而不是同时跑一遍几十秒的枚举（还会和滚动/点击抢 FSA）。
   * `requestIdleCallback` 不可用时退回 1.2s 定时（也有"先让当前这一帧画完"的效果）。
   */
  const scheduleIdleScan = useCallback(
    (rec: WorkspaceRecord, wsId: string) => {
      const run = (): void => void runScan(rec, wsId, pathRef.current)
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
        .requestIdleCallback
      if (typeof ric === 'function') ric(run, { timeout: 3000 })
      else window.setTimeout(run, 1200)
    },
    [runScan],
  )

  /**
   * adj543/adj546/adj588：**确保有索引可用**——
   * ① 内存里已有（且是本工作区的）⇒ 直接用；② 否则先读**落盘的整树索引**（秒出，可能略旧）
   * 并在**空闲时**后台重扫；③ 都没有 ⇒ **带进度地扫一次**（立刻有进度与渐进结果，不再静默空等）。
   * `useCallback` 保证引用稳定（E-2026-249：进依赖的必须是稳定引用）。
   *
   * adj580/adj588：过滤范围仍是"当前目录及其下级"，但**不再靠"按目录分别索引"实现**，
   * 而是拿整树索引做 `filterHitsInScope()` 前缀裁剪（见 `workspace.ts`——换目录零扫描）。
   */
  const buildIndex = useCallback(
    async (rec: WorkspaceRecord, wsId: string, force = false): Promise<SearchResult> => {
      const key = indexScopeKey(rec)
      if (indexRef.current && indexKeyRef.current === key && !force) {
        return { hits: indexRef.current, ...idxMetaRef.current, scanned: 0 }
      }
      const cached = force ? null : await loadWorkspaceIndex(wsId, '')
      if (cached && cached.relPaths.length > 0) {
        const hits = cached.relPaths.map((relPath) => {
          const segs = relPath.split('/')
          return { name: segs[segs.length - 1], relPath, dirSegs: segs.slice(0, -1) }
        })
        indexRef.current = hits
        indexKeyRef.current = key
        idxMetaRef.current = { truncated: false, blocked: [] }
        setIndexVersion((v) => v + 1)
        if (Date.now() - (cached.at ?? 0) > INDEX_STALE_MS) scheduleIdleScan(rec, wsId)
        return { hits, truncated: false, blocked: [], scanned: 0 }
      }
      // adj588：首次扫描也**先扫当前目录**，让用户马上看到自己这个目录里的谱
      return await runScan(rec, wsId, pathRef.current)
    },
    [runScan, scheduleIdleScan],
  )

  /**
   * adj589：**打开面板时就把索引准备好**（内存里没有就先装落盘的；缺失/过期就**空闲时**扫起来）。
   *
   * 为什么：用户实测"27 秒 → 20 秒"，那 20 秒就是他**第一次按 `*`** 时的那次整树扫描。
   * 把它挪到"打开工作区面板"之后的空闲时段 ⇒ 多数情况下用户点 `*` 时索引已经就绪（秒开），
   * 最坏也只是"边看文件列表边在后台扫"，而不是"点下去之后干等"。
   * 找不到索引就**不 pretend**：照样显示进度，并在扫到一半时给出渐进结果（adj588）。
   */
  const ensureIndexFresh = useCallback(
    async (rec: WorkspaceRecord): Promise<void> => {
      const key = indexScopeKey(rec)
      const memFresh =
        !!indexRef.current && indexKeyRef.current === key && Date.now() - indexAtRef.current <= INDEX_STALE_MS
      if (memFresh) return
      if (!indexRef.current || indexKeyRef.current !== key) {
        const cached = await loadWorkspaceIndex(rec.id, '')
        if (cached && cached.relPaths.length > 0) {
          indexRef.current = cached.relPaths.map((relPath) => {
            const segs = relPath.split('/')
            return { name: segs[segs.length - 1], relPath, dirSegs: segs.slice(0, -1) }
          })
          indexKeyRef.current = key
          indexAtRef.current = cached.at ?? 0
          idxMetaRef.current = { truncated: false, blocked: [] }
          setIndexVersion((v) => v + 1)
          // 落盘索引够新鲜就直接用；过期才**空闲时**重扫（不占用户当前这一下）
          if (Date.now() - (cached.at ?? 0) > INDEX_STALE_MS) scheduleIdleScan(rec, rec.id)
          return
        }
      }
      // 内存、落盘都没有（或内存那份已过期）⇒ 空闲时先把整树扫起来，用户待会儿一过滤就是秒开
      scheduleIdleScan(rec, rec.id)
    },
    [scheduleIdleScan],
  )

  /**
   * adj589（用户反馈"写操作之后还得整棵重扫一遍"）：**把"刚列出来的这一层"并回过滤索引**。
   *
   * 写操作（改名/另存/新建谱/移动/删除）之后，此前一律 `invalidateCache()` 丢掉整棵索引 ⇒
   * 下一次过滤要么吃旧快照、要么整树重扫（真机 20s 量级）。而写操作**只会改动当前这一层**，
   * 且 `refresh()` 紧接着就会拿到这一层的最新列表 ⇒ 直接拿它**局部替换**索引里这一层的命中即可：
   * 零额外 IO、结果立刻正确、整树索引仍然有效。
   * `persist=true` 时才落盘（导航时也走这里，但导航不该写 IndexedDB——Android 上一次 20-50ms）。
   */
  const patchIndexDir = useCallback(
    (rec: WorkspaceRecord, dirSegs: readonly string[], list: DirEntry[], persist: boolean): void => {
      const idx = indexRef.current
      if (!idx) return
      const prefix = joinPath(dirSegs)
      const withSep = prefix ? `${prefix}/` : ''
      // 只替换"本层文件"的命中（子目录里的命中不归这一层管）
      const atThisLevel = (relPath: string): boolean =>
        relPath.startsWith(withSep) && !relPath.slice(withSep.length).includes('/')
      const next = idx.filter((h) => !atThisLevel(h.relPath))
      for (const e of list) {
        if (e.kind !== 'file' || !isJpsName(e.name)) continue
        next.push({ name: e.name, relPath: joinPath([...dirSegs, e.name]), dirSegs: [...dirSegs] })
      }
      indexRef.current = next
      indexAtRef.current = Date.now()
      setIndexVersion((v) => v + 1)
      if (persist) {
        void saveWorkspaceIndex({ wsId: rec.id, from: '', at: Date.now(), relPaths: next.map((h) => h.relPath) })
      }
    },
    [],
  )

  /** adj589：删除**目录**时把该子树下的命中一并摘掉（`patchIndexDir` 只管本层） */
  const dropIndexSubtrees = useCallback((rec: WorkspaceRecord, dirs: readonly string[][]): void => {
    const idx = indexRef.current
    if (!idx || dirs.length === 0) return
    const prefixes = dirs.map((d) => `${joinPath(d)}/`)
    indexRef.current = idx.filter((h) => !prefixes.some((p) => h.relPath.startsWith(p)))
    indexAtRef.current = Date.now()
    setIndexVersion((v) => v + 1)
    void saveWorkspaceIndex({ wsId: rec.id, from: '', at: Date.now(), relPaths: indexRef.current.map((h) => h.relPath) })
  }, [])
  /**
   * adj540（用户要求）：右侧**只留一个下拉按钮**「操作」——点它**弹出菜单**再选具体操作。
   * 为什么必须用 portal：dock 容器是 `overflow: hidden`，就地展开的浮层会被裁掉
   * （内联展开又会挤占列表行数），所以菜单渲染到 `document.body` 并 `position: fixed` 锚在按钮上方。
   */
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const menuBtnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  /** adj544：**最近工作区**（一键切回；重启后不用重新选目录） */
  const [recent, setRecent] = useState<WorkspaceRecord[]>([])
  /** adj544：正常视图里点「最近的工作区…」就地展开列表（不用切到形同虚设的空态视图） */
  const [showRecent, setShowRecent] = useState(false)
  /**
   * adj575（用户要求）：是否显示**工作区选择界面**——由标题左侧的「切换工作区目录」按钮打开，
   * 也可以在没有工作区 / 待授权 / 目录已不在时自动落在这里（见下面的 `if (choose || …)`）。
   * 语义是"**先列清单让人选**"，而不是一按就直接弹系统对话框。
   */
  const [choose, setChoose] = useState(false)
  /** adj544：待校验绑定（随草稿恢复，需要重新授权才能写回原文件）——只用于提示 */
  const pending = useDocStore((s) => s.pendingBinding)

  const selectedEntries = entries.filter((e) => selected.includes(e.name))
  const selectedFiles = selectedEntries.filter((e) => e.kind === 'file')
  const selCount = selectedEntries.length
  const hasDirSelected = selectedEntries.some((e) => e.kind === 'dir')
  const toggleSelect = (name: string) =>
    setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))

  /**
   * adj543（用户反馈"过滤筛选的速度很慢"）：**先建一次索引，之后每次输入只在内存里过滤**。
   *
   * 之前每次输入（debounce 200ms）都把整个工作区**递归重走一遍**（每层目录都是一次 FSA 调用），
   * 大工作区下每敲一个字都要等一轮遍历 ⇒ 明显卡顿。
   * 现在：首次过滤时整棵走一次（带更大的上限，因为只走一次），把全部 `.jps` 存进 `indexRef`；
   * 之后同一面板会话内的每次输入都只是 `Array.filter(matchesQuery)`（纯字符串比较，微秒级）。
   * 索引在**任何写操作**（改名/新建/另存/移动/删除）后作废（见 `invalidateCache`），下次过滤重建。
   *
   * adj580（用户反馈）：**范围 = 当前目录及其下级**（`from = path`）——
   * 所以目录一变，作用域键就变，旧索引自动作废（`filterFromIndex` 里比对 `indexKeyRef`），
   * 于是"在子目录里过滤"只看这一层子树，而不是把整个工作区翻一遍。
   */
  useEffect(() => {
    if (!ws || perm !== 'granted' || !searching) {
      setHits(null)
      return
    }
    let alive = true
    const from = path // adj580：当前目录（子目录过滤的作用域起点）
    const key = indexScopeKey(ws)
    /** 有索引（且**是本工作区的**）⇒ 同步过滤（零等待）；否则走一次建索引再过滤 */
    const filterFromIndex = (): boolean => {
      const idx = indexRef.current
      if (!idx || indexKeyRef.current !== key) return false
      // adj546：查询只编译一次（5000+ 条时别再每条 new RegExp）
      const match = compileQuery(query)
      // adj588：索引是**整棵树**的 ⇒ 先按当前目录裁剪作用域（纯函数，微秒级），再套查询条件
      setHits(filterHitsInScope(idx, from).filter((h) => match(h.name, h.relPath)))
      setHitsTruncated(idxMetaRef.current.truncated)
      setBlockedDirs(idxMetaRef.current.blocked)
      return true
    }
    if (filterFromIndex()) return
    void buildIndex(ws, ws.id)
      .then((r) => {
        if (!alive) return
        filterFromIndex()
        // 没搜完必须说出来：否则用户会以为"这里就没有这些谱"
        if (r.truncated) showNotice(workspaceCopy.searchTruncated(r.hits.length), 'warn')
        // 读不动的目录也说出来：不然 `*` 看不到就是"文件不见了"
        if (r.blocked.length > 0) showNotice(workspaceCopy.searchBlockedDirs(r.blocked), 'warn')
      })
      .catch(() => {
        if (alive) {
          setHits([])
          setHitsTruncated(false)
          setBlockedDirs([])
        }
      })
    return () => {
      alive = false
    }
  }, [ws, perm, query, searching, showNotice, buildIndex, indexVersion, path])
  /** 弹出菜单：点外面/按 Esc 关闭（菜单渲染在 portal 里，不在 dock 的裁剪范围内） */
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || menuBtnRef.current?.contains(t)) return
      setMenuOpen(false)
    }
    /**
     * adj608：**用捕获阶段把 ESC 吃掉**——菜单开着时按 ESC 只应关菜单，不该顺带把底栏最小化
     * （`ToolDock` 的 ESC 处理挂在 `<section>` 上，属于冒泡路径；document 的捕获先跑，
     * `stopPropagation` 之后它就收不到这个事件了）。菜单是 portal 到 body 的，不在底栏子树里，
     * 所以只能靠"抢在它前面消费"这一条路。
     */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenuOpen(false)
      e.stopPropagation()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [menuOpen])

  /** 打开菜单：按按钮位置定位（锚在按钮**上方**，因为 dock 在屏幕底部），并**夹进视口**：
   *  侧栏贴右边缘，若直接用按钮 left 会让菜单溢出屏幕右侧（实测 390px 视口溢出 56px）。 */
  const openMenu = () => {
    const r = menuBtnRef.current?.getBoundingClientRect()
    if (r) {
      const width = Math.max(r.width, 150)
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      setMenuPos({ left, bottom: window.innerHeight - r.top + 6, width })
    }
    setMenuOpen(true)
  }

  /** 写操作后**整张列表缓存都过期**——统一清空比按路径精确失效简单且足够（写不频繁） */
  /**
   * 写操作后**整张列表缓存都过期**——统一清空比按路径精确失效简单且足够（写不频繁）。
   *
   * ⚠️ **必须 `useCallback([])` 固定引用**（E-2026-249）：它进了 `refresh` 的依赖数组，
   * 而 `refresh` 又在"面板激活"effect 的依赖里——普通函数每次渲染都换新引用，
   * 会让 `refresh` 每次渲染都变 ⇒ effect 每渲染重跑 ⇒ `setState` ⇒ 再渲染……
   * **无限刷新循环**（表现为面板内容一直闪、点目录/文件没反应）。
   */
  const invalidateCache = useCallback(() => {
    entriesCacheRef.current.clear()
    /**
     * adj589（用户反馈"写操作之后还得整棵重扫"）：**不再丢掉过滤索引**——索引是整棵树的，
     * 而写操作只改动当前这一层，`refresh()` 拿到新列表后会由 `patchIndexDir()` **局部替换**那一层；
     * 整树索引因此一直有效 ⇒ 改完名/删完文件再按 `*` 依然是秒开（此前是"丢索引 → 整树重扫 20s"，
     * 或者"吃旧快照、新文件看不见"）。
     * 打开面板/切工作区也走这里：前者由 `ensureIndexFresh()` 决定要不要空闲重扫，
     * 后者靠 `indexKeyRef` 与 `wsId` 天然隔离（换工作区不会复用旧索引）。
     */
    // adj588：正在跑的扫描作废（代际 +1）——否则"扫描期间改名/删除"的结果会被写回索引。
    // 这里**只动 ref、不 setState**：`invalidateCache` 进了 `refresh` 的依赖链，
    // 在里面 setState 会把"渲染 → effect → setState"重新引回来（E-2026-249 那个无限刷新循环）。
    scanGenRef.current += 1
    /**
     * adj599：同时作废**启动后台预热**正在跑的那一次枚举（`gen` 是模块级的）——
     * 否则"预热扫描期间改名/删除"的结果会被预热当作可信结果**写回落盘索引**，
     * 下次打开面板就吃到一份错的索引。
     */
    markWorkspaceDataChanged()
  }, [])
  /**
   * 列目录（带缓存——同一路径再次访问直接走缓存，避免每次都打 IndexedDB / FSA）。
   * adj589：返回这一次真正用到的列表（缓存命中就返回缓存），供写操作之后**局部更新过滤索引**
   * （`patchIndexDir`）；同时**每次拿到新列表都顺手把索引里这一层对齐**（零额外 IO、
   * 记不记盘由 `persistIndex` 决定：导航不写盘，写操作写盘）。
   */
  const refresh = useCallback(
    async (rec: WorkspaceRecord, next: string[], label?: string, persistIndex = false): Promise<DirEntry[]> => {
      setBusy(true)
      setBusyLabel(label ?? workspaceCopy.refreshing) // adj547：立刻给出"在忙什么"
      const key = joinPath(next)
      /**
       * adj576（用户反馈"打开其它工作区后列表应重新刷新缓存"）：缓存键**必须带上工作区身份**——
       * 原先只按区内相对路径做键，于是"切到别的工作区、相对路径同为根目录"时会**命中上一个工作区的
       * 目录列表**（看到的是旧工作区的内容）。带上 `rec.id` 后，不同工作区天然是不同键。
       */
      const cacheKey = `${rec.id}|${key}`
      const cached = entriesCacheRef.current.get(cacheKey)
      if (cached) {
        setEntries(cached)
        setPath(next)
        setSelected([])
        setEdit(null)
        setConfirmDel(null)
        setBusy(false)
        setBusyLabel(null)
        patchIndexDir(rec, next, cached, persistIndex)
        return cached
      }
      try {
        const list = await readDirEntries(rec, next)
        entriesCacheRef.current.set(cacheKey, list)
        setEntries(list)
        setPath(next)
        setSelected([])
        setEdit(null)
        setConfirmDel(null)
        // adj548（用户反馈）：**进入目录就记住位置**——不能在关闭时才记：底栏收起/切页签时
        // 面板是直接卸载的，关闭分支跑不到，重开就永远回到根目录。
        void rememberWorkspacePath(next)
        patchIndexDir(rec, next, list, persistIndex)
        return list
      } catch (e) {
        const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        showNotice(workspaceCopy.loadFailed(reason), 'error')
        setEntries([])
        return []
      } finally {
        setBusy(false)
        setBusyLabel(null)
      }
    },
    [showNotice, patchIndexDir],
  )
  /**
   * adj550（用户要求，**一条规则**）：**进入工作区 ⇒ 定位到该工作区的最新位置**。
   *
   * 「授权」只是前置条件，不是另一条规则：
   *  · 未授权 ⇒ 先显示授权视图，**授权成功后**调用本函数；
   *  · 已授权 ⇒ 切页签回来 / 切到某个工作区 / 打开面板时**直接**调用本函数。
   * 位置已被外部删/移动 ⇒ 收敛到**仍存在的最外层**并提示（不会给空列表让人以为文件没了）。
   * 三条入口（激活 / 授权后 / 切工作区）都走这里，保证行为一致。
   *
   * 定义位置在 `refresh` 之后、激活 effect **之前**，并用 `useCallback` 固定引用——
   * 否则它进 effect 依赖会让激活 effect 每次渲染都重跑（E-2026-249 的无限刷新）。
   */
  const enterAtLatestPos = useCallback(
    async (rec: WorkspaceRecord, label: string) => {
      const want = rec.path ?? []
      const dir = await resolveExistingDir(rec, want)
      if (joinPath(dir) !== joinPath(want)) {
        showNotice(workspaceCopy.dirGone(joinPath(want) || '根目录', joinPath(dir)), 'warn')
      }
      await refresh(rec, dir, label)
    },
    [refresh, showNotice],
  )


  /**
   * **每次打开面板都重读**（用户确认）：从 IndexedDB 取最新工作区 → 只查权限（申请必须由用户手势触发）
   * → 有权限就重列目录（手机上刚存进来的 `.jps` 立刻可见）。
   * 收起面板时清掉展开态，避免下次打开还停在上次的重命名/删除确认上。
   */
  useEffect(() => {
    if (!active) {
      setSelected([])
      setEdit(null)
      setMoving(null)
      setConfirmDel(null)
      setMenuOpen(false)
      setQuery('')
      setHits(null)
      // adj575：收起面板时回到"文件列表"视图（下次打开不该还停在选择界面）
      setChoose(false)
      // adj540：路径记忆写在**关闭面板时**（打开时已经在 IDB 里读到了 ws.path），写一次就够。
      // 经 ref 读当前路径——不把 `path` 放进依赖数组（那样每次导航都会重跑本 effect）。
      void rememberWorkspacePath(pathRef.current).catch(() => {})
      return
    }
    let alive = true
    void (async () => {
      const rec = await getWorkspace()
      if (!alive) return
      setWs(rec)
      // adj576：顺手把**目录列表缓存**也清掉（它同理可能过期：用户在别的程序里增删过文件）
      // adj589：过滤索引**不再在这里丢掉**——改为交给 `ensureIndexFresh()`：内存里没有就装落盘的
      //（第一次过滤即秒开），缺失或过期才**空闲时**重扫。这样"打开面板"不再等于"下次过滤要等 20s"。
      invalidateCache()
      // adj544：读最近工作区列表（供"一键切回"），并尝试恢复绑定（权限已授予时）
      setRecent(await listWorkspaces())
      await resolvePendingBinding()
      // adj540：手机端「保存/另存」带过来的意图 ⇒ 直接把"另存"输入框展开（消费掉，不做持久化）
      if (rec && useUiStore.getState().workspaceSaveIntent) {
        setEdit({ kind: 'saveAs', value: fileBaseName(useDocStore.getState().fileName) })
        useUiStore.getState().clearWorkspaceSaveIntent()
      }
      if (!rec) return
      const q = await queryWorkspacePermission(rec)
      if (!alive) return
      setPerm(q)
      if (q === 'granted') {
        /**
         * adj550：**已授权 ⇒ 进入工作区直接定位到最新位置**（与"授权后"走同一个函数）。
         *
         * adj607（E-2026-296）：顺序是 **先列目录、再准备索引**——
         *  ① 索引只能在**已授权**之后准备（未授权扫描会读出"0 命中"并把空索引装进内存，
         *     见 `runScan` 里的授权门槛）；
         *  ② 首屏那一次列目录本来就慢（手机 FSA 每条一趟往返），索引扫描没必要跟它抢同一个通道。
         */
        await enterAtLatestPos(rec, workspaceCopy.loadingWorkspace)
        await ensureIndexFresh(rec)
      } else setBusy(false)
    })()
    return () => {
      alive = false
      // adj550：面板卸载时把"待写的目录位置"立刻落盘（刚进完目录就收起底栏/关页面也不丢）
      flushWorkspacePath()
    }
  }, [active, refresh, showNotice, enterAtLatestPos, invalidateCache, ensureIndexFresh])

  const onPick = async () => {
    if (!isWorkspaceAvailable()) {
      showNotice(workspaceCopy.unsupported, 'warn')
      return
    }
    setBusy(true)
    // 静默失败兜底：已安装的 PWA 里选择器可能不弹（adj405 的同类现象）
    const timer = window.setTimeout(() => showNotice(workspaceCopy.pickerNoResponse, 'warn'), PICKER_NO_RESPONSE_MS)
    try {
      // adj568：`pickWorkspaceDir()` 现在**分平台**——桌面壳走原生选择器拿绝对路径（路径后端），
      // 浏览器走 FSA 拿句柄（句柄后端）；返回的已是带身份的完整记录。
      const picked = await pickWorkspaceDir()
      if (!picked) return // 用户取消（网页版里也可能是"目录被内核黑名单拦下"——两句同一个 AbortError）
      /**
       * adj577（用户要求"相同的目录只能有一个工作区"）：选到的目录若**已经是历史工作区**
       * ⇒ 直接用历史那条（保留它的身份 id / 名字），不新建重复项。
       * 桌面端按绝对路径当身份（天然去重）；网页端用句柄的 `isSameEntry()` 比（原先每次重选
       * 同一个文件夹都会在清单里堆一个新工作区）。
       */
      const rec = await dedupeWorkspaceRecord(picked)
      await setWorkspace(rec)
      setWs(rec)
      setPerm('granted')
      // adj576（用户反馈）：换了工作区 ⇒ **目录列表缓存与过滤索引都必须作废**。
      // 原先只有"写操作"与"打开面板"会清（`invalidateCache`），切工作区时两条路都没走到，
      // 于是新工作区的根目录会命中上个工作区留下的 `'' → 旧列表` 缓存（看到上一个工作区的内容）。
      invalidateCache()
      setChoose(false) // adj575：选完就回到文件列表
      // adj590（用户反馈"切换工作区后，新的工作区好像没有索引"）：新工作区的索引**现在就准备好**
      // （内存/落盘命中即秒开；缺了就空闲时扫起来）——否则切过去第一次过滤又得干等一次整树扫描。
      await ensureIndexFresh(rec)
      await refresh(rec, [])
      setRecent(await listWorkspaces())
      showNotice(rec.id === picked.id ? workspaceCopy.picked(rec.name) : workspaceCopy.reused(rec.name), 'ok')
    } catch (e) {
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      showNotice(workspaceCopy.loadFailed(reason), 'error')
    } finally {
      window.clearTimeout(timer)
      setBusy(false)
    }
  }

  /**
   * adj1305（用户要求）：**在文件管理器打开当前目录**（面包屑右侧的图标按钮）。
   *
   * 只有桌面壳的**路径后端**有绝对路径（`absoluteDirOf` 返回 null ⇒ 按钮根本不渲染）；
   * 网页版 FSA 句柄与插件宿主桥都给不出系统路径，按口径"非适用端不给入口"。
   * 打开动作复用 `adj1183` 的 `open_local_path`（`reveal=false` = 用系统默认方式打开该路径；
   * 传目录时 Windows 就是资源管理器）。失败如实提示，不静默。
   */
  const openCurrentDir = async () => {
    const abs = absoluteDirOf(ws, path)
    if (abs === null) return
    try {
      await openLocalPath(abs, false)
    } catch (e) {
      showNotice(workspaceCopy.openDirFailed(e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  /** 补授权（用户点了按钮 ⇒ 手势成立）；adj544：授权成功后顺便尝试"恢复绑定到原文件" */

  /** 补授权（用户点了按钮 ⇒ 手势成立）；授权成功 = 满足前置条件 ⇒ 走同一条"定位到最新位置" */
  const onGrant = async () => {
    if (!ws) return
    setBusy(true)
    setBusyLabel(workspaceCopy.loadingWorkspace)
    try {
      const r = await requestWorkspacePermission(ws)
      setPerm(r === 'granted' ? 'granted' : r === 'denied' ? 'denied' : 'unknown')
      if (r === 'granted') {
        await enterAtLatestPos(ws, workspaceCopy.loadingWorkspace)
        /**
         * adj607（E-2026-296）：**刚授权 ⇒ 现在才开始准备索引**（与"打开面板"同序：先列目录再索引）。
         * 不补这一步的话，"刷新后重新授权"这条最常见的手机路径会一直停在"没有索引"，
         * 用户按下 `*` 时才现扫（真机 20s 量级）。
         */
        await ensureIndexFresh(ws)
        await resolvePendingBinding()
      }
    } finally {
      setBusy(false)
      setBusyLabel(null)
    }
  }

  /**
   * adj544（用户要求 C）：从"最近工作区"切回某个工作区。
   * 句柄可能已失效（目录被删/移动）⇒ 申请权限失败时如实提示，不静默失败。
   */
  const onActivate = async (rec: WorkspaceRecord) => {
    setBusy(true)
    try {
      const next = await activateWorkspace(rec.id)
      if (!next) {
        showNotice(workspaceCopy.activateFailed(rec.name), 'error')
        return
      }
      setWs(next)
      const r = await requestWorkspacePermission(next)
      if (r !== 'granted') {
        setPerm(r === 'denied' ? 'denied' : 'unknown')
        showNotice(workspaceCopy.activateFailed(next.name), 'warn')
        return
      }
      setPerm('granted')
      // adj576（用户反馈"打开其它工作区后列表应重新刷新缓存"）：切工作区 ⇒ 目录列表缓存作废
      invalidateCache()
      setChoose(false) // adj575：选完就回到文件列表
      // adj590：从"最近工作区"切过去时，同样**立刻把新工作区的索引准备好**（每个工作区各存一份，切回也是秒开）
      await ensureIndexFresh(next)
      // adj550：切换到某个工作区 = 又一条"进入工作区"的入口 ⇒ 同一条规则：定位到它的最新位置
      await enterAtLatestPos(next, workspaceCopy.loadingWorkspace)
      await resolvePendingBinding()
      showNotice(workspaceCopy.picked(next.name), 'ok')
    } catch (e) {
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      showNotice(workspaceCopy.loadFailed(reason), 'error')
    } finally {
      setBusy(false)
    }
  }

  /** 打开某一项（目录 ⇒ 进入；文件 ⇒ 打开并收起底栏）——**点行就是这件事**，不需先选中
   * adj540（用户反馈）：列表里点击文件名就能打开/进入，所以右侧独立的「打开」按钮意义不大——删除掉。
   * adj547（用户反馈）：目录**先进去**（面包屑立刻变、列表显示"正在进入…"），再去读里面的 `.jps`——
   * 点完马上有反馈，不会让人以为"点不动"；读失败则回滚路径。 */
  const openEntry = async (entry: DirEntry) => {
    if (!ws) return
    if (entry.kind === 'dir') {
      const next = [...path, entry.name]
      const prev = path
      setBusy(true)
      setBusyLabel(workspaceCopy.enteringDir(entry.name)) // 立刻反馈
      setPath(next) // 乐观更新面包屑：先"进目录"
      setSelected([])
      setEdit(null)
      setConfirmDel(null)
      try {
        await refresh(ws, next, workspaceCopy.enteringDir(entry.name))
      } catch {
        setPath(prev) // 读失败回滚
      } finally {
        setBusy(false)
        setBusyLabel(null)
      }
      return
    }
    setBusy(true)
    setBusyLabel(workspaceCopy.openingFile(entry.name))
    try {
      const ok = await openWorkspaceFile([...path, entry.name])
      if (ok) {
        /**
         * adj723z：**登记到「最近…」**（文件菜单的二级菜单，最多 10 条、最近在前）。
         * 身份 = 工作区 id + 相对路径（与 `docStore.binding` 同源），故换机器/换工作区也能对上号。
         * 登记失败不影响打开（`recordRecentFile` 内部已静默降级）。
         */
        void recordRecentFile({
          wsId: ws.id,
          wsName: ws.name,
          segs: [...path, entry.name],
          name: fileBaseName(entry.name),
        })
        closeDock()
      }
    } finally {
      setBusy(false)
      setBusyLabel(null)
    }
  }

  /** 移动模式下切换目标目录（不动已定的搬运清单） */
  const refreshMovingTarget = async (next: string[]) => {
    if (!ws) return
    setBusy(true)
    setBusyLabel(workspaceCopy.readingTarget) // adj547
    try {
      const list = await readDirEntries(ws, next)
      setEntries(list)
      setPath(next)
      void rememberWorkspacePath(next) // adj548：移动模式下选目标也记住
    } catch (e) {
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      showNotice(workspaceCopy.loadFailed(reason), 'error')
    } finally {
      setBusy(false)
      setBusyLabel(null)
    }
  }

  /** 提交输入区：改名 / 新建目录 / 另存 / 新建谱（四者共用一个输入框，故集中在这里分派） */
  const submitEdit = async () => {
    if (!ws || !edit) return
    const value = edit.value.trim()
    if (!value) return
    // adj589：写操作只作废**目录列表缓存**（过滤索引保留，随后由 `refresh` 的局部对齐更新那一层）
    invalidateCache() // adj540：写操作 ⇒ 列表缓存先作废（否则刷新时吃到旧列表）
    const segsOf = (raw: string): string[] => [...path, `${stripJpsExt(raw)}.jps`]
    if (edit.kind === 'rename' && edit.name) {
      const ok = await renameWorkspaceFile(path, edit.name, `${stripJpsExt(value)}.jps`)
      if (ok) {
        setEdit(null)
        await refresh(ws, path, undefined, true) // adj589：改名 ⇒ 索引这一层对齐并落盘
      }
      return
    }
    if (edit.kind === 'newFolder') {
      const ok = await createWorkspaceDir(path, value)
      if (ok) {
        setEdit(null)
        // adj558（v0.28.2，用户要求）：创建后**自动进入新目录**（与文件管理器一致），
        // 不再停在父目录让用户再点一次进去——空目录的 "当前目录为空" 占位 + 操作▾的
        // 「新建」/「另存」都立即可用，省一次手动导航。`refresh` 内部走 `resolveDir`
        // 按 segs 走到底层 `getDirectoryHandle`，新建的目录句柄即时生效。
        await refresh(ws, [...path, value], undefined, true)
      }
      return
    }
    if (edit.kind === 'saveAs') {
      const ok = await saveToWorkspace(segsOf(value))
      if (ok) {
        setEdit(null)
        await refresh(ws, path, undefined, true) // adj589：另存 ⇒ 新文件进索引
      }
      return
    }
    // newScore：在当前目录写一份空谱（沿用「新建」模板内容），写完直接打开它
    const ok = await newWorkspaceScore(segsOf(value))
    if (ok) {
      setEdit(null)
      await refresh(ws, path, undefined, true)
    }
  }

  /**
   * 「保存」：已绑定工作区文件 ⇒ 直接写回（`saveFile` 内部走工作区分支）；
   * **未绑定** ⇒ 转成「另存」（展开文件名输入）——不让它变成"按了没反应"的死路。
   */
  const onSave = async () => {
    if (!ws) return
    // adj544：绑定属于**当前**工作区 ⇒ 写回原文件；属于别的工作区 ⇒ 先讲清原因（否则用户只看到
    // "保存怎么变成另存了"），再展开另存输入框让他决定存到哪儿（绝不静默写进当前工作区）
    const bind = useDocStore.getState().binding
    if (bind && bind.wsId === ws.id) {
      await saveFile()
      await refresh(ws, path, undefined, true) // adj589：写回 ⇒ 索引这一层对齐并落盘
      return
    }
    if (bind && bind.wsId !== ws.id) {
      showNotice(workspaceCopy.boundToOtherWorkspace(bind.wsName || '另一个工作区', ws.name, joinPath(bind.segs)), 'warn')
    }
    setEdit({ kind: 'saveAs', value: fileBaseName(useDocStore.getState().fileName) })
  }

  /** 进入"移动到…"模式：把当前选中的**文件**路径定下来（目录不支持移动） */
  const startMove = () => {
    setMenuOpen(false)
    if (selectedFiles.length === 0) {
      showNotice(workspaceCopy.moveDirUnsupported, 'warn')
      return
    }
    setMoving({ list: selectedFiles.map((e) => [...path, e.name]) })
  }

  const submitMove = async () => {
    if (!ws || !moving) return
    // adj589：移动只影响**当前这一层**（源与目标都在当前目录）⇒ 不丢索引，随后局部对齐
    invalidateCache() // adj540：移动会改动源目录与目标目录两处列表
    const ok = await moveWorkspaceFiles(moving.list, path)
    if (ok) {
      setMoving(null)
      await refresh(ws, path, undefined, true)
    }
  }

  const startDelete = () => {
    setMenuOpen(false)
    if (selCount === 0) return
    setConfirmDel({
      items: selectedEntries.map((e) => ({ segs: [...path, e.name], kind: e.kind as 'file' | 'dir' })),
      label:
        selCount === 1
          ? selectedEntries[0].kind === 'file'
            ? workspaceCopy.deleteFileConfirm(selectedEntries[0].name)
            : workspaceCopy.deleteDirConfirm(selectedEntries[0].name)
          : workspaceCopy.deleteManyConfirm(selCount),
    })
  }

  const doDelete = async () => {
    if (!ws || !confirmDel) return
    setBusy(true)
    try {
      invalidateCache() // adj540：删除后列表缓存作废
      const deletedDirs = confirmDel.items.filter((it) => it.kind === 'dir').map((it) => it.segs)
      const ok = await deleteWorkspaceEntries(confirmDel.items)
      setConfirmDel(null)
      if (ok) {
        // adj589：删掉的**目录**要把整棵子树的命中摘掉（本层文件的增删由 refresh 的局部对齐负责）
        if (deletedDirs.length > 0) dropIndexSubtrees(ws, deletedDirs)
        await refresh(ws, path, undefined, true)
      }
    } finally {
      setBusy(false)
    }
  }

  const crumb = path.length > 0 ? joinPath(path) : (ws?.name ?? '')
  /**
   * 工作区目录的**可读路径**：
   *  · 桌面**路径后端**（adj568）= 完整磁盘路径（`D:\谱\小星星`）——原生选择器给的就是路径；
   *  · 网页 FSA = `文件夹名 / 子目录 / …`。
   * ⚠️ FSA 只给文件夹名（`handle.name`），**拿不到完整磁盘路径**（隐私限制，`resolve()` 也只能算区内相对路径）
   * ⇒ 授权提示里就显示这个，并在旁边说明原因（用户要求"授权时要显示要授权的目录"）。
   * 分隔符跟随根路径本身（Windows `\` / 其它 `/`），免得显示成 `D:\谱/小星星` 这种混搭。
   */
  const wsPathText = (() => {
    if (!ws) return ''
    const segs = ws.path ?? []
    if (isPathWorkspace(ws)) {
      const dir = ws.dir ?? ''
      const sep = dir.includes('\\') ? '\\' : '/'
      return [dir.replace(/[\\/]+$/, ''), ...segs].join(sep)
    }
    return joinPath([ws.name, ...segs])
  })()

  /**
   * adj544（用户要求 C）：**最近工作区**——一键切回上次那个（重启后尤其有用：
   * 重新选同一个文件夹会因为 FSA 不给稳定路径而变成"新工作区"，从列表点回去就不用重选）。
   *
   * adj575（用户要求）：原先这里有一份"竖排大按钮"清单（只在"还没设工作区"那一屏用），
   * 现在**统一到工作区选择界面**（带 ✕ 移除 + 目录路径提示，见下面的 `choose` 分支），
   * 因此这份旧渲染已删除；正常视图里那份横排"最近的工作区"（操作▾ 里展开）保持不变。
   */

  /**
   * adj575（用户要求）：把一项从"最近工作区"清单里移除（✕）。
   * 语义刻意收窄成"**只动这份清单**"：不动磁盘上的文件夹，也**不动当前正在用的工作区**
   * （adj577 起 ✕ 只出现在**非当前**项上，所以根本点不到当前那条——见下面 `isCurrent` 分支）。
   */
  const onForget = async (rec: WorkspaceRecord) => {
    await forgetWorkspace(rec.id)
    setRecent(await listWorkspaces())
    showNotice(workspaceCopy.forgotten(rec.name), 'ok')
  }
  /** 清单里每项的悬浮提示：桌面路径后端能给出**完整磁盘路径**（网页版只有文件夹名） */
  const recentTitle = (r: WorkspaceRecord): string => (r.dir ? r.dir : r.name)

  /**
   * adj575（用户要求）：**工作区选择界面**——先列出"之前打开过的工作区"让人选，
   * 每项后面一个 ✕ 用于从清单里移除，底部「打开其它目录」直接开系统选择对话框。
   * 骨架复用了原先"待授权"那一屏，并把它需要的信息**并进来**（同一屏解决三件事）：
   *  · 当前工作区需要**重新授权**（网页版刷新后是 prompt）⇒ 显示目录 + 原因 + 「继续访问」按钮；
   *  · 当前工作区**已不在**（桌面版目录被删/改名）⇒ 显示目录 + 说明（只能重选）；
   *  · 网页版还要带上"内核敏感目录黑名单"的提示（必须**选之前**说，见 E-2026-271）。
   */
  /**
   * adj575（用户要求）：**工作区选择界面**——先列出"之前打开过的工作区"让人选。
   *
   * adj577（用户要求）改成**左右分栏**（左=清单、右=操作按钮），与文件列表那一屏同构：
   *  · 右栏只有一个主按钮「**新工作区**」（原「打开其它目录」，语义更直白），
   *    当前工作区待授权时上面再叠一个「继续访问（需授权）」；
   *  · **取消**「返回文件列表」按钮——改为**点当前工作区那一项**回到文件列表
   *    （所以当前项**不给 ✕**：它必须一直留在清单里，"已打开的工作区才能成为当前工作区"）；
   *  · 用 `.ws-panel` + `.ws-body` 这套现成的弹性布局（而不是居中的 `-gate`），
   *    列表因此拿到真实高度（`.ws-list` 有 `min-height: 120px`）——**清单一定显示得出来**；
   *  · 仍然把原先"待授权 / 目录已不在"的信息并进来（一屏解决三件事）。
   */
  if (choose || !ws || perm !== 'granted') {
    const needGrant = !!ws && perm !== 'granted' && !isPathWorkspace(ws)
    const gone = !!ws && perm !== 'granted' && isPathWorkspace(ws)
    /**
     * adj586（用户要求）：这一屏的**常驻文字全部收进标题后的 `?`**（点开才占高度），左栏只留清单。
     * 用户原话："列表下面还是大片的文字，导致列表高度太小……要么增加默认工作区清单高度为 5 行，
     * 下面大片文字可以通过滚动后可见，要么这些文字整理进 `?` 点击可以列出提示信息"，
     * 外加"为什么老把清单整得小小的，甚至不可见，非得我调整底栏 dock 高度才看得到"。
     * ⇒ 两条都做：① 说明一律进 `?`；② 清单默认就给 **5 行**（`.ws-choose-list` 的 min-height）。
     * 顺序：用法 → 当前状态的原因（待授权 / 目录已不在）→ 待校验绑定的说明 → 网页版内核黑名单。
     */
    const chooseHints = [
      workspaceCopy.chooseHint,
      ...(needGrant ? [workspaceCopy.grantWhy, workspaceCopy.grantPathHint] : []),
      ...(needGrant && pending
        ? [workspaceCopy.bindingRestored(pending.wsName || ws?.name || '', joinPath(pending.segs))]
        : []),
      ...(gone ? [workspaceCopy.dirMissingWhy] : []),
      ...(supportsPathWorkspace() ? [] : [workspaceCopy.blockedHint]),
    ]
    /** 点**当前**那一项做什么：待授权 ⇒ 顺手把授权办掉；目录已不在 ⇒ 如实说一句；否则回文件列表 */
    const tapCurrent = () => {
      if (needGrant) {
        void onGrant()
        return
      }
      if (gone) {
        showNotice(workspaceCopy.dirMissingWhy, 'warn')
        return
      }
      setChoose(false)
    }
    const currentTitle = needGrant
      ? workspaceCopy.grantTapTitle
      : gone
        ? workspaceCopy.dirMissingWhy
        : workspaceCopy.backToFilesTitle
    return (
      <div className="ws-panel">
        <div className="ws-head ws-choose-head">
          {/* adj581（用户要求）：底栏各面板的内容标题统一样式——用**谱面页的行标题样式**
              （`.pcfg-group-title`，即设置→谱面里「纸张与边距」那种：强调色 + 加粗 + 左侧强调竖条 + 下边框）。
              `?` 放在标题元素**内部**：标题是 flex 容器 ⇒ 图标紧跟文字，而标题本身仍占满整行、
              那条下边框与左侧竖条横贯整行（与「纸张与边距」观感一致）。
              adj585/adj586：说明**点 `?` 才展开**（PC 仍可悬浮）。 */}
          <div className="pcfg-group-title ws-choose-title">
            <span>{workspaceCopy.chooseTitle}</span>
            <HelpBadge
              hint={chooseHints}
              // 带内核黑名单那条时用 adj568 的强调卡片样式（左竖条 + 淡底），一眼能分出"这条是限制"
              hintClassName={supportsPathWorkspace() ? undefined : 'ws-blocked-hint'}
            />
          </div>
        </div>
        <div className="ws-body">
          {/* adj586：左栏**只有清单**——此前"当前目录框 + 三条说明"把清单挤到只剩一两行 */}
          <div className="ws-left">
            {recent.length === 0 ? (
              <div className="ws-list ws-choose-list">
                <div className="ws-none">{workspaceCopy.chooseEmpty}</div>
              </div>
            ) : (
              <div className="ws-list ws-choose-list">
                {recent.map((r) => {
                  const isCurrent = ws?.id === r.id
                  return (
                    <div key={r.id} className={`ws-choose-row${isCurrent ? ' is-current' : ''}`}>
                      <button
                        type="button"
                        className="btn ws-choose-item"
                        // adj586（用户要求）：点当前那一项 = 回文件列表；**待授权时这一下顺便把授权办掉**
                        //（点击即用户手势，浏览器才允许弹权限询问）——因此原来的「继续访问（需授权）」
                        // 按钮取消："通过点击当前工作区项可以切回文件列表"。
                        onClick={() => (isCurrent ? tapCurrent() : void onActivate(r))}
                        disabled={busy}
                        title={isCurrent ? currentTitle : recentTitle(r)}
                      >
                        <span className="ws-icon">📁</span>
                        <span className="ws-choose-name">{r.name}</span>
                        {isCurrent && <span className="ws-choose-tag">{workspaceCopy.currentTag}</span>}
                      </button>
                      {/* ✕ 只在**非当前**项上：当前工作区必须留在清单里（同目录只有一个工作区） */}
                      {!isCurrent && (
                        <button
                          type="button"
                          className="btn ws-forget"
                          onClick={() => void onForget(r)}
                          disabled={busy}
                          title={workspaceCopy.forgetTitle}
                          aria-label={`${workspaceCopy.forgetTitle}：${r.name}`}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {/* 右侧操作区：与文件列表那一屏同一个 `.ws-side`（固定宽度，保证"清单"拿到剩余宽度） */}
          <div className="ws-side ws-choose-side">
            {isHostEmbedded() ? (
              /**
               * adj724b（用户实测 #5）：**嵌入版（Obsidian iframe）里不能出现"选文件夹"**。
               *
               * 浏览器禁止**跨源子框架**弹文件选择器：
               * `SecurityError: Failed to execute 'showDirectoryPicker' on 'Window':
               *  Cross origin sub frames aren't allowed to show a file picker.`
               * 而且嵌入版的语义本来就是"**文库即工作区**"，压根不需要选 ⇒ 直接换成一句说明。
               */
              <div className="ws-side-hint">{workspaceCopy.embeddedUsesVault}</div>
            ) : (
              <>
                <button
                  type="button"
                  className="btn ws-side-btn"
                  onClick={() => void onPick()}
                  disabled={busy}
                  title={workspaceCopy.chooseHint}
                >
                  {workspaceCopy.openOther}
                </button>
                {/* adj585（用户要求）：内核要求这句短提示**只**留在「新工作区」按钮下方 */}
                {!supportsPathWorkspace() && <div className="ws-side-hint">{workspaceCopy.chromiumOnly}</div>}
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="ws-panel">
      {/* adj549（用户要求）：**面包屑独占一整行**（切换工作区按钮 + 路径 + 移动提示），
          下面才分左右：左=目录/文件列表，右=过滤 / `*` / 消除过滤 / 操作▾。
          这样路径能拿到整个面板宽度（此前被右栏挤掉一百多像素，深目录看不全）。 */}
      <div className="ws-head">
        {/* adj540（用户第二轮反馈）：左侧放一个"切换工作区"图标按钮；
            路径面包屑从**第一个段（根目录名）**开始就是普通段，点击=回到工作区根目录——
            解决了"根目录名点不开"的别扭，把"切换工作区"这个动作彻底从路径里分离出去。
            adj569（用户要求）：图标从 `工作区.png` 换成专用的 `切换工作区.png`——
            同一个"工作区"概念下两处语义不同：底栏**页签**是"打开工作区面板"，
            这个**按钮**是"换一个目录当工作区"，用同一张图会让人以为它也是开关面板。 */}
        {!isHostEmbedded() && (
          <button
            type="button"
            className="ws-workspace-btn"
            onClick={() => void (moving ? refreshMovingTarget([]) : setChoose(true))}
            title={workspaceCopy.workspaceBtnTitle}
            aria-label={workspaceCopy.workspaceBtnTitle}
            disabled={busy}
          >
            <ToolIcon name="switchWorkspace" />
          </button>
        )}
        <div className="ws-crumb" title={wsPathText}>
          {/* 根目录名 = 普通面包屑段（"回到工作区根目录"或"移动模式下选工作区根作目标"） */}
          <button
            type="button"
            className="ws-crumb-seg ws-crumb-root"
            onClick={() => void (moving ? refreshMovingTarget([]) : refresh(ws, []))}
            disabled={busy}
          >
            {ws.name}
          </button>
          <span className="ws-sep">/</span>
          {path.map((seg, i) => (
            <span key={`${seg}-${i}`}>
              <button
                type="button"
                className="ws-crumb-seg"
                onClick={() => void (moving ? refreshMovingTarget(path.slice(0, i + 1)) : refresh(ws, path.slice(0, i + 1)))}
                disabled={busy}
              >
                {seg}
              </button>
              <span className="ws-sep">/</span>
            </span>
          ))}
        </div>
        {/* adj1305（用户要求）：面包屑**右侧**——在系统文件管理器打开当前目录。
            只有桌面壳的路径后端有绝对路径（`isPathWorkspace` + `ws.dir`），网页版/嵌入版不渲染。 */}
        {ws !== null && isPathWorkspace(ws) && ws.dir ? (
          <button
            type="button"
            className="ws-open-dir-btn"
            onClick={() => void openCurrentDir()}
            title={workspaceCopy.openDirTitle}
            aria-label={workspaceCopy.openDirTitle}
          >
            <ToolIcon name="openFolder" />
          </button>
        ) : null}
        {/* 「移动到…」模式下头部显示目标提示 */}
        {moving && (
          <span className="ws-move-hint">
            {workspaceCopy.moveHere}·{moving.list.length} → {crumb || ''}
          </span>
        )}
      </div>

          {/* 输入/确认区：改名、新建、另存、删除确认都放这里（不占用列表行） */}
          {edit && (
            <div className="ws-editbar">
              <span className="ws-edit-label">{EDIT_META[edit.kind].label}</span>
              <input
                className="ws-input"
                value={edit.value}
                autoFocus
                placeholder={EDIT_META[edit.kind].placeholder}
                onChange={(ev) => setEdit({ ...edit, value: ev.target.value })}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') void submitEdit()
                  if (ev.key === 'Escape') {
                    // adj608：`preventDefault` = "这个 ESC 我用了"——底栏的"ESC 最小化"据此让路
                    //（ESC 先关最里面那一层：正在改名的输入框先取消，再按一次才最小化底栏）
                    // adj613：取消即"退出输入框"（这个输入框随之卸载，焦点自然释放）
                    ev.preventDefault()
                    setEdit(null)
                  }
                }}
              />
              <button type="button" className="btn primary" onClick={() => void submitEdit()} disabled={busy}>
                {workspaceCopy.confirmBtn}
              </button>
              <button type="button" className="btn" onClick={() => setEdit(null)} disabled={busy}>
                {workspaceCopy.cancelBtn2}
              </button>
            </div>
          )}
          {confirmDel && (
            <div className="ws-editbar ws-editbar-danger">
              <span className="ws-danger-text">{confirmDel.label}</span>
              <button type="button" className="btn ws-danger" onClick={() => void doDelete()} disabled={busy}>
                {workspaceCopy.actDelete}
              </button>
              <button type="button" className="btn" onClick={() => setConfirmDel(null)} disabled={busy}>
                {workspaceCopy.cancelBtn2}
              </button>
            </div>
          )}

          {/* adj544（用户要求 C）：正常视图里也能"切回最近的工作区"——点「操作 → 最近的工作区…」就地展开 */}
          {showRecent && recent.length > 0 && (
            <div className="ws-recent ws-recent-inline">
              <div className="ws-recent-title">{workspaceCopy.recentWorkspaces}</div>
              <div className="ws-recent-row">
                {recent.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`btn ws-recent-item${ws?.id === r.id ? ' is-current' : ''}`}
                    onClick={() => {
                      setShowRecent(false)
                      void onActivate(r)
                    }}
                    disabled={busy}
                    title={r.name}
                  >
                    <span className="ws-icon">📁</span>
                    <span className="ws-recent-name">{r.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

      {/* adj549：下面分左右两栏——**左栏只有列表**，右栏是过滤 / `*` / 消除过滤 / 操作▾（固定宽度）。 */}
      <div className="ws-body">
        <div className="ws-left">
          <div className={`ws-list${busyLabel ? ' is-busy' : ''}`} title={workspaceCopy.onlyListed}>
            {/* adj547（用户反馈）：**进行中的提示**放在列表最上方**立刻**出现（转圈 + 文案），
                同时把旧内容变淡——用户一眼能分清"在忙"而不是"点不动/不能点"。 */}
            {busyLabel && (
              <div className="ws-loading" role="status" aria-live="polite">
                <span className="ws-spin" aria-hidden="true" />
                <span className="ws-loading-text">{busyLabel}</span>
              </div>
            )}
            {/* adj590（用户要求"工作区在索引操作时，应该有提示消息"）：建索引是几十秒级的长操作，
                而且现在会在"打开面板/切工作区"之后**空闲时自己跑**——提示必须放在**列表最上方**、
                与其它进行中提示同款（转圈 + 文案），否则它夹在几百行列表底部等于没提示。 */}
            {scanInfo && (
              <div className="ws-loading" role="status" aria-live="polite">
                <span className="ws-spin" aria-hidden="true" />
                <span className="ws-loading-text">{workspaceCopy.indexing(scanInfo.scanned, scanInfo.found)}</span>
              </div>
            )}
          {/* 过滤模式：**平坦结果**（跨子目录），点一条直接打开 —— 不提供勾选（改名/移动/删除要先清空过滤） */}
          {searching
            ? (hits ?? []).slice(0, RESULT_RENDER_MAX).map((h) => (
                /* adj571（用户反馈）：列表窄时文件名会被省略号截断 ⇒ **悬浮显示完整相对路径**
                   （含文件名与所在子目录）。title 放在**整行 div** 上而不是里面的按钮上：
                   按钮旁边还有复选框/目录后缀，放行上则悬停任意位置都能看到。
                   adj572（用户反馈）：过滤结果**本来就没有复选框**，却仍用 16px 占位保对齐 ⇒
                   左边白白空出 26px（16 占位 + 2 右边距 + 8 间距）。这里**不再渲染占位**，
                   🎼 图标与文件名整体左移，文件名也因此多拿到这 26px。
                   adj574（用户建议）：窄列表里"文件名 + 路径"挤在同一行会**互相截断** ⇒ 改**两行**：
                   上行文件名左对齐、下行所在目录右对齐（颜色口径不变：名字主文字色、路径弱化色）。
                   两行各自吃满整行宽度 ⇒ 两者都拿到完整可读宽度，行也更高、手机上更好点按；
                   也正因如此，行距可以再收紧一点（见 `.ws-row-plain`）。 */
                <div key={h.relPath} className="ws-row ws-row-plain" title={h.relPath}>
                  <button
                    type="button"
                    className="ws-row-open ws-row-open-2l"
                    onClick={() => {
                      void (async () => {
                        const segs = [...h.dirSegs, h.name]
                        const ok = await openWorkspaceFile(segs)
                        if (ok) {
                          // adj723z：搜索命中里打开的也要进「最近…」（与目录列表同一条规则）
                          if (ws) void recordRecentFile({ wsId: ws.id, wsName: ws.name, segs, name: fileBaseName(h.name) })
                          closeDock()
                        }
                      })()
                    }}
                    disabled={busy}
                  >
                    <span className="ws-icon">🎼</span>
                    <span className="ws-hit-main">
                      <span className="ws-name">{h.name}</span>
                      {h.dirSegs.length > 0 && <span className="ws-hit-dir">{joinPath(h.dirSegs)}</span>}
                    </span>
                  </button>
                </div>
              ))
            : (
              <>
                {path.length > 0 && (
                  <div className="ws-row">
                    <span className="ws-check" aria-hidden="true" />
                    <button
                      type="button"
                      className="ws-row-open ws-row-up"
                      onClick={() => {
                        setSelected([])
                        void (moving ? refreshMovingTarget(parentPath(path)) : refresh(ws, parentPath(path)))
                      }}
                      disabled={busy}
                    >
                      <span className="ws-icon">↰</span>
                      <span className="ws-name">{workspaceCopy.up}</span>
                    </button>
                  </div>
                )}
                {entries
                  .filter((e) => !moving || e.kind === 'dir')
                  .map((e) => (
                    /* adj571（用户反馈）：普通列表行**原来没有任何 title** ⇒ 窗口窄 / 底栏窄时
                       文件名被省略号截断后**无处可看全名**。这里补上"工作区内完整相对路径"
                       （含文件名，例如 `2.曲谱集/小星星.jps`）——既给出全名，也顺带说明它在哪一层。
                       title 放整行 div：悬停在复选框、图标、名字任意位置都能看到。 */
                    <div
                      key={`${e.kind}-${e.name}`}
                      className={`ws-row${selected.includes(e.name) ? ' is-selected' : ''}`}
                      title={joinPath([...path, e.name])}
                    >
                      {/* adj540（用户要求）：文件名前的**复选框** —— 勾选 = 选中（供 改名/移动/删除 用），
                          点名字 = 打开/进入。两者分开，不再需要"点两次才打开" */}
                      {moving ? (
                        <span className="ws-check" aria-hidden="true" />
                      ) : (
                        <input
                          type="checkbox"
                          className="ws-check"
                          checked={selected.includes(e.name)}
                          aria-label={e.name}
                          onChange={() => {
                            setEdit(null)
                            setConfirmDel(null)
                            toggleSelect(e.name)
                          }}
                        />
                      )}
                      <button type="button" className="ws-row-open" onClick={() => void openEntry(e)} disabled={busy}>
                        <span className="ws-icon">{e.kind === 'dir' ? '📁' : '🎼'}</span>
                        <span className="ws-name">{e.name}</span>
                      </button>
                    </div>
                  ))}
                {entries.length === 0 && <div className="ws-none">{workspaceCopy.emptyDir}</div>}
              </>
            )}
          {searching && hits !== null && hits.length === 0 && <div className="ws-none">{workspaceCopy.searchEmpty}</div>}
          {/* adj546：命中数超过渲染上限 ⇒ 如实说明（索引是全量的，只是没全画出来） */}
          {searching && (hits?.length ?? 0) > RESULT_RENDER_MAX && (
            <div className="ws-none">{workspaceCopy.searchCapped(hits?.length ?? 0, RESULT_RENDER_MAX)}</div>
          )}
          {/* adj546：正在后台重扫/首次扫描 ⇒ 显示进度
              adj590：进度改到**列表最上方**（`.ws-loading` 同款），这里不再重复显示 */}
          </div>
        </div>

        <div className="ws-side">
          {moving ? (
            <>
              <div className="ws-side-label">
                {workspaceCopy.actMove}·{moving.list.length}
              </div>
              <button type="button" className="btn primary ws-side-btn" onClick={() => void submitMove()} disabled={busy}>
                {workspaceCopy.moveHere}
              </button>
              <button type="button" className="btn ws-side-btn" onClick={() => setMoving(null)} disabled={busy}>
                {workspaceCopy.moveCancel}
              </button>
            </>
          ) : (
            <>
              {/* adj1298（用户第五轮，2026-11-16）：右栏（操作区）里的控件顺序改成
                  **提示信息 → 搜索行 → 操作按钮**（原来是"操作按钮 → 搜索行 → 提示"）。
                  读起来是"先看现在什么状态，再去筛选，最后动手"，操作▾ 落在最下方
                  （`moving` 那一支本来就同序：`actMove·N` 提示在上、按钮在下）。 */}

              {/* ① 提示信息：命中数 / 选中项名字（没勾选也没搜索时是空的，不占行高） */}
              <div className="ws-side-label" title={selectedEntries.map((e) => e.name).join('、')}>
                {searching ? (
                  <span className="ws-side-name">
                    {workspaceCopy.searchResults(hits?.length ?? 0)}
                    {hitsTruncated ? '…' : ''}
                  </span>
                ) : selCount === 0 ? (
                  // adj546（用户要求）：没勾选时**不显示任何文字**（原来那句"勾选后可操作"去掉）
                  null
                ) : selCount === 1 ? (
                  <span className="ws-side-name">{selectedEntries[0].name}</span>
                ) : (
                  <span className="ws-side-name">{workspaceCopy.selectedCount(selCount)}</span>
                )}
              </div>

              {/* ② 搜索行（过滤三件套）——adj545：搬到右栏；adj1298：一行排开，
                  `*` 在搜索框**前**、`✕` 在**后**，两枚按钮**正方形**（宽 = 高）。
                  默认层级列表；一过滤就把整个工作区符合条件的 `.jps` 收成平坦列表
                  （`*` 在过滤口径里是"任意串"⇒ 等价于"不过滤但走平坦列表"）。 */}
              <div className="ws-filter-row">
                <button
                  type="button"
                  className={`btn ws-filter-all${query.trim() === '*' ? ' is-active' : ''}`}
                  title={workspaceCopy.filterAllTitle}
                  aria-label={workspaceCopy.filterAllTitle}
                  aria-pressed={query.trim() === '*'}
                  onClick={() => {
                    setQuery(query.trim() === '*' ? '' : '*')
                    setEdit(null)
                    setConfirmDel(null)
                  }}
                >
                  {workspaceCopy.filterAll}
                </button>
                <input
                  className="ws-input ws-filter"
                  value={query}
                  placeholder={workspaceCopy.filterPlaceholder}
                  title={workspaceCopy.filterHint}
                  onChange={(ev) => {
                    setQuery(ev.target.value)
                    setEdit(null)
                    setConfirmDel(null)
                  }}
                  onKeyDown={(ev) => {
                    /**
                     * adj608：清空过滤是"这个 ESC 的用途"，标记已用 ⇒ 底栏不再顺手最小化（见 ToolDock）
                     * adj613（用户要求）：同时**退出输入框** ——"第一次 ESC 退出输入框、第二次才最小化底栏"。
                     */
                    if (ev.key === 'Escape') {
                      ev.preventDefault()
                      setQuery('')
                      ev.currentTarget.blur()
                    }
                  }}
                />
                {/* 消除过滤：常驻（无过滤时禁用）——位置固定，不因是否有过滤而跳动 */}
                {/* adj1299（用户拍板）：`✕` 字符换成**图标**（复用导入页签那枚「取消」，
                    与其它已图标化的按钮同一套观感）。`*` 仍是字符——图标集里没有对应的
                    "匹配任意串"图形，硬画一枚不如留着这个数学符号好认。 */}
                <button
                  type="button"
                  className="btn ws-filter-clear"
                  onClick={() => setQuery('')}
                  disabled={!searching}
                  title={workspaceCopy.filterClear}
                  aria-label={workspaceCopy.filterClear}
                >
                  <ToolIcon name="close" size={12} />
                </button>
              </div>

              {/* ③ 操作按钮：列出所有操作的下拉（adj540：列表里点文件名就能打开/进入，
                  所以右侧不再放独立的「打开」按钮，只剩这一个）。
                  adj1298（用户第九轮）：按钮**前面加图标**——按用户口径直接用「菜单」那枚
                  **三横**（`public/icons/菜单.png`，与顶栏汉堡同一个图形），不再新画；
                  文字与右侧的 ▾ 都保留（下拉按钮带文字更好认，图标只补一个一眼可辨的形状）。 */}
              <button
                ref={menuBtnRef}
                type="button"
                className="btn ws-side-btn ws-side-group"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
                disabled={busy}
              >
                <ToolIcon name="menu" size={12} />
                {workspaceCopy.menuBtn}
                {/* adj548（用户反馈）：文本后的下三角**用 `下.png` 图标**（原来的 ▾ 字符太小看不清）；
                    展开时翻成 `上.png`，与顶栏视图下拉同一套观感。 */}
                <span className="ws-caret">
                  <ToolIcon name={menuOpen ? 'up' : 'down'} size={12} />
                </span>
              </button>
            </>
          )}
        </div>
      </div>
      {/* 操作菜单（portal → body：dock 有 overflow:hidden，就地浮层会被裁掉；
          锚在按钮**上方**，因为底栏就在屏幕底部） */}
      {menuOpen &&
        menuPos &&
        createPortal(
          <div ref={menuRef} className="ws-menu-pop" role="menu" style={{ left: menuPos.left, bottom: menuPos.bottom, width: menuPos.width }}>
            <button type="button" className="ws-menu-item" role="menuitem" onClick={() => { setMenuOpen(false); void onSave() }}>
              {workspaceCopy.actSave}
            </button>
            <button
              type="button"
              className="ws-menu-item"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                setEdit({ kind: 'saveAs', value: fileBaseName(useDocStore.getState().fileName) })
              }}
            >
              {workspaceCopy.actSaveAs}
            </button>
            <button
              type="button"
              className="ws-menu-item"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                setEdit({ kind: 'newScore', value: '' })
              }}
            >
              {workspaceCopy.actNewScore}
            </button>
            <button
              type="button"
              className="ws-menu-item"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                setEdit({ kind: 'newFolder', value: '' })
              }}
            >
              {workspaceCopy.actNewFolder}
            </button>
            <div className="ws-menu-sep" />
            {/* adj546：手动**重新扫描**（外部新增了文件、或索引过期时用；否则靠落盘索引秒开） */}
            <button
              type="button"
              className="ws-menu-item"
              role="menuitem"
              disabled={!ws || busy}
              onClick={() => {
                setMenuOpen(false)
                if (!ws) return
                invalidateCache() // adj588：手动重扫 = 索引与代际一起作废，重扫**整棵树**
                void buildIndex(ws, ws.id, true).then(() => setIndexVersion((v) => v + 1))
              }}
            >
              {workspaceCopy.rescan}
            </button>
            {/* adj544：切回最近工作区（重启后 / 换过工作区后都用得着） */}
            {recent.length > 0 && (
              <button
                type="button"
                className="ws-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  // adj544：展开前重读列表——刚切换过工作区时，面板激活时拿到的那份已经旧了
                  void listWorkspaces().then(setRecent)
                  setShowRecent((v) => !v)
                }}
              >
                {workspaceCopy.recentWorkspaces}…
              </button>
            )}
            <div className="ws-menu-sep" />
            <button
              type="button"
              className="ws-menu-item"
              role="menuitem"
              disabled={selCount !== 1 || selectedEntries[0]?.kind !== 'file'}
              onClick={() => {
                const one = selCount === 1 ? selectedEntries[0] : null
                setMenuOpen(false)
                if (!one || one.kind !== 'file') return
                setEdit({ kind: 'rename', value: stripJpsExt(one.name), name: one.name })
              }}
            >
              {workspaceCopy.actRename}
            </button>
            <button
              type="button"
              className="ws-menu-item"
              role="menuitem"
              disabled={selectedFiles.length === 0 || hasDirSelected}
              title={hasDirSelected ? workspaceCopy.moveDirUnsupported : undefined}
              onClick={startMove}
            >
              {workspaceCopy.actMove}
            </button>
            <button type="button" className="ws-menu-item ws-danger" role="menuitem" disabled={selCount === 0} onClick={startDelete}>
              {workspaceCopy.actDelete}
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}
