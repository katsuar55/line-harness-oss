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
  cronRunCalls: [] as Array<{
    jobName: string;
    status: string;
    metrics?: unknown;
    errorSummary?: string;
  }>,
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
    async (
      _db: unknown,
      input: { jobName: string; status: string; metrics?: unknown; errorSummary?: string },
    ) => {
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

  it('🚨実 feed 形式 (エスケープ済み HTML) の description からタグが除去される', async () => {
    // 2026-08-11 監査: 旧実装は「タグ strip → entity decode」の順だったため、
    // エスケープ済み HTML (実 feed の 100%) では strip が no-op になり
    // タグがそのまま D1 に保存されていた。decode → strip の順が正しい。
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    const xml = `<rss><channel>
      <item>
        <title>T</title>
        <link>https://x/y</link>
        <description>&lt;p&gt;Billing is now enabled for &lt;a href=&quot;https://developers.cloudflare.com/r2/&quot;&gt;R2 Data Catalog&lt;/a&gt;.&lt;/p&gt;</description>
      </item>
    </channel></rss>`;
    const items = __test__.parseRss(xml);
    expect(items[0]?.description).toBe('Billing is now enabled for R2 Data Catalog.');
    expect(items[0]?.description).not.toContain('<');
  });

  it('entity decode: &amp; は最後に decode (二重エスケープは 1 段のみ) + 本文中の不等号は残る', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    const xml = `<rss><channel>
      <item>
        <title>T</title>
        <link>https://x/y</link>
        <description>value &lt; 10 and &gt; 5, Tom &amp; Jerry, literal &amp;lt;tag&amp;gt;</description>
      </item>
    </channel></rss>`;
    const items = __test__.parseRss(xml);
    // "< 10" は英字が続かないのでタグとして strip されない。
    // "&amp;lt;" は 1 段だけ decode され "&lt;" の literal として残る (タグ化しない)。
    expect(items[0]?.description).toBe('value < 10 and > 5, Tom & Jerry, literal &lt;tag&gt;');
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
      feeds: [{ url: 'https://x/feed', xml: '<rss><channel></channel></rss>' }],
    });
    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), CHANGELOG_SYNC_FORCE: 'true' },
      {
        now: new Date('2026-05-26T15:00:00+09:00'),
        fetchImpl: fi.fetch,
        feeds: [{ url: 'https://x/feed', category: 'general' }],
      },
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
  /** fixture の pubDate (2026-05) が取込 cutoff (30 日) に入る基準時刻 */
  const NOW_MAY = new Date('2026-05-26T04:31:00+09:00');
  const ONE_FEED = [{ url: 'https://x/feed', category: 'general' }];

  it('新着 2 件 → upsert + Discord 通知 + mark notified', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const xml = `<rss><channel>
      <item><title>Workers AI Llama 4 launch</title><link>https://x/llama4</link><pubDate>Tue, 20 May 2026 10:00:00 +0000</pubDate></item>
      <item><title>D1 read replicas GA</title><link>https://x/d1ga</link><pubDate>Mon, 19 May 2026 12:00:00 +0000</pubDate></item>
    </channel></rss>`;
    const fi = makeFetchImpl({
      feeds: [{ url: 'https://x/feed', xml }],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), DISCORD_WEBHOOK_URL: DISCORD, ACCOUNT_NAME: 'naturism', ...FORCE },
      { fetchImpl: fi.fetch, feeds: ONE_FEED, now: NOW_MAY },
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
      feeds: [{ url: 'https://x/feed', xml }],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), DISCORD_WEBHOOK_URL: DISCORD, ...FORCE },
      { fetchImpl: fi.fetch, feeds: ONE_FEED },
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
      feeds: [{ url: 'https://x/feed', xml }],
    });
    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE }, // DISCORD_WEBHOOK_URL 未設定
      { fetchImpl: fi.fetch, feeds: ONE_FEED },
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
      feeds: [{ url: 'https://x/feed', xml }],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), DISCORD_WEBHOOK_URL: DISCORD, ...FORCE },
      { fetchImpl: fi.fetch, maxNotifyPerRun: 2, feeds: ONE_FEED },
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
      feeds: [{ url: 'https://x/feed', xml }],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE },
      { fetchImpl: fi.fetch, feeds: ONE_FEED },
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
      if (url === 'https://x/feed') {
        return new Response(xml, { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), DISCORD_WEBHOOK_URL: DISCORD, ...FORCE },
      { fetchImpl, feeds: ONE_FEED },
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

  it('feed 失敗理由が errorSummary に残る (= 2026-08 の「原因未調査」再発防止)', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const fi = makeFetchImpl({
      feeds: [{ url: 'https://x/404', status: 404, xml: '' }],
    });
    await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE },
      { fetchImpl: fi.fetch, feeds: [{ url: 'https://x/404', category: 'workers' }] },
    );
    expect(state.cronRunCalls[0]?.status).toBe('error');
    expect(state.cronRunCalls[0]?.errorSummary).toContain('workers: feed returned 404');
  });
});

