# WI-3 設計書 v5 採点 R5 残 findings (2026-07-19)

次セッションで v6 修正に使う作業メモ。
**スコア: state-machine 84 (唯一の未達) / migration-safety 93 ✅ / ops-killswitch 96 ✅**。
dunning 92 / verifiability 92 は R4 で pass 済み → **v6 は state-machine の 5 findings
(HIGH 1 + MEDIUM 2 + LOW 2、各 FIX 具体記載済み) を反映して state-machine のみ再採点すれば完了**。
pass 済み次元の MEDIUM/LOW (下記 migration 93 / ops 96 の findings) も v6 で安価に畳めるなら畳む。

### [MEDIUM] 移行窓中 (own_created_paused〜activated) の顧客操作と phase 機械の相互作用が未規定
migrated_to は hb_stop_requested で印字され、own_sub_contracts には paused 行が先行採録される。SELF_BILLING_UI_ENABLED が ON のバッチ運用時 (2バッチ目以降)、窓中の顧客が WI-1 カード/マイページで自分の own 契約を「一時停止中」と見て §6.7 再開を実行すると、billing_aligned の確定前に activate + 次アンカー scheduleEdit が走り得る。5日実行窓+48h整合の時系列により実課金前に activated の scheduleEdit(target) が上書きするため通常は自己修復するが、billing_aligned ① hold で数日停滞した場合は 承継日 に own が課金し HB in-flight と重複し得る (14日監視+返金で補償される事後レーン)。同様に窓中の顧客 cancel を phase 機械が受けた際の遷移 (activate 失敗時の終端化) も未規定。破綻には UI enable 中×窓中操作×hold 長期停滞×HB in-flight の重畳が必要で、補償レーンが受けるため MEDIUM。
FIX: §7 に「sub_migration_snapshots の phase が own_created_paused〜billing_aligned の契約は WI-1/マイページの操作 (§6.6/§6.7) をブロックし『お切り替え手続き中』を表示。窓中の cancel 意思は snapshot に記録し activated 直後に §6.6 cancel として実行」の 1 項を追加。10.2 negative に「窓中の §6.7 再開試行が reject される」を追加

### [LOW] billing_aligned ① hold の基準値再確定規則が人間裁量のみ — HB 課金起因の不一致で二重加算 (過小請求方向) の余地
HB の in-flight 課金が Order 生成と同時に HB 側の次回日タグも前進させた場合、① 差分検査が hold し、Katsu が事後値 (旧+interval) を基準値に再確定すると ② が Order 検出でさらに +interval し旧+2×interval になり得る。「①と②の二重加算はしない」の主張は基準値の確定箇所の一意性のみを機構化しており、この分岐の判断規則は未記載。方向は顧客有利 (1サイクル無償) で人間介在下、HB 停止後はタグ前進自体が起きにくいため LOW。
FIX: §7.3 or ① の hold 手順に「不一致が snapshot 以後の HB Order で説明できる場合は基準値=snapshot 値のまま ② に委ねる (② が +interval を担当)。Order で説明できない不一致のみ再取得値を採用」の判定規則を 1 行追記

### [LOW] EXCLUDELIST「自動追加」の格納先が env-secret parser 前提と両立していない
§8 の SELF_BILLING_EXCLUDELIST は allowlist と同一 parser (parse 不能=fail-closed、\r trim) で env/secret 形式を示唆し、breaker_tripped のみ (D1) と明記される一方、§7③ は cron による「EXCLUDELIST に自動追加」を要求する。Worker は自身の secret を書き換えられないため、自動追加には D1 overlay (secret ∪ D1 隔離テーブル) が必要だが未記載。未解決でも Discord alert→手動追加に劣化するだけで、次回課金まで約30日の猶予があるため LOW。
FIX: §8 の EXCLUDELIST 行に「= secret リスト ∪ D1 quarantine テーブルの和集合。§7③ の自動追加は D1 側へ INSERT」と格納先を明記

### [LOW] activated 手順の activate→scheduleEdit 順序に crash 窓 (性質は 10.2 unit でピン留め済み)
§7 activated は「activate → own_sub_contracts 更新 → scheduleEdit(target)」の順で、target=+interval (HB 課金済) かつ cycle1 予定日が過去の場合、activate 後 scheduleEdit 前に crash すると次 tick の due 発行が旧予定日で attempt し二重課金し得る。10.2 に「activate 直後 tick の二重発行なし」unit が明記され性質は要求済みだが、達成手順 (D1 status の active 化を scheduleEdit 成功後にする等) は実装裁量に残る。
FIX: activated の記述を「scheduleEdit 成功を確認してから own_sub_contracts.status を active 化 (D1 が発行述語の読み先であるため)」の順序制約付きに 1 語補強

