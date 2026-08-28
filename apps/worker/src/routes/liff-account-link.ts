/**
 * LIFF Account Link Route (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 *
 * 役割:
 *   - POST /api/liff/link/request-code — friend が入力した email に 6桁 OTP を送る
 *   - POST /api/liff/link/verify-code  — OTP 検証 → email の Shopify customer を friend に紐付け
 *   - POST /api/liff/link/unlink       — 連携解除 (本人のみ・冪等・2026-08-28)
 *
 * 認証:
 *   - liffAuthMiddleware で LINE idToken 検証済 (= c.get('liffUser') から friendId/lineUserId 取得)。
 *     idToken 検証はミドルウェアが担保するため、 本 route は client 申告の id を信用しない。
 *
 * ガード:
 *   - ACCOUNT_LINK_ENABLED='true' でなければ service が disabled を返し、 本 route は 404 で inert に見せる
 *     (= 本番未稼働。 endpoint の存在を露出しない)。
 *
 * 関連: services/account-link.ts、 routes/liff-opt-in.ts (= 同 LIFF POST パターン)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  requestAccountLinkCode,
  verifyAccountLinkCode,
  type RequestCodeFailure,
  type VerifyCodeFailure,
} from '../services/account-link.js';
import type { Env } from '../index.js';
import { issueLinkRewardCoupon } from '../services/link-reward-coupon-issuer.js';
import { unlinkAccount } from '../services/account-unlink.js';
import { backfillCustomerOrders } from '../services/member-purchase-backfill.js';
import { getShopifyAccessToken } from '../services/shopify-token.js';

/**
 * OTP 連携後のインライン backfill のページ上限。sub-link (redeem) の
 * REDEEM_BACKFILL_MAX_PAGES と同じ値・同じ理由: 予算の支配項は fetch でなく
 * 注文ごとの addPurchaseEvent (~5 D1/新規適用) なので、ページ側の無駄を抑えるだけの値。
 * 完遂は member-backfill-sweep cron が保証する。
 */
const OTP_BACKFILL_MAX_PAGES = 2;

const liffAccountLink = new Hono<Env>();

function getLiffUser(c: { get: (key: string) => unknown }) {
  return c.get('liffUser') as { lineUserId: string; friendId: string } | undefined;
}

const RequestSchema = z.object({
  email: z.string().email().max(254),
});

const VerifySchema = z.object({
  email: z.string().email().max(254),
  // OTP は 6桁数字。 長さ上限は念のため緩めに取り service 側で厳密判定。
  code: z.string().min(1).max(12),
});

// ============================================================
// 失敗 → HTTP マッピング (= UI が message をそのまま表示できるよう日本語も返す)
//   Record<Failure, ...> で全 failure code の網羅性を型で保証する。
//   `m.status as never` は Hono の c.json status overload が literal numeric のみ受ける制約の回避
//   (= status は number 型なので literal に絞れない。 値は上の Record で固定済のため安全。 他 route と同パターン)。
// ============================================================

const REQUEST_FAILURE: Record<RequestCodeFailure, { status: number; message: string }> = {
  disabled: { status: 404, message: 'お探しのページは見つかりませんでした。' },
  misconfigured: { status: 503, message: 'ただいま連携機能を準備中です。 時間をおいてお試しください。' },
  invalid_email: { status: 400, message: 'メールアドレスの形式が正しくありません。' },
  already_linked: { status: 409, message: 'このアカウントはすでに連携済みです。' },
  rate_limited: { status: 429, message: '確認コードの送信回数が上限に達しました。 しばらくしてからお試しください。' },
  email_failed: { status: 502, message: '確認コードの送信に失敗しました。 もう一度お試しください。' },
};

const VERIFY_FAILURE: Record<VerifyCodeFailure, { status: number; message: string }> = {
  disabled: { status: 404, message: 'お探しのページは見つかりませんでした。' },
  misconfigured: { status: 503, message: 'ただいま連携機能を準備中です。 時間をおいてお試しください。' },
  invalid_email: { status: 400, message: 'メールアドレスの形式が正しくありません。' },
  invalid_code: { status: 400, message: '確認コードが正しくありません。' },
  already_linked: { status: 409, message: 'このアカウントはすでに連携済みです。' },
  no_code: { status: 400, message: '確認コードの有効期限が切れています。 もう一度送信してください。' },
  locked: { status: 429, message: '試行回数の上限に達しました。 もう一度コードを送信してください。' },
  customer_not_found: { status: 404, message: 'このメールアドレスのアカウントが見つかりませんでした。 ご購入時・ご登録時のメールアドレスをご確認ください。' },
  customer_conflict: { status: 409, message: 'このご注文アカウントは別の LINE と連携済みです。' },
  shopify_error: { status: 502, message: '連携処理でエラーが発生しました。 もう一度お試しください。' },
};

// ============================================================
// POST /api/liff/link/request-code
// ============================================================

liffAccountLink.post('/api/liff/link/request-code', async (c) => {
  const user = getLiffUser(c);
  if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }

  const result = await requestAccountLinkCode(c.env, {
    friendId: user.friendId,
    lineUserId: user.lineUserId,
    email: parsed.data.email,
  });

  if (result.ok) {
    return c.json({ success: true, data: { sent: true } });
  }
  const m = REQUEST_FAILURE[result.code];
  return c.json({ success: false, error: result.code, message: m.message }, m.status as never);
});

// ============================================================
// POST /api/liff/link/verify-code
// ============================================================

