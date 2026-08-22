/**
 * ビルド識別子 (2026-08-23)。
 *
 * 🚨 動機: #270 の視覚改修で「deploy 済み・本番 curl では新マーカーが出るのに
 *   オーナー実機は何も変わらない」という報告があり、切り分けに丸 1 日かかった。
 *   真因は 2 つ重なっていた:
 *     (a) 観測が deploy の 95 分**前**だった (スクショの時刻で後から判明)
 *     (b) LIFF の HTML に Cache-Control が皆無で WebView がキャッシュしうる (#271 で修正)
 *   どちらも「その画面がどの版か」を名乗る手段がゼロだったせいで判別できなかった。
 *
 * そこで **HTML 自身に版を名乗らせる**。これがあれば
 *   - 実機: アカウントタブ最下部の小さな版表示を見るだけで新旧が確定する
 *   - 自動: post-deploy-check が本番 HTML の meta と ローカル HEAD を照合できる
 * となり、「実機に届いたか」の切り分けが恒久的に 1 手で済む。
 *
 * 値は vite.config.ts が build 時に `git rev-parse --short HEAD` を埋める。
 * vitest / dev では define が無いので 'dev' に落ちる (テストが SHA に依存しない)。
 */

// vite の define による置換対象。未定義環境 (vitest/dev) では identifier ごと存在しない
declare const __BUILD_SHA__: string | undefined;

/** 短縮 commit SHA、または 'dev' (ローカル/テスト)。 */
export const BUILD_SHA: string =
  typeof __BUILD_SHA__ === 'string' && __BUILD_SHA__.length > 0 ? __BUILD_SHA__ : 'dev';

/** HTML の meta 名。post-deploy-check.mjs と liff-health-check.mjs が同じ値を参照する。 */
export const BUILD_META_NAME = 'x-build';

/** head に入れる meta タグ。値は英数字のみ (git SHA / 'dev') なのでエスケープ不要だが、念のため絞る。 */
export function buildMetaTag(): string {
  const safe = BUILD_SHA.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'dev';
  return `<meta name="${BUILD_META_NAME}" content="${safe}">`;
}
