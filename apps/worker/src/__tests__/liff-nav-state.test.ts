/**
 * ポータルの「戻る」= 直前のタブ/位置へ (2026-08-25) の恒久ガード。
 *
 * 実機報告: 「ミニアプリ内で画面遷移して戻るボタンをタップすると、**すべて**
 * Shop タブの下部『再購入』に戻ってしまう」。
 *
 * 原因は 3 つの重なり (nav-state.ts 冒頭に詳述):
 *   ① リッチメニューの `#reorder` / 定期便リマインダーの `?page=reorder` を
 *      URL から消すコードが**存在しない** → 戻るたびに handleDeepLink が再発火
 *   ② タブがどこにも保存されていない (switchTab は history にも storage にも触らない)
 *   ③ no-store (#271) が bfcache を無効化 → 戻る = 完全リロードで JS 状態が消える
 *
 * ここでは①②の修正を、吐き出された client JS を**実際に評価して**固定する。
 * 「deep link は 1 回で使い切る」「戻ってきたときだけ復元する」の 2 つが要。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { navStateJs, navStateCss, NAV_SNAPSHOT_KEY, NAV_SNAPSHOT_TTL_MS } from '../routes/liff-portal-fragments/nav-state.js';

const root = dirname(fileURLToPath(import.meta.url));
const pagesSrc = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8').replace(/\r\n/g, '\n');

const NOW = 1_800_000_000_000;

interface NavApi {
  navActiveTab: () => string;
  navMarkTab: (name: string) => void;
  navStateTab: () => string | null;
  navReplaceUrl: (url: string) => void;
  navSnapshot: (via?: string) => void;
  navSnapshotRead: () => { tab: string; y: number; via: string; ts: number } | null;
  navIsReturn: () => boolean;
  navResolveEntry: () => { tab: string; y: number; source: string };
  navResolveOnce: () => { tab: string; y: number; source: string };
  navConsumeDeepLink: (tab: string) => void;
  navRestoreScroll: (y: unknown) => void;
  initNavState: () => void;
  applyNavEntry: () => { tab: string; y: number; source: string };
  setViaOverride: (v: string | null) => void;
}

interface Harness {
  api: NavApi;
  history: { state: unknown; replaced: string[]; scrollRestoration: string };
  session: Map<string, string>;
  url: URL;
  switched: Array<[string, unknown]>;
  deepLinkCalls: number;
  scrolledTo: number[];
  listeners: Record<string, Array<() => void>>;
  activeTab: { id: string };
}

interface HarnessOpts {
  href?: string;
  /** deepLinkDest() の返り値 (null = deep link 無し) */
  deepLink?: string | null;
  navType?: string;
  referrer?: string;
  state?: Record<string, unknown> | null;
  snapshot?: { tab: string; y: number; via: string; ts: number } | null;
  activeTab?: string;
  pageY?: number;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const url = new URL(opts.href ?? 'https://example.workers.dev/liff/portal');
  const session = new Map<string, string>();
  if (opts.snapshot !== undefined && opts.snapshot !== null) {
    session.set(NAV_SNAPSHOT_KEY, JSON.stringify(opts.snapshot));
  }
  const history = {
    state: opts.state ?? null,
    replaced: [] as string[],
    scrollRestoration: 'auto',
    replaceState(st: Record<string, unknown> | null, _t: string, u?: string) {
      history.state = st;
      if (u !== undefined) {
        history.replaced.push(u);
        const next = new URL(u, url.origin);
        url.href = next.href;
      }
    },
  };
  const listeners: Record<string, Array<() => void>> = {};
  const scrolledTo: number[] = [];
  const activeTab = { id: 'section-' + (opts.activeTab ?? 'home') };
  const win = {
    get location() {
      return { href: url.href, origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash };
    },
    history,
    sessionStorage: {
      getItem: (k: string) => (session.has(k) ? session.get(k)! : null),
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    },
    performance: {
      getEntriesByType: (t: string) => (t === 'navigation' ? [{ type: opts.navType ?? 'navigate' }] : []),
    },
    pageYOffset: opts.pageY ?? 0,
    innerHeight: 800,
    addEventListener: (type: string, fn: () => void) => void (listeners[type] ||= []).push(fn),
    scrollTo: (_x: number, y: number) => void scrolledTo.push(y),
  };
  const doc = {
    referrer: opts.referrer ?? '',
    visibilityState: 'visible',
    documentElement: { scrollHeight: 4000 },
    addEventListener: (type: string, fn: () => void) => void (listeners['doc:' + type] ||= []).push(fn),
    querySelector: (sel: string) => (sel === '.section.active' ? activeTab : null),
  };
  const switched: Array<[string, unknown]> = [];
  let deepLinkCalls = 0;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'window', 'document', 'Date', 'deepLinkDest', 'switchTab', 'handleDeepLink', 'setTimeout', 'URL',
    `${navStateJs()}
     return { navActiveTab: navActiveTab, navMarkTab: navMarkTab, navStateTab: navStateTab,
              navReplaceUrl: navReplaceUrl, navSnapshot: navSnapshot, navSnapshotRead: navSnapshotRead,
              navIsReturn: navIsReturn, navResolveEntry: navResolveEntry, navResolveOnce: navResolveOnce,
              navConsumeDeepLink: navConsumeDeepLink, navRestoreScroll: navRestoreScroll,
              initNavState: initNavState, applyNavEntry: applyNavEntry,
              setViaOverride: function (v) { navViaOverride = v; } };`,
  ) as (...a: unknown[]) => NavApi;

  const api = factory(
    win,
    doc,
    { now: () => NOW },
    () => (opts.deepLink === undefined ? null : opts.deepLink),
    (name: string, keepScroll: unknown) => void switched.push([name, keepScroll]),
    () => { deepLinkCalls++; },
    (cb: () => void) => { cb(); return 0; },
    URL,
  );
  return {
    api, history, session, url, switched, scrolledTo, listeners, activeTab,
    get deepLinkCalls() { return deepLinkCalls; },
  } as unknown as Harness;
}

