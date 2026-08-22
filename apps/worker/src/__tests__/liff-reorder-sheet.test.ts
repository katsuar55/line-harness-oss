/**
 * 再注文シート (2026-07-30 オーナー指示):
 * 「この注文を再注文」→ 最少タップで注文完了へ。シートで選ぶのは
 * 「配送方法 (宅配便/ネコポス)」「お届け日時」の2つだけ (ティファニーブルー #0ABAB5)。
 * 変更系 (送り先/注文内容/支払い方法) はグレーの脇役ボタンで、ほとんどの人はスルーできる。
 *
 * inline template-literal のため source 静的検査 (既存 liff-* テストと同流儀)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

/** top-level function のブロックを抽出 (行頭 `}` で終端) */
function fnBlock(name: string): string {
  const m = pages.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  expect(m, name + ' が定義されている').not.toBeNull();
  return m![0];
}

describe('再注文シート — 最少タップのリピート注文', () => {
  it('「この注文を再注文」はシートを開く (即 Draft Order 作成には行かない)', () => {
    const b = fnBlock('reorderFromOrder');
    expect(b).toContain('openReorderSheet()');
    expect(b).not.toContain('/api/liff/reorder/create');
  });

  it('シートの選択肢は 配送方法 + お届け日時 の2つだけ / 既定は宅配便 + 指定なし (追加タップ0)', () => {
    expect(pages).toMatch(/data-ship="takkyubin"[^>]*class="ros-seg-btn is-on"/);
    expect(pages).toMatch(/data-ship="nekopos"/);
    expect(fnBlock('openReorderSheet')).toMatch(/rosShip = 'takkyubin'/);
    // 時間帯は固定語彙 (サーバー側 DELIVERY_TIMES と一致)
    for (const slot of ['午前中', '14〜16時', '16〜18時', '18〜20時', '19〜21時']) {
      expect(pages).toContain('<option>' + slot + '</option>');
    }
  });

  it('ネコポス選択で日時指定を無効化 + 理由を表示 (ポスト投函)', () => {
    const b = fnBlock('rosApplyShip');
    expect(b).toMatch(/is-disabled/);
    expect(b).toMatch(/ros-nekopos-note/);
    expect(pages).toContain('ネコポスはポスト投函のため、お届け日時の指定はできません');
  });

  it('主役ボタンはティファニーブルー系 (§7-1 AA 準拠の #0d827d = 白 4.66:1) / 変更系3つは第3階層の淡ティールチップ (ros-sub)', () => {
    expect(pages).toMatch(/\.ros-seg-btn\.is-on\{[^}]*#0d827d/);
    expect(pages).toMatch(/\.ros-primary\{[^}]*#0d827d/);
    // 2026-08-22 Katsu 指示: 主役2つ (primary / 配送方法セグメント) より静かに、
    // 素の灰チップよりは「押せる」と分かる第3階層。輪郭 + ティール文字で観測する
    const subs = pages.match(/class="ros-sub"/g) ?? [];
    expect(subs.length).toBe(3);
    expect(pages).toMatch(/\.ros-sub\{[^}]*border:1\.5px solid #bfe8e3/);
    expect(pages).toMatch(/\.ros-sub\{[^}]*color:#0f766e/);
    expect(pages).toMatch(/送り先を<br>変更する/);
    expect(pages).toMatch(/注文内容を<br>変更する/);
    expect(pages).toMatch(/支払い方法を<br>変更する/);
  });

  it('サマリの商品名・金額は太字強調 (2026-08-22 Katsu 指示: 確認の意味も込め可読性高く)', () => {
    const b = fnBlock('openReorderSheet');
    expect(b).toContain("className = 'ros-sum-item'");
    expect(b).toContain("className = 'ros-sum-price'");
    // 金額は商品名より一回り大きい太字 + ディープティファニー (AA 準拠 #0d827d)
    expect(pages).toMatch(/\.ros-sum-item\{[^}]*font-weight:700[^}]*font-size:14px/);
    expect(pages).toMatch(/\.ros-sum-price\{[^}]*font-weight:800[^}]*font-size:16px[^}]*color:#0d827d/);
  });

  it('送り先/支払いの変更もチェックアウトへの最短経路 + 案内トースト (行き止まりを作らない)', () => {
    expect(pages).toMatch(/onclick="submitReorder\('address'\)"/);
    expect(pages).toMatch(/onclick="submitReorder\('payment'\)"/);
    const b = fnBlock('submitReorder');
    expect(b).toContain('お届け先は次の画面');
    expect(b).toContain('お支払い方法は次の画面');
  });

  it('注文内容の変更は前回内容入りカート permalink へ (variant_id:数量)', () => {
    const b = fnBlock('rosEditItems');
    expect(b).toMatch(/naturism-diet\.com\/cart\//);
    expect(b).toMatch(/variant_id/);
  });

  it('submit は shippingMethod + (ネコポス以外のみ) deliveryDate/deliveryTime を送る', () => {
    const b = fnBlock('submitReorder');
    expect(b).toMatch(/shippingMethod: rosShip/);
    expect(b).toMatch(/rosShip !== 'nekopos'/);
    expect(b).toMatch(/deliveryDate/);
    expect(b).toMatch(/deliveryTime/);
  });

  it('サマリ/動的値は textContent / createTextNode で反映 (HTML 系 sink 不使用 = XSS ガード)', () => {
    const b = fnBlock('openReorderSheet');
    expect(b).toMatch(/sum\.textContent = ''/);
    // 🚨 採点R2 HIGH: 商品名 1 値だけの固定だと、注文番号・金額を insertAdjacentHTML へ
    // 置き換える変異が SURVIVED した (実測)。動的値 3 つを**個別に**安全な sink へ固定する
    expect(b).toMatch(/createTextNode\('前回のご注文 #' \+ rosOrder\.orderNumber/);
    expect(b).toMatch(/itemEl\.textContent = label/);
    expect(b).toMatch(/priceEl\.textContent = '¥' \+ Number\(rosOrder\.totalPrice\)/);
    // blacklist も innerHTML 1 語では足りない — HTML 文字列を解釈する sink を面で塞ぐ
    expect(b).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|setHTMLUnsafe|document\.write/);
  });

  it('A案 (2026-08-22): reused 応答は専用トーストで「さきほどのページ + 内容は作成時のまま」を明示する', () => {
    const b = fnBlock('submitReorder');
    expect(b).toMatch(/res\.data\.reused\) showToast\('さきほど作成したご注文ページを開きます/);
    expect(b).toContain('内容は作成時のままです');
    // reused 判定は focus トーストより先 (「お届け先は次の画面で…」と嘘をつかない)
    expect(b.indexOf('res.data.reused')).toBeLessThan(b.indexOf("focus === 'address'"));
  });

  it('二重送信ガード + ボタン状態の復帰', () => {
    const b = fnBlock('submitReorder');
    expect(b).toMatch(/if \(!rosOrder \|\| rosSubmitting\) return;/);
    expect(b).toMatch(/rosSubmitting = true/);
    expect(b).toMatch(/rosSubmitting = false/);
  });

  it('esbuild backtick trap: 追加ブロックに backtick を含まない', () => {
    for (const fn of ['reorderFromOrder', 'openReorderSheet', 'closeReorderSheet', 'rosPickShip', 'rosApplyShip', 'rosEditItems', 'openExternalUrl', 'submitReorder']) {
      expect(fnBlock(fn), fn).not.toContain('`');
    }
  });
});
