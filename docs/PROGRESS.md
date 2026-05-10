# LINE Harness - 進捗管理

## プロジェクト概要
LINE公式アカウント向けOSS CRM / マーケティングオートメーション
L社/U社代替。AI（CC）ネイティブ設計。

## コンセプト
- **LINE Harness** = AIがLINEを安全に操作するための基盤
- 人間は監視、AIが操作
- 全機能API公開、ダッシュボードは可視化のみ
- 1プロジェクト = 1デプロイ（ステルス性最強）

## デプロイ先
- **API**: https://line-crm-worker.line-crm-api.workers.dev
- **管理画面**: https://line-crm-admin.pages.dev
- **D1**: line-crm (YOUR_D1_DATABASE_ID) APAC/KIX
- **Cron**: 5分毎ステップ配信チェック + リマインダー配信

## 実装状況

### Round 1 (MVP) ✅ 完了 2026-03-21
- [x] pnpm monorepo
- [x] D1スキーマ（friends, tags, scenarios, steps, broadcasts, auto_replies, messages_log）
- [x] Workers API (Hono) - webhook, friends, tags, scenarios, broadcasts
- [x] LINE SDK型付きラッパー
- [x] ステップ配信Cron
- [x] Next.js管理画面（ダッシュボード、友だち、シナリオ、配信）
- [x] 5分デプロイガイドREADME

### Round 2 (拡張) ✅ 完了 2026-03-21
- [x] UUID Cross-Account System (users, line_accounts テーブル)
- [x] LIFF Auth Flow (apps/liff/ Vite app)
- [x] Affiliate & CV Tracking (affiliates, conversion_points, conversion_events)
- [x] Stealth delivery (ジッター、パーソナライズ、時間分散)
- [x] Rich Message builders (Flex, Carousel, ImageMap, QuickReply)
- [x] SDK npm publish prep
- [x] OpenAPI/Swagger (/docs)
- [x] Enhanced Admin UI (Users, Conversions, Affiliates, LINE Accounts)

### Round 3 (フル機能) ✅ 完了 2026-03-22
- [x] Webhook IN/OUT System — 受信/送信Webhook CRUD + イベント連携
- [x] Google Calendar Integration — GCal接続/予約管理テーブル
- [x] Reminder/Countdown Delivery — リマインダー作成/ステップ/友だち登録/配信Cron
- [x] Lead Scoring — スコアリングルールCRUD + 手動/自動スコア加算 + 履歴
- [x] Template Management — テンプレートCRUD (text/flex/image)
- [x] Operator/Multi-user Chat — チャット閲覧/送信API
- [x] Notification System — 通知ルールCRUD + イベント連動
- [x] Stripe Payment Integration — Stripe連携テーブル/ルート（APIキー設定待ち）
- [x] BAN Detection & Recovery — アカウントヘルスモニタリング
- [x] IF-THEN Action Automation — オートメーションCRUD + 条件/アクション定義

### Round 3.5 (追加機能) ✅ 完了 2026-03-22
- [x] フォーム (LIFF) — フォーム定義/回答保存/metadata連携/タグ・シナリオ自動付与
- [x] トラッキングリンク — URL計測/クリック記録/誰がいつクリックしたか/タグ自動付与
- [x] リッチメニュー — LINE API経由 作成/画像アップロード/デフォルト設定/個別紐付け
- [x] エントリールート — 流入元トラッキング
- [x] friends.scoreカラム追加 — マイグレーション漏れ修正

### Phase 3: AI 食事診断 + カロリー記録 ✅ 完了 2026-04-27 (naturism)
- [x] PR-1: D1 マイグレーション 036 (`food_logs` / `daily_food_stats` / `monthly_food_reports`)
- [x] PR-2: Anthropic Claude Vision wrapper + LINE Content downloader (Zod / 薬機 redaction / 5MB cap)
- [x] PR-3: webhook image branch — 即時返信 + ctx.waitUntil() で AI 解析パイプライン
- [x] PR-4: LIFF API 6 endpoints (log/list/delete/stats/report) — TOCTOU 排除
- [x] PR-5: LIFF UI `/liff/food` — 履歴 + 手動入力 + 削除
- [x] PR-6: LIFF UI `/liff/food/graph` — Chart.js (カロリー / PFC / レンジ切替)
- [x] PR-7: 月次 AI レポート cron (毎月 1 日, idempotent, テンプレフォールバック)
- 検証: 1079 tests pass / 50 files (worker package), typecheck green
- 本番デプロイ: 別途 wrangler deploy 承認待ち
- 関連 secret: ANTHROPIC_API_KEY (登録済)
- git tag: v0.9.0-phase3 / D1 backup: backups/naturism-d1-backup-2026-04-27-phase3.sql

