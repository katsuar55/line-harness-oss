/**
 * In-memory sliding window rate limiter for Cloudflare Workers.
 *
 * Cloudflare Workers have per-isolate memory that persists across
 * requests to the same instance. Counters are lost on cold start,
 * which is acceptable — this guards against burst abuse, not
 * long-term quota enforcement.
 */

import type { Context, Next } from 'hono';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Core rate-limit logic
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

const PRUNE_INTERVAL = 60_000;
let lastPrune = Date.now();

/**
 * store の上限。 prune は 60 秒に 1 回しか走らないため、 キー基数が攻撃者に握られると
 * その 1 分間ぶんのエントリが isolate に滞留する。 上限に達したら即時 prune し、
 * それでも減らなければ最古のキーから捨てる (= 有限メモリを保証する)。
 * store は webhook/api 等 全 rate-limit 対象パスと共有なので、 ここが溢れると
 * 無関係な本番機能まで巻き込む。
 */
const MAX_STORE_KEYS = 10_000;

function prune(windowMs: number): void {
  const now = Date.now();
  if (now - lastPrune < PRUNE_INTERVAL && store.size < MAX_STORE_KEYS) return;
  lastPrune = now;
  const cutoff = now - windowMs;
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) store.delete(key);
  }
  // window 内の生存エントリだけで上限を超えている = 意図的なキー回転。
  // Map は挿入順を保つので、先頭 (= 最も古く作られたキー) から捨てる。
  if (store.size > MAX_STORE_KEYS) {
    const excess = store.size - MAX_STORE_KEYS;
    let i = 0;
    for (const key of store.keys()) {
      if (i++ >= excess) break;
      store.delete(key);
    }
  }
}

export function check(key: string, max: number, windowMs: number): { ok: boolean; remaining: number; retryAfter: number } {
  const now = Date.now();
  const cutoff = now - windowMs;

  prune(windowMs);

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

  if (entry.timestamps.length >= max) {
    const oldest = entry.timestamps[0];
    const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
    return { ok: false, remaining: 0, retryAfter: Math.max(retryAfter, 1) };
  }

  entry.timestamps.push(now);
  return { ok: true, remaining: max - entry.timestamps.length, retryAfter: 0 };
}

// ---------------------------------------------------------------------------
// Paths that are unauthenticated (lower limit, keyed by IP)
// ---------------------------------------------------------------------------

const UNAUTHENTICATED_PATTERNS: Array<string | RegExp> = [
  '/webhook',
  /^\/api\/forms\/[^/]+\/submit$/,
  /^\/api\/integrations\/shopify\/webhook/,
  // Phase 5β-1: opt-in 確認ページは公開 + HMAC 認証なので IP keyed limit を強制
  '/email/opt-in',
];

function isUnauthenticatedPath(path: string): boolean {
  return UNAUTHENTICATED_PATTERNS.some((p) =>
    typeof p === 'string' ? path === p : p.test(path),
  );
}

function getClientIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    '0.0.0.0'
  );
}

/**
 * SHA-256 hex digest of an API token, used as the rate-limit bucket key.
 *
 * Hashing the *full* token (instead of storing a raw `token.slice(0, 16)`
 * prefix) closes two problems with the previous approach:
 *  - entropy leak: a 16-char slice of the secret bearer token was stored in
 *    the in-memory Map key and forwarded verbatim to Cloudflare's rate-limit
 *    binding (and thus its telemetry). 16 chars is a meaningful partial
 *    disclosure of a secret; a one-way hash discloses nothing.
 *  - collision: two distinct tokens sharing the same 16-char prefix shared a
 *    single bucket, so one could exhaust the other's limit. Hashing the whole
 *    token makes a shared bucket require a full SHA-256 collision (infeasible).
 *
 * crypto.subtle.digest is called directly on the object (never destructured)
 * per the Workers `this`-binding rules in CLAUDE.md.
 */
export async function hashRateLimitToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Hono middleware
// ---------------------------------------------------------------------------

const AUTHENTICATED_MAX = 1000;
const AUTHENTICATED_WINDOW = 60_000; // 1 min

const UNAUTHENTICATED_MAX = 100;
const UNAUTHENTICATED_WINDOW = 60_000; // 1 min

/**
 * App Proxy 入口 (= 顧客 1 人あたり)。 正常系は「ログイン → 1 回叩いて LINE へ戻る」なので
 * 分間 20 は十分に緩い。 D1 write を伴うため上限そのものは必ず設ける。
 */
const PROXY_MAX = 20;
const PROXY_WINDOW = 60_000;

