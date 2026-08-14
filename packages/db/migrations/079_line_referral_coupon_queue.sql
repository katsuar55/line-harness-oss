-- Migration 079: line_referral_coupon_queue — 紹介クーポンの順次活性化 (queue)
-- 2026-08-13 Katsu 確定要件 R1:
--   紹介クーポンは複数「保有」できるが、1 注文で使えるのは必ず 1 枚 (¥1,000 への合算は NG)。
--   Shopify の combinesWith はクラス単位の握手のみで「紹介×紹介だけ禁止」は原理的に不可能なため、
--   **Shopify 上に生きた紹介コードを friend につき常に最大 1 枚**にすることで物理的に保証する。
--   2 枚目以降の紹介成立はこの queue に waiting で積み、使用検知 (orders webhook) /
--   失効 (期限 sweep) / ポータル閲覧 (pull 検算) を契機に次の 1 枚を Shopify に発行する。
--
-- 設計:
--   - reward_id UNIQUE = 紹介成立 (referral_rewards) 1 件につき queue 1 行 (冪等キー)。
--     台帳 line_referral_coupons.reward_id UNIQUE と対で二重発行を防ぐ。
--   - planned_code = 活性化時に使う予定の code を先に確保しておく。activating で落ちた行の
--     再駆動時に同じ code で再試行することで、Shopify 側の code 重複エラーを「既に作成済み」の
--     シグナルとして使える (= 二重発行の自然防止)。
--   - status: waiting → activating → activated / cancelled。
--     「friend につき activating は同時 1 行まで + 生きた issued 台帳行が無いときだけ claim 成立」
--     は単文 UPDATE の WHERE (D1 は write を直列化) で強制する (アプリ層 SQL 参照:
--     packages/db/src/referral-coupon-queue.ts)。
--   - 有効期限は**活性化時点から起算** (待機中は減らない = 顧客に不利にならない)。
--     よってこのテーブルに expires_at は持たない。
--   - additive only (live-safe)。既存テーブルへの変更なし。
CREATE TABLE IF NOT EXISTS line_referral_coupon_queue (
  id                    TEXT PRIMARY KEY,
  friend_id             TEXT NOT NULL,                  -- referrer (紹介した側)
  reward_id             TEXT NOT NULL UNIQUE,           -- referral_rewards.id (冪等キー)
  line_account_id       TEXT,
  planned_code          TEXT NOT NULL,                  -- 活性化時に使う予定の NREF- code
  discount_value        INTEGER NOT NULL DEFAULT 500,   -- 値引き額 (発行時の台帳が正)
  status                TEXT NOT NULL DEFAULT 'waiting'
                        CHECK (status IN ('waiting', 'activating', 'activated', 'cancelled')),
  created_at            TEXT NOT NULL,                  -- 獲得 (紹介成立) 時刻 = FIFO の順序
  activation_started_at TEXT,                           -- activating に入った時刻 (stuck 検出)
  activated_at          TEXT,
  activated_coupon_id   TEXT,                           -- 活性化後の line_referral_coupons.id
  metadata              TEXT,                           -- JSON (再駆動履歴等)
  FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE SET NULL
);

-- 活性化候補の走査 (friend × status × FIFO) と待機枚数カウントの両方をこの 1 本で賄う
CREATE INDEX IF NOT EXISTS idx_lrcq_friend_status_created
  ON line_referral_coupon_queue(friend_id, status, created_at);
