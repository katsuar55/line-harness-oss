/**
 * Shopify顧客一括同期サービス
 * Cronトリガーまたは手動APIから呼び出し可能
 */
import { upsertShopifyCustomer } from '@line-crm/db';
import { getShopifyAccessToken } from './shopify-token.js';

export async function syncShopifyCustomers(
  db: D1Database,
  env: Record<string, string | undefined>,
): Promise<{ synced: number; error?: string }> {
  const storeDomain = env.SHOPIFY_STORE_DOMAIN;
  if (!storeDomain) {
    return { synced: 0, error: 'SHOPIFY_STORE_DOMAIN not configured' };
  }

  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(storeDomain)) {
    return { synced: 0, error: 'Invalid SHOPIFY_STORE_DOMAIN format' };
  }

  try {
    const accessToken = await getShopifyAccessToken(db, env);
    const apiVersion = '2025-07';
    const headers = {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    };

    const res = await fetch(
      `https://${storeDomain}/admin/api/${apiVersion}/customers.json?limit=250`,
      { headers },
    );

    if (!res.ok) {
      return { synced: 0, error: `Shopify Customers API returned ${res.status}` };
    }

    const data = (await res.json()) as {
      customers: Array<Record<string, unknown>>;
    };
    const customers = data.customers ?? [];

    let synced = 0;
    for (const cust of customers) {
      await upsertShopifyCustomer(db, {
        shopifyCustomerId: String(cust.id),
        email: (cust.email as string) ?? undefined,
        phone: (cust.phone as string) ?? undefined,
        firstName: (cust.first_name as string) ?? undefined,
        lastName: (cust.last_name as string) ?? undefined,
        ordersCount: cust.orders_count ? Number(cust.orders_count) : undefined,
        totalSpent: cust.total_spent ? Number(cust.total_spent) : undefined,
        tags: (cust.tags as string) ?? undefined,
        metadata: JSON.stringify({ source: 'cron_sync' }),
      });
      synced++;
    }

    return { synced };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { synced: 0, error: msg };
  }
}