### Phase 4: AI 栄養コーチ + サプリ クロスセル ✅ 完了 2026-04-28 (naturism)
- [x] PR-1: D1 マイグレーション 037 (`nutrition_recommendations` / `nutrition_sku_map` seed 5件)
- [x] PR-2: `services/nutrition-analyzer.ts` — 決定論的 PFC 7 日窓 deficit 判定 (AI 不使用)
- [x] PR-3: `services/nutrition-recommender.ts` — Claude Haiku コピー生成 + 薬機 redaction + テンプレフォールバック
- [x] PR-4: LIFF API 4 endpoints (`/api/liff/coach/{latest,dismiss,click,regenerate}`) + UI `/liff/coach`
- [x] PR-5: 週次 push cron (火曜 10:00 JST gating, 7 日内 reco 持ち除外)
- [x] PR-6: 管理画面 `/coach` (KPI / by-deficit / SKU マップ管理) + Worker `/api/admin/coach/*` 4 endpoints
- 設計方針: Phase 3 で集めた `daily_food_stats` を消費 → naturism サプリ売上に変換する閉ループ
- 出口側 (CV): `nutrition_recommendations.conversion_event_id` で既存 CV 計測基盤と紐付け
- 関連 secret: ANTHROPIC_API_KEY (Phase 3 と共用)
- git tag: v0.10.0-phase4

### Phase 5: Production Hardening + Phase 3/4 Revenue Activation ✅ ほぼ完了 2026-05-02 (naturism)
**Ultraplan で TOP 1 として選定**。Phase 3+4 を本番に投入する前提整備。
- [x] PR-1: Sidebar に `/coach` リンク + Worker `/api/admin/coach/summary` (push 数を独立メトリクスで返す)
- [x] PR-2: 実 naturism Shopify URL で `nutrition_sku_map` を差し替え (migration 044) — 2026-05-02 完了
  - migration 037 が prod 未適用だったので先に適用 → 044 で 5 deficit_key を URL 化
  - protein_low/calorie_low → naturism Blue 180粒 / fiber_low/iron_low → KOSO Pink 180粒 / calorie_high → naturism Premium 180粒
  - 全 URL HTTP 200 応答確認、薬機法配慮 copy_template
- [x] PR-3: Playwright E2E 6 本 (`coach.spec.ts` 4 + `food-log.spec.ts` 2) — `page.route()` で全 worker API モック
- [x] PR-4: Cron 死活監視 (`cron_run_logs` table + `processCronMonitor` + Discord アラート JST 09:00 gating)
- [x] PR-5: Pre-deploy preflight checker (`pnpm preflight` / `--full` / `:test`) — REQUIRED_SECRETS / migration 整合性
- [x] PR-6: wrangler deploy + smoke runbook ← Round 4 deploy で実質完了
- [ ] **PR-7**: 7 日観測 + SKU copy_template A/B テスト ← Phase 4 KPI 蓄積後
- preflight 実行で発見された pre-existing 課題:
  - ~~CRITICAL: migration 009 duplicate~~ → **2026-04-28 解決**: README の「既知の歴史的事項」に従い preflight 側で allowlist 化 (commit fdcd1d9)
  - ~~WARN: migration gap at 038~~ → 同上、KNOWN_GAP_EXCEPTIONS で INFO に降格 (PR-2 は migration 044 で実装したため 38 は欠番のまま)
- git tag: v0.11.0-phase5-partial → 次回 v0.15.0-phase5-complete タグ予定

### Phase 6: 再購入リマインダー強化 ✅ 完了 2026-04-28 (naturism)
**Ultraplan で TOP 2 として選定**。既存 `subscription_reminders` (migration 029) を強化し、Phase 3/4 食事/栄養データと連動させた閉ループ完成。
- [x] PR-1: 商品別再購入間隔推定 (migration 040 + `repurchase-estimator` service)
  - 4段階フォールバック: user_history → product_default → auto_estimated (商品名 keyword) → fallback
  - clamp [7, 90] 日で異常値の暴発を防止
  - vitest 31 件 (estimator 19 + db helper 12) green
- [x] PR-2: Shopify webhook 自動 enrollment (`subscription-enroller` service)
  - orders/create で line_items の各商品を recipient friend に自動紐付け
  - 既存 active リマインダーは skip、1 商品の失敗が他を止めない
  - vitest 15 件 green
- [x] PR-3: Cross-sell 推奨マップ (migration 041 + `purchase_cross_sell_map`)
  - `subscription-reminder` push の Flex bubble に最大 2 件のクロスセル添付
  - shopify_products から商品タイトル解決、reason 表示
  - vitest 14 件 green
- [x] PR-4: LIFF `/liff/reorder` UI
  - 一覧 / 間隔変更 (preset 7-90日) / 停止・再開 / 削除
  - 既存 `/api/liff/subscriptions*` を活用、Phase 6 拡張カラム (interval_source) も表示
  - vitest 7 件 green
- [x] PR-5: 管理画面 `/reorder` KPI ダッシュ + ルール CRUD
  - Worker `/api/admin/reorder/*` 7 endpoints (summary / cross-sell CRUD / product-intervals CRUD)
  - Next.js `/reorder` page: KPI cards + interval_source breakdown + 直近 reminder 一覧 +
    cross-sell ルール編集モーダル + product_repurchase_intervals 編集モーダル
  - sidebar に 「📦 再購入」リンク追加
  - vitest 17 件 green
- [x] PR-6: cron-monitor 統合 + 再購入リマインダーの heartbeat 化
  - `subscription-reminder` cron が毎回 (no-op 含む) `cron_run_logs` に書き込み
  - `cron-monitor.DEFAULT_RULES` に `subscription-reminder` (maxSilentHours=24) 追加
  - 24 時間以上 silent なら Discord アラート発火
  - vitest 6 件 green
