/**
 * ¥300 連携特典を **LINE 内メール OTP で連携した本人に見せる** 経路の恒久ガード (2026-08-28)。
 *
 * ## なぜこのテストが要るか (本番初実行の直前に見つかった欠陥)
 * ホームの第一候補 CTA `openAccountLinkCard()` は `window.location.href` で会員証
 * (/liff/my-rank) へ**フルページ遷移**する。ポータルの `#link-coupon-card` と後追い取得
 * `refreshLinkCouponAfterLink` はそこで破棄されるため、OTP で連携した本人は
 *   - 特典カードを一度も見ず
 *   - しかも会員証の一覧は別台帳 (shopify_coupon_assignments) しか読まないので
 *     「保有クーポン 0枚 / 利用できるクーポンはまだありません」と**持っているのに無いと言う**
 * 状態だった。台帳 `line_link_coupons` は本番 0 行 = この経路は一度も実行されていないため、
 * 実行されるまで誰も気づけない種類の欠陥である。
 *
 * ## 観測点
 * 「合成後」を見る (= [[feedback_observe_composed_string]])。片側だけ rename されたら落ちること:
 *   - `renderCoupons` が実際に吐く属性 と `linkCouponVisible` が実際に引くセレクタ
 *   - 空状態の文言は**逐語**照合 (連携直後に「ありません」と断定しない)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
// CRLF のまま正規表現を当てると `\n}` 系のアンカーが外れ、「ブロックが無い」で
// テストが構造的に無力化する (= 変異を検出できない測定器になる)。読み込み時に正規化する。
const src = readFileSync(join(root, '..', 'routes', 'liff-my-rank.ts'), 'utf8').replace(/\r\n/g, '\n');

function grab(re: RegExp, label: string): string {
  const m = src.match(re);
  if (!m) throw new Error(`${label} not found in liff-my-rank.ts`);
  return m[0];
}

const escSrc = grab(/^function esc\(s\)\{.*$/m, 'esc');
const yenSrc = grab(/^function yen\(n\)\{.*$/m, 'yen');
const fmtMdSrc = grab(/^function fmtMd\(s\)\{.*$/m, 'fmtMd');
const labelSrc = grab(/^function couponValueLabel\(cp\)\{.*$/m, 'couponValueLabel');
const renderSrc = grab(/function renderCoupons\(d\)\{[\s\S]*?\n\}/, 'renderCoupons');
const visibleSrc = grab(/function linkCouponVisible\(\)\{[\s\S]*?\n\}/, 'linkCouponVisible');

interface FakeCard {
  className: string;
  style: { display: string };
  innerHTML: string;
  querySelectorAll: () => never[];
}

/** renderCoupons を実際に走らせて、吐かれた HTML を返す (ロジックを test 側で再実装しない) */
function render(coupons: unknown[], opts: { pending?: boolean; timedOut?: boolean } = {}): string {
  const card: FakeCard = {
    className: '',
    style: { display: 'none' },
    innerHTML: '',
    querySelectorAll: () => [],
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'document',
    'linkCouponPending',
    'linkCouponTimedOut',
    `${escSrc}\n${yenSrc}\n${fmtMdSrc}\n${labelSrc}\n${renderSrc}\nreturn renderCoupons;`,
  ) as (d: unknown, pending: boolean, timedOut: boolean) => (data: unknown) => void;
  const renderCoupons = factory(
    { getElementById: (id: string) => (id === 'coupons-card' ? card : null) },
    Boolean(opts.pending),
    Boolean(opts.timedOut),
  );
  renderCoupons({ coupons });
  return card.innerHTML;
}

const LINK_ROW = {
  kind: 'link_reward',
  code: 'NLINK-ABCD1234',
  title: '🔗 連携特典（¥2,000以上のご注文で）',
  discountType: 'fixed_amount',
  discountValue: 300,
  expiresAt: '2026-09-27T00:00:00.000Z',
};

