-- Add amendment submit-jobs operation (distinct from remark).
PRAGMA foreign_keys = OFF;

CREATE TABLE ticket_submit_jobs_new (
  id TEXT PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  submitted_by_user_id INTEGER NOT NULL,
  submitted_by_display_name TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL CHECK (operation IN (
    'create', 'renew', 'remark', 'amendment', 'clone_new',
    'exposed', 'damage', 'follow_up', 'disputed'
  )),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  total_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  job_options_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (submitted_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO ticket_submit_jobs_new SELECT * FROM ticket_submit_jobs;

DROP TABLE ticket_submit_jobs;

ALTER TABLE ticket_submit_jobs_new RENAME TO ticket_submit_jobs;

CREATE INDEX IF NOT EXISTS idx_ticket_submit_jobs_org_status ON ticket_submit_jobs(organization_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_ticket_submit_jobs_user ON ticket_submit_jobs(submitted_by_user_id, status);

PRAGMA foreign_keys = ON;
