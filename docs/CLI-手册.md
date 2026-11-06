# iJipu 命令行使用手册

> - 适用版本：**iJipu 0.78.0**
> - 许可：**AGPL-3.0** ｜ 源码与问题反馈：<https://github.com/snailhome/ijipu>
> - 共 13 个命令。下文示例均为**实跑输出**：以 `>` 开头的是输入的命令，紧随其后的是该命令的真实输出
>   （这些示例都在 Windows 上**实跑过**，输出原文照录）。
> - 本手册面向使用者，只讲有什么、怎么用；命令行的实现与维护说明见 `docs/CLI.md`。

---

## 一、一分钟上手

### 1.1 注册：让终端直接支持 `ijipu cli`

注册只需执行一次，两种方式任选：

- **在应用内注册**（无需输入命令）：底栏 →「全局」→「命令行」→ 点「注册」。
- **在终端注册**：此时 `ijipu` 尚未加入 PATH，需要使用完整路径（下例为 cmd.exe；PowerShell 请在命令前加 `&`）：

```text
> "%LOCALAPPDATA%\iJipu\bin\ijipu.cmd" cli register
已注册 ✓ 命令行入口目录已加入当前用户 PATH：C:\Users\<你>\AppData\Local\iJipu\bin
  · 请新开一个终端，之后就能直接敲：ijipu cli lint 我的谱.jps
  · 只对当前用户生效，不需要管理员权限
```

注册完成后**新开一个终端**，即可直接使用 `ijipu cli <命令>`。注册是幂等的，重复执行不会重复写入：

```text
> ijipu cli register
已是注册状态 ✓（PATH 里本来就有这一条，未重复写入）：C:\Users\<你>\AppData\Local\iJipu\bin
```

### 1.2 注册后随处可用

注册省去的是**路径**，`cli` 不可省略；命令形态始终是 `ijipu cli <命令>`。

| 时机 | 命令形态 |
| --- | --- |
| 注册前 | `"%LOCALAPPDATA%\iJipu\bin\ijipu.cmd" cli lint 我的谱.jps` |
| 注册后 | `ijipu cli lint 我的谱.jps` |

| 事项 | 说明 |
| --- | --- |
| 需要新开终端 | 已打开的终端读不到新加入的 PATH，因此注册后须新开终端。 |
| 仅对当前用户生效 | 只修改当前用户的 PATH，不需要管理员权限；不影响系统级设置，也不影响其他用户。 |
| 可随时解除 | `ijipu cli unregister`（或应用设置里的同一按钮）只移除本程序写入的那一条，其余条目保持原样；卸载应用时也会自动解除。 |

由更早版本升级而来（当时写入 PATH 的是安装目录本身）：`status` 会把该形态标记为 `legacy` 并按未注册报告；
执行一次「注册」即可替换它，`unregister` 则两种形态都会移除。

### 1.3 确认注册成功

新开一个终端，依次执行：

```text
> ijipu cli --version
iJipu 0.78.0
```

```text
> ijipu cli status
iJipu CLI 注册状态：已注册 ✓（终端里可以直接敲 ijipu）
  安装目录：C:\Users\<你>\AppData\Local\iJipu
  命令行入口目录（写进 PATH 的就是它）：C:\Users\<你>\AppData\Local\iJipu\bin
  当前用户 PATH：558 / 2047 字符
  App Paths：C:\Users\<你>\AppData\Local\iJipu\ijipu.exe
```

- 第一条能打印版本，说明 PATH 已生效（最简验证）。
- 第二条 `status` 读取系统现状：在「环境变量」里手工改动过也如实反映。
- 供脚本使用时加 `--json`，读取 `registered` 字段比解析文案可靠：

```text
> ijipu cli status --json
{
  "schema": 1,
  "registered": true,
  …
}
```

（节选。完整字段：`installDir` / `binDir` / `legacy` / `pathLength` / `pathLimit` / `pathValue` / `appPaths`。
未注册时第一行是 `iJipu CLI 注册状态：未注册 ✗（终端里还敲不了 ijipu）`，并多一行以 `注册：` 开头的提示。）

**不要在终端里直接运行安装目录中的 `ijipu.exe`**：它是图形界面程序，命令行的输出顺序与退出码都不可靠。
请使用 `ijipu cli …`（注册后）或 §1.2 表中的完整路径形式。

### 1.4 常见误区

命令行与图形界面是**同一个程序**，以「第一个参数是否为 `cli`」区分。下列写法不会执行命令，而是打开图形界面：

| 你敲的（✗ 会打开图形界面） | 实际发生的事 | 正确写法（✓） |
| --- | --- | --- |
| `ijipu lint 我的谱.jps` ✗ | 打开图形界面（`lint` 不是 `.jps` 路径 ⇒ 被忽略）⇒ **一个语法检查都没做**，命令行这边一个字都不打印 | `ijipu cli lint 我的谱.jps` |
| `ijipu.exe --help` ✗ | 打开图形界面，**不打印命令行帮助**（查看用法须显式写 `cli`） | `ijipu cli --help` |
| `ijipu --version` ✗ | 同上，打开图形界面 | `ijipu cli --version` |
| `ijipu 我的谱.jps`（✓ 有意为之） | 打开图形界面并载入这份谱 —— 双击 `.jps`、文件关联走的就是这条路 | 使用命令行请写 `ijipu cli …` |

