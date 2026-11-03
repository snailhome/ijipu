# 水印与背景层方案（OVL）

> **方案名：OVL**（Overlay，水印层 + 背景层）。
> 开工只需一句：**「按 OVL 方案做」**，并指向本文件。
>
> **状态**：**EP-01…EP-06、EP-12、EP-13、EP-14① 已完成**（见 §零）；**从 EP-07 开始做**（图片取图通道）。
> 本文是"动手前的唯一口径"：字段、单位、默认值、层序、裁剪、跨端取图、交互、执行清单、闸门。
> 用户 2026-10-15 提需求 → 4 项裁定（§十）→ 采纳 10 条优化（§八）。

---

## 零、交接状态（**先读这一节**）

### 已完成

| 项 | 内容 | 证据 |
|---|---|---|
| **EP-01** | `PageConfig` 加 15 个字段 + `defaultPageConfig` 默认值 | commit `212e38b` |
| 计数同步 | 字段进白名单后 CLI `doctor` 35 → **50**、`settings` 的"可用键 35 个"→ 50（手册与 `cli-assert` 是逐字比对） | `docs/CLI-手册.md` 两处、`cli-assert` 的 `doctor` 用例 |
| **EP-02…EP-05** | `expectDescOf` 加 `wmType` 枚举校验；新增纯模块 `render/overlay.ts`；`renderPage`/`renderScoreToSvg` 收 `RenderOpts = RenderFontMeta & { assets? }` 并在白底 rect 与 `body` 之间插入两层；`smoke` 加 **12 条**闸门 | commit `b048d8e` |
| 公共工具 | `render/svgUtil.ts`（`r1n`/`r2n`/`xmlEsc`）—— 从 `render/index.ts` 抽出，overlay 共用一份口径 | 同上 |
| **EP-06** | `SETTINGS-AUDIT.md`（50 字段 + 新 15 行）、`SYNTAX.md` §2.14（新键与"自包含被打了洞"的告警） | commit `ccdaf16` |
| **EP-12** | 谱面设置加「水印 / 背景」两个子页签（5 处登记 + `.pcfg-text`）；`verify-app-ui` 加**真点端到端**（打字 → 预览真出层 → 保存真落键） | commit `1dcc03b` |
| **EP-13** | **预览区手势**（`adj965d`）：`Alt+滚轮` 缩放 / `Alt+Shift+滚轮` 旋转 / `Alt+左键拖动` 平移该层 + 三条前提 + 松手/停顿落盘；判定逻辑落**引擎** `engine/overlayGesture.ts`（应用与 Obsidian 插件共用一份）；`verify-app-ui` **真派发鼠标事件**（含负向判据、`Ctrl+单击` 回归、累计步进、`preventDefault` 生效） | 本轮 commit（见 §七 EP-13 那一行） |
| **EP-14①** | 网页版 FSA 读图通道（`store/assetReaderFsa.ts`：工作区目录句柄逐级下钻 → 字节；未授权与"图不在"分开报） | commit `101f64f` |
| **EP-14②** | `adj969`（用户实报"文件方式打开的谱里相对路径图找不到"）：网页版**单文件句柄**那一档补齐 —— `AssetBase` 增 `{kind:'picked'}` / `{kind:'fileNoDir'}`，新增 `store/assetDirAuth.ts`（授权一次所在文件夹 + 同名/字节数/修改时间校验 + IndexedDB 记忆 + 打开时先问一句），设置页签就地给按钮；桌面壳 PC 的「打开…」同一档（`desktopAssetReader` 复用网页版通道） | commit `21ac580`（v0.66.0） |
| **EP-11①** | `obsidian-ijipu/vendor/engine` 已同步（51 文件、哈希 0 差异）；插件冒烟 **766 passed / 0 failed** | 插件仓库 commit `8c53434` |
| 本文 | 规格 → 完整方案（含执行清单） | commit `b8cdd3a` |

**当前能用的能力**：**文本水印已全程可用** —— 设置界面 → 预览 → PNG/JPG/PDF/打印导出 → 差量写进 `# jps-config`；
**预览区的 Alt 手势已可用**（水印层与背景层都能在预览里缩放/旋转/平移，前提三条见 §六）。
**"文件方式"打开的谱**（拖入 / 文件选择器 / 最近文件）现在也能读相对路径的图了 —— `adj969` 起
打开后会在顶部确认条问一句，点「授权所在文件夹」授权一次即可（句柄记住、跨会话复用，见 §4.1 那一行）。
（图片水印与背景图还差取图通道：EP-07/EP-08/EP-09/EP-10；网页版 FSA 那两条 EP-14①② 已接；
插件 DEFS/README 与嵌入产物 EP-11②③④。）

**基线**：`tsc -b` 0 错；`oxlint` 54 警告 / 0 错（＝基线）；`npm run smoke` 全绿（CLI 断言 126 项）；
`npm run verify:app-ui` **41/41**；两个仓库 `git status` 干净。

### 跨仓状态

`vendor/engine` **已同步**（`adj770` 绿）。**仍待做**：插件 `DEFS` + `README` 补行（EP-11③，等 EP-12 的字段进
`TAB_CONFIG_KEYS` 之后闸门会强制）、嵌入产物重生成（EP-11④，顺序铁律）。
**在 EP-11 全部做完之前不要发布插件版本。**


---

## 一、需求（用户原话要点）

谱面设置里增加**水印属性组**与**背景属性组**：

