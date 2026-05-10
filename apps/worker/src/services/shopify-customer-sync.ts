/**
 * Shopify 顧客一括同期サービス
 * Cron トリガー (5 分毎) または手動 API から呼び出し可能。
 *
 * 2026-05-10 enrichment:
 *  - paging 対応 (Link header の rel="next" を辿る、 max 50 page = 12,500 件)
 *  - metadata に email_marketing_consent / sms_marketing_consent / accepts_marketing 等を保存
 *  - return に opt-in 状態別 (subscribed / not_subscribed / pending / unsubscribed) の集計を追加
 *  → 後段の email_subscribers seed では SQL `json_extract(metadata, '$.email_marketing_consent.state')`
 *    で opt-in 同意者を抽出可能になる。
 */
import { upsertShopifyCustomer } from '@line-crm/db';
import { getShopifyAccessToken } from './shopify-token.js';

const PAGE_LIMIT = 250;
const MAX_PAGES = 50; // 50 page × 250 件 = 12,500 件まで同期 (Workers CPU 上限を考慮)

export interface SyncShopifyCustomersResult {
  synced: number;
  subscribed: number;
  notSubscribed: number;
  pending: number;
  unsubscribed: number;
  pages: number;
  error?: string;
}

/**
 * Shopify REST API の Link header から rel="next" の URL を抽出する。
 * Format: `<URL>; rel="next"` または `<URL>; rel="previous", <URL>; rel="next"` 等の組合せ。
 */
export function parseNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

export async function syncShopifyCustomers(
  db: D1Database,
  env: Record<string, string | undefined>,
): Promise<SyncShopifyCustomersResult> {
  const counts: SyncShopifyCustomersResult = {
    synced: 0,
    subscribed: 0,
    notSubscribed: 0,
    pending: 0,
    unsubscribed: 0,
    pages: 0,
  };

  const storeDomain = env.SHOPIFY_STORE_DOMAIN;
  if (!storeDomain) {
    return { ...counts, error: 'SHOPIFY_STORE_DOMAIN not configured' };
  }

  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(storeDomain)) {
    return { ...counts, error: 'Invalid SHOPIFY_STORE_DOMAIN format' };
  }

  try {
    const accessToken = await getShopifyAccessToken(db, env);
    const apiVersion = '2025-07';
    const headers = {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    };

    let url: string | null =
      `https://${storeDomain}/admin/api/${apiVersion}/customers.json?limit=${PAGE_LIMIT}`;

    while (url && counts.pages < MAX_PAGES) {
      const res = await fetch(url, { headers });

      if (!res.ok) {
        return {
          ...counts,
          error: `Shopify Customers API returned ${res.status} on page ${counts.pages + 1}`,
        };
      }

      const data = (await res.json()) as {
        customers: Array<Record<string, unknown>>;
      };
      const customers = data.customers ?? [];

      for (const cust of customers) {
        // email_marketing_consent.state を opt-in 集計用に抽出
        const emailConsent = cust.email_marketing_consent as
          | { state?: string; opt_in_level?: string; consent_updated_at?: string }
          | null
          | undefined;
        const state = emailConsent?.state ?? null;
        if (state === 'subscribed') counts.subscribed++;
        else if (state === 'not_subscribed') counts.notSubscribed++;
        else if (state === 'pending') counts.pending++;
        else if (state === 'unsubscribed') counts.unsubscribed++;

        // metadata に opt-in / 関連同意情報を保存
        // (Round 4 email_subscribers seed の SQL JSON_EXTRACT で使用)
        const enrichedMetadata = {
          source: 'cron_sync',
          sync_at: new Date().toISOString(),
          email_marketing_consent: emailConsent ?? null,
          sms_marketing_consent: cust.sms_marketing_consent ?? null,
          accepts_marketing: cust.accepts_marketing ?? null,
          accepts_marketing_updated_at: cust.accepts_marketing_updated_at ?? null,
          marketing_opt_in_level: cust.marketing_opt_in_level ?? null,
        };

        await upsertShopifyCustomer(db, {
          shopifyCustomerId: String(cust.id),
          email: (cust.email as string) ?? undefined,
          phone: (cust.phone as string) ?? undefined,
          firstName: (cust.first_name as string) ?? undefined,
          lastName: (cust.last_name as string) ?? undefined,
          ordersCount: cust.orders_count ? Number(cust.orders_count) : undefined,
          totalSpent: cust.total_spent ? Number(cust.total_spent) : undefined,
          tags: (cust.tags as string) ?? undefined,
          metadata: JSON.stringify(enrichedMetadata),
        });
        counts.synced++;
      }

      counts.pages++;
      const linkHeader = res.headers.get('Link') ?? res.headers.get('link');
      url = parseNextUrl(linkHeader);
    }

    return counts;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { ...counts, error: msg };
  }
}
