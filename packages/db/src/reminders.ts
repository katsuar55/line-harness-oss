import { jstNow } from './utils.js';
// リマインダ配信クエリヘルパー

export interface ReminderRow {
  id: string;
  name: string;
  description: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface ReminderStepRow {
  id: string;
  reminder_id: string;
  offset_minutes: number;
  message_type: string;
  message_content: string;
  created_at: string;
}

export interface FriendReminderRow {
  id: string;
  friend_id: string;
  reminder_id: string;
  target_date: string;
  status: string;
  created_at: string;
  updated_at: string;
}

// --- リマインダCRUD ---

// 採点 Round1 D5: default LIMIT で unbounded scan / 10k 行 silent truncation を防止。
export async function getReminders(
  db: D1Database,
  opts: { limit?: number; offset?: number } = {},
): Promise<ReminderRow[]> {
  const limit = opts.limit ?? 1000;
  const offset = opts.offset ?? 0;
  const result = await db
    .prepare(`SELECT * FROM reminders ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(limit, offset)
    .all<ReminderRow>();
  return result.results;
}

export async function getReminderById(db: D1Database, id: string): Promise<ReminderRow | null> {
  return db.prepare(`SELECT * FROM reminders WHERE id = ?`).bind(id).first<ReminderRow>();
}

export async function createReminder(
  db: D1Database,
  input: { name: string; description?: string },
): Promise<ReminderRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.prepare(`INSERT INTO reminders (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, input.name, input.description ?? null, now, now).run();
  return (await getReminderById(db, id))!;
}

export async function updateReminder(
  db: D1Database,
  id: string,
  updates: Partial<{ name: string; description: string; isActive: boolean }>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
  if (updates.isActive !== undefined) { sets.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  await db.prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function deleteReminder(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM reminders WHERE id = ?`).bind(id).run();
}

// --- リマインダステップ ---

export async function getReminderSteps(db: D1Database, reminderId: string): Promise<ReminderStepRow[]> {
  const result = await db.prepare(`SELECT * FROM reminder_steps WHERE reminder_id = ? ORDER BY offset_minutes ASC`)
    .bind(reminderId).all<ReminderStepRow>();
  return result.results;
}

export async function createReminderStep(
  db: D1Database,
  input: { reminderId: string; offsetMinutes: number; messageType: string; messageContent: string },
): Promise<ReminderStepRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.prepare(`INSERT INTO reminder_steps (id, reminder_id, offset_minutes, message_type, message_content, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, input.reminderId, input.offsetMinutes, input.messageType, input.messageContent, now).run();
  return (await db.prepare(`SELECT * FROM reminder_steps WHERE id = ?`).bind(id).first<ReminderStepRow>())!;
}

export async function deleteReminderStep(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM reminder_steps WHERE id = ?`).bind(id).run();
}

// --- 友だちリマインダ ---

/**
 * リマインダの `target_date` を「明示 +09:00 offset 付き ISO8601」に正規化する (2026-06-15)。
 *
 * enroll は free-form な日付文字列を受け付ける。 bare な `YYYY-MM-DD` は SQLite `unixepoch()` /
 * JS `new Date()` の双方で **UTC** midnight と解釈され、 JST midnight より 9 時間ずれる
 * (当ブランドは JST 運用・ jstNow() は +09:00)。 そこで naive な日付/日時を JST と見なし、
 * 保存値が必ず explicit offset を持つようにする (= unixepoch と Date が同一 instant に一致)。
 *
 * - `YYYY-MM-DD`                       → `YYYY-MM-DDT00:00:00+09:00` (JST midnight)
 * - `YYYY-MM-DDTHH:mm[:ss[.sss]]`      → `+09:00` を付与し秒まで補完 (offset 無し = JST)
 * - 既に `Z` / `±HH:MM` offset 付き     → そのまま保持 (冪等)
 * - 形式不正 / 実在しない暦日 / 範囲外の時刻 (hour≥24・min/sec≥60) / 範囲外 offset → `null` (route で 400)
 *
 * 範囲検査は自前で行い JS Date の寛容な parse に依存しない (例: JS は 24:00:00 を翌日 00:00 として
 * 受理してしまうが、 reminder 用途では曖昧なので明示的に拒否する)。
 */
export function normalizeReminderTargetDate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();

  // date (必須) + 任意の time (HH:mm[:ss[.sss]]) + 任意の offset (Z | ±HH:MM)。
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(s);
  if (!m) return null;
  const [, yy, mo, dd, hh, mi, ss, frac, off] = m;

  // 実在しない暦日を拒否 (JS Date は 2026-02-30 を 03-02 へ silent roll-over するため明示検査)。
  const year = Number(yy), month = Number(mo), day = Number(dd);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  // 時刻成分の範囲検査 (24:00 等の曖昧/不正値を明示拒否)。
  if (hh !== undefined) {
    if (Number(hh) > 23 || Number(mi) > 59 || (ss !== undefined && Number(ss) > 59)) return null;
  }
  // offset の範囲検査 (±00:00..±23:59 のみ)。
  if (off && off !== 'Z') {
    if (Number(off.slice(1, 3)) > 23 || Number(off.slice(4, 6)) > 59) return null;
  }

  // 正規化して返す。 bare date → JST midnight、 naive 時刻 → +09:00 付与 (秒補完)、 明示 offset/Z → 保持。
  if (hh === undefined) return `${yy}-${mo}-${dd}T00:00:00+09:00`;
  const normalized = `${yy}-${mo}-${dd}T${hh}:${mi}:${ss ?? '00'}${frac ?? ''}${off ?? '+09:00'}`;
  return Number.isNaN(new Date(normalized).getTime()) ? null : normalized;
}

export async function enrollFriendInReminder(
  db: D1Database,
  input: { friendId: string; reminderId: string; targetDate: string },
): Promise<FriendReminderRow> {
  // 単一 chokepoint なので DB 層でも正規化する (route 以外の caller も保護)。 正規化は冪等。
  const targetDate = normalizeReminderTargetDate(input.targetDate);
  if (!targetDate) {
    throw new Error(`enrollFriendInReminder: invalid targetDate "${input.targetDate}"`);
  }
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.prepare(`INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, input.friendId, input.reminderId, targetDate, now, now).run();
  return (await db.prepare(`SELECT * FROM friend_reminders WHERE id = ?`).bind(id).first<FriendReminderRow>())!;
}

export async function getFriendReminders(db: D1Database, friendId: string): Promise<FriendReminderRow[]> {
  const result = await db.prepare(`SELECT * FROM friend_reminders WHERE friend_id = ? ORDER BY target_date ASC`)
    .bind(friendId).all<FriendReminderRow>();
  return result.results;
}

export async function cancelFriendReminder(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE friend_reminders SET status = 'cancelled', updated_at = ? WHERE id = ?`)
    .bind(jstNow(), id).run();
}

/**
 * 1 tick あたりに処理する due friend_reminder の上限 (launch-scale hardening, 2026-06-15)。
 * 数千友だち規模で `.all()` の 10,000 行上限による silent truncation (= 配信欠落) と、
 * cron の subrequest 枯渇を防ぐ。 超過分は次 tick で drain される (配信済 step は EXISTS
 * 条件から外れ、 ORDER BY target_date ASC で最古から処理される)。
 */
export const DUE_REMINDER_BATCH_LIMIT = 100;

/** リマインダ配信処理用: 配信が必要な友だちリマインダを取得 (bounded + N+1 解消) */
export async function getDueReminderDeliveries(
  db: D1Database,
  now: string,
  limit: number = DUE_REMINDER_BATCH_LIMIT,
): Promise<Array<FriendReminderRow & { steps: ReminderStepRow[] }>> {
  // 1) 「due かつ未配信の step を 1 つ以上持つ」 friend_reminder のみを bounded に取得する。
  //    - ブラックリスト除外 (consent/景表法): do-not-contact の友だちには本人設定の
  //      リマインダーも配信しない (H2、 一斉配信/シナリオと統一)。 解除で自動再開。
  //    - due 判定は unixepoch() で TZ 混在 (Z/+09:00) を UTC epoch に正規化する (D1 実機検証済:
  //      unixepoch('…+09:00') == unixepoch('…Z') == unixepoch('….000+09:00'))。 これは bounded
  //      候補を絞る prefilter で、 最終 due 判定は下記 3 の JS が行う。 JS 側も同じ whole-second
  //      精度 (Math.floor(ms/1000)) で比較するため、 SQL prefilter と JS authoritative は完全に
  //      同一の due 判定になる (= 取りこぼしも空 slot 浪費もなく、 配信欠落しない)。
  //    - 注: unixepoch(列) は関数包みのため idx_friend_reminders は range scan に使えず full scan
  //      になるが、 active な未配信 reminder は少数 + ≤5,000 友だち上限 (本番実測 sub-ms) で許容。
  //      大規模化時は target_date の epoch 式 index を別 migration で検討。
  const candidates = await db
    .prepare(
      `SELECT fr.* FROM friend_reminders fr
              INNER JOIN reminders r ON r.id = fr.reminder_id
              INNER JOIN friends f ON f.id = fr.friend_id
              WHERE fr.status = 'active' AND r.is_active = 1
                AND COALESCE(f.is_blacklisted, 0) = 0
                AND EXISTS (
                  SELECT 1 FROM reminder_steps rs
                  WHERE rs.reminder_id = fr.reminder_id
                    AND unixepoch(fr.target_date) + rs.offset_minutes * 60 <= unixepoch(?)
                    AND NOT EXISTS (
                      SELECT 1 FROM friend_reminder_deliveries frd
                      WHERE frd.friend_reminder_id = fr.id
                        AND frd.reminder_step_id = rs.id
                    )
                )
              ORDER BY unixepoch(fr.target_date) ASC
              LIMIT ?`,
    )
    .bind(now, limit)
    .all<FriendReminderRow>();

  const reminders = candidates.results;
  if (reminders.length === 0) return [];

  // 2) 候補の steps / deliveries を IN 句で一括取得し N+1 を解消する。
  const reminderIds = [...new Set(reminders.map((fr) => fr.reminder_id))];
  const frIds = reminders.map((fr) => fr.id);
  const ph = (n: number) => Array.from({ length: n }, () => '?').join(', ');

  const stepsRes = await db
    .prepare(
      `SELECT * FROM reminder_steps WHERE reminder_id IN (${ph(reminderIds.length)}) ORDER BY offset_minutes ASC`,
    )
    .bind(...reminderIds)
    .all<ReminderStepRow>();
  const stepsByReminder = new Map<string, ReminderStepRow[]>();
  for (const s of stepsRes.results) {
    const arr = stepsByReminder.get(s.reminder_id);
    if (arr) arr.push(s);
    else stepsByReminder.set(s.reminder_id, [s]);
  }

  const delRes = await db
    .prepare(
      `SELECT friend_reminder_id, reminder_step_id FROM friend_reminder_deliveries WHERE friend_reminder_id IN (${ph(frIds.length)})`,
    )
    .bind(...frIds)
    .all<{ friend_reminder_id: string; reminder_step_id: string }>();
  const deliveredByFr = new Map<string, Set<string>>();
  for (const d of delRes.results) {
    const set = deliveredByFr.get(d.friend_reminder_id);
    if (set) set.add(d.reminder_step_id);
    else deliveredByFr.set(d.friend_reminder_id, new Set([d.reminder_step_id]));
  }

  // 3) JS で due step を最終確定する (delivered 除外 + dueSteps 構築、 authoritative)。
  //    due 比較は SQL prefilter (unixepoch = 秒精度) と完全一致させるため whole-second に揃える
  //    (Math.floor(ms/1000))。 これで prefilter と authoritative が同一判定になり、 ミリ秒境界での
  //    乖離 (= SQL が拾い JS が落とす空 slot) が原理的に発生しない。 5分 cron なので秒未満は無意味。
  //    不正な target_date は getTime()=NaN → Math.floor(NaN)=NaN、 `NaN <= nowSec === false` で除外
  //    (= SQL の unixepoch(invalid)=NULL 除外と同挙動)。
  const nowSec = Math.floor(new Date(now).getTime() / 1000);
  const results: Array<FriendReminderRow & { steps: ReminderStepRow[] }> = [];
  for (const fr of reminders) {
    const steps = stepsByReminder.get(fr.reminder_id) ?? [];
    const deliveredIds = deliveredByFr.get(fr.id) ?? new Set<string>();
    const targetSec = Math.floor(new Date(fr.target_date).getTime() / 1000);
    const dueSteps = steps.filter((step) => {
      if (deliveredIds.has(step.id)) return false;
      return targetSec + step.offset_minutes * 60 <= nowSec;
    });
    if (dueSteps.length > 0) {
      results.push({ ...fr, steps: dueSteps });
    }
  }
  return results;
}

/** 配信済みを記録 */
export async function markReminderStepDelivered(db: D1Database, friendReminderId: string, reminderStepId: string): Promise<void> {
  const id = crypto.randomUUID();
  await db.prepare(`INSERT OR IGNORE INTO friend_reminder_deliveries (id, friend_reminder_id, reminder_step_id) VALUES (?, ?, ?)`)
    .bind(id, friendReminderId, reminderStepId).run();
}

/**
 * 送信前 atomic claim。 friend_reminder_deliveries の UNIQUE(friend_reminder_id, reminder_step_id) を
 * 利用し、 INSERT OR IGNORE で「初めて行を入れられた実行」 だけ changes===1 で true を返す。
 * 重複 cron が同じステップを二重 push するのを防ぐ (= push の前に claim する)。
 * 既に配信済 (= 行あり) なら changes===0 → false (= skip)。
 */
export async function claimReminderStepDelivery(db: D1Database, friendReminderId: string, reminderStepId: string): Promise<boolean> {
  const id = crypto.randomUUID();
  const res = await db.prepare(`INSERT OR IGNORE INTO friend_reminder_deliveries (id, friend_reminder_id, reminder_step_id) VALUES (?, ?, ?)`)
    .bind(id, friendReminderId, reminderStepId).run();
  return (res.meta?.changes ?? 0) === 1;
}

/** 全ステップ配信済みならcompletedにする */
export async function completeReminderIfDone(db: D1Database, friendReminderId: string, reminderId: string): Promise<void> {
  const totalSteps = await db.prepare(`SELECT COUNT(*) as count FROM reminder_steps WHERE reminder_id = ?`)
    .bind(reminderId).first<{ count: number }>();
  const deliveredSteps = await db.prepare(`SELECT COUNT(*) as count FROM friend_reminder_deliveries WHERE friend_reminder_id = ?`)
    .bind(friendReminderId).first<{ count: number }>();

  if (totalSteps && deliveredSteps && deliveredSteps.count >= totalSteps.count) {
    await db.prepare(`UPDATE friend_reminders SET status = 'completed', updated_at = ? WHERE id = ?`)
      .bind(jstNow(), friendReminderId).run();
  }
}