- 水印：文字/图形选择（默认文本）、文本（默认 `""`）、图形文件（默认 `""`）、显示比率（100）、
  旋转角度（默认 45°）、透明度（默认 25，100 为不透明）
- 背景：图形文件（默认 `""`）、页面位置（默认 `(0,0)`）、显示比率（100）、旋转角度（默认 0°）、
  透明度（默认 100，不透明）
- 图形文件用**与 `.jps` 的相对路径**；插件里笔记的 ` ```jps ` 代码块支持**双链** `[[…]]`
- 背景图**只显示页面内**的部分，走出页面的不显示
- 层级从上到下：**曲谱层（现在的内容层）→ 水印层 → 背景层**
- 谱面设置里加两个页签，各自放上述属性
- **排版模式下**：`Ctrl+滚轮` 缩放背景图、`Ctrl+Alt+滚轮` 旋转、`Ctrl+左键按住拖动` 移动位置
  （注意与 `Ctrl+鼠标点击音符开始试听` 区分开）

## 二、字段定稿（引擎 `PageConfig`，全部 L2 谱面级）

### 2.1 键名与默认值（**EP-01 已实现**，`packages/ijipu-engine/src/engine/types.ts` 搜 `adj965`）

| 键 | 类型 / 范围 | 默认 | 语义 |
|---|---|---|---|
| `wmType` | `'text' ｜ 'image'` | `'text'` | 画哪一个（两个字段都保留，互不删除） |
| `wmText` | 字符串（允许 `\n` 多行） | `'爱记谱・iJipu'` | 空 ⇒ 不画（adj1189 用户默认值；仍受 `wmEnabled=false` 约束） |
| `wmImage` | 字符串（相对路径 / `[[双链]]` / `data:` URI） | `''` | 空 ⇒ 不画 |
| `wmSize` | 整数 pt，渲染端钳 6~400 | `22` | **文本**水印字号（裁定：单列字段；adj1189 默认 36 → 22） |
| `wmScale` | 整数 %，钳 10~1000 | `100` | **图形**水印宽度 = 页宽 × 比率（裁定：基准是**页宽**） |
| `wmRotate` | 整数 °，钳 -180~180 | **-45** | 绕**自身中心**旋转（用户 2026-10-15 裁定：由 +45 改为 **-45**） |
| `wmRepeat` | `true ｜ false` | `false` | **重复水印**：勾选后按行列间隔平铺满页面（用户 2026-10-15 追加要求） |
| `wmRepeatGap` | 整数 %，钳 0~1000 | `300` | 平铺间隔：空隙 = 水印自身尺寸 × 该值/100（300 ⇒ 步进为自身 4 倍）。**默认 2026-10-15 由 100 改为 300**（用户裁定：100 太密）；平铺网格**以水印自身中心为基点**（`adj965f`）⇒ 调位置/拖动时**整片一起移动** |
| `wmOpacity` | 整数 0~100 | `25` | 100 = 不透明 |
| `wmOffsetX` / `wmOffsetY` | 整数 pt | `0` / `0` | 水印中心相对**页面中心**的偏移（居中 = 0,0） |
| `bgImage` | 字符串，同上 | `''` | 空 ⇒ 不画 |
| `bgScale` | 整数 %，钳 10~1000 | `100` | 图片宽度 = 页宽 × 比率 |
| `bgRotate` | 整数 °，钳 -180~180 | `0` | 绕图片中心 |
| `bgOpacity` | 整数 0~100 | `100` | 100 = 不透明 |
| `bgOffsetX` / `bgOffsetY` | 整数 pt | `0` / `0` | 图片中心相对**页面中心**的偏移（居中 = 0,0） |

### 2.2 四条语义（都必须写进断言）

1. **"显示比率"的 100% = 页面宽度**（用户裁定）：图形宽度 = `页宽 × scale/100`，高度按**原图长宽比**
   推算（所以必须由宿主量出 `naturalWidth/Height` 一并传入）。换纸张尺寸时"相对页宽"的关系自动保持。
2. **位置 = 元素中心相对页面中心的偏移**（用户裁定）：`(0,0)` ⇒ 居中，负值向左/上。
   缩放、旋转、位移**共用同一个中心**。
3. **旋转中心**：图形/文本都绕**自身中心**。
4. **只显示页面内**：两层都用**本页页面矩形**做 `clipPath`（不依赖 `viewBox` 的隐式裁剪——
   插件会改 `viewBox`、导出范围也会改）。**每一页都画**，位置相对**该页**的页面框。

### 2.3 差量写入的天然好处（不用额外交代）

`writeJpsConfig` 的 `mode:'diff'` 会跳过"等于默认值"的键
（`settings.ts:437` 的 `pickWritableConfig`）⇒ **不用这功能的谱，`# jps-config` 一个键都不会多**。
正落在铁律 §五.12：**默认配置下出的谱必须是正规、正确的谱**。

### 2.4 注册侧要不要动？（EP-01 已确认：只差一处）

- `CONFIG_FIELDS = Object.keys(defaultPageConfig) ∪ OPTIONAL_CONFIG_FIELDS`（`settings.ts:55`）
  ⇒ 字段进 `defaultPageConfig` 就**自动**进白名单；CLI 的 `-s`/`set`/`doctor`/`config` 随之自动支持 ✓
- 15 个字段全是**必需字段 + 有默认值** ⇒ **不需要**进 `OPTIONAL_CONFIG_FIELDS`
  （编译期断言 `_OPTIONAL_CONFIG_FIELDS_COMPLETE` 只盯"类型里带 `?` 的字段"）✓
