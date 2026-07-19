# Phase 3 自社課金基盤 設計書 v5 (WI-3) — Huckleberry 卒業

2026-07-19: R1 (58 findings) → v2 → R2 (55) → v3 → R3 (51) → v4 → R4 (28) → **v5**。
Ultraplan (docs/SUBSCRIPTION_ULTRAPLAN_2026-07-14.md) WI-3 成果物。WI-4 (実装)・WI-5 (移行) の正。

## 0. 目的と非スコープ

**目的:** サブスク契約・課金サイクルを自社 custom app が所有し、Huckleberry ($49/月+1%) を
解約する。LINE トーク内でスキップ/日付変更/一時停止/解約/支払リカバリが完結する。
**非スコープ:** 独自決済ゲートウェイ、周期変更 UI、HB 既存注文の改変。
**サポート範囲:** interval は **DAY のみ** (実契約は全て「30日に1回」)。WEEK/MONTH 契約が
現れたら移行保留リスト行き (月末日算術等の未定義問題を持ち込まない)。

## 1. 前提 (shopify.dev 突合済み確定事実)

| 項目 | 事実 |
|---|---|
| サイクル構造 | cycle は**契約作成時点から index** (安定 ID、編集でもリセットされない)。境界も作成時点起点。`billingAttemptExpectedDate` = サイクル終端 =「次のお届け期間分をサイクル末に課金」モデル |
| cadence 制御 | `subscriptionBillingCycleScheduleEdit(selector:{index}, input:{billingDate})` で**任意の単一サイクル**の課金日を変更可能 (実例確認済)。→ 作成時刻/anchors 整合に依存せず、エンジンが毎サイクル明示スケジュール (§4.0)。anchors (WEEKDAY/MONTHDAY/YEARDAY のみ、DAY 不可) には依存しない |
| attempt | `subscriptionBillingAttemptCreate` + idempotencyKey (Shopify exactly-once) + billingCycleSelector{index}。**expectedDate の 24h 以上前は BILLING_CYCLE_CHARGE_BEFORE_EXPECTED_DATE (BCCBED) で同期拒否。過去日への attempt は拒否されない (overdue 課金は正常系)**。他の同期 userError: THROTTLED / CONTRACT_PAUSED / CONTRACT_TERMINATED / CONTRACT_UNDER_REVIEW |
| 3DS | **billing_attempts/challenged webhook は attempt が 3DS 要求になった時点で届く (一次検出)。その後の success/failure は顧客が認証を完了するまで届かない**。nextActionUrl は attempt 照会で取得 |
| skip | scheduleEdit(input:{skip:true}) / unskip。webhook cycles/skip・unskip |
| 失敗 code | SubscriptionBillingAttemptErrorCode 55 値。PAUSED への attempt は拒否されない |
| 支払方法 | vault はアプリ横断利用可 (要 read_customer_payment_methods)。**新規 vault は契約に自動紐付かない** → `subscriptionContractUpdate` (draft flow) で差替。**API vault 不可** (storefront checkout / 新カスタマーアカウント UI のみ) |
| atomicCreate | status:PAUSED で作成可。lines に customAttributes を持てる (移行 intent マーカーに利用 §7) |
| webhook | billing_attempts/{success,failure,challenged}・contracts/{activate,pause,cancel,update}・cycles/{skip,unskip}・customer_payment_methods/{create,update} |
| Huckleberry | own-scope で API 停止不可 (管理画面/顧客のみ)。タグは contract_id 付き (`subscription-{ID}-cancel`) |
| 現況 | 76件 / MRR ¥131k / 30日 DAY interval / 決済失敗=自動停止運用 / マイページ締切=決済3日前 |
| 環境 | Workers Free 50 subrequests/invocation → 全経路チャンク (WI-6 パターン) |

## 2. アーキテクチャと WI-1/2 接続

```
LINE postback (skip/date/pause/cancel) ─┐
webhook (attempts/contracts/cycles/pm) ─┼→ CF Workers ─ own SubscriptionContract
own-billing cron (5分 tick、§5) ────────┘        │
                                          D1: own_sub_contracts / billing_cycle_claims /
                                              sub_migration_snapshots
```

- **サイクルの正は Shopify**。D1 は現在サイクル (cycle_index + scheduled_date) のキャッシュ。
  日次 + 全 webhook + 全操作後に照会再同期 (self-heal 可能)
- **WI-1/WI-2 接続 (責務分界)**:
  - リマインド (4日前): WI-2 cron が旧 read-model の `migrated_to` 列で own_sub_contracts に
    切替して読む。**印字は hb_stop_requested 時** (activated まで待つと停止〜activate の窓で
    旧経路が cancel タグに反応して沈黙/誤発火する)。**rolled_back で消印**。
    二重送信はリマインド claim を own 側と共有 (同一 contract×サイクル 1 通) で防止
  - リカバリ/dunning 通知: **own-billing が送信責務** (WI-2 の文言 builder のみ共有)。
    Huckleberry タグ駆動の WI-2 検知は migrated_to でスキップ
  - **通知チャネル規則**: LINE 連携済み → LINE。**dispatch 結果 failed/skipped (ブロック等) と
    未連携 → email fallback** (既存 Round4 email 基盤。連携済みブロック顧客の全チャネル沈黙を
    防ぐ)。dunning email 内のリンクは `/my/subscription` の**入口 (メール入力ページ)** —
    magic link 15分 TTL はメール入力後に発行されるため到達時間と衝突しない。
    **例外: challenge_link (3DS 認証依頼) のみ Shopify の nextActionUrl を直送**
    (認証は Shopify 側セッションで完結するためマイページを経由しない)

