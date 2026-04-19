# Session Handoff v25 — 2026-04-19

> **このドキュメントは新セッション開始時に最初に読むこと。** 前回セッションの全てのコンテキスト・現在の状態・次の作業を完結に記述している。

---

## 0. あなた（次セッションの Claude）の役割

あなたは LINE Harness OSS (`katsuar55/line-harness-oss`) のシニアエンジニア。
オーナー **Katsu**（非エンジニア、naturism ブランド代表、株式会社ケンコーエクスプレス）のために自律的に作業する。

### 運用ルール（必ず守る）
- **Windows / PowerShell 環境**: `&&` 不可、`;` で区切る。`npx wrangler` / `npx next` / `npx vite` を使う
- **マルチエージェント並列推奨**: Explore / code-reviewer / security-reviewer を積極的に並列実行
- **API > GUI**: GUI で不可能なら即座に API 実装を提案
- **naturism は必ず小文字**（"Naturism" は禁止）
- **薬機法**: 効能効果を断定する表現を AI プロンプト・UI コピーに含めない
- **タスク報告**: 引き継ぎリストの全項目を verify してから「完了」と報告
- **自律作業歓迎**: D1 マイグレーション・デプロイ・secret確認まで Claude が代行してよい

---

## 1. プロジェクト全体像（30秒で把握）

LINE Harness OSS — LINE 公式アカウントの完全 OSS 版 CRM/マーケティング自動化ツール。
Cloudflare Workers + D1 上で動作、無料枠で 5,000 友だちまで運用可能。

```
LINE Platform ──→ CF Workers (Hono) ──→ D1 (42+テーブル)
                       ↑                     ↑
                 Cron (5分毎)           Workers AI (Qwen3-30B)
                       ↓
                LINE Messaging API

Next.js 15 (管理画面) ──→ Workers API ──→ D1
LIFF (モバイル) ────────→ Workers API ──→ D1
```

### デプロイ対象
- **Worker**: `naturism-line-crm` → https://naturism-line-crm.katsu-7d5.workers.dev
- **管理画面**: Cloudflare Pages → https://naturism-admin.pages.dev
- **D1**: `naturism-line-crm` (id: `f736c7fa-1c19-4279-b03d-3af3a71b7fca`)
- **R2**: `naturism-line-crm-images`
- **GitHub**: `katsuar55/line-harness-oss` (main)

---

## 2. 現在の状態（2026-04-19 時点）

### Git
- **branch**: `main`
- **HEAD**: `e4d7506` （最新）

### Build / Type
- `apps/web` typecheck: ✅ クリーン
- `apps/worker` typecheck: ✅ クリーン
- `apps/web` next build: ✅ 成功（33ページ全て静的生成）

### 本番デプロイ
| 項目 | 状態 |
|---|---|
| Worker Version | `e9fc3ba3-8718-404b-9f9f-33d657d67dd4` |
| Web (Pages) | `bd2def5e.naturism-admin.pages.dev` + alias `naturism-admin.pages.dev` |
| Cron | `*/5 * * * *` 稼働中 |
| GitHub push | ✅ main `e4d7506` まで反映 |

### Smoke Test 結果（本番確認済）
| エンドポイント | 結果 |
|---|---|
| `GET /api/health` | ✅ 200 OK |
| `POST /webhook` (無署名) | ✅ 200 {"status":"ok"}（LINE仕様通り即ack） |
| `GET /api/friends` (認証なし) | ✅ 401 |
| `GET /api/dashboard/overview` (偽トークン) | ✅ 401 |
| `GET /openapi.json` | ✅ 200 OK |
| 管理画面 `/`, `/login`, `/dashboard`, `/reminder-messages` | ✅ 全 200 |

---

## 3. 直近セッション（2026-04-17 〜 04-19）で完了した作業

### P2: 全typecheckエラー修正 + ビルド修正
| コミット | 内容 |
|---|---|
| `6eeefee` | Header title prop 4ページ + TrendPoint型 + broadcast-form quick_reply + worker 9エラー修正 |
| `dc02fca` | `friends/[id]` → `/friend-detail?id=` に移行（static export互換） |

