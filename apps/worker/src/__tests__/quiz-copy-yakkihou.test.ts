/**
 * Regression guard (2026-06-29 顧客導線監査 rank 9): 顧客向け診断クイズの商品コピーは
 * 非届出商品(Blue/Pink)に作用断定的表現を使わない。
 *
 * 「脂質カットに特化」は機能性表示食品でない Blue への作用断定で薬機法/景表法のグレーゾーン。
 * チーム自身 welcome-postback.ts では対象者ベース表現「脂っこい食事が好きな方に」を採用済。
 * 常時オープンな「診断」タブの最頻表示(Blue tie-break default)なので、対象者/主観ベースに統一する。
 * (機能性表示食品 Premium の届出表示は引用可・本ガード対象外)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const FILES = [
  join(root, '..', 'routes', 'liff-pages.ts'),
  join(root, '..', 'services', 'quiz-engine.ts'),
  join(root, '..', 'services', 'quick-quiz.ts'),
];

describe('診断クイズ 商品コピー 薬機法ガード (非届出商品の作用断定を禁止)', () => {
  it.each(FILES)('%s は「脂質カットに特化」を含まない (作用断定→対象者ベースへ)', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toContain('脂質カットに特化');
  });

  it('対象者ベースの安全表現に置換されている (liff-pages の Blue reason)', () => {
    const src = readFileSync(FILES[0], 'utf8');
    expect(src).toContain('脂っこい食事が好きな方の');
  });
});
