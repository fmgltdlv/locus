-- Clean up legacy JSON string sentinels that should be SQL NULLs.

UPDATE tickets
SET previous_ticket_number = NULL
WHERE LOWER(TRIM(previous_ticket_number)) IN ('null', 'undefined', '');

UPDATE tickets
SET job_number = NULL
WHERE LOWER(TRIM(job_number)) IN ('null', 'undefined', '');

UPDATE tickets
SET current_ngen_enquiry_status = NULL
WHERE LOWER(TRIM(current_ngen_enquiry_status)) IN ('null', 'undefined', '');

UPDATE tickets
SET original_lodged_by_user_name = NULL
WHERE LOWER(TRIM(original_lodged_by_user_name)) IN ('null', 'undefined', '');

UPDATE tickets
SET current_lodged_by_user_name = NULL
WHERE LOWER(TRIM(current_lodged_by_user_name)) IN ('null', 'undefined', '');

DELETE FROM ticket_lineage_events
WHERE LOWER(TRIM(previous_ticket_number)) IN ('null', 'undefined', '');
