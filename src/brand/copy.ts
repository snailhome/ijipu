/**
 * 品牌文案库 —— 所有面向用户的品牌文字集中于此，便于统一修改。
 */
import { brand } from './tokens'

/** 关于本软件（“关于我们”）
 *  adj419：原「脚本兼容说明 / 致谢 / 谱师 / 命令行工作流」四段移到**操作手册**
 *  （docs/USER-GUIDE.md §九）——关于对话框只留品牌介绍、署名与协议，避免越长越像文档。 */
export const aboutCopy = {
  title: `${brand.nameZh}（${brand.name}）`,
  tagline: brand.taglineMain,
  /** 品牌介绍正文 */
  body: [
    `${brand.nameZh}（英文名：${brand.name}）—— 优秀高效的代码式简谱制谱引擎。`,
    '我们致力于将编程语言的严谨逻辑，注入中国传统简谱的创作之中。通过一套极简的 .jps 标记语言，让音乐人像写代码一样编排音符，让程序员像调参一样调整音高。码即成，谱自现，让简谱创作从此进入“脚本时代”。',
  ].join('\n'),
  /** 作者署名（adj373） */
  author: `作者：${brand.author}`,
  /** 作者联系方式（邮箱留空时为空串 → 关于对话框不渲染该行） */
  contact: brand.authorEmail ? `联系：${brand.authorEmail}` : '',
  /** 底部情怀 */
  footer: brand.taglineFooter,
  /** 开源协议说明（捐赠入口未配置时显示在关于对话框底部；
   *  adj422：原来的「致敬」短句已移到操作手册 §九，关于对话框不再重复） */
  license: '本项目基于 GNU Affero General Public License v3.0（AGPL-3.0）发布，欢迎学习、修改与再分发。',
  /**
   * adj724b（用户要求）：关于对话框里的**可点链接**。
   *
   * 用户原话：「在 ijipu 的关于里，添加 https://ijipu.pages.dev 和
   * https://github.com/snailhome/obsidian-ijipu 的链接」。
   * 地址本身在 `brand/tokens.ts`（品牌信息一处定义），这里只放**显示名**。
   */
  links: [
    { label: '官方网站', url: brand.siteUrl, hint: '在线版 · 示例 · 语法说明' },
    { label: 'Obsidian 插件', url: brand.obsidianRepoUrl, hint: '在 Obsidian 里渲染与试听 .jps' },
    /**
     * adj945（用户要求"该加的加"）：**源码地址** —— AGPL-3.0 的网络条款那层。
     *
     * 为什么必须有：AGPL 第 13 条要求"通过网络与用户交互"的程序**向这些用户提供对应源码**。
     * 官网/在线版就是这种交互，所以「关于」里必须有一个能直接点到源码的入口（只有 LICENSE 全文不够）。
     * 地址取 `brand.repoUrl`（品牌对外地址一处定义），这里只放显示名 ✓。
     */
    { label: '源码仓库', url: brand.repoUrl, hint: 'AGPL-3.0 源码 · 欢迎学习、修改与再分发' },
  ],
} as const

/** 捐赠/支持作者（Q-10）。donateImage 为微信赞赏码图片路径（public/ 下）；为空则不显示捐赠入口。
 *  按钮文案见 donate.label；「关于」对话框点击后打开模态框展示赞赏码。 */
export const donate = {
  /** 微信赞赏码图片路径（adj417 起图片统一放 public/icons/ 下，如 '/icons/good.png'）——留空 = 不显示捐赠入口 */
  image: '/icons/good.png',
  /** 捐赠按钮文案 */
  label: '支持作者 ❤',
  /** 显示在赞赏码下方的说明 */
  tip: '算力烧得火热，五音不全也要接着奏乐、接着谱——赏点 Token，让我继续摇摆～（自愿捐赠，无任何商业回报）',
} as const

/** 界面内文案 */
export const uiCopy = {
  appName: brand.shortName,
  windowTitle: `${brand.nameZh} ${brand.name} — ${brand.taglineMain}`,
  newFile: '新建乐谱',
  openFile: '打开乐谱',
  saveFile: '保存乐谱',
  exportMenu: '导出',
  exportPdf: '导出 PDF',
  exportJpg: '导出 JPG 图片',
  exportSvg: '导出 SVG 图片',
  exportPng: '导出 PNG 图片',
  // adj422：菜单与对话框统一叫「设置」（原「页面设置」——里面早就不只是页面了：
  // 全局/主题/音色库/谱面/字体五个标签）
  pageConfig: '设置',
  play: '试听播放',
  about: `关于 ${brand.name}`,
  currentFile: '当前乐谱',
  defaultFileName: '未命名',
  unsaved: '未保存',
  viewCode: '编码',
  viewSplit: '拆分',
  viewPreview: '预览',
  statusReady: '就绪',
  /**
   * adj628（用户报"Ctrl+N 新建后状态栏还是上一个文件名，会不会覆盖原文件"）：
   * 新建与"恢复上次文件"两种情况都要**明说**，用户才分得清"这是新谱"还是"还绑在老文件上"。
   *   · `newDocDone`：确认新建真的生效，并点明"未关联文件 ⇒ 保存会走另存为"；
   *   · `restoredFile`：新窗口/新标签（含浏览器自己开的窗口）会恢复上次草稿与文件绑定——
   *     明确告诉用户"保存会写回它"，别把它当成新建出来的空谱。
   */
  newDocDone: '已新建空谱（未与任何文件关联，保存会提示另存为）',
  /**
   * adj963（用户要求"规范新建的行为"）：**有未保存修改时**点「新建」先问一句。
   *
   * 为什么必须问：`newDoc()` 会把当前草稿槽（`ijipu.draft`）**直接换成模板**，
   * 原文件虽然不动，**但当前这些没保存的编辑就此消失**（没有撤销可回到）。
   * 这也正是 E-2026-310 那一族的边界 —— 别让"点错一下"等于丢内容。
   * 文案里点明"原文件不受影响"，避免用户以为文件被删了。
   */
  newDocDirtyAsk: '当前文档有未保存的修改。新建会丢弃这些修改（磁盘上的原文件不受影响），确定要新建吗？',
  newDocDirtyConfirm: '丢弃并新建',
  newDocDirtyCancel: '取消',
  restoredFile: (name: string): string =>
    `已恢复上次打开的「${name}」：这份草稿仍与它关联，保存会写回它（要另起一份请用「新建」）`,
  // ---- 保存反馈（toast）----
  saveOk: '已保存',
  // adj365：慢保存的即时反馈（超过 150ms 仍未完成才提示，避免快保存闪烁）
  saving: '保存中…',
  saveFailed: '保存失败：文件句柄可能失效或文件被占用，请用「文件 → 另存为」重新保存',
  saveAsFailed: '另存为失败，请检查文件位置是否可写',
  // adj363：保存失败按原因给出可操作提示（此前统一静默或笼统提示，用户以为已保存）
  saveGone: '保存失败：原文件已被移动或删除，请用「文件 → 另存为」另选位置',
  saveBusy: '保存失败：文件正被其它程序占用或只读，请关闭占用程序后重试，或用「文件 → 另存为」',
  saveVerifyFailed: '保存未生效：写入后校验内容不一致，请用「文件 → 另存为」另选位置重试',
  saveAsNoGesture: '另存为失败：未获得用户操作授权，请直接再点一次「另存为」或按 Ctrl+S',
  // adj369：保存慢在「提交文件」（浏览器把临时文件替换成目标文件）时的可操作提示——
  // 该步由浏览器 + 操作系统完成，应用代码不参与；adj372 按实测补充"换浏览器"这条（Edge 正常、
  // Chrome/PWA 窗口慢，属浏览器环境差异）
  saveSlowCommitHint: '保存慢在文件替换（浏览器/系统行为）：可试试换用其它浏览器或非 PWA 窗口，或把文件移出云同步/杀软监控目录',
  saveUnsupported: '当前环境不支持保存到磁盘（File System Access API 仅 Chromium 安全上下文支持，手机端通常没有）；请用「文件 → 导出」下载 .jps 保存',
  // adj379：PWA 部署新版后的更新提示（新 SW 已接管、页面仍跑旧 bundle，点击刷新即换新代码）
  updateReady: '发现新版本，点击刷新',
  // adj281：非安全上下文（http:// 或 file://）或非 Chromium 内核下无 Web File System Access API，
  // 降级用 <input type=file> 载入 .jps 文本——已载入但无法写回磁盘，提示改用「导出」保存
  openFallbackNotice: '已载入文件；此环境无法写回磁盘，请用「文件 → 导出」保存成果',
  // adj370：打开文件必须给出反馈（此前失败静默 return false，用户无法判断是否打开成功）
  openOkPrefix: '已打开：',
  openFailedPrefix: '打开失败：',
  // adj401：手机端「打开」里找不到 .jps 时的可操作指引——用户实测：文件在网盘/微信里还没落到本机，
  // 而系统选择器只列本机文件；加上国产浏览器/网盘 SAF 会按类型隐藏未知扩展，
  // 于是「能看到 .md 却看不到 .jps」。这三条覆盖所有情况（落地 / 换目录 / 改扩展名）。
  openPickHint:
    '列表里找不到 .jps？① 先把文件「保存到手机／下载到本地」（网盘、微信里的文件不在本机列表里）；② 再从「下载」目录选；③ 把扩展名改成 .md/.txt 也能打开（按文本读入）；④ 或用「文件 → 粘贴源码导入」（adj406：把源码粘进来即可，不经过文件选择器）',
  // adj405：移动端文件选择器根本没弹出来（个别外壳/PWA 会静默失败，点了像"没反应"）
  openPickerSilent: '文件选择器没有弹出来（个别手机浏览器/PWA 会这样）：请改用浏览器打开本站，或用「文件 → 粘贴源码导入」把源码贴进来',
  // adj428：临时叠加段上下层纵向间距可调（设置 → 谱面 → 临时段）
  segmentRowGapGroup: '临时段',
  segmentRowGapBzLabel: 'bz 段上下间距',
  segmentRowGapDsbLabel: 'dsb 段上下间距',
  // adj629e：替谱行与其**下方歌词行**的间距
  segmentRowGapTpLabel: '替谱行与下方歌词间距',
  segmentRowGapHint:
    '临时叠加段的纵向间距（px）。bz、dsb 为段层与主旋律的间距；' +
    'tp 为替谱行与其下方歌词行的间距，拖动时移动的是替谱层，下方歌词行不动。' +
    '歌词行 1 的虚线调整「歌词区 ↔ 曲部」间距，歌词行 2 及以后调整歌词行之间的间距。' +
    '默认值：bz、dsb 为 22，tp 为 14。',
  // adj479：多声部块内「声部行间距」——此前只有预览虚线可拖（设置里没有输入框，用户报"无法调整"）
  shengbuGapLabel: '声部间距',
  /* ---- adj1000（用户 2026-10-19 要求）：深色预览柔化 ---- */
  previewSoftenOff: '关',
  previewSoftenLight: '轻',
  previewSoftenMid: '中',
  previewSoftenHint:
    '只影响深色主题下的谱面预览：档位越高，纸底越浅、墨色越柔，黑底白字的刺眼感越低。色块、焦点、标记段线的颜色不受影响。',
} as const

/**
 * adj406：「粘贴源码导入」文案——不依赖文件选择器的兜底入口
 * （手机端网盘/微信里的 .jps 常看不到：系统选择器只列本机文件，未知扩展还可能被按类型隐藏）
 */
export const pasteImportCopy = {
  menuLabel: '粘贴源码导入(&V)…',
  title: '粘贴源码导入',
  /**
   * adj579（用户要求）：这条长说明从"常驻正文"改成编辑器上方那个 `?` 的提示
   * （常驻会占掉两行，粘贴框就矮了）；正文位置只留一个短标签 `label`。
   * adj585（用户要求）：`?` 改成**点一下展开**（PC 仍可悬浮）——触屏没有 hover，
   * 旧版只能让这条常驻，手机上白占高度（见 `ui/HelpBadge.tsx`）。
   */
  desc: '把谱面源码粘贴到下面（微信/网盘里复制的文本、笔记里的 ```jps 代码块都可以），点「导入」即替换当前内容。不会写入磁盘，保存请用「导出」。',
  /** adj579（用户要求）：编辑器上方的标签——adj581：去掉冒号，并统一成"谱面页标签"样式（当作标题用） */
  label: '粘贴源码',
  placeholder: '在这里粘贴 .jps 源码……',
  fromClipboard: '从剪贴板粘贴',
  clipboardFailed: '读不到剪贴板内容：请长按输入框手动粘贴',
  clipboardEmpty: '剪贴板里没有文本内容',
  importBtn: '导入',
  cancelBtn: '取消',
  empty: '还没有内容——先粘贴源码再点「导入」',
  ok: (chars: number): string => `已导入粘贴的源码（${chars} 字符）；保存请用「文件 → 导出」`,
  name: '粘贴导入',
} as const

/** adj1249：从乐谱包（zip）导入到当前工作区目录 */
export const scorePackageImportCopy = {
  button: '从乐谱包导入',
  needWorkspace: '请先在底栏「工作区」里选择一个工作区，再导入乐谱包。',
  chooseTitle: '选择乐谱包',
  badZip: '这个 zip 不是有效的乐谱包：缺少 meta.json 或 score.jps。',
  badPath: '乐谱包里有不允许的路径，已中止导入。',
  conflict: (name: string): string =>
    `目录「${name}」已存在。\n\n点「确定」覆盖已有目录；点「取消」创建新目录。`,
  newDirTitle: '新目录名',
  newDirHint: (name: string): string => `目录「${name}」仍存在，请换一个名字。`,
  invalidDir: '目录名不能为空，也不能包含 / \\ : * ? " < > |。',
  creating: '正在解压乐谱包…',
  done: (name: string): string => `已导入到「${name}」`,
  openFailed: '乐谱包已解压，但 score.jps 打不开：请到工作区里手动打开。',
  unsupportedBinary: '当前工作区不支持写入图片资源，已停止导入。',
  failed: (e: string): string => `导入乐谱包失败：${e}`,
} as const

