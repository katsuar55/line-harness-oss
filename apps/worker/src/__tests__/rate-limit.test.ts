/**
 * Tests for middleware/rate-limit (採点 Round1 D3: 単体テスト皆無の解消)
 *
 * in-memory sliding-window limiter を Hono context 経由で検証 (CF rate limiter binding は
 * env に無いため in-memory path を exercise)。 store は module-level に永続するため
 * テストごとに distinct IP/token を使い cross-talk を避ける。
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  rateLimitMiddleware,
  hashRateLimitToken,
  __resetRateLimitStoreForTests,
  __rateLimitStoreSizeForTests,
} from '../middleware/rate-limit.js';

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
  // middleware では **署名検証前** なので、キーに使えるのは IP だけ。query の
  // logged_in_customer_id をキーにすると、値を回すだけで上限を回避でき、他人の id を
  // 指定してその人の枠を先に焼けてしまう。顧客単位の絞りは署名検証後 (service 側) で掛ける。
  it('/proxy/line-link は IP バケットで制限される (query の値では回避できない)', async () => {
    const app = makeApp();
    const ip = '203.0.113.10';
    let saw429 = false;
    for (let i = 0; i < 200; i++) {
      // customer id を毎回変えても、キーは IP なので回避できない
      const res = await app.fetch(
        req(`/proxy/line-link?shop=s.myshopify.com&logged_in_customer_id=${1000 + i}`, { ip }),
        ENV,
      );
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });

  it('/proxy/line-link のバケットは Shopify webhook と分離されている (proxy-ip: prefix)', async () => {
    // 転送元は Shopify egress IP なので、webhook と同じ `ip:` バケットを共有すると
    // 連携ページへのアクセスが増えたときに **注文 webhook が 429 で落ちる**。
    const app = makeApp();
    const ip = '203.0.113.20';
    for (let i = 0; i < 100; i++) {
      await app.fetch(req('/proxy/line-link?shop=s.myshopify.com', { ip }), ENV);
    }
    // proxy 側は上限到達
    const proxyRes = await app.fetch(req('/proxy/line-link?shop=s.myshopify.com', { ip }), ENV);
    expect(proxyRes.status).toBe(429);
    // 同一 IP からの webhook は影響を受けない
    const webhookRes = await app.fetch(req('/api/integrations/shopify/webhook', { ip }), ENV);
    expect(webhookRes.status).toBe(200);
  });

  it('/proxy/line-link のサブパスも同じ IP バケット (skip 漏れを作らない)', async () => {
    const app = makeApp();
    const ip = '203.0.113.21';
    let saw429 = false;
    for (let i = 0; i < 200; i++) {
      const res = await app.fetch(req('/proxy/line-link/sub', { ip }), ENV);
      if (res.status === 429) { saw429 = true; break; }
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

describe('store のメモリ上限 (キー回転への耐性)', () => {
  // キー基数は攻撃者が握れる (ランダム Bearer を投げれば key:<hash> が毎回増える)。
  // prune は 60 秒に 1 回しか走らないので、上限が無いと 1 分ぶんが isolate に滞留し、
  // store を共有する webhook/cron まで巻き込んで落ちる。
  it('ユニークキーを大量に作っても store は上限を超えて増え続けない', async () => {
    __resetRateLimitStoreForTests();
    const app = makeApp();
    for (let i = 0; i < 12_000; i++) {
      await app.fetch(req('/api/friends', { auth: `rotating-token-${i}`, ip: '198.51.100.1' }), ENV);
    }
    // 上限 (10,000) を超えて青天井にならないこと
    expect(__rateLimitStoreSizeForTests()).toBeLessThanOrEqual(10_000);
    __resetRateLimitStoreForTests();
  });

  it('退避は「最終アクセスが古い順」= 使い続けている正規バケットを先に捨てない', async () => {
    __resetRateLimitStoreForTests();
    const app = makeApp();
    const liveIp = '198.51.100.2';
    // 正規バケットを作る (以後も使い続ける想定)
    await app.fetch(req('/webhook', { ip: liveIp }), ENV);
    // キー回転で上限を超えさせる
    for (let i = 0; i < 11_000; i++) {
      await app.fetch(req('/api/friends', { auth: `flood-${i}`, ip: '198.51.100.3' }), ENV);
      if (i % 2_000 === 0) {
        // 正規バケットを触り続ける (= 最終アクセスが新しい状態を保つ)
        await app.fetch(req('/webhook', { ip: liveIp }), ENV);
      }
    }
    // 正規バケットは生き残っており、カウンタもリセットされていない
    const res = await app.fetch(req('/webhook', { ip: liveIp }), ENV);
    const remaining = Number(res.headers.get('X-RateLimit-Remaining'));
    expect(remaining).toBeLessThan(99); // 99 = 初回相当 (= 捨てられて作り直された状態)
    __resetRateLimitStoreForTests();
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
