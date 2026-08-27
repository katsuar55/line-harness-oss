/**
 * Tests for 連携解除のサービス層とルート (2026-08-28)
 *
 * 対象:
 *   - services/account-unlink.ts unlinkAccount — 監査 / metafield 後始末 / 冪等 no-op
 *   - routes/account-link-admin.ts POST /api/admin/account-link/unlink
 *   - routes/liff-account-link.ts POST /api/liff/link/unlink
 *
 * 🚨 観測点の置き方:
 *   ステータスコードだけを見ない。「未連携のとき **1 行も書かない**」「metafield を
 *   **呼んでいない**」のように、外部作用の不在を観測する (= 「読んでから捨てる」実装で緑にならない)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { unlinkDbMock } = vi.hoisted(() => ({ unlinkDbMock: vi.fn() }));

vi.mock('@line-crm/db', async (importActual) => {
  const actual = await importActual<typeof import('@line-crm/db')>();
  return { ...actual, unlinkFriendFromShopifyCustomer: unlinkDbMock };
});
vi.mock('../services/audit-logger.js', () => ({ auditSystem: vi.fn(async () => {}) }));
vi.mock('../services/shopify-token.js', () => ({ getShopifyAccessToken: vi.fn(async () => 'tok') }));
// 🚨 route 経由の呼び出しは deleteMetafieldImpl を注入できないので、ここで実 Shopify を封じる。
//    封じないとテストが本物の shopify.myshopify.com へ出ていく (実測 401 / 700ms、ネットワーク依存)。
vi.mock('../services/account-link-shopify.js', async (importActual) => {
  const actual = await importActual<typeof import('../services/account-link-shopify.js')>();
  return { ...actual, deleteCustomerLineUserIdMetafield: vi.fn(async () => ({ ok: true, userErrors: [] })) };
});

import { unlinkAccount } from '../services/account-unlink.js';
import { auditSystem } from '../services/audit-logger.js';
import { getShopifyAccessToken } from '../services/shopify-token.js';
import { accountLinkAdmin } from '../routes/account-link-admin.js';
import { liffAccountLink } from '../routes/liff-account-link.js';

const mockedAudit = vi.mocked(auditSystem);
const mockedToken = vi.mocked(getShopifyAccessToken);

const LINKED = {
  unlinked: true,
  shopifyCustomerId: '900',
  cleared: { customers: 1, orders: 2, fulfillments: 1, purchaseEvents: 3, members: 1, rankDiscounts: 1 },
};
const NOT_LINKED = {
  unlinked: false,
  shopifyCustomerId: null,
  cleared: { customers: 0, orders: 0, fulfillments: 0, purchaseEvents: 0, members: 0, rankDiscounts: 0 },
};

const ENV = {
  DB: {} as D1Database,
  SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com',
};

beforeEach(() => {
  unlinkDbMock.mockReset();
  mockedAudit.mockClear();
  mockedToken.mockClear();
  mockedToken.mockResolvedValue('tok');
});

describe('unlinkAccount (service)', () => {
  it('解除成功 → 監査に cleared の内訳と「台帳は残した」旨を残す', async () => {
    unlinkDbMock.mockResolvedValue(LINKED);
    const del = vi.fn(async () => ({ ok: true, userErrors: [] }));
    const r = await unlinkAccount(ENV, { friendId: 'f1', actor: 'customer', deleteMetafieldImpl: del });

    expect(r.unlinked).toBe(true);
    expect(r.metafieldDeleted).toBe(true);
    expect(mockedAudit).toHaveBeenCalledTimes(1);
    const [, input] = mockedAudit.mock.calls[0];
    expect(input).toMatchObject({
      action: 'account_link.unlinked',
      targetType: 'friend',
      targetId: 'f1',
      result: 'success',
    });
    const meta = input.metadata as Record<string, unknown>;
    expect(meta.unlinkedBy).toBe('customer');
    expect(meta.cleared).toEqual(LINKED.cleared);
    // 🚨 「¥300 台帳を残した」ことを監査に明記する (将来消す改修への警告になる)
    expect(meta.linkRewardLedgerKept).toBe(true);
  });

  it('admin 実行は監査の unlinkedBy で区別できる (誤連携の是正か顧客の意思かの切り分け)', async () => {
    unlinkDbMock.mockResolvedValue(LINKED);
    await unlinkAccount(ENV, {
      friendId: 'f1',
      actor: 'admin',
      actorId: 'ops',
      deleteMetafieldImpl: vi.fn(async () => ({ ok: true, userErrors: [] })),
    });
    const [, input] = mockedAudit.mock.calls[0];
    expect((input.metadata as Record<string, unknown>).unlinkedBy).toBe('admin');
    expect(input.actorId).toBe('ops');
  });

  it('🚨 未連携 → 監査も metafield 削除も token 取得も一切しない (冪等 no-op)', async () => {
    unlinkDbMock.mockResolvedValue(NOT_LINKED);
    const del = vi.fn();
    const r = await unlinkAccount(ENV, { friendId: 'f2', actor: 'customer', deleteMetafieldImpl: del });

    expect(r.unlinked).toBe(false);
    // 観測点は外部作用の不在
    expect(mockedAudit).not.toHaveBeenCalled();
    expect(mockedToken).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('metafield 削除が失敗しても解除は成立する (best-effort)', async () => {
    unlinkDbMock.mockResolvedValue(LINKED);
    const del = vi.fn(async () => {
      throw new Error('shopify down');
    });
    const r = await unlinkAccount(ENV, { friendId: 'f1', actor: 'customer', deleteMetafieldImpl: del });
    expect(r.unlinked).toBe(true);
    expect(r.metafieldDeleted).toBe(false);
    expect(mockedAudit).toHaveBeenCalledTimes(1);
  });

  it('Shopify 未設定なら metafield を触らない (解除自体は成立)', async () => {
    unlinkDbMock.mockResolvedValue(LINKED);
    const del = vi.fn();
    const r = await unlinkAccount({ DB: {} as D1Database }, { friendId: 'f1', actor: 'admin', deleteMetafieldImpl: del });
    expect(r.unlinked).toBe(true);
    expect(r.metafieldDeleted).toBe(false);
    expect(del).not.toHaveBeenCalled();
    expect(mockedToken).not.toHaveBeenCalled();
  });

  it('metafield の namespace/key は連携時に書いたもの (ACCOUNT_LINK_*) と同じ既定を使う', async () => {
    unlinkDbMock.mockResolvedValue(LINKED);
    const del = vi.fn(async () => ({ ok: true, userErrors: [] }));
    await unlinkAccount(ENV, { friendId: 'f1', actor: 'admin', deleteMetafieldImpl: del });
    const args = del.mock.calls[0] as unknown as unknown[];
    expect(args[2]).toBe('900'); // customerId
    expect(args[3]).toBe('naturism'); // namespace 既定
    expect(args[4]).toBe('line_user_id'); // key 既定
  });
});

describe('POST /api/admin/account-link/unlink', () => {
  async function post(body: unknown) {
    return accountLinkAdmin.request(
      '/api/admin/account-link/unlink',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      ENV as unknown as Record<string, unknown>,
    );
  }

  it('friendId 必須 (欠落は 400・DB を触らない)', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(unlinkDbMock).not.toHaveBeenCalled();
  });

  it('空文字 friendId も 400', async () => {
    const res = await post({ friendId: '   ' });
    expect(res.status).toBe(400);
    expect(unlinkDbMock).not.toHaveBeenCalled();
  });

  it('解除成功 → 200 + cleared の内訳を返す', async () => {
    unlinkDbMock.mockResolvedValue(LINKED);
    const res = await post({ friendId: 'f1' });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { success: boolean; data: { unlinked: boolean; cleared: unknown } };
    expect(j.success).toBe(true);
    expect(j.data.unlinked).toBe(true);
    expect(j.data.cleared).toEqual(LINKED.cleared);
  });

  it('未連携でも 200 + unlinked:false (404 にしない = 運用が「消えた」と誤解しない)', async () => {
    unlinkDbMock.mockResolvedValue(NOT_LINKED);
    const res = await post({ friendId: 'f2' });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { data: { unlinked: boolean } };
    expect(j.data.unlinked).toBe(false);
  });
});

describe('POST /api/liff/link/unlink', () => {
  function authedApp(friendId: string | null) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (friendId) {
        (c as unknown as { set: (k: string, v: unknown) => void }).set('liffUser', {
          friendId,
          lineUserId: 'U1',
        });
      }
      await next();
    });
    app.route('/', liffAccountLink as never);
    return app;
  }
  async function post(friendId: string | null, body: unknown = {}) {
    return authedApp(friendId).request(
      '/api/liff/link/unlink',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      ENV as unknown as Record<string, unknown>,
    );
  }

  it('未認証は 401 (DB を触らない)', async () => {
    const res = await post(null);
    expect(res.status).toBe(401);
    expect(unlinkDbMock).not.toHaveBeenCalled();
  });

  it('🚨 friendId は middleware 解決のものだけを使う (client 申告の friendId は無視)', async () => {
    unlinkDbMock.mockResolvedValue(LINKED);
    const res = await post('real-friend', { friendId: 'attacker-target' });
    expect(res.status).toBe(200);
    expect(unlinkDbMock).toHaveBeenCalledTimes(1);
    expect(unlinkDbMock.mock.calls[0][1]).toBe('real-friend');
  });

  it('解除成功 → 200 + 顧客向けメッセージ', async () => {
    unlinkDbMock.mockResolvedValue(LINKED);
    const res = await post('f1');
    const j = (await res.json()) as { success: boolean; data: { unlinked: boolean }; message: string };
    expect(j.success).toBe(true);
    expect(j.data.unlinked).toBe(true);
    expect(j.message).toBe('オンラインストアとの連携を解除しました。');
  });

  it('未連携でも 200 (二度押しでエラーを出さない)', async () => {
    unlinkDbMock.mockResolvedValue(NOT_LINKED);
    const res = await post('f2');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { data: { unlinked: boolean }; message: string };
    expect(j.data.unlinked).toBe(false);
    expect(j.message).toBe('このLINEアカウントは、現在ストアと連携されていません。');
  });

  it('🚨 解除は連携の受付 gate (ACCOUNT_LINK_ENABLED) に依存しない — 受付停止中でも解除できる', async () => {
    unlinkDbMock.mockResolvedValue(LINKED);
    const res = await authedApp('f1').request(
      '/api/liff/link/unlink',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      // ACCOUNT_LINK_ENABLED を一切与えない = 受付は閉じている状態
      { DB: {} as D1Database } as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(200);
    expect(unlinkDbMock).toHaveBeenCalledTimes(1);
  });
});