- `roundPxIntegers`（`settings.ts:285`）**遍历所有顶层数值**取整 ⇒ 新字段自动覆盖，**不用加段** ✓
  （只有"嵌套数值对象"才必须手动补；本方案没有这种字段）
- **只差** `expectDescOf` 的 `case 'wmType'`（枚举校验；否则默认分支只检查"是字符串"）→ **EP-02**

## 三、渲染设计（引擎侧，纯函数）

### 3.1 插入点与层序

页面 SVG 现在长这样（`packages/ijipu-engine/src/engine/render/index.ts:2054`）：

```
<svg width height viewBox="0 0 w h">
  <rect data-page-bg="1" x=0 y=0 width=100% height=100% fill="#ffffff"/>
  …body…（描述头 / 跳房子 / 连音线 / 音符 / 段层 / 歌词 / 多声部 / 页号 / 说明）
</svg>
```

改成（顺序 = 用户要的层级，**背景在下、水印居中、曲谱在上**）：

```
<svg …>
  <rect data-page-bg="1" …/>
  <g data-overlay="bg"> …背景图… </g>        ← 新
  <g data-overlay="wm"> …水印…   </g>        ← 新
  …body…
</svg>
```

新增纯模块 `engine/render/overlay.ts`：算矩形（页宽基准 / 中心锚点 / 旋转矩阵 / opacity）并产出两段 SVG。
几何全部纯函数 ⇒ `scripts/smoke.mts` 可直接断言，不必跑浏览器。

### 3.2 运行时资源注入（引擎零 DOM，不能自己读图）

引擎有机器闸门 `adj770`（禁 `document`/`createElement`/`Image`，`scripts/smoke.mts:1463`）
⇒ **量宽高、读字节都在宿主做**。同款先例：`renderScoreToSvg(layout, opts?: RenderFontMeta)`
就是"宿主实测、引擎消费"（`render/index.ts:2070`、`src/preview/fontMeta.ts:97`）。

```ts
// render/index.ts（EP-04）
export interface RenderAssets {
  bg?: { href: string; w: number; h: number }   // href 一律 data: URI
  wm?: { href: string; w: number; h: number }
}
/** 与 RenderFontMeta 并列：宿主实测的字体度量 + 宿主解析好的图片资源 */
export type RenderOpts = RenderFontMeta & { assets?: RenderAssets }
function renderPage(page: ScorePage, config: PageConfig, pageCount: number, opts?: RenderOpts): string
export function renderScoreToSvg(layout: ScoreLayout, opts?: RenderOpts): string[]
```

**`assets` 缺省 ⇒ 输出与现在逐字节相同**（层为空串时连 `<g>` 都不产出）——这条必须是回归断言。

### 3.3 为什么 `href` 必须是 data URI（硬约束）

PNG/JPG/PDF 三条导出都是"把 SVG 交给 `new Image()` 栅格化"
（`src/export/export.ts:40` 的 `svgToCanvas`；PDF 在 `pdf.ts` 里以 JPEG 的 `/DCTDecode` 内嵌）。
**以图片方式加载的 SVG 不允许引用外部资源** ⇒ 相对路径 / `http:` 一律读不到。
打印那条路是把 SVG `innerHTML` 进 DOM（`src/export/print.ts:72`），但为了四路一致，**统一 data URI**。

### 3.4 ⚠ `data-overlay` 标记的作用范围（**只有一处真的要排除**）

| 地方 | 计量方式 | 是否受影响 |
|---|---|---|
| 引擎自动裁边 `NEAR_PAGE_RATIO = 0.98`（`render/range.ts:48`） | **按布局估算**（`inkBoxOfLayout(layout)`，`render/inkBox.ts:162`） | **不受影响** ✓ 不用改 |
| 应用预览的调试边界 | 同上是布局算的（`layout/guides.ts`） | 不受影响 ✓ |
| **插件 `scorePane.measureContentBox()`** | **按 SVG DOM**：遍历 `<svg>` 直接子元素、**除 `data-page-bg` 外**全部 `getBBox()` 求并集（`obsidian-ijipu/src/scorePane.ts:2226`） | **受影响** ⇒ 必须把 `[data-overlay]` 一并排除（EP-11），否则 `'score'` 视图裁剪失效 |

⇒ 新层**仍要打 `data-overlay`**（插件排除 + 宿主可识别 + 预览层可选择性忽略），
但**不要**去改引擎的墨迹盒（那是布局算的，改了反而错）。

## 四、跨端取图（本功能最大的工作量）

### 4.1 现状缺口（已核实，含行号）

