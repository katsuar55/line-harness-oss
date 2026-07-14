# Shopify Flow → LINE CRM サブスク実測値連携 設定手順 (WI-2)

**目的**: 定期購買 (Huckleberry) の Flow Trigger が持つ「次回決済日」の実測値を本 CRM へ送り、
LINE カード/リマインドの日付を「推定」から「実測」に昇格させる。
**所要**: 約 5 分 (Katsu 操作 — 定期購買アプリ内の設定は Claude が操作できないため)。
未設定でも機能は推定値で動作する (この連携は精度向上のオプション)。

## 前提: TEIKI_FLOW_SECRET の準備 (値の受け渡し手順)

シークレット値はチャットにも Actions ログ (PUBLIC repo) にも出さない運用。手順:

1. パスワードマネージャ等で 32 文字以上の**英数字**ランダム文字列を生成
2. GitHub → リポジトリの Settings → Secrets and variables → Actions → New repository secret で
   Name = `TEIKI_FLOW_SECRET`、Value = 生成した値 を保存 (ここは GitHub がマスクする)
3. GitHub → Actions → **Admin Ops** workflow → Run workflow → op = `put-teiki-flow-secret` を実行
   (repo secret から読んで wrangler secret に投入する。値はログに出ない)
4. **同じ値**を下記手順 3 の `X-Teiki-Flow-Secret` ヘッダに貼り付ける (パスワードマネージャから)
5. `SUBSCRIPTION_MENU_ENABLED=true` 済みであること (OFF 中は 202 で無視される)

## 手順

1. Shopify 管理画面 → アプリ → **Flow** → 「ワークフローを作成」
2. **トリガー**: 「定期購買」アプリのトリガーから、次回決済日を含むもの
   (例: サブスクリプション契約の作成/更新系トリガー。定期購買 → 一般設定 →「Flow Trigger 設定」の
   日付フォーマットは既定の `YYYY年M月D日 hh:mm頃` のままで OK — 受信側が和文形式もパースする)
   ※ 契約作成・スキップ・お届け日変更の各トリガーがあれば、それぞれ同じアクションで複製する
3. **アクション**: 「HTTP リクエストを送信」(Send HTTP request)
   - Method: `POST`
   - URL: `https://naturism-line-crm.katsu-7d5.workers.dev/api/integrations/teiki-flow`
   - Headers:
     - `Content-Type: application/json`
     - `X-Teiki-Flow-Secret: <TEIKI_FLOW_SECRET と同じ値>`
   - Body (トリガーの変数ピッカーから該当変数を挿入):
     ```json
     {
       "contract_id": "{{ 契約ID の変数 }}",
       "next_billing_date": "{{ 次回決済日 の変数 }}"
     }
     ```
4. ワークフローを **オン** にして保存
5. 動作確認: テスト実行 (Flow の実行ログで HTTP 200 を確認)。CRM 側の確認コマンド:

   ```bash
   cd apps/worker && npx wrangler d1 execute naturism-line-crm --remote --command \
     "SELECT contract_id, next_billing_estimate, updated_at FROM subscription_contracts WHERE estimate_source = 'flow'"
   ```

## 受信側の仕様 (参考)

- `POST /api/integrations/teiki-flow` (routes/shopify.ts)
- 認可: `X-Teiki-Flow-Secret` ヘッダ (定数時間比較)。不一致・secret 未設定とも 401
  (未設定はサーバログでのみ判別 — 設定状態を外部に開示しない)
- 日付は `YYYY年M月D日 [hh:mm頃]` (Flow 既定の和文形式)・タイムゾーン付き ISO・
  `YYYY-MM-DD...` のいずれも受理 (JST 日付に正規化、暦として不正な日付は 400)
- 未知の contract_id は **200 + skipped** で受ける (phantom 行は作らない)。
  契約作成トリガーが注文 webhook より先着する race で起きうるが、Flow は 4xx を再試行しない
  ため実行ログを green に保ち、次のトリガー発火で自然回復する
- 実測値 (`estimate_source='flow'`) は導出ロジックで上書きされない。
  次の実注文 (決済成功) で `derived` に戻り通常の推定が再開する
