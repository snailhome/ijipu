# 视频能力折离方案：iJipu → 爱出片（`ijipu-cp`）

> 用户 2026-11-10 提出：视频导出偏离记谱核心，要折离成独立的桌面视频生成工具。
> 本文回答三个问题：**可行不可行**、**两边怎么配合**、**具体怎么做**。
> 拍板结果在第十一节；许可证注意在看第十节之前先读 §11.1。

---

## 〇、一页结论

**可行，而且代价比看起来小。**

三句话概括：

1. **"折离"不是剪切粘贴，是"搬宿主层 + 删应用入口 + 引擎继续共享"**。
   视频的"怎么算"早在引擎里（纯函数），"怎么画"那层几乎不碰应用状态，能整体搬走。
2. **数据层可以完全配合，进程内不能配合**。
   谱面、对拍、卡片模板都是文件/JSON，两边能互认；但两个程序不会互相"跳转"，
   用户要在两个窗口之间切。这是折离的固有代价。
3. **应用侧能干净删掉**，牵连面已经量过：`src/` 52172 行里约 13003 行是视频相关的
   （25%），删除后应用只留记谱核心。

---

## 一、现状：视频这块到底有多大、多耦合

以下都是实际统计（`Get-Content` 逐文件计行，2026-11-10）。

| 层 | 位置 | 行数 / 文件 | 归谁 |
|---|---|---|---|
| 纯函数内核 | `packages/ijipu-engine/src/engine/dynamic/` | 1798 行 / 8 文件 | 引擎（已共享） |
| 宿主逻辑 | `src/export/video/` | **5895 行 / 24 文件** | 视频专用 |
| 台面 UI | 见下 | **7108 行 / 7 文件** | 视频专用 |
| 音源 | `src/playback/` | **2011 行 / 8 文件** | 两边都要 |
| 桌面命令 | `src-tauri/src/` | 3875 行（视频/对拍约 380 行：`cli_video.rs` 304 + `lib.rs` 里几条命令；音色库/字体是共用能力） | 视频的搬走，音色库/字体的留着 |
| 命令行 | `packages/ijipu-cli/src/` | 2907 行（`-t mp4` 一条支线） | 视频专用 |

台面 UI 明细：

| 文件 | 行数 |
|---|---|
| `src/dialogs/LinearSyncDialog.tsx`（连续动态谱对拍台） | 2349 |
| `src/dialogs/SyncDialog.tsx`（相机位对拍台） | 2110 |
| `src/dialogs/CardStyleDialog.tsx`（卡片模板编辑） | 1163 |
| `src/preview/DynamicFrameOverlay.tsx`（预览区相机位浮层） | 1120 |
| `src/dialogs/noteStrip.ts` / `syncRuler.ts` / `metronomeSchedule.ts` | 138 / 165 / 63 |

### 1.1 耦合点：只有 4 处

`src/export/video/` 24 个文件里，对应用侧的 import 只有这些：

```
brand/env        isTauriShell / tauriCore / isDevBuild     （平台判定、Tauri 通道）
brand/tokens     brand                                     （卡片上的品牌字）
store/overlayAssets  withOverlay                            （水印/背景图资源）
store/uiStore、playback/spessaCache、playback/spessaSynthBackend、store/hostBridge
                仅 cliWorker.ts 用（命令行出片那条路）
```

其余全部是 `@ijipu/engine` + `mediabunny` + 浏览器/WebCodecs。

**这说明宿主层本来就是"被注入参数的库"，不是"长在应用里的一坨"。**
`exportDynamic.ts` 的注释甚至直说了："本文件不碰 React，也不读 store"。

### 1.2 内核已经为"多出口"设计过

`docs/DYNAMIC-SCORE-PLAN.md` §二 定的三条硬约束现在成立：

1. `frameAt(t)` 是纯函数，同一 `t` 调两次结果深度相等；
2. 所有动画由 `t` 算出来，不用 CSS transition / rAF 累加；
3. `t=0` = 音频第 0 个采样。

⇒ 同一份谱在两个程序里出片，只要引擎版本一致，**逐帧可以相同**。这条是折离的安全底线。

---

## 二、目标：三个项目，三件事

