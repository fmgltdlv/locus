/**
 * USAN dig-site size limits for create-ticket map drawing.
 * Area (polygon / line corridor), circle radius, and line length caps.
 */
(function (global) {
    'use strict';

    const MAX_AREA_SQ_FT = 10_000_000;
    const MAX_CIRCLE_RADIUS_FT = 200;
    const HALF_MILE_FT = 2640;
    const TWO_MILE_FT = 10_560;
    const CORRIDOR_OFFSET_FT = 250;
    const SAMPLE_INTERVAL_FT = 1320;
    const FEET_PER_METER = 3.280839895;
    const METERS_PER_FOOT = 1 / FEET_PER_METER;

    /** @type {{ freeways: object[], railroads: object[] } | null} */
    let transportCache = null;
    /** @type {Promise<{ freeways: object[], railroads: object[] }> | null} */
    let transportLoadPromise = null;
    /** @type {Map<string, Promise<object>>} */
    const ruralClassCache = new Map();

    function formatNumberWithCommas(n, decimals) {
        if (!Number.isFinite(n)) return '0';
        const fixed = decimals != null ? n.toFixed(decimals) : String(Math.round(n));
        const parts = fixed.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return parts.join('.');
    }

    function formatLengthFeet(feet) {
        if (!Number.isFinite(feet) || feet <= 0) return '0 ft';
        if (feet >= FEET_PER_METER * 1609.344) {
            return formatNumberWithCommas(feet / (FEET_PER_METER * 1609.344), 2) + ' mi';
        }
        return formatNumberWithCommas(feet, 0) + ' ft';
    }

    function formatAreaSqFt(sqFt) {
        if (!Number.isFinite(sqFt) || sqFt <= 0) return '0 sq ft';
        return formatNumberWithCommas(sqFt, 0) + ' sq ft';
    }

    function maxCircleRadiusMeters() {
        return MAX_CIRCLE_RADIUS_FT * METERS_PER_FOOT;
    }

    function clampCircleRadiusMeters(radiusMeters) {
        const maxR = maxCircleRadiusMeters();
        if (!Number.isFinite(radiusMeters) || radiusMeters < 0) return 0;
        return Math.min(radiusMeters, maxR);
    }

    function ringFromGeoJsonPolygon(geo) {
        if (!geo || geo.type !== 'Polygon' || !Array.isArray(geo.coordinates) || !geo.coordinates[0]) {
            return null;
        }
        const ring = geo.coordinates[0];
        const latlngs = [];
        for (let i = 0; i < ring.length; i++) {
            const pt = ring[i];
            if (!Array.isArray(pt) || pt.length < 2) continue;
            latlngs.push(L.latLng(pt[1], pt[0]));
        }
        if (latlngs.length >= 2) {
            const a = latlngs[0];
            const b = latlngs[latlngs.length - 1];
            if (a.lat === b.lat && a.lng === b.lng) latlngs.pop();
        }
        return latlngs.length >= 3 ? latlngs : null;
    }

    function polygonAreaSqMeters(map, latlngs) {
        if (!map || !latlngs || latlngs.length < 3) return 0;
        const ref = latlngs[0];
        const xy = latlngs.map(function (p) {
            const x =
                map.distance(L.latLng(ref.lat, ref.lng), L.latLng(ref.lat, p.lng)) *
                (p.lng >= ref.lng ? 1 : -1);
            const y =
                map.distance(L.latLng(ref.lat, ref.lng), L.latLng(p.lat, ref.lng)) *
                (p.lat >= ref.lat ? 1 : -1);
            return { x: x, y: y };
        });
        let sum = 0;
        const n = xy.length;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            sum += xy[i].x * xy[j].y - xy[j].x * xy[i].y;
        }
        return Math.abs(sum / 2);
    }

    function polygonAreaSqFeet(map, latlngs) {
        return polygonAreaSqMeters(map, latlngs) * FEET_PER_METER * FEET_PER_METER;
    }

    function geoJsonPolygonAreaSqFeet(map, geo) {
        const latlngs = ringFromGeoJsonPolygon(geo);
        if (!latlngs) return 0;
        return polygonAreaSqFeet(map, latlngs);
    }

    function exceedsMaxAreaSqFeet(map, geo) {
        const sqFt = geoJsonPolygonAreaSqFeet(map, geo);
        return sqFt > MAX_AREA_SQ_FT;
    }

    function polylineLengthMeters(map, latlngs) {
        if (!map || !Array.isArray(latlngs) || latlngs.length < 2) return 0;
        let total = 0;
        for (let i = 1; i < latlngs.length; i++) {
            total += map.distance(latlngs[i - 1], latlngs[i]);
        }
        return total;
    }

    function polylineLengthFeet(map, latlngs) {
        return polylineLengthMeters(map, latlngs) * FEET_PER_METER;
    }

    function samplePointsAlongPolyline(map, latlngs) {
        const out = [];
        if (!map || !Array.isArray(latlngs) || !latlngs.length) return out;
        latlngs.forEach(function (p) {
            out.push(p);
        });
        if (latlngs.length < 2) return out;
        const intervalM = SAMPLE_INTERVAL_FT * METERS_PER_FOOT;
        for (let i = 0; i < latlngs.length - 1; i++) {
            const a = latlngs[i];
            const b = latlngs[i + 1];
            const segLen = map.distance(a, b);
            if (segLen <= intervalM) continue;
            let distAlong = intervalM;
            while (distAlong < segLen) {
                const t = distAlong / segLen;
                out.push(
                    L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t)
                );
                distAlong += intervalM;
            }
        }
        return out;
    }

    function loadTransportData() {
        if (transportCache) return Promise.resolve(transportCache);
        if (transportLoadPromise) return transportLoadPromise;
        transportLoadPromise = Promise.all([
            fetch('data/transport/nv-freeways.json', { credentials: 'same-origin' }).then(function (r) {
                if (!r.ok) throw new Error('freeways data missing');
                return r.json();
            }),
            fetch('data/transport/nv-railroads.json', { credentials: 'same-origin' }).then(function (r) {
                if (!r.ok) throw new Error('railroads data missing');
                return r.json();
            }),
        ])
            .then(function (pair) {
                transportCache = {
                    freeways: pair[0] && Array.isArray(pair[0].segments) ? pair[0].segments : [],
                    railroads: pair[1] && Array.isArray(pair[1].segments) ? pair[1].segments : [],
                };
                return transportCache;
            })
            .catch(function (err) {
                console.warn('[digSiteLimits] transport load failed', err);
                transportCache = { freeways: [], railroads: [] };
                return transportCache;
            });
        return transportLoadPromise;
    }

    function toLocalXY(latlng, origin) {
        const lat0 = (origin.lat * Math.PI) / 180;
        const cosLat = Math.cos(lat0);
        return {
            x:
                (latlng.lng - origin.lng) *
                111320 *
                (Math.abs(cosLat) > 1e-6 ? cosLat : 1e-6),
            y: (latlng.lat - origin.lat) * 111320,
        };
    }

    function fromLocalXY(xy, origin) {
        const lat0 = (origin.lat * Math.PI) / 180;
        const cosLat = Math.cos(lat0);
        return L.latLng(
            origin.lat + xy.y / 111320,
            origin.lng + xy.x / (111320 * (Math.abs(cosLat) > 1e-6 ? cosLat : 1e-6))
        );
    }

    function closestPointOnSegmentLatLng(point, a, b) {
        const P = toLocalXY(point, a);
        const B = toLocalXY(b, a);
        const len2 = B.x * B.x + B.y * B.y;
        if (len2 < 1e-12) return a;
        let t = (P.x * B.x + P.y * B.y) / len2;
        t = Math.max(0, Math.min(1, t));
        return fromLocalXY({ x: B.x * t, y: B.y * t }, a);
    }

    function minDistanceToSegmentsMeters(map, point, segments) {
        if (!segments || !segments.length) return Infinity;
        let min = Infinity;
        const lng = point.lng;
        const lat = point.lat;
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const bbox = seg && seg.bbox;
            if (bbox && bbox.length === 4) {
                if (lng < bbox[0] - 0.02 || lng > bbox[2] + 0.02 || lat < bbox[1] - 0.02 || lat > bbox[3] + 0.02) {
                    continue;
                }
            }
            const coords = seg && seg.coords;
            if (!Array.isArray(coords) || coords.length < 2) continue;
            for (let j = 0; j < coords.length - 1; j++) {
                const a = L.latLng(coords[j][1], coords[j][0]);
                const b = L.latLng(coords[j + 1][1], coords[j + 1][0]);
                const closest = closestPointOnSegmentLatLng(point, a, b);
                const d = map.distance(point, closest);
                if (d < min) min = d;
            }
        }
        return min;
    }

    function nearFreewayMeters(map, point, transport) {
        return minDistanceToSegmentsMeters(map, point, transport.freeways);
    }

    function nearRailroadMeters(map, point, transport) {
        return minDistanceToSegmentsMeters(map, point, transport.railroads);
    }

    function corridorThresholdMeters() {
        return CORRIDOR_OFFSET_FT * METERS_PER_FOOT;
    }

    function fetchRuralClass(latlng) {
        const key = latlng.lat.toFixed(4) + ',' + latlng.lng.toFixed(4);
        if (ruralClassCache.has(key)) return ruralClassCache.get(key);
        const p = Promise.resolve()
            .then(function () {
                if (!global.authModule || typeof global.authModule.apiRequest !== 'function') {
                    return { maxLineFeet: HALF_MILE_FT, label: 'City · up to 0.5 mi', rural: false, ruca: null };
                }
                return global.authModule
                    .apiRequest(
                        'geocoding/rural-class?lat=' +
                            encodeURIComponent(String(latlng.lat)) +
                            '&lng=' +
                            encodeURIComponent(String(latlng.lng))
                    )
                    .then(function (res) {
                        const row = res && res.data !== undefined ? res.data : res;
                        const maxLineFeet =
                            row && Number.isFinite(Number(row.maxLineFeet))
                                ? Number(row.maxLineFeet)
                                : HALF_MILE_FT;
                        return {
                            maxLineFeet: maxLineFeet,
                            label:
                                row && row.label
                                    ? String(row.label)
                                    : maxLineFeet >= TWO_MILE_FT
                                      ? 'Rural · up to 2 mi'
                                      : 'City · up to 0.5 mi',
                            rural: !!(row && row.rural),
                            ruca: row && row.ruca != null ? Number(row.ruca) : null,
                        };
                    });
            })
            .catch(function () {
                return { maxLineFeet: HALF_MILE_FT, label: 'City · up to 0.5 mi', rural: false, ruca: null };
            });
        ruralClassCache.set(key, p);
        return p;
    }

    function isNonMetroRuca(ruca) {
        if (!Number.isFinite(ruca) || ruca === 99) return false;
        return ruca >= 4 && ruca <= 10;
    }

    function capLabelFromFlags(allNonMetro, allNearFreeway, allNearRail, qualifiesTwoMile) {
        if (!qualifiesTwoMile) return 'City · up to 0.5 mi';
        if (allNearFreeway && !allNearRail && !allNonMetro) return 'Along freeway · up to 2 mi';
        if (allNearRail && !allNearFreeway && !allNonMetro) return 'Along railroad · up to 2 mi';
        if (allNonMetro && !allNearFreeway && !allNearRail) return 'Rural · up to 2 mi';
        return 'Extended · up to 2 mi';
    }

    function classifySamplesTransportOnly(map, samples, transport) {
        const thresholdM = corridorThresholdMeters();
        let allNearFreeway = true;
        let allNearRail = true;
        for (let i = 0; i < samples.length; i++) {
            const pt = samples[i];
            if (nearFreewayMeters(map, pt, transport) > thresholdM) allNearFreeway = false;
            if (nearRailroadMeters(map, pt, transport) > thresholdM) allNearRail = false;
        }
        const qualifiesTwoMile = allNearFreeway || allNearRail;
        return {
            maxLineFeet: qualifiesTwoMile ? TWO_MILE_FT : HALF_MILE_FT,
            label: capLabelFromFlags(false, allNearFreeway, allNearRail, qualifiesTwoMile),
        };
    }

    /**
     * Sync corridor check (freeway/rail only) after transport JSON is loaded.
     * @param {L.Map} map
     * @param {L.LatLng[]} latlngs
     * @returns {{ maxLineFeet: number, label: string }}
     */
    function computeTransportOnlyLineCap(map, latlngs) {
        const samples = samplePointsAlongPolyline(map, latlngs);
        if (!samples.length || !transportCache) {
            return { maxLineFeet: HALF_MILE_FT, label: 'City · up to 0.5 mi' };
        }
        return classifySamplesTransportOnly(map, samples, transportCache);
    }

    /**
     * @param {L.Map} map
     * @param {L.LatLng[]} latlngs
     * @returns {Promise<{ maxLineFeet: number, label: string }>}
     */
    async function computeLineLengthCap(map, latlngs) {
        const samples = samplePointsAlongPolyline(map, latlngs);
        if (!samples.length) {
            return { maxLineFeet: HALF_MILE_FT, label: 'City · up to 0.5 mi' };
        }
        const transport = await loadTransportData();
        const thresholdM = corridorThresholdMeters();
        const ruralResults = await Promise.all(samples.map(fetchRuralClass));

        let allNonMetro = true;
        let allNearFreeway = true;
        let allNearRail = true;

        for (let i = 0; i < samples.length; i++) {
            const pt = samples[i];
            const ruralRow = ruralResults[i];
            if (!isNonMetroRuca(ruralRow.ruca)) allNonMetro = false;
            const fw = nearFreewayMeters(map, pt, transport);
            const rail = nearRailroadMeters(map, pt, transport);
            if (fw > thresholdM) allNearFreeway = false;
            if (rail > thresholdM) allNearRail = false;
        }

        const qualifiesTwoMile = allNonMetro || allNearFreeway || allNearRail;
        const maxLineFeet = qualifiesTwoMile ? TWO_MILE_FT : HALF_MILE_FT;
        return {
            maxLineFeet: maxLineFeet,
            label: capLabelFromFlags(allNonMetro, allNearFreeway, allNearRail, qualifiesTwoMile),
        };
    }

    function mergeLineCaps(fullCap, transportCap) {
        const maxLineFeet = Math.max(
            fullCap.maxLineFeet,
            transportCap.maxLineFeet
        );
        let label = fullCap.label;
        if (maxLineFeet >= TWO_MILE_FT && fullCap.maxLineFeet < TWO_MILE_FT && transportCap.maxLineFeet >= TWO_MILE_FT) {
            label = transportCap.label;
        }
        return { maxLineFeet: maxLineFeet, label: label };
    }

    function wouldExceedLineCap(map, latlngs, maxLineFeet) {
        const lenFt = polylineLengthFeet(map, latlngs);
        return lenFt > maxLineFeet + 0.5;
    }

    function circleAreaSqFeet(radiusMeters) {
        const rFt = radiusMeters * FEET_PER_METER;
        return Math.PI * rFt * rFt;
    }

    global.digSiteLimitsModule = {
        MAX_AREA_SQ_FT: MAX_AREA_SQ_FT,
        MAX_CIRCLE_RADIUS_FT: MAX_CIRCLE_RADIUS_FT,
        HALF_MILE_FT: HALF_MILE_FT,
        TWO_MILE_FT: TWO_MILE_FT,
        formatLengthFeet: formatLengthFeet,
        formatAreaSqFt: formatAreaSqFt,
        maxCircleRadiusMeters: maxCircleRadiusMeters,
        clampCircleRadiusMeters: clampCircleRadiusMeters,
        circleAreaSqFeet: circleAreaSqFeet,
        geoJsonPolygonAreaSqFeet: geoJsonPolygonAreaSqFeet,
        exceedsMaxAreaSqFeet: exceedsMaxAreaSqFeet,
        polylineLengthFeet: polylineLengthFeet,
        samplePointsAlongPolyline: samplePointsAlongPolyline,
        loadTransportData: loadTransportData,
        computeTransportOnlyLineCap: computeTransportOnlyLineCap,
        computeLineLengthCap: computeLineLengthCap,
        mergeLineCaps: mergeLineCaps,
        wouldExceedLineCap: wouldExceedLineCap,
        ringFromGeoJsonPolygon: ringFromGeoJsonPolygon,
        polygonAreaSqFeet: polygonAreaSqFeet,
    };
})(typeof window !== 'undefined' ? window : globalThis);
