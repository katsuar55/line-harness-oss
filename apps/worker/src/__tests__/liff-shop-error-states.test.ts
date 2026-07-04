/**
 * ストアタブ error/empty 状態 (2026-07-04 実機検証フィードバック):
 *
 * loadShopData() が API 失敗を catch {} で握りつぶし、products/orders カードに
 * else 分岐が無いため skeleton が永久固着していた (Katsu 実機スクショで発覚)。
 * fulfillments はエラーでも「配送情報はありません」と表示され、失敗が空データに化けていた。
 *
 * 修正仕様:
 *   - error と empty を区別: 失敗時は shopErrorCard (再試行 CTA)、空は説明つき空状態
 *   - idToken 失効 (401 'Invalid or expired ID token') はセッション切れとして再読み込み誘導
 *   - retryShopData() は skeleton を戻してから loadShopData() を再実行
 *   - demo モード (isDemo) では demo 描画を上書きしない
 *
 * liff-pages.ts は inline template-literal のため source 静的検査で担保する
 * (既存 liff-onboarding.test.ts / liff-a11y.test.ts と同流儀)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

// loadShopData と補助関数のブロックを抽出 (shopErrorCard 定義〜loadShopData 本体の終端まで)
const block = pages.match(/function shopAuthExpired[\s\S]*?async function loadShopData\(\) \{[\s\S]*?\n\}/);

describe('ストアタブ error/empty 状態 — 静的構造', () => {
  it('shopAuthExpired / shopErrorCard / retryShopData / loadShopData が定義されている', () => {
    expect(block).not.toBeNull();
    expect(pages).toContain('function shopAuthExpired(');
    expect(pages).toContain('function shopErrorCard(');
    expect(pages).toContain('function retryShopData(');
  });

  it('API 失敗時に error card (再試行 CTA) を出す — 握りつぶし禁止', () => {
    const b = block![0];
    expect(b).toContain('shopErrorCard(');
    expect(pages).toContain('読み込みに失敗しました');
    expect(pages).toContain('onclick="retryShopData()"');
    expect(pages).toContain('再試行');
  });

  it('idToken 失効はセッション切れとして再読み込みを誘導する (HTTP 401 判定)', () => {
    // 文字列 sniffing でなく api()/apiGet() が透過する HTTP status で判定する
    // (middleware の 401 は 'Invalid or expired ID token' と 'Authentication required...' の
    //  2 変種があり、どちらもセッション切れ扱いが正しい。文言変更にも壊れない)
    expect(pages).toMatch(/function shopAuthExpired[\s\S]{0,160}status === 401/);
    expect(pages).not.toMatch(/shopAuthExpired[\s\S]{0,200}indexOf\('token'\)/);
    expect(pages).toContain('セッションの有効期限が切れました');
    expect(pages).toMatch(/セッションの有効期限が切れました[\s\S]{0,400}location\.reload\(\)/);
  });

  it('api()/apiGet() は HTTP status を透過する (auth 判定の基盤)', () => {
    const matches = pages.match(/json\.status = res\.status/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2); // api と apiGet の両方
  });

  it('products が空のとき skeleton でなく説明つき空状態を出す (else 分岐が存在する)', () => {
    const b = block![0];
    expect(b).toContain('商品情報を準備中です');
  });

  it('orders/fulfillments の「空」文言は維持しつつ、エラー時とは区別される', () => {
    const b = block![0];
    expect(b).toContain('まだ注文がありません');
    expect(b).toContain('配送情報はありません');
    // fulfillments 失敗時は空文言でなく shopErrorCard に倒す
    expect(b).toMatch(/fulfillments[\s\S]*shopErrorCard\(fel/);
  });

  it('retryShopData は skeleton を戻してから loadShopData を再実行する', () => {
    const retry = pages.match(/function retryShopData\(\) \{[\s\S]*?\n\}/);
    expect(retry).not.toBeNull();
    expect(retry![0]).toContain('skeleton');
    expect(retry![0]).toContain('loadShopData()');
  });

  it('demo モードでは demo 描画を上書きしない (isDemo ガード)', () => {
    const b = block![0];
    expect(b).toMatch(/if \(isDemo\) return;/);
  });

  it('auth 失効時は fulfillments への無駄撃ちをしない (早期 return)', () => {
    const b = block![0];
    expect(b).toMatch(/shopErrorCard\(fel, true\); return;/);
  });

  it('esbuild backtick trap: 追加ブロックに backtick を含まない', () => {
    expect(block![0]).not.toContain('`');
  });
});
