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

### Step 0: GMC ダッシュボード「Add details to show how you ship your products」 click

```
URL: https://merchants.google.com/mc/overview?a=11652571
→ Show your products on Google → Add details to show how you ship your products → 「Add」
```

「Add your shipping information」 wizard が開く (= 4 step process)。

---

### Step 1: Countries (= 配送対象国を選択)

スクショ画面 (= 2026-05-28 user 確認済):
- Policy name: `Shipping Policy 5 9` (= 自動生成、 そのまま OK or `日本国内 配送ポリシー` に編集任意)
- Countries 一覧 (= 32 国程度の checkbox list)

**📌 推奨**: **Japan のみ check** (= naturism は国内 only confirmed)
- ❌ Australia / Austria / Belgium / Canada / Czechia / Denmark / Finland / France / Gambia / Germany / Greece / Hong Kong / Ireland / Israel / Italy
- ✅ **Japan**  ← この 1 つだけ check
- ❌ Malaysia / Netherlands / New Zealand / Norway / Poland / Portugal / Singapore / South Korea / Spain / Sweden / Switzerland / Taiwan / Thailand / United Arab Emirates / United Kingdom / United States

→ 「Continue」 click

---

### Step 2: Products (= 適用 product 範囲)

「Apply to which products?」 選択肢:
- **All products** ← 推奨 (= 12 商品全てに同じ shipping policy)
- Specific products only

**📌 推奨**: **All products** select → 「Continue」

理由: naturism 商品 12 種類は全て同じサプリメント (= ¥389-¥2,000)、 配送料 + 配送時間 を商品ごとに差別化する理由ない。 1 つの policy で全部カバー。

---

### Step 3: Delivery times (= 配送時間)

「How long does it take to deliver?」 設定:
- **Order cutoff time**: 注文の締め時刻 (= 推奨: `12:00` 平日昼まで翌営業日発送)
- **Order handling time**: 注文処理日数 (= 推奨: `0-1 business days` 即日 or 翌営業日発送)
- **Transit time**: 配送日数 (= 推奨: `1-4 business days` 全国 1-4 営業日)

**📌 推奨設定**:
| 項目 | 値 |
|---|---|
| Order cutoff time | 12:00 (= 平日昼) |
| Min handling time | 0 days |
| Max handling time | 1 day |
| Min transit time | 1 day |
| Max transit time | 4 days |

合計 customer 視点では「**注文 → 1-5 営業日で到着**」 表示 = naturism Shopify 既存設定 (= 2-5 営業日) と整合。

→ 「Continue」 click

---

### Step 4: Shipping costs (= 送料設定)

「How much does shipping cost?」 選択肢:
- **Free shipping** ← **推奨**
- Flat rate (= 一律料金)
- Calculated rate (= 重量 / 距離計算)

**📌 推奨**: **Free shipping** (= 送料無料)

理由 (= LP launch インセンティブ):
- naturism 商品単価 ¥389-¥2,000 で送料 ¥800 を加算すると **送料が商品価格を超える case** がある → conversion blocker
- LP launch 初期は friction 最小化が conversion 優先
- 既存 Shopify は ¥3,000 以上送料無料、 未満 ¥600 設定だが、 GMC 表示は **送料無料 で広告 click 率最大化**
- 実際の checkout で Shopify 配送料計算ロジック (= ¥3,000 未満 ¥600) が走るため、 GMC「送料無料」 表示 + Shopify checkout 配送料は **不一致リスクあり** → 但し Google Merchant Center policy 上 「shipping cost in GMC ≦ actual checkout cost」 は OK (= 顧客に有利な direction)

→ 「**Free shipping**」 select → 「Save」 click

---

### Step 5: 保存後の確認

「Save」 click → GMC dashboard に戻る:
- 「Show your products on Google」 step が **全て ✅** になることを確認
- 「Add details to show how you ship your products」 → ✅ 消える

→ 24h 以内に GMC 再 audit 実行

---

### Step 6: 24h 待機

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
