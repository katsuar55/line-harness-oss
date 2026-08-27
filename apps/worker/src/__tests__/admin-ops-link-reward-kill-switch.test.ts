/**
 * admin-ops.yml の kill switch と解除 op の存在検証 (2026-08-28)
 *
 * なぜ要るか:
 *   `enable-link-reward` はあるのに `disable-link-reward` が無く、¥300 クーポンが
 *   想定外に出ても**ワンクリックで止められない**状態だった (対になる disable を持つ機能は
 *   他にあるので、単純な作り忘れ)。手元ターミナルの wrangler は OAuth が切れることがあるため、
 *   「止め方が手打ちしかない」は運用リスクそのもの。
 *
 * 🚨 このテストの観測点は「op 名が選択肢にある」だけでは足りない。
 *    選択肢にあっても実装ステップが無ければ、実行しても**何も起きずに成功する**。
 *    選択肢と実装の両方を照合する。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let yml = '';

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  yml = readFileSync(join(here, '..', '..', '..', '..', '.github', 'workflows', 'admin-ops.yml'), 'utf8');
});

describe('admin-ops: 連携特典 ¥300 の kill switch', () => {
  it('disable-link-reward が op 選択肢にある', () => {
    expect(yml).toContain('- disable-link-reward');
  });

  it('🚨 選択肢だけでなく実装ステップも存在する (無いと実行しても何も起きずに成功する)', () => {
    expect(yml).toContain("if: inputs.op == 'disable-link-reward'");
    // gate は === 'true' の厳密一致なので 'false' で確実に止まる
    expect(yml).toContain('{"LINK_REWARD_ENABLED":"false"}');
  });

  it('enable と disable が対で存在する (片方だけの状態に戻さない)', () => {
    expect(yml).toContain("if: inputs.op == 'enable-link-reward'");
    expect(yml).toContain("if: inputs.op == 'disable-link-reward'");
  });
});

describe('admin-ops: アカウント連携の解除 op', () => {
  it('unlink-account が選択肢と実装の両方にある', () => {
    expect(yml).toContain('- unlink-account');
    expect(yml).toContain("if: inputs.op == 'unlink-account'");
  });

  it('friend_id 入力が定義されている', () => {
    expect(yml).toContain('friend_id:');
  });

  it('🚨 friend_id を case で全文検証する (grep は行単位なので改行入り入力が素通りする)', () => {
    const step = yml.slice(yml.indexOf("if: inputs.op == 'unlink-account'"));
    expect(step).toContain('case "$FID" in');
    // 検証を通らなかったら必ず落とす
    expect(step).toContain('exit 1');
  });

  it('🚨 PII を summary に出さない (repo は public = workflow ログは公開される)', () => {
    const step = yml.slice(
      yml.indexOf("if: inputs.op == 'unlink-account'"),
      yml.indexOf("if: inputs.op == 'unlink-account'") + 3000,
    );
    // 応答をそのまま summary へ echo していないこと
    expect(step).not.toMatch(/echo "\$RES" >> "\$GITHUB_STEP_SUMMARY"/);
    expect(step).not.toMatch(/tee -a "\$GITHUB_STEP_SUMMARY" <<< "\$RES"/);
  });

  it('¥300 台帳を残すことが運用者に伝わる (将来消す改修への警告)', () => {
    expect(yml).toContain('連携特典 ¥300 の台帳は意図的に残しています');
  });
});
