/**
 * クーポンの「顧客に見えている文言」と「実スキーマ」の恒久ガード (2026-08-24)
 *
 * 背景:
 *   PR-C (#255, 2026-08-14) が welcome を ¥500 → ¥300 に下げたとき、顧客向け文言を 1 つも
 *   追随させなかった。友だち追加の挨拶・招待文・紹介カード・月次 Flex・管理画面がそろって
 *   「500 円 OFF」と言い続け、実額だけが ¥300 になっていた (景表法の有利誤認)。
 *   さらに **全券に付いている最低購入 ¥2,000 が、顧客が読むどの面にも書かれていなかった**。
 *
 * 🚨 測定器としての設計 (採点ループ 2026-08-24 の指摘を反映):
 *   初版は `html.indexOf(...)` の近傍に '¥2,000' があるかを見ていたが、**emitted HTML には
 *   サーバ側の `//` コメントもそのまま乗る**ため、顧客可視の行を消してもコメントがヒットして
 *   緑のままだった (変異 (c) SURVIVED)。以降、顧客可視の面は**描画される文字列そのものを
 *   逐語で照合する** (コメントでは一致し得ない形)。
 *   同様に「額」は定数と結び、`WELCOME_DISCOUNT_VALUE_JPY` を変えたら文言テストが落ちるようにする。
 *
 * 本ファイルが守るもの:
 *   ① 顧客が読む面に「¥2,000」が出ること (LIFF / トーク Flex / 紹介 intent / 紹介 LP /
 *      月次 Flex / 紹介者 push / AI の fact block / 管理画面ラベル)
 *   ② 約束している額 === 実際に発行する額 (定数と文言の対)
 *   ③ 割引額は**台帳の値**が正で、その配線が caller まで生きていること
 *   ④ 実装と食い違う旧文言 (3 日間有効 / ¥696 → 実質 ¥196 / OSS デモ LP) が復活しないこと
 *   ⑤ 格上げ機構が復活しないこと
 *   ⑥ gate off の間、「紹介した側にも ¥500」を約束しないこと
 *   ⑦ 🚨 /api/line-friend-coupons が **実スキーマ** で動くこと (一覧 + stats)
 *
 * ⑦ が最重要。本番では全リクエストが 500 を返していた (2026-08-24 実測) — 原因は存在しない列
 * `c.created_at` を SELECT していたこと。既存 route テスト (line-friend-coupons-route.test.ts) は
 * D1 を手 mock し created_at を含む架空行を返すため、**列の不在が原理的に現れない**。
 * ここでは packages/db/schema.sql を実 SQLite に流して実 SQL を走らせる = 列名の誤りが必ず落ちる。
 *
 * ⚠️ 本ファイルでは vi.mock を使わない (worker default export の dynamic import と併用すると
 *    CLAUDE.md「テストコーディングルール」の干渉トラップに触れるため)。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

import { createSchemaDb, asD1, insertFriend } from './helpers/sqlite-d1.js';
import { lineFriendCoupons } from '../routes/line-friend-coupons.js';
import { liffPages } from '../routes/liff-pages.js';
import { buildMyCouponFlex } from '../services/welcome-postback.js';
import { buildMessagesForIntentAsync, type Intent } from '../services/intent-router.js';
import { buildReferrerRewardMessage, buildReferrerQueuedMessage } from '../services/referral-reward.js';
import { getFriendCouponContext } from '../services/ai-fact-context.js';
import {
  MIN_SUBTOTAL_JPY,
  WELCOME_VALID_DAYS,
  WELCOME_DISCOUNT_VALUE_JPY,
} from '../services/shopify-coupon-issuer.js';
import { redeemCouponByCode } from '@line-crm/db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_ENV = {
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
  WORKER_URL: 'https://example.workers.dev',
  API_KEY: 'test-api-key',
};

/** 顧客向けの条件表記。全券共通の最低購入額と一致していること自体もここで固定する。 */
const MIN_LABEL = '¥2,000';

function srcOf(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
}

