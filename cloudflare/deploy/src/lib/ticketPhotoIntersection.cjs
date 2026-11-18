const { createHash } = require('node:crypto');
const { allRows, getRow, runDb } = require('./db.cjs');
const { applyIndexedColumnsToTicketShape } = require('./ticketIndexedColumns.cjs');
const { applyPhotoRequirementFields, photoCreatedAtMeetsRevisionCutoff } = require('./photoRequirementCutoff.cjs');

const TICKET_PHOTO_SEARCH_BUFFER_FEET = 180;
const TICKET_PHOTO_SEARCH_BUFFER_METERS = TICKET_PHOTO_SEARCH_BUFFER_FEET * 0.3048;
const MEDIA_SCAN_CHUNK = 1000;
const MAX_TICKET_RECOMPUTES_PER_PASS = 40;
/** D1 enforces a low cap on bound parameters per statement (~100); chunk large `IN (...)` lists. */
const D1_SAFE_IN_CHUNK = 99;

function isMissingTableError(e) {
    return /no such table/i.test((e && e.message) || String(e || ''));
}

function safeJsonParse(s, fallback) {
    try {
        return s ? JSON.parse(String(s)) : fallback;
    } catch (_) {
        return fallback;
    }
}

function stableStringify(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashString(s) {
    return createHash('sha256').update(String(s || '')).digest('hex');
}

function normalizePolygon(geometry) {
    if (!geometry || typeof geometry !== 'object') return null;
    if (geometry.type === 'Feature') return normalizePolygon(geometry.geometry);
    if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') return geometry;
    return null;
}

function geometryRings(geometry) {
    const g = normalizePolygon(geometry);
    if (!g) return [];
    if (g.type === 'Polygon') {
        return Array.isArray(g.coordinates) && Array.isArray(g.coordinates[0]) ? [g.coordinates[0]] : [];
    }
    if (g.type === 'MultiPolygon') {
        const rings = [];
        (g.coordinates || []).forEach((poly) => {
            if (Array.isArray(poly) && Array.isArray(poly[0])) rings.push(poly[0]);
        });
        return rings;
    }
    return [];
}

function computeAabbForRings(rings) {
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const ring of rings || []) {
        for (const pt of ring || []) {
            if (!Array.isArray(pt) || pt.length < 2) continue;
            const lng = Number(pt[0]);
            const lat = Number(pt[1]);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
            minLng = Math.min(minLng, lng);
            maxLng = Math.max(maxLng, lng);
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
        }
    }
    if (!Number.isFinite(minLng)) return null;
    return { minLng, minLat, maxLng, maxLat };
}

function paddingForMeters(lat, meters) {
    const latPad = meters / 111320;
    const cosLat = Math.cos(Number(lat) * Math.PI / 180);
    const lngPad = cosLat > 1e-6 ? meters / (111320 * cosLat) : latPad;
    return { latPad, lngPad };
}

function expandAabbByMeters(aabb, meters) {
    if (!aabb) return null;
    const midLat = (aabb.minLat + aabb.maxLat) / 2;
    const pad = paddingForMeters(midLat, meters);
    return {
        minLng: aabb.minLng - pad.lngPad,
        minLat: aabb.minLat - pad.latPad,
        maxLng: aabb.maxLng + pad.lngPad,
        maxLat: aabb.maxLat + pad.latPad,
    };
}

function pointInRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = Number(ring[i][0]);
        const yi = Number(ring[i][1]);
        const xj = Number(ring[j][0]);
        const yj = Number(ring[j][1]);
        if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;
        const intersect = ((yi > point.lat) !== (yj > point.lat)) &&
            (point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function haversineMeters(a, b) {
    const r = 6371000;
    const toRad = (v) => Number(v) * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

function distancePointToSegmentMeters(p, a, b) {
    const ax = a.lng;
    const ay = a.lat;
    const bx = b.lng;
    const by = b.lat;
    const px = p.lng;
    const py = p.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return haversineMeters(p, a);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return haversineMeters(p, { lng: ax + t * dx, lat: ay + t * dy });
}

function minDistancePointToRingMeters(point, ring) {
    let minD = Infinity;
    for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length;
        const a = { lng: Number(ring[i][0]), lat: Number(ring[i][1]) };
        const b = { lng: Number(ring[j][0]), lat: Number(ring[j][1]) };
        if (!Number.isFinite(a.lng) || !Number.isFinite(a.lat) || !Number.isFinite(b.lng) || !Number.isFinite(b.lat)) continue;
        const d = distancePointToSegmentMeters(point, a, b);
        if (d < minD) minD = d;
    }
    return minD;
}

function pointInOrNearPolygon(point, geometry) {
    const rings = geometryRings(geometry);
    if (rings.length === 0) return false;
    for (const ring of rings) {
        const aabb = expandAabbByMeters(computeAabbForRings([ring]), TICKET_PHOTO_SEARCH_BUFFER_METERS);
        if (!aabb) continue;
        if (point.lng < aabb.minLng || point.lng > aabb.maxLng || point.lat < aabb.minLat || point.lat > aabb.maxLat) {
            continue;
        }
        if (pointInRing(point, ring)) return true;
        if (minDistancePointToRingMeters(point, ring) <= TICKET_PHOTO_SEARCH_BUFFER_METERS) return true;
    }
    return false;
}

function snapshotInputsHash(orgId, row, ticket) {
    return hashString(stableStringify({
        organizationId: Number(orgId),
        ticketId: row && row.id != null ? Number(row.id) : null,
        ticketNumber: row && row.ticket_number != null ? String(row.ticket_number) : ticket && ticket.ticketNumber,
        polygon: normalizePolygon(ticket && ticket.polygon),
        photoRequirementCutoffIso: ticket && ticket.photoRequirementCutoffIso != null ? String(ticket.photoRequirementCutoffIso) : null,
        photoRequirementCutoffPending: !!(ticket && ticket.photoRequirementCutoffPending),
    }));
}

function getCutoffMs(ticket) {
    if (!ticket || ticket.photoRequirementCutoffPending) return { pending: !!(ticket && ticket.photoRequirementCutoffPending), ms: null };
    const raw = ticket.photoRequirementCutoffIso;
    if (raw == null || String(raw).trim() === '') return { pending: false, ms: null };
    const ms = new Date(raw).getTime();
    return { pending: false, ms: Number.isFinite(ms) ? ms : null };
}

async function getOrgMediaMaxCreatedAt(db, orgId) {
    const row = await getRow(
        db,
        `SELECT MAX(created_at) AS max_created_at
         FROM media_files
         WHERE organization_id = ? AND has_gps = 1`,
        [orgId]
    );
    return row && row.max_created_at != null ? String(row.max_created_at) : null;
}

function associatedTicketIdFromMediaMeta(rawMeta) {
    const meta = typeof rawMeta === 'string' ? safeJsonParse(rawMeta, {}) : rawMeta;
    if (!meta || typeof meta !== 'object') return null;
    const tid = meta.associatedTicketId != null ? Number(meta.associatedTicketId) : null;
    return Number.isFinite(tid) && tid > 0 ? tid : null;
}

async function queryAssociatedNoGpsMedia(db, orgId, ticketId) {
    const rows = await allRows(
        db,
        `SELECT id, file_name, file_type, thumbnail_path, mime_type, created_at, metadata
         FROM media_files
         WHERE organization_id = ?
           AND has_gps = 0
         ORDER BY datetime(created_at) ASC, id ASC
         LIMIT 2000`,
        [orgId]
    );
    const out = [];
    for (const m of rows || []) {
        const assoc = associatedTicketIdFromMediaMeta(m.metadata);
        if (assoc !== Number(ticketId)) continue;
        out.push({
            id: Number(m.id),
            fileName: m.file_name,
            fileType: m.file_type,
            thumbnailUrl: m.thumbnail_path ? `/api/data/media/${m.id}/thumbnail` : null,
            mimeType: m.mime_type,
            createdAt: m.created_at,
            lat: null,
            lng: null,
            associatedNoGps: true,
        });
    }
    return out;
}

async function queryCandidateMedia(db, orgId, expandedAabb) {
    if (!expandedAabb) return { rows: [], incomplete: false };
    const out = [];
    let offset = 0;
    let incomplete = false;
    for (;;) {
        const rows = await allRows(
            db,
            `SELECT id, file_name, file_type, thumbnail_path, mime_type, created_at, latitude, longitude
             FROM media_files
             WHERE organization_id = ?
               AND has_gps = 1
               AND latitude BETWEEN ? AND ?
               AND longitude BETWEEN ? AND ?
             ORDER BY datetime(created_at) ASC, id ASC
             LIMIT ? OFFSET ?`,
            [
                orgId,
                expandedAabb.minLat,
                expandedAabb.maxLat,
                expandedAabb.minLng,
                expandedAabb.maxLng,
                MEDIA_SCAN_CHUNK,
                offset,
            ]
        );
        out.push(...(rows || []));
        if (!rows || rows.length < MEDIA_SCAN_CHUNK) break;
        offset += MEDIA_SCAN_CHUNK;
        if (offset >= MEDIA_SCAN_CHUNK * 3) {
            incomplete = true;
            break;
        }
    }
    return { rows: out, incomplete };
}

async function computeSnapshot(db, orgId, row, ticket) {
    if (!ticket || !normalizePolygon(ticket.polygon) || !row || row.id == null) return null;
    const rings = geometryRings(ticket.polygon);
    const aabb = computeAabbForRings(rings);
    if (!aabb) return null;
    const expandedAabb = expandAabbByMeters(aabb, TICKET_PHOTO_SEARCH_BUFFER_METERS);
    const candidates = await queryCandidateMedia(db, orgId, expandedAabb);
    const matching = [];
    for (const m of candidates.rows) {
        const lat = Number(m.latitude);
        const lng = Number(m.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        if (!pointInOrNearPolygon({ lat, lng }, ticket.polygon)) continue;
        matching.push({
            id: Number(m.id),
            fileName: m.file_name,
            fileType: m.file_type,
            thumbnailUrl: m.thumbnail_path ? `/api/data/media/${m.id}/thumbnail` : null,
            mimeType: m.mime_type,
            createdAt: m.created_at,
            lat,
            lng,
        });
    }
    const associatedNoGps = await queryAssociatedNoGpsMedia(db, orgId, row.id);
    const seenIds = new Set(matching.map((m) => Number(m.id)));
    for (const media of associatedNoGps) {
        if (seenIds.has(Number(media.id))) continue;
        matching.push(media);
        seenIds.add(Number(media.id));
    }

    const cut = getCutoffMs(ticket);
    let afterCutoff = 0;
    let olderInPolygon = 0;
    for (const media of matching) {
        if (cut.pending) {
            olderInPolygon++;
        } else if (photoCreatedAtMeetsRevisionCutoff(media.createdAt, ticket.photoRequirementCutoffIso)) {
            afterCutoff++;
        } else {
            olderInPolygon++;
        }
    }
    const totalInPolygon = matching.length;
    const computedAt = new Date().toISOString();
    const mediaCreatedAts = matching.map((m) => m.createdAt).filter(Boolean).sort();
    const snapshot = {
        computedAt,
        stats: {
            totalInPolygon,
            afterCutoff: cut.pending ? 0 : afterCutoff,
            olderInPolygon,
            forRequirement: cut.pending ? 0 : afterCutoff,
        },
        inputsHash: snapshotInputsHash(orgId, row, ticket),
        ticketRowUpdatedAtSnapshot: row.updated_at != null ? String(row.updated_at) : null,
        orgMediaGlobalMaxCreatedAt: await getOrgMediaMaxCreatedAt(db, orgId),
        intersectingMediaMaxCreatedAt: mediaCreatedAts.length ? mediaCreatedAts[mediaCreatedAts.length - 1] : null,
        mediaFanoutAware: true,
        slimStatsOnly: true,
        incomplete: candidates.incomplete,
    };
    snapshot.stale = Boolean(snapshot.incomplete);
    return snapshot;
}

/** Inline photo count for workflow ack (no persist). See workflowAckCompliance.cjs */
async function countPhotosForRequirementInline(db, orgId, row, ticket) {
    if (!ticket || !normalizePolygon(ticket.polygon) || !row || row.id == null) {
        return { forRequirement: 0, pending: true };
    }
    const rings = geometryRings(ticket.polygon);
    const aabb = computeAabbForRings(rings);
    if (!aabb) return { forRequirement: 0, pending: true };
    const expandedAabb = expandAabbByMeters(aabb, TICKET_PHOTO_SEARCH_BUFFER_METERS);
    const candidates = await queryCandidateMedia(db, orgId, expandedAabb);
    const matching = [];
    for (const m of candidates.rows) {
        const lat = Number(m.latitude);
        const lng = Number(m.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        if (!pointInOrNearPolygon({ lat, lng }, ticket.polygon)) continue;
        matching.push({ createdAt: m.created_at });
    }
    const associatedNoGps = await queryAssociatedNoGpsMedia(db, orgId, row.id);
    for (const media of associatedNoGps) {
        matching.push({ createdAt: media.createdAt });
    }
    const cut = getCutoffMs(ticket);
    if (cut.pending) return { forRequirement: 0, pending: true };
    let afterCutoff = 0;
    for (const media of matching) {
        if (photoCreatedAtMeetsRevisionCutoff(media.createdAt, ticket.photoRequirementCutoffIso)) afterCutoff++;
    }
    return { forRequirement: afterCutoff, pending: false };
}

/** @deprecated ticket_photo_stats removed — no-op */
async function persistSnapshot() {
    return null;
}

/**
 * Apply staleness rules to a stored snapshot (inputs hash, ticket row revision, org media fanout).
 * @param {unknown} orgMediaMaxCreatedAt — when omitted and snapshot is not mediaFanoutAware, caller must fetch separately.
 */
function resolvePhotoStatsSnapshotStaleness(orgId, row, ticket, snapshot, orgMediaMaxCreatedAt) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const currentHash = snapshotInputsHash(orgId, row, ticket);
    let stale = Boolean(snapshot.incomplete) || snapshot.inputsHash !== currentHash;
    const rowUpdated = row.updated_at ? Date.parse(row.updated_at) : NaN;
    const snapshotRowUpdated = snapshot.ticketRowUpdatedAtSnapshot
        ? Date.parse(snapshot.ticketRowUpdatedAtSnapshot)
        : NaN;
    if (Number.isFinite(rowUpdated) && Number.isFinite(snapshotRowUpdated) && rowUpdated > snapshotRowUpdated) {
        stale = true;
    }
    if (snapshot.mediaFanoutAware !== true && orgMediaMaxCreatedAt !== undefined) {
        if (orgMediaMaxCreatedAt !== (snapshot.orgMediaGlobalMaxCreatedAt || null)) stale = true;
    }
    return { ...snapshot, stale };
}

/** @returns {Promise<Map<number, object>>} ticket_id → parsed stats_json (no staleness flag). */
/** @deprecated ticket_photo_stats removed — always empty */
async function loadPhotoStatsJsonMapForTicketIds() {
    return new Map();
}

/** @deprecated ticket_photo_stats removed — no-op */
function attachPhotoStatsSnapshotFromMap(ticket) {
    return ticket;
}

async function loadSnapshotForTicket(db, orgId, row, ticket) {
    try {
        const map = await loadPhotoStatsJsonMapForTicketIds(db, [row.id]);
        const snapshot = map.get(Number(row.id));
        if (!snapshot) return null;
        let orgMediaMaxCreatedAt = undefined;
        if (snapshot.mediaFanoutAware !== true) {
            orgMediaMaxCreatedAt = await getOrgMediaMaxCreatedAt(db, orgId);
        }
        return resolvePhotoStatsSnapshotStaleness(orgId, row, ticket, snapshot, orgMediaMaxCreatedAt);
    } catch (e) {
        if (isMissingTableError(e)) return null;
        throw e;
    }
}

/** @deprecated ticket_photo_stats removed — no-op */
async function attachSnapshotToTicket(db, orgId, row, ticket) {
    return ticket;
}

async function findTicketIdsForMediaPoint(db, orgId, point) {
    if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) return [];
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    const pad = paddingForMeters(lat, TICKET_PHOTO_SEARCH_BUFFER_METERS);
    const ticketIds = new Set();
    const rows = await allRows(
        db,
        `SELECT id, polygon_json
         FROM tickets
         WHERE organization_id = ?
           AND polygon_json IS NOT NULL
           AND min_lat <= ? AND max_lat >= ?
           AND min_lng <= ? AND max_lng >= ?
         ORDER BY updated_at DESC
         LIMIT 500`,
        [orgId, lat + pad.latPad, lat - pad.latPad, lng + pad.lngPad, lng - pad.lngPad]
    );
    for (const row of rows || []) {
        const polygon = safeJsonParse(row.polygon_json, null);
        if (pointInOrNearPolygon({ lat, lng }, polygon)) ticketIds.add(Number(row.id));
    }
    return Array.from(ticketIds);
}

/** @deprecated ticket_photo_stats removed — no-op */
async function recomputeTicketIds(db, orgId, ticketIds) {
    const ids = [...new Set((ticketIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
    return { processed: [], remaining: ids };
}

/** @deprecated ticket_photo_stats removed — no-op */
async function recomputeForMediaChange() {
    return { processed: [], remaining: [] };
}

module.exports = {
    attachSnapshotToTicket,
    attachPhotoStatsSnapshotFromMap,
    countPhotosForRequirementInline,
    persistSnapshot,
    recomputeForMediaChange,
    recomputeTicketIds,
    findTicketIdsForMediaPoint,
    getOrgMediaMaxCreatedAt,
    loadPhotoStatsJsonMapForTicketIds,
    pointInOrNearTicketPolygon: pointInOrNearPolygon,
    resolvePhotoStatsSnapshotStaleness,
    snapshotInputsHash,
};
