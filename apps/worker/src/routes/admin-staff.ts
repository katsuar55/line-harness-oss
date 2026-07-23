/**
 * スタッフ管理 + 操作履歴のブラウザ画面 (2026-07-23 Katsu 指示「管理側①スタッフ個別アカウント化」)。
 *
 * - GET /admin/staff : スタッフ管理ページ (公開 HTML shell。実操作は API_KEY 保護の /api/staff/*)
 * - GET /admin/logs  : 操作履歴ページ (同上。データは /api/audit-logs = 全操作を新しい順に)
 *
 * 背景: staff_members / requireRole / audit_logs の基盤は既存だったが、ブラウザから使う手段が
 * 無く、実運用は共有 API キー 1 本のままだった。この 2 ページで「個人キーの発行・失効」と
 * 「誰が何をしたか」を非エンジニアのスタッフが扱えるようにする。
 *
 * inline JS ルール (CLAUDE.md): onclick 属性に引用符ネストを書かない。全て addEventListener +
 * data 属性のイベント委譲で組む (#192 のポータル全損事故の再発防止)。
 */
import { Hono } from 'hono';
import type { Env } from '../index.js';

export const adminStaff = new Hono<Env>();

adminStaff.get('/admin/staff', (c) => c.html(STAFF_PAGE_HTML));
adminStaff.get('/admin/logs', (c) => c.html(LOGS_PAGE_HTML));

/** 2 ページ共通の見た目 (ダッシュボードとトーンを揃える) */
const SHARED_STYLE = `
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:system-ui,-apple-system,'Hiragino Kaku Gothic ProN','Segoe UI','Noto Sans JP',sans-serif;background:#f4f8f8;margin:0;padding:20px;color:#052422;line-height:1.6}
    .wrap{max-width:880px;margin:0 auto}
    header{border-bottom:3px solid #2fa8ad;padding-bottom:12px;margin-bottom:18px}
    h1{font-size:20px;margin:0}
    .sub{font-size:13px;color:#4a6664;margin:4px 0 0}
    .back{display:inline-block;font-size:13px;color:#1d7d82;text-decoration:none;margin-bottom:10px;font-weight:700}
    h2{font-size:15px;color:#1d7d82;margin:26px 0 10px}
    .card{background:#fff;border:1px solid #e3ecec;border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(5,36,34,.05)}
    label{display:block;font-size:12px;font-weight:700;color:#374151;margin:10px 0 4px}
    input,select{width:100%;padding:10px 12px;border:1.5px solid #e3ecec;border-radius:10px;font-size:14px;font-family:inherit}
    input:focus,select:focus{outline:none;border-color:#2fa8ad;box-shadow:0 0 0 3px rgba(47,168,173,.15)}
    .hint{font-size:11px;color:#8aa3a1;margin-top:4px}
    button{padding:10px 16px;background:#2fa8ad;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit}
    button:active{transform:translateY(1.5px)}
    button.ghost{background:#fff;color:#1d7d82;border:1.5px solid #cfe3e3}
    button.danger{background:#fff;color:#b84a2e;border:1.5px solid #eaa588}
    button:disabled{opacity:.5;cursor:not-allowed}
    table{border-collapse:collapse;width:100%;font-size:13px}
    .tablewrap{overflow-x:auto}
    td,th{border-bottom:1px solid #e3ecec;padding:9px 10px;text-align:left;vertical-align:middle}
    th{color:#4a6664;font-size:11px;white-space:nowrap}
    .pill{display:inline-block;border-radius:999px;font-size:11px;font-weight:800;padding:2px 9px;white-space:nowrap}
    .pill.on{background:#e8f6f6;color:#1d7d82}
    .pill.off{background:#fff3ec;color:#b84a2e;border:1px solid #eaa588}
    .pill.owner{background:#1d7d82;color:#fff}
    .pill.admin{background:#d8efef;color:#1d7d82}
    .pill.staff{background:#eef1f1;color:#5b6b6a}
    #status{font-size:13px;font-weight:700;min-height:20px;margin-top:8px}
    .ok{color:#1d7d82}.err{color:#b84a2e}
    .keybox{background:#052422;color:#7fe3e6;font-family:SFMono-Regular,Consolas,monospace;font-size:13px;padding:12px;border-radius:10px;word-break:break-all;margin:8px 0}
    .warnbox{background:#fff3ec;border:1px solid #eaa588;border-radius:12px;padding:12px 14px;font-size:13px;margin:10px 0}
    .whoami{font-size:12px;color:#4a6664;margin-top:6px}
    .actions{display:flex;gap:6px;flex-wrap:wrap}
    .actions button{padding:6px 10px;font-size:12px}
`;

