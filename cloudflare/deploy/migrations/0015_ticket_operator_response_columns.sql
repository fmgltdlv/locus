-- Preserve nGen notification identity fields in the canonical operator response table.

ALTER TABLE ticket_operator_responses ADD COLUMN authority_id TEXT;
ALTER TABLE ticket_operator_responses ADD COLUMN source TEXT;
ALTER TABLE ticket_operator_responses ADD COLUMN ticket_revision_snapshot TEXT;
ALTER TABLE ticket_operator_responses ADD COLUMN ticket_number_full_snapshot TEXT;

UPDATE ticket_operator_responses
SET
  authority_id = (
    SELECT json_extract(op.value, '$.authorityId')
    FROM tickets t, json_each(t.ticket_data, '$.operatorResponses') op
    WHERE t.id = ticket_operator_responses.ticket_id
      AND CAST(op.key AS INTEGER) = ticket_operator_responses.response_index
      AND json_valid(t.ticket_data)
      AND json_type(t.ticket_data, '$.operatorResponses') = 'array'
  ),
  source = (
    SELECT json_extract(op.value, '$.source')
    FROM tickets t, json_each(t.ticket_data, '$.operatorResponses') op
    WHERE t.id = ticket_operator_responses.ticket_id
      AND CAST(op.key AS INTEGER) = ticket_operator_responses.response_index
      AND json_valid(t.ticket_data)
      AND json_type(t.ticket_data, '$.operatorResponses') = 'array'
  ),
  ticket_revision_snapshot = (
    SELECT json_extract(op.value, '$.ticketRevisionSnapshot')
    FROM tickets t, json_each(t.ticket_data, '$.operatorResponses') op
    WHERE t.id = ticket_operator_responses.ticket_id
      AND CAST(op.key AS INTEGER) = ticket_operator_responses.response_index
      AND json_valid(t.ticket_data)
      AND json_type(t.ticket_data, '$.operatorResponses') = 'array'
  ),
  ticket_number_full_snapshot = (
    SELECT json_extract(op.value, '$.ticketNumberFullSnapshot')
    FROM tickets t, json_each(t.ticket_data, '$.operatorResponses') op
    WHERE t.id = ticket_operator_responses.ticket_id
      AND CAST(op.key AS INTEGER) = ticket_operator_responses.response_index
      AND json_valid(t.ticket_data)
      AND json_type(t.ticket_data, '$.operatorResponses') = 'array'
  );

CREATE INDEX IF NOT EXISTS idx_ticket_operator_responses_authority ON ticket_operator_responses(authority_id);
