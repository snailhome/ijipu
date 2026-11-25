# 方案 V2：图片 / PDF → 简谱与五线谱（爱识谱 · iJipu SP）

> 状态：**已批准执行**（用户 2026-11-25「按默认走」）。
> 本文取代 2026-10-11 的初版（初版主张「云端 VLM 起步」，与用户「尽量本地化」的要求冲突；
> 初版的「待确认清单 / 反渲染评测 / 三向联动 / 不猜」全部保留）。
>
> 落地目录：`ijipu-sp/`（安装目录 `iJipuSP`、exe `ijipu-sp.exe`、图标 `logo-sp.png`、许可 AGPL-3.0-only）。
> 应用边界：**桌面专属**（重功能：模型推理、大图处理、长任务；网站/插件不给入口）。
> MusicXML 导出属于「轻」功能：主应用 `ijipu/` 的导出台 + CLI 都做。

---

## 一、一句话目标

给一张**拍照/扫描的简谱或五线谱页面**（PDF/JPG/PNG），先做图像优化，再识别成
**能被引擎 `parseJps` 解析、能渲染、能试听**的 `.jps`；识别不确定的地方**框出来**让用户改，
而不是猜。五线谱与简谱以 `ScoreIR` 为桥双向互转。

## 二、已拍板的关键选择

| 项 | 定稿 |
|---|---|
| 应用 | 新开 `ijipu-sp`（爱识谱 / iJipu SP），不塞进爱扒谱 |
| 简谱识别主路径 | 经典 CV（预处理/版面）+ 专用小模型（数字分类、PP-OCR）+ 引擎自检 + 人工确认 |
| 五线谱 OMR | M3 先 spike `ferraus-score`（Rust，Apache/MIT，oemer ONNX）；不达标退 `homr` sidecar；仍不达标只做「简谱→五线谱导出」 |
| 和弦 | 取最高音为主旋律，其余标「待确认」并保留 bbox（不默认拆多声部） |
| 本地大模型 | 不内置；设置页提供可选「Ollama + Qwen3-VL-4B/8B 整行重识别」；PaddleOCR-VL 需 GPU，不内置 |
| PDF | 前端 `pdfjs-dist` 渲染成页位图；大文件再评估 pdfium |
| MusicXML | `.musicxml` 纯文本；`render/batch -t musicxml`；`.mxl` 本轮不做 |
| 训练 | 允许一次性 Python+PyTorch 训练数字分类小模型（仅开发机，不进产物） |

## 三、为什么不用「纯大模型」做识别

- **幻觉**：会编出不存在的音符，且不认错；
- **bbox 不可靠**：做不了「框出不确定区域」；
- **慢/贵/占显存**：一页几秒到几十秒，普通用户没 GPU；
- 我们的优势是**引擎自检 + 元素级置信度 + 人工点选**，专用小模型更贴合。

大模型只做「这一行我认不出」的第二意见：必须结构化输出、带 bbox、进 `issues`，不直接落脚本。

## 四、总体架构（七层）

```
PDF/JPG/PNG
 └─① 导入        渲染 PDF 页→位图；EXIF 方向；页列表/缩略图          [Rust + 前端]
   └─② 预处理    灰度→光照归一→去噪→纸面检测/透视→二值化→行带→行拉直  [omr-core]
     └─③ 版面    行带分类；小节线；音符槽                            [omr-core]
       └─④ 符号  数字分类（ONNX）+ 八度点/减时线/增时线/附点/变音/歌词
         └─⑤ 装配 时值/小节/歌词/调号 → ScoreIR（含 bbox/conf）      [omr-core]
           └─⑥ 自检 toJps → parseJps → layoutScore → 拍数校验
             └─⑦ 复核 三区 UI：框选修正 + 待确认 + 导出/保存
```

### 预处理默认参数
处理长边 3000px；背景窗口 页宽/8；Sauvola k=0.2；行分段 24 列；基线残差阈值 0.3×行高；
模糊阈值 Laplacian 方差 60；倾斜 >0.5° 才转。低质量只提示「建议重拍」，不阻断识别。

### 待确认与自动框
| 类型 | 来源 | 颜色 |
|---|---|---|
| 低置信元素 | conf < 0.85 | 黄框 |
| 结构冲突 | 拍数不符 / 时值非法 / 数字与修饰矛盾 | 红框 |
| 未认领墨迹 | 连通域 >50px² 且不属于任何元素 | 红框 |
| 版面不支持 | 双栏 / 竖排 / 无行带 | 整页红框 |
| 反光/模糊区 | 质量指标 | 黄虚线 |

三态输出：`可直接用` / `建议复核` / `需人工`（按最坏元素定）。

## 五、`ScoreIR`（已落地，M0）

位置：`ijipu/packages/ijipu-engine/src/engine/scoreIR/`（纯 TS、零 DOM，从 `engine/index.ts` 导出）。

```ts
parseJpsToIR(code): { ir, errors }
irToJps(ir): { code, issues }
irToMusicXml(ir): { xml, issues }
parseMusicXmlToIR(xml): { ir, issues }
```

文件分工：
- `types.ts`：ScoreIR（part / measure / event / barline / lyric / issue）；
- `pitch.ts`：调号 / MIDI / 简谱数字 / 五线谱 `step+alter+octave` / `<fifths>`；
- `fromJps.ts`：解析结果 → IR（带 `groupIndex`，区分「同时演奏」与「先后演奏」）；
- `toJps.ts`：IR → `.jps`（互转的唯一语法出口）；
- `musicxml.ts`：极简 XML 解析 + MusicXML 4.0 读写；
- `issues.ts`：issue 构造 / 去重 / `hasMustIssue`。