> 归纳：注册省去的是**路径**，`cli` 不可省略；命令形态始终是 `ijipu cli <命令>`。

### 1.5 查看用法

```text
用法：ijipu cli [全局选项] <命令> [命令选项]
```

完整帮助随时可查：`ijipu cli --help`。各命令的选项与示例见下一节。

---

## 二、命令集

本节示例均在 Windows 上实跑取得，输出原文照录。示例谱取自仓库 `samples` 目录的 7 份示例谱
（如 `samples\ershenbu.jps`）；两处「出错 / 不规范」的示例，谱的全文也贴在对应小节，照抄即可复现。
使用自己的谱时替换路径即可。

### 2.1 命令总表

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `format` | 按应用规范规范化源码（与应用编辑器的格式化结果一致） | `-i` `-o` `--check` `--in-place` `--diff` |
| `lint` | 语法检查（有错 ⇒ 退出码 3）；输入可以是目录 | `-i` `-r` `--filter` `--format text\|json\|gh` `--watch` |
| `info` | 谱面概况（调号 / 行数 / 分组 / 问题数） | `-i` `-t text\|json` `--json` |
| `render` | 渲染导出：`-t svg` ｜ `-t midi` ｜ `-t png` `-t jpg` `-t pdf` ｜ `-t mp4` | `-i` `-t` `-o` `--crop` `--pad` `--ink` `--mark` `--sound` |
| `play` | 导出音频文件：`-t midi` ｜ `-t wav` | `-i` `-t` `-o` |
| `batch` | 目录批量操作，任务可用逗号组合 | `--in` `-o` `-t lint,svg,midi,fmt` `-r` `--filter` |
| `settings` | 查看某一个设置项的值与来源（只读） | `-i <谱>` `<键名>` `-s k=v` |
| `set` | 把设置写进谱面（源码里的 `# jps-config`） | `-i <文件\|目录>` `k=v …` `--in-place` ｜ `-o <目录>` `-r` `--filter` |
| `config` | 打印生效设置全表与每项来源 | `-i <谱>` `-t effective` `--quiet` `--json` |
| `doctor` | 环境自检（如实报告各能力有无） | `--json` |
| `completions` | 输出 shell 补全脚本 | `bash` ｜ `zsh` ｜ `powershell` |
| `register` | 注册命令行入口目录到当前用户 PATH | `--json` |
| `unregister` | 从当前用户 PATH 解除注册 | `--json` |
| `status` | 查看当前是否已注册（读系统实况） | `--json` |

### 2.2 通用选项

| 选项 | 说明 |
| --- | --- |
| `-i, --input <文件\|目录\|->` | 输入。`-` = stdin；省略时也读 stdin；`--in` 是别名 |
| `-o, --output <文件\|->` | 输出文件（`-` 或省略 = stdout）；在 `batch` 里是**输出目录** |
| `-t, --type <类型>` | 输出类型。省略时按 `-o` 后缀推断；`batch` 里可逗号组合 |
| `--json` | 机器可读输出（带 schema 版本） |
| `--quiet` | 不输出非必要信息 |
| `-s <k=v>` | 临时设置（可重复；**优先级最高**，不落盘）。只接受于 `settings` / `config` / `render` / `play` / `batch` |
| `-r, --recursive` | 输入是目录时**连子目录一起**（缺省只看当前一层） |
| `--filter <通配符>` | 只处理**文件名**匹配的（支持 `*` 与 `?`，如 `--filter "春*"`） |

`-s` 的三条规则：键名必须是真实的设置项（有误 ⇒ 退出码 5，不会被忽略）；`k=v` 缺少 `=` 同样报退出码 5；
值可解析为数字时按数字处理（`margin_right=33` 即数字 33）。

### 2.3 `lint`：语法检查

**① 检查一份谱**（无问题 ⇒ 打印一行、退出码 0）：

```text
> ijipu cli lint -i samples\ershenbu.jps
没有发现问题 ✓
```

**② 检查整个目录**（最常用的一种，无需自行编写批处理循环）：

