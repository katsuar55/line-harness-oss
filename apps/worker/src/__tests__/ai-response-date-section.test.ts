/**
 * Regression guard (2026-06-29 UX ブラッシュアップ — ai_reply 事実精度):
 *
 * 採点 ai_reply: AI system prompt に current_date 注入が無く、AI が日付を推測していた。
 * クーポンの「あと◯日」「有効期限」を AI 任せで計算させると、期限切れクーポンを「まだ有効」と
 * 誤案内するリスクがある。本日日付(JST)を contextPrompt に注入して基準を与える。
 *
 * buildDateSection は純関数 (nowMs を引数化) なので、JST 境界を mock 無しで直接テストする。
 */
import { describe, it, expect } from 'vitest';
import { buildDateSection } from '../services/ai-response.js';

describe('buildDateSection — AI prompt への本日日付(JST)注入', () => {
  it('本日日付セクションのヘッダを含む', () => {
    expect(buildDateSection(Date.UTC(2026, 5, 29, 3, 0, 0))).toContain('## 本日の日付');
  });

  it('UTC 昼 → JST 同日 (UTC 2026-06-29 03:00 → JST 12:00 6/29)', () => {
    expect(buildDateSection(Date.UTC(2026, 5, 29, 3, 0, 0))).toContain('2026-06-29');
  });

  it('UTC 早朝 → JST 同日に正しく繰り上がる (UTC 2026-06-29 00:00 → JST 09:00 6/29)', () => {
    expect(buildDateSection(Date.UTC(2026, 5, 29, 0, 0, 0))).toContain('2026-06-29');
  });

  it('UTC 夜 → JST 翌日に繰り上がる (UTC 2026-06-29 16:00 → JST 01:00 6/30)', () => {
    expect(buildDateSection(Date.UTC(2026, 5, 29, 16, 0, 0))).toContain('2026-06-30');
  });

  it('日付基準で答えるよう AI に指示する文言を含む', () => {
    expect(buildDateSection(Date.UTC(2026, 0, 1, 5, 0, 0))).toContain('この日付を基準に');
  });
});
