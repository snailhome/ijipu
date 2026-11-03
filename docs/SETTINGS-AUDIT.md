# 设置归属梳理（iJipu 应用 → 嵌入 obsidian-ijipu 的前置分析）

> 目的：把 iJipu 应用里**所有**设置/状态点分门别类，明确「哪些该随 .jps 走、哪些是用户个性、哪些只是会话状态」，
> 作为「应用整体嵌入 Obsidian 插件」方案（见 `docs/EMBED-PLAN.md`）的输入。
>
> 数据来源：本轮对 `src/**` 的全量扫描（localStorage 键、IndexedDB 库、Tauri 分支、`PageConfig` 54 字段、store 定义）。

---

## 一、判定准则（三条提问）

一个设置该放哪一层，用三问决定：

1. **改它会不会改变谱面的外观/排版结果？** 会 → 谱面级（进 `# jps-config`）。
2. **换一台机器/换一个用户打开同一份 .jps，期望看到一样吗？** 期望一样 → 谱面级；允许不一样 → 用户级。
3. **丢掉它用户会不会烦（要重新设置）？** 会 → 用户级（需持久化）；不会 → 会话级（内存即可）。

例外：**编辑器/界面偏好永进谱面级**（方向反了也要按第 2 问归用户级）。

---

## 二、四层模型

| 层 | 含义 | 存储 | 谁能改 | 嵌入 Obsidian 后 |
|---|---|---|---|---|
| **L0 代码默认** | `defaultPageConfig`、`DEFAULT_HQ_ENABLED`、品牌/主题默认 | 源码常量 | 开发者 | 不变 |
| **L1 用户个性** | 只影响"我这个人的使用体验"，与具体谱无关 | 缓存（localStorage / 插件设置 / IndexedDB） | 用户 | 由**宿主**提供与持久化（按库或全局，见 D4） |
| **L1.5 笔记级**（仅 Obsidian） | 一个笔记内多份谱的统一覆盖 | 笔记 frontmatter `ijipu_*` | 用户 | 是否保留待定（见 D3） |
| **L2 谱面级** | 决定这份谱长什么样，必须跟着 .jps 走 | 源码 `# jps-config:{...}` | 用户（按谱） | 不变（核心不变式） |
| **L3 会话级** | 打开期间的临时状态，重开即重建 | 内存 | — | 不变（但需**每实例独立**） |

优先级（现状，保持）：**L0 < L1 < L1.5 < L2**。

> **adj480（2026-09-18）用户确认：`PageConfig` 取消 L1 层——谱面自包含。**
>
> 用户目标原话："我把脚本复制给其他人，其他人显示的应该是和我一样的效果……因此打开一个 jps 时，
> 谱面设置应该更新配置值，除非谱面没有携带这个值；如果没有缓存的设置值，则使用默认值"，
> 并追问"当必须值都进谱面后，本机缓存的意义不大了……是不是可以取消本机缓存？"——**结论：可以，且必须**：
>
> | 项 | 结论 |
> |---|---|
> | `localStorage['ijipu.pageConfig']`（本机页面设置层） | **删除**。它只对"谱面没写的项"兜底，是"我和别人看到的不一样"的**唯一来源** |
> | 生效配置 | **代码默认 ← 谱面 `# jps-config`（两层）**；`resolveConfig()` 传 `null` 兜底 |
> | 写入 | 保持差量（只写与默认不同的项）⇒ **保存即自包含**；「固化到谱面」按钮**删除**（不再需要） |
> | 保留在 L1 的 | 主题 / 编辑器字体字号 / **字体覆盖开关** / 音色 / 缩放……（都不参与谱面渲染配置链） |
>
> 关键事实支撑：① 新建文档从 adj214 起就**不吃**这一层（`mergeJpsConfig(template, null)`）⇒ 删除它几乎没有便利性损失；
> ② 它其实是"脏"的——`setPageConfig()` 无论是否持久化都把**整份生效配置**写回缓存（预览/取消回写也算），
> 所以内容是"上一份谱的整份配置"而非"我的默认"。
> 残余差异（已在文档与 UI 里写明）：**字体字形跨机不保证**（字体栈随谱走）；**字体覆盖开关**会让"我看到的字体"与谱面不同；
> **跨版本默认值演进**（不写默认值 ⇒ 两端版本不同且默认改过时会不同；需要冻结时用 `writeJpsConfig(..., {mode:'full'})`）。
> 宿主侧（Obsidian 插件）：插件设置 / 笔记 frontmatter 仍是"只对源内没写的项生效"的默认层，且**不随谱走**——
> 用引擎 `configCarryover(code, effective, baseline)` 显式列出差异，用户点「随谱固化」把它们写进谱面
> （保留"改一处、全库统一变"的能力）。
>
> **adj639（2026-09-30）用户要求**："将插件的默认值体系与应用的默认值体系保持一致，以确保在应用正常的
> 谱面设置，在插件中不会有未随谱携带的提示项。" 落地：`configCarryover` 新增第三个参数 `baseline`
> = **本库默认层**（`代码默认 ← 插件设置`，**不含**笔记 frontmatter）——与它一致的值**不算"未随谱携带"**。
> 理由：这一层在用户眼里就是"本库默认值"，等价于应用里的**代码默认值**；提示于是只剩"这篇笔记特有"的
> 差异（典型来源 = frontmatter）。插件侧在 `src/config.ts` 的 `resolvePageConfig()` 里产出该基线
> （`mergeJpsConfig('', settings)`），`scorePane.ts` 把它传给 `configCarryover`。应用侧不传（无 L1 层）⇒ 口径不变。

