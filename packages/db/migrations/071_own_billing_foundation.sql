-- 071: Phase 3 自社課金基盤の基礎テーブル (WI-4 step 1)
-- 設計の正: docs/PHASE3_BILLING_DESIGN_2026-07-19.md §3 (v6, 全5次元90+)
-- 全テーブル additive・既存テーブル無改変・IF NOT EXISTS で冪等。
-- gate (SELF_BILLING_ENABLED 等) が全て OFF の間はどのコードパスも読み書きしない (dormant)。
-- 適用は Admin Ops workflow の apply-migration-071 op (wrangler d1 execute --file)。

-- 自社契約キャッシュ (サイクルの正は Shopify、本テーブルは現在サイクルのキャッシュ §2)
CREATE TABLE IF NOT EXISTS own_sub_contracts (
  contract_gid        TEXT PRIMARY KEY,
  shopify_customer_id TEXT NOT NULL,
  status              TEXT NOT NULL,          -- active|paused|cancelled|expired|failed
  current_cycle_index INTEGER,                -- 最古の未解決サイクル (§4.0)
  current_cycle_scheduled_date TEXT,          -- scheduleEdit 済み課金予定日 (JST)
  anchor_date         TEXT NOT NULL,          -- カデンツ起点 (承継課金日 or 初回課金日)
  interval_unit       TEXT NOT NULL,          -- 'DAY' のみサポート (§0)
  interval_count      INTEGER NOT NULL,
  payment_method_gid  TEXT,
  pending_new_card    INTEGER NOT NULL DEFAULT 0,  -- challenged 中のカード更新フラグ (§6.3)
  cadence_repair_needed INTEGER NOT NULL DEFAULT 0, -- scheduleEdit 失敗の修復待ち (§4.0)
  dunning_state       TEXT NOT NULL DEFAULT 'none',
      -- none|retry_wait|await_card|challenged|ops_hold|exhausted
  dunning_attempts    INTEGER NOT NULL DEFAULT 0,
  next_retry_date     TEXT,
  dunning_deadline_at TEXT,                   -- await_card / challenged の期限 (§6.2/§6.3)
  last_attempt_error  TEXT,                   -- code のみ (PII なし)
  source              TEXT NOT NULL,          -- migration|new
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_own_sub_contracts_due
  ON own_sub_contracts(status, dunning_state, current_cycle_scheduled_date);
CREATE INDEX IF NOT EXISTS idx_own_sub_contracts_customer
  ON own_sub_contracts(shopify_customer_id);

-- サイクル単位の課金 claim (attempt 発行の排他 §3。attempt 証跡の正は audit_logs)
CREATE TABLE IF NOT EXISTS billing_cycle_claims (
  contract_gid    TEXT NOT NULL,
  cycle_key       TEXT NOT NULL,              -- Shopify cycle_index
  status          TEXT NOT NULL,
      -- attempting|succeeded|failed|failed_no_attempt|skipped|abandoned
  retry_policy    TEXT NOT NULL DEFAULT 'none', -- none|next_tick|hold (§6.5)
  attempt_no      INTEGER NOT NULL DEFAULT 1,
  attempt_gid     TEXT,
  order_id        TEXT,                       -- success 時に記録 (双方向突合の連結キー)
  idempotency_key TEXT NOT NULL,              -- SHA-256("own-billing:{gid}:{cycle_key}:{attempt_no}")
  claimed_at      TEXT NOT NULL,
  resolved_at     TEXT,
  PRIMARY KEY (contract_gid, cycle_key)
);

CREATE INDEX IF NOT EXISTS idx_billing_cycle_claims_status
  ON billing_cycle_claims(status, claimed_at);

-- 移行 phase 機械 (§7)。pending_intent = §7.0 窓中の pause/cancel 意思 (v6)
CREATE TABLE IF NOT EXISTS sub_migration_snapshots (
  huckleberry_contract_id TEXT PRIMARY KEY,
  shopify_customer_id TEXT NOT NULL,
  snapshot_json       TEXT NOT NULL,          -- 全条件 + Flow 実測 + 直近 order_id
  own_contract_gid    TEXT,
  phase               TEXT NOT NULL,
      -- snapshotted|pending_card|own_created_paused|hb_stop_requested|
      -- huckleberry_stopped|billing_aligned|activated|rolled_back
  target_first_billing_date TEXT,             -- billing_aligned が確定する絶対日付
  pending_intent      TEXT,                   -- NULL|'pause'|'cancel' (§7.0)
  pending_intent_done INTEGER NOT NULL DEFAULT 0,
  phase_updated_at    TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_migration_snapshots_phase
  ON sub_migration_snapshots(phase);
CREATE INDEX IF NOT EXISTS idx_sub_migration_snapshots_own_gid
  ON sub_migration_snapshots(own_contract_gid);

-- 通知冪等マーカー (§3): (contract, cycle, attempt, kind) 単位で 1 通
-- kind = fail_notice|card_request|challenge_link|pause_notice|resume_notice|delivery_notice
CREATE TABLE IF NOT EXISTS own_billing_notices (
  contract_gid TEXT NOT NULL,
  cycle_key    TEXT NOT NULL,
  attempt_no   INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  sent_at      TEXT NOT NULL,
  PRIMARY KEY (contract_gid, cycle_key, attempt_no, kind)
);

-- 運用状態 KV (§8)。既知 key: breaker_tripped_at (行が存在 = breaker trip 中)
CREATE TABLE IF NOT EXISTS own_billing_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- EXCLUDELIST の D1 側 (§8: 実効 EXCLUDELIST = secret リスト ∪ 本テーブル。
-- Worker は自身の secret を書き換えられないため、§7③ の自動隔離はここへ INSERT)
CREATE TABLE IF NOT EXISTS own_billing_quarantine (
  contract_gid TEXT PRIMARY KEY,
  reason       TEXT NOT NULL,
  added_at     TEXT NOT NULL
);