// ───────────────────────── 行き先の決定 ─────────────────────────

describe('nav-state — 行き先の決定 (deep link > 復元 > 新規)', () => {
  it('リッチメニューからの新規入場は deep link が最優先', () => {
    const h = makeHarness({ href: 'https://example.workers.dev/liff/portal#reorder', deepLink: 'shop' });
    expect(h.api.navResolveEntry()).toEqual({ tab: 'shop', y: 0, source: 'deeplink' });
  });

  it('🚨 消費済み (nxTab あり) の履歴エントリでは deep link を再発火させない', () => {
    // これが実機報告の核心: #reorder が URL に残ったまま戻ると Shop へ引き戻されていた
    const h = makeHarness({
      href: 'https://example.workers.dev/liff/portal#reorder',
      deepLink: 'shop',
      state: { nxTab: 'home' },
      navType: 'back_forward',
      snapshot: { tab: 'home', y: 640, via: 'link', ts: NOW - 5000 },
    });
    expect(h.api.navResolveEntry()).toEqual({ tab: 'home', y: 640, source: 'restore' });
  });

  it('戻る (back_forward) + 退避があれば直前のタブと位置を復元する', () => {
    const h = makeHarness({
      navType: 'back_forward',
      snapshot: { tab: 'shop', y: 1200, via: 'link', ts: NOW - 1000 },
    });
    expect(h.api.navResolveEntry()).toEqual({ tab: 'shop', y: 1200, source: 'restore' });
  });

  it('別 LIFF ページからの前進遷移 (マイページ リンク) も「戻ってきた」と扱う', () => {
    const h = makeHarness({
      referrer: 'https://example.workers.dev/liff/my-rank',
      snapshot: { tab: 'intake', y: 300, via: 'link', ts: NOW - 1000 },
    });
    expect(h.api.navIsReturn()).toBe(true);
    expect(h.api.navResolveEntry()).toEqual({ tab: 'intake', y: 300, source: 'restore' });
  });

  it('ポータル自身からの referrer は「戻ってきた」に含めない', () => {
    const h = makeHarness({ referrer: 'https://example.workers.dev/liff/portal' });
    expect(h.api.navIsReturn()).toBe(false);
  });

  it('他サイトからの referrer は「戻ってきた」に含めない', () => {
    const h = makeHarness({ referrer: 'https://naturism-diet.com/cart' });
    expect(h.api.navIsReturn()).toBe(false);
  });

  it('🚨 新規に開いたときは復元しない (勝手に途中から始まらない)', () => {
    const h = makeHarness({ snapshot: { tab: 'shop', y: 900, via: 'link', ts: NOW - 1000 } });
    expect(h.api.navResolveEntry()).toEqual({ tab: 'home', y: 0, source: 'fresh' });
  });

  it('退避が古い (TTL 超過) なら復元しない', () => {
    const h = makeHarness({
      navType: 'back_forward',
      snapshot: { tab: 'shop', y: 900, via: 'link', ts: NOW - NAV_SNAPSHOT_TTL_MS - 1 },
    });
    expect(h.api.navResolveEntry().source).toBe('fresh');
  });

  it('退避のタブが履歴エントリのタブと違うときは位置を持ち込まない', () => {
    const h = makeHarness({
      state: { nxTab: 'quiz' },
      snapshot: { tab: 'shop', y: 900, via: 'link', ts: NOW - 1000 },
    });
    expect(h.api.navResolveEntry()).toEqual({ tab: 'quiz', y: 0, source: 'restore' });
  });

  it('未知のタブ名は home に丸める (壊れた退避で白画面にしない)', () => {
    const h = makeHarness({
      navType: 'back_forward',
      snapshot: { tab: 'evil', y: 10, via: 'link', ts: NOW - 1 } as never,
    });
    expect(h.api.navResolveEntry().tab).toBe('home');
  });

  it('壊れた JSON の退避でも落ちない', () => {
    const h = makeHarness({ navType: 'back_forward' });
    h.session.set(NAV_SNAPSHOT_KEY, '{not json');
    expect(h.api.navSnapshotRead()).toBeNull();
    expect(h.api.navResolveEntry().source).toBe('fresh');
  });

  it('navResolveOnce は 1 度だけ決めて憶える (途中で URL が変わっても答えがブレない)', () => {
    const h = makeHarness({ href: 'https://example.workers.dev/liff/portal#reorder', deepLink: 'shop' });
    const first = h.api.navResolveOnce();
    h.api.navConsumeDeepLink('shop'); // URL から hash が消える
    expect(h.api.navResolveOnce()).toBe(first);
  });
});