> **adj454（2026-09-16）用户确认与落地**：读取优先级就是「**源码设置 > 缓存设置 > 默认设置**」——
> `engine/settings.ts` 的 `mergeJpsConfig` 展开顺序 `{...defaultPageConfig, ...(缓存), ...(源码)}`
> ——*（adj480 起：应用侧已取消"缓存"这一层，见下；`mergeJpsConfig` 的 `fallback` 参数保留给宿主侧插件设置/frontmatter 用）*
> 即优先级本身（源码最后展开、覆盖前两层），现已由 smoke `[107]` 用例逐条锁定；
> 应用侧所有入口统一走 `docStore.resolveConfig()`（= 合并 + L1「字体覆盖」），
> **包括撤销/重做**（此前 `restoreEntry` 漏了字体覆盖这一层）。
> 同轮还补了两处与"分层"直接相关的行为：
> ① **写方向只固化用户改动**（`mergeConfigEdits`）——点「保存设置」/拖拽虚线松手时，只把本次真正改动的
>    字段写进 `# jps-config`；缓存来源的值不再被固化（此前会把本机公共设置写进别人的谱）；
> ② **读取端类型校验**（`inspectJpsConfig`）——坏 JSON / 值类型不对 / 键拼错 / 设置行被缩进，
>    一律给出带行号的告警（并进 `ParseResult.errors` → 问题条 + 状态栏橙点），不再静默"设置丢失"。
>
> **adj603/605/606（2026-09-23）设置面板的三条口径**：
> ① **按归属分家**——底栏拆成「全局」（版面/主题/音色库/命令行，L1 本机偏好，改完即时生效）与「谱面」（布局/字体，L2 随谱保存）
>    两个页签，同一个组件按 `section` 各渲染一份；**「保存设置」只出现在 L2 那一半**（L1 没有"保存"这一步）；
>    > **adj944**：「命令行」页签里只有**一个动作**（把安装目录注册进当前用户 PATH / 解除）＋**现读系统实况**的状态，
>    > **不存任何自己的配置**（用户手动改过 PATH 也如实反映）；文案在 `brand/copy.ts` 的 `cliPathCopy`，口径见 `docs/CLI.md` §二之二。
> ② **非默认项可见**——「谱面」页签里与 `defaultPageConfig` 不同的项，标签后带红色 `*`。判据用引擎的
>    `nonDefaultConfigKeys(cfg)`，它**就是** `writeJpsConfig(..., {mode:'diff'})` 会写出的键集
>    ⇒ "带 `*`" 严格等价于"点保存后会进谱面"，不靠另写一套比较逻辑（避免两套口径漂移）；
> ③ **可选字段的"关值"是 `undefined`**——`showInstrument`/`lyricShrink` 这类不在 `defaultPageConfig` 上的字段，
>    复选框取消勾选写 `undefined`（而不是 `false`），`sameValue` 也把**布尔**的 `false` 与 `undefined` 视为同一状态
>    （只布尔：`0`/`''` 语义上确实与"未设置"不同，不参与归并）。否则 `false` 会被当成"与默认不同"：
>    标记不熄灭，还会往 `# jps-config` 写一条冗余的 `false`（`E-2026-294`）。

---

## 三、L2 谱面级：`PageConfig` **54** 字段逐一归属（49 个有默认值 + 5 个可选）

图例：✅ 随谱（保留） · ⚠️ 随谱但有争议 · ❌ 不该随谱（要移出）

