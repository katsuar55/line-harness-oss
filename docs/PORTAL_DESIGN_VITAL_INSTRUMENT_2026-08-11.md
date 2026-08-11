実装仕様の統合が完了した。以下が最終実装仕様(全文)。

---

# 最終実装仕様: LIFF ポータル「VITAL INSTRUMENT」改修 (+ 移植要素)

**ベース** = 審査 3 名全員一致の勝者「VITAL INSTRUMENT (白い精密計器 × 生命力のグラデ)」(87/87/86 点)。
**移植** = Porcelain Calm から ①ブランド固定 confetti ②Ambassador 金の額装 ③アバター二重リング ④ヘッダ saturate(1.5) ⑤空クーポン回遊化、MAISON ÉDITORIAL から ⑥「動く枠は ref-hero 1 枚だけ」憲法 ⑦バッジ「n / N」ノンブル ⑧ストリーク数字主役化 ⑨CTA letter-spacing .04em ⑩タップ scale 統一 .96。
**移植禁止** (審査で明示却下): serif 数字 (Android フォールバック割れ)・仏英 eyebrow (『NIVEAU』『ACHIEVEMENTS』等 — ラベルは日本語)・絵文字の全面退役・4px 細ゲージ・ヘッダ通電レールのアニメーション (静的グラデに減光)。

対象ファイル: `C:\dev\line-harness-oss\apps\worker\src\routes\liff-pages.ts` (4,631 行・単一 inline CSS/JS)。
行番号は main `99af18e` 時点。編集時は行番号でなく **引用文字列を grep して anchor** すること。

---

## 1. 最終トークン表 (現行値 → 新値)

### 1-1. `:root` (L77) — **置換ではなく追記。既存 11 変数は名前・値とも温存**

現行 (実測):
```
:root{--brand:#2fa8ad;--brand-deep:#1d7d82;--brand-soft:#eef7f7;--brand-tint:#dff0f0;--brand-line:#e3ecec;--ink:#052422;--muted:#66727d;--coral:#ffb39c;--coral-deep:#d9573d;--coral-ink:#b84a2e;--coral-soft:#fff3ec}
```

追記する新変数:

