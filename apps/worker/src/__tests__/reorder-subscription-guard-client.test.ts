/**
 * 再注文の二重購入ガード — クライアント確認シート (採点②-1 HIGH, 2026-08-22)。
 *
 * renderPortal() の**出力ベース**で検証する (ソース静的検査は「0 マッチで恒久 pass」の
 * 事故を起こすため)。ガードは gate なしの常時 ON — PORTAL_GATE_MATRIX 全組合せで
 * シートが emit されることを確認する。
 * サーバ側 (409 fail-closed) は reorder-subscription-guard.test.ts が正。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderPortal, PORTAL_GATE_MATRIX, extractStyles } from './helpers/render-portal.js';

/** 出力 HTML から top-level function のブロックを抽出 (行頭 `}` で終端)。 */
function fnBlock(html: string, name: string): string {
  const m = html.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  expect(m, name + ' が定義されている').not.toBeNull();
  return m![0];
}

describe('二重購入ガード 確認シート — 常時 ON (全 gate 組合せ)', () => {
  for (const [label, env] of PORTAL_GATE_MATRIX) {
    it(`${label}: #subdup-sheet とガード JS が emit される`, async () => {
      const html = await renderPortal(env);
      expect(html).toContain('id="subdup-sheet"');
      expect(html).toContain('function subDupShouldConfirm()');
      expect(html).toContain('function subDupProceed()');
      expect(html).toContain('はい、単発で追加購入する');
      // 🚨 初期非表示 (採点R1 HIGH: display:none 削除の mutation が実測 SURVIVED した穴)。
      // このシートは gate なし常時 emit の全画面 fixed オーバーレイなので、初期表示されると
      // ポータル全損級 — style 属性に display:none があることを開始タグ単位で観測する
      const sheetTag = html.match(/<div id="subdup-sheet"[^>]*>/)?.[0];
      expect(sheetTag, '#subdup-sheet の開始タグ').toBeTruthy();
      expect(sheetTag).toContain('display:none');
    });
  }
});

