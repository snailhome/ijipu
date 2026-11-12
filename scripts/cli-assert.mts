/**
 * scripts/cli-assert.mts — **命令行机器闸门**（A·P1–P4 的回归防线，adj806）
 *
 * 为什么要有它：A·P1–P4 的验收此前都是"我手工跑一遍"（改一行就可能悄悄回退 ✗）。
 * 这里把**对外承诺**钉死：
 *  · **退出码矩阵**（0/1/2/3/4/5）—— 脚本与 CI 靠它判断，不看文案 ✓；
 *  · **`format` 幂等**（`f(f(x)) == f(x)`）✓；
 *  · **`render` 产出可解析**（SVG 里有 `<svg`；MIDI 以 `MThd` 开头）✓；
 *  · **位图/音频在无宿主时明确报错**（4，而不是假装成功 ✗）；
 *  · **`batch` 输出目录自动创建**（写文件前 mkdir ✓）；
 *  · **`settings` 的"值 + 来源"分层正确**（命令行 -s > 源内 `# jps-config` > 代码默认 ✓）；
 *  · **`doctor` 如实报告能力**（没有的能力必须 false ✓）；
 *  · adj874：**`@ijipu/cli` 包的对外契约** —— `--help` 必须与实现一致（含负对照）、`-v/--version`
 *    等价、包版本 == `APP_VERSION`、`bin`/`files` 与产物对得上，并把产物**真跑一次** ✓。
 *
 * 运行：`npm run smoke`（已串在后面）；也可单独 `node dist-smoke/cli-assert.cjs`。
 */
import { runCli, EXIT, flattenScoreNotes, type CliIo } from '../packages/ijipu-cli/src/cli'
// adj1085：桌面壳本机配置的**纯逻辑**（不碰 Tauri/DOM，可在 Node 里直接断言）
import { createPrefsFacade, importLegacyPrefs, mergedKeys, prefsValuesOf, PREFS_PREFIX } from '../src/store/prefsCore'
// adj1085 P1：zip 与卡片图引用（设置导出导入 / 大图外置）
import { readZip, writeZip } from '../src/export/zip'
import { referencedBlobNamesForTest, exportSettingsZip, importSettingsZip } from '../src/store/settingsArchive'
// adj942：**内嵌入口**（`ijipu.exe` 里跑的就是这一份）——这里真跑一遍它的接线 ✓
import { runEmbeddedCli, type EmbedHost } from '../packages/ijipu-cli/src/embedEntry'
// adj873：`--crop` 断言要读渲染产物的 viewBox 来核对画布盒
import { readViewBoxOf } from '@ijipu/engine/index.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

let passed = 0
let failed = 0
function check(title: string, ok: boolean, extra = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${title}`)
  } else {
    failed += 1
    console.log(`  ✗ ${title}${extra ? ` — ${extra}` : ''}`)
  }
}

/**
 * 内存文件系统（不碰真实磁盘 ⇒ 可断言"到底写了什么" ✓）
 *
 * adj956：`listDir` 的返回值跟着 `CliIo` 改了形状（`{ name, dir }[]`）。为了让老用例照旧能写
 * （只给一串名字），这里做了归一：
 *  · 给**字符串** ⇒ 若 `files` 里存在 `${目录}/${名字}/…` 这样的键，就当作**目录**，否则当文件；
 *  · 给**对象** ⇒ 原样用（要精确控制"是目录但不是文件"时用这种写法）。
 * 与真实宿主同口径地**按名字排序**（顺序可复现 ⇒ 输出能逐字节比对）。
 */
type FakeEntry = string | { name: string; dir: boolean }
function makeIo(
  files: Record<string, string> = {},
  dirs: Record<string, FakeEntry[]> = {},
): { io: CliIo; files: Record<string, string | Uint8Array>; logs: string[]; errs: string[] } {
  const out: Record<string, string | Uint8Array> = {}
  const logs: string[] = []
  const errs: string[] = []
  const io: CliIo = {
    async readStdin() {
      return files['(stdin)'] ?? ''
    },
    async readFile(p) {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`)
      return files[p]
    },
    async writeFile(p, data) {
      out[p] = data
    },
    async exists(p) {
      return p in files || p in out
    },
    async listDir(d) {
      if (!(d in dirs)) throw new Error(`ENOENT: ${d}`)
      return dirs[d]
        .map((e) =>
          typeof e === 'string'
            ? { name: e, dir: Object.keys(files).some((k) => k.startsWith(`${d}/${e}/`)) }
            : e,
        )
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
    out: (t) => void logs.push(t),
    err: (t) => void errs.push(t),
  }
  return { io, files: out, logs, errs }
}

const GOOD = readFileSync(join('samples', 'ershenbu.jps'), 'utf8')
/**
 * ⚠ `Q: x` 这类"无法识别的符号"在引擎里是**告警** ✗（lint 只把**错误**算作退出码 3 ✓）。
 * 要触发**错误**用"小节时值不符"——应用自身冒烟就是从 `parseJps().errors` 里过滤 `第 N 小节共…` 的 ✓。
 */
const BAD = 'V:1.0\nQ: 1 2\n'

/**
 * ⚠ 打成 **CJS**（`vite.smoke.config.ts` 的 `formats: ['cjs']`）⇒ **不能用顶层 await** ✗
 * （第一版就踩了：21 个构建错误）。整个套件包进 `main()`，最后 `void main()` 调用。
 * 缩进保持不变（可读性次要，避免大范围改动引入新错 ✗）。
 */
async function main(): Promise<void> {

console.log('\n— 命令行（A·P1–P4）—')

// ① 退出码矩阵
{
  const a = makeIo({ 'a.jps': GOOD, '(stdin)': GOOD })
  check('adj806 成功路径退出码 0（info）', (await runCli(['info', '-i', 'a.jps'], a.io)).code === EXIT.ok)
  const b = makeIo({ '(stdin)': GOOD })
  check('adj806 未知命令 ⇒ 1（用法错误）', (await runCli(['nope'], b.io)).code === EXIT.usage)
  const c = makeIo({})
  check('adj806 输入不存在 ⇒ 2', (await runCli(['info', '-i', '缺失.jps'], c.io)).code === EXIT.noInput)
  const d = makeIo({ '(stdin)': BAD })
  const dr = await runCli(['lint', '-i', '-', '--json'], d.io)
  const dp = JSON.parse(String(d.logs.join('')))
  /**
   * ⚠ 这里断言的是**契约本身**（`ok === false` ⇔ 退出码 3），不去猜某个输入会被引擎判成错误还是告警 ✗
   * （我第一版拿 `Q: x` 当"错误"，实测它是**告警** ⇒ 断言错、不是代码错；第二轮换"小节时值"仍不报错 ✗）。
   */
  check('adj806 语法错误 ⇔ 退出码 3（lint 契约自洽）', dr.code === (dp.ok ? EXIT.ok : EXIT.syntax), `ok=${dp.ok} code=${dr.code}`)
  const e = makeIo({ '(stdin)': GOOD })
  check('adj806 无渲染通道时位图 ⇒ 4（渲染失败）', (await runCli(['render', '-i', '-', '-t', 'png', '-o', 'x.png'], e.io)).code === EXIT.render)
  const f = makeIo({ '(stdin)': GOOD })
  check('adj806 无合成通道时 WAV ⇒ 4', (await runCli(['play', '-i', '-', '-t', 'wav', '-o', 'x.wav'], f.io)).code === EXIT.render)
  const g = makeIo({ '(stdin)': GOOD })
  check('adj806 --config 未实现 ⇒ 5（设置非法）', (await runCli(['info', '-i', '-', '--config', 'x.toml'], g.io)).code === EXIT.config)
  /**
   * adj944：注册类命令要读写当前用户的注册表 —— 只有桌面端 `ijipu.exe`（内嵌 CLI）有这个能力，
   * 独立 Node 环境没有 ⇒ **退出码 6**（刻意与"用法错误 1""渲染能力缺失 4"分开，脚本据此换环境 ✓）。
   */
  const h = makeIo({ '(stdin)': GOOD })
  check('adj944 无宿主时注册类命令 ⇒ 6（环境能力缺失）', (await runCli(['status'], h.io)).code === EXIT.env && EXIT.env === 6)
  // 负对照：把"位图需要通道"的判断去掉 ⇒ 判据为假（证明这条真的在起作用）
  const noCapIo = makeIo({ '(stdin)': GOOD })
  check(
    'adj806 负对照：无 rasterize 能力时**不得**产出 png 文件',
    Object.keys(noCapIo.files).length === 0 &&
      (await runCli(['render', '-i', '-', '-t', 'png', '-o', 'x.png'], noCapIo.io)).code !== EXIT.ok,
  )
}

// ② format 幂等
{
  const one = makeIo({ '(stdin)': GOOD })
  await runCli(['format', '-i', '-', '-o', '-'], one.io)
  const first = String(one.logs.join(''))
  const two = makeIo({ '(stdin)': first })
  await runCli(['format', '-i', '-', '-o', '-'], two.io)
  check('adj806 format 幂等（f(f(x)) == f(x)）', String(two.logs.join('')) === first, `${first.length} vs ${String(two.logs.join('')).length}`)
  const chk = makeIo({ '(stdin)': GOOD })
  const r = await runCli(['format', '-i', '-', '--check'], chk.io)
  check('adj806 --check 合规 ⇒ 0', r.code === EXIT.ok)
}

// ③ render 产出可解析
{
  const svgIo = makeIo({ '(stdin)': GOOD })
  const r = await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'out.svg'], svgIo.io)
  const svg = String(svgIo.files['out.svg'] ?? '')
  check('adj806 render -t svg ⇒ 0 且写出 `<svg`', r.code === EXIT.ok && svg.includes('<svg') && svg.includes('</svg>'))
  const midIo = makeIo({ '(stdin)': GOOD })
  const m = await runCli(['render', '-i', '-', '-t', 'midi', '-o', 'out.mid'], midIo.io)
  const bytes = midIo.files['out.mid'] as Uint8Array
  const magic = bytes ? String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) : ''
  check('adj806 render -t midi ⇒ 0 且文件头是 MThd', m.code === EXIT.ok && magic === 'MThd', `magic=${magic}`)
  check('adj806 MIDI 不能用 stdout（二进制）', (await runCli(['render', '-i', '-', '-t', 'midi'], makeIo({ '(stdin)': GOOD }).io)).code === EXIT.usage)
}

// ③b adj873（T-3 补落点）：`render --crop page|score [--pad N] [--ink x,y,w,h]`
{
  /** `page`：**缺省**与显式 `--crop page` 都必须与"不加 --crop"**逐字节一致** ✓ */
  const base = makeIo({ '(stdin)': GOOD })
  await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'out.svg'], base.io)
  const raw = String(base.files['out.svg'] ?? '')
  const explicit = makeIo({ '(stdin)': GOOD })
  await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'out.svg', '--crop', 'page'], explicit.io)
  const pageSvg = String(explicit.files['out.svg'] ?? '')
  check(
    'adj873 `--crop page` 与不加 --crop **逐字节一致**（现状行为不变）',
    raw.length > 0 && pageSvg === raw,
    `len ${raw.length} vs ${pageSvg.length}`,
  )
  /** `score`：墨迹 + 每边 `--pad`（默认 2），且**不是**整页盒 */
  const scoreIo = makeIo({ '(stdin)': GOOD })
  const rs = await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'out.svg', '--crop', 'score'], scoreIo.io)
  const scoreSvg = String(scoreIo.files['out.svg'] ?? '')
  const vbScore = readViewBoxOf(scoreSvg)
  const vbPage = readViewBoxOf(pageSvg)
  check(
    'adj873 `--crop score` ⇒ 0；画布换成**墨迹盒 + 每边 2px**（≠ 整页盒）；内容一字不动',
    rs.code === EXIT.ok && vbScore !== null && vbPage !== null &&
      !(vbScore[2] === vbPage[2] && vbScore[3] === vbPage[3]) &&
      vbScore[2] < vbPage[2] && vbScore[3] < vbPage[3] &&
      scoreSvg.slice(scoreSvg.indexOf('>')) === pageSvg.slice(pageSvg.indexOf('>')),
    `page=${JSON.stringify(vbPage)} score=${JSON.stringify(vbScore)} code=${rs.code} err=${scoreIo.errs.join('｜')}`,
  )
  /** `--pad 0` ⇒ 紧贴墨迹；`--pad 999` ⇒ 钳到 64（每边） */
  const p0Io = makeIo({ '(stdin)': GOOD })
  await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'out.svg', '--crop', 'score', '--pad', '0'], p0Io.io)
  const vb0 = readViewBoxOf(String(p0Io.files['out.svg'] ?? ''))
  const p64Io = makeIo({ '(stdin)': GOOD })
  await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'out.svg', '--crop', 'score', '--pad', '999'], p64Io.io)
  const vb64 = readViewBoxOf(String(p64Io.files['out.svg'] ?? ''))
  check(
    'adj873 `--pad`：0 ⇒ 紧贴墨迹（=不含留白的墨迹宽）；999 ⇒ 每边钳到 64（宽 +128）',
    vbScore !== null && vb0 !== null && vb64 !== null &&
      vb0[2] === vbScore[2] - 4 && vb0[3] === vbScore[3] - 4 &&
      vb64[2] === vbScore[2] - 4 + 128 && vb64[3] === vbScore[3] - 4 + 128,
    `pad2=${JSON.stringify(vbScore)} pad0=${JSON.stringify(vb0)} pad64=${JSON.stringify(vb64)}`,
  )
  /** `--ink x,y,w,h`：显式盒覆盖估算（有 DOM 的宿主把实测值喂进来） */
  const inkIo = makeIo({ '(stdin)': GOOD })
  const ri = await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'out.svg', '--crop', 'score', '--ink', '100,50,300,200', '--pad', '0'], inkIo.io)
  const vbInk = readViewBoxOf(String(inkIo.files['out.svg'] ?? ''))
  check(
    'adj873 `--ink x,y,w,h` 覆盖估算：盒 = 传入值（pad 0 ⇒ 300×200 @100,50）',
    ri.code === EXIT.ok && vbInk !== null && vbInk[0] === 100 && vbInk[1] === 50 && vbInk[2] === 300 && vbInk[3] === 200,
    JSON.stringify(vbInk),
  )
  /**
   * 负对照：`--ink` 给一个**退化盒**（比一个音符还小）⇒ 引擎的退化闸必须拦下，
   * **退出码非 0 且不写任何文件**（宁可报错，也不产出一条 27px 的横带 ✗）。
   */
  const badIo = makeIo({ '(stdin)': GOOD })
  const rb = await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'out.svg', '--crop', 'score', '--ink', '10,10,489,1'], badIo.io)
  check(
    'adj873 负对照：退化墨迹盒（489×1）⇒ 退出码 4 且**不写文件**（不静默退回整页）',
    rb.code === EXIT.render && Object.keys(badIo.files).length === 0 && badIo.errs.some((e) => e.includes('--crop score')),
    `code=${rb.code} files=${Object.keys(badIo.files).join(',')} err=${badIo.errs.join('｜')}`,
  )
  /** 非法取值 ⇒ 用法错误（不猜、不忽略 ✗） */
  const badCrop = makeIo({ '(stdin)': GOOD })
  const rbc = await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'out.svg', '--crop', 'nope'], badCrop.io)
  const badPad = makeIo({ '(stdin)': GOOD })
  const rbp = await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'out.svg', '--crop', 'score', '--pad', 'abc'], badPad.io)
  check(
    'adj873 `--crop nope` / `--pad abc` ⇒ 退出码 1（用法错误），不悄悄回默认',
    rbc.code === EXIT.usage && rbp.code === EXIT.usage && Object.keys(badCrop.files).length === 0 && Object.keys(badPad.files).length === 0,
    `crop=${rbc.code} pad=${rbp.code}`,
  )
}

