/**
 * AI fact context builder (Plan A-2、 2026-05-24)
 *
 * 役割:
 *   AI 応答 (= generateAiResponse) に渡す **事実だけ** の context section を D1 から build する。
 *   ハルシネーション防止: AI は「context に書いてあるもの」 だけ口にでき、
 *   無い場合は system prompt の rule 1 で「現時点で開催中のキャンペーンはございません」 と固定応答。
 *
 * 出力 contract:
 *   - 各 builder は **markdown section text or 空文字** を返す
 *   - 空文字なら caller は append しない (= prompt 余分な空セクション避ける)
 *   - section header は「## 進行中のお知らせ」「## あなた専用クーポン」 等、 system prompt と整合
 *
 * 設計原則:
 *   - **fail-safe**: D1 query が throw しても空文字を返す (= AI 応答自体は壊さない)
 *   - **best-effort**: limit 3 件、 過去 7 日 / 今後配信予定の sliding window
 *   - **multi-tenant 対応**: lineAccountId filter optional
 *   - **timestamp**: D1 の TEXT timestamps は ISO 8601 + JST '+09:00' suffix で比較可
 */

const ACTIVE_BROADCAST_WINDOW_DAYS = 7; // 過去 N 日間に配信済 broadcast を「進行中」 として扱う
const BROADCAST_LIMIT = 3; // prompt 肥大化防止

interface BroadcastRow {
  title: string;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
}

interface CouponRow {
  coupon_code: string;
  discount_value: number;
  discount_currency: string;
  expires_at: string | null;
}

/**
 * 現在 active な broadcasts を「## 進行中のお知らせ」 セクション形式で返す。
 * D1 query 失敗時は空文字 (= caller が無視できる)。
 *
 * 「active」 定義:
 *   - status='scheduled' AND scheduled_at >= now (= 今後配信予定)
 *   - OR status='sent' AND sent_at >= now - 7 days (= 過去 7 日間に配信済)
 *
 * channel='line' のみ対象 (= email broadcast は AI 応答 context 対象外)。
 */
export async function getActiveBroadcastsContext(
  db: D1Database,
  lineAccountId: string | null,
): Promise<string> {
  try {
    const now = new Date();
    const nowIso = jstIsoFromDate(now);
    const cutoff = new Date(now.getTime() - ACTIVE_BROADCAST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const cutoffIso = jstIsoFromDate(cutoff);

    // lineAccountId 指定なら filter、 なしなら全 (= multi-tenant 対応)
    const sql = lineAccountId
      ? `SELECT title, status, scheduled_at, sent_at FROM broadcasts
         WHERE channel = 'line' AND line_account_id = ?
           AND (
             (status = 'scheduled' AND scheduled_at >= ?)
             OR (status = 'sent' AND sent_at >= ?)
           )
         ORDER BY COALESCE(sent_at, scheduled_at) DESC LIMIT ?`
      : `SELECT title, status, scheduled_at, sent_at FROM broadcasts
         WHERE channel = 'line'
           AND (
             (status = 'scheduled' AND scheduled_at >= ?)
             OR (status = 'sent' AND sent_at >= ?)
           )
         ORDER BY COALESCE(sent_at, scheduled_at) DESC LIMIT ?`;

    const stmt = lineAccountId
      ? db.prepare(sql).bind(lineAccountId, nowIso, cutoffIso, BROADCAST_LIMIT)
      : db.prepare(sql).bind(nowIso, cutoffIso, BROADCAST_LIMIT);

    const { results } = await stmt.all<BroadcastRow>();
    if (!results || results.length === 0) return '';

    const lines = results.map((row) => {
      const when =
        row.status === 'scheduled'
          ? `${formatJstDate(row.scheduled_at)} 配信予定`
          : `${formatJstDate(row.sent_at)} 配信`;
      return `- 「${row.title}」 (${when})`;
    });

    return `\n## 進行中のお知らせ (本日時点、 過去 ${ACTIVE_BROADCAST_WINDOW_DAYS} 日 + 配信予定)\n${lines.join('\n')}`;
  } catch (err) {
    console.error(
      '[ai-fact-context] getActiveBroadcastsContext failed:',
      err instanceof Error ? err.message : String(err),
    );
    return '';
  }
}

/**
 * friend が保有する active coupon を「## あなた専用クーポン」 セクション形式で返す。
 * D1 query 失敗時 or 無い時は空文字。
 *
 * 「active」 定義:
 *   - status = 'issued' (= 未使用、 未失効、 未取消)
 *   - AND (expires_at IS NULL OR expires_at >= now)
 *
 * 1 friend = 1 coupon (table UNIQUE 制約) なので LIMIT 1。
 */
export async function getFriendCouponContext(
  db: D1Database,
  friendId: string,
): Promise<string> {
  try {
    const nowIso = jstIsoFromDate(new Date());
    const row = await db
      .prepare(
        `SELECT coupon_code, discount_value, discount_currency, expires_at
         FROM line_friend_coupons
         WHERE friend_id = ? AND status = 'issued'
           AND (expires_at IS NULL OR expires_at >= ?)
         ORDER BY issued_at DESC LIMIT 1`,
      )
      .bind(friendId, nowIso)
      .first<CouponRow>();
    if (!row) return '';

    const expiry = row.expires_at ? formatJstDate(row.expires_at) + ' まで有効' : '無期限';
    const currency = row.discount_currency === 'JPY' ? '¥' : row.discount_currency + ' ';
    return `\n## あなた専用クーポン (有効)\n- コード: ${row.coupon_code}\n- 値引: ${currency}${row.discount_value} OFF\n- 有効期限: ${expiry}\n- 利用先: 公式ストア naturism-diet.com`;
  } catch (err) {
    console.error(
      '[ai-fact-context] getFriendCouponContext failed:',
      err instanceof Error ? err.message : String(err),
    );
    return '';
  }
}

// ============================================================
// helpers
// ============================================================

/** Date → JST '+09:00' suffix の ISO 8601 string (= D1 TEXT timestamps と整合) */
function jstIsoFromDate(date: Date): string {
  const jstMs = date.getTime() + 9 * 60 * 60 * 1000;
  return new Date(jstMs).toISOString().slice(0, -1) + '+09:00';
}

/** ISO 8601 timestamp → '6月15日' 等の表示用 string (= 年は省略、 月日のみ) */
function formatJstDate(iso: string | null): string {
  if (!iso) return '日時未定';
  const match = /(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  return `${month}月${day}日`;
}

// テスト用 export
export const __test__ = {
  jstIsoFromDate,
  formatJstDate,
  ACTIVE_BROADCAST_WINDOW_DAYS,
  BROADCAST_LIMIT,
};
