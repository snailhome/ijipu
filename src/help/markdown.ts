/**
 * help/markdown.ts — 帮助文档的 Markdown → HTML 渲染器（纯函数、零依赖）
 *
 * ## 为什么要有这个模块（adj876）
 *
 * 它原先写在 `dialogs/DocDialog.tsx` 里、**且没有导出**。于是官网的文档页
 * （`/manual/`、`/syntax/`）想显示同样的内容时只有两条路：再写一份渲染器，或者改架构。
 * 再写一份 ⇒ 两份迟早漂移（"网页上有的、应用里没有"）。
 *
 * 抽到这里之后，**应用内帮助与官网文档页消费同一个函数、同一份 `.md`**：
 *   · 应用内「帮助 → 操作手册 / 脚本语法说明」→ `dialogs/DocDialog.tsx`
 *   · 官网 `/manual/` `/syntax/`              → `docs/main.ts`
 * 另一层原因：oxlint 的 `react/only-export-components` 不允许组件文件导出非组件函数。
 *
 * 支持：标题 `#` / 多级列表 / 代码块围栏 / **表格** / **引用块** / 行内 `` `code` ``、**粗体**、*斜体*、[链接](url)
 *      / **反引号转义**（`\`` ⇒ 字面反引号、`\\` ⇒ 字面反斜杠，adj913；只有这两种，别的反斜杠原样保留）。
 *      / ` ```jps ` 块的显示参数（`v=` / `z=`，adj882）与 **`playground` 可调示例**（adj914，见 `jpsPlaygroundHtml`）。
 *
 * adj876 新增：标题补稳定 `id`（文档页左侧目录的锚点要用）+ 导出 `extractToc()`。
 * ⚠ **标题的 id 与目录的链接必须由同一套函数产出**（`createHeadingIds()` + `isHeading()`）——
 *   两边各自算一遍 slug，迟早会对不上，表现就是"目录点不动"。
 */

/** 目录条目（文档页左侧栏用它渲染） */
export interface TocItem {
  /** 标题层级：1–6 */
  level: number
  /** 标题纯文本（已去掉前导 `#`） */
  text: string
  /** 与正文 `<hN id>` 完全一致的锚点 */
  id: string
}

/** 是否是一行标题——渲染与建目录**必须**用同一个判据（`#` 后要有空格） */
export function isHeading(line: string): boolean {
  return /^#{1,6} /.test(line)
}

