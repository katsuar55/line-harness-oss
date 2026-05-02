# Email Runbook (Round 4 PR-8)

**作成**: 2026-04-30
**対象**: line-harness-oss / naturism (株式会社ケンコーエクスプレス)
**前提読み物**:
- `docs/ROUND4_EMAIL_ULTRAPLAN.md` §5 PR-8 / §11
- `CLAUDE.md` 「デプロイルール (案 A: 全権限委譲)」
- `apps/worker/wrangler.toml` (env vars)

---

## 1. 概要

このドキュメントは Round 4 (Email channel) の **本番投入直前に必ず一読する** 運用 runbook。

### 何が書いてあるか

1. 事前準備チェックリスト (オーナー側 + Claude 側)
2. 本番投入前の smoke test (Gmail / iCloud / Yahoo の 3 ISP 配信確認)
3. bounce / complaint のテスト手順
4. 配信停止リンク動作確認
5. DMARC レポート受信確認
6. DMARC `p=none` → `quarantine` → `reject` の段階移行判定
7. 障害時の rollback 手順
8. 法令準拠チェックリスト (特定電子メール法 / GDPR / CAN-SPAM)
9. KPI モニタリング (admin UI 完成までは SQL で観測)

### いつ参照するか

| シーン | 該当セクション |
|---|---|
| 初回 deploy 直前 | §2, §3, §4, §5 |
| Resend webhook が動かない | §4, §7 |
| 配信が届かない / Spam 行き | §3 (DKIM/SPF/DMARC verdict 確認), §6 |
| 大量送信ループ等の事故 | §7 |
| 月次の KPI レビュー | §10 |
| 法務 / 監査対応 | §9 |

### 用語

- **Resend**: 送信プロバイダ (resend.com)。本プロジェクトの primary provider
- **DKIM**: 送信ドメインの公開鍵署名。Resend が自動発行
- **SPF**: 送信元 IP の許可リスト。Resend の include を指定
- **DMARC**: DKIM/SPF が両方 fail した時の処理ポリシー
- **transactional**: 取引メール (注文確認等)。同意不要
- **marketing**: 販促メール (再購入リマインダー等)。明示同意必須

---

## 2. 事前準備チェックリスト

### 2-A. オーナー作業 (Claude では完結できない)

- [ ] **LINE Developers Console で email scope の申請承認** (Round 4 PR-0 依存)
  - 既に申請済 (2026-04-29)。承認待ち。承認されると LIFF login 経路で `users.email` が back-fill される
- [ ] **Resend アカウント作成** (resend.com)
  - 課金主体は株式会社ケンコーエクスプレス。当面は無料枠 (3,000/月) 内で運用
  - 2FA を必ず有効化 (送信ドメイン乗っ取り対策)
- [ ] **Resend ダッシュで送信ドメイン追加**
  - ドメイン: `mail.naturism-diet.com` (subdomain)
  - DKIM/SPF/MX レコードは 2026-04-29 に Cloudflare DNS に追加済 → ダッシュで `verify` を 1 回押す
- [ ] **Resend API Key 発行 + Worker への登録**
  - 発行スコープ: `Sending access` のみ (full access は不要)
  - 登録: `npx wrangler secret put RESEND_API_KEY` (apps/worker から実行)
- [ ] **Resend webhook 用 Signing Secret の登録** (PR-4 が deploy された後に)
  - ダッシュ Webhooks → 新規作成 → endpoint URL `https://naturism-line-crm.katsu-7d5.workers.dev/api/integrations/resend/webhook`
  - イベント: `email.sent` `email.delivered` `email.bounced` `email.complained` `email.opened` `email.clicked`
  - Signing Secret をコピー → `npx wrangler secret put RESEND_WEBHOOK_SECRET`
- [x] **support@naturism-diet.com の Routing 設定** (2026-05-01 完了)
  - Cloudflare Email Routing で `support@naturism-diet.com → info@kenkoex.com` 転送済
- [ ] **dmarc@naturism-diet.com の Routing 設定確認** (DMARC レポート受信用、§6-0 参照)
  - Cloudflare ダッシュ → Email → Email Routing → Routes
  - `dmarc@naturism-diet.com → info@kenkoex.com` の Forward rule が無ければ作成
  - 既に `naturism-diet.com` 全体を `info@kenkoex.com` に Catch-all 設定している場合は追加不要

### 2-B. Claude / 設定済み (確認のみ)

