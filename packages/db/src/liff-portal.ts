import { jstNow } from './utils.js';

// ===== Intake Logs =====

export async function createIntakeLog(
  db: D1Database,
  data: {
    friendId: string;
    productName?: string;
    shopifyProductId?: string;
    note?: string;
  },
): Promise<{ id: string; streak_count: number; logged_at: string }> {
  const now = jstNow();
  const today = now.slice(0, 10); // YYYY-MM-DD

  // Calculate streak: count consecutive days backwards from today
  const streak = await calculateStreak(db, data.friendId, today);

  const result = await db
    .prepare(
      `INSERT INTO intake_logs (friend_id, product_name, shopify_product_id, streak_count, note, logged_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id, streak_count, logged_at`,
    )
    .bind(
      data.friendId,
      data.productName ?? null,
      data.shopifyProductId ?? null,
      streak + 1,
      data.note ?? null,
      now,
      now,
    )
    .first<{ id: string; streak_count: number; logged_at: string }>();

  if (!result) throw new Error('createIntakeLog: INSERT returned null');
  return result;
}

export async function getIntakeLogs(
  db: D1Database,
  friendId: string,
  days: number = 30,
): Promise<Array<{ id: string; product_name: string | null; streak_count: number; logged_at: string; note: string | null }>> {
  const now = jstNow();
  const since = new Date(new Date(now).getTime() - days * 86400000).toISOString().slice(0, 10);

  const { results } = await db
    .prepare(
      `SELECT id, product_name, streak_count, logged_at, note
       FROM intake_logs WHERE friend_id = ? AND logged_at >= ?
       ORDER BY logged_at DESC`,
    )
    .bind(friendId, since)
    .all();

  return results as Array<{ id: string; product_name: string | null; streak_count: number; logged_at: string; note: string | null }>;
}

export async function getTodayIntakeCount(
  db: D1Database,
  friendId: string,
): Promise<number> {
  const today = jstNow().slice(0, 10);

  const row = await db
    .prepare(`SELECT COUNT(*) as cnt FROM intake_logs WHERE friend_id = ? AND logged_at LIKE ?`)
    .bind(friendId, `${today}%`)
    .first<{ cnt: number }>();

  return row?.cnt ?? 0;
}

/** Subtract N days from a YYYY-MM-DD string, returning YYYY-MM-DD (timezone-safe). */
function subtractDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

async function calculateStreak(
  db: D1Database,
  friendId: string,
  today: string,
): Promise<number> {
  // Get distinct log dates in descending order
  const { results } = await db
    .prepare(
      `SELECT DISTINCT substr(logged_at, 1, 10) as log_date
       FROM intake_logs WHERE friend_id = ?
       ORDER BY log_date DESC LIMIT 60`,
    )
    .bind(friendId)
    .all<{ log_date: string }>();

  if (!results || results.length === 0) return 0;

  let streak = 0;
  // Start from yesterday (today's log is being created now)
  let dayOffset = 1;

  for (const row of results) {
    const logDate = row.log_date;
    const expected = subtractDays(today, dayOffset);

    if (logDate === expected) {
      streak++;
      dayOffset++;
    } else if (logDate < expected) {
      break; // Gap found
    }
  }

  return streak;
}

export async function getIntakeStreak(
  db: D1Database,
  friendId: string,
): Promise<{ currentStreak: number; longestStreak: number; totalDays: number }> {
  const today = jstNow().slice(0, 10);
  const todayCount = await getTodayIntakeCount(db, friendId);
  const currentStreak = await calculateStreak(db, friendId, today) + (todayCount > 0 ? 1 : 0);

  // Total unique days
  const totalRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT substr(logged_at, 1, 10)) as total FROM intake_logs WHERE friend_id = ?`,
    )
    .bind(friendId)
    .first<{ total: number }>();

  // Longest streak from max streak_count
  const longestRow = await db
    .prepare(`SELECT MAX(streak_count) as longest FROM intake_logs WHERE friend_id = ?`)
    .bind(friendId)
    .first<{ longest: number | null }>();

  return {
    currentStreak,
    longestStreak: Math.max(longestRow?.longest ?? 0, currentStreak),
    totalDays: totalRow?.total ?? 0,
  };
}

// ===== Intake Reminders =====

/**
 * リマインダーを追加（1ユーザー最大5件）
 */
export async function addIntakeReminder(
  db: D1Database,
  data: {
    friendId: string;
    label?: string;
    reminderTime?: string;
    timezone?: string;
  },
): Promise<{ id: string; label: string; reminder_time: string; is_active: number }> {
  const now = jstNow();

  // 最大5件チェック
  const countResult = await db
    .prepare('SELECT COUNT(*) as cnt FROM intake_reminders WHERE friend_id = ?')
    .bind(data.friendId)
    .first<{ cnt: number }>();
  if (countResult && countResult.cnt >= 5) {
    throw new Error('MAX_REMINDERS_REACHED');
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO intake_reminders (id, friend_id, label, reminder_time, timezone, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      id,
      data.friendId,
      data.label ?? '朝食前',
      data.reminderTime ?? '08:00',
      data.timezone ?? 'Asia/Tokyo',
      now,
      now,
    )
    .run();

  return { id, label: data.label ?? '朝食前', reminder_time: data.reminderTime ?? '08:00', is_active: 1 };
}

/**
 * リマインダー更新（ID指定）
 */
export async function updateIntakeReminder(
  db: D1Database,
  data: {
    id: string;
    friendId: string;
    label?: string;
    reminderTime?: string;
    isActive?: boolean;
  },
): Promise<{ id: string; label: string; reminder_time: string; is_active: number }> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE intake_reminders SET
       label = COALESCE(?, label),
       reminder_time = COALESCE(?, reminder_time),
       is_active = COALESCE(?, is_active),
       updated_at = ?
       WHERE id = ? AND friend_id = ?`,
    )
    .bind(
      data.label ?? null,
      data.reminderTime ?? null,
      data.isActive !== undefined ? (data.isActive ? 1 : 0) : null,
      now,
      data.id,
      data.friendId,
    )
    .run();

  const result = await db
    .prepare('SELECT id, label, reminder_time, is_active FROM intake_reminders WHERE id = ?')
    .bind(data.id)
    .first<{ id: string; label: string; reminder_time: string; is_active: number }>();

  if (!result) throw new Error('Reminder not found');
  return result;
}

