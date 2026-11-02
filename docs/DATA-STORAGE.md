# 三端存储与桌面本机配置（adj1085）

> 用户口径（2026-10-23）：桌面壳的「本机配置」应放在**个人目录**下，由应用自己管，
> 而不是寄在 WebView2 的浏览器缓存里——缓存一清就没了。网站/PWA 用浏览器缓存，
> 插件用插件目录，这是三端应有的区别。

## 一、分层（先定层，再定落点）

| 层 | 内容 | 落点 |
|---|---|---|
| **L2 谱面配置** | 页边距、字号、行距、背景图、水印、`# jps-config` 全部字段 | **始终写在 `.jps` 里**；三端一致，**不进**本机配置 |
| **L1 本机偏好** | 主题、缩放、拆分比例、**卡片模板库**、音色库选择、导出背景、草稿… | 桌面：`%APPDATA%\iJipu\settings.json`；网站/PWA：浏览器 `localStorage`；插件：插件目录 `data.json` |
| **L1 大文件** | 卡片背景图、**印章图片**（均 ≤2.5MB；模板库里只存 `ijipu-blob:` 引用） | 桌面：`files\<hash>.<ext>`；网站/PWA：IndexedDB（`ijipu-assets`）；插件：仍内联在 `data.json`（宿主桥暂无写二进制 op） |
| **谱面附属（sidecar）** | **这首歌用哪套卡片模板**（`card.template`）、对拍锚点/混音、练习段/导出段 | 与 `.jps` 同目录的 `xxx.jps.sync.json`；**只记引用，不复制样式本体**（adj1176） |
| **L3 会话** | 当前弹窗、临时预览状态 | 内存，不落盘 |

硬规则：**换台机器打开同一份 `.jps`，谱面必须一样** ⇒ L2 永远跟着谱走；
本机配置只放"这个人怎么用"，丢了会烦、但不该改变谱面长相。

## 二、桌面壳的路径与文件

```text
%APPDATA%\iJipu\
  settings.json        # 当前配置（人可读、可手改）
  settings.bak.json    # 上一份（主文件坏了回退）
  settings.json.tmp    # 原子写的临时文件（写完即替换，读的人看不到半截）
  files\<hash>.<ext>   # 卡片背景图等大附件（settings 里只存 ijipu-blob:<名>）
```

- Windows 上 `%APPDATA%` = `C:\Users\<你>\AppData\Roaming`；macOS 是
  `~/Library/Application Support/iJipu`，Linux 是 `~/.config/iJipu`（Tauri `config_dir()` + `iJipu`）。
- **不放安装目录**（`%LOCALAPPDATA%\iJipu`）：那里是程序文件，卸载/升级会动它。
- **不放 WebView2 的 profile**（`%LOCALAPPDATA%\<identifier>\EBWebView`）：那是浏览器缓存。
- 卸载默认**保留**本目录；以后若加"同时删除本机配置"选项，默认不勾。

文件格式：

```json
{
  "schema": 1,
  "app": "iJipu",
  "updatedAt": 1792727433176,
  "values": {
    "ijipu.theme": "ink",
    "ijipu.previewZoom": "125"
  }
}
```

`values` 里的键与浏览器 `localStorage` **完全同一套**（`ijipu.` 前缀），值是字符串。
这样"迁移"只是换落点，不换数据形状。

## 三、启动、迁移与失败口径

1. 启动时（`main.tsx`，**早于任何 store 模块求值**）调 `prefs_load`。
2. 文件不存在 ⇒ 把 WebView2 `localStorage` 里现有的 `ijipu.*` 抄进快照，先落盘一次，再接管。
   **源不删**：新文件写失败时旧版本还能读；等这版用稳了再谈清理。
3. 把 `window.localStorage` 换成只接管 `ijipu.` 前缀的 `Storage` 门面
   （`createPrefsFacade`；与插件版 `embedStorage.ts` 同一手法）⇒ 80+ 个调用点一行不用改。
4. 写入防抖 300ms 后**整表**落盘；切到后台/关窗前再补一次。
5. 主文件坏掉 ⇒ 读 `settings.bak.json`，控制台提示"已回退到上一份"，**不静默重置**。
6. 读不到 / 旧版 exe 没有命令 ⇒ **不接管**，退回浏览器存储，界面照常启动。

### 启动顺序的坑（已修，adj1085 实测）

`main.tsx` 末尾还有**另一个顶层 IIFE**（外部改动轮询），它在模块求值时就启动，并会
`import('./store/docStore')` → docStore 静态 import 了 uiStore。冷启动时它和"读配置文件"的
IPC **赛跑**：IPC 稍慢，uiStore 就先用 WebView2 里的旧值求值了（实测：文件写 `dark`、界面却是
`light`，刷新一次才对）。