| 変数 | 値 | 用途 / コントラスト根拠 |
|---|---|---|
| `--brand-hi` | `#0ABAB5` | ブランド原色。**グラデ先端・非テキスト装飾専用** (白地 2.3:1 — 文字・単色面塗り禁止) |
| `--action` | `#0f766e` | 主 CTA 塗り (白文字 5.47:1 AA✓・既存 .btn-primary 値の昇格) |
| `--action-2` | `#0d827d` | ゲージ終端・セカンダリ (白文字 4.66:1 AA✓・既存 ros 値の昇格) |
| `--ink-2` | `#3f4b55` | 本文・補足 (白地 9.2:1) |
| `--hairline` | `#dfe9e9` | 精密ヘアライン (現 --brand-line #e3ecec より 1 段締め) |
| `--track` | `#e6efef` | ゲージ・リングの空トラック (終端 #0d827d と 3:1+ = WCAG 1.4.11✓) |
| `--well` | `#f2f8f8` | 沈み面 (クーポンコード地) |
| `--gold` | `#b8933f` | ≥24px 太字専用 (既存 .nxq-rname--premium 値) |
| `--gold-ink` | `#8a6a24` | 小文字 AA (白 5.05:1) ★新規 |
| `--gold-deep` | `#92400e` | 白文字塗り (7.0:1・既存 ambassador-badge 値) |
| `--gold-line` | `#e6d5a8` | 金の額装ヘアライン ★新規 (Porcelain 移植) |
| `--gold-wash` | `#faf6ec` | 額装の地 ★新規 (Porcelain 移植) |
| `--grad-vital` | `linear-gradient(90deg,#0ABAB5,#0d827d)` | ゲージ塗り (終端側で非テキスト 3:1 担保) |
| `--grad-btn` | `linear-gradient(180deg,#11837c,#0f766e)` | 主ボタン (両端とも白文字 4.6:1+) |
| `--shadow-rest` | `0 1px 2px rgba(8,58,60,.05),0 8px 24px rgba(8,58,60,.07)` | カード静止影 (黒でなくティール色相) |
| `--shadow-float` | `0 2px 6px rgba(8,58,60,.08),0 16px 40px rgba(8,58,60,.10)` | 強調カード |
| `--edge-light` | `inset 0 1px 0 rgba(255,255,255,.85)` | カード上端の内側ハイライト |
| `--ease` | `cubic-bezier(.22,1,.36,1)` | 既存の署名イージングの命名 |
| `--dur-tap` | `120ms` / `--dur-ui:240ms` / `--dur-gauge:700ms` | モーション階段 |

### 1-2. 既存セレクタの値変更 (現行値 → 新値)

| 箇所 (anchor) | 現行 | 新値 |
|---|---|---|
| `.tab-active` (L79) | `color:#1d7d82;border-bottom:2.5px solid #2fa8ad;font-weight:600` | `color:#052422;font-weight:700;border-bottom:none;background:linear-gradient(90deg,#0ABAB5,#1d7d82) bottom/100% 3px no-repeat` |
| `.tab-inactive` (L80) | `color:#475569;border-bottom:2.5px solid transparent` | `color:#3f4b55;border-bottom:none;font-weight:600` |
| タブ button (CSS 追加のみ) | `text-xs` (12px)・py-3 実測 ~42px | `.tab-strip button{font-size:13px;min-height:48px}` (クラス名・markup 無改変。specificity で text-xs に勝つ) |
| `.btn-primary` (L85) | `background:#0f766e; letter-spacing:.02em` | `background:var(--grad-btn);letter-spacing:.04em;min-height:48px` (pill・影は現行維持) |
| `.btn-primary:active` (L86) | `scale(0.95)` | `scale(.96)` (translateY(1.5px) は維持) |
| `.btn-coral:active` (L107) | `scale(0.95)` | `scale(.96)` |
| `.mood-btn 等:active` (L184) / `.meal-btn:active` (L213) | `scale(0.95)` | `scale(.96)` |
| `button:active,.tap:active…` (L265) | `scale(0.97)` | `scale(.96)` |
| `.active\:scale-\[0\.98\]:active` (L267) | `scale(0.98)` | `scale(.96)` |
| `.nxq-opt:active`(L125)/`.nxq-rcta:active`(L151)/`.ros-primary:active`(L166) | `scale(.97)` | `scale(.96)` |
| `.card` (L171) | `border:1px solid #e3ecec;box-shadow:0 2px 6px rgba(24,34,41,.05),0 12px 32px rgba(24,34,41,.06)` | `border:1px solid var(--hairline);box-shadow:var(--shadow-rest),var(--edge-light)` (radius 20px・白地維持) |
| `.ambassador-badge` (L194) | `font-size:10px` | `font-size:11px` (他は現行維持) |
| `.rank-ambassador` (L197) | amber rgba グラデ地 + `border:1.5px solid rgba(251,191,36,.25)` | `background:var(--gold-wash) !important;border:1px solid var(--gold-line) !important` (額装・Porcelain 移植) |
| `.rank-ambassador::before` (L198) | `animation:sparkleRotate 8s`・conic opacity .06/.04 | `animation:sparkleRotate 14s`・opacity 半減 (`.03`/`.02`) |
| confetti palette (L2150, JS) | `['#2fa8ad','#f59e0b','#ec4899','#3b82f6','#8b5cf6']` | `['#2fa8ad','#b8933f','#ffffff','#dff0f0']` |
| AA 是正 (brand-skin 層 L242〜 に追記) | `.text-gray-400` = #9ca3af (2.54:1 AA 不成立・実在バグ) | `.text-gray-400{color:#66727d !important}` の 1 行追加 |
| ヘッダ inline style (L278) | `backdrop-filter:blur(16px)` | `blur(16px) saturate(1.5)` (-webkit- 側も) |
| アバター (L298) | `box-shadow:0 0 0 2px rgba(47,168,173,.45),0 1px 3px rgba(0,0,0,.08)` | `box-shadow:0 0 0 2px #fff,0 0 0 3.5px rgba(47,168,173,.55),0 1px 3px rgba(0,0,0,.08)` (二重リング) |
| 10px チップ各所 (JS 文字列内 `font-size:10px`) | L1891 / L1933 / L1973 / L2004 / L2677 / L2682-84 | `font-size:11px` へ引上げ |

### 1-3. 追加ユーティリティ (inline CSS へ新規)

```css
.num{font-variant-numeric:tabular-nums}
.crd-eyebrow{display:block;font-size:11px;letter-spacing:.18em;font-weight:700;color:#0f766e}
.crd-eyebrow--coral{color:#b84a2e} .crd-eyebrow--gold{color:#8a6a24}
button:focus-visible,.tap:focus-visible{outline:3px solid rgba(10,186,181,.4);outline-offset:2px}
```
ラベルは**日本語** (「ランク」「クーポン」「連携」)。英仏語 eyebrow は禁止。

### 1-4. モーション憲法 (CSS コメントとして L221 付近に明文化・MAISON 移植)

```
/* モーション憲法: 「動く枠」は .ref-hero 1 枚だけ (お得=動、格式=静)。
   常時アニメの新設禁止。達成演出は 1 回きり (iteration-count:1)。
   新規 animation/transition は必ず下の prefers-reduced-motion ブロックに追記する。 */
```

---

## 2. コンポーネント別の変更指示

### A. ヘッダ (L278) — 計器盤 (静的)
- inline style に `saturate(1.5)` 追加 (§1-2)。アバター二重リング (§1-2)。
- `border-bottom:1px solid rgba(0,0,0,.06)` → `border-bottom:none` にし、CSS へ追加:
```css
header.sticky::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,transparent,rgba(10,186,181,.55),transparent);pointer-events:none}
```
**アニメーションなし** (審査 3 の指摘どおり静的に減光。憲法準拠)。ロゴ・言語メニュー・`#scroll-progress`/`#scroll-leaf` は無改変。

### B. タブバー (L79-80, L304-314) — レーザーレール
§1-2 のとおり。**クラス名 `tab-active`/`tab-inactive` は絶対に変えない** (switchTab L1616-1619 が `className.replace('tab-active','tab-inactive')` で機械置換している)。markup・JS 無改変、CSS 2 行差替 + `.tab-strip button` 1 行追加のみ。

### C. カード共通 (L171) — 計器ガラス
§1-2 のとおり。カード見出しの新様式 `.crd-eyebrow` は**触った PR から順次採用** (一括改修禁止)。絵文字見出しは温存可 (60 代のアイコン言語 — 審査 1 の指摘)。

### D. 主ボタン (L85)
§1-2 のとおり。`@media(hover:hover)` の hover 影 (L190) は現行維持。

### E. クーポン一覧 (loadCoupons L2041-2070) — チケット様式
CSS 追加:
```css
.coupon-ticket{position:relative;border:1px solid var(--hairline);border-radius:14px;padding:10px 12px 10px 17px;background:#fff;margin-bottom:8px}
.coupon-ticket::before{content:'';position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:3px;background:var(--grad-vital)}
.coupon-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;font-weight:700;letter-spacing:.08em;color:#0f766e;background:var(--well);border:1.5px dashed #9fd4d2;border-radius:8px;padding:2px 8px;display:inline-block}
```
- 現行の `border-b` 区切りリスト行 (L2051-2055) を `.coupon-ticket` 行へ書換。コードは `.coupon-code`、期限は `.num` 12px `--muted`、**残 3 日以下は chip (11px/700 `#b84a2e` on `#fff3ec`) を先頭に**。コピーボタン (44px+ 維持) は現行 teal 枠 pill のまま。
- **ノッチ (左右の切込み円) は作らない** — 白カード上で背景色が合わず浮く (審査 1 が指摘したバグ)。左レール + 点線コードで金券感を出す。
- welcome/referral/link/friend の単品カード (L1877-2017) は**構造無改変**。10px チップ→11px と、割引大数字への `class="num"` 追加のみ (色ルール現行どおり: 艶コーラル #d9573d は 24px+ 専用)。

### F. ランクカード (loadRank L1801-1856) — ゲージ計器
innerHTML テンプレートを次のとおり改修 (esc() エスケープ・`position:relative;z-index:1` の重ね順は現行踏襲):
1. アイコン円 48px → **conic リング**: 外周 `background:conic-gradient(from -90deg,#0ABAB5,#0d827d ${pct}%,var(--track) 0)` の 48px 円 + 内側 40px 白円にランクアイコン。
2. バー: `h-2` (8px) → **10px**・track `var(--track)`・塗り `var(--grad-vital)`・上に `repeating-linear-gradient(90deg,transparent 0 calc(25% - 1px),rgba(255,255,255,.9) 0 25%)` の白目盛。`progress-bar` クラス (width transition) は維持。
3. バー右端に進捗 % を `20px/800/#0f766e` `.num` で追加。
4. 「次のランク X まであと ¥N」: 現 `text-gray-400` → `13px #3f4b55`、金額のみ `15px/700/#052422` `.num` (※ §1-2 の !important 是正で最低ラインは全域先に直る)。
5. CTA 行 `bg-green-50` (brand-skin で #eef7f7 に写像済) は現行クラス維持、`min-height:44px` を style 追加。
6. **Ambassador**: §1-2 の額装 + sparkle 14s/半減。バッジ #92400e は現行維持。進捗バー塗り (L1842 inline の `#fbbf24,#f59e0b`) は `linear-gradient(90deg,#b8933f,#8a6a24)` へ。
7. 未購入者分岐 (L1848-1853) は文言・構造無改変 (ティーザーは薬機法セーフ設計済)。

### G. バッジカード (L372-392, loadBadges L2241-2289) — ノンブル + メダル
- ヘッダ右端 `#badge-level-mini` の隣に `<span id="badge-nombre" class="num" style="font-size:12px;font-weight:700;color:#66727d"></span>` を追加し、loadBadges 成功時に `earnedBadges.length + ' / ' + allBadges.length` (例「07 / 12」ゼロ埋めは `String(n).padStart(2,'0')`) を書く (MAISON 移植)。
- 獲得済チップ: 現行 `bg-green-50 border-2 border-green-200` 維持 (brand-skin が teal に写像済) + `box-shadow:inset 0 1px 2px rgba(8,58,60,.12)` のエンボス。
- 未獲得: `opacity-40` → `opacity:.35;filter:grayscale(1)`。
- 経験値バー (L384): `linear-gradient(90deg,#2fa8ad,#0f766e)` → `var(--grad-vital)`。
- `text-[10px]` バッジ名 (L2284) → `text-[11px]`。

### H. ストリーク (loadIntakeData L2095-2119) — 数字主役 (MAISON 移植)
- 絵文字 `text-4xl` → `text-2xl` へ降格、連続日数 `text-3xl` → `font-size:34px` + `class="num"` へ昇格。
- `streak-fire` パルスは**現行維持** (Katsu 実機FB資産。Porcelain の封印案は不採用)。

---

## 3. 1 秒ダッシュボード「VITAL STRIP」

### 3-1. DOM (挿入位置: `<div id="section-home" class="section active space-y-4">` (L319) の直後、`#welcome-coupon-card` (L321) の**前**)

```html
<div id="vital-strip" class="card" role="group" aria-label="あなたの現在ステータス" style="padding:4px 6px">
  <div class="vs-grid">
    <button type="button" class="vs-cell tap" onclick="vsJumpRank()" aria-label="会員ランクの詳細へ">
      <span class="vs-ring" id="vs-ring" style="--p:0%"><span class="vs-ring-in" id="vs-rank-icon">🌱</span></span>
      <span class="vs-meta"><b class="vs-b">ランク</b><small class="vs-s num" id="vs-rank-sub"><span class="skeleton vs-sk"></span></small></span>
    </button>
    <span class="vs-div" aria-hidden="true"></span>
    <button type="button" class="vs-cell tap" id="vs-coupon-cell" onclick="vsJumpCoupons()" aria-label="クーポン一覧へ">
      <span class="vs-num num" id="vs-coupon-n">–</span>
      <span class="vs-meta"><b class="vs-b">クーポン</b><small class="vs-s" id="vs-coupon-sub"><span class="skeleton vs-sk"></span></small></span>
    </button>
    <span class="vs-div" aria-hidden="true"></span>
    <button type="button" class="vs-cell tap" id="vs-link-cell" onclick="vsLinkTap()" aria-label="ストア連携の状態">
      <span class="vs-dot" id="vs-link-dot"></span>
      <span class="vs-meta"><b class="vs-b">連携</b><small class="vs-s" id="vs-link-sub"><span class="skeleton vs-sk"></span></small></span>
    </button>
  </div>
</div>
```

### 3-2. CSS (追加のみ)

```css
.vs-grid{display:grid;grid-template-columns:1.3fr 1px 1fr 1px 1fr;align-items:stretch}
.vs-cell{display:flex;align-items:center;gap:8px;min-height:56px;padding:6px 8px;background:none;border:0;text-align:left;border-radius:12px}
.vs-div{background:linear-gradient(180deg,transparent,var(--hairline) 30%,var(--hairline) 70%,transparent)}
.vs-ring{--p:0%;width:40px;height:40px;border-radius:50%;flex:none;background:conic-gradient(from -90deg,#0ABAB5,#0d827d var(--p),var(--track) 0);display:flex;align-items:center;justify-content:center}
.vs-ring-in{width:32px;height:32px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:inset 0 0 0 1px #eef4f4}
.vs-num{font-size:24px;font-weight:800;color:#052422;letter-spacing:-.5px;min-width:28px;text-align:center}
.vs-b{display:block;font-size:12px;font-weight:700;color:#052422;line-height:1.3}
.vs-s{display:block;font-size:11px;font-weight:600;color:#66727d;line-height:1.3}
.vs-s.is-ng{color:#b84a2e} .vs-s.is-ok{color:#0f766e}
.vs-dot{width:12px;height:12px;border-radius:50%;flex:none;background:#c3cdd4}
.vs-dot.is-on{background:#0d827d;box-shadow:0 0 0 3px rgba(13,130,125,.18)}
.vs-dot.is-off{background:#d9573d;box-shadow:0 0 0 3px rgba(217,87,61,.15)}
.vs-sk{display:inline-block;width:44px;height:12px;border-radius:6px}
#vital-strip .vs-cell:nth-of-type(1) .skeleton{animation-delay:.15s}
#vital-strip .vs-cell:nth-of-type(2) .skeleton{animation-delay:.3s}
#vital-strip .vs-cell:nth-of-type(3) .skeleton{animation-delay:.45s}
```
色覚対応 = dot 色 + テキスト「連携済み/未連携」の二重符号化。ring 終端 #0d827d vs track #e6efef ≈ 3:1+ で WCAG 1.4.11 準拠。

### 3-3. データソースと JS 配線 (**追加 fetch ゼロ・新規エンドポイント不要**)

| セル | ソース | 配線 |
|---|---|---|
| ランク | `POST /api/liff/rank` (loadRank L1801 が既取得)。応答: `data.currentRank{name,icon}` / `data.progressPercent` / `data.nextRank.remaining` / `data.linked` | loadRank 成功分岐の末尾に追記: `#vs-ring` の `style.setProperty('--p', pct+'%')`、`#vs-rank-icon.textContent = currentRank.icon`、`#vs-rank-sub.textContent = currentRank ? currentRank.name : 'はじめて'`。nextRank があれば sub を `currentRank.name` のままにし、値はランク名 (60 代に最重要なのは「自分の格」の名前) |
| クーポン枚数 | 発生源が**互いに素な 5 系統**: `/api/liff/coupons` (coupon_assignments 台帳・loadCoupons) と welcome/referral/link/friend (Shopify 個人コード・各専用 endpoint)。重複なし (liff-portal.ts L204-231 で確認済) | 共有集計 `window.__vsCoupons = {list:0,welcome:0,referral:0,link:0,friend:0}` を用意し、**各 loader が表示成功時に自キーへ「set」** (increment 禁止 = 再実行冪等)。set 後に `updateVsCouponCell()` を呼び合計を `#vs-coupon-n` へ。**0 枚のとき**: `#vs-coupon-n` を `–` のままにし `#vs-coupon-sub` を「もらう →」(`class="vs-s is-ng"`)、セルの onclick を `vsJumpReferral()` へ差替 (Porcelain 移植・空状態の回遊化) |
| 連携 | 同じ `/api/liff/rank` の `data.linked`。**単調性ガード (L1814-1822) と同じ向き**: 一度 on にしたら off へ戻さない (`window.__shopifyLinked` を参照) | `markShopifyLinked()` (L3810) の中にも dot=is-on / sub「連携済み」更新を 1 行追加 (連携完了の瞬間に strip も同期)。未連携: dot=is-off / sub「未連携 →」 |

新規関数 (すべて**名前付き関数** — inline onclick の引用符ネスト禁止規約準拠):
```js
function vsJumpRank(){ var el=document.getElementById('rank-card'); if(el) el.scrollIntoView({behavior: TAB_REDUCED_MOTION?'auto':'smooth'}); }
function vsJumpCoupons(){ /* 同型: coupons-card へ */ }
function vsJumpReferral(){ scrollToReferralCard(); }  // 既存 L2074 を再利用
function vsLinkTap(){ if(window.__shopifyLinked===true){ vsJumpRank(); } else { openShopifyLinkPage(); } }
```
- 枚数は 400ms の rAF count-up (TAB_REDUCED_MOTION なら即値)。
- 値の書込みは全て `textContent` — `jsonForScript`/`escapeHtmlAttr` が必要な埋込みは発生しない設計を維持する (発生させたら規約どおり使い分け)。
- 新規ルートなし = `liff-script-syntax.test.ts` の対象表への追加は不要 (既存 /liff/portal の検証に自動的に乗る)。

---

## 4. 変更しないもの (壊してはいけない)

1. **ID**: `section-home/quiz/shop/intake/account`, `tab-home` 等 4 つ, `rank-card`, `coupons-card`, `referral-card`, `ranking-card`, `badge-card`, `badge-grid`, `badge-level-num`, `badge-score`, `badge-pts-next`, `badge-progress-bar`, `intake-today-card`, `meal-breakfast/lunch/dinner`, `tip-card`, `welcome-coupon-card`, `referral-coupon-card`, `link-coupon-card`, `friend-coupon-card`, `shopify-link-home-card`, `next-move-card`, `user-avatar`, `lang-btn/lang-menu`, `scroll-progress/scroll-leaf`, `toast`, `loading`, `ref-url`, `confetti-overlay`。skeleton stagger の id 指定リスト (L205-212) も無改変。
2. **クラス名の契約**: `tab-active`/`tab-inactive` (switchTab が文字列 replace)、`.section`/`.active`、`.skeleton`、`.progress-bar`、`.sr`/`.sr-in`、`.tap`、`.btn-primary`/`.btn-coral`、`.card`。**名前は不変・値だけ変える**。
3. **JS 契約**: `window.__shopifyLinked` の単調性ガード (L1814-1822)・`markShopifyLinked()`・`openShopifyLinkPage()`・`showShopifyLinkHomeCard()`・`apiFailed()`/`cardError()` のエラー非隠蔽・`isDemo` 分岐・`TAB_REDUCED_MOTION` (L1652)・init 順序 (Promise.all 12 loaders → loadRank await, L1347-1350)・deep-link tabMap (L1591)。
4. **意匠の聖域**: `.ref-hero` の動くグラデ枠 + refShine + ref-gift (Katsu 実機FB第5弾の承認資産 — **唯一の動く枠**として憲法に明記)。「LINEで送る」ボタンの `#06C755` (L2685 — LINE 機能ボタンの唯一の例外)。`#scroll-progress` + 🌿。sublink 系 60 代トークン (L87-101)。nxq 診断 9 問の意匠 (本サイトミラー)。brand-skin !important 層の**機構** (L238-262・値の追記は可、削除不可)。
5. **安全規約**: inline script に literal の script 終了タグを書かない (コメント含む)・`\'` エスケープ禁止・onclick は名前付き関数・値埋込みは `jsonForScript`/`escapeHtmlAttr` を文脈で使い分け・新規 animation は必ず L268 の `prefers-reduced-motion` ブロックへ同時追記 (`.vs-ring` は即時 100% 描画・count-up は即値・conic リングは静止で情報完結)。
6. **薬機法**: 効能効果の断定文言を足さない (ランクティーザー文言 L1852 は現行のまま)。

---

## 5. 実装順 (PR 分割・体感が大きい順)

| PR | 内容 | 触る範囲 | 検証 |
|---|---|---|---|
| **PR-1: 全面ポリッシュ (CSS 中心・最大の面積変化)** | §1 トークン追記 + タブバー + btn-primary グラデ/48px/.04em + カード影/hairline + タップ .96 統一 (9 箇所) + ヘッダ saturate/静的レール + アバター二重リング + **AA 是正** (`.text-gray-400` 1 行 + ambassador-badge 11px) + confetti ブランド固定 + モーション憲法コメント | CSS ブロック + L2150 の 1 行 | `pnpm preflight` → `liff-script-syntax.test.ts` → deploy (post-deploy-check)。実機で全 4 タブ目視 |
| **PR-2: VITAL STRIP (1 秒ダッシュボード)** | §3 全体。DOM 挿入 + CSS + loadRank/loadCoupons/各クーポン loader への set 追記 + markShopifyLinked 同期 + 名前付き関数 4 本 | DOM 1 ブロック + JS ~40 行 | 同上 + 未連携/連携済/クーポン 0 枚の 3 状態を demo で確認 |
| **PR-3: ランクカード計器化 + Ambassador 額装** | §2-F (conic リング・目盛バー・%・AA 文字・額装・sparkle 14s) | loadRank innerHTML + .rank-ambassador CSS | 同上 + Ambassador ユーザーの実機確認 |
| **PR-4: クーポンチケット化** | §2-E (.coupon-ticket + .coupon-code + 期限 chip + 10px→11px 群) | loadCoupons + 4 renderer の文字列 | 同上 + コピー動作の実機確認 |
| **PR-5: ゲーム性ポリッシュ (小粒)** | §2-G バッジノンブル/エンボス/grayscale + §2-H ストリーク数字主役 + focus-visible | loadBadges / loadIntakeData / CSS 数行 | 同上 |

各 PR 共通: 単一ファイル編集でも **CSS 変更と JS 文字列変更を同一 commit で混ぜない** (revert 容易性)。deploy は `pnpm --filter worker deploy` (事前承認不要・post-deploy-check 内蔵)。JS 文字列 (innerHTML テンプレート) を触る PR-2〜5 は編集前に CLAUDE.md「LIFF inline JS コーディングルール」の自己点検チェックリストを必ず実施。

**関連ファイル**: 実装対象 `C:\dev\line-harness-oss\apps\worker\src\routes\liff-pages.ts` / API 応答定義 `C:\dev\line-harness-oss\apps\worker\src\routes\liff-portal.ts` (POST /api/liff/rank L110-199, POST /api/liff/coupons L204-231) / 恒久ガード `liff-script-syntax.test.ts`・`apps/worker/src/utils/inline-script.ts`。