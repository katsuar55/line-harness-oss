-- 070: サブスク決済失敗リカバリ通知の pending/notified マーカー (WI-2 採点R1 対応)
-- 検知 (customers/update の pause タグ遷移) と送信 (teiki-billing-reminder cron の
-- JST 10-20時窓・CAS claim) を分離するための列。即時 push 方式の欠陥
-- (深夜送信・送信失敗で通知が永久喪失・並行 webhook で二重送信) を解消する。
ALTER TABLE subscription_contracts ADD COLUMN recovery_pending_at TEXT;
ALTER TABLE subscription_contracts ADD COLUMN recovery_notified_at TEXT;
