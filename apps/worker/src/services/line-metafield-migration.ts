/**
 * WI-6: CRM PLUS on LINE 撤去準備 — LINE userId ↔ Shopify customer マッピングの自己所有化
 * (docs/SUBSCRIPTION_ULTRAPLAN_2026-07-14.md / docs/CRMPLUS_UNINSTALL_RUNBOOK.md)
 *
 * 背景: 現行の friend↔customer 連携のうち **reverse 経路** (friend-customer-linker cron) が
 * Social PLUS (CRM PLUS on LINE) の `socialplus.line` customer metafield に依存している
 * (2026-07-19 secret-list 実査: FRIEND_LINK_METAFIELD_*=socialplus/line。forward の
 * ACCOUNT_LINK_METAFIELD_* は未設定でコードデフォルト naturism.line_user_id = 非依存)。
 * CRM PLUS をアンインストールするとアプリ所有の定義・値が削除されうるため、**先に**
 * 自己所有の公開 namespace `lineharness.line_user_id` へ移行する。
 *
 * 設計:
 *   - D1 `friends` (line_user_id × shopify_customer_id) が正 (= single source of truth)。
 *     socialplus.line のコピーではなく D1 から Shopify へ書き戻す (旧値の汚染を持ち込まない)
 *   - **チャンク実行** (採点R1 HIGH): Workers Free プランは外部 subrequest 50/invocation。
 *     migration は 1 件 = 書込1+直読1 の 2 fetch なので、1 呼び出し limit≦20 (既定10) +
 *     offset カーソルで分割し、remaining=0 までループする (account-link-admin.ts と同方式)
 *   - 冪等: metafieldsSet は upsert、定義作成は TAKEN (既存) を成功扱い。再実行は常に安全
 *   - 検証 2 段:
 *       ① 直読 (customer.metafield 直接取得) — 書込直後でも安定するため migration 内で実施
 *       ② 検索経路 (metafields.ns.key 検索 = friend-customer-linker と同経路) —
 *          Shopify の検索インデックス反映が非同期のため verifySearchPathParity として分離。
 *          `useSecret` で FRIEND_LINK secret の実効値を使った検証もでき (採点R1)、
 *          切替 op の成否を operator が検出できる (応答に実効 ns/key を含める)
 *   - 旧 namespace 棚卸し (採点R1): アンインストールは不可逆なので、直前に
 *     auditLegacyMetafieldValues で「socialplus.line に値を持つ customer が全員 D1 に
 *     リンク済みか」を全顧客スキャンで照合する (取り漏らしゼロの証跡)
 *   - ロールバック: FRIEND_LINK secret を socialplus/line に戻すだけ (アンインストール前なら
 *     旧 metafield が残存するため即復旧可)。ACCOUNT_LINK は naturism/line_user_id が移行前実効値
 *
 * 既知の受容事項: friend が別 customer へ re-link した場合、旧 customer の lineharness 値は
 * 残る → 検索経路は値一致 2 件で ambiguous (null) になる。これは forward 連携 (naturism ns)
 * 由来の既存特性と同型で、D1 が正のため機能影響なし (linker は連携済み friend を再走査しない)。
 *
 * 関連:
 *   - services/account-link-shopify.ts (= setCustomerLineUserIdMetafield を再利用)
 *   - services/friend-customer-linker.ts (= findShopifyCustomerByLineId を再利用)
 *   - .github/workflows/admin-ops.yml `switch-link-metafield` / `rollback-link-metafield` op
 */
import { getShopifyAccessToken } from './shopify-token.js';
import { setCustomerLineUserIdMetafield } from './account-link-shopify.js';
import { findShopifyCustomerByLineId, normalizeShopifyCustomerId } from './friend-customer-linker.js';
import { auditSystem } from './audit-logger.js';

// ============================================================
// 定数
// ============================================================

/** 自己所有マッピングの公開 namespace (アプリ非依存 = アンインストールで消えない) */
export const LINEHARNESS_METAFIELD_NAMESPACE = 'lineharness';
export const LINEHARNESS_METAFIELD_KEY = 'line_user_id';

/** CRM PLUS (Social PLUS) の旧 metafield (2026-07-19 secret-list 実査値)。棚卸し対象 */
export const LEGACY_METAFIELD_NAMESPACE = 'socialplus';
export const LEGACY_METAFIELD_KEY = 'line';

