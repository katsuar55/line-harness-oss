# サブスク UX 設計 — 未解決の宿題リスト (2026-07-25 採点ループ打ち切り時点)

本書は `docs/SUBSCRIPTION_UX_TAP_MINIMAL_2026-07-25.md` の**開いている論点**を確定させたもの。
4 ラウンドの敵対的採点 (計 46 エージェント) の到達点:

| 次元 | 最終 | 判定 |
|---|---|---|
| feasibility-now | **91** | ✅ pass |
| compliance | **90** | ✅ pass |
| brand-uxfeel | **90** | ✅ pass |
| migration-safety | 84 | 宿題あり |
| tap-efficiency | 81 | 宿題あり |
| trust-honest-failure | 78 | 宿題あり |

**打ち切り理由**: スコアが振動を始め (tap 87→81)、修正が新しい記述を生み新しい指摘を招く状態になった。
残る指摘はすべて **①移行窓 (Phase 3 領域) の縁のケース** と **②タップの計測単位の未定義**に集中しており、
**設計の方向性ではなく実装仕様の精度**の問題。実際に migration と test を書く段階で確定させるのが正しい。

> **重要な切り分け**: 開いている宿題は**すべて移行窓と受理台帳の縁**に関するもの。
> §10「今すぐ (Phase 3 非依存)」の 1・2・6 (fast path / LIFF 友だち追加オプション / 60代トークン) は
> **一切影響を受けないので、そのまま着手してよい**。

---

## A. 実装着手前に必ず決めること (実装 PR の設計セクションに書く)

### A-1. 鍵列を書き換える UPDATE の衝突解決 【trust HIGH】
`ux_sub_intents_open` は `(contract_ns, contract_key, target_cycle_key, op)` の partial UNIQUE。
一方、鍵列を書き換える経路が **2 つ**ある:
1. §5-4 窓明けの再アンカリング (複数の deferred を「次に課金される回」へ**多対一**で寄せる)
2. §1-2 の繰越し (`target_cycle_key` / `deadline_at` を次サイクルへ UPDATE)

窓が 1 サイクルを跨ぐと同一 op の deferred が 2 行でき、両方が同じ鍵に潰れて **UNIQUE 違反**。
§5-4 が必須とする「ns 付け替えと同一トランザクション」ごと abort し activated が進まなくなる。

**決めること**: 同一 op の畳み込み規則。推奨 = **最新の意思を残し、古い方を `superseded` にする**
(`supersedes_intent_id` は既にスキーマにある)。両 UPDATE 経路に `ON CONFLICT` 相当の解決を書く。
§5-1 の supersede 規則は `cancel > pause` の優先順位しか扱っていないので、**同一 op の畳み込みは別途定義が要る**。

### A-2. `deferred` の出口を 3 入口すべてに用意する 【trust HIGH】
`deferred` の**入口は 3 つ**ある:
1. §5-1 移行窓 (`executor='blocked'`)
2. §5-3 breaker / billing-kill による縮退
3. §5-4 再アンカー後の顧客回答待ち

しかし**出口が定義されているのは 1 と 3 だけ**。§4-2 の二段 sweep は `state='received'` 述語なので
`deferred` を拾わない。結果、**breaker/kill 中に受理した skip/date は解除後も誰も再評価せず永久に滞留**する。
§1 の「完了 or 正直な失敗を必ず通知」がこの分岐でだけ成立しない。

**決めること**: breaker/kill 解除時に該当 `deferred` を `received` へ戻す再評価トリガ。
(PHASE3 §8 の解除 runbook は attempt バックログの分散しか扱っておらず、intent 台帳に触れていない → runbook 側も改訂が要る)

### A-3. 窓入場時に in-flight intent を凍結する 【migration HIGH】
窓入場 (`snapshotted`) 時に、既存の `received` (executor='human') を `blocked`/`deferred` へ遷移させる規定が無い。
§4-2 の除外述語は `executor <> 'blocked'` だけなので、**入場前に受理された skip/date が窓中に締切を跨いで
`expired` + 「間に合いませんでした」通知に落ち、その後 catch-up がそのまま課金する**。

到達経路は現実的:
> 決済 7 日前にリマインド → 顧客タップ → 決済 5 日前に snapshotted 入場 → 決済 3 日前 (締切) を窓中に通過

**決めること (修正は軽微)**: `snapshotted` 遷移時に当該契約の未解決 intent を
`executor='blocked'` / `state='deferred'` へ**一括変換**し、§5-4 の再アンカリング対象に載せる。

### A-4. 実行可否 gate の適用範囲を明示する 【migration MEDIUM】
§5-3 の gate 式に `SELF_BILLING_ENABLED` を AND しているが、これが
**own_billing 実行だけを指すのか、代行 (executor='human') を含む全実行を指すのか**が未定義。
- 全実行と読む → `SELF_BILLING_ENABLED` は Phase 3 まで OFF なので **§10 の「今すぐ」3〜5 が出荷即座に実行不能**
- own_billing 限定と読む → §5-2 の「代行実行も止める」を担保する述語が式から消える

**決めること**: 式の適用範囲を明示するか、**代行実行用の phase ガードを別立て**にする。

### A-5. `rolled_back` 出口の deferred 処理 【migration MEDIUM】
窓の出口として `activated` しか結線されていない。`rolled_back` (PHASE3 §7 の正規経路) で出た場合、
再アンカリングは own 側前提で書かれているため、**HB 側へ戻る非対称処理** (ns 据置 / `executor='human'` 復帰 /
HB 側締切の再計算) が未定義。放置すると deferred が「承りました」表示のまま永久滞留する。

---

## B. タップ数の受入条件を先に定義する 【tap HIGH】

