import type { Context, Next } from 'hono';
import { getStaffByApiKey } from '@line-crm/db';
import type { Env } from '../index.js';

/**
 * Constant-time string comparison — avoids leaking the master key via response
 * timing. Length mismatch returns immediately (key length is not secret).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function authMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  // Skip auth for the LINE webhook endpoint — it uses signature verification instead
  // Skip auth for OpenAPI docs — public documentation
  const path = new URL(c.req.url).pathname;
  if (
    path === '/webhook' ||
    path === '/docs' ||
    path === '/openapi.json' ||
    path === '/api/affiliates/click' ||
    path.startsWith('/t/') ||
    path.startsWith('/r/') ||
    path.startsWith('/images/') ||
    path.startsWith('/api/liff/') ||
    // LIFF HTML ページは API ではなく SPA エントリ (内部の API 呼び出しは
    // liffAuthMiddleware が `/api/liff/*` で別途 idToken 検証する)。
    // ハードコードしていた `/liff/portal` だけだと、/liff/coach や /liff/food
    // /liff/reorder /liff/food/graph /liff/cart 等が 401 になっていた (2026-04-28 顕在化)。
    path.startsWith('/liff/') ||
    path.startsWith('/auth/') ||
    // Round 4 PR-5: 配信停止リンクはメール受信者 (= 認証不可能な外部ユーザー) が叩く。
    // HMAC token 検証で代替認証する (routes/email-unsubscribe.ts)。
    path === '/email/unsubscribe' ||
    path === '/email/resubscribe' ||
    // Phase 5β-1: opt-in 確認ページ (email 受信者 = 認証不可能な外部ユーザー、 HMAC token で代替認証)
    path === '/email/opt-in' ||
    // Round 4 PR-4: Resend webhook (Svix 署名検証で代替認証)
    path === '/api/integrations/resend/webhook' ||
    path === '/api/integrations/stripe/webhook' ||
    path === '/api/integrations/shopify/webhook' ||
    path === '/api/integrations/shopify/webhook/checkout' ||
    path === '/api/integrations/shopify/webhook/fulfillment' ||
    path === '/api/integrations/shopify/webhook/inventory' ||
    path === '/api/integrations/shopify/webhook/payment' ||
    path === '/api/integrations/shopify/webhook/product' ||
    path.match(/^\/api\/webhooks\/incoming\/[^/]+\/receive$/) ||
    path.match(/^\/api\/forms\/[^/]+\/submit$/) ||
    path.match(/^\/api\/forms\/[^/]+$/) || // GET form definition (public for LIFF)
    path === '/api/rich-menus/image-guide' // Rich menu image template (static HTML)
  ) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice('Bearer '.length);

  // Check staff_members table first
  const staff = await getStaffByApiKey(c.env.DB, token);
  if (staff) {
    c.set('staff', { id: staff.id, name: staff.name, role: staff.role });
    return next();
  }

  // Fallback: env API_KEY acts as owner.
  // Guard against an unset/empty API_KEY authenticating an empty/garbage bearer,
  // and compare in constant time.
  if (c.env.API_KEY && constantTimeEqual(token, c.env.API_KEY)) {
    c.set('staff', { id: 'env-owner', name: 'Owner', role: 'owner' as const });
    return next();
  }

  return c.json({ success: false, error: 'Unauthorized' }, 401);
}
