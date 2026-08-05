# Shopify Flow → LINE CRM サブスク実測値連携 設定手順 (WI-2 / §10-0 ①)

**目的**: 定期購買 (Huckleberry) の Flow トリガーが持つ「次回決済日」の実測値を本 CRM へ送り、
LINE カード/リマインドの日付を**推定から実測へ**昇格させる。

**なぜ必須か** (2026-08-01 の本番実測): active 契約 139 件のうち **68 件 (約半分) が推定日を出せない**。
内訳は `last_order_at` 欠落 65 / `interval_days` 欠落 3。ローカル `shopify_orders` は
`read_all_orders` scope が無く直近 60 日分しか無いため、顧客タグから契約は作れても
紐づく注文が無く決済日を逆算できない ([[feedback_shopify_orders_60day_scope]])。
**導出推定では埋まらない。Flow の実測値だけが埋められる。**

**所要**: 約 15 分 (Katsu 操作 — 定期購買/Flow は埋め込みアプリで Claude が操作できない)。

**未設定のときの挙動 (C2 以降は機能ごとに違う)**:
- 契約カードの日付表示 … 推定値 (derived) で動作する。上記 68 件は日付なしのまま
- **決済リマインドの送信 … 1 通も送られない**。C2 (2026-08-05) 以降、送信対象は
  Flow 実測 (`estimate_source='flow'`) かつ受信 10 日以内の契約に限定されている。
  意図的仕様 — 導出はお届け日変更を追えず、**誤送信は回復不能・無送信は回復可能**
  という判断軸による。詳細は下記「受信側の仕様」と `docs/SUBSCRIPTION_GATE_CRITERIA.md`

## 前提 0: migration 074 を適用する

> Admin Ops → op = `apply-migration-074`

実測アンカー列 (`flow_estimate_anchor` / `skip_count_at_estimate`) を追加する。
**収集を開始する前に必ず済ませること。**

⚠️ 未適用のまま収集を ON にすると「精度が落ちる」のではなく**契約の書込が全て失敗する**
(`no such column`)。webhook 経路は catch で完全に無音、teiki-flow は 500 を返すので、
「設定したのに 1 件も入らない」状態になる。`enable-subscription-ingest` は
この列の存在を先に確認して、無ければ fail するようになっている。

列追加 + 既存行の基準値初期化のみで、行の追加・削除・日付の変更はない (additive・live-safe)。

## 前提 A: 収集 gate を ON にする

`SUBSCRIPTION_INGEST_ENABLED=true` が無いと受信口は **202 で黙って捨てる**。

> Admin Ops → op = `enable-subscription-ingest`

これは**収集だけ**を開始する gate で、顧客に見える面 (トーク内の契約カード / サブスク intent /
リッチメニュー) は `SUBSCRIPTION_MENU_ENABLED` のまま OFF。
**この順序が要**: 先に MENU を開けると、日付を出せない契約のカードを顧客に見せることになる。

## 前提 B: TEIKI_FLOW_SECRET の準備

シークレット値はチャットにも Actions ログ (PUBLIC repo) にも出さない運用。

1. パスワードマネージャ等で 32 文字以上の**英数字**ランダム文字列を生成
2. GitHub → Settings → Secrets and variables → Actions → New repository secret で
   Name = `TEIKI_FLOW_SECRET`、Value = 生成した値 を保存 (ここは GitHub がマスクする)
3. GitHub → Actions → **Admin Ops** → Run workflow → op = `put-teiki-flow-secret`
   (repo secret から読んで wrangler secret に投入する。値はログに出ない)
4. **同じ値**を下記手順 3 の `X-Teiki-Flow-Secret` ヘッダに貼り付ける (パスワードマネージャから)

## 設定するトリガー

定期購買アプリが提供する Flow トリガーのうち、**次回決済日が動く瞬間**を押さえる。
1 つのワークフロー = 1 トリガーなので、下記をそれぞれ作る (アクションは全て同一)。

| # | トリガー (Flow 上の実際の表示名) | なぜ必要か | 優先度 |
|---|---|---|---|
| 1 | **注文時n日前通知メール** | 決済の n 日前 (現在 7 日前) に発火し、**その時点の次回決済日**を運ぶ。リマインド窓 `[3,7]` の入口と一致するため、**これ 1 本で窓に入る契約が実測になる** | ★必須 |
| 2 | **スキップ時** | スキップは次回決済日を 1 周期先送りする。タグの skip-count からも追える (migration 074 で実測アンカーにも反映される) が、実測が正 | ★必須 |
| 3 | **お届け日の変更時** | **タグに現れない**変更。推定が原理的に追えない唯一のケース | ★必須 |
| 4 | 初回の購入時 / 2回目以降の購入時 | 決済直後に次サイクルの日付を実測で入れる (推定でも出せるので任意) | 任意 |
| 5 | スキップの取り消し時 / プラン(周期)の変更時 | 同上 (日付が動く) | 任意 |

