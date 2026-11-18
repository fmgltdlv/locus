/**
 * Server-side aerial map queries (geometry via @turf/turf).
 * Aerial access is **Enhanced tier only**. Basic: no maps.
 * Refresh returns global catalog maps in the current viewport.
 * Auto-load returns viewport maps that intersect tickets currently in the viewport.
 * Newest first. for-view requires zoom 16 and bbox. Client only draws tiles at zoom 16+.
 */

const turf = require('@turf/turf');
const ticketBuilder = require('./ticketBuilder.cjs');
const { getRow, runDb } = require('./db.cjs');

const { calculateTicketStatus } = ticketBuilder;

const ACCESS_MODES = Object.freeze(['global', 'restricted', 'hidden']);

function safeParseSettings(settingsRaw) {
    if (settingsRaw == null || settingsRaw === '') return {};
    try {
        return typeof settingsRaw === 'string' ? JSON.parse(settingsRaw) : settingsRaw;
    } catch {
        return {};
    }
}

/**
 * @param {string|object|null} settingsRaw
 * @returns {'basic'|'enhanced'}
 */
function getProductTierFromSettingsOnly(settingsRaw) {
    const s = safeParseSettings(settingsRaw);
    const t = (s.subscriptionTier || s.subscription_tier || 'basic').toString().toLowerCase();
    if (t === 'plus' || t === 'max' || t === 'enhanced') return 'enhanced';
    return 'basic';
}

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

/**
 * @param {unknown} accessMode
 * @param {unknown} [hiddenFromUsers]
 * @returns {'global'|'restricted'|'hidden'}
 */
function normalizeAccessMode(accessMode, hiddenFromUsers) {
    const raw = accessMode != null ? String(accessMode).trim().toLowerCase() : '';
    if (ACCESS_MODES.includes(raw)) return raw;
    if (Number(hiddenFromUsers) === 1) return 'hidden';
    return 'global';
}

function hiddenFromUsersForAccessMode(accessMode) {
    return accessMode === 'hidden' ? 1 : 0;
}

/**
 * SQL fragment for org-aware aerial catalog access.
 * @param {string} alias
 * @param {number|null|undefined} orgId
 * @param {{ devBypass?: boolean, globalOnly?: boolean }} [options]
 * @returns {{ sql: string, params: unknown[] }}
 */
function orgAerialAccessWhereSql(alias, orgId, options = {}) {
    const modeExpr = `COALESCE(${alias}.access_mode, CASE WHEN COALESCE(${alias}.hidden_from_users, 0) = 1 THEN 'hidden' ELSE 'global' END)`;
    if (options.devBypass) {
        return { sql: '', params: [] };
    }
    if (options.globalOnly) {
        return {
            sql: `AND ${modeExpr} = 'global'`,
            params: [],
        };
    }
    const oid = orgId != null ? Number(orgId) : NaN;
    if (!Number.isFinite(oid)) {
        return {
            sql: `AND ${modeExpr} NOT IN ('hidden', 'restricted')`,
            params: [],
        };
    }
    return {
        sql: `AND ${modeExpr} != 'hidden'
              AND (
                ${modeExpr} = 'global'
                OR (
                  ${modeExpr} = 'restricted'
                  AND EXISTS (
                    SELECT 1 FROM aerial_map_org_access x
                    WHERE x.aerial_map_id = ${alias}.id AND x.organization_id = ?
                  )
                )
              )`,
        params: [oid],
    };
}

/**
 * Simpler access check using normalized mode from a row object.
 * @param {Record<string, unknown>|null|undefined} mapRow
 * @param {number} orgId
 * @returns {boolean}
 */
function orgCanAccessAerialMapRow(mapRow, orgId) {
    if (!mapRow) return false;
    const mode = normalizeAccessMode(mapRow.access_mode, mapRow.hidden_from_users);
    if (mode === 'hidden') return false;
    if (mode === 'global') return true;
    if (mode === 'restricted') {
        const allowed = mapRow._orgHasAccess === true || mapRow.org_has_access === 1;
        return allowed;
    }
    return false;
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number} orgId
 * @param {number} mapId
 */
