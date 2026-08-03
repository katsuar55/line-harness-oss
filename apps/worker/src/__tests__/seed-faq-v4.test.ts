/**
 * 2026-08-03: seed-naturism-faq-v4.sql の内容を pin する test。
 *
 * v2 で投入した auto_replies (違い/アレルギー/成分) が公式サイトの単一真実と矛盾したまま
 * 本番 D1 で有効だった。auto_replies は intent-router / AI 応答より優先して返るため、
 * ソース(ai-response.ts / faq-context.ts)を直すだけでは本番の回答は変わらない。
 *
 * 本 test は seed が (1) 旧行を無効化し (2) 実ラベル準拠の正しい文面を含み
 * (3) 撤回済み表現・薬機法NG表現を含まない ことを保証する。
 * あわせて、同じファクトを持つソース側 3 ファイルにも古い値が復活しないよう固定する。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(here, '../../../../packages/db/seed-naturism-faq-v4.sql'), 'utf8');
// 禁止語チェックは「顧客に返る文面」= INSERT の response_content だけを対象にする。
// 除外する理由:
//   ・ヘッダーコメントは、何をなぜ直したかの説明として禁止語自体を引用している
//   ・セクション3の UPDATE ... replace('酵素360mg', ...) は、禁止語を"探して置き換える"側なので
//     本文に現れるのが正しい
const SECTION3 = '-- ── 3.';
const sqlBody = sql
  .slice(0, sql.indexOf(SECTION3) >= 0 ? sql.indexOf(SECTION3) : sql.length)
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

const SOURCES = [
  resolve(here, '..', 'services', 'ai-response.ts'),
  resolve(here, '..', 'services', 'faq-context.ts'),
  resolve(here, '..', 'services', 'welcome-postback.ts'),
  resolve(here, '..', 'services', 'monthly-broadcast-postback.ts'),
];

describe('seed-faq-v4 — 旧行の無効化', () => {
  it('商品ファクト系キーワードの旧行を is_active=0 で無効化する', () => {
    expect(sql).toMatch(/UPDATE auto_replies SET is_active = 0/);
    for (const kw of ['違い', 'アレルギー', '成分', 'ヴィーガン', 'Kep1er']) {
      expect(sql).toContain(`'${kw}'`);
    }
  });

  it('auto_replies 以外の user-visible な D1 データも揃える', () => {
    // ソースの .ts を直しても D1 の行がそのまま表示される経路
    expect(sql).toContain('purchase_cross_sell_map'); // 定期リマインドのクロスセル理由文
    expect(sql).toContain('scenario_steps'); // 友だち追加シナリオ
    // replace() は同じ SQL を2回流しても no-op (冪等)
    expect(sql).toMatch(/UPDATE purchase_cross_sell_map SET reason = replace\(/);
    expect(sql).toMatch(/UPDATE scenario_steps SET message_content = replace\(/);
  });

  it('DELETE を使わない (= 本番破壊操作の回避)', () => {
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });
});

describe('seed-faq-v4 — 実ラベル準拠の新ファクト', () => {
  it('成分数は Blue 9 / Pink 10 / Premium 16', () => {
    expect(sql).toContain('Blue（9成分）');
    expect(sql).toContain('Pink（10成分）');
    expect(sql).toContain('Premium（16成分）');
  });

  it('包含関係ではなく入れ替えとして説明している', () => {
    expect(sql).toContain('玄米外皮・胚芽加工食品を除き');
    expect(sql).toContain('植物発酵乾燥粉末を除き');
  });

  it('アレルゲンは商品別 (Pink 7品目 / Premium 大豆 / Blue 不使用)', () => {
    expect(sql).toContain('オレンジ、キウイフルーツ、バナナ、リンゴ、大豆、ゴマ、カシューナッツ');
    expect(sql).toContain('特定原材料8品目・推奨表示20品目は使用していません');
    expect(sql).toContain('製造工程上の混入の可能性は否定できません');
  });
});

describe('seed-faq-v4 — D1 実行制約', () => {
  // Cloudflare D1 は LIKE/GLOB パターン最大 50 バイト。超えると
  // 「LIKE or GLOB pattern too complex: SQLITE_ERROR」になり seed 全体がロールバックする
  // (2026-08-03 apply-faq-v4 run 30792841182 で日本語パターン 52〜61B が実際に失敗)。
  const FILES = [
    resolve(here, '../../../../packages/db/seed-naturism-faq-v4.sql'),
    resolve(here, '../../../../.github/workflows/admin-ops.yml'),
  ];
  it.each(FILES)('%s の全 LIKE パターンが 50 バイト未満', (file) => {
    const src = readFileSync(file, 'utf8');
    const patterns = [...src.matchAll(/LIKE '([^']*)'/g)].map((m) => m[1]);
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) {
      expect(Buffer.byteLength(p, 'utf8'), `LIKE '${p}'`).toBeLessThan(50);
    }
  });
});

// 撤回済み・NG 表現は seed とソースの両方から排除された状態を固定する。
// 出典: 消費者庁「食品添加物の不使用表示に関するガイドライン」類型2 /
//       naturism 3SKU の原材料表示 (ショ糖脂肪酸エステル等を含むため「天然由来100%」は不成立)
const FORBIDDEN = [
  '100%天然由来', // 原材料に合成添加物を含むため成立しない
  '人工甘味料', // 類型2: 人工/合成/化学/天然 の語を用いた不使用表示
  '人工香料',
  '脂質カット特化', // 一般食品 Blue への機能表示 (薬機法)
  '糖質カット最強', // 同上 + 景表法の最上級表現
  '酵素360mg', // Pink の成分表に無い数値
  '天然由来成分のみ', // 同上 (合成添加物を含むため成立しない)
  '動物性原料は一切', // ヴィーガンの断定。乳酸菌発酵物末の培地が未確認
  'フォトカードキャンペーンも実施中', // 終了済み販促を現在進行形で告知していた
];

describe('seed-faq-v4 / ソース — 撤回済み・NG 表現を含まない', () => {
  it.each(FORBIDDEN)('seed の応答文面が「%s」を含まない', (word) => {
    expect(sqlBody).not.toContain(word);
  });

  it.each(SOURCES)('%s が撤回済み・NG 表現を含まない', (file) => {
    const src = readFileSync(file, 'utf8');
    for (const word of FORBIDDEN) {
      expect(src).not.toContain(word);
    }
  });

  it.each(SOURCES)('%s が Blue を 8 成分と表記しない', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/Blue[^\n]{0,20}8\s*成分/);
    expect(src).not.toMatch(/8\s*成分配合/);
  });

  // 「Pink = Blue + 酵素」型の包含表現を禁止する。
  // 実際は Blue から玄米外皮・胚芽加工食品を除いて穀物麹と植物発酵乾燥粉末を足して10成分なので、
  // 単純な足し算として書くと成分構成を誤って伝える。
  // 数値を伴わないため上の「8成分」ガードでは検出できず、実際に4箇所を取りこぼした。
  it.each(SOURCES)('%s が Pink を「Blue + 酵素」と足し算で説明しない', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/Blue\s*[+＋]\s*(活きた)?酵素/);
    expect(src).not.toMatch(/Blue\s*の?\s*\d+\s*成分\s*[+＋]/);
  });
});
