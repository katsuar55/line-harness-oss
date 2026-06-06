/**
 * account_link_codes 自動 cleanup (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 *
 * 目的:
 *   email OTP テーブル (account_link_codes、 migration 064) の古い行を定期削除する。
 *   主目的は **PII 最小化**: 本テーブルは受信者 email (本人入力) を保持するため、
 *   OTP が役目を終えた後 (= 失効・消費済) の email を長期保持しない。
 *   副次的に行数肥大も防ぐ (rate-limit で発行は抑制済だが念のため)。
 *
 * 設計方針 (= cron-cleanup.ts と同パターン):
 *   - **gating**: cron は 5 分毎なので JST 03:10-03:14 のウィンドウのみ trigger
 *     (= cron-cleanup の 03:00 とずらして同時実行の競合を避ける)。
 *     `ACCOUNT_LINK_CLEANUP_FORCE='true'` で bypass (テスト/手動)。
 *   - **retention 短め (default 1 日)**: OTP の TTL は 5 分なので、 1 日経過した行は確実に
 *     失効済 (= active code を誤削除しない)。 デバッグ/不正調査の猶予として 1 日残す。
 *   - **created_at < cutoff で削除**: TTL << retention のため created_at 基準で安全
 *     (= 1 日以上前に発行された code は consumed/expired を問わず全て役目終了)。
 *   - **idempotent / fail-safe**: DELETE は絶対条件、 何度実行しても同結果。 DB 失敗で throw しない。
 *   - **self-record**: `account-link-cleanup` も cron_run_logs に記録 (silent 監視)。
 *   - **本番未稼働時は no-op**: 機能 gate off の間は account_link_codes が空なので deletedRows=0。
 *
 * 関連: services/account-link.ts、 packages/db/migrations/064_account_link_codes.sql、
 *       services/cron-cleanup.ts (= 同パターンの参照実装)
 */

import { insertCronRunLog } from '@line-crm/db';

export interface AccountLinkCleanupEnv {
  DB: D1Database;
  /** 'true' で gating bypass */
  ACCOUNT_LINK_CLEANUP_FORCE?: string;
}

export interface AccountLinkCleanupOptions {
  /** 現在時刻 (テスト用 override) */
  now?: Date;
  /** 保持日数 (default 1 日) */
  retentionDays?: number;
}

export interface AccountLinkCleanupResult {
  triggered: boolean;
  /** DELETE された行数 */
  deletedRows: number;
}

export const ACCOUNT_LINK_CLEANUP_JOB_NAME = 'account-link-cleanup';
const TRIGGER_HOUR = 3;
const TRIGGER_MINUTE_FROM = 10;
const TRIGGER_MINUTE_TO_EXCLUSIVE = 15;
const DEFAULT_RETENTION_DAYS = 1;

export async function processAccountLinkCleanup(
  env: AccountLinkCleanupEnv,
  options: AccountLinkCleanupOptions = {},
): Promise<AccountLinkCleanupResult> {
  const now = options.now ?? new Date();
  const retention = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const force = env.ACCOUNT_LINK_CLEANUP_FORCE === 'true';

  if (!force && !isAccountLinkCleanupWindow(now)) {
    return { triggered: false, deletedRows: 0 };
  }

  const cutoffMs = now.getTime() - retention * 24 * 3600 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  let deletedRows = 0;
  try {
    // TTL (5分) << retention (1日) のため created_at 基準で active code を誤削除しない。
    const result = await env.DB.prepare(
      `DELETE FROM account_link_codes WHERE created_at < ?`,
    )
      .bind(cutoffIso)
      .run();
    deletedRows = result.meta?.changes ?? 0;
  } catch (err) {
    console.error(
      '[account-link-cleanup] DELETE failed',
      err instanceof Error ? err.name : 'unknown',
    );
    return { triggered: true, deletedRows: 0 };
  }

  // self-record (= cron-monitor で silent 検知できるよう success を記録)
  try {
    await insertCronRunLog(env.DB, {
      jobName: ACCOUNT_LINK_CLEANUP_JOB_NAME,
      status: 'success',
      metrics: { deletedRows, retentionDays: retention },
    });
  } catch (err) {
    console.error(
      '[account-link-cleanup] self-record failed',
      err instanceof Error ? err.name : 'unknown',
    );
  }

  return { triggered: true, deletedRows };
}

// ============================================================
// gating
// ============================================================

export function isAccountLinkCleanupWindow(now: Date): boolean {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return (
    jst.getUTCHours() === TRIGGER_HOUR &&
    jst.getUTCMinutes() >= TRIGGER_MINUTE_FROM &&
    jst.getUTCMinutes() < TRIGGER_MINUTE_TO_EXCLUSIVE
  );
}

// ============================================================
// テスト用エクスポート
// ============================================================

export const __test__ = {
  isAccountLinkCleanupWindow,
  TRIGGER_HOUR,
  TRIGGER_MINUTE_FROM,
  DEFAULT_RETENTION_DAYS,
};
