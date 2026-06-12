/**
 * 再入荷通知 — 顧客導線 + variant 解決 (Task#3 完動化, 2026-06-12)
 *
 * 旧状態は「完成して見えるが死んでいる backend」だった:
 *   ①友だちが再入荷希望を登録する導線が皆無 (admin POST のみ)
 *   ②inventory_levels/update の inventory_item_id を variant_id とみなす照合バグ (永遠に不一致)
 *   ③inventory webhook が未購読 ④gated 時も waiting を notified に消費
 *
 * 本サービスは ① の導線 (商品カードの postback → 登録) と ② の解決
 * (variants_json から inventory_item_id を引く) を提供する。③④ は routes 側で修正。
 *
 * postback data 形式: `action=restock_request&pid=<shopifyProductId>&vid=<variantId>`
 *   (webhook.ts の URLSearchParams `action=` 系統。reply token 返信 = 通数ゼロ)
 */

import {
  createRestockRequest,
  getWaitingRestockRequest,
  getShopifyProductByShopifyId,
} from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';

// Shopify product webhook 生 payload の variants 要素 (variants_json に保存される形)。
// TS interface は最小限だが、実体は webhook payload そのままなので inventory_item_id を含む。
interface StoredVariant {
  id?: number | string;
  title?: string;
  inventory_item_id?: number | string;
  inventory_quantity?: number;
}

export interface ResolvedVariant {
  variantId: string;
  variantTitle: string | null;
  inventoryItemId: string | null;
  inventoryQuantity: number | null;
  productTitle: string;
}

/**
 * shopify_products.variants_json から variant を解決する。
 * variantId 未指定 (空) なら先頭 variant (naturism は単一 variant 商品が主)。
 */
export async function resolveVariant(
  db: D1Database,
  shopifyProductId: string,
  variantId?: string | null,
): Promise<ResolvedVariant | null> {
  const product = await getShopifyProductByShopifyId(db, shopifyProductId);
  if (!product) return null;

  let variants: StoredVariant[] = [];
  try {
    variants = product.variants_json ? (JSON.parse(product.variants_json) as StoredVariant[]) : [];
  } catch {
    variants = [];
  }
  if (!Array.isArray(variants) || variants.length === 0) return null;

  const v = variantId
    ? variants.find((x) => String(x.id ?? '') === String(variantId))
    : variants[0];
  if (!v || v.id === undefined || v.id === null) return null;

  return {
    variantId: String(v.id),
    variantTitle: typeof v.title === 'string' ? v.title : null,
    inventoryItemId:
      v.inventory_item_id !== undefined && v.inventory_item_id !== null
        ? String(v.inventory_item_id)
        : null,
    inventoryQuantity:
      typeof v.inventory_quantity === 'number' && Number.isFinite(v.inventory_quantity)
        ? v.inventory_quantity
        : null,
    productTitle: product.title,
  };
}

/**
 * 商品カードの「🔔 再入荷したらお知らせ」postback ハンドラ。
 * 冪等 (同 friend×variant の waiting が既にあれば再登録せず案内のみ)。
 * 返信は reply token (= 無料)。失敗は throw (caller が audit)。
 */
export async function handleRestockPostback(
  db: D1Database,
  lineClient: LineClient,
  friend: { id: string; display_name: string | null },
  replyToken: string,
  params: URLSearchParams,
): Promise<{ outcome: 'registered' | 'duplicate' | 'product_not_found' }> {
  const pid = params.get('pid') ?? '';
  const vid = params.get('vid');

  const resolved = pid ? await resolveVariant(db, pid, vid) : null;
  if (!resolved) {
    await lineClient.replyMessage(replyToken, [
      {
        type: 'text',
        text: '申し訳ありません、この商品の情報が見つかりませんでした。お手数ですがチャットでお問い合わせください。',
      },
    ]);
    return { outcome: 'product_not_found' };
  }

  const existing = await getWaitingRestockRequest(db, friend.id, resolved.variantId);
  if (existing) {
    await lineClient.replyMessage(replyToken, [
      {
        type: 'text',
        text: `「${resolved.productTitle}」は再入荷お知らせに登録済みです。入荷したらすぐお知らせしますね！`,
      },
    ]);
    return { outcome: 'duplicate' };
  }

  await createRestockRequest(db, {
    friendId: friend.id,
    shopifyProductId: pid,
    shopifyVariantId: resolved.variantId,
    productTitle: resolved.productTitle,
    variantTitle: resolved.variantTitle ?? undefined,
    inventoryItemId: resolved.inventoryItemId,
  });

  await lineClient.replyMessage(replyToken, [
    {
      type: 'text',
      text: `「${resolved.productTitle}」の再入荷お知らせを受け付けました🔔\n入荷したらこのトークでお知らせします。`,
    },
  ]);
  return { outcome: 'registered' };
}

/** 商品カード用: 在庫切れ判定 (先頭 variant 基準、在庫数が取れない場合は在庫ありとみなす) */
export function isOutOfStock(variantsJson: string | null): boolean {
  if (!variantsJson) return false;
  try {
    const variants = JSON.parse(variantsJson) as StoredVariant[];
    const v = Array.isArray(variants) ? variants[0] : null;
    return typeof v?.inventory_quantity === 'number' && v.inventory_quantity <= 0;
  } catch {
    return false;
  }
}

/** postback data ビルダー (product-display から利用) */
export function buildRestockPostbackData(shopifyProductId: string, variantId?: string | null): string {
  const params = new URLSearchParams();
  params.set('action', 'restock_request');
  params.set('pid', shopifyProductId);
  if (variantId) params.set('vid', String(variantId));
  return params.toString();
}