| 载体 | 基准目录 | 读图通道 | 缺口 |
|---|---|---|---|
| **桌面端**（双击 `.jps`） | `nativePath` 的目录 | ❌ | 桌面端**没有**"按任意绝对路径读内容"的命令（只有写文本的 `write_external_file`、要工作区根+相对段的 `ws_read_text`）；唯一返原始字节的 `sf_soundfont_resource_read`（`src-tauri/src/lib.rs:207`）路径被限死在安装目录 ⇒ **需新增（EP-08）** |
| 桌面端（工作区） | 工作区根 + `segs` | 半 ✓ | `ws_*` 只有文本读写 ⇒ 需加二进制读（可并入 EP-08） |
| **网页版**（工作区 FSA） | 工作区根 | 定位 ✓ / 读 ❌ | `resolveFileHandle` 能逐级拿到句柄（`src/store/workspace.ts:543`），但只有 `readTextRaw`（`:690`）⇒ 需加 ArrayBuffer 读（EP-14） |
| 网页版（单文件句柄） | 用户**额外授权的那份谱所在目录**（`{kind:'picked'}`） | ✓（`adj969`） | 单文件句柄**拿不到父目录**（FSA 硬限制）⇒ 改为"打开后立刻在确认条问一句，用户点「授权所在文件夹」再弹 `showDirectoryPicker`"；句柄存 IndexedDB 跨会话复用，**采信判据**=所选目录里同名 `.jps` 的字节数 + 修改时间都对得上（`src/store/assetDirAuth.ts`）。⚠ 不能在打开动作之后**直接弹**对话框：`showOpenFilePicker()` 已把那次"用户手势"用掉（实测 `userActivation.isActive === false`）⇒ 必被 `SecurityError` 拒 |
| **手机 PWA** | 同工作区 | 同上 | 移动端打开常走 `<input type=file>` 降级、**连句柄都没有** ⇒ 现实路径是"工作区"或"图内嵌" |
| **插件（嵌入版）** | vault（`welcome.root` + 当前 `segs`） | 半 ✓ | 桥的 `read` 是**纯文本**（`obsidian-ijipu/src/embed/bridge.ts:344`）；`adapter.readBinary` 插件里已有用例（`src/bankFile.ts:86`）⇒ **需新增桥 op（EP-09）** |
| 插件（代码块 `[[…]]`） | 笔记所在目录 | 解析 ✓ | `metadataCache.getFirstLinkpathDest(link, sourcePath)` 有先例（`obsidian-ijipu/src/embed.ts:176`），但代码块面板（`scorePane.ts`）今天不做链接解析 ⇒ **需新增**；"当前笔记路径"已有：`ctx.sourcePath` → `IJipuBlock.sourcePath` → `ScorePaneHost.containerPath` |
| CLI（Node / 内嵌） | 输入文件目录 | 半 ✓ | `CliIo` 只有文本 `readFile` ⇒ 读不到就**跳过该层 + stderr 说明**（另给 `--no-assets`），**绝不静默出不带背景的图** |

### 4.2 统一解析器（应用侧一处，EP-07）

新增 `src/store/assetSource.ts`：

```
resolveAsset(raw: string, base: AssetBase): Promise<{ href, w, h } | { error }>
  · raw：去掉 [[ ]] 包裹 → 相对路径 / data: URI 直通
  · base：nativePath 目录 ｜ 工作区(根 + segs) ｜ 插件 vault + 笔记路径
  · 白名单：png/jpg/jpeg/webp/gif/bmp（**拒绝 svg** —— SVG 可含脚本，安全）
  · 上限：单文件 ≤ 16MB
  · 降采样：长边 > 目标像素×2 时 canvas 缩 + 重编码（JPEG/WebP q≈0.85）
  · 缓存：内存 + IndexedDB（键 = 真实路径 + mtime）
```

## 五、界面（EP-12）

`src/dialogs/PageConfigDialog.tsx` 加两个子页签（`水印` / `背景`），各 6 行左右，复用 `Row` + `.pcfg-*`。
要同步登记 **5 处**：`TabId`(:42) / `ALL_TABS`(:54) / `FIELDS_TABS`(:71) / `TAB_CONFIG_KEYS`(:102) /
`renderPanel()` 的 `case`(:416)；顺手把 `uiStore.SettingsTabId`(:75) 与 `TabId`
那**两份已经不同步的名单**（前者缺 `cli`）**合并成一处**。

图形文件那一行：路径输入框 + 「选图…」+ 「内嵌进谱面（自包含）」+ 「置空」+ 插件下 `[[图片.png]]` 提示。

**插件侧（闸门强制）**：`obsidian-ijipu/src/defs.ts` 的 `DEFS`(:43) 加这两组（裁定：**插件设置面板也加**），
`obsidian-ijipu/README.md` 的设置键对照表补行、默认值必须与引擎一致
（闸门 `smoke-frontmatter.mts:350`、`:356`）。

## 六、交互（EP-13）

**键位以裁定 9 为准**（用户 2026-10-15 终裁＝方案 A「Alt 一族全包」；本节早期版本写的是 `Ctrl` 一族，
那是**被否掉的**方案，已按终裁改写）：

| 操作 | 行为 | 步进 / 钳制 |
|---|---|---|
| `Alt+滚轮` | 缩放该层 | 比例类每次 **5**（个百分点），钳 10~1000；**文本水印改字号**（见下）；滚轮**累计约 100px 走一档** |
| `Alt+Shift+滚轮` | 旋转该层（**绕元素自身中心**，裁定 9.1） | 每次 **5°**，钳 -180~180 |
| `Alt+左键按住拖动` | 平移该层（改中心偏移） | 1pt 取整；按住 `Shift` 吸附页面中心 |

**三条前提（缺一不动）**：①「排版辅助」`uiStore.showGuides` 打开；②该层已启用（`wmEnabled`/`bgEnabled`）；
③该层有内容。②③ 的判据与引擎 `render/overlay.ts` 的 `overlayLayers()` **同口径**
（判定逻辑在**引擎**的 `engine/overlayGesture.ts` —— 应用与插件共用一份，两端只负责接线，smoke 可断言）。

**为什么不用 `Ctrl`**（用户指出）：`Ctrl+滚轮` 是浏览器/桌面壳的**页面缩放**热键；
而 `Ctrl+单击` 已经是"从这里试听"（`src/preview/noteClickAction.ts` 的 `ctrl-tryout`）。
拖动也改用 `Alt` 之后两者**完全不冲突** ⇒ **不再需要**早期方案里"4px 位移阈值 + 抑制 click"那套判据。

