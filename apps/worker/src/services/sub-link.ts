/**
 * サブスク連携獲得キット (magic-link) サービス層 (2026-07-24)
 *
 * 背景 (本番実測):
 *   稼働中サブスク顧客 112 名のうち LINE 連携済は 3 名 (2.7%)、 自前 email 到達は 0 名。
 *   決済リマインド等を LINE で作っても 109 名に届かない → まず「連携率」を上げる必要がある。
 *   本サービスは、 店舗が顧客の受信箱へ送る email/挿入物に載せる「1タップ連携リンク」を提供する。
 *
 * フロー:
 *   ① generateSubLinkBatch (admin/API_KEY): 未連携サブスク顧客ごとに使い捨てトークンを発行し、
 *      link = `${LIFF_URL}?slk=<token>` と email/氏名/プラン名を返す (= 店舗が mail-merge/挿入物に使う)。
 *   ② 顧客が link を開く → (未友だちなら友だち追加) → LIFF portal が ?slk= を検出。
 *   ③ previewSubLinkToken (idToken): トークンを検証しプランを提示 (= 消費しない)。
 *   ④ redeemSubLinkToken (idToken): single-use CAS 消費 → friends.shopify_customer_id を紐付け。
 *
 * セキュリティ (= なぜ OTP なしで安全か):
 *   - token = 160bit ランダム = 推測不能。 顧客の受信箱に届いた事実が email 所有の証明。
 *   - single-use (consumed_at CAS): 転送 link を複数人が踏んでも先着 1 人のみ連携。
 *   - friends.shopify_customer_id の UNIQUE partial index: 1 customer ≤ 1 friend を DB が担保
 *     (= 既連携顧客の乗っ取りは redeem の事前検査 + UNIQUE 制約で二重防止)。
 *   - gate SUB_LINK_ENABLED='true' でなければ生成/redeem とも no-op (= 本番 dormant)。
 *   - PII 最小化: token 行・audit_logs に email/氏名を残さない。 preview は氏名/emailを一切返さない。
 */

import {
  insertSubLinkToken,
  getSubLinkToken,
  consumeSubLinkTokenCas,
  releaseSubLinkToken,
  deleteUnconsumedSubLinkTokensForCustomer,
  getSubLinkTokenStats,
  getFriendById,
  getFriendByShopifyCustomerId,
  setFriendShopifyCustomerId,
  linkShopifyCustomerToFriend,
  jstNow,
  toJstString,
  type SubLinkTokenStats,
} from '@line-crm/db';
import { parseCustomerSubscriptionTags, parseIntervalDays } from './subscription-contracts.js';
import { auditSystem } from './audit-logger.js';

const TTL_DAYS_DEFAULT = 30;
const TTL_DAYS_MAX = 90;
const MAX_BATCH = 500;

/**
 * App Proxy 発行トークンの batch_id (services/app-proxy-link.ts が使用)。
 * preview/redeem はこの値で「定期購入 (email キャンペーン)」と「お買い物アカウント (App Proxy)」の
 * 文言分岐用 kind を導出する。
 */
export const APP_PROXY_BATCH_ID = 'app-proxy';

/** LIFF 側の文言分岐: subscription = magic-link キャンペーン / shop = App Proxy 自動連携。 */
export type SubLinkKind = 'subscription' | 'shop';

function kindOfBatch(batchId: string | null | undefined): SubLinkKind {
  return batchId === APP_PROXY_BATCH_ID ? 'shop' : 'subscription';
}

interface EnvLike {
  DB: D1Database;
  LIFF_URL?: string;
  SUB_LINK_ENABLED?: string;
  APP_PROXY_LINK_ENABLED?: string;
}

/**
 * generate (= 店舗発の email キャンペーン用バッチ生成) は magic-link gate のみで制御する。
 * App Proxy だけを有効化した状態で admin API から 30日 link を量産できてしまうと、
 * 「キャンペーンは止めたまま自動連携だけ動かす」という運用が成立しなくなるため。
 */
function isGenerateEnabled(env: EnvLike): boolean {
  return (env.SUB_LINK_ENABLED ?? '') === 'true';
}

/**
 * status (= 観測点) は、 token を発行しうるどちらかの経路が有効なら動く。
 */
function isAnyGateEnabled(env: EnvLike): boolean {
  return (env.SUB_LINK_ENABLED ?? '') === 'true' || (env.APP_PROXY_LINK_ENABLED ?? '') === 'true';
}