const SHOPIFY_API_VERSION = '2026-04';
const SHOPIFY_TIMEOUT_MS = 8_000;
/**
 * 1 呼び出しの処理件数上限。Workers Free プランの外部 subrequest 50/invocation に対し、
 * migration は 1 件 = 2 fetch (書込+直読) + 定義作成 1 + token 数回 → limit 20 で最大 ~45。
 * 既定 10 は安全側。全件は offset ループで処理する (runbook 参照)。
 */
const MIGRATION_MAX_LIMIT = 20;
const MIGRATION_DEFAULT_LIMIT = 10;
/** verify は 1 件 = 1 fetch なので上限を広めに取れる */
const VERIFY_MAX_LIMIT = 40;
const VERIFY_DEFAULT_LIMIT = 20;
/** 棚卸しスキャン: 250 customer/page × 20 page = 5,000 customer/呼び出し (fetch 20 回) */
const LEGACY_AUDIT_PAGE_SIZE = 250;
const LEGACY_AUDIT_MAX_PAGES = 20;
/**
 * 棚卸しで D1 照合する with-value customer の 1 呼び出し予算 (D1 1,000/invocation 対策)。
 * **必ず LEGACY_AUDIT_PAGE_SIZE 以上にする**: 予算判定はページ開始前に行い (採点R2)、
 * 1 ページ内で cap が発生しない = 「照合されないまま走査済み」の customer が構造的に出ない。
 * 予算切れは nextCursor 付きで返し、再呼び出しで新しい予算により自然に完遂できる。
 */
const LEGACY_AUDIT_MATCH_CAP = 300;
const SAFE_METAFIELD_PART = /^[A-Za-z0-9_-]+$/;

// ============================================================
// types
// ============================================================

export interface MigrationEnv {
  DB: D1Database;
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
  FRIEND_LINK_METAFIELD_NAMESPACE?: string;
  FRIEND_LINK_METAFIELD_KEY?: string;
}

export interface MigrationDeps {
  fetchImpl?: typeof fetch;
  getTokenImpl?: typeof getShopifyAccessToken;
  setMetafieldImpl?: typeof setCustomerLineUserIdMetafield;
  findByLineIdImpl?: typeof findShopifyCustomerByLineId;
}

export interface LinkedFriendRow {
  id: string;
  line_user_id: string;
  shopify_customer_id: string;
}

export interface MigrationResult {
  dryRun: boolean;
  /** metafield 定義の状態。exists = 既存 (TAKEN)。offset>0 の呼び出しでは skipped_offset */
  definition: 'created' | 'exists' | 'error' | 'skipped_dry_run' | 'skipped_offset';
  definitionErrors: string[];
  /** D1 の連携済み friend 総数 (= 全体の移行対象) */
  candidatesTotal: number;
  offset: number;
  limit: number;
  /** この呼び出しで処理した件数 */
  processed: number;
  /** 残件数 (= 0 になるまで offset を進めて再呼び出しする) */
  remaining: number;
  written: number;
  /** metafieldsSet の userErrors (business エラー) */
  writeErrors: number;
  /** transport/GraphQL throw (継続して次の friend へ) */
  failed: number;
  /** 直読検証: metafield 値 === line_user_id を確認できた件数 */
  verifiedDirect: number;
  verifyMismatch: number;
  verifyFailed: number;
  firstError: string | null;
}

export interface SearchParityResult {
  candidatesTotal: number;
  offset: number;
  limit: number;
  processed: number;
  /** 残件数 (= 0 になるまで offset を進めて再呼び出しする) */
  remaining: number;
  /** 検索経路で同一 customer に解決できた件数 */
  resolved: number;
  /** 検索は成功したが 0 件/複数件/別 customer だった件数 */
  unresolved: number;
  failed: number;
  /** 実際に検証へ使った ns/key (非機密) — 切替 op の成否を operator が目視確認できる */
  namespace: string;
  key: string;
  nsSource: 'default' | 'friend_link_secret';
  firstError: string | null;
}

