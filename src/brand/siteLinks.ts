/**
 * brand/siteLinks.ts — 官网页面（首页 + 文档页）的外部链接填充（adj876）
 *
 * 背景：官网 HTML 里凡是**外部地址**（GitHub 仓库、桌面端下载、Obsidian 插件…）
 * 都不写死 href，而是标一个 `data-l="<键名>"`，由本函数在运行时从 `brand/tokens.ts` 填进去。
 * 好处是"地址只有一处定义"——换仓库、换下载策略时不会漏改某个页面。
 *
 * 站内路径（`/app/`、`/manual/`、`/syntax/`）**不**走这里，直接写在 HTML 里：
 * 它们是本站结构的一部分，改了就是改站点，本来就要一起改。
 */
import { brand } from './tokens'

/** `data-l` 的键 → 实际地址（值全部来自品牌 token） */
const LINKS: Record<string, string> = {
  siteUrl: brand.siteUrl,
  scoresUrl: brand.scoresUrl,
  repoUrl: brand.repoUrl,
  desktopDownloadUrl: brand.desktopDownloadUrl,
  // adj896：全部发布页（「更新记录」入口；与 desktopDownloadUrl 的 latest 不同）
  releasesUrl: brand.releasesUrl,
  obsidianRepoUrl: brand.obsidianRepoUrl,
  obsidianMarketUrl: brand.obsidianMarketUrl,
}

/**
 * 把所有 `a[data-l]` 的 href 填上。
 * 认不出的键**保持原样**（不写成 `#`）——这样即便某个页面漏了键，
 * 也只是那一处链接指向 HTML 里写的兜底地址，而不是变成一个点不动的空链接。
 */
export function fillExternalLinks(): void {
  document.querySelectorAll<HTMLAnchorElement>('a[data-l]').forEach((a) => {
    const url = LINKS[a.dataset.l ?? '']
    if (url) a.href = url
  })
}
