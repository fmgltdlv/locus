-- Per-authority enquiry tip fingerprints for smart GetNotificationResponseHistoryAsync skip.

CREATE TABLE IF NOT EXISTS ticket_ngen_history_authority_tips (
  ticket_id INTEGER NOT NULL,
  authority_id TEXT NOT NULL,
  tip_fingerprint TEXT NOT NULL,
  request_number TEXT,
  fetched_at TEXT,
  PRIMARY KEY (ticket_id, authority_id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ticket_ngen_history_authority_tips_ticket
  ON ticket_ngen_history_authority_tips (ticket_id);
