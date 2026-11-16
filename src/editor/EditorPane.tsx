/**
 * editor/EditorPane.tsx — 代码编辑器（textarea + 语法高亮层 + 行号栏 + IDE 化体验）
 *
 * M2 能力：
 *  - 行号栏（与编辑区同步滚动；错误行红标 + 悬停显示错误消息）
 *  - 行首命令快捷键（光标在行首按 Q/C/B/Z/D/P/J/V/H 插入命令头）
 *  - 自动格式化（防抖 + 光标公共前缀保持）
 *  - 语法高亮（含错误行红底）
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useDocStore } from '../store/docStore'
import { useUiStore } from '../store/uiStore'
import { highlightCodeWrapped } from './highlight'
// adj642（用户要求）：查找命中在编辑区的**高亮**——走浏览器自己的机制（CSS Custom Highlight API）
import { applyFindHighlights, clearFindHighlights } from './findHighlight'
import { currentMatchIndex, findMatches } from './findReplace'
import { formatLine, codePosToNoteId, highlightModel, groupBlocksByLine } from '@ijipu/engine'
import { insertLineHeader, isLineHeaderKey, lineColOf } from './shortcuts'
import { isBarlineModifierContext, isGraceModifierContext, filterModifierHints } from './completions'
import { ScriptToolbar } from './ScriptToolbar'
import { ToolIcon } from '../ui/ToolIcon'
import { dockCopy } from '../brand/copy'
// adj617（用户要求）：浮动栏「展开底栏」按钮的提示后面带快捷键（键名一处定义）
import { KBD, withKbd } from '../brand/shortcuts'
import type { PadGroup, PadKey } from './padLayout'

/** adj165：自动提示浮层状态（null = 不显示）
 *  adj314：保留 & 修饰符（modifier）与 Y/@ 乐器（instrument）两类——
 *  描述头（header）、跳房子（volta）已由嵌入式输入工具条整段覆盖，弹列表取消 */
interface Completion {
  /** 提示类型：修饰符（& 编码）、Y 行乐器（@ 后，adj302） */
  kind: 'modifier' | 'instrument'
  /** 候选列表（cursorAt = 插入后光标停靠位置，用于带声部名模板） */
  items: { code: string; label: string; cursorAt?: number }[]
  /** 当前高亮索引 */
  index: number
  /** 光标触发位置（相对 textarea 内容区，浮层定位用） */
  x: number
  y: number
}

/** adj323：一級工具条主键组浮层状态（null = 不显示）
 *  点主键在工具条上方弹出该组二级键（insert + 中文说明），点击插入；
 *  keepOpen 组（音符/时值）保持展开（连续插多个），移到浮层外点击时关闭；其余组点一项后自动关闭。 */
interface PadMenu {
  /** 所属主键组 id */
  groupId: string
  /** 该组二级键列表 */
  keys: PadKey[]
  /** 当前高亮索引 */
  index: number
  /** 工具条容器视口 rect（adj323b：浮层底部统一对齐工具条顶边） */
  area: { x: number; y: number; w: number; h: number }
  /** 被点按钮视口 rect（adj323c：水平尽量跟随按钮位置） */
  btn: { x: number; y: number; w: number; h: number }
  /** 点二级键后是否保持展开（keepOpen 组：音符/时值，连续输入） */
  keepOpen: boolean
}

/** 判断光标前是否在输入 & 编码（返回已输入的前缀；只收字母 + 可选 +，adj220 与 tokenizer 一致） */
function modifierPrefix(lineBefore: string): string | null {
  const m = /&([a-zA-Z+]*)$/.exec(lineBefore)
  return m ? m[1] : null
}

