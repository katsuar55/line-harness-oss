/**
 * Google Analytics 4 連携サービス
 *
 * - GA4 Measurement Protocol でサーバーサイドイベント送信
 * - UTMパラメータ付きリンク生成
 * - LINEイベント→GA4イベントマッピング
 */

import {
  getAnalyticsSettings,
  logAnalyticsEvent,
} from '@line-crm/db';

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

// ─── GA4 Measurement Protocol ─────────────────────────────────

interface GA4Event {
  name: string;
  params?: Record<string, string | number | boolean>;
}

/**
 * Send event to GA4 via Measurement Protocol
 */
export async function sendGA4Event(
  db: D1Database,
  opts: {
    friendId?: string;
    clientId: string; // GA4 client_id — use friend.id or LINE userId
    events: GA4Event[];
    lineAccountId?: string;
  },
): Promise<void> {
  const settings = await getAnalyticsSettings(db, opts.lineAccountId);
  const ga4 = settings.find(
    (s) => s.provider === 'ga4' && s.enabled && s.measurement_id && s.api_secret,
  );

  if (!ga4) return;

  const measurementId = ga4.measurement_id as string;
  const apiSecret = ga4.api_secret as string;

  const url = `${GA4_ENDPOINT}?measurement_id=${measurementId}&api_secret=${apiSecret}`;

  const payload = {
    client_id: opts.clientId,
    events: opts.events.map((e) => ({
      name: e.name,
      params: {
        ...e.params,
        engagement_time_msec: '100',
      },
    })),
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    await logAnalyticsEvent(db, {
      friendId: opts.friendId,
      eventName: opts.events.map((e) => e.name).join(','),
      eventParams: JSON.stringify(payload),
      measurementId,
      status: res.ok ? 'sent' : 'failed',
      errorMessage: res.ok ? undefined : `HTTP ${res.status}`,
    });
  } catch (err) {
    await logAnalyticsEvent(db, {
      friendId: opts.friendId,
      eventName: opts.events.map((e) => e.name).join(','),
      eventParams: JSON.stringify(payload),
      measurementId,
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}

// ─── LINE Event → GA4 Event Mapping ──────────────────────────

/**
 * Send GA4 event for LINE friend add
 */
export async function trackFriendAdd(
  db: D1Database,
  friendId: string,
  clientId: string,
  source?: string,
): Promise<void> {
  await sendGA4Event(db, {
    friendId,
    clientId,
    events: [
      {
        name: 'line_friend_add',
        params: {
          source: source ?? 'direct',
          method: 'line',
        },
      },
    ],
  });
}

/**
 * Send GA4 event for message sent to user
 */
export async function trackMessageSent(
  db: D1Database,
  friendId: string,
  clientId: string,
  messageType: string,
  campaignName?: string,
): Promise<void> {
  await sendGA4Event(db, {
    friendId,
    clientId,
    events: [
      {
        name: 'line_message_sent',
        params: {
          message_type: messageType,
          campaign_name: campaignName ?? '',
        },
      },
    ],
  });
}

/**
 * Send GA4 event for link click (tracking link)
 */
export async function trackLinkClick(
  db: D1Database,
  friendId: string,
  clientId: string,
  url: string,
  linkName?: string,
): Promise<void> {
  await sendGA4Event(db, {
    friendId,
    clientId,
    events: [
      {
        name: 'line_link_click',
        params: {
          link_url: url,
          link_name: linkName ?? '',
        },
      },
    ],
  });
}

/**
 * Send GA4 purchase event (synced from Shopify)
 */
export async function trackPurchase(
  db: D1Database,
  friendId: string,
  clientId: string,
  value: number,
  currency: string,
  transactionId: string,
): Promise<void> {
  await sendGA4Event(db, {
    friendId,
    clientId,
    events: [
      {
        name: 'purchase',
        params: {
          value,
          currency,
          transaction_id: transactionId,
        },
      },
    ],
  });
}

// ─── UTM Link Builder ────────────────────────────────────────

interface UtmParams {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
}

/**
 * Append UTM parameters to a URL
 */
export function buildUtmUrl(baseUrl: string, utm: UtmParams): string {
  try {
    const url = new URL(baseUrl);
    if (utm.source) url.searchParams.set('utm_source', utm.source);
    if (utm.medium) url.searchParams.set('utm_medium', utm.medium);
    if (utm.campaign) url.searchParams.set('utm_campaign', utm.campaign);
    if (utm.content) url.searchParams.set('utm_content', utm.content);
    if (utm.term) url.searchParams.set('utm_term', utm.term);
    return url.toString();
  } catch {
    // If URL is invalid, append as query string
    const params = new URLSearchParams();
    if (utm.source) params.set('utm_source', utm.source);
    if (utm.medium) params.set('utm_medium', utm.medium);
    if (utm.campaign) params.set('utm_campaign', utm.campaign);
    if (utm.content) params.set('utm_content', utm.content);
    if (utm.term) params.set('utm_term', utm.term);
    const qs = params.toString();
    return qs ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${qs}` : baseUrl;
  }
}

/**
 * Build UTM URL with LINE defaults
 */
export function buildLineUtmUrl(
  baseUrl: string,
  opts?: {
    campaign?: string;
    content?: string;
    term?: string;
  },
): string {
  return buildUtmUrl(baseUrl, {
    source: 'line',
    medium: 'message',
    campaign: opts?.campaign,
    content: opts?.content,
    term: opts?.term,
  });
}