```
                 ┌──────────────────────────────┐
   .jps   ──────▶│  ijipu（应用）                │  写谱、排版、预览、试听、打印/图片
                 └──────────────────────────────┘
                          │ 共享：@ijipu/engine（解析/排版/SVG/播放序列/动态帧/相机）
                          ▼
                 ┌──────────────────────────────┐
   .jps ─────────│  ijipu-cp 爱出片（新，桌面）│  卡片模板、对拍、动态谱、连续谱、出片
   .sync.json ──▶│                              │  视频项目（可保存、可批量）
   .mp4 (伴奏) ──┘                              │
                 └──────────────────────────────┘
                          ▲  CLI: ijipu-cp export --project …
                          │
                 ┌──────────────────────────────┐
                 │  ijipu-mv（已有）             │  文案、平台适配、拼接、发布素材包
                 └──────────────────────────────┘
```

一句话记法（沿用 mv 的口径）：

- **iJipu 管"谱"**：这谱怎么写、怎么排、怎么看、怎么听。
- **ijipu-cp 管"片"**：这条片子画面怎么走、声音怎么对、卡片长什么样。
- **ijipu-mv 管"发"**：这条片子讲什么、发哪个平台、怎么复盘。

边界规则（建议写进三个仓库的 AGENTS）：**每个能力只有一个实现方**。
出片能力只在新工具；应用删掉后不再有"输出 mp4"。

---

## 三、可行性判断

### 3.1 技术：可行

- 编码走 WebView2 的 WebCodecs + mediabunny（`mp4.ts` 注释里有本机实测：
  H.264 High + AAC 都支持），不依赖 ffmpeg、不依赖 Node。
- 新工具用 Tauri v2，与现有一致；Rust 侧要搬的只有文件选择/保存、系统字体枚举、
  音色库扫描/下载、音频读字节这几组命令（`src-tauri/src/lib.rs` 里已有现成实现）。
- 引擎是纯 TS、零 DOM，新工具直接 `import` 即可，`tsconfig paths` + vite alias 是现成做法
  （应用自己就是这么引引擎的）。

### 3.2 数据：可行，而且是强配合

| 数据 | 载体 | 配合程度 |
|---|---|---|
| 谱面 | `.jps`（自包含，L2 配置随谱走） | **强**：新工具自己解析排版，不需要应用在跑 |
| 对拍 | `xxx.jps.sync.json`（`SYNC_VERSION = 1`） | **强**：格式是契约，新工具读写同一份 |
| 卡片模板 | `CardStyle` JSON + `ijipu-card-*.zip` 包 | **强**：已有打包/解包实现 |
| 伴奏 | 音频文件（路径记在 sidecar） | **强**：普通文件 |
| 音色库 | `.sf2` / `.js` 文件 + 目录约定 | **强**：可选共用目录 |

### 3.3 体验：有代价，要接受

- 用户从"在应用里点一下"变成"另开一个程序"。应用侧**不留入口**（用户 2026-11-10 选了彻底删），
  所以这个切换只能靠发布说明和文档引导。
- 好处是实打实的：应用启动更快、界面更专注、出片能独立迭代（视频工具可以按自己的节奏发版）。

### 3.4 维护：可行，但要立两道闸

- 引擎只有一份（应用仓库），新工具通过 `vendor/engine` 逐字节同步 —— 插件已经在用这套机制
  （`obsidian-ijipu/vendor/engine` + 冒烟闸门 `adj770`），有现成经验。
- 保留一道**跨仓一致性断言**：同一份谱、同一参数，两个程序出的片抽取 3 帧做哈希比对。
  不比对整片（编码器版本会变），只比"第 1 秒、中间、结尾"三帧的画面哈希 + 总时长 + 音轨长度。

---

## 四、共享内核怎么切

### 4.1 结论：只共享引擎；音源抽成包；宿主层整体搬走

| 层 | 处置 | 理由 |
|---|---|---|
| `@ijipu/engine` | **留在应用仓库，继续共享** | 应用自己要用它解析/排版/试听；插件也在同步 |
| `src/playback/`（音源） | **抽成 `packages/ijipu-audio`** | 两边都要"完整试听"（用户已经选了"一次搬全"），复制必漂 |
| `src/export/video/`（宿主） | **整体搬进新仓库**，应用删除 | 只有视频工具需要，没有共享价值 |
| 视频台面 UI（7108 行） | **搬到新仓库后适配，不重写** | 重写 7000 行不划算；先跑通再重构 |
| `src-tauri` 视频/对拍命令 | 新仓库复制一份（约 380 行 Rust） | Rust 代码抽 crate 收益低，先复制 |
| CLI 的 `-t mp4` | 应用删除；新工具提供等价命令 | 见 5.6 |

### 4.2 为什么不把视频宿主也做成"共享包"

