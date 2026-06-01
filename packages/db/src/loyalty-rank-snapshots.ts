/**
 * Loyalty rank snapshots DB (= 自社内製ロイヤリティ 月次再判定, 2026-06-01, PR2)
 *
 * 月次 cron が friend ごとに「その月の official rank」 を記録する table の CRUD。
 * trailing-12ヶ月 rank を月次スナップショットとして固定し、 前月比 (direction) を保持。
 *
 * 設計:
 *   - friend × period (YYYY-MM) で 1 行 (= UNIQUE、 ON CONFLICT で同月冪等)
 *   - direction = initial|up|down|same (= 降格 down は PR8 通知の基盤)
 *   - 表示用の live rank は loyalty-rank.ts resolveFriendRank で別途算出
 *
 * 関連: migration 061、 apps/worker/src/services/loyalty-rank-cron.ts。
 */
import { jstNow } from './utils.js';

export type RankDirection = 'initial' | 'up' | 'down' | 'same';

export interface RankSnapshotRow {
  id: string;
  friend_id: string;
  period: string;
  rank_id: string;
  trailing_12mo_jpy: number;
  prev_rank_id: string | null;
  direction: string;
  brand_id: string | null;
  evaluated_at: string;
  created_at: string;
}

export interface RankSnapshot {
  id: string;
  friendId: string;
  period: string;
  rankId: string;
  trailing12moJpy: number;
  prevRankId: string | null;
  direction: RankDirection;
  brandId: string | null;
  evaluatedAt: string;
}

function normalizeDirection(value: string): RankDirection {
  return value === 'up' || value === 'down' || value === 'same' || value === 'initial'
    ? value
    : 'initial';
}

export function rowToRankSnapshot(row: RankSnapshotRow): RankSnapshot {
  return {
    id: row.id,
    friendId: row.friend_id,
    period: row.period,
    rankId: row.rank_id,
    trailing12moJpy: row.trailing_12mo_jpy,
    prevRankId: row.prev_rank_id,
    direction: normalizeDirection(row.direction),
    brandId: row.brand_id,
    evaluatedAt: row.evaluated_at,
  };
}

/** friend の最新 snapshot (= evaluated_at 降順 1 件)。 マイランク表示 / cron の前回 rank に使う。 */
export async function getLatestRankSnapshot(
  db: D1Database,
  friendId: string,
): Promise<RankSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT * FROM loyalty_rank_snapshots
        WHERE friend_id = ?
        ORDER BY evaluated_at DESC
        LIMIT 1`,
    )
    .bind(friendId)
    .first<RankSnapshotRow>();
  return row ? rowToRankSnapshot(row) : null;
}

/** friend × period の snapshot を取得 (= 同月既存チェック)。 */
export async function getRankSnapshotForPeriod(
  db: D1Database,
  friendId: string,
  period: string,
): Promise<RankSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT * FROM loyalty_rank_snapshots WHERE friend_id = ? AND period = ?`,
    )
    .bind(friendId, period)
    .first<RankSnapshotRow>();
  return row ? rowToRankSnapshot(row) : null;
}

/**
 * friend の「指定 period より前」 の最新 snapshot (= 前月 rank、 昇格/降格判定の比較対象)。
 * 同 period の rerun でも自分自身を prev にしないため、 period < ? で絞る。
 */
export async function getPreviousRankSnapshot(
  db: D1Database,
  friendId: string,
  period: string,
): Promise<RankSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT * FROM loyalty_rank_snapshots
        WHERE friend_id = ? AND period < ?
        ORDER BY period DESC, evaluated_at DESC
        LIMIT 1`,
    )
    .bind(friendId, period)
    .first<RankSnapshotRow>();
  return row ? rowToRankSnapshot(row) : null;
}

export interface RecordRankSnapshotInput {
  friendId: string;
  period: string;
  rankId: string;
  trailing12moJpy: number;
  prevRankId?: string | null;
  direction: RankDirection;
  brandId?: string | null;
  evaluatedAt?: string;
}

/**
 * snapshot を記録 (= 同月冪等: UNIQUE(friend_id, period) に ON CONFLICT で上書き)。
 * 月次 cron が同月に複数回走っても 1 行に収束する。
 */
export async function recordRankSnapshot(
  db: D1Database,
  input: RecordRankSnapshotInput,
): Promise<{ written: boolean }> {
  const now = input.evaluatedAt ?? jstNow();
  const trailing = Math.max(
    0,
    Math.floor(Number.isFinite(input.trailing12moJpy) ? input.trailing12moJpy : 0),
  );
  await db
    .prepare(
      `INSERT INTO loyalty_rank_snapshots (
         id, friend_id, period, rank_id, trailing_12mo_jpy,
         prev_rank_id, direction, brand_id, evaluated_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(friend_id, period) DO UPDATE SET
         rank_id           = excluded.rank_id,
         trailing_12mo_jpy = excluded.trailing_12mo_jpy,
         prev_rank_id      = excluded.prev_rank_id,
         direction         = excluded.direction,
         evaluated_at      = excluded.evaluated_at`,
    )
    .bind(
      crypto.randomUUID(),
      input.friendId,
      input.period,
      input.rankId,
      trailing,
      input.prevRankId ?? null,
      input.direction,
      input.brandId ?? null,
      now,
      now,
    )
    .run();
  return { written: true };
}

/** period 内の direction='down' (= 降格) snapshot 一覧 (= PR8 降格通知の基盤)。 */
export async function listDemotionsForPeriod(
  db: D1Database,
  period: string,
  limit = 500,
): Promise<RankSnapshot[]> {
  const result = await db
    .prepare(
      `SELECT * FROM loyalty_rank_snapshots
        WHERE period = ? AND direction = 'down'
        ORDER BY evaluated_at DESC
        LIMIT ?`,
    )
    .bind(period, limit)
    .all<RankSnapshotRow>();
  return (result.results ?? []).map(rowToRankSnapshot);
}
