-- Open/closed lifecycle for job projects (job_misc_compliance registry rows).

ALTER TABLE job_misc_compliance ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE job_misc_compliance ADD COLUMN closed_at DATETIME;
ALTER TABLE job_misc_compliance ADD COLUMN closed_by_user_id INTEGER;
ALTER TABLE job_misc_compliance ADD COLUMN closed_by_display_name TEXT;

CREATE INDEX IF NOT EXISTS idx_job_misc_compliance_org_status_closed
  ON job_misc_compliance(organization_id, status, closed_at);
