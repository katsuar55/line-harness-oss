import { Hono } from 'hono';
import { translations as i18nData } from '@line-crm/shared';
import type { Env } from '../index.js';
import { BRAND_LOGO_PNG_BASE64 } from './brand-logo.js';
import { liffWatchdogScriptTag } from '../utils/liff-watchdog.js';

const liffPages = new Hono<Env>();

// 公式ブランドロゴ (self-host)。Shopify CDN の officialLOGO SVG は 1MB の PNG 埋込で
// モバイル初回表示に重すぎるため、抽出→トリム→72px 縮小した PNG を worker から配信する。
liffPages.get('/liff/brand-logo.png', (c) => {
  const bin = Uint8Array.from(atob(BRAND_LOGO_PNG_BASE64), (ch) => ch.charCodeAt(0));
  return c.body(bin, 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=604800, immutable',
  });
});

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * GET /liff/portal — LIFF マイページ SPA
 *
 * LIFF SDK で初期化 → IDトークン取得 → API呼び出し → セクション表示
 * Tailwind CSS CDN + LIFF SDK CDN を使用
 */
// 末尾スラッシュ付きリクエスト対応（LINE LIFF ブラウザ互換性）
const portalHandler = (c: { env: Env['Bindings']; html: (html: string) => Response }) => {
  const liffUrl = c.env.LIFF_URL || '';
  const workerUrl = c.env.WORKER_URL || '';
  const liffId = liffUrl.replace('https://liff.line.me/', '');
  // 紹介報酬 gate を client に注入 (実機FB第5弾): on のとき紹介カードが
  // 「お友だちが購入するとあなたにも¥500」訴求 + 承認済コピー A' に自動切替する。
  const referralRewardOn = c.env.REFERRAL_REWARD_ENABLED === 'true';
  // App Proxy 連携 (2026-07-29): gate on かつ storefront URL が https で妥当な時だけ
  // マイアカウントに連携カードを出す (URL は inline JS に埋め込むため形式を厳格に検証する)。
  const storefrontRaw = (c.env.SHOPIFY_STOREFRONT_URL || '').trim().replace(/\/+$/, '');
  const shopifyLinkUrl =
    c.env.APP_PROXY_LINK_ENABLED === 'true' && /^https:\/\/[A-Za-z0-9.-]+$/.test(storefrontRaw)
      ? storefrontRaw
      : null;
  return c.html(portalPage(liffId, workerUrl, referralRewardOn, shopifyLinkUrl));
};
liffPages.get('/liff/portal', portalHandler as never);
liffPages.get('/liff/portal/', portalHandler as never);

