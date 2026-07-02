/**
 * friends プロフィール補完の管理 API — 第2波-③ 支援 (2026-07-02)
 *
 * POST /api/admin/friends/refresh-profiles { limit? }
 *   display_name 未設定の friend (カットオーバー import 由来) に LINE profile API で
 *   表示名/アイコン/ステータスメッセージを補完する。 remaining が 0 になるまで繰り返し
 *   呼ぶ運用 (詳細設計は services/friend-profile-refresh.ts)。
 *
 * subrequest 予算: friend ごとに LINE fetch 1 + 選定/COUNT 2 + db.batch 1。
 * limit 上限 30 で最悪 ~34 subrequests に収める。
 *
 * 認証: /api/* は authMiddleware (API_KEY bearer) 配下。
 */

import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';
import { refreshMissingFriendProfiles } from '../services/friend-profile-refresh.js';

const MAX_LIMIT = 30;
const DEFAULT_LIMIT = 20;

const friendsProfileAdmin = new Hono<Env>();

friendsProfileAdmin.post('/api/admin/friends/refresh-profiles', async (c) => {
  try {
    // JSON literal null は .catch を通らず parse 成功する → null ガード必須 (review LOW)
    const body = (await c.req
      .json<{ limit?: unknown } | null>()
      .catch(() => null)) ?? {};
    const limitRaw =
      typeof body === 'object' && typeof (body as { limit?: unknown }).limit === 'number'
        ? Math.floor((body as { limit: number }).limit)
        : DEFAULT_LIMIT;
    const limit = Math.min(Math.max(limitRaw, 1), MAX_LIMIT);

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const result = await refreshMissingFriendProfiles(
      c.env.DB,
      { getProfileImpl: (userId) => lineClient.getProfile(userId) },
      { limit },
    );

    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/admin/friends/refresh-profiles error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { friendsProfileAdmin };
