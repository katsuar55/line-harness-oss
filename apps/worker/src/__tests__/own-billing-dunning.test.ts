/**
 * own-billing-dunning (WI-4 step 3) — 設計書 §6.2 matrix / §10.3「matrix 6 クラス」の unit。
 *
 * 重点:
 *   - **網羅性**: Shopify の全 54 code が明示分類されている (未分類の混入を検出)
 *   - **F 倒し**: 未知 code / null / 空文字 は必ず F (自動アクションなし + 人間)
 *   - クラス別の遷移・通知・リトライ算術 (A の +3/+7/計3、B の deadline clamp)
 *   - 正規化 (webhook の小文字 snake / 記号ゆらぎ)
 */
import { describe, it, expect } from 'vitest';
import {
  BILLING_ERROR_CODES,
  SOFT_MAX_ATTEMPTS,
  addDaysJst,
  classifyErrorCode,
  decideDunning,
  normalizeErrorCode,
  type DunningClass,
} from '../services/own-billing-dunning.js';

const SCHEDULED = '2026-08-05';
const TODAY = '2026-08-05';

function decide(code: unknown, attempts = 0, todayJst = TODAY) {
  return decideDunning({
    rawErrorCode: code,
    currentAttempts: attempts,
    scheduledDateJst: SCHEDULED,
    todayJst,
  });
}

describe('normalizeErrorCode', () => {
  it('webhook の小文字 snake を GraphQL enum 綴りへ寄せる', () => {
    expect(normalizeErrorCode('expired_card')).toBe('EXPIRED_CARD');
    expect(normalizeErrorCode('  insufficient_funds  ')).toBe('INSUFFICIENT_FUNDS');
  });

  it('ハイフン・空白・連続記号を _ に畳む', () => {
    expect(normalizeErrorCode('do-not-honor')).toBe('DO_NOT_HONOR');
    expect(normalizeErrorCode('card declined')).toBe('CARD_DECLINED');
    expect(normalizeErrorCode('__EXPIRED__CARD__')).toBe('EXPIRED_CARD');
  });

  it('非文字列・空文字は null', () => {
    expect(normalizeErrorCode(null)).toBeNull();
    expect(normalizeErrorCode(undefined)).toBeNull();
    expect(normalizeErrorCode(42)).toBeNull();
    expect(normalizeErrorCode('   ')).toBeNull();
    expect(normalizeErrorCode('!!!')).toBeNull();
  });
});

