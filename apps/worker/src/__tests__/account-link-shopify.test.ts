/**
 * Tests for account-link-shopify (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 *
 * forward link (email→customer + metafieldsSet 書込) を検証:
 *   - findShopifyCustomerByEmail: 厳密(case-insensitive)一致 1 件のみ採用 / 部分一致・複数・0件・不正 email → null /
 *     gid 正規化 / query body / HTTP・GraphQL エラー → throw / email 注入防御
 *   - setCustomerLineUserIdMetafield: 成功 ok / userErrors → ok=false / 不正入力 → fetch せず ok=false /
 *     mutation body (ownerId gid + single_line_text_field) / HTTP・GraphQL エラー → throw
 *
 * GraphQL は shopify-dev MCP validate_graphql_codeblocks で ✅ VALID 済 (query: read_customers / mutation: metafieldsSet)。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  findShopifyCustomerByEmail,
  setCustomerLineUserIdMetafield,
} from '../services/account-link-shopify.js';

const TOKEN = 'shpat_test_token';

function customersResponse(edges: Array<{ id: string; email: string | null }>) {
  return new Response(
    JSON.stringify({
      data: {
        customers: {
          edges: edges.map((e) => ({
            node: { id: e.id, defaultEmailAddress: e.email === null ? null : { emailAddress: e.email } },
          })),
        },
      },
    }),
    { status: 200 },
  );
}

// ============================================================
// findShopifyCustomerByEmail
// ============================================================

describe('findShopifyCustomerByEmail', () => {
  it('厳密一致 1 件 → customerId(正規化)', async () => {
    const fetchImpl = vi.fn(async () => customersResponse([{ id: 'gid://shopify/Customer/777', email: 'alice@x.com' }]));
    const r = await findShopifyCustomerByEmail('shop.myshopify.com', TOKEN, 'alice@x.com', fetchImpl as unknown as typeof fetch);
    expect(r).toEqual({ customerId: '777' });
  });

  it('case-insensitive 一致 (= 入力大文字 / Shopify 小文字)', async () => {
    const fetchImpl = vi.fn(async () => customersResponse([{ id: 'gid://shopify/Customer/5', email: 'alice@x.com' }]));
    const r = await findShopifyCustomerByEmail('shop.myshopify.com', TOKEN, 'Alice@X.com', fetchImpl as unknown as typeof fetch);
    expect(r).toEqual({ customerId: '5' });
  });

  it('query body: email:"<lower>" + 厳密一致のみ採用 (= 部分一致の余分 edge 排除)', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body);
      // Shopify は部分一致で別 customer も返しうる → 厳密一致は 1 件
      return customersResponse([
        { id: 'gid://shopify/Customer/1', email: 'alice@x.com' },
        { id: 'gid://shopify/Customer/2', email: 'alice2@x.com' },
      ]);
    });
    const r = await findShopifyCustomerByEmail('shop.myshopify.com', TOKEN, 'alice@x.com', fetchImpl as unknown as typeof fetch);
    expect(r).toEqual({ customerId: '1' });
    expect(captured!.variables).toEqual({ q: 'email:"alice@x.com"' });
    expect(captured!.query).toContain('defaultEmailAddress { emailAddress }');
  });

  it('厳密一致が複数件 (ambiguous) → null', async () => {
    const fetchImpl = vi.fn(async () =>
      customersResponse([
        { id: 'gid://shopify/Customer/1', email: 'dup@x.com' },
        { id: 'gid://shopify/Customer/2', email: 'dup@x.com' },
      ]),
    );
    const r = await findShopifyCustomerByEmail('shop.myshopify.com', TOKEN, 'dup@x.com', fetchImpl as unknown as typeof fetch);
    expect(r).toBeNull();
  });

  it('0 件 → null', async () => {
    const fetchImpl = vi.fn(async () => customersResponse([]));
    const r = await findShopifyCustomerByEmail('shop.myshopify.com', TOKEN, 'none@x.com', fetchImpl as unknown as typeof fetch);
    expect(r).toBeNull();
  });

  it('部分一致だけ (厳密一致 0) → null', async () => {
    const fetchImpl = vi.fn(async () => customersResponse([{ id: 'gid://shopify/Customer/9', email: 'alice-other@x.com' }]));
    const r = await findShopifyCustomerByEmail('shop.myshopify.com', TOKEN, 'alice@x.com', fetchImpl as unknown as typeof fetch);
    expect(r).toBeNull();
  });

  it('不正 email (注入リスク) → fetch せず null', async () => {
    const fetchImpl = vi.fn();
    const r = await findShopifyCustomerByEmail('shop.myshopify.com', TOKEN, 'a"b@x.com', fetchImpl as unknown as typeof fetch);
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('HTTP error → throw', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 }));
    await expect(
      findShopifyCustomerByEmail('shop.myshopify.com', TOKEN, 'a@x.com', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('GraphQL errors → throw (= 障害を notFound に誤計上しない)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'throttled' }] }), { status: 200 }));
    await expect(
      findShopifyCustomerByEmail('shop.myshopify.com', TOKEN, 'a@x.com', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/throttled/);
  });
});

// ============================================================
// setCustomerLineUserIdMetafield
// ============================================================

function metafieldsSetResponse(userErrors: Array<{ message: string }> = []) {
  return new Response(
    JSON.stringify({ data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors } } }),
    { status: 200 },
  );
}

describe('setCustomerLineUserIdMetafield', () => {
  it('成功 (userErrors なし) → ok=true + mutation body (ownerId gid + type)', async () => {
    let captured: { query: string; variables: { metafields: Array<Record<string, unknown>> } } | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body);
      return metafieldsSetResponse();
    });
    const r = await setCustomerLineUserIdMetafield(
      'shop.myshopify.com', TOKEN, '777', 'naturism', 'line_user_id', 'U_alice', fetchImpl as unknown as typeof fetch,
    );
    expect(r.ok).toBe(true);
    expect(r.userErrors).toEqual([]);
    const mf = captured!.variables.metafields[0];
    expect(mf.ownerId).toBe('gid://shopify/Customer/777');
    expect(mf.namespace).toBe('naturism');
    expect(mf.key).toBe('line_user_id');
    expect(mf.type).toBe('single_line_text_field');
    expect(mf.value).toBe('U_alice');
    expect(captured!.query).toContain('metafieldsSet');
  });

  it('userErrors あり → ok=false + message', async () => {
    const fetchImpl = vi.fn(async () => metafieldsSetResponse([{ message: 'owner not found' }]));
    const r = await setCustomerLineUserIdMetafield(
      'shop.myshopify.com', TOKEN, '777', 'naturism', 'line_user_id', 'U_alice', fetchImpl as unknown as typeof fetch,
    );
    expect(r.ok).toBe(false);
    expect(r.userErrors).toEqual(['owner not found']);
  });

  it('不正 customerId → fetch せず ok=false', async () => {
    const fetchImpl = vi.fn();
    const r = await setCustomerLineUserIdMetafield(
      'shop.myshopify.com', TOKEN, 'gid://x/1', 'naturism', 'line_user_id', 'U_alice', fetchImpl as unknown as typeof fetch,
    );
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('不正 namespace/key → fetch せず ok=false', async () => {
    const fetchImpl = vi.fn();
    const r = await setCustomerLineUserIdMetafield(
      'shop.myshopify.com', TOKEN, '777', 'bad:ns', 'line_user_id', 'U_alice', fetchImpl as unknown as typeof fetch,
    );
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('不正 lineUserId (注入) → fetch せず ok=false', async () => {
    const fetchImpl = vi.fn();
    const r = await setCustomerLineUserIdMetafield(
      'shop.myshopify.com', TOKEN, '777', 'naturism', 'line_user_id', 'U" bad', fetchImpl as unknown as typeof fetch,
    );
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('HTTP error → throw', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 503 }));
    await expect(
      setCustomerLineUserIdMetafield('shop.myshopify.com', TOKEN, '777', 'naturism', 'line_user_id', 'U_a', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('GraphQL errors → throw', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'bad' }] }), { status: 200 }));
    await expect(
      setCustomerLineUserIdMetafield('shop.myshopify.com', TOKEN, '777', 'naturism', 'line_user_id', 'U_a', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/bad/);
  });
});
