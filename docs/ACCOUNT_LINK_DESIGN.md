# 自前 friend↔Shopify customer 連携 設計 (Option B)

**作成**: 2026-06-06 / **対象**: naturism (LINE Harness OSS) / **状態**: 実装完了・**本番 gated off (未稼働)**

CRM PLUS on LINE / Social PLUS / DMM チャットブーストに依存せず、**LINE ハーネス単体で
friend (LINE 友だち) ↔ Shopify customer の連携を完結**させる仕組み。OSS 大方針（自前完結）に合致。

---

## 1. なぜ自前か

- Chrome 実機調査の結論: CRM PLUS on LINE は **0/5 設定未完・ID 連携済 0 人**。
- `socialplus.line` metafield は「顧客がボタンを押す方式」で値が入るが、誰も連携しておらず空。
- CRM PLUS は「DMM チャットブースト」用にインストールされた可能性があり、LINE チャネル/プロバイダーが
  naturism 自前の Messaging API と別 → 相乗りは不確実。
- → **自前の LIFF 連携（email OTP 本人確認）で完結**させる。

連携が成立すると `friends.shopify_customer_id` が populate され、その顧客の過去注文が
trailing-12ヶ月の会員ランク算出に反映される（= マイランクが「regular ¥0」から実ランクに）。

---

## 2. セキュリティモデル（3 要素で乗っ取り防止）

連携には以下 **3 要素が揃って初めて** `friends.shopify_customer_id` を書き込む:

| 要素 | 担保するもの | 実装 |
|---|---|---|
| ① LINE 本人性 | 操作者が当該 LINE 友だち本人 | `liffAuthMiddleware` が idToken を **LINE `oauth2/v2.1/verify`** でサーバ検証 → `c.get('liffUser')={lineUserId, friendId}` |
| ② email 所有 | 入力された email を受信できる本人 | 6 桁 OTP を email 送信し、一致で証明 |
| ③ email→customer | その email が Shopify customer に対応 | Shopify `customers(query:"email:…")` で厳密 1 件照合 |

→「自分の LINE」×「自分が受信できる email」×「その email の customer」が揃わないと連携不可。

### OTP の堅牢化
- **HMAC(pepper) hash 保存**: `code_hash = HMAC-SHA256(ACCOUNT_LINK_HMAC_KEY, "{friendId}:{email}:{code}")`。平文 OTP は保存しない。pepper（server secret・D1 外）により D1 dump 単体の offline 総当たりを防ぐ。
- **短 TTL**: 5 分。
- **試行回数 lock**: 5 回失敗で lock（atomic 加算 `RETURNING` で読み戻し race を排除）。online 総当たりは 5/10^6 で不能。
- **request rate-limit**: 1 friend あたり 5 回/時（email 爆撃防止）。
- **single-use**: 成功/lock で `consumed_at` を CAS。並行する正コード verify は link 側の CAS (`shopify_customer_id IS NULL`) が単一 link を保証。
- **consume は terminal outcome のみ**: transient な Shopify 障害では消費せず、同 code で再試行可（正コードを焼かない）。

### email enumeration 不可
request 時は customer の有無に関わらず OTP を送る。customer の在否は **email 所有を OTP で証明した後**にしか
判明しないため、他人の email を総当たりして「この email は顧客か？」を探れない。

### 注入防止 / PII
- Shopify query/mutation は email/namespace/key/lineUserId を **allowlist 正規表現**で検査。
- `account_link_codes` は受信者 email（PII）を保持するが、**audit_logs には email を残さない**（friend_id / shopify_customer_id で識別）。
- 期限切れ行は cleanup cron が 1 日で purge（PII 最小化、後述）。

### 二重ゲート（gated off で本番 inert）
- **UI**: `accountLinkEnabled` (= `ACCOUNT_LINK_ENABLED==='true'`) が false なら連携 UI を描画しない。
- **Backend**: 両 endpoint は `ACCOUNT_LINK_ENABLED!=='true'` で最初に `disabled` を返し（HTTP 404）、いかなる副作用も起こさない。
- → `ACCOUNT_LINK_ENABLED` 未設定の本番では **UI 不可視 + endpoint 404** で完全 inert。

---

## 3. コンポーネント

### Phase 1 — worker core (PR #109, merged + deploy 済)
| ファイル | 役割 |
|---|---|
| `packages/db/migrations/064_account_link_codes.sql` | OTP transient テーブル（非破壊 CREATE TABLE、本番 D1 適用済 = 121 tables） |
| `packages/db/src/account-link.ts` | 発行 / rate-limit 窓 / active 逆引き / atomic 加算(RETURNING) / CAS 消費 / 旧 code 無効化 |
| `apps/worker/src/services/otp-crypto.ts` | HMAC pepper / 定数時間比較 / bias-free 数値コード |
| `apps/worker/src/services/account-link-shopify.ts` | `findShopifyCustomerByEmail` + `setCustomerLineUserIdMetafield`（GraphQL は shopify-dev MCP で validate 済） |
| `apps/worker/src/services/account-link.ts` | request/verify orchestration |
| `apps/worker/src/routes/liff-account-link.ts` | `POST /api/liff/link/request-code` / `verify-code` |

