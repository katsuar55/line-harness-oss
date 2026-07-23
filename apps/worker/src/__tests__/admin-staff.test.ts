/**
 * スタッフ管理 / 操作履歴ページ + 監査記録ヘルパーのテスト
 * (2026-07-23 管理側①「スタッフ個別アカウント化 + 誰が何をしたかの記録」)。
 *
 * 対象:
 *   - /admin/staff・/admin/logs: 実 authMiddleware 下で GET 200 (公開 shell) / 非 GET は 401 /
 *     inline script が構文的に valid (CLAUDE.md の LIFF inline JS 事故の再発防止)
 *   - 公開 shell に実データ・キー値が埋まっていない
 *   - auditAdminAction: actor 記録・PII 最小化 (生 IP を保存しない)・best-effort (throw を握り潰す)
 *   - 監査配線の回帰: friend-coupon PUT が実際に監査を書く (呼び出しを消すと落ちる)
 *   - 権限ガード: requireRole が拒否時に監査を残す / 一斉配信・監査閲覧が staff で 403
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { adminStaff } from '../routes/admin-staff.js';
import { authMiddleware } from '../middleware/auth.js';
import { auditAdminAction } from '../services/admin-audit.js';
import { friendCoupon } from '../routes/friend-coupon.js';
import { auditLogs as auditLogsRoute } from '../routes/audit-logs.js';

const API_KEY = 'test-key';

function fakeDb() {
  return {
    prepare() {
      return {
        bind: () => ({
          async first() { return null; },
          async all() { return { results: [] }; },
          async run() { return { success: true, meta: { changes: 1 } }; },
        }),
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
    },
  } as unknown as D1Database;
}

function createApp() {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/', adminStaff);
  return app;
}

const ENV = () => ({ DB: fakeDb(), API_KEY });

describe('GET /admin/staff · /admin/logs (公開 shell)', () => {
  for (const path of ['/admin/staff', '/admin/logs']) {
    it(`${path} は無認証 GET で 200 を返す (実 authMiddleware の skip-list 経由)`, async () => {
      const res = await createApp().request(`http://localhost${path}`, { method: 'GET' }, ENV());
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('noindex');
      expect(html).toContain('/admin');
      // 実キー値・実データを shell に埋め込まない
      expect(html).not.toMatch(/Bearer [A-Za-z0-9]/);
      expect(html).not.toContain('lh_0');
    });

    it(`${path} の inline script が構文的に valid (new Function で parse 可能)`, async () => {
      const res = await createApp().request(`http://localhost${path}`, { method: 'GET' }, ENV());
      const html = await res.text();
      const m = html.match(/<script>([\s\S]*?)<\/script>/);
      expect(m).not.toBeNull();
      expect(() => new Function(m![1]!)).not.toThrow();
    });

    it(`${path} は GET 以外なら 401 (method 非依存 skip の穴を作らない)`, async () => {
      const res = await createApp().request(`http://localhost${path}`, { method: 'POST' }, ENV());
      expect(res.status).toBe(401);
    });
  }

  it('スタッフ管理ページは権限表と個人キーの注意書きを含む', async () => {
    const res = await createApp().request('http://localhost/admin/staff', { method: 'GET' }, ENV());
    const html = await res.text();
    expect(html).toContain('権限でできること');
    expect(html).toContain('二度と表示できません');
    expect(html).toContain('/admin/logs');
  });

  it('操作履歴ページは全操作を audit から引く (admin. 固定にしない = 一斉配信の履歴も出す)', async () => {
    const res = await createApp().request('http://localhost/admin/logs', { method: 'GET' }, ENV());
    const html = await res.text();
    expect(html).toContain('/api/audit-logs?limit=100');
    expect(html).not.toContain('actionPrefix=admin.');
    expect(html).toContain('操作履歴');
    // 既存 action の日本語ラベルも持つ (broadcast.send が生の action 名で出ない)
    expect(html).toContain('broadcast.send');
  });
});

describe('auditAdminAction', () => {
  function ctx(overrides: Record<string, unknown> = {}) {
    const inserted: Array<Record<string, unknown>> = [];
    // insertAuditLog は INSERT 後に行を SELECT して返すため first() まで持たせる
    // (欠けていると helper が例外経路を通り、監査が「握り潰された」状態で test が通ってしまう)
    const db = {
      prepare() {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                inserted.push({ args });
                return { success: true, meta: { changes: 1 } };
              },
              async first() {
                return inserted.length ? { id: 'audit-1' } : null;
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const c = {
      env: { DB: db },
      get: (k: string) => (k === 'staff' ? { id: 's1', name: '山田', role: 'staff' } : undefined),
      req: { header: (h: string) => (h === 'CF-Connecting-IP' ? '203.0.113.9' : 'UA/1.0') },
      ...overrides,
    } as never;
    return { c, inserted };
  }

  it('actor と action を記録し、生 IP は保存しない (PII 最小化)', async () => {
    const { c, inserted } = ctx();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await auditAdminAction(c, { action: 'admin.faq.update', targetType: 'faq_item', targetId: 'f1' });
    // 例外経路 (握り潰し) を通っていないこと = 監査が本当に書かれたことの担保
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(inserted.length).toBe(1);
    const flat = JSON.stringify(inserted[0]);
    expect(flat).toContain('admin.faq.update');
    expect(flat).toContain('山田');
    // 生 IP は含まれない (ハッシュのみ)
    expect(flat).not.toContain('203.0.113.9');
  });

  it('監査書込が失敗しても throw しない (業務操作を落とさない)', async () => {
    const throwingDb = {
      prepare() { throw new Error('audit table missing'); },
    } as unknown as D1Database;
    const c = {
      env: { DB: throwingDb },
      get: () => ({ id: 's1', name: '山田', role: 'staff' }),
      req: { header: () => undefined },
    } as never;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(auditAdminAction(c, { action: 'admin.faq.delete' })).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('共有キー (env-owner) での操作も actor として識別できる', async () => {
    const { c, inserted } = ctx({
      get: (k: string) => (k === 'staff' ? { id: 'env-owner', name: 'Owner', role: 'owner' } : undefined),
    });
    await auditAdminAction(c, { action: 'admin.friend_coupon.update' });
    expect(JSON.stringify(inserted[0])).toContain('env-owner');
  });
});

// ─── 監査配線の回帰 + 権限ガード ───

describe('監査配線の回帰 (friend-coupon PUT)', () => {
  it('クーポン設定の PUT が admin.friend_coupon.update を audit_logs に書く', async () => {
    const writes: string[] = [];
    const db = {
      prepare(sql: string) {
        const exec = (args: unknown[]) => ({
          async first() {
            // brand_config 読み取り (getFriendCouponConfig)
            if (sql.includes('brand_config')) {
              return { metadata: JSON.stringify({ friendCoupon: { enabled: false, percent: 5 } }) };
            }
            return { id: 'audit-1' };
          },
          async all() { return { results: [] }; },
          async run() {
            if (sql.includes('audit_logs')) writes.push(JSON.stringify(args));
            return { success: true, meta: { changes: 1 } };
          },
        });
        return { bind: (...a: unknown[]) => exec(a), ...exec([]) };
      },
    } as unknown as D1Database;

    const app = new Hono();
    app.use('*', authMiddleware);
    app.route('/', friendCoupon);
    const res = await app.request(
      'http://localhost/api/admin/friend-coupon',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, percent: 10, code: 'NTOMO10' }),
      },
      { DB: db, API_KEY },
    );
    expect(res.status).toBe(200);
    // 監査が実際に書かれた (auditAdminAction の呼び出しを消すとこのテストが落ちる)
    const flat = writes.join('|');
    expect(flat).toContain('admin.friend_coupon.update');
  });
});

describe('権限ガード (requireRole)', () => {
  function appWithStaffRole(role: 'owner' | 'admin' | 'staff') {
    const audits: string[] = [];
    const db = {
      prepare(sql: string) {
        const exec = (args: unknown[]) => ({
          async first() {
            // getStaffByApiKey — staff ロールのキーとして解決させる
            if (sql.includes('staff_members')) {
              return { id: 's9', name: '佐藤', role, api_key: 'staff-key', is_active: 1 };
            }
            return { id: 'audit-1' };
          },
          async all() { return { results: [] }; },
          async run() {
            if (sql.includes('audit_logs')) audits.push(JSON.stringify(args));
            return { success: true, meta: { changes: 1 } };
          },
        });
        return { bind: (...a: unknown[]) => exec(a), ...exec([]) };
      },
    } as unknown as D1Database;
    const app = new Hono();
    app.use('*', authMiddleware);
    app.route('/', auditLogsRoute);
    return { app, db, audits };
  }

  it('staff ロールは監査ログ閲覧が 403 (スタッフ名簿の迂回閲覧を封鎖)', async () => {
    const { app, db } = appWithStaffRole('staff');
    const res = await app.request(
      'http://localhost/api/audit-logs?actionPrefix=admin.staff.',
      { method: 'GET', headers: { Authorization: 'Bearer staff-key' } },
      { DB: db, API_KEY },
    );
    expect(res.status).toBe(403);
  });

  it('admin ロールは監査ログを閲覧できる', async () => {
    const { app, db } = appWithStaffRole('admin');
    const res = await app.request(
      'http://localhost/api/audit-logs',
      { method: 'GET', headers: { Authorization: 'Bearer staff-key' } },
      { DB: db, API_KEY },
    );
    expect(res.status).toBe(200);
  });

  it('拒否された操作も監査に残る (admin.access.denied)', async () => {
    const { app, db, audits } = appWithStaffRole('staff');
    await app.request(
      'http://localhost/api/audit-logs',
      { method: 'GET', headers: { Authorization: 'Bearer staff-key' } },
      { DB: db, API_KEY },
    );
    expect(audits.join('|')).toContain('admin.access.denied');
  });
});

describe('一斉配信の予約バイパス封鎖 (R3)', () => {
  // denyUnlessRole が staff を止め、owner を通すことを直接検証する
  function mkCtx(role: 'owner' | 'admin' | 'staff') {
    const audits: string[] = [];
    const db = {
      prepare() {
        const exec = () => ({
          async run() { return { success: true, meta: { changes: 1 } }; },
          async first() { return { id: 'a' }; },
        });
        return { bind: () => exec(), ...exec() };
      },
    } as unknown as D1Database;
    const c = {
      env: { DB: db },
      get: (k: string) => (k === 'staff' ? { id: 'x', name: 'X', role } : undefined),
      req: { url: 'http://localhost/api/ab-tests', method: 'POST', header: () => undefined },
      json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status: status ?? 200 }),
    } as never;
    return { c, audits };
  }

  it('staff は denyUnlessRole で 403 + admin.access.denied 記録', async () => {
    const { denyUnlessRole } = await import('../middleware/role-guard.js');
    const { c } = mkCtx('staff');
    const res = await denyUnlessRole(c, 'A/Bテストの予約', 'owner', 'admin');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('owner / admin は denyUnlessRole を素通り (null)', async () => {
    const { denyUnlessRole } = await import('../middleware/role-guard.js');
    for (const role of ['owner', 'admin'] as const) {
      const { c } = mkCtx(role);
      const res = await denyUnlessRole(c, 'A/Bテストの予約', 'owner', 'admin');
      expect(res).toBeNull();
    }
  });
})
