-- Server-side dismissals for failed submit-job items (Needs attention UI).
CREATE TABLE IF NOT EXISTS ticket_submit_job_item_dismissals (
  user_id INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, job_id, item_index)
);

CREATE INDEX IF NOT EXISTS idx_submit_job_item_dismissals_user
  ON ticket_submit_job_item_dismissals (user_id, dismissed_at);
