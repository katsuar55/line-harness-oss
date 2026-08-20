/**
 * Regression guard (2026-06-29 顧客導線監査 PR-A): LIFF データ取得の client/server
 * method 取り違えと、紹介カードのフィールド名/SQL 不一致を防ぐ静的検査。
 *
 * 実機検証で「その他」タブの通知設定・定期お届け一覧が永久スケルトン固着していた。
 * 原因は client の read loader が api()(=POST) を使い、server が GET/PUT-only(404) や
 * POST=CREATE(400) に当たって描画関数が走らなかったこと。read は apiGet()(GET) を使う。
 * 加えて紹介実績(totalReferred)とランキング SQL(referrer_friend_id) の名前不一致を固定。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const routes = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes');
const pages = readFileSync(join(routes, 'liff-pages.ts'), 'utf8');
const portal = readFileSync(join(routes, 'liff-portal.ts'), 'utf8');

describe('LIFF data-load 取り違え回帰ガード (監査 PR-A)', () => {
  it('通知設定 read は apiGet(GET) (server は GET/PUT-only、POST だと 404→永久スケルトン)', () => {
    expect(pages).toContain("apiGet('/api/liff/notification-prefs')");
    expect(pages).not.toMatch(/await api\('\/api\/liff\/notification-prefs'\)/);
  });

  it('定期お届け一覧 read は apiGet(GET) (POST だと CREATE handler に当たり 400→永久スケルトン)', () => {
    expect(pages).toContain("apiGet('/api/liff/subscriptions')");
    expect(pages).not.toMatch(/await api\('\/api\/liff\/subscriptions'\)/);
  });

  it('FAQ read は apiGet(GET) (server は GET-only)', () => {
    expect(pages).toContain("apiGet('/api/liff/faq')");
    expect(pages).not.toMatch(/await api\('\/api\/liff\/faq'\)/);
  });

  it('紹介実績は stats.totalReferred を読む (totalReferrals は API に存在せず実績行が常に非表示)', () => {
    expect(pages).toContain('stats.totalReferred');
    expect(pages).not.toContain('stats.totalReferrals');
  });

  it('紹介ランキング SQL は実在カラム referrer_friend_id を使う (referrer_id / reward_type は referral_rewards に無く 500)', () => {
    // SQL 実体は services/portal-read.ts readReferralRanking (PR-2 抽出) — ガードは実体を読む
    const portalRead = readFileSync(join(routes, '..', 'services', 'portal-read.ts'), 'utf8');
    expect(portalRead).toContain('JOIN friends f ON f.id = rr.referrer_friend_id');
    expect(portalRead).not.toContain('rr.referrer_id');
    expect(portalRead).not.toMatch(/rr\.reward_type/);
    // handler 側にも SQL の断片が復活していないこと (二重管理の drift 防止)
    expect(portal).not.toContain('rr.referrer_friend_id');
  });
});
