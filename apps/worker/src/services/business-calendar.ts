/**
 * 営業カレンダー (§4-1 promised_by の算出、 §10-4、 2026-08-07 / **2026-08-08 更新**)
 *
 * ## 確定している部分
 *   - **サポート時間は 10:00-17:00 JST** (2026-08-08 Katsu 指示 と、製品内の顧客向け案内
 *     5 箇所「受付: 平日10:00〜17:00」が一致する)
 *   - 約束 (promised_by) = **翌営業日 17:00 JST** (= サポート終了時刻)
 *
 * ## 土曜の扱い (⚠️ 未確定・保守側で運用中)
 * 2026-08-08 に Katsu から「休みは日曜と祝日」= 土曜も営業、との指示があった。しかし
 * **commit 5838fa6 (2026-06-15「運用系ファクトを公式ポリシー準拠に修正」) が、まさに
 * 逆方向の確定を行っている**:
 *   旧「平日10:00〜17:00、日祝休み」→ 新「平日10:00〜17:00、土日祝・年末年始を除く」
 * (テストにも「旧『日祝休み』= **土曜営業の誤解** を土日祝に修正」と明記され、
 *  ai-response / ai-message-builder / faq-context / contact-email-page の 4 面 +
 *  seed-naturism-faq-v3.sql が「土日祝休み」で顧客に案内している)
 *
 * **矛盾が解消されるまでは土曜も休み扱いにする** (= 現行の顧客向け案内と一致する側)。
 * 理由は誤りの非対称性: 余分に休みにする誤り → 約束が 1 日遅くなるだけ (安全側)。
 * 出社しない日を約束する誤り → §4-2 の謝罪 push が構造的に量産される (危険側)。
 * **土曜営業で確定したら `SATURDAY_IS_BUSINESS_DAY` を true にするだけで切り替わる**
 * (同時に上記 5 箇所の顧客向け文言も更新すること — 片方だけ変えると案内と実態が食い違う)。
 *
 * ## 受理時刻を見ない設計
 * 10:00 受理も 16:59 受理も同じ「翌営業日 17:00」。実行はスタッフの手作業で当日完了を
 * 保証できないため。実測が貯まったら「営業時間内の受理は当日 17:00」へ短縮できる。
 *
 * 出力形式は deadline_at (`YYYY-MM-DDTHH:mm:ss.sss+09:00`) と同じ固定幅 —
 * `promised_by > deadline_at` (§4-1 の開示判定) と sweep の `promised_by < now`
 * (toJstString と同形式) を文字列比較で成立させる。
 */

const JST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;

/** サポート終了時刻 (JST の時) = 約束する時刻。「翌営業日 17:00」の 17。 */
export const BUSINESS_PROMISE_HOUR_JST = 17;

/**
 * 土曜を営業日として扱うか。**現在 false** (= 顧客向け案内「土日祝・年末年始を除く」と一致)。
 * 2026-08-08 の Katsu 指示 (日曜と祝日のみ休み) と commit 5838fa6 の確定が矛盾しているため、
 * 解消まで保守側 (休み) で運用する。ヘッダのコメント参照。
 */
export const SATURDAY_IS_BUSINESS_DAY = false;

/**
 * 日本の祝日 + 年末年始休業 (固定リスト・**年 1 回の手更新が必要**)。2026 後半〜2027 分。
 * 祝日を無視すると誰も出社しない日を約束し、連休のたびに §4-2 の謝罪 push が量産される
 * (§10-4 監査 CONFIRMED)。リスト末尾 (2027-12) を過ぎて未更新でも「日曜のみ定休」に
 * 劣化するだけで壊れない (= 約束が早まる側 = 危険側なので、年 1 回の更新を怠らないこと)。
 */
/**
 * 祝日テーブルが有効な最終日。**これを過ぎた日付は営業日と断定しない** (= 約束しない)。
 * JP_HOLIDAYS_JST を延長したらここも必ず伸ばすこと (伸ばし忘れ = 約束が出なくなるだけ = 安全側)。
 */
export const HOLIDAY_TABLE_VALID_THROUGH = '2027-12-31';

/** promised_by 探索の上限日数 (無限ループ防止。年末年始 + 連休でも 20 日あれば足りる)。 */
const MAX_PROMISE_SEARCH_DAYS = 400;

export const JP_HOLIDAYS_JST: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-12', '2026-02-11', '2026-02-23',
  '2026-03-20', '2026-04-29', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06',
  '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12',
  '2026-11-03', '2026-11-23', '2026-12-29', '2026-12-30', '2026-12-31',
  // 2027
  '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-11', '2027-02-11', '2027-02-23',
  '2027-03-22', '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05', '2027-07-19',
  '2027-08-11', '2027-09-20', '2027-09-23', '2027-10-11', '2027-11-03', '2027-11-23',
  '2027-12-29', '2027-12-30', '2027-12-31',
]);

/**
 * 営業日判定 (JST の日付)。定休 = 日曜 (+ SATURDAY_IS_BUSINESS_DAY=false の間は土曜) + 祝日。
 * **祝日テーブルの有効期限を過ぎた日付は「営業日と断定できない」ので false を返す** —
 * 判定不能を営業日に倒すと、テーブル切れの翌日 (2028-01-01 = 元日) を約束してしまう。
 */
export function isBusinessDayJst(dateJst: string): boolean {
  const t = Date.parse(`${dateJst}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  if (dateJst > HOLIDAY_TABLE_VALID_THROUGH) return false; // 祝日を知らない期間
  const dow = new Date(t).getUTCDay();
  if (dow === 0) return false; // 日曜は定休
  if (dow === 6 && !SATURDAY_IS_BUSINESS_DAY) return false;
  return !JP_HOLIDAYS_JST.has(dateJst);
}

/**
 * 受理時刻から promised_by を算出する (§4-1)。
 * = 受理日 (JST) の翌日以降で最初の営業日の 17:00 JST。
 *
 * **祝日テーブルの有効期限を越えて営業日が見つからない場合は null** (= 約束しない)。
 * 受理そのものは成立し、文言は「スタッフが順に対応し、完了しましたら必ずご連絡いたします」に
 * 落ちる (buildAcceptanceMessage の promisedBy=null 分岐)。誤った日を約束して §4-2 の
 * 謝罪 push を量産するより、約束しない方が誠実。
 * ⚠️ この状態は **JP_HOLIDAYS_JST の更新漏れ**を意味する。年 1 回の更新を怠らないこと。
 */
export function computePromisedBy(acceptedAtMs: number): string | null {
  const jst = new Date(acceptedAtMs + JST_OFFSET_MS);
  let t = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  // 探索上限: テーブル有効期限を越えたら打ち切る (無限ループ防止 + 判定不能を約束しない)
  for (let i = 0; i < MAX_PROMISE_SEARCH_DAYS; i += 1) {
    t += DAY_MS;
    const d = new Date(t).toISOString().slice(0, 10);
    if (d > HOLIDAY_TABLE_VALID_THROUGH) return null;
    if (isBusinessDayJst(d)) {
      const hh = String(BUSINESS_PROMISE_HOUR_JST).padStart(2, '0');
      return `${d}T${hh}:00:00.000+09:00`;
    }
  }
  return null;
}
