-- Migration 064: account_link_codes テーブル (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
--
-- 目的:
--   CRM PLUS on LINE / Social PLUS に依存せず、 LINE ハーネス単体で friend↔Shopify customer を
--   連携させる「LIFF + email OTP 本人確認」 フローの OTP コードを保存する。
--   友だちが LIFF で自分の Shopify 注文 email を入力 → 6桁 OTP を email 送信 → OTP 検証で
--   email 所有を証明 → その email の Shopify customer を friends.shopify_customer_id に紐付ける。
--
-- セキュリティ設計 (= OTP テーブルが必要な理由):
--   - OTP は 6桁 (10^6) のため、 stateless 署名トークンだと総当たり可能 → 試行回数制限が必須。
--     試行回数を server-side で数えるため D1 テーブルで状態を持つ。
--   - code_hash = HMAC-SHA256(ACCOUNT_LINK_HMAC_KEY pepper, "{friend_id}:{email}:{code}") の hex。
--     平文 OTP は保存しない。 pepper (server secret、 D1 外) により D1 dump 単体の offline 総当たりを防ぐ。
--   - attempts >= MAX (= 5) で lock (consumed_at を埋めて無効化)。 online 総当たりは 5/10^6 で不能。
--   - request レート制限は friend_id + created_at 窓で件数を数える (= email 爆撃防止)。
--   - consumed_at による single-use (= CAS 消費)。 新規発行時に同 (friend,email) の旧 active code を無効化。
--
-- 設計:
--   - 全列 transient (= OTP は短 TTL 5分、 別途 cleanup 可能)。 email は本人入力の自分の email (= 連携同意済)。
--   - PII 最小化: audit_logs には email を残さない (= friend_id / customer_id で識別)。 email は本テーブルのみ。
--   - 非破壊 (= CREATE TABLE IF NOT EXISTS + index)。 既存テーブル不変。
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\064_account_link_codes.sql

CREATE TABLE IF NOT EXISTS account_link_codes (
  id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL,
  email TEXT NOT NULL,                 -- lowercased 受信者 email (= 本人入力)
  code_hash TEXT NOT NULL,             -- HMAC-SHA256(pepper, "friend_id:email:code") hex
  expires_at TEXT NOT NULL,            -- ISO8601 (= now + TTL)
  attempts INTEGER NOT NULL DEFAULT 0, -- verify 試行回数 (= MAX 到達で lock)
  consumed_at TEXT,                    -- single-use: 成功 / lock / 旧 code 無効化 で埋まる
  created_at TEXT NOT NULL
);

-- rate-limit (= friend ごとの直近発行件数) の窓クエリ用
CREATE INDEX IF NOT EXISTS idx_account_link_codes_friend_created
  ON account_link_codes(friend_id, created_at);

-- verify 時の active code 逆引き (= friend + email + 未消費 + 未失効) 用
CREATE INDEX IF NOT EXISTS idx_account_link_codes_lookup
  ON account_link_codes(friend_id, email);
