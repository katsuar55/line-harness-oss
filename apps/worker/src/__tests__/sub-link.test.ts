/**
 * サブスク連携獲得キット (magic-link) サービスのテスト (2026-07-24)
 *
 * 検証対象 (= security-critical な money-adjacent 経路):
 *   - gate: SUB_LINK_ENABLED != 'true' で generate/preview/redeem とも no-op (= 本番 dormant)
 *   - generate: customerIds 指定 / 自動選定 (onlyUnlinked) / 旧 unconsumed トークンの掃除 / link 形状
 *   - preview: invalid/expired/used/taken/already_self/ready (= 消費しない・PII を返さない)
 *   - redeem: single-use CAS / 冪等 (同一連携) / friend_conflict / taken / UNIQUE race での消費巻き戻し
 *
 * 実 D1 の CAS/UNIQUE 意味論を忠実に再現する in-memory fake を使う
 * (= consumed_at IS NULL の CAS、 friends.shopify_customer_id の UNIQUE partial index)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// 連携特典クーポン (Sprint A-1): redeem 成功 hook の発火だけを検証する (issuer 本体は
// link-reward-coupon-issuer.test.ts で網羅済)。route は静的 import のみ = dynamic import 干渉なし。
vi.mock('../services/link-reward-coupon-issuer.js', () => ({
  issueLinkRewardCoupon: vi.fn(async () => null),
}));
// 過去購入 backfill (2026-08-26): redeem 成功 hook の発火だけを検証する (backfill 本体は
// member-purchase-backfill.test.ts で網羅済)。token 取得も外部 I/O なので同様に固定する。
vi.mock('../services/member-purchase-backfill.js', () => ({
  backfillCustomerOrders: vi.fn(async () => ({
    skipped: false, scanned: 0, backfilled: 0, alreadyApplied: 0, errors: 0, totalJpy: 0, capped: false,
  })),
}));
vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'test-access-token'),
}));
// preview の監査 (2026-08-26): 呼び出しの有無と内容だけを検証する (insert 本体は audit-logger 側)。
vi.mock('../services/audit-logger.js', () => ({
  auditSystem: vi.fn(async () => {}),
}));

import {
  generateSubLinkBatch,
  previewSubLinkToken,
  redeemSubLinkToken,
  getSubLinkStatus,
  maskEmail,
} from '../services/sub-link.js';
import { subLink } from '../routes/sub-link.js';
import { issueLinkRewardCoupon } from '../services/link-reward-coupon-issuer.js';
import { backfillCustomerOrders } from '../services/member-purchase-backfill.js';
import { getShopifyAccessToken } from '../services/shopify-token.js';
import { auditSystem } from '../services/audit-logger.js';
import { toJstString } from '@line-crm/db';

const mockedIssueLinkReward = vi.mocked(issueLinkRewardCoupon);
const mockedBackfill = vi.mocked(backfillCustomerOrders);
const mockedGetToken = vi.mocked(getShopifyAccessToken);
const mockedAudit = vi.mocked(auditSystem);

/** waitUntil 内の fire-and-forget promise chain を settle させる (member-ingest テストと同じ作法)。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

// ============================================================
// in-memory D1 fake (= CAS/UNIQUE を忠実に enforce)
// ============================================================

interface TokenRow {
  token: string;
  shopify_customer_id: string;
  batch_id: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by_line_user_id: string | null;
  consumed_friend_id: string | null;
  created_at: string;
}
interface FriendRow {
  id: string;
  line_user_id: string;
  shopify_customer_id: string | null;
  is_following: number;
}
interface CustomerRow {
  shopify_customer_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  tags: string | null;
  /** 逆方向リンク (2026-07-29): redeem 成功時に backlink される */
  friend_id?: string | null;
}
interface Store {
  tokens: Map<string, TokenRow>;
  friends: Map<string, FriendRow>;
  customers: Map<string, CustomerRow>;
  /** UNIQUE race 再現: これらの friendId への link UPDATE を throw させる */
  throwOnLinkFor: Set<string>;
  /** CAS 敗者再現: consume CAS が常に changes:0 (= row は未消費で読めるのに消費に負ける) */
  forceConsumeLoss?: boolean;
  /** 並行 link 再現: consume 時に消費 friend の shopify_customer_id を cid にセット (= setFriend が敗ける) */
  linkOnConsume?: string;
}

function futureIso(days = 30): string {
  return toJstString(new Date(Date.now() + days * 86_400_000));
}
function pastIso(days = 1): string {
  return toJstString(new Date(Date.now() - days * 86_400_000));
}

