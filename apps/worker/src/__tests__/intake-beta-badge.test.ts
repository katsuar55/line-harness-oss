/**
 * 服用記録ボタンの beta バッジと、その破壊パターンの恒久ガード (2026-08-17)。
 *
 * 背景: `logIntake()` は送信中にボタン文言を「記録中...」へ差し替える。
 *   実装当初は `btn.textContent` を保存/復元していたため、ボタン内に子要素
 *   (beta バッジ) を置くと **初回タップで バッジ要素ごと消滅**し、復元時に
 *   ラベルとバッジが連結した素テキスト (「✨ 服用を記録する beta」) になった。
 *   textContent は HTML を落とすので、見た目の破壊が一度起きると元に戻らない。
 *
 * よってラベルを `#intake-btn-label` に分離し、logIntake はその span だけを触る。
 * 本テストは「バッジが出ていること」と「破壊パターンが復活していないこと」の両方を見る。
 * バッジの存在だけを見ると、textContent 復元に戻した変更を検出できない。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liffPages } from '../routes/liff-pages.js';

const baseEnv = {
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
  WORKER_URL: 'https://example.workers.dev',
};

async function portalHtml(): Promise<string> {
  const res = await liffPages.request('/liff/portal', {}, baseEnv as unknown as Record<string, unknown>);
  expect(res.status).toBe(200);
  return res.text();
}

// リポジトリ既存の作法に合わせる (friend-coupon.test.ts 等)。
// `new URL(...)` 経由は Workers 型と DOM 型の URL が衝突し typecheck だけが落ちる
// (vitest は通るので preflight まで気付けない)。
const root = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(root, '..', 'routes/liff-pages.ts'), 'utf8');

describe('服用記録ボタンの beta バッジ', () => {
  it('配信 HTML にラベル span と beta バッジが両方出ている', async () => {
    const html = await portalHtml();

    expect(html).toContain('id="intake-btn-label"');
    // バッジ本体 (ラベルの外側にある独立要素であること)
    const btn = /<button[^>]*id="intake-btn"[\s\S]*?<\/button>/.exec(html);
    expect(btn, '#intake-btn が見つからない').not.toBeNull();
    expect(btn![0]).toContain('beta');
    expect(btn![0]).toContain('id="intake-btn-label"');
    expect(btn![0]).toContain('✨ 服用を記録する');
  });

  it('ラベルとバッジは別要素 (バッジがラベル span の中に入っていない)', async () => {
    const html = await portalHtml();
    const labelSpan = /<span id="intake-btn-label">([\s\S]*?)<\/span>/.exec(html);
    expect(labelSpan, 'ラベル span が見つからない').not.toBeNull();
    // ラベル span の中身は文言のみ。ここに beta が入っていると textContent 差し替えで消える。
    expect(labelSpan![1]).not.toContain('beta');
    expect(labelSpan![1].trim()).toBe('✨ 服用を記録する');
  });

  it('logIntake がボタン全体の textContent を書き換えていない (破壊パターンの再発防止)', () => {
    const fn = /async function logIntake\(\)[\s\S]*?\n\}/.exec(SOURCE);
    expect(fn, 'logIntake が見つからない').not.toBeNull();
    const body = fn![0];

    // 破壊パターン: ボタン要素そのものの textContent へ代入する
    expect(body).not.toMatch(/\bbtn\.textContent\s*=/);
    // 正しい形: 分離したラベル要素だけを触る
    expect(body).toMatch(/\blabel\.textContent\s*=/);
    expect(body).toContain('intake-btn-label');
  });

  it('送信中の文言差し替えと復元が、ラベル要素だけを対象にしている', () => {
    const fn = /async function logIntake\(\)[\s\S]*?\n\}/.exec(SOURCE)![0];
    // 「記録中...」への差し替えと origLabel への復元が、どちらも label 経由であること
    expect(fn).toMatch(/label\.textContent\s*=\s*'記録中\.\.\.'/);
    expect(fn).toMatch(/label\.textContent\s*=\s*origLabel/);
    // 退避元も label (btn から取ると子要素のテキストまで拾って復元時に連結する)
    expect(fn).toMatch(/origLabel\s*=\s*label\.textContent/);
  });
});