/**
 * adj540：「工作区」文案（Android/移动端"选一个文件夹当工作区"）
 *
 * 解决的是手机上的真实痛点：系统文件选择器对 `.jps` 这种自定义扩展名态度不一致
 * （按 MIME 隐藏、只能看到已下载的文件），保存用的 `showSaveFilePicker` 在移动端还出现过
 * "点了没反应"（adj405）。工作区把打开/保存变成"在同一个文件夹里挑文件/写文件"，
 * 一次授权、之后都在这个文件夹里操作（含**子目录**）。
 */
export const workspaceCopy = {
  menuLabel: '工作区(&W)…',
  /**
   * adj966：桌面壳启动时**不再自动接管**上次的原生目录工作区（用户口径：PC 默认直接操作系统文件、
   * 逐步退出工作区方式）。**明确告知一次**，免得用户以为"上次那份谱丢了"。
   */
  pcNoAutoOpen:
    'PC 版已改为直接操作系统文件：上次的工作区不会自动打开。要用工作区，请在底部「工作区」面板里打开一个目录或文件。',
  /** adj540：系统文件选择器的独立入口（「打开…」在工作区就绪后会改开工作区面板） */
  openSystemLabel: '打开（系统文件选择器）(&F)…',
  title: '工作区',
  desc: '选一个文件夹当工作区：之后打开 / 保存都在这个文件夹里（支持子目录）。手机上都走这条路，不用每次翻系统文件选择器。',
  pick: '选择文件夹当工作区',
  /**
   * adj586（用户要求"继续访问 按钮不需要，通过点击当前工作区项可以切回文件列表"）：
   * 清单里**当前那一项**的悬浮提示——点它 = 补授权 + 回文件列表（原来那个独立按钮已取消，
   * 所以 `grant: '继续访问（需授权）'` 这条文案随之删除）。
   */
  grantTapTitle: '点它即可重新授权访问，并回到文件列表',
  /** adj540：授权前**必须让用户看清是哪个目录**（用户要求）。
   *  adj586：授权前的目录框（`.ws-grant-dir`）按用户要求取消——清单里那行带「当前」标记的
   *  就是正在用的工作区，本字段暂留（另有展示完整路径的需求时再用）。 */
  grantTitle: '需要重新授权访问这个文件夹',
  /**
   * 授权区里那条"为什么看不到完整路径"的说明。
   * File System Access 出于隐私**只暴露文件夹名**（句柄的 `name`），**不提供完整磁盘路径**
   * （`resolve()` 也只能在工作区内算相对路径）⇒ 这里如实说明，别让用户以为是显示不全。
   */
  grantPathHint: '浏览器出于隐私不提供完整磁盘路径，清单里显示的是文件夹名（桌面版有完整路径）',
  /**
   * adj568（用户反馈"下载目录没法当工作区"，追问"为什么不让带系统文件的目录当工作区"）：
   * 这条限制**不在 iJipu 里**，而是浏览器内核（Chromium / WebView2）的**敏感目录黑名单**——
   * 它按"目录在系统里扮演什么角色"判定，**与目录里有什么文件（有没有 .jps）完全无关**：
   * 「下载 / 桌面 / 文档 / 用户主目录」这几个目录**自身**不能授予网页，但**其中的子文件夹可以**
   * （`chrome_file_system_access_permission_context.cc` 的 `GenerateBlockPaths()`，
   * BlockType = `kDontBlockChildren`）。
   * 更麻烦的是：被拦时内核弹框的说法是"包含系统文件"（对干净的下载目录而言并不准确），
   * 且抛出的错误是 `AbortError`——**与"用户取消"完全同一个错误**，应用侧既绕不过、也没法区分，
   * 只能在**选之前**把规矩讲清楚（见 E-2026-271）。桌面版走原生选择器，不受这条 Web 策略约束。
   */
  blockedHint:
    '提示：浏览器不允许把「下载 / 桌面 / 文档 / 用户主目录」这几个目录本身当工作区（内核安全策略，与目录里有没有 .jps 无关）。在它们里面新建一个子文件夹再选即可；桌面版不受此限制，可直接选这些目录。',
  /**
   * adj585（用户要求）：右栏「新工作区」按钮**下方**常驻的短提示——只说"内核要求"这一句；
   * 上面那条长说明（哪些目录被拦、怎么办）收进「选择工作区」标题后的 `?`，点一下才展开。
   */
  chromiumOnly: '仅支持 Chromium 内核浏览器',
  grantWhy: '刷新或重新打开页面后，浏览器会把目录权限重置为"待确认"，需要在点击后重新授予一次。',
  /**
   * adj568：**桌面端**（路径后端）没有"浏览器授权"这回事 ⇒ 这个界面只剩一种成因：
   * 目录被外部删掉/改名/移走了（应用记住的是绝对路径）。用网页版那套"重新授权"文案会误导。
   */
  dirMissingTitle: '工作区目录已不在（可能被移动、改名或删除）',
  dirMissingWhy: '桌面版记住的是目录的完整路径；路径失效后无法继续读写。请重新选一个文件夹。',
  switchDir: '换一个文件夹',
  /** adj540（用户第二轮反馈）：左侧的"切换工作区"按钮改用图标 + 通用悬浮提示
      ——把"切换工作区"这个动作从路径面包屑里彻底分离出去，根目录名恢复成普通的面包屑段（点击=回工作区根）。
      adj569：图标由 `工作区.png` 换成专用的 `切换工作区.png`（页签那处仍是 `工作区.png`） */
  workspaceBtnTitle: '切换工作区目录',
  up: '上级目录',
  emptyDir: '这个文件夹里没有 .jps 文件',
  rootLabel: '工作区',
  onlyListed: '只列出文件夹与 .jps 文件',
  unsupported: '当前浏览器不支持选择文件夹（需要 Chrome / Edge 等 Chromium 内核浏览器）；请改用「文件 → 导出」保存',
  noWorkspace: '还没有设工作区：请先在「文件 → 工作区…」里选一个文件夹',
  /**
   * adj724b：嵌入版（Obsidian）里**没有"选文件夹"这一步**——文库就是工作区。
   * 用户实测：原来的「新工作区」按钮会弹
   * `SecurityError: … Cross origin sub frames aren't allowed to show a file picker.`
   * （浏览器禁止跨源子框架弹文件选择器）⇒ 整块换成这句说明。
   */
  embeddedUsesVault: '当前工作区为 Obsidian 文库（嵌入版无需选择文件夹）',
  picked: (name: string): string => `工作区已设为「${name}」`,
  loadFailed: (reason: string): string => `读工作区失败：${reason}`,
  opened: (p: string): string => `已从工作区打开 ${p}`,
  openFailed: (p: string, reason: string): string => `打开 ${p} 失败：${reason}`,
  saved: (p: string): string => `已保存到工作区：${p}`,
  saveFailed: (p: string, reason: string): string => `保存到工作区失败（${p}）：${reason}`,
  saveHere: '存到此处',
  saveNameLabel: '文件名',
  namePlaceholder: '例如 小星星',
  saveBtn: '保存',
  closeBtn: '关闭',
  // ---- adj540 续：文件操作（新建/改名/移动/删除；破坏性操作必须二次确认） ----
  // 文案从简（用户要求"能指明指示为宜"）：右侧按钮列窄（96px），短标签更好读、也更少换行。
  // 「改名/移动」而不写"重命名/移动到…"，「新建」在本面板里只有"新建文件夹"一种含义，
  // 「存到此处」= 把当前谱写进当前目录（与全局「保存 Ctrl+S」区分开）。
  // adj558（用户反馈"新建夹太口语化"）：「新建夹」→「新建目录」；行为也改——创建完成后
  // **自动进入**该新目录（与文件管理器一致），不再停在父目录让用户再点一次进去。
  /** 行尾「更多操作」按钮（打开/改名/移动/删除） */
  moreActions: '更多操作',
  /** adj540：多选时的选中条数 */
  selectedCount: (n: number): string => `已选 ${n} 项`,
  actOpen: '打开',
  /** adj540：写回当前谱绑定的工作区文件；未绑定时等同于「另存」（不出现"按了没反应"的死路） */
  actSave: '保存',
  /** adj540：把当前谱**写进当前目录**（可改文件名） */
  actSaveAs: '另存',
  /** adj540：在当前目录新建一份空谱（用「新建」模板内容）并打开 */
  actNewScore: '新建',
  actRename: '改名',
  actMove: '移动',
  actDelete: '删除',
  /** adj558（v0.28.2，用户要求）：「新建夹」→「新建目录」——"夹"字偏口语，目录更准确 */
  actNewFolder: '新建目录',
  /** adj540：分组下拉的第三组——作用在选中项上的操作（改名/移动/删除） */
  actOps: '操作',
  newScorePlaceholder: '新谱名（不用写 .jps）',
  folderNamePlaceholder: '文件夹名',
  renamePlaceholder: '新名字（不用写 .jps）',
  confirmBtn: '确定',
  cancelBtn2: '取消',
  /** 移动模式：进入目标目录后再点它 */
  moveHere: '移到此处',
  moveCancel: '取消',
  /** 永久删除的二次确认（FSA 没有回收站） */
  deleteFileConfirm: (n: string): string => `永久删除「${n}」？删了就找不回来了（浏览器文件 API 没有回收站）`,
  deleteDirConfirm: (n: string): string => `永久删除空文件夹「${n}」？`,
  dirNotEmpty: (n: string): string => `「${n}」里还有东西，本轮只删空文件夹（避免连带删掉里面其它文件）`,
  exists: (n: string): string => `已存在同名「${n}」，换个名字`,
  invalidName: '名字不能为空，也不能包含 / \\ 或 ..',
  /** adj558：「已新建文件夹」→「已新建目录」——与新文案一致 */
  dirCreated: (n: string): string => `已新建目录「${n}」`,
  /** adj540：新建谱（写进工作区当前目录） */
  created: (n: string): string => `已新建「${n}」`,
  renamed: (a: string, b: string): string => `已把「${a}」重命名为「${b}」`,
  moved: (n: string, dir: string): string => `已把「${n}」移动到「${dir || '根目录'}」`,
  /** adj540：多选批量移动/删除的汇总文案 */
  movedMany: (n: number, dir: string): string => `已移动 ${n} 个到「${dir || '根目录'}」`,
  deletedMany: (n: number): string => `已删除 ${n} 项`,
  /** 部分成功：如实报出成功数与第一个失败原因（不假装全成功） */
  opPartial: (ok: number, fail: number, reason: string): string => `${ok} 项成功、${fail} 项失败（${reason}）`,
  /** 多选时删除确认里的条数提示 */
  deleteManyConfirm: (n: number): string => `永久删除选中的 ${n} 项？删了就找不回来了`,
  /** adj540：过滤框（用户要求）——过滤时列出符合条件的 .jps（平坦列表，便于快速打开）
   *  adj545：右栏固定宽度很窄，占位符只留最短提示（完整规则在 `filterHint` 悬浮提示里）
   *  adj580（用户反馈）：**过滤范围 = 当前目录及其下级**（不再是整个工作区）——用户在某层目录里
   *  过滤时想的就是"在这个目录里找"；人在根目录时行为不变（= 整个工作区）。 */
  filterPlaceholder: '过滤 .jps…',
  filterClear: '清空过滤',
  /** adj540（用户要求）：过滤框旁的一键按钮——填入 `*` 即列出全部 .jps（再点一下清空） */
  filterAll: '*',
  filterAllTitle: '列出当前目录（含子目录）全部 .jps',
  /** 通配符说明（输入框 title）——adj580：连范围一起说清 */
  filterHint: '在当前目录及其子目录里过滤；不含 * ? 时按子串匹配，含 * ? 时按通配符整体匹配（如 小星*、*练习*、第?课）',
  searchEmpty: '当前目录里没有匹配的 .jps',
  /** adj543：首次过滤要建立索引（走一次目录树）——给个等待提示，别让用户以为"什么都没有" */
  searchIndexing: '正在读取当前目录…',
  /**
   * adj546（用户实测 5550 文件/117 目录的工作区要 27 秒）：扫描期间显示进度——
   * `边扫边出结果` + 计数，用户能看到在动，也能马上打开已找到的谱。
   */
  scanning: (scanned: number, found: number, ms: number): string =>
    `正在扫描…已查 ${scanned} 项 / 找到 ${found} 个 / ${(ms / 1000).toFixed(1)}s`,
  /**
   * adj590（用户要求"工作区在索引操作时，应该有提示消息"）：建索引是**几十秒级**的长操作，
   * 而且现在会在"打开面板/切工作区"之后**空闲时自己跑起来**——不说一声用户只会觉得"卡住了/没反应"。
   * 这句放在列表**最上方**（与其它进行中提示同款：转圈 + 文案，滚动也看得见）。
   */
  indexing: (scanned: number, found: number): string => `正在建立索引：已扫描 ${scanned} 项 / 找到 ${found} 个谱`,
  /** adj590：索引建好后的**收尾提示**（用户要求"应该有提示消息"）——告诉它成了、有几个谱、花了多久 */
  indexReady: (found: number, sec: string): string => `索引完成：${found} 个谱（用时 ${sec}s）`,
  /** adj590：索引没建成时也要说（否则用户以为"就是没有这些谱"） */
  indexFailed: '建立索引失败（可稍后在「操作 ▾ → 重新扫描工作区」重试）',
  /**
   * adj607（E-2026-296）：**没授权时不许建索引**——未授权的目录句柄读取一律 `NotAllowedError`，
   * 扫出来会是一份"0 命中"的空索引，装上之后过滤会一直短路（用户现象：`*` 什么都不出）。
   * 这句只在"面板还停在授权界面、用户却触发了建索引"时出现。
   */
  indexNeedGrant: '还没授权访问这个文件夹，暂时不能建立索引',
  /**
   * adj607：**整棵树都没读到**（根目录被拒 / 目录被删 / 授权被撤）——
   * 必须与"工作区里确实没有 .jps"区分开，否则用户会以为自己的谱不见了。
   */
  indexUnreadable: '没能读取工作区目录，索引未建立（确认文件夹还在、并重新授权后会自动重试）',
  /** adj546：命中太多时不全部渲染（手机上一次画几千行要几百毫秒），如实说明并引导缩小范围 */
  searchCapped: (total: number, shown: number): string => `共 ${total} 个，只显示前 ${shown} 个（输入关键词可缩小范围）`,
  /**
   * adj547（用户反馈）：点目录/文件后到内容出来之间是"黑的"——用户分不清是"不能点""没响应"还是"在忙"。
   * 所有会等的动作都必须在界面上**立刻**显示"进行中"的提示（转圈 + 说清在做什么）。
   */
  enteringDir: (name: string): string => `正在进入「${name}」…`,
  openingFile: (name: string): string => `正在打开「${name}」…`,
  loadingWorkspace: '正在读取工作区…',
  refreshing: '正在刷新…',
  readingTarget: '正在读取目标目录…',
  /** adj548：上次所在的目录已不存在（被外部删/移动）⇒ 回到仍存在的最外层并说明 */
  dirGone: (was: string, now: string): string => `上次所在的「${was}」已不在，已回到「${now || '工作区根目录'}」`,
  /** adj540（用户报告 `*` 仍看不到文件）：读不动的目录也主动说出来——"没搜到"与"没搜完/搜到一半"是两件事 */
  searchBlockedDirs: (dirs: string[]): string =>
    `有 ${dirs.length} 个子目录读不动（可能在里面），已跳过：${dirs.slice(0, 3).join('、')}${dirs.length > 3 ? '…' : ''}`,
  /** 命中数被上限截断时如实告知（否则用户以为"文件不见了"） */
  searchTruncated: (n: number): string => `匹配项很多，先显示前 ${n} 个（输入更具体的关键词可缩小范围）`,
  /** 过滤结果条数（侧栏标签用） */
  searchResults: (n: number): string => `匹配 ${n} 个`,
  /** 过滤模式下的说明（点击结果=直接打开） */
  searchHint: '点一条直接打开',
  /** 只有一个下拉按钮（用户要求）：点它弹出操作菜单 */
  menuBtn: '操作',
  /** 过滤模式下不能改名/移动/删除（没有勾选项） */
  opNeedsSelection: '先清空过滤，在目录里勾选文件',
  /** 重命名只支持单个 */
  renameSingleOnly: '重命名一次只能改一个',
  /** 多选里含目录时不能移动 */
  moveDirUnsupported: '选中的里有文件夹，移动只支持 .jps 文件',
  deleted: (n: string): string => `已删除「${n}」`,
  deletedOpenFile: (n: string): string => `「${n}」已被删除——内容仍在编辑器里，可用「保存当前谱到此处」重新存一份`,
  /**
   * adj544（E-2026-251）：绑定的谱属于**另一个工作区** ⇒ 保存**拒绝写盘**。
   * 必须说清"东西在哪、为什么没写、接下来怎么办"——静默写错文件不可接受。
   */
  boundToOtherWorkspace: (boundWs: string, currentWs: string, path: string): string =>
    `这份谱绑定在工作区「${boundWs}」的 ${path}，当前工作区是「${currentWs}」——为避免写错文件，本次未保存。请切回「${boundWs}」再保存，或用「操作 → 另存」存到当前工作区`,
  /** adj544：绑定的原文件已不在（被外部移动/删除）⇒ 提示并转另存，不静默重建同名文件 */
  sourceMissing: (path: string): string => `原文件 ${path} 已不在工作区里（可能被移动或删除）——请用「操作 → 另存」确认保存位置`,
  /** adj544：重启后恢复了来源绑定，需重新授权才能写回原文件 */
  bindingRestored: (wsName: string, path: string): string =>
    `这份谱来自工作区「${wsName}」的 ${path}：重新授权该工作区后，「保存」即可写回原文件`,
  /** adj544：最近工作区列表标题（面板可一键切回） */
  recentWorkspaces: '最近的工作区',
  /** adj546：手动重新扫描工作区（外部新增文件 / 索引过期时用；平时靠落盘索引秒开） */
  rescan: '重新扫描工作区',
  /** adj544：从"最近工作区"切回失败（目录被删/移动、授权被拒） */
  activateFailed: (n: string): string => `无法打开工作区「${n}」（目录可能已被移动/删除，或授权被拒绝）`,
  verifyFailed: (n: string): string => `「${n}」写入后校验不一致，已保留原文件（请重试）`,
  opFailed: (n: string, reason: string): string => `「${n}」操作失败：${reason}`,
  /** 目录暂不支持重命名/移动（递归搬运风险大，本轮只做文件） */
  dirOpUnsupported: '文件夹暂不支持重命名/移动（本轮只对 .jps 文件做）',
  /** 点了"选择文件夹"但系统没弹选择器（静默失败）时的可操作指引 —— 见 ERRORS-LOG E-2026-241 */
  pickerNoResponse:
    '系统没有弹出文件夹选择器。如果你是从桌面图标（已安装的应用）打开的，请改用 Chrome 浏览器打开本站再试一次——数据不会丢。',

  // ---- adj575（用户要求）：**工作区选择界面** ----
  // 用户口径（adj575）："先显示界面，有一个清单列出之前已打开过的工作区以供选择，每个工作区后面有个叉用于遗忘该项，
  // 有一个「打开其它目录」按钮用于打开选择目录的对话框"——即**不要**一按就直接弹系统对话框，
  // 先把清单摆出来（并把原先"待授权/目录已不在"那一屏的信息并进来）。
  // adj577（用户要求）：改成**左右分栏**（左=清单、右=操作按钮），按钮改名「**新工作区**」，
  // **取消**「返回文件列表」——改为**点当前工作区那一项**即回到文件列表；
  // 当前工作区**不给 ✕**（它必须一直留在清单里 ⇒ "已打开的工作区才能成为当前工作区"）。
  chooseTitle: '选择工作区',
  chooseHint: '点清单里的工作区直接打开；「新工作区」可选一个没打开过的文件夹。',
  /** 每项后面的 ✕ —— 语义要说清：只动这份清单，不动磁盘、也不动当前正在用的工作区 */
  forgetTitle: '从这份清单里移除（不会删除磁盘上的文件夹）',
  forgotten: (n: string): string => `已从最近列表移除「${n}」`,
  /** adj577：按钮文案由「打开其它目录」改为「**新工作区**」，并移到右侧操作区 */
  openOther: '新工作区',
  /** adj577：当前工作区**没有 ✕**——点它即回到文件列表（因此不再需要「返回文件列表」按钮） */
  backToFilesTitle: '点它回到文件列表',
  /** adj577：新选的目录本来就是清单里那个（同一个目录只能有一个工作区）⇒ 直接切过去 */
  reused: (n: string): string => `这个文件夹已经是工作区「${n}」了，已直接切过去`,
  chooseEmpty: '还没有打开过的工作区',
  /** 清单里标出"正在用的那个" */
  currentTag: '当前',
} as const

