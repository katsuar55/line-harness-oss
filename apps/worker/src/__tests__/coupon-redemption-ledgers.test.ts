/**
 * クーポン redemption の**台帳横断**テスト (2026-08-13)。
 *
 * 背景: redemption 追跡は welcome (`line_friend_coupons`) にだけ実装されていて、
 * 紹介 (`line_referral_coupons`) と連携特典 (`line_link_coupons`) は
 * **使い切っても status='issued' のまま**だった。表示側は 3 台帳とも `status='issued'` で
 * 絞るので、使用済みのクーポンが「使えるふり」をして期限切れまで出続けていた。
 *
 * 🚨 このテストの最重要項目は「**紹介報酬が誤発火しないこと**」。
 * `redeemedFriendIds` は routes/shopify.ts で `processReferralRewardOnPurchase`
 * (= 紹介者に ¥500 の実クーポンを発行 + push) の起点に使われる。意味は厳密に
 * 「**紹介された人が welcome クーポンを使った**」であって、他台帳を混ぜると
 * 連携特典や紹介報酬を使っただけの人が報酬発火の条件を満たし、**実費の誤発行**になる。
 *
 * fake は **未知の SQL で throw する**。テーブル名を間違えた変異が
 * 「黙って matched:false」に化けて素通りするのを防ぐため
 * (既存 coupon-redemption.test.ts の fake は line_friend_coupons 決め打ちで、
 *  新台帳の SELECT が null に落ちるため**新台帳を測れない**)。
 */
import { describe, it, expect } from 'vitest';
import { processOrderCouponRedemption } from '../services/coupon-redemption.js';
import { COUPON_LEDGER_TABLES, COUPON_LEDGERS, redeemCouponByCode } from '@line-crm/db';

type Ledger = 'friend' | 'referral' | 'link';

interface Row {
  id: string;
  friend_id: string;
  line_account_id: string | null;
  coupon_code: string;
  redeemed_at: string | null;
  status: string;
}

/** 台帳を理解する fake。未知の SQL は throw する (= 測れていないことを緑にしない) */
class LedgerDb {
  rows: Record<Ledger, Row[]> = { friend: [], referral: [], link: [] };
  auditInserts: unknown[][] = [];
  /** この台帳の SELECT で D1 例外を模す */
  throwOnLedger: Ledger | null = null;
  /** 実際に発行された SQL (テーブル名の網羅確認用) */
  seenTables = new Set<string>();
  /** 実際に走った UPDATE の回数 (早期 return が効いているかの観測点) */
  updateCalls = 0;

  constructor(seed: Partial<Record<Ledger, Row[]>> = {}) {
    for (const l of ['friend', 'referral', 'link'] as Ledger[]) {
      this.rows[l] = seed[l] ?? [];
    }
  }

  private ledgerOf(sql: string): Ledger | null {
    for (const l of Object.keys(COUPON_LEDGER_TABLES) as Ledger[]) {
      if (sql.includes(COUPON_LEDGER_TABLES[l])) return l;
    }
    return null;
  }

  prepare(sql: string) {
    const isAuditInsert = sql.includes('INSERT INTO audit_logs');
    const isAuditReadback = sql.includes('FROM audit_logs') && sql.includes('WHERE id');
    const isSelect = sql.trimStart().startsWith('SELECT id, friend_id');
    const isUpdate = sql.trimStart().startsWith('UPDATE');
    const ledger = this.ledgerOf(sql);
    if (ledger) this.seenTables.add(COUPON_LEDGER_TABLES[ledger]);

    if (!isAuditInsert && !isAuditReadback && !ledger) {
      throw new Error(`LedgerDb: 未知の SQL (テーブル名を解決できない): ${sql.slice(0, 120)}`);
    }

    return {
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (isAuditReadback) return { id: String(params[0]) };
          if (isSelect && ledger) {
            if (this.throwOnLedger === ledger) throw new Error('transient D1 error');
            const code = String(params[0]).toUpperCase();
            const row = this.rows[ledger].find((r) => r.coupon_code.toUpperCase() === code);
            return row
              ? {
                  id: row.id,
                  friend_id: row.friend_id,
                  line_account_id: row.line_account_id,
                  redeemed_at: row.redeemed_at,
                  status: row.status,
                }
              : null;
          }
          throw new Error(`LedgerDb: 未知の first(): ${sql.slice(0, 120)}`);
        },
        run: async () => {
          if (isAuditInsert) {
            this.auditInserts.push(params);
            return { success: true, meta: { changes: 1 } };
          }
          if (isUpdate && ledger) {
            this.updateCalls += 1;
            // 🚨 述語を fake 側で**自前に再実装しない**。実装から `redeemed_at IS NULL` が
            //    消えても fake が代わりに守ってしまうと、CAS が壊れた変異が緑のまま通る
            //    (mutation R6 が SURVIVED した実原因)。SQL に述語が無ければ落とす。
            if (!/WHERE id = \? AND redeemed_at IS NULL/.test(sql)) {
              throw new Error(
                `LedgerDb: UPDATE から冪等述語 (redeemed_at IS NULL) が消えている — ` +
                  `並行受信で二重 redeem する: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`,
              );
            }
            const redeemedAt = params[0] as string;
            const id = params[2] as string;
            const row = this.rows[ledger].find((r) => r.id === id);
            if (!row || row.redeemed_at !== null) return { success: true, meta: { changes: 0 } };
            row.redeemed_at = redeemedAt;
            row.status = 'redeemed';
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`LedgerDb: 未知の run(): ${sql.slice(0, 120)}`);
        },
      }),
    };
  }
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 'r1',
  friend_id: 'f1',
  line_account_id: null,
  coupon_code: 'CODE-1',
  redeemed_at: null,
  status: 'issued',
  ...over,
});

