import {
  getShopifyProducts,
  getProductsNotRecommendedTo,
  recordProductRecommendation,
  upsertShopifyProduct,
} from '@line-crm/db';
import type { ShopifyProduct, UpsertShopifyProductInput } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import {
  flexMessage,
  flexCarousel,
  productCard,
} from '@line-crm/line-sdk';

// ---------- Webhook: Sync product from Shopify ----------

interface ShopifyProductWebhookBody {
  id: number;
  title: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  handle?: string;
  status?: string;
  tags?: string;
  image?: { src: string } | null;
  images?: Array<{ src: string }>;
  variants?: Array<{
    id: number;
    title: string;
    price: string;
    compare_at_price: string | null;
    inventory_quantity?: number;
  }>;
}

/**
 * Sync product data from Shopify webhook to D1.
 */
export async function syncProductFromWebhook(
  db: D1Database,
  body: ShopifyProductWebhookBody,
  storeDomain?: string,
): Promise<ShopifyProduct> {
  const imageUrl = body.image?.src || body.images?.[0]?.src || null;
  const firstVariant = body.variants?.[0];
  const storeUrl = storeDomain && body.handle
    ? `https://${storeDomain}/products/${body.handle}`
    : null;

  // Strip HTML from description
  const description = body.body_html
    ? body.body_html.replace(/<[^>]*>/g, '').slice(0, 500)
    : null;

  const input: UpsertShopifyProductInput = {
    shopifyProductId: String(body.id),
    title: body.title,
    description,
    vendor: body.vendor || null,
    productType: body.product_type || null,
    handle: body.handle || null,
    status: (body.status as 'active' | 'draft' | 'archived') || 'active',
    imageUrl,
    price: firstVariant?.price || null,
    compareAtPrice: firstVariant?.compare_at_price || null,
    tags: body.tags || null,
    variantsJson: body.variants ? JSON.stringify(body.variants) : null,
    storeUrl,
  };

  return upsertShopifyProduct(db, input);
}

// ---------- Build Product Flex Messages ----------

/**
 * Build a Flex carousel message with product cards.
 * Maximum 12 bubbles per carousel (LINE limit).
 */
export function buildProductCarousel(
  products: ShopifyProduct[],
  altText = '商品のご案内',
): ReturnType<typeof flexMessage> | null {
  if (products.length === 0) return null;

  // LINE carousel max is 12 bubbles
  const displayProducts = products.slice(0, 12);

  const bubbles = displayProducts.map((p) =>
    productCard({
      imageUrl: p.image_url || 'https://placehold.co/600x400?text=No+Image',
      name: p.title,
      price: p.price ? `¥${Number(p.price).toLocaleString()}` : '価格未設定',
      description: p.description?.slice(0, 60) || undefined,
      actionUrl: p.store_url || `https://example.com/products/${p.handle || p.shopify_product_id}`,
    }),
  );

  if (bubbles.length === 1) {
    return flexMessage(altText, bubbles[0]);
  }

  return flexMessage(altText, flexCarousel(bubbles));
}

// ---------- Send Product Recommendations ----------

/**
 * Send product recommendations to a friend.
 * Skips products already recommended with the same trigger.
 */
export async function sendProductRecommendations(
  db: D1Database,
  lineClient: LineClient,
  friendLineUserId: string,
  friendId: string,
  opts?: {
    triggerType?: 'purchase' | 'browse' | 'restock' | 'manual' | 'scheduled';
    productType?: string;
    limit?: number;
    altText?: string;
  },
): Promise<{ sent: number }> {
  const triggerType = opts?.triggerType ?? 'manual';
  const limit = opts?.limit ?? 5;

  // Get products not yet recommended to this friend
  const products = await getProductsNotRecommendedTo(db, friendId, triggerType, limit);

  if (products.length === 0) {
    return { sent: 0 };
  }

  // Filter by product type if specified
  const filtered = opts?.productType
    ? products.filter((p) => p.product_type === opts.productType)
    : products;

  if (filtered.length === 0) {
    return { sent: 0 };
  }

  const message = buildProductCarousel(filtered, opts?.altText);
  if (!message) return { sent: 0 };

  await lineClient.pushMessage(friendLineUserId, [message]);

  // Record recommendations
  for (const product of filtered) {
    await recordProductRecommendation(db, friendId, product.shopify_product_id, triggerType);
  }

  return { sent: filtered.length };
}

// ---------- Post-Purchase Recommendations ----------

/**
 * After a purchase, recommend other products the customer hasn't bought.
 * Called from event bus on 'purchase_completed'.
 */
export async function sendPostPurchaseRecommendations(
  db: D1Database,
  lineClient: LineClient,
  friendId: string,
  friendLineUserId: string,
): Promise<void> {
  try {
    await sendProductRecommendations(db, lineClient, friendLineUserId, friendId, {
      triggerType: 'purchase',
      limit: 3,
      altText: 'こちらの商品もおすすめです',
    });
  } catch (err) {
    console.error(`Failed to send post-purchase recommendations to friend ${friendId}:`, err);
  }
}
