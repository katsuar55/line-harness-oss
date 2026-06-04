/**
 * Tests for cart-permalink (= 自社内製ロイヤリティ PR5-5b, 2026-06-04)
 */
import { describe, it, expect } from 'vitest';
import {
  buildCartPermalink,
  buildDiscountApplyUrl,
  toNumericVariantId,
} from '../services/cart-permalink.js';

describe('toNumericVariantId', () => {
  it('gid → 数値', () => {
    expect(toNumericVariantId('gid://shopify/ProductVariant/41234567890')).toBe('41234567890');
  });
  it('数値文字列 → そのまま', () => {
    expect(toNumericVariantId('41234567890')).toBe('41234567890');
  });
  it('数値 → 文字列', () => {
    expect(toNumericVariantId(41234567890)).toBe('41234567890');
  });
  it('不正/欠損 → null', () => {
    expect(toNumericVariantId('abc')).toBeNull();
    expect(toNumericVariantId(null)).toBeNull();
    expect(toNumericVariantId(undefined)).toBeNull();
    expect(toNumericVariantId('gid://shopify/Product/123')).toBeNull(); // Product であって Variant でない
  });
});

describe('buildCartPermalink', () => {
  it('単一商品 + 割引コード', () => {
    expect(
      buildCartPermalink('naturism-diet.com', [{ variantId: '40000000001', quantity: 1 }], 'NLR-SILVER-ABCD2345'),
    ).toBe('https://naturism-diet.com/cart/40000000001:1?discount=NLR-SILVER-ABCD2345');
  });
  it('複数商品 (gid 混在) + コードなし', () => {
    expect(
      buildCartPermalink('naturism-diet.com', [
        { variantId: 'gid://shopify/ProductVariant/1001', quantity: 2 },
        { variantId: '1002', quantity: 1 },
      ]),
    ).toBe('https://naturism-diet.com/cart/1001:2,1002:1');
  });
  it('有効 item なし → null', () => {
    expect(buildCartPermalink('naturism-diet.com', [{ variantId: 'abc', quantity: 1 }])).toBeNull();
    expect(buildCartPermalink('naturism-diet.com', [{ variantId: '1001', quantity: 0 }])).toBeNull();
    expect(buildCartPermalink('naturism-diet.com', [])).toBeNull();
  });
  it('store 未設定 → null', () => {
    expect(buildCartPermalink('', [{ variantId: '1001', quantity: 1 }])).toBeNull();
  });
  it('discount コードは URL エンコード', () => {
    expect(buildCartPermalink('s.com', [{ variantId: '1', quantity: 1 }], 'A B')).toBe(
      'https://s.com/cart/1:1?discount=A%20B',
    );
  });
});

describe('buildDiscountApplyUrl', () => {
  it('割引適用 URL', () => {
    expect(buildDiscountApplyUrl('naturism-diet.com', 'NLR-GOLD-XXXX2345')).toBe(
      'https://naturism-diet.com/discount/NLR-GOLD-XXXX2345',
    );
  });
  it('コード/store なし → null', () => {
    expect(buildDiscountApplyUrl('s.com', '')).toBeNull();
    expect(buildDiscountApplyUrl('', 'NLR-X')).toBeNull();
    expect(buildDiscountApplyUrl('s.com', null)).toBeNull();
  });
});
