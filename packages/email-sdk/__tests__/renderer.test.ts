/**
 * Tests for EmailRenderer (Round 4 PR-1).
 */

import { describe, it, expect } from 'vitest';
import { EmailRenderer } from '../src/renderer.js';

const baseOptions = {
  unsubscribeBaseUrl: 'https://naturism-line-crm.example/email/unsubscribe',
  unsubscribeHmacKey: 'test-hmac-secret',
  legalFooterHtml:
    '<p style="font-size:11px;color:#666;">株式会社ケンコーエクスプレス<br>東京都〇〇区〇〇 1-2-3</p>',
  legalFooterText: '株式会社ケンコーエクスプレス\n東京都〇〇区〇〇 1-2-3',
};

describe('EmailRenderer', () => {
  it('必須オプション欠如時は throw', () => {
    expect(
      () =>
        new EmailRenderer({
          unsubscribeBaseUrl: '',
          unsubscribeHmacKey: 'k',
          legalFooterHtml: 'h',
          legalFooterText: 't',
        }),
    ).toThrow('unsubscribeBaseUrl');
    expect(
      () =>
        new EmailRenderer({
          unsubscribeBaseUrl: 'https://x',
          unsubscribeHmacKey: 'k',
          legalFooterHtml: '',
          legalFooterText: 't',
        }),
    ).toThrow('legalFooterHtml');
  });

  it('変数置換が動作 ({{name}}, {{order}})', async () => {
    const r = new EmailRenderer(baseOptions);
    const out = await r.render({
      subjectTemplate: '{{name}} 様、ご注文 #{{order}}',
      htmlTemplate: '<p>こんにちは {{name}} 様</p>',
      textTemplate: 'こんにちは {{name}} 様',
      variables: { name: '田中', order: '12345' },
      subscriberId: 'sub-1',
      category: 'transactional',
    });
    expect(out.subject).toBe('田中 様、ご注文 #12345');
    expect(out.html).toContain('こんにちは 田中 様');
    expect(out.text).toContain('こんにちは 田中 様');
  });

  it('未定義変数は空文字に置換される', async () => {
    const r = new EmailRenderer(baseOptions);
    const out = await r.render({
      subjectTemplate: '{{undefined_var}}テスト',
      htmlTemplate: '<p>{{missing}}本文</p>',
      textTemplate: '本文',
      variables: {},
      subscriberId: 'sub-1',
      category: 'transactional',
    });
    expect(out.subject).toBe('テスト');
    expect(out.html).toContain('<p>本文</p>');
  });

  it('marketing カテゴリは配信停止リンクを HTML/text に必ず注入', async () => {
    const r = new EmailRenderer(baseOptions);
    const out = await r.render({
      subjectTemplate: '春のお知らせ',
      htmlTemplate: '<p>本文</p>',
      textTemplate: '本文',
      variables: {},
      subscriberId: 'sub-marketing',
      category: 'marketing',
    });
    expect(out.html).toContain('配信停止は <a href="');
    expect(out.html).toContain('id=sub-marketing');
    expect(out.html).toContain('token=');
    expect(out.text).toContain('配信停止: ');
    expect(out.unsubscribeUrl).toContain('id=sub-marketing');
  });

  it('transactional カテゴリは配信停止リンクを HTML/text に注入しない', async () => {
    const r = new EmailRenderer(baseOptions);
    const out = await r.render({
      subjectTemplate: 'ご注文確認',
      htmlTemplate: '<p>ありがとうございます</p>',
      textTemplate: 'ありがとうございます',
      variables: {},
      subscriberId: 'sub-trans',
      category: 'transactional',
    });
    expect(out.html).not.toContain('配信停止は');
    expect(out.text).not.toContain('配信停止:');
    // ただし unsubscribeUrl は List-Unsubscribe ヘッダ用に常に生成される
    expect(out.unsubscribeUrl).toContain('id=sub-trans');
  });

  it('法定フッターが HTML / text 両方に注入される', async () => {
    const r = new EmailRenderer(baseOptions);
    const out = await r.render({
      subjectTemplate: 'X',
      htmlTemplate: '<p>本文</p>',
      textTemplate: '本文',
      variables: {},
      subscriberId: 'sub-1',
      category: 'transactional',
    });
    expect(out.html).toContain('株式会社ケンコーエクスプレス');
    expect(out.html).toContain('東京都〇〇区〇〇 1-2-3');
    expect(out.text).toContain('株式会社ケンコーエクスプレス');
    expect(out.text).toContain('東京都〇〇区〇〇 1-2-3');
  });

  it('preheader を指定すると HTML 冒頭に hidden div が挿入される', async () => {
    const r = new EmailRenderer(baseOptions);
    const out = await r.render({
      subjectTemplate: 'X',
      htmlTemplate: '<p>main</p>',
      textTemplate: 'main',
      preheader: 'preview text here',
      variables: {},
      subscriberId: 'sub-1',
      category: 'marketing',
    });
    expect(out.html).toContain('preview text here');
    expect(out.html).toContain('display:none');
  });

  it('同じ subscriberId なら HMAC token が再現性ある (決定論的)', async () => {
    const r = new EmailRenderer(baseOptions);
    const out1 = await r.render({
      subjectTemplate: 'X',
      htmlTemplate: '<p>1</p>',
      textTemplate: '1',
      variables: {},
      subscriberId: 'sub-stable',
      category: 'marketing',
    });
    const out2 = await r.render({
      subjectTemplate: 'Y',
      htmlTemplate: '<p>2</p>',
      textTemplate: '2',
      variables: {},
      subscriberId: 'sub-stable',
      category: 'marketing',
    });
    expect(out1.unsubscribeUrl).toBe(out2.unsubscribeUrl);
  });

  it('異なる subscriberId は異なる token を生成する', async () => {
    const r = new EmailRenderer(baseOptions);
    const a = await r.render({
      subjectTemplate: 'X',
      htmlTemplate: '<p>x</p>',
      textTemplate: 'x',
      variables: {},
      subscriberId: 'sub-A',
      category: 'marketing',
    });
    const b = await r.render({
      subjectTemplate: 'Y',
      htmlTemplate: '<p>y</p>',
      textTemplate: 'y',
      variables: {},
      subscriberId: 'sub-B',
      category: 'marketing',
    });
    expect(a.unsubscribeUrl).not.toBe(b.unsubscribeUrl);
  });
});
