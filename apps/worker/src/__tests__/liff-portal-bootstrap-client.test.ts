/**
 * Ultraplan PR-3: /liff/portal の client が portal-bootstrap 1 往復で初期化する経路。
 *
 * gate PORTAL_BOOTSTRAP_ENABLED (既定 off) で配線し、
 * - off = 従来経路が 1 bit も変わらないこと (PORTAL_BOOTSTRAP_ON=false + 旧 Promise.all 温存)
 * - on = bootstrap 成功で個別 section fetch が発生しないこと (実機期待値: bootstrap + intake/streak の 2 本)
 * - section 単位の失敗は該当 loader だけが個別 fetch へ落ちること (他カードへ伝播しない)
 * - bootstrap 呼び出し自体の失敗は false を返し旧経路へ丸ごとフォールバックすること
 * - 全画面 #loading は rank 初回描画で解除されること (残り loader が未 settle でも)
 * を、**吐き出された client JS を実際に評価して**観測する (regex 検査だけにしない —
 * 2026-07-10 / 07-26 の教訓。ハーネスの視力は「見えるはずのものが見える」ドリルで別途確認する)。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { liffPages } from '../routes/liff-pages.js';

interface MinimalEnv {
  LIFF_URL: string;
  WORKER_URL: string;
  PORTAL_BOOTSTRAP_ENABLED?: string;
}

const baseEnv: MinimalEnv = {
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
  WORKER_URL: 'https://example.workers.dev',
};

async function portalHtml(extra: Partial<MinimalEnv> = {}): Promise<string> {
  const env = { ...baseEnv, ...extra };
  const res = await liffPages.request('/liff/portal', {}, env as unknown as Record<string, unknown>);
  expect(res.status).toBe(200);
  return res.text();
}

function inlineScript(html: string): string {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const withInit = scripts.filter((s) => s.includes('bootstrapPortal'));
  expect(withInit.length, 'bootstrapPortal を含む inline script が 1 本あること').toBe(1);
  return withInit[0];
}

// ───────────────────────── ミニ DOM (loader が触る要素だけ実在させる) ─────────────────────────

interface FakeEl {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  classes: Set<string>;
  _html: string;
  innerHTML: string;
  classList: { add(c: string): void; remove(c: string): void };
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(): void;
}

function el(tagName: string, id = ''): FakeEl {
  const node: FakeEl = {
    tagName,
    id,
    className: '',
    textContent: '',
    style: {},
    attrs: {},
    classes: new Set<string>(),
    _html: '',
    get innerHTML() {
      return node._html;
    },
    set innerHTML(html: string) {
      node._html = html;
    },
    classList: {
      add: (c: string) => void node.classes.add(c),
      remove: (c: string) => void node.classes.delete(c),
    },
    setAttribute(k, v) {
      node.attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null;
    },
    addEventListener() {},
  };
  return node;
}

// loader 群が初期化経路で触る id。実在させないと null 参照で catch に落ち、
// 「描画された」ことも「エラーに落ちた」ことも観測できなくなる
const CARD_IDS = [
  'loading',
  'rank-card',
  'tip-card',
  'coupons-card',
  'welcome-coupon-card',
  'referral-coupon-card',
  'link-coupon-card',
  'friend-coupon-card',
  'referral-card',
  'ranking-card',
  'ambassador-section',
  'ambassador-status-card',
  'badge-level-num',
  'badge-score',
  'badge-pts-next',
  'badge-progress-bar',
  'badge-grid',
  'intake-streak-num',
];

interface FetchCall {
  path: string;
}

interface Sandbox {
  fn: Record<string, (...a: never[]) => unknown>;
  byId: Map<string, FakeEl>;
  win: Record<string, unknown>;
  calls: FetchCall[];
  /** 次の fetch 応答を path prefix で解決する。無ければ 200 { success:true, data:null }。 */
  respond: Map<string, { status: number; json: unknown } | 'never' | 'reject'>;
}

