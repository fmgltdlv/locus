// County coverage registry: bbox coarse filter + lazy polygon PIP for precise hits.
// Used to gate Clark parcel features and select create-ticket parcel overlay providers.
(function (global) {
    'use strict';

    /** @typedef {[number, number, number, number]} BBox west,south,east,north */

    /**
     * @typedef {{
     *   id: string,
     *   label: string,
     *   provider: string,
     *   bbox: BBox,
     *   polygonUrl?: string,
     *   features: string[],
     * }} CountyCoverageEntry
     */

    /** Statewide NV envelope for USAN parcel WMS fallback (no polygon). */
    const NV_FALLBACK_BBOX = /** @type {BBox} */ ([-120.0, 35.0, -114.0, 42.0]);

    /**
     * Clark County bbox derived from frontend/data/counties/clark_nv.geojson envelope.
     * Updated if the GeoJSON asset is regenerated.
     */
    const CLARK_NV_BBOX = /** @type {BBox} */ ([-115.896925, 35.002085, -114.046838, 36.853473]);

    /** @type {CountyCoverageEntry[]} */
    const COUNTY_REGISTRY = [
        {
            id: 'clark_nv',
            label: 'Clark County, NV',
            provider: 'clark_nv_gismo',
            bbox: CLARK_NV_BBOX,
            polygonUrl: 'data/counties/clark_nv.geojson',
            features: ['parcelLookup', 'assessorOverlay', 'addressSearch'],
        },
        {
            id: 'nv_usan_fallback',
            label: 'Nevada (USAN parcels)',
            provider: 'usan_nv_wms',
            bbox: NV_FALLBACK_BBOX,
            features: ['assessorOverlayFallback'],
        },
        // Future: Northern California USAN parcels (no URL yet).
        // {
        //   id: 'noca_usan_fallback',
        //   label: 'Northern California (USAN parcels)',
        //   provider: 'usan_ca_wms',
        //   bbox: [...],
        //   features: ['assessorOverlayFallback'],
        // },
    ];

    /** @type {Record<string, number[][][]|null>} countyId → exterior rings [lng,lat][] */
    const polygonRingsById = Object.create(null);
    /** @type {Record<string, Promise<number[][][]|null>>} */
    const polygonLoadPromises = Object.create(null);

    /** @type {string[]} */
    let activeCountyIds = [];
    /** @type {Array<(ids: string[]) => void>} */
    const activeListeners = [];
    let viewportSeq = 0;
    let viewportListenersBound = false;
    /** @type {any} */
    let boundMap = null;

    function pointInBbox(lng, lat, bbox) {
        return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
    }

    function bboxIntersectsBounds(bbox, bounds) {
        if (!bounds || typeof bounds.getWest !== 'function') return false;
        const west = bounds.getWest();
        const south = bounds.getSouth();
        const east = bounds.getEast();
        const north = bounds.getNorth();
        return !(east < bbox[0] || west > bbox[2] || north < bbox[1] || south > bbox[3]);
    }

    /** Ray-cast PIP on a ring of [lng, lat] pairs. */
    function pointInRing(lng, lat, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0];
            const yi = ring[i][1];
            const xj = ring[j][0];
            const yj = ring[j][1];
            const intersect =
                yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function pointInRings(lng, lat, rings) {
        if (!rings || !rings.length) return false;
        for (let i = 0; i < rings.length; i++) {
            if (pointInRing(lng, lat, rings[i])) return true;
        }
        return false;
    }

    function extractExteriorRings(geometry) {
        if (!geometry || !geometry.type) return [];
        const rings = [];
        if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
            const exterior = geometry.coordinates[0];
            if (Array.isArray(exterior) && exterior.length) rings.push(exterior);
        } else if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
            for (let i = 0; i < geometry.coordinates.length; i++) {
                const poly = geometry.coordinates[i];
                if (Array.isArray(poly) && poly[0] && poly[0].length) rings.push(poly[0]);
            }
        }
        return rings;
    }

    function parseGeoJsonRings(data) {
        if (!data) return [];
        if (data.type === 'FeatureCollection' && Array.isArray(data.features) && data.features[0]) {
            return extractExteriorRings(data.features[0].geometry);
        }
        if (data.type === 'Feature') {
            return extractExteriorRings(data.geometry);
        }
        return extractExteriorRings(data);
    }

    /**
     * Lazy-load and cache polygon rings. Fail-closed: returns null on error.
     * @param {string} countyId
     * @returns {Promise<number[][][]|null>}
     */
    function ensurePolygon(countyId) {
        if (Object.prototype.hasOwnProperty.call(polygonRingsById, countyId)) {
            return Promise.resolve(polygonRingsById[countyId]);
        }
        if (polygonLoadPromises[countyId]) {
            return polygonLoadPromises[countyId];
        }
        const entry = COUNTY_REGISTRY.find(function (c) {
            return c.id === countyId;
        });
        if (!entry || !entry.polygonUrl) {
            polygonRingsById[countyId] = null;
            return Promise.resolve(null);
        }
        const url = entry.polygonUrl;
        polygonLoadPromises[countyId] = fetch(url, { method: 'GET', credentials: 'same-origin' })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                const rings = parseGeoJsonRings(data);
                polygonRingsById[countyId] = rings.length ? rings : null;
                return polygonRingsById[countyId];
            })
            .catch(function (err) {
                console.warn('[mapCountyCoverage] polygon load failed', countyId, err);
                polygonRingsById[countyId] = null;
                return null;
            })
            .then(function (rings) {
                delete polygonLoadPromises[countyId];
                return rings;
            });
        return polygonLoadPromises[countyId];
    }

    function entryHasFeature(entry, feature) {
        return entry && Array.isArray(entry.features) && entry.features.indexOf(feature) !== -1;
    }

    /**
     * Counties whose bbox contains the point, then (if polygon) PIP.
     * Bbox-only entries (no polygonUrl) count as hits on bbox alone.
     * @returns {Promise<CountyCoverageEntry[]>}
     */
    async function countiesForPoint(lat, lng) {
        const candidates = COUNTY_REGISTRY.filter(function (c) {
            return pointInBbox(lng, lat, c.bbox);
        });
        const out = [];
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            if (!c.polygonUrl) {
                out.push(c);
                continue;
            }
            const rings = await ensurePolygon(c.id);
            if (rings && pointInRings(lng, lat, rings)) {
                out.push(c);
            }
            // Fail-closed: no rings → not a hit for dedicated counties
        }
        return out;
    }

    /**
     * Viewport ∩ county: bbox intersect, then center/corners/ring-vertex heuristics.
     * Bbox-only entries hit on bbox intersect alone.
     * @param {any} bounds Leaflet LatLngBounds
     * @returns {Promise<CountyCoverageEntry[]>}
     */
    async function countiesForBounds(bounds) {
        if (!bounds) return [];
        const candidates = COUNTY_REGISTRY.filter(function (c) {
            return bboxIntersectsBounds(c.bbox, bounds);
        });
        const out = [];
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const center = bounds.getCenter ? bounds.getCenter() : null;
        const testPoints = [
            center,
            sw,
            ne,
            { lat: sw.lat, lng: ne.lng },
            { lat: ne.lat, lng: sw.lng },
        ].filter(Boolean);

        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            if (!c.polygonUrl) {
                out.push(c);
                continue;
            }
            const rings = await ensurePolygon(c.id);
            if (!rings) continue;
            let hit = false;
            for (let p = 0; p < testPoints.length; p++) {
                const pt = testPoints[p];
                if (pointInRings(pt.lng, pt.lat, rings)) {
                    hit = true;
                    break;
                }
            }
            if (!hit) {
                // County ring vertex inside viewport (county fills or clips view)
                const west = bounds.getWest();
                const south = bounds.getSouth();
                const east = bounds.getEast();
                const north = bounds.getNorth();
                outer: for (let r = 0; r < rings.length; r++) {
                    const ring = rings[r];
                    for (let v = 0; v < ring.length; v++) {
                        const lng = ring[v][0];
                        const lat = ring[v][1];
                        if (lng >= west && lng <= east && lat >= south && lat <= north) {
                            hit = true;
                            break outer;
                        }
                    }
                }
            }
            if (hit) out.push(c);
        }
        return out;
    }

    async function hasFeatureAtPoint(feature, lat, lng) {
        const counties = await countiesForPoint(lat, lng);
        return counties.some(function (c) {
            return entryHasFeature(c, feature);
        });
    }

    async function hasFeatureInViewport(feature, map) {
        if (!map || typeof map.getBounds !== 'function') return false;
        const counties = await countiesForBounds(map.getBounds());
        return counties.some(function (c) {
            return entryHasFeature(c, feature);
        });
    }

    /**
     * Overlay provider for create-ticket: dedicated assessorOverlay at map center,
     * else assessorOverlayFallback (USAN NV), else null.
     * Clark poly load failure → skip dedicated → allow USAN if NV bbox hits.
     * @returns {Promise<{ provider: string, countyId: string }|null>}
     */
    async function resolveParcelOverlayProvider(map) {
        if (!map || typeof map.getCenter !== 'function') return null;
        const center = map.getCenter();
        const lat = center.lat;
        const lng = center.lng;
        const atPoint = await countiesForPoint(lat, lng);
        for (let i = 0; i < atPoint.length; i++) {
            if (entryHasFeature(atPoint[i], 'assessorOverlay')) {
                return { provider: atPoint[i].provider, countyId: atPoint[i].id };
            }
        }
        // Bbox-only fallback entries: check NV fallback even if polygon path excluded them
        for (let i = 0; i < COUNTY_REGISTRY.length; i++) {
            const c = COUNTY_REGISTRY[i];
            if (!entryHasFeature(c, 'assessorOverlayFallback')) continue;
            if (pointInBbox(lng, lat, c.bbox)) {
                return { provider: c.provider, countyId: c.id };
            }
        }
        return null;
    }

    function getActiveCountyIds() {
        return activeCountyIds.slice();
    }

    function onActiveCountiesChanged(cb) {
        if (typeof cb !== 'function') return function () {};
        activeListeners.push(cb);
        return function () {
            const idx = activeListeners.indexOf(cb);
            if (idx >= 0) activeListeners.splice(idx, 1);
        };
    }

    function emitActiveChanged() {
        const ids = getActiveCountyIds();
        for (let i = 0; i < activeListeners.length; i++) {
            try {
                activeListeners[i](ids);
            } catch (e) {
                console.warn('[mapCountyCoverage] listener error', e);
            }
        }
    }

    function idsEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    async function refreshActiveCounties(map) {
        if (!map || typeof map.getBounds !== 'function') return;
        const seq = ++viewportSeq;
        const counties = await countiesForBounds(map.getBounds());
        if (seq !== viewportSeq) return;
        const next = counties.map(function (c) {
            return c.id;
        });
        if (idsEqual(activeCountyIds, next)) return;
        activeCountyIds = next;
        emitActiveChanged();
    }

    function onViewportChanged() {
        const map = global.map || boundMap;
        if (!map) return;
        refreshActiveCounties(map);
    }

    function bindViewportTracking(map) {
        if (!map) return;
        if (viewportListenersBound && boundMap === map) return;
        if (viewportListenersBound && boundMap && boundMap !== map) {
            boundMap.off('moveend zoomend', onViewportChanged);
            viewportListenersBound = false;
            boundMap = null;
        }
        map.on('moveend zoomend', onViewportChanged);
        viewportListenersBound = true;
        boundMap = map;
        refreshActiveCounties(map);
    }

    /**
     * County containing map center that supports addressSearch, or null.
     * Prefer center PIP; if none, null (caller uses non-Clark geocode).
     */
    async function resolveSearchCounty(map) {
        if (!map || typeof map.getCenter !== 'function') return null;
        const center = map.getCenter();
        const counties = await countiesForPoint(center.lat, center.lng);
        for (let i = 0; i < counties.length; i++) {
            if (entryHasFeature(counties[i], 'addressSearch')) {
                return counties[i];
            }
        }
        return null;
    }

    global.mapCountyCoverageModule = {
        COUNTY_REGISTRY: COUNTY_REGISTRY,
        ensurePolygon: ensurePolygon,
        countiesForPoint: countiesForPoint,
        countiesForBounds: countiesForBounds,
        hasFeatureAtPoint: hasFeatureAtPoint,
        hasFeatureInViewport: hasFeatureInViewport,
        resolveParcelOverlayProvider: resolveParcelOverlayProvider,
        resolveSearchCounty: resolveSearchCounty,
        getActiveCountyIds: getActiveCountyIds,
        onActiveCountiesChanged: onActiveCountiesChanged,
        bindViewportTracking: bindViewportTracking,
        refreshActiveCounties: refreshActiveCounties,
    };
})(typeof window !== 'undefined' ? window : globalThis);
