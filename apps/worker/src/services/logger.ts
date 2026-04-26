/**
 * 軽量エラー監視 Logger
 *
 * 目的:
 * - Cloudflare Workers Logs は 24h で消える → 重大エラーを長期保存 + 通知
 * - 月額無料枠で運用 (Axiom Free 500MB/月 + Discord webhook 無料)
 * - **secret 未登録時は no-op** (fail-safe: 観測機能不在でアプリは止まらない)
 *
 * 配信先:
 * - Axiom Datasets API (構造化ログ長期保存・検索UI)
 * - Discord webhook (重大エラーを即時通知)
 *
 * 必要な wrangler secret (オプショナル, 未設定なら該当先のみスキップ):
 * - AXIOM_TOKEN              : Axiom API トークン
 * - AXIOM_DATASET            : 投入先 dataset 名 (default: "naturism-worker")
 * - DISCORD_WEBHOOK_URL      : Discord 通知用 webhook URL
 *
 * 使い方:
 *   const log = createLogger(env, ctx);
 *   log.error('payment failed', { friendId, orderId, err });
 *
 * `ctx.waitUntil()` で fire-and-forget 送信するため request latency に影響しない。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerEnv {
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  DISCORD_WEBHOOK_URL?: string;
  ACCOUNT_NAME?: string;
}

export interface LoggerContext {
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface Logger {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  fatal: (message: string, fields?: Record<string, unknown>) => void;
}

const DISCORD_NOTIFY_LEVELS: ReadonlySet<LogLevel> = new Set(['error', 'fatal']);

export function createLogger(env: LoggerEnv, ctx: LoggerContext | null): Logger {
  const send = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    const ts = new Date().toISOString();
    const payload = {
      _time: ts,
      level,
      message,
      account: env.ACCOUNT_NAME ?? 'naturism',
      ...(fields ? sanitizeFields(fields) : {}),
    };

    // Cloudflare Workers Logs (24h, debug 用)
    const consoleFn = level === 'error' || level === 'fatal'
      ? console.error
      : level === 'warn'
      ? console.warn
      : console.info;
    consoleFn(JSON.stringify(payload));

    // Axiom (長期保存)
    if (env.AXIOM_TOKEN) {
      const dataset = env.AXIOM_DATASET ?? 'naturism-worker';
      const promise = sendToAxiom(env.AXIOM_TOKEN, dataset, payload);
      if (ctx) ctx.waitUntil(promise);
    }

    // Discord (即時通知, error/fatal のみ)
    if (env.DISCORD_WEBHOOK_URL && DISCORD_NOTIFY_LEVELS.has(level)) {
      const promise = sendToDiscord(env.DISCORD_WEBHOOK_URL, payload);
      if (ctx) ctx.waitUntil(promise);
    }
  };

  return {
    debug: (m, f) => send('debug', m, f),
    info: (m, f) => send('info', m, f),
    warn: (m, f) => send('warn', m, f),
    error: (m, f) => send('error', m, f),
    fatal: (m, f) => send('fatal', m, f),
  };
}

async function sendToAxiom(
  token: string,
  dataset: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(`https://api.axiom.co/v1/datasets/${encodeURIComponent(dataset)}/ingest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([payload]),
    });
  } catch {
    // 監視先障害でアプリは止めない
  }
}

async function sendToDiscord(
  webhookUrl: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const level = String(payload.level ?? '').toUpperCase();
    const account = payload.account ?? 'naturism';
    const message = String(payload.message ?? '');
    const extras = Object.entries(payload)
      .filter(([k]) => !['_time', 'level', 'message', 'account'].includes(k))
      .map(([k, v]) => `\`${k}\`: ${truncate(stringify(v), 300)}`)
      .join('\n');

    const content = [
      `**[${level}]** \`${account}\` — ${truncate(message, 1500)}`,
      extras ? `\`\`\`\n${truncate(extras, 1500)}\n\`\`\`` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: truncate(content, 1900) }),
    });
  } catch {
    // 監視先障害でアプリは止めない
  }
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message, stack: v.stack };
    } else if (v === undefined) {
      // skip
    } else if (typeof v === 'function') {
      // skip
    } else {
      out[k] = v;
    }
  }
  return out;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
