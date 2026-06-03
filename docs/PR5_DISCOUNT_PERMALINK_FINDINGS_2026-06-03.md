# PR5 実証メモ — 自社割引 + cart permalink 3タップ購入 (2026-06-03)

> Shopify dev MCP (Admin API 最新版) で「割引の併用 (combinesWith) / 割引作成 / cart permalink」を実証した結果と、
> 実装前に Katsu 判断が必要な事項をまとめる。**本番 Shopify 割引の作成は未実施**（customer-facing・実費影響のため承認待ち）。

## 0. PR5 のゴール (再掲)

- **3タップ購入**: マイランク LIFF → [このまま購入] → cart permalink (商品 + 割引自動適用) → [購入] = 3タップ・コード入力ゼロ。
- **13% スタッキング**: サブスク (2回目以降5%) + ランク (プラチナ8%) = 最大13% を**自社管理割引**で実現。
- cb-admin の「感謝クーポン (1回限り・併用不可)」制約を超えるため、割引を自社発行し combinesWith を自前制御。
- ⚠️ cb-admin 感謝クーポンと**衝突しないコード namespace** で発行。

## 1. 実証結果 (Shopify Admin API)

### 1-1. 割引作成 mutation (両方 存在・検証済)
| mutation | 用途 | 適用 |
|---|---|---|
| `discountCodeBasicCreate` | **コード式** %/定額オフ。`customerSelection` で顧客限定可、`combinesWith` 指定可 | **ランク割引に最適** (= 顧客別・コード) |
| `discountAutomaticBasicCreate` | **自動** %/定額オフ (コード不要、cart/checkout で自動適用) | 店舗全体一律向け (= 顧客別ランクには不向き) |

→ **ランクは顧客別**のため、店舗全体 automatic ではなく **per-customer コード割引** が自然 (cb-admin と同方式だが自社所有)。
   `customerSelection` で対象顧客を限定でき、cart permalink `?discount={code}` で自動適用 → コード入力ゼロを実現。

### 1-2. ⚠️ 併用 (combinesWith) の核心制約 — Shopify Plus 依存
`DiscountCombinesWithInput` = `{ orderDiscounts, productDiscounts, shippingDiscounts }` (各 default false) + `productDiscountsWithTagsOnSameCartLine`。

公式ドキュメント原文 (2ソースで確認):
> "By default, **only one product discount applies per line**. Available **only on a Shopify Plus plan** and requires the productDiscounts field to be set to true." (`productDiscountsWithTagsOnSameCartLine`)

**意味**: 同一カートラインに **2つの "product" クラス割引を重ねる**には **Shopify Plus が必要** (tag 双方向マッチ方式)。
- naturism は Plus 非加入と推定 (設計 doc: multipass/Plus は無い前提)。
- → サブスク% と ランク% を**両方 product 割引**にすると、同一商品ラインでは **片方しか効かない** = 13% にならない。

### 1-3. Plus 不要の回避策 = cross-class 併用
割引クラスが**異なれば** (order × product) Plus なしで併用可:
- **ランク割引 = order discount (注文小計%オフ)** + `combinesWith.productDiscounts = true`
- サブスク割引 = product discount のままで `combinesWith.orderDiscounts = true` なら → **両者 stack = 13% 実現 (Plus 不要)**
- ⚠️ ただし**サブスク割引側の class と combinesWith はサブスクアプリ (定期購買) が決めている** → 自社で変更不可。実店舗で実体確認が必須。

### 1-4. cart permalink (3タップ購入の要)
- 形式: `https://{shop}/cart/{variantId}:{qty}?discount={CODE}` (Online Store / theme 機能、Admin API 範囲外のため dev docs では hit せず)。
- **URL に入れられる割引は「コード」1枚のみ**。automatic 割引は URL 不要で自動適用 (= コードと自動は別枠で両立可)。
- → 3タップ flow: permalink に**ランクコード**を載せ、(将来サブスク自動割引があれば) 自動分は別途乗る。
- ⚠️ **naturism の実テーマ + checkout で `?discount=` 自動適用が効くか実機確認が必要** (テーマ/Checkout 拡張で挙動差あり)。

## 2. スコープ分割 (feasibility 別)

| 機能 | Plus 依存 | サブスクアプリ依存 | 本セッションでの判断 |
|---|---|---|---|
| **3タップ単発購入** (ランク割引1枚 + permalink) | ❌ 不要 | ❌ 無関係 | **実装可** (単一割引、Plus 問題なし) |
| **13% スタッキング** (サブスク注文に rank 上乗せ) | △ same-class なら要 / cross-class なら不要 | ✅ 依存 (アプリの class/combinesWith 次第) | **要・実店舗確認 + Katsu 戦略判断** |

## 3. 🔴 実装前に必要な確認 / Katsu 判断事項

1. **naturism は Shopify Plus か?** (= same-line で2 product 割引を重ねられるか)。非 Plus なら 13% は cross-class 設計 (ランク=order 割引) 一択。
2. **定期購買アプリのサブスク割引の実体** (discount class = product/order?、combinesWith 設定) を実店舗で確認。これ次第で 13% 併用の可否が決まる。
   - 確認方法: Shopify Admin で既存サブスク注文の applied discounts、または Admin API `codeDiscountNodes`/`automaticDiscountNodes` で class + combinesWith を読む。
3. **本番 Shopify への自社ランク割引の作成承認** (per-customer コード、実費なし・但し顧客の実購入に影響 = customer-facing)。
4. **コード namespace**: cb-admin 感謝クーポン (固有コード例 `9a69e160c2c5854`) と衝突回避。自社は **`NLR-{rank}-{friend短縮}`** 等の明示 prefix を推奨 (NLR = naturism loyalty rank)。
5. **cart permalink `?discount=` が naturism テーマ/Checkout で自動適用されるか**実機確認。

## 4. 実装計画 (段階・依存順)

| sub-PR | 内容 | 本番 Shopify 書込 | autonomous 可否 |
|---|---|---|---|
| **5a** | 割引発行サービス core (`discountCodeBasicCreate` ラッパ + combinesWith + namespace + 冪等) + TDD | ❌ (mock/dry-run) | ✅ 可 (backend、本番未書込) |
| **5b** | マイランク LIFF に [このまま購入] = cart permalink builder (`/cart/{variant}:{qty}?discount={rankCode}`) | ❌ | ✅ 可 (LIFF UI、リンク生成のみ) |
| **5c** | 実発行 + 実店舗併用検証 + 本番 wiring | ✅ | ❌ Katsu 承認・実機確認ゲート |

→ **5a/5b は本番に触れず autonomous 実装可**。5c のみ Katsu ゲート。

## 5. 参考 (実証で確認した API)
- `discountCodeBasicCreate` / `discountAutomaticBasicCreate` (Admin GraphQL latest)
- `DiscountCombinesWithInput` / `DiscountCombinesWith` (order/product/shipping + productDiscountsWithTagsOnSameCartLine = Plus 限定)
- cart permalink `?discount=` は Online Store 機能 (theme 実機確認要)
