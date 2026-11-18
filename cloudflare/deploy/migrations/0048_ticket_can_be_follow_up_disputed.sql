-- Persist Follow Up / Dispute eligibility flags from USAN poll.
PRAGMA foreign_keys = ON;

ALTER TABLE tickets ADD COLUMN can_be_follow_up INTEGER;
ALTER TABLE tickets ADD COLUMN can_be_disputed INTEGER;
