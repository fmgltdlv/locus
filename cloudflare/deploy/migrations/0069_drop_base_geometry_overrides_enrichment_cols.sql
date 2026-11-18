-- Dig-site geometry lives on tickets.polygon_json (shared across revisions via app propagate).
-- Operator/photo overrides replaced by ticket_workflow_acks.
-- Enrichment table keeps job_number only.

DROP TABLE IF EXISTS ticket_base_geometry;
DROP TABLE IF EXISTS ticket_overrides;

ALTER TABLE ticket_pacweb_enrichment DROP COLUMN pacweb_enquiry_id;
ALTER TABLE ticket_pacweb_enrichment DROP COLUMN request_number;
