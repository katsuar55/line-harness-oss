# Disaster Recovery Runbook

> **このドキュメントは本番DB全損・Worker消失など、障害発生時の復旧手順を定義する。**
> 目標復旧時間 (RTO): **30分以内**
> 目標復旧時点 (RPO): **24時間以内** (毎日 03:00 JST のバックアップから復旧)

---

## 1. 障害シナリオと対応

| シナリオ | 復旧手順 |
|---|---|
| **Worker デプロイ失敗で本番が壊れた** | §3 Worker ロールバック |
| **D1 のテーブルが消えた / データが飛んだ** | §4 D1 復元 |
| **R2 バケットが消えた** | §5 R2 復元 |
| **Cloudflare アカウント全損** | §6 フル再構築 |
| **LINE アクセストークン漏洩** | §7 トークンローテーション |

---

## 2. 前提: 必要な情報

| 項目 | 参照先 |
|---|---|
| GitHub repo | `https://github.com/katsuar55/line-harness-oss` |
| Cloudflare Account ID | `7d5372d95437094beb5c91f4015402e1` |
| Worker 名 | `naturism-line-crm` |
| D1 database 名 | `naturism-line-crm` |
| D1 database ID | `f736c7fa-1c19-4279-b03d-3af3a71b7fca` |
| R2 bucket (画像・公開配信あり) | `naturism-line-crm-images` |
| R2 bucket (バックアップ・**非公開/Worker binding なし**) | `naturism-line-crm-backups` |
| バックアップ保存先 | `naturism-line-crm-backups/YYYY-MM-DD/naturism-d1-backup-YYYY-MM-DD.sql` |
| ローカルバックアップ | `C:\dev\line-harness-oss\backups\naturism-d1-backup-*.sql` |

---

## 3. Worker ロールバック (過去バージョンへ戻す)

### 手順

1. Cloudflare ダッシュボード → Workers & Pages → `naturism-line-crm` → Deployments タブ
2. 履歴から戻したいバージョンを選択 → **Rollback**

または PowerShell から:

```powershell
cd C:\dev\line-harness-oss\apps\worker
npx wrangler deployments list
# 一覧から Version ID をコピー
npx wrangler rollback <version-id>
```

### 確認

```powershell
# 応答確認
curl -s "https://naturism-line-crm.katsu-7d5.workers.dev/api/health"
# デプロイ履歴
npx wrangler deployments list | head -3
```

---

## 4. D1 復元 (バックアップからの完全復旧)

### 手順 A: ローカルバックアップから — 🚨 **最後の手段。現状ほぼ使えない**

前日の R2 バックアップが使えない場合の代替。ただし **2026-08-17 実測で以下が判明している**:

| | テーブル数 |
|---|---|
| ローカル退避の最新 `backups/naturism-d1-backup-2026-05-16.sql` | **106** |
| 本番 | **135** |

= **29 テーブル欠落**。2026-05 以降に追加されたロイヤリティ / 定期便 (`subscription_contracts`)
/ 受理台帳 (`sub_intents`) / クーポン各台帳が丸ごと入っていない。これで復元すると
**それらの機能が消えたうえ、顧客の受理済み依頼も失われる**。

→ 実質の復旧経路は **手順 B (R2) 一択**。手順 A を使うのは「R2 も失った」場合に限り、
その場合も復元後に migration を再適用して欠落テーブルを作り直すこと。
ローカル退避を復旧経路として維持するなら、新鮮なダンプを取り直す運用が要る (未整備)。

```powershell
cd C:\dev\line-harness-oss\apps\worker

# 1. 既存テーブル全削除 (慎重に実行。別DBでテストしてからが安全)
# wrangler d1 execute naturism-line-crm --remote --command="SELECT 'DROP TABLE IF EXISTS ' || name || ';' FROM sqlite_master WHERE type='table'"
# → 出力を別ファイルに保存し --file= で実行する

# 2. バックアップ SQL を本番に流し込む
npx wrangler d1 execute naturism-line-crm --remote --file=../../backups/naturism-d1-backup-YYYY-MM-DD.sql

# 3. 確認
npx wrangler d1 execute naturism-line-crm --remote --command="SELECT COUNT(*) FROM friends"
```

