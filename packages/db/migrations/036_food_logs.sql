-- Phase 3: AI 食事診断 + カロリー記録
--
-- food_logs:        食事ログ 1 行 = 1 食 (画像 + AI 解析結果)
-- daily_food_stats: 日次集計 (LIFF グラフを O(1) で描くための事前集計テーブル)
--
-- 設計方針:
-- - 画像本体は R2 に保存し、DB は image_url のみ保持 (D1 の容量と読込コスト最小化)
-- - AI 解析結果は ai_analysis (JSON) にまとめて保存。モデル更新時の互換性のため柔軟スキーマ
-- - 集計に使う 4 値 (calories / protein / fat / carbs) は冗長カラムにキャッシュし、
--   毎回 JSON パースしない (週/月グラフは 30〜90 行スキャンするため)
-- - daily_food_stats は food_logs INSERT 時に upsert 集計
-- - meal_type は intake_logs と命名統一 (breakfast / lunch / dinner / snack / NULL)
-- - 個人情報配慮: friend 削除で食事ログも cascade 削除
--
-- 重さリスク対策:
-- - インデックス: friend_id + ate_at DESC (履歴ページネーション)
-- - インデックス: friend_id + 日付部分 (日次クエリ)
-- - 集計テーブルにより month グラフは 30〜31 行スキャンで足りる

CREATE TABLE IF NOT EXISTS food_logs (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  ate_at          TEXT NOT NULL,                    -- ISO8601 JST (撮影時刻 or 手動入力時刻)
  meal_type       TEXT,                             -- breakfast / lunch / dinner / snack / NULL
  image_url       TEXT,                             -- R2 公開 URL (NULL なら手動テキスト入力のみ)
  raw_text        TEXT,                             -- ユーザ入力 / キャプション (検索用)
  ai_analysis     TEXT,                             -- JSON: {calories, protein_g, fat_g, carbs_g, fiber_g, items[{name,qty}], notes, model_version}
  total_calories  INTEGER,                          -- ai_analysis.calories の冗長キャッシュ
  total_protein_g REAL,
  total_fat_g     REAL,
  total_carbs_g   REAL,
  analysis_status TEXT NOT NULL DEFAULT 'pending',  -- pending / completed / failed
  error_message   TEXT,                             -- 解析失敗時のエラー要約 (ユーザ表示用)
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_food_logs_friend_ate
  ON food_logs (friend_id, ate_at DESC);

-- 日次クエリ高速化 (substr で YYYY-MM-DD 抽出)
CREATE INDEX IF NOT EXISTS idx_food_logs_friend_date
  ON food_logs (friend_id, substr(ate_at, 1, 10));

CREATE TABLE IF NOT EXISTS daily_food_stats (
  friend_id        TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  date             TEXT NOT NULL,                   -- YYYY-MM-DD (JST)
  total_calories   INTEGER NOT NULL DEFAULT 0,
  total_protein_g  REAL NOT NULL DEFAULT 0,
  total_fat_g      REAL NOT NULL DEFAULT 0,
  total_carbs_g    REAL NOT NULL DEFAULT 0,
  meal_count       INTEGER NOT NULL DEFAULT 0,
  last_updated     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (friend_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_food_stats_friend
  ON daily_food_stats (friend_id, date DESC);

-- 解析中ログを高速検出するための partial index (retry cron 用)
-- WHERE 句は Phase 1 の idx_intake_logs_unique_meal と同じパターン
CREATE INDEX IF NOT EXISTS idx_food_logs_pending
  ON food_logs (friend_id, created_at)
  WHERE analysis_status = 'pending';

-- 月次 AI レポート (pull 型・LIFF からの能動取得のみ、push 配信しない)
-- 食事ログ自体とは別テーブルで分離し、ログ削除時にレポートが消えないようにする
CREATE TABLE IF NOT EXISTS monthly_food_reports (
  friend_id    TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  year_month   TEXT NOT NULL,                    -- "2026-04" (JST)
  summary_text TEXT NOT NULL,                    -- AI 生成テキスト (薬機ガード後)
  meal_count   INTEGER NOT NULL DEFAULT 0,       -- 集計対象になった食事ログ数
  avg_calories INTEGER,                          -- 月平均カロリー (NULL=データ不足)
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (friend_id, year_month)
);

CREATE INDEX IF NOT EXISTS idx_monthly_food_reports_generated
  ON monthly_food_reports (friend_id, generated_at DESC);
