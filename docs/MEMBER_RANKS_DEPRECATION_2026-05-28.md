# member_ranks / friend_ranks System Deprecation

**作成**: 2026-05-28 (= Phase 4-η 完成後の cleanup 計画)
**status**: ⚠️ **DEPRECATED** (= 既存 admin API は警告 header 付きで動作継続、 新規実装は禁止)
**実 drop 予定**: 2026-07-15 (= 別 PR で migration 削除)

---

## 背景

LINE Harness OSS には **2 つの会員ランク system が並走** していた:

| system | 設計 | 状態 |
|---|---|---|
| 旧 `member_ranks` + `friend_ranks` | Shopify customer 累計購入 / 注文数 から rank 自動計算 (= shopify-phase2a 由来) | ⚠️ **DEPRECATED** (本 doc) |
| 新 `membership_tiers` + `members` + `member_purchase_events` | tier-up flex push + 月次 sanity cron + audit (= Phase 4 PR #80-#85) | ✅ **正規** |

旧 system は **friend_ranks 0 件** で実運用しておらず、 新 system (= Phase 4) に完全置換可能。 但し本番 admin route で参照されている可能性 + 移行期間中の安全性を考慮し、 段階的に廃止する。

---

## 廃止 schedule

| date | action | 影響 |
|---|---|---|
| 2026-05-28 (= 本 PR) | doc 公開 + admin route に `X-Deprecation-Notice` header 追加 | 既存 client は警告 console.warn 確認可能、 動作影響なし |
| 2026-06-15 | admin route handler が 410 Gone を返す (= 読取のみ) | client が新 API への移行を強制される、 read 不可 |
| 2026-07-15 | migration 062 で `member_ranks` / `friend_ranks` table を DROP | schema cleanup 完了 |

---

## 廃止対象

### Table (= 2026-07-15 DROP 予定)

- `member_ranks` (= migration 029 で追加、 4 seed row「ブロンズ / シルバー / ゴールド / プラチナ」)
- `friend_ranks` (= migration 029 で追加、 friends と member_ranks の bridge、 **0 件で実運用なし**)

### Query (= packages/db、 2026-07-15 削除予定)

- `getMemberRanks`
- `createMemberRank`
- `updateMemberRank`
- `deleteMemberRank`
- `getFriendRank`
- `calculateAndUpdateFriendRank`

### Route (= apps/worker、 2026-06-15 で 410 Gone)

- `GET /api/integrations/shopify/ranks`
- `POST /api/integrations/shopify/ranks`
- `PUT /api/integrations/shopify/ranks/:id`
- `DELETE /api/integrations/shopify/ranks/:id`
- `GET /api/integrations/shopify/ranks/friend/:friendId`
- `POST /api/integrations/shopify/ranks/calculate/:friendId`

### 既存 admin web 影響

- 5/28 時点で /membership page (= 新 system) は実装済、 旧 ranks page は **作成されていない** (= 影響なし)

---

## 移行 path (= 旧 → 新)

| 旧 (DEPRECATED) | 新 (正規) | 備考 |
|---|---|---|
| `member_ranks` table | `membership_tiers` table (= migration 058) | 5 seed (bronze/silver/gold/platinum/ambassador)、 perks JSON + badge |
| `friend_ranks.current_rank_id` | `members.current_tier_id` (= migration 058) | 1 friend = 1 member row、 join via friend_id |
| `calculateAndUpdateFriendRank` | `promoteMemberIfEligible` (= packages/db) | 純関数、 降格なし冪等、 cron + 都度両対応 |
| 累計購入計算 (= friend_ranks.total_spent) | `members.total_purchase_jpy` + `member_purchase_events` (= migration 059) | event audit trail 付き |

---

## 移行確認 query

旧 system 状態確認 (= 廃止前):
```sql
SELECT 'member_ranks' AS t, COUNT(*) AS n FROM member_ranks
UNION ALL
SELECT 'friend_ranks', COUNT(*) FROM friend_ranks;
```

新 system 状態確認 (= 廃止後の代替):
```sql
SELECT 'membership_tiers' AS t, COUNT(*) AS n FROM membership_tiers
UNION ALL
SELECT 'members', COUNT(*) FROM members
UNION ALL
SELECT 'member_purchase_events', COUNT(*) FROM member_purchase_events;
```

---

## Plugin / 外部利用がある場合 (= 想定なし)

LINE Harness OSS の外部 plugin / 3rd party は naturism 環境では未確認だが、 もし旧 ranks API を使用していれば 6 月 15 日までに移行必要:

| 旧 endpoint | 新 endpoint / library API |
|---|---|
| `GET /api/integrations/shopify/ranks` | `GET /api/membership/tiers` |
| `POST /api/integrations/shopify/ranks` | (= manual seed 不要、 migration 058 で確定 5 tier) |
| `GET /api/integrations/shopify/ranks/friend/:friendId` | `GET /api/membership/members?tier=...` で取得 + tier_id で filter |
| `POST /api/integrations/shopify/ranks/calculate/:friendId` | `POST /api/membership/members/:friendId/promote` (= manual) または order webhook 経由自動 |

---

## ref

- Phase 4 設計 doc: `docs/PHASE_4_DESIGN_2026-05-27.md`
- 新 system migrations: `packages/db/migrations/058_membership_tiers.sql` + `059_member_purchase_events.sql` + `060_friends_shopify_customer_id.sql`
- 新 system services: `apps/worker/src/services/membership.ts` + `membership-promotion-cron.ts` + `shopify-order-member-sync.ts`
- 新 admin route + page: `apps/worker/src/routes/membership.ts` + `apps/web/src/app/membership/page.tsx` (= PR #84)
