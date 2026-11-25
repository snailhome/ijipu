/**
 * cli.ts — iJipu 命令行**核心**（方案 A / A·P1）
 *
 * 设计口径见 `docs/CLI.md` 与 `docs/CLI-AND-COMMAND-PLAN.md`：
 *  · **纯逻辑**：`runCli(argv, io)` 不碰 `process`/`console`（IO 由调用方注入）⇒ 可被
 *    ① 打包成 node 可执行（`npm run cli`）、② 桌面端 exe 的子命令（决策①）、③ 冒烟测试直接调用；
 *  · **不重写引擎**：解析/格式化一律调 `@ijipu/engine`（"数值口径同源"，AGENTS §六之二·4）；
 *  · **退出码稳定**（见 `EXIT`）：脚本与 CI 靠它判断，不看文案 ✗；
 *  · **stdin/stdout 友好**：`-i -` 读 stdin、`-o -` 写 stdout（缺省也是 stdout）。
 *
 * 本阶段（P1）实现：`format` / `lint` / `info` + 全局选项 + `--json`。
 * `render` / `play` / `batch` / `settings` / `config` / `doctor` 属 P2–P4，**未实现时明确报错**（不假装成功 ✗）。
 */
import { formatJps, parseJps, splitParseIssues, layoutScore, renderScoreToSvg, buildPlaySequence, inferBpm, resolvePracticeRange, resolveBarBeatRange, eventsToMidi, defaultPageConfig, mergeJpsConfig, extractJpsConfig, OPTIONAL_CONFIG_FIELDS, rangeBox, applyRangeToSvg, readViewBoxOf, normalizeRangePad, inkBoxesOfLayout, type PageConfig, type ScoreLayout, type RangeBox, type ExportRange, type ProblemRow,
  // M0：MusicXML 导出（`.jps` → ScoreIR → MusicXML；纯文本、任意环境可用）
  parseJpsToIR, irToMusicXml,
  // adj962：把设置**写进谱面**（`set` 命令）——与应用的「保存设置」**同一份引擎实现**
  writeJpsConfig, mergeConfigEdits } from '@ijipu/engine'
// adj944：注册/解除 PATH 的**纯逻辑与编排**（与全局设置里那个按钮**共用同一份** ✓）
import {
  cliPathRegister,
  cliPathStatus,
  cliPathUnregister,
  PATH_MAX_CHARS,
  type PathHostIo,
} from './envPath'

/** 退出码：**对外承诺**，只增不改（脚本/CI 依赖它） */
export const EXIT = {
  ok: 0,
  usage: 1,
  noInput: 2,
  syntax: 3,
  render: 4,
  config: 5,
  /**
   * adj944：**环境能力缺失** —— 例如"注册/解除 PATH"要读写当前用户的注册表，
   * 这个能力只有桌面端 `ijipu.exe`（内嵌 CLI）有；独立 Node 环境没有 ⇒ 如实报 6，
   * 与"用法错误(1)""渲染能力缺失(4)"都分开（脚本据此就能判断"换个环境再跑"✓）。
   */
  env: 6,
} as const

/**
 * 目录里的一项（adj956）。
 *
 * 为什么不是"只回文件名"了：`batch` / `lint -i <目录>` 要能**递归子目录**（`-r`），
 * 而"名字"本身分不出哪个是目录 ✗。用一次 `readdir(withFileTypes)` 就拿到，不必额外 stat。
 */
export type DirEntry = {
  /** 条目名（不含路径） */
  name: string
  /** 是不是目录（递归时据此下钻） */
  dir: boolean
}

/** 注入式 IO（便于测试与"同 exe 子命令"复用） */
export type CliIo = {
  readStdin(): Promise<string>
  readFile(path: string): Promise<string>
  /** 文本或**二进制**（MIDI 等；adj802 起支持 `Uint8Array`） */
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  exists(path: string): Promise<boolean>
  /**
   * 列目录里**一层**的条目（`batch` / `lint -i <目录>` 用）。
   *
   * adj956：返回值从 `string[]` 改成 `DirEntry[]` —— 只有名字分不出目录，递归无从下手。
   * 约定：**按名字排序**（顺序可复现 ⇒ 输出能逐字节比对 ✓）、**只回一层**（递归由 CLI 自己下钻，
   * 免得把"要不要跟符号链接"这类平台细节塞进每个宿主）。
   */
  listDir(dir: string): Promise<DirEntry[]>
  /**
   * adj803（A·P3）**可选能力**：把 SVG 页栅格化成 png/jpg/pdf。
   *
   * 为什么是"可选能力"而不是实现细节：位图渲染需要 **canvas/字体/分页**（应用侧已有 ✓），
   * 纯 Node 环境下**不可能**凭空给出 ✗ ⇒ 由**宿主**（桌面端 exe 的隐藏窗口渲染通道）注入 ✓。
   * 未注入时 CLI **明确报错**（退出码 4）而不是假装成功 ✓。
   */
  rasterize?: (req: { svgs: string[]; type: 'png' | 'jpg' | 'pdf'; scale: number; title: string }) => Promise<Uint8Array[]>
  /**
   * adj803（A·P3）**可选能力**：MIDI → WAV（需要 AudioContext + 音色库 ⇒ 同理由宿主注入）。
   */
  synthesize?: (midi: Uint8Array) => Promise<Uint8Array>
  /**
   * adj1084 **可选能力**：导出动态谱视频（MP4）。
   *
   * 为什么必须是"宿主注入"：成片要 **WebCodecs**（`VideoEncoder` + `AudioEncoder`）与
   * 画布/字体/音色库，这些只在**桌面端的 WebView2** 里有；内嵌 CLI 跑在 QuickJS 里、
   * 独立 Node 更是连 DOM 都没有 ⇒ 由桌面宿主起一个隐藏窗口去编（`src-tauri/src/cli_video.rs`）。
   * 未注入时 `render -t mp4` **明确报错**（退出码 4），不产出半成品、也不假装成功。
   *
   * 传的是**已经解析好的音符 id**（`p_v_g_i` 形状，与界面标记段同一口径）：
   * 拍位 → 音符的换算在 CLI（纯函数、可单测），宿主只负责"照这份谱、这一段、这一遍"出片。
   */
  encodeVideo?: (req: {
    /** `.jps` 源码（宿主自己写临时文件也行，这里直接给文本，省一次读盘） */
    source: string
    /** 生效的页面配置（与 `render -t svg` 完全同一份，保证版面一致） */
    pageConfig: PageConfig
    /** 起始音符 id（含） */
    startId: string | null
    /** 结束音符 id（含）；`null` = 到曲末 */
    endId: string | null
    /** 第几遍（**0 起**；CLI 的 `--pass` 是 1 起，解析时已减一） */
    pass: number | null
    /** 输出文件（绝对路径或相对当前目录；宿主按此写盘） */
    output: string
    /** 画布比例（由 `--aspect` 决定；CLI 缺省 `9x16`，见 `runCli` 里的说明） */
    aspect: '9x16' | '1x1' | '16x9'
    /** `full` = 整曲（缺省）；`3min` = 单支上限 3 分钟 */
    mode: 'full' | '3min'
    /**
     * 片头/片尾卡片的模板（`brand` 深空蓝 / `paper` 纸面 / `ink` 水墨 / `minimal` 极简）。
     *
     * 与界面「卡片」下拉是**同一组模板**（`src/export/video/cardTemplates.ts` 的 `CARD_TEMPLATES`）；
     * 命令行只给这四种预设，`custom`（用户自己存的那份）不在此列 —— 自定义样式是本机偏好、
     * 换台机器就没有，放进命令行会变成"同一条命令在别人机器上出片不一样"。
     *
     * adj1114（用户 2026-10-23）：`null` = **不带片头片尾**（用户没写 `--card`，只出动态谱）。
     */
    cardStyleId: 'brand' | 'paper' | 'ink' | 'minimal' | null
    /**
     * adj1114：是否带音轨。缺省 `true`；`--nosound` 时 `false`（对应界面「带声音」未勾选）。
     * 宿主据此决定要不要渲音轨 —— 明确说"不要"，就不要白渲一条再丢掉。
     */
    withAudio: boolean
    /**
     * adj1166：声音来源。`synth` = 合成音（缺省，保持旧命令）；`file` = 伴奏；
     * `mix` = 伴奏+合成。任务文件里原样带给隐藏窗口。
     */
    sound: 'synth' | 'file' | 'mix'
    /** adj1166：`--sound file|mix` 时要用的对拍 sidecar 原文（`marks`/`trim`/`anchors`/`mix`） */
    syncText: string | null
    /** adj1166：伴奏绝对/相对路径（workdir 口径）；`synth` 时为 null */
    audioPath: string | null
    /** adj1166：两条音量（0–2；缺省 1） */
    accompGain: number
    synthGain: number
  }) => Promise<{ bytes: number; audio: boolean }>
  /**
   * adj814（A·P4 尾项）**可选能力**：监视文件变化（`--watch` 用）。
   * 与 `rasterize`/`synthesize` 同一口径：**宿主注入** ✓（node 入口用 `fs.watch` ✓；测试注入假实现 ✓）；
   * 未注入时 `--watch` **明确报错**（退出码 1）而不是"静默不监视" ✗。
   * @returns 取消监视的函数
   */
  watchFile?: (path: string, onChange: () => void) => () => void
  /**
   * adj944（用户需求「只有注册后，打开终端就能 `ijipu cli`」）**可选能力**：注入本机
   * "注册/解除 PATH"所需的 IO（安装目录 / 读写 `HKCU\Environment\Path` / App Paths）。
   *
   * 与 `rasterize`/`synthesize`/`watchFile` **同一口径**：由宿主注入 ✓ ——
   * 桌面端 exe（内嵌 CLI）注入 Rust 实现；独立 Node 入口**不注入** ⇒
   * `register`/`unregister`/`status` **明确报错（退出码 6）**，不假装成功 ✗。
   * 逻辑本身（字符串口径 + 编排）在 `envPath.ts`，与全局设置里那个按钮**共用一份** ✓。
   */
  pathHost?: PathHostIo
  out(text: string): void
  err(text: string): void
}

/** 命令结果（供测试断言与 `--json` 输出复用同一份事实） */
export type CliResult = {
  code: number
  /** `--json` 时写 stdout 的对象（`--json` 关闭时为 undefined） */
  json?: unknown
}

/**
 * 人类可读输出统一补换行：`io.out` 是"写一段文本"的语义（要拼接时也不吃亏），
 * 而 CLI 的每一行都是**独立**消息 ⇒ 这里集中补 `\n`（否则多行会挤成一行 ✗）。
 */
const line = (io: CliIo, text: string): void => {
  const NL = String.fromCharCode(10)
  // ⚠ 这里必须调用**原始**的 `io.out` —— 本轮我用全局替换把 `io.out(` 全换成了 `line(io, `，
  //   连助手自己也换了 ⇒ 无限递归（Maximum call stack size exceeded ✗）。教训：替换要排除定义处。
  io.out(text.endsWith(NL) ? text : text + NL)
}

/**
 * 帮助正文（`ijipu cli --help`）。
 *
 * ## 文案口径：正式、规范、优雅、简洁（用户 2026-10-14 定的官网同一条标准，`adj965m` 起同样管这里）
 *
 * **这是纯文本，会原样打到终端** ⇒ 里面不许出现 Markdown 强调（`**…**` 在终端里就是四个星号，
 * 用户看到的是 `必须**恰好**是`）与表情/警示符号（`⚠` 同理）。强调靠语序与「」，不靠标记。
 * 同一族毛病在官网修过一次（`adj948`：首页示例区字面 `**` 未渲染，`E-2026-432`）——
 * 那次只修了网页，**命令行这边漏了**，直到用户点名。
 *
 * 另外两条硬约束（都有闸门，别凭手感改）：
 *  · 用法行**逐字**是 `用法：ijipu cli [全局选项] <命令> [命令选项]`（`adj947`）；
 *  · 行宽按**显示列**（中文算 2 列）不超过 120 —— 常见终端一屏读得完，不做水平滚动。
 */
