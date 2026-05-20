/**
 * Tests for stealth.ts — focus on jitterDeliveryTime() future-only invariant.
 *
 * 5β-polish (2026-05-20): jitterDeliveryTime が **過去方向に shift しない** ことを保証する。
 * これにより step-delivery の `enforceDeliveryWindow(...)` → `jitterDeliveryTime(...)` の
 * 順序で window 内に閉じ込められる (= 旧実装で 09:00 → 08:55 になる事案を防止)。
 */

import { describe, it, expect } from 'vitest';
import { jitterDeliveryTime } from '../services/stealth.js';

describe('jitterDeliveryTime', () => {
  it('never shifts to the past (= 未来方向のみ jitter、 5β-polish 不変条件)', () => {
    const base = new Date('2026-05-21T09:00:00.000Z');
    // 1000 回試行で 過去方向 shift がないことを確認
    for (let i = 0; i < 1000; i++) {
      const result = jitterDeliveryTime(base);
      expect(result.getTime()).toBeGreaterThanOrEqual(base.getTime());
    }
  });

  it('shifts by 0〜+9 minutes (= range 確認)', () => {
    const base = new Date('2026-05-21T09:00:00.000Z');
    const baseMs = base.getTime();
    const maxShiftMs = 9 * 60 * 1000;
    // 1000 回試行で 9 分以内に収まることを確認
    for (let i = 0; i < 1000; i++) {
      const result = jitterDeliveryTime(base);
      const shiftMs = result.getTime() - baseMs;
      expect(shiftMs).toBeGreaterThanOrEqual(0);
      expect(shiftMs).toBeLessThanOrEqual(maxShiftMs);
    }
  });

  it('produces variety across multiple calls (= 単一値に固まらない)', () => {
    const base = new Date('2026-05-21T09:00:00.000Z');
    const results = new Set<number>();
    for (let i = 0; i < 200; i++) {
      results.add(jitterDeliveryTime(base).getTime());
    }
    // 200 回中 5 種類以上の結果 (= deterministic に固まっていない)。
    // 確率的には 0-9 分 = 10 種類のうち十分多様化される
    expect(results.size).toBeGreaterThan(5);
  });

  it('does NOT mutate the input Date (= 純粋関数)', () => {
    const base = new Date('2026-05-21T09:00:00.000Z');
    const baseMs = base.getTime();
    jitterDeliveryTime(base);
    expect(base.getTime()).toBe(baseMs);
  });

  it('window enforcement integration: 09:00 base から jitter で window 外 (= 23 時以降) に出ない', () => {
    // base = 09:00、 jitter max +9 min → 09:09 が上限 → 23:00 までは余裕
    // base = 22:59、 jitter max +9 min → 23:08 で window 外 (= 23:00 が end hour)
    // ただし step-delivery では enforceDeliveryWindow → jitterDeliveryTime の順なので、
    // base = 22:59 はそもそも来ない (= 9-23 window 内に既に押し込まれてる)
    // 09:00 base なら 09:00-09:09 内に必ず収まる
    const morning = new Date('2026-05-21T09:00:00.000Z');
    const dayInMs = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 100; i++) {
      const result = jitterDeliveryTime(morning);
      // 同日内 + 9 分以内
      expect(result.getTime() - morning.getTime()).toBeLessThan(10 * 60 * 1000);
      expect(result.getTime() - morning.getTime()).toBeGreaterThanOrEqual(0);
      expect(Math.floor(result.getTime() / dayInMs)).toBe(Math.floor(morning.getTime() / dayInMs));
    }
  });
});
