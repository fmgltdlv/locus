-- master = one nGen poller + optional stored password; sub = username only for org matching
ALTER TABLE organization_pacweb_accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT 'sub';

-- One master per org (lowest id wins); subs must not keep passwords
UPDATE organization_pacweb_accounts SET account_type = 'sub';
UPDATE organization_pacweb_accounts SET account_type = 'master' WHERE id IN (
  SELECT MIN(id) FROM organization_pacweb_accounts GROUP BY organization_id
);
UPDATE organization_pacweb_accounts SET password_encrypted = NULL WHERE account_type = 'sub';
