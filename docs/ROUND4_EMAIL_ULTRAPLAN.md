# Round 4: メール配信連携 Ultraplan

**作成**: 2026-04-29
**前提**: Phase 6 完了 / Phase 6 KPI レポート (`PHASE6_KPI_REPORT_2026-04-29.md`) で「friend ↔ Shopify customer の email マッチング 0 件」「LINE 友だち 1 名」が判明済み。**LINE 単一チャネルでは届かない 290+ 顧客がいる**ことが Round 4 の最大のドライバー。

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

| | Resend (推奨) | SendGrid | AWS SES |
|---|---|---|---|
| 無料枠 | 3,000/月 + 100/日 (permanent) | 100/日 (permanent) | 200/日 (EC2 outside 62,000) |
| Cloudflare Workers DX | ◎ (`fetch` ベース、官方 SDK が Workers 対応) | ○ (REST OK) | △ (AWS Sigv4 を自前実装) |
| Bounce / Complaint | webhook → 1 endpoint で OK | webhook (event API) | SNS → SQS → 自前 polling |
| List-Unsubscribe-Post | サポート済み | サポート済み | DIY |
| DKIM 自動化 | DNS レコード 3 行貼るだけ | DNS 4 レコード | DNS 3 レコード + IAM 権限 |
| 価格 (>3,000/月) | $20/月 50k | $19.95/月 50k | $0.10/1k = $5/50k |
| 評判 | 新興 (2023〜) DX 重視 | 老舗、Twilio 傘下後やや停滞 | 安いが運用コスト高 |

**結論: Resend を primary 採用。** 理由:
1. naturism のスケール (現状 300 顧客) では永遠に無料枠内
2. Cloudflare Workers との相性が最良 (`fetch` only、SDK バンドル可)
3. webhook 1 個で bounce/complaint/click 全部取れる (運用コスト低)
4. 仮に将来 50k/月を超えたら SES に出す逃げ道もある (provider 抽象化を導入する)

**バックアップ: SendGrid を Resend 障害時の fallback として provider 抽象化レイヤで切り替え可能にする** (PR-3 で実装)。

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

### 042_email_channel.sql (新規)

