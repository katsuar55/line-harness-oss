/**
 * Shopify App Proxy 署名検証のテスト (2026-07-29)
 *
 * 独立検証の担保:
 *   - アルゴリズム一致は **Shopify 公式ドキュメントの実ベクタ** で固定する
 *     (secret='hush' / signature=e072b6d7…、
 *      https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies)。
 *   - 署名値の計算は node:crypto (= 実装の crypto.subtle とは別系統) で行い、相互検証にする。
 *
 * 重複キーの扱い:
 *   公式ベクタは `extra=1&extra=2` を含み、署名としては valid。 だが本エンドポイントは
 *   複数値を一切必要とせず、「署名は getAll のカンマ結合・業務ロジックは get の先頭値」の
 *   読み取り不一致が任意 customer のトークン発行に繋がる (R1 採点 CRITICAL)。
 *   したがって verify は **重複キーを無条件で拒否** する。 アルゴリズム一致の検証は
 *   buildAppProxyMessage + HMAC 直接計算で行い、verify の受理判定とは分離している。
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildAppProxyMessage,
  verifyAppProxySignature,
  APP_PROXY_TIMESTAMP_TOLERANCE_SEC,
} from '../utils/shopify-app-proxy.js';

const SECRET = 'hush';
const SHOP = 'example.myshopify.com';
const PREFIX = '/apps/line-link';
const TS = '1317327555';
const NOW_MS = Number(TS) * 1000;

/** 公式ドキュメントの実例 (複数値 extra を含む)。 */
const DOC_QUERY =
  'extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555' +
  '&signature=e072b6d7e6622d85912a5214b860d3100dc1e73d9bc29f43796ac8c9ff8093cb';
const DOC_EXPECTED_MESSAGE =
  'extra=1,2logged_in_customer_id=path_prefix=/apps/awesome_reviewsshop=shop-name.myshopify.comtimestamp=1317327555';
const DOC_EXPECTED_SIGNATURE = 'e072b6d7e6622d85912a5214b860d3100dc1e73d9bc29f43796ac8c9ff8093cb';

