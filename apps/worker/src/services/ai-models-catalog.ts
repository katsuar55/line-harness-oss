/**
 * AI Models Catalog Sync (= 自動 update 戦略 #1、 2026-05-26)
 *
 * 目的:
 *   Cloudflare Workers AI の利用可能 model 一覧を D1 に sync する daily cron。
 *   新 model 検出 + deprecated model 検出を Discord 通知。
 *
 * 設計方針:
 *   - **gating**: JST 04:00-04:04 window のみ trigger (= cleanup の 03:00 と分離)。
 *     `AI_MODELS_SYNC_FORCE='true'` で bypass。
 *   - **fail-safe**: API 失敗 / DB 失敗で例外を投げず、 cron 全体を止めない。
 *   - **graceful no-op**: `CLOUDFLARE_API_TOKEN` 未設定なら API call skip + heartbeat のみ。
 *     (= secret 設定前は seed catalog のみで運用可)
 *   - **silent fallback 教訓**: feedback_ai_model_silent_fallback.md より、 silent
 *     fail 検知を最重要視。 sync の成否は cron_run_logs + metrics で残す。
 *   - **stale grace period**: API response から消えた model も 7 日間は deprecated 化
 *     しない (= 一時的な API fail で誤 deprecate しないため)。
 *
 * 認証 (user 戻り後設定依頼):
 *   - `wrangler secret put CLOUDFLARE_API_TOKEN` (= Workers AI read 権限のみで可)
 *   - `wrangler secret put CLOUDFLARE_ACCOUNT_ID` (= 既存 wrangler.toml の account_id 同じ)
 *   未設定でも catalog SELECT 系 API + admin UI は動く (= seed 7 件で稼働)。
 */

import {
  upsertAiModel,
  getAiModelById,
  markStaleModelsAsDeprecated,
  insertCronRunLog,
} from '@line-crm/db';

// ============================================================
// 型
// ============================================================

export interface AiModelsSyncEnv {
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  DISCORD_WEBHOOK_URL?: string;
  ACCOUNT_NAME?: string;
  /** 'true' で JST 04:00 window gating bypass */
  AI_MODELS_SYNC_FORCE?: string;
}

export interface AiModelsSyncOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
  /** stale 判定の grace period 日数 (default 7 日) */
  staleGraceDays?: number;
}

export interface AiModelsSyncResult {
  triggered: boolean;
  skippedReason?: 'window' | 'token-missing' | 'account-missing';
  fetched: number;
  inserted: number;
  updated: number;
  newlyDeprecated: number;
  errors: number;
  newModelIds: string[];
  deprecatedModelIds: string[];
}

interface CloudflareApiResponse {
  result?: CloudflareModelResult[];
  success?: boolean;
  errors?: unknown[];
  messages?: unknown[];
}

interface CloudflareModelResult {
  id?: string;
  name?: string;
  description?: string;
  task?: { id?: string; name?: string };
  tags?: string[];
  properties?: Array<{ property_id?: string; value?: string | number }>;
  created_at?: string;
  modified_at?: string;
}

// ============================================================
// 定数
// ============================================================

export const AI_MODELS_SYNC_JOB_NAME = 'ai-models-catalog-sync';
const TRIGGER_HOUR = 4;
const TRIGGER_MINUTE_FROM = 0;
const TRIGGER_MINUTE_TO_EXCLUSIVE = 5;
const DEFAULT_STALE_GRACE_DAYS = 7;
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_DISCORD_LIST_ITEMS = 15;

// ============================================================
// gating
// ============================================================

export function isSyncWindow(now: Date): boolean {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return (
    jst.getUTCHours() === TRIGGER_HOUR &&
    jst.getUTCMinutes() >= TRIGGER_MINUTE_FROM &&
    jst.getUTCMinutes() < TRIGGER_MINUTE_TO_EXCLUSIVE
  );
}

