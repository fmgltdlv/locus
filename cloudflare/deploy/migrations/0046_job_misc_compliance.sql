-- Job-scoped misc compliance tracking shared across tickets with the same job name (user_reference).

CREATE TABLE IF NOT EXISTS job_misc_compliance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  job_name_normalized TEXT NOT NULL,
  job_name_display TEXT NOT NULL,
  permit_expiration TEXT,
  traffic_control_permit_expiration TEXT,
  third_party_inspection_date TEXT,
  third_party_inspection_notes TEXT,
  general_notes TEXT,
  custom_items_json TEXT NOT NULL DEFAULT '[]',
  updated_by_user_id INTEGER,
  updated_by_display_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, job_name_normalized),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_job_misc_compliance_org
  ON job_misc_compliance(organization_id, job_name_normalized);

CREATE INDEX IF NOT EXISTS idx_tickets_org_user_reference
  ON tickets(organization_id, user_reference);
