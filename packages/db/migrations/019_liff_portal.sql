-- 019_liff_portal.sql
-- Phase 3A: LIFF リッチ顧客ポータル + 追加5機能
-- 8 new tables: intake_logs, intake_reminders, referral_links, referral_rewards,
--               recommendation_results, health_logs, ambassadors, daily_tips

-- ===== 1. intake_logs: サプリ服用記録 =====
CREATE TABLE IF NOT EXISTS intake_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))),
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  product_name TEXT,
  shopify_product_id TEXT,
  streak_count INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  logged_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_intake_logs_friend ON intake_logs(friend_id);
CREATE INDEX IF NOT EXISTS idx_intake_logs_logged ON intake_logs(friend_id, logged_at);

-- ===== 2. intake_reminders: 服用リマインダー設定 =====
CREATE TABLE IF NOT EXISTS intake_reminders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))),
  friend_id TEXT NOT NULL UNIQUE REFERENCES friends(id) ON DELETE CASCADE,
  reminder_time TEXT NOT NULL DEFAULT '08:00',
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  reminder_type TEXT NOT NULL DEFAULT 'morning_push' CHECK(reminder_type IN ('morning_push', 'streak_only')),
  is_active INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  snooze_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_intake_reminders_active ON intake_reminders(is_active, reminder_time);

-- ===== 3. referral_links: 友だち紹介リンク =====
CREATE TABLE IF NOT EXISTS referral_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))),
  friend_id TEXT NOT NULL UNIQUE REFERENCES friends(id) ON DELETE CASCADE,
  ref_code TEXT NOT NULL UNIQUE,
  referrer_coupon_id TEXT REFERENCES shopify_coupons(id) ON DELETE SET NULL,
  referred_coupon_id TEXT REFERENCES shopify_coupons(id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_referral_links_ref ON referral_links(ref_code);

-- ===== 4. referral_rewards: 紹介成立記録 =====
CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))),
  referrer_friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  referred_friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  referrer_coupon_id TEXT REFERENCES shopify_coupons(id) ON DELETE SET NULL,
  referred_coupon_id TEXT REFERENCES shopify_coupons(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'rewarded', 'expired')),
  rewarded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer ON referral_rewards(referrer_friend_id);
CREATE INDEX IF NOT EXISTS idx_referral_rewards_referred ON referral_rewards(referred_friend_id);

-- ===== 5. recommendation_results: 診断クイズ結果 =====
CREATE TABLE IF NOT EXISTS recommendation_results (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))),
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  quiz_answers TEXT NOT NULL DEFAULT '{}',
  recommended_product TEXT NOT NULL,
  recommended_product_id TEXT,
  score_breakdown TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_recommendation_friend ON recommendation_results(friend_id);

-- ===== 6. health_logs: 体重・体調・食事記録 =====
CREATE TABLE IF NOT EXISTS health_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))),
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  weight REAL,
  condition TEXT CHECK(condition IN ('good', 'normal', 'bad')),
  skin_condition TEXT CHECK(skin_condition IN ('good', 'normal', 'bad')),
  meals TEXT DEFAULT '{}',
  sleep_hours REAL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_health_logs_friend ON health_logs(friend_id);
CREATE INDEX IF NOT EXISTS idx_health_logs_date ON health_logs(friend_id, log_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_health_logs_unique ON health_logs(friend_id, log_date);

-- ===== 7. ambassadors: アンバサダー制度 =====
CREATE TABLE IF NOT EXISTS ambassadors (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))),
  friend_id TEXT NOT NULL UNIQUE REFERENCES friends(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'invited' CHECK(status IN ('active', 'inactive', 'invited')),
  tier TEXT NOT NULL DEFAULT 'standard' CHECK(tier IN ('standard', 'premium')),
  enrolled_at TEXT,
  total_surveys_completed INTEGER NOT NULL DEFAULT 0,
  total_product_tests INTEGER NOT NULL DEFAULT 0,
  feedback_score REAL,
  preferences TEXT NOT NULL DEFAULT '{"survey_ok":true,"product_test_ok":true,"sns_share_ok":false}',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_ambassadors_status ON ambassadors(status);
CREATE INDEX IF NOT EXISTS idx_ambassadors_friend ON ambassadors(friend_id);

-- ===== 8. daily_tips: 日替わりヘルスTips =====
CREATE TABLE IF NOT EXISTS daily_tips (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))),
  tip_date TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'nutrition' CHECK(category IN ('nutrition', 'sleep', 'exercise', 'skincare', 'mental')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  image_url TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'ai_generated')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_daily_tips_date ON daily_tips(tip_date);
