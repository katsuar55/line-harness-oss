# Secrets Rotation Runbook

> **このドキュメントは naturism-line-crm Worker (Cloudflare) に登録されている本番シークレット 14 個を、計画的に更新するための手順書。**
> 対象オーナー: Katsu (非エンジニア / Windows + PowerShell)
> 関連: [DR.md](./DR.md) §7 (漏洩時の緊急対応) / [MONITORING.md](./MONITORING.md) (Axiom ログ確認)

---

## 1. 目的

シークレット (API トークン・Webhook 署名鍵など) は時間経過で漏洩リスクが累積する:

- 過去のスクリーンショット・チャット履歴・ログから漏れる
- 退職した協力者・古い PC・古いブラウザ拡張に残り続ける
- 開発元 (LINE / Shopify / Stripe) で「漏洩懸念チャネル」と判定されると一斉失効される

定期ローテーションの目的は、たとえ漏洩していても **「漏洩した値が有効でいる時間 (= 攻撃に使われうる時間窓)」を最大半年に絞ること**。
ローテーションそのものに不具合検出効果はないが、漏洩時の被害上限を押さえる保険として運用する。

---

## 2. ローテーション方針 (一覧表)

| # | Secret 名 | カテゴリ | 推奨間隔 | 取得元 |
|---|---|---|---|---|
| 1 | `LINE_CHANNEL_ACCESS_TOKEN` | auth | **6ヶ月** | LINE Developers Console > Messaging API チャネル |
| 2 | `LINE_CHANNEL_SECRET` | auth (静的) | 漏洩時のみ | LINE Developers Console > Messaging API チャネル |
| 3 | `LINE_LOGIN_CHANNEL_ID` | static | 不要 | LINE Developers Console > LINE Login チャネル |
| 4 | `LINE_LOGIN_CHANNEL_SECRET` | auth | **6ヶ月** | LINE Developers Console > LINE Login チャネル |
| 5 | `LIFF_URL` | static | 不要 (LIFF ID 変更時のみ) | LIFF Console (LINE Developers) |
| 6 | `API_KEY` | auth (自家生成) | **6ヶ月** | 自家生成 (PowerShell `[guid]::NewGuid()` 等) |
| 7 | `AI_SYSTEM_PROMPT` | config | プロンプト改修時 | 内部設定 (プレーンテキスト) |
| 8 | `SHOPIFY_CLIENT_ID` | static | 不要 (アプリ再作成時のみ) | Shopify Partner > App > API credentials |
| 9 | `SHOPIFY_CLIENT_SECRET` | auth | **6ヶ月** | Shopify Partner > App > API credentials |
| 10 | `SHOPIFY_WEBHOOK_SECRET` | auth | **6ヶ月** | Shopify Admin > Notifications > Webhooks |
| 11 | `SHOPIFY_STORE_DOMAIN` | static | 不要 (ストア移行時のみ) | Shopify Admin (例: `naturism.myshopify.com`) |
| 12 | `SHOPIFY_LINE_NOTIFY_ENABLED` | feature flag | 機能 ON/OFF 切替時のみ | 内部 (`true` / `false`) |
| 13 | `STRIPE_WEBHOOK_SECRET` | auth | **6ヶ月** | Stripe Dashboard > Developers > Webhooks > 該当エンドポイント |
| 14 | `WORKER_URL` | static | 不要 (ドメイン変更時のみ) | `https://naturism-line-crm.katsu-7d5.workers.dev` 固定 |

**カテゴリ凡例**

- **auth** — 漏洩すると不正利用される可能性のある秘密鍵・トークン。半年ごとに必ず更新
- **static** — 公開しても攻撃に直結しない識別子 (Channel ID 等)。漏洩時のみ更新
- **feature flag / config** — 動作制御用。ローテーションは不要だが棚卸し対象

---

## 3. 半年ローテーション対象 (6 個)

以下 6 個は **6ヶ月毎に必ず更新する**。これだけ覚えれば最低限のリスク管理は成立する。

1. `LINE_CHANNEL_ACCESS_TOKEN` — LINE 配信が止まる影響度最大
2. `API_KEY` — 管理画面 (Next.js) → Worker の Bearer 認証
3. `LINE_LOGIN_CHANNEL_SECRET` — LIFF ログイン用
4. `SHOPIFY_CLIENT_SECRET` — Shopify OAuth
5. `SHOPIFY_WEBHOOK_SECRET` — Shopify Webhook 署名検証
6. `STRIPE_WEBHOOK_SECRET` — Stripe Webhook 署名検証

