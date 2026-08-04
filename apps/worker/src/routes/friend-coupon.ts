/**
 * LINE 友だち限定クーポンの管理 (= ON/OFF ボタン + 設定 API)。
 *
 * - GET  /admin/friend-coupon      : 管理トグル HTML ページ (公開 shell。操作は API_KEY 必須の API 経由)。
 *                                    apps/web は本番デプロイされないため、worker 配信の自己完結ページにする。
 * - GET  /api/admin/friend-coupon  : 現在の設定を返す (authMiddleware = API_KEY 保護)。
 * - PUT  /api/admin/friend-coupon  : 設定を upsert (authMiddleware = API_KEY 保護)。
 *
 * 顧客向けの表示は LIFF (GET /api/liff/friend-coupon) が別途読む。
 */
import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  getFriendCouponConfig,
  setFriendCouponConfig,
  type FriendCouponConfig,
} from '../services/friend-coupon-config.js';
import { auditAdminAction } from '../services/admin-audit.js';

export const friendCoupon = new Hono<Env>();

// ─── 管理 API (API_KEY 保護) ───
friendCoupon.get('/api/admin/friend-coupon', async (c) => {
  const cfg = await getFriendCouponConfig(c.env.DB);
  return c.json({ success: true, data: cfg });
});

friendCoupon.put('/api/admin/friend-coupon', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<FriendCouponConfig>;
  const before = await getFriendCouponConfig(c.env.DB);
  const cfg = await setFriendCouponConfig(c.env.DB, {
    enabled: body.enabled,
    percent: body.percent,
    code: body.code,
    label: body.label,
    note: body.note,
  });
  // 「誰がいつクーポンを ON/OFF したか」は景表法・原価影響の観点で必ず残す
  await auditAdminAction(c, {
    action: 'admin.friend_coupon.update',
    targetType: 'friend_coupon_config',
    before: { enabled: before.enabled, percent: before.percent, code: before.code },
    after: { enabled: cfg.enabled, percent: cfg.percent, code: cfg.code },
  });
  return c.json({ success: true, data: cfg });
});

// ─── 管理トグル ページ (公開 HTML shell。実操作は上記 API_KEY 保護 API 経由) ───
friendCoupon.get('/admin/friend-coupon', (c) => c.html(ADMIN_PAGE_HTML));

const ADMIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#059669">
  <meta name="robots" content="noindex,nofollow">
  <title>LINE友だち限定クーポン 設定</title>
  <style>
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:system-ui,-apple-system,'Segoe UI','Noto Sans JP',sans-serif;background:#f6f8f7;margin:0;padding:20px;color:#1f2937}
    .wrap{max-width:520px;margin:0 auto}
    h1{font-size:18px;margin:0 0 4px}
    .sub{font-size:12px;color:#6b7280;margin:0 0 16px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin-bottom:14px}
    label{display:block;font-size:12px;font-weight:700;color:#374151;margin:12px 0 4px}
    input[type=text],input[type=number],input[type=password],textarea{width:100%;padding:10px 12px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px}
    input:focus,textarea:focus{outline:none;border-color:#06C755;box-shadow:0 0 0 3px rgba(6,199,85,.12)}
    .row{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .toggle{position:relative;width:56px;height:30px;flex:none}
    .toggle input{opacity:0;width:0;height:0}
    .slider{position:absolute;inset:0;background:#cbd5e1;border-radius:30px;transition:.2s;cursor:pointer}
    .slider:before{content:'';position:absolute;height:24px;width:24px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
    input:checked+.slider{background:#06C755}
    input:checked+.slider:before{transform:translateX(26px)}
    .big{font-size:15px;font-weight:800}
    button.save{width:100%;padding:13px;background:linear-gradient(135deg,#059669,#06C755);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:800;margin-top:8px;cursor:pointer}
    button.save:active{transform:scale(.99)}
    .hint{font-size:11px;color:#9ca3af;margin-top:4px}
    #status{font-size:13px;font-weight:700;text-align:center;min-height:20px;margin-top:10px}
    .ok{color:#059669}.err{color:#dc2626}
  </style>
</head>
<body>
  <div class="wrap">
    <p style="margin:0 0 8px"><a href="/admin" style="font-size:12px;color:#059669;text-decoration:none;font-weight:700">← ダッシュボードに戻る</a></p>
    <h1>🎁 LINE友だち限定クーポン</h1>
    <p class="sub">全友だち向けのキャンペーンクーポンです。ON にすると、お客様の LINE ポータル (ホーム画面) にクーポンカードが表示されます。OFF に戻すと非表示になります。</p>

    <div class="card">
      <label>管理APIキー</label>
      <input type="password" id="apikey" placeholder="管理者から受け取ったキーを貼り付け" autocomplete="off">
      <p class="hint">この端末にのみ保存されます。ダッシュボード (/admin) で入力済みなら自動で引き継がれます。</p>
    </div>

    <div class="card">
      <div class="row">
        <span class="big">クーポンを表示する</span>
        <label class="toggle"><input type="checkbox" id="enabled"><span class="slider"></span></label>
      </div>
      <label>割引率 (%)</label>
      <input type="number" id="percent" min="1" max="100" value="5">
      <label>Shopify 割引コード (共有)</label>
      <input type="text" id="code" placeholder="例: NTOMO5" autocomplete="off">
      <p class="hint">Shopify 管理画面で「○%OFF」コードを1つ作成し、そのコードを入力してください。</p>
      <label>表示ラベル</label>
      <input type="text" id="label" placeholder="LINE友だち限定クーポン">
      <label>補足 (任意・利用条件など)</label>
      <textarea id="note" rows="2" placeholder="例: 1回のご注文につき1回・他クーポンと併用不可"></textarea>
      <button class="save" id="save">保存する</button>
      <div id="status"></div>
    </div>
  </div>
  <script>
    var $ = function(id){ return document.getElementById(id); };
    var KEY = 'fc_admin_apikey';
    // ダッシュボード (/admin) で保存した共通キーがあれば引き継ぐ
    $('apikey').value = localStorage.getItem(KEY) || localStorage.getItem('lh_admin_apikey') || '';
    function setStatus(msg, ok){ var s=$('status'); s.textContent=msg; s.className= ok?'ok':'err'; }
    function headers(){ var k=$('apikey').value.trim(); return { 'Content-Type':'application/json', 'Authorization':'Bearer '+k }; }
    function load(){
      var k=$('apikey').value.trim(); if(!k) return;
      fetch('/api/admin/friend-coupon',{ headers: headers() })
        .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(function(j){
          // 正しいキーと確認できてから保存 (誤キーで共有キーを潰さない)
          localStorage.setItem(KEY,k); localStorage.setItem('lh_admin_apikey',k);
          var d=j.data||{}; $('enabled').checked=!!d.enabled; $('percent').value=d.percent||5; $('code').value=d.code||''; $('label').value=d.label||''; $('note').value=d.note||''; setStatus('読み込みました', true); })
        .catch(function(e){ setStatus('読み込み失敗: '+e.message+' (APIキーをご確認ください)', false); });
    }
    $('apikey').addEventListener('change', load);
    if($('apikey').value) load();
    $('save').addEventListener('click', function(){
      var k=$('apikey').value.trim(); if(!k){ setStatus('APIキーを入力してください', false); return; }
      var body = { enabled: $('enabled').checked, percent: Number($('percent').value), code: $('code').value.trim(), label: $('label').value.trim(), note: $('note').value };
      // 保存は友だち全員 (約6,600人) のポータル表示に即反映される。誤タップ1回で
      // 実際の割引率と違う表示 (有利誤認) を公開しうるため、送信前に必ず確認を挟む。
      // 他の破壊的操作 (スタッフ削除 / FAQ 削除) には confirm があり、ここだけ無かった。
      // ⚠️ 顧客側は「ON かつコードあり」のときだけ表示する — ON でもコード未設定なら
      // 表示されない。その象限で「表示されます」と断言すると /admin の pill と真逆の嘘になる
      var confirmMsg;
      if(body.enabled && !body.code){
        confirmMsg = 'ON で保存しますが、Shopify 割引コードが未設定のため、お客様のポータルには表示されません。\\n\\nコードを入力してから保存し直すことをおすすめします。このまま保存しますか？';
      } else if(body.enabled){
        confirmMsg = 'クーポンを「表示中」で保存します。友だち全員のポータルに表示されます。\\n\\n割引率 ' + ($('percent').value || '?') + '% は、Shopify 側の割引コード「' + body.code + '」の実際の割引率と一致していますか？';
      } else {
        confirmMsg = 'クーポンを「OFF」で保存します。お客様のポータルから非表示になります。よろしいですか？';
      }
      if(!window.confirm(confirmMsg)){ setStatus('保存を中止しました (変更は反映されていません)', true); return; }
      $('save').disabled=true; setStatus('保存中…', true);
      fetch('/api/admin/friend-coupon',{ method:'PUT', headers: headers(), body: JSON.stringify(body) })
        .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(function(j){
          localStorage.setItem(KEY,k); localStorage.setItem('lh_admin_apikey',k);
          var d=j.data||{};
          // 保存後の表示も顧客側の実際の見え方 (ON かつコードあり = 表示) に一致させる
          if(d.enabled && !d.code){ setStatus('⚠️ ON で保存しましたが、コード未設定のためお客様には表示されていません。コードを入力して保存し直してください', false); }
          else if(d.enabled){ setStatus('✅ 表示ON / '+d.percent+'%OFF / コード: '+d.code, true); }
          else { setStatus('⏸ 表示OFF にしました', true); } })
        .catch(function(e){ setStatus('保存失敗: '+e.message, false); })
        .finally(function(){ $('save').disabled=false; });
    });
  </script>
</body>
</html>`;
