/**
 * VITAL STRIP (デザイン仕様書 §3 / PR-2) の恒久ガード。
 *
 * 設計の要は「**追加 fetch ゼロ**」— 既存 loader が取ったデータを寄せるだけ。
 * そのため各 loader からの `vsSetCoupons` / `vsSetRank` / `vsSetLinked` が唯一の連絡経路で、
 * ここが漏れると strip の表示が黙って実態とズレる (カードは出ているのに「0 枚」等)。
 * 静的検査 (構造・規約・色) と、実ロジックを DOM スタブで走らせる検証の 2 軸で固定する。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
// CRLF のまま正規表現を当てるとブロック抽出が外れ、測定器が無力化する
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8').replace(/\r\n/g, '\n');

const block = pages.match(
  /window\.__vsCoupons = \{[\s\S]*?\nfunction vsLinkTap\(\) \{[\s\S]*?\n\}/,
);

interface FakeEl {
  id: string;
  className: string;
  textContent: string;
  style: { setProperty: (k: string, v: string) => void; props: Record<string, string> };
}

function makeEl(id: string): FakeEl {
  const props: Record<string, string> = {};
  return {
    id,
    className: '',
    textContent: '',
    style: { setProperty: (k, v) => { props[k] = v; }, props },
  };
}

/** strip の公開関数。`never[]` にすると呼び出し側の引数が全部型エラーになるので明示する */
interface StripApi {
  vsSetCoupons: (key: string, n: unknown) => void;
  vsSetRank: (rank: { name?: string; icon?: string } | null, pct: unknown) => void;
  vsSetLinked: (linked: boolean) => void;
  vsJumpRank: () => void;
  vsJumpCoupons: () => void;
  vsJumpReferral: () => void;
  vsLinkTap: () => void;
  vsCouponTotal: () => number;
  updateVsCouponCell: () => void;
}

interface Harness {
  els: Record<string, FakeEl>;
  scrolled: string[];
  linkPageOpened: number;
  referralScrolled: number;
  api: StripApi;
  win: Record<string, unknown>;
}

function makeHarness(opts: { reducedMotion?: boolean } = {}): Harness {
  if (!block) throw new Error('VITAL STRIP block not found in liff-pages.ts');
  const ids = [
    'vs-ring', 'vs-rank-icon', 'vs-rank-sub',
    'vs-coupon-n', 'vs-coupon-sub', 'vs-coupon-cell',
    'vs-link-dot', 'vs-link-sub',
    'rank-card', 'coupons-card', 'referral-card',
  ];
  const els: Record<string, FakeEl> = {};
  for (const id of ids) {
    els[id] = makeEl(id);
    // scrollIntoView を持たせて、跳び先を記録する
    (els[id] as unknown as Record<string, unknown>).scrollIntoView = () => { scrolled.push(id); };
  }
  const scrolled: string[] = [];
  const win: Record<string, unknown> = {};
  let linkPageOpened = 0;
  let referralScrolled = 0;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'document', 'window', 'TAB_REDUCED_MOTION', 'requestAnimationFrame',
    'scrollToReferralCard', 'openShopifyLinkPage',
    `${block[0]}
     return { vsSetCoupons: vsSetCoupons, vsSetRank: vsSetRank, vsSetLinked: vsSetLinked,
              vsJumpRank: vsJumpRank, vsJumpCoupons: vsJumpCoupons, vsJumpReferral: vsJumpReferral,
              vsLinkTap: vsLinkTap, vsCouponTotal: vsCouponTotal,
              updateVsCouponCell: updateVsCouponCell };`,
  ) as (...a: unknown[]) => StripApi;

  const api = factory(
    { getElementById: (id: string) => els[id] ?? null },
    win,
    // 既定は reduced-motion 扱い = count-up を即値にして決定的にテストする
    opts.reducedMotion !== false,
    // worker の tsconfig に DOM lib は無いので FrameRequestCallback は使わない
    (cb: (t: number) => void) => { cb(0); return 0; },
    () => { referralScrolled++; },
    () => { linkPageOpened++; },
  );
  return {
    els, scrolled,
    get linkPageOpened() { return linkPageOpened; },
    get referralScrolled() { return referralScrolled; },
    api, win,
  } as unknown as Harness;
}

