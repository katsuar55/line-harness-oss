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

import { MIN_SUBTOTAL_JPY } from './shopify-coupon-issuer.js';

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

export interface ActiveCoupon {
  readonly couponCode: string;
  readonly discountValue: number;
  readonly discountCurrency: string;
  readonly expiresAt: string | null;
  /** 顧客に見せる種別名 (例: 「アカウント連携特典」) */
  readonly label: string;
}

/**
 * 顧客が「自分のクーポン」と認識する 3 台帳 (2026-08-28)。
 *
 * 🚨 なぜ 3 つ要るか: ここは長らく line_friend_coupons (友だち追加特典) しか見ておらず、
 * ¥300 連携特典 / ¥500 紹介特典を**持っている顧客に対して公式アカウントが
 * 「現在お持ちのクーポンはございません」と断定**していた。友だち追加特典は 7 日で切れるので、
 * 既存顧客 (= 連携を試す層) ではほぼ確実にこの嘘を踏む。
 *
 * 3 台帳とも列は同形 (coupon_code / discount_value / discount_currency / expires_at /
 * status / issued_at / friend_id)、最低購入は 3 つとも ¥2,000。
 *
 * ⚠️ table 名は**この定数配列だけ**が供給源 (リクエスト由来の文字列は絶対に入れない)。
 * ⚠️ 台帳ごとに独立の try/catch にする — 1 テーブルが未 migration でも他は返す
 *    (UNION にすると 1 つ欠けた瞬間に全部が空になり、既存の友だち追加特典まで見えなくなる)。
 */
const COUPON_LEDGERS: ReadonlyArray<{ readonly table: string; readonly label: string }> = [
  { table: 'line_friend_coupons', label: '友だち追加特典' },
  { table: 'line_link_coupons', label: 'アカウント連携特典' },
  { table: 'line_referral_coupons', label: 'ご紹介特典' },
];

/** 1 台帳から有効な 1 枚を引く。失敗しても他の台帳を巻き込まない (fail-safe)。 */
async function queryCouponLedger(
  db: D1Database,
  table: string,
  label: string,
  friendId: string,
  nowIso: string,
): Promise<ActiveCoupon | null> {
  try {
    const row = await db
      .prepare(
        `SELECT coupon_code, discount_value, discount_currency, expires_at
         FROM ${table}
         WHERE friend_id = ? AND status = 'issued'
           AND (expires_at IS NULL OR expires_at >= ?)
         ORDER BY issued_at DESC LIMIT 1`,
      )
      .bind(friendId, nowIso)
      .first<CouponRow>();
    if (!row) return null;
    return {
      couponCode: row.coupon_code,
      discountValue: row.discount_value,
      discountCurrency: row.discount_currency,
      expiresAt: row.expires_at,
      label,
    };
  } catch (err) {
    console.error(
      `[ai-fact-context] coupon ledger ${table} failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * friend が保有する有効なクーポンを全台帳から集めて返す (発行が新しい順ではなく台帳順)。
 * 1 つも無ければ空配列。台帳単位で fail-safe。
 */
export async function listFriendActiveCoupons(
  db: D1Database,
  friendId: string,
): Promise<ActiveCoupon[]> {
  const nowIso = jstIsoFromDate(new Date());
  const found: ActiveCoupon[] = [];
  for (const ledger of COUPON_LEDGERS) {
    const c = await queryCouponLedger(db, ledger.table, ledger.label, friendId, nowIso);
    if (c) found.push(c);
  }
  return found;
}

/**
 * friend の active coupon を 1 件返す (= row 形式、 intent-router 等で再利用)。
 * 「active」 = status='issued' AND (expires_at IS NULL OR expires_at >= now)。
 * 失敗時 / 無い時は null (fail-safe)。
 */
export async function getFriendActiveCoupon(
  db: D1Database,
  friendId: string,
): Promise<ActiveCoupon | null> {
  const all = await listFriendActiveCoupons(db, friendId);
  return all[0] ?? null;
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
    // 🚨 3 台帳すべてを見る (2026-08-28)。友だち追加特典だけを見ていたため、¥300 連携特典 /
    //    ¥500 紹介特典を持つ顧客に「現在お持ちのクーポンはございません」と断定していた。
    const coupons = await listFriendActiveCoupons(db, friendId);
    if (coupons.length === 0) return '';

    const lines = coupons.map((c, i) => {
      const expiry = c.expiresAt ? formatJstDate(c.expiresAt) + ' まで有効' : '無期限';
      const currency = c.discountCurrency === 'JPY' ? '¥' : c.discountCurrency + ' ';
      return `${i + 1}. ${c.label} — コード: ${c.couponCode} / 値引: ${currency}${c.discountValue} OFF / 有効期限: ${expiry}`;
    });
    // 🚨 利用条件は**この fact block に載せる**こと (2026-08-24)。system prompt 側のルール文だけだと
    //   LLM はデータ側を優先して転記し、最低購入が落ちた回答になる。値は発行側の定数が唯一の正。
    // 🚨 「併用できます」は**まだ書かない** — 流通中の旧コードへの遡及 op が未実施のため
    //   (docs/SPRINT_C_MAGIC_LINK_MAIL.md §6 / CLAUDE.md の順序厳守)。
    return (
      `\n## あなた専用クーポン (有効)\n(お持ちのクーポン ${coupons.length} 枚)\n` +
      lines.join('\n') +
      `\n- ご利用条件: ${coupons.length > 1 ? 'いずれも ' : ''}¥${formatThousands(MIN_SUBTOTAL_JPY)} 以上のご注文` +
      `\n- 利用先: 公式ストア naturism-diet.com`
    );
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

/** 千区切り。Workers ランタイムの Intl に依存させないため toLocaleString は使わない。 */
function formatThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Date → JST '+09:00' suffix の ISO 8601 string (= D1 TEXT timestamps と整合) */
function jstIsoFromDate(date: Date): string {
  const jstMs = date.getTime() + 9 * 60 * 60 * 1000;
  return new Date(jstMs).toISOString().slice(0, -1) + '+09:00';
}

/** ISO 8601 timestamp → '6月15日' 等の表示用 string (= 年は省略、 月日のみ) */
export function formatJstDate(iso: string | null): string {
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
