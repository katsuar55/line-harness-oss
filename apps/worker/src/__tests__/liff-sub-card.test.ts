/**
 * Ultraplan PR-5: shop タブ「定期便のお手続き」カード (gate LIFF_SUB_CARD_ENABLED)。
 *
 * - off (既定) = fragment を 1 byte も emit しない (dark)
 * - on = PR-4 の 3 endpoint を呼ぶ UI。§1 (受理は常に成功・承りました止まり)、
 *   §2 (skip/pause 1 タップ・date/cancel 2 タップ)、§4-1 (late_promise 開示 → ack 再送)、
 *   §1-3 (取り消す併記) を **吐き出された client JS を実行して**観測する。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { liffPages } from '../routes/liff-pages.js';

interface MinimalEnv {
  LIFF_URL: string;
  WORKER_URL: string;
  LIFF_SUB_CARD_ENABLED?: string;
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
  const withInit = scripts.filter((s) => s.includes('initLiff'));
  expect(withInit.length).toBe(1);
  return withInit[0];
}

// ───────────────────────── ミニ DOM (sub-card が触る id を実在させる) ─────────────────────────

interface FakeEl {
  id: string;
  value: string;
  disabled: boolean;
  style: Record<string, string>;
  _html: string;
  innerHTML: string;
}

function el(id: string): FakeEl {
  const node: FakeEl = {
    id,
    value: '',
    disabled: false,
    style: {},
    _html: '',
    get innerHTML() {
      return node._html;
    },
    set innerHTML(html: string) {
      node._html = html;
    },
  };
  return node;
}

const IDS = [
  'loading',
  'sub-contracts-card',
  'sub-contracts-list',
  'sc-item-0',
  'sc-panel-0',
  'sc-msg-0',
  'sc-date-0',
  'sc-item-1',
  'sc-panel-1',
  'sc-msg-1',
  'sc-date-1',
];

interface FetchCall {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface Sandbox {
  fn: Record<string, (...a: never[]) => unknown>;
  byId: Map<string, FakeEl>;
  calls: FetchCall[];
  toasts: string[];
  /** 'METHOD /path-prefix' → 応答 (先勝ち)。無ければ 200 { success:true, data:null }。 */
  respond: Map<string, { status: number; json: unknown }>;
}

function loadSandbox(script: string): Sandbox {
  const byId = new Map<string, FakeEl>(IDS.map((id) => [id, el(id)]));
  // 実ブラウザ準拠: list.innerHTML の再設定は配下の sc-item/panel/msg/date を丸ごと破棄して
  // 空で作り直す。これが無いと「メッセージを書いてから再描画する」順序バグが構造的に
  // 観測不能になる (採点ループ R1 で order-swap mutation が素通りした実測に基づく)。
  const list = byId.get('sub-contracts-list')!;
  const plainSet = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(list), 'innerHTML') ??
    Object.getOwnPropertyDescriptor(list, 'innerHTML')!;
  Object.defineProperty(list, 'innerHTML', {
    get() {
      return list._html;
    },
    set(html: string) {
      for (const [id, node] of byId) {
        if (/^sc-(item|panel|msg|date)-/.test(id)) {
          node._html = '';
          node.value = '';
        }
      }
      void plainSet;
      list._html = html;
    },
  });
  const calls: FetchCall[] = [];
  const toasts: string[] = [];
  const respond: Sandbox['respond'] = new Map();

  const doc = {
    addEventListener() {},
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [] as FakeEl[],
    createElement: (t: string) => el(t),
    body: el('body'),
  };
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const win: Record<string, unknown> = {
    sessionStorage: storage,
    localStorage: storage,
    location: { href: 'https://example.workers.dev/liff/portal', search: '', hash: '', reload() {}, replace() {} },
    history: { replaceState() {} },
    addEventListener() {},
    scrollTo() {},
  };
  const fakeFetch = (url: string, init?: { method?: string; body?: string }) => {
    const path = String(url).replace(baseEnv.WORKER_URL, '');
    let body: Record<string, unknown> | null = null;
    try {
      body = init && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    const method = (init && init.method) || 'GET';
    calls.push({ path, method, body });
    for (const [key, resp] of respond) {
      const sp = key.indexOf(' ');
      const km = key.slice(0, sp);
      const kp = key.slice(sp + 1);
      if (km === method && path.indexOf(kp) === 0) {
        return Promise.resolve({ status: resp.status, json: () => Promise.resolve(resp.json) });
      }
    }
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ success: true, data: null }) });
  };

  const EXPORTS = [
    'loadSubContracts',
    'loadSubContractsOnce',
    'scAct',
    'scSubmit',
    'scSubmitDate',
    'scSubmitCancel',
    'scAckResend',
    'scUndo',
    'scShowDatePanel',
    'scShowCancelPanel',
    'scClearPanel',
    'scJpDate',
    'scAddDays',
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
    // showToast は本体実装 (DOM 依存) を上書きして観測点にする
    script + "\n;showToast = function (m) { window.__toasts.push(String(m)); };" +
      '\n;return { ' + EXPORTS.map((n) => n + ': ' + n).join(', ') + ' };',
  );
  win.__toasts = toasts;
  const fn = factory(
    win,
    doc,
    win.location,
    storage,
    storage,
    (cb: () => void) => {
      void cb;
      return 0;
    },
    () => {},
    () => 0,
    fakeFetch,
    { log() {}, warn() {}, error() {} },
    { getDecodedIDToken: () => ({ sub: 'U_alice' }) },
  ) as Sandbox['fn'];
  return { fn, byId, calls, toasts, respond };
}

