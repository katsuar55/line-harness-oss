/**
 * 連携フォームの入力正規化と「無反応ボタン」の恒久ガード (2026-08-31 Katsu 実機 FB)。
 *
 * ## なぜ要るか
 * 1. iOS の日本語キーボードは `＠` や `０-９` を**全角のまま**入れることがある。見た目は
 *    ほぼ同じなのに検証で弾かれるため、利用者には原因が分からず**行き止まり**になる。
 *    実機で「正しいメールアドレスをご入力ください」が繰り返し出て連携できなかった。
 * 2. `location.href` への代入は、**既に同じ URL に居ると何も起きない**(ハッシュ移動扱い)。
 *    「押しても無反応」というのは利用者から見て最悪の壊れ方で、報告もされにくい。
 * 3. 連携済みの表示はマイアカウントと会員証の両方にあるのに、**解除だけ会員証にしかなかった**。
 *
 * ## 観測点
 * 正規化は**実際に関数を走らせて**判定する (regex の目視では全角の扱いが分からない)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const myRank = readFileSync(join(root, '..', 'routes', 'liff-my-rank.ts'), 'utf8').replace(/\r\n/g, '\n');
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8').replace(/\r\n/g, '\n');

/** ソースから関数ブロックを切り出して実行できる形にする (ロジックを test 側で再実装しない) */
function grab(src: string, header: string): string {
  const start = src.indexOf(header);
  expect(start, header).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  expect(end, header).toBeGreaterThan(start);
  return src.slice(start, end + 2);
}

const toHalfWidthSrc = grab(myRank, 'function toHalfWidth(v){');
const normalizeEmailSrc = grab(myRank, 'function normalizeEmailInput(v){');

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const factory = new Function(
  `${toHalfWidthSrc}\n${normalizeEmailSrc}\nreturn { toHalfWidth: toHalfWidth, normalizeEmailInput: normalizeEmailInput };`,
) as () => { toHalfWidth: (v: unknown) => string; normalizeEmailInput: (v: unknown) => string };
const { toHalfWidth, normalizeEmailInput } = factory();

/** 実装と同じ検証式 (ここだけは形を写す — 通る/通らないの境界を固定するため) */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

describe('メールアドレスの入力正規化', () => {
  it('🚨 全角で入力されたメールを受け付ける (実機で詰まった本体)', () => {
    // ＠ が全角。半角に寄せないと EMAIL_RE を通らない
    const raw = 'katsu＠kenkoex.com';
    expect(EMAIL_RE.test(raw)).toBe(false); // 正規化しなければ弾かれることを先に固定
    expect(normalizeEmailInput(raw)).toBe('katsu@kenkoex.com');
    expect(EMAIL_RE.test(normalizeEmailInput(raw))).toBe(true);
  });

  it('全角英数字もすべて半角へ寄せる', () => {
    expect(normalizeEmailInput('ａｂｃ１２３＠ｅｘａｍｐｌｅ．ｃｏｍ')).toBe('abc123@example.com');
  });

  it('全角スペース (U+3000) を落とす', () => {
    expect(normalizeEmailInput('　a@b.com　')).toBe('a@b.com');
  });

  it('「名前 <a@b.com>」形式の貼り付けを受ける', () => {
    expect(normalizeEmailInput('カツ <katsu@kenkoex.com>')).toBe('katsu@kenkoex.com');
    expect(EMAIL_RE.test(normalizeEmailInput('カツ <katsu@kenkoex.com>'))).toBe(true);
  });

  it('普通の入力は変えない', () => {
    expect(normalizeEmailInput('katsu@kenkoex.com')).toBe('katsu@kenkoex.com');
  });

  it('null / undefined でも落ちない', () => {
    expect(normalizeEmailInput(null)).toBe('');
    expect(normalizeEmailInput(undefined)).toBe('');
  });
});

describe('確認コードの入力正規化', () => {
  /** 実装と同じ導出 (linkVerify の 1 行) */
  const norm = (v: unknown) => toHalfWidth(v).replace(/[^0-9]/g, '');

  it('🚨 全角数字の確認コードを受け付ける (メールを直しても次で詰む)', () => {
    expect(/^[0-9]{6}$/.test('１２３４５６')).toBe(false); // 正規化しなければ弾かれる
    expect(norm('１２３４５６')).toBe('123456');
  });

  it('空白やハイフン込みの貼り付けも受ける', () => {
    expect(norm('123 456')).toBe('123456');
    expect(norm('123-456')).toBe('123456');
  });

  it('数字でない入力は空になる (= 「6桁を入力してください」へ倒れる)', () => {
    expect(norm('abcdef')).toBe('');
  });
});

describe('正規化の配線 (実装が呼んでいること)', () => {
  const code = (t: string) => t.replace(/\/\/[^\n]*/g, '');

  it('linkRequest がメールを正規化し、結果を入力欄へ書き戻す', () => {
    const fn = code(grab(myRank, 'async function linkRequest(){'));
    expect(fn).toContain('normalizeEmailInput(emailEl && emailEl.value)');
    expect(fn).toContain('emailEl.value = email');
    // 例示つきの案内 (行き止まりにしない)
    expect(fn).toContain('例: name@example.com');
  });

  it('linkVerify がコードを正規化する', () => {
    const fn = code(grab(myRank, 'async function linkVerify(){'));
    expect(fn).toContain('toHalfWidth(codeEl && codeEl.value)');
    expect(fn).toContain("replace(/[^0-9]/g, '')");
  });
});

describe('「押しても無反応」を作らない', () => {
  const fn = grab(pages, 'function openAccountLinkCard() {');

  it('🚨 同じ URL に居るときは reload する (href 代入はハッシュ移動扱いで無反応)', () => {
    expect(fn).toContain('location.href === url');
    expect(fn).toContain('location.reload()');
  });

  it('例外が出ても相対 URL で必ず遷移を試みる', () => {
    expect(fn).toContain("url = '/liff/my-rank#link'");
  });

  it('遷移しなかったら押せるリンクを出す (無言の行き止まりにしない)', () => {
    expect(fn).toContain('showLinkNavFallback');
    expect(pages).toContain('function showLinkNavFallback(url) {');
    const fb = grab(pages, 'function showLinkNavFallback(url) {');
    expect(fb).toContain("createElement('a')");
    expect(fb).toContain('a.href = url');
  });
});

describe('マイアカウントからも連携を解除できる', () => {
  it('🚨 連携済みカードに解除の入口がある (会員証にしか無いと利用者が迷う)', () => {
    // markShopifyLinked が組み立てる連携済みカードに、会員証へ送るボタンが在ること
    const i = pages.indexOf("title.textContent = '✅ オンラインストアと連携済み'");
    expect(i).toBeGreaterThan(-1);
    const block = pages.slice(i, i + 1600);
    expect(block).toContain('連携の設定・解除');
    expect(block).toContain("addEventListener('click', openAccountLinkCard)");
  });
});
