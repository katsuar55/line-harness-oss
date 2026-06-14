# Launch-Readiness 全体レビュー (2026-06-15, 多エージェント Workflow)

counts: {"raw":66,"deduped":66,"confirmed":21,"refuted":3,"medLow":42}  (35 agents / 多次元 find → 敵対的 verify → 統合)

> 自動生成。出典 = workflow naturism-launch-readiness-review。修正の進捗は別途 PR/task で追跡。

---

The task update isn't essential to my deliverable. I have verified all the load-bearing findings against the actual code. Here is the final report.

---

# naturism DMM移行 Launch 最終レビューレポート

## 1. アーキテクチャ & 目的の再確認

LINE Harness OSS は Cloudflare Workers + Hono を入口に、D1 (SQLite, 121 tables) / Workers AI (Qwen→Llama fallback) / Next.js15 管理画面で構成される LINE CRM/マーケ自動化基盤。本線は現行「DMMチャットブースト for EC」を解約して本 OSS へ完全移行する直前で、本番 worker は LIVE。webhook フロー (`apps/worker/src/routes/webhook.ts`) は LINE署名検証 → `waitUntil` 非同期 → Layer1 auto_replies(keyword) → Layer1.5 intent-router(deterministic) → Layer2 AI の3層。cron は 5分毎に step配信/予約broadcast/リマインダー/再入荷/token refresh 等をマルチアカウント token ループ (`index.ts:404`) で並列実行。ブランドは機能性表示食品 (届出 H975 系) のため薬機法/景表法のコンプラ・ゲートが launch クリティカル。CORS/auth は `index.ts:197-219` でグローバル適用。

## 2. Launch 判定: **条件付き No-Go (Conditional Go)**

コア配信パスは健全だが、**実コードで確認した CRITICAL 1 件 + launch-blocking HIGH 4 件**を修正してからカットオーバーすべき。すべて autofixSafe=true (migration/secret/外部設定不要) で、main loop が即 TDD+gated PR で潰せる。これらを fix すれば Go。

**No-Go を解く blocker (修正必須):**
| # | 重大度 | 件名 | file:line |
|---|---|---|---|
| B1 | **CRITICAL** | reorder/create IDOR (他人の注文を再注文 URL 化) | `liff-portal.ts:285-286` |
| B2 | **HIGH (compliance)** | AI redact が「痩せる/ダイエット/脂肪燃焼」を素通り（顧客送信前の唯一ゲート不十分） | `redact.ts:22` / `ai-response.ts:297` |
| B3 | **HIGH (correctness)** | intent-router の reply 失敗時に Layer2 AI が deterministic ルーティングを上書き | `webhook.ts:837-883` |
| B4 | **HIGH (correctness)** | `purchase_completed` が `orders/updated` でも発火 → automation 多重実行 | `shopify.ts:278` |
| B5 | **MEDIUM→実害高** | CORS が未許可オリジンをそのまま echo（実質 allowlist 無効化） | `index.ts:207` |

> 注: cron 系の atomic-claim 欠落 (B6-B9) は**現時点 single-account では未発火**だが、移行計画の第2アカウント追加で即発火する。launch 当日が single-account なら HIGH→launch非ブロッキングに格下げ可だが、第2アカウント有効化前に必ず潰すこと。

## 3. 即時修正すべき (autofixSafe=true・launch関連) — 優先度順

main loop が今から TDD+gated PR で直す対象。すべて migration/secret 不要・happy-path 不変・recipient 縮小方向。

### P0 — CRITICAL
**1. reorder/create に所有権チェック追加 (IDOR)** — `apps/worker/src/routes/liff-portal.ts:286`
- 実コード確認済: line 285 `getShopifyOrderById(c.env.DB, orderId)` は body の `orderId` を無検証で引く。`packages/db/src/shopify.ts` の同関数は `WHERE id = ?` のみで friend_id フィルタ無し。
- `liff.ts:1144` には正しいガード `if (!order || order.friend_id !== friend.id)` が存在 → これを移植。`user.friendId` は `getLiffUser(c)` (liffAuthMiddleware 経由、line 258) で確実に非null。
- 修正: line 286 の直後に `if (order.friend_id !== user.friendId) return c.json({ success: false, error: 'Order not found' }, 404);`。NULL (未リンク注文) は `null !== friendId` で正しく弾かれる。
- TDD: `getShopifyOrderById` が別 friend_id の注文を返すケースで 404 を assert。

### P1 — HIGH (compliance, 薬機法/景表法)
**2. redact.ts にダイエット違反語を追加** — `packages/ai-provider/src/redact.ts:50` 直後
- 実コード確認済: `PROHIBITED_PHRASES` (line 22-50) は 治る/治す/効く/cure/heal 等の医療系のみ。`痩せる/やせる/ダイエット効果/脂肪燃焼/体重が減/引き締/代謝が上が/スリム` を一切含まない。これが `workers-ai.ts` で顧客送信前に走る唯一の redaction。
- `ai-ng-filter` は検知するが monitoring 専用 (`ai-response.ts:297-307` で warn+log のみ、text はそのまま return) → 防御になっていない。
- 修正(2段): (a) redact.ts に `'痩せる','痩せ','やせる','やせ','ダイエット効果','脂肪燃焼','体重が減','体重を落','体脂肪が','引き締','代謝が上が','スリム効果'` を追加。届出表示「BMIが高めの方の腹部の脂肪を減らす」は上記いずれの substring でもないので衝突しない。(b) `ai-response.ts:297` の `if (ngResult.hasNg)` 分岐で `result.text` を `FALLBACK_MESSAGE` に差し替えて返す (conversation_logs には原文を残し監査性維持)。
- TDD: `redactProhibitedPhrases('naturism Blueを飲めば痩せます')` が redact され、届出表示文がそのまま通ることを assert。

### P1 — HIGH (correctness)
**3. intent-router の matched フラグを try 外に移動** — `apps/worker/src/routes/webhook.ts:850→839`
- 実コード確認済: line 839 `if (intentResult)` 内で `matched = true` (850) と `replyTokenConsumed = true` (849) が **try ブロック内**にあり、`lineClient.replyMessage` (848) が throw すると catch (866-878) はログのみで両フラグ未設定 → line 883 `if (!matched && !replyTokenConsumed && env?.AI)` を通過し AI が発火。
- auto_replies パス (line 732) は `matched=true` を try 外に置いており非対称。
- 修正: `if (intentResult) {` 直後に `matched = true;` を移動 (replyTokenConsumed は成功時のみで正しい)。これで `quiz_invite`/`feature_unavailable`/`my_rank` の deterministic 経路が LINE API 一時障害でも AI に上書きされない。
- TDD: `detectIntent` 非null + `replyMessage` throw のとき AI が呼ばれないことを assert。

**4. purchase_completed を orders/create に限定** — `apps/worker/src/routes/shopify.ts:278`
- 実コード確認済: `fireEvent('purchase_completed', ...)` (278) は `topic === 'orders/create' || topic === 'orders/updated'` の共有ブロック内で topic ガード無し。line 291 の subscription enroller は正しく `topic === 'orders/create'` ガード済 → 非対称。
- Shopify は fulfillment/tag/refund 更新でも orders/updated を送るため、同一注文で automation・scoring が毎回再発火。
- 修正: `fireEvent` 呼び出しを `if (topic === 'orders/create')` でラップ。`upsertShopifyOrder`/`findFriendAndBackfill`/`linkShopifyCustomerToFriend` は updated でも実行継続。
- TDD: `X-Shopify-Topic: orders/updated` で `fireEvent` が呼ばれないことを assert。

