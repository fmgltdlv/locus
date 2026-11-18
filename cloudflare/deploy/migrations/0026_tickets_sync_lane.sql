-- Sync lane: isolates refresh sibling fanout (posr_public vs ngen_primary).
-- Default ngen_primary for existing rows; manually set posr_public for known public-POSR imports, e.g.:
--   UPDATE tickets SET sync_lane = 'posr_public' WHERE id IN (...);

ALTER TABLE tickets ADD COLUMN sync_lane TEXT NOT NULL DEFAULT 'ngen_primary';
