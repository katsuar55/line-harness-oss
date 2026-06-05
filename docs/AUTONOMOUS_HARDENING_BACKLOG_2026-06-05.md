# Autonomous Pre-Launch Hardening Backlog (2026-06-05)

LP launch 前の data-integrity / reliability 予防 hardening の優先ロードマップ。
出所: 全体コードレビュー `docs/CODE_REVIEW_2026-05-30.md` を survey agent で再整理し、
**autonomous（Katsu/外部依存なし）・live-safe または gated・PR #91 非重複・非破壊** な項目に絞ったもの。

## このセッションで shipped（2026-06-05 PM cont）

| PR | 内容 | 状態 |
|---|---|---|
| #101 | PR3-B 過去注文 backfill + occurred_at money path（gated） | merged + deploy（`102a8d3c`、migration 063） |
| #102 | event-bus per-row 隔離（review #13）+ AI fallback の conversation_logs 記録（silent fallback 可視化） | merged + deploy（`db0082f8`） |
| #103 | step 配信 atomic claim（review #8、重複 cron 二重配信防止、CAS、migration なし） | merged + deploy |

## 残り（優先度順、次セッション着手推奨）

> 各項目: survey ランク / value / risk / effort / gated-or-live / key files

### P4. 購入金額正確性（money、gated）
- **A. order→member replay cron**（survey #1, value high, risk low, M, **要 gate**）
  - `shopify_orders LEFT JOIN member_purchase_events WHERE mpe.id IS NULL` を drain → `syncOrderToMember`（idempotent: shopify_order_id UNIQUE + applied_at CAS）。dead code `listUnappliedPurchaseEvents`（membership.ts:512）も活用。
  - 新 `services/order-member-replay-cron.ts` + `index.ts` cron loop（:385 の withHeartbeat pattern）。
  - **gate**: `MEMBER_REPLAY_ENABLED`（default off）。本番 member_purchase_events=0 / shopify_orders 281 のため、有効化で 281 件（大半 friend 未マッチ=audit only、rank 影響なし）が入る → gate 必須。
  - **⚠️ 注意**: replay は webhook waitUntil 失敗の recovery が目的。LP launch 後の実注文流入時に価値。
- **B. refund webhook → 負の member_purchase_event**（survey #3, value high, risk low, M, **要 gate `REFUND_SYNC_ENABLED`**）
  - `refunds/create` webhook 登録 → 返金分を負で記録し total_purchase_jpy 過大計上を解消。
  - **⚠️ 落とし穴**: 既存 `addPurchaseEvent` は `Math.max(0, ...)` で負を 0 に丸める。負の event を許す別経路（新 fn or 専用 column）が必要 = 設計を要検討（fresh context 推奨）。
- **M. NaN/通貨ガード**（survey #13, value low, risk low, S, live-safe）
  - `services/shopify-customer-sync.ts:116-117` の total_spent/total_price/orders_count を `toFiniteNumber()`。currency!=='JPY' は credit skip。

### 配信整合性（残り、live-safe）
- **E. broadcast の atomic claim + retry**（survey #7, value high, risk med, M, live-safe）
  - `broadcast.ts:33-41,67-81,508-526`。`UPDATE broadcasts SET status='sending' WHERE id=? AND status='scheduled'` CAS + bounded retry（現状 fail で 'draft' dead-end）。#103 の step claim と同設計。
- **H. blacklist を broadcast/step に適用**（survey #6, value med, risk low, **S**, live-safe）
  - `getFriendsByTag` と 'all' email query に `COALESCE(is_blacklisted,0)=0`、`processSingleDelivery` でも check。`segment-query.ts` は既に対応済 = 不整合が proven。**小さく high-value、次の着手に最適**。

### AI-native observability / compliance（live-safe）
- **J. 薬機法 NG-word を redact 前 raw 出力で検出**（survey #8, value med, risk low, S）
  - `ai-response.ts:274-295` + `packages/ai-provider/src/redact.ts:73`。現状 redacted text に対し検出 → 最高リスク表現を under-report。`detectedPhrases` を union。cross-package のため要 ai-provider 理解。
- **L. ai-fact-context null-account ガード**（survey #10, value low-today, risk low, S）
  - `ai-fact-context.ts:94-123`。lineAccountId null で全テナント broadcast を query → multi-tenant で cross-tenant leak。**ただし naturism 単一テナントで現状 null=全件は意図的**（regression 注意）→ multi-tenant（brand #2）着手時にまとめて。

### scale / maintainability（live-safe）
- **N. 成長テーブルの bounded pagination**（survey #14, value med, risk low-med, M）
  - `getChats`/`getCalendarBookings`/`getUsers` に LIMIT/keyset、reminder/scenario/broadcast cron SELECT に due 述語 + LIMIT（128MB isolate にテーブル全ロードを回避）。
- **O. webhook.ts handler 抽出**（survey #15, value med, risk med, **L**, live-safe）
  - 1,220 行 `handleEvent`（~1,066 行）を per-event-type に抽出。`webhook.test.ts`/`webhook-image.test.ts` が regression net。**最も安全な大型抽出**（liff-pages.ts 2,287 / liff-portal.ts 2,407 は untyped client + PR #91 が触るため #91 merge 後）。

## 除外（survey 確認済、着手しない）
- **PR #91 重複8件**（profile/reorder IDOR, shop allowlist, resubscribe, CORS, auth const-time, dead route, fetchApi）= #91 が open でカバー。触らない。
- **multi-tenant line_account_id**（review #5/6/9/23/27/59）= brand #2「健康エクスプレス」onboarding（人的/事業判断）まで dormant。
- **PR7 referral** = 別プロジェクトで構築中。
- **STALE/done**: LSTEP H1 CSV import（friends-import.ts 実装済）、H4 quota monitor（line-quota-monitor.ts 実装済）。

## ワークフロー（各 PR）
TDD（RED→GREEN）→ 並列/focused レビュー（security+correctness）→ フルゲート（worker+db typecheck + worker test + preflight All green）→ 単独 PR → CI green → squash merge → main 同期 → deploy（gated は inert / live は post-deploy-check）。money/customer-facing は gated（default off で本番未書込、有効化は Katsu 承認）。
