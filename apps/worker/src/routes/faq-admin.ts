/**
 * FAQ (faq_items) の管理 — AI 応答 + LIFF portal の FAQ を deploy なしに編集する。
 *
 * - GET    /admin/faq           : 管理ページ (公開 HTML shell。操作は API_KEY 必須の API 経由)。
 *                                 apps/web は本番デプロイされないため worker 配信の自己完結ページ。
 * - GET    /api/admin/faq       : 全 FAQ 一覧 (authMiddleware = API_KEY 保護)。
 * - POST   /api/admin/faq       : 1 件追加 (API_KEY)。
 * - PUT    /api/admin/faq/:id   : 1 件更新 (API_KEY)。
 * - DELETE /api/admin/faq/:id   : 1 件削除 (API_KEY)。
 * - POST   /api/admin/faq/seed  : 空のとき DEFAULT_FAQ_ENTRIES を一括投入 (冪等、API_KEY)。
 *
 * faq_items は migration 029 で本番に既存 (= 新規 migration 不要)。 seed で初期 21 件を投入すると
 * AI prompt と LIFF portal の FAQ タブが同時に動的化される。
 */
import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  listAllFaqItems,
  countFaqItems,
  createFaqItem,
  updateFaqItem,
  deleteFaqItem,
  bulkInsertFaqItems,
  listUnansweredQuestions,
  jstIsoDaysAgo,
  type UpdateFaqItemInput,
} from '@line-crm/db';
import { DEFAULT_FAQ_ENTRIES } from '../services/faq-context.js';

export const faqAdmin = new Hono<Env>();

const QUESTION_MAX = 500;
const ANSWER_MAX = 2000;
const CATEGORY_MAX = 64;

interface ValidContent {
  question: string;
  answer: string;
}

/** question/answer の必須・長さチェック (trim 済の値 or エラー文字列)。 */
function validateContent(question: unknown, answer: unknown): ValidContent | { error: string } {
  const q = typeof question === 'string' ? question.trim() : '';
  const a = typeof answer === 'string' ? answer.trim() : '';
  if (!q) return { error: 'question は必須です' };
  if (!a) return { error: 'answer は必須です' };
  if (q.length > QUESTION_MAX) return { error: `question は${QUESTION_MAX}文字以内にしてください` };
  if (a.length > ANSWER_MAX) return { error: `answer は${ANSWER_MAX}文字以内にしてください` };
  return { question: q, answer: a };
}

// ─── 管理 API (API_KEY 保護) ───
faqAdmin.get('/api/admin/faq', async (c) => {
  const items = await listAllFaqItems(c.env.DB);
  return c.json({ success: true, data: { items, count: items.length } });
});

// PR2: AI が答えられなかった (fallback) 質問を頻度順に返す = FAQ化候補。
// /:id (PUT/DELETE) と method/segment が異なるため衝突しない。
faqAdmin.get('/api/admin/faq/unanswered', async (c) => {
  const days = Number(c.req.query('days')) || 90;
  const limit = Number(c.req.query('limit')) || 30;
  const minCount = Number(c.req.query('min')) || 1;
  const sinceIso = jstIsoDaysAgo(days, Date.now());
  const questions = await listUnansweredQuestions(c.env.DB, { sinceIso, limit, minCount });
  return c.json({ success: true, data: { questions, days, minCount } });
});

faqAdmin.post('/api/admin/faq', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const v = validateContent(body.question, body.answer);
  if ('error' in v) return c.json({ success: false, error: v.error }, 400);
  const item = await createFaqItem(c.env.DB, {
    question: v.question,
    answer: v.answer,
    category: typeof body.category === 'string' ? body.category.slice(0, CATEGORY_MAX) : undefined,
    sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : undefined,
    isActive: body.isActive !== false,
  });
  return c.json({ success: true, data: item });
});

// seed は :id より前に置く必要はない (method/segment が異なる) が、可読性のため CRUD の直前に置く。
faqAdmin.post('/api/admin/faq/seed', async (c) => {
  const existing = await countFaqItems(c.env.DB);
  if (existing > 0) {
    return c.json({ success: true, data: { seeded: 0, skipped: true, existing } });
  }
  const items = DEFAULT_FAQ_ENTRIES.map((e, i) => ({
    question: e.question,
    answer: e.answer,
    category: e.category,
    sortOrder: (i + 1) * 10,
    isActive: true,
  }));
  const seeded = await bulkInsertFaqItems(c.env.DB, items);
  return c.json({ success: true, data: { seeded, skipped: false } });
});

