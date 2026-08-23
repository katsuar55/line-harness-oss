/**
 * 顧客向けストアフロントのドメイン (2026-08-23 切り出し)。
 *
 * 🚨 `SHOPIFY_STORE_DOMAIN` (env) は **Admin/API 用の myshopify ホスト**で、
 *   本番実値は punycode の `xn-0ckn0a9fxa4a.myshopify.com`。顧客に見せる URL に
 *   使うと管理用ドメインが露出する (現に Shop タブの storeUrl がそうなっている)。
 *   顧客向けは必ずこの定数を使う。
 *
 * liff-my-rank.ts が持っていた同名の定数をここへ移し、複数面で食い違わないようにした。
 */
export const STOREFRONT_DOMAIN = 'naturism-diet.com';

/** 商品ページ URL (handle が無ければ null)。 */
export function storefrontProductUrl(handle: string | null | undefined): string | null {
  if (!handle) return null;
  return `https://${STOREFRONT_DOMAIN}/products/${encodeURIComponent(handle)}`;
}
