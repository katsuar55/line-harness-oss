-- Migration 023: 体調記録の強化 — お通じ・気分カラム追加
--
-- 追加項目:
-- 1. bowel_form  — お通じの形状 (hard/normal/soft)
-- 2. bowel_count — お通じの回数 (0〜10)
-- 3. mood        — 気分 5段階 (great/good/normal/bad/terrible)

ALTER TABLE health_logs ADD COLUMN bowel_form TEXT CHECK(bowel_form IN ('hard', 'normal', 'soft'));
ALTER TABLE health_logs ADD COLUMN bowel_count INTEGER;
ALTER TABLE health_logs ADD COLUMN mood TEXT CHECK(mood IN ('great', 'good', 'normal', 'bad', 'terrible'));