/**
 * **token 行の発行経路ごと**に受け入れ可否を判定する (R1 採点 MED の反映)。
 * OR 結合にすると「magic-link キャンペーンを止める目的で SUB_LINK_ENABLED=false にした後、
 * App Proxy を有効化した瞬間に未消費の 30日 link が全部よみがえる」= kill switch が効かない。
 * batch_id='app-proxy' の token は APP_PROXY_LINK_ENABLED、 それ以外は SUB_LINK_ENABLED を要求する。
 */
function isTokenAccepted(env: EnvLike, batchId: string | null | undefined): boolean {
  return kindOfBatch(batchId) === 'shop'
    ? (env.APP_PROXY_LINK_ENABLED ?? '') === 'true'
    : (env.SUB_LINK_ENABLED ?? '') === 'true';
}

/** 160bit crypto ランダムを base64url に (= 推測不能な link capability)。 */
function generateLinkToken(): string {
  const buf = new Uint8Array(20);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 顧客タグから代表 (= 最初の未解約) プランを抽出。 */
function extractPrimaryPlan(tags: string | null | undefined): { planName: string | null; intervalDays: number | null } {
  const map = parseCustomerSubscriptionTags(tags);
  for (const state of map.values()) {
    if (state.cancelledAt) continue;
    if (state.planName) {
      return { planName: state.planName, intervalDays: parseIntervalDays(state.planName) };
    }
  }
  return { planName: null, intervalDays: null };
}

// ============================================================
// generate (admin)
// ============================================================

export interface GenerateBatchInput {
  /** 明示指定の customer id 群 (= 省略時は未連携サブスク顧客を自動選定)。 */
  customerIds?: string[];
  /** true なら「LINE 連携済 (following)」顧客を除外 (既定 true)。 */
  onlyUnlinked?: boolean;
  /** トークン有効日数 (既定 30、 最大 90)。 */
  expiresInDays?: number;
  /** 自動選定時の上限 (既定 MAX_BATCH)。 */
  limit?: number;
}

export interface GenerateBatchEntry {
  shopifyCustomerId: string;
  email: string;
  name: string;
  plan: string | null;
  intervalDays: number | null;
  link: string;
}

export type GenerateBatchResult =
  | {
      ok: true;
      batchId: string;
      expiresAt: string;
      count: number;
      entries: GenerateBatchEntry[];
    }
  | { ok: false; code: 'disabled' | 'misconfigured' | 'invalid_input' };

interface CustomerRow {
  shopify_customer_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  tags: string | null;
}

export async function generateSubLinkBatch(
  env: EnvLike,
  input: GenerateBatchInput = {},
): Promise<GenerateBatchResult> {
  if (!isGenerateEnabled(env)) return { ok: false, code: 'disabled' };
  const liffUrl = (env.LIFF_URL ?? '').trim();
  if (!liffUrl) return { ok: false, code: 'misconfigured' };

  const db = env.DB;
  const onlyUnlinked = input.onlyUnlinked !== false;
  const ttlDays = Math.min(Math.max(Math.floor(input.expiresInDays ?? TTL_DAYS_DEFAULT), 1), TTL_DAYS_MAX);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? MAX_BATCH), 1), MAX_BATCH);

  // 対象顧客の選定
  let rows: CustomerRow[];
  if (Array.isArray(input.customerIds) && input.customerIds.length > 0) {
    // 重複 id を除去 (= 同一 customer を 2 回処理すると後段の delete が前段の insert を消し、
    // entries に載った link が DB 不在の死にリンクになる)
    const ids = [...new Set(input.customerIds.filter((v): v is string => typeof v === 'string' && v.length > 0))];
    if (ids.length === 0 || ids.length > MAX_BATCH) return { ok: false, code: 'invalid_input' };
    const placeholders = ids.map(() => '?').join(',');
    const res = await db
      .prepare(
        `SELECT shopify_customer_id, email, first_name, last_name, tags
           FROM shopify_customers WHERE shopify_customer_id IN (${placeholders})`,
      )
      .bind(...ids)
      .all<CustomerRow>();
    rows = res.results ?? [];
  } else {
    // 自動選定: tags に subscription を含み cancel を含まない (= 保守的・解約者は除外) + email あり
    // onlyUnlinked は「いずれかの friend に連携済」を除外する (= is_following を問わない)。
    // redeem の taken 検査 (getFriendByShopifyCustomerId = following 不問) と述語を一致させ、
    // ブロック/退会済 friend に占有された顧客へ死にリンクを発行しないようにする。
    const unlinkedClause = onlyUnlinked
      ? `AND NOT EXISTS (SELECT 1 FROM friends f WHERE f.shopify_customer_id = sc.shopify_customer_id)`
      : '';
    const res = await db
      .prepare(
        `SELECT sc.shopify_customer_id, sc.email, sc.first_name, sc.last_name, sc.tags
           FROM shopify_customers sc
          WHERE sc.tags LIKE '%subscription%' AND sc.tags NOT LIKE '%cancel%'
            AND sc.email IS NOT NULL AND sc.email != ''
            ${unlinkedClause}
          ORDER BY sc.updated_at DESC
          LIMIT ?`,
      )
      .bind(limit)
      .all<CustomerRow>();
    rows = res.results ?? [];
  }

  const batchId = crypto.randomUUID();
  const now = jstNow();
  // expires_at は jstNow() と同じ +09:00 固定幅 JST 形式にする (= 文字列/SQL 比較が
  // 辞書順=時系列で一致する。 toISOString() の 'Z' だと jstNow() との比較が壊れる)。
  const expiresAt = toJstString(new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000));

  const entries: GenerateBatchEntry[] = [];
  for (const r of rows) {
    if (!r.shopify_customer_id) continue;
    if (!r.email) continue; // email 無しは連携キャンペーンに載せられない
    // 旧 unconsumed トークンを掃除 (= 再生成で古い link を無効化)
    await deleteUnconsumedSubLinkTokensForCustomer(db, r.shopify_customer_id);
    const token = generateLinkToken();
    await insertSubLinkToken(db, {
      token,
      shopifyCustomerId: r.shopify_customer_id,
      batchId,
      expiresAt,
      createdAt: now,
    });
    const { planName, intervalDays } = extractPrimaryPlan(r.tags);
    const name = [r.last_name, r.first_name].filter((v) => v && v.trim()).join(' ').trim();
    entries.push({
      shopifyCustomerId: r.shopify_customer_id,
      email: r.email,
      name,
      plan: planName,
      intervalDays,
      link: `${liffUrl}?slk=${token}`,
    });
  }

  return { ok: true, batchId, expiresAt, count: entries.length, entries };
}

