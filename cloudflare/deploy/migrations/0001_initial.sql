-- D1 initial schema — mirrors `backend/database.js` createTables + common migrations.
-- D1 uses SQLite; validate with `wrangler d1 execute --local --file=...` before production.
-- Partial indexes: supported in D1 (SQLite).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  settings TEXT,
  subscription_tier TEXT NOT NULL DEFAULT 'basic',
  storage_used INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  default_organization_id INTEGER,
  full_name TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'es')),
  last_login DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (default_organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS user_organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  organization_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS login_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  ip_address TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS media_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  thumbnail_path TEXT,
  mime_type TEXT,
  metadata TEXT,
  note_text TEXT,
  note_last_edited_by TEXT,
  note_last_edited_at TEXT,
  batch_id TEXT,
  batch_name TEXT,
  latitude REAL,
  longitude REAL,
  has_gps INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS geospatial_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  data_type TEXT NOT NULL,
  data_id TEXT NOT NULL,
  geometry TEXT NOT NULL,
  properties TEXT,
  geom_type TEXT,
  min_lng REAL,
  min_lat REAL,
  max_lng REAL,
  max_lat REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(organization_id, data_type, data_id)
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  user_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'new',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS aerial_maps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  bounding_box TEXT,
  min_lng REAL,
  min_lat REAL,
  max_lng REAL,
  max_lat REAL,
  captured_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS org_aerial_favorites (
  organization_id INTEGER NOT NULL,
  aerial_map_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, aerial_map_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (aerial_map_id) REFERENCES aerial_maps(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  ticket_number TEXT NOT NULL,
  ticket_data TEXT NOT NULL,
  min_lng REAL,
  min_lat REAL,
  max_lng REAL,
  max_lat REAL,
  company TEXT,
  excavator_name TEXT,
  work_description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  intake_revision_schema_version INTEGER DEFAULT 1,
  enrichment_completed_at TEXT,
  enrichment_causal_watermark TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(organization_id, ticket_number)
);

CREATE TABLE IF NOT EXISTS service_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT,
  user_email TEXT,
  service_type TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS document_annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id INTEGER NOT NULL,
  organization_id INTEGER NOT NULL,
  annotations_json TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (media_file_id) REFERENCES media_files(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(media_file_id)
);

CREATE TABLE IF NOT EXISTS map_workspace_state (
  organization_id INTEGER PRIMARY KEY,
  annotations_json TEXT NOT NULL DEFAULT '[]',
  data_layers_json TEXT NOT NULL DEFAULT '[]',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS map_workspace_annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  ann_id TEXT NOT NULL,
  geometry TEXT NOT NULL,
  geom_type TEXT,
  min_lng REAL,
  min_lat REAL,
  max_lng REAL,
  max_lat REAL,
  properties_json TEXT NOT NULL DEFAULT '{}',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, ann_id)
);

CREATE TABLE IF NOT EXISTS map_workspace_data_layers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  layer_id TEXT NOT NULL,
  layer_json TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, layer_id)
);

CREATE TABLE IF NOT EXISTS ticket_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  ticket_number TEXT NOT NULL,
  override_type TEXT NOT NULL,
  operator_code TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  overridden_by_user_id INTEGER,
  overridden_by_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (overridden_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(organization_id, ticket_number, override_type, operator_code)
);

CREATE TABLE IF NOT EXISTS ticket_view_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  ticket_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_display_name TEXT,
  opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS station_operator_phones (
  station_code TEXT PRIMARY KEY NOT NULL,
  name_with_phones TEXT,
  industry TEXT,
  last_refreshed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS organization_pacweb_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  label TEXT,
  webhook_secret_phrase TEXT,
  pacweb_username TEXT,
  password_encrypted TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ticket_pacweb_enrichment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  ticket_number TEXT NOT NULL,
  revision TEXT,
  job_number INTEGER,
  pacweb_enquiry_id TEXT,
  request_number TEXT,
  confirmation_pdf_path TEXT,
  positive_response_pdf_path TEXT,
  parsed_fields_json TEXT,
  fetched_at DATETIME,
  enrichment_error TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, ticket_number)
);

CREATE TABLE IF NOT EXISTS pac_unassigned_import_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_number TEXT NOT NULL UNIQUE,
  job_row_json TEXT,
  enquiry_json TEXT,
  lodged_by_hint TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id INTEGER,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS organization_partnerships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_low_id INTEGER NOT NULL,
  org_high_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  initiated_by_org_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_low_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (org_high_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (initiated_by_org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CHECK (org_low_id < org_high_id),
  UNIQUE(org_low_id, org_high_id)
);

CREATE TABLE IF NOT EXISTS organization_sharing_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partnership_id INTEGER NOT NULL,
  source_org_id INTEGER NOT NULL,
  share_tickets INTEGER NOT NULL DEFAULT 0,
  share_photos INTEGER NOT NULL DEFAULT 0,
  share_saved_layers INTEGER NOT NULL DEFAULT 0,
  share_reported_events INTEGER NOT NULL DEFAULT 0,
  source_identity_mode TEXT NOT NULL DEFAULT 'named',
  FOREIGN KEY (partnership_id) REFERENCES organization_partnerships(id) ON DELETE CASCADE,
  FOREIGN KEY (source_org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(partnership_id, source_org_id)
);

CREATE TABLE IF NOT EXISTS user_ui_preferences (
  user_id INTEGER PRIMARY KEY,
  preferences_json TEXT NOT NULL DEFAULT '{}',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
