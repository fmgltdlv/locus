-- Ticket schema audit: slim lineage audit log, drop unused source_endpoint,
-- rename ticket_photo_intersections → ticket_photo_stats (slim counts only).

-- A. ticket_lineage_events: keep minimum audit columns
CREATE TABLE IF NOT EXISTS ticket_lineage_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  previous_ticket_number TEXT NOT NULL,
  observed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  UNIQUE(ticket_id, previous_ticket_number)
);

INSERT OR IGNORE INTO ticket_lineage_events_new (ticket_id, previous_ticket_number, observed_at)
SELECT
  ticket_id,
  previous_ticket_number,
  MIN(observed_at)
FROM ticket_lineage_events
WHERE previous_ticket_number IS NOT NULL
  AND TRIM(previous_ticket_number) <> ''
GROUP BY ticket_id, previous_ticket_number;

DROP TABLE ticket_lineage_events;
ALTER TABLE ticket_lineage_events_new RENAME TO ticket_lineage_events;

CREATE INDEX IF NOT EXISTS idx_ticket_lineage_previous ON ticket_lineage_events(previous_ticket_number);

-- B. ticket_status_history: source_endpoint never populated
ALTER TABLE ticket_status_history DROP COLUMN source_endpoint;

-- C. ticket_photo_intersections → ticket_photo_stats
CREATE TABLE IF NOT EXISTS ticket_photo_stats (
  ticket_id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  ticket_number TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  inputs_hash TEXT,
  computed_at TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

INSERT INTO ticket_photo_stats (
  ticket_id, organization_id, ticket_number, stats_json, inputs_hash, computed_at, updated_at
)
SELECT
  ticket_id, organization_id, ticket_number, snapshot_json, inputs_hash, computed_at, updated_at
FROM ticket_photo_intersections;

DROP TABLE ticket_photo_intersections;

CREATE INDEX IF NOT EXISTS idx_ticket_photo_stats_org
  ON ticket_photo_stats (organization_id, updated_at);
