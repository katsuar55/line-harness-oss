/**
 * Account Link service (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 *
 * 役割:
 *   CRM PLUS on LINE / Social PLUS に依存せず、 LINE ハーネス単体で friend↔Shopify customer を連携する
 *   「LIFF + email OTP 本人確認」 フローのオーケストレーション。 2 つの操作:
 *     1. requestAccountLinkCode: friend が入力した email に 6桁 OTP を送る (= email 所有の確認準備)。
 *     2. verifyAccountLinkCode: OTP 検証 → email の Shopify customer を引き当て → friend に紐付け
 *        + 自前 metafield 書込 (best-effort) + 過去注文 backfill (gated, best-effort)。
 *
 * セキュリティ (= 3 要素で乗っ取り防止):
 *   ① LINE 本人性: idToken 検証は liffAuthMiddleware が担保 (= caller が friendId/lineUserId を渡す)。
 *   ② email 所有: OTP を email に送り、 入力された OTP の一致で証明。
 *   ③ email→customer: Shopify customers(email) で email から customer を引く。
 *   → 「自分の LINE」 ×「自分が受信できる email」 ×「その email の customer」 が揃って初めて link。
 *   - OTP は HMAC(pepper, friend:email:code) で hash 保存 (= 平文非保存)、 短 TTL、 試行回数 lock、 request rate-limit、 single-use。
 *   - email enumeration 防止: 「customer の有無」 は OTP 検証後 (= email 所有証明後) にしか判明しない
 *     (= request 時は customer 有無に関わらず送る)。 → 他人の email を総当たりして customer 在否を探れない。
 *   - ambiguous / 別 friend に既 link の customer は reject (= customer_conflict)。
 *
 * ⚠️ 本番ガード: ACCOUNT_LINK_ENABLED='true' + ACCOUNT_LINK_HMAC_KEY 設定済でなければ no-op (= disabled)。
 *   default off = 本番未稼働。 backfill は MEMBER_BACKFILL_ENABLED の別 gate (= money path)。
 *
 * 関連:
 *   - apps/worker/src/routes/liff-account-link.ts (= 2 endpoints)
 *   - apps/worker/src/services/account-link-shopify.ts (= findShopifyCustomerByEmail / setCustomerLineUserIdMetafield)
 *   - apps/worker/src/services/member-purchase-backfill.ts (= backfillCustomerOrders、 gated)
 *   - packages/db/src/account-link.ts (= OTP テーブル CRUD)
 */
import {
  getFriendById,
  getFriendByShopifyCustomerId,
  setFriendShopifyCustomerId,
  linkShopifyCustomerToFriend,
  insertAccountLinkCode,
  invalidatePriorAccountLinkCodes,
  countRecentAccountLinkCodes,
  getActiveAccountLinkCode,
  incrementAccountLinkAttempts,
  consumeAccountLinkCode,
} from '@line-crm/db';
import { ResendClient, type EmailMessage } from '@line-crm/email-sdk';
import { getShopifyAccessToken } from './shopify-token.js';
import { findShopifyCustomerByEmail, setCustomerLineUserIdMetafield } from './account-link-shopify.js';
import { backfillCustomerOrders } from './member-purchase-backfill.js';
import { auditSystem } from './audit-logger.js';
import { isValidEmail } from './email-opt-in.js';
import { hmacSha256Hex, constantTimeEqual, generateNumericCode } from './otp-crypto.js';

// ============================================================
// 定数 (= セキュリティ tunable、 コードで固定)
// ============================================================

/** OTP 有効期限 (秒)。 短 TTL で総当たり窓を狭める。 */
const CODE_TTL_SECONDS = 300; // 5 min
/** 1 code あたりの verify 試行上限 (= 超過で lock)。 6桁 OTP に対し 5/10^6 で online 総当たり不能。 */
const MAX_ATTEMPTS = 5;
/** 1 friend あたりの request 上限 (= email 爆撃防止)。 */
const MAX_REQUESTS_PER_HOUR = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const CODE_DIGITS = 6;
/** 自己所有マッピング metafield の default (= multi-brand は env で上書き)。 */
const DEFAULT_METAFIELD_NAMESPACE = 'naturism';
const DEFAULT_METAFIELD_KEY = 'line_user_id';