const HELP = `iJipu 命令行（爱记谱）

用法：ijipu cli [全局选项] <命令> [命令选项]

第一个参数必须恰为 cli：命令行与图形界面是同一个可执行文件，据此分流。
省略 cli（例如 ijipu 我的谱.jps、ijipu --help）会打开图形界面，不执行命令。
注册 PATH 后仍需写 cli：命令行入口不会代为补齐。

命令：
  format        -i <文件|-> [-o <文件|->] [--check] [--in-place] [--diff]   按应用规范规范化源码
  lint          -i <文件|目录|-> [--format text|json|gh] [--watch]          语法检查（有错 ⇒ 退出码 3）
                [-r] [--filter <通配>]                                    输入为目录时批量检查
  info          -i <文件|-> [-t text|json]                                  谱面概况（行数 / 分组 / 问题数）
  render        -i <文件|-> -t svg|midi|musicxml|png|jpg|pdf|mp4 -o <输出>   渲染导出
                [--crop page|score] [--pad N] [--ink x,y,w,h]              画布范围（缺省 page = 整页）
                [--from 27:3 --to 50:1 [--pass 2]]                        只导这一段（mp4）
                [--mark 段1]                                              按 sidecar 里的标记段名导出（与 from/to 互斥）
                [--sync <sidecar>]                                        对拍文件；缺省 <输入>.sync.json
                [--aspect 9:16|1:1|16:9]                                  画布比例（缺省 9:16）
                [--card [brand|paper|ink|minimal]]                        片头片尾模板（不写 = 不带；只写 = 极简）
                [--sound synth|file|mix]                                  合成音 / 伴奏 / 伴奏+合成（缺省 synth）
                [--accomp <音频>]                                         覆盖 sidecar 的伴奏路径（只配 file/mix）
                [--accomp-gain 0-2] [--synth-gain 0-2]                    伴奏 / 合成音音量（缺省 1；mix 合成 0.5）
                [--nosound]                                               导出无声视频（缺省带声音）
  play          -i <文件|-> -t midi|wav -o <输出>                           导出音频
  batch         --in <目录> [-o <目录>] [-t lint,svg,midi,fmt]              目录批量操作
                [-r] [--filter <通配>] [--in-place]                       任务可逗号组合；省略 -o ⇒ 产物写在各源文件旁
  settings      -i <谱> <键名> [-s k=v]                                     查看设置项的值与来源（只读）
  set           -i <文件|目录|-> k=v [k=v …]                                把设置写进谱面（源码里的 # jps-config）
                [--in-place | -o <目录>] [-r] [--filter <通配>]             不给落点 ⇒ 打到 stdout（不写入文件）
  config        -i <谱> [-t effective] [--quiet]                            打印生效设置全表与每项来源
  doctor        [--json]                                                    环境自检（如实报告能力有无）
  completions   bash|zsh|powershell                                         输出 shell 补全脚本
  register      [--json]                                                    注册命令行入口目录到当前用户 PATH
  unregister    [--json]                                                    从当前用户 PATH 解除注册
  status        [--json]                                                    查看是否已注册（读系统实况）

目录类选项（lint -i <目录>、batch、set 同此一套）：
  -r, --recursive            输入为目录时连同子目录（缺省只看当前一层）
  --filter <通配符>           只处理文件名匹配的项（支持 * 与 ?，如 --filter "春*"）；
                             输入为单个文件时不生效（既已指名文件，无须再筛）
  --in-place                 原地写回源文件（batch 中只对 -t fmt 有意义；与 -o 互斥）

产物落点（三选一；batch、set、format 同一套口径，差别仅在 -o 是目录还是文件）：
  -o <目录|文件>             另存到该处（batch、set 为目录，format 为文件）
  省略 -o                    产物写在各源文件旁（-r 递归时亦然；单文件加 format 或 set 时打到 stdout）
  --in-place                 原地覆盖源文件
    · set：把设置写进这份谱的常规写法，必须显式写出
    · batch -t fmt：原地覆盖会改动源文件，不写 --in-place 即拒绝
  仅 batch 的纯 -t lint 不产出文件，因此不需要 -o
  -o 与 --in-place 同时给出即语义冲突（一为另存、一为就地）⇒ 报用法错误（三处判定一致）
  format --check 为只读：即使同时给出 --in-place，也不写入任何字节

全局选项：
  -i, --input <文件|目录|-> 输入（- 为 stdin；省略时也读 stdin）；--in 为别名
  -o, --output <文件|->     输出文件（- 或省略为 stdout）；batch 中为输出目录
  -t, --type <类型>         输出类型（省略时按 -o 后缀推断；batch 中可用逗号组合）
  --json                    机器可读输出（带 schema 版本）
  --quiet                   不输出非必要信息
  --deterministic           输出不含时间戳（供 CI 逐字节比对）
  -s <k=v>                  临时设置（可重复；优先级最高，不落盘）
                            适用于 settings、config、render、play、batch；键名有误 ⇒ 退出码 5
  --config <文件>           CLI 配置文件（尚未实现；给出即退出码 5）
  -h, --help                帮助
  -v, --version             版本

需要桌面端能力的两类输出：render -t png|jpg|pdf|mp4（画布、字体、分页、WebCodecs）与 play -t wav（音频上下文、音色库）。
  具备宿主能力时正常产出；不具备时（独立 Node 环境）退出码 4 并说明原因，同时给出替代方案
  （-t svg、-t midi，或视频改用桌面端 ijipu cli render -t mp4）；不产出半成品，也不报成功。

视频的段落写法（只认 <小节>:<拍> 这一种，不写 --from/--to 即整曲）：
  --from 27:3 --to 50:1     从第 27 小节第 3 拍，到第 50 小节第 1 拍之前
  --pass 2                  反复段落里的第 2 遍（从 1 起；缺省按解析器的第一遍）
  拍号可带小数（如 27:3.5 = 第 27 小节第 3 拍的后半拍）；结束位置不含该拍那个音。

注册类命令（register、unregister、status）仅内嵌版可用（ijipu.exe cli register）：
  这三条需要读写当前用户的 PATH 与 App Paths，该能力由桌面端注入；无该能力时退出码 6 并说明原因。
  写入 PATH 的是命令行入口目录 <安装目录>\\bin；注册后终端里输出顺序、退出码与重定向均正常，
  双击 .jps 仍打开界面。注册后要新开一个终端才生效（已打开的终端读不到新 PATH）；
  仅对当前用户生效，不需要管理员权限。

退出码：0 成功 ｜ 1 用法错误 ｜ 2 输入不存在 ｜ 3 语法错误 ｜ 4 渲染失败 ｜ 5 设置非法 ｜ 6 环境能力缺失
`

type Parsed = {
  command: string
  inputs: string[]
  output: string | null
  type: string | null
  json: boolean
  quiet: boolean
  deterministic: boolean
  help: boolean
  version: boolean
  check: boolean
  inPlace: boolean
  diff: boolean
  /** adj814：`--watch`（监视文件变化后重跑检查 ✓） */
  watch: boolean
  format: 'text' | 'json' | 'gh' | null
  sets: string[]
  configPath: string | null
  unknown: string[]
  /**
   * adj873（T-3 补落点）：`render` 的画布范围。`null` = 用户没写 ⇒ **按现状（整页）** ✓
   * （缺省绝不静默改成"谱面" ✗）。取值在 `render` 里校验：只认 `page` / `score`。
   */
  crop: string | null
  /** adj873：`--crop score` 的每边留白（px；缺省 2，钳制 0–64，由引擎 `normalizeRangePad` 统一） */
  pad: string | null
  /** adj873：`--ink x,y,w,h` 显式墨迹盒（覆盖布局级估算；有 DOM 的宿主量到后可喂进来） */
  ink: string | null
  /**
   * adj956：`-r` / `--recursive` —— 目录输入要不要**下钻子目录**。
   *
   * 缺省是**不递归**：一次手滑就会扫出用户没预期的一大批文件（"我只想查这一层"是更常见的意图）。
   */
  recursive: boolean
  /**
   * adj956：`--filter <通配符>` —— 按**文件名**筛（支持 `*` 与 `?`，如 `--filter "春*"`）。
   *
   * 为什么按文件名而不是整条路径：这个 CLI 的批量操作都是"一个目录里的谱"，
   * 让用户去写路径通配更容易写错；真要按目录挑，多敲一次 `-i <子目录>` 更直观。
   */
  filter: string | null
  /**
   * adj1084：`render -t mp4` 的段落起止（**原始字符串**，在命令里再校验）。
   *
   * 口径（用户 2026-10-23 拍板）：只认 `<小节>:<拍>` 一种写法，例如 `27:3`；
   * 拍号从 1 起、可带小数。**不做** `27/3`、`@27/3` 之类的兼容写法（少一种写法就少一类歧义）。
   */
  from: string | null
  to: string | null
  /** `--pass <N>` 的原始字符串（1 起；同样在命令里校验） */
  pass: string | null
  /**
   * adj1115：`--aspect <9:16|1:1|16:9>` 的原始字符串（画布比例）。
   *
   * 只认界面上写的那三种（与相机位的「画布」按钮同一套词）；`9x16` 这类内部 id **不认** ——
   * 一种行为只留一种写法。缺省 `9:16`（adj1117 起与界面的默认画布一致；用户拍板：
   * 这个参数刚加、没有存量脚本要照顾，正好把两处缺省对齐）。
   */
  aspect: string | null
  /**
   * `--card [模板]` 的原始字符串：片头/片尾卡片（adj1114 起模板是**可选值**）。
   *
   * · `null` = 没写 `--card` ⇒ **不带**片头片尾（只出动态谱）；
   * · `''`   = 只写了 `--card`、后面没跟模板 ⇒ 用默认的**极简**（minimal）；
   * · 其它   = brand / paper / ink / minimal（用户 2026-10-23 口径）；
   *   `custom` 不开放 —— 那是本机偏好，见 `CliIo.encodeVideo` 的说明。
   */
  card: string | null
  /**
   * adj1114：`--nosound` —— 明确导出**不带声音**的视频（对应界面「带声音」未勾选）。
   * 缺省带声音；这是布尔开关，所以**不需要**再给 `--sound` 的反向写法。
   */
  nosound: boolean
  /**
   * adj1166：按**标记段名**导出（读 `.jps.sync.json` 的 `marks`）。
   *
   * 与 `--from/--to` 互斥：名字来自 sidecar、可能重名，只给日常使用；
   * 精确/无 sidecar 的脚本仍用 `--from/--to`。`--pass` 也不与 `--mark` 同用
   * （段自己的 `pass` 已经存在 sidecar 里）。
   */
  mark: string | null
  /** adj1166：对拍/标记段 sidecar 路径；缺省 = `<输入>.sync.json` */
  sync: string | null
  /**
   * adj1166：声音来源（只在 `-t mp4` 有意义）。
   * `synth` = 合成音（缺省，保持旧命令行为）；`file` = 伴奏；`mix` = 两者混合。
   */
  sound: string | null
  /** adj1166：覆盖 sidecar 里的伴奏路径（相对 sidecar 目录或绝对路径） */
  accomp: string | null
  /** adj1166：伴奏 / 合成音增益（0–2，缺省 1） */
  accompGain: string | null
  synthGain: string | null
}

/** 手写参数解析（**不引依赖** —— AGENTS §一"新增依赖必须先询问"，这里完全用不着） */
function parseArgs(argv: string[]): Parsed {
  const p: Parsed = {
    command: '',
    inputs: [],
    output: null,
    type: null,
    json: false,
    quiet: false,
    deterministic: false,
    help: false,
    version: false,
    check: false,
    inPlace: false,
    diff: false,
    watch: false,
    format: null,
    sets: [],
    configPath: null,
    unknown: [],
    crop: null,
    pad: null,
    ink: null,
    recursive: false,
    filter: null,
    from: null,
    to: null,
    pass: null,
    aspect: null,
    card: null,
    nosound: false,
    mark: null,
    sync: null,
    sound: null,
    accomp: null,
    accompGain: null,
    synthGain: null,
  }
  const takesValue = new Set(['-i', '--input', '-o', '--output', '-t', '--type', '-s', '--set', '--config', '--format', '--crop', '--pad', '--ink', '--filter', '--from', '--to', '--pass', '--aspect', '--card', '--mark', '--sync', '--sound', '--accomp', '--accomp-gain', '--synth-gain'])
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[i + 1]
      if (v === undefined) {
        p.unknown.push(a)
        return ''
      }
      i += 1
      return v
    }
    if (a === '-h' || a === '--help') p.help = true
    else if (a === '-v' || a === '--version') p.version = true
    else if (a === '--json') p.json = true
    else if (a === '--quiet') p.quiet = true
    else if (a === '--deterministic') p.deterministic = true
    else if (a === '--check') p.check = true
    else if (a === '--in-place') p.inPlace = true
    else if (a === '--diff') p.diff = true
    else if (a === '--watch') p.watch = true
    else if (a === '-r' || a === '--recursive') p.recursive = true
    else if (a === '--filter') {
      const v = next()
      if (v !== '') p.filter = v
    }
    else if (a === '-i' || a === '--input' || a === '--in') {
      /**
       * adj806：`--in` 是 `-i` 的别名 —— `docs/CLI.md` 里 `batch` 一直写的是 `--in <目录>`，
       * 但第一版解析器没认它 ✗（断言当场抓出来 ✓）。别名与文档保持一致。
       */
      const v = next()
      if (v !== '') p.inputs.push(v)
    } else if (a === '-o' || a === '--output') {
      const v = next()
      if (v !== '') p.output = v
    } else if (a === '-t' || a === '--type') {
      const v = next()
      if (v !== '') p.type = v
    } else if (a === '-s' || a === '--set') {
      const v = next()
      if (v !== '') p.sets.push(v)
    } else if (a === '--config') {
      const v = next()
      if (v !== '') p.configPath = v
    } else if (a === '--crop') {
      const v = next()
      if (v !== '') p.crop = v
    } else if (a === '--pad') {
      const v = next()
      if (v !== '') p.pad = v
    } else if (a === '--ink') {
      const v = next()
      if (v !== '') p.ink = v
    } else if (a === '--from') {
      const v = next()
      if (v !== '') p.from = v
    } else if (a === '--to') {
      const v = next()
      if (v !== '') p.to = v
    } else if (a === '--pass') {
      const v = next()
      if (v !== '') p.pass = v
    } else if (a === '--aspect') {
      const v = next()
      if (v !== '') p.aspect = v
    } else if (a === '--card') {
      /**
       * adj1114（用户 2026-10-23）：`--card` 的模板是**可选值**。
       *
       * 后面紧跟的词不以 `-` 开头才当模板名；否则（后面没词、或直接跟下一个选项）
       * 按"只给了 `--card`"处理 ⇒ `''` = 用默认的极简模板。
       * 为什么不复用 `next()`：它把"缺值"报成未知参数，而这里**缺值是合法写法** ✓。
       */
      const v = argv[i + 1]
      if (v !== undefined && v !== '' && !v.startsWith('-')) {
        i += 1
        p.card = v
      } else {
        p.card = ''
      }
    } else if (a === '--nosound') {
      p.nosound = true
    } else if (a === '--mark') {
      const v = next()
      if (v !== '') p.mark = v
    } else if (a === '--sync') {
      const v = next()
      if (v !== '') p.sync = v
    } else if (a === '--sound') {
      const v = next()
      if (v !== '') p.sound = v
    } else if (a === '--accomp') {
      const v = next()
      if (v !== '') p.accomp = v
    } else if (a === '--accomp-gain') {
      const v = next()
      if (v !== '') p.accompGain = v
    } else if (a === '--synth-gain') {
      const v = next()
      if (v !== '') p.synthGain = v
    } else if (a === '--format') {
      const v = next()
      if (v === 'text' || v === 'json' || v === 'gh') p.format = v
      else p.unknown.push(a)
    } else if (a.startsWith('-') && !p.command) p.unknown.push(a)
    else if (a.startsWith('-')) p.unknown.push(a)
    else if (p.command === '') p.command = a
    else p.inputs.push(a)
    // 满足 TS：takesValue 目前只用于文档性说明（保留以便后续扩展）
    void takesValue
  }
  return p
}

/** 读输入：`-` = stdin；否则读文件（不存在 ⇒ 抛 `ENOENT` 由调用方映射为退出码 2） */
async function readInput(spec: string | undefined, io: CliIo): Promise<{ text: string; fromStdin: boolean }> {
  if (spec === undefined || spec === '-') return { text: await io.readStdin(), fromStdin: true }
  return { text: await io.readFile(spec), fromStdin: false }
}

/**
 * adj1175：Windows `.bat` 里传中文文件名时，cmd 会按 OEM 代码页解析批处理，
 * UTF-8 中文会变成乱码（常带 `?`），到 CLI 时文件已经“不存在”了。
 * 只在路径里真的出现 `?`/替换符时提示，不干扰正常的“文件没找到”。
 */
