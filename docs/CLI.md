# iJipu 命令行（CLI）操作手册

> ⚠ **这份是"给改代码的人看"的设计口径与维护说明**（方案、协议、实现约定）。
> **面向使用者**的《命令集与使用示例手册》在 **`docs/CLI-手册.md`**（`adj945` 起）。
> 两边分工：**怎么用**看那一份，**为什么这么做/怎么维护**看这一份。
> `adj957`（**用户裁定**）起那份手册**不再随安装包分发**（原先映射成安装目录的
> `docs/iJipu-CLI-手册.md`、由应用「全局 → 命令行 → 查看 CLI 手册」按钮用系统默认程序打开）——
> 理由与替代路径见 §二之三。它现在的三个入口都是**应用内渲染**（顶栏「帮助」下的
> 操作手册 / 脚本语法说明 / 命令行手册，同一份 `docs/CLI-手册.md`）。
> `adj949`（用户要求"手册的目的是告诉用户有什么和怎么用，不是为什么和原理、实现"）把这条分界线
> 变成了**机器闸门**：`docs/CLI-手册.md` 里不许出现一组"实现/原理"词（`QuickJS` / **命名管道** /
> `AttachConsole` / **OEM 代码页** / `fs.watch` / 设计取舍 …），而这些词必须**仍在本文件里** ——
> 成对断言 + 负对照在冒烟 `adj949`；被移出来的内容在本文件 §一之三 有索引。
>
> 方案与决策见 `docs/CLI-AND-COMMAND-PLAN.md`（**① 同一个 exe 带子命令 ② 位图/音频走隐藏窗口渲染
> ③ 嵌入版 RPC 默认关闭 + 仅 vault 内路径**）。
> 阶段状态：**P1–P4 全部实现**（`format` / `lint` / `info` / `render` / `play` / `batch` /
> `settings` / `config` / `doctor` / `completions` / `lint --watch`）；
> adj944 起另有 **`register` / `unregister` / `status`**（把**命令行入口目录 `<安装目录>\bin`**
> 注册进当前用户 PATH ⇒ 终端里直接敲 `ijipu`，见 §二之二；`adj946` 起那个 `bin` 目录里是
> **控制台垫片** `ijipu.cmd` —— 见 §一之一）。
> 其中**位图与音频**（`png/jpg/pdf/wav`）需要"隐藏窗口渲染"通道：在桌面端 exe 内可用 ✓，
> 独立 Node 环境会**明确报错（退出码 4）**并给出替代（`-t svg` / `-t midi`）✓ —— 不假装成功 ✗。

## 一、怎么运行

命令行有**两条交付路径**，跑的是**同一份命令逻辑**（`packages/ijipu-cli/src/cli.ts` 的
`runCli(argv, io)` ✓）—— 差别只在"谁提供 IO、谁提供引擎"。

### 甲、随应用发布：`ijipu cli <命令>`（`adj942` 起；`adj946` 起有**控制台垫片**；**不需要装 Node**）

装了 iJipu 就有命令行。形态是**明确的子命令 `cli`**（不是裸参数）。
命令行入口是**控制台垫片** `bin\ijipu.cmd`（注册 PATH 之后就是一个 `ijipu`，见 §一之一/§二之二）：

```powershell
ijipu cli --version                                  # iJipu 0.79.0
ijipu cli --help                                     # 完整的命令/选项清单
ijipu cli lint -i 我的谱.jps                         # 有错 ⇒ 退出码 3
ijipu cli render -i 我的谱.jps -t svg -o 我的谱.svg
ijipu cli render -i 我的谱.jps -t midi -o 我的谱.mid
```

> **没注册 PATH 时**用垫片的完整路径，效果一样：
> `"%LOCALAPPDATA%\iJipu\bin\ijipu.cmd" cli lint -i 我的谱.jps` ✓
> （**别**直接调 `ijipu.exe`：GUI 子系统程序，cmd 不等它 ⇒ 输出顺序/退出码/重定向都不可靠 ✗，
> 理由见 §一之一。）

- **原理**：那段 JS（引擎 + CLI 逻辑）在**编译期**被 `include_bytes!` 打进 `ijipu.exe`，
  运行时由**内嵌的 QuickJS**（`rquickjs`）执行；文件读写 / stdin / stdout 由 Rust 侧注入
  （**不在 QuickJS 里硬造 `node:fs`** ✓）。⇒ 用户**不必装 Node**，也不用额外下载任何东西。
  构建：`npm run cli:embed`（`npm run build` 与 `tauri build` 都会串它 ✓）。
  这条**内嵌运行时**路线是一次**设计取舍**：用户给的对照是"只放 `.cjs` +0.18MB（LZMA 折算）／
  带 `node.exe` +21.97MB／pkg 单文件 exe +15.27MB"，而内嵌运行时 + JS 实测合计 **+0.69MB**
  （体积与耗时的逐项实测见 §一之二）✓。
- ⚠ **与"双击 `.jps` 打开界面"不冲突**：判据是**第一个参数恰为 `cli`**
  （`ijipu.exe 我的谱.jps` / 双击关联 / `ijipu.exe --help` **全都照旧进 GUI** ✓）。
  这条有 Rust 单测钉着（`src-tauri/src/cli_embed.rs` 的 `split_cli_args`，`npm run test:rust` 里跑）。
- ⚠ **控制台输出**：`ijipu.exe` 是 **GUI 子系统**程序（双击不弹黑框），所以启动时会
  `AttachConsole(ATTACH_PARENT_PROCESS)` 挂到**调用它的那个终端**上（挂不上才 `AllocConsole` 自己开一个）；
  **重定向到文件 / 管道照常工作**（那种情况下把原始 **UTF-8 字节**写进去，与 Node 版逐字节同口径 ✓）。
  中文在真控制台上走 `WriteConsoleW`（UTF-16）⇒ 不受控制台代码页影响 ✓。
  ⚠⚠ **但"GUI 子系统 exe 兼做命令行"这件事本身有 Windows 层面的坑**（cmd 不等 GUI 程序）——
  用户 2026-10 实报（有截图）：在 cmd 里输出**每一行前面都多一个提示符**、退出码拿不到、
  PowerShell 的 `>` 写出 0 字节文件。**`adj946` 起用控制台垫片解决**（见 §一之一），
  所以**命令行入口请走 `bin\ijipu.cmd`（或注册后的 `ijipu`）**，不要直接调 `ijipu.exe` ✗。
- ⚠ **内嵌版没有"位图/音频/监视"能力**：`render -t png|jpg|pdf`、`play -t wav` 需要"隐藏窗口渲染"通道
  （**与独立 Node 环境同一口径**）⇒ 如实报错、退出码 4；`lint --watch` 需要宿主的文件监视能力，
  内嵌版不注入 ⇒ 退出码 1（**独立 Node 包可用** ✓，见 §二）。都不产半成品 ✗（通道状态见 §七之二 / §七之三）。
  **视频是例外**（`adj1084`）：`render -t mp4` 由宿主**另起一个隐藏窗口**去编（见 §二之一），
  所以内嵌版能出片；独立 Node 包没有这条通道，仍然退出码 4。
- ⚠ 退出码与 Node 版**完全一致**（§四）；唯一的例外是**接线层自身**出错（引擎加载失败等）⇒ 退出码 **70**
  并把原因打到 stderr（这类不是"用法错误"，刻意与 0–5 区分开 ✓）。

### §一之一、控制台垫片 `bin\ijipu.cmd`（`adj946`，**命令行入口只走它**）

**为什么要它**（用户 2026-10 实报 + 截图）：`ijipu.exe` 是 GUI 子系统程序 ⇒
**cmd 不等它**（Windows 固有行为，`code.exe`/`sublime_text.exe` 也一样）⇒ 四连带症状：
① 输出**跟在下一个提示符后面**；② `%ERRORLEVEL%` / `$LASTEXITCODE` 是旧值；
③ PowerShell 的 `>` 写出 **0 字节**文件；④ 输出顺序不可靠。
`adj945` 只在文档里写成"注意事项"让用户绕 ✗（用户认为不可接受）；`adj946` 照 VS Code 的成熟做法修：

