-- Normalize ticket assignment out of ticket_data.

CREATE TABLE IF NOT EXISTS ticket_assignees (
  ticket_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT,
  assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticket_id, user_id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO ticket_assignees (ticket_id, user_id, user_name)
SELECT
  t.id,
  CAST(json_extract(a.value, '$.userId') AS INTEGER),
  json_extract(a.value, '$.userName')
FROM tickets t,
     json_each(t.ticket_data, '$.assignedToUsers') a
WHERE json_valid(t.ticket_data)
  AND json_type(t.ticket_data, '$.assignedToUsers') = 'array'
  AND json_extract(a.value, '$.userId') IS NOT NULL
  AND CAST(json_extract(a.value, '$.userId') AS INTEGER) > 0;

INSERT OR IGNORE INTO ticket_assignees (ticket_id, user_id, user_name)
SELECT
  id,
  CAST(json_extract(ticket_data, '$.assignedToUserId') AS INTEGER),
  json_extract(ticket_data, '$.assignedToUserName')
FROM tickets
WHERE json_valid(ticket_data)
  AND json_extract(ticket_data, '$.assignedToUserId') IS NOT NULL
  AND CAST(json_extract(ticket_data, '$.assignedToUserId') AS INTEGER) > 0;

CREATE INDEX IF NOT EXISTS idx_ticket_assignees_user ON ticket_assignees(user_id);
