/**
 * 連携 CTA の gate 連動と顧客可視文言 (2026-08-26 連携ファネル修復)
 *
 * 背景 (本番実測): 連携は 6,618 人中 10 人。LINE 内で完結するメール OTP 連携は
 * 2026-06-07 から本番 ON なのに入口が会員証ページ下部のみで利用 0 件、ホームの連携 CTA は
 * 外部ブラウザ + ストアログインを要する App Proxy (トークン発行 3 件・完遂 0 件) に接続されていた。
 * 本 PR でホーム/マイアカウント/空状態の CTA を OTP 第一候補に再設計した。
 *
 * 検証の作法:
 *   - 観測点は「合成後の HTML 文字列」(memory feedback_observe_composed_string —
 *     部分だけ見ると合成後の欠陥が見えない)。顧客可視の文は逐語で固定する。
 *   - ボタンの有無は server が emit した**カードブロック内**で見る。client JS の
 *     shopifyLinkCtaHtml が同じ文字列を JS リテラルとして常に含むため、HTML 全文への
 *     toContain では区別できない。
 *   - gate off の経路のボタンは 1 byte も出さない (押した先が 404 の死んだボタン防止)。
 */

import { describe, it, expect } from 'vitest';
import { liffPages } from '../routes/liff-pages.js';

interface MinimalEnv {
  LIFF_URL: string;
  WORKER_URL: string;
  ACCOUNT_LINK_ENABLED?: string;
  APP_PROXY_LINK_ENABLED?: string;
  SHOPIFY_STOREFRONT_URL?: string;
  MEMBER_BACKFILL_ENABLED?: string;
}

const baseEnv: MinimalEnv = {
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
  WORKER_URL: 'https://example.workers.dev',
};

async function fetchPortal(over: Partial<MinimalEnv> = {}): Promise<string> {
  const res = await liffPages.request(
    '/liff/portal',
    {},
    { ...baseEnv, ...over } as unknown as Record<string, unknown>,
  );
  expect(res.status).toBe(200);
  return res.text();
}

/**
 * server が emit したカードブロック (id= から最初の </div> まで) を取り出す。
 * 連携カードは入れ子 div を持たないのでこれで全体が取れる (入れ子を足したらここも直すこと)。
 */
function cardBlock(html: string, id: string): string | null {
  const i = html.indexOf(`id="${id}"`);
  if (i < 0) return null;
  const end = html.indexOf('</div>', i);
  return end < 0 ? null : html.slice(i, end);
}

const OTP_BTN = 'onclick="openAccountLinkCard()"';
const STORE_BTN = 'onclick="openShopifyLinkPage()"';
const APP_PROXY_ENV = {
  APP_PROXY_LINK_ENABLED: 'true',
  SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com',
} as const;

describe('連携 CTA の gate 行列 (server emit)', () => {
  it('両 gate off → home/マイアカウントの連携カードとも 1 byte も出さない', async () => {
    const html = await fetchPortal();
    expect(html).not.toContain('id="shopify-link-home-card"');
    expect(html).not.toContain('id="shopify-link-card"');
    expect(html).toContain('const ACCOUNT_LINK_OTP_ON = false;');
  });

  it('ACCOUNT_LINK のみ on → 両カードに OTP ボタンだけ (ストアログインは出さない)', async () => {
    const html = await fetchPortal({ ACCOUNT_LINK_ENABLED: 'true' });
    expect(html).toContain('const ACCOUNT_LINK_OTP_ON = true;');
    expect(html).toContain('var SHOPIFY_LINK_URL = null;');
    for (const id of ['shopify-link-home-card', 'shopify-link-card']) {
      const card = cardBlock(html, id);
      expect(card, id).not.toBeNull();
      expect(card!, id).toContain(OTP_BTN);
      expect(card!, id).not.toContain(STORE_BTN);
    }
  });

  it('APP_PROXY のみ on → 両カードにストアログインだけ (btn-primary のまま)、OTP は出さない', async () => {
    const html = await fetchPortal(APP_PROXY_ENV);
    expect(html).toContain('const ACCOUNT_LINK_OTP_ON = false;');
    for (const id of ['shopify-link-home-card', 'shopify-link-card']) {
      const card = cardBlock(html, id);
      expect(card, id).not.toBeNull();
      expect(card!, id).not.toContain(OTP_BTN);
      expect(card!, id).toContain(STORE_BTN);
      expect(card!, id).toContain('btn-primary');
      expect(card!, id).not.toContain('link-cta-secondary');
    }
  });

  it('両方 on → OTP が先 (第一候補)、ストアログインは link-cta-secondary で後', async () => {
    const html = await fetchPortal({ ...APP_PROXY_ENV, ACCOUNT_LINK_ENABLED: 'true' });
    for (const id of ['shopify-link-home-card', 'shopify-link-card']) {
      const card = cardBlock(html, id);
      expect(card, id).not.toBeNull();
      const otpAt = card!.indexOf(OTP_BTN);
      const storeAt = card!.indexOf(STORE_BTN);
      expect(otpAt, id).toBeGreaterThanOrEqual(0);
      expect(storeAt, id).toBeGreaterThan(otpAt);
      // ストアログイン行だけが第二候補スタイル
      const storeLine = card!.split('\n').find((l) => l.includes(STORE_BTN));
      expect(storeLine, id).toContain('link-cta-secondary');
      const otpLine = card!.split('\n').find((l) => l.includes(OTP_BTN));
      expect(otpLine, id).toContain('btn-primary');
    }
  });

  it.each([['TRUE'], ['false'], ['1'], ['true\r'], ['']])(
    "ACCOUNT_LINK_ENABLED=%j は有効化しない (=== 'true' 厳密一致)",
    async (gate) => {
      const html = await fetchPortal({ ACCOUNT_LINK_ENABLED: gate });
      expect(html).toContain('const ACCOUNT_LINK_OTP_ON = false;');
      expect(html).not.toContain('id="shopify-link-home-card"');
    },
  );
});

