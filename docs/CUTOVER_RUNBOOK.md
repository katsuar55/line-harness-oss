# 本番カットオーバー Runbook — DMMチャットブースト → LINE Harness (2026-06-12)

DMM を解約し本番 OA を Harness に切り替える当日の作業手順書。**上から順に実行**。
🔴 = Katsu の明示承認が必要 / 🟢 = 自律実行可 / ⏱ = ダウンタイムに影響。

> 前提（確定済）: 本番 OA は **認証済(緑バッジ)** / Messaging API ch + LINE Login ch **準備済・同一 provider** / 友だちは OA 帰属で DMM 解約後も残る / webhook は 1ch=1URL なので **ハードカットオーバー**。

---

## A. 事前準備（T−1日、ダウンタイムなし）

> **🟢 自律分の現状（2026-06-16 実測・検証済）**: A-3 / A-4 の seed はほぼ投入済み（#117 再入荷 / #119 FAQ v3 等）。
> 当日は **`node scripts/cutover-prep-A.mjs`**（read-only 監査ランナー）で go/no-go を一発確認すること。
> `API_KEY=xxx node scripts/cutover-prep-A.mjs` で A-5 webhook 購読も検証（`--register` で不足分を登録）。
> 実測サマリは [`docs/CUTOVER_PREP_A_STATUS.md`](CUTOVER_PREP_A_STATUS.md)。

### A-1. 🟢 コード確定 + テスト worker へ deploy
- [ ] main が全 PR merge 済み・`pnpm preflight` All green
- [ ] `pnpm --filter worker run deploy`（post-deploy-check で bundle 一致確認）
- [ ] 本番 smoke: `curl -s https://naturism-line-crm.katsu-7d5.workers.dev/ | grep 'src="/assets/'`（200 + bundle ID）

### A-2. 🔴 本番 secret 差し替え（`wrangler secret bulk` JSON、`"値"|put` の `\r` trap 回避）
本番 OA のチャネル値に差し替える（テスト OA の値から）:
```
LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN   # 本番 Messaging API ch
LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET  # 本番 LINE Login ch (同一provider)
LIFF_URL                                           # 本番 LIFF の https://liff.line.me/<id>
```
- [ ] 🔴 Katsu から本番チャネル値を受領 → `wrangler secret bulk secrets.json`（投入後 secrets.json は即削除）
- [ ] `VITE_LIFF_ID` を local `.env` + GitHub repo vars 両方更新 → admin web rebuild（preflight は missing は弾くが **stale-but-valid は弾かない**ので人手確認）

### A-3. 🟢 migration 065（再入荷 inventory_item_id）を本番 D1 に適用
state drift 回避のため `migrations apply` でなく直接実行（[[feedback_d1_migrations_state_drift]]）:
```
cd apps/worker && npx wrangler d1 execute <DB> --remote --file ../../packages/db/migrations/065_restock_inventory_item.sql
```
（wrangler d1 は apps/worker cwd から。root + --config は 7403 で fail）

### A-4. 🟢 本番ブランド seed 投入
- [ ] welcome scenario / 基本タグ / automations / templates / monthly broadcast（テスト OA で使っていた構成を本番 D1 へ）
- [ ] キーワード自動応答（auto_replies）の必須 FAQ を投入（営業時間/返品/配送/定期解約 等）← #10 のブランド FAQ
- [ ] リッチメニューを **Messaging API で作成のみ**（まだ set default しない）

### A-5. 🟢 Shopify webhook 購読（再入荷の駆動に必須）
- [ ] `POST /api/integrations/shopify/webhooks/register`（inventory_levels/update を含む9 topic を登録）
- [ ] 商品同期 → `shopify_products.variants_json` に inventory_item_id が入っていることを確認（再入荷の照合キー）

