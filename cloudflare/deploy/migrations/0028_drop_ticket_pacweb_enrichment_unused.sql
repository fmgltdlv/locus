-- Unused columns: never read; upsert only nulled them on conflict.

ALTER TABLE ticket_pacweb_enrichment DROP COLUMN confirmation_pdf_path;
ALTER TABLE ticket_pacweb_enrichment DROP COLUMN positive_response_pdf_path;
ALTER TABLE ticket_pacweb_enrichment DROP COLUMN parsed_fields_json;
ALTER TABLE ticket_pacweb_enrichment DROP COLUMN enrichment_error;
