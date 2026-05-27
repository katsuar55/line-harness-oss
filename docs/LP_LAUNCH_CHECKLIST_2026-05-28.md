# LP Launch 直前 Checklist (= 2026-05-28 autonomous session 集大成)

**目的**: user 戻り後の LP launch GO までを **30-60 分** で完了できる action list。
**現状**: GMC shipping zone 未設定が唯一の本線 blocker、 全 backend 準備完了。

---

## 🎯 全体 timeline (= 想定)

| date | action | 所要 |
|---|---|---|
| 2026-05-28 朝 (= user 戻り) | GMC shipping zone 設定 | 5 min |
| 2026-05-28 夜 〜 5-29 朝 | GMC 24h audit 待機 | 受動 |
| 2026-05-29 朝 (= verify) | Approved 12 確認 | 5 min |
| 2026-05-29 午前 | Google Ads キャンペーン設定 | 30 min |
| 2026-05-29 午後 | LP 動作確認 + 流入開始 | 15 min |
| 2026-05-29 〜 6 月初 | 7 日間 KPI 観測 | 1 日 5 min × 7 |

---

## ✅ Step 1: GMC shipping zone 設定 (= LP launch 本線、 5 min)

**詳細**: [docs/MERCHANT_CENTER_SHIPPING_SETUP_2026-05-28.md](MERCHANT_CENTER_SHIPPING_SETUP_2026-05-28.md)

要約:
1. https://merchants.google.com/mc/overview?a=11652571
2. 「Add details to show how you ship your products」 → Add
3. Step 1 Countries: **Japan のみ** check → Continue
4. Step 2 Products: **All products** → Continue
5. Step 3 Delivery times: Cutoff 12:00 / Handling 0-1 / Transit 1-4 days → Continue
6. Step 4 Shipping costs: **Free shipping** → Save
7. Dashboard 戻り → 全 step ✅ 確認

---

## ⏳ Step 2: 24h 待機 + Approved 12 確認 (= verify)

