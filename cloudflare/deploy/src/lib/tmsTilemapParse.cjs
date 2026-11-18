/**
 * Parse GDAL/NodeODM tilemapresource.xml (server-side only: catalog add + one-off backfill).
 */

const AERIAL_TMS_FALLBACK_MIN_ZOOM = 5;
const AERIAL_TMS_FALLBACK_MAX_ZOOM = 22;

function isTilesetResourceUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return (
        url.includes('tilemapresource.xml') ||
        (url.includes('orthophoto_tiles') && (url.endsWith('.xml') || url.includes('/tilemapresource')))
    );
}

function parseTmsNativeZoomLevelsFromXml(xmlText) {
    const levels = [];
    if (!xmlText || typeof xmlText !== 'string') {
        return levels;
    }
    const tileSetRe = /<TileSet\b([^>]*)\/?>/gi;
    let m;
    while ((m = tileSetRe.exec(xmlText)) !== null) {
        const attrs = m[1];
        let z = NaN;
        const hrefM = attrs.match(/\bhref="([^"]+)"/i);
        if (hrefM) {
            const href = hrefM[1].trim().replace(/\/+$/, '');
            const base = href.split('/').pop() || href;
            if (/^\d+$/.test(base)) {
                z = parseInt(base, 10);
            }
        }
        if (isNaN(z)) {
            const orderM = attrs.match(/\border="(\d+)"/i);
            if (orderM) {
                z = parseInt(orderM[1], 10);
            }
        }
        if (!isNaN(z)) {
            levels.push(z);
        }
    }
    return levels;
}

function parseTmsZoomBoundsFromTileMapElement(xmlText) {
    const maxM = xmlText.match(/<TileMap\b[^>]*\bmaxzoom="(\d+)"/i);
    if (!maxM) {
        return null;
    }
    const maxZ = parseInt(maxM[1], 10);
    if (isNaN(maxZ)) {
        return null;
    }
    const minM = xmlText.match(/<TileMap\b[^>]*\bminzoom="(\d+)"/i);
    const minZ = minM ? parseInt(minM[1], 10) : maxZ;
    if (isNaN(minZ)) {
        return { minNativeZoom: maxZ, maxNativeZoom: maxZ };
    }
    return {
        minNativeZoom: Math.min(minZ, maxZ),
        maxNativeZoom: Math.max(minZ, maxZ),
    };
}

/**
 * @param {string} xmlText
 * @returns {{ minNativeZoom: number, maxNativeZoom: number }}
 */
function resolveTmsNativeZoomFromTilemapXml(xmlText) {
    const zoomLevels = parseTmsNativeZoomLevelsFromXml(xmlText);
    if (zoomLevels.length > 0) {
        return {
            minNativeZoom: Math.min(...zoomLevels),
            maxNativeZoom: Math.max(...zoomLevels),
        };
    }
    const fromTileMap = parseTmsZoomBoundsFromTileMapElement(xmlText);
    if (fromTileMap) {
        return fromTileMap;
    }
    return {
        minNativeZoom: AERIAL_TMS_FALLBACK_MIN_ZOOM,
        maxNativeZoom: AERIAL_TMS_FALLBACK_MAX_ZOOM,
    };
}

/**
 * @param {string} xmlText
 * @returns {{ type: 'Polygon', coordinates: number[][][] }|null}
 */
function parseBoundingBoxFromTilemapXml(xmlText) {
    if (!xmlText || typeof xmlText !== 'string') return null;
    const bboxMatch = xmlText.match(
        /<BoundingBox\s+minx="([^"]+)"\s+miny="([^"]+)"\s+maxx="([^"]+)"\s+maxy="([^"]+)"/
    );
    if (!bboxMatch) return null;
    const minX = parseFloat(bboxMatch[1]);
    const minY = parseFloat(bboxMatch[2]);
    const maxX = parseFloat(bboxMatch[3]);
    const maxY = parseFloat(bboxMatch[4]);
    if (![minX, minY, maxX, maxY].every((n) => Number.isFinite(n))) return null;
    return {
        type: 'Polygon',
        coordinates: [
            [
                [minX, minY],
                [maxX, minY],
                [maxX, maxY],
                [minX, maxY],
                [minX, minY],
            ],
        ],
    };
}

/**
 * @param {string} xmlText
 * @returns {{ boundingBox: object, minNativeZoom: number, maxNativeZoom: number }}
 */
function parseTilemapResourceFromXml(xmlText) {
    const boundingBox = parseBoundingBoxFromTilemapXml(xmlText);
    if (!boundingBox) {
        throw new Error('Could not find BoundingBox in tileset XML. XML structure may be different.');
    }
    const zoom = resolveTmsNativeZoomFromTilemapXml(xmlText);
    return {
        boundingBox,
        minNativeZoom: zoom.minNativeZoom,
        maxNativeZoom: zoom.maxNativeZoom,
    };
}

module.exports = {
    isTilesetResourceUrl,
    parseTilemapResourceFromXml,
    resolveTmsNativeZoomFromTilemapXml,
};
