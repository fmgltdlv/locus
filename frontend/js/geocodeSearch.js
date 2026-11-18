// Shared forward-geocode helper. No map side effects — callers handle pan/zoom/markers.
(function () {
    'use strict';

    function getGeocodeApiBase() {
        const apiBase = (window.authModule && window.authModule.API_BASE) || window.API_BASE;
        if (!apiBase) {
            throw new Error('API base is not configured. Set window.API_BASE_URL in config-override.js.');
        }
        return apiBase;
    }

    function isClarkCountyCoverage(county) {
        return !!(county && (county.id === 'clark_nv' || county.provider === 'clark_nv_gismo'));
    }

    /**
     * Map toolbar location fan: Clark GISMO when applicable, else Photon/Nominatim via /geocoding/search.
     * Falls back to OSM when GISMO returns no rows or throws.
     */
    async function fetchMapToolbarAddressSuggestions(query, limit, map, county) {
        const lim = Number.isFinite(limit) && limit > 0 ? limit : 5;

        if (isClarkCountyCoverage(county)) {
            try {
                const rows = await fetchClarkCountyAddressSuggestions(query, lim);
                if (rows && rows.length) return rows;
            } catch (e) {
                console.warn('Clark address search failed, falling back to OSM geocode:', e);
            }
        }
        return fetchGeocodeSuggestions(query, lim);
    }

    /**
     * Clark's ArcGIS locator. Called from the browser because Cloudflare Workers
     * get an empty 200 from this host (their firewall drops datacenter requests).
     */
    const CLARK_ADDRESS_SEARCH_URL =
        'https://maps.clarkcountynv.gov/arcgis/rest/services/Locators/Clark_County_Composite_All_Pro/GeocodeServer/findAddressCandidates';

    /** Forward-geocode via Clark County ArcGIS (create-ticket map centering). Returns Nominatim-like rows. */
    async function fetchClarkCountyAddressSuggestions(query, limit) {
        const q = String(query || '').trim();
        const lim = Number.isFinite(limit) && limit > 0 ? limit : 5;
        const url =
            CLARK_ADDRESS_SEARCH_URL +
            '?Street=&SingleLine=' +
            encodeURIComponent(q) +
            '&outFields=&maxLocations=' +
            encodeURIComponent(lim) +
            '&matchOutOfRange=true&f=json';
        const controller = new AbortController();
        const timeoutId = setTimeout(function () {
            controller.abort();
        }, 15000);
        let response;
        try {
            response = await fetch(url, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                signal: controller.signal,
            });
        } catch (err) {
            if (err && err.name === 'AbortError') {
                throw new Error('Clark address search timed out');
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }
        if (!response.ok) {
            const err = new Error('HTTP error! status: ' + response.status);
            err.status = response.status;
            throw err;
        }
        const raw = await response.text();
        if (!raw || !raw.trim()) {
            throw new Error('Clark address search returned an empty response');
        }
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            throw new Error('Clark address search returned invalid JSON');
        }
        if (data && data.error) {
            throw new Error((data.error && data.error.message) || 'Clark address search failed');
        }
        const candidates = Array.isArray(data.candidates) ? data.candidates : [];
        const toLatLng =
            window.parcelGeocodeModule && typeof window.parcelGeocodeModule.statePlaneToLatLng === 'function'
                ? window.parcelGeocodeModule.statePlaneToLatLng
                : null;
        const rows = [];
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            if (!c || !c.location) continue;
            const loc = c.location;
            let lat;
            let lon;
            if (toLatLng) {
                const ll = toLatLng(loc.x, loc.y);
                if (!ll) continue;
                lat = ll.lat;
                lon = ll.lng;
            } else {
                continue;
            }
            rows.push({
                display_name: c.address || '',
                lat: String(lat),
                lon: String(lon),
                score: c.score,
                raw: c,
            });
        }
        return rows;
    }

    function usanGeoSearchDisplayName(row, query) {
        const street = row && row.street != null ? String(row.street).trim() : '';
        const suburb = row && row.suburb != null ? String(row.suburb).trim() : '';
        const county = row && row.county != null ? String(row.county).trim() : '';
        const postcode = row && row.postcode != null ? String(row.postcode).trim() : '';
        if (street) {
            const placeParts = [suburb, county, postcode].filter(function (p) {
                return p;
            });
            return placeParts.length ? street + ', ' + placeParts.join(', ') : street;
        }
        const placeCore = [suburb, county].filter(function (p) {
            return p;
        }).join(', ');
        const placeZip = placeCore && postcode ? placeCore + ' ' + postcode : placeCore || postcode;
        const q = String(query || '').trim();
        if (q && placeZip) return q + ' · ' + placeZip;
        return q || placeZip || '';
    }

    function mapUsanGeoSearchRows(rows, query, limit) {
        const lim = Number.isFinite(limit) && limit > 0 ? limit : 5;
        const out = [];
        const arr = Array.isArray(rows) ? rows : [];
        for (let i = 0; i < arr.length && out.length < lim; i++) {
            const row = arr[i];
            const coords = row && row.coordinates;
            const x = coords && Number(coords.x);
            const y = coords && Number(coords.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            out.push({
                display_name: usanGeoSearchDisplayName(row, query),
                lat: String(y),
                lon: String(x),
                raw: row,
            });
        }
        return out;
    }

    function isUsanGeoSearchCredError(err) {
        if (!err) return false;
        if (err.usanCredError === true) return true;
        const status = err.status;
        const msg = String(err.message || '').toLowerCase();
        return status === 400 && /credential|ngen master|master account|no ngen/.test(msg);
    }

    /**
     * Forward address search via nGen SearchByStreetAsync (org USAN master credentials).
     * @returns {Promise<Array<{ display_name: string, lat: string, lon: string, raw: object }>>}
     */
    async function fetchUsanStreetSuggestions(organizationId, query, limit) {
        const q = String(query || '').trim();
        const lim = Number.isFinite(limit) && limit > 0 ? limit : 5;
        const orgId = organizationId != null ? Number(organizationId) : NaN;
        if (!Number.isFinite(orgId)) {
            const err = new Error('organizationId is required for USAN address search');
            err.usanCredError = true;
            throw err;
        }
        if (!window.authModule || typeof window.authModule.apiRequest !== 'function') {
            throw new Error('authModule is not available');
        }
        try {
            const res = await window.authModule.apiRequest('tickets/geo-search-street', {
                method: 'POST',
                body: JSON.stringify({ organizationId: orgId, streetAddress: q }),
            });
            const data = res && res.data;
            const rows = Array.isArray(data) ? data : [];
            return mapUsanGeoSearchRows(rows, q, lim);
        } catch (err) {
            if (isUsanGeoSearchCredError(err)) {
                err.usanCredError = true;
            }
            throw err;
        }
    }

    /**
     * Reverse-geocode lat/lng via Worker `/geocoding/reverse` (Photon, with Nominatim per server config).
     * @returns {Promise<{ display_name: string, lat?: string, lon?: string, address?: object }|null>}
     */
    async function fetchReverseGeocode(lat, lon) {
        const latN = Number(lat);
        const lonN = Number(lon);
        if (!Number.isFinite(latN) || !Number.isFinite(lonN)) {
            throw new Error('Latitude and longitude are required');
        }
        const apiBase = getGeocodeApiBase();
        const url =
            apiBase +
            '/geocoding/reverse?lat=' +
            encodeURIComponent(latN) +
            '&lon=' +
            encodeURIComponent(lonN);
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                ...(window.authModule && typeof window.authModule.getAuthHeaders === 'function'
                    ? window.authModule.getAuthHeaders()
                    : {}),
            },
        });
        if (!response.ok) {
            const err = new Error('HTTP error! status: ' + response.status);
            err.status = response.status;
            throw err;
        }
        const data = await response.json();
        if (!data || typeof data !== 'object') return null;
        return data;
    }

    /** Forward-geocode via Worker (server applies Nevada-wide OSM bias; no map viewport bias). */
    async function fetchGeocodeSuggestions(query, limit) {
        const q = String(query || '').trim();
        const lim = Number.isFinite(limit) && limit > 0 ? limit : 5;
        const apiBase = getGeocodeApiBase();
        const url = `${apiBase}/geocoding/search?q=${encodeURIComponent(q)}&limit=${lim}&addressdetails=1`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                ...(window.authModule && typeof window.authModule.getAuthHeaders === 'function'
                    ? window.authModule.getAuthHeaders()
                    : {}),
            },
        });
        if (!response.ok) {
            const err = new Error(`HTTP error! status: ${response.status}`);
            err.status = response.status;
            throw err;
        }
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    }

    function geocodeResultDisplayName(item) {
        if (!item) return '';
        return item.display_name || `${item.name || ''} ${item.address || ''}`.trim();
    }

    function showGeocodeMessage(container, message, color) {
        if (!container) return;
        container.innerHTML = '';
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        if (color) item.style.color = color;
        item.textContent = message;
        container.appendChild(item);
        container.classList.add('show');
    }

    /**
     * Render a clickable suggestion list. onSelect receives { displayName, lat, lon, raw }.
     */
    function renderGeocodeSuggestionList(container, results, onSelect) {
        if (!container) return;
        container.innerHTML = '';
        if (!results || results.length === 0) {
            showGeocodeMessage(container, 'No results found.', 'var(--app-text-secondary)');
            return;
        }
        results.forEach(item => {
            const displayName = geocodeResultDisplayName(item);
            const lat = parseFloat(item.lat);
            const lon = parseFloat(item.lon);
            const row = document.createElement('div');
            row.className = 'suggestion-item';
            row.textContent = displayName;
            row.addEventListener('click', function () {
                if (typeof onSelect === 'function') onSelect({ displayName, lat, lon, raw: item });
            });
            container.appendChild(row);
        });
        container.classList.add('show');
    }

    window.geocodeSearchModule = {
        fetchGeocodeSuggestions,
        fetchClarkCountyAddressSuggestions,
        fetchUsanStreetSuggestions,
        isUsanGeoSearchCredError,
        fetchMapToolbarAddressSuggestions,
        fetchReverseGeocode,
        renderGeocodeSuggestionList,
        showGeocodeMessage,
        geocodeResultDisplayName,
        get MIN_QUERY_LENGTH() {
            return typeof window.MIN_ADDRESS_QUERY_LENGTH === 'number' ? window.MIN_ADDRESS_QUERY_LENGTH : 3;
        },
    };
})();
