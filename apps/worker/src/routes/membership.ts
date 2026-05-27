/**
 * Membership admin route (= Phase 4-η、 2026-05-28)
 *
 * 役割:
 *   - admin web `/membership` page から member + tier の可視化
 *   - GET /api/membership/stats   → 5 tier 分布 + total + 平均購入額
 *   - GET /api/membership/tiers   → membership_tiers 一覧 (= 5 seed)
 *   - GET /api/membership/members → members 一覧 (= ?tier=...&limit=...)
 *   - POST /api/membership/members/:friendId/promote → manual tier 強制設定 (= 商業判断)
 *
 * 設計:
 *   - 既存 listMembershipTiers + getMembershipStats + getMembersByTier query を使う (= MVP)
 *   - manual promote は audit_logs に必ず記録 (= 商業判断の trail)
 *   - 友だち 1 件 (= Katsu) MVP 段階のため、 paginate 簡略 (= 100 件 limit)
 */
import { Hono } from 'hono';
import {
  listMembershipTiers,
  getMembershipStats,
  getMembersByTier,
  getMemberByFriendId,
  getMembershipTierById,
  upsertMember,
  jstNow,
} from '@line-crm/db';
import type { Env } from '../index.js';

const membership = new Hono<Env>();

/**
 * GET /api/membership/stats
 *   response: { success: true, data: { totalMembers, byTier, tiers } }
 */
membership.get('/api/membership/stats', async (c) => {
  try {
    const [stats, tiers] = await Promise.all([
      getMembershipStats(c.env.DB),
      listMembershipTiers(c.env.DB, true),
    ]);
    return c.json({
      success: true,
      data: {
        totalMembers: stats.totalMembers,
        byTier: stats.byTier,
        tiers,
      },
    });
  } catch (err) {
    console.error(
      '[membership GET stats] failed',
      err instanceof Error ? err.message : 'unknown',
    );
    return c.json({ success: false, error: 'failed to fetch stats' }, 500);
  }
});

/** GET /api/membership/tiers — tier master 一覧 */
membership.get('/api/membership/tiers', async (c) => {
  try {
    const includeInactive = c.req.query('includeInactive') === 'true';
    const tiers = await listMembershipTiers(c.env.DB, includeInactive);
    return c.json({ success: true, data: tiers });
  } catch (err) {
    console.error(
      '[membership GET tiers] failed',
      err instanceof Error ? err.message : 'unknown',
    );
    return c.json({ success: false, error: 'failed to fetch tiers' }, 500);
  }
});

/**
 * GET /api/membership/members
 *   query: tier (= 'bronze' | ...) / limit / offset
 *   response: { success: true, data: { members: [...], total } }
 *
 * Note: friend display_name も JOIN で取得して返す (= admin UI で見やすく)
 */
membership.get('/api/membership/members', async (c) => {
  try {
    const tier = c.req.query('tier') || undefined;
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '100'), 1), 500);
    const offset = Math.max(Number(c.req.query('offset') ?? '0'), 0);

    const where = tier ? `WHERE m.current_tier_id = ?` : '';
    const params: unknown[] = tier ? [tier] : [];
    params.push(limit, offset);

    const result = await c.env.DB
      .prepare(
        `SELECT
           m.id,
           m.friend_id,
           m.current_tier_id,
           m.total_purchase_jpy,
           m.total_referral_count,
           m.last_purchase_at,
           m.last_promotion_at,
           m.joined_at,
           f.display_name,
           f.line_user_id
         FROM members m
         LEFT JOIN friends f ON m.friend_id = f.id
         ${where}
         ORDER BY m.total_purchase_jpy DESC, m.joined_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...params)
      .all<Record<string, unknown>>();

    const totalRow = tier
      ? await c.env.DB
          .prepare(`SELECT COUNT(*) AS n FROM members WHERE current_tier_id = ?`)
          .bind(tier)
          .first<{ n: number }>()
      : await c.env.DB
          .prepare(`SELECT COUNT(*) AS n FROM members`)
          .first<{ n: number }>();

    return c.json({
      success: true,
      data: {
        members: result.results ?? [],
        total: totalRow?.n ?? 0,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error(
      '[membership GET members] failed',
      err instanceof Error ? err.message : 'unknown',
    );
    return c.json({ success: false, error: 'failed to fetch members' }, 500);
  }
});

/**
 * POST /api/membership/members/:friendId/promote
 *   body: { toTierId: string, reason?: string }
 *   response: { success: true, data: { fromTier, toTier, promoted: boolean } }
 *
 * 用途: 商業判断で manual に tier を強制設定 (= 例: VIP customer 即 platinum)
 *   - 自然昇格 (= 購入累計達成) とは別 path
 *   - audit_logs に必ず記録 (= 商業判断 trail)
 *   - 降格も技術的には可能だが、 通常 reason 必須運用
 */
membership.post('/api/membership/members/:friendId/promote', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const body = await c.req.json<{ toTierId: string; reason?: string }>();
    if (!body.toTierId) {
      return c.json({ success: false, error: 'toTierId required' }, 400);
    }

    const targetTier = await getMembershipTierById(c.env.DB, body.toTierId);
    if (!targetTier) {
      return c.json({ success: false, error: 'tier not found' }, 404);
    }

    const member = await getMemberByFriendId(c.env.DB, friendId);
    if (!member) {
      return c.json({ success: false, error: 'member not found' }, 404);
    }

    const fromTier = member.currentTierId;
    if (fromTier === body.toTierId) {
      return c.json({
        success: true,
        data: { fromTier, toTier: body.toTierId, promoted: false, reason: 'already in tier' },
      });
    }

    await upsertMember(c.env.DB, {
      friendId,
      currentTierId: body.toTierId,
    });

    // last_promotion_at + audit
    const now = jstNow();
    await c.env.DB
      .prepare(`UPDATE members SET last_promotion_at = ?, updated_at = ? WHERE friend_id = ?`)
      .bind(now, now, friendId)
      .run();

    try {
      await c.env.DB
        .prepare(
          `INSERT INTO audit_logs (
             id, line_account_id, actor_type, actor_id, action,
             target_type, target_id, before_value, after_value, result, metadata, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          null,
          'admin',
          c.req.header('x-admin-actor') ?? null,
          'membership.manual_promote',
          'member',
          friendId,
          JSON.stringify({ tierId: fromTier }),
          JSON.stringify({ tierId: body.toTierId }),
          'success',
          JSON.stringify({ reason: body.reason ?? null, tierName: targetTier.name }),
          now,
        )
        .run();
    } catch (auditErr) {
      console.error(
        '[membership manual_promote] audit log failed',
        auditErr instanceof Error ? auditErr.message : 'unknown',
      );
    }

    return c.json({
      success: true,
      data: { fromTier, toTier: body.toTierId, promoted: true, reason: body.reason ?? null },
    });
  } catch (err) {
    console.error(
      '[membership POST promote] failed',
      err instanceof Error ? err.message : 'unknown',
    );
    return c.json({ success: false, error: 'failed to promote' }, 500);
  }
});

export { membership };
