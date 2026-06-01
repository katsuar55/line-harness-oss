# 自社内製 AIネイティブ・ロイヤリティ設計 (2026-06-01)

> 方針確定 (Katsu 2026-06-01): cb-admin の制約 (API無し / 感謝クーポン=コード型・1回限り・併用不可) を踏まえ、
> **③ 非併用前提で着手 → 会員ランク/割引/紹介/スタンプを自社内製化**。ハッシャダイには依存しない。
> 常に **AIネイティブ** を意識。multi-brand 汎用性を保つ。

## 0. 実機確認の確定事実 (2026-06-01, Chrome openclaw-pc 読み取り専用)

| 項目 | 結果 |
|---|---|
| Shopify 顧客タグにランク | ❌ 無し (最高額客のタグは `subscription-...-plan:` のみ) |
| Shopify 顧客メタフィールドにランク | ❌ 無し (`LINE ID/生年月日/inflow_route/social` のみ) |
| cb-admin の正体 | **ハッシャダイ製 LINE LIFF 会員アプリ** (Vue3, `liff.init` 要 = LINE内専用)。公開API/webhook 無し |
| ランク割引の実体 | 顧客別 **Shopify コードクーポン**「{ランク}感謝クーポン」(作成者=アプリ)。**% が rank** (bronze2/silver4/gold6/platinum8) |
| クーポン制約 | **1回限りの購入** (サブスク商品非適用) / **他割引と併用不可** / 利用上限1回 / 特定顧客 / 毎月再発行 |
| 付随 | `CRM PLUS on LINE` (SocialPLUS) 導入済 → friend↔customer link 候補。`定期購買` がサブスク状態を tag 付与。顧客 3,733 |

→ **cb-admin から rank を読む手段が無い**ため、自社で rank を算出・所有する。

## 1. 完成図 (ターゲットアーキテクチャ)

```
Shopify orders ──(既存 webhook/cron)──→ D1 member_purchase_events
                                              │
                              [自社ランクエンジン] trailing-12mo 集計 → rank 判定
                                              │
                    ┌─────────────┬───────────┴───────────┬──────────────┐
              rank snapshot   自社割引発行         マイランク LIFF      対象限定通知
              (月次再判定/降格)  (併用を自前制御)    (会員証/再注文/AI)   (降格3日前 等)
                                              │
                                   friend ↔ Shopify customer link
                                   (CRM PLUS metafield / LIFF)
```

**AIネイティブ層** (横断): Workers AI で ①商品レコメンド ②昇格促し文面の個別生成 ③紹介不正の境界判定 ④ベストクーポン組合せ提案 ⑤AI相談 (既存)。

## 2. ランクモデル (cb-admin 互換 = 既存客の rank を温存)

