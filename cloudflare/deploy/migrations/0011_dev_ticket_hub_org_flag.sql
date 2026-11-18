-- Dev Ticket Hub org: global dev users selecting this org can read tickets across all orgs.
ALTER TABLE organizations ADD COLUMN is_dev_ticket_hub INTEGER NOT NULL DEFAULT 0;
