/**
 * ブランドデザイン統一 (2026-07-07 Katsu 指示・実機FB第5弾):
 *
 * 「LINEの黄緑は封印」— #06C755/#059669/green系を naturism ティール (Dawn テーマ実測
 * トークン: primary #2fa8ad / deep #1d7d82 / ink #052422 / line #e3ecec) に全域統一。
 * 方式 = brand skin レイヤー: Tailwind CDN は実行時に <head> 末尾へ注入されるため、
 * green/emerald 系ユーティリティを !important で上書き (markup/classList ロジック無改変)。
 * 例外 = 「LINEで送る」ボタン (LINE 機能そのもの) のみ #06C755 を維持。
 *
 * あわせて:
 *   - ヘッダーロゴを self-host PNG (/liff/brand-logo.png) に変更 — CDN の officialLOGO
 *     「SVG」は 1MB の PNG 埋込でモバイルに重すぎた (#185 の修正)
 *   - 全ボタン「柔らかく押し込む」触感 (button:active translateY+scale)
 *   - カードのコントラスト (白カード + #e3ecec 枠 + Dawn 影) / 入力欄はカードと差をつける
 *   - スクロール進捗バーの先端を 🌿 が走る (遊び心)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');
const logo = readFileSync(join(root, '..', 'routes', 'brand-logo.ts'), 'utf8');

describe('LINE黄緑の封印 (naturism ティール統一)', () => {
  it('#06C755 は「LINEで送る」ボタン (LINE機能) の 2 箇所のみ', () => {
    const all = pages.match(/#06C755/g) || [];
    expect(all.length).toBe(2);
    const lines = pages.split('\n').filter((l) => l.includes('#06C755'));
    for (const l of lines) {
      expect(l, 'LINE緑はLINEで送るボタンのみ許可: ' + l.slice(0, 120)).toContain('LINE');
    }
  });

  it('#059669 / rgba(6,199,85) / rgba(5,150,105) は全廃', () => {
    expect(pages).not.toContain('#059669');
    expect(pages).not.toContain('rgba(6,199,85');
    expect(pages).not.toContain('rgba(5,150,105');
  });

  it('ブランドトークン :root と AA 合格 solid の btn-primary (pill 形状)', () => {
    expect(pages).toMatch(/:root\{--brand:#2fa8ad;--brand-deep:#1d7d82/);
    // 2026-07-26 §7-1: 横グラデは明るい側 #2fa8ad が白文字 2.87:1 で AA 不成立 → solid 化。
    // 2026-08-11 VITAL INSTRUMENT: 縦グラデ var(--grad-btn) へ移行 (両端 #11837c 4.67:1 /
    // #0f766e 5.47:1 で AA 維持)。hex のピン留めは liff-sublink-fastpath.test.ts 側が担う。
    expect(pages).toMatch(/\.btn-primary\{background:var\(--grad-btn\);color:#fff/);
    expect(pages).not.toMatch(/\.btn-primary\{background:linear-gradient/);
    expect(pages).toMatch(/\.btn-primary\{[^}]*border-radius:999px !important/);
  });

  it('brand skin: green/emerald ユーティリティが !important でブランド実色に上書きされる', () => {
    expect(pages).toMatch(/\.text-green-500,\.text-green-600,\.text-emerald-600\{color:#1d7d82 !important\}/);
    // 2026-07-26 §7-1: この 2 ユーティリティは text-white と組で使う面があり、#2fa8ad は白文字 2.87:1 で
    // AA 不成立。塗り面は #115e59 (白 7.0:1) へ — btn-primary (#0f766e) と同色にすると
    // 非対話バッジと購入 CTA が同じ塗り・同じ pill で見分けられなくなるため 1 段暗くする。
    // 文字色・枠色の写像はティール基軸のまま。
    expect(pages).toMatch(/\.bg-green-500,\.bg-green-600\{background-color:#115e59 !important\}/);
    expect(pages).toMatch(/\.border-green-500,\.border-green-600\{border-color:#2fa8ad !important\}/);
    // variant (hover/active) も上書き — TS template literal では \\: が CSS の \: になる
    expect(pages).toContain('.hover\\\\:bg-green-100:hover');
    expect(pages).toContain('.active\\\\:bg-green-100:active');
  });

  it('tab-active / theme-color / 入力 focus / range / spinner / tour dot もティール', () => {
    // VITAL INSTRUMENT: 下線 → グラデの「レーザーレール」(ティール基軸は不変)
    expect(pages).toMatch(/\.tab-active\{color:#052422;font-weight:700;border-bottom:none;background:linear-gradient\(90deg,#2fa8ad,#1d7d82\)/);
    expect(pages).toContain('<meta name="theme-color" content="#2fa8ad">');
    expect(pages).toMatch(/input:focus[^}]*border-color:#2fa8ad/);
    expect(pages).toMatch(/accent-color:#2fa8ad/);
    expect(pages).toContain('border-top-color:#2fa8ad');
  });
});

describe('コントラストと触感', () => {
  it('カードは白 + ヘアライン枠 + ティール色相の影 (背景と同化しない)', () => {
    // VITAL INSTRUMENT: 枠は --hairline (#dfe9e9 = #e3ecec より 1 段締め)、影はティール色相
    expect(pages).toMatch(/\.card\{background:#ffffff;border-radius:20px;border:1px solid var\(--hairline\)/);
    expect(pages).toMatch(/--hairline:#dfe9e9/);
  });

  it('入力欄はカード内で差が出る (背景 #fbfdfd + 枠 #dbe9e9)', () => {
    expect(pages).toMatch(/input\[type="time"\][^}]*border:1\.5px solid #dbe9e9[^}]*background:#fbfdfd/);
  });

  it('全ボタン「柔らかく押し込む」触感 (translateY + scale) + reduced-motion では無効', () => {
    // 採点R1: onclick アンカー CTA にも押し込み触感を拡張 (a[onclick]:active)
    expect(pages).toMatch(/button:active,\.tap:active,label:active,a\[onclick\]:active\{transform:translateY\(1\.5px\) scale\(\.96\)\}/);
    expect(pages).toMatch(/prefers-reduced-motion:reduce\)[\s\S]{0,700}button:active[\s\S]{0,120}transform:none !important/);
  });

  it('個別 :active ルールも translateY を同梱 — 押し込み触感が全ボタンで統一 (review confirmed 2件)', () => {
    // VITAL INSTRUMENT: 全タップを scale(.96) に統一 (押し込み感の署名を 1 つに)
    expect(pages).toMatch(/\.mood-btn:active,\.skin-btn:active,\.bowel-btn:active\{transform:translateY\(1\.5px\) scale\(\.96\)\}/);
    expect(pages).toMatch(/\.meal-btn:active\{transform:translateY\(1\.5px\) scale\(\.96\)\}/);
    expect(pages).toMatch(/\.btn-primary:active\{transform:scale\(\.96\) translateY\(1\.5px\)/);
    // quiz 選択肢 active:scale-[0.98] は詳細度で global を打ち消すため専用 override (値は .96 に統一)
    expect(pages).toContain('.active\\\\:scale-\\\\[0\\\\.98\\\\]:active{transform:translateY(1.5px) scale(.96) !important}');
  });

  it('本文の基調色は ink #052422 (body + text-gray-800 skin)', () => {
    expect(pages).toMatch(/body\{[^}]*color:#052422\}/);
    expect(pages).toMatch(/\.text-gray-800\{color:#052422 !important\}/);
  });
});

describe('self-host ブランドロゴ', () => {
  it('brand-logo.ts に base64 PNG が同梱され、/liff/brand-logo.png route で配信される', () => {
    expect(logo).toContain('export const BRAND_LOGO_PNG_BASE64');
    expect(logo.length).toBeGreaterThan(10000);
    expect(pages).toContain("liffPages.get('/liff/brand-logo.png'");
    expect(pages).toMatch(/Cache-Control[^}]*max-age=604800/);
  });

  it('ヘッダーは /liff/brand-logo.png を参照し、CDN の 1MB officialLOGO 直参照を廃止', () => {
    expect(pages).toContain('src="/liff/brand-logo.png"');
    expect(pages).not.toContain('officialLOGO_800x267.svg');
    expect(pages).toContain('id="brand-fallback"'); // onerror fallback は維持
  });
});

describe('遊び心 (進捗バーの 🌿)', () => {
  it('#scroll-leaf が進捗に応じて translateX + rotate で走る', () => {
    expect(pages).toContain('<div id="scroll-leaf"');
    expect(pages).toMatch(/scroll-leaf[\s\S]{0,600}translateX\(/);
    expect(pages).toMatch(/prefers-reduced-motion:reduce\)[\s\S]{0,900}#scroll-progress,#scroll-leaf\{display:none\}/);
  });

  it('進捗バーはブランドグラデ (LINE緑を含まない)', () => {
    // 2026-07-07 コーラル挿し色: 終端を coral に (teal→coral のグラデ)
    expect(pages).toMatch(/#scroll-progress\{[^}]*linear-gradient\(90deg,#80c8cd,#2fa8ad,#ffb39c\)/);
  });
});