| rank | 閾値 (trailing-12mo JPY) | 割引 | badge |
|---|---|---|---|
| regular | ¥0 | 0% | 🌱 |
| bronze | ¥1 | 2% | 🥉 |
| silver | ¥12,000 | 4% | 🥈 |
| gold | ¥24,000 | 6% | 🥇 |
| platinum | ¥45,000 | 8% | 💎 (#0ABAB5) |

- **過去12ヶ月 rolling 累計**・**月次再判定**・**降格あり** (cb-admin と同仕様)。
- `brand_config` で defs を上書き可能 (= multi-brand)。naturism は上表を default。
- ⚠️ 既存 Phase-4 membership (lifetime累計・降格なし・¥10k/30k/100k/200k・bronze〜ambassador) とは別モデル。
  Phase-4 の `members.total_purchase_jpy` (lifetime) は **別指標として残置** (生涯VIP判定に転用可)、rank 判定には trailing-12mo を使う。

## 3. データモデル

**再利用 (既存)**
- `member_purchase_events` (order毎: `friend_id, amount_jpy, created_at, applied_at`) → trailing-12mo 集計源。
- `members` (friend毎 lifetime 累計) → 残置 (生涯指標)。
- `friends.shopify_customer_id` (列はあるが **populate flow 未実装**)。

**新規 (後続 PR)**
- `loyalty_rank_snapshots` (friend/customer毎: `rank_id, trailing12mo_jpy, evaluated_at, prev_rank_id`) — 降格検知 + 履歴 (PR2)。
- `loyalty_stamps` / `loyalty_stamp_events` (PR6)。
- `referrals` (既存 affiliates 流用検討) / 不正フラグ (PR7)。

## 4. friend ↔ Shopify customer link (PR3)

現状 `resolveFriendForOrder` は customer_id を **読む**が **書く** flow が無い。実装:
1. **CRM PLUS on LINE 経由**: Shopify customer metafield「LINE ID」を Admin API で逆引き → friend.line_user_id 一致で link (既存導入アプリを活用、ユーザー操作不要が理想)。
2. **LIFF link fallback**: マイランク初回起動時に LINE Login + email 確認 → Shopify customer 照合 → `friends.shopify_customer_id` set。
3. **link-triggered backfill**: link 確定時にその customer の過去 paid order を遡及加算 (正確な注文日付で trailing-12mo を埋める)。

## 5. マイランク LIFF (PR4) — pull型・課金ゼロ

LINE Login/idToken で自動識別。構成: ①会員証 (rank%+次rank進捗+降格注意) ②保有クーポン (併用可否色分け+ベスト組合せ自動提案) ③かんたん再注文 ④AIおすすめ ⑤スタンプ進捗/AI相談。
既存 `liff-portal.ts` / `liff-reorder-page.ts` / `client/reorder.ts` を基盤に拡張。豪華演出は LIFF (Lottie/紙吹雪) = 課金ゼロ。

## 6. 自社割引 + 3タップ購入 (PR5) — 併用を自前制御

cb-admin の「併用不可」を超えるため、**自社管理の Shopify 割引**を発行し `combinesWith` を自前設定:
- サブスク% + ランク% を automatic discount で重ねる (= 最大13% 実現)。販促コードは1注文1枚。
- 最短購入: cart permalink `/cart/{variantId}:{qty}?discount={code}` で商品投入+割引自動適用 → Shop Pay (返品客は2タップ)。
- ⚠️ 実装前に Shopify dev MCP で combinations / permalink 最新仕様を確認。multipass は SSO決済にのみ必要 (permalink には不要)。

## 7. スタンプ / 紹介 / 通知

- **スタンプ (PR6)**: ログイン台帳 0-30、パーク(ギフト)+小割引2-3%、LIFFミニゲーム化。スタンプ系はサブスク+ランクと**非併用**。
- **紹介 (PR7)**: 10% (両者・全品)。不正=連絡先重複アウト/同住所フラグ (`normalize-japanese-addresses`+境界は Workers AI)。報酬は発行前検査 (被紹介者=本人確認後、紹介者=orders/paid確認後)。
- **通知 (PR8)**: 降格3日前=gold/platinum限定、紹介クーポン期限3日前=紹介成功者のみ。月1 push に集約しコスト最小。

## 8. 段階 PR 分割 (依存順)

| PR | 内容 | 依存 | 状態 |
|---|---|---|---|
| **PR1** | ランクエンジン core (純関数 rank判定/進捗 + brand config + trailing-12mo集計) | — | 🔨 本PR |
| PR2 | rank snapshot + 月次再判定 cron (降格対応) | PR1 | |
| PR3 | friend↔Shopify customer link + backfill | — | |
| PR4 | マイランク LIFF (会員証/進捗/クーポン表示) | PR1,PR3 | |
| PR5 | 自社割引発行 + cart permalink 3タップ購入 | PR1,PR4 | |
| PR6 | スタンプ台帳 + LIFFミニゲーム | PR4 | |
| PR7 | 紹介10% + 不正チェック | PR3 | |
| PR8 | 対象限定通知 (降格3日前) | PR2 | |

各 PR は TDD (80%+) + 並列 review (security+correctness+typescript) → preflight → merge/deploy。

## 9. リスク / 未解決

- **既存 cb-admin との二重運用**: 移行期は cb-admin の感謝クーポンと自社割引が両立しうる。当面は自社割引を**別コード**で発行し衝突回避、cb-admin 廃止は Katsu 判断で段階的に。
- **trailing-12mo の注文日付精度**: PR1 は `member_purchase_events.created_at` 基準 (live webhook では注文時刻≈記録時刻)。過去 order の正確日付は PR3 backfill で精緻化。
- **3タップ購入の割引自動適用**: Shopify の automatic+code 併用挙動は PR5 着手時に dev MCP で実証。
- **friend↔customer link 充足率**: CRM PLUS metafield の populate 率次第。低ければ LIFF link 訴求が必要。