function batchEncodingHint(spec: string | undefined): string {
  if (spec === undefined) return ''
  if (!spec.includes('?') && !spec.includes('\uFFFD')) return ''
  return (
    '\n提示：这像是 .bat 批处理文件编码问题（中文被按 OEM 代码页解析）。' +
    '请把 .bat 存为 ANSI/GBK，或在第一行加 chcp 65001 后存 UTF-8（无 BOM）；' +
    '也可以改用 for %%f in (*.jps) do ... 让 cmd 从目录取真实文件名。'
  )
}

/** 输出：`-o -` 或 `-o` 省略 = stdout；`-o 文件` = 写文件 */
async function writeOutput(spec: string | null, text: string, io: CliIo): Promise<string> {
  if (spec === null || spec === '-') {
    line(io, text.endsWith('\n') ? text : `${text}\n`)
    return '(stdout)'
  }
  await io.writeFile(spec, text)
  return spec
}

/** 由 `-o` 后缀/`-t` 推断输出类型（P1 只有文本类；P2 起 svg/midi 等） */
function inferType(p: Parsed): string {
  if (p.type !== null) return p.type.toLowerCase()
  const o = p.output
  if (o !== null && o.includes('.')) {
    const ext = o.slice(o.lastIndexOf('.') + 1).toLowerCase()
    if (ext !== '') return ext
  }
  return 'text'
}

/**
 * adj1084：`<小节>:<拍>` 的**唯一**解析口径（用户 2026-10-23 拍板：只用这一种写法）。
 *
 * · 小节从 **1** 起、拍从 **1** 起（与乐谱上的叫法一致："第 27 小节第 3 拍"）；
 * · 拍**可带小数**（`3.5` = 第 3 拍的后半拍，`3.25` = 第 3 拍的前四分之一处）；
 * · 其它写法（`27/3`、`@27/3`、`27-3`）**一律不认** —— 多一种写法就多一类"看着像却解析不成"的歧义。
 *
 * @returns 解析结果；写法不对 ⇒ `null`（由调用方报用法错误，不猜）
 */
export function parseBarBeat(raw: string): { bar: number; beat: number } | null {
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(raw.trim())
  if (m === null) return null
  const bar = Number(m[1])
  const beat = Number(m[2])
  if (!Number.isSafeInteger(bar) || bar < 1) return null
  if (!Number.isFinite(beat) || beat < 1) return null
  return { bar, beat }
}

/** 拍位比较的容差：`beatPos` 是累加出来的浮点数（0.9999999 要当成 1） */
/**
 * adj1101：`flattenScoreNotes` / `resolveBarBeatRange` 已搬到引擎（`layout/measureMap.ts`）——
 * 界面（标记段下拉显示 `33:1 - 34:2`）与命令行 `--from 33:1` 必须同一套小节/拍口径。
 * 这里**只做转出**（`cli-assert` 与本文件其它地方照旧从 CLI 导入，不会断）。
 */
export { flattenScoreNotes, resolveBarBeatRange, totalBarsOf } from '@ijipu/engine'
export type { ScoreSpotNote, BarBeatRange } from '@ijipu/engine'

/**
 * 取路径里的**文件名**。
 *
 * ⚠ adj962（**自己实测抓到的真 bug**）：一开始写的是 `p.split('/').pop()` —— 对**目录输入**
 * 没问题（`expandInputs` 拼出来的路径统一用 `/`），但**单文件输入**的路径是**用户原样给的**
 * （Windows 上就是 `D:\我的谱\a.jps`）⇒ `split('/')` 切不开，整条路径被当成文件名，
 * 最终拼成 `<输出目录>\D:\我的谱\a.jps`、`mkdir` 直接 ENOENT（7 个文件全失败）。
 * 所以这里 `\` 与 `/` **都算**分隔符。
 */
function baseNameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

/**
 * 拼路径。
 *
 * adj960：`-i .`（用户实报那次的写法）走出来的路径会带 `./` 前缀 ⇒ 归一化掉，
 * 免得逐行输出长成 `./samples/x.jps 第 3 行：…`、与"直接给目录名"的形态不一致。
 *
 * adj962：**沿用用户输入里那种斜杠** —— `set -i D:\我的谱 -o D:\输出` 的产物路径不能长成
 * `D:\输出/x.jps` 这种半截混合形态（`set` 是第一条会把拼好的输出路径打出来的命令）。
 * 输入里没有斜杠时用 `/`（跨平台默认；Windows 也认）。
 */
function joinPath(dir: string, name: string): string {
  const d = dir.replace(/[\\/]+$/, '')
  if (d === '' || d === '.') return name
  const sep = d.includes('\\') && !d.includes('/') ? '\\' : '/'
  return `${d}${sep}${name}`
}

/** 目录部分（两种斜杠都认；没有分隔符 ⇒ 当前目录） */
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i < 0 ? '' : p.slice(0, i)
}

/** 绝对路径判据（Windows 盘符 / UNC / Unix 根）；用于 sidecar 里的相对伴奏路径 */
function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

/**
 * adj956：把 `--filter` 的 `*` / `?` 通配符转成正则（大小写不敏感；只匹配**文件名**）。
 *
 * 刻意不引入 glob 依赖（`AGENTS §一`：新增依赖必须先询问）——`*` 与 `?` 两条就够用了，
 * 而且**只按文件名**匹配，写法越简单越不容易出错。
 */
