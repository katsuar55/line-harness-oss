/**
 * Regression guard (2026-06-29 監査 PR-F・Katsu 承認): 月次配信 flex の商品コピーは
 * 非届出商品 Blue に作用断定「脂質カット(に特化)」を使わない。診断クイズ/welcome-postback と同様、
 * 対象者ベース「脂っこい食事が好きな方に」へ統一する。
 * (食事自体を指す「脂質が高め」「脂質高めの食事」は製品の作用断定ではないため対象外)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const services = join(dirname(fileURLToPath(import.meta.url)), '..', 'services');

describe('月次配信/クイズの薬機法コピー (脂質カット作用断定の除去)', () => {
  it.each([
    'monthly-broadcast-postback.ts',
    'quiz-engine.ts',
  ])('%s は「脂質カット」作用断定を含まない', (file) => {
    const src = readFileSync(join(services, file), 'utf8');
    expect(src).not.toContain('脂質カット');
  });
});