describe('連携 CTA の顧客可視文言 (逐語)', () => {
  const ALL_ON = { ...APP_PROXY_ENV, ACCOUNT_LINK_ENABLED: 'true', MEMBER_BACKFILL_ENABLED: 'true' };

  it('backfill on → home カードは「これまでのお買い物が会員ランクに反映」を約束する', async () => {
    const html = await fetchPortal(ALL_ON);
    const home = cardBlock(html, 'shopify-link-home-card')!;
    expect(home).toContain(
      '連携すると、これまでのお買い物が会員ランクに反映されます。ご注文の状況確認や、過去のご注文からの再注文もこの画面でできるようになります。',
    );
    const account = cardBlock(html, 'shopify-link-card')!;
    expect(account).toContain(
      '連携すると、これまでのお買い物が会員ランクに反映され、会員特典やお届けのお知らせがLINEで受け取れるようになります。',
    );
  });

  it('backfill off → 過去反映の約束を HTML 全体で 1 箇所も出さない (旧文言のまま)', async () => {
    const html = await fetchPortal({ ...APP_PROXY_ENV, ACCOUNT_LINK_ENABLED: 'true' });
    // gate off では連携しても過去分が 1 円も反映されない — 書いた時点で嘘になる
    expect(html).not.toContain('これまでのお買い物が会員ランクに反映');
    const home = cardBlock(html, 'shopify-link-home-card')!;
    expect(home).toContain(
      '連携すると、ご注文の状況確認や、過去のご注文からの再注文がこの画面でできるようになります。',
    );
    const account = cardBlock(html, 'shopify-link-card')!;
    expect(account).toContain('連携すると、会員特典やお届けのお知らせがLINEで受け取れるようになります。');
  });

  it('OTP ボタンのラベルと補足は「LINE内完結 + 6桁コード」を逐語で伝える', async () => {
    const html = await fetchPortal(ALL_ON);
    const home = cardBlock(html, 'shopify-link-home-card')!;
    expect(home).toContain('メールで連携する（LINEの中で完結）→');
    expect(home).toContain('ご注文時のメールアドレスに届く6桁の確認コードで本人確認します。');
    // ストアログイン側の説明も従来どおり残る
    expect(home).toContain('ストアのページが開きます。ログイン確認のあと、ボタンをタップするとLINEに戻ります。');
  });

  it('openAccountLinkCard は 会員証 (/liff/my-rank) の連携カード (#link) へ遷移する', async () => {
    const html = await fetchPortal({ ACCOUNT_LINK_ENABLED: 'true' });
    expect(html).toContain("'/liff/my-rank'");
    // 🚨 距離 (先頭から N 文字以内) で見ない (2026-08-31)。コメントを足しただけで落ちるうえ、
    //    本体が変わっても近くに #link が在れば通ってしまう。**本体を切り出して**照合する。
    const start = html.indexOf('function openAccountLinkCard()');
    expect(start).toBeGreaterThan(-1);
    const end = html.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    const body = html.slice(start, end + 2).replace(/\/\/[^\n]*/g, ''); // コメントは落とす
    expect(body).toContain('/liff/my-rank');
    expect(body).toContain('#link');
  });

  // slk 死路の復旧文言の gate 連動は liff-sublink-fastpath.test.ts で**実行ベース**に検証する
  // (ここで HTML 全文 toContain すると、両アームが常に JS リテラルとして存在するため
  //  分岐の反転/削除が素通りする tautology になる — 採点ループ MED で実測)
});