```text
> ijipu cli lint -i samples
samples/liangzhilaohu.jps 第 12 行：第 5 小节共 6 拍，与拍号 4/4（每小节 4 拍）不符
samples/liangzhilaohu.jps 第 12 行：第 6 小节共 6 拍，与拍号 4/4（每小节 4 拍）不符
samples/lianyinxian-zhuangshi.jps 第 10 行：第 2 小节共 6 拍，与拍号 4/4（每小节 4 拍）不符
samples/yinyun-zhuangshi.jps 第 11 行：第 2 小节共 6 拍，与拍号 4/4（每小节 4 拍）不符
samples/yufa-quangai.jps 第 12 行：第 2 小节共 4 拍，与拍号 6/8（每小节 6 拍）不符
samples/yufa-quangai.jps 第 12 行：第 3 小节共 3 拍，与拍号 6/8（每小节 6 拍）不符
samples/yufa-quangai.jps 第 12 行：第 4 小节共 7 拍，与拍号 6/8（每小节 6 拍）不符
检查 7 个文件：7 个通过、0 个有错（错误 0 个、告警 7 个）
```

> 每处问题的行首都带文件名；只有最后一句「检查 N 个文件…」属共同信息，因此不带文件名。
> 单文件输入同样带文件名（`错谱.jps 第 5 行：…`），两种输出同一口径，混在同一份日志里也能分辨来源。

默认只检查当前一层；需要连同子目录时加 `-r`：

```text
> ijipu cli lint -i 乐谱 -r
```

仅检查文件名匹配的若干份，使用 `--filter`（支持 `*` 与 `?`）：

```text
> ijipu cli lint -i 乐谱 --filter "春*"
```

目录中没有 `.jps` 时如实报错（退出码 2），并提示加 `-r`。

**③ 有错时**：逐行打印，退出码 3。下面这份谱的全文如下（照抄存为 `错谱.jps` 即可复现）：

```text
V: 1.0
B: 错谱演示
D: C
P: 4/4
Q: 1"注释没闭合 2 3 4 |
```

```text
> ijipu cli lint -i 错谱.jps
错谱.jps 第 5 行：引号注释未闭合
```

**④ 供 CI 使用**：`--format gh` 使每行都是 GitHub Actions 注解（问题会直接标在 diff 上）：

```text
> ijipu cli lint -i 错谱.jps --format gh
::error file=错谱.jps,line=5::引号注释未闭合
```

**⑤ 供脚本使用**（`--json`；目录输入时 `files` 为每个文件一条）：

```text
> ijipu cli lint -i 错谱.jps --json
{
  "schema": 1,
  "generator": "ijipu 0.78.0",
  "input": "错谱.jps",
  "ok": false,
  …
  "errors": [
    {
      "line": 5,
      …
```

```text
> ijipu cli lint -i samples -r --json
{
  "schema": 1,
  "generator": "ijipu 0.78.0",
  "files": [
```

**⑥ 告警不影响退出码**：下面这份谱只有告警，退出码仍为 0（存为 `告警谱.jps`）：

```text
V: 1.0
B: w
D: C
P: 4/4
Q: 1 2 x 4 |
```

```text
> ijipu cli lint -i 告警谱.jps
告警谱.jps 第 5 行：无法识别的符号 "x"
```

**⑦ 边写边查**（`--watch`：文件每次变化即重新检查，`Ctrl+C` 结束）。该能力只有独立 Node 包具备：

```text
> ijipu cli lint -i samples\ershenbu.jps --watch
--watch 需要宿主的文件监视能力（node 入口提供；独立环境不可用）
```

### 2.4 `format`：规范化源码

**① 只检查是否符合规范**（不改文件）。符合即打印一行 `已符合规范 ✓`、退出码 0：

```text
> ijipu cli format -i samples\ershenbu.jps --check
已符合规范 ✓
```

不符合 ⇒ 退出码 3（可作为提交前钩子）。下面这份谱只有一行：

```text
Q:1 2 3 4|
```

```text
> ijipu cli format -i 我的谱.jps --check
需要格式化 ✗
```

**② 查看差异**（`-` 旧 / `+` 新，逐行）：

```text
> ijipu cli format -i 我的谱.jps --diff
- Q:1 2 3 4|
+ Q: 1 2 3 4 |
```

**③ 规范化结果打到屏幕**（`-o -` 或省略 `-o`）：

```text
> ijipu cli format -i 我的谱.jps -o -
Q: 1 2 3 4 |
```

**④ 写入另一个文件**：

```text
> ijipu cli format -i 我的谱.jps -o 我的谱.规范化.jps
已写入 我的谱.规范化.jps
```

**⑤ 原地修改**（只能对文件，不能对 stdin）：

```text
> ijipu cli format -i 我的谱.jps --in-place
已原地格式化：我的谱.jps
```

两条规则：

- **`--check` 只检查不修改**：即使同时写了 `--in-place`，也不写入任何字节（有断言守着）。
- **`-o` 与 `--in-place` 不能同时给出**（一为另存到该文件、一为原地覆盖）：

```text
> ijipu cli format -i 我的谱.jps --in-place -o 我的谱.规范化.jps
-o 与 --in-place 不能同时给：-o 是"另存到那个文件"，--in-place 是"原地覆盖源文件"
```

（退出码 1。`batch` / `set` 遇到同一组合也是这个口径，不做推断。）

### 2.5 `info`：谱面概况

