-- Reverse 0040: precomputed ticket ↔ aerial intersections (badges removed).
DROP INDEX IF EXISTS idx_ticket_aerial_intersections_map;
DROP TABLE IF EXISTS ticket_aerial_intersections;
ALTER TABLE tickets DROP COLUMN has_aerial_imagery;