// ============================================================
// model_id parse
// ============================================================

/**
 * Cloudflare Workers AI の model id (= '@cf/{vendor}/{rest}') を分解。
 *
 * 例:
 *  - '@cf/meta/llama-4-scout-17b-16e-instruct' → meta/llama, size_label='4-scout-17b-16e-instruct'
 *  - '@cf/openai/whisper' → openai/whisper, size_label=null
 *  - '@cf/baai/bge-base-en-v1.5' → baai/bge, size_label='base-en-v1.5'
 *
 * family 推測:
 *  - 'llama-*' → llama
 *  - 'gemma-*' → gemma
 *  - 'qwen*' → qwen (prefix)
 *  - 'bge-*' → bge
 *  - それ以外 → 最初の '-' 前の token
 */
export interface ParsedModelId {
  vendor: string;
  family: string;
  sizeLabel: string | null;
}

export function parseModelId(modelId: string): ParsedModelId {
  // strip '@cf/' prefix if present
  const stripped = modelId.startsWith('@cf/') ? modelId.slice(4) : modelId;
  const parts = stripped.split('/');
  const vendor = parts[0] ?? 'unknown';
  const rest = parts.slice(1).join('/') || 'unknown';

  // family detection: split on '-', special-case known families
  const tokens = rest.split('-');
  const first = tokens[0] ?? rest;
  let family = first;
  // qwen, qwen2, qwen3 等の数字 suffix は family にまとめる
  const qwenMatch = first.match(/^(qwen)(\d*)$/i);
  if (qwenMatch) {
    family = 'qwen';
  }
  const sizeLabel = tokens.length > 1 ? tokens.slice(1).join('-') : null;

  return { vendor, family, sizeLabel };
}

// ============================================================
// Cloudflare API fetch
// ============================================================

interface FetchOptions {
  accountId: string;
  apiToken: string;
  fetchImpl: typeof fetch;
}

async function fetchCloudflareModels(opts: FetchOptions): Promise<CloudflareModelResult[]> {
  const url = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(opts.accountId)}/ai/models/search?per_page=200`;
  // ⚠️ `opts.fetchImpl(...)` と property 経由で呼ぶと `this = opts` になり、
  // Workers の global fetch (this=globalThis 必須) で Illegal invocation になる。
  // 必ず local const に取り出してから呼ぶ (this=undefined = global が許容する形)。
  const { fetchImpl } = opts;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${opts.apiToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Cloudflare API returned ${response.status}`);
  }

  const data = (await response.json()) as CloudflareApiResponse;
  if (!data.success) {
    throw new Error('Cloudflare API success=false');
  }
  return Array.isArray(data.result) ? data.result : [];
}

// ============================================================
// 主処理
// ============================================================

