-- 024: ambassador_feedback テーブル
-- アンバサダーからのフィードバック・アンケート回答を保存

CREATE TABLE IF NOT EXISTS ambassador_feedback (
  id TEXT PRIMARY KEY,
  ambassador_id TEXT NOT NULL REFERENCES ambassadors(id),
  friend_id TEXT NOT NULL REFERENCES friends(id),
  type TEXT NOT NULL DEFAULT 'feedback' CHECK (type IN ('feedback', 'survey', 'product_review')),
  category TEXT DEFAULT 'general' CHECK (category IN ('general', 'product', 'service', 'suggestion', 'other')),
  content TEXT NOT NULL,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S+09:00', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_ambassador_feedback_ambassador ON ambassador_feedback(ambassador_id);
CREATE INDEX IF NOT EXISTS idx_ambassador_feedback_type ON ambassador_feedback(type);