- [x] env vars (`apps/worker/wrangler.toml`):
  - `EMAIL_FROM = "naturism <noreply@mail.naturism-diet.com>"`
  - `EMAIL_REPLY_TO = "support@naturism-diet.com"`
  - `EMAIL_UNSUBSCRIBE_BASE_URL = "https://naturism-line-crm.katsu-7d5.workers.dev/email/unsubscribe"`
  - `EMAIL_LEGAL_FOOTER_HTML/TEXT` (株式会社ケンコーエクスプレス + 住所 + 連絡先)
- [x] secret:
  - `EMAIL_UNSUBSCRIBE_HMAC_KEY` (登録済 2026-04-30)
- [x] D1 schema (本番):
  - migration 042 適用済 → `email_subscribers` / `email_templates` / `email_messages_log` / `email_link_clicks` の 4 tables + 9 indexes
- [x] Worker route:
  - `GET /email/unsubscribe`
  - `POST /email/unsubscribe` (RFC 8058 One-Click 兼用)
  - `POST /email/resubscribe` (誤解除救済)

### 2-C. preflight 確認

deploy 前に必ず実行:

```bash
pnpm preflight
```

CRITICAL がある状態で `wrangler deploy` 禁止 (CLAUDE.md 規定)。

期待される grep 項目:
- `RESEND_API_KEY` が REQUIRED_SECRETS に登録されているか (PR-4 deploy 時点で必須化)
- migration 042 が apply 済か
- DNS レコード (DKIM/SPF) が dig で取れるか (PR-8 で追加予定の preflight チェック)

---

## 3. 本番投入前の smoke test 3 種

**目的**: Gmail / iCloud / Yahoo の 3 大 ISP に届くこと、かつ DKIM/SPF/DMARC verdict が PASS であることを確認する。

### 3-0. 準備

3 つのテスト用受信メアドを用意 (オーナーの所有を強く推奨):

| ISP | テストメアド例 | 確認ポイント |
|---|---|---|
| Gmail | `katsu.test@gmail.com` 等 | 一番厳格。spam 判定の最右翼 |
| iCloud | `katsu@icloud.com` 等 | Apple Mail Privacy Protection の影響 |
| Yahoo Japan | `katsu@yahoo.co.jp` 等 | 国内大手で日本語 mail header の受け |

### 3-1. テスト用 subscriber 投入

3 ISP 分を `email_subscribers` に手動投入 (本番 D1)。

```sql
-- 3 ISP 分の subscriber を作成 (UUIDv4 は事前生成 / Date は ISO 8601)
INSERT INTO email_subscribers
  (id, email, is_active, transactional_only, consent_source, consent_at, created_at, updated_at)
VALUES
  ('test-gmail-001', 'katsu.test@gmail.com',     1, 0, 'manual_import', '2026-04-30T00:00:00.000', '2026-04-30T00:00:00.000', '2026-04-30T00:00:00.000'),
  ('test-icloud-001', 'katsu.test@icloud.com',   1, 0, 'manual_import', '2026-04-30T00:00:00.000', '2026-04-30T00:00:00.000', '2026-04-30T00:00:00.000'),
  ('test-yahoo-001', 'katsu.test@yahoo.co.jp',   1, 0, 'manual_import', '2026-04-30T00:00:00.000', '2026-04-30T00:00:00.000', '2026-04-30T00:00:00.000');
```

mcp__cloudflare D1 query で実行 (`database_id: f736c7fa-1c19-4279-b03d-3af3a71b7fca`)。

### 3-2. 送信実行 (admin API 経由 / curl)

PR-7 (admin UI) 完成までは admin API を直接叩く:

```bash
# テスト送信 (subscriber_id, template_id を指定)
curl -X POST "https://naturism-line-crm.katsu-7d5.workers.dev/api/admin/email/test-send" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "subscriberId": "test-gmail-001",
    "subject": "[smoke] naturism email test",
    "htmlBody": "<h1>smoke test</h1><p>これは送信テストです。</p>",
    "textBody": "smoke test\n\nこれは送信テストです。",
    "category": "transactional"
  }'
```

> **注**: `/api/admin/email/test-send` endpoint は PR-7 で実装。それまでは Resend 公式 dashboard の Send Test から手動送信でも可。

### 3-3. 受信確認 (Gmail)

