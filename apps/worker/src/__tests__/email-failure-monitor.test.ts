/**
 * Tests for email-failure-monitor (Phase 5α-4)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  processEmailFailureMonitor,
  __test__,
  type EmailFailureMonitorEnv,
} from '../services/email-failure-monitor.js';

const { isInWindow, parseInt10, parseFloat10 } = __test__;

describe('helpers', () => {
  it('parseInt10 — fallback when undefined / invalid / non-positive', () => {
    expect(parseInt10(undefined, 10)).toBe(10);
    expect(parseInt10('abc', 10)).toBe(10);
    expect(parseInt10('0', 10)).toBe(10);
    expect(parseInt10('-5', 10)).toBe(10);
    expect(parseInt10('5', 10)).toBe(5);
  });

  it('parseFloat10 — fallback when undefined / invalid / non-positive', () => {
    expect(parseFloat10(undefined, 0.5)).toBe(0.5);
    expect(parseFloat10('abc', 0.5)).toBe(0.5);
    expect(parseFloat10('0', 0.5)).toBe(0.5);
    expect(parseFloat10('-0.1', 0.5)).toBe(0.5);
    expect(parseFloat10('0.75', 0.5)).toBe(0.75);
  });

  it('isInWindow — JST 09:00-09:04 OK / 09:05 NG', () => {
    // JST 09:00 = UTC 00:00
    expect(isInWindow(new Date('2026-05-12T00:00:00Z'))).toBe(true);
    expect(isInWindow(new Date('2026-05-12T00:04:59Z'))).toBe(true);
    // JST 09:05 = UTC 00:05
    expect(isInWindow(new Date('2026-05-12T00:05:00Z'))).toBe(false);
    // JST 08:59 = UTC -00:01 → 23:59 of prev day
    expect(isInWindow(new Date('2026-05-11T23:59:00Z'))).toBe(false);
  });
});

describe('processEmailFailureMonitor', () => {
  function makeEnv(over: Partial<EmailFailureMonitorEnv> = {}): EmailFailureMonitorEnv {
    return {
      DB: makeFakeDb({ total: 0, failed: 0, errors: [] }),
      EMAIL_FAILURE_MONITOR_FORCE: 'true',
      ...over,
    };
  }

  function makeFakeDb(rows: { total: number; failed: number; errors: { summary: string; count: number }[] }): D1Database {
    return {
      prepare(sql: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('SUM(CASE WHEN status')) {
                  return { total: rows.total, failed: rows.failed } as unknown as T;
                }
                return null;
              },
              async all<T>() {
                if (sql.includes('GROUP BY summary')) {
                  return { results: rows.errors as unknown as T[] };
                }
                return { results: [] as T[] };
              },
              async run() {
                return { success: true } as unknown as D1Response;
              },
            };
          },
        };
      },
    } as unknown as D1Database;
  }

  it('window 外なら no-op (force=false)', async () => {
    const env = makeEnv({
      EMAIL_FAILURE_MONITOR_FORCE: undefined,
    });
    const result = await processEmailFailureMonitor(env, {
      now: new Date('2026-05-12T05:00:00Z'), // JST 14:00 = window 外
    });
    expect(result.triggered).toBe(false);
    expect(result.alertSent).toBe(false);
  });

  it('failure 件数が閾値以下なら alertReason=null', async () => {
    const env = makeEnv({
      DB: makeFakeDb({ total: 100, failed: 5, errors: [] }),
      EMAIL_FAILURE_COUNT_THRESHOLD: '10',
      EMAIL_FAILURE_RATE_THRESHOLD: '0.5',
      EMAIL_FAILURE_MIN_SAMPLE: '5',
    });
    const result = await processEmailFailureMonitor(env);
    expect(result.triggered).toBe(true);
    expect(result.stats?.alertReason).toBe(null);
    expect(result.alertSent).toBe(false); // alert なし
  });

  it('failure 件数が閾値超えで alertReason=count_threshold', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    const env = makeEnv({
      DB: makeFakeDb({
        total: 100,
        failed: 15,
        errors: [{ summary: 'SMTP timeout', count: 10 }, { summary: 'bounce', count: 5 }],
      }),
      DISCORD_WEBHOOK_URL: 'https://discord.test/webhook',
      EMAIL_FAILURE_COUNT_THRESHOLD: '10',
    });
    const result = await processEmailFailureMonitor(env, { fetchImpl: fetchMock });
    expect(result.stats?.alertReason).toBe('count_threshold');
    expect(result.stats?.failedCount).toBe(15);
    expect(result.stats?.topErrors.length).toBe(2);
    expect(result.alertSent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('failure 率が閾値超え + minSample 達成で alertReason=rate_threshold', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    const env = makeEnv({
      DB: makeFakeDb({ total: 10, failed: 6, errors: [] }),
      DISCORD_WEBHOOK_URL: 'https://discord.test/webhook',
      EMAIL_FAILURE_COUNT_THRESHOLD: '100', // 件数では超えない
      EMAIL_FAILURE_RATE_THRESHOLD: '0.5', // 6/10=0.6 で超える
      EMAIL_FAILURE_MIN_SAMPLE: '5',
    });
    const result = await processEmailFailureMonitor(env, { fetchImpl: fetchMock });
    expect(result.stats?.alertReason).toBe('rate_threshold');
    expect(result.alertSent).toBe(true);
  });

  it('totalSent < minSample なら rate 判定スキップ (false positive 防止)', async () => {
    const env = makeEnv({
      DB: makeFakeDb({ total: 3, failed: 2, errors: [] }), // rate 67% だが sample 不足
      EMAIL_FAILURE_COUNT_THRESHOLD: '10',
      EMAIL_FAILURE_RATE_THRESHOLD: '0.5',
      EMAIL_FAILURE_MIN_SAMPLE: '5',
    });
    const result = await processEmailFailureMonitor(env);
    expect(result.stats?.alertReason).toBe(null);
    expect(result.alertSent).toBe(false);
  });

  it('Discord webhook 未設定なら alertSent=false (alertReason は出る)', async () => {
    const env = makeEnv({
      DB: makeFakeDb({ total: 100, failed: 50, errors: [] }),
      // DISCORD_WEBHOOK_URL 未設定
      EMAIL_FAILURE_COUNT_THRESHOLD: '10',
    });
    const result = await processEmailFailureMonitor(env);
    expect(result.stats?.alertReason).toBe('count_threshold');
    expect(result.alertSent).toBe(false);
  });

  it('DB 失敗で例外を投げず stats=null + alertSent=false', async () => {
    const env: EmailFailureMonitorEnv = {
      DB: {
        prepare(_sql: string) {
          return {
            bind(..._args: unknown[]) {
              return {
                async first() {
                  throw new Error('D1 unavailable');
                },
                async all() {
                  throw new Error('D1 unavailable');
                },
                async run() {
                  throw new Error('D1 unavailable');
                },
              };
            },
          };
        },
      } as unknown as D1Database,
      EMAIL_FAILURE_MONITOR_FORCE: 'true',
    };
    const result = await processEmailFailureMonitor(env);
    expect(result.triggered).toBe(true);
    expect(result.stats).toBe(null);
    expect(result.alertSent).toBe(false);
  });
});
