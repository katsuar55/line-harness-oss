/**
 * AI Translation Service — Workers AI を使った自動翻訳
 * Cloudflare Workers AI (Qwen3-30B-A3B) で翻訳、D1にキャッシュ
 */

import { getCachedTranslation, cacheTranslation } from '@line-crm/db';

const LANG_NAMES: Record<string, string> = {
  ja: 'Japanese',
  en: 'English',
  ko: 'Korean',
  zh: 'Simplified Chinese',
  th: 'Thai',
};

/**
 * Translate text using Workers AI with caching
 */
export async function translateText(
  db: D1Database,
  ai: Ai,
  text: string,
  sourceLang: string,
  targetLang: string,
  context?: string,
): Promise<string> {
  if (sourceLang === targetLang) return text;
  if (!text.trim()) return text;

  // Check cache first
  const cached = await getCachedTranslation(db, text, sourceLang, targetLang);
  if (cached) return cached;

  // AI translation
  const sourceName = LANG_NAMES[sourceLang] || sourceLang;
  const targetName = LANG_NAMES[targetLang] || targetLang;

  const prompt = context
    ? `Translate the following ${sourceName} text to ${targetName}. Context: ${context}. Only output the translation, no explanations.\n\n${text}`
    : `Translate the following ${sourceName} text to ${targetName}. Only output the translation, no explanations.\n\n${text}`;

  try {
    const result = await ai.run('@cf/qwen/qwen3-30b-a3b-fp8' as Parameters<Ai['run']>[0], {
      messages: [
        { role: 'system', content: 'You are a professional translator. Translate accurately and naturally. Do not add explanations. Output only the translation.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1024,
    }) as { response?: string };

    const translated = (result.response || '').trim();
    if (!translated) return text; // fallback to original

    // Cache the result
    await cacheTranslation(db, text, sourceLang, targetLang, translated, context);

    return translated;
  } catch (err) {
    console.error('Translation error:', err);
    return text; // fallback to original on error
  }
}

/**
 * Batch translate multiple texts
 */
export async function batchTranslate(
  db: D1Database,
  ai: Ai,
  texts: string[],
  sourceLang: string,
  targetLang: string,
  context?: string,
): Promise<string[]> {
  if (sourceLang === targetLang) return texts;

  const results: string[] = [];
  for (const text of texts) {
    results.push(await translateText(db, ai, text, sourceLang, targetLang, context));
  }
  return results;
}