export interface LegacyAuditResult {
  pagesScanned: number;
  customersScanned: number;
  /** 旧 metafield (socialplus.line) に値を持つ customer 数 */
  withLegacyValue: number;
  /** うち D1 friends にリンク済みの数 (= 移行でカバー済み) */
  matchedInD1: number;
  /** D1 に無い (取り漏らし候補) の総数 */
  unmatchedTotal: number;
  /** 取り漏らし候補の customer id (最大20件まで列挙。PII でない内部 id のみ) */
  unmatchedCustomerIds: string[];
  /**
   * D1 照合が実行できなかった数 (クエリ throw / gid 解釈不能)。採点R2 HIGH: swallow すると
   * matched/unmatched のどちらにも計上されず「取り漏らしゼロ」が偽 green になる。
   * 合格条件は unmatchedTotal == 0 かつ matchFailed == 0 かつ
   * matchedInD1 + unmatchedTotal + matchFailed == withLegacyValue の算術閉包で判定する
   */
  matchFailed: number;
  /**
   * D1 照合予算 (LEGACY_AUDIT_MATCH_CAP) を使い切ってこの呼び出しを打ち切ったか。
   * true のときは必ず nextCursor 付き = 再呼び出しで続きから完遂できる (採点R2)
   */
  matchingCapped: boolean;
  /** null = 全顧客スキャン完了。非 null = この cursor で再呼び出しして続きを走査 */
  nextCursor: string | null;
  firstError: string | null;
}

