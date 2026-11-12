/**
 * landing/samples.ts — 首页示例谱（adj877 建；adj883/adj892/adj893 精简；adj898 扩成示例集；adj901 全换真曲子）
 *
 * ## 示例从哪来
 *
 * · **茉莉花**用仓库里**已有的示例谱**（`public/samples/茉莉花.jps`）——它本来就有 smoke 断言守着；
 * · 其余六段是**为首页手写的真曲子**，并逐条过引擎闸门：**零错误、零告警**（见 smoke 的 `[164]` 段）。
 *
 * ## adj901（用户口径「示例里都换真曲子，使用的感受最直接」＋「按 A 做」＝**全部用公版**）
 *
 * adj898 那一版里，「倚音与连音」「跳房子与反复」「临时伴奏」「临时多声部」「多声部」
 * 五段的旋律是**为了演示语法编的** —— 语法对、但听着生硬，用户感受不直接。
 * 这一版**全部换成真实曲目**，而且**只选已过著作权保护期的作品**（作者去世满 50 年），
 * 因为首页是**公开发布**的（`ijipu.pages.dev`，且谱面片段会进公开 git 仓库）——
 * "只取片段"在法律上**不等于**免责：合理使用看的是"适当引用"（目的／比例／是否替代原作／署名），
 * 而音乐的"**实质性部分**"可能短到 2 小节（记忆点副歌），所以**公版才是干净的做法**。
 *
 * | 示例 | 曲目 | 作者 / 年代 | 演示什么 |
 * |---|---|---|---|
 * | 小星星 | 法国童谣 | 传统 | 最小示例（也是首屏预置的那段） |
 * | 茉莉花（完整） | 中国民歌 | 传统 | 成品（取 `public/samples/茉莉花.jps`） |
 * | 欢乐颂 | 贝多芬 | †1827 | `2[1]` 前倚音、`( )` 连音、`3.` 附点 |
 * | 两只老虎 | 法国童谣 | 传统 | `\|:` `:\|]` 反复、`["1."` / `["2."` 两遍房子、`\|\|]` 收尾 |
 * | 铃儿响叮当 | J. L. Pierpont | †1893 | `{bz … }` 临时伴奏（段内伴奏 ↔ 段后等长主旋律） |
 * | 送别 | 词 李叔同（†1942）／曲 Auld Lang Syne | 苏格兰民谣 | `{dsb … }` 临时多声部（上声部三度编配） |
 * | 友谊地久天长 | 苏格兰民歌 | 传统 | 四条 `Q` 轨的多声部（**用户复刻**的四声部片段） |
 *
 * ⚠ 曾用《雪绒花》，已换掉：罗杰斯（†1979）⇒ 1979+50 = **2029** 才过保护期，**仍在版权期内**。
 *
 * ⚠ **旋律按通行简谱整理**，仍请用户复核音高与节奏；
 * `{bz}` 的伴奏声部与 `{dsb}` 的上声部属**编配**（真实制谱本来就要自己配），
 * 但**主旋律都是真曲**。
 *
 * ## 关于"精简"（adj883 / adj892 / adj893 的来龙去脉）
 *
 * adj883（用户口径：「首页示例谱都先不带 `# jps-config:{}` 的设置，尽量简单，
 * 不要一开始就劝退了一帮人」）：剥掉 `# jps-config:{…}` 与装饰性分隔注释。
 * adj892（用户反馈）：「茉莉花应加个 **两端对齐最小小节:3**」——该字段直接决定每行会不会
 * 两端对齐，删了就不像成品 ⇒ 改为**白名单保留**（`KEEP_CONFIG_KEYS`）。
 * adj893（用户要求）：去掉描述头 `S:`（示例里那句"本乐谱使用「爱记谱」编制"是自述冗余）。
 * adj941（用户 2026-10-13 决定）：「现在可以把**所有示例谱**里的 `align_min_bars` 设置**去掉**了」——
 * `adj940` 之后"末行按小节序号对齐上一行"已是**默认行为**（不再读任何 `# jps-config` 键），
 * 该键只剩"末行撑不撑满"这一个作用（属"锦上添花"）⇒ 真源（`public/samples/茉莉花.jps`）
 * **只去掉这一个键**（其余 17 个键与值逐字保留）；白名单里那**唯一**一项随之落空 ⇒
 * 首页副本**连配置行一起丢掉**（不是"把配置行删了"，是白名单挑不出东西）。
 *
 * ⚠ 只精简**首页展示**用的副本；`public/samples/*.jps` 原文一个字都不动
 * （应用「打开示例」用的仍是完整谱面，那是"一打开就是成品"的场景）。
 *
 * ## 手写示例的规矩（用户 adj898 要求）
 *
 * 小节拍数与拍号一致、**以 `||` 收尾**（房子收尾的 `||]` 也算）、**不得有告警**。
 * 每一段都由 smoke 逐个验证 —— 3 拍还是 4 拍，眼睛看不出来，必须用引擎量。
 */