/**
 * adj963（**用户要求**）：「保存到工作区」对话框的文案。
 *
 * 这是个**专用保存对话框**，专治插件（Obsidian 嵌入版）里的保存：
 * 嵌入版是跨源子框架，浏览器**禁止**它弹系统文件选择器（adj724b 实测 `SecurityError`），
 * 所以原来只能把用户送到「工作区面板」；而工作区页签在嵌入版又是**隐藏**的
 * （`ToolDock` 的 `visibleTabs`，adj724c 口径"文件操作交给 Obsidian"）⇒ 那条路半通不通。
 * 现在给嵌入版一个**只做一件事**的对话框：选目录 + 填文件名 → 写进当前文库。
 */
export const saveAsCopy = {
  title: '保存到工作区',
  /** 文件名输入框上方的标签 */
  nameLabel: '文件名',
  namePlaceholder: '不填就用描述头标题',
  /** 目录区标题（可进入子目录） */
  dirLabel: '保存到',
  rootLabel: '（文库根目录）',
  upLabel: '上一层',
  emptyDir: '这个目录里没有子目录',
  /**
   * 目录树是按需展开的（一次只列当前层）：文库大时把整棵树都拉出来既慢又吵，
   * 而"存到哪儿"通常只需要看着当前这一层决定。
   */
  dirHint: '只列当前这一层：点目录进去，点「上一层」退回',
  /**
   * 权限说明：网页版（FSA）刷新后首次使用是 `prompt`，而**申请必须在用户手势内**
   * （浏览器拒绝挂载时静默申请，见 DESKTOP-ASSOC-AND-ANDROID.md §3.1）⇒ 给一个明确的按钮。
   */
  needGrant: '需要重新授权访问这个工作区（浏览器要求由你点一下才给）',
  grantBtn: '继续访问',
  loading: '正在读取目录…',
  readFailed: '读目录失败',
  saveBtn: '保存',
  cancelBtn: '取消',
  /** 没有绑定工作区时的指路（嵌入版正常不会出现，网页版可能） */
  noWorkspace: '还没有工作区：请先在「文件 → 工作区…」里选一个文件夹当工作区',
  /**
   * 文件名非法字符**在写盘之前**就拦下：交给文件系统的话，轻则写不进去、重则建出怪名字，
   * 而错误信息是 `NotAllowedError` 之类的底层话（用户看不懂）。这是 Windows 内核的限制，
   * Obsidian 文库（vault）同样不吃这些字符。
   */
  badName: '文件名里不能包含 \\ / : * ? " < > | 这些字符',
  emptyName: '请先填一个文件名',
  /** 目录树里已存在的同名文件（只作参照，点它会把名字填进输入框） */
  existsTip: '已存在这个文件',
  /** 保存成功（与工作区面板的 `saved` 同口径，但这里要说明"存到工作区了"） */
  saved: (path: string) => `已保存到工作区：${path}`,
} as const

/**
 * adj394：编辑区「问题提示条」文案（脚本不符合语法时在编辑区内显式可见，
 * 此前只有行号栏着色 + 悬停 tooltip，用户看不出哪里不对）
 */
export const problemCopy = {
  /** 无问题时的状态文字（状态栏小圆点 tooltip） */
  clean: '语法检查通过',
  /** 有错误时的状态文字 */
  hasErrors: '有语法错误',
  /** 仅有警告时的状态文字 */
  hasWarnings: '有语法告警',
  /** 分级标签（与 summarizeProblems 的 label 一致） */
  error: '错误',
  warning: '警告',
  /** 提示条标题：N 个问题（X 错误 / Y 警告） */
  title: (total: number, errors: number, warnings: number): string => {
    const parts: string[] = []
    if (errors > 0) parts.push(`${errors} 个错误`)
    if (warnings > 0) parts.push(`${warnings} 个告警`)
    return `${total} 个问题（${parts.join(' / ')}）`
  },
  /** 行尾提示：点击跳到该位置 */
  jumpHint: '点击跳转到该位置',
  expand: '展开',
  collapse: '收起',
  /** adj394：问题条里「正确写法」的前缀（hint 由引擎给出） */
  correctPrefix: '正确写法：',
  /** 打开内置「语法速查」对话框 */
  syntaxHelp: '语法速查',
  /** adj462：每条问题行首的「正确写法」展开/收起（默认收起，按需展开） */
  expandHint: '展开正确写法',
  collapseHint: '收起正确写法',
} as const

/**
 * adj462：底部 dock 文案（告警 / 试听 / 导出 / 设置 共用一个 dock，互斥切换）
 */
export const dockCopy = {
  /** 面板标签 */
  tabProblems: '告警',
  tabTryout: '试听',
  tabExport: '导出',
  /**
   * adj603（用户要求）：原「设置」页签**拆成两个**——「全局」（视图/主题/音色库，本机偏好）
   * 与「谱面」（布局/字体，随谱保存）。
   */
  tabSettings: '全局',
  /** adj492：「关于」从弹窗迁入 dock */
  tabAbout: '关于',
  /** adj540：工作区（选文件夹当工作区；移动端的打开/保存主路径） */
  tabWorkspace: '工作区',
  /** adj603（用户要求）：底栏「谱面」页签（谱面设置：布局 / 字体）——紧跟在「全局」之后 */
  tabScore: '谱面',
  /** adj562：导入（粘贴源码导入）——排在工作区之后（用户要求） */
  tabImport: '导入',
  /**
   * adj641（用户要求）：**查找替换**页签——用户口径："编辑区只有 Ctrl+F 搜索操作，还缺少一个替换操作……
   * 在底栏 dock 里增加一个查找替换页签，将查找和替换进行整合"。排在「导入」之后（同属"改内容"的动作）。
   */
  tabFind: '查找替换',
  /** 标题栏 × 按钮 */
  closeTitle: '关闭底栏',
  /** adj541：底栏展开/收起（编辑区左下角悬浮按钮 + 页签栏里的收起按钮） */
  expandTitle: '展开底栏',
  /**
   * adj591（用户要求"脚本有告警时，打开底栏先切到告警窗口，否则不切换"）：
   * 有告警时「展开底栏」按钮的 tooltip——点开会**先切到告警页签**，先说清楚再去。
   */
  expandWithProblems: (n: number): string => `展开底栏（先看告警：${n} 条）`,
  collapseTitle: '收起底栏',
  /** 顶部抓手（拖拽调整 dock 高度） */
  resizeTitle: '拖动调整底栏高度',
  /**
   * adj556（用户要求"页签始终显示图标，靠左右滚动查看视界外的页签"）：当页签多到放不下、
   * `.tool-dock-tabstrip` 横向溢出时，左右两端各出现一个**翻页箭头**按钮（只在"该方向还有
   * 内容"时才显示；滚到尽头就消失）。文案与输入条 adj553 那对保持一致语义。
   */
  tabsLeftTitle: '向左翻看页签',
  tabsRightTitle: '向右翻看页签',
  /** 无告警时告警面板的占位文字 */
  noProblems: '语法检查通过，没有问题。',
  /** 导出进行中（状态栏动态指示），clickHint 提示可点击查看 */
  exportRunning: (label: string): string => `导出中：${label}`,
  exportRunningHint: '点击查看导出面板',
  /**
   * adj520：dock 高度档位切换按钮（位于关闭按钮左侧）—— 单按钮 4 相位循环
   * `建议 → 最大 → 建议 → 最小 → 建议`，图标（`上.png` / `下.png`）方向按"点一下会往哪走"切换。
   */
  sizeGroupTitle: '底栏高度档位',
  /** 三个档位的中文名（用于按钮 title / aria-label 的拼装） */
  sizeName: { max: '最大', suggested: '建议', min: '最小' } as const,
  /** 按钮提示：当前档 + 点一下会到哪一档 */
  sizeTitle: (cur: string, next: string): string => `底栏高度：${cur}（点击 → ${next}）`,
} as const