修法：`prefs.ts` 导出 `prefsReady`，那个 IIFE 在动 store 之前先 `await prefsReady`；
`preloadDesktopPrefs` 在成功/失败/无需接管的**所有出口**都 resolve 它（只保证"等待结束"，
不保证"已经接管"）。冷启动连跑 3 次，顺序都是 `prefs 完成 → uiStore`，主题一致。

失败时绝不做的两件事：不把设置悄悄清成默认；不因为写盘失败挡住用户操作。

## 四、三端的差异（同一个键空间）

| | 桌面壳 | 网站 / PWA | Obsidian 插件 |
|---|---|---|---|
| L1 配置 | `%APPDATA%\iJipu\settings.json` | `localStorage` | `<vault>/.obsidian/plugins/ijipu/data.json` |
| 大文件 | `%APPDATA%\iJipu\files\` | IndexedDB（`ijipu-assets`） | 插件目录 `data.json`（内联 data URL） |
| 跨端迁移 | 首次从 `localStorage` 抄一次 | — | 早已由 `embedKv` 走宿主桥 |
| L2 谱面配置 | `.jps` | `.jps` | `.jps` |

## 五、为什么这样定（而不是别的做法）

- **不每个功能一个文件**：`settings.json` 一个键值表，迁移/备份/导出都只有一份；
  分文件会重演"哪个设置存在哪"的老问题。
- **不逐键写盘**：80+ 个调用点、拖滑块会连续写；整表 300ms 防抖 + 原子替换，
  既不打碎磁盘，也不会出现"一半新一半旧"。
- **不直接改 store**：替换 `localStorage` 门面是插件已经验证过的路径，风险最小、
  回退最容易（不接管即回到现状）。
- **不让命令行出片窗口写配置**：它是第二个进程，会和主窗口互相覆盖；出片只需要读默认值。

## 六、验证

- `npm run smoke`：`adj1085` 的纯逻辑断言（只搬 `ijipu.*`、门面代理、去重、clear 不越界、落盘形状）。
- `npm run test:rust`：`prefs.rs` 的单元测试（往返、备份、坏文件回退、旧格式、非字符串值）。
  ⚠ 本机 GNU 工具链上 `cargo test` 起不来（`STATUS_ENTRYPOINT_NOT_FOUND`，见 `ERRORS-LOG.md`），
  所以这几条用 `cargo test --no-run` 证明"能编译"，运行结果须在正常环境补跑。
- 真机：启动桌面壳一次 → 检查 `%APPDATA%\iJipu\settings.json` 已生成且含原 `ijipu.*`；
  改主题/缩放 → 文件随动；重启 → 设置还在。
  本次实测：首次启动迁移出 9 个键（主题 `zhusha`、浅色模式、拆分方向、草稿正文、工作区绑定、
  民族乐器、音色库选择）；把文件改成 `themeMode=dark` 后**冷启动 3 次**，界面均为深色
  （`data-mode=dark`、背景 `rgb(23,13,12)`），证明"读的是文件"而不是浏览器缓存。

## 七、P1 已做（adj1085）

- **大图外置**：卡片背景图不再以 data URL 塞进 `settings.json`。
  - 桌面：写 `%APPDATA%\iJipu\files\<hash>.<ext>`，配置里存 `ijipu-blob:<名>`；
  - 网站/PWA：写 IndexedDB（`ijipu-assets`）；
  - 插件：仍内联在 `data.json`（宿主桥目前没有写二进制文件的 op；插件本身不在浏览器缓存里）；
  - 旧数据：启动时把 `ijipu.dynamicCardStyleCustom` 里的 data URL 自动迁成引用（一次性、失败保留原样）。
- **设置页「本机」子页签**：显示配置落点、打开配置目录（桌面）、导出/导入设置 zip。
  - zip 内容：`settings.json`（带 schema/app/exportedAt/values）+ `files/<名>` + `README.txt`；
  - 导入只**合并**同名 `ijipu.*`、不删本地独有键；附件名白名单（防 `..\`）、单文件 ≤20MB；
  - 附件缺失时清空那张卡片图的引用，不留打不开的图；导入后自动重新加载界面。
- **卸载选项**：选「完全卸载」时删 `%APPDATA%\iJipu` 与 WebView2 的 `%LOCALAPPDATA%\com.ijipu.app`；
  选「否」（默认）或静默卸载时**全部保留**。NSIS 模板不支持在卸载页加自定义复选框，
  这里沿用已有的「完全卸载 / 保留」二选一（默认保留），语义等价。

## 八、后续可做

- 插件端把背景图写到插件目录（需要宿主桥新增"写二进制文件" op）。
- 草稿体积变大后再拆 `drafts/`（现在与其它 L1 一起放 `settings.json`，草稿是文本、量级可接受）。
- 配置的"导出前清理孤儿附件"（现在只在新图替换/删除时清旧的，异常退出可能留一两个孤儿文件）。