const CONTRACT = {
  contractId: 'gid://shopify/SubscriptionContract/123',
  planName: 'ブルー30日分',
  intervalDays: 30,
  orderCount: 5,
  state: 'active',
  presentableDate: '2026-09-05',
  cycleKey: 'gid://shopify/SubscriptionContract/123:2026-09-05',
  deadlineText: '変更のご依頼は 9月2日 まで承れます',
  openIntents: [] as unknown[],
};

function listJson(overrides: Record<string, unknown> = {}, contract: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      enabled: true,
      linked: true,
      subIntentEnabled: true,
      contracts: [{ ...CONTRACT, ...contract }],
      ...overrides,
    },
  };
}

/** fake button: onclick ハンドラへ渡す this 相当 (data-* だけ持つ)。 */
function fakeBtn(attrs: Record<string, string>) {
  return {
    disabled: false,
    getAttribute: (k: string) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
  };
}

let scriptOn = '';
let htmlOn = '';
let htmlOff = '';
beforeAll(async () => {
  htmlOn = await portalHtml({ LIFF_SUB_CARD_ENABLED: 'true' });
  htmlOff = await portalHtml();
  scriptOn = inlineScript(htmlOn);
});

// ───────────────────────── gate (dark = 0 byte) ─────────────────────────

describe('gate LIFF_SUB_CARD_ENABLED (既定 off = fragment を 1 byte も出さない)', () => {
  it('off: カード HTML / JS / CSS のいずれも emit されない', () => {
    expect(htmlOff).not.toContain('sub-contracts-card');
    expect(htmlOff).not.toContain('loadSubContracts');
    expect(htmlOff).not.toContain('.sc-btn');
    // 配線 (loadSubContractsOnce 呼び出し) ごと emit されない = 真の dark
    expect(htmlOff).not.toContain('loadSubContractsOnce');
  });

  it('on: カード HTML + JS + CSS + shop タブの lazy-load 配線が現れる', () => {
    expect(htmlOn).toContain('id="sub-contracts-card"');
    expect(htmlOn).toContain('function loadSubContracts');
    expect(htmlOn).toContain('.sc-btn{min-height:48px');
    // shop タブ lazy-load + deep-link 先行フェッチの**分岐内**に配線される
    // (出現回数だけの assert は「if (name === 'account') 側へ移動」の mutation を素通りする)
    expect(scriptOn).toMatch(/if \(name === 'shop'\) \{[\s\S]{0,300}?loadSubContractsOnce\(\);/);
    expect(scriptOn).toMatch(/earlyDest === 'delivery'[\s\S]{0,300}?loadSubContractsOnce\(\);/);
  });
});

// ───────────────────────── 描画 ─────────────────────────

describe('loadSubContracts — 描画', () => {
  it('active 契約: プラン名・次回お届け日 (20px 面)・3 ボタン + 解約リンク (§7 ボタン最大3)', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', { status: 200, json: listJson() });
    await (sb.fn.loadSubContracts as unknown as () => Promise<void>)();
    const card = sb.byId.get('sub-contracts-card')!;
    const list = sb.byId.get('sub-contracts-list')!;
    expect(card.style.display).toBe('block');
    expect(list.innerHTML).toContain('ブルー30日分');
    // §3-2: derived 推定は断定しない — 「決済予定」ラベル + 「ごろ」必須
    expect(list.innerHTML).toContain('次回の決済予定');
    expect(list.innerHTML).toContain('9月5日ごろ');
    expect(list.innerHTML).not.toContain('お届け予定</p>'); // 決済日をお届け日と誤表記しない
    expect(list.innerHTML).toContain('変更のご依頼は 9月2日 まで承れます');
    // §3: skip 1 タップは「押す前に結果日付が読める」が成立条件 (9/5 + 30日 = 10/5)
    expect(list.innerHTML).toContain('押すと 次回は 10月5日ごろ になるお申し込みになります');
    const buttons = (list.innerHTML.match(/<button/g) ?? []).length;
    expect(buttons, 'ボタンは skip/date/pause の 3 個まで (§7)').toBe(3);
    expect(list.innerHTML).toContain('解約のお手続きはこちら'); // 解約はテキストリンク
  });

  it('enabled:false / 契約 0 件 / cancelled のみ → カードごと非表示 (空 chrome を見せない)', async () => {
    for (const json of [
      { success: true, data: { enabled: false } },
      listJson({ contracts: [] }),
      listJson({}, { state: 'cancelled' }),
    ]) {
      const sb = loadSandbox(scriptOn);
      sb.respond.set('GET /api/liff/sub-contracts', { status: 200, json });
      await (sb.fn.loadSubContracts as unknown as () => Promise<void>)();
      expect(sb.byId.get('sub-contracts-card')!.style.display).toBe('none');
    }
  });

  it('subIntentEnabled:false → 実行できないボタンを出さない (§1)。相談導線のみ', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', { status: 200, json: listJson({ subIntentEnabled: false }) });
    await (sb.fn.loadSubContracts as unknown as () => Promise<void>)();
    const list = sb.byId.get('sub-contracts-list')!;
    expect(list.innerHTML).not.toContain('<button');
    expect(list.innerHTML).toContain('トークルーム');
  });

  it('open intent あり → 状況 +「取り消す」を必ず併記 (§1-3)。新規ボタンは出さない', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', {
      status: 200,
      json: listJson({}, {
        openIntents: [
          { id: 'si_1', op: 'skip', opLabel: '今回スキップ', state: 'received', promisedBy: '2026-09-02T12:00:00+09:00', requestedDate: null },
        ],
      }),
    });
    await (sb.fn.loadSubContracts as unknown as () => Promise<void>)();
    const html = sb.byId.get('sub-contracts-list')!.innerHTML;
    expect(html).toContain('「今回スキップ」のご依頼を承りました');
    expect(html).toContain('このご依頼を取り消す');
    expect(html).toContain('2026-09-02 12:00'); // §4-1 promised_by の開示
    expect(html).not.toContain('今回はスキップする'); // 二重依頼の温床を出さない
  });

  it('GET 失敗 (500) → 非表示のまま (他カードへ波及させない)', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', { status: 500, json: { success: false, error: 'boom' } });
    await (sb.fn.loadSubContracts as unknown as () => Promise<void>)();
    expect(sb.byId.get('sub-contracts-card')!.style.display).toBe('none');
  });
});

