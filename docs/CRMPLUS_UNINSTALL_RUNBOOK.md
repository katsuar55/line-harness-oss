# CRM PLUS on LINE アンインストール runbook (WI-6)

対象: Social PLUS 提供「CRM PLUS on LINE」アプリの削除。Free プラン・連携 0 人・ボット機能は
webhook を harness が保持済みで無効。**唯一の依存 = friend↔customer 逆引き (夜間 cron) が読む
`socialplus.line` customer metafield** (2026-07-19 secret-list 実査: `FRIEND_LINK_METAFIELD_*`
のみ socialplus 参照。forward 書込 (`ACCOUNT_LINK_METAFIELD_*`) は secret 未設定で
コードデフォルト `naturism.line_user_id` が実効値 = CRM PLUS 非依存)。

方針: D1 `friends` を正として自己所有の公開 namespace **`lineharness.line_user_id`** へ
書き戻し、検索経路のパリティと旧 namespace の棚卸しを実証してから secret を切替え、
その後アンインストールする。

## 前提

- PR (WI-6) merge + auto-deploy 済み (migration endpoint が本番に存在すること)
- `apps/worker/cutover-apikey.txt` の API_KEY が有効。**401 が返る場合の復旧**:
  GitHub Repository Secret `WORKER_API_KEY` に新しい値を保存 → Admin Ops op
  `put-worker-api-key` を実行 → 同値を cutover-apikey.txt に保存
  (⚠️ 保存時に改行を混ぜない: `printf '%s' '<値>' > apps/worker/cutover-apikey.txt`。
  過去に PowerShell 経由の末尾 `\r` 混入で「値は正しいのに 401」が実発生している)
- 実行はすべて冪等 — 失敗時は原因解消後に同じコマンドを再実行してよい
- 各エンドポイントは Workers Free の subrequest 上限 (50/呼び出し) 内に収まるよう
  **チャンク実行** (`limit`/`offset`) になっている。`remaining` / `nextCursor` が
  0 / null になるまでループする
- 出力は生 JSON (jq 不要。読みにくければ末尾に `| node -e "process.stdin.on('data',d=>console.log(JSON.stringify(JSON.parse(d),null,2)))"` を付けてもよい)

```bash
WORKER=https://naturism-line-crm.katsu-7d5.workers.dev
KEY=$(cat apps/worker/cutover-apikey.txt)
AUTH="Authorization: Bearer $KEY"
```

## 手順

### 1. dryRun — 対象件数の確認 (書込・Shopify 呼び出しゼロ)

```bash
curl -s -X POST "$WORKER/api/integrations/shopify/line-metafield-migration" -H "$AUTH"
```

`candidatesTotal` = D1 連携済み friend 数 (2026-07-19 時点 ~20 想定)。

### 2. 実行 — 定義作成 + backfill + 直読検証 (チャンクループ)

```bash
# offset を 0, 10, 20, ... と進め、remaining が 0 になるまで繰り返す (1 回 10 件処理)
curl -s -X POST "$WORKER/api/integrations/shopify/line-metafield-migration?execute=1&offset=0" -H "$AUTH"
curl -s -X POST "$WORKER/api/integrations/shopify/line-metafield-migration?execute=1&offset=10" -H "$AUTH"
# ... remaining=0 まで
```

**合格条件 (全チャンクの合計で):** `written 合計 == candidatesTotal`、
`verifiedDirect 合計 == candidatesTotal`、各応答で `verifyMismatch == 0`・`failed == 0`・
`writeErrors == 0`、最初のチャンクで `definition ∈ {created, exists}`、最後に `remaining == 0`。

### 3. (5分以上あけて) 検索経路パリティ — linker と同一経路で全件解決を実証

```bash
# offset を 0, 20, 40, ... と進め、processed の合計が candidatesTotal になるまで
curl -s "$WORKER/api/integrations/shopify/line-metafield-migration/verify?offset=0" -H "$AUTH"
```

**合格条件:** `resolved 合計 == candidatesTotal`、`unresolved == 0`、`failed == 0`
(応答の `namespace/key` は lineharness/line_user_id、`nsSource: "default"`)。

`unresolved` が残る場合、原因は 2 つ:
- **Shopify 検索インデックス未反映** → 10-30 分後に再実行
- **手順 2 以降に新規連携が成立** (OTP/注文 webhook 経由) → 手順 1 の dryRun で
  `candidatesTotal` が増えていないか確認し、増えていれば **手順 2 を再実行**
  (冪等なので安全) → 手順 3 を再実行

上記 2 つで解消しない場合のみ中止して原因調査 (secret 切替に進まない)。

