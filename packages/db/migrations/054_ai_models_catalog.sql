-- Migration 054: ai_models_catalog table (= 自動 update 戦略 #1、 2026-05-26)
--
-- 目的:
--   Cloudflare Workers AI で利用可能な model 一覧を蓄積。
--   - 新 model リリース時の手動 monitoring を不要化 (cron + Discord 通知)
--   - primary/fallback 候補の judge 材料 (= capability / family / vendor)
--   - 将来的に ai-router auto-select の primary 候補 source (= 戦略 #3 への布石)
--   - admin web で可視化 (= /ai-models page、 後続 PR)
--
-- 5/26 教訓 (= feedback_ai_model_silent_fallback.md):
--   Qwen primary が 1 ヶ月以上 silent fail。 model 切替の判断材料を一元化することで
--   「設計と production の乖離」 を早期検知する基盤を作る。
--
-- schema:
--   - id TEXT PK (= UUID)
--   - model_id TEXT UNIQUE NOT NULL (= e.g. '@cf/meta/llama-4-scout-17b-16e-instruct')
--   - vendor TEXT NOT NULL (= e.g. 'meta', 'google', 'qwen', 'mistral')
--   - family TEXT NOT NULL (= e.g. 'llama', 'gemma', 'qwen')
--   - size_label TEXT NULLABLE (= e.g. '17b-16e', '26b', '30b-a3b')
--   - task TEXT NOT NULL (= e.g. 'text-generation', 'embedding', 'speech-to-text')
--   - capabilities TEXT NULLABLE (= JSON array, e.g. '["text", "vision", "multilingual"]')
--   - context_window INTEGER NULLABLE (= e.g. 32768)
--   - description TEXT NULLABLE
--   - is_beta INTEGER 0/1 (= Cloudflare beta tag)
--   - is_deprecated INTEGER 0/1 (= manually marked or detected via missing from sync)
--   - primary_candidate INTEGER 0/1 (= 1 なら admin web で primary 推奨 markup)
--   - fallback_candidate INTEGER 0/1 (= 同上 fallback 推奨)
--   - first_seen_at TEXT (= 初回 catalog 登録時刻 JST)
--   - last_seen_at TEXT (= 直近 sync で API response に含まれた時刻、 deprecated 検出用)
--   - last_synced_at TEXT NULLABLE (= 直近 sync 実行時刻、 API 連動済 row のみ)
--   - raw_metadata TEXT NULLABLE (= JSON、 Cloudflare API response の全 fields)
--   - source TEXT NOT NULL DEFAULT 'seed' (= 'seed' / 'sync' / 'manual')
--   - created_at / updated_at TEXT
--
-- index:
--   - vendor + family: 系統別 list 用 (= e.g. 「meta/llama 全部」)
--   - task: text-generation vs embedding 等の filter
--   - last_seen_at DESC: 新着順
--   - 部分 INDEX (is_deprecated = 0): active model のみの fast lookup
--
-- 適用方法 (= cwd: apps/worker、 d1_migrations state drift の trap 回避):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\054_ai_models_catalog.sql

CREATE TABLE IF NOT EXISTS ai_models_catalog (
  id                   TEXT PRIMARY KEY,
  model_id             TEXT NOT NULL UNIQUE,
  vendor               TEXT NOT NULL,
  family               TEXT NOT NULL,
  size_label           TEXT,
  task                 TEXT NOT NULL,
  capabilities         TEXT,
  context_window       INTEGER,
  description          TEXT,
  is_beta              INTEGER NOT NULL DEFAULT 0,
  is_deprecated        INTEGER NOT NULL DEFAULT 0,
  primary_candidate    INTEGER NOT NULL DEFAULT 0,
  fallback_candidate   INTEGER NOT NULL DEFAULT 0,
  first_seen_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  last_seen_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  last_synced_at       TEXT,
  raw_metadata         TEXT,
  source               TEXT NOT NULL DEFAULT 'seed',
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_ai_models_catalog_vendor_family
  ON ai_models_catalog(vendor, family);

CREATE INDEX IF NOT EXISTS idx_ai_models_catalog_task
  ON ai_models_catalog(task);

CREATE INDEX IF NOT EXISTS idx_ai_models_catalog_seen
  ON ai_models_catalog(last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_models_catalog_active
  ON ai_models_catalog(model_id)
  WHERE is_deprecated = 0;

CREATE INDEX IF NOT EXISTS idx_ai_models_catalog_primary
  ON ai_models_catalog(primary_candidate, last_seen_at DESC)
  WHERE primary_candidate = 1 AND is_deprecated = 0;

CREATE INDEX IF NOT EXISTS idx_ai_models_catalog_fallback
  ON ai_models_catalog(fallback_candidate, last_seen_at DESC)
  WHERE fallback_candidate = 1 AND is_deprecated = 0;

-- ============================================================
-- Seed: 現在 production 関連 + 主要 model
-- API token 設定前でも catalog 機能するように、 well-known model を pre-populate
-- sync 実行時に last_seen_at が更新され、 raw_metadata も埋まる
-- ============================================================

-- 現在 PRIMARY (= PR #69 から、 2026-05-26 切替)
INSERT OR IGNORE INTO ai_models_catalog (
  id, model_id, vendor, family, size_label, task, capabilities, context_window,
  description, is_beta, primary_candidate, fallback_candidate, source
) VALUES (
  'seed-llama-4-scout',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  'meta', 'llama', '17b-16e', 'text-generation',
  '["text","multilingual","function-calling"]',
  131072,
  'Llama 4 Scout — 17B Mixture-of-Experts (16 experts), multimodal capable, multilingual',
  1, 1, 0, 'seed'
);

-- 現在 FALLBACK (= PR #69 から)
INSERT OR IGNORE INTO ai_models_catalog (
  id, model_id, vendor, family, size_label, task, capabilities, context_window,
  description, is_beta, primary_candidate, fallback_candidate, source
) VALUES (
  'seed-gemma-4-26b',
  '@cf/google/gemma-4-26b-a4b-it',
  'google', 'gemma', '26b-a4b', 'text-generation',
  '["text","vision","multilingual"]',
  131072,
  'Gemma 4 26B (A4B variant) — vision capable, instruction tuned',
  1, 0, 1, 'seed'
);

-- 旧 PRIMARY (= 常時 fail で PR #69 で deprecate)
INSERT OR IGNORE INTO ai_models_catalog (
  id, model_id, vendor, family, size_label, task, capabilities, context_window,
  description, is_beta, is_deprecated, primary_candidate, fallback_candidate, source
) VALUES (
  'seed-qwen3-30b',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  'qwen', 'qwen', '30b-a3b', 'text-generation',
  '["text","multilingual"]',
  32768,
  'Qwen 3 30B A3B (FP8) — observed silent fallback failure in production 2026-04 to 2026-05',
  0, 1, 0, 0, 'seed'
);

-- 旧 FALLBACK (= まだ valid、 緊急 fallback 候補)
INSERT OR IGNORE INTO ai_models_catalog (
  id, model_id, vendor, family, size_label, task, capabilities, context_window,
  description, is_beta, primary_candidate, fallback_candidate, source
) VALUES (
  'seed-llama-3.3-70b',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'meta', 'llama', '70b', 'text-generation',
  '["text","multilingual","fast-inference"]',
  24000,
  'Llama 3.3 70B (FP8 fast) — large stable model, weak rule adherence vs newer models',
  0, 0, 1, 'seed'
);

-- 旧 PRIMARY 候補 (= 軽量、 compact fallback として残置)
INSERT OR IGNORE INTO ai_models_catalog (
  id, model_id, vendor, family, size_label, task, capabilities, context_window,
  description, is_beta, primary_candidate, fallback_candidate, source
) VALUES (
  'seed-llama-3-8b',
  '@cf/meta/llama-3-8b-instruct',
  'meta', 'llama', '8b', 'text-generation',
  '["text","multilingual"]',
  8000,
  'Llama 3 8B Instruct — small + cheap, baseline candidate for low-traffic deploys',
  0, 0, 1, 'seed'
);

-- 音声 (= 将来 Phase で voice message intake 用、 catalog に含めて可視化)
INSERT OR IGNORE INTO ai_models_catalog (
  id, model_id, vendor, family, task, capabilities,
  description, source
) VALUES (
  'seed-whisper',
  '@cf/openai/whisper',
  'openai', 'whisper', 'speech-to-text',
  '["audio","multilingual"]',
  'Whisper — speech-to-text (future: voice message intake)',
  'seed'
);

-- Embeddings (= 将来 RAG-lite 用)
INSERT OR IGNORE INTO ai_models_catalog (
  id, model_id, vendor, family, task, capabilities,
  description, source
) VALUES (
  'seed-bge-base-en',
  '@cf/baai/bge-base-en-v1.5',
  'baai', 'bge', 'embedding',
  '["embedding","english"]',
  'BGE base English — vector embeddings for retrieval (future RAG-lite)',
  'seed'
);
