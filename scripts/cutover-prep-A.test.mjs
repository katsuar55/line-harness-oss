/**
 * Tests for scripts/cutover-prep-A.mjs
 *
 * Runs with node:test (built-in, no devDependency). Invoke via: pnpm cutover-prep-A:test
 * 純粋関数 + 注入した exec/fetch で I/O 関数を検証する (ネットワーク/wrangler を実呼びしない)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseD1Count,
  evaluateSeed,
  checkTopics,
  summarize,
  runSeedAudit,
  runSmoke,
  runShopifyTopics,
  gatherRows,
  SEED_EXPECTATIONS,
  REQUIRED_SHOPIFY_TOPICS,
} from './cutover-prep-A.mjs';

// ---- parseD1Count ----
test('parseD1Count: wrangler --json 出力から件数を抽出', () => {
  const json = `[\n  {\n    "results": [\n      { "n": 40 }\n    ]\n  }\n]`;
  assert.equal(parseD1Count(json), 40);
});
test('parseD1Count: 件数が無ければ null', () => {
  assert.equal(parseD1Count('error: nope'), null);
  assert.equal(parseD1Count(''), null);
});

// ---- evaluateSeed ----
test('evaluateSeed: min 以上で ok、 未満/欠落で not ok', () => {
  const counts = { auto_replies: 40, scenarios: 1, automations: 1, tags: 14, email_templates: 7, broadcasts: 14, brand_config: 1, shopify_products: 25 };
  const rows = evaluateSeed(counts);
  const byTable = Object.fromEntries(rows.map((r) => [r.table, r]));
  assert.equal(byTable.auto_replies.ok, true);
  assert.equal(byTable.automations.ok, false); // min 3 > 1
  assert.equal(byTable.tags.ok, true);
});
test('evaluateSeed: 欠落テーブル (null) は not ok', () => {
  const rows = evaluateSeed({});
  assert.ok(rows.every((r) => r.ok === false));
  assert.equal(rows.length, SEED_EXPECTATIONS.length);
});

// ---- checkTopics ----
test('checkTopics: 全 topic 揃えば ok', () => {
  const r = checkTopics([...REQUIRED_SHOPIFY_TOPICS, 'extra/topic']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});
test('checkTopics: 不足 topic を列挙', () => {
  const partial = REQUIRED_SHOPIFY_TOPICS.slice(0, 3);
  const r = checkTopics(partial);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('inventory_levels/update'));
});

// ---- summarize ----
test('summarize: GAP があれば go=false / exit 1、 無ければ go=true / exit 0', () => {
  assert.deepEqual(summarize([{ status: 'OK' }, { status: 'SKIP' }, { status: 'GATE' }]), { go: true, gapCount: 0, exitCode: 0 });
  const s = summarize([{ status: 'OK' }, { status: 'GAP' }]);
  assert.equal(s.go, false);
  assert.equal(s.exitCode, 1);
});

// ---- runSeedAudit (注入 exec) ----
test('runSeedAudit: 各テーブルの COUNT を 1 クエリずつ取得', () => {
  const calls = [];
  const fakeExec = (cmd) => {
    calls.push(cmd);
    const m = cmd.match(/FROM (\w+)/);
    const fixtures = { auto_replies: 40, scenarios: 1, automations: 6, tags: 14, email_templates: 7, broadcasts: 14, brand_config: 1, shopify_products: 25 };
    return `[{"results":[{"n": ${fixtures[m[1]] ?? 0}}]}]`;
  };
  const counts = runSeedAudit({ exec: fakeExec });
  assert.equal(counts.auto_replies, 40);
  assert.equal(counts.shopify_products, 25);
  // compound SELECT 上限回避: テーブルごとに別クエリ
  assert.equal(calls.length, SEED_EXPECTATIONS.length);
});
test('runSeedAudit: exec が throw しても null で継続', () => {
  const counts = runSeedAudit({ exec: () => { throw new Error('7403'); } });
  assert.ok(Object.values(counts).every((v) => v === null));
});

// ---- runSmoke (注入 fetch) ----
test('runSmoke: root 200 を返す', async () => {
  const status = await runSmoke({ fetchImpl: async () => ({ status: 200 }) });
  assert.equal(status, 200);
});
test('runSmoke: 例外時 null', async () => {
  const status = await runSmoke({ fetchImpl: async () => { throw new Error('net'); } });
  assert.equal(status, null);
});

// ---- runShopifyTopics (注入 fetch) ----
test('runShopifyTopics: API_KEY 無しは skip', async () => {
  const r = await runShopifyTopics({ apiKey: undefined });
  assert.equal(r.skipped, true);
});
test('runShopifyTopics: 全 topic 購読済なら ok', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => ({ data: { webhooks: REQUIRED_SHOPIFY_TOPICS.map((t) => ({ topic: t })) } }),
  });
  const r = await runShopifyTopics({ apiKey: 'k', fetchImpl });
  assert.equal(r.skipped, false);
  assert.equal(r.ok, true);
});
test('runShopifyTopics: --register 時は register エンドポイントも叩く', async () => {
  const hits = [];
  const fetchImpl = async (url, opts) => {
    hits.push(`${opts?.method ?? 'GET'} ${url}`);
    return { ok: true, json: async () => ({ data: { webhooks: REQUIRED_SHOPIFY_TOPICS.map((t) => ({ topic: t })) } }) };
  };
  await runShopifyTopics({ apiKey: 'k', fetchImpl, register: true });
  assert.ok(hits.some((h) => h.startsWith('POST') && h.includes('/register')));
  assert.ok(hits.some((h) => h.startsWith('GET') && h.endsWith('/webhooks')));
});

// ---- gatherRows (統合: 注入 exec + fetch) ----
test('gatherRows: 全緑シナリオ', async () => {
  const fakeExec = (cmd) => {
    if (cmd.includes('NOT LIKE')) return `[{"results":[{"n": 0}]}]`; // inventory 欠落 0
    const m = cmd.match(/FROM (\w+)/);
    const fixtures = { auto_replies: 40, scenarios: 1, automations: 6, tags: 14, email_templates: 7, broadcasts: 14, brand_config: 1, shopify_products: 25 };
    return `[{"results":[{"n": ${fixtures[m[1]] ?? 0}}]}]`;
  };
  const fetchImpl = async (url) => {
    if (url.endsWith('/')) return { status: 200 };
    return { ok: true, json: async () => ({ data: { webhooks: REQUIRED_SHOPIFY_TOPICS.map((t) => ({ topic: t })) } }) };
  };
  const rows = await gatherRows({ exec: fakeExec, fetchImpl, apiKey: 'k' });
  assert.equal(summarize(rows).go, true);
  assert.equal(rows.find((r) => r.id === 'A-1').status, 'OK');
  assert.equal(rows.find((r) => r.id === 'A-3').status, 'OK');
  assert.equal(rows.find((r) => r.id === 'A-5').status, 'OK');
});
test('gatherRows: seed 空 + inventory 欠落 + smoke 不通 は GAP', async () => {
  const fakeExec = (cmd) => {
    if (cmd.includes('NOT LIKE')) return `[{"results":[{"n": 3}]}]`; // 3 件欠落
    return `[{"results":[{"n": 0}]}]`; // 全テーブル空
  };
  const fetchImpl = async () => { throw new Error('down'); };
  const rows = await gatherRows({ exec: fakeExec, fetchImpl, apiKey: undefined });
  const s = summarize(rows);
  assert.equal(s.go, false);
  assert.equal(rows.find((r) => r.id === 'A-1').status, 'GAP'); // smoke 不通
  assert.equal(rows.find((r) => r.id === 'A-3').status, 'GAP'); // inventory 欠落
  assert.equal(rows.find((r) => r.id === 'A-5').status, 'SKIP'); // API_KEY 無し
});
