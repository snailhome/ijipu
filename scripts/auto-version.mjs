/**
 * scripts/auto-version.mjs — 打包/发版前按改动自动升应用版本
 *
 * 用户 2026-11-13 口径：jp / cp / ms 三个应用按**功能变更情况**自动升版本，
 * 时机是**打包/发版前**，不是每次提交。
 *
 * 判定口径（与 docs/VERSIONING.md 一致）：
 *  · 破坏性变更（BREAKING CHANGE / !: / 不兼容 / 破坏性） → MAJOR
 *  · 新增功能（feat / 新增 / 新功能 / 加入 / 支持 / 添加） → MINOR
 *  · 其余代码改动（修复、样式、细节）                     → PATCH
 *  · 只改文档 / 日志 / release-body → 不升版
 *
 * 基线：上一次改动版本文件的提交。之后没有新提交时**不升版**，所以同一提交重复打包
 * 不会一直涨版本号；正常发布流程应先提交改动，再打包。
 *
 * 用法：
 *   node scripts/auto-version.mjs            # 按当前仓库 package.json 的 name 识别应用
 *   node scripts/auto-version.mjs --dry-run  # 只打印将要升到的版本
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const dryRun = process.argv.includes('--dry-run')

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'))
}

function writeJson(rel, obj) {
  writeFileSync(join(root, rel), `${JSON.stringify(obj, null, 2)}\n`)
}

function setJsonVersion(rel, version) {
  if (!existsSync(join(root, rel))) return false
  const obj = readJson(rel)
  if (obj.version === version) return false
  obj.version = version
  writeJson(rel, obj)
  return true
}

function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (m === null) throw new Error(`版本号格式不认识：${version}`)
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (kind === 'major') {
    major += 1
    minor = 0
    patch = 0
  } else if (kind === 'minor') {
    minor += 1
    patch = 0
  } else {
    patch += 1
  }
  return `${major}.${minor}.${patch}`
}

const APPS = {
  ijipu: {
    label: 'jp',
    baseline: 'src/brand/version.ts',
    versionTs: 'src/brand/version.ts',
    lock: 'package-lock.json',
    lockPackages: ['packages/ijipu-cli'],
    manifests: ['package.json', 'src-tauri/tauri.conf.json', 'packages/ijipu-cli/package.json'],
  },
  'ijipu-cp': {
    label: 'cp',
    baseline: 'src/brand/version.ts',
    versionTs: 'src/brand/version.ts',
    lock: 'package-lock.json',
    lockPackages: [],
    manifests: ['package.json', 'src-tauri/tauri.conf.json'],
  },
  'ijipu-sm-desktop': {
    label: 'ms',
    baseline: 'src-tauri/tauri.conf.json',
    versionTs: null,
    lock: null,
    lockPackages: [],
    manifests: ['package.json', 'src-tauri/tauri.conf.json', '../tool/package.json'],
  },
}

const pkg = readJson('package.json')
const app = APPS[pkg.name]
if (app === undefined) {
  console.error(`[auto-version] 不认识的应用：${pkg.name}`)
  process.exit(1)
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

const base = git(['log', '-1', '--format=%H', '--', app.baseline])
if (base === '') {
  console.error(`[auto-version] ${app.label} 找不到版本文件的历史提交，无法判断版本`)
  process.exit(1)
}

const commits = git(['log', '--format=%s%n%b', `${base}..HEAD`]).trim()
const changed = git(['diff', '--name-only', `${base}..HEAD`])
  .split(/\r?\n/)
  .filter(Boolean)

/** 文档 / 日志 / 构建产物不算“功能变更” */
const isCode = (file) =>
  !/\.md$/i.test(file) &&
  !/^docs\//i.test(file) &&
  !/^CHANGELOG/i.test(file) &&
  !/^release-body/i.test(file) &&
  !/^\.dsh\//i.test(file) &&
  !/\.log$/i.test(file)

if (!changed.some(isCode)) {
  console.log(`[auto-version] ${app.label}：自 ${base.slice(0, 8)} 起没有代码改动，版本保持 ${pkg.version}`)
  process.exit(0)
}

if (commits === '') {
  console.log(`[auto-version] ${app.label}：没有新的已提交改动；先提交功能改动再打包，版本保持 ${pkg.version}`)
  process.exit(0)
}

const text = commits
let kind = 'patch'
if (/BREAKING[ -]?CHANGE|!:\s|不兼容|破坏性/i.test(text)) kind = 'major'
else if (/^feat(\(|:)|^feature|新增|新功能|加入|支持|添加|功能/mi.test(text)) kind = 'minor'

const current = pkg.version
const next = bump(current, kind)
console.log(`[auto-version] ${app.label}：${current} → ${next}（${kind.toUpperCase()}）`)
if (dryRun) {
  console.log('[auto-version] --dry-run，不写文件')
  process.exit(0)
}

/** 版本号唯一来源：TS 常量或 package.json */
if (app.versionTs !== null) {
  const file = join(root, app.versionTs)
  const raw = readFileSync(file, 'utf8')
  const nextRaw = raw.replace(/(export const APP_VERSION = ')([^']+)(')/, `$1${next}$3`)
  if (nextRaw === raw) throw new Error(`${app.versionTs} 里没找到 APP_VERSION`)
  writeFileSync(file, nextRaw)
}

for (const rel of app.manifests) {
  if (rel.startsWith('../')) {
    const abs = join(root, rel)
    if (!existsSync(abs)) continue
    const obj = JSON.parse(readFileSync(abs, 'utf8'))
    if (obj.version !== next) {
      obj.version = next
      writeFileSync(abs, `${JSON.stringify(obj, null, 2)}\n`)
    }
  } else {
    setJsonVersion(rel, next)
  }
}

if (app.lock !== null && existsSync(join(root, app.lock))) {
  const lock = readJson(app.lock)
  if (lock.version !== next) lock.version = next
  if (lock.packages?.[''] !== undefined) lock.packages[''].version = next
  for (const name of app.lockPackages) {
    if (lock.packages?.[name] !== undefined) lock.packages[name].version = next
  }
  writeJson(app.lock, lock)
}

/**
 * adj1307（用户实报）：**首页页脚「调优 N」跟到最新 adj**。
 *
 * 0.81.0 发布时漏了这一步，线上页脚一直停在 1257。现在发布前（本脚本由 `tauri:build`
 * 与发布流程调用）从 **git log 提交标题**里取最大的 `adjNNNN`，写回 `src/brand/adj.ts`；
 * 只增不减（用户手写更大的值时不回退）。`npm run smoke` 有对应闸门。
 */
if (!dryRun) {
  const adjFile = join(root, 'src/brand/adj.ts')
  if (existsSync(adjFile)) {
    let maxAdj = 0
    for (const m of git(['log', '--format=%s', '-n', '800']).matchAll(/adj(\d{3,4})/g)) {
      maxAdj = Math.max(maxAdj, Number(m[1]))
    }
    const raw = readFileSync(adjFile, 'utf8')
    const cur = Number(/export const LATEST_ADJ = (\d+)/.exec(raw)?.[1] ?? 0)
    if (maxAdj > cur) {
      writeFileSync(adjFile, raw.replace(/export const LATEST_ADJ = \d+/, `export const LATEST_ADJ = ${maxAdj}`))
      console.log(`[auto-version] 首页页脚 LATEST_ADJ ${cur} → ${maxAdj}`)
    }
  }
}

console.log(`[auto-version] ${app.label} 版本已更新到 ${next}`)