function createDb(seed: Partial<Store> = {}): { db: D1Database; store: Store } {
  const store: Store = {
    tokens: seed.tokens ?? new Map(),
    friends: seed.friends ?? new Map(),
    customers: seed.customers ?? new Map(),
    throwOnLinkFor: seed.throwOnLinkFor ?? new Set(),
  };

  function norm(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
  }

  function exec(sqlRaw: string, args: unknown[], mode: 'first' | 'all' | 'run'): unknown {
    const sql = norm(sqlRaw);

    // ---- sub_link_tokens ----
    if (sql.startsWith('INSERT INTO sub_link_tokens')) {
      const [token, cid, batch, exp, created] = args as string[];
      store.tokens.set(token, {
        token,
        shopify_customer_id: cid,
        batch_id: batch,
        expires_at: exp,
        consumed_at: null,
        consumed_by_line_user_id: null,
        consumed_friend_id: null,
        created_at: created,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('SELECT * FROM sub_link_tokens WHERE token')) {
      return store.tokens.get(args[0] as string) ?? null;
    }
    if (sql.startsWith('UPDATE sub_link_tokens SET consumed_at = ?, consumed_by_line_user_id')) {
      // consume CAS: bind(now, lineUserId, friendId, token)
      const [now, lu, fid, token] = args as string[];
      if (store.forceConsumeLoss) return { meta: { changes: 0 } }; // CAS 敗者を強制
      const row = store.tokens.get(token);
      if (row && row.consumed_at === null) {
        row.consumed_at = now;
        row.consumed_by_line_user_id = lu;
        row.consumed_friend_id = fid;
        // 並行 link race: 消費と同時に別経路が friend を link した状況を再現
        if (store.linkOnConsume) {
          const f = store.friends.get(fid);
          if (f && f.shopify_customer_id === null) f.shopify_customer_id = store.linkOnConsume;
        }
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.startsWith('UPDATE sub_link_tokens SET consumed_at = NULL')) {
      // release: bind(token, friendId)
      const [token, fid] = args as string[];
      const row = store.tokens.get(token);
      if (row && row.consumed_friend_id === fid) {
        row.consumed_at = null;
        row.consumed_by_line_user_id = null;
        row.consumed_friend_id = null;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.startsWith('DELETE FROM sub_link_tokens WHERE shopify_customer_id')) {
      // 3 形態: 無限定 / batch 限定 (= ?) / batch 除外 (!= ?)。
      // 述語は SQL 文字列から導出する (JS 側で決め打ちすると SQL の退行を検出できない)。
      const scoped = sql.includes('AND batch_id = ?');
      const excluded = sql.includes('AND batch_id != ?');
      const requireUnconsumed = sql.includes('consumed_at IS NULL');
      const cid = args[0] as string;
      const batchId = scoped || excluded ? (args[1] as string) : null;
      let n = 0;
      for (const [k, v] of store.tokens) {
        if (v.shopify_customer_id !== cid) continue;
        if (requireUnconsumed && v.consumed_at !== null) continue;
        if (scoped && v.batch_id !== batchId) continue;
        if (excluded && v.batch_id === batchId) continue;
        store.tokens.delete(k);
        n++;
      }
      return { meta: { changes: n } };
    }
    if (sql.startsWith('SELECT COUNT(*) AS total') && sql.includes('FROM sub_link_tokens')) {
      const now = args[0] as string;
      let total = 0,
        consumed = 0,
        pending = 0,
        expired = 0;
      for (const v of store.tokens.values()) {
        total++;
        if (v.consumed_at !== null) consumed++;
        else if (v.expires_at > now) pending++;
        else expired++;
      }
      return { total, consumed, pending, expired };
    }

    // ---- friends ----
    if (sql.startsWith('SELECT * FROM friends WHERE id = ?')) {
      return store.friends.get(args[0] as string) ?? null;
    }
    if (sql.startsWith('SELECT * FROM friends WHERE shopify_customer_id = ?')) {
      const cid = args[0] as string;
      for (const f of store.friends.values()) if (f.shopify_customer_id === cid) return f;
      return null;
    }
    if (sql.startsWith('UPDATE friends SET shopify_customer_id = ?')) {
      // setFriendShopifyCustomerId CAS: bind(cid, now, friendId)
      const [cid, , fid] = args as string[];
      if (store.throwOnLinkFor.has(fid)) {
        throw new Error('D1_ERROR: UNIQUE constraint failed: idx_friends_shopify_customer_id');
      }
      const friend = store.friends.get(fid);
      if (!friend || friend.shopify_customer_id !== null) return { meta: { changes: 0 } };
      // UNIQUE partial index: 別 friend が同 customer を持っていれば throw
      for (const other of store.friends.values()) {
        if (other.id !== fid && other.shopify_customer_id === cid) {
          throw new Error('D1_ERROR: UNIQUE constraint failed: idx_friends_shopify_customer_id');
        }
      }
      friend.shopify_customer_id = cid;
      return { meta: { changes: 1 } };
    }

    // ---- shopify_customers ----
    if (sql.startsWith('UPDATE shopify_customers SET friend_id')) {
      // linkShopifyCustomerToFriend: bind(friendId, now, shopifyCustomerId)
      const [fid, , cid] = args as string[];
      const c = store.customers.get(cid);
      if (!c) return { meta: { changes: 0 } };
      c.friend_id = fid;
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('UPDATE shopify_orders SET friend_id')) {
      // 同 writer の第2文 (注文の後追い補完)。 本テストでは注文を持たないので no-op
      return { meta: { changes: 0 } };
    }
    if (sql.startsWith('SELECT tags, email FROM shopify_customers WHERE shopify_customer_id')) {
      const c = store.customers.get(args[0] as string);
      return c ? { tags: c.tags, email: c.email } : null;
    }
    if (sql.includes('FROM shopify_customers') && sql.includes('IN (')) {
      const ids = args as string[];
      return ids.map((id) => store.customers.get(id)).filter(Boolean);
    }
    if (sql.includes('FROM shopify_customers sc')) {
      // 自動選定: subscription 含み cancel 含まず email あり [+ onlyUnlinked]
      const onlyUnlinked = sql.includes('NOT EXISTS');
      const limit = args[args.length - 1] as number;
      const out: CustomerRow[] = [];
      for (const c of store.customers.values()) {
        if (!c.tags || !c.tags.includes('subscription') || c.tags.includes('cancel')) continue;
        if (!c.email) continue;
        if (onlyUnlinked) {
          // 実 SQL の NOT EXISTS は is_following を問わない (= ブロック/退会済 friend に
          // 占有された顧客にも死にリンクを発行しないため)。 fake 側に is_following=1 条件を
          // 足すと、その退行を検出できなくなる (R1 採点 MED)。
          let linked = false;
          for (const f of store.friends.values()) {
            if (f.shopify_customer_id === c.shopify_customer_id) {
              linked = true;
              break;
            }
          }
          if (linked) continue;
        }
        out.push(c);
        if (out.length >= limit) break;
      }
      return out;
    }

    // ---- audit_logs 等はテスト対象外 (auditSystem が best-effort で握る) ----
    return mode === 'all' ? [] : mode === 'first' ? null : { meta: { changes: 0 } };
  }

  const db = {
    prepare(sql: string) {
      const make = (args: unknown[]) => ({
        async first() {
          return exec(sql, args, 'first');
        },
        async all() {
          return { results: exec(sql, args, 'all') };
        },
        async run() {
          return exec(sql, args, 'run');
        },
      });
      return {
        bind(...args: unknown[]) {
          return make(args);
        },
        ...make([]),
      };
    },
  } as unknown as D1Database;

  return { db, store };
}

const PLAN_TAG = 'subscription-999-plan:[5％OFF定期便] 30日に1回配送（2回目からは5%OFF)';

function envWith(db: D1Database, over: Record<string, string | undefined> = {}) {
  return { DB: db, LIFF_URL: 'https://liff.line.me/123-abc', SUB_LINK_ENABLED: 'true', ...over };
}

function seedCustomer(store: Store, id: string, opts: Partial<CustomerRow> = {}): void {
  store.customers.set(id, {
    shopify_customer_id: id,
    email: opts.email === undefined ? `c${id}@example.com` : opts.email,
    first_name: opts.first_name ?? '花子',
    last_name: opts.last_name ?? '山田',
    tags: opts.tags ?? PLAN_TAG,
  });
}
function seedFriend(store: Store, id: string, opts: Partial<FriendRow> = {}): void {
  store.friends.set(id, {
    id,
    line_user_id: opts.line_user_id ?? `U${id}`,
    shopify_customer_id: opts.shopify_customer_id ?? null,
    is_following: opts.is_following ?? 1,
  });
}

// ============================================================
// gate
// ============================================================

describe('sub-link gate (SUB_LINK_ENABLED)', () => {
  it('generate は gate off で disabled', async () => {
    const { db } = createDb();
    const r = await generateSubLinkBatch(envWith(db, { SUB_LINK_ENABLED: undefined }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('disabled');
  });

  it('preview は gate off で disabled', async () => {
    const { db } = createDb();
    const r = await previewSubLinkToken(envWith(db, { SUB_LINK_ENABLED: 'false' }), { token: 't', friendId: 'f1' });
    expect(r.ok).toBe(false);
  });

  it('redeem は gate off で disabled', async () => {
    const { db } = createDb();
    const r = await redeemSubLinkToken(envWith(db, { SUB_LINK_ENABLED: undefined }), {
      token: 't',
      friendId: 'f1',
      lineUserId: 'U1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('disabled');
  });
});

// ============================================================
// generate
// ============================================================

describe('generateSubLinkBatch', () => {
  it('LIFF_URL 未設定は misconfigured', async () => {
    const { db } = createDb();
    const r = await generateSubLinkBatch(envWith(db, { LIFF_URL: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('misconfigured');
  });

  it('customerIds 指定でトークン発行 + link 形状 + plan 抽出', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    const r = await generateSubLinkBatch(envWith(db), { customerIds: ['100'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count).toBe(1);
    const e = r.entries[0];
    expect(e.shopifyCustomerId).toBe('100');
    expect(e.email).toBe('c100@example.com');
    expect(e.name).toBe('山田 花子');
    expect(e.intervalDays).toBe(30);
    expect(e.link.startsWith('https://liff.line.me/123-abc?slk=')).toBe(true);
    // トークンが D1 に記録されている
    const token = e.link.split('slk=')[1];
    expect(store.tokens.get(token)?.shopify_customer_id).toBe('100');
  });

  it('自動選定 onlyUnlinked は連携済(following)顧客を除外', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '200');
    seedCustomer(store, '201');
    // 201 は following friend に連携済 → 除外される
    seedFriend(store, 'fA', { shopify_customer_id: '201', is_following: 1 });
    const r = await generateSubLinkBatch(envWith(db), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.entries.map((e) => e.shopifyCustomerId);
    expect(ids).toContain('200');
    expect(ids).not.toContain('201');
  });

  it('cancel タグの顧客は自動選定から除外', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '300', { tags: 'subscription-1-plan:X, subscription-1-cancel:2026-07-01' });
    seedCustomer(store, '301');
    const r = await generateSubLinkBatch(envWith(db), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.entries.map((e) => e.shopifyCustomerId);
    expect(ids).not.toContain('300');
    expect(ids).toContain('301');
  });

  it('再生成で旧 unconsumed トークンを掃除 (= 古い link を無効化)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '400');
    const r1 = await generateSubLinkBatch(envWith(db), { customerIds: ['400'] });
    const r2 = await generateSubLinkBatch(envWith(db), { customerIds: ['400'] });
    expect(r1.ok && r2.ok).toBe(true);
    // 顧客 400 の未消費トークンは最新の 1 本のみ
    const remaining = [...store.tokens.values()].filter((t) => t.shopify_customer_id === '400' && !t.consumed_at);
    expect(remaining.length).toBe(1);
  });

  it('App Proxy 発行トークンは巻き添えで削除しない (顧客がストアで連携中の link を殺さない)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '400');
    store.tokens.set('inflight', mkToken('inflight', '400', { batch_id: 'app-proxy' }));
    const r = await generateSubLinkBatch(envWith(db), { customerIds: ['400'] });
    expect(r.ok).toBe(true);
    expect(store.tokens.has('inflight')).toBe(true);
  });

  it('email 無しの顧客は entries に載せない', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '500', { email: null });
    const r = await generateSubLinkBatch(envWith(db), { customerIds: ['500'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count).toBe(0);
  });
});

// ============================================================
// preview
// ============================================================

describe('previewSubLinkToken', () => {
  it('未知トークンは invalid', async () => {
    const { db } = createDb();
    const r = await previewSubLinkToken(envWith(db), { token: 'nope', friendId: 'f1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('invalid');
  });

  it('未消費・未失効・未連携は ready + plan', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    const r = await previewSubLinkToken(envWith(db), { token: 'T', friendId: 'f1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe('ready');
      expect(r.intervalDays).toBe(30);
    }
  });

  it('失効トークンは expired', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100', { expires_at: pastIso() }));
    const r = await previewSubLinkToken(envWith(db), { token: 'T', friendId: 'f1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('expired');
  });

  it('別 friend が消費済みは used', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100', { consumed_at: futureIso(-0), consumed_friend_id: 'other' }));
    const r = await previewSubLinkToken(envWith(db), { token: 'T', friendId: 'f1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('used');
  });

  it('顧客が別 following friend に連携済みは taken', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'fA', { shopify_customer_id: '100' });
    const r = await previewSubLinkToken(envWith(db), { token: 'T', friendId: 'f1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('taken');
  });

  it('自分が既に連携済みは already_self', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1', { shopify_customer_id: '100' });
    const r = await previewSubLinkToken(envWith(db), { token: 'T', friendId: 'f1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('already_self');
  });

  it('自分が消費済みでも friend 側の連携が無ければ used (偽の「連携済み」を出さない)', async () => {
    // redeem 途中の失敗やサポートによる手動解除で、token だけ消費済み・friend は未連携という
    // 状態が起きうる。 ここで already_self を返すと「✓ 連携済みです」と表示して連携ボタンを
    // 消してしまい、実際には連携されていないユーザーが自力で復旧できなくなる (R2 採点 LOW)。
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100', { consumed_at: futureIso(-0), consumed_friend_id: 'f1' }));
    seedFriend(store, 'f1'); // friend 自体は未連携だが token は f1 が消費済み
    const r = await previewSubLinkToken(envWith(db), { token: 'T', friendId: 'f1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('used'); // redeem 側 (code:'used') と同じ述語
  });

  it('呼び出し元が別顧客に連携済みは friend_conflict (redeem と一致 = 死んだボタン回避)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1', { shopify_customer_id: '999' }); // 別顧客に連携済み
    const r = await previewSubLinkToken(envWith(db), { token: 'T', friendId: 'f1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('friend_conflict');
  });

  it('連携不能ステータス (used/taken/expired) では plan を返さない (PII/内容 非開示)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    // taken
    store.tokens.set('T1', mkToken('T1', '100'));
    seedFriend(store, 'fA', { shopify_customer_id: '100' });
    const taken = await previewSubLinkToken(envWith(db), { token: 'T1', friendId: 'f1' });
    // expired
    store.tokens.set('T2', mkToken('T2', '100', { expires_at: pastIso() }));
    const expired = await previewSubLinkToken(envWith(db), { token: 'T2', friendId: 'f2' });
    for (const r of [taken, expired]) {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.plan).toBeNull();
        expect(r.intervalDays).toBeNull();
        // preview 応答に氏名/email が構造的に存在しない
        expect(Object.keys(r)).not.toContain('email');
        expect(Object.keys(r)).not.toContain('name');
      }
    }
  });
});

// ============================================================
// redeem
// ============================================================

describe('redeemSubLinkToken', () => {
  it('happy path: 連携 + トークン消費 + friend に customer 設定', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    const r = await redeemSubLinkToken(envWith(db), { token: 'T', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.alreadyLinked).toBe(false);
      expect(r.summary.customerId).toBe('100');
    }
    expect(store.friends.get('f1')?.shopify_customer_id).toBe('100');
    expect(store.tokens.get('T')?.consumed_at).not.toBeNull();
    expect(store.tokens.get('T')?.consumed_friend_id).toBe('f1');
  });

  it('single-use: 転送 link を別 friend が踏んでも 2 人目は used', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    seedFriend(store, 'f2');
    const r1 = await redeemSubLinkToken(envWith(db), { token: 'T', friendId: 'f1', lineUserId: 'U1' });
    const r2 = await redeemSubLinkToken(envWith(db), { token: 'T', friendId: 'f2', lineUserId: 'U2' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('used');
    // f2 は連携されない
    expect(store.friends.get('f2')?.shopify_customer_id).toBeNull();
  });

  it('冪等: 同一顧客に既連携の friend が再 redeem すると alreadyLinked 成功', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1', { shopify_customer_id: '100' });
    const r = await redeemSubLinkToken(envWith(db), { token: 'T', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.alreadyLinked).toBe(true);
    // 冪等時もトークンは消費される (= link 再利用を封じる)
    expect(store.tokens.get('T')?.consumed_at).not.toBeNull();
  });

  it('friend が別顧客に連携済みは friend_conflict', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1', { shopify_customer_id: '999' });
    const r = await redeemSubLinkToken(envWith(db), { token: 'T', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('friend_conflict');
    // トークンは消費されない
    expect(store.tokens.get('T')?.consumed_at).toBeNull();
  });

  it('顧客が別 friend に連携済みは taken (消費しない)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'fA', { shopify_customer_id: '100' });
    seedFriend(store, 'f1');
    const r = await redeemSubLinkToken(envWith(db), { token: 'T', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('taken');
    expect(store.tokens.get('T')?.consumed_at).toBeNull();
  });

  it('失効トークンは expired', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100', { expires_at: pastIso() }));
    seedFriend(store, 'f1');
    const r = await redeemSubLinkToken(envWith(db), { token: 'T', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('expired');
  });

  it('UNIQUE race: link 失敗時にトークン消費を巻き戻す + taken', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    store.throwOnLinkFor.add('f1'); // setFriend が UNIQUE で throw
    const r = await redeemSubLinkToken(envWith(db), { token: 'T', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('taken');
    // 消費が巻き戻り、 別の link 再発行で救済可能な状態に戻る
    expect(store.tokens.get('T')?.consumed_at).toBeNull();
  });

  it('未知トークンは invalid', async () => {
    const { db, store } = createDb();
    seedFriend(store, 'f1');
    const r = await redeemSubLinkToken(envWith(db), { token: 'nope', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid');
  });

  it('CAS 敗者: row は未消費で読めるが consume に負けたら used + 連携しない', async () => {
    const { db, store } = createDb();
    store.forceConsumeLoss = true; // getSubLinkToken では未消費、 consume CAS は 0 件
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    const r = await redeemSubLinkToken(envWith(db), { token: 'T', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('used');
    // 直列化点で負けたので friend は連携されない (= setFriend まで到達しない)
    expect(store.friends.get('f1')?.shopify_customer_id).toBeNull();
  });

  it('並行 link race: consume 後に別経路が同顧客へ連携済 → refreshed 再確認で alreadyLinked 成功', async () => {
    const { db, store } = createDb();
    store.linkOnConsume = '100'; // consume と同時に f1 が 100 へ連携された状況
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1'); // pre-check 時点では未連携
    const r = await redeemSubLinkToken(envWith(db), { token: 'T', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.alreadyLinked).toBe(true);
    expect(store.friends.get('f1')?.shopify_customer_id).toBe('100');
  });
});

// ============================================================
// status
// ============================================================

describe('getSubLinkStatus', () => {
  it('件数集計 (total/consumed/pending/expired)', async () => {
    const { db, store } = createDb();
    store.tokens.set('a', mkToken('a', '1'));
    store.tokens.set('b', mkToken('b', '2', { consumed_at: futureIso(-0), consumed_friend_id: 'f' }));
    store.tokens.set('c', mkToken('c', '3', { expires_at: pastIso() }));
    const s = await getSubLinkStatus(envWith(db));
    expect(s.enabled).toBe(true);
    expect(s.tokens.total).toBe(3);
    expect(s.tokens.consumed).toBe(1);
    expect(s.tokens.pending).toBe(1);
    expect(s.tokens.expired).toBe(1);
  });
});

// ============================================================
// routes (HTTP 契約: gate → status code / envelope / auth 境界)
// ============================================================

describe('sub-link routes', () => {
  function routeEnv(db: D1Database, over: Record<string, string | undefined> = {}) {
    return { DB: db, LIFF_URL: 'https://liff.line.me/123-abc', SUB_LINK_ENABLED: 'true', ...over } as unknown as Record<string, unknown>;
  }
  async function post(path: string, body: unknown, env: Record<string, unknown>) {
    return subLink.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
  }

  it('admin generate: gate off → 409 disabled', async () => {
    const { db } = createDb();
    const res = await post('/api/admin/sub-link/generate', {}, routeEnv(db, { SUB_LINK_ENABLED: undefined }));
    expect(res.status).toBe(409);
    const j = (await res.json()) as { success: boolean; error: string };
    expect(j.success).toBe(false);
    expect(j.error).toBe('disabled');
  });

  it('admin generate: LIFF_URL 未設定 → 503 misconfigured', async () => {
    const { db } = createDb();
    const res = await post('/api/admin/sub-link/generate', {}, routeEnv(db, { LIFF_URL: '' }));
    expect(res.status).toBe(503);
  });

  it('admin generate: customerIds で 200 + entries', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    const res = await post('/api/admin/sub-link/generate', { customerIds: ['100'] }, routeEnv(db));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { success: boolean; data: { count: number; entries: unknown[] } };
    expect(j.success).toBe(true);
    expect(j.data.count).toBe(1);
  });

  it('admin status: 200 + counts', async () => {
    const { db, store } = createDb();
    store.tokens.set('a', mkToken('a', '1'));
    const res = await subLink.request('/api/admin/sub-link/status', {}, routeEnv(db));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { success: boolean; data: { tokens: { total: number } } };
    expect(j.data.tokens.total).toBe(1);
  });

  it('liff redeem: liffUser なし → 401', async () => {
    const { db } = createDb();
    const res = await post('/api/liff/sub-link/redeem', { token: 'T' }, routeEnv(db));
    expect(res.status).toBe(401);
  });

  it('liff preview: liffUser なしは 401 (認証境界。 400 の body 検証は下の authed ブロック)', async () => {
    const { db } = createDb();
    const res = await post('/api/liff/sub-link/preview', { nope: 1 }, routeEnv(db));
    expect(res.status).toBe(401);
  });
});

// ============================================================
// LIFF route の応答契約 (liffUser 注入つき)
//   kind / hint を落としても service テストは green のままなので、
//   route レイヤの body 形状をここで固定する (R2 採点 HIGH)。
// ============================================================

describe('sub-link LIFF routes (authed)', () => {
  function routeEnv(db: D1Database, over: Record<string, string | undefined> = {}) {
    return {
      DB: db,
      LIFF_URL: 'https://liff.line.me/123-abc',
      SUB_LINK_ENABLED: 'true',
      ...over,
    } as unknown as Record<string, unknown>;
  }

  function authedApp(friendId: string, lineUserId = 'U1') {
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set('liffUser', { friendId, lineUserId });
      await next();
    });
    app.route('/', subLink as never);
    return app;
  }

  async function authedPost(
    friendId: string,
    path: string,
    body: unknown,
    env: Record<string, unknown>,
  ) {
    return authedApp(friendId).request(
      path,
      { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
      env,
    );
  }

  it('preview(ready, app-proxy) は kind=shop と マスク済 hint を返す', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1', { tags: '', email: 'hanako@example.com' });
    seedFriend(store, 'f1');
    store.tokens.set('tk1', mkToken('tk1', 'c1', { batch_id: 'app-proxy' }));
    const res = await authedPost(
      'f1',
      '/api/liff/sub-link/preview',
      { token: 'tk1' },
      routeEnv(db, { APP_PROXY_LINK_ENABLED: 'true' }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      data: { status: string; kind: string; hint: string | null; plan: string | null };
    };
    expect(j.data.status).toBe('ready');
    expect(j.data.kind).toBe('shop');
    expect(j.data.hint).toBe('h***@e***.com');
  });

  it('preview(taken) は hint を返さない (転送 link 保持者に識別材料を渡さない)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1', { email: 'hanako@example.com' });
    seedFriend(store, 'f1', { shopify_customer_id: 'c1' });
    seedFriend(store, 'f2');
    store.tokens.set('tk1', mkToken('tk1', 'c1', {}));
    const res = await authedPost('f2', '/api/liff/sub-link/preview', { token: 'tk1' }, routeEnv(db));
    const j = (await res.json()) as { data: { status: string; hint: string | null; kind: string } };
    expect(j.data.status).toBe('taken');
    expect(j.data.hint).toBeNull();
    expect(j.data.kind).toBe('subscription');
  });

  it('redeem 応答は kind を含む (完了画面の文言分岐が確認カードと矛盾しない)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1', { tags: '', email: 'h@e.com' });
    seedFriend(store, 'f1');
    store.tokens.set('tk1', mkToken('tk1', 'c1', { batch_id: 'app-proxy' }));
    const res = await authedPost(
      'f1',
      '/api/liff/sub-link/redeem',
      { token: 'tk1' },
      routeEnv(db, { APP_PROXY_LINK_ENABLED: 'true' }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { data: { linked: boolean; kind: string } };
    expect(j.data.linked).toBe(true);
    expect(j.data.kind).toBe('shop');
  });

  it('不正ボディは 400 (認証を通した上での validation)', async () => {
    const { db } = createDb();
    const res = await authedPost('f1', '/api/liff/sub-link/preview', { nope: 1 }, routeEnv(db));
    expect(res.status).toBe(400);
  });
});

// ============================================================
// App Proxy 連携との共用 (2026-07-29): デュアルゲート / kind / backlink
// ============================================================

describe('デュアルゲート (APP_PROXY_LINK_ENABLED)', () => {
  it('generate は APP_PROXY gate のみでは disabled のまま (= キャンペーン停止中に 30日 link を量産させない)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1');
    const r = await generateSubLinkBatch(
      envWith(db, { SUB_LINK_ENABLED: undefined, APP_PROXY_LINK_ENABLED: 'true' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('disabled');
  });

  it('APP_PROXY gate のみのとき、app-proxy 発行トークンは受理される', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1');
    seedFriend(store, 'f1');
    store.tokens.set('tk1', mkToken('tk1', 'c1', { batch_id: 'app-proxy' }));
    const env = envWith(db, { SUB_LINK_ENABLED: undefined, APP_PROXY_LINK_ENABLED: 'true' });
    const p = await previewSubLinkToken(env, { token: 'tk1', friendId: 'f1' });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.status).toBe('ready');
    const r = await redeemSubLinkToken(env, { token: 'tk1', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(true);
  });

  it('🚨 APP_PROXY gate を開いても、停止したキャンペーンの magic-link は復活しない', async () => {
    // OR 結合だと「SUB_LINK_ENABLED=false で止めたはずの 30日 link が、App Proxy 有効化で
    // 全部よみがえる」= kill switch が効かない (R1 採点 MED)。
    const { db, store } = createDb();
    seedCustomer(store, 'c1');
    seedFriend(store, 'f1');
    store.tokens.set('tk1', mkToken('tk1', 'c1', { batch_id: 'campaign-2026-07' }));
    const env = envWith(db, { SUB_LINK_ENABLED: undefined, APP_PROXY_LINK_ENABLED: 'true' });
    const p = await previewSubLinkToken(env, { token: 'tk1', friendId: 'f1' });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.status).toBe('invalid');
    const r = await redeemSubLinkToken(env, { token: 'tk1', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid');
    expect(store.friends.get('f1')?.shopify_customer_id).toBeNull();
  });

  it('SUB_LINK gate のみのとき、app-proxy 発行トークンは受理されない', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1');
    seedFriend(store, 'f1');
    store.tokens.set('tk1', mkToken('tk1', 'c1', { batch_id: 'app-proxy' }));
    const env = envWith(db, { SUB_LINK_ENABLED: 'true', APP_PROXY_LINK_ENABLED: undefined });
    const r = await redeemSubLinkToken(env, { token: 'tk1', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid');
  });

  it('status は APP_PROXY gate のみで enabled=true + gates を返す', async () => {
    const { db } = createDb();
    const s = await getSubLinkStatus(envWith(db, { SUB_LINK_ENABLED: undefined, APP_PROXY_LINK_ENABLED: 'true' }));
    expect(s.enabled).toBe(true);
    expect(s.gates).toEqual({ subLink: false, appProxy: true });
  });

  it('両 gate off では status も dormant (tokens ゼロ・DB 非参照)', async () => {
    const { db } = createDb();
    const s = await getSubLinkStatus(envWith(db, { SUB_LINK_ENABLED: undefined }));
    expect(s.enabled).toBe(false);
    expect(s.tokens).toEqual({ total: 0, consumed: 0, pending: 0, expired: 0 });
  });
});

describe('自動選定の onlyUnlinked 述語 (is_following を問わない)', () => {
  it('ブロック/退会済 (is_following=0) の friend に連携済みの顧客も除外される', async () => {
    // 除外しないと、既に別 LINE に占有された顧客へ redeem 不能な死にリンクを配ってしまう
    const { db, store } = createDb();
    seedCustomer(store, 'c1');
    seedFriend(store, 'f1', { shopify_customer_id: 'c1', is_following: 0 });
    const r = await generateSubLinkBatch(envWith(db));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.count).toBe(0);
  });

  it('未連携顧客は選定される (過剰除外でないことの対照)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1');
    seedFriend(store, 'f1', { shopify_customer_id: null, is_following: 0 });
    const r = await generateSubLinkBatch(envWith(db));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.count).toBe(1);
  });
});

describe('preview の hint (マスク済 email)', () => {
  it('ready でのみマスク済 email を返す', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1', { email: 'hanako@example.com' });
    seedFriend(store, 'f1');
    store.tokens.set('tk1', mkToken('tk1', 'c1', {}));
    const p = await previewSubLinkToken(envWith(db), { token: 'tk1', friendId: 'f1' });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.status).toBe('ready');
      expect(p.hint).toBe('h***@e***.com');
    }
  });

  it('taken (第三者が踏んだ) では hint を返さない', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1', { email: 'hanako@example.com' });
    seedFriend(store, 'f1', { shopify_customer_id: 'c1' });
    seedFriend(store, 'f2');
    store.tokens.set('tk1', mkToken('tk1', 'c1', {}));
    const p = await previewSubLinkToken(envWith(db), { token: 'tk1', friendId: 'f2' });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.status).toBe('taken');
      expect(p.hint).toBeNull();
    }
  });

  it('maskEmail は不正形式を null にする', () => {
    expect(maskEmail('a@b.com')).toBe('a***@b***.com');
    expect(maskEmail('@example.com')).toBeNull();
    expect(maskEmail('no-at-sign')).toBeNull();
    expect(maskEmail('a@localhost')).toBeNull();
    expect(maskEmail(null)).toBeNull();
  });
});

describe('kind (subscription / shop) の導出', () => {
  it('batch_id=app-proxy のトークンは preview/redeem とも kind=shop', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1', { tags: '' }); // 非サブスク顧客 = plan null (seedCustomer は null を既定 PLAN_TAG に潰すため空文字で表現)
    seedFriend(store, 'f1');
    store.tokens.set('tk1', mkToken('tk1', 'c1', { batch_id: 'app-proxy' }));
    const env = envWith(db, { APP_PROXY_LINK_ENABLED: 'true' });
    const p = await previewSubLinkToken(env, { token: 'tk1', friendId: 'f1' });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.kind).toBe('shop');
      expect(p.plan).toBeNull();
    }
    const r = await redeemSubLinkToken(env, { token: 'tk1', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.summary.kind).toBe('shop');
  });

  it('通常バッチのトークンは kind=subscription (既存挙動不変)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1');
    seedFriend(store, 'f1');
    store.tokens.set('tk1', mkToken('tk1', 'c1', {}));
    const p = await previewSubLinkToken(envWith(db), { token: 'tk1', friendId: 'f1' });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.kind).toBe('subscription');
  });
});

describe('backlink (shopify_customers.friend_id 逆方向書き込み)', () => {
  it('redeem 成功で customer 側にも friend_id が入る', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1');
    seedFriend(store, 'f1');
    store.tokens.set('tk1', mkToken('tk1', 'c1', {}));
    const r = await redeemSubLinkToken(envWith(db), { token: 'tk1', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(true);
    expect(store.customers.get('c1')?.friend_id).toBe('f1');
  });

  it('冪等 redeem (既連携) でも欠損 backlink を補完する', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1'); // friend_id 未設定 (過去 link の欠損を再現)
    seedFriend(store, 'f1', { shopify_customer_id: 'c1' });
    store.tokens.set('tk1', mkToken('tk1', 'c1', {}));
    const r = await redeemSubLinkToken(envWith(db), { token: 'tk1', friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.alreadyLinked).toBe(true);
    expect(store.customers.get('c1')?.friend_id).toBe('f1');
  });

  it('redeem 失敗 (taken) では backlink しない', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1');
    seedFriend(store, 'f1', { shopify_customer_id: 'c1' });
    seedFriend(store, 'f2');
    store.tokens.set('tk1', mkToken('tk1', 'c1', {}));
    const r = await redeemSubLinkToken(envWith(db), { token: 'tk1', friendId: 'f2', lineUserId: 'U2' });
    expect(r.ok).toBe(false);
    expect(store.customers.get('c1')?.friend_id).toBeUndefined();
  });
});

// ============================================================
// helpers
// ============================================================

function mkToken(token: string, cid: string, over: Partial<TokenRow> = {}): TokenRow {
  return {
    token,
    shopify_customer_id: cid,
    batch_id: over.batch_id ?? 'batch1',
    expires_at: over.expires_at ?? futureIso(),
    consumed_at: over.consumed_at ?? null,
    consumed_by_line_user_id: over.consumed_by_line_user_id ?? null,
    consumed_friend_id: over.consumed_friend_id ?? null,
    created_at: toJstString(new Date()),
  };
}

// ============================================================
// 連携特典クーポン hook (Sprint A-1, 2026-08-11)
//   redeem 新規成功のときだけ発行する。冪等 (alreadyLinked) / 失敗では発行しない。
// ============================================================

describe('link reward hook (POST /api/liff/sub-link/redeem)', () => {
  function routeEnv(db: D1Database) {
    return {
      DB: db,
      LIFF_URL: 'https://liff.line.me/123-abc',
      SUB_LINK_ENABLED: 'true',
      LINK_REWARD_ENABLED: 'true',
    } as unknown as Record<string, unknown>;
  }
  function authedApp(friendId: string, lineUserId = 'U1') {
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set('liffUser', { friendId, lineUserId });
      await next();
    });
    app.route('/', subLink as never);
    return app;
  }
  async function postRedeem(app: Hono, db: D1Database, token: string) {
    return app.request(
      '/api/liff/sub-link/redeem',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) },
      routeEnv(db),
    );
  }

  beforeEach(() => {
    mockedIssueLinkReward.mockReset();
    mockedIssueLinkReward.mockResolvedValue(null);
  });

  it('🚨新規連携成功 → issuer が friendId/customerId/linkPath=sub_link で 1 回呼ばれる', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    const res = await postRedeem(authedApp('f1'), db, 'T');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { success: boolean; data: { alreadyLinked: boolean } };
    expect(j.data.alreadyLinked).toBe(false);
    expect(mockedIssueLinkReward).toHaveBeenCalledTimes(1);
    const [, , opts] = mockedIssueLinkReward.mock.calls[0];
    expect(opts).toMatchObject({ friendId: 'f1', shopifyCustomerId: '100', linkPath: 'sub_link' });
  });

  it('冪等再訪 (alreadyLinked=true) → issuer を呼ばない', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1', { shopify_customer_id: '100' });
    const res = await postRedeem(authedApp('f1'), db, 'T');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { success: boolean; data: { alreadyLinked: boolean } };
    expect(j.data.alreadyLinked).toBe(true);
    expect(mockedIssueLinkReward).not.toHaveBeenCalled();
  });

  it('redeem 失敗 (無効トークン) → issuer を呼ばない', async () => {
    const { db, store } = createDb();
    seedFriend(store, 'f1');
    const res = await postRedeem(authedApp('f1'), db, 'nope');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockedIssueLinkReward).not.toHaveBeenCalled();
  });

  it('issuer が reject しても redeem 応答は成功のまま (fire-and-forget)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    mockedIssueLinkReward.mockRejectedValueOnce(new Error('shopify down'));
    const res = await postRedeem(authedApp('f1'), db, 'T');
    expect(res.status).toBe(200);
  });
});