const STAFF_PAGE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#1d7d82">
  <meta name="robots" content="noindex,nofollow">
  <title>スタッフ管理 · naturism</title>
  <style>${SHARED_STYLE}</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="/admin">← ダッシュボードに戻る</a>
  <header>
    <h1>👥 スタッフ管理</h1>
    <p class="sub">スタッフ一人ひとりに専用のログインキーを発行します。退職・端末紛失のときは、その人のキーだけを止められます。</p>
    <div class="whoami" id="whoami"></div>
  </header>

  <div class="card">
    <label>管理APIキー</label>
    <input type="password" id="apikey" placeholder="管理者から受け取ったキーを貼り付け" autocomplete="off">
    <p class="hint">この画面はオーナー権限の人だけが使えます。キーはこの端末にのみ保存されます。</p>
    <div style="margin-top:8px"><button id="load">スタッフ一覧を読み込む</button></div>
    <div id="status"></div>
  </div>

  <h2>登録されているスタッフ</h2>
  <div class="card tablewrap">
    <table>
      <thead><tr><th>名前</th><th>権限</th><th>状態</th><th>キー</th><th>操作</th></tr></thead>
      <tbody id="rows"><tr><td colspan="5" class="hint">APIキーを入れて「スタッフ一覧を読み込む」を押してください</td></tr></tbody>
    </table>
  </div>

  <h2>新しいスタッフを追加</h2>
  <div class="card">
    <label>名前 (必須)</label>
    <input type="text" id="newName" placeholder="例: 山田 花子">
    <label>メールアドレス (任意・連絡用)</label>
    <input type="email" id="newEmail" placeholder="例: yamada@kenkoex.com">
    <label>権限</label>
    <select id="newRole">
      <option value="staff">スタッフ — FAQ・クーポンなど日常業務</option>
      <option value="admin">管理者 — 上記に加えて設定変更・データ書き出し</option>
      <option value="owner">オーナー — 上記に加えてスタッフの追加・削除</option>
    </select>
    <p class="hint">迷ったら「スタッフ」を選んでください。あとから変更できます。</p>
    <div style="margin-top:10px"><button id="create">この内容で発行する</button></div>
    <div id="newKeyArea"></div>
  </div>

  <h2>権限でできること</h2>
  <div class="card tablewrap">
    <table>
      <thead><tr><th>できること</th><th>スタッフ</th><th>管理者</th><th>オーナー</th></tr></thead>
      <tbody>
        <tr><td>ダッシュボードの数字を見る</td><td>✅</td><td>✅</td><td>✅</td></tr>
        <tr><td>FAQ の追加・編集</td><td>✅</td><td>✅</td><td>✅</td></tr>
        <tr><td>友だち限定クーポンの ON/OFF</td><td>✅</td><td>✅</td><td>✅</td></tr>
        <tr><td>友だち情報の編集・個別メッセージ送信</td><td>✅</td><td>✅</td><td>✅</td></tr>
        <tr><td>一斉配信 (ブロードキャスト) の実行</td><td>—</td><td>✅</td><td>✅</td></tr>
        <tr><td>顧客データの書き出し (CSV)</td><td>—</td><td>✅</td><td>✅</td></tr>
        <tr><td>操作履歴を見る</td><td>—</td><td>✅</td><td>✅</td></tr>
        <tr><td>リッチメニューの一斉切替</td><td>—</td><td>✅</td><td>✅</td></tr>
        <tr><td>LINEアカウント設定の変更</td><td>—</td><td>—</td><td>✅</td></tr>
        <tr><td>スタッフの追加・キー再発行・削除</td><td>—</td><td>—</td><td>✅</td></tr>
      </tbody>
    </table>
    <div class="warnbox">
      <strong>この表に無い操作は、3つの権限すべてで実行できます。</strong>
      「スタッフ」は閲覧専用ではありません。取り消せない操作 (一斉配信・CSV書き出し) と
      設定変更だけを権限で分けています。信頼できる方にのみアカウントを発行してください。
    </div>
    <p class="hint">変更操作は「いつ・誰が・何をしたか」が <a href="/admin/logs">操作履歴</a> に記録されます。権限不足で拒否された操作も記録されます。</p>
  </div>

  <div class="card">
    <strong>この端末からログアウト</strong>
    <p class="hint" style="margin-top:4px">共有パソコンを使ったあとや、席を離れるときは必ず押してください。保存されたキーをこの端末から消します。</p>
    <div style="margin-top:8px"><button class="danger" id="logout">キーを消して終了する</button></div>
  </div>
