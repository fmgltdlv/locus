-- Replaces in-memory Map for <img> media tokens (Workers-safe, multi-instance)
CREATE TABLE IF NOT EXISTS media_access_tokens (
  token TEXT PRIMARY KEY,
  media_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_access_tokens_expires ON media_access_tokens(expires_at);
