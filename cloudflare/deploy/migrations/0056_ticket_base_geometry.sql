CREATE TABLE IF NOT EXISTS ticket_base_geometry (
  organization_id INTEGER NOT NULL,
  ticket_base_number TEXT NOT NULL,
  polygon_json TEXT,
  min_lng REAL,
  min_lat REAL,
  max_lng REAL,
  max_lat REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, ticket_base_number)
);

CREATE INDEX IF NOT EXISTS idx_ticket_base_geometry_org
  ON ticket_base_geometry (organization_id);

-- Backfill: one row per (org, base) from any revision that has polygon_json.
INSERT OR IGNORE INTO ticket_base_geometry (
  organization_id,
  ticket_base_number,
  polygon_json,
  min_lng,
  min_lat,
  max_lng,
  max_lat,
  updated_at
)
SELECT
  organization_id,
  CASE
    WHEN instr(ticket_number, '-') > 0 THEN substr(ticket_number, 1, instr(ticket_number, '-') - 1)
    ELSE ticket_number
  END AS ticket_base_number,
  polygon_json,
  min_lng,
  min_lat,
  max_lng,
  max_lat,
  CURRENT_TIMESTAMP
FROM tickets
WHERE polygon_json IS NOT NULL
GROUP BY
  organization_id,
  CASE
    WHEN instr(ticket_number, '-') > 0 THEN substr(ticket_number, 1, instr(ticket_number, '-') - 1)
    ELSE ticket_number
  END;