export function EditorPane() {
  const code = useDocStore((s) => s.code)
  const setCode = useDocStore((s) => s.setCode)
  const setCursor = useDocStore((s) => s.setCursor)
  const setSelection = useDocStore((s) => s.setSelection)
  const autoFormat = useDocStore((s) => s.autoFormat)
  const parseResult = useDocStore((s) => s.parseResult)
  // adj281：editor-head 顶栏已迁出到 EditorFootBar；编辑器主体仍需字号/字体 CSS 变量
  const editorFontSize = useUiStore((s) => s.editorFontSize)
  // adj160：编辑器字体
  const editorFont = useUiStore((s) => s.editorFont)
  // adj233/adj235/adj311：自动折行开关（折叠点计算与 textarea wrap=soft/off 联动）
  const autoWrap = useUiStore((s) => s.autoWrap)
  // adj314：嵌入式简谱输入工具条显示开关
  const showScriptPad = useUiStore((s) => s.showScriptPad)
  // adj541：底栏展开悬浮按钮要读的状态（关着才显示；点开时保留上次的页签）
  const dockOpen = useUiStore((s) => s.dockOpen)
  // adj610：展开动作收进 store——「展开底栏」按钮 / Ctrl+D / Ctrl+H 三个入口共用同一条规则
  // adj1290（用户拍板）：告警已独立成抽屉，`expandDock()` 不再带"有告警先切告警"的参数
  const expandDockPanel = useUiStore((s) => s.expandDock)
  const expandDock = () => expandDockPanel()
  // 编辑器字体/字号属 L1「用户个性」（本机偏好，**不随谱保存**；分层见 docs/SETTINGS-AUDIT.md）——
  // adj-font：此前这里读 `pageConfig.editorFontSize ?? editorFontSize`（谱面里有值就优先），
  // 而谱面里的这两个键是早期版本误写进去的；现已从 PageConfig 移除，只认本机偏好。
  const effectiveFontSize = editorFontSize
  const effectiveFont = editorFont

  // adj165：行高取整为整数（textarea 原生行盒与高亮层 CSS 行盒完全一致）
  const editorLineH = Math.round(effectiveFontSize * 1.7)

  // adj331：实测 textarea 单行渲染行高（两行 offsetHeight 差）——理论 editorLineH
  // （round(fs*1.7)）在手机端某些字体/浏览器下可能与 textarea 实际行盒不一致，
  // 导致行号栏/高亮层按 editorLineH 排布与内容行**累积漂移**（越往下越错）。
  // 实际测量逻辑在下方 taRef 声明的 ResizeObserver effect 里执行（须在 taRef 之后，
  // 否则 TS 报 TDZ：taRef 使用先于声明）。
  const [measuredLineH, setMeasuredLineH] = useState<number>(editorLineH)

  // adj331：渲染统一用实测行高 lineH（= measuredLineH），而非理论 editorLineH——
  // 保证行号栏/高亮层/滚动目标与 textarea 实际行盒一致，消除累积漂移。
  const lineH = measuredLineH

  const taRef = useRef<HTMLTextAreaElement>(null)
  const hlRef = useRef<HTMLDivElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  // adj167：显示层（高亮层/行号栏）内部滚动容器——用 transform 平移跟随 textarea 滚动位置，
  // 避免 scrollTop 同步被各自 scrollHeight 钳制（滚动到底时显示层停住、textarea 继续滚）
  const hlInnerRef = useRef<HTMLDivElement>(null)
  const gutterInnerRef = useRef<HTMLDivElement>(null)
  /**
   * adj542（用户要求）：行号栏**默认按两位数**宽，只有**滚动到超过两位数的行号**时才加宽。
   *
   * 之前是按"整篇行数"算（`String(lineCount).length`）——一份 300 行的谱，打开时明明在第 1 行，
   * 行号栏也已占三位的宽度，白白挤掉代码区。
   * 口径：`gutterDigits` 只**增长**（缩窄会让代码区在滚动时左右跳动），并受整篇行数上限约束
   * （`min(gutterDigits, String(lineCount).length)`）——换到短文档/删行后自动回到两位。
   * 为了不因滚动而频繁重渲染，只在**数字位数**变化时 `setState`（见下面的 `syncGutterDigitsRef`）。
   */
  const [gutterDigits, setGutterDigits] = useState(2)
  /** 滚动的"位数同步"回调：`visualTopOfLine` 在其后定义，故经 ref 调用（与 onScrollRef 同套路） */
  const syncGutterDigitsRef = useRef<(top: number, clientH: number) => void>(() => {})
  const formatTimer = useRef<number | null>(null)
  // adj110：最近编辑行（光标所在行）；光标离开该行时格式化它，避免输入时抢光标
  const editingLineRef = useRef<number>(-1)
  // adj165：自动提示浮层
  const [completion, setCompletion] = useState<Completion | null>(null)
  const completionRef = useRef<Completion | null>(null)
  completionRef.current = completion
  // adj323：一级工具条 → 主键组浮层（点主键统一在工具条上方弹出该组二级键列表）
  const [padMenu, setPadMenu] = useState<PadMenu | null>(null)
  const padMenuRef = useRef<PadMenu | null>(null)
  padMenuRef.current = padMenu
  // adj323b：工具条容器 ref——浮层底部统一对齐工具条顶边（不随按钮水平位置飘）
  const padAreaRef = useRef<HTMLDivElement | null>(null)
  // adj296b：回车换行标记——onChange 后横向滚动回新行行首光标
  //（长行末回车时视口停在右侧，不滚回行首会看不到新行输入）
  const enterKeyRef = useRef(false)
  // adj314：系统软键盘当前是否显示——「⌨」按钮高亮态由 focus/blur 事件驱动
  const [kbActive, setKbActive] = useState(false)

  // 光标联动（M3）：光标移动 → 计算 notepos id → 预览高亮
  const setActiveNoteId = useDocStore((s) => s.setActiveNoteId)
  const noteIndexToPage = useDocStore((s) => s.noteIndexToPage)
  const cursorJump = useDocStore((s) => s.cursorJump)
  // adj292：折行点 ref——光标跳转滚动时精确到「光标所在视觉行」（源码行顶 + 折行偏移）
  const wrapPointsRef = useRef<number[][]>([])
  const undo = useDocStore((s) => s.undo)
  const redo = useDocStore((s) => s.redo)
  // adj537：输入条行首「撤销 / 重做」按钮的可用态——取栈长度（数字选择器，避免整个数组订阅引起重渲染）
  const undoStackLen = useDocStore((s) => s.undoStack.length)
  const redoStackLen = useDocStore((s) => s.redoStack.length)
  // adj165：当前光标行/列（1-based 行、0-based 列），供高亮当前行与当前区块
  const cursor = useDocStore((s) => s.cursor)
  /**
   * adj642：选区（textarea 坐标）——查找高亮要用它判定"当前项是哪一处"
   * （`currentMatchIndex(matches, sel)`：与选区完全重合的那一项）。
   * 编辑器本来就会随 caret 移动重渲染（`cursor` 已订阅），这里不额外增加渲染成本。
   */
  const sel = useDocStore((s) => s.sel)
  const jumpCursor = useDocStore((s) => s.jumpCursor)
  const onSelectRef = useRef<() => void>(() => {})

  // 消费"点击谱面音符 / 撤销重做" → 跳转编辑器光标（含选区）请求
  useEffect(() => {
    if (!cursorJump) return
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    ta.selectionStart = Math.min(cursorJump.start, ta.value.length)
    ta.selectionEnd = Math.min(cursorJump.end, ta.value.length)
    // 滚动到光标所在行（行高 = 整数 --jp-editor-lh，adj165：与 CSS 取整一致）；adj63 wrap=off 需同步横向
    // adj223：折行后按视觉行滚动（visualTopRef 读取最新视觉行前缀和，不加入依赖——
    // 否则每次输入重跑 effect、光标被拉回跳转位置）
    // adj236：居中滚动——目标音符块尽量处于编辑器视口水平/垂直中心，
    // 避免跳到边角不好查找；超界由浏览器自动钳制到最大滚动
    const pos = lineColOf(ta.value, cursorJump.start)
    // adj292：折行内精确到光标所在视觉行——源码行顶 + 折行偏移×行高，保证音符块居中
    const wp = wrapPointsRef.current[pos.line - 1] ?? []
    const vIdx = wp.filter((p) => p < pos.col).length
    // visualTopRef 存「视觉行数」，需 ×行高转 px；（源码行前视觉行数 + 行内折行偏移）× 行高
    const targetTop = ((visualTopRef.current[pos.line - 1] ?? 0) + vIdx) * lineH
    ta.scrollTop = Math.max(0, targetTop - (ta.clientHeight - lineH) / 2)
    const targetLeft = pos.col * effectiveFontSize * 0.6
    // 折行（autoWrap）时内容宽度=视口，无横向滚动条——scrollLeft 置 0，
    // 避免残留的横向偏移让高亮层/内容错位、左侧看不到；wrap=off（长行横向滚动）再定位到目标列居中
    ta.scrollLeft = autoWrap ? 0 : Math.max(0, targetLeft - ta.clientWidth / 2 + effectiveFontSize * 0.3)
    onScroll()
    onSelectRef.current()
  }, [cursorJump, effectiveFontSize])

  // adj323：点浮层/主键外任意位置 → 关闭主键组浮层。
  // 注意浮层与主键本身 mousedown 都 preventDefault 保留 textarea 焦点，这里用 capture 阶段
  // 判断点击目标是否在浮层（.pad-menu）内；keepOpen 组（音符/时值）只在移到浮层外时关闭。
  useEffect(() => {
    if (!padMenu) return
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (t && (t as HTMLElement).closest?.('.pad-menu, .script-pad')) return
      setPadMenu(null)
    }
    document.addEventListener('mousedown', onDocDown, true)
    return () => document.removeEventListener('mousedown', onDocDown, true)
  }, [padMenu])

  // 行号 + 错误行信息
  const lineCount = useMemo(() => code.split('\n').length, [code])
  const errByLine = useMemo(() => {
    const map = new Map<number, { col: number; msg: string; severity: string }[]>()
    for (const e of parseResult.errors) {
      if (e.line <= 0) continue
      const arr = map.get(e.line) ?? []
      arr.push({
        col: e.col,
        severity: e.severity,
        msg: `${e.severity === 'error' ? '错误' : '警告'}[第${e.line}行 第${e.col}列] ${e.message}`,
      })
      map.set(e.line, arr)
    }
    return map
  }, [parseResult])

  // adj322：单击行号（含折行标记区域）→ 光标跳转：
  //   若点击的**不是当前行** → 跳转该源码行行首；
  //   若点击的**是当前行** → 跳到该行错误位置（若有错误；无错误则落行首）。
  //   不再用双击（双击会造成当前行连续跳动）。
  const onGutterClick = (line: number) => {
    const lines = code.split('\n')
    let offset = 0
    for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1
    // adj338：点击行号 → 跳到该行第一个告警/错误的问题列（无则行首），不受是否当前行限制
    const errs = errByLine.get(line)
    if (errs && errs.length > 0) {
      const first = [...errs].sort((a, b) => a.col - b.col)[0]
      jumpCursor(offset + first.col)
    } else {
      jumpCursor(offset)
    }
  }

  // 滚动同步（adj167：显示层内部容器用 transform 平移跟随 textarea 的滚动位置，
  // 不受显示层自身 scrollHeight 限制——滚动到底也不会停住/错层）
  const onScroll = () => {
    const ta = taRef.current
    if (!ta) return
    const hlInner = hlInnerRef.current
    const gutterInner = gutterInnerRef.current
    if (hlInner) hlInner.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
    if (gutterInner) gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`
    // adj542：滚到三位数行号时才把行号栏加宽（只在位数变化时 setState，不按像素重渲染）
    syncGutterDigitsRef.current(ta.scrollTop, ta.clientHeight)
    setCompletion(null) // adj165：滚动时关闭提示（位置不再准确）
  }

  // adj296b：回车换行后把横向滚动回滚到行首——textarea 原生不处理此场景：
  // 关闭自动折行（wrap=off）时在长行末尾回车，新行行首在左侧但视口仍停在右侧，
  // 用户看不到输入位置；其余场景（方向键/输入）由浏览器原生保证光标可见，
  // 不做额外滚动（避免逐键检查造成多余操作）
  const scrollToLineStartAfterEnter = () => {
    const ta = taRef.current
    if (!ta) return
    if (enterKeyRef.current) {
      enterKeyRef.current = false
      ta.scrollLeft = 0 // 新行行首 col=0 → 滚回最左
    }
  }

  // adj195：每源码行的视觉行数（软折行下可能 >1）——行号栏按视觉行高渲染，
  // 折行不产生新行号、并用延续标记区分新行与折行
  const [contentW, setContentW] = useState(0)
  // adj224：textarea 内容区宽（含 padding，clientWidth 已扣除滚动条宽）——
  // 同步给高亮层（--jp-editor-content-w），恢复竖向滚动条后两侧折行点一致
  const [taClientW, setTaClientW] = useState(0)
  // adj225：高亮层宽度由 ResizeObserver 直接写 DOM（inline width）——拖动窗体时
  // textarea 与高亮层**同帧**重排；若只走 React state（CSS 变量）会滞后一帧，
  // 拖动过程中高亮层仍是旧宽度、折行点不同，折行后的行文本错位
  const innerRef = useRef<HTMLDivElement>(null)
  /**
   * adj456：本测量 effect 由 `useEffect` 改为 `useLayoutEffect`，并把「是否同步渲染」参数化——
   * 修掉控制台那条 React 报错 `flushSync was called from inside a lifecycle method`（dev 下 StrictMode
   * 双跑 effect，故干净加载即出现 **2 条**）：
   *  - **初次测量在生命周期内执行** → 不能用 flushSync；而 layout effect 里的 setState 本来就会在
   *    本帧绘制**前**同步提交（与 flushSync 等效，还少一次多余渲染），语义不降级；
   *  - **ResizeObserver 回调**（拖动窗体途中、帧间触发，不在 React 生命周期内）→ 继续用 flushSync，
   *    保住 adj228 的本意：高亮层折行点与 textarea 同帧一致、不跨帧错位。
   */
  useLayoutEffect(() => {
    const parent = taRef.current?.parentElement ?? null
    if (!parent) return
    const update = (sync: boolean) => {
      const ta = taRef.current
      if (ta) {
        // 直接写 DOM：与浏览器 reflow 同帧生效（React state 只用于视觉行探测等非对齐计算）
        if (innerRef.current) innerRef.current.style.width = `${ta.clientWidth}px`
        // adj228：flushSync 同步渲染——快速拖动窗体时 React 并发调度可能跨帧提交，
        // wrapPoints（高亮层手动折行点）与 textarea 实际折行错位；同步渲染保证
        // 拖动过程中的每一帧内高亮层切分都与 textarea 一致
        const applyWidths = () => {
          setTaClientW(ta.clientWidth) // 含 padding，不含滚动条
          setContentW(ta.clientWidth - 28) // 内容区宽（去左右 padding 14×2）
        }
        if (sync) flushSync(applyWidths)
        else applyWidths()
        // adj331：实测 textarea 单行**布局行盒**（getBoundingClientRect().height 差）——
        // textarea 是原生控件，其行盒可能被字体撑得高于 line-height（部分 WebKit/移动
        // WebView 对 textarea 遵循字体 line-box 而非 CSS line-height）。用克隆 textarea
        // 测两行布局高差，得到 textarea 真实每行高度；不用理论 editorLineH（round(fs*1.7)），
        // 且不用 scrollHeight（它按 line-height 算、不含字体撑高，测不到偏差）。
        const cs = getComputedStyle(ta)
        const clone = document.createElement('textarea')
        // adj333：用 opacity:0 而非 visibility:hidden——visibility:hidden 的隐藏 textarea
        // 在部分浏览器 getBoundingClientRect 高度为 0（测不到行盒）；opacity:0 保留布局
        // 与行盒，能测出字体撑高后的真实每行高度（移动端字体 ascent/descent 较大时，
        // textarea 实际行盒 > CSS line-height，这正是 PC 正常、手机错位的根源）。
        clone.style.cssText = `position:absolute;left:-9999px;top:0;opacity:0;width:${ta.clientWidth}px;box-sizing:border-box;font-family:${cs.fontFamily};font-size:${cs.fontSize};line-height:${cs.lineHeight};letter-spacing:${cs.letterSpacing};white-space:${cs.whiteSpace};overflow-wrap:${cs.overflowWrap};tab-size:4;font-variant-ligatures:none;direction:ltr;resize:none;border:none;outline:none;padding:0;margin:0`
        document.body.appendChild(clone)
        clone.value = '0'
        const oneH = clone.getBoundingClientRect().height
        clone.value = '0\n0'
        const twoH = clone.getBoundingClientRect().height
        document.body.removeChild(clone)
        // rect 差（布局行盒）随字体撑高；value 无空格含 `\n` 强制两行，不含 padding（=0）
        const lh = Math.round(twoH - oneH)
        if (lh > 0) setMeasuredLineH(lh)
      }
    }
    update(false) // adj456：初次测量走普通 setState（layout effect 内本帧绘制前提交）
    const ro = new ResizeObserver(() => update(true))
    ro.observe(parent)
    // adj224：滚动条出现/消失会改变 textarea 内容宽（父宽不变）——需直接观察 textarea
    if (taRef.current) ro.observe(taRef.current)
    return () => ro.disconnect()
  }, [])
  // adj227：以实际层（textarea）的真实折行点为准——克隆同款 textarea 逐行测量
  // 折行点（wrapPoints），显示层按此手动分行，彻底消除 span 断行差异导致的错位；
  // adj309：用 mirror div + Range API 测字符 X 坐标替代 scrollHeight + Math.round——
  // scrollHeight 取整在 sub-pixel 边界处 ±1 字符误差，Range 直接给像素位置无误差；
  // mirror div 用 word-break:keep-all 与 textarea 折行行为一致（仅空格处折行）。
  const wrapPoints = useMemo(() => {
    const lines = code.split('\n')
    // adj233：关闭自动折行时不测量（wrap=off 无折行，长行横向滚动对位正确）
    if (!autoWrap) return lines.map(() => [])
    // adj225 延伸：用 taRef.current.clientWidth（实时，与 textarea reflow 同帧）——
    // 不读 taClientW state（state 滞后一帧，拖动/缩放窗体时镜像用旧宽 → 折行点错位）。
    // taClientW 仅作 deps 触发 useMemo 重算；测量时一律用 ref 的实时宽。
    const ta = taRef.current
    const w = ta ? ta.clientWidth : 0
    if (w <= 0) return lines.map(() => [])
    // mirror div：与 textarea 同款样式，width 直接用实时 clientWidth（与 textarea 一致）。
    // box-sizing: border-box 让内容 = w - 28（去 padding 14×2），与 textarea（box-sizing:border-box）完全一致。
    // adj330：字体/度量直接从 textarea 的 computed style 取（getComputedStyle），
    // 不再用 `${effectiveFont},monospace` 拼接——effectiveFont 为空或含特殊字族时
    // mirror 与 textarea 字体分裂 → 折行点不同 → 行号/高亮层错位（手机端尤其明显）。
    // 现 mirror 的 font-family/font-size/line-height/letter-spacing 与 textarea 逐字一致，
    // 保证折行测量与实际渲染完全同源。
    const mirror = document.createElement('div')
    const taCS = ta ? getComputedStyle(ta) : null
    const fontFamily = taCS?.fontFamily ?? `${effectiveFont}, monospace`
    const fontSize = taCS?.fontSize ?? `${effectiveFontSize}px`
    const lineHeight = taCS?.lineHeight ?? `${editorLineH}px`
    const letterSpacing = taCS?.letterSpacing ?? 'normal'
    // adj332：折行判定阈值按行高缩放——原用 `cur.top > prev.top + 0.5`（0.5px 太小），
    // 手机/亚像素渲染时相邻字符 top 可能抖动 >0.5px → 误判为折行 → visualLines 高估 →
    // 行号栏每行过高、往下与内容行越离越开（累积漂移）。改为按 0.6 行高作 top 阈值：
    // 真实换行 top 增加≈一整行（必过），亚像素抖动（远小于行高）不会误判。
    const lh = parseFloat(lineHeight) || 24
    mirror.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;width:${w}px;padding:10px 14px;box-sizing:border-box;font-family:${fontFamily};font-size:${fontSize};line-height:${lineHeight};letter-spacing:${letterSpacing};white-space:pre-wrap;overflow-wrap:normal;tab-size:4;font-variant-ligatures:none;direction:ltr`
    document.body.appendChild(mirror)
    // adj：去掉「短行跳过」优化（line.length*charW <= cw return []）——
    // charW = fontSize*0.6 是估算（`=` advance ~8.4 但 0.6×14=8.4 是近似，sub-pixel 临界时会
    // 让 mirror 误判「装得下不折」、而 textarea 实际整数像素 layout 装不下折了 → 一层折一层没折 → 错位。
    // 所有行都用 Range 测真实字符 X 坐标，精确无误差；短行 Range 也只测几十字符，性能可接受）
    const res = lines.map((line) => {
      mirror.textContent = line
      void mirror.offsetHeight // 强制 reflow
      const node = mirror.firstChild
      if (!node || node.nodeType !== 3) return []
      // 测每字符 X 坐标：top 突然变大 = 新行起点 → 折行点
      const rects: { left: number; right: number; top: number }[] = []
      for (let i = 0; i < line.length; i++) {
        const range = document.createRange()
        try {
          range.setStart(node, i)
          range.setEnd(node, i + 1)
        } catch {
          break
        }
        const r = range.getBoundingClientRect()
        rects.push({ left: r.left, right: r.right, top: r.top })
        range.detach?.()
      }
      const pts: number[] = []
      for (let i = 1; i < rects.length; i++) {
        const cur = rects[i]
        const prev = rects[i - 1]
        // 新行起点：top 增加近一整行高（≥0.6 行）且 left 显著回退到行首（adj332）
        if (cur.top > prev.top + lh * 0.6 && cur.left < prev.left - 1) {
          pts.push(i)
        }
      }
      return pts
    })
    document.body.removeChild(mirror)
    return res
  }, [code, contentW, taClientW, effectiveFontSize, editorLineH, effectiveFont, autoWrap])

  const visualLines = useMemo(
    () => wrapPoints.map((pts) => pts.length + 1),
    [wrapPoints],
  )
  // adj292：折行点经 ref 供光标跳转滚动读取（不加入 effect 依赖，避免输入重跑）
  wrapPointsRef.current = wrapPoints

  // adj201：视觉行起点偏移（每源码行前的累计视觉行数 × 行高）——折行后当前行
  // 背景/提示定位等按视觉行计算，不再按源码行（此前折行时光标行背景错位）
  const visualTopOfLine = useMemo(() => {
    const tops: number[] = []
    let acc = 0
    for (const v of visualLines) {
      tops.push(acc)
      acc += v
    }
    return tops
  }, [visualLines])
  // adj223：视觉行前缀和经 ref 供光标跳转滚动读取（避免加入 effect 依赖）
  const visualTopRef = useRef(visualTopOfLine)
  visualTopRef.current = visualTopOfLine

  /**
   * adj542：由「视口底部落在第几视觉行」反查**最后一个可见源码行号**，据此决定行号栏位数。
   * 用视觉行前缀和二分（折行算在同一源码行内），O(log n)，滚动时开销可忽略。
   */
  syncGutterDigitsRef.current = (top: number, clientH: number) => {
    const tops = visualTopRef.current
    if (tops.length === 0) return
    const lastRow = Math.floor((top + Math.max(0, clientH - 1)) / lineH)
    let lo = 0
    let hi = tops.length - 1
    let idx = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (tops[mid] <= lastRow) {
        idx = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    const need = Math.max(2, String(idx + 1).length)
    setGutterDigits((prev) => (prev >= need ? prev : need)) // 只增不减（缩窄会让代码区左右跳动）
  }

  // 光标写入 store + 谱面联动（M3）
  const onSelect = () => {
    const ta = taRef.current
    if (!ta) return
    const { line, col } = lineColOf(ta.value, ta.selectionStart)
    // adj196：光标移动离开上一行（鼠标点击/方向键/谱面跳转）→ 格式化该行。
    // 注意：此函数内部 setCode 会触发 onChange，但 onChange 中 editingLineRef 已更新
    // 为当前行，不会重复格式化。
    formatLeftLine(ta.value, line)
    setCursor(line, col)
    setSelection(ta.selectionStart, ta.selectionEnd)
    // adj291：传布局后的 index→页映射，使音符 id.page 与预览物理页一致（自动分页）
    const id = codePosToNoteId(ta.value, ta.selectionStart, noteIndexToPage ?? undefined)
    setActiveNoteId(id)
  }
  onSelectRef.current = onSelect

  // adj194：窗口/容器宽度变化（软折行重排）后强制同步 transform——
  // 否则动态 resize 过程中显示层与实际层折行位置短暂错位
  const onScrollRef = useRef(onScroll)
  onScrollRef.current = onScroll
  useEffect(() => {
    const onResize = () => onScrollRef.current()
    window.addEventListener('resize', onResize)
    // 拆分窗格拖动也会改变编辑器宽度（ResizeObserver 兜底）
    const ro = new ResizeObserver(onResize)
    if (taRef.current?.parentElement) ro.observe(taRef.current.parentElement)
    return () => {
      window.removeEventListener('resize', onResize)
      ro.disconnect()
    }
  }, [])

  // adj314：系统软键盘显示态 —— 跟随 textarea focus/blur，给「⌨」按钮高亮
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const onF = () => setKbActive(true)
    const onB = () => setKbActive(false)
    ta.addEventListener('focus', onF)
    ta.addEventListener('blur', onB)
    return () => {
      ta.removeEventListener('focus', onF)
      ta.removeEventListener('blur', onB)
    }
  }, [])

  // adj314：工具条插入 —— 与 applyCompletion 同范式：读 textarea → 拼接 → setCode → 光标定位。
  // cursorOffset 相对 insert 起点（默认末尾），用于带模板插入（如带声部名的描述头光标停在引号内）。
  // 注意：受控 textarea 无法 execCommand，必须 setCode 后 RAF 回位光标并联动 onSelect/updateCompletion。
  const insertAtCursor = (text: string, cursorOffset?: number) => {
    const ta = taRef.current
    if (!ta) return
    const pos = ta.selectionStart
    const next = ta.value.slice(0, pos) + text + ta.value.slice(ta.selectionEnd)
    setCode(next)
    const newPos = pos + (cursorOffset ?? text.length)
    requestAnimationFrame(() => {
      if (taRef.current) {
        taRef.current.selectionStart = taRef.current.selectionEnd = newPos
        onScroll()
        onSelect()
        updateCompletion()
      }
    })
  }

  // ———— adj323：一级工具条主键组浮层 ————
  // 点主键：读取工具条容器 rect（底边对齐），记录按钮 rect（水平跟随），弹出该组浮层并关闭自动提示
  // adj407：主键按钮按**开关**语义——同一组菜单已展开时再点即收起；点别的组直接换成那个组的菜单
  const openPadGroup = (group: PadGroup, rect: DOMRect) => {
    setCompletion(null)
    if (padMenuRef.current?.groupId === group.id) {
      setPadMenu(null)
      return
    }
    const area = padAreaRef.current?.getBoundingClientRect()
    setPadMenu({
      groupId: group.id,
      keys: group.keys,
      index: 0,
      area: area
        ? { x: area.left, y: area.top, w: area.width, h: area.height }
        : { x: 0, y: 0, w: 0, h: 0 },
      btn: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      keepOpen: !!group.keepOpen,
    })
  }
  // 点浮层项：插入；非 keepOpen 组插入后自动关闭
  const pickPadKey = (k: PadKey) => {
    insertAtCursor(k.insert, k.cursorOffset)
    if (!padMenuRef.current?.keepOpen) setPadMenu(null)
  }
  // 关闭浮层（点击浮层外 / Esc）
  const closePadMenu = () => setPadMenu(null)

  // adj314：「⌨」软键盘开关 —— blur 收起（可靠）；focus 在用户手势下通常能唤起 iOS/Android 软键盘，
  // 个别平台 focus 失效时用户仍可点编辑区唤回，不影响其它输入。
  const toggleSystemKb = () => {
    const ta = taRef.current
    if (!ta) return
    if (ta.matches(':focus')) {
      ta.blur()
    } else {
      ta.focus()
    }
  }

  // adj165：分析光标前文本，触发自动提示（& 修饰符 / [ 跳房子 / 描述头行首 Tab）
  const updateCompletion = () => {
    const ta = taRef.current
    if (!ta) return
    const pos = ta.selectionStart
    const before = ta.value.slice(0, pos)
    const lineBefore = before.slice(before.lastIndexOf('\n') + 1)
    // adj201：浮层 y 按视觉行（折行后光标行下有折行占位）；adj223：行数 × 行高转像素
    const compPos = (line: number, col: number) => ({
      x: col * effectiveFontSize * 0.6,
      y: ((visualTopOfLine[line - 1] ?? 0) + 1) * lineH,
    })
    // adj314：描述头（行首 Tab 补全）已由嵌入式输入工具条「描述头」组整段覆盖，取消弹列表；
    // 行首命令快捷键（Q/C/B/...）等行为保留在 onKeyDown。
    // adj335：取消 Y 行乐器补全（与 @ 补全一致）——乐器由输入工具条一步插入，或手动输入
    // `Y: @库id:乐器"显示名"` / `@乐器名`；避免补全列表过长。
    if (!/^Q(\d*(?:"[^"]*")?\s*:)/.test(lineBefore) && !/^\s*Q/.test(lineBefore)) {
      setCompletion(null)
      return
    }
    // adj335：取消曲行内 @ 乐器自动补全——动态乐器多时列表过长不便选择；
    // @乐器名 由用户手动输入（解析器仍识别），且输入工具条「乐器」组已可一步插入。
    if (modifierPrefix(lineBefore) === null) {
      setCompletion(null)
      return
    }
    const mod = modifierPrefix(lineBefore)
    if (mod !== null) {
      // adj203：小节线后（| &、:| &）提示小节线修饰符（&fine/&dc/&ds/&ty/&hs），
      // 音符后提示音符修饰符——按光标上下文切换候选池
      // adj632：倚音括号内（`6/[5/&`）只提示倚音支持的 5 个编码（其余写在里面会告警）
      const items = filterModifierHints(mod, isBarlineModifierContext(lineBefore), isGraceModifierContext(lineBefore))
      if (items.length === 0) {
        setCompletion(null)
        return
      }
      const { line, col } = lineColOf(ta.value, pos)
      // adj177：浮层定位在光标字符下方
      setCompletion({ kind: 'modifier', items, index: 0, ...compPos(line, col) })
      return
    }
    setCompletion(null)
  }

  // 补全候选（插入文本）
  const applyCompletion = (c: Completion) => {
    const ta = taRef.current
    if (!ta) return
    const item = c.items[c.index]
    if (!item) return
    const pos = ta.selectionStart
    const before = ta.value.slice(0, pos)
    const lineBefore = before.slice(before.lastIndexOf('\n') + 1)
    let insert = item.code
    let replaceLen = 0
    let cursorAt: number | null = null
    if (c.kind === 'modifier') {
      // adj177：用户已输入 &（lineBefore 以 & 结尾），只补全其后的字母——
      // 不再拼接第二个 &（此前 replaceLen 仅替换字母、insert 又含 &，会变成 &&tr）
      const m = /&([a-zA-Z+]*)$/.exec(lineBefore)
      if (m) replaceLen = m[1].length
      insert = item.code + ' '
      cursorAt = insert.length
    } else if (c.kind === 'instrument') {
      // adj302/302b：Y 行乐器补全（替换 Y: 后内容）或曲行 @ 乐器补全（替换 @ + 前缀）
      if (/^Q/.test(lineBefore)) {
        const m = /@([^@\s]*)$/.exec(lineBefore)
        if (m) replaceLen = 1 + m[1].length // @ + 已输入前缀
      } else {
        const m = /^(Y\s*:\s*)(@?)(.*)$/.exec(lineBefore)
        if (m) replaceLen = m[2].length + m[3].length // @ + 已输入前缀
      }
      insert = item.code
      cursorAt = insert.length
    }
    const next = ta.value.slice(0, pos - replaceLen) + insert + ta.value.slice(pos)
    setCode(next)
    const newPos = pos - replaceLen + (cursorAt ?? insert.length)
    requestAnimationFrame(() => {
      if (taRef.current) {
        taRef.current.selectionStart = taRef.current.selectionEnd = newPos
        onScroll()
        onSelect()
        setCompletion(null)
      }
    })
  }

  // 行首命令快捷键：光标在行首时按 Q/C/B/Z/D/P/J/V/H 插入命令头
  // 限制：歌词行（C 行）只允许插入 C；曲行（Q 行）只允许 Q/C；IME 合成事件排除
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = taRef.current
    if (!ta) return
    if (e.nativeEvent.isComposing) return // 输入法合成中不触发
    // adj323：主键组浮层键盘导航（↑↓ 选择 / Enter Tab 插入 / Esc 关闭）——复用同一套导航习惯
    const menu = padMenuRef.current
    if (menu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPadMenu({ ...menu, index: (menu.index + 1) % menu.keys.length })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPadMenu({ ...menu, index: (menu.index - 1 + menu.keys.length) % menu.keys.length })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const k = menu.keys[menu.index]
        if (k) pickPadKey(k)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closePadMenu()
        return
      }
    }
    // adj165：自动提示导航（↑↓ 选择 / Enter Tab 补全 / Esc 关闭）
    const comp = completionRef.current
    if (comp) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCompletion({ ...comp, index: (comp.index + 1) % comp.items.length })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCompletion({ ...comp, index: (comp.index - 1 + comp.items.length) % comp.items.length })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applyCompletion(comp)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCompletion(null)
        return
      }
    }
    // adj111：撤销/重做在编辑器内直接处理（受控 textarea 浏览器原生撤销无效；
    // stopPropagation 防止与 App 全局快捷键双重触发）
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      e.stopPropagation()
      undo()
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      e.stopPropagation()
      redo()
      return
    }
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
    // adj296b：回车换行（无补全时）→ 标记，onChange 后横向滚回新行行首光标；
    // 其余场景横向滚动仍由用户手动控制
    if (e.key === 'Enter') {
      enterKeyRef.current = true
      return
    }
    const key = e.key
    if (key.length !== 1 || !isLineHeaderKey(key.toUpperCase())) return
    const keyUp = key.toUpperCase() as Parameters<typeof insertLineHeader>[2]
    // 当前行类型（光标前内容）
    const before = ta.value.slice(0, ta.selectionStart)
    const lineText = before.slice(before.lastIndexOf('\n') + 1)
    const isMusicLine = /^Q\d*(?:"[^"]*")?\s*:/.test(lineText)
    const isLyricLine = /^C\d*\s*:/.test(lineText)
    if (isLyricLine && keyUp !== 'C') return // 编辑歌词时避免误触其他命令
    if (isMusicLine && keyUp !== 'Q' && keyUp !== 'C') return
    const insert = insertLineHeader(ta.value, ta.selectionStart, keyUp)
    if (!insert) return
    e.preventDefault()
    setCode(insert.text)
    requestAnimationFrame(() => {
      if (taRef.current) {
        taRef.current.selectionStart = taRef.current.selectionEnd = insert.pos
        onSelect()
      }
    })
  }

  // adj196：光标离开上一行时格式化该行（仅 Q 行）。输入（onChange）与光标移动
  // （onSelect：鼠标点击/方向键/谱面跳转）都触发——此前只有 onChange 处理，
  // 鼠标点击离开行不会格式化。
  // 返回是否已执行格式化（调用方据此跳过后续处理）。
  const formatLeftLine = (text: string, newLine: number): boolean => {
    if (!autoFormat) return false
    const prev = editingLineRef.current
    if (prev < 0 || prev === newLine) return false
    const li = prev - 1 // adj111：1-based 行 → 0-based 索引
    const lines = text.split('\n')
    const oldText = lines[li] ?? ''
    const formatted = formatLine(oldText)
    if (formatted === oldText) {
      editingLineRef.current = newLine
      return false
    }
    const delta = formatted.length - oldText.length
    lines[li] = formatted
    const replaced = lines.join('\n')
    const ta = taRef.current
    const off = ta ? Math.max(0, Math.min(ta.selectionStart + delta, replaced.length)) : 0
    setCode(replaced)
    requestAnimationFrame(() => {
      if (taRef.current) {
        taRef.current.selectionStart = taRef.current.selectionEnd = off
        onScroll()
        onSelect()
      }
    })
    editingLineRef.current = newLine
    return true
  }

  const onChange = () => {
    const ta = taRef.current
    if (!ta) return
    const next = ta.value
    const { line } = lineColOf(next, ta.selectionStart)
    // adj110：光标离开上一行时才格式化该行（仅 Q 行，formatLine 逐行处理），
    // 输入中不格式化 → 不抢光标；格式化行在光标上方，偏移量同步光标
    if (formatLeftLine(next, line)) return
    editingLineRef.current = line
    setCode(next)
    // adj165：输入后更新自动提示；adj296b：回车换行后横向滚回行首（仅此场景干预，
    // 其余光标可见性由浏览器原生保证）
    requestAnimationFrame(() => {
      updateCompletion()
      scrollToLineStartAfterEnter()
    })
  }

  useEffect(() => {
    return () => {
      if (formatTimer.current) window.clearTimeout(formatTimer.current)
    }
  }, [])

  // adj243：行内错误/告警块标记（col 相对该行内容）——命中块加红/橙单线外框
  /**
   * adj762（清单 B4：用户要求「源码高亮、错误信息显示提示等共性的功能都可以独立到引擎层面」，
   * 且"应用端也应同样处理"）：错误/告警块与"哪几行有问题"改由引擎的**整篇高亮模型**统一给出
   * （`highlightModel`）—— 此前这里是"自己按 col 攒块、自己造行号集合"，与插件那套是两份口径。
   */
  const hlModel = useMemo(() => highlightModel(code, parseResult.errors), [code, parseResult.errors])

  // adj227：按实际层折行点分视觉行高亮（每视觉行一个 .hl-line，white-space: pre）
  const html = highlightCodeWrapped(code, hlModel.problemLines, cursor, wrapPoints, groupBlocksByLine(hlModel.blockMarks))
  /**
   * adj642（用户要求："按下 Ctrl+F 时编辑区选中的文本自动成为查找框的内容，并完成查找，
   * 同时高亮编辑区里已找到的内容"）：把查找命中注册成**浏览器自己的高亮**。
   *
   * 做法见 `editor/findHighlight.ts`：用 CSS Custom Highlight API（`CSS.highlights` + `::highlight()`）
   * 在**语法高亮层**的文本节点上建 Range —— 那一层就在 textarea 底下、逐字符对应源码。
   * 这里只负责"拿到命中项 + 当前项"：
   *  · 查找内容/大小写来自 uiStore（与查找面板同一份，见该面板处的说明）；
   *  · 当前项 = 与选区完全重合的那一项（`currentMatchIndex`）。
   *
   * 换行归一：高亮层内部把 `\r\n` 规范成 `\n`（见 highlight.ts），所以按**同一份归一化后的代码**
   * 算命中，DOM 偏移才对得上；这正是 .jps 里极少见但仍可能出现的 CRLF 场景。
   */
  const findQuery = useUiStore((s) => s.findQuery)
  const findCase = useUiStore((s) => s.findCaseSensitive)
  const findHtmlRef = useRef<HTMLDivElement | null>(null)
  const normForFind = useMemo(() => {
    const norm = code.replace(/\r\n/g, '\n')
    const shifted = norm === code
    return { norm, shifted }
  }, [code])
  const findMatchesNow = useMemo(
    () => (findQuery ? findMatches(normForFind.norm, findQuery, { caseSensitive: findCase }) : []),
    [normForFind, findQuery, findCase],
  )
  // 选区（textarea 坐标）→ 归一化坐标：CRLF 时减去其前面的 `\r` 个数
  const findSel = useMemo(() => {
    if (normForFind.shifted) return sel
    const before = (p: number) => (code.slice(0, p).match(/\r\n/g)?.length ?? 0)
    return { start: sel.start - before(sel.start), end: sel.end - before(sel.end) }
  }, [normForFind, sel, code])
  useLayoutEffect(() => {
    applyFindHighlights(findHtmlRef.current, normForFind.norm, findMatchesNow, currentMatchIndex(findMatchesNow, findSel))
    return clearFindHighlights
  }, [html, normForFind, findMatchesNow, findSel])
  const gutterLines = Array.from({ length: lineCount }, (_, i) => i + 1)
  // adj242：行号字号跟随脚本字号后，按行号位数自适应栏宽（避免大字号/多位数被裁切）
  // adj542（用户要求）：**默认两位数**宽度；`gutterDigits` 只随滚动增长，且不超过整篇行数的位数
  // （所以短文档/删行后自然回到两位）。栏宽公式与原来一致，只把"位数"的来源换掉。
  const gutterNumW = Math.max(46, Math.max(2, Math.min(gutterDigits, String(lineCount).length)) * effectiveFontSize * 0.62 + 16)

  // 编辑器字号 → CSS 变量（--jp-editor-fs / --jp-editor-lh），驱动 textarea/高亮层/行号栏
  // adj163：字体值保留 monospace 回退——避免所选字体缺失时退化为非等宽默认字体导致
  // 高亮层加粗 span 与 textarea 逐字符错位
  // adj165：行高取整为整数——非整数行高（如 14×1.7=23.8px）在 textarea 原生行盒与
  // 高亮层 CSS 行盒中按各自方式取整，多行后累积错位（选中行高亮到另一行）
  const editorStyle = {
    '--jp-editor-fs': `${effectiveFontSize}px`,
    '--jp-editor-lh': `${lineH}px`,
    '--jp-editor-font': `${effectiveFont}, monospace`,
    // adj224：高亮层宽度跟随 textarea 内容区（滚动条占宽后两侧折行一致）
    '--jp-editor-content-w': taClientW > 0 ? `${taClientW}px` : '100%',
    // adj541：把行号栏宽度透出成变量——"展开底栏"悬浮按钮据此**居中在行号列上**（不压代码内容），
    // 且行号位数变化（栏宽自适应）时自动跟着居中。
    '--jp-gutter-w': `${gutterNumW}px`,
  } as React.CSSProperties

  return (
    <div className="editor-pane">
      {/* adj281：editor-head 已迁出到 EditorFootBar；编辑器主体直接铺满 */}
      <div className="editor-body" style={editorStyle}>
        <div className="editor-gutter" ref={gutterRef} aria-hidden="true" style={{ width: gutterNumW }}>
          <div className="editor-gutter-inner" ref={gutterInnerRef}>
            {gutterLines.map((n) => {
              const errs = errByLine.get(n)
              const vis = visualLines[n - 1] ?? 1
              // adj322：当前源码行（光标所在行）的行号也高亮，与整行背景统一（gutter-current）
              const cur = cursor && cursor.line === n
              // adj338：区分告警/错误，且告警/错误背景优先于当前行高亮——有 err 就不用 gutter-current
              const hasErr = errs?.some((e) => e.severity === 'error')
              const hasWarn = errs?.some((e) => e.severity !== 'error')
              const gutterCls = `gutter-line${hasErr ? ' gutter-err' : hasWarn ? ' gutter-warn' : ''}${cur && !errs ? ' gutter-current' : ''}`
              return (
                <div
                  key={n}
                  className={gutterCls}
                  style={{ height: vis * lineH }}
                  title={errs?.map((e) => e.msg).join('\n')}
                  onClick={() => onGutterClick(n)}
                >
                  <span className="gutter-num">{n}</span>
                  {/* adj195：折行延续标记（不占新行号，区分新行与折行） */}
                  {vis > 1 &&
                    Array.from({ length: vis - 1 }, (_, k) => (
                      <span key={k} className="gutter-wrap-mark" />
                    ))}
                </div>
              )
            })}
          </div>
        </div>
        <div className="editor-main">
          <textarea
            ref={taRef}
            value={code}
            spellCheck={false}
            wrap={autoWrap ? 'soft' : 'off'}
            // adj233：关闭自动折行时 white-space 改 pre——wrap=off 仅属性不足，
            // CSS pre-wrap 仍会软折行；pre 保证长行横向滚动、不折行对位正确；
            // adj235：选中自动折行时 overflow-x hidden——normal 下无空格长串溢出，
            // 取消横向滚动条（长串与高亮层同被裁剪，对位一致）
            style={{
              whiteSpace: autoWrap ? 'pre-wrap' : 'pre',
              overflowX: autoWrap ? 'hidden' : 'auto',
            }}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={onChange}
            onKeyDown={onKeyDown}
            onScroll={onScroll}
            onSelect={onSelect}
            onKeyUp={onSelect}
            onMouseUp={onSelect}
          />
          <div ref={hlRef} className="highlight-layer" aria-hidden="true">
            {/* adj225：innerRef 供 ResizeObserver 同帧同步宽度（拖动窗体不滞后） */}
            <div className="highlight-inner" ref={(el) => {
              innerRef.current = el
              hlInnerRef.current = el
            }}>
              {/* adj：去掉整行铺满背景 — 折行时整行 accent 8% 底色跨多视觉行过重；
                  当前块/选中由 .hl-current-block 背景（accent 18%）文字级高亮承担，参考排版按钮选中风格 */}
              <div
                className="highlight-content"
                /* adj642：查找高亮就在这一层上注册 Range（见 findHighlight.ts 的文件头说明） */
                ref={findHtmlRef}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
          </div>
          {/* adj165：自动提示浮层（& 修饰符 / Y/@ 乐器）；adj177：定位含内容层 padding（上 10 左 14）；
              adj192：靠下输入时浮层改为在光标上方弹出（否则列表超出窗口底部无法选择） */}
          {completion && (
            <CompletionPopover
              completion={completion}
              containerRef={taRef.current?.parentElement ?? null}
              lineH={lineH}
              onPick={(c) => applyCompletion(c)}
            />
          )}
        </div>

        {/* adj541（用户要求）：底栏收起时，在**行号栏位置**（不遮代码内容）浮出「展开底栏」按钮。
            放在 `.editor-body` 里、用 `--jp-gutter-w` 居中到行号列上——行号栏本身是 `aria-hidden`
            的装饰层，不能把可点按钮塞进去；放这里既能对齐行号列，又保留可访问性。
            又因为它属于 `.editor-body`（输入条 `.script-pad` 在其下方、属于 `.editor-pane`），
            输入条显示时按钮**自然位于输入条上方**、不占输入条位置。 */}
        {!dockOpen && (
          <button
            type="button"
            className="dock-fab"
            onClick={expandDock}
            // adj617（用户要求）：提示文本后面带上快捷键（Ctrl+D 展开/收起底栏）
            // adj1290：告警抽屉已独立，这里不再有"先看告警"的分支
            title={withKbd(dockCopy.expandTitle, KBD.dock)}
            aria-label={withKbd(dockCopy.expandTitle, KBD.dock)}
          >
            <ToolIcon name="dockExpand" />
          </button>
        )}
      </div>
      {/* adj314：嵌入式简谱输入工具条——编辑器底部常驻（编辑区与预览/分页之间），
          单行横向滑动，一级主键/软键盘开关（adj323：二级键改为浮层弹出） */}
      {showScriptPad && (
        <ScriptToolbar
          padAreaRef={padAreaRef}
          onGroupMenuOpen={openPadGroup}
          onToggleKb={toggleSystemKb}
          kbActive={kbActive}
          activeGroupId={padMenu?.groupId ?? null}
          onUndo={undo}
          onRedo={redo}
          canUndo={undoStackLen > 0}
          canRedo={redoStackLen > 0}
        />
      )}
      {/* adj323：一级主键组浮层——点主键在按钮位置弹出该组二级键（insert + 中文说明） */}
      {padMenu && (
        <PadMenuPopover
          menu={padMenu}
          onPick={pickPadKey}
        />
      )}
    </div>
  )
}

