/**
 * ?slk= (定期購入 magic-link) の fast path と退避トークンのライフサイクル。
 *
 * 設計根拠 = docs/SUBSCRIPTION_UX_TAP_MINIMAL_2026-07-25.md §6-4 / §10-1 / §7。
 *
 * 本テストは **吐き出された client JS を実際に評価し、 ミニ DOM と差し替え可能な fetch の上で
 * 関数を呼んで振る舞いを観測する**。 ソース文字列の regex 検査だけでは #193 クラスの事故も
 * 「無言で消える」クラスの欠陥も落とせない (2026-07-10 / 2026-07-26 の教訓)。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { liffPages } from '../routes/liff-pages.js';

interface MinimalEnv {
  LIFF_URL: string;
  WORKER_URL: string;
}

const baseEnv: MinimalEnv = {
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
  WORKER_URL: 'https://example.workers.dev',
};

async function portalHtml(): Promise<string> {
  const res = await liffPages.request('/liff/portal', {}, baseEnv as unknown as Record<string, unknown>);
  expect(res.status).toBe(200);
  return res.text();
}

function inlineScript(html: string): string {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const withSubLink = scripts.filter((s) => s.includes('SUBLINK_STASH_KEY'));
  expect(withSubLink.length, 'sub-link を含む inline script が 1 本あること').toBe(1);
  return withSubLink[0];
}

// ───────────────────────── ミニ DOM ─────────────────────────

interface FakeEl {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  children: FakeEl[];
  parentNode: FakeEl | null;
  disabled?: boolean;
  /** markShopifyLinked が `while (card.firstChild) removeChild(...)` で中身を空にする。
   *  これが無いと「差し替え」が「追記」になり、古い CTA が残ったまま緑になる */
  readonly firstChild: FakeEl | null;
  /** innerHTML で流し込まれた生 HTML (loadShopData の空表示検証に使う) */
  _html?: string;
  innerHTML: string;
  getBoundingClientRect(): { top: number };
  querySelector(sel: string): FakeEl | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(type: string, fn: () => void): void;
  fire(type: string, ev?: unknown): void;
  listeners: Record<string, ((ev?: unknown) => void)[]>;
}

function el(tagName: string): FakeEl {
  const node: FakeEl = {
    tagName,
    id: '',
    className: '',
    textContent: '',
    style: {},
    attrs: {},
    children: [],
    parentNode: null,
    listeners: {},
    get firstChild() {
      return node.children.length ? node.children[0] : null;
    },
    appendChild(c) {
      c.parentNode = node;
      node.children.push(c);
      return c;
    },
    removeChild(c) {
      const i = node.children.indexOf(c);
      if (i >= 0) node.children.splice(i, 1);
      c.parentNode = null;
    },
    setAttribute(k, v) {
      node.attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null;
    },
    addEventListener(type, fn) {
      (node.listeners[type] = node.listeners[type] || []).push(fn);
    },
    // C3: reorderShortcut がスクロール位置を計算する。実 DOM に無い値なので固定で返す
    getBoundingClientRect: () => ({ top: 200 }),
    // innerHTML への代入。生 HTML は文字列としても検査できるよう保持しつつ、
    // **C3 の CTA だけは実要素として復元する**。文字列のままだと
    // querySelector / getAttribute / 「畳めているか」が観測できず、
    // 「出して後から畳む」という設計の中核が構造的に検証不能になる (採点 test-integrity)
    set innerHTML(html: string) {
      node.children.length = 0;
      node._html = html;
      const m = /data-shopify-link-cta="([^"]*)"/.exec(html);
      if (m) {
        const cta = el('div');
        cta.setAttribute('data-shopify-link-cta', m[1]);
        // CTA 自身の座標 (カード上端 200 とは別の値にして、スクロール先を区別できるようにする)
        cta.getBoundingClientRect = () => ({ top: 500 });
        cta.parentNode = node;
        node.children.push(cta);
      }
    },
    get innerHTML() {
      return node._html ?? '';
    },
    querySelector(sel: string) {
      const hit = matchSelector(node, sel);
      return hit.length ? hit[0] : null;
    },
    fire(type, ev) {
      // ブラウザ準拠: disabled な要素には click が配送されない。
      // これを模さないと「同期的に disabled にして連打を止める」実装を検証できない。
      if (type === 'click' && node.disabled === true) return;
      for (const fn of node.listeners[type] || []) fn(ev);
    },
  };
  return node;
}

function walk(root: FakeEl, visit: (n: FakeEl) => void): void {
  visit(root);
  for (const c of root.children) walk(c, visit);
}

function findById(root: FakeEl, id: string): FakeEl | null {
  let hit: FakeEl | null = null;
  walk(root, (n) => {
    if (!hit && n.id === id) hit = n;
  });
  return hit;
}

function textOf(root: FakeEl): string {
  let out = '';
  walk(root, (n) => {
    out += n.textContent;
  });
  return out;
}

function buttonsOf(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  walk(root, (n) => {
    if (n.tagName === 'button') out.push(n);
  });
  return out;
}

/**
 * `[attr]` と `[attr="value"]` の連結だけを解釈する簡易セレクタ照合。
 * 例: `[data-shopify-link-cta]` / `[data-shopify-link-cta][data-linked="1"]`
 *
 * 属性名の部分文字列マッチにしないこと — セレクタを精緻化したときに無言で常に
 * 空を返すようになり、ガードが効いていないのに緑になる (採点 test-integrity)。
 */
