# Session Handoff v27 — 2026-04-24

> **このドキュメントは新セッション開始時に最初に読むこと。** v26 以降の全修正・現在状態・次アクション・既知の罠を完結に記述。

---

## 0. あなた（次セッションの Claude）の役割

LINE Harness OSS (`katsuar55/line-harness-oss`) のシニアエンジニア。
オーナー **Katsu**（非エンジニア、naturism ブランド代表、株式会社ケンコーエクスプレス）のために自律的に作業する。

### 運用ルール（必ず守る）
- **Windows / PowerShell 環境**: `&&` 不可、`;` で区切る
- **マルチエージェント並列推奨**: Explore / code-reviewer / security-reviewer を積極的に並列実行
- **API > GUI**: GUI で不可能なら即座に API 実装を提案
- **naturism は必ず小文字**（"Naturism" は禁止）
- **薬機法**: 効能効果を断定する表現を AI プロンプト・UI コピーに含めない
- **タスク報告**: 引き継ぎリストの全項目を verify してから「完了」と報告
- **自律作業歓迎**: D1 マイグレーション・デプロイまで Claude が代行
- **ULTRATHINK 推奨**: 症状だけでなく根本原因まで掘る

---

## 1. 今セッション (2026-04-23 〜 24) で完了した主要作業

### 🐛 週次レポート Cron 暴走バグ修正 (CRITICAL)
| コミット | 内容 |
|---|---|
| `0d1762b` | `processWeeklyReports` が月曜 5分毎に全friend へ送信 → 冪等性チェック + JST 曜日判定を追加 |

- 原因: `getDay()` が UTC 評価だった + 前回送信から7日経過判定が欠けていた
- 対策: `getJstDayOfWeek()` ヘルパ + `messages_log` バルク照会で過去6日内既送をO(1)スキップ
- 被害復旧: 2026-04-13 の単一friend 196件 Flex 送信の再発防止

### 🎨 リッチメニュー alias 方式対応
| コミット | 内容 |
|---|---|
| `70ab018` | LINE alias API (create/update/delete/get/list) を SDK に追加 + worker エンドポイント + 画像差替時の自動 rebind |

- line-sdk: 5 メソッド追加 (`createRichMenuAlias` / `updateRichMenuAlias` / `deleteRichMenuAlias` / `getRichMenuAlias` / `getRichMenuAliasList`)
- worker: `GET/POST /api/rich-menus/aliases`, `PUT/DELETE /api/rich-menus/aliases/:aliasId`
- 画像差替フロー (`POST /api/rich-menus/:id/image`) に alias 自動引継ぎを組込（旧 richMenuId を指す alias を全て新 ID に update）

### 🧪 既存 fail 25件を全修正
| コミット | 内容 |
|---|---|
| `e92a8ad` | stripe 9 / liff 11 / liff-portal 1 / broadcasts 1 / rich-menus 2 件のテストを実装追従 |

- stripe: STRIPE_WEBHOOK_SECRET 必須化に伴い `signed webhook` describe に全機能テストを移行
- liff: liffAuthMiddleware による lineUserId フォールバック廃止に testLiffAuth ミドルウェアで対応
- liff-portal: `getShopifyProducts` mock を配列に修正
- broadcasts: response に `lineRequestId`/`insightsFetchedAt` 追加
- rich-menus: エラー文言ずれ修正

### 🧹 console.log クリーンアップ
| コミット | 内容 |
|---|---|
| `22ae5ea` | Worker 本番コードから console.log 20件を整理（削除 5 / info 昇格 12） |

### 📐 schema.sql 再生成 + 自動化スクリプト
| コミット | 内容 |
|---|---|
| `c6aa37a` | `scripts/regenerate-schema.mjs` + schema.sql 更新 (55テーブル+29カラム追記) |

- `pnpm regenerate-schema` で `migrations/*.sql` から自動再生成
- ALTER TABLE ADD COLUMN は CREATE TABLE 内へ inline マージ（SQLite 文法上、制約の前に）
- `wrangler d1 execute --file=schema.sql` がフレッシュ DB で 95 テーブルを正常作成することを検証済

