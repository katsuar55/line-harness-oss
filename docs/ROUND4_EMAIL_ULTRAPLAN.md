# Round 4: メール配信連携 Ultraplan

**作成**: 2026-04-29 (v2 改訂)
**前提**: Phase 6 完了 / Phase 6 KPI レポート (`PHASE6_KPI_REPORT_2026-04-29.md`) で「friend ↔ Shopify customer の email マッチング 0 件」「LINE 友だち 1 名」が判明済み。**LINE 単一チャネルでは届かない 290+ 顧客がいる**ことが Round 4 の最大のドライバー。

> **改訂履歴**:
> - v1 (2026-04-29 06:00): 初版。8 PR / 6 日 / Resend+SendGrid abstraction
> - v2 (2026-04-29 07:30): 自己レビュー反映。provider abstraction 縮退 (Resend のみ) / migration 042 に source_order_id 等追加 / transactional vs marketing 分離 / EmailRenderer で footer 強制 / 工数 2 日 + DNS 1 週間に分離 / Round 4 PR-0 (users.email backfill) を依存ブロッカーとして明示

## ⚠ 依存ブロッカー (Round 4 着手前提)

**PR-0: users.email backfill の完了** (Phase 6 KPI P0 アクション #1 と同一作業)

Round 4 PR-6 の「LINE 配信不能時 email fallback」は `users.email` 経由で friend を引き当てる。現状 0 件のため、これを埋めるパスが先行して動いている必要がある。具体的には:

1. **LINE Developers Console で email scope の申請承認** (オーナー手動、審査 1〜2 営業日)
   - 現状コードは既に `'profile openid email'` を要求済 (`liff.ts:93`) で実装は完了。Console 承認のみ未完了。
2. **Shopify customers/create webhook 経路で users.email を back-fill するロジック追加** (Claude 0.5 日)
   - `shopify.ts:152` の friend マッチング後、見つかった friend の `users.email` が NULL なら Shopify customer の email で更新

両方完了 → Round 4 PR-1 着手可能。Round 4 全体は PR-0 が前提。

---

## 0. なぜ今メール配信か (motivation)

| 課題 (Phase 6 KPI 由来) | メール配信が解く理由 |
|---|---|
| Shopify customers 291 名 vs friends 1 名。LINE で届けられる相手が事実上 0 | Shopify 注文時点で email は確実に取れる → **メールなら 100% 到達母集団** |
| Phase 6 PR-2 (orders/create → enroll) が 0 件発火 | LINE friend が居なくても、email 経由で再購入リマインダーを送れる |
| BAN リスク (LINE OA 規約違反 1 回で全友だち失う) | メールは BAN リスクが構造的に低い → 災害時バックアップ |
| LINE では送れない長文 / リッチコンテンツ (例: 月次 AI 栄養レポート) | メールなら 5 分かけて読む長文も自然 |

**= LINE Harness を「LINE Only」から「LINE + Email のマルチチャネル CRM」に進化させる。**

---

## 1. スコープ境界 (yes / no)

### IN

- Transactional email (注文確認 / 配送通知 / 再購入リマインダー / 栄養レポート)
- Marketing email (broadcast / step delivery 並行)
- Bounce / complaint handling (送信評価維持)
- Unsubscribe (CAN-SPAM / 特定電子メール法準拠)
- 既存 templates / scenarios / broadcasts / automations をマルチチャネル化
- 開封率 / クリック率トラッキング
- LINE 配信失敗時の email fallback
- Phase 3/4 (栄養コーチ) の月次レポートの email 送信オプション

### OUT (Round 4 では扱わない)

- SMS (Round 4 後半 / Round 5)
- Instagram DM (Round 5)
- 物理配信 (LINE 経由 PDF など)
- 送信ドメインの新規取得 (既存 naturism ドメインを使う想定)
- 既存 LINE 配信ロジックのリファクタ (チャネル抽象化 layer のみ追加)

---

## 2. プロバイダ選定 (decision)

| | Resend (推奨) | SendGrid | AWS SES | MailChannels |
|---|---|---|---|---|
| 無料枠 | 3,000/月 + 100/日 (permanent) | 100/日 (permanent) | 200/日 (EC2 outside 62,000) | **❌ 2024-08 で CF 無料プラン廃止** |
| Cloudflare Workers DX | ◎ (`fetch` ベース、官方 SDK が Workers 対応) | ○ (REST OK) | △ (AWS Sigv4 を自前実装) | — |
| Bounce / Complaint | webhook → 1 endpoint で OK | webhook (event API) | SNS → SQS → 自前 polling | — |
| List-Unsubscribe-Post | サポート済み | サポート済み | DIY | — |
| DKIM 自動化 | DNS レコード 3 行貼るだけ | DNS 4 レコード | DNS 3 レコード + IAM 権限 | — |
| 価格 (>3,000/月) | $20/月 50k | $19.95/月 50k | $0.10/1k = $5/50k | — |
| 評判 | 新興 (2023〜) DX 重視 | 老舗、Twilio 傘下後やや停滞 | 安いが運用コスト高 | 旧定番、CF が公式に Resend 推奨へ移行 |

**MailChannels 補足**: 2024-08 以降 Cloudflare Workers ユーザー向けの無料プランは廃止。現在は有料プランのみで、Cloudflare 公式ドキュメントも Resend を第一推奨に変更している。本計画では選定から除外。

**Cloudflare Email Routing / Email Workers**: 受信専用 (inbound) なので送信用途ではないが、将来 `bounce@` `postmaster@` の受信処理に活用可能。Round 4 では OUT スコープ。

**結論: Resend を primary 採用。Provider abstraction (PR-3 の SendGrid 切替) は v2 で縮退**。

理由:
1. naturism のスケール (現状 300 顧客) では永遠に無料枠内
2. Cloudflare Workers との相性が最良 (`fetch` only、SDK バンドル可)
3. webhook 1 個で bounce/complaint/click 全部取れる (運用コスト低)
4. 仮に将来 50k/月を超えたら SES に出す逃げ道もある (interface だけ用意)

**v2 改訂: SendGrid 実装は YAGNI として削除**。
- v1 では PR-1 で `EmailProvider` interface + Resend + SendGrid 二実装、PR-3 の Dispatcher で切替を計画していたが、現スケールでは過剰設計 (テスト 15 件分のメンテ負債)。
- v2 では PR-1 で `interface EmailProvider` + `class ResendClient` のみ作り、SendGrid 実装は **障害発生 or 50k 通超え時のトリガで起こす Issue** として `BACKLOG.md` に残す。
- これにより PR-1 が 0.5 日 → 0.3 日に短縮、テスト件数 15 → 8。

---

## 3. アーキテクチャ全体図

```
                  ┌────────────────────────────────────┐
                  │  既存: LINE 配信パイプライン          │
                  │  scenarios / broadcasts / automations│
                  └──────────────┬─────────────────────┘
                                 │
                  ┌──────────────▼─────────────────────┐
                  │  NEW: ChannelDispatcher (PR-3)      │
                  │  入: friend, payload                │
                  │  出: { channel, providerSendId }    │
                  └─┬────────────────────────────────┬──┘
                    │                                │
            ┌───────▼─────────┐               ┌──────▼─────────┐
            │  LINE channel   │               │ Email channel  │
            │ (既存 LineClient)│               │ (NEW Resend)   │
            └─────────────────┘               └─┬──────────────┘
                                                │
                                  ┌─────────────▼──────────────┐
                                  │ Resend API                  │
                                  └─┬───────────────────────┬───┘
                                    │ delivery webhook       │ click/open
                                    │                        │
                              ┌─────▼─────────────┐    ┌────▼────────────┐
                              │ /api/integrations/ │    │ email_events DB │
                              │ resend/webhook     │    │ (PR-2)          │
                              └─────────────────────┘   └─────────────────┘
```

設計ポリシー:
- **既存 LINE 配信を壊さない。** ChannelDispatcher は LINE の場合は既存パイプラインを呼ぶだけ。
- **Provider 切替可能にする** (`emailProvider: 'resend' | 'sendgrid'`)。 環境変数で切替、コード変更不要。
- **両チャネル送信は automations 側で同時 schedule する** (broadcast の DM と email を 1 回の操作で両方出す)。

---

## 4. データモデル (新 migration)

### 責務マトリクス (v2 で追加)

| カラム / テーブル | 役割 | 権威ソース | ライフサイクル |
|---|---|---|---|
| `friends.email` | LINE 友だち本人の連絡先 (identity) | LIFF Login の id_token | LINE friend と一蓮托生 |
| `email_subscribers.email` | メール配信権利 + 状態 (subscription state) | Shopify checkout の opt-in / 手動 import | LINE friend と独立 |
| `email_subscribers.friend_id` | 任意の関連付け (LINE 友だちでもある場合の連結) | nullable | friend 削除時 SET NULL (subscriber は残す) |

**同期ルール** (PR-6 で実装):
- LIFF login で friend が作られた直後、その email がまだ `email_subscribers` に無ければ upsert (consent_source='liff_signup')
- Shopify customers/create webhook で friend マッチング後、その friend.user.email が NULL なら Shopify email を back-fill。**ただし `email_marketing_consent.state='subscribed'` の場合のみ** `email_subscribers` 側にも upsert (consent_source='shopify_checkout')

両者を分離する理由: Shopify 顧客 290 名のうち LINE 友だち化していない人にも送りたい (Round 4 の核心)。`friends` テーブルに合流させると LINE 友だちでない人をどう持つか不明瞭になる。

### 042_email_channel.sql (新規)

```sql
-- email 配信先 (friend と独立にも管理可能)
-- 既存 friends.email にも依存するが、subscriber list を別途持ちたいケースに対応
CREATE TABLE IF NOT EXISTS email_subscribers (
  id                 TEXT PRIMARY KEY,
  friend_id          TEXT REFERENCES friends(id) ON DELETE SET NULL,  -- LINE 友だち未登録でも可
  email              TEXT NOT NULL,
  is_active          INTEGER NOT NULL DEFAULT 1,        -- marketing 配信可否のメインフラグ
  transactional_only INTEGER NOT NULL DEFAULT 0,        -- 1 = transactional (注文確認等) のみ送信。配信停止しても 0 にはしない
  unsubscribed_at    TEXT,
  bounce_count       INTEGER NOT NULL DEFAULT 0,        -- 3 で auto-suppress (is_active=0)
  complaint_count    INTEGER NOT NULL DEFAULT 0,        -- 1 で auto-suppress (法令準拠)
  consent_source     TEXT,                              -- 'shopify_checkout'|'liff_signup'|'manual_import'|'opt_in_form'
  consent_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE UNIQUE INDEX idx_email_subscribers_email ON email_subscribers(email);
CREATE INDEX idx_email_subscribers_active ON email_subscribers(is_active, unsubscribed_at);
CREATE INDEX idx_email_subscribers_friend ON email_subscribers(friend_id);

-- 配信ログ (LINE messages_log と並列)
CREATE TABLE IF NOT EXISTS email_messages_log (
  id                  TEXT PRIMARY KEY,
  subscriber_id       TEXT NOT NULL REFERENCES email_subscribers(id),
  template_id         TEXT REFERENCES email_templates(id),
  broadcast_id        TEXT REFERENCES broadcasts(id),
  scenario_step_id    TEXT REFERENCES scenario_steps(id),
  -- v2 追加: Phase 6 連携で「どの注文起点か」を遡るために必須
  source_order_id     TEXT REFERENCES shopify_orders(id) ON DELETE SET NULL,
  source_kind         TEXT NOT NULL DEFAULT 'manual',   -- 'reorder'|'cross_sell'|'broadcast'|'transactional'|'manual'
  category            TEXT NOT NULL DEFAULT 'marketing', -- 'transactional'|'marketing' (法令上の区別)
  subject             TEXT NOT NULL,
  from_address        TEXT NOT NULL,
  reply_to            TEXT,
  -- provider 情報
  provider            TEXT NOT NULL,                  -- 'resend'|'sendgrid'
  provider_message_id TEXT,                            -- webhook で照合に使う
  -- 状態
  status              TEXT NOT NULL DEFAULT 'queued',  -- queued|sent|delivered|opened|clicked|bounced|complained|failed
  error_summary       TEXT,
  sent_at             TEXT,
  delivered_at        TEXT,
  first_opened_at     TEXT,
  last_event_at       TEXT,
  open_count          INTEGER NOT NULL DEFAULT 0,
  click_count         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX idx_email_log_subscriber ON email_messages_log(subscriber_id);
CREATE INDEX idx_email_log_provider ON email_messages_log(provider, provider_message_id);
CREATE INDEX idx_email_log_broadcast ON email_messages_log(broadcast_id);
CREATE INDEX idx_email_log_source_order ON email_messages_log(source_order_id);
CREATE INDEX idx_email_log_source_kind ON email_messages_log(source_kind, status);

-- click tracking
CREATE TABLE IF NOT EXISTS email_link_clicks (
  id            TEXT PRIMARY KEY,
  email_log_id  TEXT NOT NULL REFERENCES email_messages_log(id),
  url           TEXT NOT NULL,
  clicked_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  user_agent    TEXT,
  ip_hash       TEXT  -- IP は Hash 化して保存 (個人情報最小化)
);
CREATE INDEX idx_email_clicks_log ON email_link_clicks(email_log_id);

-- templates の拡張: 既存 templates テーブルに email 系列を入れず、別テーブルで持つ
-- (text/flex/etc. と排他的に使うのが自然なため)
CREATE TABLE IF NOT EXISTS email_templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'general',  -- 'transactional'|'marketing'|'reorder'|'coach_report'
  subject       TEXT NOT NULL,                    -- {{name}} placeholder 対応
  html_content  TEXT NOT NULL,                    -- minified, with {{vars}}
  text_content  TEXT NOT NULL,                    -- plaintext fallback (multipart 必須)
  preheader     TEXT,                             -- inbox preview text
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX idx_email_templates_category ON email_templates(category);
```

### 既存テーブルへの拡張 (additive only)

- `broadcasts.channel` (TEXT DEFAULT 'line', allowed: 'line'|'email'|'both')
- `scenario_steps.channel` (同上)
- `subscription_reminders.email_fallback_enabled` (INTEGER DEFAULT 0) — Phase 6 連携で重要
- `automations.actions` の JSON に `{ "type": "send_email", "templateId": "..." }` を許可 (schema 変更不要、ロジック追加のみ)

---

## 5. 機能 PR 分割 (8 本)

### PR-1: Resend クライアント + EmailRenderer + 送信プリミティブ (v2 縮退)
- `packages/email-sdk/` 新パッケージ (workspace 名 `@line-crm/email-sdk`)
  - `interface EmailProvider { send(req: EmailMessage): Promise<EmailResult> }` ← 型レイヤだけ用意
  - `class ResendClient implements EmailProvider` (唯一の実装、v2)
  - **SendGrid 実装は v2 では作らない。** 障害発生 or 50k 通超え時に Issue を切って後付け
  - Zod schema: `EmailMessage = { to, from, subject, html, text, replyTo?, headers?, tags?, category, sourceOrderId?, sourceKind }`
  - **`class EmailRenderer`**: テンプレ HTML/text に対し以下を**強制注入**
    - 法定情報フッター (社名・住所・連絡先 / 配信停止リンク) — `EMAIL_LEGAL_FOOTER_HTML` env var から取得
    - List-Unsubscribe ヘッダ (HMAC token 付き解除 URL)
    - これによりテンプレ作成者がフッター省略する事故を構造的に防ぐ
- 単体テスト: 8 件 (Resend client 4 + EmailRenderer 4)
- secret: `RESEND_API_KEY`
- env vars: `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_LEGAL_FOOTER_HTML`, `EMAIL_LEGAL_FOOTER_TEXT`, `EMAIL_UNSUBSCRIBE_HMAC_KEY`

### PR-2: D1 migration 042 + email_subscribers / email_messages_log CRUD
- migration ファイル (上記 schema)
- `packages/db/src/email-subscribers.ts`: CRUD + opt-out バルク処理
- `packages/db/src/email-logs.ts`: insert/update by provider_message_id
- vitest: 25 件目標 (subscribe, unsubscribe, bounce limit, complaint suppress, log update)

### PR-3: ChannelDispatcher (channel abstraction layer)
- `apps/worker/src/services/channel-dispatcher.ts`:
  - input: `{ recipient: { friendId?, email? }, channel: 'line'|'email'|'both', payload, category }`
  - 出: 各 channel に既存 service を呼ぶ
  - 法令準拠: `category='marketing'` の場合は `email_subscribers.is_active=1 AND unsubscribed_at IS NULL` でゲート、`category='transactional'` は `transactional_only=0 OR is_active=1` (= 配信停止しても transactional は届く)

#### 抽象化の 3 層 (v2 で明示)

```
ChannelDispatcher          ← LINE / email / both の振り分け (関心事: ユーザーへのリーチ)
  ↓
EmailChannelHandler        ← email 固有: subscriber lookup / consent gate / template render
  ↓
EmailProvider (Resend)     ← provider 固有: HTTP 通信 / fetch / レスポンス整形
```

`EmailProvider` (provider 抽象化) と `ChannelDispatcher` (channel 抽象化) は **直交した関心事**。両方必要。

#### 既存 call-site 改修一覧 (v2 で追加)

| call-site | 現状 | v2 後 |
|---|---|---|
| `subscription-reminder.ts:processSubscriptionReminders` | LINE 直送のみ | **dispatcher 経由化必須**: LINE 配信不可 (BAN/blocked) なら email fallback |
| `event-bus.ts` の `send_message` action handler | LINE 直送 | dispatcher 経由化 (action JSON で channel 指定可能に) |
| `services/broadcast.ts` (`processScheduledBroadcasts`) | LINE のみ | broadcast.channel='email'|'both' なら dispatcher |
| `scenarios/runStep` (`step-delivery.ts`) | LINE のみ | scenario_steps.channel が 'email' なら dispatcher |
| `automations` の `send_message` | LINE のみ | dispatcher 経由 |

LINE 専用 path は **disabler 機能 (BAN 検出時 skip)** を持つので、dispatcher 統合時はその挙動を email fallback で補強する。

- vitest 12 件 (LINE のみ / email のみ / 両方 / friend なし email のみ / consent ゲート 2 種 / etc.)

### PR-4: Resend webhook 受信 + bounce/complaint 自動 suppress
- `apps/worker/src/routes/integrations-resend.ts`:
  - POST /api/integrations/resend/webhook
  - Svix 署名検証 (Resend は Svix 経由で署名)
  - イベント: delivered / bounced / complained / opened / clicked
- bounce 3 回 or complaint 1 回 で `email_subscribers.is_active=0` 自動 OFF
- `email_messages_log.status` 更新 + open_count/click_count インクリメント
- vitest 18 件
- secret: `RESEND_WEBHOOK_SECRET`

### PR-5: Unsubscribe フロー (法令準拠)
- LIFF と独立した静的 HTML ページ `/email/unsubscribe?token=...`
  - ワンクリック解除 (List-Unsubscribe ヘッダ + List-Unsubscribe-Post POST URL も対応)
  - 解除後 `email_subscribers.unsubscribed_at = now`
- token は HMAC: `sha256(subscriber_id + secret)` で改ざん検知
- 全送信メールに `List-Unsubscribe: <https://.../email/unsubscribe?token=...>` ヘッダ自動付与
- 全 HTML テンプレ末尾に「配信停止はこちら」リンク必須化 (テンプレ保存時に validation)
- 特定電子メール法 Article 4 準拠 (送信者情報・解除方法明示)

### PR-6: 既存 LINE 配信に email fallback / parallel 送信を統合
- `subscription_reminders` 配信時:
  - LINE が `is_active=0`/BAN なら email へ自動切替 (`email_fallback_enabled=1` の場合)
  - 両方有効なら LINE 優先 (UX 上 LINE のほうが開封率が高いため)
- `broadcasts.channel='both'` なら LINE + email 同時 schedule
- `automations` の action に `send_email` 追加
- vitest 14 件 (Phase 6 PR-2 のテストパターンを email チャネルにも展開)

### PR-7: 管理画面 (`/email` ページ群) + admin API
- Worker `/api/admin/email/*`:
  - GET subscribers (filter: active/unsub/bounced)
  - POST opt-in 手動 / CSV import
  - POST template CRUD
  - GET KPI summary (送信数 / 開封率 / クリック率 / 配信停止率 / バウンス率 — 期間絞り込み)
- Next.js `/email` ページ (既存 sidebar に「✉️ メール」追加):
  - 購読者一覧 / インポート / テンプレ編集 (HTML エディタは textarea + プレビュー iframe)
  - KPI ダッシュ (Chart.js, 7/30/90 日)
  - 配信履歴 + 個別開封ステータス
- E2E (Playwright) 4 本

### PR-8: ドメイン認証 + 本番 deploy + smoke runbook
- naturism ドメインに DKIM / SPF / DMARC 設定 (Cloudflare DNS)
- DMARC は最初 `p=none` で 1 週間観測 → `p=quarantine` → `p=reject` 段階移行
- スモーク手順書 (`docs/EMAIL_RUNBOOK.md`):
  - 送信テスト 3 種 (Gmail / iCloud / Yahoo) で受信確認
  - bounce 受信テスト (存在しないアドレスへ送る)
  - 解除リンク動作確認
  - DMARC レポート受信確認 (`postmaster@naturism.example` を作る)
- Phase 6 のように pre-deploy preflight (`pnpm preflight`) に email 系チェック追加:
  - DKIM レコードが DNS にあるか
  - REQUIRED_SECRETS に RESEND_API_KEY が登録済か
  - email_subscribers テーブル存在確認

---

## 6. 既存システムとの統合詳細

### Phase 6 (再購入リマインダー) との連携

`processSubscriptionReminders` の改修:
1. 対象 friend が `email_subscribers.is_active=1` を持つか確認
2. friend.line_user_id が BAN/blocked なら → email のみ送信
3. 通常時は両方送信 (broadcast.channel='both' 同様の挙動)
4. cross-sell も email HTML 版を用意 (`email_templates.category='reorder'`)

### Phase 4 (栄養コーチ) との連携

月次レポートを email 配信オプションに:
- `nutrition_recommendations` の last reco を月次 email で要約配信
- LINE で見ない人にも届く → 栄養コーチ機能の到達率改善

### Shopify との連携

- `customers/create` webhook で自動 opt-in (consent_source='shopify_checkout')
- 特定電子メール法 Article 3 (オプトイン原則) に注意:
  - **marketing 同意は明示的に**: Shopify チェックアウト画面の「キャンペーン情報を受け取る」チェックボックスがある時のみ marketing 配信 opt-in
  - その情報は Shopify の `email_marketing_consent.state='subscribed'` に入る → これを参照
  - 実装: `customers/create` で `email_marketing_consent.state` を確認:
    - `subscribed` → `email_subscribers.is_active=1, transactional_only=0`
    - それ以外 → `email_subscribers.is_active=0, transactional_only=1` (注文確認等は送れる)
- **transactional vs marketing の区別** (v2 で明示):
  - transactional: 注文確認 / 配送通知 / 領収書 → 同意不要で送信可 (= 取引上当然の連絡)
  - marketing: ニュースレター / 再購入リマインダー / クロスセル → 同意必須
  - reorder reminder は marketing 寄りなのでオプトイン者のみ送信
  - cross-sell push も同様

---

## 7. テスト戦略

| レイヤー | 件数目標 | カバー対象 |
|---|---|---|
| 単体 (vitest) | +90 件 | provider clients / dispatcher / webhook handlers / DB CRUD / unsub token 生成検証 |
| 統合 | +15 件 | broadcast email / scenario step email / Phase 6 fallback |
| E2E (Playwright) | 4 件 | template 編集 / subscriber import / KPI ダッシュ / 解除フロー |
| 手動 (smoke) | 3 件 | Gmail / iCloud / Yahoo 受信確認 |

合計 **+109 worker tests** (現 1315 → 1424) を目標。

### テストデータ戦略

- 送信は **モック** が原則。実 Resend API を叩くのは PR-8 のスモークだけ。
- bounce/complaint は webhook payload を fixture 化して入れる。

---

## 8. リスク登録簿

| 重要度 | リスク | 対策 |
|---|---|---|
| **High** | DMARC reject による Gmail 届かず | PR-8 で `p=none` から段階導入、DMARC レポート購読 |
| **High** | 不正 opt-in による特定電子メール法違反 | Shopify の `email_marketing_consent.state` を必須参照、手動 import は consent_source 必須 |
| **Med** | bounce 率が高くドメイン信用低下 | 3 回 bounce で auto-suppress、月次で衛生クリーニング |
| **Med** | Resend 障害時に全停止 | PR-3 の provider 抽象化で SendGrid に環境変数 1 つで切替 |
| **Med** | 解除リンク token 偽造による他人の解除 | HMAC token + DB lookup の二段認証 |
| **Low** | 開封率トラッキング (1px gif) のプライバシー懸念 | Apple Mail 16+ がプリフェッチで 100% 偽陽性化 → クリック率を主指標にする |
| **Low** | 4-7-3 日問題 (LINE Harness OSS 配布版で他者がメール送信に使うと naturism ドメインからの大量配信になる) | OSS 側は provider abstraction のみ提供、ドメイン設定は各運用者責任 |

---

## 9. 成功指標 (KPI)

PR-8 完了から 30 日後に評価:

| 指標 | 目標 | 計測 SQL |
|---|---|---|
| email_subscribers 数 | 200+ | `COUNT(*) WHERE is_active=1` |
| 配信成功率 | 95%+ | `delivered / sent` (bounce/failed 除外) |
| 開封率 (transactional) | 40%+ | `first_opened_at IS NOT NULL / delivered` |
| 開封率 (marketing) | 20%+ | 同上、category='marketing' |
| クリック率 | 5%+ | `click_count > 0 / delivered` |
| 解除率 | <0.5% / 配信 | `unsubscribed in window / sent in window` |
| Phase 6 reminder の email fallback 発火数 | LINE 配信不能時の 80%+ | `email_messages_log` で template='reorder' の件数 |

---

## 10. ロードマップ / 工数見積もり (v2 改訂)

### 工数を 2 軸で分離

| | Claude 実装軸 | DNS / 認証 / 段階移行軸 |
|---|---|---|
| 性質 | コード書き換え + テスト | DNS 反映待ち + Gmail/iCloud/Yahoo 評判蓄積 |
| 圧縮可能 | YES (並列実行で短縮) | NO (物理的待機時間) |

### Claude 実装軸 (v2 縮退反映)

| PR | 工数 | 依存 |
|---|---|---|
| **PR-0 (users.email backfill)** | 0.5 日 | LINE Console email scope 申請承認 (オーナー) |
| PR-1 (Resend SDK + EmailRenderer) | 0.3 日 (provider abstraction 縮退) | — |
| PR-2 (DB / migration 042) | 0.4 日 (列追加分やや増) | — |
| PR-3 (ChannelDispatcher) | 0.5 日 | PR-1, PR-2 |
| PR-4 (Resend webhook + bounce 制御) | 0.7 日 | PR-2 |
| PR-5 (unsubscribe + List-Unsubscribe-Post) | 0.4 日 | PR-2 |
| PR-6 (既存統合 5 call-site 改修) | 1 日 | PR-0, PR-3, PR-5 |
| PR-7 (管理画面) | 1 日 | PR-2, PR-3, PR-4 |
| **合計 (Claude 実装のみ)** | **約 4.8 日 (並列化で 2-2.5 日)** | |

並列化計画:
- PR-0/PR-1/PR-2 を並列着手 (1 日)
- PR-3/PR-4/PR-5 を並列 (1 日)
- PR-6/PR-7 を並列 (1 日)
- 合計 **3 日で実装完了可能**

### DNS / 段階移行軸 (オーナー作業 + 物理時間)

| ステップ | 期間 | 担当 |
|---|---|---|
| 1. Resend アカウント開設 + ドメイン追加 | 1 日 | オーナー |
| 2. DNS レコード反映 (DKIM/SPF/DMARC `p=none`) | 1 日 (TTL 待ち) | オーナー DNS 操作 |
| 3. テスト送信 + 受信確認 (Gmail/iCloud/Yahoo) | 1 日 | Claude smoke test |
| 4. DMARC レポート 1 週間観測 | 7 日 | 自然待機 |
| 5. DMARC `p=quarantine` 段階移行 | 7 日観測 | Claude DNS 更新 |
| 6. DMARC `p=reject` 本番移行 | — | Claude DNS 更新 |
| **合計 (DNS 軸)** | **約 17 日 (実質オーナー作業 2 日 + 物理待機 15 日)** | |

### 全体スケジュール

実装完了から本格 marketing 配信可能 (DMARC reject) まで **約 3 週間**。ただし transactional 配信は DMARC `p=none` 以降であれば送信可能 (= 実装完了 + 2-3 日後)。

---

## 11. 承認待ちアイテム (v2 で分類整理)

### 11A. オーナーのみ判断可能 (必須事前承認)

1. **送信ドメイン**: `naturism.example` の subdomain (`mail.naturism.example`) を切るか / ルートで送るか
   - DNS 操作権限とブランド方針が絡むためオーナー判断
4. **Resend account 開設**: オーナーアカウント or 共有アカウントか / 課金主体
6. **CRM PLUS との重複配信**: もし使用中なら、メール配信は LINE Harness 側で一元化するか / CRM PLUS と並列稼働するか
7. **LINE Developers Console での email scope 申請** (PR-0 のための手動オペレーション、審査 1〜2 営業日)

### 11B. Claude が default 提案可能 (確認のみ依頼)

2. **From アドレス**: 推奨 `noreply@<送信ドメイン>` (返信不要のため)。サポート問い合わせ用に Reply-To で別アドレス指定
3. **Reply-To**: 推奨 `support@<送信ドメイン>` (= naturism のサポート窓口)
5. **送信者表記** (特定電子メール法準拠): CLAUDE.md 記載の **株式会社ケンコーエクスプレス** をテンプレフッターに自動挿入。住所・連絡先は会社情報を Claude が text に整形
   - PR-1 の `EmailRenderer` で `EMAIL_LEGAL_FOOTER_HTML` env var を強制注入する設計に既に組み込み済み

= オーナー必須は 4 件 (1, 4, 6, 7)、それ以外 (2, 3, 5) は Claude default で進められる。

---

## 12. Round 4 全体の中での位置づけ

PROGRESS.md の Round 4 リスト:
1. **メール配信連携 (SendGrid/SES)** ← 本 Ultraplan が対象
2. SMS連携
3. Instagram DM連携
4. LTV予測・チャーン予測
5. ポイントシステム
6. 抽選/くじ機能
7. ファネルビルダー (LIFF + CF Pages)

Email を最優先にする理由は §0 の通り (LINE 単一チャネル限界 / 290+ 顧客が届かない)。Email 完成 → SMS / Instagram は同じ ChannelDispatcher パターンで横展開可能。**つまり Round 4 PR-1 (本計画) は Round 4 全体のアーキテクチャを決める下地**。

---

## 13. 次のアクション (v2 改訂)

1. **オーナー**: §11A (4 件) を確認し回答
   - 特に **#7 LINE Console の email scope 申請** は審査 1〜2 営業日かかるため最優先
2. **Claude (並列着手可能)**:
   - PR-0: users.email backfill ロジック追加 (Shopify webhook 経由) — オーナー回答待ちなしで先行可
   - PR-1, PR-2 を並列で実装
3. オーナー §11A 回答取得後、PR-3〜PR-7 を 3 並列で進める
4. DNS 軸 (§10) は Claude 実装完了とは独立に進行 (オーナー作業 + 物理待機 15 日)
5. PR-8 (DMARC `p=reject`) 完了から 30 日 / 90 日のタイミングで KPI 計測 → 必要なら Round 4-2 (SMS) 着手

---

**完**
