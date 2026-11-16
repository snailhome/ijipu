# 底栏 / 右栏 / 告警抽屉 改造方案（adj1290 起）

> 状态：**阶段 A 已完成**（`adj1290`）；**阶段 B 已完成**（`adj1294`/`adj1295`/`adj1296`，2026-11-16）；
> 阶段 C 待实施。
> 编号：`adj1290` 起（当前最新 `adj1296`）。
> 本文件是这次改动的唯一方案口径。**改法有变，先改这里，再动代码。**
> 落地时与方案有出入的地方，都在对应小节里用「⚠ 落地改法」标出（共三处，见 §3.2 / §4.3 / §六·阶段 B）。

---

## 一、要解决的三件事

1. **底栏只在编辑区**。宽屏左右拆分时底栏被塞进编辑列（`adj552`，`App.tsx` 的
   `editorWithDock`），预览那一侧完全看不到告警——告警是全局信息，不该只属于半屏。
2. **告警混在操作页签里不直观**。现在 9 个页签（工作区/导入/试听/导出/全局/谱面/告警/关于/查找）
   是同质的「操作台」，告警是「信息反馈」。反馈混进操作台，用户得先想起去哪个页签找，
   而告警的全部价值就是不用找。
3. **底栏永远吃窗口底部的纵向空间**。有人更希望它是侧栏。

---

## 二、拍板结论（用户 2026-11-16）

| 项 | 决定 |
|---|---|
| 底栏模式 | **不撤**，保留 |
| 新增模式 | 右侧栏（插入，挤占预览/编辑宽度）、右侧浮动栏（悬浮，不挤占） |
| 入口 | 全局设置里选操作方式；顶栏「支持」右侧加一个**常驻**图标开关 |
| 右栏内容 | 与底栏**完全同一批面板组件**，只换壳 |
| 右栏页签位置 | 两种可切：右栏底部（横向，同底栏）/ 右栏右侧（图标在上、中文竖排） |
| 右栏尺寸 | 宽度模型，两档切换；**不做最小化** |
| 宽度值 | PC：窄 320 / 宽 480（按视口夹）；手机：1/2 屏宽 / 2/3 屏宽 |
| 默认 | 全局设置默认「右侧栏」，右栏内模式默认「右浮动栏」；**手机端默认底栏** |
| 手机端选项 | 保留「底栏」「右侧浮动栏」，**不提供「右侧栏」**（窄屏不友好） |
| 关闭方式 | 顶栏图标开关；浮动栏另支持「点栏外区域关闭」 |
| 状态栏 | `EditorFootBar` **不跟着动**，永远在窗口底部 |
| 告警 | 从页签组**独立**成贯穿窗口底部的告警抽屉，默认收起，由状态栏那行开关 |
| 页签组 | 删掉「告警」页签（剩 8 个） |
| 面板适配标准 | 第一版**只保证不崩、不裁内容**，难看另排 adj |
| 图标来源 | `ijipu-cp/public/icons/右侧边栏.svg`（1024 viewBox 线稿） |

---

## 三、目标形态

### 3.1 三种操作方式

```
底栏（现状，保留）
┌───────────────────────── 编辑 / 预览 ─────────────────────────┐
│                                                               │
├────────────────── 操作底栏（ToolDock） ───────────────────────┤
├────────────────── 告警抽屉（可选） ───────────────────────────┤
[ 状态栏 EditorFootBar ]                                        │
```

```
右侧栏（插入：把预览/编辑挤窄）
┌──────────────── 编辑 / 预览 ────────────────┬─ 右栏 ─┐
│                                             │ 工具条 │
│                                             │  面板  │
│                                             │  页签  │
├────────────────── 告警抽屉（可选） ─────────┴────────┤
[ 状态栏 EditorFootBar ]                              │
```

```
右侧浮动栏（悬浮：盖在右侧，不挤占；点栏外关闭）
┌──────────────── 编辑 / 预览 ────────────────┬─ 右栏 ─┐
│                                       （悬浮层）      │
│                                             │  面板  │
├────────────────── 告警抽屉（可选） ─────────┴────────┤
[ 状态栏 EditorFootBar ]
```

⚠ **右栏是整幅高度**（TopBar 之下、状态栏/抽屉之上），**不受 `adj552` 那条「底栏只占编辑列」影响**。

### 3.2 右栏内部结构