async function portalHtml(env: Record<string, unknown> = BASE_ENV): Promise<string> {
  const res = await liffPages.request('/liff/portal', {}, env);
  expect(res.status).toBe(200);
  return res.text();
}

async function referralLandingHtml(): Promise<string> {
  const worker = (await import('../index.js')).default as {
    fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response>;
  };
  const res = await worker.fetch(
    new Request('https://example.workers.dev/r/ref-abcd1234'),
    BASE_ENV,
    { waitUntil: () => undefined, passThroughOnException: () => undefined },
  );
  expect(res.status).toBe(200);
  return res.text();
}

/** welcome クーポンを 1 枚だけ持つ実 SQLite を作る */
function dbWithWelcome(discountValue: number) {
  const raw = createSchemaDb();
  insertFriend(raw, 'F1');
  raw
    .prepare(
      `INSERT INTO line_friend_coupons
         (id, friend_id, coupon_code, discount_value, discount_currency, issued_at, expires_at, status, source)
       VALUES (?, ?, ?, ?, 'JPY', ?, ?, 'issued', 'shopify')`,
    )
    .run(
      'c1',
      'F1',
      'LINE-ABCD2345',
      discountValue,
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 5 * 86_400_000).toISOString(),
    );
  return raw;
}

// ============================================================
// ① 顧客が読む面に利用条件 (¥2,000) が出ている
// ============================================================

