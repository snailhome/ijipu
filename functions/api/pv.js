/**
 * functions/api/pv.js — 首页页脚用的公开总 PV
 *
 * 只暴露总访问量，不暴露页面明细；明细仍在需要 STATS_TOKEN 的 /api/stats。
 */
import { ensureVisitsTable, isMissingTable } from '../_lib/visits.js'

const CORS = { 'Access-Control-Allow-Origin': '*' }

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, ...extra, 'content-type': 'application/json; charset=utf-8' },
  })
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json(503, { error: '统计数据库未绑定' })
  try {
    const row = await env.DB.prepare('SELECT SUM(views) AS pv FROM visits').first()
    return json(200, { pv: Number(row?.pv) || 0 }, { 'cache-control': 'public, max-age=60' })
  } catch (e) {
    if (!isMissingTable(e)) return json(500, { error: '读取失败' })
    try {
      await ensureVisitsTable(env)
      return json(200, { pv: 0 }, { 'cache-control': 'public, max-age=60' })
    } catch {
      return json(500, { error: '读取失败' })
    }
  }
}
