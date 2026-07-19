/**
 * WI-6: LINE userId metafield 移行 (CRM PLUS 撤去準備) のテスト
 * docs/CRMPLUS_UNINSTALL_RUNBOOK.md
 *
 * 対象: 定義作成の冪等性 (TAKEN=成功)・チャンク実行 (offset/limit/remaining、採点R1 HIGH:
 *       Free プラン 50 subrequests/invocation)・部分失敗継続・直読/検索経路の 2 段検証・
 *       useSecret 切替検証・旧 namespace 棚卸し・dryRun の外部呼び出しゼロ・PII 非漏洩。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAuditSystem } = vi.hoisted(() => ({ mockAuditSystem: vi.fn() }));

vi.mock('../services/audit-logger.js', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('../services/audit-logger.js');
  return { ...orig, auditSystem: mockAuditSystem };
});

import {
  ensureLineUserIdDefinition,
  readCustomerLineUserIdMetafield,
  listLinkedFriends,
  countLinkedFriends,
  migrateLineUserIdMetafields,
  verifySearchPathParity,
  auditLegacyMetafieldValues,
  LINEHARNESS_METAFIELD_NAMESPACE,
  LINEHARNESS_METAFIELD_KEY,
  __test__,
} from '../services/line-metafield-migration.js';
import { setCustomerLineUserIdMetafield } from '../services/account-link-shopify.js';

// ===== fixtures =====

const STORE = 'naturism-test.myshopify.com';
const TOKEN = 'shpat_test_token';
const LINE_ID_1 = 'U1111111111111111111111111111111';
const LINE_ID_2 = 'U2222222222222222222222222222222';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** friends SELECT/COUNT を実評価する fake D1 (述語・ORDER BY の実在も検証) */
function createFakeDb(rows: Array<Record<string, unknown>>) {
  const linked = () =>
    rows
      .filter((r) => r.shopify_customer_id != null && r.line_user_id != null)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    prepare(sql: string) {
      // 実 D1 同様、bind() 無しでも first/all を呼べるようにする
      const exec = (binds: unknown[]) => ({
        async all() {
          if (!sql.includes('FROM friends')) throw new Error(`unsupported sql: ${sql}`);
          for (const p of [
            'shopify_customer_id IS NOT NULL',
            'line_user_id IS NOT NULL',
            'ORDER BY id',
            'LIMIT ? OFFSET ?',
          ]) {
            if (!sql.includes(p)) throw new Error(`list SQL から述語が消えている: ${p}`);
          }
          const limit = binds[0] as number;
          const offset = binds[1] as number;
          return { results: linked().slice(offset, offset + limit) };
        },
        async first() {
          if (sql.includes('COUNT(*)')) {
            for (const p of ['shopify_customer_id IS NOT NULL', 'line_user_id IS NOT NULL']) {
              if (!sql.includes(p)) throw new Error(`count SQL から述語が消えている: ${p}`);
            }
            return { n: linked().length };
          }
          if (sql.includes('WHERE shopify_customer_id = ?')) {
            const cid = binds[0] as string;
            const hit = rows.find((r) => r.shopify_customer_id === cid);
            return hit ? { id: hit.id } : null;
          }
          throw new Error(`unsupported first sql: ${sql}`);
        },
      });
      return { bind: (...binds: unknown[]) => exec(binds), ...exec([]) };
    },
  } as unknown as D1Database;
}

function migrationEnv(db: D1Database, extra: Record<string, string> = {}) {
  return {
    DB: db,
    SHOPIFY_STORE_DOMAIN: STORE,
    SHOPIFY_CLIENT_ID: 'cid',
    SHOPIFY_CLIENT_SECRET: 'csec',
    ...extra,
  };
}

const FRIENDS = [
  { id: 'f1', line_user_id: LINE_ID_1, shopify_customer_id: '100' },
  { id: 'f2', line_user_id: LINE_ID_2, shopify_customer_id: '200' },
];

