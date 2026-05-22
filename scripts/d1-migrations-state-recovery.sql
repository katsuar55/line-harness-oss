-- D1 migrations state recovery (one-shot, 2026-05-22)
--
-- 背景:
--   production の `d1_migrations` table が 0 rows (= state drift) のため、
--   `wrangler d1 migrations apply` が全 migration を「未適用」と判定して再試行 →
--   `duplicate column name` 等で fail する。
--   (= memory `feedback_d1_migrations_state_drift.md` の現象)
--
-- 状況確認 (2026-05-22):
--   - `SELECT COUNT(*) FROM d1_migrations` = 0
--   - schema spot check で 11 主要 table 全存在を確認
--     (line_friend_coupons / audit_logs / brand_config / scenario_steps / shopify_tokens /
--      tracked_links / friends / automations / line_accounts / nutrition_sku_map /
--      email_messages_log)
--   - `PRAGMA table_info('scenario_steps')` で `updated_at` column 存在 (= migration 051 apply 済)
--   → 全 47 migration は production で apply 済、 bookkeeping のみ drift
--
-- 適用方法 (apps/worker cwd から):
--   npx wrangler d1 execute naturism-line-crm --remote \
--     --file ../../scripts/d1-migrations-state-recovery.sql
--
-- 適用後の verify:
--   - `SELECT COUNT(*) FROM d1_migrations` = 47
--   - `wrangler d1 migrations apply naturism-line-crm --remote` が「No migrations to apply」を返す
--
-- ファイル番号:
--   009 は重複 (= 2 files、 README の「既知の歴史的事項」参照)
--   038 / 046 は予約欠番 (= preflight.mjs の KNOWN_GAP_EXCEPTIONS 参照)
--   全 50 entries (= 001〜051、 009 重複 +1、 038/046 欠番 -2 = 50)

INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('001_round2.sql'),
  ('002_round3.sql'),
  ('003_entry_routes.sql'),
  ('004_friend_metadata.sql'),
  ('005_step_branching.sql'),
  ('006_tracked_links.sql'),
  ('007_forms.sql'),
  ('008_multi_account.sql'),
  ('009_delivery_type.sql'),
  ('009_token_expiry.sql'),
  ('010_ad_conversions.sql'),
  ('011_staff_members.sql'),
  ('012_alt_text.sql'),
  ('013_bot_user_id.sql'),
  ('014_shopify.sql'),
  ('015_shopify_phase2a.sql'),
  ('016_ab_tests.sql'),
  ('017_shopify_products.sql'),
  ('018_analytics.sql'),
  ('019_liff_portal.sql'),
  ('020_friend_profile_and_dashboard.sql'),
  ('021_multi_reminders_and_templates.sql'),
  ('022_reminder_messages_1000.sql'),
  ('023_health_tracking_enhanced.sql'),
  ('024_ambassador_feedback.sql'),
  ('025_ambassador_surveys.sql'),
  ('026_i18n.sql'),
  ('027_shopify_oauth.sql'),
  ('028_shopify_draft_orders.sql'),
  ('029_notification_prefs_and_subscriptions.sql'),
  ('030_shopify_webhook_log.sql'),
  ('031_feature_gap.sql'),
  ('032_feature_gap_v2.sql'),
  ('033_broadcast_insights.sql'),
  ('034_intake_meal_type.sql'),
  ('035_badges.sql'),
  ('036_food_logs.sql'),
  ('037_nutrition_coach.sql'),
  ('039_cron_run_logs.sql'),
  ('040_repurchase_estimation.sql'),
  ('041_purchase_cross_sell.sql'),
  ('042_email_channel.sql'),
  ('043_broadcast_step_channel.sql'),
  ('044_nutrition_sku_real_gid.sql'),
  ('045_phase6_seed.sql'),
  ('047_brand_config.sql'),
  ('048_audit_logs.sql'),
  ('049_block_recovery.sql'),
  ('050_line_friend_coupons.sql'),
  ('051_scenario_steps_updated_at.sql');
