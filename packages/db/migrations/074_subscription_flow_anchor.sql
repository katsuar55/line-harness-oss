-- 074: Flow 実測値を「アンカー」として保持し、実測後のスキップ増分だけ先送りする (§10-0 ①)
--
-- 背景: estimate_source='flow' の行は refreshEstimate が早期 return するため、
-- その後に顧客がスキップしても next_billing_estimate が動かなかった。
-- 結果、**スキップ済みの顧客に 1 周期古い決済リマインドが LINE で push される**経路があった。
--
-- 「実測は導出で上書きしない」(docs/SUBSCRIPTION_UX_TAP_MINIMAL_2026-07-25.md §3-2) は正しい。
-- スキップは導出ではなく**新しい事実**なので、実測を捨てずに増分だけ足す。
--   実効値 = flow_estimate_anchor + interval_days × max(0, skip_count - skip_count_at_estimate)
-- next_billing_estimate には実効値 (= リマインド SQL が引く値) を、anchor には実測日そのものを持つ。
-- 純関数の再計算にすることで、webhook の交錯・再配信で何度走っても同じ値に収束する。
--
-- ⚠️ skip_count_at_last_order は流用できない: 「直近注文時点」の累計なので、
-- 注文と実測の間に起きたスキップ (= Huckleberry が既に実測日へ織り込み済み) を二重計上する。
ALTER TABLE subscription_contracts ADD COLUMN flow_estimate_anchor TEXT;
ALTER TABLE subscription_contracts ADD COLUMN skip_count_at_estimate INTEGER NOT NULL DEFAULT 0;

-- 既存行の初期化 (DEFAULT 0 のままだと、適用直後の refreshEstimate が
-- 累計スキップ数ぶんを一気に先送りしてしまう)。
-- 基準値は現累計 = 「過去のスキップは消化済みとみなす」(rebuild pass3 と同じ安全側の規約)。
UPDATE subscription_contracts SET skip_count_at_estimate = skip_count;
UPDATE subscription_contracts
   SET flow_estimate_anchor = next_billing_estimate
 WHERE estimate_source = 'flow' AND next_billing_estimate IS NOT NULL;