function loadSandbox(script: string, opts: { hash?: string; search?: string } = {}): Sandbox {
  const byId = new Map<string, FakeEl>(CARD_IDS.map((id) => [id, el('div', id)]));
  const calls: FetchCall[] = [];
  const respond: Sandbox['respond'] = new Map();

  const doc = {
    addEventListener() {},
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [] as FakeEl[],
    createElement: (t: string) => el(t),
    body: el('body'),
  };
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  const win: Record<string, unknown> = {
    sessionStorage: storage,
    localStorage: storage,
    location: {
      href: 'https://example.workers.dev/liff/portal' + (opts.search ?? ''),
      search: opts.search ?? '',
      hash: opts.hash ?? '',
      reload() {},
      replace() {},
    },
    history: { replaceState() {} },
    addEventListener() {},
    scrollTo() {},
  };
  const fakeFetch = (url: string) => {
    const path = String(url).replace(baseEnv.WORKER_URL, '');
    calls.push({ path });
    for (const [prefix, resp] of respond) {
      if (path.indexOf(prefix) === 0) {
        if (resp === 'never') return new Promise(() => {});
        if (resp === 'reject') return Promise.reject(new Error('network down'));
        return Promise.resolve({ status: resp.status, json: () => Promise.resolve(resp.json) });
      }
    }
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ success: true, data: null }) });
  };

  const EXPORTS = ['bootstrapPortal', 'bootstrapSection', 'revealLoading', 'loadTip', 'loadRank', 'initLiff'];
  const factory = new Function(
    'window',
    'document',
    'location',
    'sessionStorage',
    'localStorage',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'fetch',
    'console',
    'liff',
    script + '\n;return { ' + EXPORTS.map((n) => n + ': ' + n).join(', ') + ' };',
  );
  const fn = factory(
    win,
    doc,
    win.location,
    storage,
    storage,
    (cb: () => void) => {
      // 本経路 (queued 0 / IO 非対応) では timer は発生しない前提。発生したら実行せず捨てる
      void cb;
      return 0;
    },
    () => {},
    () => 0,
    fakeFetch,
    { log() {}, warn() {}, error() {} },
    // initLiff を末端まで走らせる最小 stub (login 済み・token あり・profile 画像なし)
    {
      init: () => Promise.resolve(),
      isLoggedIn: () => true,
      login: () => {},
      getIDToken: () => 'tok_test',
      getProfile: () => Promise.resolve({}),
      getDecodedIDToken: () => ({ sub: 'U_alice' }),
      isApiAvailable: () => false,
    },
  ) as Sandbox['fn'];
  return { fn, byId, win, calls, respond };
}

/** promise microtask を捌く。 */
const tick = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

// rank section の data (個別 POST /api/liff/rank の data と同 shape)。フォールバック検証でも使う。
const RANK_DATA = {
  linked: false,
  currentRank: { name: 'Silver', color: '#C0C0C0', icon: 'Ag' },
  totalSpent: 15000,
  ordersCount: 3,
  nextRank: { name: 'Gold', minTotalSpent: 24000, remaining: 9000 },
  progressPercent: 25,
  allRanks: [],
};

// bootstrap の正常応答 fixture (全 14 section ok)。data は個別 endpoint の data と同 shape。
function bootstrapOkJson() {
  const ok = (data: unknown) => ({ ok: true, data });
  return {
    success: true,
    data: {
      rank: ok(JSON.parse(JSON.stringify(RANK_DATA))),
      coupons: ok({ coupons: [] }),
      welcomeCoupon: ok({ coupon: null }),
      referralCoupon: ok({ coupons: [], count: 0, queuedCount: 0 }),
      linkCoupon: ok({ coupon: null }),
      friendCoupon: ok({ enabled: false }),
      referral: ok({ totalReferred: 2, refCode: 'ref_abc123', hasLink: true }),
      ranking: ok([]),
      ambassador: ok(null),
      tip: ok({ title: '水分補給のコツ', content: 'こまめな水分補給が大切です。' }),
      profile: ok({}),
      intakeToday: ok({
        date: '2026-08-20',
        recorded: { breakfast: false, lunch: false, dinner: false, snack: false },
      }),
      badges: ok({ allBadges: [], earnedBadges: [], level: 1, score: 0, pointsToNext: 100 }),
      language: ok({ lang: 'ja' }),
    },
  };
}