```
┌──────────────────────────┐
│ [宽度档] [页签位置] [模式] │  ← 顶部工具条，三个按钮
├──────────────────────────┤
│                          │
│        面板内容           │  ← 复用 DockBody
│                          │
├──────────────────────────┤  ← 页签组（位置 = 底部时）
│ 图标+文字 横向，可左右滚   │
└──────────────────────────┘
```
页签位置 = 右侧时：页签组变成右侧竖条，图标在上、中文竖排（`writing-mode: vertical-rl`），
超出视界**上下滚动**（沿用底栏页签组的溢出箭头 + 滚轮接管那套）。

顶部工具条三个按钮：
1. 宽度档位切换（窄 ⇄ 宽）
2. 页签组位置切换（底部 ⇄ 右侧）
3. 模式切换（右侧栏 ⇄ 右侧浮动栏）

宽度预算：窄档 320px 下，三个 28px 方形按钮 + 两个 3px 间距 ≈ 90px，余 230px，够。

⚠ **右栏页签条不能整条复用底栏的 `.tool-dock-tabs`**。那一条里装着五样东西，右栏只跟两样：

| 元素 | 右栏是否跟 | 原因 |
|---|---|---|
| 页签项（`tool-dock-tabstrip`） | **跟** | 页签组本体 |
| 两端溢出箭头（`tool-dock-tab-arrow`） | **跟** | 页签超出视界要能翻——横向用 `left/right`，竖排用 `up/down` |
| 「收起」（`tool-dock-collapse`） | 不跟 | 关闭归顶栏图标按钮 |
| 「高度档位」（`tool-dock-size-btn`） | 不跟 | 档位在顶部工具条（右栏换成宽度档） |
| 「✕」（`tool-dock-close`） | 不跟 | 与「收起」同源；关闭归顶栏图标按钮，不留第二个关闭入口 |

所以右栏页签条 = **只有页签项 + 两端溢出箭头**。需要一个纯页签条组件
（`dockPanels.ts` 抽 `TABS` 时一并把「页签项」抽成组件，两个壳各自组装条子）。

⚠ **落地改法（adj1295）**：这一条**没有照做**——右栏自己写了一份只含「页签项 + 两端溢出箭头」的
精简实现（`ui/RightDock.tsx` 里约 120 行），**没有**把底栏那条抽成共用组件。理由：

1. 底栏那份承载着 `adj556/adj561/adj567` 三个已被真机反复校准的行为（箭头始终占位、
   当前页签滚进视界、滚轮转横向），且 smoke 里有 **19 处源码断言**钉着它的写法；
2. 阶段 B 的验收里有一条硬判据——**「底栏模式行为必须与改造前完全一致」**。动底栏热文件
   换来的"少写一份 120 行"不值得拿这条判据去赌；
3. 两壳的页签条**本来就不一样**：右栏没有「收起 / 高度档位 / ✕」，方向还可能竖起来。

⇒ 具体差异（这是"两份实现"能接受的前提，改的时候两边都要看）：
`ui/RightDock.tsx` 的 `syncOv/pageBy/alignActive` 与 `ToolDock` 的
`syncTabOverflow/pageTabsBy/alignActiveTab` 一一对应；右栏多一个 `vertical` 分支（纵轴）。
以后真要合并，**先改本节**，再一起改两处 + 那 19 条断言。

### 3.3 告警抽屉

```
… 操作底栏（若有）…
┌────────────────────────────────────────────────────┐
│ ✕ 5告警   第3行 第5列 · 消息            语法速查    │  ← 头（可点收起）
│ ! 第9行 第2列 · 消息                                │
└────────────────────────────────────────────────────┘
[ 文件名.jps  [5,10/123]  5告警  v0.79.0  官网首页 ]
```