describe('matrix の網羅性 (§6.2 / §11)', () => {
  it('Shopify の全 code が重複なく列挙されている', () => {
    expect(new Set(BILLING_ERROR_CODES).size).toBe(BILLING_ERROR_CODES.length);
    // 2026-07-24 に shopify.dev から取得した SubscriptionBillingAttemptErrorCode の値数。
    // Shopify が値を増減したらこのテストが落ちる = 再較正のトリガになる (意図的な固定)。
    expect(BILLING_ERROR_CODES.length).toBe(54);
  });

  it('全 code が分類済みで、F に落ちるのは意図した曖昧 code だけ', () => {
    const fallenToF = BILLING_ERROR_CODES.filter((c) => classifyErrorCode(c) === 'F');
    // 「意味が一意に定まらない」と判断した 3 つ以外が F に落ちていたら分類漏れ
    expect([...fallenToF].sort()).toEqual(
      ['GENERIC_ERROR', 'PAYPAL_ERROR_GENERAL', 'UNEXPECTED_ERROR'].sort(),
    );
  });

  it('6 クラスすべてに少なくとも 1 つの code が割り当たっている', () => {
    const seen = new Set<DunningClass>(BILLING_ERROR_CODES.map((c) => classifyErrorCode(c)));
    expect([...seen].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('未知 code / null は F に倒れる (fail-to-human)', () => {
    expect(classifyErrorCode('SOMETHING_NEW_FROM_SHOPIFY')).toBe('F');
    expect(classifyErrorCode(null)).toBe('F');
    expect(decide('SOMETHING_NEW_FROM_SHOPIFY').klass).toBe('F');
    expect(decide(null).klass).toBe('F');
  });
});

describe('クラス A: ソフトデクライン (+3日 / +7日 / 計3)', () => {
  it('初回失敗 = retry_wait +3日 + 初回通知', () => {
    const d = decide('INSUFFICIENT_FUNDS', 0);
    expect(d.klass).toBe('A');
    expect(d.dunningState).toBe('retry_wait');
    expect(d.nextRetryDate).toBe('2026-08-08');
    expect(d.notice).toBe('fail_notice');
    expect(d.pauseContract).toBe(false);
    expect(d.nextAttempts).toBe(1);
  });

  it('2 回目 = retry_wait +7日 だが通知しない (§6.2「初回+最終」)', () => {
    const d = decide('CARD_DECLINED', 1);
    expect(d.dunningState).toBe('retry_wait');
    expect(d.nextRetryDate).toBe('2026-08-12');
    expect(d.notice).toBeNull();
    expect(d.nextAttempts).toBe(2);
  });

  it('3 回目 = 使い切りで S5 (pause + exhausted) + 最終通知', () => {
    const d = decide('PROCESSING_ERROR', SOFT_MAX_ATTEMPTS - 1);
    expect(d.dunningState).toBe('exhausted');
    expect(d.pauseContract).toBe(true);
    expect(d.notice).toBe('fail_notice');
    expect(d.nextRetryDate).toBeNull();
    expect(d.nextAttempts).toBe(SOFT_MAX_ATTEMPTS);
  });

  it('リトライ列は I-6 (14日) の内側に収まる', () => {
    // scheduled から +3、さらに +7 = 最遅でも scheduled+10 日目に 3 回目が走る
    const first = decide('INSUFFICIENT_FUNDS', 0, SCHEDULED).nextRetryDate as string;
    const second = decide('INSUFFICIENT_FUNDS', 1, first).nextRetryDate as string;
    const ageDays =
      (Date.parse(`${second}T00:00:00Z`) - Date.parse(`${SCHEDULED}T00:00:00Z`)) / 86400_000;
    expect(ageDays).toBeLessThanOrEqual(14);
  });
});

describe('クラス B: カード無効 (await_card + deadline clamp)', () => {
  it('リトライせず await_card + 即日 card_request', () => {
    const d = decide('EXPIRED_CARD', 0);
    expect(d.klass).toBe('B');
    expect(d.dunningState).toBe('await_card');
    expect(d.nextRetryDate).toBeNull();
    expect(d.notice).toBe('card_request');
    expect(d.pauseContract).toBe(false);
  });

  it('deadline = 失敗+7日 (scheduled+13日 より早い側)', () => {
    const d = decide('INVALID_PAYMENT_METHOD', 0, '2026-08-05');
    expect(d.deadlineAt).toBe('2026-08-12T23:59:59+09:00');
  });

  it('deadline は scheduled+13日 で clamp される (I-6 内に収める)', () => {
    // 失敗が scheduled+10 日目 → 失敗+7 = scheduled+17 は I-6 を超えるので 13 に丸める
    const d = decide('EXPIRED_CARD', 0, '2026-08-15');
    expect(d.deadlineAt).toBe('2026-08-18T23:59:59+09:00');
  });

  it('clamp が過去日になる場合は当日に丸める (期限が過去にならない)', () => {
    const d = decide('EXPIRED_CARD', 0, '2026-08-25');
    expect(d.deadlineAt).toBe('2026-08-25T23:59:59+09:00');
  });

  it('3DS/認証系も B (off-session の再試行では回復しないため)', () => {
    for (const code of [
      'AUTHENTICATION_REQUIRED',
      'AUTHENTICATION_FAILED',
      'OFF_SESSION_REJECTED',
      'EXPIRED_BUYER_ACTION',
      'CONFIRMATION_REJECTED',
    ]) {
      expect(classifyErrorCode(code)).toBe('B');
    }
  });
});

describe('クラス C / D / E', () => {
  it('C (INVOICE_ALREADY_PAID) は success として reconcile + 突合 alert', () => {
    const d = decide('INVOICE_ALREADY_PAID', 2);
    expect(d.klass).toBe('C');
    expect(d.treatAsSuccess).toBe(true);
    expect(d.dunningState).toBe('none');
    expect(d.nextAttempts).toBe(0);
    expect(d.pauseContract).toBe(false);
    expect(d.alertOps).toBe(true);
  });

  it('D (店側起因) は顧客通知なし・pause なし・ops_hold', () => {
    const d = decide('INSUFFICIENT_INVENTORY', 0);
    expect(d.klass).toBe('D');
    expect(d.dunningState).toBe('ops_hold');
    expect(d.notice).toBeNull();
    expect(d.pauseContract).toBe(false);
    expect(d.alertOps).toBe(true);
  });

  it('E (ハードデクライン) は即 S5・リトライなし・中立通知', () => {
    const d = decide('FRAUD_SUSPECTED', 0);
    expect(d.klass).toBe('E');
    expect(d.dunningState).toBe('exhausted');
    expect(d.pauseContract).toBe(true);
    expect(d.nextRetryDate).toBeNull();
    expect(d.notice).toBe('fail_notice');
  });

  it('F (未知) は D と同じく自動アクションなし + 人間', () => {
    const d = decide('GENERIC_ERROR', 0);
    expect(d.dunningState).toBe('ops_hold');
    expect(d.notice).toBeNull();
    expect(d.pauseContract).toBe(false);
    expect(d.alertOps).toBe(true);
  });
});

describe('addDaysJst', () => {
  it('月境界・年境界を跨いでも正しい', () => {
    expect(addDaysJst('2026-08-30', 3)).toBe('2026-09-02');
    expect(addDaysJst('2026-12-30', 7)).toBe('2027-01-06');
    expect(addDaysJst('2028-02-28', 1)).toBe('2028-02-29'); // 閏年
  });
});