`LINE_CHANNEL_SECRET` は **「再発行すると過去の Webhook 署名がすべて無効化され Webhook 送信が即時破綻する」** ため LINE は半年ローテを公式推奨していない。漏洩疑い時のみ §5 緊急ローテで更新する。

---

## 4. 個別ローテ手順

すべて `apps/worker` ディレクトリで実行。事前に旧値を **PowerShell の Notepad に控えておく** (§6 ロールバック時のため、保管は最大 30 日)。

### 4.1 LINE_CHANNEL_ACCESS_TOKEN

**取得**

1. [LINE Developers Console](https://developers.line.biz/console/) → 該当 Provider → 該当 Messaging API チャネル
2. 「Messaging API 設定」タブ → 「チャネルアクセストークン (長期)」
3. 「再発行」ボタンを押す → 新トークンが表示される (旧トークンは即時失効)

**Cloudflare 反映**

```powershell
cd C:\dev\line-harness-oss\apps\worker
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
# プロンプトに新トークンを貼り付け
```

**検証**

```powershell
# 自分宛にプッシュメッセージを送って届けばOK (LINE_USER_ID は LINE Developers > Channel basic settings 末尾)
$token = "新トークン"
$userId = "<自分のLINEユーザーID>"
Invoke-RestMethod -Method Post `
  -Uri "https://api.line.me/v2/bot/message/push" `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body (@{ to=$userId; messages=@(@{ type="text"; text="rotation test" }) } | ConvertTo-Json -Depth 4)
```

または管理画面から「テスト配信」を 1 件実行して LINE 側に届けば成功。

---

### 4.2 LINE_LOGIN_CHANNEL_SECRET

**取得**

1. LINE Developers Console → 該当 LINE Login チャネル
2. 「チャネル基本設定」 → 「チャネルシークレット」 → 「Issue」 (再発行)

**Cloudflare 反映**

```powershell
cd C:\dev\line-harness-oss\apps\worker
npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET
```

**検証** — LIFF ログインを試す。管理画面の友だち詳細から LIFF URL を 1 件開き、ログインが完了して Worker が UUID を取得できれば成功。失敗時は Axiom で `liff` または `userinfo` 関連のエラーログを確認。

---

### 4.3 API_KEY (自家生成)

**生成 + 反映**

```powershell
cd C:\dev\line-harness-oss\apps\worker

# 新しい値を生成 (UUID v4 を 2 個連結 = 64 文字)
$new = "$([guid]::NewGuid().Guid)$([guid]::NewGuid().Guid)" -replace '-',''
$new   # コピー先: 1) wrangler  2) 管理画面 (Cloudflare Pages) の環境変数

npx wrangler secret put API_KEY
# プロンプトに $new を貼り付け
```

**管理画面側にも同じ値を反映**

1. Cloudflare Dashboard → Pages → `naturism-admin` → Settings → Environment variables
2. `NEXT_PUBLIC_API_KEY` (または `API_KEY`) を新値に更新 → Save → Re-deploy

**検証**

```powershell
curl -H "Authorization: Bearer $new" `
  "https://naturism-line-crm.katsu-7d5.workers.dev/api/health"
# {"status":"ok"} が返れば成功
```

管理画面 (https://naturism-admin.pages.dev) の友だち一覧が表示されれば管理画面側の更新も成功。

---

### 4.4 SHOPIFY_CLIENT_SECRET

**取得**

1. [Shopify Partner Dashboard](https://partners.shopify.com/) → Apps → 該当アプリ
2. 「App setup」 (またはアプリ設定) → 「Client credentials」 → 「Rotate client secret」
3. 旧 secret は表示猶予期間 (24 時間程度) があるため、その間に Cloudflare 側を更新する

**Cloudflare 反映**

```powershell
cd C:\dev\line-harness-oss\apps\worker
npx wrangler secret put SHOPIFY_CLIENT_SECRET
```

**検証** — 管理画面の Shopify 設定ページから OAuth 連携を 1 度切断 → 再認証して接続できれば成功。

---

### 4.5 SHOPIFY_WEBHOOK_SECRET

**取得**

1. Shopify Admin → Settings → Notifications → Webhooks
2. 既存 Webhook エンドポイントの「Edit」 → 「Reveal」で現在のシークレットを確認 (Shopify は webhook 単位ではなくストア単位の signing secret を発行)
3. もしくは「Create webhook」して新エンドポイントの secret を新規発行 → 旧エンドポイント削除

**Cloudflare 反映**

```powershell
cd C:\dev\line-harness-oss\apps\worker
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
```

**検証**

- Shopify Admin → 該当 Webhook → 「Send test notification」で `orders/create` などをテスト送信
- Axiom で `Shopify HMAC verified` または `webhook` 関連の `info` ログが流れていれば成功
- 万一ログに `succeeded with CLIENT_SECRET, not WEBHOOK_SECRET` と出ている場合は webhook secret の登録漏れ。再度 `wrangler secret put` で正しい値を設定する

---

### 4.6 STRIPE_WEBHOOK_SECRET

**取得**

1. [Stripe Dashboard](https://dashboard.stripe.com/) → Developers → Webhooks
2. 該当エンドポイント (Worker URL を指している行) を選択
3. 「Signing secret」セクションで「Roll secret」 → 旧 secret に `Expires in: 24 hours` の猶予を選ぶ
4. 表示された新 `whsec_...` をコピー

**Cloudflare 反映**

```powershell
cd C:\dev\line-harness-oss\apps\worker
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

**検証**

- Stripe Dashboard → 該当 Webhook → 「Send test webhook」 → `payment_intent.succeeded` などを送信
- Worker が 200 OK を返せば成功 (Stripe Dashboard の Webhook ログ画面で確認可能)
- Axiom で `Stripe webhook` 関連エラーが出ていなければ OK

---

## 5. 緊急ローテ (漏洩疑い時)

「Slack に貼った」「git に commit した」「ログにそのまま出力した」など、漏洩疑いがある場合は **30 分以内に全 auth secret を回す**。

### 優先順位 (上から順に対処)

| 順 | Secret | 漏洩時の被害 | 対応 |
|---|---|---|---|
| 1 | `LINE_CHANNEL_ACCESS_TOKEN` | 友だち全員に任意メッセージ送信、なりすまし | §4.1 即実行 |
| 2 | `API_KEY` | 管理画面相当の全 CRUD 実行 | §4.3 即実行 |
| 3 | `STRIPE_WEBHOOK_SECRET` | 偽の決済通知でデータ汚染 | §4.6 即実行 |
| 4 | `SHOPIFY_WEBHOOK_SECRET` | 偽の注文 Webhook で在庫・配信誤動作 | §4.5 即実行 |
| 5 | `SHOPIFY_CLIENT_SECRET` | OAuth 不正取得 (再認可までの間) | §4.4 |
| 6 | `LINE_LOGIN_CHANNEL_SECRET` | LIFF ログイン経路の偽装 | §4.2 |
| 7 | `LINE_CHANNEL_SECRET` | Webhook 署名偽装 (再発行で過去全署名失効、副作用大) | LINE Console から再発行、即時 `wrangler secret put LINE_CHANNEL_SECRET` |

### ログ確認 (漏洩経路の特定)

1. Axiom にログイン → dataset `naturism-worker` → 「Stream」
2. 直近 24 時間の `error` / `warn` で「該当 secret が使われた IP / User-Agent / endpoint」を確認
3. 不審アクセスがあれば該当 IP を Cloudflare WAF で一時遮断 (Dashboard > Security > WAF > Custom rules)
4. Discord の `#error-alerts` も時系列で確認 (詳細手順は [MONITORING.md](./MONITORING.md))

### 対応完了後

- GitHub のコミット履歴 / Issue / PR から漏洩した値が見えていないか grep
- 漏洩経路 (Slack / git / log 等) を本ドキュメント末尾の「インシデント記録」に追記
- 旧値は **24 時間後に Notepad ごと完全消去** (§6 ロールバック猶予期間)

---

## 6. ロールバック (新値で本番が壊れた場合)

ローテーション後に予期せぬ不具合が出た場合、旧値に戻して原因調査の時間を確保する。

### 原則

- **新値を `wrangler secret put` する前に、必ず旧値を Notepad に控える**
- 旧値の保管期間は **最大 30 日** (それ以降は完全消去。漏洩リスクが累積するため)
- 控え場所は Katsu のローカル Windows 上のみ。クラウド・チャット・git に置かない

### 戻し手順

```powershell
cd C:\dev\line-harness-oss\apps\worker
npx wrangler secret put <SECRET_NAME>
# プロンプトに控えておいた旧値を貼り付け
```

### 不可逆なケース

- `LINE_CHANNEL_ACCESS_TOKEN` の「再発行」は旧トークンを **即時失効** させるため、Cloudflare 側を旧値に戻しても LINE 側で受け付けない。再発行してしまった場合はロールバック不可 → 新トークンで動作確認するしかない
- `STRIPE_WEBHOOK_SECRET` は Stripe Dashboard で「Roll secret」時に「旧 secret の猶予期間 (24h)」を指定した場合のみロールバック可能。猶予 0 を選ぶと旧値も即時失効
- `SHOPIFY_CLIENT_SECRET` は Shopify Partner で rotate 時に同様の猶予期間あり

---

## 7. カレンダーリマインダー

Google カレンダーに以下を 1 件登録すれば、毎回手作業で覚えておく必要はない。

```
タイトル: [naturism] Worker secrets 半年ローテーション
日時: 2026-10-27 (月) 10:00 - 11:00 JST
繰り返し: 6ヶ月ごと (同じ曜日)
リマインダー: 1日前 / 1時間前 (メール + ポップアップ)
場所: 自宅PC (Windows)
詳細:
naturism-line-crm Worker のシークレットを 6 個更新する。
所要 30〜45 分。手順: docs/SECRETS_ROTATION.md §3 / §4 を上から順に実行。

対象 (6個):
- LINE_CHANNEL_ACCESS_TOKEN  (§4.1)
- API_KEY                    (§4.3)
- LINE_LOGIN_CHANNEL_SECRET  (§4.2)
- SHOPIFY_CLIENT_SECRET      (§4.4)
- SHOPIFY_WEBHOOK_SECRET     (§4.5)
- STRIPE_WEBHOOK_SECRET      (§4.6)

事前準備:
- C:\dev\line-harness-oss を最新化 (git pull)
- 旧値控え用に Notepad を起動

完了後:
- 本ドキュメント §8 の「次回ローテ予定日」表を 6ヶ月後に更新
- 旧値メモは 30 日後に消去
```

---

## 8. 次回ローテ予定日

起点: 2026-04-27 → 半年後 2026-10-27 を初期値。実施したら都度更新する。

| # | Secret | 最終ローテ | 次回予定 | 備考 |
|---|---|---|---|---|
| 1 | `LINE_CHANNEL_ACCESS_TOKEN` | (初期登録) | **2026-10-27** | 半年毎 |
| 2 | `LINE_CHANNEL_SECRET` | (初期登録) | 漏洩時のみ | 再発行で署名失効するため定期ローテ非推奨 |
| 3 | `LINE_LOGIN_CHANNEL_ID` | (初期登録) | — | 静的識別子 |
| 4 | `LINE_LOGIN_CHANNEL_SECRET` | (初期登録) | **2026-10-27** | 半年毎 |
| 5 | `LIFF_URL` | (初期登録) | — | LIFF ID 変更時のみ |
| 6 | `API_KEY` | (初期登録) | **2026-10-27** | 半年毎、管理画面側も同時更新 |
| 7 | `AI_SYSTEM_PROMPT` | (初期登録) | — | プロンプト改修時 |
| 8 | `SHOPIFY_CLIENT_ID` | (初期登録) | — | 静的識別子 |
| 9 | `SHOPIFY_CLIENT_SECRET` | (初期登録) | **2026-10-27** | 半年毎 |
| 10 | `SHOPIFY_WEBHOOK_SECRET` | (初期登録) | **2026-10-27** | 半年毎 |
| 11 | `SHOPIFY_STORE_DOMAIN` | (初期登録) | — | ストア移行時のみ |
| 12 | `SHOPIFY_LINE_NOTIFY_ENABLED` | (初期登録) | — | feature flag |
| 13 | `STRIPE_WEBHOOK_SECRET` | (初期登録) | **2026-10-27** | 半年毎 |
| 14 | `WORKER_URL` | (初期登録) | — | 静的 URL |

---

## 9. インシデント記録 (漏洩 / 異常時の追記欄)

| 日付 | 対象 secret | 経路 / 原因 | 対応 |
|---|---|---|---|
| — | — | (未発生) | — |

---

**Last updated: 2026-04-27 (v1)**