// ───────────────────────── 受理フロー ─────────────────────────

describe('受理 POST — cycleKey 同梱・§1/§2/§4-1', () => {
  async function loaded(json = listJson()) {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', { status: 200, json });
    await (sb.fn.loadSubContracts as unknown as () => Promise<void>)();
    return sb;
  }

  it('skip は 1 タップで POST。body に op と cycleKey が入り、accepted の message を表示 (§2)', async () => {
    const sb = await loaded();
    sb.respond.set('POST /api/liff/sub-contracts/gid', {
      status: 200,
      json: { success: true, data: { status: 'accepted', promisedBy: '2026-09-02T12:00:00+09:00', message: '承りました。' } },
    });
    await (sb.fn.scAct as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-op': 'skip', 'data-idx': '0' }));
    const post = sb.calls.find((c) => c.method === 'POST');
    expect(post).toBeTruthy();
    expect(post!.path).toContain('/api/liff/sub-contracts/');
    expect(post!.path).toContain('/intents');
    expect(post!.body).toMatchObject({ op: 'skip', cycleKey: CONTRACT.cycleKey });
    expect(sb.byId.get('sc-msg-0')!.innerHTML).toContain('承りました。');
    // 受理後に最新状態を引き直す (GET が 2 回目)
    expect(sb.calls.filter((c) => c.method === 'GET' && c.path.indexOf('/api/liff/sub-contracts') === 0).length).toBe(2);
  });

  it('date は 2 タップ (§2): 1 タップ目はパネルだけで POST しない → 確定で requestedDate を送る', async () => {
    const sb = await loaded();
    await (sb.fn.scAct as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-op': 'date', 'data-idx': '0' }));
    expect(sb.calls.filter((c) => c.method === 'POST').length, '1 タップ目で送信しない').toBe(0);
    expect(sb.byId.get('sc-panel-0')!.innerHTML).toContain('type="date"');
    sb.respond.set('POST /api/liff/sub-contracts/gid', {
      status: 200,
      json: { success: true, data: { status: 'accepted', message: '変更で承りました。' } },
    });
    sb.byId.get('sc-date-0')!.value = '2026-09-10';
    await (sb.fn.scSubmitDate as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-idx': '0' }));
    const post = sb.calls.find((c) => c.method === 'POST');
    expect(post!.body).toMatchObject({ op: 'date', requestedDate: '2026-09-10', cycleKey: CONTRACT.cycleKey });
  });

  it('date 未選択の確定は送信しない (画面内で促す)', async () => {
    const sb = await loaded();
    await (sb.fn.scSubmitDate as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-idx': '0' }));
    expect(sb.calls.filter((c) => c.method === 'POST').length).toBe(0);
    expect(sb.byId.get('sc-msg-0')!.innerHTML).toContain('お日にちをお選びください');
  });

  it('cancel は 2 タップ (§2): 確認パネル → 確定で POST', async () => {
    const sb = await loaded();
    await (sb.fn.scAct as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-op': 'cancel', 'data-idx': '0' }));
    expect(sb.calls.filter((c) => c.method === 'POST').length, '確認前に送信しない').toBe(0);
    expect(sb.byId.get('sc-panel-0')!.innerHTML).toContain('解約を依頼する');
    sb.respond.set('POST /api/liff/sub-contracts/gid', {
      status: 200,
      json: { success: true, data: { status: 'accepted', message: '解約のご依頼を承りました。' } },
    });
    await (sb.fn.scSubmitCancel as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-idx': '0' }));
    const post = sb.calls.find((c) => c.method === 'POST');
    expect(post!.body).toMatchObject({ op: 'cancel' });
  });

  it('late_promise (409) は受理と偽らず開示 → 「それでもお願いする」で ack:true 再送 (§4-1)', async () => {
    const sb = await loaded();
    sb.respond.set('POST /api/liff/sub-contracts/gid', {
      status: 409,
      json: { success: false, error: 'late_promise', disclosure: '対応が次回決済の後になる可能性があります。' },
    });
    await (sb.fn.scAct as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-op': 'skip', 'data-idx': '0' }));
    const panel = sb.byId.get('sc-panel-0')!;
    expect(panel.innerHTML).toContain('対応が次回決済の後になる可能性');
    expect(panel.innerHTML).toContain('それでもお願いする');
    // ack 再送
    sb.respond.set('POST /api/liff/sub-contracts/gid', {
      status: 200,
      json: { success: true, data: { status: 'accepted', message: '承りました。' } },
    });
    await (sb.fn.scAckResend as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-op': 'skip', 'data-idx': '0' }));
    const acked = sb.calls.filter((c) => c.method === 'POST').map((c) => c.body);
    expect(acked[0]).not.toMatchObject({ ack: true });
    expect(acked[1]).toMatchObject({ op: 'skip', ack: true });
  });

  it('cycle_changed (409) → 最新を引き直して選び直しを促す (古い画面のタップを作用させない §3-3)', async () => {
    const sb = await loaded();
    sb.respond.set('POST /api/liff/sub-contracts/gid', {
      status: 409,
      json: { success: false, error: 'cycle_changed', current: { cycleKey: 'x', presentableDate: '2026-09-06' } },
    });
    await (sb.fn.scAct as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-op': 'skip', 'data-idx': '0' }));
    expect(sb.byId.get('sc-msg-0')!.innerHTML).toContain('最新の情報に更新');
    expect(sb.calls.filter((c) => c.method === 'GET' && c.path.indexOf('/api/liff/sub-contracts') === 0).length).toBe(2);
  });

  it('deadline_passed 等はサーバの message をそのまま見せる (false-success を作らない)', async () => {
    const sb = await loaded();
    sb.respond.set('POST /api/liff/sub-contracts/gid', {
      status: 409,
      json: { success: false, error: 'deadline_passed', message: '受付期限を過ぎているため、承ることができませんでした。' },
    });
    await (sb.fn.scAct as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-op': 'skip', 'data-idx': '0' }));
    expect(sb.byId.get('sc-msg-0')!.innerHTML).toContain('承ることができませんでした');
  });
});

// ───────────────────────── onclick 配線 (採点ループ R1: scActTypo mutation が素通りした穴) ─────────────────────────

describe('onclick 配線 — 描画 HTML の handler 名が実在する関数を指す', () => {
  it('契約カード + 各パネルの onclick="fn(this)" は全て sandbox に定義済みの関数', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', {
      status: 200,
      json: listJson({}, {
        openIntents: [
          { id: 'si_1', op: 'skip', opLabel: '今回スキップ', state: 'received', promisedBy: null, requestedDate: null },
        ],
      }),
    });
    await (sb.fn.loadSubContracts as unknown as () => Promise<void>)();
    let html = sb.byId.get('sub-contracts-list')!.innerHTML;
    // アクションパネルも展開して handler を収集 (active 契約で再描画)
    sb.respond.set('GET /api/liff/sub-contracts', { status: 200, json: listJson() });
    await (sb.fn.loadSubContracts as unknown as () => Promise<void>)();
    html += sb.byId.get('sub-contracts-list')!.innerHTML;
    (sb.fn.scShowDatePanel as unknown as (i: string) => void)('0');
    html += sb.byId.get('sc-panel-0')!.innerHTML;
    (sb.fn.scShowCancelPanel as unknown as (i: string) => void)('0');
    html += sb.byId.get('sc-panel-0')!.innerHTML;
    const names = [...html.matchAll(/onclick="(\w+)\(this\)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of new Set(names)) {
      expect(typeof (sb.fn as Record<string, unknown>)[name], name + ' が未定義 (typo 配線)').toBe('function');
    }
  });

  it('undo ボタンの data-intent はサーバの intent id をそのまま運ぶ', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', {
      status: 200,
      json: listJson({}, {
        openIntents: [
          { id: 'si_1', op: 'skip', opLabel: '今回スキップ', state: 'received', promisedBy: null, requestedDate: null },
        ],
      }),
    });
    await (sb.fn.loadSubContracts as unknown as () => Promise<void>)();
    expect(sb.byId.get('sub-contracts-list')!.innerHTML).toContain('data-intent="si_1"');
  });
});

// ───────────────────────── 受理レイヤー閉鎖時の undo (採点ループ R1 confirmed) ─────────────────────────

describe('SUB_INTENT_ENABLED off — 必ず失敗するボタンを出さない (§1)', () => {
  it('subIntentEnabled:false × open intent あり → 取り消すボタンを出さず相談導線', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', {
      status: 200,
      json: listJson({ subIntentEnabled: false }, {
        openIntents: [
          { id: 'si_1', op: 'skip', opLabel: '今回スキップ', state: 'received', promisedBy: '2026-09-02T12:00:00+09:00', requestedDate: null },
        ],
      }),
    });
    await (sb.fn.loadSubContracts as unknown as () => Promise<void>)();
    const html = sb.byId.get('sub-contracts-list')!.innerHTML;
    expect(html).toContain('承りました'); // 状況表示は維持
    expect(html).not.toContain('scUndo'); // タップしても 409 gate_off にしかならないボタンを出さない
    expect(html).toContain('トークルーム');
  });

  it('undo が 409 gate_off を返したらサーバの message (マイページ誘導) を toast する', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', { status: 200, json: listJson() });
    sb.respond.set('POST /api/liff/sub-intents/si_1/undo', {
      status: 409,
      json: { success: false, error: 'gate_off', message: 'この機能は現在ご利用いただけません。お手続きはマイページをご利用ください。' },
    });
    await (sb.fn.scUndo as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-intent': 'si_1' }));
    expect(sb.toasts.join(' ')).toContain('マイページをご利用ください');
    expect(sb.toasts.join(' ')).not.toContain('時間をおいて'); // 絶対に成功しない操作への誤誘導をしない
  });
});

// ───────────────────────── 受理後の再取得失敗 (採点ループ R1 confirmed) ─────────────────────────

describe('accepted 後の GET 失敗 — 受理フィードバックを全損させない', () => {
  it('POST accepted → 再取得 500 → 「承りました」は toast へフォールバック', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', { status: 200, json: listJson() });
    await (sb.fn.loadSubContracts as unknown as () => Promise<void>)();
    sb.respond.set('POST /api/liff/sub-contracts/gid', {
      status: 200,
      json: { success: true, data: { status: 'accepted', message: '解約のご依頼を承りました。救済手順つき。' } },
    });
    sb.respond.set('GET /api/liff/sub-contracts', { status: 500, json: { success: false, error: 'boom' } });
    await (sb.fn.scAct as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-op': 'skip', 'data-idx': '0' }));
    expect(sb.byId.get('sub-contracts-card')!.style.display).toBe('none');
    expect(sb.toasts.join(' ')).toContain('解約のご依頼を承りました。救済手順つき。');
  });

  it('skip の結果日付が計算できない契約 (intervalDays 欠損) は日付を捏造せず fallback 文言', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', {
      status: 200,
      json: listJson({}, { intervalDays: null }),
    });
    await (sb.fn.loadSubContracts as unknown as () => Promise<void>)();
    const html = sb.byId.get('sub-contracts-list')!.innerHTML;
    expect(html).toContain('次回分をお休みするお申し込みになります');
    expect(html).not.toContain('押すと 次回は '); // 捏造した日付を出さない
  });
});