1. Gmail 受信箱で着信確認
2. **着信先**: 受信箱 / プロモーション / 迷惑メール のどこに入ったかを記録
   - 迷惑メール → §6 DMARC レポートで原因調査が必要
3. メールを開く → 右上の「︙」 → **「メッセージのソースを表示」**
4. ヘッダで以下を確認:

| ヘッダ | 期待値 |
|---|---|
| `Authentication-Results: mx.google.com;` | `dkim=pass`, `spf=pass`, `dmarc=pass` の 3 つ全て pass |
| `DKIM-Signature:` | `d=mail.naturism-diet.com` (送信ドメインと一致) |
| `Return-Path:` | `bounce@mail.naturism-diet.com` 系 (Resend が自動付与) |
| `List-Unsubscribe:` | `<https://naturism-line-crm.katsu-7d5.workers.dev/email/unsubscribe?id=...&token=...>` |
| `List-Unsubscribe-Post:` | `List-Unsubscribe=One-Click` |

### 3-4. 受信確認 (iCloud Mail)

1. mail.icloud.com で着信確認
2. メールを選択 → 「︙」 → **「ソースとして表示」** (PC web 版)
3. Gmail と同じヘッダを確認
4. **iCloud 特有の注意**: Apple Mail Privacy Protection (MPP) が画像をプリフェッチするため、開封トラッキング (`first_opened_at`) は届いた瞬間に発火する。これは正常 (= MPP の挙動)。

### 3-5. 受信確認 (Yahoo Japan)

1. mail.yahoo.co.jp で着信確認
2. 受信メール → ヘッダ表示 → 「詳細」
3. `Authentication-Results: mta**.mail.yahoo.co.jp` で `dkim=pass spf=pass dmarc=pass` を確認
4. **Yahoo 特有の注意**: 日本語 subject の base64 encoding が必須。Resend SDK が自動で UTF-8 → MIME encoded-word に変換するため、テンプレ作成側は普通に日本語で書いて OK

### 3-6. 失敗時の判断

| Symptom | 推定原因 | 対処 |
|---|---|---|
| 全 ISP に届かない | RESEND_API_KEY 未登録 / 期限切れ | `wrangler secret list` で確認、再登録 |
| Gmail だけ Spam 判定 | DMARC `p=none` 段階で初動評価が悪い | §6 で 7 日観測、改善されないなら HTML/text 両方の retentcion 改善 |
| iCloud だけ未着 | MPP のリンクプリフェッチで Resend に bounce 報告される | `email_messages_log.error_summary` を確認 |
| Yahoo Japan だけ Spam | 日本語 subject に絵文字を使うとスコア下がる事例あり | subject の絵文字を外して再送 |
| 全 ISP で `dmarc=fail` | DKIM/SPF レコード未反映 | DNS TTL 待ち (24h)、`dig` で確認 |

---

## 4. bounce / complaint テスト手順

**目的**: webhook 受信 → `email_subscribers.bounce_count` インクリメント → 3 回で `is_active=0`、complaint は 1 回で即 0 が機能することを確認する。

### 4-1. bounce テスト (存在しないアドレスへ送信)

```bash
# 存在しないアドレスを subscriber に投入
INSERT INTO email_subscribers (id, email, is_active, consent_source, consent_at, created_at, updated_at)
VALUES ('test-bounce-001', 'this-address-does-not-exist-12345@gmail.com', 1, 'manual_import',
        '2026-04-30T00:00:00.000', '2026-04-30T00:00:00.000', '2026-04-30T00:00:00.000');
```

```bash
# 送信実行
curl -X POST ".../api/admin/email/test-send" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{ "subscriberId": "test-bounce-001", "subject": "bounce test", "htmlBody": "test", "textBody": "test", "category": "marketing" }'
```

数秒〜数分後、Resend が webhook で `email.bounced` を送ってくる。

### 4-2. 状態確認 (D1)

mcp__cloudflare D1 query (`database_id: f736c7fa-1c19-4279-b03d-3af3a71b7fca`):

```sql
-- email_messages_log: status='bounced' になっているか
SELECT id, status, error_summary, sent_at, last_event_at
FROM email_messages_log
WHERE subscriber_id = 'test-bounce-001'
ORDER BY created_at DESC LIMIT 1;

-- email_subscribers: bounce_count がインクリメントされているか
SELECT id, email, is_active, bounce_count, complaint_count, unsubscribed_at
FROM email_subscribers
WHERE id = 'test-bounce-001';
```

