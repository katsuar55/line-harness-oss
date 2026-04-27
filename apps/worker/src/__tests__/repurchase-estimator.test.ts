/**
 * Tests for repurchase-estimator (Phase 6 PR-1).
 *
 * 全 DB 呼び出しは EstimatorDeps 経由で差し替えるため、
 * ここでは pure 関数 + 4 段階フォールバックの分岐を検証する。
 */

import { describe, it, expect } from 'vitest';
import {
  clampInterval,
  extractDaysFromTitle,
  estimateRepurchaseInterval,
  DEFAULT_INTERVAL_DAYS,
  MIN_INTERVAL_DAYS,
  MAX_INTERVAL_DAYS,
} from '../services/repurchase-estimator.js';

const fakeDb = {} as unknown as D1Database;

// ============================================================
// clampInterval
// ============================================================

describe('clampInterval', () => {
  it('正常値はそのまま整数で返す', () => {
    expect(clampInterval(30)).toBe(30);
    expect(clampInterval(45.4)).toBe(45);
    expect(clampInterval(45.6)).toBe(46);
  });

  it('下限以下は MIN_INTERVAL_DAYS にクランプ', () => {
    expect(clampInterval(0)).toBe(MIN_INTERVAL_DAYS);
    expect(clampInterval(3)).toBe(MIN_INTERVAL_DAYS);
    expect(clampInterval(-10)).toBe(MIN_INTERVAL_DAYS);
  });

  it('上限以上は MAX_INTERVAL_DAYS にクランプ', () => {
    expect(clampInterval(120)).toBe(MAX_INTERVAL_DAYS);
    expect(clampInterval(365)).toBe(MAX_INTERVAL_DAYS);
  });

  it('NaN / Infinity は DEFAULT に倒す', () => {
    expect(clampInterval(Number.NaN)).toBe(DEFAULT_INTERVAL_DAYS);
    expect(clampInterval(Number.POSITIVE_INFINITY)).toBe(DEFAULT_INTERVAL_DAYS);
  });
});

// ============================================================
// extractDaysFromTitle
// ============================================================

describe('extractDaysFromTitle', () => {
  it('「30日分」を抽出', () => {
    expect(extractDaysFromTitle('プロテイン30日分')).toBe(30);
  });

  it('「60 日」(空白あり) を抽出', () => {
    expect(extractDaysFromTitle('鉄サプリ 60 日')).toBe(60);
  });

  it('全角数字「９０日分」を抽出', () => {
    expect(extractDaysFromTitle('美容ドリンク９０日分')).toBe(90);
  });

  it('英語「30days」「30 day」を抽出', () => {
    expect(extractDaysFromTitle('Vitamin C 30days')).toBe(30);
    expect(extractDaysFromTitle('Magnesium 60 day')).toBe(60);
  });

  it('該当キーワードなしは null', () => {
    expect(extractDaysFromTitle('プロテイン')).toBeNull();
    expect(extractDaysFromTitle('500ml')).toBeNull();
  });

  it('null/undefined/空文字は null', () => {
    expect(extractDaysFromTitle(null)).toBeNull();
    expect(extractDaysFromTitle(undefined)).toBeNull();
    expect(extractDaysFromTitle('')).toBeNull();
  });
});

// ============================================================
// estimateRepurchaseInterval — 4段階フォールバック
// ============================================================