faqAdmin.put('/api/admin/faq/:id', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: UpdateFaqItemInput = {};
  if (body.question !== undefined) {
    const q = typeof body.question === 'string' ? body.question.trim() : '';
    if (!q) return c.json({ success: false, error: 'question は必須です' }, 400);
    if (q.length > QUESTION_MAX) return c.json({ success: false, error: `question は${QUESTION_MAX}文字以内` }, 400);
    patch.question = q;
  }
  if (body.answer !== undefined) {
    const a = typeof body.answer === 'string' ? body.answer.trim() : '';
    if (!a) return c.json({ success: false, error: 'answer は必須です' }, 400);
    if (a.length > ANSWER_MAX) return c.json({ success: false, error: `answer は${ANSWER_MAX}文字以内` }, 400);
    patch.answer = a;
  }
  if (body.category !== undefined && typeof body.category === 'string') patch.category = body.category.slice(0, CATEGORY_MAX);
  if (body.sortOrder !== undefined && typeof body.sortOrder === 'number') patch.sortOrder = body.sortOrder;
  if (body.isActive !== undefined) patch.isActive = body.isActive === true;

  const updated = await updateFaqItem(c.env.DB, id, patch);
  if (!updated) return c.json({ success: false, error: 'FAQ not found' }, 404);
  return c.json({ success: true, data: updated });
});

faqAdmin.delete('/api/admin/faq/:id', async (c) => {
  const ok = await deleteFaqItem(c.env.DB, c.req.param('id'));
  if (!ok) return c.json({ success: false, error: 'FAQ not found' }, 404);
  return c.json({ success: true, data: { deleted: true } });
});

// ─── 管理ページ (公開 HTML shell。実操作は上記 API_KEY 保護 API 経由) ───
faqAdmin.get('/admin/faq', (c) => c.html(ADMIN_PAGE_HTML));

const ADMIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#059669">
  <meta name="robots" content="noindex,nofollow">
  <title>FAQ 管理</title>
  <style>
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:system-ui,-apple-system,'Segoe UI','Noto Sans JP',sans-serif;background:#f6f8f7;margin:0;padding:20px;color:#1f2937}
    .wrap{max-width:640px;margin:0 auto}
    h1{font-size:18px;margin:0 0 4px}
    .sub{font-size:12px;color:#6b7280;margin:0 0 16px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin-bottom:14px}
    label{display:block;font-size:12px;font-weight:700;color:#374151;margin:12px 0 4px}
    input[type=text],input[type=number],input[type=password],textarea{width:100%;padding:10px 12px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;font-family:inherit}
    input:focus,textarea:focus{outline:none;border-color:#06C755;box-shadow:0 0 0 3px rgba(6,199,85,.12)}
    button{cursor:pointer;font-family:inherit}
    button.save{width:100%;padding:13px;background:linear-gradient(135deg,#059669,#06C755);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:800;margin-top:10px}
    button.save:active{transform:scale(.99)}
    button.ghost{padding:8px 12px;background:#fff;border:1.5px solid #e5e7eb;border-radius:10px;font-size:13px;font-weight:700;color:#374151}
    .hint{font-size:11px;color:#9ca3af;margin-top:4px}
    #status{font-size:13px;font-weight:700;text-align:center;min-height:20px;margin-top:10px}
    .ok{color:#059669}.err{color:#dc2626}
    .toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px}
    .item{border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin-bottom:10px}
    .item.off{opacity:.55}
    .item .q{font-weight:800;font-size:14px;word-break:break-word}
    .item .a{font-size:13px;color:#374151;margin-top:4px;white-space:pre-wrap;word-break:break-word}
    .item .meta{font-size:11px;color:#9ca3af;margin-top:6px}
    .badge{display:inline-block;background:#ecfdf5;color:#059669;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700}
    .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
    .row button{padding:6px 10px;border-radius:8px;border:1.5px solid #e5e7eb;background:#fff;font-size:12px;font-weight:700}
    .row .del{color:#dc2626;border-color:#fecaca}
    .count{font-size:12px;color:#6b7280;margin:0 0 8px}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>📚 FAQ 管理</h1>
    <p class="sub">AI 応答とトーク下メニュー「よくある質問」の元データです。ここで追加・編集すると deploy なしで反映されます。</p>

    <div class="card">
      <label>管理APIキー (Bearer)</label>
      <input type="password" id="apikey" placeholder="API_KEY を貼り付け" autocomplete="off">
      <p class="hint">この端末にのみ保存されます (localStorage)。読み込み/保存に使用。</p>
      <div class="toolbar" style="margin-top:10px">
        <button class="ghost" id="reload">再読込</button>
        <button class="ghost" id="seed">デフォルト21件を投入</button>
      </div>
      <p class="hint">「投入」はFAQが0件のときだけ効きます (既存があればスキップ=重複しません)。</p>
    </div>

    <div class="card">
      <div class="row">
        <span class="big" style="font-size:15px;font-weight:800">💬 未解決のよくある質問</span>
        <button class="ghost" id="reloadUnanswered">更新</button>
      </div>
      <p class="hint">AIが答えられなかった質問を回数順に表示します。「FAQ化」で下のフォームに質問を流し込み、回答を書いて保存できます。</p>
      <div id="unanswered"></div>
    </div>

    <div class="card">
      <div class="big" style="font-size:15px;font-weight:800" id="formTitle">新規追加</div>
      <input type="hidden" id="editId">
      <label>質問</label>
      <input type="text" id="question" placeholder="例: 飲み方は？" maxlength="500">
      <label>回答</label>
      <textarea id="answer" rows="3" placeholder="回答を入力" maxlength="2000"></textarea>
      <label>カテゴリ (任意)</label>
      <input type="text" id="category" placeholder="general" maxlength="64">
      <label>並び順 (小さいほど上、任意)</label>
      <input type="number" id="sortOrder" value="0">
      <button class="save" id="save">保存する</button>
      <button class="ghost" id="cancelEdit" style="width:100%;margin-top:8px;display:none">編集をやめる</button>
      <div id="status"></div>
    </div>

    <p class="count" id="count"></p>
    <div id="list"></div>
  </div>
  <script>
    var $ = function(id){ return document.getElementById(id); };
    var KEY = 'faq_admin_apikey';
    $('apikey').value = localStorage.getItem(KEY) || '';
    function esc(s){ var d=document.createElement('div'); d.textContent = s==null?'':String(s); return d.innerHTML; }
    function setStatus(msg, ok){ var s=$('status'); s.textContent=msg; s.className= ok?'ok':'err'; }
    function key(){ return $('apikey').value.trim(); }
    function headers(){ return { 'Content-Type':'application/json', 'Authorization':'Bearer '+key() }; }
    function resetForm(){ $('editId').value=''; $('question').value=''; $('answer').value=''; $('category').value=''; $('sortOrder').value='0'; $('formTitle').textContent='新規追加'; $('cancelEdit').style.display='none'; }
    function render(items){
      $('count').textContent = items.length + ' 件';
      var html = items.map(function(it){
        return '<div class="item '+(it.isActive?'':'off')+'">'
          + '<div class="q">'+esc(it.question)+'</div>'
          + '<div class="a">'+esc(it.answer)+'</div>'
          + '<div class="meta"><span class="badge">'+esc(it.category||'general')+'</span> 並び:'+esc(it.sortOrder)+(it.isActive?'':' ・非表示')+'</div>'
          + '<div class="row">'
          + '<button data-act="edit" data-id="'+esc(it.id)+'">編集</button>'
          + '<button data-act="toggle" data-id="'+esc(it.id)+'" data-active="'+(it.isActive?'1':'0')+'">'+(it.isActive?'非表示にする':'表示する')+'</button>'
          + '<button class="del" data-act="del" data-id="'+esc(it.id)+'">削除</button>'
          + '</div></div>';
      }).join('');
      $('list').innerHTML = html;
      window.__faq = items;
    }
    function load(){
      if(!key()) { setStatus('APIキーを入力してください', false); return; }
      localStorage.setItem(KEY,key());
      fetch('/api/admin/faq',{ headers: headers() })
        .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(function(j){ render((j.data&&j.data.items)||[]); setStatus('読み込みました', true); loadUnanswered(); })
        .catch(function(e){ setStatus('読み込み失敗: '+e.message+' (APIキーをご確認ください)', false); });
    }
    function renderUnanswered(qs){
      window.__unanswered = qs;
      if(!qs.length){ $('unanswered').innerHTML = '<p class="hint">未解決の質問はまだありません。</p>'; return; }
      $('unanswered').innerHTML = qs.map(function(q,i){
        return '<div class="item"><div class="q">'+esc(q.question)+'</div>'
          + '<div class="row"><span class="badge">'+esc(q.count)+'回</span>'
          + '<button data-act="faqify" data-idx="'+i+'">これをFAQ化 ▶</button></div></div>';
      }).join('');
    }
    function loadUnanswered(){
      if(!key()) return;
      fetch('/api/admin/faq/unanswered',{ headers: headers() })
        .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(function(j){ renderUnanswered((j.data&&j.data.questions)||[]); })
        .catch(function(){ $('unanswered').innerHTML = '<p class="hint">未解決質問の読み込みに失敗しました。</p>'; });
    }
    $('reload').addEventListener('click', load);
    $('reloadUnanswered').addEventListener('click', loadUnanswered);
    $('unanswered').addEventListener('click', function(ev){
      var btn = ev.target.closest('button'); if(!btn || btn.getAttribute('data-act')!=='faqify') return;
      var q = (window.__unanswered||[])[Number(btn.getAttribute('data-idx'))];
      if(!q) return;
      resetForm(); $('question').value=q.question; $('formTitle').textContent='新規追加 (未解決質問から)';
      $('answer').focus(); window.scrollTo(0,0);
      setStatus('質問を読み込みました。回答を入力して保存してください。', true);
    });
    $('apikey').addEventListener('change', load);
    if($('apikey').value) load();

    $('seed').addEventListener('click', function(){
      if(!key()){ setStatus('APIキーを入力してください', false); return; }
      setStatus('投入中…', true);
      fetch('/api/admin/faq/seed',{ method:'POST', headers: headers() })
        .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(function(j){ var d=j.data||{}; setStatus(d.skipped?('既に'+d.existing+'件あるためスキップしました'):('✅ '+d.seeded+'件を投入しました'), true); load(); })
        .catch(function(e){ setStatus('投入失敗: '+e.message, false); });
    });

    $('save').addEventListener('click', function(){
      if(!key()){ setStatus('APIキーを入力してください', false); return; }
      var q=$('question').value.trim(), a=$('answer').value.trim();
      if(!q||!a){ setStatus('質問と回答は必須です', false); return; }
      var body = { question:q, answer:a, category:$('category').value.trim()||undefined, sortOrder:Number($('sortOrder').value)||0, isActive:true };
      var id=$('editId').value;
      var url = id ? '/api/admin/faq/'+encodeURIComponent(id) : '/api/admin/faq';
      var method = id ? 'PUT' : 'POST';
      if(id) delete body.isActive; // 編集では表示状態を変えない
      $('save').disabled=true; setStatus('保存中…', true);
      fetch(url,{ method:method, headers: headers(), body: JSON.stringify(body) })
        .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(function(){ setStatus(id?'✅ 更新しました':'✅ 追加しました', true); resetForm(); load(); })
        .catch(function(e){ setStatus('保存失敗: '+e.message, false); })
        .finally(function(){ $('save').disabled=false; });
    });
    $('cancelEdit').addEventListener('click', resetForm);

    $('list').addEventListener('click', function(ev){
      var btn = ev.target.closest('button'); if(!btn) return;
      var act = btn.getAttribute('data-act'), id = btn.getAttribute('data-id');
      var item = (window.__faq||[]).filter(function(x){ return x.id===id; })[0];
      if(act==='edit' && item){
        $('editId').value=item.id; $('question').value=item.question; $('answer').value=item.answer;
        $('category').value=item.category||''; $('sortOrder').value=item.sortOrder; $('formTitle').textContent='編集中';
        $('cancelEdit').style.display='block'; window.scrollTo(0,0);
      } else if(act==='toggle'){
        var next = btn.getAttribute('data-active')!=='1';
        fetch('/api/admin/faq/'+encodeURIComponent(id),{ method:'PUT', headers: headers(), body: JSON.stringify({ isActive: next }) })
          .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
          .then(function(){ setStatus(next?'表示にしました':'非表示にしました', true); load(); })
          .catch(function(e){ setStatus('変更失敗: '+e.message, false); });
      } else if(act==='del'){
        if(!confirm('このFAQを削除しますか？')) return;
        fetch('/api/admin/faq/'+encodeURIComponent(id),{ method:'DELETE', headers: headers() })
          .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
          .then(function(){ setStatus('🗑 削除しました', true); load(); })
          .catch(function(e){ setStatus('削除失敗: '+e.message, false); });
      }
    });
  </script>
</body>
</html>`;