期待値:
- `email_messages_log.status = 'bounced'`
- `email_subscribers.bounce_count = 1`
- 3 回繰り返すと `is_active = 0` に切り替わる (PR-4 のロジック)

### 4-3. complaint テスト (Spam 報告シミュレーション)

実機テストの場合:
1. §3-1 で投入した Gmail 宛 subscriber に marketing メールを送信
2. 受信箱で「迷惑メールを報告」をクリック
3. Gmail → Resend へフィードバックループ (FBL) 経由で complaint 通知
4. Resend webhook で `email.complained` 発火

```sql
-- 期待値: complaint_count=1 → is_active=0 に即落ちる
SELECT id, email, is_active, complaint_count, unsubscribed_at
FROM email_subscribers WHERE id = 'test-gmail-001';
```

実機が面倒な場合は Resend の Test Webhook 機能で `email.complained` payload を手動送信して確認する。

### 4-4. 仕様確認

PR-4 の bounce/complaint ロジック (`apps/worker/src/routes/integrations-resend.ts`):

```
email.bounced     → bounce_count += 1; if bounce_count >= 3 then is_active = 0
email.complained  → complaint_count += 1; is_active = 0 (即時)
                    + unsubscribed_at = now (法令上の解除扱い)
```

- bounced → soft bounce (一時的) でも 3 回で off になる。再開はオーナー手動
- complained → 1 回で永久 suppression。誤報の可能性は低いため救済 UI は当面なし (PR-7 で検討)

---

## 5. 配信停止リンク動作確認

**目的**: メール末尾の「配信停止はこちら」リンク + RFC 8058 One-Click が正しく動くことを確認する。

### 5-1. リンクのクリックテスト (HTML 経路)

1. §3 の smoke test で受信した marketing メール末尾のリンクをクリック
2. ブラウザに `/email/unsubscribe?id=...&token=...` ページが表示される
3. ページ内容:
   - `📧 配信停止の確認`
   - 該当メアド (subscriber.email) が表示される
   - 「配信を停止する」赤ボタン
   - キャンセルボタン (naturism-diet.com に戻る)
4. 「配信を停止する」クリック
5. POST が処理され `✅ 配信停止が完了しました` ページに遷移

### 5-2. D1 状態確認

```sql
SELECT id, email, is_active, unsubscribed_at, updated_at
FROM email_subscribers
WHERE id = 'test-gmail-001';
```

期待値:
- `unsubscribed_at` が現在時刻でセットされる
- `is_active = 0` になる

### 5-3. RFC 8058 One-Click テスト

Gmail / iCloud は Inbox 上に **「配信停止」ボタン** を自動表示する (List-Unsubscribe ヘッダがあれば)。

1. Gmail で受信メールを開く → subject 横の「配信停止」ボタン
2. Gmail 側がバックグラウンドで `POST /email/unsubscribe?id=...&token=...` を One-Click で実行
3. Gmail に「配信停止しました」と表示される
4. D1 で `is_active=0, unsubscribed_at=now` を確認

### 5-4. 偽造 token テスト (セキュリティ)

```bash
# 不正 token で叩いて 400 が返ることを確認
curl -i "https://naturism-line-crm.katsu-7d5.workers.dev/email/unsubscribe?id=test-gmail-001&token=0000000000000000000000000000000000000000000000000000000000000000"
```

期待値: `HTTP/1.1 400 Bad Request` + 「⚠️ エラー」ページ。

### 5-5. 既解除 idempotent テスト

既に `unsubscribed_at` がセットされている subscriber に対して再度クリック:

期待値: 200 + 「✅ 配信停止済み」ページ (404 にしない、ユーザー混乱回避)。

---

## 6. DMARC レポート受信確認

**目的**: 大手 ISP (Google / Microsoft / Yahoo) から DMARC 集計レポートが日次で届くことを確認する。

### 6-0. 現状ステータス (2026-05-02 確認)

| 項目 | 状態 |
|---|---|
| DMARC stage | **Stage 1 (p=none)** で稼働中 — 観測フェーズ開始 2026-05-02 |
| DMARC DNS レコード | 設定済 (詳細は 6-1) |
| DKIM (Resend selector) | `resend._domainkey.mail.naturism-diet.com` で公開鍵確認済 |
| SPF (apex) | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| SPF (mail subdomain) | `v=spf1 include:amazonses.com ~all` (Resend 内部で AWS SES 利用) |
| MX (apex) | Cloudflare Email Routing (`route1/2/3.mx.cloudflare.net`) に切替済 |
| `dmarc@naturism-diet.com` Routing | **要確認** — Cloudflare ダッシュで `dmarc@→info@kenkoex.com` の forward が無ければ作成 (オーナー作業 5 分) |

