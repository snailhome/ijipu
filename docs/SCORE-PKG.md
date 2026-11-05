# 乐谱包与乐谱库规范（SCORE-PKG v1）

> 目的：把"一首谱 = 一个可交接的 zip / 一个库目录"固定下来，
> 让**作者导出**、**本地乐谱库**、**网站构建**、**管理工具**四边读同一套规则。
>
> 本文是**规范**；实现进度见 `docs/SCORE-SHARING-PLAN.md` 第十三节。
> 规则一旦发布，`version` 只增不改；要改就升 `version` 并写迁移。

---

## 一、包结构（zip 内部）

```
<任意名>.zip
├── meta.json          # 机器读；发布的唯一权威
├── README.md          # 人读；由导出器按 meta 生成
├── score.jps          # 谱面本体
└── assets/            # 可选；水印/背景/封面
    ├── bg.webp
    ├── wm.png
    └── cover.webp
```

硬规则：

1. **文件在 zip 根目录**，不要套一层 `<slug>/`。
2. zip 名自由；应用导出的包可以不带 slug/short，由工具按「主标题，副标题」生成。
3. 不接收 `__MACOSX/`、`.DS_Store`、`Thumbs.db`；工具导入时忽略，校验时不计。
4. 不接收嵌套 zip。
5. 只允许上面列出的文件名与 `assets/**`；多余文件报错（防夹带）。

---

## 二、`meta.json`

> **字段模型与校验的唯一实现**：`packages/ijipu-engine/src/engine/scoreMeta.ts`
> （`ScoreMetaDoc` / `normalizeScoreMeta` / `validateScoreMeta`）。
> 应用只导出**运输字段**（title/subtitle/composer/assets/overlay），**不带 slug/short**；
> 许可、来源、rights、tags 等**发布信息由乐谱库工具维护**，导入时补默认值。
> short 由工具按 `SHA-256(主标题，副标题去空格) → 33 进制 4 位` 生成，slug = `score-<short>`。
>
> **职责边界（用户 2026-11-05 定）**：应用侧只做 `.jps` 解析/排版/渲染/导出这些简谱相关的事；
> **short / slug / 发布身份一律由乐谱库工具生成和维护**。后续不要再在应用里加 short 输入、
> 本地 short 注册表或 slug 生成逻辑；同名谱要区分，请在副标题上做变化。

| 字段 | 包内 | 库内 | 规则 |
|---|---|---|---|
| `format` | ✓ | | 固定 `"ijipu-score-package"` |
| `version` | ✓ | | 固定 `1`（整数） |
| `slug` | | ✓ | 工具生成 `score-<short>`；发布后不改 |
| `short` | | ✓ | 工具生成 4 位 `[a-z0-9]`，全局唯一，发布后不改 |
| `title` | ✓ | ✓ | 主标题：第一个 `B` 去空格 |
| `subtitle` | ✓ | ✓ | 副标题：其余 `B` 去空格后用「，」连接 |
| `composer` | ✓ | ✓ | 非空；全部 `Z` 去首尾空格后用「，」连接；公版写「传统」/作者 |
| `license` | | ✓ | 工具默认 `CC`；`PD` / `ORIGINAL` / `AUTHORIZED` / `CC` |
| `rights` | | ✓ | 权利分层；工具默认见 §2.3 |
| `source` | | ✓ | 工具默认 `无`；审计用，页脚会显示 |
| `tags` | | ✓ | 工具默认 `[]`；`示例谱` 是**保留 tag**（见 §五） |
| `difficulty` | | | 1-5 整数 |
| `order` | | | 数字，越小越靠前；首页示例也用它排序 |
| `excerpt` | | | 片段说明（如「第 1-4 小节」） |
| `note` | | | 编配说明（Markdown） |
| `videoUrl` | | | 旧单条视频链接（兼容；新数据用 `videos`） |
| `videos` | | | `[{ "platform": "douyin", "url": "https://…" }]`；platform: douyin / xiaohongshu / wechat / other |
| `card` | | | `paper` / `ink` / `brand` / `minimal` |
| `watermark` | | | `corner` / `tile` / `none` |
| `cover` | | | `assets/cover.webp`；省略 = 自动封面 |
| `assets` | ✓ | ✓ | `[{ "path": "assets/bg.webp", "role": "background" }]`；role: `background` / `watermark` / `cover` |
| `overlay` | ✓ | ✓ | 背景/水印的缩放、位置、透明度等渲染设置；见 §2.2 |
| `status` | | | `published`（默认）/ `retired` |
| `retiredReason` / `retiredAt` | | | `retired` 时必填 |
| `publishedAt` / `updatedAt` | | ✓ | 导入时由工具写 `YYYY-MM-DD` |
| `exportedAt` / `exportedBy` | ✓ | | 应用导出时间 / 版本，工具保留 |

