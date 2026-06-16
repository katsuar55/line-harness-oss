# Cutover Prep A — 実測ステータス（2026-06-16）

`docs/CUTOVER_RUNBOOK.md` の **Stage A（前日準備・🟢 自律分）** を本番 D1 で実測・検証した結果。
再確認は **`node scripts/cutover-prep-A.mjs`**（read-only 監査ランナー）で一発実行できる。

> 結論: **Stage A の自律分はすべて緑（B カットオーバーへ進める）**。
> 残るは 🔴 Katsu ゲート（A-2 secret 差替 / A-6 OA Manager）と、A-2 後のリッチメニュー、
> および A-5 Shopify webhook の最終確認（`API_KEY` を渡してランナー実行）だけ。

## ランナー出力（2026-06-16, read-only / API_KEY 無し）

```
✅ OK  [A-1] 本番 worker root (200)
✅ OK  [A-3] inventory_item_id 欠落商品 (0)
✅ OK  [A-4] キーワード自動応答 / FAQ (40 / 最低 10)
✅ OK  [A-4] ウェルカムシナリオ (1 / 最低 1)
✅ OK  [A-4] automation ルール (6 / 最低 3)
✅ OK  [A-4] タグ (14 / 最低 5)
✅ OK  [A-4] email テンプレート (7 / 最低 3)
✅ OK  [A-4] 月次ブロードキャスト (14 / 最低 6)
✅ OK  [A-4] ブランド設定 (1 / 最低 1)
✅ OK  [A-4] Shopify 商品同期 (25 / 最低 1)
•  SKIP [A-5] Shopify webhook 購読 — API_KEY 未設定 (検証 skip)
🔴 GATE [A-2] 本番 OA secret 差替
🔴 GATE [A-6] OA Manager 応答設定
🔴 GATE [A-4] リッチメニュー作成 (A-2 後)
```

## 項目別の検証メモ

| Runbook | 項目 | 実測 | 判定 | 備考 |
|---|---|---|---|---|
| A-1 | コード/deploy | main `e104f79`・root 200 | ✅ | 当日は `pnpm preflight` + `pnpm --filter worker run deploy` を別途実行 |
| A-3 | migration 065 | shopify_products 25/25 が `inventory_item_id` 保有 | ✅ | #117 で適用済（欠落 0 件） |
| A-4 | auto_replies (FAQ) | 40 件 | ✅ | #119 で公式準拠 FAQ v3 投入済 |
| A-4 | ウェルカムシナリオ | `naturism-welcome-v1`・1 step・**Flex**・`friend_add`・active | ✅ | v3 で単一 Flex カード（クーポン入り）に集約済。旧 4-step seed は過去設計 |
| A-4 | automations | 6 件 | ✅ | |
| A-4 | tags | 14 件 | ✅ | |
| A-4 | email_templates | 7 件 | ✅ | |
| A-4 | 月次ブロードキャスト | broadcasts 14 件 | ✅ | `scripts/monthly-broadcast-*-seed.sql` ×12 + α |
| A-4 | brand_config | 1 件 | ✅ | |
| A-4 | Shopify 商品同期 | 25 件 | ✅ | #117 |
| A-4 | リッチメニュー | LINE プラットフォーム側リソース（D1 テーブル無し） | 🔴/⏳ | **A-2 secret 差替後**に `scripts/setup-rich-menu.mjs` で本番 OA に作成（作成のみ・set default は B-4） |
| A-5 | Shopify webhook 購読 | 要 `API_KEY` で確認 | ⏳ | 10 topic（orders/customers/products/fulfillments/**inventory_levels/update**）。`API_KEY=xxx node scripts/cutover-prep-A.mjs --register` |
| A-2 | 本番 secret 差替 | — | 🔴 Katsu | `wrangler secret bulk`（`"値"\|put` の `\r` trap 回避） |
| A-6 | OA Manager 設定 | — | 🔴 Katsu | チャット ON（手動のみ）/ 応答・あいさつ OFF / AI ボット不使用 |

## 補足（調査で確定した事実）

- **`line_accounts` = 0 行は正常**。`apps/worker/src/routes/webhook.ts` は `c.env.LINE_CHANNEL_SECRET/ACCESS_TOKEN` を
  デフォルトに使い、`destination` で `line_accounts` に当たらなければ env にフォールバックする（単一アカウント env モード）。
  友だち 1 件・ブロードキャスト 14 件が現に動作している事実とも整合。第 2 ブランド追加時に初めて行が要る。
- **`templates`（LINE メッセージテンプレート）= 0、`faq_items` = 0、`reminders/intake_reminders` = 0** は launch 非ブロッカー。
  FAQ は `auto_replies`（40 件）で機能し、テンプレートは管理画面の便宜機能、リマインダーは運用時に作成する。

## 当日の最短手順（A）

1. `node scripts/cutover-prep-A.mjs` → 自律分が緑であることを確認
2. 🔴 A-2: 本番 secret を `wrangler secret bulk` で投入 → `pnpm --filter worker run deploy`
3. `API_KEY=xxx node scripts/cutover-prep-A.mjs --register` → A-5 webhook を登録・確認
4. A-2 後: `node scripts/setup-rich-menu.mjs`（リッチメニュー作成のみ）
5. 🔴 A-6: OA Manager 応答設定を確認 → B（カットオーバー）へ
