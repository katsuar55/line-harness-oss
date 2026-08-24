/**
 * クーポンの「顧客に見えている文言」と「実スキーマ」の恒久ガード (2026-08-24)
 *
 * 背景:
 *   PR-C (#255, 2026-08-14) が welcome を ¥500 → ¥300 に下げたとき、顧客向け文言を 1 つも
 *   追随させなかった。友だち追加の挨拶・招待文・紹介カード・月次 Flex・管理画面がそろって
 *   「500 円 OFF」と言い続け、実額だけが ¥300 になっていた (景表法の有利誤認)。
 *   さらに **全券に付いている最低購入 ¥2,000 が、顧客が読むどの面にも書かれていなかった**。
 *   2026-08-24 に実装側を文言へ合わせ (¥500 復帰 + 格上げ機構の削除)、条件を明記した。
 *
 * 本ファイルが守るもの:
 *   ① 顧客が読む面 (ポータル / トーク Flex / 紹介 intent / 紹介 LP) に「¥2,000」が出ること
 *   ② 実装と食い違う旧文言 (3 日間有効 / ¥696 → 実質 ¥196 / OSS デモ LP) が復活しないこと
 *   ③ 格上げ機構 (welcome-upgrade.ts) が復活しないこと
 *   ④ 🚨 /api/line-friend-coupons が **実スキーマ** で動くこと
 *
 * ④ が最重要。本番では全リクエストが 500 を返していた (2026-08-24 実測) — 原因は存在しない列
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
import { MIN_SUBTOTAL_JPY } from '../services/shopify-coupon-issuer.js';
import { redeemCouponByCode } from '@line-crm/db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_ENV = {
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
  WORKER_URL: 'https://example.workers.dev',
  API_KEY: 'test-api-key',
};

/** 顧客向けの条件表記。全券共通の最低購入額と一致していること自体もここで固定する。 */
const MIN_LABEL = '¥2,000';

async function portalHtml(env: Record<string, unknown> = BASE_ENV): Promise<string> {
  const res = await liffPages.request('/liff/portal', {}, env);
  expect(res.status).toBe(200);
  return res.text();
}

// ============================================================
// ① 顧客が読む面に利用条件 (¥2,000) が出ている
// ============================================================

