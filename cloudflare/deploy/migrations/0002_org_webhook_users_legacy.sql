-- Align with Node migrations: organizations.webhook_secret_phrase, legacy users.organization_id for org list JOINs.
PRAGMA foreign_keys = ON;

ALTER TABLE organizations ADD COLUMN webhook_secret_phrase TEXT;

ALTER TABLE users ADD COLUMN organization_id INTEGER;
