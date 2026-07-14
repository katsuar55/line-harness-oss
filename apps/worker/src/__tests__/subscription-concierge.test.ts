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
import { addDays } from '../services/subscription-contracts.js';

const LIFF = 'https://liff.line.me/xxxx';

// isStaleEstimate (実時計 Date.now 依存) と固定日付フィクスチャの結合は時限爆弾になる
// (採点R3: 固定 '2026-08-04' は 2026-08-05 から stale 化し CI が確定 red)。
// 推定日は「今日(JST)+21日」で動的生成し、期待文字列も同じ材料から計算する。
const TODAY_JST = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const FUTURE_ESTIMATE = addDays(TODAY_JST, 21);
const FUTURE_ESTIMATE_JP = formatJpDate(FUTURE_ESTIMATE) as string;
const FUTURE_DEADLINE_JP = formatJpDate(addDays(FUTURE_ESTIMATE, -3)) as string;

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
    next_billing_estimate: FUTURE_ESTIMATE,
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
  it('未連携 → アカウント連携導線 (LIFF #rank = 連携UIの実在ページ) + マイページ直行の 2 択', async () => {
    const messages = await buildSubscriptionMenuMessages(
      dbWithContracts([]),
      { id: 'f1', display_name: 'x', shopify_customer_id: null },
      LIFF,
    );
    const s = json(messages);
    expect(s).toContain('アカウント連携');
    // 連携フロー (email OTP) は /liff/my-rank 側にある。#account はメール配信設定のみで
    // 連携できない行き止まり (採点R2 HIGH) — 誘導先に連携UIが実在することを固定する
    expect(s).toContain(`${LIFF}#rank`);
    expect(s).not.toContain('#account');
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
    expect(s).toContain(`${FUTURE_ESTIMATE_JP}ごろ`);
    expect(s).toContain('次回決済の3日前');
    expect(s).toContain(`${FUTURE_DEADLINE_JP}ごろまで`); // 締切 = 推定 - 3日
    expect(s).toContain('action=teiki_guide&op=skip&cid=100');
    expect(s).toContain('action=teiki_guide&op=date&cid=100');
    expect(s).toContain('action=teiki_guide&op=cancel_pause&cid=100');
    expect(s).toContain('商品・数量の変更');
    // 許可されていない操作 (周期変更) を案内しない
    expect(s).not.toContain('周期変更');
  });

  it('stale 推定 (過去日) → 過去の日付・締切を出さず一般則へ (採点R2/R3 回帰テスト)', async () => {
    const messages = await buildSubscriptionMenuMessages(
      dbWithContracts([contract({ next_billing_estimate: '2020-01-01' })]),
      { id: 'f1', display_name: 'x', shopify_customer_id: 'cust-1' },
      LIFF,
    );
    const s = json(messages);
    expect(s).toContain('マイページでご確認ください');
    expect(s).not.toContain('1月1日ごろ');
    expect(s).not.toContain('12月29日'); // 締切 (推定-3日) も出さない
    expect(s).toContain('次回決済日の3日前まで受付');
    // ガイドカード側も同様に一般則へ落ちる
    const g = json(buildGuideMessages('skip', contract({ next_billing_estimate: '2020-01-01' })));
    expect(g).toContain('次回決済日の3日前まで受付');
    expect(g).not.toContain('1月1日');
  });

  it('推定が直近すぎて締切が過去 (今日〜2日後) → 「締め切られている可能性」に切替 (採点R3)', async () => {
    const messages = await buildSubscriptionMenuMessages(
      dbWithContracts([contract({ next_billing_estimate: addDays(TODAY_JST, 1) })]),
      { id: 'f1', display_name: 'x', shopify_customer_id: 'cust-1' },
      LIFF,
    );
    const s = json(messages);
    expect(s).toContain('締め切られている可能性');
    expect(s).not.toContain('ごろまで (次回決済の3日前)');
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
      contract({ contract_id: 'a6' }), // アクティブ6件目 = slice(0,5) で切り落とされる
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
    expect(s).toContain('cid=a5');
    // 6件目はアクティブ (= postback ボタンを持つはず) だが 5 件で切られる
    expect(s).not.toContain('cid=a6');
  });
});
