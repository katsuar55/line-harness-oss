import { Hono } from 'hono';
import type { Env } from '../index.js';

/**
 * メール起動ブリッジ (実機FB第5弾 2026-07-10): LINE Flex の uri action は mailto: 非対応
 * (公式 scheme は http/https/line/tel のみ) のため、contact card の「メールを送る」は
 * この https ページを経由する。開くと即メールアプリを起動し、失敗時は手動ボタン + コピー fallback。
 *
 * index.ts 直書きから抽出 (2026-07-31): inline script を持つ公開固定パスとして
 * liff-script-syntax.test.ts (出荷前) と liff-health-check.mjs (deploy 後) の両ゲート対象。
 */
const contactEmailPage = new Hono<Env>();

contactEmailPage.get('/contact/email', (c) => {
  const email = 'info@naturism-diet.com';
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>メールでお問い合わせ | naturism</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans',system-ui,sans-serif;background:#f7fbfa;color:#1e293b;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{text-align:center;max-width:400px;width:90%;padding:40px 24px;background:#fff;border-radius:20px;box-shadow:0 8px 30px rgba(15,118,110,.08);border:1px solid #d7efec}
h1{font-size:18px;font-weight:800;color:#0f766e;margin-bottom:6px}
.sub{font-size:13px;color:#64748b;margin-bottom:24px;line-height:1.6}
.addr{font-size:15px;font-weight:700;color:#0f766e;background:#effaf8;border:1px solid #bfe8e3;border-radius:12px;padding:14px 10px;margin-bottom:16px;word-break:break-all}
.btn{display:block;width:100%;padding:16px;border:none;border-radius:12px;font-size:16px;font-weight:700;text-decoration:none;text-align:center;color:#fff;background:#0f766e;transition:transform .12s ease-out,opacity .15s;margin-bottom:10px}
.btn:active{transform:translateY(2px) scale(.98);opacity:.9}
.btn2{display:block;width:100%;padding:14px;border-radius:12px;font-size:14px;font-weight:700;text-align:center;color:#0f766e;background:#effaf8;border:1px solid #bfe8e3;cursor:pointer}
.btn2:active{transform:translateY(2px) scale(.98)}
.note{font-size:11px;color:#94a3b8;margin-top:18px;line-height:1.7}
.toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:#0f766e;color:#fff;font-size:13px;font-weight:700;padding:10px 20px;border-radius:999px;opacity:0;transition:opacity .25s}
.toast.show{opacity:1}
</style>
</head>
<body>
<div class="card">
<h1>🌿 メールでお問い合わせ</h1>
<p class="sub">メールアプリを起動しています…<br>開かない場合は下のボタンをどうぞ</p>
<div class="addr" id="addr">${email}</div>
<a href="mailto:${email}" class="btn">✉️ メールアプリを開く</a>
<button class="btn2" onclick="copyAddr()">アドレスをコピー</button>
<p class="note">受付: 平日10:00〜17:00 (土日祝・年末年始を除く)<br>お電話: 03-6411-5513</p>
</div>
<div class="toast" id="toast">コピーしました</div>
<script>
setTimeout(function(){ window.location.href = 'mailto:${email}'; }, 400);
function copyAddr(){
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText('${email}'); }
    var t=document.getElementById('toast'); t.classList.add('show');
    setTimeout(function(){ t.classList.remove('show'); },1800);
  }catch(e){}
}
</script>
</body>
</html>`);
});

export { contactEmailPage };
