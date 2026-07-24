-- 072: Phase 3 自社課金基盤 — 通知キュー (WI-4 step 3)
-- 設計の正: docs/PHASE3_BILLING_DESIGN_2026-07-19.md §5.6 (通知キュー配送 JST 10:00-19:59) /
--           §3 (通知冪等マーカー = (contract, cycle, attempt, kind)) / §2 (チャネル規則)
--
-- additive・既存テーブル無改変・IF NOT EXISTS で冪等。
-- gate (SELF_BILLING_ENABLED) が OFF の間はどのコードパスも読み書きしない (dormant)。
--
-- 071 の own_billing_notices との責務分界:
--   own_billing_notices        = 「実際に送信できた」永続マーカー (§3)。送信成功時のみ INSERT。
--   own_billing_notice_queue   = 送信予定/送信中/失敗の作業キュー。UNIQUE 制約が enqueue の
--                                冪等性を担保する (同一 (contract, cycle, attempt, kind) は 1 行)。
-- 二段にする理由: enqueue 時点で claim (UNIQUE) を取ることで、webhook 再配送や複数 tick の
-- 競合があっても「同じ通知を 2 通送る」経路を構造的に消す。実送信は別トランザクションのため、
-- 送信直前に status を CAS ('queued' -> 'sending') して配送側でも排他する。

CREATE TABLE IF NOT EXISTS own_billing_notice_queue (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_gid      TEXT NOT NULL,
  cycle_key         TEXT NOT NULL,
  attempt_no        INTEGER NOT NULL,
  kind              TEXT NOT NULL,
      -- fail_notice|card_request|challenge_link|pause_notice|resume_notice|delivery_notice
  shopify_customer_id TEXT NOT NULL,
  payload_json      TEXT NOT NULL,   -- 文面組立パラメータ (PII 最小: 金額/日付/URL のみ)
  status            TEXT NOT NULL DEFAULT 'queued',
      -- queued|sending|sent|failed|abandoned
  channel           TEXT,            -- line|email (確定時に記録)
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,            -- 分類済みの短い理由のみ (PII なし)
  queued_at         TEXT NOT NULL,
  -- 'sending' へ CAS した時刻。**reaper はこの列で判定する**。
  -- queued_at で判定すると、配送窓 (JST10-20) と enqueue 時刻の差により拾った瞬間から
  -- reap 対象になり、排他が実質無効化されて同じ通知を 2 通送りうる。
  sending_at        TEXT,
  sent_at           TEXT,
  UNIQUE (contract_gid, cycle_key, attempt_no, kind)
);

CREATE INDEX IF NOT EXISTS idx_own_billing_notice_queue_pending
  ON own_billing_notice_queue(status, queued_at);
