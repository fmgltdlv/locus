-- Idempotent client id for offline ticket note sync retries.

ALTER TABLE ticket_notes ADD COLUMN client_note_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_notes_client_note_id
  ON ticket_notes(client_note_id)
  WHERE client_note_id IS NOT NULL AND TRIM(client_note_id) != '';