| # | 字段 | 默认 | 现值语义 | 归属 | 说明 |
|---|---|---|---|---|---|
| 1 | `page` | A4 | 纸张 | ✅ | 直接决定分页与可用宽 |
| 2-5 | `margin_top/bottom/left/right` | 40 / 40 / 50 / 50 | 页边距 | ✅ | 拖拽虚线可调；adj418：左右默认 40 → 50 |
| 6 | `body_margin_top` | 20 | 曲部上间距 | ✅ | 描述头区域高的一部分 |
| 7 | `descAreaH` | 80 | 描述头内容区高 | ✅ | |
| 8-9 | `biaoti_font/size` | 系统栈 / 20 | 标题 | ⚠️ | 字体跨机可能缺失（见 D2） |
| 10-11 | `fubiaoti_font/size` | 系统栈 / 15 | 副标题 | ⚠️ | 同上 |
| 12-13 | `miaoshu_font/size` | 系统栈 / 13 | 描述头 | ⚠️ | 同上 |
| 14-15 | `notes_font/size` | 系统栈 / 12 | 说明文字 | ⚠️ | 同上 |
| 16-17 | `geci_font/size` | 系统栈 / 11 | 歌词 | ⚠️ | 歌词字号直接影响行高与分页 → 偏"谱面" |
| 18 | `note_size` | 13 | 音符字号 | ✅ | 决定整行几何（缩放基准） |
| 19 | `shuzi_font` | 系统栈 | 音符数字字体 | ⚠️ | 同上 |
| 20-24 | `height_quci/cici/ciqu/ciqu_lyric/shengbu` | 20/10/20/-5/0 | 行距 | ✅ | 拖拽虚线可调；设置面板均有输入框（adj479 补「声部间距」），其中 `ciqu_lyric` 与 `shengbu` 允许负值（拖拽下限 −80 / −30，用于压缩行距）；默认值 adj629w/adj629y 按用户要求改：`ciqu_lyric` 10 → **−5**、`quci` 15 → **20** |
| 25 | `bar_gap` | 0 | 小节间距 | ✅ | |
| 26 | `align_min_bars` | 4 | 两端对齐最小小节数 | ✅ | **只对"整份谱的最后一行"生效**（adj925 用户裁定「只针对末行有效」+ adj935 收窄"末行"口径）：非末行一律两端对齐撑满；末行才看它（小节数 < 它 ⇒ 自然宽、行尾留白，且按 adj199/adj355 不窄于上一行对应小节）。**第二个作用**：整份谱只有一行且小节数 < 它 ⇒ 走 `adj421` 预分槽（每小节 1 个槽）。多行谱里"某段只有一行"**不再**算末行、也不再预分槽（一律撑满） |
| 27 | `noteSpaceLayout` | space | 空间优先/时值优先 | ✅ | 改变断行结果 |
| 28 | `lianyinxian_type` | 0 自动 | 连音线样式 | ✅ | 绘制样式 |
| 29 | `lyricShrink` | 未设(false) | 歌词压缩避免重叠 | ✅ | 影响歌词占宽 |
| 30 | `showInstrument` | 未设(false) | 显示乐器名 | ✅ | 谱面内容的一部分 |
| 31 | `editorFont` | 未设 | **编辑器**字体 | ❌ | 与谱面外观无关 |
| 32 | `editorFontSize` | 未设 | **编辑器**字号 | ❌ | 同上 |
| 33 | `metaPos` | 未设 | 描述头元素拖拽位置 | ✅ | 版式的一部分 |
| 34 | `heights` | 未设 | 按页行距覆盖（旧） | ✅（只读兼容） | 引擎仍支持 `heights['a'+page]`；当前无 UI 写入 |
| 35 | `segmentRowGap` | 未设 | 临时段（{bz/dsb/tp}）纵向间距（`{bz?,dsb?,tp?}`，单位 px；`tp` = 替谱行与其下方歌词行的间距，adj629e） | ✅ | 决定临时叠加段的几何；属于"这份谱长什么样"，应随谱走 |
| 36 | `showBarCount` | true | **显示小节计数**（小节线下的方框小节序号） | ✅ | 谱面内容的一部分（画出来就是版式的一部分）；adj625 用户要求，adj630c 默认由关改为**勾选** |
| 37 | `barCountInterval` | 4 | **小节序号间隔**（每隔几个小节显示一个序号，1~99） | ✅ | 只在 `showBarCount` 打开时生效；决定"哪几小节带序号"，随谱走 |
| 38 | `wmType` | `'text'` | **水印类型**：文字 / 图形 | ✅ | adj965（方案 OVL）；两个字段都保留、由它决定画哪个 |
| 39 | `wmText` | `'爱记谱・iJipu'` | **水印文本**（空 ⇒ 不画；支持 `\n` 多行） | ✅ | 同上；**adj1189 用户默认值**（仍受 `wmEnabled=false` 约束） |
| 40 | `wmImage` | `''` | **水印图形**：相对 `.jps` 的路径 / 插件 `[[双链]]` / `data:` URI（空 ⇒ 不画） | ✅ | 同上；⚠ 外部依赖 ⇒ 与"谱面自包含"冲突（见该方案 §十一.1） |
| 41 | `wmSize` | 22 | **文本水印字号**（pt，钳 6~400） | ✅ | 用户裁定：单列字段，不共用 `wmScale`；adj1189 默认 36 → 22 |
| 42 | `wmScale` | 100 | **图形水印宽度**占**页宽**的百分比（钳 10~1000） | ✅ | 用户裁定：基准是页宽 |
| 43 | `wmRotate` | -45 | 水印旋转角（度，钳 ±180；绕自身中心） | ✅ | 同上；**默认 -45**（用户 2026-10-15 裁定：从 +45 改为 -45） |
| 44 | `wmOpacity` | 25 | 水印不透明度（0~100，100 = 不透明） | ✅ | 同上 |
| 45 | `wmOffsetX` | 0 | 水印中心相对**页面中心**的横向偏移（pt） | ✅ | 同上（0,0 = 居中） |
| 46 | `wmOffsetY` | 0 | 同上，纵向 | ✅ | 同上 |
| 47 | `bgImage` | `''` | **背景图**：同 `wmImage`（空 ⇒ 不画） | ✅ | adj965 |
| 48 | `bgScale` | 100 | 背景图宽度占**页宽**的百分比（钳 10~1000） | ✅ | 同上 |
| 49 | `bgRotate` | 0 | 背景图旋转角（度，钳 ±180；绕图片中心） | ✅ | 同上 |
| 50 | `bgOpacity` | 100 | 背景图不透明度（0~100） | ✅ | 同上 |
| 51 | `bgOffsetX` | 0 | 背景图中心相对页面中心的横向偏移（pt） | ✅ | 同上 |
| 52 | `bgOffsetY` | 0 | 同上，纵向 | ✅ | 同上 |
| 53 | `wmRepeat` | false | **重复水印**：按行列间隔平铺满页面（false = 只在正中画一个） | ✅ | 用户 2026-10-15 要求；默认关闭 ⇒ 不用它时零变化 |
| 54 | `wmRepeatGap` | 300 | 平铺**间隔**（%）：空隙 = 水印自身尺寸 × 该值/100（300 ⇒ 步进为自身 4 倍；100 ⇒ 2 倍） | ✅ | 同上（只在 `wmRepeat` 打开时生效）；**默认由 100 改 300**（用户 2026-10-15 裁定：100 太密） |
| 55 | `wmEnabled` | false | **启用水印**（总开关）：false ⇒ 整层不画、连 `<defs>` 都不产出 | ✅ | 用户 2026-10-15 要求；**默认关**（用户裁定），勾上会写进 `# jps-config` |
| 56 | `bgEnabled` | false | **启用背景**（总开关）：同上 | ✅ | 同上 |

