/**
 * scripts/check-installer.mjs — 打包自检：安装包是否随包带上运行期必需的 DLL（E-2026-134）
 *
 * 背景：本项目用 **GNU 工具链**（`x86_64-pc-windows-gnu`，见 docs/ERRORS-LOG.md E-2026-029），
 * 而 `webview2-com-sys` 只在 `target_env = "msvc"` 时**静态链接** `WebView2LoaderStatic.lib`；
 * GNU 下走**动态** `WebView2Loader.dll` → 必须与 `ijipu.exe` 同目录分发。
 * 0.14.0 之前所有安装包都漏了它（生成的 `installer.nsi` 只 `File` 了 exe），装完启动即报
 * 「找不到 WebView2Loader.dll」。
 *
 * 本脚本读 `tauri build` 生成的 `nsis/x64/installer.nsi`，检查「安装到 $INSTDIR 的文件」清单里
 * 是否包含必需文件——避免下次又漏（`bundle.resources` 被清空、换工具链、换打包目标都会重现）。
 *
 * adj416 增补：内置音源 `generaluser_gs.sf2` 必须随安装包落到安装目录（GNU/任意工具链都一样）——
 * 桌面端试听/导出直接读它（Rust `sf_soundfont_builtin_path`），漏了就会退回联网下载（国内直链不可达）。
 *
 * adj894：随包布局改为 **`soundfonts/`**（用户要求"和 LICENSE 放一起"）⇒ 判定里接受
 * `soundfonts\` 前缀；并**新增一条**：音色库的**许可文件**也必须进安装包 ——
 * 那是分发第三方作品的义务（见 `resources/soundfonts/README.md`），值得机器守住而不是靠自觉。
 *
 * 用法：npm run check:installer（建议紧跟 `npx tauri build` 之后跑）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

/** 必须在安装目录里的文件：[展示名, 在 installer.nsi 中应出现的片段] */
const REQUIRED = [
  ['主程序 ijipu.exe', /!define\s+MAINBINARYSRCPATH\s+"[^"]*ijipu\.exe"/],
  ['WebView2Loader.dll（GNU 工具链下为动态依赖）', /File\s+\/a\s+"\/oname=WebView2Loader\.dll"/],
  /**
   * adj1020（用户 2026-10-21 决定：**去掉随包音色库**）：
   * 安装包里**不再**包含 `generaluser_gs.sf2` 与它的许可 —— 音色库改由
   * 「首次打开时下载 / 资源包安装 / 用户导入」三条路进入 `%APPDATA%\…\soundfonts\`。
   *
   * 所以这里**反过来**要守住"别再把它塞回来"：下面有一组负向判据（见 `assertNoBundledSoundfont`）。
   */
]

/** 打包源文件：[展示名, 路径, 最小字节数]——adj1020 起**不再有音色库源文件**（不随包） */
const SOURCES = []

/**
 * adj945/adj957 **必须随包进安装目录的两份文档**：
 * `[展示名, installer.nsi 里应出现的片段, bundle.resources 的源, bundle.resources 的目标]`。
 *
 * 为什么值得机器守住：
 *  · `LICENSE`（AGPL-3.0 全文）—— 分发本体的义务，**安装目录里必须有**（用户 2026-10 反馈"安装目录好像也没有 LICENSE"）；
 *  · `THIRD-PARTY.md` —— 第三方组件（音色库 / WebView2 / Tauri / QuickJS…）的署名与许可说明。
 * 两者都是**资源映射**（`bundle.resources`）⇒ 判定要**两边一起看**：
 *  ① 打包配置里有这条映射（源 → 目标）；② 生成的 `installer.nsi` 里真有那行 `File /oname=…`。
 * 每条都带**负对照**：把映射从 conf 删掉 / 把 nsi 里那行删掉 ⇒ 同一判据必须**判红** ✓
 * （证明它真的在读配置与清单，而不是恒真 ✗）。
 *
 * ⚠ adj957（用户裁定）：**原先这里还有一条 `docs/iJipu-CLI-手册.md`，已删除**。
 * 用户口径是「那几份 MD 不必随包分发」——命令行手册改走**应用内 `DocDialog`**
 * （与操作手册/语法说明同路），于是随包 MD、`src-tauri/src/cli_manual.rs`、
 * `tauri.conf.json` 的这条映射**一并撤掉**（三处同源，缺一处就会露出"找不到文件"）。
 */
