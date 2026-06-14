/**
 * upsertShopifyOrder の UPDATE(既存注文)パスを直接テスト (Launch-readiness review #11)。
 *
 * orders/updated で payload に欠落したフィールドは COALESCE で既存値を維持し、
 * 指定があれば上書きすることを bind 引数レベルで検証 (bind 順序ドリフトの早期検知)。
 */

import { describe, it, expect } from 'vitest';
import { upsertShopifyOrder } from '@line-crm/db';

type Bind = { sql: string; args: unknown[] };

function makeDb(existing: Record<string, unknown> | null) {
  const binds: Bind[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        _args: [] as unknown[],
        bind(...a: unknown[]) {
          this._args = a;
          binds.push({ sql, args: a });
          return this;
        },
        async first() {
          if (sql.includes('WHERE shopify_order_id')) return existing;
          if (sql.includes('WHERE id')) return { ...(existing ?? {}), id: 'so-1' };
          return null;
        },
        async run() {
          return { success: true };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, binds };
}

const EXISTING = {
  id: 'so-1',
  shopify_order_id: '12345',
  total_price: 6415,
  line_items: '[{"name":"Blue"}]',
  email: 'old@example.com',
  phone: '090',
  order_number: 1001,
  financial_status: 'paid',
  fulfillment_status: 'unfulfilled',
};

describe('upsertShopifyOrder — UPDATE COALESCE', () => {
  it('欠落フィールド (totalPrice/lineItems/email/phone/orderNumber 未指定) は null を bind し既存値を維持', async () => {
    const { db, binds } = makeDb(EXISTING);
    await upsertShopifyOrder(db, { shopifyOrderId: '12345', financialStatus: 'refunded' });
    const upd = binds.find((b) => b.sql.includes('UPDATE shopify_orders'));
    expect(upd).toBeTruthy();
    // bind 順: financial_status(0) fulfillment_status(1) friend_id(2) tags(3) metadata(4)
    //          total_price(5) line_items(6) email(7) phone(8) order_number(9) updated_at(10) where(11)
    expect(upd!.args[5]).toBeNull(); // total_price → COALESCE で既存維持
    expect(upd!.args[6]).toBeNull(); // line_items
    expect(upd!.args[7]).toBeNull(); // email
    expect(upd!.args[8]).toBeNull(); // phone
    expect(upd!.args[9]).toBeNull(); // order_number
    expect(upd!.args[0]).toBe('refunded'); // financial_status は指定したので上書き
  });

  it('指定フィールドは bind に反映され上書きされる', async () => {
    const { db, binds } = makeDb(EXISTING);
    await upsertShopifyOrder(db, {
      shopifyOrderId: '12345',
      totalPrice: 7960,
      lineItems: '[{"name":"Blue","quantity":2}]',
      email: 'new@example.com',
    });
    const upd = binds.find((b) => b.sql.includes('UPDATE shopify_orders'))!;
    expect(upd.args[5]).toBe(7960);
    expect(upd.args[6]).toBe('[{"name":"Blue","quantity":2}]');
    expect(upd.args[7]).toBe('new@example.com');
  });
});