// 過去購入 backfill hook (2026-08-26): slk redeem 経路の設計ギャップ修正。
// OTP 経路 (verifyAccountLinkCode) は service 内で backfill するが、この経路には無かった
// = App Proxy / magic-link で連携した人だけ「これまでのお買い物」がランクに 1 円も反映されない。
describe('purchase backfill hook (POST /api/liff/sub-link/redeem)', () => {
  function authedApp(friendId: string, lineUserId = 'U1') {
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set('liffUser', { friendId, lineUserId });
      await next();
    });
    app.route('/', subLink as never);
    return app;
  }
  async function postRedeem(friendId: string, db: D1Database, token: string, over: Record<string, string | undefined> = {}) {
    return authedApp(friendId).request(
      '/api/liff/sub-link/redeem',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) },
      {
        DB: db,
        LIFF_URL: 'https://liff.line.me/123-abc',
        SUB_LINK_ENABLED: 'true',
        MEMBER_BACKFILL_ENABLED: 'true',
        SHOPIFY_STORE_DOMAIN: 'x.myshopify.com',
        ...over,
      } as unknown as Record<string, unknown>,
    );
  }

  beforeEach(() => {
    mockedBackfill.mockClear();
    mockedGetToken.mockClear();
    mockedGetToken.mockResolvedValue('test-access-token');
  });

  it('🚨新規連携成功 → backfill が customerId/friendId/取得済 token で 1 回呼ばれる', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    const res = await postRedeem('f1', db, 'T');
    expect(res.status).toBe(200);
    await settle();
    expect(mockedBackfill).toHaveBeenCalledTimes(1);
    const [, env, opts] = mockedBackfill.mock.calls[0];
    expect(env).toMatchObject({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', MEMBER_BACKFILL_ENABLED: 'true' });
    // maxPages=2: redeem invocation は D1 + クーポン発行も subrequest を使うため既定 6 より絞る
    expect(opts).toMatchObject({ customerId: '100', friendId: 'f1', accessToken: 'test-access-token', maxPages: 2 });
  });

  it('gate off (MEMBER_BACKFILL_ENABLED 未設定) → backfill も token 取得も呼ばない', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    const res = await postRedeem('f1', db, 'T', { MEMBER_BACKFILL_ENABLED: undefined });
    expect(res.status).toBe(200);
    await settle();
    // 観測点は「外部 I/O に触れていないこと」(ステータスだけ見ると「取ってから捨てる」実装で緑になる)
    expect(mockedGetToken).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it.each([['false'], ['TRUE'], ['true\r'], ['']])(
    'gate 値 %j は有効化しない (=== \'true\' 厳密一致)',
    async (gate) => {
      const { db, store } = createDb();
      seedCustomer(store, '100');
      store.tokens.set('T', mkToken('T', '100'));
      seedFriend(store, 'f1');
      const res = await postRedeem('f1', db, 'T', { MEMBER_BACKFILL_ENABLED: gate });
      expect(res.status).toBe(200);
      await settle();
      expect(mockedGetToken).not.toHaveBeenCalled();
      expect(mockedBackfill).not.toHaveBeenCalled();
    },
  );

  it('冪等再訪 (alreadyLinked=true) → backfill を呼ばない (admin op の管轄)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1', { shopify_customer_id: '100' });
    const res = await postRedeem('f1', db, 'T');
    expect(res.status).toBe(200);
    await settle();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('redeem 失敗 (無効トークン) → backfill を呼ばない', async () => {
    const { db, store } = createDb();
    seedFriend(store, 'f1');
    const res = await postRedeem('f1', db, 'nope');
    expect(res.status).toBeGreaterThanOrEqual(400);
    await settle();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('token 取得が reject しても redeem 応答は成功のまま (fire-and-forget)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    mockedGetToken.mockRejectedValueOnce(new Error('token store down'));
    const res = await postRedeem('f1', db, 'T');
    expect(res.status).toBe(200);
    await settle();
    expect(mockedBackfill).not.toHaveBeenCalled(); // token 無しでは backfill に進まない
  });

  it('🚨backfill はクーポン発行の**後**に直列実行される (subrequest 予算の巻き添え防止・採点ループ HIGH)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    // クーポン発行を保留にして、その間 backfill が始まらないことを観測する
    let resolveIssue: (() => void) | undefined;
    mockedIssueLinkReward.mockImplementationOnce(
      () => new Promise((res) => { resolveIssue = () => res(null); }) as ReturnType<typeof issueLinkRewardCoupon>,
    );
    const res = await postRedeem('f1', db, 'T');
    expect(res.status).toBe(200);
    await settle();
    expect(mockedGetToken).not.toHaveBeenCalled(); // クーポン未完了の間は token 取得すら始めない
    expect(mockedBackfill).not.toHaveBeenCalled();
    resolveIssue!();
    await settle();
    expect(mockedBackfill).toHaveBeenCalledTimes(1); // 発行完了後に backfill が走る
  });

  it('クーポン発行が reject しても backfill は走る (直列化は順序であって依存ではない)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    mockedIssueLinkReward.mockRejectedValueOnce(new Error('shopify down'));
    const res = await postRedeem('f1', db, 'T');
    expect(res.status).toBe(200);
    await settle();
    expect(mockedBackfill).toHaveBeenCalledTimes(1);
  });
});

