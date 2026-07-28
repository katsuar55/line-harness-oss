/**
 * Tests for middleware/rate-limit (採点 Round1 D3: 単体テスト皆無の解消)
 *
 * in-memory sliding-window limiter を Hono context 経由で検証 (CF rate limiter binding は
 * env に無いため in-memory path を exercise)。 store は module-level に永続するため
 * テストごとに distinct IP/token を使い cross-talk を避ける。
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { rateLimitMiddleware, hashRateLimitToken } from '../middleware/rate-limit.js';

function makeApp(): Hono {
  const app = new Hono();
  app.use('*', rateLimitMiddleware as never);
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

const ENV = {} as never; // WEBHOOK_RATE_LIMITER / API_RATE_LIMITER なし → in-memory path

function req(path: string, opts: { ip?: string; auth?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
  if (opts.auth) headers.Authorization = `Bearer ${opts.auth}`;
  return new Request(`http://localhost${path}`, { headers });
}

describe('rateLimitMiddleware', () => {
  it('/docs / /openapi.json は rate limit 対象外 (150 連投でも 200)', async () => {
    const app = makeApp();
    for (let i = 0; i < 150; i++) {
      const res = await app.fetch(req('/docs', { ip: '9.9.9.9' }), ENV);
      expect(res.status).toBe(200);
    }
  });

  it('/liff/* HTML ページは rate limit 対象外 (CGNAT 配下 = 同一 IP の大量 LIFF アクセスでも 429 にしない)', async () => {
    // 2026-06-29 cutover 回帰: 同一 IP (mobile CGNAT) からの /liff/portal 150 連投でも 200。
    const app = makeApp();
    for (let i = 0; i < 150; i++) {
      const res = await app.fetch(req('/liff/portal?liff.state=%23rank', { ip: '203.0.113.7' }), ENV);
      expect(res.status).toBe(200);
    }
  });

  it('/contact/email は rate limit 対象外 (公開静的ページ・CGNAT safe)', async () => {
    const app = makeApp();
    for (let i = 0; i < 150; i++) {
      const res = await app.fetch(req('/contact/email', { ip: '203.0.113.9' }), ENV);
      expect(res.status).toBe(200);
    }
  });

  // ── Shopify App Proxy (2026-07-29) ──
  // 転送元 IP は Shopify の egress = 全顧客が共有するので IP keyed だと 1 人の連打で
  // 店舗全体が 429 になる。一方、完全除外にすると無認証 trigger の D1 write が無制限に
  // なり write 枠を焼ける。よって **顧客単位**のバケットに振り替えている。
  it('/proxy/line-link は顧客単位で keyed (同一 IP でも別顧客なら独立)', async () => {
    const app = makeApp();
    const ip = '203.0.113.10'; // Shopify egress を模す (全顧客で同一)
    for (let i = 0; i < 20; i++) {
      const res = await app.fetch(
        req('/proxy/line-link?shop=s.myshopify.com&logged_in_customer_id=111', { ip }),
        ENV,
      );
      expect(res.status).toBe(200);
    }
    // 顧客 111 は上限到達
    const over = await app.fetch(
      req('/proxy/line-link?shop=s.myshopify.com&logged_in_customer_id=111', { ip }),
      ENV,
    );
    expect(over.status).toBe(429);
    // 別顧客 222 は同一 IP でも影響を受けない (= 巻き添え 429 が起きない)
    const other = await app.fetch(
      req('/proxy/line-link?shop=s.myshopify.com&logged_in_customer_id=222', { ip }),
      ENV,
    );
    expect(other.status).toBe(200);
  });

  it('/proxy/line-link は無制限ではない (D1 write を伴うので上限が必ずある)', async () => {
    const app = makeApp();
    let saw429 = false;
    for (let i = 0; i < 60; i++) {
      const res = await app.fetch(
        req('/proxy/line-link/sub?shop=s.myshopify.com&logged_in_customer_id=333', { ip: '203.0.113.11' }),
        ENV,
      );
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });

  it('/api/liff/* データ endpoint は exempt されない (idToken Bearer keyed の per-user 制限を維持)', async () => {
    // `/api/liff/...` は `/api/` 始まりなので `/liff/` skip に巻き込まれない。
    // idToken を Bearer で持つので authed bucket (remaining 999) = per-user・CGNAT 安全。
    const res = await makeApp().fetch(
      req('/api/liff/my-rank', { auth: 'idtoken-per-user-abc', ip: '203.0.113.8' }),
      ENV,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('999');
  });

  it('未認証 path は IP keyed、 100 超で 429 + Retry-After', async () => {
    const app = makeApp();
    const ip = '1.2.3.4';
    for (let i = 0; i < 100; i++) {
      expect((await app.fetch(req('/webhook', { ip }), ENV)).status).toBe(200);
    }
    const over = await app.fetch(req('/webhook', { ip }), ENV);
    expect(over.status).toBe(429);
    expect(over.headers.get('Retry-After')).toBeTruthy();
    expect(((await over.json()) as { success: boolean }).success).toBe(false);
  });

  it('認証 path は token hash keyed で高い上限 (remaining 999)', async () => {
    const res = await makeApp().fetch(req('/api/friends', { auth: 'abcdef0123456789zzz', ip: '5.5.5.5' }), ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('999');
  });

  it('token collision fix: 先頭16文字が同一の別 token は独立バケット (full token hash keyed)', async () => {
    const app = makeApp();
    // 'samepfx012345678' が両 token の先頭16文字 (= 旧 slice(0,16) key だと衝突)
    const a = await app.fetch(req('/api/friends', { auth: 'samepfx012345678AAAAA', ip: '5.0.0.1' }), ENV);
    const b = await app.fetch(req('/api/friends', { auth: 'samepfx012345678BBBBB', ip: '5.0.0.2' }), ENV);
    expect(a.headers.get('X-RateLimit-Remaining')).toBe('999');
    // 独立バケットなら 999 (衝突していれば同バケット2発目で 998 になる)
    expect(b.headers.get('X-RateLimit-Remaining')).toBe('999');
  });

  it('認証 path で token なし → IP keyed の低い上限 (remaining 99)', async () => {
    const res = await makeApp().fetch(req('/api/friends', { ip: '6.6.6.6' }), ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('99');
  });

  it('per-key isolation: 別 IP は独立カウント', async () => {
    const app = makeApp();
    for (let i = 0; i < 100; i++) await app.fetch(req('/webhook', { ip: '7.7.7.7' }), ENV);
    expect((await app.fetch(req('/webhook', { ip: '7.7.7.7' }), ENV)).status).toBe(429);
    // 別 IP は影響を受けない
    expect((await app.fetch(req('/webhook', { ip: '8.8.8.8' }), ENV)).status).toBe(200);
  });
});

describe('hashRateLimitToken', () => {
  it('決定的・SHA-256 hex (64文字)・raw token の部分文字列を含まない', async () => {
    const token = 'secrettoken0123456789abcdef';
    const h1 = await hashRateLimitToken(token);
    const h2 = await hashRateLimitToken(token);
    expect(h1).toBe(h2); // 決定的
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex digest
    expect(h1).not.toContain(token.slice(0, 16)); // 先頭16文字が漏れない (entropy leak 防止)
  });

  it('既知ベクトル: SHA-256("") を正しく算出', async () => {
    // 空文字の SHA-256 (= 一方向ハッシュであることの sanity check)
    expect(await hashRateLimitToken('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('異なる token は異なる hash (先頭16文字が同一でも)', async () => {
    const a = await hashRateLimitToken('samepfx012345678AAAAA');
    const b = await hashRateLimitToken('samepfx012345678BBBBB');
    expect(a).not.toBe(b);
  });
});