import moly from '../../public/samples/茉莉花.jps?raw'
/**
 * adj1190（用户 2026-11-03 拍板「合一份」）：首页示例的源码**不再写在这个文件里**。
 * 2026-11-13 示例谱正式留在应用侧：列表/源码由 `public/scores/**` 提供；
 * `public/scores/<slug>/score.jps` 的固定 `?raw` 导入只保留给旧示例常量和欢迎页兜底。
 * 这里只做 `?raw` 导入 + 原有变量名别名。
 *
 * 为什么保留别名而不是直接用导入名：下面每一段上方都写了大段"这段演示什么语法、
 * 当年踩过什么坑"的注释；换名字会把这些历史说明和代码断开。别名一层最省事。
 */
import xiaoXingXingSrc from '../../public/scores/star/score.jps?raw'
import odeToJoySrc from '../../public/scores/hls/score.jps?raw'
import frereJacquesSrc from '../../public/scores/lzlh/score.jps?raw'
import jingleBellsSrc from '../../public/scores/lexdd/score.jps?raw'
import farewellSrc from '../../public/scores/duet/score.jps?raw'
import auldLangSyneSrc from '../../public/scores/yydj/score.jps?raw'

/**
 * adj1197（S4）：首页示例改为 **tag 驱动**。
 *
 * 唯一规则：`meta.tags` 里含 `示例谱` 的条目才进首页；顺序按 `order`。
 * 源码仍从应用自己的示例读（public/scores），不在这里手写第二份。
 * 现有 7 首的静态 import 保留，只是为了不改动下面那一大段"这段演示什么语法"的历史注释；
 * 新加进库里的 `示例谱` 会自动走 glob，不用改这个文件。
 */
type HomeMeta = {
  slug: string
  title: string
  tags?: string[]
  order?: number
  file?: string
}
const HOME_METAS = {
  // 站点示例现在由本地乐谱库的发布区驱动；public/scores 只保留给下面的 ?raw 固定引用
  ...import.meta.glob('../../public/scores/**/meta.json', { eager: true, import: 'default' }),
} as Record<string, HomeMeta>
const HOME_SOURCES = {
  ...import.meta.glob('../../public/scores/**/score.jps', { eager: true, query: '?raw', import: 'default' }),
} as Record<string, string>

const HOME_LABELS: Record<string, string> = {
  star: '小星星',
  mlh: '茉莉花（完整）',
  hls: '欢乐颂（倚音与连音）',
  lzlh: '两只老虎（跳房子与反复）',
  lexdd: '铃儿响叮当（临时伴奏）',
  duet: '送别（临时多声部）',
  yydj: '友谊地久天长（多声部）',
  // 2026-11-06 示例迁入库后的 4 位 short
  'score-ag9y': '小星星',
  'score-9b6k': '茉莉花（完整）',
  'score-nevt': '欢乐颂（倚音与连音）',
  'score-qqwd': '两只老虎（跳房子与反复）',
  'score-qnhf': '铃儿响叮当（临时伴奏）',
  'score-mn73': '送别（临时多声部）',
  'score-uut8': '友谊地久天长（多声部）',
}

/**
 * 精简时**保留**的配置项（白名单）。
 *
 * 判据：**删了它，谱面看起来会明显不同**（不是"内部实现细节"）。
 *
 * ⚠ **当前是空的**（`adj941`，用户 2026-10-13 决定）：原先只列了一项 `align_min_bars`
 * （两端对齐最小小节数）——`adj892` 时用户要求首页示例的茉莉花**留住它**，
 * 因为那时"删了就不像成品、显示不会两边对齐"。但 `adj940` 之后
 * 「非末行一律两端对齐」与「末行按小节序号对齐上一行」都成了**默认行为**（不读任何 `# jps-config` 键），
 * 这个键只剩"末行撑不撑满"这一个作用 ⇒ 用户决定**示例谱里去掉它**（真源已只去这一个键）。
 * 于是白名单挑不出任何东西 ⇒ 首页副本的 `# jps-config:{…}` **整行丢掉**，
 * 首页示例回到"**默认配置就出正规的谱**"（`AGENTS.md` 五·12：其它设置只是锦上添花/个性设置）。
 *
 * 暂不保留的（都属"细节"或"冗长"，剥掉不影响"像不像成品"）：
 *   `note_size` / `geci_size` / `height_*`（字号行距微调）、`metaPos`（作者/调号坐标微调）、
 *   `geci_font`（一长串字体栈）、`margin_*`（页边距，谱面/满宽视图下看不出）。
 *   日后若发现某项**删了就明显不像话**，往这里加一行即可 —— 这就是白名单存在的意义。
 */
