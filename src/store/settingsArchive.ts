/**
 * store/settingsArchive.ts — 本机配置的**导出 / 导入**（adj1085 / P1）
 *
 * 用户要"换台机器也能把设置带走"。包内容：
 *   settings.json   —— `{schema, app, exportedAt, values}`，values 就是 `ijipu.*` 键值
 *   files/<名>       —— 卡片背景图等外置附件（settings 里存 `ijipu-blob:<名>`）
 *   README.txt       —— 说明
 *
 * 约束：
 *  - 不引第三方依赖，复用 `export/zip.ts`（store 条目）；
 *  - 导入**只合并同名键**，不删本地独有的键；
 *  - 导入的文件名白名单校验（防 `..\`），单文件 ≤20MB；
 *  - 导入后检查引用：附件缺了就把那张卡片图的引用清空，不留"打不开的图"。
 */
import { readZip, writeZip, type ZipEntry } from '../export/zip'
import { prefsInstalled, prefsSnapshotValues, mergePrefs, flushPrefsNow } from './prefs'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const MAX_JSON_BYTES = 5 * 1024 * 1024

export interface ArchiveStats {
  keys: number
  files: number
}

/** 收集一份配置里引用到的附件名（卡片功能已迁到爱出片，当前无附件） */
function referencedBlobs(values: Record<string, string>): string[] {
  return Object.keys(values).slice(0, 0)
}

/** 网页/插件：直接从 localStorage 读 `ijipu.*`（桌面壳由 prefs 快照提供） */
function readLocalPrefs(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i)
      if (k === null || !k.startsWith('ijipu.')) continue
      const v = localStorage.getItem(k)
      if (v !== null) out[k] = v
    }
  } catch {
    /* 存储不可用 ⇒ 导出空表，由界面显示 0 项 */
  }
  return out
}

/** 网页/插件：把导入的键写回 localStorage（桌面壳走 mergePrefs） */
function writeLocalPrefs(values: Record<string, string>): number {
  let n = 0
  try {
    for (const [k, v] of Object.entries(values)) {
      if (!k.startsWith('ijipu.') || localStorage.getItem(k) === v) continue
      localStorage.setItem(k, v)
      n += 1
    }
  } catch (e) {
    throw new Error(`写入浏览器存储失败：${e instanceof Error ? e.message : String(e)}`)
  }
  return n
}

/**
 * 打包当前本机配置。
 *
 * 导出前先 `flushPrefsNow()`：把 300ms 防抖里还没落盘的值写进快照源，
 * 否则"刚改完就导出"会少一两项。
 */
export async function exportSettingsZip(): Promise<Uint8Array> {
  await flushPrefsNow()
  const values = prefsInstalled() ? prefsSnapshotValues() : readLocalPrefs()
  const files: ZipEntry[] = []
  files.unshift({
    name: 'settings.json',
    data: ENC.encode(
      JSON.stringify(
        {
          schema: 1,
          app: 'iJipu',
          exportedAt: Date.now(),
          values,
        },
        null,
        2,
      ),
    ),
  })
  files.push({
    name: 'README.txt',
    data: ENC.encode(
      [
        '爱记谱 iJipu 本机配置备份',
        '',
        '导入：应用 → 设置（全局）→ 本机配置 →「导入设置…」',
        'settings.json 是 ijipu.* 键值。',
        '导入只合并同名键，不删除本机独有的设置。',
      ].join('\n'),
    ),
  })
  return writeZip(files)
}

/**
 * 导入设置 zip（合并）。
 *
 * @throws 不是本应用的设置包 / JSON 坏 / 条目超限时给出中文原因
 */
export async function importSettingsZip(zip: Uint8Array): Promise<ArchiveStats & { droppedImage: boolean }> {
  const entries = readZip(zip)
  const json = entries.get('settings.json')
  if (!json) throw new Error('zip 里没有 settings.json（不是本应用导出的设置包）')
  if (json.byteLength > MAX_JSON_BYTES) throw new Error('settings.json 超过 5 MB，已拒绝导入')

  let root: unknown
  try {
    root = JSON.parse(DEC.decode(json))
  } catch {
    throw new Error('settings.json 不是有效 JSON')
  }
  const obj = root as { values?: unknown } & Record<string, unknown>
  const rawValues = (obj.values ?? obj) as Record<string, unknown>
  if (rawValues === null || typeof rawValues !== 'object' || Array.isArray(rawValues)) {
    throw new Error('settings.json 里没有键值对象')
  }
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawValues)) {
    if (!k.startsWith('ijipu.') || typeof v !== 'string') continue
    values[k] = v
  }
  if (Object.keys(values).length === 0) throw new Error('设置包里没有可导入的 ijipu.* 项')

  const files = 0
  // 卡片附件已随视频功能迁到爱出片；应用设置包里只有 settings.json
  const droppedImage = false
  // 桌面壳走 prefs 快照（会落 settings.json）；网页/插件写回 localStorage（插件由宿主桥落 data.json）
  const merged = prefsInstalled() ? await mergePrefs(values) : writeLocalPrefs(values)
  await flushPrefsNow()
  return { keys: merged, files, droppedImage }
}

/** 把 zip 下载到本地（桌面/网页都用浏览器下载；桌面会落到"下载"目录） */
export function downloadSettingsZip(bytes: Uint8Array): void {
  // TS 6 的 BlobPart 只认 ArrayBuffer：复制一份，避开 Uint8Array<ArrayBufferLike> 的类型冲突
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `iJipu-设置备份-${new Date().toISOString().slice(0, 10)}.zip`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 排错/单测用：配置里引用到的附件名（不读盘） */
export function referencedBlobNamesForTest(values: Record<string, string>): string[] {
  return referencedBlobs(values)
}