- [ ] **PR-7**: wrangler deploy + smoke runbook ← 本セッションでデプロイ済み
- [ ] **PR-8**: 7 日観測 + reminder copy A/B ← PR-7 完了後
- 自律実行済 PR: 6 件 (PR-1〜PR-6)。さらに本番事故 hotfix 4 件:
  - LIFF 「読み込み中...」固着 (VITE_LIFF_ID 未注入) → main.ts throw → showError 化 + preflight liff-bundle 検証追加
  - LINE 内ブラウザ hang → timeout fallback UI + LIFF URL 切替ボタン
  - 完了画面メニュー導線追加 (PC ブラウザ行き止まり対策)
  - authMiddleware の LIFF skip 漏れ → `path.startsWith('/liff/')` に拡張 + 回帰テスト 6 件
- worker 全テスト: **1309 tests pass / 64 files** (Phase 6 PR-1〜PR-6 + hotfix で計 +96 件追加)
- git tag: v0.13.0-phase6-complete (Phase 5 PR-2 = naturism Shopify GID 投入は別途)

### Round 4 (大幅進行中 — 2026-04-30 / 2026-05-01)
**完了 PR**:
- [x] PR-0: users.email/phone Shopify backfill (2026-04-29)
- [x] PR-1: @line-crm/email-sdk 新規パッケージ — Resend client + EmailRenderer + Zod (2026-04-29)
- [x] PR-2: migration 042 + email_subscribers/templates/messages_log helpers (2026-04-29)
  - 本番 D1 に migration 042 適用済 (2026-04-30): 4 tables + 9 indexes
- [x] PR-3: services/channel-dispatcher.ts — channel 抽象化 + 法令ゲート (2026-04-30)
  - 23 vitest 全パス。本番 deploy 済
- [x] PR-4: routes/integrations-resend.ts + utils/svix-signature.ts (2026-05-01)
  - Resend webhook 受信 + Svix 署名検証 + 5 イベント型処理 + bounce/complaint 自動 suppress
  - 29 vitest (svix 10 + integrations-resend 19) 全パス。本番 deploy 済 (503 = secret 未登録の正常状態)
- [x] PR-5: routes/email-unsubscribe.ts — GET/POST + RFC 8058 One-Click + HMAC 検証 (2026-04-30)
  - 24 vitest 全パス。本番 deploy 済 — `/email/unsubscribe` 経路 200/400/404 動作確認
- [x] PR-6 段階 1: automations の send_email action 統合 (2026-05-01)
  - services/email-dispatch-config.ts + services/send-email-action.ts 新規
  - event-bus.ts: fireEvent → processAutomations → executeAction の 3 レイヤに emailConfig?: EmailDispatchConfig | null をスレッド (既存動作不変)
  - case 'send_email' 実装: friend → subscriber 解決 → dispatcher 経由 (channel='email')
  - templateId / 直接 content 両対応、{{name}} を friend.display_name で自動展開
  - fireEvent コーラー 8 件更新 (friends/liff-portal/shopify/stripe/webhook/webhooks)
  - 21 vitest 追加 (send-email-action 13 + email-dispatch-config 8)
  - 既存 stripe/webhooks tests を fireEvent 新シグネチャに合わせて更新
  - 本番 deploy 済 (Version `f86a75d9-f285-45d1-93c4-4d50e4833e6b`)
  - Cloudflare Email Routing で `support@naturism-diet.com → info@kenkoex.com` も完成
  - LINE Console email permission `Applied` (= 承認済) 確認済
- [x] Cloudflare Email Routing 設定 (2026-05-01): apex MX を Cloudflare に切替 (X-Server MX 削除) + `support@naturism-diet.com → info@kenkoex.com` route 作成 + apex SPF を Cloudflare 用に更新
  - Resend 用の `mail.naturism-diet.com` / `send.mail.naturism-diet.com` レコードは別 subdomain で独立 → 影響なし
- [x] PR-6 部分: subscription-reminder を ChannelDispatcher 経由化 (2026-05-01)
  - 既存 5 call-site のうち 1 つ完了。残 4 (event-bus / broadcast / scenarios / automations) は LINE 承認後に実施
  - behavior 改善: is_following=0 / is_blacklisted=1 が legitimate skip 扱いに (旧コードは永久リトライ問題)

**残 PR (オーナー作業 + 後続)**:
- [x] PR-6 段階 2: broadcast.ts / step-delivery.ts dispatcher 化 (2026-05-02 完了, commit cbdeacf)
  - migration 043 で broadcasts/scenario_steps に `channel` + `email_template_id` 列追加
  - channel='line' は既存挙動不変、'email'/'both' で dispatcher 経由
  - +41 vitest (broadcast 16 / step-delivery 11 / scenarios 7 / broadcasts +7)
- [x] PR-7: 管理画面 (`/email` ページ群) + admin API (2026-05-02 完了, commit a3eda14)
  - Worker: 8 endpoints under `/api/admin/email/*` (kpi/subscribers/templates/messages) + 28 vitest
  - Web: `/email` page (KPI 8 cards / subscribers / templates 編集 / messages 履歴) + サイドバー追加 + 4 Playwright e2e
