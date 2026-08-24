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

export async function verifyLineIdToken(
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
    // Authorization ヘッダーからIDトークンを取得（GET リクエスト対応）
    const authHeader = c.req.header('Authorization');
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // POST はボディから、GET は Authorization ヘッダーから取得
    let bodyToken: string | undefined;
    let bodyLineUserId: string | undefined;
    if (c.req.method !== 'GET') {
      try {
        const body = await c.req.json<{ idToken?: string; lineUserId?: string }>();
        bodyToken = body.idToken;
        bodyLineUserId = body.lineUserId;
      } catch {
        // JSON パース失敗 — ヘッダートークンにフォールバック
      }
    }

    const idToken = headerToken || bodyToken;

    // Try idToken first (secure path)
    if (idToken) {
      const channelId = c.env.LINE_LOGIN_CHANNEL_ID;
      if (!channelId) {
        return c.json({ success: false, error: 'LIFF auth not configured' }, 500);
      }

      const verifiedUserId = await verifyLineIdToken(idToken, channelId);
      if (!verifiedUserId) {
        return c.json({ success: false, error: 'Invalid or expired ID token' }, 401);
      }

      const friend = await getFriendByLineUserId(c.env.DB, verifiedUserId);
      if (!friend) {
        return c.json({ success: false, error: 'Friend not found' }, 404);
      }

      // shopifyCustomerId / followedAt も載せる (= 既に読んだ行から取れるので、下流 route が
      // 連携有無や友だち歴を知るために friend 行をもう一度読む必要がなくなる)。
      //   followedAt = **最後に友だちになった時刻**。紹介 claim の「未発行の救済」の窓判定に使う。
      //   🚨 created_at ではなく last_refollowed_at を優先すること (Codex P2, 2026-08-24):
      //   upsertFriend はブロック復活 (再フォロー) のとき created_at を**保持**して
      //   last_refollowed_at だけを now にする。created_at だけを見ると、再フォローで発行が
      //   失敗した人の正当な救済を「古い友だち」として落としてしまう。
      (c as { set: (key: string, value: unknown) => void }).set('liffUser', {
        lineUserId: verifiedUserId,
        friendId: friend.id,
        shopifyCustomerId: friend.shopify_customer_id ?? null,
        followedAt: friend.last_refollowed_at ?? friend.created_at ?? null,
      });
      return next();
    }

    // lineUserId フォールバック削除（セキュリティリスク: IDを知っているだけで他人になりすまし可能）
    // 本番では必ず LINE_LOGIN_CHANNEL_ID を設定し、idToken 検証を使うこと
    return c.json({ success: false, error: 'Authentication required. Send idToken in Authorization Bearer header.' }, 401);
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
}
