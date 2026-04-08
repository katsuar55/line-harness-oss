import { jstNow } from './utils.js';

// ===== Friend Language Preference =====

export async function getFriendLanguage(
  db: D1Database,
  friendId: string,
): Promise<string> {
  const result = await db
    .prepare('SELECT preferred_language FROM friends WHERE id = ?')
    .bind(friendId)
    .first<{ preferred_language: string | null }>();
  return result?.preferred_language || 'ja';
}

export async function setFriendLanguage(
  db: D1Database,
  friendId: string,
  lang: string,
): Promise<void> {
  await db
    .prepare('UPDATE friends SET preferred_language = ? WHERE id = ?')
    .bind(lang, friendId)
    .run();
}

// ===== Translation Cache =====

export async function getCachedTranslation(
  db: D1Database,
  sourceText: string,
  sourceLang: string,
  targetLang: string,
): Promise<string | null> {
  const result = await db
    .prepare(
      'SELECT translated_text FROM translations WHERE source_text = ? AND source_lang = ? AND target_lang = ?',
    )
    .bind(sourceText, sourceLang, targetLang)
    .first<{ translated_text: string }>();
  return result?.translated_text ?? null;
}

export async function cacheTranslation(
  db: D1Database,
  sourceText: string,
  sourceLang: string,
  targetLang: string,
  translatedText: string,
  context?: string,
): Promise<void> {
  const id = `trn_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await db
    .prepare(
      `INSERT OR REPLACE INTO translations (id, source_text, source_lang, target_lang, translated_text, context, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, sourceText, sourceLang, targetLang, translatedText, context || null, jstNow())
    .run();
}

// ===== Tips i18n =====

export async function getTipTranslation(
  db: D1Database,
  tipId: string,
  lang: string,
): Promise<{ title: string; content: string } | null> {
  return db
    .prepare('SELECT title, content FROM daily_tips_i18n WHERE tip_id = ? AND lang = ?')
    .bind(tipId, lang)
    .first<{ title: string; content: string }>();
}

export async function saveTipTranslation(
  db: D1Database,
  tipId: string,
  lang: string,
  title: string,
  content: string,
): Promise<void> {
  const id = `ti18n_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await db
    .prepare(
      `INSERT OR REPLACE INTO daily_tips_i18n (id, tip_id, lang, title, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, tipId, lang, title, content, jstNow())
    .run();
}