### 手順 B: R2 バックアップから

```powershell
cd C:\dev\line-harness-oss\apps\worker

# 1. R2 から日付指定でダウンロード (例: 2026-04-24)
$DATE = "2026-04-24"
npx wrangler r2 object get naturism-line-crm-backups/$DATE/naturism-d1-backup-$DATE.sql --file=restore.sql --remote

# ※ 2026-08-17 より前のバックアップは旧バケットにある (30 日 retention で順次消滅):
#    npx wrangler r2 object get naturism-line-crm-images/backups/$DATE/naturism-d1-backup-$DATE.sql --file=restore.sql --remote

# 2. 内容サニティチェック
Get-Content restore.sql -Head 5
# 先頭に `PRAGMA defer_foreign_keys=TRUE;` があれば正常

# 3. 復元実行
npx wrangler d1 execute naturism-line-crm --remote --file=restore.sql
```

### 手順 C: スキーマだけ再構築 (データ不要の場合)

```powershell
cd C:\dev\line-harness-oss\apps\worker
npx wrangler d1 execute naturism-line-crm --remote --file=../../packages/db/schema.sql
```

**注意**: schema.sql は `pnpm regenerate-schema` で migrations から自動生成されている単一ファイルスキーマ。95 テーブル + 99 インデックスを含む。

### 動作検証

復旧後は必ず以下を確認:

```powershell
# 1. テーブル数が 95 あること
npx wrangler d1 execute naturism-line-crm --remote --command="SELECT COUNT(*) FROM sqlite_master WHERE type='table'"

# 2. 友だち数
npx wrangler d1 execute naturism-line-crm --remote --command="SELECT COUNT(*) FROM friends"

# 3. 管理画面 https://naturism-admin.pages.dev で友だち一覧が見える
```

---

## 5. R2 復元

R2 バケット自体が消えた場合:

```powershell
cd C:\dev\line-harness-oss\apps\worker
# 1. バケット再作成 (画像用 = Worker が binding 経由で読む)
npx wrangler r2 bucket create naturism-line-crm-images

# 1b. バックアップ用バケット (Worker binding は張らない。retention も再設定)
npx wrangler r2 bucket create naturism-line-crm-backups --location apac
npx wrangler r2 bucket lifecycle add naturism-line-crm-backups backup-30day-retention --expire-days 30 --force

# 2. wrangler.toml の binding 確認 → 変更不要 (バケット名は同じ)

# 3. Worker 再デプロイ (binding の再バインドのため)
npx vite build; npx wrangler deploy
```

**注意**: リッチメニュー画像など R2 上のアセットは失われる。LINE Platform 側のリッチメニュー画像は残っているが、管理画面プレビュー用のキャッシュは失われる。LINE Platform からは `api-data.line.me/v2/bot/richmenu/{id}/content` で再取得可能。

---

## 6. Cloudflare アカウント全損 (最悪ケース)

### 準備するもの
- GitHub repo (コードは無傷)
- 最新の D1 バックアップ (ローカル or 別クラウド退避分)
- LINE Channel Access Token / Secret (LINE Developers Console で再取得可)
- Stripe Webhook Secret (再生成必要)
- Shopify OAuth (再認証必要)

### 手順

1. 新しい Cloudflare アカウント作成 / 既存アカウント権限復旧
2. 新 D1 database 作成:
   ```powershell
   npx wrangler d1 create naturism-line-crm
   # 出力された database_id を apps/worker/wrangler.toml に反映
   ```
3. 新 R2 バケット作成:
   ```powershell
   npx wrangler r2 bucket create naturism-line-crm-images
   ```
4. スキーマ適用 + バックアップ復元:
   ```powershell
   cd apps/worker
   npx wrangler d1 execute naturism-line-crm --remote --file=../../packages/db/schema.sql
   npx wrangler d1 execute naturism-line-crm --remote --file=../../backups/naturism-d1-backup-最新.sql
   ```
