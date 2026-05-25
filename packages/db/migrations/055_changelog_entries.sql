-- Migration 055: changelog_entries_seen table (= 自動 update 戦略 #2、 2026-05-26)
--
-- 目的:
--   Cloudflare developer changelog (= RSS feed 4 categories) を daily cron で fetch、
--   未通知 entry のみ Discord 通知。 同 entry を二度通知しないため、 entry URL を
--   key として通知済 marker を保持。
--
-- 関連:
--   - 戦略 #1 (migration 054) = ai_models_catalog (= 個別 model 検出)
--   - 戦略 #2 (本 migration) = changelog 全般 (= 新機能 / breaking change / deprecation)
--
-- schema:
--   - id TEXT PK (= UUID)
--   - entry_url TEXT UNIQUE NOT NULL (= e.g. 'https://developers.cloudflare.com/changelog/2026-05-26-...')
--   - title TEXT NOT NULL
--   - category TEXT NOT NULL (= 'workers-ai' / 'workers' / 'd1' / 'r2' / 'general')
--   - published_at TEXT (= RSS の pubDate を ISO 8601 化)
--   - first_seen_at TEXT (= cron で初回検出した時刻 JST)
--   - notified_at TEXT NULLABLE (= Discord 通知済時刻、 NULL なら未通知)
--   - description TEXT NULLABLE (= entry 抜粋、 Discord 通知 body 用)
--
-- index:
--   - category + published_at DESC: カテゴリ別新着取得
--   - notified_at IS NULL: 未通知抽出 (= 部分 INDEX で高速化)
--   - first_seen_at DESC: 新着順
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\055_changelog_entries.sql

CREATE TABLE IF NOT EXISTS changelog_entries_seen (
  id             TEXT PRIMARY KEY,
  entry_url      TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  category       TEXT NOT NULL,
  published_at   TEXT,
  first_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  notified_at    TEXT,
  description    TEXT
);

CREATE INDEX IF NOT EXISTS idx_changelog_seen_category
  ON changelog_entries_seen(category, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_changelog_seen_unnotified
  ON changelog_entries_seen(category, first_seen_at DESC)
  WHERE notified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_changelog_seen_first
  ON changelog_entries_seen(first_seen_at DESC);
