/**
 * #10-2 (2026-06-12): seed-naturism-faq-v3.sql の内容を pin する test。
 *
 * 既存 auto_replies (送料/返品/返金/解約/営業時間) が公式ポリシーと矛盾する古いファクトを
 * 返していたため、 旧行を無効化 → 公式準拠で再 INSERT する seed。 本 test は seed が
 * (1) 旧行を無効化し (2) 公式準拠の正しい文面を含み (3) 旧・誤ファクトを含まない ことを保証する。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = resolve(here, '../../../../packages/db/seed-naturism-faq-v3.sql');
const sql = readFileSync(seedPath, 'utf8');

describe('seed-faq-v3 — 旧行の無効化', () => {
  it('運用系キーワードの旧行を is_active=0 で無効化する', () => {
    expect(sql).toMatch(/UPDATE auto_replies SET is_active = 0/);
    for (const kw of ['送料', '返品', '返金', '解約', '営業時間']) {
      expect(sql).toContain(`'${kw}'`);
    }
  });

  it('DELETE を使わない (= 本番破壊操作の回避)', () => {
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });
});

describe('seed-faq-v3 — 公式準拠の新ファクト', () => {
  it('返品: 原則お受けできない (食品) + 対象3商品 + 不良品10日以内', () => {
    expect(sql).toContain('原則お受けしておりません');
    expect(sql).toContain('対象3商品');
    expect(sql).toContain('プレミアム180粒');
    expect(sql).toContain('10日以内');
  });

  it('定期: マイページから24時間いつでも + 縛りなし + 出荷準備完了', () => {
    expect(sql).toContain('24時間いつでも');
    expect(sql).toContain('最低継続回数の縛りなし');
    expect(sql).toContain('出荷準備完了');
  });

  it('配送: ヤマト運輸 / ゆうパケット + 平日12:00まで当日発送', () => {
    expect(sql).toContain('ヤマト運輸');
    expect(sql).toContain('ゆうパケット');
    expect(sql).toContain('平日12:00までのご注文は原則当日発送');
  });

  it('営業時間: 平日10:00〜17:00', () => {
    expect(sql).toContain('平日 10:00〜17:00');
  });

  it('スキップ・休止・配送・発送・定期便 の新キーワードを追加', () => {
    // 定期 は「定期的に飲む」等の誤マッチ回避で 定期便 に絞る (review MEDIUM 反映)
    for (const kw of ['配送', '発送', '定期便', 'スキップ', '休止']) {
      expect(sql).toContain(`'${kw}', 'contains'`);
    }
  });
});

describe('seed-faq-v3 — 旧・誤ファクトの不在 (regression)', () => {
  it('「8日以内」「未開封品に限り返品」を含まない', () => {
    expect(sql).not.toContain('8日以内');
    expect(sql).not.toContain('未開封品に限り');
  });

  it('「10日前までにご連絡」(旧・誤った定期解約条件) を含まない', () => {
    expect(sql).not.toContain('10日前まで');
  });
});
