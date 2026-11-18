/**
 * Fetch ngen public map HTML and extract dig-site polygon (WKT POLYGON in spatialObjectDescription).
 */
const ticketBuilder = require('./ticketBuilder.cjs');

const MAP_URL_BASE = 'https://onecallnv.undergroundservicealert.org/ngen.web/map/index?RequestNumber=';

const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

/**
 * NV public map polygons are always fetched with the base request number and -000 revision.
 * @param {string} ticketNumber
 * @returns {string|null}
 */
function resolveNgenMapRequestNumber(ticketNumber) {
    const stored = String(ticketNumber || '').trim();
    if (!stored) return null;
    const parts = ticketBuilder.parseTicketNumberParts(stored);
    const base = parts.baseNumber || stored.split('-')[0];
    if (!base) return null;
    return `${base}-000`;
}

/**
 * @param {string} fullRequestNumber e.g. 2026030500318-000
 * @param {typeof import('node-fetch')['default']} [fetchImpl]
 * @returns {Promise<object|null>} GeoJSON Polygon or null
 */
async function fetchNgenMapPolygonGeoJSON(fullRequestNumber, fetchImpl) {
    const parsed = await fetchNgenMapPageParsed(fullRequestNumber, fetchImpl);
    if (!parsed || !parsed.polygon) return null;
    return parsed.polygon;
}

/**
 * Fetch public map HTML and parse polygon + optional history table.
 * @returns {Promise<{ ok: boolean, polygon: object|null, mapData: { coords: number[][]|null, history: object[] }, error?: string }>}
 */
async function fetchNgenMapPageParsed(fullRequestNumber, fetchImpl) {
    const fetchFn = fetchImpl || globalThis.fetch.bind(globalThis);
    const q = String(fullRequestNumber || '').trim();
    if (!q) {
        return { ok: false, polygon: null, mapData: { coords: null, history: [] }, error: 'empty request number' };
    }
    const url = `${MAP_URL_BASE}${encodeURIComponent(q)}`;
    try {
        const res = await fetchFn(url, { headers: DEFAULT_HEADERS });
        if (!res.ok) {
            return {
                ok: false,
                polygon: null,
                mapData: { coords: null, history: [] },
                error: `map fetch failed: ${res.status}`,
            };
        }
        const html = await res.text();
        const mapData = ticketBuilder.parseMapPageHtml(html);
        const coords = mapData && mapData.coords;
        const polygon =
            coords && coords.length >= 3 ? ticketBuilder.mapCoordsToGeoJSON(coords) : null;
        return {
            ok: true,
            polygon: polygon && polygon.type === 'Polygon' ? polygon : null,
            mapData: mapData || { coords: null, history: [] },
        };
    } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        return { ok: false, polygon: null, mapData: { coords: null, history: [] }, error: msg };
    }
}

/**
 * @param {{ ticket_number?: string|null }} row
 * @param {typeof import('node-fetch')['default']} [fetchImpl]
 * @returns {Promise<{ polygon: object|null, requestNumber: string|null }>}
 */
async function fetchNgenMapPolygonForTicketRow(row, fetchImpl) {
    const ticketNumber = row && row.ticket_number != null ? String(row.ticket_number).trim() : '';
    const requestNumber = resolveNgenMapRequestNumber(ticketNumber);
    if (!requestNumber) return { polygon: null, requestNumber: null };
    const polygon = await fetchNgenMapPolygonGeoJSON(requestNumber, fetchImpl);
    return {
        polygon: polygon && polygon.type === 'Polygon' ? polygon : null,
        requestNumber,
    };
}

module.exports = {
    MAP_URL_BASE,
    resolveNgenMapRequestNumber,
    fetchNgenMapPolygonGeoJSON,
    fetchNgenMapPageParsed,
    fetchNgenMapPolygonForTicketRow,
};