| 项 | 口径 |
|---|---|
| 交付物 | `resources/bin/ijipu.cmd`（**单一真源**，经 `bundle.resources` 映射成安装目录的 `bin/ijipu.cmd`，**不复制** ✓） |
| 内容 | **可执行段只有两行**：`"%~dp0..\ijipu.exe" %*` + `exit /b %ERRORLEVEL%`（冒烟 `adj946` 逐字钉住） |
| 为什么是**直接调用** | **实测**（2026-10-14，Windows 11 26300.9457，cmd 代码页 936）：直接调用 ⇒ 重定向文件 89 字节、退出码 3 ✓；`start /wait "" … %*` ⇒ **0 字节**（`start` 不给子进程传重定向句柄）✗。cmd **会等批处理文件**，所以直接调用就是同步的 |
| 为什么不加 `cli` | **实测**：垫片若写成 `ijipu.exe cli %*`，用户敲的 `ijipu cli lint …` 会变成 `ijipu.exe cli cli lint …`（报「命令 "cli" 尚未实现」✗）⇒ 垫片**透明**转交 `%*` |
| 为什么注释纯 ASCII | cmd 按 **OEM 代码页**（本机 936）解析 `.cmd`；UTF-8 中文注释在 DBCS 页上可能错位，而垫片坏掉＝命令行全坏（`scripts/git-push.bat` 的 "ASCII safe" 同一原因）。冒烟 `adj946` 钉住"纯 ASCII + 无 BOM" |
| 用户 `.bat` 里的中文 | 同理：cmd 按 OEM 代码页解析**用户的批处理文件**，UTF-8 中文在进入 CLI 前就变成乱码（常带 `?`）。终端直接敲是 Unicode 输入，所以不犯。处置：`.bat` 存 ANSI/GBK，或首行 `chcp 65001` + UTF-8 无 BOM；最稳是 `.bat` 不写中文，用 `for %%f in (*.jps)` 从目录取真实文件名（见 `CLI-手册` §2.6） |
| 注册口径 | 注册进 PATH 的是 **`<安装目录>\bin`**（不是安装目录本身 ✗）—— 由 TS `binDirOf()` **唯一一处**推导；`.CMD` 在 `PATHEXT` 里、`.exe` 不在 PATH 里 ⇒ 敲 `ijipu` 命中垫片 ✓ |
| 双击/关联 | **不受影响**：`ijipu.exe` 仍是 GUI 子系统程序（双击 `.jps` / 关联打开照旧开窗口、不闪黑框 ✓） |
| 旧形态兼容 | `adj944` 曾注册"安装目录本身"：`status` 认出它（`legacy`，并按**未注册**报）→ 点「注册」**顺手换掉**；`unregister` **两种都摘**；卸载钩子（`nsis/cli-path.nsh`）也**两条都摘** ✓ |
| 闸门 | 冒烟 `[172] adj946`（垫片可执行段逐字/纯 ASCII 无 BOM/`binDirOf`/旧形态迁移/文案/NSIS/文档，每条配负对照）+ `cli-assert` 的 register/status/unregister + `check-installer` 的"安装清单必须含 `bin\ijipu.cmd`" |

### 乙、独立 Node 包 `@ijipu/cli`（给 CI / 没装应用的环境）

CLI 也是一个**独立的 Node 包**（`packages/ijipu-cli`，包名 `@ijipu/cli`，命令名 `ijipu`）：
引擎源码已打进单文件产物，运行期**零依赖** ✓。

```powershell
# ① 开发/CI（本仓库内，改完源码立刻跑）：
npm run cli -- <命令> [选项]         # = npm run cli:build && node packages/ijipu-cli/dist/ijipu.cjs …

# ② 直接跑已构建产物：
node packages/ijipu-cli/dist/ijipu.cjs <命令> [选项]

# ③ 当成普通命令行工具装（不需要装 iJipu 应用）：
npm run cli:build                     # 先出产物
npm i -g ./packages/ijipu-cli         # 装好后命令名就是 ijipu
ijipu --help
```

> **两条路径怎么选**：装了桌面版 ⇒ 用甲（`ijipu.exe cli …`，零依赖 ✓）；
> 只有 Node（CI、服务器、只写谱不装应用的人）⇒ 用乙。
> 需要 canvas / 音频的两类输出（`render -t png|jpg|pdf`、`play -t wav`）两条路径**都**要由
> **桌面端应用**提供能力，这条通道的落地见 §七之二（**尚未接线**：现在会如实报退出码 4 ✓）。

### §一之二、内嵌版怎么调、什么前提、代价多少（`adj942` 实测）

**前提**：装过 iJipu（`ijipu.exe` 就在安装目录里）。**不需要** Node、不需要联网、不需要额外文件。

**调用形态**。⚠ `ijipu.exe` 是 **GUI 子系统**程序（双击 `.jps` 不开黑框的代价就是它），
而 **cmd / PowerShell 都不会等 GUI 子系统程序** —— 这是 Windows 的固有行为，不是本 CLI 的 bug。

`adj946` 起这件事**已经修好**：命令行入口是**控制台垫片** `bin\ijipu.cmd`（命令行入口只走它，
见 §一之一）。**注册之后**（`ijipu cli register`）PATH 里就是那个 `bin` 目录 ⇒ 下面这一行**全都正常**：

```text
ijipu cli lint -i 我的谱.jps          # 输出紧跟命令、%ERRORLEVEL% / $LASTEXITCODE 是真值
ijipu cli lint -i 我的谱.jps > out.txt # cmd 与 PowerShell 的 > 都写出正常内容（不再是 0 字节）
```

| shell 写法 | 输出 | 退出码 |
|---|---|---|
| `ijipu cli lint -i 谱.jps`（垫片，注册之后 ✓ **推荐**） | ✓ 紧跟在自己那条命令后面 | ✓ `%ERRORLEVEL%` / `$LASTEXITCODE` |
| `ijipu cli lint -i 谱.jps > out.txt`（cmd 或 PowerShell） | ✓ 真写进文件（UTF-8） | ✓ |
| `"%LOCALAPPDATA%\iJipu\bin\ijipu.cmd" cli lint -i 谱.jps`（**没注册**时用完整路径） | ✓ 同上 | ✓ |
| `"%LOCALAPPDATA%\iJipu\ijipu.exe" cli lint -i 谱.jps`（**直呼 exe** ✗） | ✗ 提示符会夹在输出中间 | ✗（shell 没等它，拿到的是旧值） |
| `…\ijipu.exe cli lint -i 谱.jps > out.txt`（**直呼 exe**，PowerShell 的 `>`） | ✗ **文件会是 0 字节** | ✗ |
| `Start-Process …\ijipu.exe -ArgumentList 'cli','lint','-i','谱.jps' -Wait -PassThru -NoNewWindow`（绕过垫片的老办法） | ✓（要 `-NoNewWindow`） | ✓ `$p.ExitCode` |

> **结论**：命令行一律走 `ijipu cli …`（垫片）；**不要直接调 `ijipu.exe`** ✗ ——
> 上表最后三行就是"直呼 exe"的代价（`adj946` 之前只能这么绕，现在不必了）。
> 注意垫片是**透明**的：它不替你补 `cli` 子命令（补了会变成 `ijipu.exe cli cli …`，
> 实测报「命令 "cli" 尚未实现」✗），所以形态仍是 `ijipu cli <命令>`。

**实测：体积**（同一次 `tauri build`；⚠ NSIS 安装包**同一输入两次打包也会抖 ~2KB**：本轮三次打包分别为
34,545,493 / 34,548,670 / 34,550,872 B，下表取中间那次作代表）：

| 项 | 改前（v0.58.0，无内嵌命令行） | 改后（v0.59.0 起） | 增量 |
|---|---|---|---|
| 安装包 `iJipu_0.58.0_x64-setup.exe` | 33,824,416 B（32.26 MB） | **34,545,493 ~ 34,550,872 B**（32.95 MB） | **+0.69 ~ +0.72 MB** ✓ |
| `ijipu.exe` 本体 | 26,107,801 B（24.90 MB） | 28,371,423 ~ 28,371,668 B（27.06 MB） | +2.16 MB（未压缩） |
| 其中：内嵌 JS 产物 | — | 196,873 B（192 KiB；gzip 71 KiB） | — |
| 其中：QuickJS 目标文件 | — | 4.6 MB（编译产物，链进 exe） | — |