- **默认收起**，0 条告知时也收起（状态栏那行始终在，信息不丢）。
- 点状态栏那行 → 从状态栏往上展开，**贯穿整幅窗口宽度**。
- 再点 / `Ctrl+`` / ESC → 收起。
- **有错也不自动展开**（自动弹会突然顶起编辑区、打断打字）。
- 高度：CSS `max-height` = 面板头 + 5 行，内容超出内部滚。**不走 JS 测高**。

### 3.4 顶栏按钮

位置：「支持」按钮右侧、「更多」之前。**常驻**（进顶栏折叠预算，见 §八·2）。
图标：`ijipu-cp/public/icons/右侧边栏.svg` → 转 32×32 透明 PNG（形状在 alpha 通道）
→ `public/icons/右侧边栏.png` → `toolIcons.ts` 的 `ICON_FILES` 加 `rightDock: '右侧边栏'`
→ 同步 `public/sw.js` 预热清单。

---

## 四、状态设计

### 4.1 L1 用户个性（落 `localStorage`，`ijipu.` 前缀）

| 键 | 值 | 默认 | 说明 |
|---|---|---|---|
| `ijipu.dockSide` | `'bottom' \| 'right'` | **按端算**（见 4.3） | 操作方式 |
| `ijipu.dockFloat` | `boolean` | **按端算**（PC 默认 `true`） | 右栏是否浮动 |
| `ijipu.dockWidth` | `'narrow' \| 'wide'` | `'narrow'` | 右栏宽度档 |
| `ijipu.dockTabsPos` | `'bottom' \| 'right'` | `'bottom'` | 右栏页签组位置（仅右栏用） |

全局设置里的「操作方式」下拉三项：**底栏 / 右侧栏 / 右侧浮动栏**，映射到
`side:'bottom'` 或 `side:'right'` + `float` 两值。手机上第三项「右侧栏」**不渲染**
（按项目规矩：非适用端不给入口，不是点了报错）。

### 4.2 L3 会话状态（不落盘）

`dockOpen`、`dockPanel`、`problemsDrawerOpen`。

⚠ 右栏宽度档（`dockWidth`）**属于 L1**：用户当场切了档，下次打开还应该是那一档
——它不是"这一次会话的临时状态"。

### 4.3 默认值按端计算（纯函数，要断言）

`store/fileHost.ts` 已有 `hostProfile` / `shouldOpenWorkspaceDock` 这类纯判据。
新增一个同风格的纯函数，例如 `defaultDockMode(profile)`：

- 手机/粗指针（窄屏 & 触屏）⇒ `{ side: 'bottom', float: false }`
- PC / 桌面壳 / 平板宽屏 ⇒ `{ side: 'right', float: true }`

**首次无存档时才用**；用户改过设置就以存档为准。判据与 `adj1289` 的
`shouldOpenTryoutDock` 互不影响（那个管"打开时展开哪个面板"，这个管"壳在哪一边"）。

⚠ **落地改法（adj1294）**：函数签名是 `defaultDockMode(env: RuntimeEnv)`，**不是** `(profile)`。
原因：`FileHostProfile` 判不出「手机」与「桌面版 Firefox/Safari」——两者都是 `limited` 档，
按 profile 判会把桌面浏览器误判成手机。`RuntimeEnv.device`（粗指针判据）才是"这是不是手机"的
唯一口径（`adj974` 立的同一套）。另外补一条：**插件嵌入版（`shell === 'host'`）默认也是底栏**——
它通常挂在 Obsidian 的侧栏/窄面板里，右栏会直接把可用宽吃掉一半。

### 4.4 宽度换算（纯函数，要断言）

```
dockWidthPx(档位, 视口宽, 是否手机)
  PC：      narrow 320 / wide 480，且夹 min(档位, 45vw)
  手机：    narrow 50vw / wide 66vw
```

手机上不再用 320/480 硬值——320 在 375 宽的手机上几乎全屏。

⚠ 落地补一道：PC 档的 `45vw` 自身再兜一个 **180px 下限**（窗口窄到 400px 以下时 45vw 不到 180，
再按比例收就完全看不清面板内容）。⚠ 手**机**档不夹——它本来就按屏宽比例给。
断言里的实际数字：`(窄,1440)=320`、`(宽,1440)=480`、`(窄,700)=315`、`(窄,375,手机)=188`、`(宽,375,手机)=250`。

---

## 五、DOM 与布局

```
.app (column)
 ├ TopBar
 ├ .app-body            ← 新增：row，flex:1，min-height:0，position:relative
 │   ├ .app-main        ← 现有（编辑/预览/拆分仍在里面）
 │   └ RightDock        ← 插入：flex 子项；浮动：absolute right/top/bottom
 ├ ProblemsDrawer       ← 新增：整幅宽，紧贴状态栏上方
 ├ ToolDock             ← 只在「底栏」模式渲染
 └ EditorFootBar