describe('VITAL STRIP — 静的構造 (§4-1 の ID 契約)', () => {
  it('home セクションの先頭 (welcome クーポンより前) に置かれている', () => {
    const home = pages.indexOf('<div id="section-home"');
    const strip = pages.indexOf('id="vital-strip"');
    const welcome = pages.indexOf('id="welcome-coupon-card"');
    expect(home).toBeGreaterThan(0);
    expect(strip).toBeGreaterThan(home);
    expect(strip).toBeLessThan(welcome);
  });

  it('必要な ID が揃っている', () => {
    for (const id of ['vital-strip', 'vs-ring', 'vs-rank-icon', 'vs-rank-sub', 'vs-coupon-n',
      'vs-coupon-sub', 'vs-coupon-cell', 'vs-link-cell', 'vs-link-dot', 'vs-link-sub']) {
      expect(pages).toContain(`id="${id}"`);
    }
  });

  it('スクリーンリーダー向けの説明がある (アイコンだけの意味を文字で補う)', () => {
    expect(pages).toContain('role="group"');
    expect(pages).toContain('aria-label="あなたの現在ステータス"');
    expect(pages).toContain('aria-label="会員ランクの詳細へ"');
    expect(pages).toContain('aria-label="クーポン一覧へ"');
    expect(pages).toContain('aria-label="ストア連携の状態"');
    expect(pages).toContain('aria-hidden="true"'); // 区切り線は読み上げない
  });

  it('既存 ID の契約を壊していない (§4-1 の抜き取り確認)', () => {
    for (const id of ['section-home', 'rank-card', 'coupons-card', 'referral-card',
      'welcome-coupon-card', 'link-coupon-card', 'badge-card', 'next-move-card']) {
      expect(pages).toContain(`id="${id}"`);
    }
  });
});

