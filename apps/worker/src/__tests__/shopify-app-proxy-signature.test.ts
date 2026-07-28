/**
 * Shopify App Proxy 署名検証のテスト (2026-07-29)
 *
 * v1 ベクタは Shopify 公式ドキュメントの実例そのもの:
 *   https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 *   secret='hush'、 signature=e072b6d7... (= 実装がドキュメントと一致することの独立検証)。
 * v2 は node:crypto (別実装) で事前計算した値 = crypto.subtle 実装との相互検証。
 */

import { describe, it, expect } from 'vitest';
import {
  buildAppProxyMessage,
  verifyAppProxySignature,
  APP_PROXY_TIMESTAMP_TOLERANCE_SEC,
} from '../utils/shopify-app-proxy.js';

// 公式ドキュメント実例 (timestamp=1317327555)
const DOC_QUERY =
  'extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555' +
  '&signature=e072b6d7e6622d85912a5214b860d3100dc1e73d9bc29f43796ac8c9ff8093cb';
const DOC_NOW_MS = 1317327555 * 1000;

// node:crypto で独立計算した第2ベクタ (logged_in_customer_id 入り)
const V2_QUERY =
  'shop=example.myshopify.com&path_prefix=%2Fapps%2Fline-link&logged_in_customer_id=6458785661181&timestamp=1317327555' +
  '&signature=c1f143a5c1d67e1dec5b52e15201319c078cf140e164c2fd0d554e4689d7b751';

function qs(s: string): URLSearchParams {
  return new URLSearchParams(s);
}

describe('buildAppProxyMessage', () => {
  it('公式仕様: signature 除外・複数値カンマ結合・キー辞書順・区切りなし連結', () => {
    expect(buildAppProxyMessage(qs(DOC_QUERY))).toBe(
      'extra=1,2logged_in_customer_id=path_prefix=/apps/awesome_reviewsshop=shop-name.myshopify.comtimestamp=1317327555',
    );
  });
});

describe('verifyAppProxySignature', () => {
  it('公式ドキュメントのベクタが verify を通る', async () => {
    const r = await verifyAppProxySignature(qs(DOC_QUERY), 'hush', DOC_NOW_MS);
    expect(r).toEqual({ ok: true });
  });

  it('logged_in_customer_id 入りベクタ (node:crypto で独立計算) が verify を通る', async () => {
    const r = await verifyAppProxySignature(qs(V2_QUERY), 'hush', DOC_NOW_MS);
    expect(r).toEqual({ ok: true });
  });

  it('パラメータ改竄 (logged_in_customer_id 差し替え) は bad_signature', async () => {
    const tampered = DOC_QUERY.replace('logged_in_customer_id=', 'logged_in_customer_id=999');
    const r = await verifyAppProxySignature(qs(tampered), 'hush', DOC_NOW_MS);
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('未知パラメータの追加も bad_signature (= 署名対象は全キー)', async () => {
    const r = await verifyAppProxySignature(qs(DOC_QUERY + '&evil=1'), 'hush', DOC_NOW_MS);
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('secret 不一致は bad_signature', async () => {
    const r = await verifyAppProxySignature(qs(DOC_QUERY), 'wrong-secret', DOC_NOW_MS);
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('signature 欠落は missing_signature', async () => {
    const noSig = DOC_QUERY.replace(/&signature=[0-9a-f]+/, '');
    const r = await verifyAppProxySignature(qs(noSig), 'hush', DOC_NOW_MS);
    expect(r).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('hex 64桁でない signature は missing_signature 扱い (= 形式検査で弾く)', async () => {
    const badFmt = DOC_QUERY.replace(/signature=[0-9a-f]+/, 'signature=zz');
    const r = await verifyAppProxySignature(qs(badFmt), 'hush', DOC_NOW_MS);
    expect(r).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('timestamp が許容窓より古い署名済み URL は stale_timestamp (= replay 遮断)', async () => {
    const staleNow = DOC_NOW_MS + (APP_PROXY_TIMESTAMP_TOLERANCE_SEC + 1) * 1000;
    const r = await verifyAppProxySignature(qs(DOC_QUERY), 'hush', staleNow);
    expect(r).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('timestamp が未来すぎる場合も stale_timestamp (= 時計ずれの absolute 検査)', async () => {
    const pastNow = DOC_NOW_MS - (APP_PROXY_TIMESTAMP_TOLERANCE_SEC + 1) * 1000;
    const r = await verifyAppProxySignature(qs(DOC_QUERY), 'hush', pastNow);
    expect(r).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('許容窓ぎりぎり (±tolerance 以内) は通る', async () => {
    const edge = DOC_NOW_MS + APP_PROXY_TIMESTAMP_TOLERANCE_SEC * 1000;
    const r = await verifyAppProxySignature(qs(DOC_QUERY), 'hush', edge);
    expect(r).toEqual({ ok: true });
  });
});