/** 标题行的层级（1–6）；非标题返回 0 */
export function headingLevel(line: string): number {
  return isHeading(line) ? Math.min(6, (line.match(/^#+/) as RegExpMatchArray)[0].length) : 0
}

/** 标题行的纯文本（去掉前导 `#` 与空白） */
export function headingText(line: string): string {
  return line.replace(/^#+\s*/, '')
}

/**
 * 标题文本 → 锚点 id。
 * 规则：只保留中文/字母/数字，其余字符当分隔符，连续分隔符合并成一个 `-`，去掉首尾 `-`。
 * 于是 `## 2.12b 替谱段 {tp … }（同一小节两遍不同奏法）` ⇒ `2-12b-替谱段-tp-同一小节两遍不同奏法`。
 * 全是符号的标题会得到空串，由调用方兜底成 `h`。
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 标题 id 分配器：按**出现顺序**发 id，重名的自动加 `-2`、`-3`。
 * 返回一个闭包而不是直接处理文本——因为渲染器是逐行流式处理，而建目录是另一遍扫描，
 * 两边各持一个分配器、按同样的顺序调用，id 才会完全一致。
 */
export function createHeadingIds(): (text: string) => string {
  const used = new Map<string, number>()
  return (text: string): string => {
    const base = slugifyHeading(text) || 'h'
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    return seen === 0 ? base : `${base}-${seen + 1}`
  }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * ` ```jps ` 代码块的**显示参数**（adj882）。
 *
 * 口径**沿用 Obsidian 插件的代码块参数**（`obsidian-ijipu/src/jpsBlocks.ts`），
 * 这样在插件笔记里写的 ` ```jps z=150 v=p ` 搬到网页文档里意思完全一样：
 *   · `v=<s|w|p>` —— **视图**：`s` 谱面（裁到墨迹，**默认**）/ `w` 满宽 / `p` 整页。
 *     为什么是 `v`：这三档在插件内部本来就叫 `ViewMode`（视图）。
 *     （`m=` 是同一个参数**短暂用过的旧名**，用户 2026-10 确认"刚设置的、可以直接改"⇒
 *      **直接废弃、不保留兼容**：少一套分支、少一段迁移提示，两端的口径也更干净。）
 *   · `z=<数字>` —— 缩放百分比（1–1000）；`z=*` = 自适应容器宽；未写 ⇒ 100（自然尺寸）。
 * 分隔符：空格为主，`,` `;` `|` 也认（有人习惯 `v=p,z=150`）；
 * **认不出的键值一律忽略**、**连写不算参数**（`z=150v=p` 两个都不认）—— 与插件同款容错。
 * 另有一个**网页文档专有**的关键字 `playground`（adj914，见 `JpsBlockParams.playground`）：
 * 插件那边它是一个"认不出的词"、被忽略 ⇒ 同一份 .md 在笔记里仍是一个普通代码块。
 */
export interface JpsBlockParams {
  mode: 's' | 'w' | 'p'
  zoom: number | '*'
  /**
   * adj914：**可调控件 + 实时预览**（info string 里多写一个 `playground` 关键字，
   * 形如 ` ```jps v=w z=150 playground `）。接口与裁切口径一个字不变 ——
   * 只是在这个块外面多一层控件（交互在 `help/jpsPreview.ts`，与「脚本 / 预览」同一份实现）。
   *
   * ⚠ **只在写了关键字时才出现这个字段**（不写成恒有的布尔）：既有的
   * "缺省 ⇒ 谱面 + 100"断言是逐字比对象字符串的，多一个恒假字段就会把它判红 ——
   * 而且那种红是"断言口径变了"，不是真有缺陷。
   */
  playground?: boolean
}

/**
 * 解析围栏后面的 info string。**不是 `jps` 就返回 `null`**（当普通代码块处理）。
 * 纯函数，便于 smoke 直接断言（文档里的示例一旦解析错，网页上就是一排不渲染的块）。
 */
export function parseJpsInfo(info: string): JpsBlockParams | null {
  const parts = info.split(/[\s,;|]+/).filter((s) => s !== '')
  if (parts.length === 0 || parts[0].toLowerCase() !== 'jps') return null
  let mode: JpsBlockParams['mode'] = 's'
  let zoom: number | '*' = 100
  let playground = false
  for (const part of parts.slice(1)) {
    // adj914：`playground` ⇒ 这一块渲染成「控件 + 实时预览」（网页文档/应用内帮助专有）
    if (/^playground$/i.test(part)) {
      playground = true
      continue
    }
    const v = /^v=([swp])$/i.exec(part)
    if (v) {
      mode = v[1].toLowerCase() as JpsBlockParams['mode']
      continue
    }
    const z = /^z=(\*|\d{1,4})$/i.exec(part)
    if (z) {
      if (z[1] === '*') zoom = '*'
      else {
        const n = Number(z[1])
        if (n >= 1 && n <= 1000) zoom = n
      }
    }
  }
  const out: JpsBlockParams = { mode, zoom }
  if (playground) out.playground = true
  return out
}

/**
 * ` ```jps ` 块 → 「脚本 / 预览」小组件。
 *
 * 结构上刻意把**源码留在 `<pre><code>` 里**（而不是塞进 data 属性）：
 * 没跑 JS 时它就是一段普通的、可复制的代码块 —— **降级是正确的**；
 * JS 到位后由 `help/jpsPreview.ts` 把它当"源码"读走并挂上渲染。
 */
function jpsBlockHtml(src: string, p: JpsBlockParams): string {
  const block =
    `<div class="jps-block" data-jps-mode="${p.mode}" data-jps-zoom="${p.zoom}">` +
    `<div class="jps-block-tabs" role="tablist">` +
    `<button type="button" role="tab" class="active" data-jps-tab="preview">预览</button>` +
    `<button type="button" role="tab" data-jps-tab="code">源码</button>` +
    `</div>` +
    `<pre class="jps-block-code"><code>${esc(src)}</code></pre>` +
    `<div class="jps-block-preview" hidden></div>` +
    `</div>`
  // adj914：写了 `playground` 的块，外面再套一层控件（交互在 help/jpsPreview.ts）
  return p.playground ? jpsPlaygroundHtml(block, p) : block
}

/** 缩放的滑块手感范围（数字框仍按文档口径 1–1000，滑块只取最常用的一段） */
const PG_SLIDER_MIN = 25
const PG_SLIDER_MAX = 300

/**
 * adj914（**用户要求**）：「代码块参数（`v=` 视图 / `z=` 缩放）这块最好能有调整设置项直观看到预览效果」。
 *
 * 做法：文档里多写一个关键字 `playground`（` ```jps v=w z=150 playground `），
 * 这一块就渲染成「控件 + 实时预览」：
 *   · **控件**：三档视图下拉（谱面 / 满宽 / 整页）+ 缩放滑块 + 数字输入（1–1000，照文档口径）
 *     + 「自适应（`z=*`）」勾选 + 「重置」；
 *   · 控件初值 = **同一行写的 `v=` / `z=`**，「重置」回到它；
 *   · 预览就是下面那个 `.jps-block`（与文档里其它示例**同一个组件**，不自造第二个）。
 *
 * 这里**只出标记与初值**（纯字符串，零依赖，可在 Node 里断言）；控件怎么驱动、怎么重排全在
 * `help/jpsPreview.ts` —— 那里也是**唯一**一处挂载点（三个消费方共用同一个模块）。
 *
 * ⚠ 文案直接写在这里（不搬 `brand/copy.ts`）：本模块是**纯函数、零依赖**且会被打进 Obsidian 嵌入版，
 *   同族的「脚本 / 预览」「正在渲染…」也都写在组件内 —— 保持一致，不为几个标签多引一层依赖。
 */
function jpsPlaygroundHtml(block: string, p: JpsBlockParams): string {
  /** `z=*` 时滑块/数字框给「取消自适应之后回到」的那个值（100 = 自然尺寸，与文档口径一致） */
  const auto = p.zoom === '*'
  // ⚠ 这里必须再判一次 `p.zoom`（TS 不能顺着 `auto` 这个变量收窄联合类型）
  const num = p.zoom === '*' ? 100 : p.zoom
  const slider = Math.min(PG_SLIDER_MAX, Math.max(PG_SLIDER_MIN, num))
  const option = (value: JpsBlockParams['mode'], text: string): string =>
    `<option value="${value}"${p.mode === value ? ' selected' : ''}>${text}</option>`
  return (
    `<div class="jps-playground" data-jps-playground="1">` +
    `<div class="jps-playground-controls">` +
    `<label class="jps-pg-field">视图` +
    `<select data-jps-view aria-label="视图（v=）">` +
    option('s', '谱面（裁到墨迹）') +
    option('w', '满宽') +
    option('p', '整页') +
    `</select></label>` +
    `<label class="jps-pg-field">缩放` +
    `<input type="range" data-jps-zoom-range min="${PG_SLIDER_MIN}" max="${PG_SLIDER_MAX}" step="5" value="${slider}" aria-label="缩放百分比（滑块）">` +
    `<input type="number" data-jps-zoom-num min="1" max="1000" step="5" value="${num}" aria-label="缩放百分比（1–1000）">` +
    `<span class="jps-pg-unit">%</span></label>` +
    `<label class="jps-pg-field jps-pg-auto">` +
    `<input type="checkbox" data-jps-auto${auto ? ' checked' : ''}> 自适应（z=*）` +
    `</label>` +
    `<button type="button" class="jps-pg-reset" data-jps-reset>重置</button>` +
    `</div>` +
    block +
    `</div>`
  )
}

/**
 * adj913（**用户实测**）：**反引号转义**的两个占位符。
 *
 * 文档里要"在**句子中间**显示字面的三个反引号"（例如「笔记里写一个 \`\`\`jps 代码块」），
 * 只能用转义写法写：源码里是「反斜杠 + 反引号」（`docs/PLUGIN-GUIDE.md` 4 处 / `docs/SYNTAX.md` 2 处）。
 * Obsidian 自己的渲染器认这个转义，**本渲染器原来不认** ⇒ 网页上把反斜杠原样显示出来、
 * 后面再跟一个代码片（同一个写法在 Obsidian 里正常、在官网文档页里不对）。
 *
 * 做法（保守，**只碰这两种序列**）：
 *   ① 先把 `\`` 与 `\\` 换成下面两个**私有区占位符**（正文里不可能出现），
 *      这样它们不会参与"反引号配对成行内代码"的匹配（否则会和行内代码逻辑打架）；
 *   ② 行内代码 / 粗体 / 斜体 / 链接都处理完、HTML 转义也做完之后，再把占位符还原成字面字符。
 *
 * ⚠ **只认这两种**：`\n`、`\d`、`C:\path` 这类**真实文本**里的反斜杠必须原样保留 ——
 *   本渲染器不是完整 Markdown（没有通用转义表），把反斜杠一律当转义符会吃掉别人的正文。
 * ⚠ 已知代价：占位是做在"配对行内代码"**之前**的（这正是为了不与反引号配对打架，见下），
 *   于是**行内代码片内部**的 `\`` 与 `\\` 也会被折叠 —— 而 CommonMark 里代码片内容是字面量。
 *   三份站点文档（USER-GUIDE / SYNTAX / PLUGIN-GUIDE）里**没有**这种写法（已逐份 grep 核对），
 *   真要写"代码里的反斜杠反引号"时用更长的反引号串包起来即可。
 * ⚠ 不用后行断言（lookbehind）：本模块会被打包进 Obsidian 插件（含 iOS 16.4 之前），
 *   审核规则明令禁止（见 `mdToHtml` 里 adj772 那段说明）。
 */
const ESCAPED_TICK = '\uE000'
const ESCAPED_BSLASH = '\uE001'

/**
 * 把 `\`` 与 `\\` 换成占位符。
 * **单趟从左到右扫描**（不用 lookbehind）⇒ 与 Markdown 的转义语义一致：
 * 例如 `\\\``（两个反斜杠 + 一个反引号）⇒ 「字面反斜杠 + 字面反引号」。
 */
function hideInlineEscapes(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const next = raw[i + 1]
    if (raw[i] === '\\' && next === '`') {
      out += ESCAPED_TICK
      i++
    } else if (raw[i] === '\\' && next === '\\') {
      out += ESCAPED_BSLASH
      i++
    } else {
      out += raw[i]
    }
  }
  return out
}

/** 占位符还原成字面字符。⚠ 必须在 HTML 转义**之后**做（反引号与反斜杠都不需要转义） */
function showInlineEscapes(html: string): string {
  return html.split(ESCAPED_TICK).join('`').split(ESCAPED_BSLASH).join('\\')
}

/**
 * 行内 Markdown：`code`、**bold**、*italic*、[text](url)、**![alt](图片)**。普通文本 HTML 转义，语法片段包裹标签。
 *
 * adj913：进来先 `hideInlineEscapes()`（`\`` / `\\` 占位）、出去再 `showInlineEscapes()` 还原 ——
 * 于是"句子中间的字面反引号"与"行内代码配对"两件事互不干扰。
 *
 * adj949（用户要求「手册中可以有更多的示例和截图」）：补**图片**支持 ——
 * 文档里的 `![说明](/docs/cli/xxx.png)` 现在产出真正的 `<img>`。
 * 口径：
 *   · **必须写在图片前面**（正则第一支），否则 `[说明](url)` 会先被链接那支吃掉，
 *     页面上留下一个字面的 `!` 加一个链接（改前的行为就是这样）；
 *   · 路径**原样透传**（`public/` 下的绝对网络路径 `/…` 在官网直接可取），只把 `"` 转义掉；
 *   · `alt` 只做 HTML 转义（不递归解析行内语法 —— 图片说明里不需要粗体/链接）；
 *   · `loading="lazy"`：文档页可能很长，图片不该拖慢首屏。
 */
export function inlineMd(raw: string): string {
  const src = hideInlineEscapes(raw)
  const re = /(!\[[^\]]*\]\([^)]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('![')) {
      const inner = tok.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
      const alt = inner ? inner[1] : ''
      const img = inner ? inner[2].replace(/"/g, '&quot;') : ''
      out += `<img src="${img}" alt="${esc(alt)}" loading="lazy" />`
    } else if (tok[0] === '`') {
      out += `<code>${esc(tok.slice(1, -1))}</code>`
    } else if (tok.startsWith('**')) {
      out += `<strong>${inlineMd(tok.slice(2, -2))}</strong>`
    } else if (tok[0] === '[') {
      const inner = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      const label = inner ? inlineMd(inner[1]) : tok
      const href = inner ? inner[2].replace(/"/g, '&quot;') : '#'
      out += `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`
    } else {
      out += `<em>${inlineMd(tok.slice(1, -1))}</em>`
    }
    last = re.lastIndex
  }
  out += esc(src.slice(last))
  return showInlineEscapes(out)
}

/**
 * 扫描 Markdown，产出目录（供文档页左侧栏使用）。
 * 与 `mdToHtml` 共用 `isHeading` / `headingLevel` / `headingText` / `createHeadingIds`，
 * 所以产出的 `id` 与正文标题上的 `id` 逐个相同——这是"目录点得动"的前提。
 *
 * ⚠ **必须跳过代码块**：`.jps` 的注释行就长成 `# 注释行…`，
 *   而语法说明里到处是这种代码块（`docs/SYNTAX.md` §2.1 就有）。
 *   不跳过的话，目录里会混进一堆"注释行"，而正文里它们根本不是标题
 *   ⇒ 目录多出点不动的条目。`mdToHtml` 里代码块内一律 `esc()` 输出，不会产出标题，
 *   两边的"标题集合"因此必须用同一个围栏判断（同款 `trimStart().startsWith(fence)`）。
 */
export function extractToc(md: string): TocItem[] {
  const nextId = createHeadingIds()
  const items: TocItem[] = []
  const fence = String.fromCharCode(96).repeat(3) // ``` 代码块围栏
  let inCode = false
  for (const rawLine of md.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.trimStart().startsWith(fence)) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    if (!isHeading(line)) continue
    const text = headingText(line)
    items.push({ level: headingLevel(line), text, id: nextId(text) })
  }
  return items
}

/** 极简 Markdown→HTML：标题 #、多级列表 -/数字、代码块 围栏、**表格**、**引用块**、普通段落 */
export function mdToHtml(md: string): string {
  const out: string[] = []
  let inCode = false
  const fence = String.fromCharCode(96).repeat(3) // ``` 代码块围栏（避免字面反引号）
  // 列表栈：每层 {tag 容器标签, liOpen 当前 <li> 是否未闭合（可容纳子列表）}
  const listStack: { tag: 'ul' | 'ol'; liOpen: boolean }[] = []
  // adj422：表格状态（连续的 | 行合成为一个 <table>；紧随表头的 |---| 分隔行标记为 thead）
  const table: { rows: string[][]; headRows: number } = { rows: [], headRows: 0 }
  const isTableRow = (s: string) => /^\s*\|.*\|\s*$/.test(s)
  const isTableSep = (s: string) => /^\s*\|[\s:|-]+\|\s*$/.test(s)
  // adj876：标题 id（与 extractToc 同源，见文件头说明）
  const nextHeadingId = createHeadingIds()
  /**
   * adj423：单元格切分——**只在未转义的 `|` 处切**（`\|` 是转义后的竖线，用于语法表里写 `|`、`||`、`:|:`）。
   * 此前用 `split('|')` 直接切，导致「小节线与反复」这类表格被切碎（E-2026-153）。
   *
   * adj772（**Obsidian 社区审核 Error**）：这里原来用**后行断言（lookbehind）**切分 ——
   * 该语法在 **iOS 16.4 之前不支持**，而本应用会被打包进 Obsidian 插件（嵌入版）供手机端使用
   * ⇒ 审核直接判 Error（`Lookbehinds are not supported on iOS versions before 16.4.`）。
   * 改为**手写扫描**（不用任何 lookbehind，语义与原来逐字等价：紧跟反斜杠的 `|` 不切）。
   * ⚠ 注释里也**不复述**那个正则 —— 审核是按**源码文本**扫描的（`webappAssets.ts` 就是这样被点到的）。
   */
  const cellsOf = (s: string) => {
    const body = s.trim().replace(/^\|/, '').replace(/\|$/, '')
    const parts: string[] = []
    let cur = ''
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (ch === '|' && body[i - 1] !== '\\') {
        parts.push(cur)
        cur = ''
      } else {
        cur += ch
      }
    }
    parts.push(cur)
    return parts.map((c) => c.trim().replace(/\\\|/g, '|'))
  }

  const closeAllLists = () => {
    while (listStack.length) {
      const top = listStack.pop()!
      if (top.liOpen) out.push('</li>')
      out.push(`</${top.tag}>`)
    }
  }

  /** adj422：把缓存的表格行输出成真正的 HTML 表格（前 headRows 行进 <thead>） */
  const flushTable = () => {
    if (table.rows.length === 0) return
    const head = table.rows.slice(0, table.headRows)
    const body = table.rows.slice(table.headRows)
    out.push('<table class="doc-md-table">')
    if (head.length) {
      out.push('<thead>')
      for (const r of head) out.push(`<tr>${r.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr>`)
      out.push('</thead>')
    }
    if (body.length) {
      out.push('<tbody>')
      for (const r of body) out.push(`<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`)
      out.push('</tbody>')
    }
    out.push('</table>')
    table.rows = []
    table.headRows = 0
  }

  // adj422：引用块——连续的 `> ` 行合成一个 <blockquote>（每行一个 <p>）
  let inQuote = false
  const closeQuote = () => {
    if (inQuote) {
      out.push('</blockquote>')
      inQuote = false
    }
  }

  /** 当前代码块若是 ```jps，用它装内容行（结束时产出 `.jps-block`）；其它语言保持 `null` */
  let jpsParams: JpsBlockParams | null = null
  let jpsLines: string[] = []

  for (const rawLine of md.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.trimStart().startsWith(fence)) {
      flushTable()
      closeQuote()
      if (inCode) {
        // 收尾：jps 块产出「脚本 / 预览」组件，其它块就是普通的 </pre>
        if (jpsParams) out.push(jpsBlockHtml(jpsLines.join('\n'), jpsParams))
        else out.push('</pre>')
        inCode = false
        jpsParams = null
        jpsLines = []
      } else {
        closeAllLists()
        // adj882：```jps 走「脚本 / 预览」组件；其余语言照旧当代码块（`jps` 之外的 info 一律忽略）
        jpsParams = parseJpsInfo(line.trimStart().slice(fence.length).trim())
        if (jpsParams) jpsLines = []
        else out.push('<pre>')
        inCode = true
      }
      continue
    }
    if (inCode) {
      if (jpsParams) jpsLines.push(line)
      else out.push(esc(line))
      continue
    }
    const t = line.trimEnd()
    // adj422：引用块（`> 文字`）——帮助文档开头常用来写"怎么读这份文档"
    if (/^>\s?/.test(t)) {
      closeAllLists()
      flushTable()
      if (!inQuote) {
        out.push('<blockquote>')
        inQuote = true
      }
      out.push(`<p>${inlineMd(t.replace(/^>\s?/, ''))}</p>`)
      continue
    }
    closeQuote()
    // adj422：表格——| 行连续排布，第二行是 |---| 分隔行时视为表头
    if (isTableRow(t)) {
      closeAllLists()
      if (isTableSep(t)) {
        table.headRows = table.rows.length
      } else {
        table.rows.push(cellsOf(t))
      }
      continue
    }
    flushTable()
    if (isHeading(t)) {
      closeAllLists()
      const level = headingLevel(t)
      const text = headingText(t)
      // adj876：带 id 的标题——文档页的目录锚点靠它；对应用内对话框来说多一个 id 无害
      out.push(`<h${level} id="${nextHeadingId(text)}">${inlineMd(text)}</h${level}>`)
    } else if (/^\s*[-*]\s+/.test(t) || /^\s*\d+\.\s+/.test(t)) {
      const indent = (t.match(/^\s*/)![0]).length
      const ordered = /^\s*\d+\.\s+/.test(t)
      const depth = Math.floor(indent / 2) // 2 空格一级
      const item = t.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')
      // 关掉比当前更深的层
      while (listStack.length - 1 > depth) {
        const top = listStack.pop()!
        if (top.liOpen) out.push('</li>')
        out.push(`</${top.tag}>`)
      }
      if (listStack.length - 1 < depth) {
        // 进入更深层：父级 <li> 需保持未闭合，以容纳子列表
        if (listStack.length === 0) {
          if (out.length && out[out.length - 1] !== '') out.push('')
        } else {
          const parent = listStack[listStack.length - 1]
          if (!parent.liOpen) {
            out.push('<li>')
            parent.liOpen = true
          }
        }
        while (listStack.length - 1 < depth) {
          const tag = ordered ? 'ol' : 'ul'
          listStack.push({ tag, liOpen: false })
          out.push(`<${tag}>`)
        }
      } else if (listStack.length > 0) {
        // 同级：闭合上一项并另起一项
        const top = listStack[listStack.length - 1]
        if (top.liOpen) {
          out.push('</li>')
          top.liOpen = false
        }
      }
      const level = listStack[listStack.length - 1]
      out.push(`<li>${inlineMd(item)}`)
      level.liOpen = true
    } else if (t === '') {
      closeAllLists()
      out.push('')
    } else {
      closeAllLists()
      out.push(`<p>${inlineMd(t)}</p>`)
    }
  }
  closeAllLists()
  flushTable()
  closeQuote()
  // 文件末尾还没闭合的围栏（写文档时漏了收尾）：jps 块照常产出组件，其余按代码块收尾
  if (inCode) {
    if (jpsParams) out.push(jpsBlockHtml(jpsLines.join('\n'), jpsParams))
    else out.push('</pre>')
  }
  return out.join('\n')
}
