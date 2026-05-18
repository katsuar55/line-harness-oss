/**
 * Tests for /liff/opt-in page (Phase 5β-1b).
 *
 * inline HTML page なので、 重要な要素 (LIFF init, API endpoint, 同意 checkbox,
 * 配信内容説明 box) が含まれることを検証。
 * 5β-1e (2026-05-18): クーポン関連 markup は出現しないことを negative assert。
 */

import { describe, it, expect } from 'vitest';
import { liffOptInPage } from '../routes/liff-opt-in-page.js';

interface MinimalEnv {
  LIFF_URL: string;
  WORKER_URL: string;
}

const baseEnv: MinimalEnv = {
  LIFF_URL: 'https://liff.line.me/2000000000-abcd1234',
  WORKER_URL: 'https://example.workers.dev',
};

async function fetchPage(path: string, env: MinimalEnv = baseEnv): Promise<{ status: number; body: string }> {
  const res = await liffOptInPage.request(path, {}, env as unknown as Record<string, unknown>);
  return { status: res.status, body: await res.text() };
}

describe('GET /liff/opt-in', () => {
  it('200 を返し、 title + LIFF SDK 読込', async () => {
    const r = await fetchPage('/liff/opt-in');
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/<title>メール配信登録/);
    expect(r.body).toMatch(/static\.line-scdn\.net\/liff\/edge\/2\/sdk\.js/);
    expect(r.body).toMatch(/cdn\.tailwindcss\.com/);
  });

  it('LIFF_ID と API_BASE が JS 変数にインジェクトされる (script-safe escape)', async () => {
    const r = await fetchPage('/liff/opt-in');
    // jsonForScript で < / > / & が \uXXXX escape されるが、 通常 URL では出現しないので literal そのまま
    expect(r.body).toMatch(/const LIFF_ID = "2000000000-abcd1234"/);
    expect(r.body).toMatch(/const API_BASE = "https:\/\/example\.workers\.dev"/);
  });

  it('末尾スラッシュも 200', async () => {
    const r = await fetchPage('/liff/opt-in/');
    expect(r.status).toBe(200);
  });

  it('robots noindex meta + プライバシーポリシー link', async () => {
    const r = await fetchPage('/liff/opt-in');
    expect(r.body).toMatch(/<meta name="robots" content="noindex,nofollow">/);
    expect(r.body).toMatch(/プライバシーポリシー/);
    expect(r.body).toMatch(/naturism-diet\.com\/pages\/privacy/);
  });

  it('email input + 同意 checkbox + submit button', async () => {
    const r = await fetchPage('/liff/opt-in');
    expect(r.body).toMatch(/<input type="email" id="email"/);
    expect(r.body).toMatch(/<input type="checkbox" id="consent"/);
    expect(r.body).toMatch(/<button[^>]+id="submit-btn"/);
  });

  it('配信内容説明 box が表示される + クーポン関連 markup は無い (5β-1e)', async () => {
    const r = await fetchPage('/liff/opt-in');
    // 5β-1e (商業判断): メルマガ登録ではクーポンを付与しない
    expect(r.body).not.toMatch(/500\s*円/);
    expect(r.body).not.toMatch(/coupon-box/);
    expect(r.body).not.toMatch(/id="coupon-code"/);
    expect(r.body).not.toMatch(/クーポンコード/);
    // 代替: 配信内容説明 box
    expect(r.body).toMatch(/benefits-box/);
    expect(r.body).toMatch(/配信内容/);
    expect(r.body).toMatch(/新商品の先行ご案内/);
  });

  it('POST /api/liff/opt-in を呼ぶコードを含む', async () => {
    const r = await fetchPage('/liff/opt-in');
    expect(r.body).toMatch(/\/api\/liff\/opt-in/);
    expect(r.body).toMatch(/method: 'POST'/);
    expect(r.body).toMatch(/Authorization.*Bearer/);
    expect(r.body).toMatch(/marketingConsent/);
  });

  it('outcome 別 message 切替 logic を含む', async () => {
    const r = await fetchPage('/liff/opt-in');
    expect(r.body).toMatch(/reactivated/);
    expect(r.body).toMatch(/re_consent/);
  });

  it('XSS: LIFF_ID 内の < > / は inline <script> 内で escape され XSS 不能', async () => {
    const r = await fetchPage('/liff/opt-in', {
      LIFF_URL: 'https://liff.line.me/<script>alert(1)</script>',
      WORKER_URL: 'https://example.com',
    });
    // const LIFF_ID = ... 行を抽出 (literal `<script>` / `</script>` が出ると XSS)
    const constMatch = r.body.match(/const LIFF_ID = (.+?);/);
    expect(constMatch).not.toBeNull();
    const constLine = constMatch?.[1] ?? '';
    // 該当行に literal `<script>` や `</script>` が無い (escape されている)
    expect(constLine).not.toMatch(/<script>/);
    expect(constLine).not.toMatch(/<\/script>/);
    // jsonForScript は < > を < > に escape するので const 行は escape 済 hex 含む
    expect(constLine).toContain('\\u003c');
    expect(constLine).toContain('\\u003e');
  });

  it('XSS: HTML body 部分には escape 済の値が出る (& < > " \' すべて)', async () => {
    const r = await fetchPage('/liff/opt-in', {
      LIFF_URL: "https://liff.line.me/<a>&\"'",
      WORKER_URL: 'https://example.com',
    });
    // HTML body には raw 文字なし
    expect(r.body).not.toMatch(/<a>&"'/);
  });
});
