/** JST offset: UTC+9 in milliseconds */
const JST_OFFSET_MS = 9 * 60 * 60_000;

/**
 * Returns current time as JST ISO 8601 string with +09:00 offset.
 * Format: YYYY-MM-DDTHH:mm:ss.sss+09:00
 *
 * All timestamps in this project are standardized to JST.
 * The +09:00 suffix ensures new Date() parses correctly for epoch comparisons.
 */
export function jstNow(): string {
  return toJstString(new Date());
}

/**
 * Convert a Date object to JST ISO 8601 string with +09:00 offset.
 * Format: YYYY-MM-DDTHH:mm:ss.sss+09:00
 */
export function toJstString(date: Date): string {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  return jst.toISOString().slice(0, -1) + '+09:00';
}

/**
 * Returns the JST ISO 8601 string (same format as jstNow) for `months` months
 * before `asOf` (default: now). Used for trailing-window aggregations such as
 * the trailing-12-month loyalty rank. The result is lexically comparable with
 * stored `created_at` values (same fixed-width `+09:00` format), so it can be
 * used directly in `created_at >= ?` SQL bounds.
 */
export function isoMonthsAgo(months: number, asOf?: string): string {
  const base = asOf ? new Date(asOf) : new Date();
  // Shift to JST wall clock, subtract whole months on that wall clock, then
  // re-stamp the +09:00 suffix — mirrors toJstString so comparisons line up.
  const jst = new Date(base.getTime() + JST_OFFSET_MS);
  jst.setUTCMonth(jst.getUTCMonth() - months);
  return jst.toISOString().slice(0, -1) + '+09:00';
}

/**
 * Compare two timestamp strings (any format) as epoch milliseconds.
 * Handles both Z and +09:00 formats correctly.
 */
export function isTimeBefore(a: string, b: string): boolean {
  return new Date(a).getTime() <= new Date(b).getTime();
}