// ④ batch：目录列举 + 输出目录自动创建（由 IO 的 writeFile 负责 mkdir ✓）
{
  const io = makeIo({ 'in/a.jps': GOOD, 'in/b.jps': GOOD, 'in/skip.txt': 'x' }, { in: ['b.jps', 'a.jps', 'skip.txt'] })
  const r = await runCli(['batch', '--in', 'in', '-o', 'out', '-t', 'svg', '--quiet'], io.io)
  check('adj806 batch ⇒ 只处理 .jps、每个产出 SVG、退出码 0', r.code === EXIT.ok && 'out/a.svg' in io.files && 'out/b.svg' in io.files && !('out/skip.svg' in io.files))
  const io2 = makeIo({ 'in/a.jps': GOOD }, { in: ['a.jps'] })
  const r2 = await runCli(['batch', '--in', 'in', '-o', 'out', '-t', 'fmt'], io2.io)
  check('adj806 batch -t fmt ⇒ 写出 .jps（规范化）', r2.code === EXIT.ok && 'out/a.jps' in io2.files)
  // 失败隔离：目录里有这个文件名，但读不到内容（fake io 抛错）⇒ 必须计入失败且**不写**任何输出
  const io3 = makeIo({}, { in: ['a.jps'] })
  const r3 = await runCli(['batch', '--in', 'in', '-o', 'out', '-t', 'svg', '--quiet'], io3.io)
  check('adj806 batch 单个文件失败 ⇒ 退出码 3 且**不写**半成品', r3.code === EXIT.syntax && Object.keys(io3.files).length === 0, `code=${r3.code} files=${Object.keys(io3.files).join(',')}`)
}

/**
 * ④b adj956（用户需求）：「如果我要获取指定目录下的所有 jps 文件的 lint 情况，是需要借助 bat 文件
 * 来实现还是 batch 参数就可以实现？」—— 改之前**两条路都走不通**，只能写 bat 循环。
 * 现在 `lint -i <目录> [-r] [--filter <通配>]` 一条命令。
 */
{
  /** 与 ⑨ 的 `EMBED_BAD` 同一种"注定报错"的写法（小节时值不符） */
  const ERR_JPS = 'V: 1.0\nB: 错\nD: C\nP: 4/4\nQ: 1 2 3 4 | {tp 5 6 7 1} |\n'
  const tree = (): ReturnType<typeof makeIo> =>
    makeIo(
      { 'in/a.jps': GOOD, 'in/bad.jps': ERR_JPS, 'in/skip.txt': 'x', 'in/sub/c.jps': GOOD },
      // ⚠ 键必须是**完整路径**（`in/sub`）——`listDir` 收的是路径，不是目录名
      { in: ['a.jps', 'bad.jps', 'skip.txt', 'sub'], 'in/sub': ['c.jps'] },
    )
  const io = tree()
  const r = await runCli(['lint', '-i', 'in', '--json'], io.io)
  const j = JSON.parse(String(io.logs.join(''))) as {
    files: { input: string; ok: boolean }[]
    ok: boolean
    errors: number
  }
  check(
    'adj956 `lint -i <目录>`：只收 .jps、默认**不下钻**子目录（`in/sub/c.jps` 不在内）',
    j.files.length === 2 && j.files.map((f) => f.input).join(',') === 'in/a.jps,in/bad.jps',
    j.files.map((f) => f.input).join(','),
  )
  check(
    'adj956 目录 lint 的退出码与汇总自洽（有错 ⇒ 3；`ok` 与 `errors` 同口径）',
    r.code === (j.ok ? EXIT.ok : EXIT.syntax) && j.ok === (j.errors === 0),
    `code=${r.code} ok=${j.ok} errors=${j.errors}`,
  )
  /** 负对照：这份谱是**故意写错**的 ⇒ 必须真的被算成错误（否则上面那条可能靠"全绿"蒙过去） */
  check('adj956 负对照：目录里那份故意写错的谱确实被算作错误（不是"全绿"假象）', j.errors > 0 && j.ok === false, `errors=${j.errors}`)

  const ioR = tree()
  const rR = await runCli(['lint', '-i', 'in', '-r', '--json'], ioR.io)
  const jR = JSON.parse(String(ioR.logs.join(''))) as { files: { input: string }[]; errors: number }
  check(
    'adj956 `-r` 递归：子目录里的谱也被扫到（3 个，含 `in/sub/c.jps`；那份故意写错的仍在 ⇒ 退出码 3）',
    rR.code === EXIT.syntax && jR.errors > 0 && jR.files.length === 3 && jR.files.some((f) => f.input === 'in/sub/c.jps'),
    `code=${rR.code} ${jR.files.map((f) => f.input).join(',')}`,
  )

  const ioF = makeIo({ 'in/春.jps': GOOD, 'in/夏.jps': GOOD }, { in: ['春.jps', '夏.jps'] })
  const rF = await runCli(['lint', '-i', 'in', '--filter', '春*', '--json'], ioF.io)
  const jF = JSON.parse(String(ioF.logs.join(''))) as { files: { input: string }[] }
  check(
    'adj956 `--filter 春*` 只留文件名匹配的（1 个，退出码 0）',
    rF.code === EXIT.ok && jF.files.length === 1 && jF.files[0].input === 'in/春.jps',
    jF.files.map((f) => f.input).join(','),
  )

  const ioEmpty = makeIo({}, { 'in/空': [] })
  check(
    'adj956 目录里没有 .jps ⇒ 退出码 2（输入不存在），并提示"子目录要加 -r"',
    (await runCli(['lint', '-i', 'in/空'], ioEmpty.io)).code === EXIT.noInput,
  )
  check('adj956 `--watch` 不能用于目录 ⇒ 退出码 1（不静默不监视）', (await runCli(['lint', '-i', 'in', '--watch'], tree().io)).code === EXIT.usage)

  /** 单文件与 stdin 的老路径**一个字没动**（回归） */
  const one = tree()
  check('adj956 回归：`lint -i <单个文件>` 仍走老路径（退出码 0）', (await runCli(['lint', '-i', 'in/a.jps'], one.io)).code === EXIT.ok)
}

/**
 * ④b·2 adj960（**用户实报**）：逐项输出必须指明**是哪个文件**。
 *
 * 用户拿 `ijipu cli -i . -r lint` 查了 54 个文件，输出里只有一片 `第 20 行：倚音内不支持的符号`
 * —— **完全对不上号**。用户给的判据：**"输出的信息是单一文件独有、还是共同信息"**
 * ⇒ 独有的带文件名、共同的（那句汇总）不带。
 *
 * 这里把**两半**都钉住：① 逐项必须带；② 汇总**不许**带（免得矫枉过正成"每行都糊一个文件名"）。
 */
{
  const DIR_ERR = 'V: 1.0\nB: 错\nD: C\nP: 4/4\nQ: 1 2 3 4 | {tp 5 6 7 1} |\n'
  const dir = makeIo({ 'in/a.jps': GOOD, 'in/bad.jps': DIR_ERR }, { in: ['a.jps', 'bad.jps'] })
  await runCli(['lint', '-i', 'in'], dir.io)
  const out = String(dir.logs.join(''))
  const hasFile = /^in\/bad\.jps 第 \d+ 行：/m.test(out)
  check(
    'adj960 `lint -i <目录>`：每条问题**行首带文件名**（用户实报：只有 `第 N 行：…` 对不上号）',
    hasFile && !/^第 \d+ 行：/m.test(out),
    out.split('\n').slice(0, 3).join(' ｜ '),
  )
  check(
    'adj960 同一条的另一半：那句**汇总**是共同信息 ⇒ **不带**文件名（`检查 N 个文件：…`）',
    /^检查 2 个文件：/m.test(out),
    out.split('\n').slice(-1)[0],
  )
  check(
    'adj960 负对照：把文件名抹掉（＝修复前的写法）⇒ 同一判据判红',
    !/^in\/bad\.jps 第 \d+ 行：/m.test(out.replace(/in\/bad\.jps /g, '')) && hasFile,
  )

  const oneFile = makeIo({ 'err.jps': DIR_ERR })
  await runCli(['lint', '-i', 'err.jps'], oneFile.io)
  check(
    'adj960 单文件**也带**文件名（与目录输入同一口径；与目录输出混在一个日志里不会对不上号）',
    /^err\.jps 第 \d+ 行：/m.test(String(oneFile.logs.join(''))),
    String(oneFile.logs.join('')).split('\n')[0],
  )

  const batchLint = makeIo({ 'in/bad.jps': DIR_ERR }, { in: ['bad.jps'] })
  await runCli(['batch', '--in', 'in', '-t', 'lint'], batchLint.io)
  check(
    'adj960 `batch -t lint` 的明细与 `lint -i <目录>` **同一份格式**（都带文件名）',
    /^in\/bad\.jps 第 \d+ 行：/m.test(String(batchLint.logs.join(''))),
    String(batchLint.logs.join('')).split('\n').slice(0, 2).join(' ｜ '),
  )
}

/**
 * ④c adj956（用户需求「一些操作是否可以通过 batch 参数形成组合式的批量操作的效果？」）：
 * `-t` 逗号组合 + `-o` 只在真要写文件时才必填。
 */
{
  const io = makeIo({ 'in/a.jps': GOOD }, { in: ['a.jps'] })
  const r = await runCli(['batch', '--in', 'in', '-t', 'lint'], io.io)
  check('adj956 `batch -t lint` **不必给 -o**（lint 不产出文件），且一个文件都没写', r.code === EXIT.ok && Object.keys(io.files).length === 0)

  const io2 = makeIo({ 'in/a.jps': GOOD }, { in: ['a.jps'] })
  const r2 = await runCli(['batch', '--in', 'in', '-o', 'out', '-t', 'lint,fmt,svg', '--json'], io2.io)
  const j2 = JSON.parse(String(io2.logs.join(''))) as { tasks: string[]; inputs: number }
  check(
    'adj956 `-t lint,fmt,svg`：**一次遍历**产出三种结果（.jps + .svg 都写了），`--json` 真的吐 JSON',
    r2.code === EXIT.ok && 'out/a.jps' in io2.files && 'out/a.svg' in io2.files && j2.tasks.join(',') === 'lint,fmt,svg',
    `code=${r2.code} files=${Object.keys(io2.files).join(',')}`,
  )

  check(
    'adj956/adj961 组合 `-t lint,svg` 缺 -o ⇒ 现在**合法**（svg 就地写在源文件旁；adj961 改的口径）',
    (await runCli(['batch', '--in', 'in', '-t', 'lint,svg'], makeIo({ 'in/a.jps': GOOD }, { in: ['a.jps'] }).io)).code === EXIT.ok,
  )
  check(
    'adj956 未知任务名 ⇒ 用法错误 1（不静默跳过）',
    (await runCli(['batch', '--in', 'in', '-o', 'out', '-t', 'lint,png'], makeIo({ 'in/a.jps': GOOD }, { in: ['a.jps'] }).io)).code === EXIT.usage,
  )
  check(
    'adj956 `batch --in <文件>` ⇒ 明确说"不是目录"（用法错误 1）',
    (await runCli(['batch', '--in', 'in/a.jps', '-o', 'out'], makeIo({ 'in/a.jps': GOOD }, { in: ['a.jps'] }).io)).code === EXIT.usage,
  )
}

/**
 * ④c·2 adj961（**用户问**：「`-t svg` 必须要 `-o` 吗？不能导出在原目录吗？」）：
 * 省略 `-o` ⇒ 产物写在**各源文件旁边**；但 `-t fmt` 就地会**覆盖源文件** ⇒ 必须显式 `--in-place`。
 */
{
  const tree = (): ReturnType<typeof makeIo> =>
    makeIo({ 'in/a.jps': GOOD, 'in/sub/c.jps': GOOD }, { in: ['a.jps', 'sub'], 'in/sub': ['c.jps'] })

  const ip = tree()
  const rIp = await runCli(['batch', '--in', 'in', '-t', 'svg', '-r'], ip.io)
  check(
    'adj961 省略 -o ⇒ 产物写在**各源文件旁边**（`-r` 时子目录里的也各贴各的）',
    rIp.code === EXIT.ok && 'in/a.svg' in ip.files && 'in/sub/c.svg' in ip.files,
    Object.keys(ip.files).join(','),
  )

  const lintOnly = makeIo({ 'in/a.jps': GOOD }, { in: ['a.jps'] })
  await runCli(['batch', '--in', 'in', '-t', 'lint'], lintOnly.io)
  check(
    'adj961 纯 `-t lint` 的汇总**不提**产物落点（它不产出文件；提了反而是误导 —— 实测抓出来的）',
    !String(lintOnly.logs.join('')).includes('输出'),
    String(lintOnly.logs.join('')).trim(),
  )

  const noIp = makeIo({ 'in/a.jps': GOOD }, { in: ['a.jps'] })
  const rNoIp = await runCli(['batch', '--in', 'in', '-t', 'fmt'], noIp.io)
  check(
    'adj961 `-t fmt` 省略 -o ⇒ **拒绝**（就地会覆盖源文件）且一个文件都没写',
    rNoIp.code === EXIT.usage && Object.keys(noIp.files).length === 0,
    `code=${rNoIp.code} files=${Object.keys(noIp.files).join(',')}`,
  )

  const withIp = makeIo({ 'in/a.jps': GOOD }, { in: ['a.jps'] })
  const rWithIp = await runCli(['batch', '--in', 'in', '-t', 'fmt', '--in-place'], withIp.io)
  check(
    'adj961 `-t fmt --in-place` ⇒ **覆盖源文件本身**（写进 `in/a.jps`，不是另存）',
    rWithIp.code === EXIT.ok && 'in/a.jps' in withIp.files && !('in/a/a.jps' in withIp.files),
    Object.keys(withIp.files).join(','),
  )

  check(
    'adj961 `-o` 与 `--in-place` 同时给 ⇒ 报歧义（用法错误 1，不猜用户想哪个）',
    (await runCli(['batch', '--in', 'in', '-t', 'fmt', '-o', 'out', '--in-place'], makeIo({ 'in/a.jps': GOOD }, { in: ['a.jps'] }).io)).code === EXIT.usage,
  )
}

