/**
 * resilience 全域修正 (2026-07-04 採点 Round3: resilience=58, 支配的欠陥クラス):
 *
 * liff-pages.ts の 15+ loader が API 失敗を catch {} で握りつぶし、skeleton/blank が
 * 永久固着していた (#179 ストアタブと同族)。/liff/opt-in も「読み込み中…」固着を実機確認。
 *
 * 修正仕様 (共通ヘルパー方式・個別パッチ禁止):
 *   - apiFailed(res): #179 の api()/apiGet() HTTP status 透過を使い status>=400 / null を失敗判定。
 *     demo モードは従来どおり空状態に倒す (プレビューにエラーカードを出さない)。
 *   - cardError(el, res, retryFnName): 非 auth 失敗はカード内「読み込みに失敗しました+再試行」。
 *     401 は handleAuthExpired() へ一本化 (カード毎に同文エラーを並べない)。
 *   - handleAuthExpired(): showFatalError で全画面「ログインの有効期限が切れました」+再読み込み。
 *     api()/apiGet() 中央でも 401 を検知 (mutation 経路の 401 もカバー)。
 *   - loading watchdog (12s): liff.init/API が resolve も reject もしないケースで
 *     「読み込み中…」を明示エラーに倒す (portal + /liff/opt-in)。
 *   - 文言: 技術用語「セッション」を顧客向け文言から排除 (copy_clarity HIGH 先取り)。
 *
 * liff-pages.ts は inline template-literal のため source 静的検査で担保する
 * (liff-shop-error-states.test.ts と同流儀)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');
const optin = readFileSync(join(root, '..', 'routes', 'liff-opt-in-page.ts'), 'utf8');

/** 名前つき async loader のブロックを抽出 (top-level 関数は行頭 `}` で終端) */
function loaderBlock(name: string): string {
  const m = pages.match(new RegExp('async function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  expect(m, name + ' が定義されている').not.toBeNull();
  return m![0];
}

describe('共通ヘルパー (cardError / apiFailed / handleAuthExpired)', () => {
  it('3 ヘルパーが定義されている', () => {
    expect(pages).toContain('function apiFailed(');
    expect(pages).toContain('function cardError(');
    expect(pages).toContain('function handleAuthExpired(');
  });

  it('apiFailed は demo モードで false (プレビューは従来の空状態に倒す)', () => {
    expect(pages).toMatch(/function apiFailed\([\s\S]{0,160}if \(isDemo\) return false/);
  });

  it('apiFailed は status>=400 と null (fetch 例外) を失敗と判定する', () => {
    expect(pages).toMatch(/function apiFailed\([\s\S]{0,300}status >= 400/);
  });

  it('cardError は 401 を handleAuthExpired へ一本化 (カード毎の同文エラー多重表示を防ぐ)', () => {
    expect(pages).toMatch(/function cardError\([\s\S]{0,220}status === 401[\s\S]{0,80}handleAuthExpired\(\)/);
  });

  it('cardError は再試行ボタンつきエラーカードを描画する', () => {
    const m = pages.match(/function cardError\([\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('読み込みに失敗しました');
    expect(m![0]).toContain('再試行');
    expect(m![0]).not.toContain('`'); // esbuild backtick trap
  });

  it('handleAuthExpired は全画面の再読み込み誘導 (showFatalError) に倒す', () => {
    expect(pages).toMatch(/function handleAuthExpired\([\s\S]{0,240}showFatalError\('ログインの有効期限が切れました/);
  });

  it('api()/apiGet() 中央でも 401 を検知する (mutation 経路の 401 もカバー)', () => {
    const api = pages.match(/async function api\(path[\s\S]*?\n\}/);
    const apiGet = pages.match(/async function apiGet\(path[\s\S]*?\n\}/);
    expect(api).not.toBeNull();
    expect(apiGet).not.toBeNull();
    expect(api![0]).toMatch(/401[\s\S]{0,80}handleAuthExpired\(\)/);
    expect(apiGet![0]).toMatch(/401[\s\S]{0,80}handleAuthExpired\(\)/);
  });
});

describe('全 loader へ cardError 適用 (silent catch → skeleton 固着の根絶)', () => {
  // カード型 loader: 失敗時に自分自身を再試行 CTA として渡す
  const cardLoaders = [
    'loadRank',
    'loadTip',
    'loadCoupons',
    'loadFriendCoupon',
    'loadWelcomeCoupon',
    'loadIntakeData',
    'loadBadges',
    'loadReferralCard',
    'loadFeedbackHistory',
    'loadPendingSurveys',
    'loadNotifPrefs',
    'loadSubscriptions',
    'loadFAQ',
  ];

  for (const fn of cardLoaders) {
    it(fn + ' は失敗時に cardError (再試行=自関数) を描画し、握りつぶさない', () => {
      const b = loaderBlock(fn);
      expect(b, fn).toMatch(new RegExp("cardError\\([\\s\\S]{0,80}'" + fn + "'\\)"));
      expect(b, fn).not.toMatch(/catch \{ \/\* ignore \*\/ \}/);
      expect(b, fn).not.toMatch(/catch \{\}/);
    });
  }

  it('loadGraph は失敗時に cardError (再試行=retryGraph) を描画する', () => {
    const b = loaderBlock('loadGraph');
    expect(b).toMatch(/cardError\([\s\S]{0,80}'retryGraph'\)/);
    expect(pages).toContain('function retryGraph(');
    expect(pages).toMatch(/currentGraphDays = days/);
  });

  it('loadHealthData / loadProfile (フォーム型) は toast + 401 分岐で通知する', () => {
    const health = loaderBlock('loadHealthData');
    const profile = loaderBlock('loadProfile');
    expect(health).toMatch(/apiFailed\(/);
    expect(health).toContain('体調データを読み込めませんでした');
    expect(profile).toMatch(/apiFailed\(/);
    expect(profile).toContain('プロフィールを読み込めませんでした');
  });

  it('loadTodayIntake / loadBadges は raw fetch をやめ apiGet (401 中央検知の対象) を使う', () => {
    const today = loaderBlock('loadTodayIntake');
    const badges = loaderBlock('loadBadges');
    expect(today).toContain("apiGet('/api/liff/intake/today')");
    expect(badges).toContain("apiGet('/api/liff/badges')");
    expect(today).not.toContain('fetch(API_BASE');
    expect(badges).not.toContain('fetch(API_BASE');
  });

  it('loadTodayIntake は streak の HTTP エラー (throw しない経路) も「-」に倒す — 部分不整合を隠さない (review HIGH)', () => {
    const today = loaderBlock('loadTodayIntake');
    expect(today).toMatch(/apiFailed\(streakRes\)/);
  });

  it('loadRanking / loadAmbassador (任意カード) も 401 だけは全画面誘導に流す', () => {
    const ranking = loaderBlock('loadRanking');
    const ambassador = loaderBlock('loadAmbassador');
    expect(ranking).toMatch(/apiFailed\(/);
    expect(ambassador).toMatch(/apiFailed\(/);
  });
});

describe('MORE タブ: moreLoaded 固着の解消', () => {
  it('loadMoreData は 1 つでも失敗したら moreLoaded を解放し再訪問で再読込できる', () => {
    const b = loaderBlock('loadMoreData');
    expect(b).toMatch(/indexOf\(false\) >= 0/);
    expect(b).toMatch(/moreLoaded = false/);
  });

  it('loadNotifPrefs / loadSubscriptions / loadFAQ は成功/失敗を boolean で返す', () => {
    for (const fn of ['loadNotifPrefs', 'loadSubscriptions', 'loadFAQ']) {
      const b = loaderBlock(fn);
      expect(b, fn).toContain('return true');
      expect(b, fn).toContain('return false');
    }
  });

  it('loadSubscriptions のエラーは「まだリマインダーが設定されていません」に化けない', () => {
    const b = loaderBlock('loadSubscriptions');
    expect(b).not.toMatch(/catch \{ renderSubscriptions\(\); \}/);
  });

  it('loadFAQ のエラーは default FAQ (fallback 5 件) に化けない — apiFailed を fallback より先に判定', () => {
    const b = loaderBlock('loadFAQ');
    expect(b).toMatch(/apiFailed\(res\)[\s\S]*DBが空のときの fallback/);
  });
});

describe('loading watchdog (「読み込み中…」永久固着の根絶)', () => {
  it('portal: 12 秒で明示エラー+再読み込みに倒す watchdog がある', () => {
    expect(pages).toMatch(/setTimeout\([\s\S]{0,400}読み込みに時間がかかっています[\s\S]{0,200}12000\)/);
  });

  it('/liff/opt-in: 同じ watchdog がある (実機で固着を確認したページ)', () => {
    expect(optin).toMatch(/setTimeout\([\s\S]{0,400}読み込みに時間がかかっています[\s\S]{0,200}12000\)/);
  });

  it('watchdog / loading 消し込みは __fatalShown ガードで全画面エラーを上書き・隠蔽しない', () => {
    // showFatalError がフラグを立てる
    expect(pages).toMatch(/function showFatalError\([\s\S]{0,200}__fatalShown = true/);
    expect(optin).toMatch(/function showFatalError\([\s\S]{0,200}__fatalShown = true/);
    // initLiff の loading 非表示は fatal 表示中はスキップ (401 overlay を消さない)
    expect(pages).toMatch(/__fatalShown\) return;[\s\S]{0,200}getElementById\('loading'\)\.style\.display = 'none'/);
  });
});

describe('文言統一 (copy_clarity HIGH 先取り): 技術用語「セッション」を顧客文言から排除', () => {
  it('portal / opt-in に「セッションの有効期限」が残っていない', () => {
    expect(pages).not.toContain('セッションの有効期限');
    expect(optin).not.toContain('セッションの有効期限');
  });

  it('auth 失効文言は「ログインの有効期限が切れました」に統一', () => {
    expect(pages).toContain('ログインの有効期限が切れました');
    expect(optin).toContain('ログインの有効期限が切れました');
  });

  it('opt-in 送信時の 401 は全画面の再読み込み誘導に倒す (エラートーストで済ませない)', () => {
    expect(optin).toMatch(/res\.status === 401[\s\S]{0,220}showFatalError/);
  });
});