describe('二重購入ガード — 配線 (既定 env の出力で検証)', () => {
  it('reorderFromOrder は ack をリセットし、確認が必要ならシートを出して止まる', async () => {
    const html = await renderPortal();
    const b = fnBlock(html, 'reorderFromOrder');
    expect(b).toMatch(/rosAckSubDup = false/);
    // ガード判定 → openSubDupConfirm() → return が openReorderSheet() より前にある
    const guardIdx = b.indexOf('subDupShouldConfirm()');
    const openIdx = b.indexOf('openReorderSheet()');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(openIdx);
    expect(b).toContain('openSubDupConfirm(); return;');
  });

  it('subDupShouldConfirm は 定期便注文 × 稼働契約 × ack 未 の AND (どれが欠けても確認しない)', async () => {
    const html = await renderPortal();
    const b = fnBlock(html, 'subDupShouldConfirm');
    expect(b).toContain('rosOrder.isSubscriptionOrder');
    expect(b).toContain('window.__liffHasActiveContract === true');
    expect(b).toContain('rosAckSubDup !== true');
  });

  it('subDupProceed は ack を立ててから通常の再注文シートへ進む', async () => {
    const html = await renderPortal();
    const b = fnBlock(html, 'subDupProceed');
    expect(b).toMatch(/rosAckSubDup = true/);
    expect(b).toContain('openReorderSheet()');
  });

  it('submitReorder は ack 時のみ acknowledgeSubscriptionDuplicate を送り、409 code には確認シートで追随する', async () => {
    const html = await renderPortal();
    const b = fnBlock(html, 'submitReorder');
    expect(b).toMatch(/rosAckSubDup === true\) payload\.acknowledgeSubscriptionDuplicate = true/);
    // 採点R1 MEDIUM: 存在検査だけだと「ack 代入を api() 呼出の後ろへ移す」変異が生存する。
    // ack が payload に載るのは送信より**前**であることを位置関係で固定する
    const ackIdx = b.indexOf('payload.acknowledgeSubscriptionDuplicate = true');
    const apiIdx = b.indexOf("api('/api/liff/reorder/create'");
    expect(ackIdx).toBeGreaterThan(-1);
    expect(apiIdx).toBeGreaterThan(-1);
    expect(ackIdx).toBeLessThan(apiIdx);
    expect(b).toContain("res.code === 'subscription_duplicate'");
    expect(b).toContain('openSubDupConfirm()');
    // 409 リカバリはシートを閉じない (選択済み配送方法・希望日時を破棄しない)
    const dupBranch = b.slice(b.indexOf("res.code === 'subscription_duplicate'"), b.indexOf('} else if'));
    expect(dupBranch).not.toContain('closeReorderSheet()');
  });

  it('subDupProceed: 再注文シートが開いている 409 リカバリ経路では選択を保持したまま即再送する', async () => {
    const html = await renderPortal();
    const b = fnBlock(html, 'subDupProceed');
    expect(b).toContain('submitReorder()');
    // ack を立てるのは再送より前
    expect(b.indexOf('rosAckSubDup = true')).toBeLessThan(b.indexOf('submitReorder()'));
  });

  it('loadShopData は hasActiveSubscriptionContract を厳密比較で保持する (undefined は false 側)', async () => {
    const html = await renderPortal();
    const b = fnBlock(html, 'loadShopData');
    expect(b).toContain('window.__liffHasActiveContract = data.hasActiveSubscriptionContract === true');
  });

  it('確認シートの onclick は引数なしの名前付き関数のみ (引用符ネスト禁止ルール)', async () => {
    const html = await renderPortal();
    const sheet = html.match(/<div id="subdup-sheet"[\s\S]*?<\/div>\s*<\/div>/)![0];
    const onclicks = [...sheet.matchAll(/onclick="([^"]+)"/g)].map((m) => m[1]);
    expect(onclicks.length).toBeGreaterThanOrEqual(4);
    for (const oc of onclicks) {
      // 背景タップの self-close 判定だけは event.target 条件式を許す (既存 #reorder-sheet と同型)
      if (oc.startsWith('if(event.target===this)')) continue;
      expect(oc).toMatch(/^[A-Za-z_$][\w$]*\(\)$/);
    }
  });

  it('行き止まりなし: 「定期便のお手続きを見る」はカードへスクロール、無ければトーク導線を案内', async () => {
    const html = await renderPortal();
    const b = fnBlock(html, 'subDupGoSubCard');
    expect(b).toContain('sub-contracts-card');
    expect(b).toContain('showToast');
  });

  it('確認シートにボトムシート様式 (.ros-panel) が実際に当たる — セレクタが #subdup-sheet を含む (採点R1 HIGH)', async () => {
    // #reorder-sheet .ros-panel だけだと ID スコープで確認シートには 1 ルールも当たらず、
    // 無背景・上端貼り付きの素テキストで出荷される。reduced-motion 側も同時に観測する
    const css = extractStyles(await renderPortal());
    expect(css).toMatch(/#reorder-sheet \.ros-panel,#subdup-sheet \.ros-panel\{[^}]*background:#fff/);
    expect(css).toMatch(/prefers-reduced-motion[^}]*\{#reorder-sheet \.ros-panel,#subdup-sheet \.ros-panel\{animation:none\}/);
  });
});

describe('旧 SPA (?page=reorder) — 409 行き止まりの解消 (採点R1 MEDIUM)', () => {
  it('submitReorder は subscription_duplicate に confirm で追随し、ack 付きで再送する', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(root, '..', 'client', 'reorder.ts'), 'utf8');
    const m = src.match(/async function submitReorder\([^)]*\)[\s\S]*?\n\}/);
    expect(m, 'client/reorder.ts の submitReorder').not.toBeNull();
    const b = m![0];
    expect(b).toContain("json.code === 'subscription_duplicate'");
    expect(b).toContain('window.confirm');
    expect(b).toContain('await submitReorder(true)');
    expect(b).toContain('acknowledgeSubscriptionDuplicate: true');
    // ack はサーバ送信の body に載る位置 (confirm 済みフラグの分岐内) — 順序で固定
    expect(b.indexOf('acknowledgeSubscriptionDuplicate: true')).toBeLessThan(b.indexOf('await res.json()'));
  });
});