// 初期化バッチが束ねる個別 section endpoint (bootstrap 成功時は 1 本も呼ばれないはずの群)。
// intake/streak は bootstrap の外 (別 endpoint) なので含めない。
const SECTION_ENDPOINTS = [
  '/api/liff/rank',
  '/api/liff/coupons',
  '/api/liff/welcome-coupon',
  '/api/liff/referral-coupon',
  '/api/liff/link-coupon',
  '/api/liff/friend-coupon',
  '/api/liff/referral/stats',
  '/api/liff/referral/generate',
  '/api/liff/referral/ranking',
  '/api/liff/ambassador/status',
  '/api/liff/tips/today',
  '/api/liff/profile',
  '/api/liff/intake/today',
  '/api/liff/badges',
  '/api/liff/language',
];

let scriptOn = '';
let scriptOff = '';
beforeAll(async () => {
  scriptOn = inlineScript(await portalHtml({ PORTAL_BOOTSTRAP_ENABLED: 'true' }));
  scriptOff = inlineScript(await portalHtml());
});

// ───────────────────────── gate 注入と旧経路の温存 ─────────────────────────

describe('gate PORTAL_BOOTSTRAP_ENABLED の注入 (既定 off = dark)', () => {
  it('gate off (既定) → PORTAL_BOOTSTRAP_ON=false で旧経路がそのまま残る', () => {
    expect(scriptOff).toContain('const PORTAL_BOOTSTRAP_ON = false;');
    // 旧経路 (13 loader Promise.all → initOptInCard → initAccountHint → loadRank) の温存
    const batch = scriptOff.indexOf('await Promise.all([loadLanguage()');
    const optIn = scriptOff.indexOf('initOptInCard();');
    const rank = scriptOff.indexOf('await loadRank();');
    expect(batch).toBeGreaterThan(-1);
    expect(optIn).toBeGreaterThan(batch);
    expect(rank).toBeGreaterThan(optIn);
  });

  it('gate on → PORTAL_BOOTSTRAP_ON=true が注入される', () => {
    expect(scriptOn).toContain('const PORTAL_BOOTSTRAP_ON = true;');
  });

  it('bootstrap の分岐は旧 Promise.all より前 (= 成功時に旧経路を撃たない)', () => {
    const branch = scriptOn.indexOf('if (PORTAL_BOOTSTRAP_ON)');
    const batch = scriptOn.indexOf('await Promise.all([loadLanguage()');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(batch);
  });

  it('bootstrapPortal 内は ambassador → rank → revealLoading の順 (rank 装飾と #loading 契約)', () => {
    const amb = scriptOn.indexOf("loadAmbassador(bootstrapSection(s, 'ambassador'))");
    const rank = scriptOn.indexOf("loadRank(bootstrapSection(s, 'rank'))");
    const reveal = scriptOn.indexOf("if (!dest || dest === 'home') { revealLoading(); }");
    expect(amb).toBeGreaterThan(-1);
    expect(rank).toBeGreaterThan(amb);
    expect(reveal).toBeGreaterThan(rank);
  });

  it('旧 13-fetch バッチは !bootstrapped ガード内・else 側は後処理のみ (採点ループ R1: 隣接固定)', () => {
    // 順序 (indexOf) だけの検査は「if (true) 化 = bootstrap 成功後に旧バッチを無条件再実行」の
    // mutation を素通りさせる (実測 4,867 テスト green)。ガードとバッチの隣接を直接固定する。
    expect(scriptOn).toMatch(/if \(!bootstrapped\) \{\s*await Promise\.all\(\[loadLanguage\(\)/);
    expect(scriptOn).toMatch(/\} else \{\s*(?:\/\/[^\r\n]*\s*)*initOptInCard\(\);\s*initAccountHint\(\);/);
  });
});

// ───────────────────────── 挙動 (吐き出された JS を実行して観測) ─────────────────────────

describe('bootstrap 成功 — 個別 section fetch ゼロで全カード描画', () => {
  it('fetch は bootstrap + intake/streak の 2 本だけ (実機の期待リクエスト数)', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('/api/liff/portal-bootstrap', { status: 200, json: bootstrapOkJson() });
    sb.respond.set('/api/liff/intake/streak', {
      status: 200,
      json: { success: true, data: { currentStreak: 5 } },
    });
    const result = await (sb.fn.bootstrapPortal as unknown as () => Promise<boolean>)();
    await tick();
    expect(result).toBe(true);
    const paths = sb.calls.map((c) => c.path);
    expect(paths.filter((p) => p.indexOf('/api/liff/portal-bootstrap') === 0).length).toBe(1);
    for (const ep of SECTION_ENDPOINTS) {
      expect(paths, ep + ' は bootstrap 成功時に呼ばれない').not.toContain(ep);
    }
    // streak は bootstrap の外なので従来どおり 1 本
    expect(paths.filter((p) => p.indexOf('/api/liff/intake/streak') === 0).length).toBe(1);
  });

  it('rank / tip / 紹介カードが bootstrap data で描画され、#loading が解除される', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('/api/liff/portal-bootstrap', { status: 200, json: bootstrapOkJson() });
    sb.respond.set('/api/liff/intake/streak', {
      status: 200,
      json: { success: true, data: { currentStreak: 5 } },
    });
    await (sb.fn.bootstrapPortal as unknown as () => Promise<boolean>)();
    await tick();
    expect(sb.byId.get('rank-card')!.innerHTML).toContain('Silver');
    expect(sb.byId.get('tip-card')!.innerHTML).toContain('水分補給のコツ');
    // 紹介カードは bootstrap の refCode で generate を撃たずに描画される
    expect(sb.byId.get('referral-card')!.innerHTML).toContain('ref_abc123');
    expect(sb.calls.map((c) => c.path)).not.toContain('/api/liff/referral/generate');
    expect(sb.byId.get('loading')!.style.display).toBe('none');
    // 空 section は非表示に畳まれる (welcome coupon: null)
    expect(sb.byId.get('welcome-coupon-card')!.style.display).toBe('none');
    // streak は bootstrap の外 (別 endpoint) — 従来どおり描画される
    expect(String(sb.byId.get('intake-streak-num')!.textContent)).toBe('5');
  });

  it('#loading は rank 初回描画で解除される (残り loader が未 settle でも)', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('/api/liff/portal-bootstrap', { status: 200, json: bootstrapOkJson() });
    sb.respond.set('/api/liff/intake/streak', 'never'); // loadTodayIntake が永遠に終わらない
    const p = (sb.fn.bootstrapPortal as unknown as () => Promise<boolean>)();
    await tick(20);
    // bootstrapPortal 全体は streak 待ちで未解決のまま — それでも rank は描画済み・loading 解除済み
    expect(sb.byId.get('rank-card')!.innerHTML).toContain('Silver');
    expect(sb.byId.get('loading')!.style.display).toBe('none');
    void p; // 未解決の promise は放置して良い (fetch stub は leak しない)
  });
});

