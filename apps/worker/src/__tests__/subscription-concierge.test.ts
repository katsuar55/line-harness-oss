/**
 * サブスク・コンシェルジュ カードのテスト (WI-1)
 *
 * 対象: 未連携/契約なし/契約あり (推定あり・なし)/解約済み/一時停止/複数契約カルーセル、
 *       操作ガイドカード、締切表示、postback data 形式、誠実な失敗文言。
 */
import { describe, it, expect } from 'vitest';
import {
  buildSubscriptionMenuMessages,
  buildGuideMessages,
  buildConciergeErrorMessages,
  formatJpDate,
  MYPAGE_URL,
} from '../services/subscription-concierge.js';
import type { SubscriptionContractRow } from '@line-crm/db';

const LIFF = 'https://liff.line.me/xxxx';

function contract(overrides: Partial<SubscriptionContractRow> = {}): SubscriptionContractRow {
  return {
    contract_id: '100',
    shopify_customer_id: 'cust-1',
    plan_name: '[5％OFF定期便] 30日に1回配送（2回目からは5%OFF)',
    interval_days: 30,
    order_count: 2,
    last_order_id: 'ord-1',
    last_order_at: '2026-07-05T10:00:00+09:00',
    last_delivery_date: '2026-07-08',
    skip_count: 0,
    skip_count_at_last_order: 0,
    paused_at: null,
    cancelled_at: null,
    next_billing_estimate: '2026-08-04',
    estimate_source: 'derived',
    reminded_for_estimate: null,
    created_at: '2026-07-05 10:00:00',
    updated_at: '2026-07-05 10:00:00',
    ...overrides,
  };
}

