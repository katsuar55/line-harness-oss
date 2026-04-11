-- Migration 027: Shopify OAuth states table for CSRF protection
-- Used during the Partner App OAuth install flow

CREATE TABLE IF NOT EXISTS shopify_oauth_states (
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL UNIQUE,
  store_domain TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at TEXT NOT NULL
);