function order(codes: string[]) {
  return {
    body: { id: 9, order_number: 1001, financial_status: 'paid', discount_codes: codes.map((code) => ({ code })) },
    shopifyOrderId: '9',
    topic: 'orders/create',
  };
}

const run = (db: LedgerDb, codes: string[]) =>
  processOrderCouponRedemption(db as unknown as D1Database, order(codes));

describe('redemption — 3 台帳すべてを追跡する', () => {
  it('連携特典クーポンが redeemed になり、台帳別の内訳に出る', async () => {
    const db = new LedgerDb({ link: [row({ id: 'L1', coupon_code: 'NLINK-ABCD2345', friend_id: 'fL' })] });
    const r = await run(db, ['NLINK-ABCD2345']);
    expect(r.byLedger.link).toEqual({ matched: 1, redeemed: 1 });
    expect(db.rows.link[0].status).toBe('redeemed');
    expect(db.rows.link[0].redeemed_at).not.toBeNull();
  });

  it('紹介クーポンが redeemed になる', async () => {
    const db = new LedgerDb({ referral: [row({ id: 'R1', coupon_code: 'NREF-11112222', friend_id: 'fR' })] });
    const r = await run(db, ['NREF-11112222']);
    expect(r.byLedger.referral).toEqual({ matched: 1, redeemed: 1 });
    expect(db.rows.referral[0].status).toBe('redeemed');
  });

  it('welcome クーポンは従来どおり redeemed になる (回帰)', async () => {
    const db = new LedgerDb({ friend: [row({ id: 'W1', coupon_code: 'LINE-ABCD2345', friend_id: 'fW' })] });
    const r = await run(db, ['LINE-ABCD2345']);
    expect(r.byLedger.friend).toEqual({ matched: 1, redeemed: 1 });
    expect(db.rows.friend[0].status).toBe('redeemed');
  });

  it('どの台帳にも無い code は no-op (誤って何かを redeemed にしない)', async () => {
    const db = new LedgerDb({
      friend: [row({ id: 'W1', coupon_code: 'LINE-AAAA1111' })],
      link: [row({ id: 'L1', coupon_code: 'NLINK-BBBB2222' })],
    });
    const r = await run(db, ['SOMETHING-ELSE']);
    expect(r.matched).toBe(0);
    expect(r.redeemed).toBe(0);
    expect(db.rows.friend[0].status).toBe('issued');
    expect(db.rows.link[0].status).toBe('issued');
  });

  it('3 台帳すべてに実際に問い合わせている (テーブル名の取りこぼしを検出)', async () => {
    const db = new LedgerDb();
    await run(db, ['ANY-CODE']);
    for (const l of COUPON_LEDGERS) {
      expect(db.seenTables.has(COUPON_LEDGER_TABLES[l])).toBe(true);
    }
  });
});

describe('🚨redemption — 紹介報酬の誤発火を防ぐ (実費の誤発行)', () => {
  it('連携特典の redemption は redeemedFriendIds に入らない', async () => {
    const db = new LedgerDb({ link: [row({ id: 'L1', coupon_code: 'NLINK-ABCD2345', friend_id: 'fL' })] });
    const r = await run(db, ['NLINK-ABCD2345']);
    expect(r.byLedger.link.redeemed).toBe(1); // 確かに redeem はしている
    expect(r.redeemedFriendIds).toEqual([]); // なのに報酬の起点にはならない
  });

  it('紹介報酬クーポンの redemption も redeemedFriendIds に入らない (連鎖発火の防止)', async () => {
    const db = new LedgerDb({ referral: [row({ id: 'R1', coupon_code: 'NREF-11112222', friend_id: 'fR' })] });
    const r = await run(db, ['NREF-11112222']);
    expect(r.byLedger.referral.redeemed).toBe(1);
    expect(r.redeemedFriendIds).toEqual([]);
  });

  it('welcome の redemption **だけ** が redeemedFriendIds に入る', async () => {
    const db = new LedgerDb({
      friend: [row({ id: 'W1', coupon_code: 'LINE-AAAA1111', friend_id: 'fW' })],
      link: [row({ id: 'L1', coupon_code: 'NLINK-BBBB2222', friend_id: 'fL' })],
      referral: [row({ id: 'R1', coupon_code: 'NREF-CCCC3333', friend_id: 'fR' })],
    });
    const r = await run(db, ['LINE-AAAA1111', 'NLINK-BBBB2222', 'NREF-CCCC3333']);
    expect(r.redeemed).toBe(3); // 3 枚とも redeem された
    expect(r.redeemedFriendIds).toEqual(['fW']); // 報酬の起点は welcome の 1 人だけ
  });
});