beforeEach(() => {
  mockAuditSystem.mockReset().mockResolvedValue(undefined);
});

// ============================================================
// ensureLineUserIdDefinition
// ============================================================

describe('ensureLineUserIdDefinition', () => {
  it('新規作成 → created (lineharness.line_user_id / CUSTOMER / single_line_text_field)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          metafieldDefinitionCreate: { createdDefinition: { id: 'gid://x/1' }, userErrors: [] },
        },
      }),
    );
    const r = await ensureLineUserIdDefinition(STORE, TOKEN, fetchImpl as unknown as typeof fetch);
    expect(r.status).toBe('created');
    const sent = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.variables.definition.namespace).toBe(LINEHARNESS_METAFIELD_NAMESPACE);
    expect(sent.variables.definition.key).toBe(LINEHARNESS_METAFIELD_KEY);
    expect(sent.variables.definition.ownerType).toBe('CUSTOMER');
    expect(sent.variables.definition.type).toBe('single_line_text_field');
  });

  it('既存 (TAKEN) → exists として冪等成功', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          metafieldDefinitionCreate: {
            createdDefinition: null,
            userErrors: [{ field: ['definition'], message: 'Namespace and key is already taken', code: 'TAKEN' }],
          },
        },
      }),
    );
    const r = await ensureLineUserIdDefinition(STORE, TOKEN, fetchImpl as unknown as typeof fetch);
    expect(r.status).toBe('exists');
    expect(r.errors).toEqual([]);
  });

  it('TAKEN 以外の userError → error + メッセージ', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          metafieldDefinitionCreate: {
            createdDefinition: null,
            userErrors: [{ message: 'Invalid type', code: 'INVALID' }],
          },
        },
      }),
    );
    const r = await ensureLineUserIdDefinition(STORE, TOKEN, fetchImpl as unknown as typeof fetch);
    expect(r.status).toBe('error');
    expect(r.errors).toEqual(['Invalid type']);
  });

  it('HTTP !ok / GraphQL errors は throw (caller が firstError に計上)', async () => {
    const fetch500 = vi.fn().mockResolvedValue(new Response('x', { status: 500 }));
    await expect(
      ensureLineUserIdDefinition(STORE, TOKEN, fetch500 as unknown as typeof fetch),
    ).rejects.toThrow('HTTP 500');
    const fetchErr = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: 'boom' }] }));
    await expect(
      ensureLineUserIdDefinition(STORE, TOKEN, fetchErr as unknown as typeof fetch),
    ).rejects.toThrow('boom');
  });
});

// ============================================================
// readCustomerLineUserIdMetafield
// ============================================================

