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
// couponExpiryPhrase は welcome / 紹介 / 連携特典の 3 カード共有なので、
// 連携特典ブロックの**外**にある。実装を再実装せず、ソースから抜いて注入する。
const phraseSrc = pages.match(/function couponExpiryPhrase\(remainingText\) \{[\s\S]*?\n\}/);
const block = pages.match(
  /function linkCouponDaysLeft\(expiresAt\) \{[\s\S]*?\nasync function loadLinkCoupon\(preRes\) \{[\s\S]*?\n\}\n(?=\/\/ 🚨 連携特典クーポンは redeem)/,
);

interface FakeEl {
  className: string;
  style: { display: string };
  innerHTML: string;
}

interface RenderResult {
  el: FakeEl;
  cardErrorCalls: Array<{ retry: string | null }>;
  /** VITAL STRIP (§3) への通知。追加 fetch ゼロ設計なので、ここが唯一の連絡経路 */
  vsCalls: Array<[string, number]>;
}

async function render(
  apiResponse: unknown,
  opts: { failed?: boolean; throws?: boolean; throwOnRender?: boolean } = {},
): Promise<RenderResult> {
  if (!escSrc || !block || !phraseSrc) throw new Error('loadLinkCoupon block not found in liff-pages.ts');
  // 🚨 初期状態を 'card p-4' にすると、実装のリセットを削除しても値が変わらず
  //    「金の額装を残さない」系のテストが**全部 vacuous** になる (2026-08-11 監査 HIGH)。
  //    現実に守りたいのは「前回は成功して金の額装が付いていた要素を、次の失敗で使い回す」
  //    経路なので、スタブも**前回成功後の状態**から始める。
  const el: FakeEl = {
    className: 'coupon-ticket coupon-ticket--gold',
    style: { display: 'block' },
    innerHTML: '<!-- 前回の描画 -->',
  };
  if (opts.throwOnRender) {
    // 成功分岐で金の額装を付けた**後**に落ちる経路を作る (catch 側のリセットを測るため)
    let held = el.innerHTML;
    Object.defineProperty(el, 'innerHTML', {
      get: () => held,
      set: (v: string) => {
        held = v;
        if (String(v).indexOf('coupon-eyebrow') >= 0) throw new Error('render boom');
      },
      configurable: true,
    });
  }
  const cardErrorCalls: Array<{ retry: string | null }> = [];
  const vsCalls: Array<[string, number]> = [];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'document',
    'apiGet',
    'apiFailed',
    'cardError',
    'vsSetCoupons',
    `${escSrc[0]}\n${phraseSrc[0]}\n${block[0]}\nreturn loadLinkCoupon;`,
  ) as (
    d: unknown,
    g: unknown,
    f: unknown,
    ce: unknown,
    vs: unknown,
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
    (key: string, n: number) => vsCalls.push([key, n]),
  );
  await loadLinkCoupon();
  return { el, cardErrorCalls, vsCalls };
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

  // 🚨 サーバ (formatCouponCountdown) は Math.floor で日数を数える。クライアントが ceil だと
  // 3.5 日残 = サーバ「あと3日」/ クライアント 4 日で **強調されない 24 時間の窓**ができる。
  it('残り 3.5 日 (サーバは「あと3日」と言う) でも切迫 chip になる — floor で数えている', async () => {
    const { el } = await render(
      coupon({ expiresAt: new Date(Date.now() + 3.5 * 86_400_000).toISOString(), remainingText: 'あと3日' }),
    );
    expect(el.innerHTML).toContain('coupon-expiry--soon');
  });

  it('残り 4.2 日 (サーバは「あと4日」) は切迫 chip にしない', async () => {
    const { el } = await render(
      coupon({ expiresAt: new Date(Date.now() + 4.2 * 86_400_000).toISOString(), remainingText: 'あと4日' }),
    );
    expect(el.innerHTML).not.toContain('coupon-expiry--soon');
  });

  // 🚨 サーバは残り 1 時間未満で「まもなく終了」を返す。素朴に 'で終了' を足すと
  // 「まもなく終了で終了」という壊れた日本語が本番に出る (welcome/紹介カードは今もこの形)。
  it('「まもなく終了」に「で終了」を足さない', async () => {
    const { el } = await render(
      coupon({ expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), remainingText: 'まもなく終了' }),
    );
    expect(el.innerHTML).toContain('まもなく終了');
    expect(el.innerHTML).not.toContain('まもなく終了で終了');
    expect(el.innerHTML).toContain('coupon-expiry--soon');
  });

  it('「あと5時間」には「で終了」を足す', async () => {
    const { el } = await render(
      coupon({ expiresAt: new Date(Date.now() + 5 * 3_600_000).toISOString(), remainingText: 'あと5時間' }),
    );
    expect(el.innerHTML).toContain('あと5時間で終了');
  });

  it('expiresAt が壊れていても落ちない (chip は出さない)', async () => {
    const { el } = await render(coupon({ expiresAt: 'not-a-date' }));
    expect(el.innerHTML).toContain('coupon-expiry"');
    expect(el.innerHTML).not.toContain('coupon-expiry--soon');
  });

  // 🚨 mutation で判明: NaN ガードを外しても `left` が NaN になるだけで、
  //    `NaN <= 3` は false なので**描画結果が同じ**になり検出できない (M6 SURVIVED)。
  //    ヘルパーの戻り値の契約 (壊れた入力 → null であって NaN ではない) を直接固定する。
  //    NaN を返す実装は、後から `left > N` 等の別の比較を足した瞬間に静かに壊れる。
  it('linkCouponDaysLeft は壊れた入力に NaN でなく null を返す', () => {
    const src = block ? block[0] : '';
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const daysLeft = new Function(`${src}\nreturn linkCouponDaysLeft;`)() as (
      s: string | null,
    ) => number | null;
    for (const bad of ['not-a-date', '', null]) {
      const v = daysLeft(bad as string);
      expect(v).toBeNull();
      expect(Number.isNaN(v as number)).toBe(false);
    }
    // 正常系は数値を返す
    expect(typeof daysLeft(new Date(Date.now() + 3 * 86_400_000).toISOString())).toBe('number');
  });

  it('remainingText なし → 期限表示ごと出さない (空の ⏳ を残さない)', async () => {
    const { el } = await render(coupon({ remainingText: null }));
    expect(el.innerHTML).not.toContain('⏳');
  });
});