export async function syncAiModelsCatalog(
  env: AiModelsSyncEnv,
  options: AiModelsSyncOptions = {},
): Promise<AiModelsSyncResult> {
  const now = options.now ?? new Date();
  // default は必ず bind する (CLAUDE.md「Workers コーディングルール」)。
  // この値は下流で object property に載る (FetchOptions.fetchImpl) ため、
  // unbound のままだと呼出時に this が奪われる。
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const staleGraceDays = options.staleGraceDays ?? DEFAULT_STALE_GRACE_DAYS;
  const force = env.AI_MODELS_SYNC_FORCE === 'true';

  const baseResult: AiModelsSyncResult = {
    triggered: false,
    fetched: 0,
    inserted: 0,
    updated: 0,
    newlyDeprecated: 0,
    errors: 0,
    newModelIds: [],
    deprecatedModelIds: [],
  };

  if (!force && !isSyncWindow(now)) {
    return { ...baseResult, skippedReason: 'window' };
  }

  // secret 未設定なら graceful skip (= seed のみで catalog 機能継続)
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    await recordCronRun(env.DB, 'skipped', {
      reason: 'CLOUDFLARE_ACCOUNT_ID missing',
    });
    return { ...baseResult, triggered: true, skippedReason: 'account-missing' };
  }
  if (!env.CLOUDFLARE_API_TOKEN) {
    await recordCronRun(env.DB, 'skipped', {
      reason: 'CLOUDFLARE_API_TOKEN missing',
    });
    return { ...baseResult, triggered: true, skippedReason: 'token-missing' };
  }

  let models: CloudflareModelResult[];
  try {
    models = await fetchCloudflareModels({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      fetchImpl,
    });
  } catch (err) {
    console.error(
      '[ai-models-catalog-sync] Cloudflare API fetch failed',
      err instanceof Error ? err.message : 'unknown',
    );
    await recordCronRun(env.DB, 'error', undefined, errorMessage(err));
    return { ...baseResult, triggered: true, errors: 1 };
  }

  const newModelIds: string[] = [];
  let inserted = 0;
  let updated = 0;
  let errors = 0;

  for (const model of models) {
    if (!model.name) continue;
    const modelId = model.name;
    const parsed = parseModelId(modelId);
    const task = model.task?.name?.toLowerCase().replace(/\s+/g, '-') ?? 'unknown';
    const tags = Array.isArray(model.tags) ? model.tags : [];
    const isBeta = tags.some((t) => t.toLowerCase().includes('beta'));
    const capabilities = extractCapabilities(tags, task);
    const contextWindow = extractContextWindow(model.properties);

    try {
      const existing = await getAiModelById(env.DB, modelId);
      const result = await upsertAiModel(env.DB, {
        modelId,
        vendor: parsed.vendor,
        family: parsed.family,
        sizeLabel: parsed.sizeLabel,
        task,
        capabilities,
        contextWindow,
        description: model.description ?? null,
        isBeta,
        rawMetadata: model as unknown as object,
        source: 'sync',
      });
      if (result.inserted) {
        inserted += 1;
        if (!existing) {
          newModelIds.push(modelId);
        }
      } else {
        updated += 1;
      }
    } catch (err) {
      errors += 1;
      console.error(
        '[ai-models-catalog-sync] upsert failed for',
        modelId,
        err instanceof Error ? err.message : 'unknown',
      );
    }
  }

  // stale 判定 (= API response から消えた sync model を grace period 経過後 deprecate)
  const staleThresholdMs = now.getTime() - staleGraceDays * 24 * 3600 * 1000;
  const staleThresholdIso = new Date(staleThresholdMs).toISOString();

  let deprecatedModelIds: string[] = [];
  let newlyDeprecated = 0;
  try {
    const staleResult = await markStaleModelsAsDeprecated(env.DB, staleThresholdIso);
    deprecatedModelIds = staleResult.modelIds;
    newlyDeprecated = staleResult.deprecatedCount;
  } catch (err) {
    errors += 1;
    console.error(
      '[ai-models-catalog-sync] markStaleModelsAsDeprecated failed',
      err instanceof Error ? err.message : 'unknown',
    );
  }

  // Discord 通知 (= 新着 or deprecated があれば)
  if ((newModelIds.length > 0 || deprecatedModelIds.length > 0) && env.DISCORD_WEBHOOK_URL) {
    try {
      await sendDiscordNotification(
        env.DISCORD_WEBHOOK_URL,
        env.ACCOUNT_NAME ?? 'naturism',
        newModelIds,
        deprecatedModelIds,
        fetchImpl,
      );
    } catch (err) {
      console.error(
        '[ai-models-catalog-sync] Discord notification failed',
        err instanceof Error ? err.message : 'unknown',
      );
    }
  }

  const status = errors === 0 ? 'success' : 'partial';
  await recordCronRun(env.DB, status, {
    fetched: models.length,
    inserted,
    updated,
    newlyDeprecated,
    errors,
  });

  return {
    triggered: true,
    fetched: models.length,
    inserted,
    updated,
    newlyDeprecated,
    errors,
    newModelIds,
    deprecatedModelIds,
  };
}

