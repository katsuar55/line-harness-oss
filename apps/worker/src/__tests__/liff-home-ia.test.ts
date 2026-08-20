/**
 * Ultraplan PR-6b: home タブ IA 再編 (rank-hero + coupon-hub, gate LIFF_HOME_IA_ENABLED)。
 *
 * 方式は CSS order のみ (DOM/JS 不変) — 検証も出力ベースで行う:
 * - off (既定) = fragment を 1 byte も emit しない (dark)
 * - on = `.active` スコープ (外れると非表示タブが常時表示になる致命傷) と、
 *   台帳 HOME_IA_ORDER が home 直下の**実在する全要素**を網羅していること
 *   (行が無い要素は order:0 で先頭に紛れ込む) を固定する。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { liffPages } from '../routes/liff-pages.js';
import { HOME_IA_ORDER } from '../routes/liff-portal-fragments/home-ia.js';

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

/** home セクション直下 (深さ1) の id 付き要素を列挙する簡易パーサ。 */
function homeTopLevelIds(html: string): string[] {
  // home の直後のセクション見出し (INTAKE) までを切り出す — SHOP を anchor にすると
  // intake/quiz セクションまで飲み込み、他セクションの id を home 直下と誤認する
  const m = /<div id="section-home"[^>]*>([\s\S]*?)\n    <!-- ===== [A-Z]/.exec(html);
  expect(m, 'section-home の切り出しに失敗').toBeTruthy();
  const body = m![1];
  const ids: string[] = [];
  let depth = 0;
  for (const tag of body.matchAll(/<(\/?)div\b([^>]*)>/g)) {
    if (tag[1] === '/') {
      depth--;
      continue;
    }
    if (depth === 0) {
      const id = /id="([^"]+)"/.exec(tag[2]);
      if (id) ids.push(id[1]);
    }
    depth++;
  }
  return ids;
}

let htmlOn = '';
let htmlOff = '';
beforeAll(async () => {
  htmlOn = await portalHtml({ LIFF_HOME_IA_ENABLED: 'true', APP_PROXY_LINK_ENABLED: 'true', SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com' });
  htmlOff = await portalHtml({ APP_PROXY_LINK_ENABLED: 'true', SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com' });
});

describe('gate LIFF_HOME_IA_ENABLED (既定 off = 1 byte も出さない)', () => {
  it('off: order CSS も hub 見出しも emit されない', () => {
    expect(htmlOff).not.toContain('coupon-hub-head');
    expect(htmlOff).not.toContain('#section-home.active{display:flex');
    expect(htmlOff).not.toMatch(/#rank-card\{order:/);
  });

  it('on: order CSS + hub 見出しが emit される', () => {
    expect(htmlOn).toContain('id="coupon-hub-head"');
    expect(htmlOn).toContain('#section-home.active{display:flex;flex-direction:column;gap:1rem}');
  });
});

describe('IA 再編の安全条件', () => {
  it('🚨 flex 化は必ず .active にスコープされる (外すと非表示タブが常時表示になる)', () => {
    expect(htmlOn).toContain('#section-home.active{display:flex');
    // スコープ無しの素の #section-home{display:flex ...} が紛れ込んでいないこと
    expect(htmlOn).not.toMatch(/#section-home\{display:flex/);
  });

  it('space-y-4 の margin は gap に置換される (DOM 順 margin が視覚順とズレるため)', () => {
    expect(htmlOn).toContain('#section-home.active > *{margin-top:0 !important');
  });

  it('台帳 HOME_IA_ORDER が home 直下の実在要素を網羅する (行漏れ = order:0 で先頭に紛れ込む)', () => {
    const ids = homeTopLevelIds(htmlOn);
    expect(ids.length).toBeGreaterThanOrEqual(14);
    const ledger = new Map(HOME_IA_ORDER);
    for (const id of ids) {
      expect(ledger.has(id), 'home 直下の #' + id + ' が HOME_IA_ORDER 台帳に無い').toBe(true);
    }
    // 台帳の各行が CSS として emit されている
    for (const [id, n] of HOME_IA_ORDER) {
      expect(htmlOn).toContain('#' + id + '{order:' + n + '}');
    }
  });

  it('order 値は台帳内で一意 (重複すると DOM 順依存に戻り再編が silent に崩れる)', () => {
    const values = HOME_IA_ORDER.map(([, n]) => n);
    expect(new Set(values).size).toBe(values.length);
  });

  it('rank-hero: rank の order はクーポン群 (hub) より前・VITAL STRIP/次の一手より後', () => {
    const order = new Map(HOME_IA_ORDER);
    expect(order.get('rank-card')!).toBeLessThan(order.get('coupon-hub-head')!);
    expect(order.get('rank-card')!).toBeLessThan(order.get('coupons-card')!);
    expect(order.get('rank-card')!).toBeGreaterThan(order.get('vital-strip')!);
  });

  it('coupon-hub: 見出し + クーポン 5 面が連続 order (分断されない)', () => {
    const order = new Map(HOME_IA_ORDER);
    const hub = ['coupon-hub-head', 'coupons-card', 'welcome-coupon-card', 'referral-coupon-card', 'link-coupon-card', 'friend-coupon-card'];
    const ns = hub.map((id) => order.get(id)!);
    for (let i = 1; i < ns.length; i++) {
      expect(ns[i], hub[i] + ' が hub の連続 order から外れている').toBe(ns[i - 1] + 1);
    }
  });
});
