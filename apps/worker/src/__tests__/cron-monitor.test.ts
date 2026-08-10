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
// DEFAULT_RULES 登録 (= 監視対象から漏れると silent 失敗を検知できない)
// ============================================================

describe('conditionalRules — teiki-flow ingest 監視', () => {
  const load = async () => (await import('../services/cron-monitor.js')).conditionalRules;

  it('Flow 未配線の環境では登録しない (一度も記録が無い = 即アラートになるため)', async () => {
    const conditionalRules = await load();
    // OSS の既定 / 他ブランド: 収集も secret も無い
    expect(conditionalRules({ DB: {} as D1Database })).toEqual([]);
    // gate だけ ON (Flow は未設定) — 受信口は全て 401 を返すので沈黙が正常
    expect(
      conditionalRules({ DB: {} as D1Database, SUBSCRIPTION_INGEST_ENABLED: 'true' }),
    ).toEqual([]);
    // secret だけあって収集 gate が OFF なら受信しない
    expect(conditionalRules({ DB: {} as D1Database, TEIKI_FLOW_SECRET: 's' })).toEqual([]);
  });

  it('🚨配線済み環境では 72h 沈黙で検知する (実測 0 件の原因を切り分ける唯一の自動手段)', async () => {
    const conditionalRules = await load();
    const rules = conditionalRules({
      DB: {} as D1Database,
      SUBSCRIPTION_INGEST_ENABLED: 'true',
      TEIKI_FLOW_SECRET: 's',
    });
    expect(rules).toEqual([{ jobName: 'teiki-flow-ingest', maxSilentHours: 72 }]);
  });

  it('MENU 単独 (後方互換の収集 ON) でも配線済みとみなす', async () => {
    const conditionalRules = await load();
    expect(
      conditionalRules({
        DB: {} as D1Database,
        SUBSCRIPTION_MENU_ENABLED: 'true',
        TEIKI_FLOW_SECRET: 's',
      }),
    ).toHaveLength(1);
  });
});

describe('conditionalRules — ai-models-catalog-sync 監視 (2026-08-11)', () => {
  const load = async () => (await import('../services/cron-monitor.js')).conditionalRules;

  it('secret 未設定 (= 意図的 dormant) では登録しない — 毎朝の silence ノイズ防止', async () => {
    const conditionalRules = await load();
    // 両方なし
    expect(
      conditionalRules({ DB: {} as D1Database }).some(
        (r) => r.jobName === 'ai-models-catalog-sync',
      ),
    ).toBe(false);
    // ACCOUNT_ID のみ (2026-08-09〜 の本番実状態: TOKEN 待ち)
    expect(
      conditionalRules({ DB: {} as D1Database, CLOUDFLARE_ACCOUNT_ID: 'acc' }).some(
        (r) => r.jobName === 'ai-models-catalog-sync',
      ),
    ).toBe(false);
    // TOKEN のみ
    expect(
      conditionalRules({ DB: {} as D1Database, CLOUDFLARE_API_TOKEN: 'tok' }).some(
        (r) => r.jobName === 'ai-models-catalog-sync',
      ),
    ).toBe(false);
  });

  it('secret 両方あり = sync 実走環境では 30h 沈黙で検知する (監視は自動復帰)', async () => {
    const conditionalRules = await load();
    const rules = conditionalRules({
      DB: {} as D1Database,
      CLOUDFLARE_ACCOUNT_ID: 'acc',
      CLOUDFLARE_API_TOKEN: 'tok',
    });
    expect(rules).toContainEqual({ jobName: 'ai-models-catalog-sync', maxSilentHours: 30 });
  });

  it('teiki-flow 配線済み + CF secret あり → 両方のルールが同時に立つ', async () => {
    const conditionalRules = await load();
    const rules = conditionalRules({
      DB: {} as D1Database,
      SUBSCRIPTION_INGEST_ENABLED: 'true',
      TEIKI_FLOW_SECRET: 's',
      CLOUDFLARE_ACCOUNT_ID: 'acc',
      CLOUDFLARE_API_TOKEN: 'tok',
    });
    expect(rules.map((r) => r.jobName).sort()).toEqual([
      'ai-models-catalog-sync',
      'teiki-flow-ingest',
    ]);
  });
});

