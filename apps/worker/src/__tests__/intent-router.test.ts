/**
 * Tests for intent-router.ts (ULTRATHINK fix、 2026-05-26)
 *
 * 範囲:
 *   - detectIntent: 各 keyword pattern → 正しい intent
 *   - 未 match → null
 *   - quiz_invite / price_table / feature_unavailable の出力 Message structure
 *   - 部分一致が広すぎないか (= 「価格」 単独 等は AI 任せに、 「価格教えて」 は intent matched)
 */

import { describe, it, expect } from 'vitest';
import { detectIntent, buildMessagesForIntentAsync, __test__ } from '../services/intent-router.js';

describe('intent-router — quiz_invite', () => {
  it.each([
    '私におすすめは？',
    '私に合うのはどれ？',
    '私はどれを買えばいい？',
    '初めてでどれを選べばいい?',
    'おすすめ教えて',
    'どれがおすすめ?',
    'どれを選べばいい?',
  ])('matches "%s" → quiz_invite', (text) => {
    const r = detectIntent(text);
    expect(r).not.toBeNull();
    expect(r?.intent.type).toBe('quiz_invite');
    expect(r?.messages).toHaveLength(1);
    expect(r?.messages[0]?.type).toBe('flex');
    if (r?.messages[0]?.type === 'flex') {
      expect(String(r.messages[0].altText)).toContain('診断');
    }
  });
});

describe('intent-router — price_table', () => {
  it.each([
    '価格教えて',
    '価格一覧',
    '価格比較',
    '料金教えて',
    '値段教えて',
    'いくらする',
    '3 種類の価格教えて',
    '3つの価格を教えて',
    'どれが一番安い',
  ])('matches "%s" → price_table', (text) => {
    const r = detectIntent(text);
    expect(r).not.toBeNull();
    expect(r?.intent.type).toBe('price_table');
    expect(r?.messages[0]?.type).toBe('flex');
    if (r?.messages[0]?.type === 'flex') {
      expect(String(r.messages[0].altText)).toContain('価格');
    }
  });

  it('matches short "価格" alone (= 5/26 user feedback、 auto_replies deactivated)', () => {
    // 「価格」 単独でも grid flex で返す = user が「価格」 とだけ送っても見やすい
    const r = detectIntent('価格');
    expect(r?.intent.type).toBe('price_table');
  });

  it('matches "値段" and "料金" short forms', () => {
    expect(detectIntent('値段')?.intent.type).toBe('price_table');
    expect(detectIntent('料金')?.intent.type).toBe('price_table');
  });
});

// #10-1 (2026-06-12): 会員ランクは feature_unavailable でなく my_rank (= マイランク LIFF 稼働中)
describe('intent-router — my_rank (= マイランク LIFF 誘導)', () => {
  it.each([
    '私の会員ランクは？',
    'マイランク教えて',
    '私のステータスは？',
    '私のランクを確認したい',
    '会員ランク',
    'ランクは何',
  ])('matches "%s" → my_rank', (text) => {
    const r = detectIntent(text);
    expect(r).not.toBeNull();
    expect(r?.intent.type).toBe('my_rank');
  });

  it('sync build returns rich-menu guidance text (= liffUrl 不明の fallback、 URL を含まない)', () => {
    const r = detectIntent('マイランク');
    expect(r?.messages).toHaveLength(1);
    expect(r?.messages[0]?.type).toBe('text');
    if (r?.messages[0]?.type === 'text') {
      expect(r.messages[0].text).toContain('マイランク');
      expect(r.messages[0].text).not.toContain('undefined');
      expect(r.messages[0].text).not.toMatch(/近日リリース/);
    }
  });

  it('does NOT say 近日リリース (= 旧 feature_unavailable 誤回答の regression)', () => {
    for (const text of ['会員ランク', 'マイランク', '私のランク', '私のステータス']) {
      const r = detectIntent(text);
      expect(r?.intent.type).toBe('my_rank');
      if (r?.messages[0]?.type === 'text') {
        expect(r.messages[0].text).not.toMatch(/近日リリース/);
      }
    }
  });
});

