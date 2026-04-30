# オーナー判断 / 手動オペレーション一枚チェックリスト

**作成**: 2026-04-29 / **対象期限**: 2026-05-06 (1 週間以内推奨)

Round 4 (メール配信) と Phase 6 KPI 改善のために**オーナーにしか実行できない作業**を 1 ページにまとめたもの。Claude が代行不可な項目だけ。並行作業可。

---

## ⏱ 30 分で全部終わる想定。順序自由。

| # | 項目 | 所要 | 締切 | 状態 |
|---|---|---|---|---|
| A | LINE Developers Console で email scope 申請 | 10 分 + 審査 1〜2 営業日 | 早い方が良い | ☐ |
| B | Resend アカウント開設 + naturism ドメイン追加 | 10 分 + DNS 反映 24h | A の後でも可 | ☐ |
| C | 送信ドメイン (subdomain or root) を決定 | 5 分 | B の前 | ☐ |
| D | CRM PLUS との重複配信ポリシー決定 | 5 分 | 実配信開始前 | ☐ |
| E | Phase 6 PR-0 (users.email backfill) を本番反映してよいか確認 | 1 分 | 即 | ☐ |

---

## A. LINE Developers Console で email scope 申請

**なぜ必要**: 現状 LIFF login で email を取得していない (Console 側が email scope 未承認)。Phase 6 PR-2 (再購入リマインダー自動 enroll) も Round 4 (メール配信) もこれが前提。

**手順**:
1. https://developers.line.biz/console/ にログイン
2. naturism のチャネルを選択 → **LINE Login** タブ → 「**OpenID Connect**」セクション
3. 「**Email permission**」の「**Apply**」ボタンをクリック
4. 申請フォーム入力:
   - **Subject of email request**: `お客様の Shopify 注文情報と LINE 友だちを紐付けるため` (= 後述コピペ可)
   - **How email is used**: `(1) 既存 Shopify 顧客と LINE 友だちのマッチング (2) 配送通知や再購入リマインダーの本人確認 (3) LINE がブロックされた場合の連絡手段の確保` (= 後述コピペ可)
   - **Screenshots required**: LIFF 画面で「メール許可します」のような同意 UI のスクリーンショット 1〜3 枚
5. 「**Submit**」 — LINE の審査 1〜2 営業日

**スクリーンショットが取れない場合**: テスト LIFF (`https://liff.line.me/{LIFF_ID}`) で実機ブラウザを LINE で開き、`liff.login()` 後に表示される "メールアドレス" の許可ダイアログをスクショ撮影。

### A の申請文 コピペテンプレ (日本語)

> **Subject** (件名): お客様の Shopify 注文情報と LINE 友だちを紐付けるため
>
> **Description** (用途): naturism オンラインショップで購入されたお客様について、Shopify 側に登録されているメールアドレスと LINE 友だちを照合します。これにより以下が可能になります:
>
> 1. **配送通知の本人確認**: LINE 友だちと Shopify 顧客が同一人物であることを確認した上で、配送状況を LINE で送信
> 2. **再購入リマインダー**: 過去注文した商品の再購入タイミングをお知らせ (オプトイン制)
> 3. **連絡手段の冗長化**: LINE のブロック等で配信不能になった場合に、メールでお届けする代替手段を確保
>
> 取得したメールアドレスは、利用規約・プライバシーポリシーに明記の上、上記目的にのみ使用します。第三者提供は行いません。

### A の英語版 (LINE 審査が英語要求の場合)

> **Subject**: To match Shopify customers with LINE friends for transactional notifications
>
> **Description**: We will match the email address registered in our Shopify store with LINE friend accounts to enable: (1) shipment notifications with verified identity, (2) opt-in reorder reminders for past purchases, and (3) email fallback when LINE delivery becomes unavailable. Email addresses are used solely for these purposes as stated in our terms of service and privacy policy.

---

## B. Resend アカウント開設 + ドメイン追加

**なぜ必要**: Round 4 のメール送信プロバイダ。月 3,000 通まで永久無料。

