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
 * RSS source (= RSS 2.0):
 *   - 2026-08-11 更新: 旧 `/changelog/index.xml` は 404 (Cloudflare 側の URL 再編)。
 *     現行は製品別 `/changelog/rss/<product>.xml`。全体集約
 *     (`/changelog/rss/index.xml`) は 7MB / 1,100+ items と巨大なため使わない。
 *   - 採用 feed はこのスタックの構成要素のみ: workers / workers-ai / d1 / r2。
 *   - feed 一覧: https://developers.cloudflare.com/fundamentals/new-features/available-rss-feeds/
 *
 * 取込境界 (= 初回 backfill と CPU / D1 subrequest 数の暴走防止):
 *   - item ブロックは generator で遅延抽出し、`pubDate` が `maxEntryAgeDays`
 *     (default 30) より古い item に達したら打ち切り (feed は新しい順)。
 *     pubDate 欠落 / 解析不能は安全側 = 打ち切らず取り込む。
 *   - `maxItemsPerFeed` (default 20) は「1 run あたりの新規 insert 数」の cap。
 *     feed 先頭位置に効かせると cap からこぼれた item が永久欠落するため
 *     (isNew 判定は D1 の seen チェック)。cap 到達は metrics の `cappedFeeds` で
 *     可視化し、残りは翌日以降の run が拾う。
 *   - `FEED_SCAN_CAP` (100) = 走査ブロック数の絶対上限 (順序崩れ・pubDate 無し
 *     feed でも有界)。
 *   - 発行から `NOTIFY_MAX_AGE_DAYS` (14 日) を超えた未通知 entry は Discord に
 *     流さず notified mark のみ (= 旧 URL 期間に溜まった過去 entry を連日 10 件ずつ
 *     ドリップ通知しない)。
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
  /** 1 feed あたりの処理 item 上限 (= 新しい順に先頭 N 件、 default 20) */
  maxItemsPerFeed?: number;
  /** これより古い pubDate の item は upsert しない (default 30 日) */
  maxEntryAgeDays?: number;
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
  /** 発行が古すぎるため Discord に流さず notified mark だけした entry 数 */
  suppressedStale: number;
  /** cap (maxItemsPerFeed / FEED_SCAN_CAP) で走査を打ち切った feed 数 (= backlog の可視化) */
  cappedFeeds: number;
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
const DEFAULT_MAX_ITEMS_PER_FEED = 20;
const DEFAULT_MAX_ENTRY_AGE_DAYS = 30;
/** 発行からこれを超えた未通知 entry は Discord に流さず notified mark のみ */
const NOTIFY_MAX_AGE_DAYS = 14;
/**
 * 1 feed で走査する item ブロックの絶対上限。feed の新しい順が崩れた場合や
 * pubDate の無い feed でも、CPU と D1 subrequest を有界に保つ backstop。
 */
const FEED_SCAN_CAP = 100;
/** description の strip チェーンに掛ける生入力の上限 (出力は 500 字) */
const RAW_DESCRIPTION_MAX = 2000;

export const DEFAULT_FEEDS: ChangelogFeed[] = [
  {
    url: 'https://developers.cloudflare.com/changelog/rss/workers.xml',
    category: 'workers',
  },
  {
    url: 'https://developers.cloudflare.com/changelog/rss/workers-ai.xml',
    category: 'workers-ai',
  },
  {
    url: 'https://developers.cloudflare.com/changelog/rss/d1.xml',
    category: 'd1',
  },
  {
    url: 'https://developers.cloudflare.com/changelog/rss/r2.xml',
    category: 'r2',
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
 * Cloudflare の feed は RSS 2.0 (= <item>...</item>) なのでそれを優先。
 * Atom (= <entry>...</entry>) も fallback で抽出。
 *
 * generator なのは CPU を有界にするため (2026-08-11 監査): workers.xml は
 * 2.3MB / 219 items あり、全 item の field 抽出は実測 ~100ms。item 境界の
 * 走査自体は ~4ms と安いので、呼び出し側が必要な件数で打ち切れば
 * 抽出コストは処理件数に比例する。
 */
export function* iterateRssItems(xml: string): Generator<ParsedRssItem> {
  let yielded = 0;

  // RSS 2.0 items
  const rssItemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = rssItemRe.exec(xml)) !== null) {
    const item = extractRssItem(match[1] ?? '');
    if (item) {
      yielded += 1;
      yield item;
    }
  }

  // Atom entries (= fallback、 RSS item が 1 件も取れなかったときのみ)
  if (yielded === 0) {
    const atomRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
    while ((match = atomRe.exec(xml)) !== null) {
      const item = extractAtomEntry(match[1] ?? '');
      if (item) yield item;
    }
  }
}

