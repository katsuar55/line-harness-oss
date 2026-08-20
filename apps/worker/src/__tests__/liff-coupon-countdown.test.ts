/**
 * クーポン期限文言の恒久ガード (2026-08-11)。
 *
 * サーバ (`services/welcome-coupon.ts` の `formatCouponCountdown`) が返すのは
 * 「あとN日」「あとN時間」「まもなく終了」の **3 形**。素朴に `+ 'で終了'` すると
 * 最後のケースが **「まもなく終了で終了」** という壊れた日本語になる。
 * これは 2026-08-11 まで **本番の welcome / 紹介カードで実際に顧客に見えていた**
 * (welcome クーポンは gate ON)。
 *
 * 修正は「`couponExpiryPhrase` を通す」だけなので、**通し忘れ**が唯一の再発経路。
 * そこで ①各カードの render を実際に走らせる ②ソース全体で素の連結が無いことを機械検査する
 * の 2 軸で固定する。②があるので、4 枚目のカードを足した人も同じ穴に落ちない。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatCouponCountdown } from '../services/welcome-coupon.js';

const root = dirname(fileURLToPath(import.meta.url));
// CRLF のまま正規表現を当てるとブロック抽出が外れ、測定器が無力化する
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8').replace(/\r\n/g, '\n');

const escSrc = pages.match(/^function esc\(s\) \{.*$/m);
const phraseSrc = pages.match(/function couponExpiryPhrase\(remainingText\) \{[\s\S]*?\n\}/);

/** カードごとの loader をソースから抜き出す (test 側で再実装しない) */
const LOADERS = {
  welcome: /async function loadWelcomeCoupon\(preRes\) \{[\s\S]*?\n\}/,
  // 順次活性化 (2026-08-13): loader が参照する待機スタック helper ごと抜き出す
  referral: /var refCouponRefetched = false;[\s\S]*?async function loadReferralCoupon\(preRes\) \{[\s\S]*?\n\}/,
  link: /function linkCouponDaysLeft\(expiresAt\) \{[\s\S]*?\nasync function loadLinkCoupon\(preRes\) \{[\s\S]*?\n\}/,
} as const;

type CardKey = keyof typeof LOADERS;

const ENTRY: Record<CardKey, string> = {
  welcome: 'loadWelcomeCoupon',
  referral: 'loadReferralCoupon',
  link: 'loadLinkCoupon',
};

interface FakeEl {
  className: string;
  style: { display: string };
  innerHTML: string;
}

/** 各カードの API 応答 shape はバラバラなので、カードごとに包む */
function payloadFor(card: CardKey, remainingText: string | null) {
  const base = {
    code: 'TESTCODE1234',
    discountValue: 500,
    expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    remainingText,
    applyUrl: 'https://naturism-diet.com/discount/TESTCODE1234',
  };
  if (card === 'referral') return { data: { coupons: [base] } };
  return { data: { coupon: base } };
}

async function renderCard(card: CardKey, remainingText: string | null): Promise<string> {
  const src = pages.match(LOADERS[card]);
  if (!escSrc || !phraseSrc || !src) throw new Error(`loader block not found: ${card}`);
  const el: FakeEl = { className: 'card p-4', style: { display: 'none' }, innerHTML: '' };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'document', 'apiGet', 'apiFailed', 'cardError', 'vsSetCoupons', 'vsSetCouponsWaiting',
    `${escSrc[0]}\n${phraseSrc[0]}\n${src[0]}\nreturn ${ENTRY[card]};`,
  ) as (...a: unknown[]) => () => Promise<void>;
  const load = factory(
    { getElementById: () => el },
    async () => payloadFor(card, remainingText),
    () => false,
    (_el: FakeEl) => { _el.innerHTML = '<!-- error -->'; },
    () => {},
    () => {},
  );
  await load();
  return el.innerHTML;
}

const CARDS: CardKey[] = ['welcome', 'referral', 'link'];

describe('クーポン期限文言 — サーバが返す 3 形すべてで日本語が壊れない', () => {
  for (const card of CARDS) {
    it(`${card}: 「まもなく終了」に「で終了」を足さない`, async () => {
      const html = await renderCard(card, 'まもなく終了');
      expect(html).toContain('まもなく終了');
      expect(html).not.toContain('まもなく終了で終了');
    });

    it(`${card}: 「あとN日」には「で終了」を足す`, async () => {
      const html = await renderCard(card, 'あと3日');
      expect(html).toContain('あと3日で終了');
    });

    it(`${card}: 「あとN時間」には「で終了」を足す`, async () => {
      const html = await renderCard(card, 'あと5時間');
      expect(html).toContain('あと5時間で終了');
    });

    it(`${card}: remainingText が無ければ期限行ごと出さない (空の ⏳ を残さない)`, async () => {
      const html = await renderCard(card, null);
      expect(html).not.toContain('⏳');
      expect(html).not.toContain('で終了');
    });
  }
});

