-- Stable 10-char alphanumeric public IDs for projects (used as share link tokens).

ALTER TABLE job_misc_compliance ADD COLUMN public_id TEXT;

-- Backfill existing registry rows (hex is a valid A-Z0-9 subset).
UPDATE job_misc_compliance
SET public_id = upper(substr(hex(randomblob(8)), 1, 10))
WHERE public_id IS NULL OR trim(public_id) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_misc_compliance_public_id
  ON job_misc_compliance(public_id);

-- Ensure a registry row exists for any still-active share links.
INSERT INTO job_misc_compliance (
  organization_id,
  job_name_normalized,
  job_name_display,
  custom_items_json,
  public_id,
  created_at,
  updated_at
)
SELECT
  s.organization_id,
  s.job_name_normalized,
  s.job_name_normalized,
  '[]',
  upper(substr(hex(randomblob(8)), 1, 10)),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM job_project_share_links s
WHERE s.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM job_misc_compliance j
    WHERE j.organization_id = s.organization_id
      AND j.job_name_normalized = s.job_name_normalized
  );

-- Rewrite active share tokens to the stable public_id and drop expiry.
UPDATE job_project_share_links
SET
  expires_at = NULL,
  token = (
    SELECT j.public_id
    FROM job_misc_compliance j
    WHERE j.organization_id = job_project_share_links.organization_id
      AND j.job_name_normalized = job_project_share_links.job_name_normalized
  )
WHERE revoked_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM job_misc_compliance j
    WHERE j.organization_id = job_project_share_links.organization_id
      AND j.job_name_normalized = job_project_share_links.job_name_normalized
      AND j.public_id IS NOT NULL
      AND trim(j.public_id) != ''
  );