## 3. データモデル (migration 071〜)

```sql
CREATE TABLE own_sub_contracts (
  contract_gid        TEXT PRIMARY KEY,
  shopify_customer_id TEXT NOT NULL,
  status              TEXT NOT NULL,          -- active|paused|cancelled|expired|failed
  current_cycle_index INTEGER,                -- 最古の未解決サイクル (§4.0)
  current_cycle_scheduled_date TEXT,          -- scheduleEdit 済み課金予定日 (JST)
  anchor_date         TEXT NOT NULL,          -- カデンツ起点 (承継課金日 or 初回課金日)
  interval_unit       TEXT NOT NULL,          -- 'DAY' のみサポート (§0)
  interval_count      INTEGER NOT NULL,
  payment_method_gid  TEXT,
  pending_new_card    INTEGER NOT NULL DEFAULT 0,  -- challenged 中のカード更新フラグ (§6.3)
  cadence_repair_needed INTEGER NOT NULL DEFAULT 0, -- scheduleEdit 失敗の修復待ち (§4.0)
  dunning_state       TEXT NOT NULL DEFAULT 'none',
      -- none|retry_wait|await_card|challenged|ops_hold|exhausted
  dunning_attempts    INTEGER NOT NULL DEFAULT 0,
  next_retry_date     TEXT,
  dunning_deadline_at TEXT,                   -- await_card: min(失敗+7d, scheduled+13d) / challenged: リンク送付+72h
  last_attempt_error  TEXT,                   -- code のみ
  source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE billing_cycle_claims (
  contract_gid TEXT NOT NULL,
  cycle_key    TEXT NOT NULL,                 -- Shopify cycle_index
  status       TEXT NOT NULL,
      -- attempting|succeeded|failed|failed_no_attempt|skipped|abandoned
  retry_policy TEXT NOT NULL DEFAULT 'none',  -- none|next_tick|hold (§6.5 の判別列)
  attempt_no   INTEGER NOT NULL DEFAULT 1,
  attempt_gid  TEXT,
  order_id     TEXT,                          -- success 時に記録 (双方向突合の連結キー)
  idempotency_key TEXT NOT NULL,              -- SHA-256("own-billing:{gid}:{cycle_key}:{attempt_no}")
  claimed_at TEXT NOT NULL, resolved_at TEXT,
  PRIMARY KEY (contract_gid, cycle_key)
);
-- attempt 単位の証跡 (gid/エラー/時刻) は audit_logs に append 記録 (claim 行は最新のみ保持。
-- チャージバック紛争・突合深掘りの一次証跡は audit が正)

CREATE TABLE sub_migration_snapshots (
  huckleberry_contract_id TEXT PRIMARY KEY,
  shopify_customer_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,                -- 全条件 + Flow 実測 + 直近 order_id
  own_contract_gid TEXT,
  phase TEXT NOT NULL,
      -- snapshotted|pending_card|own_created_paused|hb_stop_requested|
      -- huckleberry_stopped|billing_aligned|activated|rolled_back
  target_first_billing_date TEXT,             -- billing_aligned が確定する絶対日付
  phase_updated_at TEXT NOT NULL, created_at TEXT NOT NULL
);
```

通知冪等マーカー: (cycle_key, attempt_no, kind) 単位。kind = fail_notice / card_request /
challenge_link / pause_notice / **resume_notice / delivery_notice** (全通知種を列挙)。

### claim ライフサイクル (「未claim」= status ∈ {attempting, succeeded, skipped} の行が無いこと)

| 遷移 | 手段 / 条件 |
|---|---|
| (無/CAS対象) → attempting | INSERT、または CAS `WHERE status IN ('failed','failed_no_attempt','abandoned')` (attempt_no++・key 再計算)。resolveBillableCycle が当該 cycle を返した時のみ。**【no-parallel-attempt 原則】attempt_gid を持つ行からの全ての CAS 再入 (failed/failed_no_attempt/abandoned を問わず) は、旧 attempt の最終状態を照会してから: 非 terminal (pending/challenged) → 再入不可 / succeeded → succeeded 昇格 / failed 確定のみ CAS 可**。同一サイクルに非 terminal な attempt が 2 本存在する状態はどの経路からも作らない (二重課金の構造封鎖) |
| attempting → succeeded | success webhook / reconciliation。order_id 記録 |
| attempting → failed | failure webhook / reconciliation。**failure webhook 経由で challenged になった場合は failed 化せず attempting 維持 (§6.3 レーン管轄)** |
| attempting → failed_no_attempt | 同期 userError。retry_policy: THROTTLED → next_tick (attempt_no 据え置き・同一 key で再発行)、BCCBED/未知 → hold (自動再発行なし + alert、ops 解除 op で復帰) |
| attempting/failed → abandoned | pause/cancel/skip/対象サイクル変更 (I-3) |
| failed → succeeded | 遅延 success (3DS 等)。無条件昇格 + I-4 |
| attempting → failed | challenged 72h 失効 sweep (attempt 最終照会後。**照会が success なら succeeded 処理**) |
| (無) → skipped | skip 操作 (cron を永久ブロック) |
| skipped → abandoned | unskip (行は残す。未claim 定義により due 復帰可能) |
| abandoned → skipped | §6.7 S6 再開の過去サイクル skip 処理 (**前提: 旧 attempt が非 terminal なら §6.3 レーンの決着を待ってから**) |
| abandoned → succeeded | 遅延 success (§6.6 規則) / CAS 再入時の照会昇格 |
| failed_no_attempt → abandoned | pause/cancel/skip (I-3。hold 中の claim も対象) |