const DOCS_REQUIRED = [
  ['LICENSE（AGPL-3.0 全文，落在安装目录根）', /File\s+\/a\s+"\/oname=LICENSE"/, '../LICENSE', 'LICENSE'],
  ['THIRD-PARTY.md（第三方组件与许可，落在安装目录根）', /File\s+\/a\s+"\/oname=THIRD-PARTY\.md"/, '../THIRD-PARTY.md', 'THIRD-PARTY.md'],
  /**
   * adj946（用户实报）：**命令行入口垫片** `bin\ijipu.cmd`。
   *
   * 为什么必须机器守住：注册进 PATH 的是**安装目录下的 `bin` 目录**（只为实现"cmd 会等批处理
   * 文件"这条 Windows 行为，见 `resources/bin/ijipu.cmd` 的文件头）；垫片一旦不进安装包，
   * 用户终端里 `ijipu` 就找不到（`bin` 里空无一物），而装机时完全看不出来 —— 只有真跑才暴露。
   * 判据与上面三份文档同构：① conf 里有这条映射；② 生成的 `installer.nsi` 里有对应 `File /oname=`；
   * 两条各配一个负对照（删掉映射 / 删掉清单里那行 ⇒ 必须判红 ✓）。
   */
  [
    '命令行入口垫片 bin/ijipu.cmd（注册进 PATH 的 bin 目录里必须有它）',
    /File\s+\/a\s+"\/oname=bin[\\/]ijipu\.cmd"/,
    '../resources/bin/ijipu.cmd',
    'bin/ijipu.cmd',
  ],
]

/** 这两份文档的**仓库源文件**也要在（源没了安装包里自然也没有）
 *  adj957：`docs/CLI-手册.md` 那条已移除（不再随包分发；命令行手册走应用内 DocDialog）。 */
const DOC_SOURCES = [
  ['LICENSE（仓库根，AGPL-3.0 全文）', 'LICENSE', 30_000],
  ['THIRD-PARTY.md（仓库根）', 'THIRD-PARTY.md', 2_000],
  [
    'resources/bin/ijipu.cmd（仓库里那份＝**单一真源**，直接映射进安装包，不复制）',
    'resources/bin/ijipu.cmd',
    500,
  ],
]

/**
 * adj551（用户要求"快捷方式名与备注要记住、下次发布继续保持"）：把这**两条品牌设置**钉成发布前硬校验。
 *
 * 为什么必须钉：桌面/开始菜单快捷方式的**中文名**与**备注**只能由 `nsis/hooks.nsh` 里的
 * `IJIPU_FixShortcuts` 写入（Tauri 模板只会建 `${PRODUCTNAME}.lnk` = `iJipu.lnk`、且**不写备注**）。
 * 这些是**字符串常量**，一旦被改动/漏 include/钩子没被调用，安装包会"看起来正常"但快捷方式退回英文名、
 * 备注丢失——而这类问题只有装到真机才发现（2026-09-21 用户就是这么报的）。
 * 故：① 断言两个常量**逐字**正确；② 断言模板确实 include 了钩子文件；
 *     ③ 断言钩子确实挂在 POSTINSTALL 与 `.onGUIEnd` 两个时机上（GUI 安装的桌面快捷方式是完成页才建的）；
 *     ④ 交叉校验钩子里的 exe 名 / AUMI 与本次构建生成的值一致（防 E-2026-240 那类"名字对不上"）。
 */
const HOOKS = 'src-tauri/nsis/hooks.nsh'
const LNK_NAME = '爱记谱・iJipu.lnk'
const LNK_DESC = '爱记谱 - 码即成，谱自现，代码式简谱制谱引擎。'

