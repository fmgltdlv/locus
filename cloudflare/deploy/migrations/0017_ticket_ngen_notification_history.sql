-- Normalize nGen GetNotificationResponseHistoryAsync rows out of ticket_data.

CREATE TABLE IF NOT EXISTS ticket_ngen_notification_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  authority_id TEXT NOT NULL,
  entry_index INTEGER NOT NULL DEFAULT 0,
  responded_at TEXT,
  status_code TEXT,
  code_description TEXT,
  notes_comment TEXT,
  summary TEXT,
  raw_json TEXT,
  error TEXT,
  request_number TEXT,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  UNIQUE(ticket_id, authority_id, entry_index)
);

INSERT OR IGNORE INTO ticket_ngen_notification_history (
  ticket_id,
  authority_id,
  entry_index,
  responded_at,
  status_code,
  code_description,
  notes_comment,
  summary,
  raw_json,
  request_number,
  fetched_at
)
SELECT
  t.id,
  json_extract(u.value, '$.authorityId'),
  CAST(e.key AS INTEGER),
  json_extract(e.value, '$.at'),
  json_extract(e.value, '$.code'),
  json_extract(e.value, '$.codeDescription'),
  json_extract(e.value, '$.notesComment'),
  json_extract(e.value, '$.summary'),
  json_extract(e.value, '$.raw'),
  json_extract(t.ticket_data, '$.ngenResponseHistory.requestNumber'),
  COALESCE(json_extract(t.ticket_data, '$.ngenResponseHistory.fetchedAt'), CURRENT_TIMESTAMP)
FROM tickets t,
     json_each(t.ticket_data, '$.ngenResponseHistory.normalized.utilities') u,
     json_each(u.value, '$.entries') e
WHERE json_valid(t.ticket_data)
  AND json_type(t.ticket_data, '$.ngenResponseHistory.normalized.utilities') = 'array'
  AND json_extract(u.value, '$.authorityId') IS NOT NULL;

INSERT OR IGNORE INTO ticket_ngen_notification_history (
  ticket_id,
  authority_id,
  entry_index,
  error,
  request_number,
  fetched_at
)
SELECT
  t.id,
  json_extract(u.value, '$.authorityId'),
  -1,
  json_extract(u.value, '$.error'),
  json_extract(t.ticket_data, '$.ngenResponseHistory.requestNumber'),
  COALESCE(json_extract(t.ticket_data, '$.ngenResponseHistory.fetchedAt'), CURRENT_TIMESTAMP)
FROM tickets t,
     json_each(t.ticket_data, '$.ngenResponseHistory.normalized.utilities') u
WHERE json_valid(t.ticket_data)
  AND json_type(t.ticket_data, '$.ngenResponseHistory.normalized.utilities') = 'array'
  AND json_extract(u.value, '$.authorityId') IS NOT NULL
  AND json_extract(u.value, '$.error') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ticket_ngen_notification_history_ticket
  ON ticket_ngen_notification_history(ticket_id, authority_id, entry_index);