> 上面 38–52 是 `adj965` 的**水印层/背景层**（完整规格与实现清单见 `docs/OVERLAY-PLAN.md`「OVL」）。
> 三者都是"这份谱长什么样" ⇒ L2、随 `# jps-config` 走；**默认全部等于默认值** ⇒ 差量写入**一个键都不落**
> （不用这功能的谱与以前逐字节相同，有闸门 `adj965` 钉着）。
> ⚠ 它们**不参与**"谱面元素墨迹不重叠"那条铁律（是页面级底图，不参与元素排布）。

### 现存问题①：`editorFont/editorFontSize` 既进了 .jps，又是"两份存储"（真 bug 级）

- **写进文件**：顶栏的 A−/A+ 与字体下拉**直接写 `pageConfig` 并持久化**：
  `TopBar.tsx:368/380/416/469/483` → `setPageConfig({ ...pageConfig, editorFontSize: v }, true)`
  → `docStore.setPageConfig(cfg, true)` → `writeJpsConfig(code, cfg)`（`engine/settings.ts` 用 `JSON.stringify(cfg)` 写**整份**配置）。
- **两份存储并存**：同一偏好还存在 `uiStore`（localStorage `ijipu.editorFont` / `ijipu.editorFontSize`），
  读取时 `pageConfig.editorFontSize ?? editorFontSize`（`EditorPane.tsx:79-80`、`TopBar.tsx:180-181`）——
  **谁赢取决于谱面里有没有写**；而**页面设置对话框里的字体/字号控件写的是 uiStore**（`PageConfigDialog.tsx:100-103`），
  顶栏写的是 pageConfig → 同一个"编辑器字号"在两个入口写进两个地方。
- 后果：① 把 .jps 发给别人 → 别人的编辑器字体/字号被改；② 用户自己也会困惑"我改了字号，为什么换台机器/换了谱又变了"；
  ③ 想改默认值时要同时改两处。
- 结论：**必须移出 L2**；`editorFont/editorFontSize` 只保留 L1（缓存/宿主），并把两个入口统一到 L1。做法见「六、迁移」。

### 现存问题②：写入策略是"全量"，会永久钉住旧默认

- 现状：`# jps-config` 记录**全部**（含与默认值相同的项，约 930 字符一行）。
- 后果：① 文件冗长；② 将来把某个默认值改得更合理，**旧谱永远按旧默认渲染**（即使那份谱从未被用户改过）；③ 编辑器偏好顺带泄漏。
- 备选策略见「五、决策 D1」。

---

## 四、L1 用户级：全部持久化项清点

### 4.1 localStorage（键数随功能增加；全部 `ijipu.` 前缀）