可选扩展字段（工具可写、构建忽略）：`contentHash`（SHA-256）、`importedAt`、`sourceZip`。

### 2.1 `rights`：旋律 / 编配 / 记谱三层

`license` 是**旋律（原作）**的主状态；`rights` 补充编配、记谱和证据，避免
「公版旋律 + 我的编配」被写成整首公版。

```json
"license": "CC",
"rights": {
  "work": "CC",
  "arrangement": "ORIGINAL",
  "notation": "CC-BY-NC-SA-4.0",
  "pdReason": "author-death",
  "rightsHolder": "爱记谱示例",
  "evidence": "作者卒于 1827 年",
  "territory": "CN",
  "commercial": false,
  "ccLicense": "CC-BY-NC-SA-4.0",
  "attribution": "作者名",
  "sourceUrl": "https://example.com",
  "expires": "2030-12-31"
}
```

| 字段 | 说明 |
|---|---|
| `work` | 旋律状态；若填必须与顶层 `license` 一致 |
| `arrangement` | 编配：`NONE` / `PD` / `ORIGINAL` / `AUTHORIZED` / `CC` |
| `notation` | 记谱/排版许可；站点默认 CC BY-NC-SA 4.0 |
| `pdReason` | `author-death` / `public-domain-dedication` / `government` / `cc0` / `other` |
| `rightsHolder` / `evidence` / `territory` | 授权方、依据、地域 |
| `commercial` | 是否允许商用 |
| `ccLicense` / `attribution` / `sourceUrl` | CC 协议、署名、来源 |
| `expires` | 授权期限（可选） |

规则：

- `license: "CC"` 时**必须**有 `rights.ccLicense`，且 `attribution` / `sourceUrl` 至少一个；
- `EXCERPT` **不是许可**；片段范围用 `excerpt` 字段，底层仍写 `PD / ORIGINAL / AUTHORIZED / CC`；
- 顶层 `license` 与 `rights.work` 不一致 ⇒ 构建失败。

### 2.2 `overlay`：背景/水印的渲染设置

`assets` 只回答“用哪张图”；`overlay` 回答“怎么画”。应用导出乐谱包时把当前
`pageConfig` 里的水印/背景设置原样复制进来，乐谱库工具预览和站点构建都按它画。

```json
"overlay": {
  "bg": {
    "enabled": true,
    "scale": 50,
    "rotate": 10,
    "opacity": 80,
    "offsetX": 100,
    "offsetY": 50
  },
  "wm": {
    "enabled": true,
    "type": "image",
    "text": "爱记谱・iJipu",
    "size": 22,
    "scale": 20,
    "rotate": -30,
    "opacity": 40,
    "repeat": false,
    "repeatGap": 300,
    "offsetX": -20,
    "offsetY": 30
  }
}
```

