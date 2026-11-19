import { describe, it, expect } from 'vitest';
import {
  RECEIPT_LOOKUP_URL,
  buildFulfillmentLineMessage,
  buildReceiptGuide,
  resolveShopifyOrderName,
} from '../services/fulfillment-line-message.js';

describe('resolveShopifyOrderName (お客様に見せる注文番号)', () => {
  it('fulfillment.name (#4625.1) の発送連番を外して使う', () => {
    expect(resolveShopifyOrderName('#4625.1', null)).toBe('#4625');
    expect(resolveShopifyOrderName('#4625.12', 9999)).toBe('#4625');
  });

  it('fulfillment.name が無ければ D1 の order_number から #N を作る', () => {
    expect(resolveShopifyOrderName(undefined, 4625)).toBe('#4625');
    expect(resolveShopifyOrderName(null, '4625')).toBe('#4625');
  });

  it('形のおかしい fulfillment.name は使わず order_number に落ちる (文に混ぜない)', () => {
    expect(resolveShopifyOrderName('#4625', 4625)).toBe('#4625'); // 連番なし = 形が違う
    expect(resolveShopifyOrderName('<script>.1', 4625)).toBe('#4625');
    expect(resolveShopifyOrderName('#46 25.1', null)).toBeNull();
    expect(resolveShopifyOrderName(`#${'1'.repeat(40)}.1`, null)).toBeNull();
  });

  it('どちらも使えなければ null', () => {
    expect(resolveShopifyOrderName(undefined, undefined)).toBeNull();
    expect(resolveShopifyOrderName('', 0)).toBeNull();
    expect(resolveShopifyOrderName(123, -1)).toBeNull();
    expect(resolveShopifyOrderName(undefined, 1.5)).toBeNull();
    expect(resolveShopifyOrderName(undefined, 'abc')).toBeNull();
  });
});

describe('buildFulfillmentLineMessage (発送の LINE の文)', () => {
  it('追跡番号・注文番号・領収書のページのリンクが 1 つの文に入る', () => {
    const msg = buildFulfillmentLineMessage('TRACK123456', '#4625');
    expect(msg).toBe(
      'ご注文の商品が発送されました！追跡番号: TRACK123456\n\n' +
        '領収書が必要なお客様は、注文番号 (#4625) と、ご注文のときのメールアドレスを入れて表示してください: ' +
        'https://app.2clover.biz/receipt/lookup',
    );
  });

  it('注文番号が分からないときは番号の部分を省く', () => {
    const msg = buildFulfillmentLineMessage('TRACK123456', null);
    expect(msg).toContain('領収書が必要なお客様は、注文番号と、ご注文のときのメールアドレス');
    expect(msg).not.toContain('()');
    expect(msg).toContain(RECEIPT_LOOKUP_URL);
  });

  it('LINE のテキスト 1 通の上限 (5000 字) に十分収まる', () => {
    expect(buildFulfillmentLineMessage('X'.repeat(100), '#'.concat('9'.repeat(32))).length).toBeLessThan(500);
  });

  it('案内文はリンクで終わる (LINE がリンクとして認識できる)', () => {
    expect(buildReceiptGuide('#1').endsWith(RECEIPT_LOOKUP_URL)).toBe(true);
  });
});