const NSI = 'src-tauri/target/release/nsis/x64/installer.nsi'
const SETUP_DIR = 'src-tauri/target/release/bundle/nsis'

if (!existsSync(NSI)) {
  console.error(`[check-installer] 未找到 ${NSI}——请先运行 npx tauri build`)
  process.exit(1)
}
const nsi = readFileSync(NSI, 'utf8')
const hooks = existsSync(HOOKS) ? readFileSync(HOOKS, 'utf8') : ''

let failed = 0
console.log('[check-installer] 安装包必需文件自检：')
for (const [label, re] of REQUIRED) {
  const ok = re.test(nsi)
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failed++
}

console.log('[check-installer] 快捷方式（中文名 + 备注）自检：')
{
  const bundleId = (nsi.match(/!define BUNDLEID "([^"]+)"/) ?? [])[1] ?? ''
  const mainExe = (nsi.match(/!define MAINBINARYNAME "([^"]+)"/) ?? [])[1] ?? ''
  const checks = [
    ['钩子文件存在且含快捷方式函数', hooks.includes('Function IJIPU_FixShortcuts')],
    [`快捷方式名逐字正确（${LNK_NAME}）`, hooks.includes(`!define IJIPU_LNK_NEW "${LNK_NAME}"`)],
    [`快捷方式备注逐字正确（${LNK_DESC}）`, hooks.includes(`!define IJIPU_LNK_DESC "${LNK_DESC}"`)],
    ['模板已 include 该钩子文件', /!include\s+"[^"]*nsis[\\/]hooks\.nsh"/.test(nsi)],
    ['钩子挂在 NSIS_HOOK_POSTINSTALL', (hooks.match(/macro NSIS_HOOK_POSTINSTALL/g) ?? []).length === 1 && nsi.includes('!insertmacro NSIS_HOOK_POSTINSTALL')],
    ['钩子挂在 .onGUIEnd（GUI 安装的桌面快捷方式是完成页才建的）', hooks.includes('Function .onGUIEnd') && hooks.includes('Call IJIPU_FixShortcuts')],
    ['钩子里的主程序名与本构建一致', hooks.includes(`!define IJIPU_EXE "${mainExe}.exe"`)],
    ['钩子里的 AUMI 与本构建 identifier 一致', hooks.includes(`!define IJIPU_AUMI "${bundleId}"`)],
  ]
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
    if (!ok) failed++
  }
  if (hooks) console.log(`  · 名称 ${LNK_NAME} / 备注 ${LNK_DESC}`)
}

