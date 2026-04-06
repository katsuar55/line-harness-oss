import type { Context, Next } from 'hono';
import type { Env } from '../index.js';
import { getFriendByLineUserId } from '@line-crm/db';

/**
 * LIFF ID Token 検証ミドルウェア
 *
 * LINE Login ID Token を LINE Platform で検証し、
 * 検証済み lineUserId を c.set('liffUser') にセットする。
 *
 * フロントエンドは liff.getIDToken() で取得した idToken を
 * リクエストボディに含める。
 */

interface LiffTokenPayload {
  iss: string;
  sub: string;    // LINE userId (verified)
  aud: string;
  exp: number;
  iat: number;
  name?: string;
  picture?: string;
  email?: string;
}

async function verifyLineIdToken(
  idToken: string,
  channelId: string,
): Promise<string | null> {
  try {
    const resp = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });

    if (!resp.ok) return null;

    const data = await resp.json<LiffTokenPayload>();
    return data.sub ?? null;
  } catch {
    return null;
  }
}

export async function liffAuthMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  const path = new URL(c.req.url).pathname;

  // Tips endpoint is public (no auth needed)
  if (path === '/api/liff/tips/today') {
    return next();
  }

  // Only apply to LIFF routes
  if (!path.startsWith('/api/liff/')) {
    return next();
  }

  try {
    const body = await c.req.json<{ idToken?: string; lineUserId?: string }>();

    // Try idToken first (secure path)
    if (body.idToken) {
      const channelId = c.env.LINE_LOGIN_CHANNEL_ID;
      if (!channelId) {
        return c.json({ success: false, error: 'LIFF auth not configured' }, 500);
      }

      const verifiedUserId = await verifyLineIdToken(body.idToken, channelId);
      if (!verifiedUserId) {
        return c.json({ success: false, error: 'Invalid or expired ID token' }, 401);
      }

      const friend = await getFriendByLineUserId(c.env.DB, verifiedUserId);
      if (!friend) {
        return c.json({ success: false, error: 'Friend not found' }, 404);
      }

      (c as { set: (key: string, value: unknown) => void }).set('liffUser', { lineUserId: verifiedUserId, friendId: friend.id });
      return next();
    }

    // Fallback: lineUserId directly (for development/testing only)
    // In production, LINE_LOGIN_CHANNEL_ID should always be set
    if (body.lineUserId) {
      const friend = await getFriendByLineUserId(c.env.DB, body.lineUserId);
      if (!friend) {
        return c.json({ success: false, error: 'Friend not found' }, 404);
      }

      (c as { set: (key: string, value: unknown) => void }).set('liffUser', { lineUserId: body.lineUserId, friendId: friend.id });
      return next();
    }

    return c.json({ success: false, error: 'idToken or lineUserId required' }, 401);
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
}