```

`.app` 现为 column、`.app-main` 是 `flex:1`，包一层 `.app-body` 后所有 `flex:1`
依赖不变（已核对 `index.css`）。新增 CSS 变量：

| 变量 | 用途 |
|---|---|
| `--jp-right-dock-w` | 右栏当前宽度（由 `dockWidthPx` 算，写到 `.app-body` 的 style 上） |
| `--jp-right-dock-tabs-w` | 竖排页签条宽度（约 44~56px） |
| `--jp-problems-drawer-h` | 抽屉最大高度（头 + 5 行） |

⚠ 落地改法：`--jp-right-dock-w` **挂在 `<html>` 上**（由 `RightDock` 用
`document.documentElement.style.setProperty` 写、关闭/切回底栏时摘掉），不是 `.app-body`。
因为除了右栏自己的宽度，**右上角的 Toast / 更新提示也要让位**——它们 `position: fixed` 贴右，
会正好压在右栏上；挂在根上，`.toast { right: calc(20px + var(--jp-right-dock-w, 0px)) }`
一条就够（改这两条既有断言时已同步，见 §八）。

---

## 六、阶段与验收判据

### 阶段 A：告警抽屉（adj1290）——✅ **已完成**

**落地情况（adj1290，实测）**
- 新增 `src/ui/ProblemsDrawer.tsx`；删除 `src/ui/dock/ProblemPanel.tsx`（118 行）与
  `src/ui/dock/problemsHeight.ts`（81 行）——**净减约 100 行**。
- 四道门：`smoke` ✓（exit 0）、`lint` 0 error、`tsc -b` ✓、`build` ✓、
  `verify:app-ui` **92/92**（新增 7 条抽屉用例）。
- 真浏览器实测：抽屉 `left=0 / right=1440 / vw=1440`，底边 `874` = 状态栏顶边 `874`
  （真贯穿整幅）；0 条告警时按内容收缩（48px），有告警时封顶 160px。
- 踩到并记下的坑：两条负向断言先撞上了**注释里的同一串字符**（`requestDockPanel('problems')`
  与 `capProblemsContentHeight`）——`E-2026-237` 同款，负向断言必须**先剥注释**。

**改什么**

**为什么先做**：告警行是「第3行 第5列 · 消息」这种横长内容，是**最塞不进 320px 窄栏**的面板。
先把它独立出去，阶段 C 直接少一个最难适配的对象；而且它**净减代码**。

改什么：
- 新增 `src/ui/ProblemsDrawer.tsx`（从 `ui/dock/ProblemPanel.tsx` 改造：保留「点击跳转」「正确写法按需展开」
  「语法速查」，去掉面板头 + AUTO_FIT 相关）。
- 新增 `src/ui/problemsDrawer.ts`？**不需要**——高度走 CSS 常量，不做 JS 测高。
- 删 `src/ui/dock/problemsHeight.ts`（81 行，`adj528/524/555` 的算式全部下线）。
- 删 `src/ui/dock/ProblemPanel.tsx`（118 行）。
- `uiStore`：`DockPanelKey` 去掉 `'problems'`；新增 `problemsDrawerOpen` + `toggleProblemsDrawer`；
  `expandDock(preferProblems)` 去掉参数；`initialDock()` 的兜底 `panel` 从 `'problems'` 改成 `'tryout'`。
- `EditorFootBar`：告警按钮改调 `toggleProblemsDrawer()`，`is-active` 读抽屉状态。
- `App.tsx`：`Ctrl+`` 改开关抽屉；`<ProblemsDrawer />` 放在 `<ToolDock />` 与 `<EditorFootBar />` 之间；
  `expandDock(summarizeProblems(...).total > 0)` 三处调用改成 `expandDock()`，`summarizeProblems` import 可删。
- `EditorPane.tsx`：「展开底栏」按钮的 `expandDock = () => expandDockPanel(problems.total > 0)` 改成无参。
- `ToolDock.tsx`：`TABS` 删 problems 一项、`PANELS` 删一项、lazy import 删、`PROBS` 全部常量删、
  `forPanel` 的 problems 分支删、`AUTO_FIT` 去掉 `'problems'`、实测里那个 `if (dockPanel !== 'problems')` 特判删。
- `ShortcutsDialog.tsx`：`KBD.problems` 文案改成「告警抽屉」。
- `copy.ts`：`dockCopy.tabProblems` 下线；新增抽屉文案（标题/空态/收起提示）。

