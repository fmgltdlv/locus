-- Speed GET /tickets list ordering: WHERE organization_id = ? ORDER BY created_at DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_tickets_org_created_id ON tickets (organization_id, created_at DESC, id DESC);
