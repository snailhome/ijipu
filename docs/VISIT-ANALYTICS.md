# 访问统计（Cloudflare Pages Functions + D1）

统计四个页面的 PV / UV：

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

首页页脚的 PV 读公开接口 `/api/pv`（只返回总 PV）；页面明细仍走 `/api/stats`。

并按 `web` / `pwa` / `desktop` 区分来源。

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

## 5. 查看

打开：

```text
https://ijipu.pages.dev/stats/
```

输入 `STATS_TOKEN` 即可看：

- 首页 / 应用 / 乐谱库 / 每首乐谱的 PV、UV；
- 每日 PV / UV 变化曲线；
- 乐谱点击排名（按 PV 排序，带占比条）。

令牌只存本机 localStorage，不放在 URL 里。

## 6. 数据口径

- 同一天、同一 path、同一 visitor、同一 channel 一行；
- `views` 每次访问 +1 ⇒ **PV = SUM(views)**；
- `UV = COUNT(*)`，同一天同一 visitor 只算一次；
- visitor 是浏览器/应用本地随机 id，不存 IP、UA；
- localhost / 127.0.0.1 / dev 不上报；
- 统计接口失败不影响页面和应用。