**验收判据（正向）**
- [ ] 状态栏点告警 → 抽屉从底部整幅出现；再点 → 收起。
- [ ] `Ctrl+`` 开关抽屉；ESC 收起（且不误触别的 ESC 语义）。
- [ ] 页签组只剩 8 个，没有「告警」。
- [ ] 0 条告警时抽屉可打开、显示空态，不崩。
- [ ] 宽屏左右拆分时抽屉**贯穿整幅**（含预览那侧）——这是本次要解决的核心痛点。
- [ ] 告警行点击仍能跳到对应行列（复用 `docStore.jumpCursor`）。

**验收判据（负向）**
- [ ] 打字出错时**不自动展开**抽屉。
- [ ] `expandDock()` 不再因为"有告警"而切面板（`adj591` 的行为下线）。
- [ ] 抽屉打开不挤压操作底栏的高度（两者独立）。

### 阶段 B：右栏壳（adj1293 ~ adj1296）——✅ **已完成**

**落地情况（adj1294/adj1295/adj1296，2026-11-16 实测）**

- 新增 `src/ui/RightDock.tsx`（约 430 行，含注释）：宽度两档、顶部工具条三按钮、
  页签组两种位置（底部横排 / 右侧竖排 `writing-mode: vertical-rl` + 上下滚 + 上下箭头）。
- `store/fileHost.ts`：新增 `defaultDockMode(env)` / `dockWidthPx(档位, 视口宽, 是否手机)`
  两个纯函数 + `DockSide`/`DockWidth`/`DockTabsPos` 三个类型。
- `store/uiStore.ts`：4 个 L1 键（`ijipu.dockSide` / `dockFloat` / `dockWidth` / `dockTabsPos`）
  + `setDockSide` / `setDockFloat` / `setDockWidth` / `setDockTabsPos` / `setDockMode` /
  `toggleRightDock`；`DockMode`（三选一的合成视图）与 `dockModeOf()`。
- `App.tsx`：加 `.app-body`（横向容器 + 浮动定位上下文），`<RightDock />` 在它之内；
  `adj552` 那套「底栏放进编辑列」的结构**一行没动**。
- `ToolDock.tsx`：加一条自锁 `if (!dockOpen || dockSide !== 'bottom') return null`
  （ESC / Ctrl+H 两条监听也各加了一句 `dockSide` 守卫，免得在右栏模式下动作一个看不见的底栏）。
- `TopBar.tsx` + `ui/topbarFold.ts`：`支持` 右侧、`更多` 之前的**常驻**按钮；
  `FoldInput` 新增 `rightDockW`（常驻槽位**恒扣宽**，不算折叠链的一员），并有隐形测量副本。
- `PageConfigDialog.tsx`：「版面」页签第一行新增**操作方式**下拉（手机上不渲染「右侧栏」）。
- `editor/EditorPane.tsx`：编辑区左下角那个「展开底栏」悬浮按钮**只在底栏模式**出现
  （右栏模式关起来时，入口是顶栏那个常驻开关——两个入口挂两个名字会让人以为"展开底栏把右边展开了"）。
- `brand/copy.ts`：新增 `dockRightCopy`（三个按钮名/提示、模式名、设置项文案）。
- `index.css`：文件末尾新增一节（`.app-body` / `.right-dock` / 竖排页签 / Toast 让位），
  另有两条既有规则被**按新口径**更新（见下）。

**四道门 + 真浏览器**
- `smoke` ✓（exit 0；新增 29 条断言：默认壳/宽度换算/状态/结构/折叠预算/三条负向判据/CSS）
- `lint` 0 error（77 warning，与改前同数）、`tsc -b` ✓、`build` ✓
- `verify:app-ui` **114/114**（92 → 114，新增 22 条真浏览器用例；实测数据见下）

**真浏览器实测（1440×900 / 390×844）**
- PC 首次无存档：右栏 `w=320 / l=1120 / t=40 / b=874 / position:absolute` —— **整幅高度**
  （顶边贴 TopBar 下沿、底边贴状态栏顶边），且 `.app-main` 仍是 1440（浮动**不挤占**）。
- 插入模式（宽档 480）：右栏 `pos=static`、`.app-main` `w=960 = 1440 − 480` —— 真的挤窄。
- 竖排页签：`.right-dock-tabs.is-vert` 在 `.right-dock-main` 里、`writing-mode: vertical-rl`、
  8 个页签齐全、竖条宽 52px。
- 手机（粗指针 + iPhone UA + 390 宽）：默认**底栏**（`.right-dock` 不存在）、设置里
  操作方式只有 `bottom,float` 两项。
- **8 个面板 × 两壳逐个点开**（机器扫，替代方案 §十 原定的手工核对）：右栏 8 个、底栏 8 个，
  每块面板都"露出来 + 宽高 > 0"，扫完应用仍活着（编辑区与右栏都在）。
- **宽屏左右拆分**（`splitH`）三者共存：底栏仍在编辑列（`adj552` 不变）、告警抽屉仍从
  `left=0` 铺到 `right=1440`（阶段 A 的痛点在这一档成立）、右栏仍是整幅高度且浮动不挤窄内容。

**既有断言按新口径改了两处（不是放宽）**
| 位置 | 旧口径 | 新口径 | 为什么 |
|---|---|---|---|
| `verify:app-ui` 的 adj1013 | 提示右缘贴视口右（`vw − right ≤ 30`） | 贴**右栏左缘**（`vw − 右栏宽 − right ≤ 30`） | 右栏出现后，贴视口右边的提示会被右栏压住；"不压住底栏/内容"的意图不变，让位量 = 右栏宽 |
| `smoke` 的 adj530 折叠夹具 | 无 `rightDockW` 字段 | 补 `rightDockW: 0` | 新增的常驻槽位必须进预算；夹具里记 0（那次 `gap: 0`）⇒ 老阈值一个都不用改 |

**验收判据（正向）**
- [x] 三种方式都能进 8 个面板，面板状态互通（切壳不丢当前面板）——右栏与底栏共用 `uiStore.dockPanel`。
- [x] 插入模式：预览/编辑真的变窄；浮动模式：宽度不变、盖在右侧。
- [x] 两档宽度切换生效；手机上是 1/2 与 2/3 屏宽。
- [x] 页签组位置两种都能切；竖排时图标在上、文字竖排、可上下滚。
- [x] 顶栏按钮在窄屏下**仍然可见**（不进折叠链，且宽度恒扣预算）。
- [x] 手机上设置里没有「右侧栏」选项；默认底栏。

**验收判据（负向）**
- [x] 浮动栏点栏外关闭；但点**工作区操作菜单**（portal 到 body）**不**关闭。
      （真浏览器用例：往 body 放一个 `.ws-menu`、真鼠标点它 ⇒ 右栏还在。真工作区菜单要授权
      文件夹才出得来，本轮没有铺那个夹具——判据本身走的是同一条代码路径。）
- [x] 右栏**没有**最小化状态；ESC 只在浮动模式关闭它。
- [x] 底栏模式的行为与改造前**完全一致**（回归）：底栏源码只多了两处守卫，
      `adj552` 结构、19 处页签源码断言、`verify:app-ui` 的既有底栏/抽屉/输入条用例全部照旧通过。

### 阶段 C：面板窄栏适配（adj1297 起，逐面板）

按用户口径：**只保证不崩、不裁内容**。逐面板在 320 / 480 下看一遍，
难看的地方单独开 adj，不在本阶段硬啃。

**阶段 B 收尾时亲眼看到的（截图留档，交给阶段 C）**
- **设置面板 @320px（插入档）**：`.pcfg-row` 的标签列与控件列挤在一起，"左右排列"那一行的
  下拉框压到标签文字上；「编辑器字体」的 `select` 右端超出右缘（被裁一点）。
- **工作区面板 @195px（手机 1/2 屏宽的浮动栏）**：空态那列文字被压成一个字一行，且与右侧
  「新工作区」按钮列的边界重叠。⇒ 阶段 C 要么给这类两栏面板在窄栏下换成上下排，
  要么给它一个最小宽度（右栏在手机上再窄就不给这个面板）。
- 试听 / 导出 / 关于 / 查找替换 / 导入 在 320 与 480 下**基本可用**（不裁、不崩）。

---

## 七、接线清单（逐文件）

### 新增
| 文件 | 内容 |
|---|---|
| `src/ui/ProblemsDrawer.tsx` | 告警抽屉 ✅（adj1290） |
| `src/ui/RightDock.tsx` | 右栏壳 ✅（adj1295） |
| `src/ui/dock/dockPanels.tsx` | 页签定义 + 面板懒加载映射 + 可见页签判据 ✅（adj1293）。⚠ 方案里的「纯页签条组件」**没抽**，见 §3.2 |
| `public/icons/右侧边栏.png` | 顶栏图标（从 cp 的 svg 转）✅（adj1293） |
| `docs/DOCK-LAYOUT-PLAN.md` | 本文件 |

### 删除
| 文件 | 原因 |
|---|---|
| `src/ui/dock/ProblemPanel.tsx` | 改为抽屉 ✅（adj1290） |
| `src/ui/dock/problemsHeight.ts` | 抽屉不做 JS 测高 ✅（adj1290） |

### 修改（代码）
`src/App.tsx` ✅、`src/ui/ToolDock.tsx` ✅、`src/ui/EditorFootBar.tsx` ✅、`src/ui/EditorPane.tsx` ✅、
`src/ui/TopBar.tsx` ✅、`src/ui/topbarFold.ts` ✅（方案漏列：折叠预算的新槽位在这里）、
`src/ui/toolIcons.ts` ✅、`src/store/uiStore.ts` ✅、`src/store/fileHost.ts` ✅、
`src/dialogs/PageConfigDialog.tsx` ✅、`src/dialogs/ShortcutsDialog.tsx` ✅、`src/brand/copy.ts` ✅、
`src/index.css` ✅、`public/sw.js` ✅、`public/icons/` ✅

### 修改（断言）
`scripts/smoke.mts`（32423 行，`dock` 出现 676 次）与 `scripts/verify-app-ui.mjs`。
要动的段落：

| 位置 | 动作 |
|---|---|
| 页签列表断言（`TABS` 里 problems 那条） | 删 problems、改 8 个 |
| `DockPanelKey` 断言 | 去 `'problems'` |
| `adj528/524/555` 高度算式断言（约 21 处） | 删；改为"抽屉高度由 CSS 常量决定"的结构断言 |
| `Ctrl+`` 断言（`requestDockPanel('problems')`） | 改为 `toggleProblemsDrawer()` |
| `expandDock` 断言（含 `adj591` 那条） | 改为无参 |
| 新增 | 抽屉默认收起 / 开关 / 空态；`defaultDockMode`；`dockWidthPx` |
| `verify:app-ui` | 新增真浏览器用例：点状态栏 → 抽屉出现 → 再点消失；三壳切换 |

