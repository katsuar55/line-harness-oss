-- ============================================================
-- Migration 048: audit_logs (運用記録テーブル)
--
-- 目的 (Phase 5α-3 / Ultraplan v4 大方針 3 Lステップ網羅):
--   - admin / system / cron / webhook / api アクターの destructive / 重要 操作を記録
--   - 監査・トラブルシューティング・5η RBAC 強化の前提
--   - line_account_id 列で multi-tenant 対応 (大方針 2 整合)
--
-- 設計方針:
--   - **append-only**: 既存 row の UPDATE/DELETE は禁止 (運用ルールで担保)
--   - **best-effort logging**: 書き込み失敗が business operation を巻き込まない
--   - **PII 最小化**: IP は SHA-256 hash で保存、 actor_name は snapshot (削除後も判別可)
--   - **JSON 拡張**: before/after/metadata は JSON 文字列、 自由スキーマ
--
-- インデックス戦略:
--   - account 別 timeline / actor 別 / target 別 / action 別 / 全件 timeline
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id              TEXT PRIMARY KEY,
  -- multi-tenant (NULL = system-wide)
  line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  -- 'admin' | 'system' | 'cron' | 'webhook' | 'api'
  actor_type      TEXT NOT NULL,
  -- admin user id / cron job id 等。 NULL = anonymous system
  actor_id        TEXT,
  -- 操作時点の actor 表示名 snapshot (削除されても判別可)
  actor_name      TEXT,
  -- 'broadcast.send' / 'friend.delete' / 'template.update' 等の dot-notation
  action          TEXT NOT NULL,
  -- 'broadcast' / 'friend' / 'template' / 'automation' 等
  target_type     TEXT,
  target_id       TEXT,
  -- 1 リクエストにまたがる複数 audit を結合する trace ID
  request_id      TEXT,
  -- IP は SHA-256 hash で保存 (PII 最小化)
  ip_hash         TEXT,
  user_agent      TEXT,
  -- 操作前/後の値 snapshot (JSON 文字列、 destructive 操作で重要)
  before_value    TEXT,
  after_value     TEXT,
  -- 'success' | 'failure'
  result          TEXT NOT NULL DEFAULT 'success',
  -- failure 時の概要 (詳細は metadata に)
  error_message   TEXT,
  -- 拡張 (request body summary / 影響レコード数 等)
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- account 別 timeline (admin UI で「この account の最近の操作」)
CREATE INDEX IF NOT EXISTS idx_audit_logs_account_time
  ON audit_logs(line_account_id, created_at DESC);

-- actor 別 (「この admin が何をしたか」)
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
  ON audit_logs(actor_type, actor_id, created_at DESC);

-- target 別 (「この broadcast に対する操作履歴」)
CREATE INDEX IF NOT EXISTS idx_audit_logs_target
  ON audit_logs(target_type, target_id, created_at DESC);

-- action 別 (「直近 24h で broadcast.send が何回?」)
CREATE INDEX IF NOT EXISTS idx_audit_logs_action
  ON audit_logs(action, created_at DESC);

-- 全件 timeline (監査用 csv export 等)
CREATE INDEX IF NOT EXISTS idx_audit_logs_time
  ON audit_logs(created_at DESC);
