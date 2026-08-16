/**
 * GET/DELETE /images/:key の公開名前空間ガード (2026-08-16 の情報漏洩の恒久ガード)。
 *
 * 背景: `/images/` は認証不要 (middleware/auth.ts の skip-list)。Hono は `%2F` を
 * デコードして `:key` に渡すため、ガードが無いと IMAGES バケット内の**任意**の
 * オブジェクトが無認証で読めた。実際に D1 日次バックアップ
 * (`backups/<日付>/naturism-d1-backup-<日付>.sql` = 顧客 PII を含む DB 全体) が
 * 本番で 206 を返していた。キーは日付ベースで推測容易。
 *
 * このテストの観測点は「ステータスコード」だけではなく
 * **R2 に一度も触っていないこと** (`head`/`get`/`delete` が未呼び出し) に置く。
 * ステータスだけを見ると「R2 から読んでから 404 に潰す」実装でも緑になり、
 * ガードを消す変異が生き残るため。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...actual,
    getStaffByApiKey: vi.fn(async () => null),
    getLineAccounts: vi.fn(async () => []),
  };
});

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    async replyMessage() {}
    async pushMessage() {}
    async showLoadingAnimation() {}
  },
}));

import { authMiddleware } from '../middleware/auth.js';
import { images, isPubliclyServableImageKey } from '../routes/images.js';
import type { Env } from '../index.js';

const TEST_API_KEY = 'test-api-key-secret-12345';

/** 本番で実際に漏れていたキー (2026-08-16 実測)。 */
const LEAKED_BACKUP_KEY = 'backups/2026-08-15/naturism-d1-backup-2026-08-15.sql';

function createMockR2Bucket() {
  return {
    put: vi.fn(async () => undefined),
    get: vi.fn(async (): Promise<unknown> => null),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ objects: [], truncated: false })),
    head: vi.fn(async (): Promise<unknown> => null),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  };
}

function createMockDb(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      })),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ success: true })),
    })),
    dump: vi.fn(),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
  } as unknown as D1Database;
}

function createMockEnv(bucket: ReturnType<typeof createMockR2Bucket>): Env['Bindings'] {
  return {
    DB: createMockDb(),
    IMAGES: bucket as unknown as R2Bucket,
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-channel-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'test-channel-id',
    LINE_LOGIN_CHANNEL_ID: 'test-login-channel-id',
    LINE_LOGIN_CHANNEL_SECRET: 'test-login-secret',
    WORKER_URL: 'https://worker.example.com',
  };
}

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', images);
  return app;
}

/** R2 に実体があるかのように振る舞わせる (ガードが無ければ配信されてしまう状態を作る)。 */
function stubObjectExists(bucket: ReturnType<typeof createMockR2Bucket>, contentType = 'image/png') {
  bucket.head.mockResolvedValue({ size: 1024, httpMetadata: { contentType }, etag: '"e"' });
  bucket.get.mockResolvedValue({ body: new ReadableStream(), httpMetadata: { contentType }, etag: '"e"' });
}

