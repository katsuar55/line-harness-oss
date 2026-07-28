/**
 * Shopify App Proxy 連携サービス層 (2026-07-29)
 *
 * 背景:
 *   属性/購買セグメント配信・会員ランク・サブスク管理はすべて friend↔customer 連携が律速
 *   (本番実測: 連携 10 人 / 顧客 3,434 人)。magic-link (#205) は「店舗が email を送る」プッシュ型で、
 *   本サービスは「顧客が Shopify にログインした時点で拾う」プル型 = 購入者は放っておいても連携が貯まる。
 *
 * フロー:
 *   ① 顧客が storefront の `/apps/line-link` を開く (LIFF マイアカウントのボタン or 任意の導線)
 *   ② Shopify App Proxy が worker `/proxy/line-link` へ転送 (署名 + logged_in_customer_id 付き)
 *   ③ 本サービスが署名/shop/timestamp を検証し、 ログイン済み顧客に短命 (10分) の
 *      sub_link_tokens (batch_id='app-proxy') を発行
 *   ④ `LIFF_URL?slk=<token>` へ送り返す → 以降は #205/#206 の preview/redeem 状態機械がそのまま動く
 *      (CAS single-use / UNIQUE partial index / 確認カード / 世代カウンタ、 すべて再利用)
 *
 * セキュリティ (= なぜこの方向は安全か):
 *   - token は「ログイン中の顧客本人のブラウザ」でだけ発行され、 その場で本人の LINE へ redirect される。
 *     攻撃者が被害者の customer に紐づく token を得るには、 被害者の署名済み URL (90秒窓) か
 *     被害者のブラウザそのものが必要 = login-CSRF/fixation で被害者の購買データを奪う経路が構造的に無い。
 *   - 逆方向 (攻撃者が自分の customer token を被害者に踏ませる) は、 被害者側 LIFF の確認カードに
 *     連携先プランが表示され、 かつ晒されるのは攻撃者自身のデータ = 動機が立たない。
 *   - gate APP_PROXY_LINK_ENABLED='true' でなければ 404 (= 本番 dormant・存在を露出しない)。
 *
 * 関連: services/sub-link.ts (redeem 側)、 routes/app-proxy.ts (HTML 応答)、
 *       utils/shopify-app-proxy.ts (署名検証)
 */

import {
  insertSubLinkToken,
  deleteUnconsumedSubLinkTokensForCustomerBatch,
  getFriendByShopifyCustomerId,
  jstNow,
  toJstString,
} from '@line-crm/db';
import { verifyAppProxySignature } from '../utils/shopify-app-proxy.js';
import { APP_PROXY_BATCH_ID } from './sub-link.js';
import { auditSystem } from './audit-logger.js';

export { APP_PROXY_BATCH_ID };

/**
 * App Proxy 発行トークンの TTL (分)。
 * その場で LIFF へ遷移する前提だが、 新規顧客は「友だち追加 → webhook 反映待ち」を挟むため
 * 短すぎると LIFF 側のリトライ中に失効する。 stash TTL (30分) に合わせる。
 */
export const APP_PROXY_TOKEN_TTL_MIN = 30;

/** storefront 側の proxy prefix (Dev Dashboard の App Proxy 設定と一致させる)。 */
export const APP_PROXY_PATH_PREFIX = '/apps/line-link';

interface EnvLike {
  DB: D1Database;
  LIFF_URL?: string;
  APP_PROXY_LINK_ENABLED?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_STORE_DOMAIN?: string;
}

export function isAppProxyLinkEnabled(env: Pick<EnvLike, 'APP_PROXY_LINK_ENABLED'>): boolean {
  return (env.APP_PROXY_LINK_ENABLED ?? '') === 'true';
}

export type AppProxyEntryResult =
  | { ok: false; code: 'disabled' }
  | { ok: false; code: 'misconfigured' }
  | { ok: false; code: 'unauthorized'; reason: string }
  | { ok: true; state: 'login_required' }
  | { ok: true; state: 'already_linked' }
  /** Shopify にはいるが local shopify_customers に未同期 (= 確認材料を出せないので連携させない) */
  | { ok: true; state: 'sync_pending' }
  | { ok: true; state: 'ready'; redirectUrl: string };

