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
 * 照合設計 (誤連携 = 他人の購入履歴の露出 なので保守的に。 adversarial review 反映済):
 *   - customer 解決: CSV email → shopify_customers.email (COLLATE NOCASE)。 ちょうど1件のみ採用。
 *   - friend 解決:
 *     - lineUserId があれば唯一の照合キー。 **不一致なら表示名へフォールバックしない**
 *       (最強キーで不在が確定した人を、 弱い表示名一致で別人に link する事故を防ぐ / review HIGH)。
 *     - lineUserId が無い場合は表示名。 曖昧性の判定基準は **空白正規化後の一致集合**
 *       (完全一致1件でも正規化で複数一致するなら ambiguous として自動連携しない / review MEDIUM)。
 *       正規化は SQL の REPLACE と完全に同じ「半角スペース U+0020 + 全角スペース U+3000 の除去」のみ。
 *   - batch 内で同一 friend / 同一 customer を複数 entry が狙った場合は 2 件目以降を conflict 扱い
 *     (dry-run が実行結果を過大報告しないため)。
 *   - customer が既に別 friend に連携済 / friend が別 customer に連携済 → conflict で skip
 *     (UNIQUE partial index の constraint throw は事前検査 + race 時の catch で分類)。
 *   - dryRun 既定 true。 明示的に dryRun:false のときのみ書込。 冪等 (再実行は already_linked)。
 *   - entry 不備 (null 等) は per-entry で隔離し batch を止めない。
 *
 * ランクの扱い:
 *   legacyRank (DMM 側ランク) は **書き込まない** (ランクは trailing-12mo 購入額から自動算出)。
 *   audit_logs の metadata に記録して移行後の突合 (計算ランク vs DMM ランク) に使う。
 *   PII 最小化: email は audit にも console にも残さない (shopifyCustomerId で識別十分、 OTP 経路と同方針)。
 *
 * 制約 (既知・単一アカウント前提):
 *   friend 照合は line_account_id で絞っていない。 第2アカウント (健康エクスプレス) 追加時は
 *   lineAccountId パラメータを追加してから使うこと (review LOW)。
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
  | 'no_friend'           // friend が見つからない (lineUserId 不一致もここ・fallback なし)
  | 'ambiguous_friend'    // friend が一意に定まらない (正規化一致が複数)
  | 'friend_linked_other' // friend が既に別 customer に連携済 (batch 内先取り含む)
  | 'customer_linked_other' // customer が既に別 friend に連携済 (batch 内先取り・race 含む)
  | 'invalid'             // entry 不備 (非 object / email 欠落 / payload 内重複)
  | 'error';              // 個別処理の例外 (他 entry は継続)

const VALID_RANKS = new Set(['regular', 'bronze', 'silver', 'gold', 'platinum']);

export interface DmmImportEntry {
  email?: unknown;
  displayName?: unknown;
  /** DMM 側ランク (bronze/silver/gold/platinum)。 audit 記録用で書込には使わない */
  legacyRank?: unknown;
  /** あれば唯一の照合キー (不一致時は表示名へフォールバックしない) */
  lineUserId?: unknown;
}