function matchSelector(root: FakeEl, selector: string): FakeEl[] {
  const parts = [...selector.trim().matchAll(/\[([A-Za-z-]+)(?:="([^"]*)")?\]/g)];
  // セレクタ全体が `[...]` の連結で説明できないなら、解釈できない = 空を返す
  if (!parts.length || parts.map((p) => p[0]).join('') !== selector.trim()) return [];
  const out: FakeEl[] = [];
  walk(root, (n) => {
    const ok = parts.every(([, attr, val]) => {
      if (!Object.prototype.hasOwnProperty.call(n.attrs, attr)) return false;
      return val === undefined || n.attrs[attr] === val;
    });
    if (ok) out.push(n);
  });
  return out;
}

interface FetchCall {
  path: string;
  body: Record<string, unknown>;
}

interface Sandbox {
  fn: Record<string, (...a: never[]) => unknown>;
  body: FakeEl;
  storage: ReturnType<typeof makeStorage>;
  win: Record<string, unknown>;
  replacedUrls: string[];
  calls: FetchCall[];
  /** 次の fetch 応答を積む。 null = ネットワーク例外。 */
  queue: ({ status: number; json: unknown } | null)[];
  setSearch(s: string): void;
  /** fetch 実装を差し替える (手動 settle で遅延応答を再現する用)。 */
  setFetchImpl(impl: ((url: string, init?: { body?: string }) => Promise<unknown>) | null): void;
  flush(max?: number): void;
  pendingTimers(): number;
  overlay(): FakeEl | null;
  /** window.scrollTo の呼び出し履歴 (C3: 行き止まり解消の観測) */
  scrolls: { top: number }[];
}

function makeStorage(opts: { throwOnWrite?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (opts.throwOnWrite) throw new Error('QuotaExceeded');
      map.set(k, String(v));
    },
    removeItem: (k: string) => void map.delete(k),
  };
}

function loadSandbox(
  script: string,
  opts: {
    search?: string;
    sub?: string | null;
    storageThrows?: boolean;
    neverSettle?: boolean;
    fetchImpl?: (url: string, init?: { body?: string }) => Promise<unknown>;
  } = {},
): Sandbox {
  const storage = makeStorage({ throwOnWrite: opts.storageThrows });
  const replacedUrls: string[] = [];
  const calls: FetchCall[] = [];
  const queue: ({ status: number; json: unknown } | null)[] = [];
  const body = el('body');
  // 実ページと同じく #loading を実在させる。 これが無いと showFatalError が早期 return し、
  // 「handleAuthExpired が撃たれていないこと」の assert が構造的に必ず真になる (tautology)。
  const loadingEl = el('div');
  loadingEl.id = 'loading';
  body.appendChild(loadingEl);
  const loc = {
    href: 'https://example.workers.dev/liff/portal' + (opts.search ?? ''),
    search: opts.search ?? '',
    hash: '',
    reload() {},
    replace() {},
  };

  let nextTimer = 1;
  // 遅延の大小を保持する。 実時間では retry(1.5s)×4 がスタール監視(15s)より必ず先に走るので、
  // これを無視して登録順に流すと「実際には起きない順序」でテストが赤/緑になる。
  const timers = new Map<number, { cb: () => void; at: number }>();
  let clock = 0;
  const preexisting = new Set<number>(); // script の top-level watchdog 等 (本テストの対象外)

  const doc = {
    addEventListener() {},
    getElementById: (id: string) => findById(body, id),
    // C3: shopifyLinkCtaHtml が `[data-shopify-link-cta][data-linked="1"]` で
    // 「既に畳まれた CTA があるか」を見る。null 固定だとそのガードが素通りする
    querySelector: (sel: string) => {
      const hit = matchSelector(body, sel);
      return hit.length ? hit[0] : null;
    },
    // C3: markShopifyLinked が `[data-shopify-link-cta]` を全件走査する。
    // 空配列を返すスタブのままだと「畳めているか」の検証が構造的に必ず真になる
    querySelectorAll: (sel: string) => matchSelector(body, sel),
    createElement: (t: string) => el(t),
    body,
  };
  // C3: reorderShortcut がスクロール位置を計算するので、呼ばれたことを観測できるようにする
  const scrolls: { top: number }[] = [];
  const win: Record<string, unknown> = {
    sessionStorage: storage,
    localStorage: makeStorage(),
    location: loc,
    history: {
      replaceState(_s: unknown, _t: unknown, url: string) {
        replacedUrls.push(url);
        const q = url.indexOf('?');
        loc.search = q >= 0 ? url.slice(q) : '';
        loc.href = url;
      },
    },
    addEventListener() {},
    pageYOffset: 0,
    scrollTo(arg: { top: number }) {
      scrolls.push(arg);
    },
  };
  const liff = {
    getDecodedIDToken: () => (opts.sub === null ? null : { sub: opts.sub ?? 'U_alice' }),
  };

  let fetchImpl = opts.fetchImpl ?? null;
  const fakeFetch = (url: string, init?: { body?: string }) => {
    const path = String(url).replace(baseEnv.WORKER_URL, '');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = init && init.body ? JSON.parse(init.body) : {};
    } catch {
      parsed = {};
    }
    calls.push({ path, body: parsed });
    if (fetchImpl) return fetchImpl(url, init);
    if (opts.neverSettle) return new Promise(() => {}); // resolve も reject もしない
    const next = queue.length ? queue.shift() : undefined;
    if (next === null) return Promise.reject(new Error('network down'));
    const resp = next ?? { status: 200, json: { success: true, data: { status: 'ready', plan: 'ブルー30日分' } } };
    return Promise.resolve({ status: resp.status, json: () => Promise.resolve(resp.json) });
  };

  const EXPORTS = [
    'captureSubLinkToken',
    'subLinkTakeStash',
    'subLinkStashWrite',
    'subLinkClearStash',
    'checkSubLinkParam',
    'subLinkPreview',
    'subLinkShowCard',
    'subLinkDismiss',
    'subLinkShowLoading',
    'subLinkRedeem',
    // C3: 連携導線 (呼び出し側も実行して検証する — 関数単体だけだと
    // 「空表示から呼び出しを消す」変異が生き残る)
    'markShopifyLinked',
    'shopifyLinkCtaHtml',
    'openAccountLinkCard',
    'subLinkStatusInfo',
    'subLinkShowUnavailable',
    'showShopifyLinkHomeCard',
    'loadShopData',
    'loadRank',
    'reorderShortcut',
  ];

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
    loc,
    storage,
    win.localStorage,
    (cb: () => void, ms?: number) => {
      const id = nextTimer++;
      timers.set(id, { cb, at: clock + (typeof ms === 'number' ? ms : 0) });
      return id;
    },
    (id: number) => void timers.delete(id),
    () => 0,
    fakeFetch,
    { log() {}, warn() {}, error() {} },
    liff,
  ) as Record<string, (...a: never[]) => unknown>;
  // script 評価中に張られた timer (12s watchdog 等) は本テストの観測対象外
  for (const id of timers.keys()) preexisting.add(id);

  return {
    fn,
    body,
    storage,
    win,
    replacedUrls,
    calls,
    queue,
    setSearch(s: string) {
      loc.search = s;
      loc.href = 'https://example.workers.dev/liff/portal' + s;
    },
    setFetchImpl(impl) {
      fetchImpl = impl;
    },
    flush(max = 12) {
      for (let i = 0; i < max; i++) {
        const due = [...timers.entries()]
          .filter(([id]) => !preexisting.has(id))
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        clock = Math.max(clock, due[1].at);
        due[1].cb();
      }
    },
    pendingTimers: () => [...timers.keys()].filter((id) => !preexisting.has(id)).length,
    overlay: () => findById(body, 'sublink-overlay'),
    scrolls,
  };
}

/** promise microtask を捌く。 */
const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

let script = '';
beforeAll(async () => {
  script = inlineScript(await portalHtml());
});

// ───────────────────────── 実行順序 ─────────────────────────

describe('?slk= fast path — 実行順序 (§10-1)', () => {
  it('captureSubLinkToken は liff.init() より前にも呼ばれる', () => {
    const capture = script.indexOf('captureSubLinkToken();');
    const init = script.indexOf('await liff.init(');
    expect(capture).toBeGreaterThan(-1);
    expect(capture, 'login リダイレクト前に URL の slk を退避しておく').toBeLessThan(init);
  });

  it('checkSubLinkParam は idToken 代入の後・12 loader の Promise.all より前', () => {
    const idTokenAssign = script.indexOf('idToken = liff.getIDToken();');
    const check = script.indexOf('checkSubLinkParam();');
    const batch = script.indexOf('await Promise.all([loadLanguage()');
    expect(idTokenAssign).toBeGreaterThan(-1);
    expect(batch).toBeGreaterThan(-1);
    // idToken 未代入の地点で撃つと api() が全経路 401 → handleAuthExpired で全画面エラーになる
    expect(check).toBeGreaterThan(idTokenAssign);
    // 12 loader / loadRank を待つと、 メール経由の来訪者が最も離脱しやすい時間に空白を見せる
    expect(check).toBeLessThan(batch);
  });

  it('checkSubLinkParam は await されない (ホームの読み込みを塞がない)', () => {
    expect(script).toContain('\n    checkSubLinkParam();');
    expect(script).not.toContain('await checkSubLinkParam()');
  });

  it('#rank 早期分岐より後にある (そこは idToken 未代入)', () => {
    const rankBranch = script.indexOf("location.replace('/liff/my-rank?entry=replace')");
    expect(rankBranch).toBeGreaterThan(-1);
    expect(script.indexOf('checkSubLinkParam();')).toBeGreaterThan(rankBranch);
  });
});

// ───────────────── liff.state 経路 (本番の主経路) ─────────────────

describe('liff.state 経由でトークンが届く経路 (本番の唯一の配布形)', () => {
  // 配布リンクは services/sub-link.ts の `${LIFF_URL}?slk=<token>` = https://liff.line.me/{id}?slk=...
  // endpoint には ?liff.state=%3Fslk%3D<token> として着弾し、 liff.init() が復元して初めて
  // location.search に ?slk= が現れる。 init 前だけを読む実装はここで 1 件も拾えない。
  it('init 前は liff.state のままなので何も退避されない', () => {
    const sb = loadSandbox(script, { search: '?liff.state=%3Fslk%3Dtok_state' });
    sb.fn.captureSubLinkToken();
    expect(sb.storage.getItem('sublink_token_v1')).toBeNull();
  });

  it('init 後に復元された ?slk= を checkSubLinkParam が拾い、preview を撃つ', async () => {
    const sb = loadSandbox(script, { search: '?liff.state=%3Fslk%3Dtok_state' });
    sb.fn.captureSubLinkToken(); // init 前 (空振り)
    sb.setSearch('?slk=tok_state'); // liff.init() による復元を再現
    sb.fn.checkSubLinkParam();
    await tick();
    expect(sb.calls.map((c) => c.path)).toContain('/api/liff/sub-link/preview');
    expect(sb.calls[0].body.token).toBe('tok_state');
    // 復元後も URL からは消す (履歴・共有スクショ対策)
    expect(sb.replacedUrls.length).toBe(1);
    expect(sb.replacedUrls[0]).not.toContain('slk');
  });

  it('endpoint URL に直接 ?slk= が乗る経路も従来どおり動く', async () => {
    const sb = loadSandbox(script, { search: '?slk=tok_direct' });
    sb.fn.captureSubLinkToken();
    sb.fn.checkSubLinkParam();
    await tick();
    expect(sb.calls[0].body.token).toBe('tok_direct');
  });
});

// ───────────────────────── 退避ライフサイクル ─────────────────────────