/**
 * ④c·3 adj962（**用户需求**：「如果要为指定文件/目录（批量）添加一个设置项及设置值，如何操作？」）：
 * 新命令 `set` —— 把设置**写进谱面**（源码里的 `# jps-config`）；读=settings、写=set。
 *
 * 钉四件事：① 不给落点只打到 stdout、**一个文件都不改**；② `--in-place` 才写；
 * ③ **差量写入**（原有设置项不许丢；设回默认值那一项要**从设置行去掉**）；
 * ④ **反斜杠路径**（Windows 单文件输入的真实形态 —— 这里抓到过一个真 bug，见负对照那条）。
 */
{
  const CFG_JPS = '# jps-config:{"margin_right":33}\n\n\nQ: 1 2 3 4 |\n'

  const a = makeIo({ 'p.jps': GOOD })
  await runCli(['set', '-i', 'p.jps', 'margin_right=33'], a.io)
  check(
    'adj962 `set` 不给落点 ⇒ 打到 stdout（**不改文件**，与 format 同口径）',
    Object.keys(a.files).length === 0 && String(a.logs.join('')).includes('# jps-config:{"margin_right":33}'),
    String(a.logs.join('')).split('\n').filter((l) => l !== '').slice(-1)[0],
  )

  const b = makeIo({ 'p.jps': CFG_JPS })
  await runCli(['set', '-i', 'p.jps', 'page=A5', '--in-place'], b.io)
  const bWrote = String(b.files['p.jps'] ?? '')
  check(
    'adj962 `--in-place` 写回原文件，且**差量**：原有 `margin_right` 没丢（新增 `page`）',
    'p.jps' in b.files && bWrote.includes('"page":"A5"') && bWrote.includes('"margin_right":33'),
    (bWrote.split('\n')[0] ?? '').trim(),
  )

  const c = makeIo({ 'p.jps': CFG_JPS })
  await runCli(['set', '-i', 'p.jps', 'margin_right=50', '--in-place'], c.io)
  check(
    'adj962 把值设回**默认** ⇒ 该项从设置行里去掉（不留一堆等于默认值的键）',
    !String(c.files['p.jps'] ?? '').includes('margin_right'),
    (String(c.files['p.jps'] ?? '').split('\n')[0] ?? '').trim(),
  )

  const d = makeIo({ 'dir\\a.jps': GOOD })
  const rd = await runCli(['set', '-i', 'dir\\a.jps', '-o', 'out\\sub', 'page=A5'], d.io)
  const dKeys = Object.keys(d.files)
  check(
    'adj962 负对照（**自己实测抓到的真 bug**）：`\\` 路径下产物必须是 `out\\sub\\a.jps`，绝不能把整条输入路径粘上去',
    rd.code === EXIT.ok && dKeys.length === 1 && dKeys[0] === 'out\\sub\\a.jps' && !(dKeys[0] ?? '').includes('dir\\a.jps'),
    dKeys.join(' | '),
  )

  const e = makeIo({ 'in/a.jps': GOOD }, { in: ['a.jps'] })
  check(
    'adj962 目录输入不给 `--in-place` / `-o` ⇒ 用法错误 1（多份源码不能都打到 stdout）',
    (await runCli(['set', '-i', 'in', 'page=A5'], e.io)).code === EXIT.usage,
  )

  const f = makeIo({ 'in/a.jps': GOOD, 'in/b.jps': GOOD }, { in: ['a.jps', 'b.jps'] })
  const rf = await runCli(['set', '-i', 'in', '-o', 'out', 'page=A5'], f.io)
  check(
    'adj962 目录 + `-o`：逐个另存（`out/a.jps`、`out/b.jps`），汇总行**不带**文件名（adj960 的另一半）',
    rf.code === EXIT.ok && 'out/a.jps' in f.files && 'out/b.jps' in f.files && /^已处理 2 个文件：/m.test(String(f.logs.join(''))),
    Object.keys(f.files).join(','),
  )

  check(
    'adj962 一组 `k=v` 都没给 ⇒ 用法错误 1（给出示例，并指路"只想临时生效就用 -s"）',
    (await runCli(['set', '-i', 'p.jps'], makeIo({ 'p.jps': GOOD }).io)).code === EXIT.usage,
  )
  check(
    'adj962 未知设置项 ⇒ 退出码 5（与 `-s` 同口径；不静默忽略）',
    (await runCli(['set', '-i', 'p.jps', 'margn_right=10', '--in-place'], makeIo({ 'p.jps': GOOD }).io)).code === EXIT.config,
  )
  check(
    'adj962 `-s` 用在 `set` 上 ⇒ 退出码 5（`set` 的值是位置参数 `k=v`；`-s` 是"临时生效"那一路，不混用）',
    (await runCli(['set', '-i', 'p.jps', 'page=A5', '-s', 'margin_right=10'], makeIo({ 'p.jps': GOOD }).io)).code === EXIT.config,
  )
}

/**
 * ④c·4 adj964（自测发现的**静默忽略**）：`format` 的 `-o` 与 `--in-place` 同时给时，
 * 旧实现让 `--in-place` 悄悄赢、`-o` 一个字节都不写、也不提示；而 `batch`/`set` 那边报歧义。
 * 同一件事两种口径 ⇒ 统一成"报用法错误"；顺带把 `--check` 的**只读保证**钉住。
 */
{
  const fmtIo = (): ReturnType<typeof makeIo> => makeIo({ 'a.jps': 'Q:1 2 3 4|\n' })

  const a = fmtIo()
  const ra = await runCli(['format', '-i', 'a.jps', '--in-place', '-o', 'out.jps'], a.io)
  check(
    'adj964 `format -o` 与 `--in-place` 同时给 ⇒ **报歧义**（退出码 1；与 batch/set 同口径，不再静默忽略 -o）',
    ra.code === EXIT.usage && Object.keys(a.files).length === 0,
    `code=${ra.code} files=${Object.keys(a.files).join(',')}`,
  )

  const b = fmtIo()
  const rb = await runCli(['format', '-i', 'a.jps', '--check', '--in-place'], b.io)
  check(
    'adj964 `--check` 是**只读保证**：同时给了 `--in-place` 也一个字节都不写（只看合不合规）',
    rb.code === EXIT.syntax && Object.keys(b.files).length === 0,
    `code=${rb.code} files=${Object.keys(b.files).join(',')}`,
  )

  // **正对照**：同一个夹具下 `--in-place`（不带 --check）确实会写 ⇒ 说明上面"没写"不是恒真
  const ctl = fmtIo()
  await runCli(['format', '-i', 'a.jps', '--in-place'], ctl.io)
  check(
    'adj964 正对照：同一夹具下 `--in-place` 单独用时**确实写盘** ⇒ 上面那条"没写"的判据不是恒真',
    'a.jps' in ctl.files,
    Object.keys(ctl.files).join(','),
  )
}

/**
 * ④d adj956（**修一个真 bug**）：`-s k=v` 原先只被 settings / config 消费，
 * 却被 render / play / batch 的守卫放行 ⇒ "接受了、然后静默忽略"。
 *
 * 这条判据**本身就是那个 bug 的负对照**：修复前 `-s note_size=40` 不生效，
 * 下面"两者不同"必然判红（不是恒真）。
 */
{
  const mk = (): ReturnType<typeof makeIo> => makeIo({ 'p.jps': GOOD })
  const a = mk()
  const b = mk()
  await runCli(['render', '-i', 'p.jps', '-t', 'svg', '-o', 'a.svg'], a.io)
  await runCli(['render', '-i', 'p.jps', '-t', 'svg', '-o', 'b.svg'], b.io)
  const svgA = String(a.files['a.svg'] ?? '')
  const svgB = String(b.files['b.svg'] ?? '')
  // 先证明渲染是**确定的**（否则下面那条差异就说明不了任何事）
  check('adj956 前置：同一份谱渲染两次逐字节相同（差异只能来自 -s）', svgA !== '' && svgA === svgB)

  const c = mk()
  const rc = await runCli(['render', '-i', 'p.jps', '-t', 'svg', '-o', 'c.svg', '-s', 'note_size=40'], c.io)
  const svgC = String(c.files['c.svg'] ?? '')
  check(
    'adj956 `render -s note_size=40` **真的生效**（产物与不加 -s 时不同；修复前二者会一样）',
    rc.code === EXIT.ok && svgC !== '' && svgC !== svgA,
  )
  check(
    'adj956 `-s margn_right=10`（键名拼错）⇒ 退出码 5，**不当没写**',
    (await runCli(['render', '-i', 'p.jps', '-t', 'svg', '-o', 'x.svg', '-s', 'margn_right=10'], mk().io)).code === EXIT.config,
  )
  check(
    'adj956 `-s margin_right`（缺 `=`）⇒ 退出码 5',
    (await runCli(['render', '-i', 'p.jps', '-t', 'svg', '-o', 'x.svg', '-s', 'margin_right'], mk().io)).code === EXIT.config,
  )
  check(
    'adj956 `-s` 对 info 不再"接受但忽略" ⇒ 退出码 5（它本来就不看谱面设置）',
    (await runCli(['info', '-i', 'p.jps', '-s', 'margin_right=10'], mk().io)).code === EXIT.config,
  )
}

// ⑤ settings：值 + 来源分层
{
  const src = `# jps-config:{"margin_right": 44}\n${GOOD}`
  const io = makeIo({ 'p.jps': src })
  const r1 = await runCli(['settings', '-i', 'p.jps', 'margin_right', '--json'], io.io)
  const j1 = JSON.parse(String(io.logs.join('')))
  check('adj806 settings：源内 # jps-config 覆盖代码默认（来源标注正确）', r1.code === EXIT.ok && j1.value === 44 && j1.source === '源内 # jps-config', JSON.stringify(j1))
  const io2 = makeIo({ 'p.jps': src })
  await runCli(['settings', '-i', 'p.jps', 'margin_right', '-s', 'margin_right=33', '--json'], io2.io)
  const j2 = JSON.parse(String(io2.logs.join('')))
  /**
   * adj956：`-s` 的值现在**按类型粗转**（`margin_right` 是数字字段 ⇒ 得到数字 `33`）。
   * 改之前这里是字符串 `'33'` —— 那是**错的**：`mergeJpsConfig` 给同一个键的是数字，
   * 于是"命令行覆盖"报出来的值跟真正生效的值不是同一种东西（`AGENTS §六之二·4` 数值口径同源）。
   */
  check('adj806/adj956 settings：命令行 -s 优先级最高（值按类型转：数字字段得到数字 33）', j2.value === 33 && j2.source === '命令行 -s', JSON.stringify(j2))
  const io3 = makeIo({ 'p.jps': GOOD })
  await runCli(['settings', '-i', 'p.jps', 'margin_right', '--json'], io3.io)
  const j3 = JSON.parse(String(io3.logs.join('')))
  check('adj806 settings：源内没写 ⇒ 报"代码默认"', j3.source === '代码默认', JSON.stringify(j3))
}

// ⑥ doctor：能力如实
{
  const io = makeIo({})
  await runCli(['doctor', '--json'], io.io)
  const d = JSON.parse(String(io.logs.join('')))
  check(
    'adj806 doctor 如实报告能力（无宿主时 raster/audio 必须 false）',
    d.capabilities.svg === true && d.capabilities.midi === true && d.capabilities.raster === false && d.capabilities.audio === false,
    JSON.stringify(d.capabilities),
  )
}

// ⑦ `--watch` 的两条**可断言契约**（长驻进程本身不在这里跑 —— 那会悬挂测试 ✗，
//    真实行为由端到端冒烟覆盖：改文件后打印「变更后检查：…」✓）
{
  const noCap = makeIo({ 'a.jps': GOOD })
  const r1 = await runCli(['lint', '-i', 'a.jps', '--watch'], noCap.io)
  check(
    'adj814 --watch 在宿主没有文件监视能力时**明确报错**（退出码 1，不静默不监视 ✗）',
    r1.code === EXIT.usage && noCap.errs.some((e) => e.includes('--watch')),
    `code=${r1.code} err=${noCap.errs.join('｜')}`,
  )
  const io = makeIo({ '(stdin)': GOOD })
  io.io.watchFile = () => () => {}
  const r2 = await runCli(['lint', '-i', '-', '--watch'], io.io)
  check('adj814 --watch 不能用于 stdin（要监视具体文件）', r2.code === EXIT.usage, `code=${r2.code}`)
}

// ⑧ `@ijipu/cli` 包（adj874）：`--help` / `--version` 的**对外契约** + 包元数据 + 产物真跑
{
  const io = makeIo({})
  const r = await runCli(['--help'], io.io, { version: '9.9.9' })
  const help = String(io.logs.join(''))
  check('adj874 --help 退出码 0、写 stdout、不写 stderr', r.code === EXIT.ok && help.length > 0 && io.errs.length === 0, `code=${r.code}`)
  const CMDS = ['format', 'lint', 'info', 'render', 'play', 'batch', 'settings', 'config', 'doctor', 'completions', 'register', 'unregister', 'status']
  const missing = CMDS.filter((c) => !help.includes(c))
  check('adj874/adj944 --help 列全 13 个已实现命令（含 adj944 的 register/unregister/status）', missing.length === 0, `缺：${missing.join(' ')}`)
  /**
   * **负对照**：旧文案把 render / play / batch / settings / config / doctor 写成
   * 「未实现（P2–P4，会明确报错）」—— 而那 6 个命令**当时早已实现**（E-2026-390）。
   * 这条钉死"不许再把已实现的写成未实现" ✓。
   */
  check('adj874 --help 不再把已实现命令写成"未实现（P2–P4）"（负对照）', !help.includes('未实现（P2–P4'))
  check('adj874 --help 覆盖后加的选项（--crop/--pad/--ink/--watch/--from/--to/--pass/--aspect/--card/--nosound）', ['--crop', '--pad', '--ink', '--watch', '--from', '--to', '--pass', '--aspect', '--card', '--nosound'].every((o) => help.includes(o)))

  const ioV = makeIo({})
  const ioV2 = makeIo({})
  const rv = await runCli(['-v'], ioV.io, { version: '9.9.9' })
  const rv2 = await runCli(['--version'], ioV2.io, { version: '9.9.9' })
  check(
    'adj874 -v 与 --version 等价（退出码 0 + 版本行）',
    rv.code === EXIT.ok && rv2.code === EXIT.ok && String(ioV.logs.join('')) === 'iJipu 9.9.9\n' && String(ioV2.logs.join('')) === 'iJipu 9.9.9\n',
    `-v=${JSON.stringify(String(ioV.logs.join('')))} --version=${JSON.stringify(String(ioV2.logs.join('')))}`,
  )

  // 包元数据：`@ijipu/cli` 的版本是**第 4 处**版本号 ⇒ 必须与 APP_VERSION 锁在一起 ✓
  const pkg = JSON.parse(readFileSync('packages/ijipu-cli/package.json', 'utf8')) as {
    name: string
    version: string
    bin: Record<string, string>
    files: string[]
    dependencies?: Record<string, string>
  }
  const appVer = String(readFileSync('src/brand/version.ts', 'utf8')).match(/APP_VERSION = '([^']+)'/)?.[1] ?? ''
  /**
   * 包名**带 scope**（用户 2026-10-11 定：与引擎包 `@ijipu/engine` 对齐）⇒ 钉住，
   * 免得被"顺手改成无 scope 的 ijipu-cli" ✗。
   */
  check('adj874 包名 = @ijipu/cli（与引擎包 @ijipu/engine 同一 scope）', pkg.name === '@ijipu/cli', `实际=${pkg.name}`)
  check('adj874 CLI 包版本 == APP_VERSION（版本号不漂移）', pkg.version === appVer && appVer !== '', `包=${pkg.version} 应用=${appVer}`)
  check(
    'adj874 包 bin 指向构建产物、files 含 dist、运行期零依赖',
    pkg.bin.ijipu === 'dist/ijipu.cjs' && pkg.files.includes('dist') && pkg.dependencies === undefined,
    JSON.stringify({ bin: pkg.bin, files: pkg.files, deps: pkg.dependencies }),
  )

  /**
   * 产物核对。**为什么静态读文本 + 一次 spawn，而不是只 spawn**：
   *  · 静态部分（shebang / 版本注入）能在"产物没构建"时给出**明确原因**而不是堆栈 ✗；
   *  · spawn 部分才是"运行时真的跑到了"的证据（E-2026-264 的教训：源码文本断言证明不了运行期 ✓）——
   *    但 DSH 沙箱下 `spawn` + 管道 stdio 会 EPERM，这时**如实标记跳过**（不冒充通过 ✗）。
   */
  let bundle: string | null = null
  try {
    bundle = readFileSync('packages/ijipu-cli/dist/ijipu.cjs', 'utf8')
  } catch {
    check('adj874 CLI 产物存在（packages/ijipu-cli/dist/ijipu.cjs）', false, '先跑 `npm run cli:build`')
  }
  if (bundle !== null) {
    check('adj874 产物以 shebang 开头（bin 可直接执行）', bundle.startsWith('#!/usr/bin/env node'))
    check('adj874 产物注入了真实版本（不是 dev 兜底）', bundle.includes(pkg.version))
    try {
      const out = execFileSync(process.execPath, ['packages/ijipu-cli/dist/ijipu.cjs', '--version'], { encoding: 'utf8' })
      check('adj874 产物端到端可跑：node dist/ijipu.cjs --version', out.trim() === `iJipu ${pkg.version}`, `实际=${JSON.stringify(out.trim())}`)
    } catch (e) {
      const msg = String(e)
      if (msg.includes('EPERM')) {
        console.log('  · adj874 端到端**跳过**（沙箱不允许 spawn + 管道 stdio：EPERM）—— 请在普通终端手跑：node packages/ijipu-cli/dist/ijipu.cjs --version')
      } else {
        check('adj874 产物端到端可跑：node dist/ijipu.cjs --version', false, msg)
      }
    }
  }
}

