-- naturism-welcome-v1 scenario v3 cost-zero rebrush (Phase 1 ULTRATHINK v3、 2026-05-24)
--
-- 背景:
--   v2 (= 同日 scripts/welcome-scenario-v2-2026-05-24.sql) で
--   step 1 (15 min 後 push 商品比較) + step 2 (24h 後 push reminder) を残していたが、
--   user 指摘で「LINE 公式アカウントの push は 1 通ずつ課金、 reply は無料、
--   コストかけずに最高の結果を出す」 と再設計。
--
--   v3 = welcome 全 reply chain で完結:
--     - step 0 (= follow event reply): 既存 v2 維持 (= coupon 即時開示 + 「次へ ▶」 button)
--     - 「次へ」 tap → reply で「お誕生日教えて」 flex (= 旧 push を reply 化、 services/welcome-postback.ts)
--     - 月 tap → reply で「年代教えて」 flex (= 同)
--     - 年代 tap → reply 1 回で 3 message 同時 (= ありがとう + 商品比較 + マイクーポン)
--       → 旧 step 1 (15 min push) + step 2 (24h push) を完全に統合、 0 通課金
--
--   step 1 と step 2 を scenario_steps から **削除** することで:
--     - step-delivery cron が無駄な抽出をしない
--     - admin web /scenarios で 1 step のみ表示 (= clean)
--     - 「v3 で 0 通化された」 事実が D1 state からも明示
--
-- 旧 step 1 / step 2 の content は webhook handler 内 (= buildProductCompareFlex /
-- buildMyCouponFlex) に移植済 (= revert 不要、 必要なら git history から再作成可)。
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\welcome-scenario-v3-2026-05-24.sql
--
-- 適用後確認:
--   SELECT step_order FROM scenario_steps WHERE scenario_id = 'naturism-welcome-v1';
--   → 1 row (= step_order=0 のみ)

-- ============================================================
-- step 1 (= 15 min 後 商品比較 push) を削除
-- ============================================================
DELETE FROM scenario_steps WHERE scenario_id = 'naturism-welcome-v1' AND step_order = 1;

-- ============================================================
-- step 2 (= 24h 後 reminder push) を削除
-- ============================================================
DELETE FROM scenario_steps WHERE scenario_id = 'naturism-welcome-v1' AND step_order = 2;
