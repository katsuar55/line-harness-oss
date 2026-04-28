# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- brain_notebook_id: bb76696f-4e1f-47c7-b328-801d3c55aa37 -->

## プロジェクト概要

LINE Harness OSS — LINE公式アカウントの完全オープンソース CRM/マーケティング自動化ツール。
Cloudflare Workers + D1 上で動作し、無料枠で5,000友だちまで運用可能。

現在のデプロイ対象: **naturism**（インナーケアサプリブランド、株式会社ケンコーエクスプレス）
- ブランド名は必ず小文字 "naturism"（"Naturism" は誤り）
- 将来的に第2アカウント「健康エクスプレス」も追加予定

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| API / Webhook | Cloudflare Workers + Hono |
| データベース | Cloudflare D1 (SQLite) — 42テーブル |
| AI | Cloudflare Workers AI (Qwen3-30B-A3B) |
| 管理画面 | Next.js 15 (App Router) + Tailwind CSS 4 + React 19 |
| LINE SDK | カスタム型付きSDK (`packages/line-sdk/`) |
| SDK | TypeScript SDK (`packages/sdk/`, 41テスト) |
| 定期実行 | Workers Cron Triggers (5分毎) |
| パッケージマネージャー | **pnpm 9.15.4**（npm/yarn 使用禁止） |

## 開発コマンド

```bash
pnpm install              # 依存関係インストール
pnpm dev:worker           # Worker ローカル開発 → http://localhost:8787
pnpm dev:web              # 管理画面ローカル開発 → http://localhost:3001
pnpm build                # 全パッケージビルド
pnpm deploy:worker        # Worker デプロイ (vite build && wrangler deploy)
pnpm db:migrate           # D1 スキーマ適用（リモート）
pnpm db:migrate:local     # D1 スキーマ適用（ローカル）

# Worker 単体操作
cd apps/worker
pnpm typecheck            # TypeScript 型チェック
pnpm dev                  # vite dev
pnpm deploy               # vite build && wrangler deploy

# SDK テスト
cd packages/sdk
pnpm test                 # 41テスト実行
```

## モノレポ構成

pnpm ワークスペース (`pnpm-workspace.yaml`: `apps/*`, `packages/*`)

### apps/
- **`worker/`** — Cloudflare Workers API + Webhook (Hono)。25+ ルートファイル、100+ エンドポイント
- **`web/`** — Next.js 15 管理画面

### packages/
- **`db/`** — D1 スキーマ (`schema.sql`) + 12マイグレーション + 全クエリ関数。workspace名 `@line-crm/db`
- **`line-sdk/`** — LINE Messaging API 型付きラッパー。workspace名 `@line-crm/line-sdk`
- **`shared/`** — 共有型定義。workspace名 `@line-crm/shared`
- **`sdk/`** — 外部クライアント向け TypeScript SDK (ESM + CJS)
- **`mcp-server/`** — MCP サーバー（Claude Code 連携用）
- **`create-line-harness/`** — セットアップ CLI
- **`plugin-template/`** — プラグインテンプレート

## アーキテクチャ

```
LINE Platform ──→ CF Workers (Hono) ──→ D1 (42テーブル)
                       ↑                     ↑
                 Cron (5分毎)           Workers AI
                       ↓
                LINE Messaging API

Next.js 15 (管理画面) ──→ Workers API ──→ D1
```

### Worker リクエストフロー
1. `/webhook` — LINE署名検証 → `waitUntil()` で非同期イベント処理（LINE の1秒応答制限対応）
2. `/api/*` — `authMiddleware` (API_KEY ベアラー認証) → CRUD 操作
3. Cron — ステップ配信・予約ブロードキャスト・リマインダー・BAN監視・トークンリフレッシュ

### マルチアカウント
`line_accounts` テーブルで複数LINEアカウントを管理。Webhook受信時に `destination` フィールドと署名検証で自動ルーティング。

### イベントバス
`fireEvent()` (`apps/worker/src/services/event-bus.ts`) が全自動化の起点。
イベント種別: `friend_add`, `message_received` 等 → `automations` テーブルの条件に基づきアクション実行。

### AI 自動応答（3層ハイブリッド）
```
メッセージ受信
  → [Layer 1] auto_replies テーブルでキーワードマッチ → テンプレート返信
  → [Layer 2] Workers AI (Qwen3-30B-A3B) で自然言語応答
  → [Layer 3] フォールバック定型メッセージ
```

## Env バインディング (Worker)

```typescript
DB: D1Database                    // Cloudflare D1
IMAGES: R2Bucket                  // 画像ストレージ
AI: Ai                            // Workers AI (naturism用に追加)
LINE_CHANNEL_SECRET: string       // wrangler secret
LINE_CHANNEL_ACCESS_TOKEN: string // wrangler secret
API_KEY: string                   // 管理画面認証用 wrangler secret
LINE_LOGIN_CHANNEL_ID: string     // UUID 自動取得用
LINE_LOGIN_CHANNEL_SECRET: string
LIFF_URL: string
WORKER_URL: string
```

