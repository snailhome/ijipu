/**
 * vite.scores.config.ts — 把 `scripts/gen-scores.mts` 打成 **Node 可跑的 CJS**
 *
 * 为什么要单独打一次：生成器要 import `@ijipu/engine`、`src/brand/*`、`src/help/markdown.ts`
 * （都是 TS + `@ijipu/engine` 别名），Node 不能直接跑 `.mts`。
 * 做法与 `vite.smoke.config.ts` 一致：`vite build --config vite.scores.config.ts`
 * → `node dist-scores/gen-scores.cjs`。
 *
 * 产物 `dist-scores/` 已在 `.gitignore` 里（构建垃圾，不进仓库）。
 */
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ijipu\/engine$/, replacement: fileURLToPath(new URL('./packages/ijipu-engine/src/engine/index.ts', import.meta.url)) },
      { find: /^@ijipu\/engine\//, replacement: fileURLToPath(new URL('./packages/ijipu-engine/src/engine/', import.meta.url)) },
    ],
  },
  build: {
    outDir: 'dist-scores',
    target: 'node22',
    minify: false,
    sourcemap: false,
    lib: {
      entry: 'scripts/gen-scores.mts',
      formats: ['cjs'],
      fileName: () => 'gen-scores.cjs',
    },
    rollupOptions: {
      external: ['node:fs', 'node:path', 'node:url', 'fs', 'path', 'url'],
      /**
       * 与 `vite.smoke.config.ts` 同因：rolldown 在多模块图里会把引擎入口的
       * 死再导出判成"不在任何 chunk"并 panic。这里单入口风险小，但生成器把整个
       * 引擎都拉进来了，先关掉 tree-shaking 更稳（只影响构建垃圾的大小）。
       */
      treeshake: false,
    },
  },
})
