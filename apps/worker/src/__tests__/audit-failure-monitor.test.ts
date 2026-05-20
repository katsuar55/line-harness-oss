/**
 * Tests for audit-failure-monitor service (Phase 5β-1d-2f-followup-2).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkAuditFailureSpike } from '../services/audit-failure-monitor.js';
import type { Logger } from '../services/logger.js';

const FIXED_NOW = new Date('2026-05-20T15:00:00.000Z').getTime();

interface AuditRow {
  id: string;
  action: string;
  result: string;
  created_at: string;
}

interface TopActionRow {
  action: string;
  count: number;
}

/**
 * FakeDb: audit_logs に対する 4 種の SQL を mock。
 *   - COUNT(*) failure
 *   - SELECT last alert (cooldown check)
 *   - SELECT top actions
 *   - INSERT alert audit row
 */
class FakeDb {
  rows: AuditRow[] = [];
  alertInserts: AuditRow[] = [];

  prepare(sql: string) {
    const isCountFailure = /SELECT COUNT\(\*\) AS n FROM audit_logs/i.test(sql);
    const isLastAlert =
      /SELECT created_at FROM audit_logs/i.test(sql) && /audit_failure_monitor\.spike_detected/i.test(sql.replace(/\?/g, ''));
    const isLastAlertGeneric =
      /SELECT created_at FROM audit_logs/i.test(sql) && /ORDER BY created_at DESC LIMIT 1/.test(sql);
    const isTopActions = /GROUP BY action/i.test(sql) && /ORDER BY count DESC/i.test(sql);
    const isInsert = /INSERT INTO audit_logs/i.test(sql);

    return {
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (isCountFailure) {
            const since = params[0] as string;
            const excludeAction = params[1] as string;
            const n = this.rows.filter(
              (r) => r.result === 'failure' && r.created_at >= since && r.action !== excludeAction,
            ).length;
            return { n };
          }
          if (isLastAlertGeneric) {
            const targetAction = params[0] as string;
            const cooldownSince = params[1] as string;
            const last = this.rows
              .filter((r) => r.action === targetAction && r.created_at >= cooldownSince)
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
            return last ? { created_at: last.created_at } : null;
          }
          // INSERT readback
          if (isInsert) {
            const id = params[0] as string;
            const found = this.rows.find((r) => r.id === id);
            return found ?? null;
          }
          return null;
        },
        all: async () => {
          if (!isTopActions) return { results: [] };
          const since = params[0] as string;
          const excludeAction = params[1] as string;
          const filtered = this.rows.filter(
            (r) => r.result === 'failure' && r.created_at >= since && r.action !== excludeAction,
          );
          const byAction = new Map<string, number>();
          for (const r of filtered) {
            byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
          }
          const sorted: TopActionRow[] = Array.from(byAction.entries())
            .map(([action, count]) => ({ action, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);
          return { results: sorted };
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

function mockLogger(): Logger & { errorMock: ReturnType<typeof vi.fn> } {
  const errorMock = vi.fn();
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: errorMock,
    fatal: vi.fn(),
    errorMock,
  };
}

function addFailure(db: FakeDb, id: string, action: string, ageMinutes: number) {
  db.rows.push({
    id,
    action,
    result: 'failure',
    created_at: new Date(FIXED_NOW - ageMinutes * 60 * 1000).toISOString(),
  });
}

describe('checkAuditFailureSpike', () => {
  beforeEach(() => vi.clearAllMocks());

  it('below threshold → no alert', async () => {
    const db = new FakeDb();
    addFailure(db, 'f1', 'line_friend_coupon.issue_failed', 2);
    addFailure(db, 'f2', 'line_friend_coupon.issue_failed', 3);
    // 2 件 < threshold 3
    const logger = mockLogger();
    const result = await checkAuditFailureSpike(db as unknown as D1Database, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(false);
    expect(result.failureCount).toBe(2);
    expect(result.skipReason).toBe('below_threshold');
    expect(logger.errorMock).not.toHaveBeenCalled();
    expect(db.alertInserts.length).toBe(0);
  });

  it('threshold exceeded → alert + audit_logs INSERT', async () => {
    const db = new FakeDb();
    addFailure(db, 'f1', 'line_friend_coupon.issue_failed', 1);
    addFailure(db, 'f2', 'line_friend_coupon.issue_failed', 2);
    addFailure(db, 'f3', 'line_friend_coupon.issue_failed', 3);
    addFailure(db, 'f4', 'cron.step_delivery.failed', 4);
    const logger = mockLogger();
    const result = await checkAuditFailureSpike(db as unknown as D1Database, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(true);
    expect(result.failureCount).toBe(4);
    expect(logger.errorMock).toHaveBeenCalledTimes(1);
    const [msg, fields] = logger.errorMock.mock.calls[0];
    expect(msg).toMatch(/spike detected/);
    expect((fields as Record<string, unknown>).failureCount).toBe(4);
    expect((fields as Record<string, unknown>).severity).toBe('CRITICAL');
    expect((fields as Record<string, unknown>).topActions).toContain('line_friend_coupon.issue_failed (3)');
    expect(db.alertInserts.length).toBe(1);
    expect(db.alertInserts[0].action).toBe('audit_failure_monitor.spike_detected');
  });

  it('cooldown active → no alert', async () => {
    const db = new FakeDb();
    // 30 min 前に既に alert 済 (= cooldown 1h 以内)
    db.rows.push({
      id: 'prev-alert',
      action: 'audit_failure_monitor.spike_detected',
      result: 'success',
      created_at: new Date(FIXED_NOW - 30 * 60 * 1000).toISOString(),
    });
    // 直近 failure も 5 件
    addFailure(db, 'f1', 'line_friend_coupon.issue_failed', 1);
    addFailure(db, 'f2', 'line_friend_coupon.issue_failed', 2);
    addFailure(db, 'f3', 'line_friend_coupon.issue_failed', 3);
    addFailure(db, 'f4', 'line_friend_coupon.issue_failed', 4);
    addFailure(db, 'f5', 'line_friend_coupon.issue_failed', 4);

    const logger = mockLogger();
    const result = await checkAuditFailureSpike(db as unknown as D1Database, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(false);
    expect(result.skipReason).toBe('cooldown');
    expect(result.failureCount).toBe(5);
    expect(logger.errorMock).not.toHaveBeenCalled();
    expect(db.alertInserts.length).toBe(0);
  });

  it('cooldown expired (>1h前 alert) → alert 再発火 OK', async () => {
    const db = new FakeDb();
    // 2 hour 前 alert → cooldown 1h 過ぎ
    db.rows.push({
      id: 'old-alert',
      action: 'audit_failure_monitor.spike_detected',
      result: 'success',
      created_at: new Date(FIXED_NOW - 2 * 60 * 60 * 1000).toISOString(),
    });
    addFailure(db, 'f1', 'cron.step_delivery.failed', 1);
    addFailure(db, 'f2', 'cron.step_delivery.failed', 2);
    addFailure(db, 'f3', 'cron.step_delivery.failed', 3);

    const logger = mockLogger();
    const result = await checkAuditFailureSpike(db as unknown as D1Database, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(true);
    expect(logger.errorMock).toHaveBeenCalledTimes(1);
    expect(db.alertInserts.length).toBe(1);
  });

  it('windowMinutes filter: 範囲外 failure は count しない', async () => {
    const db = new FakeDb();
    // 10 min 前 (= window 5 min 外)
    addFailure(db, 'old1', 'line_friend_coupon.issue_failed', 10);
    addFailure(db, 'old2', 'line_friend_coupon.issue_failed', 15);
    addFailure(db, 'old3', 'line_friend_coupon.issue_failed', 20);
    // 直近 (window 内)
    addFailure(db, 'f1', 'line_friend_coupon.issue_failed', 2);

    const logger = mockLogger();
    const result = await checkAuditFailureSpike(db as unknown as D1Database, logger, {
      nowFn: () => FIXED_NOW,
      windowMinutes: 5,
    });

    expect(result.failureCount).toBe(1);
    expect(result.alerted).toBe(false);
  });

  it('SPIKE_ACTION 自体は failure count に含めない (= 無限ループ防止)', async () => {
    const db = new FakeDb();
    // 既に spike alert が 5 件記録されてる場合でも、 alert は出ない
    for (let i = 0; i < 5; i++) {
      db.rows.push({
        id: `s${i}`,
        action: 'audit_failure_monitor.spike_detected',
        result: 'failure', // 仮に failure として記録されてても無視されること
        created_at: new Date(FIXED_NOW - (i + 1) * 60 * 1000).toISOString(),
      });
    }
    const logger = mockLogger();
    const result = await checkAuditFailureSpike(db as unknown as D1Database, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.failureCount).toBe(0);
    expect(result.alerted).toBe(false);
  });

  it('topActions: count DESC で 5 件まで返す', async () => {
    const db = new FakeDb();
    for (let i = 0; i < 5; i++) addFailure(db, `a${i}`, 'action.A', 1);
    for (let i = 0; i < 3; i++) addFailure(db, `b${i}`, 'action.B', 2);
    for (let i = 0; i < 1; i++) addFailure(db, `c${i}`, 'action.C', 3);

    const logger = mockLogger();
    const result = await checkAuditFailureSpike(db as unknown as D1Database, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(true);
    expect(result.topActions).toBeDefined();
    expect(result.topActions![0]).toEqual({ action: 'action.A', count: 5 });
    expect(result.topActions![1]).toEqual({ action: 'action.B', count: 3 });
    expect(result.topActions![2]).toEqual({ action: 'action.C', count: 1 });
  });

  it('logger.error が throw しても audit_logs INSERT は試みる (best-effort)', async () => {
    const db = new FakeDb();
    addFailure(db, 'f1', 'x', 1);
    addFailure(db, 'f2', 'x', 1);
    addFailure(db, 'f3', 'x', 1);

    const logger = mockLogger();
    logger.errorMock.mockImplementation(() => {
      throw new Error('logger broken');
    });

    const result = await checkAuditFailureSpike(db as unknown as D1Database, logger, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.alerted).toBe(true); // alerted 状態として返す
    expect(db.alertInserts.length).toBe(1); // INSERT は実行された
  });
});
