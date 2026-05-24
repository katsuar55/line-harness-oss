-- Migration 053: conversation_logs table (Phase 3.1 ULTRATHINK、 2026-05-24)
--
-- 目的:
--   AI 応答の質問 + 応答 + friend_id + meta を蓄積。 後の fine-tune data 化 / admin で
--   「user 質問傾向」 分析 / KB 拡充材料 / 薬機法 NG 検知後の trace 元。
--
-- schema:
--   - id TEXT PK
--   - friend_id TEXT FK (CASCADE DELETE)
--   - user_message TEXT NOT NULL (= 質問、 最大 500 文字 by sanitization)
--   - ai_response TEXT NOT NULL (= 応答)
--   - ai_layer TEXT (= 'keyword' / 'ai' / 'fallback'、 既存 AiResponseResult.layer と同期)
--   - ai_model TEXT (= 使用モデル名、 e.g. '@cf/qwen/qwen3-30b-a3b-fp8')
--   - ng_words_detected TEXT (= JSON array、 検出された NG word リスト、 検出なしなら NULL)
--   - friend_context TEXT (= JSON、 birth_month/age_group/tags/score 等の context snapshot)
--   - created_at TEXT
--
-- index:
--   - friend_id: 個別 user 履歴検索
--   - created_at DESC: 時系列分析
--   - ng_words_detected (NOT NULL): 薬機法 NG 検知 履歴
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 migrations apply naturism-line-crm --remote
--   または直接:
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\053_conversation_logs.sql

CREATE TABLE IF NOT EXISTS conversation_logs (
  id                   TEXT PRIMARY KEY,
  friend_id            TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  user_message         TEXT NOT NULL,
  ai_response          TEXT NOT NULL,
  ai_layer             TEXT,
  ai_model             TEXT,
  ng_words_detected    TEXT,
  friend_context       TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_conversation_logs_friend
  ON conversation_logs(friend_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_logs_created
  ON conversation_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_logs_ng
  ON conversation_logs(created_at DESC)
  WHERE ng_words_detected IS NOT NULL;
