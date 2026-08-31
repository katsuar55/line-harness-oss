/**
 * LIFF の inline JS で「正規表現のバックスラッシュが TS の template literal に飲まれる」
 * 事故の恒久ガード (2026-09-01 本番障害)。
 *
 * ## 何が起きたか
 * `liff-my-rank.ts` に `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` と書いていたが、この inline JS は
 * TS の template literal から emit されるため `\s` が潰れて **`s`** が出ていた:
 *
 *   書いた   /^[^@\s]+@[^@\s]+\.[^@\s]+$/     空白以外
 *   emit された /^[^@s]+@[^@s]+.[^@s]+$/       @ と **英字の s** 以外
 *
 * 結果、**`s` を含むメールアドレスが全員拒否**されていた
 * (`katsu@kenkoex.com` / `info@shop.jp` …)。メール OTP 連携は誰も通れない状態だった。
 *
 * ## なぜ既存のガードで捕まらないか
 * 🚨 潰れた正規表現は**構文的に妥当なまま**なので、`liff-script-syntax.test.ts` の
 * parse 検証も typecheck も素通りする。壊れているのは**意味**だけ。
 * 文字列リテラルの場合は改行が入って SyntaxError になるので parse 検証で拾えるが、
 * 正規表現は拾えない — ここが構造的な穴だった。
 *
 * ## このテストの観測点
 * ソースに書いた正規表現リテラルが、**emit 後の HTML にそのままの形で在るか**。
 * 「潰れた版が在る」= 事故。ソースを読むだけでは絶対に分からないので、実際に emit させる。
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Env } from '../index.js';
import { liffMyRank } from '../routes/liff-my-rank.js';
import { liffPages } from '../routes/liff-pages.js';

const here = dirname(fileURLToPath(import.meta.url));
const routes = join(here, '..', 'routes');

/** 正規表現リテラルらしきものを拾う (候補を広く取り、照合で絞る) */
const RE_LITERAL = /\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+\/[gimsuy]*/g;
/** 潰れると意味が変わるエスケープ */
const HAS_ESCAPE = /\\[sdwbSDWB.+*?^$()[\]{}|/-]/;

/**
 * TS の template literal が実際に行う unescape を模す。
 * 認識するのは `\\` `` \` `` `\$` `\n` `\t` `\r` だけで、`\s` `\.` 等は**文字だけが残る**。
 *   source `\\s` → emit `\s`  (正しい書き方)
 *   source `\s`  → emit `s`   (潰れる = 事故)
 */
function asEmitted(literal: string): string {
  const known: Record<string, string> = { '\\': '\\', '`': '`', $: '$', n: '\n', t: '\t', r: '\r' };
  return literal.replace(/\\(.)/g, (_m, c: string) => known[c] ?? c);
}

/** ソース側に「1 本だけのバックスラッシュ」エスケープが残っているか (= 潰れる書き方) */
const SINGLE_BACKSLASH_ESCAPE = /(^|[^\\])\\[sdwbSDWB.]/;

function scriptsOf(html: string): string {
  return (html.match(/<script[^>]*>[\s\S]*?<\/script>/g) ?? []).join('\n');
}

async function render(path: string, route: Hono<Env>): Promise<string> {
  const app = new Hono<Env>();
  app.use('/api/liff/*', async (c, next) => {
    (c as { set: (k: string, v: unknown) => void }).set('liffUser', { lineUserId: 'U1', friendId: 'f1' });
    await next();
  });
  app.route('/', route);
  const res = await app.request(path, undefined, {
    LIFF_ID: '1234567890-abcdefgh',
    ACCOUNT_LINK_ENABLED: 'true',
    MEMBER_BACKFILL_ENABLED: 'true',
  } as unknown as Env['Bindings']);
  expect(res.status, path).toBe(200);
  return res.text();
}

const TARGETS: ReadonlyArray<{ file: string; path: string; route: Hono<Env> }> = [
  { file: 'liff-my-rank.ts', path: '/liff/my-rank', route: liffMyRank as unknown as Hono<Env> },
  { file: 'liff-pages.ts', path: '/liff/portal', route: liffPages as unknown as Hono<Env> },
];

describe('LIFF inline JS: 正規表現のエスケープが emit で潰れていない', () => {
  for (const t of TARGETS) {
    it(`${t.file} — 書いた正規表現がそのまま出ている`, async () => {
      const src = readFileSync(join(routes, t.file), 'utf8');
      const html = await render(t.path, t.route);
      const scripts = scriptsOf(html);

      const broken: string[] = [];
      for (const lit of src.match(RE_LITERAL) ?? []) {
        if (!HAS_ESCAPE.test(lit) || lit.length > 200) continue;
        const emitted = asEmitted(lit);
        // emit された形が script に在る = この正規表現は inline JS 側 (サーバ側なら在らない)
        if (!scripts.includes(emitted)) continue;
        // inline JS なら、ソースは **必ず 2 本のバックスラッシュ**で書かれていなければならない。
        // 1 本だと template literal に飲まれ、意味が変わったまま構文的に妥当な正規表現になる。
        if (SINGLE_BACKSLASH_ESCAPE.test(lit)) {
          broken.push(`書いた ${lit} → 出ている ${emitted}`);
        }
      }
      expect(broken, broken.join(' / ')).toEqual([]);
    });
  }

  // 🚨 実害そのものを固定する。上の汎用ガードが壊れても、この 1 件は必ず落ちる。
  it('🚨 メール検証が「s を含むアドレス」を拒否しない (本番障害の再発防止)', async () => {
    const html = await render('/liff/my-rank', liffMyRank as unknown as Hono<Env>);
    const m = /if\(!(\/[^/]+\/)\.test\(email\)\)/.exec(html);
    expect(m, 'メール検証の正規表現が見つからない').not.toBeNull();

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const emailRe = new Function(`return ${m![1]};`)() as RegExp;
    for (const ok of ['katsu@kenkoex.com', 'info@shop.jp', 'taro@example.com', 'a@b.co']) {
      expect(emailRe.test(ok), `${ok} が拒否された`).toBe(true);
    }
    for (const ng of ['katsu', 'katsu@', '@b.com', 'a b@c.com', 'a@bcom']) {
      expect(emailRe.test(ng), `${ng} が通ってしまった`).toBe(false);
    }
  });

  it('🚨 サーバ側の検証も同じアドレスを受ける (クライアントだけ直しても意味がない)', async () => {
    const { z } = await import('zod');
    const schema = z.string().email().max(254);
    for (const ok of ['katsu@kenkoex.com', 'info@shop.jp']) {
      expect(schema.safeParse(ok).success, ok).toBe(true);
    }
  });
});
