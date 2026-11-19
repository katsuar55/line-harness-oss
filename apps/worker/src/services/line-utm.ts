/**
 * LINE から公式ストアへ出るリンクに計測の印を付ける (サーバー側・2026-11-19・L-1)。
 * client 側 (ミニアプリ) は routes/liff-portal-fragments/line-utm.ts。規則は同じ:
 * - 公式ストアのホストだけ / 既に utm_source があれば触らない / `/apps/` は触らない
 * - `/cart/` 直行リンクには ref=line-<medium>-<campaign> も付ける
 */

import { LINE_UTM_STORE_HOSTS } from '../routes/liff-portal-fragments/line-utm.js';

export interface LineUtmOptions {
  readonly medium: 'miniapp' | 'message';
  readonly campaign: string;
  readonly content?: string;
}

const STORE_HOSTS: ReadonlySet<string> = new Set(LINE_UTM_STORE_HOSTS);

/** 1つの URL に印を付けた新しい文字列を返す (対象外ならそのまま)。 */
export function tagLineUtm(url: string, opts: LineUtmOptions): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!STORE_HOSTS.has(u.hostname)) return url;
  if (u.pathname.startsWith('/apps/')) return url;
  if (u.searchParams.get('utm_source')) return url;
  u.searchParams.set('utm_source', 'line');
  u.searchParams.set('utm_medium', opts.medium);
  u.searchParams.set('utm_campaign', opts.campaign);
  if (opts.content) u.searchParams.set('utm_content', opts.content);
  if (u.pathname.startsWith('/cart/') && !u.searchParams.get('ref')) {
    u.searchParams.set('ref', `line-${opts.medium}-${opts.campaign}`);
  }
  return u.toString();
}

const URL_KEYS: ReadonlySet<string> = new Set(['uri', 'url', 'linkUri']);

/**
 * LINE のメッセージ (flex を含む) の中の `uri` / `url` / `linkUri` を走査して印を付けた
 * **新しい** 値を返す。元の値は変更しない。flex を JSON 文字列で持つ `contents` (buildMessage の
 * 出力) も読み解いて付け直す。
 */
export function tagLineUtmDeep<T>(value: T, opts: LineUtmOptions): T {
  return walk(value, opts) as T;
}

function walk(value: unknown, opts: LineUtmOptions): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, opts));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && URL_KEYS.has(k)) {
      out[k] = tagLineUtm(v, opts);
    } else {
      out[k] = walk(v, opts);
    }
  }
  return out;
}
