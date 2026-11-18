-- Per-map flag: exclude from end-user aerial discovery (for-view, public catalog search).
ALTER TABLE aerial_maps ADD COLUMN hidden_from_users INTEGER NOT NULL DEFAULT 0;