### 🔐 STRIPE_WEBHOOK_SECRET 本番設定完了
- Stripe ダッシュボードで `naturism-production-webhook` 送信先作成（`https://naturism-line-crm.katsu-7d5.workers.dev/api/integrations/stripe/webhook`）
- リッスンイベント: `payment_intent.succeeded` + `customer.subscription.deleted`
- worker secrets に `STRIPE_WEBHOOK_SECRET` 登録済（合計14個）
- **Stripeアカウントはレビュー進行中 (2〜3日)** のため実決済テストは保留、レビュー完了後に自動動作開始

---

## 2. 🚨 超重要: デプロイ時の必須手順（罠あり）

### Worker デプロイで過去にハマったポイント
`.wrangler/deploy/config.json` が存在していた時期があり、**`npx wrangler deploy` 単独では Vite ビルド成果物 (`dist/`) を見に行く**。ビルドしないと古いコードが永遠にデプロイされ続ける地獄になる。

### 正しい手順
```powershell
cd C:\Users\user\Desktop\line-harness-oss\apps\worker
# ★ 必ず vite build してから deploy
npx vite build; npx wrangler deploy
# もしくは package.json の script を使う
pnpm deploy
```

`package.json` の `"deploy": "vite build && wrangler deploy"` が正しい。直接 `wrangler deploy` を叩くと事故る。

---

## 3. 現在の状態（2026-04-24 時点）

### Git
- **branch**: `main`
- **HEAD**: `c6aa37a` (schema.sql 再生成) — 本 v27 ハンドオフコミット前

### Build / Type / Tests
- `apps/web` typecheck: ✅ クリーン
- `apps/worker` typecheck: ✅ クリーン
- `packages/db` typecheck: ✅ クリーン
- `packages/line-sdk` typecheck: ✅ クリーン
- `packages/sdk` typecheck: ✅ クリーン
- **Worker tests: 966/966 pass**
- **SDK tests: 43/43 pass**
- `packages/plugin-template` のみ `@types/node` 不足でエラー（standalone テンプレート、本番影響なし）

### 本番デプロイ
| 項目 | 値 |
|---|---|
| Worker Version | `7ff3fcc4-c7a9-4168-85fe-6be108a47a40` |
| Web (Pages) | `naturism-admin.pages.dev` |
| Cron | `*/5 * * * *` 稼働中 |
| Webhook URL (LINE) | `https://naturism-line-crm.katsu-7d5.workers.dev/webhook` (LINE Developers で疎通確認済) |
| Stripe Webhook | `naturism-production-webhook` アクティブ (レビュー完了待ち) |

### D1 バックアップ
| 日付 | サイズ |
|---|---|
| `backups/naturism-d1-backup-2026-04-12-v2.sql` | 938KB (古い) |
| `backups/naturism-d1-backup-2026-04-17.sql` | 1.7MB |
| `backups/naturism-d1-backup-2026-04-23.sql` | 1.8MB |
| **`backups/naturism-d1-backup-2026-04-24.sql`** | **1.8MB (最新)** |

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
- `packages/plugin-template` の `@types/node` 不足（standalone template、本番影響なし）
- `migrations/009_delivery_type.sql` と `009_token_expiry.sql` の番号重複（適用済なので害はない、将来リネームで整理可）
- AI ガード (noise/burst/daily cap) チューニング定数は webhook.ts 先頭にあり、実運用データ次第で調整可

### 将来対応 (Katsu 判断待ち)
1. **DMM チャットブースト解約**: 2026-06-01〜06-30 に申請 → 7/31 解約推奨
   - 失うもの: トーク履歴 / DMM入力プロフィール（住所・電話・誕生日）/ DMM タグ / 顧客ステータス / メモ
   - 残るもの: 友だち8,265人本体 / LINE 公式アカウント / 友だち追加 URL / リッチメニュー
   - **誕生月再収集シナリオを naturism-line-crm から配信して救出するのが推奨**