/**
 * リマインダー削除（ID指定）
 */
export async function deleteIntakeReminder(
  db: D1Database,
  id: string,
  friendId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM intake_reminders WHERE id = ? AND friend_id = ?')
    .bind(id, friendId)
    .run();
}

/**
 * ユーザーの全リマインダー取得
 */
export async function getIntakeReminders(
  db: D1Database,
  friendId: string,
): Promise<Array<{ id: string; label: string; reminder_time: string; is_active: number }>> {
  const { results } = await db
    .prepare('SELECT id, label, reminder_time, is_active FROM intake_reminders WHERE friend_id = ? ORDER BY reminder_time ASC')
    .bind(friendId)
    .all<{ id: string; label: string; reminder_time: string; is_active: number }>();
  return results;
}

/**
 * 後方互換: 単一リマインダー取得（最初の1件を返す）
 */
export async function getIntakeReminder(
  db: D1Database,
  friendId: string,
): Promise<{ id: string; reminder_time: string; timezone: string; reminder_type: string; is_active: number; last_sent_at: string | null } | null> {
  return db
    .prepare(`SELECT id, reminder_time, timezone, reminder_type, is_active, last_sent_at FROM intake_reminders WHERE friend_id = ? ORDER BY reminder_time ASC LIMIT 1`)
    .bind(friendId)
    .first();
}

/**
 * 後方互換: upsertIntakeReminder（最初の1件を更新 or 新規作成）
 */
