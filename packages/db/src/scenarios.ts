import { jstNow } from './utils.js';
export type ScenarioTriggerType = 'friend_add' | 'tag_added' | 'manual';
export type MessageType = 'text' | 'image' | 'flex';
export type FriendScenarioStatus = 'active' | 'paused' | 'completed';
/** Round 4 PR-6.2: dispatcher 経由の channel 区別 (migration 043) */
export type ScenarioStepChannel = 'line' | 'email' | 'both';

export interface Scenario {
  id: string;
  name: string;
  description: string | null;
  trigger_type: ScenarioTriggerType;
  trigger_tag_id: string | null;
  line_account_id: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface ScenarioStep {
  id: string;
  scenario_id: string;
  step_order: number;
  delay_minutes: number;
  message_type: MessageType;
  message_content: string;
  condition_type: string | null;
  condition_value: string | null;
  next_step_on_false: number | null;
  /** migration 043 で追加。default 'line'。 */
  channel?: ScenarioStepChannel;
  /** migration 043 で追加。channel が 'email' | 'both' のときに email_templates(id) を指す */
  email_template_id?: string | null;
  created_at: string;
}

export interface ScenarioWithSteps extends Scenario {
  steps: ScenarioStep[];
}

export interface FriendScenario {
  id: string;
  friend_id: string;
  scenario_id: string;
  current_step_order: number;
  status: FriendScenarioStatus;
  started_at: string;
  next_delivery_at: string | null;
  updated_at: string;
}

// ============================================================
// Scenario CRUD
// ============================================================

export type ScenarioWithStepCount = Scenario & { step_count: number };

export async function getScenarios(db: D1Database): Promise<ScenarioWithStepCount[]> {
  const result = await db
    .prepare(
      `SELECT s.*, COUNT(ss.id) as step_count
       FROM scenarios s
       LEFT JOIN scenario_steps ss ON s.id = ss.scenario_id
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
    )
    .all<ScenarioWithStepCount>();
  return result.results;
}

export async function getScenarioById(
  db: D1Database,
  id: string,
): Promise<ScenarioWithSteps | null> {
  const scenario = await db
    .prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(id)
    .first<Scenario>();

  if (!scenario) return null;

  const stepsResult = await db
    .prepare(
      `SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`,
    )
    .bind(id)
    .all<ScenarioStep>();

  return { ...scenario, steps: stepsResult.results };
}

export interface CreateScenarioInput {
  name: string;
  description?: string | null;
  triggerType: ScenarioTriggerType;
  triggerTagId?: string | null;
}

export async function createScenario(
  db: D1Database,
  input: CreateScenarioInput,
): Promise<Scenario> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO scenarios (id, name, description, trigger_type, trigger_tag_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      id,
      input.name,
      input.description ?? null,
      input.triggerType,
      input.triggerTagId ?? null,
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(id)
    .first<Scenario>())!;
}

export type UpdateScenarioInput = Partial<
  Pick<Scenario, 'name' | 'description' | 'trigger_type' | 'trigger_tag_id' | 'is_active'>
>;

export async function updateScenario(
  db: D1Database,
  id: string,
  updates: UpdateScenarioInput,
): Promise<Scenario | null> {
  const now = jstNow();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.trigger_type !== undefined) {
    fields.push('trigger_type = ?');
    values.push(updates.trigger_type);
  }
  if (updates.trigger_tag_id !== undefined) {
    fields.push('trigger_tag_id = ?');
    values.push(updates.trigger_tag_id);
  }
  if (updates.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.is_active);
  }

  if (fields.length === 0) {
    return db
      .prepare(`SELECT * FROM scenarios WHERE id = ?`)
      .bind(id)
      .first<Scenario>();
  }

  fields.push('updated_at = ?');
  values.push(now);
  values.push(id);

  await db
    .prepare(`UPDATE scenarios SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return db
    .prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(id)
    .first<Scenario>();
}

export async function deleteScenario(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM scenarios WHERE id = ?`).bind(id).run();
}

// ============================================================
// Scenario Steps
// ============================================================

export interface CreateScenarioStepInput {
  scenarioId: string;
  stepOrder: number;
  delayMinutes?: number;
  messageType: MessageType;
  messageContent: string;
  conditionType?: string | null;
  conditionValue?: string | null;
  nextStepOnFalse?: number | null;
  /** migration 043 で追加。省略時は 'line' (default) */
  channel?: ScenarioStepChannel;
  /** migration 043 で追加。channel が 'email' | 'both' のときに使う */
  emailTemplateId?: string | null;
}

export async function createScenarioStep(
  db: D1Database,
  input: CreateScenarioStepInput,
): Promise<ScenarioStep> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, condition_type, condition_value, next_step_on_false, channel, email_template_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.scenarioId,
      input.stepOrder,
      input.delayMinutes ?? 0,
      input.messageType,
      input.messageContent,
      input.conditionType ?? null,
      input.conditionValue ?? null,
      input.nextStepOnFalse ?? null,
      input.channel ?? 'line',
      input.emailTemplateId ?? null,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM scenario_steps WHERE id = ?`)
    .bind(id)
    .first<ScenarioStep>())!;
}