| 键 | 默认 | 作用 | 类别 | 嵌入后的归属 |
|---|---|---|---|---|
| `ijipu.pageConfig` | `{}` | ~~**公共默认页面设置**（L1 默认层）~~ **adj480 已删除**（仅保留一次性迁移清理） | 用户个性 | 无（谱面自包含；宿主的"默认层"另见插件设置） |
| `ijipu.theme` | 品牌默认 | 中国色主题 id | 用户个性 | 保留；建议增加"跟随 Obsidian"（D5） |
| `ijipu.themeMode` | auto | 浅/深/跟随系统 | 用户个性 | 跟随 Obsidian 深浅（D5） |
| `ijipu.editorFont` | Consolas | 编辑器字体（限等宽） | 用户个性 | → 插件按库缓存（编辑体验） |
| `ijipu.editorFontSize` | 14 | 编辑器字号 10~26 | 用户个性 | 同上 |
| `ijipu.autoWrap` | true | 自动折行 | 用户个性 | 同上 |
| `ijipu.showScriptPad` | 触屏/窄屏=true | 输入工具条显隐 | 用户个性 | 同上 |
| `ijipu.previewZoom` | 100 | 预览缩放 50~200 | 用户个性 | 保留但**意义有限**（窗格宽度由宿主决定）——adj529 已补上"**双击顶栏比率值即按预览区宽度适配**"的一次性动作（不新增设置/状态） |
| `ijipu.splitPct` | 50 | 拆分比例 | 用户个性（视口相关） | **改用宿主/窗格**，嵌入时不再持久化 |
| `ijipu.splitHDir` | previewLeft | 左右拆分方向 | 同上 | 同上 |
| `ijipu.viewType` | split | 视图偏好（拆分/编辑/预览） | 同上 | 同上（由宿主决定布局） |
| `ijipu.showGuides` | true | 排版辅助虚线开关 | UI 状态（可持久化可不） | 建议插件级开关或会话状态 |
| `ijipu.playbackHqLibrary` | ''(默认库) | 音源库 id | 用户个性 | → 插件设置（已实现） |
| `ijipu.playbackHqVoice` | ~~null=自动~~ | ~~默认音色（GM program）~~ | **adj448：改为会话级（L3），不再落盘**（adj450：**本次运行内记住**，重启回到「自动」） | 选定音色会**覆盖谱面 `Y:` 乐器**，被持久化会让用户误判「谱面 Y: 不生效」⇒ 不落盘 + 选定即提示；旧键仅用于清理残留。Obsidian 插件侧同口径（设置项说明写明覆盖关系） |
| `ijipu.playbackHqEnabled` | 常用 7 种 | 收藏音色集合 | 用户个性 | → 插件设置（已实现） |
| Obsidian 插件设置 `exportRange` | `view` | **导出范围**：`view`（跟随视图，**默认**，用户 2026-10-11 定稿）/ `page`（整页 + 留白）/ `score`（墨迹 + 每边 2px） | **L1 用户个性**（adj863/adj864；adj873 改默认值） | 与具体谱无关、**不随谱走** ⇒ 只存插件 `data.json`，**不进** `defs.ts` 的 `DEFS`（那是跟谱走的 L2）、不写进谱面源码。设置页与「⋯ 更多 → 导出范围」是**同一个值**，缺省值只在插件 `src/types.ts` 的 `DEFAULT_EXPORT_RANGE` 一处定义；几何一律走引擎 `rangeBox()`（唯一口径） |
| Obsidian 插件设置 `embedChannel` | `false` | **嵌入版通道**总开关（原「开发者：允许嵌入版调用插件能力」，adj868 改名） | **L1 用户个性 / 安全开关** | 管两条 postMessage 通道：**插件 → 应用**（`render.png` / `export.midi` / `playback.*` ⇒ 导出 PNG / MIDI / 复制为图片必经）与**应用 → 插件**（能力探测/渲染，目前无调用方）。adj868 起**持久化**（原来仅本会话有效）；默认关=安全优先；打开后仍受来源校验 + 方法白名单 + 参数校验约束 |
| `ijipu.draft` | — | **未保存草稿正文** | 独立应用专用 | **嵌入时必须禁用**（vault 才是唯一真源） |
| `ijipu.draftName` | — | 草稿文件名 | 独立应用专用 | 同上 |
| `ijipu.draftNative` | — | 草稿对应的**本地文件路径**（adj985：双击打开后重启恢复用） | 独立应用专用 | 同上 |
| `ijipu.practiceMarks.<docKey>` | `[]` | **试听「标记段」（adj987）**：按**文档身份**存的练习段（`ws:<wsId>/<segs>` / `native:<path>` / `name:<fileName>`）。**L1（本机）**，**不写进 `.jps`**，换机器不带过去（有意为之） | 用户个性（与具体谱相关但不随谱走） | 保留（嵌入版用同一键） |
| `ijipu.practiceLoop` | false | 标记段「循环」开关（L1 记住） | 用户个性 | 保留 |
| `ijipu.practiceCollapsed` | false | 标记段组「收起」状态（L1 记住） | 用户个性 | 保留 |
| `ijipu.previewSoften` | `light` | **预览柔化档位**（adj1000/adj1001）：`off` / `light` / `mid`。深色下走"反相 + contrast/brightness 微调"，浅色下只换**纸张色**（白 / `#FDFBF5` / `#F7EFDD`） | 用户个性 | 保留 |
| `ijipu.exportBg` | `none` | **导出底色**（adj1002）：`none`（透明，**默认**）/ `white` / `paper`（跟随 `previewSoften` 的纸色）。⚠ JPG/PDF 无透明通道 ⇒ 透明档落白 | 用户个性 | 保留 |
| `ijipu.exportBgImage` | false | **导出是否带背景图/水印**（adj1002，默认**不带**；与底色独立，导出时临时置 `bgEnabled:false`，**不改用户设置**） | 用户个性 | 保留 |
| `ijipu.playbackHqEnabledByLib` | `{}` | **每库一套收藏音色**（adj1012）：按音色库 id 存收藏集合 | 用户个性 | → 插件设置（保留） |
| `ijipu.dynamicCardStyle` | `brand` | **动态谱片头/片尾卡片模板**（adj1073）：`brand`/`paper`/`ink`/`minimal` 或用户模板库里的 `tpl-…` id；L1，不写进 `.jps` | 用户个性（视频样式） | 桌面端保留；网站/插件不显示动态谱视频 |
| `ijipu.cardTemplates` | `[]` | **用户卡片模板库**（adj1176）：`{version,items}`，每项是一份完整 `CardStyle`（含名字、背景图 `ijipu-blob:` 引用）。公共一份，相机位下拉直接列出；旧版单槽 `ijipu.dynamicCardStyleCustom` 在首次读取时迁入一项（id `custom`，名字「我的卡片」）。**每首谱用哪套**记在 sidecar 的 `card.template`，不复制样式本体 | 用户个性（视频样式） | 桌面端保留；网站/插件不显示动态谱视频 |
| `ijipu.panMode` | `beat` | **动态视频/试听的行中平移方式**（adj1089；**adj1094 起默认 `beat`**）：`follow`（色块到右 4/5 才推、一次推到左 1/5）/ `beat`（按拍居中，默认）/ `bar`（按小节居中 + 行内 4/5 安全推）。三种都受"行首、行末左右露白 ≤ 画面 10%"约束（引擎 `CAMERA_WHITE_MARGIN` / `clampRowCenter`）；L1，不写进 `.jps` | 用户个性（怎么看谱/成片） | 桌面端保留；网站/插件不显示动态谱视频（试听跟随滚动仍读这个键） |
| `ijipu.rowLeadBeats` | `0.5` | **行末提前平移量**（adj1094，单位：拍，0~2）：三种平移模式共用——换到下一行（横向 + 纵向）提前这么多拍**完成**，好提前看到下一行；`0` = 正好在行首那一下换行；L1，不写进 `.jps` | 用户个性（怎么看谱/成片） | 桌面端保留；试听同样读它 |

