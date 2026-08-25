/**
 * 🚨 `readLoyaltyRank` を **実スキーマ** で通し、会員証との shape 一致を固定する (2026-08-25)
 *
 * なぜ必要か:
 *   この PR の本丸は「ホームのランクの出どころを、DEPRECATED な friend_ranks から
 *   会員証 (/liff/my-rank) と同じ 1 本 (resolveFriendRank) へ付け替えた」こと。
 *   ところがそのサーバ側実装 `readLoyaltyRank` には**テストが 1 件も無かった** (採点ループ P1)。
 *
 *   実測された穴: portal-read.ts の `loyalty,` を `loyaltyRank: loyalty,` に変えるだけで
 *   client の `data.loyalty` が undefined になり全ユーザーが「ただいま確認中」に落ちるのに、
 *   関連 7 ファイル 138 テストが全部 pass した。client 側の fixture が**手書き**で、
 *   サーバ出力から作られていなかったため (= 本番 500 を 3 ヶ月隠した手 mock と同じ穴)。
 *
 * ここで固定するのは 2 つ:
 *   ① 実 SQLite に packages/db/schema.sql を流し、member_purchase_events から
 *      trailing-12ヶ月 SUM → ランク判定 → 進捗 が本当に通ること (列名・窓の実測)
 *   ② その出力が **会員証 GET /api/liff/my-rank の data.rank / trailing12moJpy / next /
 *      progressRatio と逐語で一致**すること。drift すると同じ顧客に 2 つの数字を見せる。
 */
import { describe, it, expect } from 'vitest';
import { readLoyaltyRank, readRank } from '../services/portal-read.js';
import { createSchemaDb, asD1, insertFriend } from './helpers/sqlite-d1.js';
import { NATURISM_RANK_DEFS, resolveFriendRank } from '@line-crm/db';
import type { SqliteDatabase } from './helpers/sqlite-d1.js';

const FRIEND = 'F_RANK';

// shopify_order_id は NOT NULL UNIQUE (= 冪等性 key)。実スキーマなので省略できない。
function purchase(db: SqliteDatabase, friendId: string, id: string, jpy: number, occurredAt: string): void {
  db.exec(
    `INSERT INTO member_purchase_events (id, shopify_order_id, friend_id, amount_jpy, occurred_at, applied_at, created_at)
     VALUES ('${id}', 'ord-${id}', '${friendId}', ${jpy}, '${occurredAt}', '${occurredAt}', '${occurredAt}')`,
  );
}

function setup(): { db: SqliteDatabase; deps: { db: D1Database }; user: { lineUserId: string; friendId: string } } {
  const db = createSchemaDb();
  insertFriend(db, FRIEND);
  return {
    db,
    deps: { db: asD1(db) },
    user: { lineUserId: 'U_RANK', friendId: FRIEND },
  };
}

describe('readLoyaltyRank — 実スキーマ (member_purchase_events)', () => {
  it('購入記録が無ければ regular / 0 円 / 次は bronze', async () => {
    const { deps, user } = setup();
    const out = await readLoyaltyRank(deps, user);
    expect(out).not.toBeNull();
    expect(out!.rank.id).toBe('regular');
    expect(out!.rank.discountPercent).toBe(0);
    expect(out!.trailing12moJpy).toBe(0);
    expect(out!.next).toEqual({ id: 'bronze', name: 'ブロンズ', remainingJpy: 1, discountPercent: 2 });
    expect(out!.progressRatio).toBe(0);
  });

  it('trailing-12ヶ月の SUM で判定する (列名・窓が実スキーマで通る)', async () => {
    const { db, deps, user } = setup();
    const now = new Date();
    const recent = new Date(now.getTime() - 30 * 86400_000).toISOString();
    purchase(db, FRIEND, 'e1', 9000, recent);
    purchase(db, FRIEND, 'e2', 4000, recent);
    const out = await readLoyaltyRank(deps, user);
    expect(out!.trailing12moJpy).toBe(13000);
    expect(out!.rank.id).toBe('silver'); // 12,000 以上
    expect(out!.rank.discountPercent).toBe(4);
    expect(out!.next!.id).toBe('gold');
    expect(out!.next!.remainingJpy).toBe(24000 - 13000);
  });

  it('🚨 12 ヶ月より古い購入は算入しない (窓が効いていることの実測)', async () => {
    const { db, deps, user } = setup();
    const old = new Date(Date.now() - 400 * 86400_000).toISOString();
    purchase(db, FRIEND, 'e_old', 50000, old);
    const out = await readLoyaltyRank(deps, user);
    expect(out!.trailing12moJpy).toBe(0);
    expect(out!.rank.id).toBe('regular');
  });

  it('🚨 applied_at が NULL の行は算入しない (未確定の購入でランクを上げない)', async () => {
    const { db, deps, user } = setup();
    const recent = new Date(Date.now() - 10 * 86400_000).toISOString();
    db.exec(
      `INSERT INTO member_purchase_events (id, shopify_order_id, friend_id, amount_jpy, occurred_at, applied_at, created_at)
       VALUES ('e_pending', 'ord-pending', '${FRIEND}', 30000, '${recent}', NULL, '${recent}')`,
    );
    const out = await readLoyaltyRank(deps, user);
    expect(out!.trailing12moJpy).toBe(0);
  });

  it('最高ランクでは next が null (「最高ランク」表示の唯一の根拠)', async () => {
    const { db, deps, user } = setup();
    const recent = new Date(Date.now() - 5 * 86400_000).toISOString();
    purchase(db, FRIEND, 'e_big', 60000, recent);
    const out = await readLoyaltyRank(deps, user);
    expect(out!.rank.id).toBe('platinum');
    expect(out!.next).toBeNull();
    expect(out!.progressRatio).toBe(1);
  });

  it('DB が落ちても null を返してホーム全体は描く (会員証と同じ作法)', async () => {
    const broken = {
      prepare: () => {
        throw new Error('D1_ERROR: down');
      },
    } as unknown as D1Database;
    const out = await readLoyaltyRank({ db: broken }, { lineUserId: 'U', friendId: FRIEND });
    expect(out).toBeNull();
  });
});

