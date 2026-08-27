/**
 * 採点 Round3 myrank_link (verified 68) — 連携カードの「なぜメール?」文言 (2026-07-07)
 *
 * Katsu の混乱の根本 = 「なぜメールアドレスを入れるのか」が説明されていないこと。
 *   - タイトルを顧客利益ベースに (Shopifyアカウントと連携 → これまでのお買い物をランクに反映)
 *   - 因果を明記: 注文時メールで本人確認 → 購入履歴を会員ランクに反映
 *   - opt-in (メールマガジン配信登録) とは別機能である区別を明記 (配信は増えない)
 *   - メール形式チェックをサーバ往復前に実施
 *   - OTP 確認ボタンのラベルで「何が起きるか」を明示
 *   - 「別のメールアドレスで送り直す」の視認性/タップターゲット改善
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(root, '..', 'routes', 'liff-my-rank.ts'), 'utf8');

describe('連携カード文言 (なぜメール? の因果明示)', () => {
  it('タイトルは顧客利益ベース', () => {
    expect(src).toContain('これまでのお買い物をランクに反映');
    expect(src).not.toContain('>Shopifyアカウントと連携<');
  });

  it('説明文に「注文時メールで本人確認 → 購入履歴をランクへ」の因果がある', () => {
    expect(src).toMatch(/ご注文時に使ったメールアドレス[\s\S]{0,80}本人確認/);
    expect(src).toMatch(/購入履歴を会員ランクに反映/);
  });

  it('opt-in (メルマガ登録) とは別機能である区別を明記', () => {
    expect(src).toMatch(/メールマガジンの配信登録とは別/);
    expect(src).toMatch(/メールが届くようになることはありません/);
  });

  it('input placeholder/aria-label が「ご注文時のメールアドレス」', () => {
    expect(src).toContain('placeholder="ご注文時のメールアドレス"');
    expect(src).toContain('aria-label="ご注文時のメールアドレス"');
  });
});

describe('連携フォーム UX', () => {
  it('メール形式チェックをサーバ往復前に実施', () => {
    const m = src.match(/async function linkRequest\(\)\{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/test\(email\)/);
    expect(m![0]).toContain('正しいメールアドレスをご入力ください');
  });

  it('OTP 確認ボタンのラベルが「何が起きるか」を明示', () => {
    expect(src).toContain('メールアドレスを確認して連携');
  });

  it('「別のメールアドレスで送り直す」は bordered style + py-3 (発見性/タップターゲット)', () => {
    expect(src).toMatch(/link-restart[^>]*py-3[^>]*rounded-xl[^>]*style="background:#f8fafc;border:1px solid #e2e8f0"/);
    expect(src).not.toMatch(/link-restart[^>]*text-gray-400/);
  });
});

// ─── backfill gate 連動の文言 (2026-08-26) ───
// MEMBER_BACKFILL_ENABLED off では連携しても過去分が 1 円も反映されないため、
// 「これまでの購入履歴を反映」は memberBackfillOn のときだけ書く。
//
// 🚨 検証は**実行ベース** (採点ループ MED: 文字列 contains だけだと「両アームの文字列は
// 残っているが ternary のアームが入れ替わっている」= gate off で過去反映を約束する嘘、が
// 全緑で通る)。renderLink を実際に走らせ、合成後の innerHTML を観測する。
interface FakeCard {
  style: Record<string, string>;
  className: string;
  innerHTML: string;
  classListAdds: string[];
  scrolled: boolean;
  classList: { add: (c: string) => void };
  scrollIntoView: () => void;
}

function runRenderLink(
  d: Record<string, unknown>,
  opts: { hash?: string; win?: Record<string, unknown> } = {},
): { card: FakeCard; win: Record<string, unknown> } {
  const m = src.match(/function renderLink\(d\)\{[\s\S]*?\n\}/);
  expect(m).not.toBeNull();
  // renderLink は既連携時に renderUnlink を呼ぶ (2026-08-28)。
  // 抽出しないと ReferenceError になるので、同じ sandbox に両方を載せる。
  const mu = src.match(/function renderUnlink\(card\)\{[\s\S]*?\n\}/);
  expect(mu).not.toBeNull();
  const card: FakeCard = {
    style: {},
    className: '',
    innerHTML: '',
    classListAdds: [],
    scrolled: false,
    classList: { add(c: string) { card.classListAdds.push(c); } },
    scrollIntoView() { card.scrolled = true; },
  };
  const doc = { getElementById: (id: string) => (id === 'link-card' ? card : null) };
  const win = opts.win ?? {};
  const loc = { hash: opts.hash ?? '' };
  // setTimeout は即時実行 (= #link 着地のスクロールを同期的に観測する)
  const immediate = (fn: () => void) => { fn(); return 0; };
  new Function('document', 'window', 'location', 'setTimeout', 'd', mu![0] + '\n' + m![0] + '\nrenderLink(d);')(
    doc, win, loc, immediate, d,
  );
  return { card, win };
}

describe('連携カード文言の backfill gate 連動 (実行ベース)', () => {
  const base = { accountLinkEnabled: true, linked: false };

  it('memberBackfillOn=true → 過去反映を約束する文言', () => {
    const { card } = runRenderLink({ ...base, memberBackfillOn: true });
    expect(card.style.display).toBe('block');
    expect(card.innerHTML).toContain('これまでのお買い物をランクに反映');
    expect(card.innerHTML).toContain('これまでの購入履歴を会員ランクに反映します');
    expect(card.innerHTML).toContain('メールマガジンの配信登録とは別');
  });

  it('🚨memberBackfillOn=false → 過去反映の約束を 1 文字も出さない (アーム入替の嘘を殺す)', () => {
    const { card } = runRenderLink({ ...base, memberBackfillOn: false });
    expect(card.style.display).toBe('block');
    expect(card.innerHTML).toContain('お買い物アカウントと連携');
    expect(card.innerHTML).toContain('お客様のご注文アカウントとこのLINEを連携します');
    expect(card.innerHTML).not.toContain('これまでのお買い物をランクに反映');
    expect(card.innerHTML).not.toContain('購入履歴を会員ランクに反映');
    // off 側にも「メルマガとは別」の区別が残る (落とすと不安が再発する)
    expect(card.innerHTML).toContain('メールマガジンの配信登録とは別');
  });

  // 2026-08-28: 既連携は「非表示」から「解除カード」へ変わった (連携解除機能の追加)。
  // テストを弱めるのではなく、新しい契約を逐語で固定する。
  it('未連携 + 受付 gate off ではカードを出さない', () => {
    expect(runRenderLink({ accountLinkEnabled: false, linked: false }).card.style.display).toBe('none');
  });

  it('🚨 既連携なら解除カードを出す (受付 gate の on/off に依存しない)', () => {
    for (const gate of [true, false]) {
      const { card } = runRenderLink({ accountLinkEnabled: gate, linked: true });
      expect(card.style.display, 'gate=' + gate).toBe('block');
      expect(card.innerHTML).toContain('連携を解除する');
      // 連携フォームは出さない (解除画面に「連携する」が混ざらない)
      expect(card.innerHTML).not.toContain('確認コードを送信');
    }
  });

  it('解除は二段確認で、失うものを具体的に伝える', () => {
    const { card } = runRenderLink({ accountLinkEnabled: true, linked: true });
    // 一段目では確認ブロックが隠れている (実 markup は style="display:none;margin-top:10px")
    expect(card.innerHTML).toMatch(/id="unlink-confirm"[^>]*display:none/);
    // 何を失い、何が残るかを両方書く
    expect(card.innerHTML).toContain('会員ランクが表示されなくなります');
    expect(card.innerHTML).toContain('お手持ちのクーポンはそのままご利用いただけます');
    expect(card.innerHTML).toContain('あらためて連携していただくこともできます');
    // 「元に戻ります」と断定しない (復元は cron が数分かけて行うので即時ではない)
    expect(card.innerHTML).not.toContain('元に戻ります');
  });

  it('demo データは memberBackfillOn: true (デモは全機能 on の見た目)', () => {
    expect(src).toMatch(/memberBackfillOn: true/);
  });
});

// ─── #link 着地 (ホーム/マイアカウントの「メールで連携する」から) ───
describe('#link 着地の受け (連携カードへスクロール + 強調)', () => {
  it("#link で着地 → スクロール + .link-focus (実行ベース)", () => {
    const { card, win } = runRenderLink(
      { accountLinkEnabled: true, linked: false, memberBackfillOn: true },
      { hash: '#link' },
    );
    expect(card.scrolled).toBe(true);
    expect(card.classListAdds).toContain('link-focus');
    expect(win.__linkFocusDone).toBe(true);
  });

  it('hash 無し / 既に focus 済みならスクロールしない (再 render で毎回動かさない)', () => {
    const noHash = runRenderLink({ accountLinkEnabled: true, linked: false, memberBackfillOn: true });
    expect(noHash.card.scrolled).toBe(false);
    const done = runRenderLink(
      { accountLinkEnabled: true, linked: false, memberBackfillOn: true },
      { hash: '#link', win: { __linkFocusDone: true } },
    );
    expect(done.card.scrolled).toBe(false);
  });

  it('reduced-motion では smooth を落とす (ソース検証)', () => {
    const fn = src.match(/function renderLink\(d\)\{[\s\S]*?\n\}/)![0];
    expect(fn).toContain('prefers-reduced-motion');
  });

  it('.link-focus の CSS が定義されている (静的リング = reduced-motion でも成立)', () => {
    expect(src).toMatch(/\.link-focus\{box-shadow:/);
  });
});
