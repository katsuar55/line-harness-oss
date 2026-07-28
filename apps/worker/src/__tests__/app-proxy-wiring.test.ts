/**
 * App Proxy の**実配線**テスト (2026-07-29)
 *
 * なぜ必要か:
 *   auth.test.ts の App Proxy テストはローカルに stub route を建てて authMiddleware の
 *   skip-list だけを固定している。 そのため `app.route('/', appProxy)` を index.ts から
 *   消しても 235 ファイル全 green のままだった (R2 採点 CRITICAL)。
 *   本番では route 登録漏れ = 全 App Proxy リクエストが 404/401 = 機能が丸ごと死ぬ。
 *
 * ここでは worker の実エントリポイント (index.ts の default export) を通して叩き、
 *   ① authMiddleware を素通りして (= Bearer なしでも 401 にならず)
 *   ② appProxy ハンドラに到達している (= 応答が生テキストでなくブランド HTML)
 * ことを固定する。 gate off (本番既定) でも appProxy 自身が 404 + HTML を返すため、
 * 「未登録の 404」(生テキスト/JSON) と識別できる。
 */

import { describe, it, expect } from 'vitest';
import worker from '../index.js';

const env = {
  DB: {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
    },
  },
  API_KEY: 'test-api-key',
} as unknown as Parameters<typeof worker.fetch>[1];

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`https://worker.example.com${path}`), env, ctx);
}

describe('App Proxy の実配線 (index.ts)', () => {
  it.each(['/proxy/line-link', '/proxy/line-link/', '/proxy/line-link/anything'])(
    'GET %s は authMiddleware を通過し appProxy ハンドラに到達する',
    async (path) => {
      const res = await get(path);
      // 401 = auth skip-list 漏れ / JSON の 404 = route 未登録。
      // gate off の appProxy は 404 + ブランド HTML を返すので、これで識別できる。
      expect(res.status).not.toBe(401);
      expect(res.headers.get('content-type') ?? '').toContain('text/html');
      expect(await res.text()).toContain('ご利用いただけません');
    },
  );

  it('POST /proxy/line-link は認証必須のまま (GET 限定 skip)', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example.com/proxy/line-link', { method: 'POST' }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it('gate off の応答に Cache-Control: no-store が付く', async () => {
    const res = await get('/proxy/line-link');
    expect(res.headers.get('Cache-Control') ?? '').toContain('no-store');
  });
});
