/**
 * Feed map-markers + scan-maps helpers (owner-org ticket geometry, no copy into feed org).
 */

const { allRows, getRow, runDb } = require('./db.cjs');
const {
    loadGlobalAerialMaps,
    parseBoundingBox,
    ticketPolygonIntersectsFootprint,
    rowToMap,
} = require('./aerialMapQuery.cjs');
const { applyIndexedColumnsToTicketShape } = require('./ticketIndexedColumns.cjs');
const {
    FEED_ACTIVE_STATUSES,
    parseFeedServiceRequestNote,
    isFeedIncompleteLike,
} = require('./feedServiceRequestNote.cjs');

function ticketAnchorMs(row) {
    const lodged = row && (row.lodged_on || row.lodgedOn);
    if (lodged) {
        const t = Date.parse(String(lodged));
        if (Number.isFinite(t)) return t;
    }
    const created = row && (row.created_at || row.createdAt);
    if (created) {
        const t = Date.parse(String(created));
        if (Number.isFinite(t)) return t;
    }
    return null;
}

function mapCaptureMs(mapRowOrClient) {
    const raw =
        (mapRowOrClient && (mapRowOrClient.captured_at || mapRowOrClient.capturedAt)) ||
        (mapRowOrClient && (mapRowOrClient.created_at || mapRowOrClient.createdAt));
    if (!raw) return null;
    const t = Date.parse(String(raw));
    return Number.isFinite(t) ? t : null;
}

/**
 * Load lean ticket row by org + ticket number (base or full).
 * @returns {Promise<object|null>}
 */
async function loadOwnerTicketLean(db, organizationId, ticketNumber) {
    const orgId = Number(organizationId);
    const tn = ticketNumber != null ? String(ticketNumber).trim() : '';
    if (!Number.isFinite(orgId) || !tn) return null;

    // Column-first tickets schema (ticket_data dropped in migration 0018).
    const leanSelect = `SELECT id, organization_id, ticket_number, revision, polygon_json, pin_lng, pin_lat,
                min_lng, min_lat, max_lng, max_lat, ticket_expires_at, lodged_on, created_at,
                ngen_enquiry_status, current_ngen_enquiry_status,
                required_response_count, received_response_count,
                sync_lane
         FROM tickets
         WHERE organization_id = ? AND ticket_number = ?
         LIMIT 1`;

    let row = await getRow(db, leanSelect, [orgId, tn]);
    if (!row) {
        // Try base number match when full number was stored in note
        const base = tn.includes('-') ? tn.split('-')[0].trim() : tn;
        if (base && base !== tn) {
            row = await getRow(db, leanSelect, [orgId, base]);
        }
    }
    return row || null;
}

/**
 * Build client-ish ticket object for computeFeedTicketStatus.
 */
function leanRowToTicketShape(row) {
    if (!row) return null;
    const indexed = applyIndexedColumnsToTicketShape({}, row);
    return {
        ...indexed,
        id: row.id,
        organizationId: row.organization_id,
        ticketNumber: row.ticket_number || indexed.ticketNumber,
        ticketRevision: row.revision || indexed.ticketRevision,
        ngenEnquiryStatus:
            row.current_ngen_enquiry_status ||
            row.ngen_enquiry_status ||
            indexed.ngenEnquiryStatus,
        ngenRequiredResponseCount:
            row.required_response_count != null
                ? Number(row.required_response_count)
                : indexed.ngenRequiredResponseCount,
        ngenReceivedResponseCount:
            row.received_response_count != null
                ? Number(row.received_response_count)
                : indexed.ngenReceivedResponseCount,
        ticketExpirationDate: row.ticket_expires_at || indexed.ticketExpirationDate,
        lodged_on: row.lodged_on,
        created_at: row.created_at,
        syncLane: row.sync_lane || indexed.syncLane,
        polygon: indexed.polygon || null,
        stubMapPin: indexed.stubMapPin || null,
        bbox: indexed.bbox || null,
    };
}

function markerFromLeanTicket(ticket) {
    if (!ticket) return { polygon: null, pin: null };
    let polygon = null;
    if (ticket.polygon && typeof ticket.polygon === 'object') {
        polygon = ticket.polygon;
    }
    let pin = null;
    if (
        ticket.stubMapPin &&
        Number.isFinite(Number(ticket.stubMapPin.lat)) &&
        Number.isFinite(Number(ticket.stubMapPin.lng))
    ) {
        pin = { lat: Number(ticket.stubMapPin.lat), lng: Number(ticket.stubMapPin.lng) };
    } else if (
        ticket.bbox &&
        Number.isFinite(Number(ticket.bbox.minLat)) &&
        Number.isFinite(Number(ticket.bbox.maxLat))
    ) {
        pin = {
            lat: (Number(ticket.bbox.minLat) + Number(ticket.bbox.maxLat)) / 2,
            lng: (Number(ticket.bbox.minLng) + Number(ticket.bbox.maxLng)) / 2,
        };
    }
    return { polygon, pin };
}

