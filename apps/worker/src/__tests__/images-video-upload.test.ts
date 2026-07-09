/**
 * 画像/動画アップロード route の video 対応 + 決定的キー (2026-07-08):
 *
 * 診断タブの 💊 を naturism 商品の 5 秒動画に差し替えるため、POST /api/images に
 * video/mp4 (+ webm) を許可し、決定的キー (quiz-hero-v1.mp4) でアップロードできるようにする。
 * GET /images/:key は content-type を R2 メタから返すので動画もそのまま配信される (認証不要・公開)。
 *
 * セキュリティ: POST は authMiddleware (API_KEY) 保護下。カスタムキーは path traversal /
 * 予約キー上書きを防ぐため厳格にサニタイズ ([a-z0-9._-] のみ、拡張子必須)。
 */
import { describe, it, expect, vi } from 'vitest';
import { images } from '../routes/images.js';

type StoredObject = { body: unknown; httpMetadata?: { contentType?: string }; etag: string };

function byteLen(o: StoredObject): number {
  const b = o.body as ArrayBuffer | Uint8Array;
  return b instanceof ArrayBuffer ? b.byteLength : (b as Uint8Array).byteLength ?? 0;
}

function makeEnv(store: Map<string, StoredObject>) {
  return {
    IMAGES: {
      put: vi.fn(async (key: string, data: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) => {
        store.set(key, { body: data, httpMetadata: opts?.httpMetadata, etag: 'etag-' + key });
      }),
      head: vi.fn(async (key: string) => {
        const o = store.get(key);
        return o ? { size: byteLen(o), httpMetadata: o.httpMetadata, etag: o.etag } : null;
      }),
      get: vi.fn(async (key: string, opts?: { range?: { offset: number; length: number } }) => {
        const o = store.get(key);
        if (!o) return null;
        if (opts?.range) {
          return { ...o, range: opts.range };
        }
        return o;
      }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
    },
    WORKER_URL: 'https://example.workers.dev',
    API_KEY: 'test-key',
  };
}

function jsonReq(body: unknown) {
  return new Request('https://example.workers.dev/api/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// tiny base64 payload (not a real video, route does not decode)
const tinyB64 = btoa('mp4-bytes');

describe('POST /api/images — video 対応', () => {
  it('video/mp4 を base64 で受け付け、R2 に put する', async () => {
    const store = new Map<string, StoredObject>();
    const res = await images.request(jsonReq({ data: tinyB64, mimeType: 'video/mp4' }), {}, makeEnv(store) as never);
    expect(res.status).toBe(201);
    const json = await res.json() as { success: boolean; data: { url: string; mimeType: string } };
    expect(json.success).toBe(true);
    expect(json.data.mimeType).toBe('video/mp4');
    expect(json.data.url).toMatch(/\.mp4$/);
  });

  it('決定的キー (quiz-hero-v1.mp4) を指定でき、そのキーで保存される', async () => {
    const store = new Map<string, StoredObject>();
    const res = await images.request(
      jsonReq({ data: tinyB64, mimeType: 'video/mp4', key: 'quiz-hero-v1.mp4' }),
      {}, makeEnv(store) as never,
    );
    expect(res.status).toBe(201);
    const json = await res.json() as { data: { key: string; url: string } };
    expect(json.data.key).toBe('quiz-hero-v1.mp4');
    expect(json.data.url).toBe('https://example.workers.dev/images/quiz-hero-v1.mp4');
    expect(store.has('quiz-hero-v1.mp4')).toBe(true);
  });

  it('path traversal を含むカスタムキーを拒否する', async () => {
    const store = new Map<string, StoredObject>();
    for (const bad of ['../secret.mp4', 'a/b.mp4', 'no-ext', 'x.exe', 'x.mp4/../y']) {
      const res = await images.request(jsonReq({ data: tinyB64, mimeType: 'video/mp4', key: bad }), {}, makeEnv(store) as never);
      expect(res.status, bad).toBe(400);
    }
    expect(store.size).toBe(0);
  });

  it('カスタムキーの拡張子は mimeType と一致必須 (mp4 keyに image mime は拒否)', async () => {
    const store = new Map<string, StoredObject>();
    const res = await images.request(jsonReq({ data: tinyB64, mimeType: 'image/png', key: 'quiz-hero-v1.mp4' }), {}, makeEnv(store) as never);
    expect(res.status).toBe(400);
  });

  it('画像は従来どおり 5MB 上限、動画は 20MB まで許可', async () => {
    const store = new Map<string, StoredObject>();
    // 6MB image → reject
    const bigImg = btoa('x'.repeat(6 * 1024 * 1024));
    const r1 = await images.request(jsonReq({ data: bigImg, mimeType: 'image/png' }), {}, makeEnv(store) as never);
    expect(r1.status).toBe(400);
    // 6MB video → OK
    const r2 = await images.request(jsonReq({ data: bigImg, mimeType: 'video/mp4', key: 'big-v1.mp4' }), {}, makeEnv(store) as never);
    expect(r2.status).toBe(201);
  });

  it('未対応 mime (image/svg+xml 等) は従来どおり拒否', async () => {
    const store = new Map<string, StoredObject>();
    const res = await images.request(jsonReq({ data: tinyB64, mimeType: 'image/svg+xml' }), {}, makeEnv(store) as never);
    expect(res.status).toBe(400);
  });
});

describe('GET /images/:key — 動画配信', () => {
  it('動画も content-type を R2 メタから返し public cache + Accept-Ranges する', async () => {
    const store = new Map<string, StoredObject>();
    const env = makeEnv(store);
    await images.request(jsonReq({ data: tinyB64, mimeType: 'video/mp4', key: 'quiz-hero-v1.mp4' }), {}, env as never);
    const res = await images.request(
      new Request('https://example.workers.dev/images/quiz-hero-v1.mp4'), {}, env as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    // iOS WebView 動画再生に必須
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
  });

  it('Range リクエストは 206 + Content-Range を返す (iOS 動画シーク/ループ対応)', async () => {
    const store = new Map<string, StoredObject>();
    const env = makeEnv(store);
    await images.request(jsonReq({ data: tinyB64, mimeType: 'video/mp4', key: 'quiz-hero-v1.mp4' }), {}, env as never);
    const total = byteLen(store.get('quiz-hero-v1.mp4')!);
    const res = await images.request(
      new Request('https://example.workers.dev/images/quiz-hero-v1.mp4', { headers: { Range: 'bytes=0-3' } }),
      {}, env as never,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-3/${total}`);
    expect(res.headers.get('Content-Length')).toBe('4');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
  });

  it('範囲外 Range は 416 を返す', async () => {
    const store = new Map<string, StoredObject>();
    const env = makeEnv(store);
    await images.request(jsonReq({ data: tinyB64, mimeType: 'video/mp4', key: 'quiz-hero-v1.mp4' }), {}, env as never);
    const total = byteLen(store.get('quiz-hero-v1.mp4')!);
    const res = await images.request(
      new Request('https://example.workers.dev/images/quiz-hero-v1.mp4', { headers: { Range: `bytes=${total + 10}-` } }),
      {}, env as never,
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe(`bytes */${total}`);
  });
});