describe('連携特典を会員証 (my-rank) で見せる', () => {
  it('連携特典の行に data-coupon-kind が付く (= 後追い取得が「出た」と判定できる)', () => {
    const html = render([LINK_ROW]);
    expect(html).toContain('data-coupon-kind="link_reward"');
  });

  it('通常クーポンには kind 属性を付けない (= 誤検出で後追いが早期終了しない)', () => {
    const html = render([
      { kind: null, code: 'LINE-X', title: '友だちクーポン', discountType: 'fixed_amount', discountValue: 500, expiresAt: null },
    ]);
    expect(html).not.toContain('data-coupon-kind');
  });

  it('🚨 合成: renderCoupons が吐く属性を linkCouponVisible のセレクタが実際に含む', () => {
    // 片側だけ rename されたら落ちる。ラベル単体を見ていると両者の乖離が見えない。
    const attr = render([LINK_ROW]).match(/data-coupon-kind="([^"]+)"/);
    expect(attr).not.toBeNull();
    expect(visibleSrc).toContain(`[data-coupon-kind="${attr![1]}"]`);
    // 引き先のカード id も、renderCoupons が実際に書き込む要素と同じであること
    expect(renderSrc).toContain("getElementById('coupons-card')");
    expect(visibleSrc).toContain('#coupons-card');
  });

  it('金額は台帳の実値をそのまま出す (既定額 ¥300 にフォールバックしない)', () => {
    // 既発行の ¥500 券を ¥300 と表示する類の嘘を防ぐ
    const html = render([{ ...LINK_ROW, discountValue: 500 }]);
    expect(html).toContain('¥500 OFF');
    expect(html).not.toContain('¥300');
  });

  it('枚数は連携特典を含めて数える', () => {
    expect(render([LINK_ROW])).toContain('>1枚<');
    expect(render([LINK_ROW, { kind: null, code: 'LINE-X', title: 'x', discountType: 'fixed_amount', discountValue: 500, expiresAt: null }])).toContain('>2枚<');
  });
});

describe('連携直後の空状態 (発行は waitUntil で応答の後)', () => {
  it('🚨 連携直後は「ありません」と断定しない (= 届く直前に否定する嘘)', () => {
    const html = render([], { pending: true });
    expect(html).toContain('特典クーポンをご用意しています…');
    expect(html).not.toContain('利用できるクーポンはまだありません');
  });

  // 🚨 2026-08-28 採点ループ P2: 本文だけ直しても、枚数バッジが先に組まれていたため
  //    「ご用意しています…」の真上で「0枚」と言い続けていた。観測点を**合成後**に置く。
  it('🚨 合成: 待機中に「0枚」と言わない (本文だけでなくバッジも見る)', () => {
    const html = render([], { pending: true });
    expect(html).not.toContain('0枚');
    expect(html).toContain('準備中');
  });

  it('打ち切り後も断定に戻さない (発行失敗と発行中は画面で区別できない)', () => {
    const html = render([], { timedOut: true });
    expect(html).toContain('特典クーポンがまだ届いていません');
    expect(html).not.toContain('利用できるクーポンはまだありません');
    expect(html).not.toContain('0枚');
  });

  it('通常の空 (連携していない) は従来どおりの文言 + 0枚', () => {
    const html = render([], { pending: false });
    expect(html).toContain('利用できるクーポンはまだありません');
    expect(html).toContain('0枚');
    expect(html).not.toContain('特典クーポンをご用意しています');
    expect(html).not.toContain('準備中');
  });
});