describe('VITAL STRIP — 安全規約', () => {
  it('onclick は名前付き関数のみ (引用符ネスト禁止)', () => {
    const stripHtml = pages.slice(pages.indexOf('id="vital-strip"'), pages.indexOf('id="welcome-coupon-card"'));
    const onclicks = [...stripHtml.matchAll(/onclick="([^"]*)"/g)].map((m) => m[1]);
    expect(onclicks.length).toBe(3);
    for (const h of onclicks) expect(h).toMatch(/^[A-Za-z_$][\w$]*\(\)$/);
  });

  it('🚨追加 fetch ゼロ — strip のロジックは API を呼ばない', () => {
    const src = block ? block[0] : '';
    expect(src.length).toBeGreaterThan(500); // 抽出できていること
    for (const bad of ['api(', 'apiGet(', 'fetch(', 'XMLHttpRequest']) {
      expect(src).not.toContain(bad);
    }
  });

  it('ブランド原色ティールをポータルに持ち込まない (§7-1)', () => {
    const css = pages.slice(pages.indexOf('.vs-grid{'), pages.indexOf('#vital-strip .vs-cell:nth-of-type(3)'));
    expect(css).not.toMatch(/#0abab5/i);
  });

  it('新しいアニメーションを作らない (モーション憲法: 動く枠は .ref-hero 1 枚だけ)', () => {
    const rules = [...pages.matchAll(/(?:^|\n)\s*(?:#vital-strip )?\.vs-[\w-]*(?:[.:][\w-]+)*\{[^}]*\}/g)].map((m) => m[0]);
    expect(rules.length).toBeGreaterThan(5);
    for (const r of rules) {
      // animation-delay は既存 shimmer のずらしなので可。animation の**新規定義**は不可
      expect(r).not.toMatch(/animation:/);
      expect(r).not.toContain('@keyframes');
    }
  });

  it('タップ域は 56px 以上 (60代のタップ精度)', () => {
    expect(pages).toMatch(/\.vs-cell\{[^}]*min-height:56px/);
  });
});

describe('VITAL STRIP — クーポン枚数 (5 系統の合算)', () => {
  it('互いに素な 5 系統を合算する', () => {
    const h = makeHarness();
    h.api.vsSetCoupons('list', 2);
    h.api.vsSetCoupons('welcome', 1);
    h.api.vsSetCoupons('referral', 3);
    h.api.vsSetCoupons('link', 1);
    h.api.vsSetCoupons('friend', 1);
    expect(h.api.vsCouponTotal()).toBe(8);
    expect(h.els['vs-coupon-n'].textContent).toBe('8');
    expect(h.els['vs-coupon-sub'].textContent).toBe('使えます');
    expect(h.els['vs-coupon-sub'].className).toContain('is-ok');
  });

  it('🚨set であって increment ではない (loader の再試行で二重計上しない)', () => {
    const h = makeHarness();
    h.api.vsSetCoupons('welcome', 1);
    h.api.vsSetCoupons('welcome', 1);
    h.api.vsSetCoupons('welcome', 1);
    expect(h.api.vsCouponTotal()).toBe(1);
  });

  it('0 枚は「無い」で終わらせず「もらう →」へ (空状態の回遊化)', () => {
    const h = makeHarness();
    h.api.vsSetCoupons('list', 0);
    expect(h.els['vs-coupon-n'].textContent).toBe('–');
    expect(h.els['vs-coupon-sub'].textContent).toBe('もらう →');
    expect(h.els['vs-coupon-sub'].className).toContain('is-ng');
  });

  it('枚数が 0 に戻ったら表示も 0 状態へ戻る (古い数字を残さない)', () => {
    const h = makeHarness();
    h.api.vsSetCoupons('welcome', 1);
    expect(h.els['vs-coupon-n'].textContent).toBe('1');
    h.api.vsSetCoupons('welcome', 0);
    expect(h.els['vs-coupon-n'].textContent).toBe('–');
  });

  it('壊れた値 (NaN / undefined) は 0 として扱い、NaN を表示しない', () => {
    const h = makeHarness();
    h.api.vsSetCoupons('list', 'abc');
    h.api.vsSetCoupons('welcome', undefined);
    expect(h.api.vsCouponTotal()).toBe(0);
    expect(h.els['vs-coupon-n'].textContent).toBe('–');
  });
});

describe('VITAL STRIP — ランクと連携の表示', () => {
  it('ランク名とアイコンと進捗リングを埋める', () => {
    const h = makeHarness();
    h.api.vsSetRank({ name: 'Silver', icon: '🥈' }, 42);
    expect(h.els['vs-rank-icon'].textContent).toBe('🥈');
    expect(h.els['vs-rank-sub'].textContent).toBe('Silver');
    expect(h.els['vs-ring'].style.props['--p']).toBe('42%');
  });

  it('進捗は 0-100 にクランプする (リングが一周以上回らない)', () => {
    const h = makeHarness();
    h.api.vsSetRank({ name: 'Gold' }, 250);
    expect(h.els['vs-ring'].style.props['--p']).toBe('100%');
    h.api.vsSetRank({ name: 'Gold' }, -5);
    expect(h.els['vs-ring'].style.props['--p']).toBe('0%');
  });

  it('未購入 (ランクなし) は「はじめて」— 死んだグレー行にしない', () => {
    const h = makeHarness();
    h.api.vsSetRank(null, 0);
    expect(h.els['vs-rank-sub'].textContent).toBe('はじめて');
  });

  it('🚨連携状態は色と文字の二重符号化 (色覚対応)', () => {
    const h = makeHarness();
    h.api.vsSetLinked(true);
    expect(h.els['vs-link-dot'].className).toContain('is-on');
    expect(h.els['vs-link-sub'].textContent).toBe('連携済み');
    h.api.vsSetLinked(false);
    expect(h.els['vs-link-dot'].className).toContain('is-off');
    expect(h.els['vs-link-sub'].textContent).toBe('未連携 →');
  });
});

describe('VITAL STRIP — 跳び先 (行き止まりを作らない)', () => {
  it('ランクセルはランクカードへ', () => {
    const h = makeHarness();
    h.api.vsJumpRank();
    expect(h.scrolled).toEqual(['rank-card']);
  });

  it('クーポンが 1 枚以上ならクーポンカードへ', () => {
    const h = makeHarness();
    h.api.vsSetCoupons('welcome', 1);
    h.api.vsJumpCoupons();
    expect(h.scrolled).toEqual(['coupons-card']);
  });

  it('🚨クーポン 0 枚のときは空表示でなく「もらう」導線へ跳ぶ', () => {
    const h = makeHarness();
    h.api.vsJumpCoupons();
    expect(h.scrolled).toEqual([]); // coupons-card へは行かない
    expect(h.referralScrolled).toBe(1);
  });

  it('連携セル: 未連携なら連携ページ、連携済みならランクへ', () => {
    const h = makeHarness();
    h.api.vsLinkTap();
    expect(h.linkPageOpened).toBe(1);
    (h.win as Record<string, unknown>).__shopifyLinked = true;
    h.api.vsLinkTap();
    expect(h.linkPageOpened).toBe(1); // 増えない
    expect(h.scrolled).toEqual(['rank-card']);
  });
});

describe('VITAL STRIP — 既存 loader への配線', () => {
  it('5 系統すべてが成功時と 0 件時の両方で set する', () => {
    for (const key of ['list', 'welcome', 'referral', 'link', 'friend']) {
      const calls = [...pages.matchAll(new RegExp(`vsSetCoupons\\('${key}',`, 'g'))];
      // 成功時 (件数) と 0 件時 の最低 2 箇所
      expect(calls.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('loadRank がランクと連携の両方を strip へ流す', () => {
    const fn = pages.match(/async function loadRank\(\) \{[\s\S]*?\n\}/);
    expect(fn).toBeTruthy();
    expect(fn![0]).toContain('vsSetRank(');
    expect(fn![0]).toContain('vsSetLinked(');
  });

  it('🚨markShopifyLinked が連携成立の瞬間に strip を同期する', () => {
    const fn = pages.match(/function markShopifyLinked\(\) \{[\s\S]*?\n\}/);
    expect(fn).toBeTruthy();
    expect(fn![0]).toContain('vsSetLinked(true)');
  });

  it('連携の向きは単調 (loadRank が遅れて false を運んでも on を落とさない)', () => {
    const fn = pages.match(/async function loadRank\(\) \{[\s\S]*?\n\}/);
    expect(fn![0]).toContain('window.__shopifyLinked === true || !!data.linked');
  });
});
