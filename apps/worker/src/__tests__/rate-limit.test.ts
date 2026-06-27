/**
 * Tests for middleware/rate-limit (採点 Round1 D3: 単体テスト皆無の解消)
 *
 * in-memory sliding-window limiter を Hono context 経由で検証 (CF rate limiter binding は
 * env に無いため in-memory path を exercise)。 store は module-level に永続するため
 * テストごとに distinct IP/token を使い cross-talk を避ける。
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';

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

  it('認証 path は token prefix keyed で高い上限 (remaining 999)', async () => {
    const res = await makeApp().fetch(req('/api/friends', { auth: 'abcdef0123456789zzz', ip: '5.5.5.5' }), ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('999');
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
