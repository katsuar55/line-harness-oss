/**
 * Tests for ai-fact-context.ts (Plan A-2、 2026-05-24)
 *
 * カバー範囲:
 *   - getActiveBroadcastsContext: active broadcasts -> section / 空 -> 空文字 / error -> 空文字 / lineAccountId filter
 *   - getFriendCouponContext: active coupon -> section / 期限切 -> 空 / error -> 空
 *   - helpers: jstIsoFromDate, formatJstDate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getActiveBroadcastsContext,
  getFriendCouponContext,
  getFriendActiveCoupon,
  listFriendActiveCoupons,
  __test__,
} from '../services/ai-fact-context.js';

interface LedgerRow {
  coupon_code: string;
  discount_value: number;
  discount_currency: string;
  expires_at: string | null;
}

/**
 * 台帳ごとに別の行を返す mock (2026-08-28)。
 * 🚨 全 prepare が同じ stmt を返す mock だと、3 台帳が**同じ 1 枚を 3 回**返してしまい、
 *    「3 台帳を見ている」ことも「台帳ごとに fail-safe」なことも検証できない。
 */
function createLedgerDb(
  rows: Partial<Record<'friend' | 'link' | 'referral', LedgerRow | Error | null>>,
): D1Database {
  const pick = (sql: string) => {
    if (sql.includes('line_friend_coupons')) return rows.friend ?? null;
    if (sql.includes('line_link_coupons')) return rows.link ?? null;
    if (sql.includes('line_referral_coupons')) return rows.referral ?? null;
    return null;
  };
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          const r = pick(sql);
          if (r instanceof Error) throw r;
          return r;
        },
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as D1Database;
}

interface MockStmt {
  bind: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
}

function createMockDb(stmt: MockStmt): D1Database {
  return {
    prepare: vi.fn().mockReturnValue(stmt),
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

describe('ai-fact-context — getActiveBroadcastsContext', () => {
  let stmt: MockStmt;

  beforeEach(() => {
    stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn(),
      first: vi.fn(),
    };
  });

  it('returns formatted section when broadcasts are found', async () => {
    stmt.all.mockResolvedValue({
      results: [
        { title: '6 月梅雨対策', status: 'sent', scheduled_at: null, sent_at: '2026-06-01T09:00:00+09:00' },
        { title: '7 月夏キャンペーン', status: 'scheduled', scheduled_at: '2026-07-01T09:00:00+09:00', sent_at: null },
      ],
    });
    const db = createMockDb(stmt);
    const text = await getActiveBroadcastsContext(db, null);
    expect(text).toContain('## 進行中のお知らせ');
    expect(text).toContain('6 月梅雨対策');
    expect(text).toContain('6月1日 配信');
    expect(text).toContain('7 月夏キャンペーン');
    expect(text).toContain('7月1日 配信予定');
  });

  it('returns empty string when no broadcasts found', async () => {
    stmt.all.mockResolvedValue({ results: [] });
    const db = createMockDb(stmt);
    const text = await getActiveBroadcastsContext(db, null);
    expect(text).toBe('');
  });

  it('returns empty string when results is null (= D1 edge case)', async () => {
    stmt.all.mockResolvedValue({ results: null });
    const db = createMockDb(stmt);
    const text = await getActiveBroadcastsContext(db, null);
    expect(text).toBe('');
  });

  it('returns empty string on D1 error (= fail-safe)', async () => {
    stmt.all.mockRejectedValue(new Error('D1 connection failed'));
    const db = createMockDb(stmt);
    const text = await getActiveBroadcastsContext(db, null);
    expect(text).toBe('');
  });

  it('applies lineAccountId filter when specified', async () => {
    stmt.all.mockResolvedValue({ results: [] });
    const db = createMockDb(stmt);
    await getActiveBroadcastsContext(db, 'line-account-naturism');
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain('line_account_id');
    // 引数 4 個: lineAccountId, nowIso, cutoffIso, limit
    expect(stmt.bind).toHaveBeenCalledWith('line-account-naturism', expect.any(String), expect.any(String), 3);
  });

  it('omits lineAccountId filter when null', async () => {
    stmt.all.mockResolvedValue({ results: [] });
    const db = createMockDb(stmt);
    await getActiveBroadcastsContext(db, null);
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).not.toContain('line_account_id');
    // 引数 3 個: nowIso, cutoffIso, limit
    expect(stmt.bind).toHaveBeenCalledWith(expect.any(String), expect.any(String), 3);
  });
});

