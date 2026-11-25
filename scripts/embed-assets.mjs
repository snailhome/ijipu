/**
 * scripts/embed-assets.mjs — **嵌入版**（进 Obsidian 插件）的资产清单与精简拷贝
 *
 * ## 为什么需要它
 *
 * 嵌入版要打进 Obsidian 插件的 `main.js`（**发布物只有 main.js/manifest.json/styles.css 三个文件**），
 * 所以体积必须精打细算。而现在的 `public/icons/` 里有相当一部分是**网页版/PWA 专用**、嵌入版用不到的：
 *
 * | 文件 | 体积 | 为什么不用 |
 * |---|---|---|
 * | `Jianpu.ico` | 33 KB | 浏览器标签页 favicon；iframe 里不显示标签页图标 |
 * | `pwa-512.png` | 27 KB | PWA 安装图标 |
 * | `pwa-192.png` | 10 KB | PWA 安装图标 / apple-touch-icon |
 *
 * 另有 8 个 `.svg`（波音/滑音/延长记号/大括号，共 ~8.7 KB）：**引擎的曲谱图形是 SVG 现画**，
 * 源码里没有任何地方按路径加载它们（已在 `src/` 与 `packages/ijipu-engine/src/` 全文搜索确认），
 * 属于历史遗留，嵌入版不带。
 *
 * ## 做法
 *
 * 不直接删 `public/`（网页版仍需要 favicon/PWA 图标），而是**生成一份精简的 public 目录**：
 * `scripts/` 下产出 `dist-embed/public/**`，供 Vite 的 `publicDir` 指向。
 *
 * 清单是**显式白名单**：只有列在这里的文件才会进嵌入版——
 * 这样以后 `public/` 里新增了资源，默认**不会**被悄悄打进插件（要显式加白）。
 *
 * 用法：`node scripts/embed-assets.mjs`
 */
import { readdir, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'public')
const OUT = path.join(ROOT, 'dist-embed', 'public')

/**
 * 嵌入版**需要**的图标（PNG，形状在 alpha 通道，`ToolIcon` 用 CSS mask 上色）。
 *
 * 与 `src/ui/toolIcons.ts` 的 `ICON_FILES` 一一对应——**改那里的清单就要同步这里**。
 * 本脚本构建时会解析 `toolIcons.ts` 并断言无遗漏（见 `assertToolIconsCovered`），
 * 漏一个会直接让 `build:embed` 失败，避免插件里出现"按钮在、图标空白"。
 * 另加 5 个非工具图标：应用 logo、捐赠码、播放面板谱面图、视图模式整页/页宽。
 */
const USED_ICONS = [
  // ---- src/ui/toolIcons.ts 的 ICON_FILES（工具条/顶栏/底栏 图标）----
  '菜单', '编码', '左右', '上下', '预览', '排版', '重排', '播放', '停止', '暂停', '设置', '谱面设置',
  '导出', '折行', '字体', '爱心', '下', '上', '更多', '输入', '自动主题', '浅色主题', '深色主题',
  '工作区', '底栏展开', '底栏收起', '左', '右', '导入', '告警', '关于', '切换工作区', '查找',
  '右侧边栏', '窄栏', '宽栏', '浮动', '粘贴', '取消', '乐谱包', '恢复默认', '保存', '打开目录',
  // ---- 非工具图标 ----
  'Jianpu.png', // 顶栏 logo（TopBar.tsx）+ index.html 的 favicon
  'good.png', // 「支持作者」捐赠码（brand/copy.ts 的 image 字段）
  '谱面.png', // 播放/谱面面板
  '整页.png', // 视图模式（整页）
  '页宽.png', // 视图模式（页宽）
]

/**
 * 构建期闸门：`USED_ICONS` 必须覆盖 `ICON_FILES` 的每一个图标。
 *
 * 背景（2026-11-25 用户实报）：插件嵌入版里右栏三个按钮只有中间「页签位置」有图标，
 * 左右「宽窄 / 浮动」和顶栏「右侧栏开关」都是空白。根因是这里漏了 adj1293/adj1298
 * 新增的 5 枚图标（`右侧边栏`/`窄栏`/`宽栏`/`浮动`/`重排`）——`server.ts` 查不到资产就回 204，
 * CSS mask 拿不到图 ⇒ 空白。**只靠人工同步清单迟早再漏**，所以在生成资产这一步直接断言。
 */