### P1 — CORS (MEDIUM だが実害高)
**5. CORS フォールスルーを deny に** — `apps/worker/src/index.ts:207`
- 実コード確認済: `origin: (origin) => { ... return origin; }` が未許可オリジンをそのまま echo。Hono cors はコールバックの truthy 戻り値を ACAO に verbatim 設定するため allowlist (199-204) が dead code。コメント「R2画像等の公開パスは全オリジン許可」は誤り (コールバックは path を見られない)。
- 修正: line 207 を `return null;` に変更。R2 画像で open-origin が真に必要なら `app.use('/images/*', cors({ origin: '*' }))` を別途 path-scoped で追加。credentials 未設定なので API_KEY 自動添付はないが、`/api/liff/*`・`/images/*`・form 系のレスポンスがクロスオリジンで読める状態は解消すべき。
- TDD: `Origin: https://evil.example.com` で ACAO ヘッダが付かないことを assert。

### P1 — HIGH (cron reliability, 第2アカウント前に必須)
以下は single-account では未発火だが移行で第2アカウント追加した瞬間に二重送信/ハングが起きる。第2アカウント有効化より前に必ず修正:
- **6. subscription-reminder atomic claim** — `subscription-reminder.ts:135`。`claimSubscriptionReminderForSend` (CAS: `UPDATE ... WHERE id=? AND next_reminder_at=?`) を dispatch 前に追加。`claimFriendScenarioForDelivery` パターンを踏襲。
- **7. reminder-delivery atomic claim** — `reminder-delivery.ts:41`。`claimReminderStepDelivery` (`INSERT OR IGNORE`→`changes===1`) を pushMessage 前に。テーブル/UNIQUE 既存 (schema.sql:448-454)。
- **8. ab-test atomic claim** — `ab-test.ts:162`。`claimAbTestForSending` (`WHERE status='scheduled'`) を broadcast の `claimBroadcastForSending` に倣って追加。
- **9. token-refresh / ad-conversion / event-bus webhook の fetch timeout** — `token-refresh.ts:40`, `ad-conversion.ts:115/146/179/218`, `event-bus.ts:159/374`。AbortController+5s。これらは single-account でも発火 (外部 API ハング→cron が 30s CPU limit まで占有)。`shopify-token.ts:124-140` パターンを踏襲。**timeout 系は single-account でも launch-blocking。**

### P2 — cron 性能 (unbounded SELECT / LIMIT 追加)
launch スケール (数千友だち) で D1 の 10,000 行 .all() 上限に達し silent truncation の恐れ。SQL に時刻述語 + LIMIT を push:
- `scenarios.ts:386` (`getFriendScenariosDueForDelivery`): `AND next_delivery_at <= ? ORDER BY next_delivery_at ASC LIMIT 200`、JS filter/sort 削除。
- `reminders.ts:127` (`getDueReminderDeliveries`): 時刻述語 push + `LIMIT 100` + deliveries の IN-clause バッチ化 (N+1 解消)。

### P3 — 小修正 (autofixSafe=true, launch 近接)
- `webhook.ts:556` daily_tip postback の catch で fallback 返信を追加 (他 postback と同パターン)。
- `event-bus.ts:484` processNotifications を per-row try/catch に (1件の不正 JSON で以降の rule が全停止)。
- `event-bus.ts:287` score_threshold が currentScore=undefined で素通り → `currentScore === undefined || ...` で fail-safe。
- `shopify.ts:35` upsertShopifyOrder UPDATE が orders/updated で total_price/line_items/email/phone を落とす → COALESCE。
- `ai-response.ts:136` Blue を「脂肪・糖質の吸収を抑える基盤モデル」と効能断定 → サポート表現に修正 (template literal 内 backtick 禁止に注意)。
- `monthly-broadcast-postback.ts:798/571` 体験談示唆 (翌日が違う実感/翌朝がラク) → 中立表現に。
- `liff-pages.ts:2056` LIFF 既定 FAQ の返品ポリシーが公式 (seed v3) と矛盾 (7日) + 「効果的」表現。
- `ban-monitor.ts:56`, `shopify-customer-sync.ts:84`, `google-calendar.ts:38`, `logger.ts:96` の fetch に timeout 追加。
- `subscription-reminder.ts:177` silent empty catch を console.warn に。

## 4. Katsu 承認ゲート (autofixSafe=false: secret/money/破壊的/外部設定)

main loop は触らない。Katsu の承認/操作が必要:

1. **admin web (Cloudflare Pages) の deploy** — `package.json` / task #5。DMM パリティ新 UI が未 deploy (stale)。カットオーバー前に `pnpm --filter web build` → Pages deploy。**launch-gap、要 Katsu 実行**。
2. **`POST /api/forms/:id/submit` の無認証 friendId 自称** — `forms.ts:183`。auth/liffAuth 両方をスキップ。`save_to_metadata=true` フォームで任意友だちのメタデータ改竄可。short-term: save_to_metadata=true 時に friendId/lineUserId を無視して null 保存 (挙動変更を伴うため要判断)。**移行で公開フォームを使うなら launch 前に要対応。**
3. **API_KEY 空文字ガード** — `auth.ts:62`。実コード確認済: `if (token === c.env.API_KEY)` に非空チェック無し。CRLF secret trap (MEMORY 既知) 等で API_KEY が空だと `Bearer ` で owner 権限通過。修正自体は autofixSafe=true (`if (c.env.API_KEY && token === ...)`) だが、起動時に API_KEY 非空を検証する運用込みで Katsu に共有推奨。**まず `wrangler secret list` で API_KEY 設定確認を。**
4. **`/auth/callback` の uid 無検証リンク (アカウント乗っ取り)** — `liff.ts:292`。`?uid=<victim-uuid>` で他人の user_id に自分の friend を紐付け可能。修正 (`getUserById` 存在チェック追加) は autofixSafe=true だが、既存リンク済データへの影響確認のため Katsu 共有。HMAC 署名化は別途検討。
5. **amountJpy ¥0 記録** — `shopify-phase2a.ts:551`。money path のため autofixSafe=false。`totalPrice ?? 0` が paid 注文で total_price 欠落時に ¥0 を loyalty 加算。early-return ガード or 再 fetch を Katsu 判断。
6. **multi-account 重複 cron** — `index.ts:404`。loyalty/membership/birthday 等 LINE非依存 cron が token ループでアカウント数分実行。第2アカウント追加時の設計判断 (LINE非依存 job をループ外に出す)。

## 5. Post-launch backlog (実害小 or 大規模リファクタ)