describe('OTP 成功時の後追い取得の配線', () => {
  const verifySrc = (() => {
    const m = src.match(/async function linkVerify\(\)\{[\s\S]*?\n\}/);
    if (!m) throw new Error('linkVerify not found');
    return m[0];
  })();

  it('成功分岐が後追い取得を起動する', () => {
    // 200 成功分岐の中に居ること (失敗分岐に紛れていたら意味がない)
    const ok = verifySrc.match(/if\(res\.status===200[\s\S]*?return;\n\s*\}/);
    expect(ok).not.toBeNull();
    expect(ok![0]).toContain('refreshLinkCouponAfterLink(0)');
    expect(ok![0]).toContain('linkCouponPending = true');
  });

  it('後追いは階段状にリトライし、諦めたら pending を畳む', () => {
    expect(src).toContain('var LINK_COUPON_RETRY_MS = [1500, 4000, 9000, 20000];');
    const refresh = src.match(/function refreshLinkCouponAfterLink\(attempt\)\{[\s\S]*?\n\}/);
    expect(refresh).not.toBeNull();
    expect(refresh![0]).toContain('n >= LINK_COUPON_RETRY_MS.length');
    expect(refresh![0]).toContain('linkCouponPending = false');
    expect(refresh![0]).toContain('loadRank()');
    // 打ち切り時は断定に戻さず「時間がかかっています」へ切り替える
    expect(refresh![0]).toContain('linkCouponTimedOut = true');
  });

  // 🚨 2026-08-28 採点ループ P1: クーポンだけを終了条件にすると、backfill も応答の後に
  //    走るため会員証が「レギュラー / ¥0 / まずは1回のお買い物で」でセッション中固着する。
  it('🚨 クーポンが出ても取り込み中なら追い続ける (ランクが ¥0 で固着しない)', () => {
    const refresh = src.match(/function refreshLinkCouponAfterLink\(attempt\)\{[\s\S]*?\n\}/);
    expect(refresh).not.toBeNull();
    expect(refresh![0]).toContain('if (got && !lastImportPending) return;');
    // 告知は 1 回だけ (追い続けても毎 tick トーストしない)
    expect(refresh![0]).toContain('linkCouponAnnounced');
    // この画面に他の再取得トリガーが無いことも固定する (あるなら終了条件を緩めてよい)
    expect(src).not.toMatch(/addEventListener\('(visibilitychange|pageshow|focus)'/);
    expect(src).not.toContain('setInterval(');
  });

  // 取り込み中の正直な文言 (逐語)。ソース照合なのは renderRank / renderProgress が
  // medal / 進捗バー等の依存を多く持ち、切り出して走らせると測定器の方が複雑になるため。
  it('🚨 取り込み中はランク・進捗で断定しない (逐語)', () => {
    expect(src).toContain('これまでのお買い物を反映しています…');
    expect(src).toContain('これまでのお買い物を反映しています（数分かかる場合があります）');
    expect(src).toContain("(d.purchaseImportPending ? '集計中…' : esc(yen(d.trailing12moJpy)))");
    // 断定側は「取り込み中でないとき」だけに残っていること
    const hero = src.slice(src.indexOf('function renderRank('), src.indexOf('function renderProgress('));
    const i = hero.indexOf('これまでのお買い物を反映しています…');
    const j = hero.indexOf('まずは1回のお買い物でブロンズ会員に');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i); // pending 分岐が先 = 断定は else 側
  });

  it('完了告知に金額を書かない (正は台帳を出すクーポン行)', () => {
    const announce = src.match(/function announceLinkCoupon\(\)\{[\s\S]*?\n\}/);
    expect(announce).not.toBeNull();
    expect(announce![0]).not.toMatch(/[¥￥]\s*\d/);
    expect(announce![0]).toContain('連携特典クーポンをお届けしました');
  });
});

describe('inline script の配線', () => {
  it('🚨 pending フラグと利用側が同じ script ブロックに居る (var の巻き上げが効く)', () => {
    // 別ブロックに分かれると巻き上げが効かず renderCoupons が ReferenceError で落ちる。
    // parse 検証 (liff-script-syntax) は**どちらでも通る**ので、ここで固定する。
    const opens = [...src.matchAll(/<script/g)].map((m) => m.index ?? 0);
    const blockOf = (needle: string) => {
      const i = src.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return opens.filter((o) => o < i).length;
    };
    const home = blockOf('var linkCouponPending');
    expect(blockOf('function renderCoupons(d){')).toBe(home);
    expect(blockOf('async function linkVerify(){')).toBe(home);
    expect(blockOf('function linkCouponVisible(){')).toBe(home);
  });
});

