# 底栏 / 右栏 / 告警抽屉 改造方案（adj1290 起）

> 状态：**阶段 A 已完成**（`adj1290`，2026-11-16）；阶段 B / C 待实施。
> 编号：`adj1290` 起（当前最新 `adj1289`）。
> 本文件是这次改动的唯一方案口径。**改法有变，先改这里，再动代码。**

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

### 4.4 宽度换算（纯函数，要断言）

```
dockWidthPx(档位, 视口宽, 是否手机)
  PC：      narrow 320 / wide 480，且夹 min(档位, 45vw)
  手机：    narrow 50vw / wide 66vw
```
手机上不再用 320/480 硬值——320 在 375 宽的手机上几乎全屏。

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

### 阶段 B：右栏壳（adj1293 ~ adj1296）

- 新增 `src/ui/dock/dockPanels.ts`：把 `TABS`（key/label/icon/kbd）+ 懒加载面板映射 +
  `DockBody` 从 `ToolDock.tsx` 抽出来，两个壳共用。**只抽这些，不动高度模型。**
- 新增 `src/ui/RightDock.tsx`：宽度模型（两档）、顶部工具条三按钮、页签两种位置、竖排滚动。
- `App.tsx`：加 `.app-body`；按 `dockSide` 决定渲染 `ToolDock` / `RightDock`。
- `uiStore`：加 4 个 L1 键 + `setDockSide` / `setDockFloat` / `setDockWidth` / `setDockTabsPos`。
- `TopBar`：加常驻图标按钮（进折叠预算）。
- `PageConfigDialog`「版面」页签：加「操作方式」下拉（手机上只给两项）。
- `copy.ts`：新文案集中（模式名、三个按钮的 title、设置项说明）。

**验收判据（正向）**
- [ ] 三种方式都能进 8 个面板，面板状态互通（切壳不丢当前面板）。
- [ ] 插入模式：预览/编辑真的变窄；浮动模式：宽度不变、盖在右侧。
- [ ] 两档宽度切换生效；手机上是 1/2 与 2/3 屏宽。
- [ ] 页签组位置两种都能切；竖排时图标在上、文字竖排、可上下滚。
- [ ] 顶栏按钮在窄屏下**仍然可见**（没被折进「更多」）。
- [ ] 手机上设置里没有「右侧栏」选项；默认底栏。

**验收判据（负向）**
- [ ] 浮动栏点栏外关闭；但点**工作区操作菜单**（portal 到 body）**不**关闭。
- [ ] 右栏**没有**最小化状态；ESC 只在浮动模式关闭它。
- [ ] 底栏模式的行为与改造前**完全一致**（回归）。

### 阶段 C：面板窄栏适配（adj1297 起，逐面板）

按用户口径：**只保证不崩、不裁内容**。逐面板在 320 / 480 下看一遍，
难看的地方单独开 adj，不在本阶段硬啃。

---

## 七、接线清单（逐文件）

### 新增
| 文件 | 内容 |
|---|---|
| `src/ui/ProblemsDrawer.tsx` | 告警抽屉 |
| `src/ui/RightDock.tsx` | 右栏壳 |
| `src/ui/dock/dockPanels.ts` | 页签定义 + 面板懒加载映射 + **纯页签条组件**（只含 tabstrip + 溢出箭头，不含收起/档位/✕；两壳共用） |
| `public/icons/右侧边栏.png` | 顶栏图标（从 cp 的 svg 转） |
| `docs/DOCK-LAYOUT-PLAN.md` | 本文件 |

### 删除
| 文件 | 原因 |
|---|---|
| `src/ui/dock/ProblemPanel.tsx` | 改为抽屉 |
| `src/ui/dock/problemsHeight.ts` | 抽屉不做 JS 测高 |

### 修改（代码）
`src/App.tsx`、`src/ui/ToolDock.tsx`、`src/ui/EditorFootBar.tsx`、`src/ui/EditorPane.tsx`、
`src/ui/TopBar.tsx`、`src/ui/toolIcons.ts`、`src/store/uiStore.ts`、`src/store/fileHost.ts`、
`src/dialogs/PageConfigDialog.tsx`、`src/dialogs/ShortcutsDialog.tsx`、`src/brand/copy.ts`、
`src/index.css`、`public/sw.js`、`public/icons/`

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

---

## 八、已知的坑

1. **portal 菜单被误判为「栏外」**。工作区的操作菜单 portal 到 `body`（`adj540`）。
   浮动栏「点外部关闭」不能用 `contains()` 一判了事，要判 `composedPath` 里有没有
   浮动栏或它的菜单节点；否则点菜单就把栏关了。
2. **顶栏折叠预算**（`adj453`）。新按钮常驻就必须进预算（跟 `donateSlot` / `moreSlot` 一起扣宽），
   否则窄屏下"开关右栏"的按钮自己躲进「更多」下拉。
3. **高度算式在右栏里失去意义**。`问题面板 5 行`、`工作区 5 行`、设置面板 `min(55vh,460px)`
   这些是给「矮而宽」算的；右栏是「高而窄」，不旁路会莫名其妙把内容裁成一条。
4. **Toast / UpdatePrompt 压右下角**（`adj1013` 为底栏调过位置）。右栏出现后会盖住它们，要一起改。
5. **`initialDock()` 的兜底面板是 `'problems'`**（`uiStore.ts`）。删页签必须同步改，
   否则 PC 首次展开时 `dockPanel` 指向一个不存在的面板。
6. **`adj1289` 的网页版默认试听**（`shouldOpenTryoutDock`）不受影响，别顺手改。
7. **图标必须走 alpha 通道**。`ToolIcon` 靠 mask 上色，PNG 要是透明底、白色形状；
   直接拿彩色 svg 转出来会变成一块黑或一块白。
8. **`ToolDock.tsx` 是热点文件**（1183 行 + 129 处 CSS 选择器 + 19 处源码断言），
   `index.css` 6602 行。本方案会长时间占着它们，先在本会话认领。

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
- 手机尺寸（375×667）下：默认底栏、设置里无「右侧栏」、宽度按 1/2 与 2/3。
- 宽屏左右拆分（`splitH` / `splitHE`）下：抽屉贯穿整幅、右栏整幅高度。
