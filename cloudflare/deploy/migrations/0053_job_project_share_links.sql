-- Public share links for project map views (unauthenticated token access).

CREATE TABLE IF NOT EXISTS job_project_share_links (
  token TEXT PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  job_name_normalized TEXT NOT NULL,
  label TEXT,
  created_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  revoked_at DATETIME,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_project_share_links_org_project
  ON job_project_share_links(organization_id, job_name_normalized);

CREATE INDEX IF NOT EXISTS idx_job_project_share_links_expires
  ON job_project_share_links(expires_at);
