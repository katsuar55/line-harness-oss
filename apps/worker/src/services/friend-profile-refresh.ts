/**
 * friends の LINE プロフィール一括補完 — 第2波-③ 支援 (2026-07-02)
 *
 * 背景:
 *   カットオーバーのフォロワー一括 import (getFollowerIds) は LINE userId **のみ** を返すため、
 *   imported 6,583 friends の display_name / picture_url / status_message は全て NULL だった
 *   (本番実測: GET /api/friends の全 sample が displayName:null、 表示名検索 0 件)。
 *   これにより (1) DMM ランク引き継ぎの表示名照合が全滅、 (2) 管理画面チャット/friend 一覧が
 *   無名、 の 2 つが起きている。 LINE Messaging API GET /v2/bot/profile/{userId} で補完する。
 *
 * 設計:
 *   - 対象: is_following=1 かつ display_name 未設定 かつ 過去に永続失敗マークが無い friend。
 *   - 永続失敗 (404/403 = ブロック/退会等) は friends.metadata.profile_refresh_failed_at に
 *     マークして次回選定から除外 (= auto ループが収束する。 backfill-linked と同じ設計判断)。
 *   - 一時失敗 (429/5xx/network) はマークせず選定に残す (= 次回 retry)。 remaining が
 *     減らない場合は呼び出し側が停止判断する。
 *   - D1 書込は db.batch() に集約 (= バッチ全体で subrequest 1 消費。 LINE profile fetch が
 *     friend ごとに 1 subrequest 使うため、 D1 側で浪費しない)。
 *   - upsertFriend は使わない (is_following=1 を強制するため、 unfollow webhook との race で
 *     ブロック済み friend を following に戻し得る)。 profile 3 列 + updated_at のみ UPDATE。
 *
 * 関連:
 *   - apps/worker/src/routes/friends-profile-admin.ts (= POST /api/admin/friends/refresh-profiles)
 *   - apps/worker/src/routes/webhook.ts follow handler (= 新規 follow は従来どおり都度取得)
 *   - apps/worker/src/services/dmm-rank-import.ts (= 補完後に表示名照合が機能する)
 */

import { jstNow } from '@line-crm/db';

/** LINE profile API の応答 subset (line-sdk UserProfile 互換) */
export interface LineProfileLike {
  displayName?: string;
  pictureUrl?: string;
  statusMessage?: string;
}

export interface ProfileRefreshDeps {
  /** userId → profile。 throw 時は err.status (HTTP status) を見て永続/一時を分類 */
  getProfileImpl: (userId: string) => Promise<LineProfileLike>;
}

export interface ProfileRefreshResult {
  /** 今回選定した friend 数 */
  selected: number;
  /** display_name を補完できた数 */
  updated: number;
  /** 永続失敗 (404/403/空プロフィール) としてマークした数 */
  failed: number;
  /** 一時失敗 (retry 対象のまま) の数 */
  transientErrors: number;
  /**
   * 呼び出し全体を中断した原因 ('400'|'401'|'429'|'timeout')。
   * 401/400 = token 異常 (全 friend が失敗確定)、 429 = rate limit、 timeout = hang。
   * これを返した呼び出しは進捗しない — 呼び出し側のループは即停止して原因調査すること
   * (review MEDIUM: 旧実装は 401 でも 200/updated:0 を返し続け、 loop が収束しなかった)。
   */
  aborted?: string;
  /** 処理後の未補完残数 (再 COUNT の正確値) */
  remaining: number;
}

interface PendingFriendRow {
  id: string;
  line_user_id: string;
}

/**
 * 未補完 friend の選定述語。 (test で本文 pinning — 変更時は friend-profile-refresh.test.ts も更新)
 * - 失敗マーク除外が無いと、 ブロック済み friend が毎回再選択され auto ループが収束しない。
 * - ⚠️ 失敗マークは friends.metadata でなく **audit_logs** に置く: 本番 smoke (2026-07-02) で
 *   本番 friends テーブルに metadata 列が存在しない (schema.sql との drift、
 *   D1_ERROR: no such column: metadata) ことが判明したため。 audit ベースの除外は
 *   backfill-linked (routes/account-link-admin.ts) と同じ確立済みパターン。
 * - 既知の制約: line_account_id 非スコープ + route は単一 env token。 第2アカウント追加時は
 *   アカウント別 token 解決を実装してから使うこと (review LOW、 dmm-rank-import と同じ制約)。
 * - 永続マークは re-follow でも自動クリアされないが、 re-follow 時は webhook follow handler が
 *   都度 profile を取得するため実害は限定的 (review LOW)。
 */