</div>
<script>
  var $ = function(id){ return document.getElementById(id); };
  var KEY = 'lh_admin_apikey';
  $('apikey').value = localStorage.getItem(KEY) || '';
  function setStatus(msg, ok){ var s=$('status'); s.textContent=msg; s.className= ok?'ok':'err'; }
  function key(){ return $('apikey').value.trim(); }
  function headers(){ return { 'Content-Type':'application/json', 'Authorization':'Bearer '+key() }; }
  // textContent 経由は & < > しか実体参照化しないため、属性値には使えない (採点 HIGH:
  // data-name="…" から抜けて任意ハンドラを注入できた)。テキスト用と属性用を分ける。
  function esc(t){ var d=document.createElement('div'); d.textContent=(t==null?'':String(t)); return d.innerHTML; }
  function escAttr(t){ return esc(t).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function roleLabel(r){ return r==='owner'?'オーナー':(r==='admin'?'管理者':'スタッフ'); }

  var myId = null;
  function whoami(){
    if(!key()) return;
    fetch('/api/staff/me',{ headers: headers() })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){
        if(!j || !j.data) return;
        var d=j.data;
        myId = d.id;
        var extra = d.id==='env-owner' ? ' ※共有キーでログイン中です。個人キーへの切替をおすすめします' : '';
        $('whoami').textContent = 'ログイン中: ' + d.name + '（' + roleLabel(d.role) + '）' + extra;
        // オーナー以外はこのページの操作ができないので、その旨を先に伝える
        if(d.role !== 'owner'){
          setStatus('この画面はオーナー権限の方のみ操作できます。スタッフの追加はオーナーにご依頼ください。', false);
        }
      })
      .catch(function(){});
  }

  function load(){
    if(!key()){ setStatus('管理APIキーを入力してください', false); return; }
    setStatus('読み込み中…', true);
    fetch('/api/staff',{ headers: headers() })
      .then(function(r){
        if(r.status===403) throw new Error('この画面はオーナー権限の方のみ利用できます');
        if(r.status===401) throw new Error('APIキーが違います');
        if(!r.ok) throw new Error('HTTP '+r.status);
        return r.json();
      })
      .then(function(j){
        localStorage.setItem(KEY, key());
        render(j.data||[]);
        setStatus('✅ 最新の一覧です', true);
        whoami();
      })
      .catch(function(e){ setStatus('読み込み失敗: '+e.message, false); whoami(); });
  }

  function render(list){
    if(!list.length){ $('rows').innerHTML='<tr><td colspan="5" class="hint">まだ個人アカウントがありません。下のフォームから追加してください。</td></tr>'; return; }
    $('rows').innerHTML = list.map(function(m){
      var statePill = m.isActive ? '<span class="pill on">有効</span>' : '<span class="pill off">停止中</span>';
      var rolePill = '<span class="pill ' + escAttr(m.role) + '">' + esc(roleLabel(m.role)) + '</span>';
      var toggleLabel = m.isActive ? '利用を停止' : '利用を再開';
      return '<tr>'
        + '<td>' + esc(m.name) + (m.email ? '<div class="hint">' + esc(m.email) + '</div>' : '') + '</td>'
        + '<td>' + rolePill + '</td>'
        + '<td>' + statePill + '</td>'
        + '<td class="hint">' + esc(m.apiKey) + '</td>'
        + '<td><div class="actions">'
        +   '<button class="ghost" data-act="regen" data-id="' + escAttr(m.id) + '" data-name="' + escAttr(m.name) + '">キー再発行</button>'
        +   '<button class="ghost" data-act="toggle" data-id="' + escAttr(m.id) + '" data-active="' + (m.isActive?'1':'0') + '">' + toggleLabel + '</button>'
        +   '<button class="danger" data-act="del" data-id="' + escAttr(m.id) + '" data-name="' + escAttr(m.name) + '">削除</button>'
        + '</div></td>'
        + '</tr>';
    }).join('');
  }

  function showNewKey(name, apiKey){
    $('newKeyArea').innerHTML =
      '<div class="warnbox"><strong>' + esc(name) + ' さんのログインキーができました。</strong><br>'
      + 'この画面を離れると二度と表示できません。今すぐ本人に安全な方法で渡してください（チャットやメールに貼らない）。</div>'
      + '<div class="keybox" id="newKeyValue">' + esc(apiKey) + '</div>'
      + '<button class="ghost" id="copyKey">キーをコピー</button>'
      + '<div class="card" style="margin-top:10px"><strong>本人に伝えること</strong>'
      +   '<div style="font-size:13px;margin-top:6px">'
      +     '① このページを開いてもらう: <span class="hint">' + esc(location.origin) + '/admin</span><br>'
      +     '② 上のキーを口頭または社内の安全な方法で渡す（メール・チャットに貼らない）<br>'
      +     '③ 本人が「管理APIキー」欄に貼れば完了です'
      +   '</div>'
      + '</div>';
    var btn = $('copyKey');
    if(btn) btn.addEventListener('click', function(){
      var v = $('newKeyValue').textContent;
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(v).then(function(){ btn.textContent='コピーしました'; })
          .catch(function(){ btn.textContent='コピーできません（手動で選択してください）'; });
      } else { btn.textContent='コピーできません（手動で選択してください）'; }
    });
  }

  $('create').addEventListener('click', function(){
    var name = $('newName').value.trim();
    if(!name){ setStatus('名前を入力してください', false); return; }
    if(!key()){ setStatus('管理APIキーを入力してください', false); return; }
    var body = { name: name, email: $('newEmail').value.trim() || null, role: $('newRole').value };
    $('create').disabled = true;
    fetch('/api/staff',{ method:'POST', headers: headers(), body: JSON.stringify(body) })
      .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j; }); })
      .then(function(j){
        showNewKey(j.data.name, j.data.apiKey);
        $('newName').value=''; $('newEmail').value='';
        setStatus('✅ 発行しました', true);
        load();
      })
      .catch(function(e){ setStatus('発行できませんでした: '+e.message, false); })
      .finally(function(){ $('create').disabled = false; });
  });

  $('rows').addEventListener('click', function(ev){
    var btn = ev.target.closest('button');
    if(!btn) return;
    var act = btn.getAttribute('data-act');
    var id = btn.getAttribute('data-id');
    var name = btn.getAttribute('data-name') || '';
    if(act === 'regen'){
      if(!window.confirm(name + ' さんのキーを作り直します。今のキーはすぐ使えなくなります。よろしいですか？')) return;
      fetch('/api/staff/' + encodeURIComponent(id) + '/regenerate-key', { method:'POST', headers: headers() })
        .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j; }); })
        .then(function(j){
          showNewKey(name, j.data.apiKey);
          // 自分自身のキーを更新した場合、この端末のキーも差し替える
          // (差し替えないと直後の再読込が 401 になり「失敗した」ように見える)
          if(myId && id === myId){
            $('apikey').value = j.data.apiKey;
            // 3 ページ共有スキームなので全キーを同時に更新する
            ['lh_admin_apikey','faq_admin_apikey','fc_admin_apikey'].forEach(function(k){
              localStorage.setItem(k, j.data.apiKey);
            });
            setStatus('✅ あなた自身のキーを更新しました。この端末は新しいキーに切り替え済みです', true);
          } else {
            setStatus('✅ 再発行しました', true);
          }
          load();
        })
        .catch(function(e){ setStatus('再発行できませんでした: '+e.message, false); });
    } else if(act === 'toggle'){
      var makeActive = btn.getAttribute('data-active') !== '1';
      fetch('/api/staff/' + encodeURIComponent(id), { method:'PATCH', headers: headers(), body: JSON.stringify({ isActive: makeActive }) })
        .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j; }); })
        .then(function(){ setStatus(makeActive?'✅ 利用を再開しました':'✅ 利用を停止しました', true); load(); })
        .catch(function(e){ setStatus('変更できませんでした: '+e.message, false); });
    } else if(act === 'del'){
      if(!window.confirm(name + ' さんを削除します。取り消せません。よろしいですか？')) return;
      fetch('/api/staff/' + encodeURIComponent(id), { method:'DELETE', headers: headers() })
        .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j; }); })
        .then(function(){ setStatus('✅ 削除しました', true); load(); })
        .catch(function(e){ setStatus('削除できませんでした: '+e.message, false); });
    }
  });

  $('logout').addEventListener('click', function(){
    if(!window.confirm('この端末に保存されたキーを消します。次に使うときは再度貼り付けが必要です。よろしいですか？')) return;
    localStorage.removeItem(KEY);
    localStorage.removeItem('faq_admin_apikey');
    localStorage.removeItem('fc_admin_apikey');
    $('apikey').value = '';
    $('rows').innerHTML = '<tr><td colspan="5" class="hint">ログアウトしました</td></tr>';
    $('newKeyArea').innerHTML = '';
    $('whoami').textContent = '';
    setStatus('✅ この端末からキーを消しました', true);
  });

  $('load').addEventListener('click', load);
  $('apikey').addEventListener('change', load);
  // whoami は load の成否と独立に呼ぶ (403 でも「自分が誰か」は表示する)
  if(key()) { whoami(); load(); }
