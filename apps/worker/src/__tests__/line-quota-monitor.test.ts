/**
 * Tests for line-quota-monitor service (LSTEP audit H4、 2026-05-22)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkLineQuota } from '../services/line-quota-monitor.js';
import type { Logger } from '../services/logger.js';
import type { LineClient } from '@line-crm/line-sdk';

const FIXED_NOW = new Date('2026-05-22T12:00:00.000Z').getTime();

interface AuditRow {
  id: string;
  action: string;
  result: string;
  created_at: string;
}

/**
 * FakeDb: audit_logs に対する SQL を mock。
 *   - SELECT created_at (= cooldown check)
 *   - INSERT INTO audit_logs (= alert 記録)
 */
class FakeDb {
  rows: AuditRow[] = [];
  alertInserts: AuditRow[] = [];
  prepareThrows = false;

  prepare(sql: string) {
    if (this.prepareThrows) {
      throw new Error('D1 broken');
    }
    const isLastAlert =
      /SELECT created_at FROM audit_logs/i.test(sql) &&
      /ORDER BY created_at DESC LIMIT 1/.test(sql);
    const isInsert = /INSERT INTO audit_logs/i.test(sql);

    return {
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (isLastAlert) {
            const targetAction = params[0] as string;
            const cooldownSince = params[1] as string;
            const last = this.rows
              .filter((r) => r.action === targetAction && r.created_at >= cooldownSince)
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
            return last ? { created_at: last.created_at } : null;
          }
          if (isInsert) {
            const id = params[0] as string;
            const found = this.rows.find((r) => r.id === id);
            return found ?? null;
          }
          return null;
        },
        run: async () => {
          if (!isInsert) return { success: true };
          // INSERT INTO audit_logs (id, line_account_id, actor_type, actor_id, actor_name, action,
          //   target_type, target_id, request_id, ip_hash, user_agent, before_value, after_value,
          //   result, error_message, metadata, created_at)
          const row: AuditRow = {
            id: params[0] as string,
            action: params[5] as string,
            result: params[13] as string,
            created_at: params[16] as string,
          };
          this.rows.push(row);
          this.alertInserts.push(row);
          return { success: true, meta: { changes: 1 } };
        },
      }),
    };
  }
}

function mockLogger(): Logger & {
  errorMock: ReturnType<typeof vi.fn>;
  warnMock: ReturnType<typeof vi.fn>;
} {
  const errorMock = vi.fn();
  const warnMock = vi.fn();
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: errorMock,
    fatal: vi.fn(),
    errorMock,
    warnMock,
  };
}

function makeLineClient(quota: { type: 'none' | 'limited'; value?: number }, usage: number): LineClient {
  return {
    getMessageQuota: vi.fn().mockResolvedValue(quota),
    getMessageQuotaConsumption: vi.fn().mockResolvedValue({ totalUsage: usage }),
  } as unknown as LineClient;
}

function makeFailingLineClient(): LineClient {
  return {
    getMessageQuota: vi.fn().mockRejectedValue(new Error('LINE API 500')),
    getMessageQuotaConsumption: vi.fn().mockRejectedValue(new Error('LINE API 500')),
  } as unknown as LineClient;
}