// ============================================================
// DEFAULT_FEEDS — 2026-08 の URL 再編への追随 (回帰ガード)
// ============================================================

describe('DEFAULT_FEEDS', () => {
  it('🚨旧 /changelog/index.xml (404) を含まない', async () => {
    const { DEFAULT_FEEDS } = await import('../services/cloudflare-changelog-sync.js');
    expect(
      DEFAULT_FEEDS.some((f) => f.url === 'https://developers.cloudflare.com/changelog/index.xml'),
    ).toBe(false);
  });

  it('スタック構成要素 4 本 (workers / workers-ai / d1 / r2) を製品別 URL で購読', async () => {
    const { DEFAULT_FEEDS } = await import('../services/cloudflare-changelog-sync.js');
    expect(DEFAULT_FEEDS.map((f) => f.url)).toEqual([
      'https://developers.cloudflare.com/changelog/rss/workers.xml',
      'https://developers.cloudflare.com/changelog/rss/workers-ai.xml',
      'https://developers.cloudflare.com/changelog/rss/d1.xml',
      'https://developers.cloudflare.com/changelog/rss/r2.xml',
    ]);
    expect(DEFAULT_FEEDS.map((f) => f.category)).toEqual([
      'workers',
      'workers-ai',
      'd1',
      'r2',
    ]);
  });

  it('🚨feeds option 未指定の本番経路で DEFAULT_FEEDS 4 本が実際に fetch される', async () => {
    // 2026-08-11 監査: 全 flow テストが feeds を明示 override していたため、
    // `options.feeds ?? DEFAULT_FEEDS` の配線が壊れても (例: `?? []`) 全 green の
    // まま本番だけ「毎日 success で 0 feed 処理」の無音死になることを mutation で実証。
    // このテストが本番経路 (feeds 未指定) を実走させる。
    const { syncCloudflareChangelog, DEFAULT_FEEDS } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const xmlFor = (title: string) =>
      `<rss><channel><item><title>${title}</title><link>https://x/${title}</link></item></channel></rss>`;
    const fi = makeFetchImpl({
      feeds: DEFAULT_FEEDS.map((f) => ({ url: f.url, xml: xmlFor(f.category) })),
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), CHANGELOG_SYNC_FORCE: 'true' },
      { fetchImpl: fi.fetch }, // feeds 未指定 = 本番と同じ
    );

    expect(result.feedsProcessed).toBe(4);
    expect(result.feedsFailed).toBe(0);
    expect(state.upsertCalls.map((c) => c.category).sort()).toEqual([
      'd1',
      'r2',
      'workers',
      'workers-ai',
    ]);
  });
});

// ============================================================
// 取込境界 (= backfill 暴走防止)
// ============================================================

