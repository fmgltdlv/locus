-- PAC web enrichment (GetEnquiryBySubset revision tracking) was removed; nothing reads this column.

ALTER TABLE ticket_pacweb_enrichment DROP COLUMN revision;
