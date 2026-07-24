/**
 * Phase 3 自社課金基盤 — Shopify サブスク webhook 受信口 (WI-4 step 3)
 * 設計の正: docs/PHASE3_BILLING_DESIGN_2026-07-19.md §6 (webhook・失敗処理) / §8 (gate)
 *
 * 受信 topic (X-Shopify-Topic):
 *   subscription_billing_attempts/{success,failure,challenged}
 *   subscription_contracts/{activate,pause,cancel,update,fail,expire}
 *   subscription_billing_cycles/{skip,unskip}
 *   customer_payment_methods/{create,update}
 *
 * ## セキュリティ
 * - HMAC-SHA256 (X-Shopify-Hmac-Sha256) を既存 utils で検証。**署名不正は 401**。
 * - authMiddleware の skip-list には **POST 限定**で登録する
 *   ([[feedback_auth_skiplist_method_independent]]: path-only skip は全 method を素通しさせる)。
 *
 * ## live-safety
 * - own_sub_contracts に存在しない契約 (= 現状すべて) は unknown_contract で即帰る。
 *   本番に own 契約が 0 件である限り、本 route はいかなる状態も変更しない。
 * - Shopify を mutate する経路は canIssueAttempt() (§8) を必ず通す。gate OFF でも
 *   「受信・同期・結果回収」は継続する (§8 の表)。
 * - 例外は握って **200 を返す** — Shopify の webhook 再送ストームを誘発させないため。
 *   失敗は alert + webhook ログに残す。
 */
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { verifyShopifySignature } from '../utils/shopify-hmac.js';
import { canIssueAttempt, readStaticGates, readD1Gates } from '../services/own-billing.js';
import { routeBillingWebhook, type BillingWebhookDeps } from '../services/own-billing-webhooks.js';
import { createShopifyBillingAdapter } from '../services/own-billing-shopify-adapter.js';
import { getShopifyAccessToken } from '../services/shopify-token.js';

export const ownBillingWebhook = new Hono<Env>();

/** Discord alert の timeout。webhook のリクエストパス上なので短く切る */
const ALERT_TIMEOUT_MS = 3_000;

export const OWN_BILLING_WEBHOOK_PATH = '/api/integrations/shopify/webhook/subscription';

/** 本 route が処理する topic の接頭辞 (これ以外は noop で 200) */
export const HANDLED_TOPIC_PREFIXES = [
  'subscription_billing_attempts/',
  'subscription_contracts/',
  'subscription_billing_cycles/',
  'customer_payment_methods/',
];

ownBillingWebhook.post(OWN_BILLING_WEBHOOK_PATH, async (c) => {
  const env = c.env;
  const signingSecret = env.SHOPIFY_WEBHOOK_SECRET || env.SHOPIFY_CLIENT_SECRET;
  if (!signingSecret) {
    // シークレット未設定で受け入れると誰でも課金状態を書き換えられる。必ず拒否する。
    console.error('own-billing webhook rejected: no signing secret configured');
    return c.json({ success: false, error: 'not configured' }, 401);
  }

  const rawBody = await c.req.text();
  const hmacHeader = c.req.header('X-Shopify-Hmac-Sha256') ?? '';
  const valid = await verifyShopifySignature(signingSecret, rawBody, hmacHeader);
  if (!valid) {
    return c.json({ success: false, error: 'signature verification failed' }, 401);
  }

  // 署名鍵はアプリ単位なので、鍵が一致しても別ストア宛の配信を受け取りうる。
  // ストアが判っているときは shop domain も突き合わせる (多層防御)。
  const shopDomain = (c.req.header('X-Shopify-Shop-Domain') ?? '').trim().toLowerCase();
  if (env.SHOPIFY_STORE_DOMAIN && shopDomain && shopDomain !== env.SHOPIFY_STORE_DOMAIN.toLowerCase()) {
    console.error(`own-billing webhook rejected: unexpected shop domain ${shopDomain}`);
    return c.json({ success: false, error: 'unexpected shop' }, 401);
  }

  const topic = (c.req.header('X-Shopify-Topic') ?? '').trim();
  if (!HANDLED_TOPIC_PREFIXES.some((p) => topic.toLowerCase().startsWith(p))) {
    // 想定外 topic は受理だけして無視 (Shopify に再送させない)
    return c.json({ success: true, data: { outcome: 'unhandled_topic' } });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // 署名は通っているので本文異常は 200 で飲む (再送されても直らない)
    return c.json({ success: true, data: { outcome: 'invalid_body' } });
  }

  const alert = async (message: string): Promise<void> => {
    console.error(message);
    if (!env.DISCORD_WEBHOOK_URL) return;
    // 公開 webhook のリクエストパス上なので **必ず timeout を付ける** (repo 方針 #123)。
    // Discord が無応答だと Shopify 側がタイムアウトして再送ストームになる。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
    try {
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Discord の 2000 文字制限内に収める (message は code/gid のみで PII を含まない)
        body: JSON.stringify({ content: `[own-billing] ${message}`.slice(0, 1900) }),
        signal: controller.signal,
      });
    } catch {
      /* 通知先障害・timeout で webhook 処理を落とさない */
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // §8 gate: tick と同じ完全定義で評価する (発行系のみを止め、記録は続ける)
    const statics = readStaticGates(env);
    const d1 = await readD1Gates(env.DB);
    const canIssue = (contractGid: string): boolean =>
      d1.error === undefined && canIssueAttempt(statics, d1, contractGid);

    const deps: BillingWebhookDeps = {
      db: env.DB,
      canIssue,
      alert,
      nowMs: Date.now(),
    };
    // adapter は認証情報が揃っているときだけ注入する。未注入でも記録系は動く。
    // own 契約が 1 件も無い間は adapter を作らない (採点 R1 LOW): buildAdapter は D1 読み +
    // token 期限切れなら Shopify への subrequest を伴うため、契約 0 件の現在は
    // webhook 1 本ごとに無駄な往復が発生してしまう。
    const anyContract = await env.DB.prepare(
      `SELECT 1 AS x FROM own_sub_contracts LIMIT 1`,
    ).first<{ x: number }>();
    if (anyContract) {
      const api = await buildAdapter(env.DB, env);
      if (api) deps.api = api;
    }

    const outcome = await routeBillingWebhook(deps, topic, body);
    return c.json({ success: true, data: { outcome } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await alert(`own-billing webhook (${topic}) の処理に失敗: ${msg}`);
    // 200 を返して再送ストームを避ける (欠損は §5.3 reconciliation / §8 突合が回収する)
    return c.json({ success: true, data: { outcome: 'error' } });
  }
});

/**
 * Shopify 認証情報が揃っているときだけ adapter を作る。
 * 作れなくても throw しない — webhook の記録系 (claim/契約の状態反映) は API 非依存で動くため、
 * 「token が取れないから状態も更新しない」という最悪の縮退を避ける。
 */
export async function buildAdapter(
  db: D1Database,
  env: Pick<
    Env['Bindings'],
    'SHOPIFY_STORE_DOMAIN' | 'SHOPIFY_CLIENT_ID' | 'SHOPIFY_CLIENT_SECRET'
  >,
): Promise<ReturnType<typeof createShopifyBillingAdapter> | null> {
  if (!env.SHOPIFY_STORE_DOMAIN) return null;
  try {
    const accessToken = await getShopifyAccessToken(db, env);
    if (!accessToken) return null;
    return createShopifyBillingAdapter({
      storeDomain: env.SHOPIFY_STORE_DOMAIN,
      accessToken,
    });
  } catch {
    return null;
  }
}