describe('取込境界 — maxItemsPerFeed / maxEntryAgeDays', () => {
  const FORCE = { CHANGELOG_SYNC_FORCE: 'true' as const };
  const NOW = new Date('2026-08-11T04:31:00+09:00');

  it('isOlderThan: 欠落 / 解析不能は false (= 安全側で新しい扱い)', async () => {
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    const cutoff = NOW.getTime() - 30 * 86_400_000;
    expect(__test__.isOlderThan(null, cutoff)).toBe(false);
    expect(__test__.isOlderThan(undefined, cutoff)).toBe(false);
    expect(__test__.isOlderThan('not-a-date', cutoff)).toBe(false);
    expect(__test__.isOlderThan('2026-08-10T00:00:00Z', cutoff)).toBe(false);
    expect(__test__.isOlderThan('2026-01-01T00:00:00Z', cutoff)).toBe(true);
  });

  it('maxEntryAgeDays より古い item に達したら走査を打ち切る (pubDate なしは取り込む)', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    // feed は新しい順: Fresh → NoDate (欠落 = 新しい扱い) → Ancient (打ち切り) → After
    const xml = `<rss><channel>
      <item><title>Fresh</title><link>https://x/fresh</link><pubDate>Mon, 10 Aug 2026 00:00:00 +0000</pubDate></item>
      <item><title>NoDate</title><link>https://x/nodate</link></item>
      <item><title>Ancient</title><link>https://x/ancient</link><pubDate>Mon, 26 May 2026 00:00:00 +0000</pubDate></item>
      <item><title>After</title><link>https://x/after</link></item>
    </channel></rss>`;
    const fi = makeFetchImpl({ feeds: [{ url: 'https://x/feed', xml }] });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE },
      { fetchImpl: fi.fetch, feeds: [{ url: 'https://x/feed', category: 'g' }], now: NOW },
    );

    expect(state.upsertCalls.map((c) => c.title)).toEqual(['Fresh', 'NoDate']);
    expect(result.newEntries).toBe(2);
  });

  it('maxItemsPerFeed は新規 insert 数の cap → 到達で打ち切り + cappedFeeds で可視化', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const items = Array.from(
      { length: 5 },
      (_, i) => `<item><title>T${i}</title><link>https://x/${i}</link></item>`,
    ).join('');
    const fi = makeFetchImpl({
      feeds: [{ url: 'https://x/feed', xml: `<rss><channel>${items}</channel></rss>` }],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE },
      {
        fetchImpl: fi.fetch,
        feeds: [{ url: 'https://x/feed', category: 'g' }],
        now: NOW,
        maxItemsPerFeed: 2,
      },
    );

    expect(state.upsertCalls.map((c) => c.title)).toEqual(['T0', 'T1']);
    expect(result.newEntries).toBe(2);
    expect(result.cappedFeeds).toBe(1);
  });

  it('🚨既取込 (seen) の item は cap を消費しない — backfill 途中でこぼれた item が翌 run で拾われる', async () => {
    // 2026-08-11 監査: cap を feed 先頭位置に効かせると (slice 方式)、
    // cap からこぼれた item は翌日以降も先頭に戻れず永久欠落する。
    // cap は「新規 insert 数」に効かせ、seen をスキップして深い位置の未取込を拾う。
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    state.existingUrls.add('https://x/0');
    state.existingUrls.add('https://x/1');
    const items = Array.from(
      { length: 3 },
      (_, i) => `<item><title>T${i}</title><link>https://x/${i}</link></item>`,
    ).join('');
    const fi = makeFetchImpl({
      feeds: [{ url: 'https://x/feed', xml: `<rss><channel>${items}</channel></rss>` }],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE },
      {
        fetchImpl: fi.fetch,
        feeds: [{ url: 'https://x/feed', category: 'g' }],
        now: NOW,
        maxItemsPerFeed: 1,
      },
    );

    // slice 方式なら T0 (seen) だけ見て終わり newEntries=0。
    // isNew-cap 方式は T0/T1 (seen) を素通りして T2 を拾う。
    expect(state.upsertCalls.map((c) => c.title)).toEqual(['T0', 'T1', 'T2']);
    expect(result.newEntries).toBe(1);
  });

  it('cap を消費するのは新規 insert のみ — seen が先行しても新規 N 件フルに取り込む', async () => {
    // mutation M8 の回帰ガード: cap 判定を「走査位置 (scanned)」に変えると、
    // seen が先行した時点で走査位置が cap を先食いし、新規が N 件未満で打ち切られる。
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    state.existingUrls.add('https://x/0'); // 先頭だけ seen
    const items = Array.from(
      { length: 4 },
      (_, i) => `<item><title>T${i}</title><link>https://x/${i}</link></item>`,
    ).join('');
    const fi = makeFetchImpl({
      feeds: [{ url: 'https://x/feed', xml: `<rss><channel>${items}</channel></rss>` }],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE },
      {
        fetchImpl: fi.fetch,
        feeds: [{ url: 'https://x/feed', category: 'g' }],
        now: NOW,
        maxItemsPerFeed: 2,
      },
    );

    // T0=seen (cap 消費なし) → T1/T2 が新規 2 件で cap 到達 → T3 は翌 run へ
    expect(state.upsertCalls.map((c) => c.title)).toEqual(['T0', 'T1', 'T2']);
    expect(result.newEntries).toBe(2);
    expect(result.cappedFeeds).toBe(1);
  });

  it('FEED_SCAN_CAP で走査ブロック数が絶対有界 (pubDate 無し + 全 seen でも)', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    const { __test__ } = await import('../services/cloudflare-changelog-sync.js');
    const count = __test__.FEED_SCAN_CAP + 20;
    const items = Array.from({ length: count }, (_, i) => {
      state.existingUrls.add(`https://x/${i}`);
      return `<item><title>T${i}</title><link>https://x/${i}</link></item>`;
    }).join('');
    const fi = makeFetchImpl({
      feeds: [{ url: 'https://x/feed', xml: `<rss><channel>${items}</channel></rss>` }],
    });

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE },
      { fetchImpl: fi.fetch, feeds: [{ url: 'https://x/feed', category: 'g' }], now: NOW },
    );

    expect(state.upsertCalls.length).toBe(__test__.FEED_SCAN_CAP);
    expect(result.cappedFeeds).toBe(1);
  });
});

