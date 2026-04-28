/**
 * Tests for /liff/reorder page (Phase 6 PR-4).
 *
 * inline HTML page なので、レンダリング結果に必要な要素 (LIFF init script,
 * API endpoint 呼び出し、エスケープ処理) が含まれることをスナップ的に検証。
 */

import { describe, it, expect } from 'vitest';
import { liffReorderPage } from '../routes/liff-reorder-page.js';

interface MinimalEnv {
  LIFF_URL: string;
  WORKER_URL: string;
}

const baseEnv: MinimalEnv = {
  LIFF_URL: 'https://liff.line.me/2000000000-abcd1234',
  WORKER_URL: 'https://example.workers.dev',
};

async function fetchPage(path: string, env: MinimalEnv = baseEnv): Promise<{ status: number; body: string }> {
  const res = await liffReorderPage.request(path, {}, env as unknown as Record<string, unknown>);
  return { status: res.status, body: await res.text() };
}

describe('GET /liff/reorder', () => {
  it('200 を返し、必要な script + tag が含まれる', async () => {
    const r = await fetchPage('/liff/reorder');
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/<title>再購入リマインダー/);
    expect(r.body).toMatch(/static\.line-scdn\.net\/liff\/edge\/2\/sdk\.js/);
    expect(r.body).toMatch(/cdn\.tailwindcss\.com/);
  });

  it('LIFF_ID と API_BASE が JS 変数にインジェクトされる', async () => {
    const r = await fetchPage('/liff/reorder');
    expect(r.body).toMatch(/const LIFF_ID = '2000000000-abcd1234'/);
    expect(r.body).toMatch(/const API_BASE = 'https:\/\/example\.workers\.dev'/);
  });

  it('末尾スラッシュも 200', async () => {
    const r = await fetchPage('/liff/reorder/');
    expect(r.status).toBe(200);
  });

  it('GET /api/liff/subscriptions を呼ぶコードが含まれる', async () => {
    const r = await fetchPage('/liff/reorder');
    expect(r.body).toMatch(/\/api\/liff\/subscriptions/);
    expect(r.body).toMatch(/PUT/);
    expect(r.body).toMatch(/DELETE/);
  });

  it('preset 候補 [7, 14, 30, 45, 60, 90] が定義される', async () => {
    const r = await fetchPage('/liff/reorder');
    expect(r.body).toMatch(/PRESET_DAYS = \[7, 14, 30, 45, 60, 90\]/);
  });

  it('XSS 対策: LIFF_URL に < を含めても script が壊れない', async () => {
    const r = await fetchPage('/liff/reorder', {
      LIFF_URL: 'https://liff.line.me/<script>alert(1)</script>',
      WORKER_URL: 'https://example.workers.dev',
    });
    expect(r.status).toBe(200);
    // 生の <script> が body に注入されていないこと
    const idLine = (r.body.match(/const LIFF_ID = '[^']*'/) ?? [''])[0];
    expect(idLine).not.toContain('<script>');
    expect(idLine).toContain('&lt;script&gt;');
  });

  it('LIFF_URL 未設定時も 500 にせず空文字で動く', async () => {
    const r = await fetchPage('/liff/reorder', {
      LIFF_URL: '',
      WORKER_URL: '',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/const LIFF_ID = ''/);
    expect(r.body).toMatch(/const API_BASE = ''/);
  });
});