export async function upsertIntakeReminder(
  db: D1Database,
  data: {
    friendId: string;
    reminderTime?: string;
    timezone?: string;
    reminderType?: string;
    isActive?: boolean;
  },
): Promise<{ id: string; reminder_time: string; is_active: number }> {
  const now = jstNow();
  const existing = await db
    .prepare(`SELECT id FROM intake_reminders WHERE friend_id = ? ORDER BY created_at ASC LIMIT 1`)
    .bind(data.friendId)
    .first<{ id: string }>();

  if (existing) {
    await db
      .prepare(
        `UPDATE intake_reminders SET
         reminder_time = COALESCE(?, reminder_time),
         timezone = COALESCE(?, timezone),
         reminder_type = COALESCE(?, reminder_type),
         is_active = COALESCE(?, is_active),
         updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        data.reminderTime ?? null,
        data.timezone ?? null,
        data.reminderType ?? null,
        data.isActive !== undefined ? (data.isActive ? 1 : 0) : null,
        now,
        existing.id,
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO intake_reminders (friend_id, label, reminder_time, timezone, reminder_type, is_active, created_at, updated_at)
         VALUES (?, '朝食前', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        data.friendId,
        data.reminderTime ?? '08:00',
        data.timezone ?? 'Asia/Tokyo',
        data.reminderType ?? 'morning_push',
        data.isActive !== undefined ? (data.isActive ? 1 : 0) : 1,
        now,
        now,
      )
      .run();
  }

  const result = await db
    .prepare(`SELECT id, reminder_time, is_active FROM intake_reminders WHERE friend_id = ? ORDER BY created_at ASC LIMIT 1`)
    .bind(data.friendId)
    .first<{ id: string; reminder_time: string; is_active: number }>();

  if (!result) throw new Error('upsertIntakeReminder: query returned null');
  return result;
}

// ── メッセージテンプレート ──

/**
 * 時間帯に応じたメッセージをランダム取得（過去に送ったものを避ける）
 */
export async function pickReminderMessage(
  db: D1Database,
  friendId: string,
  timeSlot: 'morning' | 'noon' | 'evening',
): Promise<{ id: string; message: string; category: string } | null> {
  // まず未送信のメッセージを優先取得
  const unsent = await db
    .prepare(
      `SELECT rm.id, rm.message, rm.category
       FROM reminder_messages rm
       WHERE rm.is_active = 1
         AND rm.time_slot IN (?, 'any')
         AND rm.id NOT IN (
           SELECT rml.reminder_message_id FROM reminder_message_log rml WHERE rml.friend_id = ?
         )
       ORDER BY RANDOM()
       LIMIT 1`,
    )
    .bind(timeSlot, friendId)
    .first<{ id: string; message: string; category: string }>();

  if (unsent) return unsent;

  // 全メッセージ送信済みの場合: 最も古く送ったものを再利用
  const oldest = await db
    .prepare(
      `SELECT rm.id, rm.message, rm.category
       FROM reminder_messages rm
       JOIN reminder_message_log rml ON rml.reminder_message_id = rm.id
       WHERE rm.is_active = 1
         AND rm.time_slot IN (?, 'any')
         AND rml.friend_id = ?
       ORDER BY rml.sent_at ASC
       LIMIT 1`,
    )
    .bind(timeSlot, friendId)
    .first<{ id: string; message: string; category: string }>();

  return oldest ?? null;
}

/**
 * メッセージ送信履歴を記録
 */
export async function logReminderMessage(
  db: D1Database,
  friendId: string,
  messageId: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO reminder_message_log (id, friend_id, reminder_message_id, sent_at) VALUES (?, ?, ?, ?)',
    )
    .bind(crypto.randomUUID(), friendId, messageId, jstNow())
    .run();
}

export async function getActiveIntakeReminders(
  db: D1Database,
  currentTime: string,
): Promise<Array<{ id: string; friend_id: string; reminder_time: string; reminder_type: string; last_sent_at: string | null; snooze_until: string | null }>> {
  const today = jstNow().slice(0, 10);

  const { results } = await db
    .prepare(
      `SELECT ir.id, ir.friend_id, ir.reminder_time, ir.reminder_type, ir.last_sent_at, ir.snooze_until
       FROM intake_reminders ir
       JOIN friends f ON f.id = ir.friend_id
       WHERE ir.is_active = 1
         AND f.is_following = 1
         AND ir.reminder_time <= ?
         AND (ir.last_sent_at IS NULL OR ir.last_sent_at < ?)
       LIMIT 100`,
    )
    .bind(currentTime, today)
    .all();

  return results as Array<{ id: string; friend_id: string; reminder_time: string; reminder_type: string; last_sent_at: string | null; snooze_until: string | null }>;
}

export async function updateReminderLastSent(
  db: D1Database,
  reminderId: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(`UPDATE intake_reminders SET last_sent_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, reminderId)
    .run();
}

// ===== Referral Links =====

export async function createReferralLink(
  db: D1Database,
  data: {
    friendId: string;
    refCode: string;
    referrerCouponId?: string;
    referredCouponId?: string;
  },
): Promise<{ id: string; ref_code: string }> {
  const now = jstNow();

  const result = await db
    .prepare(
      `INSERT INTO referral_links (friend_id, ref_code, referrer_coupon_id, referred_coupon_id, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING id, ref_code`,
    )
    .bind(
      data.friendId,
      data.refCode,
      data.referrerCouponId ?? null,
      data.referredCouponId ?? null,
      now,
    )
    .first<{ id: string; ref_code: string }>();

  if (!result) throw new Error('createReferralLink: INSERT returned null');
  return result;
}

export async function getReferralLink(
  db: D1Database,
  friendId: string,
): Promise<{ id: string; ref_code: string; referrer_coupon_id: string | null; referred_coupon_id: string | null; is_active: number } | null> {
  return db
    .prepare(`SELECT id, ref_code, referrer_coupon_id, referred_coupon_id, is_active FROM referral_links WHERE friend_id = ?`)
    .bind(friendId)
    .first();
}

export async function getReferralLinkByRefCode(
  db: D1Database,
  refCode: string,
): Promise<{ id: string; friend_id: string; ref_code: string; referrer_coupon_id: string | null; referred_coupon_id: string | null } | null> {
  return db
    .prepare(`SELECT id, friend_id, ref_code, referrer_coupon_id, referred_coupon_id FROM referral_links WHERE ref_code = ? AND is_active = 1`)
    .bind(refCode)
    .first();
}

// ===== Referral Rewards =====

export async function createReferralReward(
  db: D1Database,
  data: {
    referrerFriendId: string;
    referredFriendId: string;
    referrerCouponId?: string;
    referredCouponId?: string;
  },
): Promise<{ id: string; status: string }> {
  const now = jstNow();

  const result = await db
    .prepare(
      `INSERT INTO referral_rewards (referrer_friend_id, referred_friend_id, referrer_coupon_id, referred_coupon_id, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?) RETURNING id, status`,
    )
    .bind(
      data.referrerFriendId,
      data.referredFriendId,
      data.referrerCouponId ?? null,
      data.referredCouponId ?? null,
      now,
    )
    .first<{ id: string; status: string }>();

  if (!result) throw new Error('createReferralReward: INSERT returned null');
  return result;
}

export async function getReferralStats(
  db: D1Database,
  friendId: string,
): Promise<{ totalReferred: number; pendingRewards: number; rewardedCount: number }> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
         SUM(CASE WHEN status = 'rewarded' THEN 1 ELSE 0 END) as rewarded
       FROM referral_rewards WHERE referrer_friend_id = ?`,
    )
    .bind(friendId)
    .first<{ total: number; pending: number; rewarded: number }>();

  return {
    totalReferred: row?.total ?? 0,
    pendingRewards: row?.pending ?? 0,
    rewardedCount: row?.rewarded ?? 0,
  };
}

// ===== Recommendation Results =====

export async function createRecommendationResult(
  db: D1Database,
  data: {
    friendId: string;
    quizAnswers: Record<string, string>;
    recommendedProduct: string;
    recommendedProductId?: string;
    scoreBreakdown: Record<string, number>;
  },
): Promise<{ id: string; recommended_product: string }> {
  const now = jstNow();

  const result = await db
    .prepare(
      `INSERT INTO recommendation_results (friend_id, quiz_answers, recommended_product, recommended_product_id, score_breakdown, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id, recommended_product`,
    )
    .bind(
      data.friendId,
      JSON.stringify(data.quizAnswers),
      data.recommendedProduct,
      data.recommendedProductId ?? null,
      JSON.stringify(data.scoreBreakdown),
      now,
    )
    .first<{ id: string; recommended_product: string }>();

  if (!result) throw new Error('createRecommendationResult: INSERT returned null');
  return result;
}

export async function getLatestRecommendation(
  db: D1Database,
  friendId: string,
): Promise<{ id: string; quiz_answers: string; recommended_product: string; score_breakdown: string; created_at: string } | null> {
  return db
    .prepare(
      `SELECT id, quiz_answers, recommended_product, score_breakdown, created_at
       FROM recommendation_results WHERE friend_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(friendId)
    .first();
}

// ===== Health Logs =====

export async function upsertHealthLog(
  db: D1Database,
  data: {
    friendId: string;
    logDate: string;
    weight?: number;
    condition?: string;
    skinCondition?: string;
    meals?: Record<string, string>;
    sleepHours?: number;
    note?: string;
    bowelForm?: string;
    bowelCount?: number;
    mood?: string;
  },
): Promise<{ id: string; log_date: string }> {
  const now = jstNow();

  const existing = await db
    .prepare(`SELECT id FROM health_logs WHERE friend_id = ? AND log_date = ?`)
    .bind(data.friendId, data.logDate)
    .first<{ id: string }>();

  if (existing) {
    await db
      .prepare(
        `UPDATE health_logs SET
         weight = COALESCE(?, weight),
         condition = COALESCE(?, condition),
         skin_condition = COALESCE(?, skin_condition),
         meals = COALESCE(?, meals),
         sleep_hours = COALESCE(?, sleep_hours),
         note = COALESCE(?, note),
         bowel_form = COALESCE(?, bowel_form),
         bowel_count = COALESCE(?, bowel_count),
         mood = COALESCE(?, mood)
         WHERE id = ?`,
      )
      .bind(
        data.weight ?? null,
        data.condition ?? null,
        data.skinCondition ?? null,
        data.meals ? JSON.stringify(data.meals) : null,
        data.sleepHours ?? null,
        data.note ?? null,
        data.bowelForm ?? null,
        data.bowelCount ?? null,
        data.mood ?? null,
        existing.id,
      )
      .run();

    return { id: existing.id, log_date: data.logDate };
  }

  const result = await db
    .prepare(
      `INSERT INTO health_logs (friend_id, log_date, weight, condition, skin_condition, meals, sleep_hours, note, bowel_form, bowel_count, mood, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, log_date`,
    )
    .bind(
      data.friendId,
      data.logDate,
      data.weight ?? null,
      data.condition ?? null,
      data.skinCondition ?? null,
      data.meals ? JSON.stringify(data.meals) : null,
      data.sleepHours ?? null,
      data.note ?? null,
      data.bowelForm ?? null,
      data.bowelCount ?? null,
      data.mood ?? null,
      now,
    )
    .first<{ id: string; log_date: string }>();

  if (!result) throw new Error('upsertHealthLog: INSERT returned null');
  return result;
}

export async function getHealthLogs(
  db: D1Database,
  friendId: string,
  days: number = 30,
): Promise<Array<{ id: string; log_date: string; weight: number | null; condition: string | null; skin_condition: string | null; meals: string | null; sleep_hours: number | null; note: string | null; bowel_form: string | null; bowel_count: number | null; mood: string | null }>> {
  const now = jstNow();
  const since = new Date(new Date(now).getTime() - days * 86400000).toISOString().slice(0, 10);

  const { results } = await db
    .prepare(
      `SELECT id, log_date, weight, condition, skin_condition, meals, sleep_hours, note, bowel_form, bowel_count, mood
       FROM health_logs WHERE friend_id = ? AND log_date >= ?
       ORDER BY log_date DESC`,
    )
    .bind(friendId, since)
    .all();

  return results as Array<{ id: string; log_date: string; weight: number | null; condition: string | null; skin_condition: string | null; meals: string | null; sleep_hours: number | null; note: string | null; bowel_form: string | null; bowel_count: number | null; mood: string | null }>;
}

export async function getHealthTrends(
  db: D1Database,
  friendId: string,
  days: number = 30,
): Promise<Array<{ log_date: string; weight: number | null; condition: string | null; skin_condition: string | null; sleep_hours: number | null; bowel_form: string | null; bowel_count: number | null; mood: string | null }>> {
  const now = jstNow();
  const since = new Date(new Date(now).getTime() - days * 86400000).toISOString().slice(0, 10);

  const { results } = await db
    .prepare(
      `SELECT log_date, weight, condition, skin_condition, sleep_hours, bowel_form, bowel_count, mood
       FROM health_logs WHERE friend_id = ? AND log_date >= ?
       ORDER BY log_date ASC`,
    )
    .bind(friendId, since)
    .all();

  return results as Array<{ log_date: string; weight: number | null; condition: string | null; skin_condition: string | null; sleep_hours: number | null; bowel_form: string | null; bowel_count: number | null; mood: string | null }>;
}

export async function getHealthSummary(
  db: D1Database,
  friendId: string,
): Promise<{ totalLogs: number; avgWeight: number | null; goodDays: number; normalDays: number; badDays: number; latestWeight: number | null }> {
  const summary = await db
    .prepare(
      `SELECT
         COUNT(*) as total,
         AVG(weight) as avg_weight,
         SUM(CASE WHEN condition = 'good' THEN 1 ELSE 0 END) as good,
         SUM(CASE WHEN condition = 'normal' THEN 1 ELSE 0 END) as normal,
         SUM(CASE WHEN condition = 'bad' THEN 1 ELSE 0 END) as bad
       FROM health_logs WHERE friend_id = ? AND log_date >= date('now', '-7 days')`,
    )
    .bind(friendId)
    .first<{ total: number; avg_weight: number | null; good: number; normal: number; bad: number }>();

  const latest = await db
    .prepare(`SELECT weight FROM health_logs WHERE friend_id = ? AND weight IS NOT NULL ORDER BY log_date DESC LIMIT 1`)
    .bind(friendId)
    .first<{ weight: number | null }>();

  return {
    totalLogs: summary?.total ?? 0,
    avgWeight: summary?.avg_weight ? Math.round(summary.avg_weight * 10) / 10 : null,
    goodDays: summary?.good ?? 0,
    normalDays: summary?.normal ?? 0,
    badDays: summary?.bad ?? 0,
    latestWeight: latest?.weight ?? null,
  };
}

// ===== Ambassadors =====

export async function enrollAmbassador(
  db: D1Database,
  friendId: string,
  preferences?: { survey_ok?: boolean; product_test_ok?: boolean; sns_share_ok?: boolean },
): Promise<{ id: string; status: string }> {
  const now = jstNow();
  const prefs = JSON.stringify({
    survey_ok: preferences?.survey_ok ?? true,
    product_test_ok: preferences?.product_test_ok ?? true,
    sns_share_ok: preferences?.sns_share_ok ?? false,
  });

  const existing = await db
    .prepare(`SELECT id, status FROM ambassadors WHERE friend_id = ?`)
    .bind(friendId)
    .first<{ id: string; status: string }>();

  if (existing) {
    await db
      .prepare(`UPDATE ambassadors SET status = 'active', enrolled_at = ?, preferences = ?, updated_at = ? WHERE id = ?`)
      .bind(now, prefs, now, existing.id)
      .run();
    return { id: existing.id, status: 'active' };
  }

  const result = await db
    .prepare(
      `INSERT INTO ambassadors (friend_id, status, enrolled_at, preferences, created_at, updated_at)
       VALUES (?, 'active', ?, ?, ?, ?) RETURNING id, status`,
    )
    .bind(friendId, now, prefs, now, now)
    .first<{ id: string; status: string }>();

  if (!result) throw new Error('enrollAmbassador: INSERT returned null');
  return result;
}

export async function getAmbassador(
  db: D1Database,
  friendId: string,
): Promise<{ id: string; status: string; tier: string; enrolled_at: string | null; total_surveys_completed: number; total_product_tests: number; feedback_score: number | null; preferences: string } | null> {
  return db
    .prepare(
      `SELECT id, status, tier, enrolled_at, total_surveys_completed, total_product_tests, feedback_score, preferences
       FROM ambassadors WHERE friend_id = ?`,
    )
    .bind(friendId)
    .first();
}

export async function getAmbassadors(
  db: D1Database,
  filters?: { status?: string; tier?: string; limit?: number; offset?: number },
): Promise<{ ambassadors: Array<Record<string, unknown>>; total: number }> {
  let where = 'WHERE 1=1';
  const params: unknown[] = [];

  if (filters?.status) {
    where += ' AND a.status = ?';
    params.push(filters.status);
  }
  if (filters?.tier) {
    where += ' AND a.tier = ?';
    params.push(filters.tier);
  }

  const countRow = await db
    .prepare(`SELECT COUNT(*) as cnt FROM ambassadors a ${where}`)
    .bind(...params)
    .first<{ cnt: number }>();

  const limit = filters?.limit ?? 20;
  const offset = filters?.offset ?? 0;

  const { results } = await db
    .prepare(
      `SELECT a.*, f.display_name, f.picture_url
       FROM ambassadors a
       JOIN friends f ON f.id = a.friend_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all();

  return { ambassadors: results as Array<Record<string, unknown>>, total: countRow?.cnt ?? 0 };
}

export async function updateAmbassador(
  db: D1Database,
  id: string,
  data: { status?: string; tier?: string; note?: string },
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE ambassadors SET
       status = COALESCE(?, status),
       tier = COALESCE(?, tier),
       note = COALESCE(?, note),
       updated_at = ?
       WHERE id = ?`,
    )
    .bind(data.status ?? null, data.tier ?? null, data.note ?? null, now, id)
    .run();
}

export async function getAmbassadorStats(
  db: D1Database,
): Promise<{ total: number; active: number; avgSurveys: number; avgFeedbackScore: number | null }> {
  const stats = await db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
         AVG(total_surveys_completed) as avg_surveys,
         AVG(feedback_score) as avg_feedback
       FROM ambassadors`,
    )
    .first<{ total: number; active: number; avg_surveys: number; avg_feedback: number | null }>();

  return {
    total: stats?.total ?? 0,
    active: stats?.active ?? 0,
    avgSurveys: Math.round(stats?.avg_surveys ?? 0),
    avgFeedbackScore: stats?.avg_feedback ? Math.round(stats.avg_feedback * 10) / 10 : null,
  };
}

// ===== Ambassador Feedback =====

export async function submitAmbassadorFeedback(
  db: D1Database,
  ambassadorId: string,
  friendId: string,
  data: { type?: string; category?: string; content: string; rating?: number },
): Promise<{ id: string }> {
  const result = await db
    .prepare(
      `INSERT INTO ambassador_feedback (ambassador_id, friend_id, type, category, content, rating)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      ambassadorId,
      friendId,
      data.type || 'feedback',
      data.category || 'general',
      data.content,
      data.rating ?? null,
    )
    .first<{ id: string }>();

  if (!result) throw new Error('submitAmbassadorFeedback: INSERT returned null');

  // Update ambassador feedback_score (running average of ratings)
  if (data.rating) {
    await db
      .prepare(
        `UPDATE ambassadors SET
         feedback_score = (SELECT AVG(rating) FROM ambassador_feedback WHERE ambassador_id = ? AND rating IS NOT NULL),
         total_surveys_completed = total_surveys_completed + 1,
         updated_at = ?
         WHERE id = ?`,
      )
      .bind(ambassadorId, jstNow(), ambassadorId)
      .run();
  }

  return result;
}

