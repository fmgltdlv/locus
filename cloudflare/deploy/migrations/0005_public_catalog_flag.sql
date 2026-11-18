-- Public Data org: mark which organization row is the shared catalog (1=yes)
ALTER TABLE organizations ADD COLUMN is_public_catalog INTEGER NOT NULL DEFAULT 0;
