# サブスク gate (MENU / REMINDER) の開放条件 — 数値の明文化 (C2)

**作成**: 2026-08-05 (ロードマップ C2)。数値は 2026-08-02 の優先順位づけで合意した案が起点。
**判定の実測**: Admin Ops → `reminder-dry-run` の「**gate 開放条件の判定 (C2)**」セクションが
毎回機械判定する (`crit1` / `crit2` が両方 `1` になるまで開けない)。

## 前提: なぜ「開けない」がデフォルトなのか

判断軸は一貫して **「誤送信は回復不能・無送信は回復可能」**。

- 導出 (`estimate_source='derived'`) は「直近注文 + 周期」の推定にすぎず、
  **お届け日変更を原理的に追えない** (タグに現れない)。推定が外れたまま送ると
  「決済済みの顧客に『まもなく決済されます』」級の誤送信になり、取り消せない。
- 実測 (`estimate_source='flow'`、Shopify Flow → `/api/integrations/teiki-flow`) は
  Huckleberry 自身が言う「次回ご注文日」なので、送ってよい唯一の日付ソース。
- したがって **C2 で送信対象は「実測 + 受信 10 日以内」に限定済み** (コード側の恒久述語。
  `packages/db/src/subscription-contracts.ts` の `listContractsDueForReminder`)。
  gate を早く開けても derived 契約に誤送信が飛ぶことはないが、
  「開けたのにほぼ誰にも届かない」状態は運用の混乱を生むため、数値条件を置く。

## 開放条件 (数値)

| # | 条件 | 数値 | 実測列 (reminder-dry-run) | 2026-08-04 時点 |
|---|------|------|---------------------------|------------------|
| 条件1 | LINE 到達可能な連携済み active 契約 | **> 30 件** | `linked_reachable_active` / `crit1_linked_over_30` | 0〜数件 (連携済み顧客 10 人) |
| 条件2 | active 契約のうち実測 (flow) の割合 | **> 50%** | `measured_active` × 2 > `active_total` / `crit2_measured_majority` | 1 / 142 |
| 条件3 (運用前提) | teiki-flow の受信が生きている | 直近 72h で受信あり | cron-monitor (`teiki-flow-ingest` の沈黙検知、#229 B-1) が green | ✅ (8/4 実測 1 件受信) |

- **条件1 の意味 (分母)**: 送信可否ではなく「開ける価値」の判定。REMINDER を開けても
  届くのは 連携済み ∩ 実測あり ∩ 窓内 だけ。分母 30 未満で開けると
  「開けたのに月に数通」となり、効果測定も事故検知もできない。
  → 分母を動かすのは **C3 (App Proxy 連携導線)** の仕事。
- **条件2 の意味 (カードの信頼性)**: MENU を開けると契約カードの日付が顧客に見える。
  過半が実測なら「大半の顧客に Huckleberry と同じ日付」を出せる。derived 過半のまま開けると
  カードの日付の大半が「ごろ」推定になり、問い合わせとブランド毀損を生む。
  トリガー1 (決済 7 日前) は周期に沿って発火するので、**収集開始から最長周期 1 周
  (30〜90 日) で自然に過半へ到達する見込み**。到達しない場合は Flow 側の障害を疑う
  (cron-monitor と Shopify Flow 実行ログで切り分け)。
- **条件3 の意味 (測定器の生存)**: 条件2 が満ちても受信が止まっていれば実測は腐り始める。
  鮮度述語 (10 日) があるので腐った実測は送信されないが、開ける判断は受信が生きている時に行う。

数値は「08-02 時点の案」を起点に**実データで再検討可**。変更する場合は本ファイルと
`reminder-dry-run` の判定 SQL の両方を同時に更新すること (片方だけ変えると判定が嘘になる)。

## 開放の順序 (変更なし・再掲)

1. 条件1〜3 を `reminder-dry-run` で確認 (crit1 = crit2 = 1)
2. `SUBSCRIPTION_MENU_ENABLED=true` (顧客可視面。**Katsu 承認必須**)
3. カード表示を実機確認 (日付が Shopify 画面と一致するか — `contract-diagnose` op で照合可)
4. `SUBSCRIPTION_REMINDER_ENABLED=true` (ここで初めて push。**Katsu 承認必須**)

**K5: 条件到達の報告があるまで MENU / REMINDER / BROADCAST_ALL は押さない** (2026-08-05 合意)。

## C2 の送信述語 (コード側の恒久ガード・gate とは独立)

gate が開いた後も、送信は常に次の全てを満たす契約に限られる:

- `estimate_source = 'flow'` (実測のみ。derived は永久に送らない)
- `flow_measured_at` が **10 日以内** (`FLOW_MEASUREMENT_FRESH_DAYS`)。
  前サイクルの実測の取り残し (「お届け日変更 + 7日前通知」の両 Flow 喪失) を落とす。
  10 の根拠: トリガー1 は決済 7 日前発火 → 窓下限 (3 日前) でも受信 4 日後 = 余裕 2 倍強。
  前サイクルの実測は最短周期 20 日でも 13 日以上前 = 確実に落ちる。
  ⚠️ Huckleberry の「注文前確認メール」の日数 (現在 7) を 13 日超にするとここも要見直し
- 未解約・未一時停止・同一推定日で未送信 (従来どおり)
- 送信直前の再導出検算 (staleEstimate) と実測限定の関門 (notMeasured) を通過 (#229 A-1 系譜)

関連: `docs/TEIKI_FLOW_SETUP.md` (Flow 設定と受信仕様) /
`packages/db/migrations/075_flow_measured_at.sql` (受信時刻列) /
Admin Ops `contract-diagnose` (契約 1 件の照合)。