describe('readCustomerLineUserIdMetafield', () => {
  it('値を直読して返す / 未設定は null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ data: { customer: { metafield: { value: LINE_ID_1 } } } }),
    );
    expect(
      await readCustomerLineUserIdMetafield(STORE, TOKEN, '100', fetchImpl as unknown as typeof fetch),
    ).toBe(LINE_ID_1);
    const fetchNull = vi.fn().mockResolvedValue(jsonResponse({ data: { customer: { metafield: null } } }));
    expect(
      await readCustomerLineUserIdMetafield(STORE, TOKEN, '100', fetchNull as unknown as typeof fetch),
    ).toBeNull();
  });

  it('数値以外の customerId は fetch せず null (gid 注入防止)', async () => {
    const fetchImpl = vi.fn();
    expect(
      await readCustomerLineUserIdMetafield(
        STORE,
        TOKEN,
        'abc"} evil',
        fetchImpl as unknown as typeof fetch,
      ),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ============================================================
// listLinkedFriends / countLinkedFriends
// ============================================================

describe('listLinkedFriends / countLinkedFriends', () => {
  it('連携済み (両カラム非NULL) のみ・id 順・limit/offset を実評価', async () => {
    const db = createFakeDb([
      { id: 'f3', line_user_id: 'U3', shopify_customer_id: '300' },
      ...FRIENDS,
      { id: 'f9', line_user_id: 'U9', shopify_customer_id: null }, // 未連携
      { id: 'f0', line_user_id: null, shopify_customer_id: '400' }, // 異常データ
    ]);
    expect(await countLinkedFriends(db)).toBe(3);
    expect((await listLinkedFriends(db, 2, 0)).map((r) => r.id)).toEqual(['f1', 'f2']);
    expect((await listLinkedFriends(db, 2, 2)).map((r) => r.id)).toEqual(['f3']);
    expect(await listLinkedFriends(db, 10, 3)).toEqual([]);
  });
});

// ============================================================
// migrateLineUserIdMetafields
// ============================================================

describe('migrateLineUserIdMetafields', () => {
  it('dryRun: 総数/残数のみ返し、token 取得・Shopify 呼び出しゼロ・audit も書かない', async () => {
    const db = createFakeDb(FRIENDS);
    const getTokenImpl = vi.fn();
    const setMetafieldImpl = vi.fn();
    const fetchImpl = vi.fn();
    const r = await migrateLineUserIdMetafields(migrationEnv(db), { dryRun: true }, {
      getTokenImpl,
      setMetafieldImpl,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toMatchObject({
      dryRun: true,
      candidatesTotal: 2,
      processed: 2,
      remaining: 0,
      definition: 'skipped_dry_run',
      written: 0,
    });
    expect(getTokenImpl).not.toHaveBeenCalled();
    expect(setMetafieldImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockAuditSystem).not.toHaveBeenCalled();
  });

  it('execute: 定義作成 + 全件書込 + 直読検証 all green → success audit (PII 非含有)', async () => {
    const db = createFakeDb(FRIENDS);
    // fetch は 定義作成 1 回 + 直読 2 回。直読は customerId ごとに正しい line_user_id を返す
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (String(body.query).includes('metafieldDefinitionCreate')) {
        return jsonResponse({
          data: { metafieldDefinitionCreate: { createdDefinition: { id: 'g1' }, userErrors: [] } },
        });
      }
      const cid = String(body.variables.id).replace('gid://shopify/Customer/', '');
      const value = cid === '100' ? LINE_ID_1 : LINE_ID_2;
      return jsonResponse({ data: { customer: { metafield: { value } } } });
    });
    const setMetafieldImpl = vi.fn().mockResolvedValue({ ok: true, userErrors: [] });
    const getTokenImpl = vi.fn().mockResolvedValue(TOKEN);

    const r = await migrateLineUserIdMetafields(migrationEnv(db), { dryRun: false }, {
      getTokenImpl: getTokenImpl as never,
      setMetafieldImpl: setMetafieldImpl as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r).toMatchObject({
      definition: 'created',
      candidatesTotal: 2,
      processed: 2,
      remaining: 0,
      written: 2,
      writeErrors: 0,
      failed: 0,
      verifiedDirect: 2,
      verifyMismatch: 0,
      verifyFailed: 0,
    });
    // 書込は lineharness.line_user_id へ
    expect(setMetafieldImpl).toHaveBeenCalledWith(
      STORE,
      TOKEN,
      '100',
      LINEHARNESS_METAFIELD_NAMESPACE,
      LINEHARNESS_METAFIELD_KEY,
      LINE_ID_1,
      expect.anything(),
    );
    // audit は成功 + 件数のみ (LINE userId を含まない = PII 最小化)
    expect(mockAuditSystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'line_metafield_migration.completed', result: 'success' }),
    );
    const auditDump = JSON.stringify(mockAuditSystem.mock.calls);
    expect(auditDump).not.toContain(LINE_ID_1);
    expect(auditDump).not.toContain(LINE_ID_2);
  });

  it('🚨採点R1 HIGH: チャンク実行 — offset/limit で分割し remaining で前進が見える (subrequest 50 上限対策)', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `f${String(i).padStart(3, '0')}`,
      line_user_id: `U${String(i).padStart(31, '0')}`,
      shopify_customer_id: String(1000 + i),
    }));
    const db = createFakeDb(many);
    const setMetafieldImpl = vi.fn().mockResolvedValue({ ok: true, userErrors: [] });
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (String(body.query).includes('metafieldDefinitionCreate')) {
        return jsonResponse({
          data: { metafieldDefinitionCreate: { createdDefinition: { id: 'g1' }, userErrors: [] } },
        });
      }
      const cid = String(body.variables.id).replace('gid://shopify/Customer/', '');
      const idx = Number(cid) - 1000;
      return jsonResponse({
        data: { customer: { metafield: { value: `U${String(idx).padStart(31, '0')}` } } },
      });
    });
    const deps = {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      setMetafieldImpl: setMetafieldImpl as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    // チャンク1 (offset=0, limit=10): 定義作成あり
    const c1 = await migrateLineUserIdMetafields(migrationEnv(db), { dryRun: false, limit: 10, offset: 0 }, deps);
    expect(c1).toMatchObject({ candidatesTotal: 25, processed: 10, remaining: 15, definition: 'created', written: 10, verifiedDirect: 10 });
    // 1 チャンクの外部 fetch = 定義 1 + 直読 10 = 11 (書込は mock)。50 上限に対する予算検証
    expect(fetchImpl.mock.calls.length).toBe(11);

    // チャンク2 (offset=10): 定義作成は skip (subrequest 節約)
    const c2 = await migrateLineUserIdMetafields(migrationEnv(db), { dryRun: false, limit: 10, offset: 10 }, deps);
    expect(c2).toMatchObject({ processed: 10, remaining: 5, definition: 'skipped_offset' });

    // チャンク3 (offset=20): 端数 → remaining=0 で完了が判る
    const c3 = await migrateLineUserIdMetafields(migrationEnv(db), { dryRun: false, limit: 10, offset: 20 }, deps);
    expect(c3).toMatchObject({ processed: 5, remaining: 0 });
    expect(c1.written + c2.written + c3.written).toBe(25);

    // limit は上限にクランプされる (無制限指定で subrequest 超過しない)
    const clamped = await migrateLineUserIdMetafields(migrationEnv(db), { dryRun: true, limit: 999 }, deps);
    expect(clamped.limit).toBe(__test__.MIGRATION_MAX_LIMIT);
  });

  it('0 件 (未連携ストア) でも安全に完走し remaining=0', async () => {
    const db = createFakeDb([]);
    const r = await migrateLineUserIdMetafields(migrationEnv(db), { dryRun: true });
    expect(r).toMatchObject({ candidatesTotal: 0, processed: 0, remaining: 0 });
  });

  it('部分失敗でも継続: 1 件 throw + 1 件 userError → 他は書込・検証される + failure audit', async () => {
    const db = createFakeDb([
      ...FRIENDS,
      { id: 'f5', line_user_id: 'U5555555555555555555555555555555', shopify_customer_id: '500' },
    ]);
    const setMetafieldImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, userErrors: [] }) // f1
      .mockRejectedValueOnce(new Error('Shopify 500')) // f2
      .mockResolvedValueOnce({ ok: false, userErrors: ['metafield locked'] }); // f5
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (String(body.query).includes('metafieldDefinitionCreate')) {
        return jsonResponse({
          data: { metafieldDefinitionCreate: { createdDefinition: null, userErrors: [{ code: 'TAKEN', message: 'taken' }] } },
        });
      }
      return jsonResponse({ data: { customer: { metafield: { value: LINE_ID_1 } } } });
    });

    const r = await migrateLineUserIdMetafields(migrationEnv(db), { dryRun: false }, {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      setMetafieldImpl: setMetafieldImpl as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r.definition).toBe('exists');
    expect(r.written).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.writeErrors).toBe(1);
    expect(r.firstError).toContain('Shopify 500');
    // 直読検証: f1 のみ一致 (他は値不一致 = mismatch として可視化)
    expect(r.verifiedDirect).toBe(1);
    expect(r.verifyMismatch).toBe(2);
    expect(mockAuditSystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure' }),
    );
  });

  it('🚨採点R1: 直読が transport 失敗 (verifyFailed) でも audit は failure (検証未完了を success にしない)', async () => {
    const db = createFakeDb(FRIENDS.slice(0, 1));
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (String(body.query).includes('metafieldDefinitionCreate')) {
        return jsonResponse({
          data: { metafieldDefinitionCreate: { createdDefinition: { id: 'g' }, userErrors: [] } },
        });
      }
      return new Response('x', { status: 500 }); // 直読 transport 失敗
    });
    const r = await migrateLineUserIdMetafields(migrationEnv(db), { dryRun: false }, {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      setMetafieldImpl: vi.fn().mockResolvedValue({ ok: true, userErrors: [] }) as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.verifyFailed).toBe(1);
    expect(mockAuditSystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure' }),
    );
  });

  it('SHOPIFY_STORE_DOMAIN 未設定は throw (誤って空移行を成功扱いしない)', async () => {
    const db = createFakeDb(FRIENDS);
    await expect(
      migrateLineUserIdMetafields({ DB: db }, { dryRun: false }),
    ).rejects.toThrow('SHOPIFY_STORE_DOMAIN');
  });
});

