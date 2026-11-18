-- Optional seed for local partnership-ticket-smoke (run after dev_user.sql).
-- Creates org 901 (owner) and 902 (viewer), accepted partnership, one active shared ticket on 901.
-- Adjust user_organizations if your dev_user.sql uses different user ids.

INSERT OR IGNORE INTO organizations (id, name, is_public_catalog)
VALUES (901, 'Dev Partner Owner Org', 0),
       (902, 'Dev Partner Viewer Org', 0);

INSERT OR IGNORE INTO organization_partnerships (id, org_low_id, org_high_id, status, initiated_by_org_id)
VALUES (9001, 901, 902, 'accepted', 901);

INSERT OR IGNORE INTO organization_sharing_rules (
    partnership_id,
    source_org_id,
    share_tickets,
    share_photos,
    share_saved_layers,
    share_reported_events,
    source_identity_mode
)
VALUES (9001, 901, 1, 1, 0, 0, 'named');