**手順**:
1. https://resend.com/signup でアカウント作成 (Google sign-in 推奨、5 秒)
2. ダッシュボード → **Domains** → 「**Add Domain**」
3. ドメイン入力: 項目 C で決めた値 (例: `mail.naturism.example`)
4. Resend が表示する 3 つの DNS レコードを Cloudflare DNS に追加:
   - **SPF**: `v=spf1 include:_spf.resend.com ~all` (TXT)
   - **DKIM**: `resend._domainkey` (CNAME or TXT、Resend の指示に従う)
   - **DMARC**: `v=DMARC1; p=none; rua=mailto:dmarc@naturism.example` (TXT、`p=none` でスタート)
5. ダッシュボードで「Verify」 — 5〜30 分で反映
6. **API Key 生成**: Settings → API Keys → 「Create API Key」(scope: 全許可)
7. **Webhook 登録**: Settings → Webhooks → 「Add Endpoint」
   - URL: `https://naturism-line-crm.katsu-7d5.workers.dev/api/integrations/resend/webhook` (PR-4 完了後に有効化)
   - イベント: `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`
8. **API Key と Webhook Secret を Claude に渡す**: 安全な方法 (1Password / Bitwarden / 直接 wrangler secret put)

→ Claude が後で `RESEND_API_KEY` と `RESEND_WEBHOOK_SECRET` を `wrangler secret put` で設定する。

---

## C. 送信ドメインを決定

**選択肢**:

| | A. Subdomain (推奨) | B. ルートドメイン |
|---|---|---|
| 例 | `mail.naturism.example` | `naturism.example` |
| メリット | 既存ドメインの送信評価に影響しない / 段階的に温められる | DNS 設定 1 箇所 |
| デメリット | DNS レコード少し増える | 配信失敗時に既存ドメインの評価も巻き込み |
| 推奨度 | **◎** (デファクト) | △ |

**Claude のおすすめ**: `mail.naturism.example` (subdomain 方式)。Resend の公式推奨もこれ。

### From / Reply-To のデフォルト案 (Claude 提案)

- **From**: `noreply@mail.naturism.example` (返信不要メッセージ用)
- **Reply-To**: `support@naturism.example` (もし問い合わせ先メアドがあれば — 無ければ Reply-To 省略)

→ オーナー: subdomain (推奨) または root のどちらかに ☐ チェック、From/Reply-To に指定があれば追記。

---

## D. CRM PLUS on LINE との重複配信ポリシー

**現状確認**: naturism は CRM PLUS on LINE を使っている? 使っているなら何の機能を?

| 選択肢 | 内容 |
|---|---|
| **D-1** | CRM PLUS は **未使用 or 解約予定** → メールは LINE Harness で全て一元化 |
| **D-2** | CRM PLUS の **メール配信機能のみ使用中** → LINE Harness の Round 4 完成と同時に CRM PLUS 側を OFF |
| **D-3** | CRM PLUS と **並列稼働** (例: マーケ系は CRM PLUS、トランザクショナル系は LINE Harness) → ドメイン分けて運用 |

**Claude のおすすめ**: D-1 (未使用) なら何もしなくて OK。D-2 が一番多いケース。D-3 は管理コスト高くて非推奨。

→ オーナー: 1 つに ☐ チェック。

---

## E. Phase 6 PR-0 (users.email backfill) の本番反映

Phase 6 KPI レポート §4 P0 #1 の対応として、Claude が今セッションで実装済み (commit 未):
- Shopify webhook (orders/create / customers/create) 経由で friend マッチング成功時、`users.email` または `users.phone` が NULL なら Shopify 値で back-fill
- 副作用: 既存ユーザーのレコードに対する書き込みが発生 (本番 D1 の users テーブルに UPDATE)

**リスク評価**:
- 影響: NULL のフィールドに値を埋めるだけ。既存値は上書きしない (`WHERE email IS NULL OR email = ''`)
- スコープ: Shopify 注文 / 顧客 webhook の処理パス内のみ
- ロールバック: `git revert` 後 wrangler deploy で元に戻る (back-fill 済データは戻らないが、データとして正しい値が入っただけなので無害)

→ オーナー: ☐ **承認** (Claude が deploy)

---

## 確認方法

各項目完了したら Claude にチャットで「A 完了」「B の API Key と Webhook Secret 渡す」等と報告すれば、Claude が次の Round 4 PR を着手できる。

A〜C 完了 → Round 4 PR-1, PR-2 着手可能
A〜E 完了 + DNS 反映 24h → PR-1〜PR-7 全並列実行可能 (3 日で実装完了)
