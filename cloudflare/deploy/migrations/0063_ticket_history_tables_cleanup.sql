-- POSR history rename/trim + nGen history formalize (drop raw_json).
-- API/JSON field remains ticket_data.history / ticket.history.
-- Existing history rows are test data only — clear them; no raw_json backfill.
-- Attachments intentionally omitted from nGen formalization.

-- --- POSR map/scrape history ---
ALTER TABLE ticket_history_events RENAME TO ticket_posr_notification_history;

ALTER TABLE ticket_posr_notification_history DROP COLUMN event_id;
ALTER TABLE ticket_posr_notification_history DROP COLUMN ticket_number;
ALTER TABLE ticket_posr_notification_history DROP COLUMN station_code;
ALTER TABLE ticket_posr_notification_history DROP COLUMN station_code_name;

DROP INDEX IF EXISTS idx_ticket_history_events_ticket;
CREATE INDEX IF NOT EXISTS idx_ticket_posr_notification_history_ticket
  ON ticket_posr_notification_history(ticket_id);

DELETE FROM ticket_posr_notification_history;

-- --- nGen notification history ---
DELETE FROM ticket_ngen_notification_history;

ALTER TABLE ticket_ngen_notification_history ADD COLUMN updated_by TEXT;
ALTER TABLE ticket_ngen_notification_history ADD COLUMN is_disputed INTEGER;
ALTER TABLE ticket_ngen_notification_history ADD COLUMN dispute_locate_code TEXT;
ALTER TABLE ticket_ngen_notification_history ADD COLUMN enquiry_id TEXT;

ALTER TABLE ticket_ngen_notification_history DROP COLUMN raw_json;