// ============================================================
// 通知境界 (= 滞留 entry のドリップ通知防止)
// ============================================================

describe('通知境界 — NOTIFY_MAX_AGE_DAYS', () => {
  const FORCE = { CHANGELOG_SYNC_FORCE: 'true' as const };
  const DISCORD = 'https://discord.com/api/webhooks/xxx/yyy';
  const NOW = new Date('2026-08-11T04:31:00+09:00');
  const EMPTY_FEED = {
    feeds: [{ url: 'https://x/feed', xml: '<rss><channel></channel></rss>' }],
  };

  it('発行 14 日超の未通知 entry は Discord に流さず notified mark のみ', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    state.unnotifiedEntries.push(
      {
        id: 'stale-1',
        title: 'Stale entry',
        entryUrl: 'https://x/stale',
        category: 'g',
        publishedAt: '2026-06-01T00:00:00Z',
        description: null,
      },
      {
        id: 'fresh-1',
        title: 'Fresh entry',
        entryUrl: 'https://x/freshentry',
        category: 'g',
        publishedAt: '2026-08-10T00:00:00Z',
        description: null,
      },
    );
    const fi = makeFetchImpl(EMPTY_FEED);

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), DISCORD_WEBHOOK_URL: DISCORD, ...FORCE },
      { fetchImpl: fi.fetch, feeds: [{ url: 'https://x/feed', category: 'g' }], now: NOW },
    );

    expect(result.suppressedStale).toBe(1);
    expect(result.notified).toBe(1);
    expect(state.markedNotifiedIds).toEqual(['stale-1', 'fresh-1']);
    expect(fi.discordCalls).toHaveLength(1);
    const body = fi.discordCalls[0]?.body as { content: string };
    expect(body.content).toContain('Fresh entry');
    expect(body.content).not.toContain('Stale entry');
  });

  it('webhook 未設定でも stale は mark される (= 後から webhook を設定しても flood しない)', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    state.unnotifiedEntries.push(
      {
        id: 'stale-2',
        title: 'Stale',
        entryUrl: 'https://x/stale2',
        category: 'g',
        publishedAt: '2026-06-01T00:00:00Z',
        description: null,
      },
      {
        id: 'fresh-2',
        title: 'Fresh',
        entryUrl: 'https://x/fresh2',
        category: 'g',
        publishedAt: '2026-08-10T00:00:00Z',
        description: null,
      },
    );
    const fi = makeFetchImpl(EMPTY_FEED);

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), ...FORCE }, // webhook 未設定
      { fetchImpl: fi.fetch, feeds: [{ url: 'https://x/feed', category: 'g' }], now: NOW },
    );

    expect(result.suppressedStale).toBe(1);
    expect(result.notified).toBe(0);
    // fresh は catchup のため未通知のまま残る
    expect(state.markedNotifiedIds).toEqual(['stale-2']);
    expect(fi.discordCalls).toHaveLength(0);
  });

  it('publishedAt が null の未通知 entry は fresh 扱いで通知される', async () => {
    const { syncCloudflareChangelog } = await import(
      '../services/cloudflare-changelog-sync.js'
    );
    state.unnotifiedEntries.push({
      id: 'nodate-1',
      title: 'No date entry',
      entryUrl: 'https://x/nodate1',
      category: 'g',
      publishedAt: null,
      description: null,
    });
    const fi = makeFetchImpl(EMPTY_FEED);

    const result = await syncCloudflareChangelog(
      { DB: makeFakeDb(), DISCORD_WEBHOOK_URL: DISCORD, ...FORCE },
      { fetchImpl: fi.fetch, feeds: [{ url: 'https://x/feed', category: 'g' }], now: NOW },
    );

    expect(result.notified).toBe(1);
    expect(result.suppressedStale).toBe(0);
  });
});
