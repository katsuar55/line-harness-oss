# Merchant Center Shipping Setup — LP launch 最終 blocker 解消手順

**作成**: 2026-05-28 (= autonomous session、 5/27 Shopify Markets「国際」 削除後の 24h verify で判明)
**所要時間**: **user 約 5 分** (= GMC ダッシュボード操作のみ)
**緊急度**: 🔥 **最優先** (= LP launch 本線の唯一の残 blocker)

---

## 🚨 現状 (= 2026-05-28 朝、 スクショ確認)

GMC ダッシュボード:
- **Total products: 12**
- **Approved: 0**  ← 期待 12 ❌
- **Limited: 12 (100%)** ← LP launch 不可
- **Not approved: 0**
- **Under review: 0**

未対応 step:
- ⚠️ **Add details to show how you ship your products** ← 残 blocker

---

## 🔍 真因 (= ULTRATHINK 再分析)

5/27 session で「Shopify Markets「国際」 削除で 24h 自動解消」 と予測したが、 **GMC は Shopify Markets と independent に shipping zone を持つ**:

| layer | 5/27 削除前 | 5/27 削除後 | 必要 |
|---|---|---|---|
| Shopify Markets 国際 | 29 国 active (配送料未設定) | 削除 ✅ | 削除済 |
| Shopify Markets 国内 (日本) | active (配送料設定済) | 維持 ✅ | 維持 |
| **GMC shipping zone (= GMC 内)** | **設定なし** | **設定なし** ❌ | **要設定** |

つまり LP launch 本線の **最終 blocker は GMC 内 shipping zone 設定** (= 「Shopify と接続済み」 状態でも GMC は配送情報 missing と判定)。

### 学び (= 5/27 skill 補強)

`feedback_shopify_markets_silent_blocker.md` の前提 「Markets 削除で MC 自動解消」 は **不十分** だった:
- Shopify Markets 削除 = 韓国 BRN / 通貨 mismatch (= 3 issues のうち 2) は解消
- **GMC shipping setup は別 layer** = Markets 削除では touched されない
- → 「Missing shipping information」 (= 3rd issue) は **GMC 内設定で解消**

---

## ✅ user action 手順 (= 5 分)

### Step 1: GMC ダッシュボード「Add details to show how you ship your products」 click

スクショの **「Add」 button** click:
```
URL: https://merchants.google.com/mc/overview?a=11652571
→ Show your products on Google → Add details to show how you ship your products → 「Add」
```

### Step 2: Shipping service 追加

「Shipping service」 設定画面で:

#### 推奨値 (= naturism 商品 spec + 既存 Shopify 設定 整合)

| 項目 | 推奨値 | 理由 |
|---|---|---|
| Service name | `日本国内 標準配送` | わかりやすさ |
| Shipping origin | 日本 (JP) | 既存 Shopify 設定 |
| Shipping destination | 日本 (JP) | naturism は国内 only confirmed |
| Delivery time | 2-5 営業日 | naturism Shopify 既存設定と整合 |
| **Shipping cost** | **送料無料 (= 0 円)** | LP launch インセンティブ + Shopify 商品単価 ¥389-¥2,000 で送料無料が conversion 最適 |

#### 代替案 (= 送料設定したい場合)

| 設定 | 値 | 注意 |
|---|---|---|
| 一律 ¥800 | 全国一律 | naturism 既存 Shopify 設定と一致 |
| 一定額以上送料無料 | 例: ¥3,000 以上送料無料、 未満 ¥800 | upsell 効果あり、 但し設定が複雑 |

**📌 推奨は「送料無料」**: LP launch 初期は friction 最小化が conversion 優先。 既存 Shopify でも naturism 商品単価が低いため送料が conversion blocker になりやすい。

### Step 3: 保存 + 確認

「Save」 click → GMC dashboard に戻る → 「Show your products on Google」 step が全て ✅ になるか確認。

### Step 4: 24h 待機

GMC が再 audit 実行 (= 24h 程度)。 翌日 (= 2026-05-29 朝) に再度:
- https://merchants.google.com/mc/products/diagnostics?a=11652571
- Approved: 0 → **12** に変化することを確認

---

## 🎯 完了後の next action (= LP launch GO)

Approved 12 確認後:
1. **Google Ads キャンペーン開始準備**: docs/LP_LAUNCH_SUPPORT.md 参照 (= 文言案 + UTM 設計 + KPI plan)
2. **LP naturism-diet.com 動作確認**: 既存 + Google Ads 流入経路の整合
3. **LINE 友だち追加導線 動作確認**: webhook + 動的クーポン (= LINE-UXSE4P6D 等)
4. **流入観察**: 7 日間 KPI = friends 100+ / clicks 1,000+ 目標

---

## 📚 関連 doc / memory

- **5/27 skill**: `feedback_shopify_markets_silent_blocker.md` (= 「100% 全件 issue」 = account-level signal、 本 doc で補強済)
- **5/22 doc**: `docs/LP_LAUNCH_SUPPORT.md` (= LP launch 後の文言案 / KPI plan)
- **5/27 doc**: `docs/PHASE_4_DESIGN_2026-05-27.md` (= LP launch 後の Phase 4 後続 PR)
- **GMC ID**: 11652571 (= 健康エクスプレス)
- **Shopify store**: xn-0ckn0a9fxa4a (= naturism-diet.com)

---

## ⏳ Trouble shoot (= 24h 後も Approved 0 のままの場合)

| 症状 | 仮説 |
|---|---|
| Limited 12 のまま | shipping setup 反映遅延 (= 最大 72h)、 さらに 24h 待機 |
| Limited 8 / Approved 4 等 | 個別 product 問題 (= PR #79 で実装した audit 利用) |
| Not approved 発生 | GMC policy violation (= 薬機法 / 効能効果記述、 8 商品追加時にも注意) |
| Approved 0 / Under review 12 | 通常 24h で完了、 さらに 24h 待機 |

別 issue が新規発生時:
- /google-audit page (= https://naturism-admin.pages.dev/google-audit) で再 audit
- PR #79 で実装した 7 仮説 audit を試行