**次のアクション (2026-05-09 以降)**: 7 日観測してレポート pass 率 99%+ + 正規 source_ip のみであれば §7-2 の手順で `p=quarantine pct=10` に昇格。

### 6-1. DMARC DNS レコード確認

```bash
dig TXT _dmarc.naturism-diet.com +short
```

現在設定されている内容 (2026-05-02 確認):

```
"v=DMARC1; p=none; rua=mailto:dmarc@naturism-diet.com; ruf=mailto:dmarc@naturism-diet.com; fo=1; aspf=r; adkim=r"
```

(`pct=` タグは省略されている = 暗黙的に `pct=100`。動作上問題なし。)

| タグ | 意味 | 推奨値 (現状) |
|---|---|---|
| `p=` | DMARC 違反時のポリシー | `none` (観測のみ) → 後で `quarantine` → `reject` |
| `rua=` | 集計レポート送信先 (Aggregate) | `mailto:dmarc@naturism-diet.com` |
| `ruf=` | 違反レポート送信先 (Forensic) | 同上 |
| `fo=1` | レポート発火条件 (1 = DKIM/SPF どちらか fail) | `1` |
| `adkim/aspf=r` | アライメントモード | `r` (relaxed、subdomain 許容) |
| `pct=100` | ポリシー適用率 | `100` で運用 |

### 6-2. レポート受信先の検査

dmarc@naturism-diet.com → katsu@kenkoex.com の Email Routing 転送が動いていることを確認。

```bash
# テスト送信 (Cloudflare Email Routing 動作確認)
echo "test" | mail -s "test dmarc@" dmarc@naturism-diet.com
```

数分後 katsu@kenkoex.com に届くこと。

### 6-3. レポート内容の読み方

DMARC aggregate report は **XML 添付** で日次に届く:

```xml
<record>
  <row>
    <source_ip>52.219.108.123</source_ip>
    <count>3</count>
    <policy_evaluated>
      <disposition>none</disposition>
      <dkim>pass</dkim>
      <spf>pass</spf>
    </policy_evaluated>
  </row>
  <auth_results>
    <dkim><domain>mail.naturism-diet.com</domain><result>pass</result></dkim>
    <spf><domain>mail.naturism-diet.com</domain><result>pass</result></spf>
  </auth_results>
</record>
```

確認ポイント:
- `source_ip` が Resend の送信 IP のみであるか (なりすまし検知)
- `dkim/spf` が `pass` であるか
- 異常な IP からの送信があれば DKIM 鍵漏洩の可能性 → 即時 RESEND_API_KEY ローテート

### 6-4. 簡易ビューア

