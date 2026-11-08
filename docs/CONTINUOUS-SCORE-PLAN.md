# 连续动态谱（单行滚动谱）实施方案

> **决策来源**：用户 2026-11-08 拍板（见 §八）。
> **状态**：M1 引擎已完成（`adj1258`）；宿主渲染 / 对拍台 / 出片待做（M2–M4）。
> **相关文档**：`docs/DYNAMIC-SCORE-PLAN.md`（多行 + 相机位，另一条路线）、
> `docs/EXTERNAL-ACCOMPANIMENT-PLAN.md`（对拍与 sidecar）、`docs/SYNTAX.md`

---

## 一、这是什么，和「动态谱视频」有什么区别

| | 现在的动态谱视频 | 连续动态谱（本文） |
|---|---|---|
| 方向 | **竖着滚**（一行一行往下） | **横着滚**（全曲一条线，往左移） |
| 画面 | A4 版面 + 相机取景 | 背景视频 + 一条谱带 |
| 当前音 | 相机把当前行推近 | 谱带左 1/3 的**定位色块** + 跳跳球 |
| 排版 | 原样 A4 | **按时值重排成单行**（反复/跳转已展开） |

**平台**：桌面专属（与动态谱视频同一道闸门 `canUseDynamicVideo()`）。网站 / 插件不给入口。

---

## 二、总体结构

```
.jps ──parse──▶ layoutScore（会话级：条带字号、时值优先）
                        │
播放序列（已展开反复/跳转）─ barStartsMs / barNos
                        │
        buildLinearStrip()  ← 引擎纯函数（engine/linear/）
         └ 输出：一整页 ScorePage（超宽单行）+ runs + notes(时间→x)
                        │
        renderScoreToSvg → 一张超宽 SVG → 分块光栅（缓存）
                        │
背景视频（Mediabunny 解码）┐
谱带块 + 定位色块 + 跳跳球 ├─▶ draw(ctx, t)  ← 一帧
片头/片尾卡（跟随视频宽高）┘
                        │
           预览：音频时钟驱动     出片：encodeMp4（现成的）
```

三条硬约束沿用：`draw(t)` 纯函数、所有动画由 `t` 算、`t=0` = 第 0 个采样。

---

## 三、单行谱怎么来（方案 A：坐标重排）

不重排字形，只做**仿射变换**：拿正常排版的结果当底稿，按演奏顺序克隆每个源小节。

- **源小节表**（`engine/linear/measures.ts`）：行 = `rowSpansOfPage`（与试听同一套曲行判定）；
  小节边界 = 行内小节线的 x；元素归属按 x 落点判。**不用 `barIndex`**（它跨 Q 行会重新起算）。
- **按演奏顺序展开**（`strip.ts`）：吃 `seq.barNos` + `seq.barStartsMs`（逐遍记录），
  同一个源小节号出现几次就克隆几次。反复 / 跳房子 / `&ds` / `&dc` / `&fine` 在条带上**不再存在**。
- **横向量纲**：每小节 `k = max(1, 每拍像素 × 本小节拍数 ÷ 源小节自然宽)`——
  只放大不压缩，密集小节按自然宽走（宁可这一段慢一点，也不让字叠在一起）。
- **纵向**：`y' = y − 源行基线 + 条带基线`，多行拼到同一条基线上。

### 3.1 行首小节线（用户特别点出的坑）

排版里行首的普通 `|` **不画**（`layout/index.ts:2101`），`|/` 隐藏线**不显示也不占位**
（`types.ts:295`、`spacing.ts:106`）。⇒ 拼成一条线后，行与行的交界处会**缺一根线**。

规则（已实现 + 断言守着）：

1. 每个小节起点都补一根线，**第一条 run 除外**；
2. 线类型降级：`|: :| :|: |/ |*` → `|`（反复已展开，不再画反复记号）；`|| ||/` → `||`；
3. 曲末若源谱是 `||`，条带末端补一条终止线。

---

## 四、数据结构

```ts
// engine/linear/types.ts
interface StripRun { sourceBar: number; pass: number; t0: number; t1: number; x0: number; x1: number; pageIndex: number; rowIndex: number }
interface StripNote { t0: number; t1: number; x: number; w: number; sourceBar: number }
interface LinearStrip {
  page: ScorePage          // 合成的一整页（宽 = 全曲、高 = 一行）
  width: number; height: number; baselineY: number
  runs: StripRun[]; notes: StripNote[]
  noteSize: number; pxPerBeat: number; beatMs: number
  dropped: { crossMeasure: number; fragment: number; extraVoice: number }  // 丢了什么，不许静默
}
```