console.log('[check-installer] 打包源文件自检：')
for (const [label, path, minBytes] of SOURCES) {
  const ok = existsSync(path) && statSync(path).size >= minBytes
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? `  ${Math.round(statSync(path).size / 1024)}KB` : '（缺失或体积不足）'}`)
  if (!ok) failed++
}

/**
 * adj945：**随包进安装目录的文档** + 每条判据的**负对照**（见上方 `DOCS_REQUIRED` 的说明）。
 * adj957：CLI 手册那条已撤（不再随包分发，见 `DOCS_REQUIRED` 的说明）。
 */
console.log('[check-installer] 随包文件（adj945：LICENSE / THIRD-PARTY.md；adj946：命令行入口垫片 bin/ijipu.cmd）自检：')
{
  const confPath = 'src-tauri/tauri.conf.json'
  const conf = JSON.parse(readFileSync(confPath, 'utf8'))
  const res = conf.bundle?.resources ?? {}
  /** 反斜杠统一成 `/`：conf 里写 `../LICENSE`、nsi 里写 `LICENSE`，比较时不能各算一套 */
  const norm = (p) => String(p).split('\\').join('/')
  const confHas = (map, source, target) =>
    Object.entries(map).some(([s, t]) => norm(s).endsWith(source) && norm(t) === norm(target))
  /** 判据的**可判假性**：把清单里所有命中的行删掉后，同一个正则必须**不再命中** ✓ */
  const falsifiable = (text, re) => {
    const stripped = text
      .split('\n')
      .filter((l) => !re.test(l))
      .join('\n')
    return stripped !== text && !re.test(stripped)
  }
  for (const [label, re, source, target] of DOCS_REQUIRED) {
    const inNsi = re.test(nsi)
    const inConf = confHas(res, source, target)
    console.log(`  ${inNsi && inConf ? '✓' : '✗'} ${label}`)
    console.log(
      `      · 打包配置 ${confPath}：${inConf ? `有映射 ${source} → ${target}` : `**缺映射** ${source} → ${target}`}` +
        `｜安装清单 installer.nsi：${inNsi ? '有对应的 File /oname=' : '**缺** File /oname='}`,
    )
    if (!(inNsi && inConf)) failed++
    const confCut = Object.fromEntries(Object.entries(res).filter(([, t]) => norm(t) !== norm(target)))
    const negConf = !confHas(confCut, source, target)
    const negNsi = falsifiable(nsi, re)
    console.log(
      `      · 负对照：把这**条映射从 conf 删掉** ⇒ ${negConf ? '判红 ✓' : '仍为真 ✗（判据无效）'}` +
        `｜把**清单里那行删掉** ⇒ ${negNsi ? '判红 ✓' : '仍为真 ✗（判据无效）'}`,
    )
    if (!(negConf && negNsi)) failed++
  }
  console.log('[check-installer] 随包文件的仓库源文件自检：')
  for (const [label, path, minBytes] of DOC_SOURCES) {
    const ok = existsSync(path) && statSync(path).size >= minBytes
    console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? `  ${Math.round(statSync(path).size / 1024)}KB` : '（缺失或体积不足）'}`)
    if (!ok) failed++
  }
  // 上一条判据的**负对照**：同一个判据喂一个不存在的路径必须为假（证明它真在读文件）
  const existsOk = (p, min) => existsSync(p) && statSync(p).size >= min
  console.log(
    `  · 负对照（源文件判据）：不存在的路径 ⇒ ${!existsOk('docs/__NEVER_EXISTS__.md', 1) ? '判红 ✓' : '仍为真 ✗'}` +
      `｜已存在的路径 ⇒ ${existsOk('LICENSE', 30_000) ? '判真 ✓' : '判红 ✗（说明判据失效）'}`,
  )
  if (existsOk('docs/__NEVER_EXISTS__.md', 1) || !existsOk('LICENSE', 30_000)) failed++
}

/**
 * adj1020（用户 2026-10-21：**去掉随包音色库**）：反向判据 —— 安装包**不许**再带音色库。
 *
 * 为什么值得机器守住：随包撤掉后，若哪天有人顺手把映射加回 `bundle.resources`，
 * 安装包会悄悄变大 32 MB、而"首次为空、需要下载"的新口径又被打回旧行为——两边都没提示。
 */
console.log('[check-installer] 反向判据：音色库**不随包**（adj1020）：')
{
  const confPath = 'src-tauri/tauri.conf.json'
  const conf = JSON.parse(readFileSync(confPath, 'utf8'))
  const res = conf.bundle?.resources ?? {}
  const hitConf = Object.entries(res).filter(([src, dst]) =>
    /generaluser_gs\.sf2|LICENSE-GeneralUserGS|soundfonts[\\/]README\.md/i.test(`${src} ${dst}`),
  )
  const hitNsi = /generaluser_gs\.sf2|LICENSE-GeneralUserGS/i.test(nsi)
  console.log(`  ${hitConf.length === 0 && !hitNsi ? '✓' : '✗'} 打包配置与 installer.nsi 都不含音色库文件`)
  if (hitConf.length > 0) console.log(`      · 仍在 conf 里：${hitConf.map(([s]) => s).join(', ')}`)
  if (hitConf.length > 0 || hitNsi) failed++
}