function filterToRe(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`, 'i')
}

/**
 * adj956：把输入展开成"要处理的 `.jps` 列表"（`lint -i <目录>` 与 `batch` **共用这一份口径**）。
 *
 * · **目录** ⇒ 列一层（`recursive` 时下钻子目录），按 `.jps` 后缀 + `--filter` 筛；
 * · **文件** ⇒ 原样一条（`--filter` **对它不生效**：用户点名要这个文件，没有再筛掉的道理）。
 *
 * 目录/文件的判据是**试一次 `listDir`**：宿主能力里目前只有它能区分二者（`exists` 只给"在不在"）。
 * 这样不必为了"这是文件还是目录"再给三处宿主接线加一个 `statKind`；而在文件上 `listDir`
 * 必然失败 ⇒ 落到"当文件读"，与从前行为一致 ✓。
 */
async function expandInputs(
  target: string,
  io: CliIo,
  recursive: boolean,
  filter: string | null,
): Promise<{ files: string[]; isDir: boolean }> {
  const re = filter === null ? null : filterToRe(filter)
  const hit = (name: string): boolean =>
    name.toLowerCase().endsWith('.jps') && (re === null || re.test(name))
  /**
   * ⚠ **只对顶层这一次 `listDir` 的失败做降级**（"不是目录 ⇒ 当单文件"）。
   *
   * 子目录读失败**必须抛出去**：第一版把整个 `walk` 包在同一个 try 里 ⇒ 递归时某个子目录
   * 权限不足/被删，异常会被那个 catch 吞掉、降级成"把目录当文件读"，最终报的是
   * "输入不存在"——**根因被藏起来了**（这正是本项目反复记的"静默失败"那一类 ✗）。
   */
  let top: DirEntry[]
  try {
    top = await io.listDir(target)
  } catch {
    return { files: [target], isDir: false }
  }
  const out: string[] = []
  const walk = async (dir: string, entries: DirEntry[]): Promise<void> => {
    for (const e of entries) {
      if (e.dir) {
        if (recursive) {
          const child = joinPath(dir, e.name)
          await walk(child, await io.listDir(child))
        }
        continue
      }
      if (hit(e.name)) out.push(joinPath(dir, e.name))
    }
  }
  await walk(target, top)
  // 排序：宿主各自排过一层，但递归把多层拼起来后要靠这里统一（输出必须可复现 ✓）
  return { files: out.sort(), isDir: true }
}

/**
 * adj956（**修一个真 bug**）：把 `-s k=v` 解析成覆盖对象。
 *
 * 由来：`-s` 原先只在 `settings` / `config` 里被真正消费，但 [守卫](cli.ts) 同时放行了
 * `render` / `play` / `batch` —— 那三个命令**从头到尾没读过 `p.sets`** ⇒ 用户写
 * `batch --in 谱 -o 出 -t svg -s margin_right=10` 会"被接受、然后静默忽略"，
 * 是最坏的一种错：不报错、结果却不是他要的。现在**统一在这里解析、由调用方套用**。
 *
 * 值按需粗转：能当数字就当数字（`margin_right=33` 要变成 `33` 而不是 `"33"`），
 * 其余保留字符串（`page=A4`）；`true`/`false` 也认。
 */
function parseOverrides(sets: readonly string[]): { overrides: Record<string, unknown>; error?: string } {
  const overrides: Record<string, unknown> = {}
  for (const kv of sets) {
    const i = kv.indexOf('=')
    if (i <= 0) return { overrides, error: `-s 需要 k=v 形式（收到 “${kv}”）` }
    const key = kv.slice(0, i)
    const raw = kv.slice(i + 1)
    overrides[key] =
      raw === 'true' ? true : raw === 'false' ? false : raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw
  }
  return { overrides }
}

/**
 * adj956：生效配置 = 代码默认 ← 谱面 `# jps-config` ← **命令行 `-s`（最高）**。
 *
 * `-s` 必须**最后**展开：`mergeJpsConfig` 内部是"源码盖过 fallback"，把覆盖值塞进 fallback
 * 会被谱面里的值反过来盖掉 ⇒ 与 `--help` 承诺的"优先级最高"不符 ✗。
 */
function effectiveConfig(src: string, overrides: Record<string, unknown>): PageConfig {
  return { ...mergeJpsConfig(src, defaultPageConfig), ...overrides } as PageConfig
}

/**
 * 问题清单 → 一行文字（`--format gh` 用 GitHub Actions 注解格式）。
 *
 * ## adj960（**用户实报**）：批量输入必须**指明是哪个文件**
 *
 * 用户拿 `ijipu cli -i . -r lint` 查 54 个文件，输出里只有一片 `第 20 行：倚音内不支持的符号`
 * —— **对不上号**（哪个文件？）。用户给的判据很清楚：
 * **"输出的信息是单一文件独有、还是共同信息"** ⇒ **独有的必须带文件名，共同的（那句汇总）不带**。
 *
 * 于是这个函数收一个可选的 `file`，并成为**唯一一处**格式出处（此前 `batch` 里另写了一份
 * `<文件> 第 N 行：…`，而 `lint` 那份漏了文件名 —— 同一件事两处实现，必然漂 ✗）：
 *  · `gh`：`::error file=<文件>,line=N::<消息>`（GitHub 靠这个 file 把问题标到对应的 diff 上）
 *  · 文本：`<文件> 第 N 行：<消息>`
 *
 * ⚠ 单文件输入（`lint -i a.jps`）**也带**文件名 —— 与目录输入同一口径（用户那条判据不区分两者）；
 *   stdin 没有文件名，用 `(stdin)` 顶上。
 */
function issueLine(
  issue: { line?: number; message?: string; text?: string },
  gh: boolean,
  file: string,
): string {
  const ln = issue.line ?? 0
  const msg = String(issue.message ?? issue.text ?? '').trim()
  return gh ? `::error file=${file},line=${ln}::${msg}` : `${file} 第 ${ln} 行：${msg}`
}

/** 输入的文件名（stdin 用 `(stdin)`）——**逐项输出**统一用它做归属 */
function fileLabelOf(spec: string | undefined, fromStdin: boolean): string {
  return fromStdin || spec === undefined || spec === '-' ? '(stdin)' : spec
}

/**
 * adj873（T-3 补落点）：解析 `render --crop`。
 * **缺省 = `page`（整页）** —— 与本次改动前的行为逐字节一致 ✓（不静默改成"谱面" ✗）。
 * @returns `null` = 取值非法（调用方报用法错误）
 */
function normalizeCrop(v: string | null): ExportRange | null {
  if (v === null) return 'page'
  const s = v.toLowerCase()
  return s === 'page' || s === 'score' ? s : null
}

/** adj873：解析 `--ink x,y,w,h`（显式实测墨迹盒）；格式不对 ⇒ `null` */
function parseInkArg(v: string | null): RangeBox | null {
  if (v === null) return null
  const parts = v.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [x, y, w, h] = parts
  return w > 0 && h > 0 ? { x, y, w, h } : null
}

/**
 * adj873：按 `--crop` 把渲染产物的画布口径裁到所选范围。
 *
 * · `page` ⇒ **原样返回**（一个字都不动 ⇒ 与改动前逐字节一致 ✓）；
 * · `score` ⇒ 墨迹盒 + 每边 `pad` px。墨迹按优先级取：
 *   ① `--ink x,y,w,h`（宿主实测值）；② 引擎 `inkBoxOfLayout()` 的**布局级估算**（Node 无 DOM）。
 *   **两道可信度闸（退化 / 近整页）由引擎 `rangeBox()` 判**；不过 ⇒ 返回 `error`，
 *   由调用方**明确报错退出**（退出码 4），**绝不静默退回整页** ✗。
 *
 * 几何只有一份：这里只传参 + 消费引擎结论（`rangeBox` 算盒、`applyRangeToSvg` 改外框）✓。
 */
function cropSvgs(
  svgs: string[],
  layout: ScoreLayout,
  crop: ExportRange,
  pad: number | undefined,
  inkArg: RangeBox | null,
): { svgs: string[]; error?: string } {
  if (crop === 'page') return { svgs }
  const inks = inkBoxesOfLayout(layout)
  const out: string[] = []
  for (let i = 0; i < svgs.length; i += 1) {
    const page = layout.pages[i]
    const vb = readViewBoxOf(svgs[i])
    const pageW = vb?.[2] ?? page?.width ?? 0
    const pageH = vb?.[3] ?? page?.height ?? 0
    const r = rangeBox({ range: 'score', pageW, pageH, ink: inkArg ?? inks[i] ?? null, pad })
    if (!r.ok) {
      return {
        svgs,
        error:
          `--crop score 量不到可信的墨迹盒（第 ${i + 1} 页）：${r.reason ?? '未知原因'}\n` +
          `  · 有 DOM 的宿主可把实测盒喂进来：--ink x,y,w,h（如 --ink 50,80,495,600）；\n` +
          `  · 或改用 --crop page（整页，与不加 --crop 一致）。`,
      }
    }
    out.push(applyRangeToSvg(svgs[i], r.box))
  }
  return { svgs: out }
}

/**
 * 跑一次 CLI。**纯函数**：所有 IO 走 `io`，返回值即退出码。
 * @param argv 不含 `node` 与脚本路径（即 `process.argv.slice(2)`）
 */
export async function runCli(argv: string[], io: CliIo, meta?: { version?: string }): Promise<CliResult> {
  const p = parseArgs(argv)
  const version = meta?.version ?? '0.0.0'
  /**
   * ⚠ 提前声明：`doctor` / `settings` / `config` 等命令在**读输入之前**就要用它 ✗
   * （第一版把它放在读输入之后 ⇒ `ReferenceError: Cannot access 'wantJson' before initialization`）。
   */
  const wantJson = p.json || p.format === 'json'
  /**
   * adj956：**可设置项名单**（只此一处）——`settings` / `config` / `-s` 的键校验共用。
   * 顺序与 `docs/CLI.md` 的"生效设置全表"一致（默认字段在前、可选字段在后）。
   */
  const CONFIG_KEYS: string[] = [...Object.keys(defaultPageConfig), ...OPTIONAL_CONFIG_FIELDS]

  if (p.help) {
    line(io, HELP)
    return { code: EXIT.ok }
  }
  if (p.version) {
    line(io, `iJipu ${version}`)
    return { code: EXIT.ok }
  }
  if (p.unknown.length > 0) {
    io.err(`未知选项：${p.unknown.join(' ')}（用 --help 看用法）`)
    return { code: EXIT.usage }
  }
  if (p.command === '') {
    io.err('缺少命令（用 --help 看用法）')
    return { code: EXIT.usage }
  }
  if (p.configPath !== null) {
    io.err('--config 属 P4，尚未实现（当前只支持命令行 -s）')
    return { code: EXIT.config }
  }
  /**
   * adj956：`-s` 的**接受范围收敛到"真的会用它"的命令**。
   *
   * 原先这里放行了 `info` / `render` / `play` / `batch`，但**只有 `settings` / `config` 真的读了它**
   * ⇒ 另外那几条是"接受了、然后静默忽略"（最坏的一种错：不报错、结果却不是用户要的）。
   * 现在：`info` 从名单里去掉（它不看谱面设置），其余三条**本轮真的接上了**（见 `effectiveConfig`）。
   */
  if (p.sets.length > 0 && !['settings', 'config', 'render', 'play', 'batch'].includes(p.command)) {
    io.err(
      '-s 只对 settings / config / render / play / batch 有意义（临时生效，不落盘）。\n' +
        '  要把设置写进谱面（跟着文件走）用：ijipu cli set -i <谱> k=v --in-place',
    )
    return { code: EXIT.config }
  }
  /** `-s k=v` 的解析**只在这里做一次**（格式错就统一报退出码 5，各命令不必各写一遍） */
  const parsedSets = parseOverrides(p.sets)
  if (parsedSets.error !== undefined) {
    io.err(parsedSets.error)
    return { code: EXIT.config }
  }
  const overrides = parsedSets.overrides
  /**
   * adj956：覆盖键必须是**真的设置项**。
   *
   * 为什么非查不可：`-s margn_right=10` 这种拼错，如果原样塞进配置对象，引擎**不认识这个键**
   * ⇒ 排版结果一个字不变、退出码还是 0 —— 又是一个"静默忽略"。宁可当用法错误拦下来。
   */
  const badKeys = Object.keys(overrides).filter((k) => !CONFIG_KEYS.includes(k))
  if (badKeys.length > 0) {
    io.err(
      `-s 里有未知设置项：${badKeys.join('、')}\n` +
        `  可用键 ${CONFIG_KEYS.length} 个（config -i <谱> -t effective 可全量列出；可选字段：${OPTIONAL_CONFIG_FIELDS.join('、')}）`,
    )
    return { code: EXIT.config }
  }

  /**
   * adj802（A·P2）：已实现命令集合。
   * `render`：源码 → SVG（每页一段）或 MIDI；`batch`：目录批量转换。
   * ⚠ SVG 走引擎**估算**角标墨迹（Node 里没有 canvas 实测 ⇒ 与应用的实测版会有亚像素差异，
   *    这是"CLI 无 DOM"的必然取舍，已在 docs/CLI.md 写明口径）。
   */
  const known = new Set(['format', 'lint', 'info', 'render', 'play', 'batch', 'settings', 'set', 'config', 'doctor', 'completions', 'register', 'unregister', 'status'])
  if (!known.has(p.command)) {
    io.err(`命令 “${p.command}” 尚未实现（用 --help 看已实现命令）`)
    return { code: EXIT.usage }
  }

  // ── completions（P4）：输出补全脚本（纯静态文本，零依赖）────
  if (p.command === 'completions') {
    const shell = (p.inputs[0] ?? p.type ?? 'bash').toLowerCase()
    const COMMANDS = 'format lint info render play batch settings set config doctor completions register unregister status'
    /**
     * adj947（用户实报：`--help` 的用法行漏了 `cli`）：这三行**注释提示本身就是"怎么敲"**，
     * 同样必须带 `cli` —— 否则用户照抄 `ijipu completions powershell` 会走进图形界面 ✗。
     * ⚠ 这里**只改提示文案、不动补全逻辑**：脚本里的命令补全位次（bash 的 `COMP_CWORD -eq 1`、
     * zsh 的 `'1:command:…'`）是按 **Node 包形态**（`ijipu <命令>`）写的，
     * 与桌面端形态（`ijipu cli <命令>`）差一个参数位 —— 改它是**行为变更**，
     * 已在报告里列出待用户裁定，本轮不动 ✗（改了会让 Node 包那边的补全反过来坏掉）。
     */
    const scripts: Record<string, string> = {
      bash: `# iJipu bash 补全（桌面端）：source <(ijipu cli completions bash)\n_ijipu() {\n  local cur="\${COMP_WORDS[COMP_CWORD]}"\n  if [ "\$COMP_CWORD" -eq 1 ]; then COMPREPLY=( \$(compgen -W "${COMMANDS}" -- "\$cur") ); return; fi\n  COMPREPLY=( \$(compgen -f -- "\$cur") )\n}\ncomplete -F _ijipu ijipu\n`,
      zsh: `# iJipu zsh 补全（桌面端）：ijipu cli completions zsh > "\${fpath[1]}/_ijipu"\n#compdef ijipu\n_ijipu() { _arguments '1:command:(${COMMANDS})' '*:file:_files' }\n_ijipu "\$@"\n`,
      powershell: `# iJipu PowerShell 补全（桌面端）：ijipu cli completions powershell | Out-String | Invoke-Expression\nRegister-ArgumentCompleter -Native -CommandName ijipu -ScriptBlock {\n  param(\$wordToComplete, \$commandAst, \$cursorPosition)\n  @('${COMMANDS.split(' ').join("','")}') | Where-Object { \$_ -like "\$wordToComplete*" } | ForEach-Object {\n    [System.Management.Automation.CompletionResult]::new(\$_, \$_, 'ParameterValue', \$_)\n  }\n}\n`,
    }
    const text = scripts[shell]
    if (text === undefined) {
      io.err(`completions 支持 bash | zsh | powershell（收到 “${shell}”）`)
      return { code: EXIT.usage }
    }
    line(io, text)
    return { code: EXIT.ok, json: { schema: 1, shell } }
  }

  // ── doctor（P4）：环境自检（**如实报告能力有无**，不粉饰）────
  if (p.command === 'doctor') {
    const caps = {
      svg: true,
      midi: true,
      // M0：MusicXML 是纯文本（ScoreIR → 文本），任意环境都有，不依赖桌面渲染
      musicxml: true,
      raster: io.rasterize !== undefined,
      audio: io.synthesize !== undefined,
      // adj1084：动态谱视频（WebCodecs）——同样只有桌面宿主能给
      video: io.encodeVideo !== undefined,
    }
    const report = {
      schema: 1,
      generator: `ijipu ${version}`,
      engine: 'ijipu-engine',
      configKeys: Object.keys(defaultPageConfig).length + OPTIONAL_CONFIG_FIELDS.length,
      capabilities: caps,
      platform: 'cli',
    }
    if (wantJson) line(io, JSON.stringify(report, null, 2))
    else {
      line(io, `iJipu CLI doctor`)
      line(io, `  可设置项：${report.configKeys} 个（含可选字段 ${OPTIONAL_CONFIG_FIELDS.length} 个）`)
      line(io, `  能力：svg ✓｜midi ✓｜musicxml ✓｜位图(png/jpg/pdf) ${caps.raster ? '✓（桌面端通道已就绪）' : '✗（需桌面端隐藏窗口渲染）'}｜音频(wav) ${caps.audio ? '✓' : '✗（需音色库合成）'}｜视频(mp4) ${caps.video ? '✓（桌面端隐藏窗口）' : '✗（需桌面端隐藏窗口）'}`)
      line(io, `  提示：位图/音频在桌面端 exe 内可用；独立 Node 环境可用 svg/midi/musicxml ✓`)
    }
    return { code: EXIT.ok, json: report }
  }

  /**
   * ── register / unregister / status（adj944）：把 iJipu 注册进**当前用户 PATH** ──────
   *
   * 用户需求：「只有注册后，才能在打开终端时就能 `ijipu cli`」。
   * 口令全部复用 `envPath.ts`（**与应用界面那个按钮同一份实现** ✓），这里只做"接线 + 文案 + 退出码"。
   *
   * ⚠ 读写 PATH/App Paths 的能力由**宿主注入**（`io.pathHost`）：内嵌版 `ijipu.exe cli …` 有 ✓，
   *   独立 Node 环境没有 ⇒ **如实报退出码 6**（不假装成功 ✗）。
   */
  if (p.command === 'register' || p.command === 'unregister' || p.command === 'status') {
    const host = io.pathHost
    if (host === undefined) {
      io.err(
        `“${p.command}”需要读写当前用户的 PATH 或注册表，这个能力由桌面端注入（内嵌 CLI）。\n` +
          `  请改用：ijipu.exe cli ${p.command}（独立 Node 环境没有该能力 ⇒ 退出码 6）`,
      )
      return { code: EXIT.env }
    }
    if (p.command === 'status') {
      const st = await cliPathStatus(host)
      const payload = {
        schema: 1,
        registered: st.registered,
        installDir: st.installDir,
        binDir: st.binDir,
        legacy: st.legacy,
        pathLength: st.pathLength,
        pathLimit: PATH_MAX_CHARS,
        pathValue: st.pathValue,
        appPaths: st.appPaths,
      }
      if (wantJson) line(io, JSON.stringify(payload, null, 2))
      else {
        line(io, `iJipu CLI 注册状态：${st.registered ? '已注册 ✓（终端里可以直接敲 ijipu）' : '未注册 ✗（终端里还敲不了 ijipu）'}`)
        line(io, `  安装目录：${st.installDir}`)
        line(io, `  命令行入口目录（写进 PATH 的就是它）：${st.binDir}`)
        if (st.legacy) {
          line(
            io,
            '  注意：PATH 里还有旧的注册形态（安装目录本身）—— 它会与命令行入口抢 ijipu，' +
              '跑一次 `ijipu cli register` 会自动把它换成命令行入口目录 ✓',
          )
        }
        line(io, `  当前用户 PATH：${st.pathLength} / ${PATH_MAX_CHARS} 字符`)
        line(io, `  App Paths：${st.appPaths ?? '（未注册）'}`)
        if (!st.registered) {
          line(io, '  注册：ijipu cli register（注册后要新开一个终端才生效；只对当前用户生效、不需要管理员）')
        }
      }
      return { code: EXIT.ok, json: payload }
    }
    const action = p.command === 'register' ? await cliPathRegister(host) : await cliPathUnregister(host)
    if (!action.ok) {
      if (action.error.kind === 'too-long') {
        io.err(
          `注册后当前用户 PATH 会有 ${action.error.length} 字符，超过上限 ${action.error.limit} ⇒ 未写入（PATH 一个字都没改）。\n` +
            '  建议：① 先在「系统属性 → 环境变量」里删掉 PATH 中已经不存在的目录（反复装卸的软件常留一堆）；\n' +
            '        ② 或把 iJipu 装到更短的路径（例如 C:\\iJipu）后再注册；\n' +
            '        ③ 也可以不动 PATH，直接用完整路径调用：<安装目录>\\bin\\ijipu.cmd cli lint 我的谱.jps\n' +
            '           （或 <安装目录>\\ijipu.exe cli lint 我的谱.jps —— 后者的输出顺序与退出码不如上面那种可靠）',
        )
      } else {
        io.err(
          `“${p.command}”失败：${action.error.detail}\n` +
            '  可能原因：注册表写入被安全软件拦截，或当前用户无权写 HKCU\\Environment。',
        )
      }
      return { code: EXIT.env }
    }
    const st = action.status
    const payload = {
      schema: 1,
      changed: action.changed,
      registered: st.registered,
      installDir: st.installDir,
      binDir: st.binDir,
      legacy: st.legacy,
      pathLength: st.pathLength,
      pathValue: st.pathValue,
      appPaths: st.appPaths,
    }
    if (wantJson) line(io, JSON.stringify(payload, null, 2))
    else if (p.command === 'register') {
      line(
        io,
        `${action.changed ? '已注册 ✓ 命令行入口目录已加入当前用户 PATH' : '已是注册状态 ✓（PATH 里本来就有这一条，未重复写入）'}：${st.binDir}`,
      )
      line(io, '  · 请新开一个终端，之后就能直接敲：ijipu cli lint 我的谱.jps')
      line(io, '  · 只对当前用户生效，不需要管理员权限')
    } else {
      line(
        io,
        `${action.changed ? '已解除 ✓ 已从当前用户 PATH 里摘掉' : '本就未注册 ✓（PATH 里没有这一条，未改动 PATH）'}：${st.binDir}`,
      )
      line(io, '  · 其余 PATH 条目逐字未动；新开的终端里就不再能直接敲 ijipu 了')
      if (st.legacy) {
        line(io, `  · 旧形态（安装目录本身）也一并摘掉了：${st.installDir}`)
      }
    }
    return { code: EXIT.ok, json: payload }
  }

  // ── play（P3）：源码 → 音频（MIDI 任意环境；WAV 需宿主合成）────
  if (p.command === 'play') {
    let src = ''
    try {
      src = (await readInput(p.inputs[0], io)).text
    } catch (e) {
      io.err(`读输入失败：${String(e)}`)
      return { code: EXIT.noInput }
    }
    const type = (p.type ?? (p.output?.toLowerCase().endsWith('.wav') ? 'wav' : 'midi')).toLowerCase()
    const { errors } = splitParseIssues(parseJps(src))
    if (errors.length > 0) {
      io.err(`源码有 ${errors.length} 个错误，先修好再导出（用 lint 看细节）`)
      return { code: EXIT.syntax }
    }
    const parsed = parseJps(src)
    // adj956：`-s` 真的生效（此前 play 接受了 -s 却从不读它 ⇒ 静默忽略）
    const layout = layoutScore(parsed, effectiveConfig(src, overrides))
    const title = (parsed.header as unknown as Record<string, unknown>)['title']
    const bytes = eventsToMidi(buildPlaySequence(parsed, layout, 60).events, {
      bpm: 60,
      title: typeof title === 'string' ? title : 'iJipu',
    })
    if (type === 'midi') {
      if (p.output === null || p.output === '-') {
        io.err('MIDI 是二进制，必须用 -o 指定文件（不能用 stdout）')
        return { code: EXIT.usage }
      }
      await io.writeFile(p.output, bytes)
      if (!p.quiet) line(io, `已写入 ${p.output}（MIDI，${bytes.length} 字节）`)
      return { code: EXIT.ok, json: { schema: 1, type: 'midi', output: p.output, bytes: bytes.length } }
    }
    if (type === 'wav') {
      /**
       * adj803（A·P3）：WAV 需要"采样合成"（AudioContext + 音色库 ⇒ 应用侧已有 ✓）；
       * 由宿主注入 `synthesize`（桌面端隐藏窗口/后台合成）✓；无此能力 ⇒ 明确报错 ✓。
       */
      if (io.synthesize === undefined) {
        io.err(
          'WAV 需要采样合成（音色库 + AudioContext），当前环境没有该能力。\n' +
            '  可用：-t midi（任意环境）｜或改用桌面端：ijipu cli play -i <谱> -t wav -o <输出.wav>',
        )
        return { code: EXIT.render }
      }
      if (p.output === null || p.output === '-') {
        io.err('WAV 是二进制，必须用 -o 指定文件（不能用 stdout）')
        return { code: EXIT.usage }
      }
      const wav = await io.synthesize(bytes)
      await io.writeFile(p.output, wav)
      if (!p.quiet) line(io, `已写入 ${p.output}（WAV，${wav.length} 字节）`)
      return { code: EXIT.ok, json: { schema: 1, type: 'wav', output: p.output, bytes: wav.length } }
    }
    io.err(`play 的 -t 支持 midi | wav（收到 “${type}”）`)
    return { code: EXIT.usage }
  }

  // ── settings / config（P4）：设置分层可解释 ──────────────
  if (p.command === 'settings' || p.command === 'config') {
    let src = ''
    if (p.inputs.length > 0 && p.inputs[0] !== '-') {
      try {
        src = await io.readFile(p.inputs[0])
      } catch (e) {
        io.err(`读输入失败：${String(e)}`)
        return { code: EXIT.noInput }
      }
    }
    /** 三层来源（代码默认 ← 源内 # jps-config ← 命令行 -s）；`overrides` 已在上面统一解析并校验过 */
    const srcCfg = (extractJpsConfig(src) ?? {}) as Record<string, unknown>
    const merged = mergeJpsConfig(src, defaultPageConfig) as unknown as Record<string, unknown>
    const keys = CONFIG_KEYS
    const where = (k: string): string => {
      if (k in overrides) return '命令行 -s'
      if (k in srcCfg) return '源内 # jps-config'
      return '代码默认'
    }
    const valueOf = (k: string): unknown => (k in overrides ? overrides[k] : merged[k])
    const wantList = p.command === 'config' || p.inPlace /* --print-effective 走 -t effective 亦可 */
    if (p.type === 'effective' || wantList) {
      const rows = keys.map((k) => ({ key: k, value: valueOf(k), source: where(k) }))
      if (wantJson) line(io, JSON.stringify({ schema: 1, rows }, null, 2))
      else {
        line(io, `生效设置（来源：命令行 > 源内 # jps-config > 代码默认）`)
        for (const r of rows) {
          if (r.source === '代码默认' && p.quiet) continue
          line(io, `  ${r.key} = ${JSON.stringify(r.value)}   [${r.source}]`)
        }
      }
      return { code: EXIT.ok, json: { schema: 1, rows } }
    }
    const key = p.inputs[1] ?? p.inputs[0]
    if (key === undefined || !keys.includes(key)) {
      io.err(
        `settings 需要键名（位置参数），例如：settings -i <谱> margin_right\n` +
          `  可用键 ${keys.length} 个：settings -i <谱> -t effective 可全量列出；` +
          `可选字段：${OPTIONAL_CONFIG_FIELDS.join('、')}`,
      )
      return { code: EXIT.usage }
    }
    const payload = { schema: 1, key, value: valueOf(key), source: where(key) }
    if (wantJson) line(io, JSON.stringify(payload, null, 2))
    else line(io, `${key} = ${JSON.stringify(payload.value)}   [来自：${payload.source}]`)
    return { code: EXIT.ok, json: payload }
  }

  /**
   * ── set（adj962，**用户需求**）：把设置**写进谱面**（源码里的 `# jps-config`）────────────
   *
   * 由来（用户原话）：「如果要为指定文件/目录（批量）添加一个设置项及设置值，如何操作？」
   * —— 改之前 **做不到**：`-s k=v` 是**临时**覆盖（不落盘），`--config` 还没实现，
   * 而引擎里其实早就有这个能力（`writeJpsConfig` + `mergeConfigEdits`，应用「保存设置」走的就是它）
   * ⇒ 缺的只是 CLI 这一层接线。
   *
   * ## 三条口径（都不是新发明的，全是照抄既有的）
   *
   *  · **读=settings、写=set**（跟 `git config` 同一对）：`set` 只负责把 `k=v` 写进去。
   *  · **落点三选一，与 `format` / `batch` 完全同口径**：不给落点 ⇒ 打到 **stdout**（不改文件）；
   *    `--in-place` ⇒ 写回原文件；`-o <目录>` ⇒ 另存一份。目录输入**必须**给后两者之一
   *    （多份源码没法都打到 stdout）。
   *  · **差量写入**（`mergeConfigEdits` + `writeJpsConfig` 的 `diff` 模式）：只写"与现状不同"的项、
   *    保留文件里已有的其它项、与默认值相同的项**不写进谱面**、更**不把本机偏好固化进去**。
   *    ⚠ 绝不能直接 `writeJpsConfig(code, {…})` —— 那会把**整条设置行**换成只有我传的那几个键
   *    （文件里原有的设置会被抹掉）✗；所以必须走 `mergeConfigEdits(code, before, after)`。
   *
   * 逐项输出带**文件名**（`adj960` 的口径）；汇总行不带（共同信息）。
   */
  if (p.command === 'set') {
    /**
     * 位置参数：`k=v` 是"要写的设置"，其余（至多一个）是**输入路径**。
     * 于是两种写法都收：`set -i 我的谱.jps margin_right=33` 与 `set 我的谱.jps margin_right=33`。
     */
    const looksLikePair = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(s)
    const pairArgs = p.inputs.filter(looksLikePair)
    const restArgs = p.inputs.filter((s) => !looksLikePair(s))
    if (restArgs.length > 1) {
      io.err(`set 只接受一个输入路径（多给了 ${restArgs.length - 1} 个）；要写多个设置项就写多组 k=v`)
      return { code: EXIT.usage }
    }
    const setTarget = restArgs[0]
    if (pairArgs.length === 0) {
      io.err(
        'set 需要至少一组 k=v（要写进谱面的设置），例如：\n' +
          '  · ijipu cli set -i 我的谱.jps margin_right=33\n' +
          '  · ijipu cli set -i 乐谱 -r --in-place margin_right=33 page=A4\n' +
          '  · 只想"处理时按这个值来"、不写进文件：用 -s（如 render … -s margin_right=33）',
      )
      return { code: EXIT.usage }
    }
    const parsedSet = parseOverrides(pairArgs)
    if (parsedSet.error !== undefined) {
      io.err(parsedSet.error)
      return { code: EXIT.config }
    }
    const setEdits = parsedSet.overrides
    const badSetKeys = Object.keys(setEdits).filter((k) => !CONFIG_KEYS.includes(k))
    if (badSetKeys.length > 0) {
      io.err(
        `set 里有未知设置项：${badSetKeys.join('、')}\n` +
          `  可用键 ${CONFIG_KEYS.length} 个（config -i <谱> -t effective 可全量列出；可选字段：${OPTIONAL_CONFIG_FIELDS.join('、')}）`,
      )
      return { code: EXIT.config }
    }

    const setFromStdin = setTarget === undefined || setTarget === '-'
    if (p.inPlace && setFromStdin) {
      io.err('--in-place 需要文件输入（不能对 stdin 原地写）；要看结果就省略落点、打到 stdout')
      return { code: EXIT.usage }
    }
    const setOutDir = p.output !== null && p.output !== '-' ? p.output : null
    let setFiles: string[] = []
    let setTargetIsDir = false
    if (!setFromStdin) {
      let expandedSet: { files: string[]; isDir: boolean }
      try {
        expandedSet = await expandInputs(String(setTarget), io, p.recursive, p.filter)
      } catch (e) {
        io.err(`读目录失败：${String(e)}`)
        return { code: EXIT.noInput }
      }
      setTargetIsDir = expandedSet.isDir
      setFiles = expandedSet.files
    }
    if (setTargetIsDir) {
      if (setOutDir === null && !p.inPlace) {
        io.err('目录输入必须给 --in-place（写回原文件）或 -o <目录>（另存一份）：多份源码不能都打到 stdout')
        return { code: EXIT.usage }
      }
      if (setFiles.length === 0) {
        io.err(`目录里没有 .jps：${String(setTarget)}${p.recursive ? '' : '（子目录里的谱要加 -r 才会被扫到）'}`)
        return { code: EXIT.noInput }
      }
    }

    /**
     * 把一份源码按 `setEdits` 改好。**差量**：`mergeConfigEdits(code, before, after)` 只挑出
     * "本次真的改了"的键并**并进文件原有的设置**里 ⇒ 文件里别的设置项一个都不会丢 ✓。
     */
    const applySet = (src: string): { next: string; changed: boolean } => {
      const before = mergeJpsConfig(src, defaultPageConfig)
      const after = { ...before, ...setEdits } as PageConfig
      const next = writeJpsConfig(src, mergeConfigEdits(src, before, after))
      return { next, changed: next !== src }
    }

    // ① 单文件 / stdin，且**没给落点** ⇒ 打到 stdout（与 `format` 一致：只读不改）
    if (!setTargetIsDir && setOutDir === null && !p.inPlace) {
      let src = ''
      try {
        src = setFromStdin ? await io.readStdin() : await io.readFile(String(setTarget))
      } catch (e) {
        io.err(`读输入失败：${String(e)}`)
        return { code: EXIT.noInput }
      }
      const { next, changed } = applySet(src)
      await writeOutput(null, next, io)
      return {
        code: EXIT.ok,
        json: {
          schema: 1,
          generator: `ijipu ${version}`,
          input: fileLabelOf(setTarget, setFromStdin),
          changed,
          keys: Object.keys(setEdits),
        },
      }
    }

    // ② 有落点（`--in-place` 或 `-o`）：单文件或目录，逐个处理
    const targets = setTargetIsDir ? setFiles : [String(setTarget)]
    let changedCount = 0
    let unchangedCount = 0
    const setFailed: string[] = []
    const setRows: { input: string; output: string; changed: boolean }[] = []
    for (const file of targets) {
      let src = ''
      try {
        src = await io.readFile(file)
      } catch (e) {
        setFailed.push(`${file}（读失败：${String(e)}）`)
        continue
      }
      const { next, changed } = applySet(src)
      // adj962：用 `baseNameOf`（`\` 与 `/` 都算分隔符）—— 单文件输入的路径是用户原样给的
      const name = baseNameOf(file)
      const stem = name.replace(/\.jps$/i, '')
      const outPath = p.inPlace ? file : joinPath(String(setOutDir), `${stem}.jps`)
      try {
        await io.writeFile(outPath, next)
      } catch (e) {
        setFailed.push(`${file}（写失败：${String(e)}）`)
        continue
      }
      if (changed) changedCount += 1
      else unchangedCount += 1
      setRows.push({ input: file, output: outPath, changed })
      if (!p.quiet && !wantJson) {
        // 逐项信息**带文件名**（adj960 的口径）
        line(
          io,
          p.inPlace
            ? `${file} ${changed ? '已写回' : '未改动（设置值已与现状一致）'}`
            : `${outPath} 已写入（来自 ${file}${changed ? '' : '，内容未变'}）`,
        )
      }
    }
    const setPayload = {
      schema: 1,
      generator: `ijipu ${version}`,
      keys: Object.keys(setEdits),
      ...(setTargetIsDir
        ? { files: setRows, changed: changedCount, unchanged: unchangedCount, failed: setFailed }
        : {
            input: String(setTarget),
            output: setRows[0]?.output ?? String(setTarget),
            changed: setRows[0]?.changed ?? false,
            ...(setFailed.length > 0 ? { failed: setFailed } : {}),
          }),
    }
    if (wantJson) line(io, JSON.stringify(setPayload, null, 2))
    else if (setTargetIsDir && !p.quiet) {
      // 汇总行是**共同信息** ⇒ 不带文件名（adj960 的另一半）
      line(io, `已处理 ${targets.length} 个文件：${changedCount} 个有改动、${unchangedCount} 个未改动`)
    }
    if (!wantJson) for (const f of setFailed) line(io, `  ✗ ${f}`)
    return { code: setFailed.length === 0 ? EXIT.ok : EXIT.noInput, json: setPayload }
  }

  if (p.command === 'render') {
    let src = ''
    try {
      src = (await readInput(p.inputs[0], io)).text
    } catch (e) {
      io.err(`读输入失败：${String(e)}${batchEncodingHint(p.inputs[0])}`)
      return { code: EXIT.noInput }
    }
    const type = inferType(p)
    const { errors } = splitParseIssues(parseJps(src))
    if (errors.length > 0) {
      io.err(`源码有 ${errors.length} 个错误，先修好再渲染（用 lint 看细节）`)
      return { code: EXIT.syntax }
    }
    const cfg: PageConfig = effectiveConfig(src, overrides)
    const parsed = parseJps(src)
    /**
     * adj873（T-3 补落点）：`--crop page|score [--pad N] [--ink x,y,w,h]` 的参数校验。
     * **缺省 `page`**（= 改动前的整页行为，逐字节一致）✓；非法值一律报用法错误（不猜、不静默 ✗）。
     */
    const crop = normalizeCrop(p.crop)
    if (crop === null) {
      io.err(`--crop 支持 page | score（收到 “${String(p.crop)}”）`)
      return { code: EXIT.usage }
    }
    let pad: number | undefined
    if (p.pad !== null) {
      const n = Number(p.pad)
      if (!Number.isFinite(n)) {
        io.err(`--pad 需要数字（每边留白 px，0–64；收到 “${p.pad}”）`)
        return { code: EXIT.usage }
      }
      pad = normalizeRangePad(n)
    }
    const inkArg = parseInkArg(p.ink)
    if (p.ink !== null && inkArg === null) {
      io.err(`--ink 需要 x,y,w,h 四个正数（如 --ink 50,80,495,600；收到 “${p.ink}”）`)
      return { code: EXIT.usage }
    }
    /**
     * adj1084：`--from/--to/--pass` 只属于视频。
     *
     * 别的类型给了就报用法错误 —— 静默忽略是最坏的：用户以为"只导这一段"，
     * 实际拿到整页/整曲，还以为自己写对了。
     */
    if (
      type !== 'mp4' &&
      (p.from !== null ||
        p.to !== null ||
        p.pass !== null ||
        p.aspect !== null ||
        p.card !== null ||
        p.nosound ||
        p.mark !== null ||
        p.sync !== null ||
        p.sound !== null ||
        p.accomp !== null ||
        p.accompGain !== null ||
        p.synthGain !== null)
    ) {
      io.err(
        '--from / --to / --pass / --aspect / --card / --nosound / --mark / --sync / --sound / --accomp / --accomp-gain / --synth-gain 只用于 -t mp4（其它类型没有"第几拍""画布比例""片头卡片""音轨"这些概念）',
      )
      return { code: EXIT.usage }
    }
    if (type === 'mp4') {
      const target = p.output
      if (target === null || target === '-') {
        io.err('MP4 是二进制，必须用 -o 指定文件（不能用 stdout）')
        return { code: EXIT.usage }
      }
      if ((p.from === null) !== (p.to === null)) {
        io.err('--from 与 --to 要一起给（两个都不给 = 整曲）')
        return { code: EXIT.usage }
      }
      // adj1166：名字段与位置段是两套入口，不能同时给（否则不知道听谁的）
      if (p.mark !== null && (p.from !== null || p.to !== null)) {
        io.err('--mark 与 --from/--to 不能同时给：名字段请用 --mark；精确位置请用 --from/--to')
        return { code: EXIT.usage }
      }
      if (p.mark !== null && p.pass !== null) {
        io.err('--mark 已带标记段自己的遍次，不能再给 --pass；要换遍次请改用 --from/--to --pass')
        return { code: EXIT.usage }
      }
      const soundArg = (p.sound ?? 'synth').toLowerCase()
      if (soundArg !== 'synth' && soundArg !== 'file' && soundArg !== 'mix') {
        io.err(`--sound 支持 synth（合成音）| file（伴奏）| mix（伴奏+合成）；收到 “${String(p.sound)}”，不写则为 synth`)
        return { code: EXIT.usage }
      }
      if (p.nosound && (p.sound !== null || p.accomp !== null || p.accompGain !== null || p.synthGain !== null)) {
        io.err('--nosound 与 --sound / --accomp / --accomp-gain / --synth-gain 不能同时给')
        return { code: EXIT.usage }
      }
      if (p.accomp !== null && soundArg === 'synth') {
        io.err('--accomp 只用于 --sound file|mix（--sound synth 不使用伴奏）')
        return { code: EXIT.usage }
      }
      const gainOf = (raw: string | null, name: string, fallback: number): number | null => {
        if (raw === null) return fallback
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 0 || n > 2) {
          io.err(`${name} 需要 0–2 的数字（缺省 ${fallback}）；收到 “${raw}”`)
          return null
        }
        return n
      }
      const accompGain = gainOf(p.accompGain, '--accomp-gain', 1)
      if (accompGain === null) return { code: EXIT.usage }
      // 与相机位 DEFAULT_SYNC_MIX 一致：纯合成音按满音量（旧行为），mix 时合成音默认 0.5
      const synthGain = gainOf(p.synthGain, '--synth-gain', soundArg === 'mix' ? 0.5 : 1)
      if (synthGain === null) return { code: EXIT.usage }
      let from: { bar: number; beat: number } | null = null
      let to: { bar: number; beat: number } | null = null
      if (p.from !== null && p.to !== null) {
        from = parseBarBeat(p.from)
        to = parseBarBeat(p.to)
        if (from === null || to === null) {
          io.err(
            `段落写法是 <小节>:<拍>，小节与拍都从 1 起、拍可带小数（如 27:3、50:1.5）。\n` +
              `  收到：--from ${p.from} --to ${p.to}`,
          )
          return { code: EXIT.usage }
        }
      }
      let pass: number | null = null
      if (p.pass !== null) {
        if (!/^\d+$/.test(p.pass) || Number(p.pass) < 1) {
          io.err(`--pass 从 1 起（第 1 遍写 1，第 2 遍写 2）；收到 “${p.pass}”`)
          return { code: EXIT.usage }
        }
        if (from === null) {
          io.err('--pass 只用于段落导出：要同时给 --from 与 --to')
          return { code: EXIT.usage }
        }
        // CLI 对外 1 起；内部候选遍次 0 起（与界面下拉一致）
        pass = Number(p.pass) - 1
      }
      /**
       * adj1115（用户 2026-10-23 要求）：画布比例 `--aspect`。
       *
       * 只认相机位「画布」按钮上那三种写法（`9:16` / `1:1` / `16:9`），内部 id 是
       * `9x16 / 1x1 / 16x9`（与 `DYNAMIC_PRESETS` 的键、任务文件同一套）；`9x16` 这种内部写法
       * **明确不认** —— 一种行为只留一种写法，少一种写法就少一类"看着像却解析不成"。
       * 缺省 **9:16**（adj1117，用户拍板）：与界面相机位的默认画布一致。
       * 这个参数刚加、还没有存量脚本要照顾，正好把两处缺省对齐。
       */
      const ASPECT_IDS: Record<'9:16' | '1:1' | '16:9', '9x16' | '1x1' | '16x9'> = {
        '9:16': '9x16',
        '1:1': '1x1',
        '16:9': '16x9',
      }
      const aspectArg = (p.aspect ?? '9:16').trim()
      if (!(aspectArg in ASPECT_IDS)) {
        io.err(
          `--aspect 支持 9:16（竖屏）| 1:1（方形）| 16:9（横屏）；收到 “${String(p.aspect)}”，不写则为 9:16`,
        )
        return { code: EXIT.usage }
      }
      const aspect = ASPECT_IDS[aspectArg as '9:16' | '1:1' | '16:9']
      /**
       * 片头/片尾卡片（adj1114 起为**可选**，用户 2026-10-23 口径）：
       *  · 不写 `--card`        ⇒ **不带**片头片尾，只出动态谱；
       *  · 只写 `--card`        ⇒ 默认**极简**（minimal）；
       *  · `--card <模板>`      ⇒ brand / paper / ink / minimal 之一。
       * 收 `custom` 是**明确拒绝**而不是默默当 brand —— 自定义样式存在本机，
       * 同一条命令在别人机器上会出不同的片，那不该是命令行的语义。
       */
      const CARD_NAMES: Record<'brand' | 'paper' | 'ink' | 'minimal', string> = {
        brand: '深空蓝',
        paper: '纸面',
        ink: '水墨',
        minimal: '极简',
      }
      let cardStyleId: 'brand' | 'paper' | 'ink' | 'minimal' | null = null
      if (p.card !== null) {
        const cardRaw = (p.card === '' ? 'minimal' : p.card).toLowerCase()
        if (!(cardRaw in CARD_NAMES)) {
          io.err(
            `--card 的模板支持 brand（深空蓝）| paper（纸面）| ink（水墨）| minimal（极简）；收到 “${p.card}”。\n` +
              '  不写 --card = 不带片头片尾；只写 --card（后面不跟模板）= 极简。\n' +
              '  自定义卡片是本机偏好，只在界面里用；命令行不接受 custom（换台机器会出不一样的片）。',
          )
          return { code: EXIT.usage }
        }
        cardStyleId = cardRaw as 'brand' | 'paper' | 'ink' | 'minimal'
      }
      if (io.encodeVideo === undefined) {
        io.err(
          'MP4 需要"桌面端隐藏窗口"通道（WebCodecs 编码）；当前环境没有该能力。\n' +
            '  请在桌面端运行：ijipu cli render -i <谱> -t mp4 -o <输出> [--from 27:3 --to 50:1 --pass 2]\n' +
            '  或改用 -t svg（任意环境）｜-t midi（任意环境）。',
        )
        return { code: EXIT.render }
      }
      /**
       * adj1166：标记段名 / 伴奏都读同一份 `xxx.jps.sync.json`。
       * 缺省路径 = `<输入>.sync.json`；`--sync` 可覆盖（侧车不在旁边时）。
       *
       * 不在 `--sound synth` 且没有 `--mark` 时必须读 sidecar：显式 file/mix 缺文件要报错，
       * 不许静默退回合成音。
       */
      const inputPath = p.inputs[0]
      const syncPath =
        p.sync ??
        (inputPath !== undefined && inputPath !== '-' ? `${inputPath}.sync.json` : null)
      const needSidecar = p.mark !== null || soundArg !== 'synth'
      let syncText: string | null = null
      let syncObj: Record<string, unknown> | null = null
      if (needSidecar) {
        if (syncPath === null) {
          io.err('--mark / --sound file|mix 需要具体 `.jps` 输入（不能从 stdin）')
          return { code: EXIT.usage }
        }
        try {
          syncText = await io.readFile(syncPath)
        } catch {
          io.err(
            `找不到对拍文件：${syncPath}\n` +
              '  --mark / --sound file|mix 需要 xxx.jps.sync.json；可用 --sync 指定路径。',
          )
          return { code: EXIT.noInput }
        }
        try {
          const raw = JSON.parse(syncText) as unknown
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not object')
          syncObj = raw as Record<string, unknown>
        } catch {
          io.err(`对拍文件不是合法 JSON：${syncPath}`)
          return { code: EXIT.render }
        }
      }

      let markStartId: string | null = null
      let markEndId: string | null = null
      let markPass: number | null = null
      let markLabel = ''
      if (p.mark !== null) {
        const marks = Array.isArray(syncObj?.marks) ? (syncObj?.marks as unknown[]) : []
        const hits = marks.filter(
          (m): m is { id?: string; name: string; startId: string; endId: string; pass?: number } =>
            m !== null &&
            typeof m === 'object' &&
            (m as { name?: unknown }).name === p.mark &&
            typeof (m as { startId?: unknown }).startId === 'string' &&
            typeof (m as { endId?: unknown }).endId === 'string',
        )
        if (hits.length === 0) {
          const names = marks
            .map((m) => (m !== null && typeof m === 'object' ? (m as { name?: unknown }).name : ''))
            .filter((n): n is string => typeof n === 'string' && n !== '')
          io.err(
            `标记段里没有「${p.mark}」。${names.length > 0 ? `\n  现有：${names.join(' / ')}` : '\n  这份 sidecar 里没有 marks（先在试听里建标记段并保存）。'}`,
          )
          return { code: EXIT.usage }
        }
        if (hits.length > 1) {
          io.err(`标记段名「${p.mark}」不唯一（${hits.length} 条），请先改名；名字必须能唯一定位一段。`)
          return { code: EXIT.usage }
        }
        const m = hits[0]
        markStartId = m.startId
        markEndId = m.endId
        markPass = typeof m.pass === 'number' && Number.isFinite(m.pass) ? m.pass : null
        markLabel = m.name
      }

      let audioPath: string | null = null
      if (soundArg !== 'synth') {
        if (p.accomp !== null && !needSidecar) {
          io.err('--accomp 只用于 --sound file|mix')
          return { code: EXIT.usage }
        }
        const sidecarAudio = typeof syncObj?.audio === 'string' ? syncObj.audio.trim() : ''
        const audioRef = p.accomp ?? sidecarAudio
        if (audioRef === '') {
          io.err(
            `--sound ${soundArg} 需要伴奏：sidecar 里没有 audio，也没有给 --accomp。\n` +
              '  先用对拍台/相机位选一次伴奏（会写进 xxx.jps.sync.json），或显式 --accomp <音频文件>。',
          )
          return { code: EXIT.usage }
        }
        audioPath = isAbsolutePath(audioRef) ? audioRef : joinPath(dirOf(syncPath ?? inputPath ?? ''), audioRef)
      }
      let startId: string | null = null
      let endId: string | null = null
      let rangeText = '整曲'
      if (markStartId !== null && markEndId !== null) {
        startId = markStartId
        endId = markEndId
        pass = markPass
        rangeText = markLabel
      }
      if (from !== null && to !== null) {
        const layoutR = layoutScore(parsed, cfg)
        const r = resolveBarBeatRange(layoutR, from, to)
        if ('error' in r) {
          io.err(r.error)
          return { code: EXIT.usage }
        }
        startId = r.startId
        endId = r.endId
        rangeText = `${r.startLabel} → ${r.endLabel}`
        const sid = r.startId
        const eid = r.endId
        /**
         * `--pass` 的**可数性**：反复段落有几遍，由引擎的候选表说了算（与界面标记段同一份）。
         * 先在这里数清楚 —— 否则用户要等出片窗口起来，才收到一句"标记段已失效"，
         * 而真正的原因只是"这一段没有第 2 遍"。
         */
        if (pass !== null) {
          const seq = buildPlaySequence(parsed, layoutR, inferBpm(parsed))
          const cand = resolvePracticeRange(seq, sid, eid)
          const n = cand.candidates.length
          if (n <= pass) {
            io.err(
              n === 0
                ? '这一段找不到可放映的遍次（起止之间没有音符）'
                : `这一段只有 ${n} 遍（没有第 ${pass + 1} 遍）；--pass 只能是 1${n > 1 ? `..${n}` : ''}`,
            )
            return { code: EXIT.usage }
          }
        }
      }
      const passText = pass === null ? '' : `，第 ${pass + 1} 遍`
      /** adj1114：片头片尾与声音都在这一行说清 —— 用户得能从终端确认"到底出的是什么片" */
      const cardText =
        cardStyleId === null ? '不带片头片尾' : `片头片尾：${CARD_NAMES[cardStyleId]}`
      const soundText = p.nosound
        ? '，无声'
        : soundArg === 'synth'
          ? '，合成音'
          : soundArg === 'file'
            ? '，伴奏'
            : '，伴奏+合成'
      if (!p.quiet) {
        line(
          io,
          `正在导出视频：${rangeText}${passText}（${aspectArg}，全片长，${cardText}${soundText}）`,
        )
      }
      try {
        const out = await io.encodeVideo({
          source: src,
          pageConfig: cfg,
          startId,
          endId,
          pass,
          output: target,
          // adj1115/adj1117：画布比例（缺省 9:16，与界面一致）；整曲时长是 CLI 的缺省，3 分钟会把长曲悄悄截短，命令行不做
          aspect,
          mode: 'full',
          cardStyleId,
          // adj1114：`--nosound` 明确不要声音；缺省与界面「带声音」勾选一致
          withAudio: !p.nosound,
          // adj1166：声音来源与 sidecar/伴奏；默认 synth 保持旧命令行为
          sound: p.nosound ? 'synth' : (soundArg as 'synth' | 'file' | 'mix'),
          syncText,
          audioPath,
          accompGain,
          synthGain,
        })
        if (!p.quiet) {
          const mb = (out.bytes / (1024 * 1024)).toFixed(1)
          line(io, `已写入 ${target}（MP4，${mb} MB${out.audio ? '，含音轨' : '，无声'}）`)
        }
        return {
          code: EXIT.ok,
          json: {
            schema: 1,
            type: 'mp4',
            output: target,
            bytes: out.bytes,
            audio: out.audio,
            // adj1115：画布比例也写进 JSON（内部 id，与任务文件一致）
            aspect,
            card: cardStyleId,
            sound: p.nosound ? 'none' : soundArg,
            ...(markLabel !== '' ? { mark: markLabel } : {}),
            range: startId === null ? null : { startId, endId, pass },
          },
        }
      } catch (e) {
        io.err(`视频导出失败：${e instanceof Error ? e.message : String(e)}`)
        return { code: EXIT.render }
      }
    }
    if (type === 'midi') {
      const layout = layoutScore(parsed, cfg)
      const seq = buildPlaySequence(parsed, layout, typeof cfg === 'object' ? 60 : 60)
      const bytes = eventsToMidi(seq.events, { bpm: 60, title: 'iJipu' })
      const target = p.output
      if (target === null || target === '-') {
        io.err('MIDI 是二进制，必须用 -o 指定文件（不能用 stdout）')
        return { code: EXIT.usage }
      }
      await io.writeFile(target, bytes)
      if (!p.quiet) line(io, `已写入 ${target}（MIDI，${bytes.length} 字节）`)
      return { code: EXIT.ok, json: { schema: 1, type: 'midi', output: target, bytes: bytes.length } }
    }
    if (type === 'musicxml') {
      /**
       * M0（用户 2026-11-25 需求）：`.jps` → MusicXML。
       *
       * 与主应用导出面板、爱识谱互转**同一份引擎实现**（`parseJpsToIR` + `irToMusicXml`）；
       * 纯文本、不需要桌面渲染能力，所以独立 Node 环境也能用。
       * 有"未写入"条目时**不阻断**导出（与 GUI 同一口径），在汇总里如实报数。
       */
      const out = irToMusicXml(parseJpsToIR(src).ir)
      const target = p.output
      if (target === null || target === '-') {
        line(io, out.xml)
        return {
          code: EXIT.ok,
          json: { schema: 1, type: 'musicxml', output: null, bytes: out.xml.length, issues: out.issues.length },
        }
      }
      await io.writeFile(target, out.xml)
      if (!p.quiet) {
        const tail = out.issues.length > 0 ? `，${out.issues.length} 处未写入` : ''
        line(io, `已写入 ${target}（MusicXML，${out.xml.length} 字节${tail}）`)
      }
      return {
        code: EXIT.ok,
        json: { schema: 1, type: 'musicxml', output: target, bytes: out.xml.length, issues: out.issues.length },
      }
    }
    if (type !== 'svg' && type !== 'text' && type !== 'png' && type !== 'jpg' && type !== 'pdf' && type !== 'mp4') {
      io.err(`render 的 -t 支持 svg | midi | musicxml | png | jpg | pdf | mp4（收到 “${type}”；wav 请用 play -t wav）`)
      return { code: EXIT.usage }
    }
    if (type === 'png' || type === 'jpg' || type === 'pdf') {
      /**
       * adj803（A·P3）：位图/PDF 需要 canvas/字体/分页 ⇒ 由**宿主**注入 `rasterize`
       * （桌面端 = 隐藏窗口渲染，决策②；复用应用 `src/export/*` ⇒ 与 GUI 导出像素级一致 ✓）。
       * 独立 Node 环境下**明确报错**（退出码 4 = 渲染失败），不产出半成品 ✗。
       */
      if (io.rasterize === undefined) {
        io.err(
          `-t ${type} 需要"隐藏窗口渲染"通道（桌面端 exe 内置）；当前环境没有该能力。\n` +
            `  可用：-t svg（矢量，任意环境）｜-t musicxml（乐谱交换，任意环境）｜或改用桌面端：ijipu cli render -i <谱> -t ${type} -o <输出>`,
        )
        return { code: EXIT.render }
      }
      const layoutP = layoutScore(parsed, cfg)
      // adj873：位图/PDF 与矢量走**同一套**范围口径（同一份墨迹盒、同一个 `applyRangeToSvg`）
      const croppedP = cropSvgs(renderScoreToSvg(layoutP), layoutP, crop, pad, inkArg)
      if (croppedP.error !== undefined) {
        io.err(croppedP.error)
        return { code: EXIT.render }
      }
      const svgsP = croppedP.svgs
      const title = (parsed.header as unknown as Record<string, unknown>)['title']
      const files = await io.rasterize({
        svgs: svgsP,
        type,
        scale: 2,
        title: typeof title === 'string' ? title : 'iJipu',
      })
      if (p.output === null || p.output === '-') {
        io.err(`${type.toUpperCase()} 是二进制，必须用 -o 指定文件（不能用 stdout）`)
        return { code: EXIT.usage }
      }
      const base = p.output.replace(new RegExp(`\\.${type}$`, 'i'), '')
      const made: string[] = []
      for (let i = 0; i < files.length; i += 1) {
        const path = files.length > 1 ? `${base}-${i + 1}.${type}` : `${base}.${type}`
        await io.writeFile(path, files[i])
        made.push(path)
      }
      if (!p.quiet) line(io, `已写入 ${made.join('、')}`)
      return { code: EXIT.ok, json: { schema: 1, type, pages: files.length, outputs: made } }
    }
    const layout = layoutScore(parsed, cfg)
    // adj873：`--crop score` 在这里落地（`page` 原样返回 ⇒ 与改动前逐字节一致）
    const cropped = cropSvgs(renderScoreToSvg(layout), layout, crop, pad, inkArg)
    if (cropped.error !== undefined) {
      io.err(cropped.error)
      return { code: EXIT.render }
    }
    const svgs = cropped.svgs
    if (p.output === null || p.output === '-') {
      line(io, svgs.join('\n<!-- 分页 -->\n'))
      return { code: EXIT.ok, json: { schema: 1, type: 'svg', pages: svgs.length, crop } }
    }
    const base = p.output.replace(/\.svg$/i, '')
    const made: string[] = []
    for (let i = 0; i < svgs.length; i += 1) {
      const path = svgs.length > 1 ? `${base}-${i + 1}.svg` : `${base}.svg`
      await io.writeFile(path, svgs[i])
      made.push(path)
    }
    if (!p.quiet) line(io, `已写入 ${made.join('、')}`)
    return { code: EXIT.ok, json: { schema: 1, type: 'svg', pages: svgs.length, outputs: made, crop } }
  }

  /**
   * ── batch（P2）：目录批量操作 ────────────────────────────
   *
   * adj956（用户需求：**组合式批量**）：一次遍历目录，把多种任务一起做掉。
   *  · `-t` 支持**逗号组合**：`-t lint,fmt,svg`（原来一次只能一种，想组合就得跑几遍、目录遍历几遍）；
   *  · `-t lint` 时 `-o` **可以不写**（lint 不产出文件；原来 `-o` 是硬性必填，于是"只想查一遍"
   *    也得先编一个输出目录）；
   *  · `-r` 递归子目录、`--filter` 按文件名筛、`-s` 真的生效。
   *
   * `-t lint` 让"对整个目录做语法检查"不必再写 bat 循环（用户点名的那个用法）。
   */
  if (p.command === 'batch') {
    const inDir = p.inputs[0]
    if (inDir === undefined || inDir === '-') {
      io.err('batch 需要 --in <目录>（stdin 不适用）')
      return { code: EXIT.usage }
    }
    /** 任务名归一：同义词都收进来，免得用户为"fmt 还是 format"试两次 */
    const normTask = (t: string): string | null => {
      if (t === 'lint') return 'lint'
      if (t === 'svg') return 'svg'
      if (t === 'midi') return 'midi'
      if (t === 'musicxml') return 'musicxml'
      if (t === 'fmt' || t === 'format' || t === 'jps') return 'fmt'
      return null
    }
    const tasks = (p.type ?? 'svg')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const kinds = tasks.map(normTask).filter((k): k is string => k !== null)
    const badTasks = tasks.filter((t) => normTask(t) === null)
    if (tasks.length === 0 || badTasks.length > 0) {
      io.err(
        `batch 的 -t 支持 lint | svg | midi | musicxml | fmt（可逗号组合，如 -t lint,fmt,svg）；收到 “${badTasks.join(' ') || String(p.type ?? '')}”`,
      )
      return { code: EXIT.usage }
    }
    const outDir = p.output
    /** 只有 lint 不产出文件 ⇒ 只有"纯 lint"才允许省掉 `-o` */
    const writesFiles = kinds.some((k) => k !== 'lint')
    const hasOutDir = outDir !== null && outDir !== '-'
    /**
     * adj961（**用户问**：「`-t svg` 必须要 `-o` 吗？不能导出在原目录吗？」）：
     * **不写 `-o` ⇒ 每个产物写在该输入文件所在的目录**（就地）。
     *
     * 为什么这样定：
     *  · 就地是**最自然**的默认（`batch --in 乐谱 -t svg` 出 `乐谱/x.svg`），也省掉"先编一个输出目录"；
     *  · 但 **`-t fmt` 不写 `-o` 就是原地覆盖源文件**（`x.jps` → `x.jps`）——那是数据损坏级别的操作，
     *    **必须显式**：照 `format --in-place` 的既有口径，要求用户明写 `--in-place`（默认**拒绝**并说清出路）；
     *  · `svg` / `midi` 是**新增**文件（不碰源文件）⇒ 允许直接就地。
     *
     * `-o` 与 `--in-place` 同时给是**歧义**（一个说另存、一个说就地）⇒ 报用法错误，不猜。
     */
    if (hasOutDir && p.inPlace) {
      io.err('-o 与 --in-place 不能同时给：-o 是"另存到那个目录"，--in-place 是"原地覆盖源文件"')
      return { code: EXIT.usage }
    }
    const inPlaceOut = !hasOutDir
    if (writesFiles && inPlaceOut && kinds.includes('fmt') && !p.inPlace) {
      io.err(
        'batch 不写 -o 时产物就地输出；而 `-t fmt` 就地就是原地覆盖源文件 ⇒ 要显式确认：\n' +
          '  · 确实要覆盖源文件：ijipu cli batch --in <目录> -t fmt --in-place\n' +
          '  · 想另存一份：      ijipu cli batch --in <目录> -t fmt -o <输出目录>\n' +
          '  · 只想先看看：      ijipu cli batch --in <目录> -t lint',
      )
      return { code: EXIT.usage }
    }
    let expanded: { files: string[]; isDir: boolean }
    try {
      expanded = await expandInputs(inDir, io, p.recursive, p.filter)
    } catch (e) {
      io.err(`读目录失败：${String(e)}`)
      return { code: EXIT.noInput }
    }
    if (!expanded.isDir) {
      io.err(`batch 需要 --in <目录>（“${inDir}” 不是目录；单文件请用 lint / format / render）`)
      return { code: EXIT.usage }
    }
    const files = expanded.files
    /** `-t fmt --in-place`：直接覆盖 `file` 本身（上面已保证它不能与 `-o` 同时给） */
    const fmtInPlace = p.inPlace
    let okCount = 0
    const failed: string[] = []
    type LintRow = { input: string; ok: boolean; errors: { line: number; message: string }[] }
    const lintRows: LintRow[] = []
    const gh = p.format === 'gh'
    for (const file of files) {
      const name = baseNameOf(file)
      const stem = name.replace(/\.jps$/i, '')
      /**
       * 这个文件的产物写哪儿（adj961）：
       *  · 给了 `-o` ⇒ 那个目录；
       *  · 没给 ⇒ **该文件所在目录**（就地；`a/b/c.jps` ⇒ `a/b`，顶层文件 ⇒ 当前目录）。
       *    这样 `-r` 递归时也是"每个产物贴着它自己的源文件"，而不是全糊到一处。
       *    ⚠ `-t fmt --in-place` 除外 —— 那一路直接覆盖 `file` 本身（见下面 fmt 分支）。
       */
      const outBase = hasOutDir
        ? String(outDir)
        : file.includes('/')
          ? file.slice(0, file.lastIndexOf('/'))
          : ''
      try {
        const src = await io.readFile(file)
        const { errors } = splitParseIssues(parseJps(src))
        if (errors.length > 0) {
          failed.push(`${file}（${errors.length} 个语法错误）`)
          if (kinds.includes('lint')) {
            lintRows.push({
              input: file,
              ok: false,
              errors: errors.map((e) => ({ line: e.line ?? 0, message: String(e.message ?? e.text ?? '') })),
            })
            if (gh) for (const e of errors) line(io, issueLine(e as { line?: number; message?: string }, true, file))
          }
          continue
        }
        if (kinds.includes('lint')) lintRows.push({ input: file, ok: true, errors: [] })
        // adj956：`-s` 真的生效（此前 batch 接受了 -s 却从不读它 ⇒ 静默忽略）
        const cfg = effectiveConfig(src, overrides)
        if (kinds.includes('midi')) {
          const parsed = parseJps(src)
          const layout = layoutScore(parsed, cfg)
          const bytes = eventsToMidi(buildPlaySequence(parsed, layout, 60).events, { bpm: 60, title: stem })
          await io.writeFile(joinPath(outBase, `${stem}.mid`), bytes)
        }
        if (kinds.includes('musicxml')) {
          const xml = irToMusicXml(parseJpsToIR(src).ir).xml
          await io.writeFile(joinPath(outBase, `${stem}.musicxml`), xml)
        }
        if (kinds.includes('fmt')) {
          // adj961：`--in-place` ⇒ 覆盖源文件本身；否则写进 outBase（给了 -o 就是它，没给就是源目录）
          await io.writeFile(fmtInPlace ? file : joinPath(outBase, `${stem}.jps`), formatJps(src))
        }
        if (kinds.includes('svg')) {
          const parsed = parseJps(src)
          const layout = layoutScore(parsed, cfg)
          const svgs = renderScoreToSvg(layout)
          for (let i = 0; i < svgs.length; i += 1) {
            const fileName = svgs.length > 1 ? `${stem}-${i + 1}.svg` : `${stem}.svg`
            await io.writeFile(joinPath(outBase, fileName), svgs[i])
          }
        }
        okCount += 1
      } catch (e) {
        failed.push(`${file}（${String(e)}）`)
      }
    }
    const lintErrors = lintRows.reduce((n, r) => n + r.errors.length, 0)
    const payload = {
      schema: 1,
      tasks: kinds,
      inputs: files.length,
      ok: okCount,
      failed,
      // adj961：产物落点也要进 `--json`（脚本据此知道文件去哪了）
      ...(hasOutDir ? { output: outDir } : { output: null, inPlace: fmtInPlace }),
      ...(kinds.includes('lint') ? { lint: lintRows, lintErrors } : {}),
    }
    /**
     * adj956：`--json` 要**真的写 JSON 到 stdout**。
     *
     * 原实现无论有没有 `--json` 都只打那句中文汇总，`json` 只存在返回值里 ⇒ 拿这个 CLI 当
     * 机器接口用的人（脚本/CI）在 `--json` 下拿到的仍然是人话，与 `lint`/`info`/`config`
     * 的口径不一致 ✗（`--help` 明写"机器可读输出"）。
     */
    if (wantJson) line(io, JSON.stringify(payload, null, 2))
    else {
      /**
       * adj961：产物落点要说清 —— 但**纯 lint 一个字都不提**（它根本不产出文件，
       * 提"输出与源文件同目录"反而是误导；这条是实测自己抓出来的）。
       */
      const whereText = !writesFiles
        ? ''
        : hasOutDir
          ? `，输出到 ${outDir}`
          : fmtInPlace
            ? '，fmt 任务原地覆盖源文件'
            : '，输出与源文件同目录'
      line(
        io,
        `批处理完成：成功 ${okCount} 个、失败 ${failed.length} 个（任务 ${kinds.join(',')}；` +
          `输入 ${files.length} 个文件${whereText}）`,
      )
      if (kinds.includes('lint') && !gh && !p.quiet) {
        for (const r of lintRows) {
          // adj960：与 `lint -i <目录>` **同一份格式**（含文件名；此前这里另写了一份）
          for (const e of r.errors) line(io, issueLine({ line: e.line, message: e.message }, false, r.input))
        }
      }
      for (const f of failed) line(io, `  ✗ ${f}`)
    }
    return { code: failed.length === 0 ? EXIT.ok : EXIT.syntax, json: payload }
  }

  /**
   * ── lint（adj956）：输入可以是**目录** ─────────────────────────
   *
   * 用户需求原话：「如果我要获取指定目录下的所有 jps 文件的 lint 情况，是需要借助 bat 文件来实现
   * 还是 batch 参数就可以实现？」—— 改之前**两条路都走不通**（`batch` 没有 lint；`lint` 只吃单文件），
   * 只能在 bat 里写 `for %%f in (*.jps) do ...`。现在一条命令：
   *   `ijipu cli lint -i 乐谱目录 -r --filter "春*"`
   *
   * ⚠ 目录分支必须放在**读输入之前**：`readFile(目录)` 会失败，而"这是目录"只有 `listDir` 判得出来
   *   （见 `expandInputs` 的说明）。单文件 / stdin 的老路径一个字不动，继续往下走。
   */
  if (p.command === 'lint' && p.inputs[0] !== undefined && p.inputs[0] !== '-') {
    let expanded: { files: string[]; isDir: boolean }
    try {
      expanded = await expandInputs(p.inputs[0], io, p.recursive, p.filter)
    } catch (e) {
      io.err(`读目录失败：${String(e)}`)
      return { code: EXIT.noInput }
    }
    if (expanded.isDir) {
      if (p.watch) {
        io.err('--watch 只支持单个文件（要对整个目录做即时检查，请用脚本循环逐文件调用）')
        return { code: EXIT.usage }
      }
      if (expanded.files.length === 0) {
        io.err(
          `目录里没有 .jps：${p.inputs[0]}${p.recursive ? '' : '（子目录里的谱要加 -r 才会被扫到）'}`,
        )
        return { code: EXIT.noInput }
      }
      const gh = p.format === 'gh'
      type Row = {
        input: string
        ok: boolean
        errors: { line: number; message: string }[]
        warnings: { line: number; message: string }[]
      }
      const rows: Row[] = []
      let errCount = 0
      let warnCount = 0
      for (const file of expanded.files) {
        let src = ''
        try {
          src = await io.readFile(file)
        } catch (e) {
          io.err(`读文件失败：${file}：${String(e)}`)
          return { code: EXIT.noInput }
        }
        const { errors, warnings } = splitParseIssues(parseJps(src))
        errCount += errors.length
        warnCount += warnings.length
        const pick = (x: { line?: number; message?: string; text?: string }): { line: number; message: string } => ({
          line: x.line ?? 0,
          message: String(x.message ?? x.text ?? ''),
        })
        rows.push({ input: file, ok: errors.length === 0, errors: errors.map(pick), warnings: warnings.map(pick) })
        if (!wantJson && !p.quiet) {
          // adj960：目录输入 —— 每条问题都带文件名（**用户实报的那条**）
          for (const e of errors) line(io, issueLine(e as { line?: number; message?: string }, gh, file))
          for (const w of warnings) line(io, issueLine(w as { line?: number; message?: string }, gh, file))
        }
      }
      const payload = {
        schema: 1,
        generator: `ijipu ${version}`,
        files: rows,
        ok: errCount === 0,
        errors: errCount,
        warnings: warnCount,
      }
      if (wantJson) line(io, JSON.stringify(payload, null, 2))
      else if (!p.quiet) {
        const badCount = rows.filter((r) => !r.ok).length
        line(
          io,
          `检查 ${rows.length} 个文件：${rows.length - badCount} 个通过、${badCount} 个有错` +
            `（错误 ${errCount} 个、告警 ${warnCount} 个）`,
        )
      }
      return { code: errCount === 0 ? EXIT.ok : EXIT.syntax, json: payload }
    }
  }

  // 读输入（`-` = stdin）
  let source: string
  let fromStdin = false
  try {
    const r = await readInput(p.inputs[0], io)
    source = r.text
    fromStdin = r.fromStdin
  } catch (e) {
    io.err(`读输入失败：${String(e)}`)
    return { code: EXIT.noInput }
  }
  /** 输入是否是"真的给了"（用于 format 的默认行为判断） */
  const inputGiven = p.inputs.length > 0

  // ── info ────────────────────────────────────────────────
  if (p.command === 'info') {
    const parsed = parseJps(source)
    const { errors, warnings } = splitParseIssues(parsed)
    const header = parsed.header as unknown as Record<string, unknown>
    const pick = (k: string): string | null => (typeof header[k] === 'string' ? (header[k] as string) : null)
    const info = {
      schema: 1,
      generator: `ijipu ${version}`,
      input: fromStdin ? '(stdin)' : String(p.inputs[0]),
      title: pick('title'),
      key: pick('key'),
      lines: parsed.lines.length,
      groups: parsed.groups.length,
      errors: errors.length,
      warnings: warnings.length,
      bytes: source.length,
    }
    if (wantJson) {
      line(io, JSON.stringify(info, null, 2))
      return { code: EXIT.ok, json: info }
    }
    if (!p.quiet) {
      line(io, `文件：${info.input}`)
      if (info.title !== null) line(io, `标题：${info.title}`)
      if (info.key !== null) line(io, `调号：${info.key}`)
      line(io, `源码行：${info.lines}｜曲词分组：${info.groups}｜字符：${info.bytes}`)
      line(io, `问题：错误 ${info.errors} 个、告警 ${info.warnings} 个`)
    }
    return { code: EXIT.ok, json: info }
  }

  // ── lint（P1；adj814 起支持 --watch）──────────────────────
  if (p.command === 'lint') {
    /** 单次检查 → 文本 + 结论（watch 复用同一份逻辑，避免两份口径 ✗） */
    const runOnce = (): { errors: ProblemRow[]; warnings: ProblemRow[]; ok: boolean } => {
      const parsed = parseJps(source)
      const { errors, warnings } = splitParseIssues(parsed)
      return { errors, warnings, ok: errors.length === 0 }
    }
    if (p.watch) {
      /**
       * adj814：`--watch` —— 文件变化就重跑一次检查（CI/写谱时的即时反馈 ✓）。
       * 能力由宿主注入；没有该能力就明确报错 ✓。**永不静默不监视** ✗。
       */
      if (io.watchFile === undefined) {
        io.err('--watch 需要宿主的文件监视能力（node 入口提供；独立环境不可用）')
        return { code: EXIT.usage }
      }
      if (fromStdin) {
        io.err('--watch 不能用于 stdin（要监视具体文件）')
        return { code: EXIT.usage }
      }
      const target = String(p.inputs[0])
      let first = true
      const pass = (): void => {
        const r = runOnce()
        line(io, `${first ? '首次' : '变更后'}检查：错误 ${r.errors.length} 个、告警 ${r.warnings.length} 个${r.ok ? ' ✓' : ''}`)
        for (const e of r.errors.slice(0, 5)) line(io, issueLine(e as { line?: number; message?: string; text?: string }, false, target))
        first = false
      }
      pass()
      await new Promise<void>((resolve) => {
        const stop = io.watchFile?.(target, () => {
          // 重新读盘（外部可能已改过文件 ✓）
          void io
            .readFile(target)
            .then((t) => {
              source = t
              pass()
            })
            .catch((e) => io.err(`读文件失败：${String(e)}`))
        })
        // 宿主没给 stop（异常情况）⇒ 立刻结束，不留悬挂 Promise ✓
        if (stop === undefined) resolve()
      })
      return { code: EXIT.ok, json: { schema: 1, watched: target } }
    }
    const { errors, warnings } = runOnce()
    const gh = p.format === 'gh'
    // adj960：逐项输出的"文件归属"只有这一处口径（stdin ⇒ `(stdin)`）
    const file = fileLabelOf(p.inputs[0], fromStdin)
    const payload = {
      schema: 1,
      generator: `ijipu ${version}`,
      input: file,
      ok: errors.length === 0,
      errors: errors.map((e) => ({ line: e.line ?? 0, message: String(e.message ?? e.text ?? '') })),
      warnings: warnings.map((w) => ({ line: w.line ?? 0, message: String(w.message ?? w.text ?? '') })),
    }
    if (wantJson) line(io, JSON.stringify(payload, null, 2))
    else if (!p.quiet) {
      // adj960：单文件**也带**文件名 —— 与目录输入同一口径（用户那条判据不区分两者）；
      //   stdin 时 `file` 就是 `(stdin)`（见上面 `fileLabelOf`）
      for (const e of errors) line(io, issueLine(e as { line?: number; message?: string; text?: string }, gh, file))
      for (const w of warnings) line(io, issueLine(w as { line?: number; message?: string; text?: string }, gh, file))
      if (errors.length === 0 && warnings.length === 0) line(io, '没有发现问题 ✓')
    }
    return { code: errors.length === 0 ? EXIT.ok : EXIT.syntax, json: payload }
  }

  // ── format ──────────────────────────────────────────────
  /**
   * adj964（自测发现的**静默忽略**）：`-o` 与 `--in-place` 同时给时，旧实现让 `--in-place` 悄悄赢、
   * `-o` 一个字节都不写、也不提示 —— 与 `batch` / `set`（那边报歧义、退出码 1）**不一致**，
   * 属项目反复记的"接受了、然后静默忽略"（最坏的一种错：不报错，结果却不是用户要的）。
   * 现在三处**同一口径**：一个说"另存"、一个说"就地"，说不清就报用法错误，不猜。
   */
  if (p.inPlace && p.output !== null && p.output !== '-') {
    io.err('-o 与 --in-place 不能同时给：-o 是"另存到那个文件"，--in-place 是"原地覆盖源文件"')
    return { code: EXIT.usage }
  }
  const fixed = formatJps(source)
  const changed = fixed !== source
  if (p.check) {
    /**
     * ⚠ `--check` 是**只读保证**：即使同时给了 `--in-place` 也**一个字节都不写**
     * （用户要"先看合不合规"，那就不能顺手改文件）。这条有闸门钉着（`cli-assert` `adj964`）。
     */
    if (!p.quiet) line(io, changed ? '需要格式化 ✗' : '已符合规范 ✓')
    return { code: changed ? EXIT.syntax : EXIT.ok, json: { schema: 1, changed } }
  }
  if (p.diff) {
    const a = source.split('\n')
    const b = fixed.split('\n')
    const lines: string[] = []
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i += 1) {
      if (a[i] === b[i]) continue
      if (a[i] !== undefined) lines.push(`- ${a[i]}`)
      if (b[i] !== undefined) lines.push(`+ ${b[i]}`)
    }
    line(io, lines.join('\n'))
    return { code: changed ? EXIT.ok : EXIT.ok, json: { schema: 1, changed, diffLines: lines.length } }
  }
  if (p.inPlace) {
    if (fromStdin || !inputGiven || p.inputs[0] === '-') {
      io.err('--in-place 需要文件输入（不能对 stdin 原地写）')
      return { code: EXIT.usage }
    }
    if (changed) await io.writeFile(String(p.inputs[0]), fixed)
    if (!p.quiet) line(io, changed ? `已原地格式化：${p.inputs[0]}` : '已符合规范，未改动 ✓')
    return { code: EXIT.ok, json: { schema: 1, changed } }
  }
  const target = await writeOutput(p.output, fixed, io)
  if (!p.quiet && target !== '(stdout)') line(io, `已写入 ${target}${changed ? '' : '（内容未变）'}`)
  return { code: EXIT.ok, json: { schema: 1, changed, output: target } }
}
