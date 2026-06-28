/**
 * Tests for generateAiResponse fallback logging (= AI 応答 observability hardening, 2026-06-05)
 *
 * バグ: result.text 空 / 例外 の 2 つの fallback 経路が conversation_logs に何も記録しないため、
 *   provider 障害 (= 全モデル fail → 定型 fallback) が完全に不可視だった
 *   ([[feedback_ai_model_silent_fallback]]: Qwen→Llama の黙殺が 1ヶ月気付かれなかった教訓)。
 * 修正: 両 fallback 経路で best-effort に ai_layer='fallback' を記録し、 provider 健全性を query 可能にする。
 *
 * ai-response.ts は dynamic import なし → vi.mock('@line-crm/db') 安全。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@line-crm/db', () => ({ getFriendTags: vi.fn(async () => []) }));
vi.mock('../services/ai-fact-context.js', () => ({
  getActiveBroadcastsContext: vi.fn(async () => ''),
  getFriendCouponContext: vi.fn(async () => ''),
}));

import { generateAiResponse } from '../services/ai-response.js';

/** conversation_logs INSERT の bind を記録する fake db */
function makeDb() {
  const inserts: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        _b: [] as unknown[],
        bind(...a: unknown[]) {
          stmt._b = a;
          return stmt;
        },
        async run() {
          if (sql.includes('INSERT INTO conversation_logs')) inserts.push(stmt._b);
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [], success: true };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, inserts };
}

type Router = Parameters<typeof generateAiResponse>[0];
function fakeRouter(impl: () => Promise<{ text: string; model: string }>): Router {
  return { generateText: vi.fn(impl) } as unknown as Router;
}

// conversation_logs bind 順: id(0), friend_id(1), user_message(2), ai_response(3), ai_layer(4), ai_model(5), ...
describe('generateAiResponse — fallback logging', () => {
  it('全モデル空応答 → fallback を ai_layer=fallback で記録 (= どのモデルが空かも残す)', async () => {
    const { db, inserts } = makeDb();
    const router = fakeRouter(async () => ({ text: '', model: 'llama-x' }));
    const r = await generateAiResponse(router, db, 'f1', 0, '2026-01-01', 'こんにちは');
    expect(r.layer).toBe('fallback');
    expect(inserts.length).toBe(1);
    expect(inserts[0][1]).toBe('f1');
    expect(inserts[0][4]).toBe('fallback');
    expect(inserts[0][5]).toBe('llama-x');
  });

  it('router が throw → fallback を ai_layer=fallback で記録 (= provider 障害可視化)', async () => {
    const { db, inserts } = makeDb();
    const router = fakeRouter(async () => {
      throw new Error('provider down');
    });
    const r = await generateAiResponse(router, db, 'f2', 5, '2026-01-01', 'やあ');
    expect(r.layer).toBe('fallback');
    expect(inserts.length).toBe(1);
    expect(inserts[0][1]).toBe('f2');
    expect(inserts[0][4]).toBe('fallback');
  });

  it('正常応答 → ai_layer=ai で記録 (regression baseline)', async () => {
    const { db, inserts } = makeDb();
    const router = fakeRouter(async () => ({ text: 'お答えします', model: 'qwen' }));
    const r = await generateAiResponse(router, db, 'f3', 0, '2026-01-01', '質問');
    expect(r.layer).toBe('ai');
    expect(inserts.length).toBe(1);
    expect(inserts[0][4]).toBe('ai');
  });

  // 2026-06-15 (Launch-readiness review B2): 薬機法 NG word が AI 応答に混入したら
  // 顧客には送らず中立な定型文に差し替える (送信前の最終ゲート)。原文は監査ログに残す。
  it('AI応答に薬機法NG語 → 顧客には送らずコンプラ定型文に差し替え (原文はlog保持)', async () => {
    const { db, inserts } = makeDb();
    const ngText = 'naturism Blueを飲めば痩せます。脂肪燃焼を促進します。';
    const router = fakeRouter(async () => ({ text: ngText, model: 'qwen' }));
    const r = await generateAiResponse(router, db, 'f4', 0, '2026-01-01', '痩せますか？');
    // 顧客向け text は NG 文ではない
    expect(r.text).not.toContain('痩せ');
    expect(r.text).not.toContain('脂肪燃焼');
    expect(r.text).toContain('カスタマーサポート');
    expect(r.ngDetected && r.ngDetected.length).toBeGreaterThan(0);
    // conversation_logs には原文 (NG文) が記録される (監査)
    expect(inserts.length).toBe(1);
    expect(inserts[0][3]).toBe(ngText);
  });

  // 2026-06-29 顧客導線監査 (rank 3): provider (workers-ai) が prohibited phrase を
  // REDACTION_TOKEN '[省略]' に置換して返すと、detectNgWords は置換後を検査して NG を
  // 取りこぼし、内部トークン [省略] が顧客に漏れていた。REDACTION_TOKEN 残存自体を block する。
  it('AI応答に redact トークン [省略] → 顧客には漏らさずコンプラ定型文に差し替え (ログ保持)', async () => {
    const { db, inserts } = makeDb();
    const redactedText = 'naturism Blue は[省略]をサポートします🌿';
    const router = fakeRouter(async () => ({ text: redactedText, model: 'llama-4-scout' }));
    const r = await generateAiResponse(router, db, 'f5', 0, '2026-01-01', '脂肪燃焼に効きますか？');
    // 顧客向け text に内部トークン [省略] が漏れない
    expect(r.text).not.toContain('[省略]');
    expect(r.layer).toBe('fallback');
    expect(r.text).toContain('カスタマーサポート');
    expect(r.ngDetected).toContain('[省略]');
    // conversation_logs には原文 (redact 済) が ai_response として残る (監査)
    expect(inserts.length).toBe(1);
    expect(inserts[0][3]).toBe(redactedText);
  });
});