// 2026-06-29 監査 rank 8: 友だち紹介は feature_unavailable でなく referral (= リッチメニュー+LIFF 稼働中)
describe('intent-router — referral (= 友だち紹介 LIFF 誘導)', () => {
  it.each([
    '友だち紹介',
    '友達紹介',
    '紹介コード',
    'リファラル',
    '紹介プログラム教えて',
    '友だち紹介で割引ある？',
  ])('matches "%s" → referral (近日リリースと言わない)', (text) => {
    const r = detectIntent(text);
    expect(r).not.toBeNull();
    expect(r?.intent.type).toBe('referral');
    if (r?.messages[0]?.type === 'text') {
      expect(r.messages[0].text).not.toMatch(/近日リリース/);
    }
  });

  it('async build with liffUrl returns #referral tap link', async () => {
    const r = detectIntent('友だち紹介');
    expect(r?.intent.type).toBe('referral');
    const msgs = await buildMessagesForIntentAsync(r!.intent, {
      db: {} as unknown as D1Database,
      friendId: 'f1',
      liffUrl: 'https://liff.line.me/2009713578-NbdHyFZf',
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.type).toBe('text');
    if (msgs[0]?.type === 'text') {
      expect(msgs[0].text).toContain('#referral');
      expect(msgs[0].text).not.toMatch(/近日リリース/);
    }
  });
});

describe('intent-router — feature_unavailable', () => {
  it.each<[string, string]>([
    ['ポイント残高は？', 'ポイント / マイル'],
    ['マイル何個持ってる？', 'ポイント / マイル'],
    ['アンバサダー制度は？', 'アンバサダープログラム'],
    ['専用バッジある？', '専用バッジ / 称号'],
  ])('matches "%s" → feature_unavailable (%s)', (text, expectedFeature) => {
    const r = detectIntent(text);
    expect(r).not.toBeNull();
    expect(r?.intent.type).toBe('feature_unavailable');
    if (r?.intent.type === 'feature_unavailable') {
      expect(r.intent.feature).toBe(expectedFeature);
    }
    expect(r?.messages[0]?.type).toBe('text');
    if (r?.messages[0]?.type === 'text') {
      expect(r.messages[0].text).toMatch(/近日リリース/);
      expect(r.messages[0].text).toContain(expectedFeature);
    }
  });
});

describe('intent-router — fallthrough (= null for unrelated)', () => {
  it.each([
    'こんにちは',
    'ありがとう',
    'naturism の歴史は?',
    'Blue の成分教えて',
    '飲み方',
    '送料はいくら?',
    '',
    '   ',
  ])('returns null for "%s"', (text) => {
    expect(detectIntent(text)).toBeNull();
  });

  it('returns null for empty/whitespace', () => {
    expect(detectIntent('')).toBeNull();
    expect(detectIntent('   \n  ')).toBeNull();
  });
});

describe('intent-router — priority', () => {
  it('quiz_invite checked before price_table when keywords overlap', () => {
    // 「価格教えて」 vs 「私におすすめ」 が両方含まれる → 上から順なので quiz_invite (= 上位定義) が勝つ
    const r = detectIntent('私におすすめの価格教えて');
    expect(r?.intent.type).toBe('quiz_invite');
  });

  it('returns first matched keyword string for debugging', () => {
    const r = detectIntent('価格教えて、 3 商品の');
    expect(r?.matchedKeyword).toBe('価格教えて');
  });
});

// PR 2 (2026-05-26): product_compare + my_coupon intent
describe('intent-router — product_compare (= 「違い」 Step 7 fix)', () => {
  it.each([
    '3 種類の違いは？',
    '3種類の違いを教えて',
    'Blue Pink Premium の比較',
    '商品比較教えて',
    '違い教えて',
    '違い',
    '比較',
  ])('matches "%s" → product_compare', (text) => {
    const r = detectIntent(text);
    expect(r?.intent.type).toBe('product_compare');
    expect(r?.messages[0]?.type).toBe('flex');
    if (r?.messages[0]?.type === 'flex') {
      expect(String(r.messages[0].altText)).toMatch(/3 ?種類|違い|比較/);
    }
  });
});

describe('intent-router — my_coupon (= Step 3 UX、 sync sentinel)', () => {
  it.each(['私のクーポン', 'マイクーポン', 'クーポンコード教えて', '使えるクーポンある'])(
    'matches "%s" → my_coupon',
    (text) => {
      const r = detectIntent(text);
      expect(r?.intent.type).toBe('my_coupon');
    },
  );

  it('sync buildMessagesForIntent returns sentinel text (= async 経由を期待)', () => {
    const r = detectIntent('私のクーポン');
    expect(r?.messages[0]?.type).toBe('text');
    if (r?.messages[0]?.type === 'text') {
      expect(r.messages[0].text).toMatch(/確認中/);
    }
  });
});

// async build の挙動 (= D1 mock + getFriendActiveCoupon)
describe('intent-router — buildMessagesForIntentAsync (my_coupon)', () => {
  interface Row { coupon_code: string; discount_value: number; discount_currency: string; expires_at: string | null }

  /**
   * 🚨 台帳ごとに別の行を返す (2026-08-28)。全 prepare が同じ行を返す mock だと
   *    3 台帳が同じ 1 枚を 3 回返し、「何枚持っているか」の分岐を検証できない。
   */
  // 🚨 紹介台帳は 1 friend が複数枚持てるので配列も渡せる形にする (Codex P1 2026-08-28)
  function ledgerDb(rows: Partial<Record<'friend' | 'link' | 'referral', Row | Row[] | null>>): D1Database {
    const pick = (sql: string): Row | Row[] | null => {
      if (sql.includes('line_friend_coupons')) return rows.friend ?? null;
      if (sql.includes('line_link_coupons')) return rows.link ?? null;
      if (sql.includes('line_referral_coupons')) return rows.referral ?? null;
      return null;
    };
    return {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async <T,>(): Promise<{ results: T[] }> => {
            const r = pick(sql);
            if (r === null) return { results: [] as T[] };
            const rows = Array.isArray(r) ? r : [r];
            // 🚨 `COUNT(*) OVER ()` は LIMIT の**前**の全該当行を数える。偽 DB もそう振る舞う。
            const withCount = sql.includes('COUNT(*) OVER ()')
              ? rows.map((x) => ({ ...x, total_count: rows.length }))
              : rows;
            // 🚨 SQL の LIMIT を実際に効かせる (無視すると「LIMIT 1 に戻す」変異を検出できない)
            const m = sql.match(/LIMIT\s+(\d+)/i);
            return { results: (m ? withCount.slice(0, Number(m[1])) : withCount) as T[] };
          },
          first: async <T,>(): Promise<T | null> => {
            const r = pick(sql);
            return (Array.isArray(r) ? (r[0] ?? null) : r) as T | null;
          },
        }),
      }),
    } as unknown as D1Database;
  }

  const mockDb = (coupon: Row | null): D1Database => ledgerDb(coupon ? { friend: coupon } : {});

  it('returns 2 messages (= flex + text code) when coupon exists', async () => {
    const db = mockDb({
      coupon_code: 'LINE-TEST-001',
      discount_value: 500,
      discount_currency: 'JPY',
      expires_at: '2026-12-31T23:59:00+09:00',
    });
    const r = await buildMessagesForIntentAsync(
      { type: 'my_coupon', reason: 'test' },
      { db, friendId: 'test-friend' },
    );
    expect(r).toHaveLength(2);
    expect(r[0]?.type).toBe('flex');
    expect(r[1]?.type).toBe('text');
    if (r[1]?.type === 'text') {
      expect(r[1].text).toContain('LINE-TEST-001');
      expect(r[1].text).toMatch(/長押しでコピー/);
    }
  });

  it('returns 1 message fallback text when no coupon', async () => {
    const db = mockDb(null);
    const r = await buildMessagesForIntentAsync(
      { type: 'my_coupon', reason: 'test' },
      { db, friendId: 'test-friend' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.type).toBe('text');
    if (r[0]?.type === 'text') {
      expect(r[0].text).toMatch(/お持ちのクーポンはございません/);
    }
  });

  // 🚨 2026-08-28: 友だち追加特典だけを見ていたため、¥300 連携特典 / ¥500 紹介特典を
  //    持っている顧客に「現在お持ちのクーポンはございません」と断定していた。
  it('🚨 連携特典しか持っていなくても「ございません」にならない', async () => {
    const db = ledgerDb({
      link: { coupon_code: 'NLINK-ABCD1234', discount_value: 300, discount_currency: 'JPY', expires_at: null },
    });
    const r = await buildMessagesForIntentAsync(
      { type: 'my_coupon', reason: 'test' },
      { db, friendId: 'test-friend' },
    );
    expect(r).toHaveLength(2);
    if (r[1]?.type === 'text') expect(r[1].text).toContain('NLINK-ABCD1234');
  });

  // 🚨 2026-08-31 採点ループ P1: 1 枚のときの Flex は welcome 専用で、期限「発行から 7 日間有効」と
  //    種別「(友だち限定)」が直書きだった。3 台帳を見るようにした途端、¥300 連携特典 (30 日) を
  //    **23 日短く偽る**。既存客は友だち追加特典が期限切れで保有 1 枚 = この経路に入るため、
  //    被害が既存客に偏る。観測点は **Flex の中身 (r[0])** — 前回はコード文字列しか見ておらず素通りした。
  it('🚨 Flex が台帳の実期限と種別を出す (7 日を決め打ちしない)', async () => {
    const db = ledgerDb({
      link: {
        coupon_code: 'NLINK-ABCD1234',
        discount_value: 300,
        discount_currency: 'JPY',
        expires_at: '2026-09-27T23:59:59+09:00',
      },
    });
    const r = await buildMessagesForIntentAsync(
      { type: 'my_coupon', reason: 'test' },
      { db, friendId: 'test-friend' },
    );
    expect(r[0]?.type).toBe('flex');
    const flex = JSON.stringify((r[0] as { contents: unknown }).contents);
    expect(flex).toContain('9月27日まで有効');
    expect(flex).toContain('アカウント連携特典');
    // 嘘の 2 点が消えていること
    expect(flex).not.toContain('7 日間有効');
    expect(flex).not.toContain('友だち限定');
  });

  it('紹介特典 1 枚でも種別と期限が正しい (60 日券)', async () => {
    const db = ledgerDb({
      referral: {
        coupon_code: 'NREF-EFGH5678',
        discount_value: 500,
        discount_currency: 'JPY',
        expires_at: '2026-10-27T23:59:59+09:00',
      },
    });
    const r = await buildMessagesForIntentAsync(
      { type: 'my_coupon', reason: 'test' },
      { db, friendId: 'test-friend' },
    );
    const flex = JSON.stringify((r[0] as { contents: unknown }).contents);
    expect(flex).toContain('10月27日まで有効');
    expect(flex).toContain('ご紹介特典');
    expect(flex).not.toContain('7 日間有効');
  });

  it('期限が無い券は日数を主張しない (既定の 7 日で埋めない)', async () => {
    const db = ledgerDb({
      link: { coupon_code: 'NLINK-NOEXP', discount_value: 300, discount_currency: 'JPY', expires_at: null },
    });
    const r = await buildMessagesForIntentAsync(
      { type: 'my_coupon', reason: 'test' },
      { db, friendId: 'test-friend' },
    );
    const flex = JSON.stringify((r[0] as { contents: unknown }).contents);
    expect(flex).not.toContain('日間有効');
    expect(flex).toContain('naturism-diet.com');
  });

  it('複数枚は 1 通に全部載せる (Flex 1 枚だと「1 枚しか無い」と誤読させる)', async () => {
    const db = ledgerDb({
      friend: { coupon_code: 'LINE-W', discount_value: 500, discount_currency: 'JPY', expires_at: '2026-09-04T23:59:59+09:00' },
      link: { coupon_code: 'NLINK-L', discount_value: 300, discount_currency: 'JPY', expires_at: null },
    });
    const r = await buildMessagesForIntentAsync(
      { type: 'my_coupon', reason: 'test' },
      { db, friendId: 'test-friend' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.type).toBe('text');
    if (r[0]?.type === 'text') {
      expect(r[0].text).toContain('お持ちのクーポン 2枚');
      expect(r[0].text).toContain('▼ 友だち追加特典');
      expect(r[0].text).toContain('LINE-W');
      expect(r[0].text).toContain('▼ アカウント連携特典');
      expect(r[0].text).toContain('NLINK-L');
      expect(r[0].text).toContain('¥2,000 以上のご注文');
      // 遡及 op が済むまで「併用」は書かない
      expect(r[0].text).not.toContain('併用');
    }
  });

  // 🚨 Codex P1 (2026-08-28): 紹介特典は 1 人が複数枚持てる
  it('🚨 紹介特典を複数枚持っていたら全部出す (枚数も実数)', async () => {
    const ref = (n: number) => ({ coupon_code: `NREF-${n}`, discount_value: 500, discount_currency: 'JPY', expires_at: null });
    const db = ledgerDb({ referral: [ref(1), ref(2), ref(3)] });
    const r = await buildMessagesForIntentAsync(
      { type: 'my_coupon', reason: 'test' },
      { db, friendId: 'test-friend' },
    );
    expect(r).toHaveLength(1);
    if (r[0]?.type === 'text') {
      expect(r[0].text).toContain('お持ちのクーポン 3枚');
      expect(r[0].text).toContain('NREF-1');
      expect(r[0].text).toContain('NREF-3');
    }
  });

  it('🚨 列挙は 5 枚までだが枚数は実数を出し、省略分を明示する', async () => {
    const ref = (n: number) => ({ coupon_code: `NREF-${n}`, discount_value: 500, discount_currency: 'JPY', expires_at: null });
    const db = ledgerDb({ referral: [ref(1), ref(2), ref(3), ref(4), ref(5), ref(6)] });
    const r = await buildMessagesForIntentAsync(
      { type: 'my_coupon', reason: 'test' },
      { db, friendId: 'test-friend' },
    );
    if (r[0]?.type === 'text') {
      expect(r[0].text).toContain('お持ちのクーポン 6枚');
      expect(r[0].text).toContain('NREF-5');
      expect(r[0].text).not.toContain('NREF-6');
      expect(r[0].text).toContain('ほか 1枚');
    }
  });

  it('async build passes through for non-coupon intent (= falls back to sync)', async () => {
    const db = mockDb(null);
    const r = await buildMessagesForIntentAsync(
      { type: 'quiz_invite', reason: 'test' },
      { db, friendId: 'test-friend' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.type).toBe('flex');
  });
});

// #10-1 (2026-06-12): my_rank async build (= liffUrl 注入でマイランク LIFF へ誘導)
describe('intent-router — buildMessagesForIntentAsync (my_rank)', () => {
  const dbStub = {} as unknown as D1Database;

  it('returns LIFF link text with ${liffUrl}#rank when liffUrl provided (= rich-menus.ts と同じ規約)', async () => {
    const r = await buildMessagesForIntentAsync(
      { type: 'my_rank', reason: 'test' },
      { db: dbStub, friendId: 'test-friend', liffUrl: 'https://liff.line.me/1234-abcd' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.type).toBe('text');
    if (r[0]?.type === 'text') {
      expect(r[0].text).toContain('https://liff.line.me/1234-abcd#rank');
      expect(r[0].text).not.toMatch(/近日リリース/);
      expect(r[0].text).not.toContain('undefined');
    }
  });

  it('falls back to rich-menu guidance when liffUrl is missing/empty (= URL なし・undefined 混入なし)', async () => {
    for (const liffUrl of [undefined, '']) {
      const r = await buildMessagesForIntentAsync(
        { type: 'my_rank', reason: 'test' },
        { db: dbStub, friendId: 'test-friend', liffUrl },
      );
      expect(r).toHaveLength(1);
      expect(r[0]?.type).toBe('text');
      if (r[0]?.type === 'text') {
        expect(r[0].text).toContain('マイランク');
        expect(r[0].text).not.toContain('undefined');
        expect(r[0].text).not.toContain('#rank');
      }
    }
  });
});

describe('intent-router — constants', () => {
  it('PATTERNS has all intent types covered', () => {
    const types = new Set(__test__.PATTERNS.map((p) => p.intent.type));
    expect(types.has('quiz_invite')).toBe(true);
    expect(types.has('price_table')).toBe(true);
    expect(types.has('my_rank')).toBe(true);
    expect(types.has('feature_unavailable')).toBe(true);
  });

  it('all keywords are non-empty strings', () => {
    for (const p of __test__.PATTERNS) {
      for (const k of p.keywords) {
        expect(typeof k).toBe('string');
        expect(k.length).toBeGreaterThan(0);
      }
    }
  });
});

// WI-1 (2026-07-14): サブスク・コンシェルジュ intent (docs/SUBSCRIPTION_ULTRAPLAN_2026-07-14.md)
describe('intent-router — subscription (= サブスク・コンシェルジュ)', () => {
  it.each([
    'サブスクリプション',
    'サブスクの解約したい',
    '定期便を変更したい',
    '定期購入について',
    'スキップしたいです',
    '解約方法を教えて',
    '定期をやめたい',
  ])('detects subscription for "%s"', (text) => {
    const r = detectIntent(text);
    expect(r?.intent.type).toBe('subscription');
  });

  it('sync build はマイページ誘導 text (= async 経由で契約カードを期待)', () => {
    const r = detectIntent('サブスク');
    expect(r?.intent.type).toBe('subscription');
    const text = JSON.stringify(r?.messages);
    expect(text).toContain('マイページ');
    expect(text).toContain('naturism-diet.com/account');
  });

  it('async build は friend 行を引いて契約カードを返す (未連携 friend はメール登録導線)', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM friends')) {
                  return { id: 'f1', display_name: 'x', shopify_customer_id: null };
                }
                throw new Error(`unsupported: ${sql}`);
              },
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const messages = await buildMessagesForIntentAsync(
      { type: 'subscription', reason: 'test' },
      { db, friendId: 'f1', liffUrl: 'https://liff.line.me/xxxx' },
    );
    const s = JSON.stringify(messages);
    expect(s).toContain('アカウント連携');
    // 連携UI が実在する /liff/my-rank (#rank) へ (採点R2: #account は行き止まり)
    expect(s).toContain('https://liff.line.me/xxxx#rank');
  });
});

