-- Database cleanup: remove login browser storage, normalize map workspace blobs,
-- and add first-pass ticket structured columns / child tables.

PRAGMA foreign_keys = OFF;

-- login_history: keep IP address, drop user_agent.
DROP TABLE IF EXISTS login_history__m10;
CREATE TABLE login_history__m10 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  ip_address TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO login_history__m10 (id, user_id, login_time, ip_address)
SELECT lh.id, lh.user_id, lh.login_time, lh.ip_address
FROM login_history lh
INNER JOIN users u ON u.id = lh.user_id;

DROP TABLE login_history;
ALTER TABLE login_history__m10 RENAME TO login_history;

-- Map workspace annotations: replace properties_json with standardized columns.
DROP TABLE IF EXISTS map_workspace_annotations__m10;
CREATE TABLE map_workspace_annotations__m10 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  ann_id TEXT NOT NULL,
  geometry TEXT NOT NULL,
  geom_type TEXT,
  min_lng REAL,
  min_lat REAL,
  max_lng REAL,
  max_lat REAL,
  annotation_type TEXT,
  name TEXT,
  note TEXT,
  color TEXT,
  icon TEXT,
  utility_type TEXT,
  document_ref TEXT,
  line_pattern TEXT,
  original_name TEXT,
  created_at TEXT,
  created_by TEXT,
  last_edited_by TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, ann_id)
);

INSERT OR REPLACE INTO map_workspace_annotations__m10 (
  id, organization_id, ann_id, geometry, geom_type, min_lng, min_lat, max_lng, max_lat,
  annotation_type, name, note, color, icon, utility_type, document_ref, line_pattern,
  original_name, created_at, created_by, last_edited_by, updated_at
)
SELECT
  id,
  organization_id,
  ann_id,
  geometry,
  geom_type,
  min_lng,
  min_lat,
  max_lng,
  max_lat,
  CASE WHEN json_valid(properties_json) THEN json_extract(properties_json, '$.type') ELSE NULL END,
  CASE WHEN json_valid(properties_json) THEN json_extract(properties_json, '$.name') ELSE NULL END,
  CASE WHEN json_valid(properties_json) THEN json_extract(properties_json, '$.note') ELSE NULL END,
  CASE WHEN json_valid(properties_json) THEN json_extract(properties_json, '$.color') ELSE NULL END,
  CASE WHEN json_valid(properties_json) THEN json_extract(properties_json, '$.icon') ELSE NULL END,
  CASE WHEN json_valid(properties_json) THEN json_extract(properties_json, '$.utilityType') ELSE NULL END,
  CASE WHEN json_valid(properties_json) THEN json_extract(properties_json, '$.documentRef') ELSE NULL END,
  CASE WHEN json_valid(properties_json) THEN json_extract(properties_json, '$.linePattern') ELSE NULL END,
  CASE WHEN json_valid(properties_json) THEN json_extract(properties_json, '$.originalName') ELSE NULL END,
  CASE WHEN json_valid(properties_json) THEN json_extract(properties_json, '$.createdAt') ELSE NULL END,
  CASE WHEN json_valid(properties_json) THEN json_extract(properties_json, '$.createdBy') ELSE NULL END,
  CASE WHEN json_valid(properties_json) THEN json_extract(properties_json, '$.lastEditedBy') ELSE NULL END,
  updated_at
FROM map_workspace_annotations;

DROP TABLE map_workspace_annotations;
ALTER TABLE map_workspace_annotations__m10 RENAME TO map_workspace_annotations;

-- Saved data layers: metadata table + child feature rows.
DROP TABLE IF EXISTS map_workspace_data_layers__m10;
CREATE TABLE map_workspace_data_layers__m10 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  layer_id TEXT NOT NULL,
  name TEXT,
  original_name TEXT,
  source TEXT,
  utility_type TEXT,
  is_visible INTEGER NOT NULL DEFAULT 1,
  list_in_layer_panel INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, layer_id)
);