describe('部分失敗の隔離と丸ごとフォールバック', () => {
  it('1 section の ok:false は該当 loader だけ個別 fetch へ落ちる (他カードは bootstrap で描画)', async () => {
    const sb = loadSandbox(scriptOn);
    const json = bootstrapOkJson();
    (json.data as Record<string, unknown>).tip = { ok: false, status: 500 };
    sb.respond.set('/api/liff/portal-bootstrap', { status: 200, json });
    sb.respond.set('/api/liff/tips/today', {
      status: 200,
      json: { success: true, data: { title: '個別経路の Tip', content: 'fallback' } },
    });
    const result = await (sb.fn.bootstrapPortal as unknown as () => Promise<boolean>)();
    await tick();
    expect(result).toBe(true);
    expect(sb.calls.map((c) => c.path)).toContain('/api/liff/tips/today');
    expect(sb.byId.get('tip-card')!.innerHTML).toContain('個別経路の Tip');
    // 他 section は個別 fetch されない
    expect(sb.calls.map((c) => c.path)).not.toContain('/api/liff/rank');
    expect(sb.byId.get('rank-card')!.innerHTML).toContain('Silver');
  });

  it('bootstrap 呼び出し自体の失敗 (network) は false = 旧経路へ丸ごとフォールバック', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('/api/liff/portal-bootstrap', 'reject');
    const result = await (sb.fn.bootstrapPortal as unknown as () => Promise<boolean>)();
    await tick();
    expect(result).toBe(false);
    // bootstrapPortal 自身は loader を撃たない (旧経路の再実行は initLiff 側の責務)
    expect(sb.calls.length).toBe(1);
    // 失敗時に #loading を消さない (旧経路の完走まで overlay を保つ)
    expect(sb.byId.get('loading')!.style.display).not.toBe('none');
  });

  it('bootstrap の HTTP 500 も false (apiFailed 判定で旧経路へ)', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('/api/liff/portal-bootstrap', { status: 500, json: { success: false, error: 'boom' } });
    const result = await (sb.fn.bootstrapPortal as unknown as () => Promise<boolean>)();
    expect(result).toBe(false);
    expect(sb.byId.get('loading')!.style.display).not.toBe('none');
  });
});

