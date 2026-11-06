-- 0001_visits.sql — 访问计数（Cloudflare D1）
-- 同一 path + day + visitor + channel 一行，views 累加：
--   PV = SUM(views)；UV = COUNT(*)

CREATE TABLE IF NOT EXISTS visits (
  path TEXT NOT NULL,
  day TEXT NOT NULL,
  visitor TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'web',
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (path, day, visitor, channel)
);

CREATE INDEX IF NOT EXISTS visits_day ON visits(day);