```text
> ijipu cli info -i samples\ershenbu.jps
文件：samples\ershenbu.jps
调号：C
源码行：17｜曲词分组：3｜字符：259
问题：错误 0 个、告警 0 个
```

```text
> ijipu cli info -i samples\ershenbu.jps --json
{
  "schema": 1,
  "generator": "ijipu 0.78.0",
  …
  "groups": 3,
```

### 2.6 `render`：渲染导出

输出类型：`-t svg|midi|png|jpg|pdf|mp4`。

**① 矢量图**（多页谱会自动加 `-1` `-2`…）：

```text
> ijipu cli render -i samples\ershenbu.jps -t svg -o 我的谱.svg
已写入 我的谱.svg
```

**② MIDI**（二进制，**必须**用 `-o` 指定文件）：

```text
> ijipu cli render -i samples\ershenbu.jps -t midi -o 我的谱.mid
已写入 我的谱.mid（MIDI，225 字节）
```

```text
> ijipu cli render -i samples\ershenbu.jps -t midi
MIDI 是二进制，必须用 -o 指定文件（不能用 stdout）
```

**③ 裁到谱面**（缺省是整页；`--pad` 是每边留白像素，钳制 0–64）：

```text
> ijipu cli render -i samples\ershenbu.jps -t svg --crop score --pad 4 -o 我的谱.svg
已写入 我的谱.svg
```

**④ 位图 / PDF**：需要隐藏窗口渲染通道，只有桌面端版本具备：

```text
> ijipu cli render -i samples\ershenbu.jps -t png -o 我的谱.png
-t png 需要"隐藏窗口渲染"通道（桌面端 exe 内置）；当前环境没有该能力。
  可用：-t svg（矢量，任意环境）｜或改用桌面端：ijipu cli render -i <谱> -t png -o <输出>
```

**⑤ 动态谱视频（MP4）**：只有桌面端版本具备（成片要用 WebCodecs 编码）。
拍位统一写成 `<小节>:<拍>`，小节与拍都从 **1** 起，拍可带小数：

```text
> ijipu cli render -i 赤伶.jps -t mp4 -o 赤伶-第2遍.mp4 --from 27:3 --to 50:1 --pass 2 --card ink
正在导出视频：第 27 小节第 3 拍 → 第 50 小节第 1 拍之前，第 2 遍（9:16，全片长，片头片尾：水墨）
已写入 赤伶-第2遍.mp4（MP4，86.4 MB，含音轨）
```

- 不写 `--from` / `--to` 就是整曲；两个要一起给，只给一个会报用法错误。
- 终点**不含**那一拍上的音（`--to 50:1` = 到第 50 小节第 1 拍之前收住）。
- `--pass 2` 是反复段落里的第 2 遍（从 1 起）；不写则按解析器的第一遍。
- `--aspect 9:16|1:1|16:9` 选画布比例（竖屏 / 方形 / 横屏），与相机位「画布」按钮同一套写法；
  只认这三种（`9x16` / `16x9` 不认，一种行为只留一种写法）；不写就是 **9:16**，与界面默认画布一致。
- `--card` 选片头片尾模板：`brand`（深空蓝）、`paper`（纸面）、`ink`（水墨）、`minimal`（极简）。
  **不写 `--card` = 不带片头片尾**（只出动态谱，画面直接从第一拍开始）；
  **只写 `--card`、后面不跟模板 = 用极简**。自定义卡片是本机偏好，命令行不接受 `custom`。
  （界面的「我的模板」也一样：命令行进程读不到那本模板库，批量出片用这 4 个内置模板。）
- `--nosound` 明确导出**不带声音**的视频；不写就是带声音（与相机位的「带声音」勾选一致）。
- 缺省 **9:16、整曲时长**（不会像界面里的「3 分钟」那样把长曲悄悄截短）。
- `-o` 必须写文件：MP4 是二进制，不能走 stdout。

**按标记段名导出**（`--mark`，需要同目录的 `xxx.jps.sync.json`）：

```text
ijipu cli render -i 赤伶.jps -t mp4 -o 段1.mp4 --mark 段1
```

- `--mark` 用 sidecar 里 `marks` 的**名字**，段自己的遍次也一起用；不要再写 `--from/--to/--pass`；
- `--sync <文件>` 可指定 sidecar（缺省是 `<输入>.jps.sync.json`）；
- 找不到名字会列出已有段名；重名会明确报"不唯一"；
- sidecar 只有在这份谱已有伴奏/对拍时才写盘；只有标记段、没有伴奏时请用 `--from/--to`。

**声音选择**（`--sound`）：

```text
# 合成音（缺省，和旧命令一致）
ijipu cli render -i 赤伶.jps -t mp4 -o 合成.mp4 --mark 段1

# 只用伴奏（sidecar 里记的音频）
ijipu cli render -i 赤伶.jps -t mp4 -o 伴奏.mp4 --mark 段1 --sound file

# 伴奏 + 合成音，两条音量 0–2
ijipu cli render -i 赤伶.jps -t mp4 -o 混合.mp4 --mark 段1 --sound mix \
  --accomp-gain 0.8 --synth-gain 0.5
```

