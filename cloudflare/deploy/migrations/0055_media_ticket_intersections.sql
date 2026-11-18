CREATE TABLE IF NOT EXISTS media_ticket_intersections (
  media_id INTEGER NOT NULL,
  ticket_base_number TEXT NOT NULL,
  organization_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (media_id, ticket_base_number, organization_id),
  FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_media_ticket_intersections_base
  ON media_ticket_intersections (organization_id, ticket_base_number);
