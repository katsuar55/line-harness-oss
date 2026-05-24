/**
 * Tests for ai-message-builder.ts (Plan A-4、 2026-05-24)
 *
 * カバー範囲:
 *   - buildAiMessage: prefix hint / heuristics / flex fallback の分岐
 *   - buildAiFlexJson: 既存 markdown → flex 変換 (= regression 防止)
 */

import { describe, it, expect } from 'vitest';
import { buildAiMessage, buildAiFlexJson, __test__ } from '../services/ai-message-builder.js';

describe('ai-message-builder — buildAiMessage prefix hint', () => {
  it('strips [FMT:text] prefix and returns text Message', () => {
    const msg = buildAiMessage('[FMT:text]こんにちは😊 何かお手伝いできますか?');
    expect(msg.type).toBe('text');
    if (msg.type === 'text') {
      expect(msg.text).toBe('こんにちは😊 何かお手伝いできますか?');
      expect(msg.text).not.toContain('[FMT:text]');
    }
  });

  it('strips prefix even with leading whitespace', () => {
    const msg = buildAiMessage('  [FMT:text]\nありがとうございます');
    expect(msg.type).toBe('text');
    if (msg.type === 'text') {
      expect(msg.text).toBe('ありがとうございます');
    }
  });

  it('returns text Message when prefix is alone (= falls back to raw)', () => {
    const msg = buildAiMessage('[FMT:text]');
    expect(msg.type).toBe('text');
    if (msg.type === 'text') {
      expect(msg.text).toBe('[FMT:text]');
    }
  });
});

describe('ai-message-builder — buildAiMessage heuristics', () => {
  it('short greeting (< 50 chars, no structure) → text', () => {
    const msg = buildAiMessage('こんにちは！naturism公式LINEです😊');
    expect(msg.type).toBe('text');
  });

  it('short ack → text', () => {
    const msg = buildAiMessage('ありがとうございます🙏');
    expect(msg.type).toBe('text');
  });

  it('URL-centric short (< 200 chars, no structure) → text', () => {
    const msg = buildAiMessage('公式ストアはこちらです: https://naturism-diet.com');
    expect(msg.type).toBe('text');
  });

  it('URL with longer surrounding text but no structure → text (still < 200)', () => {
    const text = '詳細は公式サイトでご確認いただけます: https://naturism-diet.com/products/blue (24時間ご注文可能です)';
    expect(text.length).toBeLessThanOrEqual(200);
    const msg = buildAiMessage(text);
    expect(msg.type).toBe('text');
  });

  it('long text without structure (> 50 chars, no URL) → flex (= fallback)', () => {
    // 50 字超 + 構造なし + URL なし → flex fallback (= heuristics 漏れ)
    const text = '長いお返事をご準備していますが、 まだ準備中の機能ですので、 もう少々お待ちください。 公式サポートまでご連絡ください';
    expect(text.length).toBeGreaterThan(50);
    const msg = buildAiMessage(text);
    expect(msg.type).toBe('flex');
  });

  it('text with markdown ## heading → flex', () => {
    const text = '## 商品情報\nnaturism Blue は脂質カットに特化したエントリーモデルです';
    const msg = buildAiMessage(text);
    expect(msg.type).toBe('flex');
  });

  it('text with **label**: value structure → flex', () => {
    const text = '**価格**: ¥64/日\n**成分**: 8 成分';
    const msg = buildAiMessage(text);
    expect(msg.type).toBe('flex');
  });

  it('text with bullet * list → flex', () => {
    const text = '* Blue\n* Pink\n* Premium';
    const msg = buildAiMessage(text);
    expect(msg.type).toBe('flex');
  });

  it('text with 【見出し】 → flex', () => {
    const text = '【飲み方ガイド】🌿\n1回2〜3粒、 1日6〜9粒';
    const msg = buildAiMessage(text);
    expect(msg.type).toBe('flex');
  });
});

describe('ai-message-builder — buildAiMessage flex content', () => {
  it('flex Message contains altText and contents object', () => {
    const msg = buildAiMessage('## naturism\n**価格**: ¥64/日');
    expect(msg.type).toBe('flex');
    if (msg.type === 'flex') {
      expect(msg.altText).toBe('naturism AI 応答');
      expect(typeof msg.contents).toBe('object');
    }
  });
});

describe('ai-message-builder — buildAiFlexJson (regression)', () => {
  it('renders ## heading as green box', () => {
    const json = buildAiFlexJson('## 商品情報');
    const bubble = JSON.parse(json);
    expect(bubble.type).toBe('bubble');
    expect(bubble.body.contents[0].backgroundColor).toBe('#f0fdf4');
  });

  it('renders **label**: value as horizontal table row', () => {
    const json = buildAiFlexJson('**価格**: ¥64/日');
    const bubble = JSON.parse(json);
    const row = bubble.body.contents[0];
    expect(row.layout).toBe('horizontal');
    expect(row.contents[0].text).toBe('価格');
    expect(row.contents[1].text).toBe('¥64/日');
  });

  it('renders bullet * as ▸ prefix', () => {
    const json = buildAiFlexJson('* Blue は入門モデル');
    const bubble = JSON.parse(json);
    const row = bubble.body.contents[0];
    expect(row.contents[0].text).toBe('▸');
    expect(row.contents[1].text).toBe('Blue は入門モデル');
  });

  it('renders --- as separator', () => {
    const json = buildAiFlexJson('テキスト1\n---\nテキスト2');
    const bubble = JSON.parse(json);
    const hasSeparator = bubble.body.contents.some(
      (c: { type: string }) => c.type === 'separator',
    );
    expect(hasSeparator).toBe(true);
  });

  it('renders plain text as normal text node', () => {
    const json = buildAiFlexJson('普通のテキスト');
    const bubble = JSON.parse(json);
    expect(bubble.body.contents[0].type).toBe('text');
    expect(bubble.body.contents[0].text).toBe('普通のテキスト');
  });

  it('includes naturism header + email footer', () => {
    const json = buildAiFlexJson('テスト');
    const bubble = JSON.parse(json);
    expect(bubble.header.contents.some((c: { text?: string }) => c.text === 'naturism')).toBe(true);
    expect(bubble.footer.contents[0].contents.some((c: { text?: string }) => c.text === 'info@kenkoex.com')).toBe(true);
  });
});

describe('ai-message-builder — constants', () => {
  it('thresholds are reasonable', () => {
    expect(__test__.SHORT_TEXT_THRESHOLD).toBe(50);
    expect(__test__.URL_TEXT_THRESHOLD).toBe(200);
    expect(__test__.FMT_TEXT_PREFIX).toBe('[FMT:text]');
  });

  it('URL_REGEX detects http/https URLs', () => {
    expect(__test__.URL_REGEX.test('see https://example.com for more')).toBe(true);
    expect(__test__.URL_REGEX.test('plain text without url')).toBe(false);
  });
});
