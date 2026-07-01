/**
 * アカウント連携 (LINE friend ↔ Shopify customer) の管理 API — 第2波-③ 支援 (2026-07-01)
 *
 * GET  /api/admin/account-link/stats
 *   連携の現況サマリ (read-only)。 移行前 friends のうち 連携済 / メール判明 / 一括連携候補 /
 *   会員ランク履歴反映済 の人数を可視化し、 会員ランク復元のカバレッジを数字で確定する。
 *
 * POST /api/admin/account-link/import-dmm (2026-07-02)
 *   DMM チャットブースト CSV (LINE表示名+メール+ランク) からの一括連携。 **dryRun 既定 true**、
 *   明示的に dryRun:false のときのみ friends.shopify_customer_id を書込。 照合設計 (曖昧一致は
 *   自動連携しない・冪等) は services/dmm-rank-import.ts のコメント参照。
 *
 * POST /api/admin/account-link/backfill-linked (2026-07-02)
 *   連携済みで購入履歴未反映の friend に過去注文 backfill を実行 (少数バッチ・冪等)。
 *   MEMBER_BACKFILL_ENABLED='true' でなければ gated 応答で no-op (money path gate は
 *   backfill 側と二重)。 Workers subrequest 上限対策で 1 呼び出し最大 10 人 (既定 3)。
 *   remaining が 0 になるまで繰り返し呼ぶ運用。
 *
 * 認証: /api/* は authMiddleware (API_KEY bearer) 配下。
 */

import { Hono } from 'hono';
import { getAccountLinkStats } from '@line-crm/db';
import type { Env } from '../index.js';
import { processDmmRankImport, type DmmImportEntry } from '../services/dmm-rank-import.js';
import { backfillCustomerOrders } from '../services/member-purchase-backfill.js';
import { getShopifyAccessToken } from '../services/shopify-token.js';

const MAX_IMPORT_ENTRIES = 50;
const MAX_BACKFILL_PER_CALL = 10;
const DEFAULT_BACKFILL_PER_CALL = 3;

const accountLinkAdmin = new Hono<Env>();

