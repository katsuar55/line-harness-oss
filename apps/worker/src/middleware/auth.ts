import type { Context, Next } from 'hono';
import { getStaffByApiKey } from '@line-crm/db';
import type { Env } from '../index.js';

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
    // GET のみ公開 (LIFF が form 定義を読む)。 PUT(編集)/DELETE(削除) は authMiddleware を
    // 通す = method 非依存 skip だと無認証で他人の form を改竄/削除できる穴 (採点 D2)。
    (c.req.method === 'GET' && path.match(/^\/api\/forms\/[^/]+$/)) ||
    path === '/api/rich-menus/image-guide' || // Rich menu image template (static HTML)
    // 友だち限定クーポン 管理トグルページ (公開 HTML shell のみ skip。
    // 実操作 /api/admin/friend-coupon は API_KEY 保護のまま = 無認証で改変不可)。
    path === '/admin/friend-coupon' ||
    // FAQ 管理ページ (公開 HTML shell のみ skip。/api/admin/faq* は API_KEY 保護のまま。
    // exact-match なので /api/admin/faq を素通りさせない = 採点 D2 の method 非依存 skip 穴を作らない)。
    path === '/admin/faq'
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

  // Fallback: env API_KEY acts as owner
  // API_KEY が空/未設定のときに `Bearer ` (空トークン) が owner 権限を得るのを防ぐ
  // (CRLF secret trap 等で API_KEY が空文字になる事故への防御)。
  if (c.env.API_KEY && token === c.env.API_KEY) {
    c.set('staff', { id: 'env-owner', name: 'Owner', role: 'owner' as const });
    return next();
  }

  return c.json({ success: false, error: 'Unauthorized' }, 401);
}
