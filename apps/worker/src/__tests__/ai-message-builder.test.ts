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

  it('marker のみ (本文なし) は raw を返さず fallback — marker を顧客に見せない (review 2026-07-07)', () => {
    const msg = buildAiMessage('[FMT:text]');
    expect(msg.type).toBe('text');
    if (msg.type === 'text') {
      expect(msg.text).not.toContain('[FMT');
      expect(msg.text.length).toBeGreaterThan(0); // LINE は空 text を送れない
    }
  });
});

describe('ai-message-builder — mangled/typo marker tolerance (2026-06-28 実測 [FMAT:text])', () => {
  it('[FMAT:text] (LLM typo, 50字超) → marker を strip し本文のみ。 顧客に marker が漏れない', () => {
    const raw = '[FMAT:text] ナチュリズムは毎食時にお飲みいただくのがおすすめです🌿 カロリーが気になるお食事の際に飲むと良いでしょう😊 詳しくはパッケージをご確認ください📝';
    const msg = buildAiMessage(raw);
    if (msg.type === 'text') {
      expect(msg.text).not.toContain('FMAT');
      expect(msg.text).not.toContain('[FMT');
      expect(msg.text.startsWith('ナチュリズム')).toBe(true);
    } else if (msg.type === 'flex') {
      // flex に落ちても marker が altText/contents に漏れないこと
      expect(JSON.stringify(msg)).not.toContain('FMAT');
      expect(JSON.stringify(msg)).not.toContain('[FMT');
    }
  });

  it('[FORMAT:text] 変形 prefix も strip', () => {
    const msg = buildAiMessage('[FORMAT:text]こんにちは😊 ご質問ありがとうございます');
    expect(msg.type).toBe('text');
    if (msg.type === 'text') {
      expect(msg.text).toBe('こんにちは😊 ご質問ありがとうございます');
      expect(msg.text).not.toContain('FORMAT');
    }
  });

  it('変形 marker でも keyword=price_table なら price table flex に route', () => {
    const msg = buildAiMessage('[FMAT:price_table]3商品の価格です💰');
    expect(msg.type).toBe('flex');
  });

  it('変形 marker でも keyword=quiz_invite なら quiz invite flex に route', () => {
    const msg = buildAiMessage('[FMAT:quiz_invite]診断しますね💚');
    expect(msg.type).toBe('flex');
  });

  it('日本語の隅付き括弧は ASCII marker regex に誤検出されず本文が保持される', () => {
    // marker regex は [A-Za-z]{2,8}:[a-z_]{2,20} の ASCII のみ対象 → 【】 にマッチしない。
    // (type は既存 structure heuristic で flex になりうるが、 本文が strip されないことを検証)
    const msg = buildAiMessage('【お知らせ】本日のおすすめはこちらです😊');
    expect(JSON.stringify(msg)).toContain('お知らせ');
  });
});

