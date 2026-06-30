/**
 * 第1波-④ ポータル内蔵AIチャット (LIFF Q&A) のコスト/DoSガード。
 *
 * LIFF から実 Workers AI (generateAiResponse) を呼べるようにするため、 1人が連打して
 * AI 費用を膨らませないよう 2段ガードを敷く:
 *   - burst: middleware/rate-limit.ts の check() (in-memory sliding window、 既存LINE側と同方式)
 *     → これは呼び出し側 (route) で適用する。
 *   - daily cap: conversation_logs を friend×JST当日で数え、 上限超で AI を呼ばず定型応答。
 *     generateAiResponse は内部で conversation_logs に INSERT するため、 LINE側AIと合算で
 *     当日の AI 利用回数を friend 単位に上限化できる (= webhook.ts の daily-cap と同思想)。
 *
 * 本ファイルは純粋なガード判定 (read-only count + 純関数) のみ。 AI 応答自体は呼ばない。
 */

/** 連打ガード: 1 friend あたり AI_BURST_WINDOW_MS 内に許す最大質問数。 */
export const AI_BURST_MAX = 5;
export const AI_BURST_WINDOW_MS = 60_000;
/** 日次上限: 1 friend あたり JST 当日の AI 利用上限 (LINE側AIと合算)。 */
export const AI_DAILY_CAP = 20;
/** 質問文の最大長 (endpoint validation と UI maxlength を一致させる)。 */
export const AI_QUESTION_MAX = 500;

/** nowMs → JST 当日の 'YYYY-MM-DD' (conversation_logs.created_at の JST wall-clock prefix と一致)。 */
export function jstDateString(nowMs: number): string {
  return new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * friend の JST 当日の AI 利用回数 (conversation_logs 行数)。 daily cap 判定に使う。
 * created_at は migration 053 の DEFAULT で JST wall-clock ISO ('YYYY-MM-DDT...') なので
 * LIKE 'YYYY-MM-DD%' で当日を数えられる。
 */
export async function countTodayAiAsks(
  db: D1Database,
  friendId: string,
  jstDate: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM conversation_logs
        WHERE friend_id = ? AND created_at LIKE ?`,
    )
    .bind(friendId, `${jstDate}%`)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}
