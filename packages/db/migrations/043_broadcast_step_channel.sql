-- Round 4 PR-6 段階 2: broadcast.ts / step-delivery.ts dispatcher 化
--
-- 目的: ChannelDispatcher (PR-3) を broadcast / scenario_steps からも呼べるようにする。
--   既存の LINE 一斉配信 / シナリオ配信は channel='line' (default) で挙動不変。
--   新規追加された 'email' / 'both' を選択することで dispatcher 経由の email 送信が可能になる。
--
-- 設計方針:
-- - Additive only (DROP / DELETE なし)。既存行は DEFAULT 'line' で挙動不変。
-- - email_template_id は email_templates(id) を指す想定。FK 制約は付けず緩い参照に
--   (email_templates 側は migration 042 で新設済、互いに独立した運用ライフサイクル)。
-- - CHECK 制約は ALTER TABLE で追加できないので、値ドメインは app 層で validate する。
--
-- 関連: docs/ROUND4_EMAIL_ULTRAPLAN.md §5 PR-6.2

-- ============================================================
-- broadcasts: channel + email_template_id
-- ============================================================
ALTER TABLE broadcasts ADD COLUMN channel TEXT NOT NULL DEFAULT 'line';
ALTER TABLE broadcasts ADD COLUMN email_template_id TEXT;

-- ============================================================
-- scenario_steps: channel + email_template_id
-- ============================================================
ALTER TABLE scenario_steps ADD COLUMN channel TEXT NOT NULL DEFAULT 'line';
ALTER TABLE scenario_steps ADD COLUMN email_template_id TEXT;

-- ============================================================
-- index: channel 別の絞り込みが多発する想定で軽い index を張る
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_broadcasts_channel ON broadcasts(channel);
CREATE INDEX IF NOT EXISTS idx_scenario_steps_channel ON scenario_steps(channel);