- **死コード削除** (autofixSafe=true, 挙動不変): `stealth.ts:92` StealthRateLimiter / `translate.ts:71` batchTranslate / `audit-logger.ts:153` auditApi / `product-display.ts:168` sendPostPurchaseRecommendations。
- **GA4 server-side 送信** (`analytics.ts:26`) が完全未配線の死コード → 配線 or 削除を Katsu 判断 (将来 feature の足場可能性)。
- **コード重複統合** (autofixSafe=false, 互換性 test 先行必須): `hmacSha256Hex`/`constantTimeEqual` が3ファイル重複 (`email-opt-in.ts:34` 等、署名互換性注意) / `escapeHtml` が14ファイル (client/worker bundle 境界確認)。
- **巨大ファイル分割** (`liff-portal.ts` 2407行ほか10ファイル800行超) → launch 後にサブルーター分割。
- **その他 unbounded SELECT** (broadcasts/ab-tests/birthday/loyalty-rank/abandoned-carts/tag-elapsed) に LIMIT 追加 → P2 と同方針で順次。
- **入力サニタイズ**: `liff-portal.ts:1760` intervalDays クランプ、rate-limit skip パスの UNAUTHENTICATED_PATTERNS 整合、LINE token error body のログ削減 (`liff.ts:224`)。
- **テスト追加** (test-only, live-safe): orders/paid member-sync wiring (`shopify-phase2a.ts:543`)、restock postback dispatch (`webhook.ts:477`)、inventory notify loop (`shopify-phase2a.ts:398`)、auth skip allowlist の negative 401 test。

## 6. 各 finder の所見ハイライト

- **sec-liff-forms**: 最重要。reorder IDOR (CRITICAL) は実害が直接的で `liff.ts:1144` に正解パターンが既存 → 移植容易。`/auth/callback` uid 無検証は HIGH で乗っ取りリスク。
- **sec-webhook-auth**: CORS echo と liff/profile の cross-user enumeration。両者とも「完全無認証」は誇張で、liff/profile は liffAuthMiddleware で 401 はかかる（実コード確認: index.ts:219 でグローバル適用）。ただし handler が body の任意 lineUserId を引く認証済列挙は実在 → MEDIUM で正。CORS は echo により allowlist が実質無効で MEDIUM→実害高。
- **correctness-events**: intent-router の matched 非対称 (try 内設定) と start_scenario の二重 enroll。前者は launch-blocking、後者は automation 設定次第で HIGH。
- **correctness-money**: purchase_completed の orders/updated 多重発火。topic ガード欠落で automation/scoring が注文更新毎に再実行 → 移行直後の自動化で実害大。
- **data-integrity-cron**: atomic claim 欠落 4 件 + unbounded SELECT 群。**single-account では大半が未発火**だが、移行の第2アカウント追加が引き金。timeout 系 (token-refresh/ad-conversion) は single でも発火するので最優先。
- **compliance-yakkiho**: redact 痩せ系欠落 + ai-ng-filter が monitoring 専用。機能性表示食品+Qwen→Llama fallback 常態化 (MEMORY 既知) を踏まえると launch-blocking。3層 (redact/ng-filter/system-prompt) のうち実防御は redact のみで、その辞書に違反語が無い構造的ギャップを実コードで確認。
- **reliability-errors**: 外部 fetch timeout 欠落の横断。`ad-conversion.ts` は event-bus phase1 内から呼ばれ phase2(automations) をブロックし得る点が要注意。
- **test-gaps**: money path (orders/paid member-sync) の wiring 層が無テスト → フィールド名ミスが green のまま loyalty 加算を壊す。test-only で安全に追加可。

---
**結論**: B1-B5 (CRITICAL×1 + HIGH×4) と timeout 系 (P1-9) を TDD+gated PR で潰せば Go。cron atomic-claim (B6-B8) は第2アカウント有効化前に。admin web Pages deploy と forms 無認証は Katsu ゲート。

主要確認ファイル: `apps/worker/src/index.ts:197-219`, `apps/worker/src/routes/liff-portal.ts:256-294`, `apps/worker/src/routes/liff.ts:508-533,1138-1146`, `apps/worker/src/routes/webhook.ts:837-883`, `apps/worker/src/routes/shopify.ts:278-291`, `apps/worker/src/middleware/auth.ts:10-68`, `packages/ai-provider/src/redact.ts:22-50`。

---

## 付録A: confirmed findings (21)

