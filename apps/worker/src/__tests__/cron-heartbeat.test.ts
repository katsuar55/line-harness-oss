/**
 * Tests for withHeartbeat (Phase 7 cron heartbeat wrapper).
 *
 * 対象: apps/worker/src/services/cron-heartbeat.ts
 *
 * テストする保証:
 * 1. fn 成功時 status='success' で 1 行 INSERT
 * 2. fn 失敗時 status='error' で 1 行 INSERT + error 再 throw
 * 3. metrics extractor が呼ばれて metrics が JSON 化される
 * 4. heartbeat INSERT 失敗は元の戻り値に影響しない (swallow)
 * 5. 元の関数の戻り値は完全に透過される
 * 6. extractor が throw しても heartbeat は記録される
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @line-crm/db
const insertCalls: Array<Record<string, unknown>> = [];
let insertShouldThrow = false;

vi.mock('@line-crm/db', () => ({
  insertCronRunLog: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    insertCalls.push({ ...input });
    if (insertShouldThrow) {
      throw new Error('simulated D1 failure');
    }
  }),
}));

import { withHeartbeat } from '../services/cron-heartbeat.js';

const mockDb = {} as D1Database;

describe('withHeartbeat', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    insertShouldThrow = false;
  });

  it('fn 成功時 status=success で 1 行 INSERT する', async () => {
    const result = await withHeartbeat(mockDb, 'test-job', async () => 'OK');
    expect(result).toBe('OK');
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ jobName: 'test-job', status: 'success' });
  });

  it('fn 失敗時 status=error で INSERT + error を再 throw する', async () => {
    await expect(
      withHeartbeat(mockDb, 'fail-job', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      jobName: 'fail-job',
      status: 'error',
      errorSummary: 'boom',
    });
  });

  it('metrics extractor の戻り値を metrics として記録', async () => {
    const result = await withHeartbeat(
      mockDb,
      'metrics-job',
      async () => ({ pushed: 5, skipped: 2 }),
      (r) => ({ pushed: r.pushed, skipped: r.skipped }),
    );
    expect(result).toEqual({ pushed: 5, skipped: 2 });
    expect(insertCalls[0]?.metrics).toEqual({ pushed: 5, skipped: 2 });
  });

  it('heartbeat INSERT 失敗は元の戻り値に影響しない (success path)', async () => {
    insertShouldThrow = true;
    const result = await withHeartbeat(mockDb, 'swallow-job', async () => 42);
    expect(result).toBe(42);
    expect(insertCalls).toHaveLength(1); // 試行はされる
  });

  it('heartbeat INSERT 失敗は error 再 throw を阻害しない', async () => {
    insertShouldThrow = true;
    await expect(
      withHeartbeat(mockDb, 'swallow-error', async () => {
        throw new Error('original error');
      }),
    ).rejects.toThrow('original error');
    expect(insertCalls).toHaveLength(1);
  });

  it('extractor が throw しても heartbeat は success として記録される', async () => {
    const result = await withHeartbeat(
      mockDb,
      'bad-extractor',
      async () => 'OK',
      () => {
        throw new Error('extractor blew up');
      },
    );
    expect(result).toBe('OK');
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.status).toBe('success');
    // extractor が失敗した場合は metrics undefined
    expect(insertCalls[0]?.metrics).toBeUndefined();
  });

  it('元の関数の戻り値型が型安全に透過される (型アサーション)', async () => {
    interface CustomResult {
      count: number;
      label: string;
    }
    const result: CustomResult = await withHeartbeat<CustomResult>(
      mockDb,
      'typed-job',
      async () => ({ count: 7, label: 'hi' }),
    );
    expect(result.count).toBe(7);
    expect(result.label).toBe('hi');
  });

  it('非 Error throw 値も errorSummary に文字列化される', async () => {
    await expect(
      withHeartbeat(mockDb, 'string-throw', async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'literal string';
      }),
    ).rejects.toBe('literal string');
    expect(insertCalls[0]?.errorSummary).toBe('literal string');
  });
});
