/**
 * functions/api/stats.ts — 访问统计（需要 STATS_TOKEN）
 *
 * GET /api/stats?days=30
 * Authorization: Bearer <STATS_TOKEN>
 *
 * 返回首页 / 应用 / 乐谱库 / 每首谱的 PV、UV。
 */
import { ensureVisitsTable, isMissingTable } from '../_lib/visits.js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function fromDay(days) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 - (days - 1) * 86400 * 1000)
  return d.toISOString().slice(0, 10)
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json(503, { error: '统计数据库未绑定' })
  const expected = env.STATS_TOKEN
  if (!expected) return json(503, { error: '未设置 STATS_TOKEN' })
  const auth = request.headers.get('authorization') ?? ''
  if (auth !== `Bearer ${expected}`) return json(401, { error: '需要统计令牌' })

  const url = new URL(request.url)
  const days = Math.min(3650, Math.max(1, Number(url.searchParams.get('days')) || 30))
  const since = fromDay(days)

  const rows = await env.DB.prepare(
    `SELECT path, SUM(views) AS pv, COUNT(*) AS uv
       FROM visits
      WHERE day >= ?
      GROUP BY path`,
  )
    .bind(since)
    .all()
    .catch(async (e) => {
      if (!isMissingTable(e)) throw e
      await ensureVisitsTable(env)
      return { results: [] }
    })

  const dailyRows = await env.DB.prepare(
    `SELECT day, SUM(views) AS pv, COUNT(*) AS uv
       FROM visits
      WHERE day >= ?
      GROUP BY day
      ORDER BY day`,
  )
    .bind(since)
    .all()
    .catch(async (e) => {
      if (!isMissingTable(e)) throw e
      await ensureVisitsTable(env)
      return { results: [] }
    })

  const daily = (dailyRows.results ?? []).map((row) => ({
    day: String(row.day),
    pv: Number(row.pv) || 0,
    uv: Number(row.uv) || 0,
  }))

  const pages = {
    home: { pv: 0, uv: 0 },
    app: { pv: 0, uv: 0 },
    library: { pv: 0, uv: 0 },
  }
  const docs = {
    '/manual/': { pv: 0, uv: 0 },
    '/syntax/': { pv: 0, uv: 0 },
    '/plugin/': { pv: 0, uv: 0 },
    '/cli/': { pv: 0, uv: 0 },
    '/soundfonts/': { pv: 0, uv: 0 },
  }
  const scores = {}
  let totalPv = 0
  let totalUv = 0

  for (const row of rows.results ?? []) {
    const pv = Number(row.pv) || 0
    const uv = Number(row.uv) || 0
    totalPv += pv
    totalUv += uv
    if (row.path === '/') {
      pages.home = { pv, uv }
    } else if (row.path === '/app/') {
      pages.app = { pv, uv }
    } else if (row.path === '/scores/') {
      pages.library = { pv, uv }
    } else if (Object.prototype.hasOwnProperty.call(docs, row.path)) {
      docs[row.path] = { pv, uv }
    } else {
      const m = /^\/scores\/([a-z0-9-]+)\/$/.exec(row.path)
      if (m) scores[m[1]] = { pv, uv }
    }
  }

  return json(200, {
    generatedAt: new Date().toISOString(),
    days,
    since,
    totals: { pv: totalPv, uv: totalUv },
    pages,
    docs,
    scores,
    daily,
  })
}
