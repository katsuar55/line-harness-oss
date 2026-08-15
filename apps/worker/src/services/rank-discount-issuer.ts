/**
 * Rank Discount Issuer Service (= 自社内製ロイヤリティ PR5-5a, 2026-06-04)
 *
 * 役割: 会員ランクに応じた常時%OFF 割引を、 顧客別 Shopify コード (NLR-{rank}-{suffix}) で発行する。
 *   3タップ単発購入 (cart permalink ?discount={code}) で利用。
 *
 * 設計 (PR-D 2026-08-15 改訂・B案 = 定期便ランク%は Huckleberry ネイティブ会員ランクが担当):
 *   - discountCodeBasicCreate (percentage, items.all)。連携済み (shopify_customer_id 保有) は
 *     customerSelection を **customer 限定**で発行 (SNS 漏洩リークの止血)。未連携は従来の all。
 *   - **単発購入専用** (appliesOnSubscription: false 明示 = HB ランク%との二重取り防止)。
 *     min ¥2,000 同梱 (全券共通ガード)。
 *   - combinesWith product+order 両 true (= 紹介 NREF- / 連携 NLINK- と order×order で実際に重なる)。
 *   - 再利用可 (usageLimit=null, appliesOncePerCustomer=false)。 cb-admin 感謝クーポンとは別 namespace。
 *   - friend ごとに active は1つ。 ランク変更・残寿命 <13日 で旧を superseded 化 + 新規 issue +
 *     旧コードを discountCodeDeactivate (失敗は日次 sweep [gate COUPON_SWEEP_ENABLED] が
 *     shopify_deactivated_at NULL を再試行)。
 *   - GraphQL は Shopify dev MCP validate_graphql_codeblocks で検証済 (write_discounts scope)。
 *
 * ⚠️ 本番ガード: RANK_DISCOUNT_ENABLED='true' でなければ no-op (= 承認前は本番 Shopify に書き込まない)。
 *   default off。 Katsu 承認後に env を設定して有効化 (= 5c)。
 *
 * セキュリティ / 既知トラップ:
 *   - access token は getShopifyAccessToken (D1 cache + Client Credentials)。
 *   - fetch は fetch.bind(globalThis) で渡す (= Illegal invocation 回避、 CLAUDE.md ルール)。
 *   - 例外/token は console.error にとどめ caller には null (情報漏洩防止)。
 *
 * 関連: services/shopify-coupon-issuer.ts (= 同パターンの welcome クーポン)、 migration 062。
 */

import { getShopifyAccessToken } from './shopify-token.js';
import { auditSystem } from './audit-logger.js';
import { deactivateDiscountCode } from './shopify-discount-admin.js';
import {
  getActiveRankDiscount,
  getFriendById,
  insertRankDiscount,
  markRankDiscountShopifyDeactivated,
  supersedeActiveRankDiscounts,
} from '@line-crm/db';

// ============================================================
// 定数
// ============================================================

const SHOPIFY_API_VERSION = '2026-04';
// reply window 外 (= admin/cron trigger) のため coupon-issuer の 3s より長め
const SHOPIFY_TIMEOUT_MS = 8_000;
// ambiguous な 0/1/O/I/L を除外した base31 alphabet (= 人間が読み書きしやすい)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_SUFFIX_LENGTH = 8;
// 月次再判定 + buffer。 superseded した旧コードも自動失効させる
const DEFAULT_VALID_DAYS = 45;
// 冪等再利用の最低残寿命 (PR-D 2026-08-15): 従来は同 rank なら無条件再利用だったため、
//   45日で Shopify 側が失効しても DB は active のままコードが二度と再発行されなかった。
//   残寿命がこの日数を切ったら supersede + 再発行する。⚠️ 値の根拠 (採点ループ算術確定):
//   月1 cron (毎月1日) の時点で残寿命は最短 45-31=14日。閾値 14 だと cron の数秒の実行
//   ジッタで 13日23時間59分 と判定され「毎月全員再発行」へ雪崩れる knife-edge になる
//   (採点 R1 finding) → **13 で丸1日の slack** を持たせる。35日等にすると月1 cron が
//   毎回全員分を再発行して Shopify write が爆発する (plan の許容帯は 10-14日)。
const REISSUE_MIN_REMAINING_DAYS = 13;
const REISSUE_MIN_REMAINING_MS = REISSUE_MIN_REMAINING_DAYS * 86_400_000;
const CODE_NAMESPACE = 'NLR'; // naturism loyalty rank (= cb-admin 感謝クーポンと衝突回避)

