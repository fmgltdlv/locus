/**
 * Robust GPS point averaging with outlier removal (incident-scale clusters).
 */

(function () {
    function photoHasValidGpsPair(lat, lng) {
        if (lat == null || lng == null || lat === '' || lng === '') return false;
        const la = Number(lat);
        const ln = Number(lng);
        return Number.isFinite(la) && Number.isFinite(ln);
    }

    function extractPhotoGpsPoint(photo) {
        if (!photo || typeof photo !== 'object') return null;
        if (photo.latlng && photoHasValidGpsPair(photo.latlng.lat, photo.latlng.lng)) {
            return { lat: Number(photo.latlng.lat), lng: Number(photo.latlng.lng) };
        }
        if (photoHasValidGpsPair(photo.lat, photo.lng)) {
            return { lat: Number(photo.lat), lng: Number(photo.lng) };
        }
        const exif = photo.exifData;
        if (!exif || typeof exif !== 'object') return null;
        if (exif.hasGPS === false || exif.gpsSource === 'None') return null;
        if (photoHasValidGpsPair(exif.gpsLat, exif.gpsLng)) {
            return { lat: Number(exif.gpsLat), lng: Number(exif.gpsLng) };
        }
        return null;
    }

    function tryParseJson(s) {
        try {
            return JSON.parse(s);
        } catch {
            return null;
        }
    }

    /** Extract lat/lng from GET /data/media/:id response (metadata only). */
    function extractMediaGpsPoint(file) {
        if (!file || typeof file !== 'object') return null;
        const rawMeta = file.metadata;
        const meta = typeof rawMeta === 'string' ? tryParseJson(rawMeta) || {} : rawMeta || {};
        const exif = meta.exif && typeof meta.exif === 'object' ? meta.exif : {};
        const lat = meta.lat ?? meta.gpsLat ?? exif.gpsLat;
        const lng = meta.lng ?? meta.gpsLng ?? exif.gpsLng;
        const hasStoredGps =
            meta.hasGPS === true ||
            exif.hasGPS === true ||
            photoHasValidGpsPair(lat, lng);
        if (!hasStoredGps) return null;
        if (!photoHasValidGpsPair(lat, lng)) return null;
        return { lat: Number(lat), lng: Number(lng) };
    }

    function haversineDistanceMeters(a, b) {
        const R = 6371000;
        const lat1 = (a.lat * Math.PI) / 180;
        const lat2 = (b.lat * Math.PI) / 180;
        const dLat = ((b.lat - a.lat) * Math.PI) / 180;
        const dLng = ((b.lng - a.lng) * Math.PI) / 180;
        const sinDLat = Math.sin(dLat / 2);
        const sinDLng = Math.sin(dLng / 2);
        const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function median(values) {
        if (!values.length) return 0;
        const sorted = values.slice().sort(function (a, b) {
            return a - b;
        });
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function arithmeticMean(points) {
        const lat = points.reduce(function (s, p) {
            return s + p.lat;
        }, 0) / points.length;
        const lng = points.reduce(function (s, p) {
            return s + p.lng;
        }, 0) / points.length;
        return { lat: lat, lng: lng };
    }

    /**
     * @param {{ lat: number, lng: number }[]} points
     * @returns {{ lat: number, lng: number, usedCount: number, droppedCount: number } | null}
     */
    function robustAverageGpsPoints(points) {
        if (!points || !points.length) return null;
        const valid = points.filter(function (p) {
            return p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
        });
        if (!valid.length) return null;
        if (valid.length === 1) {
            return {
                lat: valid[0].lat,
                lng: valid[0].lng,
                usedCount: 1,
                droppedCount: 0,
            };
        }

        const totalCount = valid.length;
        const initialCentroid = arithmeticMean(valid);
        let active = valid.slice();

        for (let iter = 0; iter < 2; iter++) {
            const center = arithmeticMean(active);
            const dists = active.map(function (p) {
                return haversineDistanceMeters(p, center);
            });
            const med = median(dists);
            const absDevs = dists.map(function (d) {
                return Math.abs(d - med);
            });
            const mad = median(absDevs);
            const threshold = Math.max(75, med + 3 * mad);
            const filtered = active.filter(function (_p, i) {
                return dists[i] <= threshold;
            });
            if (filtered.length === active.length || filtered.length === 0) break;
            active = filtered;
        }

        if (!active.length) {
            let closest = valid[0];
            let minD = haversineDistanceMeters(valid[0], initialCentroid);
            for (let i = 1; i < valid.length; i++) {
                const d = haversineDistanceMeters(valid[i], initialCentroid);
                if (d < minD) {
                    minD = d;
                    closest = valid[i];
                }
            }
            active = [closest];
        }

        const result = arithmeticMean(active);
        return {
            lat: result.lat,
            lng: result.lng,
            usedCount: active.length,
            droppedCount: totalCount - active.length,
        };
    }

    window.geoGpsAverage = {
        extractPhotoGpsPoint: extractPhotoGpsPoint,
        extractMediaGpsPoint: extractMediaGpsPoint,
        haversineDistanceMeters: haversineDistanceMeters,
        robustAverageGpsPoints: robustAverageGpsPoints,
    };
})();