- `bg`/`wm` 都是可选；不写 = 按旧的“有 asset 就开、其余默认”。
- `wm.type: "text"` 时不需要 `watermark` 资源，`text` 必须非空；
- `wm.type: "image"` 时必须有 `watermark` 资源；
- `bg.enabled` 为 true 时必须有 `background` 资源；
- `scale` 是页宽百分比（100 = 整页宽）；`offsetX/Y` 是页面单位（pt）；
- 站点/工具预览都把这份值传给引擎 `RenderAssets` 同一条渲染链，**不能只复制图片文件**。
未知字段由校验器报错（防手滑）；需要扩展时先升 `version`。

---

### 2.3 工具导入时的默认值

应用不维护发布信息；乐谱库工具导入**缺字段**的包时补：

```
license: CC
source: 无
tags: []
rights.work: CC
rights.arrangement: CC
rights.notation: CC-BY-NC-SA-4.0
rights.ccLicense: CC-BY-NC-SA-4.0
rights.attribution: 无
publishedAt / updatedAt: 导入当天
```

只补缺失字段；旧包已有 `ORIGINAL` / `原创` 等值保留，不强行覆盖。

## 三、`score.jps` 与资源

1. **`.jps` 保持纯谱面**：不要往 `# jps-config` 里写 `bgImage` / `wmImage`。
   实测引擎会把它们当"不可识别的设置项"告警（`# jps-config` 的校验白名单不等于运行时 overlay 字段）。
   资源改在 `meta.json` 的 `assets[]` 里声明角色：
   - `background` → 背景图；
   - `watermark` → 图形水印；
   - `cover` → 作者封面（没有就自动封面）。
2. 导出器**不改写** `.jps`；只把图片复制进 `assets/`，并在 `meta.json` 写 `assets[]`。
   旧包如果 `.jps` 里已有 `bgImage`/`wmImage`，导入器可迁移到 `meta.assets` 并删掉旧键（可选；
   至少新包不要新增）。
3. 允许的图片：`png` / `jpg` / `jpeg` / `webp` / `gif` / `bmp`；**拒绝 `svg`**（引擎既有安全口径）。
4. 单图 ≤16MB（引擎上限）；站点建议 ≤2MB。zip 解压总量 ≤40MB，条目数 ≤50。
5. 图找不到、扩展名不对、宽高读不出 ⇒ **导出/导入都失败并列出文件名**，不静默少图。
6. `.jps` 解析必须 **0 错误、0 告警**（站点不发布带告警的谱）。

---

## 四、`README.md`

人读，不进渲染。导出器按 `meta.json` 生成，至少含：

```
主标题 / 副标题 / 作曲作词
怎么打开：用「爱记谱 iJipu」打开 score.jps
资源清单：assets/bg.webp（背景）、assets/wm.png（水印）
```

short / slug 由工具导入时生成，README 不写死页面地址。

`README.md` 缺失时导入器可自动补；`meta.json` 缺失直接失败。

---

## 五、乐谱库目录（本地，git 管理）

```
scores-library/
├── <slug>/
│   ├── score.jps
│   ├── meta.json
│   ├── assets/
│   └── README.md
├── _inbox/          # 拖进来的 zip；工具导入后移走/归档
├── _packages/       # 导出的 zip（分享/备份；工具生成）
├── _trash/          # 下架/删除归档（保留可恢复）
└── library.json     # 工具生成的索引；不手改
```

允许在 `scores-library/` 下再建子目录做**存放分组**（例如 `collections/民歌/<slug>/`）。
工具递归扫描；**`meta.slug` 全局唯一**，目录名仍应等于 slug。

### 5.1 子目录与 tag：只让 tag 做分类

| 维度 | 子目录 | tag |
|---|---|---|
| 用途 | 本地存放/归档 | 站点分类、筛选、首页示例 |
| 一谱多类 | 做不到 | 天然支持 |
| 改名/移动 | 可能影响路径 | 不影响 slug/URL |
| 站点读不读 | **不读**（只用来找文件） | 读 |