**webhook 照合**: (contract_gid, cycle_key) 一次 + attempt_gid 検算。
**検算不一致の failure は適用せず audit のみ** (旧 attempt 再配送の汚染防止)。success は
§6.5 逆引きで常に救済。

## 4. 状態機械

### 4.0 サイクル解決 (中核)

**cadence-by-scheduleEdit**: 課金予定日はエンジンが毎サイクル明示設定する。
- 予定日列は `anchor_date + k×interval` で**固定** (dunning 遅延で将来がズレない =
  Huckleberry の決済日起点運用の継承)
- cycle k の success 処理で cycle k+1 へ scheduleEdit(次アンカー日) を発行。
  **skip 処理後も次の未解決サイクルへ scheduleEdit(次アンカー日) を発行** (skip 後にカデンツが
  作成時刻起点デフォルトへ落ちる穴の封鎖)
- **scheduleEdit 失敗時**: `cadence_repair_needed` フラグ → **日次サイクル再同期ジョブ (§5.4) が
  再試行** (担い手の明示)。独立 overdue 検出器 (§8) は「予定日と anchor 列の乖離」も検出条件に
  含める (この故障モードの第二網)

**resolveBillableCycle(contract, today)** — 全 attempt 発行経路が通る唯一の対象決定関数:
1. Shopify billing cycles 照会 → 最古の未解決 (未 billed・未 skipped) サイクル C
2. C.scheduledDate > today → 対象なし
3. today − C.scheduledDate > 14日 (I-6) → 対象なし。claim abandoned 化 + C を
   scheduleEdit(skip) + 次アンカーへ + Discord alert
4. それ以外 → C が対象。claim は C の cycle_key で INSERT/CAS (旧サイクルの未解決 claim は
   abandoned 化してから)

**resolveBillableCycle の呼出しと step 3 の副作用 (skip/abandon) を含む全動作は
canIssueAttempt() (§8) 通過後のみ** (kill 中に Shopify を mutate しない)。

### 4.1 状態表

| # | 状態 | 出る遷移 |
|---|---|---|
| S1 | active/none | 失敗分類 → **matrix が決める先 (S2/S3/S4h/S4o/S5 いずれも)**、S6/S7、S8 |
| S2 | active/retry_wait | S1 (成功)・matrix 再分類・S6/S7 |
| S3 | active/challenged | S1 (認証成功)・matrix 再分類 (decline)・S5 (72h 失効)・S6/S7 |
| S4h | active/await_card | S1 (差替→成功)・matrix 再分類・S5 (deadline)・S6/S7 |
| S4o | active/ops_hold | S1 (ops 解除 op → resolveBillableCycle 経由再試行)・S6/S7 |
| S5 | paused/exhausted | S1 (§6.4 復旧)・S7 |
| S6 | paused/none | S1 (§6.7 再開)・S7 |
| S7/S8 | cancelled / expired | 終端 |

**閉包規則**: dunning 中の失敗 webhook は現在状態によらず §6.2 matrix が遷移先を決める。
**適用条件: attempting claim を failed 化した failure webhook のみ。resolved 済み claim への
遅延/再配送 failure は audit のみ** (S5 後の遅延 decline が表外状態を生まない)。
resolved 済みへの遅延 success は §6.3/§6.6 の明示規則が処理。

不変条件:
- **I-1**: attempt 発行 = status=active ∧ canIssueAttempt() ∧ resolveBillableCycle の対象 cycle の
  claim 保持。S5 復旧は activate → S1 → この列
- **I-2**: 全発行 (cron due / dunning リトライ / 支払復旧 / 移行 catch-up / reconciliation 再発行)
  は「**canIssueAttempt() → resync → resolveBillableCycle → claim → 発行**」の順序で統一
- **I-3**: pause/cancel/skip 受理時に未解決 claim を abandoned 化。in-flight の遅延 success は
  §6.6 規則で処理
