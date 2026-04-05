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

## デプロイルール

- `wrangler deploy` は必ずオーナー（Katsu）の承認を得てから実行
- `wrangler d1 create` はオーナーが PowerShell で実行 → database_id を受け取る
- シークレットは `wrangler secret put` でのみ設定。コード・ログ・CLAUDE.md に含めない
- 薬機法に抵触する表現（効能効果の断定）をAIプロンプトに含めない

## 現在のフェーズ

**Phase 1: 基盤構築** — Worker + D1 + Webhook + AI自動応答 + 管理画面
