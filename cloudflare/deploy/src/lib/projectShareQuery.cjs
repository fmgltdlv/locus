/**
 * Public project share queries (unauthenticated token access).
 */
const { allRows, getRow } = require('./db.cjs');
const { ticketBaseFromNumber } = require('./mapPhotoTimeWindow.cjs');
const { resolveShareLinkByToken } = require('./jobProjectShareLink.cjs');
const { listEffectiveTicketRowsForProject } = require('./jobProjectMembership.cjs');
const {
    loadGlobalAerialMaps,
    rowToMap,
    parseBoundingBox,
    ticketPolygonIntersectsFootprint,
} = require('./aerialMapQuery.cjs');
const { applyIndexedColumnsToTicketShape } = require('./ticketIndexedColumns.cjs');
const ticketBuilder = require('./ticketBuilder.cjs');
const turf = require('@turf/turf');

async function resolveShareContext(db, token) {
    const resolved = await resolveShareLinkByToken(db, token);
    if (!resolved) return { ok: false, status: 404, error: 'Share link not found' };
    if (resolved.invalid) {
        const msg =
            resolved.reason === 'expired'
                ? 'This share link has expired'
                : 'This share link is no longer valid';
        return { ok: false, status: 410, error: msg };
    }
    const row = resolved.row;
    const orgId = Number(row.organization_id);
    const jobNameKey = String(row.job_name_normalized).trim().toLowerCase();
    const complianceRow = await getRow(
        db,
        `SELECT job_name_display, status FROM job_misc_compliance
         WHERE organization_id = ? AND job_name_normalized = ?`,
        [orgId, jobNameKey]
    );
    const ticketRows = await listEffectiveTicketRowsForProject(db, orgId, jobNameKey);
    const projectName =
        (complianceRow && complianceRow.job_name_display
            ? String(complianceRow.job_name_display).trim()
            : '') || jobNameKey;
    const projectStatus =
        complianceRow && complianceRow.status != null ? String(complianceRow.status).trim() : 'open';
    return {
        ok: true,
        orgId,
        jobNameKey,
        projectName,
        projectStatus,
        shareRow: row,
        ticketRows,
        ticketIds: (ticketRows || []).map((r) => Number(r.id)).filter((id) => Number.isFinite(id)),
    };
}

function extendBoundsFromIndexed(indexed, bounds) {
    let { minLng, minLat, maxLng, maxLat } = bounds;
    const bbox = indexed && indexed.bbox;
    if (bbox && typeof bbox === 'object') {
        if (Number.isFinite(Number(bbox.minLng))) minLng = Math.min(minLng, Number(bbox.minLng));
        if (Number.isFinite(Number(bbox.minLat))) minLat = Math.min(minLat, Number(bbox.minLat));
        if (Number.isFinite(Number(bbox.maxLng))) maxLng = Math.max(maxLng, Number(bbox.maxLng));
        if (Number.isFinite(Number(bbox.maxLat))) maxLat = Math.max(maxLat, Number(bbox.maxLat));
    }
    const pin = indexed && indexed.stubMapPin;
    if (pin && Number.isFinite(Number(pin.lng)) && Number.isFinite(Number(pin.lat))) {
        const lng = Number(pin.lng);
        const lat = Number(pin.lat);
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
    }
    return { minLng, minLat, maxLng, maxLat };
}

function computeBoundsFromTicketRows(rows) {
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const row of rows || []) {
        const indexed = applyIndexedColumnsToTicketShape({}, row);
        if (
            row.min_lng != null &&
            row.max_lng != null &&
            row.min_lat != null &&
            row.max_lat != null &&
            Number.isFinite(Number(row.min_lng)) &&
            Number.isFinite(Number(row.max_lng)) &&
            Number.isFinite(Number(row.min_lat)) &&
            Number.isFinite(Number(row.max_lat))
        ) {
            minLng = Math.min(minLng, Number(row.min_lng));
            minLat = Math.min(minLat, Number(row.min_lat));
            maxLng = Math.max(maxLng, Number(row.max_lng));
            maxLat = Math.max(maxLat, Number(row.max_lat));
        }
        ({ minLng, minLat, maxLng, maxLat } = extendBoundsFromIndexed(indexed, {
            minLng,
            minLat,
            maxLng,
            maxLat,
        }));
    }
    if (!Number.isFinite(minLng)) return null;
    return { minLng, minLat, maxLng, maxLat };
}