/** contracts を返す fake db (getSubscriptionContractsByCustomerId の SQL だけ受ける) */
function dbWithContracts(rows: SubscriptionContractRow[]) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async all() {
              if (sql.includes('FROM subscription_contracts')) return { results: rows };
              throw new Error(`unsupported: ${sql}`);
            },
            async first() {
              throw new Error(`unsupported: ${sql}`);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const json = (m: unknown) => JSON.stringify(m);

describe('buildSubscriptionMenuMessages', () => {
  it('未連携 → メール登録導線 (LIFF #account) + マイページ直行の 2 択', async () => {
    const messages = await buildSubscriptionMenuMessages(
      dbWithContracts([]),
      { id: 'f1', display_name: 'x', shopify_customer_id: null },
      LIFF,
    );
    const s = json(messages);
    expect(s).toContain('メールアドレスの登録');
    expect(s).toContain(`${LIFF}#account`);
    expect(s).toContain(MYPAGE_URL);
  });

  it('連携済み・契約ゼロ → 定期便のご案内 (押し売りせず事実のみ)', async () => {
    const messages = await buildSubscriptionMenuMessages(
      dbWithContracts([]),
      { id: 'f1', display_name: 'x', shopify_customer_id: 'cust-1' },
      LIFF,
    );
    const s = json(messages);
    expect(s).toContain('ご契約中の定期便はありません');
    expect(s).toContain('定期便を見てみる');
  });

  it('契約 1 件 → 推定日「ごろ」+ 締切 + 3 操作ボタン (postback) + 商品変更リンク', async () => {
    const messages = await buildSubscriptionMenuMessages(
      dbWithContracts([contract()]),
      { id: 'f1', display_name: 'x', shopify_customer_id: 'cust-1' },
      LIFF,
    );
    const s = json(messages);
    expect(s).toContain('8月4日ごろ');
    expect(s).toContain('次回決済の3日前');
    expect(s).toContain('8月1日ごろまで'); // 締切 = 推定 - 3日
    expect(s).toContain('action=teiki_guide&op=skip&cid=100');
    expect(s).toContain('action=teiki_guide&op=date&cid=100');
    expect(s).toContain('action=teiki_guide&op=cancel_pause&cid=100');
    expect(s).toContain('商品・数量の変更');
    // 許可されていない操作 (周期変更) を案内しない
    expect(s).not.toContain('周期変更');
  });

  it('推定不能 (周期不明) → 日付をでっち上げずマイページ確認へ', async () => {
    const messages = await buildSubscriptionMenuMessages(
      dbWithContracts([contract({ next_billing_estimate: null, interval_days: null })]),
      { id: 'f1', display_name: 'x', shopify_customer_id: 'cust-1' },
      LIFF,
    );
    const s = json(messages);
    expect(s).toContain('マイページでご確認ください');
    expect(s).not.toContain('ごろ *');
  });

  it('解約済み → 操作 postback を出さない + 再訪導線', async () => {
    const messages = await buildSubscriptionMenuMessages(
      dbWithContracts([contract({ cancelled_at: '2026-07-10', next_billing_estimate: null })]),
      { id: 'f1', display_name: 'x', shopify_customer_id: 'cust-1' },
      LIFF,
    );
    const s = json(messages);
    expect(s).toContain('解約済み');
    expect(s).not.toContain('teiki_guide');
  });

  it('一時停止 → お支払い確認の文言 + マイページボタン', async () => {
    const messages = await buildSubscriptionMenuMessages(
      dbWithContracts([contract({ paused_at: '2026-07-12', next_billing_estimate: null })]),
      { id: 'f1', display_name: 'x', shopify_customer_id: 'cust-1' },
      LIFF,
    );
    const s = json(messages);
    expect(s).toContain('一時停止中');
    expect(s).toContain('お支払い');
    expect(s).not.toContain('teiki_guide');
  });

  it('複数契約 → カルーセル', async () => {
    const messages = await buildSubscriptionMenuMessages(
      dbWithContracts([contract(), contract({ contract_id: '200' })]),
      { id: 'f1', display_name: 'x', shopify_customer_id: 'cust-1' },
      LIFF,
    );
    const flex = messages[0] as { contents: { type: string; contents: unknown[] } };
    expect(flex.contents.type).toBe('carousel');
    expect(flex.contents.contents).toHaveLength(2);
  });
});

describe('buildGuideMessages', () => {
  it.each(['skip', 'date', 'cancel_pause'] as const)('%s ガイドは手順 + マイページボタン + 締切', (op) => {
    const s = json(buildGuideMessages(op, contract()));
    expect(s).toContain('マイページにログイン');
    expect(s).toContain(MYPAGE_URL);
    expect(s).toContain('次回決済の3日前');
  });

  it('解約ガイドは代替案を出しつつ解約導線を隠さない', () => {
    const s = json(buildGuideMessages('cancel_pause', contract()));
    expect(s).toContain('スキップ');
    expect(s).toContain('一時停止');
    expect(s).toContain('解約のお手続きもマイページからいつでも可能');
  });
});

describe('buildConciergeErrorMessages / formatJpDate', () => {
  it('失敗時は正直に謝りマイページへ (false-success 禁止)', () => {
    const s = json(buildConciergeErrorMessages());
    expect(s).toContain('申し訳ありません');
    expect(s).toContain(MYPAGE_URL);
  });

  it('formatJpDate', () => {
    expect(formatJpDate('2026-08-04')).toBe('8月4日');
    expect(formatJpDate('2026-12-31')).toBe('12月31日');
    expect(formatJpDate('garbage')).toBeNull();
    expect(formatJpDate(null)).toBeNull();
  });
});

describe('buildSubscriptionMenuMessages — 複数契約の上限 (採点R1)', () => {
  it('6件以上はカルーセル5 bubbleに切り詰める (先頭 = DB が返した順のアクティブ)', async () => {
    const rows = [
      contract({ contract_id: 'a1' }),
      contract({ contract_id: 'a2' }),
      contract({ contract_id: 'a3' }),
      contract({ contract_id: 'a4' }),
      contract({ contract_id: 'a5' }),
      contract({ contract_id: 'x6', cancelled_at: '2026-07-01', next_billing_estimate: null }),
    ];
    const messages = await buildSubscriptionMenuMessages(
      dbWithContracts(rows),
      { id: 'f1', display_name: 'x', shopify_customer_id: 'cust-1' },
      LIFF,
    );
    const flex = messages[0] as { contents: { type: string; contents: unknown[] } };
    expect(flex.contents.type).toBe('carousel');
    expect(flex.contents.contents).toHaveLength(5);
    const s = json(messages);
    expect(s).toContain('cid=a1');
    expect(s).not.toContain('x6');
  });
});