describe('intent-router — subscription 負例 (誤発火防止、採点R1 HIGH)', () => {
  it.each([
    'サプリは定期的に飲んだ方がいいですか？',
    '不定期ですが飲んでいます',
    'メルマガの解約',
    '朝食をスキップしてもいいですか？',
    '解約',
    '定期健診に行ってきました',
  ])('returns null for "%s" (bare 定期/解約/スキップ を採用しない)', (text) => {
    expect(detectIntent(text)).toBeNull();
  });

  it('disabledIntents (gate OFF) は subscription パターンを skip して後続へ fall-through する', () => {
    // 有効時は subscription が先勝ち
    const enabled = detectIntent('アンバサダー解約したい');
    expect(enabled?.intent.type).toBe('subscription');
    // gate OFF では従来どおり feature_unavailable (アンバサダー) に落ちる = 挙動ゼロ変更
    const disabled = detectIntent('アンバサダー解約したい', { disabledIntents: ['subscription'] });
    expect(disabled?.intent.type).toBe('feature_unavailable');
  });

  it('async build: friend 行が引けない場合は sync のマイページ誘導 text に落ちる', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return null;
              },
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const messages = await buildMessagesForIntentAsync(
      { type: 'subscription', reason: 'test' },
      { db, friendId: 'ghost', liffUrl: 'https://liff.line.me/xxxx' },
    );
    expect(JSON.stringify(messages)).toContain('naturism-diet.com/account');
  });
});

describe('intent-router — subscription negativeKeywords (採点R2)', () => {
  it.each([
    'メルマガの解約方法を教えて',
    'メールマガジンを解約したい',
    'ニュースレターの解約手続き',
  ])('returns null for "%s" (メルマガ系解約は乗っ取らない → AI へ)', (text) => {
    expect(detectIntent(text)).toBeNull();
  });

  it('定期文脈の解約は引き続き subscription', () => {
    expect(detectIntent('定期便の解約方法を教えて')?.intent.type).toBe('subscription');
  });
});