// バッチ発行の監査 (2026-08-26 採点ループ MED): magic-link 一斉発行に監査が無いと、
// dashboard の連携ファネルが「発行 < 到達」の矛盾表示になる (発行列の母集団欠落)。
describe('generate バッチ監査 (account_link.sub_link_batch_generated)', () => {
  beforeEach(() => {
    mockedAudit.mockClear();
  });

  it('発行あり → 1 バッチ 1 行 (count 入り・PII なし)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    seedCustomer(store, '200');
    const r = await generateSubLinkBatch(envWith(db), { customerIds: ['100', '200'] });
    expect(r.ok).toBe(true);
    const calls = mockedAudit.mock.calls.filter(([, i]) => i.action === 'account_link.sub_link_batch_generated');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ result: 'success', metadata: { count: 2 } });
    // PII (email/氏名) を audit に載せない
    expect(JSON.stringify(calls[0][1])).not.toContain('@example.com');
  });

  it('発行 0 件 → バッチ監査を書かない (ノイズ防止)', async () => {
    const { db } = createDb();
    const r = await generateSubLinkBatch(envWith(db), { customerIds: ['nope'] });
    expect(r.ok).toBe(true);
    expect(
      mockedAudit.mock.calls.filter(([, i]) => i.action === 'account_link.sub_link_batch_generated'),
    ).toHaveLength(0);
  });
});

