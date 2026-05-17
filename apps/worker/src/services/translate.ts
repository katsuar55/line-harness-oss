/**
 * AI Translation Service — Phase 5β-prep adoption (2026-05-16)
 *
 * Workers AI 直叩き → @line-crm/ai-provider AIRouter 経由に refactor。
 *   - task='translate' → workers-ai 優先 + claude fallback (router 内部で自動)
 *   - PROHIBITED_PHRASES redaction が router 内で適用される (薬機 NG ガード)
 *   - cache layer (D1) は変更なし
 */

import { getCachedTranslation, cacheTranslation } from '@line-crm/db';
import type { AIRouter } from '@line-crm/ai-provider';

const LANG_NAMES: Record<string, string> = {
  ja: 'Japanese',
  en: 'English',
  ko: 'Korean',
  zh: 'Simplified Chinese',
  th: 'Thai',
};

const TRANSLATION_SYSTEM_PROMPT =
  'You are a professional translator. Translate accurately and naturally. Do not add explanations. Output only the translation.';

/**
 * Translate text using AIRouter with caching.
 * @returns 翻訳結果。 router 失敗時は元 text を返す (graceful degradation)
 */
export async function translateText(
  db: D1Database,
  router: AIRouter,
  text: string,
  sourceLang: string,
  targetLang: string,
  context?: string,
): Promise<string> {
  if (sourceLang === targetLang) return text;
  if (!text.trim()) return text;

  const cached = await getCachedTranslation(db, text, sourceLang, targetLang);
  if (cached) return cached;

  const sourceName = LANG_NAMES[sourceLang] || sourceLang;
  const targetName = LANG_NAMES[targetLang] || targetLang;

  const userMessage = context
    ? `Translate the following ${sourceName} text to ${targetName}. Context: ${context}. Only output the translation, no explanations.\n\n${text}`
    : `Translate the following ${sourceName} text to ${targetName}. Only output the translation, no explanations.\n\n${text}`;

  try {
    const result = await router.generateText('translate', {
      systemPrompt: TRANSLATION_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 1024,
    });

    const translated = result.text.trim();
    if (!translated) return text;

    await cacheTranslation(db, text, sourceLang, targetLang, translated, context);

    return translated;
  } catch (err) {
    console.error('Translation error:', err);
    return text;
  }
}

/**
 * Batch translate multiple texts.
 */
export async function batchTranslate(
  db: D1Database,
  router: AIRouter,
  texts: string[],
  sourceLang: string,
  targetLang: string,
  context?: string,
): Promise<string[]> {
  if (sourceLang === targetLang) return texts;

  const results: string[] = [];
  for (const text of texts) {
    results.push(await translateText(db, router, text, sourceLang, targetLang, context));
  }
  return results;
}
