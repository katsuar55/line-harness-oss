/**
 * Tests for utils/svix-signature (Round 4 PR-4)
 */

import { describe, it, expect } from 'vitest';
import { verifySvixSignature } from '../utils/svix-signature.js';

// 既知の値で正規ケースを構築
async function buildValidSignature(opts: {
  secret: string; // whsec_<base64>
  svixId: string;
  svixTimestamp: string;
  body: string;
}): Promise<string> {
  const b64 = opts.secret.slice('whsec_'.length);
  const keyBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = `${opts.svixId}.${opts.svixTimestamp}.${opts.body}`;
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `v1,${sigB64}`;
}

const SECRET = 'whsec_dGVzdC1zZWNyZXQtMTIzNDU2'; // base64('test-secret-123456')
const NOW = new Date('2026-05-01T10:00:00Z');
const NOW_TS = String(Math.floor(NOW.getTime() / 1000));

describe('verifySvixSignature', () => {
  it('正規の署名は valid', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'pm-1' } });
    const sig = await buildValidSignature({
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: NOW_TS,
      body,
    });
    const r = await verifySvixSignature({
      body,
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: NOW_TS,
      svixSignature: sig,
      now: NOW,
    });
    expect(r.valid).toBe(true);
  });

  it('body が改ざんされたら signature_mismatch', async () => {
    const sig = await buildValidSignature({
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: NOW_TS,
      body: 'original',
    });
    const r = await verifySvixSignature({
      body: 'tampered',
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: NOW_TS,
      svixSignature: sig,
      now: NOW,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('signature_mismatch');
  });

  it('別の svix-id だと signature_mismatch', async () => {
    const body = '{}';
    const sig = await buildValidSignature({
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: NOW_TS,
      body,
    });
    const r = await verifySvixSignature({
      body,
      secret: SECRET,
      svixId: 'msg_DIFFERENT',
      svixTimestamp: NOW_TS,
      svixSignature: sig,
      now: NOW,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('signature_mismatch');
  });

  it('5 分超古い timestamp は timestamp_out_of_range', async () => {
    const body = '{}';
    const oldTs = String(Math.floor(NOW.getTime() / 1000) - 6 * 60);
    const sig = await buildValidSignature({
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: oldTs,
      body,
    });
    const r = await verifySvixSignature({
      body,
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: oldTs,
      svixSignature: sig,
      now: NOW,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('timestamp_out_of_range');
  });

  it('未来 6 分の timestamp も timestamp_out_of_range (clock skew 攻撃緩和)', async () => {
    const body = '{}';
    const futureTs = String(Math.floor(NOW.getTime() / 1000) + 6 * 60);
    const sig = await buildValidSignature({
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: futureTs,
      body,
    });
    const r = await verifySvixSignature({
      body,
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: futureTs,
      svixSignature: sig,
      now: NOW,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('timestamp_out_of_range');
  });

  it('whsec_ prefix なし secret は malformed_secret', async () => {
    const r = await verifySvixSignature({
      body: '{}',
      secret: 'no-prefix',
      svixId: 'msg_001',
      svixTimestamp: NOW_TS,
      svixSignature: 'v1,xxx',
      now: NOW,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('malformed_secret');
  });

  it('signature ヘッダに v1 がなければ no_v1_signature', async () => {
    const r = await verifySvixSignature({
      body: '{}',
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: NOW_TS,
      svixSignature: 'v2,abc',
      now: NOW,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('no_v1_signature');
  });

  it('複数 v1 署名 (rotation) のうち 1 つが正しければ valid', async () => {
    const body = '{}';
    const goodSig = await buildValidSignature({
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: NOW_TS,
      body,
    });
    const combined = `v1,WRONG_BASE64== ${goodSig}`;
    const r = await verifySvixSignature({
      body,
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: NOW_TS,
      svixSignature: combined,
      now: NOW,
    });
    expect(r.valid).toBe(true);
  });

  it('headers 欠落で missing_headers', async () => {
    const r = await verifySvixSignature({
      body: '{}',
      secret: SECRET,
      svixId: '',
      svixTimestamp: NOW_TS,
      svixSignature: 'v1,xxx',
      now: NOW,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('missing_headers');
  });

  it('body 空 (request body 無し) は missing_headers', async () => {
    const r = await verifySvixSignature({
      body: '',
      secret: SECRET,
      svixId: 'msg_001',
      svixTimestamp: NOW_TS,
      svixSignature: 'v1,xxx',
      now: NOW,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('missing_headers');
  });
});
