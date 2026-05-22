# Lステップ網羅性 audit (2026-05-22 snapshot)

**目的**: 大方針 3「Lステップ全網羅」 (= 215 機能 / 実装対象 203 / 目標 99.5%) の現状進捗を可視化し、 隙間と次着手優先度を確定する。

**source**: `docs/COMPETITOR_FEATURES.md` (= L社 20 機能 + U社 詳細 ~200 機能)
**audit 方法**: 機能カテゴリ単位で routes (`apps/worker/src/routes/`) + admin pages (`apps/web/src/app/`) + D1 schema を照合
**snapshot 日**: 2026-05-22 (= main commit `5d04db8`、 PR #1〜48)

---

## 1. L社 主要 20 機能 — 現状

| # | 機能 | 状態 | 実装 location |
|---|---|---|---|
| 1 | ステップシナリオ配信 | ✅ 実装済 | routes/scenarios.ts + step-delivery cron + admin /scenarios |
| 2 | セグメント配信 | ✅ 実装済 | routes/broadcasts.ts + tags + admin /broadcasts |
| 3 | リマインダーステップ配信 | ✅ 実装済 | routes/reminders.ts + reminder_steps + cron |
| 4 | キーワード応答 | ✅ 実装済 | auto_replies table + webhook.ts (Layer 1) |
| 5 | テンプレート | ✅ 実装済 | routes/templates.ts + admin /templates |
| 6 | グルーピングタグ | ✅ 実装済 | routes/tags.ts + admin /friends + automations |
| 7 | 友だち情報欄管理 | ✅ 実装済 | routes/friends.ts + friends + friend_metadata + admin /friend-detail |
| 8 | スコアリング | ✅ 実装済 | routes/scoring.ts + scoring_rules + friend_scores + admin /scoring |
| 9 | CSV インポート/エクスポート | ⚠️ 部分実装 | routes/csv-export.ts (export のみ、 import 未対応) |
| 10 | セグメントリッチメニュー | ✅ 実装済 | routes/rich-menus.ts + admin /rich-menus |
| 11 | カルーセルパネル | ⚠️ 部分実装 | templates でカルーセル送信可、 admin UI 編集は基本のみ |
| 12 | 回答フォーム | ✅ 実装済 | routes/forms.ts + form_submissions + LIFF |
| 13 | 流入経路分析 | ✅ 実装済 | routes/tracked-links.ts + admin /traffic-sources (UTM 集計済) |
| 14 | クリック計測 | ✅ 実装済 | tracked-links + link_clicks + 友だち紐付け |
| 15 | ファネル分析 | ❌ 未実装 | Phase 5β-7 で計画 |
| 16 | オペレーター機能 | ⚠️ 部分実装 | routes/staff.ts + admin /staff (= スタッフ登録のみ、 1to1 チャット振分は未) |
| 17 | 通知機能 | ✅ 実装済 | routes/notifications.ts + notification_rules + Discord webhook |
| 18 | クロスデバイス対応 | ✅ 実装済 | Next.js 15 + Tailwind responsive (= PC/SP) |
| 19 | マルチカレンダー | ⚠️ 部分実装 | routes/calendar.ts + calendar_bookings (Google Cal 連携は Phase 5ε で予定) |
| 20 | 広告連携 | ⚠️ 部分実装 | routes/ad-platforms.ts + conversions (= LINE Ads は ULTRA PLAN 段階) |

**カバー率 (L社 20 機能)**: ✅ 13 / ⚠️ 6 / ❌ 1 = **65% 実装済 + 30% 部分** = 実用 ~95%

---

## 2. U社 主要機能 — 現状

| カテゴリ | 機能 | 状態 | 備考 |
|---|---|---|---|
| ファネル | ファネルマップ | ❌ 未実装 | Phase 5δ-3 ファネルビルダー AI で計画 |
| ファネル | スワイプLP | ❌ 未実装 | OSS 公開後 検討 |
| ファネル | Meta コンバージョン API | ❌ 未実装 | conversions.ts は LINE Ads のみ |
| 決済 | Stripe 連携 | ⚠️ 部分実装 | routes/stripe.ts + stripe_events (基本のみ、 サブスク継続は Phase 5ι) |
| 決済 | UnivaPay / テレコムクレジット | ❌ 未実装 | Phase 5ι 後検討 (= 国内向け代替 PSP) |
| 決済 | 3D セキュア | ❌ 未実装 | Stripe が一部対応、 専用 UI なし |
| 決済 | 売上一覧 / 返金処理 / 領収書発行 | ❌ 未実装 | Shopify 側で対応 (= naturism 専用) |
| メール配信 | ステップメール | ✅ 実装済 | routes/email-admin.ts + email_templates + integrations-resend |
| メール配信 | 一斉送信 / リマインドメール | ✅ 実装済 | broadcasts (email channel) |
| メール配信 | HTMLメール | ✅ 実装済 | Resend integration、 HTML 対応済 |
| 配信 | A/Bテスト | ✅ 実装済 | routes/ab-tests.ts + admin (broadcast 配信時) |
| 配信 | リンク期限設定 | ❌ 未実装 | tracked_links に expires_at column なし |
| 配信 | リンククリック時アクション | ✅ 実装済 | tracked_links.tag_id + scenario_id で自動付与 |
| LINE | LINE メッセージ種類 | ⚠️ 部分実装 | テキスト/ボタン/画像/カルーセル/動画 ✅、 音声 ❌、 スタンプ ❌、 ファイル ❌ |
| LINE | LINE ログイン認証 | ✅ 実装済 | LIFF + LINE Login (entry_routes 連動) |
| LINE | LINE リッチメニュー (自動切替) | ✅ 実装済 | rich-menus.ts + segment-aware |
| LINE | LINE BAN 検知 / 切替 | ✅ 実装済 | routes/ban-recovery.ts + audit-failure-monitor cron + Discord alert |
| LINE | LINE メッセージ通数上限アラート | ❌ 未実装 | 月次 quota 監視なし、 broadcast-insights-fetch のみ |
| LINE | LINE カスタム送信者 | ❌ 未実装 | LINE OA の機能依存、 SDK で対応難 |
| LINE | LINE 配信エラー再送 | ❌ 未実装 | 失敗 log は audit_logs にあるが、 再送 UI なし |
| LINE | LINE 友だち移行 | ❌ 未実装 | CSV インポート未対応 |
| 会員サイト | コース / レッスン管理 | ❌ 未実装 | Phase 5ι 後検討 |
| 会員サイト | バンドル / 受講管理 | ❌ 未実装 | 同上 |
| 会員サイト | ログイン不要閲覧 | ❌ 未実装 | LIFF portal で part 的可能 |
| イベント・予約 | セミナー / 個別相談 | ⚠️ 部分実装 | calendar_bookings あり、 専用フロー未 |
| イベント・予約 | リマインダ配信 | ✅ 実装済 | reminders + reminder_steps |
| イベント・予約 | 参加者状況管理 | ⚠️ 部分実装 | calendar_bookings あり、 admin UI なし |
| イベント・予約 | Zoom / Google Meet 連携 | ❌ 未実装 | calendar_bookings の URL field のみ |
| イベント・予約 | Google スプレッドシート連携 | ❌ 未実装 | export 経由のみ |
| パートナー | パートナーサイト作成 | ⚠️ 部分実装 | routes/affiliates.ts + admin /affiliates (= 紹介 URL のみ) |
| パートナー | 報酬計算 / 振込 | ❌ 未実装 | affiliates は計測まで、 精算 UI なし |
| パートナー | ランキング表示 | ❌ 未実装 | 同上 |
| 管理 | AI アシスト | ✅ 実装済 | routes/conductor.ts + admin /conductor (= AI Conductor Phase 5γ 完成) |
| 管理 | メディア管理 (画像) | ✅ 実装済 | routes/images.ts + R2 |
| 管理 | 動画アップロード | ❌ 未実装 | Phase 5μ で予定 (= 公開後) |
| 管理 | 音声アップロード | ❌ 未実装 | 優先度低 |
| 管理 | Zapier 連携 | ❌ 未実装 | 外部 SaaS 依存、 OSS 公開後 検討 |
| 管理 | Webhook 送信 (outgoing) | ✅ 実装済 | routes/webhooks.ts + outgoing_webhooks |
| 管理 | 置き換え文字 (パーソナライズ) | ✅ 実装済 | expandVariables (webhook + step-delivery、 brand_config 連動) |

**カバー率 (U社 主要 ~40 抽出)**: ✅ 13 / ⚠️ 7 / ❌ 20 = **33% 実装 + 17% 部分** = 実用 ~50%

---

## 3. 全体 coverage 概算

| 区分 | 実装済 | 部分 | 未実装 | カバー率 |
|---|---|---|---|---|
| L社 20 機能 | 13 | 6 | 1 | **95%** (= 部分含む実用率) |
| U社 主要 40+ | 13 | 7 | 20 | **50%** (= 部分含む実用率) |
| **合計 60+** | **26** | **13** | **21** | **~65%** |

「目標 99.5%」 に対して、 現状 ~65% (= L 社中心を厚く、 U 社 EC/会員サイト系は薄い)。 ただし、 EXCLUDE 12 項目 (= ECforce / WooCommerce / 音声 / 占い等) + Coming Soon 1 (= 動画) を除外すれば、 実質目標達成可能項目は ~200 → 現状 ~130/200 = **65%**。

---

## 4. 隙間 — 高優先度 (= LP ローンチ直後の効果が大きい)

LP ローンチ後の自然流入 (= 友だち追加 / クリック / 開封) を効果的に活用するために、 以下の機能が **次セッション (= 1-3 ヶ月) で実装価値高い**:

### H1. **CSV インポート** (= L社機能 9 の半分、 friend マイグレーション)
- **why**: 既存 LINE OA から naturism public へ移行する顧客があった場合、 一括登録が必要
- **scope**: routes/csv-import.ts 新規 + admin /friends に「import」 ボタン + Zod validation
- **工数**: 2 日 / 1 PR
- **影響**: 既存 LINE OA 友だち取込 → 即マーケ施策へ転用可

### H2. **ファネル可視化 (= 5β-7)** (= L社機能 15、 U社ファネルマップ)
- **why**: 友だち追加 → クーポン受領 → 商品購入 → リピート の各ステップで離脱率を可視化、 LP/シナリオ最適化の基礎データ
- **scope**: routes/funnel-analytics.ts + funnel_events table (新 migration) + admin /funnel page
- **依存**: 実流入 (= friends 100+) で意味あるデータ
- **工数**: 5 日 / 2 PR
- **影響**: シナリオ改善 + LP CTA 改善の意思決定基盤

### H3. **1to1 チャット UI + スタッフ振分 (= 5α-5 + 5α-6)**
- **why**: 友だちからの個別質問対応 (= LP/SNS 流入後の問合せ対応の現場、 顧客満足度直結)
- **scope**: chats.ts route 拡張 + chat_assignments table + admin /chats UI 拡張
- **工数**: 7 日 / 2 PR
- **影響**: 顧客対応 SLA、 LTV 向上

### H4. **LINE 月次 quota 監視 + alert**
- **why**: LP 大流入時に LINE Free plan の月 1,000 通制限に当たる risk、 配信停止を未然に検知
- **scope**: routes/line-quota-monitor.ts (cron 5 分毎) + Discord alert + admin /broadcasts に残数表示
- **工数**: 2 日 / 1 PR
- **影響**: 大規模流入時の安定運用

### H5. **配信エラー再送 UI**
- **why**: LINE BAN / API 失敗で配信できなかったメッセージを admin から個別再送
- **scope**: messages_log の error 行を抽出 + admin /broadcasts に再送ボタン
- **工数**: 2 日 / 1 PR
- **影響**: 配信成功率向上

---

## 5. 隙間 — 中優先度 (= 3-6 ヶ月、 multi-brand 展開後)

### M1. **リンク期限設定 (tracked_links.expires_at)**
- **scope**: schema + 期限切れ時の click handler 修正
- **工数**: 1 日 / 1 PR

### M2. **パートナー (affiliate) 報酬計算 / 精算 UI**
- **why**: ambassador 制度の運用 (= ambassador_feedback / ambassador_surveys 既存だが、 報酬精算なし)
- **工数**: 5 日 / 2 PR

### M3. **イベント・予約 admin UI** (= calendar_bookings の管理画面)
- **scope**: admin /calendar-bookings + Zoom URL 自動生成連携
- **工数**: 3 日 / 1 PR

### M4. **カルーセルパネル admin 編集 UI 強化**
- **why**: 現状 template JSON 直編集、 ノーコード化で運用効率
- **工数**: 5 日 / 1 PR

### M5. **LINE 音声 / スタンプ / ファイル メッセージ送信 (Phase 5θ)**
- **scope**: line-sdk の追加 + admin /templates 拡張
- **工数**: 7 日 / 1 PR (= Phase 5θ で計画済)

---

## 6. 隙間 — 低優先度 (= 公開後 / OSS 後)

- 会員サイト系 (= Phase 5ι 後)
- スワイプ LP / ノーコードページビルダー (= U社独自、 競合差別化として戦略判断)
- Zapier 連携 (= 外部 SaaS 依存、 OSS 公開後 community 期待)
- 動画アップロード (= Phase 5μ、 公開後)
- Meta コンバージョン API (= conversions.ts 拡張、 広告運用時)
- Google スプレッドシート連携 (= 外部 SaaS 依存)

---

## 7. 次セッション着手推奨 PR (= LP ローンチ後 0-1 ヶ月で実装)

優先順:

1. **H4: LINE 月次 quota 監視** (= 2 日、 流入急増時の安定運用 fail-safe)
2. **H5: 配信エラー再送 UI** (= 2 日、 流入後の配信成功率向上)
3. **H1: CSV インポート** (= 2 日、 既存 OA からの migration 可能化)

合計 6 日 / 3 PR で **実流入対応の防御層を一気に厚くできる**。

その後、 流入データ蓄積 (= friends 100+ / clicks 1,000+) を待って:

4. **H2: ファネル可視化 (5β-7)** (= 5 日、 シナリオ改善の意思決定基盤)
5. **H3: 1to1 チャット UI** (= 7 日、 顧客対応 SLA + LTV)

---

## 8. Audit 注記

- 本 audit は spot check (= route + page 一覧 + 主要 schema 確認) ベース。 個別機能の動作完成度までは検証していない。
- 「⚠️ 部分実装」 は「core mechanism は動いているが UI / edge case 不足」 を意味する。
- `docs/COMPETITOR_FEATURES.md` 自体が 2024 年頃の snapshot で、 競合の新機能は反映されていない可能性。 OSS 公開前に再 audit 推奨。
- 「目標 99.5%」 は OSS 公開時の対外宣伝向け数値。 実用上は「core 60-70% + multi-brand plugin 化」 で十分競合と肩を並べる。

---

**作成者注 (Claude)**: 本 audit は autonomous 進行で作成。 個別機能の優先度判断は brand 戦略 / 市場状況で変動するため、 Katsu の判断で再優先度付け可能。
