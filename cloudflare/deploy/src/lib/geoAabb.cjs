/**
 * Axis-aligned bounding box + GeoJSON type from arbitrary GeoJSON geometry (for SQL indexing).
 */

/**
 * @param {unknown} geometry GeoJSON Geometry object
 * @returns {{ min_lng: number, min_lat: number, max_lng: number, max_lat: number, geom_type: string } | null}
 */
function computeGeomAabbAndType(geometry) {
    if (!geometry || typeof geometry !== 'object' || !geometry.type) return null;
    const geomType = String(geometry.type);
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;

    function visitCoordPair(lng, lat) {
        const lo = Number(lng);
        const la = Number(lat);
        if (!Number.isFinite(lo) || !Number.isFinite(la)) return;
        minLng = Math.min(minLng, lo);
        maxLng = Math.max(maxLng, lo);
        minLat = Math.min(minLat, la);
        maxLat = Math.max(maxLat, la);
    }

    function walkCoords(node) {
        if (node == null) return;
        if (typeof node[0] === 'number' && typeof node[1] === 'number') {
            visitCoordPair(node[0], node[1]);
            return;
        }
        if (Array.isArray(node)) {
            for (const c of node) walkCoords(c);
        }
    }

    if (geometry.coordinates != null) {
        walkCoords(geometry.coordinates);
    }

    if (!Number.isFinite(minLng) || minLng === Infinity) return null;
    return {
        min_lng: minLng,
        min_lat: minLat,
        max_lng: maxLng,
        max_lat: maxLat,
        geom_type: geomType,
    };
}

/**
 * Parse JSON string or object to GeoJSON geometry.
 * @returns {object|null}
 */
function parseGeometryJson(raw) {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(String(raw));
    } catch {
        return null;
    }
}

module.exports = {
    computeGeomAabbAndType,
    parseGeometryJson,
};