`page` 故意做成 `ScorePage`，这样 `renderScoreToSvg` 能**原样渲染**——
字形、减时线、高低八度点、变音、倚音、歌词全部走既有渲染。

---

## 五、渲染与合成（M2）

| 层 | 做法 |
|---|---|
| 谱带 | 一次排版、一次出 SVG（超宽）→ `applyRangeToSvg` 按可视窗口裁块 → 缓存成位图块（LRU） |
| 文字色 | `tintSvg(svg, ink)` 把写死的 `#1b1b1b/#333/#555/#888` 换成主题色 |
| 描边/阴影 | 烘焙进块缓存（8 方向偏移描边 + 模糊），不每帧算 |
| 定位色块 | 固定在画面宽 1/3；`scrollX = stripXAt(t) − viewW/3` |
| 跳跳球 | x 固定在色块中心，只在 y 弹；落地 = 拍点（`barStartsMs` 重置网格），复用 `BALL_LANDING_TIMING` / `BALL_SQUASH_*` |
| 背景视频 | Mediabunny `BlobSource` → `VideoSampleSink.samplesAtTimestamps` → `sample.draw()` |
| 片头片尾 | 从 `renderer.ts` 抽出 `cardPainter.ts`，尺寸传视频宽高（`endCardLayout` 已按比例算） |

---

## 六、对拍台与音频（M3）

**独立台面**（与 `SyncDialog` 同款，Esc 关闭），内含：

- 背景视频预览（画布）+ 谱带 + 定位色块 + 球；
- 波形 + 时间标尺 + 起止点 + 打点 + 微调（复用 `syncStore` / `fitSync` / `syncRuler`）；
- **标记段选择**：对好拍后选一段导出；
- 三路音频：视频原声 / 外部伴奏 / 合成音，各带音量；
  **没加单独音频 ⇒ 用视频的音频；加了 ⇒ 用单独那条**（用户 2026-11-08 口径）。

出片：`encodeMp4(session, { fps:30, audio })`，尺寸 = 视频宽高（奇数偶数化）。

---

## 七、断言（`npm run smoke`，`adj1258` 起）

| 编号 | 断言 | 状态 |
|---|---|---|
| L1 | 条带上的小节号 = `seq.barNos` | ✅ |
| L2 | 反复段展开成多条 run（同一源小节出现两次） | ✅ |
| L3 | 每个小节起点都有且只有一根线（行首隐藏线已补） | ✅ |
| L4 | 条带上没有反复/跳房子/`&ds` 等修饰线 | ✅ |
| L5 | `stripXAt(t0)` = 段起点 `x0`（误差 < 0.2px） | ✅ |
| L6 | `stripXAt` 随时间单调不减 | ✅ |
| L7 | `stripEndMs` = 最后一段结束 | ✅ |
| L8 | 长谱跨行拼接处一根线都不缺 | ✅ |
| L9 | 主题颜色越界被钳制 | 待做 |
| L10 | 混音时长 = max(各路)、开播偏移 ≤ 1 帧 | 待做 |
| L11 | 同一 `t` 合成两次结果相等 | 待做 |
| L12 | 视频宽高奇数 ⇒ 输出偶数化、卡片不越界 | 待做 |

**已丢弃（v1 明说，不静默）**：跨小节的连音线/渐强记号（`dropped.crossMeasure` 计数）、
超长小节被拆行后的碎片、非主声部的音符（`dropped.extraVoice`）。

---

## 八、用户 2026-11-08 拍板

| 编号 | 决定 |
|---|---|
| P1 | 单行谱**只显示主声部**（`{dsb}` 第二声部 / `{bz}` 伴奏不显示） |
| P2 | 歌词**可开关**，默认只显示第 1 条 `C:` 行；"第 N 遍显示对应歌词行"以后再做 |
| P3 | 小节号默认**不画**（可开） |
| P4 | 谱带纵向位置**必须可调**，默认**上 1/4** |
| P5 | 支持"无视频、纯音频 + 背景图/纯色"兜底 |
| P6 | 时长上限**按视频长度**，不套 3 分钟 |
| P7 | 卡片模板库与现有共用一份 |
| P8 | 入口：试听栏 + 导出面板各一条 |

---

## 九、里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0** | 预研（Mediabunny 解码闭环 / 超宽 SVG 分块光栅 / 大字号排版量宽） | 待做 |
| **M1** | 引擎：源小节表 + 拼接 + 时刻→x | ✅ `adj1258` |
| **M2** | 宿主：条带光栅 + 合成一帧 + 卡片抽取 | 待做 |
| **M3** | 台面：导入视频 / 对拍 / 标记段 / 混音 / 出片 | 待做 |
| **M4** | 打磨：主题、卡片适配、进度取消、文档、`ERRORS-LOG` | 待做 |