export function parseRss(xml: string): ParsedRssItem[] {
  return [...iterateRssItems(xml)];
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
    description: description ? sanitizeDescription(description) : null,
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
    description: summary ? sanitizeDescription(summary) : null,
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

/**
 * CDATA unwrap → 実体参照 decode → HTML タグ strip。
 *
 * この順序が本質 (2026-08-11 監査): 実 feed の description は HTML エスケープ済み
 * (`&lt;p&gt;&lt;a href=&quot;...&quot;&gt;`) なので、decode より先に strip すると
 * raw の `<` が存在せず strip が no-op になり、decode で復元されたタグがそのまま
 * D1 に保存される (実測で全 item 該当)。decode は `&amp;` を最後に置く
 * (先に戻すと `&amp;lt;` が二重 decode されて意図しないタグ化が起きる)。
 * タグ strip はタグ名先頭 (英字) に限定し、本文中の不等号 `a < b` を守る。
 * 二重エスケープ (`&amp;lt;`) は仕様として 1 段だけ decode する。
 */
function stripCdata(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ''); // strip HTML tags (decode 後)
}

/**
 * description 用: strip チェーンに掛ける生入力を制限してから 500 字に切る。
 * 出力は 500 字なので、2.3MB feed の長大な HTML description を全量 replace
 * するのは捨て CPU (エスケープ済み HTML を途中で切っても要約用途では無害)。
 */
