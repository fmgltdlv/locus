// Create-ticket parcel overlays: Clark GISMO AssessorMap/Anno when center is in Clark;
// else statewide NV USAN WMS parcels_nv fallback. Additive pane — does not clear aerials/tickets.
(function (global) {
    'use strict';

    const MIN_ZOOM = 17;
    const REFRESH_DEBOUNCE_MS = 150;
    const MAX_EXPORT_PX = 4096;
    const PANE_NAME = 'assessorOverlayPane';
    const PANE_Z_INDEX = '360';
    const WKID = 102707;

    const PROVIDER_CLARK = 'clark_nv_gismo';
    const PROVIDER_USAN = 'usan_nv_wms';

    const ASSESSOR_MAP_URL =
        'https://maps.clarkcountynv.gov/arcgis/rest/services/GISMO/AssessorMap/MapServer/export';
    const ASSESSOR_ANNO_URL =
        'https://maps.clarkcountynv.gov/arcgis/rest/services/GISMO/AssessorAnno/MapServer/export';

    const USAN_WMS_URL =
        'https://usanmap.pcges.us/geoserver/ref_us_nv_north811_live/wms';
    const USAN_WMS_LAYERS = 'ref_us_nv_north811_live:parcels_nv';

    let sessionActive = false;
    let listenersBound = false;
    let refreshTimer = null;
    let refreshGeneration = 0;
    let mapLayer = null;
    let annoLayer = null;
    /** In-flight Clark exports awaiting load before replacing the visible layer. */
    let pendingMapLayer = null;
    let pendingAnnoLayer = null;
    let wmsLayer = null;
    /** @type {string|null} */
    let activeProvider = null;
    let boundMap = null;

    function getMap() {
        return global.map || null;
    }

    function ensurePane(map) {
        if (!map.getPane(PANE_NAME)) {
            const pane = map.createPane(PANE_NAME);
            pane.style.zIndex = PANE_Z_INDEX;
            pane.style.pointerEvents = 'none';
        } else {
            const pane = map.getPane(PANE_NAME);
            if (pane) {
                pane.style.zIndex = PANE_Z_INDEX;
                pane.style.pointerEvents = 'none';
            }
        }
    }

    function clearRefreshTimer() {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
    }

    function discardLayer(layer) {
        if (!layer) return;
        layer.off('load error');
        const map = getMap();
        if (map && map.hasLayer(layer)) map.removeLayer(layer);
    }

    function abortPendingClarkLayers() {
        discardLayer(pendingMapLayer);
        discardLayer(pendingAnnoLayer);
        pendingMapLayer = null;
        pendingAnnoLayer = null;
    }

    function removeClarkLayers() {
        const map = getMap();
        abortPendingClarkLayers();
        if (mapLayer) {
            if (map && map.hasLayer(mapLayer)) map.removeLayer(mapLayer);
            mapLayer = null;
        }
        if (annoLayer) {
            if (map && map.hasLayer(annoLayer)) map.removeLayer(annoLayer);
            annoLayer = null;
        }
    }

    function removeUsanLayer() {
        const map = getMap();
        if (wmsLayer) {
            if (map && map.hasLayer(wmsLayer)) map.removeLayer(wmsLayer);
            wmsLayer = null;
        }
    }

    function removeOverlayLayers() {
        removeClarkLayers();
        removeUsanLayer();
        activeProvider = null;
    }

    function buildExportUrl(baseUrl, layersShow, bbox, width, height) {
        const params = new URLSearchParams({
            dpi: '96',
            transparent: 'true',
            format: 'png8',
            layers: 'show:' + layersShow,
            bbox: bbox.join(','),
            bboxSR: String(WKID),
            imageSR: String(WKID),
            size: width + ',' + height,
            f: 'image',
        });
        return baseUrl + '?' + params.toString();
    }

    function projectBoundsToStatePlane(bounds) {
        const pg = global.parcelGeocodeModule;
        if (!pg || typeof pg.latLngToStatePlane !== 'function') {
            throw new Error('parcelGeocodeModule.latLngToStatePlane is not available');
        }
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const swSp = pg.latLngToStatePlane(sw.lat, sw.lng);
        const neSp = pg.latLngToStatePlane(ne.lat, ne.lng);
        const xmin = Math.min(swSp.x, neSp.x);
        const ymin = Math.min(swSp.y, neSp.y);
        const xmax = Math.max(swSp.x, neSp.x);
        const ymax = Math.max(swSp.y, neSp.y);
        return [xmin, ymin, xmax, ymax];
    }

    /**
     * Load a new GISMO export into a fresh ImageOverlay; keep the current layer
     * georeferenced until the new image loads, then swap. Avoids setBounds+setUrl
     * stretching stale pixels across the new viewport while the export fetches.
     * @param {'map'|'anno'} slot
     */
    function swapClarkImageOverlay(slot, url, latLngBounds, map, generation) {
        const isMap = slot === 'map';
        const existing = isMap ? mapLayer : annoLayer;
        const prevPending = isMap ? pendingMapLayer : pendingAnnoLayer;
        if (prevPending) {
            discardLayer(prevPending);
            if (isMap) pendingMapLayer = null;
            else pendingAnnoLayer = null;
        }

        const next = L.imageOverlay(url, latLngBounds, {
            pane: PANE_NAME,
            opacity: existing ? 0 : 1,
            interactive: false,
            className: 'create-ticket-assessor-overlay',
        });

        let settled = false;
        const settle = function (ok) {
            if (settled) return;
            settled = true;
            next.off('load', onLoad);
            next.off('error', onError);
            if (isMap) {
                if (pendingMapLayer === next) pendingMapLayer = null;
            } else if (pendingAnnoLayer === next) {
                pendingAnnoLayer = null;
            }
            if (!ok || generation !== refreshGeneration || !sessionActive) {
                discardLayer(next);
                return;
            }
            if (existing && existing !== next) discardLayer(existing);
            const overlayEl = typeof next.getElement === 'function' ? next.getElement() : null;
            if (overlayEl) overlayEl.classList.add('create-ticket-assessor-overlay--ready');
            if (typeof next.setOpacity === 'function') next.setOpacity(1);
            if (!map.hasLayer(next)) next.addTo(map);
            if (isMap) mapLayer = next;
            else annoLayer = next;
            activeProvider = PROVIDER_CLARK;
        };

        const onLoad = function () {
            settle(true);
        };
        const onError = function () {
            settle(false);
        };

        next.once('load', onLoad);
        next.once('error', onError);
        if (isMap) pendingMapLayer = next;
        else pendingAnnoLayer = next;
        next.addTo(map);

        // Cached images may already be complete when Leaflet wires the element.
        const img = typeof next.getElement === 'function' ? next.getElement() : null;
        if (img && img.complete && img.naturalWidth > 0) {
            settle(true);
        }
    }

    function ensureUsanWms(map) {
        if (wmsLayer) {
            if (!map.hasLayer(wmsLayer)) wmsLayer.addTo(map);
            return wmsLayer;
        }
        if (typeof L === 'undefined' || !L.tileLayer || typeof L.tileLayer.wms !== 'function') {
            throw new Error('L.tileLayer.wms is not available');
        }
        wmsLayer = L.tileLayer.wms(USAN_WMS_URL, {
            layers: USAN_WMS_LAYERS,
            format: 'image/png',
            transparent: true,
            version: '1.1.1',
            pane: PANE_NAME,
            opacity: 1,
            maxZoom: 24,
            minZoom: MIN_ZOOM,
            className: 'create-ticket-usan-parcel-overlay',
            updateWhenIdle: true,
            updateWhenZooming: false,
        });
        wmsLayer.addTo(map);
        return wmsLayer;
    }

    function hideOverlays() {
        clearRefreshTimer();
        refreshGeneration += 1;
        removeOverlayLayers();
    }

    function switchProvider(nextProvider) {
        if (activeProvider === nextProvider) return;
        if (activeProvider === PROVIDER_CLARK) removeClarkLayers();
        if (activeProvider === PROVIDER_USAN) removeUsanLayer();
        activeProvider = nextProvider;
    }

    function refreshClark(map, generation) {
        // Drop USAN (or other prior provider) before work that can fail, so stale tiles never linger.
        if (activeProvider !== PROVIDER_CLARK) {
            switchProvider(PROVIDER_CLARK);
        }

        let bbox;
        try {
            bbox = projectBoundsToStatePlane(map.getBounds());
        } catch (e) {
            console.warn('[createTicketAssessorOverlay] project bounds', e);
            removeClarkLayers();
            activeProvider = null;
            return;
        }

        const size = map.getSize();
        const width = Math.max(1, Math.min(MAX_EXPORT_PX, Math.round(size.x)));
        const height = Math.max(1, Math.min(MAX_EXPORT_PX, Math.round(size.y)));
        const latLngBounds = map.getBounds();
        ensurePane(map);

        const mapUrl = buildExportUrl(ASSESSOR_MAP_URL, '0,1', bbox, width, height);
        const annoUrl = buildExportUrl(ASSESSOR_ANNO_URL, '0', bbox, width, height);

        if (generation !== refreshGeneration) return;

        try {
            // Keep any existing Clark layers visible at their original bounds until
            // the new exports load (swapClarkImageOverlay). Mark provider active now
            // so switchProvider does not tear them down mid-fetch.
            activeProvider = PROVIDER_CLARK;
            swapClarkImageOverlay('map', mapUrl, latLngBounds, map, generation);
            swapClarkImageOverlay('anno', annoUrl, latLngBounds, map, generation);
        } catch (e) {
            console.warn('[createTicketAssessorOverlay] swap Clark overlays', e);
            removeClarkLayers();
            activeProvider = null;
        }
    }

    function refreshUsan(map, generation) {
        if (activeProvider !== PROVIDER_USAN) {
            switchProvider(PROVIDER_USAN);
        }
        ensurePane(map);
        if (generation !== refreshGeneration) return;
        try {
            ensureUsanWms(map);
            activeProvider = PROVIDER_USAN;
        } catch (e) {
            console.warn('[createTicketAssessorOverlay] USAN WMS', e);
            removeUsanLayer();
            activeProvider = null;
        }
    }

    function refresh() {
        if (!sessionActive) return;
        const map = getMap();
        if (!map || typeof L === 'undefined') return;
        if (map.getZoom() < MIN_ZOOM) {
            hideOverlays();
            return;
        }

        const generation = ++refreshGeneration;
        const coverage = global.mapCountyCoverageModule;
        const resolve =
            coverage && typeof coverage.resolveParcelOverlayProvider === 'function'
                ? coverage.resolveParcelOverlayProvider(map)
                : Promise.resolve({ provider: PROVIDER_CLARK, countyId: 'clark_nv' });

        Promise.resolve(resolve)
            .then(function (resolved) {
                if (!sessionActive || generation !== refreshGeneration) return;
                if (!resolved || !resolved.provider) {
                    hideOverlays();
                    return;
                }
                if (resolved.provider === PROVIDER_CLARK) {
                    refreshClark(map, generation);
                    return;
                }
                if (resolved.provider === PROVIDER_USAN) {
                    refreshUsan(map, generation);
                    return;
                }
                hideOverlays();
            })
            .catch(function (err) {
                console.warn('[createTicketAssessorOverlay] resolve provider', err);
            });
    }

    function scheduleRefresh() {
        if (!sessionActive) return;
        clearRefreshTimer();
        refreshTimer = setTimeout(function () {
            refreshTimer = null;
            refresh();
        }, REFRESH_DEBOUNCE_MS);
    }

    function syncVisibility() {
        if (!sessionActive) {
            hideOverlays();
            return;
        }
        const map = getMap();
        if (!map) return;
        if (map.getZoom() < MIN_ZOOM) {
            hideOverlays();
            return;
        }
        scheduleRefresh();
    }

    function onMapViewportChanged() {
        syncVisibility();
    }

    function bindListeners(map) {
        if (listenersBound && boundMap === map) return;
        if (listenersBound && boundMap && boundMap !== map) {
            boundMap.off('moveend zoomend', onMapViewportChanged);
            listenersBound = false;
            boundMap = null;
        }
        map.on('moveend zoomend', onMapViewportChanged);
        listenersBound = true;
        boundMap = map;
    }

    function unbindListeners() {
        if (!listenersBound) return;
        if (boundMap) {
            boundMap.off('moveend zoomend', onMapViewportChanged);
        }
        listenersBound = false;
        boundMap = null;
    }

    /**
     * Enable/disable parcel overlays for the create-ticket wizard session.
     * Minimize/restore must not call this — only open/close of the wizard session.
     */
    function setActive(active) {
        const next = !!active;
        if (next === sessionActive) {
            if (next) syncVisibility();
            return;
        }
        sessionActive = next;
        if (!sessionActive) {
            clearRefreshTimer();
            unbindListeners();
            removeOverlayLayers();
            refreshGeneration += 1;
            return;
        }
        const map = getMap();
        if (!map) return;
        ensurePane(map);
        bindListeners(map);
        syncVisibility();
    }

    function isActive() {
        return sessionActive;
    }

    global.createTicketAssessorOverlayModule = {
        setActive: setActive,
        isActive: isActive,
        MIN_ZOOM: MIN_ZOOM,
        PROVIDER_CLARK: PROVIDER_CLARK,
        PROVIDER_USAN: PROVIDER_USAN,
    };
})(typeof window !== 'undefined' ? window : globalThis);