/** adj323c：一级工具条主键组浮层——底部统一对齐工具条顶边（所有菜单底部在同一水平线，
 *  向上弹出），水平尽量跟随被点按钮居中，越界钳制在视口内。每项显示「插入内容 + 中文说明」，点击即插入。 */
function PadMenuPopover({
  menu,
  onPick,
}: {
  menu: PadMenu
  onPick: (k: PadKey) => void
}) {
  const { area, btn, keys, index } = menu
  // 估算浮层宽度（高度不用估算：用 CSS bottom 定位让底边精确对齐，键数变化不影响底边）
  const estW = 290
  const viewW = window.innerWidth
  const viewH = window.innerHeight
  // 用 CSS bottom 定位（元素底边到视口底边的距离）：把底边精确放在工具条顶边上方 6px——
  // 所有菜单的**底边**都在同一水平线、紧贴工具条上方；键数多少、CSS max-height 钳制都不影响底边。
  const bottomInset = Math.max(0, viewH - (area.y - 6))
  // 顶边钳制：固定定位下底边位置已定，若内容过高顶边会越过视口顶——
  // 用 maxHeight 限制菜单高：上限 176px（≈6 个菜单项，adj328），且不超底边到视口顶的高度。
  const maxH = Math.min(176, Math.max(56, viewH - bottomInset - 6))
  // 水平：以按钮中心为基准居中跟随；越出视口则钳制到窗口内
  const btnCenter = btn.x + btn.w / 2
  let left = btnCenter - estW / 2
  left = Math.min(Math.max(6, left), viewW - estW - 6)
  return (
    <div
      className="pad-menu"
      style={{ position: 'fixed', left, bottom: bottomInset, maxHeight: maxH }}
      role="menu"
    >
      {keys.map((k, i) => (
        <div
          key={k.insert + k.label}
          role="menuitem"
          className={`pad-menu-item${i === index ? ' active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault() // 防止 textarea 失焦
            onPick(k)
          }}
        >
          <span className="pad-menu-insert">{k.insert}</span>
          <span className="pad-menu-label">{k.hint ?? k.label}</span>
        </div>
      ))}
    </div>
  )
}

/** adj192：自动提示浮层——靠下时翻转到光标上方显示，避免列表超出窗口底部 */
function CompletionPopover({
  completion,
  containerRef,
  lineH,
  onPick,
}: {
  completion: Completion
  containerRef: HTMLElement | null
  lineH: number
  onPick: (c: Completion) => void
}) {
  const { x, y, items } = completion
  // 估算浮层尺寸：每项约 24px + 上下 padding + 估算宽
  const estH = items.length * 24 + 8
  const estW = 240
  const containerW = containerRef?.clientWidth ?? 800
  const containerH = containerRef?.clientHeight ?? 600
  // 内容区 left padding=14；浮层左缘默认在光标右侧；超出右边界翻转到左侧
  const baseLeft = x + 14
  const flipH = baseLeft + estW > containerW
  const left = flipH ? Math.max(4, baseLeft - estW) : baseLeft
  // 默认在光标下方；超出底部翻转到上方，并钳制不超容器下沿
  const below = y + 10
  const flipV = below + estH > containerH
  const top = flipV
    ? Math.max(4, y - lineH - estH + 10)
    : Math.min(below, containerH - estH - 4)
  return (
    <div className="editor-completion" style={{ left, top }}>
      {items.map((it, i) => (
        <div
          key={it.code}
          className={`completion-item${i === completion.index ? ' active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault() // 防止 textarea 失焦
            onPick({ ...completion, index: i })
          }}
        >
          <span className="completion-code">{it.code}</span>
          <span className="completion-label">{it.label}</span>
        </div>
      ))}
    </div>
  )
}