- **I-4**: success = dunning 全リセット + order_id 記録 + 次サイクル scheduleEdit
- **I-5**: 過去未解決サイクルの「回収」(14日以内) を行うのは **dunning 復旧経路 (S5→S1・
  カード更新起点) と移行 catch-up のみ**。**顧客都合の一時停止 (S6) からの再開は回収しない**:
  再開処理が当該過去サイクルを scheduleEdit(skip) + claim skipped 化してから次アンカーを
  schedule (「休止期間分は請求しない」の一意化。overdue 検出器に残骸も残さない)
- **I-6**: 14日 staleness は resolveBillableCycle 内で強制 = 全発行経路に効く

## 5. own-billing cron (5分 tick 内のジョブ)

1. **due 発行** (JST 05:00-07:59): active ∧ dunning∈{none} ∧ 未claim ∧ scheduled<=today、
   および retry_wait ∧ next_retry_date<=today。順序は I-2 (gate false なら claim を作らず
   resolve も呼ばない — §10.1⑨ の「claim 0 件」assert と整合)
2. **期限 sweep**: await_card/challenged の deadline 超過 → 処置。
   - challenged 失効: attempt 最終照会 → success なら succeeded 処理 / **failed 確定していれば**
     pending_new_card の有無で分岐: あり → §6.4 の 4 手順で自動再試行 (no-parallel-attempt
     原則を満たす) / なし → claim failed 化 + S5。
     **照会が依然 pending の場合は新 attempt を発行しない** (no-parallel-attempt 原則。
     契約は challenged のまま維持し deadline を +24h 延長して毎日再照会。scheduledDate+14日で
     I-6 がサイクルを放棄 (skip+abandoned+alert) — その後に旧 attempt が成功したら
     「resolved への遅延 success」規則 (昇格+delivery_notice+人間判断) が受ける。
     3DS pending の自然失効有無は §10.1⑪ で実測し、失効が確認できればこの待機は短縮できる)
   - **billing-kill / breaker 中は sweep 停止。deadline は凍結し、解除時に「解除時刻+残余時間」で
     再設定** (kill 中にカード更新した顧客を解除直後に S5 化しない)。
     **kill 中のカード更新イベントは pending_new_card / pending_card 系フラグとして必ず記録され
     (contractUpdate まで実施、発行のみ保留)、解除後の sweep/tick が §6.4 を評価する** —
     トリガの永久喪失を防ぐ (S4h 含む)
3. **reconciliation** (attempting 24h 超、challenged 契約は除外): attempt_gid あり → 照会
   (三値: 未確定 no-op)。attempt_gid NULL → idempotencyKey 逆引き → 実在なら結果反映 /
   不在なら **I-2 の順序 (canIssueAttempt 通過時のみ) で同一 key 再発行**。kill 中は再発行せず
   stuck alert に委ねる。**stuck claim の手動 DELETE は禁止**
4. **サイクル再同期** (日次): 全 active 契約の current cycle 照会更新 +
   cadence_repair_needed の scheduleEdit 再試行
5. **監視** (§8)
6. **通知キュー配送** (JST 10:00-19:59)。**challenged の 72h deadline 起点はリンク送付時刻**
   (配送窓の遅延を顧客の持ち時間から差し引かない)

## 6. Webhook・失敗処理

### 6.1 success
claim succeeded + order_id。I-4 (dunning リセット・次サイクル scheduleEdit・cache 前進)。

### 6.2 dunning matrix (6 クラス、WI-4 で 55 code 全列挙)

| クラス | 代表 code | 動作 | 通知 | 終端 |
|---|---|---|---|---|
| A ソフトデクライン | INSUFFICIENT_FUNDS, 一般 CARD_DECLINED, PROVIDER_TIMEOUT | +3日, +7日 (計3) | 初回+最終 | S5 |
| B カード無効 | EXPIRED_CARD, INVALID_PAYMENT_METHOD | リトライなし。await_card + deadline = min(失敗+7d, scheduled+13d) (I-6 内 clamp) | 即日 card_request | S5 |
| C 支払済み | INVOICE_ALREADY_PAID | success として reconcile | なし | S1 |
| D 店側起因 | INSUFFICIENT_INVENTORY 等 | ops_hold + Discord。顧客通知なし・pause なし | なし | S4o (人間) |
| E ハードデクライン | FRAUD_SUSPECTED, DO_NOT_HONOR 系 | 即 S5 (リトライ禁止) | 中立文言 | S5 |
| F 未知 | 残り全て | 自動アクションなし。ops_hold + Discord | なし | S4o |

遷移先は §4.1 閉包規則で状態を問わず matrix が決定。通知はキュー経由・
(cycle_key, attempt_no, kind) 冪等マーカー。

### 6.3 challenged
- **一次検出 = billing_attempts/challenged webhook**。reconciliation は fallback (三値照会が
  challenged を検出したら本レーンを起動 — リンク未送信の永久放置防止)
- dunning_state='challenged'。次 tick で attempt 照会 → nextActionUrl 取得 → LINE (fallback
  email) で送付。deadline = 送付時刻 + 72h
- **S3 中のカード更新**: contractUpdate + `pending_new_card=1` (claim は attempting のため発行
  しない)。失効 sweep がフラグを見て S5 化の代わりに §6.4 の 4 手順で自動再試行