export async function getAmbassadorFeedbacks(
  db: D1Database,
  ambassadorId: string,
  limit = 10,
): Promise<Array<{ id: string; type: string; category: string; content: string; rating: number | null; created_at: string }>> {
  const { results } = await db
    .prepare(
      `SELECT id, type, category, content, rating, created_at
       FROM ambassador_feedback
       WHERE ambassador_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(ambassadorId, limit)
    .all();

  return results as Array<{ id: string; type: string; category: string; content: string; rating: number | null; created_at: string }>;
}

// ===== Ambassador Surveys =====

export interface SurveyQuestion {
  id: string;
  type: 'rating' | 'text' | 'choice' | 'multi_choice';
  label: string;
  options?: string[];
  required?: boolean;
}

export interface AmbassadorSurvey {
  id: string;
  title: string;
  description: string | null;
  survey_type: string;
  questions: string;
  target_tier: string;
  status: string;
  sent_count: number;
  response_count: number;
  created_at: string;
  updated_at: string;
}

export async function createSurvey(
  db: D1Database,
  data: {
    title: string;
    description?: string;
    survey_type?: string;
    questions: SurveyQuestion[];
    target_tier?: string;
  },
): Promise<{ id: string }> {
  const id = `srv_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = jstNow();
  const result = await db
    .prepare(
      `INSERT INTO ambassador_surveys (id, title, description, survey_type, questions, target_tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      id,
      data.title,
      data.description || null,
      data.survey_type || 'survey',
      JSON.stringify(data.questions),
      data.target_tier || 'all',
      now,
      now,
    )
    .first<{ id: string }>();
  if (!result) throw new Error('createSurvey: INSERT returned null');
  return result;
}

export async function updateSurvey(
  db: D1Database,
  id: string,
  data: {
    title?: string;
    description?: string;
    questions?: SurveyQuestion[];
    target_tier?: string;
    status?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (data.title !== undefined) { sets.push('title = ?'); vals.push(data.title); }
  if (data.description !== undefined) { sets.push('description = ?'); vals.push(data.description); }
  if (data.questions !== undefined) { sets.push('questions = ?'); vals.push(JSON.stringify(data.questions)); }
  if (data.target_tier !== undefined) { sets.push('target_tier = ?'); vals.push(data.target_tier); }
  if (data.status !== undefined) { sets.push('status = ?'); vals.push(data.status); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  vals.push(jstNow());
  vals.push(id);
  await db.prepare(`UPDATE ambassador_surveys SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}

export async function getSurveys(
  db: D1Database,
  filters?: { status?: string; survey_type?: string; limit?: number; offset?: number },
): Promise<{ surveys: AmbassadorSurvey[]; total: number }> {
  const wheres: string[] = [];
  const vals: unknown[] = [];
  if (filters?.status) { wheres.push('status = ?'); vals.push(filters.status); }
  if (filters?.survey_type) { wheres.push('survey_type = ?'); vals.push(filters.survey_type); }
  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
  const limit = filters?.limit || 20;
  const offset = filters?.offset || 0;

  const countVals = [...vals];
  const { total } = await db
    .prepare(`SELECT COUNT(*) as total FROM ambassador_surveys ${whereClause}`)
    .bind(...countVals)
    .first<{ total: number }>() ?? { total: 0 };

  vals.push(limit, offset);
  const { results } = await db
    .prepare(`SELECT * FROM ambassador_surveys ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...vals)
    .all();

  return { surveys: results as unknown as AmbassadorSurvey[], total };
}

export async function getSurveyById(
  db: D1Database,
  id: string,
): Promise<AmbassadorSurvey | null> {
  return db
    .prepare('SELECT * FROM ambassador_surveys WHERE id = ?')
    .bind(id)
    .first<AmbassadorSurvey>();
}

export async function deleteSurvey(
  db: D1Database,
  id: string,
): Promise<void> {
  await db.prepare('DELETE FROM ambassador_surveys WHERE id = ?').bind(id).run();
}

// --- Survey Delivery ---

export async function getDeliveryTargets(
  db: D1Database,
  surveyId: string,
  targetTier: string,
): Promise<Array<{ ambassador_id: string; friend_id: string; line_user_id: string }>> {
  const tierClause = targetTier === 'all' ? '' : 'AND a.tier = ?';
  const vals: unknown[] = [surveyId];
  if (targetTier !== 'all') vals.push(targetTier);

  const { results } = await db
    .prepare(
      `SELECT a.id as ambassador_id, a.friend_id, f.line_user_id
       FROM ambassadors a
       JOIN friends f ON f.id = a.friend_id
       WHERE a.status = 'active'
       AND f.is_following = 1
       AND a.id NOT IN (SELECT ambassador_id FROM ambassador_survey_deliveries WHERE survey_id = ?)
       ${tierClause}`,
    )
    .bind(...vals)
    .all();

  return results as Array<{ ambassador_id: string; friend_id: string; line_user_id: string }>;
}

export async function recordSurveyDelivery(
  db: D1Database,
  surveyId: string,
  ambassadorId: string,
  friendId: string,
): Promise<void> {
  const id = `sdl_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO ambassador_survey_deliveries (id, survey_id, ambassador_id, friend_id)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(id, surveyId, ambassadorId, friendId)
    .run();
}

export async function incrementSurveySentCount(
  db: D1Database,
  surveyId: string,
  count: number,
): Promise<void> {
  await db
    .prepare('UPDATE ambassador_surveys SET sent_count = sent_count + ?, updated_at = ? WHERE id = ?')
    .bind(count, jstNow(), surveyId)
    .run();
}

// --- Survey Responses ---

export async function submitSurveyResponse(
  db: D1Database,
  surveyId: string,
  ambassadorId: string,
  friendId: string,
  answers: Record<string, unknown>,
): Promise<{ id: string }> {
  const id = `srs_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const result = await db
    .prepare(
      `INSERT INTO ambassador_survey_responses (id, survey_id, ambassador_id, friend_id, answers)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(id, surveyId, ambassadorId, friendId, JSON.stringify(answers))
    .first<{ id: string }>();
  if (!result) throw new Error('submitSurveyResponse: INSERT returned null');

  // Mark delivery as responded
  await db
    .prepare(
      'UPDATE ambassador_survey_deliveries SET responded = 1 WHERE survey_id = ? AND ambassador_id = ?',
    )
    .bind(surveyId, ambassadorId)
    .run();

  // Increment response count
  await db
    .prepare('UPDATE ambassador_surveys SET response_count = response_count + 1, updated_at = ? WHERE id = ?')
    .bind(jstNow(), surveyId)
    .run();

  // Increment ambassador survey count
  await db
    .prepare('UPDATE ambassadors SET total_surveys_completed = total_surveys_completed + 1, updated_at = ? WHERE id = ?')
    .bind(jstNow(), ambassadorId)
    .run();

  return result;
}

export async function getSurveyResponses(
  db: D1Database,
  surveyId: string,
  limit = 50,
  offset = 0,
): Promise<{ responses: Array<{ id: string; ambassador_id: string; friend_id: string; answers: string; submitted_at: string; display_name?: string }>; total: number }> {
  const { total } = await db
    .prepare('SELECT COUNT(*) as total FROM ambassador_survey_responses WHERE survey_id = ?')
    .bind(surveyId)
    .first<{ total: number }>() ?? { total: 0 };

  const { results } = await db
    .prepare(
      `SELECT r.id, r.ambassador_id, r.friend_id, r.answers, r.submitted_at, f.display_name
       FROM ambassador_survey_responses r
       LEFT JOIN friends f ON f.id = r.friend_id
       WHERE r.survey_id = ?
       ORDER BY r.submitted_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(surveyId, limit, offset)
    .all();

  return { responses: results as Array<{ id: string; ambassador_id: string; friend_id: string; answers: string; submitted_at: string; display_name?: string }>, total };
}

export async function getSurveyStats(
  db: D1Database,
  surveyId: string,
): Promise<{ sent: number; responded: number; responseRate: number; avgRating: number | null }> {
  const survey = await db
    .prepare('SELECT sent_count, response_count FROM ambassador_surveys WHERE id = ?')
    .bind(surveyId)
    .first<{ sent_count: number; response_count: number }>();
  if (!survey) return { sent: 0, responded: 0, responseRate: 0, avgRating: null };

  // Calculate average of rating-type answers
  const { results } = await db
    .prepare('SELECT answers FROM ambassador_survey_responses WHERE survey_id = ?')
    .bind(surveyId)
    .all();

  let ratingSum = 0;
  let ratingCount = 0;
  for (const row of results) {
    try {
      const answers = JSON.parse(row.answers as string);
      for (const val of Object.values(answers)) {
        if (typeof val === 'number' && val >= 1 && val <= 5) {
          ratingSum += val;
          ratingCount++;
        }
      }
    } catch { /* skip */ }
  }

  return {
    sent: survey.sent_count,
    responded: survey.response_count,
    responseRate: survey.sent_count > 0 ? Math.round((survey.response_count / survey.sent_count) * 100) : 0,
    avgRating: ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
  };
}

// --- Ambassador pending surveys (for LIFF) ---

export async function getPendingSurveys(
  db: D1Database,
  ambassadorId: string,
): Promise<Array<{ id: string; title: string; description: string | null; survey_type: string; questions: string }>> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.title, s.description, s.survey_type, s.questions
       FROM ambassador_surveys s
       JOIN ambassador_survey_deliveries d ON d.survey_id = s.id
       WHERE d.ambassador_id = ?
       AND d.responded = 0
       AND s.status = 'active'
       ORDER BY d.delivered_at DESC`,
    )
    .bind(ambassadorId)
    .all();
  return results as Array<{ id: string; title: string; description: string | null; survey_type: string; questions: string }>;
}

// ===== Daily Tips =====

export async function getTodayTip(
  db: D1Database,
): Promise<{ id: string; tip_date: string; category: string; title: string; content: string; image_url: string | null } | null> {
  const today = jstNow().slice(0, 10);

  return db
    .prepare(`SELECT id, tip_date, category, title, content, image_url FROM daily_tips WHERE tip_date = ?`)
    .bind(today)
    .first();
}

export async function getDailyTips(
  db: D1Database,
  filters?: { limit?: number; offset?: number },
): Promise<{ tips: Array<Record<string, unknown>>; total: number }> {
  const countRow = await db
    .prepare(`SELECT COUNT(*) as cnt FROM daily_tips`)
    .first<{ cnt: number }>();

  const limit = filters?.limit ?? 30;
  const offset = filters?.offset ?? 0;

  const { results } = await db
    .prepare(`SELECT * FROM daily_tips ORDER BY tip_date DESC LIMIT ? OFFSET ?`)
    .bind(limit, offset)
    .all();

  return { tips: results as Array<Record<string, unknown>>, total: countRow?.cnt ?? 0 };
}

export async function createDailyTip(
  db: D1Database,
  data: {
    tipDate: string;
    category: string;
    title: string;
    content: string;
    imageUrl?: string;
    source?: string;
  },
): Promise<{ id: string; tip_date: string }> {
  const now = jstNow();

  const result = await db
    .prepare(
      `INSERT INTO daily_tips (tip_date, category, title, content, image_url, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, tip_date`,
    )
    .bind(
      data.tipDate,
      data.category,
      data.title,
      data.content,
      data.imageUrl ?? null,
      data.source ?? 'manual',
      now,
    )
    .first<{ id: string; tip_date: string }>();

  if (!result) throw new Error('createDailyTip: INSERT returned null');
  return result;
}

export async function updateDailyTip(
  db: D1Database,
  id: string,
  data: { category?: string; title?: string; content?: string; imageUrl?: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE daily_tips SET
       category = COALESCE(?, category),
       title = COALESCE(?, title),
       content = COALESCE(?, content),
       image_url = COALESCE(?, image_url)
       WHERE id = ?`,
    )
    .bind(data.category ?? null, data.title ?? null, data.content ?? null, data.imageUrl ?? null, id)
    .run();
}

export async function deleteDailyTip(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM daily_tips WHERE id = ?`).bind(id).run();
}
