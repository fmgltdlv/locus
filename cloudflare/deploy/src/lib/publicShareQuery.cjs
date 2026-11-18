const { getRow, allRows } = require('./db.cjs');

function displayLabelForShare(sourceOrgName, sourceIdentityMode) {
    if (sourceIdentityMode === 'anonymous') return 'Partner organization';
    return sourceOrgName || 'Partner organization';
}

function parseBbox(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const parts = raw.split(',').map((s) => Number(String(s).trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (minLng >= maxLng || minLat >= maxLat) return null;
    return { minLng, minLat, maxLng, maxLat };
}

async function getPublicCatalogOrgId(db) {
    const row = await getRow(db, 'SELECT id FROM organizations WHERE is_public_catalog = 1 LIMIT 1');
    return row && row.id != null ? Number(row.id) : null;
}

async function isPublicCatalogOrgId(db, orgId) {
    const pubId = await getPublicCatalogOrgId(db);
    return pubId != null && Number(orgId) === pubId;
}

/**
 * User may view the public catalog when they belong to any org with share_to_public enabled.
 */
async function userCanAccessPublicCatalog(db, userId) {
    const row = await getRow(
        db,
        `SELECT 1 AS ok FROM user_organizations uo
         INNER JOIN organizations o ON o.id = uo.organization_id
         WHERE uo.user_id = ? AND o.share_to_public = 1
         LIMIT 1`,
        [userId]
    );
    return !!row;
}

const BBOX_OVERLAP_SQL = `
  min_lng IS NOT NULL AND min_lat IS NOT NULL AND max_lng IS NOT NULL AND max_lat IS NOT NULL
  AND min_lng <= ? AND max_lng >= ? AND min_lat <= ? AND max_lat >= ?
`;

/** Same predicate as ticketActiveListSqlPredicate in ticketRowHelpers.ts */
function ticketActiveListSqlPredicate(expiresCol) {
    const c = expiresCol;
    const jd = `julianday(TRIM(${c}))`;
    return `(
        (${c} IS NULL OR TRIM(COALESCE(${c}, '')) = '')
        OR (${jd} IS NULL)
        OR (${jd} > julianday('now'))
        )`;
}

function parsePublicTimeRange(fromRaw, toRaw) {
    let fromMs = null;
    let toMs = null;
    if (fromRaw != null && String(fromRaw).trim() !== '') {
        const t = new Date(String(fromRaw)).getTime();
        if (Number.isFinite(t)) fromMs = t;
    }
    if (toRaw != null && String(toRaw).trim() !== '') {
        const t = new Date(String(toRaw)).getTime();
        if (Number.isFinite(t)) toMs = t;
    }
    return { fromMs, toMs };
}

function appendTimeRangeSql(column, fromMs, toMs, params) {
    let sql = '';
    if (fromMs != null && Number.isFinite(fromMs)) {
        sql += ` AND datetime(${column}) >= datetime(?)`;
        params.push(new Date(fromMs).toISOString());
    }
    if (toMs != null && Number.isFinite(toMs)) {
        sql += ` AND datetime(${column}) <= datetime(?)`;
        params.push(new Date(toMs).toISOString());
    }
    return sql;
}

async function getPublicTicketsInBbox(db, bbox, limit = 500, timeRange = {}) {
    const { minLng, minLat, maxLng, maxLat } = bbox;
    const lim = Math.min(Math.max(1, limit), 500);
    const params = [maxLng, minLng, maxLat, minLat];
    const timeSql = appendTimeRangeSql('t.created_at', timeRange.fromMs, timeRange.toMs, params);
    params.push(lim);
    const activeSql = ticketActiveListSqlPredicate('t.ticket_expires_at');
    const rows = await allRows(
        db,
        `SELECT t.*, o.name AS source_org_name, o.public_identity_mode, o.id AS source_org_id
         FROM tickets t
         INNER JOIN organizations o ON o.id = t.organization_id
         WHERE o.share_to_public = 1
           AND COALESCE(o.is_public_catalog, 0) = 0
           AND ${BBOX_OVERLAP_SQL.replace(/\n\s*/g, ' ')}
           AND ${activeSql}
           ${timeSql}
         ORDER BY datetime(t.created_at) DESC, t.id DESC
         LIMIT ?`,
        params
    );
    return rows.map((row) => ({
        row,
        sourceOrgId: row.source_org_id,
        displayLabel: displayLabelForShare(row.source_org_name, row.public_identity_mode),
    }));
}

async function getPublicMediaInBbox(db, bbox, fileType = null, limit = 500, timeRange = {}) {
    const { minLng, minLat, maxLng, maxLat } = bbox;
    const lim = Math.min(Math.max(1, limit), 500);
    let sql = `
        SELECT m.*, o.name AS source_org_name, o.public_identity_mode, o.id AS source_org_id,
               COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, u.email) AS uploaded_by
        FROM media_files m
        INNER JOIN organizations o ON o.id = m.organization_id
        LEFT JOIN users u ON u.id = m.user_id
        WHERE o.share_to_public = 1
          AND COALESCE(o.is_public_catalog, 0) = 0
          AND m.is_public = 1
          AND m.has_gps = 1
          AND m.latitude >= ? AND m.latitude <= ?
          AND m.longitude >= ? AND m.longitude <= ?
          AND NOT (LOWER(REPLACE(m.file_path, '\\', '/')) GLOB '*_thumb.jpg')
    `;
    const params = [minLat, maxLat, minLng, maxLng];
    sql += appendTimeRangeSql('m.created_at', timeRange.fromMs, timeRange.toMs, params);
    if (fileType) {
        sql += ' AND m.file_type = ?';
        params.push(fileType);
    }
    sql += ' ORDER BY m.created_at DESC LIMIT ?';
    params.push(lim);
    const rows = await allRows(db, sql, params);
    return rows.map((row) => ({
        row,
        sourceOrgId: row.source_org_id,
        displayLabel: displayLabelForShare(row.source_org_name, row.public_identity_mode),
    }));
}

async function getPublicLayersInBbox(db, bbox, limit = 100, timeRange = {}) {
    const { minLng, minLat, maxLng, maxLat } = bbox;
    const lim = Math.min(Math.max(1, limit), 100);
    const layerParams = [];
    const layerTimeSql = appendTimeRangeSql('l.created_at', timeRange.fromMs, timeRange.toMs, layerParams);
    layerParams.push(lim);
    const layerRows = await allRows(
        db,
        `SELECT l.*, o.name AS source_org_name, o.public_identity_mode, o.id AS source_org_id
         FROM map_workspace_data_layers l
         INNER JOIN organizations o ON o.id = l.organization_id
         WHERE o.share_to_public = 1
           AND COALESCE(o.is_public_catalog, 0) = 0
           AND l.is_public = 1
           ${layerTimeSql}
         ORDER BY l.id
         LIMIT ?`,
        layerParams
    );
    if (!layerRows.length) return [];
    const out = [];
    for (const layer of layerRows) {
        const orgId = layer.organization_id;
        const layerId = layer.layer_id;
        const features = await allRows(
            db,
            `SELECT * FROM map_workspace_layer_annotations
             WHERE organization_id = ? AND layer_id = ?
               AND ${BBOX_OVERLAP_SQL.replace(/\n\s*/g, ' ')}`,
            [orgId, layerId, maxLng, minLng, maxLat, minLat]
        );
        if (!features.length) continue;
        out.push({
            layer,
            features,
            sourceOrgId: layer.source_org_id,
            displayLabel: displayLabelForShare(layer.source_org_name, layer.public_identity_mode),
        });
    }
    return out;
}

function publicAerialRowToClient(row) {
    const minLng = row.min_lng != null ? Number(row.min_lng) : null;
    const minLat = row.min_lat != null ? Number(row.min_lat) : null;
    const maxLng = row.max_lng != null ? Number(row.max_lng) : null;
    const maxLat = row.max_lat != null ? Number(row.max_lat) : null;
    let boundingBox = null;
    if ([minLng, minLat, maxLng, maxLat].every((n) => Number.isFinite(n))) {
        boundingBox = {
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
    return {
        id: row.id,
        name: row.name || '',
        url: row.url,
        boundingBox,
        minNativeZoom: row.min_native_zoom != null ? Number(row.min_native_zoom) : null,
        maxNativeZoom: row.max_native_zoom != null ? Number(row.max_native_zoom) : null,
        capturedAt: row.captured_at || undefined,
        createdAt: row.created_at || undefined,
        organizationId: row.organization_id,
    };
}

async function getPublicAerialMapsInBbox(db, bbox, limit = 100, timeRange = {}) {
    const { minLng, minLat, maxLng, maxLat } = bbox;
    const lim = Math.min(Math.max(1, limit), 100);
    const { orgAerialAccessWhereSql } = require('./aerialMapQuery.cjs');
    const access = orgAerialAccessWhereSql('a', null, { globalOnly: true });
    const params = [...access.params, maxLng, minLng, maxLat, minLat];
    const timeSql = appendTimeRangeSql(
        'COALESCE(a.captured_at, a.created_at)',
        timeRange.fromMs,
        timeRange.toMs,
        params
    );
    params.push(lim);
    const rows = await allRows(
        db,
        `SELECT a.*
         FROM aerial_maps a
         WHERE a.organization_id IS NULL
           ${access.sql}
           AND (
             (a.min_lng IS NOT NULL AND a.min_lng <= ? AND a.max_lng >= ? AND a.min_lat <= ? AND a.max_lat >= ?)
             OR a.min_lng IS NULL
           )
           ${timeSql}
         ORDER BY datetime(COALESCE(a.captured_at, a.created_at)) DESC, a.id DESC
         LIMIT ?`,
        params
    );
    return rows.map((row) => ({ row }));
}

async function canViewerReadPublicMedia(db, userId, mediaRow) {
    if (!mediaRow || Number(mediaRow.is_public) !== 1) return false;
    if (!(await userCanAccessPublicCatalog(db, userId))) return false;
    const ownerOrg = await getRow(db, 'SELECT share_to_public FROM organizations WHERE id = ?', [
        mediaRow.organization_id,
    ]);
    return !!(ownerOrg && Number(ownerOrg.share_to_public) === 1);
}

module.exports = {
    displayLabelForShare,
    parseBbox,
    parsePublicTimeRange,
    getPublicCatalogOrgId,
    isPublicCatalogOrgId,
    userCanAccessPublicCatalog,
    getPublicTicketsInBbox,
    getPublicMediaInBbox,
    getPublicLayersInBbox,
    getPublicAerialMapsInBbox,
    publicAerialRowToClient,
    canViewerReadPublicMedia,
};
