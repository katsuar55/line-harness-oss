/**
 * Phase 5α-7: ブロック復活施策 (block recovery) API route
 *
 * GET /api/ban-recovery?lineAccountId=xxx&days=30&limit=50
 *   → 統計 + 直近復活した友だち + 現在ブロック中の友だちを返す
 *
 * 認証: authMiddleware (API_KEY ベアラー) で保護される (index.ts でマウント済の前提)
 */

import { Hono } from 'hono';
import {
  getBanRecoveryStats,
  getRecentlyRecoveredFriends,
  getCurrentlyBlockedFriends,
} from '@line-crm/db';
import type { Env } from '../index.js';

const banRecovery = new Hono<Env>();

function clampPositiveInt(value: string | undefined, defaultValue: number, max: number): number {
  if (!value) return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(n, max);
}

banRecovery.get('/api/ban-recovery', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId') || undefined;
    const days = clampPositiveInt(c.req.query('days'), 30, 365);
    const limit = clampPositiveInt(c.req.query('limit'), 50, 200);

    const [stats, recoveredRows, blockedRows] = await Promise.all([
      getBanRecoveryStats(c.env.DB, lineAccountId, days),
      getRecentlyRecoveredFriends(c.env.DB, lineAccountId, limit),
      getCurrentlyBlockedFriends(c.env.DB, lineAccountId, limit),
    ]);

    return c.json({
      success: true,
      data: {
        stats,
        params: { lineAccountId: lineAccountId ?? null, days, limit },
        recentlyRecovered: recoveredRows.map((r) => ({
          friendId: r.id,
          lineUserId: r.line_user_id,
          displayName: r.display_name,
          pictureUrl: r.picture_url,
          lastUnfollowedAt: r.last_unfollowed_at,
          lastRefollowedAt: r.last_refollowed_at,
          unfollowCount: r.unfollow_count,
        })),
        currentlyBlocked: blockedRows.map((r) => ({
          friendId: r.id,
          lineUserId: r.line_user_id,
          displayName: r.display_name,
          pictureUrl: r.picture_url,
          lastUnfollowedAt: r.last_unfollowed_at,
          unfollowCount: r.unfollow_count,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/ban-recovery error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { banRecovery };
