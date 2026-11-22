/**
 * tools/zip.ts — 最小 ZIP 打包（store，不压缩）（adj1316）
 *
 * 为什么不直接用 `src/export/zip.ts`：那份的 `writeZip` 依赖 `@ijipu/engine` 的 `crc32`，
 * 静态 import 会把整块简谱引擎拖进这个独立页面。这里自己算 CRC32（16 行表），其余格式照搬：
 *  · 只写 store（method 0）条目 —— 内容是 WAV/MP3，本来就不该再压；
 *  · 文件名 UTF-8（通用位标志 0x0800）。
 */

const ENC = new TextEncoder()

/** CRC32 查表（IEEE 802.3，与 zip 规范一致） */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  /** zip 内的文件名（用 `/` 分隔；含中文没问题） */
  name: string
  data: Uint8Array
}

/** 打包成 zip 字节（DOS 时间固定用当前时刻，不参与内容判等） */
export function writeZipStore(files: ZipEntry[]): Uint8Array {
  const now = new Date()
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const file of files) {
    const name = ENC.encode(file.name)
    const crc = crc32(file.data)
    const local = new Uint8Array(30 + name.length)
    const ldv = new DataView(local.buffer)
    ldv.setUint32(0, 0x04034b50, true)
    ldv.setUint16(4, 20, true)
    ldv.setUint16(6, 0x0800, true)
    ldv.setUint16(10, time, true)
    ldv.setUint16(12, date, true)
    ldv.setUint32(14, crc, true)
    ldv.setUint32(18, file.data.length, true)
    ldv.setUint32(22, file.data.length, true)
    ldv.setUint16(26, name.length, true)
    local.set(name, 30)
    locals.push(local, file.data)

    const central = new Uint8Array(46 + name.length)
    const cdv = new DataView(central.buffer)
    cdv.setUint32(0, 0x02014b50, true)
    cdv.setUint16(4, 20, true)
    cdv.setUint16(6, 20, true)
    cdv.setUint16(8, 0x0800, true)
    cdv.setUint16(12, time, true)
    cdv.setUint16(14, date, true)
    cdv.setUint32(16, crc, true)
    cdv.setUint32(20, file.data.length, true)
    cdv.setUint32(24, file.data.length, true)
    cdv.setUint16(28, name.length, true)
    cdv.setUint32(42, offset, true)
    central.set(name, 46)
    centrals.push(central)
    offset += local.length + file.data.length
  }

  const centralSize = centrals.reduce((n, p) => n + p.length, 0)
  const eocd = new Uint8Array(22)
  const edv = new DataView(eocd.buffer)
  edv.setUint32(0, 0x06054b50, true)
  edv.setUint16(8, files.length, true)
  edv.setUint16(10, files.length, true)
  edv.setUint32(12, centralSize, true)
  edv.setUint32(16, offset, true)

  const out = new Uint8Array(offset + centralSize + eocd.length)
  let p = 0
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p)
    p += part.length
  }
  return out
}
