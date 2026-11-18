-- Idempotency records for USAN/nGen SubmitCurrentUserEnquiryAsync writes.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS usan_submit_idempotency (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  organization_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  scope_ref TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  response_json TEXT,
  new_enquiry_id INTEGER,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_usan_idempotency_expires ON usan_submit_idempotency(expires_at);
