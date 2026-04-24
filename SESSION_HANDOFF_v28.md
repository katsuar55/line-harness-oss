# Session Handoff v28 — 2026-04-24

> **このドキュメントは新セッション開始時に最初に読むこと。** v27 以降の全修正・現在状態・次アクション・既知の罠を完結に記述。

---

## 0. あなた（次セッションの Claude）の役割

LINE Harness OSS (`katsuar55/line-harness-oss`) のシニアエンジニア。
オーナー **Katsu**（非エンジニア、naturism ブランド代表、株式会社ケンコーエクスプレス）のために自律的に作業する。

### 運用ルール（必ず守る）
- **Windows / PowerShell 環境**: `&&` 不可、`;` で区切る
- **PowerShell スクリプトは ASCII only** または BOM 付き UTF-8（ja-JP locale の PS5.1 が BOMなし UTF-8 を Shift-JIS として読む罠）
- **マルチエージェント並列推奨**: Explore / code-reviewer / security-reviewer を積極的に並列実行
- **API > GUI**: GUI で不可能なら即座に API 実装を提案
- **naturism は必ず小文字**（"Naturism" は禁止）
- **薬機法**: 効能効果を断定する表現を AI プロンプト・UI コピーに含めない
- **タスク報告**: 引き継ぎリストの全項目を verify してから「完了」と報告
- **自律作業歓迎**: D1 マイグレーション・デプロイまで Claude が代行
- **GitHub Actions 経由デプロイ優先**: 手動 `wrangler deploy` よりも main push → CI → Deploy Worker の自動フローを使う

---

## 1. 今セッション (2026-04-24) で完了した主要作業

### 🚀 GitHub Actions CI/CD 完全構築
| コミット | 内容 |
|---|---|
| `f341970` | CI workflow 新設 + Deploy Worker に test gate + D1 Daily Backup + Dependabot + DR.md + plugin-template @types/node 修正 |
| `c343285` | setup-github-secrets.ps1 ASCII-only に修正 (ja-JP PS 5.1 エンコーディング問題) |
| `e0b0c00` | CI 内で @line-harness/sdk も build (plugin-template typecheck 通過のため) |
| `358245d` | dependabot.yml で vite/vitest/zod/typescript/@types/node の major bump を ignore |

### 🔐 GitHub Secrets 登録完了
- `CLOUDFLARE_ACCOUNT_ID`: 7d5372d95437094beb5c91f4015402e1
- `CLOUDFLARE_API_TOKEN`: `github-actions-deploy-and-backup` カスタムトークン
  - Account Settings: Read
  - Workers Scripts: Edit
  - D1: Edit
  - Workers R2 Storage: Edit
  - User Details: Read

### 💰 Stripe Webhook 本番設定完了
- 送信先名: `naturism-production-webhook` (アクティブ)
- URL: `https://naturism-line-crm.katsu-7d5.workers.dev/api/integrations/stripe/webhook`
- イベント: `payment_intent.succeeded` + `customer.subscription.deleted`
- `STRIPE_WEBHOOK_SECRET` を worker secrets に登録済み
- **Stripe アカウントはレビュー進行中 (2〜3日)** のため実決済テスト保留、レビュー完了後に自動動作開始

### 🗄 R2 ライフサイクル設定
- bucket `naturism-line-crm-images`
- rule `backup-30day-retention`: `backups/` prefix で 30 日後自動削除
- これにより D1 バックアップが無限に貯まらない

### 🔄 Dependabot PR 全件処理
- マージ: #1 pnpm/action-setup v6, #2 actions/checkout v6, #3 actions/setup-node v6, #4 minor-and-patch 10件まとめ, #5 @types/node v25
- Close: #6 vitest v4 (major), #7 zod v4 (major), #8 vite v8 (major) — 破壊的変更リスクのため手動レビュー待ち

---

## 2. 🚨 デプロイの正しい手順 (変更あり)

### ✅ 推奨: main push で自動デプロイ
```powershell
cd C:\Users\user\Desktop\line-harness-oss
git add <files>
git commit -m "..."
git push origin main
# → CI workflow 起動 (40秒)
# → CI 成功で Deploy Worker workflow 自動起動 (38秒)
```