**与 `Ctrl+单击音符 = 试听` 的关系**：只剩一条防线 —— 手势仅在**排版辅助打开**时注册，
非排版模式下按 Alt 什么都不发生；而 `Ctrl+单击` 走的是另一条路（不带 Alt），一字未变。
（拖动确实移动过时仍会吞掉紧随其后的那一次 `click`，防的是"小位移松手时指针还停在音符上"。）

### 实现口径（**均为用户 2026-10-15 逐条确认**）

1. **「调整对象」切换器**（用户 2026-10-15 追加要求）：水印与背景**都可调**时，预览区右下角给出
   `调整对象：水印 / 背景` 切换器 + 一行键位提示；**只有一层可调**时不显示切换器（手势直接作用在它身上）；
   都没得调时整块提示不渲染。选择存在 `uiStore.overlayEditLayer`（**L3 会话级，不落盘**）。
2. **文本水印的"缩放"改的是字号 `wmSize`**（用户 2026-10-15 确认），不是 `wmScale`：引擎的文本层只读 `wmSize`
   （`overlay.ts` 的 `textLayer`），若去改 `wmScale` 就会"改了却什么都没变"。
   步进按字号的 **≈5%（至少 1pt）**，钳 6~400 —— 与比例类的"±5 个百分点"不同，
   因为字号是 pt 值（36 → 38 才自然，36 → 41 太跳）。相应地，"该层有内容"也按
   **`wmType` 实际画的那一种**判：文本要有文字、图形要有路径。
3. **落盘的基线不是"按下时的完整快照"，而是"该层自己的键置回默认"**（`overlayGestureBase`）。
   ⚠ **这条是用户在真机上踩出来的**（"关闭一个再双重打开，切换条未再显示""Alt 这一套好像不起作用了"）：
   落盘走 `mergeConfigEdits(code, base, cfg)`，规则是「只并 `base` 与 `cfg` **不同**的键」。
   若用户只在**设置面板**里打开了水印/背景（**没点「保存设置」**），`wmEnabled`/`wmText`/`bgImage`
   只活在草稿里 ⇒ 一次手势只会把 `wmSize` 这类**单个键**写进谱面，留下**半截配置**
   （"一个没启用的水印层 + 一个孤零零的字号"）；此后任何一次"从源码重新派生生效配置"的动作
   （在编辑器里打字、刷新页面、宿主整页重载）都会让这一层**连提示条带手势一起消失**，
   而配置行里那个孤儿键还留着 —— 用户看到的就是"条没了、Alt 也不动了"。
   把该层的键在基线里置默认 ⇒ 它们都算"本次改动"，
   **一次手势 = 把被调的那一层按现在看到的样子整层固化进谱面**（启用 + 内容 + 参数）；
   同时**仍然不碰别的东西**（页边距、字体、另一层那些同批草稿改动都不会被带进谱面）。
   ⚠ **仍未自动解决的那一半**：只是"打开了开关、既没保存也没手势过"的层，在源码重新派生时照旧会掉
   —— 这是全应用一致的 L2 口径（所有谱面设置都这样：不点「保存设置」就只是预览），
   面板里的勾选框会如实翻回未勾。**已经按用户 2026-10-15 的要求补了两道保险**：
   ① 这一层还没写进谱面时，预览角落用**红字**说明（`overlayCopy.notInScore`）；
   ② 留了只读自检钩子 **`window.__ijipuOverlay()`**（控制台一句话取回"此刻调哪一层 / 三条前提各是什么 /
   配置行原文"，同 `__ijipuPlayhead` 套路）。
   ⚠ **已经坏掉的谱不会自愈**：得把两个开关重新勾上（或用一次手势 / 点「保存设置」把它写进谱面）
   —— 这条恢复路径在真浏览器里验过（配置只剩 `{"wmSize":38}` 的谱 → 重开两层 ⇒ 条与手势立刻回来）。
4. **滚轮按"累计约 100px 走一档"**（用户 2026-10-15 确认）：鼠标滚一格在 Chrome/Windows 上恰好
   `deltaY≈100` ⇒ 一格一档；**触控板**一次滑动会派发很多小 delta，若"一个事件一档"就会滑一下连跳好几档。
   余数留着（触控板才攒得满一档），一次连续滚动结束（停顿落盘）后归零。
   实现里另有 `deltaMode` 换算（行 ×16 / 页 ×预览区高）与"单事件最多 20 档"的保险。

实现要点：滚轮监听挂在**预览容器** `.preview-pane` 上且 `{ passive: false }` + `preventDefault()`
（React 的合成 `onWheel` 是 passive 的，里面 `preventDefault()` 会被忽略 ⇒ 页面照滚）；
拖动复用 `src/ui/dragGesture.ts` 的指针捕获范式（`setPointerCapture` + `window` 上的 `pointermove`），
**松手才写盘**（`docStore.setPageConfig(最新, true, 按下时快照)` ⇒ 一次拖动 = 一条撤销、
差量只含本次改动 —— 与描述头/虚线拖拽同口径）；滚轮没有"松手"事件 ⇒ **停顿 400ms 落盘**
（一次连续滚动同样只产生一条撤销）。
`Alt+左键` 的平移与描述头拖拽共用 `.pages` 的那一个 `pointerdown`：**手势优先**，不满足条件时原样下传。
**只读自检**：控制台里 `__ijipuOverlay()` 一句话取回"此刻调哪一层 / 三条前提各是什么 / 配置行原文"。