- `--sound synth|file|mix`：合成音 / 伴奏 / 伴奏+合成；
- **两条音量是独立参数**：

| 选项 | 控制哪条声音 | 缺省 |
| --- | --- | --- |
| `--accomp-gain 0-2` | **伴奏**音量（`file` / `mix` 生效） | `1` |
| `--synth-gain 0-2` | **合成音**音量（`synth` / `mix` 生效） | 纯合成 `1`；`mix` 时 `0.5` |

- `--accomp <音频>` 覆盖 sidecar 里的伴奏路径（相对 sidecar 目录或绝对路径）；
- `file` / `mix` 缺 sidecar 或伴奏 ⇒ 明确报错，不会静默退回合成音；
- `--nosound` 与 `--sound` / `--accomp` / 两条音量互斥。

**在 `.bat` 里使用中文文件名（Windows）**

终端里直接敲命令没问题，但把同一条命令写进 `.bat` 时，`cmd.exe` 会按**本机命令行编码**（中文 Windows 通常是 GBK）解析批处理文件。`.bat` 若存成 UTF-8，中文会先变成乱码（常出现 `?`），CLI 拿到的文件名已经不存在，于是报 `ENOENT`。

三种可靠写法（任选其一）：

```text
@echo off
chcp 65001 >nul
ijipu cli render -t mp4 --card paper -i 安和桥.jps -o 安和桥.mp4
```

> 这个 `.bat` 要存成 **UTF-8 无 BOM**；`chcp 65001` 必须在第一行（`@echo off` 之后）。
> 某些旧版 Windows 仍会按旧编码解析批处理，此时改用下面两种。

**写法二：`.bat` 存成 ANSI/GBK**（中文 Windows 最稳）

用记事本「另存为 → 编码：ANSI」，或 VS Code「通过编码保存 → GBK/GB2312」，命令原样写：

```text
@echo off
ijipu cli render -t mp4 --card paper -i 安和桥.jps -o 安和桥.mp4
```

**写法三：`.bat` 里完全不写中文**（推荐给固定目录）

让 `cmd` 自己从目录里取真实文件名（`%%~ff` 是完整路径，`%%~nf` 是去掉扩展名的文件名），中文由文件系统给出，不经过批处理编码：

```text
@echo off
for %%f in (*.jps) do (
  ijipu cli render -t mp4 --card paper -i "%%~ff" -o "%%~nf.mp4"
)
```

这个写法会把当前目录的每个 `.jps` 都渲染一份；目录里只有一首谱时就是你要的那一首。

也可以用 PowerShell 脚本（`.ps1` 存 UTF-8，Windows PowerShell 5.1 建议带 BOM）：

```text
$src = '安和桥.jps'
ijipu cli render -t mp4 --card paper -i $src -o ([IO.Path]::GetFileNameWithoutExtension($src) + '.mp4')
```

只要动态谱、不要片头片尾（也是最省事的写法 —— 不写 `--card`）：

```text
> ijipu cli render -i 我的谱.jps -t mp4 -o 我的谱-动态谱.mp4
正在导出视频：整曲（9:16，全片长，不带片头片尾）
已写入 我的谱-动态谱.mp4（MP4，32.1 MB，含音轨）
```

在独立 Node 环境（没有桌面能力）下，这条命令会明确报错，而不是假装成功：

```text
> ijipu cli render -i samples\ershenbu.jps -t mp4 -o 我的谱.mp4
MP4 需要"桌面端隐藏窗口"通道（WebCodecs 编码）；当前环境没有该能力。
  请在桌面端运行：ijipu cli render -i <谱> -t mp4 -o <输出> [--from 27:3 --to 50:1 --pass 2]
  或改用 -t svg（任意环境）｜-t midi（任意环境）。
```

### 2.7 `play`：导出音频文件

命令名 `play`（播放）来自它与应用试听共用同一套播放逻辑；在本手册的语境里，它的用途是
**把这份谱导出为音频文件**。输出类型：`-t midi|wav`。

```text
> ijipu cli play -i samples\ershenbu.jps -t midi -o 我的谱.mid
已写入 我的谱.mid（MIDI，225 字节）
```

`-t wav` 需要音色库采样合成，同样只有桌面端版本具备：

```text
> ijipu cli play -i samples\ershenbu.jps -t wav -o 我的谱.wav
WAV 需要采样合成（音色库 + AudioContext），当前环境没有该能力。
  可用：-t midi（任意环境）｜或改用桌面端：ijipu cli play -i <谱> -t wav -o <输出.wav>
```

### 2.8 `batch`：目录批量操作

`-t` 可用逗号组合（一次遍历目录、同时产出多种结果）；可用任务：`lint` / `svg` / `midi` / `fmt`。

**产物落点，三种写法**：

