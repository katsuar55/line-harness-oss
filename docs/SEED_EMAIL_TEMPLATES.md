# Email Templates Seed 案 (Round 4 実運用準備)

**作成日**: 2026-05-10
**目的**: naturism 実運用開始時に最初に投入すべき 5 種類の email_templates ドラフト
**ステータス**: ⏳ Katsu レビュー待ち。承認後に D1 へ INSERT script で投入。
**法令**: 特定電子メール法 / 個人情報保護法 / 薬機法 (NG 表現を避ける) を考慮済

## 設計方針

- **legal footer は EmailRenderer が自動付与**するため、template には含めない (env `EMAIL_LEGAL_FOOTER_HTML/TEXT` で供給)
- **配信停止リンクは EmailRenderer が自動付与** (marketing カテゴリのみ、List-Unsubscribe header にも自動設定)
- **{{var}} 形式の変数置換**を使用 (mustache 風、ネストなし、エスケープなし)
- **subject 200 文字以内、preheader 150 文字以内** (受信箱でのプレビュー最適化)
- **HTML は inline CSS** (Gmail / iOS Mail 互換性のため、<style> タグは無視されることがある)
- **薬機法**: 効能効果の断定を避ける (「○○ が改善する」 「○○ に効く」 等は使用禁止)

## カテゴリ分類 (法令ゲート)

| カテゴリ | 法令ゲート | 配信停止後も届くか |
|---|---|---|
| `transactional` | unsubscribed_at が設定されていても届く | YES (注文確認・発送通知 等) |
| `marketing` | unsubscribed_at が設定されていれば届かない | NO |

---

## Template 1: `welcome` (友だち追加 + opt-in 確認)

| 項目 | 値 |
|---|---|
| id | `tpl-welcome-v1` |
| name | naturism ウェルカム + opt-in 確認 |
| category | `transactional` (opt-in 確認は法令準拠の transactional とみなせる) |
| subject | `[naturism] ご登録ありがとうございます 🌿` |
| preheader | `naturism のメールマガジン購読のご確認です` |

### html_content

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:#06C755;font-size:22px;margin-bottom:16px;">🌿 naturism へようこそ</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    naturism (株式会社ケンコーエクスプレス) にご登録いただき、ありがとうございます。<br>
    本メールはご登録確認のためにお送りしています。
  </p>
  <p style="font-size:15px;line-height:1.7;">
    今後、新商品のご案内・キャンペーン情報・お得なクーポン等をお届けします。<br>
    配信を希望されない場合は本メール末尾の「配信停止」 リンクからお手続きください。
  </p>
  <div style="background:#f0fdf4;padding:20px;border-radius:8px;margin:24px 0;">
    <p style="font-size:15px;margin:0 0 12px 0;"><strong>🎁 まずはお試しを</strong></p>
    <p style="font-size:14px;margin:0;line-height:1.6;">
      Blue 7日分（42粒）¥696 から始められます。<br>
      <a href="https://naturism-diet.com" style="color:#06C755;text-decoration:none;">公式サイトはこちら</a>
    </p>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    ご不明点は <a href="mailto:support@naturism-diet.com" style="color:#06C755;">support@naturism-diet.com</a> までお気軽にお問い合わせください。
  </p>
</div>
```

### text_content

```
🌿 naturism へようこそ

{{name}} 様

naturism (株式会社ケンコーエクスプレス) にご登録いただき、ありがとうございます。
本メールはご登録確認のためにお送りしています。

今後、新商品のご案内・キャンペーン情報・お得なクーポン等をお届けします。
配信を希望されない場合は本メール末尾の「配信停止」 リンクからお手続きください。

🎁 まずはお試しを
Blue 7日分（42粒）¥696 から始められます。
公式サイト: https://naturism-diet.com

