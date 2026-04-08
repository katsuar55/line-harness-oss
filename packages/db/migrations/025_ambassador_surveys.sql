-- 025: ambassador_surveys + ambassador_survey_responses
-- アンバサダー向けアンケートテンプレート管理・配信・回答収集

-- アンケートテンプレート
CREATE TABLE IF NOT EXISTS ambassador_surveys (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  survey_type TEXT NOT NULL DEFAULT 'survey' CHECK (survey_type IN ('survey', 'product_test', 'nps')),
  questions TEXT NOT NULL DEFAULT '[]',
  -- questions JSON: [{ "id": "q1", "type": "rating|text|choice|multi_choice", "label": "...", "options": ["A","B","C"], "required": true }]
  target_tier TEXT DEFAULT 'all' CHECK (target_tier IN ('all', 'standard', 'premium')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed', 'archived')),
  sent_count INTEGER NOT NULL DEFAULT 0,
  response_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S+09:00', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S+09:00', 'now', '+9 hours'))
);

-- アンケート回答
CREATE TABLE IF NOT EXISTS ambassador_survey_responses (
  id TEXT PRIMARY KEY,
  survey_id TEXT NOT NULL REFERENCES ambassador_surveys(id) ON DELETE CASCADE,
  ambassador_id TEXT NOT NULL REFERENCES ambassadors(id),
  friend_id TEXT NOT NULL REFERENCES friends(id),
  answers TEXT NOT NULL DEFAULT '{}',
  -- answers JSON: { "q1": 4, "q2": "テキスト回答", "q3": ["A","C"] }
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S+09:00', 'now', '+9 hours'))
);

-- 配信記録
CREATE TABLE IF NOT EXISTS ambassador_survey_deliveries (
  id TEXT PRIMARY KEY,
  survey_id TEXT NOT NULL REFERENCES ambassador_surveys(id) ON DELETE CASCADE,
  ambassador_id TEXT NOT NULL REFERENCES ambassadors(id),
  friend_id TEXT NOT NULL REFERENCES friends(id),
  delivered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S+09:00', 'now', '+9 hours')),
  responded INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ambassador_surveys_status ON ambassador_surveys(status);
CREATE INDEX IF NOT EXISTS idx_ambassador_surveys_type ON ambassador_surveys(survey_type);
CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON ambassador_survey_responses(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_ambassador ON ambassador_survey_responses(ambassador_id);
CREATE INDEX IF NOT EXISTS idx_survey_deliveries_survey ON ambassador_survey_deliveries(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_deliveries_ambassador ON ambassador_survey_deliveries(ambassador_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_responses_unique ON ambassador_survey_responses(survey_id, ambassador_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_deliveries_unique ON ambassador_survey_deliveries(survey_id, ambassador_id);
