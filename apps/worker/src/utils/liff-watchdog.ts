/**
 * 外部 watchdog — 本体 inline script が全滅しても生き残る最終防衛線 (2026-07-31)
 *
 * ## なぜ「本体 script の中の watchdog」では守れないか
 * /liff/opt-in の 2.5 ヶ月障害 (2026-05-17〜07-29) では、12 秒 watchdog が
 * **守るべき script 自身の中にあった**ため、script 打ち切りと一緒に死んで
 * 一度も発火しなかった。全損クラス (打ち切り / SyntaxError / 先頭付近の実行時例外)
 * では、同じ script 内の防衛線は構造的に必ず道連れになる。
 *
 * ## 設計
 * - 独立した別の `<script>` 要素として **`<head>` の最初の外部 CDN script より前** に置く。
 *   HTML parser は script を要素単位で評価するので、後続の本体がどう壊れても
 *   この watchdog は無傷で実行される。CDN script (tailwind / LIFF SDK) は同期ロードで
 *   parser をブロックするため、CDN より後ろに置くと「CDN ハング」クラスで
 *   watchdog 自体が arm されない (採点 R1 HIGH)。必ず CDN より前。
 * - 15 秒後、`#loading` がまだ可視 (style.display !== 'none') かつ
 *   `__fatalShown` が立っていなければ、DOM API のみでエラー UI を最前面 overlay で出す。
 *   打ち切り時に本体 JS の残骸がテキストとして描画されるケースも overlay が覆い隠す。
 * - **再武装**: 発火時刻に body / #loading が未 parse (CDN ハング中) なら 3 秒間隔で
 *   最大 40 回再試行する (+2 分の監視窓)。
 * - **解除経路**: 発火後も #loading を隠さず 2 秒間隔で監視し、本体が遅れて成功して
 *   #loading を隠したら overlay を自分で撤去する (15 秒超の遅延成功を恒久エラーにしない)。
 * - 優先順位の契約: portal / opt-in の in-script watchdog (12 秒・ブランド文言) が先に
 *   発火した場合は `__fatalShown` で こちらは何もしない。逆に 15 秒以降に各ページの
 *   showFatalError が走った場合は **showFatalError 側が overlay を撤去して** ブランド
 *   文言を優先する (全 6 ページに実装・liff-script-syntax.test.ts が固定)。
 *   15 秒 > 12 秒 の関係は意図的なので、どちらかを変える時は必ず両方見ること。
 *
 * ## 制約 (絶対遵守 — CLAUDE.md「LIFF inline JS コーディングルール」)
 * - 補間値ゼロ (タイムアウト定数のみ数値 literal 補間) の完全静的 ES5。
 *   createElement + textContent のみ (#193 クラス回避)。
 * - script 終了タグを literal に含めない。念のため inlineScriptBody() でも機械的に無害化。
 */
import { inlineScriptBody } from './inline-script.js';

/** watchdog の <script> タグを識別するマーカー属性。post-deploy-check / テストが参照する。 */
export const LIFF_WATCHDOG_ATTR = 'data-liff-watchdog';

/** 発火までの猶予。in-script watchdog (12s) より必ず後 = ブランド文言を優先させる。 */
export const LIFF_WATCHDOG_TIMEOUT_MS = 15_000;

const WATCHDOG_JS = `/* liff-watchdog v1: 本体 script が打ち切り/SyntaxError で全滅しても生き残る最終防衛線 */
(function () {
  'use strict';
  var rearm = 0;
  function fire() {
    try {
      if (window.__fatalShown) return;
      var el = document.getElementById('loading');
      if (!el || !document.body) {
        /* CDN 同期 script のハング等で parser が body に未到達。3 秒間隔で最大 40 回再武装し、
           窓 (+2 分) を使い切ったら DOMContentLoaded を最終トリガに残す (2 分超のハング回復対策) */
        rearm++;
        if (rearm <= 40) {
          setTimeout(fire, 3000);
        } else if (!window.__liffWatchdogFinal) {
          window.__liffWatchdogFinal = true;
          document.addEventListener('DOMContentLoaded', function () { setTimeout(fire, 3000); });
        }
        return;
      }
      if (el.style.display === 'none') return;
      var ov = document.createElement('div');
      ov.id = 'liff-watchdog-overlay';
      ov.setAttribute('role', 'alert');
      ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f8fafc;padding:32px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif';
      var icon = document.createElement('p');
      icon.textContent = '\\ud83c\\udf3f';
      icon.style.cssText = 'font-size:30px;margin:0 0 12px';
      var msg = document.createElement('p');
      msg.textContent = '読み込みに時間がかかっています。通信環境をご確認のうえ、もう一度開いてください';
      msg.style.cssText = 'font-size:15px;color:#4b5563;line-height:1.8;margin:0 0 20px;max-width:280px';
      var btn = document.createElement('button');
      btn.textContent = '再読み込み';
      btn.style.cssText = 'font-size:15px;font-weight:700;color:#fff;background:#0f766e;border:none;border-radius:999px;padding:12px 28px;cursor:pointer;box-shadow:0 2px 8px rgba(15,118,110,.28);transition:transform .15s';
      btn.addEventListener('touchstart', function () { btn.style.transform = 'scale(0.97)'; });
      btn.addEventListener('touchend', function () { btn.style.transform = ''; });
      btn.addEventListener('click', function () { location.reload(); });
      ov.appendChild(icon);
      ov.appendChild(msg);
      ov.appendChild(btn);
      document.body.appendChild(ov);
      window.__fatalShown = true;
      /* 解除経路: #loading は隠さず監視し、本体が遅れて成功したら overlay を自分で撤去する */
      var polls = 0;
      var iv = setInterval(function () {
        polls++;
        if (el.style.display === 'none' || !ov.parentNode) {
          clearInterval(iv);
          if (ov.parentNode) ov.parentNode.removeChild(ov);
        } else if (polls >= 150) {
          clearInterval(iv);
        }
      }, 2000);
    } catch (e) { /* 最終防衛線の例外を他へ波及させない */ }
  }
  setTimeout(fire, ${LIFF_WATCHDOG_TIMEOUT_MS});
  window.__liffWatchdogArmed = true;
})();`;

/**
 * 外部 watchdog の <script> タグを返す。**必ず <head> の最初の外部 <script src> より前に
 * 置くこと** (CDN より後ろだと CDN ハングで arm されず、本体より後ろだと打ち切りの
 * 巻き添えで消える)。配置順は liff-script-syntax.test.ts と post-deploy-check.mjs の
 * 両方が検証する。
 */
export function liffWatchdogScriptTag(): string {
  return `<script ${LIFF_WATCHDOG_ATTR}="v1">${inlineScriptBody(WATCHDOG_JS)}</script>`;
}
