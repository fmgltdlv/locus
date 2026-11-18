-- Manual include/exclude overrides for project ticket membership (job name groups).

CREATE TABLE IF NOT EXISTS job_project_ticket_membership (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  job_name_normalized TEXT NOT NULL,
  ticket_id INTEGER NOT NULL,
  membership TEXT NOT NULL CHECK (membership IN ('include', 'exclude')),
  created_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, job_name_normalized, ticket_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_project_ticket_membership_ticket
  ON job_project_ticket_membership(organization_id, ticket_id);

CREATE INDEX IF NOT EXISTS idx_job_project_ticket_membership_project
  ON job_project_ticket_membership(organization_id, job_name_normalized);