// ───────────────────────── deep link の消費 ─────────────────────────

describe('nav-state — deep link は 1 回で使い切る', () => {
  it('hash を落とし、この履歴エントリの行き先を nxTab に固定する', () => {
    const h = makeHarness({ href: 'https://example.workers.dev/liff/portal#reorder', deepLink: 'shop' });
    h.api.navConsumeDeepLink('shop');
    expect(h.history.replaced).toEqual(['/liff/portal']);
    expect(h.api.navStateTab()).toBe('shop');
  });

  it('🚨 ?page= も落とす (定期便リマインダー push は ?page=reorder でポータルを開く)', () => {
    const h = makeHarness({ href: 'https://example.workers.dev/liff/portal?page=reorder', deepLink: 'shop' });
    h.api.navConsumeDeepLink('shop');
    expect(h.history.replaced).toEqual(['/liff/portal']);
  });

  it('🚨 紹介コード ?ref= は消さない (claim 成立前に消すと紹介が二度と成立しない)', () => {
    const h = makeHarness({ href: 'https://example.workers.dev/liff/portal?ref=abc123#reorder', deepLink: 'shop' });
    h.api.navConsumeDeepLink('shop');
    expect(h.history.replaced).toEqual(['/liff/portal?ref=abc123']);
  });

  it('落とすものが無ければ URL を書き換えない (無意味な履歴操作をしない)', () => {
    const h = makeHarness({ href: 'https://example.workers.dev/liff/portal' });
    h.api.navConsumeDeepLink('home');
    expect(h.history.replaced).toEqual([]);
    expect(h.api.navStateTab()).toBe('home');
  });
});

