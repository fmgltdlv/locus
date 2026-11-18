-- Per-revision nGen enquiry catalog (ids + USAN status). PDF bytes stay on-device only.
CREATE TABLE IF NOT EXISTS ticket_revision_enquiries (
  ticket_id INTEGER NOT NULL,
  revision TEXT NOT NULL,
  job_number TEXT NOT NULL,
  request_number TEXT,
  status TEXT,
  observed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticket_id, revision),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ticket_revision_enquiries_job
  ON ticket_revision_enquiries(job_number);
