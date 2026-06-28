/**
 * Regression guard (2026-06-29 顧客導線監査 再採点 PR-E):
 * - rank5(HIGH): portal home は idToken 取得不可で全カードが skeleton 固着していた
 *   → initLiff で idToken null を検出し showFatalError で明示エラー+再読み込みを出す。
 * - AI system prompt の「紹介プログラム=近日リリース(未実装)」が intent-router の
 *   referral live 格上げと矛盾していた → 未実装リストから外し稼働中扱いに。
 * - demo の Blue コピー(脂質カット特化)を対象者ベースに追従。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');
const aiResp = readFileSync(join(root, '..', 'services', 'ai-response.ts'), 'utf8');

describe('portal/AI レジリエンス (監査 再採点 PR-E)', () => {
  it('rank5: initLiff は idToken null で showFatalError し home カードの skeleton 固着を回避', () => {
    expect(pages).toContain('function showFatalError');
    expect(pages).toMatch(/if \(!idToken\) \{[\s\S]{0,500}showFatalError/);
  });

  it('AI system prompt: 紹介プログラムを未実装(近日リリース)に列挙せず稼働中扱い', () => {
    expect(aiResp).not.toContain('紹介プログラム（友だち紹介で割引等の詳細）');
    expect(aiResp).toContain('友だち紹介も稼働中');
  });

  it('demo の Blue コピーも対象者ベースに追従 (脂質カット作用断定を除去)', () => {
    // loadDemoData は非ASCIIを \u エスケープ保存するため escaped 形で検査する
    expect(pages).not.toMatch(/\\u8102\\u8cea\\u30ab\\u30c3\\u30c8/); // 「脂質カット」(escaped)
    expect(pages).toMatch(/\\u8102\\u3063\\u3053\\u3044\\u98df\\u4e8b/); // 「脂っこい食事」(escaped)
  });
});
