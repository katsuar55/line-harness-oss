import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { LineClient } from '@line-crm/line-sdk';
import { getLineAccounts } from '@line-crm/db';
import { processStepDeliveries } from './services/step-delivery.js';
import { processScheduledBroadcasts } from './services/broadcast.js';
import { processReminderDeliveries } from './services/reminder-delivery.js';
import { checkAccountHealth } from './services/ban-monitor.js';
import { refreshLineAccessTokens } from './services/token-refresh.js';
import { syncShopifyCustomers } from './services/shopify-customer-sync.js';
import { processAbandonedCartNotifications } from './services/abandoned-cart-notify.js';
import { processTagElapsedDeliveries } from './services/tag-elapsed-delivery.js';
import { fetchPendingBroadcastInsights } from './services/broadcast-insights-fetcher.js';
import { checkAuditFailureSpike } from './services/audit-failure-monitor.js';
import { checkLineQuota } from './services/line-quota-monitor.js';
import { authMiddleware } from './middleware/auth.js';
import { liffAuthMiddleware } from './middleware/liff-auth.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { webhook } from './routes/webhook.js';
import { friends } from './routes/friends.js';
import { tags } from './routes/tags.js';
import { scenarios } from './routes/scenarios.js';
import conductor from './routes/conductor.js';
import { broadcasts } from './routes/broadcasts.js';
import { users } from './routes/users.js';
import { lineAccounts } from './routes/line-accounts.js';
import { conversions } from './routes/conversions.js';
import { affiliates } from './routes/affiliates.js';
import { openapi } from './routes/openapi.js';
import { liffRoutes } from './routes/liff.js';
// Round 3 ルート
import { webhooks } from './routes/webhooks.js';
import { calendar } from './routes/calendar.js';
import { reminders } from './routes/reminders.js';
import { scoring } from './routes/scoring.js';
import { templates } from './routes/templates.js';
import { chats } from './routes/chats.js';
import { notifications } from './routes/notifications.js';
import { stripe } from './routes/stripe.js';
import { shopify as shopifyRoutes } from './routes/shopify.js';
import lineMetafieldMigration from './routes/line-metafield-migration.js';
import { shopifyPhase2a } from './routes/shopify-phase2a.js';
import { health } from './routes/health.js';
import { banRecovery } from './routes/ban-recovery.js';
import { automations } from './routes/automations.js';
import { richMenus } from './routes/rich-menus.js';
import { trackedLinks } from './routes/tracked-links.js';
import { forms } from './routes/forms.js';
import { autoReplies } from './routes/auto-replies.js';
import { segments } from './routes/segments.js';
import { adPlatforms } from './routes/ad-platforms.js';
import { staff } from './routes/staff.js';
import { images } from './routes/images.js';
import { abTests } from './routes/ab-tests.js';
import { shopifyProducts } from './routes/shopify-products.js';
import { analyticsRoutes } from './routes/analytics.js';
import { liffPortal } from './routes/liff-portal.js';
import { friendCoupon } from './routes/friend-coupon.js';
import { faqAdmin } from './routes/faq-admin.js';
import { adminStaff } from './routes/admin-staff.js';
import { adminDashboard } from './routes/admin-dashboard.js';
import { liffPages } from './routes/liff-pages.js';
import { liffFoodGraph } from './routes/liff-food-graph.js';
import { liffFoodPage } from './routes/liff-food-page.js';
import { liffCoachPage } from './routes/liff-coach-page.js';
import { liffReorderPage } from './routes/liff-reorder-page.js';
import { liffMyRank } from './routes/liff-my-rank.js';
import { tips } from './routes/tips.js';
import { ambassadors } from './routes/ambassadors.js';
import { csvExport } from './routes/csv-export.js';
import { dashboard } from './routes/dashboard.js';
import { auditLogs } from './routes/audit-logs.js';
import { lineFriendCoupons } from './routes/line-friend-coupons.js';
import { lineInsights } from './routes/line-insights.js';
import { reminderMessages } from './routes/reminder-messages.js';
import { surveys } from './routes/surveys.js';
import { shopifyAuth } from './routes/shopify-auth.js';
import { groups } from './routes/groups.js';
import { tagElapsedDeliveries } from './routes/tag-elapsed-deliveries.js';
import { emailUnsubscribe } from './routes/email-unsubscribe.js';
import { emailOptIn } from './routes/email-opt-in.js';
import { liffOptIn } from './routes/liff-opt-in.js';
import { liffOptInPage } from './routes/liff-opt-in-page.js';
import { liffAccountLink } from './routes/liff-account-link.js';
import { accountLinkAdmin } from './routes/account-link-admin.js';
import { friendsProfileAdmin } from './routes/friends-profile-admin.js';
import { integrationsResend } from './routes/integrations-resend.js';
import { birthdayCollection } from './routes/birthday-collection.js';
import { coachAdmin } from './routes/coach-admin.js';
import { reorderAdmin } from './routes/reorder-admin.js';
import { emailAdmin } from './routes/email-admin.js';
import { aiModels } from './routes/ai-models.js';
import { googleAudit } from './routes/shopify-google-audit.js';
import { membership as membershipRoutes } from './routes/membership.js';
import { processScheduledAbTests } from './services/ab-test.js';
// Phase 1 (2026-04-26): processIntakeReminders は能動pull化により cron 停止。
// 既存 service コードは残置 (将来オプトイン式に再活性化する可能性あり)。
// 友だちは LIFF Portal Top の「朝/昼/夜」3ボタンから自発的に記録するように変更。
import { processWeeklyReports } from './services/weekly-report.js';
import { processSubscriptionReminders } from './services/subscription-reminder.js';
import { processBillingReminders } from './services/subscription-billing-reminder.js';
import { processOwnBilling } from './services/own-billing.js';
import { ownBillingWebhook, buildAdapter } from './routes/own-billing-webhook.js';
import { buildEmailDispatcherDeps } from './services/email-dispatch-config.js';
import type { NoticeDispatchDeps } from './services/own-billing-notify.js';
import { processMonthlyFoodReports } from './services/monthly-food-report.js';
import { processWeeklyCoachPush } from './services/weekly-coach-push.js';
import { processCronMonitor } from './services/cron-monitor.js';
import { processBirthdayGreetings } from './services/birthday-cron.js';
import { processMembershipPromotionSanity } from './services/membership-promotion-cron.js';
import { processLoyaltyRankReeval } from './services/loyalty-rank-cron.js';
import { processFriendCustomerLink } from './services/friend-customer-linker.js';
import { syncAiModelsCatalog } from './services/ai-models-catalog.js';
import { syncCloudflareChangelog } from './services/cloudflare-changelog-sync.js';
import { processEmailFailureMonitor } from './services/email-failure-monitor.js';
import { processCronCleanup } from './services/cron-cleanup.js';
import { processAccountLinkCleanup } from './services/account-link-cleanup.js';
import { processWebhookDeliveryCleanup } from './services/webhook-delivery-cleanup.js';
import { processConversationLogCleanup } from './services/conversation-log-cleanup.js';
import { withHeartbeat } from './services/cron-heartbeat.js';
import { createLogger } from './services/logger.js';
import { buildEmailDispatchConfig } from './services/email-dispatch-config.js';