describe('redemption — 冪等性と隔離', () => {
  it('同じ webhook を 2 回受けても二重に redeem しない (audit も 1 回だけ)', async () => {
    const db = new LedgerDb({ link: [row({ id: 'L1', coupon_code: 'NLINK-ABCD2345', friend_id: 'fL' })] });
    const first = await run(db, ['NLINK-ABCD2345']);
    const second = await run(db, ['NLINK-ABCD2345']);
    expect(first.byLedger.link).toEqual({ matched: 1, redeemed: 1 });
    // 2 回目は「一致はするが redeem はしない」
    expect(second.byLedger.link).toEqual({ matched: 1, redeemed: 0 });
    const linkAudits = db.auditInserts.filter((p) => p[5] === 'line_link_coupon.redeemed');
    expect(linkAudits.length).toBe(1);
  });

  // 🚨 mutation R5 が SURVIVED した穴: 既 redeemed の早期 return を外しても、
  //    UPDATE 側の述語が代わりに守るので**結果が同じ**になり検出できなかった。
  //    「UPDATE を撃たない」= 早期 return が効いていること自体を観測点にする。
  it('既に redeemed の行には UPDATE を撃たない (無駄な write を出さない)', async () => {
    const db = new LedgerDb({
      link: [row({ id: 'L1', coupon_code: 'NLINK-ABCD2345', friend_id: 'fL', redeemed_at: '2026-08-01T00:00:00.000Z', status: 'redeemed' })],
    });
    const r = await run(db, ['NLINK-ABCD2345']);
    expect(r.byLedger.link).toEqual({ matched: 1, redeemed: 0 });
    expect(db.updateCalls).toBe(0);
  });

  it('未使用の行には UPDATE を 1 回だけ撃つ (対照)', async () => {
    const db = new LedgerDb({ link: [row({ id: 'L1', coupon_code: 'NLINK-ABCD2345', friend_id: 'fL' })] });
    await run(db, ['NLINK-ABCD2345']);
    expect(db.updateCalls).toBe(1);
  });

  it('1 台帳の D1 例外が他台帳を止めない', async () => {
    const db = new LedgerDb({
      friend: [row({ id: 'W1', coupon_code: 'LINE-AAAA1111', friend_id: 'fW' })],
      link: [row({ id: 'L1', coupon_code: 'LINE-AAAA1111', friend_id: 'fL' })],
    });
    db.throwOnLedger = 'friend';
    const r = await run(db, ['LINE-AAAA1111']);
    expect(r.byLedger.friend).toEqual({ matched: 0, redeemed: 0 }); // 落ちた側は 0
    expect(r.byLedger.link).toEqual({ matched: 1, redeemed: 1 }); // 他台帳は生きている
  });

  it('audit の action は台帳ごとに分かれている (既存の welcome 名は変えない)', async () => {
    const db = new LedgerDb({
      friend: [row({ id: 'W1', coupon_code: 'LINE-AAAA1111', friend_id: 'fW' })],
      referral: [row({ id: 'R1', coupon_code: 'NREF-CCCC3333', friend_id: 'fR' })],
      link: [row({ id: 'L1', coupon_code: 'NLINK-BBBB2222', friend_id: 'fL' })],
    });
    await run(db, ['LINE-AAAA1111', 'NREF-CCCC3333', 'NLINK-BBBB2222']);
    const actions = db.auditInserts.map((p) => p[5]).sort();
    expect(actions).toEqual([
      'line_friend_coupon.redeemed',
      'line_link_coupon.redeemed',
      'line_referral_coupon.redeemed',
    ]);
  });
});

describe('redemption — テーブル名の解決は閉じた対応表からのみ', () => {
  it('未知の台帳名は throw する (任意文字列が SQL に流れない)', async () => {
    const db = new LedgerDb();
    await expect(
      redeemCouponByCode(
        db as unknown as D1Database,
        'line_friend_coupons; DROP TABLE friends' as never,
        'CODE-1',
        new Date().toISOString(),
      ),
    ).rejects.toThrow(/unknown ledger/);
  });

  it('対応表が 3 台帳を漏れなく持っている', () => {
    expect(COUPON_LEDGERS.slice().sort()).toEqual(['friend', 'link', 'referral']);
    expect(COUPON_LEDGER_TABLES.friend).toBe('line_friend_coupons');
    expect(COUPON_LEDGER_TABLES.referral).toBe('line_referral_coupons');
    expect(COUPON_LEDGER_TABLES.link).toBe('line_link_coupons');
  });
});
