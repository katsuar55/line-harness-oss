-- =============================================
-- 032: Feature Gap v2 — ステータス管理・ユーザー情報拡充・担当者・LINE内購入
-- DMMチャットブースト for EC 完全パリティ
-- =============================================

-- ⑮ Per-friend ステータス管理（チャットではなく友だち単位）
-- gender, birthday already exist from earlier migration
ALTER TABLE friends ADD COLUMN status TEXT NOT NULL DEFAULT 'none';
CREATE INDEX IF NOT EXISTS idx_friends_status ON friends(status);

-- ⑲ ユーザー情報拡充（住所・電話・メール・メモ）
-- gender/birthday already added in prior migration
ALTER TABLE friends ADD COLUMN phone TEXT;
ALTER TABLE friends ADD COLUMN email TEXT;
ALTER TABLE friends ADD COLUMN address TEXT;
ALTER TABLE friends ADD COLUMN memo TEXT;

-- ⑳ 担当者割り当て（友だち単位）
ALTER TABLE friends ADD COLUMN assigned_staff_id TEXT REFERENCES staff_members(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_friends_assigned_staff ON friends(assigned_staff_id);

-- ㉘ LINE内カート（LIFF購入フロー用）
CREATE TABLE IF NOT EXISTS liff_carts (
  id                TEXT PRIMARY KEY,
  friend_id         TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  shopify_variant_id TEXT NOT NULL,
  shopify_product_id TEXT,
  title             TEXT,
  image_url         TEXT,
  price             REAL NOT NULL DEFAULT 0,
  quantity          INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_liff_carts_friend ON liff_carts(friend_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_liff_carts_friend_variant ON liff_carts(friend_id, shopify_variant_id);
