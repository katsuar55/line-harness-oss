# Shopify Flow → LINE CRM サブスク実測値連携 設定手順 (WI-2 / §10-0 ①)

**目的**: 定期購買 (Huckleberry) の Flow トリガーが持つ「次回決済日」の実測値を本 CRM へ送り、
LINE カード/リマインドの日付を**推定から実測へ**昇格させる。

**なぜ必須か** (2026-08-01 の本番実測): active 契約 139 件のうち **68 件 (約半分) が推定日を出せない**。
内訳は `last_order_at` 欠落 65 / `interval_days` 欠落 3。ローカル `shopify_orders` は
`read_all_orders` scope が無く直近 60 日分しか無いため、顧客タグから契約は作れても
紐づく注文が無く決済日を逆算できない ([[feedback_shopify_orders_60day_scope]])。
**導出推定では埋まらない。Flow の実測値だけが埋められる。**

**所要**: 約 15 分 (Katsu 操作 — 定期購買/Flow は埋め込みアプリで Claude が操作できない)。
未設定でも機能は推定値で動作する (壊れはしないが、上記 68 件は日付なしのまま)。

## 前提 A: 収集 gate を ON にする

`SUBSCRIPTION_INGEST_ENABLED=true` が無いと受信口は **202 で黙って捨てる**。

> Admin Ops → op = `enable-subscription-ingest`

これは**収集だけ**を開始する gate で、顧客に見える面 (トーク内の契約カード / サブスク intent /
リッチメニュー) は `SUBSCRIPTION_MENU_ENABLED` のまま OFF。
**この順序が要**: 先に MENU を開けると、日付を出せない契約のカードを顧客に見せることになる。

## 前提 B: TEIKI_FLOW_SECRET の準備

シークレット値はチャットにも Actions ログ (PUBLIC repo) にも出さない運用。

1. パスワードマネージャ等で 32 文字以上の**英数字**ランダム文字列を生成
2. GitHub → Settings → Secrets and variables → Actions → New repository secret で
   Name = `TEIKI_FLOW_SECRET`、Value = 生成した値 を保存 (ここは GitHub がマスクする)
3. GitHub → Actions → **Admin Ops** → Run workflow → op = `put-teiki-flow-secret`
   (repo secret から読んで wrangler secret に投入する。値はログに出ない)
4. **同じ値**を下記手順 3 の `X-Teiki-Flow-Secret` ヘッダに貼り付ける (パスワードマネージャから)

## 設定するトリガー

定期購買アプリが提供する Flow トリガーのうち、**次回決済日が動く瞬間**を押さえる。
1 つのワークフロー = 1 トリガーなので、下記をそれぞれ作る (アクションは全て同一)。

| # | トリガー | なぜ必要か | 優先度 |
|---|---|---|---|
| 1 | **決済日n日前通知メール** | 決済の n 日前 (現在 7 日前) に発火し、**その時点の次回決済日**を運ぶ。リマインド窓 `[3,7]` の入口と一致するため、**これ 1 本で窓に入る契約が実測になる** | ★必須 |
| 2 | **スキップ時** | スキップは次回決済日を 1 周期先送りする。推定側はタグの skip-count から追えるが実測が正 | ★必須 |
| 3 | **お届け日の変更時** | **タグに現れない**変更。推定が原理的に追えない唯一のケース | ★必須 |
| 4 | 初回の購入時 / 2回目以降の購入時 | 決済直後に次サイクルの日付を実測で入れる (推定でも出せるので任意) | 任意 |
| 5 | スキップの取り消し時 / プラン(周期)の変更時 | 同上 (日付が動く) | 任意 |

`契約作成` という名前のトリガーは存在しない — 実体は「初回の購入時」。

## 手順 (各トリガーで同じ)

1. Shopify 管理画面 → アプリ → **Flow** → 「ワークフローを作成」
   - 直リンク: https://admin.shopify.com/store/xn-0ckn0a9fxa4a/apps/flow