export type Env = {
  Bindings: {
    DB: D1Database;
    IMAGES?: R2Bucket;
    AI: Ai;
    LINE_CHANNEL_SECRET: string;
    LINE_CHANNEL_ACCESS_TOKEN: string;
    API_KEY: string;
    ANTHROPIC_API_KEY?: string;  // Phase 3: AI 食事画像解析。未設定時は image webhook 側で skip
    LIFF_URL: string;
    LINE_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_SECRET: string;
    WORKER_URL: string;
    ACCOUNT_NAME?: string;
    AI_SYSTEM_PROMPT?: string;
    AI_MODEL_PRIMARY?: string;
    AI_MODEL_FALLBACK?: string;
    X_HARNESS_URL?: string;  // Optional: X Harness API URL for account linking
    SHOPIFY_WEBHOOK_SECRET?: string;
    SHOPIFY_STORE_DOMAIN?: string;
    SHOPIFY_CLIENT_ID?: string;
    SHOPIFY_CLIENT_SECRET?: string;
    SHOPIFY_LINE_NOTIFY_ENABLED?: string; // 'true' to enable LINE notifications from Shopify webhooks
    // 監視 (オプショナル, secret 未登録時は no-op)
    AXIOM_TOKEN?: string;
    AXIOM_DATASET?: string;
    DISCORD_WEBHOOK_URL?: string;
    /** Phase 5 PR-4: 'true' で cron-monitor の gating を bypass (テスト/手動用) */
    CRON_MONITOR_FORCE?: string;
    /** Phase 7 (2026-05-01): 'true' で cron-cleanup の 03:00 JST gating を bypass */
    CRON_CLEANUP_FORCE?: string;
    /** LSTEP audit H4 (2026-05-22): 'true' で line-quota-monitor の hour-boundary gating を bypass */
    LINE_QUOTA_MONITOR_FORCE?: string;
    WEBHOOK_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
    API_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
    // Round 4: Email channel (Resend). Secret は wrangler secret put で別途登録
    RESEND_API_KEY?: string;
    RESEND_WEBHOOK_SECRET?: string; // Svix webhook signature 用 (whsec_... 形式)
    EMAIL_FROM?: string;
    EMAIL_REPLY_TO?: string;
    EMAIL_UNSUBSCRIBE_BASE_URL?: string;
    EMAIL_UNSUBSCRIBE_HMAC_KEY?: string;
    EMAIL_LEGAL_FOOTER_HTML?: string;
    EMAIL_LEGAL_FOOTER_TEXT?: string;
    // Phase 5β-1: email opt-in
    EMAIL_OPTIN_HMAC_KEY?: string;       // HMAC token 署名 secret (web 経路で必須)
    // 5β-1e (2026-05-18): EMAIL_OPTIN_DEFAULT_COUPON 削除 (商業判断、 メルマガ登録ではクーポンを付与しない)
    // 自動 update 戦略 #1 (2026-05-26): Cloudflare AI models catalog sync
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    AI_MODELS_SYNC_FORCE?: string;
    // 自動 update 戦略 #2 (2026-05-26): Cloudflare changelog RSS sync
    //   認証不要 (= public RSS feed)。 Discord 通知用に DISCORD_WEBHOOK_URL があれば便利。
    CHANGELOG_SYNC_FORCE?: string;
    // 自社内製ロイヤリティ PR3 (2026-06-05): friend↔Shopify customer metafield 自動リンク
    //   'true' で本番リンク有効化 (= 未設定なら cron は no-op、 本番未書込)。 metafield ns/key も必須。
    FRIEND_LINK_ENABLED?: string;
    FRIEND_LINK_METAFIELD_NAMESPACE?: string; // CRM PLUS「LINE ID」customer metafield の namespace
    FRIEND_LINK_METAFIELD_KEY?: string;       // 同 key (= 実機 Admin で確認後に設定)
    FRIEND_LINK_CRON_FORCE?: string;          // 'true' で JST 02:00-02:04 gating を bypass (テスト/手動)
    // PR3-B (2026-06-05): link 成立後の過去注文 backfill (= money path、 linking とは別 gate)
    //   'true' で有効化 (= 未設定なら backfill は no-op、 本番 member_purchase_events 未書込)。
    //   ⚠️ read_all_orders scope 未付与だと直近60日のみ取得 (= 完全 backfill には scope 追加が必要)。
    MEMBER_BACKFILL_ENABLED?: string;
    // 自前 friend↔Shopify customer 連携 Option B (2026-06-06): LIFF + email OTP 本人確認
    //   CRM PLUS / Social PLUS 非依存。 'true' で有効化 (= 未設定なら全 endpoint が disabled、 本番未稼働)。
    ACCOUNT_LINK_ENABLED?: string;
    ACCOUNT_LINK_HMAC_KEY?: string;            // OTP hash の pepper (= server secret、 有効化時 必須)
    ACCOUNT_LINK_METAFIELD_NAMESPACE?: string; // 自己所有 customer metafield の namespace (default 'naturism')
    ACCOUNT_LINK_METAFIELD_KEY?: string;       // 同 key (default 'line_user_id')
    ACCOUNT_LINK_CLEANUP_FORCE?: string;       // 'true' で account_link_codes cleanup の JST 03:10 gating を bypass
    WEBHOOK_DELIVERY_CLEANUP_FORCE?: string;   // 'true' で webhook_deliveries cleanup の JST 03:20 gating を bypass
    BROADCAST_ALL_ENABLED?: string;            // 'true' で target_type='all' の LINE broadcast を許可 (既定OFF=blacklist bypass 防止、 ② Codex)
    CONVERSATION_LOG_CLEANUP_FORCE?: string;   // 'true' で messages_log/conversation_logs 2年prune の JST 03:30 gating を bypass
    // 自社内製ロイヤリティ PR5 (2026-06-04): ランク割引コードの本番発行 gate
    //   'true' で issueRankDiscountForFriend が本番 Shopify に書込 (= 未設定なら no-op、 本番未書込)。
    RANK_DISCOUNT_ENABLED?: string;
    // 友だち紹介の referrer 報酬クーポン発行 gate (2026-07-10): referred がクーポン利用購入時に発行
    //   'true' で issueReferralCoupon が本番 Shopify に書込 (= 未設定なら no-op、 本番未書込)。
    //   ⚠️ 有効化前に migration 068 (line_referral_coupons) 適用が必要。
    REFERRAL_REWARD_ENABLED?: string;
    // サブスク・コンシェルジュ gate (WI-1 2026-07-14, docs/SUBSCRIPTION_ULTRAPLAN_2026-07-14.md):
    //   'true' でリッチメニュー「サブスク」postback / サブスク intent / 契約 read-model 導出が有効。
    //   ⚠️ 有効化手順 (順番厳守): ①migration 069 適用 → ②rebuild endpoint 実行 (gate 非連動、
    //     read-model を温める。gate ON 後の再実行は ?force=1 必須 = スキップ先送りを消しうる) →
    //     ③本 gate ON → ④実機確認 → ⑤リッチメニュー v4 反映 (setup-naturism)。
    SUBSCRIPTION_MENU_ENABLED?: string;
    // サブスク決済4日前リマインド + 決済失敗リカバリ通知 gate (WI-2 2026-07-14):
    //   'true' で teiki-billing-reminder cron と pause 遷移時の LINE push が有効。
    //   SUBSCRIPTION_MENU_ENABLED=true (read-model 稼働) が前提。
    SUBSCRIPTION_REMINDER_ENABLED?: string;
    // Shopify Flow → /api/integrations/teiki-flow の共有シークレット (WI-2)。
    //   未設定なら受信口は 401 (実質無効。503 にしない — 設定状態を外部に開示しないため、
    //   区別はサーバログのみ)。設定手順: docs/TEIKI_FLOW_SETUP.md
    TEIKI_FLOW_SECRET?: string;
    // Phase 3 自社課金基盤 gate 群 (WI-4, docs/PHASE3_BILLING_DESIGN_2026-07-19.md §8):
    //   canIssueAttempt() = ENABLED='true' ∧ ARMED_AT 設定済 ∧ ¬breaker(D1) ∧ allowlist match
    //   ∧ ¬excludelist match。全て未設定 (既定) = own-billing は heartbeat のみの dormant。
    //   緊急停止 = Admin Ops「billing-kill」op (ENABLED + SUB_MIGRATION を同時 'false')。
    SELF_BILLING_ENABLED?: string;
    SELF_BILLING_ARMED_AT?: string;            // arming インターロック (ISO 日時。未設定 = 発行不可)
    SELF_BILLING_ALLOWLIST?: string;           // 契約 gid CSV or 'ALL'。fail-closed (空/parse不能=ゼロ)
    SELF_BILLING_EXCLUDELIST?: string;         // 契約単位の緊急除外 (実効 = secret ∪ D1 quarantine)
    SUB_MIGRATION_ENABLED?: string;            // 移行 phase 機械の自動遷移 gate (§7)
    SELF_BILLING_UI_ENABLED?: string;          // WI-1 カードの実 API 化 gate (§8)
    // 新規ユーザー限定 welcome クーポン用の顧客セグメント gid (2026-07-10):
    //   例 gid://shopify/Segment/xxx (= Shopify Admin で「注文回数 0」segment を作成)。
    //   設定時、 welcome クーポンはこのセグメントのみ対象 (= 既存客の複数アカウント farming 防止)。
    //   未設定なら全顧客 (従来挙動)。
    SHOPIFY_WELCOME_CUSTOMER_SEGMENT_ID?: string;
    SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;     // Shopify access token 暗号化鍵 (= token cache、 getShopifyAccessToken)
    LOYALTY_RANK_CRON_FORCE?: string;          // 'true' で月次 rank 再判定 cron の JST 1日 09:05 gating を bypass
  };
  Variables: {
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
    liffUser: { lineUserId: string; friendId: string };
  };
};