**结论：tag 做分类，子目录只做存放。** 不把「民歌/儿歌」这类语义分类只写进目录名；
需要分类就写 `tags`。否则同一首既属于民歌又属于儿歌时，目录只能二选一，站点也无法按多标签筛。

### 5.2 保留 tag：`示例谱`

- 只有 `tags` 里含 `示例谱` 的条目，才进**首页示例**；
- 排序用 `order`（没有就按 `updatedAt` 倒序）；
- 该 tag 是保留字，工具里最好用勾选框写它，避免手打错字（`示例`、`example` 都不算）；
- 首页需要至少 1 条 `示例谱`；没有就回退到内置小星星，不让首页空掉。

> 备选：用 `homeSample: true` 布尔值更不容易写错。当前按用户口径先用 tag；
> 若以后觉得 tag 太隐晦，升 `version` 改成布尔值。

---

## 六、网站构建怎么读

1. `gen-scores` 读 `scores-library/`（递归），不再只读 `public/scores/`；
   现有 8 份可先留在 `public/scores/`，两边合并，迁移完再只读库。
2. 每个条目：
   - 读 `meta.json` + `score.jps` + `assets/`；
   - 资源读字节 → data URI；用头解析拿 PNG/JPEG/WebP/GIF/BMP 宽高（P2c 已实现）；
   - 用 `meta.overlay` 覆盖 `bgScale/bgOffset*/wmScale/wmOffset*/wmOpacity…`（应用导出的设置）；
   - `renderScoreToSvg(layout, { assets })`，详情/封面/og 都带作者的水印/背景；
   - **有 assets/overlay 时详情页展示整页**（作者按 A4 页面设置的缩放/位置才不会被裁掉）；
     纯谱仍裁到墨迹，保持紧凑。
   - 生成 `dist/scores/<slug>/index.html`、`cover.svg`、`score.zip`；
   - 复制 `score.jps` / `assets/` 到 `dist/scores/<slug>/`（下载与 `?src=` 用）。
3. `score.zip` = 从库目录重新打的同结构包（含 `meta.json`/`README.md`/`assets/`），
   不再只是 `.jps + README.txt`。
4. 下架：`status: retired` 仍生成 tombstone 页（链接不 404），列表不显示。
5. 首页示例：`samples.ts` 用 `import.meta.glob` 读 `public/scores` + `scores-library` 的 meta/score，
   筛 `tags` 含 `示例谱` 的条目；按钮由 `playground.ts` 动态生成（S4 已实现，不用生成中间 TS 文件）。

---

## 七、管理工具（本地，自己用，不发版）

### 7.1 形态

**本地 Node 服务 + 浏览器 UI**（`http://127.0.0.1:<port>`），不装 Electron/Tauri，不出安装包。

- **工具与工作库放私有仓**（默认 `D:\Coding\JianpuScript\iJipu-Library`，本地 git，不建公开远程）；
- 公开站点仓（`ijipu`）只放**已发布镜像** `scores-library/`，不放工具代码；
- 前端复用 `@ijipu/engine` 渲染预览（与网站/文档页同源），不另写渲染器；
- Node 侧只用内置 `node:http` / `node:fs` / `node:child_process`，不引重依赖；
- zip 读写复用站点的 `src/export/zip.ts` 逻辑（跨仓引用不便时抽共享模块；不要各写一套不一致的实现）。

### 7.2 功能