> 对照（用户给的实测）：只放 `.cjs` **+0.18MB**（LZMA 折算）｜带 `node.exe` **+21.97MB**｜
> pkg 单文件 exe **+15.27MB** ⇒ 内嵌 QuickJS + JS = **+0.69MB**，落在"0.5~1MB 量级"的目标内 ✓。

**实测：耗时**（同一台机器；内嵌 = `ijipu.exe cli …`、Node = `node dist/ijipu.cjs …`；各跑 3 次，贴原始值）：

| 谱 | `lint`（内嵌 ／ Node） | `render -t svg`（内嵌 ／ Node） |
|---|---|---|
| `samples/ershenbu.jps`（17 行） | 137 / 86 / 85 ms ／ 161 / 152 / 158 ms | 92 / 94 / 90 ms ／ 181 / 182 / 182 ms |
| `壁上观.jps`（真谱 32 行） | 89 / 85 / 95 ms ／ 153 / 163 / 193 ms | 111 / 112 / 131 ms ／ 200 / 215 / 243 ms |
| 合成 308 行 | 138 / 143 / 151 ms ／ 223 / 223 / 237 ms | 498 / 482 / 470 ms ／ 358 / 336 / 335 ms |
| 合成 1008 行 | 241 / 241 / 224 ms ／ 219 / 245 / 229 ms | **1680 / 1635 / 1630 ms** ／ 591 / 580 / 553 ms |

**怎么读**：
- **启动**：内嵌省掉了 V8 启动 + 650KB 脚本解析 ⇒ **小谱上内嵌更快**（85–140ms vs 150–240ms，含 `--version` 那种空跑）；
- **单位工作量**：QuickJS 比 V8 慢 ⇒ 谱一大就反过来：1008 行 `render -t svg` 内嵌 **≈1.65s**、
  Node **≈0.58s**（**≈2.8 倍**）；同一份谱 `lint` 基本打平（≈0.23s vs ≈0.23s）；
- 一次性出图 1.7s 可接受；**要批量渲染几百份**就选乙（Node 版）——两条路径产物口径一致 ✓。

### §一之三、实现细节索引（手册里被移出来的东西都落在这份文件）

`adj949` 起分工固定下来：**`docs/CLI-手册.md` 只讲"有什么 / 怎么用"**（命令、选项、真实输出、
用户必须知道的限制），**所有"为什么 / 原理 / 内部机制 / 设计取舍 / 实现细节"一律留在本文件**。
配套对照如下（左边是手册里保留的事实，右边是它的实现细节在本文件的位置）：

| 手册里只留事实 | 实现细节 / 原理在哪 |
|---|---|
| 命令行入口是垫片 `bin\ijipu.cmd`，注册的是 `<安装目录>\bin` | §一之一（可执行段逐字、**为什么注释纯 ASCII**、`start /wait` 的实测对比、**为什么垫片透明**不加 `cli`） |
| **别直接调 `ijipu.exe`**（输出顺序 / 退出码 / `>` 重定向会坏） | §一之一（GUI 子系统 + `AttachConsole` / `AllocConsole` / `WriteConsoleW` 口径）＋ §一之二（逐条实测对照表） |
| `-t png` / `-t jpg` / `-t pdf` / `-t wav` 现在不可用（退出码 4） | §七之二 / §七之三（能力通道：**命名管道**协议与当前状态、`rasterize` / `synthesize` 两项注入能力的落地计划） |
| `lint --watch` 内嵌版不可用、独立 Node 包可用 | §二（`nodeEntry.ts` 用 `fs.watch` 注入 `watchFile`；`embedEntry.ts` **刻意不注入**） |
| 注册写 PATH 的上限 2047 与幂等 | §二之二（`envPath.ts` 单一口径、写前备份 + 回读校验、`WM_SETTINGCHANGE`、旧形态兼容） |
| 内嵌版 / 独立 Node 包两条路径的差别 | §一 甲 / 乙、§一之二（**内嵌运行时**的体积与耗时实测）、§八（`实现约定` 与其它 `实现细节`） |

> 维持这份索引的目的很直白：手册瘦身**不许丢事实** ✗ —— 凡是从手册移走的东西，都必须能在上表
> 找到落点（冒烟 `adj949` 对两边的关键词做了成对断言 + 负对照）。

## 二、命令一览（P1）

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `format` | 按应用规范**规范化源码**（与应用编辑器/插件格式化同一实现） | `-i` `-o` `--check` `--in-place` `--diff` |
| `lint` | 语法检查（错误/告警）；输入可以是**目录**（`-r` 递归、`--filter` 按名筛）；`--watch` 监视文件变化后**即时重检** | `-i` `-r` `--filter` `--format text\|json\|gh` `--watch` |
| `info` | 谱面概况（标题/调号/行数/分组/问题数） | `-i` `-t text\|json` |
| `render` | 源码 → **SVG**（每页一段）／**MIDI**／**PNG·JPG·PDF**（需桌面端通道）／**MP4 动态谱视频**（桌面端，另起隐藏窗口） | `-i` `-t svg\|midi\|png\|jpg\|pdf\|mp4` `-o` `--from` `--to` `--pass` `--aspect` `--card` `--nosound` |
| `play` | 导出音频：**MIDI**（任意环境）／**WAV**（需桌面端通道） | `-i` `-t midi\|wav` `-o` |
| `batch` | **目录批量操作**（任务**可逗号组合**：`lint` / `svg` / `midi` / `fmt`）；输出目录会自动创建 | `--in <目录>` `-o <目录>`（**纯 `-t lint` 可省**）`-t lint,svg,midi,fmt` `-r` `--filter` |
| `settings` | 看**某一个设置项**的值与**来源**（位置参数 = 键名） | `-i <谱>` `<键名>` `-s k=v`（临时覆盖） |
| `set` | 把设置**写进谱面**（源码里的 `# jps-config`）—— 与 `settings` 是"读 / 写"一对（`adj962`） | `-i <文件\|目录>` `k=v …`（位置参数，可多组）`--in-place` ｜ `-o <目录>` `-r` `--filter` `--json` |
| `config` | 打印**生效设置全表 + 每项来源** | `-i <谱>` `-t effective` |
| `doctor` | 环境自检（可设置项数量、各项能力是否可用） | `--json` |
| `completions` | 输出 shell 补全脚本 | `completions bash\|zsh\|powershell` |
| `register` | 把**命令行入口目录 `<安装目录>\bin`** 写进当前用户 PATH（装了应用就能直接敲 `ijipu`；adj946 口径） | `--json` |
| `unregister` | 从当前用户 PATH 里**摘掉自己那一条**（其余逐字不动） | `--json` |
| `status` | 看现在注册了没有（**读系统实况**，不读配置） | `--json` |

`--watch` 分两条交付路径，**能力不一样**（口径与代码一致，见 `cli.ts` 的 `watchFile` 宿主能力）：

- **独立 Node 包可用 ✓**：`nodeEntry.ts` 用 `fs.watch` 注入 `watchFile` ⇒ `lint --watch` 监视文件变化后即时重检；
- **内嵌版（`ijipu.exe cli …`）不可用 ✗**：`embedEntry.ts` **刻意不注入** `watchFile`（要长驻监视）
  ⇒ 明确报错、**退出码 1**，不假装成功；
- 两种路径都**不能对 stdin 用**（要监视具体文件）。

### §二之一、动态谱视频（`render -t mp4`，`adj1084`）

```powershell
ijipu cli render -i 赤伶.jps -t mp4 -o 赤伶-第2遍.mp4 --from 27:3 --to 50:1 --pass 2 --card ink
ijipu cli render -i 我的谱.jps -t mp4 -o 整曲.mp4          # 不写起止 = 整曲
ijipu cli render -i 我的谱.jps -o 整曲.mp4                  # -o 后缀即可推断类型

# adj1166：有 sidecar 时按标记段名导出（不用自己换算小节:拍）
ijipu cli render -i 赤伶.jps -t mp4 -o 段1.mp4 --mark 段1

# 声音：合成音（缺省）/ 只伴奏 / 伴奏+合成
ijipu cli render -i 赤伶.jps -t mp4 -o 段1-伴奏.mp4 --mark 段1 --sound file
ijipu cli render -i 赤伶.jps -t mp4 -o 段1-混合.mp4 --mark 段1 --sound mix --accomp-gain 0.8 --synth-gain 0.5
```

