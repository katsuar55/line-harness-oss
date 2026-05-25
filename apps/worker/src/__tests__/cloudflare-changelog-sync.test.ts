/**
 * Tests for services/cloudflare-changelog-sync (= 戦略 #2、 2026-05-26)
 *
 * カバー範囲:
 *   - gating (= JST 04:30-04:34 window)
 *   - CHANGELOG_SYNC_FORCE='true' で bypass
 *   - parseRss: RSS 2.0 + Atom + CDATA + 空 + 不正
 *   - sync success: 新着 entry → upsert + Discord 通知 + notified mark
 *   - sync 既存 entry のみ → notified=0, newEntries=0
 *   - sync 部分失敗 (= 1 feed throws): 他 feed 続行 + status=partial
 *   - sync 全 feed 失敗 → status=error
 *   - Discord webhook 未設定 → upsert は実行、 notify skip + catchup 可
 *   - notify max limit (= maxNotifyPerRun)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock @line-crm/db
// ============================================================

interface UpsertCall {
  entryUrl: string;
  title: string;
  category: string;
  publishedAt: string | null;
  description: string | null;
}

const state = {
  upsertCalls: [] as UpsertCall[],
  existingUrls: new Set<string>(),
  unnotifiedEntries: [] as Array<{
    id: string;
    title: string;
    entryUrl: string;
    category: string;
    publishedAt: string | null;
    description: string | null;
  }>,
  markedNotifiedIds: [] as string[],
  cronRunCalls: [] as Array<{ jobName: string; status: string; metrics?: unknown }>,
  upsertShouldThrowFor: new Set<string>(),
  listUnnotifiedShouldThrow: false,
  markShouldThrow: false,
};

vi.mock('@line-crm/db', () => ({
  upsertChangelogEntry: vi.fn(async (_db: unknown, input: UpsertCall) => {
    if (state.upsertShouldThrowFor.has(input.entryUrl)) {
      throw new Error(`simulated upsert failure for ${input.entryUrl}`);
    }
    state.upsertCalls.push(input);
    const isNew = !state.existingUrls.has(input.entryUrl);
    if (isNew) {
      state.existingUrls.add(input.entryUrl);
      state.unnotifiedEntries.push({
        id: `id-${state.upsertCalls.length}`,
        title: input.title,
        entryUrl: input.entryUrl,
        category: input.category,
        publishedAt: input.publishedAt,
        description: input.description,
      });
    }
    return { isNew };
  }),
  listUnnotifiedChangelogEntries: vi.fn(async (_db: unknown, limit: number) => {
    if (state.listUnnotifiedShouldThrow) {
      throw new Error('simulated listUnnotified failure');
    }
    return state.unnotifiedEntries.slice(0, limit);
  }),
  markChangelogEntriesNotified: vi.fn(async (_db: unknown, ids: string[]) => {
    if (state.markShouldThrow) throw new Error('simulated mark failure');
    state.markedNotifiedIds.push(...ids);
  }),
  insertCronRunLog: vi.fn(
    async (_db: unknown, input: { jobName: string; status: string; metrics?: unknown }) => {
      state.cronRunCalls.push(input);
    },
  ),
}));

// ============================================================
// Fake D1 (= queries are intercepted by mocked db)
// ============================================================

function makeFakeDb(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first<T>() {
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[], success: true };
            },
            async run() {
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

// ============================================================
// Test fetch impl
// ============================================================

interface FeedMockEntry {
  url: string;
  xml?: string;
  throws?: boolean;
  status?: number;
}

function makeFetchImpl(opts: {
  feeds?: FeedMockEntry[];
}): { fetch: typeof fetch; discordCalls: Array<{ url: string; body: unknown }> } {
  const discordCalls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('discord.com')) {
      discordCalls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(null, { status: 204 });
    }
    const feed = opts.feeds?.find((f) => f.url === url);
    if (!feed) {
      return new Response('not found', { status: 404 });
    }
    if (feed.throws) throw new Error('network down');
    return new Response(feed.xml ?? '', {
      status: feed.status ?? 200,
      headers: { 'Content-Type': 'application/xml' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, discordCalls };
}

// ============================================================
// Reset state
// ============================================================

beforeEach(() => {
  state.upsertCalls.length = 0;
  state.existingUrls.clear();
  state.unnotifiedEntries.length = 0;
  state.markedNotifiedIds.length = 0;
  state.cronRunCalls.length = 0;
  state.upsertShouldThrowFor.clear();
  state.listUnnotifiedShouldThrow = false;
  state.markShouldThrow = false;
  vi.clearAllMocks();
});

// ============================================================
// gating
// ============================================================

describe('isSyncWindow', () => {
  it('JST 04:30 ジャスト → true', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    expect(__test__.isSyncWindow(new Date('2026-05-26T19:30:00Z'))).toBe(true);
  });

  it('JST 04:34 → true (= 5 分窓内)', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    expect(__test__.isSyncWindow(new Date('2026-05-26T19:34:59Z'))).toBe(true);
  });

  it('JST 04:35 → false (= 窓外)', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    expect(__test__.isSyncWindow(new Date('2026-05-26T19:35:00Z'))).toBe(false);
  });

  it('JST 04:29 → false', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    expect(__test__.isSyncWindow(new Date('2026-05-26T19:29:00Z'))).toBe(false);
  });

  it('JST 04:00 (= ai-models-catalog の window) → false (= 分離確認)', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    expect(__test__.isSyncWindow(new Date('2026-05-26T19:00:00Z'))).toBe(false);
  });
});

// ============================================================
// parseRss
// ============================================================

describe('parseRss — RSS 2.0', () => {
  it('1 item + 全 fields', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>New Workers AI model added</title>
        <link>https://developers.cloudflare.com/changelog/2026-05-20-llama-4/</link>
        <pubDate>Wed, 20 May 2026 12:00:00 +0000</pubDate>
        <description>Llama 4 Scout is now available</description>
      </item>
    </channel></rss>`;
    const items = __test__.parseRss(xml);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'New Workers AI model added',
      link: 'https://developers.cloudflare.com/changelog/2026-05-20-llama-4/',
      description: 'Llama 4 Scout is now available',
    });
    expect(items[0]?.pubDate).toMatch(/^2026-05-20T12:00:00/);
  });

  it('複数 item', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    const xml = `<rss><channel>
      <item><title>A</title><link>https://x/a</link></item>
      <item><title>B</title><link>https://x/b</link></item>
      <item><title>C</title><link>https://x/c</link></item>
    </channel></rss>`;
    const items = __test__.parseRss(xml);
    expect(items.map((i) => i.title)).toEqual(['A', 'B', 'C']);
  });

  it('CDATA セクション内の content も extract', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    const xml = `<rss><channel>
      <item>
        <title><![CDATA[D1 backups now GA]]></title>
        <link>https://x/d1</link>
        <description><![CDATA[<p>Description with HTML</p>]]></description>
      </item>
    </channel></rss>`;
    const items = __test__.parseRss(xml);
    expect(items[0]?.title).toBe('D1 backups now GA');
    expect(items[0]?.description).toBe('Description with HTML');
  });

  it('description の HTML タグは strip + entity decode', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    const xml = `<rss><channel>
      <item>
        <title>T</title>
        <link>https://x/y</link>
        <description>Hello &amp; goodbye &lt;world&gt;</description>
      </item>
    </channel></rss>`;
    const items = __test__.parseRss(xml);
    expect(items[0]?.description).toBe('Hello & goodbye <world>');
  });

  it('link なし → skip (= 不正 item)', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    const xml = `<rss><channel>
      <item><title>No link</title></item>
      <item><title>OK</title><link>https://x</link></item>
    </channel></rss>`;
    const items = __test__.parseRss(xml);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('OK');
  });

  it('empty xml → []', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    expect(__test__.parseRss('')).toEqual([]);
  });

  it('malformed xml → 抽出可能な item のみ', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    const xml = `garbage<item><title>OK</title><link>https://x</link></item>more garbage`;
    const items = __test__.parseRss(xml);
    expect(items[0]?.title).toBe('OK');
  });
});

describe('parseRss — Atom fallback', () => {
  it('Atom entry も extract できる', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Atom entry</title>
        <link href="https://atom/1" />
        <updated>2026-05-25T10:00:00Z</updated>
        <summary>Summary text</summary>
      </entry>
    </feed>`;
    const items = __test__.parseRss(xml);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Atom entry');
    expect(items[0]?.link).toBe('https://atom/1');
  });
});

// ============================================================
// syncCloudflareChangelog — gating
// ============================================================

describe('syncCloudflareChangelog — gating', () => {
  it('窓外 → triggered=false, skippedReason=window, fetch 呼ばれない', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const fi = makeFetchImpl({});
    const fetchSpy = vi.spyOn(fi as unknown as { fetch: typeof fetch }, 'fetch');
    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb() },
      { now: new Date('2026-05-26T07:00:00+09:00'), fetchImpl: fi.fetch },
    );
    expect(result.triggered).toBe(false);
    expect(result.skippedReason).toBe('window');
    expect(state.cronRunCalls).toHaveLength(0);
    expect(state.upsertCalls).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  it('CHANGELOG_SYNC_FORCE=true → 窓外でも triggered', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const fi = makeFetchImpl({
      feeds: [
        {
          url: 'https://developers.cloudflare.com/changelog/index.xml',
          xml: '<rss><channel></channel></rss>',
        },
      ],
    });
    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), CHANGELOG_SYNC_FORCE: 'true' },
      { now: new Date('2026-05-26T15:00:00+09:00'), fetchImpl: fi.fetch },
    );
    expect(result.triggered).toBe(true);
  });
});

// ============================================================
// syncCloudflareChangelog — full flow
// ============================================================

describe('syncCloudflareChangelog — full flow', () => {
  const FORCE = { CHANGELOG_SYNC_FORCE: 'true' as const };
  const DISCORD = 'https://discord.com/api/webhooks/xxx/yyy';

  it('新着 2 件 → upsert + Discord 通知 + mark notified', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const xml = `<rss><channel>
      <item><title>Workers AI Llama 4 launch</title><link>https://x/llama4</link><pubDate>Tue, 20 May 2026 10:00:00 +0000</pubDate></item>
      <item><title>D1 read replicas GA</title><link>https://x/d1ga</link><pubDate>Mon, 19 May 2026 12:00:00 +0000</pubDate></item>
    </channel></rss>`;
    const fi = makeFetchImpl({
      feeds: [{ url: 'https://developers.cloudflare.com/changelog/index.xml', xml }],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), DISCORD_WEBHOOK_URL: DISCORD, ACCOUNT_NAME: 'naturism', ...FORCE },
      { fetchImpl: fi.fetch },
    );

    expect(result.triggered).toBe(true);
    expect(result.feedsProcessed).toBe(1);
    expect(result.feedsFailed).toBe(0);
    expect(result.newEntries).toBe(2);
    expect(result.notified).toBe(2);
    expect(state.upsertCalls).toHaveLength(2);
    expect(fi.discordCalls).toHaveLength(1);

    const body = fi.discordCalls[0]?.body as { content: string };
    expect(body.content).toContain('Cloudflare changelog updates');
    expect(body.content).toContain('naturism');
    expect(body.content).toContain('Workers AI Llama 4 launch');
    expect(body.content).toContain('D1 read replicas GA');

    expect(state.markedNotifiedIds).toHaveLength(2);
    expect(state.cronRunCalls[0]?.status).toBe('success');
  });

  it('既存 entry のみ → newEntries=0, notified=0, Discord 呼ばれない', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    state.existingUrls.add('https://x/old');
    const xml = `<rss><channel>
      <item><title>Old</title><link>https://x/old</link></item>
    </channel></rss>`;
    const fi = makeFetchImpl({
      feeds: [{ url: 'https://developers.cloudflare.com/changelog/index.xml', xml }],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), DISCORD_WEBHOOK_URL: DISCORD, ...FORCE },
      { fetchImpl: fi.fetch },
    );

    expect(result.newEntries).toBe(0);
    expect(result.notified).toBe(0);
    expect(fi.discordCalls).toHaveLength(0);
    expect(state.cronRunCalls[0]?.status).toBe('success');
  });

  it('feed fetch throws → feedsFailed++、 他 feed 続行 + status=partial', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const fi = makeFetchImpl({
      feeds: [
        { url: 'https://x/bad', throws: true },
        {
          url: 'https://x/good',
          xml: '<rss><channel><item><title>OK</title><link>https://x/ok</link></item></channel></rss>',
        },
      ],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE },
      {
        fetchImpl: fi.fetch,
        feeds: [
          { url: 'https://x/bad', category: 'a' },
          { url: 'https://x/good', category: 'b' },
        ],
      },
    );

    expect(result.feedsProcessed).toBe(1);
    expect(result.feedsFailed).toBe(1);
    expect(result.newEntries).toBe(1);
    expect(state.cronRunCalls[0]?.status).toBe('partial');
  });

  it('全 feed fail → status=error', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const fi = makeFetchImpl({
      feeds: [
        { url: 'https://x/bad1', throws: true },
        { url: 'https://x/bad2', throws: true },
      ],
    });
    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE },
      {
        fetchImpl: fi.fetch,
        feeds: [
          { url: 'https://x/bad1', category: 'a' },
          { url: 'https://x/bad2', category: 'b' },
        ],
      },
    );
    expect(result.feedsFailed).toBe(2);
    expect(result.feedsProcessed).toBe(0);
    expect(state.cronRunCalls[0]?.status).toBe('error');
  });

  it('feed 5xx → feedsFailed++', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const fi = makeFetchImpl({
      feeds: [{ url: 'https://x/503', status: 503, xml: '' }],
    });
    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE },
      { fetchImpl: fi.fetch, feeds: [{ url: 'https://x/503', category: 'a' }] },
    );
    expect(result.feedsFailed).toBe(1);
  });

  it('Discord webhook 未設定 → upsert 実行、 notify skip (= 次回 catchup 可)', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const xml = `<rss><channel>
      <item><title>X</title><link>https://x/y</link></item>
    </channel></rss>`;
    const fi = makeFetchImpl({
      feeds: [{ url: 'https://developers.cloudflare.com/changelog/index.xml', xml }],
    });
    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE }, // DISCORD_WEBHOOK_URL 未設定
      { fetchImpl: fi.fetch },
    );
    expect(result.newEntries).toBe(1);
    expect(result.notified).toBe(0);
    expect(fi.discordCalls).toHaveLength(0);
    expect(state.markedNotifiedIds).toHaveLength(0); // mark しない
  });

  it('maxNotifyPerRun=2 → 2 件のみ通知', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const xml = `<rss><channel>
      <item><title>A</title><link>https://x/a</link></item>
      <item><title>B</title><link>https://x/b</link></item>
      <item><title>C</title><link>https://x/c</link></item>
      <item><title>D</title><link>https://x/d</link></item>
      <item><title>E</title><link>https://x/e</link></item>
    </channel></rss>`;
    const fi = makeFetchImpl({
      feeds: [{ url: 'https://developers.cloudflare.com/changelog/index.xml', xml }],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), DISCORD_WEBHOOK_URL: DISCORD, ...FORCE },
      { fetchImpl: fi.fetch, maxNotifyPerRun: 2 },
    );

    expect(result.newEntries).toBe(5);
    expect(result.notified).toBe(2);
    expect(state.markedNotifiedIds).toHaveLength(2);
  });

  it('一部 upsert 失敗 → errors > 0、 他 entry は続行', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    state.upsertShouldThrowFor.add('https://x/bad');
    const xml = `<rss><channel>
      <item><title>OK1</title><link>https://x/ok1</link></item>
      <item><title>Bad</title><link>https://x/bad</link></item>
      <item><title>OK2</title><link>https://x/ok2</link></item>
    </channel></rss>`;
    const fi = makeFetchImpl({
      feeds: [{ url: 'https://developers.cloudflare.com/changelog/index.xml', xml }],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE },
      { fetchImpl: fi.fetch },
    );

    expect(result.newEntries).toBe(2);
    expect(result.errors).toBe(1);
    expect(state.cronRunCalls[0]?.status).toBe('partial');
  });

  it('Discord 通知 throw → errors++、 mark しない (= 次回 catchup)', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const xml = `<rss><channel>
      <item><title>X</title><link>https://x/y</link></item>
    </channel></rss>`;
    // discord call が throw する fetch impl
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('discord.com')) {
        throw new Error('discord down');
      }
      if (url.includes('cloudflare.com')) {
        return new Response(xml, { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), DISCORD_WEBHOOK_URL: DISCORD, ...FORCE },
      { fetchImpl },
    );

    expect(result.newEntries).toBe(1);
    expect(result.notified).toBe(0);
    expect(result.errors).toBeGreaterThan(0);
    expect(state.markedNotifiedIds).toHaveLength(0);
  });

  it('cron_run_logs に必ず record される (= 全 feed 失敗でも)', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const fi = makeFetchImpl({});
    await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE },
      {
        fetchImpl: fi.fetch,
        feeds: [{ url: 'https://x/missing', category: 'x' }],
      },
    );
    expect(state.cronRunCalls).toHaveLength(1);
    expect(state.cronRunCalls[0]?.jobName).toBe('cloudflare-changelog-sync');
  });
});