§3-1 は描画幅について「40 字チェックではなく**実機 320px で切れないこと**」という受入条件まで書いたのに、
**タップ数側には受入条件が無い**。このままだと実装時に静かに +1 して「2→1」の看板だけが残る。

**決めること**:
1. **「1 タップ」の単位を定義する** (物理タップ数か、カード表示からの操作数か)
2. **`日付変更 = 1` の経路を確定する**。現状 §10-5 のカード構成からは導出できない
   (datetimepicker も QR プリセットも 2 タップ)。1 タップにするなら
   **カード上に `[1週間ずらす]` 等のプリセットを直接置く**必要があり、本文に定義が無い
3. **`[お休み・解約]` を統合ボタンにするか 4 ボタンにするかを確定する**
   - 統合 (07-24 設計 S0 踏襲) → 一時停止 2 / 解約 3 になり §2 の 1 / 2 と食い違う
   - 4 ボタン (§7-3 の例外を根拠) → §2 の 1 / 2 が成立する
4. 各フローに **「実機で N タップで完了すること」の受入条件**を書く

---

## C. Katsu 判断待ち (設計を分岐させる)

> ### 🔒 2026-07-26 実地確認で C-1 は解決した (回答待ちではない)
> Huckleberry の メール設定「設定を開始する」を実際に押した結果、
> **「送信元の設定にはENTERPRISEプランにアップグレードが必要です。」** のダイアログが出た。
> 併せて料金プラン画面を確認: **FREE $0 / STANDARD $49 (現行) / ENTERPRISE $299**、
> ENTERPRISE だけの機能に **「API連携」と「メールの送信元ドメインの設定」の両方**が列挙されている。
>
> **したがって `executor='api'` の道は $299/月 (差額 $250/月 ≈ ¥37,500/月、年 ¥45万) を払わない限り開かない。**
> サブスク MRR ¥277,493 に対し 13.5% にあたるため、**既定は「買わない」= 代行 3 層 (§4) は残る**とする。
> 受理レイヤー (intent ledger) で executor を後から差し替える設計にしておいたことがそのまま効く。
> 独自ドメイン送信も同じゲートの内側なので、**移行前の Huckleberry メールは
> `@huckleberry-inc.com` のままと確定**した (Shopify 側で完了した `kenkoex.com` のドメイン認証が
> 効くのは Shopify 自身が送るメールだけ)。**買うか自前化するかは Katsu の経営判断**。

| # | 論点 | 影響 |
|---|---|---|
| 1 | ~~Huckleberry API 連携の可否~~ → **ENTERPRISE ($299/月) 限定と確定** (上記) | 買わない限り `executor='api'` は無い。§4 の代行 3 層と A-2/A-3/A-4 は**そのまま必要** |
| 2 | **スタッフが HB 管理画面で代行できるか (未検証)** | **一度も検証していない**。C-1 が閉じた今、**これが移行前 UX の唯一の実行手段**であり、最大の未検証リスクに昇格した。07-24 調査が確認したのは**顧客マイページでの skip/解約**であって店舗側代行ではない。**成立しなければ移行前の実行手段が消える** |
| 3 | rollback 禁止の開始点が PHASE3 (`huckleberry_stopped`) と本書 (`hb_stop_requested`) で **1 phase ずれている** | どちらに揃えるか |
| 4 | 二重 skip 検出が `estimate_source='flow'` 前提 | TEIKI_FLOW 設定まで測定不能 = human claim の自動解放停止の根拠が一部未成立 |
| 5 | 差出人ドメインを `kenkoex.com` のままにするか `naturism-diet.com` へ寄せるか | メールドメイン認証の対象が変わる |

---

## D. 影響を受けない = 今すぐ着手してよいもの

1. ✅ **`?slk=` fast path** — 2026-07-26 実装済。`captureSubLinkToken()` を `liff.init()` 前へ、
   `checkSubLinkParam()` を `idToken` 代入直後 (12 loader の `Promise.all` / `loadRank` より前、非 await) へ。
   sessionStorage 退避は §6-4 の削除条件 4 つ込み + `sub` スコープ。sub-link 経路の 401 は
   `handleAuthExpired` を撃たない (`api(..., {softAuth:true})`)。ツアーはカード表示中は抑止し閉じたら解放。
   併せて `subLinkResult` の**閉じるボタン appendChild 欠落**を修正 (連携成功直後に閉じられないモーダルだった)。
2. ⏳ **LIFF「友だち追加オプション」= On(normal)** — LINE Developers コンソールがログイン必須のため **Katsu 作業**。
3. ✅ **60代可読性トークン** (§7) — LIFF 側を実装済 (下記)。**Flex 側 (`action.label` 全角 8 字 / `size` 規約) は未実装** =
   §10-5 のリマインドカード実装時に同時に入れる。
4. ✅ **shimmer 先出し** — `subLinkShowLoading()` として実装済。

### 実装時に決めた解釈 (§7 の適用範囲)
- `.btn-primary` は §7-1 の第一推奨どおり **solid `#0f766e` (5.47:1)**。`#0f766e` は Flex/メール面で既に
  使っている既存トークンなので新色は増えない。
- **min-height 48px は連携カード (`.sublink-btn`/`.sublink-sub`) に限定**。全 `.btn-primary` への一括適用は
  40+ 箇所のレイアウト回帰を伴うため別 PR とする。
- §7-1 の閾値規定は「全 surface 共通」なので、**二次 LIFF 5 ページ (opt-in/reorder/food/food-graph/coach) の
  LINE 黄緑 (白文字 2.2:1) と my-rank の `#0ABAB5` (白文字 2.5:1) も同時に是正**した。
  my-rank の該当箇所は**セルフ連携ボタン (§6 経路1)** そのものだったため、放置は到達戦略と矛盾する。