const app = new Hono<Env>();

// CORS — 許可オリジンを制限
const CORS_ALLOWED_ORIGINS = [
  'https://naturism-admin.pages.dev',
  'https://liff.line.me',
  // 独自ドメイン (Custom Domain。DNS 接続前でも allowlist に入れておくのは無害 —
  // 未接続の間はこの Origin のリクエスト自体が存在しない)。docs/CUSTOM_DOMAIN_RUNBOOK.md
  'https://crm.naturism-diet.com',
  'http://localhost:3001',
  'http://localhost:3000',
];

/**
 * CORS origin リゾルバ。 許可オリジンはそのまま返し、 Origin ヘッダ無しは '*'、
 * 未許可オリジンは null (= ACAO ヘッダを付けず、 ブラウザがレスポンスをブロック)。
 * 以前は未許可 origin を verbatim echo しており allowlist が実質無効化されていた (CORS bypass)。
 * R2 画像 (<img src>) はブラウザが CORS を要求しないため本挙動で壊れない。
 */
export function resolveCorsOrigin(origin: string | undefined | null): string | null {
  if (!origin || CORS_ALLOWED_ORIGINS.includes(origin)) return origin || '*';
  return null;
}

app.use('*', cors({ origin: (origin) => resolveCorsOrigin(origin) }));

