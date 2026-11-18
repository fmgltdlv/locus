-- Remove legacy webhook_secret_phrase from organization_pacweb_accounts.
-- DROP COLUMN fails if the column was never created (some DBs differ from 0001).
-- Rebuild the table by copying only the columns we use (requires account_type from 0007).

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS organization_pacweb_accounts__m9;

CREATE TABLE organization_pacweb_accounts__m9 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  label TEXT,
  pacweb_username TEXT,
  password_encrypted TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  account_type TEXT NOT NULL DEFAULT 'sub',
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

INSERT INTO organization_pacweb_accounts__m9 (
  id, organization_id, label, pacweb_username, password_encrypted, created_at, updated_at, account_type
)
SELECT
  id,
  organization_id,
  label,
  pacweb_username,
  password_encrypted,
  created_at,
  updated_at,
  COALESCE(account_type, 'sub')
FROM organization_pacweb_accounts;

DROP TABLE organization_pacweb_accounts;

ALTER TABLE organization_pacweb_accounts__m9 RENAME TO organization_pacweb_accounts;

DELETE FROM sqlite_sequence WHERE name = 'organization_pacweb_accounts';
INSERT INTO sqlite_sequence (name, seq)
VALUES (
  'organization_pacweb_accounts',
  COALESCE((SELECT MAX(id) FROM organization_pacweb_accounts), 0)
);

PRAGMA foreign_keys = ON;
