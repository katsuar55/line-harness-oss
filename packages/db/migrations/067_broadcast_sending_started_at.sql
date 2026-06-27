-- Migration 067: broadcasts.sending_started_at (= stuck-'sending' 安全自動復旧の基盤、 2026-06-28)
--
-- 背景 (採点 Round1 D1 HIGH):
--   claimBroadcastForSending で status を 'sending' に遷移した直後に worker が crash すると、
--   cron は 'scheduled' しか拾わないため永続 stuck になる。 旧 stuck 検知は scheduled_at 基準で、
--   手動送信 (scheduled_at=NULL) の stuck を検知できなかった。
--
-- 本 column:
--   - claim 時に sending_started_at=現在時刻 (JST) を記録 → 経過時間で stuck を正確に検知
--     (手動送信も含む)。
--   - 送信痕跡なし (line_request_id NULL かつ messages_log/email_messages_log 0 件) の stuck のみ
--     status='scheduled' に戻して安全に自動再送 (= 二重送信を起こさない)。
--   - 非破壊 (ALTER ADD COLUMN、 既存行は NULL = 旧 stuck 検知 fallback 対象外)。
--
-- 適用 (cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\067_broadcast_sending_started_at.sql

ALTER TABLE broadcasts ADD COLUMN sending_started_at TEXT;

CREATE INDEX IF NOT EXISTS idx_broadcasts_status_sending_started
  ON broadcasts (status, sending_started_at);