/**
 * adj942（用户裁定「直接落，修」·路线②）：**`ijipu.exe` 内置了 CLI** ——
 * 这就是"用户不必装 Node 也能用命令行"的交付物本身，所以值得机器守住。
 *
 * 怎么核对（**不需要跑 exe** ✓）：`include_bytes!` 是把产物**逐字节**放进 exe 的 ⇒
 * 在 exe 里一定找得到产物里的标志串。三条一起看才可信：
 *   ① 内嵌产物存在且**像真产物**（体积下限 —— `build.rs` 的占位只有几百字节 ✗ 会被拦下）；
 *   ② exe 里找得到 `__ijipuCliMain`（内嵌入口）与 `__ijipuHost`（宿主接口）；
 *   ③ exe 的 mtime **不早于**产物 ⇒ 打包前**重生成过**产物
 *      （防"先打包、后重生成产物"，与 `E-2026-374` 同族：产物会冻在生成那一刻）。
 * 另配两条负对照：同一个搜索找"一定不存在的标志"必须为假、Node 版产物里不该有这个标志
 * （证明它真在区分"两种产物/有没有内嵌"，而不是恒真 ✗）。
 */
const EMBED_JS = 'packages/ijipu-cli/dist/ijipu-embed.js'
const RELEASE_EXE = 'src-tauri/target/release/ijipu.exe'
const NODE_BUNDLE = 'packages/ijipu-cli/dist/ijipu.cjs'
const EMBED_MIN_BYTES = 50 * 1024

console.log('[check-installer] 内嵌 CLI（adj942：命令行编进 exe）自检：')
{
  const contains = (path, needle) => {
    if (!existsSync(path)) return false
    return readFileSync(path).includes(Buffer.from(needle, 'utf8'))
  }
  const embedSize = existsSync(EMBED_JS) ? statSync(EMBED_JS).size : 0
  const exeSize = existsSync(RELEASE_EXE) ? statSync(RELEASE_EXE).size : 0
  const fresh = embedSize > 0 && exeSize > 0 && statSync(RELEASE_EXE).mtimeMs >= statSync(EMBED_JS).mtimeMs
  const checks = [
    [`内嵌 CLI 产物存在且不是占位（${EMBED_JS} ≥ ${Math.round(EMBED_MIN_BYTES / 1024)}KB）`, embedSize >= EMBED_MIN_BYTES],
    [`exe 里带着内嵌 CLI 入口（找得到 __ijipuCliMain）`, contains(RELEASE_EXE, '__ijipuCliMain')],
    [`exe 里带着宿主接口（找得到 __ijipuHost）`, contains(RELEASE_EXE, '__ijipuHost')],
    [`exe 不比内嵌产物旧（打包前重生成过产物）`, fresh],
    ['负对照①：同一个搜索找"一定不存在"的标志必须为假', !contains(RELEASE_EXE, '__ijipuCliMain_NEVER_EXISTS__')],
  ]
  /**
   * ⚠ 负对照②依赖 **Node 版产物**（`dist/ijipu.cjs`），而它**只有 `npm run cli:build` 才产出**——
   * `tauri build` 只跑 `cli:embed`（内嵌版）⇒ **干净克隆直接打包时它并不存在**（实测踩到：
   * 这条把"全部通过"判成了 ✗）。所以：**有才做这条**，没有就如实说明"跳过"（不当成通过 ✓ 也不误判 ✗）。
   */
  if (existsSync(NODE_BUNDLE)) {
    checks.push([
      '负对照②：Node 版产物（dist/ijipu.cjs）里**不该**有这个标志（两种产物分得开）',
      contains(NODE_BUNDLE, '#!') && !contains(NODE_BUNDLE, '__ijipuCliMain'),
    ])
  } else {
    console.log('  · 负对照②**跳过**：没有 dist/ijipu.cjs（`tauri build` 不产它；跑过 `npm run cli:build`/`smoke` 才有）')
  }
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
    if (!ok) failed++
  }
  console.log(`  · exe ${Math.round(exeSize / 1024)}KB ／ 内嵌产物 ${Math.round(embedSize / 1024)}KB`)
}

