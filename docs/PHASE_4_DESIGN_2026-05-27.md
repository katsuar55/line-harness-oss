# Phase 4 設計 doc — 会員ランク + 紹介 + アンバサダー

**作成**: 2026-05-27 (= autonomous session 内、 PR #80 + #81 完了直後)
**着手済**: migration 058 (= membership_tiers + members) + service skeleton (= membership.ts) + 17 tests
**目的**: user 戻り後に Phase 4 全体像を把握 + 後続 5 PR の review 判断材料 + 設計 decision rationale 保管

---

## 🎯 Phase 4 全体構成 (= 5 sub-phases)

| Sub-phase | PR # | scope | 工数 | 状態 |
|---|---|---|---|---|
| 4-α | #80 (済) | migration 058 + db queries scaffolding | 0.5 日 | ✅ merged |
| 4-β | #81 (済) | tier-up flex + push notification service | 0.5 日 | ✅ merged |
| 4-γ | #82 (予) | Shopify orders 連動 (= webhook + 累計購入額 update) | 1.5 日 | 設計済 |
| 4-δ | #83 (予) | promotion cron (= 月次 全 member check + dispatch) | 1 日 | 設計済 |
| 4-ε | #84 (予) | 紹介 referral_codes table + LIFF flow | 2-3 日 | 概要のみ |
| 4-ζ | #85 (予) | アンバサダー dashboard + affiliate code | 2 日 | 概要のみ |
| 4-η | #86 (予) | admin web /membership page + 統合 | 1 日 | 概要のみ |

合計: **約 10-12 日 / 6 PR** (= 既 0.5+0.5 完了で残り 9-11 日)

---

## 🎁 5 Tier 設計 (= migration 058 で apply 済)

| Tier | 閾値 (累計購入額 OR 紹介人数) | discount | priority support | exclusive | affiliate |
|---|---|---|---|---|---|
| 🥉 **ブロンズ** | ¥0 OR 0 人 (= default) | 0% | × | × | × |
| 🥈 **シルバー** | ¥10,000 OR — | 3% | × | × | × |
| 🥇 **ゴールド** | ¥30,000 OR — | 5% | ✅ | × | × |
| 💎 **プラチナ** | ¥100,000 OR 3 人 | 8% | ✅ | Pink Limited | × |
| 🌟 **アンバサダー** | ¥200,000 OR 10 人 | 10% | ✅ | Pink Limited + Beta | ✅ |

### 設計 decision rationale
- **bronze 〜 ゴールド**: 累計購入額 only (= 紹介人数閾値 0)
- **プラチナ 〜 アンバサダー**: 紹介人数 alternative path 追加 (= 購入額少なくても紹介熱心なら昇格 OK)
- **降格なし** (= 一度上がった tier は永続、 retention 優先)
- **discount は累進的に増加** (= 3/5/8/10%、 LTV 向上 + customer loyalty)
- **アンバサダー affiliate code 発行可** (= Phase 4-ζ で実装、 紹介リンク収益化)

### 閾値 review pointer (= user 確認推奨)
- ¥10k / ¥30k / ¥100k / ¥200k は naturism 商品単価から逆算 (= Blue 7 日 ¥696、 30 日 ¥1,980)
  - 7 日 × 14 回 = ¥10k (= シルバー、 半年で reachable)
  - 30 日 × 15 回 = ¥30k (= ゴールド、 1 年 reachable)
  - 30 日 × 50 回 = ¥100k (= プラチナ、 多回継続)
  - 30 日 × 100 回 = ¥200k (= アンバサダー、 highly engaged)
- 紹介人数 3 / 10 はマーケ仮説 (= 後で実績見て調整推奨)

---

## 🔄 Phase 4-γ: Shopify orders 連動 (= PR #82 想定)

### 設計
**目的**: Shopify で購入があった時、 friend_id を識別して member.total_purchase_jpy を update。

#### Data flow
```
Shopify order webhook
  ↓
worker /api/shopify/webhooks/orders/created
  ↓
Shopify customer email or LINE friend metadata で friend_id 解決
  ↓
upsertMember (= total_purchase_jpy += order.total_jpy)
  ↓
checkAndNotifyForFriend (= 昇格 check + 通知)
```

#### 課題と解決
1. **friend_id 解決**:
   - Shopify customer.email ↔ LINE friend.email (= LIFF で登録時 取得)
   - もしくは Shopify customer.note に friend_id 埋込 (= LIFF checkout 時)
   - もしくは Shopify customer.tags に friend_id 埋込
2. **重複防止**: Shopify webhook 再送対策 (= shopify_order_id を unique key として保管)
3. **既存 friends → members backfill**: PR #82 deploy 後、 全 friend を members に 1 回 upsert (= one-time script)

#### 実装 file
- `apps/worker/src/services/shopify-order-member-sync.ts` (= 新規)
- `apps/worker/src/routes/shopify-webhooks.ts` (= 既存に handler 追加)
- migration 059: `member_purchase_events` table (= 重複防止 + audit trail)
- backfill script: `scripts/backfill-members-from-friends.mjs`

---

## ⏰ Phase 4-δ: promotion cron (= PR #83 想定)

### 設計
**目的**: 月 1 回 (= 毎月 1 日 09:00 JST) 全 member の promote check + LINE push dispatch。

実は **PR #82 (Shopify orders 連動)** で都度 promote check するなら、 cron 不要かも。 但し:
- backfill 時 / 紹介人数増加 (= PR #84 referral) は orders 経由しない
- 月 1 で全 member sanity check が安心

#### Cost zero design
- 月 1 回 × promote 該当 member 数 のみ push
- 200 friends × 5% promote rate × 月 1 = 月 10 push (= 余裕で Free 枠内)
- 既 max tier (= アンバサダー) は no-op = 多くの member は push なし

#### 実装 file
- `apps/worker/src/services/membership-cron.ts` (= 新規)
- `apps/worker/src/index.ts` (= cron 接続)
- cron-monitor rule 追加

---

## 🤝 Phase 4-ε: 紹介 referral_codes (= PR #84 想定)

### 設計
**目的**: 既存 friend が紹介 code 生成 → 招待先 friend add 時に紐付け → reward。

#### Data model
```sql
CREATE TABLE referral_codes (
  id TEXT PK,
  code TEXT UNIQUE NOT NULL,          -- e.g. 'NAT-K8VG23'
  inviter_friend_id TEXT NOT NULL,    -- 紹介者 friend.id
  generated_at TEXT,
  expires_at TEXT NULLABLE,           -- 無期限可
  is_active INTEGER DEFAULT 1
);

CREATE TABLE referral_invitations (
  id TEXT PK,
  code TEXT NOT NULL,                 -- referral_codes.code FK
  invitee_friend_id TEXT NOT NULL,    -- 招待先 friend.id
  invited_at TEXT,
  reward_applied INTEGER DEFAULT 0    -- inviter に reward 配布済か
);
```

#### LIFF flow
1. 既存 friend が LIFF `/referral` を開く → 「あなたの code: NAT-K8VG23」 表示 + share button
2. share button → LINE 友だち追加 deeplink (= `https://lin.ee/xxx?code=NAT-K8VG23`)
3. 招待先 friend add 時 → webhook で `referral_invitations` に row 追加
4. 招待先初購入時 → inviter に reward (= 500 円 OFF クーポン) + total_referral_count++

#### Cost zero design
- 紹介 code 生成は LIFF (= push 0 通)
- 招待先 friend add 時の reply (= push 0 通)
- inviter への reward 通知は push 1 通 / 招待成立 (= 月数件程度)

#### 実装 file
- migration 060: referral_codes + referral_invitations
- packages/db/src/referral.ts
- apps/worker/src/services/referral.ts
- apps/worker/src/routes/liff-referral.ts (= LIFF render + API)
- apps/web/src/app/liff/referral/page.tsx (= LIFF UI)

---

## 🌟 Phase 4-ζ: アンバサダー dashboard (= PR #85 想定)

### 設計
**目的**: アンバサダー tier の friend に「affiliate code 発行」 + 「収益 dashboard」 提供。

#### 概要 only (= 詳細は user 確認後)
- アンバサダーは LIFF `/ambassador` で:
  - 自分の affiliate code を見る
  - 紹介経由の購入実績を見る
  - 月次収益 (= 紹介経由購入の 5-10% commission) を確認
- 商業判断必要: commission rate / 支払いタイミング / 支払い method (= Stripe / 振込 / クーポン)
- 法的判断必要: 景表法 / 特商法 ステマ規制 / 「広告」 表示義務

#### user 戻り後の論点
- commission rate は何 % が妥当か?
- 支払い method (= 振込 / クーポン replacement)
- アンバサダー応募審査有無 (= auto promote? 申請式?)

---

## 🖥 Phase 4-η: admin web /membership page (= PR #86 想定)

### 設計
**目的**: admin で全 member の tier 分布 + 個別 member 詳細 + manual promotion を可能に。

#### UI 要素
- 5 stat cards: total members / tier 別人数 (= 5 cards)
- member 一覧 (= filter: tier / 累計購入額 / 紹介数 sort)
- 個別 member 詳細: tier 履歴 / 購入履歴 / 紹介履歴
- manual promotion button (= 例: 特別待遇で 1 段昇格)
- export CSV

#### 実装 file
- apps/worker/src/routes/membership-admin.ts (= 新規)
- apps/web/src/app/membership/page.tsx (= 新規)
- sidebar.tsx に nav 追加

---

## 🛡 移行 strategy (= 既存 friends → members backfill)

### 必須: PR #82 deploy 後の one-time script
```javascript
// scripts/backfill-members-from-friends.mjs
// 全 friends に対して INSERT INTO members (friend_id, current_tier_id='bronze', ...) を実行
// 既存 row があれば SKIP (= 冪等)
```

### 実装
- script は `npm run` で manual 実行 (= cron なし、 1 回限り)
- output: backfilled=N, skipped=M, errors=K
- audit_logs に「membership.backfill_completed」 記録

---

## 🔍 Open questions (= user 戻り後の判断材料)

1. **5 tier の閾値** は妥当か? (= naturism 商品単価から逆算した推奨値)
2. **降格なし** は妥当か? (= retention 優先で永続、 但し inactive 1 年で「sleep」 状態 etc. の途中 state は考えるか)
3. **昇格通知頻度** は月 1 でいいか? それとも都度 (= order webhook 経由) か?
4. **アンバサダー commission rate** は何 % が妥当か?
5. **紹介 code 有効期限** は無期限でいいか?
6. **LIFF 紹介 page** の見た目 (= QR code 表示有無、 SNS share button 含有有無)

---

## 📋 user 戻り後の推奨 sequence

| Step | Action | 時間 |
|---|---|---|
| 1 | 本 doc review + Open questions 6 項目に回答 | 30 分 |
| 2 | PR #80 + #81 review (= merged 済、 GitHub で確認) | 15 分 |
| 3 | (24h 後) Merchant Center Approved 確認 → LP launch GO 判定 | 10 分 |
| 4 | LP launch 実行 + 流入観察 | user 主導 |
| 5 | 友だち増えたら Phase 4-γ (= PR #82 Shopify orders 連動) 着手 | 1.5 日 |
| 6 | Phase 4-δ promotion cron | 1 日 |
| 7 | Phase 4-ε 紹介 referral (= LIFF flow 大型) | 2-3 日 |
| 8 | Phase 4-ζ アンバサダー dashboard | 2 日 |
| 9 | Phase 4-η admin web /membership page | 1 日 |
| 10 | Phase 4 完成 + retrospective | - |

---

## 関連 memory + skill

- `project_current_state.md` (= 5/27 全体状態)
- `feedback_shopify_markets_silent_blocker.md` (= LP launch unblock skill)
- `project_naturism_opt_in_state.md` (= 日本国内 only confirmation)
- `project_multi_brand_industry_design.md` (= 将来海外展開時の re-activation 想定)
- `SESSION_HANDOFF.md` (= 引継ぎ詳細)
