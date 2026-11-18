-- Self-service signup: claimed email domains, pending signups, verification, allowlists, reject burn list.

ALTER TABLE organizations ADD COLUMN email_domain TEXT;
ALTER TABLE organizations ADD COLUMN name_normalized TEXT;

-- SQLite UNIQUE allows multiple NULLs, so no partial index needed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_email_domain ON organizations(email_domain);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_name_normalized ON organizations(name_normalized);

-- Existing orgs keep name_normalized NULL until Admin edits or ops backfills.
-- New self-serve creates always set name_normalized.

CREATE TABLE IF NOT EXISTS pending_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  org_name TEXT,
  seed_admins_json TEXT,
  seed_users_json TEXT,
  usan_username TEXT,
  usan_password_encrypted TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pending_signups_created_at ON pending_signups(created_at);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_signup_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  requested_ip TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pending_signup_id) REFERENCES pending_signups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_pending ON email_verification_tokens(pending_signup_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_expires ON email_verification_tokens(expires_at);

CREATE TABLE IF NOT EXISTS org_signup_allowlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  consumed_at TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE (organization_id, email)
);

CREATE INDEX IF NOT EXISTS idx_org_signup_allowlist_email ON org_signup_allowlist(email);

CREATE TABLE IF NOT EXISTS signup_rejected_emails (
  email TEXT PRIMARY KEY,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