ご不明点は support@naturism-diet.com までお気軽にお問い合わせください。
```

### 想定変数
- `{{name}}` — 受信者の名前 (display_name)

---

## Template 2: `order_confirmation` (Shopify 注文確認)

| 項目 | 値 |
|---|---|
| id | `tpl-order-confirmation-v1` |
| name | naturism ご注文確認 |
| category | `transactional` |
| subject | `[naturism] ご注文ありがとうございます (#{{order_number}})` |
| preheader | `ご注文内容のご確認 — 合計 ¥{{total_amount}}` |

### html_content

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:#06C755;font-size:22px;margin-bottom:16px;">ご注文ありがとうございます</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    このたびは naturism をご注文いただきありがとうございます。<br>
    以下のご注文内容で受け付けました。
  </p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0;">
    <tr><td style="padding:8px 0;color:#666;width:40%;">注文番号</td><td style="padding:8px 0;font-weight:bold;">#{{order_number}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">注文日時</td><td style="padding:8px 0;">{{order_date}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">合計金額</td><td style="padding:8px 0;font-weight:bold;color:#06C755;">¥{{total_amount}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">配送先</td><td style="padding:8px 0;">{{shipping_address}}</td></tr>
  </table>
  <div style="background:#f9fafb;padding:16px;border-radius:8px;margin:20px 0;">
    <p style="font-size:14px;margin:0 0 8px 0;"><strong>📦 配送について</strong></p>
    <p style="font-size:13px;margin:0;line-height:1.6;color:#555;">
      ご注文の確認後、通常 1-2 営業日で発送いたします。<br>
      発送完了時に追跡番号をメールでお知らせします。
    </p>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    ご不明点は <a href="mailto:support@naturism-diet.com" style="color:#06C755;">support@naturism-diet.com</a> までお気軽にお問い合わせください。
  </p>
</div>
```

### text_content

```
ご注文ありがとうございます

{{name}} 様

このたびは naturism をご注文いただきありがとうございます。
以下のご注文内容で受け付けました。

注文番号: #{{order_number}}
注文日時: {{order_date}}
合計金額: ¥{{total_amount}}
配送先: {{shipping_address}}

📦 配送について
ご注文の確認後、通常 1-2 営業日で発送いたします。
発送完了時に追跡番号をメールでお知らせします。

ご不明点は support@naturism-diet.com までお気軽にお問い合わせください。
```

### 想定変数
- `{{name}}` — 受信者名
- `{{order_number}}` — Shopify 注文番号 (例: 1001)
- `{{order_date}}` — 注文日時 (YYYY-MM-DD HH:mm)
- `{{total_amount}}` — 合計金額 (税込、円)
- `{{shipping_address}}` — 配送先 (1 行に整形した文字列)

---

## Template 3: `reorder_reminder` (再購入リマインダー、Phase 6 連携)

| 項目 | 値 |
|---|---|
| id | `tpl-reorder-reminder-v1` |
| name | naturism 再購入リマインダー |
| category | `marketing` |
| subject | `[naturism] {{product_name}} そろそろお手元になくなる頃ではありませんか? ` |
| preheader | `最後のご購入から {{days_since_last}} 日経ちました` |

### html_content

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:#06C755;font-size:22px;margin-bottom:16px;">🌿 そろそろリピートしませんか?</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    最後に <strong>{{product_name}}</strong> をご購入いただいてから {{days_since_last}} 日が経ちました。<br>
    そろそろお手元のお品物が少なくなる頃ではないでしょうか。
  </p>
  <div style="background:#f0fdf4;padding:20px;border-radius:8px;margin:24px 0;text-align:center;">
    <p style="font-size:15px;margin:0 0 12px 0;color:#15803d;"><strong>{{product_name}}</strong></p>
    <p style="font-size:14px;margin:0 0 16px 0;color:#555;">¥{{product_price}}</p>
    <a href="{{product_url}}" style="display:inline-block;background:#06C755;color:#fff;padding:12px 28px;border-radius:24px;text-decoration:none;font-weight:bold;font-size:14px;">
      公式ストアで購入する
    </a>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    定期便で 10% OFF + 送料無料も承っています。<br>
    詳しくは <a href="https://naturism-diet.com/pages/subscription" style="color:#06C755;">公式サイト</a> をご確認ください。
  </p>
</div>
```

### text_content

```
🌿 そろそろリピートしませんか?

{{name}} 様

最後に {{product_name}} をご購入いただいてから {{days_since_last}} 日が経ちました。
そろそろお手元のお品物が少なくなる頃ではないでしょうか。

{{product_name}} ¥{{product_price}}
公式ストアで購入: {{product_url}}

定期便で 10% OFF + 送料無料も承っています。
詳しくは https://naturism-diet.com/pages/subscription をご確認ください。
```

### 想定変数
- `{{name}}` — 受信者名
- `{{product_name}}` — 商品名 (Blue / Pink / Premium)
- `{{product_price}}` — 商品価格 (税込)
- `{{product_url}}` — 商品ページ URL (nutrition_sku_map から取得)
- `{{days_since_last}}` — 前回購入からの経過日数

---

## Template 4: `cart_recovery` (カート放棄リカバリ)

| 項目 | 値 |
|---|---|
| id | `tpl-cart-recovery-v1` |
| name | naturism カート放棄リカバリ |
| category | `marketing` |
| subject | `[naturism] お買い物かごに商品が残っています 🛒` |
| preheader | `カートのお品物のご確認とご注文完了について` |

### html_content

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:#06C755;font-size:22px;margin-bottom:16px;">🛒 お買い物かごに商品が残っています</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    お買い物かごに商品をお入れいただきありがとうございます。<br>
    まだご注文が完了していないようですので、お知らせさせていただきました。
  </p>
  <div style="background:#fff7ed;padding:20px;border-radius:8px;margin:24px 0;border:1px solid #fed7aa;">
    <p style="font-size:14px;margin:0 0 12px 0;color:#c2410c;"><strong>🎁 ただいま限定キャンペーン中</strong></p>
    <p style="font-size:13px;margin:0;line-height:1.6;color:#7c2d12;">
      5,500 円以上のご注文で <strong>送料無料</strong>。<br>
      ご注文確定はカートページから 24 時間以内にお願いします。
    </p>
  </div>
  <div style="text-align:center;margin:24px 0;">
    <a href="{{cart_url}}" style="display:inline-block;background:#06C755;color:#fff;padding:14px 32px;border-radius:24px;text-decoration:none;font-weight:bold;font-size:15px;">
      カートを見る
    </a>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    商品が在庫切れになる前にご注文ください。<br>
    ご不明点は <a href="mailto:support@naturism-diet.com" style="color:#06C755;">support@naturism-diet.com</a> までお気軽にお問い合わせください。
  </p>
</div>
```

### text_content

```
🛒 お買い物かごに商品が残っています

{{name}} 様

お買い物かごに商品をお入れいただきありがとうございます。
まだご注文が完了していないようですので、お知らせさせていただきました。

🎁 ただいま限定キャンペーン中
5,500 円以上のご注文で送料無料。
ご注文確定はカートページから 24 時間以内にお願いします。

カートを見る: {{cart_url}}

商品が在庫切れになる前にご注文ください。
ご不明点は support@naturism-diet.com までお気軽にお問い合わせください。
```

### 想定変数
- `{{name}}` — 受信者名
- `{{cart_url}}` — Shopify カート復元 URL (Shopify Admin API で生成、checkout_url 等)

---

## Template 5: `shipping_notification` (発送通知)

| 項目 | 値 |
|---|---|
| id | `tpl-shipping-notification-v1` |
| name | naturism 発送通知 |
| category | `transactional` |
| subject | `[naturism] 商品を発送しました (#{{order_number}})` |
| preheader | `配送状況の確認はこちらから` |

### html_content

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:#06C755;font-size:22px;margin-bottom:16px;">📦 商品を発送しました</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    お待たせいたしました。ご注文の商品を発送いたしました。
  </p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0;">
    <tr><td style="padding:8px 0;color:#666;width:40%;">注文番号</td><td style="padding:8px 0;font-weight:bold;">#{{order_number}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">配送業者</td><td style="padding:8px 0;">{{carrier}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">追跡番号</td><td style="padding:8px 0;font-family:monospace;">{{tracking_number}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">到着予定</td><td style="padding:8px 0;">{{estimated_delivery_date}}</td></tr>
  </table>
  <div style="text-align:center;margin:24px 0;">
    <a href="{{tracking_url}}" style="display:inline-block;background:#06C755;color:#fff;padding:12px 28px;border-radius:24px;text-decoration:none;font-weight:bold;font-size:14px;">
      配送状況を確認する
    </a>
  </div>
  <div style="background:#f9fafb;padding:16px;border-radius:8px;margin:20px 0;">
    <p style="font-size:13px;margin:0;line-height:1.6;color:#555;">
      💡 <strong>ご不在時の取り扱い</strong><br>
      ご不在の場合は不在票が投函されます。再配達のご連絡は配送業者のサイトをご利用ください。
    </p>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    商品到着後、お気づきの点がございましたら <a href="mailto:support@naturism-diet.com" style="color:#06C755;">support@naturism-diet.com</a> までお問い合わせください。
  </p>
</div>
```

### text_content

```
📦 商品を発送しました

{{name}} 様

お待たせいたしました。ご注文の商品を発送いたしました。

注文番号: #{{order_number}}
配送業者: {{carrier}}
追跡番号: {{tracking_number}}
到着予定: {{estimated_delivery_date}}

配送状況を確認: {{tracking_url}}

💡 ご不在時の取り扱い
ご不在の場合は不在票が投函されます。再配達のご連絡は配送業者のサイトをご利用ください。

商品到着後、お気づきの点がございましたら support@naturism-diet.com までお問い合わせください。
```

### 想定変数
- `{{name}}` — 受信者名
- `{{order_number}}` — Shopify 注文番号
- `{{carrier}}` — 配送業者名 (例: ヤマト運輸、日本郵便)
- `{{tracking_number}}` — 追跡番号
- `{{estimated_delivery_date}}` — 到着予定日 (YYYY-MM-DD)
- `{{tracking_url}}` — 配送業者の追跡 URL

---

## D1 INSERT script (Katsu レビュー後に投入)

```sql
INSERT INTO email_templates (id, name, category, subject, html_content, text_content, preheader, is_active) VALUES
('tpl-welcome-v1', 'naturism ウェルカム + opt-in 確認', 'transactional', '[naturism] ご登録ありがとうございます 🌿',
  '<html_content>', '<text_content>', 'naturism のメールマガジン購読のご確認です', 1),
('tpl-order-confirmation-v1', 'naturism ご注文確認', 'transactional', '[naturism] ご注文ありがとうございます (#{{order_number}})',
  '<html_content>', '<text_content>', 'ご注文内容のご確認 — 合計 ¥{{total_amount}}', 1),
('tpl-reorder-reminder-v1', 'naturism 再購入リマインダー', 'marketing', '[naturism] {{product_name}} そろそろお手元になくなる頃ではありませんか? ',
  '<html_content>', '<text_content>', '最後のご購入から {{days_since_last}} 日経ちました', 1),
('tpl-cart-recovery-v1', 'naturism カート放棄リカバリ', 'marketing', '[naturism] お買い物かごに商品が残っています 🛒',
  '<html_content>', '<text_content>', 'カートのお品物のご確認とご注文完了について', 1),
('tpl-shipping-notification-v1', 'naturism 発送通知', 'transactional', '[naturism] 商品を発送しました (#{{order_number}})',
  '<html_content>', '<text_content>', '配送状況の確認はこちらから', 1);
```

実行は `<html_content>` / `<text_content>` を Liquid escape した形で実 INSERT する。実装は Katsu 承認後に script `scripts/seed_email_templates.mjs` を作成。

## 法令確認チェックリスト

| 項目 | チェック方法 |
|---|---|
| **特定電子メール法**: 配信停止リンクが全 marketing メールに含まれる | EmailRenderer が自動付与 ✅ |
| **特定電子メール法**: 送信元の表示者情報 (株式会社ケンコーエクスプレス、住所) | env.EMAIL_LEGAL_FOOTER_HTML/TEXT で自動付与 ✅ |
| **個人情報保護法**: privacy policy へのリンク | naturism-diet.com に privacy policy 公開済か Katsu 確認 ⏳ |
| **薬機法**: 効能効果断定なし | 全 5 テンプレで断定表現を使用していないことを目視確認済 ✅ |
| **薬機法**: 「治す」「効く」「予防」 等の医薬品的表現なし | 含まれていないことを目視確認済 ✅ |
| **景品表示法**: 「最強」 「最高」 等の優良誤認表現なし | 含まれていないことを目視確認済 (ただし「お得」 は許容) ✅ |

## Katsu レビュー時の確認ポイント

1. ☐ 各テンプレの subject / preheader / 本文の文言は OK か?
2. ☐ 価格表記 (¥696, 5500 円以上で送料無料) は最新か?
3. ☐ Blue 7 日分 ¥696 の表示は合っているか? (最新の SKU 一覧と照合)
4. ☐ 配送業者の表記 (ヤマト/日本郵便) は実態と合うか?
5. ☐ {{cart_url}} のフォーマット (Shopify checkout_url が来る前提で OK か)
6. ☐ {{tracking_url}} は Shopify が fulfillment 時に提供するもので動くか
7. ☐ Privacy policy / 特商法 / 個人情報保護法のページは公開済か (footer リンク確認)

承認後、`scripts/seed_email_templates.mjs` を作成して D1 へ投入予定。
