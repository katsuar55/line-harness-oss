-- Migration 052: friends に birth_month + age_group 追加 (Phase 1 ULTRATHINK MVP、 2026-05-24)
--
-- 背景:
--   LP launch 前 welcome scenario rebrush で、 friend 追加直後に「お誕生月」 「年代」 を
--   user 主導 (= postback button tap) で取得し、 Phase 2 の月 1 通信 + 誕生月特典 + Phase 3
--   AI 個別化 で活用するため、 friends に 2 column 追加。
--
-- 既存 column (= 残置):
--   - birthday TEXT NULL (= 既存、 過去仕様、 YYYY-MM-DD 想定。 今回は使わず別 column を新設)
--
-- 新 column:
--   - birth_month INTEGER NULL  -- 1-12 (= 誕生月のみ取得、 日付は聞かない user 指示)
--   - age_group TEXT NULL       -- '10s' / '20s' / '30s' / '40s' / '50s' / '60s' / '70+'
--
-- index:
--   - birth_month: 毎月 1 日に「今月誕生月の friend」 を抽出する birthday cron 用 (= Phase 2)
--   - age_group: 年代別セグメント broadcast 用 (= Phase 2)
--
-- 適用方法 (= cwd: apps/worker、 d1_migrations state は PR #47 で復活済):
--   npx wrangler d1 migrations apply naturism-line-crm --remote
--   または直接:
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\052_friend_demographics.sql
--
-- revert (= 必要時):
--   ALTER TABLE friends DROP COLUMN birth_month;
--   ALTER TABLE friends DROP COLUMN age_group;
--   (SQLite 3.35+ で DROP COLUMN サポート、 production D1 は対応)

ALTER TABLE friends ADD COLUMN birth_month INTEGER NULL CHECK (birth_month IS NULL OR (birth_month >= 1 AND birth_month <= 12));
ALTER TABLE friends ADD COLUMN age_group TEXT NULL CHECK (age_group IS NULL OR age_group IN ('10s', '20s', '30s', '40s', '50s', '60s', '70+'));

CREATE INDEX IF NOT EXISTS idx_friends_birth_month
  ON friends(birth_month)
  WHERE birth_month IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_friends_age_group
  ON friends(age_group)
  WHERE age_group IS NOT NULL;
