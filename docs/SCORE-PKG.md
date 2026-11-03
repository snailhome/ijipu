# 乐谱包与乐谱库规范（SCORE-PKG v1）

> 目的：把"一首谱 = 一个可交接的 zip / 一个库目录"固定下来，
> 让**作者导出**、**本地乐谱库**、**网站构建**、**管理工具**四边读同一套规则。
>
> 本文是**规范**；实现进度见 `docs/SCORE-SHARING-PLAN.md` 第十三节。
> 规则一旦发布，`version` 只增不改；要改就升 `version` 并写迁移。

---

## 一、包结构（zip 内部）

```
<slug>.zip
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
2. zip 名 = `meta.slug` + `.zip`（导入时不一致要报错，或由工具改名并记录）。
3. 不接收 `__MACOSX/`、`.DS_Store`、`Thumbs.db`；工具导入时忽略，校验时不计。
4. 不接收嵌套 zip。
5. 只允许上面列出的文件名与 `assets/**`；多余文件报错（防夹带）。

---

## 二、`meta.json` 字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `format` | ✓ | 固定 `"ijipu-score-package"` |
| `version` | ✓ | 固定 `1`（整数） |
| `slug` | ✓ | `[a-z0-9-]+`，发布后不改；= zip 名 |
| `short` | ✓ | `[a-z]{3,6}`，全局唯一，发布后不改 |
| `title` | ✓ | 非空 |
| `composer` | ✓ | 非空；公版写「传统」/作者 |
| `license` | ✓ | `PD` / `ORIGINAL` / `AUTHORIZED`（不做 C/D） |
| `source` | ✓ | 来源/卒年/授权方；审计用，页脚会显示 |
| `tags` | ✓ | 字符串数组；`示例谱` 是**保留 tag**（见 §五） |
| `difficulty` | | 1-5 整数 |
| `order` | | 数字，越小越靠前；首页示例也用它排序 |
| `excerpt` | | 片段说明（如「第 1-4 小节」） |
| `note` | | 编配说明（Markdown） |
| `card` | | `paper` / `ink` / `brand` / `minimal` |
| `watermark` | | `corner` / `tile` / `none` |
| `cover` | | `assets/cover.webp`；省略 = 自动封面 |
| `assets` | | `[{ "path": "assets/bg.webp", "role": "background" }]`；role: `background` / `watermark` / `cover` |
| `status` | | `published`（默认）/ `retired` |
| `retiredReason` / `retiredAt` | | `retired` 时必填 |
| `publishedAt` / `updatedAt` | ✓ | `YYYY-MM-DD` |

可选扩展字段（工具可写、构建忽略）：`contentHash`（SHA-256）、`importedAt`、`sourceZip`。
未知字段由校验器报错（防手滑）；需要扩展时先升 `version`。

---

## 三、`score.jps` 与资源

1. 包里 `score.jps` 的 `# jps-config` 中：
   - `bgImage` → `assets/<文件名>`；
   - `wmImage` → `assets/<文件名>`；
   - `cover` → `assets/cover.webp`（如有）。
   导出器**只改包里这份**，作者原文件不动。
2. 允许的图片：`png` / `jpg` / `jpeg` / `webp` / `gif` / `bmp`；**拒绝 `svg`**（引擎既有安全口径）。
3. 单图 ≤16MB（引擎上限）；站点建议 ≤2MB。zip 解压总量 ≤40MB，条目数 ≤50。
4. 图找不到、扩展名不对、宽高读不出 ⇒ **导出/导入都失败并列出文件名**，不静默少图。
5. `.jps` 解析必须 **0 错误、0 告警**（站点不发布带告警的谱）。

---

## 四、`README.md`

人读，不进渲染。导出器按 `meta.json` 生成，至少含：

```
曲名 / 作曲 / 来源 / 许可
页面：https://ijipu.pages.dev/scores/<slug>/
怎么打开：用「爱记谱 iJipu」打开 score.jps
资源清单：assets/bg.webp（背景）、assets/wm.png（水印）
```

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
   - 资源读字节 → data URI；用头解析拿 PNG/JPEG/WebP 宽高；
   - `renderScoreToSvg(layout, { assets })`，详情/封面/og 都带作者的水印/背景；
   - 生成 `dist/scores/<slug>/index.html`、`cover.svg`、`score.zip`；
   - 复制 `score.jps` / `assets/` 到 `dist/scores/<slug>/`（下载与 `?src=` 用）。
3. `score.zip` = 从库目录重新打的同结构包（含 `meta.json`/`README.md`/`assets/`），
   不再只是 `.jps + README.txt`。
4. 下架：`status: retired` 仍生成 tombstone 页（链接不 404），列表不显示。
5. 首页示例：构建期从 `示例谱` 生成 `src/gen/homeSamples.ts`（标签 + 源码），
   `src/landing/samples.ts` 消费它；`index.html` 的首屏预置块由构建期注入或保留固定占位，
   避免"静态块与第一首不一致"（详见计划文档 P4）。

---

## 七、管理工具（本地，自己用，不发版）

### 7.1 形态

**本地 Node 服务 + 浏览器 UI**（`http://127.0.0.1:<port>`），不装 Electron/Tauri，不出安装包。

- 代码放 `tools/score-library/`，与站点同一个 git 仓库，但**不进 Vite 站点构建**；
- 前端复用 `@ijipu/engine` 渲染预览（与网站/文档页同源），不另写渲染器；
- Node 侧只用内置 `node:http` / `node:fs` / `node:child_process`，不引重依赖；
- zip 读写复用 `src/export/zip.ts` 的 `readZip` / `writeZip`。

### 7.2 功能

| 功能 | 行为 |
|---|---|
| 列表 | 扫库，显示 slug、标题、tags、难度、状态、更新时间 |
| 查看 | 显示 meta、README、资源清单、包大小 |
| 预览 | 引擎渲染 SVG（含 `assets` 的 data URI）；可切换整页/裁墨迹 |
| 打开 | 「用 iJipu 打开」调系统默认程序 / 复制路径（不假装内置编辑器） |
| 导入 | 拖入 zip → 校验 → 解到 `scores-library/<slug>/`；同 slug 询问"覆盖/并存" |
| 编辑 | 改 meta 字段；保存写回 `meta.json`（zip 用导出的方式另存） |
| 导出 | 把库目录打成 `<slug>.zip` 到 `_packages/`（分享/备份） |
| 下架 | 设 `status: retired`，移到 `_trash/` 或保留；列表隐藏，站点出下架页 |
| 删除 | 移到 `_trash/`，不直接 `rm`；可恢复 |
| 更新乐谱库 | 校验全部 → 本地构建（可选）→ `git add/commit/push` |

### 7.3 一键更新的顺序（无 AI）

```
点「更新乐谱库」
  → 扫描 scores-library/
  → 逐条校验（§八）
  → 有错：列出文件与原因，停止，不 push
  → 无错：npm run build（本地先过一遍）
  → git add scores-library
  → git commit -m "chore(library): sync N scores"
  → git push origin main
  → 提示：已推送，Cloudflare 约 1-2 分钟构建；给出线上地址
```

- 没有改动时不 commit；push 失败时原样显示 git stderr；
- 不自建账号、不存 token；用本机 git 凭据；
- 工具只绑 `127.0.0.1`，加一次性 token 防本机其它页面误调；不做公网访问。

### 7.4 工具不发布

- `tools/score-library/` 只进 git，不进 `vite.config.ts` 的入口、不进安装包、不上 Pages；
- 它自己的 `npm run library` 启动；没有版本号/Release 负担。

---

## 八、校验清单（工具与站点共用）

1. zip：根目录结构、文件名、大小/条目上限、无嵌套 zip、无系统垃圾文件。
2. `meta.json`：`format/version` 对、必填齐全、枚举合法、未知字段报错、日期格式。
3. `slug` / `short`：格式、唯一（库内 + zip 内）、发布后不改。
4. `score.jps`：解析 0 错误、0 告警。
5. `assets`：存在、扩展名白名单、≤16MB、宽高可读、`bgImage/wmImage` 指向的图都在。
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
| **S4** | 首页示例改为 tag 驱动（`示例谱`）+ 现有 8 份迁移 |

---

## 十一、待拍板

1. 库的工作格式：**目录**（推荐，编辑/预览简单）／**zip 为唯一源**（工具频繁解包重打）？
2. 工具形态：本地 Web（推荐）／Tauri 桌面窗口？
3. 工具与站点：**同一个 git 仓库**（推荐，一键 push）／单独仓库 + 子模块？
4. 首页示例：`示例谱` tag（用户口径）／`homeSample` 布尔（更防错）？
5. 现有 8 份：保持 `public/scores`（推荐先不动）／迁入 `scores-library`？