async function assertToolIconsCovered() {
  const ts = await readFile(path.join(ROOT, 'src', 'ui', 'toolIcons.ts'), 'utf8')
  const body = /export const ICON_FILES = \{([\s\S]*?)\n\} as const/.exec(ts)?.[1]
  if (!body) throw new Error('[embed-assets] 解析 src/ui/toolIcons.ts 的 ICON_FILES 失败')
  const toolIcons = [...body.matchAll(/^\s*[A-Za-z_$][\w$]*:\s*'([^']+)'/gm)].map((m) => m[1])
  if (toolIcons.length < 30) {
    throw new Error(`[embed-assets] 只解析出 ${toolIcons.length} 个工具图标，疑似格式变了，拒绝继续`)
  }
  const missing = toolIcons.filter((n) => !USED_ICONS.includes(n))
  if (missing.length > 0) {
    throw new Error(
      `[embed-assets] USED_ICONS 漏了 ${missing.length} 个工具图标：${missing.join('、')}\n` +
        `  嵌入版里这些图标会 404（server.ts 回 204）⇒ 按钮空白。请把它们补进 USED_ICONS。`,
    )
  }
  return toolIcons.length
}


/** 嵌入版需要的示例谱（`samples/`）——「新建」模板在 `src/samples/`，不走这里 */
const KEEP_SAMPLES = true

/** 明确**不带**的资源（写在这里是为了"为什么"留在代码里；本脚本按白名单拷贝，不在清单里自然就不带） */
export const EXCLUDED = {
  pwa: ['Jianpu.ico', 'pwa-192.png', 'pwa-512.png'],
  legacySvg: ['复上波音.svg', '复下波音.svg', '上波音.svg', '下波音.svg', '上滑音.svg', '下滑音.svg', '延长记号.svg', '大括号.svg'],
}

async function main() {
  const toolIconCount = await assertToolIconsCovered()
  await rm(OUT, { recursive: true, force: true })
  await mkdir(path.join(OUT, 'icons'), { recursive: true })

  const srcIcons = await readdir(path.join(SRC, 'icons'))
  const needFiles = USED_ICONS.map((n) => (n.includes('.') ? n : `${n}.png`))
  const absent = needFiles.filter((f) => !srcIcons.includes(f))
  if (absent.length > 0) {
    throw new Error(`[embed-assets] 白名单里的图标在 public/icons/ 下不存在：${absent.join('、')}`)
  }

  let bytes = 0
  for (const f of needFiles) {
    const buf = await readFile(path.join(SRC, 'icons', f))
    await writeFile(path.join(OUT, 'icons', f), buf)
    bytes += buf.length
  }

  if (KEEP_SAMPLES) {
    const srcSamples = path.join(SRC, 'samples')
    if (existsSync(srcSamples)) {
      await mkdir(path.join(OUT, 'samples'), { recursive: true })
      for (const f of await readdir(srcSamples)) {
        const buf = await readFile(path.join(srcSamples, f))
        await writeFile(path.join(OUT, 'samples', f), buf)
        bytes += buf.length
      }
    }
  }

  // 网页版里有、嵌入版明确不需要的（体积最大的一类）
  const pwaBytes = await Promise.all(
    EXCLUDED.pwa.map(async (f) => {
      try {
        return (await readFile(path.join(SRC, 'icons', f))).length
      } catch {
        return 0
      }
    }),
  )
  const saved = pwaBytes.reduce((a, b) => a + b, 0)

  console.log(`[embed-assets] 已生成精简 public → dist-embed/public`)
  console.log(`[embed-assets] 工具图标 ${toolIconCount} 个，USED_ICONS 全覆盖 ✓`)
  console.log(`[embed-assets] icons: ${needFiles.length} 个 / ${(bytes / 1024).toFixed(1)} KB`)
  console.log(`[embed-assets] 剔除 PWA 专用 ${EXCLUDED.pwa.length} 个（省 ${(saved / 1024).toFixed(1)} KB）：${EXCLUDED.pwa.join('、')}`)
  console.log(`[embed-assets] 剔除遗留 SVG ${EXCLUDED.legacySvg.length} 个（引擎的曲谱图形是现画 SVG，源码未按路径加载）`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
