/**
 * Verifies the X-Line-Signature header using HMAC-SHA256.
 * Must be called before processing any webhook event.
 *
 * @param channelSecret - LINE channel secret
 * @param body          - Raw request body string (before JSON.parse)
 * @param signature     - Value of the X-Line-Signature header (base64)
 * @returns true if the signature is valid, false otherwise
 */
export async function verifySignature(
  channelSecret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const computedBytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(body)),
  );

  // Decode incoming base64 signature to bytes
  let signatureBytes: Uint8Array;
  try {
    const binaryStr = atob(signature);
    signatureBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      signatureBytes[i] = binaryStr.charCodeAt(i);
    }
  } catch {
    return false; // Invalid base64
  }

  // Constant-time comparison: XOR all bytes, OR results together
  if (computedBytes.length !== signatureBytes.length) return false;

  let diff = 0;
  for (let i = 0; i < computedBytes.length; i++) {
    diff |= computedBytes[i] ^ signatureBytes[i];
  }

  return diff === 0;
}
