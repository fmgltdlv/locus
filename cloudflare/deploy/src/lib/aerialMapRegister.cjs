/**
 * Register a global aerial catalog row from a TMS tilemapresource.xml URL.
 */

const { getRow, runDb } = require('./db.cjs');
const { computePolygonAabb } = require('./ticketIndexedColumns.cjs');
const { isTilesetResourceUrl, parseTilemapResourceFromXml } = require('./tmsTilemapParse.cjs');

/**
 * Parse capture time from GCS / HTTP object headers (tilemapresource.xml upload time).
 * @param {Headers|{ get?: (name: string) => string|null }} headers
 * @returns {string|null} ISO timestamp
 */
function capturedAtFromObjectHeaders(headers) {
    if (!headers || typeof headers.get !== 'function') return null;
    const raw = headers.get('last-modified') || headers.get('Last-Modified');
    if (!raw || !String(raw).trim()) return null;
    const t = Date.parse(String(raw).trim());
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * @param {string|null|undefined} explicitCapturedAt
 * @param {Headers|{ get?: (name: string) => string|null }|null|undefined} objectHeaders
 * @returns {string}
 */
function resolveCapturedAt(explicitCapturedAt, objectHeaders) {
    if (explicitCapturedAt != null && String(explicitCapturedAt).trim() !== '') {
        return String(explicitCapturedAt).trim();
    }
    const fromHeaders = capturedAtFromObjectHeaders(objectHeaders);
    if (fromHeaders) return fromHeaders;
    return new Date().toISOString();
}

/**
 * @param {string} url
 * @returns {string|null}
 */
function folderNameFromTilesetUrl(url) {
    const m = String(url || '').match(/outputs\/([^/]+)/);
    return m ? m[1] : null;
}

/**
 * @param {unknown} db
 * @param {number} userId
 * @param {string} url
 * @param {{ capturedAt?: string|null, hiddenFromUsers?: number, objectHeaders?: { get?: (name: string) => string|null } }} [options]
 * @returns {Promise<
 *   | { skipped: true, reason: 'exists'|'no_tileset', id: number|null }
 *   | { skipped: false, id: number, name: string, url: string, boundingBox: object, minNativeZoom: number, maxNativeZoom: number, capturedAt: string, hiddenFromUsers: number }
 * >}
 */
async function registerAerialMapFromUrl(db, userId, url, options = {}) {
    const trimmedUrl = String(url || '').trim();
    if (!trimmedUrl) {
        throw new Error('URL is required');
    }
    const folderName = folderNameFromTilesetUrl(trimmedUrl);
    if (!folderName) {
        throw new Error('Invalid GCP bucket URL format. Expected format: .../outputs/FOLDER_NAME/...');
    }
    if (!isTilesetResourceUrl(trimmedUrl)) {
        throw new Error(
            'Unsupported aerial URL. Add a TMS tileset: URL must include tilemapresource.xml (or orthophoto_tiles … .xml).'
        );
    }

    const existing = await getRow(db, 'SELECT id FROM aerial_maps WHERE url = ?', [trimmedUrl]);
    if (existing && existing.id != null) {
        return { skipped: true, reason: 'exists', id: Number(existing.id) };
    }

    const response = await fetch(trimmedUrl);
    if (!response.ok) {
        if (response.status === 404) {
            return { skipped: true, reason: 'no_tileset', id: null };
        }
        throw new Error(`Failed to fetch tileset XML: ${response.status} ${response.statusText}`);
    }
    const parsed = parseTilemapResourceFromXml(await response.text());
    const boundingBox = parsed.boundingBox;
    const nativeZoom = { minNativeZoom: parsed.minNativeZoom, maxNativeZoom: parsed.maxNativeZoom };
    const capAt = resolveCapturedAt(
        options.capturedAt,
        options.objectHeaders || response.headers
    );
    const aabb = boundingBox ? computePolygonAabb(boundingBox) : null;
    const hiddenFromUsers = options.hiddenFromUsers === 1 ? 1 : 0;
    const accessMode = hiddenFromUsers === 1 ? 'hidden' : 'global';

    let result;
    try {
        result = await runDb(
            db,
            `
        INSERT INTO aerial_maps
        (organization_id, user_id, name, url, min_lng, min_lat, max_lng, max_lat,
         min_native_zoom, max_native_zoom, captured_at, hidden_from_users, access_mode, created_at)
        VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `,
            [
                userId,
                folderName,
                trimmedUrl,
                aabb ? aabb.min_lng : null,
                aabb ? aabb.min_lat : null,
                aabb ? aabb.max_lng : null,
                aabb ? aabb.max_lat : null,
                nativeZoom.minNativeZoom,
                nativeZoom.maxNativeZoom,
                capAt,
                hiddenFromUsers,
                accessMode,
            ]
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/hidden_from_users|access_mode|no such column/i.test(msg)) {
            throw new Error(
                'Database schema is missing aerial_maps access columns. Apply D1 migrations 0039_aerial_maps_hidden_from_users.sql and 0065_aerial_map_org_access.sql on this environment.'
            );
        }
        throw e;
    }

    const mapId = Number(result.lastID);

    return {
        skipped: false,
        id: mapId,
        name: folderName,
        url: trimmedUrl,
        boundingBox,
        minNativeZoom: nativeZoom.minNativeZoom,
        maxNativeZoom: nativeZoom.maxNativeZoom,
        capturedAt: capAt,
        hiddenFromUsers,
    };
}

module.exports = {
    folderNameFromTilesetUrl,
    capturedAtFromObjectHeaders,
    resolveCapturedAt,
    registerAerialMapFromUrl,
};