CREATE TABLE IF NOT EXISTS map_workspace_layer_annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  layer_id TEXT NOT NULL,
  ann_id TEXT NOT NULL,
  geometry TEXT NOT NULL,
  geom_type TEXT,
  min_lng REAL,
  min_lat REAL,
  max_lng REAL,
  max_lat REAL,
  annotation_type TEXT,
  name TEXT,
  note TEXT,
  color TEXT,
  icon TEXT,
  utility_type TEXT,
  document_ref TEXT,
  line_pattern TEXT,
  original_name TEXT,
  created_at TEXT,
  created_by TEXT,
  last_edited_by TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, layer_id, ann_id)
);

INSERT OR REPLACE INTO map_workspace_data_layers__m10 (
  id, organization_id, layer_id, name, original_name, source, utility_type,
  is_visible, list_in_layer_panel, created_at, updated_at
)
SELECT
  id,
  organization_id,
  layer_id,
  CASE WHEN json_valid(layer_json) THEN json_extract(layer_json, '$.name') ELSE NULL END,
  CASE WHEN json_valid(layer_json) THEN json_extract(layer_json, '$.originalName') ELSE NULL END,
  CASE WHEN json_valid(layer_json) THEN json_extract(layer_json, '$.source') ELSE NULL END,
  CASE WHEN json_valid(layer_json) THEN json_extract(layer_json, '$.utilityType') ELSE NULL END,
  CASE WHEN json_valid(layer_json) AND json_extract(layer_json, '$.isVisible') = 0 THEN 0 ELSE 1 END,
  CASE WHEN json_valid(layer_json) AND json_extract(layer_json, '$.listInLayerPanel') = 0 THEN 0 ELSE 1 END,
  CASE WHEN json_valid(layer_json) THEN json_extract(layer_json, '$.createdAt') ELSE NULL END,
  updated_at
FROM map_workspace_data_layers;

INSERT OR IGNORE INTO map_workspace_layer_annotations (
  organization_id, layer_id, ann_id, geometry, geom_type,
  annotation_type, name, note, color, icon, utility_type, document_ref, line_pattern,
  original_name, created_at, created_by, last_edited_by, updated_at
)
SELECT
  l.organization_id,
  l.layer_id,
  COALESCE(json_extract(ann.value, '$.id'), 'migrated-' || l.id || '-' || ann.key),
  json_extract(ann.value, '$.geometry'),
  json_extract(ann.value, '$.geometry.type'),
  json_extract(ann.value, '$.type'),
  json_extract(ann.value, '$.name'),
  json_extract(ann.value, '$.note'),
  json_extract(ann.value, '$.color'),
  json_extract(ann.value, '$.icon'),
  json_extract(ann.value, '$.utilityType'),
  json_extract(ann.value, '$.documentRef'),
  json_extract(ann.value, '$.linePattern'),
  json_extract(ann.value, '$.originalName'),
  json_extract(ann.value, '$.createdAt'),
  json_extract(ann.value, '$.createdBy'),
  json_extract(ann.value, '$.lastEditedBy'),
  l.updated_at
FROM map_workspace_data_layers l,
     json_each(l.layer_json, '$.annotations') ann
WHERE json_valid(l.layer_json)
  AND json_type(l.layer_json, '$.annotations') = 'array'
  AND json_extract(ann.value, '$.geometry') IS NOT NULL;

INSERT OR IGNORE INTO map_workspace_data_layers__m10 (
  organization_id, layer_id, name, original_name, source, utility_type,
  is_visible, list_in_layer_panel, created_at, updated_at
)
SELECT
  s.organization_id,
  COALESCE(json_extract(layer.value, '$.id'), 'legacy-layer-' || s.organization_id || '-' || layer.key),
  json_extract(layer.value, '$.name'),
  json_extract(layer.value, '$.originalName'),
  json_extract(layer.value, '$.source'),
  json_extract(layer.value, '$.utilityType'),
  CASE WHEN json_extract(layer.value, '$.isVisible') = 0 THEN 0 ELSE 1 END,
  CASE WHEN json_extract(layer.value, '$.listInLayerPanel') = 0 THEN 0 ELSE 1 END,
  json_extract(layer.value, '$.createdAt'),
  s.updated_at
