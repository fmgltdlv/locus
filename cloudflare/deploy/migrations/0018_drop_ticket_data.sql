-- Drop the legacy ticket_data blob now that ticket reads/writes use columns and child tables.

ALTER TABLE tickets DROP COLUMN ticket_data;
