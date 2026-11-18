-- Footprint is stored in min_lng / min_lat / max_lng / max_lat; bounding_box TEXT is unused.
ALTER TABLE aerial_maps DROP COLUMN bounding_box;
