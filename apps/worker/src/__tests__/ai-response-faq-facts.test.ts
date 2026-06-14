/**
 * #10-2 (2026-06-12): AI system prompt の運用系ファクト (配送/返品/定期/営業時間) を
 * naturism-diet.com 公式ポリシーページ準拠に修正した regression test。
 *
 * 背景: 既存 prompt は「返品=8日以内未開封OK」「定期解約=7日前までに連絡」「発送=1〜3営業日」
 *   等、 公式ページ (返品=原則不可 / 解約=マイページ24h / 発送=平日12時まで当日) と矛盾する
 *   古い fact を含んでいた。 DMM 移行で顧客に誤回答する launch blocker のため pin する。
 *
 * 出典 (公式・最終改定 2026-05〜06):
 *   /policies/shipping-policy /policies/refund-policy /policies/subscription-policy /policies/legal-notice
 */

import { describe, it, expect } from 'vitest';
import { __test__ } from '../services/ai-response.js';

const prompt = __test__.buildSystemPrompt();

describe('ai-response prompt — esbuild 安全性', () => {
  it('template literal 内に backtick を含まない (= buildSystemPrompt の parse error 防止)', () => {
    // [[feedback_template_literal_backtick_trap]]
    expect(prompt.includes('`')).toBe(false);
  });
});

describe('ai-response prompt — 返品・返金 (公式準拠)', () => {
  it('お客様都合の返品は原則不可 (食品衛生) を明記', () => {
    expect(prompt).toContain('原則');
    expect(prompt).toMatch(/開封・未開封を問わず|食品衛生/);
  });

  it('全額返金保証は初回購入限定・対象3商品・14日以内', () => {
    expect(prompt).toContain('全額返金保証');
    expect(prompt).toContain('初回購入');
    expect(prompt).toContain('14日以内');
  });

  it('不良品・配送破損は10日以内 (旧: 8日以内 を修正)', () => {
    expect(prompt).toContain('10日以内');
  });

  it('旧・誤ファクト「8日以内・未開封品のみ受付」を含まない', () => {
    expect(prompt).not.toMatch(/8日以内.*未開封品のみ受付|未開封品のみ受付/);
  });
});

describe('ai-response prompt — 定期便 (公式準拠)', () => {
  it('マイページから24時間いつでも解約・スキップ・変更を明記', () => {
    expect(prompt).toMatch(/24時間いつでも|いつでも解約・スキップ・変更/);
  });

  it('最低継続回数の縛りなしを明記', () => {
    expect(prompt).toContain('最低継続回数の縛り');
  });

  it('出荷準備完了後は次回分から適用の締切を明記', () => {
    expect(prompt).toContain('出荷準備完了');
  });

  it('旧・誤ファクト「7日前までに連絡で解約」を含まない', () => {
    expect(prompt).not.toMatch(/7日前までに.*解約|7日前までにご連絡/);
  });
});

describe('ai-response prompt — 配送 (公式準拠)', () => {
  it('配送業者 (ヤマト運輸 / ゆうパケット) を明記', () => {
    expect(prompt).toContain('ヤマト運輸');
    expect(prompt).toContain('ゆうパケット');
  });

  it('平日12時まで当日発送 (旧: 1〜3営業日で発送 を修正)', () => {
    expect(prompt).toMatch(/12:00まで.*当日発送|平日12時まで.*当日発送/);
  });

  it('5,500円以上で送料無料を維持', () => {
    expect(prompt).toContain('5,500円');
    expect(prompt).toContain('送料無料');
  });

  it('旧・誤ファクト「1〜3営業日で発送」を含まない', () => {
    expect(prompt).not.toContain('1〜3営業日で発送');
  });
});

describe('ai-response prompt — 営業時間 (公式準拠)', () => {
  it('受付は平日10:00〜17:00、土日祝休み', () => {
    expect(prompt).toContain('平日10:00〜17:00');
    // 旧「日祝休み」(= 土曜営業の誤解) を土日祝に修正
    expect(prompt).not.toContain('日祝休み');
  });
});
