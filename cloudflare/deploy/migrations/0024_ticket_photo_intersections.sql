CREATE TABLE IF NOT EXISTS ticket_photo_intersections (
  ticket_id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  ticket_number TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  inputs_hash TEXT,
  computed_at TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ticket_photo_intersections_org
  ON ticket_photo_intersections (organization_id, updated_at);
