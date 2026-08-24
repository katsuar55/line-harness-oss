/**
 * 紹介報酬 gate の ops (admin-ops.yml) のガード (2026-08-24)
 *
 * 採点ループの指摘: 紹介だけが「前提チェック付きの enable op」も「kill switch」も持たず、
 *   gate 投入と migration 068 の適用が個人端末の wrangler 頼みになっていた。
 *   同型の連携特典 (enable-link-reward) は台帳の存在確認を持ち、他の gate は disable op と対で
 *   用意されている。ここでは紹介 gate の op が**その水準を満たしていること**を固定する。
 *
 * CLAUDE.md「本番 gate の ops workflow ルール」に照らした観測点:
 *   - gate の ON/OFF 判定は**要素マーカー**で行う (CSS セレクタ文字列を使わない)
 *   - gate-off は**正マーカーとの AND** (5xx / 空応答を ✅ と誤読しない)
 *   - pipefail 下で `curl | grep` を書かない (一時ファイル経由)
 *   - 伝播はリトライで実測し、時間切れは exit 1
 *   - enable には対になる disable を同時に用意する
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// admin-ops.yml は CRLF。CR を落として LF に揃えてから照合する
// (行末を含むパターンが素通りしないように)。
const CR = String.fromCharCode(13);
const YML = fs
  .readFileSync(path.resolve(HERE, '../../../../.github/workflows/admin-ops.yml'), 'utf8')
  .split(CR)
  .join('');

/** `- name:` 単位で op ブロックを切り出す (前後の op を巻き込まずに検査するため) */
function opBlock(opName: string): string {
  const marker = `if: inputs.op == '${opName}'`;
  const at = YML.indexOf(marker);
  expect(at, `op ${opName} が admin-ops.yml に無い`).toBeGreaterThan(-1);
  const next = YML.indexOf('\n      - name:', at);
  return YML.slice(at, next === -1 ? YML.length : next);
}

describe('紹介 gate の op が選択肢に登録されている', () => {
  it.each(['apply-migration-068', 'enable-referral-reward', 'disable-referral-reward'])(
    '%s が options にある (登録漏れは UI から選べない)',
    (op) => {
      expect(YML).toContain(`          - ${op}\n`);
    },
  );
});

describe('apply-migration-068 は実在する migration を流す', () => {
  it('参照している SQL ファイルが実在する', () => {
    const block = opBlock('apply-migration-068');
    expect(block).toContain('068_line_referral_coupons.sql');
    expect(
      fs.existsSync(path.resolve(HERE, '../../../../packages/db/migrations/068_line_referral_coupons.sql')),
    ).toBe(true);
  });

  it('適用後にテーブルの存在を検証する', () => {
    expect(opBlock('apply-migration-068')).toContain("name='line_referral_coupons'");
  });
});

describe('enable-referral-reward の前提チェック', () => {
  const block = opBlock('enable-referral-reward');

  it('台帳 (068) が無ければ exit 1 する', () => {
    expect(block).toContain("name='line_referral_coupons'");
    expect(block).toContain('apply-migration-068 を先に実行してください');
  });

  it('順次活性化の queue (079) が無ければ exit 1 する', () => {
    // queue を裸で引く実装のため、無いと catch の「直接発行に退行」まで到達せず沈黙する
    expect(block).toContain("name='line_referral_coupon_queue'");
    expect(block).toContain('apply-migration-079 を先に実行してください');
  });

  it('secret は bulk (JSON) で投入する — PowerShell 由来の CR 混入を避ける', () => {
    expect(block).toContain('wrangler secret bulk');
    expect(block).toContain('"REFERRAL_REWARD_ENABLED":"true"');
  });
});

describe('gate の伝播を要素マーカーで実測する', () => {
  it.each(['enable-referral-reward', 'disable-referral-reward'])(
    '%s: curl を pipe で grep に渡さない (pipefail 下で match したときだけ落ちる罠)',
    (op) => {
      const block = opBlock(op);
      expect(block).toContain('-o "$HTML"');
      expect(block).not.toMatch(/curl[^\n]*\|\s*grep/);
    },
  );

  it('enable: gate ON を inline 定数の実値で照合する', () => {
    expect(opBlock('enable-referral-reward')).toContain("grep -q 'REFERRAL_REWARD_ON = true' \"$HTML\"");
  });

  it('disable: gate OFF は正マーカーとの AND で判定する (5xx を ✅ にしない)', () => {
    const block = opBlock('disable-referral-reward');
    expect(block).toContain('grep -q \'id="section-home"\' "$HTML"');
    expect(block).toContain("grep -q 'REFERRAL_REWARD_ON = false' \"$HTML\"");
  });

  it.each(['enable-referral-reward', 'disable-referral-reward'])(
    '%s: 伝播はリトライで待ち、時間切れなら exit 1 する',
    (op) => {
      const block = opBlock(op);
      expect(block).toContain('seq 1 12');
      expect(block).toContain('sleep 5');
      expect(block).toContain('exit 1');
    },
  );
});

describe('kill switch が対で存在する', () => {
  it('disable-referral-reward が false を投入する (redeploy 不要)', () => {
    expect(opBlock('disable-referral-reward')).toContain('"REFERRAL_REWARD_ENABLED":"false"');
  });

  it('🚨 enable は検証に失敗したら gate を false へ巻き戻してから落ちる (Codex P1)', () => {
    // secret 投入は成功しているので、ここで素直に exit すると「op は失敗表示なのに
    // 顧客向け文言と実クーポン発行だけが有効」という最悪の状態が残る。
    const block = opBlock('enable-referral-reward');
    const fail = block.slice(block.indexOf('if [ "$OK" -ne 1 ]'));
    expect(fail).toContain('"REFERRAL_REWARD_ENABLED":"false"');
    expect(fail).toContain('wrangler secret bulk');
    expect(fail.indexOf('"REFERRAL_REWARD_ENABLED":"false"')).toBeLessThan(fail.indexOf('exit 1'));
  });
});

describe('gate が切り替えるものが op の説明に書いてある', () => {
  it('enable の説明が「顧客向け文言も切り替わる」ことに触れている', () => {
    // この gate は実費 (クーポン発行) だけでなく LIFF / トークの文言も同時に変える。
    // op の実行者がそれを知らないと「文言だけ先に出た」事故に気付けない。
    const at = YML.indexOf("if: inputs.op == 'enable-referral-reward'");
    const preamble = YML.slice(Math.max(0, at - 800), at);
    expect(preamble).toContain('顧客向け文言も切り替える');
  });
});
