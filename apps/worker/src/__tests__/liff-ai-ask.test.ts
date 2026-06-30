/**
 * 第1波-④ ポータル内蔵AIチャット (LIFF Q&A) のコスト/DoSガード + 配線テスト。
 * - jstDateString / countTodayAiAsks: daily cap 判定の純ロジック (実Workers AIは呼ばない)。
 * - 統合静的ガード: endpoint の burst/daily/generateAiResponse 配線 + LIFF chat UI。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  countTodayAiAsks,
  jstDateString,
  AI_BURST_MAX,
  AI_DAILY_CAP,
  AI_QUESTION_MAX,
} from '../services/liff-ai-ask.js';

function makeCaptureDb(cnt: number) {
  const captured = { sql: '', binds: [] as unknown[] };
  const prepare = (sql: string) => ({
    bind: (...b: unknown[]) => ({
      async first<T>() {
        captured.sql = sql;
        captured.binds = b;
        return { cnt } as unknown as T;
      },
    }),
  });
  return { db: { prepare } as unknown as D1Database, captured: () => captured };
}

describe('liff-ai-ask ガード', () => {
  it('jstDateString: UTC→JST の当日 YYYY-MM-DD', () => {
    expect(jstDateString(Date.UTC(2026, 6, 1, 3, 0, 0))).toBe('2026-07-01'); // JST 12:00 同日
    expect(jstDateString(Date.UTC(2026, 6, 1, 20, 0, 0))).toBe('2026-07-02'); // JST 05:00 翌日
  });

  it('countTodayAiAsks: conversation_logs を friend×当日で数える', async () => {
    const { db, captured } = makeCaptureDb(7);
    const n = await countTodayAiAsks(db, 'friend-1', '2026-07-01');
    expect(n).toBe(7);
    expect(captured().sql).toContain('FROM conversation_logs');
    expect(captured().sql).toContain('created_at LIKE ?');
    expect(captured().binds).toEqual(['friend-1', '2026-07-01%']);
  });

  it('cap 定数が安全側 (連打/日次/文字数の上限が有限)', () => {
    expect(AI_BURST_MAX).toBeGreaterThan(0);
    expect(AI_BURST_MAX).toBeLessThanOrEqual(20);
    expect(AI_DAILY_CAP).toBeGreaterThan(0);
    expect(AI_DAILY_CAP).toBeLessThanOrEqual(100);
    expect(AI_QUESTION_MAX).toBe(500);
  });
});

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string): string => readFileSync(join(root, '..', rel), 'utf8');

describe('liff-ai-ask 統合 (endpoint + UI 配線)', () => {
  const portal = readSrc('routes/liff-portal.ts');
  const pages = readSrc('routes/liff-pages.ts');

  it('endpoint /api/liff/ask が idToken 保護 + 2段ガード + generateAiResponse', () => {
    expect(portal).toContain("'/api/liff/ask'");
    expect(portal).toMatch(/getLiffUser\(c\)[\s\S]{0,160}Unauthorized/);
    expect(portal).toContain("check(`liff-ai:"); // burst
    expect(portal).toContain('countTodayAiAsks'); // daily cap
    expect(portal).toContain('AI_DAILY_CAP');
    expect(portal).toContain('generateAiResponse');
  });

  it('AI 未設定 / 長すぎる質問をガードする', () => {
    expect(portal).toMatch(/if \(!c\.env\.AI\)/);
    expect(portal).toContain('AI_QUESTION_MAX');
  });

  it('LIFF に AIチャットUI (card/input/send) + sendAiChat', () => {
    expect(pages).toContain('id="ai-chat-card"');
    expect(pages).toContain('id="ai-chat-input"');
    expect(pages).toContain('function sendAiChat');
    expect(pages).toContain("fetch(API_BASE + '/api/liff/ask'");
  });

  it('回答は textContent で描画 (XSS安全)', () => {
    expect(pages).toMatch(/bubble\.textContent = text/);
  });

  it('FAQの「AIに質問」はチャットへ誘導 (closeWindow fallback 維持)', () => {
    expect(pages).toMatch(/function askAiFromFaq[\s\S]{0,200}ai-chat-input/);
    expect(pages).toMatch(/function askAiFromFaq[\s\S]{0,400}liff\.closeWindow/);
  });
});