describe('退避トークンのライフサイクル (§6-4)', () => {
  it('capture: URL から slk を抜き、 replaceState で消し、 session へ退避する', () => {
    const sb = loadSandbox(script, { search: '?slk=abc123' });
    sb.fn.captureSubLinkToken();
    expect(sb.replacedUrls[0]).not.toContain('slk');
    const rec = JSON.parse(sb.storage.getItem('sublink_token_v1')!);
    expect(rec.t).toBe('abc123');
    expect(rec.s, '未束縛で保存される (init 前は sub が取れない)').toBeNull();
    expect(sb.win.__subLinkPending).toBe(true);
  });

  it('capture: slk が無ければ何も書かない', () => {
    const sb = loadSandbox(script, { search: '?demo=1' });
    sb.fn.captureSubLinkToken();
    expect(sb.storage.getItem('sublink_token_v1')).toBeNull();
    expect(sb.replacedUrls.length).toBe(0);
  });

  it('take: 初回読み出しで現在の sub に束縛される', () => {
    const sb = loadSandbox(script, { search: '?slk=tok1' });
    sb.fn.captureSubLinkToken();
    expect(sb.fn.subLinkTakeStash('U_alice' as never)).toBe('tok1');
    expect(JSON.parse(sb.storage.getItem('sublink_token_v1')!).s).toBe('U_alice');
  });

  it('take: 束縛済みの sub と異なるアカウントには渡さず破棄する (共有端末)', () => {
    const sb = loadSandbox(script, { search: '?slk=tok1' });
    sb.fn.captureSubLinkToken();
    expect(sb.fn.subLinkTakeStash('U_alice' as never)).toBe('tok1');
    expect(sb.fn.subLinkTakeStash('U_bob' as never)).toBeNull();
    expect(sb.storage.getItem('sublink_token_v1')).toBeNull();
  });

  it('take: 同一 sub なら何度でも復元できる (リロード救済)', () => {
    const sb = loadSandbox(script, { search: '?slk=tok1' });
    sb.fn.captureSubLinkToken();
    expect(sb.fn.subLinkTakeStash('U_alice' as never)).toBe('tok1');
    expect(sb.fn.subLinkTakeStash('U_alice' as never)).toBe('tok1');
  });

  it('take: 保存から 30 分超で破棄 / 29 分は生存 (境界)', () => {
    const sb = loadSandbox(script);
    sb.fn.subLinkStashWrite({ t: 'old', s: 'U_alice', ts: Date.now() - 31 * 60 * 1000 } as never);
    expect(sb.fn.subLinkTakeStash('U_alice' as never)).toBeNull();
    sb.fn.subLinkStashWrite({ t: 'fresh', s: 'U_alice', ts: Date.now() - 29 * 60 * 1000 } as never);
    expect(sb.fn.subLinkTakeStash('U_alice' as never)).toBe('fresh');
  });

  it('take: 壊れた JSON / 空トークンは破棄する', () => {
    const sb = loadSandbox(script);
    sb.storage.setItem('sublink_token_v1', '{not json');
    expect(sb.fn.subLinkTakeStash('U_alice' as never)).toBeNull();
    sb.fn.subLinkStashWrite({ t: '', s: null, ts: Date.now() } as never);
    expect(sb.fn.subLinkTakeStash('U_alice' as never)).toBeNull();
  });

  it('sessionStorage が書けない端末でも同一ページ内では機能する (メモリ fallback)', async () => {
    const sb = loadSandbox(script, { search: '?slk=tok_ps', storageThrows: true });
    sb.fn.captureSubLinkToken();
    expect(sb.storage.getItem('sublink_token_v1'), 'storage には残らない').toBeNull();
    sb.fn.checkSubLinkParam();
    await tick();
    // URL からは既に消しているので、fallback が無いと機能ごと消える
    expect(sb.calls[0].body.token).toBe('tok_ps');
  });
});

// ───────────────────────── 実挙動: preview の全分岐 ─────────────────────────

async function runPreview(
  responses: ({ status: number; json: unknown } | null)[],
  opts: { search?: string } = {},
): Promise<Sandbox> {
  const sb = loadSandbox(script, { search: opts.search ?? '?slk=tokX' });
  sb.queue.push(...responses);
  sb.fn.captureSubLinkToken();
  sb.fn.checkSubLinkParam();
  await tick();
  // リトライ timer をすべて進める
  for (let i = 0; i < 8; i++) {
    if (sb.pendingTimers() === 0) break;
    sb.flush(1);
    await tick();
  }
  return sb;
}

describe('preview の全分岐が「閉じられる終端状態」に到達する (§4 誠実な失敗)', () => {
  it('ready: プラン名と連携ボタンが出る', async () => {
    const sb = await runPreview([{ status: 200, json: { success: true, data: { status: 'ready', plan: 'ブルー30日分' } } }]);
    const ov = sb.overlay()!;
    expect(ov).toBeTruthy();
    expect(textOf(ov)).toContain('ブルー30日分');
    const labels = buttonsOf(ov).map((b) => b.textContent);
    expect(labels).toContain('このLINEに連携する');
    expect(labels).toContain('あとで');
    expect(sb.storage.getItem('sublink_token_v1'), 'ready では退避を残す').not.toBeNull();
  });

  it('terminal (expired): 説明カード + とじる、 退避は消える', async () => {
    const sb = await runPreview([{ status: 200, json: { success: true, data: { status: 'expired' } } }]);
    const ov = sb.overlay()!;
    expect(textOf(ov)).toContain('有効期限');
    expect(buttonsOf(ov).map((b) => b.textContent)).toContain('とじる');
    expect(sb.storage.getItem('sublink_token_v1')).toBeNull();
  });

  it('友だち未反映の 404 が続いても、枯渇後は無言で消えず再試行カードを出す (退避は残す)', async () => {
    const notFound = { status: 404, json: { success: false, error: 'Friend not found' } };
    const sb = await runPreview([notFound, notFound, notFound, notFound, notFound, notFound]);
    const ov = sb.overlay();
    expect(ov, '無言で消えてはいけない').not.toBeNull();
    expect(textOf(ov!)).toContain('もう少しお待ちください');
    expect(buttonsOf(ov!).map((b) => b.textContent)).toContain('もう一度試す');
    expect(sb.storage.getItem('sublink_token_v1'), '結論が出ていないので退避は残す').not.toBeNull();
  });

  it('5xx: 再試行カード + 退避は残す', async () => {
    const sb = await runPreview([{ status: 503, json: { success: false, error: 'upstream' } }]);
    const ov = sb.overlay()!;
    expect(textOf(ov)).toContain('通信に失敗しました');
    expect(sb.storage.getItem('sublink_token_v1')).not.toBeNull();
  });

  it('通信例外の枯渇: 再試行カード + 退避は残す', async () => {
    const sb = await runPreview([null, null, null, null, null, null]);
    const ov = sb.overlay()!;
    expect(textOf(ov)).toContain('通信に失敗しました');
    expect(sb.storage.getItem('sublink_token_v1')).not.toBeNull();
  });

  it('gate off (404 not_found): 事実を伝えるカードを出し、退避は消す (再表示ループを作らない)', async () => {
    const sb = await runPreview([{ status: 404, json: { success: false, error: 'not_found' } }]);
    const ov = sb.overlay()!;
    expect(textOf(ov)).toContain('ただいまお受けできません');
    expect(buttonsOf(ov).map((b) => b.textContent)).toContain('とじる');
    expect(sb.storage.getItem('sublink_token_v1'), '毎リロードで再表示しない').toBeNull();
  });

  it('401: 全画面エラーに倒さず、開き直し導線を出す (退避は残す)', async () => {
    const sb = await runPreview([{ status: 401, json: { success: false, error: 'Unauthorized' } }]);
    const ov = sb.overlay()!;
    expect(textOf(ov)).toContain('ログインの有効期限');
    expect(buttonsOf(ov).map((b) => b.textContent)).toContain('開き直す');
    expect(sb.storage.getItem('sublink_token_v1')).not.toBeNull();
    // handleAuthExpired が撃たれていない = ポータル全体は生きている
    expect(sb.win.__fatalShown).toBeFalsy();
  });

  it('応答が返らないまま固まっても、スタール監視が再試行カードへ逃がす', async () => {
    // ポータル本体の 12s watchdog は #loading にしか書かないため、その上に出るこのカードには届かない。
    const sb = loadSandbox(script, { search: '?slk=tokStall', neverSettle: true });
    sb.fn.captureSubLinkToken();
    sb.fn.checkSubLinkParam();
    await tick();
    expect(sb.overlay()!.getAttribute('data-sublink-phase')).toBe('loading');
    expect(sb.pendingTimers(), 'スタール監視が仕掛けられている').toBeGreaterThan(0);
    sb.flush(4);
    await tick();
    const ov = sb.overlay();
    expect(ov, 'shimmer のまま放置されない').not.toBeNull();
    expect(textOf(ov!)).toContain('通信に失敗しました');
    expect(buttonsOf(ov!).map((b) => b.textContent)).toContain('あとで');
  });
});

// ───────────────────────── dismiss と timer ─────────────────────────