// ============================================================
// preview (LIFF idToken) — 消費しない。 PII を返さない。
// ============================================================

export type PreviewStatus =
  | 'ready'
  | 'already_self'
  | 'friend_conflict'
  | 'taken'
  | 'expired'
  | 'used'
  | 'invalid';

export type PreviewResult =
  | {
      ok: true;
      status: PreviewStatus;
      plan: string | null;
      intervalDays: number | null;
      kind: SubLinkKind;
      /** 連携先を識別できる最小ヒント (マスク済 email)。 ready 時のみ非 null */
      hint: string | null;
    }
  | { ok: false; code: 'disabled' };

/**
 * トークンを検証しプランを提示 (= 消費しない)。
 * 判定順序は redeem と一致させる (= preview で ready を出したボタンが redeem で必ず失敗する
 * 「死んだボタン」を防ぐ)。 プラン (=対象顧客のサブスク内容) は「連携当事者」に対してのみ開示し、
 * used/taken/expired/friend_conflict では null を返す (= 転送 link 保持者への情報開示を防ぐ)。
 */
export async function previewSubLinkToken(
  env: EnvLike,
  input: { token: string; friendId: string },
): Promise<PreviewResult> {
  if (!isAnyGateEnabled(env)) return { ok: false, code: 'disabled' };
  const db = env.DB;
  const row = await getSubLinkToken(db, input.token);
  if (!row) return { ok: true, status: 'invalid', plan: null, intervalDays: null, kind: 'subscription', hint: null };
  // 発行経路の gate が閉じた token は「無効」として扱う (= 存在も内容も開示しない)
  if (!isTokenAccepted(env, row.batch_id)) {
    return { ok: true, status: 'invalid', plan: null, intervalDays: null, kind: 'subscription', hint: null };
  }
  const cid = row.shopify_customer_id;
  const kind = kindOfBatch(row.batch_id);
  // ready のみ「連携先が誰か」を判断できるマスク済ヒントを添える。
  // link fixation (攻撃者の token を被害者に踏ませ、 被害者の LINE を攻撃者の顧客に束縛する)
  // に対して、 唯一の人間確認点である確認カードに識別材料を与えるため (R1 採点 MED)。
  // 開示はマスク済 email のみ (先頭1文字 + ドメイン先頭1文字 + TLD)。
  const legit = async (status: PreviewStatus, withHint = false): Promise<PreviewResult> => {
    const { plan, intervalDays, email } = await loadCustomerPlan(db, cid);
    return { ok: true, status, plan, intervalDays, kind, hint: withHint ? maskEmail(email) : null };
  };
  const opaque = (status: PreviewStatus): PreviewResult => ({
    ok: true,
    status,
    plan: null,
    intervalDays: null,
    kind,
    hint: null,
  });

  // ① 呼び出し元 friend の既連携を最優先で判定 (= redeem と同じ precedence)
  const friend = await getFriendById(db, input.friendId);
  if (friend?.shopify_customer_id) {
    if (friend.shopify_customer_id === cid) return legit('already_self');
    return opaque('friend_conflict'); // この LINE は別顧客に連携済み → ボタンを出さない
  }

  // ② トークン状態
  if (row.consumed_at) {
    if (row.consumed_friend_id === input.friendId) return legit('already_self');
    return opaque('used');
  }
  if (row.expires_at <= jstNow()) return opaque('expired');

  // ③ 連携先が別 friend に占有
  const existing = await getFriendByShopifyCustomerId(db, cid);
  if (existing && existing.id !== input.friendId) return opaque('taken');

  // ④ 連携可能 (= requester が正当な連携当事者。 ここでだけプランと識別ヒントを開示)
  return legit('ready', true);
}

