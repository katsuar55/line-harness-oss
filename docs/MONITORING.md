# 監視 & エラー通知 セットアップ (Katsu 用 開設手順)

> **目的**: Cloudflare Workers Logs は 24時間で消えるため、重大エラーを長期保存 + 即時通知する。
> **コスト**: 立ち上げ期は完全無料 (Axiom Free 500MB/月 + Discord 無料)。

このドキュメントは naturism オーナー (Katsu) が監視を有効化するための **手作業手順** です。
コード側のフックはすでに実装済 (`apps/worker/src/services/logger.ts`)、secret を登録した瞬間から動き始めます。
secret 未登録時は no-op (アプリは普通に動く) なので順番に登録すればOK。

---

## ステップ 1. Discord webhook を作成 (5分)

**目的**: error/fatal レベルのログを naturism チャンネルに即時通知

1. PC または スマホで [https://discord.com/](https://discord.com/) にログイン
2. 通知用サーバーを作る (既存サーバーがあるならスキップ)
   - サイドバー左の「+」→「自分用に作成する」→ 名前 "naturism alerts"
3. チャンネル "#error-alerts" を新規作成 (鍵マーク = プライベートでOK)
4. 該当チャンネルの ⚙️設定 → 「連携サービス」 → 「ウェブフック」 → 「新しいウェブフック」
5. 名前 "naturism-worker"、 ⚠️**「ウェブフックURLをコピー」をクリックしてURL を保存**
   - 形式: `https://discord.com/api/webhooks/{ID}/{TOKEN}`
6. 動作テスト: PowerShell で
   ```powershell
   $url = "貼り付けた webhook URL"
   Invoke-RestMethod -Method Post -Uri $url -ContentType 'application/json' -Body '{"content":"naturism webhook 動作テスト"}'
   ```
   Discord チャンネルに「naturism webhook 動作テスト」と出れば成功

---

## ステップ 2. Axiom アカウント開設 (5分)

**目的**: 全ログを長期保存・SQL検索可能に

1. [https://app.axiom.co/register](https://app.axiom.co/register) にアクセス
2. GitHub アカウントでサインイン (= katsuar55) 推奨
3. Organization 名: "naturism" を入力
4. Plan は "Free" を選択 (500MB/月、保持期間 7日)
5. Dataset を作成
   - 左サイドバー「Datasets」→「New Dataset」
   - 名前: `naturism-worker` (CLAUDE.md と整合させる)
6. API Token を発行
   - 右上アバター → Settings → API Tokens → 「New Token」
   - 名前: `worker-ingest`
   - Permissions: ✅Ingest (該当 dataset のみ) を選択
   - ⚠️ **発行されたトークンをコピーして保存** (一度しか表示されない)

---

## ステップ 3. wrangler secrets に登録 (3分)

PowerShell で `apps/worker` ディレクトリに移動して以下を実行:

```powershell
cd C:\Users\user\Desktop\line-harness-oss\apps\worker

# Axiom (長期保存)
npx wrangler secret put AXIOM_TOKEN
# プロンプトに Axiom で発行したトークンを貼り付け

npx wrangler secret put AXIOM_DATASET
# "naturism-worker" を入力 (Axiom で作った dataset 名)

# Discord (即時通知, error/fatal のみ)
npx wrangler secret put DISCORD_WEBHOOK_URL
# Discord webhook URL を貼り付け
```

登録確認:
```powershell
npx wrangler secret list
```
→ `AXIOM_TOKEN`, `AXIOM_DATASET`, `DISCORD_WEBHOOK_URL` の3つが追加されていればOK。

---

## ステップ 4. 動作確認 (5分)

1. **わざとエラーを起こすテスト**: 存在しないルートを叩く
   ```powershell
   curl -X POST -H "Authorization: Bearer $env:API_KEY" `
     "https://naturism-line-crm.katsu-7d5.workers.dev/api/__force_error_for_test__"
   ```
2. Discord #error-alerts に `**[ERROR]**` で始まる通知が来れば OK
3. Axiom のダッシュボード → naturism-worker → 「Stream」で受信ログが流れていれば OK

---

## トラブルシュート

| 症状 | 原因 | 対処 |
|---|---|---|
| Discord に通知が来ない | webhook URL の貼り間違い | `wrangler secret put DISCORD_WEBHOOK_URL` で再登録 |
| Axiom にログが来ない | dataset 名 mismatch | secret `AXIOM_DATASET` と Axiom 管理画面の dataset 名を一致させる |
| Axiom Free 枠 500MB を超えた | logger.error 呼び過ぎ | logger.warn に降格 / Axiom 有料プラン (約$25/月) に検討 |
| Discord アラートが多すぎる | error 多発 | Discord 通知は error/fatal のみ。warn/info は Axiom だけに行く設計 |

---

## 月次メンテナンス

- **月初**: Axiom ダッシュボードで「使用容量」を確認 (500MB の何 % か)
- **エラー多発時**: Discord 通知から原因究明 → ヒットしたエラー種別をコード側で握りつぶすか修正
- **半年ごと**: Axiom トークン / Discord webhook URL のローテーション

---

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `apps/worker/src/services/logger.ts` | logger 実装 (Axiom + Discord クライアント) |
| `apps/worker/src/index.ts` | `app.onError` で全ルート横串フック |
| `docs/DR.md` | 障害時の復旧手順 (この監視がアラートを発する基盤) |
