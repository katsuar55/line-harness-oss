/**
 * Shopify Webhook HMAC-SHA256 署名検証ユーティリティ
 *
 * shopify.ts と shopify-phase2a.ts の両方から共通利用。
 * Shopify は X-Shopify-Hmac-Sha256 ヘッダーに base64 エンコードした HMAC を送信する。
 *
 * crypto.subtle.verify を使用してタイミングセーフな比較を行う。
 */

export async function verifyShopifySignature(
  secret: string,
  rawBody: string,
  hmacHeader: string,
): Promise<boolean> {
  const trimmedHeader = hmacHeader.trim();
  if (!trimmedHeader || !secret || !rawBody) {
    return false;
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    // Shopify の HMAC ヘッダーは base64 エンコード → バイナリに戻す
    const expectedSig = Uint8Array.from(atob(trimmedHeader), (c) => c.charCodeAt(0));

    // crypto.subtle.verify はタイミングセーフ（内部で定数時間比較を行う）
    return await crypto.subtle.verify('HMAC', key, expectedSig, encoder.encode(rawBody));
  } catch {
    // base64 デコード失敗等
    return false;
  }
}