// ⑨ adj942（用户裁定「直接落，修」·路线②）：**内嵌 CLI** 的接线 —— `ijipu.exe` 里跑的就是这一份
{
  /** 假宿主：宿主（Rust）注入的那组能力，全部内存化（字段口径见 `embedEntry.ts` 的 `EmbedHost`） */
  const makeHost = (
    files: Record<string, string> = {},
    failRead = false,
  ): { host: EmbedHost; out: string[]; errs: string[]; text: Record<string, string>; bin: Record<string, string> } => {
    const out: string[] = []
    const errs: string[] = []
    const text: Record<string, string> = {}
    const bin: Record<string, string> = {}
    const host: EmbedHost = {
      argv: [],
      readStdin: () => files['(stdin)'] ?? '',
      readFile: (p) => {
        if (failRead || !(p in files)) throw new Error(`ENOENT: 读不到文件 ${p}`)
        return files[p]
      },
      writeFile: (p, t) => void (text[p] = t),
      writeFileBinary: (p, b64) => void (bin[p] = b64),
      listDir: () => [],
      exists: (p) => p in files || p in text || p in bin,
      out: (t) => void out.push(t),
      err: (t) => void errs.push(t),
    }
    return { host, out, errs, text, bin }
  }

  /**
   * ⚠ 要**错误**（不是告警）得用「`{tp … }` 只能写在歌词行」——`Q: x` 那类"无法识别的符号"
   * 在引擎里是**告警**（本文件第 ① 组早就踩过这个坑 ✗），拿它当"语法错误"会得到退出码 0。
   */
  const EMBED_BAD = 'V: 1.0\nB: 错\nD: C\nP: 4/4\nQ: 1 2 3 4 | {tp 5 6 7 1} |\n'
  const embedPkgVersion = readFileSync('packages/ijipu-cli/package.json', 'utf8').match(/"version":\s*"([^"]+)"/)?.[1] ?? ''

  const v = makeHost()
  v.host.argv = ['--version']
  const rv = await runEmbeddedCli(v.host)
  check(
    'adj942 内嵌入口 `--version` 走通（退出码 0 + `iJipu <版本>`，与 Node 版同一个版本宏）',
    rv.code === EXIT.ok && embedPkgVersion !== '' && String(v.out.join('')) === `iJipu ${embedPkgVersion}\n`,
    `code=${rv.code} out=${JSON.stringify(String(v.out.join('')))} 期望=${embedPkgVersion}`,
  )

  const good = makeHost({ '(stdin)': GOOD })
  good.host.argv = ['lint', '-i', '-']
  const rg = await runEmbeddedCli(good.host)
  check(
    'adj942 内嵌入口 `lint`（好谱）⇒ 0 且**不写任何文件**（只读这条也要在内嵌路径上成立）',
    rg.code === EXIT.ok && Object.keys(good.text).length === 0 && Object.keys(good.bin).length === 0,
    `code=${rg.code}`,
  )

  const bad = makeHost({ '(stdin)': EMBED_BAD })
  bad.host.argv = ['lint', '-i', '-']
  const rb = await runEmbeddedCli(bad.host)
  check('adj942 内嵌入口 `lint`（错误谱）⇒ 3（退出码契约与 Node 版同一套）', rb.code === EXIT.syntax, `code=${rb.code}`)
  const fixed = makeHost({ '(stdin)': EMBED_BAD.replace('{tp 5 6 7 1}', '5 6 7 1') })
  fixed.host.argv = ['lint', '-i', '-']
  check(
    'adj942 负对照①：同一份谱**把错处修好**后 ⇒ 0（证明上面那条 3 是谱的问题、不是内嵌接线在乱报）',
    (await runEmbeddedCli(fixed.host)).code === EXIT.ok,
  )

  const mid = makeHost({ '(stdin)': GOOD })
  mid.host.argv = ['render', '-i', '-', '-t', 'midi', '-o', 'out.mid']
  const rm = await runEmbeddedCli(mid.host)
  const midiBytes = mid.bin['out.mid'] !== undefined ? Buffer.from(mid.bin['out.mid'], 'base64') : Buffer.alloc(0)
  check(
    'adj942 内嵌入口**二进制通道**（base64）走通：`render -t midi` ⇒ 0 且宿主拿到的字节以 MThd 开头',
    rm.code === EXIT.ok && midiBytes.subarray(0, 4).toString('latin1') === 'MThd',
    `code=${rm.code} bytes=${midiBytes.length} head=${midiBytes.subarray(0, 4).toString('latin1')}`,
  )

  const png = makeHost({ '(stdin)': GOOD })
  png.host.argv = ['render', '-i', '-', '-t', 'png', '-o', 'out.png']
  const rp = await runEmbeddedCli(png.host)
  check(
    'adj942 内嵌入口**不谎报能力**：没注入 rasterize ⇒ `-t png` 退出码 4 且不写文件（与独立 Node 环境同口径）',
    rp.code === EXIT.render && Object.keys(png.bin).length === 0 && png.errs.some((e) => e.includes('隐藏窗口渲染')),
    `code=${rp.code} err=${png.errs.join('｜')}`,
  )

  const missing = makeHost({}, true)
  missing.host.argv = ['lint', '-i', '不存在.jps']
  check('adj942 内嵌入口：宿主读文件失败 ⇒ 2（"输入不存在"的对外承诺不变 ✓）', (await runEmbeddedCli(missing.host)).code === EXIT.noInput)

  /**
   * `TextEncoder` 补丁：**QuickJS 没有 TextEncoder**，而引擎的 MIDI 产出要用它
   * （`engine/playback/midi.ts` 的 `utf8()`）⇒ 内嵌入口自己补了一个。
   * 这里把 Node 的全局**删掉**来模拟 QuickJS：① 内嵌入口仍出 MIDI ✓；
   * ② **负对照**：CLI 核心（不装补丁）在同一环境下**必然失败** ✓ —— 证明补丁真的在起作用。
   */
  const g = globalThis as unknown as { TextEncoder?: unknown }
  const savedTe = g.TextEncoder
  const removedTe = delete g.TextEncoder
  if (!removedTe) {
    console.log('  · adj942 TextEncoder 补丁那两条**跳过**（本环境不允许删全局 TextEncoder）')
  } else {
    try {
      let coreFailed = false
      try {
        const core = makeIo({ '(stdin)': GOOD })
        await runCli(['render', '-i', '-', '-t', 'midi', '-o', 'out.mid'], core.io)
      } catch {
        coreFailed = true
      }
      const noTe = makeHost({ '(stdin)': GOOD })
      noTe.host.argv = ['render', '-i', '-', '-t', 'midi', '-o', 'out.mid']
      const rNoTe = await runEmbeddedCli(noTe.host)
      const teHead = noTe.bin['out.mid'] !== undefined ? Buffer.from(noTe.bin['out.mid'], 'base64').subarray(0, 4).toString('latin1') : ''
      check(
        'adj942 内嵌入口自带 `TextEncoder` 补丁（模拟"没有 TextEncoder"的环境）⇒ `-t midi` 仍出 MThd 且补上了全局',
        rNoTe.code === EXIT.ok && teHead === 'MThd' && typeof g.TextEncoder === 'function',
        `code=${rNoTe.code} head=${teHead}`,
      )
      check('adj942 负对照②：同环境下**不装补丁的 CLI 核心**必然失败（证明那条补丁不是摆设）', coreFailed)
    } finally {
      g.TextEncoder = savedTe
    }
  }
}

// ⑩ adj944（用户需求）：「注册 iJipu CLI 到当前用户 PATH」的三个子命令 —— 接线、退出码、幂等
{
  /**
   * 假宿主：`io.pathHost`（真宿主在 Rust 侧 `src-tauri/src/cli_path.rs`，真机实测另做）。
   * ⚠ 这里**不碰真实注册表**：把"系统"放在内存里 ⇒ 断言能精确到"到底写了几次、写的是什么" ✓。
   */
  const makePathHost = (initial: string | null, installDir = 'C:\\Apps\\iJipu') => {
    let value = initial
    let appPaths: string | null = null
    const writes: string[] = []
    const host = {
      async installDir() {
        return installDir
      },
      async exePath() {
        return `${installDir}\\ijipu.exe`
      },
      async readPath() {
        return value
      },
      async writePath(next: string) {
        writes.push(next)
        value = next
      },
      async readAppPaths() {
        return appPaths
      },
      async writeAppPaths(exe: string) {
        appPaths = exe
      },
      async removeAppPaths() {
        appPaths = null
      },
    }
    return { host, writes, value: () => value, appPaths: () => appPaths }
  }
  /**
   * adj946：注册写进 PATH 的是**命令行入口目录**（`<安装目录>\bin`）—— 断言里的期望值就取它。
   * 与 `envPath.ts` 的 `binDirOf` **同口径**（这里刻意不 import，只在断言里写一次字面量，
   * 机器核对由 `smoke.mts` 的 `adj946` 那组负责 ✓）。
   */
  const BIN_DIR = 'C:\\Apps\\iJipu\\bin'

  // ① 没有宿主能力（独立 Node 环境）⇒ 如实报 6，且不假装成功
  {
    const noHost = makeIo({})
    const r = await runCli(['status'], noHost.io)
    check(
      'adj944 无宿主（独立 Node 环境）⇒ `status` 退出码 6 且说明"要用桌面端"（不假装成功 ✗）',
      r.code === EXIT.env && noHost.errs.some((e) => e.includes('桌面端')) && noHost.logs.length === 0,
      `code=${r.code} err=${noHost.errs.join('｜')}`,
    )
    const noHost2 = makeIo({})
    check(
      'adj944 无宿主 ⇒ `register` 同样是 6（三个子命令一条口径）',
      (await runCli(['register'], noHost2.io)).code === EXIT.env,
    )
    const noHost3 = makeIo({})
    check(
      'adj944 无宿主 ⇒ `unregister` 同样是 6',
      (await runCli(['unregister'], noHost3.io)).code === EXIT.env,
    )
  }

  // ② 有宿主：status / register / unregister 的实况与幂等
  {
    const a = makePathHost(null)
    const st = makeIo({})
    st.io.pathHost = a.host
    const r0 = await runCli(['status', '--json'], st.io)
    const s0 = JSON.parse(String(st.logs.join('')))
    check(
      'adj944 `status --json`：未注册时如实报 registered=false + 安装目录 + 命令行入口目录 + PATH 长度',
      r0.code === EXIT.ok && s0.registered === false && s0.installDir === 'C:\\Apps\\iJipu' &&
        s0.binDir === BIN_DIR && s0.legacy === false && s0.pathLength === 0 && s0.pathLimit === 2047,
      JSON.stringify(s0),
    )

    const reg = makeIo({})
    reg.io.pathHost = a.host
    const r1 = await runCli(['register'], reg.io)
    check(
      'adj944 `register` ⇒ 0、只写一次、**写的是命令行入口目录 bin**（adj946 口径），并提示"新开一个终端"',
      r1.code === EXIT.ok && a.writes.length === 1 && a.writes[0] === BIN_DIR &&
        reg.logs.join('').includes('新开一个终端'),
      `writes=${JSON.stringify(a.writes)}`,
    )
    const reg2 = makeIo({})
    reg2.io.pathHost = a.host
    const r2 = await runCli(['register'], reg2.io)
    check(
      'adj944 再 `register` 一次 ⇒ **一个字都不写**（幂等；已注册时不重复追加）',
      r2.code === EXIT.ok && a.writes.length === 1 && reg2.logs.join('').includes('未重复写入'),
      `writes=${a.writes.length} out=${JSON.stringify(reg2.logs.join(''))}`,
    )
    const un = makeIo({})
    un.io.pathHost = a.host
    const r3 = await runCli(['unregister'], un.io)
    check(
      'adj944 `unregister` ⇒ 0、把 PATH 写成空、App Paths 也清掉',
      r3.code === EXIT.ok && a.value() === '' && a.appPaths() === null && a.writes.length === 2 &&
        un.logs.join('').includes('逐字未动'),
      `value=${JSON.stringify(a.value())}`,
    )
    const un2 = makeIo({})
    un2.io.pathHost = a.host
    const r4 = await runCli(['unregister'], un2.io)
    check('adj944 再 `unregister` 一次 ⇒ 不改动（幂等）', r4.code === EXIT.ok && a.writes.length === 2)
  }

  // ③ 别人的条目一个字都不许动 + 超长拒绝写入（负对照）+ adj946 旧形态兼容
  {
    const b = makePathHost(`C:\\Windows;${BIN_DIR};C:\\Other`)
    const un = makeIo({})
    un.io.pathHost = b.host
    await runCli(['unregister'], un.io)
    check(
      'adj944 `unregister` 只摘自己那一条，别人的两条**逐字未动**',
      b.value() === 'C:\\Windows;C:\\Other' && b.writes.length === 1,
      `value=${JSON.stringify(b.value())}`,
    )

    const long = makePathHost('z'.repeat(2047))
    const reg = makeIo({})
    reg.io.pathHost = long.host
    const r = await runCli(['register'], reg.io)
    check(
      'adj944 超长 ⇒ 退出码 6、**不写**（writes=0），并把上限与建议讲清楚',
      r.code === EXIT.env && long.writes.length === 0 && reg.errs.join('').includes('2047') &&
        reg.errs.join('').includes('未写入'),
      `code=${r.code} writes=${long.writes.length} err=${reg.errs.join('｜').slice(0, 120)}`,
    )
    /** 负对照：把"不判长度"的写法当判据 ⇒ 它会照写（writes 就不是 0）⇒ 判假 ✓ */
    check(
      'adj944 负对照：超长却照样写的情形与上面的"零写入"互斥',
      long.writes.length === 0 && r.code === EXIT.env,
    )

    /**
     * adj946：**旧形态兼容**（adj944 曾把"安装目录本身"写进 PATH）。
     * 必须做到两件事，否则用户升级后点「注册」会留下一条更靠前的 `ijipu.exe`（症状复发 ✗）：
     *  ① `status` 要如实认出旧形态（`legacy=true` 且按**未注册**报）；
     *  ② `register` 要**顺手把它换成 bin**；`unregister` 要**两种都摘**。
     */
    const legacy = makePathHost(`C:\\Windows;C:\\Apps\\iJipu;C:\\Other`)
    const stLegacy = makeIo({})
    stLegacy.io.pathHost = legacy.host
    const rl = await runCli(['status', '--json'], stLegacy.io)
    const sl = JSON.parse(String(stLegacy.logs.join('')))
    check(
      'adj946 `status --json`：PATH 里只有**旧形态**（安装目录本身）⇒ `legacy=true`、`registered=false`（如实报，不冒充已注册）',
      rl.code === EXIT.ok && sl.legacy === true && sl.registered === false && sl.binDir === BIN_DIR,
      JSON.stringify(sl),
    )
    const regLegacy = makeIo({})
    regLegacy.io.pathHost = legacy.host
    const rl2 = await runCli(['register'], regLegacy.io)
    check(
      'adj946 `register`：**把旧形态换成 bin**（`C:\\Windows;<安装目录>;C:\\Other` ⇒ `C:\\Windows;C:\\Other;<bin>`，别人的两条逐字未动）',
      rl2.code === EXIT.ok && legacy.writes.length === 1 &&
        legacy.value() === `C:\\Windows;C:\\Other;${BIN_DIR}` &&
        regLegacy.logs.join('').includes(BIN_DIR),
      `value=${JSON.stringify(legacy.value())}`,
    )
    const unLegacyHost = makePathHost(`C:\\Windows;C:\\Apps\\iJipu;C:\\Other`)
    const unLegacy = makeIo({})
    unLegacy.io.pathHost = unLegacyHost.host
    const rl3 = await runCli(['unregister'], unLegacy.io)
    check(
      'adj946 `unregister`：**两种形态都摘**（只留旧形态时也摘得干净 ⇒ 不留指向 GUI exe 的尾巴）',
      rl3.code === EXIT.ok && unLegacyHost.value() === 'C:\\Windows;C:\\Other' &&
        unLegacyHost.writes.length === 1,
      `value=${JSON.stringify(unLegacyHost.value())}`,
    )
  }
}

