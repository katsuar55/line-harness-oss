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
  __test__,
} from '../services/ai-fact-context.js';

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
    stmt.first.mockResolvedValue({
      coupon_code: 'LINE-ABC12345',
      discount_value: 500,
      discount_currency: 'JPY',
      expires_at: '2026-05-27T23:59:59+09:00',
    });
    const db = createMockDb(stmt);
    const text = await getFriendCouponContext(db, 'friend-1');
    expect(text).toContain('## あなた専用クーポン');
    expect(text).toContain('LINE-ABC12345');
    expect(text).toContain('¥500 OFF');
    expect(text).toContain('5月27日 まで有効');
    expect(text).toContain('naturism-diet.com');
  });

  it('returns empty string when no active coupon', async () => {
    stmt.first.mockResolvedValue(null);
    const db = createMockDb(stmt);
    const text = await getFriendCouponContext(db, 'friend-no-coupon');
    expect(text).toBe('');
  });

  it('handles coupon without expiry (= 無期限)', async () => {
    stmt.first.mockResolvedValue({
      coupon_code: 'LINE-XYZ',
      discount_value: 1000,
      discount_currency: 'JPY',
      expires_at: null,
    });
    const db = createMockDb(stmt);
    const text = await getFriendCouponContext(db, 'friend-1');
    expect(text).toContain('LINE-XYZ');
    expect(text).toContain('無期限');
  });

  it('handles non-JPY currency', async () => {
    stmt.first.mockResolvedValue({
      coupon_code: 'LINE-USD',
      discount_value: 10,
      discount_currency: 'USD',
      expires_at: null,
    });
    const db = createMockDb(stmt);
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