### Phase 2 — LIFF UI (PR #110, merged + deploy 済)
| ファイル | 役割 |
|---|---|
| `apps/worker/src/routes/liff-my-rank.ts` | `/api/liff/my-rank` に `linked` + `accountLinkEnabled` 追加。マイランクページに gated 2 段フォーム（email→OTP）。a11y 対応（aria-label / aria-live / enterkeyhint）。 |

### Phase 3 — cleanup + docs (本 PR)
| ファイル | 役割 |
|---|---|
| `apps/worker/src/services/account-link-cleanup.ts` | 期限切れ OTP の cleanup cron（JST 03:10-03:14、1 日保持、PII hygiene） |
| `docs/ACCOUNT_LINK_DESIGN.md` | 本書 |

---

## 4. エンドポイント

`liffAuthMiddleware` 配下（`/api/liff/*`）。idToken Bearer 必須。

### `POST /api/liff/link/request-code`
- body: `{ email }`
- gate → email 形式 → 既 link チェック → rate-limit → 旧 code 無効化 → OTP 発行 → Resend で送信。
- 200 `{ success:true }` / 失敗は `{ success:false, error, message }`（disabled→404, rate_limited→429, already_linked→409, email_failed→502, …）。

### `POST /api/liff/link/verify-code`
- body: `{ email, code }`
- gate → 形式 → 既 link → active code 取得 → lock 判定 → 定数時間比較 → (transient なら consume せず) → Shopify customer 引当 → conflict 検査 → `setFriendShopifyCustomerId` → 自前 metafield 書込(best-effort) → 過去注文 backfill(gated)。
- 200 `{ success:true, data:{ linked, customerId, backfilled, metafieldWritten } }` / 失敗は `error+message`（invalid_code は `attemptsRemaining` 付き、customer_not_found→404, customer_conflict→409, locked→429, shopify_error→502, …）。

---

## 5. データモデル: `account_link_codes` (migration 064)

```
id TEXT PK / friend_id TEXT / email TEXT (lowercased, 本人入力)
code_hash TEXT (HMAC) / expires_at TEXT (ISO) / attempts INT / consumed_at TEXT? / created_at TEXT
index: (friend_id, created_at) [rate-limit窓] / (friend_id, email) [active逆引き]
```
- transient（OTP は 5 分 TTL）。cleanup cron が created_at < now-1日 を purge。

---

## 6. 有効化手順（= Katsu 承認後）

本番では default off。有効化に必要な secret（`wrangler secret bulk` で **JSON 投入**推奨。
PowerShell の `"値"|wrangler secret put` は末尾 `\r` を残すトラップあり → [[feedback_wrangler_secret_powershell_crlf]]）:

| secret | 必須 | 値 |
|---|---|---|
| `ACCOUNT_LINK_ENABLED` | ✅ | `true` |
| `ACCOUNT_LINK_HMAC_KEY` | ✅ | ランダムな pepper（OTP hash 用 server secret） |
| `ACCOUNT_LINK_METAFIELD_NAMESPACE` | 任意 | default `naturism` |
| `ACCOUNT_LINK_METAFIELD_KEY` | 任意 | default `line_user_id` |
| `MEMBER_BACKFILL_ENABLED` | 任意 | `true`（連携時に過去注文を rank へ backfill、money path・別 gate） |

前提: Resend（`RESEND_API_KEY` / `EMAIL_FROM`）は設定済。

有効化後の動作確認:
1. `?demo=1` で UI レイアウトを確認（demo は accountLinkEnabled:true でフォームを描画。idToken 無しのため実 endpoint は 401 = 連携は成立しない）。
2. 実 LINE 内でマイランクを開き、自分の Shopify 注文 email で連携 → OTP → linked:true → rank 反映を確認。

⚠️ **`read_all_orders` scope**: backfill は本番 token の `write_orders`（直近 60 日のみ閲覧可）では直近 60 日の paid 注文のみ取得（それ以前は under-count = 安全方向）。完全な trailing-12mo backfill には scope 追加（Shopify アプリ再認証）が必要 → [[feedback_shopify_orders_60day_scope]]。

---

## 7. 任意の将来拡張（= Katsu の config 判断）

### reverse cron 再ポイント（socialplus.line → naturism.line_user_id）
PR3-A の `friend-customer-linker.ts` は metafield 逆引きで未 link friend を自動連携する cron（本番有効）。
現在 `FRIEND_LINK_METAFIELD_NAMESPACE=socialplus` / `KEY=line` を読むが、Social PLUS が値を投入しないため
実顧客はヒットしない。

本機能（Phase 1）が `naturism.line_user_id` metafield を**自前で書き込む**ようになったため、
reverse cron をそこに re-point すれば「自前 metafield からの逆引き自動連携」も可能になる。

**ただしこれは live 挙動変更**（本番稼働中の cron が読む metafield が変わる）であり、
secret (`FRIEND_LINK_METAFIELD_NAMESPACE`/`KEY`) の変更で行う **config 判断**のため、
コード側では実施せず本書に記録するに留める。実施時は Katsu が secret を更新する。

---

## 8. テスト

- Phase 1: 72 test（db / shopify / service / route / otp）
- Phase 2: liff-my-rank +8（flags / UI / a11y render）
- Phase 3: account-link-cleanup 10（gating / DELETE / heartbeat / retention / fail-safe）
- 全 PR で worker+db+web typecheck + 全 test + schema drift preflight All green / CI green。