2. **重要顧客の手動救出**: 対応済 / VIP などのフィルタで対象を絞り、DMM 管理画面からコピペで naturism-line-crm のメモ欄へ転記
3. **alias 初期セットアップ**: `naturism-default` alias 作成は将来 richmenuswitch 実装時でOK

---

## 5. プロエキスパート推奨アクション（次セッション以降）

優先度順に並記:

### P1 (運用の安定性 / 障害復旧)
1. **D1 バックアップ自動化**: 現在手動 (`wrangler d1 export`) → Workers Cron で毎日 R2 へ自動保存
2. **エラー監視**: Cloudflare Workers Logs は24時間で消える → Logtail/BetterStack/Sentry で長期保存 + Slack 通知
3. **デプロイ自動化 (GitHub Actions)**: push → test → typecheck → build → deploy を CI で。人間が vite build 忘れる罠を物理的に防ぐ
4. **ディザスタリカバリ手順書**: D1 全損時の復旧手順を `docs/DR.md` に（schema.sql + バックアップから15分で再構築できるか検証）

### P2 (セキュリティ)
5. **Dependabot / Renovate 有効化**: npm 依存の脆弱性監視
6. **シークレットローテーション計画**: LINE_CHANNEL_ACCESS_TOKEN / API_KEY / SHOPIFY系 を半年ごとに更新するチェックリスト
7. **レート制限強化**: 現在 webhook=60/60s, api=300/60s → Stripe 相当の厳しい設定に上げる検討

### P3 (品質 / 可観測性)
8. **E2E テスト**: Playwright で主要フロー（友だち追加→シナリオ→購入）をテスト
9. **パフォーマンス監視**: Cloudflare Analytics Engine で p95 応答時間を可視化
10. **コスト監視**: Workers AI / D1 読み書き / R2 のコストを日次レポート化

### P4 (コードヘルス)
11. **migrations 整理**: 009 番号重複のリネーム + 古いマイグレーション統合
12. **TypeScript strict 強化**: `any` 残存箇所の棚卸し
13. **プラグインテンプレートの @types/node 修正**

---

## 6. リポジトリ構成（pnpm 9.15.4 monorepo）

```
apps/
  worker/              Cloudflare Workers + Hono
    src/routes/        30+ ルート
    src/services/      Cron で回るビジネスロジック (12本)
  web/                 Next.js 15 + React 19 + Tailwind 4 (33ページ)
packages/
  db/                  @line-crm/db — D1 スキーマ + クエリ関数
    schema.sql         95テーブル (migrationsから再生成可)
    scripts/regenerate-schema.mjs  再生成ツール (pnpm regenerate-schema)
  line-sdk/            @line-crm/line-sdk — LINE Messaging API ラッパー (alias API追加済)
  shared/              @line-crm/shared
  sdk/                 外部向け SDK (43 tests)
backups/
  naturism-d1-backup-YYYY-MM-DD.sql  D1 バックアップ
  sessions/SESSION_HANDOFF_v1〜v26.md 旧セッション記録
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

チューニング定数 (webhook.ts 先頭):
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
| Memory | `C:\Users\user\.claude\projects\C--Users-user-Desktop-line-harness-oss\memory\MEMORY.md` |
| 旧セッション | `backups/sessions/SESSION_HANDOFF_v1〜v26.md` |

---

## 9. 新セッション開始時の推奨手順

1. このファイル `SESSION_HANDOFF_v27.md` を読む
2. `git log --oneline -10` で直近コミット確認
3. `pnpm -r typecheck` で全体ビルド健全性確認
4. Katsu から以下のいずれかの情報が来る可能性:
   - Stripe レビュー完了通知 → 実決済で webhook が動作しているか確認
   - DMM 解約申請タイミングの相談 (2026-06〜07月)
   - 新機能要望 / バグ報告
5. アクションが無ければ、**§5 の P1 推奨事項（バックアップ自動化 / エラー監視 / CI）** に着手することを提案

---

**以上、v27 ハンドオフ完了。次セッションで `git log --oneline -5` 確認から開始してください。**
