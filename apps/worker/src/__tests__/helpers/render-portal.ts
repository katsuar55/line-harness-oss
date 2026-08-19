/**
 * LIFF ページを router 経由で実レンダリングする共有ハーネス (Ultraplan PR-1)。
 *
 * ソース静的検査 (readFileSync + regex) は「抽出 0 マッチで恒久 pass」する事故 (測定器の
 * 無力化) を起こしうるため、新設テストは原則こちらの**出力ベース**で書く。
 * gate が増えたら PORTAL_GATE_MATRIX に組合せを足すこと — 既定 env だけ見ていると
 * 「本番で配っている形を誰も見ていない」状態になる (liff-script-syntax.test.ts と同思想)。
 */

import { expect } from 'vitest';
import { liffPages } from '../../routes/liff-pages.js';

export const PORTAL_BASE_ENV = {
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
  WORKER_URL: 'https://example.workers.dev',
} as const;

/**
 * portal のテンプレート分岐を生む gate の全組合せ。
 * PR-3 (PORTAL_BOOTSTRAP_ENABLED) / PR-5 (LIFF_SUB_CARD_ENABLED) で必ず行を足す。
 */
export const PORTAL_GATE_MATRIX: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['gate すべて off', {}],
  [
    'APP_PROXY_LINK_ENABLED=true',
    { APP_PROXY_LINK_ENABLED: 'true', SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com' },
  ],
  ['REFERRAL_REWARD_ENABLED=true', { REFERRAL_REWARD_ENABLED: 'true' }],
  [
    '全 gate on (現在の本番)',
    {
      APP_PROXY_LINK_ENABLED: 'true',
      SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com',
      REFERRAL_REWARD_ENABLED: 'true',
    },
  ],
];

/** portal を実レンダリングして HTML を返す (200 でなければ即 fail)。 */
export async function renderPortal(extraEnv: Record<string, string> = {}): Promise<string> {
  const env = { ...PORTAL_BASE_ENV, ...extraEnv };
  const res = await liffPages.request('/liff/portal', {}, env as unknown as Record<string, unknown>);
  expect(res.status).toBe(200);
  return res.text();
}

/** レンダリング済み HTML から inline <style> の中身を全部つないで返す。 */
export function extractStyles(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
}
