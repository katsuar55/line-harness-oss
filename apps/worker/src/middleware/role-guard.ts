import type { Context, Next } from 'hono';
import type { Env } from '../index.js';
import { auditAdminAction } from '../services/admin-audit.js';

type Role = 'owner' | 'admin' | 'staff';

/**
 * ハンドラ内で条件付きに権限を要求する (middleware では表現できないケース用)。
 * 例: broadcast の作成/更新自体は staff でも許すが、**予約送信 (scheduledAt) を伴う場合だけ**
 * owner/admin を要求する — cron が拾って実送信するため、実質「一斉配信の実行」だから
 * (2026-07-23 採点 R2 HIGH: /send にだけガードを付けても scheduledAt で迂回できた)。
 * 拒否時は 403 Response を返す (呼び出し側でそのまま return する)。許可なら null。
 */
export async function denyUnlessRole(
  c: Context<Env>,
  reason: string,
  ...allowed: Role[]
): Promise<Response | null> {
  const staff = c.get('staff');
  if (staff && allowed.includes(staff.role)) return null;
  await auditAdminAction(c, {
    action: 'admin.access.denied',
    targetType: 'endpoint',
    targetId: new URL(c.req.url).pathname,
    result: 'failure',
    errorMessage: `${reason}: required=${allowed.join('|')} actual=${staff?.role ?? 'none'}`,
    metadata: { method: c.req.method, reason },
  });
  return c.json({ success: false, error: `${reason}には${allowed[0]}権限が必要です` }, 403);
}

export function requireRole(...allowed: Role[]) {
  return async (c: Context<Env>, next: Next): Promise<Response | void> => {
    const staff = c.get('staff');
    if (!staff || !allowed.includes(staff.role)) {
      // 拒否された操作も監査に残す (採点 MEDIUM: 失敗が記録されないと
      // 「権限のない人が何を触ろうとしたか」が事後に分からない)。best-effort。
      await auditAdminAction(c, {
        action: 'admin.access.denied',
        targetType: 'endpoint',
        targetId: new URL(c.req.url).pathname,
        result: 'failure',
        errorMessage: `required=${allowed.join('|')} actual=${staff?.role ?? 'none'}`,
        metadata: { method: c.req.method },
      });
      return c.json(
        { success: false, error: `この操作には${allowed[0]}権限が必要です` },
        403,
      );
    }
    return next();
  };
}
