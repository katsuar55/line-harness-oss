/**
 * アカウント連携 (LINE friend ↔ Shopify customer) の管理 API — 第2波-③ 支援 (2026-07-01)
 *
 * GET /api/admin/account-link/stats
 *   連携の現況サマリ (read-only)。 移行前 friends のうち 連携済 / メール判明 / 一括連携候補 /
 *   会員ランク履歴反映済 の人数を可視化し、 会員ランク復元のカバレッジを数字で確定する。
 *
 * 認証: /api/* は authMiddleware (API_KEY bearer) 配下。
 * 副作用: なし (純 read-only)。 実際の一括連携 (mutation) は別 PR の endpoint で dry-run 既定にする。
 */

import { Hono } from 'hono';
import { getAccountLinkStats } from '@line-crm/db';
import type { Env } from '../index.js';

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

export { accountLinkAdmin };
