/**
 * Tests for weekly-coach-push (Phase 4 PR-5).
 *
 * Covers:
 *   - gating: 火曜以外 / 火曜 11:00 / 火曜 09:30 → triggered=false
 *   - 火曜 10:02 JST → triggered=true, evaluated > 0
 *   - force=true で曜日無視
 *   - 7 日以内に reco がある friend は SQL 側で除外される (空 list でも triggered=true)
 *   - analyzer skipReason → skipped++
 *   - recommender null (deficits空 or SKU 全件不在) → skipped++
 *   - push 失敗 → errors++ で batch 続行
 *   - batchSize で件数制限 (LIMIT バインド)
 *   - jstParts / isTriggerWindow / buildCoachUrl / buildCoachBubble の純粋関数
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------- Helpers ----------

interface FriendRow {
  id: string;
  line_user_id: string;
  display_name: string | null;
}

/** SELECT (friends) の results と UPDATE (sent_at) 用 mock DB を構築 */
function makeMockDb(opts: {
  friends: FriendRow[];
  selectLimitCapture?: { value: number | null };
  updateSpy?: ReturnType<typeof vi.fn>;
}): D1Database {
  const updateSpy = opts.updateSpy ?? vi.fn().mockResolvedValue({ success: true });
  return {
    prepare: vi.fn((sql: string) => {
      if (/SELECT\s+f\.id, f\.line_user_id, f\.display_name/i.test(sql)) {
        return {
          bind: (limit: number) => {
            if (opts.selectLimitCapture) opts.selectLimitCapture.value = limit;
            const sliced = opts.friends.slice(0, limit);
            return {
              all: vi.fn().mockResolvedValue({ results: sliced }),
            };
          },
        };
      }
      if (/UPDATE nutrition_recommendations SET sent_at/i.test(sql)) {
        return {
          bind: (...args: unknown[]) => ({
            run: () => updateSpy(...args),
          }),
        };
      }
      throw new Error(`Unexpected SQL in weekly-coach-push test: ${sql.slice(0, 80)}`);
    }),
  } as unknown as D1Database;
}

// JST の指定日時を表す Date を作る (UTC で 9 時間前にずらす)
function jstDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  // JST = UTC+9 → JST の (Y/M/D h:m) は UTC の (Y/M/D h-9:m)
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute));
}

// ============================================================
// 純粋関数のテスト (mock 不要)
// ============================================================

describe('jstParts / isTriggerWindow', () => {
  it('火曜 10:02 JST → trigger window', async () => {
    const { __test__ } = await import('../services/weekly-coach-push.js');
    // 2026-04-28 (火曜) 10:02 JST
    const d = jstDate(2026, 4, 28, 10, 2);
    const parts = __test__.jstParts(d);
    expect(parts.day).toBe(2);
    expect(parts.hour).toBe(10);
    expect(parts.minute).toBe(2);
    expect(__test__.isTriggerWindow(d)).toBe(true);
  });

  it('火曜 10:05 JST (ウィンドウ境界外) → false', async () => {
    const { __test__ } = await import('../services/weekly-coach-push.js');
    const d = jstDate(2026, 4, 28, 10, 5);
    expect(__test__.isTriggerWindow(d)).toBe(false);
  });

  it('火曜 09:55 JST → false', async () => {
    const { __test__ } = await import('../services/weekly-coach-push.js');
    const d = jstDate(2026, 4, 28, 9, 55);
    expect(__test__.isTriggerWindow(d)).toBe(false);
  });

  it('月曜 10:02 JST → false', async () => {
    const { __test__ } = await import('../services/weekly-coach-push.js');
    const d = jstDate(2026, 4, 27, 10, 2); // 月曜
    expect(__test__.isTriggerWindow(d)).toBe(false);
  });
});

describe('buildCoachUrl', () => {
  it('LIFF_URL 未設定 → fallback', async () => {
    const { __test__ } = await import('../services/weekly-coach-push.js');
    expect(__test__.buildCoachUrl(undefined)).toContain('liff.line.me');
  });

  it('LIFF_URL のみ → /liff/coach 付与', async () => {
    const { __test__ } = await import('../services/weekly-coach-push.js');
    expect(__test__.buildCoachUrl('https://example.com')).toBe(
      'https://example.com/liff/coach',
    );
  });

  it('既に /liff/ を含む URL はそのまま', async () => {
    const { __test__ } = await import('../services/weekly-coach-push.js');
    expect(__test__.buildCoachUrl('https://liff.line.me/123-abc/liff/coach')).toBe(
      'https://liff.line.me/123-abc/liff/coach',
    );
  });
});

