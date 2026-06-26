/**
 * Unit tests for @line-crm/db webhook-deliveries helpers (= LINE webhook 冪等化, 2026-06-26)
 *
 * 実 @line-crm/db 関数 (recordWebhookDelivery / pruneWebhookDeliveries) を fake D1 で直接 test する。
 *
 * NOTE: 本ファイルは意図的に `vi.mock('@line-crm/db')` を **呼ばない** (= 実装を exercise するため)。
 *       vi.mock は file scope なので他 test に影響なし (= membership-db.test.ts と同方針)。
 */
import { describe, it, expect } from 'vitest';
import { recordWebhookDelivery, pruneWebhookDeliveries } from '@line-crm/db';

interface FakeRunState {
  calls: { sql: string; params: unknown[] }[];
  /** run() が返す meta (= 未指定なら meta 欠落をシミュレート) */
  metaToReturn?: { changes?: number };
  shouldThrow?: boolean;
}

function makeFakeDb(state: FakeRunState): D1Database {
  return {
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] };
      return {
        bind(...params: unknown[]) {
          call.params = params;
          return {
            async run() {
              state.calls.push(call);
              if (state.shouldThrow) throw new Error('D1 down');
              return { success: true, meta: state.metaToReturn };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('recordWebhookDelivery', () => {
  it('changes===1 (= 新規挿入) → true、 INSERT OR IGNORE + 正しい bind', async () => {
    const state: FakeRunState = { calls: [], metaToReturn: { changes: 1 } };
    const isNew = await recordWebhookDelivery(
      makeFakeDb(state),
      'evt-1',
      '2026-06-26T00:00:00.000Z',
    );
    expect(isNew).toBe(true);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]!.sql).toContain('INSERT OR IGNORE INTO webhook_deliveries');
    expect(state.calls[0]!.params).toEqual(['evt-1', '2026-06-26T00:00:00.000Z']);
  });

  it('changes===0 (= 重複, IGNORE 発火) → false', async () => {
    const state: FakeRunState = { calls: [], metaToReturn: { changes: 0 } };
    const isNew = await recordWebhookDelivery(
      makeFakeDb(state),
      'evt-dup',
      '2026-06-26T00:00:00.000Z',
    );
    expect(isNew).toBe(false);
  });

  it('meta 欠落 → false (= 新規と誤判定しない、 安全側)', async () => {
    const state: FakeRunState = { calls: [], metaToReturn: undefined };
    const isNew = await recordWebhookDelivery(
      makeFakeDb(state),
      'evt-x',
      '2026-06-26T00:00:00.000Z',
    );
    expect(isNew).toBe(false);
  });

  it('DB throw → 呼出元へ伝播 (= caller が fail-open で握る設計)', async () => {
    const state: FakeRunState = { calls: [], shouldThrow: true };
    await expect(
      recordWebhookDelivery(makeFakeDb(state), 'evt-e', '2026-06-26T00:00:00.000Z'),
    ).rejects.toThrow();
  });
});

describe('pruneWebhookDeliveries', () => {
  it('DELETE WHERE created_at < cutoff、 削除行数を返す', async () => {
    const state: FakeRunState = { calls: [], metaToReturn: { changes: 7 } };
    const deleted = await pruneWebhookDeliveries(
      makeFakeDb(state),
      '2026-06-24T00:00:00.000Z',
    );
    expect(deleted).toBe(7);
    expect(state.calls[0]!.sql).toContain('DELETE FROM webhook_deliveries WHERE created_at < ?');
    expect(state.calls[0]!.params).toEqual(['2026-06-24T00:00:00.000Z']);
  });

  it('meta 欠落 → 0', async () => {
    const state: FakeRunState = { calls: [], metaToReturn: undefined };
    const deleted = await pruneWebhookDeliveries(
      makeFakeDb(state),
      '2026-06-24T00:00:00.000Z',
    );
    expect(deleted).toBe(0);
  });
});