### 4. secret 切替

GitHub Actions「Admin Ops」→ op = **`switch-link-metafield`** を実行
(FRIEND_LINK / ACCOUNT_LINK の metafield ns/key を lineharness/line_user_id に統一)。

### 5. 切替後の確認

```bash
# useSecret=1 = FRIEND_LINK secret の実効値で検証。応答の namespace/key/nsSource で
# 切替が効いたことを目視確認できる (期待: namespace=lineharness, nsSource=friend_link_secret)
curl -s "$WORKER/api/integrations/shopify/line-metafield-migration/verify?useSecret=1&offset=0" -H "$AUTH"
```

**合格条件:** `nsSource == "friend_link_secret"` かつ `namespace == "lineharness"` かつ
`key == "line_user_id"` かつ `resolved 合計 == candidatesTotal`。

さらに手順 2〜4 の間に新規連携が成立した可能性を潰すため、**手順 2 (execute) をもう一度
全チャンク実行**してから (以後の forward 連携は切替済み secret で lineharness に直接書くため
これが最後の追補)、上記 verify を再実行して green を確認する。

### 6. 旧 namespace の棚卸し (アンインストール直前・必須)

「socialplus.line に値があるのに D1 に無いリンク」が存在しないことを全顧客スキャンで証明する
(アンインストールは不可逆のため。検索インデックス非依存のカーソル走査)。

```bash
curl -s "$WORKER/api/integrations/shopify/line-metafield-migration/legacy-audit" -H "$AUTH"
# nextCursor が返ったら: .../legacy-audit?cursor=<nextCursor> で続きを走査 (全 ~6,600 顧客 ≈ 2 回)。
# matchingCapped=true も同じ意味 (D1 照合予算切れ) — nextCursor で再呼び出しすれば完遂できる
```

**合格条件 (全呼び出しの各応答で):**
- `unmatchedTotal == 0` かつ `matchFailed == 0` かつ `firstError == null`
- 算術閉包: `matchedInD1 + unmatchedTotal + matchFailed == withLegacyValue`
  (= 値持ち customer が 1 件残らず照合されたことの検算)
- 最終応答で `nextCursor == null` (= 全顧客走査完了)

`unmatchedTotal > 0` の場合 = socialplus.line に値を持つが D1 未リンクの customer
(`unmatchedCustomerIds` に最大20件列挙)。id を控えて中止し、原因調査 (D1 へのリンク追加 or
無視してよい残骸かの判断) をしてから進む。`matchFailed > 0` は D1 一時エラー等 —
同じ cursor で再実行する (冪等)。

### 7. CRM PLUS on LINE アンインストール (Katsu、Shopify Admin → 設定 → アプリと販売チャネル)

- ⚠️ **この操作以降 `rollback-link-metafield` は使えない** (socialplus.* が削除されるため)。
  手順 1〜6 の合格条件がすべて green であることを確認してから実行すること
- アンインストールでアプリ所有の `socialplus.*` metafield/定義が削除されても、
  `lineharness.*` は公開 namespace + 自社カスタムアプリ書込のため影響なし

### 8. アンインストール後の確認 (翌日)

- 手順 5 の verify (useSecret=1) が green のまま
- friend-customer-linker cron (JST 02:00) の audit (`loyalty_customer_link.scan_completed`)
  が記録され errors=0 (注: この cron は未連携 friend の新規リンク用。既存リンクは D1 保持で無影響)

## ロールバック

- **手順 7 の前** (socialplus.line 残存中): Admin Ops op = **`rollback-link-metafield`**
  (FRIEND_LINK → socialplus/line、ACCOUNT_LINK → naturism/line_user_id = 移行前の実効状態)
- **手順 7 の後**: socialplus.line は消えている可能性が高くロールバック不可。
  ただし D1 `friends` が正であり、lineharness.line_user_id も残るため、連携機能は
  lineharness 経路で継続する (= 戻す理由が発生しない)

## 影響範囲 (変わらないもの)

- D1 `friends.shopify_customer_id` の既存リンクは一切触らない (Shopify 側 metafield のみ追記)
- 注文 webhook の email 照合リンク (PR#86)・OTP forward link の成立ロジックは無変更
- ランク/クーポン/サブスク等、friend↔customer リンクを前提とする全機能は D1 参照のため無影響

## 既知の受容事項

- friend が別 customer へ re-link した場合、旧 customer の lineharness 値は残り、検索経路は
  値一致 2 件で ambiguous (null) になる。forward 連携 (naturism ns) 由来の既存特性と同型で、
  D1 が正のため機能影響なし
