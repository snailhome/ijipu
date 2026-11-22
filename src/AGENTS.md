# AGENTS.md src 模块协作规范

> 本文件由 DeepSeek Harness（DSH）在会话进入 `src/` 目录时**动态注入**；项目级规则见根目录 `AGENTS.md`。

## 一、src 模块职责

`src/` 是应用源码统一存放目录，按职责分层：

| 目录 | 职责 | 约束 |
|------|------|------|
| `engine/` | 简谱引擎：解析（parser/tokenizer）、格式化（format）、排版（layout）、渲染（render）、播放（playback）、光标映射（cursorMap）、时值（duration）、类型（types）；**adj758–adj766 新增共性层**：`highlight/`（分词 `jpsHighlight` ／ 错误→块 `jpsProblems` ／ 逐行模型 `model` ／ 色板 `palette`）、`diagnostics/`（问题分级与展示行 `problems`）、`playback/`（色块 `playhead` ／ 音源清单与顺序 `soundbanks` ／ 时钟 `clock`）、`samples/template`（新建模板）、`settings/layers`（分层判定规则） | **纯 TS，零 React/DOM/浏览器 API 依赖**（宿主全局只允许 `typeof` 守卫下的用法，有闸门 `adj770`），可在 Node 中单测；数据流单向 `source → parse → layout → render/playback`，禁止反向依赖；入口统一 `engine/index.ts`；**两端（应用 / Obsidian 插件）共用的规则一律先落这里**，插件经 `vendor/engine` 逐字节同步（闸门 `adj770`） |
| `editor/` | 代码编辑器：EditorPane（textarea+高亮层）、highlight、history（撤销/重做）、shortcuts（行首命令快捷键） | 只做编辑交互；解析/格式化调用 engine，不复制引擎逻辑 |
| `preview/` | 乐谱预览：PreviewPane（SVG 渲染消费 + 光标联动 + 排版辅助虚线拖拽） | 渲染消费 engine 输出，虚线位置计算调用 `engine/layout/guides.ts` 纯函数，不重算几何 |
| `store/` | Zustand 状态：docStore（代码/解析结果/页面配置/历史）、uiStore（模态框/主题/缩放/字号）、**externalChange（外部改动判据与基准，adj927：纯判据 + 注入 IO 的编排，可在 Node 里断言）** | 唯一状态源；localStorage 键集中定义在文件顶部常量（`ijipu.` 前缀），禁止组件内散落硬编码键名 |
| `ui/` | 通用组件：MenuBar、Toolbar、Modal、StatusBar、**ConfirmBar（顶部确认条，adj724b/adj928：多一个「查看差异」）** | 无业务状态，只消费 store；图标/按钮样式走 CSS 变量 |
| `dialogs/` | 功能对话框：PageConfig、Playback、Export、Samples、Shortcuts、About、**FileDiffDialog（两栏源码差异框，adj928）** | 每个对话框一个文件，统一用 `ui/Modal`；打开/关闭走 uiStore.modal（FileDiffDialog 例外：走 `uiStore.fileDiff`，因为它叠在确认条之上） |
| `diff/` | **源码差异计算**（`textDiff.ts`，adj927/adj928）：归一化（CRLF/行尾空白/末尾换行不算改动）、内容指纹（FNV-1a+长度）、行级 LCS 对齐 + **行内字符级高亮**、默认折叠口径 | **纯函数、零依赖、零 DOM**，可在 Node 里直接断言；只算差异，界面在 `dialogs/FileDiffDialog.tsx`；**归一化只用于比较与展示，绝不回写用户内容**；超长输入必须退化而不卡死（`degraded`） |
| `export/` | 导出模块：PDF/JPG/SVG/PNG（export.ts） | 纯函数 + 浏览器下载，仅在用户主动触发时执行 |
| `playback/` | 播放辅助：采样音色库离线缓存（浏览器 IndexedDB / Tauri 文件系统，samplerCache.ts，adj323）；**空格 = 播放/暂停的目标判定**（spaceToggle.ts，adj1321：编辑区/右栏底栏/输入框不接管） | 实现 engine 的 `SamplerCache` 接口；只做缓存读写与预缓存编排，音频播放仍走 engine；空格判定是纯函数 + DOM 取信息两层，纯函数可在 Node 断言 |
| `brand/` | 品牌层：tokens（色板/字体/口号/**官网地址**）、copy（面向用户文案）、themes（中国色主题）、version（版本号）、siteVars/siteLinks（**官网页面**的品牌色注入与外部链接填充，adj876）、siteBoot（**官网首屏启动层**：色值/元素 id 的唯一口径 + 揭示时机，adj930） | 所有品牌字面量集中于此，禁止在其它代码硬编码文案/色值/版本号；官网的**外部地址**（GitHub / 下载 / 插件）也放这里，HTML 里只写 `data-l="<键名>"` 由 `siteLinks.ts` 填；**启动层那段内联 CSS 必须留在各页 `<head>` 里**（外链样式表来不及防闪烁），色值只改 `siteBoot.ts` + 四页（smoke `[168]` 逐字核对） |
| `help/` | 帮助文档渲染：markdown.ts（Markdown→HTML 纯函数 + `extractToc`，adj876 从 `dialogs/DocDialog.tsx` 抽出） | **纯函数、零依赖、可在 Node 里直接断言**；应用内帮助与官网 `/manual/`、`/syntax/` **共用这一个渲染器**（标题 id 与目录锚点必须同源，有 smoke 闸门兜底）；不许在这里引 React/DOM |
| `landing/` | **官网介绍首页**（`/`）的入口与样式：main.ts + landing.css（adj876） | 只做"注入品牌色 / 填外链 / 填版本号 / 少量交互 / 揭示首屏启动层（adj930，见 `brand/siteBoot.ts`）"；**不引 React、不引引擎**（首页正文写在根 `index.html` 里，为的是 SEO 与首屏，有 smoke 断言守着）；样式只消费 `--site-*` 变量 |
| `docs/` | **官网文档页**（`/manual/`、`/syntax/`）：render.ts（共用的渲染+目录+滚动高亮）+ manual.ts / syntax.ts（两个入口各导自己那份 md）+ docs.css（adj876） | 两个入口**各自 import 自己那份 `docs/*.md`**，不要合并（否则一页会把另一份 80KB 也下下来）；正文运行时注入，与应用内帮助同源 |
| `styles/` | 主题样式：theme.css（品牌 token CSS 变量） | 样式统一用 `var(--jp-*)` 变量，禁止散落魔法色值 |
| `gen/` | 自动生成：buildInfo.ts（BUILD_DATE/GIT_COMMIT） | 由 scripts/gen-build-info.mjs 生成，**禁止手改**（已在 .gitignore） |
| `samples/` | 示例谱登记：index.ts（?raw 导入 samples/*.jps） | 新增示例谱两处同步：`public/samples/*.jps` 原文 + 此登记（id/name/description/code）；**「新建」模板 = `src/samples/未命名.jps`**（adj481 文件驱动：改这个文件即改新建出来的空白谱，代码里不内嵌副本、只有极小兜底；放源码目录而非 `public/`，免得随产物发布） |

> 本职责表是 AI 判断「代码该放哪」的依据：新增/调整目录或职责时，必须先更新本表再动代码。

## 二、engine 引擎约束（强制）

1. **零 React/DOM 依赖**：engine 文件不得 `import` react、react-dom、window/document/localStorage；纯几何/字符串/音频序列计算
2. **入口收敛**：对外 API 统一从 `engine/index.ts` 导出（parseJps、layoutScore、renderScoreToSvg、buildPlaySequence 等）；内部模块按需导入，禁止跨层绕过
3. **数据流单向**：`source(.jps) → parseResult → layout(ScoreLayout) → render(SVG) / playback(sequence)`；layout 不得反向读取 render 产物
4. **数值集中**：默认排版数值（边距/字号/行距/间距）定义在 `engine/types.ts` 的 `defaultPageConfig`，布局计算引用 `engine/layout/index.ts`；调整用 `adjNN` 编号标注
5. **可测性**：引擎关键行为（解析/时值/布局/虚线/播放序列/两点共用的共性层）必须在 `scripts/smoke.mts` 有断言（`npm run smoke`，具体条数以输出为准，**不要在文档里写死数字**——写死就会过期）；新增行为先写断言再实现。凡是"两端都要用的规则"，断言还要覆盖"两端不再各自实现"（见 `adj767`/`adj770` 两道收口闸门）
6. **排版辅助虚线**：位置计算收敛在 `engine/layout/guides.ts`（computeRowTops/computeRowGuides/quciGuideY/dragDelta/clamp）；quci 虚线钳制在「曲部内容下沿」与「歌词文字上沿」之间、cici 虚线不越过歌词下沿（adj53），预览层只消费

## 三、store 状态管理

1. `docStore`（文档态）：code、parseResult、pageConfig、cursor/sel、撤销/重做历史（history.ts，上限 50 步、输入合并窗口）、草稿自动保存（ijipu.draft）
2. `uiStore`（界面态）：modal、showGuides、theme/themeMode、splitPct、editorFontSize、previewZoom；写入 localStorage 前范围钳制（缩放 50~200、字号 10~26、拆分 15~85）
3. **数据流**：组件通过 `useDocStore((s) => s.xxx)` 按字段订阅，禁止解构整个 store 造成全量重渲染；修改一律走 store action，禁止组件直接改 store 内部状态
4. **持久化键**：`ijipu.` 前缀常量集中在 store 文件顶部（DRAFT_KEY/PREVIEW_ZOOM_KEY 等），读取必须 try/catch 回退默认值。
   **adj480：不再有"页面设置"缓存键**——`PageConfig` 只有「代码默认 ← 谱面 `# jps-config`」两层（谱面自包含才谈得上"复制给别人显示一致"）；
   `ijipu.pageConfig` 只保留一次性迁移清理（`docStore.migrateLegacyPageConfig`），**不得再写入**
5. **本机配置的三端落点（adj1085，用户口径）**：同一个 `ijipu.*` 键空间，落点按端区分——
   桌面壳：`store/prefs.ts` 把 `window.localStorage` 换成门面，落 `%APPDATA%\iJipu\settings.json`（`settings.bak.json` 备份、
   原子替换、首次从 WebView2 `localStorage` 迁移一次）；网站/PWA：浏览器 `localStorage`；Obsidian 插件：宿主桥 → 插件目录 `data.json`。
   新增 L1 偏好**照旧用 `ijipu.` 前缀 + localStorage 读写**（无需感知后端）；**L2 谱面配置永远进 `.jps`**；
   图片等大值走文件/IndexedDB，不塞键值表。命令行出片窗口是第二个进程，**不写配置**。完整口径见 `docs/DATA-STORAGE.md`。

## 四、品牌与文案集中管理（强制）

1. 品牌 token（应用名/中文名/Slogan/用户身份/色板/字体）统一定义在 `src/brand/tokens.ts`，其余代码经 `brand` 导入引用，禁止硬编码
2. 面向用户的文案集中定义在 `src/brand/copy.ts`（aboutCopy/uiCopy），组件不得直接写字面量文案
3. 主题集中定义在 `src/brand/themes.ts`（中国色主题 + 深浅色模式），样式消费 `var(--jp-*)` CSS 变量
4. 版本号唯一手动维护点 `src/brand/version.ts` 的 `APP_VERSION`；发布时与 `package.json version`、`src-tauri/tauri.conf.json version` 三处一致（根 AGENTS 十一）
5. 新增任何品牌字面量时，先在 brand 对应文件添加常量并写中文注释，再在调用处引用

## 五、UI 与样式约定

1. 组件文件头部写中文说明注释；组件名与文件同名（PascalCase）；一个文件一个组件（oxlint `react/only-export-components`）
2. 布局用 flex；间距/色值统一走 CSS 变量与既有工具类，禁止散落魔法值
3. 工具栏/菜单按钮顺序调整、图标样式调整等 UI 改动标注 `adjNN` 编号并同步 commit message
4. 新增对话框：Modal 标题 + 底部操作区（确定/取消靠右），参考 PageConfigDialog 既有结构
5. **改应用内 UI（尤其"点了要动"的交互）时，除了冒烟还要跑 `npm run verify:app-ui`**（真浏览器点一遍）：
   `adj959` 的教训 —— 「事件挂错地方」这类缺陷**源码级断言守不住**：代码里确实"挂了监听"，
   `tsc`/`lint`/`smoke` 全绿，但事件**收不到**（两条真实成因：① 监听挂在**冒泡阶段** `document` 上，
   被 `ui/Modal.tsx` 给 `.modal` 挂的 `stopPropagation` 掐断；② 事件委托挂在 `.doc-content` 上，
   而浮层是它的**兄弟节点**）。两条现成口径：**模态框里的"点外面关掉"一律用捕获阶段**；
   **浮层不要靠正文容器做事件委托**。
6. **做事件委托前先核对 DOM 关系**：被委托的元素必须是目标元素的**祖先**（Portal、`position: fixed`
   浮层、兄弟节点都会让委托静默失效）；跨组件时还要看上游有没有 `stopPropagation` 掐断原生化冒泡。
7. **dev 模式功能全开**（用户 2026-10-23 口径）：`npm run dev`（`isDevBuild()`）下，因产品边界隐藏的 UI 功能
   **必须开放**（动态谱视频等），方便真浏览器测试；**唯一例外是必须由插件宿主提供的能力**（host bridge）。
   需要 Tauri 原生命令的功能（如音色库“发现”扫描）用 `tauri dev` 测。生产网站/插件仍按边界隐藏；
   环境闸门统一走 `brand/env.ts` 的 `isTauriShell()` / `isHostFrame()` / `isDevBuild()`，不许各写一套。