// ───────────────────────── initLiff レベル (gate 配線そのものを実行して観測) ─────────────────────────
// bootstrapPortal 単体のテストだけでは「if (!bootstrapped) を if (true) 化 (= 成功後に旧バッチを
// 無条件再実行)」「bootstrapped=true ハードコード (= 何も読まない白画面)」の mutation が
// 全 suite を素通りする (採点ループ R1 実測)。initLiff を末端まで走らせて総 fetch 本数で塞ぐ。

describe('initLiff — gate 配線の end-to-end 観測', () => {
  it('gate on + bootstrap 成功: 総 fetch は bootstrap + intake/streak の 2 本きっかり', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('/api/liff/portal-bootstrap', { status: 200, json: bootstrapOkJson() });
    sb.respond.set('/api/liff/intake/streak', {
      status: 200,
      json: { success: true, data: { currentStreak: 5 } },
    });
    await (sb.fn.initLiff as unknown as () => Promise<void>)();
    const paths = sb.calls.map((c) => c.path);
    expect(paths.length, '総 fetch 本数 (= PR-3 の削減効果そのもの): ' + paths.join(', ')).toBe(2);
    expect(sb.byId.get('rank-card')!.innerHTML).toContain('Silver');
    expect(sb.byId.get('loading')!.style.display).toBe('none');
  });

  it('gate on + bootstrap network 失敗: 旧経路へ丸ごとフォールバックし個別 endpoint 群を fetch', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('/api/liff/portal-bootstrap', 'reject');
    sb.respond.set('/api/liff/rank', { status: 200, json: { success: true, data: JSON.parse(JSON.stringify(RANK_DATA)) } });
    await (sb.fn.initLiff as unknown as () => Promise<void>)();
    const paths = sb.calls.map((c) => c.path);
    expect(paths).toContain('/api/liff/rank');
    expect(paths).toContain('/api/liff/tips/today');
    expect(paths).toContain('/api/liff/badges');
    expect(sb.byId.get('rank-card')!.innerHTML).toContain('Silver');
    expect(sb.byId.get('loading')!.style.display).toBe('none');
  });

  it('gate off: bootstrap を一切呼ばず従来の個別 fetch 群のみ (完全不変)', async () => {
    const sb = loadSandbox(scriptOff);
    await (sb.fn.initLiff as unknown as () => Promise<void>)();
    const paths = sb.calls.map((c) => c.path);
    expect(paths.some((p) => p.indexOf('/api/liff/portal-bootstrap') === 0)).toBe(false);
    expect(paths).toContain('/api/liff/rank');
    expect(paths).toContain('/api/liff/tips/today');
  });
});

