/**
 * スタッフ向け 管理ダッシュボード (2026-07-23 Katsu 指示「この画面だけ見ておけば OK」)。
 *
 * - GET /admin                : ダッシュボード HTML (公開 shell。データ取得は API_KEY 必須の API 経由)
 * - GET /api/admin/dashboard  : 集約サマリ API (authMiddleware = API_KEY 保護)
 *
 * 設計方針:
 *   - 既存の単機能ページ (/admin/faq, /admin/friend-coupon) の「入口」になるハブ。
 *   - 集約 API は section ごとに独立 try/catch — 一部テーブル欠損や将来の schema 変化でも
 *     500 にせず null section で返す (スタッフ画面は部分表示 > 全損)。
 *   - 出すのは件数・状態のみ (PII なし)。API キーは既存ページと共通の localStorage
 *     'lh_admin_apikey' に保存し、旧キー (faq_admin_apikey / fc_admin_apikey) にも書いて
 *     既存 2 ページがそのまま動くようにする。
 */
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { getFriendCouponConfig } from '../services/friend-coupon-config.js';
import { auditAdminAction } from '../services/admin-audit.js';
import { listUnansweredQuestions, jstIsoDaysAgo, jstNow } from '@line-crm/db';

export const adminDashboard = new Hono<Env>();

interface SectionErrors { [section: string]: string }

