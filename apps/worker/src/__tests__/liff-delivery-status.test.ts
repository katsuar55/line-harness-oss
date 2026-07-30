/**
 * ゼロクリック配送状況 (2026-07-30):
 * 「Shop」タブの 🚚 配送状況カードが、発送 (fulfillment 作成) 前でも
 * 最新注文の financial_status / fulfillment_status から進捗を表示することのガード。
 *
 * 背景: 銀行振込テスト注文で「現在配送中のお荷物はありません」から一切変化しなかった。
 *   旧実装は fulfillments (発送レコード) しか見ておらず、入金待ち/支払い済み/発送準備中の
 *   段階では何も出せなかった。Shopify へ遷移せずこの画面だけで状況が分かるようにする。
 *
 * inline template-literal のため source 静的検査 (既存 liff-* テストと同流儀)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

/** top-level function のブロックを抽出 (行頭 `}` で終端) */
function fnBlock(name: string): string {
  const m = pages.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  expect(m, name + ' が定義されている').not.toBeNull();
  return m![0];
}

describe('配送状況カード — 発送前の注文ステータス表示 (ゼロクリック)', () => {
  it('fulfillments が空でも latestOrder があれば注文ステータス hero を出す', () => {
    expect(pages).toContain('fres.data.latestOrder');
    expect(pages).toMatch(/else if \(fres\.data\.latestOrder\)/);
    expect(pages).toContain('renderOrderHero(fres.data.latestOrder)');
  });

  it('financial_status → 顧客向け表現: 銀行振込の入金待ちが最重要 (テスト注文で無反応だった障害の恒久対策)', () => {
    const b = fnBlock('orderStageInfo');
    expect(b).toContain('ご入金確認待ち'); // pending (銀行振込)
    expect(b).toContain('お支払い確認中'); // authorized / partially_paid
    expect(b).toContain('発送準備中'); // paid
    expect(b).toContain('発送済み'); // fulfillment_status=fulfilled (レコード欠損時の保険)
    expect(b).toContain('キャンセル・返金済み'); // refunded / voided
    expect(b).toMatch(/銀行振込/); // 入金待ちの説明文
  });

  it('進捗ステップは ご注文受付→お支払い→発送準備→お届け の4段', () => {
    const b = fnBlock('renderOrderHero');
    expect(b).toMatch(/'ご注文受付', 'お支払い', '発送準備', 'お届け'/);
  });

  it('動的値 (注文番号/商品名) は esc() でエスケープ (XSS ガード)', () => {
    const b = fnBlock('renderOrderHero');
    expect(b).toContain('esc(o.orderNumber)');
    expect(b).toMatch(/esc\(o\.lineItems\[0\]\.name/);
  });

  it('キャンセル・返金 (stage=-1) では進捗ステップを出さない', () => {
    const info = fnBlock('orderStageInfo');
    expect(info).toMatch(/stage: -1/);
    const hero = fnBlock('renderOrderHero');
    expect(hero).toMatch(/if \(info\.stage >= 0\)/);
  });
});

describe('配送状況カード — 発送後 (fulfillment) ステータスの日本語化 (既存仕様の固定)', () => {
  it('shipment_status/status の両語彙を日本語化 (delivered/out_for_delivery/in_transit/…)', () => {
    const b = fnBlock('fulfillStatusJa');
    expect(b).toContain("delivered: '配達完了'");
    expect(b).toContain("out_for_delivery: '配達中'");
    expect(b).toContain("in_transit: '配送中'");
    expect(b).toContain("ready_for_pickup: '受取可能'");
    expect(b).toContain("cancelled: 'キャンセル'");
  });
});
