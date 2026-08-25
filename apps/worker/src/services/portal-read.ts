/**
 * Portal read-model 関数群 (Ultraplan PR-2)。
 *
 * routes/liff-portal.ts の read 系 handler 14 本の本体をそのまま関数として抽出した。
 * - 各関数は「liffAuthMiddleware で認証済みの liffUser を前提に、既存 handler が
 *   c.json({ success: true, data }) に渡していた data と**完全同一 shape** を返す」だけ。
 * - 認証 (getLiffUser / 401)・try/catch・error 応答・console.error は呼び出し側
 *   handler の責務のまま (= 個別 endpoint の挙動は 1 bit も変えない)。
 * - routes/liff-portal-bootstrap.ts (GET /api/liff/portal-bootstrap) が同じ関数群を
 *   Promise.allSettled で並列実行し、ポータル初期化の直列 fetch 群を 1 往復に束ねる。
 */
import { LineClient } from '@line-crm/line-sdk';
import {
  getFriendRank,
  getMemberRanks,
  resolveFriendRank,
  NATURISM_RANK_DEFS,
  getCouponAssignmentsByFriend,
  getReferralStats,
  getReferralLink,
  getAmbassador,
  getTodayTip,
  getFriendLanguage,
  countWaitingReferralCoupons,
} from '@line-crm/db';
import { getFriendCouponConfig } from './friend-coupon-config.js';
import { buildDiscountApplyUrl } from './cart-permalink.js';
import { getActiveWelcomeCoupon, formatCouponCountdown } from './welcome-coupon.js';
import { getActiveReferralCoupons } from './referral-coupon-issuer.js';
import { getActiveLinkRewardCoupon } from './link-reward-coupon-issuer.js';
import { activateAndNotifyNextReferralCoupon } from './referral-reward.js';
import type { ReferralRewardEnv } from './referral-reward.js';

// ─── deps / user 型 ───

/** liffAuthMiddleware が c.set('liffUser') した検証済み friend (index.ts Variables と同型)。 */
export interface LiffUser {
  lineUserId: string;
  friendId: string;
  shopifyCustomerId?: string | null;
}

/** 最小 deps: D1 のみ。 env や waitUntil が要る関数は個別 deps 型で拡張する。 */
export interface PortalReadDeps {
  db: D1Database;
}

export interface ReferralCouponReadDeps extends PortalReadDeps {
  /** gate (REFERRAL_REWARD_ENABLED) + T3 活性化 (activateAndNotifyNextReferralCoupon) 用。 */
  env: ReferralRewardEnv & { LINE_CHANNEL_ACCESS_TOKEN: string };
  /**
   * T3 pull 検算の fire-and-forget 登録。 本番 handler は
   * `(work) => { try { c.executionCtx.waitUntil(work) } catch { /* no exec ctx in tests *\/ } }`
   * を渡す。 未指定なら単なる fire-and-forget (work には catch 済み)。
   */
  waitUntil?: (work: Promise<unknown>) => void;
}

export interface LinkCouponReadDeps extends PortalReadDeps {
  env: { LINK_REWARD_ENABLED?: string };
}

// 顧客向けストアフロント (= 公式ドメイン)。割引適用リンクに使う。
const FRIEND_COUPON_STORE_DOMAIN = 'naturism-diet.com';

// ─── read 関数 14 本 (liff-portal.ts の handler と 1:1) ───

/**
 * 会員ランク (= 自社内製ロイヤリティ, trailing-12ヶ月) の read-model。
 *
 * 🚨 会員証 (GET /api/liff/my-rank) と**同じ 1 本の実装** (resolveFriendRank) から導くこと。
 *   ポータルのホームは長らく DEPRECATED な member_ranks 表 (getFriendRank/getMemberRanks) を
 *   読んでおり、会員証ページ (/liff/my-rank) の trailing-12mo ランクと**別の答え**を出していた
 *   (ホーム「はじめて」/ 会員証「レギュラー会員」)。同じ顧客に 2 つのランクを見せないため、
 *   顧客可視のランク表示はすべてこの関数を通す。
 *
 * shape は GET /api/liff/my-rank の data.rank / trailing12moJpy / next / progressRatio と
 * 逐語で一致させる (drift すると同じ画面で 2 つの数字が出る)。
 * 失敗しても null を返してホーム全体は描く (会員証本体を落とさない my-rank と同じ作法)。
 */