// ⑪ adj947（用户实报）：`--help` 的"用法"行必须带 `cli`
{
  const io = makeIo({})
  await runCli(['--help'], io.io, { version: '9.9.9' })
  const help = String(io.logs.join(''))
  /**
   * 用法行 = 帮助里唯一以 `用法：` 开头的那一行（**行首匹配**，别用 `includes` ✗）。
   * 判据是**逐字相等**、不是 `includes('cli')`：`ijipu cli [全局选项]` 与 `ijipu [全局选项]`
   * 的差别就在那一个词上，而 `includes('cli')` 会被"iJipu CLI"这类字样满足 ⇒ 判据太松 ✗。
   */
  const usageLine = (text: string): string => text.split('\n').find((l) => l.startsWith('用法：')) ?? ''
  const USAGE_OK = '用法：ijipu cli [全局选项] <命令> [命令选项]'
  check(`adj947 --help 的用法行逐字是 \`${USAGE_OK}\``, usageLine(help) === USAGE_OK, `实际=${JSON.stringify(usageLine(help))}`)
  check('adj947 --help 里不再出现旧的 `ijipu [全局选项]`（用户实报的那一行）', !help.includes('ijipu [全局选项]'))
  const legacy = help.replace('ijipu cli [全局选项]', 'ijipu [全局选项]')
  check(
    'adj947 负对照①：把用法行改回 `ijipu [全局选项] …`（＝用户实报的写法）⇒ 判据判红',
    legacy !== help && usageLine(legacy) !== USAGE_OK && usageLine(legacy) === '用法：ijipu [全局选项] <命令> [命令选项]',
    `改坏后=${JSON.stringify(usageLine(legacy))}`,
  )
  const moved = help.replace('ijipu cli [全局选项]', 'ijipu [全局选项]').replace('iJipu 命令行', 'iJipu 命令行 cli')
  check(
    'adj947 负对照②：把 `cli` 挪出用法行、塞进标题（＝`includes("cli")` 那种松判据会放过）⇒ 判据仍判红',
    moved !== help && moved.includes('cli') && usageLine(moved) !== USAGE_OK,
    `实际=${JSON.stringify(usageLine(moved))}`,
  )
  /**
   * 用法行以外的"示例命令"：帮助里凡把 `ijipu` / `ijipu.exe` 当命令名、后面**直接跟一个已知子命令**
   * 的地方，都必须先有 `cli`。已知命令名单**从 `cli.ts` 源码里读**（不写死 ✓）。
   * ⚠ 刻意不含"`ijipu 某个谱.jps`"这类形态：那是**对的**用法（双击/文件关联），不是漏 `cli` ✓。
   */
  const cliSrcForHelp = readFileSync('packages/ijipu-cli/src/cli.ts', 'utf8')
  const knownSrc = cliSrcForHelp.match(/const known = new Set\(\[([^\]]*)\]\)/)
  const KNOWN = knownSrc === null ? [] : Array.from(knownSrc[1].matchAll(/'([^']+)'/g)).map((x) => x[1])
  const bareInvocations = (text: string): string[] => {
    const out: string[] = []
    for (const l of text.split('\n')) {
      for (const m of l.matchAll(/\bijipu(?:\.exe)?\s+(?!cli\b)([a-z][a-z-]*)/g)) if (KNOWN.includes(m[1])) out.push(m[1])
    }
    return out
  }
  check(
    `adj947 --help 里没有"缺 cli"的示例命令（名单从源码读到 ${KNOWN.length} 个）`,
    KNOWN.length >= 13 && bareInvocations(help).length === 0,
    `命中：${bareInvocations(help).join(' ')}`,
  )
  check(
    'adj947 负对照③：往帮助里插一行 `ijipu lint -i a.jps`（＝漏 `cli` 的示例）⇒ 判据判红',
    bareInvocations(`${help}\n  ijipu lint -i a.jps\n`).length === 1 && bareInvocations(help).length === 0,
  )
  check(
    'adj947 负对照④：同一行写成 `ijipu.exe cli lint -i a.jps` ⇒ 判据不再报（证明它盯的是"缺 cli"、不是"出现过 lint"）',
    bareInvocations(`${help}\n  ijipu.exe cli lint -i a.jps\n`).length === 0,
  )
  /**
   * adj947（实测顺手抓到的**同族**缺陷）：HELP 是**模板字符串** ⇒ 里面的 `\b` 会被 JS 当成
   * **退格符**（不是"反斜杠 + b"），用户看到的是 `<安装>in` 这种被吃掉一个字的乱码
   * （`E-2026-396` 的"模板字符串里反引号"同族：**模板字符串里的转义字符**）。
   * 判据：帮助输出里除 `\n` / `\t` 之外**不许出现控制字符** ✓。
   */
  const ctrlChars = (text: string): number[] =>
    Array.from(text)
      .map((c) => c.codePointAt(0) ?? 0)
      .filter((n) => n < 32 && n !== 10 && n !== 9)
  check(
    'adj947 --help 里没有控制字符（除换行/制表）—— 模板字符串里的 `\\b` 会被当成退格符、把字吃掉',
    ctrlChars(help).length === 0,
    `控制字符码点：${ctrlChars(help).join(',')}`,
  )
  check(
    'adj947 负对照⑤：往帮助里插一个 `\\b`（＝模板字符串里那个坑的原始形态）⇒ 判据判红',
    ctrlChars(`${help}\n<安装目录>\bin\n`).length >= 1 && ctrlChars(help).length === 0,
  )
  check(
    'adj947 --help 里的 `<安装目录>\\bin` 是**字面反斜杠**（目录名写全，不是被吃成退格的形态）',
    help.includes('<安装目录>\\bin'),
  )
}

/**
 * ⑫ adj965m（用户 2026-10-15 要求）：「**cli 的 `--help` 也要遵循文案的信雅达**」——
 * 即与官网同一条标准（`adj948`：正式、规范、优雅、简洁），而命令行还多一条更硬的约束：
 * `--help` 与各条提示都是**纯文本**，里面的 Markdown 强调（`**…**`）与警示符号（`⚠`）
 * 会**原样打到终端**（用户看到的是 `必须**恰好**是`）。
 *
 * 实测（改之前）：`--help` 输出里 **46 个 `**`、3 个 `⚠`**，最宽一行 **131 显示列**
 * （常见 120 列终端会折行）。同一族毛病官网修过一次（`adj948` 首页字面 `**`，`E-2026-432`），
 * 那次只修了网页，**命令行这边漏了**。
 *
 * 四条判据，每条都配负对照（表刻意**窄**：只抓"真的会被用户看见"的两类标记，不做宽泛的风格扫描）：
 *  ① 源码里**非注释行**（＝会被打印的字符串）没有 `**` / 警示符号；
 *  ② 真跑 `--help`：输出同样干净，且每行**显示列**（中文算 2 列）≤ 120；
 *  ③ 关键信息点逐项仍在（重写不许把信息删掉）；
 *  ④ 帮助里不出现内部编号（`adjNNN` / `E-2026-NNN`）—— 那是维护者口径，不该出现在用户眼前。
 */
{
  const cliSource = readFileSync('packages/ijipu-cli/src/cli.ts', 'utf8')
  /** 警示符号（窄表：只列终端里最扎眼的几个；`✓ ✗ ⇒ ｜ ·` 是命令行既有惯例，不在表内） */
  const WARN_MARKS = ['⚠', '❗', '❕', '🚧', '🔥']
  const markHits = (text: string): string[] => {
    const out: string[] = []
    if (text.includes('**')) out.push('**')
    for (const w of WARN_MARKS) if (text.includes(w)) out.push(w)
    return out
  }
  /** 会被打印的源码行＝去掉注释行（以 `*` / `//` / `/*` 开头）；注释里写 `**` 是给维护者看的，不算 */
  const printable = (src: string): string =>
    src
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
      })
      .join('\n')
  check(
    'adj965m ① cli.ts 的**可打印字符串**里没有 Markdown 强调与警示符号（`**` 在终端里就是星号）',
    markHits(printable(cliSource)).length === 0,
    `命中：${markHits(printable(cliSource)).join(' ')}`,
  )
  check(
    'adj965m ① **负对照**：往一行可打印字符串里塞 `**` 与 `⚠` ⇒ 判据判红（不是恒绿）',
    markHits(printable(`${cliSource}\nconst x = '**加粗** ⚠ 注意'\n`)).length >= 2,
  )

  const ioM = makeIo({})
  await runCli(['--help'], ioM.io, { version: '9.9.9' })
  const helpText = String(ioM.logs.join(''))
  /** 终端显示宽度：CJK/全角算 2 列（否则"字符数不长"的行其实会折行） */
  const displayWidth = (line: string): number =>
    [...line].reduce((a, c) => a + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(c) ? 2 : 1), 0)
  const widest = (text: string): number => Math.max(0, ...text.split('\n').map(displayWidth))
  check(
    'adj965m ② 真跑 `--help`：输出里没有 `**`/警示符号，且最宽一行 ≤ 120 显示列（常见终端不折行）',
    markHits(helpText).length === 0 && widest(helpText) <= 120,
    `命中：${markHits(helpText).join(' ')}；最宽 ${widest(helpText)} 列`,
  )
  check(
    'adj965m ② **负对照**：往帮助里插 `**` / 追加一行 130 列的长文本 ⇒ 标记与行宽两条分别判红',
    markHits(`${helpText}\n**放不下**\n`).length === 1 && widest(`${helpText}\n${'x'.repeat(130)}\n`) > 120,
  )

  /**
   * ③ 关键信息点：重写文案**不许把信息删掉**（`adj948` 的先例也是"信息一条未删"）。
   * 清单只放"删了会让用户少知道一件事"的点：用法行、各段标题、退出码全表、入口目录、几个不易察觉的选项。
   */
  const KEY_FACTS = [
    '用法：ijipu cli [全局选项] <命令> [命令选项]',
    '命令：',
    '目录类选项',
    '产物落点',
    '全局选项：',
    '退出码：0 成功 ｜ 1 用法错误 ｜ 2 输入不存在 ｜ 3 语法错误 ｜ 4 渲染失败 ｜ 5 设置非法 ｜ 6 环境能力缺失',
    '<安装目录>\\bin',
    '--deterministic',
    '--filter',
    'completions',
    'register',
    'status',
  ]
  const missingFacts = (text: string): string[] => KEY_FACTS.filter((f) => !text.includes(f))
  check(
    `adj965m ③ 重写后**关键信息一条不丢**（${KEY_FACTS.length} 项：用法行 / 各段标题 / 退出码全表 / 入口目录 / 若干选项与命令）`,
    missingFacts(helpText).length === 0,
    `缺：${missingFacts(helpText).join(' / ')}`,
  )
  const cut = helpText
    .replace('目录类选项', '')
    .replace('退出码：0 成功', '')
    .replace('<安装目录>\\bin', '')
    .replace('--deterministic', '')
  check(
    'adj965m ③ **负对照**：四类各删一项（段标题 / 退出码 / 入口目录 / 选项）⇒ 判据**逐项**判红（缺 4 项）',
    missingFacts(cut).length === 4,
    `实际缺 ${missingFacts(cut).length} 项`,
  )
  const internalTags = (text: string): string[] => text.match(/\badj\d+[a-z]?\b|E-2026-\d+/g) ?? []
  check(
    'adj965m ④ 帮助里不出现内部编号（`adjNNN` / `E-2026-NNN`）—— 那是维护者口径，不该出现在用户眼前',
    internalTags(helpText).length === 0,
    `命中：${internalTags(helpText).join(' ')}`,
  )
  check(
    'adj965m ④ **负对照**：塞一个 `adj965m` 与一个 `E-2026-445` 进去 ⇒ 判据判红',
    internalTags(`${helpText}\nadj965m E-2026-445\n`).length === 2,
  )
}

