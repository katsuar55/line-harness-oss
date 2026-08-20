/**
 * GET /api/liff/portal-bootstrap — ポータル初期化の一括 read API (Ultraplan PR-2, inert)。
 *
 * services/portal-read.ts の read 関数 14 本 (= 既存の個別 endpoint と同一実装) を
 * Promise.allSettled で並列実行し、1 往復で全カード分の data を返す。
 *
 * Response:
 *   { success: true, data: { <section>: { ok: true, data } | { ok: false, status } , ... } }
 *   - section の data は対応する個別 endpoint の data と完全同一 shape。
 *   - 1 section の失敗 (reject) は { ok: false, status: 500 } に畳み、他 section へ伝播させない
 *     (クライアントは該当カードだけ既存のエラー表示 / fallback に落とせる)。
 *   - Cache-Control: no-store (顧客ごとの個人データ束のため)。
 *
 * 認証: /api/liff/* なので liffAuthMiddleware (idToken) が自動適用。
 *   getLiffUser が undefined なら 401 (既存 handler と同じ作法)。
 *
 * ※ この endpoint はまだどのクライアントからも呼ばれない (inert)。
 *   liff-pages.ts の切替は PR-3。
 */
import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  readRank,
  readCoupons,
  readFriendCoupon,
  readWelcomeCoupon,
  readReferralCoupon,
  readLinkCoupon,
  readReferralStats,
  readReferralRanking,
  readAmbassadorStatus,
  readTipToday,
  readProfile,
  readIntakeToday,
  readBadges,
  readLanguage,
} from '../services/portal-read.js';

const liffPortalBootstrap = new Hono<Env>();

// ─── Helper: get verified friend from liffUser middleware (routes/liff-portal.ts と同型) ───
function getLiffUser(c: { get: (key: string) => unknown }) {
  return c.get('liffUser') as
    | { lineUserId: string; friendId: string; shopifyCustomerId?: string | null }
    | undefined;
}

/** 個別 GET /api/liff/referral/ranking の default limit と同値 (clamp 済み定数)。 */
const BOOTSTRAP_RANKING_LIMIT = 10;

/** section 応答: 成功は data そのまま、失敗は status のみ (原因はサーバログ側に残す)。 */
type BootstrapSection = { ok: true; data: unknown } | { ok: false; status: number };

/** section キー (応答 shape の契約)。 tasks 配列と同順で zip する。 */
const SECTION_KEYS = [
  'rank',
  'coupons',
  'welcomeCoupon',
  'referralCoupon',
  'linkCoupon',
  'friendCoupon',
  'referral',
  'ranking',
  'ambassador',
  'tip',
  'profile',
  'intakeToday',
  'badges',
  'language',
] as const;

liffPortalBootstrap.get('/api/liff/portal-bootstrap', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const deps = { db: c.env.DB };
    const referralCouponDeps = {
      db: c.env.DB,
      env: c.env,
      waitUntil: (work: Promise<unknown>) => {
        try { c.executionCtx.waitUntil(work); } catch { /* no exec ctx in tests */ }
      },
    };

    // SECTION_KEYS と同順 (zip するので順序がズレると section が入れ替わる)
    const settled = await Promise.allSettled([
      readRank(deps, user),
      readCoupons(deps, user),
      readWelcomeCoupon(deps, user),
      readReferralCoupon(referralCouponDeps, user),
      readLinkCoupon({ db: c.env.DB, env: c.env }, user),
      readFriendCoupon(deps, user),
      readReferralStats(deps, user),
      readReferralRanking(deps, BOOTSTRAP_RANKING_LIMIT),
      readAmbassadorStatus(deps, user),
      readTipToday(deps),
      readProfile(deps, user),
      readIntakeToday(deps, user),
      readBadges(deps, user),
      readLanguage(deps, user),
    ]);

    const entries = SECTION_KEYS.map((key, i): [string, BootstrapSection] => {
      const result = settled[i];
      if (result.status === 'fulfilled') {
        return [key, { ok: true, data: result.value }];
      }
      // 失敗は response 上 ok:false に畳む (silent swallow しない — 原因はここに残す)
      console.error(`GET /api/liff/portal-bootstrap section ${key} failed:`, result.reason);
      return [key, { ok: false, status: 500 }];
    });
    const data = Object.fromEntries(entries) as Record<(typeof SECTION_KEYS)[number], BootstrapSection>;

    // 顧客ごとの個人データ束 — 中間キャッシュに残さない
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/liff/portal-bootstrap error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { liffPortalBootstrap };