| 写法 | 产物落在哪 |
| --- | --- |
| `-o <目录>` | 另存到该目录（每个谱一个或多个文件） |
| **省略 `-o`** | **写在各源文件旁边**（`batch --in samples -t svg` ⇒ `samples/xxx.svg`；带 `-r` 时也同样各自就近） |
| `-t fmt --in-place` | **原地覆盖源文件**（必须显式写出） |

纯 `-t lint` 不产出文件 ⇒ 不需要 `-o`；`-o` 与 `--in-place` 同时给出属歧义（一为另存、一为就地）⇒ 报用法错误（退出码 1）。

**① 对整个目录做语法检查**（不需要 `-o`；也不提示"输出到哪"，因为它不产出文件）：

```text
> ijipu cli batch --in samples -t lint
批处理完成：成功 7 个、失败 0 个（任务 lint；输入 7 个文件）
```

**② 批量出 SVG · 另存到指定目录**：

```text
> ijipu cli batch --in samples -o 输出目录 -t svg
批处理完成：成功 7 个、失败 0 个（任务 svg；输入 7 个文件，输出到 输出目录）
```

**③ 批量出 SVG · 就地**（省略 `-o` ⇒ 产物与源文件同目录）：

```text
> ijipu cli batch --in samples -t svg
批处理完成：成功 7 个、失败 0 个（任务 svg；输入 7 个文件，输出与源文件同目录）
```

⇒ `samples\我的谱.jps` 旁即出现 `samples\我的谱.svg`；加 `-r` 时，子目录中的谱，产物落在各自的子目录。

**④ 组合式批量**（一次遍历，同时取得检查结果、规范化源码与 SVG；给出 `-o` 则都写到那里）：

```text
> ijipu cli batch --in 乐谱 -o 输出 -t lint,fmt,svg
```

**⑤ 就地规范化源码**（`-t fmt` 就地**会覆盖源文件** ⇒ 必须显式 `--in-place`）：

```text
> ijipu cli batch --in samples -t fmt --in-place
批处理完成：成功 7 个、失败 0 个（任务 fmt；输入 7 个文件，fmt 任务原地覆盖源文件）
```

未写 `--in-place` 时会拒绝（退出码 1）并给出三条出路：

```text
> ijipu cli batch --in samples -t fmt
batch 不写 -o 时产物就地输出；而 `-t fmt` 就地就是原地覆盖源文件 ⇒ 要显式确认：
  · 确实要覆盖源文件：ijipu cli batch --in <目录> -t fmt --in-place
  · 想另存一份：      ijipu cli batch --in <目录> -t fmt -o <输出目录>
  · 只想先看看：      ijipu cli batch --in <目录> -t lint
```

**⑥ 个别谱有语法错误**：记入"失败"并逐条列出，整体退出码 3（其余照常产出）：

```text
> ijipu cli batch --in 待检查 -o 输出目录 -t svg
批处理完成：成功 1 个、失败 1 个（任务 svg；输入 2 个文件，输出到 输出目录）
  ✗ bad.jps（1 个语法错误）
```

任务名写错（如 `-t lint,png`）直接报用法错误（退出码 1）。

### 2.9 `settings` / `config` / `set`：查看设置、写入设置

前两条只读；第三条 `set` 把设置**写进谱面**（源码里那行 `# jps-config`，跟着文件保存）。

```text
> ijipu cli settings -i samples\ershenbu.jps margin_right
margin_right = 50   [来自：代码默认]
```

临时改用其它值查看（**不落盘**）：

```text
> ijipu cli settings -i samples\ershenbu.jps margin_right -s margin_right=33
margin_right = 33   [来自：命令行 -s]
```

缺少键名时会给出用法与可用键提示：

```text
> ijipu cli settings -i samples\ershenbu.jps
settings 需要键名（位置参数），例如：settings -i <谱> margin_right
  可用键 54 个：settings -i <谱> -t effective 可全量列出；可选字段：heights、metaPos、lyricShrink、showInstrument、segmentRowGap
```

一次查看全部生效设置：

```text
> ijipu cli config -i samples\ershenbu.jps -t effective --quiet
生效设置（来源：命令行 > 源内 # jps-config > 代码默认）
```

上面的 `--quiet` 表示"只显示非默认项"（这份谱没有非默认项，因此只有标题一行）。去掉它则逐行列出全部：

```text
> ijipu cli config -i samples\ershenbu.jps -t effective
生效设置（来源：命令行 > 源内 # jps-config > 代码默认）
  page = "A4"   [代码默认]
  margin_top = 40   [代码默认]
  …
```

来源优先级：**命令行 `-s` > 源内 `# jps-config` > 代码默认**。

**把设置写进谱面**（`set`）：`k=v` 直接跟在命令之后，可写多组。不给落点则打到屏幕，**不改动文件**：

```text
> ijipu cli set -i 我的谱.jps margin_right=33
Q:1 2 3 4|



# jps-config:{"margin_right":33}
```