- success → S1 / decline failure → matrix 再分類 / 失効 → §5.2 の処置
- **S5 後の遅延 3DS success**: succeeded 昇格 + I-4 + **自動 activate + resume_notice**
  (支払済みなのに停止のまま、を残さない)

### 6.4 支払方法更新 (create/update webhook)
対象 = 該当顧客の S2/S3/S4h/S5 契約 + 移行 pending_card の snapshot 行。
手順: contractUpdate(paymentMethodId) → (S5 なら activate) → **I-2 の順序
(canIssueAttempt → resync → resolveBillableCycle → claim → 発行)**。
S3 は pending_new_card 経路 (§6.3)。複数契約顧客は失敗中 (S2/S3/S4h/S5) の契約のみ。

### 6.5 同期 userError / orphan
- THROTTLED: failed_no_attempt + retry_policy=next_tick (同一 key・attempt_no 据え置き)
- BCCBED / 未知同期エラー: failed_no_attempt + retry_policy=hold + Discord (連打しない。
  hold は resolveBillableCycle の対象からも除外。**ops 解除 op は retry_policy→none と
  dunning_state→none の戻し + resolveBillableCycle 再評価までを op 内で実施** — 戻し忘れの
  構造排除)
- CONTRACT_PAUSED/TERMINATED: abandoned + 状態再同期

### 6.6 顧客操作
- **締切ガード対象は skip / 日付変更のみ** (scheduled の 3 日前以降 or 当該 claim attempting →
  「今回分のお手続きは締め切りました。次回分から反映されます」)。
  **pause/cancel は常時受理** (I-3 + 遅延 success 規則で処理)
- **skip**: scheduleEdit(skip) → claim skipped INSERT → **次の未解決サイクルへ
  scheduleEdit(次アンカー日)** → 再同期。unskip: claim abandoned 化 → 再同期。
  外部起点 (管理画面) の cycles/skip webhook も同ハンドラ。**in-flight attempting claim がある
  場合の skip も I-3 に統一: claim を abandoned 化する** (遅延 success は abandoned×遅延
  success 規則が受ける。abandoned 化により以後の failure webhook は「resolved への遅延
  failure = audit のみ」となり、skip 済みサイクル起点の誤 dunning→誤 S5 が構造的に起きない)
- **日付変更**: `scheduleEdit(billingDate=指定日)` の**単発変更。anchor_date は変更しない**
  (次々回以降は従来カデンツ — 現行 Huckleberry マイページの「お届け日変更」と同一挙動)。
  受理時に **date_override マーカー (サイクル単位)** を記録し、乖離検出器 (§8) は override
  済みサイクルを除外する (正当な単発変更が scheduleEdit 故障検出を恒常ノイズ化しない)。
  締切ガードにより未 claim の将来サイクルにのみ作用 = I-3 対象外。WI-1 カードに
  「今回のみ変更」と明記
- pause/cancel: I-3 → mutation → 同期。**abandoned×遅延 success**: succeeded 昇格 +
  pause/cancel 維持 + delivery_notice (「直前のお支払いが完了していたため今回分はお届け
  します」) + Discord 人間判断 (自動返金なし)

### 6.7 再開 (S6→S1)
I-5: 過去未解決サイクルを scheduleEdit(skip) + claim skipped 化 → 次アンカーを scheduleEdit →
以後 resolveBillableCycle は将来日を返す (過去サイクル非請求の一意化)。
**前提条件: 当該 claim の旧 attempt が非 terminal (pending/challenged) なら skip 処理を保留し
§6.3 レーンの決着後に実行** (no-parallel-attempt 原則と管轄の一意化)。

## 7. 移行 — サイクル単位 exactly-once