</script>
</body>
</html>`;

const LOGS_PAGE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#1d7d82">
  <meta name="robots" content="noindex,nofollow">
  <title>操作履歴 · naturism</title>
  <style>${SHARED_STYLE}</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="/admin">← ダッシュボードに戻る</a>
  <header>
    <h1>📜 操作履歴</h1>
    <p class="sub">システムで行われた変更が「いつ・誰が・何をしたか」の記録です。記録は後から書き換えできません。</p>
  </header>

  <div class="card">
    <label>管理APIキー</label>
    <input type="password" id="apikey" placeholder="管理者から受け取ったキーを貼り付け" autocomplete="off">
    <div style="margin-top:8px"><button id="load">履歴を読み込む</button></div>
    <div id="status"></div>
  </div>

  <div class="card tablewrap">
    <table>
      <thead><tr><th>日時</th><th>実行した人</th><th>操作</th><th>対象</th><th>結果</th></tr></thead>
      <tbody id="rows"><tr><td colspan="5" class="hint">APIキーを入れて「履歴を読み込む」を押してください</td></tr></tbody>
    </table>
    <p class="hint">直近 100 件を新しい順に表示しています。</p>
  </div>
</div>
<script>
  var $ = function(id){ return document.getElementById(id); };
  var KEY = 'lh_admin_apikey';
  $('apikey').value = localStorage.getItem(KEY) || '';
  function setStatus(msg, ok){ var s=$('status'); s.textContent=msg; s.className= ok?'ok':'err'; }
  function key(){ return $('apikey').value.trim(); }
  // textContent 経由は & < > しか実体参照化しないため、属性値には使えない (採点 HIGH:
  // data-name="…" から抜けて任意ハンドラを注入できた)。テキスト用と属性用を分ける。
  function esc(t){ var d=document.createElement('div'); d.textContent=(t==null?'':String(t)); return d.innerHTML; }
  function escAttr(t){ return esc(t).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

  var ACTION_LABELS = {
    'admin.staff.create': 'スタッフを追加',
    'admin.staff.update': 'スタッフ情報を変更',
    'admin.staff.delete': 'スタッフを削除',
    'admin.staff.regenerate_key': 'ログインキーを再発行',
    'admin.faq.create': 'FAQ を追加',
    'admin.faq.update': 'FAQ を編集',
    'admin.faq.delete': 'FAQ を削除',
    'admin.faq.seed': 'FAQ の初期データを投入',
    'admin.friend_coupon.update': '友だち限定クーポンの設定を変更',
    'admin.access.denied': '⛔ 権限がなく実行できなかった操作',
    'broadcast.send': '一斉配信を実行',
    'broadcast.send_segment': 'セグメント配信を実行',
    'friend.blacklist.set': '友だちを配信対象から除外',
    'friend.blacklist.unset': '友だちを配信対象に戻す'
  };
  function roleLabel(r){ return r==='owner'?'オーナー':(r==='admin'?'管理者':'スタッフ'); }

  function fmtTime(iso){
    if(!iso) return '';
    var s = String(iso).replace('T',' ');
    return s.slice(0, 16);
  }

  function load(){
    if(!key()){ setStatus('管理APIキーを入力してください', false); return; }
    setStatus('読み込み中…', true);
    fetch('/api/audit-logs?limit=100',{ headers: { 'Authorization':'Bearer '+key() } })
      .then(function(r){
        if(r.status===401) throw new Error('APIキーが違います');
        if(r.status===403) throw new Error('この画面を見る権限がありません');
        if(!r.ok) throw new Error('HTTP '+r.status);
        return r.json();
      })
      .then(function(j){
        localStorage.setItem(KEY, key());
        var items = (j.data && j.data.logs) || [];
        if(!Array.isArray(items)) items = [];
        var total = (j.data && typeof j.data.total === 'number') ? j.data.total : items.length;
        render(items);
        setStatus(total > items.length
          ? '✅ 全 ' + total + ' 件のうち、新しい ' + items.length + ' 件を表示しています'
          : '✅ 最新の履歴です（' + items.length + ' 件）', true);
      })
      .catch(function(e){ setStatus('読み込み失敗: '+e.message, false); });
  }

  function parseJson(s){ try { return s ? JSON.parse(s) : null; } catch(e){ return null; } }
  function clip(s, n){ s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

  /** 「何を」変更したのかを人が読める形にする (ID の羅列では運用に使えない) */
  function describeTarget(it){
    var before = parseJson(it.before_value), after = parseJson(it.after_value), meta = parseJson(it.metadata);
    if(it.target_type === 'staff_member'){
      var nm = (after && after.name) || (before && before.name) || (meta && meta.targetName);
      var roleChg = (before && after && before.role !== after.role) ? '（' + roleLabel(before.role) + '→' + roleLabel(after.role) + '）' : '';
      return nm ? (nm + ' さん' + roleChg) : 'スタッフ';
    }
    if(it.target_type === 'faq_item'){
      var q = (after && after.question) || (before && before.question);
      if(q) return '「' + clip(q, 28) + '」';
      if(meta && meta.seeded != null) return '初期データ ' + meta.seeded + ' 件';
      return 'FAQ';
    }
    if(it.target_type === 'friend_coupon_config'){
      if(before && after){
        var onOff = (before.enabled ? 'ON' : 'OFF') + '→' + (after.enabled ? 'ON' : 'OFF');
        var pct = (before.percent !== after.percent) ? ' / ' + before.percent + '%→' + after.percent + '%' : '';
        return onOff + pct;
      }
      return 'クーポン設定';
    }
    if(it.target_type === 'endpoint') return clip(it.target_id, 40);
    return it.target_type ? clip(it.target_type, 24) : '';
  }

  function render(items){
    if(!items.length){ $('rows').innerHTML='<tr><td colspan="5" class="hint">まだ記録がありません（この機能を入れた後の操作から記録されます）。</td></tr>'; return; }
    $('rows').innerHTML = items.map(function(it){
      var label = ACTION_LABELS[it.action] || it.action;
      // actor_name は共有キーでも 'Owner' が入るため、actor_id を先に見る
      var actor = it.actor_id === 'env-owner'
        ? '共有キー（個人キー未使用）'
        : (it.actor_name || it.actor_id || '不明');
      var actorCell = it.actor_id === 'env-owner'
        ? '<span class="pill off">' + esc(actor) + '</span>'
        : esc(actor);
      var resultPill = it.result === 'success'
        ? '<span class="pill on">成功</span>'
        : '<span class="pill off">失敗</span>';
      return '<tr>'
        + '<td class="hint">' + esc(fmtTime(it.created_at)) + '</td>'
        + '<td>' + actorCell + '</td>'
        + '<td>' + esc(label) + '</td>'
        + '<td>' + esc(describeTarget(it)) + '</td>'
        + '<td>' + resultPill + '</td>'
        + '</tr>';
    }).join('');
  }

  $('load').addEventListener('click', load);
  $('apikey').addEventListener('change', load);
  if(key()) load();
</script>
</body>
</html>`;