// preview 監査 (2026-08-26): 「顧客は LIFF に到達したのか」を事後に切り分ける観測点。
// App Proxy トークン 3 件が全件失効した実事例で、この記録が無く破断点を特定できなかった。
describe('preview 監査 (account_link.sub_link_previewed)', () => {
  beforeEach(() => {
    mockedAudit.mockClear();
  });

  it('ready → status/kind 入りで 1 回記録される', async () => {
    const { db, store } = createDb();
    seedCustomer(store, 'c1', { email: 'hanako@example.com' });
    seedFriend(store, 'f1');
    store.tokens.set('tk1', mkToken('tk1', 'c1', { batch_id: 'app-proxy' }));
    const r = await previewSubLinkToken(
      envWith(db, { APP_PROXY_LINK_ENABLED: 'true' }),
      { token: 'tk1', friendId: 'f1' },
    );
    expect(r.ok).toBe(true);
    expect(mockedAudit).toHaveBeenCalledTimes(1);
    const [, input] = mockedAudit.mock.calls[0];
    expect(input).toMatchObject({
      action: 'account_link.sub_link_previewed',
      targetType: 'friend',
      targetId: 'f1',
      metadata: { status: 'ready', kind: 'shop' },
    });
  });

  it('invalid (存在しないトークン) も status 入りで記録される', async () => {
    const { db, store } = createDb();
    seedFriend(store, 'f1');
    const r = await previewSubLinkToken(envWith(db), { token: 'nope', friendId: 'f1' });
    expect(r.ok).toBe(true);
    expect(mockedAudit).toHaveBeenCalledTimes(1);
    expect(mockedAudit.mock.calls[0][1]).toMatchObject({
      action: 'account_link.sub_link_previewed',
      metadata: { status: 'invalid', kind: 'subscription' },
    });
  });

  it('dormant (両 gate off) では 1 行も書かない (dormancy 不変条件)', async () => {
    const { db, store } = createDb();
    seedFriend(store, 'f1');
    store.tokens.set('tk1', mkToken('tk1', 'c1'));
    const r = await previewSubLinkToken(
      envWith(db, { SUB_LINK_ENABLED: undefined }),
      { token: 'tk1', friendId: 'f1' },
    );
    expect(r.ok).toBe(false);
    expect(mockedAudit).not.toHaveBeenCalled();
  });
});