export async function readLoyaltyRank(deps: PortalReadDeps, liffUser: LiffUser) {
  try {
    const resolved = await resolveFriendRank(deps.db, liffUser.friendId, NATURISM_RANK_DEFS);
    const p = resolved.progress;
    return {
      rank: {
        id: resolved.rank.id,
        name: resolved.rank.name,
        discountPercent: resolved.rank.discountPercent,
        badgeEmoji: resolved.rank.badgeEmoji ?? null,
        badgeColor: resolved.rank.badgeColor ?? null,
        badgeImageUrl: resolved.rank.badgeImageUrl ?? null,
      },
      trailing12moJpy: resolved.trailing12moJpy,
      next: p.next
        ? {
            id: p.next.id,
            name: p.next.name,
            remainingJpy: p.remainingToNextJpy,
            // ホームは「次は何% OFF か」まで出す (会員証と同じ 1 本から出すため両方に足す)
            discountPercent: p.next.discountPercent,
          }
        : null,
      progressRatio: p.progressRatio,
    };
  } catch (err) {
    console.error('[portal-read] readLoyaltyRank failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * POST /api/liff/rank の本体 — ランク＋進捗バー＋特典。
 */
export async function readRank(deps: PortalReadDeps, liffUser: LiffUser) {
  // 顧客可視のランクは会員証 (/liff/my-rank) と同じ 1 本 (loyalty) から出す。 member_ranks 由来
  // フィールド (currentRank/totalSpent/nextRank/progressPercent) は DEPRECATED な旧系統で、
  // 表示には使わない (既存 consumer との後方互換のためだけに残す)。
  // この endpoint はポータル初期化の直列パスに居るので 3 本を直列に await しない (並列で 1 往復ぶん)。
  const [friendRank, allRanks, loyalty] = await Promise.all([
    getFriendRank(deps.db, liffUser.friendId),
    getMemberRanks(deps.db),
    readLoyaltyRank(deps, liffUser),
  ]);
  // linked = Shopify customer と紐付け済か。 ポータルのマイアカウントが
  // 「オンラインストアと連携」カードを畳む判定に使う (= 連携済みの人に押させない)。
  // 命名は /api/liff/my-rank の同名フィールドに合わせる。
  // 値は liffAuthMiddleware が既に読んだ friend 行から来るので、 D1 read は増えない
  // (この endpoint はポータル初期化の直列パスに居るため、 1 本の追加も全ユーザーに載る)。
  const linked = !!liffUser.shopifyCustomerId;

  if (!friendRank) {
    return {
      linked,
      loyalty,
      currentRank: null,
      totalSpent: 0,
      ordersCount: 0,
      // 有り分岐と同じ shape に揃える (旧実装は member_ranks の生行 = snake_case・remaining 無しを返していた)
      nextRank: allRanks[0]
        ? {
            name: allRanks[0].name,
            color: allRanks[0].color,
            minTotalSpent: allRanks[0].min_total_spent,
            remaining: Math.max(0, Number(allRanks[0].min_total_spent ?? 0)),
          }
        : null,
      progressPercent: 0,
      benefits: null,
      allRanks: allRanks.map((r) => ({
        name: r.name,
        color: r.color,
        icon: r.icon,
        minTotalSpent: r.min_total_spent,
      })),
    };
  }

  const currentRankDetail = allRanks.find(
    (r) => r.id === (friendRank as Record<string, unknown>).rank_id,
  );
  const currentIdx = allRanks.findIndex(
    (r) => r.id === (friendRank as Record<string, unknown>).rank_id,
  );
  const nextRank = currentIdx < allRanks.length - 1 ? allRanks[currentIdx + 1] : null;

  const totalSpent = Number((friendRank as Record<string, unknown>).total_spent) || 0;
  let progressPercent = 100;
  if (nextRank) {
    const currentMin = Number(currentRankDetail?.min_total_spent) || 0;
    const nextMin = Number(nextRank.min_total_spent) || 0;
    const range = nextMin - currentMin;
    progressPercent = range > 0 ? Math.min(100, Math.round(((totalSpent - currentMin) / range) * 100)) : 100;
  }

  return {
    linked,
    loyalty,
    currentRank: currentRankDetail
      ? {
          name: currentRankDetail.name,
          color: currentRankDetail.color,
          icon: currentRankDetail.icon,
          benefits: currentRankDetail.benefits_json
            ? JSON.parse(currentRankDetail.benefits_json as string)
            : null,
        }
      : null,
    totalSpent,
    ordersCount: (friendRank as Record<string, unknown>).orders_count ?? 0,
    nextRank: nextRank
      ? {
          name: nextRank.name,
          color: nextRank.color,
          minTotalSpent: nextRank.min_total_spent,
          remaining: Math.max(0, Number(nextRank.min_total_spent ?? 0) - totalSpent),
        }
      : null,
    progressPercent,
    allRanks: allRanks.map((r) => ({
      name: r.name,
      color: r.color,
      icon: r.icon,
      minTotalSpent: r.min_total_spent,
    })),
  };
}

/**
 * POST /api/liff/coupons の本体 — 未使用クーポン一覧。
 */
export async function readCoupons(deps: PortalReadDeps, liffUser: LiffUser) {
  const assignments = await getCouponAssignmentsByFriend(deps.db, liffUser.friendId, true);

  return {
    coupons: assignments.map((a: Record<string, unknown>) => ({
      id: a.coupon_id,
      code: a.code,
      title: a.title,
      description: a.description,
      discountType: a.discount_type,
      discountValue: a.discount_value,
      minimumOrderAmount: a.minimum_order_amount,
      expiresAt: a.expires_at,
      assignedAt: a.assigned_at,
    })),
  };
}

/**
 * GET /api/liff/friend-coupon の本体 — LINE友だち限定クーポン (ランク不問の一律 % OFF)。
 * 管理トグルが ON かつコード設定済みのときだけ code/applyUrl を返す。
 * liffUser は取得に使わないが「認証済み friend にのみ見せる」契約を型で示すため受け取る。
 */
export async function readFriendCoupon(deps: PortalReadDeps, _liffUser: LiffUser) {
  const cfg = await getFriendCouponConfig(deps.db);
  if (!cfg.enabled || !cfg.code) {
    return { enabled: false };
  }
  return {
    enabled: true,
    code: cfg.code,
    percent: cfg.percent,
    label: cfg.label,
    note: cfg.note,
    applyUrl: buildDiscountApplyUrl(FRIEND_COUPON_STORE_DOMAIN, cfg.code),
  };
}

/**
 * GET /api/liff/welcome-coupon の本体 — 友だち追加時に発行済みの「あなた専用」welcomeクーポン。
 * 発行済 (line_friend_coupons, status='issued', 未失効) があれば code/値引/残り時間/購入リンクを返す。
 */
export async function readWelcomeCoupon(deps: PortalReadDeps, liffUser: LiffUser) {
  const coupon = await getActiveWelcomeCoupon(deps.db, liffUser.friendId);
  if (!coupon) return { coupon: null };

  return {
    coupon: {
      code: coupon.code,
      discountValue: coupon.discountValue,
      currency: coupon.discountCurrency,
      expiresAt: coupon.expiresAt,
      remainingText: formatCouponCountdown(coupon.expiresAt, Date.now()),
      applyUrl: buildDiscountApplyUrl(FRIEND_COUPON_STORE_DOMAIN, coupon.code),
    },
  };
}

/**
 * GET /api/liff/referral-coupon の本体 — 紹介した側 (referrer) が獲得した実クーポン群。
 * gate off (= 機能未有効化) なら DB を触らず常に空 (= migration 068 未適用でも安全)。
 */
export async function readReferralCoupon(deps: ReferralCouponReadDeps, liffUser: LiffUser) {
  // 未有効化なら DB を触らず空 (= テーブル未存在の pre-migration でも安全)
  if (deps.env.REFERRAL_REWARD_ENABLED !== 'true') {
    return { coupons: [], count: 0, queuedCount: 0 };
  }

  const active = await getActiveReferralCoupons(deps.db, liffUser.friendId);
  const coupons = active.map((cp) => ({
    code: cp.code,
    discountValue: cp.discountValue,
    role: cp.role,
    expiresAt: cp.expiresAt,
    remainingText: formatCouponCountdown(cp.expiresAt, Date.now()),
    applyUrl: buildDiscountApplyUrl(FRIEND_COUPON_STORE_DOMAIN, cp.code),
  }));

  // 順次活性化 (R1): 待機枚数 (queue waiting)。fail-safe 0 (= migration 079 未適用でも安全)。
  const queuedCount = await countWaitingReferralCoupons(deps.db, liffUser.friendId);

  // T3 pull 検算: 使える 1 枚が無いのに待機がある = T1 (webhook) の取りこぼし or 失効による解放。
  //   顧客が見に来た瞬間に自己修復する (sweep gate 未開放でも queue がデッドロックしない第三経路)。
  //   応答は待たせない (waitUntil) — 次回 fetch (カード側の遅延再取得) で反映される。
  if (coupons.length === 0 && queuedCount > 0) {
    // static import (dynamic import は vi.mock 干渉トラップ — CLAUDE.md テストルール)
    const work = activateAndNotifyNextReferralCoupon(
      deps.db,
      deps.env,
      new LineClient(deps.env.LINE_CHANNEL_ACCESS_TOKEN),
      { friendId: liffUser.friendId },
    ).catch((err) => {
      console.error('[liff-portal] T3 referral activation failed:', err instanceof Error ? err.name : 'unknown');
    });
    deps.waitUntil?.(work);
  }

  return { coupons, count: coupons.length, queuedCount };
}

/**
 * GET /api/liff/link-coupon の本体 — アカウント連携特典の実クーポン (Sprint A-1)。
 * gate off (= 機能未有効化) なら DB を触らず常に空 (= migration 078 未適用でも安全)。
 */
export async function readLinkCoupon(deps: LinkCouponReadDeps, liffUser: LiffUser) {
  // 未有効化なら DB を触らず空 (= テーブル未存在の pre-migration でも安全)
  if (deps.env.LINK_REWARD_ENABLED !== 'true') {
    return { coupon: null };
  }

  const coupon = await getActiveLinkRewardCoupon(deps.db, liffUser.friendId);
  if (!coupon) return { coupon: null };

  return {
    coupon: {
      code: coupon.code,
      // 🚨 定数 (DEFAULT_DISCOUNT_VALUE_JPY) を書かないこと。**台帳の値が唯一の正**で、
      //    既発行の ¥500 券をここで ¥300 と言うと顧客の実額と食い違う。
      //    liff-portal.test.ts は定数と異なる値 (450) で経路を測っている。
      discountValue: coupon.discountValue,
      expiresAt: coupon.expiresAt,
      remainingText: formatCouponCountdown(coupon.expiresAt, Date.now()),
      applyUrl: buildDiscountApplyUrl(FRIEND_COUPON_STORE_DOMAIN, coupon.code),
    },
  };
}

/**
 * POST /api/liff/referral/stats の本体 — 紹介実績。
 */
export async function readReferralStats(deps: PortalReadDeps, liffUser: LiffUser) {
  const stats = await getReferralStats(deps.db, liffUser.friendId);
  const link = await getReferralLink(deps.db, liffUser.friendId);

  return {
    ...stats,
    refCode: link?.ref_code ?? null,
    hasLink: !!link,
  };
}

/**
 * マスク処理: 「田中太郎」→「田○太○」（1文字おき伏字）
 */
function maskDisplayName(name: string | null): string {
  if (!name) return '匿名';
  const chars = [...name]; // Unicode-safe split
  return chars.map((ch, i) => (i % 2 === 1 ? '○' : ch)).join('');
}

/**
 * GET /api/liff/referral/ranking の本体 — 紹介ランキング (display_name はマスク済み)。
 * limit は handler 側で 1..50 に clamp した値を渡す (bootstrap は既定の 10)。
 */
export async function readReferralRanking(deps: PortalReadDeps, limit: number) {
  const { results } = await deps.db
    .prepare(
      `SELECT
         rr.referrer_friend_id,
         f.display_name,
         COUNT(*) as referral_count
       FROM referral_rewards rr
       JOIN friends f ON f.id = rr.referrer_friend_id
       GROUP BY rr.referrer_friend_id
       ORDER BY referral_count DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ referrer_friend_id: string; display_name: string | null; referral_count: number }>();

  return results.map((r, i) => ({
    rank: i + 1,
    displayName: maskDisplayName(r.display_name),
    referralCount: r.referral_count,
  }));
}

/**
 * POST /api/liff/ambassador/status の本体 — アンバサダーステータス (未登録なら null)。
 */
export async function readAmbassadorStatus(deps: PortalReadDeps, liffUser: LiffUser) {
  const ambassador = await getAmbassador(deps.db, liffUser.friendId);

  return ambassador
    ? {
        status: ambassador.status,
        tier: ambassador.tier,
        enrolledAt: ambassador.enrolled_at,
        surveysCompleted: ambassador.total_surveys_completed,
        productTests: ambassador.total_product_tests,
        preferences: JSON.parse(ambassador.preferences),
      }
    : null;
}

/**
 * GET /api/liff/tips/today の本体 — 今日のTip（認証不要・liffUser 不要)。
 * 未登録日は null (handler 側が message を添える)。
 */
export async function readTipToday(deps: PortalReadDeps) {
  return await getTodayTip(deps.db);
}

/**
 * GET /api/liff/profile の本体 — gender/birthday を含む自分のプロフィール。
 */
export async function readProfile(deps: PortalReadDeps, liffUser: LiffUser) {
  const friend = await deps.db
    .prepare('SELECT display_name, gender, birthday FROM friends WHERE id = ?')
    .bind(liffUser.friendId)
    .first<{ display_name: string | null; gender: string | null; birthday: string | null }>();

  return friend || {};
}

/**
 * GET /api/liff/intake/today の本体 — 今日の各 meal_type 記録状況。
 */
export async function readIntakeToday(deps: PortalReadDeps, liffUser: LiffUser) {
  const today = new Date().toISOString().slice(0, 10); // 簡易: JST と1日ズレる可能性あり、UI 側で許容
  const { results } = await deps.db
    .prepare(
      `SELECT meal_type, logged_at FROM intake_logs
       WHERE friend_id = ? AND substr(logged_at, 1, 10) = ? AND meal_type IS NOT NULL
       ORDER BY logged_at DESC`,
    )
    .bind(liffUser.friendId, today)
    .all<{ meal_type: string; logged_at: string }>();

  const recorded = {
    breakfast: false,
    lunch: false,
    dinner: false,
    snack: false,
  };
  for (const row of results) {
    if (row.meal_type === 'breakfast') recorded.breakfast = true;
    else if (row.meal_type === 'lunch') recorded.lunch = true;
    else if (row.meal_type === 'dinner') recorded.dinner = true;
    else if (row.meal_type === 'snack') recorded.snack = true;
  }

  return { date: today, recorded };
}

/**
 * GET /api/liff/badges の本体 — 自分の獲得バッジ + 全バッジ + レベル。
 */
export async function readBadges(deps: PortalReadDeps, liffUser: LiffUser) {
  const { getAllBadges, getFriendBadges, calculateLevel, pointsToNextLevel } = await import('@line-crm/db');

  const [allBadges, earned, scoreRow] = await Promise.all([
    getAllBadges(deps.db),
    getFriendBadges(deps.db, liffUser.friendId),
    deps.db.prepare(`SELECT score FROM friends WHERE id = ?`).bind(liffUser.friendId).first<{ score: number }>(),
  ]);

  const score = scoreRow?.score ?? 0;
  return {
    allBadges,
    earnedBadges: earned.map((b) => ({ code: b.badge_code, earnedAt: b.earned_at })),
    level: calculateLevel(score),
    score,
    pointsToNext: pointsToNextLevel(score),
  };
}

/**
 * POST /api/liff/language の本体 — 言語設定取得。
 */
export async function readLanguage(deps: PortalReadDeps, liffUser: LiffUser) {
  const lang = await getFriendLanguage(deps.db, liffUser.friendId);
  return { lang };
}
