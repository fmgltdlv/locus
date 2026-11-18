-- Project-based tech assignment: crew on projects instead of per-ticket assignees.

CREATE TABLE IF NOT EXISTS job_project_assignees (
  organization_id INTEGER NOT NULL,
  job_name_normalized TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id INTEGER,
  PRIMARY KEY (organization_id, job_name_normalized, user_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_project_assignees_user
  ON job_project_assignees(organization_id, user_id);

CREATE INDEX IF NOT EXISTS idx_job_project_assignees_project
  ON job_project_assignees(organization_id, job_name_normalized);

DROP INDEX IF EXISTS idx_ticket_assignees_user;
DROP TABLE IF EXISTS ticket_assignees;
