-- Remove unused summary column (UI uses codeDescription / raw).

ALTER TABLE ticket_ngen_notification_history DROP COLUMN summary;