describe('ai-message-builder — 日本語変形 marker tolerance (2026-07-04 実機で「[フォーマ…text]」露出)', () => {
  it('[フォーマット:text] (日本語 prefix) → strip して本文のみ、顧客に marker が漏れない', () => {
    const msg = buildAiMessage('[フォーマット:text]こんにちは😊 何かお手伝いできますか?');
    expect(msg.type).toBe('text');
    if (msg.type === 'text') {
      expect(msg.text).toBe('こんにちは😊 何かお手伝いできますか?');
      expect(msg.text).not.toContain('フォーマット');
    }
  });

  it('[フォーマット：text] (全角コロン) も strip', () => {
    const msg = buildAiMessage('[フォーマット：text]公式ストアはこちらです: https://naturism-diet.com');
    expect(JSON.stringify(msg)).not.toContain('フォーマット');
    expect(JSON.stringify(msg)).toContain('naturism-diet.com');
  });

  it('［フォーマット：text］ (全角括弧) も strip', () => {
    const msg = buildAiMessage('［フォーマット：text］ありがとうございます🙏');
    expect(JSON.stringify(msg)).not.toContain('フォーマット');
    expect(JSON.stringify(msg)).toContain('ありがとうございます');
  });

  it('[形式:quiz_invite] → quiz invite flex に route', () => {
    const msg = buildAiMessage('[形式:quiz_invite]診断しますね💚');
    expect(msg.type).toBe('flex');
  });

  it('[フォーマット:price_table] → price table flex に route', () => {
    const msg = buildAiMessage('[フォーマット:price_table]3商品の価格です💰');
    expect(msg.type).toBe('flex');
  });

  it('誤 strip 防止: keyword が既知 3 種以外の日本語括弧は本文保持 (例 [お得:sale])', () => {
    const msg = buildAiMessage('[お得:sale]本日のセール情報です😊');
    expect(JSON.stringify(msg)).toContain('[お得:sale]');
  });

  it('誤 strip 防止: コロンなし日本語括弧 [重要] は本文保持', () => {
    const msg = buildAiMessage('[重要]配送日変更のお知らせです');
    expect(JSON.stringify(msg)).toContain('[重要]');
  });

  it('marker のみ (本文なし) の変形 marker も顧客に露出しない ([FMAT:text] / [フォーマット:text])', () => {
    for (const raw of ['[FMAT:text]', '[フォーマット:text]', '［フォーマット：text］']) {
      const msg = buildAiMessage(raw);
      expect(msg.type, raw).toBe('text');
      if (msg.type === 'text') {
        expect(msg.text, raw).not.toContain('text]');
        expect(msg.text, raw).not.toContain('フォーマット');
        expect(msg.text.length, raw).toBeGreaterThan(0);
      }
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

// Plan A-6 (2026-05-24): 価格比較表 flex
describe('ai-message-builder — buildPriceTableMessage ([FMT:price_table])', () => {
  it('[FMT:price_table] prefix returns price table flex Message', () => {
    const msg = buildAiMessage('[FMT:price_table]naturism 3 種類の価格です💰');
    expect(msg.type).toBe('flex');
    if (msg.type === 'flex') {
      expect(msg.altText).toBe('💰 価格一覧 (税込)');
      expect(msg.contents).toMatchObject({ type: 'bubble' });
    }
  });

  it('price table flex contains all 3 products with correct prices', () => {
    const msg = buildAiMessage('[FMT:price_table]');
    expect(msg.type).toBe('flex');
    if (msg.type === 'flex') {
      const json = JSON.stringify(msg.contents);
      // 商品名 + 価格 が全て含まれる
      expect(json).toContain('Blue');
      expect(json).toContain('Pink');
      expect(json).toContain('Premium');
      expect(json).toContain('¥2,376'); // Blue 個包装
      expect(json).toContain('¥6,415'); // Blue VP
      expect(json).toContain('¥64'); // Blue 1日
      expect(json).toContain('¥2,830'); // Pink 個包装
      expect(json).toContain('¥7,538'); // Pink VP
      expect(json).toContain('¥75'); // Pink 1日
      expect(json).toContain('¥3,564'); // Premium 個包装
      expect(json).toContain('¥14,904'); // Premium VP
      expect(json).toContain('¥149'); // Premium 1日
    }
  });

  it('price table includes 送料無料 note + 公式ストア button', () => {
    const msg = buildAiMessage('[FMT:price_table]');
    expect(msg.type).toBe('flex');
    if (msg.type === 'flex') {
      const json = JSON.stringify(msg.contents);
      expect(json).toContain('5,500'); // 送料無料閾値
      expect(json).toContain('送料無料');
      expect(json).toContain('naturism-diet.com'); // 公式ストア button URL
    }
  });

  it('PRICE_ROWS export contains exactly 3 rows', () => {
    expect(__test__.PRICE_ROWS).toHaveLength(3);
    expect(__test__.PRICE_ROWS[0].name).toBe('Blue');
    expect(__test__.PRICE_ROWS[1].name).toBe('Pink');
    expect(__test__.PRICE_ROWS[2].name).toBe('Premium');
  });

  it('PRICE_ROWS use brand color #0ABAB5 for Blue (= Plan B integration)', () => {
    expect(__test__.PRICE_ROWS[0].color).toBe('#0ABAB5'); // ティファニーブルー
  });

  it('FMT_PRICE_TABLE_PREFIX constant is exported correctly', () => {
    expect(__test__.FMT_PRICE_TABLE_PREFIX).toBe('[FMT:price_table]');
  });

  it('prefix priority: [FMT:quiz_invite] is checked BEFORE [FMT:price_table]', () => {
    // (= 同時 prefix は想定外だが、 quiz_invite が先 = AI 「おすすめ」 intent 優先)
    const msg = buildAiMessage('[FMT:quiz_invite][FMT:price_table]両方');
    expect(msg.type).toBe('flex');
    if (msg.type === 'flex') {
      // quiz_invite が優先された場合 altText が異なる
      expect(msg.altText).toContain('診断');
    }
  });
});