// ============================================================
// verifySearchPathParity
// ============================================================

describe('verifySearchPathParity', () => {
  it('検索経路で全件同一 customer に解決 → resolved (連携経路無停止の実証)', async () => {
    const db = createFakeDb(FRIENDS);
    const findByLineIdImpl = vi
      .fn()
      .mockImplementation(async (_s: string, _t: string, ns: string, key: string, lineId: string) => {
        // friend-customer-linker と同じ引数形で、新 namespace が渡ることも検証
        expect(ns).toBe(LINEHARNESS_METAFIELD_NAMESPACE);
        expect(key).toBe(LINEHARNESS_METAFIELD_KEY);
        return { customerId: lineId === LINE_ID_1 ? '100' : '200', email: null };
      });
    const r = await verifySearchPathParity(migrationEnv(db), {}, {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      findByLineIdImpl: findByLineIdImpl as never,
    });
    expect(r).toMatchObject({
      candidatesTotal: 2,
      processed: 2,
      resolved: 2,
      unresolved: 0,
      failed: 0,
      namespace: LINEHARNESS_METAFIELD_NAMESPACE,
      key: LINEHARNESS_METAFIELD_KEY,
      nsSource: 'default',
    });
  });

  it('🚨採点R1: useSecret=1 は FRIEND_LINK secret の実効値で検証し、応答で切替結果を目視確認できる', async () => {
    const db = createFakeDb(FRIENDS);
    const findByLineIdImpl = vi.fn().mockImplementation(
      async (_s: string, _t: string, ns: string, key: string, lineId: string) => {
        expect(ns).toBe('lineharness');
        expect(key).toBe('line_user_id');
        return { customerId: lineId === LINE_ID_1 ? '100' : '200', email: null };
      },
    );
    const r = await verifySearchPathParity(
      migrationEnv(db, {
        FRIEND_LINK_METAFIELD_NAMESPACE: 'lineharness',
        FRIEND_LINK_METAFIELD_KEY: 'line_user_id',
      }),
      { useSecret: true },
      {
        getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
        findByLineIdImpl: findByLineIdImpl as never,
      },
    );
    expect(r).toMatchObject({ namespace: 'lineharness', key: 'line_user_id', nsSource: 'friend_link_secret', resolved: 2 });
  });

  it('🚨採点R1: useSecret=1 で secret 未設定/構文不正 (CRLF trap 等) は throw して露見させる', async () => {
    const db = createFakeDb(FRIENDS);
    await expect(
      verifySearchPathParity(migrationEnv(db), { useSecret: true }, {
        getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      }),
    ).rejects.toThrow('FRIEND_LINK_METAFIELD_NAMESPACE');
    await expect(
      verifySearchPathParity(
        migrationEnv(db, {
          FRIEND_LINK_METAFIELD_NAMESPACE: 'lineharness\r', // PowerShell CRLF trap 再現
          FRIEND_LINK_METAFIELD_KEY: 'line_user_id',
        }),
        { useSecret: true },
        { getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never },
      ),
    ).rejects.toThrow('不正');
  });

  it('別 customer / 未解決は unresolved、throw は failed。audit に firstError (PII 混入源) を残さない', async () => {
    const db = createFakeDb([
      ...FRIENDS,
      { id: 'f5', line_user_id: 'U5555555555555555555555555555555', shopify_customer_id: '500' },
    ]);
    const findByLineIdImpl = vi
      .fn()
      .mockResolvedValueOnce({ customerId: '999', email: null }) // f1 → 別 customer
      .mockResolvedValueOnce(null) // f2 → 未解決 (index 未反映等)
      .mockRejectedValueOnce(new Error(`Shopify down for ${LINE_ID_1}`)); // エラー文に PII が混入するケース
    const r = await verifySearchPathParity(migrationEnv(db), {}, {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      findByLineIdImpl: findByLineIdImpl as never,
    });
    expect(r).toMatchObject({ candidatesTotal: 3, resolved: 0, unresolved: 2, failed: 1 });
    expect(r.firstError).toContain('Shopify down'); // 応答 (認可済み) には返す
    expect(mockAuditSystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'line_metafield_migration.search_parity', result: 'failure' }),
    );
    // audit (append-only) には firstError を展開しない = LINE userId が残らない
    expect(JSON.stringify(mockAuditSystem.mock.calls)).not.toContain(LINE_ID_1);
  });

  it('offset チャンク: processed が slice 分のみで candidatesTotal は全体', async () => {
    const db = createFakeDb([
      ...FRIENDS,
      { id: 'f5', line_user_id: 'U5555555555555555555555555555555', shopify_customer_id: '500' },
    ]);
    const findByLineIdImpl = vi.fn().mockResolvedValue({ customerId: '500', email: null });
    const r = await verifySearchPathParity(migrationEnv(db), { limit: 1, offset: 2 }, {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      findByLineIdImpl: findByLineIdImpl as never,
    });
    expect(r).toMatchObject({ candidatesTotal: 3, processed: 1, resolved: 1, offset: 2, limit: 1 });
    expect(findByLineIdImpl).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// auditLegacyMetafieldValues (旧 namespace 棚卸し)
// ============================================================

describe('auditLegacyMetafieldValues', () => {
  const scanPage = (
    nodes: Array<{ id: string; value: string | null }>,
    hasNextPage: boolean,
    endCursor: string | null,
  ) =>
    jsonResponse({
      data: {
        customers: {
          pageInfo: { hasNextPage, endCursor },
          edges: nodes.map((n) => ({
            node: {
              id: `gid://shopify/Customer/${n.id}`,
              metafield: n.value == null ? null : { value: n.value },
            },
          })),
        },
      },
    });

  it('socialplus.line 値持ち customer を D1 と照合: 全員リンク済みなら unmatched 空 + 算術閉包 + audit 記録', async () => {
    const db = createFakeDb(FRIENDS);
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      scanPage(
        [
          { id: '100', value: LINE_ID_1 }, // D1 リンク済み
          { id: '300', value: null }, // 値なし → 対象外
        ],
        false,
        null,
      ),
    );
    const r = await auditLegacyMetafieldValues(migrationEnv(db), {}, {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toMatchObject({
      pagesScanned: 1,
      customersScanned: 2,
      withLegacyValue: 1,
      matchedInD1: 1,
      unmatchedTotal: 0,
      unmatchedCustomerIds: [],
      matchFailed: 0,
      nextCursor: null,
    });
    // 算術閉包: 値持ち全件が照合済み
    expect(r.matchedInD1 + r.unmatchedTotal + r.matchFailed).toBe(r.withLegacyValue);
    // 旧 namespace (socialplus.line) を読んでいることを検証
    const sent = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.variables.ns).toBe('socialplus');
    expect(sent.variables.key).toBe('line');
    // 不可逆ゲートの永続証跡 (件数のみ、customer id を残さない)
    expect(mockAuditSystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'line_metafield_migration.legacy_audit', result: 'success' }),
    );
    expect(JSON.stringify(mockAuditSystem.mock.calls)).not.toContain('"100"');
  });

  it('D1 に無い値持ち customer は unmatchedTotal + id 列挙 (取り漏らし検出) → audit failure', async () => {
    const db = createFakeDb(FRIENDS);
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      scanPage([{ id: '999', value: 'U_orphan' }], false, null),
    );
    const r = await auditLegacyMetafieldValues(migrationEnv(db), {}, {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.withLegacyValue).toBe(1);
    expect(r.matchedInD1).toBe(0);
    expect(r.unmatchedTotal).toBe(1);
    expect(r.unmatchedCustomerIds).toEqual(['999']);
    expect(mockAuditSystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'line_metafield_migration.legacy_audit', result: 'failure' }),
    );
    // 採点R3: 漏洩が実際に起こりうるシナリオ (unmatched あり) で id 非含有を検証
    expect(JSON.stringify(mockAuditSystem.mock.calls)).not.toContain('999');
  });

  it('🚨採点R3: gid 解釈不能な値持ち customer も matchFailed に計上され閉包が保たれる', async () => {
    const db = createFakeDb(FRIENDS);
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: {
          customers: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [
              // customer 以外の gid = normalizeShopifyCustomerId が null を返す
              { node: { id: 'gid://shopify/Order/12345', metafield: { value: 'U_weird' } } },
              { node: { id: 'gid://shopify/Customer/100', metafield: { value: LINE_ID_1 } } },
            ],
          },
        },
      }),
    );
    const r = await auditLegacyMetafieldValues(migrationEnv(db), {}, {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.withLegacyValue).toBe(2);
    expect(r.matchFailed).toBe(1);
    expect(r.firstError).toBe('unparseable customer gid');
    expect(r.matchedInD1 + r.unmatchedTotal + r.matchFailed).toBe(r.withLegacyValue); // 閉包維持
    expect(mockAuditSystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure' }),
    );
  });

  it('🚨採点R2 HIGH: D1 照合 throw は matchFailed に計上され閉包が破れない (swallow で偽 green にしない)', async () => {
    // fake D1 の first() を throw させる: shopify_customer_id 照合クエリだけ失敗させる
    const db = createFakeDb(FRIENDS);
    const origPrepare = (db as unknown as { prepare: (sql: string) => unknown }).prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes('WHERE shopify_customer_id = ?')) {
        return { bind: () => ({ first: async () => { throw new Error('database is locked'); } }) };
      }
      return origPrepare(sql);
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      scanPage([{ id: '999', value: 'U_orphan' }], false, null),
    );
    const r = await auditLegacyMetafieldValues(migrationEnv(db), {}, {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.matchFailed).toBe(1);
    expect(r.firstError).toContain('database is locked');
    expect(r.matchedInD1 + r.unmatchedTotal + r.matchFailed).toBe(r.withLegacyValue); // 閉包維持
    expect(mockAuditSystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure' }),
    );
  });

  it('🚨採点R2: D1 照合予算切れはページ開始前に判定し、nextCursor 付きで再開可能 (完遂不能にならない)', async () => {
    // page1 に値持ち 60 件 (すべて D1 未リンク) → matchChecks=60。
    // page2 開始前: 60 + 250 > 300 (CAP) → capped + nextCursor=page1 の endCursor
    const db = createFakeDb(FRIENDS);
    const manyValued = Array.from({ length: 60 }, (_, i) => ({
      id: String(9000 + i),
      value: `U_legacy_${i}`,
    }));
    const fetchImpl = vi.fn().mockResolvedValueOnce(scanPage(manyValued, true, 'cur-page2'));
    const r = await auditLegacyMetafieldValues(migrationEnv(db), {}, {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.pagesScanned).toBe(1);
    expect(r.matchingCapped).toBe(true);
    expect(r.nextCursor).toBe('cur-page2'); // 再開点 = 未走査ページの先頭
    expect(r.withLegacyValue).toBe(60);
    expect(r.unmatchedTotal).toBe(60); // 全件照合済み (走査済みなのに未照合、が存在しない)
    expect(r.unmatchedCustomerIds.length).toBe(20); // 列挙は 20 件に制限、総数は unmatchedTotal
    expect(r.matchedInD1 + r.unmatchedTotal + r.matchFailed).toBe(r.withLegacyValue);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // page2 は fetch すらしない (予算前判定)
  });

  it('複数ページを cursor で辿り、MAX_PAGES 到達で nextCursor を返す (呼び出し側が続行)', async () => {
    const db = createFakeDb(FRIENDS);
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => scanPage([{ id: '100', value: null }], true, 'cur-next'));
    const r = await auditLegacyMetafieldValues(migrationEnv(db), { cursor: 'cur-0' }, {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.pagesScanned).toBe(__test__.LEGACY_AUDIT_MAX_PAGES);
    expect(r.nextCursor).toBe('cur-next');
    // 初回呼び出しに引き継ぎ cursor が渡る
    const first = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(first.variables.after).toBe('cur-0');
  });

  it('CAP はページサイズ以上 (mid-page cap を構造的に排除する不変条件)', () => {
    expect(__test__.LEGACY_AUDIT_MATCH_CAP).toBeGreaterThanOrEqual(__test__.LEGACY_AUDIT_PAGE_SIZE);
  });
});