// ============================================================
// types
// ============================================================

export interface RankDiscountEnv {
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
  /** 'true' で本番発行を有効化。 未設定/その他なら no-op (= 承認前は本番未書込)。 */
  RANK_DISCOUNT_ENABLED?: string;
}

export interface IssueRankDiscountOptions {
  friendId: string;
  rankId: string;
  /** 2/4/6/8 (= rank の discountPercent)。 0 以下なら発行しない。 */
  discountPercent: number;
  lineAccountId?: string | null;
  brandId?: string | null;
  validDays?: number;
  /** test 用 fetch 注入 (default: fetch.bind(globalThis)) */
  fetchImpl?: typeof fetch;
  /** test 用 clock 注入 */
  now?: () => number;
}

export interface IssuedRankDiscount {
  code: string;
  discountPercent: number;
  rankId: string;
  expiresAt: string | null;
  /** true if returned from DB (already issued for this rank) */
  isExisting: boolean;
  shopifyDiscountNodeId: string | null;
}

// ============================================================
// コード生成 (rank label + random suffix)
// ============================================================

/** rank id を code 用ラベルに正規化 (英数大文字のみ)。 */
function rankLabel(rankId: string): string {
  return String(rankId)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function generateRankCode(rankId: string): string {
  const bytes = new Uint8Array(CODE_SUFFIX_LENGTH);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const b of bytes) {
    suffix += CODE_CHARS[b % CODE_CHARS.length];
  }
  return `${CODE_NAMESPACE}-${rankLabel(rankId)}-${suffix}`;
}

// ============================================================
// Shopify GraphQL discountCodeBasicCreate (= validate 済 mutation)
// ============================================================

