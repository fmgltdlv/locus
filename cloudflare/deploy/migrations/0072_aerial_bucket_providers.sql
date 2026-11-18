-- Admin-managed GCS buckets for on-demand aerial folder search (no auto-sync).
CREATE TABLE IF NOT EXISTS aerial_bucket_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  bucket TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT 'outputs/',
  tileset_suffix TEXT NOT NULL DEFAULT 'orthophoto_tiles/tilemapresource.xml',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_aerial_bucket_providers_bucket_prefix
  ON aerial_bucket_providers (bucket, prefix);

INSERT INTO aerial_bucket_providers (name, bucket, prefix, tileset_suffix, enabled)
VALUES (
  'ASC NodeODM prod',
  'asc-nodeodm-outputs-prod',
  'outputs/',
  'orthophoto_tiles/tilemapresource.xml',
  1
);