FROM map_workspace_state s,
     json_each(s.data_layers_json) layer
WHERE json_valid(s.data_layers_json)
  AND json_type(s.data_layers_json) = 'array';

INSERT OR IGNORE INTO map_workspace_layer_annotations (
  organization_id, layer_id, ann_id, geometry, geom_type,
  annotation_type, name, note, color, icon, utility_type, document_ref, line_pattern,
  original_name, created_at, created_by, last_edited_by, updated_at
)
SELECT
  s.organization_id,
  COALESCE(json_extract(layer.value, '$.id'), 'legacy-layer-' || s.organization_id || '-' || layer.key),
  COALESCE(json_extract(ann.value, '$.id'), 'legacy-ann-' || s.organization_id || '-' || layer.key || '-' || ann.key),
  json_extract(ann.value, '$.geometry'),
  json_extract(ann.value, '$.geometry.type'),
  json_extract(ann.value, '$.type'),
  json_extract(ann.value, '$.name'),
  json_extract(ann.value, '$.note'),
  json_extract(ann.value, '$.color'),
  json_extract(ann.value, '$.icon'),
  json_extract(ann.value, '$.utilityType'),
  json_extract(ann.value, '$.documentRef'),
  json_extract(ann.value, '$.linePattern'),
  json_extract(ann.value, '$.originalName'),
  json_extract(ann.value, '$.createdAt'),
  json_extract(ann.value, '$.createdBy'),
  json_extract(ann.value, '$.lastEditedBy'),
  s.updated_at
FROM map_workspace_state s,
     json_each(s.data_layers_json) layer,
     json_each(layer.value, '$.annotations') ann
WHERE json_valid(s.data_layers_json)
  AND json_type(s.data_layers_json) = 'array'
  AND json_type(layer.value, '$.annotations') = 'array'
  AND json_extract(ann.value, '$.geometry') IS NOT NULL;

DROP TABLE map_workspace_data_layers;
ALTER TABLE map_workspace_data_layers__m10 RENAME TO map_workspace_data_layers;

-- Tickets: promoted scalars/full polygon + repeated display structures.
ALTER TABLE tickets ADD COLUMN ticket_expires_at TEXT;
ALTER TABLE tickets ADD COLUMN address TEXT;
ALTER TABLE tickets ADD COLUMN polygon_json TEXT;
ALTER TABLE tickets ADD COLUMN ngen_job_number TEXT;
ALTER TABLE tickets ADD COLUMN ngen_enquiry_status TEXT;
ALTER TABLE tickets ADD COLUMN lodged_by_user_name TEXT;

CREATE TABLE IF NOT EXISTS ticket_operator_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  response_index INTEGER NOT NULL DEFAULT 0,
  response_id TEXT,
  station_code TEXT,
  operator_name TEXT,
  operator_code TEXT,
  status_code TEXT,
  operator_status TEXT,
  responded_at TEXT,
  comment TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  UNIQUE(ticket_id, response_index)
);

CREATE TABLE IF NOT EXISTS ticket_history_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  event_index INTEGER NOT NULL DEFAULT 0,
  event_id TEXT,
  ticket_number TEXT,
  station_code TEXT,
  station_code_name TEXT,
  operator_name TEXT,
  operator_code TEXT,
  status_code TEXT,
  responded_at TEXT,
  response_received TEXT,
  comment TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  UNIQUE(ticket_id, event_index)
);

UPDATE tickets
SET
  ticket_expires_at = COALESCE(
    json_extract(ticket_data, '$.ticketExpirationDate'),
    json_extract(ticket_data, '$.endTime'),
    json_extract(ticket_data, '$.dueDate'),
    json_extract(ticket_data, '$.workExpirationDate')
  ),
  address = COALESCE(
    json_extract(ticket_data, '$.address'),
    json_extract(ticket_data, '$.digSiteAddress'),
    json_extract(ticket_data, '$.locationSummary')
  ),
  polygon_json = json_extract(ticket_data, '$.polygon'),
  ngen_job_number = json_extract(ticket_data, '$.ngenJobNumber'),
  ngen_enquiry_status = json_extract(ticket_data, '$.ngenEnquiryStatus'),
  lodged_by_user_name = LOWER(TRIM(json_extract(ticket_data, '$.lodgedByUserName')))