/** 160bit crypto ランダム base64url (= sub-link と同形式の推測不能 token)。 */
function generateLinkToken(): string {
  const buf = new Uint8Array(20);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * App Proxy 転送リクエストを検証し、 ログイン済み顧客へ短命連携トークンを発行する。
 *
 * 判定順序:
 *   gate → 設定 → 署名 (+timestamp) → shop 一致 → ログイン有無 → 既連携 → token 発行
 *   (署名より先に gate = dormant 時は検証コストも情報露出もゼロ)
 */
export async function handleAppProxyLinkEntry(
  env: EnvLike,
  query: URLSearchParams,
  nowMs: number = Date.now(),
): Promise<AppProxyEntryResult> {
  if (!isAppProxyLinkEnabled(env)) return { ok: false, code: 'disabled' };

  const secret = (env.SHOPIFY_CLIENT_SECRET ?? '').trim();
  const liffUrl = (env.LIFF_URL ?? '').trim();
  if (!secret || !liffUrl) return { ok: false, code: 'misconfigured' };

  const verdict = await verifyAppProxySignature(query, secret, nowMs, APP_PROXY_PATH_PREFIX);
  if (!verdict.ok) return { ok: false, code: 'unauthorized', reason: verdict.reason };

  // shop 一致は **必須** (= 他ストアにインストールされた同一 app からの署名済みリクエストを拒否)。
  // App Proxy 署名は app の client secret で計算されるため、 同一 app を別ストアに入れると
  // そちらからの転送も署名検証を通る。 未設定時に skip すると、 ストア B の customer id が
  // ストア A の同 id と同一人物として紐付き、 別人の購買履歴が LINE に開示される。
  // secret 欠落と同じく「無言 skip」ではなく misconfigured で止める。
  const expectedShop = (env.SHOPIFY_STORE_DOMAIN ?? '').trim().toLowerCase();
  if (!expectedShop) return { ok: false, code: 'misconfigured' };
  const shop = (query.get('shop') ?? '').trim().toLowerCase();
  if (shop !== expectedShop) {
    return { ok: false, code: 'unauthorized', reason: 'shop_mismatch' };
  }

  const customerId = (query.get('logged_in_customer_id') ?? '').trim();
  if (!customerId) return { ok: true, state: 'login_required' };
  // Shopify の customer id は数値文字列。 形式外は署名済みでも token 化しない (深層防御)。
  if (!/^\d{1,32}$/.test(customerId)) {
    return { ok: false, code: 'unauthorized', reason: 'bad_customer_id' };
  }

  // 既にどれかの friend と連携済みなら token を発行しない
  // (redeem 側の taken 検査と同じ述語 = getFriendByShopifyCustomerId は following を問わない)。
  const existing = await getFriendByShopifyCustomerId(env.DB, customerId);
  if (existing) return { ok: true, state: 'already_linked' };

  // local の shopify_customers に行が無い顧客 (webhook 未達 / 作成直後の race) は ready にしない。
  // ready にすると preview が plan=null かつ **hint=null** を返し、 確認カードから
  // 「連携先: h***@e***.com」と警告文が無音で消える = link fixation の唯一の人間確認点が失われる。
  // さらに backlink も 0 行更新で永久に欠損する。
  const known = await env.DB.prepare(`SELECT 1 AS ok FROM shopify_customers WHERE shopify_customer_id = ?`)
    .bind(customerId)
    .first<{ ok: number }>();
  if (!known) return { ok: true, state: 'sync_pending' };

  // 未消費・未失効の自分の app-proxy token が既にあれば再利用する
  // (= 連打しても DELETE+INSERT を繰り返さない。 併せて「開いたままの前のページ」も生き続ける)。
  const reusable = await findReusableAppProxyToken(env.DB, customerId, toJstString(new Date(nowMs)));
  if (reusable) return { ok: true, state: 'ready', redirectUrl: `${liffUrl}?slk=${reusable}` };

  // 失効した自分の app-proxy token だけ掃除 (= magic-link キャンペーンの 30日 link は殺さない)
  await deleteUnconsumedSubLinkTokensForCustomerBatch(env.DB, customerId, APP_PROXY_BATCH_ID);

  const token = generateLinkToken();
  await insertSubLinkToken(env.DB, {
    token,
    shopifyCustomerId: customerId,
    batchId: APP_PROXY_BATCH_ID,
    expiresAt: toJstString(new Date(nowMs + APP_PROXY_TOKEN_TTL_MIN * 60_000)),
    createdAt: jstNow(),
  });

  // 監査: 「どの customer にいつ連携 capability を発行したか」。 redeem 側だけ記録していると、
  // 乗っ取りの疑いが出たときに「発行が正規ログイン由来か注入由来か」を事後に切り分けられない。
  await auditSystem(env.DB, {
    action: 'account_link.app_proxy_token_issued',
    targetType: 'shopify_customer',
    targetId: customerId,
    result: 'success',
    metadata: { shop },
  });

  return { ok: true, state: 'ready', redirectUrl: `${liffUrl}?slk=${token}` };
}

/** 未消費・未失効の app-proxy token を 1 件返す (= 再訪問時の再利用)。 */
async function findReusableAppProxyToken(
  db: D1Database,
  shopifyCustomerId: string,
  now: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT token FROM sub_link_tokens
        WHERE shopify_customer_id = ? AND batch_id = ? AND consumed_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(shopifyCustomerId, APP_PROXY_BATCH_ID, now)
    .first<{ token: string }>();
  return row?.token ?? null;
}