### 🆘 緊急時のみ: 手動デプロイ
```powershell
cd C:\Users\user\Desktop\line-harness-oss\apps\worker
npx vite build; npx wrangler deploy
# ★ 必ず vite build してから deploy (単独 deploy は古い dist/ を上げる罠)
```

---

## 3. 現在の状態（2026-04-24 時点）

### Git
- **branch**: `main`
- **HEAD**: `92e13a51` 相当 (dependabot minor-and-patch マージ後)

### Build / Type / Tests
- Worker tests: **966/966 pass** (CI 実測)
- SDK tests: **43/43 pass** (CI 実測)
- CI 自動実行中: typecheck×6 + tests + schema drift check = 40秒で完走

### 本番デプロイ
| 項目 | 値 |
|---|---|
| Worker 最新 Version | `92e13a51-13e3-4ded-8cd8-a059698a181f` (2026-04-24 03:37) |
| Web (Pages) | `naturism-admin.pages.dev` |
| Cron | `*/5 * * * *` 稼働中 |
| Webhook URL (LINE) | `https://naturism-line-crm.katsu-7d5.workers.dev/webhook` |
| Stripe Webhook | `naturism-production-webhook` アクティブ (レビュー完了待ち) |

### D1 バックアップ
| 日付 | サイズ | 保存場所 |
|---|---|---|
| `backups/naturism-d1-backup-2026-04-23.sql` | 1.8MB | ローカル |
| `backups/naturism-d1-backup-2026-04-24.sql` | 1.8MB | ローカル + R2 `backups/2026-04-24/` |
| **以降** | 毎日自動 | R2 のみ (30日保持) |

### Worker シークレット（14個設定済）
```
AI_SYSTEM_PROMPT, API_KEY, LIFF_URL,
LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET,
LINE_LOGIN_CHANNEL_ID, LINE_LOGIN_CHANNEL_SECRET,
SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET,
SHOPIFY_LINE_NOTIFY_ENABLED, SHOPIFY_STORE_DOMAIN,
SHOPIFY_WEBHOOK_SECRET, STRIPE_WEBHOOK_SECRET, WORKER_URL
```

---

## 4. 🐛 既知の未修正・将来課題

### 🟢 優先度低
- `migrations/009_delivery_type.sql` と `009_token_expiry.sql` の番号重複（適用済なので害はない）
- AI ガード (noise/burst/daily cap) チューニング定数は webhook.ts 先頭にあり、実運用データ次第で調整可
- GitHub Actions Node.js 20 deprecation (2026-09 に強制移行) — dependabot が自動 PR する

### 将来対応 (Katsu 判断待ち)
1. **DMM チャットブースト解約**: 2026-06-01〜06-30 に申請 → 7/31 解約推奨
   - 失うもの: トーク履歴 / DMM入力プロフィール（住所・電話・誕生日）/ DMM タグ / 顧客ステータス / メモ
   - 残るもの: 友だち8,265人本体 / LINE 公式アカウント / 友だち追加 URL / リッチメニュー
   - **誕生月再収集シナリオを naturism-line-crm から配信して救出するのが推奨**
2. **重要顧客の手動救出**: DMM 管理画面からコピペで naturism-line-crm のメモ欄へ転記
3. **alias 初期セットアップ**: `naturism-default` alias 作成は将来 richmenuswitch 実装時でOK
4. **Stripe レビュー完了通知後の検証**: 実決済 webhook が届くか確認

---

## 5. プロエキスパート推奨アクション（残件）

### P1 (運用の安定性) — 未実装
1. **エラー監視・通知** (Sentry/BetterStack/Logtail): Cloudflare Workers Logs は24時間で消える → 長期保存 + Slack/LINE 通知
2. **誕生月シナリオの naturism 側再実装**: DMM 解約前に走らせる必要

### P2 (セキュリティ) — 未実装
3. **シークレットローテーション運用**: LINE_CHANNEL_ACCESS_TOKEN / API_KEY / SHOPIFY_* を半年ごとに更新

### P3 (品質) — 未実装
4. **E2E テスト** (Playwright): 主要3フロー (友だち追加→シナリオ / 購入→ランクアップ / リッチメニュー画像差替)
5. **コスト日次レポート**: Workers AI / D1 読み書き / R2 のコスト可視化

