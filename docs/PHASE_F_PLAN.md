# Phase F: LINE通知有効化 計画

**前提:** Phase E試運転が完了し、Webhookデータが正常にD1に記録されている状態

---

## ステップ 1: HMAC署名検証の修正確認

現在Shopify Webhookが全件`auth_failed`のため、まずこれを解決する。

```powershell
# デプロイ後、D1で成功ログを確認
npx wrangler d1 execute naturism-line-crm --remote --command "SELECT status, COUNT(*) FROM shopify_webhook_log WHERE received_at > '2026-04-13T12:00:00' GROUP BY status"
```

**もし引き続き失敗する場合:**
```powershell
# SHOPIFY_WEBHOOK_SECRET を SHOPIFY_CLIENT_SECRET と同じ値に再設定
# Shopify Partner Dashboard → アプリ → LINE Harness CRM → API credentials → Client secret をコピー
echo "ここにclient_secretの値" | npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
```

## ステップ 2: Webhookデータ蓄積確認（1-2日）

- D1の `shopify_webhook_log` に `processed` ステータスのレコードが蓄積されるか
- `shopify_orders`, `shopify_customers` テーブルにWebhook経由のデータが入るか
- フレンドマッチング（メール/電話番号での紐付け）が動作するか

```powershell
npx wrangler d1 execute naturism-line-crm --remote --command "SELECT status, COUNT(*) as cnt FROM shopify_webhook_log GROUP BY status"
```

## ステップ 3: LINE通知有効化

全Webhookが正常に処理されることを確認後:

```powershell
echo "true" | npx wrangler secret put SHOPIFY_LINE_NOTIFY_ENABLED
```

### 通知が送信される条件

| トリガー | 通知内容 | 条件 |
|---------|---------|------|
| 配送通知 (fulfillments/create) | 「ご注文の商品が発送されました！追跡番号: XXX」 | LINE友だちとマッチ + 追跡番号あり |
| 再入荷通知 (products/update) | 「XXXが再入荷しました！」 | 再入荷リクエスト済みの友だち |
| 決済完了通知 (orders/create) | 「ご注文ありがとうございます！注文番号: #XXX」 | LINE友だちとマッチ |

### 通知が送信されない場合
- LINE友だちとShopify顧客がマッチしない（メール/電話番号が未登録）
- `SHOPIFY_LINE_NOTIFY_ENABLED` が `'true'` でない

## ステップ 4: モニタリング（1週間）

有効化後、以下を監視:

```powershell
# Webhookログ確認
npx wrangler d1 execute naturism-line-crm --remote --command "SELECT topic, status, COUNT(*) as cnt FROM shopify_webhook_log WHERE received_at > datetime('now', '-1 day') GROUP BY topic, status"

# LINE通知送信エラー確認
npx wrangler tail --format pretty 2>&1 | findstr "LINE push"
```

## ステップ 5: CRM PLUS on LINE 移行判断

LINE通知が安定稼働したら:
- CRM PLUS on LINE の通知機能を無効化（重複防止）
- CRM PLUSの他機能（友だち追加経路分析等）は継続利用可能

---

## ロールバック手順

問題が発生した場合:
```powershell
# LINE通知を即座にOFFにする
npx wrangler secret delete SHOPIFY_LINE_NOTIFY_ENABLED
# または
echo "false" | npx wrangler secret put SHOPIFY_LINE_NOTIFY_ENABLED
```

通知OFFにしてもWebhookデータの受信・保存は継続される（安全側に倒す設計）。