```
snapshotted        全条件 + Flow 実測 + 直近 order_id。実行窓: 次回決済日まで 5 日以上
                   (検査は snapshotted / pending_card 復帰 / 宣言 op 受理の 3 箇所)
  ↓ (支払方法 0 件 → pending_card、カード追加 webhook §6.4 で復帰)
own_created_paused atomicCreate(PAUSED, **nextBillingDate = snapshot の承継課金日**,
                   customAttribute lineharness_migration_id={huckleberry_contract_id})。
                   冪等: crash-resume は customer の own-app 契約 (**status ≠ CANCELLED** —
                   rolled_back 残骸への誤マッチ防止) を照会し本 attribute で突合。
                   **own_sub_contracts に paused 行をこの時点で先行採録** (scheduled = 承継
                   課金日。activated で確定値に更新) — hb_stop_requested〜activated の窓で
                   WI-2 リマインドの読み先が空になり初回サイクルのリマインドが沈黙する穴の封鎖
  ↓ Katsu が admin endpoint で「契約IDリストの HB 停止をこれから実施する」と事前宣言
hb_stop_requested  二要素ゲート第1要素 = 事前宣言 (cancel タグ先着の偽 rolled_back 防止)。
                   宣言済み契約の cancel タグ = 停止確認 / 宣言なき cancel タグ = 自主解約 →
                   rolled_back + alert。宣言後 72h タグ未着 → Discord + Katsu 確認。
                   SOP: 宣言→即実施 (同一セッション、§7.3)。migrated_to をこの時点で印字
  ↓ cancel タグ webhook (48h 滞留 alert + 能動再取得 op)
huckleberry_stopped
  ↓ 自動 (**確認後 48h の猶予** = HB 最終 attempt の in-flight 決済の着地待ち。
     5 日実行窓がこの 48h を吸収)
billing_aligned    サイクル所有権ハンドオフ (**単一の決定手順 — 優先順位を固定**):
                   ① まず**差分検査**: 承継課金日の基準値 = この時点の再取得値 (Flow 実測最新 +
                     顧客タグ再取得)。snapshot 値と不一致 → phase hold + Discord +
                     Katsu 承認で基準値を再確定してから②へ (①と②の二重加算はしない —
                     基準値はこの 1 箇所でのみ確定する)
                   ② Shopify Orders **ライブ照会** (local キャッシュ不使用) で snapshot 以後の
                     subscription-id:{ID} 注文の有無を確認 →
                     target_first_billing_date = 基準値 (Order 無し) / 基準値+interval (有り、
                     **+interval は一度だけ**)。絶対日付で永続化 (crash-resume 再実行は再確定
                     であり二重先送りしない)
                   ③ 【残余リスクの明示】HB 側の in-flight 3DS attempt は own-scope 制約で
                     観測不能。48h 猶予後に完了した HB 課金 (Order 遅延出現) は防げないため、
                     **移行後 14 日間、双方向突合 cron が migrated 契約への HB 由来 Order 出現を
                     監視 → 検出時は当該契約を EXCLUDELIST に自動追加 + Discord (返金判断は
                     人間)** — 予防不能ケースは検出+隔離+補償で受ける (§11 に登記)
  ↓ 自動 (**前提: canIssueAttempt() が真を返せる構成であること** — ALLOWLIST 収載 (or ALL) に
     加え SELF_BILLING_ENABLED / ARMED / EXCLUDELIST 非該当も検査。「誰も課金しない契約」を
     作らないという主張を canIssueAttempt 全要素で担保)
activated          activate → own_sub_contracts 更新 (anchor_date = target)。
                   - target が未来: 最古未解決 cycle に scheduleEdit(target)
                   - **target が過去 (遅延 catch-up): scheduleEdit(当該 cycle → 本日)** を発行し、
                     当日の発行窓で I-2 の順序により attempt (予定日=本日なので BCCBED は
                     発生せず、resolveBillableCycle の「scheduledDate <= today」も自然に成立 —
                     過去日 scheduleEdit という未検証挙動にも、resolve との矛盾にも依存しない)。
                     anchor_date は target のままなので次サイクル以降は target+k×interval
rolled_back        own cancel + gid クリア + **migrated_to 消印**。再入は snapshotted から
```

### 7.1 支払方法引き当て
候補1件→自動。複数→brand+last4 突合で一意なら自動、他は保留 (Katsu)。0件→pending_card →
LINE/email 依頼 → §6.4 で自動復帰。activate 直前に revokedAt 再チェック。

### 7.2 ロールバック
- own_created_paused 以前: own cancel のみ
- huckleberry_stopped 以後: 前進が正。障害時は billing-kill + 手動請求 runbook (下書き注文
  請求時は当該 cycle_key の claim を手動 succeeded 化 + order_id 記録 + 次サイクル
  scheduleEdit を必須手順化)。I-6 は resolveBillableCycle 内なので全経路の最終防壁

### 7.3 運用 SOP (Katsu)
当方が対象リスト生成 → Katsu が宣言 op → **直後に**管理画面で停止 → タグ確認は自動。
宣言と実施を空けない。宣言〜実施ギャップ中の自主解約誤認の残余リスクは §11 (受容)。

## 8. 運用: kill switch・監視

**canIssueAttempt() の完全定義** (全 5 発行経路の唯一のガード):
`SELF_BILLING_ENABLED='true' ∧ SELF_BILLING_ARMED_AT 設定済み ∧ ¬breaker_tripped (D1) ∧
allowlist match ∧ ¬excludelist match`
— **arming インターロック**: 未 arming では実課金を開始できない (alert 抑制と課金開始が連動)。

| gate | 効果 | 既定 |
|---|---|---|
| SELF_BILLING_ENABLED | canIssueAttempt 経由で全発行停止。OFF でも受信・同期・結果回収は継続。**期限 sweep は停止 (deadline 凍結 §5.2)** | OFF |
| SELF_BILLING_ALLOWLIST | fail-closed (未設定/空/parse 不能 = ゼロ + alert)。sentinel `ALL`。trim (\r)。日次サマリに **parse 件数と matched 件数の両方** | 未設定 |
| SELF_BILLING_EXCLUDELIST | 契約単位の緊急除外。**allowlist と同一 parser。parse 不能 = 全契約除外 (fail-closed 側) + alert** | 未設定 |
| SUB_MIGRATION_ENABLED | phase 自動遷移 | OFF |
| SELF_BILLING_UI_ENABLED | WI-1 カード実 API 化 | OFF |