describe('ai-fact-context — getFriendCouponContext', () => {
  let stmt: MockStmt;

  beforeEach(() => {
    stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn(),
      first: vi.fn(),
    };
  });

  it('returns formatted section with coupon info when active coupon exists', async () => {
    const db = createLedgerDb({
      friend: {
        coupon_code: 'LINE-ABC12345',
        discount_value: 500,
        discount_currency: 'JPY',
        expires_at: '2026-05-27T23:59:59+09:00',
      },
    });
    const text = await getFriendCouponContext(db, 'friend-1');
    expect(text).toContain('## あなた専用クーポン');
    expect(text).toContain('LINE-ABC12345');
    expect(text).toContain('¥500 OFF');
    expect(text).toContain('5月27日 まで有効');
    expect(text).toContain('naturism-diet.com');
    // 最低購入は fact block 側に載せる (system prompt のルール文だけだと落ちる)
    expect(text).toContain('¥2,000 以上のご注文');
  });

  it('returns empty string when no active coupon', async () => {
    const db = createLedgerDb({});
    const text = await getFriendCouponContext(db, 'friend-no-coupon');
    expect(text).toBe('');
  });

  it('handles coupon without expiry (= 無期限)', async () => {
    const db = createLedgerDb({
      friend: { coupon_code: 'LINE-XYZ', discount_value: 1000, discount_currency: 'JPY', expires_at: null },
    });
    const text = await getFriendCouponContext(db, 'friend-1');
    expect(text).toContain('LINE-XYZ');
    expect(text).toContain('無期限');
  });

  it('handles non-JPY currency', async () => {
    const db = createLedgerDb({
      friend: { coupon_code: 'LINE-USD', discount_value: 10, discount_currency: 'USD', expires_at: null },
    });
    const text = await getFriendCouponContext(db, 'friend-1');
    expect(text).toContain('USD 10 OFF');
  });

  it('returns empty string on D1 error (= fail-safe)', async () => {
    stmt.first.mockRejectedValue(new Error('D1 broken'));
    const db = createMockDb(stmt);
    const text = await getFriendCouponContext(db, 'friend-1');
    expect(text).toBe('');
  });
});

describe('ai-fact-context — helpers', () => {
  it('jstIsoFromDate returns +09:00 suffix ISO string', () => {
    const date = new Date('2026-05-24T07:00:00Z'); // 16:00 JST
    const iso = __test__.jstIsoFromDate(date);
    expect(iso).toMatch(/\+09:00$/);
    expect(iso).toContain('2026-05-24');
    expect(iso).toContain('16:00');
  });

  it('formatJstDate extracts month + day from ISO', () => {
    expect(__test__.formatJstDate('2026-06-15T09:00:00+09:00')).toBe('6月15日');
    expect(__test__.formatJstDate('2026-12-01T00:00:00+09:00')).toBe('12月1日');
  });

  it('formatJstDate handles null/invalid', () => {
    expect(__test__.formatJstDate(null)).toBe('日時未定');
    expect(__test__.formatJstDate('not-a-date')).toBe('not-a-date');
  });

  it('constants are sane (= broadcasts window 1 week + limit 3)', () => {
    expect(__test__.ACTIVE_BROADCAST_WINDOW_DAYS).toBe(7);
    expect(__test__.BROADCAST_LIMIT).toBe(3);
  });
});