## デプロイルール (案 A: 全権限委譲, 改訂 2026-04-28)

- Claude Code は本リポジトリの全コマンドを自律実行してよい (deploy / d1 / secret 含む)
- 実行前に必ず `pnpm preflight` で All green を確認すること
- ただし以下は**必ず実行前にチャットで報告し承認を待つ** (不可逆操作・実費・公開影響):
  - 本番 D1 データの破壊的変更 (`DROP TABLE` / `DELETE FROM ... WHERE` を伴う migration)
  - `wrangler d1 create` (新 DB 作成)
  - 実費が発生する Cloudflare プラン変更 (Workers Paid / R2 課金 / Workers AI 有料モデル切替 等)
  - 公開済み LINE Official Account への broadcast (1万件以上)
  - 公開チャンネルの Webhook URL 変更
- `pnpm --filter worker deploy` (vite build && wrangler deploy) は事前承認なしで実行可
  - 完了後に必ず本番 HTML の bundle ID + LIFF ID 埋め込みを `curl` で検証してチャットに報告
  - preflight CRITICAL がある状態で deploy しないこと (deploy 自動ブロック)
- シークレットは `wrangler secret put` でのみ設定。コード・ログ・CLAUDE.md に含めない
  - secret 値そのもののチャットへのエコーバックも禁止 (PII / 認証情報の漏洩防止)
- 薬機法に抵触する表現（効能効果の断定）をAIプロンプトに含めない

**事故時のロールバック手順** (2026-04-28 「読み込み中...」固着事故の教訓):
- 直近 deploy で本番が壊れたら即 `wrangler rollback` または前 commit を checkout して再 deploy
- 復旧 deploy 後、必ず `curl -s https://<worker-url>/ | grep "src=\"/assets/"` で
  bundle ID が変わったことを確認 (Cloudflare CDN キャッシュは数十秒で剥がれる)

## 現在のフェーズ

**Phase 1: 基盤構築** — Worker + D1 + Webhook + AI自動応答 + 管理画面

## シェル運用ルール (絶対遵守 — 再発防止)

過去 2 セッションで「実行中シェルが残り続け、6 時間以上ハング」事故が発生。Celeron 8GB の低スペック環境では致命的。以下を厳守する。

### 禁止パターン

| パターン | 理由 |
|---|---|
| `until …; do sleep N; done` で別 bash の完了を待つ | run_in_background 通知が届くため不要。output ファイルが空のままだと永久ループする |
| `tail -f file` (`-F` 含む) | 自然終了しない |
| `watch …` / `while true; do …; done` | 同上 |
| `sleep N && command` を 60 秒以上 | 進捗が見えず、キャンセル困難 |
| `pnpm dev` / `npm start` 等の常駐サーバーを Bash で起動したまま | プロセスが残り続ける。dev サーバーが必要なら preview_start か Playwright `webServer` 設定を使う |
| `& disown` 等の手動デーモン化 | 制御不能になる |

### 推奨パターン

| やりたいこと | 正しい方法 |
|---|---|
| background bash の完了を待つ | **何もしない**。`run_in_background: true` の通知を受信するまで他作業を進めるか、ScheduleWakeup で再開 |
| 完了後にログを見る | 通知到着後、`Read` ツールまたは `tail -n 100 file` を **1 回だけ** |
| 進捗を能動的に見たい | `Monitor` ツール (selective grep + 自然終了する command) を使う |
| dev サーバーで動作確認 | preview_start (1 つだけ) または Playwright `webServer` (テスト終了時に自動停止) |
| 「ビルド成功か?」だけ知りたい | exit code を返す one-shot コマンド (`npm run build && echo OK`) を `run_in_background: true` で投げ、通知を待つ |

### 自己点検チェックリスト (Bash 実行前)

- [ ] このコマンドは **何秒以内に確実に終わる** か?
- [ ] 終了条件は **プロセス自体の exit** か (output 文字列マッチではなく)?
- [ ] 既に同じ目的の background bash が走っていないか?
- [ ] 別 background の完了を待つ目的なら、それは **不要** ではないか (通知が来る)?

1 つでも怪しければコマンドを変更するか、ユーザーに方針確認する。

### Bash 実行時の自己宣言 (必須)

すべての Bash ツール呼び出し時、コマンド前にコメントで予想実行時間を宣言する:

```bash
# expected: <30s | 30s-2min | 2min-10min | >10min(needs-confirmation)
```

`>10min` を選ぶ場合は実行前にユーザー承認を取る。

### ユーザー側監視

- 2 分以上「実行中」が残るタスクがあれば、ユーザーは即「タスクパネルの状態を分析して」と質問する
- Claude Code は自分の実行中タスクを `Get-CimInstance Win32_Process` 等で確認して報告
- 該当 bash の生存状況に応じて `TaskStop` または継続判断

### 違反時の必須アクション

新パターンでハングした場合、本ファイルの「禁止パターン」表に該当パターンを追記してから次の作業に移る。
追記なき再発は同じ穴を踏み続けるため、必ずルール側にフィードバックする。