## 七、执行清单（EP-01 ～ EP-14）

> 每步做完都跑 **`npm run smoke`**；EP-05/EP-12 还要 `npx tsc -b` 与 `npx oxlint`（warning 数须为基线 54）；
> **EP-13 必须跑 `npm run verify:app-ui`**（真点，`adj959` 立的规矩）。
> 建议每步一个 commit（`feat(engine): adj965 EP-0x …` / `feat(app): …`）。

| # | 改哪里 | 做什么 | 验收 |
|---|---|---|---|
| **EP-01** ✅ | `engine/types.ts` | 15 个字段 + 默认值 | 已完成（`212e38b`）+ 计数同步 |
| **EP-02** ✅ | `engine/settings.ts` | `expectDescOf` 加 `case 'wmType'` | 已完成（`b048d8e`） |
| **EP-03** ✅ | `engine/render/overlay.ts`（新） | `overlayLayers()`：钳制/矩形/旋转/opacity/`<clipPath>`/`<image>`/`<text>`；空资源返回 `''`；id 按页唯一 | 已完成 |
| **EP-04** ✅ | `engine/render/index.ts` | `RenderAssets`/`RenderOpts` + 两层插在白底 rect 与 `body` 之间 | 已完成（**`assets` 缺省逐字节不变**） |
| **EP-05** ✅ | `scripts/smoke.mts` | `runAdj965OverlayTests()` **12 条** | 已完成（含"夹具自检：必须真分页"） |
| **EP-06** ✅ | `SETTINGS-AUDIT.md` / `SYNTAX.md` | 50 字段 + 新键口径 + 自包含告警 | 已完成（`ccdaf16`） |
| **EP-07** | 新增 `src/store/assetSource.ts` | 解析 + 白名单 + 上限 + 降采样 + 缓存（§四.2） | 纯函数部分进 smoke（路径归一、`[[…]]` 去壳、白名单/上限判定） |
| **EP-08** | `src-tauri/src/lib.rs` | 新增 `#[tauri::command] async fn read_asset_file(path: String) -> Result<tauri::ipc::Response, String>`（照 `sf_soundfont_resource_read:207` 的原始字节写法；**扩展名白名单 + 大小上限**）+ 注册进 `generate_handler!`(:464)；前端封装走 `brand/env.ts` 的 `tauriInvoke` | 桌面端双击打开的谱能出背景图（真跑：`. .\scripts\tauri-env.ps1` 后 `npx tauri build`） |
| **EP-09** | `obsidian-ijipu/src/embed/bridge.ts` + `ijipu/src/store/hostBridge.ts` + `workspace.ts` | 桥加 `readAsset` op（`adapter.readBinary` → base64/data URL）+ 应用侧方法 + 二进制原语 | 插件里能出背景图；越界路径被拒 |
| **EP-10** | `src/preview/PreviewPane.tsx`、`src/export/*` | 解析出的 assets 传进 `renderScoreToSvg`（预览与导出**共用同一份**，避免"预览有、导出没有"） | 预览/PNG/JPG/PDF/打印五路一致；解析失败给明确提示（**不静默降级**） |
| **EP-11** | `obsidian-ijipu/` | ① ✅ `vendor/engine` 已同步；② `scorePane.measureContentBox` 排除 `[data-overlay]`(:2226)；③ `DEFS` + `README` 补行（**EP-12 之后闸门会强制**）；④ 重生成嵌入产物（`npm run build:embed && node scripts/embed-emit.mjs`，闸门 `adj733`） | 插件 `npm run smoke` 全绿（现已 766 ✓） |
| **EP-12** ✅ | `PageConfigDialog.tsx` + `index.css` | 两个页签 + 5 处登记 + `.pcfg-text`；顺手修两条闸门探针（写死块名的解析器 / 只查 `cfgSrc` 的图例探针） | 已完成（`1dcc03b`）+ `verify-app-ui` 真点 3 条 |
| **EP-13** ✅ | `PreviewPane.tsx`、`ui/dragGesture.ts`、新增**引擎** `engine/overlayGesture.ts` | **`Alt+滚轮` 缩放 / `Alt+Shift+滚轮` 旋转 / `Alt+左键拖动` 平移**（裁定 9，方案 A）+ 施力前提三条（排版辅助开 + 该层启用 + 有内容）+ 松手/停顿写盘（§六）+ 滚轮累计约 100px 一档 + 「调整对象」切换器与「尚未写入谱面」提醒 | 已完成：`npm run verify:app-ui` **41/41**——真派发 `Alt+滚轮` / `Alt+Shift+滚轮` / `Alt+拖动` ⇒ **配置真的变了**（`wmSize`/`wmRotate`/`wmOffsetX,Y`/`bgScale` 真的落进 `# jps-config`，预览里的字号/角度/中心真的动了）；**非排版辅助模式下按 Alt 一个字都不变**（负向判据）；`Ctrl+单击` 试听照旧；累计步进与 `preventDefault` 各有真派发证据 |
| **EP-14** | `workspace.ts`、`packages/ijipu-cli/src/*` | ① ✅ **网页版 FSA 读图已接**（`store/assetReaderFsa.ts`：工作区目录句柄逐级下钻 → 字节；未授权与"图不在"分开报；冒烟用假句柄 3 条断言）；② CLI `CliIo.readBinary` + 读不到就跳过并说明 + `--no-assets` | CLI 出图带背景（Node 可读时）；读不到时 stderr 有明确一行 |

