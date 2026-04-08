-- 026: i18n (多言語対応)
-- 翻訳テーブル + 友だちの言語設定

-- 友だちに preferred_language カラム追加
ALTER TABLE friends ADD COLUMN preferred_language TEXT DEFAULT 'ja' CHECK (preferred_language IN ('ja', 'en', 'ko', 'zh', 'th'));

-- 翻訳キャッシュ（AI翻訳結果の保存）
CREATE TABLE IF NOT EXISTS translations (
  id TEXT PRIMARY KEY,
  source_text TEXT NOT NULL,
  source_lang TEXT NOT NULL DEFAULT 'ja',
  target_lang TEXT NOT NULL CHECK (target_lang IN ('ja', 'en', 'ko', 'zh', 'th')),
  translated_text TEXT NOT NULL,
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S+09:00', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_translations_lookup ON translations(source_lang, target_lang, source_text);
CREATE UNIQUE INDEX IF NOT EXISTS idx_translations_unique ON translations(source_text, source_lang, target_lang);

-- Tips の多言語版
CREATE TABLE IF NOT EXISTS daily_tips_i18n (
  id TEXT PRIMARY KEY,
  tip_id TEXT NOT NULL,
  lang TEXT NOT NULL CHECK (lang IN ('en', 'ko', 'zh', 'th')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S+09:00', 'now', '+9 hours'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tips_i18n_unique ON daily_tips_i18n(tip_id, lang);
CREATE INDEX IF NOT EXISTS idx_tips_i18n_lang ON daily_tips_i18n(lang);