/**
 * adj641（用户要求）：**查找替换面板**（底栏「查找替换」页签）的文案。
 *
 * 用户口径："页签里有查找内容框、替换内容框，有查找统计，还有查找按钮、替换按钮。"
 * 匹配与替换的**算法**在 `editor/findReplace.ts`（纯函数、smoke 断言），这里只有文案。
 */
export const findCopy = {
  /** 两个输入框的行标签 */
  findLabel: '查找',
  replaceLabel: '替换',
  findPlaceholder: '要查找的内容（支持 # $ [ ] 等语法字符，按字面匹配）',
  replacePlaceholder: '替换为（留空 = 删除匹配到的内容）',
  /** 查找按钮（上一个 / 下一个） */
  prev: '上一个',
  next: '下一个',
  prevTitle: '查找上一个（Shift+Enter）',
  nextTitle: '查找下一个（Enter）',
  /** 替换按钮（当前项 / 全部） */
  replaceOne: '替换',
  replaceOneTitle: '替换当前一处，并继续找下一处',
  replaceAll: '全部替换',
  replaceAllTitle: '一次替换全部匹配（可一步撤销）',
  /** 区分大小写开关（默认开：`.jps` 里 `Q:` 与 `b` 这类大小写有语义） */
  caseSensitive: '区分大小写',
  caseSensitiveTitle: '区分大小写（默认开：谱面源码里大小写有意义）',
  /** 查找统计 */
  statIdle: '输入要查找的内容',
  statNone: '无匹配',
  statTotal: (n: number): string => `共 ${n} 处`,
  statCurrent: (i: number, n: number): string => `第 ${i}/${n} 处`,
  /** 一次性提示（较长的说明放在「说明」行，常驻可见） */
  hint: '查找为字面匹配（不解析正则）；「替换」改当前一处并自动续到下一处，「全部替换」一次改完、可一步撤销。',
  /** 替换结果提示（短暂显示在统计行，避免额外弹 toast 打断输入） */
  replaced: (n: number): string => `已替换 ${n} 处`,
} as const

/**
 * adj526：数值调节文案（设置里的 px 框、顶栏预览比率、编辑器字号共用一套操作）
 *
 * 由来（用户报，手机端）：数字输入框在手机上不显示原生上下小按钮，而部分字段又限定范围，
 * 配合"输入即钳制"导致数字改不动。现统一为三类操作：**点一下用键盘输入**、
 * **`−`/`+` 步进（可按住连续）**、**按住数值上下拖**（触屏先长按）。
 */
export const numCopy = {
  /** `−`/`+` 步进钮（桌面靠原生 spinner，故只在触屏显示，见 CSS） */
  decrease: '减小（可按住连续调节）',
  increase: '增大（可按住连续调节）',
  /** 数值本身的提示：说明"按住上下拖"这条路径（输入框：还能直接打字） */
  scrubHint: '按住上下拖动可调节数值（左右拖动快速调节）；点一下可直接输入',
  /** adj529：顶栏预览比率的提示——**双击**即按预览区宽度适配 */
  zoomScrubHint: '按住上下拖动调节预览比例；双击按预览区宽度适配',
  /** 顶栏编辑器字号的提示（该处是显示值，旁边另有 `A−`/`A+` 按钮） */
  fontSizeScrubHint: '按住上下拖动调节字号（两侧 A−/A+ 也可调节）',
} as const

/**
 * adj462：导出面板（底栏 dock 内，流式布局）文案——从 ExportDialog 的字面量收敛到此处
 */
export const exportCopy = {
  svgLabel: 'SVG 矢量图',
  pngLabel: 'PNG 高清图片',
  jpgLabel: 'JPG 图片（白底）',
  // adj626（用户要求）：PDF 改走**系统打印 → 另存为 PDF**（矢量、放大不糊），
  // 不再默认用"SVG 栅格化内嵌"的位图 PDF；位图那份保留为二级入口（无需对话框、一键出文件）。
  pdfLabel: 'PDF 文档（打印·矢量）',
  pdfImageLabel: 'PDF 图片（位图）',
  pdfPrintHint:
    'PDF：调用系统打印对话框 → 目标选「另存为 PDF」。矢量输出、放大不糊，且不开新窗口（无弹窗拦截）；' +
    '默认文件名取谱面第一个 B:（标题）。需要不经对话框直接拿文件时，用「PDF 图片」按上面的清晰度导出。',
  midiLabel: 'MIDI 音频（分轨）',
  wavLabel: 'WAV 音频（高保真）',
  mp3Label: 'MP3 音频（体积小）',
  jpsLabel: 'iJipu 源文件',
  scaleLabel: '图片清晰度',
  scaleHint: '适用于 PNG / JPG / PDF 图片',
  /**
   * adj873（T-3）：**导出范围**——「页面」= 整页 + 四周留白（默认，保持既有行为）；
   * 「谱面」= 墨迹包围盒 + 每边 2px（与插件同一个口径，几何只走引擎 `render/range.ts`）。
   */
  rangeLabel: '导出范围',
  rangePageOption: '页面（整页 + 留白）',
  rangeScoreOption: '谱面（墨迹 + 每边 2px）',
  rangeHint: '适用于 SVG / PNG / JPG / PDF 图片；「谱面」用预览区实测墨迹，需先在预览里显示过一次',
  /** 「谱面」量不到墨迹时的**明确报错**前缀（后面接引擎给的原因；绝不静默给整页图 ✗） */
  rangeNoInk: '导出谱面失败：量不到墨迹盒。请先让这份谱在预览区显示一次，或把「导出范围」改回「页面」。原因：',
  busy: '导出中…',
  /** 有语法错误时图片/PDF 导出的拦截提示 */
  blockedByError: '存在语法错误，无法导出。请先修正脚本。',
  errorHint: '当前脚本存在语法错误，图片/PDF 导出需先修正。',
  /* adj1002（用户 2026-10-19 要求）：导出背景——底色与背景图是**两项独立**开关 */
  bgLabel: '导出底色',
  bgNone: '透明（默认）',
  bgWhite: '白',
  bgPaper: '纸色（跟随档位）',
  bgImageLabel: '带上背景图/水印',
  bgHint:
    'PNG 支持透明；JPG/PDF 没有透明通道，选透明时按白底导出。背景图与底色独立：关掉它，页面边距露出的是纸色（不会出现白块）。',
} as const

/**
 * adj509：试听音色选择对话框（设置 → 音色库 → 「指定音色」按钮触发）文案
 */
export const voicePickerCopy = {
  /** 对话框标题 */
  title: '指定试听音色',
  /** 搜索框 placeholder */
  searchPlaceholder: '按名称搜索',
  /** 顶部统计行；adj1012：带上"当前库"——同一个 program 在不同库里名字不同，不写库名会让人以为选错了 */
  summary: (selected: number, total: number, libName?: string): string =>
    `已选 ${selected} / ${total} 个音色${libName ? `（本库：${libName}）` : ''}（仅勾选项进入「试听」面板的音色下拉）。`,
  /** adj1012/adj1017：本库音色表还没读到时，**必须说清"下面不是本库的名字"** */
  fallbackHint: (libName: string): string =>
    `「${libName}」的音色表还没读到（先在「音色库」里下载/导入这个库）——下面按 GM 标准 128 个显示，**这些名字不是本库的**。`,
  /** adj1017：本库确实没有 bank 0（只有变体/鼓组）——比"假装有 128 个"诚实 */
  noBank0Hint: '本库没有 bank 0（GM 主音色），只有变体/鼓组——暂不支持选择。',
  /** adj1019：民族乐器只有「拟声」映射（GM 里没有二胡/琵琶/古筝）——必须让用户看见"拟"字 */
  ethnicTitle: '民族乐器（拟）',
  ethnicHint:
    'GM 音色库没有二胡/琵琶/古筝这些乐器：谱面里写这些名字时，会用下面这些最接近的 GM 音色来演奏。' +
    '这只是"拟声"，不是真实采样；要真实民乐请用外部音源（导出 MIDI 后在 DAW 里挂民乐音源）。',
  /** 快捷按钮 */
  selectAll: '全选',
  clearAll: '全消',
  invert: '反选',
  selectGroup: '选本组',
  clearGroup: '消本组',
  /** 底部按钮 */
  done: '完成',
} as const

/** adj369：保存阶段中文名（保存慢时的提示与控制台明细用） */
export const savePhaseCopy = {
  open: '打开写入流',
  write: '写入数据',
  commit: '提交文件',
  perm: '权限申请',
  store: '写入草稿名',
  ui: '更新界面状态',
} as const

/** 试听播放文案（adj344：固定 SpessaSynth 高保真——仅保留「音色」下拉相关文案） */
export const playbackCopy = {
  /** 音色下拉 label（固定高保真，只列启用收藏音色） */
  synthLabel: '音色',
  /** adj366：音色下拉的「自动」项——跟随谱面（@乐器 / 声部名）路由，非固定音色 */
  voiceAuto: '自动（跟随谱面声部/乐器）',
  /** adj448：选了具体音色时的提示——按设计它会覆盖谱面的 `Y:` 乐器（用户曾因此以为「多声部 Y: 不生效」）
   *  adj455：改为「全篇统一音色」（含 `{bz}`/`{dsb}` 伴奏声部与曲内 `@乐器名@` 切换），文案同步 */
  voiceOverrideHint: '已指定音色：全篇（所有声部，含 `{bz}`/`{dsb}` 伴奏与曲内 `@乐器名@` 切换）都用它演奏；要按谱面音色演奏请选「自动」。',
  /** adj455：选了具体音色、且谱面里确有 `@乐器名@` 切换时的补充提示（`{n}` = 处数） */
  voiceOverrideAtHint: (n: number) =>
    `谱面里有 ${n} 处 \`@乐器名@\` 显式音色切换，已被上面的试听音色统一覆盖（听不到切换是正常的；要按谱面演奏请选「自动」）。`,
  /** 音源加载状态 */
  loading: '加载中…',
  loaded: '已加载',
  failedFallback: '加载失败',
  /**
   * adj416：桌面端随安装包内置音源（安装目录 `<库 id>.sf2`）→ 直接读取，无需下载。
   * adj1011：文件名由调用方传入 —— 原来钉死 `generaluser_gs.sf2`，切换/新增库后就是假话。
   */
  builtinBankHint: (fileName: string) =>
    `✓ 使用随应用内置音源（安装目录 ${fileName}），无需下载、离线可用。`,
  /* ---- adj987（用户 2026-10-18 需求）：试听「练习段」 ---- */
  /** 段组标题（收起时也显示） */
  practiceTitle: '标记段',
  /** 下拉第一项：无标记 = 演奏全曲（**不可删除**） */
  practiceNone: '无（演奏全曲）',
  practiceSelectTitle: '选择标记段（第一项「无」= 演奏全曲，不可删除）',
  /** 「起始」「停止」两个按钮 —— 先点音符，再点它们 */
  practiceStart: '起始',
  practiceStop: '停止',
  practiceStartHint: '先在谱面点一个音符，再点这里 ⇒ 把它设为这段的起始',
  /**
   * 用户口径（2026-10-18 最后确认）：「连音线部分**不再自动判断**，由用户指定到连音线最后一个主音符」
   * ⇒ 提示里直接告诉用户：想连到线尾就把停止标在**那条线的最后一个主音**上。
   * （停止音自己的附点 / 增时线是自动完整的，不必额外操作。）
   */
  practiceStopHint:
    '先在谱面点一个音符，再点这里 ⇒ 把它设为这段的停止（它自己的附点/增时线会完整播放；要练到连音线末尾，请把停止标在那条线的最后一个主音上）',
  practiceAdd: '添加',
  practiceAddHint: '把当前的起始/停止登记成一段标记（起止都标好才可用）',
  practiceDelete: '删除',
  practiceDeleteHint: '删除当前选中的标记段（「无」不可删除）',
  practiceLoop: '循环',
  practiceLoopHint: '循环播放这一段（关掉则播一遍就停）',
  /** 左上角小按钮 */
  practiceCollapse: '收起标记段组',
  practiceExpand: '展开标记段组',
  /** 起止没标全就想添加 */
  practiceNeedBoth: '先标好「起始」与「停止」两个音符，再添加这一段。',
  /** 候选遍次（同一对起止在展开序列里可能有多处） */
  practicePassTitle: '这一对起止对应多处（反复/跳跃）——选你要练的那一遍',
  /** 标记失效：端点音符在当前谱面里找不到（谱被改过 / 标在被跳过的房子里） */
  practiceMarkInvalid: '这段标记的音符在当前谱面里找不到（可能改过谱），本次按「全曲」播放；请重新标一段。',
  /** 循环之间的 3 秒静默（用户口径：区分循环位置 + 喘口气） */
  practiceLoopGapHint: '循环时每遍之间静默 3 秒',
} as const

/**
 * adj538：**外部打开**（双击 `.jps` / 文件关联 / 右键"打开方式"）相关文案。
 * 链路：NSIS 注册关联 → 双击时以 `"ijipu.exe" "%1"` 启动 → 已有窗口由单实例插件接管 →
 * 前端拉取队列并载入；此后 Ctrl+S 直接写回**原文件**（不再要求"另存为"）。
 */
