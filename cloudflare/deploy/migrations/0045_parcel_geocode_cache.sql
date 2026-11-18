-- Cached assessor parcel situs addresses (Clark County NV GISMO today; keyed by parcel id).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS parcel_geocode_cache (
  parcel_id TEXT PRIMARY KEY,
  site_address TEXT NOT NULL,
  zip_code TEXT,
  provider TEXT NOT NULL DEFAULT 'clark_nv_gismo',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_parcel_geocode_cache_updated ON parcel_geocode_cache(updated_at);
