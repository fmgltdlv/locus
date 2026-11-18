// Assessor parcel reverse geocode (Clark County NV via GISMO today).
(function () {
    'use strict';

    const GISMO_WKID = 102707;
    const NV_EAST_FTUS =
        '+proj=tmerc +lat_0=34.75 +lon_0=-115.583333333333 +k=0.9999 +x_0=200000.00001016 +y_0=8000000.00001016 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs';
    const ZIP_CITY_URL = 'data/parcelZipCity.json';

    let zipCityMap = null;
    let zipCityLoadPromise = null;

    function getGeocodeApiBase() {
        const apiBase = (window.authModule && window.authModule.API_BASE) || window.API_BASE;
        if (!apiBase) {
            throw new Error('API base is not configured. Set window.API_BASE_URL in config-override.js.');
        }
        return apiBase;
    }

    function authHeaders() {
        return window.authModule && typeof window.authModule.getAuthHeaders === 'function'
            ? window.authModule.getAuthHeaders()
            : {};
    }

    function ensureProj4() {
        if (typeof proj4 === 'undefined') {
            throw new Error('proj4 is not loaded');
        }
        if (!proj4.defs('EPSG:3421')) {
            proj4.defs('EPSG:3421', NV_EAST_FTUS);
        }
    }

    function latLngToStatePlane(lat, lng) {
        ensureProj4();
        const latNum = Number(lat);
        const lngNum = Number(lng);
        if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
            throw new Error('Invalid latitude or longitude');
        }
        const out = proj4('EPSG:4326', 'EPSG:3421', [lngNum, latNum]);
        return { x: out[0], y: out[1] };
    }

    function statePlaneToLatLng(x, y) {
        ensureProj4();
        const xNum = Number(x);
        const yNum = Number(y);
        if (!Number.isFinite(xNum) || !Number.isFinite(yNum)) return null;
        const out = proj4('EPSG:3421', 'EPSG:4326', [xNum, yNum]);
        return { lat: out[1], lng: out[0] };
    }

    function titleCaseAddressWord(word) {
        const w = String(word || '');
        if (!w) return '';
        if (/^\d+[A-Za-z]?$/.test(w)) return w;
        const lower = w.toLowerCase();
        return lower.charAt(0).toUpperCase() + lower.slice(1);
    }

    function normalizeSiteAddress(raw) {
        return String(raw || '')
            .trim()
            .replace(/\s+/g, ' ')
            .split(' ')
            .filter(function (part) {
                return part.length > 0;
            })
            .map(titleCaseAddressWord)
            .join(' ');
    }

    function ensureZipCityMap() {
        if (zipCityMap) return Promise.resolve(zipCityMap);
        if (zipCityLoadPromise) return zipCityLoadPromise;
        zipCityLoadPromise = fetch(ZIP_CITY_URL, { headers: { Accept: 'application/json' } })
            .then(function (res) {
                if (!res.ok) throw new Error('ZIP city lookup unavailable');
                return res.json();
            })
            .then(function (data) {
                zipCityMap = data && typeof data === 'object' ? data : {};
                return zipCityMap;
            })
            .catch(function (err) {
                console.warn('[parcelGeocode] ZIP city map load failed', err);
                zipCityMap = {};
                return zipCityMap;
            });
        return zipCityLoadPromise;
    }

    function cityFromZipCode(zipCode, map) {
        const zip = String(zipCode || '').trim();
        if (!zip || !map) return '';
        return map[zip] || '';
    }

    function formatDisplayLine(siteAddress, city, zipCode, parcelId) {
        if (shouldUseApnDisplay(siteAddress)) {
            return formatApnDisplayLine(parcelId);
        }
        const addr = normalizeSiteAddress(siteAddress);
        const c = String(city || '').trim();
        const zip = String(zipCode || '').trim();
        const parts = [];
        if (addr) parts.push(addr);
        if (c) parts.push(c);
        if (zip) {
            parts.push('NV ' + zip);
        } else if (parts.length) {
            parts.push('NV');
        }
        return parts.join(', ');
    }

    /** No situs street address — show assessor parcel number (APN) instead. */
    function shouldUseApnDisplay(siteAddress) {
        const normalized = normalizeSiteAddress(siteAddress);
        return !normalized || normalized === '0';
    }

    function formatApnDisplayLine(parcelId) {
        const id = String(parcelId || '').trim();
        return id ? 'APN: ' + id : '';
    }

    function statePlaneRingToLatLngs(ring) {
        if (!Array.isArray(ring) || ring.length < 3) return null;
        ensureProj4();
        const latlngs = [];
        for (let i = 0; i < ring.length; i++) {
            const pt = ring[i];
            if (!Array.isArray(pt) || pt.length < 2) continue;
            const x = Number(pt[0]);
            const y = Number(pt[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const out = proj4('EPSG:3421', 'EPSG:4326', [x, y]);
            latlngs.push([out[1], out[0]]);
        }
        return latlngs.length >= 3 ? latlngs : null;
    }

    async function fetchParcelLookup(x, y) {
        const apiBase = getGeocodeApiBase();
        const path =
            'geocoding/parcel/lookup?x=' +
            encodeURIComponent(x) +
            '&y=' +
            encodeURIComponent(y) +
            '&wkid=' +
            encodeURIComponent(GISMO_WKID);
        const url = apiBase + (path.startsWith('/') ? path : '/' + path);
        const response = await fetch(url, {
            method: 'GET',
            headers: Object.assign({ Accept: 'application/json' }, authHeaders()),
        });
        if (!response.ok) {
            const err = new Error('Parcel lookup request failed (' + response.status + ')');
            err.status = response.status;
            throw err;
        }
        return response.json();
    }

    /**
     * Reverse geocode a map click to situs address + city.
     * Parcel situs rows are persisted in D1 on the Worker (parcel_geocode_cache).
     * @returns {Promise<{ displayLine: string, siteAddress: string, city: string, zipCode: string, parcelId: string, fromCache: boolean, useApnDisplay: boolean, parcelRingLatLngs: number[][]|null, error: string|null }>}
     */
    async function lookupAddressAtLatLng(lat, lng) {
        await ensureZipCityMap();
        const { x, y } = latLngToStatePlane(lat, lng);
        const data = await fetchParcelLookup(x, y);
        const parcelId = String((data && data.parcelId) || '').trim();
        const parcelRingLatLngs = statePlaneRingToLatLngs(data && data.parcelGeometry);
        if (data && data.error) {
            return {
                displayLine: '',
                siteAddress: '',
                city: '',
                zipCode: '',
                parcelId: parcelId,
                fromCache: false,
                useApnDisplay: false,
                parcelRingLatLngs: parcelRingLatLngs,
                error: String(data.error),
            };
        }
        if (!parcelId) {
            return {
                displayLine: '',
                siteAddress: '',
                city: '',
                zipCode: '',
                parcelId: '',
                fromCache: false,
                useApnDisplay: false,
                parcelRingLatLngs: parcelRingLatLngs,
                error: 'No parcel at this location',
            };
        }

        const siteAddress = normalizeSiteAddress(data && data.siteAddress);
        const zipCode = String((data && data.zipCode) || '').trim();
        const city = cityFromZipCode(zipCode, zipCityMap);
        const useApnDisplay = shouldUseApnDisplay(data && data.siteAddress);
        const displayLine = formatDisplayLine(data && data.siteAddress, city, zipCode, parcelId);

        if (!displayLine) {
            return {
                displayLine: '',
                siteAddress: siteAddress,
                city: city,
                zipCode: zipCode,
                parcelId: parcelId,
                fromCache: false,
                useApnDisplay: useApnDisplay,
                parcelRingLatLngs: parcelRingLatLngs,
                error: 'No address for this parcel',
            };
        }

        return {
            displayLine: displayLine,
            siteAddress: siteAddress,
            city: city,
            zipCode: zipCode,
            parcelId: parcelId,
            fromCache: !!(data && data.propertyFromCache),
            useApnDisplay: useApnDisplay,
            parcelRingLatLngs: parcelRingLatLngs,
            error: null,
        };
    }

    window.parcelGeocodeModule = {
        lookupAddressAtLatLng: lookupAddressAtLatLng,
        formatDisplayLine: formatDisplayLine,
        formatApnDisplayLine: formatApnDisplayLine,
        shouldUseApnDisplay: shouldUseApnDisplay,
        latLngToStatePlane: latLngToStatePlane,
        statePlaneToLatLng: statePlaneToLatLng,
        statePlaneRingToLatLngs: statePlaneRingToLatLngs,
    };
})();