export const externalOpenCopy = {
  /** 从系统打开成功（给用户一个"文件确实换了"的确认，尤其是窗口被置前时） */
  opened: (name: string) => `已打开 ${name}.jps`,
  /** 一次打开多个：载入第一个，并告知还有几个没打开 */
  openedWithExtra: (name: string, extra: number) => `已打开 ${name}.jps（另有 ${extra} 个文件未打开）`,
  /** 读取失败（路径没权限/文件被删/不是文本）——如实报错，不静默 */
  openFailed: (name: string, reason: string) => `打不开 ${name}.jps：${reason}`,
  /** 写回原文件成功 */
  savedToSource: (name: string) => `已保存到 ${name}.jps`,
  /** 写回失败（Rust 侧回读校验不过/无权限/文件被移走）——提示另存为，绝不谎报已保存 */
  saveToSourceFailed: (name: string, reason: string) => `保存到 ${name}.jps 失败：${reason}（可改用「另存为」）`,
} as const

/**
 * adj958（用户要求）：应用内帮助对话框（`dialogs/DocDialog.tsx`）的**目录按钮**文案。
 *
 * 用户原话：「应用内 DocDialog 标题上是否可以加个目录弹出菜单按钮，跟窄屏的手册里的显示一样，
 * 方便跳转」。三本手册（操作手册 / 脚本语法说明 / 命令行手册）共用这一套。
 */
export const docCopy = {
  /** 标题栏那个按钮的文字（与官网窄屏文档页的「目录」同一个词） */
  tocButton: '目录',
  /** 悬浮提示：说清怎么关（对话框里 ESC 是关整个框，不是关目录，见 DocDialog 文件头） */
  tocTip: '跳到某一节：点条目即跳转；再点一次「目录」、点条目或点别处都会收起（ESC 是关整个对话框）',
  /** 浮层顶部的小标题 */
  tocTitle: '目录',
} as const

/**
 * adj927/adj928：**"文件内容已在别处被改动"**的提示与差异框文案。
 *
 * 用户口径（2026-10）：
 *  · 判据改成"**内容真的变了才提示**"（时间戳不再单独作数，见 `store/externalChange.ts`）；
 *  · 文案**不许**再笼统说"外部变更"——要说明可能是 Obsidian 里编辑，也可能是 Sync 同步，
 *    并把两个选择的后果写清（保留本地 / 载入外部）；
 *  · 提示里能点开一个**两栏源码差异框**（左 = 本地、右 = 外部），自己看差异再决定。
 */
export const externalChangeCopy = {
  /** 顶部确认条正文（adj927 改写：说清"内容"与两个选择的后果） */
  askText: (name: string) =>
    `「${name}」的文件内容已在其它地方被改动（可能是 Obsidian 里编辑，也可能是 Sync 同步进来的）。` +
    '选「载入外部」会用文件里的新内容替换当前编辑；选「保留本地」则保留你正在编辑的这份，下次保存会写回文件。' +
    '两边都改过时，可以点「查看差异」逐块选「用左 / 用右」，或直接接受自动合好的结果。',
  /**
   * adj966f（P2）：**两边都改了、但改动互不重叠**时的确认条正文（用户口径原文："已自动合好"）。
   *
   * 这种情形不必逐块问：块级采纳（P1）已经能把"只有一边改过"的块自动合干净，
   * 剩下的只是让用户看一眼并落盘。文案里必须说清两件事，否则用户不敢点：
   *  ① **以本地为底**（口径③）—— 本地改动都在，外部改动只补进没打架的地方；
   *  ② 未被采纳/未合进来的外部内容**不会被写进文件**（负向判据 ③ 守的就是这句）。
   */
  mergedAskText: (name: string, blocks: number) =>
    `「${name}」两边都改了，但改动**互不重叠**（${blocks} 块）——已经自动合好：以本地为底，` +
    '外部只补进没打架的地方。点「应用」即写回文件；也可以先「查看差异」逐块确认。',
  /** 确认条上那个"直接应用合并结果"的按钮（与差异框底部的「应用（并保存）」同一件事） */
  applyMergeShort: '应用',
  /** 主按钮：用磁盘（外部）内容替换当前编辑 */
  loadExternal: '载入外部',
  /** 次按钮：保留当前编辑 */
  keepLocal: '保留本地',
  /** 第三个按钮：打开两栏差异框（不替用户做决定） */
  viewDiff: '查看差异',
  /** 差异框标题（拼上文件名） */
  diffTitle: (name: string) => `文件内容差异 — ${name}`,
  /** 左栏：本地（正在编辑的这份） */
  leftTitle: '本地（正在编辑的这份）',
  /** 右栏：外部（文件里现在的内容） */
  rightTitle: '外部（文件里的新内容）',
  /** 顶部摘要：行数 + 改动处数 */
  summary: (localLines: number, externalLines: number, changes: number) =>
    `本地 ${localLines} 行 · 外部 ${externalLines} 行 · 改动 ${changes} 处`,
  /** 超长输入退化为"只标改动区块"时的提示 */
  degradedHint: '内容较长：只标出改动区块，未做行内字符级高亮',
  /** 折叠行提示 */
  collapsed: (n: number) => `… 折叠 ${n} 行相同内容 …`,
  /** 展开全部 */
  expandAll: '展开全部',
  /** 只看改动（收起） */
  collapseToChanges: '只看改动',
  /** 关闭差异框，回到原来的确认条 */
  closeDiff: '关闭',
  /**
   * adj966f（P1 块级采纳 + P2 自动三路合并）：差异框里的**逐块决定**文案。
   *
   * 用户 2026-10-16 拍板：按钮就叫「**用左 / 用右**」（不再另起名词——栏目标题
   * `leftTitle`/`rightTitle` 已经写明"左 = 本地（正在编辑的这份）、右 = 外部（文件里的新内容）"）。
   * 合并**以本地为底**：没点过的块用它的默认选择（只有外部一方改过的块默认用外部）。
   */
  useLeft: '用左',
  useRight: '用右',
  /** 顶部批量按钮：把每一块都设成用左 / 用右 */
  useAllLeft: '全用左',
  useAllRight: '全用右',
  /** 底部主按钮：按逐块选择拼出合并文本、写回文件并立刻保存（口径④） */
  applyMerge: '应用（并保存）',
  /** 块的序号标签（逐块决定时按它对照两栏） */
  blockLabel: (n: number) => `第 ${n} 块`,
  /** 冲突块（两边改了同一块）——必须用户选，不许自动合并吞掉（负向判据 ①） */
  blockConflict: '冲突：两边都改了同一块',
  /** 只有本地改过的块（自动保留本地） */
  blockLocalOnly: '只有本地改过 · 已保留本地',
  /** 只有外部改过的块（自动采用外部）——P2 的"互不重叠"就是它 */
  blockExternalOnly: '只有外部改过 · 已采用外部',
  /** 二路模式（没有共同祖先）的块：分不清谁改的，只能逐块问 */
  blockManual: '没有共同祖先：请选择用哪一边',
  /** 摘要行追加：冲突块数 */
  mergeConflicts: (n: number) => `· 冲突 ${n} 块（请选「用左 / 用右」）`,
  /** 摘要行追加：已自动合好的块数 */
  mergeAuto: (n: number) => `· 互不重叠 ${n} 块（已自动合并）`,
} as const

/**
 * adj966：**网页版 / PWA 的「持久权限」引导**（用户口径：把权限选择交给用户）。
 *
 * 背景（官方行为，见 `docs/FILE-MODEL.md` §3）：Chrome 122 起文件提示是三选一 ——
 * 「仅此次」/「每次访问都允许」/「不允许」；选「**每次访问都允许**」之后，这个站点对该文件
 * **无需手势、跨会话**可读写；选「仅此次」（默认）则权限**只活到该 origin 最后一个标签页关闭**为止
 * ⇒ 下次打开要重新授权、也不能自动写回。
 *
 * 口径：**只提示一次**、说清"不选会怎样"、不阻断任何操作；用户不选也能正常用（降级为草稿 + 手动保存）。
 */
export const persistPermissionCopy = {
  /** 顶部提示正文（`name` = 刚打开的文件名） */
  notice: (name: string) =>
    `「${name}」已打开。想以后**免手点保存**、并在文件被同步端改动时自动发现，` +
    '请在权限气泡里选「每次访问都允许」；选「仅此次」也可以，只是关掉标签页后要重新授权，期间编辑内容先存在草稿里。',
  /** 提示级别：`ok`（是告知，不是错误也不是警告；`showNotice` 只接受 ok/warn/error） */
  level: 'ok',
} as const

/**
 * adj968（用户要求）：**把 `.jps` 从文件管理器拖进应用就能打开**的文案。
 *
 * 两端的机制不同（网页 = HTML5 拖放 + 可写句柄；桌面 = Tauri 原生拖放 + 真实路径），
 * 但**给用户看到的话必须一套**（与文件模型那条总口径一致：差别只在能力，不在交互）。
 */
export const dropOpenCopy = {
  /** 覆盖层主句（已经知道文件名时） */
  releaseToOpen: (name: string) => `松开即打开「${name}」`,
  /** 覆盖层主句（只知道拖的是文件、名字还读不到时） */
  releaseGeneric: '松开即打开乐谱（.jps）',
  /** 覆盖层副句：说明拖进来的东西会替换当前文档 */
  overlayHint: '会替换当前正在编辑的文档',
  /** 一个 `.jps` 都没认出来（拖了图片/压缩包等）——只提示，不做任何事 */
  onlyJps: (ignored: number) => `拖入的文件里没有 .jps 乐谱（另有 ${ignored} 个其它文件已忽略）`,
  /** 一次拖了多个 `.jps`：只打开第一个，其余如实报数（与双击多选同一口径 `pickPrimary`） */
  extraIgnored: (n: number) => `（另有 ${n} 个 .jps 未打开；一次拖放只打开第一个）`,
  /** 打开失败（句柄/文件读不出来） */
  failed: (reason: string) => `拖入的文件打不开：${reason}`,
  /** 拖入的是"只读"档（没有可写句柄）：说清它不会被写回，保存请走另存为 */
  uploadedReadOnly: (name: string) => `已载入「${name}」（本端拿不到可写句柄 ⇒ 保存请用「另存为」）`,
  /**
   * 当前文档有未保存修改时的确认句（与「新建」那套确认条同一实现）。
   * 拖入是**替换文档**的动作 ⇒ 必须让用户自己决定，绝不静默丢编辑。
   */
  replaceDirtyAsk: (name: string) =>
    `当前文档有未保存的修改。打开「${name}」会替换这些修改（磁盘上的原文件不受影响），确定要打开吗？`,
  replaceDirtyConfirm: '打开并替换',
  replaceDirtyCancel: '取消',
} as const

/**
 * adj944（用户需求，2026-10 原话）：「需要在全局设置里添加一个注册 iJipu CLI 的提示和按钮，
 * 未注册时显示「注册」，已注册时显示「解除」；**只有注册后，才能在打开终端时就能 `ijipu cli`**」。
 *
 * 口径（用户要求逐条落在这里；**adj946 改**）：
 *  · 「注册」= 把**命令行入口目录 `<安装目录>\bin`** 写进**当前用户**的 PATH ——
 *    **不是安装目录本身** ✗：`ijipu.exe` 是 GUI 子系统程序，cmd **不等它**（提示符会夹在输出中间、
 *    退出码拿不到、PowerShell 的 `>` 写出 0 字节文件，用户截图实报）；`bin\ijipu.cmd` 是**控制台垫片**，
 *    cmd **会等批处理文件** ⇒ 输出顺序/退出码/重定向一次修好，而双击 `.jps` 照旧不闪黑框 ✓；
 *  · 状态**读系统实况**（现读 `HKCU\Environment\Path`）⇒ 用户手动改过 PATH 也如实反映 ✓；
 *  · 两条提示必须写清：① **注册后要新开一个终端**才生效（老终端看不到）；
 *    ② **仅对当前用户生效、不需要管理员** ✓；
 *  · **旧形态**（adj944 曾把安装目录本身写进 PATH）要能识别 + 顺手换掉（否则它会跟垫片抢 `ijipu` ✗）；
 *  · 失败要把**原因**显示出来（不是笼统"失败了" ✗）。
 */