### A1. [MEDIUM] CORS origin callback returns any origin verbatim — effectively disables CORS restriction
- `apps/worker/src/index.ts:207` | category=security | launchBlocking=true | autofixSafe=true
- evidence: origin: (origin) => {   const allowed = [ ... ];   if (!origin || allowed.includes(origin)) return origin || '*';   // R2画像等の公開パスは全オリジン許可   return origin;  // ← returns ANY origin, echoing it back }
- fix: In apps/worker/src/index.ts, change line 207 from `return origin;` to `return null;`. This makes Hono skip setting the ACAO header for unlisted origins (falsy return = deny, per Hono cors dist line 43). The allowlist on lines 199-204 then works as intended.  If R2 image serving genuinely needs open-origin access, apply a second narrow cors({ origin: '*' }) middleware scoped only to those image routes (e.g. app.use('/api/images/*', cors({ origin: '*' }))) rather than leaking it globally.  TDD: add a unit/integration test asserting that a request with Origin: https://evil.example.com receives no Access-Control-Allow-Origin header (or a 403 preflight). This is safe to autofix: no migration, no 

### A2. [MEDIUM] POST /api/liff/profile is unauthenticated — exposes friend internal ID and display name via LINE user ID enumeration
- `apps/worker/src/routes/liff.ts:508` | category=security | launchBlocking=true | autofixSafe=true
- evidence: // POST /api/liff/profile - get friend by LINE userId (public, no auth) liffRoutes.post('/api/liff/profile', async (c) => {   const body = await c.req.json<{ lineUserId: string }>();   ...   return c.json({ success: true, data: { id: friend.id, displayName: friend.display_name, isFollowing: ..., userId: ... } }); });
- fix: **Downgrade rationale:** Requires a valid LINE idToken (attacker must be a genuine LINE user who has added the official account as a friend). Does not expose payment/money data. Internal UUID + display name exposure is a real privacy concern (per-user enumeration of friend records) but not a complete authentication bypass.  **Fix approach (no migration, no secrets, no external config changes, live-safe):**  1. In `apps/worker/src/routes/liff.ts:508-533`, replace the handler body so it ignores the `lineUserId` parameter and instead reads `c.get('liffUser')` (set by `liffAuthMiddleware`) to look up only the authenticated caller's own record:    ```typescript    liffRoutes.post('/api/liff/profi

### A3. [CRITICAL] reorder/create: orderId に所有権チェックなし (IDOR)
- `apps/worker/src/routes/liff-portal.ts:283` | category=security | launchBlocking=true | autofixSafe=true
- evidence: const order = await getShopifyOrderById(c.env.DB, orderId); if (!order) return c.json({ success: false, error: 'Order not found' }, 404); // ← order.friend_id !== user.friendId のチェックがない const parsed = order.line_items ? JSON.parse(order.line_items as string) : [];
- fix: Insert an ownership guard immediately after the null check at `liff-portal.ts:286`. Mirror the pattern from `liff.ts:1144` exactly:  ```typescript const order = await getShopifyOrderById(c.env.DB, orderId); if (!order) return c.json({ success: false, error: 'Order not found' }, 404); // ADD THIS LINE: if (order.friend_id !== user.friendId) return c.json({ success: false, error: 'Order not found' }, 404); ```  Note: `user.friendId` is a non-null string set by `liff-auth.ts:96` from the cryptographically verified LINE idToken, so the strict `!==` comparison is safe. If `order.friend_id` is NULL (unlinked order), `null !== user.friendId` evaluates to `true`, correctly blocking access.  For TDD:

### A4. [MEDIUM] POST /api/liff/profile: idToken 検証なしで LINE userId から全友だち情報を取得可能
- `apps/worker/src/routes/liff.ts:507` | category=security | launchBlocking=true | autofixSafe=true
- evidence: // POST /api/liff/profile - get friend by LINE userId (public, no auth) liffRoutes.post('/api/liff/profile', async (c) => {   const body = await c.req.json<{ lineUserId: string }>();   const friend = await getFriendByLineUserId(c.env.DB, body.lineUserId);   return c.json({ success: true, data: { id: friend.id, displayName: friend.display_name, isFollowing: ..., userId: ... } });
- fix: Fix approach (no migration, no secret change, live-safe, TDD-able):  1. In `apps/worker/src/routes/liff.ts` around line 508-528, replace the arbitrary body lookup with the already-verified identity from middleware context. After `liffAuthMiddleware` runs, `c.get('liffUser')` holds the verified `{ lineUserId, friendId }`. The route handler should use that directly instead of reading `body.lineUserId`:  ```ts liffRoutes.post('/api/liff/profile', async (c) => {   try {     const liffUser = c.get('liffUser');     // liffAuthMiddleware guarantees this is set; guard defensively     if (!liffUser?.friendId) {       return c.json({ success: false, error: 'Authentication required' }, 401);     }     

### A5. [HIGH] CORS: 未知オリジンをすべてそのまま許可するフォールスルー
- `apps/worker/src/index.ts:205` | category=security | launchBlocking=false | autofixSafe=true
- evidence: origin: (origin) => {   const allowed = ['https://naturism-admin.pages.dev', 'https://liff.line.me', 'http://localhost:3001', 'http://localhost:3000'];   if (!origin || allowed.includes(origin)) return origin || '*';   // R2画像等の公開パスは全オリジン許可   return origin;  // ← 許可外オリジンを全て許可している }
- fix: In `apps/worker/src/index.ts` lines 206-208, change `return origin` to `return null`. This is the minimal, purely restrictive fix: unknown origins receive no `Access-Control-Allow-Origin` header and browsers block the cross-origin read. The comment should be removed or corrected — the CORS callback cannot inspect the request path, so it cannot conditionally open access for `/images/*` from here. If open-CORS access for public image paths is genuinely required, add a separate path-scoped middleware before the global one: `app.use('/images/*', cors({ origin: '*' }))`. This change requires no migration, no secret change, does not affect the happy path for the four allowlisted origins, and is un

### A6. [HIGH] /auth/callback: uid クエリパラメータを無検証でユーザー UUID として books 書き込み
- `apps/worker/src/routes/liff.ts:292` | category=security | launchBlocking=false | autofixSafe=true
- evidence: // Cross-account linking: if uid is provided, use that existing UUID if (uidParam) {   userId = uidParam;  // ← URL パラメータの任意 UUID をそのまま user_id に設定 } // ... await linkFriendToUser(db, friend.id, userId);
- fix: In /auth/callback (liff.ts around line 292), before assigning `userId = uidParam`, call `getUserById(db, uidParam)` and only proceed if the result is non-null. If the record does not exist, fall through to the email-match branch or the create-new-user path — do not write the orphan UUID. Optionally add a UUID v4 format guard (regex) before the DB call to reject obviously malformed values cheaply. The fix requires no migration, no secret changes, and the happy path (no uid param, or uid param resolving to a real user) is unaffected, satisfying the live-safe constraint. A unit test should mock `getUserById` returning null and assert `linkFriendToUser` is not called with the unvalidated param.

### A7. [HIGH] Intent-router reply failure allows Layer 2 AI to contradict deterministic routing
- `apps/worker/src/routes/webhook.ts:866` | category=correctness | launchBlocking=true | autofixSafe=true
- evidence: At line 837-880, when detectIntent matches (intentResult != null) but lineClient.replyMessage throws at line 848, the catch block at line 866 does NOT set matched=true or replyTokenConsumed=true. The Layer 2 AI check at line 883 is `if (!matched && !replyTokenConsumed && env?.AI)`, so AI fires with the full user message. A user asking 'おすすめ教えて' (quiz_invite intent) would receive an AI answer instead of the deterministic quiz invite flex — undermining the safety-net purpose of Layer 1.5. The auto
- fix: Move `matched = true` to immediately after `if (intentResult)` is confirmed non-null, before the try block, mirroring the auto-replies pattern at line 732. Leave `replyTokenConsumed` inside the try block (set only on successful `replyMessage`) so LINE's reply-token accounting stays correct.  Concretely, at /apps/worker/src/routes/webhook.ts around line 839, change:  ```typescript if (intentResult) {   try {     const messages = await buildMessagesForIntentAsync(...);     await lineClient.replyMessage(event.replyToken, [...messages]);     replyTokenConsumed = true;     matched = true;          // ← currently here, inside try     ...   } catch (err) {     ...                      // ← matched 

### A8. [HIGH] start_scenario automation action has no enrollment idempotency guard
- `apps/worker/src/services/event-bus.ts:329` | category=correctness | launchBlocking=false | autofixSafe=true
- evidence: case 'start_scenario': await enrollFriendInScenario(db, friendId!, action.params.scenarioId); — enrollFriendInScenario (packages/db/src/scenarios.ts:325) does a bare INSERT without checking for an existing friend_scenarios row for the same (friend_id, scenario_id) pair. If two automations both have a start_scenario action for the same scenario, or the same automation fires twice for the same event (e.g., retry), the friend gets double-enrolled and receives duplicate step deliveries. The webhook.
- fix: Mirror the guard already present in `apps/worker/src/routes/webhook.ts:230-233` into the `start_scenario` case inside `executeAction` in `apps/worker/src/services/event-bus.ts`.  Concretely, before the `enrollFriendInScenario` call at line 329, add:  ```typescript case 'start_scenario': {   const existing = await db     .prepare(       `SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`,     )     .bind(friendId!, action.params.scenarioId)     .first<{ id: string }>();   if (!existing) {     await enrollFriendInScenario(db, friendId!, action.params.scenarioId);   }   break; } ```  No migration is required (the SELECT operates on the existing schema). No secret or scope 

### A9. [HIGH] purchase_completed event fires on orders/updated — automation rules re-trigger on every order update
- `apps/worker/src/routes/shopify.ts:278` | category=correctness | launchBlocking=true | autofixSafe=true
- evidence: if (topic === 'orders/create' || topic === 'orders/updated') { … if (friendId) { await fireEvent(db, 'purchase_completed', { friendId, eventData: { source: 'shopify', shopifyOrderId, amount: totalPrice } }, …) } }  — The fireEvent call is inside the shared orders/create||orders/updated block with no topic guard. Shopify sends orders/updated for fulfillment updates, tag changes, refunds, etc., so every downstream update to an order re-fires purchase_completed. Any automation rule in the D1 automa
- fix: Wrap the `fireEvent` call (and the two `INSERT OR IGNORE INTO friend_tags` blocks that assign `shopify_customer` and `purchased` tags, which are also idempotent by SQL but fire unnecessary D1 round-trips on every update) with a `if (topic === 'orders/create')` guard, mirroring the existing guard at line 291 for the subscription enroller. The `orders/updated` path should continue to execute: (a) `upsertShopifyOrder` to update financial/fulfillment status, (b) `findFriendAndBackfill` for email/phone back-fill, and (c) `linkShopifyCustomerToFriend` — none of which trigger automation rules. No migration is required (D1 schema unchanged), no secrets change, no external configuration changes, and 

### A10. [HIGH] getFriendScenariosDueForDelivery: unbounded SELECT on friend_scenarios — no LIMIT, no pagination
- `packages/db/src/scenarios.ts:386` | category=reliability | launchBlocking=true | autofixSafe=true
- evidence: SELECT * FROM friend_scenarios WHERE status = 'active' AND next_delivery_at IS NOT NULL — no LIMIT clause. All active+due rows are fetched into Worker memory and then JS-filtered. With thousands of subscribers in active scenarios this will grow linearly and will eventually breach D1 per-request row limit (D1 returns at most 10 000 rows per .all()) or exhaust Worker memory.
- fix: Push the timestamp predicate and a LIMIT into SQL. In packages/db/src/scenarios.ts:getFriendScenariosDueForDelivery, replace the current query with: `SELECT * FROM friend_scenarios WHERE status = 'active' AND next_delivery_at IS NOT NULL AND next_delivery_at &lt;= ? ORDER BY next_delivery_at ASC LIMIT 200` and bind the `now` parameter. Drop the JS `.filter()` and `.sort()` on the result — SQLite handles ISO 8601 strings with +09:00 offsets correctly in lexicographic comparison. The LIMIT 200 is a safe ceiling for one 5-minute cron tick; the next tick will process the remaining batch (since delivered rows advance their next_delivery_at or complete). Add a unit test in packages/db/__tests__/sc

### A11. [HIGH] getDueReminderDeliveries: unbounded SELECT on friend_reminders + N+1 queries for every active reminder
- `packages/db/src/reminders.ts:127` | category=reliability | launchBlocking=true | autofixSafe=true
- evidence: SELECT fr.* FROM friend_reminders fr ... WHERE fr.status='active' AND r.is_active=1 — no LIMIT. Then for every row: getReminderSteps (1 query) + SELECT friend_reminder_deliveries (1 query). At N active reminders this is 1 + 2N D1 round-trips per cron tick. D1 free-tier has a per-request time budget; this will start failing silently as the reminder base grows.
- fix: Three independent, stackable fixes — all are migration-free, secret-free, and live-safe (they only reduce/shift which D1 work happens; they cannot change which messages are delivered):  1. Push time filtering into SQL. The `now` parameter is already threaded through but unused in the query. Add `AND (datetime(fr.target_date, '+' || rs.offset_minutes || ' minutes') <= ?)` to the outer JOIN (joining reminder_steps inline) so only rows with at least one due step are returned. This requires joining reminder_steps in the outer query, which also eliminates the getReminderSteps N+1.  2. Add LIMIT + offset/cursor. Add `ORDER BY fr.created_at LIMIT 100` (or a configurable constant) to the outer query

### A12. [HIGH] processSubscriptionReminders: no atomic claim — concurrent cron runs can double-send to the same reminder
- `apps/worker/src/services/subscription-reminder.ts:135` | category=reliability | launchBlocking=true | autofixSafe=true
- evidence: SELECT LIMIT 50 with WHERE next_reminder_at <= ? fetches rows. Two concurrent Workers (multi-account loop creates one job per token) will both pick up the same reminder rows. next_reminder_at is only advanced after successful push (line 262), so a race window exists between fetch and update where both workers send the LINE message before either writes the new next_reminder_at.
- fix: Add an atomic CAS claim to `processSubscriptionReminders` before any `dispatch()` call, mirroring the existing `claimFriendScenarioForDelivery` pattern.  Step 1 — DB layer (packages/db): Add a new exported function `claimSubscriptionReminderForSend(db, reminderId, observedNextReminderAt, leaseUntil)` that executes: `UPDATE subscription_reminders SET next_reminder_at = ? WHERE id = ? AND next_reminder_at = ? AND is_active = 1` Return `true` when `meta.changes === 1`, `false` otherwise. The `leaseUntil` value should be `now + interval_days * 86400000` (the real next interval) so no separate post-send UPDATE is needed when the claim succeeds — the claim IS the advance. If the claim returns `fal

### A13. [HIGH] reminder-delivery: no atomic claim between step detection and markReminderStepDelivered — concurrent workers can double-push reminder steps
- `apps/worker/src/services/reminder-delivery.ts:41` | category=reliability | launchBlocking=true | autofixSafe=true
- evidence: For each dueReminder, the code loops over step and calls lineClient.pushMessage then markReminderStepDelivered (INSERT OR IGNORE). If two Workers process the same friend_reminder concurrently, both will see the step as undelivered (delivered check was done during getDueReminderDeliveries before either INSERT), call pushMessage twice, then both INSERT OR IGNORE (second is silently dropped). The customer receives the message twice.
- fix: Mirror the atomic claim pattern already used in step-delivery.ts:152-165.  1. In `packages/db/src/reminders.ts`, add a new function `claimReminderStepDelivery(db, friendReminderId, reminderStepId): Promise&lt;boolean&gt;` that executes `INSERT OR IGNORE INTO friend_reminder_deliveries (id, friend_reminder_id, reminder_step_id) VALUES (?, ?, ?)` and returns `result.meta.changes === 1`. No migration needed — the table and UNIQUE constraint already exist (schema.sql:448-454).  2. In `apps/worker/src/services/reminder-delivery.ts`, inside the `for (const step of fr.steps)` loop, call `claimReminderStepDelivery` before `lineClient.pushMessage`. If it returns false, `continue` (another Worker alre

### A14. [HIGH] processAbTestSend: no atomic claim on status transition — duplicate status='sending' update followed by audience resolution race
- `apps/worker/src/services/ab-test.ts:162` | category=reliability | launchBlocking=false | autofixSafe=true
- evidence: updateAbTestStatus(db, abTestId, 'sending') is a plain UPDATE with no CAS guard, unlike the broadcast pattern which uses claimBroadcastForSending (WHERE status IN ('scheduled','draft')). If two cron invocations race on the same test (possible via multi-account loop), both succeed in setting status='sending' and both proceed to audience resolution and multicast, resulting in double-sends to the entire audience.
- fix: Mirror the claimBroadcastForSending CAS pattern from packages/db/src/broadcasts.ts:217-229.  1. Add a new DB function `claimAbTestForSending(db, id): Promise&lt;boolean&gt;` in packages/db/src/ab-tests.ts that issues:    `UPDATE ab_tests SET status = 'sending' WHERE id = ? AND status = 'scheduled'`    and returns `(res.meta?.changes ?? 0) === 1`.  2. In apps/worker/src/services/ab-test.ts, replace the unconditional `await updateAbTestStatus(db, abTestId, 'sending')` at line 162 with:    ```ts    const claimed = await claimAbTestForSending(db, abTestId);    if (!claimed) return (await getAbTestById(db, abTestId))!;    ```    This makes the claim atomic in D1/SQLite; the second concurrent call

### A15. [HIGH] AI自動応答のredactが痩せる/ダイエット/脂肪燃焼を素通りさせる (顧客送信前の唯一ゲートが不十分)
- `packages/ai-provider/src/redact.ts:22` | category=compliance | launchBlocking=true | autofixSafe=true
- evidence: PROHIBITED_PHRASES (redact.ts:22-50) は 治る/治す/治療/完治/効く/即効/病気が改善/医薬品/cure/heal のみで、ダイエットサプリ最頻の違反語『痩せる/やせる/ダイエット効果/脂肪燃焼/体重が減る/落とす/スリム』を一切含まない。これが workers-ai.ts:87 で顧客送信前に走る唯一の redaction。Workers AI(Qwen/Llama)が『naturism Blueを飲めば痩せます』を生成した場合、そのまま顧客へ届く。本番は Qwen primary 失敗→Llama fallback 運用が常態化しており(MEMORY 既知)、生成のブレで違反語が出る現実的リスクがある。
- fix: Add diet-violation terms to PROHIBITED_PHRASES in `packages/ai-provider/src/redact.ts` (after line 50). Specifically add: '痩せる', '痩せ', 'やせる', 'やせ', 'ダイエット効果', '脂肪燃焼', '体重が減', '体重を落', '体脂肪が', '引き締', '代謝が上が', 'スリム効果'. Exclude '脂肪を減らす' as a standalone entry because the 届出表示 "BMIが高めの方の腹部の脂肪を減らす" contains it as a legitimate quoted expression — use '脂肪燃焼' and '体脂肪が' instead which cover the violation pattern without touching the届出表示 quote.  TDD approach: add test cases in `packages/ai-provider/__tests__/redact.test.ts` (or create it if absent) for each new phrase — verify redactProhibitedPhrases('naturism Blueを飲めば痩せます') returns '[省略]ます' and that 'BMIが高めの方の腹部の脂肪を減らす' passes through unchanged. Also v

### A16. [HIGH] ai-ng-filter(痩せる/改善/向上を検出)が monitoring 専用で、AI応答をブロック・redactしない
- `apps/worker/src/services/ai-response.ts:297` | category=compliance | launchBlocking=true | autofixSafe=true
- evidence: ai-response.ts:283-308 で detectNgWords(result.text) を実行し ngResult.hasNg を得るが、hasNg=true でも console.warn(299)+conversation_logs記録のみで result.text をそのまま返す(302-307)。webhook.ts:924 が `buildAiMessage(aiResult.text)` で顧客へ送信。つまり ai-ng-filter.ts の NG_PATTERN(痩せる/やせる/改善/向上/即効性 等)は『送信後の監視』であって防御ではない。redactの抜けを ai-ng-filter が補える設計なのに繋がっていない。
- fix: In `apps/worker/src/services/ai-response.ts` at lines 297–307, inside the `if (ngResult.hasNg)` branch, replace the raw `result.text` with `FALLBACK_MESSAGE` before returning. The return value becomes `{ text: FALLBACK_MESSAGE, layer: 'ai', model: result.model, ngDetected: ngResult.detected }`. The `conversation_logs` INSERT that precedes this branch already records the original AI text in `aiResponse` for audit purposes — that log call should remain unchanged so the raw output is preserved for review. No migration is required (schema unchanged). No secret change. Behaviour is safety-narrowing: legitimate compliant responses are not affected; only responses that already triggered a complianc

### A17. [HIGH] LINE token refresh fetch にタイムアウトなし — cron 全体が無期限ハング
- `apps/worker/src/services/token-refresh.ts:40` | category=reliability | launchBlocking=true | autofixSafe=true
- evidence: const res = await fetch('https://api.line.me/v2/oauth/accessToken', { method: 'POST', ... }); — AbortController/signal なし。他の Shopify fetch (shopify-token.ts:125, friend-customer-linker.ts:180 等) はすべて AbortController + setTimeout(5~8s) を持つが issueNewToken だけ素の fetch。LINE API endpoint が応答しないと Worker の 30s CPU limit まで cron ハング。
- fix: In `issueNewToken` (`apps/worker/src/services/token-refresh.ts`), mirror the pattern already used in `shopify-token.ts:124-140`: create an `AbortController`, schedule `setTimeout(() => controller.abort(), 5_000)` (5 s is appropriate; LINE's token endpoint is a simple credential exchange), pass `signal: controller.signal` to `fetch`, and call `clearTimeout` in a `finally` block. The `catch` in `refreshLineAccessTokens` already wraps each account call, so an aborted fetch will be caught, logged, and the loop will continue to the next account without disrupting other cron jobs. Add a unit test that asserts the `AbortSignal` is passed to the underlying fetch mock (analogous to the `bound` name c

### A18. [HIGH] ad-conversion.ts の全外部 fetch (Meta/X/Google/TikTok CAPI) にタイムアウトなし
- `apps/worker/src/services/ad-conversion.ts:115` | category=reliability | launchBlocking=true | autofixSafe=true
- evidence: sendMetaConversion (line 115), sendXConversion (line 146), sendGoogleConversion (line 179), sendTikTokConversion (line 218) の各 fetch はすべて signal なし。sendAdConversions は event-bus の phase1 (Promise.allSettled) 内から呼ばれるため、いずれかの広告 API が hang すると phase1 全体が Worker 上限まで待機し、phase2 (automations) の実行が遅延または消滅する。
- fix: Add a shared helper fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 5000): Promise&lt;Response&gt; at the top of ad-conversion.ts. Inside it create an AbortController, call setTimeout(() =&gt; controller.abort(), timeoutMs), and pass { ...init, signal: controller.signal } to fetch. Replace the bare fetch() calls at lines 115, 146, 179, and 218 with fetchWithTimeout(url, { method: 'POST', headers: ..., body: ... }, 5000). Wrap the abort-path in a clearTimeout to avoid timer leak. The catch block in sendAdConversions (lines 69-79) already calls logAdConversion with status 'failed', so an aborted fetch will be caught and logged without any schema or secret change. TDD: write a Vite

### A19. [HIGH] event-bus.ts の outgoing webhook fetch にタイムアウトなし
- `apps/worker/src/services/event-bus.ts:159` | category=reliability | launchBlocking=false | autofixSafe=true
- evidence: await fetch(wh.url, { method: 'POST', headers, body }); — isSafeUrl チェックは通過するが signal なし。SSRF 対策は実装済だが、外部 webhook endpoint が遅い場合は fireOutgoingWebhooks 全体がハングする。同じく executeAction の send_webhook (line 374) も signal なし。Promise.allSettled で包まれるが Worker の CPU time を消費する。
- fix: Add a shared helper (e.g. `fetchWithTimeout(url, init, ms = 5000)`) that creates an AbortController, attaches its signal to the RequestInit, and calls `controller.abort()` via `setTimeout`. Apply it at both call sites: line 159 in fireOutgoingWebhooks and line 374 in the send_webhook case of executeAction. Both callers already have per-iteration try/catch so an AbortError will be caught and logged without breaking the loop. No migration, no secret change, no D1 schema touch required. TDD path: add a vitest test that mocks `fetch` with a delayed Promise and asserts the call rejects within ~5 s (use fake timers). Choose 5 s as the timeout — tight enough to stay well under Cloudflare's 30 s CPU

### A20. [MEDIUM] processNotifications: rule.channels の JSON.parse が try/catch なし — 不正 JSON でループ全体が abort
- `apps/worker/src/services/event-bus.ts:484` | category=reliability | launchBlocking=false | autofixSafe=true
- evidence: let channels: string[] = JSON.parse(rule.channels); — この行は外側の try/catch (line 477) に包まれているが、rule 単位の隔離はなく、1件の rule の channels が不正 JSON ならその rule 以降の全 rule が処理されない（outer catch が processNotifications 全体を exit する）。processAutomations は per-row try/catch があるが processNotifications は for ループ全体を single try/catch で包んでいるだけ。
- fix: Mirror the `processAutomations` per-row pattern. Wrap the body of `for (const rule of rules)` (lines 484–504) in its own `try/catch`, logging `rule.id` and the error on failure and continuing to the next rule. No migration, no secret change, no customer-facing path change, and no change to LINE message delivery logic. The outer try/catch (lines 477/506–508) should be retained for failures in `getActiveNotificationRulesByEvent` itself. TDD: add a Vitest unit test that passes a rules array where the first rule has malformed `channels` JSON (`"not-json"`) and a valid second rule, then asserts `createNotification` is called exactly once (for the second rule) and `console.error` is called once — 

### A21. [HIGH] orders/paid webhook member-sync wiring (live money path) has no integration test
- `apps/worker/src/routes/shopify-phase2a.ts:543` | category=test-gap | launchBlocking=false | autofixSafe=true
- evidence: Payment webhook runs syncOrderToMember (addPurchaseEvent, members.total_purchase_jpy increment, tier promote) via executionCtx.waitUntil at L543-570, amountJpy from Number(body.total_price) L457/L551. shopify-phase2a.test.ts never references syncOrderToMember/addPurchaseEvent/waitUntil; asserts only the sync response. Service covered in shopify-order-member-sync.test.ts but the webhook wiring is not, so a field-name or friendId mistake leaves tests green while loyalty accrual silently breaks.
- fix: Add `vi.mock('../services/shopify-order-member-sync.js', ...)` to `shopify-phase2a.test.ts` using `vi.hoisted` to produce a `mockSyncOrderToMember` spy. In the existing "creates payment_notification log on orders/paid" test, capture the `waitUntil` promise by mocking `executionCtx` (or simply resolving the async branch by returning the mock synchronously), then assert `mockSyncOrderToMember` was called exactly once with `{ shopifyOrderId: '5551234567890', amountJpy: 3980, currency: 'JPY', existingFriendId: null, source: 'webhook' }`. Add a second test variant where `mockGetShopifyOrderByShopifyId` returns a row with `friend_id: 'f-existing'` to verify the `existingFriendId` wiring path. Both

## 付録B: MEDIUM/LOW findings (42)

- B1. [MEDIUM] security fix=true `apps/worker/src/routes/liff.ts:292` — OAuth /auth/callback accepts unvalidated uid query-param and links it as user UUID without DB existence check
- B2. [MEDIUM] security fix=true `apps/worker/src/middleware/auth.ts:62` — Empty-string API_KEY is accepted as valid owner credential
- B3. [MEDIUM] security fix=true `apps/worker/src/middleware/rate-limit.ts:65` — Several public bypass paths lack IP-keyed rate limiting (email/unsubscribe, email/resubscribe, stripe webhook, resend webhook, /auth/callback)
- B4. [LOW] security fix=true `apps/worker/src/routes/liff.ts:224` — LINE token exchange error body logged to console — may expose LINE error details in aggregated logs
- B5. [MEDIUM] security fix=false `apps/worker/src/routes/forms.ts:183` — POST /api/forms/:id/submit: 無認証で friendId/lineUserId を自称できる（LIFF 外からの偽装）
- B6. [MEDIUM] reliability fix=false `apps/worker/src/middleware/liff-auth.ts:67` — liffAuthMiddleware: POST body の idToken 読み取りが後続 handler でボディを消費する問題の潜在リスク
- B7. [MEDIUM] data-integrity fix=true `apps/worker/src/routes/liff-portal.ts:1760` — PUT /api/liff/subscriptions/:id: intervalDays に上限・型チェックなし
- B8. [MEDIUM] reliability fix=true `apps/worker/src/routes/webhook.ts:556` — daily_tip postback silently drops replyToken on exception — user gets no response
- B9. [LOW] code-smell fix=true `apps/worker/src/routes/webhook.ts:644` — Redundant dynamic import of step-delivery.js inside vi.mock-sensitive text handler
- B10. [MEDIUM] correctness fix=true `apps/worker/src/services/event-bus.ts:287` — score_threshold automation condition silently passes when payload has no friendId
- B11. [MEDIUM] data-integrity fix=true `packages/db/src/shopify.ts:35` — upsertShopifyOrder UPDATE path silently drops total_price, line_items, email, phone, order_number on orders/updated
- B12. [MEDIUM] data-integrity fix=false `apps/worker/src/routes/shopify-phase2a.ts:551` — amountJpy: totalPrice ?? 0 silently records ¥0 purchase event when total_price absent from orders/paid payload
- B13. [MEDIUM] reliability fix=true `apps/worker/src/routes/shopify-phase2a.ts:166` — parseWebhookBody returns {body:{}, valid:false} with no console.error when signing secret is absent — inconsistent with shopify.ts 500 path
- B14. [MEDIUM] reliability fix=false `packages/db/src/broadcasts.ts:34` — getBroadcasts: unbounded SELECT fetches entire broadcasts table each cron tick
- B15. [MEDIUM] reliability fix=false `packages/db/src/ab-tests.ts:87` — getAbTests: unbounded SELECT fetches entire ab_tests table each cron tick
- B16. [MEDIUM] correctness fix=false `apps/worker/src/index.ts:404` — multi-account loop creates duplicate jobs that share the same D1 DB — loyalty/membership/birthday crons run N times (once per account token)
- B17. [MEDIUM] reliability fix=false `apps/worker/src/services/birthday-cron.ts:94` — birthday-cron: unbounded SELECT on friends table with no LIMIT
- B18. [MEDIUM] reliability fix=false `apps/worker/src/services/loyalty-rank-cron.ts:115` — loyalty-rank-cron and membership-promotion-cron: unbounded SELECT on members table — no LIMIT, no pagination
- B19. [MEDIUM] reliability fix=false `apps/worker/src/services/tag-elapsed-delivery.ts:68` — tag-elapsed-delivery: LIMIT 100 per rule but no atomic claim before pushMessage — concurrent workers can double-send
- B20. [MEDIUM] reliability fix=false `packages/db/src/shopify-phase2a.ts:94` — getPendingAbandonedCarts: no LIMIT — unbounded SELECT on abandoned_carts
- B21. [MEDIUM] compliance fix=true `apps/worker/src/services/ai-response.ts:136` — system promptがBlue(非・機能性表示食品)を『脂肪・糖質の吸収を抑える基盤モデル』と効能断定
- B22. [MEDIUM] compliance fix=true `apps/worker/src/services/monthly-broadcast-postback.ts:798` — 月次broadcast詳細に体感効果を示唆する文面 (翌日が違う実感の声 / 翌朝がラク)
- B23. [LOW] compliance fix=true `apps/worker/src/routes/liff-pages.ts:2056` — LIFF既定FAQの返品ポリシーが公式と矛盾(7日)+『効果的ですか』表現
- B24. [LOW] code-smell fix=false `apps/worker/src/services/analytics.ts:26` — GA4 サーバーサイド送信機能(analytics.ts)が完全に未配線の死コード
- B25. [MEDIUM] code-smell fix=false `apps/worker/src/services/email-opt-in.ts:34` — hmacSha256Hex + constantTimeEqual が3ファイルに完全重複コピー
- B26. [LOW] code-smell fix=false `apps/worker/src/routes/liff-pages.ts:7` — escapeHtml ヘルパーが14ファイルにコピペ重複
- B27. [LOW] code-smell fix=true `apps/worker/src/services/stealth.ts:92` — StealthRateLimiter クラスが未使用(死コード)
- B28. [LOW] code-smell fix=true `apps/worker/src/services/translate.ts:71` — batchTranslate が未使用(死コード)
- B29. [LOW] code-smell fix=true `apps/worker/src/services/audit-logger.ts:153` — auditApi が未使用(死コード)
- B30. [LOW] code-smell fix=true `apps/worker/src/services/product-display.ts:168` — sendPostPurchaseRecommendations が未使用(死コード)
- B31. [LOW] code-smell fix=false `apps/worker/src/routes/liff-portal.ts:1` — 巨大ファイル群(800行超が10ファイル、最大 liff-portal.ts 2407行)
- B32. [MEDIUM] launch-gap fix=false `package.json:11` — admin web Pages deploy not run
- B33. [LOW] launch-gap fix=false `apps/worker/src/services/product-display.ts:99` — Restock card only sent via recommendations
- B34. [MEDIUM] reliability fix=true `apps/worker/src/services/ban-monitor.ts:56` — ban-monitor.ts の LINE API fetch にタイムアウトなし
- B35. [MEDIUM] reliability fix=true `apps/worker/src/services/shopify-customer-sync.ts:84` — shopify-customer-sync.ts のページネーション fetch にタイムアウトなし
- B36. [MEDIUM] reliability fix=true `apps/worker/src/services/subscription-reminder.ts:177` — subscription-reminder.ts: loadCrossSellEntries の silent empty catch でエラーが観測不能
- B37. [MEDIUM] reliability fix=true `apps/worker/src/services/google-calendar.ts:38` — google-calendar.ts: GoogleCalendarClient の全 fetch にタイムアウトなし
- B38. [LOW] reliability fix=false `apps/worker/src/services/account-link.ts:183` — account-link.ts: ResendClient 構築時に RESEND_API_KEY='' で throw する経路 — line 213 ガードが前提
- B39. [LOW] reliability fix=true `apps/worker/src/services/logger.ts:96` — logger.ts: Axiom/Discord への fetch にタイムアウトなし (waitUntil fire-and-forget)
- B40. [MEDIUM] test-gap fix=true `apps/worker/src/routes/webhook.ts:477` — webhook postback dispatch (restock #117) untested; postback.test.ts is a no-op
- B41. [MEDIUM] test-gap fix=true `apps/worker/src/routes/shopify-phase2a.ts:398` — inventory webhook notify loop (consume-on-success + blacklist skip) untested in waitUntil
- B42. [LOW] test-gap fix=true `apps/worker/src/middleware/auth.ts:16` — auth skip allowlist has no negative over-match 401 test

---

## 修正状況 (2026-06-15 自律ラン)

レビュー後、 launch-blocker + 高優先 reliability を TDD + 並列 adversarial review + gated PR で修正・merge・本番 auto-deploy 済 (deploy-worker.yml)。

| PR | 内容 | カバーした finding |
|---|---|---|
| #120 | security: reorder IDOR / CORS echo / liff profile列挙 / 空API_KEY | B1, B5, A2, A4, auth.ts:62 |
| #121 | 薬機法: AI応答NG語ブロック + redact拡充 + 効能文言 | B2, A15, A16, B21, B22, B23 |
| #122 | correctness: intent上書き防止 / purchase多重発火 / event-bus・upsert堅牢化 | B3, B4, A8, B10, B11, B20 |
| #123 | reliability: 外部fetch全件 timeout + silent catch可観測化 | A17, A18, A19, B34-B39 |
| #124 | cron atomic claim: ab-test / reminder-delivery / subscription-reminder | A12, A13, A14 (B6-B8) |
| (本PR) | 死コード削除: StealthRateLimiter/batchTranslate/auditApi/sendPostPurchaseRecommendations | B27, B28, B29, B30 |

**Launch 判定: 単一アカウント (naturism) は GO**。 上記で B1-B5 (CRITICAL×1 + HIGH×4) + timeout + cron claim を解消。

### 残: Katsu 承認ゲート (autofixSafe=false)
1. **admin web (Cloudflare Pages) の再deploy** — naturism-admin.pages.dev が #114-#119 前の stale ビルド (新オペレーターUIが未反映)。修正経路確定済 (`pnpm --filter web build` → `wrangler pages deploy out --project-name=naturism-admin`)。build は検証済 (全ページ static export 成功)。**publish行為のため要 Katsu 実行**。恒久対策= deploy-web.yml CI 追加 (要 project名確認)。
2. **forms /submit 無認証** (B5/forms.ts:183) — 公開フォームを使うなら friendId 自称対策が要 (挙動変更のため要判断)。
3. **/auth/callback uid 無検証** (A6/liff.ts:292) — 既存リンクデータ影響確認の上で existence check 追加。
4. **amountJpy ¥0 記録** (B12/shopify-phase2a.ts:551) — money path のため early-return ガード or 再fetch を判断。
5. **multi-account 重複 cron** (B16/index.ts:404) — 第2ブランド追加時に LINE非依存 cron をループ外へ。
6. **gated 有効化**: SHOPIFY_LINE_NOTIFY_ENABLED (再入荷, カットオーバー当日) / RANK_DISCOUNT_ENABLED / MEMBER_BACKFILL_ENABLED。

### 残: post-launch backlog (autofixSafe だが launch非ブロッカー)
- cron unbounded SELECT に LIMIT (scenarios/reminders P2 + broadcasts/ab-tests/birthday/loyalty-rank/abandoned-carts) — launch スケール (数千friend) 前に。
- 巨大ファイル分割 (liff-portal.ts 2407行ほか10ファイル) / コード重複統合 (hmacSha256Hex×3, escapeHtml×14, 互換性test先行) / ad-conversion の Promise.allSettled 化。
- テスト追加: orders/paid member-sync wiring / restock postback / inventory notify loop。
