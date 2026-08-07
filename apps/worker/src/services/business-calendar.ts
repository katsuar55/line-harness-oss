/**
 * 営業カレンダー (§4-1 promised_by の算出、 §10-4、 2026-08-07)
 *
 * ⚠️ 営業カレンダーの実仕様は未定義 (設計書 §11 の未解決事項)。本ファイルは
 * **Katsu 確認までの仮置きデフォルト**で、差し替えはこのファイルの中だけで完結する:
 *   - 営業日 = 平日 (月〜金) かつ祝日テーブルに無い日
 *   - 営業時間 = 10:00-18:00 JST (現状 promised_by の算出には未使用 — 約束は常に
 *     「翌営業日の 18:00」なので受理時刻の営業時間内外で結果が変わらない。
 *     将来「営業時間内の受理は当日 18:00」等に変える場合はここを書き換える)
 *   - 約束 = **翌営業日 18:00 JST** (受理当日を含めない保守的 under-promise。
 *     金曜/土曜/日曜の受理はいずれも月曜 18:00)
 *
 * 出力形式は deadline_at (`YYYY-MM-DDTHH:mm:ss.sss+09:00`) と同じ固定幅 —
 * `promised_by > deadline_at` (§4-1 の開示判定) と sweep の `promised_by < now`
 * (toJstString と同形式) を文字列比較で成立させる。
 */

const JST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;

/** 約束時刻 (JST の時)。「翌営業日 18:00」の 18。 */
export const BUSINESS_PROMISE_HOUR_JST = 18;

/**
 * 日本の祝日 + 年末年始休業 (仮置き・固定リスト・**年 1 回の手更新が必要**)。
 * 2026 後半〜2027 分。監査 CONFIRMED の反映: 祝日を無視すると祝日 18:00 を約束し、
 * 連休のたびに §4-2 の約束破り謝罪 push が構造的に量産される。
 * 誤登録の非対称性: 余分に休みにする誤り → 約束が 1 日遅くなるだけ (under-promise = 安全)。
 * 祝日の登録漏れ → 現状維持 (約束破り)。よって疑わしきは休み側に倒してよい。
 * リスト末尾 (2027-12) を過ぎて未更新のまま運用しても平日ベースに劣化するだけで壊れない。
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

/** 営業日判定 (JST の日付)。仮置き = 平日かつ祝日テーブル外。 */
export function isBusinessDayJst(dateJst: string): boolean {
  const t = Date.parse(`${dateJst}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const dow = new Date(t).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !JP_HOLIDAYS_JST.has(dateJst);
}

/**
 * 受理時刻から promised_by を算出する (§4-1)。
 * = 受理日 (JST) の翌日以降で最初の営業日の 18:00 JST。
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