export const cliPathCopy = {
  /** 底栏「全局」里的子页签名（与「版面/主题/音色库」并列） */
  tabLabel: '命令行',
  /** 组标题 */
  groupTitle: '注册到命令行',
  /** 一行说明：注册之后到底能得到什么（并点明"注册的是 bin 目录"这个关键口径） */
  intro:
    '将 iJipu 的命令行入口目录（安装目录下的 bin）加入当前用户的 PATH，' +
    '之后即可在终端直接调用 ijipu cli …（例如 ijipu cli lint 我的谱.jps），无需输入完整路径。' +
    '该目录中为控制台垫片 ijipu.cmd：输出顺序、退出码与重定向均正常，双击 .jps 仍打开界面。',
  /**
   * 提示①（用户指定必须写清）：新终端才生效。
   * adj947：顺手把"拿什么验证"写进去 —— 形态必须带 `cli`
   * （用户实报：`--help` 的用法行漏了 `cli`，照它敲 `ijipu lint …` 会打开图形界面 ✗）。
   *
   * adj965（用户指正）：这段与 `legacyHint` 一样是**纯文本**渲染（`PageConfigDialog` 的 `.pcfg-note`），
   * 所以**一律不写 `**加粗**`** —— 那会原样显示成星号（同族闸门见 `adj605` 的图例探针）。
   */
  hintNewTerminal:
    '注册后需新开终端方可生效，已打开的终端不会读到新的 PATH。可在新终端执行 ijipu cli --version 确认。',
  /** 提示②（用户指定必须写清）：只对当前用户生效、不用管理员；adj947 同样点明形态带 `cli` */
  hintCurrentUser:
    '仅对当前用户生效，无需管理员权限（不写系统级 PATH，不影响其他用户）。' +
    '命令形态为 ijipu cli …：第一个参数必须是 cli，否则将打开图形界面。',
  /** 注册状态：已注册 */
  statusRegistered: '已注册',
  /** 注册状态：未注册 */
  statusNotRegistered: '未注册',
  /** 注册状态：还没读到（首次进入页签） */
  statusLoading: '读取中…',
  /** 注册状态：网页版没有这个能力（如实说明，不假装可用） */
  statusWebOnly: '网页版不支持（需读写当前用户的 PATH，仅桌面版可用）',
  /** 状态行标签 */
  statusLabel: '当前状态',
  /** 安装目录标签（只作显示；真正进 PATH 的是下面的命令行入口目录） */
  installDirLabel: '安装目录',
  /** 命令行入口目录标签（adj946：**写进 PATH 的就是它**） */
  binDirLabel: '命令行入口目录（即将写入 PATH）',
  /**
   * adj946：PATH 里还留着**旧的注册形态**（安装目录本身，adj944 的口径）。
   * 必须说出来 —— 它通常排在前面，会把 `ijipu` 抢回成 `ijipu.exe`（于是又变回用户实报的症状 ✗）；
   * 点一次「注册」就会把它换成命令行入口目录 ✓。
   */
  legacyHint:
    '⚠ 检测到旧注册形态：PATH 中仍有一条安装目录本身（由旧版本写入）。' +
    '它会先于 bin 中的垫片匹配到 ijipu；点一次「注册」即可换为命令行入口目录，其余条目不变。',
  /** PATH 用量（离上限还有多远） */
  pathUsage: (n: number, limit: number) => `当前用户 PATH：${n} / ${limit} 字符`,
  /** App Paths（可选便利）标签 */
  appPathsLabel: 'App Paths',
  /** App Paths 未注册 */
  appPathsNone: '（未注册）',
  /** 按钮：注册（未注册时） */
  registerButton: '注册',
  /** 按钮：解除（已注册时） */
  unregisterButton: '解除',
  /** 按钮忙碌态 */
  busyRegister: '注册中…',
  busyUnregister: '解除中…',
  /** 重新读一次系统实况（用户可能刚在"环境变量"里手改过 ⇒ 要有这条出路） */
  refresh: '重新读取',
  /**
   * adj957（用户裁定）：原先这里有 `manualLabel` / `manualButton` / `manualBusy` / `manualTip` /
   * `manualOpened` / `manualWebOnly` / `manualFailed` 一组文案，对应「查看 CLI 手册」那个
   * **用系统默认程序打开随包 MD** 的按钮。整组已删除，原因两条：
   *  ① Windows **默认没有 `.md` 关联程序**，那个按钮在多数机器上会弹「你要如何打开此文件」；
   *  ② 命令行手册现在与操作手册/语法说明同路 —— 走**应用内 `DocDialog`**（顶栏「帮助 → 命令行手册」），
   *     不依赖外部关联，也让三本手册的开法终于一致。
   */
  /** 操作成功：注册（`changed=false` = 本来就有；`dir` = **命令行入口目录**，不是安装目录 ✓） */
  okRegistered: (dir: string, changed: boolean) =>
    changed
      ? `已注册 ✓ 命令行入口目录已加入当前用户 PATH：${dir}`
      : `本来就是已注册状态 ✓（PATH 里已有这一条，未重复写入）：${dir}`,
  /** 操作成功：解除（`changed=false` = 本来就没有；`dir` = **命令行入口目录**） */
  okUnregistered: (dir: string, changed: boolean) =>
    changed
      ? `已解除 ✓ 已从当前用户 PATH 里摘掉：${dir}（其余条目逐字未动）`
      : `本来就是未注册状态 ✓（PATH 里没有这一条，未改动）：${dir}`,
  /** 失败前缀（后面接**原因原文**） */
  failed: (reason: string) => `操作失败：${reason}`,
  /** PATH 超长的可执行建议（用户要求：超长 ⇒ 不写、明确报错、给出可执行建议 ✓） */
  tooLong: (length: number, limit: number) =>
    `注册后当前用户 PATH 会有 ${length} 字符，超过上限 ${limit} ⇒ 未写入（PATH 一个字都没改）。` +
    '建议：① 先在「系统属性 → 环境变量」里删掉 PATH 中已经不存在的目录（反复装卸的软件常留一堆）；' +
    '② 或把 iJipu 装到更短的路径（例如 C:\\iJipu）后再注册；' +
    '③ 也可以不动 PATH，直接用完整路径调用：<安装目录>\\bin\\ijipu.cmd cli lint 我的谱.jps',
} as const

/**
 * 水印层 / 背景层（adj965，方案 `docs/OVERLAY-PLAN.md`「OVL」）的面向用户文案。
 *
 * 写法遵循本项目口径：**正式、规范、简洁**（用户 2026-10-15 指正过一版口语化文案）。
 * 具体到这几条：
 *   · 开关后的说明用**陈述句**（"勾上会做什么"），与既有开关同一句式
 *     （既有例：`在小节线下方显示带方框的小节序号`），不写"不勾选＝…"这类口语与符号；
 *   · 说明段用 `；` 分层、`「」` 引用界面元素，避免括号套括号；
 *   · 错误信息写成"现象 + 可照做的处置"，不暴露内部文档路径（那是给维护者看的）。
 */
export const overlayCopy = {
  // ---- 开关（紧跟行标签的短陈述句） ----
  wmEnableDesc: '在谱面上叠加水印层',
  bgEnableDesc: '在谱面下垫入背景图',
  wmRepeatDesc: '按行列间隔平铺整页',
  // ---- 输入框占位 ----
  wmTextPlaceholder: '水印文字',
  imagePathPlaceholder: '相对本谱的路径，或 [[双链]]',
  // ---- 说明段 ----
  wmNote:
    '图形宽度以页宽为准（100 即撑满页宽，高度按原图比例）；文本字号以 pt 计。' +
    '位置为水印中心相对页面中心的偏移，X、Y 为 0 时居中；透明度 100 为完全不透明。',
  bgNote:
    '背景仅在页面内显示，超出部分裁去；宽度以页宽为准（100 即撑满页宽，高度按原图比例），' +
    '位置为图片中心相对页面中心的偏移，X、Y 为 0 时居中。' +
    '图片按相对本谱的路径读取，因此分享本谱时须同时提供图片文件。',
  /** 解析失败的提示前缀（后面接具体原因） */
  wmErrorPrefix: '水印图：',
  bgErrorPrefix: '背景图：',
  /**
   * 开关**关着但路径已填**时的说明（用户 2026-10-15 实报"背景没有显示"）。
   *
   * 为什么必须有：总开关默认关（用户裁定），而关着时我**连解析都不做** ⇒ 不产生任何提示。
   * 于是"填了路径 + 没勾开关"在界面上就是**静默不显示**，看起来像功能坏了 ✗。
   * 这一行把它说出来（不是错误，是提示）。
   */
  wmDisabledHint: '未启用水印：本谱不绘制水印层，勾选上方「启用水印」后生效。',
  bgDisabledHint: '未启用背景：本谱不绘制背景，勾选上方「启用背景」后生效。',
  // ---- 预览区的手势提示与「调整对象」切换器（adj965d，EP-13） ----
  /**
   * 两层的名字。**设置面板的两个子页签标签也用这两条**（`PageConfigDialog` 的 `ALL_TABS`）——
   * "水印/背景"这层身份只有一个出处，免得两处各写一份、改一处漏一处。
   */
  layerWm: '水印',
  layerBg: '背景',
  /** 标题：两层都可用 ⇒ 给一个切换器；只有一层可用 ⇒ 直接点名（用户口径：单一层不显示切换器） */
  editTargetTitle: '调整对象',
  editTargetOne: (layer: string) => `调整${layer}`,
  /** 手势说明（一行纯文本；键位是用户 2026-10-15 终裁的 Alt 一族，见方案裁定记录 9） */
  gestureKeys: 'Alt+滚轮 缩放 · Alt+Shift+滚轮 旋转 · Alt+拖动 平移',
  /**
   * 该层**还没写进谱面**时的提醒（用户 2026-10-15 要求"加一层保险"）。
   *
   * 只在设置面板里勾了开关时，这一层只活在草稿里：**除手势以外**的任何动作都可能让它消失
   * （在编辑器里打字、刷新、宿主整页重载都会让生效配置重新从源码派生），
   * 所以当面把话说清楚，并给出两个能立刻做的动作。
   */
  notInScore: '尚未写入谱面：点「保存设置」固化，或直接用手势调整（会自动写入）',
  // ---- adj969：**用文件方式打开的谱**（浏览器不给文件句柄的父目录）----
  /**
   * 现象 + 处置（用户口径：错误信息要能照着做）。
   *
   * 为什么必须点名"浏览器不给父目录"：不然用户看到"图找不到"会去翻图片路径有没有写错，
   * 而真正缺的是**一次文件夹授权**。
   */
  errNeedDirAuth: (name: string) =>
    `这份谱是用文件方式打开的（${name}）：浏览器不提供文件所在目录，因此无法按相对路径取图。` +
    '请点下方「授权所在文件夹」选定它所在的目录（只需一次，之后会自动记住）。',
  /** 设置页签里那个按钮的标签（缺目录授权时才出现） */
  authDirButton: '授权所在文件夹',
  /**
   * adj969：打开谱之后**顶部确认条**上问的那一句。
   *
   * 为什么不直接弹文件夹对话框：`showOpenFilePicker()` 已经把"用户手势"用掉了
   * （`verify:app-ui` 实测 `navigator.userActivation.isActive === false`）⇒ 直接弹只会被浏览器拒。
   * 所以"问"是自动的，**弹对话框那一下交给用户点**（点按钮 = 新的合法手势）。
   */
  assetDirAsk: (name: string) =>
    `「${name}」用了相对路径的图片，但它是用文件方式打开的：浏览器不提供文件所在目录，无法按相对路径取图。` +
    '选择它所在的文件夹即可读取（只需一次，之后会自动记住）。',
  /** 确认条上的「暂不」（提示仍留在设置页签里，随时可以补授权） */
  assetDirLater: '暂不',
  /**
   * adj979（**用户 2026-10-18 实报 + 拍板**）：谱和背景图放在**桌面 / 文档 / 下载**里时，
   * 浏览器（Chromium）**直接禁止**授权这三个目录 —— 与"用户取消"是同一个错误，区分不出来，
   * 所以表现为"点了没反应、图就是不显示"。用户原话：「这样可以告诉用户**为什么**不显示」。
   *
   * @param name 这份谱的文件名
   * @param dir 命中的目录名（「桌面」/「文档」/「下载」）
   */
  assetDirSensitiveAsk: (name: string, dir: string) =>
    `「${name}」用了相对路径的图片，但它放在「${dir}」里：浏览器（Chromium）不允许网页授权` +
    '桌面 / 文档 / 下载这三个目录，所以点「授权所在文件夹」不会有反应、背景图就是读不出来。' +
    '要看到图，请把谱和图片一起放到别的文件夹（例如新建一个曲谱文件夹），或者改用工作区。',
  /** 上面那条的按钮（只是"知道了"：这一档没有可点的系统对话框，别给个按了会失败的按钮） */
  assetDirSensitiveOk: '知道了',
  /** 上面那条的次按钮：直接打开底栏的「工作区」面板（那是可用的替代路径） */
  assetDirSensitiveSwitch: '改用工作区',
  /** 设置页签里那个按钮在本档下的提示（比确认条短，只留结论与出路） */
  authDirSensitive: (dir: string) =>
    `这个目录（${dir}）浏览器不让授权：请把谱和图片放到别的文件夹，或改用工作区。`,
  /** 授权进行中（选择器已弹出） */
  authDirBusy: '请在系统对话框里选择这份谱所在的文件夹…',
  /** 授权成功（图会立刻重新解析） */
  authDirOk: (dir: string) => `已授权文件夹「${dir}」，正在重新读取图片。`,
  /** 用户取消（不算错误，如实说一句，别让人以为点了没反应） */
  authDirCanceled:
    '已取消授权：背景图 / 水印图仍无法按相对路径读取。' +
    '（注意：如果谱放在桌面 / 文档 / 下载里，浏览器不允许授权这三个目录 —— 那种情况请把谱和图片换个文件夹，或改用工作区。）',
  /**
   * 选的文件夹里**没有这份谱**（或不是同一份）⇒ 明确说"选错了"，不要拿去读图。
   *
   * 这是本功能的**安全判据**：网页层拿不到任何路径，只能靠"同名 + 同字节数 + 同修改时间"
   * 反证"这个目录就是这份谱所在的目录"。核不过就宁可不显示，也不去另一个目录里读同名文件。
   */
  authDirMismatch: (name: string) =>
    `所选文件夹里没有找到这份谱（${name}）；请选择本谱真正所在的目录。`,
  /** 环境根本没有选文件夹的能力（浏览器不支持，或处在跨源子框架里） */
  authDirUnsupported: '当前环境不支持选择文件夹，无法按相对路径读取图片。',
  /** 选择器本身报错（内核策略等）——如实说，别让用户以为是"图坏了" */
  authDirFailed: '打开文件夹选择器失败：本环境不允许选择该目录，背景图 / 水印图仍无法读取。',
  // ---- 解析失败原因（都要能照着做） ----
  errEmptyPath: '图片路径为空',
  errLinkNotSupported: '[[…]] 双链仅在 Obsidian 插件内可用；此处请填写相对本谱的路径',
  errUnsupportedType: (path: string) => `仅支持 png / jpg / jpeg / webp / gif / bmp 图片：${path}`,
  errNotSaved: '本谱尚未保存为文件，无法按相对路径读取图片；请先保存本谱，或改用 data: 内嵌',
  errNoChannel: '当前环境不支持读取图片',
  errReadFailed: (reason: string) => `读取图片失败：${reason}`,
  errNotFound: (path: string) => `未找到图片：${path}`,
  errTooLarge: (mb: number, path: string) => `图片超过 ${mb}MB 上限：${path}`,
  errDecodeFailed: (reason: string) => `图片解码失败（可能不是有效图片）：${reason}`,
} as const

