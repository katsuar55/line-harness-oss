/**
 * 統合ランクヒーロー (2026-08-25) の恒久ガード。旧 liff-vital-strip.test.ts の後継。
 *
 * 直した実機報告は 2 つ:
 *   ①「ランク / はじめて」「クーポン / もらう →」の VITAL STRIP は**意味が分からない**
 *   ②「会員特典を見てみる」を押して初めてランクが出る = ノータップで出せ
 * そして本丸は **ランクの出どころの付け替え**。ホームは DEPRECATED な friend_ranks
 * (本番で空) を読んでおり、会員証 /liff/my-rank と別の答えを出していた。
 *
 * 検査は 2 軸:
 *   A. 静的 — 位置・ID 契約・安全規約 (追加 fetch ゼロ / innerHTML 不使用 / 禁止 hex)
 *   B. 実挙動 — 吐き出された client JS を最小 DOM で**実際に走らせて**、
 *      顧客が読む文字列を逐語照合する (emit されているが動かない、を取り逃がさない)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { liffPages } from '../routes/liff-pages.js';
import { rankHeroJs, rankHeroCss, RANK_HERO_IDS } from '../routes/liff-portal-fragments/rank-hero.js';
import { makeMiniDocument, byId } from './helpers/mini-dom.js';
import type { MiniDocument, MiniNode } from './helpers/mini-dom.js';

const root = dirname(fileURLToPath(import.meta.url));
// CRLF のまま正規表現を当てるとブロック抽出が外れ、測定器が無力化する
const pagesSrc = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8').replace(/\r\n/g, '\n');

const baseEnv = {
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
  WORKER_URL: 'https://example.workers.dev',
};

let html = '';
beforeAll(async () => {
  const res = await liffPages.request('/liff/portal', {}, {
    ...baseEnv,
    LIFF_HOME_IA_ENABLED: 'true',
  } as unknown as Record<string, unknown>);
  expect(res.status).toBe(200);
  html = await res.text();
});

/** クーポン枚数ブロック (ヒーローのフッターに枚数を流す唯一の経路)。 */
const couponBlock = pagesSrc.match(
  /\/\/ ─── 保有クーポン枚数[\s\S]*?\nfunction vsJumpReferral\(\) \{[\s\S]*?\n\}/,
);

// ───────────────────────── 実挙動ハーネス ─────────────────────────

interface HeroApi {
  renderRankHero: (loyalty: unknown, isAmb?: unknown) => void;
  renderRankHeroUnknown: (el: MiniNode) => void;
  vsSetCoupons: (key: string, n: unknown) => void;
  vsSetCouponsWaiting: (n: unknown) => void;
  vsCouponTotal: () => number;
  updateVsCouponCell: () => void;
}

interface Harness {
  doc: MiniDocument;
  api: HeroApi;
  featurePages: string[];
  scrolled: string[];
}

function makeHarness(opts: { reducedMotion?: boolean; rankDiscountOn?: boolean } = {}): Harness {
  if (!couponBlock) throw new Error('クーポン枚数ブロックが liff-pages.ts に見つかりません');
  const doc = makeMiniDocument();
  const card = doc.createElement('div');
  card.id = 'rank-card';
  doc.body.appendChild(card);
  // 跳び先のスタブ (vsScrollTo は scrollIntoView を直接呼ぶ)
  const scrolled: string[] = [];
  for (const id of ['coupons-card', 'referral-card']) {
    const n = doc.createElement('div');
    n.id = id;
    (n as unknown as Record<string, unknown>).scrollIntoView = () => { scrolled.push(id); };
    doc.body.appendChild(n);
  }
  const featurePages: string[] = [];
  const win: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'document', 'window', 'TAB_REDUCED_MOTION', 'setTimeout', 'openFeaturePage', 'RANK_DISCOUNT_ON',
    `${couponBlock[0]}
     ${rankHeroJs()}
     return { renderRankHero: renderRankHero, renderRankHeroUnknown: renderRankHeroUnknown,
              vsSetCoupons: vsSetCoupons,
              vsSetCouponsWaiting: vsSetCouponsWaiting, vsCouponTotal: vsCouponTotal,
              updateVsCouponCell: updateVsCouponCell };`,
  ) as (...a: unknown[]) => HeroApi;

  const api = factory(
    doc,
    win,
    // 既定は reduced-motion 扱い = バー幅を即値にして決定的にテストする
    opts.reducedMotion !== false,
    (cb: () => void) => { cb(); return 0; },
    (p: string) => { featurePages.push(p); },
    opts.rankDiscountOn !== false,
  );
  return { doc, api, featurePages, scrolled };
}