// ───────────────────────── state / 退避 ─────────────────────────

describe('nav-state — 履歴エントリの state', () => {
  it('navMarkTab は既存の state キーを保つ', () => {
    const h = makeHarness({ state: { liffState: 'keep-me' } });
    h.api.navMarkTab('shop');
    expect(h.history.state).toEqual({ liffState: 'keep-me', nxTab: 'shop' });
  });

  it('🚨 navReplaceUrl は state を引き継ぐ (素の replaceState({}) は nxTab を消す)', () => {
    const h = makeHarness({ state: { nxTab: 'quiz' } });
    h.api.navReplaceUrl('/liff/portal?x=1');
    expect(h.history.state).toEqual({ nxTab: 'quiz' });
    expect(h.api.navStateTab()).toBe('quiz');
  });

  it('未知のタブ名は state に書かない', () => {
    const h = makeHarness();
    h.api.navMarkTab('evil');
    expect(h.api.navStateTab()).toBeNull();
  });
});

describe('nav-state — 離脱時の退避', () => {
  it('いま見ているタブとスクロール位置を書く', () => {
    const h = makeHarness({ activeTab: 'shop', pageY: 1234.6 });
    h.api.navSnapshot('link');
    expect(h.api.navSnapshotRead()).toEqual({ tab: 'shop', y: 1235, via: 'link', ts: NOW });
  });

  it('🚨 #rank の集約 redirect は via=replace として記録する (マイページ リンクが LINE を閉じないように)', () => {
    const h = makeHarness({ activeTab: 'home' });
    h.api.setViaOverride('replace');
    h.api.navSnapshot('link'); // pagehide が後から link で上書きしようとしても
    expect(h.api.navSnapshotRead()!.via).toBe('replace');
  });
});

// ───────────────────────── 適用 ─────────────────────────

describe('nav-state — 適用 (applyNavEntry)', () => {
  it('deep link 入場は従来どおり handleDeepLink (タブ切替 + アンカースクロール) を通す', () => {
    const h = makeHarness({ href: 'https://example.workers.dev/liff/portal#reorder', deepLink: 'shop' });
    h.api.applyNavEntry();
    expect(h.deepLinkCalls).toBe(1);
    expect(h.api.navStateTab()).toBe('shop');
  });

  it('復元入場はアンカースクロールを走らせず、直前の位置を戻す', () => {
    const h = makeHarness({
      navType: 'back_forward',
      snapshot: { tab: 'shop', y: 1200, via: 'link', ts: NOW - 1000 },
    });
    h.api.applyNavEntry();
    expect(h.deepLinkCalls).toBe(0);
    expect(h.switched).toEqual([['shop', true]]); // keepScroll = true (scrollTo(0) と綱引きしない)
    expect(h.scrolledTo.length).toBeGreaterThan(0);
    expect(h.scrolledTo[0]).toBe(1200);
  });

  it('home への復元では switchTab を呼ばない (既定で active なので無駄な再描画をしない)', () => {
    const h = makeHarness({
      navType: 'back_forward',
      snapshot: { tab: 'home', y: 480, via: 'link', ts: NOW - 1000 },
    });
    h.api.applyNavEntry();
    expect(h.switched).toEqual([]);
    expect(h.scrolledTo[0]).toBe(480);
  });

  it('新規入場ではスクロールを復元しない', () => {
    const h = makeHarness();
    h.api.applyNavEntry();
    expect(h.switched).toEqual([]);
    expect(h.scrolledTo).toEqual([]);
  });

  it('復元位置は本文の高さでクランプする (伸びる前の高さで飛びすぎない)', () => {
    const h = makeHarness({ navType: 'back_forward', snapshot: { tab: 'home', y: 99999, via: 'link', ts: NOW } });
    h.api.applyNavEntry();
    expect(h.scrolledTo[0]).toBe(4000 - 800);
  });
});

