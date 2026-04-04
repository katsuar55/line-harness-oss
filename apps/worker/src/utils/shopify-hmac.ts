/**
 * Shopify Webhook HMAC-SHA256 署名検証ユーティリティ
 *
 * shopify.ts と shopify-phase2a.ts の両方から共通利用。
 * Shopify は X-Shopify-Hmac-Sha256 ヘッダーに base64 エンコードした HMAC を送信する。
 */

export async function verifyShopifySignature(
  secret: string,
  rawBody: string,
  hmacHeader: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  // Shopify は base64 エンコード（Stripe の hex とは異なる）
  const computedHmac = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return computedHmac === hmacHeader;
}