const KEEP_CONFIG_KEYS: readonly string[] = []

/** 装饰性分隔注释：`#===== 描述头定义 =====` 这类（`#` 后带一长串 `=` 或 `-`） */
const isDecorComment = (l: string): boolean => /^\s*#/.test(l) && /[=-]{4,}/.test(l)

/**
 * 描述头里的 `S:`（**谱尾说明**，adj893 用户要求去掉）。
 * ⚠ 判据锚在**行首**（`^\s*S\s*:`）⇒ 不会误伤 `# S: …` 这种注释行，也不会碰歌词 / 曲行。
 */
const isRemarkHeader = (l: string): boolean => /^\s*S\s*:/.test(l)

/** 页面设置行（`# jps-config:{…}`）的判定 */
const isConfigLine = (l: string): boolean => /^\s*#\s*jps-config\s*:/.test(l)

/**
 * 从 `# jps-config:{…}` 里只挑出白名单键，重写成一行。
 * 挑不出东西（该谱没有这些项）或 JSON 坏了 ⇒ 返回 `null`，调用方整行丢掉 ——
 * 首页示例不该因为一个配置块解析不了就整个崩掉。
 */
function keepConfigLine(line: string): string | null {
  const at = line.indexOf('{')
  if (at < 0) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line.slice(at)) as Record<string, unknown>
  } catch {
    return null
  }
  const kept: Record<string, unknown> = {}
  for (const key of KEEP_CONFIG_KEYS) if (key in obj) kept[key] = obj[key]
  return Object.keys(kept).length > 0 ? `# jps-config:${JSON.stringify(kept)}` : null
}