export interface DmmImportRowResult {
  email: string;
  displayName: string | null;
  legacyRank: string | null;
  /** 入力に lineUserId があった場合に echo (dry-run レビューで強キーの有無を可視化) */
  lineUserId?: string;
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

/**
 * 表示名の空白正規化。 **SQL 側の REPLACE(REPLACE(display_name, ' ', ''), '　', '') と
 * 完全に同じ変換であること** (半角スペース U+0020 と 全角スペース U+3000 のみ除去)。
 * \s 全体を使うと SQL 側と一致集合がずれ、 ambiguity 判定に穴が空く (review MEDIUM)。
 */
function normalizeDisplayName(name: string): string {
  return name.replace(/[ 　]+/g, '');
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
  // SQL 側の正規化は normalizeDisplayName と同一変換 (U+0020 / U+3000 の除去のみ)
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
 * 1 entry の失敗 (不正 entry / D1 例外) は他 entry を止めない。
 */
export async function processDmmRankImport(
  db: D1Database,
  entries: DmmImportEntry[],
  opts: { dryRun: boolean },
): Promise<DmmImportOutcome> {
  const summary = emptySummary();
  const results: DmmImportRowResult[] = [];
  const seenEmails = new Set<string>();
  // batch 内の先取り検出 (dry-run が「実行したら実際に link できる数」を過大報告しないため)
  const claimedFriends = new Set<string>();
  const claimedCustomers = new Set<string>();

  const push = (row: DmmImportRowResult): void => {
    summary[row.status] += 1;
    results.push(row);
  };

  for (let index = 0; index < entries.length; index++) {
    const raw = entries[index];

    // entry 不備は per-entry で隔離 (null 等で batch 全体を 500 にしない / review MEDIUM)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      push({ email: '', displayName: null, legacyRank: null, status: 'invalid', detail: `entry #${index} is not an object` });
      continue;
    }

    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
    const rankRaw = typeof raw.legacyRank === 'string' ? raw.legacyRank.trim().toLowerCase() : '';
    const legacyRank = VALID_RANKS.has(rankRaw) ? rankRaw : null;
    const lineUserId = typeof raw.lineUserId === 'string' ? raw.lineUserId.trim() : '';

    const base: Pick<DmmImportRowResult, 'email' | 'displayName' | 'legacyRank' | 'lineUserId'> = {
      email,
      displayName: displayName || null,
      legacyRank,
      ...(lineUserId ? { lineUserId } : {}),
    };

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

      // 2. LINE friend 解決
      let friend: FriendRow | null = null;
      let matchedBy: DmmImportRowResult['matchedBy'];

      if (lineUserId) {
        // 最強キー。 不一致 = 「friends に存在しない」が確定 → 弱い表示名一致へは
        // フォールバックしない (同名別人への誤連携防止 / review HIGH)
        const byUid = await findFriendsByLineUserId(db, lineUserId);
        if (byUid.length === 0) {
          push({ ...base, status: 'no_friend', customerId, detail: 'lineUserId not found — display_name fallback is intentionally disabled' });
          continue;
        }
        if (byUid.length > 1) {
          push({ ...base, status: 'ambiguous_friend', customerId, detail: `${byUid.length} friends share this lineUserId` });
          continue;
        }
        friend = byUid[0];
        matchedBy = 'line_user_id';
      } else if (displayName) {
        // 曖昧性の判定基準は正規化後の一致集合 (完全一致の superset)。
        // 完全一致1件でも正規化で複数いれば ambiguous (review MEDIUM)
        const normalized = normalizeDisplayName(displayName);
        if (!normalized) {
          push({ ...base, status: 'no_friend', customerId, detail: 'display name is whitespace only' });
          continue;
        }
        const normMatches = await findFriendsByNormalizedName(db, normalized);
        if (normMatches.length === 0) {
          push({ ...base, status: 'no_friend', customerId });
          continue;
        }
        if (normMatches.length > 1) {
          push({ ...base, status: 'ambiguous_friend', customerId, detail: `${normMatches.length} friends match after whitespace normalization` });
          continue;
        }
        const exact = await findFriendsByDisplayName(db, displayName);
        matchedBy =
          exact.length === 1 && exact[0].id === normMatches[0].id
            ? 'display_name'
            : 'display_name_normalized';
        friend = normMatches[0];
      } else {
        push({ ...base, status: 'no_friend', customerId, detail: 'no displayName or lineUserId to match on' });
        continue;
      }

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

      // 4. batch 内の先取り検査 (同一 friend / customer を複数 entry が狙った場合、 2件目は conflict)
      if (claimedFriends.has(friend.id)) {
        push({ ...base, status: 'friend_linked_other', friendId: friend.id, customerId, matchedBy, detail: 'friend already targeted earlier in this batch' });
        continue;
      }
      if (claimedCustomers.has(customerId)) {
        push({ ...base, status: 'customer_linked_other', friendId: friend.id, customerId, matchedBy, detail: 'customer already targeted earlier in this batch' });
        continue;
      }

      // 5. dryRun なら linkable 報告のみ (claim して以降の entry と整合)
      if (opts.dryRun) {
        claimedFriends.add(friend.id);
        claimedCustomers.add(customerId);
        push({ ...base, status: 'linkable', friendId: friend.id, customerId, matchedBy });
        continue;
      }

      // 6. 実行: 条件付き UPDATE (friend 側 NULL のときのみ)。
      //    customer 側 UNIQUE partial index の race は catch で分類 (review LOW)
      let linkRes: { linked: boolean };
      try {
        linkRes = await setFriendShopifyCustomerId(db, friend.id, customerId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (/unique/i.test(msg)) {
          push({ ...base, status: 'customer_linked_other', friendId: friend.id, customerId, matchedBy, detail: 'raced: customer was linked concurrently (unique constraint)' });
          continue;
        }
        throw err;
      }
      if (!linkRes.linked) {
        // pre-check 後に他経路 (OTP/cron) が先に link したレース。 上書きしない
        push({ ...base, status: 'friend_linked_other', friendId: friend.id, customerId, matchedBy, detail: 'raced: friend was linked concurrently' });
        continue;
      }
      claimedFriends.add(friend.id);
      claimedCustomers.add(customerId);

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
      // PII 最小化: email を console に残さない (entry 番号で特定可能 / review MEDIUM)
      console.error(`[dmm-rank-import] entry #${index} failed:`, err instanceof Error ? err.message : 'unknown error');
      push({ ...base, status: 'error', detail: err instanceof Error ? err.message : 'unknown error' });
    }
  }

  return { dryRun: opts.dryRun, results, summary };
}