**待機時間中の action** (= 任意):
- ✅ `/membership` admin page 動作確認 (= https://naturism-admin.pages.dev/membership)
- ✅ Phase 4 Open questions 6 項目 回答 ([docs/PHASE_4_DESIGN_2026-05-27.md:207](PHASE_4_DESIGN_2026-05-27.md:207))
- ✅ Google Ads アカウント Manager Center 連携確認

**24h 後 verify** (= 5/29 朝):
- URL: https://merchants.google.com/mc/products/diagnostics?a=11652571
- 確認: **Approved: 12** (= 期待値)、 **Limited: 0** (= 期待値)
- 失敗時 (= 24h 後も Limited 残存): [docs/MERCHANT_CENTER_SHIPPING_SETUP_2026-05-28.md:109](MERCHANT_CENTER_SHIPPING_SETUP_2026-05-28.md:109) Troubleshoot 参照

---

## 🚀 Step 3: Google Ads キャンペーン設定 (= 30 min)

### 3.1 キャンペーン構成 (= 推奨)

| 項目 | 推奨値 | 理由 |
|---|---|---|
| キャンペーンタイプ | **ショッピング** | naturism 商品 (= 12 種) を直接訴求、 conversion 効率最大 |
| サブタイプ | **標準ショッピング** | Performance Max は budget 大型向け、 初期は標準で control |
| 入札戦略 | **コンバージョン値の最大化** (target ROAS なし) | データ蓄積期は ROAS target 未設定で学習加速 |
| 1 日予算 | **¥3,000-¥5,000** | 7 日 = ¥21,000-¥35,000 で statistical significance を取る |
| ターゲット国 | **日本** | naturism 国内 only |
| 言語 | **日本語** | |
| デバイス | **モバイル優先** (= 入札調整 +20%) | LINE 友だち導線がモバイル中心 |
| 配信スケジュール | **24h 配信** | 初期は時間帯傾向データ収集 |

### 3.2 商品グループ (= 推奨初期構成)

- **全 12 商品 1 グループ** で start (= 個別 product 入札最適化は 2 週後)
- 除外 keyword 設定 (= 推奨):
  - `無料` `タダ` `フリー` (= 送料無料 誤解防止)
  - `競合ブランド名` (= 別途 doc 化推奨)
  - `求人` `バイト` `転職` (= 関連性なし)

### 3.3 conversion tracking 設定

- Google Tag (= gtag.js) を LP に設置 (= Shopify はテーマで設定可能)
- conversion goal: **purchase** (= Shopify checkout 完了 event)
- enhanced conversion 設定 (= email hash で精度向上、 GDPR compliant)

---

## 🎯 Step 4: LP 動作確認 (= 15 min)

### 4.1 Pre-flight check

- [ ] https://naturism-diet.com/ → 200 OK + 表示確認
- [ ] LINE 友だち追加ボタン (= LINE Add Friend URL) click → LINE app 起動
- [ ] LINE 公式アカウント追加 → welcome message + dynamic coupon (= `LINE-UXSE4P6D` 等)
- [ ] LIFF Portal (= LINE 内ブラウザで開く) → 3 ボタン (= 朝/昼/夜記録) display
- [ ] /membership admin page (= https://naturism-admin.pages.dev/membership) → Katsu bronze tier 表示

### 4.2 Shopify checkout flow

- [ ] LP からの遷移 → Shopify 商品 page → カート追加 → checkout
- [ ] order/paid webhook → CF Worker (= naturism-line-crm) で受信確認
- [ ] webhook 内処理: payment_notifications + member_purchase_events 1 件 INSERT + members.total_purchase_jpy 加算 + tier promote check
- [ ] LINE 友だち向け push: 注文確認メッセージ + (必要なら) tier 昇格通知

### 4.3 abandoned cart flow

- [ ] checkout 中断 → 1h 後 LINE push (= abandoned cart 通知 + recovery coupon)
- [ ] recovery via LINE button → Shopify checkout 復元

---

## 📊 Step 5: 7 日 KPI 観測 (= 1 日 5 min × 7)

### 5.1 daily check (= 朝 10:00 など定時)

| metric | 取得元 | 目標値 (= 7 日累計) |
|---|---|---|
| Google Ads impression | Google Ads dashboard | 10,000+ (= 流入 base) |
| Google Ads click | Google Ads dashboard | 200+ (= CTR 2%+ なら 良) |
| LP visits | Shopify Analytics | click と同等 (= 90%+ delivery 率) |
| LINE 友だち追加 | LINE Official Manager | 50+ (= LP→LINE 25%+ なら 良) |
| add to cart | Shopify Analytics | 20+ (= LP→cart 10%+ なら 良) |
| checkout 開始 | Shopify Analytics | 10+ |
| 注文完了 | Shopify Analytics | 3+ (= LP→purchase 1.5%+ なら 良) |
| member_purchase_events INSERT | D1 query | 注文完了と同数 |
| tier 昇格 (= bronze→silver 等) | audit_logs | 累計 ¥10,000+ 達成者数 |

### 5.2 D1 query (= 観測 helper)

```sql
-- daily orders
SELECT date(applied_at, '+9 hours') AS jst_date, COUNT(*) AS orders, SUM(amount_jpy) AS revenue
FROM member_purchase_events
WHERE applied_at IS NOT NULL
GROUP BY jst_date
ORDER BY jst_date DESC LIMIT 14;

-- friend match rate
SELECT
  COUNT(*) AS total_events,
  SUM(CASE WHEN friend_id IS NOT NULL THEN 1 ELSE 0 END) AS matched,
  ROUND(SUM(CASE WHEN friend_id IS NOT NULL THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS match_rate_pct
FROM member_purchase_events;

-- tier distribution
SELECT current_tier_id, COUNT(*) AS members, SUM(total_purchase_jpy) AS total_revenue
FROM members
GROUP BY current_tier_id;
```

---

## 🚨 Trouble shoot

### 7 日 KPI 未達 (= click 200 未満)

仮説:
1. Google Ads 予算不足 → 1 日予算上限を up
2. ad copy が weak → 別 variation A/B test
3. landing page bounce rate 高い → LP first-view 改善 + speed optimization
4. ターゲット keyword 不適 → search terms report で除外 / 追加調整

### LINE 友だち追加 50 未満 (= LP→LINE conversion 低)

仮説:
1. LINE add friend button が hidden / 目立たない → above-the-fold + sticky button 配置
2. LINE 加入 incentive 不足 → welcome coupon 価値 up (= ¥500 → ¥1,000)
3. CTA copy 弱い → A/B test (例: 「友だち追加で初回 ¥1,000 OFF」 vs 「LINE 限定情報を受け取る」)

### 注文完了 3 未満 (= 7 日 conversion 低)

仮説:
1. checkout drop-off (= cart → checkout 率低) → 配送料 visibility / coupon code 入力場所改善
2. abandoned cart 通知が届いてない → CF Worker logs で webhook 受信確認
3. 商品単価が広告 click 期待と乖離 → 価格表示透明化 + bundle offer 検討

---

## ref

- GMC setup: [docs/MERCHANT_CENTER_SHIPPING_SETUP_2026-05-28.md](MERCHANT_CENTER_SHIPPING_SETUP_2026-05-28.md)
- Phase 4 後続 PR plan: [docs/PHASE_4_DESIGN_2026-05-27.md](PHASE_4_DESIGN_2026-05-27.md)
- 会員ランク廃止 schedule: [docs/MEMBER_RANKS_DEPRECATION_2026-05-28.md](MEMBER_RANKS_DEPRECATION_2026-05-28.md)
- LP launch 文言案 + KPI: [docs/LP_LAUNCH_SUPPORT.md](LP_LAUNCH_SUPPORT.md) (= 5/22 既存)
- admin web: https://naturism-admin.pages.dev/membership
- 本番 worker: https://naturism-line-crm.katsu-7d5.workers.dev
