/**
 * 営業カレンダー (§4-1 promised_by の算出、 §10-4、 2026-08-07)
 *
 * ⚠️ 営業カレンダーの実仕様は未定義 (設計書 §11 の未解決事項)。本ファイルは
 * **Katsu 確認までの仮置きデフォルト**で、差し替えはこのファイルの中だけで完結する:
 *   - 営業日 = 平日 (月〜金)。祝日は当面無視 (祝日対応はこのファイルに関数を足すだけ)
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

/** 営業日判定 (JST の日付)。仮置き = 平日のみ・祝日無視。 */
export function isBusinessDayJst(dateJst: string): boolean {
  const t = Date.parse(`${dateJst}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const dow = new Date(t).getUTCDay();
  return dow >= 1 && dow <= 5;
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
