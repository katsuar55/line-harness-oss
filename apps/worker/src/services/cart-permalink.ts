/**
 * Cart permalink builder (= 自社内製ロイヤリティ PR5-5b, 2026-06-04)
 *
 * Shopify の cart permalink で「商品 variant + 数量 + 割引コード」を1リンクに集約し、
 * マイランクから 3タップ購入を実現する。 純関数 (= テスト容易、 worker/DB 非依存)。
 *
 * 形式:
 *   - cart permalink:  https://{store}/cart/{variantId}:{qty},...?discount={code}
 *   - discount apply:  https://{store}/discount/{code}   (= コード適用してストアを開く・variant 不要の確実導線)
 *
 * variant id は数値が必要 (gid は不可)。 toNumericVariantId で gid → 数値に正規化。
 */

export interface CartLineItem {
  variantId: string | number | null | undefined;
  quantity: number;
}

/**
 * variant id を cart permalink 用の数値文字列に正規化。
 *   - 数値/数値文字列 → そのまま
 *   - gid://shopify/ProductVariant/123 → 123
 *   - それ以外 → null
 */
export function toNumericVariantId(id: string | number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/ProductVariant\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * cart permalink を生成。 有効な line item (= 数値 variant + qty>0) が1つも無ければ null。
 */
export function buildCartPermalink(
  storeDomain: string,
  items: CartLineItem[],
  discountCode?: string | null,
): string | null {
  if (!storeDomain) return null;
  const segs: string[] = [];
  for (const it of items || []) {
    const vid = toNumericVariantId(it.variantId);
    const qty = Math.floor(Number(it.quantity));
    if (vid && qty > 0) segs.push(`${vid}:${qty}`);
  }
  if (segs.length === 0) return null;
  let url = `https://${storeDomain}/cart/${segs.join(',')}`;
  if (discountCode) url += `?discount=${encodeURIComponent(discountCode)}`;
  return url;
}

/**
 * 割引コードを適用してストアを開く permalink (= variant 不要の確実な導線)。
 * code が無ければ null。
 */
export function buildDiscountApplyUrl(
  storeDomain: string,
  discountCode: string | null | undefined,
): string | null {
  if (!storeDomain || !discountCode) return null;
  return `https://${storeDomain}/discount/${encodeURIComponent(discountCode)}`;
}