export type UpdateScenarioStepInput = Partial<
  Pick<ScenarioStep, 'step_order' | 'delay_minutes' | 'message_type' | 'message_content' | 'condition_type' | 'condition_value' | 'next_step_on_false' | 'channel' | 'email_template_id'>
>;

export async function updateScenarioStep(
  db: D1Database,
  id: string,
  updates: UpdateScenarioStepInput,
): Promise<ScenarioStep | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.step_order !== undefined) {
    fields.push('step_order = ?');
    values.push(updates.step_order);
  }
  if (updates.delay_minutes !== undefined) {
    fields.push('delay_minutes = ?');
    values.push(updates.delay_minutes);
  }
  if (updates.message_type !== undefined) {
    fields.push('message_type = ?');
    values.push(updates.message_type);
  }
  if (updates.message_content !== undefined) {
    fields.push('message_content = ?');
    values.push(updates.message_content);
  }
  if (updates.condition_type !== undefined) {
    fields.push('condition_type = ?');
    values.push(updates.condition_type);
  }
  if (updates.condition_value !== undefined) {
    fields.push('condition_value = ?');
    values.push(updates.condition_value);
  }
  if (updates.next_step_on_false !== undefined) {
    fields.push('next_step_on_false = ?');
    values.push(updates.next_step_on_false);
  }
  if (updates.channel !== undefined) {
    fields.push('channel = ?');
    values.push(updates.channel);
  }
  if (updates.email_template_id !== undefined) {
    fields.push('email_template_id = ?');
    values.push(updates.email_template_id);
  }

  if (fields.length > 0) {
    values.push(id);
    await db
      .prepare(`UPDATE scenario_steps SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  return db
    .prepare(`SELECT * FROM scenario_steps WHERE id = ?`)
    .bind(id)
    .first<ScenarioStep>();
}

export async function deleteScenarioStep(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM scenario_steps WHERE id = ?`).bind(id).run();
}

export async function getScenarioSteps(
  db: D1Database,
  scenarioId: string,
): Promise<ScenarioStep[]> {
  const result = await db
    .prepare(
      `SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`,
    )
    .bind(scenarioId)
    .all<ScenarioStep>();
  return result.results;
}

// ============================================================
// Friend Scenario Enrollments
// ============================================================

export async function enrollFriendInScenario(
  db: D1Database,
  friendId: string,
  scenarioId: string,
): Promise<FriendScenario> {
  const id = crypto.randomUUID();
  const now = jstNow();

  // Get the first step to calculate next_delivery_at
  const firstStep = await db
    .prepare(
      `SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC LIMIT 1`,
    )
    .bind(scenarioId)
    .first<{ step_order: number; delay_minutes: number }>();

  // A scenario with no steps is immediately completed — no stuck active enrollment.
  if (!firstStep) {
    await db
      .prepare(
        `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
         VALUES (?, ?, ?, 0, 'completed', ?, NULL, ?)`,
      )
      .bind(id, friendId, scenarioId, now, now)
      .run();

    return (await db
      .prepare(`SELECT * FROM friend_scenarios WHERE id = ?`)
      .bind(id)
      .first<FriendScenario>())!;
  }

  const rawDate = new Date(Date.now() + 9 * 60 * 60_000 + firstStep.delay_minutes * 60_000);
  // Enforce 9:00-21:00 JST delivery window
  const hours = rawDate.getUTCHours();
  if (hours < 9 || hours >= 21) {
    if (hours >= 21) rawDate.setUTCDate(rawDate.getUTCDate() + 1);
    rawDate.setUTCHours(9, 0, 0, 0);
  }
  const nextDeliveryAt = rawDate.toISOString().slice(0, -1) + '+09:00';

  await db
    .prepare(
      `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
       VALUES (?, ?, ?, 0, 'active', ?, ?, ?)`,
    )
    .bind(id, friendId, scenarioId, now, nextDeliveryAt, now)
    .run();

  return (await db
    .prepare(`SELECT * FROM friend_scenarios WHERE id = ?`)
    .bind(id)
    .first<FriendScenario>())!;
}