WHERE json_valid(ticket_data);

INSERT OR IGNORE INTO ticket_operator_responses (
  ticket_id, response_index, response_id, station_code, operator_name, operator_code,
  status_code, operator_status, responded_at, comment
)
SELECT
  t.id,
  CAST(op.key AS INTEGER),
  json_extract(op.value, '$.id'),
  json_extract(op.value, '$.stationCode'),
  json_extract(op.value, '$.operatorName'),
  json_extract(op.value, '$.operatorCode'),
  json_extract(op.value, '$.statusCode'),
  json_extract(op.value, '$.operatorStatus'),
  json_extract(op.value, '$.respondedAt'),
  json_extract(op.value, '$.comment')
FROM tickets t,
     json_each(t.ticket_data, '$.operatorResponses') op
WHERE json_valid(t.ticket_data)
  AND json_type(t.ticket_data, '$.operatorResponses') = 'array';

INSERT OR IGNORE INTO ticket_history_events (
  ticket_id, event_index, event_id, ticket_number, station_code, station_code_name,
  operator_name, operator_code, status_code, responded_at, response_received, comment
)
SELECT
  t.id,
  CAST(h.key AS INTEGER),
  json_extract(h.value, '$.id'),
  json_extract(h.value, '$.ticketNumber'),
  json_extract(h.value, '$.stationCode'),
  json_extract(h.value, '$.stationCodeName'),
  json_extract(h.value, '$.operatorName'),
  json_extract(h.value, '$.operatorCode'),
  json_extract(h.value, '$.statusCode'),
  json_extract(h.value, '$.respondedAt'),
  json_extract(h.value, '$.responseReceived'),
  json_extract(h.value, '$.comment')
FROM tickets t,
     json_each(t.ticket_data, '$.history') h
WHERE json_valid(t.ticket_data)
  AND json_type(t.ticket_data, '$.history') = 'array';

CREATE INDEX IF NOT EXISTS idx_map_ws_ann_org ON map_workspace_annotations(organization_id);
CREATE INDEX IF NOT EXISTS idx_map_ws_ann_bbox ON map_workspace_annotations(organization_id, min_lng, max_lng, min_lat, max_lat);
CREATE INDEX IF NOT EXISTS idx_map_ws_layer_org ON map_workspace_data_layers(organization_id);
CREATE INDEX IF NOT EXISTS idx_map_ws_layer_ann_layer ON map_workspace_layer_annotations(organization_id, layer_id);
CREATE INDEX IF NOT EXISTS idx_ticket_operator_responses_ticket ON ticket_operator_responses(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_operator_responses_station ON ticket_operator_responses(station_code);
CREATE INDEX IF NOT EXISTS idx_ticket_history_events_ticket ON ticket_history_events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_tickets_expires ON tickets(ticket_expires_at);
CREATE INDEX IF NOT EXISTS idx_tickets_ngen_job ON tickets(ngen_job_number);
CREATE INDEX IF NOT EXISTS idx_tickets_lodged_by ON tickets(lodged_by_user_name);

DELETE FROM sqlite_sequence WHERE name IN (
  'login_history',
  'map_workspace_annotations',
  'map_workspace_data_layers'
);
INSERT INTO sqlite_sequence (name, seq)
SELECT 'login_history', COALESCE((SELECT MAX(id) FROM login_history), 0)
UNION ALL
SELECT 'map_workspace_annotations', COALESCE((SELECT MAX(id) FROM map_workspace_annotations), 0)
UNION ALL
SELECT 'map_workspace_data_layers', COALESCE((SELECT MAX(id) FROM map_workspace_data_layers), 0);

PRAGMA foreign_keys = ON;
