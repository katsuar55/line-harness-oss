-- Migration: Broadcast insights (open rate / click rate via LINE Insight API)
-- Adds columns to store X-Line-Request-Id from broadcast and cached insight stats.

ALTER TABLE broadcasts ADD COLUMN line_request_id TEXT;
ALTER TABLE broadcasts ADD COLUMN insights_json TEXT;
ALTER TABLE broadcasts ADD COLUMN insights_fetched_at TEXT;

CREATE INDEX IF NOT EXISTS idx_broadcasts_line_request_id ON broadcasts (line_request_id);
