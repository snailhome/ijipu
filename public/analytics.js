/**
 * public/analytics.js — 网站页面访问计数
 *
 * 统计站点页面：首页 / 应用 / 音视频工具 / 文档 / 乐谱库 / 单首乐谱。
 * 爱扒谱（ijipu-bp.pages.dev）是独立站点，它自己的 `public/analytics.js` 跨站上报 `/bp/`。
 * 生产环境才上报；visitor 是 localStorage 里的随机 id（不存 IP / UA）。
 * 桌面应用由 src/analytics/trackVisit.ts 走绝对地址上报。
 */
;(function () {
  try {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '') return
    if (location.protocol !== 'https:' && location.protocol !== 'http:') return

    var path = location.pathname.replace(/index\.html$/, '')
    if (path === '/scores') path = '/scores/'
    if (path === '/app') path = '/app/'
    if (path !== '/' && !path.endsWith('/')) path += '/'
    if (!/^\/(?:app\/|scores\/(?:[a-z0-9-]+\/)?|manual\/|syntax\/|plugin\/|cli\/|soundfonts\/|tools\/)?$/.test(path)) return

    var id = ''
    try {
      id = localStorage.getItem('ijipu.visitor') || ''
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) || 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
        localStorage.setItem('ijipu.visitor', id)
      }
    } catch {
      return
    }

    var channel = 'web'
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) channel = 'pwa'
    } catch {
      /* 保持 web */
    }

    var body = JSON.stringify({ path: path, visitor: id, channel: channel })
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/visit', new Blob([body], { type: 'application/json' }))
    } else {
      fetch('/api/visit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () {})
    }
  } catch {
    /* 统计失败不影响页面 */
  }
})()