因为它**没有第二个使用者**。做成包的唯一好处是"应用以后还能用"，但应用的目标就是不用它。
留在应用仓库会让"src 52k 行"这个包袱不减小，还多一层包边界要维护。

### 4.3 `@ijipu/audio` 抽包的影响面

`src/playback/` 2011 行里，真正要搬的是：

| 文件 | 行数 | 说明 |
|---|---|---|
| `bankRegistry.ts` | 564 | 音色库注册表（L1，落 localStorage） |
| `bankDiscovery.ts` | 435 | 扫描/下载音色库（走 Tauri 命令） |
| `spessaSynthBackend.ts` | 356 | 合成器后端 |
| `spessaCache.ts` | 181 | HQ 音源缓存 |
| `metronome.ts` / `headless.ts` / `samplerCache.ts` / `playbackTimeline.ts` | 475 | 节拍器、无头渲染、采样缓存 |

改法：把这 8 个文件移到 `packages/ijipu-audio/src/`，应用侧改成
`import … from '@ijipu/audio'`（与引擎同样的 paths + alias）。
引用 `src/playback/` 的应用文件现在有 11 个，其中 4 个是视频的（两个对拍台、相机位、`cliWorker`）
→ 删完视频后剩 8 个（`ScriptToolbar` / `PreviewPane` / `docStore` / `PlaybackDialog` /
`VoicePickerDialog` / `SoundBankPanel` / `ExportPanel` / `uiStore`）。
**这一步先做、且行为不变**，是整条迁移里最"无痛"的一步。

⚠ 注意：`bankRegistry` 里有 localStorage 键（`ijipu.*`）。抽包后键名不变，
但**两个程序各写各的**（不同 origin / 不同 WebView 数据目录），不会冲突。

---

## 五、新工具设计

### 5.1 形态与技术栈

- **只做桌面端**：Tauri v2 + Vite + React 19 + TS（与现有一致，代码可直接搬）。
- 不用 Electron：现有 Rust 侧的命令（文件对话框、保存、字体枚举、音色库）能直接复用，
  换 Electron 等于重写一遍。
- 不做：谱面编辑、排版调整、PDF/图片导出、发布上传。
- 允许：打开 `.jps`、看谱（只读预览）、试听、对拍、出片、保存视频项目。

### 5.2 目录草案

```
ijipu-cp/
├─ docs/
│  ├─ PLAN.md            本方案的"项目版"（立项后落在这里）
│  └─ PROJECT-FILE.md    视频项目文件格式与迁移说明
├─ vendor/
│  ├─ engine/            与 ijipu/packages/ijipu-engine 逐字节同步
│  └─ audio/             与 ijipu/packages/ijipu-audio 逐字节同步
├─ src/
│  ├─ app/               窗口框架、最近项目、菜单
│  ├─ project/           视频项目：模型、读写、版本迁移、校验
│  ├─ score/             打开 .jps、只读谱面预览（缩放/滚动/高亮）
│  ├─ audio/             @ijipu/audio 接入、波形、节拍器
│  ├─ sync/              对拍台（相机位 / 连续谱两套）
│  ├─ card/              卡片模板管理（列表/编辑/导入导出 zip）
│  ├─ stage/             相机位台面、连续谱台面（预览 + 出片共用）
│  ├─ export/            输出预设、批量、进度、取消
│  └─ cli/               命令行入口（给 mv 用）
├─ src-tauri/
└─ scripts/
   ├─ sync-engine.mjs    从 ../ijipu 同步 vendor，记录源提交哈希
   └─ sync-audio.mjs
```

### 5.3 视频项目文件 v1（核心资产）

一个"视频项目"= 一份 JSON + 它引用的谱/伴奏/卡片。设计原则：

- **不写进 `.jps`**：一份谱要出抖音版、小红书版、15 秒版，项目是"作品"，谱是"素材"。
- **引用而不内嵌**：谱和伴奏记路径 + 内容指纹（指纹对不上就提示，不静默用旧谱）。
- **可手改**：纯 JSON、字段稳定、有 `version`，与 `.jps` 的"源码可改"哲学一致。