// ───────────────────────── 取り消し (§1-3) ─────────────────────────

describe('scUndo — 取り消し', () => {
  it('undo POST → 結果 toast + 最新状態の引き直し', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', { status: 200, json: listJson() });
    sb.respond.set('POST /api/liff/sub-intents/si_1/undo', {
      status: 200,
      json: { success: true, data: { status: 'cancelled', message: '取り消しました' } },
    });
    await (sb.fn.scUndo as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-intent': 'si_1' }));
    const post = sb.calls.find((c) => c.method === 'POST');
    expect(post!.path).toBe('/api/liff/sub-intents/si_1/undo');
    expect(sb.toasts.join(' ')).toContain('取り消しました');
    expect(sb.calls.some((c) => c.method === 'GET' && c.path.indexOf('/api/liff/sub-contracts') === 0)).toBe(true);
  });

  it('not_undoable は正直に伝える (取り消せたと偽らない)', async () => {
    const sb = loadSandbox(scriptOn);
    sb.respond.set('GET /api/liff/sub-contracts', { status: 200, json: listJson() });
    sb.respond.set('POST /api/liff/sub-intents/si_1/undo', {
      status: 409,
      json: { success: false, error: 'not_undoable', state: 'executing' },
    });
    await (sb.fn.scUndo as unknown as (b: unknown) => Promise<void>)(fakeBtn({ 'data-intent': 'si_1' }));
    expect(sb.toasts.join(' ')).toContain('取り消せません');
  });
});
