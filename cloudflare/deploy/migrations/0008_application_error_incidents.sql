CREATE TABLE IF NOT EXISTS application_error_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  error_code TEXT NOT NULL,
  customer_message TEXT NOT NULL,
  internal_message TEXT,
  detail TEXT,
  status INTEGER,
  route TEXT,
  request_method TEXT,
  request_path TEXT,
  user_id INTEGER,
  organization_id INTEGER,
  meta_json TEXT,
  acknowledged_at DATETIME,
  acknowledged_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (acknowledged_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_application_error_incidents_created
  ON application_error_incidents(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_application_error_incidents_acknowledged
  ON application_error_incidents(acknowledged_at, created_at DESC);