### 4.2 IndexedDB / Tauri / PWA

| 存储 | 内容 | 类别 | 嵌入后的归属 |
|---|---|---|---|
| IDB `ijipu` / store `fileHandle` | 上次打开的 `FileSystemFileHandle`（免重选文件） | 独立应用专用 | **禁用**（Obsidian 已绑定文件） |
| IDB `ijipu` / store `fileHandle` 键 `workspace` | **adj540 工作区**：目录根句柄 + 上次所在子目录的相对路径（移动端"选一个文件夹当工作区"）。**L1**：与"这个人怎么用"有关、与具体谱无关；换台设备可以不一样 ⇒ 不写进 `.jps`，也不写 `# jps-config` | 独立应用专用 | **禁用**（Obsidian 里文件由笔记决定，无需工作区） |
| IDB `ijipu-soundfonts-hq` | HQ 音源缓存（约 30~90MB） | 用户缓存 | 保留（建议共享缓存省流量，见 D4） |
| IDB `ijipu-soundfonts` | 旧采样缓存 | 用户缓存 | 保留/清理 |
| Tauri `sf_cache_read/write/remove` | 桌面版音源缓存落地（应用数据目录） | 平台实现 | 收敛为宿主能力（Obsidian 用 IDB/插件目录） |
| Tauri 资源安装包目录 `%LOCALAPPDATA%\iJipu\soundfonts` | **adj1025**：用户把下载的 SF2 放这里，应用扫描/导入；后续“资源安装包”也落这里 | L1/桌面 | 桌面端保留；插件用自己的库目录 |
| `public/sw.js` + `manifest.webmanifest` + `uiStore.updateReady` | PWA 安装与更新提示 | 独立运行专用 | **嵌入时禁用**（否则抢 Obsidian 的 SW 生命周期） |

### 4.3 其他"隐式用户级"

| 项 | 位置 | 说明 |
|---|---|---|
| 等宽字体白名单 | `uiStore`（`MONO` 集合） | 编辑器字体只允许等宽、且排除连字字体（防止高亮层错位） |
| `isNarrow` / `detectNarrow` | `uiStore`（`window.matchMedia`/`innerWidth`） | **必须改为"容器感知"**：Obsidian 侧边面板窄、窗口宽，用 window 判断会误判（嵌入关键改动）。<br>⚠ `adj974`（用户口径）：**"输入条默认开不开"不再用这条窄屏判据**（PC 一律默认关、只手机/触屏默认开）—— 这里只服务"布局走窄屏形态"（分屏方向等） |
| `systemLight` | `uiStore`（`prefers-color-scheme`） | 由宿主提供主题更准 |

---

## 五、L3 会话级（内存，重开即丢）

`modal`（当前对话框）、`playbackStartId`、`playbackTick`、`activeNoteId(s)`、`playheadTrack`、`voiceBlocks`、`noteIndexToPage`、`notice`、`dirty`/`fileName`/`fileStateTouched`、撤销重做历史（50 步）、`isNarrow`、`systemLight`、`updateReady`、`dynamicCamera`（相机位开关/比例/范围/时长；L3，重开即丢）。

**注意（嵌入关键）**：`docStore`/`uiStore` 目前是**模块级单例**（`create()` 各一次）。L3 状态天然"每实例独立"，但单例会让"同时打开两个 .jps 视图"互相污染。

---

## 六、迁移与兼容策略

1. **编辑器偏好移出谱面**（修问题①）
   - 类型拆分：`PageConfig`（谱面级，进源码）与 `EditorPrefs`（用户级，不进源码）分离；
   - `extractJpsConfig` 白名单去掉 `editorFont/editorFontSize`（**保留读入但不写回**，用于一次性迁移）→ 下次任何保存自动清除旧键；
   - `writeJpsConfig` 只接受谱面级类型（编译期保证不会再写回）。