**拍位口径**（用户 2026-10-23 拍板：**只用这一种写法**）

- 统一 `<小节>:<拍>`，如 `27:3`；`27/3`、`@27/3` 之类**不认**（写法越少，歧义越少）。
- 小节与拍都从 **1** 起，拍可带小数（`3.5` = 第 3 拍后半拍）。
- 起点取"这一小节里第一个不早于该拍的音"；终点取"该拍那个音的**前一个**音" ⇒
  `--from 27:3 --to 50:1` 到第 50 小节第 1 拍**之前**收住，不含那一拍。
- `--pass N`：反复段落里的第 N 遍（**1 起**）；内部候选遍次 0 起，换算在 CLI 做。
  不给就按解析器的第一遍。与界面「标记段」的遍次下拉是同一套 `pickPracticeCandidate`。

**标记段（`--mark`，adj1166）**

- `--mark <名字>`：读同目录的 `<输入>.jps.sync.json`，按 `marks[].name` **精确匹配**，
  用该段已存的起止音符与遍次；不需要再写 `--from/--to/--pass`。
- 与 `--from/--to` **互斥**（一个名字、一个位置，同时给无法判断）；与 `--pass` **也互斥**
  （段自己的遍次已经存在 sidecar 里）。
- sidecar 不在旁边时用 `--sync <文件>` 指定。
- 找不到名字 ⇒ 用法错误并列出已有段名；重名 ⇒ 明确报"不唯一"，不静默取第一条。
- ⚠ 当前 sidecar 只有在**这份谱已有伴奏/对拍**时才会写盘；只在试听里建了标记段、
  但没有伴奏的谱，`--mark` 可能找不到 sidecar —— 这种谱请用 `--from/--to`。

**声音（`--sound`，adj1166）**

- `--sound synth`（缺省）：合成音，保持旧命令行为；
- `--sound file`：只放 sidecar 里的伴奏（不依赖音色库）；
- `--sound mix`：伴奏 + 合成音；
- `--accomp <音频>`：覆盖 sidecar 的 `audio` 路径（相对 sidecar 目录或绝对路径）；
- `--accomp-gain` / `--synth-gain`：0–2，缺省伴奏 1；合成音在 `--sound mix` 时默认 0.5
  （与相机位 `DEFAULT_SYNC_MIX` 一致），`--sound synth` 时默认 1（保持旧命令满音量）；
- `file` / `mix` 必须能找到 sidecar + 伴奏，否则**明确报错**，不静默退回合成音；
- `--nosound` 与 `--sound` / `--accomp` / 两条音量**互斥**；
- `--mark` 与 `--sound file|mix` 共用同一份 sidecar，只读一次。
- `--aspect 9:16|1:1|16:9`：画布比例（竖屏／方形／横屏），与相机位「画布」按钮**同一套写法**。
  只认这三种（`9x16` / `16x9` 这类内部 id 不认 —— 一种行为只留一种写法）；缺省 **9:16**，
  与界面相机位的默认画布一致。
- `--card [brand|paper|ink|minimal]`：片头/片尾模板（深空蓝／纸面／水墨／极简）。
  **不写 `--card` = 不带片头片尾**（只出动态谱）；**只写 `--card`、不跟模板 = 极简**（`minimal`）。
  `custom` **刻意不支持**：那是本机偏好，同一条命令换台机器会出不一样的片。
  （`adj1176` 起界面的「我的模板」同样只在应用/相机位里用：命令行进程读不到那本模板库，
  批量出片请用这 4 个内置模板，或先用模板 zip 导出备份。）
- `--nosound`：明确导出**不带声音**的视频；不写就是带声音（与界面相机位「带声音」勾选一致）。
  打开无声时宿主不会去渲音轨（不是"渲完再丢掉"）。

**缺省与边界**

- 缺省 **9:16、整曲时长**。界面里的「3 分钟」会把长曲裁短，命令行不替用户做这个决定。
- `-o` 必填（MP4 是二进制，不能 stdout）；CLI **不自己写** MP4，字节由宿主窗口落盘。
- 片头 3.7 秒（描述头静止 + 推近）与片尾卡**只在给了 `--card` 时才有**（与界面「带片头片尾」勾选同一份编排）。
- 音轨失败（如音源不可用）⇒ 出**无声片**并在结果里如实标 `audio:false`，不会因此导不出来。

**为什么内嵌版也能出片**（架构，见 `src-tauri/src/cli_video.rs`）

```text
ijipu.exe cli render -t mp4 …（QuickJS，没有 WebCodecs）
  → 把请求写成临时 JSON（源码可能几万行，走不了命令行参数）
  → 起子进程 ijipu.exe --cli-video-job <任务文件>（正常 Tauri，但窗口隐藏）
  → 前端 export/video/cliWorker.ts 用与应用同一份 createDynamicSession + encodeMp4 出片
  → 分块写回 MP4（大文件不走一行一条 JSON 的管道）→ 回报结果 → 退出
  → 父进程读结果，CLI 按退出码收场（0 成功 / 1 用法 / 4 渲染失败）
```

> 出片窗口**不注册单实例插件**：否则应用已开着时，子进程会被转交给主窗口、立刻退出，
> 父进程误判失败。等待上限 20 分钟（超时杀掉并如实报错）。

### §二之二、`settings` 的键名与来源

`settings` 的键名直接当**位置参数**给，例如：

```powershell
npm run cli -- settings -i 我的谱.jps margin_right     # 例：margin_right = 40   [来自：代码默认]
npm run cli -- settings -i 我的谱.jps margin_right -s margin_right=33
#   margin_right = 33   [来自：命令行 -s]
npm run cli -- config -i 我的谱.jps -t effective --quiet # 只看"非默认"的项（精简视图）
npm run cli -- doctor                                    # 能力自检：位图/音频在独立 Node 里为 ✗（需桌面端通道）
```
> `-s k=v` 可用于 `settings` / `config` / `render` / `play` / `batch`（**临时覆盖，不落盘** ✓）；
> 把设置**写回谱面**（`# jps-config` 差量写入）属后续阶段 ✓。

### 二之一、目录级批量：`lint -i <目录>` / `batch` 组合任务 / `set` 写设置（`adj956`/`adj961`/`adj962`）

由来（**用户需求原话**）：「如果我要获取指定目录下的所有 jps 文件的 lint 情况，是需要借助 bat 文件
来实现还是 batch 参数就可以实现？一些操作是否可以通过 batch 参数形成组合式的批量操作的效果？」

改之前**两条路都走不通**：`batch` 只认 `-t svg|midi|fmt`（没有 lint）、`-o` 是硬性必填（lint 根本不产出文件）、
目录列举只回一层文件名 ⇒ 想在 bat 里 `for %%f in (*.jps) do …` 逐文件调用是唯一办法。
现在（口径与实现都在 `cli.ts`）：

| 能力 | 形态 | 说明 |
|---|---|---|
| **目录输入** | `lint -i <目录>` | 一次检查整个目录；退出码与单文件同口径（有错 ⇒ 3） |
| **递归** | `-r` / `--recursive` | **缺省不递归**（只看当前一层）—— 一次手滑不该扫出用户没预期的一大批文件 |
| **按名筛** | `--filter <通配>` | 只匹配**文件名**（`*` 与 `?`），如 `--filter "春*"`；输入是单文件时**不生效**（点名要的文件没有再筛掉的道理） |
| **组合任务** | `batch -t lint,fmt,svg` | 一次遍历目录，多种产物一起拿 |
| **`-o` 变可选** | `batch -t lint` | 纯 lint 不产出文件 ⇒ **一定**不用给 |
| **产物落点三选一（`adj961`）** | `-o <目录>` ｜ 省略 `-o` ｜ `-t fmt --in-place` | `-o` = 另存到那个目录；**省略 = 写在各源文件旁**（`-r` 时也各贴各的）；`fmt` 就地 = **覆盖源文件** ⇒ 必须显式 `--in-place`；`-o` 与 `--in-place` 同时给 = 歧义 ⇒ **退出码 1**（不猜） |
| **`--json` 真吐 JSON** | `batch … --json` | 原先 `batch` 无论有没有 `--json` 都只打那句中文汇总（`json` 只存在返回值里）⇒ 与 `lint`/`info`/`config` 口径不一致 ✗；现补上产物落点（`output` / `inPlace`） |

