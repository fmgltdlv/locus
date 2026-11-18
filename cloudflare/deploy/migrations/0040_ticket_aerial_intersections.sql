ALTER TABLE tickets ADD COLUMN has_aerial_imagery INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ticket_aerial_intersections (
  ticket_id INTEGER NOT NULL,
  aerial_map_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticket_id, aerial_map_id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (aerial_map_id) REFERENCES aerial_maps(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ticket_aerial_intersections_map
  ON ticket_aerial_intersections (aerial_map_id);