accountLinkAdmin.get('/api/admin/account-link/stats', async (c) => {
  try {
    const stats = await getAccountLinkStats(c.env.DB);
    return c.json({ success: true, data: stats });
  } catch (err) {
    console.error('GET /api/admin/account-link/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== POST /api/admin/account-link/import-dmm ==========

accountLinkAdmin.post('/api/admin/account-link/import-dmm', async (c) => {
  try {
    const body = await c.req
      .json<{ dryRun?: unknown; entries?: unknown }>()
      .catch(() => null);
    if (!body || !Array.isArray(body.entries)) {
      return c.json({ success: false, error: 'entries (array) is required' }, 400);
    }
    if (body.entries.length === 0 || body.entries.length > MAX_IMPORT_ENTRIES) {
      return c.json(
        { success: false, error: `entries must contain 1-${MAX_IMPORT_ENTRIES} items (got ${body.entries.length})` },
        400,
      );
    }
    // 安全側デフォルト: dryRun は明示的に false を渡したときのみ書込
    const dryRun = body.dryRun !== false;

    const outcome = await processDmmRankImport(c.env.DB, body.entries as DmmImportEntry[], { dryRun });
    return c.json({ success: true, data: outcome });
  } catch (err) {
    console.error('POST /api/admin/account-link/import-dmm error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== POST /api/admin/account-link/backfill-linked ==========

interface LinkedFriendRow {
  id: string;
  shopify_customer_id: string;
}

/**
 * 連携済みだが購入履歴 (applied 済 purchase event) が 1 件も無く、 かつ backfill 成功実績も無い
 * friend = backfill 待ち。
 * 2 つ目の NOT EXISTS が無いと「window 内注文 0 件の friend」が毎回再選択され auto モードが
 * 収束しない (成功 backfill は 0 件でも 'loyalty_purchase_backfill.completed' success を audit する)。
 * audit は best-effort なので書込失敗時は再試行されるが、 backfill 自体が冪等なので無害。
 */
const PENDING_PREDICATE = `
  FROM friends f
 WHERE f.shopify_customer_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM member_purchase_events e
      WHERE e.friend_id = f.id AND e.applied_at IS NOT NULL
   )
   AND NOT EXISTS (
     SELECT 1 FROM audit_logs a
      WHERE a.action = 'loyalty_purchase_backfill.completed'
        AND a.target_type = 'friend' AND a.target_id = f.id AND a.result = 'success'
   )`;

accountLinkAdmin.post('/api/admin/account-link/backfill-linked', async (c) => {
  try {
    const envRecord = c.env as unknown as Record<string, string | undefined>;
    if (envRecord.MEMBER_BACKFILL_ENABLED !== 'true') {
      return c.json({
        success: true,
        data: {
          gated: true,
          message: 'MEMBER_BACKFILL_ENABLED is not true — no-op (money path gate)',
        },
      });
    }

    const body = await c.req
      .json<{ limit?: unknown; friendIds?: unknown }>()
      .catch(() => ({} as { limit?: unknown; friendIds?: unknown }));
    const limitRaw = typeof body.limit === 'number' ? Math.floor(body.limit) : DEFAULT_BACKFILL_PER_CALL;
    const limit = Math.min(Math.max(limitRaw, 1), MAX_BACKFILL_PER_CALL);

    const db = c.env.DB;

    // 対象選定: friendIds 指定があればそれ (連携済のみ)、 無ければ backfill 待ちから limit 件
    let targets: LinkedFriendRow[];
    if (Array.isArray(body.friendIds) && body.friendIds.length > 0) {
      const ids = body.friendIds.filter((v): v is string => typeof v === 'string').slice(0, MAX_BACKFILL_PER_CALL);
      if (ids.length === 0) {
        return c.json({ success: false, error: 'friendIds must be an array of strings' }, 400);
      }
      const placeholders = ids.map(() => '?').join(',');
      const res = await db
        .prepare(
          `SELECT id, shopify_customer_id FROM friends
            WHERE id IN (${placeholders}) AND shopify_customer_id IS NOT NULL`,
        )
        .bind(...ids)
        .all<LinkedFriendRow>();
      targets = res.results ?? [];
    } else {
      const res = await db
        .prepare(`SELECT f.id, f.shopify_customer_id ${PENDING_PREDICATE} ORDER BY f.updated_at DESC LIMIT ?`)
        .bind(limit)
        .all<LinkedFriendRow>();
      targets = res.results ?? [];
    }

    const pendingRow = await db
      .prepare(`SELECT COUNT(*) AS n ${PENDING_PREDICATE}`)
      .first<{ n: number }>();
    const pendingBefore = pendingRow?.n ?? 0;

    if (targets.length === 0) {
      return c.json({ success: true, data: { processed: [], pendingBefore, remaining: pendingBefore } });
    }

    let accessToken: string;
    try {
      accessToken = await getShopifyAccessToken(db, envRecord);
    } catch (err) {
      console.error('backfill-linked: shopify token unavailable:', err);
      return c.json({ success: false, error: 'Shopify access token unavailable' }, 502);
    }

    const processed: Array<{
      friendId: string;
      customerId: string;
      skipped: boolean;
      reason?: string;
      backfilled: number;
      alreadyApplied: number;
      totalJpy: number;
      errors: number;
      capped: boolean;
    }> = [];

    for (const t of targets) {
      try {
        const r = await backfillCustomerOrders(
          db,
          {
            SHOPIFY_STORE_DOMAIN: envRecord.SHOPIFY_STORE_DOMAIN,
            MEMBER_BACKFILL_ENABLED: envRecord.MEMBER_BACKFILL_ENABLED,
          },
          { customerId: String(t.shopify_customer_id), friendId: t.id, accessToken },
        );
        processed.push({
          friendId: t.id,
          customerId: String(t.shopify_customer_id),
          skipped: r.skipped,
          reason: r.reason,
          backfilled: r.backfilled,
          alreadyApplied: r.alreadyApplied,
          totalJpy: r.totalJpy,
          errors: r.errors,
          capped: r.capped,
        });
      } catch (err) {
        console.error(`backfill-linked: friend ${t.id} failed:`, err);
        processed.push({
          friendId: t.id,
          customerId: String(t.shopify_customer_id),
          skipped: true,
          reason: err instanceof Error ? err.message : 'unknown error',
          backfilled: 0,
          alreadyApplied: 0,
          totalJpy: 0,
          errors: 1,
          capped: false,
        });
      }
    }

    // skipped=false = backfill 完走 (0 件でも success audit が書かれ pending から抜ける)
    const succeeded = processed.filter((p) => !p.skipped).length;
    const remaining = Math.max(pendingBefore - succeeded, 0);

    return c.json({ success: true, data: { processed, pendingBefore, remaining } });
  } catch (err) {
    console.error('POST /api/admin/account-link/backfill-linked error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { accountLinkAdmin };