// ============================================================
// helpers
// ============================================================

function extractCapabilities(tags: string[], task: string): string[] {
  const caps = new Set<string>();
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (lower === 'beta') continue;
    if (lower.includes('vision') || lower.includes('image')) caps.add('vision');
    if (lower.includes('function')) caps.add('function-calling');
    if (lower.includes('multilingual') || lower.includes('multi-lingual')) {
      caps.add('multilingual');
    }
    if (lower.includes('lora')) caps.add('lora');
  }
  // task 名は exact match 寄りで判定 (= 'speech-to-text' を 'text' substring match で
  // text 追加する trap を避ける)
  if (task === 'text-generation' || task === 'text-classification') caps.add('text');
  if (task === 'embedding' || task === 'sentence-similarity') caps.add('embedding');
  if (task === 'speech-to-text' || task === 'automatic-speech-recognition') caps.add('audio');
  if (task === 'translation') caps.add('translation');
  if (task === 'text-to-image' || task === 'image-generation') caps.add('image-generation');
  if (task === 'image-classification' || task === 'image-to-text') caps.add('vision');
  if (task === 'text-to-speech') caps.add('audio');
  return Array.from(caps).sort();
}

function extractContextWindow(
  properties: CloudflareModelResult['properties'],
): number | null {
  if (!Array.isArray(properties)) return null;
  for (const prop of properties) {
    if (prop.property_id === 'context_window' && prop.value !== undefined) {
      const num = typeof prop.value === 'number' ? prop.value : parseInt(String(prop.value), 10);
      return Number.isFinite(num) ? num : null;
    }
  }
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

async function recordCronRun(
  db: D1Database,
  status: 'success' | 'partial' | 'error' | 'skipped',
  metrics?: object,
  errorSummary?: string,
): Promise<void> {
  try {
    await insertCronRunLog(db, {
      jobName: AI_MODELS_SYNC_JOB_NAME,
      status,
      metrics,
      errorSummary,
    });
  } catch (err) {
    console.error(
      '[ai-models-catalog-sync] cron_run_logs insert failed',
      err instanceof Error ? err.message : 'unknown',
    );
  }
}

async function sendDiscordNotification(
  webhookUrl: string,
  account: string,
  newModelIds: string[],
  deprecatedModelIds: string[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const parts: string[] = [];

  if (newModelIds.length > 0) {
    parts.push(`:sparkles: **New Cloudflare AI model(s) detected** \`${account}\``);
    const list = newModelIds.slice(0, MAX_DISCORD_LIST_ITEMS).map((id) => `- \`${id}\``);
    parts.push(...list);
    if (newModelIds.length > MAX_DISCORD_LIST_ITEMS) {
      parts.push(`...and ${newModelIds.length - MAX_DISCORD_LIST_ITEMS} more`);
    }
  }

  if (deprecatedModelIds.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push(`:warning: **AI model(s) marked deprecated** \`${account}\``);
    parts.push('Models missing from latest sync for >7 days (grace period elapsed):');
    const list = deprecatedModelIds
      .slice(0, MAX_DISCORD_LIST_ITEMS)
      .map((id) => `- \`${id}\``);
    parts.push(...list);
    if (deprecatedModelIds.length > MAX_DISCORD_LIST_ITEMS) {
      parts.push(`...and ${deprecatedModelIds.length - MAX_DISCORD_LIST_ITEMS} more`);
    }
  }

  const content = parts.join('\n');
  await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: truncate(content, 1900) }),
  });
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ============================================================
// テスト用エクスポート
// ============================================================

export const __test__ = {
  isSyncWindow,
  parseModelId,
  extractCapabilities,
  extractContextWindow,
  TRIGGER_HOUR,
  DEFAULT_STALE_GRACE_DAYS,
};
