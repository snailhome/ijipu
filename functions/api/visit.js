/**
 * functions/api/visit.ts — Cloudflare Pages Function：页面访问计数
 *
 * POST { path, visitor, channel }
 *  · path 只允许 /、/app/、/scores/、/scores/<slug>/
 *  · 同一天 + 同一路径 + 同一 visitor + 同一 channel 只保留一行，
 *    views 累加 ⇒ PV = SUM(views)，UV = COUNT(*)
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

const PATH_RE = /^\/(?:app\/|scores\/(?:[a-z0-9-]+\/)?)?$/
const CHANNELS = new Set(['web', 'pwa', 'desktop'])

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function shanghaiDay(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json(503, { error: '统计数据库未绑定' })
    if (!request.headers.get('content-type')?.includes('application/json')) {
      return json(415, { error: '需要 application/json' })
    }
    const body = await request.json()
    const path = typeof body.path === 'string' ? body.path : ''
    const visitor = typeof body.visitor === 'string' ? body.visitor : ''
    const channel = typeof body.channel === 'string' ? body.channel : 'web'

    if (!PATH_RE.test(path)) return json(400, { error: 'path 不在统计范围' })
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(visitor)) return json(400, { error: 'visitor 不合法' })
    if (!CHANNELS.has(channel)) return json(400, { error: 'channel 不合法' })

    await env.DB.prepare(
      `INSERT INTO visits(path, day, visitor, channel, views)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(path, day, visitor, channel) DO UPDATE SET views = views + 1`,
    )
      .bind(path, shanghaiDay(), visitor, channel)
      .run()

    return new Response(null, { status: 204, headers: CORS })
  } catch {
    return json(500, { error: '记录失败' })
  }
}