### [LOW] 長期 stall 後の catch-up でアンカー固定則により課金が近接圧縮し得る
anchor_date+k×interval 固定のため、billing_aligned hold が長期化した後の catch-up (当日課金) 直後に次アンカーが数日〜十数日先に来て、30日周期の顧客が短期間に 2 回課金され得る。phase 滞留 48h alert と 5 日実行窓検査で通常到達しない運用捕捉済みの edge であり、各課金は対応するお届けを伴うため実害は限定的。
FIX: WI-5 runbook に「catch-up 実行時に次アンカーまで N 日未満なら次サイクルを skip するか顧客に事前通知する」判断基準を追加 (設計本文の変更は不要)

### [HIGH] pending_new_card が failure webhook 経路で評価されず、B/E クラスで自動再試行トリガを永久喪失する (§6.3 の回収約束と §4.1 閉包規則の race 矛盾)
§6.3 は「S3 中のカード更新 = contractUpdate + pending_new_card=1、失効 sweep がフラグを見て S5 化の代わりに §6.4 の 4 手順で自動再試行」と約束するが、フラグを読むのは §5.2 の失効 sweep のみ。一方 §4.1 閉包規則は「attempting claim を failed 化した failure webhook は現在状態によらず §6.2 matrix が遷移先を決める」と絶対規則で定め、§6.3 も「decline failure → matrix 再分類」と明記する。matrix はフラグを参照しない。具体的時系列: day0 attempt→challenged webhook→リンク送付。day1 顧客が新カード追加 → contractUpdate + pending_new_card=1 (発行なし、正しい)。day2 顧客が 3DS を試行し旧カードで最終 decline → failure webhook が 72h sweep より先に着弾 → 閉包規則により matrix 直行。(a) B クラス (EXPIRED_CARD 等、コードは旧カード起因) → await_card + 即日 card_request 通知 — カードを更新した直後の顧客に「カード更新してください」を送る。§6.4 の pm create/update webhook は既に消費済みで再来しない → deadline (min(失敗+7d, scheduled+13d)) 経過で S5。(b) E クラス (DO_NOT_HONOR 等) → 即 S5 リトライ禁止 — 新カードは一度も試行されないまま停止。いずれも検出器なし (S5 遷移は正常フローで alert 対象外)、compliant な顧客が silent に停止する。A クラスのみ retry_wait +3d が契約の現 pm (=新カード) で再試行するため偶然自己回復する。v5 自身が掲げた「トリガの永久喪失を防ぐ」(§5.
FIX: §6.2/§6.3 に 1 規則追加: 「failure webhook で attempting claim を failed 化する際、pending_new_card=1 なら matrix 適用前に §6.4 の 4 手順 (新カードで claim CAS 再入 attempt_no++ → 1 回再試行) を実施し、その失敗で初めて matrix 分類する」。閉包規則 (§4.1) に本例外を明記し、10.3 の pending_new_card レーン unit に「webhook-first ordering (sweep 前の decline 着弾)」ケースを追加する。

### [MEDIUM] challenged pending 待機レーンの終端 wiring が未定義: I-6 の executor が I-6 自身の定義と矛盾し、サイクル放棄後の dunning_state='challenged' に解放規則がなく、遅延 failed は audit-only で matrix に届かず契約が永久に発行対象外となる
3 点が連鎖する。(1) §5.2 は「scheduledDate+14日で I-6 がサイクルを放棄 (skip+abandoned+alert)」と主張するが、I-6 の定義 (§4.1) は「resolveBillableCycle 内で強制 = 全発行経路に効く」。pending 待機中の契約は due 発行から除外 (dunning∈{none,retry_wait} のみ) され、sweep も発行しないため、resolveBillableCycle は一度も呼ばれず、文書の定義上 I-6 の実行主体が存在しない。(2) 放棄が (sweep 直接実行と好意的に読んで) 行われても、dunning_state を 'challenged' から解放する規則がない — リセットは I-4 (success) と「attempting claim を failed 化した failure webhook」の matrix のみ。(3) 具体的時系列: day0 challenged、顧客放置、day3〜 sweep が毎日 +24h 延長・再照会 (pending 継続)、day14 サイクル放棄 (claim abandoned + skip + 次アンカー schedule)、day16 Shopify が 3DS を失効させ failure webhook 着弾 → claim は abandoned=resolved → 閉包規則の適用条件外で「audit のみ」→ matrix 不達 → dunning_state='challenged' が永久残留。day30+ 次サイクル due → §5.1 due 発行は dunning∈{none} を要求 → 永久に発行されない。overdue-unattempted 検出器が毎日鳴る (第二網はある) が、自動出口がなく、challenged を人為解除する op も未定義 (ops 解除 op は retry_policy=hold 専用)。なお day16 に sweep 側が failed を検知
FIX: §5.2 に追記: 「day14 判定と放棄処置 (I-6 と同一規則) は失効 sweep が自ら実施する」と executor を明示。放棄時 (または放棄後の failed 確定検知時) に dunning_state を解放する規則を追加 (推奨: 放棄と同時に S5 化 — §6.4 カード更新で回復可能な定義済み状態に置く)。claim 表の abandoned 行の扱い (放棄後 failed 確定は contract 状態のみ遷移し claim は abandoned 維持) を 1 行明記。

### [MEDIUM] §9 マイページの既存 vault 切替は payment_methods create/update webhook を発生させず、§6.4 復旧レーンが起動しない — dunning 中の顧客がカードを差し替えても回収されず deadline で S5 化する
§6.4 の起動トリガは「支払方法更新 (create/update webhook)」に閉じて列挙されている。しかし §9 は「支払方法変更 (vault 一覧から選択 → contractUpdate)」を提供する — 既存 vault の選択は新規 vault 作成でも更新でもないため、customer_payment_methods/{create,update} webhook は発火しない。具体的時系列: day0 S4h await_card (EXPIRED_CARD)、card_request 通知。day1 顧客 (非 LINE) が magic link でマイページに入り、手持ちの別の有効カード (既存 vault) に切替 → contractUpdate 成功 → しかし §6.4 は起動せず attempt は発行されない。day7 deadline 到達 → sweep が S5 化 + pause 通知 → 「もう直したのに停止された」。再度同じ操作をしても同様に無反応 (二度目の contractUpdate も webhook を生まない)。dunning 滞留検出器は「deadline+12h 超過」(= sweep の処置漏れ) を見るのみで、deadline 通りの S5 化は正常フロー扱いのため alert なし。新カード追加経路 (「新カスタマーアカウントへ誘導」) は webhook が発火するため無事であり、穴は既存 vault 切替経路に限定されるが、複数 vault 保持者 × dunning という §9/S4h の中心ユースケースそのものである。忠実な実装 (§6.4 のトリガ列挙に従う) はこの時系列を再現する。
FIX: §6.4 のトリガに「支払方法の contractUpdate を伴う全 UI 操作 (§9 マイページ / WI-1 LINE カード) の完了時」を追加し、webhook はその補完 (新カード追加経路) と位置付ける。防御として contracts/update webhook 受信時にも『失敗中契約 (S2/S4h/S5) で payment_method_gid が変化していれば §6.4 手順を評価』の fallback を明記。10.3 の並行競合 unit に「UI 起点 contractUpdate × 同一サイクル claim」を追加。

### [LOW] §6.7 再開保留 (旧 attempt 非 terminal) の再評価担い手が未指定 — 「§6.3 レーンの決着後に実行」と言うが、S6 では §6.3 レーンは当該契約を追跡していない
時系列: S3 challenged (attempt pending) 中に顧客が pause (常時受理) → I-3 で claim abandoned・S6 (paused/none、dunning_state 解除)。後日顧客が再開 → §6.7 前提により skip 処理を保留。しかしこの時点で当該 pending attempt を照会する常設機構は存在しない: sweep は dunning_state='challenged' の契約のみ対象 (S6 は対象外)、reconciliation は attempting claim のみ対象 (abandoned は非追跡) かつ challenged 契約除外。「決着」は自然着弾する webhook 頼みで、保留された再開を誰が・いつ再実行するかが未定義。顧客の再タップで解消し得るため実装裁量 (再開応答文言 + 顧客 retry、または日次再評価) で足りるが、「§6.3 レーンの決着後に実行」という記述は実在しない機構への参照であり、待機 vehicle を 1 行明示すべき。
FIX: §6.7 に「保留時は顧客へ『決済確認中』応答を返し、決着 (webhook 着弾 or 顧客の再操作時の再照会) 後に skip 処理を実行する」と待機 vehicle を明示。もしくは pending attempt を持つ abandoned claim の日次照会を §5.4 日次ジョブに追加。

### [LOW] 日付変更の上限が未定義 — 次アンカーを越える変更で、§7 が自ら回避を宣言した「過去日 scheduleEdit」への依存が success 処理経路に発生する
§6.6 日付変更は単発 (anchor 不変) だが変更可能範囲の上限がない。時系列: anchor 列 day30/60/90。顧客が cycle k (day30) を day65 に変更 (長期不在等、interval 30 日超の後ろ倒し)。day65 に success → I-4 が cycle k+1 へ scheduleEdit(次アンカー = day60) を発行 — 過去日。§7 catch-up 設計は「過去日 scheduleEdit という未検証挙動に依存しない」ことを明示的な設計原則としたのに、この経路では依存が復活する。Shopify が拒否すれば cadence_repair_needed → 日次 repair も過去日のまま永久失敗 → 乖離検出 alert 常鳴 + 人間介入。受理されれば day65 課金の直後に day60 分が即 due となり連続課金 (カデンツモデル上は正当だが UX 上の苦情リスク)。WI-1 の選択肢設計 (上限 = 次アンカー −1 日、締切ガードと対) を設計側で 1 行拘束すれば消える。
FIX: §6.6 日付変更に「変更可能範囲: 明日〜次アンカー日の前日」を明記し、WI-1 カードの選択肢生成をこの範囲に拘束する。10.3 締切ガード境界 unit に上限側の境界を追加。

### [LOW] I-6 放棄後も challenged が残る契約の後処理 (dunning_state の戻し先) が未定義
§5.2 の pending 待機レーンで 3DS pending が 14 日超残存し I-6 がサイクルを skip+abandoned+alert した後、契約の dunning_state を challenged から戻す規定がない。due 発行は dunning∈{none} 条件のため次サイクルも発行されず、14 日毎に I-6 放棄が連鎖し得る。独立 overdue 検出器と I-6 alert が毎回検出するため沈黙はせず、3DS pending の永続自体は E2E ⑪ で実測予定 (失効確認なら発生しない) — 検出網は完備なので設計破綻ではないが、放棄後の contract 処置 runbook (人間 op で none 戻し等) が WI-4 送りになっている。
FIX: §5.2 または解除 runbook に「I-6 放棄後: 旧 attempt を watch 対象に残しつつ dunning_state を ops 判断で none へ戻す op」を 1 行追記 (WI-4 で ops op として実装可)

### [LOW] §6.7 再開保留 (旧 attempt 非 terminal) の再評価駆動と滞留検出がない
S6→S1 再開時に旧 attempt が非 terminal なら skip 処理を保留し §6.3 レーンの決着を待つが、pause 時点で dunning_state は none 化済みのため §5.2 の challenged sweep (毎日再照会) の管轄外。決着を能動的に駆動するジョブと「再開保留 > Xh」の滞留検出が未指定で、顧客が 3DS を放置したまま pause→resume した場合に保留が受動 webhook 頼みになる。CAS の no-parallel-attempt 照会が二重課金は構造封鎖しており、3DS 自然失効 (E2E ⑪ で実測) があれば自然解消するため影響は限定的。
FIX: §6.7 の保留に「日次再照会 (§5.4 サイクル再同期に相乗り) + 48h 滞留 alert」を追記

### [LOW] resolved/abandoned claim への遅延 challenged webhook の扱いが failure/success ほど明文化されていない
閉包規則は「resolved 済みへの遅延 failure = audit のみ」「遅延 success = §6.3/§6.6 明示規則」と規定するが、challenged webhook が abandoned claim (例: pause 直後に in-flight attempt が 3DS 化) に届いた場合の規則がない。素朴に dunning_state=challenged を立てると paused/challenged という状態表 (§4.1) 外の組合せが生じ、失効 sweep が顧客都合 pause の契約を S5 (exhausted) 誤処置し得る。attempting claim 限定で §6.3 を起動する実装が自然であり WI-4 裁量で解決可能だが、webhook 3 種のうち challenged のみ resolved-claim 規則が欠けている。
FIX: §6.3 に「attempting claim を持つ場合のみレーン起動、resolved/abandoned claim への challenged は audit のみ (遅延 success/failure 規則が後続を受ける)」を 1 行追記

### [LOW] breaker の「日次 due 予測」と「ALL 時の母数 = active な own 契約数」の掛かり先が一意でない
§8 の trip 条件「24h 発行 > max(10, 日次 due 予測×3)」で、「ALL 時の母数 = active な own 契約数」が due 予測の算出母集団を指すのか due 予測そのものを指すのか読み分けが必要。後者と誤読すると 76 契約時の閾値が max(10, 228)=228 となり、全契約への誤発行 (76 件) でも trip しない。前者 (母集団のスケジュールから当日 due 件数 ~2.5 を予測) が意図と思われ、その場合閾値 10 で正しく機能する。§10.3 に trip 条件算術の境界値 unit が列挙済みなので実装時に固定されるが、文言の一意化が望ましい。
FIX: 「日次 due 予測 = 母集団 (allowlist match、ALL 時は全 active own 契約) のうち当日 scheduled の件数」と定義を 1 行明記