```json
{
  "version": 1,
  "name": "赤伶-抖音竖屏",
  "score": { "path": "赤伶.jps", "fingerprint": "fnv1a:8f3a91c2" },
  "kind": "camera",
  "sync": { "file": "赤伶.jps.sync.json" },
  "range": { "mark": "副歌", "startId": null, "endId": null, "pass": 0 },
  "camera": {
    "aspect": "9:16",
    "cards": true,
    "cardTemplate": "tpl-custom-fengguan",
    "panMode": "beat",
    "rowLeadBeats": 0.5
  },
  "linear": null,
  "sound": {
    "mode": "mix",
    "accompaniment": "赤伶A调伴奏.mp3",
    "gains": { "accomp": 1.0, "synth": 0.5 },
    "instrument": null
  },
  "output": {
    "fps": 30,
    "bitrate": 8000000,
    "container": "mp4",
    "width": 1080,
    "height": 1920,
    "dir": "out",
    "filename": "赤伶-抖音竖屏.mp4"
  },
  "createdAt": "2026-11-10T11:20:00+08:00"
}
```

`kind: "linear"` 时 `camera` 为 `null`、`linear` 填连续谱那套（主题、谱带位置、缩放、
`bgNone`、`outW/outH`、`cards` 等，字段与 `syncDoc.ts` 的 `SyncLinear` 一一对应）。

**迁移规则**（写进 `PROJECT-FILE.md`）：
读到 `version` 更低 ⇒ 走迁移函数；更高 ⇒ 明确报错（不猜着读）。
与 `syncDoc.ts` 的 `SYNC_VERSION` 保持同一条纪律。

**扩展名**：`<名>.ijv.json`（拍板第 10 条）。选 `.json` 结尾是为了"双击能看见、能用编辑器改"，
选 `.ijv.` 前缀是为了和应用导出的其它 JSON 区分开。文件关联放 11.2 的第 4 条，先不做。

### 5.4 预览谱面怎么来（用户特别问的）

**不需要应用参与。**

```
.jps ──parseJps──▶ layoutScore ──▶ renderScoreToSvg ──▶ <img>/canvas 显示
                              └──▶ buildPlaySequence ──▶ playheadSegs（高亮数据）
```

新工具写一个**只读预览**（估 300–500 行）：缩放、滚动、当前拍高亮、跟随播放。
不用做光标联动、选区、虚线拖拽、编辑——那些是记谱的事，留在应用。

这与相机位出片的画面**不是同一份代码**（出片走 `renderer.ts` 的"页面光栅 + 相机取景"），
但只要引擎相同，两者看到的谱面内容是一致的。预览的差异只影响"看着像不像"，
不影响成片。这一点要如实告诉用户，别承诺"预览与成片像素一致"。

如果以后想要"预览就是成片"：新工具可以把 `renderer.ts` 的会话直接拿到界面上跑
（应用现在就是这么做的，`DynamicFrameOverlay` 就是）。第一版不做，避免把出片路径耦合进编辑器。

### 5.5 试听怎么来

`@ijipu/audio` + 引擎的 `buildPlaySequence`：

- 合成音：spessa 后端（与应用同一份代码、同一套音色库格式）；
- 伴奏：WebAudio decode（`accompaniment.ts` 的 `decodeAccompaniment`）；
- 混音：`mixPlanOf`（`syncDoc.ts` 里的纯函数，已定义"伴奏/合成/视频原声"三路与音量）。

音色库目录建议：**默认读应用那份**（`%APPDATA%\com.ijipu.app\soundfonts`），
用户不必下载两遍；新工具自己的库目录作为可选覆盖。已拍板（第十一节第 7 条）。

### 5.6 CLI（给 ijipu-mv 用）

应用侧删掉 `-t mp4` 之后，mv 需要的出片能力由新工具提供：

```
ijipu-cp export --project <file.json> [--json] [--progress] [--out <路径>]
ijipu-cp render  --score <a.jps> --sync <a.jps.sync.json> --card <id> --aspect 9:16 ...
ijipu-cp cards   list | import <zip> | export <id> <zip>
ijipu-cp probe   <file.json>        # 只校验不渲染，给 mv 预检
```

`export` 的 JSON 回包沿用现有 CLI 的字段习惯（成功/失败、输出路径、字节数、时长、音轨有无），
mv 侧不用改解析逻辑太多。参数映射表（现应用 CLI → 新工具）：

| 现在 | 以后 |
|---|---|
| `-t mp4` | `ijipu-cp render` |
| `--card [brand|paper|ink|minimal]` | `--card <模板 id 或预设名>` |
| `--sync <sidecar>` | `--sync` |
| `--accomp` / `--accomp-gain` / `--synth-gain` | `--accomp` / `--accomp-gain` / `--synth-gain` |
| `--aspect` / `--from` / `--to` / `--pass` / `--mark` | 同名保留 |
| `--card` 不写 = 不带卡 | 同名语义保留 |