describe('estimateRepurchaseInterval', () => {
  it('Tier 1: user_history が見つかれば最優先で採用 (clamp 適用)', async () => {
    const result = await estimateRepurchaseInterval(
      {
        db: fakeDb,
        friendId: 'friend-1',
        shopifyProductId: 'prod-100',
        productTitle: 'テストSKU',
      },
      {
        computeUserHistory: async () => ({ averageDays: 28.4, sampleSize: 3 }),
        getProductDefault: async () => null,
      },
    );

    expect(result).toEqual({
      intervalDays: 28,
      source: 'user_history',
      sampleSize: 3,
      productTitle: 'テストSKU',
    });
  });

  it('Tier 1: ユーザー履歴の超短期は MIN にクランプ', async () => {
    const result = await estimateRepurchaseInterval(
      {
        db: fakeDb,
        friendId: 'friend-1',
        shopifyProductId: 'prod-100',
        productTitle: null,
      },
      {
        computeUserHistory: async () => ({ averageDays: 2, sampleSize: 5 }),
        getProductDefault: async () => null,
      },
    );

    expect(result.intervalDays).toBe(MIN_INTERVAL_DAYS);
    expect(result.source).toBe('user_history');
  });

  it('Tier 2: product_default を採用 (履歴なし)', async () => {
    const result = await estimateRepurchaseInterval(
      {
        db: fakeDb,
        friendId: 'friend-1',
        shopifyProductId: 'prod-100',
        productTitle: 'インプット',
      },
      {
        computeUserHistory: async () => null,
        getProductDefault: async () => ({
          shopify_product_id: 'prod-100',
          product_title: 'マスター登録',
          default_interval_days: 45,
          source: 'manual',
          sample_size: 0,
          notes: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        }),
      },
    );

    expect(result).toEqual({
      intervalDays: 45,
      source: 'product_default',
      sampleSize: 0,
      productTitle: 'マスター登録',
    });
  });

  it('Tier 2: product_default の異常値も clamp する', async () => {
    const result = await estimateRepurchaseInterval(
      {
        db: fakeDb,
        friendId: 'friend-1',
        shopifyProductId: 'prod-100',
        productTitle: null,
      },
      {
        computeUserHistory: async () => null,
        getProductDefault: async () => ({
          shopify_product_id: 'prod-100',
          product_title: null,
          default_interval_days: 300,
          source: 'manual',
          sample_size: 0,
          notes: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        }),
      },
    );

    expect(result.intervalDays).toBe(MAX_INTERVAL_DAYS);
    expect(result.source).toBe('product_default');
  });

  it('Tier 3: 商品名から auto_estimated', async () => {
    const result = await estimateRepurchaseInterval(
      {
        db: fakeDb,
        friendId: 'friend-1',
        shopifyProductId: 'prod-100',
        productTitle: 'プロテイン60日分',
      },
      {
        computeUserHistory: async () => null,
        getProductDefault: async () => null,
      },
    );

    expect(result.intervalDays).toBe(60);
    expect(result.source).toBe('auto_estimated');
    expect(result.sampleSize).toBe(0);
  });

  it('Tier 4: いずれもなければ fallback 30 日', async () => {
    const result = await estimateRepurchaseInterval(
      {
        db: fakeDb,
        friendId: 'friend-1',
        shopifyProductId: 'prod-100',
        productTitle: 'タイトルにヒントなし',
      },
      {
        computeUserHistory: async () => null,
        getProductDefault: async () => null,
      },
    );

    expect(result.intervalDays).toBe(DEFAULT_INTERVAL_DAYS);
    expect(result.source).toBe('fallback');
    expect(result.sampleSize).toBe(0);
  });

  it('shopify_product_id が無ければ DB を呼ばず title→fallback', async () => {
    let userCalled = 0;
    let productCalled = 0;
    const result = await estimateRepurchaseInterval(
      {
        db: fakeDb,
        friendId: 'friend-1',
        shopifyProductId: null,
        productTitle: 'コラーゲン90日分',
      },
      {
        computeUserHistory: async () => {
          userCalled++;
          return null;
        },
        getProductDefault: async () => {
          productCalled++;
          return null;
        },
      },
    );

    expect(userCalled).toBe(0);
    expect(productCalled).toBe(0);
    expect(result.intervalDays).toBe(90);
    expect(result.source).toBe('auto_estimated');
  });

  it('ユーザー履歴が throw してもフォールスルーする', async () => {
    const result = await estimateRepurchaseInterval(
      {
        db: fakeDb,
        friendId: 'friend-1',
        shopifyProductId: 'prod-100',
        productTitle: '商品30日分',
      },
      {
        computeUserHistory: async () => {
          throw new Error('db transient');
        },
        getProductDefault: async () => null,
      },
    );

    expect(result.source).toBe('auto_estimated');
    expect(result.intervalDays).toBe(30);
  });

  it('product_default が throw してもフォールスルーする', async () => {
    const result = await estimateRepurchaseInterval(
      {
        db: fakeDb,
        friendId: 'friend-1',
        shopifyProductId: 'prod-100',
        productTitle: null,
      },
      {
        computeUserHistory: async () => null,
        getProductDefault: async () => {
          throw new Error('db transient');
        },
      },
    );

    expect(result.source).toBe('fallback');
    expect(result.intervalDays).toBe(DEFAULT_INTERVAL_DAYS);
  });
});
