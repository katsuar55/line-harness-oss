-- Phase 4: AI パーソナル栄養コーチ + サプリ クロスセル提案
--
-- nutrition_recommendations: 1 友だち × 1 週ごとの栄養レコメンド
-- nutrition_sku_map:         栄養不足キー → naturism SKU の辞書 (seed あり)
--
-- 設計方針:
-- - Phase 3 (food_logs / daily_food_stats) の PFC データを消費する側
-- - status を遷移させて active → clicked → converted を追跡
-- - conversion_event_id 経由で既存 CV 計測基盤と紐付け (重複計測しない)
-- - SKU マップは seed で 5 件 (naturism の主要サプリ)。運用で追記可能
-- - 薬機法ガード: ai_message は services/nutrition-recommender.ts で
--   PROHIBITED_PHRASES でフィルタしてから保存
--
-- インデックス方針:
-- - friend_id + generated_at DESC (LIFF /api/coach/latest 用)
-- - status='active' の partial index (週次 push バッチ用)

CREATE TABLE IF NOT EXISTS nutrition_recommendations (
  id                     TEXT PRIMARY KEY,
  friend_id              TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  generated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  -- 栄養不足の解析結果 (JSON 配列):
  --   [{ key:'protein_low', observedAvg:55, targetAvg:80, severity:'mild' }, ...]
  deficit_json           TEXT NOT NULL,
  -- 提案 SKU 群 (JSON 配列):
  --   [{ shopifyProductId:'gid://shopify/Product/...', productTitle:'...',
  --      copy:'...', deficitKey:'protein_low' }, ...]
  sku_suggestions_json   TEXT NOT NULL,
  -- AI 生成のパーソナルメッセージ (薬機ガード後)。失敗時はテンプレ
  ai_message             TEXT NOT NULL,
  -- ステート: active (生成直後) / dismissed (友だちが却下) / clicked / converted
  status                 TEXT NOT NULL DEFAULT 'active',
  -- 配信タイミング (push 送信時刻)。LIFF 単体表示時は NULL
  sent_at                TEXT,
  clicked_at             TEXT,
  converted_at           TEXT,
  -- CV 連動: クリック → 購入したら conversion_events.id を紐付け
  conversion_event_id    TEXT REFERENCES conversion_events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_nutrition_reco_friend
  ON nutrition_recommendations (friend_id, generated_at DESC);

-- 週次 push の対象抽出を高速化 (active のみ走査)
CREATE INDEX IF NOT EXISTS idx_nutrition_reco_active
  ON nutrition_recommendations (status, generated_at)
  WHERE status = 'active';

-- 集計 (CTR/CVR) の高速化用
CREATE INDEX IF NOT EXISTS idx_nutrition_reco_status_generated
  ON nutrition_recommendations (status, generated_at DESC);

-- ─────────────────────────────────────────────
-- nutrition_sku_map — 栄養不足キー → SKU 辞書
--
-- deficit_key の命名: <nutrient>_<direction>
--   protein_low / fiber_low / iron_low / calorie_low / calorie_high
--
-- copy_template は "60 字以内・効能効果断定なし" のフォーマット文。
-- AI が patch する余地を残す (例: "[friend_name] さん、…" の置換変数)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nutrition_sku_map (
  deficit_key         TEXT PRIMARY KEY,
  shopify_product_id  TEXT NOT NULL,
  product_title       TEXT NOT NULL,
  copy_template       TEXT NOT NULL,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- naturism の代表 SKU を seed (本番運用では shopify_product_id を実 GID に置換すること)
-- INSERT OR IGNORE で再適用しても重複しない
INSERT OR IGNORE INTO nutrition_sku_map (deficit_key, shopify_product_id, product_title, copy_template) VALUES
  ('protein_low',  'placeholder://protein',  'naturism プロテインサポート',     '今週のたんぱく質摂取が控えめでした。手軽に補給できる選択肢として'),
  ('fiber_low',    'placeholder://fiber',    'naturism 食物繊維プラス',        '食物繊維がやや不足気味の週でした。1 日 1 回のシンプルな補給に'),
  ('iron_low',     'placeholder://iron',     'naturism 鉄分ケア',              '鉄分が控えめな週でした。バランスを意識したい方の選択肢として'),
  ('calorie_low',  'placeholder://multi',    'naturism マルチビタミン',        '全体的にカロリーが控えめでした。栄養の土台を整えるサポートに'),
  ('calorie_high', 'placeholder://lactic',   'naturism 乳酸菌バランス',        'カロリーが多めの週でした。日々のお腹バランスを整えたい方に');