describe('閉じる操作は必ず終端する', () => {
  it('dismiss 後に保留 timer を進めてもモーダルが復活しない', async () => {
    const notFound = { status: 404, json: { success: false, error: 'Friend not found' } };
    const sb = loadSandbox(script, { search: '?slk=tokT' });
    sb.queue.push(notFound, notFound, notFound, notFound, notFound);
    sb.fn.captureSubLinkToken();
    sb.fn.checkSubLinkParam();
    await tick();
    expect(sb.pendingTimers()).toBeGreaterThan(0); // リトライ待ち
    sb.fn.subLinkDismiss(false as never);
    expect(sb.overlay()).toBeNull();
    sb.flush(12);
    await tick();
    expect(sb.overlay(), '「閉じた」はずのモーダルが復活してはいけない').toBeNull();
  });

  it('明示的な「とじる」は退避を消し、背景タップは残す', async () => {
    const sb = await runPreview([{ status: 200, json: { success: true, data: { status: 'ready', plan: 'P' } } }]);
    const ov = sb.overlay()!;
    // 背景タップ = 判断保留
    ov.fire('click', { target: ov });
    expect(sb.overlay()).toBeNull();
    expect(sb.storage.getItem('sublink_token_v1'), '判断保留なので残す').not.toBeNull();

    const sb2 = await runPreview([{ status: 200, json: { success: true, data: { status: 'ready', plan: 'P' } } }]);
    const later = buttonsOf(sb2.overlay()!).find((b) => b.textContent === 'あとで')!;
    later.fire('click');
    expect(sb2.storage.getItem('sublink_token_v1'), '明示操作は削除条件④').toBeNull();
  });

  it('ツアーはカード表示中は出ず、閉じたら解放される', async () => {
    const sb = await runPreview([{ status: 200, json: { success: true, data: { status: 'ready', plan: 'P' } } }]);
    expect(sb.win.__subLinkPending).toBe(true);
    buttonsOf(sb.overlay()!).find((b) => b.textContent === 'あとで')!.fire('click');
    expect(sb.win.__subLinkPending, '閉じたら解放').toBe(false);
  });
});

// ───────────────────────── redeem ─────────────────────────

describe('redeem', () => {
  async function toReadyCard(): Promise<Sandbox> {
    return runPreview([{ status: 200, json: { success: true, data: { status: 'ready', plan: 'ブルー30日分' } } }]);
  }

  it('成功: 退避を消し、閉じられる完了カードを出す (閉じられないモーダルの回帰防止)', async () => {
    const sb = await toReadyCard();
    sb.queue.push({ status: 200, json: { success: true, data: { plan: 'ブルー30日分' } } });
    buttonsOf(sb.overlay()!).find((b) => b.textContent === 'このLINEに連携する')!.fire('click');
    await tick();
    const ov = sb.overlay()!;
    expect(textOf(ov)).toContain('連携が完了しました');
    expect(buttonsOf(ov).map((b) => b.textContent), '旧実装は appendChild 漏れで閉じられなかった').toContain('とじる');
    expect(sb.storage.getItem('sublink_token_v1')).toBeNull();
  });

  it('連打しても redeem は 1 回だけ (ボタンが同期的に disabled)', async () => {
    const sb = await toReadyCard();
    sb.queue.push({ status: 200, json: { success: true, data: { plan: 'P' } } });
    const btn = buttonsOf(sb.overlay()!).find((b) => b.textContent === 'このLINEに連携する')!;
    btn.fire('click');
    // await より前 = 同期的に無効化されていること (ここが非同期だと連打で二重 redeem になる)
    expect(btn.disabled, 'click ハンドラ内で同期的に disabled にする').toBe(true);
    btn.fire('click');
    btn.fire('click');
    await tick();
    const redeems = sb.calls.filter((c) => c.path.indexOf('/redeem') >= 0);
    expect(redeems.length).toBe(1);
  });

  it('5xx: 結論扱いにせず、退避を残して再試行導線へ', async () => {
    const sb = await toReadyCard();
    sb.queue.push({ status: 500, json: { success: false } });
    buttonsOf(sb.overlay()!).find((b) => b.textContent === 'このLINEに連携する')!.fire('click');
    await tick();
    expect(textOf(sb.overlay()!)).toContain('通信に失敗しました');
    expect(sb.storage.getItem('sublink_token_v1')).not.toBeNull();
  });

  it('401: 全画面エラーに倒さず開き直し導線を出す (退避は残す)', async () => {
    const sb = await toReadyCard();
    sb.queue.push({ status: 401, json: { success: false, error: 'Unauthorized' } });
    buttonsOf(sb.overlay()!).find((b) => b.textContent === 'このLINEに連携する')!.fire('click');
    await tick();
    expect(textOf(sb.overlay()!)).toContain('ログインの有効期限');
    expect(sb.storage.getItem('sublink_token_v1')).not.toBeNull();
    expect(sb.win.__fatalShown, 'softAuth によりポータル全体は生きている').toBeFalsy();
  });

  it('通信例外: 退避を残して再試行導線へ', async () => {
    const sb = await toReadyCard();
    sb.queue.push(null);
    buttonsOf(sb.overlay()!).find((b) => b.textContent === 'このLINEに連携する')!.fire('click');
    await tick();
    expect(textOf(sb.overlay()!)).toContain('通信に失敗しました');
    expect(sb.storage.getItem('sublink_token_v1')).not.toBeNull();
  });

  it('応答が返らないまま固まっても、disabled ボタンに閉じ込められない', async () => {
    const sb = await toReadyCard();
    sb.setFetchImpl(() => new Promise(() => {}));
    buttonsOf(sb.overlay()!).find((b) => b.textContent === 'このLINEに連携する')!.fire('click');
    await tick();
    expect(sb.overlay()!.getAttribute('data-sublink-phase')).toBe('redeeming');
    sb.flush(4);
    await tick();
    expect(textOf(sb.overlay()!)).toContain('通信に失敗しました');
    expect(buttonsOf(sb.overlay()!).map((b) => b.textContent)).toContain('あとで');
  });

  it('サーバが結論を返した失敗: 退避を消し、理由を表示して閉じられる', async () => {
    const sb = await toReadyCard();
    sb.queue.push({ status: 409, json: { success: false, message: 'このご登録は別のLINEと連携済みです' } });
    buttonsOf(sb.overlay()!).find((b) => b.textContent === 'このLINEに連携する')!.fire('click');
    await tick();
    const ov = sb.overlay()!;
    expect(textOf(ov)).toContain('別のLINEと連携済み');
    expect(buttonsOf(ov).map((b) => b.textContent)).toContain('とじる');
    expect(sb.storage.getItem('sublink_token_v1')).toBeNull();
  });
});

// ───────────────────────── dormancy ─────────────────────────

describe('dormancy (トークンが無ければ何もしない)', () => {
  it('?slk= 無しでは fetch 0 回・オーバーレイ 0 件・ツアーは即解放', () => {
    const sb = loadSandbox(script);
    sb.fn.captureSubLinkToken();
    sb.fn.checkSubLinkParam();
    expect(sb.calls.length).toBe(0);
    expect(sb.overlay()).toBeNull();
    expect(sb.win.__subLinkPending).toBe(false);
  });
});

// ───────────── 遅延応答 (in-flight) が閉じたカードを復活させない ─────────────

