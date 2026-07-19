/**
 * WI-6: LINE userId metafield 移行の管理エンドポイント (CRM PLUS 撤去準備)
 * docs/CRMPLUS_UNINSTALL_RUNBOOK.md の手順から呼ぶ一発物の admin op。
 *
 * 認可: /api 共通 Bearer (API_KEY)。auth skip-list には載せない。
 * 安全設計:
 *   - default は dryRun (対象件数の確認のみ、Shopify への書込・呼出ゼロ)
 *   - 実書込は ?execute=1 を明示したときだけ (誤爆防止)
 *   - チャンク実行 (?limit/?offset): Workers Free の 50 subrequests/invocation 内に収める。
 *     remaining=0 になるまで offset を進めてループする (runbook 参照)
 *   - 冪等なので再実行は安全 (metafieldsSet=upsert / 定義=TAKEN成功扱い)
 *   - gate 不要: 書込対象は自己所有 metafield のみで、既存の連携経路 (secret) には触れない。
 *     経路切替は admin-ops `switch-link-metafield` op (secret 差替) で別途行う
 */
import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  migrateLineUserIdMetafields,
  verifySearchPathParity,
  auditLegacyMetafieldValues,
} from '../services/line-metafield-migration.js';

const lineMetafieldMigration = new Hono<Env>();

function parseIntParam(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

// POST /api/integrations/shopify/line-metafield-migration[?execute=1&limit=10&offset=0]
lineMetafieldMigration.post('/api/integrations/shopify/line-metafield-migration', async (c) => {
  const execute = c.req.query('execute') === '1';
  try {
    const result = await migrateLineUserIdMetafields(c.env, {
      dryRun: !execute,
      limit: parseIntParam(c.req.query('limit')),
      offset: parseIntParam(c.req.query('offset')),
    });
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST line-metafield-migration error:', err);
    return c.json(
      { success: false, error: err instanceof Error ? err.message.slice(0, 300) : 'internal error' },
      500,
    );
  }
});

// GET /api/integrations/shopify/line-metafield-migration/verify[?useSecret=1&limit=20&offset=0]
// 検索経路 (metafields.{ns}.{key}) のパリティ検証。Shopify 検索インデックスは非同期反映の
// ため migration の数分後に実行する。useSecret=1 で FRIEND_LINK secret の実効値を検証
// (= 切替 op 後の成否確認。応答 namespace/key/nsSource で目視確認できる)。
lineMetafieldMigration.get(
  '/api/integrations/shopify/line-metafield-migration/verify',
  async (c) => {
    try {
      const result = await verifySearchPathParity(c.env, {
        useSecret: c.req.query('useSecret') === '1',
        limit: parseIntParam(c.req.query('limit')),
        offset: parseIntParam(c.req.query('offset')),
      });
      return c.json({ success: true, data: result });
    } catch (err) {
      console.error('GET line-metafield-migration/verify error:', err);
      return c.json(
        { success: false, error: err instanceof Error ? err.message.slice(0, 300) : 'internal error' },
        500,
      );
    }
  },
);

// GET /api/integrations/shopify/line-metafield-migration/legacy-audit[?cursor=...]
// アンインストール直前の棚卸し: socialplus.line に値を持つ customer が全員 D1 に
// リンク済みかを全顧客カーソル走査で照合する。nextCursor が返ったら続きを再呼び出し。
lineMetafieldMigration.get(
  '/api/integrations/shopify/line-metafield-migration/legacy-audit',
  async (c) => {
    try {
      const result = await auditLegacyMetafieldValues(c.env, {
        cursor: c.req.query('cursor') ?? null,
      });
      return c.json({ success: true, data: result });
    } catch (err) {
      console.error('GET line-metafield-migration/legacy-audit error:', err);
      return c.json(
        { success: false, error: err instanceof Error ? err.message.slice(0, 300) : 'internal error' },
        500,
      );
    }
  },
);

export default lineMetafieldMigration;