interface MetafieldDefinitionCreateResponse {
  data?: {
    metafieldDefinitionCreate?: {
      createdDefinition?: { id?: string } | null;
      userErrors?: Array<{ field?: string[] | null; message?: string; code?: string }> | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface CustomerMetafieldReadResponse {
  data?: {
    customer?: { metafield?: { value?: string | null } | null } | null;
  };
  errors?: Array<{ message: string }>;
}

interface CustomersScanResponse {
  data?: {
    customers?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
      edges?: Array<{
        node?: { id?: string; metafield?: { value?: string | null } | null };
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

// ============================================================
// GraphQL helpers
// ============================================================

async function shopifyGraphql(
  storeDomain: string,
  accessToken: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const url = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * `lineharness.line_user_id` の metafield 定義を作成する (冪等)。
 * 既存 (TAKEN) は 'exists' として成功扱い。定義がなくても metafieldsSet 自体は成立するが、
 * 定義があると Admin での可視性と検索インデックス対象化が保証される。
 */
export async function ensureLineUserIdDefinition(
  storeDomain: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<{ status: 'created' | 'exists' | 'error'; errors: string[] }> {
  const mutation = `
    mutation createLineIdDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { field message code }
      }
    }
  `;
  const variables = {
    definition: {
      name: 'LINE User ID (line-harness)',
      namespace: LINEHARNESS_METAFIELD_NAMESPACE,
      key: LINEHARNESS_METAFIELD_KEY,
      type: 'single_line_text_field',
      ownerType: 'CUSTOMER',
      description:
        'line-harness OSS が管理する LINE userId マッピング (friend↔customer 連携)。手動編集しないでください。',
    },
  };

  const res = await shopifyGraphql(storeDomain, accessToken, { query: mutation, variables }, fetchImpl);
  if (!res.ok) throw new Error(`metafieldDefinitionCreate failed: HTTP ${res.status}`);
  const body = (await res.json()) as MetafieldDefinitionCreateResponse;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`metafieldDefinitionCreate errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }

  const userErrors = body.data?.metafieldDefinitionCreate?.userErrors ?? [];
  if (userErrors.length === 0) return { status: 'created', errors: [] };
  // TAKEN = 同一 (ownerType, namespace, key) の定義が既に存在 → 冪等成功
  if (userErrors.every((e) => e.code === 'TAKEN')) return { status: 'exists', errors: [] };
  return {
    status: 'error',
    errors: userErrors.map((e) => e.message ?? e.code ?? 'unknown'),
  };
}

/** customer の metafield 値を直読する (検索インデックス非依存 = 書込直後でも安定)。 */
export async function readCustomerLineUserIdMetafield(
  storeDomain: string,
  accessToken: string,
  customerId: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  if (!/^\d+$/.test(customerId)) return null;
  const query = `
    query readCustomerLineId($id: ID!, $ns: String!, $key: String!) {
      customer(id: $id) { metafield(namespace: $ns, key: $key) { value } }
    }
  `;
  const variables = {
    id: `gid://shopify/Customer/${customerId}`,
    ns: LINEHARNESS_METAFIELD_NAMESPACE,
    key: LINEHARNESS_METAFIELD_KEY,
  };
  const res = await shopifyGraphql(storeDomain, accessToken, { query, variables }, fetchImpl);
  if (!res.ok) throw new Error(`customer metafield read failed: HTTP ${res.status}`);
  const body = (await res.json()) as CustomerMetafieldReadResponse;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`customer metafield read errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  return body.data?.customer?.metafield?.value ?? null;
}

// ============================================================
// D1
// ============================================================

/** 連携済み friend (= 移行対象) を offset カーソルで列挙。ORDER BY id で順序決定的。 */
export async function listLinkedFriends(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<LinkedFriendRow[]> {
  const result = await db
    .prepare(
      `SELECT id, line_user_id, shopify_customer_id FROM friends
       WHERE shopify_customer_id IS NOT NULL AND line_user_id IS NOT NULL
       ORDER BY id
       LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<LinkedFriendRow>();
  return result.results;
}

export async function countLinkedFriends(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM friends
       WHERE shopify_customer_id IS NOT NULL AND line_user_id IS NOT NULL`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** friends に当該 customer が存在するか (棚卸しの D1 照合)。 */
async function isCustomerLinkedInD1(db: D1Database, customerId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM friends WHERE shopify_customer_id = ? LIMIT 1`)
    .bind(customerId)
    .first<{ id: string }>();
  return row != null;
}

// ============================================================
// main: migration (定義作成 + backfill + 直読検証、チャンク実行)
// ============================================================

export async function migrateLineUserIdMetafields(
  env: MigrationEnv,
  options: { dryRun: boolean; limit?: number; offset?: number },
  deps: MigrationDeps = {},
): Promise<MigrationResult> {
  const limit = clampInt(options.limit, 1, MIGRATION_MAX_LIMIT, MIGRATION_DEFAULT_LIMIT);
  const offset = clampInt(options.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const result: MigrationResult = {
    dryRun: options.dryRun,
    definition: options.dryRun ? 'skipped_dry_run' : offset > 0 ? 'skipped_offset' : 'created',
    definitionErrors: [],
    candidatesTotal: 0,
    offset,
    limit,
    processed: 0,
    remaining: 0,
    written: 0,
    writeErrors: 0,
    failed: 0,
    verifiedDirect: 0,
    verifyMismatch: 0,
    verifyFailed: 0,
    firstError: null,
  };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setMetafield = deps.setMetafieldImpl ?? setCustomerLineUserIdMetafield;
  const getToken = deps.getTokenImpl ?? getShopifyAccessToken;

  if (!env.SHOPIFY_STORE_DOMAIN) {
    throw new Error('SHOPIFY_STORE_DOMAIN 未設定 (migration には Shopify 接続が必要)');
  }
  const storeDomain = env.SHOPIFY_STORE_DOMAIN;

  result.candidatesTotal = await countLinkedFriends(env.DB);
  const friends = await listLinkedFriends(env.DB, limit, offset);
  result.processed = friends.length;
  result.remaining = Math.max(0, result.candidatesTotal - (offset + friends.length));

  if (options.dryRun) return result; // 書込・外部呼び出しゼロで件数だけ返す

  const accessToken = await getToken(env.DB, env);

  // 1. 定義作成 (冪等)。subrequest 節約のため最初のチャンク (offset=0) のみ実行。
  //    定義エラーでも backfill は続行し、直読検証で実効性を判定する
  if (offset === 0) {
    try {
      const def = await ensureLineUserIdDefinition(storeDomain, accessToken, fetchImpl);
      result.definition = def.status;
      result.definitionErrors = def.errors;
    } catch (err) {
      result.definition = 'error';
      const msg = err instanceof Error ? err.message : 'unknown';
      result.definitionErrors = [msg.slice(0, 300)];
      result.firstError ??= msg.slice(0, 300);
    }
  }

  // 2. backfill (D1 → Shopify、per-friend try/catch で部分失敗継続)
  for (const f of friends) {
    try {
      const w = await setMetafield(
        storeDomain,
        accessToken,
        f.shopify_customer_id,
        LINEHARNESS_METAFIELD_NAMESPACE,
        LINEHARNESS_METAFIELD_KEY,
        f.line_user_id,
        fetchImpl,
      );
      if (w.ok) result.written += 1;
      else {
        result.writeErrors += 1;
        result.firstError ??= w.userErrors.join('; ').slice(0, 300);
      }
    } catch (err) {
      result.failed += 1;
      result.firstError ??= (err instanceof Error ? err.message : 'unknown').slice(0, 300);
    }
  }

  // 3. 直読検証 (書込直後でも安定する経路)
  for (const f of friends) {
    try {
      const value = await readCustomerLineUserIdMetafield(
        storeDomain,
        accessToken,
        f.shopify_customer_id,
        fetchImpl,
      );
      if (value === f.line_user_id) result.verifiedDirect += 1;
      else result.verifyMismatch += 1;
    } catch (err) {
      result.verifyFailed += 1;
      result.firstError ??= (err instanceof Error ? err.message : 'unknown').slice(0, 300);
    }
  }

  // summary audit (best-effort、PII 最小化: LINE userId や error 詳細は残さず件数のみ)。
  // verifyFailed (直読が実行できなかった件) と definition error も failure 側に倒す
  // (採点R1: 「検証未完了なのに success」を残さない)。remaining>0 は正常なチャンク途中
  // 状態なので failure にしない (metadata の remaining で進捗は自己記述される)
  const cleanChunk =
    result.verifyMismatch + result.failed + result.writeErrors + result.verifyFailed === 0 &&
    result.definition !== 'error';
  await auditSystem(env.DB, {
    action: 'line_metafield_migration.completed',
    result: cleanChunk ? 'success' : 'failure',
    metadata: {
      candidatesTotal: result.candidatesTotal,
      offset: result.offset,
      processed: result.processed,
      remaining: result.remaining,
      written: result.written,
      writeErrors: result.writeErrors,
      failed: result.failed,
      verifiedDirect: result.verifiedDirect,
      verifyMismatch: result.verifyMismatch,
      verifyFailed: result.verifyFailed,
      definition: result.definition,
    },
  });

  return result;
}

// ============================================================
// 検索経路のパリティ検証 (= 「連携経路無停止」の直接実証)
// ============================================================

/**
 * 連携済み friend について、friend-customer-linker と同じ検索経路
 * (`metafields.{ns}.{key}:"..."`) で同一 customer に解決できるか検証する (offset チャンク)。
 * Shopify の検索インデックス反映は非同期のため、migration 実行の数分後に呼ぶこと。
 *
 * @param options.useSecret true なら ns/key を FRIEND_LINK_METAFIELD_* secret の実効値から
 *   解決する (= 切替 op 後の検証。応答の namespace/key/nsSource で切替結果を目視確認できる)。
 *   false (既定) は lineharness 定数 (= 切替前の事前検証)。
 */
export async function verifySearchPathParity(
  env: MigrationEnv,
  options: { useSecret?: boolean; limit?: number; offset?: number } = {},
  deps: MigrationDeps = {},
): Promise<SearchParityResult> {
  const limit = clampInt(options.limit, 1, VERIFY_MAX_LIMIT, VERIFY_DEFAULT_LIMIT);
  const offset = clampInt(options.offset, 0, Number.MAX_SAFE_INTEGER, 0);

  let namespace = LINEHARNESS_METAFIELD_NAMESPACE;
  let key = LINEHARNESS_METAFIELD_KEY;
  let nsSource: SearchParityResult['nsSource'] = 'default';
  if (options.useSecret) {
    const ns = env.FRIEND_LINK_METAFIELD_NAMESPACE ?? '';
    const k = env.FRIEND_LINK_METAFIELD_KEY ?? '';
    // secret 側の構文不正 (例: 過去実発生の PowerShell CRLF trap) はここで露見させる
    if (!SAFE_METAFIELD_PART.test(ns) || !SAFE_METAFIELD_PART.test(k)) {
      throw new Error(
        'FRIEND_LINK_METAFIELD_NAMESPACE/KEY が未設定または不正 (useSecret=1 は secret 切替後に使う)',
      );
    }
    namespace = ns;
    key = k;
    nsSource = 'friend_link_secret';
  }

  const result: SearchParityResult = {
    candidatesTotal: 0,
    offset,
    limit,
    processed: 0,
    remaining: 0,
    resolved: 0,
    unresolved: 0,
    failed: 0,
    namespace,
    key,
    nsSource,
    firstError: null,
  };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const findByLineId = deps.findByLineIdImpl ?? findShopifyCustomerByLineId;
  const getToken = deps.getTokenImpl ?? getShopifyAccessToken;

  if (!env.SHOPIFY_STORE_DOMAIN) {
    throw new Error('SHOPIFY_STORE_DOMAIN 未設定');
  }
  const storeDomain = env.SHOPIFY_STORE_DOMAIN;
  const accessToken = await getToken(env.DB, env);

  result.candidatesTotal = await countLinkedFriends(env.DB);
  const friends = await listLinkedFriends(env.DB, limit, offset);
  result.processed = friends.length;
  result.remaining = Math.max(0, result.candidatesTotal - (offset + friends.length));

  for (const f of friends) {
    try {
      const found = await findByLineId(
        storeDomain,
        accessToken,
        namespace,
        key,
        f.line_user_id,
        fetchImpl,
      );
      if (found && found.customerId === f.shopify_customer_id) result.resolved += 1;
      else result.unresolved += 1;
    } catch (err) {
      result.failed += 1;
      result.firstError ??= (err instanceof Error ? err.message : 'unknown').slice(0, 300);
    }
  }

  // audit は件数 + ns/key のみ (firstError は Shopify エラー文に検索クエリ = LINE userId が
  // 混入しうるため残さない — 採点R1 PII 指摘。詳細は認可済みレスポンスでのみ返す)
  await auditSystem(env.DB, {
    action: 'line_metafield_migration.search_parity',
    result: result.unresolved + result.failed === 0 ? 'success' : 'failure',
    metadata: {
      candidatesTotal: result.candidatesTotal,
      offset: result.offset,
      processed: result.processed,
      resolved: result.resolved,
      unresolved: result.unresolved,
      failed: result.failed,
      namespace,
      key,
      nsSource,
    },
  });

  return result;
}

// ============================================================
// 旧 namespace (socialplus.line) の棚卸し — アンインストール前の取り漏らし検査
// ============================================================

/**
 * 全 customer をページスキャンし、旧 metafield (socialplus.line) に値を持つ customer が
 * すべて D1 friends にリンク済みかを照合する。アンインストール (不可逆) の直前に実行し、
 * unmatchedCustomerIds が空であることを確認する (= 「socialplus にあって D1 に無いリンク」
 * の不在証明。検索インデックスに依存しないカーソル走査)。
 * nextCursor が返ったら同 cursor で再呼び出しして全顧客を走査し切ること。
 */
export async function auditLegacyMetafieldValues(
  env: MigrationEnv,
  options: { cursor?: string | null } = {},
  deps: MigrationDeps = {},
): Promise<LegacyAuditResult> {
  const result: LegacyAuditResult = {
    pagesScanned: 0,
    customersScanned: 0,
    withLegacyValue: 0,
    matchedInD1: 0,
    unmatchedTotal: 0,
    unmatchedCustomerIds: [],
    matchFailed: 0,
    matchingCapped: false,
    nextCursor: null,
    firstError: null,
  };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getToken = deps.getTokenImpl ?? getShopifyAccessToken;

  if (!env.SHOPIFY_STORE_DOMAIN) throw new Error('SHOPIFY_STORE_DOMAIN 未設定');
  const storeDomain = env.SHOPIFY_STORE_DOMAIN;
  const accessToken = await getToken(env.DB, env);

  const query = `
    query scanLegacyLineMetafield($first: Int!, $after: String, $ns: String!, $key: String!) {
      customers(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges { node { id metafield(namespace: $ns, key: $key) { value } } }
      }
    }
  `;

  let cursor = options.cursor ?? null;
  let matchChecks = 0;
  let done = false;
  for (let page = 0; page < LEGACY_AUDIT_MAX_PAGES; page += 1) {
    // D1 照合予算をページ開始前に判定する (採点R2): 最悪 (全 250 件が値持ち) でも予算内で
    // ページを完了できるときだけ進む → ページ途中の cap = 「走査済みだが未照合」の customer が
    // 構造的に発生しない。予算切れはこのページの先頭 cursor を返して再呼び出しに委ねる
    if (matchChecks + LEGACY_AUDIT_PAGE_SIZE > LEGACY_AUDIT_MATCH_CAP) {
      result.matchingCapped = true;
      result.nextCursor = cursor;
      break;
    }

    const variables = {
      first: LEGACY_AUDIT_PAGE_SIZE,
      after: cursor,
      ns: LEGACY_METAFIELD_NAMESPACE,
      key: LEGACY_METAFIELD_KEY,
    };
    const res = await shopifyGraphql(storeDomain, accessToken, { query, variables }, fetchImpl);
    if (!res.ok) throw new Error(`customers scan failed: HTTP ${res.status}`);
    const body = (await res.json()) as CustomersScanResponse;
    if (body.errors && body.errors.length > 0) {
      throw new Error(`customers scan errors: ${body.errors.map((e) => e.message).join('; ')}`);
    }

    const conn = body.data?.customers;
    const edges = conn?.edges ?? [];
    result.pagesScanned += 1;
    result.customersScanned += edges.length;

    for (const e of edges) {
      const value = e.node?.metafield?.value ?? null;
      if (value == null || value === '') continue;
      result.withLegacyValue += 1;
      const customerId = normalizeShopifyCustomerId(e.node?.id ?? null);
      if (!customerId) {
        // gid が解釈不能 = 照合不能。黙殺せず matchFailed に計上する (算術閉包を保つ)
        result.matchFailed += 1;
        result.firstError ??= 'unparseable customer gid';
        continue;
      }
      matchChecks += 1;
      try {
        if (await isCustomerLinkedInD1(env.DB, customerId)) {
          result.matchedInD1 += 1;
        } else {
          result.unmatchedTotal += 1;
          if (result.unmatchedCustomerIds.length < 20) result.unmatchedCustomerIds.push(customerId);
        }
      } catch (err) {
        // 採点R2 HIGH: D1 照合エラーを swallow すると matched/unmatched のどちらにも入らず
        // 「取り漏らしゼロ」が偽 green になる → matchFailed として可視化し合格条件に含める
        result.matchFailed += 1;
        result.firstError ??= (err instanceof Error ? err.message : 'unknown').slice(0, 300);
      }
    }

    if (!conn?.pageInfo?.hasNextPage) {
      result.nextCursor = null;
      done = true;
      break;
    }
    cursor = conn.pageInfo.endCursor ?? null;
    if (!cursor) {
      result.nextCursor = null;
      done = true;
      break;
    }
    // MAX_PAGES 到達で抜けた場合の再開位置
    result.nextCursor = cursor;
  }

  // 不可逆操作 (uninstall) の直前ゲートなので、永続証跡を audit_logs にも残す (採点R2)。
  // 件数のみ (customer id / LINE userId は残さない)
  await auditSystem(env.DB, {
    action: 'line_metafield_migration.legacy_audit',
    result:
      result.unmatchedTotal + result.matchFailed === 0 &&
      result.matchedInD1 + result.unmatchedTotal + result.matchFailed === result.withLegacyValue
        ? 'success'
        : 'failure',
    metadata: {
      pagesScanned: result.pagesScanned,
      customersScanned: result.customersScanned,
      withLegacyValue: result.withLegacyValue,
      matchedInD1: result.matchedInD1,
      unmatchedTotal: result.unmatchedTotal,
      matchFailed: result.matchFailed,
      matchingCapped: result.matchingCapped,
      scanComplete: done,
    },
  });

  return result;
}

// ============================================================
// 小物
// ============================================================

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

// ============================================================
// test 用 export
// ============================================================

export const __test__ = {
  SHOPIFY_API_VERSION,
  SHOPIFY_TIMEOUT_MS,
  MIGRATION_MAX_LIMIT,
  MIGRATION_DEFAULT_LIMIT,
  VERIFY_MAX_LIMIT,
  VERIFY_DEFAULT_LIMIT,
  LEGACY_AUDIT_PAGE_SIZE,
  LEGACY_AUDIT_MAX_PAGES,
  LEGACY_AUDIT_MATCH_CAP,
};
