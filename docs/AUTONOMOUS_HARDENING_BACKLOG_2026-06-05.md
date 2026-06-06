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

## このセッションで shipped（2026-06-06）

| PR | 内容 | 状態 |
|---|---|---|
| H | blacklist を全 mass 配信に適用（broadcast tag/all + A/B test tag/all + step-delivery guard + getFriendsByTag）。並列 security review で発見した weekly-report cron + birthday-collection route の同種 gap も folded。consent/景表法。migration なし・live-safe・gated 不要（recipient を狭めるのみ） | #105 merged + deploy（`3dc4bfd1`） |
| E | broadcast atomic claim（CAS `status IN ('scheduled','draft') → 'sending'`）で重複 cron / 手動送信の二重送信を防止。`processBroadcastSend` を discriminated return `{claimed,broadcast}` 化し、手動 race 敗北時は 409（誤 audit 回避）。correctness review Finding 1(HIGH)/3/5 反映。migration なし・live-safe | #106 merged + deploy（`9d8a2d98`） |
| M | shopify-customer-sync の ordersCount/totalSpent を `toFiniteNumber()` 化（非数値→NaN を DB に書かない guard）。`x ? Number(x) : undefined` は "abc" 等 truthy 非数値で NaN を通す穴があった。migration なし・live-safe | 本PR(M) |

> H 実装メモ: 共有 `getFriendsByTag`（db 層）に `COALESCE(is_blacklisted,0)=0` を入れて broadcast/A-B の tag 経路を一括カバー。inline 'all' SELECT（broadcast 2本 scoped/unscoped・ab-test 1本・weekly-report・birthday-collection /send + /stats×2）にも同節を追加。step-delivery は既存 `!is_following` terminal guard に `|| is_blacklisted` を追加し #103 の claim-lease 不変条件を保持。Friend 型に optional `is_blacklisted?:number` を追加（blast radius 最小）。

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
- ~~**M. NaN ガード**~~ → ✅ **2026-06-06 shipped（本PR M）**。`shopify-customer-sync.ts` の ordersCount/totalSpent を `toFiniteNumber()` 化。注: backlog 当初の「currency!=='JPY' credit skip」は本 file（単一通貨 JPY ストアの total_spent 表示値、credit 操作なし）に非該当。通貨/NaN credit guard は order→member credit 経路（PR #89 で `Number.isFinite` 済）の話で別。

### 配信整合性（残り、live-safe）
- ~~**E. broadcast の atomic claim**~~ → ✅ **2026-06-06 shipped（本PR E）**。CAS `status IN ('scheduled','draft') → 'sending'` で cron/手動の二重送信防止。手動 race 敗北は 409。
- **E2. broadcast stuck-'sending' sweep cron + bounded retry**（correctness review Finding 3, value med, risk low, S）
  - claim 後（status='sending'）に worker crash すると 'sending' のまま永続 stuck（cron/手動とも再 pick せず）。N 分以上 'sending' の broadcast を 'draft' に戻す sweep cron（or admin endpoint）。⚠️ bounded retry は LINE 'all' が再送で全 follower へ二重 multicast になるため、email の dedup（loadSentSubscriberIdsForBroadcast）流用 or 慎重な scheduled 戻しが必要 = 要設計。
- ~~**H. blacklist を broadcast/step に適用**~~ → ✅ **2026-06-06 shipped（本PR）**。broadcast/A-B/step に加え weekly-report・birthday-collection も folded。
- **H2. blacklist を残りの opt-in/per-friend 配信に適用**（security review Finding 4, value med, risk low, S, live-safe）
  - `liff-portal.ts getActiveIntakeReminders`（JOIN friends）+ `intake-reminder.ts` の friend guard / `reminders.ts getDueReminderDeliveries` + `reminder-delivery.ts` の friend guard。opt-in リマインダー（transactional 寄り）のため H 本体から分離したが、do-not-contact 厳守の観点では追加すべき。step-delivery と同じ `|| friend.is_blacklisted` guard パターン。
- **H3. LINE `target_type='all'` broadcast の blacklist 構造的回避**（security review Finding 5, value med, risk med, M）
  - LINE broadcast API は全 follower に server-side 配信し friend を列挙しないため blacklist 不可（本PRで comment 明記済）。完全遵守には 'all' LINE broadcast を「全 follower − blacklist の multicast」に置換（quota/insight tracking 影響あり = 要設計）、または admin UI で 'all' LINE broadcast が blacklist を bypass する旨を警告表示。

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
