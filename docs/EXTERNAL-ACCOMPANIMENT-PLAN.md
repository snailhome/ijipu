# 外部伴奏 + 对拍（P0）实现方案

> 依据：`ijipu-mv/docs/P0-REQUIREMENTS.md`（需求单）+ 本仓库 0.74.2（`41a1b60`）的现有实现。
> 写这份文档时的实测/核对都在下面第 1 节，**行号按 0.74.2 记，提交后会移位**。
> 这份文档给"实现会话"用：按第 6 节的四步走，每一步都能单独验收。

---

## 〇、结论先说

1. **能做，而且比想象中省事**：`buildPlaySequence(parsed, layout, bpm)` 本来就收 bpm，
   `createDynamicSession(code, preset, pageConfig, bpm)` 也已经预留了 bpm 入参，
   `exportDynamicVideo` 只要把 `bpm` 透传下去，"谱面跟着伴奏走"就成立了。
   **音频不变速、不改 layout**，这条原则在现有代码里几乎没有阻力。
2. **语法已定稿为 `{jz N}`**（2026-10-24 用户拍板，原 `&jz16` 方案作废）。原因：`&` 后面
   数字会粘连（`0&jz16` 紧接音符 `1` 就成了 161 拍），而 `{jz 16}` 用 `}` 收尾没有歧义。
   实测：`&` 写法现在会被拆成「休止符 + 音符 1 + 音符 6」（见 §1.2），`{}` 写法现在也不认（§3.4）。
3. **间奏长度不能走 `symbols`、也不能进 `tokenDuration`**：前者会被渲染端当"上方小文本"画出来
   （`render/index.ts` 的 `sym` 循环，≈1040–1149 行）并抬高行顶；后者会改 layout 占宽。
   ⇒ 新增独立字段 `interludeBeats`，只在播放时间轴里生效。
4. **时长也不能进 `tokenDuration`**。layout（`layout/index.ts` 的 `tokenDurationOf`）
   与 playback 共用这个时值口径，改它会改占宽 ⇒ 排版动。
   正确做法：**layout 口径不动，只在播放时间轴里加"额外拍"**（§4-A3）。
5. **真正的难点是"间奏 16 拍"的落点**：事件时间和 `barStartsMs` 都是
   `组起点 + 小节起点 + 小节内拍位 × 拍长` 算出来的，加拍必须让**小节起点与小节内拍位
   同时顺延**，否则后面所有音都会错位（§4-A3 给了一处算清的算法）。

### 已定的事（2026-10-24 用户拍板，详见 §4-A、§8）

- 语法只做 `{jz N}`，不做 `&jz16`；`0 {jz 16}` 与 `{jz16}` 都认；**替换**口径（N 是总拍数）
- 纯插静默用隐藏休止 `8{jz 16}`；不挂休止符的独立写法 P0 不做（结构留口子）
- 间奏小节豁免"小节拍数不符"告警，改报 info
- 不给间奏生成虚拟小节（小节号仍按谱面数）

### 还需要你定的（详见 §8）

- 伴奏文件要不要复制进 `%APPDATA%\iJipu\files`（要占空间）
- 对拍工作台放哪：相机位里加一条（我建议）还是独立弹窗
- "合成音（无伴奏）时间奏要不要跳过"——我建议不跳过（单一时间轴），见 §4-A7

### 需要你配合的事（详见 §9）

- **真实谱 + 伴奏 mp3 都不在工作区**（`赤伶/绿野仙踪/知否知否/追光者/一生清贫/花又期二重奏`
  一个都搜不到），P0 验收 ①② 现在没法开工就做
- "间奏略"那几处到底多少拍（谱面没写，"16 拍"是你数出来的还是听出来的）
- 对拍的最终验收只能你听（<50ms 这条我没法自动测）

---

## 一、我看了什么、实测了什么

### 1.1 读过的实现（判断依据）

| 文件 | 我看到的关键事实 |
|---|---|
| `packages/ijipu-engine/src/engine/playback/sequence.ts` | `buildPlaySequence(result, layout, bpm, …)`（≈997 行）；布局拍位 `beatPos` 是**排版算的**；事件时刻 = `passMs + groupStartMs + barStartMsInGroup[bar] + beatPos × beatMs`（≈2459 行）；`barStartsMs` 由同一份小节起点记（≈1944/2476 行） |
| `packages/ijipu-engine/src/engine/layout/index.ts` | 拍位 `beatPos = cumBeat` 是**小节内累计拍**（≈2312/2326 行），时值只用 `tokenDurationOf`（≈6460 行）——**与 bpm 无关** |
| `packages/ijipu-engine/src/engine/parser/tokenizer.ts` | `&` 编码在 **4 处**解析：`collectSuffix`（≈259）、行内独立 `&`（≈531）、`-&`（≈995）、倚音内 `&`（≈789）；编码只收字母，`&dy5/` 的 `5` 故意留给下一个音 |
| `packages/ijipu-engine/src/engine/render/index.ts` | `symbols` 里不认识的编码会走"上方小文本"兜底（≈1144–1149），并抬高上方层顶 |
| `src/export/video/renderer.ts` | `createDynamicSession(code, preset, pageConfig, bpm?)` 已能收 bpm（≈168）；片头用"给事件 atMs 统一加 leadInMs"实现（≈188）；标记段用 `slicePlaySequenceByRange` 切片、时间归零（≈173–186）；`session` 返回 `events/bpm/totalMs/musicEndMs`（≈876） |
| `src/export/video/exportDynamic.ts` | 出片编排；`makeAudio(session)` 是音轨工厂（≈88–97）；**没有 bpm 入参** |
| `src/export/audio.ts` | `renderToAudioBuffer(events, sf2, {bpm})` → 44100 双声道 `AudioBuffer`（调 SpessaSynth 离线渲染） |
| `src/export/video/mp4.ts` | 音轨是 `AudioBuffer`，喂给 Mediabunny；`trimAudio` 把音轨截到画面长 |
| `src/preview/DynamicFrameOverlay.tsx` | 相机位（预览+出片）；音轨缓存 `audioBufferRef`；`renderAudioFor(session)` 走 HQ 音源 |
| `src/store/uiStore.ts` | L1 偏好写法：顶部常量 + `load*` 带 `try/catch` 兜底 + 越界钳制（`panMode`/`rowLeadBeats` 就是现成模板） |
| `src/export/video/cliWorker.ts` | 命令行出片是**第二个进程**，读本机偏好、不写配置 |
| `docs/DYNAMIC-SCORE-PLAN.md` §六 | 旧"对齐约定"写的是 `t = 0 = 音频第 0 个采样`，**与 P0 冲突**（P0 是"谱面 t=0 ↔ 音频 offset"） |

### 1.2 实测：三种写法今天都不成立（语法定稿为 `{jz N}` 之前的历史证据）

**① 原方案 `&jz16`**（已作废，留作"为什么不能用 `&`"的证据）：

```
> node packages\ijipu-cli\dist\ijipu.cjs lint -i ...\_tmp_jz.jps
第 6 行：第 3 小节共 3 拍，与拍号 4/4（每小节 4 拍）不符
```

这份谱第 6 行写的是 `|: 0&jz16 |`。

**结论**：`0&jz16` 被读成「休止符(1 拍) + 音符 1(1 拍) + 音符 6(1 拍)」= 3 拍。
原因就是 `collectSuffix` 只收字母：`jz` 收走，`16` 留给主循环当音符。

再测"只写注记"的写法（你的谱集里就是这种）：

```
> node packages\ijipu-cli\dist\ijipu.cjs lint -i ...\_tmp_jz2.jps
第 6 行：第 3 小节共 1 拍，与拍号 4/4（每小节 4 拍）不符
```

谱：`| 0"16拍间奏略" |`。

**结论两条**：
1. 注记只是文本，引擎现在**完全不看**它，播放时就是 1 拍静默；
2. 这种间奏小节**今天就在报"拍数不符"**。加了间奏标记之后这条告警也不会自己消失
   （因为排版不变、`tokenDuration` 不变）⇒ 需要专门处理（§4-A5，已定为豁免 + info）。

### 1.3 工作区当前状态（会影响开工）

写这份文档的过程中，另一个会话（S5）把 `adj1113`/`adj1114` 提交了。现在：

```
> git status --short   （ijipu/）
?? docs/EXTERNAL-ACCOMPANIMENT-PLAN.md      ← 只有这份新文档
> git log --oneline -2
02f8339 feat(adj1113/adj1114): 导出视频可选「不带片头片尾」；命令行 --card 可选值 + --nosound
41a1b60 chore(release): 0.74.2（导出视频封面 + 片尾网址写完整；插件 0.44.4 跟随）
```

⇒ **工作区是干净的，可以直接开工**。但要留意它刚动了我们也要动的四个文件
（`DynamicFrameOverlay.tsx` / `exportDynamic.ts` / `cliWorker.ts` / `smoke.mts`），带来两处影响：

1. `exportDynamicVideo` 多了 `cards?: boolean`，`cards:false` 时 `leadInMs = 0`。
   ⇒ 伴奏轨的"前置静音"**不能硬编码 3700ms**，必须读会话实际用的 `leadInMs`（§4-D1 已按这个写）。
2. 本文档里引用的行号是按 `41a1b60` 数的，`02f8339` 之后会漂几行，**按函数名找**。

### 1.4 基线冒烟（我跑了，绿）

在 `02f8339` 这个提交上跑的：

```
> npm run smoke
ALL SMOKE TESTS PASSED ✅
> 统计：✓ 4448 条，✗ 0 条
CLI 断言全部通过 ✅（169 项）
```