describe('利用条件 ¥2,000 が顧客向けの面に明記されている', () => {
  it('定数と表示ラベルが一致している (定数だけ動かして文言が置き去りになるのを防ぐ)', () => {
    expect(MIN_SUBTOTAL_JPY).toBe(2000);
    expect(MIN_LABEL).toBe(`¥${MIN_SUBTOTAL_JPY.toLocaleString('en-US')}`);
  });

  // 🚨 emitted HTML にはサーバ側の // コメントも乗る。**描画される文字列そのもの**を逐語で照合し、
  //    コメントでは一致し得ない形にする (初版はコメントを拾って緑になっていた)。
  it('ポータル: welcome クーポンカードの説明文に条件が入っている', async () => {
    const html = await portalHtml();
    expect(html).toContain(
      "'<p class=\"text-xs text-gray-500 mb-2\">友だち追加のお礼です。<b>¥2,000 以上のご注文</b>でお使いいただけます (定期便の初回にも)。</p>' +",
    );
  });

  it('ポータル: 連携特典カードの説明文に条件が入っている', async () => {
    const html = await portalHtml();
    expect(html).toContain(
      "'<p class=\"coupon-note mt-1 mb-3\">アカウント連携のお礼です。<b>¥2,000 以上のご注文</b>でお使いいただけます。</p>' +",
    );
  });

  it('ポータル: 紹介特典カードの説明文に条件が入っている', async () => {
    const html = await portalHtml();
    expect(html).toContain(
      '<b>¥2,000 以上のご注文</b>でお使いいただけます(紹介クーポンは1回のご注文に1枚)。',
    );
  });

  it('ポータル: 紹介ヒーローの可視行に条件が入っている (gate の ON/OFF どちらでも)', async () => {
    const LINE = "'<p class=\"text-xs text-gray-500 mt-1\">¥2,000 以上のご注文でお使いいただけます</p>' +";
    for (const gate of [undefined, 'true']) {
      const html = await portalHtml({ ...BASE_ENV, REFERRAL_REWARD_ENABLED: gate });
      expect(html, `gate=${String(gate)}`).toContain(LINE);
    }
  });

  it('ポータル: LINE で送る招待文に条件が載る (gate の ON/OFF どちらの分岐にも)', async () => {
    const html = await portalHtml({ ...BASE_ENV, REFERRAL_REWARD_ENABLED: 'true' });
    const i = html.indexOf('function shareRefLine()');
    expect(i).toBeGreaterThan(-1);
    const body = html.slice(i, i + 1200);
    // 分岐は 2 本。両方に条件が要る (片方だけ消しても落ちるようにする)
    const occurrences = body.split('(¥2,000以上のご注文で使えます)').length - 1;
    expect(occurrences, '招待文 2 分岐の両方に条件が要る').toBe(2);
  });

  it('トーク「マイクーポン」Flex に条件が載る', () => {
    const flex = JSON.stringify(buildMyCouponFlex('LINE-ABCD2345', 500));
    expect(flex).toContain(MIN_LABEL);
  });

  it('トークの紹介 intent 応答に条件が載る (gate の ON/OFF どちらでも)', async () => {
    const intent: Intent = { type: 'referral', reason: 'test' };
    for (const on of [false, true]) {
      const msgs = await buildMessagesForIntentAsync(intent, {
        db: null as unknown as D1Database,
        friendId: 'F1',
        liffUrl: BASE_ENV.LIFF_URL,
        referralRewardOn: on,
      });
      const text = JSON.stringify(msgs);
      expect(text, `gate=${on}`).toContain('友だち紹介');
      expect(text, `gate=${on}`).toContain('2,000');
    }
  });

  it('紹介リンクの着地ページ /r/:ref に条件が載る', async () => {
    const html = await referralLandingHtml();
    expect(html).toContain(MIN_LABEL);
    // 紹介リンクなので LIFF への導線が生きていること
    expect(html).toContain('ref-abcd1234');
  });

  it('紹介者への報酬 push に条件が載る (発行時 / 待機時の両方)', () => {
    const issued = JSON.stringify(
      buildReferrerRewardMessage('NREF-R-ABCD2345', '2026-09-01T00:00:00.000Z', BASE_ENV.LIFF_URL),
    );
    expect(issued).toContain('2,000');
    const queued = JSON.stringify(buildReferrerQueuedMessage(2, BASE_ENV.LIFF_URL));
    expect(queued).toContain('2,000');
  });

  it('AI が引用する fact block に条件が載る (ルール文だけだと転記から落ちる)', async () => {
    const raw = dbWithWelcome(WELCOME_DISCOUNT_VALUE_JPY);
    const ctx = await getFriendCouponContext(asD1(raw), 'F1');
    expect(ctx).toContain('あなた専用クーポン');
    expect(ctx).toContain(MIN_LABEL);
  });

  it('AI の system prompt にクーポンの利用条件ルールがある', () => {
    const src = srcOf('../services/ai-response.ts');
    expect(src).toContain('¥2,000 以上のご注文');
  });

  it('月次ブロードキャストの紹介 Flex に条件が載る', () => {
    const src = srcOf('../services/monthly-broadcast-postback.ts');
    const hits = src.split('¥2,000 以上のご注文').length - 1;
    expect(hits, '6 月 / 8 月の紹介 Flex に条件が要る').toBeGreaterThanOrEqual(2);
  });

  it('管理ダッシュボードの機能ラベルにも条件が載る (スタッフの案内原本になる)', () => {
    const src = srcOf('../routes/admin-dashboard.ts');
    const hits = src.split('¥2,000以上のご注文').length - 1;
    expect(hits, 'welcome / 紹介 / 連携の 3 ラベル').toBeGreaterThanOrEqual(3);
  });
});

// ============================================================
// ② 約束している額 === 実際に発行する額
// ============================================================

