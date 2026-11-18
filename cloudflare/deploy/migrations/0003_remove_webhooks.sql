-- Remove legacy webhook queue (Node Worker port no longer uses inbound webhooks).
PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS webhook_inbox;
