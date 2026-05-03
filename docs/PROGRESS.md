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