⇒ 源码末尾多出那行 `# jps-config`。这样得到的谱是**自包含**的：发给他人、或在其它机器上打开，效果一致
（这正是"设置写进谱面"而不是"只在本机生效"的意义）。

需要写回原文件时**显式**加 `--in-place`：

```text
> ijipu cli set -i 我的谱.jps margin_right=33 --in-place
我的谱.jps 已写回
```

**整个目录批量**（落点与 `batch` 同一套口径；不给落点会报用法错误 —— 多份源码无法都打到屏幕）：

```text
> ijipu cli set -i samples -o 输出目录 page=A5
输出目录/ershenbu.jps 已写入（来自 samples/ershenbu.jps）
输出目录/fanfu-tiaofangzi.jps 已写入（来自 samples/fanfu-tiaofangzi.jps）
…
已处理 7 个文件：7 个有改动、0 个未改动
```

需要原地修改整个目录时，把 `-o 输出目录` 换成 `--in-place`；连同子目录用 `-r`，按名字筛选用 `--filter`。

四条**差量写入**的规则（均有断言守着）：

| 情形 | 结果 |
| --- | --- |
| 文件里已经有别的设置项 | **原样保留**（`set page=A5` 不会把原有的 `margin_right` 丢掉） |
| 设的值正好等于**默认值** | 那一项**从设置行里去掉**（不写一堆等于默认值的键） |
| 设的值与现状相同 | 文件**不动**，报"未改动" |
| 本机偏好（在应用里改过、没写进谱面的） | **不会被固化**进谱面（不会把本机偏好写进别人的谱） |

> 只让本次按某个值运行、不写进文件：用 `-s`（见上一条）。
> `set` 的值是**位置参数** `k=v`；`-s` 属于"临时生效"那一路，两者不混用（`set` 上给 `-s` 会报退出码 5）。

### 2.10 `doctor` / `completions`

`doctor` 可查看本机上当前可用的 `-t` 类型（避免执行后才发现该类型不可用）：

```text
> ijipu cli doctor
iJipu CLI doctor
  可设置项：54 个（含可选字段 5 个）
  能力：svg ✓｜midi ✓｜位图(png/jpg/pdf) ✗（需桌面端隐藏窗口渲染）｜音频(wav) ✗（需音色库合成）｜视频(mp4) ✗（需桌面端隐藏窗口）
  提示：位图/音频在桌面端 exe 内可用；独立 Node 环境只能用 svg/midi ✓
```

加 `--json` 供脚本读取：

```text
> ijipu cli doctor --json
{
  "schema": 1,
  "generator": "ijipu 0.78.0",
  "capabilities": {
    "svg": true,
    "midi": true,
    "raster": false,
    "audio": false
  },
  …
}
```

`completions` 输出补全脚本（需先注册 PATH 才有意义）：

```text
> ijipu cli completions powershell
# iJipu PowerShell 补全（桌面端）：ijipu cli completions powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName ijipu -ScriptBlock {
```

```text
> ijipu cli completions bash
# iJipu bash 补全（桌面端）：source <(ijipu cli completions bash)
_ijipu() {
```

```text
> ijipu cli completions foo
completions 支持 bash | zsh | powershell（收到 “foo”）
```

### 2.11 `register` / `unregister` / `status`

这三个命令**只在桌面端版本可用**（需要读写当前用户的 PATH 与注册表）。三条命令的形态分别是
`ijipu cli register`（注册）、`ijipu cli unregister`（解除）、`ijipu cli status`（查看）；
看状态、注册、解除的完整示例分别见 §1.3 / §1.1 / §1.2，此处补充两条：

```text
> ijipu cli unregister
已解除 ✓ 已从当前用户 PATH 里摘掉：C:\Users\<你>\AppData\Local\iJipu\bin
  · 其余 PATH 条目逐字未动；新开的终端里就不再能直接敲 ijipu 了
```

```text
> ijipu.exe cli status
iJipu CLI 注册状态：未注册 ✗（终端里还敲不了 ijipu）
  安装目录：C:\Users\<你>\AppData\Local\iJipu
  命令行入口目录（写进 PATH 的就是它）：C:\Users\<你>\AppData\Local\iJipu\bin
  当前用户 PATH：450 / 2047 字符
  App Paths：（未注册）
  注册：ijipu cli register（注册后要新开一个终端才生效；只对当前用户生效、不需要管理员）
```

三个命令都是**幂等**的：重复执行不会写坏 PATH。当前用户 PATH 超过 **2047 字符**时**不写入**，
并明确报错 + 给出三条可执行建议。注册时还会顺带写入 `HKCU\...\App Paths\ijipu.exe`（于是"运行"对话框、
资源管理器地址栏敲 `ijipu` 也能启动）；解除时**只删除指向本程序的那一条**。

### 2.12 常见用法

**① 单文件：检查 → 规范化 → 出图**

```text
> ijipu cli lint -i 我的谱.jps
> ijipu cli format -i 我的谱.jps --check
> ijipu cli render -i 我的谱.jps -t svg -o 我的谱.svg
```