| 功能 | 行为 |
|---|---|
| 列表 | 扫库，显示 slug、标题、tags、难度、状态、更新时间 |
| 查看 | 显示 meta、README、资源清单、包大小 |
| 预览 | 引擎渲染 SVG（含 `assets` 的 data URI）；可切换整页/裁墨迹 |
| 打开 | 「用 iJipu 打开」调系统默认程序 / 复制路径（不假装内置编辑器） |
| 导入 | 拖入 zip → 校验 → 解到 `library/<slug>/`；同 slug 询问"覆盖/并存" |
| 编辑 | 改 meta 字段；保存写回 `meta.json`（zip 用导出的方式另存） |
| 导出 | 把库目录打成 `<slug>.zip` 到 `_packages/`（分享/备份） |
| 下架 | 设 `status: retired`，移到 `_trash/` 或保留；列表隐藏，站点出下架页 |
| 删除 | 移到 `_trash/`，不直接 `rm`；可恢复 |
| 更新乐谱库 | 校验全部 → 本地构建（可选）→ `git add/commit/push` |

### 7.3 一键更新的顺序（无 AI）

```
点「更新乐谱库」
  → 扫描私有库 library/
  → 逐条校验（§八）
  → 有错：列出文件与原因，停止，不 push
  → 无错：把「已发布」条目复制到公开站点仓的 scores-library/
  → 在站点仓 npm run build（本地先过一遍）
  → 站点仓 git add scores-library && commit && push origin main
  → 提示：已推送，Cloudflare 约 1-2 分钟构建；给出线上地址
```

- 没有改动时不 commit；push 失败时原样显示 git stderr；
- 不自建账号、不存 token；用本机 git 凭据；
- 工具只绑 `127.0.0.1`，加一次性 token 防本机其它页面误调；不做公网访问。
- 私有库自己也可以单独 commit（历史/回滚），但**不 push 到公开远程**。

### 7.4 工具不发布

- 工具在**私有仓**里，天然不公开；不进站点 `vite.config.ts`、不进安装包、不上 Pages；
- 它自己的 `npm start` 启动；没有版本号/Release 负担。
- 公开站点仓只多一个 `scores-library/` 镜像目录（已发布内容，本来就要公开）。

---

## 八、校验清单（工具与站点共用）

1. zip：根目录结构、文件名、大小/条目上限、无嵌套 zip、无系统垃圾文件。
2. `meta.json`：`format/version` 对、必填齐全、枚举合法、未知字段报错、日期格式。
3. `slug` / `short`：格式、唯一（库内 + zip 内）、发布后不改。
4. `score.jps`：解析 0 错误、0 告警。
5. `assets`：存在、扩展名白名单、≤16MB、宽高可读；`meta.assets` 里每个 role 指向的图都在。
6. 重复：同 slug 在多个位置 ⇒ 失败并点名。
7. `status: retired`：必须有原因/时间。

---

## 九、版本与迁移

- 当前 `version: 1`。
- 加字段不升版本（可选字段）；改语义/必填/文件布局才升版本，并写迁移函数。
- 旧包（无 `format/version`）：导入器按 v0 读，补默认值并提示"已升级到 v1"。

---

## 十、分期

| 期 | 内容 |
|---|---|
| **S1** | 本文定稿 + 库目录 + 构建读库 + 校验（不上工具也能加谱） |
| **S2** | `score:pack` / `score:unpack` 命令行（zip ↔ 目录） |
| **S3** | 本地管理工具（列表/预览/导入/编辑/下架/导出/一键更新） |
| **S4** | 首页示例改为 tag 驱动（`示例谱`）+ 现有 8 份迁移 | 首页已实现；迁移待做 |

---

## 十一、已定（2026-11-03）

1. **库的工作格式**：目录（每首一个文件夹）；zip 只做导入/导出/分享。
2. **工具形态**：本地 Node + 浏览器 UI；不用 Tauri/Electron。
3. **仓库**：工具 + 工作库放**私有仓**（`D:\Coding\JianpuScript\iJipu-Library`，本地 git，不建公开远程）；
   公开站点仓只接收已发布镜像 `scores-library/`。
4. **首页示例**：`示例谱` tag；S4 已实现（现有 7 首已打 tag；迁移待做）。
5. **现有 8 份**：S2/S3 完成后再迁入私有库，站点侧迁到 `scores-library/`。