// ============================================================
// verify の limit クランプ / remaining
// ============================================================

describe('verifySearchPathParity — limit クランプと remaining', () => {
  it('limit=999 は VERIFY_MAX_LIMIT にクランプ、remaining で進捗が判る', async () => {
    const db = createFakeDb(FRIENDS);
    const findByLineIdImpl = vi.fn().mockResolvedValue({ customerId: '100', email: null });
    const r = await verifySearchPathParity(migrationEnv(db), { limit: 999, offset: 1 }, {
      getTokenImpl: vi.fn().mockResolvedValue(TOKEN) as never,
      findByLineIdImpl: findByLineIdImpl as never,
    });
    expect(r.limit).toBe(__test__.VERIFY_MAX_LIMIT);
    expect(r.remaining).toBe(0); // offset=1 + processed=1 = candidatesTotal=2
  });
});

// ============================================================
// 実関数 × 新定数の整合 (採点R1: mock 注入だけでは allowlist 乖離を検出できない)
// ============================================================

describe('lineharness 定数と既存 allowlist の整合', () => {
  it('setCustomerLineUserIdMetafield (実関数) が lineharness/line_user_id を allowlist 通過させる', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ data: { metafieldsSet: { metafields: [{ id: 'm1' }], userErrors: [] } } }),
    );
    const r = await setCustomerLineUserIdMetafield(
      STORE,
      TOKEN,
      '100',
      LINEHARNESS_METAFIELD_NAMESPACE,
      LINEHARNESS_METAFIELD_KEY,
      LINE_ID_1,
      fetchImpl as unknown as typeof fetch,
    );
    expect(r.ok).toBe(true); // allowlist (SAFE_METAFIELD_PART) で invalid_metafield にならない
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