### ダッシュボード 500エラー修正
| コミット | 内容 |
|---|---|
| `d503da3` | health-score: `logged_at` → `log_date`、referral-funnel: `friends.referral_code` → `referral_links.ref_code` |

### セキュリティ修正（CRITICAL〜MEDIUM）
| コミット | 内容 |
|---|---|
| `0ee1008` | Stripe webhook認証バイパス修正、オープンリダイレクト防止、LIFF注文IDOR修正、lineUserIdフォールバック削除、CORS制限、webhook secret マスク |

### 本番公開前最終チェック + 修正
| コミット | 内容 |
|---|---|
| `e4d7506` | `reminder-messages/page.tsx`: localStorage key 不統一（`apiKey` vs `lh_api_key`）を `fetchApi()` 統一で解消。`abandoned-cart-notify.ts`: 無音 catch を `console.warn` に変更 |

### クリーンアップ（本セッション）
- 古い `SESSION_HANDOFF_v1〜v24.md` を `backups/sessions/` に集約
- `.gitignore` に `.claude/`, `backups/`, `*.tsbuildinfo` を追加
- D1 最新バックアップ取得: `backups/naturism-d1-backup-2026-04-17.sql` (1.66MB)

---

## 4. セキュリティ対応済み一覧

| 重要度 | 対応 | 状態 |
|--------|------|------|
| CRITICAL | Stripe webhook: secret 未設定時リジェクト | ✅ |
| HIGH | オープンリダイレクト: 許可ドメインのみ | ✅ |
| HIGH | LIFF 注文 IDOR: 認証済みユーザーのみ | ✅ |
| HIGH | lineUserId フォールバック削除 | ✅ |
| MEDIUM | CORS: 管理画面+LIFF+localhost のみ | ✅ |
| MEDIUM | Webhook secret マスク表示 | ✅ |
| LOW | console.log 整理 | 🟡 未着手（影響軽微） |
| LOW | レート制限必須化 | 🟡 未着手（現状 optional binding） |

---

## 5. 設定済みリソース（全て Claude が確認済）

### wrangler.toml（apps/worker/）
- D1 binding: `DB` → `naturism-line-crm`
- R2 binding: `IMAGES` → `naturism-line-crm-images`
- AI binding: `AI`（Workers AI）
- Cron: `*/5 * * * *`
- Rate Limiter: `WEBHOOK_RATE_LIMITER` (60req/60s), `API_RATE_LIMITER` (300req/60s)
- Static assets SPA fallback あり

### Worker シークレット（13個設定済）
```
AI_SYSTEM_PROMPT, API_KEY, LIFF_URL,
LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET,
LINE_LOGIN_CHANNEL_ID, LINE_LOGIN_CHANNEL_SECRET,
SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET,
SHOPIFY_LINE_NOTIFY_ENABLED, SHOPIFY_STORE_DOMAIN,
SHOPIFY_WEBHOOK_SECRET, WORKER_URL
```

未設定（必要時のみ設定する）:
- `STRIPE_WEBHOOK_SECRET` — 未設定時は自動 reject する実装済み（セキュリティOK）
- `LINE_CHANNEL_ID` — コード上未使用（実害なし）

### Cron ジョブ（12サービス）
`apps/worker/src/index.ts` の `scheduled()` で 5分毎に全アカウント向け実行:
- processStepDeliveries（ステップ配信）
- processScheduledBroadcasts（予約ブロードキャスト）
- processReminderDeliveries（リマインダー）
- checkAccountHealth（BAN監視）
- refreshLineAccessTokens（トークン更新）
- syncShopifyCustomers（Shopify 顧客同期）
- processAbandonedCartNotifications（かご落ち通知）
- processTagElapsedDeliveries（タグ経過日数配信）
- processScheduledAbTests（A/Bテスト）
- processIntakeReminders（問診リマインド）
- processWeeklyReports（週次レポート）
- processSubscriptionReminders（定期購読リマインド）

---

## 6. リポジトリ構成（pnpm 9.15.4 monorepo）