describe('checkLineQuota', () => {
  beforeEach(() => vi.clearAllMocks());

  it('unlimited plan (type=none) → skip', async () => {
    const db = new FakeDb();
    const logger = mockLogger();
    const line = makeLineClient({ type: 'none' }, 5000);

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.unlimited).toBe(true);
    expect(result.alerted).toBe(false);
    expect(result.skipReason).toBe('unlimited');
    expect(logger.errorMock).not.toHaveBeenCalled();
    expect(logger.warnMock).not.toHaveBeenCalled();
    expect(db.alertInserts.length).toBe(0);
  });

  it('below 80% threshold → no alert', async () => {
    const db = new FakeDb();
    const logger = mockLogger();
    const line = makeLineClient({ type: 'limited', value: 1000 }, 500); // 50%

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(false);
    expect(result.skipReason).toBe('below_threshold');
    expect(result.ratio).toBe(0.5);
    expect(result.severity).toBeUndefined();
    expect(logger.errorMock).not.toHaveBeenCalled();
    expect(logger.warnMock).not.toHaveBeenCalled();
    expect(db.alertInserts.length).toBe(0);
  });

  it('exactly 80% → severity=warning, logger.warn 発火', async () => {
    const db = new FakeDb();
    const logger = mockLogger();
    const line = makeLineClient({ type: 'limited', value: 1000 }, 800); // 80%

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(true);
    expect(result.severity).toBe('warning');
    expect(result.ratio).toBe(0.8);
    expect(logger.warnMock).toHaveBeenCalledTimes(1);
    expect(logger.errorMock).not.toHaveBeenCalled();
    const [msg, fields] = logger.warnMock.mock.calls[0];
    expect(msg).toMatch(/warning/);
    expect((fields as Record<string, unknown>).percentDisplay).toBe('80.0%');
    expect((fields as Record<string, unknown>).severity).toBe('WARN');
    expect(db.alertInserts.length).toBe(1);
    expect(db.alertInserts[0].action).toBe('line_quota_monitor.warning');
  });

  it('exactly 95% → severity=critical, logger.error 発火', async () => {
    const db = new FakeDb();
    const logger = mockLogger();
    const line = makeLineClient({ type: 'limited', value: 1000 }, 950); // 95%

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(true);
    expect(result.severity).toBe('critical');
    expect(logger.errorMock).toHaveBeenCalledTimes(1);
    expect(logger.warnMock).not.toHaveBeenCalled();
    expect(db.alertInserts[0].action).toBe('line_quota_monitor.critical');
  });

  it('exactly 100% (= reached) → severity=reached', async () => {
    const db = new FakeDb();
    const logger = mockLogger();
    const line = makeLineClient({ type: 'limited', value: 1000 }, 1000); // 100%

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(true);
    expect(result.severity).toBe('reached');
    expect(logger.errorMock).toHaveBeenCalledTimes(1);
    expect(db.alertInserts[0].action).toBe('line_quota_monitor.reached');
  });

  it('overflow (= usage > limit) → reached', async () => {
    const db = new FakeDb();
    const logger = mockLogger();
    const line = makeLineClient({ type: 'limited', value: 1000 }, 1234); // 123.4%

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(true);
    expect(result.severity).toBe('reached');
    expect(result.ratio).toBeCloseTo(1.234, 3);
  });

  it('value=0 (= 異常 plan response) → unlimited 扱いで skip', async () => {
    const db = new FakeDb();
    const logger = mockLogger();
    const line = makeLineClient({ type: 'limited', value: 0 }, 100);

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(false);
    expect(result.skipReason).toBe('unlimited');
  });

  it('cooldown 内 (= 12h 前 alert あり) → no alert', async () => {
    const db = new FakeDb();
    // 12h 前に warning alert 済
    db.rows.push({
      id: 'prev',
      action: 'line_quota_monitor.warning',
      result: 'success',
      created_at: new Date(FIXED_NOW - 12 * 60 * 60 * 1000).toISOString(),
    });
    const logger = mockLogger();
    const line = makeLineClient({ type: 'limited', value: 1000 }, 850); // 85%

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(false);
    expect(result.skipReason).toBe('cooldown');
    expect(result.severity).toBe('warning');
    expect(logger.warnMock).not.toHaveBeenCalled();
    expect(db.alertInserts.length).toBe(0);
  });

  it('cooldown 経過後 (= 25h 前 alert) → alert 再発火', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'old',
      action: 'line_quota_monitor.warning',
      result: 'success',
      created_at: new Date(FIXED_NOW - 25 * 60 * 60 * 1000).toISOString(),
    });
    const logger = mockLogger();
    const line = makeLineClient({ type: 'limited', value: 1000 }, 850);

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(true);
    expect(logger.warnMock).toHaveBeenCalledTimes(1);
    expect(db.alertInserts.length).toBe(1);
  });

  it('severity 別 cooldown は独立 (= warning 済でも critical は出る)', async () => {
    const db = new FakeDb();
    // warning は 1h 前
    db.rows.push({
      id: 'w',
      action: 'line_quota_monitor.warning',
      result: 'success',
      created_at: new Date(FIXED_NOW - 60 * 60 * 1000).toISOString(),
    });
    const logger = mockLogger();
    const line = makeLineClient({ type: 'limited', value: 1000 }, 960); // 96%

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(true);
    expect(result.severity).toBe('critical');
    expect(logger.errorMock).toHaveBeenCalledTimes(1);
    expect(db.alertInserts[0].action).toBe('line_quota_monitor.critical');
  });

  it('LINE API 失敗 → skipReason=api_failed, throw しない (best-effort)', async () => {
    const db = new FakeDb();
    const logger = mockLogger();
    const line = makeFailingLineClient();

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(false);
    expect(result.skipReason).toBe('api_failed');
    expect(result.unlimited).toBe(false);
    expect(logger.warnMock).toHaveBeenCalledTimes(1);
    const [msg] = logger.warnMock.mock.calls[0];
    expect(msg).toMatch(/LINE quota API call failed/);
    expect(db.alertInserts.length).toBe(0);
  });

  it('logger.error が throw しても audit_logs INSERT は試みる (best-effort)', async () => {
    const db = new FakeDb();
    const logger = mockLogger();
    logger.errorMock.mockImplementation(() => {
      throw new Error('logger broken');
    });
    const line = makeLineClient({ type: 'limited', value: 1000 }, 1000);

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(true);
    expect(db.alertInserts.length).toBe(1);
    expect(db.alertInserts[0].action).toBe('line_quota_monitor.reached');
  });

  it('custom thresholds 注入 (= 50% で warning)', async () => {
    const db = new FakeDb();
    const logger = mockLogger();
    const line = makeLineClient({ type: 'limited', value: 1000 }, 500); // 50%

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
      warningThreshold: 0.5,
      criticalThreshold: 0.9,
      reachedThreshold: 1.0,
    });

    expect(result.alerted).toBe(true);
    expect(result.severity).toBe('warning');
  });

  it('D1 prepare が throw しても api_failed 経由ではなく cooldown 判定で null を返して alert', async () => {
    // cooldown SELECT が失敗時に null 扱い → alert 通る (= best-effort)
    const db = new FakeDb();
    const original = db.prepare.bind(db);
    let callCount = 0;
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      callCount++;
      if (callCount === 1 && /SELECT created_at FROM audit_logs/i.test(sql)) {
        // cooldown 判定の SELECT が throw
        return {
          bind: () => ({
            first: () => Promise.reject(new Error('D1 broken')),
            run: () => Promise.resolve({ success: false }),
          }),
        };
      }
      return original(sql);
    };
    const logger = mockLogger();
    const line = makeLineClient({ type: 'limited', value: 1000 }, 800);

    const result = await checkLineQuota(db as unknown as D1Database, line, logger, {
      nowFn: () => FIXED_NOW,
    });

    // cooldown SELECT が null → alert 出る (= conservative)
    expect(result.alerted).toBe(true);
    expect(result.severity).toBe('warning');
  });
});
