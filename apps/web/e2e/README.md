# Web E2E Tests (Playwright)

## セットアップ (初回のみ)

```bash
cd apps/web
pnpm install
pnpm test:e2e:install   # Chromium ブラウザバイナリを取得
```

## 実行

```bash
# ヘッドレスでフル実行 (next dev も自動起動)
pnpm test:e2e

# UI モード (デバッグ用)
pnpm test:e2e:ui

# 既に dev サーバーが立ち上がっている時 (3001番)
E2E_BASE_URL=http://localhost:3001 pnpm test:e2e

# 別 URL を狙う (本番 staging など)
E2E_BASE_URL=https://staging.example.com pnpm test:e2e
```

## 現在のカバレッジ (smoke baseline)

- **login.spec.ts**: ログイン画面の基本要素表示・空入力時のボタン無効化
- **auth-guard.spec.ts**: 未ログイン時に主要ページから /login へリダイレクトされること

## 拡張時の注意

- 認証が必要な E2E は `localStorage.setItem('lh_api_key', '...')` を `page.addInitScript()` で
  注入する形が現実的。専用テスト用 API_KEY を発行してから書く。
- 実 LINE/Stripe 等の外部 API は `page.route()` でモックする。
- フレーキー対策: `expect(...).toBeVisible()` を使い、`waitForTimeout()` は禁止。
- スクリーンショット/動画は失敗時のみ自動保存 (`playwright-report/`)。
