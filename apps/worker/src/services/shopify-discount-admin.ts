/**
 * Shopify Discount 管理 mutation の共通ラッパー (2026-08-13, Ultraplan PR-C)
 *
 * discountCodeDeactivate / discountCodeActivate。呼び元:
 *   - welcome→referred 格上げ (welcome-upgrade.ts): 旧 ¥300 を殺してから ¥500 を発行 /
 *     失敗補償で復活
 *   - (PR-D 予定) rank supersede 時の旧 NLR- 無効化・期限 sweep の Shopify 側同期
 *
 * 規約 (CLAUDE.md): fetch は fetch.bind(globalThis) / timeout 8s / 例外は caller へ ok:false。
 * GraphQL は Shopify dev MCP validate 済み (2026-04)。
 */

const SHOPIFY_API_VERSION = '2026-04';
const SHOPIFY_TIMEOUT_MS = 8_000;

export type DiscountAdminResult = { ok: true } | { ok: false; error: string };

async function callDiscountStatusMutation(
  storeDomain: string,
  accessToken: string,
  mutationName: 'discountCodeDeactivate' | 'discountCodeActivate',
  discountNodeGid: string,
  fetchImpl: typeof fetch,
): Promise<DiscountAdminResult> {
  const query = `
    mutation ${mutationName}($id: ID!) {
      ${mutationName}(id: $id) {
        codeDiscountNode { id }
        userErrors { code field message }
      }
    }
  `;
  const url = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query, variables: { id: discountNodeGid } }),
      signal: controller.signal,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  try {
    const body = (await res.json()) as {
      data?: Record<string, { userErrors?: Array<{ code?: string; message: string }> } | undefined>;
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) return { ok: false, error: body.errors.map((e) => e.message).join('; ') };
    const result = body.data?.[mutationName];
    if (!result) return { ok: false, error: `no ${mutationName} in response` };
    if (result.userErrors?.length) {
      return { ok: false, error: result.userErrors.map((e) => `${e.code ?? 'ERR'}: ${e.message}`).join('; ') };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** discount を無効化する (顧客はもう使えない。過去の注文には影響しない)。 */
export function deactivateDiscountCode(
  storeDomain: string,
  accessToken: string,
  discountNodeGid: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<DiscountAdminResult> {
  return callDiscountStatusMutation(storeDomain, accessToken, 'discountCodeDeactivate', discountNodeGid, fetchImpl);
}

/** discount を再有効化する (格上げ失敗の補償用)。 */
export function activateDiscountCode(
  storeDomain: string,
  accessToken: string,
  discountNodeGid: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<DiscountAdminResult> {
  return callDiscountStatusMutation(storeDomain, accessToken, 'discountCodeActivate', discountNodeGid, fetchImpl);
}