// ============================================================
// 🚨 3 台帳を見る (2026-08-28)
// ============================================================
// 長らく line_friend_coupons だけを見ており、¥300 連携特典 / ¥500 紹介特典を**持っている顧客に
// 対して公式アカウントが「現在お持ちのクーポンはございません」と断定**していた。
// 友だち追加特典は 7 日で切れるので、既存顧客 (= 連携を試す層) ではほぼ確実に踏む。
describe('ai-fact-context — 3 台帳のクーポン', () => {
  const LINK = {
    coupon_code: 'NLINK-ABCD1234',
    discount_value: 300,
    discount_currency: 'JPY',
    expires_at: '2026-09-27T23:59:59+09:00',
  };
  const REF = {
    coupon_code: 'NREF-EFGH5678',
    discount_value: 500,
    discount_currency: 'JPY',
    expires_at: null,
  };
  const WELCOME = {
    coupon_code: 'LINE-IJKL9012',
    discount_value: 500,
    discount_currency: 'JPY',
    expires_at: '2026-09-04T23:59:59+09:00',
  };

  it('🚨 連携特典しか持っていなくても「ございません」にならない', async () => {
    const text = await getFriendCouponContext(createLedgerDb({ link: LINK }), 'f1');
    expect(text).not.toBe('');
    expect(text).toContain('NLINK-ABCD1234');
    expect(text).toContain('アカウント連携特典');
    expect(text).toContain('¥300 OFF');
  });

  it('紹介特典しか持っていなくても出る', async () => {
    const text = await getFriendCouponContext(createLedgerDb({ referral: REF }), 'f1');
    expect(text).toContain('NREF-EFGH5678');
    expect(text).toContain('ご紹介特典');
  });

  it('🚨 合成: 3 枚持っていたら 3 枚とも種別つきで載り、枚数も一致する', async () => {
    const text = await getFriendCouponContext(
      createLedgerDb({ friend: WELCOME, link: LINK, referral: REF }),
      'f1',
    );
    expect(text).toContain('(お持ちのクーポン 3 枚)');
    expect(text).toContain('1. 友だち追加特典 — コード: LINE-IJKL9012');
    expect(text).toContain('2. アカウント連携特典 — コード: NLINK-ABCD1234');
    expect(text).toContain('3. ご紹介特典 — コード: NREF-EFGH5678');
    expect(text).toContain('いずれも ¥2,000 以上のご注文');
    // 🚨 「併用できます」は遡及 op が済むまで**書かない** (CLAUDE.md の順序厳守)
    expect(text).not.toContain('併用');
  });

  it('🚨 1 台帳が落ちても他の台帳は返る (UNION にしない理由)', async () => {
    const text = await getFriendCouponContext(
      createLedgerDb({ friend: new Error('no such table'), link: LINK }),
      'f1',
    );
    expect(text).toContain('NLINK-ABCD1234');
    expect(text).toContain('(お持ちのクーポン 1 枚)');
  });

  it('全台帳が空なら空文字 (= AI は「ございません」と答えてよい)', async () => {
    expect(await getFriendCouponContext(createLedgerDb({}), 'f1')).toBe('');
  });

  it('listFriendActiveCoupons は台帳順に種別ラベルつきで返す', async () => {
    const list = await listFriendActiveCoupons(createLedgerDb({ link: LINK, referral: REF }), 'f1');
    expect(list.map((c) => c.label)).toEqual(['アカウント連携特典', 'ご紹介特典']);
    expect(list.map((c) => c.couponCode)).toEqual(['NLINK-ABCD1234', 'NREF-EFGH5678']);
  });

  it('getFriendActiveCoupon は連携特典しか無くても null を返さない', async () => {
    const c = await getFriendActiveCoupon(createLedgerDb({ link: LINK }), 'f1');
    expect(c?.couponCode).toBe('NLINK-ABCD1234');
  });
});
