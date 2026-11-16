# iJipu 版本机制（Versioning）

## 版本格式

`MAJOR.MINOR.PATCH`（SemVer）＋ 构建信息（日期 + git commit）

```
示例：v0.2.0 (2026-08-16 @a1b2c3d4)
```

## 递增规则

| 位 | 触发条件 | 示例 |
|---|---|---|
| **MAJOR** | 破坏性变更 / 里程碑（UI 重构、格式不兼容、品牌变更） | 1.0.0 |
| **MINOR** | 功能新增（向后兼容） | 0.2.0 → 0.3.0 |
| **PATCH** | Bug 修复 / 细节调整 / 文案与样式微调 | 0.2.0 → 0.2.1 |

## 版本号维护位置

- **手动维护**：`src/brand/version.ts` 的 `APP_VERSION`
- **自动注入**：`scripts/gen-build-info.mjs` 在构建/开发启动前生成
  `src/gen/buildInfo.ts`（`BUILD_DATE` = 构建日期；`GIT_COMMIT` = 当前 commit 前 8 位，无 git 时回退 "dev"）
  —— 读取 `.git/HEAD` 与 refs 文件实现，**无子进程 spawn**（沙箱兼容）

## 展示位置

- 状态栏右侧：`i记谱 · v{APP_VERSION}`
- 底栏「关于」页签（adj492 起从弹窗迁入底栏）：`v{APP_VERSION} (BUILD_DATE @GIT_COMMIT)`

## 构建链

```bash
npm run dev      # → gen:info → vite dev
npm run build    # → gen:info → tsc -b → vite build
npm run tauri:build  # 复用 npm run build（前端 dist），版本随 package.json
```

> 桌面安装包版本取自 `package.json version` 与 `src-tauri/tauri.conf.json version`，与 `APP_VERSION` 保持同步（发布时三处一致）。

---
## 发布操作流程（`ijipu` 应用）

用户以「**更新提交**」触发时，按以下整串执行：

> **本流程已固化为技能 `.dsh/skills/版本发布/SKILL.md`**（触发词「更新提交」即加载）：那里把下面 8 步拆成
> **原子操作 OP-01~OP-16**（各自可独立执行、带验证点）与**两条流程链**（CHAIN-A 应用发布 / CHAIN-B 引擎→插件联动），
> 并附检查清单与实测踩坑（中文提交信息经 UTF-8 文件传入、`vendor/engine` 用 hash 同步、Release 正文只含当版、
> 匿名 `api.github.com` 有 CDN 缓存等）。**执行时以技能为准，本节为权威规则来源。**

1. **判断版本递增幅度**——按更新内容大小：
   - **MAJOR**：破坏性变更 / 里程碑（UI 重构、语法/格式不兼容、品牌变更、大功能跨代）
   - **MINOR**（推荐小版本）：功能新增（向后兼容），如新增修饰符、新 UI 模块
   - **PATCH**：Bug 修复 / 细节调整 / 文案与样式微调
   > 实际以**更新内容大小**判定大版本 vs 小版本；拿不准时倾向小版本（MINOR）。
2. **记录更新**：
   - `CHANGELOG.md` 顶部新增 `[x.y.z]` 条目（功能/修复/文档版本）
   - `docs/ERRORS-LOG.md`：排错条目（`E-年份-序号`）+ 末尾 CHANGELOG 表新增 `vx.y.z` 行
   - 涉及语法改动同步 `docs/SYNTAX.md`（《脚本语法说明》，**唯一对外口径**；`JPS-SPEC.md` / `jps-spec.html` 已在 adj422 合并进它）
3. **递增版本号（同步多份）**：
   - `src/brand/version.ts`（`APP_VERSION`）、`package.json`、`src-tauri/tauri.conf.json`
   - `package-lock.json`（顶层 + packages[""] 两处）
   - **`packages/ijipu-cli/package.json`**（adj874 起：CLI 是独立发布的 Node 包，版本号应与应用一致；
     不一致会被 `cli-assert` 的 `adj874` 闸门当场拦下 ✓）
   - 引擎改动涉及包版本时同步 `packages/ijipu-engine/package.json`、`packages/ijipu-engine/src/engine/...` 相关
   - **`packages/ijipu-engine` 的包版本号「随 app 版本」走**（用户 2026-11-16 定）：**不因单次引擎修复单独升号**，
     等应用发版时一并递增；发 npm 就用当前号（实例：`adj1308` 的 emoji 估宽修复按 0.48.0 原号发出去，
     `ijipu-sl` 升依赖拿到的就是含修复的 0.48.0）。代价是 npm 上某版本的代码可能比应用内嵌的同一版本新，
     这是有意的取舍 —— **发 npm 前必须先确认 `dist/` 是用当前源码重建过的**，否则发出去的是旧产物。
4. **验证**：`tsc -b` + `npm run build` 通过；`npm run smoke` **必须 0 失败**（adj456 起旧的"18 条预存失败基线"已逐条清理归零——不再接受"== 基线"的说法；若确有无法立刻修的失败，必须在断言里写明原因与跟踪项，并在提交信息里点名，而不是只写个数）。
   - `npm run lint` **0 error**，且 warning 数 **== 改动前基线**（新增一条要么修掉、要么说清理由）。
   - **改动涉及应用内 UI 时**，另跑 `npm run verify:app-ui`（真浏览器点一遍；`adj959` 立的规：
     「事件挂错地方」这类缺陷源码级断言守不住 —— 代码里确实挂了监听，但**收不到事件**）。