// ============================================================
// types
// ============================================================

export interface AccountLinkEnv {
  DB: D1Database;
  /** 'true' で本機能を有効化。 未設定/その他なら全 endpoint が disabled (= 本番未稼働)。 */
  ACCOUNT_LINK_ENABLED?: string;
  /** OTP hash の pepper (= server secret)。 有効化時は必須 (= 無ければ misconfigured)。 */
  ACCOUNT_LINK_HMAC_KEY?: string;
  /** 自己所有 metafield の namespace (default 'naturism')。 */
  ACCOUNT_LINK_METAFIELD_NAMESPACE?: string;
  /** 同 key (default 'line_user_id')。 */
  ACCOUNT_LINK_METAFIELD_KEY?: string;
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
  /** 'true' で link 成立後の過去注文 backfill を有効化 (= money path、 別 gate)。 */
  MEMBER_BACKFILL_ENABLED?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
}

export type RequestCodeFailure =
  | 'disabled'
  | 'misconfigured'
  | 'invalid_email'
  | 'already_linked'
  | 'rate_limited'
  | 'email_failed';

export type RequestCodeResult = { ok: true } | { ok: false; code: RequestCodeFailure };

export interface RequestCodeInput {
  friendId: string;
  lineUserId: string;
  email: string;
}

export interface RequestCodeDeps {
  now?: () => number;
  /** Resend 送信用 fetch (= test 注入)。 */
  fetchImpl?: typeof fetch;
  /** email 送信を注入 (= test。 default は Resend transactional)。 */
  sendEmailImpl?: (env: AccountLinkEnv, to: string, code: string, fetchImpl?: typeof fetch) => Promise<void>;
  /** OTP 生成を注入 (= test の決定性)。 */
  generateCodeImpl?: () => string;
}

export type VerifyCodeFailure =
  | 'disabled'
  | 'misconfigured'
  | 'invalid_email'
  | 'invalid_code'
  | 'already_linked'
  | 'no_code'
  | 'locked'
  | 'customer_not_found'
  | 'customer_conflict'
  | 'shopify_error';

export type VerifyCodeResult =
  | { ok: true; customerId: string; backfilled: number; metafieldWritten: boolean }
  | { ok: false; code: VerifyCodeFailure; attemptsRemaining?: number };

export interface VerifyCodeInput {
  friendId: string;
  lineUserId: string;
  email: string;
  code: string;
}

export interface VerifyCodeDeps {
  now?: () => number;
  fetchImpl?: typeof fetch;
  backfillImpl?: typeof backfillCustomerOrders;
  findCustomerImpl?: typeof findShopifyCustomerByEmail;
  setMetafieldImpl?: typeof setCustomerLineUserIdMetafield;
}

// ============================================================
// helpers
// ============================================================

function otpHash(pepper: string, friendId: string, emailLower: string, code: string): Promise<string> {
  return hmacSha256Hex(pepper, `${friendId}:${emailLower}:${code}`);
}