describe('公開配信ガード — 非公開名前空間の遮断', () => {
  let app: ReturnType<typeof createTestApp>;
  let bucket: ReturnType<typeof createMockR2Bucket>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    bucket = createMockR2Bucket();
    // バケットには実体がある = ガードだけが漏洩を止めている状況。
    stubObjectExists(bucket);
  });

  it('D1 バックアップを無認証で配信しない (本番で漏れていた実キー)', async () => {
    const res = await app.request(
      `/images/${encodeURIComponent(LEAKED_BACKUP_KEY)}`,
      { method: 'GET' },
      createMockEnv(bucket),
    );

    expect(res.status).toBe(404);
    // R2 に触れてすらいないこと = ガードが本当に手前で効いている。
    expect(bucket.head).not.toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('Range 付きでもバックアップを配信しない (206 の実攻撃形)', async () => {
    const res = await app.request(
      `/images/${encodeURIComponent(LEAKED_BACKUP_KEY)}`,
      { method: 'GET', headers: { Range: 'bytes=0-200' } },
      createMockEnv(bucket),
    );

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(206);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('拒否応答は「存在しない」と区別できない (鍵の存在確認に使えない)', async () => {
    const env = createMockEnv(bucket);

    const blocked = await app.request(
      `/images/${encodeURIComponent(LEAKED_BACKUP_KEY)}`,
      { method: 'GET' },
      env,
    );

    // 実在しないフラットキー = 正真正銘の 404
    const missingBucket = createMockR2Bucket();
    const missing = await app.request('/images/definitely-absent.png', { method: 'GET' }, createMockEnv(missingBucket));

    expect(blocked.status).toBe(missing.status);
    expect(await blocked.json()).toEqual(await missing.json());
  });

  it.each([
    ['backups/2026-08-17/naturism-d1-backup-2026-08-17.sql', '別日のバックアップ'],
    ['backups/', 'プレフィックスのみ'],
    ['secrets/token.txt', '将来足されうる別の機微プレフィックス'],
    ['food/../backups/x.sql', '許可プレフィックスからの traversal'],
    ['food/nested/deeper.png', '許可プレフィックス配下のさらに深い階層'],
    ['../wrangler.toml', '親への traversal'],
    ['/etc/passwd', '絶対パス風'],
  ])('拒否する: %s (%s)', async (key) => {
    const res = await app.request(`/images/${encodeURIComponent(key)}`, { method: 'GET' }, createMockEnv(bucket));

    expect(res.status).toBe(404);
    expect(bucket.head).not.toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('DELETE でもバックアップに触らせない (画像管理権限で DR を消せない)', async () => {
    const res = await app.request(
      `/api/images/${encodeURIComponent(LEAKED_BACKUP_KEY)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      createMockEnv(bucket),
    );

    expect(res.status).toBe(404);
    expect(bucket.delete).not.toHaveBeenCalled();
  });
});

describe('公開配信ガード — 正規の画像は従来どおり配信される', () => {
  let app: ReturnType<typeof createTestApp>;
  let bucket: ReturnType<typeof createMockR2Bucket>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    bucket = createMockR2Bucket();
    stubObjectExists(bucket);
  });

  // 実装上の全書き込み経路のキー形をここに固定する。
  // routes/images.ts (POST) / routes/rich-menus.ts (PUT) / routes/webhook.ts (食事画像) /
  // 手動配置 (quiz-hero-v1.mp4・rank-silver-v2.png)。
  it.each([
    ['550e8400-e29b-41d4-a716-446655440000.png', 'POST /api/images の UUID キー'],
    ['richmenu-v4.jpg', 'リッチメニュー画像'],
    ['quiz-hero-v1.mp4', 'クイズ hero 動画 (customKey)'],
    ['rank-silver-v2.png', 'ランクバッジ'],
    ['food/550e8400-e29b-41d4-a716-446655440000.jpg', 'webhook の食事画像'],
  ])('配信する: %s (%s)', async (key) => {
    const res = await app.request(`/images/${encodeURIComponent(key)}`, { method: 'GET' }, createMockEnv(bucket));

    expect(res.status).toBe(200);
    expect(bucket.get).toHaveBeenCalledWith(key);
  });

  it('食事画像は Range 配信も維持する (LINE WebView の <video>/シーク要件)', async () => {
    bucket.get.mockResolvedValue({ body: new ReadableStream() });
    const res = await app.request(
      `/images/${encodeURIComponent('food/550e8400-e29b-41d4-a716-446655440000.jpg')}`,
      { method: 'GET', headers: { Range: 'bytes=0-99' } },
      createMockEnv(bucket),
    );

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-99/1024');
  });

  /**
   * 📌 既知の別バグ (本ガードとは無関係・本コミットでは直さない):
   * Hono の `:key` は 1 セグメント (`[^/]+`) しか取らないため、**生のスラッシュ**を含む
   * `/images/food/<id>.jpg` はハンドラに到達せず Hono 既定の 404 になる。
   * routes/webhook.ts はこの生スラッシュ形式を food_logs.image_url に書いているので、
   * 食事画像は以前から配信されていない。
   *
   * ここでピン留めしておく理由: 将来 route を `:key{.+}` 等に広げてこれを直す人が出たとき、
   * **同時に allowlist が唯一の防壁になる**ことを明示するため。広げるだけだと
   * backups/ が再び全公開に戻る。
   */
  it('生スラッシュの多段キーはハンドラに到達しない (既知の別バグ・拡張時は allowlist が唯一の防壁)', async () => {
    const res = await app.request(
      '/images/food/550e8400-e29b-41d4-a716-446655440000.jpg',
      { method: 'GET' },
      createMockEnv(bucket),
    );

    expect(res.status).toBe(404);
    // Hono 既定の 404 (プレーンテキスト) = ルート不一致。ハンドラの JSON 404 ではない。
    expect(await res.text()).toBe('404 Not Found');
    expect(bucket.head).not.toHaveBeenCalled();
  });
});

describe('isPubliclyServableImageKey — 述語の単体仕様', () => {
  it('スラッシュを含むキーは許可プレフィックス配下のみ', () => {
    expect(isPubliclyServableImageKey('food/a.png')).toBe(true);
    expect(isPubliclyServableImageKey('backups/a.sql')).toBe(false);
    expect(isPubliclyServableImageKey('foodie/a.png')).toBe(false);
    expect(isPubliclyServableImageKey('food/a/b.png')).toBe(false);
  });

  it('空キー・先頭記号・`..` を拒否する', () => {
    expect(isPubliclyServableImageKey('')).toBe(false);
    expect(isPubliclyServableImageKey('.hidden')).toBe(false);
    expect(isPubliclyServableImageKey('-dash.png')).toBe(false);
    expect(isPubliclyServableImageKey('a..b.png')).toBe(false);
    expect(isPubliclyServableImageKey('food/')).toBe(false);
  });

  it('過度に長いキーを拒否する (128 文字上限)', () => {
    expect(isPubliclyServableImageKey(`${'a'.repeat(128)}.png`)).toBe(false);
    expect(isPubliclyServableImageKey('a'.repeat(128))).toBe(true);
  });
});