// ───────────────────────── deep-link 入場の reveal 見送り (採点ループ R1 confirmed) ─────────────────────────
// 早期 reveal だと「home が見えて操作を始めた頃に画面が突然別タブへ飛ぶ」窓が
// streak fetch 1 往復ぶん開く。home 以外への deep-link では旧経路と同じ init 完走時解除に倒す。

describe('deep-link 入場では早期 reveal を見送る', () => {
  it('#delivery: 残り loader が未 settle の間 #loading を保つ (rank は描画済み)', async () => {
    const sb = loadSandbox(scriptOn, { hash: '#delivery' });
    sb.respond.set('/api/liff/portal-bootstrap', { status: 200, json: bootstrapOkJson() });
    sb.respond.set('/api/liff/intake/streak', 'never');
    const p = (sb.fn.bootstrapPortal as unknown as () => Promise<boolean>)();
    await tick(30);
    expect(sb.byId.get('rank-card')!.innerHTML).toContain('Silver');
    expect(sb.byId.get('loading')!.style.display).not.toBe('none');
    void p;
  });

  it('#mypage (home 写像) は従来どおり rank 初回描画で即解除', async () => {
    const sb = loadSandbox(scriptOn, { hash: '#mypage' });
    sb.respond.set('/api/liff/portal-bootstrap', { status: 200, json: bootstrapOkJson() });
    sb.respond.set('/api/liff/intake/streak', 'never');
    const p = (sb.fn.bootstrapPortal as unknown as () => Promise<boolean>)();
    await tick(30);
    expect(sb.byId.get('loading')!.style.display).toBe('none');
    void p;
  });

  it('?page=delivery (openLiffPage 互換) も hash と同じく見送る', async () => {
    const sb = loadSandbox(scriptOn, { search: '?page=delivery' });
    sb.respond.set('/api/liff/portal-bootstrap', { status: 200, json: bootstrapOkJson() });
    sb.respond.set('/api/liff/intake/streak', 'never');
    const p = (sb.fn.bootstrapPortal as unknown as () => Promise<boolean>)();
    await tick(30);
    expect(sb.byId.get('loading')!.style.display).not.toBe('none');
    void p;
  });
});

describe('測定器の健全性 (ハーネスが「見えるはずのもの」を実際に見えるか)', () => {
  it('個別 fetch は観測に写る (loadTip を preRes なしで呼ぶと tips/today が記録される)', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('/api/liff/tips/today', {
      status: 200,
      json: { success: true, data: { title: 't', content: 'c' } },
    });
    await (sb.fn.loadTip as unknown as (p?: unknown) => Promise<void>)();
    expect(sb.calls.map((c) => c.path)).toContain('/api/liff/tips/today');
  });

  it('revealLoading は __fatalShown 中には解除しない (エラー全画面を隠さない)', () => {
    const sb = loadSandbox(scriptOn);
    (sb.win as Record<string, unknown>).__fatalShown = true;
    (sb.fn.revealLoading as unknown as () => void)();
    expect(sb.byId.get('loading')!.style.display).not.toBe('none');
  });
});
