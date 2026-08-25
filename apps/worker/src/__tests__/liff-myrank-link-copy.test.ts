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
describe('連携カード文言の backfill gate 連動', () => {
  it('タイトル/説明とも d.memberBackfillOn で分岐する', () => {
    const m = src.match(/function renderLink\(d\)\{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    const fn = m![0];
    // 分岐が存在し、on 側だけが過去反映を約束する
    expect(fn).toContain('d.memberBackfillOn');
    expect(fn).toContain('これまでのお買い物をランクに反映');
    expect(fn).toContain('お買い物アカウントと連携');
    expect(fn).toContain('これまでの購入履歴を会員ランクに反映します');
    expect(fn).toContain('お客様のご注文アカウントとこのLINEを連携します');
    // off 側の説明にも「メルマガとは別」の区別が残る (分岐で落とすと不安が再発する)
    const offBody = fn.split('お客様のご注文アカウントとこのLINEを連携します')[1] ?? '';
    expect(offBody).toContain('メールマガジンの配信登録とは別');
  });

  it('demo データは memberBackfillOn: true (デモは全機能 on の見た目)', () => {
    expect(src).toMatch(/memberBackfillOn: true/);
  });
});

// ─── #link 着地 (ホーム/マイアカウントの「メールで連携する」から) ───
describe('#link 着地の受け (連携カードへスクロール + 強調)', () => {
  it("renderLink が location.hash==='#link' で連携カードへスクロールし .link-focus を付ける", () => {
    const m = src.match(/function renderLink\(d\)\{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    const fn = m![0];
    expect(fn).toContain("location.hash==='#link'");
    expect(fn).toContain('scrollIntoView');
    expect(fn).toContain("classList.add('link-focus')");
    // 1 回だけ (再 render で毎回スクロールし直さない)
    expect(fn).toContain('window.__linkFocusDone');
    // reduced-motion では smooth を落とす
    expect(fn).toContain('prefers-reduced-motion');
  });

  it('.link-focus の CSS が定義されている (静的リング = reduced-motion でも成立)', () => {
    expect(src).toMatch(/\.link-focus\{box-shadow:/);
  });
});
