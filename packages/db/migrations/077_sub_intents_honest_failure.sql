-- Migration 077: sub_intents 誠実な失敗 — 代行3層の残り (§10-4、 2026-08-07)
--
-- 目的 (docs/SUBSCRIPTION_UX_TAP_MINIMAL_2026-07-25.md §4-1〜§4-4):
--   §4-1 promised_by: 受理時に営業カレンダーから算出 (列は 076 で作成済み・本 migration で使用開始)
--   §4-2 約束破り sweep: promised_by < now の received に「お時間をいただいています」1 intent 1 回
--   §4-3 実行漏れの機械検出: done 後に op 別照合 (ok/miss/判定保留の 3 値)
--   §4-4 cancel 救済: 締切 24h 前の未実行 cancel を強制エスカレーション
--
-- 通知マーカーは目的ごとに別列 (§1-2 の教訓 — 1 列共有は片方の消費でもう片方が沈黙する。
-- escalated_at / stale_alerted_at の分離と同じ規律):
--   promise_alerted_at       §4-2 約束破り通知済み (1 intent 1 回。リセットしない)
--   predeadline_escalated_at §4-4 締切24h前エスカレーション済み (繰越しでリセット =
--                            次サイクルの締切にも新しいアラート枠を与える)
--
-- §4-3 検証列:
--   verify_state         NULL(対象外/未完了) | 'pending' | 'ok' | 'miss' | 'inconclusive'(判定保留)
--   verify_baseline_json 受理時点の契約スナップショット (estimate/source/intervalDays/skipCount/
--                        orderCount/acceptedAt)。**done 時でなく受理時に採取** — スタッフ実行と
--                        webhook 反映の順序 race で基準値が汚れるのを構造的に避ける
--   verified_at          verdict 確定時刻
--
-- 非破壊 (= ALTER TABLE ADD COLUMN のみ)。既存データ無改変・additive。
-- ⚠️ SQLite の ALTER TABLE ADD COLUMN は冪等でない (重複適用は duplicate column error)。
--    d1_migrations の管理外で手動適用する場合は列の有無を先に確認すること。
--
-- 適用方法 (= cwd: apps/worker、 または GitHub Actions "Admin Ops" apply-migration-077):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\077_sub_intents_honest_failure.sql

ALTER TABLE sub_intents ADD COLUMN promise_alerted_at TEXT;
ALTER TABLE sub_intents ADD COLUMN predeadline_escalated_at TEXT;
ALTER TABLE sub_intents ADD COLUMN verify_state TEXT;
ALTER TABLE sub_intents ADD COLUMN verify_baseline_json TEXT;
ALTER TABLE sub_intents ADD COLUMN verified_at TEXT;

-- §4-3 検証待ちの sweep 経路 (pending のみの partial index = 台帳が育っても走査コスト一定)
CREATE INDEX IF NOT EXISTS idx_sub_intents_verify_pending
  ON sub_intents(verify_state)
  WHERE verify_state = 'pending';