XML 直読みは辛いので **Postmark DMARC Digest** (https://dmarc.postmarkapp.com) や **dmarcian** (https://dmarcian.com) の無料プランに rua タグを向けると人間可読サマリーが届く。当面は `dmarc@naturism-diet.com` 直受けで運用、頻度が増えたら Digest 系に切り替え。

---

## 7. 段階移行 (DMARC p=none → quarantine → reject)

**目的**: いきなり `p=reject` に切り替えると正規メールも reject される事故が起きるため、段階的に強化する。

### 7-1. 段階表

| 段階 | DMARC `p=` | 期間 | 判定基準 (次段階移行条件) |
|---|---|---|---|
| Stage 0 | (DMARC 無し) | — | DKIM/SPF レコードを Cloudflare DNS に追加し、dig で取れる |
| **Stage 1 (現在)** | `p=none` | **最低 7 日** | DMARC レポートで pass 率 99%+ / source_ip が Resend のみ |
| Stage 2 | `p=quarantine` | **最低 7 日** | quarantine された件数が 0、本物のメールが Spam 行きにならない |
| Stage 3 | `p=reject` | 永続 | 本番運用 |

### 7-2. Stage 1 → Stage 2 移行手順

1. 7 日間の DMARC レポートを精査
   - 全レコードで `dkim=pass spf=pass disposition=none` が達成されているか
   - 不審な source_ip (Resend 以外) からの送信が 0 件であるか
2. 異常なし → Cloudflare DNS で `_dmarc.naturism-diet.com` の TXT レコードを編集:

```
v=DMARC1; p=quarantine; rua=mailto:dmarc@naturism-diet.com; ruf=mailto:dmarc@naturism-diet.com; fo=1; adkim=r; aspf=r; pct=10
```

**ポイント**: `pct=10` で 10% だけ quarantine 適用。残り 90% は p=none と同じ挙動。徐々に増やす。

3. 1 日ごとに `pct` を 10 → 30 → 50 → 80 → 100 に増やす (5 日かけて段階引き上げ)

### 7-3. Stage 2 → Stage 3 移行手順

1. Stage 2 (`pct=100`) で 7 日間異常なし
2. Cloudflare DNS で `_dmarc.naturism-diet.com` を更新:

```
v=DMARC1; p=reject; rua=mailto:dmarc@naturism-diet.com; ruf=mailto:dmarc@naturism-diet.com; fo=1; adkim=r; aspf=r; pct=100
```

3. **本番反映後 24 時間は受信箱を集中監視**:
   - support@naturism-diet.com に「メールが届かない」苦情が来ていないか
   - admin UI (PR-7) の bounce 率 / failed 率が急騰していないか

### 7-4. ロールバック判断

各段階で以下が起きたら即 `p=none` に戻す:
- DMARC レポートで `disposition=quarantine|reject` が連続発生 (= 正規メールが落ちている)
- support 苦情が 5 件/日以上
- bounce 率が前日比 2 倍以上に跳ね上がった

戻し方は DNS で TXT レコードを再編集 + TTL 待ち (Cloudflare DNS の TTL は通常 5 分)。

---

## 8. 障害時の rollback 手順

### 8-1. メール大量送信ループに入った時 (緊急停止)

**症状**: `email_messages_log` の sent 件数が 1 分あたり 100 件超で増え続けている / 同一 subscriber に 10 件以上送られている。

**初動 (順番に実行)**:

1. **Cron トリガーを止める** (Cloudflare ダッシュ → Workers → naturism-line-crm → Triggers → Cron を Disable)
   - 5 分以内に効く
2. **RESEND_API_KEY を無効化** (Resend ダッシュで該当 key を Revoke)
   - これで送信が即時停止する
3. **D1 の queued レコードを paused に** (PR-4 で導入予定の `email_messages_log.status='queued'` を一括 `'failed'` に):

```sql
UPDATE email_messages_log
SET status = 'failed', error_summary = 'manual halt due to incident'
WHERE status = 'queued';
```

4. 原因調査 (§8-2 参照)
5. 修正 deploy 後、新 RESEND_API_KEY を発行 → wrangler secret put → Cron 再有効化

### 8-2. 原因調査

```sql
-- 直近 1 時間の送信内訳 (subscriber 別)
SELECT subscriber_id, COUNT(*) as send_count, MIN(created_at), MAX(created_at)
FROM email_messages_log
WHERE created_at > datetime('now', '-1 hour')
GROUP BY subscriber_id
HAVING send_count > 3
ORDER BY send_count DESC;

-- source_kind 別件数 (どの経路から大量発火したか)
SELECT source_kind, status, COUNT(*) as cnt
FROM email_messages_log
WHERE created_at > datetime('now', '-1 hour')
GROUP BY source_kind, status
ORDER BY cnt DESC;
```

典型的な原因:
- `automations` の無限ループ (action が再度 trigger を発火させてしまう構成)
- `subscription-reminder` cron が同じ reminder を重複発火 (Phase 6 hotfix 後でも理論上 0 ではない)
- broadcast の channel='both' で friend_id 重複により同一 email へ複数送信

### 8-3. Resend がダウンした時

**現状**: fallback 無し (SendGrid 実装は YAGNI として削除済 — `docs/ROUND4_EMAIL_ULTRAPLAN.md` §2 参照)。

**対応**:
1. Resend の status page (https://status.resend.com) で確認
2. 短時間 (< 6 時間) なら queue で再送される (Resend 側で retry あり)
3. 長時間 (> 6 時間) で transactional 必須なら **手動で Gmail SMTP / SES 直送に一時切替**:
   - Issue を `BACKLOG.md` に切る (タイトル: "Email fallback provider 実装")
   - Round 4-1 として急遽追加実装
4. marketing 配信は当面停止して告知 (公式サイト + LINE 経由)

> **Note**: 6 時間超のダウンが過去 5 年で 1 度もないプロバイダ (Resend) を選定しているため、本シナリオは低頻度。

### 8-4. Worker の deploy 事故

CLAUDE.md の手順に従う:

```bash
# 直前のデプロイに戻す
cd apps/worker
npx wrangler rollback

# bundle ID 検証
curl -s https://naturism-line-crm.katsu-7d5.workers.dev/ | grep "src=\"/assets/"
```

---

## 9. 法令準拠チェックリスト

**目的**: 配信のたびに自動的に守られているべき項目。テンプレ作成・送信時の audit に使う。

### 9-1. 特定電子メール法 (日本)

| 条項 | 要件 | 実装ロケーション |
|---|---|---|
| **第 3 条** (オプトイン原則) | 受信者の事前同意がある相手にのみ marketing 送信可 | `email_subscribers.is_active=1 AND consent_source IS NOT NULL` を ChannelDispatcher でゲート |
| **第 4 条** (送信者情報明示) | 送信者氏名・住所・連絡先をメール本文中に表示 | `EMAIL_LEGAL_FOOTER_HTML` を EmailRenderer で強制注入 (省略不可) |
| **第 4 条** (解除方法) | 解除リンクを必ず本文中に明示 | `category='marketing'` の場合 EmailRenderer が unsubscribe URL を必ず追記 |
| **第 6 条** (送信記録の保存) | 1 ヶ月以上の送信記録保存義務 | `email_messages_log` で永続保存 (D1 は無期限) |

**確認 SQL** (定期実行):

```sql
-- 直近 7 日で「同意ソースが不明」な marketing 送信が無いことを確認
SELECT l.id, l.subject, s.email, s.consent_source, s.is_active
FROM email_messages_log l
JOIN email_subscribers s ON l.subscriber_id = s.id
WHERE l.category = 'marketing'
  AND l.sent_at > datetime('now', '-7 days')
  AND (s.consent_source IS NULL OR s.is_active = 0);
-- → 0 件であるべき
```

### 9-2. CAN-SPAM (米国)

naturism は日本国内向けだが、海外居住の日本人顧客が含まれる可能性があるため遵守:

- [ ] 件名 (Subject) に欺罔的表現を使わない (例: 「Re:」を会話継続でないのに使う)
- [ ] 物理住所をメール本文に表示 → 法定フッターで対応済
- [ ] 解除リクエストは 10 営業日以内に処理 → 即時処理 (`unsubscribed_at` を即更新) で適合

### 9-3. GDPR (EU)

naturism は EU 居住者向けではないが、たまたま EU からアクセスされる可能性に備える:

- [ ] 明示的同意 (Shopify チェックアウトのチェックボックス) を `email_subscribers.consent_source='shopify_checkout'` で記録
- [ ] データ削除リクエスト → admin UI から該当 subscriber の DELETE 可能 (PR-7)
- [ ] 開封トラッキング pixel の使用は legitimate interest として記載 (法定フッターに 1 行追記)

### 9-4. 薬機法 (日本) — naturism 固有

**サプリメント関連の表現に絶対使わない言葉** (CLAUDE.md 規定):
- 「治す」「効く」「予防する」(医薬品的効能)
- 「○○症が改善」「△△病に作用」
- 「医師推奨」「臨床試験で証明」(根拠提示なしの場合)

EmailRenderer / Phase 4 nutrition-recommender には既に redaction 入り。テンプレを手書きする場合も同基準で校正する。

---

## 10. KPI モニタリング

**目的**: 配信品質を定量で追う。admin UI (PR-7) 完成までは下記 SQL を 1 日 1 回実行する。

### 10-1. 主要 KPI (日次)

mcp__cloudflare D1 query (`database_id: f736c7fa-1c19-4279-b03d-3af3a71b7fca`):

```sql
-- 直近 7 日の送信サマリ (category 別)
SELECT
  category,
  COUNT(*) AS sent,
  SUM(CASE WHEN status IN ('delivered','opened','clicked') THEN 1 ELSE 0 END) AS delivered,
  SUM(CASE WHEN first_opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
  SUM(CASE WHEN click_count > 0 THEN 1 ELSE 0 END) AS clicked,
  SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
  SUM(CASE WHEN status = 'complained' THEN 1 ELSE 0 END) AS complained
FROM email_messages_log
WHERE created_at > datetime('now', '-7 days')
GROUP BY category;
```

期待値 (Round 4 PR-8 完了から 30 日):

| 指標 | 計算式 | 目標 |
|---|---|---|
| 配信成功率 | `delivered / sent` | 95%+ |
| 開封率 (transactional) | `opened / delivered` | 40%+ |
| 開封率 (marketing) | `opened / delivered` | 20%+ |
| クリック率 | `clicked / delivered` | 5%+ |
| バウンス率 | `bounced / sent` | < 2% (3% 超えは警戒) |
| 苦情率 | `complained / sent` | < 0.1% (0.3% 超えは即対応) |

### 10-2. 解除率モニタリング

```sql
-- 直近 7 日の解除件数 / 配信件数
SELECT
  (SELECT COUNT(*) FROM email_subscribers WHERE unsubscribed_at > datetime('now', '-7 days')) AS unsubs,
  (SELECT COUNT(*) FROM email_messages_log WHERE sent_at > datetime('now', '-7 days')) AS sent,
  ROUND(
    100.0 * (SELECT COUNT(*) FROM email_subscribers WHERE unsubscribed_at > datetime('now', '-7 days'))
    / NULLIF((SELECT COUNT(*) FROM email_messages_log WHERE sent_at > datetime('now', '-7 days')), 0),
    2
  ) AS unsub_rate_pct;
```

目標: < 0.5% / 配信。1% を超えたらコンテンツ・配信頻度の見直し。

### 10-3. Phase 6 (再購入リマインダー) email fallback の発火数

```sql
-- LINE 配信不能時に email にフォールバックした件数
SELECT
  DATE(created_at) AS date,
  COUNT(*) AS email_reorder_count
FROM email_messages_log
WHERE source_kind = 'reorder'
  AND created_at > datetime('now', '-30 days')
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

これが日次で発生していれば PR-6 の fallback ロジックが正しく動いている。0 件が続く場合は LINE 友だちのみで完結している (= 想定通り)。

### 10-4. 購読者数推移

```sql
-- 状態別 subscriber 数
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN is_active = 1 AND unsubscribed_at IS NULL THEN 1 ELSE 0 END) AS active,
  SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS unsubscribed,
  SUM(CASE WHEN is_active = 0 AND unsubscribed_at IS NULL THEN 1 ELSE 0 END) AS auto_suppressed,
  SUM(CASE WHEN bounce_count >= 3 THEN 1 ELSE 0 END) AS bounce_3_plus,
  SUM(CASE WHEN complaint_count >= 1 THEN 1 ELSE 0 END) AS complained
FROM email_subscribers;
```

PR-8 完了から 30 日後の目標: `active = 200+` (Shopify 顧客 290 から marketing 同意分が来る想定)。

### 10-5. 異常検知のしきい値

下記が 1 日でも観測されたら admin に Discord アラート:

| 観測項目 | しきい値 | 推奨アクション |
|---|---|---|
| `bounce_rate` | > 5% | DKIM/SPF 確認、自動 suppression が動いているか確認 |
| `complaint_rate` | > 0.3% | 配信内容の見直し、頻度を 1/3 に下げる |
| `delivered_rate` | < 90% | Resend ステータス + DMARC レポート確認 |
| 1 件の subscriber に 10+ 件/日 | 即停止 | §8-1 のループ停止手順 |
| 全 cron silent > 24h | — | Phase 5 cron-monitor が既に発火する。確認のみ |

---

## 11. 関連ドキュメント / 連絡先

- **Ultraplan**: `docs/ROUND4_EMAIL_ULTRAPLAN.md`
- **進捗**: `docs/PROGRESS.md` の Round 4 セクション
- **Secret rotation**: `docs/SECRETS_ROTATION.md`
- **Cron monitor**: `docs/MONITORING.md`
- **D1 ID**: `f736c7fa-1c19-4279-b03d-3af3a71b7fca` (naturism-line-crm)
- **Worker URL**: https://naturism-line-crm.katsu-7d5.workers.dev
- **Resend ダッシュ**: https://resend.com/domains
- **Cloudflare DNS**: Cloudflare ダッシュ → naturism-diet.com → DNS

**緊急連絡先 (CLAUDE.md より)**:
- オーナー: katsu@kenkoex.com (株式会社ケンコーエクスプレス)
- support窓口: support@naturism-diet.com (運用開始後に有効)

---

## 改訂履歴

- 2026-04-30 初版 (Round 4 PR-8 着手前のドラフト)