`lint` 检查有没有错、`format --check` 检查合不合规范、`render` 出图；三条的退出码都可作判据（0 为通过）。

**② 整个目录一起检查**

```text
> ijipu cli lint -i 乐谱 -r
```

有错的逐条列出，整体退出码 3。

**③ 导出 SVG / MIDI**

```text
> ijipu cli render -i 我的谱.jps -t svg -o 我的谱.svg
> ijipu cli render -i 我的谱.jps -t midi -o 我的谱.mid
```

**④ 在 CI / 提交前钩子里跑**（按退出码判断，不解析文案）

```text
> ijipu cli lint -i 乐谱 --format gh
```

`--format gh` 的每一行都是 GitHub Actions 注解。提交前钩子里可以用
`ijipu cli format -i 我的谱.jps --check`（不符合规范 ⇒ 退出码 3 ⇒ 拦下提交）。

**⑤ 注册之后仍要写 `cli`** —— 见 §1.4：注册省去的是**路径**，不是 `cli`。

---

## 三、能力与限制

### 3.1 能力表

| 能力 | 现在能用吗 | 说明 |
| --- | --- | --- |
| `format` / `lint` / `info` / `batch` / `settings` / `config` / `doctor` | ✓ | 纯计算，任意环境 |
| `render -t svg` | ✓ | 矢量图，任意环境 |
| `render -t midi` / `play -t midi` | ✓ | 二进制 MIDI，**必须 `-o` 指定文件** |
| `render -t png` `-t jpg` `-t pdf` | ✗ 退出码 4 | 需要隐藏窗口渲染通道 ⇒ 请用应用里的「导出」 |
| `play -t wav` | ✗ 退出码 4 | 需要音色库采样合成 ⇒ 请用应用里的试听 / 导出 |
| `lint --watch` | ✗ 退出码 1 | **内嵌版没有**该能力；**独立 Node 包**（`@ijipu/cli`）可用 ✓ |
| `register` / `unregister` / `status` | ✓（仅桌面版） | 要读写当前用户的注册表；独立 Node 环境 ⇒ 退出码 6 |

如需确认本机的实际能力，先执行一次 `ijipu cli doctor`（§2.10）——它会如实报告每一项。

### 3.2 两条交付路径

跑的是**同一份命令逻辑**，差别只在"谁提供能力"：

| 路径 | 命令形态 | 注册表能力 | 位图 / 音频 |
| --- | --- | --- | --- |
| **内嵌版**（装过应用就有） | 注册前用完整路径；注册后 `ijipu cli <命令>` | ✓ 有 | ✗ 报退出码 4 |
| **独立 Node 包**（给 CI / 没装应用的机器） | 独立 Node 包 `@ijipu/cli` 装好后**没有 `cli` 这一层**：直接 `ijipu <命令>` | ✗ 退出码 6 | ✗ 同上 |

### 3.3 几条平台限制（Windows）

- **不要直接运行安装目录中的 `ijipu.exe` 当命令行用** —— 输出顺序、退出码、`>` 重定向都会异常（§1.3）；
  请用 `ijipu`（注册后）或 §1.2 表中的完整路径形式。
- **注册后要新开一个终端**才能敲到 `ijipu`（已打开的终端读不到新 PATH）。
- **补全脚本对 `ijipu` 这个命令名生效** ⇒ 需先注册 PATH。

---

## 四、退出码表

脚本请按**退出码**判断，不要解析文案（文案可能改动，退出码不会）。

| 码 | 含义 | 典型触发 |
| --- | --- | --- |
| `0` | 成功 | 一切正常（含 `lint` 只有告警） |
| `1` | **用法错误** | 未知命令 / 选项、缺参数、`batch` 任务名写错、目录输入配 `--watch` |
| `2` | **输入不存在或读失败** | `-i` 指的文件不在、路径写错、目录里没有 `.jps` |
| `3` | **语法错误** | `lint` 命中错误；`format --check` 认为需要格式化；`render` / `play` 遇到错误源码 |
| `4` | **渲染失败** | 需要位图 / 音频能力但当前环境没有（`png` / `jpg` / `pdf` / `wav`） |
| `5` | **设置非法** | `--config`（尚未实现）、`-s` 的键名写错或格式不对、`-s` 用在只看谱面的命令上 |
| `6` | **环境能力缺失** | 注册类命令在独立 Node 环境执行、当前用户 PATH 超长写不进去 |
| `70` | **接线层自身出错**（仅内嵌版） | 内嵌脚本加载失败等内部异常 —— 不是"用法错误"，脚本不要混为一谈 |

---

## 五、许可与源码

iJipu（爱记谱）0.64.0 以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布，
全文随安装目录放在 `LICENSE`；第三方组件与音色库的许可见安装目录的 `THIRD-PARTY.md`。

- 源码：<https://github.com/snailhome/ijipu>
- 官网 / 在线版：<https://ijipu.pages.dev>

欢迎学习、修改与再分发。
