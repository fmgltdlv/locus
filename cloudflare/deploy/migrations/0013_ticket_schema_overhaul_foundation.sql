-- Ticket schema overhaul foundation.
--
-- This migration adds the column-first storage model while leaving ticket_data in
-- place for the transition/backfill window. A later cutover migration can drop
-- ticket_data after every reader and writer uses these columns and child tables.

ALTER TABLE tickets ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 2;
ALTER TABLE tickets ADD COLUMN revision TEXT;
ALTER TABLE tickets ADD COLUMN job_number TEXT;
ALTER TABLE tickets ADD COLUMN previous_ticket_number TEXT;
ALTER TABLE tickets ADD COLUMN current_ngen_enquiry_status TEXT;
ALTER TABLE tickets ADD COLUMN lodged_on TEXT;
ALTER TABLE tickets ADD COLUMN ngen_last_updated_time TEXT;
ALTER TABLE tickets ADD COLUMN original_lodged_by_user_name TEXT;
ALTER TABLE tickets ADD COLUMN current_lodged_by_user_name TEXT;
ALTER TABLE tickets ADD COLUMN commencement_date TEXT;
ALTER TABLE tickets ADD COLUMN work_legal_start_date TEXT;
ALTER TABLE tickets ADD COLUMN full_address TEXT;
ALTER TABLE tickets ADD COLUMN dig_site_prefix TEXT;
ALTER TABLE tickets ADD COLUMN dig_site_street TEXT;
ALTER TABLE tickets ADD COLUMN dig_site_city TEXT;
ALTER TABLE tickets ADD COLUMN dig_site_postcode TEXT;
ALTER TABLE tickets ADD COLUMN dig_site_state TEXT;
ALTER TABLE tickets ADD COLUMN dig_site_county TEXT;
ALTER TABLE tickets ADD COLUMN nearest_cross_street TEXT;
ALTER TABLE tickets ADD COLUMN ngen_ticket_type TEXT;
ALTER TABLE tickets ADD COLUMN category_of_work TEXT;
ALTER TABLE tickets ADD COLUMN work_activity TEXT;
ALTER TABLE tickets ADD COLUMN excavation_method TEXT;
ALTER TABLE tickets ADD COLUMN excavation_depth TEXT;
ALTER TABLE tickets ADD COLUMN working_on_behalf TEXT;
ALTER TABLE tickets ADD COLUMN working_on_behalf_of_auth TEXT;
ALTER TABLE tickets ADD COLUMN user_reference TEXT;
ALTER TABLE tickets ADD COLUMN scope_of_work TEXT;
ALTER TABLE tickets ADD COLUMN priority TEXT;
ALTER TABLE tickets ADD COLUMN principal_contact_name TEXT;
ALTER TABLE tickets ADD COLUMN principal_contact_phone TEXT;
ALTER TABLE tickets ADD COLUMN required_response_count INTEGER;
ALTER TABLE tickets ADD COLUMN received_response_count INTEGER;
ALTER TABLE tickets ADD COLUMN is_boring INTEGER;
ALTER TABLE tickets ADD COLUMN is_blasting INTEGER;
ALTER TABLE tickets ADD COLUMN can_be_amended INTEGER;
ALTER TABLE tickets ADD COLUMN can_be_no_response INTEGER;
ALTER TABLE tickets ADD COLUMN can_be_remark INTEGER;
ALTER TABLE tickets ADD COLUMN can_be_damage INTEGER;
ALTER TABLE tickets ADD COLUMN can_be_renewal INTEGER;
ALTER TABLE tickets ADD COLUMN can_be_exposed INTEGER;

