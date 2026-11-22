# 访问统计（Cloudflare Pages Functions + D1）

统计这些页面的 PV / UV：

| 页面 | path |
|---|---|
| 首页 | `/` |
| 应用 | `/app/` |
| 乐谱库 | `/scores/` |
| 单首乐谱 | `/scores/<slug>/` |
| 操作手册 | `/manual/` |
| 脚本语法说明 | `/syntax/` |
| 插件手册 | `/plugin/` |
| 命令行手册 | `/cli/` |
| 音色库推荐 | `/soundfonts/` |
| 音视频工具 | `/tools/` |
| 爱扒谱（iJipu BP） | `/bp/`（独立站点 `ijipu-bp.pages.dev` 跨站上报） |

首页页脚的 PV 读公开接口 `/api/pv`（只返回总 PV）；页面明细仍走 `/api/stats`。

并按 `web` / `pwa` / `desktop` 区分来源。

## 0. 乐谱库已迁到独立站点（统计仍复用主站这一套）

2026-11-13 起，乐谱库从 `https://ijipu.pages.dev/scores/` 迁到独立站点
`https://ijipu-sl.pages.dev/scores/`（仓库 `ijipu-sl`，Cloudflare Pages 项目 `ijipu-sl`）。
主站只保留 301：`ijipu/public/_redirects` 把 `/scores/`、`/scores/*`、`/s/:short` 跳到新站。

- **不另建一套统计**：新站是纯静态 Pages，没有 `functions/`；它的
  `site/public/analytics.js` 跨域 `POST` 到主站 `https://ijipu.pages.dev/api/visit`，
  继续写进主站 D1 的同一张 `visits` 表，`path` 仍是 `/scores/`、`/scores/<slug>/`。
- **为什么跨域能成**：主站 `/api/visit` 的 CORS 是 `*`（含 `OPTIONS` 预检）；
  Cloudflare Pages 的静态资源默认也带 `Access-Control-Allow-Origin: *`
  （统计页跨域取 `/scores/index.json` 解析标题靠的就是这个默认头，给新站加 `_headers` 时别覆盖掉）。
- **301 本身不计数**：301 响应没有页面、不跑脚本；用户落到新站才记一次，不会双计。
- **已知的历史断点**：2026-11-05 有 10 首谱把短码从 `score-mw…` 改成 `score-xxxx`
  （`score-mw1i3te2` → `score-xnjk` 等），改名前的 PV 留在旧 slug 行，改名后写新 slug；
  “乐谱点击排名”会把同一首显示成两行（旧行没有标题）。这是改短码造成的，**不是**域名迁移造成的。
  按用户 2026-11-14 口径：**不做**旧 slug 的 301，也**不合并**旧 slug 的统计行。
- **什么时候才另建**：只有乐谱站要完全脱离主站时，才在 `ijipu-sl` 里加 Functions + D1；
  现在不要建。

### 0.1 爱扒谱（iJipu BP）也走同一套

爱扒谱是独立站点 `https://ijipu-bp.pages.dev/`（仓库 `ijipu-bp`，Cloudflare Pages 项目 `ijipu-bp`）。
它没有自己的 Functions/D1，而是在 `ijipu-bp/public/analytics.js` 里跨域 `POST` 到主站
`https://ijipu.pages.dev/api/visit`，`path` 固定用 **`/bp/`** 作为统计标识（bp 站点本身是 `/`，
这里只是统计口径，不是真实路由）。

- 主站 `/api/visit` 的 `PATH_RE` 已放行 `/tools/` 与 `/bp/`；
- `/api/stats` 的 `pages` 增加 `tools` 与 `bp`，统计页显示「音视频工具 /tools/」「爱扒谱 /bp/」；
- 音视频工具就在主站 `/tools/`，用同一个 `public/analytics.js`，无需额外脚本；
- bp 的 visitor 存在它自己的域名 localStorage（`bp.visitor`），与主站互不干扰；
- 跨站上报可能被广告拦截/企业网络拦掉，数字比同源略低，属已知偏差。

## 1. 建 D1 数据库

```bash
npx wrangler d1 create ijipu-visits
```

把输出里的 `database_id` 填进 Pages 项目的 D1 绑定：

```text
Settings → Bindings → D1 database
变量名：DB
```

也可以在 `wrangler.toml` 里配置（本仓库没有提交实际 id，避免部署到错误库）：

```toml
[[d1_databases]]
binding = "DB"
database_name = "ijipu-visits"
database_id = "你的 database id"
```

## 2. 建表

推荐先执行 migration：

```bash
npx wrangler d1 execute ijipu-visits --remote --file=migrations/0001_visits.sql
```

`/api/visit` 也带**首次访问自动建表**兜底：D1 绑定正确但表还没建时，会先执行固定的 `CREATE TABLE IF NOT EXISTS` 再写入，不会再直接 500。

## 3. 设置统计令牌

Pages 项目环境变量：

```text
STATS_TOKEN = 一串足够长的随机字符串
```

`/api/stats` 必须带：

```http
Authorization: Bearer <STATS_TOKEN>
```

## 4. 部署

Pages 会自动部署仓库根目录的 `functions/api/*.js`。数据库绑定和 `STATS_TOKEN` 在控制台设置后重新部署一次生效。

乐谱站（`ijipu-sl`）不需要再建 Functions 或 D1：它的 `site/public/analytics.js` 由构建脚本
`site/copy-static.mjs` 复制进 `dist/`，运行时跨域上报到主站。

## 5. 查看

打开：

```text
https://ijipu.pages.dev/stats/
```

输入 `STATS_TOKEN` 即可看：

- 首页 / 应用 / 乐谱库 / 每首乐谱 / 音视频工具 / 爱扒谱的 PV、UV；
- 每日 PV / UV 变化曲线；
- 乐谱点击排名（按 PV 排序，带占比条）。

乐谱库（迁到 `ijipu-sl` 之后）的数据也在这一个页面里，不需要另开统计页。

令牌只存本机 localStorage，不放在 URL 里。

## 6. 数据口径

- 同一天、同一 path、同一 visitor、同一 channel 一行；
- `views` 每次访问 +1 ⇒ **PV = SUM(views)**；
- `UV = COUNT(*)`，同一天同一 visitor 只算一次；
- visitor 是浏览器/应用本地随机 id，不存 IP、UA；**按域名隔离**——主站、乐谱站、爱扒谱各有一个
  visitor id，所以 UV 只在同一个 path 内自洽；音视频工具在主站，和主站共用 visitor；
- localhost / 127.0.0.1 / dev 不上报；
- 301 跳转本身不计：旧地址 `/scores/` 只做跳转、没有页面，落到新站才记一次；
- 跨站上报（新站 → 主站）可能被广告拦截/企业网络拦掉，数字会比同源时略低，属已知偏差；
- 统计接口失败不影响页面和应用。