时值口径（**关键**）：`.jps` 的「1 拍」= 四分音符 = 480 tick，与 MIDI 导出（`eventsToMidi` 的 DIV=480）
同口径。`P: 6/8` 的 6 个单位导出后也是 6 个四分音符，五线谱软件可能提示小节时值不符 —
这是**已知口径差异**，`irToMusicXml` 会给一条 `meterDenominator` 的 review 提示。

## 六、M0 已完成（2026-11-25）

- 引擎 `scoreIR` 六个文件 + 导出；
- 主应用导出台新增「MusicXML 乐谱」（`ExportPanel.tsx` + `brand/copy.ts`）；
- CLI：`render -t musicxml`、`batch -t musicxml`（纯文本、任意环境；`doctor` 能力表同步）；
- 文档：`docs/CLI.md`、`docs/CLI-手册.md`、本文件；
- 断言：`scripts/smoke.mts` 新增 `[scoreIR]` 50 条（两个示例谱的 jps↔IR↔MusicXML 往返、
  音高/调号/6-8 提示、和弦降级、坏 XML、临时段、多声部）；`scripts/cli-assert.mts` 新增 3 条。

验证结果（本机沙箱）：
- `smoke`：**只差 `adj951` 1 条**跑不了（沙箱 `spawnSync node` EPERM；不是代码问题）；
- `cli-assert`：**187/187 全通过**；
- `tsc -b`：0 诊断（只是 `tsbuildinfo` 写不进 `node_modules/.tmp`，沙箱权限问题）。

## 七、后续阶段

| 阶段 | 内容 | 产物/验收 |
|---|---|---|
| **M1 识图可行性** | `ijipu-sp` 骨架；`crates/omr-core` 预处理 + 行带 + 行拉直；反渲染合成 100 张；单行识别 → IR → `.jps` | 合成图编辑距离 ≤0.10；`parseJps` 0 错误；误差画像 |
| **M2 最小可用** | PDF/JPG/PNG 导入；三区 UI；待确认框选修正；导出 `.jps`；工程保存；模型包下载 | 「导入→识别→改 3 处→导出→0 错误」真机闭环；UI probe 全绿 |
| **M3 五线谱** | 页型判定；OMR spike；MusicXML→IR→jps；OSMD 预览（可选） | 印刷体单声部音符正确率 ≥0.85 才继续；互转 roundtrip 全绿 |
| **M4 加固/产品化** | 歌词 OCR；多声部/临时段；反复/跳房子；真实样本评测；安装包/文档 | 拍照编辑距离 ≤0.12；改动数 ≤5/100 小节；漏框 0 |

## 八、模型与依赖（已批准）

| 用途 | 模型 | 体积 | 许可 | 运行位置 |
|---|---|---|---|---|
| 简谱数字分类 | 自训 CNN（9 类） | 5–15MB | 项目自有（AGPL-3.0） | onnxruntime（Rust，`ort` load-dynamic） |
| 歌词 OCR | PP-OCRv5 mobile（det+rec） | ~20–40MB | Apache-2.0 | onnxruntime（Rust） |
| 五线谱 OMR | oemer 两段分割（经 ferraus-score）或 homr | 数十 MB | MIT / AGPL-3.0 | Rust crate / sidecar |
| 可选整行重识别 | Qwen3-VL-4B/8B（GGUF） | Q4 2.5GB / Q8 4.3GB | Apache-2.0 | 用户自装 Ollama |
| 可选强 OCR | PaddleOCR-VL 0.9B | ~1GB+ | Apache-2.0 | 需 GPU，不内置 |

npm/cargo 新增依赖：`pdfjs-dist`、`image` + `imageproc`、`ort`（沿用 bp 版本）、`ureq`、
M3 可选 `ferraus-score` / `opensheetmusicdisplay`、备选 `pdfium-render` + pdfium.dll。

## 九、测试与评测

- **合成数据**：`samples/*.jps` → `parseJps` → `layoutScore` → `renderScoreToSvg` → PNG → 增广；
  五线谱侧 MusicXML → MuseScore/OSMD 渲染 → 增广；
- **真实样本**（待用户提供）：简谱 20–30 张、五线谱 10–20 张，只做评测；
- **指标**：预处理（倾斜/基线残差/模糊）、符号（数字 F1、小节线召回、漏框 0）、
  文本（编辑距离）、版式（元素相对顺序）、互转（roundtrip 等价）、端到端（每 100 小节改动数）；
- **闸门**：`npm run smoke`、`npm run check:engine`、`cargo test`、`npm run probe`、`npm run eval`。

## 十、遗留待办（不阻塞 M0）

1. `矢量图/Logo-sp.png` 源图（M1 前给；先临时占位）；
2. 真实简谱/五线谱样本（M2 评测前给；先合成数据）；
3. `ijipu-sp` 骨架与 `omr-core`（M1 第一步）。

## 十一、与旧版 OMR-PLAN 的差异

| 项 | 初版（2026-10-11） | V2（2026-11-25） |
|---|---|---|
| 主路线 | 云端 VLM 起步 | 本地小模型 + 规则 + 引擎自检 + 人工确认 |
| 输入 | 图片 | PDF / JPG / PNG |
| 五线谱 | 非目标 | M3 支持（MusicXML 桥） |
| 互转 | 无 | `ScoreIR` + jps↔MusicXML（M0 已落地） |
| 界面 | 复核 UI | 三区：页面区 / 预览区 / 脚本区 + 待确认清单 |
| 应用 | 未定 | 新开 `ijipu-sp`（爱识谱） |