liffAccountLink.post('/api/liff/link/verify-code', async (c) => {
  const user = getLiffUser(c);
  if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }
  const parsed = VerifySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }

  // 🚨 backfill は service にやらせない (deferBackfillToCaller)。同一 invocation の
  //    subrequest 予算をクーポン発行と食い合い、注文の多い顧客ほど確実に ¥300 が無言で消える。
  //    下でクーポン発行の**後**に直列化する (sub-link の redeem 経路と同じ形)。
  const result = await verifyAccountLinkCode(
    c.env,
    {
      friendId: user.friendId,
      lineUserId: user.lineUserId,
      email: parsed.data.email,
      code: parsed.data.code,
    },
    { deferBackfillToCaller: true },
  );

  if (result.ok) {
    // 連携特典クーポン (Sprint A-1): OTP 連携の成立時に発行。verifyAccountLinkCode の
    // ok=true は新規 link 成立のみ (already_linked は failure code) なので常に対象。
    // 台帳 UNIQUE(friend_id) が生涯 1 枚を保証。応答は待たせない (waitUntil)。
    const issueP = issueLinkRewardCoupon(c.env.DB, c.env, {
      friendId: user.friendId,
      shopifyCustomerId: result.customerId,
      linkPath: 'email_otp',
    }).catch((err) =>
      console.error(
        '[account-link] link reward issue failed:',
        err instanceof Error ? err.message : 'unknown',
      ),
    );
    try { c.executionCtx.waitUntil(issueP); } catch { /* no exec ctx in tests */ }

    // 過去注文 backfill を**クーポン発行の後**に直列化する (2026-08-28)。
    //   - 顧客可視の報酬 (¥300) を先に確定させ、backfill は残り予算での第一走に徹する。
    //   - issueP は上で .catch 済み = 常に resolve する (発行失敗でも backfill は走らせる)。
    //   - gate は backfillCustomerOrders 側でも二重判定するが、off のとき token 取得の
    //     subrequest すら使わないようここでも先に判定する。
    //   - 予算切れで途中死しても member-backfill-sweep cron (5 分毎・冪等) が収束させる。
    const envRecord = c.env as unknown as Record<string, string | undefined>;
    if (envRecord.MEMBER_BACKFILL_ENABLED === 'true') {
      const friendId = user.friendId;
      const customerId = result.customerId;
      const backfillP = issueP
        .then(async () => {
          const accessToken = await getShopifyAccessToken(c.env.DB, envRecord);
          await backfillCustomerOrders(
            c.env.DB,
            {
              SHOPIFY_STORE_DOMAIN: envRecord.SHOPIFY_STORE_DOMAIN,
              MEMBER_BACKFILL_ENABLED: envRecord.MEMBER_BACKFILL_ENABLED,
            },
            { customerId, friendId, accessToken, maxPages: OTP_BACKFILL_MAX_PAGES },
          );
        })
        .catch((err) =>
          console.error(
            '[account-link] purchase backfill failed:',
            err instanceof Error ? err.message : 'unknown',
          ),
        );
      try { c.executionCtx.waitUntil(backfillP); } catch { /* no exec ctx in tests */ }
    }

    return c.json({
      success: true,
      data: {
        linked: true,
        customerId: result.customerId,
        // backfill は上で waitUntil に載せた = 応答時点では未完了。0 固定にせず
        // service の戻り (defer 時は常に 0) をそのまま返すと「0 件反映」の誤読を生むため、
        // 「応答後に走る」ことが分かる null を返す。
        backfilled: null,
        metafieldWritten: result.metafieldWritten,
      },
    });
  }
  const m = VERIFY_FAILURE[result.code];
  return c.json(
    {
      success: false,
      error: result.code,
      message: m.message,
      ...(result.attemptsRemaining !== undefined ? { attemptsRemaining: result.attemptsRemaining } : {}),
    },
    m.status as never,
  );
});

// ============================================================
// POST /api/liff/link/unlink — 顧客自身による連携解除
// ============================================================
//
// なぜ顧客に開くか: 誤連携 (家族共有のメール / 旧メール) を本人が直せないと、
// 他人の購買履歴が見え続ける。サポートに回しても運用側に押せるボタンが無かった。
// 個人情報保護法の「利用の停止」請求にプライバシーポリシーで応じると明記しているのに
// 応じる手段が無い、という状態も解消する。
//
// gate: 連携の受付 (ACCOUNT_LINK_ENABLED) とは **独立して常に開ける**。
//   受付を止めた後に「解除だけできない」状態を作らないため (kill switch は一方通行にしない)。
//
// 冪等: 未連携なら unlinked:false を 200 で返す (= 二度押しでエラーを出さない)。

liffAccountLink.post('/api/liff/link/unlink', async (c) => {
  const user = getLiffUser(c);
  if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

  try {
    // friendId は middleware が idToken から解決したものだけを使う (client 申告は信用しない)
    const outcome = await unlinkAccount(c.env as unknown as Parameters<typeof unlinkAccount>[0], {
      friendId: user.friendId,
      actor: 'customer',
    });
    return c.json({
      success: true,
      data: { unlinked: outcome.unlinked },
      message: outcome.unlinked
        ? 'オンラインストアとの連携を解除しました。'
        : 'このLINEアカウントは、現在ストアと連携されていません。',
    });
  } catch (err) {
    console.error('POST /api/liff/link/unlink error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { liffAccountLink };