- **billing-kill op** (Admin Ops、Katsu 単独可): SELF_BILLING_ENABLED + SUB_MIGRATION_ENABLED を
  同時 OFF。**解除 runbook**: stuck claim 0 / overdue 一覧レビュー + **バックログを scheduleEdit
  で分散** / 双方向突合 green / 原因 PR merge 済み
- **自動サーキットブレーカー**: **trip = billing-kill と同効果** (発行 + sweep + migration 停止。
  canIssueAttempt の breaker_tripped で実現)。条件: 24h 発行 > max(10, 日次 due 予測×3) or
  24h failed > max(5, 発行の 30%)。**ALL 時の母数 = active な own 契約数**。解除 = kill 解除
  runbook と同一 (バックログ分散を含む — 解除直後の一括発行/再 trip 防止)。
  **解除時にカウンタ (24h rolling 窓) をリセット** (旧カウントでの即再 trip 防止)
- 監視:
  - **overdue-unattempted (独立系)**: 日次で **Shopify ライブの own-app active 契約列挙**
    (D1 非依存) → expectedDate < today−1 ∧ 解決済み claim なし、**+ 予定日と anchor 列の乖離**。
    tick 毎のキャッシュ版も併走 (速報)
  - dunning 滞留: retry_wait ∧ retry 日超過 / await_card・challenged ∧ deadline+12h 超過 /
    **challenged ∧ deadline 未設定 ∧ 遷移から 24h 超過** (リンク送付失敗の検出 — 述語の穴埋め)
    (**kill 中は抑制** — deadline 凍結と整合)
  - stuck claim (attempting>24h) / skippedGating 24h / 移行 phase 滞留 48h
  - **巻き添え解約検出 (仕様)**: 移行バッチ実行中 (SUB_MIGRATION_ENABLED='true' の間)、
    sub_migration_snapshots に行が無い契約 ID の cancel タグ webhook を検知 → Discord +
    Katsu 確認 (停止操作の対象誤りの即時検出)
  - **双方向突合 (日次)**: claims.order_id ↔ own 起因 Order (app 属性で照会) の 1:1 両方向。
    **+ migrated 契約への HB 由来 Order の遅延出現監視 (移行後 14 日、§7③)**
  - alert arming: SELF_BILLING_ARMED_AT 前は billing 系 alert をサマリのみに抑制
- 失敗 alert 閾値: allowlist ≤6 は全失敗即 alert、以後 7日窓 3 件 or 同一契約連続 2 回

## 9. 非 LINE 顧客マイページ (卒業の前提条件)

