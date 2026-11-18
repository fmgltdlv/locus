-- Native TMS zoom range from tilemapresource.xml (parsed once at catalog add time).
ALTER TABLE aerial_maps ADD COLUMN min_native_zoom INTEGER;
ALTER TABLE aerial_maps ADD COLUMN max_native_zoom INTEGER;