/**
 * 设置面板（全局设置 / 谱面设置两个底栏页签）里的**成句文案**。
 *
 * 为什么单列一组：这两半面板的**短标签**（纸张、边距、旋转…）按本文件既有做法留在组件里
 * （与「乐器显示」「歌词压缩」等行一致），而成句的说明/提示集中在这里 —— 它们最容易被写口语。
 *
 * 写法遵循项目口径：**正式、规范、简洁**，并且**不写 `**加粗**`**
 * （这些字串都是纯文本渲染，星号会原样显示；闸门见 `adj965` 的"文案里不许出现 Markdown 标记"）。
 */
export const settingsCopy = {
  /**
   * 「全局 → 版面」页签底部说明：说清这一页的设置存在哪里
   * （原文写的是"以上为**本机偏好**（L1）"，既带字面星号、又把内部层级代号 L1 露给了用户）
   */
  hostPrefNote: '以上为本机偏好，不随谱保存；谱面字体请在「谱面设置 → 字体」中设置，随谱保存。',
  /** 字体覆盖开启时的提示（该覆盖不随谱走 ⇒ 分享前应关闭） */
  fontOverrideOn: '⚠ 字体覆盖已开启，显示的字体与他人不同（该项不随谱保存）；分享谱面前建议关闭。',
  /** 谱面设置底部图例：解释红色 `*` 的含义（两句都渲染在面板上，改一处要改两处） */
  defLegend: '与默认值不同，点「保存设置」后将写入本谱的设置行（# jps-config）。',
  /** 红色 `*` 本身的悬浮提示（比图例更短） */
  defMarkTitle: '与默认值不同：保存后将写入本谱的设置行（# jps-config）',
  /** 「保存设置」按钮的悬浮提示 */
  saveConfigTitle:
    '将本次改动写入本谱的设置行（# jps-config），仅记录与默认值不同的项；本谱因此自包含，复制给他人后显示一致。',
} as const

/**
 * 动态谱预览文案（adj1031：视频出片的第一步，先只验画面）
 *
 * 为什么单独一组：这块还要长出「导出视频」（参数、进度、取消），文案会跟导出面板一样多，
 * 先集中在这里，别散进组件。
 */
export const dynamicVideoCopy = {
  title: '动态谱视频',
  presetLabel: '画布',
  cardStyle: '卡片',
  /* ---- adj1113：是否带片头片尾（默认带；不勾 = 只导出动态谱） ----
   * adj1116（用户口径）：界面上**只留复选框**，不要文字标签 —— 这一句放悬浮提示里，
   * `cards` 仍留作 aria-label（读屏与自动化测试要靠它认出这个复选框是干什么的）。 */
  cards: '带片头片尾',
  cardsHint:
    '带片头片尾：勾选时成片带片头卡与片尾落版；不勾只导出动态谱，画面直接从第一拍开始（预览与导出同一口径）。',
  cardsOffHint: '不导出片头片尾，只导出动态谱',
  /** adj1176：卡片下拉的分组与「管理模板…」入口 */
  cardBuiltin: '内置模板',
  cardMine: '我的模板',
  cardManage: '管理模板…',
  shortLabel: '短链',
  shortHint: '从乐谱库工具复制完整短链粘贴到这里，例如 https://ijipu.pages.dev/s/y805；留空则片尾不显示',
  play: '播放',
  pause: '暂停',
  reload: '重新载入当前谱',
  preparing: '正在准备画面…',
  preparingAudio: '正在准备声音…',
  previewAudioFailed: '预览声音渲染失败，画面继续静音',
  empty: '这份谱没有可播放的音符',
  audioHint: '带声音需要音色库（首次约 30MB）',
  /* ---- adj1150：相机位"输出声音"（与对拍台同一份 mix，存 sidecar） ---- */
  outputSound: '输出声音',
  outputSoundHint:
    '决定预览与成片用哪条声音：伴奏（对拍文件里的音频）/ 伴奏+合成 / 合成音；两条音量各自 0–200%。改完重新播放或生成即生效。',
  outputSoundNoAudio: '伴奏还没加载',
  /* ---- adj1164：相机位音色（默认自动随谱；不跟试听里的音色选择绑定） ---- */
  instrumentLabel: '音色',
  instrumentAuto: '自动（随谱）',
  instrumentHint:
    '自动：按谱面 Y: 与 @乐器名@ 的音色；选具体音色则全篇统一（所有声部、伴奏层与曲内切换都用它）。只影响声音与色块配色，不改谱面。这里的选择与试听里的音色互不影响。',
  pickAccompaniment: '加载伴奏…',
  audioLoaded: '伴奏已加载（保留段不变）',
  audioLoadFailed: '伴奏加载失败',
  overCap: '这首超过 3 分钟：导出前 3 分钟（含片头与片尾），画面与声音一起截断',
  capping: '正在把音乐裁到 3 分钟内（保留片头与片尾）…',
  exportMp4: '生成视频',
  /** adj1183：导出成功提示 + 打开文件/文件夹 */
  exportedVideo: (path: string) => `视频已导出：${path}`,
  exportedWeb: '视频已开始下载（浏览器会在下载完成后提示）',
  exportCanceled: '已取消导出（没有保存文件）',
  openFile: '打开文件',
  openFolder: '打开文件夹',
  exportDoneClose: '收起',
  openFailed: (reason: string) => `打不开：${reason}`,
  desktopOnly: '生成视频仅桌面版可用（网站/插件暂不开放）',
  mode3min: '3 分钟',
  modeFull: '整首',
  rangeAll: '整曲',
  rangeSegment: '标记段',
  /** adj1165：sidecar 里的段已不在练习段列表时，下拉里保留一个只读项 */
  rangeUnlisted: '当前段（不在列表）',
  /* ---- adj1089：行中平移方式（设置 → 本机） ---- */
  panModeGroup: '动态视频',
  panModeLabel: '平移方式',
  panModeFollow: '跟随（4/5→1/5）',
  panModeBeat: '按拍',
  panModeBar: '按小节',
  panModeHint:
    '跟随：色块到画面右侧 4/5 才推，一次推到左 1/5；按拍/按小节：每拍/每小节把色块放到画面中间。三种方式都保证行首、行末的左右露白不超过画面 10%（整行放得下时直接居中、不平移）。本机偏好，不随谱保存。',
  /* ---- adj1094：行末提前平移量（设置 → 本机） ---- */
  rowLeadLabel: '行末提前',
  rowLead0: '0 拍（行首那一下才换行）',
  rowLead05: '0.5 拍（默认）',
  rowLead1: '1 拍',
  rowLead15: '1.5 拍',
  rowLead2: '2 拍',
  rowLeadHint:
    '三种平移方式共用：换到下一行提前这么多拍完成，好提前看到下一行的开头；0 = 正好在行首那一下换行（旧行为）。',
} as const

/**
 * adj1074 / adj1176：卡片模板库与卡片风格对话框
 *
 * adj1176（用户 2026-11-01）：从"一个自定义槽位"改成"可命名的模板库"——
 * 新增/保存/另存为/删除/导入到库，相机位下拉里直接选。
 */
export const cardStyleCopy = {
  title: '卡片模板',
  intro:
    '片头/片尾卡片的样式；模板集中保存在本机配置里（设置 → 本机配置可备份/打开配置目录），每首谱只记用哪套。',
  library: '我的模板',
  builtin: '内置模板（只读）',
  newTemplate: '新建模板',
  saveAs: '另存为副本',
  deleteTemplate: '删除',
  deleteConfirm: (name: string) => `删除模板「${name}」？\n\n已经用它导出过的谱不受影响；其它谱再打开时会提示"本机没有这套模板"。`,
  nameLabel: '模板名称',
  namePlaceholder: '例如：赤伶-水墨金',
  nameHint: '名称只用于在下拉里认出这套模板。',
  current: '正在编辑',
  noTemplates: '还没有自己的模板：调好样式后点「保存模板」即可加进列表。',
  openConfigDir: '打开配置目录',
  openConfigDirFailed: '打不开配置目录：',
  saveTemplate: '保存模板',
  base: '起点模板',
  font: '标题字体',
  fontScore: '跟谱面标题',
  fontSerif: '衬线（宋体）',
  fontSans: '无衬线',
  localFont: '本机字体',
  localFontPlaceholder: '留空 = 用上面的预设；可输入已安装的字体名',
  localFontHint: '默认列表只是常见字体提示，不是你电脑上的全部字体；点「读取本机字体」才会读系统列表。',
  localFontManual: '系统里没列出来也能直接输入字体名：中文名或英文名都可以，但必须和字体族名一致。',
  loadLocalFonts: '读取本机字体',
  localFontsLoaded: (n: number) => `已读到 ${n} 个本机字体（已并入常见字体提示）`,
  localFontsUnavailable: '当前环境读不到系统字体列表（桌面 WebView 可能没开放这个接口）；直接输入字体名仍然能生效。',
  fontHint: '水印与印章也可以单独选字体；「本机字体」有值时优先于上面的预设。',
  background: '背景',
  bgTop: '上',
  bgMid: '中',
  bgBottom: '下',
  accent: '强调色 / 横线',
  titleFrom: '标题起色',
  titleTo: '标题止色',
  textColors: '文字',
  subtitle: '副标题 / 标语',
  author: '作者',
  info: '调号 / 速度',
  brand: '品牌小字',
  url: '网址',
  watermark: '水印',
  watermarkIntro: '片头字',
  watermarkEnd: '片尾字',
  watermarkColor: '水印色',
  watermarkAlpha: '透明度',
  watermarkScale: '大小',
  watermarkFont: '水印字体',
  watermarkHint: '可以写多个字（最多 12 个）：长文字会自动收字号，不会溢出画面。',
  effects: '效果',
  particles: '粒子',
  sweep: '扫光',
  staffAlpha: '五线谱透明度',
  vignette: '暗角',
  motion: '动效（淡入/展开）',
  seal: '朱砂印章',
  sealText: '印章文字',
  sealFont: '印章字体',
  sealHint: '最多 6 个字，竖排；外框是贴合文字的不规则弧线（单字近方、多字竖长），不再用椭圆。',
  sealColor: '印章色',
  /** adj1186：朱砂印章右侧效果预览 */
  sealEffect: '效果预览',
  sealEffectOff: '勾选或选图后显示',
  chooseSealImage: '选择印章图片',
  clearSealImage: '清除印章图片',
  sealImageHint:
    '有图片时优先画图片（≤2.5MB，按原比例）；没有图片才画上面的文字。图片建议用透明底 PNG。',
  sealSize: '印章大小',
  sealX: '印章左右',
  sealY: '印章上下',
  sealPosHint: '大小以画面短边的 12% 为基准；左右/上下是印章中心在画面里的相对位置（0=左/上，1=右/下）。',
  backgroundImage: '背景图片',
  chooseImage: '选择图片',
  clearImage: '清除图片',
  imageHint: '≤2.5MB；会自动压一层主题色，保证标题可读',
  imageTooLarge: '图片不能超过 2.5MB',
  imagePosX: '左右',
  imagePosY: '上下',
  imageZoom: '放大',
  imagePosHint: '拖动预览图（或下面的滑块）调整取景：左右 0=左缘、100=右缘；上下同理；放大在铺满的基础上再放大。',
  migrate: '模板导入 / 导出',
  exportZip: '导出这套模板…',
  importZip: '导入模板 zip（加入我的模板）',
  migrateHint: '导出的 zip 含样式与背景图，可发给别人；导入后会直接加进「我的模板」并选中。',
  imported: '已导入到我的模板',
  importedUnsaved: '模板已导入本次会话，但写入本机配置失败（存储可能已满）',
  exported: '已导出模板',
  cancelled: '已取消',
  save: '保存模板',
  cancel: '取消',
  reset: '从当前起点重来',
  resetAll: '恢复品牌模板',
  saved: '已保存到我的模板',
  savedOk: (name: string) => `已保存模板「${name}」`,
  saveFailed: (name: string) =>
    `模板「${name}」只保存在本次会话：写入本机配置失败（存储可能已满或被浏览器禁用）`,
  deleted: (name: string) => `已删除模板「${name}」`,
  exportFailed: '导出失败',
  importFailed: '导入失败',
} as const

/**
 * adj1119：**对拍台**的全部文案（集中在这里，组件里不写字面量——AGENTS 四·2）。
 */