---

## 六、配合方式与"可配合程度"

这是用户最关心的部分，逐条说清"能配合到什么程度、配合不了的是什么"。

| 配合项 | 怎么配合 | 程度 | 配合不了的部分 |
|---|---|---|---|
| **预览谱面** | 新工具自己用引擎渲染 | ★★★★☆ | 不做编辑；预览与成片不是同一份渲染代码 |
| **对拍数据** | 共用 `xxx.jps.sync.json`（版本 1） | ★★★★★ | 应用删除后不再写，只读旧文件的能力也没有（彻底删） |
| **卡片模板** | 共用 `CardStyle` + zip 包 | ★★★★★ | 模板库各存各的（两套 L1），靠 zip 搬运 |
| **音色库** | 共用格式；可选共用目录 | ★★★★☆ | 两边的"当前音色"偏好各自记 |
| **伴奏/视频素材** | 普通文件，路径记在项目/sidecar | ★★★★★ | — |
| **进程内跳转** | 不做（两个 exe） | ☆☆☆☆☆ | 点了应用里的按钮直接打开视频工具，做不到（要额外的协议/命令行唤起） |
| **API/CLI** | 新工具出 CLI，mv 调 | ★★★★★ | 应用不调新工具 |
| **版本配套** | 新工具锁 `vendor` 快照的源提交哈希 | ★★★☆☆ | 不是 npm 依赖，靠同步脚本；两边发版节奏不同，要做兼容矩阵 |

### 6.1 关于"应用里留一个按钮打开视频工具"

技术上可做（新工具加 `ijipu-cp open <jps>`；应用加一条 Rust 命令或 `tauri-plugin-shell` 起进程）。
但用户 2026-11-10 选了"彻底删掉"，所以**第一版不做**。
如果以后想加，成本很低（应用里一行 shell 调用），但要先在能力归属表里登记。

### 6.2 关于"预览谱面获取"的另一种做法（不推荐）

让应用导出"预览包"（每页 PNG + 音符坐标 + 高亮区间），新工具只负责拼。
好处是新工具不用引擎；坏处是：

- 每改一次谱要重新导出一次，用户容易用旧包；
- 两套版本要同步，又是一处漂移；
- 预览包体积不小（30 页 × 4 倍光栅 ≈ 上百 MB）。

⇒ 新工具直接吃 `.jps` 更简单，也更符合"`.jps` 自包含"的既有口径。

---

## 七、应用侧删除清单（文件级）

按"删完能编译、能跑冒烟"的顺序列。建议**单独一个提交/一个 adj 批次**做，方便回退。

### 7.1 整文件删除

```
src/export/video/**                     24 文件 5895 行（整目录）
src/dialogs/SyncDialog.tsx              2110
src/dialogs/LinearSyncDialog.tsx        2349
src/dialogs/CardStyleDialog.tsx         1163
src/dialogs/noteStrip.ts                 138
src/dialogs/syncRuler.ts                 165
src/dialogs/metronomeSchedule.ts          63
src/preview/DynamicFrameOverlay.tsx     1120
src/store/syncStore.ts                  289
src/store/syncSidecar.ts                 78
src/store/syncExtras.ts                 271
src/store/syncOwner.ts                   44
src/store/cardImageStore.ts             277   （卡片背景图等大附件；配置导出也引用它，见 7.2）
```

合计约 13,950 行（宿主 5895 + 台面 7108 + store 五个文件 949 行）。
`src/export/zip.ts` **保留**（配置导出也在用）。

### 7.2 入口与状态清理

| 文件 | 要改的地方 |
|---|---|
| `src/ui/TopBar.tsx` | 「卡片模板…」菜单项（约 1247–1320）、`canUseDynamicVideo` import |
| `src/ui/dock/ExportPanel.tsx` | 「动态谱视频」整块（约 325–345）+ import |
| `src/dialogs/PlaybackDialog.tsx` | 「对拍」「连续动态谱」两个按钮（约 915–936）+ import |
| `src/dialogs/PracticeMarkBar.tsx` | 「整段动态谱」按钮 + 能力闸门 import |
| `src/preview/PreviewPane.tsx` | `<DynamicFrameOverlay />` 与 import（约 81、844） |
| `src/App.tsx` | `sync` / `linearSync` / `cardStyle` 三个模态的渲染分支 + `useSyncSidecarExtras()`（`syncExtras`） |
| `src/store/uiStore.ts` | `ModalKind` 去掉三个值；`dynamicCamera` / `dynamicCardStyle` / `cardTemplates` / `panMode` / `rowLeadBeats` / `metronomeTimbre` 及相关 action、localStorage 键、`cardTemplates` 的 import |
| `src/store/docStore.ts` | 去掉 `adoptSyncDocOwner`（`syncOwner`）的调用 |
| `src/store/settingsArchive.ts` | 配置导出/导入里对 `cardImageStore` 的引用（卡片背景图随模板搬走） |
| `src/main.tsx` | 一次性迁移 `migrateInlineCardImageInLocalStorage`（`cardImageStore`） |
| `src/dialogs/PracticeMarkBar.tsx` | 除「整段动态谱」按钮，还有 `useSyncStore` / `flushSyncAutoSave`（`syncExtras`） |

