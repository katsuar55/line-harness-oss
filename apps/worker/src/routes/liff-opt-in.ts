/**
 * LIFF Email Opt-In Route (Phase 5β-1)
 *
 * 役割:
 *   - POST /api/liff/opt-in — LINE 友だちが LIFF 経由で email + marketing 同意を登録する
 *
 * 認証:
 *   - liffAuthMiddleware で LINE idToken 検証済 (c.get('liffUser') から friendId 取得)
 *
 * 動線:
 *   1. LINE 友だちに opt-in 募集 message を送信 (CTA: LIFF ボタン)
 *   2. 友だちが LIFF を開く → email 入力 + 同意 checkbox
 *   3. POST /api/liff/opt-in → email_subscribers に登録
 *   4. LIFF 側で「登録完了」 を表示 (5β-1e: クーポン提供なし、 商業判断 — LINE 友だち追加経路の
 *      クーポンは別 system = Welcome シナリオ等で実装)
 *
 * 関連: services/email-opt-in.ts、 routes/email-opt-in.ts
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { performEmailOptIn } from '../services/email-opt-in.js';
import { auditSystem } from '../services/audit-logger.js';
import type { Env } from '../index.js';

const liffOptIn = new Hono<Env>();

// ============================================================
// Helpers
// ============================================================

function getLiffUser(c: { get: (key: string) => unknown }) {
  return c.get('liffUser') as { lineUserId: string; friendId: string } | undefined;
}

const RequestSchema = z.object({
  email: z.string().email().max(254),
  marketingConsent: z.boolean(),
});

// ============================================================
// POST /api/liff/opt-in
// ============================================================

liffOptIn.post('/api/liff/opt-in', async (c) => {
  const user = getLiffUser(c);
  if (!user) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }

  const email = parsed.data.email.trim();

  if (!parsed.data.marketingConsent) {
    return c.json(
      { success: false, error: 'marketingConsent must be true to opt in' },
      400,
    );
  }

  try {
    const result = await performEmailOptIn(c.env.DB, {
      email,
      friendId: user.friendId,
      channel: 'liff',
      consentSource: 'opt_in_form',
    });

    await auditSystem(c.env.DB, {
      action: 'email.opt_in',
      actorType: 'api',
      targetType: 'email_subscriber',
      targetId: result.subscriberId,
      metadata: {
        channel: 'liff',
        friend_id: user.friendId,
        outcome: result.outcome,
        had_complaint: result.hadComplaint,
      },
    });

    return c.json({
      success: true,
      data: {
        subscriberId: result.subscriberId,
        email: result.email,
        outcome: result.outcome,
      },
    });
  } catch (err) {
    console.warn('[liff-opt-in] performEmailOptIn failed:', err instanceof Error ? err.message : String(err));
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

export { liffOptIn };