describe('クーポン期限文言 — サーバの実装と噛み合っている', () => {
  it('formatCouponCountdown が返しうるのは「あと〜」か「まもなく終了」か null のみ', () => {
    const now = Date.parse('2026-08-11T00:00:00Z');
    const at = (ms: number) => formatCouponCountdown(new Date(now + ms).toISOString(), now);
    expect(at(5 * 86_400_000)).toBe('あと5日');
    expect(at(5 * 3_600_000)).toBe('あと5時間');
    expect(at(30 * 60_000)).toBe('まもなく終了');
    expect(at(-1)).toBeNull(); // 失効済みは出さない
  });

  it('🚨サーバの出力をそのまま通しても壊れない (3 形を実際に食わせる)', async () => {
    const now = Date.parse('2026-08-11T00:00:00Z');
    const forms = [5 * 86_400_000, 5 * 3_600_000, 30 * 60_000]
      .map((ms) => formatCouponCountdown(new Date(now + ms).toISOString(), now))
      .filter((s): s is string => s !== null);
    expect(forms.length).toBe(3);
    for (const card of CARDS) {
      for (const form of forms) {
        const html = await renderCard(card, form);
        // 「〜で終了で終了」のような二重述語がどの形でも出ない
        expect(html).not.toMatch(/で終了で終了/);
        expect(html).not.toMatch(/終了で終了/);
      }
    }
  });
});

describe('クーポン期限文言 — ヘルパーの契約 (前方一致)', () => {
  function phrase(input: unknown): string {
    if (!phraseSrc) throw new Error('couponExpiryPhrase not found');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(`${phraseSrc[0]}\nreturn couponExpiryPhrase;`)() as (s: unknown) => string;
    return fn(input);
  }

  it('「あと」で始まるときだけ述語を足す', () => {
    expect(phrase('あと3日')).toBe('あと3日で終了');
    expect(phrase('あと5時間')).toBe('あと5時間で終了');
    expect(phrase('まもなく終了')).toBe('まもなく終了');
  });

  // 🚨 mutation で判明: `indexOf('あと') === 0` を `>= 0` (部分一致) に緩めても、
  //    現サーバが返す 3 形では出力が同じなので描画テストでは検出できない (C7 SURVIVED)。
  //    サーバの文言が将来増えたときに壊れるので、**前方一致であること**を直接固定する。
  it('🚨「あと」を途中に含むだけの文字列には足さない (部分一致に緩めない)', () => {
    expect(phrase('まもなくあと少し')).toBe('まもなくあと少し');
    expect(phrase('本日中のお手続きをおすすめします')).toBe('本日中のお手続きをおすすめします');
  });

  it('null / undefined / 数値でも落ちず、空文字か文字列を返す', () => {
    expect(phrase(null)).toBe('');
    expect(phrase(undefined)).toBe('');
    expect(phrase(0)).toBe(''); // falsy は空に畳む (「0で終了」を作らない)
    expect(typeof phrase(42)).toBe('string');
  });
});

describe('クーポン期限文言 — 通し忘れの再発を機械で塞ぐ', () => {
  it('🚨remainingText に素の「で終了」を連結している箇所が 1 つも無い', () => {
    // ヘルパーを通さずに述語を足す書き方をソース全体で禁止する。
    // これが無いと 4 枚目のカードを足した人が同じ穴に落ちる (今回そうなった)。
    expect(pages).not.toMatch(/remainingText\)\s*\+\s*'で終了'/);
    expect(pages).not.toMatch(/remainingText\s*\+\s*'で終了'/);
  });

  it('「で終了」の文字列リテラルはヘルパーの中にしか存在しない', () => {
    const helper = phraseSrc ? phraseSrc[0] : '';
    expect(helper).toContain("'で終了'");
    // コード行 (コメント行を除く) で 'で終了' を含むのはヘルパーの 1 行だけ
    const codeLines = pages
      .split('\n')
      .filter((l) => l.includes("'で終了'") && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    expect(codeLines.length).toBe(1);
  });

  it('期限を出す 3 カードすべてがヘルパー経由で描画している', () => {
    const uses = [...pages.matchAll(/esc\(couponExpiryPhrase\(cp\.remainingText\)\)/g)];
    // welcome 1 / 紹介 1 / 連携特典 2 (通常 + 切迫 chip)
    expect(uses.length).toBe(4);
  });

  it('ヘルパー名が用途を偽っていない (連携特典専用ではなく共有)', () => {
    expect(pages).toContain('function couponExpiryPhrase(');
    expect(pages).not.toContain('linkCouponExpiryPhrase');
  });
});