5. **git 提交 + 打 tag**：
   - 提交（Conventional + adjNN，如 `release: 版本升至 x.y.z（...）`、`feat(engine): ...`）
   - `git tag v<x.y.z>`（与既有 tag 一致，如 `v0.12.17`、`v0.13.0`），指向该提交。
6. **桌面打包 + 安装包自检**（打包放在提交之后，让应用内构建信息带上发布提交号）：
   - `. .\scripts\tauri-env.ps1` → `npx tauri build` → `src-tauri/target/release/bundle/nsis/iJipu_<x.y.z>_x64-setup.exe`
   - **必须跑 `npm run check:installer`**：读生成的 `installer.nsi` 断言「主程序 + 必需 DLL」都在安装清单里。
     本项目用 **GNU 工具链**，`WebView2Loader.dll` 是**运行期动态依赖**，必须随包分发（漏了会装完启动报错，见 `E-2026-134`）；
     换工具链（MSVC）或改 `bundle.resources` 后尤其要跑。
   - 「装出来能用」要在干净目录验证（`iJipu_<x.y.z>_x64-setup.exe /S /D=<临时目录>`）或至少核对安装清单，
     不能只在开发目录里跑 `target/release/ijipu.exe`（那里 DLL 就在旁边）。
7. **GitHub Release 正文只含当版**：用 `npm run release:body`（= `scripts/release-body.mjs`）按
   `package.json` 的版本从 `CHANGELOG.md` 截取**当前版本那一节**，写入 `release-body.md`（已 gitignore），
   建 Release 时用它当正文。
   > `CHANGELOG.md` 是累积文件（保留历史便于查阅），**直接把整份贴进 Release 会把之前所有版本一起发出去**。
   > 插件仓库同理：其工作流已改为先跑 `scripts/release-body.mjs` 再 `body_path: release-body.md`。
8. **上传安装包附件**：`gh release create/edit v<x.y.z> --notes-file release-body-<x.y.z>.md <安装包>`；
   重新打包后替换附件用 `gh release upload v<x.y.z> <安装包> --clobber`。
   > 核对 Release 状态一律用**带鉴权的 `gh api`/`gh release view`**（匿名 `curl api.github.com` 有 CDN 缓存，会读到旧内容 → `E-2026-130`）。
9. **漏发不补**（用户 2026-10-23 口径）：某版本当时没打 tag、也没建 Release，事后**一律不补**，
   直接随下一个版本发；只需在 `CHANGELOG.md` 该版条目下留一句「未单独发版（内容包含在后续版本里）」。
   > 实例：`v0.72.0` 未打 tag / 未建 Release，用户 2026-10-23 决定不补，内容已含在 `v0.73.0` / `v0.74.x` 里。

---
## 双仓库联动（ijipu 引擎 ↔ obsidian-ijipu）

- **版本号策略：两库各自独立，不强制对齐**。`ijipu`（网页应用）与 `obsidian-ijipu`（Obsidian 插件）只有**引擎（`vendor/engine`）是共用引用**，插件代码与网页代码分开，各自按自己的发布节奏与代码更新量递增版本号。引擎同步只是 obsidian-ijipu 版本递增的一类原因，不代表其版本号必须等于 ijipu。
- **当 ijipu 更新涉及引擎代码**（`packages/ijipu-engine/src/engine/`）时，`obsidian-ijipu` 需要同步发布：
  1. 把 ijipu 引擎改动的文件同步到 `obsidian-ijipu/vendor/engine/`（vite 将 `@ijipu/engine` 别名到 `vendor/engine/index.ts`，是自包含镜像）。
     - 用文件 hash 对比确认哪些引擎文件有差异（DIFF），复制覆盖；同步后用 hash 校验一致。
  2. **判断 obsidian-ijipu 版本递增**（按其自身代码更新量，非照抄 ijipu 版本号）：若有**引擎更新**（vendored 引擎变化）或**自身插件代码更新**（`src/`、manifest、设置等），则递增 `obsidian-ijipu` 版本号（`package.json` + `manifest.json`）；仅文档/素材变化可不升。
  3. 记录更新（`obsidian-ijipu/docs/RELEASE-NOTES.md` 顶部加对应版本条目）。
  4. 验证：`tsc -noEmit -skipLibCheck` 通过（vite `npm run build` 在 DSH 沙箱可能因 spawn 限制失败，属环境限制、非代码问题；`main.js` 为构建产物且已 gitignore）。
  5. **git 提交 + 打 tag**：`git tag <obsidian-ijipu 自身版本号>`（无 `v` 前缀）。

> 简化准则：**`ijipu` 有代码更新 → 按内容判版本、记录、提交 + 打 tag；若涉及引擎更新，同步 `obsidian-ijipu/vendor/engine` 并按 obsidian-ijipu 自身更新量判其版本、补 RELEASE-NOTES、提交 + 打 tag。两库版本号各自独立，不因引用同一个引擎而强行对齐。**