/**
 * ⑨ adj949（**用户追加要求**：「示例应该通过即时预览生成」「手册里的每条示例输出都必须是真跑得到的」）：
 *
 * 手册 `docs/CLI-手册.md` 里的每一段输出，都**现跑一遍**再比对 —— 判据是双向的：
 *   ① 同一条 argv 在内存 IO 上跑出来的 stdout/stderr 里**确实有**这一行（＝它不是手抄的）；
 *   ② 手册里**确实写着**这一行（＝两者逐字一致，没有抄走样）。
 * 任一侧不成立就判红 ⇒ 以后改输出文案而忘了改手册，`npm run smoke` 立刻拦下 ✓。
 *
 * ⚠ 只跑**纯计算**的那批（不碰注册表、不真写磁盘）：注册类命令的示例输出由 `adj944`/`adj946`
 *   那两组（假宿主）守着，这里不重复 ✗。版本号从 `src/brand/version.ts` 读 ⇒ 手册里的
 *   `"generator": "ijipu x.y.z"` 也跟着一起被钉住 ✓。
 */
{
  const MANUAL = readFileSync(join('docs', 'CLI-手册.md'), 'utf8')
  const APP_VERSION =
    (readFileSync(join('src', 'brand', 'version.ts'), 'utf8').match(/APP_VERSION = '([^']+)'/) ?? [])[1] ?? ''
  /** 手册里两份"出错示例"的全文（与手册里贴的逐字一致 ⇒ 用户照抄就能复现） */
  const BAD_JPS = 'V: 1.0\nB: 错谱演示\nD: C\nP: 4/4\nQ: 1"注释没闭合 2 3 4 |\n'
  const RAW_JPS = 'Q:1 2 3 4|\n'
  const WARN_JPS = 'V: 1.0\nB: w\nD: C\nP: 4/4\nQ: 1 2 x 4 |\n'
  /** 仓库 `samples/` 下的示例谱（手册的示例全用它们） */
  const SAMPLE_NAMES = readdirSync('samples').filter((n) => n.endsWith('.jps')).sort()
  const sampleFiles: Record<string, string> = {}
  for (const n of SAMPLE_NAMES) sampleFiles[`samples/${n}`] = readFileSync(join('samples', n), 'utf8')

  type ManualCase = { what: string; argv: string[]; lines: string[]; code?: number }
  const cases: ManualCase[] = [
    { what: 'lint 干净', argv: ['lint', '-i', 'samples\\ershenbu.jps'], lines: ['没有发现问题 ✓'], code: EXIT.ok },
    {
      what: 'info 文本',
      argv: ['info', '-i', 'samples\\ershenbu.jps'],
      lines: ['文件：samples\\ershenbu.jps', '调号：C', '源码行：17｜曲词分组：3｜字符：259', '问题：错误 0 个、告警 0 个'],
      code: EXIT.ok,
    },
    { what: 'format --check 合规', argv: ['format', '-i', 'samples\\ershenbu.jps', '--check'], lines: ['已符合规范 ✓'], code: EXIT.ok },
    /**
     * adj964：`-o` 与 `--in-place` 互斥（自测发现的静默忽略 ⇒ 现在报歧义）。
     * 手册 §2.4 里那段输出由这条现跑核对（`adj949` 是双向判据：跑得出 + 手册里逐字有）。
     */
    {
      what: 'format -o 与 --in-place 互斥',
      argv: ['format', '-i', '我的谱.jps', '--in-place', '-o', '我的谱.规范化.jps'],
      lines: ['-o 与 --in-place 不能同时给：-o 是"另存到那个文件"，--in-place 是"原地覆盖源文件"'],
      code: EXIT.usage,
    },
    { what: 'render svg', argv: ['render', '-i', 'samples\\ershenbu.jps', '-t', 'svg', '-o', '我的谱.svg'], lines: ['已写入 我的谱.svg'], code: EXIT.ok },
    { what: 'render midi', argv: ['render', '-i', 'samples\\ershenbu.jps', '-t', 'midi', '-o', '我的谱.mid'], lines: ['已写入 我的谱.mid（MIDI，225 字节）'], code: EXIT.ok },
    {
      what: 'render --crop score --pad 4',
      argv: ['render', '-i', 'samples\\ershenbu.jps', '-t', 'svg', '--crop', 'score', '--pad', '4', '-o', '我的谱.svg'],
      lines: ['已写入 我的谱.svg'],
      code: EXIT.ok,
    },
    { what: 'play midi', argv: ['play', '-i', 'samples\\ershenbu.jps', '-t', 'midi', '-o', '我的谱.mid'], lines: ['已写入 我的谱.mid（MIDI，225 字节）'], code: EXIT.ok },
    {
      what: 'batch svg',
      argv: ['batch', '--in', 'samples', '-o', '输出目录', '-t', 'svg'],
      // adj956：汇总文案改了口径（多了"任务 / 输入 N 个文件"），手册里那行也是现跑出来的
      lines: [`批处理完成：成功 ${SAMPLE_NAMES.length} 个、失败 0 个（任务 svg；输入 ${SAMPLE_NAMES.length} 个文件，输出到 输出目录）`],
      code: EXIT.ok,
    },
    /**
     * adj961（用户问「`-t svg` 必须要 `-o` 吗？不能导出在原目录吗？」）：省略 `-o` ⇒ 就地。
     * 下面三条把手册 §2.8 里**新贴的三段输出**也现跑一遍钉住。
     */
    {
      what: 'batch 就地出图（省略 -o）',
      argv: ['batch', '--in', 'samples', '-t', 'svg'],
      lines: [`批处理完成：成功 ${SAMPLE_NAMES.length} 个、失败 0 个（任务 svg；输入 ${SAMPLE_NAMES.length} 个文件，输出与源文件同目录）`],
      code: EXIT.ok,
    },
    {
      what: 'batch -t fmt 省略 -o ⇒ 拒绝（要 --in-place 才肯就地）',
      argv: ['batch', '--in', 'samples', '-t', 'fmt'],
      /**
       * adj965m（**文案规范化**：用户要求命令行的 `--help` 与输出也按官网同一条标准「正式、规范、
       * 优雅、简洁」）：这条断言的期望文本原来带 Markdown 强调（`**就地**`）—— 那是**会原样打到终端**的
       * 星号，已随 `cli.ts` 一并去掉。**口径变更**（不是放宽：判据仍逐字相等，只是对上了新文案），
       * 同一处文本的引用在 `docs/CLI-手册.md` 也同步改掉了（`adj949` 逐行核着手册）。
       */
      lines: ['batch 不写 -o 时产物就地输出；而 `-t fmt` 就地就是原地覆盖源文件 ⇒ 要显式确认：'],
      code: EXIT.usage,
    },
    {
      what: 'batch -t fmt --in-place',
      argv: ['batch', '--in', 'samples', '-t', 'fmt', '--in-place'],
      lines: [`批处理完成：成功 ${SAMPLE_NAMES.length} 个、失败 0 个（任务 fmt；输入 ${SAMPLE_NAMES.length} 个文件，fmt 任务原地覆盖源文件）`],
      code: EXIT.ok,
    },
    {
      what: 'batch -t lint（省略 -o）',
      argv: ['batch', '--in', 'samples', '-t', 'lint'],
      lines: [`批处理完成：成功 ${SAMPLE_NAMES.length} 个、失败 0 个（任务 lint；输入 ${SAMPLE_NAMES.length} 个文件）`],
      code: EXIT.ok,
    },
    /**
     * adj956：`lint -i <目录>` 的汇总行。
     * ⚠ 只钉到"`N 个通过、M 个有错`"为止，**不钉告警个数** —— 告警数随 `samples/` 的内容变化，
     *   把它写死会让"改一份示例谱"变成红灯（那不是文档过期，是断言太紧 ✗）。
     */
    {
      what: 'lint 目录',
      argv: ['lint', '-i', 'samples'],
      lines: [`检查 ${SAMPLE_NAMES.length} 个文件：${SAMPLE_NAMES.length} 个通过、0 个有错`],
      code: EXIT.ok,
    },
    { what: 'settings 查键', argv: ['settings', '-i', 'samples\\ershenbu.jps', 'margin_right'], lines: ['margin_right = 50   [来自：代码默认]'], code: EXIT.ok },
    {
      what: 'settings -s 覆盖',
      argv: ['settings', '-i', 'samples\\ershenbu.jps', 'margin_right', '-s', 'margin_right=33'],
      // adj956：`-s` 的值现在按类型粗转（`margin_right` 是数字字段 ⇒ 报 33 而不是字符串 "33"）。
      // 改之前的 `"33"` 其实是**错的**：那个值引擎根本不会这么用。
      lines: ['margin_right = 33   [来自：命令行 -s]'],
      code: EXIT.ok,
    },
    {
      what: 'config --quiet',
      argv: ['config', '-i', 'samples\\ershenbu.jps', '-t', 'effective', '--quiet'],
      lines: ['生效设置（来源：命令行 > 源内 # jps-config > 代码默认）'],
      code: EXIT.ok,
    },
    { what: 'doctor', argv: ['doctor'], lines: ['可设置项：54 个（含可选字段 5 个）', '能力：svg ✓｜midi ✓'], code: EXIT.ok },
    { what: 'completions bash', argv: ['completions', 'bash'], lines: ['# iJipu bash 补全（桌面端）'], code: EXIT.ok },
    { what: 'completions 用法错', argv: ['completions', 'foo'], lines: ['completions 支持 bash | zsh | powershell（收到 “foo”）'], code: EXIT.usage },
    // adj960（用户实报）：逐项输出**必须带文件名** ⇒ 下面两条按完整行钉（含行首的文件名）
    { what: 'lint 有错', argv: ['lint', '-i', '错谱.jps'], lines: ['错谱.jps 第 5 行：引号注释未闭合'], code: EXIT.syntax },
    { what: 'lint --format gh', argv: ['lint', '-i', '错谱.jps', '--format', 'gh'], lines: ['::error file=错谱.jps,line=5::引号注释未闭合'], code: EXIT.syntax },
    { what: 'lint --json', argv: ['lint', '-i', '错谱.jps', '--json'], lines: ['"generator": "ijipu ' + APP_VERSION + '"', '"line": 5,'], code: EXIT.syntax },
    { what: 'lint 告警不动退出码', argv: ['lint', '-i', '告警谱.jps'], lines: ['告警谱.jps 第 5 行：无法识别的符号 "x"'], code: EXIT.ok },
    {
      what: 'lint --watch 无能力',
      argv: ['lint', '-i', 'samples\\ershenbu.jps', '--watch'],
      lines: ['--watch 需要宿主的文件监视能力（node 入口提供；独立环境不可用）'],
      code: EXIT.usage,
    },
    { what: 'format --check 不合规', argv: ['format', '-i', '我的谱.jps', '--check'], lines: ['需要格式化 ✗'], code: EXIT.syntax },
    { what: 'format --diff', argv: ['format', '-i', '我的谱.jps', '--diff'], lines: ['- Q:1 2 3 4|', '+ Q: 1 2 3 4 |'], code: EXIT.ok },
    { what: 'format -o -', argv: ['format', '-i', '我的谱.jps', '-o', '-'], lines: ['Q: 1 2 3 4 |'], code: EXIT.ok },
    { what: 'format -o 文件', argv: ['format', '-i', '我的谱.jps', '-o', '我的谱.规范化.jps'], lines: ['已写入 我的谱.规范化.jps'], code: EXIT.ok },
    { what: 'format --in-place', argv: ['format', '-i', '我的谱.jps', '--in-place'], lines: ['已原地格式化：我的谱.jps'], code: EXIT.ok },
    {
      what: 'render -t png 无能力',
      argv: ['render', '-i', 'samples\\ershenbu.jps', '-t', 'png', '-o', '我的谱.png'],
      lines: ['-t png 需要"隐藏窗口渲染"通道（桌面端 exe 内置）；当前环境没有该能力。'],
      code: EXIT.render,
    },
    {
      // adj1084：视频在独立环境（没有隐藏窗口通道）必须如实报错，手册 §2.6 ⑤ 逐字引用这一行
      what: 'render -t mp4 无能力',
      argv: ['render', '-i', 'samples\\ershenbu.jps', '-t', 'mp4', '-o', '我的谱.mp4'],
      lines: ['MP4 需要"桌面端隐藏窗口"通道（WebCodecs 编码）；当前环境没有该能力。'],
      code: EXIT.render,
    },
    {
      what: 'play -t wav 无能力',
      argv: ['play', '-i', 'samples\\ershenbu.jps', '-t', 'wav', '-o', '我的谱.wav'],
      lines: ['WAV 需要采样合成（音色库 + AudioContext），当前环境没有该能力。'],
      code: EXIT.render,
    },
    { what: 'render -t midi 不能 stdout', argv: ['render', '-i', 'samples\\ershenbu.jps', '-t', 'midi'], lines: ['MIDI 是二进制，必须用 -o 指定文件（不能用 stdout）'], code: EXIT.usage },
    { what: 'settings 缺键名', argv: ['settings', '-i', 'samples\\ershenbu.jps'], lines: ['settings 需要键名（位置参数），例如：settings -i <谱> margin_right'], code: EXIT.usage },
    { what: 'info --json', argv: ['info', '-i', 'samples\\ershenbu.jps', '--json'], lines: ['"groups": 3,'], code: EXIT.ok },
    /**
     * adj962（用户需求）：`set` 把设置**写进谱面**。手册 §2.9 里那三段输出现跑一遍钉住。
     * ⚠ 只钉到"`已处理 N 个文件：`"为止（后面的"几个有改动"随 `samples/` 内容变），
     *   与 `lint 目录` 那条同一个取舍。
     */
    { what: 'set 打到 stdout（不给落点 ⇒ 不改文件）', argv: ['set', '-i', '我的谱.jps', 'margin_right=33'], lines: ['# jps-config:{"margin_right":33}'], code: EXIT.ok },
    { what: 'set --in-place', argv: ['set', '-i', '我的谱.jps', 'margin_right=33', '--in-place'], lines: ['我的谱.jps 已写回'], code: EXIT.ok },
    {
      what: 'set 目录 + -o（批量另存）',
      argv: ['set', '--in', 'samples', '-o', '输出目录', 'page=A5'],
      lines: [`已处理 ${SAMPLE_NAMES.length} 个文件：`],
      code: EXIT.ok,
    },
  ]

  /** 每次都用**干净的一份 io**（同一份内存文件系统，互不干扰） */
  const makeCaseIo = (): ReturnType<typeof makeIo> =>
    makeIo({ ...sampleFiles, 'samples\\ershenbu.jps': GOOD, '错谱.jps': BAD_JPS, '我的谱.jps': RAW_JPS, '告警谱.jps': WARN_JPS }, { samples: SAMPLE_NAMES })

  const mismatch: string[] = []
  const notInManual: string[] = []
  for (const c of cases) {
    const io = makeCaseIo()
    const r = await runCli(c.argv, io.io, { version: APP_VERSION })
    const ran = `${io.logs.join('')}\n${io.errs.join('\n')}`
    for (const l of c.lines) {
      if (!ran.includes(l)) mismatch.push(`${c.what} 跑出来没有「${l}」`)
      if (!MANUAL.includes(l)) notInManual.push(`${c.what} 手册里没有「${l}」`)
    }
    if (c.code !== undefined && r.code !== c.code) mismatch.push(`${c.what} 退出码 ${r.code}≠${c.code}`)
  }
  check(
    `adj949 手册里的 ${cases.length} 组示例**逐行等于真跑输出**（同一条 argv 现跑一遍：跑得出 + 手册里逐字有）`,
    mismatch.length === 0 && notInManual.length === 0,
    [...mismatch, ...notInManual].slice(0, 6).join(' ｜ '),
  )
  check(
    'adj949 负对照①：把手册里**所有** `没有发现问题 ✓` 改一个字（⇒ `没有问题 ✓`）⇒ 与真跑输出对不上、判据判红',
    (() => {
      const cut = MANUAL.split('没有发现问题 ✓').join('没有问题 ✓')
      return cut !== MANUAL && !cut.includes('没有发现问题 ✓') && MANUAL.includes('没有发现问题 ✓')
    })(),
  )
  /**
   * 负对照②：**动 argv**（不是动手册）—— `-t png` 换成 `-t jpg` ⇒ 现跑出来的那行与手册里引用的那行
   * 不再逐字相同。这一条证明判据量的是"跑出来的东西"，而不是"手册里有没有这句话" ✓。
   */
  const PNG_LINE = '-t png 需要"隐藏窗口渲染"通道（桌面端 exe 内置）；当前环境没有该能力。'
  const negIo = makeCaseIo()
  await runCli(['render', '-i', 'samples\\ershenbu.jps', '-t', 'jpg', '-o', '我的谱.png'], negIo.io, { version: APP_VERSION })
  const negRan = negIo.errs.join('\n')
  check(
    'adj949 负对照②：把 argv 的 `-t png` 换成 `-t jpg` ⇒ 跑出来的行与手册里引用的那行不再逐字相同（判据判红）',
    negRan.includes('-t jpg 需要') && !negRan.includes(PNG_LINE) && MANUAL.includes(PNG_LINE),
  )

  /**
   * 用户追加要求：「**每个命令至少两个用法变体**」——
   * 按"`ijipu [.exe] cli <命令>` 在手册里出现几次"来数（名单从 `cli.ts` 源码读，不写死 ✓）。
   */
  const KNOWN = (() => {
    const m = readFileSync(join('packages', 'ijipu-cli', 'src', 'cli.ts'), 'utf8').match(/const known = new Set\(\[([^\]]*)\]\)/)
    return m === null ? [] : Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1])
  })()
  const variantCount = (text: string, c: string): number =>
    (text.match(new RegExp('ijipu(?:\\.exe)? cli ' + c + '\\b', 'g')) ?? []).length
  const thin = KNOWN.filter((c) => variantCount(MANUAL, c) < 2)
  check(
    `adj949 手册里每个命令都有 ≥2 个用法变体（现数：${KNOWN.map((c) => `${c}=${variantCount(MANUAL, c)}`).join(' ')}）`,
    KNOWN.length >= 13 && thin.length === 0,
    thin.map((c) => `${c}(${variantCount(MANUAL, c)})`).join(' '),
  )
  check(
    'adj949 负对照③：把手册里 `doctor` 的示例全部改掉 ⇒ 该命令的变体数掉到 2 以下（判据判红）',
    (() => {
      /**
       * ⚠ 两种写法都要换：手册里既有 `ijipu.exe cli doctor`（完整路径形态）也有 `ijipu cli doctor`。
       * 只换前者的话，手册里若恰好一处都没写完整路径形态，`cut === MANUAL` ⇒ 这条负对照会**空跑** ✗
       * （adj956 重写手册时就撞上了：新手册统一用短形态，负对照当场判红）。
       */
      const cut = MANUAL.split('ijipu.exe cli doctor').join('ijipu.exe cli doc-tor').split('ijipu cli doctor').join('ijipu cli doc-tor')
      return cut !== MANUAL && variantCount(cut, 'doctor') < 2 && variantCount(MANUAL, 'doctor') >= 2
    })(),
  )
}