function portalPage(
  liffId: string,
  apiBase: string,
  referralRewardOn = false,
  shopifyLinkUrl: string | null = null,
): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#2fa8ad">
  <title>naturism 公式ポータル</title>
  <!-- 描画ブロッキングな外部 CDN への接続を前倒し (FCP 短縮) -->
  <link rel="preconnect" href="https://static.line-scdn.net" crossorigin>
  <link rel="dns-prefetch" href="https://cdn.tailwindcss.com">
  <link rel="dns-prefetch" href="https://cdn.jsdelivr.net">
  ${liffWatchdogScriptTag()}
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *{-webkit-tap-highlight-color:transparent}
    /* naturism ブランドトークン (Dawn テーマ実測: naturism-category.css / settings_data.json) */
    :root{--brand:#2fa8ad;--brand-deep:#1d7d82;--brand-soft:#eef7f7;--brand-tint:#dff0f0;--brand-line:#e3ecec;--ink:#052422;--muted:#66727d;--coral:#ffb39c;--coral-deep:#d9573d;--coral-ink:#b84a2e;--coral-soft:#fff3ec}
    body{font-family:'Noto Sans JP',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(165deg,#f2fafa 0%,#f8fafc 45%,#f3f7f8 100%);min-height:100vh;color:#052422}
    .tab-active{color:#1d7d82;border-bottom:2.5px solid #2fa8ad;font-weight:600}
    .tab-inactive{color:#475569;border-bottom:2.5px solid transparent}
    nav button{transition:color .2s,border-color .2s;white-space:nowrap}
    /* 60代可読性 (§7-1): gradient の明るい側 #2fa8ad は白文字で 2.87:1、中間 #269398 でも 3.68:1 と
       AA (4.5:1) に届かない。ラベルは 14px bold で大文字扱いにもならないため solid #0f766e (5.47:1) に統一する。
       #0f766e は Flex/メール面で既に使っている既存トークンなので新色は増えない。ブランドはティール基軸のまま。 */
    .btn-primary{background:#0f766e;color:#fff;border:none;border-radius:999px !important;letter-spacing:.02em;box-shadow:0 2px 8px rgba(15,118,110,.28);transition:transform .15s,box-shadow .15s}
    .btn-primary:active{transform:scale(0.95) translateY(1.5px);box-shadow:0 2px 6px rgba(29,125,130,.35)}
    /* 連携カード (magic-link 着地面) の 60代トークン (§7-2): 本文≥16px / 行間1.6 / タップ領域≥48px /
       日付・プランは 20px bold #0f766e。全 .btn-primary への min-height 一括適用は 40+ 箇所の
       レイアウト回帰を伴うため、本 PR が所有するこの面に限定する。 */
    #sublink-overlay{z-index:70}
    .sublink-card{padding:24px;line-height:1.6}
    .sublink-title{font-size:19px;font-weight:700;color:#052422;line-height:1.5}
    .sublink-plan{font-size:20px;font-weight:700;color:#0f766e;line-height:1.6}
    .sublink-body{font-size:16px;color:#3f4b55;line-height:1.6}
    /* 連携先の識別ヒント (マスク済メール)。 60代可読性を満たす 16px + AA コントラスト */
    .sublink-hint{font-size:16px;color:#0f766e;background:#effaf8;border:1px solid #bfe8e3;border-radius:12px;padding:10px 12px;line-height:1.6;word-break:break-all}
    /* link fixation 警告文。 このカードで最も読み落としてはいけない一文なので本文と同じ 16px */
    .sublink-note{font-size:16px;color:#4b5563;line-height:1.6}
    .sublink-btn{min-height:48px;font-size:16px;font-weight:700;width:100%;border-radius:14px !important}
    .sublink-sub{min-height:48px;font-size:16px;width:100%;color:#5b6670;background:transparent;border:none}
    .sublink-sk{height:14px;border-radius:7px;margin:10px auto}
    /* コーラル挿し色 (2026-07-07 Katsu FB: 三層設計 = ティール基調 / コーラル=感情・お得・アクション / ゴールド=プレミア。実測 pp-styles.css --color-coral) */
    /* コーラルは「淡ピーチ chip」が主軸 (2026-07-08 Katsu「濃すぎ・薄く」): 14px 白文字×コーラルは
       物理的に AA 不可 (#e8836a=2.66:1) なので白文字塗りを廃し、薄ピーチ地 + コーラル文字 + コーラル枠へ。
       艶コーラル #d9573d は大数字 (≥24px/太字 = 3:1 で足りる) 専用に隔離。#b84a2e は小文字 AA (白 5.18 / #fff3ec 4.75)。 */
    .btn-coral{background:#fff3ec;color:#b84a2e;border:1.5px solid #eaa588;border-radius:999px !important;font-weight:700;letter-spacing:.02em;box-shadow:0 2px 10px rgba(217,87,61,.18);transition:transform .15s,background .15s,box-shadow .15s}
    .btn-coral:active{transform:scale(0.95) translateY(1.5px);background:#ffe6db;box-shadow:0 1px 4px rgba(217,87,61,.24)}
    .text-coral{color:#b84a2e !important}
    .text-coral-lg{color:#d9573d !important}
    .chip-coral{background:#fff3ec;color:#b84a2e;border:1px solid #f0b49f}
    #quiz-progress-bar{background:linear-gradient(90deg,#E8835F,#ffb39c) !important}
    /* ===== 診断9問版 (本サイト SELF CHECK モーダルの意匠ミラー、2026-07-29) =====
       トークンは nx-lineup-v2.css 準拠: coral#E8835F / teal#2fa8ad / ink#182229 / muted#66727d / line#e3ecec */
    .nxq-eyebrow{display:block;font-size:11px;letter-spacing:.22em;font-weight:700;color:#E8835F}
    .nxq-eyebrow--result{color:#2fa8ad}
    .nxq-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
    .nxq-close{border:0;background:transparent;color:#66727d;font-size:17px;line-height:1;padding:4px 6px;cursor:pointer}
    .nxq-progress{height:5px;border-radius:99px;background:#ecf3f3;overflow:hidden;margin-bottom:16px}
    .nxq-progress span{display:block;height:100%;width:0;border-radius:99px;transition:width .45s cubic-bezier(.22,1,.36,1)}
    .nxq-sub{font-size:12px;color:#66727d;margin-bottom:4px;text-align:left}
    .nxq-q{font-size:16.5px;font-weight:700;color:#182229;margin-bottom:14px;line-height:1.6;text-align:left;min-height:2.6em}
    .nxq-opts{display:grid;gap:9px}
    .nxq-opt{display:flex;align-items:center;gap:10px;width:100%;min-height:52px;padding:12px 14px;border-radius:14px;border:1.5px solid #e3ecec;background:#fff;color:#182229;font-size:14px;font-weight:600;text-align:left;cursor:pointer;transition:transform .16s cubic-bezier(.22,1,.36,1),border-color .2s,background-color .2s}
    .nxq-opt b{flex:none;width:26px;height:26px;border-radius:50%;background:rgba(232,131,95,.12);color:#E8835F;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
    .nxq-opt:active{transform:scale(.97)}
    .nxq-opt.is-picked{border-color:#E8835F;background:#fdf6f2}
    .nxq-opt--rank b{min-width:38px;width:auto;height:24px;border-radius:99px;font-size:10.5px;padding:0 4px}
    .nxq-opt--rank b.is-empty{background:transparent;border:1.5px dashed rgba(31,38,46,.25)}
    .nxq-opt--rank.is-ranked{border-color:#E8835F;background:#fdf6f2}
    .nxq-opt--rank.is-ranked b{background:#E8835F;color:#fff}
    .nxq-rankfoot{display:flex;gap:9px;margin-top:13px}
    .nxq-rankreset{flex:none;border:1.5px solid #e3ecec;background:#fff;color:#66727d;border-radius:99px;padding:10px 16px;font-size:12.5px;font-weight:600;cursor:pointer;transition:color .2s,border-color .2s}
    .nxq-ranknext{flex:1;border:0;border-radius:99px;padding:10px 16px;font-size:13.5px;font-weight:700;color:#fff;cursor:pointer;background:linear-gradient(120deg,#E8835F,#f0987a);box-shadow:0 8px 20px rgba(232,131,95,.3);transition:opacity .2s,transform .2s,box-shadow .2s}
    .nxq-ranknext:disabled{opacity:.4;cursor:default;box-shadow:none}
    .nxq-back{margin-top:14px;background:none;border:none;color:#66727d;font-size:12px;cursor:pointer;text-decoration:underline}
    .nxq-rname{font-size:24px;font-weight:800;margin:4px 0 8px}
    .nxq-rname--blue{color:#109A93}
    .nxq-rname--pink{color:#DD6F8D}
    .nxq-rname--premium{color:#b8933f}
    .nxq-bars{display:grid;gap:10px;margin:14px 0 16px;text-align:left}
    .nxq-brow{display:grid;grid-template-columns:86px 1fr 42px;align-items:center;gap:10px}
    .nxq-blabel{font-size:12px;font-weight:700;color:#182229}
    .nxq-btrack{display:block;height:8px;border-radius:99px;background:#EFF2F1;overflow:hidden}
    .nxq-bfill{display:block;height:100%;width:0;border-radius:99px;transition:width .8s cubic-bezier(.22,1,.36,1)}
    .nxq-brow--blue .nxq-bfill{background:#109A93}
    .nxq-brow--pink .nxq-bfill{background:#DD6F8D}
    .nxq-brow--premium .nxq-bfill{background:#b8933f}
    .nxq-bval{font-size:12px;font-weight:700;color:#66727d;text-align:right;font-variant-numeric:tabular-nums}
    .nxq-rdesc{font-size:13.5px;color:#66727d;line-height:1.75;margin-bottom:16px}
    .nxq-rcta{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;min-height:48px;padding:12px 28px;border-radius:99px;font-size:15px;font-weight:700;color:#fff;background:linear-gradient(135deg,#2fa8ad,#1d7d82);box-shadow:0 8px 22px rgba(47,168,173,.35);text-decoration:none;transition:transform .25s cubic-bezier(.22,1,.36,1),box-shadow .25s}
    .nxq-rcta:active{transform:scale(.97)}
    @media(prefers-reduced-motion:reduce){.nxq-bfill,.nxq-progress span,.nxq-opt{transition:none}}
    /* ===== 再注文シート (2026-07-30) — ティファニーブルー系 =====
       ブランドのティファニーブルー原色は白文字 2.5:1 で §7-1 AA 不足のため、
       ディープティファニー #0d827d (白 4.66:1 ✓) へ写像 (btn-primary #0f766e と同系の解決) */
    #reorder-sheet .ros-panel{position:absolute;left:0;right:0;bottom:0;background:#fff;border-radius:24px 24px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom));box-shadow:0 -8px 32px rgba(0,0,0,.16);animation:rosUp .3s cubic-bezier(.22,1,.36,1);max-height:86vh;overflow-y:auto}
    @keyframes rosUp{from{transform:translateY(48px);opacity:0}to{transform:none;opacity:1}}
    .ros-label{font-size:12px;font-weight:700;color:#374151;margin:12px 0 6px}
    .ros-optional{font-weight:400;color:#94a3b8;margin-left:6px;font-size:11px}
    .ros-seg{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .ros-seg-btn{border:1.5px solid #cbd5e1;background:#fff;color:#475569;border-radius:14px;padding:11px 8px;font-size:14px;font-weight:700;transition:border-color .15s,background .15s,color .15s,box-shadow .15s}
    .ros-seg-btn .ros-seg-sub{display:block;font-size:10px;font-weight:400;color:#94a3b8;margin-top:2px}
    .ros-seg-btn.is-on{border-color:#0d827d;background:#0d827d;color:#fff;box-shadow:0 4px 14px rgba(13,130,125,.35)}
    .ros-seg-btn.is-on .ros-seg-sub{color:#fff}
    .ros-primary{display:block;width:100%;border:0;border-radius:999px;padding:14px;font-size:15px;font-weight:700;color:#fff;background:#0d827d;box-shadow:0 8px 22px rgba(13,130,125,.4);cursor:pointer;transition:transform .15s}
    .ros-primary:active{transform:scale(.97)}
    .ros-primary:disabled{opacity:.55}
    .ros-gray{border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;border-radius:12px;padding:10px 4px;font-size:11px;font-weight:600;line-height:1.5}
    #ros-datetime.is-disabled{opacity:.4;pointer-events:none}
    @media(prefers-reduced-motion:reduce){#reorder-sheet .ros-panel{animation:none}}
    .card{background:#ffffff;border-radius:20px;border:1px solid #e3ecec;box-shadow:0 2px 6px rgba(24,34,41,.05),0 12px 32px rgba(24,34,41,.06)}
    .skeleton{background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:shimmer 1.6s ease-in-out infinite;border-radius:8px}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .progress-bar{transition:width .6s cubic-bezier(.4,0,.2,1)}
    .streak-fire{animation:pulse 1s ease-in-out infinite alternate}
    @keyframes pulse{0%{transform:scale(1)}100%{transform:scale(1.12)}}
    .section{display:none;animation:fadeUp .38s cubic-bezier(.22,1,.36,1)}
    .section.active{display:block}
    @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    input[type="time"],input[type="date"],input[type="number"],input[type="text"],textarea,select{border-radius:12px;border:1.5px solid #dbe9e9;padding:10px 12px;font-size:14px;transition:border-color .2s,box-shadow .2s;background:#fbfdfd}
    input:focus,textarea:focus,select:focus{outline:none;border-color:#2fa8ad;box-shadow:0 0 0 3px rgba(47,168,173,.15)}
    input[type="range"]{height:6px;border-radius:3px;accent-color:#2fa8ad}
    .mood-btn,.skin-btn,.bowel-btn{transition:border-color .15s,background .15s,transform .1s}
    .mood-btn:active,.skin-btn:active,.bowel-btn:active{transform:translateY(1.5px) scale(0.95)}
    .gender-btn{transition:all .15s;border-radius:12px !important}
    #toast{backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:rgba(15,23,42,.85);font-weight:500;letter-spacing:.02em}
    #loading{background:linear-gradient(160deg,#f2fafa 0%,#f8fafc 40%,#faf5ff 100%)}
    .graph-period-btn{transition:all .15s}
    #survey-answer-modal>div{box-shadow:0 -4px 24px rgba(0,0,0,.08)}
    @media(hover:hover){.btn-primary:hover{box-shadow:0 4px 16px rgba(29,125,130,.25)}}
    /* Ambassador badge */
    /* §7-1: 10px 白文字を amber gradient (#fbbf24=1.67:1 / #f59e0b=2.15:1) に載せていたので solid #92400e
       (白 7.0:1) へ。 ゴールドの「特別感」は枠と影で残す (10px は large text の緩和が使えない)。 */
    .ambassador-badge{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:#92400e;color:#fff;border:1px solid #fbbf24;box-shadow:0 1px 4px rgba(146,64,14,.3);animation:badgePop .4s cubic-bezier(.34,1.56,.64,1)}
    @keyframes badgePop{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}
    /* Ambassador sparkle rank card */
    .rank-ambassador{position:relative;background:linear-gradient(135deg,rgba(251,191,36,.08) 0%,rgba(245,158,11,.04) 50%,rgba(255,255,255,.9) 100%) !important;border:1.5px solid rgba(251,191,36,.25) !important;overflow:hidden}
    .rank-ambassador::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:conic-gradient(from 0deg,transparent 0%,rgba(251,191,36,.06) 10%,transparent 20%,rgba(245,158,11,.04) 30%,transparent 40%);animation:sparkleRotate 8s linear infinite}
    @keyframes sparkleRotate{to{transform:rotate(360deg)}}
    .sparkle-dots{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;overflow:hidden}
    .sparkle-dot{position:absolute;width:4px;height:4px;border-radius:50%;background:radial-gradient(circle,#fbbf24,transparent);animation:sparkle 2s ease-in-out infinite}
    @keyframes sparkle{0%,100%{opacity:0;transform:scale(0)}50%{opacity:.7;transform:scale(1)}}
    /* 2026-07-07 uiux_feel: 先進性方針 — skeleton は波状に光る (stagger)、タップは明確に柔らかく */
    /* nth-child は display:none の隠しカード (welcome/friend-coupon 等) も数えて破綻するため、カード id で指定 */
    #tip-card .skeleton{animation-delay:.15s}
    #coupons-card .skeleton{animation-delay:.3s}
    #referral-card .skeleton{animation-delay:.45s}
    #orders-card .skeleton{animation-delay:.15s}
    #fulfillments-card .skeleton{animation-delay:.3s}
    #subscriptions-list .skeleton{animation-delay:.45s}
    #notif-prefs-list .skeleton{animation-delay:.15s}
    #faq-list .skeleton{animation-delay:.3s}
    .meal-btn:active{transform:translateY(1.5px) scale(0.95)}
    /* 2026-07-07 没入スクロール (Katsu 指示: 高級感×先進性・大胆に・軽量に) — 3D カード cascade + スクロール進捗 */
    #scroll-progress{position:fixed;top:0;left:0;width:100%;height:2.5px;z-index:60;background:linear-gradient(90deg,#80c8cd,#2fa8ad,#ffb39c);transform-origin:0 50%;transform:scaleX(0);pointer-events:none}
    #scroll-leaf{position:fixed;top:-1px;left:-4px;z-index:61;font-size:13px;line-height:1;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(29,125,130,.35))}
    .sr{opacity:0;transform:perspective(900px) translateY(34px) rotateX(7deg) scale(.97);will-change:transform,opacity}
    .sr-in{opacity:1;transform:perspective(900px) translateY(0) rotateX(0) scale(1);transition:transform .7s cubic-bezier(.22,1,.36,1),opacity .55s ease-out}
    .tab-strip{overflow-x:auto;scrollbar-width:none}
    .tab-strip::-webkit-scrollbar{display:none}
    /* ─ 友だち紹介ヒーロー (実機FB第5弾 2026-07-10: 「お得感を演出」— 動くグラデ枠 + シャイン + 弾む🎁) ─ */
    .ref-hero{position:relative;border-radius:20px;padding:2px;background:linear-gradient(120deg,#2fa8ad,#ffb39c,#d9573d,#2fa8ad);background-size:300% 300%;animation:refBorder 7s ease infinite}
    .ref-hero-inner{background:linear-gradient(160deg,#fffdfb,#fff5ec);border-radius:18px;padding:18px 16px;overflow:hidden;position:relative}
    .ref-hero-inner::after{content:'';position:absolute;top:0;left:-60%;width:40%;height:100%;background:linear-gradient(105deg,transparent,rgba(255,255,255,.6),transparent);transform:skewX(-20deg);animation:refShine 4.5s ease-in-out infinite;pointer-events:none}
    @keyframes refBorder{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
    @keyframes refShine{0%,55%{left:-60%}85%,100%{left:130%}}
    .ref-step{background:#fff;border:1px solid #f4c0ad;border-radius:12px;padding:8px 4px;text-align:center}
    .ref-500{font-size:36px;font-weight:800;color:#d9573d;line-height:1;letter-spacing:-.5px}
    @keyframes refPop{0%,100%{transform:scale(1) rotate(0)}50%{transform:scale(1.12) rotate(-6deg)}}
    .ref-gift{display:inline-block;animation:refPop 2.6s ease-in-out infinite;transform-origin:60% 60%}
    @media (prefers-reduced-motion: reduce){.ref-hero{animation:none}.ref-hero-inner::after{display:none}.ref-gift{animation:none}}
    /* ─ マイアカウント coach mark (採点R1: 旧「その他」ユーザーにアバター導線を一度だけ教える) ─ */
    #account-hint{position:fixed;top:56px;right:12px;z-index:55;background:#0f766e;color:#fff;font-size:11px;font-weight:700;padding:8px 12px;border-radius:12px;box-shadow:0 4px 14px rgba(15,118,110,.3)}
    #account-hint::before{content:'';position:absolute;top:-5px;right:18px;border:5px solid transparent;border-bottom-color:#0f766e;border-top:0}
    @keyframes avatarPulse{0%,100%{box-shadow:0 0 0 2px rgba(47,168,173,.5)}50%{box-shadow:0 0 0 7px rgba(47,168,173,.12)}}
    .avatar-pulse{animation:avatarPulse 1.8s ease-in-out infinite}
    @media (prefers-reduced-motion: reduce){.avatar-pulse{animation:none;box-shadow:0 0 0 2px rgba(47,168,173,.5)}}
    /* ─ brand skin (2026-07-07 Katsu 指示: LINE黄緑封印 → naturism ティール統一、Dawn 実測トークン) ─
       Tailwind CDN は実行時に <head> 末尾へ style を注入するため、green/emerald 系ユーティリティを
       !important でブランド実色に上書きする (markup と JS の classList ロジックは無改変で全域が変わる)。
       例外: 「LINEで送る」ボタン (LINE 機能そのもの) のみ LINE 緑を維持。 */
    .text-green-500,.text-green-600,.text-emerald-600{color:#1d7d82 !important}
    .text-green-700,.text-emerald-700{color:#17666a !important}
    .bg-green-50,.bg-emerald-50{background-color:#eef7f7 !important}
    .bg-green-100,.bg-emerald-100{background-color:#dff0f0 !important}
    /* §7-1: この 2 ユーティリティは text-white と組で使われる面が 7 箇所ある。 #2fa8ad は白文字 2.87:1 で
       AA 不成立 (btn-primary の gradient を廃したのと同じ理由) → #115e59 (白 7.58:1)。
       NOTE: #0f766e (btn-primary) との差は 1.39:1 しかないので、 これは**コントラスト是正であって
       「非対話バッジと購入 CTA の描き分け」ではない**。 塗りの濃さだけで役割を伝えるのは無理があるので、
       描き分けは形 (chip か pill か) の設計変更として別途扱う。 */
    .bg-green-500,.bg-green-600{background-color:#115e59 !important}
    .border-green-200{border-color:#cfe7e8 !important}
    .border-green-300,.border-emerald-300{border-color:#a8d8da !important}
    .border-green-400{border-color:#7cc6c9 !important}
    .border-green-500,.border-green-600{border-color:#2fa8ad !important}
    .from-emerald-100{--tw-gradient-from:#dff0f0 !important}
    .to-green-50{--tw-gradient-to:#eef7f7 !important}
    .hover\\:bg-green-50:hover{background-color:#eef7f7 !important}
    .hover\\:bg-green-100:hover,.hover\\:bg-emerald-100:hover{background-color:#dff0f0 !important}
    .active\\:bg-green-100:active,.active\\:bg-emerald-100:active{background-color:#d3ecec !important}
    .hover\\:border-green-400:hover{border-color:#7cc6c9 !important}
    .text-gray-800{color:#052422 !important}
    /* 全ボタン「柔らかく押し込む」触感 (個別定義 .btn-primary 等はそちらが優先される) */
    button,.tap{transition:transform .12s cubic-bezier(.22,1,.36,1)}
    button:active,.tap:active,label:active,a[onclick]:active{transform:translateY(1.5px) scale(0.97)}
    /* quiz 選択肢の active:scale-[0.98] は詳細度で global を打ち消すため、translateY を同梱して統一 (review HIGH) */
    .active\\:scale-\\[0\\.98\\]:active{transform:translateY(1.5px) scale(0.98) !important}
    @media(prefers-reduced-motion:reduce){.skeleton,.streak-fire,.ambassador-badge,.sparkle-dot,.rank-ambassador::before,.section,#quiz-result{animation:none !important}.btn-primary:active,.btn-coral:active,.meal-btn:active,.mood-btn:active,.skin-btn:active,.bowel-btn:active,button:active,.tap:active,label:active,a[onclick]:active{transform:none !important}.sr{opacity:1 !important;transform:none !important}.sr-in{transition:none !important}#scroll-progress,#scroll-leaf{display:none}}
  </style>
</head>
<body class="min-h-screen pb-20">

  <!-- スクロール進捗 (没入スクロール: ブランドグラデの細ライン + 先端を走る 🌿) -->
  <div id="scroll-progress" aria-hidden="true"></div>
  <div id="scroll-leaf" aria-hidden="true">🌿</div>

  <!-- Header -->
  <header class="sticky top-0 z-50" style="background:rgba(255,255,255,.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(0,0,0,.06)">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
      <!-- 公式ロゴ (オフィシャルサイトと同一の Shopify CDN SVG。テーマ更新等で URL が変わったら onerror fallback) -->
      <h1 class="flex items-center" style="margin:0;line-height:1">
        <img src="/liff/brand-logo.png" alt="naturism" width="129" height="24" style="height:24px;width:auto;display:block" onerror="this.style.display='none';var f=document.getElementById('brand-fallback');if(f)f.style.display='inline'">
        <span id="brand-fallback" class="text-lg font-bold" style="display:none;letter-spacing:0.02em;background:linear-gradient(135deg,#2fa8ad,#80c8cd);-webkit-background-clip:text;-webkit-text-fill-color:transparent">naturism</span>
      </h1>
      <div class="flex items-center gap-3">
        <div class="relative">
          <button id="lang-btn" onclick="toggleLangMenu()" class="text-base w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors" title="Language">&#x1F1EF;&#x1F1F5;</button>
          <div id="lang-menu" style="display:none;" class="absolute right-0 top-10 bg-white border border-gray-100 rounded-2xl shadow-xl py-1.5 z-50 min-w-[130px] overflow-hidden">
            <button onclick="setLanguage('ja')" class="block w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors">&#x1F1EF;&#x1F1F5; 日本語</button>
            <button onclick="setLanguage('en')" class="block w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors">&#x1F1FA;&#x1F1F8; English</button>
            <button onclick="setLanguage('ko')" class="block w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors">&#x1F1F0;&#x1F1F7; 한국어</button>
            <button onclick="setLanguage('zh')" class="block w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors">&#x1F1E8;&#x1F1F3; 中文</button>
            <button onclick="setLanguage('th')" class="block w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors">&#x1F1F9;&#x1F1ED; ไทย</button>
          </div>
        </div>
        <!-- 4タブ再設計: アバターをタップ → マイアカウント (プロフィール/設定/サポート)。
             採点R1: 旧・装飾 div と同見た目ではタップ可能に見えない → ティールの halo + サイズを言語ボタンに揃える -->
        <button id="user-avatar" onclick="switchTab('account')" aria-label="マイアカウント" class="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-100 to-green-50 shadow-sm overflow-hidden flex items-center justify-center text-sm" style="padding:0;cursor:pointer;box-shadow:0 0 0 2px rgba(47,168,173,.45),0 1px 3px rgba(0,0,0,.08)">👤</button>
      </div>
    </div>
  </header>

  <!-- Tab Navigation -->
  <nav class="sticky top-[53px] z-40" style="background:rgba(255,255,255,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(0,0,0,.05)">
    <div class="max-w-lg mx-auto flex tab-strip" data-no-tab-swipe>
      <!-- 4タブ再設計 (実機FB第5弾): モバイルファーストで 6→4。行動が名前 (診断する/買う/記録する)。
           体調は「記録」に統合、旧「その他」は解体 (定期→Shop / 設定・サポート→マイアカウント=右上アバター)。
           data-i18n は旧キー (tab_mypage 等) の D1 訳が旧名で上書きしないよう新キーに変更。 -->
      <button onclick="switchTabTo('home')" id="tab-home" class="flex-1 py-3 text-xs text-center tab-active" data-i18n="tab_home">ホーム</button>
      <button onclick="switchTabTo('quiz')" id="tab-quiz" class="flex-1 py-3 text-xs text-center tab-inactive" data-i18n="tab_quiz">診断</button>
      <button onclick="switchTabTo('shop')" id="tab-shop" class="flex-1 py-3 text-xs text-center tab-inactive">Shop</button>
      <button onclick="switchTabTo('intake')" id="tab-intake" class="flex-1 py-3 text-xs text-center tab-inactive" data-i18n="tab_record">記録</button>
    </div>
  </nav>

  <main class="max-w-lg mx-auto px-4 py-4 space-y-4">

    <!-- ===== HOME Section ===== -->
    <div id="section-home" class="section active space-y-4">
      <!-- 友だち追加 welcome クーポン (発行済みのときのみ表示・期限カウントダウン付き) -->
      <div id="welcome-coupon-card" class="card p-4" style="display:none"></div>
      <!-- 紹介特典クーポン (referred=紹介された/referrer=紹介した の実クーポン、発行済みのときのみ表示) -->
      <div id="referral-coupon-card" class="card p-4" style="display:none"></div>
      <!-- LINE友だち限定クーポン (管理トグル ON 時のみ表示) -->
      <div id="friend-coupon-card" class="card p-4" style="display:none"></div>
      <!-- 次の一手 (第2波-⑥: 初回体験の埋没解消。文脈で1つだけ next action を提示・診断ファースト) -->
      <div id="next-move-card" class="card p-4" style="display:none">
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1">
            <p class="text-xs font-bold text-coral mb-1">はじめの一歩</p>
            <p class="text-sm font-bold text-gray-800 mb-1" id="next-move-title"></p>
            <p class="text-xs text-gray-500 mb-3" id="next-move-desc"></p>
            <a href="javascript:void(0)" id="next-move-cta" class="inline-block btn-primary py-2.5 px-4 rounded-xl text-sm font-bold"></a>
          </div>
          <button onclick="dismissNextMove()" aria-label="閉じる" class="text-gray-300 text-xl leading-none px-1">×</button>
        </div>
      </div>

      <!-- Rank Card -->
      <div id="rank-card" class="card p-4">
        <div class="skeleton h-24 rounded-lg"></div>
      </div>

      <!-- ── お得ゾーン (採点R1 HIGH: 定常ユーザーの fold もディールファーストに。
           保有クーポン → 紹介ヒーロー → ランキング を rank 直後へ、 バッジ/服用は retention flesh として後段) ── -->
      <!-- Coupons -->
      <div id="coupons-card" class="card p-4">
        <div class="skeleton h-16 rounded-lg"></div>
      </div>

      <!-- Referral + Sharing -->
      <div id="referral-card" class="card p-4">
        <div class="skeleton h-16 rounded-lg"></div>
      </div>

      <!-- Referral Ranking -->
      <div id="ranking-card" class="card p-4" style="display:none;"></div>

      <!-- Level + Badges (Phase 2: ゲーミフィケーション) -->
      <div id="badge-card" class="card p-4">
        <div class="flex items-center justify-between mb-3">
          <p class="text-sm font-bold text-gray-700">🏆 レベル & バッジ</p>
          <p id="badge-level-mini" class="text-xs font-bold text-green-600">Lv.<span id="badge-level-num">-</span></p>
        </div>
        <!-- 経験値バー -->
        <div class="mb-3">
          <div class="flex justify-between text-xs text-gray-500 mb-1">
            <span><span id="badge-score">0</span> pt</span>
            <span>次まで <span id="badge-pts-next">-</span> pt</span>
          </div>
          <div class="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div id="badge-progress-bar" class="h-full transition-all" style="width:0%;background:linear-gradient(90deg,#2fa8ad,#0f766e)"></div>
          </div>
        </div>
        <!-- バッジグリッド -->
        <div id="badge-grid" class="grid grid-cols-5 gap-2 mt-2">
          <div class="skeleton h-12 rounded-lg col-span-5"></div>
        </div>
        <p class="text-xs text-gray-400 text-center mt-3">タップしてバッジ詳細を見る</p>
      </div>

      <!-- Today's Intake (Phase 1: 能動pull型) -->
      <div id="intake-today-card" class="card p-4">
        <div class="flex items-center justify-between mb-3">
          <p class="text-sm font-bold text-gray-700">🌿 今日の服用</p>
          <p id="intake-streak-mini" class="text-xs text-gray-400">連続 <span id="intake-streak-num">-</span> 日</p>
        </div>
        <div class="grid grid-cols-3 gap-2">
          <button onclick="logMeal('breakfast')" id="meal-breakfast" data-meal="breakfast"
            class="meal-btn flex flex-col items-center justify-center py-3 rounded-2xl border-2 border-gray-200 bg-white transition-all">
            <span class="text-2xl mb-1">☀️</span>
            <span class="text-xs font-bold text-gray-600">朝</span>
            <span class="meal-status text-lg mt-1">○</span>
          </button>
          <button onclick="logMeal('lunch')" id="meal-lunch" data-meal="lunch"
            class="meal-btn flex flex-col items-center justify-center py-3 rounded-2xl border-2 border-gray-200 bg-white transition-all">
            <span class="text-2xl mb-1">🌤</span>
            <span class="text-xs font-bold text-gray-600">昼</span>
            <span class="meal-status text-lg mt-1">○</span>
          </button>
          <button onclick="logMeal('dinner')" id="meal-dinner" data-meal="dinner"
            class="meal-btn flex flex-col items-center justify-center py-3 rounded-2xl border-2 border-gray-200 bg-white transition-all">
            <span class="text-2xl mb-1">🌙</span>
            <span class="text-xs font-bold text-gray-600">夜</span>
            <span class="meal-status text-lg mt-1">○</span>
          </button>
        </div>
        <p class="text-xs text-gray-400 text-center mt-2">タップして記録 (1日1回ずつ、押し忘れOK)</p>
      </div>

      <!-- Today's Tip -->
      <div id="tip-card" class="card p-4">
        <div class="skeleton h-16 rounded-lg"></div>
      </div>

      <!-- Ambassador Section (visible only for ambassadors) -->
      <div id="ambassador-section" style="display:none;">
        <div id="ambassador-status-card" class="card p-4"></div>
        <div id="ambassador-feedback-card" class="card p-4 mt-3">
          <p class="text-xs text-gray-500 font-bold mb-3">フィードバック送信</p>
          <div class="space-y-3">
            <div>
              <label class="text-xs text-gray-500">カテゴリ</label>
              <select id="fb-category" class="w-full mt-1 p-2 border rounded-lg text-sm bg-white">
                <option value="general">全般</option>
                <option value="product">商品について</option>
                <option value="service">サービスについて</option>
                <option value="suggestion">ご提案</option>
                <option value="other">その他</option>
              </select>
            </div>
            <div>
              <label class="text-xs text-gray-500">評価</label>
              <div class="flex gap-1 mt-1" id="fb-rating-stars">
                <button onclick="setFbRating(1)" data-star="1" class="text-2xl text-gray-300">&#x2B50;</button>
                <button onclick="setFbRating(2)" data-star="2" class="text-2xl text-gray-300">&#x2B50;</button>
                <button onclick="setFbRating(3)" data-star="3" class="text-2xl text-gray-300">&#x2B50;</button>
                <button onclick="setFbRating(4)" data-star="4" class="text-2xl text-gray-300">&#x2B50;</button>
                <button onclick="setFbRating(5)" data-star="5" class="text-2xl text-gray-300">&#x2B50;</button>
              </div>
            </div>
            <div>
              <label class="text-xs text-gray-500">内容</label>
              <textarea id="fb-content" rows="3" maxlength="2000" class="w-full mt-1 p-2.5 border rounded-xl text-sm" placeholder="商品の感想やご要望をお聞かせください..."></textarea>
            </div>
            <button onclick="submitFeedback()" id="fb-submit-btn" class="btn-primary w-full py-2.5 rounded-2xl text-xs font-bold shadow-md">送信する</button>
          </div>
        </div>
        <div id="ambassador-history-card" class="card p-4 mt-3">
          <p class="text-xs text-gray-500 font-bold mb-2">送信履歴</p>
          <div id="fb-history"></div>
        </div>
        <div id="ambassador-surveys-card" class="card p-4 mt-3" style="display:none;">
          <p class="text-xs text-gray-500 font-bold mb-3">&#x1F4CB; 未回答アンケート</p>
          <div id="pending-surveys"></div>
        </div>
        <div id="survey-answer-modal" data-no-tab-swipe style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:50;background:rgba(0,0,0,0.5);">
          <div style="position:absolute;bottom:0;left:0;right:0;max-height:85vh;overflow-y:auto;background:#fff;border-radius:24px 24px 0 0;padding:24px;">
            <div class="flex justify-between items-center mb-4">
              <p class="text-sm font-bold" id="survey-modal-title"></p>
              <button onclick="closeSurveyModal()" class="text-gray-400 text-xl">&times;</button>
            </div>
            <div id="survey-questions-container"></div>
            <button onclick="submitSurveyAnswers()" id="survey-submit-btn" class="btn-primary w-full py-3 rounded-2xl text-sm font-bold mt-4 shadow-lg">回答を送信</button>
          </div>
        </div>
      </div>

    </div>

    <!-- ===== INTAKE Section ===== -->
    <div id="section-intake" class="section space-y-4">
      <!-- Streak -->
      <div id="streak-card" class="card p-4 text-center">
        <div class="skeleton h-32 rounded-lg"></div>
      </div>
      <!-- Product Select -->
      <div class="card p-4">
        <p class="text-xs text-gray-500 font-bold mb-2">商品を選択</p>
        <div class="flex gap-2">
          <button onclick="selectProduct('Blue')" data-product="Blue" class="product-btn flex-1 py-2.5 rounded-xl text-xs border bg-blue-50 text-blue-700 font-bold border-blue-300 transition-all">💧 Blue</button>
          <button onclick="selectProduct('Pink')" data-product="Pink" class="product-btn flex-1 py-2.5 rounded-xl text-xs border transition-all">🌸 Pink</button>
          <button onclick="selectProduct('Premium')" data-product="Premium" class="product-btn flex-1 py-2.5 rounded-xl text-xs border transition-all">👑 Premium</button>
        </div>
      </div>
      <!-- Log Button -->
      <button onclick="logIntake()" id="intake-btn" class="btn-primary w-full py-4 rounded-2xl text-base font-bold shadow-lg" style="letter-spacing:.05em">
        ✨ 服用を記録する
      </button>
      <!-- Calendar View -->
      <div class="card p-4">
        <div class="flex items-center justify-between mb-3">
          <button onclick="calendarPrev()" class="text-gray-400 text-lg px-2">&lt;</button>
          <p class="text-sm font-bold text-gray-700" id="calendar-month"></p>
          <button onclick="calendarNext()" class="text-gray-400 text-lg px-2">&gt;</button>
        </div>
        <div class="grid grid-cols-7 gap-1 text-center text-xs" id="calendar-grid">
          <span class="text-gray-400">日</span><span class="text-gray-400">月</span><span class="text-gray-400">火</span>
          <span class="text-gray-400">水</span><span class="text-gray-400">木</span><span class="text-gray-400">金</span><span class="text-gray-400">土</span>
        </div>
        <div class="grid grid-cols-7 gap-1 text-center text-xs mt-1" id="calendar-days"></div>
      </div>
      <!-- Reminders (複数設定対応) -->
      <div class="card p-4">
        <div class="flex items-center justify-between mb-3">
          <div>
            <p class="text-sm font-bold text-gray-700">リマインド通知</p>
            <p class="text-xs text-gray-400">毎日LINEにお知らせ（最大5件）</p>
          </div>
          <button onclick="addReminderSlot()" class="text-xs font-bold text-emerald-600 border border-emerald-300 bg-emerald-50 px-3 py-1.5 rounded-xl transition-colors active:bg-emerald-100">＋ 追加</button>
        </div>
        <div id="reminders-list" class="space-y-2"></div>
      </div>
      <!-- 回遊: 服用記録の dead-end を解消。記録 → ランク進捗 / 会員特典購入へ繋ぐ (続けるほどおトク) -->
      <div class="card p-4">
        <p class="text-xs text-gray-500 font-bold mb-2">続けるほど、おトク 🌿</p>
        <div class="grid grid-cols-2 gap-2">
          <button onclick="switchTabTo('home')" class="flex items-center justify-center gap-1 p-3 rounded-xl bg-green-50 text-green-700 text-xs font-bold hover:bg-green-100 transition-colors">🏆 ランク・バッジ</button>
          <a href="javascript:void(0)" onclick="openFeaturePage('/liff/my-rank')" class="flex items-center justify-center gap-1 p-3 rounded-xl bg-emerald-50 text-emerald-700 text-xs font-bold hover:bg-emerald-100 transition-colors">🛍 会員特典で購入</a>
        </div>
      </div>
      <!-- 栄養 & ウェルネス (4タブ再設計: home から移設 — 健康サポート機能を「記録」に集約) -->
      <div class="card p-4">
        <p class="text-sm font-bold text-gray-700 mb-1">🍽 栄養 & ウェルネス</p>
        <p class="text-xs text-gray-400 mb-3">毎日の食事を記録 → AIコーチがあなたに合うサプリ・食生活をご提案</p>
        <div class="grid grid-cols-3 gap-2">
          <a href="javascript:void(0)" onclick="openFeaturePage('/liff/food')" class="flex flex-col items-center gap-1 p-3 rounded-xl bg-emerald-50 text-emerald-700 text-xs font-bold hover:bg-emerald-100 transition-colors">
            <span class="text-xl">🍽</span> 食事記録
          </a>
          <a href="javascript:void(0)" onclick="openFeaturePage('/liff/coach')" class="flex flex-col items-center gap-1 p-3 rounded-xl bg-green-50 text-green-700 text-xs font-bold hover:bg-green-100 transition-colors">
            <span class="text-xl">🧠</span> AIコーチ
          </a>
          <a href="javascript:void(0)" onclick="openFeaturePage('/liff/food/graph')" class="flex flex-col items-center gap-1 p-3 rounded-xl bg-teal-50 text-teal-700 text-xs font-bold hover:bg-teal-100 transition-colors">
            <span class="text-xl">📊</span> グラフ
          </a>
        </div>
      </div>

      <!-- ── 体調記録 (4タブ再設計: 旧・体調タブを「記録」に統合。服用も体調も食事も"記録する"行為で括る) ── -->
      <div class="flex items-center gap-2 pt-2">
        <p class="text-sm font-bold text-gray-700">🩺 体調の記録</p>
      </div>
      <!-- Sub-tabs: Record / Graph -->
      <div class="flex bg-gray-100/80 rounded-2xl p-1">
        <button onclick="switchHealthView('record')" id="htab-record" class="flex-1 py-2 text-xs font-bold rounded-xl bg-white shadow-sm text-emerald-600 transition-all">📝 記録する</button>
        <button onclick="switchHealthView('graph')" id="htab-graph" class="flex-1 py-2 text-xs font-bold rounded-xl text-gray-400 transition-all">📊 グラフ</button>
      </div>

      <!-- ─── Record View ─── -->
      <div id="health-record-view">
        <!-- Today's Quick Input Card -->
        <div class="card p-4 space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-bold text-gray-700">今日の記録</h3>
            <span id="health-date-label" class="text-xs text-gray-400"></span>
          </div>

          <!-- Weight with stepper -->
          <div>
            <label class="text-xs text-gray-500 mb-1 block">体重</label>
            <div class="flex items-center gap-2">
              <button onclick="adjustWeight(-0.1)" class="w-10 h-10 rounded-full bg-gray-100 text-lg font-bold text-gray-600 active:bg-gray-200">−</button>
              <input type="number" id="weight-input" step="0.1" min="30" max="200" class="flex-1 text-center text-xl font-bold p-2 border rounded-xl" placeholder="--.-">
              <button onclick="adjustWeight(0.1)" class="w-10 h-10 rounded-full bg-gray-100 text-lg font-bold text-gray-600 active:bg-gray-200">＋</button>
              <span class="text-sm text-gray-400">kg</span>
            </div>
          </div>

          <!-- Mood (5-level face icons) -->
          <div>
            <label class="text-xs text-gray-500 mb-1 block">今日の気分</label>
            <div class="flex gap-2 justify-center">
              <button onclick="setMood('great')" data-mood="great" class="mood-btn flex flex-col items-center p-2 rounded-xl border-2 border-transparent transition-all">
                <span class="text-2xl">😆</span><span class="text-[10px] mt-0.5 text-gray-400">最高</span>
              </button>
              <button onclick="setMood('good')" data-mood="good" class="mood-btn flex flex-col items-center p-2 rounded-xl border-2 border-transparent transition-all">
                <span class="text-2xl">😊</span><span class="text-[10px] mt-0.5 text-gray-400">良い</span>
              </button>
              <button onclick="setMood('normal')" data-mood="normal" class="mood-btn flex flex-col items-center p-2 rounded-xl border-2 border-transparent transition-all">
                <span class="text-2xl">😐</span><span class="text-[10px] mt-0.5 text-gray-400">普通</span>
              </button>
              <button onclick="setMood('bad')" data-mood="bad" class="mood-btn flex flex-col items-center p-2 rounded-xl border-2 border-transparent transition-all">
                <span class="text-2xl">😞</span><span class="text-[10px] mt-0.5 text-gray-400">悪い</span>
              </button>
              <button onclick="setMood('terrible')" data-mood="terrible" class="mood-btn flex flex-col items-center p-2 rounded-xl border-2 border-transparent transition-all">
                <span class="text-2xl">😫</span><span class="text-[10px] mt-0.5 text-gray-400">最悪</span>
              </button>
            </div>
          </div>

          <!-- Skin condition (3-level) -->
          <div>
            <label class="text-xs text-gray-500 mb-1 block">肌の調子</label>
            <div class="flex gap-2">
              <button onclick="setSkin('good')" data-skin="good" class="skin-btn flex-1 py-2.5 rounded-xl text-sm border-2 border-transparent bg-gray-50 transition-all">✨ 良い</button>
              <button onclick="setSkin('normal')" data-skin="normal" class="skin-btn flex-1 py-2.5 rounded-xl text-sm border-2 border-transparent bg-gray-50 transition-all">😊 普通</button>
              <button onclick="setSkin('bad')" data-skin="bad" class="skin-btn flex-1 py-2.5 rounded-xl text-sm border-2 border-transparent bg-gray-50 transition-all">😢 荒れ気味</button>
            </div>
          </div>

          <!-- Bowel (cute icons + count) -->
          <div>
            <label class="text-xs text-gray-500 mb-1 block">お通じ</label>
            <div class="flex gap-3 items-end">
              <div class="flex gap-2 flex-1">
                <button onclick="setBowel('hard')" data-bowel="hard" class="bowel-btn flex-1 py-2.5 rounded-xl text-sm border-2 border-transparent bg-gray-50 transition-all">
                  <span class="block text-lg">🫘</span><span class="text-[10px] text-gray-400">コロコロ</span>
                </button>
                <button onclick="setBowel('normal')" data-bowel="normal" class="bowel-btn flex-1 py-2.5 rounded-xl text-sm border-2 border-transparent bg-gray-50 transition-all">
                  <span class="block text-lg">🍀</span><span class="text-[10px] text-gray-400">ふつう</span>
                </button>
                <button onclick="setBowel('soft')" data-bowel="soft" class="bowel-btn flex-1 py-2.5 rounded-xl text-sm border-2 border-transparent bg-gray-50 transition-all">
                  <span class="block text-lg">💧</span><span class="text-[10px] text-gray-400">ゆるい</span>
                </button>
              </div>
              <div class="flex items-center gap-1">
                <button onclick="adjustBowelCount(-1)" class="w-8 h-8 rounded-full bg-gray-100 text-sm font-bold text-gray-600">−</button>
                <span id="bowel-count-display" class="text-lg font-bold w-6 text-center">0</span>
                <button onclick="adjustBowelCount(1)" class="w-8 h-8 rounded-full bg-gray-100 text-sm font-bold text-gray-600">＋</button>
                <span class="text-xs text-gray-400">回</span>
              </div>
            </div>
          </div>

          <!-- Sleep (slider) -->
          <div>
            <label class="text-xs text-gray-500 mb-1 block">睡眠時間</label>
            <div class="flex items-center gap-3">
              <span class="text-xs text-gray-400">4h</span>
              <input type="range" id="sleep-slider" min="4" max="12" step="0.5" value="7" class="flex-1 accent-green-500" oninput="updateSleepDisplay()">
              <span class="text-xs text-gray-400">12h</span>
              <span id="sleep-display" class="text-sm font-bold text-green-600 w-12 text-center">7.0h</span>
            </div>
          </div>

          <!-- Note -->
          <div>
            <label class="text-xs text-gray-500 mb-1 block">メモ（任意）</label>
            <input type="text" id="health-note" maxlength="500" class="w-full p-2.5 border rounded-xl text-sm" placeholder="生理中、飲み会、旅行中 など...">
          </div>

          <!-- Save Button -->
          <button onclick="saveHealthLog()" class="btn-primary w-full py-3.5 rounded-2xl text-sm font-bold shadow-lg">
            ✏️ 記録を保存
          </button>
        </div>
      </div>

      <!-- ─── Graph View ─── -->
      <div id="health-graph-view" style="display:none;" class="space-y-4">
        <!-- Period Selector -->
        <div class="flex gap-1 bg-gray-100/80 rounded-2xl p-1">
          <button onclick="loadGraph(7)" class="graph-period-btn flex-1 py-1.5 text-xs rounded-xl" data-days="7">1W</button>
          <button onclick="loadGraph(30)" class="graph-period-btn flex-1 py-1.5 text-xs rounded-xl bg-white shadow-sm font-bold text-emerald-600" data-days="30">1M</button>
          <button onclick="loadGraph(90)" class="graph-period-btn flex-1 py-1.5 text-xs rounded-xl" data-days="90">3M</button>
          <button onclick="loadGraph(180)" class="graph-period-btn flex-1 py-1.5 text-xs rounded-xl" data-days="180">6M</button>
          <button onclick="loadGraph(365)" class="graph-period-btn flex-1 py-1.5 text-xs rounded-xl" data-days="365">1Y</button>
        </div>

        <!-- Weight Chart -->
        <div class="card p-4">
          <h4 class="text-xs font-bold text-gray-500 mb-2">体重の推移</h4>
          <div style="position:relative;height:200px;">
            <canvas id="weight-chart"></canvas>
          </div>
          <div id="weight-change" class="text-center mt-2"></div>
        </div>

        <!-- Condition Overview -->
        <div class="card p-4">
          <h4 class="text-xs font-bold text-gray-500 mb-2">コンディション推移</h4>
          <div style="position:relative;height:160px;">
            <canvas id="condition-chart"></canvas>
          </div>
        </div>

        <!-- Sleep Chart -->
        <div class="card p-4">
          <h4 class="text-xs font-bold text-gray-500 mb-2">睡眠時間</h4>
          <div style="position:relative;height:160px;">
            <canvas id="sleep-chart"></canvas>
          </div>
        </div>

        <!-- Summary Stats -->
        <div id="health-stats" class="card p-4">
          <div class="skeleton h-20 rounded-lg"></div>
        </div>
      </div>
    </div>

    <!-- ===== QUIZ Section ===== -->
    <div id="section-quiz" class="section space-y-4">
      <!-- Quiz Intro -->
      <div id="quiz-intro" class="card p-6 text-center">
        <!-- 商品ヒーロー動画 (💊 差し替え、2026-07-08): カード上端に full-bleed 16:9。R2 配信・poster 先出し・
             reduced-motion は poster 静止・診断タブ表示時のみ再生 (データ節約)。onerror で poster/絵文字 fallback。 -->
        <div class="-mt-6 -mx-6 mb-5 overflow-hidden rounded-t-[20px]" style="background:#fbf7f4">
          <video id="quiz-hero-video" class="w-full block" style="aspect-ratio:16/9;object-fit:cover;background:#fbf7f4"
            muted loop playsinline preload="metadata" aria-label="naturism 商品ラインナップ"
            src="${apiBase}/images/quiz-hero-v1.mp4"
            poster="${apiBase}/images/quiz-hero-poster-v1.jpg"
            onerror="this.style.display='none';var f=document.getElementById('quiz-hero-fallback');if(f)f.style.display='block'"></video>
          <div id="quiz-hero-fallback" style="display:none" class="py-6 text-5xl">💊</div>
        </div>
        <p class="nxq-eyebrow mb-2">SELF CHECK — 約30秒</p>
        <h2 class="text-lg font-bold text-gray-800 mb-2">あなたにぴったりの naturism は？</h2>
        <p class="text-sm text-gray-500 mb-5 leading-relaxed">9つの質問に答えるだけで、<br>最適な商品をご提案します。</p>
        <button onclick="startQuiz()" class="btn-coral px-10 py-3.5 rounded-2xl text-sm font-bold shadow-lg">診断スタート →</button>
      </div>

      <!-- Quiz Steps (hidden until started) — 本サイト SELF CHECK モーダルの意匠ミラー -->
      <div id="quiz-steps" class="card p-5" style="display:none;">
        <div class="nxq-head">
          <span class="nxq-eyebrow">SELF CHECK — 約30秒</span>
          <button onclick="cancelQuiz()" aria-label="診断を中断する" class="nxq-close">✕</button>
        </div>
        <div class="nxq-progress"><span id="quiz-progress-bar"></span></div>
        <p class="nxq-sub" id="quiz-progress">質問 1 / 9</p>
        <p class="nxq-q" id="quiz-question"></p>
        <div class="nxq-opts" id="quiz-options"></div>
        <button type="button" id="quiz-back" onclick="backQuiz()" class="nxq-back" style="display:none;">← ひとつ前へ戻る</button>
      </div>

      <!-- Quiz Result (hidden until complete) — YOUR BEST MATCH + 度数バー (本サイトミラー) -->
      <div id="quiz-result" style="display:none;">
        <div class="card p-6 text-center">
          <p class="nxq-eyebrow nxq-eyebrow--result mb-1">YOUR BEST MATCH</p>
          <h3 class="nxq-rname" id="result-name"></h3>
          <div class="nxq-bars" id="result-scores"></div>
          <p class="nxq-rdesc" id="result-reason"></p>
          <a id="result-compare-link" href="https://naturism-diet.com/pages/compare" target="_blank" rel="noopener" class="nxq-rcta">もっと詳しくみる <span aria-hidden="true">→</span></a>
          <div class="flex gap-2 mt-3">
            <a id="result-store-link" href="#" target="_blank" class="flex-1 btn-primary py-3 rounded-xl text-sm font-bold text-center block">ご購入はこちら ▶</a>
            <button onclick="retryQuiz()" class="flex-1 py-3 rounded-xl text-sm font-bold border border-gray-300 text-gray-600">もう一度診断する</button>
          </div>
          <!-- PR-A: クイズ結果から LINE会員特典 (マイランク) への in-CRM 導線。「LINEが一番お得」=一本化動機を結果画面で提示 -->
          <a href="javascript:void(0)" onclick="openFeaturePage('/liff/my-rank')" class="block mt-2 text-center text-xs text-green-700 bg-green-50 rounded-xl py-2.5 font-bold hover:bg-green-100 transition-colors">🎁 マイランク会員特典・おトクな購入方法を見る →</a>
        </div>
      </div>
    </div>

    <!-- ===== SHOP Section ===== -->
    <div id="section-shop" class="section space-y-4">
      <!-- Products -->
      <div id="products-card" class="card p-4">
        <div class="skeleton h-48 rounded-lg"></div>
      </div>
      <!-- Recent Orders -->
      <div id="orders-card" class="card p-4">
        <div class="skeleton h-24 rounded-lg"></div>
      </div>
      <!-- Fulfillments -->
      <div id="fulfillments-card" class="card p-4">
        <div class="skeleton h-24 rounded-lg"></div>
      </div>

      <!-- 再注文ショートカット (採点R1 HIGH: 旧実装は同タブへの full reload だった → 注文カードへスクロール。
           実際の再注文は各注文行の「🔄 この注文を再注文」= Draft Order ワンタップ) -->
      <div class="card p-4">
        <a href="javascript:void(0)" onclick="reorderShortcut()" class="tap flex items-center justify-center gap-2 p-3 rounded-xl bg-emerald-50 text-emerald-700 text-sm font-bold hover:bg-emerald-100 transition-colors">
          <span class="text-lg">🔄</span> 購入履歴から再注文する
        </a>
      </div>

      <!-- Subscription Reminders (4タブ再設計: 旧・その他タブから移設 = 定期は買い物の文脈) -->
      <div class="card p-4">
        <div class="flex items-center justify-between mb-3">
          <div>
            <p class="text-xs text-gray-500 font-bold">定期お届けリマインダー</p>
            <p class="text-xs text-gray-400">再購入のタイミングをLINEでお知らせ</p>
          </div>
          <button onclick="showAddSubscription()" class="text-xs font-bold text-emerald-600 border border-emerald-300 bg-emerald-50 px-3 py-1.5 rounded-xl transition-colors active:bg-emerald-100">＋ 追加</button>
        </div>
        <div id="subscriptions-list">
          <div class="skeleton h-16 rounded-lg"></div>
        </div>
        <!-- Add subscription modal -->
        <div id="sub-add-form" style="display:none" class="mt-3 p-3 bg-gray-50 rounded-xl space-y-3">
          <div>
            <label class="text-xs text-gray-500">商品名</label>
            <select id="sub-product" class="w-full mt-1 p-2 border rounded-lg text-sm bg-white">
              <option value="">選択してください</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-gray-500">お届けサイクル</label>
            <select id="sub-interval" class="w-full mt-1 p-2 border rounded-lg text-sm bg-white">
              <option value="15">15日ごと</option>
              <option value="30" selected>30日ごと</option>
              <option value="45">45日ごと</option>
              <option value="60">60日ごと</option>
              <option value="90">90日ごと</option>
            </select>
          </div>
          <button onclick="createSubscription()" class="btn-primary w-full py-2.5 rounded-2xl text-xs font-bold shadow-md">リマインダーを設定</button>
        </div>
      </div>
    </div>

    <!-- ===== ACCOUNT Section (マイアカウント: 右上アバターから開く。タブバーには出さない) ===== -->
    <div id="section-account" class="section space-y-4">
      <div class="flex items-center justify-between gap-2">
        <p class="text-base font-bold text-gray-800">👤 マイアカウント</p>
        <!-- 採点R1: タブバー外セクションからの明示的な戻り導線 -->
        <button onclick="switchTab('home')" class="tap text-xs font-bold text-teal-700 rounded-full px-3 py-1.5" style="border:1px solid #bfe8e3;background:#effaf8">← ホームへ戻る</button>
      </div>

      <!-- Profile (4タブ再設計: 旧マイページ下部から移設) -->
      <div id="profile-card" class="card p-4">
        <p class="text-xs text-gray-500 font-bold mb-3">プロフィール</p>
        <div class="space-y-3">
          <div>
            <label class="text-xs text-gray-500">性別</label>
            <div class="flex gap-2 mt-1">
              <button onclick="setGender('male')" data-gender="male" class="gender-btn flex-1 py-2 rounded-lg text-xs border">男性</button>
              <button onclick="setGender('female')" data-gender="female" class="gender-btn flex-1 py-2 rounded-lg text-xs border">女性</button>
              <button onclick="setGender('other')" data-gender="other" class="gender-btn flex-1 py-2 rounded-lg text-xs border">その他</button>
              <button onclick="setGender('unspecified')" data-gender="unspecified" class="gender-btn flex-1 py-2 rounded-lg text-xs border">未回答</button>
            </div>
          </div>
          <div>
            <label class="text-xs text-gray-500">誕生日</label>
            <input type="date" id="birthday-input" class="w-full mt-1 p-2 border rounded-lg text-sm" min="1920-01-01" max="2020-12-31">
          </div>
          <button onclick="saveProfile()" class="btn-primary w-full py-2.5 rounded-2xl text-xs font-bold shadow-md">保存</button>
        </div>
      </div>

      ${shopifyLinkUrl ? `<!-- Shopify 連携 (App Proxy, 2026-07-29): gate on + storefront URL 設定時のみ表示 -->
      <div class="card p-4" id="shopify-link-card" role="status" aria-live="polite">
        <p class="text-base font-bold text-gray-800 mb-1">🛍️ オンラインストアと連携</p>
        <p class="text-sm text-gray-600 mb-3">ストアにログインするだけで、会員特典やお届けのお知らせがLINEで受け取れるようになります。</p>
        <button onclick="openShopifyLinkPage()" class="tap btn-primary py-3 px-5 rounded-xl text-base font-bold">ストアにログインして連携 →</button>
        <p class="text-sm text-gray-600 mt-2">ストアのページが開きます。ログイン確認のあと、ボタンをタップするとLINEに戻ります。</p>
      </div>` : ''}

      <p class="text-xs text-gray-400 font-bold pt-1">⚙️ 設定</p>

      <!-- メール受信設定 (4タブ再設計: 旧ホームの opt-in カードを設定として移設。
           設定行なので dismiss (×) は廃止し常時表示 — 採点R1: 過去に×した人が永久に到達不能だった。
           意図 = LINE 単一依存のリスクヘッジ (ブロック/BAN時の連絡網) + email 配信基盤の獲得経路) -->
      <div id="opt-in-card" class="card p-4">
        <p class="text-sm font-bold text-gray-800 mb-1">📩 メール受信設定</p>
        <p class="text-xs text-gray-500 mb-3">限定クーポンや新商品のお知らせを、メールでもいち早くお届けします。</p>
        <a href="javascript:void(0)" onclick="openFeaturePage('/liff/opt-in')" class="tap inline-block btn-primary py-2.5 px-4 rounded-xl text-sm font-bold">受信設定を開く →</a>
      </div>

      <!-- Notification Settings -->
      <div class="card p-4">
        <p class="text-xs text-gray-500 font-bold mb-3">🔔 通知設定</p>
        <div class="space-y-3" id="notif-prefs-list">
          <div class="skeleton h-32 rounded-lg"></div>
        </div>
      </div>

      <p class="text-xs text-gray-400 font-bold pt-1">🛟 サポート</p>

      <!-- AIチャット (ポータル内で質問→回答が完結) -->
      <div class="card p-4" id="ai-chat-card">
        <p class="text-xs text-gray-500 font-bold mb-2">🤖 AIに質問する</p>
        <div id="ai-chat-log" class="space-y-2 mb-3" style="max-height:320px;overflow-y:auto"></div>
        <div class="flex items-center gap-2">
          <input id="ai-chat-input" type="text" maxlength="500" onkeydown="if(event.key==='Enter')sendAiChat()" placeholder="商品や使い方など、お気軽にどうぞ" class="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-green-400" />
          <button id="ai-chat-send" onclick="sendAiChat()" class="btn-primary px-4 py-2 rounded-xl text-sm font-bold">送信</button>
        </div>
        <p class="text-gray-400 mt-2" style="font-size:10px">AIによる自動回答です。内容の正確性を保証するものではありません。</p>
      </div>

      <!-- FAQ -->
      <div class="card p-4">
        <p class="text-xs text-gray-500 font-bold mb-3">よくあるご質問</p>
        <input id="faq-search" type="text" inputmode="search" oninput="onFaqSearch(this.value)" placeholder="キーワードで検索（例: 送料、解約、飲み方）" class="w-full mb-3 px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-green-400" />
        <div id="faq-cats" data-no-tab-swipe class="flex gap-2 overflow-x-auto pb-2 mb-1" style="display:none"></div>
        <div id="faq-list">
          <div class="skeleton h-24 rounded-lg"></div>
        </div>
        <div id="faq-empty" style="display:none" class="py-4 text-center">
          <p class="text-xs text-gray-400 mb-2">該当するFAQが見つかりませんでした</p>
          <button onclick="askAiFromFaq()" class="px-4 py-2 rounded-full bg-green-500 text-white text-xs font-bold">💬 AIに質問する</button>
        </div>
        <button onclick="askAiFromFaq()" class="w-full mt-3 py-2 text-xs text-green-600 font-bold">💬 解決しませんか？ AIに質問する</button>
      </div>

      <!-- Official Links -->
      <div class="card p-4">
        <p class="text-xs text-gray-500 font-bold mb-3">オフィシャルリンク</p>
        <div class="space-y-2">
          <a href="https://naturism.jp" target="_blank" class="tap flex items-center gap-3 p-3 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
            <span class="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center text-sm">🌿</span>
            <div class="flex-1"><p class="text-sm font-bold text-gray-800">公式サイト</p><p class="text-xs text-gray-400">naturism.jp</p></div>
            <span class="text-gray-300 text-sm">→</span>
          </a>
          <a href="https://xn-0ckn0a9fxa4a.myshopify.com" target="_blank" class="tap flex items-center gap-3 p-3 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
            <span class="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-sm">🛒</span>
            <div class="flex-1"><p class="text-sm font-bold text-gray-800">オンラインストア</p><p class="text-xs text-gray-400">Shopify公式ストア</p></div>
            <span class="text-gray-300 text-sm">→</span>
          </a>
          <a href="https://www.instagram.com/naturism_supplement/" target="_blank" class="tap flex items-center gap-3 p-3 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
            <span class="w-8 h-8 rounded-full bg-pink-100 flex items-center justify-center text-sm">📸</span>
            <div class="flex-1"><p class="text-sm font-bold text-gray-800">Instagram</p><p class="text-xs text-gray-400">@naturism_supplement</p></div>
            <span class="text-gray-300 text-sm">→</span>
          </a>
          <a href="https://x.com/naturism_diet" target="_blank" class="tap flex items-center gap-3 p-3 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
            <span class="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-sm">𝕏</span>
            <div class="flex-1"><p class="text-sm font-bold text-gray-800">X (Twitter)</p><p class="text-xs text-gray-400">@naturism_diet</p></div>
            <span class="text-gray-300 text-sm">→</span>
          </a>
          <a href="https://www.tiktok.com/@naturism_official" target="_blank" class="tap flex items-center gap-3 p-3 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
            <span class="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-sm text-white">♪</span>
            <div class="flex-1"><p class="text-sm font-bold text-gray-800">TikTok</p><p class="text-xs text-gray-400">@naturism_official</p></div>
            <span class="text-gray-300 text-sm">→</span>
          </a>
          <a href="https://www.youtube.com/@naturism-diet" target="_blank" class="tap flex items-center gap-3 p-3 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
            <span class="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center text-sm">▶</span>
            <div class="flex-1"><p class="text-sm font-bold text-gray-800">YouTube</p><p class="text-xs text-gray-400">@naturism-diet</p></div>
            <span class="text-gray-300 text-sm">→</span>
          </a>
        </div>
      </div>

      <!-- App Info -->
      <div class="text-center py-4">
        <p class="text-xs text-gray-400">naturism LINE CRM</p>
        <p class="text-xs text-gray-300">Powered by LINE Harness OSS</p>
      </div>
    </div>

  </main>

  <!-- 再注文シート (2026-07-30): 前回と同じ内容で最少タップ再注文。
       迷いポイントを「配送方法」「お届け日時」の2つに絞り、住所・支払いは
       Shopify チェックアウト (前回情報が事前入力) に委ねる。 -->
  <div id="reorder-sheet" data-no-tab-swipe style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:60;background:rgba(15,23,42,.45)" role="dialog" aria-modal="true" aria-label="再注文" onclick="if(event.target===this)closeReorderSheet()">
    <div class="ros-panel">
      <div class="flex items-center justify-between mb-1">
        <p class="text-base font-bold text-gray-800">🔄 再注文</p>
        <button onclick="closeReorderSheet()" aria-label="閉じる" class="text-gray-400 text-lg leading-none px-2 py-1">✕</button>
      </div>
      <p class="text-xs text-gray-500 mb-2" id="ros-summary"></p>

      <p class="ros-label">配送方法</p>
      <div class="ros-seg" id="ros-ship">
        <button type="button" data-ship="takkyubin" onclick="rosPickShip('takkyubin')" class="ros-seg-btn is-on">宅配便<span class="ros-seg-sub">日時指定OK</span></button>
        <button type="button" data-ship="nekopos" onclick="rosPickShip('nekopos')" class="ros-seg-btn">ネコポス<span class="ros-seg-sub">ポスト投函</span></button>
      </div>

      <div id="ros-datetime">
        <p class="ros-label">お届け日時<span class="ros-optional">指定なしでもOK</span></p>
        <div class="flex gap-2">
          <input type="date" id="ros-date" class="flex-1" style="min-width:0">
          <select id="ros-time" class="flex-1" style="min-width:0">
            <option value="">時間帯の指定なし</option>
            <option>午前中</option>
            <option>14〜16時</option>
            <option>16〜18時</option>
            <option>18〜20時</option>
            <option>19〜21時</option>
          </select>
        </div>
      </div>
      <p id="ros-nekopos-note" style="display:none" class="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-2">ネコポスはポスト投函のため、お届け日時の指定はできません</p>

      <button id="ros-submit" onclick="submitReorder()" class="ros-primary mt-4">この内容で注文へ進む →</button>
      <p class="text-xs text-gray-400 text-center mt-2 mb-3">お届け先・お支払い方法は前回と同じなら、次の画面でそのまま進むだけでOKです</p>

      <div class="grid grid-cols-3 gap-2">
        <button onclick="submitReorder('address')" class="ros-gray">送り先を<br>変更する</button>
        <button onclick="rosEditItems()" class="ros-gray">注文内容を<br>変更する</button>
        <button onclick="submitReorder('payment')" class="ros-gray">支払い方法を<br>変更する</button>
      </div>
    </div>
  </div>

  <!-- Loading overlay -->
  <div id="loading" class="fixed inset-0 flex items-center justify-center z-50" style="background:linear-gradient(160deg,#f2fafa 0%,#f8fafc 40%,#faf5ff 100%)">
    <div class="text-center">
      <div class="w-12 h-12 rounded-full animate-spin mx-auto mb-4" style="border:3px solid #e2e8f0;border-top-color:#2fa8ad"></div>
      <p class="text-sm font-medium tracking-wide" style="color:#5b6670">読み込み中...</p>
    </div>
  </div>

  <!-- Toast -->
  <!-- z-index:70 = 再注文シート (60) の上にも出す (シート内のエラー通知が隠れない) -->
  <div id="toast" role="status" aria-live="polite" style="z-index:70" class="fixed bottom-24 left-1/2 -translate-x-1/2 text-white px-5 py-2.5 rounded-2xl text-sm shadow-xl opacity-0 transition-opacity pointer-events-none z-50"></div>

  <!-- Confetti overlay (採点R1: section-intake 内にあると home のワンタップ記録で紙吹雪が出なかった → body 直下へ) -->
  <div id="confetti-overlay" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:9999;"></div>

  <!-- 初回オンボーディングツアー (第2波-⑥: 初回起動のみ・診断ファースト・localStorage完結) -->
  <div id="onboarding-tour" data-no-tab-swipe role="dialog" aria-modal="true" aria-labelledby="tour-title" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:60;background:rgba(0,0,0,0.55);">
    <div style="position:absolute;bottom:0;left:0;right:0;max-height:88vh;overflow-y:auto;background:#fff;border-radius:24px 24px 0 0;padding:24px 24px 28px;">
      <div class="flex justify-between items-center mb-3">
        <div class="flex gap-1.5 items-center" id="tour-dots"></div>
        <button onclick="skipTour()" class="text-gray-400 text-xs">スキップ</button>
      </div>
      <div class="text-center py-3" id="tour-content">
        <div class="text-5xl mb-4" id="tour-emoji"></div>
        <p class="text-base font-bold text-gray-800 mb-2" id="tour-title"></p>
        <p class="text-sm text-gray-500 leading-relaxed px-2" id="tour-body"></p>
      </div>
      <button onclick="tourPrimary()" id="tour-primary-btn" class="btn-primary w-full py-3.5 rounded-2xl text-sm font-bold shadow-lg mt-4">つぎへ</button>
    </div>
  </div>

<script>
const LIFF_ID = '${escapeHtml(liffId)}';
const API_BASE = '${escapeHtml(apiBase)}';
const REFERRAL_REWARD_ON = ${referralRewardOn ? 'true' : 'false'};
let idToken = null;
let selectedCondition = null;

function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ─── LIFF ページ遷移 (reorder / delivery) ───
function openLiffPage(page) {
  var liffUrl = 'https://liff.line.me/' + LIFF_ID;
  window.location.href = liffUrl + '?page=' + encodeURIComponent(page);
}

// 独立した LIFF ページ (食事記録 /liff/food, AIコーチ /liff/coach, グラフ /liff/food/graph 等) へ遷移する。
// portal の openLiffPage が ?page= で portal 内タブへ deep-link するのに対し、こちらは worker 上の別ページへ
// 直接遷移する (これらは別ルートで独自に liff.init する)。demo プレビュー中は ?demo=1 を引き継ぐ。
function openFeaturePage(path) {
  window.location.href = API_BASE + path + (isDemoRequested() ? '?demo=1' : '');
}

// メール受信設定 (4タブ再設計でマイアカウント>設定へ移設): 設定行なので dismiss せず常時表示。
// 旧×の optin_dismissed キーは next-move (nm_optin) のスキップ判定でのみ引き続き参照される。
function initOptInCard() {
  try {
    var el = document.getElementById('opt-in-card');
    if (!el) return;
    el.style.display = 'block';
  } catch (e) { /* ignore */ }
}

// マイアカウント coach mark: 旧「その他」を知る既存ユーザー (ツアー済み) にだけ、
// アバター導線を一度だけ教える (localStorage 'account_hint_v1'、reduced-motion は静的リング)。
function initAccountHint() {
  try {
    if (lsGet('account_hint_v1') === '1') return;
    if (lsGet(ONBOARDING_TOUR_KEY) !== '1') { lsSet('account_hint_v1', '1'); return; } // 新規はツアーで学ぶ
    var av = document.getElementById('user-avatar');
    if (!av) return;
    av.classList.add('avatar-pulse');
    var tip = document.createElement('div');
    tip.id = 'account-hint';
    tip.textContent = '設定・サポートはこちら';
    document.body.appendChild(tip);
    var dismissed = false;
    function dismissHint() {
      if (dismissed) return; dismissed = true;
      lsSet('account_hint_v1', '1');
      av.classList.remove('avatar-pulse');
      if (tip.parentNode) tip.parentNode.removeChild(tip);
    }
    av.addEventListener('click', dismissHint, { once: true });
    setTimeout(dismissHint, 8000);
  } catch (e) { /* hint は非必須 */ }
}

// ─── 初回オンボーディング (第2波-⑥: 初回体験の埋没解消・診断ファースト・localStorage完結) ───
// tour = 初回起動のみの informational な案内 (localStorage 'onboarding_tour_v1_done')。
// next-move card = 文脈で1つだけ next action を提示 (localStorage milestone、新規 API/DB なし)。
var ONBOARDING_TOUR_KEY = 'onboarding_tour_v1_done';
var NEXT_MOVE_DISMISS_KEY = 'nextmove_dismissed';
var tourIndex = 0;

// 診断ファースト: 診断 → メール → 服用 の順で「まだ actioned でない最初の1つ」を提示。
// run() は既存の switchTab / openFeaturePage を再利用 (新規遷移先なし)。
var NEXT_MOVE_STEPS = [
  { key: 'nm_quiz', title: 'まずは30秒の無料診断', desc: 'あなたの食生活に合うサプリを見つけましょう。', cta: '診断してみる', run: function () { switchTab('quiz'); } },
  // key を v2 に上げているのは救済のため。 /liff/opt-in は 2026-05-17〜07-29 の 2.5 ヶ月間
  // script 打ち切りで全く動かず、「登録する」を押した人ほど (タップ時点で完了印が付くため)
  // 二度と案内されない状態になっていた。 key を変えることで、その層にもう一度だけ提示する。
  { key: 'nm_optin_v2', title: 'お得情報をメールでも', desc: '限定クーポンや新商品を、いち早くお届けします。', cta: '登録する', run: function () { openFeaturePage('/liff/opt-in'); } },
  { key: 'nm_intake', title: '今日の服用を記録', desc: '続けるほど習慣に。ワンタップで記録できます。', cta: '記録する', run: function () { switchTab('intake'); } }
];

var TOUR_STEPS = [
  { emoji: '🌿', title: 'naturism へようこそ', body: '毎日の食事にそっと寄り添う、インナーケア習慣。ポータルの使い方をかんたんにご案内します。' },
  { emoji: '🧪', title: 'まずは無料診断', body: '30秒の質問に答えるだけ。あなたにぴったりのサプリをご提案します。' },
  { emoji: '🏆', title: '続けるほど、おトク', body: 'ご購入を重ねるほど会員ランクが上がり、限定特典が受けられます。マイランクでいつでも確認できます。' },
  { emoji: '💬', title: '記録も相談も、ここで', body: '毎日の服用記録は「記録」タブから。気になることは、右上のアイコン → マイアカウントの「AIに質問」へ。困ったらいつでもどうぞ。' },
  { emoji: '👤', title: '設定は右上のアイコンから', body: 'プロフィール・通知設定・よくあるご質問は、右上のあなたのアイコンをタップすると開く「マイアカウント」にまとまっています。' }
];

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

// まだ actioned でない最初の next-move step を返す (無ければ null)。
// opt-in は既存の optin_dismissed も done とみなし二重提示を避ける。
function computeNextMove() {
  for (var i = 0; i < NEXT_MOVE_STEPS.length; i++) {
    var step = NEXT_MOVE_STEPS[i];
    if (lsGet(step.key) === '1') continue;
    if (step.key === 'nm_optin_v2' && lsGet('optin_dismissed') === '1') continue;
    return step;
  }
  return null;
}

function renderNextMove() {
  var el = document.getElementById('next-move-card');
  if (!el) return;
  if (lsGet(NEXT_MOVE_DISMISS_KEY) === '1') { el.style.display = 'none'; return; }
  var step = computeNextMove();
  if (!step) { el.style.display = 'none'; return; }
  var titleEl = document.getElementById('next-move-title');
  var descEl = document.getElementById('next-move-desc');
  var ctaEl = document.getElementById('next-move-cta');
  if (titleEl) titleEl.textContent = step.title;
  if (descEl) descEl.textContent = step.desc;
  if (ctaEl) {
    ctaEl.textContent = step.cta + ' →';
    ctaEl.onclick = function () {
      lsSet(step.key, '1');
      // タップ直後に再評価して次の一手へ進める (switchTab で home に戻っても stale 表示にしない)
      renderNextMove();
      step.run();
    };
  }
  el.style.display = 'block';
}

function dismissNextMove() {
  lsSet(NEXT_MOVE_DISMISS_KEY, '1');
  var el = document.getElementById('next-move-card');
  if (el) el.style.display = 'none';
}

function initOnboarding() {
  try {
    renderNextMove();
    // 連携カード表示中はツアーを出さない。 magic-link で来る 109 名はまさに「初回訪問かつ未連携」の
    // コホートなので、 ツアーが連携カードに重なると変換率をそのまま削る。 カードを閉じてから開始する。
    if (window.__subLinkPending) { window.__tourDeferred = true; return; }
    if (lsGet(ONBOARDING_TOUR_KEY) !== '1') { startTour(); }
  } catch (e) { /* onboarding は非必須。失敗しても本体に影響させない */ }
}

function startTour() {
  var overlay = document.getElementById('onboarding-tour');
  if (!overlay) return;
  tourIndex = 0;
  overlay.style.display = 'block';
  renderTourStep();
}

function renderTourStep() {
  var step = TOUR_STEPS[tourIndex];
  if (!step) { finishTour(); return; }
  var emojiEl = document.getElementById('tour-emoji');
  var titleEl = document.getElementById('tour-title');
  var bodyEl = document.getElementById('tour-body');
  var primaryEl = document.getElementById('tour-primary-btn');
  if (emojiEl) emojiEl.textContent = step.emoji;
  if (titleEl) titleEl.textContent = step.title;
  if (bodyEl) bodyEl.textContent = step.body;
  var isLast = tourIndex === TOUR_STEPS.length - 1;
  if (primaryEl) primaryEl.textContent = isLast ? 'はじめる' : 'つぎへ';
  renderTourDots();
}

function renderTourDots() {
  var dots = document.getElementById('tour-dots');
  if (!dots) return;
  var html = '';
  for (var i = 0; i < TOUR_STEPS.length; i++) {
    html += '<span style="width:7px;height:7px;border-radius:9999px;display:inline-block;background:' + (i === tourIndex ? '#2fa8ad' : '#d1d5db') + '"></span>';
  }
  dots.innerHTML = html;
}

// 主 CTA: 最後のステップなら完了、そうでなければ次のステップへ (スワイプと同じアニメ経路)。
function tourPrimary() {
  tourAdvance(1);
}

// dir: 1 = 次へ / -1 = 前へ。端は clamp (最終ページの「次」は完了)。
// 連打/連続フリックは tourAnimating で無視 (review MEDIUM: アニメの多重発火防止)
var tourAnimating = false;
function tourAdvance(dir) {
  if (tourAnimating) return;
  if (dir > 0) {
    if (tourIndex >= TOUR_STEPS.length - 1) { finishTour(); return; }
    tourIndex++;
  } else {
    if (tourIndex <= 0) return;
    tourIndex--;
  }
  animateTourStep(dir);
}

// ページがめくれるように: 現内容が方向へ流れ、次内容が反対側から入る
function animateTourStep(dir) {
  var content = document.getElementById('tour-content');
  if (!content || TAB_REDUCED_MOTION) { renderTourStep(); return; }
  tourAnimating = true;
  content.style.transition = 'transform 0.16s ease-in, opacity 0.16s ease-in';
  content.style.transform = 'translateX(' + (dir * -26) + 'px)';
  content.style.opacity = '0';
  setTimeout(function () {
    try {
      renderTourStep();
      content.style.transition = 'none';
      content.style.transform = 'translateX(' + (dir * 30) + 'px)';
      requestAnimationFrame(function () {
        content.style.transition = 'transform 0.26s cubic-bezier(0.22,1,0.36,1), opacity 0.26s ease-out';
        content.style.transform = 'translateX(0)';
        content.style.opacity = '1';
        setTimeout(function () {
          try { content.style.transition = ''; }
          finally { tourAnimating = false; }
        }, 300);
      });
    } catch (e) {
      tourAnimating = false;
    }
  }, 150);
}

// ツアーはフリックでも前後に動かせる (つぎへボタン併存)
function initTourSwipe() {
  var overlay = document.getElementById('onboarding-tour');
  if (!overlay) return;
  var sx = 0, sy = 0, tracking = false;
  overlay.addEventListener('touchstart', function (e) {
    tracking = false;
    if (e.touches.length !== 1) return;
    tracking = true;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  overlay.addEventListener('touchend', function (e) {
    if (!tracking) return;
    tracking = false;
    var t = e.changedTouches[0];
    if (!t) return;
    var dx = t.clientX - sx;
    var dy = t.clientY - sy;
    if (Math.abs(dx) < 48) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.4) return;
    tourAdvance(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function skipTour() { finishTour(); }

function finishTour() {
  lsSet(ONBOARDING_TOUR_KEY, '1');
  var overlay = document.getElementById('onboarding-tour');
  if (overlay) overlay.style.display = 'none';
  renderNextMove();
}

// ─── i18n ───
var I18N = ${JSON.stringify(i18nData)};
var currentLang = 'ja';
function i18n(key) { return (I18N[currentLang] && I18N[currentLang][key]) || (I18N.ja && I18N.ja[key]) || key; }
async function loadLanguage() {
  try {
    const { data } = await api('/api/liff/language');
    if (data && data.lang) { currentLang = data.lang; }
  } catch { /* default ja */ }
  updateI18nUI();
}
function setLanguage(lang) {
  currentLang = lang;
  api('/api/liff/language', {}).then(function(){}).catch(function(){});
  fetch(API_BASE + '/api/liff/language', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: 'Bearer ' + idToken } : {}) }, body: JSON.stringify({ lang: lang }) }).catch(function(){});
  updateI18nUI();
  document.getElementById('lang-menu').style.display = 'none';
}
function updateI18nUI() {
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    el.textContent = i18n(el.getAttribute('data-i18n'));
  });
  var langBtn = document.getElementById('lang-btn');
  if (langBtn) { var flags = { ja: '&#x1F1EF;&#x1F1F5;', en: '&#x1F1FA;&#x1F1F8;', ko: '&#x1F1F0;&#x1F1F7;', zh: '&#x1F1E8;&#x1F1F3;', th: '&#x1F1F9;&#x1F1ED;' }; langBtn.innerHTML = flags[currentLang] || '&#x1F310;'; }
}
function toggleLangMenu() {
  var menu = document.getElementById('lang-menu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

// ─── LIFF Init ───
let isDemo = false;

async function initLiff() {
  try {
    if (!LIFF_ID) throw new Error('LIFF_ID not configured');
    // ?slk= は liff.init() より前に退避する。 liff.login() は現在 URL へ戻ってくるが、 その URL は
    // 既に replaceState で slk を削ってあるため、 sessionStorage が唯一のトークン運搬手段になる。
    captureSubLinkToken();
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }
    // マイランク導線: リッチメニュー「マイランク」(hash #rank) は新・会員証ページ /liff/my-rank
    // (trailing-12mo ランク) に集約する canonical entry。LIFF init 後 = hash 復元済 (liff.state 経由でも OK)、
    // 重い portal data load の前に redirect することで画面 flash と二重ロードを最小化する。
    if (location.hash === '#rank' && new URLSearchParams(location.search).get('demo') !== '1') {
      location.replace('/liff/my-rank');
      return;
    }
    idToken = liff.getIDToken();
    if (!idToken) {
      // ID token が取得できない (失効/openid scope 欠如)。LINE の ID token は自動 refresh されないため
      // isLoggedIn()=true でも null になり得る。このまま進むと全 /api/liff/* が 401 になりホームの各カードが
      // skeleton 固着するので、demo に倒さず明示的に再読み込みを促す (2026-06-29 監査 rank5 HIGH)。
      showFatalError('ログインの有効期限が切れました。お手数ですが、トーク画面から開き直してください🌿');
      return;
    }
    // 定期購入 連携リンク (?slk=) の fast path。 idToken 代入の直後 = api() が 401 にならない最初の地点で、
    // かつ 12 loader の Promise.all / loadRank より前に撃つ (メールから来た未連携顧客に最速でカードを出す)。
    // #rank 早期分岐 (上) と同位置にはしない — そこは idToken 未代入なので全経路 401 → 全画面エラーになる。
    // await しない: 連携カードの表示がホームの読み込み完了に律速されないようにする。
    checkSubLinkParam();
    const profile = await liff.getProfile();
    if (profile.pictureUrl) {
      document.getElementById('user-avatar').innerHTML =
        '<img src="' + profile.pictureUrl + '" class="w-full h-full rounded-full object-cover" alt="">';
    }
    // 採点R3: リッチメニュー #delivery/#reorder 直行時、shop の fetch を home batch と並列に先行
    //   (旧: home 12 loader 完了後に直列で shop fetch = 体感2倍待ち)。switchTab 側は 1 回だけ skip。
    try {
      var earlyDest = (location.hash || '').replace('#', '') || (new URLSearchParams(location.search).get('page') || '');
      if (earlyDest === 'delivery' || earlyDest === 'reorder' || earlyDest === 'shop' || earlyDest === 'store') {
        window.__shopPrefetched = true;
        loadShopData(); loadSubscriptionsOnce();
      }
    } catch (e) { /* prefetch は最適化 — 失敗しても通常経路で読む */ }
    await Promise.all([loadLanguage(), loadAmbassador(), loadTip(), loadWelcomeCoupon(), loadReferralCoupon(), loadFriendCoupon(), loadCoupons(), loadReferralCard(), loadRanking(), loadProfile(), loadTodayIntake(), loadBadges()]);
    initOptInCard();
    initAccountHint();
    await loadRank();
    // 紹介リンク経由チェック（?ref=xxx）
    checkReferralParam();
    // ハッシュベースのディープリンク（リッチメニューから特定タブへ遷移）
    handleDeepLink();
    // タブ/ツアーのフリック操作 (2026-07-04 先進性方針)
    initTabSwipe();
    initTourSwipe();
    if (window.__fatalShown) return; // 401 検知で全画面エラー表示中 — loading 消しでエラーを隠さない
    document.getElementById('loading').style.display = 'none';
    // 没入スクロール起動 (loading 非表示後 = overlay 下で cascade が空撃ちされないように)
    initScrollReveal();
    // 第2波-⑥: 初回オンボーディング (loading を消してから = ツアーが loading の上に出ないように)
    initOnboarding();
  } catch (err) {
    console.error('LIFF init error:', err);
    // ?demo=1 を明示指定した時だけサンプル表示 (ブラウザプレビュー用)。
    // それ以外の本物の init/API 失敗では偽データ (偽クーポン/偽注文/偽紹介実績) を出さず、
    // 明示エラー+再読み込みに倒す (Codex MEDIUM-2)。
    if (isDemoRequested()) {
      isDemo = true;
      loadDemoData();
      document.getElementById('loading').style.display = 'none';
      initScrollReveal();
      return;
    }
    showFatalError('読み込みに失敗しました。お手数ですが、トーク画面から開き直してください🌿');
  }
}

function loadDemoData() {
  // Demo banner
  var banner = document.createElement('div');
  banner.className = 'bg-amber-50 border border-amber-200 rounded-2xl p-2.5 text-center text-xs text-amber-700 mx-4 mt-2 font-medium';
  banner.textContent = '\u{1F6A7} DEMO MODE \u2014 LINE\u30a2\u30d7\u30ea\u5185\u3067\u958b\u304f\u3068\u5b9f\u30c7\u30fc\u30bf\u304c\u8868\u793a\u3055\u308c\u307e\u3059';
  document.querySelector('nav').after(banner);

  // Avatar
  document.getElementById('user-avatar').innerHTML =
    '<div class="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center text-white text-xs font-bold">D</div>';

  // Rank
  document.getElementById('rank-card').innerHTML =
    '<div class="flex items-center gap-3 mb-3">' +
    '<div class="w-12 h-12 rounded-full flex items-center justify-center text-2xl" style="background:#C0C0C020">Ag</div>' +
    '<div><p class="text-sm font-bold text-gray-800">Silver</p>' +
    '<p class="text-xs text-gray-500">\u7d2f\u8a08 \xa515,000</p></div></div>' +
    '<div class="bg-gray-100 rounded-full h-2 overflow-hidden"><div class="bg-green-500 h-2 progress-bar" style="width:25%"></div></div>' +
    '<p class="text-xs text-gray-400 mt-1">\u6b21\u306e\u30e9\u30f3\u30af Gold \u307e\u3067\u3042\u3068 \xa59,000</p>';

  // Tip
  document.getElementById('tip-card').innerHTML =
    '<p class="text-xs text-green-600 font-bold mb-1">Today\\\'s Tip</p>' +
    '<p class="text-sm font-bold text-gray-800">\u6c34\u5206\u88dc\u7d66\u306e\u30b3\u30c4</p>' +
    '<p class="text-xs text-gray-600 mt-1">\u3053\u307e\u3081\u306a\u6c34\u5206\u88dc\u7d66\u304c\u5927\u5207\u3067\u3059\u3002\u98df\u4e8b\u306e30\u5206\u524d\u306b\u30b3\u30c3\u30d7\u4e00\u676f\u306e\u6c34\u3092\u98f2\u3080\u3068\u3001\u6d88\u5316\u3092\u30b5\u30dd\u30fc\u30c8\u3057\u307e\u3059\u3002</p>';

  // Coupons
  document.getElementById('coupons-card').innerHTML =
    '<p class="text-xs text-gray-500 font-bold mb-2">\u30af\u30fc\u30dd\u30f3</p>' +
    '<div class="flex items-center justify-between py-2 border-b">' +
    '<div><p class="text-sm font-bold text-green-600">WELCOME500</p>' +
    '<p class="text-xs text-gray-500">500\u5186OFF (\u521d\u56de\u9650\u5b9a)</p></div>' +
    '<p class="text-xs text-gray-400">~2026-12-31</p></div>' +
    '<div class="flex items-center justify-between py-2">' +
    '<div><p class="text-sm font-bold text-green-600">SILVER10</p>' +
    '<p class="text-xs text-gray-500">10%OFF (\u30b7\u30eb\u30d0\u30fc\u7279\u5178)</p></div>' +
    '<p class="text-xs text-gray-400">~2026-06-30</p></div>';

  // Referral
  document.getElementById('referral-card').innerHTML =
    '<p class="text-xs text-gray-500 font-bold mb-2">\u53cb\u3060\u3061\u7d39\u4ecb</p>' +
    '<p class="text-sm text-gray-700 mb-2">\u30ea\u30f3\u30af\u3092\u5171\u6709\u3057\u3066\u304a\u30c8\u30af\u306b\u30af\u30fc\u30dd\u30f3\u30b2\u30c3\u30c8!</p>' +
    '<div class="bg-gray-50 rounded-lg p-2 flex items-center gap-2 mb-3">' +
    '<span class="text-xs font-mono text-gray-600 truncate flex-1" id="ref-url">https://example.com/liff/portal?ref=demo123</span>' +
    '<button onclick="copyRefLink()" class="text-xs text-green-600 font-bold whitespace-nowrap">\u30b3\u30d4\u30fc</button></div>' +
    '<div class="flex gap-2">' +
    '<button onclick="shareRefLine()" class="flex-1 py-2 rounded-lg text-xs font-bold text-white" style="background:#06C755">LINE\u3067\u9001\u308b</button></div>' +
    '<p class="text-xs text-gray-500 mt-3">\u7d39\u4ecb\u5b9f\u7e3e: <span class="font-bold text-green-600">3\u4eba</span></p>';

  // Ranking
  document.getElementById('ranking-card').style.display = 'block';
  document.getElementById('ranking-card').innerHTML =
    '<p class="text-xs text-gray-500 font-bold mb-3">\u7d39\u4ecb\u30e9\u30f3\u30ad\u30f3\u30b0 TOP10</p>' +
    '<div class="flex items-center gap-3 py-2 border-b"><span class="text-sm w-8 text-center">&#x1F947;</span><span class="text-sm text-gray-800 flex-1">\u7530\u25cb\u592a\u25cb</span><span class="text-sm font-bold text-green-600">8\u4eba</span></div>' +
    '<div class="flex items-center gap-3 py-2 border-b"><span class="text-sm w-8 text-center">&#x1F948;</span><span class="text-sm text-gray-800 flex-1">\u5c71\u25cb\u82b1\u25cb</span><span class="text-sm font-bold text-green-600">5\u4eba</span></div>' +
    '<div class="flex items-center gap-3 py-2"><span class="text-sm w-8 text-center">&#x1F949;</span><span class="text-sm text-gray-800 flex-1">\u4f50\u25cb\u6b21\u25cb</span><span class="text-sm font-bold text-green-600">3\u4eba</span></div>';

  // Calendar demo
  intakeDatesSet.clear();
  var today = new Date();
  for (var i = 0; i < 5; i++) {
    var d = new Date(today); d.setDate(d.getDate() - i - 1);
    intakeDatesSet.add(d.toISOString().slice(0, 10));
  }
  renderCalendar();

  // Streak (intake)
  document.getElementById('streak-card').innerHTML =
    '<div class="text-4xl mb-2 streak-fire">&#x2B50;</div>' +
    '<p class="text-3xl font-bold text-gray-800">5<span class="text-sm text-gray-500 ml-1">\u65e5\u9023\u7d9a</span></p>' +
    '<div class="flex justify-center gap-6 mt-3 text-xs text-gray-500">' +
    '<div>\u6700\u9577 <span class="font-bold text-gray-800">12\u65e5</span></div>' +
    '<div>\u7d2f\u8a08 <span class="font-bold text-gray-800">45\u65e5</span></div></div>';

  // Reminders (demo: initReminder()で設定)

  // Health demo: populate health-stats (graph view summary)
  var hStatsEl = document.getElementById('health-stats');
  if (hStatsEl) {
    hStatsEl.innerHTML =
      '<h4 class="text-xs font-bold text-gray-500 mb-3">\u671f\u9593\u30b5\u30de\u30ea\u30fc\uff087\u65e5\u9593\uff09</h4>' +
      '<div class="grid grid-cols-3 gap-2 text-center">' +
      '<div class="bg-green-50 rounded-lg p-2"><p class="text-lg font-bold text-green-600">4</p><p class="text-xs text-gray-500">\u826f\u3044</p></div>' +
      '<div class="bg-yellow-50 rounded-lg p-2"><p class="text-lg font-bold text-yellow-600">2</p><p class="text-xs text-gray-500">\u666e\u901a</p></div>' +
      '<div class="bg-red-50 rounded-lg p-2"><p class="text-lg font-bold text-red-600">1</p><p class="text-xs text-gray-500">\u60aa\u3044</p></div></div>';
  }

  // Products
  document.getElementById('products-card').innerHTML =
    '<p class="text-xs text-gray-500 font-bold mb-3">\u5546\u54c1\u30e9\u30a4\u30f3\u30ca\u30c3\u30d7</p>' +
    '<div class="flex items-center gap-3 py-3 border-b">' +
    '<div class="w-16 h-16 rounded-lg bg-blue-50 flex items-center justify-center text-2xl">B</div>' +
    '<div class="flex-1"><p class="text-sm font-bold text-gray-800">naturism Blue</p>' +
    '<p class="text-xs text-gray-500">8\u6210\u5206\u30fb\u8102\u3063\u3053\u3044\u98df\u4e8b\u304c\u597d\u304d\u306a\u65b9\u306b</p>' +
    '<p class="text-sm text-green-600 font-bold">\xa52,376</p></div>' +
    '<span class="text-xs text-green-600 border border-green-600 px-3 py-1 rounded-full">\u8cfc\u5165</span></div>' +
    '<div class="flex items-center gap-3 py-3 border-b">' +
    '<div class="w-16 h-16 rounded-lg bg-pink-50 flex items-center justify-center text-2xl">P</div>' +
    '<div class="flex-1"><p class="text-sm font-bold text-gray-800">KOSO in naturism Pink</p>' +
    '<p class="text-xs text-gray-500">10\u6210\u5206\u30fb\u7f8e\u5bb9+\u98df\u4e8b\u30b1\u30a2</p>' +
    '<p class="text-sm text-green-600 font-bold">\xa52,830</p></div>' +
    '<span class="text-xs text-green-600 border border-green-600 px-3 py-1 rounded-full">\u8cfc\u5165</span></div>' +
    '<div class="flex items-center gap-3 py-3">' +
    '<div class="w-16 h-16 rounded-lg bg-gray-50 flex items-center justify-center text-2xl">Pr</div>' +
    '<div class="flex-1"><p class="text-sm font-bold text-gray-800">naturism Premium</p>' +
    '<p class="text-xs text-gray-500">16\u6210\u5206\u30fb\u6a5f\u80fd\u6027\u8868\u793a\u98df\u54c1</p>' +
    '<p class="text-sm text-green-600 font-bold">\xa55,590</p></div>' +
    '<span class="text-xs text-green-600 border border-green-600 px-3 py-1 rounded-full">\u8cfc\u5165</span></div>';

  // Orders
  document.getElementById('orders-card').innerHTML =
    '<p class="text-xs text-gray-500 font-bold mb-2">\u6700\u8fd1\u306e\u6ce8\u6587</p>' +
    '<div class="py-2 border-b"><div class="flex justify-between items-center"><p class="text-sm font-bold">#1042</p>' +
    '<p class="text-sm text-green-600 font-bold">\xa56,415</p></div><p class="text-xs text-gray-400">2026-03-28</p></div>' +
    '<div class="py-2"><div class="flex justify-between items-center"><p class="text-sm font-bold">#1035</p>' +
    '<p class="text-sm text-green-600 font-bold">\xa52,830</p></div><p class="text-xs text-gray-400">2026-03-01</p></div>';

  // Quiz (demo keeps intro visible, no special demo data needed)

  // Fulfillments
  document.getElementById('fulfillments-card').innerHTML =
    '<p class="text-xs text-gray-500 font-bold mb-2">\u914d\u9001\u72b6\u6cc1</p>' +
    '<div class="py-2"><div class="flex justify-between"><p class="text-sm">#1042</p>' +
    '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">delivered</span></div>' +
    '<p class="text-xs text-blue-500">\u30e4\u30de\u30c8\u904b\u8f38 1234-5678-9012</p></div>';
}

// ─── API Helper ───
// opts.softAuth = true のとき 401 で handleAuthExpired() を発火させない。
// 用途は sub-link (magic-link) 経路のみ: ここで全画面エラーに倒すと、 メールから来た未連携顧客が
// 連携カードを一度も見られずに終わる。 呼び出し側が退避トークンを保持したまま自前で案内する。
async function api(path, body = {}, opts = {}) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...body }),
  });
  var json = await res.json();
  // HTTP status を透過 (エラー文字列の英文 sniffing をせず status code で判定できるように)
  if (json && typeof json === 'object' && json.status === undefined) { json.status = res.status; }
  // 401 = idToken 失効。どの呼び出し経路 (mutation 含む) でも全画面の再読み込み誘導へ
  if (res.status === 401 && !isDemo && !opts.softAuth) { handleAuthExpired(); }
  return json;
}

async function apiGet(path) {
  var headers = {};
  if (idToken) { headers['Authorization'] = 'Bearer ' + idToken; }
  const res = await fetch(API_BASE + path, { headers: headers });
  var json = await res.json();
  if (json && typeof json === 'object' && json.status === undefined) { json.status = res.status; }
  if (res.status === 401 && !isDemo) { handleAuthExpired(); }
  return json;
}

// 致命的な初期化失敗 (idToken 取得不可 等) で skeleton 固着でなく明示的なエラー + 再読み込みを出す。
function showFatalError(msg){
  var el = document.getElementById('loading');
  if (!el) return;
  window.__fatalShown = true;
  el.style.display = 'flex';
  el.innerHTML = '<div class="text-center px-8">' +
    '<p class="text-3xl mb-3">🌿</p>' +
    '<p class="text-sm text-gray-600 font-medium leading-relaxed mb-5">' + msg + '</p>' +
    '<button onclick="location.reload()" class="btn-primary px-6 py-2.5 rounded-xl text-sm font-bold">再読み込み</button>' +
    '</div>';
  var wd = document.getElementById('liff-watchdog-overlay');
  if (wd && wd.parentNode) { wd.parentNode.removeChild(wd); }
}

// ?demo=1 を明示指定した時だけサンプル表示する。本物の API 失敗を偽データ (偽クーポン/偽注文/偽紹介実績) で隠さない。
function isDemoRequested(){
  try { return new URLSearchParams(location.search).get('demo') === '1'; } catch (e) { return false; }
}

// ─── 共通 loader エラー描画 (2026-07-04 採点R3: silent catch → skeleton 固着の全域修正) ───
// res = api()/apiGet() の返り値 (HTTP status 透過) / null = fetch 例外。
// demo モードは従来どおり空状態に倒す (プレビューにエラーカードを出さない)。
function apiFailed(res) {
  if (isDemo) return false;
  return !res || (typeof res.status === 'number' && res.status >= 400);
}

// 401 (idToken 失効) はカード毎に同文エラーを並べず、全画面の再読み込み誘導へ一本化する。
function handleAuthExpired() {
  if (window.__fatalShown) return;
  showFatalError('ログインの有効期限が切れました。お手数ですが、開き直してください🌿');
}

// 失敗したカードに「読み込みに失敗しました + 再試行」を描画する。retryFnName は loader 自身の関数名。
function cardError(el, res, retryFnName) {
  if (res && res.status === 401) { handleAuthExpired(); return; }
  if (!el) return;
  // 非表示カード (friend/welcome クーポン等) のみ表示に戻す。
  // grid/flex コンテナ (badge-grid 等) に display:block を焼き付けない (再試行成功後のレイアウト崩れ防止)。
  if (el.style.display === 'none') { el.style.display = 'block'; }
  el.innerHTML = '<div class="text-center py-3 col-span-full">' +
    '<p class="text-xs text-gray-500 mb-2">読み込みに失敗しました</p>' +
    (retryFnName ? '<button onclick="' + retryFnName + '()" class="text-xs font-bold text-green-700 border border-green-300 bg-green-50 rounded-lg px-3 py-1.5">再試行</button>' : '') +
    '</div>';
}

// フォーム型 (カードでない) loader の失敗通知: 401 は全画面誘導、それ以外は toast。
function loadErrorToast(res, msg) {
  if (res && res.status === 401) { handleAuthExpired(); return; }
  showToast(msg);
}

// ─── Deep Link (hash-based tab navigation from rich menu) ───
function handleDeepLink() {
  var hash = window.location.hash.replace('#', '');
  var tabMap = { shop: 'shop', store: 'shop', home: 'home', mypage: 'home', rank: 'home', referral: 'home', quiz: 'quiz', intake: 'intake', health: 'intake', delivery: 'shop', reorder: 'shop', more: 'account', account: 'account', settings: 'account' };
  // URLSearchParams もチェック（openLiffPage 互換）
  if (!hash) {
    var params = new URLSearchParams(window.location.search);
    hash = params.get('page') || '';
  }
  var target = tabMap[hash];
  if (target && target !== 'home') {
    switchTab(target);
  }
  // ホームタブ内のセクションへスクロール
  // 注: 通常の #rank は initLiff で /liff/my-rank へ redirect 済。この分岐は ?demo=1 で redirect を skip した時のみ到達するフォールバック。
  if (hash === 'rank') { setTimeout(function() { var el = document.getElementById('rank-card'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 300); }
  if (hash === 'referral') { setTimeout(function() { var el = document.getElementById('referral-card'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 300); }
  // ショップタブ内のカードへスクロール
  if (hash === 'delivery') { window.__pendingDeliveryScroll = true; setTimeout(function() { var el = document.getElementById('fulfillments-card'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 300); }
  if (hash === 'reorder') { window.__pendingReorderScroll = true; setTimeout(function() { var el = document.getElementById('orders-card'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 300); }
}

// ─── Tab Switching ───
function switchTab(name) {
  // 未知タブは現状維持で無視 (review HIGH: throw すると tabAnimating が固まり全タブ操作が死ぬ)
  var section = document.getElementById('section-' + name);
  if (!section) { console.error('switchTab: unknown tab', name); return; }
  document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active'); });
  document.querySelectorAll('nav button').forEach(function(b) { b.className = b.className.replace('tab-active', 'tab-inactive'); });
  section.classList.add('active');
  var tabBtn = document.getElementById('tab-' + name);
  if (tabBtn) tabBtn.className = tabBtn.className.replace('tab-inactive', 'tab-active');
  // Scroll to top smoothly
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Lazy load section data (4タブ再設計: 体調は「記録」に統合、旧 more は「マイアカウント」へ)
  if (name === 'intake') { loadIntakeData(); initReminder(); loadHealthData(); }
  if (name === 'shop') {
    // deep-link 先行フェッチ済みなら 1 回だけ skip (double-fetch 回避)
    if (window.__shopPrefetched) { window.__shopPrefetched = false; }
    else { loadShopData(); }
    loadSubscriptionsOnce();
  }
  if (name === 'account') loadAccountData();
  if (name === 'quiz') playQuizHeroVideo();
}

// 診断ヒーロー動画: 診断タブが表示された時だけ再生 (データ節約 = home 初期表示では読まない)。
// reduced-motion では poster 静止のまま (自動再生の動きを出さない = WCAG 2.2.2 尊重)。
var quizHeroPlayed = false;
function playQuizHeroVideo() {
  var v = document.getElementById('quiz-hero-video');
  if (!v || TAB_REDUCED_MOTION) return;
  quizHeroPlayed = true;
  try {
    var p = v.play();
    if (p && p.catch) { p.catch(function () { /* autoplay 拒否時は poster のまま */ }); }
  } catch (e) { /* poster fallback */ }
}

// ─── タブ フリック切替 (ページめくり、2026-07-04 先進性方針) ───
// 左右フリック/タブタップで、現タブが押し出され次タブが滑り込む。
// reduced-motion では即時切替。縦スクロール優位のジェスチャは無視する。
var TAB_ORDER = ['home', 'quiz', 'shop', 'intake']; // 4タブ (account はアバターから開く隠しセクション = スワイプ対象外)
var TAB_REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var tabAnimating = false;

function currentTabIndex() {
  var active = document.querySelector('.section.active');
  if (!active) return 0;
  var i = TAB_ORDER.indexOf(active.id.replace('section-', ''));
  return i < 0 ? 0 : i;
}

function switchTabAnimated(name, dir) {
  if (tabAnimating) return;
  var from = document.querySelector('.section.active');
  if (TAB_REDUCED_MOTION || !from) { switchTab(name); return; }
  tabAnimating = true;
  from.style.transition = 'transform 0.2s ease-in, opacity 0.2s ease-in';
  from.style.transform = 'translateX(' + (dir * -30) + 'px)';
  from.style.opacity = '0';
  setTimeout(function () {
    // review HIGH: 例外時も tabAnimating を必ず復帰させる (固まると全タブ操作不能)
    try {
      from.style.transition = ''; from.style.transform = ''; from.style.opacity = '';
      switchTab(name);
      var to = document.getElementById('section-' + name);
      if (!to) { tabAnimating = false; return; }
      // 既定の fadeUp keyframe と二重にならないよう、横スライドで入る間は無効化
      to.style.animation = 'none';
      to.style.transition = 'none';
      to.style.transform = 'translateX(' + (dir * 36) + 'px)';
      to.style.opacity = '0';
      requestAnimationFrame(function () {
        to.style.transition = 'transform 0.28s cubic-bezier(0.22,1,0.36,1), opacity 0.28s ease-out';
        to.style.transform = 'translateX(0)';
        to.style.opacity = '1';
        setTimeout(function () {
          try { to.style.transition = ''; to.style.transform = ''; to.style.opacity = ''; to.style.animation = ''; }
          finally { tabAnimating = false; }
        }, 320);
      });
    } catch (e) {
      tabAnimating = false;
    }
  }, 180);
}

// タブボタン用: 現在位置との相対方向でスライド (同一タブは no-op)
function switchTabTo(name) {
  // 同一タブ判定は index でなく実セクション id で行う (採点R1 HIGH: account 表示中は
  // TAB_ORDER に無い=index 0 扱いになり、home ボタンが index 一致で無反応だった)
  var active = document.querySelector('.section.active');
  if (active && active.id === 'section-' + name) return;
  var next = TAB_ORDER.indexOf(name);
  if (next < 0) return;
  // account 等 TAB_ORDER 外のセクションからの復帰は方向が定義できない → 素の switchTab
  if (!active || TAB_ORDER.indexOf(active.id.replace('section-', '')) < 0) { switchTab(name); return; }
  var cur = currentTabIndex();
  switchTabAnimated(name, next > cur ? 1 : -1);
}

function initTabSwipe() {
  var sx = 0, sy = 0, st = 0, tracking = false;
  document.addEventListener('touchstart', function (e) {
    tracking = false;
    if (e.touches.length !== 1) return;
    // ツアー overlay や将来の横操作 UI 上では発火させない (採点R3: range スライダーの drag も横操作)
    if (e.target && e.target.closest && e.target.closest('[data-no-tab-swipe],input[type="range"]')) return;
    tracking = true;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!tracking) return;
    tracking = false;
    var t = e.changedTouches[0];
    if (!t) return;
    var dx = t.clientX - sx;
    var dy = t.clientY - sy;
    // フリック判定: 十分な横移動 / 横優位 / 素早い操作 のすべてを満たす
    if (Math.abs(dx) < 56) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.6) return;
    if (Date.now() - st > 600) return;
    var i = currentTabIndex();
    var next = dx < 0 ? i + 1 : i - 1;
    if (next < 0 || next >= TAB_ORDER.length) return;
    switchTabAnimated(TAB_ORDER[next], dx < 0 ? 1 : -1);
  }, { passive: true });
}

// ─── 没入スクロール (2026-07-07 Katsu 指示「重要」: 高級感×先進性、大胆に、ただし軽量) ───
// 3D カード cascade: 画面に入ったカードが perspective+rotateX で「起き上がる」ように現れる (stagger 付き)。
// IntersectionObserver + transform/opacity のみ (ライブラリなし・reflow なし)。reveal 後は class を外して
// will-change を解放 (低スペック端末のメモリ保護)。reduced-motion / IO 非対応では何もしない (= 常に可視)。
var srInited = false;
function initScrollReveal() {
  if (srInited) return;
  srInited = true;
  // スクロール進捗バー (rAF throttle + passive — 60fps 維持)。先端を 🌿 が走る (ブランドの遊び心)
  var bar = document.getElementById('scroll-progress');
  var leaf = document.getElementById('scroll-leaf');
  if (bar && !TAB_REDUCED_MOTION) {
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var h = document.documentElement;
        var max = (h.scrollHeight - h.clientHeight) || 1;
        var p = Math.min(1, Math.max(0, h.scrollTop / max));
        bar.style.transform = 'scaleX(' + p + ')';
        if (leaf) { leaf.style.transform = 'translateX(' + Math.round(p * (h.clientWidth - 18)) + 'px) rotate(' + Math.round(p * 360) + 'deg)'; }
      });
    }, { passive: true });
  }
  if (TAB_REDUCED_MOTION) return;
  if (!('IntersectionObserver' in window)) return;
  var queue = 0;
  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      (function (el, isIn) {
        if (!isIn) return;
        io.unobserve(el);
        var delay = Math.min(queue * 70, 420); // 同時に入った分は波状に (最大 420ms)
        queue++;
        setTimeout(function () {
          el.classList.add('sr-in');
          setTimeout(function () {
            el.classList.remove('sr');
            el.classList.remove('sr-in');
            queue = Math.max(0, queue - 1);
          }, 800);
        }, delay);
      })(entries[i].target, entries[i].isIntersecting);
    }
  }, { threshold: 0.08, rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.section .card').forEach(function (el) {
    el.classList.add('sr');
    io.observe(el);
  });
}

// ─── Toast ───
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, 2000);
}

// ─── HOME: Rank ───
async function loadRank() {
  const el = document.getElementById('rank-card');
  try {
    const res = await api('/api/liff/rank');
    if (apiFailed(res)) { cardError(el, res, 'loadRank'); return; }
    const data = res.data;
    if (!data) return;
    // Shopify 連携済みなら、マイアカウントの連携カードを「連携済み」表示へ差し替える
    // (= 既連携ユーザーの無意味な外部ブラウザ往復と、完了直後の「まだ押せる」不安を消す)
    if (data.linked) { try { markShopifyLinked(); } catch (e) {} }
    if (data.currentRank) {
      const pct = data.progressPercent || 0;
      // Check if user is ambassador (will be set after loadAmbassador runs)
      const isAmb = !!ambassadorData;
      if (isAmb) {
        el.classList.add('rank-ambassador');
      }
      const badgeHtml = isAmb ? ' <span class="ambassador-badge">&#x2728; Ambassador</span>' : '';
      const sparkleHtml = isAmb ? '<div class="sparkle-dots">' +
        '<div class="sparkle-dot" style="top:12%;left:85%;animation-delay:0s"></div>' +
        '<div class="sparkle-dot" style="top:35%;left:10%;animation-delay:0.6s"></div>' +
        '<div class="sparkle-dot" style="top:70%;left:78%;animation-delay:1.2s"></div>' +
        '<div class="sparkle-dot" style="top:55%;left:25%;animation-delay:0.3s"></div>' +
        '<div class="sparkle-dot" style="top:20%;left:55%;animation-delay:0.9s"></div></div>' : '';
      el.innerHTML = sparkleHtml +
        '<div class="flex items-center gap-3 mb-3" style="position:relative;z-index:1">' +
        '<div class="w-12 h-12 rounded-full flex items-center justify-center text-2xl" style="background:' + esc(data.currentRank.color || '#ccc') + '20">' + esc(data.currentRank.icon || '') + '</div>' +
        '<div><p class="text-sm font-bold text-gray-800">' + esc(data.currentRank.name) + badgeHtml + '</p>' +
        '<p class="text-xs text-gray-500">累計 ¥' + Number(data.totalSpent).toLocaleString() + '</p></div></div>' +
        '<div class="bg-gray-100 rounded-full h-2 overflow-hidden" style="position:relative;z-index:1"><div class="' + (isAmb ? 'h-2 progress-bar' : 'bg-green-500 h-2 progress-bar') + '" style="width:' + pct + '%;' + (isAmb ? 'background:linear-gradient(90deg,#fbbf24,#f59e0b)' : '') + '"></div></div>' +
        (data.nextRank ? '<p class="text-xs text-gray-400 mt-1" style="position:relative;z-index:1">次のランク ' + esc(data.nextRank.name) + ' まであと ¥' + Number(data.nextRank.remaining).toLocaleString() + '</p>' : '<p class="text-xs text-green-600 mt-1" style="position:relative;z-index:1">最高ランク達成!</p>') +
        // 回遊: ランク表示で終わらせず、会員特典のおトクな購入へ繋ぐ (purchase motivation)
        '<a href="' + API_BASE + '/liff/my-rank" class="tap block mt-3 text-center text-xs text-green-700 bg-green-50 rounded-xl py-2 font-bold" style="position:relative;z-index:1">🛍 会員特典・おトクに購入する →</a>';
    } else {
      // 採点R1: 未購入ユーザーに「死んだグレー行」でなくランク制度のティーザーを見せる (割引訴求のみ=薬機法セーフ)
      el.innerHTML =
        '<div class="flex items-center gap-3 mb-2">' +
        '<div class="w-12 h-12 rounded-full flex items-center justify-center text-2xl" style="background:#effaf8">🌱</div>' +
        '<div><p class="text-sm font-bold text-gray-800">会員ランク</p>' +
        '<p class="text-xs text-gray-500">ご購入でランクが上がり、割引特典が受けられます</p></div></div>' +
        '<a href="' + API_BASE + '/liff/my-rank" class="tap block mt-1 text-center text-xs text-green-700 bg-green-50 rounded-xl py-2 font-bold">🛍 会員特典を見てみる →</a>';
    }
  } catch { cardError(el, null, 'loadRank'); }
}

// ─── HOME: Today's Tip ───
async function loadTip() {
  const el = document.getElementById('tip-card');
  try {
    const res = await apiGet('/api/liff/tips/today');
    if (apiFailed(res)) { cardError(el, res, 'loadTip'); return; }
    const data = res.data;
    if (data) {
      el.innerHTML = '<p class="text-xs text-green-600 font-bold mb-1">Today\\'s Tip</p>' +
        '<p class="text-sm font-bold text-gray-800">' + esc(data.title) + '</p>' +
        '<p class="text-xs text-gray-600 mt-1">' + esc(data.content) + '</p>';
    } else {
      el.innerHTML = '<p class="text-xs text-gray-400">今日のTipはまだありません</p>';
    }
  } catch { cardError(el, null, 'loadTip'); }
}

// ─── HOME: Coupons ───
// LINE友だち限定クーポン (ランク不問の一律 % OFF)。管理トグル ON 時のみ表示。
async function loadFriendCoupon() {
  var el = document.getElementById('friend-coupon-card');
  if (!el) return;
  try {
    const res = await apiGet('/api/liff/friend-coupon');
    // 「機能OFF/クーポンなし (200)」は非表示、「取得失敗」はエラーカード — 失敗を非表示に化けさせない
    if (apiFailed(res)) { cardError(el, res, 'loadFriendCoupon'); return; }
    const data = res.data;
    if (!data || !data.enabled || !data.code) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.background = 'linear-gradient(135deg,#eef8f8,#ffffff)';
    el.style.border = '1.5px solid rgba(47,168,173,.4)';
    el.innerHTML =
      '<div class="flex items-center gap-2 mb-1">' +
      '<span class="text-white bg-green-600 px-2 py-0.5 rounded-full" style="font-size:10px;font-weight:700">LINE友だち限定</span>' +
      (data.label ? '<span class="text-xs text-gray-400">' + esc(data.label) + '</span>' : '') + '</div>' +
      '<p class="text-2xl font-extrabold text-green-700 mb-1">' + Number(data.percent) + '%OFF クーポン 🎁</p>' +
      (data.note ? '<p class="text-xs text-gray-500 mb-2">' + esc(data.note) + '</p>' : '') +
      '<div class="flex items-center gap-2 mb-3">' +
      '<code id="friend-coupon-code" class="flex-1 text-center text-sm font-bold tracking-widest bg-white border border-green-300 rounded-lg py-2">' + esc(data.code) + '</code>' +
      '<button onclick="copyFriendCoupon()" class="text-xs font-bold text-green-700 border border-green-300 bg-green-50 rounded-lg px-3 py-2">コピー</button></div>' +
      (data.applyUrl ? '<a href="' + esc(data.applyUrl) + '" target="_blank" class="block text-center btn-primary py-3 rounded-xl text-sm font-bold">このクーポンで買う →</a>' : '');
  } catch {
    cardError(el, null, 'loadFriendCoupon');
  }
}
function copyFriendCoupon() {
  var el = document.getElementById('friend-coupon-code');
  if (!el) return;
  var code = el.textContent || '';
  // 採点R3: コピー失敗時に成功トーストを出さない
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code)
        .then(function() { showToast('クーポンコードをコピーしました'); })
        .catch(function() { showToast('コピーできませんでした。コードを長押ししてください'); });
    } else { showToast('コピーできませんでした。コードを長押ししてください'); }
  } catch (e) { showToast('コピーできませんでした。コードを長押ししてください'); }
}

// 友だち追加 welcome クーポン (¥500 OFF・あなた専用)。発行済みのときだけ期限カウントダウン付きで表示。
async function loadWelcomeCoupon() {
  var el = document.getElementById('welcome-coupon-card');
  if (!el) return;
  try {
    const res = await apiGet('/api/liff/welcome-coupon');
    if (apiFailed(res)) { cardError(el, res, 'loadWelcomeCoupon'); return; }
    var cp = res.data && res.data.coupon;
    if (!cp || !cp.code) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    // お得の主役カード: 汎用 orange でなくブランドコーラルで統一 (2026-07-07 パレット準拠)
    el.style.background = 'linear-gradient(135deg,#fff5ec,#ffffff)';
    el.style.border = '1.5px solid rgba(232,131,106,.4)';
    var currency = cp.currency === 'JPY' ? '¥' : (esc(cp.currency) + ' ');
    el.innerHTML =
      '<div class="flex items-center gap-2 mb-1">' +
      '<span class="chip-coral px-2 py-0.5 rounded-full" style="font-size:10px;font-weight:700">🎁 あなた専用</span>' +
      (cp.remainingText ? '<span class="text-xs font-bold text-coral">⏳ ' + esc(cp.remainingText) + 'で終了</span>' : '') + '</div>' +
      '<p class="text-2xl font-extrabold text-coral-lg mb-1">' + currency + Number(cp.discountValue) + ' OFF クーポン</p>' +
      '<p class="text-xs text-gray-500 mb-2">友だち追加のお礼です。公式ストアの初回購入にお使いいただけます。</p>' +
      '<div class="flex items-center gap-2 mb-3">' +
      '<code id="welcome-coupon-code" class="flex-1 text-center text-sm font-bold tracking-widest bg-white rounded-lg py-2" style="border:1px solid #f4c0ad">' + esc(cp.code) + '</code>' +
      '<button onclick="copyWelcomeCoupon()" class="text-xs font-bold text-coral rounded-lg px-3 py-2" style="border:1px solid #f4c0ad;background:#fff5ec">コピー</button></div>' +
      (cp.applyUrl ? '<a href="' + esc(cp.applyUrl) + '" target="_blank" class="block text-center btn-coral py-3 rounded-xl text-sm font-bold">このクーポンで買う →</a>' : '');
  } catch {
    cardError(el, null, 'loadWelcomeCoupon');
  }
}
function copyWelcomeCoupon() {
  var el = document.getElementById('welcome-coupon-code');
  if (!el) return;
  var code = el.textContent || '';
  // 採点R3: コピー失敗時に成功トーストを出さない
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code)
        .then(function() { showToast('クーポンコードをコピーしました'); })
        .catch(function() { showToast('コピーできませんでした。コードを長押ししてください'); });
    } else { showToast('コピーできませんでした。コードを長押ししてください'); }
  } catch (e) { showToast('コピーできませんでした。コードを長押ししてください'); }
}
async function loadReferralCoupon() {
  var el = document.getElementById('referral-coupon-card');
  if (!el) return;
  try {
    const res = await apiGet('/api/liff/referral-coupon');
    if (apiFailed(res)) { cardError(el, res, 'loadReferralCoupon'); return; }
    var list = (res.data && res.data.coupons) || [];
    if (!list.length) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.background = 'linear-gradient(135deg,#fff5ec,#ffffff)';
    el.style.border = '1.5px solid rgba(232,131,106,.4)';
    var val = Number(list[0].discountValue) || 500;
    // 紹介した側の獲得クーポンは成立ごとに増える → 全枚数を一覧表示
    var head =
      '<div class="flex items-center gap-2 mb-1">' +
      '<span class="chip-coral px-2 py-0.5 rounded-full" style="font-size:10px;font-weight:700">🎁 紹介特典</span>' +
      '<span class="text-xs font-bold text-coral">' + list.length + '枚 利用可能</span></div>' +
      '<p class="text-2xl font-extrabold text-coral-lg mb-1">¥' + val + ' OFF クーポン</p>' +
      '<p class="text-xs text-gray-500 mb-2">ご紹介ありがとうございます!お友だちが購入するたびに増えます。公式ストアでお使いいただけます。</p>';
    var items = list.map(function(cp) {
      return '<div class="flex items-center gap-2 mb-2">' +
        '<code class="flex-1 text-center text-sm font-bold tracking-widest bg-white rounded-lg py-2" style="border:1px solid #f4c0ad">' + esc(cp.code) + '</code>' +
        '<button onclick="copyRefCode(this)" data-code="' + esc(cp.code) + '" class="text-xs font-bold text-coral rounded-lg px-3 py-2 whitespace-nowrap" style="border:1px solid #f4c0ad;background:#fff5ec">コピー</button>' +
        (cp.applyUrl ? '<a href="' + esc(cp.applyUrl) + '" target="_blank" class="text-xs font-bold btn-coral rounded-lg px-3 py-2 whitespace-nowrap">使う</a>' : '') +
        '</div>' +
        (cp.remainingText ? '<p class="text-xs text-coral mb-2" style="margin-top:-4px">⏳ ' + esc(cp.remainingText) + 'で終了</p>' : '');
    }).join('');
    el.innerHTML = head + items;
  } catch {
    cardError(el, null, 'loadReferralCoupon');
  }
}
function copyRefCode(btn) {
  var code = (btn && btn.getAttribute('data-code')) || '';
  // 採点R3: コピー失敗時に成功トーストを出さない (clipboard は Promise — .then で成功時のみ)
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code)
        .then(function() { showToast('クーポンコードをコピーしました'); })
        .catch(function() { showToast('コピーできませんでした。コードを長押ししてください'); });
    } else { showToast('コピーできませんでした。コードを長押ししてください'); }
  } catch (e) { showToast('コピーできませんでした。コードを長押ししてください'); }
}

async function loadCoupons() {
  const el = document.getElementById('coupons-card');
  try {
    const res = await api('/api/liff/coupons');
    if (apiFailed(res)) { cardError(el, res, 'loadCoupons'); return; }
    const data = res.data;
    if (data && data.coupons && data.coupons.length > 0) {
      // 採点R2: 一覧行にもコピー行動を (welcome/紹介カードと同じ「使える」体験に)
      el.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-2">クーポン</p>' +
        data.coupons.map(function(cp) {
          return '<div class="flex items-center justify-between gap-2 py-2 border-b last:border-0">' +
            '<div class="flex-1 min-w-0"><p class="text-sm font-bold text-green-600 truncate">' + esc(cp.code) + '</p>' +
            '<p class="text-xs text-gray-500 truncate">' + esc(cp.title) + '</p>' +
            (cp.expiresAt ? '<p class="text-xs text-gray-400">~' + esc(cp.expiresAt.slice(0, 10)) + '</p>' : '') + '</div>' +
            '<button onclick="copyRefCode(this)" data-code="' + esc(cp.code) + '" class="tap text-xs font-bold text-teal-700 rounded-full px-3 py-1 whitespace-nowrap" style="border:1px solid #bfe8e3;background:#effaf8">コピー</button></div>';
        }).join('');
    } else {
      // 採点R1: 「無い」の告知でなく、クーポンを得る次の一手 (紹介ヒーロー) へ橋渡し。
      //   文言は gate 連動: off の間は referred 側 (=welcome、稼働中) の訴求のみ (景表法セーフ)。
      //   ⚠️ onclick 内に「バックスラッシュ+シングルクォート」で JS を書いてはいけない
      //   (TS template literal が素のクォートに潰し、client script 全体が SyntaxError =
      //   ポータル全損。2026-07-10 本番障害の実原因) →
      //   引用符ネストが要る handler は必ず名前付き関数にする。
      var refBridge = REFERRAL_REWARD_ON
        ? '🎁 お友だち紹介で ¥500 クーポンがもらえます →'
        : '🎁 お友だちに ¥500 クーポンをプレゼントできます →';
      el.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-1">クーポン</p>' +
        '<a href="javascript:void(0)" onclick="scrollToReferralCard()" class="tap block text-sm font-bold rounded-xl py-2.5 text-center" style="color:#b84a2e;background:#fff3ec;border:1px solid #f4c0ad">' + refBridge + '</a>';
    }
  } catch { cardError(el, null, 'loadCoupons'); }
}

// 空クーポン→紹介ヒーローへの橋渡し (inline onclick の引用符ネスト回避のため名前付き関数)
function scrollToReferralCard() {
  var r = document.getElementById('referral-card');
  if (r) r.scrollIntoView({ behavior: 'smooth' });
}

// ─── INTAKE Section ───
var selectedProduct = 'Blue';
var calendarOffset = 0;
var intakeDatesSet = new Set();

function selectProduct(name) {
  selectedProduct = name;
  document.querySelectorAll('.product-btn').forEach(function(b) {
    var isSelected = b.getAttribute('data-product') === name;
    b.className = 'product-btn flex-1 py-2.5 rounded-xl text-xs border transition-all ' +
      (isSelected ? (name === 'Blue' ? 'bg-blue-50 text-blue-700 font-bold border-blue-300' :
                     name === 'Pink' ? 'bg-pink-50 text-pink-700 font-bold border-pink-300' :
                     'bg-purple-50 text-purple-700 font-bold border-purple-300') : '');
  });
}

async function loadIntakeData() {
  const el = document.getElementById('streak-card');
  try {
    // 採点R1 HIGH: 旧実装は POST /api/liff/intake (= 記録作成 endpoint) を「取得」目的で叩き、
    //   タブを開くたび phantom 服用ログ + scoring イベントが発生していた。streak endpoint が
    //   recentLogs (90日分) を返すので 1 リクエストに統合し、カレンダーもそこから塗る。
    const streakRes = await api('/api/liff/intake/streak', { days: 90 });
    if (apiFailed(streakRes)) { cardError(el, streakRes, 'loadIntakeData'); return; }
    const data = streakRes.data;
    if (data) {
      const fire = data.currentStreak >= 3 ? ' streak-fire' : '';
      el.innerHTML = '<div class="text-4xl mb-2' + fire + '">' + (data.currentStreak >= 7 ? '&#x1F525;' : data.currentStreak >= 3 ? '&#x2B50;' : '&#x1F331;') + '</div>' +
        '<p class="text-3xl font-bold ' + (data.currentStreak >= 3 ? 'text-coral-lg' : 'text-gray-800') + '">' + data.currentStreak + '<span class="text-sm text-gray-500 ml-1">日連続</span></p>' +
        '<div class="flex justify-center gap-6 mt-3 text-xs text-gray-500">' +
        '<div>最長 <span class="font-bold text-gray-800">' + data.longestStreak + '日</span></div>' +
        '<div>累計 <span class="font-bold text-gray-800">' + data.totalDays + '日</span></div></div>';
    }
    // Update calendar dates (recentLogs[].loggedAt は jstNow 由来の ISO 文字列 → 先頭10桁が日付)
    intakeDatesSet.clear();
    if (data && Array.isArray(data.recentLogs)) {
      data.recentLogs.forEach(function(l) { if (l.loggedAt) intakeDatesSet.add(String(l.loggedAt).slice(0, 10)); });
    }
    renderCalendar();
  } catch { cardError(el, null, 'loadIntakeData'); }
}

function renderCalendar() {
  var now = new Date();
  now.setDate(1); // 採点R3: 29-31日に setMonth が月跨ぎ overflow して前月ボタンが死ぬのを防ぐ
  now.setMonth(now.getMonth() + calendarOffset);
  var year = now.getFullYear();
  var month = now.getMonth();
  document.getElementById('calendar-month').textContent = year + '年' + (month + 1) + '月';
  var firstDay = new Date(year, month, 1).getDay();
  var daysInMonth = new Date(year, month + 1, 0).getDate();
  var html = '';
  for (var i = 0; i < firstDay; i++) html += '<span></span>';
  for (var d = 1; d <= daysInMonth; d++) {
    var dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    var isToday = calendarOffset === 0 && d === new Date().getDate() && month === new Date().getMonth();
    var taken = intakeDatesSet.has(dateStr);
    html += '<span class="py-1 rounded-full ' +
      (taken ? 'bg-green-500 text-white font-bold' : isToday ? 'border border-green-500 text-green-600' : 'text-gray-600') +
      '">' + d + '</span>';
  }
  document.getElementById('calendar-days').innerHTML = html;
}

function calendarPrev() { calendarOffset--; renderCalendar(); }
function calendarNext() { if (calendarOffset < 0) { calendarOffset++; renderCalendar(); } }

function showConfetti() {
  if (TAB_REDUCED_MOTION) return; // 採点R1: reduced-motion では紙吹雪を出さない (トーストが節目を伝える)
  var overlay = document.getElementById('confetti-overlay');
  overlay.style.display = 'block';
  var colors = ['#2fa8ad', '#f59e0b', '#ec4899', '#3b82f6', '#8b5cf6'];
  var html = '';
  for (var i = 0; i < 30; i++) {
    var x = Math.random() * 100;
    var delay = Math.random() * 0.5;
    var color = colors[Math.floor(Math.random() * colors.length)];
    html += '<div style="position:absolute;left:' + x + '%;top:-10px;width:8px;height:8px;' +
      'background:' + color + ';border-radius:50%;animation:confetti-fall 1.5s ease-out ' + delay + 's forwards;"></div>';
  }
  overlay.innerHTML = '<style>@keyframes confetti-fall{0%{transform:translateY(0) rotate(0);opacity:1}100%{transform:translateY(100vh) rotate(720deg);opacity:0}}</style>' + html;
  setTimeout(function() { overlay.style.display = 'none'; overlay.innerHTML = ''; }, 2500);
}

async function logIntake() {
  if (isDemo) { showToast('DEMO: 記録しました! (連続6日)'); showConfetti(); return; }
  var btn = document.getElementById('intake-btn');
  btn.disabled = true;
  var origLabel = btn.textContent;
  btn.textContent = '記録中...';
  try {
    var res = await api('/api/liff/intake', { productName: 'naturism ' + selectedProduct });
    if (apiFailed(res)) {
      // 採点R1: HTTP エラーを silent にしない (false-success/無反応の根絶)
      showToast('記録に失敗しました');
    } else if (res.data && res.data.alreadyLogged) {
      // 採点R3: 同日重複はサーバが既存値を返す (INSERT/スコアリングなし) — 正直に伝える
      showToast('本日は記録済みです (連続' + res.data.streakCount + '日)');
    } else if (res.data) {
      showToast('記録しました! (連続' + res.data.streakCount + '日)');
      showConfetti();
      loadIntakeData();
    }
  } catch { showToast('記録に失敗しました'); }
  btn.disabled = false;
  btn.textContent = origLabel;
}

// Phase 1: 能動pull 型の朝/昼/夜 ボタン処理
async function logMeal(mealType) {
  if (isDemo) {
    showToast('DEMO: ' + mealLabel(mealType) + 'を記録しました!');
    markMealDone(mealType);
    return;
  }
  var btn = document.getElementById('meal-' + mealType);
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  try {
    var res = await api('/api/liff/intake', {
      productName: 'naturism ' + (selectedProduct || 'Blue'),
      mealType: mealType,
    });
    if (apiFailed(res)) {
      // 採点R1: HTTP エラー時に無反応 + ボタン固着だった → フィードバック + 復帰
      showToast('記録に失敗しました');
      btn.disabled = false;
      return;
    }
    var data = res.data;
    if (data) {
      if (data.alreadyLogged) {
        showToast(mealLabel(mealType) + 'は既に記録済みです');
      } else {
        showToast('🎉 ' + mealLabel(mealType) + 'を記録しました! +10pt');
        showConfetti();
      }
      markMealDone(mealType);
      var num = document.getElementById('intake-streak-num');
      if (num && data.streakCount) num.textContent = data.streakCount;
    }
  } catch {
    showToast('記録に失敗しました');
    btn.disabled = false;
  }
}

function mealLabel(mealType) {
  return ({ breakfast: '朝', lunch: '昼', dinner: '夜', snack: 'おやつ' })[mealType] || '';
}

function markMealDone(mealType) {
  var btn = document.getElementById('meal-' + mealType);
  if (!btn) return;
  btn.disabled = true;
  btn.classList.remove('border-gray-200', 'bg-white');
  btn.classList.add('border-green-400', 'bg-green-50');
  var status = btn.querySelector('.meal-status');
  if (status) status.textContent = '●';
}

// Phase 2: バッジ + レベルロード
async function loadBadges() {
  if (isDemo) {
    // demo data
    var demoLevel = 3;
    var demoScore = 250;
    document.getElementById('badge-level-num').textContent = demoLevel;
    document.getElementById('badge-score').textContent = demoScore;
    document.getElementById('badge-pts-next').textContent = (demoLevel * 100 - demoScore);
    document.getElementById('badge-progress-bar').style.width = (demoScore % 100) + '%';
    document.getElementById('badge-grid').innerHTML =
      '<div class="aspect-square flex flex-col items-center justify-center bg-green-50 rounded-lg border-2 border-green-200"><span class="text-xl">🌱</span><span class="text-xs">7日</span></div>' +
      '<div class="aspect-square flex flex-col items-center justify-center bg-gray-50 rounded-lg border border-gray-200 opacity-40"><span class="text-xl">🌿</span><span class="text-xs text-gray-400">30日</span></div>' +
      '<div class="aspect-square flex flex-col items-center justify-center bg-gray-50 rounded-lg border border-gray-200 opacity-40"><span class="text-xl">🌳</span><span class="text-xs text-gray-400">100日</span></div>' +
      '<div class="aspect-square flex flex-col items-center justify-center bg-green-50 rounded-lg border-2 border-green-200"><span class="text-xl">🎉</span><span class="text-xs">初購入</span></div>' +
      '<div class="aspect-square flex flex-col items-center justify-center bg-gray-50 rounded-lg border border-gray-200 opacity-40"><span class="text-xl">💎</span><span class="text-xs text-gray-400">5回</span></div>';
    return;
  }
  try {
    const json = await apiGet('/api/liff/badges');
    if (apiFailed(json)) { cardError(document.getElementById('badge-grid'), json, 'loadBadges'); return; }
    if (!json || !json.data) return;

    const data = json.data;
    document.getElementById('badge-level-num').textContent = data.level;
    document.getElementById('badge-score').textContent = data.score;
    document.getElementById('badge-pts-next').textContent = data.pointsToNext;
    var barPct = ((data.score % 100) / 100) * 100;
    document.getElementById('badge-progress-bar').style.width = barPct + '%';

    // earned codes Set
    var earnedSet = {};
    (data.earnedBadges || []).forEach(function (b) { earnedSet[b.code] = true; });

    // Grid (最初の10個まで表示)
    var html = '';
    var badges = (data.allBadges || []).slice(0, 10);
    badges.forEach(function (b) {
      var earned = !!earnedSet[b.code];
      var cls = earned
        ? 'bg-green-50 rounded-lg border-2 border-green-200'
        : 'bg-gray-50 rounded-lg border border-gray-200 opacity-40';
      html += '<div class="aspect-square flex flex-col items-center justify-center ' + cls + '" title="' + (b.description || '').replace(/"/g, '') + '">' +
        '<span class="text-xl">' + (b.icon || '🎖') + '</span>' +
        '<span class="text-[10px] ' + (earned ? '' : 'text-gray-400') + ' mt-1 px-1 text-center leading-tight">' + b.name + '</span>' +
        '</div>';
    });
    document.getElementById('badge-grid').innerHTML = html;
  } catch { cardError(document.getElementById('badge-grid'), null, 'loadBadges'); }
}

async function loadTodayIntake() {
  if (isDemo) {
    var num = document.getElementById('intake-streak-num');
    if (num) num.textContent = '6';
    return;
  }
  try {
    const json = await apiGet('/api/liff/intake/today');
    // 失敗は「0日」に化けさせない (401 は apiGet 中央検知が全画面誘導)
    if (apiFailed(json)) {
      var errNum = document.getElementById('intake-streak-num');
      if (errNum) errNum.textContent = '-';
      return;
    }
    if (json && json.data && json.data.recorded) {
      ['breakfast', 'lunch', 'dinner'].forEach(function (m) {
        if (json.data.recorded[m]) markMealDone(m);
      });
    }
    // streak 取得 (HTTP エラーも「-」に倒す — 服用ボタン記録済みなのに streak だけ古い部分不整合を隠さない)
    const streakRes = await api('/api/liff/intake/streak', { days: 7 });
    var num = document.getElementById('intake-streak-num');
    if (apiFailed(streakRes)) {
      if (num) num.textContent = '-';
    } else if (streakRes && streakRes.data && typeof streakRes.data.currentStreak === 'number') {
      // 採点R2: endpoint は streak をトップレベルに spread する flat shape (data.streak は存在しない)
      if (num) num.textContent = streakRes.data.currentStreak;
    }
  } catch {
    var errNum2 = document.getElementById('intake-streak-num');
    if (errNum2) errNum2.textContent = '-';
  }
}

// ─── Reminders (複数対応) ───
var remindersData = [];
var PRESET_LABELS = ['朝食前', '昼食前', '夕食前', '就寝前', 'カスタム'];

function renderReminders() {
  var el = document.getElementById('reminders-list');
  if (remindersData.length === 0) {
    el.innerHTML = '<p class="text-xs text-gray-400 text-center py-2">リマインダーが設定されていません</p>';
    return;
  }
  el.innerHTML = remindersData.map(function(r) {
    var activeClass = r.isActive ? 'bg-green-500' : 'bg-gray-300';
    var knobPos = r.isActive ? 'right:2px' : 'left:2px';
    return '<div class="flex items-center gap-2 p-2 bg-gray-50 rounded-lg" data-rid="' + esc(r.id) + '">' +
      '<div class="flex-1">' +
      '<p class="text-xs font-bold text-gray-700">' + esc(r.label || '未設定') + '</p>' +
      '<input type="time" value="' + esc(r.reminderTime) + '" class="text-lg font-bold text-gray-800 bg-transparent border-none p-0" ' +
      'onchange="updateReminderTime(\\'' + esc(r.id) + '\\', this.value)">' +
      '</div>' +
      '<button onclick="toggleReminderById(\\'' + r.id + '\\')" class="w-10 h-6 ' + activeClass + ' rounded-full relative transition-colors">' +
      '<div class="w-5 h-5 bg-white rounded-full absolute top-0.5 shadow" style="' + knobPos + '"></div></button>' +
      '<button onclick="deleteReminderById(\\'' + r.id + '\\')" class="text-gray-400 text-lg px-1">&times;</button>' +
      '</div>';
  }).join('');
}

async function initReminder() {
  if (isDemo) {
    remindersData = [
      { id: 'demo1', label: '朝食前', reminderTime: '08:00', isActive: true },
      { id: 'demo2', label: '昼食前', reminderTime: '12:00', isActive: true },
      { id: 'demo3', label: '夕食前', reminderTime: '18:00', isActive: false },
    ];
    renderReminders();
    return;
  }
  try {
    var res = await apiGet('/api/liff/intake/reminders');
    // 採点R1: error-as-empty の残存を解消 (HTTP エラーを「未設定」に化けさせない)
    if (apiFailed(res)) { cardError(document.getElementById('reminders-list'), res, 'initReminder'); return; }
    remindersData = res.data || [];
    renderReminders();
  } catch { cardError(document.getElementById('reminders-list'), null, 'initReminder'); }
}

async function addReminderSlot() {
  if (remindersData.length >= 5) { showToast('最大5件までです'); return; }
  if (isDemo) {
    remindersData.push({ id: 'demo' + Date.now(), label: PRESET_LABELS[remindersData.length] || 'カスタム', reminderTime: '12:00', isActive: true });
    renderReminders();
    showToast('DEMO: 追加しました');
    return;
  }
  var label = PRESET_LABELS[remindersData.length] || 'カスタム';
  var defaultTime = remindersData.length === 0 ? '08:00' : remindersData.length === 1 ? '12:00' : '18:00';
  try {
    var res = await api('/api/liff/intake/reminders/add', { label: label, reminderTime: defaultTime });
    if (res.success && res.data) {
      remindersData.push(res.data);
      renderReminders();
      showToast(label + ' (' + defaultTime + ') を追加しました');
    } else {
      showToast(res.error || '追加に失敗しました');
    }
  } catch { showToast('追加に失敗しました'); }
}

async function updateReminderTime(id, newTime) {
  if (isDemo) { showToast('DEMO: ' + newTime + ' に変更'); return; }
  try {
    var r = await fetch(API_BASE + '/api/liff/intake/reminders/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: 'Bearer ' + idToken } : {}) },
      body: JSON.stringify({ reminderTime: newTime }),
    });
    if (!r.ok) { showToast('変更に失敗しました'); return; } // 採点R1: false-success 防止
    var item = remindersData.find(function(r2) { return r2.id === id; });
    if (item) item.reminderTime = newTime;
    showToast(newTime + ' に変更しました');
  } catch { showToast('変更に失敗しました'); }
}

async function toggleReminderById(id) {
  var item = remindersData.find(function(r) { return r.id === id; });
  if (!item) return;
  var newActive = !item.isActive;
  if (isDemo) { item.isActive = newActive; renderReminders(); showToast('DEMO: ' + (newActive ? 'ON' : 'OFF')); return; }
  try {
    var r = await fetch(API_BASE + '/api/liff/intake/reminders/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: 'Bearer ' + idToken } : {}) },
      body: JSON.stringify({ isActive: newActive }),
    });
    if (!r.ok) { showToast('変更に失敗しました'); return; } // 採点R1: false-success 防止
    item.isActive = newActive;
    renderReminders();
    showToast(newActive ? 'ONにしました' : 'OFFにしました');
  } catch { showToast('変更に失敗しました'); }
}

async function deleteReminderById(id) {
  if (isDemo) { remindersData = remindersData.filter(function(r) { return r.id !== id; }); renderReminders(); showToast('DEMO: 削除しました'); return; }
  try {
    var r = await fetch(API_BASE + '/api/liff/intake/reminders/' + id, {
      method: 'DELETE',
      headers: idToken ? { Authorization: 'Bearer ' + idToken } : {},
    });
    if (!r.ok) { showToast('削除に失敗しました'); return; } // 採点R1: false-success 防止
    remindersData = remindersData.filter(function(r2) { return r2.id !== id; });
    renderReminders();
    showToast('削除しました');
  } catch { showToast('削除に失敗しました'); }
}

// ─── HEALTH Section ───
var selectedMood = null;
var selectedSkin = null;
var selectedBowel = null;
var bowelCount = 0;
var healthCharts = {};

function switchHealthView(view) {
  document.getElementById('health-record-view').style.display = view === 'record' ? 'block' : 'none';
  document.getElementById('health-graph-view').style.display = view === 'graph' ? 'block' : 'none';
  document.getElementById('htab-record').className = 'flex-1 py-2 text-xs font-bold rounded-xl transition-all ' + (view === 'record' ? 'bg-white shadow-sm text-emerald-600' : 'text-gray-400');
  document.getElementById('htab-graph').className = 'flex-1 py-2 text-xs font-bold rounded-xl transition-all ' + (view === 'graph' ? 'bg-white shadow-sm text-emerald-600' : 'text-gray-400');
  if (view === 'graph') loadGraph(30);
}

async function loadHealthData() {
  document.getElementById('health-date-label').textContent = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
  // Load today's existing record if any
  try {
    var res = await api('/api/liff/health/logs', { days: 1 });
    if (apiFailed(res)) { loadErrorToast(res, '体調データを読み込めませんでした'); return; }
    var data = res.data;
    if (data && data.logs && data.logs.length > 0) {
      var latestLog = data.logs[0];
      // 採点R2: log_date を確認せず昨日のログを「今日の記録」として prefill していた →
      //   本日 (JST) のログのみ prefill。体重だけは前回値を初期値として引き継ぐ (入力補助)。
      var jstToday = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
      if (latestLog.weight) document.getElementById('weight-input').value = latestLog.weight;
      if (String(latestLog.log_date || '').slice(0, 10) === jstToday) {
        if (latestLog.mood) setMood(latestLog.mood);
        if (latestLog.skin_condition) setSkin(latestLog.skin_condition);
        if (latestLog.bowel_form) setBowel(latestLog.bowel_form);
        if (latestLog.bowel_count) { bowelCount = latestLog.bowel_count; document.getElementById('bowel-count-display').textContent = bowelCount; }
        if (latestLog.sleep_hours) { document.getElementById('sleep-slider').value = latestLog.sleep_hours; updateSleepDisplay(); }
        if (latestLog.note) document.getElementById('health-note').value = latestLog.note;
      }
    }
  } catch { showToast('体調データを読み込めませんでした'); }
}

function adjustWeight(delta) {
  var el = document.getElementById('weight-input');
  var v = parseFloat(el.value) || 55.0;
  v = Math.round((v + delta) * 10) / 10;
  if (v >= 30 && v <= 200) el.value = v.toFixed(1);
}

function setMood(mood) {
  selectedMood = mood;
  document.querySelectorAll('.mood-btn').forEach(function(b) {
    var active = b.getAttribute('data-mood') === mood;
    b.style.borderColor = active ? '#2fa8ad' : 'transparent';
    b.style.background = active ? '#eef7f7' : 'transparent';
  });
}

function setSkin(skin) {
  selectedSkin = skin;
  var colors = { good: '#2fa8ad', normal: '#eab308', bad: '#ef4444' };
  document.querySelectorAll('.skin-btn').forEach(function(b) {
    var active = b.getAttribute('data-skin') === skin;
    b.style.borderColor = active ? (colors[skin] || '#2fa8ad') : 'transparent';
    b.style.background = active ? '#f9fafb' : '#f9fafb';
    b.style.fontWeight = active ? '700' : '400';
  });
}

function setBowel(form) {
  selectedBowel = form;
  document.querySelectorAll('.bowel-btn').forEach(function(b) {
    var active = b.getAttribute('data-bowel') === form;
    b.style.borderColor = active ? '#2fa8ad' : 'transparent';
    b.style.background = active ? '#eef7f7' : '#f9fafb';
  });
  if (bowelCount === 0) { bowelCount = 1; document.getElementById('bowel-count-display').textContent = '1'; }
}

function adjustBowelCount(delta) {
  bowelCount = Math.max(0, Math.min(10, bowelCount + delta));
  document.getElementById('bowel-count-display').textContent = bowelCount;
  if (bowelCount === 0) { selectedBowel = null; document.querySelectorAll('.bowel-btn').forEach(function(b) { b.style.borderColor = 'transparent'; b.style.background = '#f9fafb'; }); }
}

function updateSleepDisplay() {
  var v = parseFloat(document.getElementById('sleep-slider').value);
  document.getElementById('sleep-display').textContent = v.toFixed(1) + 'h';
}

async function saveHealthLog() {
  if (isDemo) { showToast('DEMO: 体調を記録しました'); return; }
  var weight = parseFloat(document.getElementById('weight-input').value);
  var sleepHours = parseFloat(document.getElementById('sleep-slider').value);
  var note = document.getElementById('health-note').value;
  try {
    var res = await api('/api/liff/health/log', {
      weight: isNaN(weight) ? undefined : weight,
      condition: selectedMood === 'great' || selectedMood === 'good' ? 'good' : selectedMood === 'normal' ? 'normal' : selectedMood ? 'bad' : undefined,
      skinCondition: selectedSkin || undefined,
      sleepHours: sleepHours || undefined,
      bowelForm: selectedBowel || undefined,
      bowelCount: bowelCount > 0 ? bowelCount : undefined,
      mood: selectedMood || undefined,
      note: note || undefined,
    });
    if (apiFailed(res)) { showToast('記録に失敗しました'); return; } // 採点R1: false-success 防止
    showToast('記録しました！');
  } catch { showToast('記録に失敗しました'); }
}

// ─── Graph functions ───
var currentGraphDays = 30;
function retryGraph() { loadGraph(currentGraphDays); }
async function loadGraph(days) {
  currentGraphDays = days;
  // Update period button styles
  document.querySelectorAll('.graph-period-btn').forEach(function(b) {
    var d = parseInt(b.getAttribute('data-days'));
    b.className = 'graph-period-btn flex-1 py-1.5 text-xs rounded-xl ' + (d === days ? 'bg-white shadow-sm font-bold text-emerald-600' : 'text-gray-400');
  });

  try {
    var res = await api('/api/liff/health/trends', { days: days });
    if (apiFailed(res)) { cardError(document.getElementById('health-stats'), res, 'retryGraph'); return; }
    var data = res.data;
    if (!data || !data.trends) return;
    var trends = data.trends;
    var labels = trends.map(function(t) { return t.log_date.slice(5); });

    // Weight chart
    renderLineChart('weight-chart', 'weightChart', labels,
      trends.map(function(t) { return t.weight; }),
      'rgba(47,168,173,1)', 'rgba(47,168,173,0.1)', 'kg');

    // Show weight change
    var weights = trends.filter(function(t) { return t.weight !== null; });
    var wcEl = document.getElementById('weight-change');
    if (weights.length >= 2) {
      var diff = weights[weights.length - 1].weight - weights[0].weight;
      var sign = diff > 0 ? '+' : '';
      var color = diff < 0 ? 'text-green-600' : diff > 0 ? 'text-red-500' : 'text-gray-500';
      wcEl.innerHTML = '<span class="text-xs ' + color + '">' + sign + diff.toFixed(1) + 'kg（期間中の変化）</span>';
    } else { wcEl.innerHTML = ''; }

    // Condition chart (mood mapped to numbers: great=5,good=4,normal=3,bad=2,terrible=1)
    var moodMap = { great: 5, good: 4, normal: 3, bad: 2, terrible: 1 };
    var condMap = { good: 4, normal: 3, bad: 2 };
    renderBarChart('condition-chart', 'condChart', labels, [
      { label: '気分', data: trends.map(function(t) { return t.mood ? moodMap[t.mood] : null; }), color: 'rgba(47,168,173,0.7)' },
      { label: '肌', data: trends.map(function(t) { return t.skin_condition ? condMap[t.skin_condition] : null; }), color: 'rgba(168,85,247,0.7)' },
    ]);

    // Sleep chart
    renderLineChart('sleep-chart', 'sleepChart', labels,
      trends.map(function(t) { return t.sleep_hours; }),
      'rgba(59,130,246,1)', 'rgba(59,130,246,0.1)', 'h');

    // Stats summary
    renderHealthStats(trends, days);
  } catch { cardError(document.getElementById('health-stats'), null, 'retryGraph'); }
}

function renderLineChart(canvasId, chartKey, labels, data, borderColor, bgColor, unit) {
  if (healthCharts[chartKey]) healthCharts[chartKey].destroy();
  var ctx = document.getElementById(canvasId).getContext('2d');
  healthCharts[chartKey] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{ data: data, borderColor: borderColor, backgroundColor: bgColor, fill: true, tension: 0.3, pointRadius: data.length > 60 ? 0 : 3, borderWidth: 2, spanGaps: true }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(c) { return c.parsed.y + unit; } } } },
      scales: { x: { ticks: { maxTicksLimit: 7, font: { size: 10 } } }, y: { ticks: { font: { size: 10 } } } }
    }
  });
}

function renderBarChart(canvasId, chartKey, labels, datasets) {
  if (healthCharts[chartKey]) healthCharts[chartKey].destroy();
  var ctx = document.getElementById(canvasId).getContext('2d');
  healthCharts[chartKey] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: datasets.map(function(ds) {
        return { label: ds.label, data: ds.data, backgroundColor: ds.color, borderRadius: 3, barPercentage: 0.6 };
      })
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 10 } } } },
      scales: {
        x: { ticks: { maxTicksLimit: 7, font: { size: 10 } } },
        y: { min: 0, max: 5, ticks: { stepSize: 1, font: { size: 10 }, callback: function(v) { return ['','最悪','悪い','普通','良い','最高'][v] || ''; } } }
      }
    }
  });
}

function renderHealthStats(trends, days) {
  var el = document.getElementById('health-stats');
  var weights = trends.filter(function(t) { return t.weight !== null; });
  var sleeps = trends.filter(function(t) { return t.sleep_hours !== null; });
  var avgW = weights.length > 0 ? (weights.reduce(function(s, t) { return s + t.weight; }, 0) / weights.length).toFixed(1) : '--';
  var avgS = sleeps.length > 0 ? (sleeps.reduce(function(s, t) { return s + t.sleep_hours; }, 0) / sleeps.length).toFixed(1) : '--';
  el.innerHTML = '<h4 class="text-xs font-bold text-gray-500 mb-3">期間サマリー（' + days + '日間）</h4>' +
    '<div class="grid grid-cols-3 gap-3 text-center">' +
    '<div class="bg-green-50 rounded-xl p-3"><p class="text-lg font-bold text-green-600">' + trends.length + '</p><p class="text-[10px] text-gray-500">記録日数</p></div>' +
    '<div class="bg-blue-50 rounded-xl p-3"><p class="text-lg font-bold text-blue-600">' + avgW + '<span class="text-xs">kg</span></p><p class="text-[10px] text-gray-500">平均体重</p></div>' +
    '<div class="bg-purple-50 rounded-xl p-3"><p class="text-lg font-bold text-purple-600">' + avgS + '<span class="text-xs">h</span></p><p class="text-[10px] text-gray-500">平均睡眠</p></div></div>';
}

// ─── REFERRAL + Sharing ───
async function loadReferralCard() {
  var el = document.getElementById('referral-card');
  try {
    const [genRes, statsRes] = await Promise.all([
      api('/api/liff/referral/generate'),
      api('/api/liff/referral/stats'),
    ]);
    if (apiFailed(genRes)) { cardError(el, genRes, 'loadReferralCard'); return; }
    var refCode = genRes.data ? genRes.data.refCode : null;
    var stats = (statsRes && statsRes.data) || {};
    if (!refCode) {
      el.innerHTML = '<p class="text-xs text-gray-400">紹介リンクを取得できませんでした</p>';
      return;
    }
    // 共有URLは liff.line.me permalink — workers.dev の生 URL (katsu-7d5 等) は顧客に不信感を与え離脱要因。
    // liff.line.me は LINE 内で最も自然に開け、?ref= は liff.state 経由で endpoint に復元される (#rank 導線と同機構)。
    var shareUrl = LIFF_ID ? 'https://liff.line.me/' + LIFF_ID + '?ref=' + refCode : (window.location.origin + '/liff/portal?ref=' + refCode);
    // 実機FB第5弾: 「ボタンを押した人は興味がある」→ お得感を演出するヒーローカードへ刷新。
    //   動くグラデ枠 + シャイン + 弾む🎁 + ¥500 大数字 + 3ステップ図。主役は「LINEで送る」1本、
    //   コピーは LINE 外シェア (Instagram/X/メール等) 用に小さなテキストリンクへ降格。
    el.style.padding = '0'; el.style.background = 'transparent'; el.style.border = 'none'; el.style.boxShadow = 'none';
    el.innerHTML = '<div class="ref-hero"><div class="ref-hero-inner">' +
      '<div class="flex items-center gap-2 mb-2">' +
      '<span class="ref-gift" style="font-size:24px">🎁</span>' +
      '<span class="chip-coral px-2 py-0.5 rounded-full" style="font-size:10px;font-weight:700">友だち紹介プログラム</span></div>' +
      '<p class="text-sm font-bold text-gray-700">お友だちに</p>' +
      '<p class="mb-1"><span class="ref-500">¥500</span><span class="text-sm font-bold" style="color:#b84a2e"> OFFクーポンをプレゼント</span></p>' +
      (REFERRAL_REWARD_ON ? '<p class="text-xs font-bold mt-1" style="color:#0f766e">👑 お友だちがクーポンで購入すると、あなたにも ¥500</p>' : '') +
      '<div class="grid grid-cols-3 gap-1.5 mt-3 mb-3">' +
      '<div class="ref-step"><p style="font-size:18px">📮</p><p style="font-size:10px;color:#64748b;font-weight:700">リンクを送る</p></div>' +
      '<div class="ref-step"><p style="font-size:18px">👋</p><p style="font-size:10px;color:#64748b;font-weight:700">友だち追加</p></div>' +
      '<div class="ref-step"><p style="font-size:18px">🎉</p><p style="font-size:10px;color:#64748b;font-weight:700">クーポンGET</p></div></div>' +
      '<button onclick="shareRefLine()" class="w-full py-3.5 rounded-xl text-sm font-bold text-white" style="background:#06C755">LINEで送る</button>' +
      '<p class="text-center mt-2"><a href="javascript:void(0)" onclick="copyRefLink()" class="text-xs text-gray-400 underline">リンクをコピー (LINE以外で送る)</a></p>' +
      '<span id="ref-url" style="display:none">' + esc(shareUrl) + '</span>' +
      (stats.totalReferred > 0 ? '<p class="text-xs text-gray-500 mt-2 text-center">これまでの紹介: <span class="font-bold text-coral">' + stats.totalReferred + '人</span></p>' : '') +
      '</div></div>';
  } catch { cardError(el, null, 'loadReferralCard'); }
}

function copyRefLink() {
  var span = document.getElementById('ref-url');
  var url = span ? span.textContent : '';
  // 採点R1: clipboard 失敗時の silent dead-end を解消 — URL を可視・選択可能にして手動コピーへ degrade
  function fallbackShowUrl() {
    showToast('コピーできませんでした。URLを長押しでコピーしてください');
    if (span) { span.style.display = 'block'; span.className = 'text-xs break-all select-all text-gray-500 mt-2'; }
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() { showToast('コピーしました!'); }).catch(fallbackShowUrl);
    } else { fallbackShowUrl(); }
  } catch (e) { fallbackShowUrl(); }
}

function openLineShare(msg) {
  // shareTargetPicker 未対応時のフォールバック: コピーで終わらせず LINE 公式の共有URLを開く。
  // (https://line.me/R/share?text= は外部ブラウザでも LINE in-app でも共有シートを起動する)
  var shareUrl = 'https://line.me/R/share?text=' + encodeURIComponent(msg);
  if (typeof liff !== 'undefined' && liff.openWindow) {
    liff.openWindow({ url: shareUrl, external: true });
  } else {
    window.location.href = shareUrl;
  }
}

function shareRefLine() {
  var url = document.getElementById('ref-url').textContent;
  // gate 連動 (実機FB第5弾): 紹介報酬 (referrer 側 ¥500) が有効化されたら承認済コピー A' に自動切替。
  //   off の間は referred 側 (= welcome ¥500、稼働中) のみを約束する文言 (景表法セーフ)。
  var msg = REFERRAL_REWARD_ON
    ? '🎁ナチュリズムの500円クーポン、おすそ分け!\\nこのリンクから友だち追加するだけで、あなたにも500円クーポンが届くよ✨\\n100%植物由来のインナーケア(食事サポート)が実質¥1,876〜\\n' + url
    : 'naturismを一緒に始めませんか? 友だち追加で500円OFFクーポンがもらえます!\\n' + url;
  if (typeof liff !== 'undefined' && liff.isApiAvailable && liff.isApiAvailable('shareTargetPicker')) {
    liff.shareTargetPicker([{ type: 'text', text: msg }]).then(function(res) {
      if (res) showToast('送信しました!');
    }).catch(function() { openLineShare(msg); });
    return;
  }
  // shareTargetPicker 未対応 (LIFF console 未設定 / 外部ブラウザ) → LINE 共有シートを開く
  openLineShare(msg);
}

// ─── Ranking ───
async function loadRanking() {
  try {
    const res = await apiGet('/api/liff/referral/ranking');
    // 任意カード: 非 auth エラーは非表示のまま (401 は apiGet 中央検知が全画面誘導)
    if (apiFailed(res)) return;
    const data = res.data;
    var el = document.getElementById('ranking-card');
    if (!data || data.length === 0) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    var html = '<p class="text-xs text-gray-500 font-bold mb-3">紹介ランキング TOP10</p>';
    data.forEach(function(r) {
      var medal = r.rank === 1 ? '&#x1F947;' : r.rank === 2 ? '&#x1F948;' : r.rank === 3 ? '&#x1F949;' : r.rank + '.';
      html += '<div class="flex items-center gap-3 py-2 border-b last:border-0">' +
        '<span class="text-sm w-8 text-center">' + medal + '</span>' +
        '<span class="text-sm text-gray-800 flex-1">' + esc(r.displayName) + '</span>' +
        '<span class="text-sm font-bold text-green-600">' + r.referralCount + '人</span></div>';
    });
    el.innerHTML = html;
  } catch { /* ignore */ }
}

// ─── Ambassador Section ───
var ambassadorData = null;
var fbRating = 0;

async function loadAmbassador() {
  try {
    const res = await api('/api/liff/ambassador/status');
    // 任意セクション: 非 auth エラーは非表示のまま (401 は api 中央検知が全画面誘導)
    if (apiFailed(res)) return;
    const data = res.data;
    if (!data || data.status !== 'active') {
      document.getElementById('ambassador-section').style.display = 'none';
      return;
    }
    ambassadorData = data;
    document.getElementById('ambassador-section').style.display = 'block';

    var tierIcons = { standard: '&#x1F331;', bronze: '&#x1F949;', silver: '&#x1F948;', gold: '&#x1F947;', platinum: '&#x1F451;', premium: '&#x2B50;' };
    var tierNames = { standard: 'スタンダード', bronze: 'ブロンズ', silver: 'シルバー', gold: 'ゴールド', platinum: 'プラチナ', premium: 'プレミアム' };
    var el = document.getElementById('ambassador-status-card');
    el.classList.add('rank-ambassador');
    el.innerHTML = '<div class="sparkle-dots">' +
      '<div class="sparkle-dot" style="top:10%;left:90%;animation-delay:0s"></div>' +
      '<div class="sparkle-dot" style="top:40%;left:5%;animation-delay:0.5s"></div>' +
      '<div class="sparkle-dot" style="top:75%;left:80%;animation-delay:1s"></div></div>' +
      '<div class="flex items-center gap-3 mb-3" style="position:relative;z-index:1">' +
      '<div class="w-12 h-12 rounded-full flex items-center justify-center text-2xl" style="background:linear-gradient(135deg,#fef3c7,#fde68a);box-shadow:0 2px 8px rgba(251,191,36,.25)">' + (tierIcons[data.tier] || '&#x1F331;') + '</div>' +
      '<div><p class="text-sm font-bold text-gray-800">アンバサダー <span class="ambassador-badge">&#x2728; Ambassador</span></p>' +
      '<p class="text-xs font-bold" style="color:#92400e">' + esc(tierNames[data.tier] || data.tier) + '</p></div></div>' +
      '<div class="grid grid-cols-3 gap-2 text-center" style="position:relative;z-index:1">' +
      '<div class="bg-yellow-50 rounded-lg p-2"><p class="text-lg font-bold text-gray-800">' + (data.surveysCompleted || 0) + '</p><p class="text-xs text-gray-500">回答数</p></div>' +
      '<div class="bg-yellow-50 rounded-lg p-2"><p class="text-lg font-bold text-gray-800">' + (data.productTests || 0) + '</p><p class="text-xs text-gray-500">商品テスト</p></div>' +
      '<div class="bg-yellow-50 rounded-lg p-2"><p class="text-lg font-bold text-gray-800">' + (data.enrolledAt ? data.enrolledAt.slice(0, 10) : '-') + '</p><p class="text-xs text-gray-500">登録日</p></div></div>';

    loadFeedbackHistory();
    loadPendingSurveys();
  } catch { /* ignore */ }
}

function setFbRating(n) {
  fbRating = n;
  document.querySelectorAll('#fb-rating-stars button').forEach(function(b) {
    var star = parseInt(b.getAttribute('data-star'));
    b.style.opacity = star <= n ? '1' : '0.3';
  });
}

async function submitFeedback() {
  var content = document.getElementById('fb-content').value.trim();
  if (!content) { showToast('内容を入力してください'); return; }
  var category = document.getElementById('fb-category').value;
  var btn = document.getElementById('fb-submit-btn');
  btn.disabled = true;
  btn.textContent = '送信中...';
  try {
    var fbRes = await api('/api/liff/ambassador/feedback', {
      category: category,
      content: content,
      rating: fbRating > 0 ? fbRating : undefined,
    });
    if (apiFailed(fbRes)) { showToast((fbRes && fbRes.error) || '送信に失敗しました'); } // 採点R2: false-success 防止 (入力は保持)
    else {
      showToast('フィードバックを送信しました!');
      document.getElementById('fb-content').value = '';
      setFbRating(0);
      loadFeedbackHistory();
    }
  } catch { showToast('送信に失敗しました'); }
  btn.disabled = false;
  btn.textContent = '送信する';
}

async function loadFeedbackHistory() {
  var el = document.getElementById('fb-history');
  try {
    const res = await api('/api/liff/ambassador/feedbacks');
    if (apiFailed(res)) { cardError(el, res, 'loadFeedbackHistory'); return; }
    const data = res.data;
    if (!data || data.length === 0) {
      el.innerHTML = '<p class="text-xs text-gray-400 text-center py-2">まだフィードバックはありません</p>';
      return;
    }
    el.innerHTML = data.slice(0, 5).map(function(fb) {
      var stars = fb.rating ? '&#x2B50;'.repeat(fb.rating) : '';
      var catLabels = { general: '全般', product: '商品', service: 'サービス', suggestion: 'ご提案', other: 'その他' };
      return '<div class="py-2 border-b last:border-0">' +
        '<div class="flex justify-between items-center">' +
        '<span class="text-xs text-gray-500">' + esc(catLabels[fb.category] || fb.category) + '</span>' +
        '<span class="text-xs text-gray-400">' + esc((fb.created_at || '').slice(0, 10)) + '</span></div>' +
        (stars ? '<span class="text-xs">' + stars + '</span>' : '') +
        '<p class="text-xs text-gray-700 mt-1">' + esc(fb.content.length > 100 ? fb.content.slice(0, 100) + '...' : fb.content) + '</p></div>';
    }).join('');
  } catch { cardError(el, null, 'loadFeedbackHistory'); }
}

// ─── Ambassador Surveys ───
var currentSurvey = null;
var surveyAnswers = {};

async function loadPendingSurveys() {
  if (!ambassadorData) return;
  var card = document.getElementById('ambassador-surveys-card');
  var el = document.getElementById('pending-surveys');
  try {
    const res = await api('/api/liff/ambassador/surveys');
    if (apiFailed(res)) {
      if (card) card.style.display = 'block';
      cardError(el, res, 'loadPendingSurveys');
      return;
    }
    const data = res.data;
    if (!data || data.length === 0) {
      card.style.display = 'none';
      return;
    }
    card.style.display = 'block';
    el.innerHTML = data.map(function(s) {
      var typeLabels = { survey: 'アンケート', product_test: '商品テスト', nps: '満足度調査' };
      var typeColors = { survey: 'bg-indigo-100 text-indigo-700', product_test: 'bg-red-100 text-red-700', nps: 'bg-teal-100 text-teal-700' };
      return '<div class="p-3 bg-gray-50 rounded-xl mb-2 cursor-pointer" onclick=\\'openSurvey(' + JSON.stringify(JSON.stringify(s)) + ')\\'>' +
        '<div class="flex items-center gap-2 mb-1">' +
        '<span class="text-xs px-2 py-0.5 rounded-full ' + esc(typeColors[s.survey_type] || '') + '">' + esc(typeLabels[s.survey_type] || s.survey_type) + '</span></div>' +
        '<p class="text-sm font-bold text-gray-800">' + esc(s.title) + '</p>' +
        (s.description ? '<p class="text-xs text-gray-500 mt-1">' + esc(s.description) + '</p>' : '') +
        '<p class="text-xs text-green-600 mt-1 font-bold">' + s.questions.length + '問 &#x2192; 回答する</p></div>';
    }).join('');
  } catch {
    if (card) card.style.display = 'block';
    cardError(el, null, 'loadPendingSurveys');
  }
}

function openSurvey(jsonStr) {
  currentSurvey = JSON.parse(jsonStr);
  surveyAnswers = {};
  document.getElementById('survey-modal-title').textContent = currentSurvey.title;
  var container = document.getElementById('survey-questions-container');
  container.innerHTML = currentSurvey.questions.map(function(q, i) {
    var html = '<div class="mb-4"><p class="text-sm font-bold text-gray-800 mb-2">' + (i + 1) + '. ' + esc(q.label) + (q.required ? ' <span class="text-red-500">*</span>' : '') + '</p>';
    if (q.type === 'rating') {
      html += '<div class="flex gap-1">';
      for (var r = 1; r <= 5; r++) {
        html += '<button onclick="setSurveyRating(\\'' + esc(q.id) + '\\',' + r + ')" data-qid="' + esc(q.id) + '" data-rating="' + r + '" class="survey-star text-2xl" style="opacity:0.3;">&#x2B50;</button>';
      }
      html += '</div>';
    } else if (q.type === 'text') {
      html += '<textarea onchange="surveyAnswers[\\'' + esc(q.id) + '\\']=this.value" rows="2" class="w-full p-2 border rounded-lg text-sm" placeholder="回答を入力..."></textarea>';
    } else if (q.type === 'choice') {
      html += '<div class="space-y-1">';
      (q.options || []).forEach(function(opt) {
        html += '<label class="flex items-center gap-2 p-2 bg-gray-50 rounded-lg cursor-pointer"><input type="radio" name="sq_' + esc(q.id) + '" value="' + esc(opt) + '" onchange="surveyAnswers[\\'' + esc(q.id) + '\\']=this.value" class="accent-green-500"><span class="text-sm">' + esc(opt) + '</span></label>';
      });
      html += '</div>';
    } else if (q.type === 'multi_choice') {
      html += '<div class="space-y-1">';
      (q.options || []).forEach(function(opt) {
        html += '<label class="flex items-center gap-2 p-2 bg-gray-50 rounded-lg cursor-pointer"><input type="checkbox" value="' + esc(opt) + '" onchange="updateMultiChoice(\\'' + esc(q.id) + '\\')" data-qid="' + esc(q.id) + '" class="accent-green-500"><span class="text-sm">' + esc(opt) + '</span></label>';
      });
      html += '</div>';
    }
    html += '</div>';
    return html;
  }).join('');
  document.getElementById('survey-answer-modal').style.display = 'block';
}

function closeSurveyModal() {
  document.getElementById('survey-answer-modal').style.display = 'none';
  currentSurvey = null;
}

function setSurveyRating(qid, rating) {
  surveyAnswers[qid] = rating;
  document.querySelectorAll('.survey-star[data-qid="' + qid + '"]').forEach(function(b) {
    b.style.opacity = parseInt(b.getAttribute('data-rating')) <= rating ? '1' : '0.3';
  });
}

function updateMultiChoice(qid) {
  var checked = [];
  document.querySelectorAll('input[data-qid="' + qid + '"]:checked').forEach(function(cb) {
    checked.push(cb.value);
  });
  surveyAnswers[qid] = checked;
}

async function submitSurveyAnswers() {
  if (!currentSurvey) return;
  // Validate required
  for (var q of currentSurvey.questions) {
    if (q.required && (surveyAnswers[q.id] === undefined || surveyAnswers[q.id] === '' || (Array.isArray(surveyAnswers[q.id]) && surveyAnswers[q.id].length === 0))) {
      showToast('必須項目に回答してください: ' + q.label);
      return;
    }
  }
  var btn = document.getElementById('survey-submit-btn');
  btn.disabled = true;
  btn.textContent = '送信中...';
  try {
    var svRes = await api('/api/liff/ambassador/survey/respond', {
      surveyId: currentSurvey.id,
      answers: surveyAnswers,
    });
    if (apiFailed(svRes)) { showToast((svRes && svRes.error) || '送信に失敗しました'); } // 採点R2: 失敗時は modal を開いたまま=回答を失わない
    else {
      showToast('回答を送信しました！ありがとうございます');
      closeSurveyModal();
      loadPendingSurveys();
    }
  } catch { showToast('送信に失敗しました'); }
  btn.disabled = false;
  btn.textContent = '回答を送信';
}

// ─── Profile (gender/birthday) ───
var selectedGender = null;

function setGender(g) {
  selectedGender = g;
  document.querySelectorAll('.gender-btn').forEach(function(b) {
    var isSelected = b.getAttribute('data-gender') === g;
    b.className = 'gender-btn flex-1 py-2 rounded-lg text-xs border ' +
      (isSelected ? 'bg-green-500 text-white font-bold' : '');
  });
}

async function loadProfile() {
  try {
    const res = await apiGet('/api/liff/profile');
    if (apiFailed(res)) { loadErrorToast(res, 'プロフィールを読み込めませんでした'); return; }
    const data = res.data;
    if (!data) return;
    if (data.gender) {
      setGender(data.gender);
    }
    if (data.birthday) {
      document.getElementById('birthday-input').value = data.birthday;
    }
  } catch { showToast('プロフィールを読み込めませんでした'); }
}

async function saveProfile() {
  if (isDemo) { showToast('DEMO: プロフィールを保存しました'); return; }
  var birthday = document.getElementById('birthday-input').value;
  var body = {};
  if (selectedGender) body.gender = selectedGender;
  if (birthday) body.birthday = birthday;
  if (!body.gender && !body.birthday) { showToast('変更項目がありません'); return; }
  try {
    var res = await fetch(API_BASE + '/api/liff/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: 'Bearer ' + idToken } : {}) },
      body: JSON.stringify(body),
    });
    var json = await res.json();
    if (json.success) {
      showToast('プロフィールを保存しました');
    } else {
      showToast(json.error || '保存に失敗しました');
    }
  } catch { showToast('保存に失敗しました'); }
}

// ─── SHOP Section ───
// ─── SHOP Tab: error と empty を区別して描画 (skeleton 固着防止, 2026-07-04 実機フィードバック) ───

// 401 (idToken 失効/未送信のどちらでも) はセッション切れとして再読み込みに誘導する。
// api() が透過する HTTP status で判定 (エラー文字列の英文一致は将来の文言変更で壊れるため不使用)。
function shopAuthExpired(res) {
  return !!(res && res.status === 401);
}

function shopErrorCard(el, auth) {
  if (!el) return;
  el.innerHTML = '<div class="text-center py-6">' +
    '<p class="text-2xl mb-2">🌿</p>' +
    '<p class="text-xs text-gray-500 mb-3">' + (auth ? 'ログインの有効期限が切れました' : '読み込みに失敗しました') + '</p>' +
    (auth
      ? '<button onclick="location.reload()" class="btn-primary px-4 py-2 rounded-xl text-xs font-bold">再読み込み</button>'
      : '<button onclick="retryShopData()" class="btn-primary px-4 py-2 rounded-xl text-xs font-bold">再試行</button>') +
    '</div>';
}

function retryShopData() {
  var pel = document.getElementById('products-card');
  var oel = document.getElementById('orders-card');
  var fel = document.getElementById('fulfillments-card');
  if (pel) pel.innerHTML = '<div class="skeleton h-48 rounded-lg"></div>';
  if (oel) oel.innerHTML = '<div class="skeleton h-24 rounded-lg"></div>';
  if (fel) fel.innerHTML = '<div class="skeleton h-24 rounded-lg"></div>';
  loadShopData();
}

async function loadShopData() {
  // demo モードは init 時に renderDemoData がカードを描画済み — 上書きしない
  if (isDemo) return;
  var pel = document.getElementById('products-card');
  var oel = document.getElementById('orders-card');
  var fel = document.getElementById('fulfillments-card');

  // 採点R1: 配送ヒーローの取得を商品/注文と並列化 (#delivery 直行時の体感短縮)
  var res = null, fres = null;
  try {
    var pair = await Promise.all([
      api('/api/liff/reorder').catch(function() { return null; }),
      api('/api/liff/fulfillments').catch(function() { return null; }),
    ]);
    res = pair[0]; fres = pair[1];
  } catch (e) { /* 個別 catch 済のため到達しない */ }
  if (res && res.data) {
    var data = res.data;
    // 再注文シートが参照する注文リスト (variant_id 入り lineItems を保持)
    window.__liffOrders = data.recentOrders || [];
    // Products
    if (data.products && data.products.length > 0) {
      pel.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-3">商品ラインナップ</p>' +
        data.products.map(function(p) {
          return '<div class="flex items-center gap-3 py-3 border-b last:border-0">' +
            (p.imageUrl ? '<img src="' + esc(p.imageUrl) + '" class="w-16 h-16 rounded-lg object-cover">' : '<div class="w-16 h-16 rounded-lg bg-gray-100"></div>') +
            '<div class="flex-1"><p class="text-sm font-bold text-gray-800">' + esc(p.title) + '</p>' +
            '<p class="text-sm text-green-600 font-bold">¥' + Number(p.price).toLocaleString() + '</p></div>' +
            '<a href="' + esc(p.storeUrl) + '" target="_blank" class="tap text-xs text-green-600 border border-green-600 px-3 py-1 rounded-full">購入</a></div>';
        }).join('');
    } else {
      pel.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-2">商品ラインナップ</p>' +
        '<p class="text-xs text-gray-400">商品情報を準備中です。しばらくしてからお試しください。</p>';
    }
    // Orders (採点R1 HIGH: 注文行にワンタップ再注文 — 既存 /api/liff/reorder/create (Draft Order) を配線)
    if (data.recentOrders && data.recentOrders.length > 0) {
      oel.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-2">最近の注文</p>' +
        data.recentOrders.map(function(o) {
          // 採点R3: 商品名サマリで「何を再注文するか」を明示 (blind action 解消、API は lineItems を返却済)
          var itemsLabel = (o.lineItems && o.lineItems.length)
            ? esc(o.lineItems[0].name || '') + (o.lineItems.length > 1 ? ' 他' + (o.lineItems.length - 1) + '点' : '')
            : '';
          return '<div class="py-2 border-b last:border-0">' +
            '<div class="flex justify-between items-center"><p class="text-sm font-bold">#' + esc(o.orderNumber) + '</p>' +
            '<p class="text-sm text-green-600 font-bold">¥' + Number(o.totalPrice).toLocaleString() + '</p></div>' +
            (itemsLabel ? '<p class="text-xs text-gray-500 truncate">' + itemsLabel + '</p>' : '') +
            '<div class="flex justify-between items-center mt-0.5"><p class="text-xs text-gray-400">' + esc((o.createdAt || '').slice(0, 10)) + '</p>' +
            (o.id ? '<button onclick="reorderFromOrder(this)" data-order-id="' + esc(o.id) + '" class="tap text-xs font-bold text-teal-700 rounded-full px-3 py-1" style="border:1px solid #bfe8e3;background:#effaf8">🔄 この注文を再注文</button>' : '') +
            '</div></div>';
        }).join('');
    } else {
      oel.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-2">最近の注文</p>' +
        '<p class="text-xs text-gray-400">まだ注文がありません</p>';
    }
  } else {
    var auth = shopAuthExpired(res);
    shopErrorCard(pel, auth);
    shopErrorCard(oel, auth);
    if (auth) { shopErrorCard(fel, true); return; }
  }

  // Fulfillments (エラーは「配送情報はありません」に化けさせない)
  //   実機FB第5弾: リッチメニュー「配送状況をみる」(#delivery) からワンタップで
  //   「最新の注文の配送状況」が即読める hero 表示 (ステータス日本語化 + 進捗ステップ + 追跡ボタン)。
  if (fres && fres.data) {
    if (fres.data.fulfillments && fres.data.fulfillments.length > 0) {
      // hero はキャンセル済みでない最新を優先 (無ければ先頭)
      var flist = fres.data.fulfillments;
      var latest = null;
      for (var fi = 0; fi < flist.length; fi++) {
        if (String(flist[fi].status || '').toLowerCase() !== 'cancelled') { latest = flist[fi]; break; }
      }
      if (!latest) latest = flist[0];
      var rest = flist.filter(function(x) { return x !== latest; }).slice(0, 2);
      fel.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-2">🚚 配送状況</p>' +
        renderFulfillHero(latest) +
        (rest.length ? '<p class="text-xs text-gray-400 font-bold mt-3 mb-1">それ以前のお届け</p>' +
          rest.map(function(f) {
            return '<div class="py-2 border-b last:border-0 flex justify-between items-center">' +
              '<p class="text-sm text-gray-600">#' + esc(f.orderNumber) + '</p>' +
              '<span class="text-xs px-2 py-0.5 rounded-full ' + fulfillBadgeClass(f.status) + '">' + fulfillStatusJa(f.status) + '</span></div>';
          }).join('') : '');
    } else if (fres.data.latestOrder) {
      // 2026-07-30 ゼロクリック配送状況: 発送前 (入金待ち/支払い済み/発送準備中) でも
      // 最新注文のステータスをこの画面だけで確認できる (Shopify へ遷移不要)。
      fel.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-2">🚚 配送状況</p>' +
        renderOrderHero(fres.data.latestOrder);
    } else {
      fel.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-2">🚚 配送状況</p>' +
        '<p class="text-sm text-gray-500">現在配送中のお荷物はありません。</p>' +
        '<p class="text-xs text-gray-400 mt-1">ご注文いただくと、ここでお届け状況をご確認いただけます。</p>';
    }
  } else {
    shopErrorCard(fel, shopAuthExpired(fres));
  }

  // #delivery / #reorder 直行時: 描画後にもう一度スクロール (skeleton→実カードのレイアウトシフト補正)
  if (window.__pendingDeliveryScroll) {
    window.__pendingDeliveryScroll = false;
    setTimeout(function() { if (fel) fel.scrollIntoView({ behavior: 'smooth' }); }, 80);
  }
  if (window.__pendingReorderScroll) {
    window.__pendingReorderScroll = false;
    setTimeout(function() { if (oel) oel.scrollIntoView({ behavior: 'smooth' }); }, 80);
  }
}

// 再注文ショートカット (2026-07-30 オーナー実機FB「タップしても何も起きない」):
// 旧実装は素の scrollIntoView のみで、①注文履歴が空だと何も起きないように見える
// ②着地位置が sticky ヘッダー+タブ (約110px) に隠れる ③着地後に何をすべきか案内が無い。
// → 空なら誘導トースト / 有れば オフセット付きスクロール + カードを一時ハイライト + 使い方トースト。
function reorderShortcut() {
  var el = document.getElementById('orders-card');
  if (!el) return;
  var hasOrders = !!el.querySelector('[data-order-id]');
  if (!hasOrders) {
    showToast('まだ注文履歴がありません。初回のご注文後にご利用いただけます');
    return;
  }
  var y = el.getBoundingClientRect().top + window.pageYOffset - 110; /* sticky header+tab 分 */
  window.scrollTo({ top: y, behavior: 'smooth' });
  el.style.transition = 'box-shadow .4s';
  el.style.boxShadow = '0 0 0 3px rgba(47,168,173,.55)';
  setTimeout(function () { el.style.boxShadow = ''; }, 1600);
  showToast('ご注文の「🔄 この注文を再注文」からワンタップで再注文できます');
}

// ─── 再注文シート (2026-07-30): 前回と同じ内容で最少タップ再注文 ───
// 「この注文を再注文」→ シートで 配送方法 (宅配便/ネコポス) と お届け日時 だけ選び
// 「この内容で注文へ進む」→ Draft Order 作成 → チェックアウト (住所・支払いは前回情報のまま)。
// 迷いポイントを2つに絞り、変更系 (送り先/内容/支払い) はグレーの脇役ボタンに退避。
var rosOrder = null;        // シート対象の注文 (window.__liffOrders の行)
var rosShip = 'takkyubin';  // 既定=宅配便 (そのまま進めば最短2タップでチェックアウト)
var rosSubmitting = false;

function reorderFromOrder(btn) {
  var orderId = btn && btn.getAttribute('data-order-id');
  if (!orderId) return;
  var list = window.__liffOrders || [];
  rosOrder = null;
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].id) === String(orderId)) { rosOrder = list[i]; break; }
  }
  if (!rosOrder) { showToast('注文情報を取得できませんでした。再読み込みしてお試しください'); return; }
  openReorderSheet();
}

function openReorderSheet() {
  rosShip = 'takkyubin';
  rosSubmitting = false;
  rosApplyShip();
  var items = rosOrder.lineItems || [];
  var label = items.length ? (items[0].name || items[0].title || '') + (items.length > 1 ? ' 他' + (items.length - 1) + '点' : '') : '';
  document.getElementById('ros-summary').textContent =
    '前回のご注文 #' + rosOrder.orderNumber + (label ? '（' + label + '）' : '') +
    ' ¥' + Number(rosOrder.totalPrice).toLocaleString() + ' と同じ内容でご用意します';
  // お届け希望日の範囲: 3日後〜30日後 (JST)。既定は指定なし = 追加タップ0
  var jstNowMs = Date.now() + 9 * 3600 * 1000;
  function fmt(ms) { return new Date(ms).toISOString().slice(0, 10); }
  var dateEl = document.getElementById('ros-date');
  dateEl.value = '';
  dateEl.min = fmt(jstNowMs + 3 * 86400 * 1000);
  dateEl.max = fmt(jstNowMs + 30 * 86400 * 1000);
  document.getElementById('ros-time').value = '';
  var btn = document.getElementById('ros-submit');
  btn.disabled = false;
  btn.textContent = 'この内容で注文へ進む →';
  document.getElementById('reorder-sheet').style.display = 'block';
}

function closeReorderSheet() {
  document.getElementById('reorder-sheet').style.display = 'none';
}

function rosPickShip(method) {
  rosShip = method;
  rosApplyShip();
}

function rosApplyShip() {
  var btns = document.querySelectorAll('#ros-ship .ros-seg-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('is-on', btns[i].getAttribute('data-ship') === rosShip);
  }
  // ネコポスはポスト投函 = 日時指定不可 (ヤマトの実仕様。サーバー側でも同じガードあり)
  var isNeko = rosShip === 'nekopos';
  document.getElementById('ros-datetime').classList.toggle('is-disabled', isNeko);
  document.getElementById('ros-nekopos-note').style.display = isNeko ? 'block' : 'none';
}

// 注文内容を変更 → 前回と同じ中身を積んだカートを開く (数量変更・追加はストア側で自由に)
function rosEditItems() {
  var items = (rosOrder && rosOrder.lineItems) || [];
  var parts = [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].variant_id) parts.push(items[i].variant_id + ':' + (Number(items[i].quantity) || 1));
  }
  var url = parts.length ? 'https://naturism-diet.com/cart/' + parts.join(',') : 'https://naturism-diet.com/';
  closeReorderSheet();
  openExternalUrl(url);
}

// 採点R2 前例踏襲: LINE iOS in-app browser の popup block 対策で liff.openWindow 優先 →
// window.open は戻り値 null 判定 → 最後は同タブ遷移に degrade
function openExternalUrl(url) {
  try {
    if (typeof liff !== 'undefined' && liff.openWindow) {
      liff.openWindow({ url: url, external: true });
      return;
    }
  } catch (e) { /* fallthrough */ }
  var w = null;
  try { w = window.open(url, '_blank'); } catch (e) { w = null; }
  if (!w) { window.location.href = url; }
}

// focus: 'address' | 'payment' | undefined。グレーボタンも同じ最短経路
// (住所・支払いはどのみち次のチェックアウト画面で変更できるため、行き先を変えず案内だけ変える)
async function submitReorder(focus) {
  if (!rosOrder || rosSubmitting) return;
  rosSubmitting = true;
  var btn = document.getElementById('ros-submit');
  btn.disabled = true;
  btn.textContent = 'ご注文の準備中…';
  var payload = { orderId: rosOrder.id, shippingMethod: rosShip };
  if (rosShip !== 'nekopos') {
    var dt = document.getElementById('ros-date').value;
    var tm = document.getElementById('ros-time').value;
    if (dt) payload.deliveryDate = dt;
    if (tm) payload.deliveryTime = tm;
  }
  try {
    var res = await api('/api/liff/reorder/create', payload);
    if (apiFailed(res)) {
      showToast((res && res.error) || '再注文の作成に失敗しました');
    } else if (res.data && res.data.invoiceUrl) {
      if (focus === 'address') showToast('お届け先は次の画面の「配送先」で変更できます');
      else if (focus === 'payment') showToast('お支払い方法は次の画面で選べます');
      else showToast('ご注文ページを開きます');
      closeReorderSheet();
      openExternalUrl(res.data.invoiceUrl);
    } else {
      showToast('再注文の作成に失敗しました');
    }
  } catch (e) { showToast('再注文の作成に失敗しました'); }
  rosSubmitting = false;
  btn.disabled = false;
  btn.textContent = 'この内容で注文へ進む →';
}

// 配送ステータスの日本語化 (Shopify fulfillment/shipment status → 顧客向け表現)
function fulfillStatusJa(status) {
  var map = {
    delivered: '配達完了', out_for_delivery: '配達中', in_transit: '配送中',
    attempted_delivery: '配達試行', ready_for_pickup: '受取可能', label_printed: '発送準備中',
    label_purchased: '発送準備中', confirmed: '発送準備中', pending: '発送準備中',
    open: '発送済み', success: '発送済み', failure: '配送遅延', error: '配送遅延',
    cancelled: 'キャンセル',
  };
  return map[String(status || '').toLowerCase()] || '配送中';
}
function fulfillBadgeClass(status) {
  var s = String(status || '').toLowerCase();
  if (s === 'delivered') return 'bg-emerald-100 text-emerald-700';
  if (s === 'failure' || s === 'error') return 'bg-red-100 text-red-600';
  if (s === 'cancelled') return 'bg-gray-100 text-gray-500';
  return 'bg-teal-50 text-teal-700';
}
// 最新のお届けを大きくヒーロー表示 (進捗3ステップ + 追跡番号 + 追跡ボタン)
function renderFulfillHero(f) {
  var ja = fulfillStatusJa(f.status);
  var s = String(f.status || '').toLowerCase();
  // 進捗ステップ: 発送準備中(0) → 配送中(1) → 配達完了(2)
  var stage = (s === 'delivered') ? 2 :
    (s === 'pending' || s === 'confirmed' || s === 'label_printed' || s === 'label_purchased') ? 0 : 1;
  var steps = ['発送準備', '配送中', 'お届け完了'];
  var stepHtml = '<div class="flex items-center gap-1 mt-3 mb-1">' + steps.map(function(label, i) {
    var on = i <= stage;
    return '<div class="flex-1">' +
      '<div class="h-1.5 rounded-full" style="background:' + (on ? '#0f766e' : '#e2e8f0') + '"></div>' +
      '<p class="text-center mt-1" style="font-size:10px;color:' + (on ? '#0f766e' : '#94a3b8') + ';font-weight:' + (i === stage ? '700' : '400') + '">' + label + '</p></div>';
  }).join('') + '</div>';
  var items = (f.lineItems && f.lineItems.length)
    ? esc(f.lineItems[0].name || '') + (f.lineItems.length > 1 ? ' 他' + (f.lineItems.length - 1) + '点' : '')
    : '';
  return '<div class="rounded-2xl p-4" style="background:linear-gradient(135deg,#effaf8,#ffffff);border:1.5px solid #bfe8e3">' +
    '<div class="flex justify-between items-center">' +
    '<p class="text-sm font-bold text-gray-700">最新のお届け <span class="text-gray-400 font-normal">#' + esc(f.orderNumber) + '</span></p>' +
    '<span class="text-xs px-2.5 py-1 rounded-full font-bold ' + fulfillBadgeClass(f.status) + '">' + ja + '</span></div>' +
    (items ? '<p class="text-xs text-gray-500 mt-1">' + items + '</p>' : '') +
    stepHtml +
    (f.trackingNumber ? '<p class="text-xs text-gray-400 mt-2">追跡番号: ' + esc(f.trackingNumber) + (f.trackingCompany ? ' (' + esc(f.trackingCompany) + ')' : '') + '</p>' : '') +
    (f.trackingUrl ? '<a href="' + esc(f.trackingUrl) + '" target="_blank" class="block text-center btn-primary py-2.5 rounded-xl text-sm font-bold mt-2">配送状況を追跡 ▶</a>' : '') +
    '</div>';
}

// 発送前の注文ステータス (financial_status / fulfillment_status → 顧客向け表現)。
// 2026-07-30 ゼロクリック配送状況: 銀行振込の「入金確認待ち」等、発送 (fulfillment 作成) より
// 前の段階もこのカードだけで進捗が分かるようにする。値は固定辞書 + esc() で XSS 安全。
function orderStageInfo(o) {
  var fin = String(o.financialStatus || '').toLowerCase();
  var ful = String(o.fulfillmentStatus || '').toLowerCase();
  // キャンセル・返金系は進捗ステップを出さない
  if (fin === 'refunded' || fin === 'partially_refunded' || fin === 'voided') {
    return { label: 'キャンセル・返金済み', stage: -1, badge: 'bg-gray-100 text-gray-500', note: 'この注文はキャンセルまたは返金済みです。' };
  }
  if (ful === 'fulfilled' || ful === 'partial') {
    // fulfillment レコード未着でも注文側が発送済みなら「発送済み」を出す (取りこぼし保険)
    return { label: '発送済み', stage: 3, badge: 'bg-teal-50 text-teal-700', note: '追跡情報は反映され次第ここに表示されます。' };
  }
  if (fin === 'pending') {
    return { label: 'ご入金確認待ち', stage: 1, badge: 'bg-amber-100 text-amber-700', note: '銀行振込などのお支払い確認が取れ次第、発送準備に進みます。' };
  }
  if (fin === 'authorized' || fin === 'partially_paid') {
    return { label: 'お支払い確認中', stage: 1, badge: 'bg-amber-100 text-amber-700', note: 'お支払いの確認が完了すると発送準備に進みます。' };
  }
  if (fin === 'paid') {
    return { label: '発送準備中', stage: 2, badge: 'bg-teal-50 text-teal-700', note: '発送が完了すると、ここに追跡情報が表示されます。' };
  }
  return { label: 'ご注文受付', stage: 0, badge: 'bg-teal-50 text-teal-700', note: 'ご注文を受け付けました。' };
}
// 最新注文 (未発送) のヒーロー表示: 4ステップ進捗 (ご注文受付→お支払い→発送準備→お届け)
function renderOrderHero(o) {
  var info = orderStageInfo(o);
  var items = (o.lineItems && o.lineItems.length)
    ? esc(o.lineItems[0].name || o.lineItems[0].title || '') + (o.lineItems.length > 1 ? ' 他' + (o.lineItems.length - 1) + '点' : '')
    : '';
  var stepHtml = '';
  if (info.stage >= 0) {
    var steps = ['ご注文受付', 'お支払い', '発送準備', 'お届け'];
    stepHtml = '<div class="flex items-center gap-1 mt-3 mb-1">' + steps.map(function(label, i) {
      var on = i <= info.stage;
      return '<div class="flex-1">' +
        '<div class="h-1.5 rounded-full" style="background:' + (on ? '#0f766e' : '#e2e8f0') + '"></div>' +
        '<p class="text-center mt-1" style="font-size:10px;color:' + (on ? '#0f766e' : '#94a3b8') + ';font-weight:' + (i === info.stage ? '700' : '400') + '">' + label + '</p></div>';
    }).join('') + '</div>';
  }
  return '<div class="rounded-2xl p-4" style="background:linear-gradient(135deg,#effaf8,#ffffff);border:1.5px solid #bfe8e3">' +
    '<div class="flex justify-between items-center">' +
    '<p class="text-sm font-bold text-gray-700">最新のご注文 <span class="text-gray-400 font-normal">#' + esc(o.orderNumber) + '</span></p>' +
    '<span class="text-xs px-2.5 py-1 rounded-full font-bold ' + info.badge + '">' + info.label + '</span></div>' +
    (items ? '<p class="text-xs text-gray-500 mt-1">' + items + '</p>' : '') +
    stepHtml +
    '<p class="text-xs text-gray-400 mt-2">' + info.note + '</p>' +
    '</div>';
}

// ─── ACCOUNT (マイアカウント) / Shop 移設分: Notifications, Subscriptions, FAQ ───

var notifPrefs = {};
var subscriptionsList = [];
var accountLoaded = false;
var subsLoaded = false;

async function loadAccountData() {
  if (accountLoaded) return;
  accountLoaded = true;
  var results = await Promise.all([loadNotifPrefs(), loadFAQ()]);
  // 1 つでも失敗したらタブ再訪問で再読込できるように解放する (skeleton 固着防止)
  if (results.indexOf(false) >= 0) { accountLoaded = false; }
}

// 定期お届けリマインダーは Shop タブへ移設 (4タブ再設計) — shop 表示時に一度だけ読む
async function loadSubscriptionsOnce() {
  if (subsLoaded) return;
  subsLoaded = true;
  var ok = await loadSubscriptions();
  if (ok === false) { subsLoaded = false; }
}

async function loadNotifPrefs() {
  var el = document.getElementById('notif-prefs-list');
  try {
    var res = await apiGet('/api/liff/notification-prefs');
    if (apiFailed(res)) { cardError(el, res, 'loadNotifPrefs'); return false; }
    if (res.data) { notifPrefs = res.data; }
    renderNotifPrefs();
    return true;
  } catch {
    cardError(el, null, 'loadNotifPrefs');
    return false;
  }
}

function renderNotifPrefs() {
  var el = document.getElementById('notif-prefs-list');
  var items = [
    { key: 'restock_alert', label: '在庫復活通知', desc: '売り切れ商品が再入荷した時' },
    { key: 'delivery_complete', label: '配送完了通知', desc: '注文商品がお届け完了した時' },
    { key: 'order_confirm', label: '注文確認通知', desc: '注文が確定した時' },
    { key: 'campaign_message', label: 'キャンペーン通知', desc: 'お得なキャンペーン情報' },
    { key: 'reorder_reminder', label: '再購入リマインダー', desc: '定期お届けのタイミング通知' },
  ];
  el.innerHTML = items.map(function(item) {
    var isOn = notifPrefs[item.key] !== undefined ? !!notifPrefs[item.key] : true;
    return '<div class="flex items-center justify-between py-2 border-b last:border-0">' +
      '<div><p class="text-sm text-gray-800">' + item.label + '</p>' +
      '<p class="text-xs text-gray-400">' + item.desc + '</p></div>' +
      '<label class="relative inline-block w-11 h-6 cursor-pointer">' +
      '<input type="checkbox" class="sr-only" ' + (isOn ? 'checked' : '') + ' onchange="toggleNotifPref(\\'' + item.key + '\\', this.checked)">' +
      '<span class="block w-11 h-6 rounded-full transition-colors ' + (isOn ? 'bg-green-500' : 'bg-gray-300') + '"></span>' +
      '<span class="absolute left-0.5 top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ' + (isOn ? 'translate-x-5' : '') + '"></span>' +
      '</label></div>';
  }).join('');
}

async function toggleNotifPref(key, val) {
  notifPrefs[key] = val ? 1 : 0;
  renderNotifPrefs();
  var body = {};
  body[key] = val;
  function revertToggle() { notifPrefs[key] = val ? 0 : 1; renderNotifPrefs(); showToast('設定の保存に失敗しました'); }
  try {
    var r = await fetch(API_BASE + '/api/liff/notification-prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: 'Bearer ' + idToken } : {}) },
      body: JSON.stringify(body),
    });
    // 採点R2: false-success + 楽観更新の未復帰を解消 (401 は中央処理へ)
    if (r.status === 401) { handleAuthExpired(); return; }
    if (!r.ok) { revertToggle(); return; }
    showToast(val ? '通知をONにしました' : '通知をOFFにしました');
  } catch { revertToggle(); }
}

async function loadSubscriptions() {
  var el = document.getElementById('subscriptions-list');
  try {
    var res = await apiGet('/api/liff/subscriptions');
    // エラーを「まだリマインダーが設定されていません」に化けさせない
    if (apiFailed(res)) { cardError(el, res, 'loadSubscriptions'); return false; }
    subscriptionsList = (res.data && res.data.subscriptions) || [];
    renderSubscriptions();
    return true;
  } catch {
    cardError(el, null, 'loadSubscriptions');
    return false;
  }
}

function renderSubscriptions() {
  var el = document.getElementById('subscriptions-list');
  if (subscriptionsList.length === 0) {
    el.innerHTML = '<p class="text-xs text-gray-400 text-center py-4">まだリマインダーが設定されていません</p>';
    return;
  }
  el.innerHTML = subscriptionsList.map(function(s) {
    var nextDate = s.next_reminder_at ? s.next_reminder_at.slice(0, 10) : '';
    return '<div class="flex items-center justify-between py-3 border-b last:border-0">' +
      '<div class="flex-1 min-w-0">' +
      '<p class="text-sm font-bold text-gray-800 truncate">' + esc(s.product_title) + '</p>' +
      '<p class="text-xs text-gray-400">' + s.interval_days + '日サイクル' + (nextDate ? ' ・ 次回: ' + nextDate : '') + '</p></div>' +
      '<div class="flex items-center gap-2 ml-2">' +
      '<label class="relative inline-block w-10 h-5 cursor-pointer">' +
      '<input type="checkbox" class="sr-only" ' + (s.is_active ? 'checked' : '') + ' onchange="toggleSubscription(\\'' + esc(s.id) + '\\', this.checked)">' +
      '<span class="block w-10 h-5 rounded-full transition-colors ' + (s.is_active ? 'bg-green-500' : 'bg-gray-300') + '"></span>' +
      '<span class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ' + (s.is_active ? 'translate-x-5' : '') + '"></span>' +
      '</label>' +
      '<button onclick="deleteSubscription(\\'' + esc(s.id) + '\\')" class="text-gray-300 hover:text-red-400 text-sm">✕</button>' +
      '</div></div>';
  }).join('');
}

async function toggleSubscription(id, isActive) {
  try {
    var r = await fetch(API_BASE + '/api/liff/subscriptions/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: 'Bearer ' + idToken } : {}) },
      body: JSON.stringify({ isActive: isActive }),
    });
    if (!r.ok) { showToast('変更に失敗しました'); return; } // 採点R1: false-success 防止
    for (var i = 0; i < subscriptionsList.length; i++) {
      if (subscriptionsList[i].id === id) subscriptionsList[i].is_active = isActive ? 1 : 0;
    }
    renderSubscriptions();
    showToast(isActive ? 'リマインダーをONにしました' : 'リマインダーを停止しました');
  } catch { showToast('エラーが発生しました'); }
}

async function deleteSubscription(id) {
  if (!confirm('このリマインダーを削除しますか？')) return;
  try {
    var r = await fetch(API_BASE + '/api/liff/subscriptions/' + id, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: 'Bearer ' + idToken } : {}) },
    });
    if (!r.ok) { showToast('削除に失敗しました'); return; } // 採点R1: false-success 防止
    subscriptionsList = subscriptionsList.filter(function(s) { return s.id !== id; });
    renderSubscriptions();
    showToast('リマインダーを削除しました');
  } catch { showToast('エラーが発生しました'); }
}

function showAddSubscription() {
  var form = document.getElementById('sub-add-form');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
  // Populate product list from shop data if available
  var sel = document.getElementById('sub-product');
  if (sel.options.length <= 1) {
    var defaults = [
      { title: 'naturism Blue', value: 'naturism Blue' },
      { title: 'naturism Pink', value: 'naturism Pink' },
      { title: 'naturism Premium', value: 'naturism Premium' },
    ];
    defaults.forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.value;
      opt.textContent = p.title;
      sel.appendChild(opt);
    });
  }
}

async function createSubscription() {
  var product = document.getElementById('sub-product').value;
  var interval = parseInt(document.getElementById('sub-interval').value);
  if (!product) { showToast('商品を選択してください'); return; }
  try {
    var res = await fetch(API_BASE + '/api/liff/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: 'Bearer ' + idToken } : {}) },
      body: JSON.stringify({ productTitle: product, intervalDays: interval }),
    });
    var json = await res.json();
    if (json.success) {
      showToast('リマインダーを設定しました');
      document.getElementById('sub-add-form').style.display = 'none';
      subsLoaded = false;
      loadSubscriptions();
    } else {
      // 採点R2: success:false / HTTP エラーの silent 失敗を解消 (フォームは開いたまま=入力を失わない)
      showToast((json && json.error) || 'リマインダーの設定に失敗しました');
    }
  } catch { showToast('エラーが発生しました'); }
}

async function loadFAQ() {
  try {
    var res = await apiGet('/api/liff/faq');
    // エラーを default FAQ に化けさせない (apiFailed を fallback より先に判定)
    if (apiFailed(res)) { cardError(document.getElementById('faq-list'), res, 'loadFAQ'); return false; }
    var items;
    if (res.data && res.data.faqs && res.data.faqs.length > 0) {
      items = res.data.faqs.map(function(f) {
        return { question: f.question, answer: f.answer, category: f.category || 'general' };
      });
    } else {
      // DBが空のときの fallback (検索・カテゴリも同じ描画経路を通す)
      items = [
        { question: 'naturismはいつ飲むのがおすすめですか？', answer: '毎日同じ時間に、食事と一緒にお飲みいただくと続けやすくなります。商品ごとの目安は商品ページをご確認ください。', category: 'usage' },
        { question: '定期購入はできますか？', answer: 'Shopタブの「定期お届けリマインダー」で、お好みのサイクルでリマインドを設定できます。タイミングが来たらLINEでお知らせし、ワンタッチで再注文いただけます。24時間いつでも解約・スキップ・変更も可能です。', category: 'subscription' },
        { question: '配送にどのくらいかかりますか？', answer: '平日12時までのご注文は原則当日発送（在庫がある場合）。12時以降・土日祝・年末年始は翌営業日発送です。配送状況は「Shop」タブの「🚚 配送状況」でご確認いただけます。', category: 'shipping' },
        { question: '返品・交換はできますか？', answer: '食品のため原則お客様都合の返品はお受けしておりません。対象3商品の初回購入は到着後14日以内のご連絡で全額返金保証、不良品・配送破損は10日以内のご連絡で対応いたします。詳しくは公式サイトの返品・返金ポリシーをご確認ください。', category: 'return' },
        { question: '問い合わせはどこからできますか？', answer: 'このLINEアカウントにメッセージを送っていただくか、公式サイトのお問い合わせフォームからご連絡ください。', category: 'support' },
      ];
    }
    window.__faqState = { items: items, cat: 'all', q: '' };
    renderFaqCats();
    renderFaqList();
    return true;
  } catch {
    cardError(document.getElementById('faq-list'), null, 'loadFAQ');
    return false;
  }
}

// カテゴリキー → 顧客向け日本語ラベル (faq_items.category と seed のキーに対応)
function faqCategoryLabel(c) {
  var map = { all: 'すべて', usage: '飲み方・使い方', allergy: '成分・アレルギー', product: '商品について', shipping: '配送・送料', return: '返品・返金', subscription: '定期便', support: 'お問い合わせ', general: 'その他' };
  return map[c] || c;
}

// カテゴリ chip を描画 (実質1カテゴリしか無ければ非表示)
function renderFaqCats() {
  var st = window.__faqState || { items: [], cat: 'all' };
  var cats = ['all'];
  st.items.forEach(function(f) { var c = f.category || 'general'; if (cats.indexOf(c) < 0) cats.push(c); });
  window.__faqCats = cats;
  var box = document.getElementById('faq-cats');
  if (!box) return;
  if (cats.length <= 2) { box.innerHTML = ''; box.style.display = 'none'; return; }
  box.style.display = 'flex';
  box.innerHTML = cats.map(function(c, i) {
    var cls = (st.cat === c) ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-600';
    return '<button onclick="onFaqCat(' + i + ')" class="flex-shrink-0 px-3 py-1 rounded-full text-xs font-bold ' + cls + '">' + esc(faqCategoryLabel(c)) + '</button>';
  }).join('');
}

// 検索語 + 選択カテゴリで絞り込み、アコーディオン描画。0件なら空状態を表示
function renderFaqList() {
  var st = window.__faqState || { items: [], cat: 'all', q: '' };
  var q = (st.q || '').trim().toLowerCase();
  var filtered = st.items.filter(function(f) {
    if (st.cat !== 'all' && (f.category || 'general') !== st.cat) return false;
    if (!q) return true;
    return (f.question + ' ' + f.answer).toLowerCase().indexOf(q) >= 0;
  });
  var el = document.getElementById('faq-list');
  var empty = document.getElementById('faq-empty');
  if (filtered.length === 0) { el.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  el.innerHTML = filtered.map(function(f, i) {
    return '<div class="border-b last:border-0">' +
      '<button onclick="toggleFaq(' + i + ')" class="w-full text-left py-3 flex items-center justify-between gap-2">' +
      '<span class="text-sm text-gray-800 font-medium">' + esc(f.question) + '</span>' +
      '<span class="text-gray-400 text-xs faq-arrow flex-shrink-0" id="faq-arrow-' + i + '">▼</span></button>' +
      '<div id="faq-answer-' + i + '" style="display:none" class="pb-3 text-xs text-gray-600 leading-relaxed">' + esc(f.answer) + '</div></div>';
  }).join('');
}

function onFaqSearch(v) {
  if (!window.__faqState) return;
  window.__faqState.q = v || '';
  renderFaqList();
}

function onFaqCat(idx) {
  var c = (window.__faqCats || [])[idx];
  if (!c || !window.__faqState) return;
  window.__faqState.cat = c;
  renderFaqCats();
  renderFaqList();
}

// FAQで解決しないとき → トーク画面に戻してAIに直接質問してもらう (= 離脱を AI 質問に転換)。
// AI が答えられなければ conversation_logs に fallback 記録され、管理画面の「未解決の質問」→FAQ化に繋がる。
function askAiFromFaq() {
  // ポータル内蔵AIチャットがあればそこへ誘導 (トーク離脱せず完結)。無ければトークに戻す。
  var input = document.getElementById('ai-chat-input');
  if (input) {
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    try { input.focus(); } catch (e) { /* ignore */ }
    return;
  }
  if (typeof liff !== 'undefined' && liff.closeWindow) {
    liff.closeWindow();
  } else {
    showToast('トーク画面に戻ってAIにメッセージを送ってください');
  }
}

// ポータル内蔵AIチャット: 質問→/api/liff/ask→回答。値は textContent で描画 (XSS安全)。
function appendAiChat(role, text) {
  var log = document.getElementById('ai-chat-log');
  if (!log) return null;
  var wrap = document.createElement('div');
  wrap.className = role === 'user' ? 'text-right' : 'text-left';
  var bubble = document.createElement('span');
  bubble.className = role === 'user'
    ? 'inline-block bg-green-500 text-white rounded-2xl px-3 py-2 text-sm text-left'
    : 'inline-block bg-gray-100 text-gray-800 rounded-2xl px-3 py-2 text-sm';
  bubble.style.maxWidth = '85%';
  bubble.style.whiteSpace = 'pre-wrap';
  bubble.style.wordBreak = 'break-word';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return wrap;
}
async function sendAiChat() {
  var input = document.getElementById('ai-chat-input');
  var btn = document.getElementById('ai-chat-send');
  if (!input) return;
  var q = (input.value || '').trim();
  if (!q) return;
  appendAiChat('user', q);
  input.value = '';
  if (btn) btn.disabled = true;
  var thinking = appendAiChat('ai', '考え中…');
  try {
    var res = await fetch(API_BASE + '/api/liff/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: 'Bearer ' + idToken } : {}) },
      body: JSON.stringify({ question: q }),
    });
    var json = await res.json();
    var answer = (json && json.data && json.data.answer) || '申し訳ございません、うまく回答できませんでした。';
    if (thinking && thinking.parentNode) thinking.parentNode.removeChild(thinking);
    appendAiChat('ai', answer);
  } catch (e) {
    if (thinking && thinking.parentNode) thinking.parentNode.removeChild(thinking);
    appendAiChat('ai', '通信エラーが発生しました。時間をおいてお試しください。');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function toggleFaq(idx) {
  var ans = document.getElementById('faq-answer-' + idx);
  var arrow = document.getElementById('faq-arrow-' + idx);
  if (ans.style.display === 'none') {
    ans.style.display = 'block';
    arrow.textContent = '▲';
  } else {
    ans.style.display = 'none';
    arrow.textContent = '▼';
  }
}

// ─── Referral Claim (auto-detect ?ref= param) ───
function checkReferralParam() {
  try {
    var params = new URLSearchParams(window.location.search);
    var ref = params.get('ref');
    if (!ref) return;
    // Clean URL (remove ref param)
    var url = new URL(window.location.href);
    url.searchParams.delete('ref');
    window.history.replaceState({}, '', url.toString());
    // Claim referral (non-blocking)
    api('/api/liff/referral/claim', { refCode: ref }).then(function(res) {
      if (res.success && res.data && !res.data.alreadyClaimed) {
        // referred の ¥500 は友だち追加 welcome クーポン (welcome-coupon-card に表示) がそれに当たる。
        showToast('紹介リンクが適用されました!お友だち追加特典の500円クーポンをご利用ください✨');
      }
    }).catch(function() {});
  } catch(e) { /* ignore */ }
}

// ─── Shopify 連携ボタン (App Proxy, 2026-07-29) ───
// gate off / URL 未設定時は null (カード自体も非表示)。 URL は server 側で https + host 形式に
// 検証済みの値だけが JSON.stringify で埋まる (= 引用符/エスケープ事故を構造的に回避)。
var SHOPIFY_LINK_URL = ${JSON.stringify(shopifyLinkUrl)};

// 連携済みが判明したらカードを「✓ 連携済み」に差し替える。 出しっぱなしだと
// ①既連携ユーザーが外部ブラウザを往復して行き止まりページに着く
// ②連携完了直後に同じ「連携する」ボタンが居座り、 完了したのか不安にさせる (R1 採点 MED)。
function markShopifyLinked() {
  var card = document.getElementById('shopify-link-card');
  if (!card) return;
  if (card.getAttribute('data-linked') === '1') return;
  card.setAttribute('data-linked', '1');
  while (card.firstChild) { card.removeChild(card.firstChild); }
  var title = document.createElement('p');
  title.className = 'text-base font-bold text-gray-800 mb-1';
  title.textContent = '✅ オンラインストアと連携済み';
  card.appendChild(title);
  var body = document.createElement('p');
  body.className = 'text-sm text-gray-600';
  body.textContent = '会員特典やお届けのお知らせをLINEでお届けしています。';
  card.appendChild(body);
}

function openShopifyLinkPage() {
  if (!SHOPIFY_LINK_URL) return;
  var url = SHOPIFY_LINK_URL + '/apps/line-link';
  // 外部ブラウザで開く (= storefront のログイン cookie が生きている本人ブラウザに乗る)。
  // 完了後は /proxy/line-link が liff.line.me?slk= へ送り返し、 このポータルの ?slk= fast path が拾う。
  try {
    if (typeof liff !== 'undefined' && liff.isInClient && liff.isInClient()) {
      liff.openWindow({ url: url, external: true });
      return;
    }
  } catch (e) { /* openWindow 不能なら通常遷移へ */ }
  // popup ブロック時 window.open は throw せず **null を返す** ので、戻り値で判定しないと
  // 「押しても何も起きない」完全な無反応になる (同ファイルの degrade 前例と同じ扱いにする)。
  var w = null;
  try { w = window.open(url, '_blank'); } catch (e) { w = null; }
  if (!w) { location.href = url; }
}

// ─── 定期購入 連携リンク (magic-link, ?slk= param) ───
// 店舗が顧客の email に載せた 1タップ連携リンクで来た人を、 このLINEと定期購入で連携させる。
// onclick 文字列を一切使わず createElement + addEventListener + textContent で組む
// (= inline JS の引用符エスケープ事故 [#193] と XSS を構造的に回避)。
// ─── トークン退避 (§6-4) ───
// URL からの即時削除 (履歴・共有スクショへの残留防止) は維持したまま、 同一セッションのリロード救済だけを足す。
// 削除条件: ①redeem 成功 ②preview が terminal 状態を返した ③保存から 30 分経過 ④ユーザーが明示的に閉じた。
// 保持条件: 通信エラー / リトライ枯渇 (= まだ結論が出ていないので次の試行に残す)。
var SUBLINK_STASH_KEY = 'sublink_token_v1';
var SUBLINK_STASH_TTL_MS = 30 * 60 * 1000;
var SUBLINK_STALL_MS = 15000;
// sessionStorage が使えない端末 (private mode 等) 用の同一ページ内 fallback。
// URL からは既に slk を消しているので、 ここが無いと書込失敗時に機能ごと無言で消える。
var subLinkMemStash = null;
// 保留中のリトライ timer。 dismiss で必ず止める (止めないと「閉じた」はずのモーダルが復活する)。
var subLinkTimer = null;
var subLinkStallTimer = null;
// **世代カウンタ**: timer を止めるだけでは足りない。 飛行中の fetch は止められないので、
// 応答が返った時点で「その要求がまだ最新か」を照合する。 これが無いと
//   ①shimmer 中に背景タップで閉じた後、 遅れて届いた応答がモーダルを復活させる
//   ②「もう一度試す」で走らせた新しい要求の結果を、 古い要求の応答が上書きして偽の結論を出す
// が起きる (どちらも R2 採点で実機再現された)。
var subLinkGen = 0;
function subLinkNextGen() { subLinkGen += 1; return subLinkGen; }
function subLinkStale(gen) { return gen !== subLinkGen; }

function subLinkStashWrite(rec) {
  subLinkMemStash = rec;
  try { window.sessionStorage.setItem(SUBLINK_STASH_KEY, JSON.stringify(rec)); } catch (e) { /* private mode 等 */ }
}
function subLinkClearStash() {
  subLinkMemStash = null;
  try { window.sessionStorage.removeItem(SUBLINK_STASH_KEY); } catch (e) { /* ignore */ }
}
function subLinkStashRead() {
  var raw = null;
  try { raw = window.sessionStorage.getItem(SUBLINK_STASH_KEY); } catch (e) { raw = null; }
  if (raw) { try { return JSON.parse(raw); } catch (e) { return null; } }
  return subLinkMemStash;
}

// URL から slk を抜き取り、 セッションへ退避する。 **2 回呼ぶ (liff.init() の前と後)。**
//   - init 前: endpoint URL に直接 ?slk= が乗っている場合と、 liff.login() 往復前の救済。
//   - init 後: 配布リンクは liff.line.me/{id}?slk=... なので、 endpoint には ?liff.state=%3Fslk%3D... で
//     着弾し、 **liff.init() が復元して初めて location.search に ?slk= が現れる** (#rank 導線と同機構)。
//     init 前だけで読むと本番の唯一の流入経路で 1 件も拾えない。
// 冪等: slk が無ければ何もしない。 新しいトークンが来たら上書きする (より新しい意思が勝つ)。
function captureSubLinkToken() {
  try {
    var params = new URLSearchParams(window.location.search);
    var slk = params.get('slk');
    if (!slk) return;
    var url = new URL(window.location.href);
    url.searchParams.delete('slk');
    window.history.replaceState({}, '', url.toString());
    subLinkStashWrite({ t: slk, s: null, ts: Date.now() });
    // ツアー抑止は init 完走を待たない (ツアーは loading 解除直後に走るため)
    window.__subLinkPending = true;
  } catch (e) { /* ignore */ }
}

// 退避トークンを取り出す。 sub (idToken の subject) でスコープし、 共有端末で別の LINE アカウントが
// 他人の Shopify customer に紐付くのを防ぐ。 初回の読み出しで現在の sub に束縛する。
function subLinkTakeStash(sub) {
  var rec = subLinkStashRead();
  if (!rec) return null;
  if (!rec.t || typeof rec.t !== 'string') { subLinkClearStash(); return null; }
  if (!rec.ts || (Date.now() - rec.ts) > SUBLINK_STASH_TTL_MS) { subLinkClearStash(); return null; }
  if (rec.s && sub && rec.s !== sub) { subLinkClearStash(); return null; }
  if (!rec.s && sub) { rec.s = sub; subLinkStashWrite(rec); }
  return rec.t;
}

function checkSubLinkParam() {
  try {
    // liff.init() が liff.state から復元した ?slk= をここで拾う (本番の主経路)。
    captureSubLinkToken();
    var sub = null;
    try { var decoded = liff.getDecodedIDToken(); if (decoded && decoded.sub) { sub = decoded.sub; } } catch (e) { /* demo/未init */ }
    var token = subLinkTakeStash(sub);
    if (!token) { subLinkReleaseTour(); return; }
    window.__subLinkPending = true;
    subLinkStartPreview(token);
  } catch (e) { subLinkReleaseTour(); }
}

// preview chain を開始する唯一の入口。 「shimmer を出す」「世代を進める」「要求を投げる」を
// 1 箇所に束ねる — 呼び出し側が世代更新を書き忘れると古い応答が新しい画面を上書きするため、
// 分散させない (2026-07-26 の採点で、 再試行側の世代更新だけが回帰テストで守られない状態になった)。
function subLinkStartPreview(token) {
  // shimmer 先出し (§9): preview の friend 非依存化を却下した代わりに、 待ち時間を空白にしない。
  subLinkShowLoading(token);
  subLinkPreview(token, 0, subLinkNextGen());
}

function subLinkRetryLater(fn) {
  if (subLinkTimer) { clearTimeout(subLinkTimer); }
  subLinkTimer = setTimeout(function() { subLinkTimer = null; fn(); }, 1500);
}

function subLinkPreview(token, attempt, gen) {
  api('/api/liff/sub-link/preview', { token: token }, { softAuth: true }).then(function(res) {
    if (subLinkStale(gen)) return; // 閉じられた / 新しい要求に置き換わった
    if (res && res.success && res.data) { subLinkShowCard(token, res.data); return; }
    // 友だち追加直後は friend 行が未反映のことがある (follow webhook の反映待ち) → 数回リトライ。
    // ただし friend 未反映 (middleware の 'Friend not found') のときだけ。 機能 disabled の 404
    // ('not_found') や他の 404 はリトライしない (= dormant 時の無駄叩き防止)。
    var friendPending = res && res.status === 404 && res.error === 'Friend not found';
    if (friendPending && attempt < 4) { subLinkRetryLater(function() { subLinkPreview(token, attempt + 1, gen); }); return; }
    // 401 = idToken 失効。 handleAuthExpired は撃たない (softAuth) が、 黙って消すのも不誠実なので案内する。
    if (res && res.status === 401) { subLinkShowRetryCard(token, 'auth'); return; }
    // friend 未反映のまま枯渇 / サーバエラー = **結論が出ていない**。 退避を残して再試行導線を出す。
    // magic-link の対象は「まだ友だちでない」層なので、 この 404 枯渇こそ既定経路。 無言で消してはいけない。
    if (friendPending) { subLinkShowRetryCard(token, 'friend'); return; }
    // 429 = レート制限。 この worker は /api/liff/* を IP 単位で絞るので、 CGNAT 共有 IP では
    // 本人が悪くなくても当たる。 結論ではないので退避を消さない。
    if (res && res.status === 429) { subLinkShowRetryCard(token, 'net'); return; }
    if (!res || typeof res.status !== 'number' || res.status >= 500) { subLinkShowRetryCard(token, 'net'); return; }
    // ここから先は結論が出た失敗 = 退避を消す。 404(not_found) は店舗側で受付が止まっている状態、
    // それ以外 (400/403 等) はリンク自体が使えない状態なので、 案内文を分ける。
    subLinkClearStash();
    subLinkShowUnavailable(res.status === 404 ? 'paused' : 'invalid');
  }).catch(function() {
    if (subLinkStale(gen)) return;
    if (attempt < 4) { subLinkRetryLater(function() { subLinkPreview(token, attempt + 1, gen); }); return; }
    // 通信エラーでリトライ枯渇 = 結論が出ていない。 退避は残したまま再試行導線を出す (§4 誠実な失敗)。
    subLinkShowRetryCard(token, 'net');
  });
}

function subLinkNode(tag, cls, text) {
  var el = document.createElement(tag);
  if (cls) { el.className = cls; }
  if (text != null) { el.textContent = text; }
  return el;
}

function subLinkCard() {
  return subLinkNode('div', 'sublink-card bg-white rounded-2xl w-full max-w-sm shadow-xl text-center');
}

function subLinkOverlay(card, phase) {
  subLinkCloseModal();
  var overlay = subLinkNode('div', 'fixed inset-0 flex items-center justify-center bg-black/40 p-4');
  overlay.id = 'sublink-overlay';
  overlay.setAttribute('data-no-tab-swipe', '1');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('data-sublink-phase', phase || 'card');
  // 背景タップ = 判断保留の離脱。 退避は残す (同一セッションでのリロード救済を潰さない)。
  overlay.addEventListener('click', function(ev) { if (ev.target === overlay) { subLinkDismiss(false); } });
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

function subLinkCloseModal() {
  var overlay = document.getElementById('sublink-overlay');
  if (overlay && overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
}

// カードを閉じる唯一の出口。 clearStash=true は「明示的に閉じた」(§6-4 削除条件④)。
// 閉じたら必ずツアーを解放する — でないと初回ユーザーがツアーを永久に受け取れない。
// 保留中の timer も必ず止める (止めないと閉じた後にモーダルが復活する)。
function subLinkDismiss(clearStash) {
  if (clearStash) { subLinkClearStash(); }
  subLinkNextGen(); // 飛行中の応答を無効化する (timer を止めるだけでは復活を防げない)
  subLinkCancelTimers();
  subLinkCloseModal();
  subLinkReleaseTour();
}

function subLinkCancelTimers() {
  if (subLinkTimer) { clearTimeout(subLinkTimer); subLinkTimer = null; }
  if (subLinkStallTimer) { clearTimeout(subLinkStallTimer); subLinkStallTimer = null; }
}

function subLinkReleaseTour() {
  window.__subLinkPending = false;
  if (!window.__tourDeferred) return;
  window.__tourDeferred = false;
  try {
    if (window.__fatalShown) return;
    var loadingEl = document.getElementById('loading');
    if (loadingEl && loadingEl.style.display !== 'none') return; // まだ読み込み中 = initOnboarding 側が拾う
    if (lsGet(ONBOARDING_TOUR_KEY) !== '1') { startTour(); }
  } catch (e) { /* ツアーは非必須 */ }
}

// shimmer 先出し: preview の応答を待つ間、 空白でも「読み込み中…」だけでもなく、 これから何が出るかの
// 骨格を見せる。 §9 で「preview の friend 非依存化」を却下した際の代替策なので落とせない。
function subLinkShowLoading(token) {
  var card = subLinkCard();
  card.appendChild(subLinkNode('div', 'text-4xl mb-2', '🌿'));
  // タイトルは kind (定期購入/お買い物) が preview 応答で判明する前なので中立にする
  card.appendChild(subLinkNode('h3', 'sublink-title mb-4', 'LINEとの連携'));
  var widths = ['82%', '100%', '64%'];
  for (var i = 0; i < widths.length; i++) {
    var bar = subLinkNode('div', 'skeleton sublink-sk');
    bar.style.width = widths[i];
    card.appendChild(bar);
  }
  var note = subLinkNode('p', 'sublink-body mt-4', 'ご登録内容を確認しています…');
  card.appendChild(note);
  subLinkOverlay(card, 'loading');
  if (token) { subLinkArmStall(token, 'loading'); }
}

// fetch が resolve も reject もしないまま固まるケースの脱出口。 ポータル本体の 12s watchdog は
// #loading にしか書かないため、 その上に出るこのカードには届かない (= shimmer が永久に残る)。
function subLinkArmStall(token, phase) {
  if (subLinkStallTimer) { clearTimeout(subLinkStallTimer); }
  subLinkStallTimer = setTimeout(function() {
    subLinkStallTimer = null;
    var overlay = document.getElementById('sublink-overlay');
    if (!overlay) return; // 既に閉じた/結果が出た
    if (overlay.getAttribute('data-sublink-phase') !== phase) return; // 先へ進んでいる
    subLinkNextGen(); // 固まった要求の遅延応答がこの後カードを上書きしないようにする
    subLinkShowRetryCard(token, 'net');
  }, SUBLINK_STALL_MS);
}

// 結論が出ていない失敗。 退避は残し、 再試行と離脱の両方を出す。
// kind: 'auth' = ログイン失効 / 'friend' = 友だち情報の反映待ち / 'net' = 通信・サーバ側の不調。
function subLinkShowRetryCard(token, kind) {
  var isAuth = kind === 'auth';
  var isFriend = kind === 'friend';
  var card = subLinkCard();
  card.appendChild(subLinkNode('div', 'text-4xl mb-2', isAuth ? '🔑' : (isFriend ? '⏳' : '📶')));
  card.appendChild(subLinkNode('h3', 'sublink-title mb-3', isAuth
    ? 'ログインの有効期限が切れました'
    : (isFriend ? 'もう少しお待ちください' : '通信に失敗しました')));
  card.appendChild(subLinkNode('p', 'sublink-body mb-5', isAuth
    ? 'お手数ですが、この画面を開き直してから、もう一度お試しください。連携のご案内はこのままお預かりしています。'
    : (isFriend
      ? '友だち追加の反映に少し時間がかかっています。少し待ってから「もう一度試す」を押してください。連携のご案内はこのままお預かりしています。'
      : '電波の良い場所でもう一度お試しください。連携のご案内はこのままお預かりしています。')));
  if (isAuth) {
    var reload = subLinkNode('button', 'btn-primary sublink-btn', '開き直す');
    reload.addEventListener('click', function() { location.reload(); });
    card.appendChild(reload);
  } else {
    var retry = subLinkNode('button', 'btn-primary sublink-btn', 'もう一度試す');
    retry.addEventListener('click', function() {
      subLinkCancelTimers();
      subLinkStartPreview(token); // 世代更新込み = 古い chain の応答は捨てられる
    });
    card.appendChild(retry);
  }
  var later = subLinkNode('button', 'sublink-sub mt-2', 'あとで');
  later.addEventListener('click', function() { subLinkDismiss(false); });
  card.appendChild(later);
  subLinkOverlay(card, 'retry');
}

// 結論の出た「使えない」。 顧客側に打つ手は無いが、 黙って消すと「タップしたのに何も起きなかった」に
// なるので、 事実だけ伝えて閉じられるようにする。
// kind: 'paused' = 店舗側で受付を停止中 (顧客の落ち度でも、 メールを探し直しても解決しない)
//       'invalid' = このリンク自体が使えない (最新の案内メールなら解決しうる)
function subLinkShowUnavailable(kind) {
  var paused = kind === 'paused';
  var card = subLinkCard();
  card.appendChild(subLinkNode('div', 'text-4xl mb-2', 'ℹ️'));
  card.appendChild(subLinkNode('h3', 'sublink-title mb-3', paused
    ? 'ただいまお受けできません'
    : 'このリンクはご利用いただけません'));
  // App Proxy 経由の人 (SHOPIFY_LINK_URL が出ている面) には、届いていないメールでなく
  // 実際に押せる導線を案内する。
  card.appendChild(subLinkNode('p', 'sublink-body mb-5', paused
    ? 'LINEでの連携のお受付を一時停止しています。ご迷惑をおかけします。再開しましたら改めてご案内しますので、そのままお待ちください。'
    : (SHOPIFY_LINK_URL
      ? 'お手数ですが、画面右上のプロフィール写真をタップ →「ストアにログインして連携」からもう一度お試しください。お困りのときはサポートまでご連絡ください。'
      : 'お手数ですが、最新のご案内メールのリンクからお試しください。お困りのときはサポートまでご連絡ください。')));
  var close = subLinkNode('button', 'btn-primary sublink-btn', 'とじる');
  close.addEventListener('click', function() { subLinkDismiss(true); });
  card.appendChild(close);
  subLinkOverlay(card);
}

function subLinkStatusInfo(status, kind) {
  if (status === 'already_self') return { emoji: '✓', title: '連携済みです', desc: (kind === 'shop'
    ? 'このLINEはすでにお客様のご登録と連携されています。'
    : 'このLINEはすでにお客様の定期購入と連携されています。') };
  if (status === 'friend_conflict') return { emoji: '🔗', title: 'このLINEは別のご登録と連携済み', desc: 'このLINEアカウントは、すでに別のご登録と連携されています。お心当たりがない場合はサポートへお問い合わせください。' };
  if (status === 'taken') return { emoji: '🔒', title: '別のLINEと連携済み', desc: 'このご登録は、すでに別のLINEアカウントと連携されています。お心当たりがない場合はサポートへお問い合わせください。' };
  // 復旧手段は経路で違う: shop (App Proxy) の人はメールを受け取っていないので、
  // 「ご案内メール」を案内すると存在しないものを探させる死路になる。
  if (status === 'expired') return { emoji: '⏰', title: 'リンクの有効期限切れ', desc: (kind === 'shop'
    ? 'この連携リンクは有効期限が切れています。お手数ですが、画面右上のプロフィール写真をタップ →「ストアにログインして連携」からもう一度お試しください。'
    : 'この連携リンクは有効期限が切れています。お手数ですが、最新のご案内メールのリンクからお試しください。') };
  return { emoji: 'ℹ️', title: '使用済みのリンク', desc: 'この連携リンクはすでに使用されています。' };
}

function subLinkShowCard(token, data) {
  var status = data.status;
  // ready 以外はすべて terminal (結論が出た) = 退避を消す。 残すと同一セッションのリロードで
  // 同じ結果カードが繰り返し出る (§6-4 削除条件②)。
  subLinkCancelTimers(); // 応答が来た = 保留中のリトライ/スタール監視は不要
  if (status !== 'ready') { subLinkClearStash(); }
  if (status === 'invalid') { subLinkShowUnavailable('invalid'); return; } // 不正/未知トークンも事実を伝えて閉じられるように
  var card = subLinkCard();
  if (status === 'ready') {
    // kind 分岐: 'shop' (App Proxy 自動連携) はプラン有無で文言を変える。 プランを持つ定期購入者は
    // 経路が App Proxy でも従来の定期購入コピーが正確 (= 情報が多い方を出す)。
    var isShop = data.kind === 'shop' && !data.plan;
    card.appendChild(subLinkNode('div', 'text-4xl mb-2', '🌿'));
    card.appendChild(subLinkNode('h3', 'sublink-title mb-2', isShop ? 'お買い物をLINEに連携' : '定期購入をLINEに連携'));
    card.appendChild(subLinkNode('p', 'sublink-plan mb-3', (data.plan ? String(data.plan) : (isShop ? 'オンラインストアのご登録' : 'ご登録の定期便'))));
    card.appendChild(subLinkNode('p', 'sublink-body mb-3', isShop
      ? 'このLINEアカウントとオンラインストアのご登録をつなぎます。会員特典やお届けに関するお知らせがLINEで受け取れるようになります。'
      : 'このLINEアカウントとお客様の定期購入をつなぎます。次回お届けのご確認やお知らせがLINEで受け取れるようになります。'));
    // 連携先の識別ヒント (マスク済メール)。 これが唯一「自分のアカウントか」を確かめる材料になる
    // — 他人が作ったリンクを踏まされたときに気付けるようにするため必ず出す。
    if (data.hint) {
      var hintBox = subLinkNode('p', 'sublink-hint mb-5');
      hintBox.appendChild(subLinkNode('span', null, '連携先: '));
      var hintVal = subLinkNode('strong', null, String(data.hint));
      hintBox.appendChild(hintVal);
      card.appendChild(hintBox);
      // 警告が指す操作は、実際に押せるボタンのラベル (「あとで」) と一致させる。
      // 語が食い違うと、他人のリンクを踏まされた人が「閉じる」を探して見つけられない。
      card.appendChild(subLinkNode('p', 'sublink-note mb-4', 'お心当たりのないメールアドレスの場合は、連携せずに「あとで」を押してください。'));
    } else {
      card.appendChild(subLinkNode('div', 'mb-2'));
    }
    var confirm = subLinkNode('button', 'btn-primary sublink-btn', 'このLINEに連携する');
    confirm.addEventListener('click', function() { subLinkRedeem(token, confirm); });
    card.appendChild(confirm);
    var later = subLinkNode('button', 'sublink-sub mt-2', 'あとで');
    later.addEventListener('click', function() { subLinkDismiss(true); });
    card.appendChild(later);
  } else {
    var info = subLinkStatusInfo(status, data.kind);
    card.appendChild(subLinkNode('div', 'text-4xl mb-2', info.emoji));
    card.appendChild(subLinkNode('h3', 'sublink-title mb-3', info.title));
    card.appendChild(subLinkNode('p', 'sublink-body mb-5', info.desc));
    var close = subLinkNode('button', 'btn-primary sublink-btn', 'とじる');
    close.addEventListener('click', function() { subLinkDismiss(true); });
    card.appendChild(close);
  }
  subLinkOverlay(card);
}

function subLinkRedeem(token, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '連携しています…'; }
  // 応答が返らないまま固まっても脱出できるようにする (ボタンは disabled なので放置すると詰む)
  var overlay = document.getElementById('sublink-overlay');
  if (overlay) { overlay.setAttribute('data-sublink-phase', 'redeeming'); }
  var gen = subLinkNextGen();
  subLinkArmStall(token, 'redeeming');
  api('/api/liff/sub-link/redeem', { token: token }, { softAuth: true }).then(function(res) {
    if (subLinkStale(gen)) return; // 閉じられた / スタール経由で別の要求に置き換わった
    subLinkCancelTimers();
    if (res && res.success && res.data) {
      subLinkClearStash(); // §6-4 削除条件①
      var doneDesc;
      if (res.data.plan) {
        doneDesc = String(res.data.plan) + 'のお知らせやお届けのご確認が、これからLINEで受け取れます。';
      } else if (res.data.kind === 'shop') {
        doneDesc = 'オンラインストアの会員特典やお得なお知らせが、これからLINEで受け取れます。';
      } else {
        doneDesc = 'ご登録の定期便のお知らせやお届けのご確認が、これからLINEで受け取れます。';
      }
      subLinkResult('🌿', '連携が完了しました', doneDesc);
      try { markShopifyLinked(); } catch (e) {}
      if (typeof loadRank === 'function') { try { loadRank(); } catch (e) {} }
      return;
    }
    if (res && res.status === 401) { subLinkShowRetryCard(token, 'auth'); return; }
    // サーバ側が落ちている (5xx) / 応答が壊れている = 結論ではない → 退避を残して再試行導線へ。
    if (!res || typeof res.status !== 'number' || res.status >= 500) { subLinkShowRetryCard(token, 'net'); return; }
    // サーバが結論を返した失敗 (使用済み/占有済み/期限切れ 等) は再試行しても同じ = 退避を消す。
    subLinkClearStash();
    var msg = (res && res.message) ? res.message : '連携に失敗しました。時間をおいてお試しください。';
    subLinkResult('⚠️', 'ご連携できませんでした', msg);
  }).catch(function() {
    if (subLinkStale(gen)) return;
    // 通信エラーは結論ではない = 退避を残して再試行導線へ (二重 redeem は single-use CAS が防ぐ)
    subLinkCancelTimers();
    subLinkShowRetryCard(token, 'net');
  });
}

function subLinkResult(emoji, title, desc) {
  var card = subLinkCard();
  card.appendChild(subLinkNode('div', 'text-4xl mb-2', emoji));
  card.appendChild(subLinkNode('h3', 'sublink-title mb-3', title));
  card.appendChild(subLinkNode('p', 'sublink-body mb-5', desc));
  var close = subLinkNode('button', 'btn-primary sublink-btn', 'とじる');
  close.addEventListener('click', function() { subLinkDismiss(true); });
  card.appendChild(close); // 旧実装はここが欠落しており、 連携成功直後に閉じられないモーダルに閉じ込めていた
  subLinkOverlay(card);
}

// ─── QUIZ Engine (client-side) ── 本サイト9問版 (nx-lineup-v2.js / 2026-07-20オーナー仕様) の完全ミラー ───
// ⚠️ 設問・選択肢・採点を変える時は 本サイト (theme-dawn: nx-lineup-v2.js / naturism-category.js) と
//    サーバー側 services/quiz-engine.ts を必ず同時更新すること (保存時の採点はサーバーが正)
var QUIZ_TYPES = ['blue', 'pink', 'premium']; /* 度数バーは必ずこの固定順で表示 */
var QUIZ_TYPE_LABELS = { blue: 'ブルー度', pink: 'ピンク度', premium: 'プレミアム度' };
var QUIZ_QUESTIONS = [
  { id: 'q1', text: 'Q1. 普段の食事の傾向は?', kind: 'single', options: [
    { label: '揚げ物・脂っこい料理が好き', pts: { pink: 0, blue: 2, premium: 2 } },
    { label: 'ご飯・パン・麺類が多い', pts: { pink: 1, blue: 0, premium: 2 } },
    { label: 'バランスを意識', pts: { pink: 2, blue: 1, premium: 0 } },
    { label: '外食やコンビニ中心', pts: { pink: 0, blue: 1, premium: 2 } },
  ]},
  { id: 'q2', text: 'Q2. 好きな料理は? 1位〜3位の順にタップしてください', kind: 'rank',
    options: ['和食', '中華', '焼肉', 'イタリアン', 'ラーメン／麺類'] },
  { id: 'q3', text: 'Q3. 体型管理の目標は?', kind: 'single', options: [
    { label: '体重を落としたい', pts: { pink: 0, blue: 1, premium: 2 } },
    { label: '体型を維持したい', pts: { pink: 1, blue: 2, premium: 0 } },
    { label: '健康のため', pts: { pink: 1, blue: 0, premium: 2 } },
    { label: '美容のため', pts: { pink: 1, blue: 0, premium: 2 } },
  ]},
  { id: 'q4', text: 'Q4. お通じ・お腹の悩みは?', kind: 'single', options: [
    { label: 'よく便秘する・お腹が張る', pts: { pink: 1, blue: 3, premium: 2 } },
    { label: 'たまに便秘・不規則', pts: { pink: 0, blue: 2, premium: 1 } },
    { label: '快調だけど維持したい', pts: { pink: 1, blue: 1, premium: 0 } },
    { label: '特に悩みはない', pts: { pink: 1, blue: 0, premium: 0 } },
  ]},
  { id: 'q5', text: 'Q5. 美容・体で一番気になるのは?', kind: 'single', options: [
    { label: '肌のハリ・ツヤ', pts: { pink: 3, blue: 0, premium: 0 } },
    { label: '消化・胃もたれ・お腹周り', pts: { pink: 0, blue: 2, premium: 1 } },
    { label: '全体的にケアしたい', pts: { pink: 0, blue: 0, premium: 3 } },
    { label: '特になし', pts: { pink: 1, blue: 0, premium: 0 } },
  ]},
  { id: 'q6', text: 'Q6. 甘いもの・間食の頻度は?', kind: 'single', options: [
    { label: 'ほぼ毎日食べる', pts: { pink: 0, blue: 1, premium: 3 } },
    { label: '週に数回', pts: { pink: 0, blue: 0, premium: 2 } },
    { label: 'たまに', pts: { pink: 1, blue: 1, premium: 0 } },
    { label: 'ほとんど食べない', pts: { pink: 2, blue: 0, premium: 0 } },
  ]},
  { id: 'q7', text: 'Q7. 運動の習慣は?', kind: 'single', options: [
    { label: 'ほとんど運動しない', pts: { pink: 0, blue: 1, premium: 2 } },
    { label: '軽く歩く程度', pts: { pink: 1, blue: 1, premium: 0 } },
    { label: '週1〜2回運動する', pts: { pink: 1, blue: 1, premium: 0 } },
    { label: 'しっかり運動している', pts: { pink: 2, blue: 0, premium: 0 } },
  ]},
  { id: 'q8', text: 'Q8. 続けやすさ・価格の考え方は?', kind: 'single', options: [
    { label: 'まずは手軽に・コスパ重視', pts: { pink: 1, blue: 2, premium: 0 } },
    { label: '効果重視でしっかり投資したい', pts: { pink: 0, blue: 0, premium: 3 } },
    { label: '1日55円〜150円くらいなら特に気にならない', pts: { pink: 1, blue: 0, premium: 2 } },
    { label: '根拠(機能性表示食品など)があるものがいい', pts: { pink: 0, blue: 0, premium: 2 } },
  ]},
  { id: 'q9', text: 'Q9. naturism を試すのは?', kind: 'single', options: [
    { label: '初めて', pts: null },
    { label: '飲んだことある', pts: null },
    { label: '今飲んでいて別種類を検討中', pts: null },
  ]},
];
var QUIZ_Q2_CUISINE = { '和食': 'pink', 'イタリアン': 'pink', '中華': 'blue', '焼肉': 'blue', 'ラーメン／麺類': 'premium' };
var QUIZ_Q2_RANK_PTS = [2, 1, 1]; /* 1位, 2位, 3位 */

var QUIZ_PRODUCTS = {
  blue: { name: 'naturism Blue', desc: '脂っこい食事やお通じの悩みが気になるあなたには、黒烏龍茶で「食べたあと」をケアするブルーがぴったり。', storeUrl: 'https://naturism-diet.com/products/naturism-blue-180-30days', compareUrl: 'https://naturism-diet.com/pages/compare#nxcp-blue' },
  pink: { name: 'KOSO in naturism Pink', desc: '美容やバランスを大切にするあなたには、酵素で内側からととのえるピンクがぴったり。', storeUrl: 'https://naturism-diet.com/products/koso-in-naturism-pink-180-30days', compareUrl: 'https://naturism-diet.com/pages/compare#nxcp-pink' },
  premium: { name: 'naturism Premium', desc: '糖質も脂質もしっかりケアして結果を出したいあなたには、トータルケアのプレミアムがぴったり。', storeUrl: 'https://naturism-diet.com/products/naturism-premium-180-20days', compareUrl: 'https://naturism-diet.com/pages/compare#nxcp-premium' },
};

var quizCurrentStep = 0;
var quizAnswers = {};
var quizAdvancing = false;
var quizAdvanceTimer = null;

// 中断・誤リロードしても途中から再開できるように sessionStorage へ保存。
// v2 = 9問版 (q2 は配列)。旧 v1 (8問版) とは形が違うためキーごと世代交代して無効化。
var QUIZ_STATE_KEY = 'quiz_state_v2';
function saveQuizState() {
  try { sessionStorage.setItem(QUIZ_STATE_KEY, JSON.stringify({ step: quizCurrentStep, answers: quizAnswers })); } catch (e) { /* private mode 等 */ }
}
function loadQuizState() {
  try {
    var raw = sessionStorage.getItem(QUIZ_STATE_KEY);
    if (!raw) return null;
    var st = JSON.parse(raw);
    if (!st || typeof st.step !== 'number' || st.step < 0 || st.step >= QUIZ_QUESTIONS.length) return null;
    if (!st.answers || typeof st.answers !== 'object') return null;
    return st;
  } catch (e) { return null; }
}
function clearQuizState() {
  try { sessionStorage.removeItem(QUIZ_STATE_KEY); } catch (e) { /* ignore */ }
}

function startQuiz() {
  var saved = loadQuizState();
  if (saved) {
    // 途中再開 (中断/リロードからの復帰)
    quizCurrentStep = saved.step;
    quizAnswers = saved.answers || {};
  } else {
    quizCurrentStep = 0;
    quizAnswers = {};
  }
  if (quizAdvanceTimer) { clearTimeout(quizAdvanceTimer); quizAdvanceTimer = null; }
  quizAdvancing = false;
  document.getElementById('quiz-intro').style.display = 'none';
  document.getElementById('quiz-result').style.display = 'none';
  document.getElementById('quiz-steps').style.display = 'block';
  renderQuizStep();
}

function retryQuiz() {
  clearQuizState();
  startQuiz();
}

// ✕ で中断 → intro へ戻る。進捗は保持されるので「診断スタート」で途中から再開できる。
// pending の advance timer は必ず破棄 (150ms 窓で ✕→再開すると stale timer が state を進める race 防止)。
function cancelQuiz() {
  if (quizAdvanceTimer) { clearTimeout(quizAdvanceTimer); quizAdvanceTimer = null; }
  quizAdvancing = false;
  document.getElementById('quiz-steps').style.display = 'none';
  document.getElementById('quiz-intro').style.display = 'block';
}

// ← ひとつ前へ戻る (本サイト同様。answers は保持 = 前の回答がハイライト/順位で復元される)
function backQuiz() {
  if (quizAdvancing) return;
  quizCurrentStep = Math.max(0, quizCurrentStep - 1);
  saveQuizState();
  renderQuizStep();
}

function renderQuizStep() {
  var q = QUIZ_QUESTIONS[quizCurrentStep];
  document.getElementById('quiz-progress').textContent = '質問 ' + (quizCurrentStep + 1) + ' / ' + QUIZ_QUESTIONS.length;
  document.getElementById('quiz-progress-bar').style.width = (quizCurrentStep / QUIZ_QUESTIONS.length * 100) + '%';
  document.getElementById('quiz-question').textContent = q.text;
  var box = document.getElementById('quiz-options');
  box.innerHTML = '';
  if (q.kind === 'rank') renderQuizRank(q, box);
  else renderQuizSingle(q, box);
  document.getElementById('quiz-back').style.display = quizCurrentStep === 0 ? 'none' : 'inline-block';
}

function renderQuizSingle(q, box) {
  var LETTERS = 'ABCD';
  q.options.forEach(function (o, oi) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'nxq-opt';
    if (quizAnswers[q.id] === o.label) b.classList.add('is-picked'); /* 戻った時に前回回答を保持表示 */
    var mark = document.createElement('b');
    mark.textContent = LETTERS[oi] || String(oi + 1);
    b.appendChild(mark);
    b.appendChild(document.createTextNode(o.label));
    b.onclick = function () { selectQuizOption(oi); };
    box.appendChild(b);
  });
}

function selectQuizOption(optIdx) {
  if (quizAdvancing) return; // 連打で 2 問飛ぶ二重 advance を防止
  var q = QUIZ_QUESTIONS[quizCurrentStep];
  var o = q.options[optIdx];
  quizAnswers[q.id] = o.label;
  saveQuizState(); // 150ms の advance 待ちに依存させない — 待ち中の中断でも回答が残る

  var btns = document.getElementById('quiz-options').querySelectorAll('button');
  for (var b = 0; b < btns.length; b++) btns[b].classList.remove('is-picked');
  btns[optIdx].classList.add('is-picked');

  // progress bar は選択直後に即時更新 — 待ち時間が「進んでいる」アニメーションになる
  document.getElementById('quiz-progress-bar').style.width = ((quizCurrentStep + 1) / QUIZ_QUESTIONS.length * 100) + '%';

  // Auto advance (150ms: ハイライトを見せつつ軽快に)
  quizAdvancing = true;
  quizAdvanceTimer = setTimeout(function () {
    quizAdvanceTimer = null;
    quizAdvancing = false;
    quizAdvanceStep();
  }, 150);
}

function quizAdvanceStep() {
  if (quizCurrentStep < QUIZ_QUESTIONS.length - 1) {
    quizCurrentStep++;
    saveQuizState();
    renderQuizStep();
  } else {
    finishQuiz();
  }
}

/* Q2: タップ順に1位→2位→3位を採番 (再タップで解除・以降繰り上げ)。3位まで選ぶと次へが活性化 (本サイトと同一挙動) */
function renderQuizRank(q, box) {
  var picked = Array.isArray(quizAnswers[q.id]) ? quizAnswers[q.id].slice() : [];
  var wrap = document.createElement('div');
  wrap.className = 'nxq-opts';
  var foot = document.createElement('div');
  foot.className = 'nxq-rankfoot';
  var resetB = document.createElement('button');
  resetB.type = 'button';
  resetB.className = 'nxq-rankreset';
  resetB.textContent = 'リセット';
  var nextB = document.createElement('button');
  nextB.type = 'button';
  nextB.className = 'nxq-ranknext';
  nextB.textContent = '次へ →';
  function build() {
    wrap.innerHTML = '';
    q.options.forEach(function (label) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'nxq-opt nxq-opt--rank';
      var pos = picked.indexOf(label);
      var mark = document.createElement('b');
      if (pos > -1) {
        b.classList.add('is-ranked');
        mark.textContent = (pos + 1) + '位';
      } else {
        mark.textContent = '';
        mark.className = 'is-empty';
      }
      b.appendChild(mark);
      b.appendChild(document.createTextNode(label));
      b.onclick = function () {
        var p = picked.indexOf(label);
        if (p > -1) picked.splice(p, 1);
        else if (picked.length < 3) picked.push(label);
        quizAnswers[q.id] = picked.slice(); /* 編集を即同期 = 戻る→再訪でも最新順位を復元 */
        saveQuizState();
        build();
      };
      wrap.appendChild(b);
    });
    nextB.disabled = picked.length < 3;
  }
  resetB.onclick = function () {
    picked = [];
    quizAnswers[q.id] = [];
    saveQuizState();
    build();
  };
  nextB.onclick = function () {
    if (picked.length < 3 || quizAdvancing) return;
    quizAnswers[q.id] = picked.slice();
    saveQuizState();
    document.getElementById('quiz-progress-bar').style.width = ((quizCurrentStep + 1) / QUIZ_QUESTIONS.length * 100) + '%';
    quizAdvanceStep();
  };
  box.appendChild(wrap);
  box.appendChild(foot);
  foot.appendChild(resetB);
  foot.appendChild(nextB);
  build();
}

/* 採点 (本サイト scoreQuiz の完全ミラー。保存時の採点はサーバー側 quiz-engine.ts が正) */
function scoreQuiz9() {
  var s = { blue: 0, pink: 0, premium: 0 };
  for (var i = 0; i < QUIZ_QUESTIONS.length; i++) {
    var q = QUIZ_QUESTIONS[i];
    var a = quizAnswers[q.id];
    if (a == null) continue;
    if (q.kind === 'rank') {
      if (!Array.isArray(a)) continue;
      for (var r = 0; r < a.length && r < 3; r++) {
        var t = QUIZ_Q2_CUISINE[a[r]];
        if (t) s[t] += QUIZ_Q2_RANK_PTS[r] || 0;
      }
    } else {
      for (var j = 0; j < q.options.length; j++) {
        if (q.options[j].label === a) {
          var p = q.options[j].pts;
          if (p) { s.blue += p.blue || 0; s.pink += p.pink || 0; s.premium += p.premium || 0; }
          break;
        }
      }
    }
  }
  /* 同点処理 (決定的): Q9=初めて → blue>pink>premium / それ以外 → premium>blue>pink */
  var first = quizAnswers.q9 === '初めて';
  var prio = first ? ['blue', 'pink', 'premium'] : ['premium', 'blue', 'pink'];
  var max = Math.max(s.blue, s.pink, s.premium);
  var rec = prio.filter(function (t) { return s[t] === max; })[0];
  return { rec: rec, scores: s };
}

function finishQuiz() {
  clearQuizState(); // 完了 → 次回は最初から
  var r = scoreQuiz9();
  var product = QUIZ_PRODUCTS[r.rec];

  // Display result (entrance animation — .section class は switchTab 管理下に入るため inline で)
  document.getElementById('quiz-progress-bar').style.width = '100%';
  document.getElementById('quiz-steps').style.display = 'none';
  document.getElementById('quiz-result').style.display = 'block';
  document.getElementById('quiz-result').style.animation = 'fadeUp 0.38s cubic-bezier(0.22,1,0.36,1)';
  var nameEl = document.getElementById('result-name');
  nameEl.textContent = product.name;
  nameEl.className = 'nxq-rname nxq-rname--' + r.rec;
  document.getElementById('result-reason').textContent = product.desc;
  document.getElementById('result-compare-link').href = product.compareUrl;
  document.getElementById('result-store-link').href = product.storeUrl;

  /* 度数バー: 必ず ブルー度→ピンク度→プレミアム度 の固定順 (得点順に並べ替えない)。% は合計比 */
  var total = r.scores.blue + r.scores.pink + r.scores.premium;
  var barsBox = document.getElementById('result-scores');
  barsBox.innerHTML = '';
  QUIZ_TYPES.forEach(function (t) {
    var pct = total > 0 ? Math.round(r.scores[t] / total * 100) : 0; /* ゼロ除算ガード */
    var row = document.createElement('div');
    row.className = 'nxq-brow nxq-brow--' + t;
    var lb = document.createElement('span');
    lb.className = 'nxq-blabel';
    lb.textContent = QUIZ_TYPE_LABELS[t];
    var track = document.createElement('span');
    track.className = 'nxq-btrack';
    var fill = document.createElement('span');
    fill.className = 'nxq-bfill';
    track.appendChild(fill);
    var val = document.createElement('span');
    val.className = 'nxq-bval';
    val.textContent = pct + '%';
    row.appendChild(lb);
    row.appendChild(track);
    row.appendChild(val);
    barsBox.appendChild(row);
    requestAnimationFrame(function () { requestAnimationFrame(function () { fill.style.width = pct + '%'; }); });
  });

  // Submit to server (non-blocking、結果表示とかぶらないよう少し遅らせて通知)
  if (!isDemo && idToken) {
    api('/api/liff/quiz/submit', { answers: quizAnswers }).then(function(res) {
      if (apiFailed(res)) { showToast('結果を保存できませんでした'); return; }
      setTimeout(function() { showToast('診断結果を保存しました'); }, 600);
    }).catch(function() { showToast('結果を保存できませんでした'); });
  }
}

// ─── Init ───
document.addEventListener('DOMContentLoaded', initLiff);

// 「読み込み中...」永久固着の watchdog: liff.init や API が resolve も reject もしないまま
// 固まるケース (SDK/回線不調) で、12 秒後に明示エラー + 再読み込みへ倒す。
setTimeout(function () {
  var el = document.getElementById('loading');
  if (el && el.style.display !== 'none' && !window.__fatalShown) {
    showFatalError('読み込みに時間がかかっています。通信環境をご確認のうえ、もう一度開いてください🌿');
  }
}, 12000);
</script>
</body>
</html>`;
}

export { liffPages };
