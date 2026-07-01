/**
 * DMM チャットブースト ランク保持者の一括連携インポート — 第2波-③ 支援 (2026-07-02)
 *
 * 背景:
 *   移行前の会員ランクは DMM 側に保存されているのではなく Shopify 購入履歴から算出される。
 *   しかし LINE friend ↔ Shopify customer の対応 (= friends.shopify_customer_id) が無いと
 *   復元できない。 本番実測で friends のメール判明数は 0 (DMM からの follow import は
 *   LINE userId のみ) だったが、 DMM の「発行済みクーポン一覧」CSV には
 *   **LINE表示名 + メールアドレス + ランク** が揃っている → これを照合キーに一括連携する。
 *
 * 照合設計 (誤連携 = 他人の購入履歴の露出 なので保守的に):
 *   - customer 解決: CSV email → shopify_customers.email (COLLATE NOCASE)。 ちょうど1件のみ採用。
 *   - friend 解決: lineUserId があれば最優先 (exact key)。 無ければ display_name の完全一致、
 *     0件なら空白正規化 (半角/全角スペース除去) 一致。 いずれも **一意に定まる場合のみ** 採用。
 *     複数一致 (ambiguous) は自動連携しない → セルフ連携 (OTP) に委ねる。
 *   - customer が既に別 friend に連携済 / friend が別 customer に連携済 → conflict で skip
 *     (UNIQUE partial index の constraint throw を事前回避)。
 *   - dryRun 既定 true。 明示的に dryRun:false のときのみ書込。
 *   - 冪等: 同じ CSV を再実行しても already_linked で no-op。
 *
 * ランクの扱い:
 *   legacyRank (DMM 側ランク) は **書き込まない** (ランクは trailing-12mo 購入額から自動算出)。
 *   audit_logs の metadata に記録して移行後の突合 (計算ランク vs DMM ランク) に使う。
 *   PII 最小化: email は audit に残さない (shopifyCustomerId で識別十分、 OTP 経路と同方針)。
 *
 * 関連:
 *   - apps/worker/src/routes/account-link-admin.ts (= POST /api/admin/account-link/import-dmm)
 *   - apps/worker/src/services/account-link.ts (= セルフ連携 OTP、 本経路)
 *   - apps/worker/src/services/member-purchase-backfill.ts (= 連携後の過去注文 backfill)
 *   - packages/db/src/friends.ts setFriendShopifyCustomerId / getFriendByShopifyCustomerId
 */

import { setFriendShopifyCustomerId, getFriendByShopifyCustomerId } from '@line-crm/db';
import { auditSystem } from './audit-logger.js';

export type DmmImportStatus =
  | 'linked'              // 実行モードで新規に連携した
  | 'linkable'            // dryRun で「実行すれば連携できる」
  | 'already_linked'      // 既に同じ customer に連携済 (冪等 no-op)
  | 'no_customer'         // email が shopify_customers に見つからない
  | 'multiple_customers'  // email が複数の customer に一致 (曖昧)
  | 'no_friend'           // 表示名が friends に見つからない
  | 'ambiguous_friend'    // 表示名が複数の friend に一致 (曖昧)
  | 'friend_linked_other' // friend が既に別 customer に連携済
  | 'customer_linked_other' // customer が既に別 friend に連携済
  | 'invalid'             // entry 不備 (email 欠落 / payload 内重複)
  | 'error';              // 個別処理の例外 (他 entry は継続)

const VALID_RANKS = new Set(['regular', 'bronze', 'silver', 'gold', 'platinum']);

export interface DmmImportEntry {
  email?: unknown;
  displayName?: unknown;
  /** DMM 側ランク (bronze/silver/gold/platinum)。 audit 記録用で書込には使わない */
  legacyRank?: unknown;
  /** あれば最優先の照合キー (DMM 顧客管理 export に含まれる場合) */
  lineUserId?: unknown;
}

