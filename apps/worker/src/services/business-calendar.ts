/**
 * 営業カレンダー (§4-1 promised_by の算出、 §10-4、 2026-08-07 / **2026-08-08 Katsu 確定**)
 *
 * 確定仕様 (2026-08-08 Katsu):
 *   - **定休は日曜と祝日**。月〜土は営業日 (土曜も営業する)
 *   - **サポート時間は 10:00-17:00 JST**
 *   - 約束 (promised_by) = **翌営業日 17:00 JST**
 *
 * 「翌営業日」= 受理当日を含めない保守的な under-promise。受理時刻が営業時間内か外かで
 * 結果を変えていない (= 10:00 受理も 16:59 受理も同じ約束) — 実行はスタッフの手作業で、
 * 当日中の完了を約束できる保証がないため。実測が貯まって当日完了が常態化したら
 * 「営業時間内の受理は当日 17:00」へ短縮できる (変更はこのファイルの中だけで完結する)。
 *
 * 誤りの非対称性: 余分に休みにする誤り → 約束が 1 日遅くなるだけ (安全側)。
 * 祝日の登録漏れ → 誰も出社しない日を約束して §4-2 の謝罪 push が飛ぶ (危険側)。
 * よって**疑わしきは休み側に倒す**。
 *
 * 出力形式は deadline_at (`YYYY-MM-DDTHH:mm:ss.sss+09:00`) と同じ固定幅 —
 * `promised_by > deadline_at` (§4-1 の開示判定) と sweep の `promised_by < now`
 * (toJstString と同形式) を文字列比較で成立させる。
 */

const JST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;

/** サポート開始時刻 (JST の時)。現状 promised_by の算出には使わない (将来の当日約束用)。 */
export const BUSINESS_OPEN_HOUR_JST = 10;
/** サポート終了時刻 (JST の時) = 約束する時刻。「翌営業日 17:00」の 17。 */
export const BUSINESS_PROMISE_HOUR_JST = 17;

/**
 * 日本の祝日 + 年末年始休業 (固定リスト・**年 1 回の手更新が必要**)。2026 後半〜2027 分。
 * 祝日を無視すると誰も出社しない日を約束し、連休のたびに §4-2 の謝罪 push が量産される
 * (§10-4 監査 CONFIRMED)。リスト末尾 (2027-12) を過ぎて未更新でも「日曜のみ定休」に
 * 劣化するだけで壊れない (= 約束が早まる側 = 危険側なので、年 1 回の更新を怠らないこと)。
 */
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

/** 営業日判定 (JST の日付)。定休 = 日曜のみ + 祝日テーブル。土曜は営業日。 */
export function isBusinessDayJst(dateJst: string): boolean {
  const t = Date.parse(`${dateJst}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const dow = new Date(t).getUTCDay();
  if (dow === 0) return false; // 日曜が定休
  return !JP_HOLIDAYS_JST.has(dateJst);
}

/**
 * 受理時刻から promised_by を算出する (§4-1)。
 * = 受理日 (JST) の翌日以降で最初の営業日の 17:00 JST。
 */
export function computePromisedBy(acceptedAtMs: number): string {
  const jst = new Date(acceptedAtMs + JST_OFFSET_MS);
  let t = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  do {
    t += DAY_MS;
  } while (!isBusinessDayJst(new Date(t).toISOString().slice(0, 10)));
  const d = new Date(t).toISOString().slice(0, 10);
  const hh = String(BUSINESS_PROMISE_HOUR_JST).padStart(2, '0');
  return `${d}T${hh}:00:00.000+09:00`;
}
