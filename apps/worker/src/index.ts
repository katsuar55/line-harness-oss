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
import { authMiddleware } from './middleware/auth.js';
import { liffAuthMiddleware } from './middleware/liff-auth.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { webhook } from './routes/webhook.js';
import { friends } from './routes/friends.js';
import { tags } from './routes/tags.js';
import { scenarios } from './routes/scenarios.js';
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
import { shopifyPhase2a } from './routes/shopify-phase2a.js';
import { health } from './routes/health.js';
import { automations } from './routes/automations.js';
import { richMenus } from './routes/rich-menus.js';
import { trackedLinks } from './routes/tracked-links.js';
import { forms } from './routes/forms.js';
import { adPlatforms } from './routes/ad-platforms.js';
import { staff } from './routes/staff.js';
import { images } from './routes/images.js';
import { abTests } from './routes/ab-tests.js';
import { shopifyProducts } from './routes/shopify-products.js';
import { analyticsRoutes } from './routes/analytics.js';
import { liffPortal } from './routes/liff-portal.js';
import { liffPages } from './routes/liff-pages.js';
import { liffFoodGraph } from './routes/liff-food-graph.js';
import { liffFoodPage } from './routes/liff-food-page.js';
import { liffCoachPage } from './routes/liff-coach-page.js';
import { tips } from './routes/tips.js';
import { ambassadors } from './routes/ambassadors.js';
import { csvExport } from './routes/csv-export.js';
import { dashboard } from './routes/dashboard.js';
import { reminderMessages } from './routes/reminder-messages.js';
import { surveys } from './routes/surveys.js';
import { shopifyAuth } from './routes/shopify-auth.js';
import { groups } from './routes/groups.js';
import { tagElapsedDeliveries } from './routes/tag-elapsed-deliveries.js';
import { liffCart } from './routes/liff-cart.js';
import { birthdayCollection } from './routes/birthday-collection.js';
import { coachAdmin } from './routes/coach-admin.js';
import { processScheduledAbTests } from './services/ab-test.js';
// Phase 1 (2026-04-26): processIntakeReminders は能動pull化により cron 停止。
// 既存 service コードは残置 (将来オプトイン式に再活性化する可能性あり)。
// 友だちは LIFF Portal Top の「朝/昼/夜」3ボタンから自発的に記録するように変更。
import { processWeeklyReports } from './services/weekly-report.js';
import { processSubscriptionReminders } from './services/subscription-reminder.js';
import { processMonthlyFoodReports } from './services/monthly-food-report.js';
import { processWeeklyCoachPush } from './services/weekly-coach-push.js';
import { processCronMonitor } from './services/cron-monitor.js';
import { createLogger } from './services/logger.js';

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
    WEBHOOK_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
    API_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
  };
  Variables: {
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
    liffUser: { lineUserId: string; friendId: string };
  };
};

const app = new Hono<Env>();

// CORS — 許可オリジンを制限
app.use('*', cors({
  origin: (origin) => {
    const allowed = [
      'https://naturism-admin.pages.dev',
      'https://liff.line.me',
      'http://localhost:3001',
      'http://localhost:3000',
    ];
    if (!origin || allowed.includes(origin)) return origin || '*';
    // R2画像等の公開パスは全オリジン許可
    return origin;
  },
}));

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
app.route('/', shopifyPhase2a);
app.route('/', health);
app.route('/', automations);
app.route('/', richMenus);
app.route('/', trackedLinks);
app.route('/', forms);
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
app.route('/', tips);
app.route('/', ambassadors);
app.route('/', csvExport);
app.route('/', dashboard);
app.route('/', reminderMessages);
app.route('/', surveys);
app.route('/', shopifyAuth);
app.route('/', groups);
app.route('/', tagElapsedDeliveries);
app.route('/', liffCart);
app.route('/', birthdayCollection);
app.route('/', coachAdmin);

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

// Convenience redirect for /book path
app.get('/book', (c) => c.redirect('/?page=book'));

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
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/') || path === '/webhook' || path === '/docs' || path === '/openapi.json') {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  return c.notFound();
});

// Scheduled handler for cron triggers — runs for all active LINE accounts
async function scheduled(
  _event: ScheduledEvent,
  env: Env['Bindings'],
  _ctx: ExecutionContext,
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
  const jobs = [];
  for (const token of activeTokens) {
    const lineClient = new LineClient(token);
    jobs.push(
      processStepDeliveries(env.DB, lineClient, env.WORKER_URL),
      processScheduledBroadcasts(env.DB, lineClient, env.WORKER_URL),
      processReminderDeliveries(env.DB, lineClient),
      processScheduledAbTests(env.DB, lineClient, env.WORKER_URL),
      // Phase 1: processIntakeReminders は cron 停止 (能動pull化)
      processWeeklyReports(env.DB, lineClient),
      processSubscriptionReminders(env.DB, lineClient, env.LIFF_URL || ''),
      processAbandonedCartNotifications(env.DB, lineClient, env.LIFF_URL || ''),
      processTagElapsedDeliveries(env.DB, lineClient, env.WORKER_URL),
    );
  }
  jobs.push(checkAccountHealth(env.DB));
  jobs.push(refreshLineAccessTokens(env.DB));

  // Phase 3: 月次食事レポート (毎月 1 日のみ実行、サービス側で gating)
  jobs.push(
    processMonthlyFoodReports(env.DB, env.ANTHROPIC_API_KEY).then((r) => {
      if (r.generated > 0 || r.errors > 0) {
        console.info(
          `monthly food reports: generated=${r.generated} skipped=${r.skipped} errors=${r.errors}`,
        );
      }
    }),
  );

  // Phase 4 PR-5: 週次栄養コーチ push (火曜 10:00 JST のみ trigger、サービス側で gating)
  jobs.push(
    processWeeklyCoachPush(env).catch((err) => {
      console.error('weekly-coach-push failed', err instanceof Error ? err.name : 'unknown');
    }),
  );

  // Shopify顧客同期（5分ごと実行、冪等なので安全）
  jobs.push(
    syncShopifyCustomers(env.DB, env as unknown as Record<string, string | undefined>)
      .then((r) => {
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

  await Promise.allSettled(jobs);
}

export default {
  fetch: app.fetch,
  scheduled,
};