- [ ] PR-8: DMARC 段階移行 (p=none → quarantine → reject)
  - **Stage 1 (p=none)** で稼働中 (rua=mailto:dmarc@naturism-diet.com、観測フェーズ開始 2026-05-02)
  - 2026-05-09 以降: レポート pass 率 99%+ 確認後、p=quarantine pct=10 に昇格 (要オーナー承認)
  - EMAIL_RUNBOOK.md §6-0 に現状ステータス記載済

**Phase 7 (cron 監視) 拡張完了**:
- 10 cron jobs を `withHeartbeat()` で wrap (2026-04-30 deploy 済)。本番で連続成功確認済
- cron_run_logs 自動 cleanup (30 日保持、JST 03:00 daily) 追加 (2026-05-01)

**docs/EMAIL_RUNBOOK.md 新規** (2026-05-01, 700+ 行) — オーナー手順書:
- smoke test 3 ISP / bounce-complaint テスト / DMARC 段階移行 / 法令準拠チェック / KPI モニタリング SQL
- 2026-05-02 更新: §6-0 に現状ステータス追記 (DMARC Stage 1 観測中)、postmaster@ → dmarc@ 統一

**worker 全テスト**: **1532 tests pass / 80 files** (本セッションで PR-7 +28 / PR-6.2 +41 = +70 件追加)

### Round 4 拡張予定
- [ ] メール配信連携 (Resend primary + SendGrid fallback) — Ultraplan: `docs/ROUND4_EMAIL_ULTRAPLAN.md` 8 PR
- [ ] SMS連携
- [ ] Instagram DM連携
- [ ] LTV予測・チャーン予測
- [ ] ポイントシステム
- [ ] 抽選/くじ機能
- [ ] ファネルビルダー（LIFF + CF Pages）

### Phase 6 観測結果 (2026-04-29 18 時間時点 KPI 速報)
- レポート: `docs/PHASE6_KPI_REPORT_2026-04-29.md`
- 主な発見: ① 本番 D1 に migration 039 (`cron_run_logs`) が未適用だった → 本セッションで適用済み (additive only) ② Phase 6 PR-2 が一度も発火していない (orders/create 0 件 + users.email NULL) ③ product_repurchase_intervals / cross_sell_map 共に 0 件 (seed 必要)
- /liff/cart 500 hotfix 同時投入 (commit `322bb46`)

### naturism-diet.com Google Workspace 移管 ✅ 完了 2026-05-03 (naturism)
**naturism ブランド専用メール基盤を Cloudflare Email Routing → Google Workspace に移管**。年商21億規模の対外メール環境を整備。
- Google Workspace Business Starter (info@naturism-diet.com 1 ライセンス) 14日間トライアル開始
- Cloudflare Domain Connect で apex MX 自動切替 (Cloudflare route1/2/3 → Google ASPMX 5 件)
- apex SPF 更新: `v=spf1 include:_spf.google.com ~all`
- DKIM 新設 (2048-bit): `google._domainkey.naturism-diet.com` (Cloudflare API 経由で TXT 追加 → 即時浸透 → Google Admin で「認証済」)
- 6 alias 集約: support / contact / partnership / press / noreply / dmarc → 全て info@ inbox
- Gmail Send-as 5 件設定 (info@ + 4 alias、表示名: naturism公式 / naturism Official / naturism カスタマーサポート / naturism パートナーシップ事務局 / naturism 広報 / naturism (自動送信))
- デフォルト返信モード: 「メールを受信したアドレスから返信する」
- 検証: 受信テスト (3 alias 同時受信) + 送信テスト (support@ alias from info@ → SPF/DKIM PASS、Spam 判定なし)
- mail.naturism-diet.com (Resend) は完全独立で稼働継続 = LINE Harness のメール送信機能 (`noreply@mail.naturism-diet.com`) は不変
- DMARC は変更なし (Stage 1 `p=none` 観測継続、rua=dmarc@→info@ alias 経由)
- 後処理: Cloudflare Email Routing destination address (`info@kenkoex.com`) は後日削除予定
- 関連ドキュメント: `docs/EMAIL_RUNBOOK.md` §6-0 全面更新

### Bundle ID 同期問題 自動検証 ✅ 完了 2026-05-07 (naturism)
**2026-05-02 朝・2026-05-07 朝の 2 度発生した「deploy 後も古い bundle が serve され続ける」事故対策**。
- `scripts/post-deploy-check.mjs` 新規 — ローカル `apps/worker/dist/client/index.html` の bundle ID と本番 `/` を最大 30s (5s × 6 attempts) リトライで照合し、不一致なら exit 1
- `apps/worker/package.json` の `deploy` script を `vite build && wrangler deploy && post-deploy-check` に拡張 → 以降は redeploy 漏れに自動気付ける
- `node:test` で 15 ユニットテスト追加 (extractBundleId / buildResult / runCheck の retry / mismatch / fetch-fail パス)
- ルート `package.json` に `pnpm post-deploy-check` (CLI 単体) と `pnpm test:scripts` (preflight + post-deploy 一括) を追加
- 本セッションの実 deploy で動作確認済 (Worker version `f682e1ee-c827-4328-ba2b-efeb41f8e7e2`、bundle `index-DuC2JoJn.js`)
- 2026-05-07 12:00 JST の merge 後 redeploy で post-deploy-check 本番初稼働 → attempt 1 即 match (Worker version `fd80e760-0e35-4e5a-b3ab-b9fe6ce19273`)
- CLAUDE.md デプロイルール / 事故時ロールバック手順を改訂