> `uiStore` 的清理是这一批里最容易漏的：这些字段在组件里被读取的地方要一并删，
> 否则 `tsc` 会红（正好当检查清单用）。

### 7.3 Rust 侧

| 位置 | 处置 |
|---|---|
| `src-tauri/src/cli_video.rs` | 整文件删（出片隐藏窗口） |
| `src-tauri/src/lib.rs` | 删 `mod cli_video`；命令注册去掉 `cli_video_job/write/progress/result`、`sync_read_file/sync_write_file/sync_read_audio`、`pick_audio_file`、`save_mp4_file`、`list_system_fonts` |
| `src-tauri/src/cli_embed.rs` | 删 `build_video_host` 与 `host.set("video", …)` |
| `src-tauri/src/lib.rs` 的 `run()` | 删 `cli_video::init_from_args()`（第 1277 行）与两处 `cli_video::is_worker()` 分支（第 1281 / 1356 行）。实测**不在** `main.rs` |

⚠ **动 `list_system_fonts` 前先确认**：它目前只被 `src/export/video/localFonts.ts` 调用
（卡片模板的"本机字体"）。如果谱面字体下拉不依赖它，可以一并删；删之前 `grep` 一遍。

### 7.4 CLI

`packages/ijipu-cli/src/cli.ts` 里删：

- `-t mp4` 分支与 `--card/--sync/--aspect/--from/--to/--pass/--mark/--nosound/--sound/--accomp/--accomp-gain/--synth-gain`；
- `io.encodeVideo` 接口与 `embedEntry.ts` 的 `video` 宿主段；
- 帮助文本里的"视频(mp4)"那一行与能力上报。

**这是对外行为的破坏性变更**：脚本可能正用着 `ijipu cli -t mp4`。
发布说明必须写清"改用 ijipu-cp"，并给出参数对照表（见 5.6）。

### 7.5 测试与文档

| 项 | 处置 |
|---|---|
| `scripts/verify-video.mjs` + `npm run verify:video` | 搬到新仓库（改成新工具的验收脚本） |
| `scripts/verify-app-ui.mjs` 里视频相关断言 | 删 |
| `scripts/smoke.mts` 里视频/对拍断言 | 删（该文件 39912 行，关键词命中约 250 处，逐条甄别；**不许**改口径凑绿） |
| `docs/DYNAMIC-SCORE-PLAN.md`、`CONTINUOUS-SCORE-PLAN.md`、`APP-PROMO-VIDEO.md` | 加迁移说明后归档（移到新仓库 docs 或留一份摘要） |
| `docs/CLI.md`、`USER-GUIDE.md`、`REQUIREMENTS.md` | 删视频/对拍章节；**不留"去爱出片"的引导**（拍板第 8 条），引导只放发布说明与官网 |
| `src/brand/copy.ts` | 删 `syncCopy` / `linearSyncCopy` 与相关文案 |
| `docs/ERRORS-LOG.md` | 不删历史记录 |

---

## 八、迁移阶段

每个阶段都能独立验收，任何一步出问题都能停下、应用仍是可用的。

### M0 立项与骨架（1–2 天）✅ 已完成（2026-11-10）

- 建 `ijipu-cp` 仓库（Tauri v2 模板），目录按 5.2；
- `scripts/sync-engine.mjs`：从 `../ijipu/packages/ijipu-engine` 同步 `vendor/engine`，写源提交哈希；
- 跑通"打开 `.jps` → 引擎排版 → 显示 SVG"。

**验收**：打开 `public/samples/` 里任意一份谱，能看到完整谱面；`vendor/engine` 哈希与应用仓库一致。

### M1 抽 `@ijipu/audio`（3–5 天，应用侧改动，行为不变）