// ─── 集約 API (API_KEY 保護。/api/* は authMiddleware 管轄) ───
adminDashboard.get('/api/admin/dashboard', async (c) => {
  const db = c.env.DB;
  const errors: SectionErrors = {};
  const since7d = jstIsoDaysAgo(7, Date.now());

  const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e: unknown) {
      errors[name] = e instanceof Error ? e.message : String(e);
      return null;
    }
  };

  const friends = await section('friends', async () => {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN is_following = 1 THEN 1 ELSE 0 END) AS following,
                SUM(CASE WHEN is_following = 0 THEN 1 ELSE 0 END) AS blocked,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new7d,
                SUM(CASE WHEN shopify_customer_id IS NOT NULL AND shopify_customer_id != '' THEN 1 ELSE 0 END) AS linked
           FROM friends`,
      )
      .bind(since7d)
      .first<{ total: number; following: number; blocked: number; new7d: number; linked: number }>();
    return row;
  });

  const welcomeCoupons = await section('welcomeCoupons', async () => {
    // line_friend_coupons.issued_at は UTC 'Z' 保存 (shopify-coupon-issuer) のため、
    // JST 保存の friends/conversation_logs と違い比較値も UTC で揃える (9h ズレ防止)
    const since7dUtc = new Date(Date.now() - 7 * 86400_000).toISOString();
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS issued,
                SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed,
                SUM(CASE WHEN issued_at >= ? THEN 1 ELSE 0 END) AS issued7d
           FROM line_friend_coupons`,
      )
      .bind(since7dUtc)
      .first<{ issued: number; redeemed: number; issued7d: number }>();
    return row;
  });

  const faq = await section('faq', async () => {
    const count = await db
      .prepare(`SELECT COUNT(*) AS n FROM faq_items WHERE is_active = 1`)
      .first<{ n: number }>();
    const unanswered = await listUnansweredQuestions(db, {
      sinceIso: jstIsoDaysAgo(90, Date.now()),
      limit: 3,
      minCount: 1,
    });
    return {
      activeCount: count?.n ?? 0,
      unansweredTop: unanswered.map((q) => ({ question: q.question, count: q.count })),
    };
  });

  const ai7d = await section('ai7d', async () => {
    // ngWords = 薬機法 NG 語で表現がブロックされた件数。NG ブロック行は ai_layer='ai' の
    // まま記録されるため、fallback だけを「要改善」と数えると実態より良く見える
    // (機能性表示食品ブランドで唯一の法務指標がどこにも表示されていなかった)
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN ai_layer = 'fallback' THEN 1 ELSE 0 END) AS fallback,
                SUM(CASE WHEN ng_words_detected IS NOT NULL THEN 1 ELSE 0 END) AS ngWords
           FROM conversation_logs WHERE created_at >= ?`,
      )
      .bind(since7d)
      .first<{ total: number; fallback: number; ngWords: number }>();
    return row;
  });

  const friendCoupon = await section('friendCoupon', async () => {
    const cfg = await getFriendCouponConfig(db);
    // codeSet: 顧客側 (liff-portal) は enabled でも code が空なら非表示にする。
    // /admin が enabled だけ見て「表示中」と言うと、コード未設定のとき嘘になる
    return {
      enabled: !!cfg.enabled,
      percent: cfg.percent ?? null,
      label: cfg.label ?? null,
      codeSet: !!cfg.code,
    };
  });

  // 人間の確認が必要なキュー。返信そのものは LINE公式アカウントマネージャーが
  // 本来の面 (apps/web にも /chats がある) なので、ここは件数と導線だけを出す。
  //
  // ⚠️ 計数の実体に注意 (採点で確定した2つの嘘を塞いだ):
  //   - 'unread' は webhook が **AI 応答より前に** 全ての自発メッセージへ立てる
  //     (AI が完答した分も含む) = 「AI が答えられなかった件数」ではなく
  //     「スタッフがまだ確認していないメッセージ」。ラベルはこの実体に合わせること
  //   - LINE公式マネージャーで返信しても D1 の status は変わらない (Manager は D1 を知らない)。
  //     解除経路が無いと警告が永久残留して狼少年化するため、下の mark-resolved を対で設ける
  const chats = await section('chats', async () => {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS unread, MIN(last_message_at) AS oldestAt
           FROM chats WHERE status = 'unread'`,
      )
      .first<{ unread: number; oldestAt: string | null }>();
    return row;
  });

  const system = await section('system', async () => {
    const row = await db
      .prepare(`SELECT MAX(ran_at) AS lastCronAt FROM cron_run_logs`)
      .first<{ lastCronAt: string | null }>();
    // MAX(ran_at) だけだと per-tick job が 1 本でも生きていれば全体が緑に見える
    // (27 本中 26 本死んでいても「たった今 ✅」)。job 別の失敗を直近24hで拾う
    const failing = await db
      .prepare(
        `SELECT job_name AS jobName, COUNT(*) AS n, MAX(ran_at) AS lastAt
           FROM cron_run_logs
          WHERE ran_at >= ? AND status IN ('error', 'partial')
          GROUP BY job_name ORDER BY n DESC LIMIT 10`,
      )
      .bind(jstIsoDaysAgo(1, Date.now()))
      .all<{ jobName: string; n: number; lastAt: string }>();
    return { lastCronAt: row?.lastCronAt ?? null, failingJobs: failing.results };
  });

  // サブスク収集の実測。secret (gate) の値だけを見た表示だと、TEIKI_FLOW_SECRET 不一致で
  // 全受信が 401 でも「稼働中」と出続ける。実測値 (契約行数 / Flow 実測件数 / 最終受信) を
  // 併記して「収集が本当に動いているか」を見えるようにする。
  // subscription_contracts が未作成の環境では section try/catch が null に落とす (部分表示 > 全損)
  const subscriptionIngest = await section('subscriptionIngest', async () => {
    const contracts = await db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN cancelled_at IS NULL AND paused_at IS NULL THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN cancelled_at IS NULL AND paused_at IS NULL
                          AND estimate_source = 'flow' AND next_billing_estimate IS NOT NULL
                     THEN 1 ELSE 0 END) AS flowMeasured
           FROM subscription_contracts`,
      )
      .first<{ total: number; active: number; flowMeasured: number }>();
    // 実測の最終受信 (teiki-flow-ingest の success = 実測を1件取り込んだ記録)
    const lastIngest = await db
      .prepare(
        `SELECT MAX(ran_at) AS lastAt FROM cron_run_logs
          WHERE job_name = 'teiki-flow-ingest' AND status = 'success'`,
      )
      .first<{ lastAt: string | null }>();
    return {
      total: contracts?.total ?? 0,
      active: contracts?.active ?? 0,
      flowMeasured: contracts?.flowMeasured ?? 0,
      lastMeasuredAt: lastIngest?.lastAt ?? null,
    };
  });

  // 機能ステータス行 (ラベル込みでサーバ側から返す — 未公開機能のロードマップを
  // 公開 shell の静的 HTML に埋め込まない。API_KEY 保護下でのみ閲覧可)
  const on = (v: string | undefined) => v === 'true';
  const features = [
    { label: '友だち追加 500円クーポン (7日有効)', on: true, offText: '' },
    { label: '会員ランク & ランク別割引', on: on(c.env.RANK_DISCOUNT_ENABLED), offText: '未公開' },
    { label: '友だち限定クーポン', on: false, offText: '', dynamic: 'friendCoupon' },
    { label: '友達紹介の「紹介した人に500円」特典', on: on(c.env.REFERRAL_REWARD_ENABLED), offText: '未公開 — 案内NG' },
    { label: 'LINE 一斉配信 (ブロードキャスト)', on: on(c.env.BROADCAST_ALL_ENABLED), offText: '未公開 (開発者に依頼)' },
    { label: 'トーク内サブスク管理カード', on: on(c.env.SUBSCRIPTION_MENU_ENABLED), offText: '近日公開 — 案内NG' },
    // 収集は顧客から見えない準備工程 (定期便の契約データを裏で貯めている状態)。
    // 「公開されたのか」と誤読されないよう、ラベルと offText の両方で内部工程と分かるようにする。
    // dynamic: 実測値 (subscriptionIngest section) を client 側で併記する
    {
      label: '(準備) 定期便データの収集',
      on: on(c.env.SUBSCRIPTION_INGEST_ENABLED) || on(c.env.SUBSCRIPTION_MENU_ENABLED),
      offText: '停止中 — 顧客影響なし',
      dynamic: 'subscriptionIngest',
    },
    { label: 'サブスク決済 7日前リマインド', on: on(c.env.SUBSCRIPTION_REMINDER_ENABLED), offText: '近日公開 — 案内NG' },
  ];

  return c.json({
    success: true,
    data: { friends, welcomeCoupons, faq, ai7d, friendCoupon, chats, subscriptionIngest, system, features,
      generatedAt: new Date(Date.now() + 9 * 3600_000).toISOString().replace('Z', '+09:00'),
      ...(Object.keys(errors).length > 0 ? { sectionErrors: errors } : {}) },
  });
});

// ─── 未確認メッセージの一括「確認済み」化 (API_KEY 保護) ───
// LINE公式マネージャーでの返信は D1 に反映されないため、確認フローの終点として
// スタッフ自身が押す。対象は 'unread' のみ ('in_progress' = apps/web で対応中の行は触らない)。
// 新しいメッセージが届けば upsertChatOnMessage が 'resolved' → 'unread' に戻す = 再表示される。
adminDashboard.post('/api/admin/chats/mark-resolved', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      `UPDATE chats SET status = 'resolved', updated_at = ? WHERE status = 'unread'`,
    )
      .bind(jstNow())
      .run();
    const resolved = result.meta?.changes ?? 0;
    // 「誰がいつ確認済みにしたか」を残す (問い合わせの取りこぼし調査で使う)
    await auditAdminAction(c, {
      action: 'admin.chats.mark_all_resolved',
      targetType: 'chats',
      after: { resolved },
    });
    return c.json({ success: true, data: { resolved } });
  } catch (err) {
    console.error('POST /api/admin/chats/mark-resolved error:', err);
    return c.json({ success: false, error: 'internal error' }, 500);
  }
});

// ─── ダッシュボード ページ (公開 shell。実データは上記 API_KEY 保護 API 経由) ───
adminDashboard.get('/admin', (c) => c.html(DASHBOARD_HTML));
// 末尾スラッシュの手打ちを 401 JSON にしない (auth skip-list は exact-match)
adminDashboard.get('/admin/', (c) => c.redirect('/admin', 301));

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#1d7d82">
  <meta name="robots" content="noindex,nofollow">
  <title>naturism 管理ダッシュボード</title>
  <style>
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:system-ui,-apple-system,'Hiragino Kaku Gothic ProN','Segoe UI','Noto Sans JP',sans-serif;background:#f4f8f8;margin:0;padding:20px;color:#052422;line-height:1.6}
    .wrap{max-width:880px;margin:0 auto}
    header{border-bottom:3px solid #2fa8ad;padding-bottom:12px;margin-bottom:18px}
    h1{font-size:20px;margin:0}
    .sub{font-size:13px;color:#4a6664;margin:4px 0 0}
    h2{font-size:15px;color:#1d7d82;margin:26px 0 10px}
    .card{background:#fff;border:1px solid #e3ecec;border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(5,36,34,.05)}
    label{display:block;font-size:12px;font-weight:700;color:#374151;margin:0 0 4px}
    input[type=password]{width:100%;padding:10px 12px;border:1.5px solid #e3ecec;border-radius:10px;font-size:14px}
    input:focus{outline:none;border-color:#2fa8ad;box-shadow:0 0 0 3px rgba(47,168,173,.15)}
    .hint{font-size:11px;color:#8aa3a1;margin-top:4px}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
    .stat{background:#fff;border:1px solid #e3ecec;border-radius:14px;padding:14px 16px}
    .stat .k{font-size:12px;color:#4a6664;font-weight:700}
    .stat .v{font-size:26px;font-weight:800;color:#1d7d82;font-variant-numeric:tabular-nums;line-height:1.3}
    .stat .s{font-size:11px;color:#8aa3a1}
    .links{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
    a.link{display:block;background:#fff;border:1px solid #e3ecec;border-radius:14px;padding:14px 16px;text-decoration:none;color:#052422;transition:transform .08s ease-out}
    a.link:active{transform:translateY(1.5px) scale(.99)}
    a.link .t{font-weight:800;color:#1d7d82;font-size:14px}
    a.link .d{font-size:12px;color:#4a6664;margin-top:2px}
    .todo{border-left:4px solid #2fa8ad;background:#fff;border-radius:0 12px 12px 0;padding:12px 16px;margin:8px 0;font-size:14px}
    .todo.warn{border-left-color:#d9573d}
    .todo a{color:#1d7d82;font-weight:700}
    .pill{display:inline-block;border-radius:999px;font-size:11px;font-weight:800;padding:2px 10px;vertical-align:middle}
    .pill.on{background:#e8f6f6;color:#1d7d82}
    .pill.off{background:#fff3ec;color:#b84a2e;border:1px solid #eaa588}
    table{border-collapse:collapse;width:100%;font-size:13px}
    td,th{border-bottom:1px solid #e3ecec;padding:8px 10px;text-align:left}
    #status{font-size:13px;font-weight:700;min-height:20px;margin-top:8px}
    .ok{color:#1d7d82}.err{color:#b84a2e}
    button{padding:10px 18px;background:#2fa8ad;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer}
    button:active{transform:translateY(1.5px)}
    footer{font-size:11px;color:#8aa3a1;margin-top:28px;border-top:1px solid #e3ecec;padding-top:12px}
    .skeleton{color:#8aa3a1}
  </style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🌿 naturism 管理ダッシュボード</h1>
    <p class="sub">この画面だけ見ておけば OK。今日の数字の確認と、よく使う操作への入り口です。</p>
    <p class="sub" id="whoami"></p>
  </header>

  <div class="card" id="keycard">
    <label>管理APIキー</label>
    <input type="password" id="apikey" placeholder="管理者から受け取ったキーを貼り付け" autocomplete="off">
    <p class="hint">初回に 1 回貼り付ければ、この端末に保存されます (他のページでも共通で使えます)。キーは社外秘 — チャットやメールに貼らないでください。</p>
    <div style="margin-top:8px"><button id="reload">数字を読み込む</button></div>
    <div id="status"></div>
  </div>

  <h2>📊 今日の概況</h2>
  <div class="grid" id="stats">
    <div class="stat"><div class="k">友だち (フォロー中)</div><div class="v skeleton" id="v-following">—</div><div class="s" id="s-friends">読み込み前</div></div>
    <div class="stat"><div class="k">今週の新しい友だち</div><div class="v skeleton" id="v-new7d">—</div><div class="s">過去7日</div></div>
    <div class="stat"><div class="k">500円クーポン</div><div class="v skeleton" id="v-coupon">—</div><div class="s" id="s-coupon">発行 / 利用</div></div>
    <div class="stat"><div class="k">アカウント連携済み</div><div class="v skeleton" id="v-linked">—</div><div class="s">ランク判定の対象</div></div>
    <div class="stat"><div class="k">AI対応 (7日)</div><div class="v skeleton" id="v-ai">—</div><div class="s" id="s-ai">自動応答の件数</div></div>
    <div class="stat"><div class="k">FAQ</div><div class="v skeleton" id="v-faq">—</div><div class="s" id="s-faq">有効な質問数</div></div>
    <div class="stat"><div class="k">スタッフ未確認のメッセージ</div><div class="v skeleton" id="v-chats">—</div><div class="s" id="s-chats">AI の自動応答分も含みます</div></div>
  </div>

  <h2>✅ やること</h2>
  <div id="todos"><div class="todo skeleton">APIキーを入れて「数字を読み込む」を押すと、今やるべきことが表示されます。</div></div>

  <h2>🔗 よく使う画面</h2>
  <div class="links">
    <a class="link" href="/admin/faq"><div class="t">FAQ 管理</div><div class="d">AI の回答を追加・修正する (お客様への自動返信が変わります)</div></a>
    <a class="link" href="/admin/friend-coupon"><div class="t">友だち限定クーポン</div><div class="d">キャンペーンクーポンの ON/OFF・割引率の設定</div></a>
    <a class="link" href="/admin/staff"><div class="t">スタッフ管理</div><div class="d">個人ごとのログインキーを発行・停止する (オーナーのみ)</div></a>
    <a class="link" href="/admin/logs"><div class="t">操作履歴</div><div class="d">いつ・誰が・何を変更したかの記録</div></a>
    <a class="link" href="https://manager.line.biz/" target="_blank" rel="noopener"><div class="t">LINE公式アカウントマネージャー ↗</div><div class="d">1:1 チャットの手動返信・友だち数の公式統計</div></a>
    <a class="link" href="https://admin.shopify.com/store/xn-0ckn0a9fxa4a" target="_blank" rel="noopener"><div class="t">Shopify 管理画面 ↗</div><div class="d">注文・顧客・在庫・割引コードの作成</div></a>
    <a class="link" href="https://liff.line.me/2009713578-NbdHyFZf" target="_blank" rel="noopener"><div class="t">お客様ポータル (LIFF) ↗</div><div class="d">お客様が見ているマイページを確認する</div></a>
    <a class="link" href="https://naturism-diet.com/account" target="_blank" rel="noopener"><div class="t">定期便マイページ ↗</div><div class="d">サブスクのお客様を案内する先 (メール+6桁コードでログイン)。/apps/subscription は 400 になるので案内しない</div></a>
  </div>

  <h2>🚦 機能の公開状態</h2>
  <div class="card">
    <table id="features"><tr><td class="skeleton">数字を読み込むと表示されます</td></tr></table>
    <p class="hint">「未公開」の機能はお客様に案内しないでください (公開時に別途周知します)。切替は開発者が行います。</p>
  </div>

  <h2>🛠 システム</h2>
  <div class="card" style="font-size:13px">
    自動処理 (5分ごと) の最終稼働: <strong id="v-cron" class="skeleton">—</strong>
    <div id="cron-fail"></div>
    <span class="hint">1時間以上前の場合はシステム異常の可能性 — 開発者に連絡してください。ポータル障害時の一次確認: <a href="/" target="_blank">トップページ</a> が表示されるか。</span>
  </div>

  <div class="card" style="margin-top:18px">
    <strong>この端末からログアウト</strong>
    <p class="hint" style="margin-top:4px">共有パソコンを使ったあとや席を離れるときに押してください。保存されたキーをこの端末から消します。</p>
    <div style="margin-top:8px"><button id="logout" style="background:#fff;color:#b84a2e;border:1.5px solid #eaa588">キーを消して終了する</button></div>
  </div>

  <footer>社内限り ・ 運営: 株式会社ケンコーエクスプレス ・ お客様向け窓口: info@naturism-diet.com ・ 使い方の詳細は運用ガイド (スタッフ共有) を参照</footer>
</div>
<script>
  var $ = function(id){ return document.getElementById(id); };
  var KEY = 'lh_admin_apikey';
  var lastUnread = 0;
  // onclick 属性から呼ぶため名前付き関数 (引用符ネスト禁止ルール)。
  // 対象は unread のみ・新着が来れば自動で未確認へ戻るため、押しても情報は失われない
  function resolveChats(){
    var k = $('apikey').value.trim();
    if(!k){ setStatus('管理APIキーを入力してください', false); return; }
    if(!window.confirm('LINE公式アカウントマネージャーでの内容確認 (必要な返信) は済みましたか？\\n\\n未確認 ' + lastUnread + ' 件を「確認済み」にします。新しいメッセージが届けば、また未確認として表示されます。')) return;
    setStatus('確認済みに更新中…', true);
    fetch('/api/admin/chats/mark-resolved', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k } })
      .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(j){
        var n = (j.data && j.data.resolved) || 0;
        setStatus('✅ ' + n + ' 件を確認済みにしました', true);
        load();
      })
      .catch(function(e){ setStatus('更新失敗: ' + e.message, false); });
  }
  // 旧ページで保存済みのキーがあれば引き継ぐ
  $('apikey').value = localStorage.getItem(KEY) || localStorage.getItem('faq_admin_apikey') || localStorage.getItem('fc_admin_apikey') || '';
  function setStatus(msg, ok){ var s=$('status'); s.textContent=msg; s.className= ok?'ok':'err'; }
  function esc(t){ var d=document.createElement('div'); d.textContent=t==null?'':String(t); return d.innerHTML; }
  function load(){
    var k = $('apikey').value.trim();
    if(!k){ setStatus('管理APIキーを入力してください', false); return; }
    setStatus('読み込み中…', true);
    fetch('/api/admin/dashboard', { headers: { 'Authorization': 'Bearer ' + k } })
      .then(function(r){ if(r.status===401) throw new Error('APIキーが違います (保存しませんでした)'); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(j){
        // 正しいキーと確認できてから保存する (誤キーで既存ページの正キーを潰さない)。
        // FAQ / クーポンページとも共有。
        localStorage.setItem(KEY, k);
        localStorage.setItem('faq_admin_apikey', k);
        localStorage.setItem('fc_admin_apikey', k);
        var d = j.data || {};
        render(d);
        loadWhoami(k);
        if(d.sectionErrors && Object.keys(d.sectionErrors).length){
          setStatus('⚠️ 一部の数字が取得できませんでした — 時間をおいて再読み込みしてください', false);
        } else {
          setStatus('✅ 最新の数字です (' + new Date().toLocaleTimeString('ja-JP') + ' 時点)', true);
        }
      })
      .catch(function(e){ setStatus('読み込み失敗: ' + e.message, false); });
  }
  function loadWhoami(k){
    fetch('/api/staff/me', { headers: { 'Authorization': 'Bearer ' + k } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){
        if(!j || !j.data) return;
        var d = j.data;
        var role = d.role === 'owner' ? 'オーナー' : (d.role === 'admin' ? '管理者' : 'スタッフ');
        var shared = d.id === 'env-owner'
          ? ' — 共有キーでログイン中です。<a href="/admin/staff">スタッフ管理</a>で個人キーを発行すると、誰の操作か記録に残ります'
          : '';
        $('whoami').innerHTML = 'ログイン中: ' + esc(d.name) + '（' + esc(role) + '）' + shared;
      })
      .catch(function(){});
  }
  function markFailed(valueId, subId){
    $(valueId).textContent = '—';
    if(subId) $(subId).textContent = '取得できませんでした';
  }
  // JST 保存の日時文字列 (タイムゾーン表記なし) を相対表記に。解釈不能なら null
  function fmtAgo(s){
    if(!s) return null;
    var t = new Date(String(s) + (String(s).indexOf('+') < 0 ? '+09:00' : ''));
    if(isNaN(t.getTime())) return null;
    var mins = Math.round((Date.now() - t.getTime()) / 60000);
    if(mins < 60) return (mins <= 1 ? 'たった今' : mins + ' 分前');
    var hours = Math.floor(mins / 60);
    if(hours < 24) return hours + ' 時間前';
    return Math.floor(hours / 24) + ' 日前';
  }
  function render(d){
    var f = d.friends, w = d.welcomeCoupons, faq = d.faq, ai = d.ai7d, fc = d.friendCoupon, sys = d.system;
    var ch = d.chats, sub = d.subscriptionIngest;
    if(f){ $('v-following').textContent = Number(f.following||0).toLocaleString(); $('v-following').classList.remove('skeleton');
      $('s-friends').textContent = '累計 ' + Number(f.total||0).toLocaleString() + ' ・ ブロック ' + Number(f.blocked||0).toLocaleString();
      $('v-new7d').textContent = '+' + Number(f.new7d||0).toLocaleString(); $('v-new7d').classList.remove('skeleton');
      $('v-linked').textContent = Number(f.linked||0).toLocaleString(); $('v-linked').classList.remove('skeleton');
    } else { markFailed('v-following','s-friends'); markFailed('v-new7d'); markFailed('v-linked'); }
    if(w){ $('v-coupon').textContent = Number(w.issued||0).toLocaleString(); $('v-coupon').classList.remove('skeleton');
      $('s-coupon').textContent = '発行数 (利用 ' + Number(w.redeemed||0).toLocaleString() + ' ・ 今週 +' + Number(w.issued7d||0) + ')';
    } else { markFailed('v-coupon','s-coupon'); }
    if(ai){ $('v-ai').textContent = Number(ai.total||0).toLocaleString(); $('v-ai').classList.remove('skeleton');
      $('s-ai').textContent = '要改善: 答えられず ' + Number(ai.fallback||0) + ' ・ 表現ブロック ' + Number(ai.ngWords||0) + ' 件';
    } else { markFailed('v-ai','s-ai'); }
    if(faq){ $('v-faq').textContent = Number(faq.activeCount||0).toLocaleString(); $('v-faq').classList.remove('skeleton');
      $('s-faq').textContent = '有効な質問数';
    } else { markFailed('v-faq','s-faq'); }
    if(ch){
      var unread = Number(ch.unread||0);
      lastUnread = unread;
      $('v-chats').textContent = unread.toLocaleString(); $('v-chats').classList.remove('skeleton');
      var oldest = fmtAgo(ch.oldestAt);
      $('s-chats').textContent = unread > 0
        ? ('最も古いもので ' + (oldest || '不明') + ' — 内容は LINE公式マネージャーで確認')
        : 'すべて確認済みです 🎉';
    } else { markFailed('v-chats','s-chats'); }
    // やること (chats / faq / friendCoupon が全て取得できたときだけ「なし🎉」を出す)
    var todos = [];
    if(ch && Number(ch.unread) > 0){
      var chAge = fmtAgo(ch.oldestAt);
      // AI が完答した分も含む (unread は AI 応答より前に立つ)。「未対応」と書くと
      // 実体 (スタッフ未確認) より悪く見えるので、文言は実体に合わせる。
      // 確認フローの終点として「確認済みにする」ボタンを必ず対で置く — これが無いと
      // LINE公式マネージャーで返信しても数字が永久に減らず、警告が狼少年化する
      todos.push('<div class="todo warn">スタッフ未確認のお客様メッセージが <strong>' + Number(ch.unread) + ' 件</strong>'
        + (chAge ? '（最も古いもので ' + esc(chAge) + '）' : '') + 'あります。AI が自動応答した分も含みます。<br>'
        + '① <a href="https://manager.line.biz/" target="_blank" rel="noopener">LINE公式アカウントマネージャーで内容を確認・必要なら返信 ↗</a><br>'
        + '② 確認が済んだら → <button onclick="resolveChats()" style="padding:6px 14px;font-size:13px">全件を確認済みにする</button></div>');
    }
    if(faq && faq.unansweredTop && faq.unansweredTop.length){
      var top = faq.unansweredTop.map(function(q){ return '「' + esc(String(q.question).slice(0,30)) + '」(' + Number(q.count) + '回)'; }).join(' ');
      todos.push('<div class="todo warn">AI が答えられなかった質問があります: ' + top + ' → <a href="/admin/faq">FAQ 管理で回答を作る</a></div>');
    }
    if(fc){
      if(fc.enabled && !fc.codeSet){
        // 顧客側は code 未設定なら非表示にする — ON なのに出ていない状態を放置させない
        todos.push('<div class="todo warn">友だち限定クーポンは ON ですが、Shopify 割引コードが未設定のため<strong>お客様には表示されていません</strong> → <a href="/admin/friend-coupon">設定画面でコードを入力</a></div>');
      } else if(fc.enabled){
        todos.push('<div class="todo">友だち限定クーポンは <strong>表示中 (' + esc(fc.percent) + '%OFF)</strong> です。キャンペーン終了時は <a href="/admin/friend-coupon">設定画面</a> で OFF に。</div>');
      } else {
        todos.push('<div class="todo">友だち限定クーポンは現在 OFF です。キャンペーンを始めるときは <a href="/admin/friend-coupon">設定画面</a> から。</div>');
      }
    }
    if(!todos.length && faq && fc && ch) todos.push('<div class="todo">今やるべきことはありません 🎉</div>');
    if(!todos.length) todos.push('<div class="todo warn">一部の情報が取得できていません。再読み込みしても続く場合は開発者に連絡してください。</div>');
    $('todos').innerHTML = todos.join('');
    // 機能ステータス (行はサーバから受信 — 公開 shell には埋め込まない)
    if(Array.isArray(d.features)){
      var rows = d.features.map(function(row){
        var pillHtml, detail = '';
        if(row.dynamic === 'friendCoupon' && !fc){
          // 状態不明 (section 取得失敗) を断定 OFF と区別する
          pillHtml = '<span class="pill off">取得できませんでした</span>';
        } else if(row.dynamic === 'friendCoupon'){
          // 顧客側の実際の表示条件 (enabled かつ code あり) と同じ判定にする —
          // enabled だけ見て「表示中」と言うと、コード未設定のとき嘘になる
          var fcLive = !!(fc.enabled && fc.codeSet);
          var fcOff = (fc.enabled && !fc.codeSet) ? 'コード未設定 — お客様には非表示' : 'OFF (いつでもONにできます)';
          pillHtml = fcLive ? '<span class="pill on">表示中</span>' : '<span class="pill off">' + esc(fcOff) + '</span>';
        } else if(row.dynamic === 'subscriptionIngest' && !sub){
          // 実測 section の取得失敗を gate だけの緑に落とさない — それでは
          // 「secret の値しか見ないので 401 全滅でも緑」という、この行を作った理由そのものが復活する
          pillHtml = '<span class="pill off">取得できませんでした</span>';
        } else {
          pillHtml = row.on ? '<span class="pill on">稼働中</span>' : '<span class="pill off">' + esc(row.offText || '未公開') + '</span>';
          if(row.dynamic === 'subscriptionIngest'){
            // gate の値だけでなく実測を併記 — 収集が「本当に」動いているかはここで見る。
            // 実測日付あり > 0 なのに最終受信が取れないのは cron_run_logs の保持期限切れ
            // (受信していない証拠ではない) なので「まだなし」とは言わない
            var lastM = fmtAgo(sub.lastMeasuredAt);
            var lastMText = lastM ? esc(lastM) : (Number(sub.flowMeasured||0) > 0 ? '30日以上前' : 'まだなし');
            detail = '<div class="hint">契約 ' + Number(sub.active||0) + ' 件 ・ 実測日付あり ' + Number(sub.flowMeasured||0)
              + ' 件 ・ 実測の最終受信 ' + lastMText + '</div>';
          }
        }
        return '<tr><td>' + esc(row.label) + detail + '</td><td>' + pillHtml + '</td></tr>';
      });
      $('features').innerHTML = rows.join('');
    }
    // cron: 最終稼働 (生存) と job 別の失敗 (品質) を別々に出す —
    // MAX(ran_at) は 1 本でも生きていれば緑になるので、失敗の検出には使えない
    if(sys && sys.lastCronAt){
      var t = new Date(sys.lastCronAt + (String(sys.lastCronAt).indexOf('+')<0 ? '+09:00' : ''));
      var mins = Math.round((Date.now() - t.getTime())/60000);
      $('v-cron').textContent = (mins <= 1 ? 'たった今' : mins + ' 分前') + (mins > 60 ? ' ⚠️' : ' ✅');
      $('v-cron').classList.remove('skeleton');
    } else { $('v-cron').textContent = '取得できませんでした'; }
    if(sys && Array.isArray(sys.failingJobs) && sys.failingJobs.length){
      var jobs = sys.failingJobs.map(function(j){
        return esc(j.jobName) + ' (' + Number(j.n) + '件' + (fmtAgo(j.lastAt) ? '・直近 ' + esc(fmtAgo(j.lastAt)) : '') + ')';
      }).join('、 ');
      $('cron-fail').innerHTML = '<div class="todo warn" style="margin:8px 0">⚠️ 24時間以内に失敗した自動処理: ' + jobs + ' — この表示が続く場合は開発者に連絡してください</div>';
    } else {
      $('cron-fail').innerHTML = '';
    }
  }
  $('logout').addEventListener('click', function(){
    if(!window.confirm('この端末に保存されたキーを消します。次に使うときは再度貼り付けが必要です。よろしいですか？')) return;
    ['lh_admin_apikey','faq_admin_apikey','fc_admin_apikey'].forEach(function(k){ localStorage.removeItem(k); });
    $('apikey').value = '';
    $('whoami').textContent = '';
    setStatus('✅ この端末からキーを消しました', true);
  });

  $('reload').addEventListener('click', load);
  $('apikey').addEventListener('change', load);
  if($('apikey').value) load();
</script>
</body>
</html>`;
