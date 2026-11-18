-- DIRT / Reported Events (org-scoped, persisted in D1)

CREATE TABLE IF NOT EXISTS dirt_reported_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  created_by_user_id INTEGER NOT NULL,
  client_legacy_id TEXT,
  ticket_id INTEGER,
  ticket_number TEXT,
  payload_json TEXT NOT NULL,
  lat REAL,
  lng REAL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_dirt_events_org_created ON dirt_reported_events(organization_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dirt_events_org_client_legacy
  ON dirt_reported_events(organization_id, client_legacy_id)
  WHERE client_legacy_id IS NOT NULL AND TRIM(client_legacy_id) != '';