### A-6. 🔴 OA Manager 設定確認（公式仕様で確定済、二重返信防止）
- [ ] Business Manager 連携済み（2026-03 から日本の全 OA で必須化）
- [ ] 応答設定: **チャットON（手動のみ）+ 応答メッセージ OFF + あいさつメッセージ OFF + AIチャットボット不使用**（ネイティブ自動応答と webhook bot の二重返信はプラットフォームで防がれない）

---

## B. カットオーバー（深夜・低トラフィック、⏱ここから切替）

### B-1. ⏱🔴 Webhook URL 切替（DMM → Harness）
- [ ] LINE Developers Console > Messaging API設定 > Webhook URL = `https://<worker>/webhook` → **検証** → Use webhook **ON**
- [ ] OA Manager の応答設定で Webhook **ON**（DMM が握っていた webhook がこの瞬間 Harness へ移る = DMM 機能停止）

### B-2. 🟢 LINE Login / LIFF の URL 整合
- [ ] LINE Login ch コールバック = `https://<worker>/auth/callback`
- [ ] LIFF endpoint = worker URL（マイランク等の LIFF が本番 OA で開けること）

### B-3. 🟢 友だち一括投入（認証済 OA なので全件取得可）
- [ ] `POST /api/friends/import-followers`（まず `{dryRun:true}` で件数確認 → 本番実行、resumable cursor で全件）
- [ ] getProfile で表示名補完、Shopify order-email-match で順次リンク

### B-4. 🟢 リッチメニュー有効化
- [ ] harness から `Set default rich menu`（A-4 で作成したメニューを既定化 = 旧 DMM メニュー上書き）

### B-5. 🔴 gated 機能の本番有効化（顧客影響・money path のため個別承認）
| フラグ | 現状 | 内容 | 有効化判断 |
|---|---|---|---|
| `SHOPIFY_LINE_NOTIFY_ENABLED` | 設定済(値要確認) | 再入荷/発送通知の LINE 送信 | 🔴 再入荷を使うなら `true` 確認 |
| `RANK_DISCOUNT_ENABLED` | 未設定(off) | 会員ランク割引コードの本番発行(money) | 🔴 承認後 `true` |
| `MEMBER_BACKFILL_ENABLED` | 未設定(off) | 過去注文 backfill(rank の母数) | 🔴 承認後 `true`(要 read_all_orders scope) |
| `FRIEND_LINK_ENABLED` | 設定済 | metafield 自動リンク cron | 現状維持 |
| `ACCOUNT_LINK_ENABLED` | 設定済 | LIFF+OTP 自己連携 | 現状維持 |

---

## C. 検証（B 直後、テスト友だち=自分で実機 e2e）
- [ ] follow → welcome（ネイティブあいさつと二重で来ないこと）
- [ ] キーワード送信 → 自動応答（auto_replies）
- [ ] 曖昧な質問 → AI 自動応答（reply token・通数ゼロ）
- [ ] リッチメニュータップ → 各導線
- [ ] マイランク LIFF → ランク表示（+ gated 有効時はランク割引コード）
- [ ] 在庫切れ商品カード → 「🔔再入荷お知らせ」→ 登録返信 → （在庫補充で）再入荷通知
- [ ] broadcast / scenario / 販促配信 / A-Bテスト / フォーム回答 / CV計測

## D. 監視（24–48h）
- [ ] webhook error 率 / 2秒以内 2xx / 署名検証 OK
- [ ] `conversation_logs.ai_model`（AI silent fallback 監視）
- [ ] `cron_run_logs` / audit_logs の異常がないこと
- [ ] Discord アラート（BAN/quota/cron-monitor）

## E. 🔴 DMM 解約
- [ ] C/D が安定確認できたら DMM チャットブーストを解約（友だちは OA に残るため失われない）

---

## F. ロールバック（B で本番が壊れた場合、[[project_current_state]] の事故教訓）
1. LINE Developers Console の Webhook URL を **DMM の URL に戻す**（DMM 復帰）or Use webhook OFF
2. 直近 deploy 起因なら `wrangler rollback` または前 commit checkout → 再 deploy
3. 復旧後 `curl ... | grep 'src="/assets/'` で bundle ID 変化を確認（CDN キャッシュは数十秒）