/** 删掉"给应用看的"与"示例里多余的自述"：页面设置只留白名单项，装饰注释与 `S:` 整行去掉 */
export function simplifyJps(src: string): string {
  const out: string[] = []
  for (const line of src.split('\n')) {
    if (isConfigLine(line)) {
      const kept = keepConfigLine(line)
      if (kept !== null) out.push(kept)
      continue
    }
    if (isDecorComment(line)) continue
    if (isRemarkHeader(line)) continue
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/**
 * 小星星 —— **最小示例**：4 小节、两句歌词，把"一行文本就是一段旋律"讲完。
 * 拍数：每小节 4 拍（`-` 是增时线，占 1 拍）；歌词 14 字对上 14 个音符（`-` 不配字）。
 * ⚠ 这段与 `index.html` 里块内**预置的源码必须逐字一致**（用户第一眼看到的就是它）。
 */
const XIAO_XING_XING = xiaoXingXingSrc

/**
 * 欢乐颂（贝多芬 †1827，**公版**）—— 演示**前倚音 `2[1]`、连音线 `( )`、附点 `3.`**。
 *
 * ⚠ 前倚音**必须附在某个音符之后**（`2[1]`），**不能**写在小节线后当"行首"——
 * 那样会被当成**跳房子标记** `["1."`（引擎原话：`跳房子 "[" 应写在小节线后（行首请用 |/ 或小节线）`）。
 * 这条是写这段时**被闸门抓出来**的，用户库里的真谱也是这个规律（`2[1/]`、`3.[3/5/]`）。
 *
 * 每小节 4 拍：`3`(1) + `(3 4)`(2) + `5`(1)；`5 4 3 2[1]`(1+1+1+1，倚音不占时值)；
 * `1`(1) + `(1 2)`(2) + `3`(1)；末小节 `3.`(1.5) + `2/`(0.5) + `2`(1) + `-`(1) = 4。
 * ⚠ 末小节最初写成 `3. 2 2 -`——那是 **4.5 拍**（附点是 1.5 拍），被闸门当场抓出来。
 */
const ODE_TO_JOY = odeToJoySrc

/**
 * 两只老虎（法国童谣，**公版**）—— 演示**反复 `|:` `:|]` 与两遍房子 `["1."` / `["2."`**。
 * 每小节 4 拍。
 *
 * ⚠ 末小节收尾是 **`||]`**（终止线在前、跳房子的结束括号在后）——
 * 这是**用户纠正**的：我原来写成 `|] ||`（先关房子再终止），顺序反了。
 * 用户原话：「`||` 后面的 `]` 是跳房子的结束，**本质上它也是以 `||` 结束乐句的**」。
 * 这条也正是 `adj899` 那次断言放宽的依据（`/\|\|\]?\s*$/` 而不是 `/\|\|\s*$/`）。
 */
const FRERE_JACQUES = frereJacquesSrc

/**
 * 铃儿响叮当（J. L. Pierpont）—— 演示**临时伴奏 `{bz … }`**。
 *
 * ⚠ `{bz … }` 的语义：**段内是伴奏声部，与段后等长的主旋律同一拍位对齐**。
 * 所以这里段内 4 小节（16 拍）配上段后 4 小节主旋律（16 拍），两者一一对齐。
 * 伴奏用低八度的主和弦分解（真实制谱的常见做法）。
 */
const JINGLE_BELLS = jingleBellsSrc

/**
 * 送别（李叔同 词 / J. P. 奥德曼 曲）—— 演示**临时多声部 `{dsb … }`**。
 *
 * `{dsb …}` 段内是**上声部**，段后等长的主旋律自动成为**下声部**。
 * 这里上声部按**三度平行**编配（`5→7`、`3→5`、`1'→3'`…），是真实制谱里最常用的和声手法。
 */
const FAREWELL = farewellSrc

/**
 * 友谊地久天长（Auld Lang Syne，苏格兰民歌，**公版**）—— 演示**多声部**（`Q1:`~`Q4:` 四条轨）。
 *
 * 由**用户复刻**（adj901/adj902）：他库里本来就有这首的四声部写法，
 * 比我原先用的《划船歌》好 —— 那是 6/8 卡农，而本引擎的 `6/8` 按"每小节 6 拍、时值以四分计"，
 * 写出来时值并不严谨。这一段是**真实的多声部编配**：4 小节、四个声部、每小节 4 拍。
 *
 * · 首小节每声部只有 1 拍 ⇒ **弱起**（引擎对首小节只要求"整数拍"，合法）；
 * · ⚠ 末小节原本以 `|` 收尾 ⇒ 按用户的硬要求改成 `||`（adj902）；
 *   用户随后又把末小节从 `6-- &hx 6` 改成 **`6---`**（adj903）——
 *   那是**长音收束**：原写法"渐强 + 一个短音"是"**接下一句**"的姿态，
 *   而这里是**独立片段**，需要收得住。四声部末小节因此都是 **4 拍**长音。
 */
const AULD_LANG_SYNE = auldLangSyneSrc

/**
 * 顺序即首页示例按钮的顺序。标签用**曲名 + 括号里的语法点** ——
 * 用户一眼能看出"这首是什么"，也能看出"这段演示什么写法"。
 */
/**
 * 顺序即首页示例按钮的顺序；**只收 tags 里含 `示例谱` 的条目**（S4）。
 * 标签优先 `HOME_LABELS`（保留"曲名 + 语法点"的老文案），新条目录直接用 title。
 */
const STATIC_SRC: Record<string, string> = {
  star: XIAO_XING_XING,
  mlh: moly,
  hls: ODE_TO_JOY,
  lzlh: FRERE_JACQUES,
  lexdd: JINGLE_BELLS,
  duet: FAREWELL,
  yydj: AULD_LANG_SYNE,
}

export const BRAND_SAMPLES: readonly { label: string; src: string }[] = Object.entries(HOME_METAS)
  .filter(([, meta]) => meta.tags?.includes('示例谱') === true)
  .sort((a, b) => (a[1].order ?? 100) - (b[1].order ?? 100) || a[0].localeCompare(b[0]))
  .map(([path, meta]) => {
    const dir = path.slice(0, path.lastIndexOf('/'))
    const raw =
      STATIC_SRC[meta.slug] ??
      HOME_SOURCES[`${dir}/score.jps`] ??
      (meta.file ? moly : '')
    if (raw === '') throw new Error(`首页示例 ${meta.slug} 缺少 score.jps`)
    return {
      label: HOME_LABELS[meta.slug] ?? meta.title,
      src: simplifyJps(raw),
    }
  })