export const syncCopy = {
  title: '对拍（伴奏对齐）',
  /** 非桌面端（网站/插件）即便绕过入口进来也只显示这一行 */
  desktopOnly: '对拍要在桌面版里做（解码音频、写 sidecar 都需要桌面能力）',
  /** 相机位上的入口按钮（短） */
  syncOpen: '对拍…',
  /** 相机位上状态前缀：`对拍 ♩=96` */
  syncBadge: '对拍',
  audioLabel: '伴奏',
  pickAudio: '选择伴奏…',
  repickAudio: '换一条…',
  noAudio: '还没选伴奏：点「选择伴奏…」挑一个 mp3 / m4a / wav',
  /** adj1176：sidecar 里记的卡片模板本机没有（别人发来的谱 / 模板删了） */
  cardTemplateMissing: (id: string) => `这本谱记的卡片模板（${id}）在本机没有，先按当前模板显示；导入模板 zip 后可恢复。`,
  audioMissing: '找不到上次那条伴奏，请重新选择',
  decoding: '正在解码…',
  decodeFailed: '这个文件解不开，换 mp3 / wav / m4a 试试',
  tipPick: '按空格播放，听到要打的那一下按 T',
  /** adj1140：波形上沿蓝字是小节号（用户问过一次，写成常驻提示） */
  barLabelHint: '上沿蓝字=小节号',
  anchors: '锚点',
  noAnchors: '还没有锚点：播到能确认的那一拍按 T',
  /** adj1136：单锚点推出的"谱面起点在音频 0 之前"不可能结论 */
  anchorImplausible: (beats: string, span: string) =>
    `这条锚点等于说"前 ${beats} 拍只用了 ${span}"，谱面第 1 拍会被推到音频 0 之前。拍号填错了？还是伴奏有前奏？再打一条锚点才能定速度。`,
  /** adj1137：波形上面那条音符格子排 */
  stripHint: '音符格子排：每格一个主音符、宽度=时值；点一格就跳到那个音（与波形同步缩放）',
  /** adj1139：伴奏比谱面长时，谱面开始之前那段 */
  headWaitLabel: '前奏（等谱面开始）',
  headWaitNote: (span: string) => `开头 ${span} 是前奏：球停在第一个音，等谱面开始`,
  /** adj1139：两条"快捷对齐"按钮（两种长度不一致的落地入口） */
  quickAlignTitle: '快捷对齐',
  quickAlignHeadWait: '谱面第 1 拍 = 当前播放头',
  quickAlignHeadWaitHint: '伴奏前面还有一段前奏时用：谱面第 1 拍从当前位置开始，之前那段球停在第一个音',
  quickAlignSkip: '0 秒 = 谱面',
  quickAlignSkipHint: '谱面比伴奏长、开头几拍要跳过时用：把音频 0 秒对齐到指定的小节:拍',
  quickAlignHeadWaitDone: (span: string) => `已把谱面第 1 拍对齐到 ${span}（之前那段算前奏）`,
  quickAlignSkipDone: (pos: string) => `已把音频 0 秒对齐到谱面 ${pos}`,
  anchorDup: '已经有一条"谱面第 1 拍"的锚点了，先删掉旧的',
  anchorHint: '只有一条锚点：只调偏移，速度按谱面 J:',
  /** 右侧微调区的占位（左侧列表已经提示过"还没有锚点"，这里不重复同一句） */
  selectAnchor: '选中左侧的锚点，这里可以 ±ms 微调、锁定、回退重听',
  tap: 'T 打点',
  tapTitle: '这一拍是谱面的哪一处？',
  barLabel: '小节',
  beatLabel: '拍',
  /** adj1130：谱位是 1 起（与标记段 / `--from 27:3` 同一口径） */
  beatPosHint: '小节:拍都从 1 数（第 1 小节第 1 拍 = 1:1）',
  beatPosInvalid: '小节和拍都从 1 开始：第 1 小节第 1 拍请写 1:1（写 0 会算到上一小节最后一拍）',
  tapConfirm: '记下',
  tapCancel: '取消',
  rewind: '回退 3 秒重听',
  loop: '循环',
  lock: '锁定',
  unlock: '解锁',
  remove: '删除',
  step: '步长',
  metronome: '节拍器',
  /** adj1128：说明"嗒"落在哪（用户口径：要跟谱面的拍点） */
  metronomeHint: '按谱面拍点响：还没对拍时按"谱面从音频 0 开始、速度用 J:"，对拍后跟着锚点的偏移与拍速',
  /** adj1173：节拍器音色下拉 + 强弱拍说明 */
  metronomeTimbre: '音色',
  metronomeTimbreHint: '每小节第一拍低音「嘣」，其余高音「恰」；音色只改质感，不影响拍点位置',
  metronomeTimbres: {
    woodblock: '木鱼',
    bangzi: '梆子',
    gear: '齿轮',
    electronic: '电子',
  },
  trim: '保留段',
  trimStartNow: '起点=当前',
  trimEndNow: '终点=当前',
  trimAll: '整曲',
  bpm: '拍速',
  offset: '偏移',
  residual: '残差',
  residualWarn: '有锚点与整体速度差超过 1 拍，请复核（可能是谱面拍数或打点位置）',
  stale: '谱面改过，锚点请复核',
  save: '保存',
  close: '关闭',
  clear: '清空对拍',
  mixSource: '声音',
  mixFile: '伴奏',
  mixSynth: '合成音',
  mixBoth: '伴奏+合成',
  accompGain: '伴奏音量',
  synthGain: '合成音音量',
  /** adj1149（用户 2026-10-25：「滑条滑了没变化、选合成音还是伴奏」）：说明这排是**播放中即时生效**的 */
  mixLiveHint: '声音档位与两条音量改了就生效（播放中也会立刻变）',
  /** 波形下方那一排用短标签（窄窗口不换行，adj1124） */
  accompGainShort: '伴奏',
  synthGainShort: '合成',
  key: '伴奏调性',
  keyNone: '未填',
  keyMismatch: '谱面与伴奏调性不一致，注意音高',
  saved: '已存本机缓存（网页/开发模式没有 sidecar 文件）',
  savedFile: (name: string) => `已保存：${name}`,
  savedDownloaded: (name: string) => `已下载 ${name}（没有找到磁盘路径：这份谱不是从磁盘/工作区打开的）`,
  /**
   * adj1156：桌面壳里**不该**把 sidecar 下载到 Downloads。
   * 出现这句 = 这份谱是浏览器文件句柄打开的（壳拿不到目录）⇒ 让用户重新「打开」一次。
   */
  saveNoNativePath:
    '这份谱是浏览器文件句柄打开的，桌面壳拿不到它所在目录，没法写到 .jps 同目录。请用「打开」或把 .jps 拖进窗口重新打开一次，再保存。',
  saveFailed: (e: string) => `保存失败：${e}`,
  saveHint: '把对拍参数写进同目录的 sidecar 文件（`.jps.sync.json`）',
  closeHint: '关掉台面（Esc 也行）',
  synthLoading: '正在渲染合成音…（第一次会慢一点）',
  synthFailed: '合成音渲染失败（音色库没准备好？），这次只播伴奏',
  play: '播放',
  pause: '暂停',
  /** 波形缩放（按钮上写"当前是什么档"，点一下切另一档） */
  zoomAll: '视图：整曲',
  zoom30: '视图：30 秒',
  /* ---- adj1126：波形视野（缩放/平移） ---- */
  viewSpan: '视野',
  viewAll: '整曲',
  viewMinutes: (n: number) => `${n} 分钟`,
  viewSeconds: (n: number) => `${n} 秒`,
  viewHint: '滚轮缩放 · 拖动平移 · 0 回整曲',
  /* ---- adj1123：波形上方的动态谱预览 ---- */
  previewBuilding: '正在准备动态谱…',
  previewFailed: '动态谱没建起来（谱面还有错？）',
  previewNow: '当前位置',
  previewHint: '播放时这里跟着伴奏走：看跳跳球落在第几拍、色块是不是压在这一下。',
  /* ---- adj1124/adj1127：台面尺寸与预览缩放 ---- */
  previewZoom: '谱面缩放',
  zoomInHint: '放大谱面（与顶栏同一个缩放）',
  zoomOutHint: '缩小谱面（与顶栏同一个缩放）',
  scrollHint: '拖动滑块平移视野；点空白处跳过去',
  maximize: '最大化',
  restore: '还原',
  maximizeHint: '最大化 / 还原（也可以双击标题条）',
  headHint: '双击这里切换最大化',
  resizeHint: '拖这里改窗口大小',
  splitPreviewHint: '上下拖：改预览高度',
  splitWaveHint: '上下拖：改波形高度',
} as const

/**
 * adj1264：**连续动态谱**（单行横滚谱）对拍台的文案。
 *
 * 为什么独立一份：它与"对拍（伴奏对齐）"共用对拍数据，但入口/口径不同
 * （背景视频、视频原声、标记段、横滚条带），混在 `syncCopy` 里会让两处文案互相牵动。
 */
export const linearSyncCopy = {
  title: '连续动态谱（横滚）',
  desktopOnly: '连续动态谱要在桌面版里做（视频解码、出片都需要桌面能力）',
  entryHint: '单行横滚谱 + 背景视频：导入视频 → 对拍 → 选段 → 出片',
  stageHint: '画面就是成片的样子：背景视频 + 一条横滚的谱带，色块压在当前音上',
  fallbackColor: '没有视频：用纯色背景（也可以选一张背景图）',
  fallbackImage: '没有视频：用背景图',
  frameMissing: '这一帧还没解出来（视频解码中）；不影响对拍',
  videoBusy: '正在打开视频…',
  pickVideo: '导入视频…',
  repickVideo: '换视频…',
  pickImage: '背景图…',
  imageFailed: '这张图打不开（换一张 png/jpg 试试）',
  bgColor: '底色',
  bgColorHint: '没有视频也没有背景图时的底色',
  videoLoaded: (name: string, hasAudio: boolean) => `${name}${hasAudio ? '（带原声）' : '（无音轨）'}`,
  videoAudioFailed: '视频原声解不出来：这一条会出无声画面（可以另加伴奏）',
  videoRemembered: (name: string) => `上次用的是「${name}」，请重新选择视频文件`,
  play: '播放',
  pause: '暂停',
  tap: '打点(T)',
  tapHint: '按 T：把当前位置记成一个谱面拍点（然后确认小节:拍）',
  waveHint: '点一下/拖一下：跳到这里；压暗的两端不会被导出',
  audioLabel: '伴奏',
  pickAudio: '选伴奏…',
  repickAudio: '换伴奏…',
  accompLoaded: '用的是单独这条伴奏',
  videoSound: '用的是视频原声',
  noSound: '还没有声音：导入视频（带音轨）或另加伴奏',
  noMedia: '还没有视频/伴奏：先导入一个，或用纯色背景只出谱带',
  rangeLabel: '导出段',
  nudgeHint: '微调起点 10ms（打点时手抖那一点点）',
  markLabel: '标记段',
  markAll: '整曲',
  markHint: '从试听栏的标记段里选一段：保留段会对齐到它的起止',
  markMissing: '这一段在当前演奏顺序里找不到（谱面改过？）',
  export: '出片',
  cancelExport: '取消出片',
  videoGain: '视频原声',
  mixRule: '没加单独伴奏 ⇒ 用视频原声；加了 ⇒ 用单独那条',
  theme: '配色',
  /** adj1266（用户 2026-11-09 拍板）：配色默认跟着卡片模板走；四套预设仍可明确指定 */
  themeAuto: (name: string) => `跟随卡片模板（${name}）`,
  themeHint: '默认跟着卡片模板的配色走：换模板，谱带的墨色/描边/色块/球一起换；也可指定下面四套预设',
  bandTop: '谱带位置',
  bandScale: '谱带大小',
  /**
   * adj1265（M4 主题编辑器）：四套预设之外的颜色/描边/阴影自定义。
   * 这些字符串只做标签；真正的取值一律走 `stripTheme.ts` 的钳制。
   */
  styleEdit: '自定义…',
  styleHide: '收起自定义',
  styleReset: '恢复预设',
  styleHint: '只记你改过的那几项（跟着这首歌的 sidecar 走）；「恢复预设」清掉全部自定义',
  styleInk: '墨色',
  styleHalo: '描边色',
  styleHaloWidth: '描边粗细',
  styleShadow: '阴影色',
  styleShadowBlur: '阴影模糊',
  styleBlock: '色块色',
  styleBlockAlpha: '色块浓淡',
  styleBall: '球色',
  /** adj1265：片头/片尾卡适配（卡片与相机位共用模板库，尺寸按视频宽高） */
  cards: '带片头片尾',
  cardsHint: '片头卡用第 1 页的描述头（标题/作者/调号/拍速）；片尾卡是品牌落版；横屏/竖屏/方图都按比例排版',
  cardTemplate: '卡片模板',
  cardsOnHint: (intro: string, end: string, w: number, h: number) => `片头 ${intro} + 片尾 ${end}（${w}×${h}）`,
  noWebCodecs: '当前环境不支持 WebCodecs，不能出片（请更新 WebView2 / 换 Chrome）',
  notReady: '台面还在准备（谱带/片头卡生成中），稍等一下再点出片',
  noSuchBar: (bar: number) => `谱面没有第 ${bar} 小节`,
  dupAnchor: '这个谱位已有锚点，先删掉旧的再加',
  exportCanceled: '已取消导出',
  exportFailed: (e: string) => `出片失败：${e}`,
  exported: (path: string) => `连续动态谱已导出：${path}`,
  exportedWeb: '连续动态谱已开始下载',
} as const

/**
 * adj1195：导出乐谱包（zip）对话框文案。
 *
 * 乐谱包是**发布/交流单元**：meta.json + README.md + score.jps + assets/；
 * 上传到私有乐谱库后由工具同步到站点。这里只负责应用侧导出。
 */
export const scorePackageCopy = {
  title: '导出乐谱包',
  intro:
    '主标题/副标题/作曲作词从描述头 B / Z 自动生成，只读；short / slug 由乐谱库工具导入时按「主标题，副标题」自动生成。',
  fieldTitle: '主标题',
  fieldSubtitle: '副标题',
  fieldComposer: '作曲 / 作词',
  fieldLicense: '许可',
  fieldSource: '来源',
  fieldTags: 'tags（逗号分隔）',
  fieldDifficulty: '难度（1-5，可空）',
  fieldExcerpt: '片段说明（可空）',
  fieldNote: '编配说明（可空）',
  licensePD: '公版',
  licenseOriginal: '原创',
  licenseAuthorized: '已授权',
  assetsOn: (n: number) => `会带上 ${n} 张图（背景/水印）`,
  assetsText: (text: string) => `会带上文字水印「${text}」`,
  assetsNone: '当前没有启用背景/水印',
  hint: '主标题取第一个 B；副标题为其余 B（去空格后用「，」连接）；作曲/作词为全部 Z（去首尾空格后用「，」连接）。这些字段只读，short / slug 由乐谱库工具自动分配。',
  exportBtn: '导出 zip',
  cancelBtn: '取消',
  busy: '正在打包…',
  done: '已导出乐谱包',
  needTitle: '主标题不能为空',
  needComposer: '作曲 / 作词不能为空',
  needSource: '来源不能为空（公版写「传统」/ 授权写授权方）',
  fail: (e: string) => `导出失败：${e}`,
} as const