describe('buildCoachBubble', () => {
  it('aiMessage と LIFF URL を含む bubble を生成', async () => {
    const { __test__ } = await import('../services/weekly-coach-push.js');
    const bubble = __test__.buildCoachBubble({
      aiMessage: 'たんぱく質が控えめでした。',
      liffUrl: 'https://example.com',
    });
    expect(bubble.type).toBe('bubble');
    expect(bubble.body).toBeDefined();
    // body に aiMessage 含む
    const bodyJson = JSON.stringify(bubble.body);
    expect(bodyJson).toContain('たんぱく質が控えめでした');
    // footer ボタンに LIFF URL
    const footerJson = JSON.stringify(bubble.footer);
    expect(footerJson).toContain('https://example.com/liff/coach');
  });

  it('長いメッセージは clip + "..." される', async () => {
    const { __test__ } = await import('../services/weekly-coach-push.js');
    const long = 'あ'.repeat(200);
    const clipped = __test__.clipForBubble(long, 120);
    expect(Array.from(clipped).length).toBeLessThanOrEqual(120 + 3 /* dots */);
    expect(clipped.endsWith('...')).toBe(true);
  });
});

// ============================================================
// processWeeklyCoachPush の本体テスト
// (analyzer / recommender をモック差し替えて挙動検証)
// ============================================================

const ENV_BASE = {
  DB: undefined as unknown as D1Database, // テスト各で差し替え
  LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
  LIFF_URL: 'https://example.com',
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.doUnmock('../services/nutrition-analyzer.js');
  vi.doUnmock('../services/nutrition-recommender.js');
});