/**
 * 1 tick あたりに処理する due scenario の上限 (launch-scale hardening, 2026-06-15)。
 * 数千友だち規模で `.all()` の 10,000 行上限による silent truncation (= 配信欠落) と、
 * cron の CPU/subrequest 枯渇を防ぐ。 超過分は次 tick で drain される (各行は claim→
 * advance/complete で due 集合から外れ、 ORDER BY ... ASC で最古 due から処理される)。
 */
export const DUE_SCENARIO_BATCH_LIMIT = 200;

export async function getFriendScenariosDueForDelivery(
  db: D1Database,
  now: string,
  limit: number = DUE_SCENARIO_BATCH_LIMIT,
): Promise<FriendScenario[]> {
  // due 判定・並べ替え・件数上限をすべて SQL 側で行う (= JS 全件 fetch を廃止)。
  // unixepoch() は next_delivery_at / now の TZ offset (Z と +09:00 の混在) を UTC epoch に
  // 正規化するため、 形式が混在しても従来の JS epoch 比較と (秒精度で) 一致する
  // (D1 実機検証: unixepoch('…+09:00') == unixepoch('…Z') == unixepoch('….000+09:00'))。
  // 秒精度のため境界では旧 JS(ms) より最大 1 秒早く due になり得るが、 SQL が due と返す行は
  // 旧 JS でも必ず due (= 取りこぼしゼロ。 floor 単調性: 秒が後なら ms も後)、 かつ 5 分 cron では
  // 秒未満差は無意味なので実質同一。 不正な timestamp は unixepoch()=NULL で除外される
  // (= 旧 JS の `NaN <= nowMs === false` と同挙動)。
  // 注: unixepoch(列) は関数包みのため idx_friend_scenarios_next_delivery_at を range scan に
  // 使えず full scan + temp sort になるが、 active scenario は少数 + ≤5,000 友だち上限 (本番実測
  // sub-ms) で許容。 大規模化時は epoch 式 index を別 migration で検討。
  const result = await db
    .prepare(
      `SELECT * FROM friend_scenarios
       WHERE status = 'active'
         AND next_delivery_at IS NOT NULL
         AND unixepoch(next_delivery_at) <= unixepoch(?)
       ORDER BY unixepoch(next_delivery_at) ASC
       LIMIT ?`,
    )
    .bind(now, limit)
    .all<FriendScenario>();
  return result.results;
}

export async function advanceFriendScenario(
  db: D1Database,
  id: string,
  nextStepOrder: number,
  nextDeliveryAt?: string | null,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE friend_scenarios
       SET current_step_order = ?,
           next_delivery_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(nextStepOrder, nextDeliveryAt ?? null, now, id)
    .run();
}

/**
 * 配信前の atomic claim (= 重複 cron 実行による二重配信を防ぐ、 2026-06-05)。
 *
 * 観測した `expectedNextDeliveryAt` で CAS UPDATE し、 changes===1 (= 自分が掴んだ) のときだけ true。
 * next_delivery_at を `leaseUntil` (将来) にずらすので処理中は再選択されず、 送信完了後に
 * advanceFriendScenario / completeFriendScenario が最終値で上書きする。 worker が claim 後に
 * crash しても lease 失効後 (= leaseUntil 到来後) に再 due となり retry される (= 二重配信より安全)。
 *
 * status='active' も条件に含め、 既に completed/paused の scenario を掴まない。
 * migration 不要 (既存 next_delivery_at 列の CAS のみ)。
 */
export async function claimFriendScenarioForDelivery(
  db: D1Database,
  id: string,
  expectedNextDeliveryAt: string,
  leaseUntil: string,
): Promise<boolean> {
  const now = jstNow();
  const res = await db
    .prepare(
      `UPDATE friend_scenarios
         SET next_delivery_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active' AND next_delivery_at = ?`,
    )
    .bind(leaseUntil, now, id, expectedNextDeliveryAt)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

export async function completeFriendScenario(
  db: D1Database,
  id: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE friend_scenarios
       SET status = 'completed',
           next_delivery_at = NULL,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, id)
    .run();
}
