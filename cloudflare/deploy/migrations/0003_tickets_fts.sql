-- FTS5 for ticket work_description search (parity with backend/database.js migrateTicketIndexedColumns)
CREATE VIRTUAL TABLE IF NOT EXISTS tickets_fts USING fts5(
  work_description,
  content='tickets',
  content_rowid='id',
  tokenize='unicode61'
);

INSERT INTO tickets_fts(tickets_fts) VALUES('rebuild');

CREATE TRIGGER IF NOT EXISTS tickets_ai_fts AFTER INSERT ON tickets BEGIN
  INSERT INTO tickets_fts(rowid, work_description) VALUES (new.id, new.work_description);
END;

CREATE TRIGGER IF NOT EXISTS tickets_ad_fts AFTER DELETE ON tickets BEGIN
  INSERT INTO tickets_fts(tickets_fts, rowid, work_description) VALUES('delete', old.id, old.work_description);
END;

CREATE TRIGGER IF NOT EXISTS tickets_au_fts AFTER UPDATE ON tickets BEGIN
  INSERT INTO tickets_fts(tickets_fts, rowid, work_description) VALUES('delete', old.id, old.work_description);
  INSERT INTO tickets_fts(rowid, work_description) VALUES (new.id, new.work_description);
END;