describe('processWeeklyCoachPush — gating', () => {
  it('月曜 10:00 JST → triggered=false (DB 触らない)', async () => {
    const { processWeeklyCoachPush } = await import('../services/weekly-coach-push.js');
    const prepare = vi.fn();
    const r = await processWeeklyCoachPush(
      { ...ENV_BASE, DB: { prepare } as unknown as D1Database },
      { now: jstDate(2026, 4, 27, 10, 0) }, // 月曜
    );
    expect(r.triggered).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('火曜 11:00 JST (ウィンドウ外) → triggered=false', async () => {
    const { processWeeklyCoachPush } = await import('../services/weekly-coach-push.js');
    const prepare = vi.fn();
    const r = await processWeeklyCoachPush(
      { ...ENV_BASE, DB: { prepare } as unknown as D1Database },
      { now: jstDate(2026, 4, 28, 11, 0) },
    );
    expect(r.triggered).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('火曜 09:30 JST → triggered=false', async () => {
    const { processWeeklyCoachPush } = await import('../services/weekly-coach-push.js');
    const prepare = vi.fn();
    const r = await processWeeklyCoachPush(
      { ...ENV_BASE, DB: { prepare } as unknown as D1Database },
      { now: jstDate(2026, 4, 28, 9, 30) },
    );
    expect(r.triggered).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('processWeeklyCoachPush — flow (火曜 10:02 JST)', () => {
  const TUESDAY_10_02 = () => jstDate(2026, 4, 28, 10, 2);

  function mockDeps(opts: {
    analyze: () => Promise<unknown>;
    recommend: () => Promise<unknown>;
  }) {
    vi.doMock('../services/nutrition-analyzer.js', () => ({
      analyzeFriendNutrition: vi.fn().mockImplementation(opts.analyze),
    }));
    vi.doMock('../services/nutrition-recommender.js', () => ({
      generateAndStoreRecommendation: vi.fn().mockImplementation(opts.recommend),
    }));
  }

  it('火曜 10:02 JST かつ候補 1 名 → triggered=true, generated=1, pushed=1', async () => {
    mockDeps({
      analyze: async () => ({
        fromDate: '2026-04-22',
        toDate: '2026-04-28',
        daysWithData: 7,
        averages: { calorie: 1200, protein_g: 40, fat_g: 30, carbs_g: 200 },
        deficits: [
          { key: 'protein_low', observedAvg: 40, targetAvg: 65, severity: 'moderate' },
        ],
      }),
      recommend: async () => ({
        id: 'reco-1',
        aiMessage: '今週はたんぱく質が控えめでした。',
        suggestions: [
          {
            shopifyProductId: 'gid://shopify/Product/X',
            productTitle: 'naturism プロテイン',
            copy: 'バランスを意識する選択肢に',
            deficitKey: 'protein_low',
          },
        ],
        source: 'template',
        recommendation: { id: 'reco-1' },
      }),
    });

    const { processWeeklyCoachPush } = await import('../services/weekly-coach-push.js');
    const updateSpy = vi.fn().mockResolvedValue({ success: true });
    const db = makeMockDb({
      friends: [{ id: 'f1', line_user_id: 'U1', display_name: '花子' }],
      updateSpy,
    });
    const pushSpy = vi.fn().mockResolvedValue({});
    const lineClient = { pushMessage: pushSpy };

    const r = await processWeeklyCoachPush(
      { ...ENV_BASE, DB: db },
      { now: TUESDAY_10_02(), lineClient },
    );

    expect(r.triggered).toBe(true);
    expect(r.evaluated).toBe(1);
    expect(r.generated).toBe(1);
    expect(r.pushed).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.errors).toBe(0);
    expect(pushSpy).toHaveBeenCalledOnce();
    // sent_at UPDATE が走った
    expect(updateSpy).toHaveBeenCalledOnce();
    // pushMessage の引数に LIFF URL が含まれる Flex
    const messages = pushSpy.mock.calls[0][1] as Array<{ contents: unknown }>;
    expect(JSON.stringify(messages)).toContain('https://example.com/liff/coach');
  });

  it('force=true で月曜でも triggered=true', async () => {
    mockDeps({
      analyze: async () => ({
        fromDate: '2026-04-21',
        toDate: '2026-04-27',
        daysWithData: 7,
        averages: { calorie: 1200, protein_g: 40, fat_g: 30, carbs_g: 200 },
        deficits: [
          { key: 'protein_low', observedAvg: 40, targetAvg: 65, severity: 'mild' },
        ],
      }),
      recommend: async () => ({
        id: 'reco-2',
        aiMessage: 'メッセージ',
        suggestions: [{ shopifyProductId: 'p', productTitle: 't', copy: 'c', deficitKey: 'protein_low' }],
        source: 'template',
        recommendation: { id: 'reco-2' },
      }),
    });

    const { processWeeklyCoachPush } = await import('../services/weekly-coach-push.js');
    const db = makeMockDb({
      friends: [{ id: 'f1', line_user_id: 'U1', display_name: null }],
    });
    const lineClient = { pushMessage: vi.fn().mockResolvedValue({}) };

    const r = await processWeeklyCoachPush(
      { ...ENV_BASE, DB: db },
      { now: jstDate(2026, 4, 27, 3, 0), force: true, lineClient },
    );
    expect(r.triggered).toBe(true);
    expect(r.pushed).toBe(1);
  });

  it('analyzer が skipReason を返す → skipped++ (push せず)', async () => {
    mockDeps({
      analyze: async () => ({
        fromDate: '2026-04-22',
        toDate: '2026-04-28',
        daysWithData: 2,
        averages: null,
        deficits: [],
        skipReason: 'insufficient_data' as const,
      }),
      recommend: async () => {
        throw new Error('should not be called');
      },
    });

    const { processWeeklyCoachPush } = await import('../services/weekly-coach-push.js');
    const db = makeMockDb({
      friends: [{ id: 'f1', line_user_id: 'U1', display_name: null }],
    });
    const pushSpy = vi.fn();
    const r = await processWeeklyCoachPush(
      { ...ENV_BASE, DB: db },
      { now: TUESDAY_10_02(), lineClient: { pushMessage: pushSpy } },
    );
    expect(r.triggered).toBe(true);
    expect(r.evaluated).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.generated).toBe(0);
    expect(r.pushed).toBe(0);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('recommender が null (SKU 全件不在) → skipped++ (push せず)', async () => {
    mockDeps({
      analyze: async () => ({
        fromDate: '2026-04-22',
        toDate: '2026-04-28',
        daysWithData: 7,
        averages: { calorie: 1200, protein_g: 40, fat_g: 30, carbs_g: 200 },
        deficits: [
          { key: 'protein_low', observedAvg: 40, targetAvg: 65, severity: 'moderate' },
        ],
      }),
      recommend: async () => null,
    });

    const { processWeeklyCoachPush } = await import('../services/weekly-coach-push.js');
    const db = makeMockDb({
      friends: [{ id: 'f1', line_user_id: 'U1', display_name: null }],
    });
    const pushSpy = vi.fn();
    const r = await processWeeklyCoachPush(
      { ...ENV_BASE, DB: db },
      { now: TUESDAY_10_02(), lineClient: { pushMessage: pushSpy } },
    );
    expect(r.triggered).toBe(true);
    expect(r.skipped).toBe(1);
    expect(r.generated).toBe(0);
    expect(r.pushed).toBe(0);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('push 失敗で 1 friend errors++ だが batch は続行', async () => {
    mockDeps({
      analyze: async () => ({
        fromDate: '2026-04-22',
        toDate: '2026-04-28',
        daysWithData: 7,
        averages: { calorie: 1200, protein_g: 40, fat_g: 30, carbs_g: 200 },
        deficits: [
          { key: 'protein_low', observedAvg: 40, targetAvg: 65, severity: 'moderate' },
        ],
      }),
      recommend: async () => ({
        id: 'reco-x',
        aiMessage: 'm',
        suggestions: [{ shopifyProductId: 'p', productTitle: 't', copy: 'c', deficitKey: 'protein_low' }],
        source: 'template',
        recommendation: { id: 'reco-x' },
      }),
    });

    const { processWeeklyCoachPush } = await import('../services/weekly-coach-push.js');
    const db = makeMockDb({
      friends: [
        { id: 'f1', line_user_id: 'U1', display_name: null },
        { id: 'f2', line_user_id: 'U2', display_name: null },
      ],
    });

    // f1 の push は失敗、f2 は成功
    const pushSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('LINE API down'))
      .mockResolvedValueOnce({});

    const r = await processWeeklyCoachPush(
      { ...ENV_BASE, DB: db },
      { now: TUESDAY_10_02(), lineClient: { pushMessage: pushSpy } },
    );
    expect(r.triggered).toBe(true);
    expect(r.evaluated).toBe(2);
    expect(r.generated).toBe(2); // どちらも DB insert は走った
    expect(r.pushed).toBe(1);
    expect(r.errors).toBe(1);
    expect(pushSpy).toHaveBeenCalledTimes(2);
  });

  it('batchSize で SQL の LIMIT が制限される', async () => {
    mockDeps({
      analyze: async () => ({
        fromDate: '2026-04-22',
        toDate: '2026-04-28',
        daysWithData: 7,
        averages: { calorie: 1200, protein_g: 40, fat_g: 30, carbs_g: 200 },
        deficits: [
          { key: 'protein_low', observedAvg: 40, targetAvg: 65, severity: 'mild' },
        ],
      }),
      recommend: async () => ({
        id: 'reco-y',
        aiMessage: 'm',
        suggestions: [{ shopifyProductId: 'p', productTitle: 't', copy: 'c', deficitKey: 'protein_low' }],
        source: 'template',
        recommendation: { id: 'reco-y' },
      }),
    });

    const { processWeeklyCoachPush } = await import('../services/weekly-coach-push.js');
    const limitCapture = { value: null as number | null };
    const db = makeMockDb({
      friends: Array.from({ length: 10 }, (_, i) => ({
        id: `f${i}`,
        line_user_id: `U${i}`,
        display_name: null,
      })),
      selectLimitCapture: limitCapture,
    });

    const r = await processWeeklyCoachPush(
      { ...ENV_BASE, DB: db },
      {
        now: TUESDAY_10_02(),
        batchSize: 3,
        lineClient: { pushMessage: vi.fn().mockResolvedValue({}) },
      },
    );
    expect(limitCapture.value).toBe(3);
    expect(r.evaluated).toBe(3);
    expect(r.pushed).toBe(3);
  });

  it('候補ゼロ (DB が空) → triggered=true / evaluated=0', async () => {
    mockDeps({
      analyze: async () => ({
        fromDate: '',
        toDate: '',
        daysWithData: 0,
        averages: null,
        deficits: [],
      }),
      recommend: async () => null,
    });

    const { processWeeklyCoachPush } = await import('../services/weekly-coach-push.js');
    const db = makeMockDb({ friends: [] });
    const pushSpy = vi.fn();
    const r = await processWeeklyCoachPush(
      { ...ENV_BASE, DB: db },
      { now: TUESDAY_10_02(), lineClient: { pushMessage: pushSpy } },
    );
    expect(r.triggered).toBe(true);
    expect(r.evaluated).toBe(0);
    expect(pushSpy).not.toHaveBeenCalled();
  });
});
