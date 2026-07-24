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

import { describe, it, expect } from 'vitest';
import {
  generateSubLinkBatch,
  previewSubLinkToken,
  redeemSubLinkToken,
  getSubLinkStatus,
} from '../services/sub-link.js';
import { subLink } from '../routes/sub-link.js';
import { toJstString } from '@line-crm/db';

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
      const cid = args[0] as string;
      let n = 0;
      for (const [k, v] of store.tokens) {
        if (v.shopify_customer_id === cid && v.consumed_at === null) {
          store.tokens.delete(k);
          n++;
        }
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
    if (sql.startsWith('SELECT tags FROM shopify_customers WHERE shopify_customer_id')) {
      const c = store.customers.get(args[0] as string);
      return c ? { tags: c.tags } : null;
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
          let linked = false;
          for (const f of store.friends.values()) {
            if (f.shopify_customer_id === c.shopify_customer_id && f.is_following === 1) {
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

  it('自分が消費済み (未連携状態) は already_self (consumed_friend_id 経路)', async () => {
    const { db, store } = createDb();
    seedCustomer(store, '100');
    store.tokens.set('T', mkToken('T', '100', { consumed_at: futureIso(-0), consumed_friend_id: 'f1' }));
    seedFriend(store, 'f1'); // friend 自体は未連携だが token は f1 が消費済み
    const r = await previewSubLinkToken(envWith(db), { token: 'T', friendId: 'f1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('already_self');
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

  it('liff preview: 不正ボディ → 400', async () => {
    const { db } = createDb();
    // liffUser は middleware 未経由なので 401 が先に返る = 認証境界を確認
    const res = await post('/api/liff/sub-link/preview', { nope: 1 }, routeEnv(db));
    expect(res.status).toBe(401);
  });
});

// ============================================================
// helpers
// ============================================================

function mkToken(token: string, cid: string, over: Partial<TokenRow> = {}): TokenRow {
  return {
    token,
    shopify_customer_id: cid,
    batch_id: 'batch1',
    expires_at: over.expires_at ?? futureIso(),
    consumed_at: over.consumed_at ?? null,
    consumed_by_line_user_id: over.consumed_by_line_user_id ?? null,
    consumed_friend_id: over.consumed_friend_id ?? null,
    created_at: toJstString(new Date()),
  };
}