function shareTicketIntersectsFootprint(ticket, footprint) {
    if (!footprint || footprint.type !== 'Polygon') return false;
    if (ticket.polygon && ticketPolygonIntersectsFootprint(ticket.polygon, footprint)) {
        return true;
    }
    if (
        ticket.stubMapPin &&
        Number.isFinite(Number(ticket.stubMapPin.lng)) &&
        Number.isFinite(Number(ticket.stubMapPin.lat))
    ) {
        try {
            const turf = require('@turf/turf');
            const pt = turf.point([Number(ticket.stubMapPin.lng), Number(ticket.stubMapPin.lat)]);
            return turf.booleanPointInPolygon(pt, turf.feature(footprint));
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * @param {object} db
 * @param {object} leanRow ticket DB row
 * @param {number} feedOrgId org used for aerial access entitlement (feed workspace or contractor)
 */
async function ticketHasQualifyingAerial(db, leanRow, feedOrgId) {
    const ticket = leanRowToTicketShape(leanRow);
    if (!ticket) return false;
    const anchor = ticketAnchorMs(leanRow);
    if (anchor == null) return false;

    const mapRows = await loadGlobalAerialMaps(db, null, feedOrgId);
    for (const row of mapRows || []) {
        const fp = parseBoundingBox(row);
        if (!fp) continue;
        if (!shareTicketIntersectsFootprint(ticket, fp)) continue;
        const capture = mapCaptureMs(row);
        if (capture != null && capture >= anchor) {
            return true;
        }
    }
    return false;
}

/**
 * List active feed SRs (optional org / id filters).
 */
async function listActiveFeedServiceRequests(db, opts) {
    const statuses = FEED_ACTIVE_STATUSES;
    const ph = statuses.map(() => '?').join(',');
    let sql = `
        SELECT sr.*, o.name AS organization_name
        FROM service_requests sr
        LEFT JOIN organizations o ON o.id = sr.organization_id
        WHERE sr.status IN (${ph})
    `;
    const params = [...statuses];

    const orgIds = Array.isArray(opts && opts.organizationIds)
        ? opts.organizationIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
    if (orgIds.length > 0) {
        sql += ` AND sr.organization_id IN (${orgIds.map(() => '?').join(',')})`;
        params.push(...orgIds);
    }

    const ids = Array.isArray(opts && opts.serviceRequestIds)
        ? opts.serviceRequestIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
    if (ids.length > 0) {
        sql += ` AND sr.id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
    }

    sql += ' ORDER BY sr.created_at DESC';
    return allRows(db, sql, params);
}

async function countActiveFeedServiceRequests(db) {
    const statuses = FEED_ACTIVE_STATUSES;
    const ph = statuses.map(() => '?').join(',');
    const row = await getRow(
        db,
        `SELECT COUNT(*) AS c FROM service_requests WHERE status IN (${ph})`,
        statuses
    );
    return row && row.c != null ? Number(row.c) : 0;
}

/**
 * Scan incomplete/new SRs; set complete when qualifying aerial found.
 */
async function scanFeedServiceRequests(db, opts) {
    const feedOrgId = Number(opts && opts.feedOrgId) || null;
    const rows = await listActiveFeedServiceRequests(db, {
        organizationIds: opts && opts.organizationIds,
        serviceRequestIds: opts && opts.serviceRequestIds,
    });

    let scanned = 0;
    let updatedToComplete = 0;
    const errors = [];

    for (const sr of rows || []) {
        if (!isFeedIncompleteLike(sr.status)) continue;
        scanned += 1;
        try {
            const feed = parseFeedServiceRequestNote(sr.note);
            if (!feed || !feed.ticketNumber) {
                errors.push({ id: sr.id, error: 'missing_ticket_link' });
                continue;
            }
            const ownerOrgId = Number(feed.ticketOrganizationId || sr.organization_id);
            const lean = await loadOwnerTicketLean(db, ownerOrgId, feed.ticketNumber);
            if (!lean) {
                errors.push({ id: sr.id, error: 'ticket_not_found' });
                continue;
            }
            // Use contractor (owner) org for restricted aerial access — not the feed workspace.
            const okOwner = await ticketHasQualifyingAerial(db, lean, ownerOrgId);
            let ok = okOwner;
            if (!ok && feedOrgId && Number(feedOrgId) !== ownerOrgId) {
                // Also accept global/restricted maps visible to the feed workspace.
                ok = await ticketHasQualifyingAerial(db, lean, feedOrgId);
            }
            if (ok) {
                await runDb(db, `UPDATE service_requests SET status = 'complete' WHERE id = ?`, [sr.id]);
                updatedToComplete += 1;
            }
        } catch (err) {
            console.error('scanFeedServiceRequests row failed', sr.id, err);
            errors.push({ id: sr.id, error: err && err.message ? String(err.message) : 'scan_error' });
        }
    }

    return { scanned, updatedToComplete, errors };
}

module.exports = {
    loadOwnerTicketLean,
    leanRowToTicketShape,
    markerFromLeanTicket,
    ticketHasQualifyingAerial,
    listActiveFeedServiceRequests,
    countActiveFeedServiceRequests,
    scanFeedServiceRequests,
    ticketAnchorMs,
};