⚠ 那 19 处「直接读 `ToolDock.tsx` 源码做正则断言」的地方，阶段 B 抽 `dockPanels.ts`
后会红几条——要改成读新文件，**不要**为了迁就旧正则而放弃抽取。

⚠ **落地结果（adj1295）**：页签条**没有抽**（理由见 §3.2 的「落地改法」），所以那 19 处
源码断言**一条都没红**；`dockPanels.tsx` 仍只是 adj1293 抽出来的「页签定义 + 面板映射 +
可见页签判据」三样。阶段 B 实际动过的断言只有两处（见 §六·阶段 B 末尾的对照表）。

---

## 八、已知的坑

1. **portal 菜单被误判为「栏外」**。工作区的操作菜单 portal 到 `body`（`adj540`）。
   浮动栏「点外部关闭」不能用 `contains()` 一判了事，要判 `composedPath` 里有没有
   浮动栏或它的菜单节点；否则点菜单就把栏关了。
   ✅ 已落地：`RightDock` 的判据是「**路径里有 `.app-body` 才算栏外**」+ `.ws-menu` /
   `.menu-dropdown` / `.modal` 显式豁免。`app-body` 那一条同时挡住了 portal 菜单（它根本不在
   内容区里），所以顶栏下拉、状态栏、告警抽屉点了都不会关右栏。