トリガー名の注意 (2026-08-02 実機で確認):
- `契約作成` というトリガーは存在しない — 実体は「初回の購入時」。
- #1 は公開資料では「決済日n日前通知メール」と表記されるが、**Flow 上の表示は
  「注文時n日前通知メール」**。同じもの (定期購買 → 一般設定 →「注文前の確認メール」の n 日前)。

### 変数名 (2026-08-02 実機で確認)

| Body のキー | 選ぶ変数 | 一覧での説明 |
|---|---|---|
| `contract_id` | **`subscriptionContractId`** | 定期購買ID |
| `next_billing_date` | **`nextBillingDate`** | 次回決済日 |

`subscriptionContractId` は Huckleberry 自身の契約 ID (顧客タグ `subscription-{ID}-plan` の
`{ID}` と同一) で **Shopify の GID ではない** = read-model の `contract_id` と直接一致する。
同じ一覧に `deliveryCycle` (お届け周期) が並ぶので取り違えないこと — これは周期であって ID ではない。

⚠️ **複製でワークフローを増やしたら、トリガー差し替え後に必ず Body を目視すること。**
トリガーが変わると変数の出どころも変わるため、前のトリガー専用の変数だった場合に無効化される。

## 手順 (各トリガーで同じ)

1. Shopify 管理画面 → アプリ → **Flow** → 「ワークフローを作成」
   - 直リンク: https://admin.shopify.com/store/xn-0ckn0a9fxa4a/apps/flow
2. **トリガー**を選ぶ → 検索窓に「定期購買」と入力 → 上表のトリガーを 1 つ選ぶ
3. **アクション**: 「HTTP リクエストを送信」(Send HTTP request)
   - Method: `POST`
   - URL: `https://naturism-line-crm.katsu-7d5.workers.dev/api/integrations/teiki-flow`
   - Headers:
     - `Content-Type: application/json`
     - `X-Teiki-Flow-Secret: <TEIKI_FLOW_SECRET と同じ値>`
   - Body (変数ピッカーから該当変数を挿入):
     ```json
     {
       "contract_id": "{{subscriptionContractId}}",
       "next_billing_date": "{{nextBillingDate}}"
     }
     ```
     引用符の**内側**にカーソルを置いて「変数を追加」から挿入する。
     `{{ }}` を手打ちしても中身は空のままなので 400 になる。**引用符は消さないこと**
   - 日付フォーマットは定期購買 → 一般設定 →「Flow Trigger 設定」の既定
     (`YYYY年M月D日 hh:mm頃`) のままで OK — 受信側が和文形式もパースする
   - エラー時の Retry 設定は既定のままでよい。4XX は再送しても直らず (設定ミス)、
     5XX の再送は安全 (受信は冪等)。契約が見つからない場合は 200 を返すのでここには来ない
   - 編集画面に出る **「返されたデータにアクセスできません」** は異常ではない。
     外部 HTTP 送信は Flow が試し打ちできないため以降のステップをプレビューできない、という説明
4. ワークフローを **オン** にして保存
5. **1 本目だけテスト実行**し、Flow の実行ログでレスポンス本文を確認する:
   - `"source": "flow"` → 成功
   - `"skipped": "unknown_contract"` → **契約ID 変数の選び間違い**の可能性 (レスポンスの `hint` 参照)。
     新規契約直後なら race なので次回発火で自然回復する
   - `400` → `contract_id` か `next_billing_date` のどちらかが空 / 日付として読めない
     (どちらでも同じ 400 になるので、**まず Body 両方の引用符の中に変数が入っているか**確認)
   - `401` → **前提 B の 3 (`put-teiki-flow-secret`) がまだ済んでいない**か、
     シークレット不一致 (前提 B の 3 と 4 で**同じ値**を使ったか)
   - `202` → 収集 gate が OFF (前提 A)

## 設定状況 (2026-08-02 時点)

✅ **3 本とも設定済み・アクティブ**。

| ワークフロー名 | トリガー |
|---|---|
| 定期購買-決済日n日前通知メール | 注文時n日前通知メール |
| 定期購買-スキップ時 | スキップ時 |
| 定期購買-お届け日の変更時 | お届け日の変更時 |

前提 A (`SUBSCRIPTION_INGEST_ENABLED`)・前提 B (`TEIKI_FLOW_SECRET`) とも投入済み。
migration 074 も適用済み (`anchor_columns=2` / `baseline_drift=0` / `anchor_missing=0` を確認)。

## 効果の確認

Admin Ops → op = `reminder-dry-run` の「**日付ソースの内訳**」セクションで
`measured_by_flow` が増えていく。トリガー 1 は決済 7 日前にしか発火しないため、
**設定直後に一気に増えるのではなく、周期に沿って数日〜1ヶ月かけて積み上がる**。

