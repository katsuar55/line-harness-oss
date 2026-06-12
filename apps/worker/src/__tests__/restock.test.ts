/**
 * Tests for the restock service (Task#3 再入荷通知の完動化):
 *   - resolveVariant: variants_json から inventory_item_id/在庫数を解決
 *   - handleRestockPostback: 登録/重複/商品なし の3経路 (reply token 返信)
 *   - isOutOfStock / buildRestockPostbackData
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@line-crm/db', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...original,
    getShopifyProductByShopifyId: vi.fn(),
    getWaitingRestockRequest: vi.fn(),
    getWaitingRestockCountByFriend: vi.fn(async () => 0),
    createRestockRequest: vi.fn(),
  };
});

import {
  resolveVariant,
  handleRestockPostback,
  isOutOfStock,
  buildRestockPostbackData,
} from '../services/restock.js';
import {
  getShopifyProductByShopifyId,
  getWaitingRestockRequest,
  getWaitingRestockCountByFriend,
  createRestockRequest,
} from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';

const mockGetProduct = getShopifyProductByShopifyId as ReturnType<typeof vi.fn>;
const mockGetWaiting = getWaitingRestockRequest as ReturnType<typeof vi.fn>;
const mockGetWaitingCount = getWaitingRestockCountByFriend as ReturnType<typeof vi.fn>;
const mockCreate = createRestockRequest as ReturnType<typeof vi.fn>;

const VARIANTS = [
  { id: 111, title: 'Default', inventory_item_id: 999, inventory_quantity: 0 },
  { id: 222, title: 'Large', inventory_item_id: 888, inventory_quantity: 5 },
];

const PRODUCT = {
  id: 'p-row-1',
  shopify_product_id: '777',
  title: 'naturism サプリ',
  variants_json: JSON.stringify(VARIANTS),
};

function fakeLineClient() {
  const replyMessage = vi.fn(
    async (_replyToken: string, _messages: Array<{ type: string; text: string }>) => {},
  );
  return { client: { replyMessage } as unknown as LineClient, replyMessage };
}

const FRIEND = { id: 'f1', display_name: 'Taro' };
const DB = {} as D1Database;

describe('resolveVariant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves inventory_item_id from variants_json (specific variant)', async () => {
    mockGetProduct.mockResolvedValue(PRODUCT);
    const r = await resolveVariant(DB, '777', '222');
    expect(r).toMatchObject({
      variantId: '222',
      inventoryItemId: '888',
      inventoryQuantity: 5,
      productTitle: 'naturism サプリ',
    });
  });

  it('falls back to the first variant when variantId is omitted', async () => {
    mockGetProduct.mockResolvedValue(PRODUCT);
    const r = await resolveVariant(DB, '777', null);
    expect(r?.variantId).toBe('111');
    expect(r?.inventoryItemId).toBe('999');
  });

  it('returns null for unknown product or empty variants', async () => {
    mockGetProduct.mockResolvedValue(null);
    expect(await resolveVariant(DB, 'nope')).toBeNull();
    mockGetProduct.mockResolvedValue({ ...PRODUCT, variants_json: '[]' });
    expect(await resolveVariant(DB, '777')).toBeNull();
    mockGetProduct.mockResolvedValue({ ...PRODUCT, variants_json: 'not-json' });
    expect(await resolveVariant(DB, '777')).toBeNull();
  });
});

describe('handleRestockPostback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProduct.mockResolvedValue(PRODUCT);
    mockGetWaiting.mockResolvedValue(null);
    mockGetWaitingCount.mockResolvedValue(0);
    mockCreate.mockResolvedValue({ id: 'rr-1' });
  });

  it('registers a new request with resolved inventory_item_id and replies', async () => {
    const { client, replyMessage } = fakeLineClient();
    const params = new URLSearchParams('action=restock_request&pid=777&vid=111');

    const result = await handleRestockPostback(DB, client, FRIEND, 'reply-token', params);

    expect(result.outcome).toBe('registered');
    expect(mockCreate).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({
        friendId: 'f1',
        shopifyProductId: '777',
        shopifyVariantId: '111',
        inventoryItemId: '999',
        productTitle: 'naturism サプリ',
      }),
    );
    expect(replyMessage).toHaveBeenCalledTimes(1);
    const messages = replyMessage.mock.calls[0][1] as Array<{ text: string }>;
    expect(messages[0].text).toContain('受け付けました');
  });

  it('is idempotent: duplicate waiting request does not create a new row', async () => {
    mockGetWaiting.mockResolvedValue({ id: 'rr-existing' });
    const { client, replyMessage } = fakeLineClient();
    const params = new URLSearchParams('action=restock_request&pid=777&vid=111');

    const result = await handleRestockPostback(DB, client, FRIEND, 'reply-token', params);

    expect(result.outcome).toBe('duplicate');
    expect(mockCreate).not.toHaveBeenCalled();
    const messages = replyMessage.mock.calls[0][1] as Array<{ text: string }>;
    expect(messages[0].text).toContain('登録済み');
  });

  it('rejects with limit_reached when the friend hits the waiting cap', async () => {
    mockGetWaitingCount.mockResolvedValue(20);
    const { client, replyMessage } = fakeLineClient();
    const params = new URLSearchParams('action=restock_request&pid=777&vid=222');

    const result = await handleRestockPostback(DB, client, FRIEND, 'reply-token', params);

    expect(result.outcome).toBe('limit_reached');
    expect(mockCreate).not.toHaveBeenCalled();
    const messages = replyMessage.mock.calls[0][1] as Array<{ text: string }>;
    expect(messages[0].text).toContain('上限');
  });

  it('replies gracefully when the product is not found', async () => {
    mockGetProduct.mockResolvedValue(null);
    const { client, replyMessage } = fakeLineClient();
    const params = new URLSearchParams('action=restock_request&pid=gone');

    const result = await handleRestockPostback(DB, client, FRIEND, 'reply-token', params);

    expect(result.outcome).toBe('product_not_found');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(replyMessage).toHaveBeenCalledTimes(1);
  });
});

describe('isOutOfStock / buildRestockPostbackData', () => {
  it('detects out-of-stock from the first variant', () => {
    expect(isOutOfStock(JSON.stringify(VARIANTS))).toBe(true); // first variant qty 0
    expect(isOutOfStock(JSON.stringify([VARIANTS[1]]))).toBe(false); // qty 5
    expect(isOutOfStock(null)).toBe(false);
    expect(isOutOfStock('broken')).toBe(false);
    // 在庫数が無い (在庫追跡なし) は在庫ありとみなす
    expect(isOutOfStock(JSON.stringify([{ id: 1 }]))).toBe(false);
    // 負数 (inventory_policy='continue' で購入可能) は在庫扱い (=ボタン出さない)
    expect(isOutOfStock(JSON.stringify([{ id: 1, inventory_quantity: -3 }]))).toBe(false);
  });

  it('builds the postback data in action= format', () => {
    const data = buildRestockPostbackData('777', '111');
    const params = new URLSearchParams(data);
    expect(params.get('action')).toBe('restock_request');
    expect(params.get('pid')).toBe('777');
    expect(params.get('vid')).toBe('111');
  });
});
