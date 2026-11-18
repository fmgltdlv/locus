-- System-managed public catalog↔Plus/Max partnerships; block casual delete
ALTER TABLE organization_partnerships ADD COLUMN is_system_managed INTEGER NOT NULL DEFAULT 0;