2. **写入策略（问题②）**：见 D1。
3. **draft / 文件句柄 / SW / 迁移模块**：嵌入模式统一开关（`host.mode === 'embedded'` 时不注册、不读写）。
4. **缓存命名空间**：L1 缓存键建议加库标识（如 `ijipu.<vaultId>.editorFontSize`）或统一走插件 `saveData`，避免多库串味（音源缓存例外，见 D4）。
5. **旧键不动**：独立应用继续用现有键；插件用新命名空间，互不干扰；`localStorageMigration` 仅在独立模式执行。

---

## 七、对嵌入方案的影响（宿主必须提供/必须禁用/必须改写）

**宿主必须提供（`IJipuHost`）**
`readDocument/writeDocument/onExternalChange`、`notify`、`pickFile`（可选）、`saveExport`、`samplerCache`（可选）、`theme{mode,variables}`、`editorPrefs`（读写 L1 编辑偏好）、`isActive()`、**容器尺寸/窄屏判定**（替代 `window.innerWidth`）。

**嵌入时必须禁用**
draft 草稿、文件句柄库、PWA/SW 与更新提示、Tauri 音源分支、`localStorageMigration`、打开/另存为入口（文件视图下）、`window` 级快捷键捕获（改为容器作用域）。

**必须改写为"容器感知"**
`isNarrow`/`detectNarrow`、拖拽与滚动的坐标基准、`document.body` 上的临时元素（测量用 textarea/mirror 需挂到容器或改用 `ResizeObserver`）。

---

## 八、待拍板的决策

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| **D1** | `# jps-config` 写入策略 | **A** 只写"与 `defaultPageConfig` 不同"的字段 + 提供「固化全部设置到谱面」动作；**B** 保持全量（仅剔除编辑器偏好） | **A**：文件干净、不会被旧默认钉死；分享保真靠"固化"动作显式触发 |
| **D2** | 字体/字号是否允许用户级覆盖谱面 | 不允许（现状，谱面为准）/ 允许（用户层可覆盖字体字号） | 允许，但**默认关**（开关名如「用我的字体覆盖谱面字体」）——跨机字体缺失是高频痛点 |
| **D3** | Obsidian 笔记 frontmatter（`ijipu_*`）是否保留 | 保留为 L1.5 / 废弃（只留 `# jps-config`） | 保留为**可选**层（多谱块统一覆盖很有用），但文档明确"优先级低于源内" |
| **D4** | 音源缓存是否按库隔离 | 共享（跨库复用，省流量）/ 按库隔离 | **共享**，设置页提供"缓存大小/清除" |
| **D5** | 嵌入后的主题与布局类偏好 | 跟随 Obsidian（主题）＋ 隐藏 split/viewType/previewZoom / 全部保留 | **跟随 Obsidian + 隐藏布局类**（宿主决定布局），保留编辑器字号/字体/折行/输入条 |

---

## 八、决策定稿（2026-09-12，按建议执行）

| # | 决策 | **定稿** |
|---|---|---|
| **D1** | `# jps-config` 写入策略 | **差量写入（默认）**：`writeJpsConfig(code, cfg)` 只写与 `defaultPageConfig` 不同的字段，无差量则**删除该行**。<br>**adj480 更新**：应用侧取消 L1 页面设置层后，**"保存"即自包含**（凡非默认的生效值都来自谱面），故对话框的「固化到谱面」**已删除**；只有"连默认值一起冻结"这个存档需求才需要用 `{ mode: 'full' }`（当前无界面入口）。<br>**adj454 补充**：默认入口的 `cfg` 必须是 `mergeConfigEdits(code, base, next)` 的结果（只含"本次用户改动"），**不得**直接传合并后的生效配置——否则本机缓存设置会被固化进谱面 |
| **D2** | 字体是否允许用户层覆盖谱面 | **允许，默认关**：L1 新增 `FontOverride{ enabled, font }`（键 `ijipu.fontOverride`），开启后标题/副标题/描述头/说明/歌词/数字六项**字体族**统一为所选栈（不动字号与其它排版参数），谱面文件不改写；界面在页面设置「全局」标签 |
| **D3** | Obsidian frontmatter 是否保留 | **保留为可选 L1.5**：优先级低于源内 `# jps-config`，文档写明；已降级键（`ijipu_editorFont*`）给专门提示而非"未识别" |
| **D4** | 音源缓存按库隔离？ | **共享**（跨库复用省流量）；插件设置页提供缓存状态与清除入口（后续随嵌入方案落地） |
| **D5** | 嵌入后主题与布局类偏好 | **跟随 Obsidian 主题 + 隐藏布局类偏好**（splitPct/splitHDir/viewType/previewZoom 由宿主/窗格决定）；保留编辑器字号/字体/折行/输入条（L1） |

## 八之二、字体策略（三原则，已落地）