async function orgCanAccessAerialMap(db, orgId, mapId) {
    const oid = Number(orgId);
    const mid = Number(mapId);
    if (!Number.isFinite(oid) || !Number.isFinite(mid)) return false;
    const row = await getRow(
        db,
        `SELECT a.id, a.access_mode, a.hidden_from_users, a.organization_id,
                CASE WHEN EXISTS (
                  SELECT 1 FROM aerial_map_org_access x
                  WHERE x.aerial_map_id = a.id AND x.organization_id = ?
                ) THEN 1 ELSE 0 END AS org_has_access
         FROM aerial_maps a
         WHERE a.id = ? AND (a.organization_id IS NULL OR a.organization_id = ?)`,
        [oid, mid, oid]
    );
    if (!row) return false;
    return orgCanAccessAerialMapRow(row, oid);
}

/**
 * Delete favorites for orgs that no longer have access after access_mode / allowlist changes.
 * @param {import('sqlite3').Database} db
 * @param {number} mapId
 */
async function pruneAerialFavoritesForMapAccess(db, mapId) {
    const mid = Number(mapId);
    if (!Number.isFinite(mid)) return;
    const row = await getRow(db, 'SELECT access_mode, hidden_from_users FROM aerial_maps WHERE id = ?', [mid]);
    if (!row) return;
    const mode = normalizeAccessMode(row.access_mode, row.hidden_from_users);
    if (mode === 'hidden') {
        await runDb(db, 'DELETE FROM org_aerial_favorites WHERE aerial_map_id = ?', [mid]);
        return;
    }
    if (mode === 'restricted') {
        const allowRows = await allAsync(
            db,
            'SELECT organization_id FROM aerial_map_org_access WHERE aerial_map_id = ?',
            [mid]
        );
        const allowedIds = (allowRows || []).map((r) => Number(r.organization_id)).filter((id) => Number.isFinite(id));
        if (allowedIds.length === 0) {
            await runDb(db, 'DELETE FROM org_aerial_favorites WHERE aerial_map_id = ?', [mid]);
            return;
        }
        const placeholders = allowedIds.map(() => '?').join(',');
        await runDb(
            db,
            `DELETE FROM org_aerial_favorites WHERE aerial_map_id = ? AND organization_id NOT IN (${placeholders})`,
            [mid, ...allowedIds]
        );
    }
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number[]} mapIds
 * @returns {Promise<Map<number, { id: number, name: string }[]>>}
 */