### ultrathink 全体セキュリティ・品質レビュー対応 ✅ 完了 2026-05-07 (naturism)
**Round 4 完成段階で並列 `security-reviewer` + `typescript-reviewer` で全体レビュー**。検出した脆弱性・品質劣化を一括修正 (PR #14 内 commit `83e1f5b`)。

- **CRITICAL (1)** Stripe webhook 署名検証 (`apps/worker/src/routes/stripe.ts`) を `crypto.subtle.verify` で timing-safe 比較化。同時に timestamp ±300s 検証 (replay 攻撃防止) と複数 `v1` (シークレットローテーション) 対応を追加
- **HIGH (9)**:
  - `post-deploy-check.mjs` に `WORKER_URL` allowlist (SSRF 防止) + `AbortController` 10s timeout、exit code 0/1/2 で意味分離 (1=mismatch、2=pre-cond / fetch fail / script tag missing)
  - `EmailMessage.from` を `z.string().email()` から mailbox schema に置換 (`naturism <noreply@mail.naturism-diet.com>` 形式を受け入れ)
  - `channel-dispatcher.sendEmail` で `render()` 失敗を `email_messages_log.failed` に記録 (KPI 整合性)
  - `step-delivery.ts` の `channel='both'` で LINE/email を独立試行 (片方の throw が他方を止めない)
  - `evaluateCondition.JSON.parse` を `parseConditionValue` / `parseMetadata` で安全パース化 (シナリオ永続 skip 防止)
  - `email-unsubscribe` の subscriber id を UUID v4 形式正規表現で事前バリデーション
  - `webhook.ts BURST_WINDOW_SEC` を SQL placeholder に移行 (将来の SQLi 予防)
- **MEDIUM (2)**: `email-admin /messages` の status クエリ allowlist、post-deploy-check exit code 整理
- **LOW (1)**: `repurchase-estimator` の best-effort catch に `console.warn` 追加 (silent fail 防止)
- **Pre-existing flake (1)**: `liff-portal-food.test.ts` の絶対日付 fixture (2026-04-27) が `ATE_AT_PAST_LIMIT_MS=7d` を超え 3 件 fail → `recentIso(hoursAgo)` helper で実行時刻基準の相対日付に置換
- 検証: `pnpm test:scripts` 59 件 / `pnpm --filter worker test` 1535 件 / `email-sdk` 14 件 すべて green
- 本番反映: Worker `fd80e760-0e35-4e5a-b3ab-b9fe6ce19273` (2026-05-07 12:00 JST)、smoke `200/400/401/401/401` (Stripe webhook 含む)

### Bundle ID 同期問題 3 度目発生 + DMARC observation test 起動 🔄 進行中 2026-05-09 (naturism)
**朝の smoke test で 3 度目の Bundle ID 不一致を検出 → redeploy で復旧 + DMARC 観測判定の前提整備**

**Part 1: Bundle ID 不一致 (3 度目) → redeploy で解消**:
- 朝の smoke 確認時、本番 bundle が `index-C9dAgO2t.js` (= 2026-05-07 セッションで「古い」と判定された bundle ID) に戻っていた
- `wrangler deployments list` で確認: 前セッション handoff の `fd80e760` (2026-05-09 00:31) 以降に出所不明 deploy 3 件 (`50601c44` 00:43、`a0fa0c0a` 07:19) が積まれていた
  - main commit (`a9f08fe`) 不変、git reflog にも私の deploy 履歴なし
  - 仮説: 別経路 (別セッション or rolling) で同 commit から build された hash 異なる bundle が deploy
- 対応: `pnpm preflight` (green) → `pnpm --filter worker run deploy` 実行 → 新 version `afeab7f7-20b7-4a14-8c53-66e47a7756d8` / bundle `index-DuC2JoJn.js` で post-deploy-check attempt 1 即 match
- smoke 5/5 OK (200/400/401/401/401)
- post-deploy-check が 3 度目の検証で初稼働を超えて実用フェーズに到達

**Part 2: DMARC observation maturity 判定の前提調査**:
- Gmail MCP で DMARC aggregate report 全件検索 → **0 件** (subject:Report-Domain naturism-diet.com / has:attachment filename:xml / from:dmarc-noreply etc. すべて 0 件)
- DNS / SPF / DKIM / DMARC TXT すべて期待通り (`v=DMARC1; p=none; rua=mailto:dmarc@naturism-diet.com; fo=1`)
- 本番 D1 確認: email_subscribers 0 件 / email_templates 0 件 / email_messages_log 0 件 / email_link_clicks 0 件
- cron 14 jobs 直近 7 日全 success / failed 0 件
- **判定不能の理由**: DMARC レポートは「ドメイン名義の送信統計」を集計するため、送信ゼロ = レポート対象なし → 統計判定材料なし

**Part 3: DMARC test 送信 1 回目 → CRITICAL bug 発覚 → fix → 2 回目送信成功**:
- email_templates `cd574436-f668-4896-9b4a-eb7cd4230319` (DMARC Observation Test、薬機・運用通知でない明記)
- email_subscribers `bc852746-bf6c-4e82-a200-2631c9256a2c` (katsu@kenkoex.com、friend `38215b51-...` 紐付き)
- broadcasts 1 回目 `a68abee5-...` (scheduled 08:23 JST) → 8:25 cron 発火 → ❌ status='failed' / `Illegal invocation: function called with incorrect this reference`
  - 原因: ResendClient で `this.fetchImpl = options.fetchImpl ?? fetch` (unbound) を class field 化していた
  - Workers ランタイムで `this.fetchImpl(...)` 呼出時、`this` が ResendClient になり globalThis でないため fail
  - **本番初の email 送信で発覚** (Round 4 完成済だが Round 4 PR-1〜7 で実送信は一度も走っていなかった)
  - 修正: `fetch.bind(globalThis)` を default に + regression test (`name=^bound /` チェック)
  - email-sdk 15 / worker 1535 / typecheck / preflight all green → redeploy worker version `4ebd6763-81fe-49bd-a65c-133cbc827df1` (08:42 JST)
  - commit `9b2fe06` を main へ push
- broadcasts 2 回目 `e91afd6c-...` (scheduled 08:45 JST) → 8:50 cron 発火 → ✅ status='delivered'
  - sent 2026-05-09T08:50:02.231+09:00 / delivered 08:50:07.147+09:00 (5 秒で配達完了)
  - provider: resend / provider_message_id: `9740f7b3-603e-4211-b595-87f28934a6ee`
  - **Resend webhook (Round 4 PR-4) も同時に本番初稼働確認** — `delivered` ステータス受信は webhook → svix 検証 → email_messages_log 更新が動いた証拠
- 24-72h 後 (= 2026-05-10〜2026-05-12)、Google が DMARC aggregate report XML を `dmarc@naturism-diet.com` (info@ alias 経由) に送付想定
- レポート受信後の流れ: Gmail MCP で XML 取得 → パース → pass 率算出 → 99%+ なら p=quarantine pct=10 昇格判定 → Cloudflare DNS API (1 日限定 token) で TXT 更新

**Part 4: 予防的レビュー (並列 agent 2 つ) → 7 件追加修正**:
本日の bug fix 経験を踏まえて、テストでは検出できないリスクパターンを能動的に洗い出し:
- **security-reviewer agent**: Workers global object 利用全件スキャン (fetch / crypto.subtle / TextEncoder / D1 method 等) → **0 件** (ResendClient 修正以外に同類リスクなし)
- **typescript-reviewer agent**: Round 4 全体型/error 安全性レビュー → **HIGH 1 件 + MED 5 件 + LOW 3 件** 検出

修正 (HIGH + 軽量 MED + LOW-1 を即時対応):

| # | level | file | fix |
|---|---|---|---|
| H-1 | HIGH | `packages/email-sdk/src/renderer.ts` | constructor で `unsubscribeBaseUrl` の `https://` 強制 + `injectFooter` で `unsubscribeUrl` / `preheader` を escapeHtml して XSS 防止 (regression test 4 件追加) |
| M-1 | MED | `apps/worker/src/services/broadcast.ts` | `lookupEmailRecipients` / `sendBroadcastBoth` の N+1 → `batchLookupSubscribers(chunk=100)` で `WHERE friend_id IN (?, ?, ...)` 集約 |
| M-2 | MED | `apps/worker/src/services/step-delivery.ts` | line 127 の生 `JSON.parse` → 既存 `parseMetadata` ヘルパー利用 (malformed JSON で scenario 永久 stuck 防止) |
| M-3 | MED | `apps/worker/src/services/broadcast.ts` | `sendBroadcastEmail` で `loadSentSubscriberIdsForBroadcast` を pre-load → retry 時に既送信 subscriber を skip (重複送信防止) |
| M-4 | MED | `apps/worker/src/services/channel-dispatcher.ts` | `ConsentGateResult` を discriminated union 化 → `as EmailSkipReason` cast 削除、コンパイル時に reason 漏れ検出 |
| M-5 | MED | `apps/worker/src/services/channel-dispatcher.ts` | `safeInsertEmailLog` で `err.message` も log (D1 constraint 違反等が現場で診断可能に) |
| LOW-1 | LOW | `apps/worker/src/services/channel-dispatcher.ts` | `errorSummary` slice を 500 → 480 で統一 (render-fail path と揃える) |

**保留 (記録のみ、別 PR 推奨)**:
- LOW-2: text format unsubscribeUrl 長さ check (over-engineering)
- LOW-3: display_name fallback 不一致 (`''` vs `'お客様'`、send-email-action は意図的に異なる挙動)
- M-3 拡張: `sendBroadcastBoth` の重複防止 (LINE + email 両方の channel 制御が必要、scope 大)

**ドキュメント追加**:
- `CLAUDE.md`: 「Workers コーディングルール (絶対遵守 — 再発防止)」 セクション新設 (禁止/推奨パターン + 自己点検チェックリスト)
- `docs/EMAIL_RUNBOOK.md`: §12 トラブルシューティング章新設 (Illegal invocation / broadcast 失敗 / retry 重複 / DMARC report 不着)

### Phase 8 PR-1: Shopify customer sync enrichment (opt-in 同意取得) ✅ 完了 2026-05-10 (naturism)
**目的**: email_subscribers seed の準備として、 Shopify customers の opt-in 同意状況 (email_marketing_consent / sms_marketing_consent / accepts_marketing 等) を CRM 側 metadata に保存し、 SQL `json_extract` で抽出可能にする。

**背景**:
- shopify_customers 316 件 / metadata は全件 `{"source":"cron_sync"}` のみ (47 文字)
- accepts_marketing カラム不在 → email_subscribers seed のための opt-in 抽出が不可能
- 解決策 3 案 (A: metadata enrichment / B: schema 拡張 / C: 1 回 import script) を比較、 Option A 採用 (schema 不変、 リスク低、 継続的価値、 拡張性)

**実装内容**:

1. `apps/worker/src/services/shopify-customer-sync.ts` 改修:
   - **paging 実装**: Shopify REST API の Link header `rel="next"` を辿る、 max 50 page (12,500 件) で safety
   - **metadata enrichment**: `email_marketing_consent`, `sms_marketing_consent`, `accepts_marketing`, `accepts_marketing_updated_at`, `marketing_opt_in_level`, `sync_at` を metadata JSON に保存
   - **return 型拡張**: `synced` + `subscribed` / `notSubscribed` / `pending` / `unsubscribed` / `pages` の集計を追加
   - **parseNextUrl 公開ヘルパー**: Link header から `rel="next"` URL を抽出 (regex)
2. `apps/worker/src/__tests__/shopify-customer-sync.test.ts` 新規 (9 件):
   - parseNextUrl 単体テスト (3 ケース)
   - syncShopifyCustomers の 1 page 同期 + state 集計 / 2 page paging / 途中 page エラー保持 / metadata 内容確認 / env 不正

**重要 bug fix (CRITICAL)**:
- `packages/db/src/shopify.ts` の `upsertShopifyCustomer` / `upsertShopifyOrder` の **UPDATE 文に `metadata` 列が無く、 既存レコードの metadata が永久に上書きされない** bug を発見
- これがあると上記 enrichment が新規 customer のみに反映され、 既存 250 件には永久に届かない
- 修正: `metadata = COALESCE(?, metadata)` で「指定があれば上書き、 無ければ既存維持」 (INSERT 挙動は不変)
- 初回 deploy `649ca093` で症状判明 (cron 23:18 sync 後も metadata 古いまま) → DB fix → 再 deploy `b1fbb651`

**type narrowing fix (回帰)**:
- `apps/worker/src/__tests__/channel-dispatcher.test.ts` の `expect(r.allowed).toBe(false); expect(r.reason)...` パターンが、 前回 M-4 修正 (ConsentGateResult discriminated union 化、 commit `6f47f96`) 後に typecheck error を返していた (前回見落とし)
- `if (r.allowed) throw new Error(...)` で narrowing を確立

**seed 準備物 (Katsu レビュー後に投入)**:
- `docs/SEED_EMAIL_TEMPLATES.md`: welcome / order_confirmation / reorder_reminder / cart_recovery / shipping_notification の 5 種メールテンプレ案 (HTML + text + 想定変数 + 法令確認チェックリスト)
- `scripts/seed-email-subscribers-from-shopify.sql`: `email_marketing_consent.state = 'subscribed'` の Shopify customers を email_subscribers に INSERT する SQL (Dry-run コメント + INSERT OR IGNORE で冪等性確保)

**検証**:
- worker tests: 1544 件 (+9) all green
- typecheck (db + worker): green
- preflight: All green
- 初回 deploy `649ca093` (DB UPDATE bug あり) → 再 deploy `b1fbb651` (DB fix 込み) で次回 cron 発火 (5 分毎) で 250 件分の metadata enrichment が反映予定
- 集計クエリ: `SELECT json_extract(metadata, '$.email_marketing_consent.state') AS state, COUNT(*) FROM shopify_customers GROUP BY state;`

**集計結果 (2026-05-10 23:30 JST 時点)**:
| state | 件数 | 比率 | 配信可否 |
|---|---|---|---|
| **subscribed** | **2** | 0.1% | ✅ marketing 配信可能 |
| not_subscribed | 1,690 | 89.4% | ⚠️ opt-in 未取得 |
| `null/old format` | 192 | 10.2% | ⚠️ cron 順次 enrich 中 |
| unsubscribed | 7 | 0.4% | ❌ 明示解除 |
| **合計** | **1,891** | 100% | (前回認識 316 件 → paging 実装で 1,891 件と判明、 5.9 倍) |

**戦略的含意**:
- subscribed が 2 名のみ = naturism Shopify チェックアウトで「メルマガ受け取る」 がデフォルト OFF or 表示なしの可能性
- マーケティング配信の即時開始は実質効果ゼロ
- 推奨段階移行:
  - **Phase 1 (即可能)**: Transactional メール先行 (注文確認 / 発送通知、 opt-in 不要、 1,891 件全員に届く)
  - **Phase 2 (Shopify 側施策)**: チェックアウトに opt-in checkbox を必須化
  - **Phase 3 (subscribers 100+ 後)**: Marketing メール (welcome / reorder reminder / cart recovery) 開始
- 既存 1,690 名 not_subscribed への opt-in 再取得施策 (1 回限りの transactional 確認メール + LINE 友だち追加クーポン等) も検討候補

### Phase 6 KPI seed 投入 ✅ 完了 2026-05-03 (naturism)
**Round 4 PR-7 deploy 後の Phase 6 動線開通**。観測 KPI 速報 ③「seed 必要」課題を解消。
- [x] migration 045 で `product_repurchase_intervals` に主要 3 SKU を seed
  - 7694090469629 → naturism Blue 180粒(個包装6粒×約30日分) → **30 日**
  - 7694096367869 → KOSO in naturism(Pink)180粒 (個包装6粒×30日分) → **30 日**
  - 9081674006781 → naturism Premium 180粒(20日分)[機能性表示食品] → **20 日**
  - source='seed'、後から user_history / 運用者編集で上書き可能
- [x] migration 045 で `purchase_cross_sell_map` に 6 ペア (3×2 相互推奨) を seed
  - 各ペアに薬機配慮 reason (成分・組成の客観的説明 + ライフスタイル提案のみ)
  - priority 10/5 で表示順を制御 (push 時 limit=2 で上位 2 件採用)
- 本番 D1 適用確認: intervals 3 行 / cross_sell 6 行 (`SELECT COUNT(*)` で検証)
- worker コード変更なし → redeploy 不要、admin /api/admin/reorder/* は 401 正常応答
- 期待効果: 次の Shopify orders/create webhook 発火時に
  ① Premium ユーザーは 20 日サイクルで正確リマインド (旧: 一律 30 日 = 10 日切らし)
  ② push に 「🎁 こちらもおすすめ」セクションが最大 2 件追加

## テスト済み機能 (2026-03-22 周アカウントで実施)

| 機能 | API | LINE送信 | 備考 |
|------|-----|---------|------|
| テンプレート | ✅ 3件 | — | text/flex/image |
| タグ付与 | ✅ 3件 | — | VIP/アクティブ/フォーム回答済み |
| スコアリング | ✅ 35pt | — | ルール4件 + 手動加算 |
| IF-THEN | ✅ 3件 | — | msg/form/followトリガー |
| リマインダー | ✅ | — | 3/25予約で3ステップ登録 |
| 通知ルール | ✅ 2件 | — | follow/form_submitted |
| Webhook | ✅ IN1+OUT1 | — | Zapier連携テスト |
| Text送信 | ✅ | ✅ 到達確認 | APIプッシュ |
| Flex送信 | ✅ | ✅ 到達確認 | ステータスカード |
| フォーム | ✅ | ✅ LIFF | 回答D1保存+metadata連携 |
| トラッキングリンク | ✅ | ✅ 5クリック | friendId紐づけ+タグ自動付与 |
| リッチメニュー | ✅ | ✅ 表示確認 | 3分割メニュー |
| UUID連携 | ✅ | — | friend→user紐づけ済み |

## D1テーブル一覧 (42テーブル)
account_health_logs, account_migrations, admin_users, affiliate_clicks,
affiliates, auto_replies, automation_logs, automations, broadcasts,
calendar_bookings, chats, conversion_events, conversion_points,
entry_routes, form_submissions, forms, friend_reminder_deliveries,
friend_reminders, friend_scenarios, friend_scores, friend_tags, friends,
google_calendar_connections, incoming_webhooks, line_accounts, link_clicks,
messages_log, notification_rules, notifications, operators,
outgoing_webhooks, ref_tracking, reminder_steps, reminders,
scenario_steps, scenarios, scoring_rules, stripe_events, tags,
templates, tracked_links, users

## 技術スタック
| レイヤー | 技術 |
|---------|------|
| API/Webhook | Cloudflare Workers + Hono |
| DB | Cloudflare D1 (SQLite) |
| Cron | Workers Cron Triggers |
| 管理画面 | Next.js 15 + Tailwind on CF Pages |
| LIFF | Vite + vanilla TS |
| LINE連携 | 自作型付きSDK (@line-crm/line-sdk) |

## マネタイズ案
1. ホスティング代行（月3,000〜5,000円）
2. セットアップ代行（5〜10万円）
3. シナリオ構築コンサル（10〜30万円）
4. BAN復旧サービス（5〜15万円）
5. ビジネスオーナーリスト活用

## 設計思想
- コア = LINE配信エンジン + UUID基盤 + CV計測
- 外部連携 = Webhook/APIで繋ぐ（Stripe, GCal, SendGrid等）
- ダッシュボード = 視覚的に見るべきものだけ
- 設定・構築 = CC（Claude Code）経由でAPI操作
- 安全策 = Zodバリデーション, dry_run, audit log, バージョニング, 配信制限

## 参考資料
- SPEC.md - 技術仕様
- LSTEP_FEATURES.md - L社/U社全機能調査
