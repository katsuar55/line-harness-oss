-- Migration 073: sub_link_tokens テーブル (= サブスク連携獲得キット / magic-link、 2026-07-24)
--
-- 目的:
--   稼働中サブスク顧客 (本番実測 112 名) のうち LINE 連携済は 3 名のみ (2.7%)、 自前 email 到達は 0 名。
--   決済リマインド等を LINE で作っても 109 名に届かないため、 まず「連携率」を上げる必要がある。
--   本テーブルは、 店舗が顧客へ送る email/挿入物に載せる「1タップ連携リンク」の使い捨てトークンを保存する。
--   顧客がリンクを開く → (未友だちなら友だち追加) → LIFF で自分の LINE と定期購入を連携。
--   OTP 入力不要 = 顧客の受信箱に届いた事実が email 所有の証明 (= 転送耐性は single-use + UNIQUE 制約で担保)。
--
-- セキュリティ設計 (= なぜ D1 テーブルが要るか):
--   - token = 160bit crypto ランダム (base64url)。 推測不能なので HMAC 署名は不要 (row 自体が真実源)。
--   - single-use: consumed_at の CAS (IS NULL → now) で二重消費を防ぐ。 転送された link を 2 人が踏んでも
--     先着 1 人のみ連携できる。
--   - 連携先の一意性は friends.shopify_customer_id の UNIQUE partial index が DB レベルで担保
--     (= 1 customer ≤ 1 friend)。 既連携顧客の乗っ取りは redeem 側の事前検査 + UNIQUE 制約で二重に防ぐ。
--   - gate: SUB_LINK_ENABLED='true' でなければ生成 API/redeem とも no-op (= 本番 dormant)。
--   - PII: token/customer_id/friend_id のみ保持。 email/氏名は保存しない (audit_logs にも残さない)。
--
-- 設計:
--   - transient: expires_at (既定 発行+30日) 経過 or consumed 済は無効。 24h 超の消費済は cleanup 可 (別 PR)。
--   - 非破壊 (= CREATE TABLE IF NOT EXISTS + index)。 既存テーブル不変・additive・冪等。
--
-- 適用方法 (= cwd: apps/worker、 または GitHub Actions "Admin Ops" apply-migration-073):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\073_sub_link_tokens.sql

CREATE TABLE IF NOT EXISTS sub_link_tokens (
  token TEXT PRIMARY KEY,                 -- 160bit base64url ランダム (= link の capability)
  shopify_customer_id TEXT NOT NULL,      -- 連携先 Shopify customer (= redeem で friends に紐付ける対象)
  batch_id TEXT NOT NULL,                 -- 生成バッチ ID (= キャンペーン単位のグルーピング/集計)
  expires_at TEXT NOT NULL,               -- ISO8601 (= now + TTL)。 preview/redeem は過去なら拒否
  consumed_at TEXT,                       -- single-use CAS (NULL → now)。 消費済は再利用不可
  consumed_by_line_user_id TEXT,          -- 監査: 消費した検証済 LINE userId
  consumed_friend_id TEXT,                -- 監査: 実際に紐付いた friend 行
  created_at TEXT NOT NULL
);

-- 顧客別の既存トークン検索 (= 再生成時に旧 unconsumed を掃除する / 集計)
CREATE INDEX IF NOT EXISTS idx_sub_link_tokens_customer
  ON sub_link_tokens(shopify_customer_id);

-- バッチ別集計・掃除用
CREATE INDEX IF NOT EXISTS idx_sub_link_tokens_batch
  ON sub_link_tokens(batch_id, created_at);