describe('readLoyaltyRank — 会員証 (/api/liff/my-rank) との shape 一致', () => {
  it('🚨 rank / trailing12moJpy / next / progressRatio が逐語で一致する (drift = 同じ顧客に 2 つの数字)', async () => {
    const { db, deps, user } = setup();
    const recent = new Date(Date.now() - 20 * 86400_000).toISOString();
    purchase(db, FRIEND, 'e1', 26000, recent);

    const home = await readLoyaltyRank(deps, user);

    // 会員証 (liff-my-rank.ts) が data を組み立てるのと同じ手順を、同じ入力で再現する
    const resolved = await resolveFriendRank(asD1(db), FRIEND, NATURISM_RANK_DEFS);
    const p = resolved.progress;
    const myRank = {
      rank: {
        id: resolved.rank.id,
        name: resolved.rank.name,
        discountPercent: resolved.rank.discountPercent,
        badgeEmoji: resolved.rank.badgeEmoji ?? null,
        badgeColor: resolved.rank.badgeColor ?? null,
        badgeImageUrl: resolved.rank.badgeImageUrl ?? null,
      },
      trailing12moJpy: resolved.trailing12moJpy,
      next: p.next
        ? {
            id: p.next.id,
            name: p.next.name,
            remainingJpy: p.remainingToNextJpy,
            discountPercent: p.next.discountPercent,
          }
        : null,
      progressRatio: p.progressRatio,
    };

    expect(home).toEqual(myRank);
    // 実データであることの確認 (両方 null / 両方 0 で「一致」を名乗らない)
    expect(home!.rank.id).toBe('gold');
    expect(home!.trailing12moJpy).toBe(26000);
  });

  it('🚨 readRank は loyalty という名前で載せる (client が読むのはこの 1 語)', async () => {
    // mutation 実測: `loyalty,` を `loyaltyRank: loyalty,` に変えても、client 側の
    // fixture が手書きなので bootstrap テストは緑のまま = 全ユーザーが「ただいま確認中」に
    // 落ちるのに誰も気付かない。サーバ側の出力そのものを観測点にして塞ぐ。
    const { db, deps, user } = setup();
    const recent = new Date(Date.now() - 15 * 86400_000).toISOString();
    purchase(db, FRIEND, 'e1', 13000, recent);

    const rank = (await readRank(deps, user)) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(rank, 'loyalty'), 'readRank に loyalty が無い').toBe(true);
    expect(rank.loyalty).toEqual(await readLoyaltyRank(deps, user));
    // 中身が本物であること (null 同士で「一致」を名乗らない)
    expect((rank.loyalty as { rank: { id: string } }).rank.id).toBe('silver');
  });

  it('メダル画像 URL は公開配信できる形で返る (ホームが 76px で表示する唯一の材料)', async () => {
    const { deps, user } = setup();
    const out = await readLoyaltyRank(deps, user);
    expect(out!.rank.badgeImageUrl).toMatch(/^\/images\/rank-[a-z]+-v2\.png$/);
  });
});