describe('nav-state — 配線', () => {
  it('initNavState はブラウザ既定のスクロール復元を切る (アプリ側の復元と綱引きしない)', () => {
    const h = makeHarness();
    h.api.initNavState();
    expect(h.history.scrollRestoration).toBe('manual');
  });

  it('離脱 (pagehide / visibilitychange) で退避する', () => {
    const h = makeHarness({ activeTab: 'quiz', pageY: 77 });
    h.api.initNavState();
    expect(h.listeners['pagehide']?.length).toBe(1);
    expect(h.listeners['doc:visibilitychange']?.length).toBe(1);
    h.listeners['pagehide'][0]();
    expect(h.api.navSnapshotRead()).toEqual({ tab: 'quiz', y: 77, via: 'link', ts: NOW });
  });
});

// ───────────────────────── ソース側の契約 (ここが切れると黙って元に戻る) ─────────────────────────

describe('nav-state — liff-pages.ts への配線', () => {
  it('initLiff が initNavState → navResolveOnce → applyNavEntry の順で呼ぶ', () => {
    const iInit = pagesSrc.indexOf('initNavState();');
    const iResolve = pagesSrc.indexOf('navResolveOnce()');
    const iApply = pagesSrc.indexOf('applyNavEntry();');
    expect(iInit).toBeGreaterThan(-1);
    expect(iResolve).toBeGreaterThan(iInit);
    expect(iApply).toBeGreaterThan(iResolve);
  });

  it('🚨 旧経路の裸の handleDeepLink() 呼び出しは残っていない (残ると deep link が二重発火)', () => {
    expect(pagesSrc).not.toMatch(/\n\s*handleDeepLink\(\);/);
  });

  it('🚨 URL を書き換える既存箇所は navReplaceUrl を通る (素の replaceState は nxTab を消す)', () => {
    expect(pagesSrc).not.toMatch(/history\.replaceState\(\{\}/);
    const clearRef = pagesSrc.match(/function clearRefParam\(\) \{[\s\S]*?\n\}/);
    expect(clearRef![0]).toContain('navReplaceUrl(');
    const capture = pagesSrc.match(/function captureSubLinkToken\(\) \{[\s\S]*?\n\}/);
    expect(capture![0]).toContain('navReplaceUrl(');
  });

  it('switchTab は keepScroll を受け取り、タブを履歴エントリに記録する', () => {
    const fn = pagesSrc.match(/function switchTab\(name, keepScroll\) \{[\s\S]*?\n\}/);
    expect(fn).toBeTruthy();
    expect(fn![0]).toContain('if (!keepScroll) { window.scrollTo(');
    expect(fn![0]).toContain('navMarkTab(name)');
  });

  it('🚨 bootstrap の早期 reveal は確定した行き先を見る (deepLinkDest だと復元入場でタブが飛ぶ)', () => {
    const fn = pagesSrc.match(/async function bootstrapPortal\(\) \{[\s\S]*?\n\}/);
    expect(fn![0]).toContain('navResolveOnce().tab');
    expect(fn![0]).not.toMatch(/var dest = deepLinkDest\(\);/);
  });

  it('#rank の集約 redirect の直前に via=replace を記録する', () => {
    const i = pagesSrc.indexOf("location.replace('/liff/my-rank')");
    const seg = pagesSrc.slice(Math.max(0, i - 400), i);
    expect(seg).toContain("navViaOverride = 'replace'");
    expect(seg).toContain("navSnapshot('replace')");
  });

  it('着地点がヘッダ下に潜らないよう scroll-margin を持つ', () => {
    expect(navStateCss()).toContain('scroll-margin-top:110px');
    for (const id of ['#orders-card', '#fulfillments-card', '#rank-card']) {
      expect(navStateCss()).toContain(id);
    }
  });
});