2. **顶栏折叠预算**（`adj453`）。新按钮常驻就必须进预算（跟 `donateSlot` / `moreSlot` 一起扣宽），
   否则窄屏下"开关右栏"的按钮自己躲进「更多」下拉。
   ✅ 已落地：`FoldInput.rightDockW` + 子项数 +1（它自己占一个 flex 间距），smoke 有算式断言。
   ⚠ 它**不进** `TOOL_PRIORITY`——那是"谁先被折进更多"的表，常驻按钮不该出现在里面。
3. **高度算式在右栏里失去意义**。`问题面板 5 行`、`工作区 5 行`、设置面板 `min(55vh,460px)`
   这些是给「矮而宽」算的；右栏是「高而窄」，不旁路会莫名其妙把内容裁成一条。
   ✅ 已落地：右栏根节点**不带** `dock-settings` 类（那条 `height: min(55vh,460px)` 因此不命中），
   并用 `.right-dock { max-height: none; height: 100% }` 覆盖底栏的上限。
   面板内部的高度算式（`ToolDock` 的 AUTO_FIT）**不参与右栏**——右栏走 flex 填满 + 内部滚动。
4. **Toast / UpdatePrompt 与右栏打架**（adj1013 把提示挪到了**右上角**，正好是右栏的位置）。
   ✅ 已落地：`--jp-right-dock-w` 挂在 `<html>` 上，`.toast` / `.update-prompt` 的 `right`
   加上这个变量；`verify:app-ui` 的 adj1013 判据同步改成"贴右栏左缘"。