describe('顧客に約束する額と発行する額が同じ定数から来ている', () => {
  it('紹介 LP の大きな数字は発行側の定数と一致する', async () => {
    const html = await referralLandingHtml();
    expect(html).toContain(`¥${WELCOME_DISCOUNT_VALUE_JPY}<small>OFF クーポン</small>`);
  });

  it('ポータルの紹介ヒーローが約束する額も同じ定数', async () => {
    const html = await portalHtml();
    expect(html).toContain(`<span class="ref-500">¥${WELCOME_DISCOUNT_VALUE_JPY}</span>`);
  });

  it('LINE 招待文が約束する額も同じ定数 (2 分岐とも)', async () => {
    const html = await portalHtml({ ...BASE_ENV, REFERRAL_REWARD_ENABLED: 'true' });
    const i = html.indexOf('function shareRefLine()');
    const body = html.slice(i, i + 1200);
    const hits = body.split(`${WELCOME_DISCOUNT_VALUE_JPY}円`).length - 1;
    expect(hits, '招待文の 2 分岐が約束する額').toBeGreaterThanOrEqual(3);
  });

  it('トークの紹介 intent が約束する額も同じ定数', async () => {
    const intent: Intent = { type: 'referral', reason: 'test' };
    for (const on of [false, true]) {
      const msgs = await buildMessagesForIntentAsync(intent, {
        db: null as unknown as D1Database,
        friendId: 'F1',
        liffUrl: BASE_ENV.LIFF_URL,
        referralRewardOn: on,
      });
      expect(JSON.stringify(msgs), `gate=${on}`).toContain(`${WELCOME_DISCOUNT_VALUE_JPY} 円 OFF`);
    }
  });
});

// ============================================================
// ③ 割引額は台帳の値が正 — その配線が caller まで生きている
// ============================================================

describe('割引額は台帳の値が正 (定数を書くと既発行の ¥300 券に嘘をつく)', () => {
  it('マイクーポン Flex は渡された額をそのまま描く', () => {
    const at300 = JSON.stringify(buildMyCouponFlex('LINE-ABCD2345', 300));
    expect(at300).toContain('300 円 OFF');
    expect(at300).not.toContain('500 円 OFF');

    const at500 = JSON.stringify(buildMyCouponFlex('LINE-ABCD2345', 500));
    expect(at500).toContain('500 円 OFF');
  });

  it('額が取れないときは既定額で埋めず条件だけ伝える', () => {
    for (const bad of [null, undefined, 0, Number.NaN]) {
      const flex = JSON.stringify(buildMyCouponFlex('LINE-ABCD2345', bad as number | null));
      expect(flex, `value=${String(bad)}`).toContain(MIN_LABEL);
      expect(flex, `value=${String(bad)}`).not.toMatch(/\d+ 円 OFF/);
    }
  });

  it('🚨 配線: トークの my_coupon intent は台帳の ¥300 を ¥300 のまま出す', async () => {
    // 額を渡し忘れる変異 (buildMyCouponFlex(code) に戻す) をここで殺す
    const raw = dbWithWelcome(300);
    const msgs = await buildMessagesForIntentAsync(
      { type: 'my_coupon', reason: 'test' },
      { db: asD1(raw), friendId: 'F1' },
    );
    const text = JSON.stringify(msgs);
    expect(text).toContain('300 円 OFF');
    expect(text).not.toContain('500 円 OFF');
  });

  it('🚨 配線: 台帳が ¥500 なら ¥500 が出る (同じ経路で値が素通しであること)', async () => {
    const raw = dbWithWelcome(500);
    const msgs = await buildMessagesForIntentAsync(
      { type: 'my_coupon', reason: 'test' },
      { db: asD1(raw), friendId: 'F1' },
    );
    expect(JSON.stringify(msgs)).toContain('500 円 OFF');
  });

  it('🚨 配線: 誕生月フローの「マイクーポン」も台帳の額を渡している', () => {
    // welcome-postback.ts の SELECT と受け渡しが両方生きていること
    const src = srcOf('../services/welcome-postback.ts');
    expect(src).toContain('SELECT coupon_code, discount_value FROM line_friend_coupons');
    expect(src).toContain('buildMyCouponFlex(couponCode, couponValue)');
  });
});

// ============================================================
// ④ 実装と食い違う旧文言が復活しない
// ============================================================