// ============================================================
// redeem (LIFF idToken) — single-use CAS → 連携
// ============================================================

export type RedeemFailure = 'disabled' | 'invalid' | 'expired' | 'used' | 'taken' | 'friend_conflict';

export interface RedeemSummary {
  customerId: string;
  plan: string | null;
  intervalDays: number | null;
  kind: SubLinkKind;
}

export type RedeemResult =
  | { ok: true; alreadyLinked: boolean; summary: RedeemSummary }
  | { ok: false; code: RedeemFailure };

export async function redeemSubLinkToken(
  env: EnvLike,
  input: { token: string; friendId: string; lineUserId: string },
): Promise<RedeemResult> {
  if (!isAnyGateEnabled(env)) return { ok: false, code: 'disabled' };
  const db = env.DB;

  const row = await getSubLinkToken(db, input.token);
  if (!row) return { ok: false, code: 'invalid' };
  // 発行経路の gate が閉じた token は受理しない (= preview の判定と一致・死んだボタンを作らない)
  if (!isTokenAccepted(env, row.batch_id)) return { ok: false, code: 'invalid' };
  const cid = row.shopify_customer_id;
  const kind = kindOfBatch(row.batch_id);
  const summary = async (): Promise<RedeemSummary> => {
    const { plan, intervalDays } = await loadCustomerPlan(db, cid);
    return { customerId: cid, plan, intervalDays, kind };
  };
  // 逆方向リンク (= customer 起点 JOIN を 1 hop に)。 既存 writer を再利用し、
  // shopify_orders.friend_id の後追い補完まで同じ意味論で行う (= 購買データ絞り込み配信が効く)。
  // best-effort: 失敗しても連携本体 (friends 側 = 真実源) は成立済みなので redeem を落とさない。
  const backlink = async (): Promise<void> => {
    try {
      await linkShopifyCustomerToFriend(db, cid, input.friendId);
    } catch (err) {
      console.warn('[sub-link] customer backlink failed (non-fatal):', err instanceof Error ? err.message : 'unknown');
    }
  };
  // 監査 (PII なし)。 idempotent 経路も含め全成功でトークン消費/連携を記録する。
  const auditRedeem = (idempotent: boolean) =>
    auditSystem(db, {
      action: 'account_link.sub_link_redeemed',
      targetType: 'friend',
      targetId: input.friendId,
      result: 'success',
      metadata: { customerId: cid, batchId: row.batch_id, idempotent },
    });

  // 現 friend の連携状態 (= 冪等 / friend 競合の事前検査)
  const friend = await getFriendById(db, input.friendId);
  if (!friend) return { ok: false, code: 'invalid' }; // middleware 通過後の消失は異常系
  if (friend.shopify_customer_id) {
    if (friend.shopify_customer_id === cid) {
      // 既にこの顧客に連携済み: 冪等成功。 未消費なら消費しておく (= link 再利用を封じる)
      if (!row.consumed_at) {
        await consumeSubLinkTokenCas(db, input.token, input.lineUserId, input.friendId, jstNow());
      }
      await backlink(); // 過去 link の逆方向欠損もここで治す
      await auditRedeem(true);
      return { ok: true, alreadyLinked: true, summary: await summary() };
    }
    return { ok: false, code: 'friend_conflict' }; // この LINE は別顧客に連携済み
  }

  // トークン状態
  if (row.consumed_at) return { ok: false, code: 'used' };
  if (row.expires_at <= jstNow()) return { ok: false, code: 'expired' };

  // 連携先が別 friend に既連携なら乗っ取り拒否 (UNIQUE 制約の事前検査)
  const existing = await getFriendByShopifyCustomerId(db, cid);
  if (existing && existing.id !== input.friendId) return { ok: false, code: 'taken' };

  // single-use CAS 消費 (= ここが直列化点。 転送 link の二重踏みはここで先着のみ通す)
  const claim = await consumeSubLinkTokenCas(db, input.token, input.lineUserId, input.friendId, jstNow());
  if (!claim.consumed) return { ok: false, code: 'used' };

  // 連携本体 (CAS on IS NULL)。 失敗系は消費を巻き戻す (= トークンを再利用可能に戻す)
  try {
    const res = await setFriendShopifyCustomerId(db, input.friendId, cid);
    if (!res.linked) {
      // friend が別値を持っていた (競合)。 現況を再確認
      const refreshed = await getFriendById(db, input.friendId);
      if (refreshed?.shopify_customer_id === cid) {
        await backlink();
        await auditRedeem(true);
        return { ok: true, alreadyLinked: true, summary: await summary() };
      }
      await releaseSubLinkToken(db, input.token, input.friendId);
      return { ok: false, code: 'friend_conflict' };
    }
  } catch (err) {
    // UNIQUE 制約 = 同 customer が別 friend に並行連携された
    await releaseSubLinkToken(db, input.token, input.friendId);
    console.warn('[sub-link] link failed (likely unique violation):', err instanceof Error ? err.message : 'unknown');
    return { ok: false, code: 'taken' };
  }

  await backlink();
  await auditRedeem(false);
  return { ok: true, alreadyLinked: false, summary: await summary() };
}