describe('DEFAULT_RULES — ai-models-catalog-sync の静的登録禁止 (回帰ガード)', () => {
  it('🚨DEFAULT_RULES に ai-models-catalog-sync を再追加しない (conditionalRules 専属)', async () => {
    const { DEFAULT_RULES } = await import('../services/cron-monitor.js');
    expect(DEFAULT_RULES.some((r) => r.jobName === 'ai-models-catalog-sync')).toBe(false);
  });
});

describe('DEFAULT_RULES registration', () => {
  it('webhook-delivery-cleanup が登録済 (= 1 日 1 回 cron、 maxSilentHours=30)', async () => {
    const { DEFAULT_RULES } = await import('../services/cron-monitor.js');
    const rule = DEFAULT_RULES.find((r) => r.jobName === 'webhook-delivery-cleanup');
    expect(rule).toBeDefined();
    expect(rule?.maxSilentHours).toBe(30);
  });

  // 採点ループ Round 1 (D10): per-tick withHeartbeat 7 本の登録漏れ修正の回帰ガード
  it.each([
    ['broadcast-insights-fetch', 2],
    ['audit-failure-monitor', 2],
    ['birthday-greetings', 2],
    ['membership-promotion-sanity', 2],
    ['loyalty-rank-reeval', 2],
    ['friend-customer-link', 2],
    ['line-quota-monitor', 3],
    ['conversation-log-cleanup', 30],
  ])('%s が登録済 (maxSilentHours=%i)', async (jobName, expected) => {
    const { DEFAULT_RULES } = await import('../services/cron-monitor.js');
    const rule = DEFAULT_RULES.find((r) => r.jobName === jobName);
    expect(rule).toBeDefined();
    expect(rule?.maxSilentHours).toBe(expected);
  });
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
  getLastLiveRun?: (db: D1Database, jobName: string) => Promise<unknown>;
  insertCronRunLog?: (db: D1Database, input: unknown) => Promise<void>;
}): {
  getSpy: ReturnType<typeof vi.fn>;
  liveSpy: ReturnType<typeof vi.fn>;
  insertSpy: ReturnType<typeof vi.fn>;
} {
  const getSpy = vi.fn(opts.getLastSuccessfulRun ?? (async () => null));
  const liveSpy = vi.fn(opts.getLastLiveRun ?? (async () => null));
  const insertSpy = vi.fn(opts.insertCronRunLog ?? (async () => undefined));
  vi.doMock('@line-crm/db', () => ({
    getLastSuccessfulRun: getSpy,
    getLastLiveRun: liveSpy,
    insertCronRunLog: insertSpy,
  }));
  return { getSpy, liveSpy, insertSpy };
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

// ============================================================
// treatPartialAsAlive (2026-08-11) — partial 定常の job に silence 誤警報を出さない
// ============================================================

describe('treatPartialAsAlive', () => {
  it('flag あり → getLastLiveRun (success|partial) で生存判定・partial があれば alert なし', async () => {
    const sixHoursAgo = new Date(JST_0900().getTime() - 6 * 3600 * 1000).toISOString();
    const { getSpy, liveSpy } = mockDbModule({
      // success だけを見る旧経路は「該当なし」を返す状況
      getLastSuccessfulRun: async () => null,
      getLastLiveRun: async () => ({
        id: 'x',
        job_name: 'cloudflare-changelog-sync',
        ran_at: sixHoursAgo,
        status: 'partial',
        metrics_json: null,
        error_summary: null,
      }),
    });
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      { ...ENV_BASE, DB: makeDb() },
      {
        now: JST_0900(),
        rules: [
          { jobName: 'cloudflare-changelog-sync', maxSilentHours: 30, treatPartialAsAlive: true },
        ],
      },
    );
    expect(r.alerts).toHaveLength(0);
    expect(liveSpy).toHaveBeenCalledWith(expect.anything(), 'cloudflare-changelog-sync');
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('flag なし → 従来どおり getLastSuccessfulRun (partial は沈黙扱いのまま)', async () => {
    const { getSpy, liveSpy } = mockDbModule({});
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      { ...ENV_BASE, DB: makeDb() },
      {
        now: JST_0900(),
        rules: [{ jobName: 'step-delivery', maxSilentHours: 2 }],
      },
    );
    expect(r.alerts).toHaveLength(1);
    expect(getSpy).toHaveBeenCalledWith(expect.anything(), 'step-delivery');
    expect(liveSpy).not.toHaveBeenCalled();
  });

  it('🚨DEFAULT_RULES の cloudflare-changelog-sync に flag が付いている (4 feed 化で partial が定常になり得るため)', async () => {
    const { DEFAULT_RULES } = await import('../services/cron-monitor.js');
    const rule = DEFAULT_RULES.find((r) => r.jobName === 'cloudflare-changelog-sync');
    expect(rule?.treatPartialAsAlive).toBe(true);
    expect(rule?.maxSilentHours).toBe(30);
  });
});

// ============================================================
// デフォルト rule 合成 (2026-08-11) — options.rules を渡さない本番経路の検証
// ============================================================

describe('processCronMonitor — DEFAULT_RULES + conditionalRules の合成 (本番経路)', () => {
  // 2026-08-11 監査: 全 triggering テストが options.rules を明示 override していたため、
  // `options.rules ?? [...DEFAULT_RULES, ...conditionalRules(env)]` の合成が壊れても
  // (例: conditionalRules の削除) 全 green のままだった (mutation で実証)。
  // 以下は rules を渡さず本番と同じ合成経路を実走させる。

  it('🚨CF secret 両方あり → ai-models-catalog-sync の監視が合成に入る (自動復帰の保証)', async () => {
    // 全 job が「成功記録なし」 → 監視対象の rule は全て alert になる
    const { insertSpy } = mockDbModule({});
    const { processCronMonitor, DEFAULT_RULES } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      {
        ...ENV_BASE,
        DB: makeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
      },
      { now: JST_0900() },
    );
    expect(r.alerts.map((a) => a.jobName)).toContain('ai-models-catalog-sync');
    expect(insertSpy.mock.calls[0][1].metrics).toMatchObject({
      rulesChecked: DEFAULT_RULES.length + 1,
    });
  });

  it('CF secret なし (意図的 dormant) → ai-models-catalog-sync は合成に入らない', async () => {
    const { insertSpy } = mockDbModule({});
    const { processCronMonitor, DEFAULT_RULES } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      { ...ENV_BASE, DB: makeDb() },
      { now: JST_0900() },
    );
    expect(r.alerts.map((a) => a.jobName)).not.toContain('ai-models-catalog-sync');
    expect(insertSpy.mock.calls[0][1].metrics).toMatchObject({
      rulesChecked: DEFAULT_RULES.length,
    });
  });

  it('teiki-flow 配線済み env → teiki-flow-ingest の監視が合成に入る', async () => {
    mockDbModule({});
    const { processCronMonitor } = await import('../services/cron-monitor.js');
    const r = await processCronMonitor(
      {
        ...ENV_BASE,
        DB: makeDb(),
        SUBSCRIPTION_INGEST_ENABLED: 'true',
        TEIKI_FLOW_SECRET: 's',
      },
      { now: JST_0900() },
    );
    expect(r.alerts.map((a) => a.jobName)).toContain('teiki-flow-ingest');
  });
});
