import { jstNow } from './utils.js';

// ---------- Types ----------

export type AbTestMessageType = 'text' | 'image' | 'flex';
export type AbTestTargetType = 'all' | 'tag';
export type AbTestStatus = 'draft' | 'scheduled' | 'sending' | 'test_sent' | 'winner_sent';

export interface AbTest {
  id: string;
  title: string;
  variant_a_message_type: AbTestMessageType;
  variant_a_message_content: string;
  variant_a_alt_text: string | null;
  variant_b_message_type: AbTestMessageType;
  variant_b_message_content: string;
  variant_b_alt_text: string | null;
  target_type: AbTestTargetType;
  target_tag_id: string | null;
  split_ratio: number;
  status: AbTestStatus;
  scheduled_at: string | null;
  sent_at: string | null;
  variant_a_total: number;
  variant_a_success: number;
  variant_b_total: number;
  variant_b_success: number;
  winner: 'A' | 'B' | null;
  winner_total: number;
  winner_success: number;
  variant_a_tracked_link_ids: string | null;
  variant_b_tracked_link_ids: string | null;
  line_account_id: string | null;
  created_at: string;
}

export interface CreateAbTestInput {
  title: string;
  variantA: {
    messageType: AbTestMessageType;
    messageContent: string;
    altText?: string | null;
  };
  variantB: {
    messageType: AbTestMessageType;
    messageContent: string;
    altText?: string | null;
  };
  targetType: AbTestTargetType;
  targetTagId?: string | null;
  splitRatio?: number;
  scheduledAt?: string | null;
  lineAccountId?: string | null;
}

export type UpdateAbTestInput = Partial<
  Pick<
    AbTest,
    | 'title'
    | 'variant_a_message_type'
    | 'variant_a_message_content'
    | 'variant_a_alt_text'
    | 'variant_b_message_type'
    | 'variant_b_message_content'
    | 'variant_b_alt_text'
    | 'target_type'
    | 'target_tag_id'
    | 'split_ratio'
    | 'status'
    | 'scheduled_at'
  >
>;

export interface AbTestStatusCounts {
  variantATotal?: number;
  variantASuccess?: number;
  variantBTotal?: number;
  variantBSuccess?: number;
  winnerTotal?: number;
  winnerSuccess?: number;
}

// ---------- CRUD ----------

export async function getAbTests(db: D1Database): Promise<AbTest[]> {
  const result = await db
    .prepare('SELECT * FROM ab_tests ORDER BY created_at DESC')
    .all<AbTest>();
  return result.results;
}

export async function getAbTestById(
  db: D1Database,
  id: string,
): Promise<AbTest | null> {
  return db
    .prepare('SELECT * FROM ab_tests WHERE id = ?')
    .bind(id)
    .first<AbTest>();
}

export async function createAbTest(
  db: D1Database,
  input: CreateAbTestInput,
): Promise<AbTest> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const initialStatus: AbTestStatus = input.scheduledAt ? 'scheduled' : 'draft';

  await db
    .prepare(
      `INSERT INTO ab_tests
         (id, title,
          variant_a_message_type, variant_a_message_content, variant_a_alt_text,
          variant_b_message_type, variant_b_message_content, variant_b_alt_text,
          target_type, target_tag_id, split_ratio, status, scheduled_at,
          line_account_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.title,
      input.variantA.messageType,
      input.variantA.messageContent,
      input.variantA.altText ?? null,
      input.variantB.messageType,
      input.variantB.messageContent,
      input.variantB.altText ?? null,
      input.targetType,
      input.targetTagId ?? null,
      input.splitRatio ?? 50,
      initialStatus,
      input.scheduledAt ?? null,
      input.lineAccountId ?? null,
      now,
    )
    .run();

  return (await getAbTestById(db, id))!;
}

export async function updateAbTest(
  db: D1Database,
  id: string,
  updates: UpdateAbTestInput,
): Promise<AbTest | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  const mapping: Array<[keyof UpdateAbTestInput, string]> = [
    ['title', 'title'],
    ['variant_a_message_type', 'variant_a_message_type'],
    ['variant_a_message_content', 'variant_a_message_content'],
    ['variant_a_alt_text', 'variant_a_alt_text'],
    ['variant_b_message_type', 'variant_b_message_type'],
    ['variant_b_message_content', 'variant_b_message_content'],
    ['variant_b_alt_text', 'variant_b_alt_text'],
    ['target_type', 'target_type'],
    ['target_tag_id', 'target_tag_id'],
    ['split_ratio', 'split_ratio'],
    ['status', 'status'],
    ['scheduled_at', 'scheduled_at'],
  ];

  for (const [key, col] of mapping) {
    if (updates[key] !== undefined) {
      fields.push(`${col} = ?`);
      values.push(updates[key]);
    }
  }

  if (fields.length > 0) {
    values.push(id);
    await db
      .prepare(`UPDATE ab_tests SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  return getAbTestById(db, id);
}