5. **`initialDock()` 的兜底面板是 `'problems'`**（`uiStore.ts`）。删页签必须同步改，
   否则 PC 首次展开时 `dockPanel` 指向一个不存在的面板。（adj1290 已改成 `'tryout'`。）
6. **`adj1289` 的网页版默认试听**（`shouldOpenTryoutDock`）不受影响，别顺手改。
   ⚠ 组合起来有个**用户可见的后果**（阶段 B 之后才有）：桌面网页版首次打开 =
   「右侧浮动栏 + 试听面板已展开」，会盖住右边 320px。这是 §二 那两条默认值叠加的结果，
   不是 bug；若用户觉得太抢眼，改的应该是"右栏默认收起"这一条（要拍板）。
7. **图标必须走 alpha 通道**。`ToolIcon` 靠 mask 上色，PNG 要是透明底、白色形状；
   直接拿彩色 svg 转出来会变成一块黑或一块白。
8. **`ToolDock.tsx` 是热点文件**（1183 行 + 129 处 CSS 选择器 + 19 处源码断言），
   `index.css` 6602 行。本方案会长时间占着它们，先在本会话认领。
9. **右栏宽度只能由 `dockWidthPx()` 算**（`store/fileHost.ts`）。别在组件里另写一套
   `innerWidth * 0.45`——宽度同时喂给"右栏自己"和"Toast 让位"，两处各算一份必然漂移
   （`AGENTS §六之二·4` 数值口径同源）。

---

## 九、明确不做

- 不做右栏「最小化」状态（宽度只有两档）。
- 第一版不做拖拽调宽（`clientX` 逻辑 + 断言另开）。
- 不动 `EditorFootBar`（用户拍板：不跟）。
- 不重构面板内部布局（阶段 C 只保证不崩不裁）。
- 不撤底栏。
- 不把告警做成常驻横条（用户拍板：抽屉式、默认收起）。

---

## 十、验收命令

```powershell
cd D:\Coding\JianpuScript\ijipu
npm run smoke            # 四道门之一：引擎断言 + 编码闸门
npm run lint
npx tsc -b
npm run build
npm run verify:app-ui    # 真浏览器（改交互必须跑，见 src/AGENTS.md 五·5）
```

手工核对（每阶段结束都要过）：
- 三种操作方式 × 8 个页签，逐个点开看有没有崩、有没有被裁。
  ✅ 阶段 B 起**已机器化**：`verify:app-ui` 的两条 `sweep`（右栏 8 个 + 底栏 8 个，
  判据是"面板露出来 + 宽高都 > 0"）。它挡得住"崩 / 被裁成 0"，挡不住"难看"——
  难看留给阶段 C。
- 手机尺寸（375×667）下：默认底栏、设置里无「右侧栏」、宽度按 1/2 与 2/3。✅ 已机器化。
- 宽屏左右拆分（`splitH` / `splitHE`）下：抽屉贯穿整幅、右栏整幅高度。✅ 已机器化
  （`splitH` 下量：底栏在编辑列、抽屉 `left=0 / right=1440`、右栏整幅高度且浮动不挤窄）。
- 「手机上右栏宽度按 1/2 与 2/3」目前只有**纯函数断言**（`dockWidthPx(…, true)`），
  没有在手机视口下真量过右栏像素宽——因为手机默认底栏、要量它得先手动切到「右侧浮动栏」。
  阶段 C 逐面板看窄栏时顺手补。