export interface DmmImportRowResult {
  email: string;
  displayName: string | null;
  legacyRank: string | null;
  status: DmmImportStatus;
  matchedBy?: 'line_user_id' | 'display_name' | 'display_name_normalized';
  friendId?: string;
  customerId?: string;
  detail?: string;
}

export interface DmmImportOutcome {
  dryRun: boolean;
  results: DmmImportRowResult[];
  summary: Record<DmmImportStatus, number>;
}

interface FriendRow {
  id: string;
  shopify_customer_id: string | null;
}

/** 半角/全角スペースを除去 (LINE 表示名の空白ゆれ対策。 "Yuka  Hirayama" vs "Yuka Hirayama") */
function normalizeDisplayName(name: string): string {
  return name.replace(/[\s　]+/g, '');
}

function emptySummary(): Record<DmmImportStatus, number> {
  return {
    linked: 0,
    linkable: 0,
    already_linked: 0,
    no_customer: 0,
    multiple_customers: 0,
    no_friend: 0,
    ambiguous_friend: 0,
    friend_linked_other: 0,
    customer_linked_other: 0,
    invalid: 0,
    error: 0,
  };
}

async function findCustomerIdsByEmail(db: D1Database, email: string): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT DISTINCT shopify_customer_id FROM shopify_customers
        WHERE email = ? COLLATE NOCASE AND shopify_customer_id IS NOT NULL`,
    )
    .bind(email)
    .all<{ shopify_customer_id: string }>();
  return (res.results ?? []).map((r) => String(r.shopify_customer_id));
}

async function findFriendsByLineUserId(db: D1Database, lineUserId: string): Promise<FriendRow[]> {
  const res = await db
    .prepare(`SELECT id, shopify_customer_id FROM friends WHERE line_user_id = ? LIMIT 3`)
    .bind(lineUserId)
    .all<FriendRow>();
  return res.results ?? [];
}

async function findFriendsByDisplayName(db: D1Database, displayName: string): Promise<FriendRow[]> {
  const res = await db
    .prepare(`SELECT id, shopify_customer_id FROM friends WHERE display_name = ? LIMIT 3`)
    .bind(displayName)
    .all<FriendRow>();
  return res.results ?? [];
}

async function findFriendsByNormalizedName(db: D1Database, normalized: string): Promise<FriendRow[]> {
  // SQL 側も同じ正規化 (半角スペース + 全角スペース除去) を適用して比較
  const res = await db
    .prepare(
      `SELECT id, shopify_customer_id FROM friends
        WHERE REPLACE(REPLACE(display_name, ' ', ''), '　', '') = ? LIMIT 3`,
    )
    .bind(normalized)
    .all<FriendRow>();
  return res.results ?? [];
}

/**
 * DMM CSV entries を照合して friend↔customer link を確定する (dryRun 既定)。
 * 1 entry の失敗は他 entry を止めない。 戻り値は per-entry 結果 + status 集計。
 */
export async function processDmmRankImport(
  db: D1Database,
  entries: DmmImportEntry[],
  opts: { dryRun: boolean },
): Promise<DmmImportOutcome> {
  const summary = emptySummary();
  const results: DmmImportRowResult[] = [];
  const seenEmails = new Set<string>();

  const push = (row: DmmImportRowResult): void => {
    summary[row.status] += 1;
    results.push(row);
  };

  for (const raw of entries) {
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
    const rankRaw = typeof raw.legacyRank === 'string' ? raw.legacyRank.trim().toLowerCase() : '';
    const legacyRank = VALID_RANKS.has(rankRaw) ? rankRaw : null;
    const lineUserId = typeof raw.lineUserId === 'string' ? raw.lineUserId.trim() : '';

    const base = { email, displayName: displayName || null, legacyRank };

    if (!email) {
      push({ ...base, status: 'invalid', detail: 'email is required' });
      continue;
    }
    if (seenEmails.has(email)) {
      push({ ...base, status: 'invalid', detail: 'duplicate email in payload' });
      continue;
    }
    seenEmails.add(email);

    try {
      // 1. Shopify customer 解決 (email → ちょうど1件)
      const customerIds = await findCustomerIdsByEmail(db, email);
      if (customerIds.length === 0) {
        push({ ...base, status: 'no_customer' });
        continue;
      }
      if (customerIds.length > 1) {
        push({ ...base, status: 'multiple_customers', detail: `${customerIds.length} customers share this email` });
        continue;
      }
      const customerId = customerIds[0];

      // 2. LINE friend 解決 (lineUserId 最優先 → display_name 完全一致 → 空白正規化一致)
      let candidates: FriendRow[] = [];
      let matchedBy: DmmImportRowResult['matchedBy'];
      if (lineUserId) {
        candidates = await findFriendsByLineUserId(db, lineUserId);
        matchedBy = 'line_user_id';
      }
      if (candidates.length === 0 && displayName) {
        candidates = await findFriendsByDisplayName(db, displayName);
        matchedBy = 'display_name';
        if (candidates.length === 0) {
          const normalized = normalizeDisplayName(displayName);
          if (normalized) {
            candidates = await findFriendsByNormalizedName(db, normalized);
            matchedBy = 'display_name_normalized';
          }
        }
      }
      if (candidates.length === 0) {
        push({ ...base, status: 'no_friend', customerId });
        continue;
      }
      if (candidates.length > 1) {
        // 誤連携 (= 他人の購入履歴露出) 防止: 一意でない場合は自動連携しない
        push({ ...base, status: 'ambiguous_friend', customerId, detail: `${candidates.length} friends match` });
        continue;
      }
      const friend = candidates[0];

      // 3. 既存 link との整合検査
      if (friend.shopify_customer_id !== null && friend.shopify_customer_id !== undefined && friend.shopify_customer_id !== '') {
        if (String(friend.shopify_customer_id) === customerId) {
          push({ ...base, status: 'already_linked', friendId: friend.id, customerId, matchedBy });
        } else {
          push({ ...base, status: 'friend_linked_other', friendId: friend.id, customerId, matchedBy });
        }
        continue;
      }
      const owner = await getFriendByShopifyCustomerId(db, customerId);
      if (owner && owner.id !== friend.id) {
        push({ ...base, status: 'customer_linked_other', friendId: friend.id, customerId, matchedBy });
        continue;
      }

      // 4. dryRun なら linkable 報告のみ
      if (opts.dryRun) {
        push({ ...base, status: 'linkable', friendId: friend.id, customerId, matchedBy });
        continue;
      }

      // 5. 実行: 条件付き UPDATE (friend 側 NULL のときのみ = 並行実行でも安全)
      const { linked } = await setFriendShopifyCustomerId(db, friend.id, customerId);
      if (!linked) {
        // pre-check 後に他経路 (OTP/cron) が先に link したレース。 上書きしない
        push({ ...base, status: 'friend_linked_other', friendId: friend.id, customerId, matchedBy, detail: 'raced: friend was linked concurrently' });
        continue;
      }

      // 監査: legacyRank を残して移行後の「計算ランク vs DMM ランク」突合に使う (email は残さない)
      await auditSystem(db, {
        action: 'account_link.dmm_import',
        actorType: 'api',
        targetType: 'friend',
        targetId: friend.id,
        result: 'success',
        metadata: { shopifyCustomerId: customerId, matchedBy, legacyRank },
      });

      push({ ...base, status: 'linked', friendId: friend.id, customerId, matchedBy });
    } catch (err) {
      console.error(`[dmm-rank-import] entry failed (${email}):`, err);
      push({ ...base, status: 'error', detail: err instanceof Error ? err.message : 'unknown error' });
    }
  }

  return { dryRun: opts.dryRun, results, summary };
}
