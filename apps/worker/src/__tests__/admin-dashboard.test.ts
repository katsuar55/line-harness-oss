/**
 * 管理ダッシュボード (/admin + GET /api/admin/dashboard) のテスト。
 *
 * 対象:
 *   - ページ shell: 200 + 主要マーカー + noindex (公開 shell に実データ・秘密なし)
 *   - 集約 API: 認証必須 (401) / 集約 shape / section 単位の resilience
 *     (1 テーブルの故障で 500 にせず null section + sectionErrors)
 *   - 機能フラグは boolean のみ (secret 値のエコーなし)
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { adminDashboard } from '../routes/admin-dashboard.js';
import { authMiddleware } from '../middleware/auth.js';

const API_KEY = 'test-key';

interface FakeOpts {
  failFriends?: boolean;
  friendCouponEnabled?: boolean;
  /** 既定 'NTOMO5'。空文字にすると codeSet=false の検証に使える */
  friendCouponCode?: string;
  unreadChats?: { unread: number; oldestAt: string | null };
  failingJobs?: Array<{ jobName: string; n: number; lastAt: string }>;
  subContracts?: { total: number; active: number; flowMeasured: number };
  lastFlowIngestAt?: string | null;
}

function fakeDb(opts: FakeOpts = {}) {
  return {
    prepare(sql: string) {
      // fake は SQL 文字列で分岐する = 実 SQL から述語が消えても fake が守り続けて
      // false green になる。核心述語の実在を fake 側で検証する (subscription テストと同じ流儀)
      const requirePredicates = (preds: string[]): void => {
        for (const p of preds) {
          if (!sql.includes(p)) throw new Error(`SQL から述語が消えている: ${p}`);
        }
      };
      const respond = () => {
        // authMiddleware の staff_members 照合 → 不在 (env API_KEY fallback 経路を使う)
        if (sql.includes('staff_members')) return null;
        if (sql.includes('FROM friends')) {
          if (opts.failFriends) throw new Error('friends query failed');
          return { total: 6600, following: 6570, blocked: 30, new7d: 42, linked: 15 };
        }
        if (sql.includes('FROM line_friend_coupons')) {
          return { issued: 120, redeemed: 18, issued7d: 9 };
        }
        if (sql.includes('FROM faq_items')) return { n: 21 };
        // faq unanswered (listUnansweredQuestions) — GROUP BY を含む集計クエリを先に判定
        if (sql.includes('conversation_logs') && sql.includes('GROUP BY')) {
          return [{ question: '返品できますか', count: 4 }];
        }
        if (sql.includes('FROM conversation_logs')) {
          // ngWords (薬機法 NG ブロック) は唯一の法務指標 — SUM 列が消えると client は
          // Number(undefined||0)=0 を表示し続け、誰も気付かず指標が消える
          requirePredicates(['ng_words_detected IS NOT NULL', "ai_layer = 'fallback'"]);
          return { total: 300, fallback: 12, ngWords: 3 };
        }
        if (sql.includes('brand_config')) {
          return {
            metadata: JSON.stringify({
              friendCoupon: {
                enabled: opts.friendCouponEnabled ?? false,
                percent: 5,
                code: opts.friendCouponCode ?? 'NTOMO5',
              },
            }),
          };
        }
        if (sql.includes('FROM chats')) {
          requirePredicates(["status = 'unread'"]);
          return opts.unreadChats ?? { unread: 0, oldestAt: null };
        }
        if (sql.includes('FROM subscription_contracts')) {
          requirePredicates([
            "estimate_source = 'flow'",
            'next_billing_estimate IS NOT NULL',
            'cancelled_at IS NULL AND paused_at IS NULL',
          ]);
          return opts.subContracts ?? { total: 370, active: 139, flowMeasured: 0 };
        }
        // cron_run_logs は 3 クエリ (最終稼働 / job 別失敗 / teiki-flow 最終受信) — SQL で分岐
        if (sql.includes('FROM cron_run_logs')) {
          if (sql.includes('GROUP BY job_name')) {
            requirePredicates(["status IN ('error', 'partial')"]);
            return opts.failingJobs ?? [];
          }
          if (sql.includes('teiki-flow-ingest')) {
            requirePredicates(["status = 'success'"]);
            return { lastAt: opts.lastFlowIngestAt ?? null };
          }
          return { lastCronAt: '2026-07-23T10:00:00.000' };
        }
        return null;
      };
      const exec = {
        async first() { return respond(); },
        async all() { const r = respond(); return { results: Array.isArray(r) ? r : r ? [r] : [] }; },
        async run() {
          if (sql.includes('UPDATE chats')) {
            // 一括確認済み化は unread のみを resolved へ (in_progress = 対応中の行を触らない)
            requirePredicates(["SET status = 'resolved'", "WHERE status = 'unread'"]);
            return { success: true, meta: { changes: opts.unreadChats?.unread ?? 0 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return { bind: () => exec, ...exec };
    },
  } as unknown as D1Database;
}

// 本番と同じ実 authMiddleware を全パスにマウントする (採点 R1 HIGH: fake middleware の
// 偽陰性で「/admin が skip-list 未登録 = 本番 401 全損」を素通しした教訓)。
// 認証は staff_members 不在 → env API_KEY fallback 経路。
function createApp() {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/', adminDashboard);
  return app;
}

const ENV = (db: D1Database, extra: Record<string, string> = {}) => ({
  DB: db,
  API_KEY,
  ...extra,
});

/**
 * shell の inline script から render() を取り出して**実行**する DOM スタブ。
 * 文字列 contains 検証では「分岐は残っているが unreachable」(dead code 化) を
 * 検出できない (mutation で実測) ため、意味の検証は実行ベースで行う。
 */
async function renderWith(data: Record<string, unknown>) {
  const app = createApp();
  const res = await app.request('http://localhost/admin', { method: 'GET' }, ENV(fakeDb()));
  const html = await res.text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const els: Record<string, { textContent: string; innerHTML: string; value: string }> = {};
  const getEl = (id: string) =>
    (els[id] ??= {
      textContent: '',
      innerHTML: '',
      value: '',
      classList: { remove() {}, add() {} },
      addEventListener() {},
      className: '',
    } as never);
  const doc = {
    getElementById: getEl,
    createElement: () => {
      const o = { _t: '' } as { _t: string; textContent: string; readonly innerHTML: string };
      Object.defineProperty(o, 'textContent', {
        set(v: unknown) { o._t = v == null ? '' : String(v); },
        get() { return o._t; },
      });
      Object.defineProperty(o, 'innerHTML', {
        get() { return o._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
      });
      return o;
    },
  };
  const storage = { getItem: () => '', setItem() {}, removeItem() {} };
  const fn = new Function('document', 'localStorage', 'window', 'fetch', `${script}; return render;`);
  const render = fn(doc, storage, { confirm: () => true }, () => new Promise(() => {})) as (
    d: Record<string, unknown>,
  ) => void;
  render(data);
  return els;
}

describe('GET /admin (ページ shell)', () => {
  it('実 authMiddleware 経由で 200 (認証ヘッダなし = ブラウザ直開き) — skip-list 登録の実配線検証', async () => {
    const app = createApp();
    const res = await app.request('http://localhost/admin', { method: 'GET' }, ENV(fakeDb()));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('naturism 管理ダッシュボード');
    expect(html).toContain('noindex');
    expect(html).toContain('/admin/faq');
    expect(html).toContain('/admin/friend-coupon');
    // 公開 shell に秘密情報 (実キー値) を埋め込まない ('Bearer ' + 変数 の連結はOK)
    expect(html).not.toMatch(/Bearer [A-Za-z0-9]/);
    // 未公開機能のロードマップ (機能名・案内NG 注記) は公開 shell に静的に埋め込まない
    // (API_KEY 保護のレスポンスからのみ描画)
    expect(html).not.toContain('紹介した人に500円');
    // ラベル文字列は実装と一致させること — 古い文言のまま残すと「もう存在しない文字列の
    // 不在」を確かめるだけのトートロジーになり、公開 shell への漏洩を検出できなくなる
    expect(html).not.toContain('決済 7日前リマインド');
  });

  it('POST /admin は skip されず 401 (GET 限定 skip — method 非依存穴を作らない)', async () => {
    const app = createApp();
    const res = await app.request('http://localhost/admin', { method: 'POST' }, ENV(fakeDb()));
    expect(res.status).toBe(401);
  });

  it('shell の inline script が構文的に valid (new Function で parse 可能)', async () => {
    const app = createApp();
    const res = await app.request('http://localhost/admin', { method: 'GET' }, ENV(fakeDb()));
    const html = await res.text();
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    expect(() => new Function(m![1]!)).not.toThrow();
  });
});

describe('GET /api/admin/dashboard', () => {
  it('認証なしは 401 (実 authMiddleware — /api/admin/dashboard は skip されない)', async () => {
    const app = createApp();
    const res = await app.request('http://localhost/api/admin/dashboard', { method: 'GET' }, ENV(fakeDb()));
    expect(res.status).toBe(401);
  });

  it('集約 shape を返す (friends/welcomeCoupons/faq/ai7d/system/features)', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/admin/dashboard',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      ENV(fakeDb(), { RANK_DISCOUNT_ENABLED: 'true' }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: Record<string, any>;
    };
    expect(json.success).toBe(true);
    expect(json.data.friends.following).toBe(6570);
    expect(json.data.friends.new7d).toBe(42);
    expect(json.data.welcomeCoupons.issued).toBe(120);
    expect(json.data.faq.activeCount).toBe(21);
    expect(json.data.ai7d.fallback).toBe(12);
    expect(json.data.system.lastCronAt).toBeTruthy();
    // features はラベル込みの行配列 (公開 shell に埋め込まない設計)
    const features = json.data.features as Array<{ label: string; on: boolean; offText: string }>;
    expect(features.find((f) => f.label.includes('ランク'))?.on).toBe(true);
    expect(features.find((f) => f.label.includes('紹介した人に500円'))?.on).toBe(false);
    expect(features.find((f) => f.label.includes('紹介した人に500円'))?.offText).toContain('案内NG');
  });

  it('friendCoupon ON のとき data.friendCoupon.enabled=true と unansweredTop の shape を返す', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/admin/dashboard',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      ENV(fakeDb({ friendCouponEnabled: true })),
    );
    const json = (await res.json()) as { data: Record<string, any> };
    expect(json.data.friendCoupon.enabled).toBe(true);
    expect(json.data.friendCoupon.percent).toBe(5);
    expect(json.data.faq.unansweredTop[0]).toEqual({ question: '返品できますか', count: 4 });
  });

  it('chats section: 未読件数と最古の受信時刻を返す (人間対応キューの可視化)', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/admin/dashboard',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      ENV(fakeDb({ unreadChats: { unread: 6, oldestAt: '2026-07-14T03:00:00.000' } })),
    );
    const json = (await res.json()) as { data: Record<string, any> };
    expect(json.data.chats).toEqual({ unread: 6, oldestAt: '2026-07-14T03:00:00.000' });
  });

  it('ai7d に薬機法 NG ブロック件数 (ngWords) が入る — fallback だけでは実態より良く見える', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/admin/dashboard',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      ENV(fakeDb()),
    );
    const json = (await res.json()) as { data: Record<string, any> };
    expect(json.data.ai7d.ngWords).toBe(3);
  });

  it('🚨friendCoupon: enabled でも code 未設定なら codeSet=false (顧客側は非表示 — 「表示中」の嘘を防ぐ)', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/admin/dashboard',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      ENV(fakeDb({ friendCouponEnabled: true, friendCouponCode: '' })),
    );
    const json = (await res.json()) as { data: Record<string, any> };
    expect(json.data.friendCoupon.enabled).toBe(true);
    expect(json.data.friendCoupon.codeSet).toBe(false);
  });

  it('system.failingJobs: 直近24hの error/partial を job 別に返す (MAX(ran_at) は生存しか見えない)', async () => {
    const app = createApp();
    const failing = [{ jobName: 'teiki-flow-ingest', n: 4, lastAt: '2026-08-03T09:00:00.000' }];
    const res = await app.request(
      'http://localhost/api/admin/dashboard',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      ENV(fakeDb({ failingJobs: failing })),
    );
    const json = (await res.json()) as { data: Record<string, any> };
    expect(json.data.system.lastCronAt).toBeTruthy();
    expect(json.data.system.failingJobs).toEqual(failing);
  });

  it('subscriptionIngest: 契約実数と Flow 実測件数・最終受信を返す (gate の値だけの表示は 401 全滅でも緑になる)', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/admin/dashboard',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      ENV(
        fakeDb({
          subContracts: { total: 370, active: 139, flowMeasured: 2 },
          lastFlowIngestAt: '2026-08-03T08:00:00.000',
        }),
      ),
    );
    const json = (await res.json()) as { data: Record<string, any> };
    expect(json.data.subscriptionIngest).toEqual({
      total: 370,
      active: 139,
      flowMeasured: 2,
      lastMeasuredAt: '2026-08-03T08:00:00.000',
    });
    // features の収集行が実測併記の dynamic を持つ (client が sub section を参照して描画)
    const features = json.data.features as Array<{ label: string; dynamic?: string }>;
    expect(features.find((f) => f.label.includes('定期便データの収集'))?.dynamic).toBe('subscriptionIngest');
  });

  it('よく使う画面: 定期便マイページは /account (旧 /apps/subscription は本番 400 の死にリンク)', async () => {
    const app = createApp();
    const res = await app.request('http://localhost/admin', { method: 'GET' }, ENV(fakeDb()));
    const html = await res.text();
    expect(html).toContain('href="https://naturism-diet.com/account"');
    expect(html).not.toContain('href="https://naturism-diet.com/apps/subscription"');
  });

  it('🚨POST /api/admin/chats/mark-resolved: 認証必須・unread のみを resolved 化し件数を返す', async () => {
    // これが無いと「LINE公式マネージャーで返信しても D1 の unread が減らない」= 警告が
    // 永久残留して狼少年化する (採点で確定した HIGH)。確認フローの終点として必須
    const app = createApp();
    const noAuth = await app.request(
      'http://localhost/api/admin/chats/mark-resolved',
      { method: 'POST' },
      ENV(fakeDb()),
    );
    expect(noAuth.status).toBe(401);

    const res = await app.request(
      'http://localhost/api/admin/chats/mark-resolved',
      { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}` } },
      ENV(fakeDb({ unreadChats: { unread: 6, oldestAt: '2026-07-14T03:00:00.000' } })),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { resolved: number } };
    expect(json.success).toBe(true);
    expect(json.data.resolved).toBe(6);
  });

  it('shell に resolveChats (確認済み化ボタンの named function) と mark-resolved 呼び出しがある', async () => {
    const app = createApp();
    const res = await app.request('http://localhost/admin', { method: 'GET' }, ENV(fakeDb()));
    const html = await res.text();
    expect(html).toContain('function resolveChats');
    expect(html).toContain('/api/admin/chats/mark-resolved');
    // ラベルは実体 (スタッフ未確認・AI 応答分も含む) に一致させる — 「未対応」「AI が
    // 対応しきれなかった分」は実定義 (webhook が AI 応答前に全自発メッセージへ立てる) と乖離する
    expect(html).toContain('スタッフ未確認のメッセージ');
    expect(html).toContain('AI の自動応答分も含みます');
    // 「取得できませんでした」pill は markFailed / friendCoupon / subscriptionIngest の
    // 3 箇所 — subscriptionIngest の分岐が消えると section 失敗時に gate だけの緑へ
    // 無言で戻る (401 全滅でも緑、という作った理由そのものの復活) ため個数で固定する
    expect((html.match(/取得できませんでした/g) || []).length).toBeGreaterThanOrEqual(3);
    // 一括変更なので必ず confirm を挟む (誤タップでキューを空にしない)
    const fnBody = html.slice(html.indexOf('function resolveChats'));
    expect(fnBody.indexOf('window.confirm')).toBeGreaterThan(-1);
    expect(fnBody.indexOf('window.confirm')).toBeLessThan(fnBody.indexOf("method: 'POST'"));
  });

  it('🚨render 実行: subscriptionIngest 取得失敗時は「取得できませんでした」pill (gate だけの緑に戻さない)', async () => {
    // section 失敗で実測 detail が消えて gate の緑だけ残ると、「401 全滅でも緑」という
    // この行を作った理由そのものが復活する。実行ベースで unreachable 化も検出する
    const els = await renderWith({
      features: [
        { label: '(準備) 定期便データの収集', on: true, offText: '停止中 — 顧客影響なし', dynamic: 'subscriptionIngest' },
      ],
      // subscriptionIngest: undefined = section 取得失敗
    });
    expect(els['features']!.innerHTML).toContain('取得できませんでした');
    expect(els['features']!.innerHTML).not.toContain('稼働中');
  });

  it('render 実行: subscriptionIngest があれば実測 detail (契約/実測/最終受信) を併記', async () => {
    const els = await renderWith({
      features: [
        { label: '(準備) 定期便データの収集', on: true, offText: '', dynamic: 'subscriptionIngest' },
      ],
      subscriptionIngest: { total: 370, active: 139, flowMeasured: 0, lastMeasuredAt: null },
    });
    const fhtml = els['features']!.innerHTML;
    expect(fhtml).toContain('稼働中');
    expect(fhtml).toContain('契約 139 件');
    expect(fhtml).toContain('実測日付あり 0 件');
    expect(fhtml).toContain('まだなし');
  });

  it('render 実行: 実測>0 なのに最終受信が無いときは「まだなし」と言わない (retention 切れは受信ゼロの証拠ではない)', async () => {
    const els = await renderWith({
      features: [
        { label: '(準備) 定期便データの収集', on: true, offText: '', dynamic: 'subscriptionIngest' },
      ],
      subscriptionIngest: { total: 370, active: 139, flowMeasured: 5, lastMeasuredAt: null },
    });
    expect(els['features']!.innerHTML).toContain('30日以上前');
    expect(els['features']!.innerHTML).not.toContain('まだなし');
  });

  it('render 実行: 未確認 >0 で warn todo (確認ボタン付き)・0 件なら 🎉 到達可能', async () => {
    const withUnread = await renderWith({
      chats: { unread: 6, oldestAt: null },
      faq: { activeCount: 1, unansweredTop: [] },
      friendCoupon: { enabled: false, codeSet: false },
    });
    expect(withUnread['todos']!.innerHTML).toContain('スタッフ未確認のお客様メッセージ');
    expect(withUnread['todos']!.innerHTML).toContain('resolveChats()');
    // 全確認済みなら「今やるべきことはありません」に到達できる (永久残留しない)
    const clean = await renderWith({
      chats: { unread: 0, oldestAt: null },
      faq: { activeCount: 1, unansweredTop: [] },
      friendCoupon: { enabled: false, codeSet: false },
    });
    expect(clean['todos']!.innerHTML).not.toContain('スタッフ未確認');
    expect(clean['v-chats']!.textContent).toBe('0');
    expect(clean['s-chats']!.textContent).toContain('すべて確認済み');
  });

  it('render 実行: friendCoupon ON+コード未設定は「表示中」と言わず警告 todo を出す', async () => {
    const els = await renderWith({
      chats: { unread: 0, oldestAt: null },
      faq: { activeCount: 1, unansweredTop: [] },
      friendCoupon: { enabled: true, percent: 5, codeSet: false },
      features: [{ label: '友だち限定クーポン', on: false, offText: '', dynamic: 'friendCoupon' }],
    });
    expect(els['features']!.innerHTML).toContain('コード未設定 — お客様には非表示');
    expect(els['features']!.innerHTML).not.toContain('表示中');
    expect(els['todos']!.innerHTML).toContain('お客様には表示されていません');
  });

  it('1 section の D1 故障は 500 にせず null + sectionErrors (部分表示 > 全損)', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/admin/dashboard',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      ENV(fakeDb({ failFriends: true })),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, any> };
    expect(json.data.friends).toBeNull();
    expect(json.data.welcomeCoupons.issued).toBe(120);
    expect(json.data.sectionErrors.friends).toContain('friends query failed');
  });
});