D1 を直接見る場合:

```bash
cd apps/worker && npx wrangler d1 execute naturism-line-crm --remote --command \
  "SELECT COUNT(*) FROM subscription_contracts WHERE estimate_source = 'flow'"
```

## 受信側の仕様 (参考)

- `POST /api/integrations/teiki-flow` (routes/shopify.ts)
- 認可: `X-Teiki-Flow-Secret` ヘッダ (定数時間比較)。不一致・secret 未設定とも 401
  (未設定はサーバログでのみ判別 — 設定状態を外部に開示しない)
- gate: `SUBSCRIPTION_INGEST_ENABLED` または `SUBSCRIPTION_MENU_ENABLED` (どちらかが `true`)。
  OFF なら 202 (Flow に再試行させない)
- 日付は `YYYY年M月D日 [hh:mm頃]` (Flow 既定の和文形式)・タイムゾーン付き ISO・
  `YYYY-MM-DD...` のいずれも受理 (JST 日付に正規化、暦として不正な日付は 400)
- 契約 ID は素の値で引き、見つからなければ GID (`gid://shopify/SubscriptionContract/123`) の
  末尾セグメントでも引く。**どちらでも実在行にしか書かない** (phantom 行を作らない)
- 未知の contract_id は **200 + skipped + hint** で受ける。契約作成トリガーが注文 webhook より
  先着する race で起きうるが、Flow は 4xx を再試行しないため実行ログを green に保ち、
  次のトリガー発火で自然回復する
- **C2 (2026-08-05)**: 決済リマインドの送信対象は **実測 (`estimate_source='flow'`) かつ
  受信 10 日以内**の契約に限定される。受信時刻は `flow_measured_at` (migration 075) に
  記録され、アンカーと同じライフサイクルで消える。導出 (derived) は窓に入っても送らない。
  開放条件の数値と根拠: `docs/SUBSCRIPTION_GATE_CRITERIA.md`
- 実測値 (`estimate_source='flow'`) は**アンカー**として保存され、タグ由来の再計算では
  上書きされない。ただし**実測を受けたあとに増えたスキップは先送りとして反映する**
  (`flow_estimate_anchor + 周期 × 増分`、migration 074)。
  「実測は導出で上書きしない」は維持しつつ、スキップは導出ではなく**新しい事実**として扱う。
  - 実測受信**時点**で既にあったスキップは Huckleberry 側が日付に織り込み済みなので数えない
    (基準値は受信時点の skip 累計。`skip_count_at_last_order` は流用できない — 注文〜実測間の
    スキップを二重計上する)
  - **周期が不明**な契約で未消化スキップが出たら日付を出さない (null)。先送り幅を計算できないのに
    古い日付を保持すると、スキップ済みと分かっている顧客へ誤った決済日を送ることになる。
    null なら無送信 + カードは「マイページでご確認ください」→ 次の Flow 発火で復帰する
  - 既知の残存レース: 「スキップ時」トリガーの POST が Shopify の `customers/update`
    (skip-count タグ) より**先着**すると、基準値がスキップ前の値になり日付が 1 周期**後ろ**へずれる。
    ずれる向きが後ろ = 窓に入らず無送信で、トリガー 1 (決済 7 日前) が
    **送信が必要になるまさにその時点で**再アンカーするため自己修復する
- 実測値は**そのサイクルの決済が完了すると `derived` に戻る** (アンカー・受信時刻も一緒に消える)。
  次の Flow 発火で再び実測へ昇格する。
  - 「決済完了」と解釈するのは **`last_order_at` を既に持つ契約に、より新しい注文が来た時だけ**
    (#229 A-2 の非対称ルール)。`last_order_at` を持たない契約 (= 実測が唯一の日付ソース =
    ① の主対象・本番 active の約半数) では、届いた注文が新しいのか古いのか判定できないため、
    **注文の事実だけを記録し、実測アンカー・skip 基準値・source には触らない**。
    過去注文の `orders/updated` (タグ後付け・出荷更新・返金) で実測は失われない
    (回帰テスト「前例なし契約に過去注文が届いても実測が生き残る」が固定)
  - 経緯: #227 の時点では前例なし層でも実測を破棄していた。「実測日以降の注文だけが
    derived に戻す」保護は当時**棄却**したが (実測を保持した行が後続のスキップ先送りを
    一切反映せず、スキップ済みの顧客へ確実に古い決済日を送るため)、その棄却理由は
    migration 074 (flow 行もスキップ増分を反映する) で解消済み。#229 で上記の
    非対称ルールへ改めた
  - derived に戻った契約は **C2 以降リマインドの送信対象から外れる**。日付が窓に入っても
    送らないので、差し戻しが誤送信になる経路は無い (次の Flow 発火で実測へ復帰するまで無送信)