5. Secrets 再登録 (14個):
   ```powershell
   # 参考: backups/sessions/SESSION_HANDOFF_v27.md §3 の secret 一覧
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   npx wrangler secret put LINE_CHANNEL_SECRET
   npx wrangler secret put LINE_LOGIN_CHANNEL_ID
   npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET
   npx wrangler secret put API_KEY
   npx wrangler secret put AI_SYSTEM_PROMPT
   npx wrangler secret put LIFF_URL
   npx wrangler secret put WORKER_URL
   npx wrangler secret put SHOPIFY_CLIENT_ID
   npx wrangler secret put SHOPIFY_CLIENT_SECRET
   npx wrangler secret put SHOPIFY_STORE_DOMAIN
   npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
   npx wrangler secret put SHOPIFY_LINE_NOTIFY_ENABLED
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```
6. Worker デプロイ:
   ```powershell
   npx vite build; npx wrangler deploy
   ```
7. LINE Developers Console で Webhook URL を新 Worker URL に更新
8. Stripe ダッシュボードで Webhook エンドポイントを新 URL に更新 + シークレット再生成

---

## 7. LINE アクセストークン漏洩時の緊急対応

1. LINE Developers Console → 該当チャネル → Messaging API → `チャネルアクセストークン（長期）` を **再発行**
2. 旧トークンは自動失効 (数秒〜数分)
3. 新トークンを wrangler に登録:
   ```powershell
   cd apps/worker
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   ```
4. 動作確認: `curl` で `/api/health` に疎通
5. 漏洩経路調査 (Git history / logs / issue)

同様の手順を `API_KEY` / `SHOPIFY_*` / `STRIPE_WEBHOOK_SECRET` にも適用可能。

---

## 8. 定期訓練 (推奨)

- **月次**: 最新バックアップをローカル sqlite にロードし、件数が妥当か検証 (小スクリプトで自動化可)
- **半年**: 開発用 D1 に復元訓練を実施し、実際のリストアタイムを計測。30分 RTO を維持できているか確認
- **年次**: Cloudflare アカウント全損シナリオの机上演習

---

## 9. バックアップ保持ポリシー

| ストレージ | 保持期間 | 用途 |
|---|---|---|
| R2 `naturism-line-crm-backups/` | 30日 (lifecycle `backup-30day-retention` 設定済) | 日次復旧用 |
| R2 `naturism-line-crm-images/backups/` (**旧・2026-08-17 で使用終了**) | 30日 (設定済) | 2026-09-14 頃までに自然消滅 |
| ローカル `backups/*.sql` | 無期限 | ⚠️ **最新 2026-05-16 / 106 テーブル (本番 135)。復旧経路として数えないこと** — §4 手順 A 参照 |

🚨 **バックアップを画像バケットへ戻さないこと。** 2026-08-16 に、画像を配信する公開ルート
`GET /images/:key` が同じバインディングを引いていたため、顧客 PII を含む D1 全体が
無認証でダウンロード可能だった (本番実測)。詳細は CLAUDE.md「公開ルート × オブジェクト
ストレージのルール」。バックアップ用バケットには **Worker binding を張っていない** —
binding が無ければ到達しうるコード経路が存在しない、というのが分離の要です。

---

## 10. 連絡先 / エスカレーション

| 役割 | 連絡先 |
|---|---|
| オーナー | Katsu (katsu@kenkoex.com) |
| Cloudflare サポート | [dash.cloudflare.com/support](https://dash.cloudflare.com/support) |
| LINE 開発者サポート | [developers.line.biz](https://developers.line.biz/ja/) |

---

**Last updated: 2026-08-17 (v2)** — バックアップを専用非公開バケット
`naturism-line-crm-backups` へ分離 / 手順のパスを `C:\dev\line-harness-oss` へ修正
(旧 `Desktop\...` は存在せず、復旧手順の 1 行目で失敗する状態だった) /
ローカル退避が本番と 29 テーブル乖離している事実を明記
