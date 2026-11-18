-- Org-restricted aerial catalog: access_mode replaces boolean hidden_from_users for discovery.
ALTER TABLE aerial_maps ADD COLUMN access_mode TEXT;

UPDATE aerial_maps SET access_mode = 'hidden' WHERE COALESCE(hidden_from_users, 0) = 1;
UPDATE aerial_maps SET access_mode = 'global' WHERE access_mode IS NULL;

CREATE TABLE IF NOT EXISTS aerial_map_org_access (
  aerial_map_id INTEGER NOT NULL,
  organization_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id INTEGER,
  PRIMARY KEY (aerial_map_id, organization_id),
  FOREIGN KEY (aerial_map_id) REFERENCES aerial_maps(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_aerial_map_org_access_org
  ON aerial_map_org_access (organization_id);