function parseTicketPolygon(row) {
    const indexed = applyIndexedColumnsToTicketShape({}, row);
    return indexed.polygon || null;
}

function buildProjectShareTicketSummary(orgId, row) {
    const indexed = applyIndexedColumnsToTicketShape({}, row);
    const parts = ticketBuilder.parseTicketNumberParts(row.ticket_number);
    return {
        id: row.id,
        ticketNumber: row.ticket_number,
        ticketBaseNumber: parts.baseNumber,
        ticketRevision: row.revision != null ? String(row.revision) : parts.revisionSuffix,
        organizationId: row.organization_id != null ? Number(row.organization_id) : orgId,
        polygon: indexed.polygon,
        stubMapPin: indexed.stubMapPin,
        bbox: indexed.bbox,
        address: indexed.address || indexed.fullAddress || undefined,
        fullAddress: indexed.fullAddress || undefined,
        workDescription: indexed.workDescription || row.work_description || undefined,
        startTime: indexed.startTime || indexed.legalStartDate || undefined,
        ticketExpirationDate: indexed.ticketExpirationDate || undefined,
        workflowStatus: indexed.workflowStatus || undefined,
        shared: true,
        readOnly: true,
    };
}

async function loadOperatorResponsesForTicket(db, ticketId) {
    const rows = await allRows(
        db,
        `SELECT response_id, station_code, operator_name, operator_code, status_code, operator_status,
                responded_at, comment
         FROM ticket_operator_responses
         WHERE ticket_id = ?
         ORDER BY response_index ASC, id ASC`,
        [ticketId]
    );
    return (rows || []).map((r) => ({
        id: r.response_id,
        stationCode: r.station_code,
        operatorName: r.operator_name,
        operatorCode: r.operator_code,
        statusCode: r.status_code,
        operatorStatus: r.operator_status,
        respondedAt: r.responded_at,
        comment: r.comment,
    }));
}

async function buildProjectShareTicketDetail(db, orgId, row) {
    const summary = buildProjectShareTicketSummary(orgId, row);
    const indexed = applyIndexedColumnsToTicketShape({}, row);
    const tid = row.id != null ? Number(row.id) : NaN;
    const operatorResponses = Number.isFinite(tid)
        ? await loadOperatorResponsesForTicket(db, tid)
        : [];
    return {
        ...summary,
        scopeOfWork: indexed.scopeOfWork || row.scope_of_work || undefined,
        categoryOfWork: indexed.categoryOfWork || row.category_of_work || undefined,
        workActivity: indexed.workActivity || row.work_activity || undefined,
        excavationMethod: indexed.excavationMethod || row.excavation_method || undefined,
        commencementDate: indexed.commencementDate || row.commencement_date || undefined,
        operatorResponses,
        stationCodes: [...new Set(operatorResponses.map((r) => r.stationCode || r.operatorCode).filter(Boolean))],
    };
}

function shareTicketIntersectsFootprint(ticket, footprint) {
    if (!ticket || !footprint || footprint.type !== 'Polygon') return false;
    if (ticket.polygon && (ticket.polygon.type === 'Polygon' || ticket.polygon.type === 'MultiPolygon')) {
        return ticketPolygonIntersectsFootprint(ticket.polygon, footprint);
    }
    const pin = ticket.stubMapPin;
    if (pin && Number.isFinite(Number(pin.lng)) && Number.isFinite(Number(pin.lat))) {
        try {
            const pt = turf.point([Number(pin.lng), Number(pin.lat)]);
            return turf.booleanPointInPolygon(pt, turf.feature(footprint));
        } catch {
            return false;
        }
    }
    const bbox = ticket.bbox;
    if (bbox && typeof bbox === 'object') {
        const minLng = Number(bbox.minLng);
        const minLat = Number(bbox.minLat);
        const maxLng = Number(bbox.maxLng);
        const maxLat = Number(bbox.maxLat);
        if (
            Number.isFinite(minLng) &&
            Number.isFinite(minLat) &&
            Number.isFinite(maxLng) &&
            Number.isFinite(maxLat)
        ) {
            const box = turf.bboxPolygon([minLng, minLat, maxLng, maxLat]);
            return turf.booleanIntersects(box, turf.feature(footprint));
        }
    }
    return false;
}

