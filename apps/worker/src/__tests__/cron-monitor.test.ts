/**
 * Tests for cron-monitor (Phase 5 PR-4).
 *
 * `@line-crm/db` の getLastSuccessfulRun / insertCronRunLog をスパイし、
 * gating / alert 判定 / Discord 送信 / fail-safe を検証する。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// JST の指定日時を表す Date を作る (UTC で 9 時間前にずらす)
function jstDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute));
}

const ENV_BASE = {
  DB: {} as unknown as D1Database,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.doUnmock('@line-crm/db');
});

// ============================================================
// 純粋関数
// ============================================================

describe('isMonitorWindow / jstParts', () => {
  it('JST 09:02 → true', async () => {
    const { __test__ } = await import('../services/cron-monitor.js');
    const d = jstDate(2026, 4, 28, 9, 2);
    expect(__test__.isMonitorWindow(d)).toBe(true);
    const parts = __test__.jstParts(d);
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(2);
  });

  it('JST 10:00 → false (window 外)', async () => {
    const { __test__ } = await import('../services/cron-monitor.js');
    const d = jstDate(2026, 4, 28, 10, 0);
    expect(__test__.isMonitorWindow(d)).toBe(false);
  });

  it('JST 09:05 (境界) → false', async () => {
    const { __test__ } = await import('../services/cron-monitor.js');
    const d = jstDate(2026, 4, 28, 9, 5);
    expect(__test__.isMonitorWindow(d)).toBe(false);
  });
});

describe('computeSilentHours', () => {
  it('null → +Infinity', async () => {
    const { __test__ } = await import('../services/cron-monitor.js');
    const now = jstDate(2026, 4, 28, 9, 0);
    expect(__test__.computeSilentHours(now, null)).toBe(Number.POSITIVE_INFINITY);
  });

  it('1 時間前 → 約 1 時間', async () => {
    const { __test__ } = await import('../services/cron-monitor.js');
    const now = jstDate(2026, 4, 28, 9, 0);
    const oneHourAgo = jstDate(2026, 4, 28, 8, 0).toISOString();
    const result = __test__.computeSilentHours(now, oneHourAgo);
    expect(result).toBeGreaterThan(0.99);
    expect(result).toBeLessThan(1.01);
  });
});

// ============================================================
// processCronMonitor 本体
// ============================================================

interface DbMock {
  prepare: ReturnType<typeof vi.fn>;
}

function makeDb(): D1Database {
  const stub: DbMock = { prepare: vi.fn() };
  return stub as unknown as D1Database;
}

function mockDbModule(opts: {
  getLastSuccessfulRun?: (db: D1Database, jobName: string) => Promise<unknown>;
  insertCronRunLog?: (db: D1Database, input: unknown) => Promise<void>;
}): { getSpy: ReturnType<typeof vi.fn>; insertSpy: ReturnType<typeof vi.fn> } {
  const getSpy = vi.fn(opts.getLastSuccessfulRun ?? (async () => null));
  const insertSpy = vi.fn(opts.insertCronRunLog ?? (async () => undefined));
  vi.doMock('@line-crm/db', () => ({
    getLastSuccessfulRun: getSpy,
    insertCronRunLog: insertSpy,
  }));
  return { getSpy, insertSpy };
}

// JST 09:00 のテスト基準時刻
const JST_0900 = () => jstDate(2026, 4, 28, 9, 0);

describe('processCronMonitor — gating', () => {
  it('JST 月曜 09:00 → triggered: true', async () => {
    const { insertSpy } = mockDbModule({});
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      { ...ENV_BASE, DB: makeDb() },
      { now: jstDate(2026, 4, 27, 9, 0), rules: [] },
    );
    expect(r.triggered).toBe(true);
    // self-record は status='success' で 1 回呼ばれる
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][1]).toMatchObject({
      jobName: 'cron-monitor',
      status: 'success',
    });
  });

  it('JST 月曜 10:00 → triggered: false (window 外)', async () => {
    const { insertSpy, getSpy } = mockDbModule({});
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      { ...ENV_BASE, DB: makeDb() },
      { now: jstDate(2026, 4, 27, 10, 0) },
    );
    expect(r.triggered).toBe(false);
    expect(r.alerts).toEqual([]);
    expect(getSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('CRON_MONITOR_FORCE=true → 曜日関係なく triggered: true', async () => {
    mockDbModule({});
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      { ...ENV_BASE, DB: makeDb(), CRON_MONITOR_FORCE: 'true' },
      { now: jstDate(2026, 4, 27, 23, 30), rules: [] },
    );
    expect(r.triggered).toBe(true);
  });
});

describe('processCronMonitor — alert 判定', () => {
  it('lastSuccessAt が null → alert 候補', async () => {
    mockDbModule({
      getLastSuccessfulRun: async () => null,
    });
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      { ...ENV_BASE, DB: makeDb() },
      {
        now: JST_0900(),
        rules: [{ jobName: 'weekly-coach-push', maxSilentHours: 180 }],
      },
    );
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({
      jobName: 'weekly-coach-push',
      lastSuccessAt: null,
    });
    expect(r.alerts[0].silentHours).toBe(Number.POSITIVE_INFINITY);
  });

  it('silentHours が threshold 内 → alert なし', async () => {
    // 6 時間前に成功 → maxSilentHours: 12 以内なので alert なし
    const sixHoursAgo = new Date(JST_0900().getTime() - 6 * 3600 * 1000).toISOString();
    mockDbModule({
      getLastSuccessfulRun: async () => ({
        id: 'x',
        job_name: 'weekly-coach-push',
        ran_at: sixHoursAgo,
        status: 'success',
        metrics_json: null,
        error_summary: null,
      }),
    });
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      { ...ENV_BASE, DB: makeDb() },
      {
        now: JST_0900(),
        rules: [{ jobName: 'weekly-coach-push', maxSilentHours: 12 }],
      },
    );
    expect(r.alerts).toHaveLength(0);
  });

  it('silentHours が threshold 超 → alert', async () => {
    // 200 時間前に成功 → maxSilentHours: 180 超え
    const longAgo = new Date(JST_0900().getTime() - 200 * 3600 * 1000).toISOString();
    mockDbModule({
      getLastSuccessfulRun: async () => ({
        id: 'x',
        job_name: 'weekly-coach-push',
        ran_at: longAgo,
        status: 'success',
        metrics_json: null,
        error_summary: null,
      }),
    });
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      { ...ENV_BASE, DB: makeDb() },
      {
        now: JST_0900(),
        rules: [{ jobName: 'weekly-coach-push', maxSilentHours: 180 }],
      },
    );
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].jobName).toBe('weekly-coach-push');
    expect(r.alerts[0].silentHours).toBeGreaterThan(199);
    expect(r.alerts[0].silentHours).toBeLessThan(201);
  });
});

describe('processCronMonitor — Discord 通知', () => {
  it('DISCORD_WEBHOOK_URL 未設定 → fetch 呼ばれず alert は記録される', async () => {
    mockDbModule({
      getLastSuccessfulRun: async () => null, // alert になる
    });
    const fetchSpy = vi.fn();
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      { ...ENV_BASE, DB: makeDb() },
      {
        now: JST_0900(),
        rules: [{ jobName: 'weekly-coach-push', maxSilentHours: 180 }],
        fetchImpl: fetchSpy as unknown as typeof fetch,
      },
    );
    expect(r.alerts).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetch が throw しても result は正常に返る', async () => {
    mockDbModule({
      getLastSuccessfulRun: async () => null,
    });
    const failingFetch = vi.fn().mockRejectedValue(new Error('discord 503'));
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      {
        ...ENV_BASE,
        DB: makeDb(),
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      },
      {
        now: JST_0900(),
        rules: [{ jobName: 'weekly-coach-push', maxSilentHours: 180 }],
        fetchImpl: failingFetch as unknown as typeof fetch,
      },
    );
    expect(r.triggered).toBe(true);
    expect(r.alerts).toHaveLength(1);
    expect(failingFetch).toHaveBeenCalledOnce();
  });

  it('複数 rule で複数 alert → fetch 1 回に集約', async () => {
    mockDbModule({
      getLastSuccessfulRun: async () => null,
    });
    const okFetch = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      {
        ...ENV_BASE,
        DB: makeDb(),
        DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
      },
      {
        now: JST_0900(),
        rules: [
          { jobName: 'weekly-coach-push', maxSilentHours: 180 },
          { jobName: 'monthly-food-report', maxSilentHours: 760 },
        ],
        fetchImpl: okFetch as unknown as typeof fetch,
      },
    );
    expect(r.alerts).toHaveLength(2);
    expect(okFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(okFetch.mock.calls[0][1].body as string);
    expect(body.content).toContain('weekly-coach-push');
    expect(body.content).toContain('monthly-food-report');
  });
});

describe('processCronMonitor — self-record', () => {
  it('alert ゼロでも自身のログが status=success で記録される', async () => {
    const sixHoursAgo = new Date(JST_0900().getTime() - 6 * 3600 * 1000).toISOString();
    const { insertSpy } = mockDbModule({
      getLastSuccessfulRun: async () => ({
        id: 'x',
        job_name: 'weekly-coach-push',
        ran_at: sixHoursAgo,
        status: 'success',
        metrics_json: null,
        error_summary: null,
      }),
    });

    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      { ...ENV_BASE, DB: makeDb() },
      {
        now: JST_0900(),
        rules: [{ jobName: 'weekly-coach-push', maxSilentHours: 12 }],
      },
    );
    expect(r.alerts).toHaveLength(0);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const recordedInput = insertSpy.mock.calls[0][1];
    expect(recordedInput).toMatchObject({
      jobName: 'cron-monitor',
      status: 'success',
    });
    expect(recordedInput.metrics).toMatchObject({ rulesChecked: 1, alerts: 0 });
  });

  it('DB エラーで alert 判定 skip しても crash しない', async () => {
    mockDbModule({
      getLastSuccessfulRun: async () => {
        throw new Error('D1 unavailable');
      },
    });
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      { ...ENV_BASE, DB: makeDb() },
      {
        now: JST_0900(),
        rules: [{ jobName: 'weekly-coach-push', maxSilentHours: 12 }],
      },
    );
    expect(r.triggered).toBe(true);
    expect(r.alerts).toEqual([]);
  });
});