/**
 * adj944（用户需求「只有注册后，打开终端就能 ijipu cli」）：**卸载时自动解除 PATH 注册**的接线自检。
 *
 * 为什么值得机器守住：这段只出现在**卸载器**里，装机时完全看不出来 —— 漏了要等用户卸载完
 * 才发现"PATH 里留了一条指向空目录的项"（而且那时已经不好查了）。三条一起看：
 *   ① 钩子文件 `cli-path.nsh` 真的存在、含两个 `un.` 函数（卸载段里只能 `Call un.` 开头的 ✗ 否则编译不过）；
 *   ② `hooks.nsh` 既 `!include` 了它、又在卸载钩子里 `!insertmacro IJIPU_PATH_UNREGISTER`；
 *   ③ **`nsis/*.nsh` 都带 UTF-8 BOM** —— 这两个文件含中文，makensis 对"无 BOM 又含非 ASCII 字节"
 *      的脚本直接报 `Bad text encoding` 拒绝编译（实测踩到过），所以它是个硬前提 ✓。
 */
console.log('[check-installer] 卸载自动解除 PATH 注册（adj944）自检：')
{
  const CLI_PATH_NSH = 'src-tauri/nsis/cli-path.nsh'
  const cliPath = existsSync(CLI_PATH_NSH) ? readFileSync(CLI_PATH_NSH, 'utf8') : ''
  const hasBom = (p) => existsSync(p) && readFileSync(p).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  const checks = [
    [`钩子文件存在且含卸载用的两个函数（${CLI_PATH_NSH}）`,
      cliPath.includes('Function un.IJIPU_PathDropDir') && cliPath.includes('Function un.IJIPU_EnvValueType')],
    ['摘除逻辑按原值类型写回（`%USERPROFILE%` 这类变量不会被写坏）', cliPath.includes('WriteRegExpandStr')],
    ['App Paths 只删指向我们的那条（不是我们写的不动）', cliPath.includes('IJIPU_APP_PATHS_KEY') && cliPath.includes('DeleteRegValue')],
    ['`hooks.nsh` 已 include 该文件', hooks.includes('cli-path.nsh')],
    ['`hooks.nsh` 的卸载钩子里插了 `IJIPU_PATH_UNREGISTER`',
      hooks.includes('!insertmacro IJIPU_PATH_UNREGISTER') &&
        (hooks.match(/macro NSIS_HOOK_POSTUNINSTALL/g) ?? []).length === 1],
    ['更新流程不摘 PATH（受 `$UpdateMode <> 1` 保护，否则"更新一次丢一次注册"）',
      /\$\{If\}\s+\$UpdateMode\s+<>\s+1[\s\S]{0,400}!insertmacro IJIPU_PATH_UNREGISTER/.test(hooks)],
    [`${CLI_PATH_NSH} 带 UTF-8 BOM（makensis 对含中文的脚本硬要求）`, hasBom(CLI_PATH_NSH)],
    ['`hooks.nsh` 带 UTF-8 BOM', hasBom(HOOKS)],
  ]
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
    if (!ok) failed++
  }
}

if (existsSync(SETUP_DIR)) {
  const files = readdirSync(SETUP_DIR).filter((f) => f.endsWith('.exe'))
  if (files.length === 0) {
    console.log('  ✗ bundle/nsis 下没有安装包产物')
    failed++
  } else {
    for (const f of files) {
      console.log(`  · ${f}  ${Math.round(statSync(`${SETUP_DIR}/${f}`).size / 1024)}KB`)
    }
  }
}

if (failed > 0) {
  console.error(
    `\n[check-installer] ${failed} 项缺失：安装后会缺文件。\n` +
      '  修复：确认 src-tauri/tauri.conf.json 的 bundle.resources 含\n' +
      '  { "target/release/WebView2Loader.dll": "WebView2Loader.dll" }（GNU 工具链时必需）\n' +
      '  { "../LICENSE": "LICENSE" } / { "../THIRD-PARTY.md": "THIRD-PARTY.md" } / { "../resources/bin/ijipu.cmd": "bin/ijipu.cmd" }\n' +
      '  ⚠ adj1020 起音色库**不随包**：不要再把 generaluser_gs.sf2 加回 bundle.resources。',
  )
  process.exit(1)
}
console.log('[check-installer] 全部通过 ✓')