async function queryAerialMapsForProjectTickets(db, orgId, ticketRows) {
    const mapRows = await loadGlobalAerialMaps(db, null, orgId);
    const tickets = (ticketRows || []).map((row) => {
        const indexed = applyIndexedColumnsToTicketShape({}, row);
        return {
            id: row.id,
            polygon: indexed.polygon || null,
            stubMapPin: indexed.stubMapPin || null,
            bbox: indexed.bbox || null,
        };
    });
    const chosenMapIds = new Set();
    for (const t of tickets) {
        for (const row of mapRows) {
            const fp = parseBoundingBox(row);
            if (!fp) continue;
            if (shareTicketIntersectsFootprint(t, fp)) {
                chosenMapIds.add(row.id);
            }
        }
    }
    const byId = new Map(mapRows.map((r) => [r.id, r]));
    const out = [];
    for (const id of chosenMapIds) {
        const row = byId.get(id);
        if (row) out.push(rowToMap(row));
    }
    out.sort((a, b) => {
        const msA = a.capturedAt ? Date.parse(a.capturedAt) : 0;
        const msB = b.capturedAt ? Date.parse(b.capturedAt) : 0;
        return msB - msA;
    });
    return out;
}

async function collectPhotoIdsForTicketIds(db, ticketIds) {
    const ids = new Set();
    if (!ticketIds || ticketIds.length === 0) return ids;
    const placeholders = ticketIds.map(() => '?').join(', ');
    const ticketRows = await allRows(
        db,
        `SELECT id, organization_id, ticket_number FROM tickets WHERE id IN (${placeholders})`,
        ticketIds
    );
    if (!ticketRows || ticketRows.length === 0) return ids;
    const baseByOrg = new Map();
    for (const row of ticketRows) {
        const orgId = Number(row.organization_id);
        if (!Number.isFinite(orgId)) continue;
        const base = ticketBaseFromNumber(row.ticket_number);
        if (!base) continue;
        if (!baseByOrg.has(orgId)) baseByOrg.set(orgId, new Set());
        baseByOrg.get(orgId).add(base);
    }
    for (const [orgId, bases] of baseByOrg) {
        const baseList = Array.from(bases);
        if (!baseList.length) continue;
        const bp = baseList.map(() => '?').join(', ');
        let junctionRows;
        try {
            junctionRows = await allRows(
                db,
                `SELECT DISTINCT media_id FROM media_ticket_intersections
                 WHERE organization_id = ? AND ticket_base_number IN (${bp})`,
                [orgId, ...baseList]
            );
        } catch (_e) {
            continue;
        }
        for (const jr of junctionRows || []) {
            if (jr.media_id != null) ids.add(Number(jr.media_id));
        }
    }
    return ids;
}

async function queryProjectSharePhotos(db, orgId, ticketIds, bbox, limit) {
    const photoIds = await collectPhotoIdsForTicketIds(db, ticketIds);
    if (photoIds.size === 0) return [];
    const idList = Array.from(photoIds);
    const placeholders = idList.map(() => '?').join(', ');
    let sql = `SELECT id, file_name, file_type, latitude, longitude, created_at, thumbnail_path
               FROM media_files
               WHERE organization_id = ? AND id IN (${placeholders}) AND has_gps = 1`;
    const params = [orgId, ...idList];
    if (bbox && bbox.minLng != null) {
        sql += ` AND longitude >= ? AND longitude <= ? AND latitude >= ? AND latitude <= ?`;
        params.push(bbox.minLng, bbox.maxLng, bbox.minLat, bbox.maxLat);
    }
    sql += ' ORDER BY created_at DESC';
    const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
    sql += ` LIMIT ${lim}`;
    const rows = await allRows(db, sql, params);
    return (rows || []).map((r) => ({
        id: r.id,
        fileName: r.file_name,
        fileType: r.file_type,
        latitude: r.latitude,
        longitude: r.longitude,
        createdAt: r.created_at,
        hasThumbnail: !!r.thumbnail_path,
    }));
}

async function isMediaAllowedForShareContext(db, ctx, mediaId) {
    const mid = Number(mediaId);
    if (!ctx || !ctx.ok || !Number.isFinite(mid)) return false;
    const allowed = await collectPhotoIdsForTicketIds(db, ctx.ticketIds);
    return allowed.has(mid);
}

module.exports = {
    resolveShareContext,
    computeBoundsFromTicketRows,
    buildProjectShareTicketSummary,
    buildProjectShareTicketDetail,
    queryAerialMapsForProjectTickets,
    queryProjectSharePhotos,
    isMediaAllowedForShareContext,
    collectPhotoIdsForTicketIds,
};