```
apps/
  worker/              Cloudflare Workers + Hono（30+ルート、100+エンドポイント）
    src/
      index.ts         エントリ（CORS, rate-limit, auth, routes mount, scheduled）
      routes/          30+ ルートファイル
      services/        Cron で回るビジネスロジック
      middleware/      auth, liff-auth, rate-limit
    wrangler.toml
  web/                 Next.js 15 + React 19 + Tailwind 4（33ページ）
    src/
      app/             Next.js App Router（全 static export）
      lib/api.ts       fetchApi() + API クライアント統合
      components/      共有コンポーネント
packages/
  db/                  @line-crm/db — D1 スキーマ + migrations/*.sql + クエリ関数
  line-sdk/            @line-crm/line-sdk — LINE Messaging API ラッパー
  shared/              @line-crm/shared — 共有型定義
  sdk/                 外部向け TypeScript SDK
  mcp-server/          Claude Code 連携用 MCP
  create-line-harness/ セットアップ CLI
backups/               D1バックアップ + 旧セッションハンドオフ（.gitignore済）
```

---

## 7. デプロイ手順（完全リファレンス）

### Worker
```powershell
cd C:\Users\user\Desktop\line-harness-oss\apps\worker
npx wrangler deploy
```

### Web（管理画面）
```powershell
cd C:\Users\user\Desktop\line-harness-oss\apps\web
npx next build
npx wrangler pages deploy out --project-name naturism-admin
```

### D1 マイグレーション（重要: `migrations apply` ではなく `execute --file=` を使う）
```powershell
cd C:\Users\user\Desktop\line-harness-oss\apps\worker
npx wrangler d1 execute naturism-line-crm --remote --file=../../packages/db/migrations/XXX_NAME.sql
```

### D1 バックアップ
```powershell
cd C:\Users\user\Desktop\line-harness-oss\apps\worker
npx wrangler d1 export naturism-line-crm --remote --output=../../backups/naturism-d1-backup-YYYY-MM-DD.sql
```

### Worker Secret 設定
```powershell
cd C:\Users\user\Desktop\line-harness-oss\apps\worker
npx wrangler secret put SECRET_NAME
# → プロンプトで値入力（画面に表示されない）
```

---

## 8. 次にやるべきこと（優先度順）

### 🔴 P0: Katsu に確認依頼が必要（Claude では完結不可）
1. **LINE Developers Console** で Webhook URL が以下になっているか目視確認
   - `https://naturism-line-crm.katsu-7d5.workers.dev/webhook`
2. **リッチメニュー画像** を本番デザイン版（2500x1686px）に差し替え
   - 現在は仮画像（API 経由で v3 が default 設定済み）
   - LINE OA マネージャー or リッチメニュー画像アップロード API で差し替え
3. **DMM 友だちデータ CSV インポート** が必要なら Claude に依頼（未実装）

### 🟡 P1: DMM 移行完了後に検討（メモ済）
- タグ別配信統計
- A・B テスト可視化
- シナリオ分析
- セグメントビルダー強化
- Slack 連携（DMM にはあったが未実装）

### 🟢 P2: 残り改善（影響軽微）
- `console.log` のプロダクション整理（web 側は 0件、worker 側にデバッグログ残存）
- レート制限バインディングを optional → required に
- `schema.sql` を migrations から再生成（現状ズレあり、実運用は migration 順で問題なし）

---

## 9. Katsu の作業スタイル（必読）

- **非エンジニア**: 全ての手順を一度に・どこで実行するか明示する
- **PowerShell**: `&&` 不可、`;` で区切る
- **コマンド例は必ずフルパスで**: `cd C:\Users\user\Desktop\line-harness-oss\apps\worker`
- **GUI より API を優先**: GUI 操作が不可能/面倒なら即 API 実装で対応
- **自律作業歓迎**: D1 マイグレーション・デプロイ・シークレット確認まで Claude が代行
- **全体像より具体**: 「なぜ」より「何を」「どこで」「どうやって」を重視
- **タスク完了報告**: 引継ぎの全項目を verify してから「完了」と報告

### naturism ブランド規則
- ブランド名は**必ず小文字** "naturism"（"Naturism" 禁止）
- 薬機法に抵触する効能効果表現を AI プロンプト・UIコピーに含めない
- 第2アカウント「健康エクスプレス」も将来追加予定（マルチアカウント対応済）

