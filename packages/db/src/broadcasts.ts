import { jstNow } from './utils.js';
export type BroadcastTargetType = 'all' | 'tag';
export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'sent';
export type BroadcastMessageType = 'text' | 'image' | 'flex';
/** Round 4 PR-6.2: dispatcher 経由の channel 区別 (migration 043) */
export type BroadcastChannel = 'line' | 'email' | 'both';

export interface Broadcast {
  id: string;
  title: string;
  message_type: BroadcastMessageType;
  message_content: string;
  target_type: BroadcastTargetType;
  target_tag_id: string | null;
  status: BroadcastStatus;
  scheduled_at: string | null;
  sent_at: string | null;
  total_count: number;
  success_count: number;
  line_request_id?: string | null;
  insights_json?: string | null;
  insights_fetched_at?: string | null;
  /** migration 043 で追加。default 'line'。 */
  channel?: BroadcastChannel;
  /** migration 043 で追加。channel が 'email' | 'both' のときに email_templates(id) を指す */
  email_template_id?: string | null;
  /** migration 008 で追加。 multi-tenant 用 (NULL = legacy / system-wide) */
  line_account_id?: string | null;
  /** migration 067 で追加。 claim('sending' 遷移) 時刻 (JST)。 stuck 検知/安全自動復旧用 */
  sending_started_at?: string | null;
  created_at: string;
}