（第一次跑我自己踩了个坑：把日志 `Tee` 到 `dist-smoke\` 里，vite 清目录时
`EBUSY: unlink dist-smoke\_smoke_baseline.log` 直接构建失败。**日志别写进 `dist-smoke/`**。）

⇒ 第 1 步做完后，`npm run smoke` 必须是"4448 + 新增条数、✗ 仍是 0"。

### 1.5 真实谱集里的「间奏」长什么样（2026-10-24 复核）

用户在 `D:\蜗居笔记\悟乐居杂记\2.曲谱集\<曲名>\` 下放谱与伴奏（同目录）。全库搜「间奏」共 **7 处**：

| 文件:行 | 原文 | 小节里写了什么 |
|---|---|---|
| `一生清贫怎敢入繁华.jps:37` | `&zkh 0"16拍间奏略" 0 0 0 &ykh \|"p:2/4" …` | **4 拍**（`0 0 0 0`），8/4 拍里唯一写了拍数的那处 = 16 |
| `绿野仙踪.jps:10` | `\| 0"间奏图" 0 0 0 \|` | 4 拍，**没写拍数** |
| `绿野仙踪.jps:14` | `\| 0"间奏略" 0 0 0 \|` | 4 拍，没写拍数 |
| `绿野仙踪.jps:19` | `\| 0"间奏略" 0 0 0 \|` | 4 拍，没写拍数 |
| `知否知否.jps:23` | `\| 0"间奏略" 0 0 1/ 2/ :\|` | 4 拍，没写拍数 |
| `追光者.jps:28` | `0 0"间奏略" 0 0 \|` | 4 拍（注释在**第 2 个** `0` 上），没写拍数 |
| `花又期二重奏.jps:35` | `["1." 1-- 0"(间奏)" :\|]` | 1 拍，没拍数（且是括号注释） |

**口径差异（很重要）**：这 7 处的物理写法都是"**用 4 拍的小节占位**"，
注释里的 `16`（唯一一处）是**整段间奏的长度**，不是"这一个 `0` 的时长"。
所以按 §4-A 的替换口径：

- `一生清贫` 那行现在会变成 16 + 3 = **19 拍**（解析期会给一条提示，教改成 `0---{jz 16}`）；
- 其余 5 处没有拍数 ⇒ 间奏按谱面 4 拍播（等于"没生效"），给"没写几拍"的提示。
  ⇒ **这 5 处需要你补真实拍数**（或者改用对拍窗口的分段锚点兜）。

顺带确认了一个事实：`"间奏图"` 是笔误（应为"间奏略"），但也照样按"提到间奏"提示——不影响。

---

## 二、现状核对：P0 五项各缺什么

| P0 需求 | 现有基础 | 缺什么 |
|---|---|---|
| ① 间奏时长 `{jz N}` | 休止符 token 有 `comment`；`tokenDuration` 统一时值；`{}` 已有 `{bz/{dsb/{tp` 分派 | 语法（只在 `{` 那 1 处加分支）、格式化/高亮、字段（`interludeBeats`）、播放时间轴加拍、小节校验豁免 |
| ② 外部音轨 | `<input type=file>` 读取现成（`docStore`/`cardImageStore` 都有先例）；`AudioContext.decodeAudioData` 原生可用 | 选文件 UI、解码、波形、内存/落盘策略 |
| ③ 整段对拍 | `buildPlaySequence` 收 bpm；`createDynamicSession` 收 bpm | 纯函数（锚点→offset/beatMs）、把 bpm 透到出片、`sourceStartMs`（标记段要用） |
| ④ 分段锚点 | 无 | 数据形状 + 分段映射纯函数（全局一个 beatMs） |
| ⑤ 混音 | `renderToAudioBuffer` 出合成音轨 | 伴奏轨构建（补片头静音 + 截取）、两份 PCM 相加、音量 |
| 交互（工作台） | 相机位已有 canvas + 逐帧 `draw(ctx,t)` + 音频播放器 | 波形画布、锚点、循环试听、±5/10ms |
| 存储 | L1 偏好机制成熟（`ijipu.*` + 桌面落 `settings.json`） | 键设计、按谱归档、音频副本策略 |
| 出片 | `exportDynamicVideo({makeAudio})` | `bpm` 入参、外部音轨工厂 |
| 回归 | 不导入伴奏 = 老路径 | 所有新分支都要"无伴奏时完全不进" |

---

## 三、三条关键技术判断（先定，后面照着做）

### 3.1 间奏长度不进 `symbols`、不进 `tokenDuration`，只新增独立字段

理由（实测代码）：
- `render/index.ts` 的 `for (const sym of t.symbols)` 兜底分支会把不认识的编码**画成上方小文本**，
  还会抬高 `aboveTop` ⇒ 谱面多出"jz16"三个字、行高可能变（这条对 `&jz16` 是致命的）；
- 布局端也可能因为 `symbols` 变化而改变（`hasHx` 这类按 `symbols.includes` 判定的逻辑虽然不认 jz，
  但"零宽"这件事最好靠**根本没有字段**来保证，而不是靠"没人读它"）。

⇒ 在 `RestToken` 上加 `interludeBeats?: number`（可选、旧谱面形状不变）。
注记写法（`0"间奏16拍"`）**不写进 token**，用的时候从 `comment` 现读——这样连解析都零风险。

### 3.2 layout 时值不动，只在"播放时间轴"里加拍

- `tokenDuration` 是全引擎唯一的时值口径，layout 用它算占宽、算拍位；
- 间奏必须是**零宽**，所以 layout 这一侧一个数都不能变；
- 播放侧的"加拍"不是改时值，而是**把这一刻之后的播放时刻整体后移**（§4-A3）。

### 3.3 音频不变速 = 换 `bpm`，不是换 `offset`

数学只有一行：

```
audioMs(谱面时刻 t) = offset + t
```

其中 `t` 是**用 bpmAudio 重建后的播放序列时刻**（`t = 拍 × beatMs`）。
所以：

- 对拍解出 `beatMs`（→ `bpmAudio = 60000 / beatMs`）与 `offset`；
- 用 `bpmAudio` 调 `buildPlaySequence` / `createDynamicSession`；
- 音轨从伴奏的 `offset` 处开始，与谱面同速走。

**⚠ 一个必须注意的"退化"**：锚点不能用"毫秒"当自变量。若锚点写成"谱面第 X 毫秒 ↔ 音频第 Y 毫秒"，
方程恒等于 `Y = offset + X`，解不出 beatMs（任何 beatMs 都成立）。
锚点必须用**音乐拍位**（小节/拍，或"从曲首算第几拍"），它是**与速度无关**的量。

### 3.4 为什么是 `{jz N}` 而不是 `&jz16`（2026-10-24 用户拍板）

`&jz16` 后面紧跟音符时，**数字会粘连**：`0&jz16` 后面直接写 `1` 就变成 `&jz161`（161 拍），
必须靠空格或行尾兜底；而空格是"人写出来的"，漏一个就错。`{jz N}` 用 `}` 收尾，
`0{jz 16}0` 也没有歧义。

而且曲部里成对定界符**只剩 `{}` 没被占用**：`()` 连音线/连音组、`[]` 倚音与跳房子、
`<>` 渐强渐弱、`""` 注释、`@@` 乐器包裹。`{}` 目前只给 `{bz`/`{dsb`/`{tp` 三种段头用，
再加一个头关键字 `jz` 是同一套分派逻辑，改动面比 `&jz`（tokenizer 四处 `&`）**更小**。

代价（必须一起做，否则"输入即被改坏"）：
- **格式化**：`formatMusicBody` 现在会把数字间补空格，实测 `{jz 16}` 被改成 `{jz 1 6 }`
  ⇒ 必须把 `{jz … }` 当 `@…@` 那样**整段原样保留**，并保幂等；
- **高亮**：`{`/`}` 目前按小节线色、`jz` 按普通字、`16` 按音符色 ⇒ 给 `{jz … }` 一个 `decoration` 类；
- **分派顺序**：先 `{jz`、再 `{bz/{dsb/{tp`；`jz` **不能**进 `SegmentKind`（进了就被当段画大括号）。

> 实测依据（0.74.2，`0{jz 16} 0 0`）：
> `lint` 报 4 条（`{`/`j`/`z`/多余的 `}`）+ 第 3 小节 5 拍；
> `format` 输出 `0 {jz 1 6 } 0 0`（`16` 被拆开）。临时谱在 `.dsh-tmp/p0/brace.jps`。

### 3.5 为什么不给间奏"生成虚拟小节"（2026-10-24 用户问，已定）

按拍号把 16 拍拆成 4 个 4/4 小节、后续小节号 +4 —— 看起来更"像真实音乐"，但 P0 不做，三条理由：

1. **小节号只有一个真源，就是谱面小节线**。谱面上印的方框小节序号（`adj625`，`showBarCount` 打开时
   每 4 小节印一个）是 layout 按实际小节线数的；`--from 27:3` 与标记段下拉走 `measureMap`，
   按 `barIndex` 累加。要让两边一致，就得让 **layout 也知道虚拟小节**——而方框序号会**占宽度**
   （`barNumberGapNeed`），那就**改了排版**，违反 P0 第一条约束。
2. **间奏拍数不一定是拍号的整数倍**（15 拍、10 拍很常见），拆不出整数小节；
   再加上谱面可以写 `|"p:2/4"` 临时拍号，拆分规则要跟着变——成本远大于收益。
3. **用户是看着谱面标记段的**。标记段下拉显示 `33:1`、命令行 `--from 33:1` 都是谱面口径；
   保持一套号最不容易错。

⇒ 代价（必须写进文档）：间奏之后，谱面小节号比伴奏真实小节少 `N / 每小节拍数`（16 拍 4/4 = 少 4 小节）。
统计/命令行上的具体影响：
- `info` **不报小节数**（只报标题/调号/源码行/分组/字符/问题数）⇒ 没有影响；
- `--from/--to <小节>:<拍>`、`totalBarsOf` 的「谱面只有 N 个小节」报错、标记段下拉 ⇒ **全部按谱面口径**，
  与改动前一致；用户若从伴奏里数小节，要换算。
- 3 分钟上限的"切在最后一个完整小节起点"用的是播放侧的 `barStartsMs`（间奏那一段被算成
  一个 16 拍的"小节"）⇒ 截断点会落在间奏开头，观感反而自然。

---

## 四、改动清单

### A. 引擎：间奏 `{jz N}`

> **语法已定稿（2026-10-24 用户拍板）**：不做 `&jz16`，只做 `{jz N}`。理由见 §3.4。

#### A1. 类型（`packages/ijipu-engine/src/engine/types.ts`，`RestToken` ≈237–259）

```ts
/**
 * 间奏拍数（`0{jz 16}` → 16）：**替换**这个休止符的播放时长（不是"再加 16 拍"），
 * **只影响播放时间轴，不影响排版**（零宽）。
 */
interludeBeats?: number
```

口径（用户 2026-10-24 确认，**替换**）：
- `0{jz 16}` = 这个 `0` 一共响 **16 拍**；
- `0---{jz 16}` = 也是 16 拍（增时线只管排版占宽）；
- 想表达"1 拍休止 + 16 拍间奏" ⇒ 写 `0 0{jz 16}`（= 17 拍），不要靠 `{jz 15}` 去凑。

同理可在 `RhythmToken` 上留同名字段（先不加，`{jz}` 挂在节奏符上直接告警）。

#### A2. 语法（`parser/tokenizer.ts`）——只改 `{` 那**一处**分支

在 `if (c === '{')` 里，**先**用 `matchInterludeHead(content, i)` 探一次，成功就走"挂到前一个休止符"；
失败再走原来的 `matchSegmentHead`（`{bz`/`{dsb`/`{tp`）。

```ts
/** `{jz 16}` → 16；`{jz16}`、`{jz  16 }` 也认；返回 `}` 之后的位置 */
export function matchInterludeHead(content: string, at: number):
  { beats: number; end: number } | null
```

规则（已拍板）：
1. **头关键字小写 `jz`**，后面允许 0~n 个空格，然后**十进制整数**（>0），再允许空格，再 `}`；
   `{jz16}`（无空格）**也认**——`}` 是硬边界，不会歧义。
2. 挂在**前一个休止符**上（跳过中间空白，看最近的 token）：`0{jz 16}` 与 `0 {jz 16}` **等价**。
   （格式化会自动插一个空格，所以带空格那种**必须**等价，否则自动格式化一跑就坏。）
3. 前一个 token 不是休止符（音符、小节线、行首）⇒ 告警
   「`{jz 16}` 要紧跟在休止符 `0`/`8` 后面（如 `0{jz 16}`）」并**不生效**。
4. `{jz` 忘 `}` ⇒ 明确报「`{jz` 未闭合」（复用 `findSegmentEnd`，它已经会跳过引号内的 `}`）。
5. `{jz ...}` **不进 `SegmentKind`**——它不是段，不产生 `segment` token（否则 layout 会当叠加层画大括号、压行高）。
6. 段内（`{bz … {jz 16} …}`）P0 **不支持**，给告警（段层另有时间轴）。
7. 定义在**音符**上（`1{jz 16}`）同上，走第 3 条告警。

#### A2b. `{jz N}` 与注记 `间奏N拍` 是同一件事

- 显式写法：`{jz N}`（推荐）；
- 等价写法（P0 也要认）：注记文本里的 `间奏N拍` 或 `N拍间奏`，例如
  `0"16拍间奏略"`、`0"间奏16拍"`。只从 `comment` 现读，**不写进 token**；
- 两者同时存在 ⇒ **以 `{jz N}` 为准**（显式的赢），注记只当文字。

⚠ **这是一条会改变老谱播放行为的口径**（用户已知并要）：你的谱集里那 5 处
`0"16拍间奏略"` 现在按 1 拍播，功能上线后会变成 16 拍。做法上要让它**看得见**：
① 编辑器/状态栏对"从注记识别出的间奏"给一条 `info`「第 N 小节：间奏 16 拍（来自注记）」；
② `docs/SYNTAX.md` 写明"注记里的 `间奏N拍` 会当真的间奏处理"。不想被识别就把注释改成
不含"间奏N拍"的写法（如 `"16 拍略"`）。

#### A2c. 三种推荐写法（写进 `docs/SYNTAX.md`）

| 写法 | 几拍 | 谱面看到什么 | 什么时候用 |
|---|---|---|---|
| `0{jz 16}` | 16 | 一个 `0`（1 拍宽） | 最省事；小节校验会豁免（见 A5） |
| `0---{jz 16}` | 16 | 一个 `0---`（4 拍宽） | 想让这一行看起来还是 4/4、也不报告警 |
| `8{jz 16}` | 16 | **什么都不画**（隐藏休止，占 1 拍宽） | 纯插静默、不想让人看见"这里有个 0" |

**`0---{jz 16}` 还是 `0{jz 16}---`（用户 2026-10-24 问）**：**两种解析结果完全一样**（都是 16 拍）。
因为 `{jz}` 不产生 token，后面的 `---` 会走"独立增时线挂回前面最近的休止符"那条路，仍然挂到同一个 `0` 上。
但**推荐 `---` 写在前面**：① 与"增时线贴音符"的既有写法一致；② `0{jz 16}---` 看起来像"间奏之后又拖长"，
读谱的人容易误会；③ 前者自动格式化后仍是 `0--- {jz 16}`（只是多一个空格），后者会变成 `0 {jz 16} ---`
（增时线被空格隔开），可读性更差。

⚠ **不要**写 `0{jz 13} 0 0 0` 去凑 4 拍：那会把"间奏多长"藏进算术，
以后多写或少写一个 `0` 就悄悄改了间奏长度（最难查的一类错误）。
要 4 拍宽就写 `0---{jz 16}`——播放仍是 16 拍，注释也还是写 **16**。

#### A2d. 老谱面（注记写法）的两条迁移提示 —— 已实现

`0"16拍间奏略" 0 0 0` 这类写法按注释读成"这个 `0` 是 16 拍"，再加后面 3 拍 = **19 拍**。
为了不让它"静默错 3 拍"，解析期增加两条 `warning`（`interludeDiagnostics`）：

| 情形 | 提示 |
|---|---|
| 注记里有「间奏」但**没写拍数**（`0"间奏略"`） | 「间奏会按谱面时值播放」，hint 教写 `{jz N}` 与 `0---{jz N}` |
| 注记写了 N 拍、**本小节还有其它时值** | 「实际播放 N+其它 拍」，hint 教改成 `0---{jz 16}` |

只对**注记**路径生效——显式 `{jz N}` 的语义没有歧义，不打扰用户。

#### A3. 播放时间轴（`playback/sequence.ts`）

目标：让"这个休止符 = N 拍静音"，其后所有事件（含小节起点、跳房子/反复、段层事件）整体顺延，
**而 layout 一个字不动**。

要改 7 处（都按 0.74.2 行号）：

1. **`blockBeatsOf`（≈1854–1864）**：累加时用 `tokenDuration(tk) + jzExtra(tk)`。
   `jzExtra(tk) = max(0, interludeBeats - tokenDuration(tk))`。
   （若谱面写 `0---{jz 16}`，休止本身 4 拍，额外 12 拍；`0{jz 16}` 额外 15 拍。）
2. **`bsMsOf`（≈1866–1876）**：同样加 `jzExtra`。**小节起点从这里来**，加对了后面小节自动对。
3. **小节内拍位映射**：新增一份 `playBeatOf(group, bar, beatPos)`：
   - 先扫一遍 `result.groups[gi].music.tokens`，按 `小节线 → bar+1、beat 归零` 的口径
     记录每个 `jz` 休止的 `(bar, beatPos, extra)`（这份口径与 layout 的 `barIdx/cumBeat` 完全一致）；
   - 查表：`beatPos + Σ(同 bar 且 at < beatPos 的 extra)`。
4. **事件时钟**：主旋律 ≈2459 行的 `bp * beatMs` 换成 `playBeatOf(...) * beatMs`；
   段层事件（`emitSegmentEvents` ≈2216 行）同样换。**两处都要**，否则 `{bz}/{dsb}` 会错位。
5. **`absBeatOf`（≈2064）**：替谱段（`{tp}`）用的"跨小节绝对拍"是**排版拍**口径，
   不能跟着变。现在它用 `barStartMsInGroup/beatMs` 折算，加了 extra 之后就不纯了
   ⇒ 顺手改成用一份**排版口径的小节起点拍数组**（`barStartBeatsInGroup`），语义更清楚。
6. **`totalMs`（≈3169–3171）**：现在是 `max(lastEndMs, segEndMs)`，**曲末的间奏会被吃掉的**。
   改成：有 `jz` 时 `max(块总长, lastEndMs, segEndMs)`；没有 `jz` 时保持原样（**保证零回归**）。
7. **休止事件自己拉长（§A7）**：该休止的 `durationMs = N × beatMs`、
   `playheadSegs[].beats = N`——色块停住、球跳 N 下、曲末也能撑长视频。

#### A4. 断言（写在 `scripts/smoke.mts`）

- `0{jz 16}` 解析成 `interludeBeats: 16`，且**不产生任何 token**（token 数不变）；
- `{jz16}`（无空格）、`0 {jz 16}`（带空格）与 `0{jz 16}` **三者结果相同**；
- `0"间奏16拍"` / `0"16拍间奏略"` 两种注记都能读出 16（等价写法）；
- `0{jz 16} | 1 |` 的序列：第 1 个音 `atMs = 0`、下一个音 `atMs = 16 × beatMs`；
- **负对照**：把 `interludeBeats` 抹掉 ⇒ 下一音回到 1 拍处（判据必须能变红）；
- 小节起点：`barStartsMs` 里第 2 个小节 = 16 拍（不是 1 拍）；
- 不动排版：同一份谱加/去 `{jz 16}`，`layout` 的每个音符 `x/y/width` **逐字段相等**；
- 曲末 `0{jz 16}` 的 `totalMs` 与 `track.endMs` 都含那 16 拍（A7）；
- **格式化**：`formatLine('Q: 0{jz 16} 0')` 必须得到 `Q: 0 {jz 16} 0`，且
  `formatJps` 幂等（第二次不变）；`formatLine('Q: 0{jz16}')` 不改坏数字；
- **负对照**：把格式化的 `{jz}` 特例删掉 ⇒ 上面那条必须变红（现在实测会得到 `{jz 1 6 }`）。

#### A5. 小节校验（`engine/measures.ts` ≈129–146）——已拍板：豁免

实测现状：`0"16拍间奏略"` 会报「第 3 小节共 1 拍，与拍号 4/4 不符」。

定稿（**实现时改了一处，见第 4 条**）：
1. **含 `{jz}` 的小节跳过"拍数不符"校验**；
2. 想让这一小节按 4/4 正常计拍 ⇒ 写 `0---{jz 16}`（排版 4 拍、播放 16 拍）；
3. **注释里永远写真实间奏拍数**（16），不要写 13 那种"凑出来的数"（见 A2c 的 ⚠）；
4. **偏差记录**：方案原写"改报 `info` 提示"，但引擎的 `ParseError.severity` 只有
   `error | warning` 两级（加一级会牵动应用问题条、插件告警区、CLI 计数的展示与配色）。
   P0 实现选择**静默豁免**（不报任何东西）；"这条间奏有多长"改由
   `docs/SYNTAX.md` 与 A2d 的两条迁移提示承担。

#### A6. 已知限制（写进文档，不要在 P0 里硬解）

- **多声部**：`{jz}` 写在哪个声部，只顺延那个声部。要多个声部一起顺延，就得每个声部都写。
- **`{bz}/{dsb}` 段内**：段层时间轴是另一套构造，P0 不支持（写进去给告警）。
- **小节号不增加**（用户 2026-10-24 问，已定）：`{jz 16}` **不生成"虚拟小节"**，
  谱面小节号、`--from 27:3`、标记段显示的 `33:1` **全都按谱面数**。后果：间奏之后
  谱面小节号比伴奏里的真实小节少 `N / 每小节拍数`（16 拍 4/4 ⇒ 少 4 小节）。
  为什么不做虚拟小节，见 §3.5。
- **曲末间奏**：`0{jz 16}` 在最后一音之后时，如果按 A7 给它一块 16 拍的色块，
  `track.endMs` 会跟着延长 ⇒ 视频也包含这段（**原来"曲末间奏不延长视频"那条限制没了**）。
  若没给色块（只改播放时长），视频仍会在最后一音结束。

#### A7. 间奏期间怎么播、怎么看（用户 2026-10-24 提的方案，附我的分析）

用户方案：**色块停在 `0` 上、跳跳球原地跳 16 下、然后再跟色块走**。分析结论：**技术上可行、
便宜，建议采纳**，但要连"时间轴要不要跟着音源变"一起定。

**(1) 色块 + 球：只要把休止事件自己拉长，不要新机制**

现状（按代码）：`buildPlaySequence` 对所有 `note`/`rest` 项都算 `playheadSegs`
（≈2820 行，不区分 `playable`），所以休止符**应该有**色块；跳跳球也能落在休止块上。
如果实测发现视频里休止没有色块（比如别处有过滤），退路是给 `{jz}` 休止**单独补**一段 seg——
不影响下面的结论。要做的就是两件事：

- `durationMs = N × beatMs`（它本来就不发声，改时长不影响声音）；
- 它自己的 `playheadSegs[].beats = N`（色块覆盖整段间奏）。

于是：色块停在 `0` 上 16 拍、球按小节拍网格在同一个落点弹 16 下、相机不动、
间奏后自动接回下一个音。**不需要新增"时间插入点"机制，也不改 layout。**
（`alignSameBeatSegs` 只处理 <1 拍的段，碰不到它；`maxSpanMs` 变大只影响
`rectsActiveAt` 的回扫窗口，性能无碍。）

间奏块的**配色**：已实现（`adj1119`）——`playheadSegs`/`TimedRect` 带 `interlude: true`，
`playheadBaseOf` 见它返回中性灰 `INTERLUDE_COLOR = rgba(120,124,130,…)`；
视频（`renderer`）与试听（`PreviewPane`/`PlaybackDialog`）共用同一条链路，断言 3 条。

**(2) "合成音时一拍走过" —— 我建议 P0 不做隐式分叉**

用户想法：没有伴奏时，16 拍静音没意义，干脆按 1 拍过去。

- **隐式分叉的代价**：同一份谱会有**两条时间轴**（按音源），`barStartsMs`/`totalMs`/相机
  `pans`/对拍的"拍位"缓存键全都要带上音源；预览（合成音）与导出（带伴奏）时长不同，
  用户会以为导错了；命令行出片（没有伴奏）会跳过、界面出片（有伴奏）不会跳过，
  同一条命令与界面结果不一致，很难解释。
- **建议**：P0 **一条时间轴，`{jz}` 永远生效**。没伴奏时就是 16 拍静音——
  这是"谱面如实呈现"。检测到"谱面有 `{jz}` 但没配伴奏"时给一条提示
  「这份谱有 16 拍间奏，没配伴奏时这 8 秒是静音」。
- 如果确实想要"草稿快进"：做成**显式开关**「无伴奏时忽略间奏」（默认关），
  实现只是给 `buildPlaySequence` 多一个 `interlude: 'honor' | 'ignore'`。
  这类开关属于 P0.5，不塞进 P0。

**(3) "间奏拍数应匹配实际伴奏"**

对，这正是 `{jz N}` 的用法：听伴奏数出间奏几拍（或几小节 × 每小节拍数）填进去。
不是整拍数的情形（比如 15.5 拍）P0 不做小数，用"分段锚点"兜（§4-B）。

### B. 引擎：对拍纯函数（新文件 `playback/sync.ts`）

```ts
/** 一个锚点：谱面拍位（从曲首算的拍序号） ↔ 伴奏**文件绝对**毫秒 */
export interface SyncAnchor { beat: number; audioMs: number; locked?: boolean }
/** 段诊断（相邻两锚点为一段；只用于显示与告警，不参与时间轴） */
export interface SyncSegmentStat {
  fromBeat: number; toBeat: number
  beats: number; ms: number
  /** 段拍速（实数，ms/拍） */
  beatMs: number
  /** 段"实际节拍数"（取整给人看） */
  bpm: number
  /** 该段与全局拟合的偏差（BPM） */
  delta: number
}
/** 对拍结果 */
export interface SyncFit {
  /** 全局拍速（实数；所有锚点最小二乘） */
  beatMs: number
  /** 曲首偏移：拍 0 对应的伴奏毫秒 */
  offsetMs: number
  /** 锚点相对拟合直线的残差（ms，与 anchors 同序） */
  residualsMs: number[]
  /** 每段诊断 */
  segments: SyncSegmentStat[]
}

/** 锚点 → 拟合结果；<2 条返回 null；2 条精确解；≥3 条最小二乘 */
export function fitSync(anchors: readonly SyncAnchor[]): SyncFit | null
/** 拍 → 伴奏毫秒（整段线性：offsetMs + beat × beatMs） */
export function audioMsOfBeat(fit: Pick<SyncFit, 'beatMs' | 'offsetMs'>, beat: number): number
/** 伴奏毫秒 → 拍（反解；波形点位置/滚回重听用） */
export function beatOfAudioMs(fit: Pick<SyncFit, 'beatMs' | 'offsetMs'>, ms: number): number
/** 谱面毫秒（播放序列时间）→ 伴奏毫秒（同一件事，只是入参单位不同） */
export function audioMsOfScoreMs(fit: Pick<SyncFit, 'beatMs' | 'offsetMs'>, scoreMs: number): number
export function bpmOfFit(fit: Pick<SyncFit, 'beatMs'>): number
/** 裁剪区间内？导出/播放都先问它 */
export function inTrimRange(trim: { startMs: number; endMs: number }, audioMs: number): boolean
```

约定（写进函数头注释，改动前先看）：
- **拍 0 = 播放序列时间 0**（曲首，片头静音之前）；`beat` 可带小数（半拍）；
- **`audioMs` 是文件绝对时刻**：掐头去尾不改变它（用户口径）；
- P0 **全局一条 `beatMs`**（最小二乘）；`segments` 只是诊断（见 §4-E6）；
- `beatMs` 越界（< 250ms 即 >240bpm，> 2000ms 即 <30bpm）由调用方拦住，引擎只做数学。

`SyncFit` 是**纯计算**，直接被 sidecar 序列化（`beatMs`/`offsetMs`/`segments`），
界面与 CLI 共用同一份结果——**不许两边各算一套**（AGENTS「数值口径同源」）。

导出到 `playback/index.ts` 与 `engine/index.ts`（与 `buildPlaySequence` 同一段导出区）。

### C. 宿主：伴奏导入 / 解码 / 波形 / 混音

#### C1. 选文件：**先自动找同目录，再手动换**（2026-10-24 定，取代原来的"复制进 files"）

用户口径："伴奏一般随 jps 文件"、"同一首曲子的 jps 和伴奏音频放在同一个目录下"。
所以**不做"复制进 `%APPDATA%\iJipu\files`"**（原路 B 作废）——伴奏就留在曲谱目录里，sidecar 只记文件名。

| 场景 | 做法 |
|---|---|
| 打开对拍台 / 相机位 | ① sidecar 里记了 `audio` ⇒ 直接找 `<谱目录>/<audio>`；② 没有 sidecar ⇒ **列出同目录的音频**（`*.mp3/m4a/wav/flac`）让用户选；③ 一个都没有 ⇒ 「选择伴奏…」 |
| 用户点「换一条…」 | 桌面：Rust `mv_pick_audio`（`tauri-plugin-dialog` 已是 Rust 依赖，照 `ws_pick_dir` 写，`add_filter` 音频）+ 回来后**列同目录其它音频**方便换；网站：`<input type="file">`（拿不到路径 ⇒ 该场景不支持 sidecar，走"仅本次"模式） |
| 伴奏在别处 | 允许，但 sidecar 里存的就**不是**同目录相对名，而是**绝对路径**，并在界面标"这条伴奏不在谱目录里，换机后要重选" |

读文件：桌面用 Rust `mv_read_binary(path)`（返回 `tauri::ipc::Response` 原始字节，**不走 base64**，
10MB 的 mp3 不过管道字符串）；网站用 `File.arrayBuffer()`。

失败处理：解不开（不是音频/损坏）⇒ 明确提示「这个文件解不开，换 mp3/wav/m4a」；
**不静默退回无声**。文件被移走/改名 ⇒ 提示「找不到 `赤伶A调伴奏.mp3`，请重选」，
sidecar 里的参数**保留**（用户重选后能直接复用）。

#### C2. 解码 + 波形（`src/export/video/accompaniment.ts`，新）

```ts
/** 解码（44.1k/48k 都行，后续建轨时统一重采样到 44100） */
export async function decodeAccompaniment(bytes: ArrayBuffer): Promise<AudioBuffer>

/** 波形包络：按桶取 min/max —— **纯函数**，Node 可断言（Float32Array 用上） */
export function waveformPeaks(
  channels: Float32Array[], buckets: number,
): { min: number; max: number }[]
```

- 桶数 = 画布 CSS 宽 × `devicePixelRatio`（例 1200×1.25 = 1500 桶）；**按 (音频引用, 桶数) 缓存**，
  窗口缩放才重算（4 分钟 2 声道 ≈ 2000 万采样，一次 ≈ 20ms，可接受）；
- 波形**两档缩放**：`整曲` / `30 秒窗口`（滚轮缩放、拖动平移）。整曲 1px ≈ 100~250ms，
  只能用来"找段落"；点得准要靠 30 秒档（1px ≈ 25ms）——**毫秒级微调仍然只靠按钮/键盘**；
- 小节刻度：`seq.barStartsMs → audioMsOfScoreMs(sync, ms)` → x；每 4 小节标一个小节号（避免挤）。
  拍刻度：相邻两根小节刻度之间按 `beatMs` 均分（最后一段可能不是整拍，按实际比例）。

#### C3. 建"伴奏轨"（同文件）

```ts
/**
 * 把伴奏裁成"会话时间轴"的一条 AudioBuffer：
 *  - 前 leadInMs 静音（片头卡）；
 *  - 从 sync 算出的起始毫秒开始放；
 *  - 总长 = session.totalMs（放完就静音）。
 * 输出固定 44100 双声道，与 renderToAudioBuffer 一致 ⇒ 后面能直接相加。
 */
export async function buildAccompanimentTrack(
  audio: AudioBuffer,
  map: SyncMap,
  session: DynamicSession,   // 需要 leadInMs / sourceStartMs / totalMs
): Promise<AudioBuffer>
```

实现要点：`OfflineAudioContext(2, ceil(totalMs/1000*44100), 44100)` +
`source.start(leadInMs/1000, audioMsOfScoreMs(map, session.sourceStartMs)/1000)`。
（浏览器会自动把 48k 的 mp3 重采样到 44.1k。）

#### C4. 混音（`src/export/audioMix.ts`，新；纯 PCM）

```ts
/** 两份（或更多）同采样率、同长度的 PCM 按增益相加，clamp 到 [-1,1] */
export function mixPcm(
  tracks: { channels: Float32Array[]; gain: number }[],
  len: number, sampleRate: number,
): AudioBuffer   // 外层薄壳；核心计算是纯函数，Node 可测
```

- `source: 'file'`（默认，推荐）：**直接用伴奏轨**——不调 SpessaSynth ⇒ 出片更快、不依赖音色库；
- `source: 'mix'`：`renderToAudioBuffer(session.events, sf2, {bpm: session.bpm})` + 伴奏轨 →
  `mixPcm([{synth, gain}, {accomp, gain}], ...)`，音量取 sidecar 的 `mix`；
- `source: 'synth'`：今天的路径，完全不变；
- **尾奏**：音轨统一被 `trimAudio(audio, spanMs)` 截到视频长（已有）；伴奏比谱长就截掉，文档写清；
- 两条边界：音量 0 = 静音（允许）；两份都 0 ⇒ 干脆不建音轨（省一次渲染）。

### D. 会话与出片接线（bpm 只在"动态谱"这条链路上生效）

1. **`DynamicSession` 加两个字段**（`renderer.ts` 的返回对象）：`leadInMs`、`sourceStartMs`。
   - `leadInMs`：会话实际用的片头时长（`cards:false` 时是 0，见 §1.3）；
   - `sourceStartMs`：标记段切片前、被切掉的那段时长（`seq.events[cand.i0].atMs`，切之前取）；
     整曲 = 0。
   ⇒ 音轨工厂只靠 `session` 就知道该从伴奏哪儿开始，不必回调方另算。
2. **`exportDynamicVideo` 加 `bpm?: number`**，透传给 `createDynamicSession`（第 4 个参数）。
3. **`makeAudio` 的两种实现**：
   - 界面：伴奏（或混音）→ `buildAccompanimentTrack` / `mixPcm`；
   - 命令行：`--sync` 给了就读 sidecar、按同一套出片（见第 5 条）。
4. **预览**：`DynamicFrameOverlay` 的 `renderAudioFor` 按 `source` 分叉；
   音轨缓存失效条件里加上"伴奏变了 / sync 变了 / bpm 变了"。
5. **命令行（用户 2026-10-24 要求"UI 能做到的命令行也能做到"）**：

```powershell
ijipu cli render -i 赤伶.jps -t mp4 -o 赤伶.mp4 --sync 赤伶.jps.sync.json
# 省略 --sync ⇒ 自动找同目录的 `<输入名>.sync.json`；找不到 = 今天的行为（合成音、谱面 J:）
ijipu cli render -i 赤伶.jps -t mp4 -o 赤伶.mp4 --no-sync          # 明确不用 sidecar
ijipu cli render -i 赤伶.jps -t mp4 -o 赤伶.mp4 --audio 别处/伴奏.mp3  # 覆盖 sidecar 里记的伴奏
```

   - sidecar 里的伴奏按**相对输入文件所在目录**解析；`--audio` 可覆盖（绝对/相对都行）；
   - 终端首行打印：`伴奏：赤伶A调伴奏.mp3（对拍 ♩=96.4，偏移 3.20s，保留段 0:00–3:45）`；
   - 伴奏找不到 / 解不开 ⇒ **退出码 4**（渲染失败）并说清原因，**不静默出声**；
   - 只给 `-t midi/wav` 时 `--sync` 无效（MIDI 与拍速无关；wav 是合成音）——明确报用法错误，不默默忽略。

**bpm 生效范围（用户 2026-10-24 确认）**：

| 链路 | 用哪个拍速 |
|---|---|
| 谱面显示 / 打印 / PDF / 导出图片 | 与 bpm 无关（排版不看 bpm） |
| 试听（`PlaybackDialog`） | **有 sidecar 时给「谱面 / 伴奏」二选**：谱面 = `J:` + 合成音；伴奏 = sidecar 的 `beatMs` + 伴奏（可与合成音混合）。没有 sidecar 只显示"谱面" | 
| 相机位预览 / 动态谱视频出片 | **sidecar 的 `beatMs`**（`bpm = 60000/beatMs`） |
| 命令行出片 | **读了 sidecar 就用 sidecar 的 `beatMs`**；没读就是谱面 `J:` |

相机位里给一行状态：`对拍：♩=96.4（谱面 80）· 偏移 3.20s · [对拍…] [清除]`；
sidecar 的 `codeHash` 对不上时，这一行追加 `（谱面改过，请复核）`。

### E. UI：对拍台（独立台面）与「粗调 + 微调」

#### E1. 独立台面，而不是"第二个系统窗口"（P0 取这个；入口在**试听栏**）

用户要求"对拍是一个独立操作，应该独立一个窗口"。**P0 做成"应用内独立台面"**：
一块盖住整个应用窗口的层（自带标题条与工具条，`Esc` 关闭），相机位先收起、关掉台面再重建会话。
看起来就是"另一个窗口"，但**共用同一份应用状态**。

**入口（用户 2026-10-24 改定）**：放在**试听栏**（底栏「试听」面板的播放/停止按钮下面），
不在相机位——对拍本来就是"边听边对"的活；试听是底栏面板不是模态，所以关掉台面它还在这儿。

**平台（`adj1121`，按工作区 `AGENTS.md` 五）**：对拍是**桌面专属**（解码音频、几十 MB 的
`AudioBuffer`、写 sidecar 都要桌面能力）。入口用 `canUseDynamicVideo()` 挡（dev 全开便于测试），
`SyncDialog` 自己**也有一道闸门**（不许只靠"入口藏起来"）。

为什么不做真正的第二个 Tauri 窗口（技术上能做：`window.__TAURI__.webviewWindow` + 一个 `sync.html` 入口）：
两份 JS 上下文 ⇒ `.jps` 源码、页面配置、解码好的 `AudioBuffer`（几十 MB）、对拍参数都要跨窗口搬，
音频还得在新窗口**重新解码**；而且"预览 = 成片"这条铁律要靠两份状态同步来维持。P0 不值得。
**真有双屏需求**（波形放副屏）：P1 再做，做法是"主窗口建会话、第二个窗口只画波形 + 按钮，
参数通过 Tauri event 同步"，那时再加 `sync.html` 入口。

#### E2. 台面布局（按用户 2026-10-24 的打点/微调思路改过）

```
┌ 对拍：赤伶.jps ───────────────────────── [保存] [×] ┐
│ 伴奏：赤伶A调伴奏.mp3 3:45 · 44.1k  [换一条…]        │
│ 声音：伴奏 ▾  伴奏▮▮▮ 1.0  合成▮▯▯ 0.5  [听一遍]      │
├──────────────────────────────────────────────────────┤
│ 波形（整曲 / 30 秒两档）                             │
│ 开始▏────────保留段────────▕结束   （区间外压暗）      │
│  ┃小节刻度┃拍刻度┃锚点①(锁)┃锚点②┃                  │
├──────────────────┬───────────────────────────────────┤
│ 锚点列表          │ 当前锚点 ②：2:1 / 82.900s          │
│ ① 1:1 / 3.200s 🔒│ [T 打点] [回退 3s 重听]            │
│ ② 2:1 / 82.900s  │ 步长 5ms ▾  −10 −5 −1 +1 +5 +10     │
│ [删除]            │ 拍数 8 拍 · 时长 4.984s · 拍速 96.4 │
│                  │ [锁定] [取消]                      │
├──────────────────┴───────────────────────────────────┤
│ 全局：拍速 96.4（谱面 80）· 偏移 3.20s · 2 锚点       │
│ 段诊断：①→② 96.4（+0.0） ✓   ☑节拍器  残差 ±—ms     │
└──────────────────────────────────────────────────────┘
```

#### E3. 起止点（掐头去尾）——**P0 就做**

用户要求：导入的音频可设起止点，只留中间作为实际播放段，省掉外部音频处理。

- 数据：sidecar 里 `trim: { startMs, endMs }`（**文件绝对毫秒**）；
- 交互：波形上拖两条边界（或输入 `开始 0:12.3 / 结束 3:41.2`），区间外压暗；
- **锚点永远是文件绝对时刻**（用户口径："音频只要不换文件，哪个时点播放的是什么是不会变的"）
  ⇒ 改起止点**不影响已打好的锚点**，锚点落在区间外只给提示「这个锚点在保留段外，导出用不到」；
- 播放/「听一遍」/循环都只在保留段内；导出时 `audioMsOfScoreMs` 落在区间外 ⇒ 静音；
- 若 `offset < trimStart`（谱面开头对应的音频被剪掉了）⇒ 开头那段静音，属于正常结果。

#### E4. 打点（粗调）——按用户思路

**核心：T 打在"文件绝对时刻"，锚点 = 音频时刻 + 谱位。**

| 步骤 | 操作 |
|---|---|
| ① | 对拍台里播放（`空格`），听到要打的那一下按 **T** |
| ② | 弹出小面板：`谱位 [2] : [1]`（默认 = 上一条锚点的谱位，方便对照）+ 「从谱面选音符…」按钮 |
| ③ | 「从谱面选音符」：切到谱面视图点一个音（复用现成的点音符取 id → `measureMap` 换成 `小节:拍`），或直接敲 `2:1` |
| ④ | 确定后**自动"回退几秒重听"**：循环 `[audioMs−3s, audioMs+2s]`，听到这一拍落点 |
| ⑤ | 不准 ⇒ 用微调按钮挪这个锚点（见 E5），再重听，直到"卡上" |
| ⑥ | 卡准后按 **锁定** 🔒（波形拖动、微调都禁用，防误动） |

- `T` 记的 `audioMs` 取 `AudioContext.currentTime`（音频时钟），**不取 React 状态**（否则带一帧延迟）；
- 拍位换算：`beat = barStartBeat(小节) + (拍 − 1)`，`barStartBeat` 来自 `barStartsMs / beatMs`
  （与速度无关，`{jz}` 的额外拍也算进去，与播放口径一致）；
- 同一 `小节:拍` 已有锚点 ⇒ 提示"这个谱位已有锚点，要替换吗？"；
- 锚点可以落在保留段外（只提示，不禁止）——用户可能会先打完再调起止点。

#### E5. 微调（游标卡尺）——按用户思路

**微调的对象是"这一条锚点的音频时刻"，不是全局偏移。**

1. **参考音（节拍器）**：默认**关**（用户定的），手动开；WebAudio 现场合成短促 "嗒"，
   点击时刻 = **拍点**（`barStarts + k·beatMs`）。
   ⚠ **不要**用"球落地那一刻"当参考：跳跳球按 `BALL_LANDING_TIMING.landOffsetBeats = 1/20 拍`
   **故意提前落地**（120bpm 时 25ms、96bpm 时 31ms）。拿它当 click 会把对拍**系统性提前**同样的量。
   球是视觉参考，"嗒"必须落在拍点上（两者差 1/20 拍是设计，不是错）。
2. **循环**：`[锚点−3s, 锚点+2s]`（默认），改锚点后区间跟着动；`L` 开关。
3. **步长**：默认 **5ms**，可选 `1 / 5 / 10 / 50`（用户说"先定一步多长，精细后面再调"）；
   键盘 `←/→` 按当前步长、`Shift+←/→` 固定 1ms。
4. **锁定**：`🔒` 后该锚点不可拖、不可微调（按钮置灰）；「解锁」恢复。
5. **复核**：换另一条锚点重听；再听一个"没打点的地方"（比如中段），看整体是否还咬合——
   不咬合说明速度不对，加一条锚点再解一次。
6. 保存 → sidecar。

**为什么拖拽不做毫秒级**：整曲铺满 1px ≈ 100~250ms、30 秒档 1px ≈ 25ms，拖不出 5ms。
所以拖拽只用于粗定位，毫秒级一律按钮/键盘（界面写这句提示）。

#### E6. 定速（按用户思路 + 我的优化）

用户口径：相邻两锚点为一段；段内 `拍数`/`时长` 已知 ⇒
- **显示用的"实际节拍数"** = `段拍数 / 段时长(秒) × 60`（**取整**给人看）；
- **对齐用的"拍速"** = `段时长 / 段拍数`（**实数 beatMs**，喂给播放序列/球/相机）。

我的优化（**要你确认**）：

1. **全局只用一条 beatMs**：由**所有锚点最小二乘**求（两条锚点时它就是精确解；
   多锚点时比"首末两点"稳，能吃掉单点误差）。存 sidecar 的 `tempo.beatMs`。
2. **每段的拍速只做"诊断"**（不参与时间轴）：sidecar 里 `segments[]` 记每段的
   `fromBeat/toBeat/beatMs/bpm`；相邻两段 BPM 差 **> 1** ⇒ 告警
   「①→② 97.2、②→③ 96.1，差 1.1：确认锚点是否点准」。
   曲首、曲尾的"单锚点段"不单独定速，**显示相邻段的值**（你说的"参考相邻段"）。
3. **残差**：每条锚点相对拟合直线的偏差（ms）；> 20ms 提示「锚点互相矛盾」。

**为什么 P0 不做"每段各自变速"**（要你拍板）：
- 现有播放序列 `buildPlaySequence(…, bpm)` **只有一个 bpm**；每段变速要在演出时间轴上做
  **分段线性重映射**，事件、`barStartsMs`、色块分段、球网格、相机 keyframe 全都要跟着改；
- 反复/跳房子让"第几小节第几拍"与"演出第几秒"不是一一对应，分段锚点还要处理"第几遍"；
- 一首歌绝大多数是恒速，多锚点的价值本来就是"提高精度"而不是"应对变速"。
- **判据**：拿真实伴奏先测两段（前段/后段各一对锚点）算出的 BPM 差；**< 0.5 就恒速够用**，
  > 1 再上分段（那是 P0.5，约 +1.5 天，且要求"锚点尽量落在小节线上"）。

#### E7. 键盘（对拍台内生效）

| 键 | 作用 |
|---|---|
| `空格` | 播放 / 暂停 |
| `T` | 打点（记当前 `AudioContext.currentTime`） |
| `←` / `→` | 当前锚点 −步长 / +步长（`Shift` = 1ms） |
| `L` | 循环开关 |
| `G` | 节拍器开关 |
| `Esc` | 关台面（有未保存改动先问） |

#### E8. 性能与状态

- 波形峰值只算一次（`waveformPeaks(channels, buckets)`，纯函数，可 Node 断言），按"桶数 + 音频"缓存；
- 播放头用 `requestAnimationFrame` + `canvas` 重绘（别用 React state 驱动）；
- 改 `offset/beatMs/锚点` **不重建会话**（台面里不需要画面）；关台面时才把新 `bpm` 交给相机位重建 ——
  否则每按一次 ±5ms 就重建一次会话，会卡。

### F. 存储：**sidecar 文件（已定，2026-10-24）**

用户口径（原话要点）：`.jps` 是**自成一体的**（显示/打印/播放/出片都靠它），伴奏对拍只是**附加**；
把伴奏/对拍写进谱面设置，一旦伴奏换了或没同步复制，设置就失效；全局设置又只在本机有效、不好交流。
⇒ **用 sidecar**：

| 项 | 定稿 |
|---|---|
| 文件名 | `赤伶.jps.sync.json`（**在原名后加 `.sync.json`**，不造新扩展名；列目录时紧挨着主文件） |
| 位置 | 与 `.jps` **同目录**；伴奏也只存**相对文件名**（同目录约定） |
| 编码 | UTF-8 无 BOM、2 空格缩进、LF（与 `.jps` 同规矩） |
| 谁读它 | 对拍台（读写）、相机位（只读）、`exportDynamicVideo`（只读）、以后的 CLI/mv（只读） |
| 谁写它 | **只有对拍台**（"保存"按钮；关窗前有脏标记要提示） |
| 插件端 | Obsidian 里谱是笔记正文、没有同目录文件 ⇒ 退化为 L1（`ijipu.mvSync`），界面注明"只在本机" |

**形状**（`version` 用于以后迁移）：

```json
{
  "version": 1,
  "audio": "赤伶A调伴奏.mp3",
  "audioDurationMs": 245300,
  "trim": { "startMs": 0, "endMs": 245300 },
  "anchors": [
    { "beat": 4,  "audioMs": 3200,  "locked": true },
    { "beat": 132, "audioMs": 82900, "locked": false }
  ],
  "tempo": { "beatMs": 622.4, "offsetMs": 3200, "bpm": 96.4 },
  "segments": [ { "fromBeat": 4, "toBeat": 132, "beats": 128, "ms": 79700, "beatMs": 622.66, "bpm": 96.4 } ],
  "key": "A",
  "mix": { "source": "file", "accomp": 1, "synth": 0.5 },
  "codeHash": "a1b2c3d4",
  "updatedAt": "2026-10-24T09:30:00+08:00"
}
```

- `anchors` 是**原始输入**（用户打的点，含 `locked`）；`tempo`/`segments` 是**解算结果**，
  每次保存重算（机读，不要手改；手改 `anchors` 才对）；
- `anchors[].audioMs` 是**文件绝对毫秒**，与 `trim` 无关；
- `trim`：掐头去尾，只播/只导出这一段（`audioMs` 落在区间外 ⇒ 静音）；
- `segments` 只做**诊断显示**（P0 全局一条 `beatMs`，见 §4-E6）；
- `key` 是手选的伴奏调性（只用于提示，不参与计算）；
- `mix` 里 `source: 'file' | 'synth' | 'mix'` 与两条音量也放 sidecar——
  因为"这首歌用伴奏还是合成音"是**这首歌的决定**，不是这台机器的偏好；
- `codeHash`：存盘时谱面的 FNV-1a 指纹。打开时 hash 变了 ⇒ 提示「谱改过，锚点请复核」（**不自动删**）。

**J: 的处理（用户 2026-10-24 问，确认）**：
- 谱面的 `J:` **一个字不改**：编辑器、预览、PDF/打印、试听默认全按 `J:`；
- **运行期**（相机位 / 动态谱视频）用 sidecar 的 `beatMs` 重建播放序列；
- **片头卡**上写 `♩=96（原谱 80）`（只在两者不同时带括号）——卡片是视频的一部分，观众看的是"实际速度"，
  你自己回看也能知道"这是照着伴奏调的"；谱面本身不显示这个差异。
- 换句话说：**sidecar 只提供"对齐基准"，不改谱面语义**。

**L1 只留"界面偏好"**（与具体谱无关的）：节拍器开关、波形缩放档、上次用的窗口位置等。


### G. 文档与断言

- `docs/SYNTAX.md` 增 `{jz N}` 一节（放在"临时段 `{bz}`/`{dsb}`"后面，紧邻它更自然），写清：
  只能跟在休止符后（`0{jz 16}` / `8{jz 16}`）、N 是**总拍数（替换）**、
  `0---{jz 16}` 只加排版宽不改播放时长、**不影响排版**、多声部要各声部都写、段内不支持、
  **不加小节号**（间奏后谱面小节号比伴奏少 N/每小节拍数）；同时说明注记 `间奏N拍` 是等价写法；
- `docs/DYNAMIC-SCORE-PLAN.md` §六 的"对齐约定"要改（旧口径 `t=0 = 音频 0` 作废，
  新口径 = `audioMs = offset + 谱面时刻`，片头静音由 `leadInMs` 补）；
- `docs/USER-GUIDE.md` 增"外部伴奏与对拍"一节；
- `docs/ERRORS-LOG.md`：本功能踩的坑按 `E-2026-NNN` 记；
- `docs/SETTINGS-AUDIT.md`：登记 3 个新 L1 键；
- `scripts/verify-app-ui.mjs`：新按钮/新面板的"点了要动"必须真浏览器点一遍（adj959 的教训）。

---

## 五、数据流（一图看清）

```
导入 mp3 ──decodeAudioData──▶ AudioBuffer（内存/可选落盘）
                                   │
谱面 ──parse──▶ layout（不动）      │
        └──▶ buildPlaySequence(parsed, layout, bpmAudio)   ← bpmAudio 由对拍反推
                    │
                    ├─ events（atMs = 拍 × beatMs + leadIn）
                    ├─ barStartsMs ──▶ 相机/跳跳球/波形小节刻度
                    └─ totalMs
                                   │
对拍 SyncFit（beatMs/offsetMs）+ trim ──▶ buildAccompanimentTrack(audio, fit, trim, session) ──▶ 伴奏轨
                                   │
（混合模式）renderToAudioBuffer(events, sf2) ──▶ 合成轨 ──mixPcm──▶ 最终音轨
                                   │
                        createDynamicSession(...) ──▶ draw() 逐帧
                                   │
                          encodeMp4(session, {audio}) ──▶ MP4
```

---

## 六、分四步落地（每步可独立验收）

> 编号取当时 `git log` 最大 `adj` +1（`02f8339` 之后是 `adj1115`；开工前再看一眼，别的会话可能先占）。

### 第 1 步（引擎）：`{jz N}` 打通 —— ✅ 已完成（`adj1118`，2026-10-24 凌晨）

**实际改了这些**（比原计划多两处，都是实测踩出来的，见 `ERRORS-LOG` 的 `E-2026-526`）：

| 文件 | 改了什么 |
|---|---|
| `engine/interlude.ts`（新） | `interludeBeatsOf`（`{jz N}` + 注记两种语序）、`interludeExtraBeats`、`interludeDiagnostics`（老写法两条迁移提示） |
| `engine/types.ts` | `RestToken.interludeBeats?`（可选，旧谱面形状不变） |
| `engine/parser/tokenizer.ts` | `matchInterludeHead` + `{` 分支先判 `jz`（不产生 token）；三种错误写法各一条告警；`findSegmentEnd` 跳过 `{jz}` 的 `}` |
| `engine/format/format.ts` | `{jz … }` 整段原样保留、归一成 `{jz 16}`（否则 `16` 被拆成 `1 6`） |
| `engine/highlight/jpsHighlight.ts` | `{jz 16}` 整体按 `decoration` 着色 |
| `engine/playback/sequence.ts` | 额外拍进 `blockBeatsOf`/`bsMsOf`；`playBeatOf` 补"同小节内"的拍位；`absBeatOf` 改用**排版拍**数组；休止事件时长 = N 拍、色块整段罩住 |
| `engine/measures.ts` | 含间奏的小节**静默豁免**"拍数不符" |
| `engine/parser/parser.ts` | 把 `interludeDiagnostics` 并入 `errors` |
| `docs/SYNTAX.md` | 新增 2.12b「间奏标记 `{jz N}`」（三种推荐写法 + 口径 + 老写法兼容） |
| `scripts/smoke.mts` | 新增 `adj1118` 一组断言（28 条，含 5 条负对照） |

**验证（真跑）**：`npm run smoke` → `ALL SMOKE TESTS PASSED ✅`，`✓ 4476 / ✗ 0`，CLI 176 项全绿；
`npm run check:encoding` 通过（445 个文件）。
真谱复核：`一生清贫怎敢入繁华.jps:37`（`0"16拍间奏略" 0 0 0`）→ 提示"实际播放 19 拍、建议 `0---{jz 16}`"；
`绿野仙踪.jps:10/14/19`、`知否知否.jps:23`（只写"间奏略"）→ 提示"没写几拍，按谱面时值播放"。

**真谱零位移实测**（不只是玩具谱）：把 `绿野仙踪.jps` 第 10 行的 `0"间奏图" 0 0 0` 改成
`0"间奏图"{jz 16} 0 0 0`，两份都 `render -t svg` —— 输出 **哈希完全相同**
（`90DC53E2…981A`，149505 字节）⇒ 加了间奏标记，谱面一个字都没动。

**与计划的偏差**：① 小节校验改为**静默豁免**（引擎没有 `info` 级别，见 §4-A5 第 4 条）；
② 新增 `findSegmentEnd` 的跳过逻辑与 `interludeDiagnostics` 两处（计划外，但不做就会误导用户）。

### 第 1b 步（已做，`adj1119`）：间奏灰 + 片头卡速度 + 对拍地基

| 文件 | 改了什么 |
|---|---|
| `engine/playback/playhead.ts` | `INTERLUDE_COLOR`（中性灰）+ `PlayheadSeg`/`PlayheadPos` 认 `interlude`，`playheadBaseOf` 优先取灰 |
| `engine/dynamic/types.ts` / `timeline.ts` | `TimedRect.interlude` 透传（视频侧） |
| `engine/playback/sequence.ts` | 间奏色块打 `interlude: true` |
| `src/dialogs/PlaybackDialog.tsx` / `src/store/docStore.ts` | 试听轨道也透传（谱面预览同色） |
| `src/export/video/cardLayout.ts` | `tempoLineOf`（片头卡写 `♩=96（原谱 80）`，纯函数可断言） |
| `src/export/video/renderer.ts` | 片头卡速度行改用 `tempoLineOf(meta, beat)` |
| `engine/playback/sync.ts`（新） | `fitSync`（2 条精确 / 3+ 最小二乘 / 残差 / 段诊断）、`audioMsOfBeat`、`beatOfAudioMs`、`residualBeatsOf`（**告警按"偏 > 1 拍"**）、`inTrimRange`、`displayBpm` |
| `src/export/video/syncDoc.ts`（新） | sidecar 解析/序列化/路径（`赤伶.jps.sync.json`）/指纹/`makeSyncDoc`/`stale` |

**验证**：`npm run smoke` → `✓ 4501 / ✗ 0`，CLI 176 项；新增 `adj1119` 断言 25 条（含负对照：
普通块不是灰、坏 JSON/高版本/缺 audio 都报错、手改 tempo 不信、同拍位去重、裁剪夹紧）。

### 第 2 步（宿主）：sidecar + 对拍台骨架（波形 + 起止点 + 打点 + 单锚点）—— 🟡 第一版已落地（`adj1119`/`adj1120`）

**这一版能用了**（还没接 Rust 文件 IO）：

| 件 | 现状 |
|---|---|
| 对拍台 | `src/dialogs/SyncDialog.tsx`（应用内独立台面，`Esc` 关）；入口 = **试听栏「对拍…」**（桌面专属，`canUseDynamicVideo()` 挡） |
| 伴奏导入 | `<input type=file>` → `decodeAccompaniment`（桌面原生选择器 + 同目录自动找 = 下一步） |
| 波形 | `waveformPeaks`（纯函数）+ canvas：包络、小节/拍刻度、锚点、播放头、整曲/30 秒两档 |
| 起止点 | 波形上「起点=当前 / 终点=当前 / 整曲」；**锚点记文件绝对毫秒** |
| 打点 | `T` → 输入 `小节:拍`（默认上一条锚点+1 拍）→ 记下 → **自动回退 3 秒重听** |
| 微调 | 每条锚点 ±1/5/10ms（步长可选 1/5/10/50）、🔒 锁定、删除；循环 + 节拍器（默认关） |
| 对拍数学 | `fitSync`（2 条精确 / 3+ 最小二乘）、段诊断、**偏 > 1 拍告警** |
| 伴奏进片 | 相机位按 sidecar 的 `beatMs` 重建会话；预览/出片用 `buildAccompanimentTrack`（片头静音 + trim + 标记段 `sourceStartMs`）；`mix` 时叠合成音 |
| 存储 | **L1 兜底**（`ijipu.mvSync.last`，按文件名）；`赤伶.jps.sync.json` 的读写等 Rust |

**还没做**：Rust 的 sidecar 读写 + 原生选文件 + 同目录音频列表；试听「谱面/伴奏」二选；
CLI `--sync/--no-sync/--audio`；调性提示。

**验证**：`npm run smoke` → `✓ 4511 / ✗ 0`、CLI 176 项；`npm run build` 通过（真实入口能打包）；
新增 `adj1119` 25 条 + `adj1120` 10 条断言；`adj1121` 修白屏 + `verify:app-ui` 新增 4 条（现在 116 项）。

### 第 3 步（对拍 + 出片，1.5 天）：两锚点定速 + 出片带伴奏

- `sync.ts`（`fitSync` 最小二乘 + 段诊断）、多锚点、锁定、节拍器、残差与告警；
- `exportDynamicVideo` 收 `bpm`；`buildAccompanimentTrack`（trim + offset + leadIn）；混音三档；
- **验收**：P0 验收 ①（赤伶 + 伴奏）人耳 <50ms；导出 MP4 音画同源、时长一致。

### 第 4 步（打磨，1 天）：试听「伴奏」模式 + CLI + 调性 + 中性灰

- `PlaybackDialog` 的「谱面 / 伴奏」二选（有 sidecar 才显示）；
- CLI `--sync / --no-sync / --audio`（含自动找 sidecar、终端首行、退出码 4）；
- 调性提示（手选比对）、间奏块中性灰、片头卡 `♩=实际（原谱 X）`；
- **验收**：P0 验收 ②（"间奏略"那份加 `{jz N}` 后能对齐）；验收 ③（无伴奏回归）；
  `npm run smoke` 全绿 + `npm run verify:app-ui` 点一遍新台面。

### 第 5 步（可选，**要你拍板**）：真·分段变速

若实测某首歌前后段拍速差 > 1（§4-E6 的判据），再做"每段一个 `beatMs`"：
在演出时间轴上做分段线性重映射（事件 / `barStartsMs` / 色块 / 球网格 / 相机），约 +1.5 天。

---

## 七、目前存在的问题（按"会不会挡路"分三档）

### 会挡路

- **P1 语法今天是"三种写法全不成立"**（实测 §1.2/§3.4）：`&jz16` 被拆成两个音、`{jz 16}` 报
  "无法识别"且格式化会把 `16` 拆成 `1 6`。语法不改，后面全是空中楼阁。
- **P4 真实谱不在工作区**（已解决）：用户在 `D:\蜗居笔记\悟乐居杂记\2.曲谱集\<曲名>\` 下，
  `.jps` 与伴奏 mp3 **同目录**（如 `赤伶\赤伶.jps` + `赤伶\赤伶A调伴奏.mp3`）。
- **P5 伴奏音频**（已解决）：同上。注意同一目录常有多条音频（伴奏/演唱/陶笛版），
  选哪条要用户指定，P1 建议在界面里给一个"音频"下拉（列同目录的 mp3/m4a/wav）。
- **P3 四个关键文件刚被另一个会话改过**（`02f8339`，`adj1113/1114`）：`DynamicFrameOverlay.tsx` /
  `exportDynamic.ts` / `cliWorker.ts` / `smoke.mts`。现在工作区干净、可以开工，但**动手前先看一眼
  `git status`**：如果又出现别人的未提交改动，先停下来问，别硬改（本工作区允许会话并行）。

### 会踩坑

- **P6 引擎改动要进 Obsidian 插件**：`types.ts` / `tokenizer.ts` / `sequence.ts` 都在
  `vendor/engine` 同步范围 ⇒ 插件要同步引擎、升插件版本、跑插件 smoke（`adj733/767/770` 三道闸门）。
  只改应用不同步插件 = 插件里 `{jz}` 不生效，而且闸门会红。
- **P7 旧文档口径冲突**：`DYNAMIC-SCORE-PLAN.md` §六 写死 `t=0 = 音频第 0 采样`，
  与 P0 的"谱面起拍 ↔ 音频 offset"相反。照旧文档实现必错。
- **P2 间奏小节一直在报"拍数不符"**（实测 §1.2）。P0 已定为豁免 + info（§4-A5）。
- **P8 片头卡显示的速度是谱面 `J:`**（`renderer.ts` 的 `introMeta.tempoNum`）。对拍后实际 bpm
  变了（比如谱面写 80、实际 96.4），卡片会写错。要么改成显示实际 bpm，要么按谱面写（要拍板）。
- **P9 间奏期间画面**：P0 方案已定（§4-A7）——色块停在 `0` 上、球原地跳 N 下，
  所以"8 秒完全不动"的问题**不再是问题**；剩下的是"同一个点跳 16 下会不会呆"，看首版效果再调。
- **P10 3 分钟上限与对拍互相影响**：`maxMs` 会"切在最后一个完整小节"，bpm 一变，切点也变；
  音频会被 `trimAudio` 截到画面长（正常，但要写进用户文档，否则用户以为丢音乐）。
- **P11 伴奏比谱长（尾奏）会被截掉**：P0 不做"尾部多留 N 秒"。

### 只是限制（写进文档即可）

- **P12 曲末间奏**：按 §4-A7 给色块后能延长视频；不给色块（只改播放时长）就仍停在最后一音。
- **P13 段内 `{bz}/{dsb}` 的 `{jz}` 不支持**；多声部要每个声部各写一份。
- **P14 <50ms 这条没法自动测**：对拍只能人耳。自动化能守的是"数学"和"接线"：
  映射公式、序列顺延、混音长度、`bpm` 是否真的透传到会话。
- **P15 CLI 出片不带伴奏**（**已改口径**）：用户 2026-10-24 要求"UI 能做到的命令行也能做到"
  ⇒ `render -t mp4` 增加 `--sync <json>`（缺省自动找同名 sidecar）、`--no-sync`、`--audio <path>`，
  见 §4-D 第 5 条。**这是 P1 的一次扩容**（原 P0 单子写"不放开 CLI"）。
- **P16 波形内存**：4 分钟 mp3 解码后 ≈ 80MB（44.1k 双声道 Float32）。P0 只留一份、
  关相机位就释放；不做多首缓存。

---

## 八、拍板清单（2026-10-24 全部定完，只剩实现顺序）

**已定**：

| # | 结论 |
|---|---|
| 1 | 语法只做 `{jz N}`；`0 {jz 16}`、`{jz16}`、`0{jz 16}` **三者等价**；**替换**口径（N = 总拍数） |
| 2 | 间奏小节**豁免**"小节拍数不符"，**静默**不报（引擎没有 info 级别，见 §4-A5 第 4 条） |
| 3 | 纯插静默用 `8{jz 16}`；不挂休止符的独立写法 P0 不做（结构留口子，以后加 `interlude: 'insert'`） |
| 4 | **不生成虚拟小节**（小节号仍按谱面数，§3.5） |
| 5 | 间奏画面：色块停在 `0` 上、球原地跳 N 下（§4-A7），不需要新机制 |
| 6 | 合成音（无伴奏）**不跳过**间奏（单一时间轴）；要"草稿快进"以后做显式开关 |
| 7 | **对拍参数存 sidecar `赤伶.jps.sync.json`**（同目录、不造新扩展名）；伴奏只记文件名（同目录，别处则记绝对路径）；**不复制**伴奏进 `%APPDATA%` |
| 8 | 谱面 `J:` **一个字不改**；运行期（相机位/动态谱出片）用 sidecar 的 `beatMs`；片头卡写 `♩=96（原谱 80）`；**试听**在有 sidecar 时给「谱面 / 伴奏」二选，无 sidecar 只有谱面（§4-D） |
| 9 | 对拍台 = **应用内独立台面**（全窗口层，Esc 关），P0 不做第二个系统窗口（§4-E1） |
| 10 | 交互 = **T 打点（文件绝对时刻）+ 输入/点选谱位（`2:1`）+ 回退几秒重听 + 每锚点微调 + 锁定**（§4-E4/E5） |
| 11 | **起止点（掐头去尾）P0 就做**；锚点永远记文件绝对时刻，改起止点不影响锚点（§4-E3） |
| 12 | 定速：**全局一条 `beatMs`（最小二乘）+ 每段拍速只做诊断**；相邻段 BPM 差 >1 告警（§4-E6，**待你确认是否要真分段**） |
| 13 | 节拍器**默认关**；点击时刻 = **拍点**，**不用球落地那一刻**（球按设计提前 1/20 拍，会把对拍系统性带偏 25~31ms） |
| 14 | **命令行也能带伴奏**：`--sync`（缺省自动找）/ `--no-sync` / `--audio`（§4-D 第 5 条） |
| 15 | 混音三档 `file / synth / mix`，音量存 sidecar；默认 `file`（伴奏），不依赖音色库 |
| 16 | 伴奏调性：**手选下拉**（P0 不做自动识调），只用于提示 |
| 17 | 尾奏比谱长 ⇒ **截掉**（`trimAudio` 已有），文档写清 |
| 18 | 间奏块配色 **中性灰**（还没实现，见下）；插件 vendor **已同步**，插件版本/发版待你定 |

**还没做的两件小事**（P0 余项）：

### 4-G 「长度不一致」的两种处理（用户 2026-10-24 拍板：**两个都做**）

**判据**（都从已解算的 `fit` 得出，不改 sidecar 结构）：

| 情况 | 判据 | 台面（已完成 adj1139） | 出片/相机位（**已完成 adj1148**） |
|---|---|---|---|
| 伴奏比谱面长（前面多一段） | `fit.offsetMs − trim.startMs > 60ms` | 波形上淡黄标出「前奏（等谱面开始）」；播放到这段时谱面时刻夹在 0 ⇒ **球停在第一个音** | 需要 **pre-roll**：视频开头这段音频照放，谱面定格在第 1 拍（不显示片头卡），`totalMs += headWaitMs` |
| 谱面比伴奏长（开头几拍要跳过） | `fit.offsetMs < 0` 且用户接受 | 「快捷对齐」按钮：**0 秒 = 谱面 N:M**（写一条 `audioMs = 0` 的锚点） | 已天然正确（`offsetMs < 0` 时谱面开头就在音频 0 之前，出片按 `trim` 从音频 0 开始、谱面早已开始） |

**台面的两条快捷入口**（都是"打一条特殊锚点"，不引入新字段、命令行/插件都能读）：
- 「谱面第 1 拍 = 当前播放头」⇒ `addAnchor({ beat: 0, audioMs: 播放头 })`；
- 「0 秒 = 谱面 N:M」⇒ `addAnchor({ beat: beatOfBarBeat(N,M), audioMs: 0 })`。

**adj1148 的 pre-roll 实现要点（已完成）**：1. `createDynamicSession(..., { headWaitMs })`：把 `leadInMs` 与 `headWaitMs` 分开——
   `headWaitMs` 段**不显示片头卡**，画面用 `draw` 的定格帧（谱面第 1 拍 + 球原地弹）；
2. `renderer.ts` 的 `shiftSequenceBy(seq, leadInMs)` 之后再 `shiftSequenceBy(seq, headWaitMs)`，`totalMs` 同样加；
3. 伴奏轨 `accompanimentPlan` 的 `whenSec` 前移到片头卡结束（源起点 `trim.startMs`，不放过头段），`playbackRate` 不变；
4. 断言（`smoke.mts` 的 `adj1148`）：`offsetMs = 1200` 时 `totalMs` 比不等待长 1200，且 `draw(600)` 与 `draw(0)`
   命中**同一条色块**（用引擎 `rectsActiveAt` 验证；负对照是"不取定格时 600ms 会换块"）；
5. 只对**整曲**生效（标记段从曲中间开始，没有前奏）；`headWaitMs = preRollMsOf(tempo, trim)`，相机位与出片同值，
   `syncRev` / `headWaitMs` 都在"重建会话"的依赖里。

### 4-H 「空小节」编辑器告警：**先不做**（用户 2026-10-25 定，方案 C）

用户口径：「空小节通常是谱有错误，一般不会发生，可以在编辑器里给告警的」→ 试做后定为**先不做**，
等真实实例再定改法。留档结论（谁接手都别重复踩）：

- **判据**：两小节线之间**一个 token 都没有**才算空小节（不是"没有带时值的元素"——
  `| &dc |`、`| {jz 16} |`、`| @乐器@ |` 都不是空小节）；
- **坑 1**：`docs/SYNTAX.md` 示例三里有 `|] |:` **紧挨着**，结构小节线（`|:` `:|` `:|:` `|/`）旁的空档
  不是空小节，否则官方示例直接被刷成告警；
- **坑 2**：同一份引擎实现会让 `verify:app-ui` 的两条断言变红（「打字出未保存点」+「新建确认条」），
  A/B 对照确认是这条告警引起、单独探针里打字正常 ⇒ **要么放 app 侧 problems 层，要么先 bisect 那条交互**；
- 台面侧已有兜底：缺号（空小节没有时间片）会把号补在后一根小节线上（`adj1146`，`barLabelsOf`）。

### 4-I 混音在试听里「播放中即时生效」（adj1149，用户 2026-10-25 实报）

用户原话：「如图里的滑条是什么用途，滑动没有什么变化，如果是音量，请实现，包括声音的选择没有变化，
都是伴奏播放」。两条根因都**不是"没接"**，而是"只在开播那一刻接了一次"：

- **音量**：`startPlayback` 把 `mix.accomp/synth` 写进 GainNode 之后就不再管；播放中拖滑杆只改 store。
  （`adj1128` 的浏览器用例是在**播放前**拖到 0.6 再量，所以当时是绿的、用户一播中拖就是死的。）
- **声音档**：同样只在开播时读一次；换档不会停旧轨/起新轨 ⇒ 听感"选什么都还是伴奏"。

做法：

1. 两条轨各存 GainNode 引用（`accGainRef` / `synthGainRef`），`doc.mix` 变化时用 `setTargetAtTime`（20ms 平滑）实时改；
2. `doc.mix.source` 变化且正在播放 ⇒ 从当前播放头重开（循环中从循环起点重开）；
3. 合成音缓存键改用源码指纹（`codeFingerprint`），不再只看 `code.length`（改音高不换字数会放旧旋律）；
4. 只有合成音且渲染失败 ⇒ 按 `synthFailed` 文案回退到伴奏（以前是"什么都不响"）；
5. 从前奏里起播合成音时按 `offsetMs − 当前音频时刻` 延迟（否则合成音比伴奏早一段，音画错开）；
6. 滑杆标签写全（伴奏音量 / 合成音音量）+ 百分比读数；`title` 写明"改了就生效"。

断言：`smoke` 的 `adj1149` 五条接线闸门；`verify:app-ui` 在**播放中**把伴奏音量拖到 0.3（GainNode 立刻变 0.3）
与换声音档（旧轨 `stop`、重新 `start`）两条真操作。

### 4-J 相机位「输出声音」+ 播放只走保留段（adj1150/adj1151，用户 2026-10-25 实报）

用户给了两张图：① 台面那排「声音 / 伴奏音量 / 合成音音量」；② 保留段 `7.277s → 265.247s`。
要求：**相机位也要有这一排**（决定成片/预览用哪条声音），并且设了保留段就**只播保留段**
（从 7.277s 起、到 265.247s 止，不要从音频 0 开始）。

做法：

1. 相机位（`DynamicFrameOverlay`）新增「输出声音」一行：三档 + 两条音量 + 百分比；读写**同一份**
   `syncDoc.mix`（存 sidecar），不是另造一套设置；
2. 相机位打开时**自己找同目录 sidecar**（`store/syncSidecar.ts`，与对拍台共用路径规则）；
   sidecar 有文件名、但内存里没有伴奏时给「加载伴奏…」；`setAudioBuffer` **不重置 sidecar 的保留段**；
3. 出片/预览的**音量真的进混音**：`file` 按 `accomp`、`synth` 按 `synth`、`mix` 两条各自 gain
   （之前 `file`/`synth` 直接返回原始 buffer，音量被忽略）；
4. 台面播放起点 `playStartMsOf` 夹进保留段：7.277s 起播、到 265.247s 停；起点已在末尾则**从头再播一遍**
   （否则按播放只会"停在末尾什么都不发生"）；
5. 混音/音量变化只**作废音轨**（不重建会话），改完下一次播放/生成生效。

断言：`smoke` 的 `adj1150` 9 条（0 → 7277、段内原样、末尾回段首、无保留段负对照、相机位接线、
音量进混音、`setAudioBuffer` 不重置保留段、台面播放走 `playStartMsOf`）；`verify:app-ui` 打开相机位
真点三档与音量滑杆（含百分比跟变）。

### 4-K 锚点 0 / 1 / 2+ 的口径（adj1152，用户 2026-10-25 逐条给出）

| 锚点数 | 拍速（`beatMs`） | 偏移（`offsetMs`） | 相机/出片 |
|---|---|---|---|
| **0** | 谱面 `J:`（或默认拍速） | **`trim.startMs`**（用户 2026-10-25 确认：保留段起点 = 谱面第 1 拍） | 伴奏与合成音都从保留段起点开始、默认对齐 |
| **1** | 谱面 `J:`（`effectiveFitOf`，不由锚点推） | 由这条锚点解 | 用该偏移对齐；有前奏则走 pre-roll |
| **2** | 由两点解实际拍速 | 由锚点解 | 按实际拍速 |
| **多** | `fitSync` 最小二乘 | 同上 | 同上 |

根因：相机位原来要求 `doc.tempo !== null`，而 `doc.tempo` **只有 ≥2 条锚点才非空** ⇒ 0/1 条时
「输出声音」整排被禁用，还提示"先去对拍台打两条锚点"（用户截图）。现在统一：
`effectiveSyncFitOf(doc, scoreBeatMs)` = `doc.tempo ?? effectiveFitOf(anchors, …)`，0 条时再兜底
`{拍速 = J:, 偏移 = trim.startMs}`；台面的拍速/偏移读数也改用它（1 条锚点不再显示 `—`）。
`tempo` 字段本身仍只存"2+ 解算结果"（1 条无法只凭锚点定速度，这是引擎口径）。

断言：`smoke` 的 `adj1152` 6 条（0 条 = 保留段起点、1 条拍速/偏移、2 条、无文档 null、
相机/台面同源、伴奏用有效拟合）。

### 4-L 桌面自动读伴奏：`sync_read_audio`（adj1154，用户 2026-10-25 要求）

用户原话：「要加一个桌面 `sync_read_audio`，这操作太繁琐了」——sidecar 里已经记了伴奏文件名，
重开应用却还要点一次「加载伴奏…」不合理。

做法：

1. Rust 新增 `sync_read_audio(path) -> Response`：只接受音频扩展名（mp3/m4a/aac/wav/flac/ogg/opus/webm）、
   单文件 ≤ 256MB（与读图片的 `read_asset_bytes` 同一套安全边界，注释写明）；
2. 前端 `syncIo.readSidecarAudio` + `syncSidecar.loadSidecarAudioFor`：
   路径 = sidecar 路径去掉 `.sync.json` 得到 `.jps`，再拼 `doc.audio`（相对同目录 / 绝对原样）；
3. 相机位打开时：没有 sidecar 就自己读 sidecar；内存没有伴奏就自动读 + `decodeAccompaniment`；
   失败（网页、文件被移走、扩展名不认）**不挡相机位**，保留「加载伴奏…」手动入口；
4. 手动入口仍保留：自动加载失败时用户还能点一次。

断言：`smoke` 的 `adj1154` 4 条（Rust 命令/白名单/注册、Rust 单测、前端两段、相机位自动加载）；
Rust 侧 `cargo test --lib sync_io_tests`（含"读得到字节 + 拒收非音频"）。

### 4-M sidecar 扩成「这首歌的附属设置」+ 一键 tauri dev（adj1155，用户 2026-10-25 选 B）

用户口径：

- `.sync.json` 里的 `sync` = **对拍**（音画同步），不是云同步；
- 但可以把"不适合放进谱面设置"的东西放到这份 sidecar：**练习段列表、当前选中段、相机导出段**；
- **试听里添加/删除练习段时保存**（不用再点对拍台的「保存」）。

schema（`version` 仍为 1；可选字段，旧文件兼容）：

| 字段 | 含义 | **缺字段** | **显式空** |
|---|---|---|---|
| `marks` | 练习段列表 | 旧文件 ⇒ 回退 localStorage | `[]` = 用户删光了 |
| `markId` | 当前选中的练习段 | 不管理 | `''` = 选「无」 |
| `range` | 相机位导出的标记段 | 不管理 | `null` = 整曲 |
| `mix` | 声音档 + 两条音量（原本就有） | 默认值 | — |

自动保存：

1. App 级 `useSyncSidecarExtras`（`store/syncExtras.ts`）：打开/切换文件时读同目录 sidecar，
   把 `marks/markId/range` 灌回 UI（`mix`/锚点由 doc 本身带回来）；
2. 订阅 `syncStore.doc` 变化：混音/锚点/保留段改动 **600ms 防抖**写 sidecar；
3. **试听里添加/删除练习段 ⇒ `mirrorMarks()` + `flushSyncAutoSave()` 立即写**；选段/遍次/相机段也写；
4. 写盘走 `sync_write_file`；网页/开发浏览器只写 L1（`ijipu.mvSync.last`），不反复触发下载；
5. 切文件用 `docOwner` / `pendingIdentity` 防串写；读盘期间关自动保存，读完再开（期间有改动就补写一次）。

一键开发：`ijipu/tauri-dev.bat`（双击）——**纯 ASCII**，不 dot-source `scripts/tauri-env.ps1`
（Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 GBK 读，中文引号直接解析失败）；
bat 自己设 `CARGO_HOME` / `RUSTUP_HOME` / `PATH`（工作区 `.cargo` + `mingw64\bin`），
`call npm run tauri:dev`（`npm` 是 `.cmd`，批处理里不加 `call` 会在 npm 结束时整段提前退出），
退出后 `pause`。带 `--check` 自检（cargo/rustc/npm 版本 + `cargo metadata`）。

断言：`smoke` 的 `adj1155` 9 条（schema 往返/显式空/旧文件缺字段、save 带 extras、自动保存接线、
App 桥、练习段增删立即写、相机段、bat 内容）。

### 4-N sidecar 记「这首歌用哪套卡片模板」（adj1176，用户 2026-11-01）

用户口径：

- 每首曲子适合的风格不同；换回上一首时**风格不会恢复**；
- 自定义风格要有名字、集中保存、能导入/导出/编辑/删除，保存后进相机位卡片列表；
- 背景图要能调取景位置（不只"铺满 + 居中"）；片头/片尾/印章的字不限于一个，字体可选。

结论：**样式本体留在本机模板库（L1），sidecar 只记引用**。

| 字段 | 含义 | **缺字段** | **显式空** |
|---|---|---|---|
| `card.template` | 这套谱用的卡片模板 id（内置 `brand/paper/ink/minimal` 或用户模板 `tpl-…`） | 旧文件 ⇒ 沿用上次选的模板 | 空字符串按"没记过"处理（不灌回一个不存在的 id） |

- 模板库：`ijipu.cardTemplates` = `{version, items: CardStyle[]}`；旧的单槽
  `ijipu.dynamicCardStyleCustom` 首次读取时迁入一项（`id: 'custom'`，名字「我的卡片」），随后立刻写回新键。
- 相机位下拉分「内置模板 / 我的模板」；用户换模板（或对话框保存）时调 `recordCardTemplate(id)`，
  没有 sidecar 就先建一份（只有 `card` 的 sidecar 也合法，见 `parseSyncDoc` 的 `hasExtras`）。
- 打开 `.jps` 时 `applySyncExtrasToUi` 按 `card.template` 切回；本机没有这套模板 ⇒ 保持当前并提示，不灌空 id。
- 背景图几何抽成 `cardImageRect`（纯函数），对话框预览与出片共用；水印多字自动收字号（`fitFontSize`）、
  印章多字竖排（`sealLayoutOf`），水印/印章都可用「跟谱面标题 / 衬线 / 无衬线」。
- adj1177/1181：印章外框按文字大小算包围盒（`sealLayoutOf` 给 boxW/boxH），
  轮廓从"椭圆"改为**贴合文字的超椭圆弧线**（`|u|⁴+|v|⁴=1`，96 点，带 ±3.6% 确定性起伏）；
  单字近方、多字竖长，6 字有高度上限。用户 2026-11-02 口径：「不规则弧线，贴合文字，不再用椭圆」。
- adj1178：印章可换成**图片**（`seal.image`，背景图同款 `ijipu-blob:` 引用）并指定
  `size`（短边 12% 的倍数，0.4~2.5）与 `x`/`y`（中心相对坐标）；文字印章同样吃这三个参数；
  图片在 `createDynamicSession` 里一次性解码，模板 zip 单独放 `seal-image.*`。
- adj1179/1181：标题/水印/印章各加一个 `fontFamily`（**本机字体族**，有值优先于预设），
  经 `normalizeFontStack` 补通用族兜底；卡片模板对话框可「读取本机字体」——
  桌面壳优先走 Rust GDI `EnumFontFamiliesExW`（`list_system_fonts`，中文族名），
  失败才退回浏览器 `navigator.queryLocalFonts()`；都读不到仍可手打字体名。
  菜单「设置 → 卡片模板…」新增入口，与动态谱视频同一道 `canUseDynamicVideo()` 闸门。
- adj1180/1182：本机字体列表来源在界面写明（默认只是常见提示、可手打）；保存模板**不关窗**；
  模板新增 `baseId`（起点模板）随模板保存/导出，重开时按它回显，不再重置成深空蓝。
- adj1183：桌面壳导出视频改走 Rust `save_mp4_file`（原生另存为 + 长度校验），成功后弹提示
  并给「打开文件 / 打开文件夹」两个按钮；`Toast` 支持 `actions` 数组。

断言：`smoke` 的 `adj1176` 19 条（取景几何/夹紧、多字与字体默认、竖排、自动收字号、模板解析回退、
sidecar 往返与负对照、模板库/相机位/对话框/渲染器接线、迁移写回）；真界面在 `verify:app-ui`。


### 4-N 桌面壳「打开」必须走原生路径：sidecar 才会写到 .jps 同目录（adj1156，用户 2026-10-25 实报）

现象：桌面壳里点保存，sidecar 仍下载到 Downloads，不在 `.jps` 同目录。

根因：桌面壳的 Ctrl+O 走的是 WebView2 的 `showOpenFilePicker()`——拿到的是**浏览器文件句柄**，
壳不知道文件在哪个目录；`resolveSidecarPath(nativePath, binding)` 两者都没有 ⇒ 返回 `null`
⇒ 对拍台降级 `downloadSidecarText`。

解决：

- Rust 新增 `pick_jps_file`（`tauri_plugin_dialog` 原生文件对话框，只筛 `.jps`，返回绝对路径）；
- 桌面壳 `openFile` 先走 `openFileNative()`：原生对话框 → `read_native_probe` 读文本 + mtime →
  `adoptDoc({ nativePath })`；`adoptDoc` 认 `nativePath`（基准键 `{kind:'native',path}`、草稿路径、
  状态三处都带）；
- 桌面壳里若确实没有 nativePath（旧句柄打开的稿），对拍台**不再下载**，提示
  `syncCopy.saveNoNativePath`：重新「打开」或拖入一次；
- 浏览器（非桌面壳）仍保留下载兜底（网页没有文件系统）。

注意：**旧稿要重开一次**才拿到 `nativePath`；重开后 Ctrl+S / sidecar / 伴奏自动读都走真实路径。

断言：`smoke` 的 `adj1156` 6 条（Rust 命令/筛选/注册、前端 pickJpsFile、openFileNative 接线、
adoptDoc 认 nativePath、桌面壳 no-nativePath 提示、浏览器下载兜底负对照）。

### 4-O 刷新后「找不到上次那条伴奏」：台面漏了自动读 + 选伴奏只记文件名（adj1157，用户 2026-10-25 实报）

现象：桌面壳刷新后打开对拍台，伴奏一栏恒为「找不到上次那条伴奏，请重新选择：空山静E调伴奏.mp3」。

两层根因：

1. **对拍台没有自动读伴奏**：`adj1154` 只给相机位加了「打开时读 sidecar + 自动读伴奏」，
   `SyncDialog` 仍要用户手动点「选择伴奏…」；
2. **桌面壳选伴奏走 `<input type=file>`**：浏览器 `File` 只有文件名、没有目录；伴奏不在
   `.jps` 同目录时，sidecar 只记 `空山静E调伴奏.mp3`，下次拼 `.jps` 同目录必然找不到。

解决：

- `SyncDialog` 打开时（`doc.audio` 非空且内存无 buffer）调 `loadSidecarAudioFor` 自动读、解码、
  `setAudioBuffer`（保留用户的 trim/锚点）；读不到才保留手动入口。
- Rust 新增 `pick_audio_file`（原生对话框，音频扩展名过滤）；桌面壳「选择伴奏…」走它，
  `readSidecarAudio` 读字节；`audioRefOf(path, nativePath)` 决定写进 sidecar 的 `audio`：
  同目录/子目录存**相对路径**，别处存**绝对路径**；相机位的手动选伴奏同一套。
- 台面显示只露文件名（`baseNameOf`），绝对路径不糊一屏。

注意：**旧 sidecar 里只有文件名、且伴奏不在 `.jps` 同目录**的，需要重选一次；选完路径写进
sidecar，之后刷新自动读。若伴奏就在 `.jps` 旁边，自动读直接生效。

断言：`smoke` 的 `adj1157` 5 条（Rust 命令/过滤/注册、前端 pickAudioFileNative、台面自动读、
台面/相机选伴奏写真实路径、`audioRefOf` 纯函数四例）。

### 4-P 桌面壳「另存为」也走原生保存：存完即有真实路径（adj1158，用户 2026-10-25 口径）

用户原话：「要考虑使用者的心智能力，太复杂操作不来，以简洁、统一为要」。

上一轮遗留的复杂点：桌面壳「另存为」仍走 WebView2 的 `showSaveFilePicker`，只给浏览器句柄，
存完没有 `nativePath` ⇒ 用户还得「用打开重开一次」才能存 sidecar。这正是要消掉的多余步骤。

解决：

- Rust 新增 `save_jps_file(name, text)`：原生保存对话框 → 写盘 → 回读校验 → 返回绝对路径；
  用户只写名字、没写扩展名时补 `.jps`。
- 桌面壳 `saveFileAs` 先走 `saveFileAsNative()`；存完设置 `nativePath` / 基准（`{kind:'native',path}`）/
  草稿路径 / 解绑句柄与工作区。之后 Ctrl+S、sidecar、伴奏自动读全按真实路径走，**不需要重开**。
- 浏览器（非桌面壳）仍走 FSA 另存为（网页没有原生路径）。

统一后的 Desktop 心智模型：

> 「打开」是原生文件框；「另存为」也是原生文件框；存完就是普通本地 `.jps`；
> sidecar / 伴奏都在它旁边，刷新自动读。

断言：`smoke` 的 `adj1158` 4 条（Rust 保存命令/回读/补扩展名/注册、前端 saveJpsFileNative、
saveFileAs 原生分支与 nativePath、浏览器 FSA 负对照）。



- 间奏块的**中性灰**：`playheadBaseOf` 加一个 `interlude` 色位，并让 `TimedRect`/`playheadTrack`
  透传 `interlude` 标记（纯显示改动）；
- 片头卡的 `♩=实际（原谱 X）`：改 `renderer.ts` 的 `introMeta` 显示逻辑（**只在 sidecar 生效时**）。

**片头卡那一行的三种写法**（取 B）：

| 方案 | 未对拍时 | 对拍后（谱面写 80、实际 96.4） | 观感 |
|---|---|---|---|
| A | `♩=80` | `♩=96` | 干净，但和谱面写的不一致，像读错 |
| **B（定）** | `♩=80` | `♩=96（原谱 80）` | 一眼看出"跟着伴奏调的"，也保住谱面信息 |
| C | `♩=80` | `♩=96 · 跟伴奏` | 说清原因但丢了原值 |

口径：**取整到整数**（96.4 → 96）；括号只在"实际 ≠ 谱面"时出现；
原来速度文字（`♩=80 稍慢`）保留在括号外边。

---

## 九、需要你配合的内容

### 资料（**已到位**，2026-10-24 用户给了路径）

1. **真实谱 + 伴奏**：`D:\蜗居笔记\悟乐居杂记\2.曲谱集\<曲名>\`，`.jps` 与 mp3 **同目录**。
   带「间奏」的 6 份已复核（`introduce` 的 7 处，见 §1.5）：
   `一生清贫怎敢入繁华.jps:37`（唯一写了拍数）、`绿野仙踪.jps:10/14/19`、`知否知否.jps:23`、
   `花又期二重奏.jps:35`、`追光者.jps:28`。**其余 5 处只写"间奏略"、没有拍数** ⇒ 需要你逐处补。
2. **"间奏略"那 5 处到底多少拍**：**已约定等实际配伴奏时再改**（不阻塞开发）；
   现在解析期会给"没写几拍"的提示，不会静默错。
3. **《赤伶》的调性**：谱面 `D:` 是 B 调还是别的？伴奏是 A 调？——决定第 4 步"调性提示"值不值得做。

### 环境/操作

4. **人耳验收**：P0 验收 ①② 只能你来听。我会给出"听什么"的具体做法（改 ±10ms 各出一版，盲听哪版更咬合）。
5. **`tauri dev` 跑一次**（只在走路 B 时需要）：我这边不能开 GUI，`mv_pick_audio` 与
   `%APPDATA%\iJipu\files` 的落盘要你实机确认一次。
6. **基线我已经跑过**（§1.4：✓ 4448 / ✗ 0，CLI 169 项全过）；第 1 步之后是 **✓ 4476 / ✗ 0、CLI 176 项**。
   每次改完照旧跑 `npm run smoke`；如果红灯，先用 `git stash` 比一比是不是自己引起的。

### 协作口径

7. 引擎改完的插件同步：**已做**（`obsidian-ijipu/vendor/engine` 与应用逐字节一致，
   插件 `npm run smoke` 840 通过 / 0 失败）。**插件版本号与发版还没动**——
   要不要随下一个插件版本发（MINOR？）等你说。

---

## 十、验收与命令

```powershell
# 基线（开工前、每次改动后）
cd D:\Coding\JianpuScript\ijipu
npm run smoke     # 现在的结果：✓ 4501 / ✗ 0 + CLI 176 项

# 语法与时间轴（第 1 步）：自己写一份临时谱，放在工作区 .dsh-tmp/ 下
# ⚠ 别放 dist-smoke/——vite 构建会先清空它
node packages\ijipu-cli\dist\ijipu.cjs lint -i ..\.dsh-tmp\p0\jz.jps
node packages\ijipu-cli\dist\ijipu.cjs play -i ..\.dsh-tmp\p0\jz.jps -t midi -o ..\.dsh-tmp\p0\jz.mid

# 真浏览器点一遍（第 2~4 步，UI 改动必跑）
npm run verify:app-ui
```

**正向判据**
- `npm run smoke` 全绿，新增断言 ≥15 条（间奏 10 + 对拍 5），带负对照；
- 不导入伴奏时，同一份谱的 `session.events` 与改动前**逐字段相等**（回归）；
- 出片：`ffprobe`（或 Windows 属性）看到的音轨长 = 视频长（±1 帧）。

**负向判据（必须能变红的）**
- 把 `interludeBeats` 抹掉 ⇒ 间奏后第一个音的 `atMs` 必须变回 1 拍，断言红；
- 把 `playBeatOf` 换回 `beatPos` ⇒ 小节起点断言红；
- 把格式化里的 `{jz}` 特例删掉 ⇒ `formatLine('Q: 0{jz 16} 0')` 变成 `0 {jz 1 6 } 0`，断言红；
- 把 `bpm` 透传删掉 ⇒ "会话 bpm == 对拍 bpm"断言红；
- 把 `leadInMs` 从伴奏轨里去掉 ⇒ "音轨前 leadInMs 为静音"断言红。

---

## 十一、可直接粘贴的开工开场白（给实现会话）

```
工作区 D:\Coding\JianpuScript，做 ijipu 的 P0「外部伴奏 + 对拍」。

先读：
 1) ijipu-mv/docs/P0-REQUIREMENTS.md（需求）
 2) ijipu/docs/EXTERNAL-ACCOMPANIMENT-PLAN.md（实现方案，看 §4 改动清单、§7 问题、§8 拍板项）
 3) ijipu/AGENTS.md（引擎零 DOM、含中文文件只用编辑器工具改、adjNN 编号）

开工顺序（方案 §6 的四步，别跳）：
 第 1 步只做引擎 {jz N}：types.ts / tokenizer.ts（{ 那 1 处 + matchInterludeHead）/
   format.ts（{jz ...} 原样保留 + 幂等）/ jpsHighlight.ts / playback/sequence.ts（7 处）/
   measures.ts；先写 smoke 断言再实现。验收：npm run smoke 全绿 + format 输出是 `0 {jz 16}`
   （不是 `{jz 1 6 }`）+ 同谱加去 {jz} 的 layout 逐字段相等。
 第 2 步才碰宿主（导入/波形/只调 offset）。

硬约束：
 - 不改 layout、不改音频速度、不加新依赖；无伴奏时行为必须与今天逐字段一致。
 - 引擎改动会进 obsidian-ijipu/vendor/engine，插件要同步并升版本、跑插件 smoke（adj733/767/770）。
 - 开工前先 git status：若 DynamicFrameOverlay.tsx / exportDynamic.ts / cliWorker.ts / smoke.mts
   有别人的未提交改动，先停下来问用户，别硬改。

验收命令：npm run smoke；UI 改动另跑 npm run verify:app-ui。
人耳验收（<50ms）由用户做，我这边只保证数学与接线。
```