async function loadAllowedOrganizationsForMaps(db, mapIds) {
    const out = new Map();
    const ids = [...new Set((mapIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
    if (!ids.length) return out;
    for (let i = 0; i < ids.length; i += D1_SAFE_IN_CHUNK) {
        const chunk = ids.slice(i, i + D1_SAFE_IN_CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await allAsync(
            db,
            `SELECT x.aerial_map_id, o.id, o.name
             FROM aerial_map_org_access x
             JOIN organizations o ON o.id = x.organization_id
             WHERE x.aerial_map_id IN (${placeholders})
             ORDER BY o.name ASC`,
            chunk
        );
        for (const row of rows || []) {
            const mapId = Number(row.aerial_map_id);
            if (!out.has(mapId)) out.set(mapId, []);
            out.get(mapId).push({ id: Number(row.id), name: String(row.name || '') });
        }
    }
    return out;
}

function intersectsPolygons(polyA, polyB) {
    if (!polyA || !polyB || polyA.type !== 'Polygon' || polyB.type !== 'Polygon') return false;
    try {
        const a = polyA.coordinates && polyA.coordinates[0] && polyA.coordinates[0].length >= 4;
        const b = polyB.coordinates && polyB.coordinates[0] && polyB.coordinates[0].length >= 4;
        if (!a || !b) return false;
        return turf.booleanIntersects(turf.feature(polyA), turf.feature(polyB));
    } catch {
        return false;
    }
}

/** Ticket polygon from indexed GeoJSON storage. Footprint is always a single Polygon (map extent). */
function ticketPolygonIntersectsFootprint(geom, footprint) {
    if (!geom || !footprint || footprint.type !== 'Polygon') return false;
    if (geom.type === 'Polygon') {
        return intersectsPolygons(geom, footprint);
    }
    if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
        for (const rings of geom.coordinates) {
            if (!Array.isArray(rings) || rings.length === 0) continue;
            const p = { type: 'Polygon', coordinates: rings };
            if (intersectsPolygons(p, footprint)) return true;
        }
    }
    return false;
}

function mapFootprintIntersectsBbox(geo, bboxPoly) {
    if (!geo || !bboxPoly) return false;
    try {
        if (geo.type === 'Polygon') {
            return intersectsPolygons(geo, bboxPoly);
        }
        if (geo.type === 'MultiPolygon' && Array.isArray(geo.coordinates)) {
            for (const rings of geo.coordinates) {
                if (!Array.isArray(rings) || rings.length === 0) continue;
                const p = { type: 'Polygon', coordinates: rings };
                if (intersectsPolygons(p, bboxPoly)) return true;
            }
        }
    } catch {
        return false;
    }
    return false;
}

/**
 * @param {import('geojson').Polygon} mapPolygonFromRow
 * @param {{ minLng: number, minLat: number, maxLng: number, maxLat: number }} viewBbox
 */
function mapIntersectsViewBbox(mapPolygonFromRow, viewBbox) {
    if (!viewBbox || !Number.isFinite(viewBbox.minLng)) return true;
    const bpoly = polygonFromAabb(
        viewBbox.minLng,
        viewBbox.minLat,
        viewBbox.maxLng,
        viewBbox.maxLat
    );
    if (!bpoly) return true;
    return mapFootprintIntersectsBbox(mapPolygonFromRow, bpoly);
}

function polygonFromAabb(minLng, minLat, maxLng, maxLat) {
    if (
        !Number.isFinite(minLng) ||
        !Number.isFinite(minLat) ||
        !Number.isFinite(maxLng) ||
        !Number.isFinite(maxLat)
    ) {
        return null;
    }
    return {
        type: 'Polygon',
        coordinates: [
            [
                [minLng, minLat],
                [maxLng, minLat],
                [maxLng, maxLat],
                [minLng, maxLat],
                [minLng, minLat],
            ],
        ],
    };
}

function getRowAabb(row) {
    if (!row) return null;
    const minLng = Number(row.min_lng);
    const minLat = Number(row.min_lat);
    const maxLng = Number(row.max_lng);
    const maxLat = Number(row.max_lat);
    if (![minLng, minLat, maxLng, maxLat].every((n) => Number.isFinite(n))) return null;
    return { min_lng: minLng, min_lat: minLat, max_lng: maxLng, max_lat: maxLat };
}

function bboxToAabb(bbox) {
    if (
        !bbox ||
        !Number.isFinite(bbox.minLng) ||
        !Number.isFinite(bbox.minLat) ||
        !Number.isFinite(bbox.maxLng) ||
        !Number.isFinite(bbox.maxLat)
    ) {
        return null;
    }
    return { min_lng: bbox.minLng, min_lat: bbox.minLat, max_lng: bbox.maxLng, max_lat: bbox.maxLat };
}

function aabbIntersects(a, b) {
    if (!a || !b) return true;
    return a.min_lng <= b.max_lng && a.max_lng >= b.min_lng && a.min_lat <= b.max_lat && a.max_lat >= b.min_lat;
}

function rowAabbIntersectsBbox(row, bbox) {
    const a = getRowAabb(row);
    const b = bboxToAabb(bbox);
    return aabbIntersects(a, b);
}

function parseBoundingBox(row) {
    if (row.min_lng != null && row.max_lng != null && row.min_lat != null && row.max_lat != null) {
        return polygonFromAabb(row.min_lng, row.min_lat, row.max_lng, row.max_lat);
    }
    return null;
}

function rowToMap(row, extra = {}) {
    const boundingBox = parseBoundingBox(row);
    const minNativeZoom =
        row.min_native_zoom != null && Number.isFinite(Number(row.min_native_zoom))
            ? Number(row.min_native_zoom)
            : null;
    const maxNativeZoom =
        row.max_native_zoom != null && Number.isFinite(Number(row.max_native_zoom))
            ? Number(row.max_native_zoom)
            : null;
    const accessMode = normalizeAccessMode(row.access_mode, row.hidden_from_users);
    return {
        id: row.id,
        name: row.name,
        url: row.url,
        boundingBox,
        minNativeZoom,
        maxNativeZoom,
        capturedAt: row.captured_at || row.created_at,
        createdAt: row.created_at,
        organizationId: row.organization_id,
        addedBy: row.added_by,
        accessMode,
        hiddenFromUsers: accessMode === 'hidden',
        ...extra,
    };
}

function parseGeoJson(value) {
    if (!value) return null;
    try {
        return typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        return null;
    }
}

/** D1 caps bound parameters per query (~100); chunk large `IN` lists (Miniflare allows more). */
const D1_SAFE_IN_CHUNK = 99;

async function loadOperatorResponsesForTickets(db, ticketIds) {
    if (!Array.isArray(ticketIds) || ticketIds.length === 0) return new Map();
    const byTicket = new Map();
    for (let i = 0; i < ticketIds.length; i += D1_SAFE_IN_CHUNK) {
        const chunk = ticketIds.slice(i, i + D1_SAFE_IN_CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await allAsync(
            db,
            `SELECT ticket_id, station_code, operator_code, status_code, operator_status
             FROM ticket_operator_responses
             WHERE ticket_id IN (${placeholders})
             ORDER BY response_index ASC, id ASC`,
            chunk
        );
        for (const row of rows || []) {
            const id = row.ticket_id;
            if (!byTicket.has(id)) byTicket.set(id, []);
            byTicket.get(id).push({
                stationCode: row.station_code,
                operatorCode: row.operator_code,
                statusCode: row.status_code,
                operatorStatus: row.operator_status,
            });
        }
    }
    return byTicket;
}

function parseTicketRow(row, operatorResponsesByTicket) {
    const polygon = parseGeoJson(row.polygon_json);
    const operatorResponses = operatorResponsesByTicket.get(row.id) || [];
    const stationCodes = [
        ...new Set(operatorResponses.map((r) => r.stationCode || r.operatorCode).filter(Boolean)),
    ];
    const status = calculateTicketStatus(
        operatorResponses,
        row.ticket_number,
        row.ticket_expires_at,
        polygon,
        stationCodes
    );
    return {
        id: row.id,
        ticketNumber: row.ticket_number,
        polygon,
        status,
        min_lng: row.min_lng,
        min_lat: row.min_lat,
        max_lng: row.max_lng,
        max_lat: row.max_lat,
    };
}

function capturedAtMs(row) {
    const s = row.captured_at || row.created_at;
    if (!s) return 0;
    const t = new Date(s).getTime();
    return Number.isNaN(t) ? 0 : t;
}

function sortMapsNewestFirst(maps) {
    maps.sort(
        (a, b) =>
            capturedAtMs({ captured_at: b.capturedAt, created_at: b.createdAt }) -
            capturedAtMs({ captured_at: a.capturedAt, created_at: a.createdAt })
    );
    return maps;
}

/**
 * @param {import('sqlite3').Database} db
 * @param {{ minLng: number, minLat: number, maxLng: number, maxLat: number }|null|undefined} bbox
 * @param {number|null|undefined} orgId
 */
async function loadGlobalAerialMaps(db, bbox, orgId) {
    const access = orgAerialAccessWhereSql('a', orgId);
    const params = [...access.params];
    let bboxWhere = '';
    if (bboxToAabb(bbox)) {
        bboxWhere = `
           AND (
             (a.min_lng IS NOT NULL AND a.min_lng <= ? AND a.max_lng >= ? AND a.min_lat <= ? AND a.max_lat >= ?)
             OR a.min_lng IS NULL
           )`;
        params.push(bbox.maxLng, bbox.minLng, bbox.maxLat, bbox.minLat);
    }
    const rows = await allAsync(
        db,
        `SELECT a.id, a.name, a.url,
                a.min_lng, a.min_lat, a.max_lng, a.max_lat,
                a.min_native_zoom, a.max_native_zoom,
                a.captured_at, a.created_at, a.organization_id,
                a.access_mode, a.hidden_from_users,
                u.username as added_by
         FROM aerial_maps a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE a.organization_id IS NULL
         ${access.sql}
         ${bboxWhere}`,
        params
    );
    return rows;
}

async function loadOrgTickets(db, orgId, bbox) {
    const params = [orgId];
    const useBbox = !!bboxToAabb(bbox);
    let bboxWhere = '';
    if (useBbox) {
        bboxWhere = `
           AND (
             (min_lng IS NOT NULL AND min_lng <= ? AND max_lng >= ? AND min_lat <= ? AND max_lat >= ?)
             OR min_lng IS NULL
           )`;
        params.push(bbox.maxLng, bbox.minLng, bbox.maxLat, bbox.minLat);
    }
    const ticketRows = await allAsync(
        db,
        `SELECT id, ticket_number, polygon_json, ticket_expires_at, min_lng, min_lat, max_lng, max_lat
         FROM tickets
         WHERE organization_id = ?
         ${bboxWhere}`,
        params
    );
    const filteredRows = useBbox
        ? ticketRows.filter((row) => rowAabbIntersectsBbox(row, bbox))
        : ticketRows;
    const operatorResponsesByTicket = await loadOperatorResponsesForTickets(
        db,
        filteredRows.map((row) => row.id).filter((id) => id != null)
    );
    return filteredRows.map((row) => parseTicketRow(row, operatorResponsesByTicket)).filter((t) => t !== null);
}

/**
 * @param {Record<string, unknown>|null|undefined} row
 * @returns {'basic'|'enhanced'}
 */
function getProductTierFromOrgRow(row) {
    if (row && row.subscription_tier != null && String(row.subscription_tier).trim() !== '') {
        const t = String(row.subscription_tier).toLowerCase();
        if (t === 'basic') return 'basic';
        if (t === 'plus' || t === 'max' || t === 'enhanced') return 'enhanced';
    }
    return getProductTierFromSettingsOnly(row?.settings);
}

/**
 * @deprecated for aerial: use getProductTierFromOrgRow. Kept for routes that used basic|enhanced.
 * Returns the same as getProductTierFromOrgRow.
 */
function tierFromOrgRow(row) {
    return getProductTierFromOrgRow(row);
}

/**
 * Aerial + favorites: only Enhanced gets imagery. Legacy plus/max rows normalize to Enhanced.
 * @param {Record<string, unknown>|null|undefined} row
 */
function hasAerialEntitlementFromOrgRow(row) {
    return getProductTierFromOrgRow(row) === 'enhanced';
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number} orgId
 * @param {{
 *   zoom?: number,
 *   bbox?: { minLng: number, minLat: number, maxLng: number, maxLat: number }|null,
 *   mode?: 'auto'|'refresh'
 * }} opts
 * - refresh: all catalog maps whose footprint intersects the current viewport.
 * - auto: viewport maps whose footprint intersects at least one org ticket that intersects the viewport.
 */
async function queryAerialMapsForView(db, orgId, opts) {
    const settingsRow = await getRow(db, 'SELECT settings, subscription_tier FROM organizations WHERE id = ?', [orgId]);
    const productTier = getProductTierFromOrgRow(settingsRow);

    const zoom = opts.zoom != null ? Number(opts.zoom) : NaN;

    if (!hasAerialEntitlementFromOrgRow(settingsRow)) {
        return { tier: productTier, maps: [] };
    }

    if (!Number.isFinite(zoom) || zoom !== 16) {
        return { tier: 'enhanced', maps: [], skipReason: 'requires_zoom_16' };
    }

    const bbox = opts.bbox;
    const hasValidBbox =
        bbox &&
        Number.isFinite(bbox.minLng) &&
        Number.isFinite(bbox.minLat) &&
        Number.isFinite(bbox.maxLng) &&
        Number.isFinite(bbox.maxLat);

    if (!hasValidBbox) {
        return { tier: 'enhanced', maps: [], skipReason: 'missing_bbox' };
    }

    const mode = opts.mode === 'refresh' ? 'refresh' : 'auto';
    const rows = await loadGlobalAerialMaps(db, bbox, orgId);

    if (mode === 'refresh') {
        const maps = rows
            .filter((row) => rowAabbIntersectsBbox(row, bbox))
            .map((row) => rowToMap(row))
            .filter((m) => m.boundingBox && mapIntersectsViewBbox(m.boundingBox, bbox));
        return { tier: 'enhanced', maps: sortMapsNewestFirst(maps) };
    }

    const viewportPoly = polygonFromAabb(bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat);
    if (!viewportPoly) {
        return { tier: 'enhanced', maps: [], skipReason: 'missing_bbox' };
    }
    const tickets = (await loadOrgTickets(db, orgId, bbox)).filter(
        (t) =>
            t.polygon &&
            (t.polygon.type === 'Polygon' || t.polygon.type === 'MultiPolygon') &&
            rowAabbIntersectsBbox(t, bbox) &&
            ticketPolygonIntersectsFootprint(t.polygon, viewportPoly)
    );
    if (tickets.length === 0) {
        return { tier: 'enhanced', maps: [] };
    }

    const maps = [];
    for (const row of rows) {
        if (!rowAabbIntersectsBbox(row, bbox)) continue;
        const footprint = parseBoundingBox(row);
        if (!footprint || !mapIntersectsViewBbox(footprint, bbox)) continue;
        const mapAabb = getRowAabb(row);
        if (
            tickets.some(
                (t) => aabbIntersects(getRowAabb(t), mapAabb) && ticketPolygonIntersectsFootprint(t.polygon, footprint)
            )
        ) {
            maps.push(rowToMap(row));
        }
    }

    return { tier: 'enhanced', maps: sortMapsNewestFirst(maps) };
}

function isValidAccessMode(mode) {
    return ACCESS_MODES.includes(String(mode || '').trim().toLowerCase());
}

const METERS_PER_MILE = 1609.344;
const ACCESSIBLE_BBOX_MAX_MILES = 5;
const ACCESSIBLE_CATALOG_DEFAULT_PAGE_SIZE = 20;
const ACCESSIBLE_CATALOG_MAX_PAGE_SIZE = 50;

/**
 * @param {{ minLng: number, minLat: number, maxLng: number, maxLat: number }} bbox
 * @returns {{ nsMeters: number, ewMeters: number }}
 */
function bboxDimensionsMeters(bbox) {
    const minLng = Number(bbox.minLng);
    const minLat = Number(bbox.minLat);
    const maxLng = Number(bbox.maxLng);
    const maxLat = Number(bbox.maxLat);
    const nsMeters = turf.distance([minLng, minLat], [minLng, maxLat], { units: 'meters' });
    const ewMeters = turf.distance([minLng, minLat], [maxLng, minLat], { units: 'meters' });
    return { nsMeters, ewMeters };
}

/**
 * @param {{ minLng: number, minLat: number, maxLng: number, maxLat: number }} bbox
 * @param {number} [maxMiles]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateAccessibleBboxMiles(bbox, maxMiles = ACCESSIBLE_BBOX_MAX_MILES) {
    if (
        !bbox ||
        !Number.isFinite(bbox.minLng) ||
        !Number.isFinite(bbox.minLat) ||
        !Number.isFinite(bbox.maxLng) ||
        !Number.isFinite(bbox.maxLat)
    ) {
        return { ok: false, error: 'bbox is required (minLng,minLat,maxLng,maxLat)' };
    }
    if (bbox.minLng >= bbox.maxLng || bbox.minLat >= bbox.maxLat) {
        return { ok: false, error: 'bbox must have minLng < maxLng and minLat < maxLat' };
    }
    const maxMeters = maxMiles * METERS_PER_MILE;
    const { nsMeters, ewMeters } = bboxDimensionsMeters(bbox);
    if (nsMeters > maxMeters || ewMeters > maxMeters) {
        return {
            ok: false,
            error: `Search area cannot exceed ${maxMiles} miles north–south or east–west`,
        };
    }
    return { ok: true };
}

/**
 * Data Hub accessible catalog: org-aware maps intersecting bbox, paginated (no zoom-16 gate).
 * @param {import('sqlite3').Database} db
 * @param {number} orgId
 * @param {{ minLng: number, minLat: number, maxLng: number, maxLat: number }} bbox
 * @param {{ page?: number, pageSize?: number }} [opts]
 */
async function queryAccessibleAerialMapsPaged(db, orgId, bbox, opts = {}) {
    const settingsRow = await getRow(db, 'SELECT settings, subscription_tier FROM organizations WHERE id = ?', [orgId]);
    const productTier = getProductTierFromOrgRow(settingsRow);
    if (!hasAerialEntitlementFromOrgRow(settingsRow)) {
        return {
            tier: productTier,
            maps: [],
            total: 0,
            page: 1,
            pageSize: ACCESSIBLE_CATALOG_DEFAULT_PAGE_SIZE,
            totalPages: 0,
        };
    }

    const bboxCheck = validateAccessibleBboxMiles(bbox);
    if (!bboxCheck.ok) {
        return { tier: 'enhanced', status: 400, error: bboxCheck.error };
    }

    const pageSize = Math.min(
        ACCESSIBLE_CATALOG_MAX_PAGE_SIZE,
        Math.max(1, Number(opts.pageSize) || ACCESSIBLE_CATALOG_DEFAULT_PAGE_SIZE)
    );
    let page = Math.max(1, Number(opts.page) || 1);

    const rows = await loadGlobalAerialMaps(db, bbox, orgId);
    const maps = rows
        .filter((row) => rowAabbIntersectsBbox(row, bbox))
        .map((row) => rowToMap(row))
        .filter((m) => !m.boundingBox || mapIntersectsViewBbox(m.boundingBox, bbox));
    sortMapsNewestFirst(maps);

    const total = maps.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    if (totalPages > 0 && page > totalPages) page = totalPages;
    const start = (page - 1) * pageSize;
    const pageMaps = maps.slice(start, start + pageSize);

    return {
        tier: 'enhanced',
        maps: pageMaps,
        total,
        page,
        pageSize,
        totalPages,
        bbox,
    };
}

module.exports = {
    ACCESS_MODES,
    getProductTierFromSettingsOnly: getProductTierFromSettingsOnly,
    getProductTierFromOrgRow,
    hasAerialEntitlementFromOrgRow,
    getSubscriptionTierFromSettings: getProductTierFromSettingsOnly,
    tierFromOrgRow,
    queryAerialMapsForView,
    loadGlobalAerialMaps,
    loadAllowedOrganizationsForMaps,
    rowToMap,
    parseBoundingBox,
    ticketPolygonIntersectsFootprint,
    getRowAabb,
    aabbIntersects,
    orgAerialAccessWhereSql,
    orgCanAccessAerialMap,
    orgCanAccessAerialMapRow,
    normalizeAccessMode,
    hiddenFromUsersForAccessMode,
    pruneAerialFavoritesForMapAccess,
    isValidAccessMode,
    validateAccessibleBboxMiles,
    queryAccessibleAerialMapsPaged,
    ACCESSIBLE_BBOX_MAX_MILES,
    ACCESSIBLE_CATALOG_DEFAULT_PAGE_SIZE,
};