describe('loadRank の応答追い越し (Codex P2 / 2026-08-28)', () => {
  // 正規表現に改行エスケープを書くと、生成側で潰れて「Unterminated regular expression」に
  // なりやすい。ここは indexOf で素直に切り出す。
  const loadRankSrc = (() => {
    const start = src.indexOf('var loadRankSeq = 0;');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', src.indexOf('async function loadRank(){', start));
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end + 2);
  })();

  /** 2 本の loadRank を投げ、応答の到着順を指定して描画結果を観測する */
  async function raceRenders(arrival: Array<{ seq: number; coupons: unknown[] }>) {
    const rendered: unknown[][] = [];
    const resolvers: Array<(v: unknown) => void> = [];
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
      'fetch', 'API_BASE', 'idToken', 'showError', 'renderAll',
      loadRankSrc + '\nreturn loadRank;',
    ) as (...a: unknown[]) => () => Promise<void>;
    const loadRank = factory(
      () => new Promise((resolve) => { resolvers.push(resolve); }),
      '', '',
      () => {},
      (d: { coupons: unknown[] }) => rendered.push(d.coupons),
    );
    const p1 = loadRank(); // seq 1 (古い = 発行前)
    const p2 = loadRank(); // seq 2 (新しい)
    for (const step of arrival) {
      resolvers[step.seq - 1]({
        status: 200,
        json: async () => ({ success: true, data: { coupons: step.coupons } }),
      });
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all([p1, p2]);
    return rendered;
  }

  it('🚨 古い応答が後から着いても、新しい応答の描画を上書きしない', async () => {
    // これが無いと、いったん出た ¥300 が消えて「ありません」に戻る (= 直した嘘の再発)
    const rendered = await raceRenders([
      { seq: 2, coupons: [LINK_ROW] },
      { seq: 1, coupons: [] },
    ]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toEqual([LINK_ROW]);
  });

  it('最後に投げた応答は (古い応答が先に着いた場合でも) 反映される', async () => {
    const rendered = await raceRenders([
      { seq: 1, coupons: [] },
      { seq: 2, coupons: [LINK_ROW] },
    ]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toEqual([LINK_ROW]);
  });
});

// ============================================================
// 発行に失敗したときの復旧導線 (2026-08-28 Katsu 指示)
// ============================================================
// 画面では「発行中」と「発行失敗」を区別できない (証跡は audit_logs だけ)。
// 台帳が空のままなら「解除 → 再連携」で冪等チェックが空振りして再発行されるので、
// 打ち切り後はその手順へ案内する。ただし解除は会員ランク表示を失うため、
// ボタンは**既存の二段確認を開くだけ**にする。
describe('¥300 が届かなかったときの復旧導線', () => {
  it('打ち切り後の空状態に復旧の案内とボタンが出る', () => {
    const html = render([], { timedOut: true });
    expect(html).toContain('特典クーポンがまだ届いていません');
    expect(html).toContain('連携をやり直すと再発行されます');
    expect(html).toContain('連携をやり直す方法を見る');
    // LIFF ルール: onclick には**名前付き関数の呼び出しだけ**を書く (引用符ネスト禁止)
    expect(html).toContain('onclick="showRelinkHelp()"');
  });

  it('発行中・通常時には復旧導線を出さない (不安を煽らない)', () => {
    expect(render([], { pending: true })).not.toContain('連携をやり直す');
    expect(render([], {})).not.toContain('連携をやり直す');
    expect(render([LINK_ROW], {})).not.toContain('連携をやり直す');
  });

  it('🚨 showRelinkHelp は解除しない — 二段確認を開くだけ', () => {
    const fnSrc = (() => {
      const start = src.indexOf('function showRelinkHelp(){');
      expect(start).toBeGreaterThan(-1);
      const end = src.indexOf('\n}', start);
      return src.slice(start, end + 2);
    })();
    // 解除 API も解除関数も呼ばない
    expect(fnSrc).not.toContain('unlinkAccount');
    expect(fnSrc).not.toContain('/api/liff/link/unlink');

    const els: Record<string, { style: { display: string }; scrollIntoView?: () => void }> = {
      'unlink-open': { style: { display: 'block' } },
      'unlink-confirm': { style: { display: 'none' } },
      'link-card': { style: { display: 'block' }, scrollIntoView: () => { scrolled = true; } },
    };
    let scrolled = false;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function('document', fnSrc + '\nreturn showRelinkHelp;') as (
      d: unknown,
    ) => () => void;
    factory({ getElementById: (id: string) => els[id] ?? null })();

    expect(els['unlink-confirm'].style.display).toBe('block'); // 確認が開く
    expect(els['unlink-open'].style.display).toBe('none');     // トグルの整合
    expect(scrolled).toBe(true);                                // その場所まで運ぶ
  });
});