- `src/playback/` 8 个文件移到 `packages/ijipu-audio`；
- 应用改 import，`tsconfig paths` + vite alias 指向包源码；
- 新工具 vendor 同一份。

**验收**：应用 `npm run smoke` 全绿、`npm run verify:app-ui` 试听能响；新工具能加载音色库并出声。

### M2 宿主层搬迁 + 出片闭环（5–8 天）— 主体已完成（2026-11-10）

- `src/export/video/` 整目录搬进新仓库 `src/render/`（先保留原样，只改 import 路径）；
- 把 4 处应用依赖改成注入：`overlayAssets` → 传 `RenderAssets`；`brand` → 新工具的品牌常量；
  `cliWorker` 删除（新工具不需要隐藏窗口出片，它本身就是窗口）；
- 项目文件 v1 落地；相机位台面先"照搬 `DynamicFrameOverlay` + 换 store"跑通；
- 出片。

**验收（关键）**：同一份谱、同一参数，新工具出片与旧应用出片的
**第 1 秒 / 中间 / 结尾三帧画面哈希一致** + 总时长一致 + 音轨采样数一致。

### M3 对拍 + 连续谱 + 卡片管理（5–8 天）

- 搬 `SyncDialog` → `src/sync/camera`、`LinearSyncDialog` → `src/sync/linear`、`CardStyleDialog` → `src/card`；
  把 `useDocStore/useUiStore` 换成新工具自己的 store（薄薄一层，只存"当前项目"）；
- 对拍写出的 sidecar 与应用旧版本**逐字段对齐**（用一份样本文件做 diff 断言）；
- 卡片模板 zip 导入导出。

**验收**：拿应用侧生成的 `xxx.jps.sync.json` 样本，新工具打开后锚点、tempo、mix、card 全部正确；
反向生成的文件能被旧应用（0.78.x）打开（删应用之前验一次就够，M4 之后不再需要）。

### M4 应用侧删除（2–3 天）

- 按第七节清单删；
- `npm run smoke` 全绿（删掉对应断言，**不许**改断言口径来凑绿）；
- `npm run verify:app-ui` 全绿；
- 重新打包，记录安装包体积变化（前后对比，别猜）；
- 版本号升到 **0.79.0**（拍板第 9 条）：`src/brand/version.ts`、`package.json`、
  `src-tauri/tauri.conf.json` 三处一致，CHANGELOG 明写"视频导出已移出"。

**验收**：`npm run build` 通过、安装包能装能开、菜单里没有视频相关项、试听/打印/图片导出正常。

### M5 mv 对接（2–3 天）

- 新工具 CLI 成型；
- `ijipu-mv` 的 `docs/PLAN.md` 改"对 iJipu 的依赖"一节：原来依赖 `ijipu cli -t mp4`，
  改为依赖 `ijipu-cp export`；
- 用 mv 的方案 JSON 跑通一条端到端（文案 → 出片 → 素材包）。

**验收**：mv 一条命令能出片，进度/失败信息可读。

总计约 **3–4 周**（单人、按现有节奏），大头在 M2 和 M3。

---

## 九、验证闸门

| 闸门 | 在哪 | 守什么 |
|---|---|---|
| `npm run smoke` | 应用 | 删完之后引擎/编辑/导出仍正常；删掉的断言要同步删（不许改口径） |
| `npm run verify:app-ui` | 应用 | 菜单/试听/打印这些"点了要动"的地方没被误伤 |
| `npm run verify:video`（搬到新仓库） | 新工具 | 真 mp4 解码/播放/出片闭环（现有脚本已验证过这套流程） |
| **跨仓帧哈希比对** | 新工具 + 应用（各出一片） | 折离前后画面一致 |
| **vendor 一致性** | 新工具 | `vendor/engine`、`vendor/audio` 与源仓库逐字节相同（仿插件 `adj770`） |
| **sidecar 往返 diff** | 新工具 | 读→写→再读，字段不丢不改 |

---