`adj961` 的口径细节（用户问「`-t svg` 必须要 `-o` 吗？不能导出在原目录吗？」）：

- **省略 `-o` = 各源文件旁**，而不是"全糊到当前目录" —— `-r` 递归时每个产物**贴着它自己的源文件**
  （`a/b/c.jps` ⇒ `a/b/c.svg`），这样多子目录的整理结果不会错位。
- **`-t fmt` 就地必须显式 `--in-place`**：就地规范化会**原地覆盖源文件**（`x.jps` → `x.jps`），
  属数据损坏级别的操作 ⇒ 照 `format --in-place` 的既有口径"默认拒绝、给出三条出路"，
  而且**拒绝时一个文件都不写**（有闸门钉着）。
- **汇总文案要分三种**：`-o` ⇒ `输出到 <目录>`；就地 ⇒ `输出与源文件同目录`；`fmt --in-place` ⇒
  `fmt 任务原地覆盖源文件`；而**纯 lint 一个字都不提落点**（它不产出文件，提了是误导 —— 实测自己抓出来的）。

两条**判据/失败口径**上的讲究（都是本轮踩出来的）：

- **目录/文件怎么判**：宿主能力里只有 `listDir` 能区分二者（`exists` 只给"在不在"）⇒ `expandInputs()`
  **只对顶层那一次 `listDir` 的失败做降级**（"不是目录 ⇒ 当单文件"）。第一版把整个递归 `walk`
  包在同一个 try 里，于是**子目录读失败会被吞掉**、降级成"把目录当文件读"，最终报的是"输入不存在"
  —— 根因被藏起来（正是本项目反复记的"静默失败"那一类 ✗）。
- **`-s` 的静默忽略（`adj956` 修）**：`-s` 原先只有 `settings` / `config` 真的读它，
  却被 `info` / `render` / `play` / `batch` 的守卫放行 ⇒ "接受了、然后静默忽略"（最坏的一种错：
  不报错、结果却不是用户要的）。现在：接受范围收敛到**真的会用它**的命令，值**按类型粗转**
  （`margin_right=33` ⇒ 数字 `33`，与 `mergeJpsConfig` 给同一个键的类型一致），
  键名写错 / 缺 `=` 一律**退出码 5**（不当没写），覆盖值**最后展开**（`-s` > 源内 `# jps-config` > 代码默认）。
- **逐项输出必须带文件名（`adj960`，用户实报）**：用户拿 `ijipu cli -i . -r lint` 查 54 个文件，
  输出里只有一片 `第 20 行：倚音内不支持的符号` —— **对不上号**。用户给的判据是
  **"输出的信息是某一个文件独有、还是共同信息"** ⇒ **独有的（每一处问题）行首带文件名；
  共同的（`检查 N 个文件：…` 那句汇总）不带**。
  格式收敛在 `issueLine()` **一处**（`gh` 走 `::error file=…`、文本走 `<文件> 第 N 行：…`）——
  此前 `batch` 里另写了一份、而 `lint` 那份漏了文件名（同一件事两处实现，必然漂 ✗）。
  单文件输入**也带**（同一口径，混在一个日志里不会对不上号）；`-i .` 走出来的路径归一化掉 `./` 前缀。
  闸门：`cli-assert` 的 `adj960` 五条（目录 / 单文件 / `batch -t lint` 三处都要带 + 汇总行**不许**带 + 负对照）。
- **`-o` 与 `--in-place` 是歧义（`adj964`，自测发现）**：`format -i a.jps --in-place -o out.jps` 里
  `--in-place` 原先**悄悄赢**、`-o` 一个字节都不写、也不提示 —— 而 `batch` / `set` 遇到同一组合是
  **报歧义（退出码 1）**。同一件事两种口径 ⇒ 现在 `format` 也报错，**三处一致**
  （一个说"另存"、一个说"就地"，说不清就不猜）。顺带把 `--check` 的**只读保证**钉成闸门：
  即便同时给了 `--in-place` 也**一个字节都不写**（配"单独用 `--in-place` 确实写盘"的**正对照**，
  免得"没写"那条判据恒真）。

#### 二之一·补、把设置**写进谱面**：`set`（`adj962`，**用户需求**）

由来（用户原话）：「如果要为指定**文件/目录（批量）**添加一个设置项及设置值，如何操作？」
改之前**做不到**：`-s k=v` 是**临时**覆盖（不落盘）、`--config` 还没实现；而引擎里早就有这个能力
（`writeJpsConfig` + `mergeConfigEdits`，应用「保存设置」走的就是它）⇒ **缺的只是 CLI 这一层接线**。

形态：**读 = `settings`、写 = `set`**（与 `git config` 同一对）。值用**位置参数** `k=v`（可多组），
**不用 `-s`** —— `-s` 是"临时生效"那一路，两者混用会让"到底落不落盘"变得不可知（`set` 上给 `-s` ⇒ 退出码 5）。

```text
ijipu cli set -i 我的谱.jps margin_right=33                 # 打到 stdout（**不改文件**）
ijipu cli set -i 我的谱.jps margin_right=33 --in-place      # 写回原文件
ijipu cli set -i 乐谱 -r --filter "春*" page=A5 -o 输出目录   # 目录批量另存
```

四条口径（都不是新发明的，全部照抄既有实现）：

| 口径 | 依据 |
|---|---|
| **落点三选一**：不给 ⇒ stdout；`--in-place` ⇒ 写回；`-o <目录>` ⇒ 另存 | 与 `format` / `batch` **同一套**（目录输入必须给后两者之一：多份源码没法都打到 stdout） |
| **差量写入**：只写"与现状不同"的项、保留文件里已有的其它项 | `mergeConfigEdits(code, before, after)` —— ⚠ **绝不能**直接 `writeJpsConfig(code, {…})`，那会把**整条设置行**换成只有传进去的那几个键（文件里原有设置被抹掉 ✗） |
| **与默认值相同的项不写进谱面** | `writeJpsConfig` 缺省 `mode:'diff'`：设回默认值 ⇒ 该项**从设置行去掉** |
| **本机偏好不被固化** | 与 `mergeConfigEdits` 的设计意图一致（它当初就是为了修"点一次保存就把本机偏好写进谱面"） |

逐项输出带**文件名**、汇总行不带（`adj960` 的口径）。

