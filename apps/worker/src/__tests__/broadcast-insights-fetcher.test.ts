/**
 * Tests for broadcast-insights-fetcher service (Phase 5β-5c-prep).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchPendingBroadcastInsights } from '../services/broadcast-insights-fetcher.js';

const FIXED_NOW = new Date('2026-05-20T10:00:00.000Z').getTime();

interface BroadcastRow {
  id: string;
  line_request_id: string;
  sent_at: string;
  title: string;
  status: string;
  insights_json: string | null;
  insights_fetched_at: string | null;
}

/**
 * FakeDb: broadcasts SELECT (pickup filter) + UPDATE (insights_json save) を mock。
 *
 * filter は実 SQL の条件 (= status='sent' AND line_request_id NOT NULL AND insights_json IS NULL
 *   AND sent_at BETWEEN ? AND ?) を再現する。 ORDER BY sent_at DESC + LIMIT 反映。
 */
class FakeDb {
  rows: BroadcastRow[] = [];
  updateLog: Array<{ id: string; insights_json: string; insights_fetched_at: string }> = [];

  prepare(sql: string) {
    const isSelect = /SELECT[\s\S]+FROM broadcasts/i.test(sql);
    const isUpdate = /UPDATE broadcasts\s+SET insights_json/i.test(sql);
    return {
      bind: (...params: unknown[]) => ({
        all: async () => {
          if (!isSelect) return { results: [] };
          const oldestAllowed = params[0] as string;
          const youngestAllowed = params[1] as string;
          const limit = params[2] as number;
          const filtered = this.rows
            .filter(
              (r) =>
                r.status === 'sent' &&
                r.line_request_id &&
                r.insights_json === null &&
                r.sent_at > oldestAllowed &&
                r.sent_at < youngestAllowed,
            )
            .sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1))
            .slice(0, limit);
          return { results: filtered };
        },
        run: async () => {
          if (!isUpdate) return { success: true };
          const insightsJson = params[0] as string;
          const fetchedAt = params[1] as string;
          const id = params[2] as string;
          const row = this.rows.find((r) => r.id === id);
          if (row) {
            row.insights_json = insightsJson;
            row.insights_fetched_at = fetchedAt;
          }
          this.updateLog.push({ id, insights_json: insightsJson, insights_fetched_at: fetchedAt });
          return { success: true, meta: { changes: 1 } };
        },
      }),
    };
  }
}

function makeBroadcast(
  overrides: Partial<BroadcastRow> & Pick<BroadcastRow, 'id'>,
): BroadcastRow {
  return {
    line_request_id: `req-${overrides.id}`,
    sent_at: new Date(FIXED_NOW - 2 * 3_600_000).toISOString(), // 2h ago
    title: `Broadcast ${overrides.id}`,
    status: 'sent',
    insights_json: null,
    insights_fetched_at: null,
    ...overrides,
  };
}

function mockLineClient(
  responder: (
    requestId: string,
  ) => Promise<{
    overview: { delivered?: number; uniqueImpression?: number; uniqueClick?: number } | null;
    messages: unknown[];
    clicks: unknown[];
  }>,
) {
  return {
    getInsightMessageEvent: vi.fn(responder),
  } as unknown as Parameters<typeof fetchPendingBroadcastInsights>[1];
}