## 十、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 引擎版本漂移 | 新工具画面与应用不一致 | 新工具锁引擎提交哈希；引擎改动两边都跑一遍帧哈希 |
| 搬过去的台面带着应用耦合 | M2 变成"重写 7000 行" | 先照搬 + 换 store 跑通，再逐块重构；不做"一次到位" |
| CLI 行为破坏 | 用户脚本失效 | 发布说明 + 参数对照表 + 保留一个版本期的提示（`-t mp4` 时打印"已迁移，见 …"而不是直接报错） |
| 音色库重复下载 | 用户磁盘翻倍、体验差 | 默认读应用那份目录（第十一节第 7 条） |
| 用户不知道去哪出片 | 功能"消失" | 发布说明、官网文档、下载页并列两个程序（应用内**不留**提示，见拍板第 8 条） |
| 闭源与 AGPL 冲突 | 法律风险，可能要撤回 | 先查引擎是否只有你一个著作权人；第三方依赖逐个核许可（见 11.1） |
| 相机位删了但用户还在用 | 升级即功能消失 | 发布说明提前两版预告；旧版本仍可下载 |

---

## 十一、拍板结果（2026-11-10）

用户当天定下，已生效、不再讨论：

| # | 事项 | 决定 |
|---|---|---|
| 1 | 仓库名 | `ijipu-cp` |
| 2 | 中文名 | **爱出片**（cp = 出片，也取 Create & Play） |
| 3 | 标识 | 应用标识 `com.ijipu.cp`；命令 `ijipu-cp`；项目文件 `<名>.ijv.json` |
| 4 | 分发 | **闭源**，GitHub **私有仓库**（见 11.1 的两个前提） |
| 5 | 音源 | 抽 `packages/ijipu-audio`，两边 vendor 同一份 |
| 6 | 卡片模板库 | 两边各存各的，靠 zip 搬运 |
| 7 | 音色库目录 | 默认读应用那份 `%APPDATA%\com.ijipu.app\soundfonts` |
| 8 | 应用侧 | 彻底删，**一处提示都不留** |
| 9 | 应用版本 | 0.78.0 → **0.79.0**（0.x 下 minor 承载破坏性变更） |
| 10 | 开工顺序 | 先 M0 骨架，再 M1 抽包 |
| 11 | ijipu-mv | 本轮**只同步文档**，不做开发；以后 mv 调 `ijipu-cp` 的 CLI |

### 11.1 闭源分发与 AGPL 的关系（开工前必须先处理）

`@ijipu/engine` 现在是 **AGPL-3.0**。AGPL 约束的是**被许可人**（拿到代码的人），
**著作权人自己**不受自己给出的许可限制。所以你可以同时做两件事：

- `ijipu` 继续以 AGPL-3.0 开源；
- 给 `ijipu-cp` 一份**专有许可**（自己授权自己）。仓库里放一份
  `LICENSE-PROPRIETARY.md`，写清"本仓库闭源；所依赖的引擎为本作者自有版权，
  以专有方式授权本仓库使用"。

**但有两个前提，缺一不可：**

1. **引擎里不能有别人的版权**。你不是唯一著作权人时，无权单方面闭源。
   开工前在 `ijipu` 仓库查一遍：

   ```powershell
   git log --format='%an <%ae>' | Sort-Object -Unique
   ```

   只有你自己 ⇒ 结论成立；有别人 ⇒ 先确认那些贡献是否含版权转让，
   或者把这些文件按 AGPL 保留、只闭源自己写的部分（工程上是拆分，很麻烦）。
2. **第三方依赖允许闭源分发**：`mediabunny`、`spessasynth_core`、`spessasynth_lib`、
   音色库（GeneralUser GS License / FluidR3 MIT）都要核对许可并保留声明。
   新仓库放 `THIRD-PARTY.md`，与应用的 `THIRD-PARTY.md` 同口径。

⚠ 这不是技术问题，处理不好要撤回。**M0 之前查第 1 条，装依赖前查第 2 条。**

### 11.2 还没定的（不挡开工）

1. 应用 0.79.0 的发布说明措辞（要提前预告"视频导出已移出"）。
2. `ijipu-cp` 的图标与品牌色（先沿用应用那套，后面单独做）。
3. 安装包命名、是否走同一套自动更新通道。
4. 要不要给 `.ijv.json` 做系统文件关联（双击打开项目）。


---

## 附：为什么这个方案比"复制一份到新项目"好

复制看起来快，但视频这块还在长（adj1264 到 adj1280 都是最近两周的事）。
复制之后任何一处修复都要做两遍，两边画面会慢慢不一样——这正是 `DYNAMIC-SCORE-PLAN.md`
里"两份实现迟早会漂"那句注释在说的事。本方案的做法是：

- **能共享的（引擎、音源）只有一份**；
- **只有一份使用者的（视频宿主、台面）整体搬走**；
- **两边都要但不需要同步的（卡片库、偏好）各自独立，用文件格式互通**。

这与你定下的"每个功能只能有一个实现方"是同一条原则。
