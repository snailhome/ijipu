/**
 * analytics/trackVisit.ts — 应用（网页 / PWA / 桌面壳）访问计数
 *
 * 网站静态页面用 public/analytics.js；这里只负责 `/app/`：
 *  · 网页/PWA：同站相对接口；
 *  · 桌面壳：绝对地址 `https://ijipu.pages.dev/api/visit`（CORS 已由 Functions 放行）。
 *
 * visitor 是 localStorage 里的随机 id，不存 IP / UA；失败静默，不影响应用。
 */
import { isDevBuild, isTauriShell } from '../brand/env'
import { brand } from '../brand/tokens'

const VISITOR_KEY = 'ijipu.visitor'

function visitorId(): string {
  try {
    const old = localStorage.getItem(VISITOR_KEY)
    if (old) return old
    const id =
      (globalThis.crypto?.randomUUID && globalThis.crypto.randomUUID()) ||
      `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(VISITOR_KEY, id)
    return id
  } catch {
    return ''
  }
}

function channelOf(): 'desktop' | 'pwa' | 'web' {
  if (isTauriShell()) return 'desktop'
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return 'pwa'
  } catch {
    /* web */
  }
  return 'web'
}

/** 每个应用窗口启动上报一次；只统计 /app/，不统计编辑中的具体文件 */
export function trackAppVisit(): void {
  if (isDevBuild()) return
  if (typeof window === 'undefined') return
  const tauri = isTauriShell()
  if (!tauri && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) return

  const visitor = visitorId()
  if (visitor === '') return
  const endpoint = tauri ? `${brand.siteUrl}/api/visit` : '/api/visit'
  const body = JSON.stringify({ path: '/app/', visitor, channel: channelOf() })

  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }))
    } else {
      void fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {})
    }
  } catch {
    /* 统计失败不影响应用 */
  }
}