// Rate limiting — runs before auth to block abuse early
app.use('*', rateLimitMiddleware);

// Health check — before auth (認証不要)
app.get('/api/health', (c) => c.json({ success: true, status: 'ok', timestamp: new Date().toISOString() }));

// Auth middleware — skips /webhook and /docs automatically
app.use('*', authMiddleware);
app.use('/api/liff/*', liffAuthMiddleware);

// Mount route groups — MVP & Round 2
app.route('/', webhook);
app.route('/', friends);
app.route('/', tags);
app.route('/', scenarios);
app.route('/', conductor);
app.route('/', broadcasts);
app.route('/', users);
app.route('/', lineAccounts);
app.route('/', conversions);
app.route('/', affiliates);
app.route('/', openapi);
app.route('/', liffRoutes);

// Mount route groups — Round 3
app.route('/', webhooks);
app.route('/', calendar);
app.route('/', reminders);
app.route('/', scoring);
app.route('/', templates);
app.route('/', chats);
app.route('/', notifications);
app.route('/', stripe);
app.route('/', shopifyRoutes);
app.route('/', lineMetafieldMigration);
app.route('/', shopifyPhase2a);
app.route('/', health);
app.route('/', banRecovery);
app.route('/', automations);
app.route('/', richMenus);
app.route('/', friendCoupon);
app.route('/', faqAdmin);
app.route('/', adminDashboard);
app.route('/', adminStaff);
app.route('/', trackedLinks);
app.route('/', forms);
app.route('/', autoReplies);
app.route('/', segments);
app.route('/', adPlatforms);
app.route('/', staff);
app.route('/', images);
app.route('/', abTests);
app.route('/', shopifyProducts);
app.route('/api/analytics', analyticsRoutes);
app.route('/', liffPortal);
app.route('/', liffPages);
app.route('/', liffFoodGraph);
app.route('/', liffFoodPage);
app.route('/', liffCoachPage);
app.route('/', liffReorderPage);
app.route('/', liffMyRank);
app.route('/', tips);
app.route('/', ambassadors);
app.route('/', csvExport);
app.route('/', dashboard);
app.route('/', lineInsights);
app.route('/', auditLogs);
app.route('/', lineFriendCoupons);
app.route('/', reminderMessages);
app.route('/', surveys);
app.route('/', shopifyAuth);
app.route('/', groups);
app.route('/', tagElapsedDeliveries);
app.route('/', emailUnsubscribe);
app.route('/', emailOptIn);
app.route('/', liffOptIn);
app.route('/', liffOptInPage);
app.route('/', liffAccountLink);
app.route('/', accountLinkAdmin);
// WI-4 step3: Phase 3 自社課金基盤の Shopify サブスク webhook 受信口。
// HMAC 検証で代替認証 (authMiddleware は POST 限定で skip)。own 契約 0 件の間は無害。
app.route('/', ownBillingWebhook);
app.route('/', friendsProfileAdmin);
app.route('/', integrationsResend);
// liffCart route 削除 (2026-04-29): /api/liff/cart endpoints は dead code
// (どのクライアントも未使用)。liff_carts table は本番に残置 (DROP は不可逆のため避ける)。
// 必要なら git history (commit 0b32cac) から復活可能。
app.route('/', birthdayCollection);
app.route('/', coachAdmin);
app.route('/', reorderAdmin);
app.route('/', emailAdmin);
app.route('/', aiModels);
app.route('/', googleAudit);
app.route('/', membershipRoutes);