export async function rateLimitMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  const path = new URL(c.req.url).pathname;

  // Skip rate limiting for docs / static assets / LIFF HTML page shells.
  //
  // LIFF page routes (`/liff/...`) are cheap, public HTML shells. The real work
  // (and the only sensitive data) lives behind `/api/liff/*` data calls, which
  // carry the LIFF idToken as a Bearer header and are therefore rate-limited
  // PER USER below (= CGNAT-safe). The HTML shells carry no Authorization
  // header, so WITHOUT this skip they fall into a shared per-IP bucket — and
  // because mobile carriers place many customers behind a single CGNAT IP, and
  // every rich-menu tap reloads `/liff/portal`, that shared bucket is exhausted
  // by legitimate traffic and returns spurious 429s to real users (observed in
  // the 2026-06-29 cutover: マイランク returned "Too many requests"). Exempt the
  // shells; keep `/api/liff/*` (which starts with `/api/`, not `/liff/`) limited.
  if (
    path === '/docs' ||
    path === '/openapi.json' ||
    path.startsWith('/r/') ||
    path.startsWith('/liff/') ||
    // メール起動ブリッジ (contact card 経由の公開静的ページ、 CGNAT-safe に exempt)
    path === '/contact/email'
  ) {
    return next();
  }

  // Shopify App Proxy 入口 (2026-07-29)。 2 段バケットの AND で評価する。
  //
  //  ① IP バケット (通常の未認証上限と同じ): キー空間を IP 集合に閉じ込めるための土台。
  //     これが無いと、 **署名検証前の生 query** をキーにしてしまうため、
  //     logged_in_customer_id を毎回変えるだけで上限が無効化され、 さらに store が
  //     無限に膨らんで isolate ごと落とせる (= webhook/cron まで巻き添え)。
  //     middleware は route より前に走るので、 ここで見える query は**まだ未検証**である点が要。
  //  ② 顧客バケット: 転送元 IP は Shopify の egress で全顧客が共有するため、 IP だけだと
  //     1 人の連打で店舗全体が 429 になる。 個人の連打はこちらで細かく止める。
  //     キーに使うのは形式検査を通った値のみ (= 長さ・文字種を有限に固定する)。
  if (path === '/proxy/line-link' || path.startsWith('/proxy/line-link/')) {
    const ipResult = check(`ip:${getClientIp(c)}`, UNAUTHENTICATED_MAX, UNAUTHENTICATED_WINDOW);
    if (!ipResult.ok) {
      return c.text('Too Many Requests', 429, { 'Retry-After': String(ipResult.retryAfter) });
    }
    const cid = (new URL(c.req.url).searchParams.get('logged_in_customer_id') ?? '').trim();
    if (/^\d{1,32}$/.test(cid)) {
      const cidResult = check(`proxy:${cid}`, PROXY_MAX, PROXY_WINDOW);
      if (!cidResult.ok) {
        return c.text('Too Many Requests', 429, { 'Retry-After': String(cidResult.retryAfter) });
      }
    }
    return next();
  }

  const unauthenticated = isUnauthenticatedPath(path);

  // Resolve the bucket key + limits ONCE, shared by both the Cloudflare
  // distributed limiter and the in-memory fallback. A single request therefore
  // always lands in one logical bucket, and the secret token is hashed before
  // it is ever used as (or forwarded as) a key.
  let key: string;
  let max: number;
  let windowMs: number;

  if (unauthenticated) {
    // Key by IP for unauthenticated endpoints (IPs are not secrets).
    key = `ip:${getClientIp(c)}`;
    max = UNAUTHENTICATED_MAX;
    windowMs = UNAUTHENTICATED_WINDOW;
  } else {
    // Key by a SHA-256 hash of the full API token for authenticated endpoints.
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
      key = `key:${await hashRateLimitToken(token)}`;
      max = AUTHENTICATED_MAX;
      windowMs = AUTHENTICATED_WINDOW;
    } else {
      // No auth header — key by IP with the lower limit.
      key = `ip:${getClientIp(c)}`;
      max = UNAUTHENTICATED_MAX;
      windowMs = UNAUTHENTICATED_WINDOW;
    }
  }

  // Cloudflare分散レート制限（全エッジロケーション共有）— in-memoryより先に評価。
  // 上で算出した hash/IP key を共有 (token prefix を CF binding/telemetry に渡さない)。
  const env = c.env;
  if (unauthenticated && env.WEBHOOK_RATE_LIMITER) {
    const { success } = await env.WEBHOOK_RATE_LIMITER.limit({ key });
    if (!success) {
      return c.json(
        { success: false, error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': '10' } },
      );
    }
  } else if (!unauthenticated && env.API_RATE_LIMITER) {
    const { success } = await env.API_RATE_LIMITER.limit({ key });
    if (!success) {
      return c.json(
        { success: false, error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': '10' } },
      );
    }
  }

  // フォールバック: in-memory sliding window（コールドスタート後の瞬間バーストを防ぐ）
  const result = check(key, max, windowMs);

  if (!result.ok) {
    return c.json(
      { success: false, error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(result.retryAfter) } },
    );
  }

  // Proceed and attach rate-limit headers to the response
  await next();

  c.header('X-RateLimit-Remaining', String(result.remaining));
}