export async function deleteAbTest(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM ab_tests WHERE id = ?').bind(id).run();
}

export async function updateAbTestStatus(
  db: D1Database,
  id: string,
  status: AbTestStatus,
  counts?: AbTestStatusCounts,
): Promise<void> {
  const fields: string[] = ['status = ?'];
  const values: unknown[] = [status];

  if (status === 'test_sent' || status === 'winner_sent') {
    fields.push('sent_at = ?');
    values.push(jstNow());
  }
  if (counts?.variantATotal !== undefined) {
    fields.push('variant_a_total = ?');
    values.push(counts.variantATotal);
  }
  if (counts?.variantASuccess !== undefined) {
    fields.push('variant_a_success = ?');
    values.push(counts.variantASuccess);
  }
  if (counts?.variantBTotal !== undefined) {
    fields.push('variant_b_total = ?');
    values.push(counts.variantBTotal);
  }
  if (counts?.variantBSuccess !== undefined) {
    fields.push('variant_b_success = ?');
    values.push(counts.variantBSuccess);
  }
  if (counts?.winnerTotal !== undefined) {
    fields.push('winner_total = ?');
    values.push(counts.winnerTotal);
  }
  if (counts?.winnerSuccess !== undefined) {
    fields.push('winner_success = ?');
    values.push(counts.winnerSuccess);
  }

  values.push(id);
  await db
    .prepare(`UPDATE ab_tests SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function updateAbTestWinner(
  db: D1Database,
  id: string,
  winner: 'A' | 'B',
): Promise<void> {
  await db
    .prepare('UPDATE ab_tests SET winner = ? WHERE id = ?')
    .bind(winner, id)
    .run();
}

export async function updateAbTestTrackedLinks(
  db: D1Database,
  id: string,
  variant: 'A' | 'B',
  trackedLinkIds: string[],
): Promise<void> {
  const col = variant === 'A' ? 'variant_a_tracked_link_ids' : 'variant_b_tracked_link_ids';
  await db
    .prepare(`UPDATE ab_tests SET ${col} = ? WHERE id = ?`)
    .bind(JSON.stringify(trackedLinkIds), id)
    .run();
}

// ---------- Assignments ----------

export async function createAbTestAssignment(
  db: D1Database,
  abTestId: string,
  friendId: string,
  variant: 'A' | 'B',
): Promise<void> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      'INSERT INTO ab_test_assignments (id, ab_test_id, friend_id, variant, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(id, abTestId, friendId, variant, now)
    .run();
}

export async function batchCreateAbTestAssignments(
  db: D1Database,
  assignments: Array<{ abTestId: string; friendId: string; variant: 'A' | 'B' }>,
): Promise<void> {
  if (assignments.length === 0) return;

  const now = jstNow();
  const stmts = assignments.map((a) =>
    db
      .prepare(
        'INSERT INTO ab_test_assignments (id, ab_test_id, friend_id, variant, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(crypto.randomUUID(), a.abTestId, a.friendId, a.variant, now),
  );

  // D1 batch supports up to 100 statements; chunk if needed
  const BATCH_SIZE = 100;
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await db.batch(stmts.slice(i, i + BATCH_SIZE));
  }
}

export async function getAssignedFriendIds(
  db: D1Database,
  abTestId: string,
): Promise<Set<string>> {
  const result = await db
    .prepare('SELECT friend_id FROM ab_test_assignments WHERE ab_test_id = ?')
    .bind(abTestId)
    .all<{ friend_id: string }>();
  return new Set(result.results.map((r) => r.friend_id));
}

export interface AbTestAssignment {
  id: string;
  ab_test_id: string;
  friend_id: string;
  variant: 'A' | 'B';
  created_at: string;
}

export async function getAbTestAssignments(
  db: D1Database,
  abTestId: string,
): Promise<AbTestAssignment[]> {
  const result = await db
    .prepare('SELECT * FROM ab_test_assignments WHERE ab_test_id = ? ORDER BY created_at')
    .bind(abTestId)
    .all<AbTestAssignment>();
  return result.results;
}
