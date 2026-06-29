/**
 * FAQ動的化 PR3 (2026-06-30): LIFF ポータル「その他」タブの FAQ を検索 + カテゴリ絞り込み対応にする。
 *
 * 背景: PR1/PR2 で faq_items を populate 済 (21件・7カテゴリ) なのに、ポータルFAQタブは
 *   フラットなアコーディオン一覧のみで、目的の質問に辿り着くのにスクロールが要った (操作性が低い)。
 *   検索ボックス + カテゴリ chip で「探す」体験を改善する。/api/liff/faq は既に category を返すため
 *   純 client-side 強化 (backend/migration 変更なし)。
 *
 * liff-pages.ts は inline template-literal の埋め込み HTML/JS なので source を静的検査する慣習に従う。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

describe('LIFF FAQ 検索 + カテゴリ (PR3)', () => {
  it('検索ボックス (#faq-search) が oninput で onFaqSearch を呼ぶ', () => {
    expect(pages).toContain('id="faq-search"');
    expect(pages).toContain('oninput="onFaqSearch(this.value)"');
    expect(pages).toContain('function onFaqSearch');
  });

  it('カテゴリ chip コンテナ (#faq-cats) と onFaqCat ハンドラがある', () => {
    expect(pages).toContain('id="faq-cats"');
    expect(pages).toContain('function onFaqCat');
    expect(pages).toContain('onclick="onFaqCat(');
  });

  it('renderFaqList が検索語を question と answer の両方に対して照合する', () => {
    expect(pages).toContain('function renderFaqList');
    expect(pages).toMatch(/\(f\.question \+ ' ' \+ f\.answer\)\.toLowerCase\(\)\.indexOf\(q\)/);
  });

  it('カテゴリ一致でも絞り込む (cat !== all のとき category 比較)', () => {
    expect(pages).toMatch(/st\.cat !== 'all' && \(f\.category \|\| 'general'\) !== st\.cat/);
  });

  it('カテゴリが実質1種類なら chip を非表示にする (ノイズ回避)', () => {
    expect(pages).toContain('function renderFaqCats');
    expect(pages).toMatch(/cats\.length <= 2/);
  });

  it('カテゴリキー→日本語ラベル map が seed のキーを網羅する', () => {
    expect(pages).toContain('function faqCategoryLabel');
    for (const key of ['usage', 'allergy', 'product', 'shipping', 'return', 'subscription', 'support']) {
      expect(pages).toContain(key + ':');
    }
  });

  it('XSS: question/answer/カテゴリラベルは esc() で描画する', () => {
    expect(pages).toMatch(/esc\(f\.question\)/);
    expect(pages).toMatch(/esc\(f\.answer\)/);
    expect(pages).toMatch(/esc\(faqCategoryLabel\(c\)\)/);
  });

  it('0件時の空状態 (#faq-empty) を持つ', () => {
    expect(pages).toContain('id="faq-empty"');
    expect(pages).toContain('該当するFAQが見つかりませんでした');
  });

  it('既存のアコーディオン toggleFaq は維持 (回帰防止)', () => {
    expect(pages).toContain('function toggleFaq');
    expect(pages).toContain('onclick="toggleFaq(');
  });
});
