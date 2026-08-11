/**
 * LIFF Account Link Route (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 *
 * 役割:
 *   - POST /api/liff/link/request-code — friend が入力した email に 6桁 OTP を送る
 *   - POST /api/liff/link/verify-code  — OTP 検証 → email の Shopify customer を friend に紐付け
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
  customer_not_found: { status: 404, message: 'このメールアドレスのご注文が見つかりませんでした。 ご購入時のメールアドレスをご確認ください。' },
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

  const result = await verifyAccountLinkCode(c.env, {
    friendId: user.friendId,
    lineUserId: user.lineUserId,
    email: parsed.data.email,
    code: parsed.data.code,
  });

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
    return c.json({
      success: true,
      data: {
        linked: true,
        customerId: result.customerId,
        backfilled: result.backfilled,
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

export { liffAccountLink };