### P4 (コードヘルス)
- migrations 009 番号重複整理 (適用済なので急がない)

---

## 6. リポジトリ構成（pnpm 9.15.4 monorepo）

```
.github/
  workflows/
    ci.yml              typecheck + test + schema drift (PR/push trigger)
    deploy-worker.yml   CI 成功で自動起動
    d1-backup.yml       毎日 JST 03:00 の D1 自動エクスポート
  dependabot.yml        週次 npm + 月次 GitHub Actions
apps/
  worker/               Cloudflare Workers + Hono
    src/routes/         30+ ルート
    src/services/       Cron で回るビジネスロジック (12本)
  web/                  Next.js 15 + React 19 + Tailwind 4 (33ページ)
packages/
  db/                   @line-crm/db — D1 スキーマ + クエリ関数
    schema.sql          95テーブル (migrations から再生成可)
    scripts/regenerate-schema.mjs  (pnpm regenerate-schema)
  line-sdk/             @line-crm/line-sdk — LINE Messaging API ラッパー (alias API 含)
  shared/               @line-crm/shared
  sdk/                  @line-harness/sdk — 外部向け SDK (43 tests)
  plugin-template/      @line-harness/plugin-myservice — プラグインテンプレート
docs/
  DR.md                 ディザスタリカバリ手順書 (RTO 30分 / RPO 24h)
scripts/
  setup-github-secrets.ps1   Cloudflare API Token 登録ヘルパー
backups/
  naturism-d1-backup-YYYY-MM-DD.sql  D1 バックアップ (gitignore)
  sessions/SESSION_HANDOFF_v1〜v27.md 旧セッション記録
```

---

## 7. AI 応答アーキテクチャ（v26 から維持）

`apps/worker/src/services/ai-response.ts` + `webhook.ts`

```
メッセージ受信
  ↓
[Layer 1] auto_replies テーブルでキーワード一致 → 定型返信
  ↓ マッチしない場合
[Layer 1.5] ガード3段
  - Guard 1: ノイズフィルタ (空/1文字/記号のみ/同一文字連打)
  - Guard 2: バーストクールダウン (30s/5件)
  - Guard 3: 日次上限 (100/friend/day)
  ↓ 全ガード通過
[Layer 2] Workers AI
  - Primary: Qwen3-30B-A3B (日本語得意)
  - Fallback: Llama 3.3 70B (安定)
  ↓ 両モデル失敗
[Layer 3] 固定文「ただいま混み合っております...」
```

チューニング定数 (`apps/worker/src/routes/webhook.ts` 先頭):
```ts
const BURST_THRESHOLD = 5;
const BURST_WINDOW_SEC = 30;
const DAILY_AI_CAP = 100;
```

---

## 8. 参考リンク

| 項目 | URL |
|---|---|
| GitHub | https://github.com/katsuar55/line-harness-oss |
| Worker | https://naturism-line-crm.katsu-7d5.workers.dev |
| 管理画面 | https://naturism-admin.pages.dev |
| OpenAPI | https://naturism-line-crm.katsu-7d5.workers.dev/openapi.json |
| GitHub Actions | https://github.com/katsuar55/line-harness-oss/actions |
| DR 手順書 | `docs/DR.md` |
| Memory | `C:\Users\user\.claude\projects\C--Users-user-Desktop-line-harness-oss\memory\MEMORY.md` |
| 旧セッション | `backups/sessions/SESSION_HANDOFF_v1〜v27.md` |

---

## 9. 新セッション開始時の推奨手順

1. このファイル `SESSION_HANDOFF_v28.md` を読む
2. `git log --oneline -10` で直近コミット確認
3. GitHub Actions の直近 run 確認: `gh run list --repo katsuar55/line-harness-oss --limit 5`
4. Katsu から以下のいずれかが来る可能性:
   - Stripe レビュー完了通知 → 実決済で webhook が動作しているか確認
   - DMM 解約申請タイミングの相談 (2026-06〜07月)
   - 誕生月シナリオ再実装依頼
   - 新機能要望 / バグ報告
5. アクションが無ければ、**§5 の P1〜P3 推奨事項** を順次実装する

---

**以上、v28 ハンドオフ完了。次セッションで `git log --oneline -5` 確認から開始してください。**
