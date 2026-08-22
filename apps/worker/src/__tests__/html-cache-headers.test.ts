/**
 * HTML の キャッシュ無効化 (2026-08-23)。
 *
 * 事故: LIFF 7 ページ + 管理画面の HTML が Cache-Control / ETag / Last-Modified を
 *   1 つも返しておらず (本番実測)、LINE の WebView がヒューリスティックキャッシュに落ちて
 *   deploy 済みの変更が実機に反映されなかった (#270 で実発生)。
 *
 * 観測点は「**実際に配られる Response のヘッダ**」。ミドルウェアの内部状態や
 * パスの列挙ではなく、app.request() の戻り値を見る (= 本番で配る形そのもの)。
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { htmlNoStoreMiddleware, HTML_CACHE_CONTROL } from '../middleware/html-cache.js';

/** ミドルウェアを適用した最小 app を作る (本番 index.ts と同じ '*' 適用) */
function appWith(register: (app: Hono) => void): Hono {
  const app = new Hono();
  app.use('*', htmlNoStoreMiddleware);
  register(app);
  return app;
}

describe('HTML no-store ミドルウェア', () => {
  it('text/html には no-store を付ける', async () => {
    const app = appWith((a) => a.get('/liff/portal', (c) => c.html('<!DOCTYPE html><p>hi</p>')));
    const res = await app.request('/liff/portal');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(HTML_CACHE_CONTROL);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(res.headers.get('Pragma')).toBe('no-cache');
  });

  it('charset 付き Content-Type (本番の実形) でも付く', async () => {
    const app = appWith((a) =>
      a.get('/p', (c) => c.body('<p>x</p>', 200, { 'Content-Type': 'text/html; charset=UTF-8' })),
    );
    const res = await app.request('/p');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('大文字表記の Content-Type でも付く (Content-Type は case-insensitive)', async () => {
    const app = appWith((a) =>
      a.get('/p', (c) => c.body('<p>x</p>', 200, { 'Content-Type': 'TEXT/HTML; charset=utf-8' })),
    );
    const res = await app.request('/p');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('🚨 画像は対象外 — brand-logo.png の immutable キャッシュを壊さない', async () => {
    const app = appWith((a) =>
      a.get('/liff/brand-logo.png', (c) =>
        c.body(new Uint8Array([1, 2, 3]), 200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800, immutable',
        }),
      ),
    );
    const res = await app.request('/liff/brand-logo.png');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=604800, immutable');
    expect(res.headers.get('Pragma')).toBeNull();
  });

  it('JSON API は対象外 (ヘッダを一切足さない)', async () => {
    const app = appWith((a) => a.get('/api/x', (c) => c.json({ ok: true })));
    const res = await app.request('/api/x');
    expect(res.headers.get('Cache-Control')).toBeNull();
    expect(res.headers.get('Pragma')).toBeNull();
  });

  it('明示的に Cache-Control を設定済みの HTML は上書きしない (app-proxy の no-store, private 等)', async () => {
    const app = appWith((a) =>
      a.get('/proxy/x', (c) =>
        c.html('<p>x</p>', 200, { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' }),
      ),
    );
    const res = await app.request('/proxy/x');
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('エラーレスポンス (404/500 の HTML) にも付く — 古いエラー画面を焼き付けない', async () => {
    const app = appWith((a) => a.get('/e', (c) => c.html('<p>err</p>', 500)));
    const res = await app.request('/e');
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });
});

/** 本物のルーターを通した end-to-end 検証 (LIFF 7 ページ全部) */
describe('LIFF 全ページが no-store で配られる (本番の形)', () => {
  const ENV = {
    LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
    WORKER_URL: 'https://example.workers.dev',
  };

  it('7 ページすべてに Cache-Control: no-store が付く', async () => {
    const [
      { liffPages },
      { liffOptInPage },
      { liffMyRank },
      { liffCoachPage },
      { liffFoodPage },
      { liffFoodGraph },
      { liffReorderPage },
    ] = await Promise.all([
      import('../routes/liff-pages.js'),
      import('../routes/liff-opt-in-page.js'),
      import('../routes/liff-my-rank.js'),
      import('../routes/liff-coach-page.js'),
      import('../routes/liff-food-page.js'),
      import('../routes/liff-food-graph.js'),
      import('../routes/liff-reorder-page.js'),
    ]);

    const PAGES: Array<[string, unknown]> = [
      ['/liff/portal', liffPages],
      ['/liff/opt-in', liffOptInPage],
      ['/liff/my-rank', liffMyRank],
      ['/liff/coach', liffCoachPage],
      ['/liff/food', liffFoodPage],
      ['/liff/food/graph', liffFoodGraph],
      ['/liff/reorder', liffReorderPage],
    ];

    for (const [path, router] of PAGES) {
      const app = new Hono();
      app.use('*', htmlNoStoreMiddleware);
      app.route('/', router as Hono);
      const res = await app.request(path, {}, ENV as unknown as Record<string, unknown>);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('Content-Type'), path).toContain('text/html');
      expect(res.headers.get('Cache-Control'), path).toContain('no-store');
    }
  });

  it('末尾スラッシュ版も同じく no-store (LINE の LIFF ブラウザは両方を叩きうる)', async () => {
    const { liffPages } = await import('../routes/liff-pages.js');
    const app = new Hono();
    app.use('*', htmlNoStoreMiddleware);
    app.route('/', liffPages as unknown as Hono);
    const res = await app.request('/liff/portal/', {}, ENV as unknown as Record<string, unknown>);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('brand-logo.png は本物のルーターでも immutable のまま (退行なし)', async () => {
    const { liffPages } = await import('../routes/liff-pages.js');
    const app = new Hono();
    app.use('*', htmlNoStoreMiddleware);
    app.route('/', liffPages as unknown as Hono);
    const res = await app.request('/liff/brand-logo.png', {}, ENV as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=604800, immutable');
  });
});

/**
 * 🚨 測定器の自己防衛 (最重要):
 * 上のテストはミドルウェアを**テスト側で手配線**しているため、index.ts から
 * `app.use('*', htmlNoStoreMiddleware)` を消しても全部 green のままになる
 * (= ガードが外れても誰も気付かない)。ここでは **本番の default export** を
 * 実際に fetch して、配線そのものを観測する。
 */
describe('本番 app (index.ts の default export) に配線されている', () => {
  const ENV = {
    LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
    WORKER_URL: 'https://example.workers.dev',
    API_KEY: 'test-api-key',
  };
  const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };

  it('GET /liff/portal が no-store を返す (配線が消えたら落ちる)', async () => {
    const worker = (await import('../index.js')).default as {
      fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response>;
    };
    const res = await worker.fetch(
      new Request('https://example.workers.dev/liff/portal'),
      ENV,
      CTX,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Cache-Control'), '本番 app の /liff/portal').toContain('no-store');
  });

  it('GET /liff/brand-logo.png は本番 app でも immutable のまま', async () => {
    const worker = (await import('../index.js')).default as {
      fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response>;
    };
    const res = await worker.fetch(
      new Request('https://example.workers.dev/liff/brand-logo.png'),
      ENV,
      CTX,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=604800, immutable');
  });
});
