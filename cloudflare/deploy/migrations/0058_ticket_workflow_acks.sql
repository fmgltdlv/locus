-- Workflow acknowledgement (manual READY) + remove deprecated photo stats cache
CREATE TABLE IF NOT EXISTS ticket_workflow_acks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  ticket_number TEXT NOT NULL,
  revision TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  photos_met INTEGER NOT NULL DEFAULT 1,
  acknowledged_by_user_id INTEGER,
  acknowledged_by_name TEXT,
  acknowledged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (acknowledged_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(organization_id, ticket_number)
);

CREATE INDEX IF NOT EXISTS idx_ticket_workflow_acks_org
  ON ticket_workflow_acks(organization_id);

DROP TABLE IF EXISTS ticket_photo_stats;