describe('飛行中の応答が「閉じたはずのモーダル」を復活させない (世代ガード)', () => {
  it('shimmer 中に背景タップで閉じた後、preview が遅れて返ってもカードは復活しない', async () => {
    let settle!: (v: unknown) => void;
    const sb = loadSandbox(script, {
      search: '?slk=tokG',
      fetchImpl: () => new Promise((r) => { settle = r as (v: unknown) => void; }),
    });
    sb.fn.captureSubLinkToken();
    sb.fn.checkSubLinkParam();
    await tick();
    expect(sb.overlay()).not.toBeNull();
    // 背景タップで離脱
    sb.overlay()!.fire('click', { target: sb.overlay() });
    expect(sb.overlay()).toBeNull();
    // 遅れて 200 ready が届く
    settle({ status: 200, json: () => Promise.resolve({ success: true, data: { status: 'ready', plan: 'P' } }) });
    await tick(10);
    expect(sb.overlay(), '閉じたモーダルが遅延応答で復活してはいけない').toBeNull();
  });

  it('redeem 飛行中に閉じた後、成功応答が届いてもカードは復活しない', async () => {
    // まず ready カードまで進める
    const sb = await runPreview([{ status: 200, json: { success: true, data: { status: 'ready', plan: 'P' } } }]);
    let settle!: (v: unknown) => void;
    sb.setFetchImpl(() => new Promise((r) => { settle = r as (v: unknown) => void; }));
    buttonsOf(sb.overlay()!).find((b) => b.textContent === 'このLINEに連携する')!.fire('click');
    await tick();
    sb.overlay()!.fire('click', { target: sb.overlay() });
    expect(sb.overlay()).toBeNull();
    settle({ status: 200, json: () => Promise.resolve({ success: true, data: { plan: 'P' } }) });
    await tick(10);
    expect(sb.overlay()).toBeNull();
  });

  it('「もう一度試す」の後に古い chain の応答が届いても、新しいカードを上書きしない', async () => {
    let settleOld!: (v: unknown) => void;
    const sb = loadSandbox(script, {
      search: '?slk=tokG',
      fetchImpl: () => new Promise((r) => { settleOld = r as (v: unknown) => void; }),
    });
    sb.fn.captureSubLinkToken();
    sb.fn.checkSubLinkParam();
    await tick();
    // スタール監視を発火させて retry カードへ
    sb.flush(4);
    await tick();
    expect(textOf(sb.overlay()!)).toContain('通信に失敗しました');
    // 「もう一度試す」で新しい chain を走らせ、こちらは ready を返す
    sb.setFetchImpl(() => Promise.resolve({ status: 200, json: () => Promise.resolve({ success: true, data: { status: 'ready', plan: '新プラン' } }) }));
    buttonsOf(sb.overlay()!).find((b) => b.textContent === 'もう一度試す')!.fire('click');
    await tick();
    expect(textOf(sb.overlay()!)).toContain('新プラン');
    // 古い chain が terminal を返してくる
    settleOld({ status: 200, json: () => Promise.resolve({ success: true, data: { status: 'expired' } }) });
    await tick(10);
    expect(textOf(sb.overlay()!), '古い応答が新しい結果を上書きしてはいけない').toContain('新プラン');
    expect(sb.storage.getItem('sublink_token_v1'), '古い応答が退避を消してはいけない').not.toBeNull();
  });

  // 以下 4 件は R3 の mutation 検査で「世代ガードを削っても緑のまま」だった穴を塞ぐ回帰。
  // 実装は正しかったが回帰ロックが無く、将来のリファクタで CI green のまま消えうる状態だった。

  it('[catch 側] dismiss 後に preview が遅れて reject しても、再試行が再開しない', async () => {
    let rejectIt!: (e: Error) => void;
    const sb = loadSandbox(script, {
      search: '?slk=tokC1',
      fetchImpl: () => new Promise((_r, rej) => { rejectIt = rej as (e: Error) => void; }),
    });
    sb.fn.captureSubLinkToken();
    sb.fn.checkSubLinkParam();
    await tick();
    const callsAtDismiss = sb.calls.length;
    sb.fn.subLinkDismiss(false as never);
    rejectIt(new Error('network down'));
    await tick(10);
    sb.flush(8);
    await tick(10);
    expect(sb.overlay(), '閉じた後に再試行 loop が復活してはいけない').toBeNull();
    expect(sb.calls.length, '閉じた後に叩き直してはいけない').toBe(callsAtDismiss);
  });

  it('[catch 側] redeem 飛行中に閉じた後、通信例外が届いてもカードが湧かない', async () => {
    const sb = await runPreview([{ status: 200, json: { success: true, data: { status: 'ready', plan: 'P' } } }]);
    let rejectIt!: (e: Error) => void;
    sb.setFetchImpl(() => new Promise((_r, rej) => { rejectIt = rej as (e: Error) => void; }));
    buttonsOf(sb.overlay()!).find((b) => b.textContent === 'このLINEに連携する')!.fire('click');
    await tick();
    sb.overlay()!.fire('click', { target: sb.overlay() });
    expect(sb.overlay()).toBeNull();
    rejectIt(new Error('network down'));
    await tick(10);
    expect(sb.overlay(), 'R2 で塞いだ HIGH が catch 経路で再発してはいけない').toBeNull();
  });

  it('[スタール] 発火後に古い応答が届いても、再試行カードが上書きされない', async () => {
    let settleOld!: (v: unknown) => void;
    const sb = loadSandbox(script, {
      search: '?slk=tokC3',
      fetchImpl: () => new Promise((r) => { settleOld = r as (v: unknown) => void; }),
    });
    sb.fn.captureSubLinkToken();
    sb.fn.checkSubLinkParam();
    await tick();
    sb.flush(4); // スタール発火
    await tick();
    expect(textOf(sb.overlay()!)).toContain('通信に失敗しました');
    // 固まっていた要求が遅れて terminal を返してくる
    settleOld({ status: 200, json: () => Promise.resolve({ success: true, data: { status: 'expired' } }) });
    await tick(10);
    expect(textOf(sb.overlay()!), 'ユーザー無操作でカードが差し替わってはいけない').toContain('通信に失敗しました');
    expect(sb.storage.getItem('sublink_token_v1'), '古い応答が退避を消してはいけない').not.toBeNull();
  });

  it('[再試行連打] 複数 chain が live になっても、最後の要求だけが UI を決める', async () => {
    const settlers: ((v: unknown) => void)[] = [];
    const sb = loadSandbox(script, {
      search: '?slk=tokC4',
      fetchImpl: () => new Promise((r) => settlers.push(r as (v: unknown) => void)),
    });
    sb.fn.captureSubLinkToken();
    sb.fn.checkSubLinkParam();
    await tick();
    sb.flush(4); // スタール → retry カード
    await tick();
    const retryBtn = () => buttonsOf(sb.overlay()!).find((b) => b.textContent === 'もう一度試す')!;
    retryBtn().fire('click'); // chain #2
    await tick();
    sb.flush(4);
    await tick();
    retryBtn().fire('click'); // chain #3
    await tick();
    expect(settlers.length).toBeGreaterThanOrEqual(3);
    // 先に張った chain #2 が ready を返しても、最新は #3 なので採用されない
    settlers[1]({ status: 200, json: () => Promise.resolve({ success: true, data: { status: 'ready', plan: '古い結果' } }) });
    await tick(10);
    expect(textOf(sb.overlay()!)).not.toContain('古い結果');
    // 最新 chain #3 の結果は採用される
    settlers[2]({ status: 200, json: () => Promise.resolve({ success: true, data: { status: 'ready', plan: '最新の結果' } }) });
    await tick(10);
    expect(textOf(sb.overlay()!)).toContain('最新の結果');
  });

  it('200 + status:invalid でも shimmer に取り残されない', async () => {
    const sb = await runPreview([{ status: 200, json: { success: true, data: { status: 'invalid' } } }]);
    const ov = sb.overlay();
    expect(ov, '無言で消えても shimmer で残ってもいけない').not.toBeNull();
    expect(textOf(ov!)).toContain('ご利用いただけません');
    expect(buttonsOf(ov!).map((b) => b.textContent)).toContain('とじる');
    expect(sb.storage.getItem('sublink_token_v1')).toBeNull();
  });

  it('dismiss は subLinkCancelTimers だけでなく世代も進める (timer 停止の削除を検出する)', async () => {
    const notFound = { status: 404, json: { success: false, error: 'Friend not found' } };
    const sb = loadSandbox(script, { search: '?slk=tokT' });
    sb.queue.push(notFound, notFound, notFound, notFound, notFound, notFound);
    sb.fn.captureSubLinkToken();
    sb.fn.checkSubLinkParam();
    await tick();
    const callsAtDismiss = sb.calls.length;
    sb.fn.subLinkDismiss(false as never);
    expect(sb.overlay()).toBeNull();
    // microtask を挟みながら timer を進める (同期 drain だと世代ガードの欠落を見逃す)
    for (let i = 0; i < 8; i++) {
      sb.flush(1);
      await tick();
    }
    expect(sb.overlay(), '閉じた後にモーダルが復活してはいけない').toBeNull();
    expect(sb.calls.length, '閉じた後に叩き続けてはいけない').toBe(callsAtDismiss);
  });
});

// ───────────── transient な失敗を「結論」扱いしない ─────────────

describe('transient な失敗の扱い', () => {
  it('429 (レート制限・CGNAT 共有 IP で誤爆しうる) は結論扱いせず退避を残す', async () => {
    const sb = await runPreview([{ status: 429, json: { success: false, error: 'rate limited' } }]);
    expect(textOf(sb.overlay()!)).toContain('通信に失敗しました');
    expect(sb.storage.getItem('sublink_token_v1')).not.toBeNull();
  });

  it('gate off (404) と不正リンク (400) で案内文を書き分ける', async () => {
    const paused = await runPreview([{ status: 404, json: { success: false, error: 'not_found' } }]);
    expect(textOf(paused.overlay()!), '店舗都合の停止に「メールを探せ」は不誠実').toContain('一時停止');

    const bad = await runPreview([{ status: 400, json: { success: false, error: 'bad token' } }]);
    expect(textOf(bad.overlay()!)).toContain('最新のご案内メール');
  });
});

// ───────────────────────── 可読性トークン ─────────────────────────

