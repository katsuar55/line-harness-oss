/**
 * 連携特典クーポンカード (Sprint A-1 / 2026-08-11 「豪華なクーポンカード」) の恒久ガード。
 *
 * #247 で入ったカードには **描画側のテストが 1 本も無かった** (grep で 0 件)。
 * 金額・AA・期限表現はいずれも「間違っていても静かに本番へ出る」種類なので、
 * source の静的検査 + 実際の render 実行 (DOM スタブ) の 2 軸で固定する。
 *
 * 特に重要な 2 点:
 *   1. **--gold #b8933f は文字色に使えない** (白地 2.88:1 / 金地 2.67:1 = 大文字 3:1 すら不成立)。
 *      金の文字は --gold-ink #8a6a24 (白 5.04:1 / 金地 4.67:1)、塗りは --gold-deep #92400e (7.09:1)。
 *   2. **表示額は台帳 (line_link_coupons.discount_value) の実値**。既定額 (¥300) を
 *      フォールバックに使うと、既発行の ¥500 券を ¥300 と表示して実額と食い違う。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { __test__ as linkReward } from '../services/link-reward-coupon-issuer.js';

const root = dirname(fileURLToPath(import.meta.url));
// CRLF のまま正規表現を当てると `\n}` 系のアンカーが全て外れ、「ブロックが見つからない」で
// テストが**構造的に無力化**する (= 変異を検出できない測定器になる)。読み込み時に正規化する。
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8').replace(/\r\n/g, '\n');

// ─────────────────────────────────────────────────────────────
// render を実際に走らせるための最小ハーネス (ロジックを test 側で再実装しない)
// ─────────────────────────────────────────────────────────────
const escSrc = pages.match(/^function esc\(s\) \{.*$/m);
const block = pages.match(
  /function linkCouponDaysLeft\(expiresAt\) \{[\s\S]*?\n\}\nasync function loadLinkCoupon\(\) \{[\s\S]*?\n\}\n(?=function copyLinkCouponCode)/,
);

interface FakeEl {
  className: string;
  style: { display: string };
  innerHTML: string;
}

interface RenderResult {
  el: FakeEl;
  cardErrorCalls: Array<{ retry: string | null }>;
}

async function render(
  apiResponse: unknown,
  opts: { failed?: boolean; throws?: boolean } = {},
): Promise<RenderResult> {
  if (!escSrc || !block) throw new Error('loadLinkCoupon block not found in liff-pages.ts');
  const el: FakeEl = { className: 'card p-4', style: { display: 'none' }, innerHTML: '' };
  const cardErrorCalls: Array<{ retry: string | null }> = [];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'document',
    'apiGet',
    'apiFailed',
    'cardError',
    `${escSrc[0]}\n${block[0]}\nreturn loadLinkCoupon;`,
  ) as (
    d: unknown,
    g: unknown,
    f: unknown,
    ce: unknown,
  ) => () => Promise<void>;
  const loadLinkCoupon = factory(
    { getElementById: (id: string) => (id === 'link-coupon-card' ? el : null) },
    async () => {
      if (opts.throws) throw new Error('boom');
      return apiResponse;
    },
    () => Boolean(opts.failed),
    (_el: FakeEl, _res: unknown, retry: string) => {
      cardErrorCalls.push({ retry: retry ?? null });
      _el.innerHTML = '<!-- error -->';
    },
  );
  await loadLinkCoupon();
  return { el, cardErrorCalls };
}

const coupon = (over: Record<string, unknown> = {}) => ({
  data: {
    coupon: {
      code: 'NLINK-ABCD2345',
      discountValue: 300,
      expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      remainingText: 'あと6日',
      applyUrl: 'https://naturism-diet.com/discount/NLINK-ABCD2345',
      ...over,
    },
  },
});

describe('連携特典カード — 金額は台帳の実値 (定数フォールバックを持たない)', () => {
  it('¥300 の新規券をそのまま描く', async () => {
    const { el } = await render(coupon());
    expect(el.innerHTML).toContain('¥300');
    expect(el.innerHTML).toContain('NLINK-ABCD2345');
    expect(el.style.display).toBe('block');
  });

  it('🚨既発行の ¥500 券は ¥500 のまま描く (¥300 化を遡及表示しない)', async () => {
    const { el } = await render(coupon({ discountValue: 500 }));
    expect(el.innerHTML).toContain('¥500');
    expect(el.innerHTML).not.toContain('¥300');
  });

  it('壊れた額 (0 / NaN / 負) は「¥0 OFF」や既定額の嘘でなく金額なし見出しへ退避', async () => {
    for (const bad of [0, -100, 'abc', null, undefined]) {
      const { el } = await render(coupon({ discountValue: bad }));
      expect(el.innerHTML).toContain('割引クーポン');
      expect(el.innerHTML).not.toContain('¥0');
      expect(el.innerHTML).not.toContain(`¥${linkReward.DEFAULT_DISCOUNT_VALUE_JPY}`);
      expect(el.innerHTML).toContain('NLINK-ABCD2345'); // コードは出す = 使える
    }
  });
});

describe('連携特典カード — 期限の切迫表現 (§2-E: 残 3 日以下は chip)', () => {
  it('残り 6 日 → 通常の期限表示', async () => {
    const { el } = await render(coupon());
    expect(el.innerHTML).toContain('coupon-expiry"');
    expect(el.innerHTML).not.toContain('coupon-expiry--soon');
  });

  it('残り 2 日 → coupon-expiry--soon の chip', async () => {
    const { el } = await render(
      coupon({ expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), remainingText: 'あと2日' }),
    );
    expect(el.innerHTML).toContain('coupon-expiry--soon');
  });

  it('expiresAt が壊れていても落ちない (chip は出さない)', async () => {
    const { el } = await render(coupon({ expiresAt: 'not-a-date' }));
    expect(el.innerHTML).toContain('coupon-expiry"');
    expect(el.innerHTML).not.toContain('coupon-expiry--soon');
  });

  it('remainingText なし → 期限表示ごと出さない (空の ⏳ を残さない)', async () => {
    const { el } = await render(coupon({ remainingText: null }));
    expect(el.innerHTML).not.toContain('⏳');
  });
});

describe('連携特典カード — 状態遷移で金の額装を残さない', () => {
  it('クーポン無し → 非表示 + 通常カード class に戻す', async () => {
    const { el } = await render({ data: { coupon: null } });
    expect(el.style.display).toBe('none');
    expect(el.className).toBe('card p-4');
  });

  it('API 失敗 → cardError(retry=loadLinkCoupon) + 金の額装を付けない', async () => {
    const { el, cardErrorCalls } = await render(null, { failed: true });
    expect(cardErrorCalls).toEqual([{ retry: 'loadLinkCoupon' }]);
    expect(el.className).toBe('card p-4');
  });

  it('例外 → 金の額装を剥がしてから cardError (エラー文が金枠で出ない)', async () => {
    const { el, cardErrorCalls } = await render(null, { throws: true });
    expect(cardErrorCalls.length).toBe(1);
    expect(el.className).toBe('card p-4');
  });

  it('成功時は coupon-ticket--gold を付ける', async () => {
    const { el } = await render(coupon());
    expect(el.className).toBe('coupon-ticket coupon-ticket--gold');
  });
});

describe('連携特典カード — エスケープと安全規約', () => {
  it('コードに HTML 特殊文字が混じっても属性・本文の両方でエスケープされる', async () => {
    const { el } = await render(coupon({ code: 'A"><img src=x>' }));
    expect(el.innerHTML).not.toContain('<img');
    expect(el.innerHTML).toContain('&quot;&gt;&lt;img');
  });

  it('applyUrl が無いときは「買う」リンクを出さない (href="" の死んだリンクを作らない)', async () => {
    const { el } = await render(coupon({ applyUrl: null }));
    expect(el.innerHTML).not.toContain('このクーポンで買う');
    expect(el.innerHTML).toContain('コードをコピー');
  });

  it('onclick は名前付き関数のみ (引用符ネスト禁止規約)', () => {
    const src = block ? block[0] : '';
    const onclicks = [...src.matchAll(/onclick="([^"]*)"/g)].map((m) => m[1]);
    expect(onclicks.length).toBeGreaterThan(0);
    for (const h of onclicks) expect(h).toMatch(/^[A-Za-z_$][\w$]*\((this)?\)$/);
  });
});

describe('連携特典カード — AA (§7-1) とトークン規律', () => {
  it('チケット様式の CSS が存在する (§2-E)', () => {
    expect(pages).toContain('.coupon-ticket{');
    expect(pages).toContain('.coupon-ticket--gold{');
    expect(pages).toContain('.coupon-code{');
    expect(pages).toContain('.coupon-code--gold{');
  });

  it('🚨--gold #b8933f を新たな文字色に使っていない (白地 2.88:1 = 大文字 3:1 すら不成立)', () => {
    // 既知の例外は `.nxq-rname--premium` 1 箇所だけ (nxq 診断は本サイトのミラー = 意匠の聖域。
    // 2.88:1 は large-text 3:1 をわずかに割るので、聖域の外へ広げないことをここで固定する)。
    const goldTextUses = [...pages.matchAll(/color:\s*#b8933f/gi)];
    expect(goldTextUses.length).toBe(1);
    expect(pages).toContain('.nxq-rname--premium{color:#b8933f}');
    // var(--gold) 経由の文字色は 1 つも作らない (トークン名だと AA の危うさが見えなくなるため)
    expect(pages).not.toMatch(/color:\s*var\(--gold\)/);
  });

  it('金の文字は --gold-ink / --gold-deep のみ (AA 合格側)', () => {
    expect(pages).toContain('color:var(--gold-ink)');
    expect(pages).toContain('background:var(--gold-deep);color:#fff');
  });

  it('🚨旧カードの AA 不成立色 (#089591 3.67:1 / #078783 4.37:1) がポータルから消えている', () => {
    expect(pages).not.toContain('#089591');
    expect(pages).not.toContain('#078783');
  });

  it('ノッチ (左右の切込み円) を作っていない — 白カード上で浮くため審査で却下済み', () => {
    expect(pages).not.toContain('.coupon-ticket::after');
  });

  it('操作ボタンのタップ域は 44px 以上', () => {
    expect(pages).toContain('.coupon-act{min-height:44px');
  });

  it('額装は静的 (モーション憲法: 動く枠は .ref-hero 1 枚だけ)', () => {
    const css = pages.match(/\.coupon-ticket--gold\{[^}]*\}/);
    expect(css).toBeTruthy();
    expect(css![0]).not.toContain('animation');
  });
});

describe('連携特典の額 — コードとカードの単一の正', () => {
  it('発行側の既定額は 300 (2026-08-11 Katsu 決定)', () => {
    expect(linkReward.DEFAULT_DISCOUNT_VALUE_JPY).toBe(300);
  });
});
