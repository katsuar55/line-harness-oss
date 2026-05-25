/**
 * Cloudflare Developer Changelog Sync (= 自動 update 戦略 #2、 2026-05-26)
 *
 * 目的:
 *   Cloudflare 公式 developer changelog (= RSS feed) を daily で fetch、
 *   未通知 entry のみ Discord 通知。 PR #71 の model 検出と相補的に、
 *   changelog レベルで新機能 / 廃止 / breaking change を catch する。
 *
 * 設計方針:
 *   - **gating**: JST 04:30-04:34 window (= 04:00 cleanup + ai-models と分離)。
 *     `CHANGELOG_SYNC_FORCE='true'` で bypass。
 *   - **fail-safe**: 個別 feed の fetch / parse 失敗で他 feed への影響なし。
 *   - **冪等**: D1 に entry_url を保存して二度通知しない。
 *   - **graceful no-op**: `DISCORD_WEBHOOK_URL` 未設定でも D1 への
 *     entry tracking は実行 (= 後から webhook 設定すれば未通知 entry が
 *     次回 sync で通知される、 catchup 機能つき)。
 *   - **認証不要**: public RSS feed なので secret 設定なしで稼働。
 *
 * RSS source (= Hugo-generated RSS 2.0):
 *   - https://developers.cloudflare.com/changelog/index.xml (= 全カテゴリ集約)
 *   - 個別カテゴリは将来追加可 (= workers-ai / workers / d1 / r2)
 */

import {
  upsertChangelogEntry,
  listUnnotifiedChangelogEntries,
  markChangelogEntriesNotified,
  insertCronRunLog,
} from '@line-crm/db';

// ============================================================
// 型
// ============================================================

export interface ChangelogSyncEnv {
  DB: D1Database;
  DISCORD_WEBHOOK_URL?: string;
  ACCOUNT_NAME?: string;
  /** 'true' で JST 04:30 window gating bypass */
  CHANGELOG_SYNC_FORCE?: string;
}

export interface ChangelogSyncOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
  /** RSS feed の override (= テスト用 / 将来カテゴリ追加用) */
  feeds?: ChangelogFeed[];
  /** Discord 通知の最大 entry 数 (= rate limit + 読みやすさ、 default 10) */
  maxNotifyPerRun?: number;
}

export interface ChangelogFeed {
  url: string;
  category: string;
}

export interface ChangelogSyncResult {
  triggered: boolean;
  skippedReason?: 'window';
  feedsProcessed: number;
  feedsFailed: number;
  newEntries: number;
  notified: number;
  errors: number;
}

interface ParsedRssItem {
  title: string;
  link: string;
  pubDate?: string | null;
  description?: string | null;
}

// ============================================================
// 定数
// ============================================================

export const CHANGELOG_SYNC_JOB_NAME = 'cloudflare-changelog-sync';
const TRIGGER_HOUR = 4;
const TRIGGER_MINUTE_FROM = 30;
const TRIGGER_MINUTE_TO_EXCLUSIVE = 35;
const DEFAULT_MAX_NOTIFY = 10;

export const DEFAULT_FEEDS: ChangelogFeed[] = [
  {
    url: 'https://developers.cloudflare.com/changelog/index.xml',
    category: 'general',
  },
];

// ============================================================
// gating
// ============================================================

export function isSyncWindow(now: Date): boolean {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return (
    jst.getUTCHours() === TRIGGER_HOUR &&
    jst.getUTCMinutes() >= TRIGGER_MINUTE_FROM &&
    jst.getUTCMinutes() < TRIGGER_MINUTE_TO_EXCLUSIVE
  );
}

// ============================================================
// RSS parser (= simple regex、 Workers ランタイム互換)
// ============================================================

/**
 * RSS 2.0 / Atom 混在を想定。
 * Cloudflare の Hugo-generated feed は RSS 2.0 (= <item>...</item>) なので
 * それを優先。 Atom (= <entry>...</entry>) も fallback で抽出。
 */
export function parseRss(xml: string): ParsedRssItem[] {
  const items: ParsedRssItem[] = [];

  // RSS 2.0 items
  const rssItemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = rssItemRe.exec(xml)) !== null) {
    const block = match[1] ?? '';
    const item = extractRssItem(block);
    if (item) items.push(item);
  }

  // Atom entries (= fallback)
  if (items.length === 0) {
    const atomRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
    while ((match = atomRe.exec(xml)) !== null) {
      const block = match[1] ?? '';
      const item = extractAtomEntry(block);
      if (item) items.push(item);
    }
  }

  return items;
}

function extractRssItem(block: string): ParsedRssItem | null {
  const title = extractTag(block, 'title');
  const link = extractTag(block, 'link') ?? extractAttr(block, 'guid');
  if (!title || !link) return null;
  const pubDate = extractTag(block, 'pubDate');
  const description = extractTag(block, 'description');
  return {
    title: stripCdata(title).trim(),
    link: link.trim(),
    pubDate: pubDate ? normalizeDate(pubDate.trim()) : null,
    description: description ? stripCdata(description).trim().slice(0, 500) : null,
  };
}

function extractAtomEntry(block: string): ParsedRssItem | null {
  const title = extractTag(block, 'title');
  // Atom <link href="..." />
  const linkMatch = block.match(/<link[^>]+href=["']([^"']+)["']/i);
  const link = linkMatch?.[1];
  if (!title || !link) return null;
  const updated = extractTag(block, 'updated') ?? extractTag(block, 'published');
  const summary = extractTag(block, 'summary') ?? extractTag(block, 'content');
  return {
    title: stripCdata(title).trim(),
    link: link.trim(),
    pubDate: updated ? normalizeDate(updated.trim()) : null,
    description: summary ? stripCdata(summary).trim().slice(0, 500) : null,
  };
}

