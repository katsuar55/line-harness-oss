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

  it('対象者ベースの安全表現になっている (liff-pages の Blue desc = 本サイト9問版と同一コピー)', () => {
    const src = readFileSync(FILES[0], 'utf8');
    // 2026-08-03: 本サイト側 (nx-lineup-v2.js) の食事シーン軸コピーと同一の対象者ベース表現
    expect(src).toContain('脂っこい食事や外食が多いあなたには');
  });

  // 2026-08-03 (本サイト c74415e ミラー): 症状に配点して一般食品(Blue/Pink)を推奨する構造は
  // 医薬品的効能効果の示唆に当たるため、診断系ソースから症状語を排除した状態を固定する。
  // (体調記録日記の「お通じ」等セルフトラッキングUIは推奨に繋がらないため対象外 = 語を限定)
  it.each(FILES)('%s は症状語(便秘/胃もたれ/肌のハリ)に配点しない', (file) => {
    const src = readFileSync(file, 'utf8');
    for (const word of ['便秘', '胃もたれ', '肌のハリ']) {
      expect(src).not.toContain(word);
    }
  });

  // 診断サービス側2ファイルは日記UIを含まないため、より広い症状語彙で固定できる
  // (liff-pages.ts は体調記録日記に「お通じ」等の自己記録ラベルがあるため対象外)
  it.each([FILES[1], FILES[2]])('%s は広義の症状語(お通じ/お腹が張る/快調/消化/整腸)も含まない', (file) => {
    const src = readFileSync(file, 'utf8');
    for (const word of ['お通じ', 'お腹が張る', '快調', '消化', '整腸']) {
      expect(src).not.toContain(word);
    }
  });
});
