-- Migration 076: sub_intents テーブル (= サブスク受理レイヤーの台帳、 §10-3、 2026-08-06)
--
-- 目的 (docs/SUBSCRIPTION_UX_TAP_MINIMAL_2026-07-25.md §1):
--   顧客のタップ = 「意思の受理」であって「実行」ではない。受理 (INSERT) と実行 (executor 分岐) を
--   分離し、完了 or 正直な失敗を必ず通知する。移行前の実行者は executor='human'
--   (スタッフが Huckleberry 管理画面で代行。代行可否は 2026-08-05 K4 で実機確定済み)。
--
-- state 機械 (9 state、遷移は services/sub-intents.ts が CAS で強制):
--   received         受理済み・未着手 (sweep の対象)
--   executing        スタッフ/機械が claim 済み (claimed_at 保持)。human は自動解放しない (§1-2)
--   done             実行完了 (CAS 勝者のみが宣言できる = false-success を型で防ぐ)
--   expired          締切超過 (op='skip'|'date' のみ。§1-2 の terminal 規則)
--   failed           実行失敗 (fail_reason に理由。正直に通知)
--   cancel_requested done に対する取り消し依頼が受理された状態 (undo_of intent とペア)
--   cancelled        顧客/スタッフが取り消した (undo CAS の勝者のみが宣言できる)
--   deferred         移行窓 (executor='blocked') で受理だけした意思 (§5-1)。sweep から除外
--   superseded       繰越し先に別の open intent が既に存在した (新しい意思が優先)
--
-- 一意性 (§1-1 二重タップを型で潰す):
--   partial UNIQUE ux_sub_intents_open が「同一契約×同一サイクル×同一 op の open intent は 1 行」を
--   DB レベルで担保する。受理は INSERT ... ON CONFLICT DO NOTHING。0 行なら既存 intent を返す
--   (= 二重タップは冪等に「承り済みです」)。唯一 CAS を持たない台帳を作らない。
--   ⚠️ op='undo_of' の target_cycle_key は '{元のcycle_key}#undo:{元intent id}' 形式 —
--   一意性の単位を「元 intent ごと」にする (サイクル単位だと同一サイクルの別 intent への
--   取り消し依頼が既存 undo_of に吸収され、無記録で握り潰される)。
--
-- terminal 規則 (§1-2):
--   skip / date    → 締切超過で expired + 正直な失敗通知 (当該サイクル限りの操作)
--   pause / cancel → expired 禁止。同一行の target_cycle_key / deadline_at を次サイクルへ UPDATE して
--                    繰越し (新規 INSERT しない = partial UNIQUE と衝突しない)。解約意思を
--                    期限切れで無効化するのは特商法上の解約妨害 (§1-2)
--   resume         → deadline なし (再開意思は締切に縛られない)
--   undo_of        → 元 intent の state に従属
--
-- PII: friend_id / contract_key / op / state のみ。氏名・メール等は保存しない。
--   payload_json はスタッフ向けの補足メモ・依頼パラメータ (PII を書かない運用 + /admin/ops の注意書き)。
--
-- gate: SUB_INTENT_ENABLED='true' でなければ受理/遷移 API と sweep cron は no-op (= 本番 dormant)。
--
-- 非破壊 (= CREATE TABLE IF NOT EXISTS + index)。既存テーブル不変・additive・冪等。
--
-- 適用方法 (= cwd: apps/worker、 または GitHub Actions "Admin Ops" apply-migration-076):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\076_sub_intents.sql

CREATE TABLE IF NOT EXISTS sub_intents (
  id TEXT PRIMARY KEY,                          -- 'si_' + 128bit crypto ランダム (service 層が採番)
  friend_id TEXT,                               -- 受理時点の friend (未連携顧客のスタッフ代理受理は NULL)
  contract_ns TEXT NOT NULL,                    -- 'hb' | 'own' (移行境界を跨ぐので名前空間必須 §1)
  contract_key TEXT NOT NULL,                   -- ns='hb' → huckleberry contract_id / ns='own' → own contract gid
  target_cycle_key TEXT NOT NULL,               -- 提示時のサイクル識別子 '{contract_key}:{YYYY-MM-DD|unknown}'
  presented_scheduled_date TEXT,                -- 提示時に画面へ出した予定日 (受理時に現在値と突合する §1)
  op TEXT NOT NULL,                             -- skip|date|pause|resume|cancel|undo_of
  state TEXT NOT NULL DEFAULT 'received',       -- 上記 9 state
  requested_by TEXT NOT NULL,                   -- customer|staff|system (種別。§1-4 で自動 pause と分離)
  actor_staff_id TEXT,                          -- 最終遷移の個人 (受理・実行・却下で更新。全履歴は audit_logs)
  actor_role TEXT,
  payload_json TEXT,                            -- 依頼パラメータ (op='date' の希望日等)。PII を書かない
  deadline_at TEXT,                             -- 変更受付期限 (= 決済日の 3 日前 EOD JST)。NULL = 締切なし
  promised_by TEXT,                             -- §4-1 の約束期限 (§10-4 で使用。本 migration では列のみ)
  claimed_at TEXT,                              -- executing の claim 時刻。/admin/ops が未解決時間を常時表示
  executor TEXT NOT NULL DEFAULT 'human',       -- human|own_billing|api|blocked
  supersedes_intent_id TEXT,                    -- undo_of が指す元 intent
  fail_reason TEXT,                             -- failed の理由 (deadline_passed|cycle_drift|staff 入力等)
  carryover_count INTEGER NOT NULL DEFAULT 0,   -- pause/cancel の繰越し回数 (可視化・無限ループ検知)
  escalated_at TEXT,                            -- 締切超過エスカレーション済みマーカー (1 intent 1 回 §4-2)
  stale_alerted_at TEXT,                        -- claim 滞留アラート済みマーカー (claim 世代ごと §1-2。
                                                --  claim/release でクリア = escalated_at と目的を分離し、
                                                --  片方の消費でもう片方が沈黙しないようにする)
  created_at TEXT NOT NULL,
  resolved_at TEXT                              -- terminal 到達時刻 (done/expired/failed/cancelled/superseded)
);

-- §1-1: open intent の一意性。received/executing/deferred のみ対象 (terminal 行は再受理を妨げない)
CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_intents_open
  ON sub_intents(contract_ns, contract_key, target_cycle_key, op)
  WHERE state IN ('received','executing','deferred');

-- sweep 用 (state + 締切)。§4-2 の二段 sweep と claim timeout がこの経路で引く
CREATE INDEX IF NOT EXISTS idx_sub_intents_state
  ON sub_intents(state, deadline_at);

-- 顧客/契約別の履歴表示用
CREATE INDEX IF NOT EXISTS idx_sub_intents_contract
  ON sub_intents(contract_ns, contract_key, created_at);