describe('60代可読性トークン (§7)', () => {
  it('連携カードの本文は 16px 以上・行間 1.6・タップ領域 48px 以上', async () => {
    const html = await portalHtml();
    expect(html).toContain('.sublink-body{font-size:16px');
    expect(html).toMatch(/\.sublink-body\{[^}]*line-height:1\.6/);
    expect(html).toContain('.sublink-btn{min-height:48px');
    expect(html).toContain('.sublink-sub{min-height:48px');
  });

  it('プラン名は 20px bold #0f766e (§7-2 の要点寸法)', async () => {
    const html = await portalHtml();
    expect(html).toContain('.sublink-plan{font-size:20px;font-weight:700;color:#0f766e');
  });

  it('連携オーバーレイは loading(z-50)/ツアー(z-60) より前面の z-index 70', async () => {
    const html = await portalHtml();
    expect(html).toContain('#sublink-overlay{z-index:70}');
    expect(html).toContain('z-index:60;background:rgba(0,0,0,0.55)');
    expect(html).toContain('id="loading" class="fixed inset-0 flex items-center justify-center z-50"');
  });

  it('白文字ユーティリティの塗り面も AA を満たす色へ写像されている', async () => {
    const html = await portalHtml();
    // .bg-green-500/600 は text-white と組で使われる面が複数あるため #2fa8ad (2.87:1) では不足
    // btn-primary (#0f766e) と同色にすると非対話バッジと購入 CTA が見分けられないため 1 段暗い色にする
    expect(html).toContain('.bg-green-500,.bg-green-600{background-color:#115e59 !important}');
    // 10px 白文字を amber gradient に載せていたバッジも solid の暗色へ
    expect(html).toMatch(/\.ambassador-badge\{[^}]*background:#92400e;color:#fff/);
  });
});

// ───────────────────────── 全 surface の AA ─────────────────────────

describe('全 LIFF surface の実行ボタンが白文字 AA を満たす (§7-1)', () => {
  const surfaces: [string, string, () => Promise<{ request: typeof liffPages.request }>][] = [
    ['/liff/portal', '/liff/portal', async () => liffPages],
    ['/liff/opt-in', '/liff/opt-in', async () => (await import('../routes/liff-opt-in-page.js')).liffOptInPage],
    ['/liff/reorder', '/liff/reorder', async () => (await import('../routes/liff-reorder-page.js')).liffReorderPage],
    ['/liff/food', '/liff/food', async () => (await import('../routes/liff-food-page.js')).liffFoodPage],
    ['/liff/food/graph', '/liff/food/graph', async () => (await import('../routes/liff-food-graph.js')).liffFoodGraph],
    ['/liff/coach', '/liff/coach', async () => (await import('../routes/liff-coach-page.js')).liffCoachPage],
    ['/liff/my-rank', '/liff/my-rank', async () => (await import('../routes/liff-my-rank.js')).liffMyRank],
  ];

  it.each(surfaces)('%s: 白文字を載せる面に AA 不足の色を使わない', async (_label, path, appOf) => {
    const app = await appOf();
    const res = await app.request(path, {}, baseEnv as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    const html = await res.text();
    // #06C755=2.2:1 / #059669=3.8:1 / #0ABAB5=2.5:1 / #22d3ee=1.9:1 — いずれも白文字には不足
    expect(html).not.toContain('#059669');
    expect(html).not.toContain('#0ABAB5');
    expect(html).not.toContain('#22d3ee');
    for (const line of html.split('\n').filter((l) => l.includes('#06C755'))) {
      expect(line, '例外は「LINEで送る」= LINE 機能そのもののボタンのみ').toContain('LINE');
    }
  });

  it.each(surfaces.filter(([l]) => l !== '/liff/my-rank'))(
    '%s: btn-primary の塗りが AA 安全形にピン留めされている (--grad-btn or solid #0f766e)',
    async (_label, path, appOf) => {
      const app = await appOf();
      const res = await app.request(path, {}, baseEnv as unknown as Record<string, unknown>);
      const html = await res.text();
      // VITAL INSTRUMENT (2026-08-11): ポータルは縦グラデ var(--grad-btn) に移行。
      // ガードの意図 (AA 破壊グラデの再来防止) は維持する — token 側の両端 hex を
      // ピン留めし、#11837c (4.67:1) / #0f766e (5.47:1) 以外へ変えると赤になる。
      const usesToken = /\.btn-primary\{background:var\(--grad-btn\)/.test(html);
      if (usesToken) {
        expect(html).toMatch(/--grad-btn:linear-gradient\(180deg,#11837c,#0f766e\)/);
      } else {
        expect(html).toMatch(/\.btn-primary\{background:#0f766e/);
      }
    },
  );
});

// ───────────────────────── C3: オンラインストア連携の導線 ─────────────────────────
//
// 連携済み 10 人が全機能 (配送状況・再注文・ランク・定期便) の分母になっている。
// 未連携者が必ず当たる「空表示」を行き止まりにせず、連携への出口にするのが C3。
// 文字列 contains では「分岐が dead-code 化した」変異を検出できないため、
// 吐き出された client JS を**実際に実行して** DOM の状態を観測する。
describe('C3: オンラインストア連携の導線', () => {
  let proxyScript = '';

  beforeAll(async () => {
    const env = {
      ...baseEnv,
      APP_PROXY_LINK_ENABLED: 'true',
      SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com',
    };
    const res = await liffPages.request('/liff/portal', {}, env as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    proxyScript = inlineScript(await res.text());
  });

  /** 実ページと同じ形の CTA 2 種 (畳み方が違う) を置いた sandbox。 */
  function withCtas() {
    const sb = loadSandbox(proxyScript);
    const home = el('div');
    home.id = 'shopify-link-home-card';
    home.setAttribute('data-shopify-link-cta', 'hide');
    home.style.display = 'none';
    sb.body.appendChild(home);

    const account = el('div');
    account.id = 'shopify-link-card';
    account.setAttribute('data-shopify-link-cta', 'replace');
    const stale = el('button');
    stale.textContent = 'ストアにログインして連携 →';
    account.appendChild(stale);
    sb.body.appendChild(account);

    return { sb, home, account };
  }

  /** `fn` は引数型を持たない汎用シグネチャなので、この関数だけ型を付け直して呼ぶ。 */
  const ctaHtml = (sb: Sandbox, lead: string): string =>
    (sb.fn.shopifyLinkCtaHtml as unknown as (s: string) => string)(lead);

  it('未確定 (loadRank 前) でも空表示に導線を出す — 出して後から畳む方が取り逃さない', () => {
    const sb = loadSandbox(proxyScript);
    const html = ctaHtml(sb, 'ご注文済みの場合は連携がまだかもしれません。');
    expect(html).toContain('data-shopify-link-cta="hide"');
    expect(html).toContain('openShopifyLinkPage()');
    expect(html).toContain('ご注文済みの場合は連携がまだかもしれません。');
    // OTP gate off の面では OTP ボタンを 1 byte も出さない (押した先が 404 の死んだボタン)
    expect(html).not.toContain('openAccountLinkCard()');
  });

  it('OTP gate on → 空表示 CTA はメール連携が第一候補・ストアログインは第二候補 (実行ベース)', async () => {
    const env = {
      ...baseEnv,
      APP_PROXY_LINK_ENABLED: 'true',
      SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com',
      ACCOUNT_LINK_ENABLED: 'true',
    };
    const res = await liffPages.request('/liff/portal', {}, env as unknown as Record<string, unknown>);
    const script = inlineScript(await res.text());
    const sb = loadSandbox(script);
    const html = ctaHtml(sb, 'ご注文済みの場合は連携がまだかもしれません。');
    const otpAt = html.indexOf('openAccountLinkCard()');
    const storeAt = html.indexOf('openShopifyLinkPage()');
    expect(otpAt).toBeGreaterThanOrEqual(0);
    expect(storeAt).toBeGreaterThan(otpAt);
    expect(html).toContain('メールで連携する（LINEの中で完結）→');
    // ストアログイン側だけが第二候補スタイル (class 属性は onclick の後ろに出る)
    expect(html.slice(storeAt, storeAt + 200)).toContain('link-cta-secondary');
    expect(html.slice(otpAt, storeAt)).not.toContain('link-cta-secondary');
  });

  it('OTP gate のみ on (App Proxy off) → 空表示 CTA はメール連携だけ (実行ベース)', async () => {
    const env = { ...baseEnv, ACCOUNT_LINK_ENABLED: 'true' };
    const res = await liffPages.request('/liff/portal', {}, env as unknown as Record<string, unknown>);
    const script = inlineScript(await res.text());
    const sb = loadSandbox(script);
    const html = ctaHtml(sb, 'ご注文済みの場合は連携がまだかもしれません。');
    expect(html).toContain('openAccountLinkCard()');
    expect(html).not.toContain('openShopifyLinkPage()');
  });

  // ─── slk 死路の復旧文言 (実行ベース。採点ループ MED: ソース内リテラル存在の contains だと
  //     ACCOUNT_LINK_OTP_ON 分岐の反転/削除が全緑で通る — 両アームの文字列は常に JS に在るため) ───
  describe('slk 死路の復旧文言は OTP gate に実行時連動する', () => {
    async function scriptWith(env: Record<string, string>) {
      const res = await liffPages.request(
        '/liff/portal', {},
        { ...baseEnv, ...env } as unknown as Record<string, unknown>,
      );
      return inlineScript(await res.text());
    }
    const PROXY_ENV = { APP_PROXY_LINK_ENABLED: 'true', SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com' };
    type StatusInfo = (s: string, k: string) => { title: string; desc: string };

    it('expired(shop): OTP on → メール連携を案内 / off → ストアログイン再試行を案内', async () => {
      const on = loadSandbox(await scriptWith({ ...PROXY_ENV, ACCOUNT_LINK_ENABLED: 'true' }));
      const dOn = (on.fn.subLinkStatusInfo as unknown as StatusInfo)('expired', 'shop').desc;
      expect(dOn).toContain('メールで連携する（LINEの中で完結）');
      expect(dOn).not.toContain('プロフィール写真');

      const off = loadSandbox(await scriptWith(PROXY_ENV));
      const dOff = (off.fn.subLinkStatusInfo as unknown as StatusInfo)('expired', 'shop').desc;
      expect(dOff).toContain('プロフィール写真');
      expect(dOff).not.toContain('メールで連携する（LINEの中で完結）');
    });

    it('unavailable(invalid): OTP on → メール連携 / off+proxy → プロフィール写真 / 両 off → ご案内メール', async () => {
      const bodyText = (sb: Sandbox) => {
        (sb.fn.subLinkShowUnavailable as unknown as (k: string) => void)('invalid');
        return textOf(sb.body);
      };
      const on = loadSandbox(await scriptWith({ ...PROXY_ENV, ACCOUNT_LINK_ENABLED: 'true' }));
      expect(bodyText(on)).toContain('メールで連携する（LINEの中で完結）');

      const proxyOnly = loadSandbox(await scriptWith(PROXY_ENV));
      const t2 = bodyText(proxyOnly);
      expect(t2).toContain('プロフィール写真');
      expect(t2).not.toContain('メールで連携する（LINEの中で完結）');

      const none = loadSandbox(await scriptWith({}));
      expect(bodyText(none)).toContain('ご案内メール');
    });
  });

  it('🚨連携済みと分かっている面には導線を出さない (既連携者を外部ブラウザへ往復させない)', () => {
    const sb = loadSandbox(proxyScript);
    (sb.win as Record<string, unknown>).__shopifyLinked = true;
    expect(ctaHtml(sb, 'x')).toBe('');
  });

  it('markShopifyLinked が hide/replace を面ごとに畳み分ける', () => {
    const { sb, home, account } = withCtas();
    home.style.display = ''; // 未連携判明で開いていた状態
    sb.fn.markShopifyLinked();

    expect(home.style.display).toBe('none'); // 空/ホームの導線は消す
    expect(home.getAttribute('data-linked')).toBe('1');
    // 常設カードは「連携済み」へ差し替え (= 古い**連携**ボタンが残らない)
    expect(textOf(account)).toContain('連携済み');
    expect(textOf(account)).not.toContain('ストアにログインして連携');
    expect(textOf(account)).not.toContain('メールで連携する');
    // 🚨 2026-08-31: 解除の入口をここに足した (会員証にしか無く利用者が迷ったため)。
    //    ガードの意図は「古い連携 CTA が残らない」ことなので、0 個ではなく
    //    「解除の入口だけが在る」で固定する。
    const accountBtns = buttonsOf(account);
    expect(accountBtns).toHaveLength(1);
    expect(accountBtns[0].textContent).toContain('連携の設定・解除');
    expect((sb.win as Record<string, unknown>).__shopifyLinked).toBe(true);
  });

  it('markShopifyLinked は冪等 (二重呼び出しで表示が壊れない)', () => {
    const { sb, account } = withCtas();
    sb.fn.markShopifyLinked();
    const first = textOf(account);
    sb.fn.markShopifyLinked();
    expect(textOf(account)).toBe(first);
  });

  it('🚨畳んだ後に遅れて「未連携」が届いてもホームカードを再表示しない', () => {
    // redeem 成功 → markShopifyLinked → その後 loadRank の古い応答が linked=false で着弾、
    // という順序が起きうる。ここで開き直すと「連携したのにまた連携を促される」
    const { sb, home } = withCtas();
    sb.fn.markShopifyLinked();
    sb.fn.showShopifyLinkHomeCard();
    expect(home.style.display).toBe('none');
  });

  it('未連携が確定したらホームカードを開く', () => {
    const { sb, home } = withCtas();
    expect(home.style.display).toBe('none'); // 既定は非表示 = 既連携者には一瞬も出ない
    sb.fn.showShopifyLinkHomeCard();
    expect(home.style.display).toBe('');
  });
});

// ───────── C3: 呼び出し側まで実行して検証する (mutation で穴が判明した分) ─────────
//
// 関数単体のテストだけでは「空表示から呼び出しを消す」「未連携分岐を消す」といった変異が
// 生き残る (2026-08-05 の C3 mutation で実測: M1/M2/M7/M9/M10 が SURVIVED)。
// loadShopData / loadRank / reorderShortcut を**実際に走らせて** DOM を観測する。
describe('C3: 呼び出し側の実行検証', () => {
  let proxyScript = '';

  beforeAll(async () => {
    const env = {
      ...baseEnv,
      APP_PROXY_LINK_ENABLED: 'true',
      SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com',
    };
    const res = await liffPages.request('/liff/portal', {}, env as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    proxyScript = inlineScript(await res.text());
  });

  /** Shop タブのカード 3 枚を実ページと同じ id で置いた sandbox。 */
  function shopSandbox(opts: { orders?: unknown[]; fulfillments?: unknown[] } = {}) {
    const sb = loadSandbox(proxyScript);
    // #toast は showToast が無条件に触る (実ページに常在する要素)。
    // 無いと reorderShortcut が TypeError で落ち、テストが「実装の欠陥」でなく
    // 「fixture の不足」で赤くなる
    for (const id of ['products-card', 'orders-card', 'fulfillments-card', 'rank-card', 'toast']) {
      const card = el('div');
      card.id = id;
      sb.body.appendChild(card);
    }
    sb.setFetchImpl((url: string) => {
      const path = String(url);
      const json = path.includes('/api/liff/reorder')
        ? { success: true, data: { products: [], orders: opts.orders ?? [] } }
        : path.includes('/api/liff/fulfillments')
          ? { success: true, data: { fulfillments: opts.fulfillments ?? [], latestOrder: null } }
          : { success: true, data: {} };
      return Promise.resolve({ status: 200, json: () => Promise.resolve(json) });
    });
    return sb;
  }

  it('🚨注文履歴が空のとき、連携導線が実際に描画される', async () => {
    const sb = shopSandbox();
    await (sb.fn.loadShopData as unknown as () => Promise<void>)();
    const oel = findById(sb.body, 'orders-card')!;
    expect(oel.innerHTML).toContain('まだ注文がありません');
    expect(oel.innerHTML).toContain('data-shopify-link-cta="hide"');
    expect(oel.innerHTML).toContain('openShopifyLinkPage()');
  });

  it('🚨同じ CTA を 2 枚並べない — 配送カード側には出さない', () => {
    // orders-card と fulfillments-card は section-shop 内の隣接兄弟で、
    // 未連携者は**定義上必ず両方が空**になる (どちらも friend_id スコープ)。
    // 両方に挿すと 100% の未連携者が同一 CTA を 2 枚見る
    return (async () => {
      const sb = shopSandbox();
      await (sb.fn.loadShopData as unknown as () => Promise<void>)();
      expect(findById(sb.body, 'orders-card')!.innerHTML).toContain('data-shopify-link-cta');
      expect(findById(sb.body, 'fulfillments-card')!.innerHTML).not.toContain('data-shopify-link-cta');
    })();
  });

  it('🚨空表示の文言は断定しない (注文したことがない人に「連携すれば履歴が出る」は嘘)', async () => {
    // この面を見る母集団は圧倒的に「まだ注文したことがない友だち」
    // (顧客 3,434 / 友だち 6,581 に対し連携 10)。条件節を必ず付ける
    const sb = shopSandbox();
    await (sb.fn.loadShopData as unknown as () => Promise<void>)();
    const html = findById(sb.body, 'orders-card')!.innerHTML;
    expect(html).toContain('ご注文済みの場合は');
    expect(html).not.toContain('連携すると表示されます');
  });

  it('CTA は §7 の可読性トークンを満たす (本文 16px / タップ 48px)', async () => {
    const sb = shopSandbox();
    await (sb.fn.loadShopData as unknown as () => Promise<void>)();
    const html = findById(sb.body, 'orders-card')!.innerHTML;
    expect(html).toContain('text-base'); // リード文 16px (text-sm=14px にしない)
    expect(html).toContain('min-height:48px');
  });

  it('連携済みなら空表示に導線を出さない (実行経路でも既連携者を煩わせない)', async () => {
    const sb = shopSandbox();
    (sb.win as Record<string, unknown>).__shopifyLinked = true;
    await (sb.fn.loadShopData as unknown as () => Promise<void>)();
    expect(findById(sb.body, 'fulfillments-card')!.innerHTML).not.toContain('data-shopify-link-cta');
    expect(findById(sb.body, 'orders-card')!.innerHTML).not.toContain('data-shopify-link-cta');
  });

  it('🚨flag が false に巻き戻っても、畳んだ CTA が DOM にあれば出し直さない', async () => {
    // redeem 成功 → markShopifyLinked → その後 **redeem 前のスナップショット**を読んだ
    // loadRank 応答が届く、という順序が実在する。flag だけを見ていると
    // 連携したばかりの人のショップタブに「連携する」が復活する
    const sb = shopSandbox();
    await (sb.fn.loadShopData as unknown as () => Promise<void>)();
    (sb.fn.markShopifyLinked as unknown as () => void)();
    (sb.win as Record<string, unknown>).__shopifyLinked = false; // 遅れて届いた false
    await (sb.fn.loadShopData as unknown as () => Promise<void>)();
    expect(findById(sb.body, 'orders-card')!.innerHTML).not.toContain('data-shopify-link-cta');
  });

  it('🚨loadRank が linked=false を返したらホームカードが開く', async () => {
    const sb = loadSandbox(proxyScript);
    const rank = el('div');
    rank.id = 'rank-card';
    sb.body.appendChild(rank);
    const home = el('div');
    home.id = 'shopify-link-home-card';
    home.setAttribute('data-shopify-link-cta', 'hide');
    home.style.display = 'none';
    sb.body.appendChild(home);
    sb.setFetchImpl(() =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({ success: true, data: { linked: false } }) }),
    );

    await (sb.fn.loadRank as unknown as () => Promise<void>)();
    expect(home.style.display).toBe('');
    expect((sb.win as Record<string, unknown>).__shopifyLinked).toBe(false);
  });

  it('loadRank が linked=true を返したらホームカードは閉じたまま畳まれる', async () => {
    const sb = loadSandbox(proxyScript);
    const rank = el('div');
    rank.id = 'rank-card';
    sb.body.appendChild(rank);
    const home = el('div');
    home.id = 'shopify-link-home-card';
    home.setAttribute('data-shopify-link-cta', 'hide');
    home.style.display = 'none';
    sb.body.appendChild(home);
    sb.setFetchImpl(() =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({ success: true, data: { linked: true } }) }),
    );

    await (sb.fn.loadRank as unknown as () => Promise<void>)();
    expect(home.style.display).toBe('none');
    expect(home.getAttribute('data-linked')).toBe('1');
  });

  it('🚨再注文ショートカット: 履歴が空でも導線があれば CTA 自身へ送る (行き止まりにしない)', async () => {
    const sb = shopSandbox();
    await (sb.fn.loadShopData as unknown as () => Promise<void>)();
    (sb.fn.reorderShortcut as unknown as () => void)();
    // スクロール先は CTA (top:500) — カード上端 (top:200) だと空表示の見出しぶん下に隠れる
    expect(sb.scrolls).toHaveLength(1);
    expect(sb.scrolls[0].top).toBe(500 - 110);
    expect(findById(sb.body, 'toast')!.textContent).toContain('ご注文済みの場合は');
  });

  it('🚨連携済みなら再注文ショートカットで「連携すると…」と案内しない', async () => {
    // markShopifyLinked は CTA をノードごと消さず display:none にするだけなので、
    // 要素の有無だけで判定すると連携済みの人に連携を促してしまう
    const sb = shopSandbox();
    await (sb.fn.loadShopData as unknown as () => Promise<void>)();
    (sb.fn.markShopifyLinked as unknown as () => void)();
    (sb.fn.reorderShortcut as unknown as () => void)();
    expect(sb.scrolls).toHaveLength(0); // 隠れた CTA へスクロールしない
    expect(findById(sb.body, 'toast')!.textContent).toContain('まだ注文履歴がありません');
  });

  it('gate off (SHOPIFY_LINK_URL=null) では空表示に導線が出ない = ロールバックが効く', async () => {
    // 本番の kill switch は APP_PROXY_LINK_ENABLED を false に戻すこと。
    // client 側がその状態で「押しても何も起きないボタン」を出さないことを固定する
    const sbOff = loadSandbox(inlineScript(await portalHtml())); // gate off の HTML
    for (const id of ['products-card', 'orders-card', 'fulfillments-card', 'toast']) {
      const card = el('div');
      card.id = id;
      sbOff.body.appendChild(card);
    }
    sbOff.setFetchImpl(() =>
      Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ success: true, data: { products: [], orders: [], fulfillments: [], latestOrder: null } }),
      }),
    );
    await (sbOff.fn.loadShopData as unknown as () => Promise<void>)();
    expect(findById(sbOff.body, 'orders-card')!.innerHTML).not.toContain('data-shopify-link-cta');
  });
});

// ───────── C3: server HTML と client セレクタの配線 / gate on のマークアップ ─────────
//
// テストの fixture は el() + setAttribute で CTA を自作している。それだけだと
// 「server が実際に吐く属性」と「client が探すセレクタ」が食い違っても緑になる
// (採点 test-integrity HIGH)。実 HTML 側からも配線を固定する。
describe('C3: 配線とブランドガード (gate on の実マークアップ)', () => {
  let gateOnHtml = '';

  beforeAll(async () => {
    const env = {
      ...baseEnv,
      APP_PROXY_LINK_ENABLED: 'true',
      SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com',
    };
    const res = await liffPages.request('/liff/portal', {}, env as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    gateOnHtml = await res.text();
  });

  it('server が吐く CTA 属性と client が探すセレクタが一致する', () => {
    // markShopifyLinked が走査するのは `[data-shopify-link-cta]`。
    // server 側の属性名を変えたらここが落ちる (逆も同じ)
    expect(gateOnHtml).toContain('data-shopify-link-cta="replace"'); // マイアカウントの常設カード
    expect(gateOnHtml).toContain('data-shopify-link-cta="hide"'); // ホームカード
    expect(gateOnHtml).toContain("querySelectorAll('[data-shopify-link-cta]')");
    expect(gateOnHtml).toContain('[data-shopify-link-cta][data-linked="1"]');
  });

  it('畳み方の値は replace / hide の 2 種類だけ (client の分岐と対応する)', () => {
    const values = [...gateOnHtml.matchAll(/data-shopify-link-cta="([^"]*)"/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    expect([...new Set(values)].sort()).toEqual(['hide', 'replace']);
  });

  it('gate on のマークアップでもブランド色ガードを満たす', () => {
    // 既存のブランドテストは gate off の HTML しか見ていないため、
    // 連携カード群 (= この PR が追加した面) が誰にも検査されていなかった
    expect(gateOnHtml).not.toContain('#059669');
    expect(gateOnHtml).not.toContain('#0ABAB5');
    expect(gateOnHtml).not.toContain('#22d3ee');
    for (const line of gateOnHtml.split('\n').filter((l) => l.includes('#06C755'))) {
      expect(line, '例外は「LINEで送る」= LINE 機能そのもののボタンのみ').toContain('LINE');
    }
  });

  it('連携 CTA のボタンは AA 検証済みの塗りだけを使う (btn-primary / link-cta-secondary)', () => {
    // 関数定義行 (`function openShopifyLinkPage()`) ではなく、onclick で呼ぶ**ボタン**だけを見る。
    // 2026-08-26: OTP 第一候補化でストアログインは第二候補 (link-cta-secondary =
    // --brand-soft 地 + --action 文字 5.0:1) に降格しうる。許すのはこの 2 クラスのみ —
    // クラス無しの生 style や新 hex を書いたら落ちる。
    const ctaButtons = gateOnHtml
      .split('\n')
      .filter((l) => l.includes('onclick="openShopifyLinkPage()"'));
    expect(ctaButtons.length).toBeGreaterThan(0);
    for (const line of ctaButtons) {
      expect(/btn-primary|link-cta-secondary/.test(line), line).toBe(true);
    }
    // 第一候補 (メール OTP) のボタンは常に btn-primary (第二候補スタイルに落とさない)
    for (const line of gateOnHtml.split('\n').filter((l) => l.includes('onclick="openAccountLinkCard()"'))) {
      expect(line).toContain('btn-primary');
      expect(line).not.toContain('link-cta-secondary');
    }
  });

  it('OTP gate も on のとき、ストアログインは第二候補 (link-cta-secondary) に降格する', async () => {
    const env = {
      ...baseEnv,
      APP_PROXY_LINK_ENABLED: 'true',
      SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com',
      ACCOUNT_LINK_ENABLED: 'true',
    };
    const res = await liffPages.request('/liff/portal', {}, env as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    const html = await res.text();
    // server 側で emit される両カード (home + マイアカウント) で、OTP が第一候補 (btn-primary)、
    // ストアログインが第二候補 (link-cta-secondary) になっている
    const otpButtons = html.split('\n').filter((l) => l.includes('onclick="openAccountLinkCard()"') && l.includes('<button'));
    expect(otpButtons.length).toBeGreaterThanOrEqual(2); // home + マイアカウント
    for (const line of otpButtons) expect(line).toContain('btn-primary');
    const storeButtons = html.split('\n').filter((l) => l.includes('onclick="openShopifyLinkPage()"') && l.includes('<button') && !l.includes("'<button"));
    expect(storeButtons.length).toBeGreaterThanOrEqual(2);
    for (const line of storeButtons) expect(line).toContain('link-cta-secondary');
  });
});