function extractTag(block: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = block.match(re);
  return m?.[1] ?? null;
}

function extractAttr(block: string, tagName: string): string | null {
  // <guid isPermaLink="true">https://...</guid> → return inner text
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = block.match(re);
  return m?.[1] ? stripCdata(m[1]).trim() : null;
}

function stripCdata(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '') // strip inner HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function normalizeDate(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toISOString();
}

// ============================================================
// 主処理
// ============================================================

export async function syncCloudflareChangelog(
  env: ChangelogSyncEnv,
  options: ChangelogSyncOptions = {},
): Promise<ChangelogSyncResult> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const feeds = options.feeds ?? DEFAULT_FEEDS;
  const maxNotify = options.maxNotifyPerRun ?? DEFAULT_MAX_NOTIFY;
  const force = env.CHANGELOG_SYNC_FORCE === 'true';

  const baseResult: ChangelogSyncResult = {
    triggered: false,
    feedsProcessed: 0,
    feedsFailed: 0,
    newEntries: 0,
    notified: 0,
    errors: 0,
  };

  if (!force && !isSyncWindow(now)) {
    return { ...baseResult, skippedReason: 'window' };
  }

  let feedsProcessed = 0;
  let feedsFailed = 0;
  let newEntries = 0;
  let errors = 0;

  // 1. 各 feed を fetch + parse + upsert
  for (const feed of feeds) {
    try {
      const xml = await fetchFeed(feed.url, fetchImpl);
      const items = parseRss(xml);
      feedsProcessed += 1;
      for (const item of items) {
        try {
          const r = await upsertChangelogEntry(env.DB, {
            entryUrl: item.link,
            title: item.title,
            category: feed.category,
            publishedAt: item.pubDate ?? null,
            description: item.description ?? null,
          });
          if (r.isNew) newEntries += 1;
        } catch (err) {
          errors += 1;
          console.error(
            '[cloudflare-changelog-sync] upsert failed for',
            item.link,
            err instanceof Error ? err.message : 'unknown',
          );
        }
      }
    } catch (err) {
      feedsFailed += 1;
      console.error(
        '[cloudflare-changelog-sync] feed fetch failed',
        feed.url,
        err instanceof Error ? err.message : 'unknown',
      );
    }
  }

  // 2. 未通知 entry を取得して Discord 通知
  let notified = 0;
  try {
    const unnotified = await listUnnotifiedChangelogEntries(env.DB, maxNotify);
    if (unnotified.length > 0 && env.DISCORD_WEBHOOK_URL) {
      try {
        await sendDiscordNotification(
          env.DISCORD_WEBHOOK_URL,
          env.ACCOUNT_NAME ?? 'naturism',
          unnotified,
          fetchImpl,
        );
        await markChangelogEntriesNotified(
          env.DB,
          unnotified.map((e) => e.id),
        );
        notified = unnotified.length;
      } catch (err) {
        errors += 1;
        console.error(
          '[cloudflare-changelog-sync] Discord notification failed',
          err instanceof Error ? err.message : 'unknown',
        );
      }
    }
  } catch (err) {
    errors += 1;
    console.error(
      '[cloudflare-changelog-sync] listUnnotified failed',
      err instanceof Error ? err.message : 'unknown',
    );
  }

  // 3. cron_run_logs に記録
  const status =
    feedsFailed === feeds.length && feeds.length > 0
      ? 'error'
      : errors > 0 || feedsFailed > 0
      ? 'partial'
      : 'success';
  await recordCronRun(env.DB, status, {
    feedsProcessed,
    feedsFailed,
    newEntries,
    notified,
    errors,
  });

  return {
    triggered: true,
    feedsProcessed,
    feedsFailed,
    newEntries,
    notified,
    errors,
  };
}

// ============================================================
// helpers
// ============================================================

async function fetchFeed(url: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/rss+xml, application/xml, text/xml',
      'User-Agent': 'naturism-line-crm/1.0 (https://github.com/katsuar55/line-harness-oss)',
    },
  });
  if (!response.ok) {
    throw new Error(`feed returned ${response.status}`);
  }
  return await response.text();
}

async function recordCronRun(
  db: D1Database,
  status: 'success' | 'partial' | 'error' | 'skipped',
  metrics?: object,
  errorSummary?: string,
): Promise<void> {
  try {
    await insertCronRunLog(db, {
      jobName: CHANGELOG_SYNC_JOB_NAME,
      status,
      metrics,
      errorSummary,
    });
  } catch (err) {
    console.error(
      '[cloudflare-changelog-sync] cron_run_logs insert failed',
      err instanceof Error ? err.message : 'unknown',
    );
  }
}

interface NotifyEntry {
  id: string;
  title: string;
  entryUrl: string;
  category: string;
  publishedAt: string | null;
  description: string | null;
}

async function sendDiscordNotification(
  webhookUrl: string,
  account: string,
  entries: NotifyEntry[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const lines: string[] = [
    `:newspaper: **Cloudflare changelog updates** \`${account}\` (${entries.length} new)`,
  ];
  for (const e of entries) {
    const date = e.publishedAt ? formatJstDate(e.publishedAt) : 'n/a';
    lines.push(`- **${e.title}** [${date}] [${e.category}]`);
    lines.push(`  ${e.entryUrl}`);
  }
  const content = truncate(lines.join('\n'), 1900);
  await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

function formatJstDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ============================================================
// テスト用エクスポート
// ============================================================

export const __test__ = {
  isSyncWindow,
  parseRss,
  TRIGGER_HOUR,
  TRIGGER_MINUTE_FROM,
};
