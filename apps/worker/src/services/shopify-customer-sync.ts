/**
 * Shopify 顧客一括同期サービス
 * Cron トリガー (5 分毎) から呼び出される。
 *
 * 2026-05-10 enrichment:
 *  - paging 対応 (Link header の rel="next" を辿る、 max 50 page = 12,500 件)
 *  - metadata に email_marketing_consent / sms_marketing_consent / accepts_marketing 等を保存
 *  - return に opt-in 状態別 (subscribed / not_subscribed / pending / unsubscribed) の集計を追加
 *  → 後段の email_subscribers seed では SQL `json_extract(metadata, '$.email_marketing_consent.state')`
 *    で opt-in 同意者を抽出可能になる。
 *
 * 2026-08-11 incremental 化 (cron silence 調査の再発防止):
 *  - 旧実装は毎 tick 全顧客フル同期 × 顧客毎 3 D1 round-trip で、1 invocation の途中で
 *    D1 接続断が起きて完走できず、cron_run_logs の全行に error が残る状態だった
 *    (heartbeat 書き込み自体も落ちた tick は行が残らない = silence 警告の原因)。
 *  - 前回クリーン成功 (cron_run_logs の status='success' かつ新形式 metrics) の ran_at を
 *    watermark に `updated_at_min` で差分同期する。partial (エラー付き完走) は watermark を
 *    進めないので、失敗した窓は次 tick で再カバーされる。
 *  - 旧形式 metrics (mode field 無し) は「どこまでカバー済みか信用できない」ためフル同期に倒す。
 *  - upsert はページ (250 件) 単位の db.batch() (batchUpsertShopifyCustomers)。
 */
import {
  batchUpsertShopifyCustomers,
  getLastSuccessfulRun,
  type BatchUpsertShopifyCustomerInput,
} from '@line-crm/db';
import { getShopifyAccessToken } from './shopify-token.js';

const PAGE_LIMIT = 250;
const MAX_PAGES = 50; // 50 page × 250 件 = 12,500 件まで同期 (Workers CPU 上限を考慮)

export const SYNC_JOB_NAME = 'shopify-customer-sync';

/**
 * watermark に持たせる重なり幅。ran_at は「実行完了時刻」なので、実行中に更新された
 * 顧客・cron の遅延・Shopify 側の反映遅延をこの幅で吸収する (重複 upsert は冪等)。
 */
const WATERMARK_OVERLAP_MS = 15 * 60 * 1000;

export type SyncMode = 'full' | 'incremental';

export interface SyncShopifyCustomersResult {
  synced: number;
  subscribed: number;
  notSubscribed: number;
  pending: number;
  unsubscribed: number;
  pages: number;
  mode: SyncMode;
  /** updated_at_min に使った ISO 時刻 (full sync では null) */
  updatedAtMin: string | null;
  /** SHOPIFY_STORE_DOMAIN 未設定など、実処理に入らなかった場合 true (heartbeat は skipped) */
  skipped?: boolean;
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

/**
 * 値を有限数 (finite) に正規化する。 null/undefined/空文字/非数値文字列/NaN/±Infinity は
 * `undefined` を返す。 Shopify の total_spent / orders_count が想定外値でも DB に NaN を
 * 書き込まないための guard (= 既存の `x ? Number(x) : undefined` は "abc" 等の truthy 非数値で
 * NaN を通してしまう穴があった)。
 */
export function toFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 直近のクリーン成功 run から updated_at_min の watermark (UTC ISO) を導出する。
 *
 * null (= フル同期に倒す) になる条件:
 *  - 成功 run が無い / metrics が無い・parse 不能
 *  - metrics に mode field が無い (2026-08-11 以前の旧形式。error 付きでも status='success' で
 *    記録されていた時期の行はカバレッジを信用できない)
 *  - ran_at が日時として解釈できない
 */
export function resolveWatermark(
  lastSuccess: { ran_at: string; metrics_json: string | null } | null,
): string | null {
  if (!lastSuccess?.metrics_json) return null;
  let metrics: { mode?: unknown };
  try {
    metrics = JSON.parse(lastSuccess.metrics_json) as { mode?: unknown };
  } catch {
    return null;
  }
  if (metrics.mode !== 'full' && metrics.mode !== 'incremental') return null;
  const lastRanAt = new Date(lastSuccess.ran_at).getTime();
  if (!Number.isFinite(lastRanAt)) return null;
  return new Date(lastRanAt - WATERMARK_OVERLAP_MS).toISOString();
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
    mode: 'full',
    updatedAtMin: null,
  };

  const storeDomain = env.SHOPIFY_STORE_DOMAIN;
  if (!storeDomain) {
    return { ...counts, skipped: true, error: 'SHOPIFY_STORE_DOMAIN not configured' };
  }

  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(storeDomain)) {
    return { ...counts, skipped: true, error: 'Invalid SHOPIFY_STORE_DOMAIN format' };
  }

  // watermark 取得の失敗はフル同期に倒す (安全側 = 取りこぼさない)
  try {
    counts.updatedAtMin = resolveWatermark(await getLastSuccessfulRun(db, SYNC_JOB_NAME));
  } catch {
    counts.updatedAtMin = null;
  }
  if (counts.updatedAtMin) counts.mode = 'incremental';

  try {
    const accessToken = await getShopifyAccessToken(db, env);
    const apiVersion = '2025-07';
    const headers = {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    };

    let url: string | null =
      `https://${storeDomain}/admin/api/${apiVersion}/customers.json?limit=${PAGE_LIMIT}` +
      (counts.updatedAtMin
        ? `&updated_at_min=${encodeURIComponent(counts.updatedAtMin)}`
        : '');

    while (url && counts.pages < MAX_PAGES) {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });

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
      const upsertRows: BatchUpsertShopifyCustomerInput[] = [];

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

        upsertRows.push({
          shopifyCustomerId: String(cust.id),
          email: (cust.email as string) ?? undefined,
          phone: (cust.phone as string) ?? undefined,
          firstName: (cust.first_name as string) ?? undefined,
          lastName: (cust.last_name as string) ?? undefined,
          ordersCount: toFiniteNumber(cust.orders_count),
          totalSpent: toFiniteNumber(cust.total_spent),
          tags: (cust.tags as string) ?? undefined,
          metadata: JSON.stringify(enrichedMetadata),
        });
      }

      // ページ単位で 1 D1 round-trip (旧: 顧客毎に 3 round-trip で途中接続断が頻発)
      await batchUpsertShopifyCustomers(db, upsertRows);
      counts.synced += upsertRows.length;

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
