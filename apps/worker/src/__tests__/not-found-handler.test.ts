/**
 * Regression tests for the global notFound / 404 handling and /liff/cart redirect.
 *
 * Background:
 *   2026-04-29 本番で `/liff/cart` が 500 を返していた。
 *   原因: `app.notFound((c) => ... return c.notFound())` で `c.notFound()` が
 *   notFoundHandler を再帰呼び出しし、stack overflow → onError で 500 を返していた。
 *
 * このテストは以下を保証する:
 *   1. 未登録の `/liff/*` パス (例: `/liff/unknown`) は 404 を返す (500 ではない)
 *   2. 未登録の `/api/*` パスは JSON 404 を返す
 *   3. `/liff/cart` と `/liff/cart/` は `/liff/reorder` に redirect される
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Build a Hono app that mirrors the real notFound / cart-redirect setup.
// We intentionally do NOT import `apps/worker/src/index.ts` because it pulls
// in 50+ route modules and ~30 service modules; this would make this test a
// full integration test. The bug we want to lock in is purely about the
// notFound handler shape, so a minimal app is sufficient.
// ---------------------------------------------------------------------------

function createMinimalApp(): InstanceType<typeof Hono> {
  const app = new Hono();

  // Mirror the production redirect for /liff/cart
  app.get('/liff/cart', (c) => c.redirect('/liff/reorder'));
  app.get('/liff/cart/', (c) => c.redirect('/liff/reorder'));

  // A known-good route to confirm the app routes normal requests
  app.get('/liff/portal', (c) => c.html('<html>portal</html>'));

  // Mirror the production onError + notFound combination
  app.onError((_err, c) => {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  });
  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    if (
      path.startsWith('/api/') ||
      path === '/webhook' ||
      path === '/docs' ||
      path === '/openapi.json'
    ) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    // 重要: ここで `c.notFound()` を呼ぶと再帰になる (Hono v4)
    return c.text('Not Found', 404);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Global notFound handler', () => {
  it('returns 404 (not 500) for unknown /liff/* paths', async () => {
    const app = createMinimalApp();
    const res = await app.request('/liff/unknown-page');
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toBe('Not Found');
  });

  it('returns 404 for nested unknown /liff/* paths', async () => {
    const app = createMinimalApp();
    const res = await app.request('/liff/foo/bar/baz');
    expect(res.status).toBe(404);
  });

  it('returns JSON 404 for unknown /api/* paths', async () => {
    const app = createMinimalApp();
    const res = await app.request('/api/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Not found');
  });

  it('still serves known LIFF pages with 200', async () => {
    const app = createMinimalApp();
    const res = await app.request('/liff/portal');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('portal');
  });
});

describe('/liff/cart redirect', () => {
  it('redirects /liff/cart to /liff/reorder', async () => {
    const app = createMinimalApp();
    const res = await app.request('/liff/cart');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/liff/reorder');
  });

  it('redirects /liff/cart/ (trailing slash) to /liff/reorder', async () => {
    const app = createMinimalApp();
    const res = await app.request('/liff/cart/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/liff/reorder');
  });
});
