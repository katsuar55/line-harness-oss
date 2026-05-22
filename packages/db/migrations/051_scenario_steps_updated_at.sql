-- Migration 051: scenario_steps.updated_at column (= technical debt #2 解消)
--
-- 目的:
--   - scenario_steps の編集 timestamp を track (= 編集履歴 / cache invalidation 等で future-proof)
--   - 既存 row は created_at で backfill (= 「最後の知られた変更」 として)
--   - 以後の INSERT / UPDATE は TRIGGER で自動 set (= worker code 修正不要)
--
-- 設計:
--   - ALTER TABLE で nullable column 追加 (= SQLite 制約で non-constant default 不可)
--   - 既存 row backfill (= UPDATE で created_at コピー)
--   - INSERT trigger: 明示 set されなかった (NEW.updated_at IS NULL) 時のみ自動 set
--   - UPDATE trigger: 編集対象 column が変わった時に自動 set
--   - SQLite default で recursive_triggers OFF → trigger 内 UPDATE は再帰しない (safe)
--
-- backward compat:
--   - 既存 worker code は updated_at を意識しないが、 TRIGGER で自動補完される
--   - 新規 query で `SELECT ... ORDER BY updated_at DESC` 等可能

-- 1. column 追加
ALTER TABLE scenario_steps ADD COLUMN updated_at TEXT;

-- 2. 既存 row backfill
UPDATE scenario_steps SET updated_at = created_at WHERE updated_at IS NULL;

-- 3. INSERT trigger (= 明示 set がなければ自動)
CREATE TRIGGER IF NOT EXISTS scenario_steps_set_updated_at_on_insert
  AFTER INSERT ON scenario_steps
  FOR EACH ROW
  WHEN NEW.updated_at IS NULL
  BEGIN
    UPDATE scenario_steps
      SET updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
      WHERE id = NEW.id;
  END;

-- 4. UPDATE trigger (= 編集対象 column が変わったら自動 set)
CREATE TRIGGER IF NOT EXISTS scenario_steps_set_updated_at_on_update
  AFTER UPDATE OF
    step_order,
    delay_minutes,
    message_type,
    message_content,
    condition_type,
    condition_value,
    next_step_on_false,
    channel,
    email_template_id
  ON scenario_steps
  FOR EACH ROW
  BEGIN
    UPDATE scenario_steps
      SET updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
      WHERE id = NEW.id;
  END;

-- 5. index for time-based queries (= 編集履歴 / cache invalidation 用)
CREATE INDEX IF NOT EXISTS idx_scenario_steps_updated_at ON scenario_steps (updated_at);
