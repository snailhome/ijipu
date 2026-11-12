/**
 * 品牌设计令牌（Design Tokens）
 * iJipu — 爱记谱
 *
 * 品牌主色调：深空蓝 #1E2A5E（音乐的深邃与严谨）+ 霓虹青 #00F0FF（代码与科技感）
 * 界面采用 VS Code 风格的深色主题，乐谱预览区保持纸张白色。
 */
export const brand = {
  /** 英文名 */
  name: 'iJipu',
  /** 中文名 */
  nameZh: '爱记谱',
  /** 中文简称（口语化传播） */
  shortName: 'i记谱',
  /** 用户昵称（社群称呼） */
  userTitle: '谱师',
  /** 用户昵称英文 */
  userTitleEn: 'Score Smith',
  /** 作者署名（关于对话框 / 安装包 publisher 展示） */
  author: '蜗牛🐌',
  /** 作者联系邮箱——留空 = 关于对话框不显示「联系」行（公开地址，需接受被爬虫抓取） */
  authorEmail: 'snail.zh@foxmail.com',
  /** 文件后缀（iJipu Script） */
  extension: '.jps',
  /** 后缀全称 */
  extensionFull: 'iJipu Script',
  /** 首页大标题 Slogan */
  taglineMain: '码即成，谱自现',
  /** 底部情怀 Slogan */
  taglineFooter: '用代码的严谨，谱写指尖的浪漫',
  /** 命令行概念（后续 CLI 工具：jps run / jps compile） */
  cli: {
    run: 'jps run',
    compile: 'jps compile',
  },
  /**
   * adj724b（用户要求）：**官方网址**（关于对话框里给可点链接）。
   * 放在 tokens 里而不是硬编码在组件中——品牌相关的对外地址属于品牌信息，
   * 换域名/换仓库时只改这一处。
   */
  siteUrl: 'https://ijipu.pages.dev',
  /** 独立乐谱站（ijipu-sl / 爱管谱管理） */
  scoresUrl: 'https://ijipu-sl.pages.dev',
  /** Obsidian 插件仓库（同一位作者，用户在 Obsidian 里用得上） */
  obsidianRepoUrl: 'https://github.com/snailhome/obsidian-ijipu',
  /**
   * adj876（官网改版）：应用的 GitHub 仓库与桌面端下载地址。
   *
   * 放在品牌层而不是写死在首页 HTML 里——首页、文档页、以后的控制台都在用这些地址，
   * 换仓库/换下载策略时只改这一处（写死在 HTML 里就会各改各的、漏一处）。
   * `releases/latest` 而不是 `releases/tag/vX.Y.Z`：**永远指向最新版**，不用跟着发版改。
   *
   * adj890（用户决定）：仓库**整体开源**，所以这里就指主仓库。
   * 之前那套"源码保持私有 ⇒ 对外指向单独的公开发布仓库"（adj889）已撤销。
   */
  repoUrl: 'https://github.com/snailhome/ijipu',
  desktopDownloadUrl: 'https://github.com/snailhome/ijipu/releases/latest',
  /**
   * adj896（用户反馈「官网首页少挂了个更新记录」）：**全部发布**页面。
   *
   * 与 `desktopDownloadUrl` 的区别：那个是 `releases/latest`（直接拿最新安装包），
   * 这个是 `releases`（看**历次版本 + 每版改了什么**）。
   * 首页顶栏与页脚各挂一个 —— `adj890` 把指向主仓库的链接统一成「GitHub」那一次，
   * 顺手把原来那个「更新记录」入口弄丢了，这里补回来。
   */
  releasesUrl: 'https://github.com/snailhome/ijipu/releases',
  /** Obsidian 社区插件市场页（插件 id 见 obsidian-ijipu/manifest.json 的 `id`） */
  obsidianMarketUrl: 'https://obsidian.md/plugins?id=ijipu',
} as const

/** 品牌色板 */
export const palette = {
  /** 深空蓝 —— 品牌主色，音乐的深邃与严谨 */
  deepSpaceBlue: '#1E2A5E',
  /** 霓虹青 —— 品牌强调色，代码与科技感 */
  neonCyan: '#00F0FF',
  /** 深空蓝的深色扩展（编辑器背景等） */
  deepSpaceBlueDark: '#0F1526',
  /** 深空蓝的面板色 */
  deepSpaceBluePanel: '#161D3A',
  /** 深空蓝的边框色 */
  deepSpaceBlueBorder: '#24315E',
} as const

/** 语义化界面色（深色主题） */
export const ui = {
  /** 应用背景 */
  bgApp: palette.deepSpaceBlueDark,
  /** 面板背景（菜单栏、状态栏、对话框） */
  bgPanel: palette.deepSpaceBluePanel,
  /** 面板悬浮/激活背景 */
  bgPanelHover: '#1E2950',
  /** 边框 */
  border: palette.deepSpaceBlueBorder,
  /** 主文字 */
  textPrimary: '#E8ECF8',
  /** 次级文字 */
  textSecondary: '#93A0C8',
  /** 弱文字/占位 */
  textMuted: '#5A6A99',
  /** 强调色（链接、激活项、光标） */
  accent: palette.neonCyan,
  /** 危险色 */
  danger: '#FF5D6C',
  /** 成功色 */
  success: '#3DDC97',
  /** 警告色 */
  warning: '#FFC857',
} as const

/** 代码编辑器语法高亮色（VS Code 风格） */
export const editorColors = {
  /** 行头命令（Q/C/B/Z/D/P/J/V/H） */
  lineHeader: '#00F0FF',
  /** 音符数字 */
  note: '#FFB86C',
  /** 小节线与反复记号 */
  barline: '#6272A4',
  /** 歌词 */
  lyric: '#7DD6A8',
  /** 注释（# 开头） */
  comment: '#6A7BB8',
  /** 分页符 [fenye] */
  pageBreak: '#FF79C6',
  /** 普通文本 */
  plain: '#E8ECF8',
} as const

/** 乐谱纸张（预览区保持白色） */
export const paper = {
  bg: '#FFFFFF',
  ink: '#1b1b1b',
} as const
