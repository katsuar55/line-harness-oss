/**
 * L-2 (2026-11-19): 公式サイトの30秒診断の結果を、ミニアプリで受け取って表示する。
 * 約束: 表示だけ。サーバーへ送らない・保存しない (GATE-3 の前)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

function fnBlock(name: string): string {
  const m = pages.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n\\}'));
  expect(m, name + ' が定義されている').not.toBeNull();
  return m![0];
}

/** inline JS の関数を取り出して、最小のスタブで実際に動かす */
function loadReceiver(search: string) {
  const replaced: string[] = [];
  const rendered: Array<{ rec: string; scores: Record<string, number>; fromSite: boolean }> = [];
  const styles: Record<string, { display: string }> = {
    'quiz-intro': { display: 'block' },
    'quiz-steps': { display: 'none' },
  };
  const window = { location: { search, href: 'https://example.com/liff/portal' + search } };
  const document = { getElementById: (id: string) => ({ style: (styles[id] ??= { display: '' }) }) };
  const src = [
    "var QUIZ_TYPES = ['blue', 'pink', 'premium'];",
    fnBlock('quizSiteScore'),
    fnBlock('showQuizResultFromSite'),
    'return showQuizResultFromSite();',
  ].join('\n');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(
    'window', 'document', 'URLSearchParams', 'URL', 'navReplaceUrl', 'clearQuizState', 'renderQuizResult',
    src,
  );
  const ok = run(
    window, document, URLSearchParams, URL,
    (u: string) => replaced.push(u),
    () => {},
    (rec: string, scores: Record<string, number>, fromSite: boolean) => rendered.push({ rec, scores, fromSite }),
  ) as boolean;
  return { ok, replaced, rendered, styles };
}

describe('サイトの診断結果を受け取る (showQuizResultFromSite)', () => {
  it('正しい結果なら、受け取った点数で結果画面を出し、受け取りの印 (fromSite) を付ける', () => {
    const r = loadReceiver('?page=quiz&qr=pink&qb=3&qp=7&qm=1');
    expect(r.ok).toBe(true);
    expect(r.rendered).toEqual([{ rec: 'pink', scores: { blue: 3, pink: 7, premium: 1 }, fromSite: true }]);
    expect(r.styles['quiz-intro'].display).toBe('none');
  });

  it('読んだ値は URL から落とす (page など他の値は残す)', () => {
    const r = loadReceiver('?page=quiz&qr=blue&qb=5&qp=2&qm=1');
    expect(r.replaced).toHaveLength(1);
    expect(r.replaced[0]).toBe('/liff/portal?page=quiz');
  });

  it('知らないタイプ・無しなら何もしない (通常の診断画面のまま)', () => {
    expect(loadReceiver('?page=quiz&qr=gold').ok).toBe(false);
    expect(loadReceiver('?page=quiz').ok).toBe(false);
    expect(loadReceiver('?page=quiz&qr=%3Cscript%3E').rendered).toHaveLength(0);
  });

  it('点数は 0〜99 の整数だけ。範囲外・文字は 0 にする', () => {
    const r = loadReceiver('?qr=premium&qb=-1&qp=abc&qm=500');
    expect(r.rendered[0].scores).toEqual({ blue: 0, pink: 0, premium: 0 });
  });

  it('🚨 表示だけ: サーバーへの送信 (api / quiz/submit / fetch) を含まない', () => {
    for (const fn of ['showQuizResultFromSite', 'renderQuizResult', 'quizSiteScore']) {
      const b = fnBlock(fn);
      expect(b, fn).not.toMatch(/api\(|quiz\/submit|fetch\(|sendBeacon/);
    }
  });

  it('自分で診断したときだけ保存する (finishQuiz に submit が残る)', () => {
    expect(fnBlock('finishQuiz')).toContain("api('/api/liff/quiz/submit'");
  });

  it('deep link が quiz のときに受け取りを試す・受け取りの一言と計測の印がある', () => {
    expect(fnBlock('handleDeepLink')).toContain("if (target === 'quiz') { try { showQuizResultFromSite(); }");
    expect(pages).toContain('id="quiz-result-from-site"');
    expect(fnBlock('renderQuizResult')).toContain("setAttribute('data-utm-campaign', 'quiz_site')");
  });

  it('inline JS にバックスラッシュとバッククォートを持ち込まない', () => {
    for (const fn of ['showQuizResultFromSite', 'renderQuizResult', 'quizSiteScore']) {
      const b = fnBlock(fn);
      expect(b, fn).not.toContain(String.fromCharCode(92));
      expect(b, fn).not.toContain('`');
    }
  });
});