// Short link: /r/:ref → landing page with LINE open button
app.get('/r/:ref', (c) => {
  const ref = c.req.param('ref');
  const liffUrl = c.env.LIFF_URL;
  if (!liffUrl) {
    return c.json({ error: 'LIFF_URL is not configured. Set it via wrangler secret put LIFF_URL.' }, 500);
  }
  const target = `${liffUrl}?ref=${encodeURIComponent(ref)}`;

  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>naturism</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans',system-ui,sans-serif;background:#0d1117;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{text-align:center;max-width:400px;width:90%;padding:48px 24px}
h1{font-size:28px;font-weight:800;margin-bottom:8px}
.sub{font-size:14px;color:rgba(255,255,255,0.5);margin-bottom:40px}
.btn{display:block;width:100%;padding:18px;border:none;border-radius:12px;font-size:18px;font-weight:700;text-decoration:none;text-align:center;color:#fff;background:#06C755;transition:opacity .15s}
.btn:active{opacity:.85}
.note{font-size:12px;color:rgba(255,255,255,0.3);margin-top:24px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
<h1>naturism</h1>
<p class="sub">L社 / U社 の無料代替 OSS</p>
<a href="${target}" class="btn">LINE で体験する</a>
<p class="note">友だち追加するだけで<br>ステップ配信・フォーム・自動返信を体験できます</p>
</div>
</body>
</html>`);
});

// メール起動ブリッジ (実機FB第5弾 2026-07-10): LINE Flex の uri action は mailto: 非対応
// (公式 scheme は http/https/line/tel のみ) のため、 contact card の「メールを送る」は
// この https ページを経由する。 開くと即メールアプリを起動し、 失敗時は手動ボタン + コピー fallback。
app.get('/contact/email', (c) => {
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

// Convenience redirect for /book path
app.get('/book', (c) => c.redirect('/?page=book'));

// /liff/cart の SPA は未実装 (/api/liff/cart endpoints は dead code 相当)。
// 当初 /liff/reorder に redirect したが、/liff/reorder は subscription_reminders
// 編集 SPA (Phase 6 PR-4) であってカート機能ではないことが判明 (2026-04-29 自己レビュー)。
// LIFF Top メニュー (マイページ/栄養コーチ/食事記録/再購入) に着地させる。
// クエリ文字列 (utm 等) は引き継ぐ。
app.get('/liff/cart', (c) => {
  const url = new URL(c.req.url);
  const target = url.search ? `/liff/portal${url.search}` : '/liff/portal';
  return c.redirect(target);
});
app.get('/liff/cart/', (c) => {
  const url = new URL(c.req.url);
  const target = url.search ? `/liff/portal${url.search}` : '/liff/portal';
  return c.redirect(target);
});

// 全ルート共通エラーハンドラ — Axiom + Discord 通知 (secret 未登録時は no-op)
// 監視機能は fail-safe: ログ送信が失敗してもアプリ応答は通す
app.onError((err, c) => {
  const ctx = (c.executionCtx as unknown as { waitUntil?: (p: Promise<unknown>) => void }) ?? null;
  const logCtx = ctx?.waitUntil ? { waitUntil: ctx.waitUntil.bind(ctx) } : null;
  const log = createLogger(c.env, logCtx);
  log.error('unhandled route error', {
    path: new URL(c.req.url).pathname,
    method: c.req.method,
    err,
  });
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

// 404 fallback — JSON for API paths, plain for others (Workers Assets SPA fallback handles it)
// 注意: app.notFound 内で c.notFound() を呼ぶと Hono v4 では再帰呼び出しになり
// stack overflow → onError で 500 を返してしまう (2026-04-29 hotfix で発覚)。
// 必ず Response を直接 return すること。
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/') || path === '/webhook' || path === '/docs' || path === '/openapi.json') {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  return c.text('Not Found', 404);
});

// Scheduled handler for cron triggers — runs for all active LINE accounts
async function scheduled(
  _event: ScheduledEvent,
  env: Env['Bindings'],
  ctx: ExecutionContext,
): Promise<void> {
  // Get all active accounts from DB, plus the default env account
  const dbAccounts = await getLineAccounts(env.DB);
  const activeTokens = new Set<string>();

  // Default account from env
  activeTokens.add(env.LINE_CHANNEL_ACCESS_TOKEN);

  // DB accounts
  for (const account of dbAccounts) {
    if (account.is_active) {
      activeTokens.add(account.channel_access_token);
    }
  }

  // Run delivery for each account
  // Phase 7 (2026-04-29): 各 cron を withHeartbeat() でラップし cron_run_logs に書き込み。
  // 既に内部で insertCronRunLog 呼んでいるもの (subscription-reminder / monthly-food-report
  // / weekly-coach-push) はラップしない (重複書き込み防止)。
  const emailConfig = buildEmailDispatchConfig(env);
  const jobs = [];
  for (const token of activeTokens) {
    const lineClient = new LineClient(token);
    jobs.push(
      withHeartbeat(env.DB, 'step-delivery', () =>
        processStepDeliveries(env.DB, lineClient, env.WORKER_URL, emailConfig)),
      withHeartbeat(env.DB, 'scheduled-broadcasts', () =>
        processScheduledBroadcasts(env.DB, lineClient, env.WORKER_URL, emailConfig, {
          broadcastAllEnabled: env.BROADCAST_ALL_ENABLED === 'true',
        })),
      withHeartbeat(env.DB, 'reminder-delivery', () =>
        processReminderDeliveries(env.DB, lineClient)),
      withHeartbeat(env.DB, 'scheduled-ab-tests', () =>
        processScheduledAbTests(env.DB, lineClient, env.WORKER_URL)),
      // Phase 1: processIntakeReminders は cron 停止 (能動pull化)
      withHeartbeat(env.DB, 'weekly-reports', () =>
        processWeeklyReports(env.DB, lineClient)),
      // subscription-reminder は内部で insertCronRunLog 呼ぶため wrap しない
      processSubscriptionReminders(env.DB, lineClient, env.LIFF_URL || ''),
      // WI-2 (2026-07-14): サブスク決済4日前リマインド (gate/送信窓/CAS 冪等はサービス内。
      // 内部で insertCronRunLog を呼ぶため wrap しない。multi-account は CAS で二重送信なし)
      processBillingReminders(env, lineClient),
      withHeartbeat(env.DB, 'abandoned-cart-notify', () =>
        processAbandonedCartNotifications(env.DB, lineClient, env.LIFF_URL || '')),
      withHeartbeat(env.DB, 'tag-elapsed-deliveries', () =>
        processTagElapsedDeliveries(env.DB, lineClient, env.WORKER_URL)),
      // Phase 5β-5c-prep: 配信済 broadcast の LINE Insight API 集計取得 (= read/click rate)
      // 1 cycle あたり BATCH_SIZE=5、 retryable (overview=null) は次回 cron に持ち越し
      withHeartbeat(env.DB, 'broadcast-insights-fetch', () =>
        fetchPendingBroadcastInsights(env.DB, lineClient).then((r) => {
          if (r.succeeded > 0 || r.failed > 0) {
            console.info(
              `broadcast-insights-fetch: processed=${r.processed} succeeded=${r.succeeded} failed=${r.failed} retryable=${r.retryable}`,
            );
          }
          return r;
        })),
    );
  }
  jobs.push(withHeartbeat(env.DB, 'ban-monitor', () => checkAccountHealth(env.DB)));
  jobs.push(withHeartbeat(env.DB, 'token-refresh', () => refreshLineAccessTokens(env.DB)));
  // WI-4 (Phase 3 自社課金基盤) own-billing 5分 tick。account 非依存のため token loop の外で 1 回。
  // gate OFF (既定) = skippedGating heartbeat のみ・071/072 新テーブル非アクセス
  // (migration 未適用でも安全)。内部で insertCronRunLog を呼ぶため wrap しない。
  //
  // step3 で ①実 Shopify adapter ②通知キューの配送先 (LINE + email fallback) を注入する。
  // どちらも canIssueAttempt / gate の内側でしか使われないため、gate OFF の現状では
  // 「作るだけで一切呼ばれない」(= 本番挙動は不変)。
  jobs.push(
    (async () => {
      const ownBillingDeps: Parameters<typeof processOwnBilling>[1] = {};
      // ⚠️ gate OFF の間は adapter を **作らない**。buildAdapter は D1 読み + (期限切れなら)
      // Shopify token エンドポイントへの subrequest を伴うため、5 分毎 tick で常時呼ぶと
      // dormant のはずの機能が実費と subrequest 予算を消費してしまう。
      // (processOwnBilling 側も !enabled で即 return するので、ここで作っても使われない)
      if ((env.SELF_BILLING_ENABLED ?? '').replace(/[\r\n]/g, '') === 'true') {
        const billingApi = await buildAdapter(env.DB, env);
        if (billingApi) ownBillingDeps.api = billingApi;
        const notify: NoticeDispatchDeps = {
          lineClient: new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN),
        };
        if (emailConfig) Object.assign(notify, buildEmailDispatcherDeps(emailConfig));
        ownBillingDeps.notify = notify;
      }
      return processOwnBilling(env, ownBillingDeps);
    })(),
  );

  // Phase 5β-1d-2f-followup-2: audit_logs failure spike monitoring (= Discord alert via logger)
  // 直近 5 min で failure 3 件以上 → alert (cooldown 1h で重複防止)
  jobs.push(
    withHeartbeat(env.DB, 'audit-failure-monitor', async () => {
      const monitorLogger = createLogger(env, ctx);
      return checkAuditFailureSpike(env.DB, monitorLogger);
    }),
  );

  // LSTEP audit H4 (2026-05-22): LINE Messaging API 月次 quota 監視
  // JST hour boundary (= 各時 0-4 分窓) のみ trigger、 cron は 5 分毎なので 1 hour に 1 回
  // service 内 cooldown 24h で alert 重複防止
  // multi-account は次 PR で対応 (= 今は default account のみ check)
  const nowJstMinute = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCMinutes();
  const isHourBoundary = nowJstMinute < 5;
  if (env.LINE_QUOTA_MONITOR_FORCE === 'true' || isHourBoundary) {
    jobs.push(
      withHeartbeat(env.DB, 'line-quota-monitor', async () => {
        const quotaLogger = createLogger(env, ctx);
        const defaultClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
        const r = await checkLineQuota(env.DB, defaultClient, quotaLogger);
        if (r.alerted) {
          console.info(
            `line-quota-monitor: severity=${r.severity} usage=${r.usage}/${r.limit} ratio=${r.ratio}`,
          );
        }
        return r;
      }),
    );
  }

  // Phase 3: 月次食事レポート (毎月 1 日のみ実行、サービス側で gating)
  // Phase 4 PR-5: 週次栄養コーチ push (火曜 10:00 JST のみ trigger、サービス側で gating)
  // Phase 5β-prep adoption batch 2: 両 job で AIRouter を共有 (createAIRouterFromEnv は冪等で軽量)
  jobs.push(
    (async () => {
      const { createAIRouterFromEnv } = await import('./services/ai-router-factory.js');
      const router = createAIRouterFromEnv(env);
      try {
        const r = await processMonthlyFoodReports(env.DB, { router });
        if (r.generated > 0 || r.errors > 0) {
          console.info(
            `monthly food reports: generated=${r.generated} skipped=${r.skipped} errors=${r.errors}`,
          );
        }
      } catch (err) {
        console.error('monthly-food-report failed', err instanceof Error ? err.name : 'unknown');
      }
      try {
        await processWeeklyCoachPush(env, { router });
      } catch (err) {
        console.error('weekly-coach-push failed', err instanceof Error ? err.name : 'unknown');
      }
    })(),
  );

  // Shopify顧客同期（5分ごと実行、冪等なので安全）
  jobs.push(
    withHeartbeat(env.DB, 'shopify-customer-sync', () =>
      syncShopifyCustomers(env.DB, env as unknown as Record<string, string | undefined>),
      (r) => ({ synced: r.synced, error: r.error ?? null }),
    ).then((r) => {
      if (r.synced > 0) console.info(`Shopify customer sync: ${r.synced} customers`);
      if (r.error) console.warn(`Shopify customer sync warning: ${r.error}`);
    }),
  );

  // Phase 5 PR-4: 低頻度 cron の死活監視 (JST 09:00 ウィンドウのみ trigger)
  jobs.push(
    processCronMonitor(env).catch((err) =>
      console.error('cron-monitor failed', err instanceof Error ? err.name : 'unknown'),
    ),
  );

  // Phase 5α-4: email 配信失敗監視 (JST 09:00 ウィンドウのみ trigger、 EMAIL_FAILURE_MONITOR_FORCE='true' で常時)
  // email_messages_log の status='failed/bounced/complained' を集計、 閾値超で Discord 通知
  jobs.push(
    processEmailFailureMonitor(env).catch((err) =>
      console.error('email-failure-monitor failed', err instanceof Error ? err.name : 'unknown'),
    ),
  );

  // Phase 7 (2026-05-01): cron_run_logs の自動 cleanup (JST 03:00 のみ trigger、30 日保持)
  // 月間 86k 行追加見込みなので 1 年放置で 100 万行になる前に対処。
  jobs.push(
    processCronCleanup(env).catch((err) =>
      console.error('cron-cleanup failed', err instanceof Error ? err.name : 'unknown'),
    ),
  );

  // 自前 friend↔Shopify customer 連携 (2026-06-06, Phase 3): 期限切れ OTP (account_link_codes) cleanup
  //   JST 03:10-03:14 のみ trigger (= cron-cleanup 03:00 とずらす)、 1 日保持。
  //   PII (email) を長期保持しないための hygiene。 機能 gate off の間はテーブル空で no-op。
  //   ACCOUNT_LINK_CLEANUP_FORCE='true' で gating bypass。
  jobs.push(
    processAccountLinkCleanup(env).then((r) => {
      if (r.deletedRows > 0) console.info(`account-link-cleanup: deleted=${r.deletedRows}`);
    }).catch((err) =>
      console.error('account-link-cleanup failed', err instanceof Error ? err.name : 'unknown'),
    ),
  );

  // ③ webhook 冪等テーブル (webhook_deliveries, migration 066) の TTL prune (2026-06-26)
  //   JST 03:20-03:24 のみ trigger (= cron-cleanup 03:00 / account-link-cleanup 03:10 とずらす)、 72h 保持。
  //   LINE 再送による二重 fireEvent を防ぐ dedup key の無限肥大を防止。 migration 未適用でも安全 (= prune が
  //   throw しても triggered=true/deletedRows=0)。 WEBHOOK_DELIVERY_CLEANUP_FORCE='true' で gating bypass。
  jobs.push(
    processWebhookDeliveryCleanup(env).then((r) => {
      if (r.deletedRows > 0) console.info(`webhook-delivery-cleanup: deleted=${r.deletedRows}`);
    }).catch((err) =>
      console.error('webhook-delivery-cleanup failed', err instanceof Error ? err.name : 'unknown'),
    ),
  );

  // 会話ログ retention prune (採点 Round1 D6 + Katsu 判断, 2026-06-28): messages_log /
  //   conversation_logs の 24ヶ月超 (PII) を JST 03:30-03:34 のみ自動削除。 migration 不要
  //   (created_at + index 既存)。 prune 失敗でも triggered=true で cron 全体を止めない。
  //   CONVERSATION_LOG_CLEANUP_FORCE='true' で gating bypass。
  jobs.push(
    processConversationLogCleanup(env).then((r) => {
      if (r.deletedMessages > 0 || r.deletedConversations > 0) {
        console.info(
          `conversation-log-cleanup: messages=${r.deletedMessages} conversations=${r.deletedConversations}`,
        );
      }
    }).catch((err) =>
      console.error('conversation-log-cleanup failed', err instanceof Error ? err.name : 'unknown'),
    ),
  );

  // Phase 2.2 (2026-05-24): birthday cron 雛形 (= 月初 1 日 10:00 JST ± 5 分 のみ実行、 service 側で gating)
  //   - friends.birth_month = current month の friend に push 「お誕生月おめでとう + 特典 flex」
  //   - 既送マーカー (friend_metadata.birthday_greeting_sent_YYYY_MM) で同月重複 push 防止
  //   - BIRTHDAY_CRON_FORCE='true' で gating bypass (= テスト用)
  jobs.push(
    withHeartbeat(env.DB, 'birthday-greetings', () =>
      processBirthdayGreetings(env as unknown as Parameters<typeof processBirthdayGreetings>[0]),
      (r) => ({ candidates: r.candidates, sent: r.sent, errors: r.errors, skippedGating: r.skippedDueToGating }),
    ).then((r) => {
      if (r.sent > 0) {
        console.info(`birthday-greetings: month=${r.month} sent=${r.sent} alreadySent=${r.alreadySent} errors=${r.errors}`);
      }
    }).catch((err) =>
      console.error('birthday-greetings failed', err instanceof Error ? err.name : 'unknown'),
    ),
  );

  // Phase 4-δ (2026-05-28): membership 月次 promotion sanity cron
  //   - 月初 1 日 09:00 JST ± 5 分 のみ実行 (= birthday 10:00 と分離、 service 側で gating)
  //   - 全 members で promoteMemberIfEligible (= 都度 promote の safety net、 漏れ救済)
  //   - MEMBERSHIP_CRON_FORCE='true' で gating bypass
  jobs.push(
    withHeartbeat(env.DB, 'membership-promotion-sanity', () =>
      processMembershipPromotionSanity(env as unknown as Parameters<typeof processMembershipPromotionSanity>[0]),
      (r) => ({ candidates: r.candidates, promoted: r.promoted, errors: r.errors, skippedGating: r.skippedDueToGating }),
    ).then((r) => {
      if (r.promoted > 0) {
        console.info(`membership-promotion-sanity: month=${r.month} promoted=${r.promoted} unchanged=${r.unchanged} errors=${r.errors}`);
      }
    }).catch((err) =>
      console.error('membership-promotion-sanity failed', err instanceof Error ? err.name : 'unknown'),
    ),
  );

  // 自社内製ロイヤリティ (2026-06-01, PR2): 月次 rank 再判定 cron
  //   - 月初 1 日 09:05 JST ± 5 分 のみ実行 (= membership 09:00 と分離、 service 側で gating)
  //   - 全 member の trailing-12ヶ月 rank を再判定 → loyalty_rank_snapshots に記録 (昇格/降格/同)
  //   - LOYALTY_RANK_CRON_FORCE='true' で gating bypass
  jobs.push(
    withHeartbeat(env.DB, 'loyalty-rank-reeval', () =>
      processLoyaltyRankReeval(env as unknown as Parameters<typeof processLoyaltyRankReeval>[0]),
      (r) => ({ candidates: r.candidates, promoted: r.promoted, demoted: r.demoted, errors: r.errors, skippedGating: r.skippedDueToGating }),
    ).then((r) => {
      if (r.promoted > 0 || r.demoted > 0) {
        console.info(`loyalty-rank-reeval: period=${r.period} promoted=${r.promoted} demoted=${r.demoted} unchanged=${r.unchanged} errors=${r.errors}`);
      }
    }).catch((err) =>
      console.error('loyalty-rank-reeval failed', err instanceof Error ? err.name : 'unknown'),
    ),
  );

  // 自社内製ロイヤリティ (2026-06-05, PR3): friend↔Shopify customer metafield 自動リンク cron
  //   - FRIEND_LINK_ENABLED='true' + metafield ns/key 設定時のみ (= default off、 本番未書込)
  //   - JST 02:00-02:04 window のみ実行 (= Shopify 呼出を 1 日 1 回に制限、 FRIEND_LINK_CRON_FORCE で bypass)
  //   - 未 link friend を metafield 逆引きで Shopify customer に紐付け (= 後続 PR3-B 過去注文 backfill の前提)
  jobs.push(
    withHeartbeat(env.DB, 'friend-customer-link', () =>
      processFriendCustomerLink(env as unknown as Parameters<typeof processFriendCustomerLink>[0]),
      (r) => ({ scanned: r.scanned, linked: r.linked, ambiguous: r.ambiguous, notFound: r.notFound, errors: r.errors, backfilled: r.backfilled, skippedGating: r.skipped }),
    ).then((r) => {
      if (r.linked > 0 || r.ambiguous > 0) {
        console.info(`friend-customer-link: scanned=${r.scanned} linked=${r.linked} ambiguous=${r.ambiguous} notFound=${r.notFound} errors=${r.errors}`);
      }
    }).catch((err) =>
      console.error('friend-customer-link failed', err instanceof Error ? err.name : 'unknown'),
    ),
  );

  // 自動 update 戦略 #1 (2026-05-26): Cloudflare AI models catalog daily sync
  //   - JST 04:00-04:04 window のみ trigger (= service 側で gating)
  //   - secret 未設定なら graceful skip (= seed catalog のみで運用継続)
  //   - 新着 / deprecated 検出時 Discord 通知
  //   - 内部で insertCronRunLog 呼ぶため withHeartbeat 不要
  jobs.push(
    syncAiModelsCatalog(env).then((r) => {
      if (r.triggered && (r.inserted > 0 || r.newlyDeprecated > 0)) {
        console.info(
          `ai-models-catalog-sync: fetched=${r.fetched} inserted=${r.inserted} updated=${r.updated} newlyDeprecated=${r.newlyDeprecated} errors=${r.errors}`,
        );
      }
    }).catch((err) =>
      console.error('ai-models-catalog-sync failed', err instanceof Error ? err.name : 'unknown'),
    ),
  );

  // 自動 update 戦略 #2 (2026-05-26): Cloudflare developer changelog daily sync
  //   - JST 04:30-04:34 window (= ai-models の 04:00 と分離)
  //   - 認証不要 (= public RSS)、 DISCORD_WEBHOOK_URL 未設定でも upsert は実行 (= catchup)
  //   - 内部で insertCronRunLog 呼ぶため withHeartbeat 不要
  jobs.push(
    syncCloudflareChangelog(env).then((r) => {
      if (r.triggered && r.newEntries > 0) {
        console.info(
          `cloudflare-changelog-sync: feeds=${r.feedsProcessed}/${r.feedsProcessed + r.feedsFailed} new=${r.newEntries} notified=${r.notified} errors=${r.errors}`,
        );
      }
    }).catch((err) =>
      console.error('cloudflare-changelog-sync failed', err instanceof Error ? err.name : 'unknown'),
    ),
  );

  await Promise.allSettled(jobs);
}

export default {
  fetch: app.fetch,
  scheduled,
};