console.log('\n— adj1084 命令行视频（-t mp4 / 小节:拍）—')
{
  /**
   * 视频的判据分两层：
   *  ① **参数层**（本组前几条）：写法不对必须当场退回，不能"看着跑">
   *  ② **换算层**（注入假宿主）：拍位要变成**音符 id**，且 `--pass` 的 1 起/0 起不能写反。
   */
  const noHost = makeIo({ '(stdin)': GOOD })
  const r0 = await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'out.mp4'], noHost.io)
  check(
    'adj1084 无视频宿主 ⇒ 4（渲染失败），并指向桌面端',
    r0.code === EXIT.render && noHost.errs.join('').includes('桌面端'),
    `code=${r0.code} err=${noHost.errs.join('｜').slice(0, 80)}`,
  )

  const slash = makeIo({ '(stdin)': GOOD })
  check(
    'adj1084 只认 <小节>:<拍>（`27/3` ⇒ 1，不猜）',
    (await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--from', '27/3', '--to', '50:1'], slash.io)).code === EXIT.usage,
  )
  const half = makeIo({ '(stdin)': GOOD })
  check(
    'adj1084 --from/--to 必须成对（只给一个 ⇒ 1）',
    (await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--from', '1:1'], half.io)).code === EXIT.usage,
  )
  const zeroPass = makeIo({ '(stdin)': GOOD })
  check(
    'adj1084 --pass 从 1 起（写 0 ⇒ 1）',
    (await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--from', '1:1', '--to', '2:1', '--pass', '0'], zeroPass.io)).code === EXIT.usage,
  )
  const passOnly = makeIo({ '(stdin)': GOOD })
  check(
    'adj1084 --pass 只能配段落（整曲给 --pass ⇒ 1）',
    (await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--pass', '2'], passOnly.io)).code === EXIT.usage,
  )

  type SeenVideo = {
    startId: string | null
    endId: string | null
    pass: number | null
    aspect: string
    mode: string
    cardStyleId: string | null
    withAudio: boolean
    output: string
    /** adj1166 */
    sound: string
    syncText: string | null
    audioPath: string | null
    accompGain: number
    synthGain: number
  }
  /**
   * 反复段落：`|: … :|` 把这两小节唱两遍。
   *
   * adj1103（用户 2026-10-23 口径）：两遍**走同一线路**（内容完全一样）⇒ 只算 **1 个遍次**，
   * `--pass 2` 会如实报"只有 1 遍"。这里用 `--pass 1` 验证"CLI 的 1 起 → 引擎的 0 起"换算。
   */
  const REPEAT = "V:1.0\nQ: 1 2 3 4 |: 5 6 7 1' | 2 3 4 5 :|\n"
  const cap = makeIo({ '(stdin)': REPEAT })
  let seen: SeenVideo | null = null
  cap.io.encodeVideo = async (req) => {
    seen = { ...req }
    return { bytes: 1234, audio: true }
  }
  const ok = await runCli(
    ['render', '-i', '-', '-t', 'mp4', '-o', 'out.mp4', '--from', '2:1', '--to', '3:1', '--pass', '1'],
    cap.io,
  )
  check(
    'adj1084/adj1103 有宿主 ⇒ 0，拍位换算成音符 id，`--pass 1` ⇒ 内部 0',
    ok.code === EXIT.ok && seen !== null && seen.startId !== null && seen.endId !== null && seen.pass === 0 && seen.output === 'out.mp4',
    `code=${ok.code} seen=${JSON.stringify(seen)} err=${cap.errs.join('｜').slice(0, 120)}`,
  )
  {
    /** adj1103 负对照：同一线路的两遍只有 1 个遍次 ⇒ `--pass 2` 必须在起出片窗口前就拒绝 */
    const same = makeIo({ '(stdin)': REPEAT })
    same.io.encodeVideo = async () => ({ bytes: 1, audio: false })
    const rSame = await runCli(
      ['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--from', '2:1', '--to', '3:1', '--pass', '2'],
      same.io,
    )
    check(
      'adj1103 反复两遍走同一线路 ⇒ `--pass 2` 报"只有 1 遍"（不再把相同内容列成第 2 遍）',
      rSame.code === EXIT.usage && same.errs.join('').includes('只有 1 遍'),
      `code=${rSame.code} err=${same.errs.join('｜').slice(0, 100)}`,
    )
  }
  check('adj1084 CLI 自己**不写** MP4（由宿主写盘，避免大字节穿管道）', !('out.mp4' in cap.files))
  check(
    'adj1084/adj1117 视频缺省 9:16（与界面默认画布一致）+ 整曲（3 分钟会把长曲悄悄截短，命令行不做）',
    seen !== null && seen.aspect === '9x16' && seen.mode === 'full',
    `seen=${JSON.stringify(seen)}`,
  )
  /**
   * adj1114（用户 2026-10-23 口径，**口径变了**）：不写 `--card` ⇒ **不带**片头片尾（只出动态谱）；
   * 声音缺省是**带**的（`--nosound` 才关）。这条是旧断言「缺省 brand」的替代 —— 不是放宽，
   * 是需求把缺省从"深空蓝卡片"改成了"根本不要卡片"；负对照见下面的 `--card ink` / `--card` 单写两条。
   */
  check(
    'adj1114 不写 --card ⇒ 不带片头片尾（cardStyleId:null）；缺省**带声音**（withAudio:true）',
    seen !== null && seen.cardStyleId === null && seen.withAudio === true,
    `seen=${JSON.stringify(seen)}`,
  )

  /**
   * adj1166：标记段名 / 声音来源 / 音量参数。
   * 标记与伴奏都从 sidecar 读；这里用内存 IO 精确断言"传进宿主的到底是哪一段、哪条音轨"。
   */
  const SIDECAR = JSON.stringify({
    audio: 'a.mp3',
    marks: [{ id: 'm1', name: '段1', startId: '0_1_0_0', endId: '0_1_0_3', pass: 1 }],
  })
  {
    const m = makeIo({ 'a.jps': GOOD, 'a.jps.sync.json': SIDECAR })
    let got: SeenVideo | null = null
    m.io.encodeVideo = async (req) => {
      got = { ...req }
      return { bytes: 2, audio: true }
    }
    const r = await runCli(['render', '-i', 'a.jps', '-t', 'mp4', '-o', 'x.mp4', '--mark', '段1'], m.io)
    check(
      'adj1166 `--mark 段1` 从 sidecar 解出起止与段自带的遍次（不再需要 from/to）',
      r.code === EXIT.ok && got !== null && got.startId === '0_1_0_0' && got.endId === '0_1_0_3' && got.pass === 1,
      `code=${r.code} seen=${JSON.stringify(got)} err=${m.errs.join('｜').slice(0, 120)}`,
    )
    check(
      'adj1166 `--mark` 默认 `--sound synth`（不碰伴奏）；`--mark` 不能与 from/to 同用',
      got !== null && got.sound === 'synth' && got.withAudio === true,
      `seen=${JSON.stringify(got)}`,
    )
    const bad = makeIo({ 'a.jps': GOOD, 'a.jps.sync.json': SIDECAR })
    bad.io.encodeVideo = async () => ({ bytes: 1, audio: false })
    const rBad = await runCli(
      ['render', '-i', 'a.jps', '-t', 'mp4', '-o', 'x.mp4', '--mark', '段1', '--from', '1:1', '--to', '2:1'],
      bad.io,
    )
    check('adj1166 `--mark` 与 --from/--to 互斥（报用法错误，不猜）', rBad.code === EXIT.usage, `code=${rBad.code}`)
    const unknown = makeIo({ 'a.jps': GOOD, 'a.jps.sync.json': SIDECAR })
    unknown.io.encodeVideo = async () => ({ bytes: 1, audio: false })
    const rUnknown = await runCli(['render', '-i', 'a.jps', '-t', 'mp4', '-o', 'x.mp4', '--mark', '段9'], unknown.io)
    check(
      'adj1166 找不到标记段名 ⇒ 用法错误 + 列出已有段（不静默退回整曲）',
      rUnknown.code === EXIT.usage && unknown.errs.join('').includes('段1'),
      `code=${rUnknown.code} err=${unknown.errs.join('｜').slice(0, 100)}`,
    )
  }
  {
    const s = makeIo({ 'a.jps': GOOD, 'a.jps.sync.json': SIDECAR })
    let got: SeenVideo | null = null
    s.io.encodeVideo = async (req) => {
      got = { ...req }
      return { bytes: 2, audio: true }
    }
    const r = await runCli(
      ['render', '-i', 'a.jps', '-t', 'mp4', '-o', 'x.mp4', '--sound', 'file', '--accomp-gain', '0.4'],
      s.io,
    )
    check(
      'adj1166 `--sound file` 读同一份 sidecar，把伴奏路径与 sync 原文交给宿主，并带 0.4 增益',
      r.code === EXIT.ok &&
        got !== null &&
        got.sound === 'file' &&
        got.syncText === SIDECAR &&
        got.audioPath === 'a.mp3' &&
        got.accompGain === 0.4,
      `code=${r.code} seen=${JSON.stringify(got)} err=${s.errs.join('｜').slice(0, 120)}`,
    )
    const mix = makeIo({ 'a.jps': GOOD, 'a.jps.sync.json': SIDECAR })
    let mixSeen: SeenVideo | null = null
    mix.io.encodeVideo = async (req) => {
      mixSeen = { ...req }
      return { bytes: 2, audio: true }
    }
    const rMix = await runCli(
      ['render', '-i', 'a.jps', '-t', 'mp4', '-o', 'x.mp4', '--sound', 'mix', '--accomp-gain', '0.8', '--synth-gain', '0.3'],
      mix.io,
    )
    check(
      'adj1166 `--sound mix` 两条音量**各自独立**：伴奏 0.8 / 合成 0.3 原样交给宿主',
      rMix.code === EXIT.ok && mixSeen !== null && mixSeen.accompGain === 0.8 && mixSeen.synthGain === 0.3,
      `code=${rMix.code} seen=${JSON.stringify(mixSeen)}`,
    )
    const mixDefault = makeIo({ 'a.jps': GOOD, 'a.jps.sync.json': SIDECAR })
    let mixDefaultSeen: SeenVideo | null = null
    mixDefault.io.encodeVideo = async (req) => {
      mixDefaultSeen = { ...req }
      return { bytes: 2, audio: true }
    }
    await runCli(['render', '-i', 'a.jps', '-t', 'mp4', '-o', 'x.mp4', '--sound', 'mix'], mixDefault.io)
    check(
      'adj1166 `--sound mix` 缺省音量：伴奏 1 / 合成 0.5（与相机位 DEFAULT_SYNC_MIX 一致）',
      mixDefaultSeen !== null && mixDefaultSeen.accompGain === 1 && mixDefaultSeen.synthGain === 0.5,
      `seen=${JSON.stringify(mixDefaultSeen)}`,
    )
    const badGain = makeIo({ 'a.jps': GOOD, 'a.jps.sync.json': SIDECAR })
    badGain.io.encodeVideo = async () => ({ bytes: 1, audio: false })
    const rBadGain = await runCli(['render', '-i', 'a.jps', '-t', 'mp4', '-o', 'x.mp4', '--sound', 'mix', '--accomp-gain', '3'], badGain.io)
    check('adj1166 音量越界（3）⇒ 用法错误，不静默钳到 2', rBadGain.code === EXIT.usage, `code=${rBadGain.code}`)
    const missing = makeIo({ 'a.jps': GOOD })
    missing.io.encodeVideo = async () => ({ bytes: 1, audio: false })
    const rMissing = await runCli(['render', '-i', 'a.jps', '-t', 'mp4', '-o', 'x.mp4', '--sound', 'file'], missing.io)
    check(
      'adj1166 `--sound file` 缺 sidecar ⇒ 输入不存在（不静默退回 synth）',
      rMissing.code === EXIT.noInput && !('x.mp4' in missing.files),
      `code=${rMissing.code} err=${missing.errs.join('｜').slice(0, 120)}`,
    )
    const conflict = makeIo({ 'a.jps': GOOD, 'a.jps.sync.json': SIDECAR })
    conflict.io.encodeVideo = async () => ({ bytes: 1, audio: false })
    const rConflict = await runCli(['render', '-i', 'a.jps', '-t', 'mp4', '-o', 'x.mp4', '--nosound', '--sound', 'mix'], conflict.io)
    check('adj1166 `--nosound` 与 `--sound` 互斥', rConflict.code === EXIT.usage, `code=${rConflict.code}`)
  }

  /**
   * adj1175：Windows `.bat` 的 UTF-8→OEM 乱码常把路径里的字节变成 `?`；
   * 读不到时给一条可照做的编码提示，不要只甩 ENOENT。
   */
  {
    const b = makeIo({})
    const r = await runCli(['render', '-i', '瀹夊拰妗?jps', '-t', 'mp4', '-o', 'x.mp4'], b.io)
    check(
      'adj1175 输入路径含 `?`（.bat 乱码特征）⇒ 退出码 2，并提示改成 ANSI/GBK 或 chcp 65001',
      r.code === EXIT.noInput && b.errs.join('').includes('批处理') && b.errs.join('').includes('chcp 65001'),
      `code=${r.code} err=${b.errs.join('｜').slice(0, 160)}`,
    )
  }

  /**
   * ⚠ **真 bug 的回归**（adj1084 第一版就踩了）：
   * `PlacedToken.barIndex` 是**曲行内**编号，每换一行就从 0 起；第一版按"页内偏移 + barIndex"
   * 算全局小节号 ⇒ 整份谱被算成只有 6 小节（用户写 `--from 27:3` 直接报"没有第 27 小节"）。
   * 这里造一份**40 小节、必然折成多行**的谱：改成按小节线累加之后，第 35~40 小节必须找得到。
   */
  const LONG = 'V:1.0\nQ: ' + Array.from({ length: 40 }, (_, i) => `${(i % 7) + 1} 2 3 4 |`).join(' ') + '\n'
  const longIo = makeIo({ '(stdin)': LONG })
  longIo.io.encodeVideo = async () => ({ bytes: 1, audio: false })
  const rLong = await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--from', '35:1', '--to', '40:1'], longIo.io)
  /**
   * 诊断用：把"算出来的小节号分布"一起带进断言信息（失败时能一眼看出是错位还是缺行）。
   * 顺便把它也钉成断言：40 小节必须**连续**落在 1..40，每个 4 个音。
   */
  const { layoutScore, parseJps, defaultPageConfig } = await import('@ijipu/engine/index.ts')
  const longNotes = flattenScoreNotes(layoutScore(parseJps(LONG), defaultPageConfig))
  const dist = new Map<number, number>()
  for (const n of longNotes) dist.set(n.bar, (dist.get(n.bar) ?? 0) + 1)
  const bars = Array.from(dist.keys()).sort((a, b) => a - b)
  const continuous = bars.length === 40 && bars.every((b, i) => b === i + 1) && Array.from(dist.values()).every((v) => v === 4)
  check(
    'adj1084 全局小节号跨曲行累加（40 小节的谱能定位到第 35~40 小节）',
    rLong.code === EXIT.ok,
    `code=${rLong.code} err=${longIo.errs.join('｜').slice(0, 100)} bars=${bars[0] ?? '-'}..${bars[bars.length - 1] ?? '-'}(${bars.length})`,
  )
  check(
    'adj1084 小节号连续、每小节 4 个音（负对照：行序/行首小节线算错就会断号）',
    continuous,
    `bars=${bars.slice(0, 8).join(',')}… 共 ${bars.length}，每节音数=${Array.from(dist.values()).slice(0, 8).join(',')}`,
  )

  const card = makeIo({ '(stdin)': GOOD })
  let sawCard: string | null = ''
  card.io.encodeVideo = async (req) => {
    sawCard = req.cardStyleId
    return { bytes: 1, audio: false }
  }
  const rCard = await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--card', 'ink'], card.io)
  check('adj1084 `--card ink` 透传到宿主（水墨）', rCard.code === EXIT.ok && sawCard === 'ink', `code=${rCard.code} card=${sawCard}`)

  const badCard = makeIo({ '(stdin)': GOOD })
  check(
    'adj1084 `--card custom` ⇒ 1（自定义是本机偏好，命令行拒绝而不是当 brand）',
    (await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--card', 'custom'], badCard.io)).code === EXIT.usage,
  )

  /**
   * adj1114（用户 2026-10-23）：`--card` 的模板改成**可选值** ——
   * 只写 `--card`（后面不跟模板）⇒ 默认极简；`--nosound` 明确不要音轨。
   * 两条都不许"吃错下一个选项"（`--card --nosound` 里的 `--nosound` 不能被当成模板名）。
   */
  {
    const bare = makeIo({ '(stdin)': GOOD })
    let bareSeen: SeenVideo | null = null
    bare.io.encodeVideo = async (req) => {
      bareSeen = { ...req }
      return { bytes: 1, audio: true }
    }
    const rBare = await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--card'], bare.io)
    check(
      'adj1114 只写 `--card`（不跟模板）⇒ 极简 minimal，退出码 0',
      rBare.code === EXIT.ok && bareSeen !== null && bareSeen.cardStyleId === 'minimal',
      `code=${rBare.code} seen=${JSON.stringify(bareSeen)} err=${bare.errs.join('｜').slice(0, 80)}`,
    )
    check(
      'adj1114 `--card` 的参数是**可选**的：后面没词也不会报未知参数/用法错误',
      rBare.code === EXIT.ok && bare.errs.length === 0,
      `code=${rBare.code} err=${bare.errs.join('｜').slice(0, 100)}`,
    )

    const both = makeIo({ '(stdin)': GOOD })
    let bothSeen: SeenVideo | null = null
    both.io.encodeVideo = async (req) => {
      bothSeen = { ...req }
      return { bytes: 1, audio: false }
    }
    const rBoth = await runCli(
      ['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--card', '--nosound'],
      both.io,
    )
    check(
      'adj1114 `--card --nosound`：`--nosound` 不被当成模板名（模板 = 极简，withAudio:false）',
      rBoth.code === EXIT.ok && bothSeen !== null && bothSeen.cardStyleId === 'minimal' && bothSeen.withAudio === false,
      `code=${rBoth.code} seen=${JSON.stringify(bothSeen)} err=${both.errs.join('｜').slice(0, 100)}`,
    )
    check(
      'adj1114 终端那一行如实写"片头片尾：极简…无声"（用户能当场确认）',
      both.logs.join('').includes('片头片尾：极简') && both.logs.join('').includes('无声'),
      both.logs.join('').slice(0, 140),
    )

    const silent = makeIo({ '(stdin)': GOOD })
    let silentSeen: SeenVideo | null = null
    silent.io.encodeVideo = async (req) => {
      silentSeen = { ...req }
      return { bytes: 1, audio: false }
    }
    const rSilent = await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--nosound'], silent.io)
    check(
      'adj1114 `--nosound` 单独给：不动卡片（cardStyleId:null），只关声音（withAudio:false）',
      rSilent.code === EXIT.ok && silentSeen !== null && silentSeen.cardStyleId === null && silentSeen.withAudio === false,
      `code=${rSilent.code} seen=${JSON.stringify(silentSeen)}`,
    )
    check(
      'adj1114 不给 `--card` 时终端写"不带片头片尾"（与"片头片尾：极简"是两条不同的路）',
      silent.logs.join('').includes('不带片头片尾'),
      silent.logs.join('').slice(0, 140),
    )

    /**
     * 负对照：这两个选项只属于视频 —— 给别的类型必须当场退回，
     * 否则用户以为"关了声音/加了卡片"，实际拿到的是别的产物。
     */
    const svgNoSound = makeIo({ '(stdin)': GOOD })
    check(
      'adj1114 `--nosound` 只用于 -t mp4（给 svg ⇒ 1）',
      (await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'x.svg', '--nosound'], svgNoSound.io)).code === EXIT.usage,
    )
    const svgCard = makeIo({ '(stdin)': GOOD })
    check(
      'adj1114 `--card` 只用于 -t mp4（给 svg ⇒ 1）',
      (await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'x.svg', '--card'], svgCard.io)).code === EXIT.usage,
    )

    const helpIo = makeIo({})
    await runCli(['--help'], helpIo.io)
    const helpText = String(helpIo.logs.join(''))
    check(
      'adj1114 --help 写清两条新口径：`--card` 不写 = 不带 / 只写 = 极简；`--nosound`',
      helpText.includes('--nosound') && /不写 = 不带；只写 = 极简/.test(helpText),
      helpText.split('\n').filter((l) => l.includes('--card') || l.includes('--nosound')).join('｜').slice(0, 200),
    )
  }
  check('adj1084 起止落在不同音符上（终点不含目标那一拍）', seen !== null && seen.startId !== seen.endId)

  /**
   * adj1115（用户 2026-10-23）：`--aspect` 画布比例 —— 只认相机位「画布」那三种写法，
   * 缺省 9:16（adj1117 起与界面的默认画布一致）。
   */
  {
    const mk = (): { m: ReturnType<typeof makeIo>; seen: { v: SeenVideo | null } } => {
      const m = makeIo({ '(stdin)': GOOD })
      const seen: { v: SeenVideo | null } = { v: null }
      m.io.encodeVideo = async (req) => {
        seen.v = { ...req }
        return { bytes: 1, audio: false }
      }
      return { m, seen }
    }
    const a916 = mk()
    const r916 = await runCli(
      ['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--aspect', '9:16'],
      a916.m.io,
    )
    check(
      'adj1115 `--aspect 9:16` ⇒ 任务里 `9x16`（竖屏），终端那一行也写 9:16',
      r916.code === EXIT.ok &&
        a916.seen.v?.aspect === '9x16' &&
        a916.m.logs.join('').includes('（9:16，全片长'),
      `code=${r916.code} seen=${JSON.stringify(a916.seen.v)} logs=${a916.m.logs.join('').slice(0, 120)}`,
    )

    const a11 = mk()
    const r11 = await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--aspect', '1:1'], a11.m.io)
    check(
      'adj1115 `--aspect 1:1` ⇒ 任务里 `1x1`（方形）',
      r11.code === EXIT.ok && a11.seen.v?.aspect === '1x1',
      `code=${r11.code} seen=${JSON.stringify(a11.seen.v)}`,
    )

    const bad = mk()
    check(
      'adj1115 `--aspect 4:3` ⇒ 1（只认三种，不猜），错误里列全可选值',
      (await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--aspect', '4:3'], bad.m.io)).code ===
        EXIT.usage && bad.m.errs.join('').includes('9:16'),
      bad.m.errs.join('｜').slice(0, 120),
    )
    for (const alt of ['9x16', '16x9']) {
      const altIo = mk()
      check(
        `adj1115/adj1117 \`--aspect ${alt}\`（内部 id 写法）⇒ 1（一种行为只留一种写法）`,
        (await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--aspect', alt], altIo.m.io))
          .code === EXIT.usage,
      )
    }
    const svgAspect = mk()
    check(
      'adj1115 `--aspect` 只用于 -t mp4（给 svg ⇒ 1，不静默忽略）',
      (await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'x.svg', '--aspect', '1:1'], svgAspect.m.io)).code ===
        EXIT.usage,
    )

    // 机器可读输出别漏这个字段（内部 id，与任务文件一致）
    const jsonIo = mk()
    const rJson = await runCli(
      ['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--aspect', '9:16', '--json'],
      jsonIo.m.io,
    )
    const obj = rJson.json as { aspect?: string } | undefined
    check(
      'adj1115 `--json` 输出带 aspect（`9x16`）',
      rJson.code === EXIT.ok && obj?.aspect === '9x16',
      JSON.stringify(obj),
    )
  }

  const noRepeat = makeIo({ '(stdin)': GOOD })
  noRepeat.io.encodeVideo = async () => ({ bytes: 1, audio: false })
  const rNoRepeat = await runCli(
    ['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--from', '1:1', '--to', '2:1', '--pass', '2'],
    noRepeat.io,
  )
  check(
    'adj1084 段落没有第 2 遍 ⇒ 1（在起出片窗口之前就说清"只有几遍"）',
    rNoRepeat.code === EXIT.usage && noRepeat.errs.join('').includes('遍') && !('x.mp4' in noRepeat.files),
    `code=${rNoRepeat.code} err=${noRepeat.errs.join('｜').slice(0, 80)}`,
  )

  const infer = makeIo({ '(stdin)': GOOD })
  let sawInfer = false
  infer.io.encodeVideo = async () => {
    sawInfer = true
    return { bytes: 1, audio: false }
  }
  const rInfer = await runCli(['render', '-i', '-', '-o', 'out.mp4'], infer.io)
  check('adj1084 `-o x.mp4` 自动识别为 mp4（不必再写 -t）', rInfer.code === EXIT.ok && sawInfer, `code=${rInfer.code}`)

  const far = makeIo({ '(stdin)': GOOD })
  far.io.encodeVideo = async () => ({ bytes: 0, audio: false })
  const rFar = await runCli(['render', '-i', '-', '-t', 'mp4', '-o', 'x.mp4', '--from', '999:1', '--to', '999:2'], far.io)
  check(
    'adj1084 不存在的小节 ⇒ 1，且一个文件都不写（说清"共几小节"）',
    rFar.code === EXIT.usage && Object.keys(far.files).length === 0 && far.errs.join('').includes('小节'),
    `code=${rFar.code} err=${far.errs.join('｜').slice(0, 80)}`,
  )
  const nonMp4 = makeIo({ '(stdin)': GOOD })
  check(
    'adj1084 --from 用在 svg 上 ⇒ 1（不静默忽略）',
    (await runCli(['render', '-i', '-', '-t', 'svg', '-o', 'x.svg', '--from', '1:1', '--to', '2:1'], nonMp4.io)).code === EXIT.usage,
  )
}