describe('fetchPendingBroadcastInsights', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path: overview あり → insights_json UPDATE + succeeded count', async () => {
    const db = new FakeDb();
    db.rows.push(makeBroadcast({ id: 'b1' }));
    const lineClient = mockLineClient(async () => ({
      overview: { delivered: 100, uniqueImpression: 80, uniqueClick: 12 },
      messages: [],
      clicks: [],
    }));

    const result = await fetchPendingBroadcastInsights(db as unknown as D1Database, lineClient, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.retryable).toBe(0);
    expect(db.updateLog.length).toBe(1);
    expect(db.updateLog[0].id).toBe('b1');
    const parsed = JSON.parse(db.updateLog[0].insights_json) as {
      overview: { delivered: number };
    };
    expect(parsed.overview.delivered).toBe(100);
  });

  it('overview=null → retryable (UPDATE しない)', async () => {
    const db = new FakeDb();
    db.rows.push(makeBroadcast({ id: 'b1' }));
    const lineClient = mockLineClient(async () => ({
      overview: null,
      messages: [],
      clicks: [],
    }));

    const result = await fetchPendingBroadcastInsights(db as unknown as D1Database, lineClient, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.retryable).toBe(1);
    expect(db.updateLog.length).toBe(0); // UPDATE しない
    // row の insights_json は null のまま (= 次回 retry)
    expect(db.rows[0].insights_json).toBeNull();
  });

  it('LINE API throw → failed count、 他 broadcast は continue', async () => {
    const db = new FakeDb();
    db.rows.push(makeBroadcast({ id: 'b-fail' }));
    db.rows.push(makeBroadcast({ id: 'b-ok', sent_at: new Date(FIXED_NOW - 3 * 3_600_000).toISOString() }));

    const lineClient = mockLineClient(async (requestId: string) => {
      if (requestId === 'req-b-fail') throw new Error('LINE API timeout');
      return {
        overview: { delivered: 50, uniqueImpression: 40, uniqueClick: 3 },
        messages: [],
        clicks: [],
      };
    });

    const result = await fetchPendingBroadcastInsights(db as unknown as D1Database, lineClient, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(db.updateLog.length).toBe(1);
    expect(db.updateLog[0].id).toBe('b-ok');
  });

  it('filter: status != sent は pickup しない', async () => {
    const db = new FakeDb();
    db.rows.push(makeBroadcast({ id: 'draft', status: 'draft' }));
    db.rows.push(makeBroadcast({ id: 'scheduled', status: 'scheduled' }));
    const lineClient = mockLineClient(async () => ({ overview: null, messages: [], clicks: [] }));

    const result = await fetchPendingBroadcastInsights(db as unknown as D1Database, lineClient, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.processed).toBe(0);
    expect(lineClient.getInsightMessageEvent).not.toHaveBeenCalled();
  });

  it('filter: line_request_id IS NULL は pickup しない', async () => {
    const db = new FakeDb();
    db.rows.push(makeBroadcast({ id: 'no-req', line_request_id: '' }));
    const lineClient = mockLineClient(async () => ({ overview: null, messages: [], clicks: [] }));

    const result = await fetchPendingBroadcastInsights(db as unknown as D1Database, lineClient, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.processed).toBe(0);
  });

  it('filter: insights_json 既にある は pickup しない (= 冪等)', async () => {
    const db = new FakeDb();
    db.rows.push(makeBroadcast({ id: 'already', insights_json: '{"overview":{"delivered":1}}' }));
    const lineClient = mockLineClient(async () => ({ overview: null, messages: [], clicks: [] }));

    const result = await fetchPendingBroadcastInsights(db as unknown as D1Database, lineClient, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.processed).toBe(0);
  });

  it('filter: sent_at が新しすぎ (= < MIN_AGE_HOURS) は pickup しない', async () => {
    const db = new FakeDb();
    db.rows.push(
      makeBroadcast({
        id: 'too-new',
        sent_at: new Date(FIXED_NOW - 10 * 60 * 1000).toISOString(), // 10 min ago < 1h
      }),
    );
    const lineClient = mockLineClient(async () => ({ overview: null, messages: [], clicks: [] }));

    const result = await fetchPendingBroadcastInsights(db as unknown as D1Database, lineClient, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.processed).toBe(0);
  });

  it('filter: sent_at が古すぎ (= > 30 days) は pickup しない', async () => {
    const db = new FakeDb();
    db.rows.push(
      makeBroadcast({
        id: 'too-old',
        sent_at: new Date(FIXED_NOW - 40 * 86_400_000).toISOString(), // 40 days ago > 30 days
      }),
    );
    const lineClient = mockLineClient(async () => ({ overview: null, messages: [], clicks: [] }));

    const result = await fetchPendingBroadcastInsights(db as unknown as D1Database, lineClient, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.processed).toBe(0);
  });

  it('batchSize で 1 cycle の件数を制限 + 古い順は後回し (ORDER BY sent_at DESC)', async () => {
    const db = new FakeDb();
    for (let i = 0; i < 10; i++) {
      db.rows.push(
        makeBroadcast({
          id: `b${i}`,
          sent_at: new Date(FIXED_NOW - (2 + i) * 3_600_000).toISOString(),
        }),
      );
    }
    const lineClient = mockLineClient(async () => ({
      overview: { delivered: 1, uniqueImpression: 1, uniqueClick: 0 },
      messages: [],
      clicks: [],
    }));

    const result = await fetchPendingBroadcastInsights(db as unknown as D1Database, lineClient, {
      nowFn: () => FIXED_NOW,
      batchSize: 3,
    });

    expect(result.processed).toBe(3);
    expect(result.succeeded).toBe(3);
    // 最新の sent_at から処理されること (= b0, b1, b2)
    expect(db.updateLog.map((u) => u.id)).toEqual(['b0', 'b1', 'b2']);
  });

  it('mixed result: 1 成功 + 1 retryable + 1 failed', async () => {
    const db = new FakeDb();
    db.rows.push(
      makeBroadcast({ id: 'ok', sent_at: new Date(FIXED_NOW - 2 * 3_600_000).toISOString() }),
    );
    db.rows.push(
      makeBroadcast({ id: 'retry', sent_at: new Date(FIXED_NOW - 3 * 3_600_000).toISOString() }),
    );
    db.rows.push(
      makeBroadcast({ id: 'fail', sent_at: new Date(FIXED_NOW - 4 * 3_600_000).toISOString() }),
    );

    const lineClient = mockLineClient(async (requestId: string) => {
      if (requestId === 'req-ok')
        return {
          overview: { delivered: 100, uniqueImpression: 80, uniqueClick: 10 },
          messages: [],
          clicks: [],
        };
      if (requestId === 'req-retry') return { overview: null, messages: [], clicks: [] };
      throw new Error('boom');
    });

    const result = await fetchPendingBroadcastInsights(db as unknown as D1Database, lineClient, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.processed).toBe(3);
    expect(result.succeeded).toBe(1);
    expect(result.retryable).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('対象 0 件 → no-op success', async () => {
    const db = new FakeDb();
    const lineClient = mockLineClient(async () => ({ overview: null, messages: [], clicks: [] }));

    const result = await fetchPendingBroadcastInsights(db as unknown as D1Database, lineClient, {
      nowFn: () => FIXED_NOW,
    });

    expect(result.processed).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.retryable).toBe(0);
    expect(lineClient.getInsightMessageEvent).not.toHaveBeenCalled();
  });
});
