CREATE INDEX IF NOT EXISTS idx_media_photo_map_org_type_gps_created
ON media_files (organization_id, file_type, has_gps, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_photo_map_org_lat_lng
ON media_files (organization_id, latitude, longitude)
WHERE has_gps = 1;
