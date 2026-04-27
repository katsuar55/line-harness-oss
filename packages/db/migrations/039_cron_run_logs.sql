-- Phase 5 PR-4: Cron 死活監視
--
-- cron_run_logs: 定期 job の実行履歴を残し、
--   - 最終成功時刻
--   - status (success / skipped / error / partial)
--   - metrics (evaluated / generated / pushed 等の JSON)
-- を記録する。services/cron-monitor.ts が毎日 1 回 (JST 09:00 ウィンドウ)
-- これを参照し、最終成功からの経過時間が rule の threshold を超えたら
-- Discord webhook で通知する。
--
-- 設計方針:
-- - job_name + ran_at DESC index で「最終成功」を 1 行で取得できる
-- - metrics_json は自由 JSON。schema 変更せずに新 cron を追加できる
-- - error_summary は 200 字以内のサマリ (Error.message を切り詰めて入れる)

CREATE TABLE IF NOT EXISTS cron_run_logs (
  id            TEXT PRIMARY KEY,
  job_name      TEXT NOT NULL,
  ran_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  status        TEXT NOT NULL,
  metrics_json  TEXT,
  error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_run_logs_job_ran
  ON cron_run_logs (job_name, ran_at DESC);