## 八、优化清单（10 条，**用户已采纳**）

1. **降采样 + 重编码**：长边压到"目标像素 × 2"。**必须做** —— 多页谱每页 SVG 各嵌一份 base64，
   10 页 × 2MB 会是 20MB 字符串，PDF（JPEG 内嵌）与内存都会炸。
2. **资源缓存**（内存 + IndexedDB，路径 + mtime 作键）：预览重排不重复解码。
3. **`data-overlay` 标记**：给插件 `measureContentBox` 排除用（§三.4）。
4. **水印位置字段**（`wmOffsetX/Y` 已进字段表）：水印同样需要定位，交互将来可复用同一套。
5. **自包含对策**：默认相对路径（用户要的）+「内嵌为 data URI」按钮 + 设置里标出"⚠ 引用了外部图片"。
6. **拖拽体验**：`Shift` 吸附中心；滚轮/旋转双步进（5% / 1%）；预览角落显示操作提示（可关）。
7. **导出前一致性检查**：解析失败时预览与导出都给明确提示，**不静默降级**。
8. **顺手修名单重复**：`uiStore.SettingsTabId` 与 `PageConfigDialog.TabId` 合并成一处。
9. **文档连锁更新**：`SETTINGS-AUDIT.md`（标题仍写"34 字段"、表体已 37 行）、`SYNTAX.md`、
   CLI 手册与 `cli-assert` 里逐字比对的计数（**EP-01 已经真实踩过一次**：35 → 50）、插件 `DEFS` + `README`。
10. **安全**：读图命令只收图片扩展名 + 大小上限（`.jps` 是纯文本、可能来自别人）；**拒绝 SVG 图源**。

## 九、闸门与验证

- **引擎纯函数断言**（EP-05）：矩形/旋转/裁剪/opacity 数值、层序、`data-overlay` 标记、
  **`assets` 缺省 ⇒ 零输出（既有谱字节不变）**；覆盖 `space`/`duration` 两类布局。
- **注册与差量**：默认值 ⇒ `# jps-config` 不出现新键；改一项 ⇒ 只出现那一项；往返一致；
  `-s`/`set`/`doctor` 自动带上新键（计数变化会让手册的逐字比对判红 ⇒ 记得同步）。
- **UI 双向闸门**（EP-12）：`TAB_CONFIG_KEYS` ↔ `isNonDefault('键')`（既有两条，`:16112`/`:16123`）。
- **真派发验证**（EP-13，`verify-app-ui`）：`Alt+滚轮`/`Alt+Shift+滚轮`/`Alt+拖动` 一律走
  CDP `Input.dispatchMouseEvent`（浏览器原生输入路径，不是 `dispatchEvent(new Event(…))`）⇒
  **预览产物与 `# jps-config` 双向都真的变了**；**非排版辅助模式下按 Alt 一个字都不变**（负向判据）；
  `Ctrl+单击` 仍能从这里试听（回归，防新手势把老路抢走）。
  ⚠ 另有一条**只能从源码钉**的：wheel 监听必须 `{ passive: false }` —— 挂成被动监听时
  `preventDefault()` 被忽略，**手势照样生效**（所以真派发测不出来），只是页面同时跟着滚。
- **纯函数断言**（EP-13）：**引擎** `engine/overlayGesture.ts` 的步进/累计/钳制/目标层/三条前提/口径同源
  （smoke `[199]`，17 条）。
- **"半截配置"闸门**（EP-13，`adj965d` 真机踩坑后补）：拿真合并（`mergeConfigEdits` + `writeJpsConfig`，
  与 `docStore.setPageConfig` 同一条路）跑"两层都只在草稿里开着"的夹具 ⇒
  被调那一层整层写进去、**同批草稿的页边距不许被带进去**、另一层也不许被顺手固化；
  配**负对照**（基线取完整快照 ⇒ 只剩 `wmSize` 一个孤儿键）。
  `verify:app-ui` 里另有一条**真派发**版：背景层只在草稿里开着时 Alt+滚轮 ⇒
  `bgEnabled`/`bgImage` 必须与 `bgScale` 一起出现在 `# jps-config` 里。
- **跨仓**（EP-11）：`vendor/engine` 逐字节一致 + 插件冒烟（DEFS / README / 嵌入门槛 `adj733`）。

## 十、决策记录

