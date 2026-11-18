-- Background USAN submit jobs (create / renew / remark). Purge completed rows after ~7 days (app cleanup).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ticket_submit_jobs (
  id TEXT PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  submitted_by_user_id INTEGER NOT NULL,
  submitted_by_display_name TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL CHECK (operation IN ('create', 'renew', 'remark')),
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

CREATE TABLE IF NOT EXISTS ticket_submit_job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  ticket_number TEXT,
  idempotency_key TEXT,
  payload_json TEXT,
  operation_detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  result_json TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES ticket_submit_jobs(id) ON DELETE CASCADE,
  UNIQUE(job_id, item_index)
);

CREATE INDEX IF NOT EXISTS idx_ticket_submit_jobs_org_status ON ticket_submit_jobs(organization_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_ticket_submit_jobs_user ON ticket_submit_jobs(submitted_by_user_id, status);
CREATE INDEX IF NOT EXISTS idx_ticket_submit_job_items_job ON ticket_submit_job_items(job_id, item_index);
