/**
 * LINE 友だち限定クーポン (ランク不問の一律 % OFF、brand_config.metadata に格納・migration 不要)。
 * - service の config 正規化 / partial merge / clamp / 他 metadata キー保持 を fake D1 で検証。
 * - LIFF/admin の統合 (card, loader, endpoint, auth skip) を静的ガードで検証。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  getFriendCouponConfig,
  setFriendCouponConfig,
} from '../services/friend-coupon-config.js';

// ─── 最小 fake D1 (brand_config の SELECT metadata / UPDATE metadata のみ対応) ───
function makeDb(metadata: string | null) {
  let stored = metadata; // null = row 無し
  const prepare = (sql: string) => ({
    bind: (...binds: unknown[]) => ({
      async first<T>() {
        if (sql.includes('SELECT metadata FROM brand_config')) {
          return stored === null ? null : ({ metadata: stored } as unknown as T);
        }
        return null;
      },
      async run() {
        if (sql.includes('UPDATE brand_config SET metadata')) stored = binds[0] as string;
        return { success: true };
      },
    }),
  });
  return { db: { prepare } as unknown as D1Database, getStored: () => stored };
}

describe('friend-coupon-config service', () => {
  it('getFriendCouponConfig: row 無し → defaults (enabled=false, percent=5)', async () => {
    const { db } = makeDb(null);
    const cfg = await getFriendCouponConfig(db);
    expect(cfg.enabled).toBe(false);
    expect(cfg.percent).toBe(5);
    expect(cfg.code).toBe('');
  });

  it('getFriendCouponConfig: metadata.friendCoupon を正規化 (code は trim)', async () => {
    const { db } = makeDb(JSON.stringify({ friendCoupon: { enabled: true, percent: 5, code: ' NTOMO5 ', label: 'L' } }));
    const cfg = await getFriendCouponConfig(db);
    expect(cfg.enabled).toBe(true);
    expect(cfg.code).toBe('NTOMO5');
    expect(cfg.label).toBe('L');
  });

  it('getFriendCouponConfig: 壊れた JSON でも default で吸収', async () => {
    const { db } = makeDb('{not json');
    const cfg = await getFriendCouponConfig(db);
    expect(cfg.enabled).toBe(false);
    expect(cfg.percent).toBe(5);
  });

  it('setFriendCouponConfig: percent を 1-100 に clamp し、他 metadata キーを保持', async () => {
    const { db, getStored } = makeDb(JSON.stringify({ industry: 'supplement', friendCoupon: { enabled: false } }));
    const cfg = await setFriendCouponConfig(db, { enabled: true, percent: 999, code: 'X' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.percent).toBe(100);
    const stored = JSON.parse(getStored() as string);
    expect(stored.industry).toBe('supplement'); // 他キーを壊さない
    expect(stored.friendCoupon.code).toBe('X');
  });

  it('setFriendCouponConfig: 未指定 field は現状維持 (partial update)', async () => {
    const { db } = makeDb(JSON.stringify({ friendCoupon: { enabled: true, percent: 8, code: 'KEEP', label: 'L' } }));
    const cfg = await setFriendCouponConfig(db, { enabled: false });
    expect(cfg.enabled).toBe(false);
    expect(cfg.percent).toBe(8);
    expect(cfg.code).toBe('KEEP');
  });

  it('setFriendCouponConfig: percent 下限 (0 → 1) に clamp', async () => {
    const { db } = makeDb(JSON.stringify({ friendCoupon: {} }));
    const cfg = await setFriendCouponConfig(db, { percent: 0 });
    expect(cfg.percent).toBe(1);
  });

  it('setFriendCouponConfig: default row 無し → throw', async () => {
    const { db } = makeDb(null);
    await expect(setFriendCouponConfig(db, { enabled: true })).rejects.toThrow();
  });
});

// ─── 統合 静的ガード ───
const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string): string => readFileSync(join(root, '..', rel), 'utf8');

describe('friend coupon 統合', () => {
  const pages = readSrc('routes/liff-pages.ts');
  const portal = readSrc('routes/liff-portal.ts');
  const adminRoute = readSrc('routes/friend-coupon.ts');
  const auth = readSrc('middleware/auth.ts');

  it('LIFF portal home に friend-coupon-card + loadFriendCoupon (init で呼ばれる)', () => {
    expect(pages).toContain('id="friend-coupon-card"');
    expect(pages).toContain('function loadFriendCoupon');
    expect(pages).toMatch(/Promise\.all\(\[[^\]]*loadFriendCoupon\(\)/);
  });

  it('LIFF endpoint GET /api/liff/friend-coupon が存在 (idToken 認証)', () => {
    expect(portal).toContain("liffPortal.get('/api/liff/friend-coupon'");
    expect(portal).toContain('getFriendCouponConfig');
  });

  it('admin route に GET/PUT API + 管理 HTML ページ', () => {
    expect(adminRoute).toContain("'/api/admin/friend-coupon'");
    expect(adminRoute).toContain("'/admin/friend-coupon'");
    expect(adminRoute).toContain('setFriendCouponConfig');
  });

  it('auth skip は HTML ページのみ。/api/admin/friend-coupon は API_KEY 保護のまま', () => {
    expect(auth).toContain("path === '/admin/friend-coupon'");
    // API パス自体を skip-list に入れていない (無認証改変の穴を作らない)
    expect(auth).not.toMatch(/path === '\/api\/admin\/friend-coupon'/);
  });
});
