/**
 * 第1波-① welcomeクーポン期限カウントダウン (LIFF表示) のテスト。
 * - getActiveWelcomeCoupon: line_friend_coupons の active 1件を structured 取得 (fail-safe)。
 * - formatCouponCountdown: 残り時間の顧客向け文言 (純関数)。
 * - 統合静的ガード: endpoint + LIFF card 配線。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getActiveWelcomeCoupon, formatCouponCountdown } from '../services/welcome-coupon.js';

interface Row {
  coupon_code: string;
  discount_value: number;
  discount_currency: string | null;
  expires_at: string | null;
  issued_at: string;
}

function makeFakeDb(row: Row | null) {
  const captured = { sql: '', binds: [] as unknown[] };
  const prepare = (sql: string) => ({
    bind: (...b: unknown[]) => ({
      async first<T>() {
        captured.sql = sql;
        captured.binds = b;
        return row as unknown as T;
      },
    }),
  });
  return { db: { prepare } as unknown as D1Database, captured: () => captured };
}

const throwingDb = {
  prepare() {
    throw new Error('no such table: line_friend_coupons');
  },
} as unknown as D1Database;

describe('getActiveWelcomeCoupon', () => {
  const row: Row = {
    coupon_code: 'NLW-ABCD1234',
    discount_value: 500,
    discount_currency: 'JPY',
    expires_at: '2026-07-03T01:00:00.000Z',
    issued_at: '2026-06-30T01:00:00.000Z',
  };

  it('active 行を structured WelcomeCoupon に map する', async () => {
    const { db, captured } = makeFakeDb(row);
    const c = await getActiveWelcomeCoupon(db, 'friend-1');
    expect(c).toEqual({
      code: 'NLW-ABCD1234',
      discountValue: 500,
      discountCurrency: 'JPY',
      expiresAt: '2026-07-03T01:00:00.000Z',
      issuedAt: '2026-06-30T01:00:00.000Z',
    });
    // active 定義 (issued + 未失効) と UTC ISO の now bind を検証
    expect(captured().sql).toContain("status = 'issued'");
    expect(captured().sql).toMatch(/expires_at IS NULL OR expires_at >= \?/);
    expect(captured().binds[0]).toBe('friend-1');
    expect(String(captured().binds[1])).toMatch(/Z$/);
  });

  it('行が無ければ null', async () => {
    const { db } = makeFakeDb(null);
    expect(await getActiveWelcomeCoupon(db, 'friend-x')).toBeNull();
  });

  it('読込エラーでも throw せず null (fail-safe)', async () => {
    expect(await getActiveWelcomeCoupon(throwingDb, 'friend-1')).toBeNull();
  });

  it('discount_currency が NULL なら JPY 既定', async () => {
    const { db } = makeFakeDb({ ...row, discount_currency: null });
    const c = await getActiveWelcomeCoupon(db, 'friend-1');
    expect(c?.discountCurrency).toBe('JPY');
  });
});

describe('formatCouponCountdown', () => {
  const now = Date.UTC(2026, 6, 1, 0, 0, 0);
  it('1日以上 → 「あと◯日」', () => {
    expect(formatCouponCountdown(new Date(Date.UTC(2026, 6, 3, 0, 0, 0)).toISOString(), now)).toBe('あと2日');
  });
  it('端数は切り捨て (2日21時間 → あと2日)', () => {
    expect(formatCouponCountdown(new Date(Date.UTC(2026, 6, 3, 21, 0, 0)).toISOString(), now)).toBe('あと2日');
  });
  it('1日未満 → 「あと◯時間」', () => {
    expect(formatCouponCountdown(new Date(Date.UTC(2026, 6, 1, 5, 0, 0)).toISOString(), now)).toBe('あと5時間');
  });
  it('1時間未満 → 「まもなく終了」', () => {
    expect(formatCouponCountdown(new Date(Date.UTC(2026, 6, 1, 0, 30, 0)).toISOString(), now)).toBe('まもなく終了');
  });
  it('失効済 → null', () => {
    expect(formatCouponCountdown(new Date(Date.UTC(2026, 5, 30, 0, 0, 0)).toISOString(), now)).toBeNull();
  });
  it('期限なし / 不正値 → null', () => {
    expect(formatCouponCountdown(null, now)).toBeNull();
    expect(formatCouponCountdown('not-a-date', now)).toBeNull();
  });
});

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string): string => readFileSync(join(root, '..', rel), 'utf8');

describe('welcome-coupon 統合 (endpoint + LIFF card 配線)', () => {
  const portal = readSrc('routes/liff-portal.ts');
  // 実装本体は PR-2 (#e17f4d2) で services/portal-read.ts へ抽出 — ガードの読み先も実体へ
  // (handler の doc コメントで満たせる形にしない。Ultraplan PR-6 follow-up)
  const portalRead = readSrc('services/portal-read.ts');
  const pages = readSrc('routes/liff-pages.ts');

  it('endpoint /api/liff/welcome-coupon が idToken 保護 + 実装が getActiveWelcomeCoupon を使う', () => {
    expect(portal).toContain("'/api/liff/welcome-coupon'");
    expect(portalRead).toContain('getActiveWelcomeCoupon');
    expect(portal).toMatch(/getLiffUser\(c\)[\s\S]{0,120}Unauthorized/);
  });

  it('LIFF home が welcome-coupon-card + loadWelcomeCoupon を持ち Promise.all に含む', () => {
    expect(pages).toContain('id="welcome-coupon-card"');
    expect(pages).toContain('function loadWelcomeCoupon');
    expect(pages).toMatch(/Promise\.all\(\[[^\]]*loadWelcomeCoupon\(\)/);
    expect(pages).toContain('で終了'); // カウントダウン文言
  });

  it('カード値は esc() でエスケープ (XSS防止)', () => {
    expect(pages).toMatch(/esc\(cp\.code\)/);
    expect(pages).toMatch(/esc\(cp\.applyUrl\)/);
  });
});