const BRONZE = {
  rank: { id: 'bronze', name: 'ブロンズ', discountPercent: 2, badgeEmoji: '🥉', badgeColor: '#CD7F32', badgeImageUrl: '/images/rank-bronze-v2.png' },
  trailing12moJpy: 660,
  next: { id: 'silver', name: 'シルバー', remainingJpy: 11340, discountPercent: 4 },
  progressRatio: 0.055,
};
const REGULAR = {
  rank: { id: 'regular', name: 'レギュラー', discountPercent: 0, badgeEmoji: '🌱', badgeColor: '#9CA3AF', badgeImageUrl: '/images/rank-regular-v2.png' },
  trailing12moJpy: 0,
  next: { id: 'bronze', name: 'ブロンズ', remainingJpy: 1, discountPercent: 2 },
  progressRatio: 0,
};
const PLATINUM = {
  rank: { id: 'platinum', name: 'プラチナ', discountPercent: 8, badgeEmoji: '💎', badgeColor: '#0ABAB5', badgeImageUrl: '/images/rank-platinum-v2.png' },
  trailing12moJpy: 52000,
  next: null,
  progressRatio: 1,
};

// ───────────────────────── A. 静的 ─────────────────────────

describe('統合ランクヒーロー — 静的構造', () => {
  it('home セクションの先頭 (welcome クーポンより前) に置かれている', () => {
    const home = html.indexOf('<div id="section-home"');
    const hero = html.indexOf('id="rank-card"');
    const welcome = html.indexOf('id="welcome-coupon-card"');
    expect(home).toBeGreaterThan(0);
    expect(hero).toBeGreaterThan(home);
    expect(hero).toBeLessThan(welcome);
  });

  it('🚨 旧 VITAL STRIP は 1 byte も残っていない (亡霊 CSS / 亡霊関数を残さない)', () => {
    for (const ghost of ['id="vital-strip"', '.vs-grid{', '.vs-cell{', 'vsSetRank(', 'vsSetLinked(', 'vsJumpRank(', 'vsLinkTap(']) {
      expect(html, ghost + ' が残っている').not.toContain(ghost);
    }
  });

  it('ID 契約 (テストと client JS が同じ綴りを見る)', () => {
    const js = rankHeroJs();
    for (const id of Object.values(RANK_HERO_IDS)) {
      expect(js + html, id).toContain(id);
    }
  });

  it('既存 ID の契約を壊していない', () => {
    for (const id of ['section-home', 'rank-card', 'coupons-card', 'referral-card',
      'welcome-coupon-card', 'link-coupon-card', 'badge-card', 'next-move-card']) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});

describe('統合ランクヒーロー — 安全規約', () => {
  it('🚨 追加 fetch ゼロ — ヒーローと枚数集計は API を呼ばない', () => {
    const src = rankHeroJs() + (couponBlock ? couponBlock[0] : '');
    expect(src.length).toBeGreaterThan(1000); // 抽出できていること
    for (const bad of ['api(', 'apiGet(', 'fetch(', 'XMLHttpRequest']) {
      expect(src, bad).not.toContain(bad);
    }
  });

  it('🚨 innerHTML を使わない (DOM 組み立てのみ = 引用符ネストと XSS を構造的に断つ)', () => {
    expect(rankHeroJs()).not.toContain('innerHTML');
    expect(couponBlock![0]).not.toContain('innerHTML');
  });

  it('ブランド原色ティールを持ち込まない (§7-1)', () => {
    expect(rankHeroCss()).not.toMatch(/#0abab5/i);
  });

  it('badgeColor は hex allowlist を通してから style に入れる (CSS injection 防止)', () => {
    expect(rankHeroJs()).toContain('function rhSafeColor');
    expect(rankHeroJs()).toMatch(/glow\.style\.background = "radial-gradient\(circle," \+ color/);
  });

  it('タップ域は 48px 以上 (60代のタップ精度)', () => {
    expect(rankHeroCss()).toMatch(/\.rh-foot button\{[^}]*min-height:48px/);
  });

  it('reduced-motion でバーのトランジションを止める', () => {
    expect(rankHeroCss()).toContain('@media(prefers-reduced-motion:reduce)');
  });
});

// ───────────────────────── B. 実挙動 ─────────────────────────

describe('統合ランクヒーロー — ノータップでランク・割引%・次条件が出る', () => {
  it('ブロンズ: メダル画像・ランク名・% OFF・累計・次条件がすべて初期表示に出る', () => {
    const h = makeHarness();
    h.api.renderRankHero(BRONZE);
    expect(byId(h.doc, 'rh-name').textContent).toBe('ブロンズ会員');
    expect(byId(h.doc, 'rh-off').textContent).toBe('通常購入 2% OFF');
    expect(byId(h.doc, 'rh-spent').textContent).toBe('直近 12 ヶ月のお買い上げ ¥660');
    expect(byId(h.doc, 'rh-next').textContent).toBe('あと ¥11,340 で シルバー会員（4% OFF） にランクアップ');
    const img = byId(h.doc, 'rh-medal-img');
    expect(img['src']).toBe('/images/rank-bronze-v2.png');
    // タップ不要 = 「見てみる」を押させる文言が本文に無いこと
    expect(byId(h.doc, 'rank-card').textContent).not.toContain('会員特典を見てみる');
  });

  it('レギュラー: 0% は嘘をつかず、次の条件で前を向かせる', () => {
    const h = makeHarness();
    h.api.renderRankHero(REGULAR);
    expect(byId(h.doc, 'rh-name').textContent).toBe('レギュラー会員');
    expect(byId(h.doc, 'rh-off').textContent).toBe('割引特典はこれから');
    expect(byId(h.doc, 'rh-off').className).toContain('is-none');
    expect(byId(h.doc, 'rh-next').textContent).toBe('1 回のお買い物で ブロンズ会員（2% OFF） になります');
  });

  it('🚨 累計 0 円のときは金額を出さない (原資が本番で空 = 購入済みの顧客にも 0 が出るため)', () => {
    const h = makeHarness();
    h.api.renderRankHero(REGULAR);
    expect(h.doc.getElementById('rh-spent')).toBeNull();
    expect(byId(h.doc, 'rank-card').textContent).not.toContain('¥0');
  });

  it('🚨 次条件は購入履歴を断定しない (「はじめての」と書かない)', () => {
    const h = makeHarness();
    h.api.renderRankHero(REGULAR);
    expect(byId(h.doc, 'rh-next').textContent).not.toContain('はじめて');
  });

  it('最高ランク: 次が無いときは達成を称える', () => {
    const h = makeHarness();
    h.api.renderRankHero(PLATINUM);
    expect(byId(h.doc, 'rh-next').textContent).toBe('✨ 最高ランク達成！いつもありがとうございます');
    expect(byId(h.doc, 'rh-off').textContent).toBe('通常購入 8% OFF');
  });

  it('進捗バーは 0..1 をクランプして % 幅にする', () => {
    const h = makeHarness();
    h.api.renderRankHero({ ...BRONZE, progressRatio: 0.42 });
    expect(byId(h.doc, 'rh-bar-fill').style['width']).toBe('42%');
    h.api.renderRankHero({ ...BRONZE, progressRatio: 9 });
    expect(byId(h.doc, 'rh-bar-fill').style['width']).toBe('100%');
    h.api.renderRankHero({ ...BRONZE, progressRatio: -3 });
    expect(byId(h.doc, 'rh-bar-fill').style['width']).toBe('0%');
  });

  it('壊れた値 (NaN / 欠損) でも NaN を表示しない', () => {
    const h = makeHarness();
    h.api.renderRankHero(
      { rank: { id: 'x', name: 'テスト', discountPercent: 'abc' }, trailing12moJpy: 'zzz', next: { name: '次', remainingJpy: 'nope' }, progressRatio: 'nope' },
    );
    const text = byId(h.doc, 'rank-card').textContent;
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
    expect(byId(h.doc, 'rh-off').textContent).toBe('割引特典はこれから');
    // remainingJpy が読めないときは金額を断定せず「1 回のお買い物で」に倒す
    expect(byId(h.doc, 'rh-next').textContent).toBe('1 回のお買い物で 次会員 になります');
  });
});

describe('統合ランクヒーロー — 記録が無いときの誠実さ', () => {
  it('🚨 「連携すればこれまでのお買い物が反映されます」とは書かない (取り込みは別 gate / 別 webhook 依存)', () => {
    const h = makeHarness();
    h.api.renderRankHero(REGULAR);
    const text = byId(h.doc, 'rank-card').textContent;
    expect(text).not.toContain('これまでのお買い物');
    expect(text).not.toContain('反映されます');
  });

  it('記録が無いときは判定の根拠だけを述べる (「なぜレギュラーなのか」に答える)', () => {
    const h = makeHarness();
    h.api.renderRankHero(REGULAR);
    expect(byId(h.doc, 'rh-note').textContent)
      .toBe('会員ランクは、公式ストアでのお買い物の記録から判定しています');
  });

  it('記録があるときは注記を出さない (説明が要るのは 0 のときだけ)', () => {
    const h = makeHarness();
    h.api.renderRankHero(BRONZE);
    expect(h.doc.getElementById('rh-note')).toBeNull();
  });

  it('🚨 記録が無いときは空の進捗バーを出さない (0% のバーは進捗があるように誤読される)', () => {
    const h = makeHarness();
    h.api.renderRankHero(REGULAR);
    expect(h.doc.getElementById('rh-bar-fill')).toBeNull();
  });
});

describe('統合ランクヒーロー — 割引 gate (RANK_DISCOUNT_ENABLED) 連動', () => {
  it('gate on: % と ¥2,000 の条件を必ずセットで出す', () => {
    const h = makeHarness({ rankDiscountOn: true });
    h.api.renderRankHero(BRONZE);
    expect(byId(h.doc, 'rh-off').textContent).toBe('通常購入 2% OFF');
    expect(byId(h.doc, 'rh-cond').textContent).toBe('¥2,000 以上のご注文でお使いいただけます');
  });

  it('🚨 % を出すときは ¥2,000 の併記が必ず付く (NLR- コードには最低購入金額が必ず付く = % 単独は有利誤認)', () => {
    // REGULAR は自分の割引が 0% でも「次は 2% OFF」と % を出す → 条件の併記が要る
    for (const data of [BRONZE, PLATINUM, REGULAR]) {
      const h = makeHarness({ rankDiscountOn: true });
      h.api.renderRankHero(data);
      const text = byId(h.doc, 'rank-card').textContent;
      expect(text, data.rank.id).toContain('% OFF');
      expect(text, data.rank.id).toContain('¥2,000 以上のご注文で');
    }
  });

  it('% を 1 つも出さない状態では条件行も出さない (無関係な注記を増やさない)', () => {
    const h = makeHarness({ rankDiscountOn: true });
    // 最高ランクで割引 0% (定義上ありえないが、defs 差し替えの multi-brand では起こりうる)
    h.api.renderRankHero({ ...PLATINUM, rank: { ...PLATINUM.rank, discountPercent: 0 }, next: null });
    expect(byId(h.doc, 'rank-card').textContent).not.toContain('% OFF');
    expect(h.doc.getElementById('rh-cond')).toBeNull();
  });

  it('🚨 gate off: % を 1 箇所も出さない (発行されない割引を広告しない)', () => {
    const h = makeHarness({ rankDiscountOn: false });
    h.api.renderRankHero(BRONZE);
    const text = byId(h.doc, 'rank-card').textContent;
    expect(text).not.toContain('% OFF');
    expect(text).not.toContain('¥2,000');
    expect(byId(h.doc, 'rh-off').textContent).toBe('割引特典は準備中です');
    expect(byId(h.doc, 'rh-next').textContent).toBe('あと ¥11,340 で シルバー会員 にランクアップ');
  });

  it('gate off でもランク名・メダル・累計は出す (分かっている事実は隠さない)', () => {
    const h = makeHarness({ rankDiscountOn: false });
    h.api.renderRankHero(BRONZE);
    expect(byId(h.doc, 'rh-name').textContent).toBe('ブロンズ会員');
    expect(byId(h.doc, 'rh-spent').textContent).toBe('直近 12 ヶ月のお買い上げ ¥660');
    expect(h.doc.getElementById('rh-medal-img')).not.toBeNull();
  });
});

describe('統合ランクヒーロー — メダル画像のフォールバック', () => {
  it('画像が落ちたら絵文字へ退避する', () => {
    const h = makeHarness();
    h.api.renderRankHero(BRONZE);
    const img = byId(h.doc, 'rh-medal-img');
    const fb = byId(h.doc, 'rh-medal-fallback');
    expect(fb.style['display']).toBe('none');
    (img['onerror'] as () => void)();
    expect(img.style['display']).toBe('none');
    expect(fb.style['display']).toBe('block');
    expect(fb.textContent).toBe('🥉');
  });

  it('画像 URL が無ければ最初から絵文字で描く', () => {
    const h = makeHarness();
    h.api.renderRankHero({ ...BRONZE, rank: { ...BRONZE.rank, badgeImageUrl: null } });
    expect(h.doc.getElementById('rh-medal-img')).toBeNull();
    expect(byId(h.doc, 'rank-card').textContent).toContain('🥉');
  });
});

describe('統合ランクヒーロー — 取得できなかったとき', () => {
  it('loyalty が無ければ断定せず「ただいま確認中」+ 会員証への導線', () => {
    const h = makeHarness();
    h.api.renderRankHero(null);
    expect(byId(h.doc, 'rh-name').textContent).toBe('ただいま確認中');
    // 存在しないランクや % を作り話しない
    expect(byId(h.doc, 'rank-card').textContent).not.toContain('% OFF');
    expect(h.doc.getElementById('rh-detail')).not.toBeNull();
  });

  it('🚨 取得失敗の退避表示も gate に従う (gate off で「割引特典が受けられます」と言わない)', () => {
    const on = makeHarness({ rankDiscountOn: true });
    on.api.renderRankHero(null);
    expect(byId(on.doc, 'rh-off').textContent).toBe('ご購入でランクが上がり、割引特典が受けられます');
    const off = makeHarness({ rankDiscountOn: false });
    off.api.renderRankHero(null);
    expect(byId(off.doc, 'rh-off').textContent).toBe('ランクの割引特典は準備中です');
    expect(byId(off.doc, 'rank-card').textContent).not.toContain('割引特典が受けられます');
  });
});

describe('統合ランクヒーロー — フッター (クーポン枚数と詳細導線)', () => {
  it('0 枚は「無い」で終わらせず もらう導線へ', () => {
    const h = makeHarness();
    h.api.renderRankHero(REGULAR);
    expect(byId(h.doc, 'rh-coupon-label').textContent).toBe('クーポンをもらう →');
  });

  it('互いに素な 5 系統を合算して枚数にする', () => {
    const h = makeHarness();
    h.api.renderRankHero(REGULAR);
    h.api.vsSetCoupons('list', 2);
    h.api.vsSetCoupons('welcome', 1);
    h.api.vsSetCoupons('referral', 3);
    h.api.vsSetCoupons('link', 1);
    h.api.vsSetCoupons('friend', 1);
    expect(h.api.vsCouponTotal()).toBe(8);
    expect(byId(h.doc, 'rh-coupon-label').textContent).toBe('クーポン 8枚');
  });

  it('🚨 set であって increment ではない (loader の再試行で二重計上しない)', () => {
    const h = makeHarness();
    h.api.renderRankHero(REGULAR);
    h.api.vsSetCoupons('welcome', 1);
    h.api.vsSetCoupons('welcome', 1);
    h.api.vsSetCoupons('welcome', 1);
    expect(h.api.vsCouponTotal()).toBe(1);
    expect(byId(h.doc, 'rh-coupon-label').textContent).toBe('クーポン 1枚');
  });

  it('待機枚数は主数字に混ぜない (「使える枚数」の誤認防止)', () => {
    const h = makeHarness();
    h.api.renderRankHero(REGULAR);
    h.api.vsSetCouponsWaiting(2);
    expect(byId(h.doc, 'rh-coupon-label').textContent).toBe('クーポン +2枚 準備中');
    h.api.vsSetCoupons('welcome', 1);
    expect(byId(h.doc, 'rh-coupon-label').textContent).toBe('クーポン 1枚（+2枚 準備中）');
  });

  it('枚数が 0 に戻ったら表示も 0 状態へ戻る (古い数字を残さない)', () => {
    const h = makeHarness();
    h.api.renderRankHero(REGULAR);
    h.api.vsSetCoupons('welcome', 1);
    h.api.vsSetCoupons('welcome', 0);
    expect(byId(h.doc, 'rh-coupon-label').textContent).toBe('クーポンをもらう →');
  });

  it('🚨 ヒーロー描画より先に着弾した枚数も反映される (loader の順序に依存しない)', () => {
    const h = makeHarness();
    h.api.vsSetCoupons('list', 3); // まだヒーローは未描画
    h.api.renderRankHero(REGULAR);
    expect(byId(h.doc, 'rh-coupon-label').textContent).toBe('クーポン 3枚');
  });

  it('クーポンボタン: 0 枚なら紹介へ、1 枚以上ならクーポン一覧へ', () => {
    const h = makeHarness();
    h.api.renderRankHero(REGULAR);
    byId(h.doc, 'rh-coupon').dispatch('click');
    expect(h.scrolled).toEqual(['referral-card']);
    h.api.vsSetCoupons('list', 1);
    byId(h.doc, 'rh-coupon').dispatch('click');
    expect(h.scrolled).toEqual(['referral-card', 'coupons-card']);
  });

  it('詳細ボタンは会員証ページへ (ランク判定日 / 全ランク一覧はそちらに置く)', () => {
    const h = makeHarness();
    h.api.renderRankHero(BRONZE);
    expect(byId(h.doc, 'rh-detail').textContent).toContain('会員特典を見る');
    byId(h.doc, 'rh-detail').dispatch('click');
    expect(h.featurePages).toEqual(['/liff/my-rank']);
  });
});

describe('統合ランクヒーロー — アンバサダー装飾の維持', () => {
  it('アンバサダーは金の環境光とバッジが付く', () => {
    const h = makeHarness();
    h.api.renderRankHero(BRONZE, true);
    const card = byId(h.doc, 'rank-card');
    expect(card.className).toContain('rank-ambassador');
    expect(card.textContent).toContain('✨ Ambassador');
  });

  it('通常会員には付かない (再描画で装飾が残らない)', () => {
    const h = makeHarness();
    h.api.renderRankHero(BRONZE, true);
    h.api.renderRankHero(BRONZE);
    const card = byId(h.doc, 'rank-card');
    expect(card.className).not.toContain('rank-ambassador');
    expect(card.textContent).not.toContain('Ambassador');
  });
});

// ───────────────────────── 配線 (ここが切れると黙って古い表示に戻る) ─────────────────────────

describe('統合ランクヒーロー — loader への配線', () => {
  it('🚨 loadRank は data.loyalty を描く (DEPRECATED な currentRank を見ない)', () => {
    const fn = pagesSrc.match(/async function loadRank\(preRes\) \{[\s\S]*?\n\}/);
    expect(fn).toBeTruthy();
    expect(fn![0]).toContain('renderRankHero(data.loyalty');
    for (const dead of ['data.currentRank', 'data.totalSpent', 'data.nextRank', 'data.progressPercent']) {
      expect(fn![0], dead + ' は本番で空の DEPRECATED 系統').not.toContain(dead);
    }
  });

  it('連携の向きは単調 (loadRank が遅れて false を運んでも on を落とさない)', () => {
    const fn = pagesSrc.match(/async function loadRank\(preRes\) \{[\s\S]*?\n\}/);
    // 単調性の実体は else-if のガード。 これが消えると、 連携直後に古いスナップショットが
    // 着弾したときショップタブに「ストアにログインして連携」が復活する
    expect(fn![0]).toContain("data.linked === false && window.__shopifyLinked !== true");
  });

  it('5 系統すべてが成功時と 0 件時の両方で枚数を set する', () => {
    for (const key of ['list', 'welcome', 'referral', 'link', 'friend']) {
      const calls = [...pagesSrc.matchAll(new RegExp(`vsSetCoupons\\('${key}',`, 'g'))];
      expect(calls.length, key).toBeGreaterThanOrEqual(2);
    }
  });
});