describe('実装と食い違う旧文言が復活しない', () => {
  it('マイクーポン Flex: 期限は発行側の定数と同じ日数', () => {
    expect(WELCOME_VALID_DAYS).toBe(7);
    const flex = JSON.stringify(buildMyCouponFlex('LINE-ABCD2345', 500));
    expect(flex).toContain(`${WELCOME_VALID_DAYS} 日間有効`);
    expect(flex).not.toContain('3 日間有効');
  });

  it('follow ハンドラは日数を直書きせず定数を渡す', () => {
    expect(srcOf('../routes/webhook.ts')).toContain('validDays: WELCOME_VALID_DAYS');
  });

  it('マイクーポン Flex: 最低購入 ¥2,000 に反する金額例 (¥696 → 実質 ¥196) を出さない', () => {
    const flex = JSON.stringify(buildMyCouponFlex('LINE-ABCD2345', 500));
    expect(flex).not.toContain('¥696');
    expect(flex).not.toContain('¥196');
  });

  it('/r/:ref は naturism の紹介ページであって OSS デモ LP ではない', async () => {
    const html = await referralLandingHtml();
    expect(html).not.toContain('無料代替 OSS');
    expect(html).not.toContain('ステップ配信');
    expect(html).toContain('お友だちからのご招待');
  });

  it('月次ブロードキャストの Flex に開発用語 (Phase N で実装予定) が残っていない', () => {
    expect(srcOf('../services/monthly-broadcast-postback.ts')).not.toMatch(/Phase \d+ で実装予定/);
  });
});

// ============================================================
// ⑤ 格上げ機構が復活しない
// ============================================================

describe('welcome 格上げ機構は削除済み', () => {
  it('services/welcome-upgrade.ts が存在しない', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../services/welcome-upgrade.ts'))).toBe(false);
  });

  it('紹介 claim 経路が格上げを呼ばない', () => {
    expect(srcOf('../routes/liff-portal.ts')).not.toMatch(/upgradeWelcomeCouponForReferred\s*\(/);
  });

  it('redemption 照合は coupon_code のみ — metadata.upgrade.oldCode では一致しない', async () => {
    const raw = createSchemaDb();
    insertFriend(raw, 'F1');
    raw
      .prepare(
        `INSERT INTO line_friend_coupons
           (id, friend_id, coupon_code, discount_value, discount_currency, issued_at, status, source, metadata)
         VALUES (?, ?, ?, 500, 'JPY', '2026-08-01T00:00:00.000Z', 'issued', 'shopify', ?)`,
      )
      .run('c1', 'F1', 'LINE-NEW22222', JSON.stringify({ upgrade: { oldCode: 'LINE-OLD11111' } }));

    const db = asD1(raw);
    const viaOld = await redeemCouponByCode(db, 'friend', 'LINE-OLD11111', '2026-08-02T00:00:00.000Z');
    expect(viaOld.matched, '旧コード照合は削除済みなので一致しない').toBe(false);

    const viaCurrent = await redeemCouponByCode(db, 'friend', 'LINE-NEW22222', '2026-08-02T00:00:00.000Z');
    expect(viaCurrent.matched).toBe(true);
    expect(viaCurrent.redeemed).toBe(true);
  });
});

// ============================================================
// ⑥ gate off の間は「紹介した側にも ¥500」を約束しない
// ============================================================

describe('紹介した側への特典は gate off の間 約束しない', () => {
  it('トークの紹介 intent: gate off では「お互いに」と言わない', async () => {
    const intent: Intent = { type: 'referral', reason: 'test' };
    const off = await buildMessagesForIntentAsync(intent, {
      db: null as unknown as D1Database,
      friendId: 'F1',
      liffUrl: BASE_ENV.LIFF_URL,
      referralRewardOn: false,
    });
    expect(JSON.stringify(off)).not.toContain('お互いに');

    const on = await buildMessagesForIntentAsync(intent, {
      db: null as unknown as D1Database,
      friendId: 'F1',
      liffUrl: BASE_ENV.LIFF_URL,
      referralRewardOn: true,
    });
    expect(JSON.stringify(on)).toContain('お互いに');
  });

  it('gate 未指定 (= 既定) でも「お互いに」と言わない (安全側に倒す)', async () => {
    const msgs = await buildMessagesForIntentAsync(
      { type: 'referral', reason: 'test' },
      { db: null as unknown as D1Database, friendId: 'F1', liffUrl: BASE_ENV.LIFF_URL },
    );
    expect(JSON.stringify(msgs)).not.toContain('お互いに');
  });

  it('webhook は intent に gate を渡している (配線が消えたら落ちる)', () => {
    expect(srcOf('../routes/webhook.ts')).toContain(
      "referralRewardOn: env?.REFERRAL_REWARD_ENABLED === 'true'",
    );
  });

  it('AI の system prompt は「紹介した側にも特典」と言わないよう明示している', () => {
    const src = srcOf('../services/ai-response.ts');
    expect(src).toContain('「紹介した側にも特典がある」とは絶対に言わない');
  });

  it('月次 Flex は紹介した側への額を約束しない', () => {
    const src = srcOf('../services/monthly-broadcast-postback.ts');
    expect(src).not.toContain('あなた → 次回購入で 500 円 OFF');
    expect(src).not.toContain('あなた + お友だち 両方');
  });

  it('welcome 未発行の救済は gate の内側 (実費を gate 外に出さない)', () => {
    const src = srcOf('../routes/liff-portal.ts');
    expect(src).toContain("const referralRewardOn = c.env.REFERRAL_REWARD_ENABLED === 'true';");
    expect(src).toContain('if (referralRewardOn) {');
  });
});