interface ShopifyRankDiscountResponse {
  data?: {
    discountCodeBasicCreate?: {
      codeDiscountNode?: {
        id: string;
        codeDiscount?: { codes?: { nodes?: Array<{ code: string }> } };
      };
      userErrors?: Array<{ code?: string; field?: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

type ShopifyRankCreateResult =
  | { ok: true; discountNodeId: string; actualCode: string }
  | { ok: false; error: string };

async function callRankDiscountCreate(
  storeDomain: string,
  accessToken: string,
  code: string,
  discountPercent: number,
  rankId: string,
  startsAt: string,
  endsAt: string,
  customerGid: string | null,
  fetchImpl: typeof fetch,
): Promise<ShopifyRankCreateResult> {
  const mutation = `
    mutation rankDiscountCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              codes(first: 1) { nodes { code } }
            }
          }
        }
        userErrors { code field message }
      }
    }
  `;
  const variables = {
    basicCodeDiscount: {
      title: `naturism ランク特典 ${discountPercent}% (${rankId})`,
      code,
      startsAt,
      endsAt,
      // 顧客限定 (PR-D 2026-08-15 abuse CRITICAL #2): shopify_customer_id 保有者 (= 連携済み) は
      //   customer 限定で発行する。従来の all + usageLimit 無制限は SNS に漏れると誰でも常時%OFF
      //   になる唯一の非有界リークで止血手段が無かった。未連携 friend のみ従来の all で発行
      //   (シークレットコード配布 = 従来リスクと同等、連携が進むほど自然に閉じる)。
      //   ゲスト checkout でも「プロフィールのメール/電話の入力」で適格判定される (Shopify 公式・
      //   採点ループの敵対的検証で確認)。別メールで checkout すると割引が外れる edge は
      //   B案 検証ゲートの実測項目。
      //   ⚠️ customerSelection は 2026-04 で deprecated (context 推奨・動作は正常)。API version を
      //   上げる時は 4 issuer (welcome/紹介/連携/ランク) 一括で DiscountContextInput へ移行すること。
      customerSelection: customerGid ? { customers: { add: [customerGid] } } : { all: true },
      customerGets: {
        // percentage は 0.00-1.00 の小数 (= Shopify schema)。 4% → 0.04
        value: { percentage: discountPercent / 100 },
        items: { all: true },
        // 🚨 NLR- は**単発購入専用** (B案 2026-08-15 Katsu 決定): 定期便のランク%は
        //   Huckleberry ネイティブ会員ランク (毎サイクル現在ランク) が担う。ここを true に
        //   すると「契約に固着したコード% + HB ランク%」の二重取りが成立してしまうため、
        //   将来も true へ変えないこと (変えるなら HB ランク側の停止とセットで)。
        //   ⚠️ appliesOnSubscription は customerGets の中 (トップレベルは GraphQL エラー)。
        appliesOnOneTimePurchase: true,
        appliesOnSubscription: false,
      },
      // recurringCycleLimit は付けない (appliesOnSubscription: false では定期便に乗らないため
      //   無意味。A案の cycle:0 は B案採択で破棄)。
      // 🔴 2026-08-13 本番実測: items:{all} の discountCodeBasicCreate は **ORDER クラス**になる
      //   (本 NLR- コードは admin 上「注文の割引」表示・「1回の注文につき複数を適用できます」実測)。
      //   combinesWith 設定済みの紹介 NREF- / 連携 NLINK- とは order×order で**実際に重なる** (Plus 不要。
      //   Plus が要るのは同一カートラインの product 割引 2 枚重ねのみ)。旧コメントの
      //   「rank=order × sub=product のクロスクラス」という説明は誤りだった。
      combinesWith: { productDiscounts: true, orderDiscounts: true, shippingDiscounts: false },
      // 全券共通の最低購入 ¥2,000 (Katsu 確定 — 過剰値引きの唯一のガード)
      minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: '2000' } },
      appliesOncePerCustomer: false, // ランク割引は再利用可
      usageLimit: null, // 無制限 (= 常時割引。漏洩リスクは customer 限定側で止血)
      tags: ['loyalty', `rank-${rankId}`],
    },
  };

  const url = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query: mutation, variables }),
      signal: controller.signal,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}` };
  }

  let body: ShopifyRankDiscountResponse;
  try {
    body = (await res.json()) as ShopifyRankDiscountResponse;
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (body.errors && body.errors.length > 0) {
    return { ok: false, error: body.errors.map((e) => e.message).join('; ') };
  }
  const result = body.data?.discountCodeBasicCreate;
  if (!result) {
    return { ok: false, error: 'no discountCodeBasicCreate in response' };
  }
  if (result.userErrors && result.userErrors.length > 0) {
    return {
      ok: false,
      error: result.userErrors.map((e) => `${e.code ?? 'ERR'}: ${e.message}`).join('; '),
    };
  }
  const discountNodeId = result.codeDiscountNode?.id;
  const actualCode = result.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code;
  if (!discountNodeId || !actualCode) {
    return { ok: false, error: 'incomplete response (no id or code)' };
  }
  return { ok: true, discountNodeId, actualCode };
}

// ============================================================
// main: issueRankDiscountForFriend
// ============================================================

export async function issueRankDiscountForFriend(
  db: D1Database,
  env: RankDiscountEnv,
  options: IssueRankDiscountOptions,
): Promise<IssuedRankDiscount | null> {
  const { friendId, rankId } = options;
  const discountPercent = options.discountPercent;
  const lineAccountId = options.lineAccountId ?? null;
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const nowFn = options.now ?? Date.now;

  // 0. regular (= 0%) / 不正値 は割引コード不要 (= Number.isFinite で NaN も明示除外)
  if (!Number.isFinite(discountPercent) || discountPercent <= 0) {
    return null;
  }

  // 1. 本番ガード: 承認前は no-op (= 本番 Shopify に書き込まない)
  if (env.RANK_DISCOUNT_ENABLED !== 'true') {
    console.info('[rank-discount-issuer] gated off (RANK_DISCOUNT_ENABLED!=true) friend=', friendId);
    return null;
  }

  // 2. 既存 active 確認 (冪等 = 同 rank/percent **かつ残寿命 ≥ REISSUE_MIN_REMAINING_DAYS 日** なら再利用)。
  //   残寿命不足・期限切れは再発行へ落ちる (旧 45日失効後に二度と再発行されないバグの根治)。
  //   ⚠️ getActiveRankDiscount は期限**無フィルタ**であること (期限切れ active 行も拾って
  //   supersede しないと、その行が永久に active のまま残留する — 採点 CONFIRMED の回帰)。
  const now = nowFn();
  const existing = await getActiveRankDiscount(db, friendId);
  if (existing && existing.rankId === rankId && existing.discountPercent === discountPercent) {
    const expiresMs = existing.expiresAt ? Date.parse(existing.expiresAt) : Infinity;
    // NaN (不正な expires_at) は比較が false になり再発行へ落ちる = 安全側
    if (expiresMs - now >= REISSUE_MIN_REMAINING_MS) {
      return {
        code: existing.code,
        discountPercent: existing.discountPercent,
        rankId: existing.rankId,
        expiresAt: existing.expiresAt,
        isExisting: true,
        shopifyDiscountNodeId: existing.shopifyDiscountNodeId,
      };
    }
  }

  // 3. Shopify config
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    console.error('[rank-discount-issuer] Shopify credentials not configured');
    return null;
  }

  // 4. access token
  let accessToken: string;
  try {
    accessToken = await getShopifyAccessToken(db, env);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[rank-discount-issuer] access token unavailable:', errMsg);
    await auditSystem(db, {
      action: 'loyalty_rank_discount.issue_failed',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'access_token', rankId },
    });
    return null;
  }

  // 5. 連携状態の確認 (PR-D): shopify_customer_id 保有者は customer 限定で発行する。
  //   lookup 失敗時は fail-closed (= 発行しない)。連携済み顧客のコードを transient エラーで
  //   all (非有界) に落とすと、この PR が塞いだ唯一のリークを偶発的に再現するため。
  //   発行は月次 cron + my-rank 閲覧 (lazy) で自動再試行される = 無発行は回復可能。
  let customerGid: string | null;
  try {
    const friend = await getFriendById(db, friendId);
    customerGid = friend?.shopify_customer_id
      ? `gid://shopify/Customer/${friend.shopify_customer_id}`
      : null;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[rank-discount-issuer] friend lookup failed (fail-closed):', errMsg);
    await auditSystem(db, {
      action: 'loyalty_rank_discount.issue_failed',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'friend_lookup', rankId },
    });
    return null;
  }

  // 6. 生成 + Shopify 発行
  const validDays = options.validDays ?? DEFAULT_VALID_DAYS;
  const startsAt = new Date(now).toISOString();
  const endsAt = new Date(now + validDays * 86_400_000).toISOString();
  const code = generateRankCode(rankId);

  const result = await callRankDiscountCreate(
    env.SHOPIFY_STORE_DOMAIN,
    accessToken,
    code,
    discountPercent,
    rankId,
    startsAt,
    endsAt,
    customerGid,
    fetchImpl,
  );
  if (!result.ok) {
    console.error('[rank-discount-issuer] discountCodeBasicCreate failed:', result.error);
    await auditSystem(db, {
      action: 'loyalty_rank_discount.issue_failed',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: result.error,
      metadata: { stage: 'discount_create', rankId, apiVersion: SHOPIFY_API_VERSION },
    });
    return null;
  }

  // 7. 新規 insert を先行 (= 失敗時は旧 active を温存し no-active 窓を作らない)。 成功後に旧 active を supersede。
  const isoNow = new Date(now).toISOString();
  const id = crypto.randomUUID();
  try {
    await insertRankDiscount(db, {
      id,
      friendId,
      rankId,
      code: result.actualCode,
      shopifyDiscountNodeId: result.discountNodeId,
      discountPercent,
      issuedAt: isoNow,
      expiresAt: endsAt,
      brandId: options.brandId ?? null,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // insert 失敗 → 旧 active は無傷 (= 安全な失敗、 no-active 窓なし)。 Shopify には orphan が残る (将来 cron 補正余地)。
    console.error('[rank-discount-issuer] insert failed:', errMsg);
    await auditSystem(db, {
      action: 'loyalty_rank_discount.issue_failed',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'db_insert', rankId, shopifyDiscountNodeId: result.discountNodeId },
    });
    return null;
  }
  // insert 成功後に旧 active を supersede (= 新 id は除外し新行を消さない)。
  // best-effort: 失敗しても reads は issued_at DESC で新を返すため安全 (旧が残存するだけ)。
  if (existing) {
    try {
      await supersedeActiveRankDiscounts(db, friendId, isoNow, id);
    } catch (err) {
      console.error(
        '[rank-discount-issuer] supersede failed (旧 active 残存するが reads は新を返す):',
        err instanceof Error ? err.message : String(err),
      );
    }
    // 旧コードを Shopify 側でも殺す (PR-D)。従来は endsAt (最長45日) まで旧%が生きたままだった。
    //   順序は insert先行→deactivate (no-active 窓を作らない設計を維持)。新旧が同時に生きる窓は
    //   この数百 ms のみ + 同時利用には両コードを同一 checkout に入力する必要があり実害は無視できる。
    //   best-effort: 失敗時はマーカー NULL のまま残り、日次 sweep (03:40) が拾って再試行する。
    //   ⚠️ sweep は gate COUPON_SWEEP_ENABLED (2026-08-15 時点で本番未投入) の内側 — gate 開放まで
    //   再試行網は dormant で、失敗した旧コードは endsAt まで生存する (被害は 45 日で有界)。
    //   期限切れ済みの旧コードは Shopify 側で自然死しているため API を呼ばずマークのみ。
    try {
      const alreadyDead = existing.expiresAt !== null && existing.expiresAt <= isoNow;
      if (!existing.shopifyDiscountNodeId || alreadyDead) {
        await markRankDiscountShopifyDeactivated(db, existing.id, isoNow);
      } else {
        const dr = await deactivateDiscountCode(
          env.SHOPIFY_STORE_DOMAIN,
          accessToken,
          existing.shopifyDiscountNodeId,
          fetchImpl,
        );
        if (dr.ok) {
          await markRankDiscountShopifyDeactivated(db, existing.id, isoNow);
        } else {
          console.error('[rank-discount-issuer] old code deactivate failed (sweep が再試行):', dr.error);
        }
      }
    } catch (err) {
      console.error(
        '[rank-discount-issuer] old code deactivate failed (sweep が再試行):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  await auditSystem(db, {
    action: 'loyalty_rank_discount.issued',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId,
    result: 'success',
    metadata: {
      code: result.actualCode,
      shopifyDiscountNodeId: result.discountNodeId,
      rankId,
      discountPercent,
      validDays,
      customerLimited: customerGid !== null,
      supersededId: existing?.id ?? null,
    },
  });

  return {
    code: result.actualCode,
    discountPercent,
    rankId,
    expiresAt: endsAt,
    isExisting: false,
    shopifyDiscountNodeId: result.discountNodeId,
  };
}

// ============================================================
// test 用 export
// ============================================================

export const __test__ = {
  generateRankCode,
  rankLabel,
  callRankDiscountCreate,
  SHOPIFY_API_VERSION,
  SHOPIFY_TIMEOUT_MS,
  DEFAULT_VALID_DAYS,
  REISSUE_MIN_REMAINING_DAYS,
  REISSUE_MIN_REMAINING_MS,
  CODE_CHARS,
  CODE_SUFFIX_LENGTH,
  CODE_NAMESPACE,
};