function otpEmailHtml(code: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"></head>
<body style="font-family:'Hiragino Sans',system-ui,sans-serif;color:#1a1a1a;line-height:1.7">
<p>naturism アカウント連携の確認コードです。</p>
<p style="font-size:32px;font-weight:800;letter-spacing:6px;margin:24px 0">${code}</p>
<p>LINE の連携画面にこのコードを入力してください。 有効期限は <strong>5分間</strong> です。</p>
<p style="color:#888;font-size:13px;margin-top:24px">このメールに心当たりがない場合は破棄してください。 コードを他人に教えないでください。</p>
</body></html>`;
}

function otpEmailText(code: string): string {
  return [
    'naturism アカウント連携の確認コードです。',
    '',
    `確認コード: ${code}`,
    '',
    'LINE の連携画面にこのコードを入力してください。 有効期限は5分間です。',
    'このメールに心当たりがない場合は破棄してください。 コードを他人に教えないでください。',
  ].join('\n');
}

/** OTP を transactional email として送る (= subscriber/consent ゲートを通さず、 入力 email へ直接)。 */
async function defaultSendOtpEmail(
  env: AccountLinkEnv,
  to: string,
  code: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const client = new ResendClient({ apiKey: env.RESEND_API_KEY ?? '', fetchImpl });
  const message: EmailMessage = {
    to,
    from: env.EMAIL_FROM ?? '',
    replyTo: env.EMAIL_REPLY_TO,
    subject: 'naturism アカウント連携の確認コード',
    html: otpEmailHtml(code),
    text: otpEmailText(code),
    category: 'transactional',
    sourceKind: 'transactional',
  };
  await client.send(message);
}

// ============================================================
// requestAccountLinkCode
// ============================================================

/**
 * friend が入力した email に 6桁 OTP を送る。
 * gate → email 形式 → 既 link → rate-limit → 旧 code 無効化 → 発行 → 送信。
 * customer の有無は確認しない (= enumeration 防止のため、 email 所有証明前に customer 在否を漏らさない)。
 */
export async function requestAccountLinkCode(
  env: AccountLinkEnv,
  input: RequestCodeInput,
  deps: RequestCodeDeps = {},
): Promise<RequestCodeResult> {
  if (env.ACCOUNT_LINK_ENABLED !== 'true') return { ok: false, code: 'disabled' };
  if (!env.ACCOUNT_LINK_HMAC_KEY) return { ok: false, code: 'misconfigured' };
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { ok: false, code: 'misconfigured' };

  const emailLower = input.email.trim().toLowerCase();
  if (!isValidEmail(emailLower)) return { ok: false, code: 'invalid_email' };

  // 既 link なら送らない (= 二重 link 防止 + 無駄送信防止)
  const friend = await getFriendById(env.DB, input.friendId);
  if (friend?.shopify_customer_id) return { ok: false, code: 'already_linked' };

  const nowMs = (deps.now ?? Date.now)();
  const sinceIso = new Date(nowMs - RATE_WINDOW_MS).toISOString();
  const recent = await countRecentAccountLinkCodes(env.DB, input.friendId, sinceIso);
  if (recent >= MAX_REQUESTS_PER_HOUR) return { ok: false, code: 'rate_limited' };

  const code = (deps.generateCodeImpl ?? (() => generateNumericCode(CODE_DIGITS)))();
  const hash = await otpHash(env.ACCOUNT_LINK_HMAC_KEY, input.friendId, emailLower, code);
  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + CODE_TTL_SECONDS * 1000).toISOString();

  // 旧 active code を無効化してから発行 (= 最新のみ有効、 attempts カウントの一貫性)
  await invalidatePriorAccountLinkCodes(env.DB, input.friendId, emailLower, nowIso);
  await insertAccountLinkCode(env.DB, {
    id: crypto.randomUUID(),
    friendId: input.friendId,
    email: emailLower,
    codeHash: hash,
    expiresAt: expiresIso,
    createdAt: nowIso,
  });

  // 送信 (= 発行後。 送信失敗は code 失効を待てばよい)
  try {
    const send = deps.sendEmailImpl ?? defaultSendOtpEmail;
    await send(env, emailLower, code, deps.fetchImpl);
  } catch (err) {
    console.warn('[account-link] OTP email send failed:', err instanceof Error ? err.message : 'unknown');
    return { ok: false, code: 'email_failed' };
  }

  // PII 最小化: audit に email を残さない (= friend_id で識別)
  await auditSystem(env.DB, {
    action: 'account_link.code_requested',
    targetType: 'friend',
    targetId: input.friendId,
    result: 'success',
  });
  return { ok: true };
}

// ============================================================
// verifyAccountLinkCode
// ============================================================

/**
 * OTP を検証し、 一致したら email の Shopify customer を friend に紐付ける。
 * gate → email/code 形式 → 既 link → active code 取得 → lock 判定 → 定数時間比較 →
 * access token → customer 引当 → (terminal outcome で single-use consume) → conflict 検査 → link →
 * metafield 書込 (best-effort) → backfill (gated, best-effort)。
 * consume は transient な Shopify 障害では行わず terminal outcome のみで行う (= 正コードを焼かない)。
 */
export async function verifyAccountLinkCode(
  env: AccountLinkEnv,
  input: VerifyCodeInput,
  deps: VerifyCodeDeps = {},
): Promise<VerifyCodeResult> {
  if (env.ACCOUNT_LINK_ENABLED !== 'true') return { ok: false, code: 'disabled' };
  if (!env.ACCOUNT_LINK_HMAC_KEY) return { ok: false, code: 'misconfigured' };
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    return { ok: false, code: 'misconfigured' };
  }

  const emailLower = input.email.trim().toLowerCase();
  if (!isValidEmail(emailLower)) return { ok: false, code: 'invalid_email' };
  if (!/^\d{6}$/.test(input.code)) return { ok: false, code: 'invalid_code' };

  const friend = await getFriendById(env.DB, input.friendId);
  if (friend?.shopify_customer_id) return { ok: false, code: 'already_linked' };

  const nowMs = (deps.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  const row = await getActiveAccountLinkCode(env.DB, input.friendId, emailLower, nowIso);
  if (!row) return { ok: false, code: 'no_code' }; // 未発行 / 失効 / 消費済
  // 防御: 試行上限に達した未消費 code (= 通常は下の誤コード経路で消費されるが念のため)。
  if (row.attempts >= MAX_ATTEMPTS) {
    await consumeAccountLinkCode(env.DB, row.id, nowIso);
    return { ok: false, code: 'locked' };
  }

  const expected = await otpHash(env.ACCOUNT_LINK_HMAC_KEY, input.friendId, emailLower, input.code);
  if (!constantTimeEqual(expected, row.code_hash)) {
    // 誤コードのみ atomic increment (= RETURNING で読み戻し race を排除)。 正コードの再試行は加算しない。
    const attempts = await incrementAccountLinkAttempts(env.DB, row.id);
    const remaining = Math.max(0, MAX_ATTEMPTS - attempts);
    if (remaining <= 0) {
      await consumeAccountLinkCode(env.DB, row.id, nowIso); // 上限到達 → lock (= 明確に locked を返す)
      return { ok: false, code: 'locked' };
    }
    return { ok: false, code: 'invalid_code', attemptsRemaining: remaining };
  }

  // ─── 一致 ─── code の消費は terminal outcome まで遅延する。
  // 理由: transient な Shopify 障害 (token 取得失敗 / 引当 throw) で正コードを焼かない (= 同 code で再試行可)。
  // 並行する 2 つの正コード verify は、 下の setFriendShopifyCustomerId の CAS (shopify_customer_id IS NULL)
  // が単一 link を保証するため、 早期消費なしでも二重 link は起きない。
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);

  let accessToken: string;
  try {
    accessToken = await getShopifyAccessToken(env.DB, env);
  } catch (err) {
    // transient: consume せず (= 同 code で再試行可)
    console.error('[account-link] access token unavailable:', err instanceof Error ? err.message : 'unknown');
    return { ok: false, code: 'shopify_error' };
  }

  const findCustomer = deps.findCustomerImpl ?? findShopifyCustomerByEmail;
  let found: { customerId: string } | null;
  try {
    found = await findCustomer(env.SHOPIFY_STORE_DOMAIN, accessToken, emailLower, fetchImpl);
  } catch (err) {
    // transient: consume せず (= 同 code で再試行可)
    console.error('[account-link] customer lookup failed:', err instanceof Error ? err.message : 'unknown');
    return { ok: false, code: 'shopify_error' };
  }

  // ─── 以降は terminal outcome → 必ず code を消費 (= single-use 確定) ───
  if (!found) {
    await consumeAccountLinkCode(env.DB, row.id, nowIso);
    return { ok: false, code: 'customer_not_found' };
  }

  // 同 customer が別 friend に既 link → conflict (= 事前検査 + UNIQUE 制約の二重防御)
  const owner = await getFriendByShopifyCustomerId(env.DB, found.customerId);
  if (owner && owner.id !== input.friendId) {
    await consumeAccountLinkCode(env.DB, row.id, nowIso);
    await auditSystem(env.DB, {
      action: 'account_link.conflict',
      targetType: 'friend',
      targetId: input.friendId,
      result: 'failure',
      metadata: { shopifyCustomerId: found.customerId, conflictFriendId: owner.id },
    });
    return { ok: false, code: 'customer_conflict' };
  }

  let linked = false;
  try {
    const r = await setFriendShopifyCustomerId(env.DB, input.friendId, found.customerId);
    linked = r.linked;
  } catch {
    // UNIQUE 違反 (= 事前検査と set の間に別 friend が link した競合) → conflict
    await consumeAccountLinkCode(env.DB, row.id, nowIso);
    return { ok: false, code: 'customer_conflict' };
  }
  // link 試行は確定 (= success / already_linked いずれも terminal) → 消費
  await consumeAccountLinkCode(env.DB, row.id, nowIso);
  if (!linked) return { ok: false, code: 'already_linked' }; // 並行 link 済 (= 競合)

  // 🚨 逆方向リンク (= customer 起点の denormalized 列を埋める)。
  //   これが無いと friends.shopify_customer_id は入るのに shopify_orders.friend_id が NULL のままになり、
  //   注文一覧 (routes/liff-portal.ts の `WHERE friend_id = ?`) と配送追跡が **0 件のまま**になる。
  //   = 顧客には「連携したのに何も変わらない」と見える。ホームの連携 CTA は
  //   「ご注文の状況確認や、過去のご注文からの再注文もこの画面でできるようになります」と
  //   約束しているので、これを呼ばないと約束が嘘になる (2026-08-28 修正)。
  //   slk 経路 (services/sub-link.ts の backlink) は最初から呼んでいた = OTP 経路だけの欠落だった。
  //   best-effort: 失敗しても連携本体 (friends 側 = 真実源) は成立済みなので verify を落とさない。
  try {
    await linkShopifyCustomerToFriend(env.DB, found.customerId, input.friendId);
  } catch (err) {
    console.warn('[account-link] customer backlink failed (non-fatal):', err instanceof Error ? err.message : 'unknown');
  }

  // 自前 metafield 書込 (= best-effort、 失敗しても link は成立)
  let metafieldWritten = false;
  const ns = env.ACCOUNT_LINK_METAFIELD_NAMESPACE || DEFAULT_METAFIELD_NAMESPACE;
  const key = env.ACCOUNT_LINK_METAFIELD_KEY || DEFAULT_METAFIELD_KEY;
  const setMetafield = deps.setMetafieldImpl ?? setCustomerLineUserIdMetafield;
  try {
    const mf = await setMetafield(env.SHOPIFY_STORE_DOMAIN, accessToken, found.customerId, ns, key, input.lineUserId, fetchImpl);
    metafieldWritten = mf.ok;
    if (!mf.ok) console.warn('[account-link] metafield userErrors:', mf.userErrors.join('; '));
  } catch (err) {
    console.warn('[account-link] metafield write failed:', err instanceof Error ? err.message : 'unknown');
  }

  // 過去注文 backfill (= gated MEMBER_BACKFILL_ENABLED、 best-effort、 link を壊さない)
  let backfilled = 0;
  const backfill = deps.backfillImpl ?? backfillCustomerOrders;
  try {
    const bf = await backfill(env.DB, env, {
      customerId: found.customerId,
      friendId: input.friendId,
      accessToken,
      fetchImpl,
    });
    backfilled = bf.backfilled;
  } catch (err) {
    console.error('[account-link] backfill failed:', err instanceof Error ? err.message : 'unknown');
  }

  await auditSystem(env.DB, {
    action: 'account_link.linked',
    targetType: 'friend',
    targetId: input.friendId,
    result: 'success',
    // PII 最小化: email を残さない (= shopifyCustomerId で識別十分)
    metadata: { shopifyCustomerId: found.customerId, matchedBy: 'email_otp', backfilled, metafieldWritten },
  });

  return { ok: true, customerId: found.customerId, backfilled, metafieldWritten };
}

// ============================================================
// test 用 export
// ============================================================

export const __test__ = {
  CODE_TTL_SECONDS,
  MAX_ATTEMPTS,
  MAX_REQUESTS_PER_HOUR,
  CODE_DIGITS,
  DEFAULT_METAFIELD_NAMESPACE,
  DEFAULT_METAFIELD_KEY,
  otpHash,
};
