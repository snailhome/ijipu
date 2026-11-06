/**
 * functions/_lib/visits.js — D1 visits 表的建表兜底
 *
 * 正常流程用 migrations/0001_visits.sql；这里只在“表还没建”时补一次，
 * 避免绑定好了但第一次访问直接 500。CREATE 语句固定，不拼接任何用户输入。
 */
export async function ensureVisitsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS visits (
       path TEXT NOT NULL,
       day TEXT NOT NULL,
       visitor TEXT NOT NULL,
       channel TEXT NOT NULL DEFAULT 'web',
       views INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (path, day, visitor, channel)
     )`,
  ).run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS visits_day ON visits(day)').run()
}

export function isMissingTable(error) {
  return /no such table|does not exist/i.test(String(error?.message ?? error))
}
