/**
 * tools/files.ts — 下载、文件名、时长显示（adj1316）
 *
 * 这个页面没有 Tauri、没有插件宿主：产物一律走浏览器的 `<a download>`（与 `src/export/export.ts`
 * 同一条路，但那边绑着应用的 store，独立页面用不了）。
 */

import { toolsCopy } from './copy'

/** 二进制 → 下载（块拷贝成独立的 ArrayBuffer，避免 TS 的 `ArrayBufferLike` 之争） */
export function downloadBytes(bytes: Uint8Array, name: string, type: string): void {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  downloadBlob(new Blob([buf], { type }), name)
}

/** Blob → 下载 */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让 Safari 下不到；给 10 秒缓冲
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 去掉扩展名，留一个能当文件名用的基名 */
export function baseNameOf(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || toolsCopy.common.fallback.audio
}

/** 文件名里不能出现的字符换成空格（Windows / macOS / Linux 取并集） */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || toolsCopy.common.fallback.untitled
}

/** 秒 → `0:03.412`（波形轴与选区都用这一种写法） */
export function clockOf(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  const whole = Math.floor(rest)
  const ms = Math.round((rest - whole) * 1000)
  return `${m}:${String(whole).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/** 字节 → `1.6 MB` */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(0)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}
