-- Phase 4-γ Backfill: friends → members (= bronze tier で seed、 2026-05-28)
--
-- 目的:
--   既存 friends 全件を members table に bronze tier で seed する。
--   Phase 4-γ deploy 後 1 回限り実行 (= 冪等、 既 row があれば skip)。
--
-- 設計理由:
--   - shopify_orders.friend_id IS NOT NULL = 0 件 (= 既存 customer は LINE friend 未紐付)
--   - 既存 friends は全員 bronze (= 累計 0 円) で seed
--   - 新規 order webhook から自然に累計加算 + tier promote 開始
--
-- 確認方法 (= 適用前):
--   SELECT COUNT(*) FROM friends;                                          -- 期待: 1 (Katsu のみ MVP 段階)
--   SELECT COUNT(*) FROM members;                                          -- 期待: 0 (= 未 seed)
--   SELECT COUNT(*) FROM friends LEFT JOIN members ON friends.id = members.friend_id WHERE members.id IS NULL;
--   -- ↑ backfill 対象数
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\backfill-members-from-friends.sql
--
-- 確認方法 (= 適用後):
--   SELECT COUNT(*) FROM members WHERE current_tier_id = 'bronze';
--   SELECT current_tier_id, COUNT(*) FROM members GROUP BY current_tier_id;

-- ============================================================
-- 1. friends → members (= bronze で seed、 冪等)
-- ============================================================

INSERT INTO members (
  id,
  friend_id,
  current_tier_id,
  total_purchase_jpy,
  total_referral_count,
  joined_at,
  created_at,
  updated_at
)
SELECT
  lower(hex(randomblob(16))),                    -- UUID-like (= D1 has no built-in uuid())
  f.id,
  'bronze',
  0,
  0,
  COALESCE(f.created_at, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
FROM friends f
WHERE NOT EXISTS (
  SELECT 1 FROM members WHERE members.friend_id = f.id
);

-- ============================================================
-- 2. audit log (= membership.backfill_completed)
-- ============================================================

INSERT INTO audit_logs (
  id,
  line_account_id,
  actor_type,
  actor_id,
  action,
  result,
  metadata,
  created_at
)
VALUES (
  lower(hex(randomblob(16))),
  NULL,
  'system',
  'script:backfill-members-from-friends.sql',
  'membership.backfill_completed',
  'success',
  json_object(
    'phase', '4-gamma',
    'tier_default', 'bronze',
    'note', 'friends to members seed, idempotent via NOT EXISTS'
  ),
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