describe('連携特典カード — 状態遷移で金の額装を残さない', () => {
  it('クーポン無し → 非表示 + 通常カード class に戻す (前回の金の額装を引き継がない)', async () => {
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

  // 🚨 mutation で判明: apiGet が throw するケースだけだと、関数**先頭**のリセットが既に
  //    効いているので catch 側のリセットを消しても緑のまま (M9 SURVIVED)。
  //    catch のリセットが本当に要るのは「成功して金の額装を付けた**後**に落ちる」経路。
  it('描画の途中で落ちても金の額装を残さない (成功後に throw する経路)', async () => {
    const { el, cardErrorCalls } = await render(coupon(), { throwOnRender: true });
    expect(cardErrorCalls.length).toBe(1);
    expect(el.className).toBe('card p-4');
  });

  it('成功時は coupon-ticket--gold を付ける', async () => {
    const { el } = await render(coupon());
    expect(el.className).toBe('coupon-ticket coupon-ticket--gold');
  });
});

/**
 * VITAL STRIP (§3) は**追加 fetch ゼロ**設計なので、各 loader からの set が唯一の連絡経路。
 * ここが漏れると strip の枚数が黙って実態とズレる (「クーポン 0 枚」と出しながらカードは出ている)。
 * increment でなく **set** であること (= 再試行しても二重計上しない) も固定する。
 */
describe('連携特典カード — VITAL STRIP への通知', () => {
  it('クーポンありで 1 を set する', async () => {
    const { vsCalls } = await render(coupon());
    expect(vsCalls).toEqual([['link', 1]]);
  });

  it('クーポン無しで 0 を set する (前回の枚数を残さない)', async () => {
    const { vsCalls } = await render({ data: { coupon: null } });
    expect(vsCalls).toEqual([['link', 0]]);
  });

  it('2 回続けて成功しても値は 1 のまま (increment でなく set)', async () => {
    const a = await render(coupon());
    const b = await render(coupon());
    expect(a.vsCalls.concat(b.vsCalls)).toEqual([['link', 1], ['link', 1]]);
  });

  it('取得失敗のときは枚数を触らない (誤って 0 と言わない)', async () => {
    const { vsCalls } = await render(null, { failed: true });
    expect(vsCalls).toEqual([]);
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
    expect(el.innerHTML).toContain('>コピー<');
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
    // 🚨 `color:` の素朴な一致は **border-color / background-color も拾う** (= doc が許可した
    //    装飾用途で誤検出し、最短の直し方が「期待値を 2 に上げる」になってガードが緩む)。
    //    前が `-` や英数字でない `color:` だけを文字色として数える。
    const goldTextUses = [...pages.matchAll(/(?<![-\w])color:\s*#b8933f/gi)];
    expect(goldTextUses.length).toBe(1);
    expect(pages).toContain('.nxq-rname--premium{color:#b8933f}');
    // var(--gold) 経由の文字色は 1 つも作らない (トークン名だと AA の危うさが見えなくなるため)
    expect(pages).not.toMatch(/(?<![-\w])color:\s*var\(--gold\)/);
    // rgb()/rgba() 記法での回り込みも塞ぐ (#b8933f = rgb(184,147,63))
    expect(pages).not.toMatch(/rgb\(\s*184\s*,\s*147\s*,\s*63/i);
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
    // 完全一致だと `--gold::after` や 1 コロンの `:after` を見逃す
    expect(pages).not.toMatch(/\.coupon-ticket[\w-]*::?after/);
  });

  it('操作ボタンのタップ域は 44px 以上', () => {
    expect(pages).toContain('.coupon-act{min-height:44px');
  });

  // 🚨 320px 端末のカード内幅は約 254px。nowrap のボタンを 2 つ横に並べると溢れて横スクロールになる。
  it('320px でボタンが溢れない配置 (コードとコピーが 1 行・主 CTA は幅いっぱい)', async () => {
    const { el } = await render(coupon());
    expect(el.innerHTML).toContain('>コピー<'); // 「コードをコピー」だと横並びで溢れる
    expect(el.innerHTML).toContain('style="width:100%">このクーポンで買う');
    // コード欄は縮められる (min-width:0 が無いと flex 子は縮まず溢れる)
    expect(el.innerHTML).toContain('flex:1 1 auto;min-width:0');
  });

  it('コード欄は溢れずに省略される (長いコードでレイアウトを壊さない)', () => {
    expect(pages).toMatch(/\.coupon-code\{[^}]*text-overflow:ellipsis/);
  });

  // WCAG 1.4.11: 地 (#faf6ec) と面 (#fff) がほぼ同色なので、境界は枠線しかない。
  // --gold-line #e6d5a8 は 1.35:1 で不足する。
  it('ghost ボタンの輪郭は --gold-ink (AA 側) を使う', () => {
    expect(pages).toContain('.coupon-act--ghost{border:1.5px solid var(--gold-ink)');
    expect(pages).not.toContain('.coupon-act--ghost{border:1.5px solid var(--gold-line)');
  });

  it('額装は静的 (モーション憲法: 動く枠は .ref-hero 1 枚だけ)', () => {
    // `--gold{...}` 本体だけ見ると ::before や別ルールに足された常時アニメを見逃す。
    // クーポン系の**全ルール**を集めて検査する。
    const rules = [...pages.matchAll(/\.coupon-[\w-]*(?:::?[\w-]+)?\s*(?:,\s*\.[\w-]+)*\{[^}]*\}/g)].map((m) => m[0]);
    expect(rules.length).toBeGreaterThan(5); // ルールを 1 つも拾えていないなら測れていない
    for (const r of rules) {
      expect(r).not.toContain('animation');
      expect(r).not.toContain('@keyframes');
    }
  });
});

describe('連携特典の額 — コードとカードの単一の正', () => {
  it('発行側の既定額は 300 (2026-08-11 Katsu 決定)', () => {
    expect(linkReward.DEFAULT_DISCOUNT_VALUE_JPY).toBe(300);
  });
});

/**
 * 🔴 2026-08-13 本番実測で 2026-08-11 監査の前提は訂正された: 4 系統とも ORDER クラスで、
 * ランク/紹介/連携は combinesWith 設定済み = 実際に重なる (Plus 不要)。
 * ただし「併用できます」の掲出は **PR-C (welcome combinesWith + 全券 min¥2,000) が本番に
 * 乗ってから** (順序厳守: 実装 → 表記。先に書くと ¥2,000 条件のない過大表示になる)。
 * PR-C 反映時にこのガードは「条件つき文言 (1枚まで・¥2,000以上) の掲出テスト」へ置き換える。
 */
describe('連携特典カード — 実装が本番に乗るまで併用を約束しない', () => {
  it('カード本文に併用の約束を書かない', async () => {
    const { el } = await render(coupon());
    for (const claim of ['重ねて', '併用', '一緒にお使い', 'ほかの割引']) {
      expect(el.innerHTML).not.toContain(claim);
    }
  });

  it('実装が根拠にしている combinesWith は残っている (設定を消したわけではない)', () => {
    const issuer = readFileSync(join(root, '..', 'services', 'link-reward-coupon-issuer.ts'), 'utf8');
    expect(issuer).toContain('combinesWith: { productDiscounts: true, orderDiscounts: true');
  });
});

/**
 * 🚨 2026-08-11 監査 HIGH。クーポンは redeem の HTTP 応答**後**に waitUntil で発行される。
 * ポータルは init で loadLinkCoupon() を済ませているので、後追いしないと
 * magic-link / App Proxy で連携した本人が特典カードを一度も見ない。
 */
describe('連携特典カード — 連携直後に本人へ届く', () => {
  it('redeem 成功ハンドラが後追い読み込みを呼ぶ', () => {
    const redeem = pages.match(/function subLinkRedeem\(token, btn\) \{[\s\S]*?\n\}\n/);
    expect(redeem).toBeTruthy();
    expect(redeem![0]).toContain('refreshLinkCouponAfterLink(0)');
    expect(redeem![0]).toContain('markShopifyLinked()');
  });

  it('後追いは有限回で止まる (無限ポーリングにしない)', () => {
    const delays = pages.match(/var LINK_COUPON_RETRY_MS = \[([^\]]*)\]/);
    expect(delays).toBeTruthy();
    const ms = delays![1].split(',').map((s) => Number(s.trim()));
    expect(ms.length).toBeGreaterThanOrEqual(2);
    expect(ms.length).toBeLessThanOrEqual(5);
    for (const v of ms) expect(v).toBeGreaterThanOrEqual(1000);
    // 単調増加 (= backoff。等間隔の短周期ポーリングにしない)
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThan(ms[i - 1]);
  });

  it('完了モーダルへの告知は金額を書かない (台帳が唯一の正)', () => {
    const fn = pages.match(/function announceLinkCoupon\(\) \{[\s\S]*?\n\}/);
    expect(fn).toBeTruthy();
    expect(fn![0]).not.toMatch(/[¥￥]\s*\d/);
  });

  // 🚨 mutation で判明: `toContain('data-link-coupon-note')` だけだと、**ガードの条件式**を
  //    消しても setAttribute 側の同じ文字列が残るので素通りする (M24 SURVIVED)。
  //    「早期 return の条件に既存判定が入っていること」を構造で見る。
  it('告知は二重挿入しない (ガードの条件式そのものを固定する)', () => {
    const fn = pages.match(/function announceLinkCoupon\(\) \{[\s\S]*?\n\}/);
    expect(fn).toBeTruthy();
    // 早期 return の行が、モーダル不在**と**既存ノートの両方を見ていること
    // 条件式に `)` を含む (querySelector 呼び出し) ので `[^)]*` では途中で切れる
    const guard = fn![0].match(/^\s*if \(.*\) return;$/m);
    expect(guard).toBeTruthy();
    expect(guard![0]).toContain('!card');
    expect(guard![0]).toContain("querySelector('[data-link-coupon-note]')");
    // 実際に 2 回呼んでも 1 つしか増えないことを DOM スタブで確認する
    const notes: Array<Record<string, string>> = [];
    const card = {
      querySelector: (sel: string) =>
        sel === '[data-link-coupon-note]'
          ? (notes.length ? notes[0] : null)
          : null,
      insertBefore: (n: Record<string, string>) => notes.push(n),
      appendChild: (n: Record<string, string>) => notes.push(n),
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
      'document',
      'subLinkNode',
      `${fn![0]}\nreturn announceLinkCoupon;`,
    ) as (d: unknown, s: unknown) => () => void;
    const announce = factory(
      { querySelector: (sel: string) => (sel === '#sublink-overlay .sublink-card' ? card : null) },
      () => ({ setAttribute: () => {} }) as unknown,
    );
    announce();
    announce();
    expect(notes.length).toBe(1);
  });
});
