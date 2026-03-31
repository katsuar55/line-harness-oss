-- Add bot_user_id column to line_accounts for destination-based webhook routing
-- The bot_user_id is the LINE user ID of the bot (the "destination" field in webhook payloads)
-- This enables O(1) lookup instead of brute-forcing all channel_secrets for signature verification

ALTER TABLE line_accounts ADD COLUMN bot_user_id TEXT;

-- Index for fast lookup by bot_user_id during webhook processing
CREATE INDEX IF NOT EXISTS idx_line_accounts_bot_user_id ON line_accounts(bot_user_id);