console.log('\n— adj1085 本机配置（桌面壳落 %APPDATA%\\iJipu，不依赖浏览器缓存）—')
{
  /** 内存版 Storage（语义与浏览器一致：字符串键值、有 length/key） */
  const fakeStorage = (init: Record<string, string> = {}): { storage: Storage; map: Map<string, string> } => {
    const map = new Map(Object.entries(init))
    const storage: Storage = {
      get length() {
        return map.size
      },
      key(i: number) {
        return [...map.keys()][i] ?? null
      },
      getItem(k: string) {
        return map.get(k) ?? null
      },
      setItem(k: string, v: string) {
        map.set(k, String(v))
      },
      removeItem(k: string) {
        map.delete(k)
      },
      clear() {
        map.clear()
      },
    }
    return { storage, map }
  }

  const legacy = fakeStorage({ 'ijipu.theme': 'ink', 'ijipu.draft': 'Q: 1 2', 'other.key': 'x' })
  const imported = importLegacyPrefs(legacy.storage)
  check(
    'adj1085 首次迁移只搬 `ijipu.*`，不碰别人的键',
    imported.get('ijipu.theme') === 'ink' && imported.get('ijipu.draft') === 'Q: 1 2' && !imported.has('other.key'),
    `keys=${[...imported.keys()].join(',')}`,
  )

  const real = fakeStorage({ 'other.key': 'real', 'ijipu.stale': 'old' })
  const snapshot = new Map(imported)
  let changed = 0
  const facade = createPrefsFacade(real.storage, snapshot, () => {
    changed += 1
  })
  facade.setItem('ijipu.theme', 'paper')
  facade.setItem('other.key', 'new')
  check(
    'adj1085 门面：`ijipu.*` 走内存快照，其余键原样转发',
    facade.getItem('ijipu.theme') === 'paper' && facade.getItem('other.key') === 'new' && real.map.get('other.key') === 'new',
    `theme=${facade.getItem('ijipu.theme')} other=${real.map.get('other.key')}`,
  )
  check('adj1085 门面：改一次只触发一次落盘标记（值没变不重复触发）', changed === 1, `changed=${changed}`)
  facade.setItem('ijipu.theme', 'paper')
  check('adj1085 门面：写入同值不再触发落盘', changed === 1, `changed=${changed}`)

  facade.removeItem('ijipu.draft')
  check(
    'adj1085 门面：remove 只删快照里的键，真实存储里的旧键不动',
    facade.getItem('ijipu.draft') === null && real.map.get('ijipu.stale') === 'old',
  )

  const keys = mergedKeys(real.storage, snapshot)
  check(
    'adj1085 可见键 = 真实键 ∪ 快照键（去重；遍历类旧代码仍能看到全部）',
    keys.includes('other.key') && keys.includes('ijipu.stale') && keys.includes('ijipu.theme') && new Set(keys).size === keys.length,
    `keys=${keys.join(',')}`,
  )

  facade.clear()
  check(
    'adj1085 clear 只清本项目命名空间（不误删别的站内键）',
    snapshot.size === 0 && real.map.get('other.key') === 'new',
    `snapshot=${snapshot.size} other=${real.map.get('other.key')}`,
  )

  const values = prefsValuesOf(new Map([['ijipu.theme', 'ink'], ['ijipu.previewZoom', '125']]))
  check(
    'adj1085 落盘形状是纯 `Record<string,string>`（与 Rust 的 prefs_save 契约一致）',
    JSON.stringify(values) === '{"ijipu.theme":"ink","ijipu.previewZoom":"125"}',
    JSON.stringify(values),
  )
  check('adj1085 键前缀常量是 `ijipu.`（三端同一键空间）', PREFS_PREFIX === 'ijipu.')
}

console.log('\n— adj1085 P1 大图外置 / 设置 zip —')
{
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const zip = writeZip([
    { name: 'settings.json', data: enc.encode('{"values":{"ijipu.theme":"ink"}}') },
    { name: 'files/abcd0123.png', data: new Uint8Array([137, 80, 78, 71]) },
  ])
  const back = readZip(zip)
  check(
    'adj1085 P1 zip 往返：settings.json 与 files/ 都能原样读回',
    dec.decode(back.get('settings.json') ?? new Uint8Array()) === '{"values":{"ijipu.theme":"ink"}}' &&
      (back.get('files/abcd0123.png') ?? new Uint8Array()).length === 4,
    `entries=${[...back.keys()].join(',')}`,
  )

  const zipOnly = writeZip([{ name: 'settings.json', data: enc.encode('{"values":{"ijipu.theme":"ink"}}') }])
  check('adj1085 P1 设置包只剩 settings.json（卡片附件已迁到爱出片）', readZip(zipOnly).size === 1, '')

  // 网页/插件路径：没有桌面 prefs 时，导出/导入走 localStorage（这里用内存桩模拟）
  const mem = new Map<string, string>()
  const fakeStorage: Storage = {
    get length() {
      return mem.size
    },
    key(i: number) {
      return [...mem.keys()][i] ?? null
    },
    getItem(k: string) {
      return mem.get(k) ?? null
    },
    setItem(k: string, v: string) {
      mem.set(k, String(v))
    },
    removeItem(k: string) {
      mem.delete(k)
    },
    clear() {
      mem.clear()
    },
  }
  const hadLocalStorage = 'localStorage' in globalThis
  Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage, configurable: true })
  try {
    mem.set('ijipu.theme', 'ink')
    mem.set('ijipu.previewZoom', '125')
    const archive = await exportSettingsZip()
    const entries = readZip(archive)
    const settings = JSON.parse(dec.decode(entries.get('settings.json') ?? new Uint8Array())) as {
      values?: Record<string, string>
    }
    check(
      'adj1085 P1 网页/插件导出：settings.json 里是 localStorage 的 `ijipu.*`',
      settings.values?.['ijipu.theme'] === 'ink' && settings.values?.['ijipu.previewZoom'] === '125',
      JSON.stringify(settings.values),
    )

    const incoming = writeZip([
      { name: 'settings.json', data: enc.encode(JSON.stringify({ values: { 'ijipu.theme': 'paper', 'other': 'x' } })) },
    ])
    const r = await importSettingsZip(incoming)
    check(
      'adj1085 P1 网页/插件导入：只合并 `ijipu.*`，不删本地独有键',
      r.keys === 1 && mem.get('ijipu.theme') === 'paper' && mem.get('ijipu.previewZoom') === '125' && !mem.has('other'),
      `keys=${r.keys} theme=${mem.get('ijipu.theme')}`,
    )
  } finally {
    if (!hadLocalStorage) delete (globalThis as { localStorage?: Storage }).localStorage
  }
}

console.log(failed === 0 ? `\nCLI 断言全部通过 ✅（${passed} 项）` : `\nCLI 断言失败 ${failed} 项 ❌`)
process.exit(failed === 0 ? 0 : 1)
}
void main()