---

## 10. アーキテクチャ詳細

### Worker リクエストフロー
1. **`/webhook`**: LINE署名検証 → `waitUntil()` で非同期イベント処理（LINE の1秒応答制限対応）
2. **`/api/*`**: `authMiddleware`（API_KEY ベアラー認証）→ CRUD 操作
3. **`/api/liff/*`**: `liffAuthMiddleware`（LINE Login ID Token 検証）→ 認証済み friend としてアクセス
4. **Cron**: 5分毎に scheduled ハンドラ → 全12サービス `Promise.allSettled` で実行

### イベントバス（全自動化の起点）
`apps/worker/src/services/event-bus.ts` の `fireEvent()` が:
1. **Phase 1**: scoring（スコア更新）
2. **Phase 2**: automations（自動化ルール実行）+ notifications（通知）+ outgoing webhooks

イベント種別の例: `friend_add`, `message_received`, `order.completed`, `incoming_webhook.*`

### AI 自動応答（3層ハイブリッド）
```
メッセージ受信
  → [Layer 1] auto_replies テーブルでキーワードマッチ → テンプレート返信
  → [Layer 2] Workers AI (Qwen3-30B-A3B) で自然言語応答
  → [Layer 3] フォールバック定型メッセージ
```

### マルチアカウント
`line_accounts` テーブルで複数 LINE アカウントを管理。
Webhook 受信時に `destination` フィールドと署名検証で自動ルーティング。

---

## 11. 参考リンク

| 項目 | URL |
|---|---|
| GitHub | https://github.com/katsuar55/line-harness-oss |
| Worker | https://naturism-line-crm.katsu-7d5.workers.dev |
| 管理画面 | https://naturism-admin.pages.dev |
| OpenAPI | https://naturism-line-crm.katsu-7d5.workers.dev/openapi.json |
| D1 バックアップ（最新） | `backups/naturism-d1-backup-2026-04-17.sql` (1.66MB) |
| Memory (永続メモ) | `C:\Users\user\.claude\projects\C--Users-user-Desktop-line-harness-oss\memory\MEMORY.md` |
| 旧セッションハンドオフ | `backups/sessions/SESSION_HANDOFF_v1〜v24.md` |

---

## 12. 新セッション開始時にやること

1. **この `SESSION_HANDOFF_v25.md` を読む**（このファイル）
2. `git log --oneline -10` で直近コミット確認
3. `git status` で未コミット変更確認（tsconfig.tsbuildinfo 以外に無いことを確認）
4. Katsu の指示を待つ
   - 指示がなければ「P0 残タスク（LINE Webhook URL 確認、リッチメニュー画像差し替え）の進捗はいかがですか？」と聞く
   - もしくは P1/P2 に手をつけて良いか確認

### よくある作業パターン

**新機能追加**:
```
1. Explore agent で既存実装を調査
2. packages/db/migrations/XXX_feature.sql でスキーマ拡張（必要なら）
3. apps/worker/src/routes/feature.ts でルート追加
4. apps/worker/src/index.ts で mount
5. apps/web/src/app/feature/page.tsx で管理画面追加
6. apps/web/src/lib/api.ts で API クライアント追加
7. typecheck → deploy
```

**デバッグ**:
```
1. Worker ログ: npx wrangler tail（別ターミナル）
2. D1 クエリ: npx wrangler d1 execute naturism-line-crm --remote --command="SELECT ..."
3. 本番確認: curl https://naturism-line-crm.katsu-7d5.workers.dev/api/...
```

**セキュリティレビュー**: `security-reviewer` agent を並列で回す

---

## 13. 既知の軽微な問題（ブロッキングではない）

- `packages/db/schema.sql` が全 migration の合成と一致しない（migration は正しく動くので実害なし）
- `LINE_CHANNEL_ID` が Env 型で required だが実コード未使用（wrangler 側で警告出ない）
- `apps/worker` の一部 `console.log` が本番残存（機能には影響なし）

---

**以上、新セッションへの完全引継ぎ。Katsu が待機中なので、P0 確認または新たな指示を受けて作業開始してください。**