function sanitizeDescription(raw: string): string {
  return stripCdata(raw.slice(0, RAW_DESCRIPTION_MAX)).trim().slice(0, 500);
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
  const maxItemsPerFeed = options.maxItemsPerFeed ?? DEFAULT_MAX_ITEMS_PER_FEED;
  const maxEntryAgeDays = options.maxEntryAgeDays ?? DEFAULT_MAX_ENTRY_AGE_DAYS;
  const force = env.CHANGELOG_SYNC_FORCE === 'true';

  const baseResult: ChangelogSyncResult = {
    triggered: false,
    feedsProcessed: 0,
    feedsFailed: 0,
    newEntries: 0,
    notified: 0,
    suppressedStale: 0,
    cappedFeeds: 0,
    errors: 0,
  };

  if (!force && !isSyncWindow(now)) {
    return { ...baseResult, skippedReason: 'window' };
  }

  const ingestCutoffMs = now.getTime() - maxEntryAgeDays * 86_400_000;

  let feedsProcessed = 0;
  let feedsFailed = 0;
  let newEntries = 0;
  let cappedFeeds = 0;
  let errors = 0;
  const feedErrors: string[] = [];

  // 1. 各 feed を fetch + iterate + upsert。
  //    cap (maxItemsPerFeed) は「新規 insert 数」に効かせる — feed 先頭位置に
  //    効かせると、backfill が cap を超えた回で窓からこぼれた item が
  //    以後の run でも先頭に戻れず永久欠落する (2026-08-11 監査で確定)。
  //    走査は「cutoff より古い item に達したら打ち切り」(feed は新しい順) +
  //    FEED_SCAN_CAP の絶対上限で有界。
  for (const feed of feeds) {
    try {
      const xml = await fetchFeed(feed.url, fetchImpl);
      feedsProcessed += 1;
      let scanned = 0;
      let newInFeed = 0;
      for (const item of iterateRssItems(xml)) {
        scanned += 1;
        if (scanned > FEED_SCAN_CAP) {
          cappedFeeds += 1;
          break;
        }
        // 新しい順の feed で cutoff より古い item に達した = 以降も古い
        // (pubDate 欠落は「新しい」扱いなので打ち切らない)
        if (isOlderThan(item.pubDate, ingestCutoffMs)) break;
        try {
          const r = await upsertChangelogEntry(env.DB, {
            entryUrl: item.link,
            title: item.title,
            category: feed.category,
            publishedAt: item.pubDate ?? null,
            description: item.description ?? null,
          });
          if (r.isNew) {
            newEntries += 1;
            newInFeed += 1;
            if (newInFeed >= maxItemsPerFeed) {
              // 未消化の新着が残っている可能性 → metric で可視化し、
              // 残りは翌日以降の run が isNew 判定で拾う
              cappedFeeds += 1;
              break;
            }
          }
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
      const msg = err instanceof Error ? err.message : 'unknown';
      feedErrors.push(`${feed.category}: ${msg}`);
      console.error('[cloudflare-changelog-sync] feed fetch failed', feed.url, msg);
    }
  }

  // 2. 未通知 entry を取得して Discord 通知。
  //    発行が古すぎる entry (= webhook 未設定期間や旧 URL 期間の滞留分) は
  //    通知せず notified mark のみ = 連日ドリップ通知の防止。
  let notified = 0;
  let suppressedStale = 0;
  const notifyCutoffMs = now.getTime() - NOTIFY_MAX_AGE_DAYS * 86_400_000;
  try {
    const unnotified = await listUnnotifiedChangelogEntries(env.DB, maxNotify);
    const stale = unnotified.filter((e) => isOlderThan(e.publishedAt, notifyCutoffMs));
    const fresh = unnotified.filter((e) => !isOlderThan(e.publishedAt, notifyCutoffMs));
    if (stale.length > 0) {
      try {
        await markChangelogEntriesNotified(
          env.DB,
          stale.map((e) => e.id),
        );
        suppressedStale = stale.length;
      } catch (err) {
        errors += 1;
        console.error(
          '[cloudflare-changelog-sync] stale mark failed',
          err instanceof Error ? err.message : 'unknown',
        );
      }
    }
    if (fresh.length > 0 && env.DISCORD_WEBHOOK_URL) {
      try {
        await sendDiscordNotification(
          env.DISCORD_WEBHOOK_URL,
          env.ACCOUNT_NAME ?? 'naturism',
          fresh,
          fetchImpl,
        );
        await markChangelogEntriesNotified(
          env.DB,
          fresh.map((e) => e.id),
        );
        notified = fresh.length;
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

  // 3. cron_run_logs に記録 (= feed 失敗理由は errorSummary に残す。
  //    console.error だけだと本番で失敗原因が追えない — 2026-08 の
  //    「feedsFailed:1 が続くが原因未調査」の再発防止)
  const status =
    feedsFailed === feeds.length && feeds.length > 0
      ? 'error'
      : errors > 0 || feedsFailed > 0
      ? 'partial'
      : 'success';
  await recordCronRun(
    env.DB,
    status,
    {
      feedsProcessed,
      feedsFailed,
      newEntries,
      notified,
      suppressedStale,
      cappedFeeds,
      errors,
    },
    feedErrors.length > 0 ? feedErrors.join('; ').slice(0, 500) : undefined,
  );

  return {
    triggered: true,
    feedsProcessed,
    feedsFailed,
    newEntries,
    notified,
    suppressedStale,
    cappedFeeds,
    errors,
  };
}

// ============================================================
// helpers
// ============================================================

/**
 * 日付が cutoff より古いか。
 * 欠落 / 解析不能は false (= 安全側で「新しい」扱い。取込側は件数 cap が
 * 上限を保証し、通知側は maxNotify cap が上限を保証する)。
 */
export function isOlderThan(iso: string | null | undefined, cutoffMs: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t < cutoffMs;
}

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
  iterateRssItems,
  isOlderThan,
  TRIGGER_HOUR,
  TRIGGER_MINUTE_FROM,
  DEFAULT_MAX_ITEMS_PER_FEED,
  DEFAULT_MAX_ENTRY_AGE_DAYS,
  NOTIFY_MAX_AGE_DAYS,
  FEED_SCAN_CAP,
  RAW_DESCRIPTION_MAX,
};
