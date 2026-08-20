/**
 * Ultraplan PR-7/8: 視覚刷新 v2 (gate LIFF_VISUAL_V2_ENABLED)。
 *
 * 装飾 CSS のみ (レイアウト/JS/DOM 不変・新色ゼロ)。固定するのは:
 * - off (既定) = 1 byte も emit しない (dark)
 * - Ambassador の金装 (.rank-ambassador) を id セレクタで潰さないこと
 * - 新色ゼロ (既存トークン var(--...) と白のみ — §7-1 コントラスト宣言表を増やさない)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { liffPages } from '../routes/liff-pages.js';
import { visualV2Css } from '../routes/liff-portal-fragments/visual-v2.js';

const baseEnv = {
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
  WORKER_URL: 'https://example.workers.dev',
};

async function portalHtml(extra: Record<string, string> = {}): Promise<string> {
  const env = { ...baseEnv, ...extra };
  const res = await liffPages.request('/liff/portal', {}, env as unknown as Record<string, unknown>);
  expect(res.status).toBe(200);
  return res.text();
}

let htmlOn = '';
let htmlOff = '';
beforeAll(async () => {
  htmlOn = await portalHtml({ LIFF_VISUAL_V2_ENABLED: 'true' });
  htmlOff = await portalHtml();
});

describe('gate LIFF_VISUAL_V2_ENABLED (既定 off = 1 byte も出さない)', () => {
  it('off: visual-v2 の CSS が emit されない', () => {
    expect(htmlOff).not.toContain('visual-v2');
    expect(htmlOff).not.toContain('#rank-card:not(.rank-ambassador)');
  });

  it('on: 主役カード 2 面の計器レール天冠が emit される', () => {
    expect(htmlOn).toContain('#rank-card:not(.rank-ambassador){background:var(--grad-vital) top/100% 3px no-repeat,#ffffff');
    expect(htmlOn).toContain('#sub-contracts-card{background:var(--grad-vital) top/100% 3px no-repeat,#ffffff');
    expect(htmlOn).toContain('#coupon-hub-head::after');
  });
});

describe('視覚刷新の安全条件', () => {
  it('🚨 Ambassador の金装を潰さない: rank-card への background 上書きは :not(.rank-ambassador) 必須', () => {
    // 素の #rank-card{ で始まる rule (Ambassador にも効いてしまう) が無いこと
    expect(visualV2Css()).not.toMatch(/#rank-card\{/);
    expect(visualV2Css()).toContain('#rank-card:not(.rank-ambassador){');
  });

  it('新色ゼロ: raw hex は白 (#ffffff) 以外に存在しない (§7-1 宣言表を増やさない)', () => {
    const hexes = [...visualV2Css().matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
      .map((m) => m[0].toLowerCase())
      .filter((h) => /^#[0-9a-f]{3,8}$/.test(h));
    for (const h of hexes) {
      expect(h, '新色 ' + h + ' — visual-v2 はトークンと白のみで書く契約').toBe('#ffffff');
    }
    expect(visualV2Css()).toContain('var(--grad-vital)');
    expect(visualV2Css()).toContain('var(--shadow-float)');
  });

  it('::before を使わない (.rank-ambassador::before の sparkle と衝突するため)', () => {
    expect(visualV2Css()).not.toContain('::before');
  });
});
