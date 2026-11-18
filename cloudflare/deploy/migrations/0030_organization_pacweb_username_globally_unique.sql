-- Each USAN provider username may appear at most once (one organization).
-- Dedupe existing rows (keep lowest id per normalized username).
DELETE FROM organization_pacweb_accounts
WHERE id IN (
  SELECT o1.id FROM organization_pacweb_accounts o1
  INNER JOIN organization_pacweb_accounts o2
    ON o1.pacweb_username IS NOT NULL
    AND o2.pacweb_username IS NOT NULL
    AND LENGTH(TRIM(o1.pacweb_username)) > 0
    AND LOWER(TRIM(o1.pacweb_username)) = LOWER(TRIM(o2.pacweb_username))
    AND o1.id > o2.id
);

UPDATE organization_pacweb_accounts
SET pacweb_username = LOWER(TRIM(pacweb_username))
WHERE pacweb_username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organization_pacweb_accounts_pacweb_username_unique
ON organization_pacweb_accounts(pacweb_username)
WHERE pacweb_username IS NOT NULL AND LENGTH(TRIM(pacweb_username)) > 0;
