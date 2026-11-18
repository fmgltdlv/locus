const { allRows, getRow } = require('./db.cjs');
const { getMapPhotoTimeWindow, photoInMapWindow, ticketBaseFromNumber } = require('./mapPhotoTimeWindow.cjs');
const { applyPhotoRequirementFieldsWithDb, photoCreatedAtMeetsRevisionCutoff } = require('./photoRequirementCutoff.cjs');
const { applyIndexedColumnsToTicketShape } = require('./ticketIndexedColumns.cjs');

const PHOTO_MAP_MIN_ZOOM = 16;
const PHOTO_MAP_POINT_MODE_MAX_ZOOM = 20;
/** Cluster drawer/gallery is ticket-scoped; do not clip to the tiny map viewport at z24. */
const CLUSTER_GALLERY_BBOX = { minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 };
const CLUSTER_POINT_THRESHOLD = 300;
const MANAGE_DATA_SPATIAL_CAP = 3000;
const CLUSTER_HYSTERESIS_LOW = 200;
const TICKET_PHOTO_SEARCH_BUFFER_METERS = 180 * 0.3048;

/** @param {string} [expiresCol] */
function ticketExpiredListSqlPredicate(expiresCol = 't.ticket_expires_at') {
    const c = expiresCol;
    const jd = `julianday(TRIM(${c}))`;
    return `${c} IS NOT NULL AND TRIM(COALESCE(${c}, '')) != '' AND (${jd} IS NOT NULL) AND (${jd} <= julianday('now'))`;
}

function ticketCancelledListSqlPredicate() {
    return `LOWER(TRIM(COALESCE(NULLIF(TRIM(t.current_ngen_enquiry_status), ''), NULLIF(TRIM(t.ngen_enquiry_status), ''), ''))) = 'cancelled'`;
}

function ticketInactiveListSqlPredicate() {
    return `(${ticketExpiredListSqlPredicate()}) OR (${ticketCancelledListSqlPredicate()})`;
}

function safeJsonParse(s, fallback) {
    try {
        return s ? JSON.parse(String(s)) : fallback;
    } catch (_) {
        return fallback;
    }
}

/**
 * @param {string} raw west,south,east,north
 * @returns {{ minLng: number, minLat: number, maxLng: number, maxLat: number }|null}
 */