```sql
-- email 配信先 (friend と独立にも管理可能)
-- 既存 friends.email にも依存するが、subscriber list を別途持ちたいケースに対応
CREATE TABLE IF NOT EXISTS email_subscribers (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT REFERENCES friends(id) ON DELETE SET NULL,  -- LINE 友だち未登録でも可
  email           TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  unsubscribed_at TEXT,
  bounce_count    INTEGER NOT NULL DEFAULT 0,    -- 3 で auto-suppress
  complaint_count INTEGER NOT NULL DEFAULT 0,    -- 1 で auto-suppress (法令準拠)
  consent_source  TEXT,                          -- 'shopify_order'|'liff_form'|'manual_import'|'opt_in_form'
  consent_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE UNIQUE INDEX idx_email_subscribers_email ON email_subscribers(email);
CREATE INDEX idx_email_subscribers_active ON email_subscribers(is_active, unsubscribed_at);
CREATE INDEX idx_email_subscribers_friend ON email_subscribers(friend_id);

-- 配信ログ (LINE messages_log と並列)
CREATE TABLE IF NOT EXISTS email_messages_log (
  id                  TEXT PRIMARY KEY,
  subscriber_id       TEXT NOT NULL REFERENCES email_subscribers(id),
  template_id         TEXT REFERENCES templates(id),
  broadcast_id        TEXT REFERENCES broadcasts(id),
  scenario_step_id    TEXT REFERENCES scenario_steps(id),
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

### PR-1: Resend クライアント + 送信プリミティブ
- `packages/email-sdk/` 新パッケージ (workspace 名 `@line-crm/email-sdk`)
  - `class ResendClient { send(req): Promise<{id}> }`
  - `class SendGridClient { send(req): Promise<{id}> }` (provider 抽象化用)
  - `interface EmailProvider { send(req: EmailMessage): Promise<EmailResult> }`
  - Zod schema: `EmailMessage = { to, from, subject, html, text, replyTo?, headers?, tags? }`
- 単体テスト: モック fetch で provider ごと 5 件、合計 15 件
- secret: `RESEND_API_KEY`, `SENDGRID_API_KEY` (optional)
- env vars: `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_PROVIDER` (default 'resend')

### PR-2: D1 migration 042 + email_subscribers / email_messages_log CRUD
- migration ファイル (上記 schema)
- `packages/db/src/email-subscribers.ts`: CRUD + opt-out バルク処理
- `packages/db/src/email-logs.ts`: insert/update by provider_message_id
- vitest: 25 件目標 (subscribe, unsubscribe, bounce limit, complaint suppress, log update)

### PR-3: ChannelDispatcher (channel abstraction layer)
- `apps/worker/src/services/channel-dispatcher.ts`:
  - input: `{ recipient: { friendId?, email? }, channel: 'line'|'email'|'both', payload }`
  - 出: 各 channel に既存 service を呼ぶ
- 既存呼び出しを変えない (LINE 専用の処理は LINE 専用 path)。新フローのみ dispatcher を経由
- vitest 12 件 (LINE のみ / email のみ / 両方 / friend なし email のみ / etc.)

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

- `customers/create` webhook で自動 opt-in (consent_source='shopify_order')
- ただし 特定電子メール法 Article 3 (オプトイン原則) に注意:
  - **同意取得は明示的に**: Shopify チェックアウト画面の「キャンペーン情報を受け取る」チェックボックスがある時のみ opt-in
  - その情報は Shopify の `email_marketing_consent.state='subscribed'` に入る → これを参照
  - 実装: `customers/create` で `email_marketing_consent.state` を確認し、`subscribed` でない場合は opt-in しない

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

## 10. ロードマップ / 工数見積もり

| PR | 工数 (Claude 自律) | 依存 |
|---|---|---|
| PR-1 (Resend SDK) | 0.5 日 | — |
| PR-2 (DB / migration) | 0.5 日 | — |
| PR-3 (Dispatcher) | 0.5 日 | PR-1, PR-2 |
| PR-4 (webhook + bounce 制御) | 1 日 | PR-2 |
| PR-5 (unsubscribe) | 0.5 日 | PR-2 |
| PR-6 (既存統合) | 1 日 | PR-3, PR-5 |
| PR-7 (管理画面) | 1.5 日 | PR-2, PR-3, PR-4 |
| PR-8 (DNS + deploy + runbook) | 0.5 日 (オーナー DNS 作業 0.5 日) | PR-1〜7 全部 |
| **合計** | **約 6 日** (うち最終 0.5 日はオーナー DNS 作業) | |

並列化すれば 4 日まで圧縮可能 (PR-1/2 並列、PR-3 後 PR-4/5/6 並列)。

---

## 11. 承認待ちアイテム (オーナー判断必須)

PR-8 直前に以下を確認:

1. **送信ドメイン**: `naturism.example` の subdomain (`mail.naturism.example`) を切るか / ルートで送るか
2. **From アドレス**: `info@naturism.example` か `noreply@naturism.example` か (返信不要なら後者)
3. **Reply-To**: カスタマーサポート用に手動運用するメアド
4. **Resend account 開設**: オーナーアカウント or 共有アカウントか
5. **特定電子メール法上の送信者表記**: 株式会社ケンコーエクスプレスの社名・住所・連絡先をテンプレフッターに自動挿入
6. **CRM PLUS との重複配信**: もし使用中なら、メール配信は LINE Harness 側で一元化するか / CRM PLUS と並列稼働するか

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

## 13. 次のアクション

1. オーナー: §11 の 6 項目を確認し回答
2. 承認後 Claude: PR-1 着手 (Resend SDK + provider abstraction)
3. PR ごとに pnpm preflight + 全 worker tests green を確認しながら順次 deploy
4. PR-8 完了から 30 日 / 90 日のタイミングで KPI 計測 → 必要なら Round 4-2 (SMS) 着手

---

**完**