export const FRIEND_PROFILE_PENDING_PREDICATE = `
  FROM friends f
 WHERE f.is_following = 1
   AND f.line_user_id IS NOT NULL AND f.line_user_id != ''
   AND (f.display_name IS NULL OR f.display_name = '')
   AND NOT EXISTS (
     SELECT 1 FROM audit_logs a
      WHERE a.action = 'friend_profile_refresh.failed'
        AND a.target_type = 'friend' AND a.target_id = f.id
   )`;

function markFailedStmt(
  db: D1Database,
  friendId: string,
  now: string,
  status: number | 'empty_profile',
): D1PreparedStatement {
  // friends.metadata が本番に無いため audit_logs を永続マークとして使う (append-only・確実に存在)。
  // insertAuditLog は insert+readback の 2 query なので、 batch 用に直接 INSERT 1 本にする。
  return db
    .prepare(
      `INSERT INTO audit_logs (id, actor_type, action, target_type, target_id, result, metadata, created_at)
       VALUES (?, 'api', 'friend_profile_refresh.failed', 'friend', ?, 'failure', ?, ?)`,
    )
    .bind(crypto.randomUUID(), friendId, JSON.stringify({ status: String(status) }), now);
}

/** hang した fetch で admin 呼び出し全体が固まるのを防ぐ (review LOW、 #123 timeout 方針と整合) */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(Object.assign(new Error(`profile fetch timeout after ${ms}ms`), { timeout: true })),
      ms,
    );
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e: unknown) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * display_name 未設定の friend を limit 件選び、 LINE profile を取得して補完する。
 * 戻り値の remaining が 0 になるまで繰り返し呼ぶ運用 (1 呼び出しの上限は route 側で制御)。
 */
export async function refreshMissingFriendProfiles(
  db: D1Database,
  deps: ProfileRefreshDeps,
  opts: { limit: number; fetchTimeoutMs?: number },
): Promise<ProfileRefreshResult> {
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 8_000;
  const res = await db
    .prepare(`SELECT f.id, f.line_user_id ${FRIEND_PROFILE_PENDING_PREDICATE} ORDER BY f.created_at ASC LIMIT ?`)
    .bind(opts.limit)
    .all<PendingFriendRow>();
  const targets = res.results ?? [];

  const now = jstNow();
  const stmts: D1PreparedStatement[] = [];
  let updated = 0;
  let failed = 0;
  let transientErrors = 0;
  let aborted: string | undefined;

  for (const t of targets) {
    try {
      const profile = await withTimeout(deps.getProfileImpl(t.line_user_id), fetchTimeoutMs);
      const name = (profile.displayName ?? '').trim();
      if (name) {
        stmts.push(
          db
            .prepare(
              `UPDATE friends
                  SET display_name = ?, picture_url = ?, status_message = ?, updated_at = ?
                WHERE id = ?`,
            )
            .bind(name, profile.pictureUrl ?? null, profile.statusMessage ?? null, now, t.id),
        );
        updated += 1;
      } else {
        // 200 だが表示名が空 (異常系)。 再選択し続けないよう永続マーク
        stmts.push(markFailedStmt(db, t.id, now, 'empty_profile'));
        failed += 1;
      }
    } catch (err) {
      const status = (err as { status?: number }).status;
      const isTimeout = (err as { timeout?: boolean }).timeout === true;
      if (status === 404 || status === 403) {
        // ブロック/退会/権限なし = 再試行しても変わらない → マークして選定から除外
        stmts.push(markFailedStmt(db, t.id, now, status));
        failed += 1;
      } else if (status === 400 || status === 401 || status === 429 || isTimeout) {
        // token 異常 (400/401) は以降の全 fetch が失敗確定、 429 は rate limit へ追い打ち禁止、
        // timeout は hang の兆候 → この呼び出しを即中断して aborted を返す (review MEDIUM)
        transientErrors += 1;
        aborted = isTimeout ? 'timeout' : String(status);
        console.error(`[friend-profile-refresh] aborting call: ${aborted}`);
        break;
      } else {
        // 5xx/network = 一時失敗。 マークせず次回 retry (PII: userId は log しない)
        transientErrors += 1;
        console.error(
          '[friend-profile-refresh] transient profile fetch failure:',
          err instanceof Error ? err.message : 'unknown error',
        );
      }
    }
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
  }

  const afterRow = await db
    .prepare(`SELECT COUNT(*) AS n ${FRIEND_PROFILE_PENDING_PREDICATE}`)
    .first<{ n: number }>();

  return {
    selected: targets.length,
    updated,
    failed,
    transientErrors,
    ...(aborted ? { aborted } : {}),
    remaining: afterRow?.n ?? 0,
  };
}