function hmacHex(message: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/** 単一値パラメータ群に正当な署名を付けた query 文字列を作る。 */
function signed(params: Record<string, string>, secret = SECRET): string {
  const message = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('');
  const q = new URLSearchParams(params);
  q.set('signature', hmacHex(message, secret));
  return q.toString();
}

function base(over: Record<string, string> = {}): Record<string, string> {
  return { shop: SHOP, path_prefix: PREFIX, logged_in_customer_id: '', timestamp: TS, ...over };
}

function qs(s: string): URLSearchParams {
  return new URLSearchParams(s);
}

// ============================================================
// アルゴリズム一致 (公式ベクタ)
// ============================================================

describe('buildAppProxyMessage — 公式仕様との一致', () => {
  it('signature 除外・複数値カンマ結合・キー辞書順・区切りなし連結', () => {
    expect(buildAppProxyMessage(qs(DOC_QUERY))).toBe(DOC_EXPECTED_MESSAGE);
  });

  it('組み立てたメッセージの HMAC が公式ベクタの signature と一致する', () => {
    expect(hmacHex(buildAppProxyMessage(qs(DOC_QUERY)))).toBe(DOC_EXPECTED_SIGNATURE);
  });
});

// ============================================================
// verify: 受理
// ============================================================

describe('verifyAppProxySignature — 受理', () => {
  it('正当な署名 (単一値) を受理する', async () => {
    const r = await verifyAppProxySignature(qs(signed(base())), SECRET, NOW_MS);
    expect(r).toEqual({ ok: true });
  });

  it('logged_in_customer_id 入りも受理する', async () => {
    const q = qs(signed(base({ logged_in_customer_id: '6458785661181' })));
    expect(await verifyAppProxySignature(q, SECRET, NOW_MS)).toEqual({ ok: true });
  });

  it('許容窓ぎりぎり (±tolerance ちょうど) は通る', async () => {
    const q = qs(signed(base()));
    const edge = NOW_MS + APP_PROXY_TIMESTAMP_TOLERANCE_SEC * 1000;
    expect(await verifyAppProxySignature(q, SECRET, edge)).toEqual({ ok: true });
  });
});

// ============================================================
// verify: 拒否
// ============================================================

describe('verifyAppProxySignature — 拒否', () => {
  it('パラメータ改竄 (logged_in_customer_id 差し替え) は bad_signature', async () => {
    const q = qs(signed(base({ logged_in_customer_id: '111' })));
    q.set('logged_in_customer_id', '999');
    expect(await verifyAppProxySignature(q, SECRET, NOW_MS)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('未知パラメータの追加も bad_signature (= 署名対象は全キー)', async () => {
    const q = qs(signed(base()));
    q.set('evil', '1');
    expect(await verifyAppProxySignature(q, SECRET, NOW_MS)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('secret 不一致は bad_signature', async () => {
    const q = qs(signed(base()));
    expect(await verifyAppProxySignature(q, 'wrong-secret', NOW_MS)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('signature 欠落は missing_signature', async () => {
    const q = qs(signed(base()));
    q.delete('signature');
    expect(await verifyAppProxySignature(q, SECRET, NOW_MS)).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('hex 64桁でない signature は missing_signature (形式検査で弾く)', async () => {
    const q = qs(signed(base()));
    q.set('signature', 'zz');
    expect(await verifyAppProxySignature(q, SECRET, NOW_MS)).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('timestamp が古すぎる署名済み URL は stale_timestamp (= replay 遮断)', async () => {
    const q = qs(signed(base()));
    const stale = NOW_MS + (APP_PROXY_TIMESTAMP_TOLERANCE_SEC + 1) * 1000;
    expect(await verifyAppProxySignature(q, SECRET, stale)).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('timestamp が未来すぎる場合も stale_timestamp (絶対値で判定)', async () => {
    const q = qs(signed(base()));
    const past = NOW_MS - (APP_PROXY_TIMESTAMP_TOLERANCE_SEC + 1) * 1000;
    expect(await verifyAppProxySignature(q, SECRET, past)).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('timestamp パラメータ自体が無い (署名は正当) も stale_timestamp', async () => {
    // Number(null) を 0 と読んで「有効」と誤判定しないこと
    const q = qs(signed({ shop: SHOP, path_prefix: PREFIX, logged_in_customer_id: '' }));
    expect(await verifyAppProxySignature(q, SECRET, NOW_MS)).toEqual({ ok: false, reason: 'stale_timestamp' });
  });
});

// ============================================================
// 🚨 重複キー汚染 (R1 採点 CRITICAL の回帰テスト)
// ============================================================

describe('重複キーの拒否', () => {
  it('logged_in_customer_id の重複は duplicate_param (署名が valid でも受理しない)', async () => {
    // 攻撃: 未ログインの攻撃者が storefront URL に被害者 id を付けて踏む。
    // Shopify が自分の値を追記しても、署名は getAll のカンマ結合で通ってしまい、
    // get() = 先頭値 (攻撃者が仕込んだ被害者 id) が identity に採用される穴。
    const q = new URLSearchParams();
    q.append('logged_in_customer_id', '6458785661181'); // 攻撃者が仕込んだ被害者 id
    q.append('logged_in_customer_id', ''); // Shopify が追記した実際の値 (未ログイン)
    q.append('path_prefix', PREFIX);
    q.append('shop', SHOP);
    q.append('timestamp', TS);
    // 実装と同じ規則で「正当な」署名を作る = 署名検証だけなら通る状態を再現
    q.set('signature', hmacHex(buildAppProxyMessage(q)));
    expect(await verifyAppProxySignature(q, SECRET, NOW_MS)).toEqual({ ok: false, reason: 'duplicate_param' });
  });

  it('shop の重複も duplicate_param (別ストア偽装の入口を塞ぐ)', async () => {
    const q = new URLSearchParams();
    q.append('shop', 'evil.myshopify.com');
    q.append('shop', SHOP);
    q.append('path_prefix', PREFIX);
    q.append('logged_in_customer_id', '');
    q.append('timestamp', TS);
    q.set('signature', hmacHex(buildAppProxyMessage(q)));
    expect(await verifyAppProxySignature(q, SECRET, NOW_MS)).toEqual({ ok: false, reason: 'duplicate_param' });
  });

  it('公式ベクタ (extra=1&extra=2) も verify では拒否される — 署名は valid でも安全側に倒す', async () => {
    const r = await verifyAppProxySignature(qs(DOC_QUERY), SECRET, NOW_MS);
    expect(r).toEqual({ ok: false, reason: 'duplicate_param' });
  });
});

// ============================================================
// path_prefix
// ============================================================

describe('path_prefix 照合', () => {
  it('一致は通る / 不一致は bad_path_prefix (別 proxy 向け署名の流用を弾く)', async () => {
    const q = qs(signed(base({ logged_in_customer_id: '6458785661181' })));
    expect(await verifyAppProxySignature(q, SECRET, NOW_MS, PREFIX)).toEqual({ ok: true });
    expect(await verifyAppProxySignature(q, SECRET, NOW_MS, '/apps/other')).toEqual({
      ok: false,
      reason: 'bad_path_prefix',
    });
  });

  it('expectedPathPrefix 未指定なら照合しない (後方互換)', async () => {
    const q = qs(signed(base()));
    expect(await verifyAppProxySignature(q, SECRET, NOW_MS)).toEqual({ ok: true });
  });
});