| # | 问题 | 裁定 |
|---|---|---|
| 1 | 图形"显示比率"以什么为 100% | **相对页宽**（100 ⇒ 宽度撑满页宽） |
| 2 | 文本水印的字号怎么给 | **单列一个"字号(pt)"字段**（默认 36） |
| 3 | 背景 `(0,0)` 指什么 | **图片中心相对页面中心的偏移**（0,0 = 居中） |
| 4 | 插件设置面板要不要也暴露这两组 | **要**（作为"新谱默认值"，与现有 30+ 键同一套） |
| 5 | 优化清单 10 条 | **全部采纳** |
| 6 | 水印**旋转默认值** | **-45°**（用户 2026-10-15 追加裁定：由 +45 改为 -45） |
| 7 | 水印**是否重复铺满** | 加**复选框** `wmRepeat`（默认关）+ 间隔 `wmRepeatGap`（默认 100%）；勾选后按行列间隔平铺满页面，**奇数行错位半格**（斜置水印用正交网格会留空带） |
| 8 | 水印/背景的**总开关** | 各加一个 `wmEnabled` / `bgEnabled`（用户 2026-10-15 要求"决定是否显示"），**默认关**（用户裁定）：不勾就不画，勾上会写进 `# jps-config`（否则换机器打开又不显示） |
| 9 | 排版模式下的**交互键**（EP-13，**用户 2026-10-15 终裁 = 方案 A「Alt 一族全包」**） | **`Alt+滚轮` 缩放**、**`Alt+Shift+滚轮` 旋转**、**`Alt+左键拖动` 平移**。 为什么不用 `Ctrl+滚轮`：**那是页面缩放的热键**（用户指出）；为什么拖动也从 `Ctrl+左键` 改成 `Alt+左键`：与「`Ctrl+单击`=试听」**完全不冲突** ⇒ 不再需要 4px 位移阈值那套判据，修饰键也只剩一个（Alt），好记。⚠ 三件前提：**「排版辅助」打开** + **该层已启用** + **有内容**（`bgImage` 非空 / 水印文本或图形非空） |
| 9.1 | 旋转**绕哪个点** | **绕元素自身中心**（用户 2026-10-15 裁定）。引擎现状即如此：`rotateAttr(θ, cx, cy)` 的 `cx/cy` 是该元素的中心；重复平铺时**每一枚各绕自己的中心**。**不是**绕鼠标位置（那会让元素边转边"跳位"） |
| 11 | 两层**都可调**时手势作用在哪一层 | **预览区角落加「调整对象：水印 / 背景」切换器**（用户 2026-10-15 追加要求）。⚠ 用户同时明确：**只有一层可调、或两层都不可调时都不显示切换器**（只有一层就直接作用在它身上）。状态存 `uiStore.overlayEditLayer`（L3 会话级，不落盘） |
| 12 | 文本水印的"缩放"改哪个字段 | **改字号 `wmSize`**（本轮实现口径，**未经用户逐条确认**，见 §六"实现口径"第 2 条）：引擎的文本层只读 `wmSize`，改 `wmScale` 等于"改了却什么都没变" |
| 10 | 文案口径 | 面向用户的文案一律**正式、规范、简洁**，且**不许写字面 Markdown**（`.pcfg-note` 是纯文本渲染，`**加粗**` 会原样显示成星号）；集中在 `brand/copy.ts`（用户 2026-10-15 两轮指正） |
| 6 | 桌面端保存走底栏还是系统对话框（同批裁定，与本功能无关） | 系统保存对话框 |

**待定（先按"不做"实现，需要时再加）**：仅首页/每页开关、水印文本多行与变量占位符、
预览用 blob URL 省内存（导出仍用 data URI）。
（原列在这里的"**水印位置也可拖**"已在 EP-13 做掉：水印与背景都能用 `Alt+左键拖动` 平移。）

**EP-13 的滚轮步进是"一个 wheel 事件 = 一档"**（不累计位移）：鼠标滚一格恰好一档（Chrome/Windows 下
一格约 `deltaY=100`），但**触控板一次两指滑动会派发很多个小 delta ⇒ 会连跳好几档**。
要不要改成"累计约 100px 才走一档"（触控板手感更稳、个别驱动一格不满 100px 的鼠标则要滚两下才动一档）
**留给用户定**；改的话只动 `PreviewPane.tsx` 里那一处累加，纯函数与闸门都不用变。

## 十一、风险与边界

1. **与"谱面自包含"原则正面冲突**（adj480：复制源码给别人效果一致）。相对路径意味着**换机器/发给别人会丢图**。
   对策见优化 5；这条冲突要在文档与设置界面里对用户讲明白。
2. **手机 PWA 基本读不到**：移动端打开常走 `<input type=file>` 降级、**没有句柄**；FSA 单文件句柄也拿不到父目录
   ⇒ 现实路径是"用工作区"或"图内嵌"。
3. **安全**：读图命令只允许图片扩展名 + 大小上限；**拒绝 SVG 图源**（SVG 可含脚本）。
4. **不要把水印/背景卷进"墨迹"**：它们不参与铁律 §五.9（元素墨迹不重叠），必须在实现与文档里写明。
5. **PDF 是位图内嵌**（`pdf.ts` 用 JPEG 的 `/DCTDecode`）⇒ 背景图会让 PDF 变大，降采样更重要。
6. **CLI 出图**：读不到资源时**不要静默出一张没背景的图**——要么明确报错、要么 stderr 说明。
7. **多页 id 冲突**：`clipPath` 的 id 必须按页唯一（每页是独立 SVG 字符串，同 id 在同一页内不能重复）。

## 十二、开工指引（前 10 分钟）

1. 读本文件（§零 → §七 的 EP 表）。
2. 读这三处现状：`engine/render/index.ts:1958-2072`（页面拼装）、`types.ts` 搜 `adj965`（已加的字段）、
   `settings.ts:105-157`（`expectDescOf`）。
3. 跑基线：`npm run smoke`（应全绿）→ 确认 `tsc -b` 0 错、`oxlint` 54 警告。
4. 从 **EP-02** 开始，按 §七 的表一步步做，每步跑 `npm run smoke`。
5. **交接铁律**：引擎改完**必须**做 EP-11（`vendor/engine` 同步 + `DEFS`/`README` + 重生成嵌入产物），
   否则插件冒烟 `adj770`/`adj733` 会红，而且"插件里的嵌入版仍是旧引擎"。
6. 全部做完、`verify-app-ui` 真点过后，再考虑「更新提交」（版本幅度：**MINOR**，因为有新增设置与能力）。