// 再注入ドリル (2026-08-11): waitUntil 登録そのものを検証する (account-link 側と同旨)。
describe('link reward hook — waitUntil 登録 (redeem)', () => {
  it('🚨新規連携成功 → executionCtx.waitUntil に発行 Promise が登録される', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set('liffUser', { friendId: 'f1', lineUserId: 'U1' });
      await next();
    });
    app.route('/', subLink as never);
    const waitUntil = vi.fn();
    const res = await app.request(
      '/api/liff/sub-link/redeem',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'T' }) },
      { DB: db, LIFF_URL: 'https://liff.line.me/123-abc', SUB_LINK_ENABLED: 'true', LINK_REWARD_ENABLED: 'true' },
      { waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it('🚨backfill gate on → waitUntil に backfill Promise も登録される (計 2 件)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100'));
    seedFriend(store, 'f1');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set('liffUser', { friendId: 'f1', lineUserId: 'U1' });
      await next();
    });
    app.route('/', subLink as never);
    const waitUntil = vi.fn();
    const res = await app.request(
      '/api/liff/sub-link/redeem',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'T' }) },
      { DB: db, LIFF_URL: 'https://liff.line.me/123-abc', SUB_LINK_ENABLED: 'true', LINK_REWARD_ENABLED: 'true', MEMBER_BACKFILL_ENABLED: 'true', SHOPIFY_STORE_DOMAIN: 'x.myshopify.com' },
      { waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(2);
    for (const call of waitUntil.mock.calls) expect(call[0]).toBeInstanceOf(Promise);
  });
});
