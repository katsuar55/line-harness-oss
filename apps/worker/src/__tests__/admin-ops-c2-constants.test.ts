/**
 * Admin Ops (admin-ops.yml) とコード定数の drift 検出 (C2)
 *
 * `reminder-dry-run` の SQL は `listContractsDueForReminder` の述語を **SQL で手書き複製**
 * している。片方だけ変えると「dry-run は 5 件と言うのに実際は 0 件送る」ような静かな嘘になり、
 * gate を開ける判断そのものが誤る。yml をパースして数値が一致することを CI で固定する。
 *
 * 文字列 contains だけでは「複製が消えた」ことは検出できるが「値がズレた」ことは
 * 検出できないため、**yml から実際に数値を抽出してコード定数と比較**する。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOW_MEASUREMENT_FRESH_DAYS } from '@line-crm/db';
import { BILLING_DEADLINE_LEAD_DAYS } from '../services/subscription-concierge.js';

// `new URL(...)` を fileURLToPath に渡すと、Workers types と node types が混在する
// この worker の tsconfig で URL 型が衝突する (ローカルは通り CI の clean build で落ちる)。
// string を受ける形にすれば型解決に依存しない
const HERE = dirname(fileURLToPath(import.meta.url));
const YML_PATH = resolve(HERE, '../../../../.github/workflows/admin-ops.yml');
const yml = readFileSync(YML_PATH, 'utf8');

/** リマインド窓の上限 (subscription-billing-reminder.ts の LEAD_DAYS_MAX と同値であること) */
const LEAD_DAYS_MAX_EXPECTED = 7;

describe('admin-ops.yml と C2 定数の一致', () => {
  it('鮮度述語の日数が FLOW_MEASUREMENT_FRESH_DAYS と一致する', () => {
    // datetime('now','+9 hours','-N day') の N を全て集める
    const found = [...yml.matchAll(/datetime\('now','\+9 hours','-(\d+) day'\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(found.length).toBeGreaterThan(0); // 述語ごと消えた場合も fail させる
    for (const days of found) {
      expect(days).toBe(FLOW_MEASUREMENT_FRESH_DAYS);
    }
  });

  it('窓の下限が締切リード日数 (BILLING_DEADLINE_LEAD_DAYS) と一致する', () => {
    // 下限は `next_billing_estimate >= date(today,'+N day')` の形でしか現れない
    // (分布クエリの `> +7 day` / `<= +30 day` は上限側なので混ざらない)
    const lower = [...yml.matchAll(/next_billing_estimate >= date\(t\.today, ?'\+(\d+) day'\)/g)]
      .map((m) => Number(m[1]));
    expect(lower.length).toBeGreaterThan(0);
    for (const days of lower) expect(days).toBe(BILLING_DEADLINE_LEAD_DAYS);
  });

  it('窓の上限が LEAD_DAYS_MAX と一致する', () => {
    // 分布クエリは同じ上限 (`<= +7 day`) を窓の判定に使い、d8_30 だけ `+30 day` を使う。
    // 窓の上限が変わったら「窓 = +7」の記述が消えるので、その存在で drift を検出する
    expect(yml).toContain(`next_billing_estimate <= date(t.today,'+${LEAD_DAYS_MAX_EXPECTED} day')`);
  });

  it('dry-run / gate 判定の述語が実装と同じ列名を使っている', () => {
    for (const predicate of [
      "estimate_source = 'flow'",
      'flow_measured_at IS NOT NULL',
      'flow_measured_at >=',
      'crit1_linked_over_30',
      'crit2_measured_majority',
      'crit3_ingest_alive_72h',
    ]) {
      expect(yml).toContain(predicate);
    }
  });
});

describe('admin-ops.yml の入力検証 (SQL へ埋め込む値)', () => {
  // 🚨 grep は**行単位**で評価するため、改行を含む入力は 1 行目さえ通れば素通りする。
  // `--command` は `;` 区切りの複数文を実行するので、読み取り専用 op に書込が混入しうる。
  // case (文字列全体のパターンマッチ) で検証していることを構造的に固定する。
  it('SQL へ埋める入力を grep で検証していない (行単位の穴を再導入しない)', () => {
    const grepValidations = [...yml.matchAll(/grep -Eq '\^[^']*\$'/g)].map((m) => m[0]);
    expect(grepValidations).toEqual([]);
  });

  it('contract_id / contract_gid を case で全文検証している', () => {
    expect(yml).toContain('case "$CID" in');
    expect(yml).toContain("''|*[!A-Za-z0-9_-]*)");
    expect(yml).toContain('case "$GID_NUM" in');
    expect(yml).toContain("''|*[!0-9]*)");
  });
});