describe('利用条件 ¥2,000 が顧客向けの面に明記されている', () => {
  it('定数と表示ラベルが一致している (定数だけ動かして文言が置き去りになるのを防ぐ)', () => {
    expect(MIN_SUBTOTAL_JPY).toBe(2000);
    expect(MIN_LABEL).toBe(`¥${MIN_SUBTOTAL_JPY.toLocaleString('en-US')}`);
  });

  it('ポータル: welcome クーポンカードに条件が載る', async () => {
    const html = await portalHtml();
    expect(html).toContain('友だち追加のお礼です。');
    const i = html.indexOf('友だち追加のお礼です。');
    // 額を出しているのと同じ 1 文の中に条件があること (別の場所にあるだけでは読まれない)
    expect(html.slice(i, i + 200)).toContain(MIN_LABEL);
  });

  it('ポータル: 連携特典カードに条件が載る', async () => {
    const html = await portalHtml();
    const i = html.indexOf('アカウント連携のお礼です。');
    expect(i).toBeGreaterThan(-1);
    expect(html.slice(i, i + 200)).toContain(MIN_LABEL);
  });

  it('ポータル: 紹介特典カードに条件が載る', async () => {
    const html = await portalHtml();
    const i = html.indexOf('お友だちが購入するたびに増えます');
    expect(i).toBeGreaterThan(-1);
    expect(html.slice(i, i + 220)).toContain(MIN_LABEL);
  });

  it('ポータル: 紹介ヒーローに条件が載る (gate の ON/OFF どちらでも)', async () => {
    for (const gate of [undefined, 'true']) {
      const html = await portalHtml({ ...BASE_ENV, REFERRAL_REWARD_ENABLED: gate });
      expect(html, `gate=${String(gate)}`).toContain('OFFクーポンをプレゼント');
      const i = html.indexOf('OFFクーポンをプレゼント');
      expect(html.slice(i, i + 300), `gate=${String(gate)}`).toContain(MIN_LABEL);
    }
  });

  it('ポータル: LINE で送る招待文に条件が載る (gate の ON/OFF どちらの分岐にも)', async () => {
    const html = await portalHtml({ ...BASE_ENV, REFERRAL_REWARD_ENABLED: 'true' });
    // shareRefLine は三項で 2 本の文面を持つ。どちらの分岐にも条件が要る
    const i = html.indexOf('function shareRefLine()');
    expect(i).toBeGreaterThan(-1);
    const body = html.slice(i, i + 900);
    const occurrences = body.split('¥2,000以上のご注文で使えます').length - 1;
    expect(occurrences, '招待文 2 分岐の両方に条件が要る').toBe(2);
  });

  it('トーク「マイクーポン」Flex に条件が載る', () => {
    const flex = JSON.stringify(buildMyCouponFlex('LINE-ABCD2345', 500));
    expect(flex).toContain(MIN_LABEL);
  });

  it('マイクーポン Flex の割引額は台帳の値が正 (既発行の ¥300 券に「500 円」と言わない)', () => {
    const at300 = JSON.stringify(buildMyCouponFlex('LINE-ABCD2345', 300));
    expect(at300).toContain('300 円 OFF');
    expect(at300).not.toContain('500 円 OFF');

    const at500 = JSON.stringify(buildMyCouponFlex('LINE-ABCD2345', 500));
    expect(at500).toContain('500 円 OFF');
  });

  it('マイクーポン Flex: 額が取れないときは既定額で埋めず条件だけ伝える', () => {
    for (const bad of [null, undefined, 0, Number.NaN]) {
      const flex = JSON.stringify(buildMyCouponFlex('LINE-ABCD2345', bad as number | null));
      expect(flex, `value=${String(bad)}`).toContain(MIN_LABEL);
      expect(flex, `value=${String(bad)}`).not.toMatch(/\d+ 円 OFF/);
    }
  });

  it('トークの紹介 intent 応答に条件が載る', async () => {
    const intent: Intent = { type: 'referral', reason: 'test' };
    const msgs = await buildMessagesForIntentAsync(intent, {
      db: null as unknown as D1Database,
      friendId: 'F1',
      liffUrl: BASE_ENV.LIFF_URL,
    });
    const text = JSON.stringify(msgs);
    expect(text).toContain('友だち紹介');
    expect(text).toContain('2,000');
  });

  it('紹介リンクの着地ページ /r/:ref に条件が載る', async () => {
    const worker = (await import('../index.js')).default as {
      fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response>;
    };
    const res = await worker.fetch(
      new Request('https://example.workers.dev/r/ref-abcd1234'),
      BASE_ENV,
      { waitUntil: () => undefined, passThroughOnException: () => undefined },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(MIN_LABEL);
    expect(html).toContain('naturism');
    // 紹介リンクなので LIFF への導線が生きていること
    expect(html).toContain('ref-abcd1234');
  });
});

// ============================================================
// ② 実装と食い違う旧文言が復活しない
// ============================================================

describe('実装と食い違う旧文言が復活しない', () => {
  it('マイクーポン Flex: 期限は 7 日 (follow 発行の実値)。「3 日間有効」は復活させない', () => {
    const flex = JSON.stringify(buildMyCouponFlex('LINE-ABCD2345', 500));
    expect(flex).toContain('7 日間有効');
    expect(flex).not.toContain('3 日間有効');
  });

  it('その「7 日」は follow ハンドラの発行日数と対 (片方だけ動いたら落とす)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../routes/webhook.ts'), 'utf8');
    expect(src, 'welcome クーポンの有効日数を変えたら Flex の文言も直すこと').toMatch(
      /validDays:\s*7\s*,/,
    );
  });

  it('マイクーポン Flex: 最低購入 ¥2,000 に反する金額例 (¥696 → 実質 ¥196) を出さない', () => {
    const flex = JSON.stringify(buildMyCouponFlex('LINE-ABCD2345', 500));
    expect(flex).not.toContain('696');
    expect(flex).not.toContain('196');
  });

  it('/r/:ref は naturism の紹介ページであって OSS デモ LP ではない', async () => {
    const worker = (await import('../index.js')).default as {
      fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response>;
    };
    const res = await worker.fetch(
      new Request('https://example.workers.dev/r/ref-abcd1234'),
      BASE_ENV,
      { waitUntil: () => undefined, passThroughOnException: () => undefined },
    );
    const html = await res.text();
    expect(html).not.toContain('無料代替 OSS');
    expect(html).not.toContain('ステップ配信');
  });

  it('月次ブロードキャストの Flex に開発用語 (Phase N で実装予定) が残っていない', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../services/monthly-broadcast-postback.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/Phase \d+ で実装予定/);
  });
});