// ============================================================
// ⑦ /api/line-friend-coupons が実スキーマで動く (本番 500 の恒久ガード)
// ============================================================

describe('GET /api/line-friend-coupons — 実スキーマで実 SQL を走らせる', () => {
  function appWithAuth() {
    const app = new Hono();
    app.use('/api/*', async (c, next) => {
      const auth = c.req.header('Authorization');
      if (auth !== `Bearer ${BASE_ENV.API_KEY}`) return c.json({ error: 'Unauthorized' }, 401);
      return next();
    });
    app.route('/', lineFriendCoupons);
    return app;
  }

  function req(app: ReturnType<typeof appWithAuth>, url: string, raw: ReturnType<typeof createSchemaDb>) {
    return app.request(url, { headers: { Authorization: `Bearer ${BASE_ENV.API_KEY}` } }, { DB: asD1(raw) });
  }

  it('一覧が 200 で返る (存在しない列を SELECT したら実 SQLite が落ちる)', async () => {
    const raw = dbWithWelcome(500);
    const res = await req(appWithAuth(), 'http://localhost/api/line-friend-coupons', raw);
    expect(res.status, '本番ではここが 500 だった (c.created_at)').toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { coupons: Array<{ id: string; discount_value: number }>; total: number };
    };
    expect(json.success).toBe(true);
    expect(json.data.total).toBe(1);
    expect(json.data.coupons[0].id).toBe('c1');
    expect(json.data.coupons[0].discount_value).toBe(500);
  });

  it('stats も実スキーマで通る (一覧だけ直して stats が mock 依存のままにしない)', async () => {
    const raw = dbWithWelcome(500);
    const res = await req(appWithAuth(), 'http://localhost/api/line-friend-coupons/stats', raw);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { issued: number } };
    expect(json.success).toBe(true);
    expect(json.data.issued).toBe(1);
  });

  it('status / source フィルタは DB の CHECK 制約と同じ語彙で動く', async () => {
    const raw = dbWithWelcome(500);
    const app = appWithAuth();
    // schema.sql の CHECK: status IN (issued, redeemed, expired, revoked) / source IN (shopify, static_fallback)
    for (const q of ['status=issued', 'status=redeemed', 'status=expired', 'status=revoked', 'source=shopify', 'source=static_fallback']) {
      const res = await req(app, `http://localhost/api/line-friend-coupons?${q}`, raw);
      expect(res.status, `?${q} は実在する値なので 400 にしない`).toBe(200);
    }
  });

  it('CHECK 制約に無い値は 400 のまま (語彙を広げすぎない)', async () => {
    const raw = dbWithWelcome(500);
    const app = appWithAuth();
    for (const q of ['status=bogus', 'source=manual']) {
      const res = await req(app, `http://localhost/api/line-friend-coupons?${q}`, raw);
      expect(res.status, `?${q}`).toBe(400);
    }
  });
});