function parseBboxParam(raw) {
    if (raw == null || String(raw).trim() === '') return null;
    const parts = String(raw).split(',').map((p) => Number(String(p).trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    let [minLng, minLat, maxLng, maxLat] = parts;
    if (minLng > maxLng) [minLng, maxLng] = [maxLng, minLng];
    if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];
    minLng = Math.max(-180, Math.min(180, minLng));
    maxLng = Math.max(-180, Math.min(180, maxLng));
    minLat = Math.max(-90, Math.min(90, minLat));
    maxLat = Math.max(-90, Math.min(90, maxLat));
    if (maxLng - minLng < 1e-9 || maxLat - minLat < 1e-9) return null;
    return { minLng, minLat, maxLng, maxLat };
}

function gridCellSizeForZoom(zoom) {
    const z = Number(zoom);
    if (!Number.isFinite(z) || z < PHOTO_MAP_MIN_ZOOM) return null;
    if (z <= 16) return 0.00035;
    if (z <= 17) return 0.0002;
    if (z <= 18) return 0.00012;
    return 0.00007;
}

function cellKeyForLatLng(lat, lng, zoom) {
    const cell = gridCellSizeForZoom(zoom);
    if (!cell || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return `${Math.floor(lng / cell)}:${Math.floor(lat / cell)}`;
}

function ticketCentroidOrAnchor(ctx) {
    if (!ctx || !ctx.ticket) return null;
    const fromPolygon = polygonCentroid(ctx.ticket.polygon);
    if (fromPolygon) return fromPolygon;
    const pin = ctx.ticket.stubMapPin;
    if (pin && Number.isFinite(Number(pin.lat)) && Number.isFinite(Number(pin.lng))) {
        return { lat: Number(pin.lat), lng: Number(pin.lng) };
    }
    return null;
}

function positionNear(lat, lng, otherLat, otherLng, epsilon) {
    const e = epsilon != null ? epsilon : 0.00003;
    return Math.abs(lat - otherLat) < e && Math.abs(lng - otherLng) < e;
}

function offsetNoGpsClusterPosition(lat, lng, gpsPoints) {
    const hasOverlap = (gpsPoints || []).some(
        (p) => p.hasGps && Number.isFinite(p.lat) && Number.isFinite(p.lng) && positionNear(lat, lng, p.lat, p.lng)
    );
    if (!hasOverlap) return { lat, lng };
    return { lat: lat + 0.00005, lng: lng + 0.00005 };
}

function mediaRowToPoint(row, extra) {
    const lat = row.latitude != null ? Number(row.latitude) : extra && extra.lat != null ? Number(extra.lat) : null;
    const lng = row.longitude != null ? Number(row.longitude) : extra && extra.lng != null ? Number(extra.lng) : null;
    const meta =
        typeof row.metadata === 'string'
            ? safeJsonParse(row.metadata, {})
            : row.metadata && typeof row.metadata === 'object'
              ? row.metadata
              : {};
    const note =
        typeof meta.note === 'string'
            ? meta.note
            : row.note_text != null && String(row.note_text).trim() !== ''
              ? String(row.note_text)
              : '';
    const tags = Array.isArray(meta.tags)
        ? meta.tags.map((t) => String(t)).filter((t) => t.trim() !== '')
        : [];
    const noteLastEditedBy =
        typeof meta.noteLastEditedBy === 'string'
            ? meta.noteLastEditedBy
            : row.note_last_edited_by != null
              ? String(row.note_last_edited_by)
              : null;
    const noteLastEditedAt =
        typeof meta.noteLastEditedAt === 'string'
            ? meta.noteLastEditedAt
            : row.note_last_edited_at != null
              ? String(row.note_last_edited_at)
              : null;
    const hasWhitePaintMark =
        meta.hasWhitePaintMark === true ||
        tags.some((t) => String(t).trim().toLowerCase() === 'white paint');
    const exif = meta.exif && typeof meta.exif === 'object' ? meta.exif : {};
    const headingM = exif.gpsHeadingDegrees ?? meta.gpsHeadingDegrees;
    const headingSrc = exif.gpsHeadingSource ?? meta.gpsHeadingSource;
    const accM = exif.gpsAccuracyMeters ?? meta.gpsAccuracyMeters;
    const point = {
        id: Number(row.id),
        fileName: row.file_name,
        thumbnailUrl: row.thumbnail_path ? `/api/data/media/${row.id}/thumbnail` : null,
        createdAt: row.created_at,
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        hasGps: Number(row.has_gps) === 1,
        associatedNoGps: !!(extra && extra.associatedNoGps),
        ticketBaseNumber: extra && extra.ticketBaseNumber ? String(extra.ticketBaseNumber) : null,
        uploadedBy: row.uploaded_by || null,
        note,
        tags,
        noteLastEditedBy,
        noteLastEditedAt,
        hasWhitePaintMark,
    };
    if (headingM != null && Number.isFinite(Number(headingM))) {
        point.gpsHeadingDegrees = Number(headingM);
    }
    if (headingSrc != null && String(headingSrc).trim() !== '') {
        point.gpsHeadingSource = String(headingSrc);
    }
    if (accM != null && Number.isFinite(Number(accM))) {
        point.gpsAccuracyMeters = Number(accM);
    }
    return point;
}

function pointInBbox(lat, lng, bbox) {
    if (!bbox || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    return lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
}

function parseTagsFilter(raw) {
    if (raw == null || String(raw).trim() === '') return [];
    return String(raw)
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
}

function photoMatchesTagFilter(metadataRaw, tags) {
    if (!tags || !tags.length) return true;
    const meta = typeof metadataRaw === 'string' ? safeJsonParse(metadataRaw, {}) : metadataRaw || {};
    const photoTags = Array.isArray(meta.tags) ? meta.tags.map((t) => String(t).toLowerCase()) : [];
    return tags.some((t) => photoTags.includes(t));
}

async function loadTicketContexts(db, orgId, ticketIds) {
    const ids = [...new Set((ticketIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
    const contexts = [];
    for (const id of ids) {
        const row = await getRow(db, `SELECT * FROM tickets WHERE id = ? AND organization_id = ?`, [id, orgId]);
        if (!row) continue;
        const ticket = applyIndexedColumnsToTicketShape({}, row);
        Object.assign(ticket, {
            id: row.id,
            ticketNumber: row.ticket_number,
            ticket_expires_at: row.ticket_expires_at,
            organizationId: orgId,
            revision: row.revision != null ? String(row.revision) : null,
            ticketRevision: row.revision != null ? String(row.revision) : ticket.ticketRevision || null,
        });
        await applyPhotoRequirementFieldsWithDb(db, ticket);
        const base = ticketBaseFromNumber(row.ticket_number);
        const timeWindow = await getMapPhotoTimeWindow(db, orgId, ticket);
        contexts.push({ ticketId: id, ticket, row, base, timeWindow });
    }
    return contexts;
}

function polygonCentroid(geometry) {
    const g = geometry && geometry.type === 'Feature' ? geometry.geometry : geometry;
    if (!g) return null;
    let ring = null;
    if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates[0]) {
        ring = g.coordinates[0];
    } else if (g.type === 'MultiPolygon' && g.coordinates && g.coordinates[0] && g.coordinates[0][0]) {
        ring = g.coordinates[0][0];
    }
    if (!ring || !ring.length) return null;
    let sumLat = 0;
    let sumLng = 0;
    let n = 0;
    for (const pt of ring) {
        if (!Array.isArray(pt) || pt.length < 2) continue;
        const lng = Number(pt[0]);
        const lat = Number(pt[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        sumLat += lat;
        sumLng += lng;
        n++;
    }
    if (!n) return null;
    return { lat: sumLat / n, lng: sumLng / n };
}

function ticketContextHasPolygon(ctx) {
    const g = ctx && ctx.ticket && ctx.ticket.polygon;
    if (!g || typeof g !== 'object') return false;
    if (g.type === 'Feature' && g.geometry) return ticketContextHasPolygon({ ticket: { polygon: g.geometry } });
    return g.type === 'Polygon' || g.type === 'MultiPolygon';
}

function polygonBearingContexts(contexts) {
    return (contexts || []).filter((ctx) => ticketContextHasPolygon(ctx));
}

function contextsForBase(contexts, base) {
    const b = String(base || '').trim();
    return (contexts || []).filter((ctx) => ctx && String(ctx.base || '').trim() === b);
}

function photoInAnyMapWindow(createdAt, matchingContexts) {
    if (!matchingContexts || !matchingContexts.length) return false;
    return matchingContexts.some((ctx) => photoInMapWindow(createdAt, ctx.timeWindow));
}

function paddingForMeters(lat, meters) {
    const latPad = meters / 111320;
    const cosLat = Math.cos(Number(lat) * Math.PI / 180);
    const lngPad = cosLat > 1e-6 ? meters / (111320 * cosLat) : latPad;
    return { latPad, lngPad };
}

function contextIndexedAabb(ctx) {
    if (!ctx || !ctx.row) return null;
    const minLat = Number(ctx.row.min_lat);
    const maxLat = Number(ctx.row.max_lat);
    const minLng = Number(ctx.row.min_lng);
    const maxLng = Number(ctx.row.max_lng);
    if (![minLat, maxLat, minLng, maxLng].every(Number.isFinite)) return null;
    return { minLat, maxLat, minLng, maxLng };
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

function unionAabbs(aabbs) {
    const list = (aabbs || []).filter(Boolean);
    if (!list.length) return null;
    let minLat = Infinity;
    let minLng = Infinity;
    let maxLat = -Infinity;
    let maxLng = -Infinity;
    for (const a of list) {
        minLat = Math.min(minLat, a.minLat);
        minLng = Math.min(minLng, a.minLng);
        maxLat = Math.max(maxLat, a.maxLat);
        maxLng = Math.max(maxLng, a.maxLng);
    }
    if (!Number.isFinite(minLat)) return null;
    return { minLat, minLng, maxLat, maxLng };
}

function matchingPolygonContextsForPoint(point, polygonContexts, pointInOrNearTicketPolygon) {
    return (polygonContexts || []).filter(
        (ctx) => ctx && pointInOrNearTicketPolygon(point, ctx.ticket.polygon)
    );
}

function passesMediaFilters(row, tags, uploadedByFilter) {
    if (!photoMatchesTagFilter(row.metadata, tags)) return false;
    if (uploadedByFilter) {
        const ub = String(row.uploaded_by || '').toLowerCase();
        if (!ub.includes(uploadedByFilter)) return false;
    }
    return true;
}

async function loadAssociatedContextForBase(db, orgId, base) {
    const baseStr = String(base || '').trim();
    if (!baseStr) return null;
    const row = await getRow(
        db,
        `SELECT * FROM tickets
         WHERE organization_id = ?
           AND (ticket_number = ? OR ticket_number LIKE ?)
         ORDER BY
           CASE WHEN polygon_json IS NOT NULL AND TRIM(polygon_json) != '' THEN 0 ELSE 1 END,
           updated_at DESC, id DESC
         LIMIT 1`,
        [orgId, baseStr, `${baseStr}-%`]
    );
    if (!row) return null;
    const ticket = applyIndexedColumnsToTicketShape({}, row);
    Object.assign(ticket, {
        id: row.id,
        ticketNumber: row.ticket_number,
        ticket_expires_at: row.ticket_expires_at,
        organizationId: orgId,
        revision: row.revision != null ? String(row.revision) : null,
        ticketRevision: row.revision != null ? String(row.revision) : ticket.ticketRevision || null,
    });
    if (row.pin_lat != null && row.pin_lng != null) {
        ticket.stubMapPin = { lat: Number(row.pin_lat), lng: Number(row.pin_lng) };
    }
    return { ticket, row, base: baseStr };
}

/**
 * GPS map read path: point in/near active ticket polygons (+ buffer). Pin-only active tickets are excluded.
 */
async function querySpatialMediaForContexts(db, orgId, contexts, bbox) {
    const { pointInOrNearTicketPolygon } = require('./ticketPhotoIntersection.cjs');
    const polygonContexts = polygonBearingContexts(contexts);
    if (!polygonContexts.length) return [];

    const mediaRows = await allRows(
        db,
        `SELECT m.id, m.file_name, m.thumbnail_path, m.created_at, m.latitude, m.longitude, m.has_gps, m.metadata,
                COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, u.email) AS uploaded_by
         FROM media_files m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = ?
           AND m.file_type = 'photo'
           AND m.has_gps = 1
           AND m.latitude BETWEEN ? AND ?
           AND m.longitude BETWEEN ? AND ?
         ORDER BY datetime(m.created_at) DESC, m.id DESC
         LIMIT 5000`,
        [orgId, bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng]
    );

    const out = [];
    for (const row of mediaRows || []) {
        const lat = Number(row.latitude);
        const lng = Number(row.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !pointInBbox(lat, lng, bbox)) continue;
        const matchingContexts = matchingPolygonContextsForPoint(
            { lat, lng },
            polygonContexts,
            pointInOrNearTicketPolygon
        );
        if (!matchingContexts.length) continue;
        out.push({
            ...row,
            ticket_base_number: matchingContexts[0].base,
            source: 'spatial',
            matchingContexts,
        });
    }
    return out;
}

async function queryJunctionMediaForBases(db, orgId, bases, bbox) {
    if (!bases.length) return [];
    const placeholders = bases.map(() => '?').join(',');
    const params = [orgId, ...bases, bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng];
    try {
        return await allRows(
            db,
            `SELECT m.id, m.file_name, m.thumbnail_path, m.created_at, m.latitude, m.longitude, m.has_gps, m.metadata,
                    j.ticket_base_number, j.source,
                    COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, u.email) AS uploaded_by
             FROM media_ticket_intersections j
             INNER JOIN media_files m ON m.id = j.media_id AND m.organization_id = j.organization_id
             LEFT JOIN users u ON u.id = m.user_id
             WHERE j.organization_id = ?
               AND j.ticket_base_number IN (${placeholders})
               AND m.file_type = 'photo'
               AND (
                 (m.has_gps = 1 AND m.latitude BETWEEN ? AND ? AND m.longitude BETWEEN ? AND ?)
                 OR m.has_gps = 0
               )
             ORDER BY datetime(m.created_at) DESC, m.id DESC
             LIMIT 5000`,
            params
        );
    } catch (e) {
        if (/no such table/i.test((e && e.message) || '')) return [];
        throw e;
    }
}

/** No-GPS map read path for active in-view bases. */
async function queryJunctionNoGpsForBases(db, orgId, bases, bbox) {
    if (!bases.length) return [];
    const placeholders = bases.map(() => '?').join(',');
    const params = [orgId, ...bases];
    try {
        return await allRows(
            db,
            `SELECT m.id, m.file_name, m.thumbnail_path, m.created_at, m.latitude, m.longitude, m.has_gps, m.metadata,
                    j.ticket_base_number, j.source,
                    COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, u.email) AS uploaded_by
             FROM media_ticket_intersections j
             INNER JOIN media_files m ON m.id = j.media_id AND m.organization_id = j.organization_id
             LEFT JOIN users u ON u.id = m.user_id
             WHERE j.organization_id = ?
               AND j.ticket_base_number IN (${placeholders})
               AND j.source = 'associated_no_gps'
               AND m.file_type = 'photo'
               AND m.has_gps = 0
             ORDER BY datetime(m.created_at) DESC, m.id DESC
             LIMIT 5000`,
            params
        );
    } catch (e) {
        if (/no such table/i.test((e && e.message) || '')) return [];
        throw e;
    }
}

async function loadInactiveCandidateBasesNearContexts(db, orgId, polygonContexts, activeBases) {
    const expanded = unionAabbs(
        polygonContexts.map((ctx) => expandAabbByMeters(contextIndexedAabb(ctx), TICKET_PHOTO_SEARCH_BUFFER_METERS))
    );
    if (!expanded) return [];
    const activeList = Array.from(activeBases || []);
    const inactiveSql = ticketInactiveListSqlPredicate();
    const baseExpr = `CASE
      WHEN instr(t.ticket_number, '-') > 0 THEN substr(t.ticket_number, 1, instr(t.ticket_number, '-') - 1)
      ELSE t.ticket_number
    END`;
    const excludeSql = activeList.length
        ? `AND (${baseExpr}) NOT IN (${activeList.map(() => '?').join(',')})`
        : '';
    const geomRows = await allRows(
        db,
        `SELECT DISTINCT ${baseExpr} AS ticket_base_number
         FROM tickets t
         WHERE t.organization_id = ?
           AND t.polygon_json IS NOT NULL
           AND t.min_lat <= ? AND t.max_lat >= ?
           AND t.min_lng <= ? AND t.max_lng >= ?
           ${excludeSql}
           AND (${inactiveSql})`,
        [orgId, expanded.maxLat, expanded.minLat, expanded.maxLng, expanded.minLng, ...activeList]
    );
    return (geomRows || [])
        .map((r) => String(r.ticket_base_number || '').trim())
        .filter(Boolean);
}

/**
 * No-GPS on expired/cancelled bases when associated anchor is within an active polygon (+ buffer).
 */
async function queryAssociatedNoGpsNearActiveContexts(db, orgId, activeContexts, activeBases, bbox) {
    const { pointInOrNearTicketPolygon } = require('./ticketPhotoIntersection.cjs');
    const polygonContexts = polygonBearingContexts(activeContexts);
    if (!polygonContexts.length) return [];

    const candidateBases = await loadInactiveCandidateBasesNearContexts(db, orgId, polygonContexts, activeBases);
    if (!candidateBases.length) return [];

    const rows = await queryJunctionNoGpsForBases(db, orgId, candidateBases, bbox);
    const assocContextCache = new Map();
    const out = [];

    for (const row of rows || []) {
        const base = String(row.ticket_base_number || '').trim();
        if (!base) continue;
        let assocCtx = assocContextCache.get(base);
        if (!assocCtx) {
            assocCtx = await loadAssociatedContextForBase(db, orgId, base);
            if (assocCtx) assocContextCache.set(base, assocCtx);
        }
        if (!assocCtx) continue;
        const anchor = ticketCentroidOrAnchor(assocCtx);
        if (!anchor || !Number.isFinite(anchor.lat) || !Number.isFinite(anchor.lng)) continue;
        const matchingContexts = matchingPolygonContextsForPoint(
            anchor,
            polygonContexts,
            pointInOrNearTicketPolygon
        );
        if (!matchingContexts.length) continue;
        out.push({
            ...row,
            matchingContexts,
            associatedContext: assocCtx,
        });
    }
    return out;
}

/**
 * @param {object} db
 * @param {number} orgId
 * @param {object[]} contexts
 * @param {{ minLng, minLat, maxLng, maxLat }} bbox
 * @param {{ tags?: string[], uploadedBy?: string }} [filters]
 */
async function collectMapPhotosForContexts(db, orgId, contexts, bbox, filters) {
    const baseToContext = new Map();
    for (const ctx of contexts) {
        if (ctx.base) baseToContext.set(ctx.base, ctx);
    }
    const bases = Array.from(baseToContext.keys());
    const activeBases = new Set(bases);

    const [spatialRows, noGpsActiveRows, noGpsExpiredRows] = await Promise.all([
        querySpatialMediaForContexts(db, orgId, contexts, bbox),
        queryJunctionNoGpsForBases(db, orgId, bases, bbox),
        queryAssociatedNoGpsNearActiveContexts(db, orgId, contexts, activeBases, bbox),
    ]);

    const tags = parseTagsFilter(filters && filters.tags);
    const uploadedByFilter =
        filters && filters.uploadedBy != null && String(filters.uploadedBy).trim() !== ''
            ? String(filters.uploadedBy).trim().toLowerCase()
            : null;

    const seen = new Set();
    const points = [];
    const noGpsByBase = new Map();

    for (const row of spatialRows) {
        const matchingContexts = row.matchingContexts || [];
        if (!photoInAnyMapWindow(row.created_at, matchingContexts)) continue;
        if (!passesMediaFilters(row, tags, uploadedByFilter)) continue;
        const id = Number(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        const lat = Number(row.latitude);
        const lng = Number(row.longitude);
        if (!pointInBbox(lat, lng, bbox)) continue;
        const base = String(row.ticket_base_number || matchingContexts[0].base || '').trim();
        points.push(mediaRowToPoint(row, { ticketBaseNumber: base, associatedNoGps: false }));
    }

    for (const row of noGpsActiveRows) {
        const base = String(row.ticket_base_number || '').trim();
        const matchingContexts = contextsForBase(contexts, base);
        if (!matchingContexts.length) continue;
        if (!photoInAnyMapWindow(row.created_at, matchingContexts)) continue;
        if (!passesMediaFilters(row, tags, uploadedByFilter)) continue;
        const id = Number(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        const displayCtx = matchingContexts[0];
        if (!noGpsByBase.has(base)) noGpsByBase.set(base, { ctx: displayCtx, rows: [] });
        noGpsByBase.get(base).rows.push(row);
    }

    for (const row of noGpsExpiredRows) {
        const base = String(row.ticket_base_number || '').trim();
        const matchingContexts = row.matchingContexts || [];
        const assocCtx = row.associatedContext;
        if (!base || !assocCtx || !matchingContexts.length) continue;
        if (!photoInAnyMapWindow(row.created_at, matchingContexts)) continue;
        if (!passesMediaFilters(row, tags, uploadedByFilter)) continue;
        const id = Number(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        if (!noGpsByBase.has(base)) noGpsByBase.set(base, { ctx: assocCtx, rows: [] });
        noGpsByBase.get(base).rows.push(row);
    }

    const noGpsClusters = [];
    for (const [base, group] of noGpsByBase.entries()) {
        const centroid = ticketCentroidOrAnchor(group.ctx);
        if (!centroid || !pointInBbox(centroid.lat, centroid.lng, bbox)) continue;
        const rowsForBase = group.rows || [];
        if (!rowsForBase.length) continue;
        if (rowsForBase.length === 1) {
            points.push(
                mediaRowToPoint(rowsForBase[0], {
                    lat: centroid.lat,
                    lng: centroid.lng,
                    associatedNoGps: true,
                    ticketBaseNumber: base,
                })
            );
            continue;
        }
        const pos = offsetNoGpsClusterPosition(centroid.lat, centroid.lng, points);
        let hasThumb = false;
        for (const row of rowsForBase) {
            if (row.thumbnail_path) {
                hasThumb = true;
                break;
            }
        }
        noGpsClusters.push({
            clusterKind: 'associated_no_gps',
            ticketBaseNumber: base,
            cellKey: `nogps:${base}`,
            count: rowsForBase.length,
            lat: pos.lat,
            lng: pos.lng,
            hasThumb,
            associatedNoGps: true,
            sampleIds: rowsForBase.slice(0, 5).map((r) => Number(r.id)),
        });
    }

    return { points, noGpsClusters };
}

/**
 * @param {object} opts
 * @param {number} opts.orgId
 * @param {number[]} opts.ticketIds
 * @param {{ minLng, minLat, maxLng, maxLat }} opts.bbox
 * @param {{ tags?: string[], uploadedBy?: string }} [opts.filters]
 */
async function getPhotoPointsForTickets(db, opts) {
    const { orgId, ticketIds, bbox, filters } = opts;
    const contexts = await loadTicketContexts(db, orgId, ticketIds);
    if (!contexts.length) {
        return { points: [], noGpsClusters: [], skipReason: 'no_active_tickets' };
    }
    const { points, noGpsClusters } = await collectMapPhotosForContexts(db, orgId, contexts, bbox, filters);
    return { points, noGpsClusters, skipReason: null };
}

function applyNonGpsOffsets(points) {
    const gpsPositions = new Set();
    for (const p of points) {
        if (p.hasGps && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
            gpsPositions.add(`${p.lat.toFixed(6)},${p.lng.toFixed(6)}`);
        }
    }
    const centroidCounts = new Map();
    return points.map((p) => {
        if (!p.associatedNoGps || p.hasGps) return p;
        const key = `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`;
        const idx = centroidCounts.get(key) || 0;
        centroidCounts.set(key, idx + 1);
        const offsetLat = idx * 0.00004;
        const offsetLng = idx * 0.00004;
        const posKey = `${(p.lat + offsetLat).toFixed(6)},${(p.lng + offsetLng).toFixed(6)}`;
        if (gpsPositions.has(posKey) || gpsPositions.has(key)) {
            return { ...p, lat: p.lat + offsetLat + 0.00005, lng: p.lng + offsetLng + 0.00005 };
        }
        return { ...p, lat: p.lat + offsetLat, lng: p.lng + offsetLng };
    });
}

function clusterPoints(points, zoom) {
    const cell = gridCellSizeForZoom(zoom);
    if (!cell) return [];
    const buckets = new Map();
    for (const p of points) {
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
        const gx = Math.floor(p.lng / cell);
        const gy = Math.floor(p.lat / cell);
        const key = `${gx}:${gy}`;
        if (!buckets.has(key)) {
            buckets.set(key, { count: 0, latSum: 0, lngSum: 0, hasThumb: false, ids: [] });
        }
        const b = buckets.get(key);
        b.count++;
        b.latSum += p.lat;
        b.lngSum += p.lng;
        if (p.thumbnailUrl) b.hasThumb = true;
        if (b.ids.length < 5) b.ids.push(p.id);
    }
    return Array.from(buckets.entries()).map(([key, b]) => ({
        cellKey: key,
        count: b.count,
        lat: b.latSum / b.count,
        lng: b.lngSum / b.count,
        hasThumb: b.hasThumb,
        sampleIds: b.ids,
    }));
}

async function getNoGpsGalleryPointsForBase(db, orgId, opts, ticketBaseNumber) {
    const base = String(ticketBaseNumber || '').trim();
    if (!base) return [];
    const { bbox, filters } = opts;
    const { points, noGpsClusters } = await getPhotoPointsForTickets(db, {
        orgId,
        ticketIds: opts.ticketIds,
        bbox,
        filters,
    });
    const fromPoints = points.filter((p) => p.associatedNoGps && p.ticketBaseNumber === base);
    if (fromPoints.length > 1) return fromPoints;
    const cluster = (noGpsClusters || []).find((c) => c.ticketBaseNumber === base);
    if (!cluster || !Array.isArray(cluster.sampleIds) || !cluster.sampleIds.length) return fromPoints;

    const contexts = await loadTicketContexts(db, orgId, opts.ticketIds);
    const activeBases = new Set(contexts.map((c) => c.base).filter(Boolean));
    const tags = parseTagsFilter(filters && filters.tags);
    const uploadedByFilter =
        filters && filters.uploadedBy != null && String(filters.uploadedBy).trim() !== ''
            ? String(filters.uploadedBy).trim().toLowerCase()
            : null;

    let rows = [];
    if (activeBases.has(base)) {
        rows = await queryJunctionNoGpsForBases(db, orgId, [base], bbox);
    } else {
        const expiredRows = await queryAssociatedNoGpsNearActiveContexts(db, orgId, contexts, activeBases, bbox);
        rows = expiredRows.filter((r) => String(r.ticket_base_number || '').trim() === base);
    }

    const assocCtx = activeBases.has(base)
        ? contexts.find((c) => c.base === base) || (await loadAssociatedContextForBase(db, orgId, base))
        : (await loadAssociatedContextForBase(db, orgId, base));
    const centroid = ticketCentroidOrAnchor(assocCtx);
    if (!centroid) return fromPoints;

    const out = [];
    for (const row of rows) {
        const matchingContexts = row.matchingContexts || contextsForBase(contexts, base);
        if (!photoInAnyMapWindow(row.created_at, matchingContexts)) continue;
        if (!passesMediaFilters(row, tags, uploadedByFilter)) continue;
        out.push(
            mediaRowToPoint(row, {
                lat: centroid.lat,
                lng: centroid.lng,
                associatedNoGps: true,
                ticketBaseNumber: base,
            })
        );
    }
    return out.length ? out : fromPoints;
}

/**
 * @param {boolean} [forceClusters]
 */
async function getPhotoMapPayload(db, opts, forceClusters) {
    const zoom = Number(opts.zoom);
    if (!Number.isFinite(zoom) || zoom < PHOTO_MAP_MIN_ZOOM) {
        return { mode: 'points', items: [], noGpsClusters: [], skipReason: 'zoom_below_min' };
    }
    const { points, noGpsClusters, skipReason } = await getPhotoPointsForTickets(db, opts);
    if (skipReason) {
        return { mode: 'points', items: [], noGpsClusters: [], skipReason };
    }
    const adjusted = applyNonGpsOffsets(points);
    const useClusters =
        forceClusters === true
            ? adjusted.length > CLUSTER_HYSTERESIS_LOW
            : adjusted.length > CLUSTER_POINT_THRESHOLD &&
              (!Number.isFinite(zoom) || zoom < PHOTO_MAP_POINT_MODE_MAX_ZOOM);
    if (useClusters) {
        return {
            mode: 'clusters',
            items: clusterPoints(adjusted, zoom),
            noGpsClusters: noGpsClusters || [],
            pointCount: adjusted.length,
        };
    }
    return {
        mode: 'points',
        items: adjusted,
        noGpsClusters: noGpsClusters || [],
        pointCount: adjusted.length,
    };
}

async function getPhotoPointsInBbox(db, opts) {
    const { orgId, bbox, filters, limit, createdFrom, createdTo } = opts;
    const cap = Math.min(Number(limit) || MANAGE_DATA_SPATIAL_CAP, MANAGE_DATA_SPATIAL_CAP);
    const tags = parseTagsFilter(filters && filters.tags);
    const params = [orgId, bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng];
    let dateSql = '';
    if (createdFrom) {
        dateSql += ' AND datetime(m.created_at) >= datetime(?)';
        params.push(String(createdFrom));
    }
    if (createdTo) {
        dateSql += ' AND datetime(m.created_at) <= datetime(?)';
        params.push(String(createdTo));
    }
    params.push(cap + 1);
    const rows = await allRows(
        db,
        `SELECT m.id, m.file_name, m.thumbnail_path, m.created_at, m.latitude, m.longitude, m.has_gps, m.metadata,
                COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, u.email) AS uploaded_by
         FROM media_files m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = ?
           AND m.file_type = 'photo'
           AND m.has_gps = 1
           AND m.latitude BETWEEN ? AND ?
           AND m.longitude BETWEEN ? AND ?${dateSql}
         ORDER BY datetime(m.created_at) DESC, m.id DESC
         LIMIT ?`,
        params
    );
    const densityWarning = rows.length > cap;
    const trimmed = rows.slice(0, cap);
    const points = [];
    for (const row of trimmed) {
        if (!photoMatchesTagFilter(row.metadata, tags)) continue;
        points.push(mediaRowToPoint(row));
    }
    return {
        points,
        totalMatched: rows.length,
        capped: densityWarning,
        cap: MANAGE_DATA_SPATIAL_CAP,
    };
}

async function getClusterPage(db, orgId, opts) {
    const { bbox, ticketIds, cellKey, page, limit, sort, order, filters, clusterKind, ticketBaseNumber, photoIds } =
        opts;
    const pageNum = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 50));
    const sortKey = sort === 'fileName' ? 'fileName' : 'createdAt';
    const dir = order === 'asc' ? 1 : -1;

    let filtered = [];

    const idList = (typeof photoIds === 'string' ? photoIds.split(',') : photoIds || [])
        .map((id) => Number(String(id).trim()))
        .filter((id) => Number.isFinite(id) && id > 0);

    const galleryBbox = CLUSTER_GALLERY_BBOX;

    if (idList.length) {
        const { points } = await getPhotoPointsForTickets(db, {
            orgId,
            ticketIds,
            bbox: galleryBbox,
            filters,
        });
        const adjusted = applyNonGpsOffsets(points);
        const idSet = new Set(idList);
        filtered = adjusted.filter((p) => idSet.has(p.id));
    } else if (
        clusterKind === 'associated_no_gps' &&
        ticketBaseNumber != null &&
        String(ticketBaseNumber).trim() !== ''
    ) {
        filtered = await getNoGpsGalleryPointsForBase(
            db,
            orgId,
            { ticketIds, bbox: galleryBbox, filters },
            ticketBaseNumber
        );
    } else {
        const { points } = await getPhotoPointsForTickets(db, {
            orgId,
            ticketIds,
            bbox: galleryBbox,
            filters,
        });
        const adjusted = applyNonGpsOffsets(points);
        const cell = gridCellSizeForZoom(opts.zoom || PHOTO_MAP_MIN_ZOOM);
        filtered = adjusted;
        const key = cellKey != null ? String(cellKey) : '';
        if (key.startsWith('nogps:')) {
            const base = key.slice(6);
            filtered = await getNoGpsGalleryPointsForBase(db, orgId, { ticketIds, bbox, filters }, base);
        } else if (key && cell) {
            const parts = key.split(':').map((n) => Number(n));
            if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
                const [gx, gy] = parts;
                filtered = adjusted.filter((p) => {
                    const px = Math.floor(p.lng / cell);
                    const py = Math.floor(p.lat / cell);
                    return px === gx && py === gy;
                });
            }
        }
    }

    filtered.sort((a, b) => {
        const av = sortKey === 'fileName' ? String(a.fileName || '') : String(a.createdAt || '');
        const bv = sortKey === 'fileName' ? String(b.fileName || '') : String(b.createdAt || '');
        if (av < bv) return -dir;
        if (av > bv) return dir;
        return dir * (Number(a.id) - Number(b.id));
    });
    const start = (pageNum - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);
    return {
        items,
        page: pageNum,
        limit: pageSize,
        total: filtered.length,
        hasMore: start + pageSize < filtered.length,
    };
}

function photoPassesComplianceCutoff(createdAt, ticket) {
    if (!ticket || ticket.photoRequirementCutoffPending) return false;
    return photoCreatedAtMeetsRevisionCutoff(createdAt, ticket.photoRequirementCutoffIso);
}

async function getPaginatedTicketPhotos(db, orgId, ticketId, tab, page, limit) {
    const contexts = await loadTicketContexts(db, orgId, [ticketId]);
    const ctx = contexts[0];
    if (!ctx) return { items: [], total: 0, page: 1, limit: 50, hasMore: false };
    const worldBbox = { minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 };
    const tabNorm = String(tab || 'map').toLowerCase();
    let filtered = [];

    if (tabNorm === 'map') {
        const { points, noGpsClusters } = await collectMapPhotosForContexts(db, orgId, contexts, worldBbox, {});
        filtered = points.slice();
        for (const cluster of noGpsClusters || []) {
            const gallery = await getNoGpsGalleryPointsForBase(
                db,
                orgId,
                { ticketIds: [ticketId], bbox: worldBbox },
                cluster.ticketBaseNumber
            );
            filtered.push(...gallery);
        }
        const seenIds = new Set();
        filtered = filtered.filter((p) => {
            const id = Number(p.id);
            if (seenIds.has(id)) return false;
            seenIds.add(id);
            return true;
        });
    } else {
        let rows = await queryJunctionMediaForBases(db, orgId, [ctx.base], worldBbox);
        if (!rows.length) {
            rows = await querySpatialMediaForContexts(db, orgId, contexts, worldBbox);
        }
        for (const row of rows) {
            if (tabNorm === 'compliance') {
                if (!photoPassesComplianceCutoff(row.created_at, ctx.ticket)) continue;
            }
            filtered.push(
                mediaRowToPoint(row, {
                    associatedNoGps: row.source === 'associated_no_gps' || Number(row.has_gps) !== 1,
                    ticketBaseNumber: ctx.base,
                })
            );
        }
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 50));
    const start = (pageNum - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);
    return {
        items,
        total: filtered.length,
        page: pageNum,
        limit: pageSize,
        hasMore: start + pageSize < filtered.length,
        stats: ctx.ticket.ticketPhotoStats && ctx.ticket.ticketPhotoStats.stats
            ? ctx.ticket.ticketPhotoStats.stats
            : null,
    };
}

module.exports = {
    PHOTO_MAP_MIN_ZOOM,
    CLUSTER_POINT_THRESHOLD,
    MANAGE_DATA_SPATIAL_CAP,
    parseBboxParam,
    gridCellSizeForZoom,
    cellKeyForLatLng,
    getPhotoPointsForTickets,
    getPhotoMapPayload,
    getPhotoPointsInBbox,
    getClusterPage,
    getPaginatedTicketPhotos,
};