// ============================================================
// status (admin) — 件数のみ
// ============================================================

export async function getSubLinkStatus(env: EnvLike): Promise<{
  enabled: boolean;
  gates: { subLink: boolean; appProxy: boolean };
  tokens: SubLinkTokenStats;
}> {
  const gates = {
    subLink: (env.SUB_LINK_ENABLED ?? '') === 'true',
    appProxy: (env.APP_PROXY_LINK_ENABLED ?? '') === 'true',
  };
  // 両 gate OFF (= 本番 dormant / migration 073 未適用の可能性) では sub_link_tokens を触らない
  // (= generate/preview/redeem と同じ dormancy 不変条件を status にも適用)。
  if (!isAnyGateEnabled(env)) {
    return { enabled: false, gates, tokens: { total: 0, consumed: 0, pending: 0, expired: 0 } };
  }
  const tokens = await getSubLinkTokenStats(env.DB, jstNow());
  return { enabled: true, gates, tokens };
}

// ============================================================
// helpers
// ============================================================

async function loadCustomerPlan(
  db: D1Database,
  shopifyCustomerId: string,
): Promise<{ plan: string | null; intervalDays: number | null; email: string | null }> {
  const row = await db
    .prepare(`SELECT tags, email FROM shopify_customers WHERE shopify_customer_id = ?`)
    .bind(shopifyCustomerId)
    .first<{ tags: string | null; email: string | null }>();
  const { planName, intervalDays } = extractPrimaryPlan(row?.tags);
  return { plan: planName, intervalDays, email: row?.email ?? null };
}

/**
 * email をマスクする (= 本人には自分のものと分かり、 第三者には特定できない粒度)。
 * `hanako@example.com` → `h***@e***.com`。 不正形式は null。
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  if (dot < 1) return null;
  return `${local[0]}***@${domain[0]}***${domain.slice(dot)}`;
}