// 採点 Round1 D5: unbounded SELECT * は D1 の 10,000 行返却上限で silent truncation の
// リスクがあり、 admin list scan も O(n)。 default LIMIT で bound + offset pagination 対応。
export async function getBroadcasts(
  db: D1Database,
  opts: { limit?: number; offset?: number } = {},
): Promise<Broadcast[]> {
  const limit = opts.limit ?? 1000;
  const offset = opts.offset ?? 0;
  const result = await db
    .prepare(`SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(limit, offset)
    .all<Broadcast>();
  return result.results;
}

export async function getBroadcastById(
  db: D1Database,
  id: string,
): Promise<Broadcast | null> {
  return db
    .prepare(`SELECT * FROM broadcasts WHERE id = ?`)
    .bind(id)
    .first<Broadcast>();
}

export interface CreateBroadcastInput {
  title: string;
  messageType: BroadcastMessageType;
  messageContent: string;
  targetType: BroadcastTargetType;
  targetTagId?: string | null;
  scheduledAt?: string | null;
  /** migration 043 で追加。省略時は 'line' (default) */
  channel?: BroadcastChannel;
  /** migration 043 で追加。channel が 'email' | 'both' のときに使う */
  emailTemplateId?: string | null;
}

export async function createBroadcast(
  db: D1Database,
  input: CreateBroadcastInput,
): Promise<Broadcast> {
  const id = crypto.randomUUID();
  const now = jstNow();

  const initialStatus: BroadcastStatus = input.scheduledAt ? 'scheduled' : 'draft';

  await db
    .prepare(
      `INSERT INTO broadcasts
         (id, title, message_type, message_content, target_type, target_tag_id, status, scheduled_at, sent_at, total_count, success_count, channel, email_template_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, ?, ?, ?)`,
    )
    .bind(
      id,
      input.title,
      input.messageType,
      input.messageContent,
      input.targetType,
      input.targetTagId ?? null,
      initialStatus,
      input.scheduledAt ?? null,
      input.channel ?? 'line',
      input.emailTemplateId ?? null,
      now,
    )
    .run();

  return (await getBroadcastById(db, id))!;
}

export type UpdateBroadcastInput = Partial<
  Pick<
    Broadcast,
    | 'title'
    | 'message_type'
    | 'message_content'
    | 'target_type'
    | 'target_tag_id'
    | 'status'
    | 'scheduled_at'
    | 'channel'
    | 'email_template_id'
  >
>;

export async function updateBroadcast(
  db: D1Database,
  id: string,
  updates: UpdateBroadcastInput,
): Promise<Broadcast | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.message_type !== undefined) {
    fields.push('message_type = ?');
    values.push(updates.message_type);
  }
  if (updates.message_content !== undefined) {
    fields.push('message_content = ?');
    values.push(updates.message_content);
  }
  if (updates.target_type !== undefined) {
    fields.push('target_type = ?');
    values.push(updates.target_type);
  }
  if (updates.target_tag_id !== undefined) {
    fields.push('target_tag_id = ?');
    values.push(updates.target_tag_id);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.scheduled_at !== undefined) {
    fields.push('scheduled_at = ?');
    values.push(updates.scheduled_at);
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
      .prepare(`UPDATE broadcasts SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  return getBroadcastById(db, id);
}

export async function deleteBroadcast(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM broadcasts WHERE id = ?`).bind(id).run();
}

export interface BroadcastStatusCounts {
  totalCount?: number;
  successCount?: number;
}

export async function updateBroadcastStatus(
  db: D1Database,
  id: string,
  status: BroadcastStatus,
  counts?: BroadcastStatusCounts,
): Promise<void> {
  const fields: string[] = ['status = ?'];
  const values: unknown[] = [status];

  if (status === 'sent') {
    fields.push('sent_at = ?');
    values.push(jstNow());
  }
  if (counts?.totalCount !== undefined) {
    fields.push('total_count = ?');
    values.push(counts.totalCount);
  }
  if (counts?.successCount !== undefined) {
    fields.push('success_count = ?');
    values.push(counts.successCount);
  }

  values.push(id);
  await db
    .prepare(`UPDATE broadcasts SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}

/**
 * 送信前 atomic claim (CAS)。 status を scheduled|draft → 'sending' に遷移できた実行だけ
 * `changes===1` で true を返す。 重複 cron / 手動送信が同じ broadcast を二重送信するのを防ぐ
 * (= scenarios.ts claimFriendScenarioForDelivery と同設計、 #103)。
 * 既に sending/sent の場合は WHERE に一致せず changes===0 → false (= 別実行に委ねて skip)。
 *
 * WHERE に 'draft' を含むのは手動送信 route (= draft を即送信) を許可するため。
 * cron 経路は scheduled のみ enqueue する。
 *
 * ⚠️ 復旧注意: claim 後 (status='sending') に worker が crash すると 'sending' のまま残り、
 * cron も手動も再 pick しない (= 永続 stuck)。 復旧は手動 D1 UPDATE で 'draft' へ戻すか、
 * 将来 stuck-sending sweep cron を用意する (backlog E2)。
 */
export async function claimBroadcastForSending(
  db: D1Database,
  id: string,
): Promise<boolean> {
  // migration 067: claim 時刻を記録し stuck 検知/安全自動復旧 (getStuckSendingBroadcasts) を可能にする。
  const res = await db
    .prepare(
      `UPDATE broadcasts SET status = 'sending', sending_started_at = ?
       WHERE id = ? AND status IN ('scheduled', 'draft')`,
    )
    .bind(jstNow(), id)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

/**
 * 配信 cron 用の bounded due query (採点 Round1 D5/D1): status='scheduled' かつ
 * scheduled_at <= now の broadcast を古い順に limit 件取得 (= getBroadcasts 全件 scan を置換)。
 */
export async function getDueScheduledBroadcasts(
  db: D1Database,
  nowIso: string,
  limit = 100,
): Promise<Broadcast[]> {
  const result = await db
    .prepare(
      `SELECT * FROM broadcasts
       WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
       ORDER BY scheduled_at ASC LIMIT ?`,
    )
    .bind(nowIso, limit)
    .all<Broadcast>();
  return result.results;
}

/**
 * stuck-'sending' broadcast を sending_started_at 基準で取得 (採点 Round1 D1)。
 * cutoffIso より前に claim されたまま 'sending' で残っているものを古い順に limit 件。
 * 手動送信 (scheduled_at=NULL) も含めて検知できる (= 旧 scheduled_at 基準の穴を解消)。
 */
export async function getStuckSendingBroadcasts(
  db: D1Database,
  cutoffIso: string,
  limit = 50,
): Promise<Broadcast[]> {
  const result = await db
    .prepare(
      `SELECT * FROM broadcasts
       WHERE status = 'sending' AND sending_started_at IS NOT NULL AND sending_started_at < ?
       ORDER BY sending_started_at ASC LIMIT ?`,
    )
    .bind(cutoffIso, limit)
    .all<Broadcast>();
  return result.results;
}

/**
 * broadcast に「実際に送信された痕跡」があるか (採点 Round1 D1)。
 * line_request_id (broadcast API) / messages_log (multicast) / email_messages_log (email) の
 * いずれかが存在すれば true。 stuck の安全自動復旧で「未送信のみ再送」を判定するのに使う。
 */
export async function hasBroadcastSendEvidence(
  db: D1Database,
  broadcastId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT 1 FROM broadcasts WHERE id = ?1 AND line_request_id IS NOT NULL) AS has_req,
         EXISTS(SELECT 1 FROM messages_log WHERE broadcast_id = ?1) AS has_msg,
         EXISTS(SELECT 1 FROM email_messages_log WHERE broadcast_id = ?1) AS has_email`,
    )
    .bind(broadcastId)
    .first<{ has_req: number | null; has_msg: number; has_email: number }>();
  if (!row) return false;
  return Boolean(row.has_req) || Boolean(row.has_msg) || Boolean(row.has_email);
}

/**
 * 送信痕跡のない stuck broadcast を 'scheduled' に戻して安全に再送可能化する (採点 Round1 D1)。
 * CAS (status='sending' のときのみ) で二重操作を防ぐ。 scheduled_at=now にして次 cron が即 pick。
 * 痕跡のある stuck はこの関数を呼ばない (= 二重送信回避、 detect-only で手動 review)。
 */
export async function resetStuckBroadcastToScheduled(
  db: D1Database,
  broadcastId: string,
  nowIso: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE broadcasts SET status = 'scheduled', scheduled_at = ?, sending_started_at = NULL
       WHERE id = ? AND status = 'sending'`,
    )
    .bind(nowIso, broadcastId)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}
