/**
 * 再注文の二重購入ガード — 確認シート (採点②-1 HIGH, 2026-08-22 Katsu 決定)。
 *
 * 「🔄 この注文を再注文」の対象が定期便のお届け分 (isSubscriptionOrder) で、かつ
 * 稼働契約を持つ顧客には、再注文シートの前に確認シートを 1 枚挟む。
 * 「はい、単発で追加購入する」で ack (acknowledgeSubscriptionDuplicate) を立てて通常フローへ。
 * サーバが正 (ack 無し POST は 409 subscription_duplicate) — クライアントは追随するだけで、
 * この JS を迂回しても事故は起きない。gate なしの常時 ON (安全ガードに gate を付けると
 * gate off = 無防備 になり本末転倒のため)。
 *
 * コーディング規律 (CLAUDE.md — LIFF inline JS):
 *   - client JS 文字列に「バックスラッシュ+シングルクォート」を書かない
 *   - script 終了タグを literal で書かない (seam 側の inlineScriptBody が最終防衛)
 *   - onclick は引数なしの名前付き関数のみ (引用符ネスト禁止)
 *   - ブランド: LINE 黄緑は使わない。teal 基軸・タップは柔らかく (scale .97)
 */

/** 確認シートの静的 HTML。#reorder-sheet と同型 (ros-panel を再利用)。 */
export function reorderGuardHtml(): string {
  return [
    '<!-- 定期便の二重購入 確認シート (採点②-1, 常時 ON) -->',
    '<div id="subdup-sheet" data-no-tab-swipe style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:61;background:rgba(15,23,42,.45)" role="dialog" aria-modal="true" aria-label="定期便の確認" onclick="if(event.target===this)closeSubDupConfirm()">',
    '    <div class="ros-panel">',
    '      <div class="flex items-center justify-between mb-1">',
    '        <p class="text-base font-bold text-gray-800">📦 定期便でお届けした分のご注文です</p>',
    '        <button onclick="closeSubDupConfirm()" aria-label="閉じる" class="text-gray-400 text-lg leading-none px-2 py-1">✕</button>',
    '      </div>',
    '      <p class="sdp-body">この商品は定期便で継続してお届けしています。再注文すると、定期便とは<b>別に単発でもう1回分</b>のご購入になります。</p>',
    '      <p class="sdp-note">お届けを早めたい・お休みしたいときは、定期便のスキップやお届け日変更もご利用いただけます。</p>',
    '      <button onclick="subDupProceed()" class="sdp-primary">はい、単発で追加購入する</button>',
    '      <button onclick="subDupGoSubCard()" class="sdp-secondary">定期便のお手続きを見る</button>',
    '      <button onclick="closeSubDupConfirm()" class="sdp-cancel">やめる</button>',
    '    </div>',
    '  </div>',
  ].join('\n  ');
}

/** 確認シート専用 CSS。60代トークン (16px/1.6/48px) + teal 基軸。 */
export function reorderGuardCss(): string {
  return [
    '/* ─ 定期便の二重購入 確認シート (採点②-1) ─ */',
    '.sdp-body{font-size:16px;line-height:1.6;color:#3f4b55;margin-top:8px}',
    '.sdp-body b{color:#0f766e}',
    '.sdp-note{font-size:14px;line-height:1.6;color:#66727d;background:#effaf8;border:1px solid #bfe8e3;border-radius:12px;padding:10px 12px;margin-top:10px}',
    '.sdp-primary{display:block;width:100%;min-height:48px;font-size:16px;font-weight:700;border-radius:12px;margin-top:14px;border:none;background:#0d827d;color:#fff;box-shadow:0 2px 8px rgba(15,118,110,.28);transition:transform .12s ease-out}',
    '.sdp-primary:active{transform:scale(.97)}',
    '.sdp-secondary{display:block;width:100%;min-height:48px;font-size:16px;font-weight:700;border-radius:12px;margin-top:8px;border:1.5px solid #bfe8e3;background:#effaf8;color:#0f766e;transition:transform .12s ease-out}',
    '.sdp-secondary:active{transform:scale(.97)}',
    '.sdp-cancel{display:block;width:100%;min-height:48px;font-size:16px;color:#5b6670;text-decoration:underline;background:none;border:none;margin-top:4px}',
  ].join('\n    ');
}

/** client JS 本体。liff-pages.ts が inlineScriptBody() を通して常時 emit する。 */
export function reorderGuardJs(): string {
  return REORDER_GUARD_JS;
}

// 通常の string 連結で保持する (TS template literal のエスケープ潰れ事故を構造的に避ける)。
const REORDER_GUARD_JS: string = [
  '// ─── 定期便の二重購入ガード (採点②-1, 常時 ON) ───',
  '// rosAckSubDup: この再注文フローで顧客が「単発で追加購入」を明示済みか。',
  '// reorderFromOrder が注文選択のたびに false へ戻す (ack の使い回し禁止)。',
  'var rosAckSubDup = false;',
  '',
  'function subDupShouldConfirm() {',
  '  return !!(rosOrder && rosOrder.isSubscriptionOrder) &&',
  '    window.__liffHasActiveContract === true && rosAckSubDup !== true;',
  '}',
  '',
  'function openSubDupConfirm() {',
  '  var el = document.getElementById("subdup-sheet");',
  '  if (el) el.style.display = "block";',
  '}',
  '',
  'function closeSubDupConfirm() {',
  '  var el = document.getElementById("subdup-sheet");',
  '  if (el) el.style.display = "none";',
  '}',
  '',
  '// 「はい、単発で追加購入する」— ack を立てて通常の再注文フローへ。',
  '// 409 リカバリ経路 (再注文シートが既に開いている) では選択済みの配送方法・希望日時を',
  '// 保持したまま即再送する (シートを開き直すと選択が既定値へ巻き戻るため)',
  'function subDupProceed() {',
  '  rosAckSubDup = true;',
  '  closeSubDupConfirm();',
  '  var sheet = document.getElementById("reorder-sheet");',
  '  if (sheet && sheet.style.display !== "none") { submitReorder(); return; }',
  '  openReorderSheet();',
  '}',
  '',
  '// 「定期便のお手続きを見る」— shop タブの定期便カードへ (無ければトーク導線を案内)',
  'function subDupGoSubCard() {',
  '  closeSubDupConfirm();',
  '  var el = document.getElementById("sub-contracts-card");',
  '  if (el && el.style.display !== "none") {',
  '    var y = el.getBoundingClientRect().top + window.pageYOffset - 110;',
  '    window.scrollTo({ top: y, behavior: "smooth" });',
  '    return;',
  '  }',
  '  showToast("トーク画面で「サブスク」とお送りいただくと、スキップやお届け日変更ができます");',
  '}',
].join('\n');