// ============================================================
// ③ 格上げ機構が復活しない
// ============================================================

describe('welcome 格上げ機構は削除済み', () => {
  it('services/welcome-upgrade.ts が存在しない', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../services/welcome-upgrade.ts'))).toBe(false);
  });

  it('紹介 claim 経路が格上げを呼ばない', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../routes/liff-portal.ts'), 'utf8');
    // コメントでの言及は許すが、呼び出し (関数名 + 開き括弧) が復活したら落とす
    expect(src).not.toMatch(/upgradeWelcomeCouponForReferred\s*\(/);
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
// ④ /api/line-friend-coupons が実スキーマで動く (本番 500 の恒久ガード)
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

  function seed() {
    const raw = createSchemaDb();
    insertFriend(raw, 'F1');
    raw
      .prepare(
        `INSERT INTO line_friend_coupons
           (id, friend_id, coupon_code, discount_value, discount_currency, issued_at, expires_at, status, source)
         VALUES (?, ?, ?, 500, 'JPY', '2026-08-20T00:00:00.000Z', '2026-08-27T00:00:00.000Z', 'issued', 'shopify')`,
      )
      .run('c1', 'F1', 'LINE-ABCD2345');
    return raw;
  }

  it('一覧が 200 で返る (存在しない列を SELECT したら実 SQLite が落ちる)', async () => {
    const raw = seed();
    const res = await appWithAuth().request(
      'http://localhost/api/line-friend-coupons',
      { headers: { Authorization: `Bearer ${BASE_ENV.API_KEY}` } },
      { DB: asD1(raw) },
    );
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

  it('source フィルタが DB の CHECK 制約と同じ語彙で動く', async () => {
    const raw = seed();
    const app = appWithAuth();
    const ok = await app.request(
      'http://localhost/api/line-friend-coupons?source=shopify',
      { headers: { Authorization: `Bearer ${BASE_ENV.API_KEY}` } },
      { DB: asD1(raw) },
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { total: number } }).data.total).toBe(1);

    // schema.sql の CHECK は ('shopify','static_fallback')。実在する値が 400 で弾かれてはいけない
    const fallback = await app.request(
      'http://localhost/api/line-friend-coupons?source=static_fallback',
      { headers: { Authorization: `Bearer ${BASE_ENV.API_KEY}` } },
      { DB: asD1(raw) },
    );
    expect(fallback.status).toBe(200);
  });

  it('status フィルタも実 SQL で通る', async () => {
    const raw = seed();
    const res = await appWithAuth().request(
      'http://localhost/api/line-friend-coupons?status=issued',
      { headers: { Authorization: `Bearer ${BASE_ENV.API_KEY}` } },
      { DB: asD1(raw) },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { total: number } }).data.total).toBe(1);
  });
});
