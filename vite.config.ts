import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * adj876（官网分层）：改成**多页面**构建。
 *
 * 原来只有根 `index.html`（就是应用本身）。现在有六份 HTML，各自对应一个入口：
 *
 * | 产物 | URL | 是什么 | 入口脚本 |
 * |---|---|---|---|
 * | `dist/index.html` | `/` | 介绍首页 | `src/landing/main.ts`（无 React） |
 * | `dist/app/index.html` | `/app/` | **应用**（原来的根 index.html） | `src/main.tsx` |
 * | `dist/manual/index.html` | `/manual/` | 操作手册（网页版） | `src/docs/manual.ts` |
 * | `dist/syntax/index.html` | `/syntax/` | 脚本语法说明（网页版） | `src/docs/syntax.ts` |
 * | `dist/plugin/index.html` | `/plugin/` | **插件手册**（Obsidian 插件，adj905x 用户要求） | `src/docs/plugin.ts` |
 * | `dist/cli/index.html` | `/cli/` | **命令行手册**（adj948 用户要求；正文 = `docs/CLI-手册.md`） | `src/docs/cli.ts` |
 * | `dist/soundfonts/index.html` | `/soundfonts/` | **音色库推荐**（adj1026；正文 = `docs/SOUNDFONTS.md`） | `src/docs/soundfonts.ts` |
 *
 * 注意几点：
 *  · 资源引用一律是绝对路径（Vite 默认 `base: '/'`）⇒ Cloudflare Pages、PWA、
 *    桌面壳（`http://tauri.localhost/`）三处都能正确解析子路径页面里的 `/assets/...`。
 *  · `app/index.html` 同时被 **Obsidian 嵌入版**（`vite.config.embed.mjs`）当入口用，
 *    所以它是"应用外壳"的**唯一来源**——不要再单独复制一份。
 *  · 七份 HTML 的 `<title>` 各不相同，有 smoke 断言守着（改漏会红灯）。
 */
const entry = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * adj1191：`npm run dev` 里也让 `/scores/` 能打开。
 *
 * 曲库页面是**构建期生成**到 `dist/scores/` 的（见 `scripts/gen-scores.mts`），
 * Vite dev 只服务仓库根与 `public/`，所以直接点顶栏「乐谱」会 404。
 * 这里在 dev 启动时跑一次 `scores:gen`，再把 `/scores/*` 的请求转去 `dist/scores/`；
 * `public/scores/` 里的 `.jps` / `meta.json` / `scores.css` / `og.png` 仍由 Vite 自己服务。
 *
 * 为什么用 `spawnSync` 跑 npm 脚本而不是 import 生成器：生成器走的是它自己的 Vite lib 构建
 * （`vite.scores.config.ts`），复用同一条命令才能保证 dev 与 build 产物一致。
 */
function scoresDevPlugin(): Plugin {
  const root = process.cwd()
  const scoresDist = join(root, 'dist/scores')
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.zip': 'application/zip',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
  }
  return {
    name: 'ijipu-scores-dev',
    apply: 'serve',
    configureServer(server) {
      const generate = (): void => {
        const r = spawnSync('npm', ['run', 'scores:gen'], {
          cwd: root,
          shell: true,
          encoding: 'utf8',
        })
        if (r.status !== 0) {
          server.config.logger.warn(`[scores] 生成失败（/scores/ 可能打不开）：${r.stderr || r.stdout || ''}`)
        }
      }
      generate()
      // 改 `public/scores/**` 后自动重生成（防抖 300ms）；只监听这个目录，不碰应用源码
      const scoresSrc = join(root, 'public/scores')
      server.watcher.add(scoresSrc)
      let timer: ReturnType<typeof setTimeout> | null = null
      server.watcher.on('all', (_event, file) => {
        const rel = relative(scoresSrc, file)
        if (rel.startsWith('..') || rel === '') return
        if (timer) clearTimeout(timer)
        timer = setTimeout(generate, 300)
      })
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== '/scores' && !url.pathname.startsWith('/scores/')) return next()
        if (url.pathname === '/scores') {
          res.writeHead(301, { location: '/scores/' })
          res.end()
          return
        }
        let p = decodeURIComponent(url.pathname)
        if (p.endsWith('/')) p += 'index.html'
        else if (!extname(p) && existsSync(join(root, 'dist', p, 'index.html'))) p += '/index.html'
        p = p.replace(/^\/+/, '')
        const abs = join(root, 'dist', p)
        if (!abs.startsWith(scoresDist) || !existsSync(abs)) return next()
        res.setHeader('content-type', mime[extname(abs).toLowerCase()] ?? 'application/octet-stream')
        res.setHeader('cache-control', 'no-store')
        res.end(readFileSync(abs))
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), scoresDevPlugin()],
  resolve: {
    alias: [
      { find: /^@ijipu\/engine$/, replacement: fileURLToPath(new URL('./packages/ijipu-engine/src/engine/index.ts', import.meta.url)) },
      { find: /^@ijipu\/engine\//, replacement: fileURLToPath(new URL('./packages/ijipu-engine/src/engine/', import.meta.url)) },
    ],
  },
  build: {
    rollupOptions: {
      input: {
        landing: entry('./index.html'),
        app: entry('./app/index.html'),
        manual: entry('./manual/index.html'),
        syntax: entry('./syntax/index.html'),
        plugin: entry('./plugin/index.html'),
        cli: entry('./cli/index.html'),
        // adj1026：音色库推荐（用户要求不放首页；正文用分块，窄屏更好读）
        soundfonts: entry('./soundfonts/index.html'),
      },
    },
  },
})