magic link (HMAC+15分+単回) → 契約表示 + skip/日付/停止/解約/**支払方法変更** (vault 一覧から
選択 → contractUpdate。新カードは新カスタマーアカウントへ誘導)。通知チャネル規則は §2。

## 10. 検証計画

### 10.1 ¥100 実課金 E2E
①¥100 商品+販売プラン ②専用テスト顧客 (契約1件) が storefront 実カード購入 (vault+HB契約成立)
③vault で atomicCreate(PAUSED) → scheduleEdit で cycle1 予定日を (a) 当日 (b) 数日後の 2 通り
実測 (cadence 機構の直接較正) ④ **予定日の 25h 以上前**に専用サイクルで発行して BCCBED を
意図的観測 (24h 規則と整合、観測後 hold 解除) ⑤同一 key 再発行 → 増えない ⑥billed 済み
サイクルへ別 key (attempt_no+1) → 第2防壁か実測 (否なら「防壁は claim のみ」を §6 に明記)
⑦JST/UTC 境界 ⑧success 後の次サイクル scheduleEdit → 期待日一致 ⑨allowlist 外で due 経過 →
**発行 0 + claim 0** (I-2 順序の実証) → 投入で課金 ⑩ **catch-up 実測: scheduleEdit(cycle → 当日) → 即日 attempt の受理** (§7 の遅延 catch-up 経路)
⑪ **並行 pending attempt** (challenged 相当 pending 中に別 key 発行) の挙動実測 —
**判定規則: Shopify が拒否するなら「第2防壁あり」と §6 に記録、受理されるなら
no-parallel-attempt 原則が唯一の防壁であることを確認し §5.2 の待機設計を維持。
あわせて 3DS pending の自然失効有無も観測** ⑫返金 (手数料実費記録) ⑬ **own 契約のみ**
cancel (HB 契約は 10.2 の被験として温存)

### 10.2 移行リハーサル (本物の信号経路)
被験 = 10.1② の HB 契約 (専用顧客・契約1件)。宣言 op → 管理画面停止 → タグ webhook →
48h 猶予 → billing_aligned (ライブ照会) → activated を実信号で全遷移。実決済日を 1 回跨ぎ、
**観測ウィンドウ = 予定日+48h** で「HB Order 0 ∧ own Order ちょうど 1」を assert。
negative: (a) 停止遅延で HB に課金させ target が +interval される (b) 宣言なし cancel →
rolled_back (c) billing_aligned の 2 回実行で絶対日付不変 (d) **窓中に顧客操作で HB 側 skip を
発生させ、差分検査が hold + Katsu 承認に落ちる** (e) 48h 猶予未経過の強制実行が進まない
(f) 5日窓・複数 vault/0 件レーン分岐 (g) **allowlist 非収載のまま activated 前提が reject する**
(h) **atomicCreate の二重実行 (crash-resume) で own 契約が 1 件に留まる (customAttribute 冪等)**。
**§7 phase 機械の unit** (全遷移 + catch-up claim 経由 + activate 直後 tick の二重発行なし) を
10.3 と独立に列挙。

### 10.3 状態機械 unit
- claim 全遷移 + 正方向 (失敗→リトライ発行 / S5→§6.4 4 手順→発行→成功 / unskip→due 復帰課金)
- **CAS 再入前提条件** (pending 照会→不可 / succeeded 昇格 / failed 後のみ)
- resolveBillableCycle: 14日境界・最古選択・hold 除外・**副作用の gate 後実行**
- **I-5 両側**: S6 再開 = skip 処理 (非請求 + overdue 残骸なし) / S5 復旧 = 14日回収
- webhook 順列 × claim 状態 (遅延 success / abandoned×success / failed→succeeded /
  検算不一致 failure 非適用 / challenged 失効→照会 success 分岐 / →failed→遅延 success→自動
  activate) + **閉包規則の適用条件** (resolved への遅延 failure = audit のみ)
- matrix 6 クラス + 同期エラーレーン + **await_card deadline の I-6 clamp**
- **reconciliation 再発行レーン** (NULL gid→逆引き→不在→gate 通過時のみ再発行 / kill 中 alert)
- **scheduleEdit 失敗 → repair フラグ → 日次回復 / 乖離検出**
- 締切ガード境界 + **日付変更の単発性 (anchor 不変)** + skip 後の次サイクル schedule
- **並行競合**: cron due × §6.4 webhook 復旧の同一サイクル claim (勝者 1)
- ops: EXCLUDELIST parser (fail-closed) / **arming インターロック** / breaker trip 時に
  attempting claim を作らない / kill 中 deadline 凍結→解除再設定 / ops_hold 解除 op の後処理
- **監視 7 検出器の検出ロジック** (独立 overdue+乖離 [date_override 除外含む] / dunning 滞留
  [deadline 未設定 challenged 含む] / stuck claim / skippedGating / 移行 phase 滞留 /
  巻き添え解約 / 双方向突合 [HB 遅延 Order 監視含む])
- **pending_new_card レーン**: 失効 sweep の pending 待機 (+24h 延長・新 attempt 不発行) /
  failed 確定後の自動再試行 / I-6 放棄後の遅延 success 受け
- サーキットブレーカーの **trip 条件算術** (境界値) + 解除時カウンタリセット
- reconciliation 三値照会の **challenged 検出 fallback** (§6.3 レーン起動)
- **email fallback 分岐** (未連携 / 連携済み dispatch failed) + 実機 1 回
- WI-1/WI-2 統合: migrated_to 切替 (印字/消印)・リマインド claim 共有・リカバリ責務非重複
- 実機 dunning: 残高0プリペイド (A) + カード更新自動復旧は本番投入前必須

### 10.4 マイページ/LINE UI
magic link 負検証 4 種 + postback IDOR + 締切ガード境界。

## 11. リスク登記簿

| リスク | 緩和 |
|---|---|
| scope 申請遅延/却下 | 前例 #177。却下時は SKIP_PAYMENT_AND_CREATE_UNPAID_ORDER + 請求書縮退 (最終手段) |
| Katsu 停止操作ミス | 二要素ゲート + リスト当方生成 + 巻き添え検知。宣言〜実施ギャップの自主解約誤認は SOP で緩和 (完全排除不能 — 受容) |
| 3DS 頻発 | challenged レーン + 初回バッチ 1 件で実測較正 |
| 55 code 未較正 | F クラス (自動なし+人間) に倒す。初回本番ログで較正 |
| scheduleEdit 失敗連鎖 | repair ジョブ + 乖離検出の二重網 |
| HB 側 in-flight 3DS の遅延 Order (移行時、観測不能) | 予防不能 — 14日間の遅延 Order 監視 + EXCLUDELIST 自動隔離 + 人間返金判断 (§7③) で検出・補償 (受容) |
| Workers Free 上限 | 全経路チャンク。平均 2.5 attempt/日で余裕 |

## 12. スコープ申請 (即実行)

read_customer_payment_methods + write_own_subscription_contracts (+webhook 用 read) を同時申請 →
リリース → 再インストール承認 (Katsu) → expire-shopify-token op。前例 #177。

## 13. WI-4 実装順

1. migration 071 + cron 骨格 (gate OFF/heartbeat) + billing-kill op + Katsu kill 実地テスト
2. サイクル同期 + resolveBillableCycle + claim ライフサイクル + 同期エラーレーン (unit 全網羅)
3. webhook 4 系統 + matrix + 通知キュー (email fallback)
4. 移行 phase 機械 + 宣言 endpoint + 監視群 + サーキットブレーカー
5. LINE UI 実 API 化 + 非 LINE マイページ
6. ¥100 E2E → リハーサル → Katsu 契約 1 件 (WI-5)