2. **トリガー**を選ぶ → 検索窓に「定期購買」と入力 → 上表のトリガーを 1 つ選ぶ
3. **アクション**: 「HTTP リクエストを送信」(Send HTTP request)
   - Method: `POST`
   - URL: `https://naturism-line-crm.katsu-7d5.workers.dev/api/integrations/teiki-flow`
   - Headers:
     - `Content-Type: application/json`
     - `X-Teiki-Flow-Secret: <TEIKI_FLOW_SECRET と同じ値>`
   - Body (変数ピッカーから該当変数を挿入):
     ```json
     {
       "contract_id": "{{ 契約ID の変数 }}",
       "next_billing_date": "{{ 次回決済日 の変数 }}"
     }
     ```
   - 日付フォーマットは定期購買 → 一般設定 →「Flow Trigger 設定」の既定
     (`YYYY年M月D日 hh:mm頃`) のままで OK — 受信側が和文形式もパースする
4. ワークフローを **オン** にして保存
5. **1 本目だけテスト実行**し、Flow の実行ログでレスポンス本文を確認する:
   - `"source": "flow"` → 成功
   - `"skipped": "unknown_contract"` → **契約ID 変数の選び間違い**の可能性 (レスポンスの `hint` 参照)。
     新規契約直後なら race なので次回発火で自然回復する
   - `400` → `next_billing_date` の変数が空 / 日付として読めない
   - `401` → シークレット不一致 (前提 B の 3 と 4 で**同じ値**を使ったか)
   - `202` → 収集 gate が OFF (前提 A)

## 効果の確認

Admin Ops → op = `reminder-dry-run` の「**日付ソースの内訳**」セクションで
`measured_by_flow` が増えていく。トリガー 1 は決済 7 日前にしか発火しないため、
**設定直後に一気に増えるのではなく、周期に沿って数日〜1ヶ月かけて積み上がる**。

D1 を直接見る場合:

```bash
cd apps/worker && npx wrangler d1 execute naturism-line-crm --remote --command \
  "SELECT COUNT(*) FROM subscription_contracts WHERE estimate_source = 'flow'"
```

## 受信側の仕様 (参考)

- `POST /api/integrations/teiki-flow` (routes/shopify.ts)
- 認可: `X-Teiki-Flow-Secret` ヘッダ (定数時間比較)。不一致・secret 未設定とも 401
  (未設定はサーバログでのみ判別 — 設定状態を外部に開示しない)
- gate: `SUBSCRIPTION_INGEST_ENABLED` または `SUBSCRIPTION_MENU_ENABLED` (どちらかが `true`)。
  OFF なら 202 (Flow に再試行させない)
- 日付は `YYYY年M月D日 [hh:mm頃]` (Flow 既定の和文形式)・タイムゾーン付き ISO・
  `YYYY-MM-DD...` のいずれも受理 (JST 日付に正規化、暦として不正な日付は 400)
- 契約 ID は素の値で引き、見つからなければ GID (`gid://shopify/SubscriptionContract/123`) の
  末尾セグメントでも引く。**どちらでも実在行にしか書かない** (phantom 行を作らない)
- 未知の contract_id は **200 + skipped + hint** で受ける。契約作成トリガーが注文 webhook より
  先着する race で起きうるが、Flow は 4xx を再試行しないため実行ログを green に保ち、
  次のトリガー発火で自然回復する
- 実測値 (`estimate_source='flow'`) はタグ由来の再計算では上書きされないが、
  **新しく見える実注文が来ると `derived` に戻る**。
  ⚠️ `last_order_at` を持たない契約 (= 実測が唯一の日付ソース = ① の主対象) では
  「新しい注文」判定が常に真になるため、Huckleberry のタグ後付け・出荷更新で飛ぶ
  過去注文の `orders/updated` でも実測が失われ、**過去日の推定に戻ることがある**。
  この状態は窓 (`[3,7]` 日前) の外なのでリマインドは送られず、
  **次の Flow 発火 (7日前通知 / スキップ / お届け日変更) で自然に回復する**。
  「実測日以降の注文だけが derived に戻す」という保護を検討したが棄却した —
  実測を保持した行は後続のスキップ先送りを一切反映しないため、
  スキップ済みの顧客に古い決済日でリマインドを送る経路ができるため
  (誤送信は回復しない / 過去日は回復する)