---

## G. broadcast「sending」 stuck 復旧手順（Codex review #4、 2026-06-26）
予約 broadcast は claim(status→`sending`) 後に worker が crash すると **永久 stuck**（cron は `scheduled` しか拾わない）。二重送信を避けるため **auto-reset しない**設計なので、検知時は手動復旧する。

1. **検知**: worker log `[broadcast] N broadcast(s) stuck in 'sending' >30min` / audit `action='broadcast.stuck_sending_detected'`（cron-monitor でも可視化）。対象 ID は audit の `metadata.ids`。
2. **実送信されたか確認**（dup 送信回避の要）:
   - LINE(all): `SELECT line_request_id FROM broadcasts WHERE id='<id>'` → **NOT NULL なら送信済**。
   - LINE(tag/multicast): `SELECT COUNT(*) FROM messages_log WHERE broadcast_id='<id>'` → **>0 なら一部以上送信済**。
   - email: `SELECT status, COUNT(*) FROM email_messages_log WHERE broadcast_id='<id>' GROUP BY status` → sent/delivered があれば送信済。
3. **復旧**:
   - 未送信が確実（上記すべて 0）→ `UPDATE broadcasts SET status='draft' WHERE id='<id>' AND status='sending';`（次回手動送信で再実行）。
   - 既に送信済 → `UPDATE broadcasts SET status='sent', sent_at=<JST ISO> WHERE id='<id>' AND status='sending';`（再送しない）。
   - 不明なら触らず調査（Cloudflare ログで crash 時刻特定）。
4. **⚠️ dup 送信警告**: multicast は per-batch dedup なし。一部送信済で `draft` に戻すと既送 friend へ再送される。**送信済が疑われるなら `sent` 化を優先**。

## H. dedup テーブル確認（Codex review #5、 2026-06-26）
- [ ] `webhook_deliveries` が本番 D1 に存在（migration 066）: `SELECT COUNT(*) FROM webhook_deliveries;`（=二重 fireEvent 防止が機能する前提。 未適用でも fail-open で動くが dedup は無効化される）

## 既知の deferred 事項（Codex review 2026-06-26、 launch ブロッカーではない）
- **multi-account 前提**（#1/#6）: 現状 `line_accounts`=0 の**単一アカウント**前提。**2nd LINE アカウント追加前**に broadcast の `line_account_id` scoping + destination 必須化が必要（未対応で 2nd を足すと token mismatch / 誤配信）。
- **broadcast 全件ロード**（#3）: `getBroadcasts` が unbounded（現 14 行で軽微）。volume 増加前に `WHERE status='scheduled' AND scheduled_at<=? LIMIT` の bounded query へ。
- **forms 公開前**（#7/#8）: `POST /api/forms/:id/submit` は public・rate-limit なし。**forms を実運用する前**に Turnstile / rate-limit + PII 再掲（確認 push）の方針確定。
- **PII ログ運用**（#13/#14）: messages_log / conversation_logs に生テキスト（住所/電話/注文番号等）が残りうる。**保持期間・閲覧権限・外部ログ(Discord/Axiom)へ生 PII を出さない方針**を Katsu 判断で定義（CRM の本質機能のため write 時 redaction は非推奨）。
- **`target_type='all'` 全員配信**（#2、 対処済の補足）: 既定で**無効**（`BROADCAST_ALL_ENABLED` 未設定）。正式な全員配信が必要なら friend 列挙 + `is_blacklisted` 除外の multicast 実装を post-launch で。

---

## 付録: 当日 Katsu 承認チェックポイント（🔴 一覧）
A-2 本番secret受領 / A-6 OA Manager設定 / B-1 Webhook切替(=DMM停止) / B-5 gated有効化(money) / E DMM解約
