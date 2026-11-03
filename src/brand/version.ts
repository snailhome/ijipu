/**
 * brand/version.ts — 版本常量（手动维护）
 *
 * 版本机制详见 docs/VERSIONING.md：
 *   MAJOR.MINOR.PATCH（SemVer）
 *   - PATCH：Bug 修复 / 细节调整 → +1
 *   - MINOR：功能新增（向后兼容）→ +1
 *   - MAJOR：破坏性变更 / 里程碑 → +1
 *
 * 构建日期与 git commit 由 scripts/gen-build-info.mjs 自动注入（npm run gen:info）。
 * 发布时与 package.json version、src-tauri/tauri.conf.json version 三处保持一致。
 */
import { BUILD_DATE, GIT_COMMIT } from '../gen/buildInfo'

/** 当前版本（手动递增） */
export const APP_VERSION = '0.77.1'

/** 完整版本串：v0.2.0 (2026-08-16 @a1b2c3d4) */
export const APP_VERSION_FULL = `v${APP_VERSION} (${BUILD_DATE} @${GIT_COMMIT})`

/**
 * adj975（**用户 2026-10-18 口径**）：「状态栏的版本号将**日期、指纹**也加上呀」。
 *
 * 状态栏那一格要按「版本号 + 构建日期 + commit 指纹」三段显示（`v0.70.0 (2026-10-17 @db3ffd76)`），
 * 而 `BUILD_DATE` / `GIT_COMMIT` 来自生成物 `gen/buildInfo`。组件不该直接去 import 那个生成物
 * （品牌层是版本信息的唯一出处，见本文件头）⇒ 在这里转出两段，供 `ui/EditorFootBar.tsx` 拼。
 */
export const APP_BUILD_DATE = BUILD_DATE
export const APP_COMMIT = GIT_COMMIT

/**
 * `adj971` 立的"标题口径"文档头 —— **已被 `adj978` 取代**（标题不再带应用名，见下面的 `appTitleOf`）。
 *
 * 历史沿革（都是用户口径，别翻旧账时搞错）：
 *   · `adj621`：标题 = `爱记谱 iJipu - v0.36.0 (2026-09-23 @4ed877a3)`，为了"一眼看到版本"；
 *   · `adj971`：标题 = `文件名.jps - 爱记谱 iJipu`，版本挪到**状态栏右侧**与**官网首页左侧**；
 *   · `adj977`：按宿主分档（已安装手机 PWA 不带应用名）；
 *   · **`adj978`（现行）**：标题**只有文件名**，应用名由外壳决定要不要显示。
 *
 * 前缀 `爱记谱 iJipu` 与 `brand/tokens.ts` 的 brand.nameZh + brand.name 一致；
 * 放在 `version.ts` 而非 `tokens.ts`，是因为它天然跟版本号绑定。
 * ⚠ `adj978` 起它**不再进标题**，仅作品牌串保留（官网/文档等处用各自的字面量）。
 */
export const APP_TITLE_PREFIX = '爱记谱 iJipu'

/**
 * adj978（**用户 2026-10-18 最终口径**，原话）：「那就不纠结了，**直接显示文件名**，壳有加应用名就加，
 * 没有的就只显示文件名，**重复显示反而不美**」。
 *
 * ⇒ 标题**只放文件名**（`望月.jps`）。应用名交给**那层外壳**自己决定要不要显示：
 *   · 安卓已安装 PWA（WebAPK）的标题栏是 `<manifest name> - <页面标题>` ⇒ 人家会拼上「爱记谱 iJipu」；
 *   · 桌面壳窗口标题栏 / 浏览器页签 / Obsidian 页签都**只显示我们给的这个串** ⇒ 就只是文件名。
 *
 * 这条口径同时替掉了两个前任：
 *   · `adj621`：标题 = `爱记谱 iJipu - v0.36.0 (…)`（带版本，为了一眼看到版本）；
 *   · `adj971`：标题 = `文件名.jps - 爱记谱 iJipu`（文件名在前、应用名在后）；以及
 *   · `adj977` 的"按宿主分档要不要带应用名"——**不再需要分档**（一律不带）。
 * 为什么最终这样定：`adj977` 实测出安卓会把应用名拼在**前面**（`爱记谱 iJipu - 望月.jps - 爱记谱 iJipu`），
 * 我们无论怎么排都会重复一次；而"应用名"本来就该由**显示它的那一层**去显示。
 *
 * @param fileBase 文件名（**不带扩展名**；`docStore.fileName` 就是这个形态）。
 *   这里仍**防御性地**剥掉一次 `.jps`：调用方若手滑传了全名，标题不该变成 `x.jps.jps`。
 *   空名兜底 `未命名.jps`。
 *   ⚠ 不 import `store/saveSupport` 的 `fileBaseName`：品牌层不许依赖 store 层（分层约束）。
 */
export function appTitleOf(fileBase: string): string {
  const base = String(fileBase ?? '').trim().replace(/\.jps$/i, '')
  return `${base === '' ? '未命名' : base}.jps`
}