| 原则 | 做法 |
|---|---|
| ① 跨机尽量有 | 候选只选 Windows/macOS/iOS/Android/Linux 至少一到两个平台内置的字体：微软雅黑 / PingFang SC / Hiragino Sans GB / Noto Sans CJK SC / 思源黑体 / 文泉驿；宋体侧用 Songti SC / SimSun / Noto Serif CJK SC |
| ② 适合简谱 | 音符数字默认无衬线（醒目）；黑体、宋体、楷体作为风格选项；另提供西文衬线（Georgia）与等宽（数字等距） |
| ③ 保证有可用字体 | 每个候选都是**完整 font-family 栈**且**末尾必须落到通用族**（`sans-serif`/`serif`/`monospace`）；旧文件里的裸字体名（`SimHei`、`KaiTi`…）在读取时经 `normalizeFontStack()` **自动补 fallback**，无需用户改谱 |

集中定义在 `engine/fonts.ts`（`SYS_FONT`、`SCORE_FONT_OPTIONS`、`EDITOR_FONT_OPTIONS`、`normalizeFontStack`），应用与插件共用同一份，不再各写一套（此前应用 10 项裸名、插件 5 项，两处还不一致）。

## 八之三、本次已实施清单

| 项 | 位置 |
|---|---|
| `PageConfig` 移除 `editorFont/editorFontSize`；L1 偏好集中到 `EditorPrefs`/`defaultEditorPrefs` | `engine/types.ts`、`engine/fonts.ts` |
| 差量写入 + 空差量删除行 + 全量模式 + 白名单过滤 + 字体 fallback 归一 | `engine/settings.ts`（`writeJpsConfig` / `extractJpsConfig` / `extractLegacyEditorPrefs`） |
| L1 读写唯一入口（编辑器字体/字号、字体覆盖）+ 旧谱面值一次性迁移 | `src/store/editorPrefs.ts`（新） |
| 顶栏 A−/A+/字体下拉不再写谱面；读取只认 L1 | `src/ui/TopBar.tsx`、`src/editor/EditorPane.tsx` |
| 生效配置解析收敛为 `resolveConfig()`（含 L1 字体覆盖）；新增 `persistFullConfig()` | `src/store/docStore.ts` |
| 页面设置：字体候选取自引擎、编辑器项标注为 L1、字体覆盖开关（adj480：删除「固化全部到谱面」按钮——保存即自包含） | `src/dialogs/PageConfigDialog.tsx` |
| 40 项断言（差量/删除行/全量/编辑器键不进谱面/迁移/字体归一/候选兜底/覆盖开关/字号钳制） | `scripts/smoke.mts` 的 `[90]` |

### 八之四、adj454 已实施清单（分层口径加固）

| 项 | 位置 |
|---|---|
| 写回只固化「用户本次改动」：`mergeConfigEdits(code, base, next)`；`setPageConfig(cfg, persist, base?)` | `engine/settings.ts`、`src/store/docStore.ts` |
| 生效配置解析统一：撤销/重做也走 `resolveConfig()`（补上 L1 字体覆盖层） | `src/store/docStore.ts`（`restoreEntry`） |
| 设置行类型校验：坏 JSON / 值类型错 / 键拼错 / 缩进 → 带行号告警；坏项忽略并回退下一层 | `engine/settings.ts`（`inspectJpsConfig` / `readConfigLine` / `expectDescOf`） |
| 告警接入既有问题通道（问题条 + 状态栏橙点 + 行号定位） | `engine/parser/parser.ts`（`#` 注释行分支） |
| 编辑交互传入"编辑前快照"作为写回基线（对话框打开时 / 虚线按下时） | `src/dialogs/PageConfigDialog.tsx`、`src/preview/PreviewPane.tsx` |
| 27 项断言（优先级三层 / 写回不含缓存值 / 改回默认即删除 / 坏 JSON 与坏值的告警与回退 / 缩进告警） | `scripts/smoke.mts` 的 `[107]` |

## 九、变更清单（按文档执行时要动的文件）

| 文件 | 动作 |
|---|---|
| `src/engine/types.ts`（实际在 `packages/ijipu-engine/src/engine/types.ts`） | 拆 `PageConfig` / `EditorPrefs`；`heights` 标注 legacy |
| `engine/settings.ts` | `extractJpsConfig` 白名单去 `editor*`；`writeJpsConfig` 收窄入参类型 + D1 的差量写入 |
| `src/store/uiStore.ts` | 编辑器偏好/布局偏好分离；`isNarrow` 改容器感知；嵌入模式禁用 SW 相关 |
| `src/store/docStore.ts` | draft/文件句柄/打开另存按 `mode` 分流；L1 默认层来自 host |
| `src/store/localStorageMigration.ts`、`fileHandleDb.ts`、`pwa/swUpdate.ts`、`main.tsx` | 嵌入模式跳过 |
| `src/playback/samplerCache.ts`、`spessaSynthBackend.ts` | Tauri 分支收敛到宿主接口 |
| `obsidian-ijipu/src/*` | 实现 `IJipuHost`（vault I/O、Notice、主题、编辑偏好按库缓存）；`defs.ts` 中编辑器无关字段保留、编辑器项移入"编辑偏好" |

---

## 十、一句话结论

**该随 .jps 走的是"排版与谱面外观"（L2，28 项左右，剔除 `editorFont/editorFontSize`）；用户个性（L1，主题/编辑体验/音色/缩放）留在缓存并交由宿主持久化；会话状态（L3）保持内存但必须每实例独立。** 顺手修掉两个现存问题：编辑器偏好被写进谱面、全量写入把旧默认钉死。