UPDATE tickets
SET
  revision = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ticketRevision') END,
    revision
  ),
  job_number = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenJobNumber') END,
    ngen_job_number,
    job_number
  ),
  previous_ticket_number = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenPreviousRequestNumber') END,
    previous_ticket_number
  ),
  current_ngen_enquiry_status = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenEnquiryStatus') END,
    ngen_enquiry_status,
    current_ngen_enquiry_status
  ),
  lodged_on = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenLodgedOn') END,
    lodged_on
  ),
  ngen_last_updated_time = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenLastUpdatedTime') END,
    ngen_last_updated_time
  ),
  original_lodged_by_user_name = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN LOWER(TRIM(json_extract(ticket_data, '$.originalLodgedByUserName'))) END,
    lodged_by_user_name,
    original_lodged_by_user_name
  ),
  current_lodged_by_user_name = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN LOWER(TRIM(json_extract(ticket_data, '$.lodgedByUserName'))) END,
    lodged_by_user_name,
    current_lodged_by_user_name
  ),
  commencement_date = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.startTime') END,
    commencement_date
  ),
  work_legal_start_date = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.legalStartDate') END,
    work_legal_start_date
  ),
  full_address = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.fullAddress') END,
    full_address
  ),
  dig_site_prefix = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.digSitePrefix') END,
    dig_site_prefix
  ),
  dig_site_street = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.digSiteStreet') END,
    dig_site_street
  ),
  dig_site_city = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.city') END,
    dig_site_city
  ),
  dig_site_postcode = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.zipcode') END,
    dig_site_postcode
  ),
  dig_site_state = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.state') END,
    dig_site_state
  ),
  dig_site_county = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.county') END,
    dig_site_county
  ),
  nearest_cross_street = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.nearbyCrossStreet') END,
    nearest_cross_street
  ),
  ngen_ticket_type = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenTicketType') END,
    ngen_ticket_type
  ),
  category_of_work = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.categoryOfWork') END,
    category_of_work
  ),
  work_activity = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.workActivity') END,
    work_activity
  ),
  excavation_method = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.excavationMethod') END,
    excavation_method
  ),
  excavation_depth = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenExcavationDepth') END,
    excavation_depth
  ),
  working_on_behalf = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenWorkingOnBehalf') END,
    working_on_behalf
  ),
  working_on_behalf_of_auth = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenWorkingOnBehalfOfAuth') END,
    working_on_behalf_of_auth
  ),
  user_reference = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenUserReference') END,
    user_reference
  ),
  scope_of_work = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.scopeOfWork') END,
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ticketScope') END,
    scope_of_work
  ),
  priority = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenPriority') END,
    priority
  ),
  principal_contact_name = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenPrincipalContactName') END,
    principal_contact_name
  ),
  principal_contact_phone = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenPrincipalContactPhone') END,
    principal_contact_phone
  ),
  required_response_count = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenRequiredResponseCount') END,
    required_response_count
  ),
  received_response_count = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.ngenReceivedResponseCount') END,
    received_response_count
  ),
  is_boring = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.isBoring') END,
    is_boring
  ),
  is_blasting = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.isBlasting') END,
    is_blasting
  ),
  can_be_amended = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.canBeAmended') END,
    can_be_amended
  ),
  can_be_no_response = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.canBeNoResponse') END,
    can_be_no_response
  ),
  can_be_remark = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.canBeRemark') END,
    can_be_remark
  ),
  can_be_damage = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.canBeDamage') END,
    can_be_damage
  ),
  can_be_renewal = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.canBeRenewal') END,
    can_be_renewal
  ),
  can_be_exposed = COALESCE(
    CASE WHEN json_valid(ticket_data) THEN json_extract(ticket_data, '$.canBeExposed') END,
    can_be_exposed
  )
WHERE json_valid(ticket_data);

CREATE TABLE IF NOT EXISTS ticket_imported_orgs (
  ticket_id INTEGER NOT NULL,
  organization_id INTEGER NOT NULL,
  imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  source TEXT,
  PRIMARY KEY (ticket_id, organization_id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ticket_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  revision TEXT NOT NULL,
  status TEXT NOT NULL,
  observed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_endpoint TEXT NOT NULL DEFAULT 'GetCurrentUserEnquiryAsync',
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  UNIQUE(ticket_id, revision, status)
);

CREATE TABLE IF NOT EXISTS ticket_lineage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  ticket_number TEXT NOT NULL,
  revision TEXT,
  job_number TEXT,
  previous_ticket_number TEXT NOT NULL,
  previous_base_number TEXT,
  previous_revision TEXT,
  observed_from_job_number TEXT,
  observed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_endpoint TEXT NOT NULL DEFAULT 'GetCurrentUserEnquiryAsync',
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  UNIQUE(ticket_id, revision, previous_ticket_number)
);

INSERT OR IGNORE INTO ticket_status_history (ticket_id, revision, status)
SELECT
  id,
  COALESCE(revision, '000'),
  current_ngen_enquiry_status
FROM tickets
WHERE current_ngen_enquiry_status IS NOT NULL
  AND TRIM(current_ngen_enquiry_status) <> '';

INSERT OR IGNORE INTO ticket_lineage_events (
  ticket_id, ticket_number, revision, job_number, previous_ticket_number,
  previous_base_number, previous_revision, observed_from_job_number
)
SELECT
  id,
  ticket_number,
  revision,
  job_number,
  previous_ticket_number,
  CASE
    WHEN instr(previous_ticket_number, '-') > 0 THEN substr(previous_ticket_number, 1, instr(previous_ticket_number, '-') - 1)
    ELSE previous_ticket_number
  END,
  CASE
    WHEN instr(previous_ticket_number, '-') > 0 THEN substr(previous_ticket_number, instr(previous_ticket_number, '-') + 1)
    ELSE NULL
  END,
  job_number
FROM tickets
WHERE previous_ticket_number IS NOT NULL
  AND TRIM(previous_ticket_number) <> '';

CREATE INDEX IF NOT EXISTS idx_tickets_revision ON tickets(organization_id, ticket_number, revision);
CREATE INDEX IF NOT EXISTS idx_tickets_job_number ON tickets(job_number);
CREATE INDEX IF NOT EXISTS idx_tickets_current_status ON tickets(current_ngen_enquiry_status);
CREATE INDEX IF NOT EXISTS idx_tickets_current_lodged_by ON tickets(current_lodged_by_user_name);
CREATE INDEX IF NOT EXISTS idx_ticket_imported_orgs_org ON ticket_imported_orgs(organization_id);
CREATE INDEX IF NOT EXISTS idx_ticket_status_history_ticket ON ticket_status_history(ticket_id, revision);
CREATE INDEX IF NOT EXISTS idx_ticket_lineage_previous ON ticket_lineage_events(previous_ticket_number);