**本轮自己实测抓到的真 bug（已修 + 已立闸门）**：`set` 的**单文件**输入路径是**用户原样给的**
（Windows 上 `D:\我的谱\a.jps`），而我第一版用 `p.split('/').pop()` 取文件名 ⇒ `split` 切不开、
**整条路径被当成文件名**，产物拼成 `<输出目录>\D:\我的谱\a.jps`、`mkdir` 直接 ENOENT（7 个文件全失败）。
目录输入那条路因为路径来自 `expandInputs`（统一 `/`）而**掩盖**了它 ——
现在统一走 `baseNameOf()`（`\` 与 `/` 都算分隔符），并有一条负对照钉着（`cli-assert` 的 `adj962`）。
同批顺手把 `joinPath()` 改成"**沿用用户输入里那种斜杠**"（否则 `-i D:\我的谱 -o D:\输出` 会打出
`D:\输出/x.jps` 这种半截混合形态）。

### P3：位图/音频为什么在独立 Node 里"报错"而不是"硬做"
`png/jpg/pdf` 需要 **canvas + 字体 + 分页**，`wav` 需要 **AudioContext + 音色库** ——
这些能力**只在应用侧存在**（决策②：走**隐藏窗口渲染**，复用 `src/export/*` 与应用音色库 ⇒ 与 GUI 导出像素级一致 ✓）。
所以本 CLI 把它们做成**由宿主注入的可选能力**：
- 在**桌面端 exe** 里（同一 exe 的子命令，决策①）由宿主注入 ⇒ 正常产出 ✓；
- 在**独立 Node** 环境里 ⇒ **明确报错 + 退出码 4**（"需要隐藏窗口渲染通道"），并给出可用的替代（`-t svg` / `-t midi`）✓
  —— **不产出半成品、不假装成功** ✓。

> **render 的 SVG 口径（重要）**：CLI 在 Node 里**没有 canvas 实测角标墨迹** ⇒ 引擎按**估算宽**排版，
> 与应用（实测版）可能有**亚像素差异**；版式、音符位置与页数一致 ✓。
> 需要像素级一致时用应用导出（P3 的"隐藏窗口渲染"就是为此 ✓）。

## 二之二、注册 / 解除：让终端里能直接敲 `ijipu`（adj944；adj946 改口径）

**要解决的事**：装了应用之后，命令行入口在**安装目录下的 `bin`** 里
（默认 `%LOCALAPPDATA%\iJipu\bin\ijipu.cmd`），终端里**不能**直接敲 `ijipu`（PATH 里没有它）。
`register` 就是把这个**命令行入口目录**加进**当前用户**的 PATH
（`adj946` 起是 `bin` 目录，不再是把安装目录本身写进去 ✗ —— 原因见 §一之一）。

```powershell
ijipu.exe cli status        # 现在注册了没有（读系统实况）
ijipu.exe cli register      # 注册：把**命令行入口目录 <安装目录>\bin** 写进当前用户 PATH
ijipu.exe cli unregister    # 解除：只摘掉自己那一条，其余逐字不动
```

实测（本机，2026-10）：

```text
> ijipu.exe cli status
iJipu CLI 注册状态：未注册 ✗（终端里还敲不了 ijipu）
  安装目录：C:\Users\<你>\AppData\Local\iJipu
  命令行入口目录（写进 PATH 的就是它）：C:\Users\<你>\AppData\Local\iJipu\bin
  当前用户 PATH：1387 / 2047 字符
  App Paths：（未注册）
  注册：ijipu cli register（注册后**新开一个终端**才生效；只对当前用户生效、不需要管理员）

> ijipu.exe cli register
已注册 ✓ 命令行入口目录已加入当前用户 PATH：C:\Users\<你>\AppData\Local\iJipu\bin
  · 请**新开一个终端**，之后就能直接敲：ijipu cli lint 我的谱.jps
  · 只对当前用户生效，不需要管理员权限
```

**五条必须知道的口径**：

| 事项 | 口径 |
|---|---|
| **写进 PATH 的是谁** | **`<安装目录>\bin`**（命令行入口目录，里面有垫片 `ijipu.cmd`）——由 TS `binDirOf()` **唯一一处**推导（Rust 只提供"安装目录"这个事实，不再自己拼一份 ✓） |
| **注册后要不要重开终端** | **要**。已经开着的终端里环境块在进程创建时就固定了，**看不到**新的 PATH；`register` 会广播 `WM_SETTINGCHANGE`，那只帮到**之后新起**的进程 ✓ |
| **权限** | 只写 `HKCU\Environment\Path`（**当前用户**），**不需要管理员**、不动系统级 PATH、不动别的用户 ✓（安装模式本来就是 currentUser） |
| **只动自己那一条** | 解除时其余条目**逐字保留**（含连续分号留下的空条目）；已存在（大小写/末尾斜杠/引号不同也算）就**不重复追加**（幂等）✓ |
| **旧形态兼容（adj946）** | PATH 里若还留着 `adj944` 那条"安装目录本身"：`status` 报 `legacy` 且**按未注册**报（那条会跟垫片抢 `ijipu`）⇒ 点一次「注册」**顺手换掉**；`unregister` **两种形态都摘** ✓ |
| **卸载会自动解除** | 卸载器（`nsis/hooks.nsh` → `nsis/cli-path.nsh`）会**两条都摘**（`${INSTDIR}\bin` 与 `${INSTDIR}`），并把值的类型按原样写回；**更新流程不摘**（`$UpdateMode` 保护，免得"更新一次丢一次注册"）✓ |

**上限**：PATH 值超过 **2047 字符**就**不写**（明确报错 + 给三条可执行建议：先清理失效目录 / 把应用装到更短的路径 / 直接用完整路径调用）。
理由是"写了之后某些老程序读不全"这类症状最难查 —— 宁可不写 ✓。

**顺带的便利（可选，不影响终端）**：注册时还会写
`HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\ijipu.exe`（指向我们的 exe），
于是「运行」对话框 / 资源管理器地址栏敲 `ijipu` 也能起来；解除时**只删指向我们的那一条** ✓。

**能力从哪来**：这三个子命令要读写当前用户的注册表 ⇒ 由**桌面端**注入（内嵌 CLI ✓）。
独立 Node 包（乙）里没有这个能力，跑了会**如实报退出码 6**（"环境能力缺失"），
并提示改用 `ijipu.exe cli register` ✓ —— 不假装成功 ✗。

> 实现同源：字符串口径（分号切分 / 大小写无关比较 / 长度上限 / 幂等）只在
> `packages/ijipu-cli/src/envPath.ts` 一处；**全局设置里那个「注册」按钮调用的是同一份函数** ✓
> （纯函数与编排有 `npm run smoke` 的成对断言 + 负对照守着）。
>
> **写前备份**：每次写 PATH 之前，原值（连同它的类型 `REG_SZ`/`REG_EXPAND_SZ`）会备份到
> `HKCU\Software\iJipu\CliPath`（`PathBackup` / `PathBackupKind`）；写完**回读校验**，
> 不一致就**立刻用备份还原**再报错 ✓（卸载器会把这个键删掉）。
> 值的类型**跟着原值走** —— PATH 里常有 `%USERPROFILE%` 这类变量，写成 `REG_SZ` 会让它们**不再展开** ✗。

## 二之三、命令行手册的入口与随包口径（`adj957`，**用户裁定**）

**结论：命令行手册不再随安装包分发；它的入口与另外两本手册合并。**

原先（`adj945`）的口径是"手册随包落在 `<安装目录>/docs/iJipu-CLI-手册.md`，应用「全局 → 命令行 →
查看 CLI 手册」按钮用**系统默认程序**打开它"（Rust 命令 `cli_manual_open`）。用户看完之后给的口径是
「那几份 MD 不必随包分发」+「桌面端、插件都指定相对路径，网站自然是在线文档」。于是本轮全撤：

| 撤掉的东西 | 位置 |
|---|---|
| 随包资源映射 | `src-tauri/tauri.conf.json` 的 `bundle.resources` |
| Rust 命令 | `src-tauri/src/cli_manual.rs`（整份）+ `lib.rs` 的 `mod` 与 `invoke_handler` 注册 |
| 设置里那个按钮 | `src/dialogs/PageConfigDialog.tsx` + `src/brand/copy.ts` 的 `cliPathCopy.manual*` 七条文案 |
| 安装清单闸门 | `scripts/check-installer.mjs` 的 `DOCS_REQUIRED` / `DOC_SOURCES` 两条 |

**换成了什么**：三本手册（操作手册 / 脚本语法说明 / 命令行手册）走**同一个 `DocDialog`**，
在顶栏「帮助」菜单里各有一项 —— 应用内渲染，不依赖 Windows 的 `.md` 关联程序
（那正是撤掉它的直接原因：**Windows 默认没有 `.md` 关联程序**，那个按钮在多数机器上会弹
「你要如何打开此文件」）。机器闸门也从"必须有这条映射"翻成"**必须撤干净**"（`adj957` 的那一组，
每条都配负对照）。

> 顺带删掉的是手册开头那张 `manual-page.png`（1440×900、95.6 KB）——"这份手册在官网上的样子"，
> 即**手册自己网页的截图**：对"怎么用"零帮助，而 `mdToHtml` 的 `<img>` **限不了宽** ⇒
> 在应用内对话框里它必然是一块巨幅图。判据随之从"至少 1 张"改成"引用了就必须存在"（0 张合法）。

## 三、全局选项

| 选项 | 含义 |
|---|---|
| `-i, --input <文件\|目录\|->` | 输入；`-` 表示 **stdin**（省略时也读 stdin）；`lint` 与 `batch` 接受**目录** |
| `-o, --output <文件\|->` | 输出文件；`-` 或省略 = **stdout**；`batch` 里是**输出目录** |
| `-t, --type <类型>` | 指定输出类型；省略时**按 `-o` 后缀推断**；`batch` 里可逗号组合 |
| `-r, --recursive` | 输入是目录时**连子目录一起**（缺省只看当前一层；`adj956`） |
| `--filter <通配符>` | 只处理**文件名**匹配的（`*` 与 `?`；`adj956`） |
| `--json` | 机器可读输出（带 `"schema": 1`） |
| `--quiet` | 不输出非必要信息（成功即静默，便于脚本判断） |
| `--deterministic` | 输出不含时间戳（CI 逐字节比对用） |
| `-s <k=v>` | 临时设置（**优先级最高、不落盘**）。只接受于 `settings` / `config` / `render` / `play` / `batch`；键名必须是真设置项，写错 ⇒ 退出码 5（`adj956`） |
| `--config <文件>` | CLI 配置文件（**P4**，现在给会报退出码 5） |
| `-h, --help` / `-v, --version` | 帮助 / 版本 |

## 四、退出码（**对外承诺**，脚本按它判断，不要解析文案 ✗）

| 码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 用法错误（未知命令/选项、缺少参数） |
| `2` | 输入不存在或读失败 |
| `3` | **语法错误**（`lint` 命中；`format --check` 发现"需要格式化"） |
| `4` | 渲染失败（P2 起） |
| `5` | 设置非法（`--config`/`-s` 相关） |
| `6` | **环境能力缺失**（adj944）：注册类命令（`register`/`unregister`/`status`）要读写当前用户的注册表，只有桌面端 `ijipu.exe`（内嵌 CLI）有；独立 Node 环境、PATH 超长、注册表写不进去都走这里 ✓ |
| `70` | **接线层自身出错**（只在内嵌版：内嵌 JS 加载失败 / 入口异常 / 产物缺失）—— 刻意与 0–5 分开，脚本**不要**把它当成"用法错误" ✓ |

## 五、示例

```powershell
# 1) 校验一份谱（有错 ⇒ 退出码 3）
npm run cli -- lint -i samples/ershenbu.jps

# 2) CI 里贴 GitHub Actions 注解（每个问题一行 ::error）
npm run cli -- lint -i 我的谱.jps --format gh

# 3) 机器可读（schema 版本 + 逐条 line/message）
npm run cli -- lint -i 我的谱.jps --json

# 4) 看概况
npm run cli -- info -i 我的谱.jps
#   文件：我的谱.jps
#   标题：…（有则打印）
#   调号：C
#   源码行：17｜曲词分组：3｜字符：259
#   问题：错误 0 个、告警 0 个

# 5) 管道：规范化后写回另一份文件
Get-Content 乱.jps -Raw | npm run cli -- format -i - -o 规范.jps

# 6) 原地规范化（**必须显式**，且只能对文件、不能对 stdin）
npm run cli -- format -i 我的谱.jps --in-place

# 7) 只检查是否合规（不改文件；不合规 ⇒ 退出码 3，适合 pre-commit）
npm run cli -- format -i 我的谱.jps --check

# 8) 看差异（- 旧 / + 新，逐行）
npm run cli -- format -i 乱.jps --diff

# 9) 一次性批量（P2 起用 batch；P1 时代用 PowerShell 循环兜；adj956 起任务可组合）
npm run cli -- batch --in samples -o dist-out -t svg     # 每个谱 → 一/多个 SVG（多页加 -1/-2）
npm run cli -- batch --in samples -o dist-out -t midi    # 每个谱 → 一个 .mid
npm run cli -- batch --in samples -o dist-out -t fmt     # 每个谱 → 规范化后的 .jps
npm run cli -- batch --in samples -t lint                # 只查语法：**不必给 -o**（不产出文件）
npm run cli -- batch --in samples -o dist-out -t lint,fmt,svg   # 组合：一次遍历拿三种结果

# 9b) 目录级 lint（adj956 起 lint 直接吃目录；-r 递归、--filter 按文件名筛）
npm run cli -- lint -i samples                           # 只查当前一层
npm run cli -- lint -i samples -r                        # 连子目录一起
npm run cli -- lint -i samples --filter "二*" --json      # 只查名字匹配的，输出机器可读汇总

# 10) 导出矢量图 / MIDI
npm run cli -- render -i 我的谱.jps -t svg -o 我的谱.svg
npm run cli -- render -i 我的谱.jps -t midi -o 我的谱.mid

# 11) 写谱时的即时反馈：监视文件，改一次查一次（Ctrl+C 结束）
npm run cli -- lint -i 我的谱.jps --watch
#   首次检查：错误 0 个、告警 0 个 ✓
#   变更后检查：错误 0 个、告警 1 个 ✓
```

## 六、CI 集成

**GitHub Actions**（`.github/workflows/jps.yml`）：
```yaml
- run: npm ci
- run: npm run cli -- lint -i 乐谱/ --format gh     # P2 起支持目录/glob；P1 先逐个文件
- run: npm run cli -- format -i 乐谱/ --check       # 不合规就红灯
```
**pre-commit / husky**：对改动过的 `.jps` 跑 `format --in-place` + `lint`（退出码非 0 即拦下提交 ✓）。

## 七、输出与编码约定

- **一律 UTF-8**；Windows 控制台若显示乱码，先 `chcp 65001`（或**优先写文件**而不是打到终端 ✓）；
- `--json` 输出**永远是单段 JSON**（带 `"schema": 1` 与 `"generator": "ijipu <版本>"`）；
- `lint --format gh` 的问题行格式：`::error file=<文件>,line=<行>::<消息>`；
- `format --diff`：`- 旧行` / `+ 新行`，只列**有变化**的行 ✓。

## 七之二、P3：桌面端「隐藏窗口渲染」怎么落（**需桌面环境验证**）

CLI 侧**已就绪** ✓：`render -t png|jpg|pdf`、`play -t wav` 需要宿主注入两个**可选能力**
（`CliIo.rasterize` / `CliIo.synthesize` ✓），没有就**明确报错 + 退出码 4** ✓。

**要接的是"谁提供这两个能力"** —— 决策②：用**隐藏窗口**（离屏 webview）复用应用既有渲染：

```
ijipu.exe cli render -i 谱.jps -t png -o out.png
  └─ src-tauri 入口解析到「子命令 `cli`」⇒ 不进 GUI（`adj942` 起已落 ✓）
      ├─ 纯文本类（format/lint/info/render -t svg|midi/batch/settings/config/doctor）：**无需窗口** ✓
      │    （内嵌 QuickJS 直接跑，宿主只提供文件/stdout —— 见 §一）
      └─ 位图/音频类（png/jpg/pdf/wav）：
          ① 建一个**不可见窗口**（或复用主窗口但先隐藏 / offscreen ✓），加载应用页面（同一套前端 ✓）
          ② 通过既有 IPC 把「要渲染的 .jps + pageConfig」交给前端
          ③ 前端调用**已有的** `src/export/export.ts`：
             `renderScoreToSvg` → `svgToCanvas` → `toDataURL('image/png')`
             （PDF 同理走既有 `exportPdf` 的分页逻辑 ✓；WAV 走既有播放/离线合成链路 ✓）
          ④ 把字节回传 Rust ⇒ CLI 落盘 ⇒ 退出
```

**关键约束（照抄项目铁律）**：
1. **不重写渲染** ✓：一律复用 `src/export/*` 与音色库 ⇒ 与 GUI 导出**像素级一致** ✓；
2. **失败要诚实** ✓：窗口建不起来 / 前端超时 ⇒ 退出码 4 + 原因（**绝不产半成品** ✗）；
3. **不引新依赖** ✓（决策②）：不用 resvg/sharp 之类第三方渲染器 ✓；
4. **产物确定性**：`--deterministic` 下不写时间戳；PNG/PDF 的字体与缩放固定（scale 默认 2 ✓）。

### 请你在桌面端按这个清单验证（我在此环境无法跑 GUI ✗）
| # | 命令 | 期望 |
|---|---|---|
| 1 | `ijipu.exe cli --help`（内嵌版）／`ijipu --help`（Node 包） | 都打印 CLI 用法 ✓；`ijipu.exe --help`（**没有 `cli`**）则**照旧弹 GUI** —— `adj947` 已实测：窗口标题「爱记谱 iJipu - v0.59.0」、进程一直活着、**stdout/stderr 都是 0 字节** ✓（口径见 §一） |
| 2 | `ijipu.exe cli lint -i 我的谱.jps`（内嵌版）或 `ijipu lint -i 我的谱.jps`（Node 包） | 两者结果一致 ✓（**不需要宿主**） |
| 3 | `ijipu.exe cli render -i 我的谱.jps -t svg -o a.svg`（Node 包形态去掉 `cli`，下同） | 生成 SVG ✓（不需要宿主） |
| 4 | 应用在跑（见 §七之三 的开启方式）时 `ijipu.exe cli render -i 我的谱.jps -t png -o a.png` | **生成 PNG ✓**；与应用「导出 PNG」**逐像素一致**（同 scale 下可对哈希 ✓） |
| 5 | 同上 `-t pdf` | 生成 PDF，页数与 GUI 导出一致 ✓ |
| 6 | 同上 `play -i 我的谱.jps -t wav -o a.wav` | 生成 WAV（需音色库就绪 ✓；缺音色库应**明确报错** ✗ 而不是静默出空文件 ✓） |
| 7 | 双击一个 `.jps`（第一个参数是路径） | **照旧打开 GUI** ✓（`adj942` 加了 CLI 分流后**仍然如此**：只有第一个参数恰为 `cli` 才走命令行 —— 本轮已实测：`Start-Process ijipu.exe samples\ershenbu.jps` 起来的窗口一直活着 ✓） |
| 8 | 应用**没在跑**时 `-t png`（含内嵌版 `ijipu.exe cli render … -t png`） | 报退出码 4 + 原因 ✓；**一次性子进程通道**落地后应能自动起宿主 ✓ |

> 第 4 条的"逐像素一致"是这条通道**唯一**的验收硬指标 ✓ —— 若不一致，说明前端走的不是 `src/export/*` 那条链路 ✓（先查这里，别调算法 ✗）。

## 七之三、能力通道**当前状态**与协议（adj875 起）

**两条通道**（用户 2026-10-11 裁决：**都做**）：

| 通道 | 何时用 | 现状 |
|---|---|---|
| ① **命名管道**（应用在跑） | 应用已开着 ⇒ CLI 连上去要能力 | **管道与协议已落 ✓**（Rust 单测：真建管道、真连、真收发 JSON）；**能力转交前端待下一批** ✗ |
| ② **一次性子进程**（应用没跑） | CLI 自己起一个隐藏窗口的宿主，拿完字节即退 | 未落 ✗ |

**管道名（单一口径，两端必须一致）**：`\\.\pipe\ijipu-cli-<USERNAME>`（取不到 `USERNAME` 时用 `default`）。
> 为什么要写死这一条：Obsidian 的 CLI 就有过"管道名按显示名/账户名不一致 ⇒ 客户端永远连不上"的案例，
> 所以这里**只允许一处规则**（Rust 侧 `cli_host::pipe_name()` 是唯一定义，CLI 侧照抄）。

**协议**：**一行一个 JSON**（UTF-8），`id` 原样回传便于配对：
```jsonc
→ {"id":1,"method":"ping"}
← {"id":1,"ok":true,"result":{"pong":true,"proto":1}}
← {"id":1,"ok":false,"error":"…"}          // 失败一律如实报错，绝不假装成功 ✗
```
**方法白名单**：`ping`（探活，CLI 用它判断"应用在不在跑"）、`capabilities`（能力自检，**如实**）、
`rasterize`、`synthesize`。未知方法一律拒绝。

**怎么开启（默认关，沿用方案 B 的安全口径）**：
```powershell
$env:IJIPU_CLI_HOST = "1"; .\ijipu.exe      # 或：.\ijipu.exe --cli-host
```
管道用**默认安全描述符**（创建者 + SYSTEM/Administrators）⇒ 只允许**同一用户**连接；
设置项接入后会改成"设置里显式开"（`adj876+`）。

> ⚠ **现在别指望 `-t png` 能通**：`capabilities` 会如实回 `raster/audio = false` 并给原因
> （"渲染转交前端的接线尚未落地"）⇒ CLI 仍然报退出码 4 + 原因 ✓。这是**刻意的**：宁可报"还没接"，
> 也不给"看起来成功了"的假象 ✗。

## 八、实现约定（给后续维护者，来自项目铁律）

1. **纯逻辑 + 注入式 IO**：核心是 `packages/ijipu-cli/src/cli.ts` 的 `runCli(argv, io)` ——
   不碰 `process`/`console` ⇒ 可被 ① **Node 包的 bin**（`src/nodeEntry.ts`；`npm run cli:build` 产出
   `packages/ijipu-cli/dist/ijipu.cjs`）② **内嵌版的入口**（`src/embedEntry.ts`；`npm run cli:embed` 产出
   `packages/ijipu-cli/dist/ijipu-embed.js`，由 `ijipu.exe` 里的 QuickJS 跑）③ 测试
   （`scripts/cli-assert.mts`）④ 将来的**能力宿主**通道，**多处共用一份逻辑** ✓
   （`adj942`：**重新**走「同一个 exe 带子命令」，但形态是**明确的 `cli` 子命令**、且**先把窗口分流掉**；
   `adj874` 那条"exe 保持纯 GUI"的口径**已作废** —— 见 §一 ✓）；
2. **不重写引擎**：解析/格式化只调 `@ijipu/engine`（AGENTS §六之二·4"数值口径必须同源"）；
3. **不引依赖**：参数解析手写（§一"新增依赖必须先询问"）—— CLI 包 `package.json` 里**没有 `dependencies`**
   （引擎已打进单文件产物），断言 `adj874` 守着这一条 ✓；
   ⚠ 内嵌侧唯一的新依赖是 `src-tauri` 的 **`rquickjs`**（QuickJS 绑定，只挂 `cfg(windows)`）——
   它属于"壳"，不进 CLI 包 ✓；
4. **未实现就报错**：不给"看起来成功了"的假象 ✗（退出码 1 + 明确提示 ✓）；
5. **凡新增命令**：同步更新本文件 + `--help` + 冒烟用例；`--help` 与命令集合的**一致性有闸门**
   （`adj874`：列全命令 + 负对照"不许把已实现的写成未实现"）✓；
   `adj947`：**`--help` 的"用法"行必须带 `cli`**（用户实报漏了 `cli`、照它敲会走进 GUI ✗）——
   闸门在 `cli-assert`（对**真实 `--help` 输出**断言 + 负对照），手册/`copy.ts` 里的"怎么敲"
   由冒烟 `adj947` 那组按"不许出现缺 `cli` 的调用形态"钉住 ✓。
6. **`CliIo.listDir` 的返回形状 = 目录项数组**（`{ name, dir }[]`，`adj956` 改）：
   ```ts
   listDir(dir: string): Promise<DirEntry[]>   // DirEntry = { name: string; dir: boolean }
   ```
   为什么改：`-r` 递归要下钻子目录，而"只有名字"**分不出哪个是目录** ✗。约定是**只回一层、
   按名字排序**（顺序可复现 ⇒ 输出能逐字节比对）。三处宿主**必须同步**，少一处就有一端崩：
   · `src/nodeEntry.ts`（`readdir(dir, { withFileTypes: true })`）；
   · `src/embedEntry.ts` 的 `EmbedHost.listDir` 类型；
   · `src-tauri/src/cli_embed.rs` 那个注入给 QuickJS 的 `listDir` 闭包（现在回 `{ name, dir }` 对象数组；
     `file_type()` 失败按"不是目录"处理 —— 只会少扫一层，不会崩 ✓）。
   测试侧的假 IO（`scripts/cli-assert.mts` 的 `makeIo`）也按同一形状归一：
   给**字符串**时若能找到 `${目录}/${名字}/…` 这样的键就当作目录，给**对象**则原样用 ✓。
