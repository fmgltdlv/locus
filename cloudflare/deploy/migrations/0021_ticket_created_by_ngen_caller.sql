-- Combined "Created by" display name (e.g. nGen callerDetails first + last) on tickets.

ALTER TABLE tickets ADD COLUMN created_by TEXT;
