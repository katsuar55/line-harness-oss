/**
 * WI-6: line-metafield-migration route のテスト (execute/limit/offset/useSecret/cursor の
 * パラメータ変換と 500 変換)。service 実体は line-metafield-migration.test.ts 側で検証。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockMigrate, mockVerify, mockLegacyAudit } = vi.hoisted(() => ({
  mockMigrate: vi.fn(),
  mockVerify: vi.fn(),
  mockLegacyAudit: vi.fn(),
}));

vi.mock('../services/line-metafield-migration.js', () => ({
  migrateLineUserIdMetafields: mockMigrate,
  verifySearchPathParity: mockVerify,
  auditLegacyMetafieldValues: mockLegacyAudit,
}));

import lineMetafieldMigration from '../routes/line-metafield-migration.js';

const BASE = '/api/integrations/shopify/line-metafield-migration';
const env = { DB: {} } as never;

beforeEach(() => {
  mockMigrate.mockReset().mockResolvedValue({ dryRun: true, candidatesTotal: 2 });
  mockVerify.mockReset().mockResolvedValue({ candidatesTotal: 2, resolved: 2, unresolved: 0, failed: 0 });
  mockLegacyAudit.mockReset().mockResolvedValue({ withLegacyValue: 0, unmatchedCustomerIds: [], nextCursor: null });
});

describe('POST /api/integrations/shopify/line-metafield-migration', () => {
  it('default は dryRun (誤爆防止) / ?execute=1&limit&offset で実書込チャンク', async () => {
    const res = await lineMetafieldMigration.request(BASE, { method: 'POST' }, env);
    expect(res.status).toBe(200);
    expect(mockMigrate).toHaveBeenCalledWith(expect.anything(), {
      dryRun: true,
      limit: undefined,
      offset: undefined,
    });

    await lineMetafieldMigration.request(`${BASE}?execute=1&limit=10&offset=20`, { method: 'POST' }, env);
    expect(mockMigrate).toHaveBeenLastCalledWith(expect.anything(), {
      dryRun: false,
      limit: 10,
      offset: 20,
    });
  });

  it('execute の非 "1" 値は dryRun のまま (execute=true 等の誤指定で書き込まない)', async () => {
    await lineMetafieldMigration.request(`${BASE}?execute=true`, { method: 'POST' }, env);
    expect(mockMigrate).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ dryRun: true }));
  });

  it('service throw → 500 + success:false (false-success を返さない)', async () => {
    mockMigrate.mockRejectedValue(new Error('SHOPIFY_STORE_DOMAIN 未設定'));
    const res = await lineMetafieldMigration.request(BASE, { method: 'POST' }, env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });
});

describe('GET .../verify', () => {
  it('useSecret/limit/offset を service に渡す / throw は 500', async () => {
    const res = await lineMetafieldMigration.request(
      `${BASE}/verify?useSecret=1&limit=5&offset=10`,
      { method: 'GET' },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockVerify).toHaveBeenCalledWith(expect.anything(), {
      useSecret: true,
      limit: 5,
      offset: 10,
    });

    mockVerify.mockRejectedValue(new Error('boom'));
    const res2 = await lineMetafieldMigration.request(`${BASE}/verify`, { method: 'GET' }, env);
    expect(res2.status).toBe(500);
  });
});

describe('GET .../legacy-audit', () => {
  it('cursor を service に渡す / throw は 500', async () => {
    const res = await lineMetafieldMigration.request(
      `${BASE}/legacy-audit?cursor=abc123`,
      { method: 'GET' },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockLegacyAudit).toHaveBeenCalledWith(expect.anything(), { cursor: 'abc123' });

    mockLegacyAudit.mockRejectedValue(new Error('boom'));
    const res2 = await lineMetafieldMigration.request(`${BASE}/legacy-audit`, { method: 'GET' }, env);
    expect(res2.status).toBe(500);
  });
});
