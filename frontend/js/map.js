// Global map variable
let map;

// Initialize Leaflet map
function initMap() {
    map = L.map('map', {
        maxZoom: 24,
        zoomControl: false
    }).setView(MAP_CONFIG.defaultCenter, MAP_CONFIG.defaultZoom);

    // Define base layers
    // Base maps use zIndex: 0 to ensure they render below aerial maps (zIndex: 100) and tickets (pane z-index: 300)
    /** Defer new tile fetches until pan/zoom motion stops (Leaflet GridLayer). */
    const basemapTileOpts = { updateWhenIdle: true, updateWhenZooming: false };

    const TRANSPARENT_TILE =
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        ...basemapTileOpts,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxNativeZoom: 19, // OpenStreetMap only supports up to zoom 19
        maxZoom: 24, // Allow zooming beyond, but will use zoom 19 tiles
        zIndex: 0, // Base maps should be below tickets and aerial maps
        errorTileUrl: TRANSPARENT_TILE,
        // Suppress tile loading errors for tiles beyond native zoom
        tileerror: function(error, tile) {
            // Silently handle 404/400 for zoom levels beyond native max (expected)
        }
    });

    const mapboxAccessToken =
        typeof window.getMapboxAccessToken === 'function' ? window.getMapboxAccessToken() : '';
    const mapboxAttribution =
        '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> <a href="https://www.mapbox.com/map-feedback/" target="_blank" rel="noopener noreferrer">Improve this map</a>';
    /** Mapbox 512px @2x tiles: zoomOffset -1 is the Leaflet pairing (do not use +1 — breaks x/y alignment). */
    const MAPBOX_HYBRID_ZOOM_OFFSET = -1;
    const MAPBOX_HYBRID_MAX_NATIVE_ZOOM = 22;
    let mapboxHybridLayer = null;
    if (mapboxAccessToken) {
        mapboxHybridLayer = L.tileLayer(
            'https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/{z}/{x}/{y}@2x?access_token=' +
                encodeURIComponent(mapboxAccessToken),
            {
                ...basemapTileOpts,
                tileSize: 512,
                zoomOffset: MAPBOX_HYBRID_ZOOM_OFFSET,
                attribution: mapboxAttribution,
                maxNativeZoom: MAPBOX_HYBRID_MAX_NATIVE_ZOOM,
                maxZoom: 24,
                zIndex: 0,
                errorTileUrl: TRANSPARENT_TILE,
                tileerror: function () {}
            }
        );
    }

    // Store layers globally for theme switching / applyBasemap
    window.mapLayers = {
        default: osmLayer
    };
    if (mapboxHybridLayer) {
        window.mapLayers.mapboxHybrid = mapboxHybridLayer;
    }
    window.currentMapLayer = osmLayer;

    /** Open tile providers; order matches the basemap picker. */
    const BASEMAP_OPTIONS = [
        { id: 'default', label: 'Street Map' }
    ];
    if (mapboxHybridLayer) {
        BASEMAP_OPTIONS.push({ id: 'mapboxHybrid', label: 'Mapbox Hybrid' });
    }

    // Add default layer
    osmLayer.addTo(map);

    // Single top-right toolbar: zoom + drawing/measure/uploads (drawing.js).
    // Layer picker UI removed; overlay registration still uses a hidden panel node.
    const MapToolbarBundleControl = L.Control.extend({
        onAdd: function (mapInstance) {
            const bundle = L.DomUtil.create('div', 'map-toolbar-bundle leaflet-control');

            const accountWrap = L.DomUtil.create('div', 'map-toolbar-account-wrap', bundle);
            accountWrap.id = 'mapToolbarAccountWrap';
            const existingAccount = document.querySelector('.profile-menu-button-wrap');
            if (existingAccount) {
                accountWrap.appendChild(existingAccount);
                const menuBtn = existingAccount.querySelector('#profileMenuButton');
                if (menuBtn) {
                    menuBtn.classList.add('map-toolbar-btn');
                    menuBtn.setAttribute('data-map-tool-label', 'Menu');
                }
            }

            const zoomWrap = L.DomUtil.create('div', 'map-toolbar-zoom-wrap', bundle);
            const zoomIn = L.DomUtil.create('button', 'map-toolbar-btn map-toolbar-zoom-btn', zoomWrap);
            zoomIn.type = 'button';
            zoomIn.id = 'mapZoomInBtn';
            zoomIn.title = window.t ? window.t('Zoom in') : 'Zoom in';
            zoomIn.setAttribute('aria-label', zoomIn.title);
            zoomIn.setAttribute('data-map-tool-label', window.t ? window.t('Zoom in') : 'Zoom in');
            zoomIn.textContent = '+';
            const zoomOut = L.DomUtil.create('button', 'map-toolbar-btn map-toolbar-zoom-btn', zoomWrap);
            zoomOut.type = 'button';
            zoomOut.id = 'mapZoomOutBtn';
            zoomOut.title = window.t ? window.t('Zoom out') : 'Zoom out';
            zoomOut.setAttribute('aria-label', zoomOut.title);
            zoomOut.setAttribute('data-map-tool-label', window.t ? window.t('Zoom out') : 'Zoom out');
            zoomOut.textContent = '−';
            L.DomEvent.on(zoomIn, 'click', function (e) {
                L.DomEvent.stop(e);
                mapInstance.zoomIn();
            });
            L.DomEvent.on(zoomOut, 'click', function (e) {
                L.DomEvent.stop(e);
                mapInstance.zoomOut();
            });

            const hiddenPanel = L.DomUtil.create('div', 'leaflet-layer-panel');
            hiddenPanel.hidden = true;
            hiddenPanel.style.display = 'none';
            window.basemapLayerRadios = {};
            window.layerControlPanel = hiddenPanel;
            window.layerControlPanelContainer = hiddenPanel;

            window.mapToolbarBundleEl = bundle;
            L.DomEvent.disableClickPropagation(bundle);
            return bundle;
        },
    });
    new MapToolbarBundleControl({ position: 'topright' }).addTo(map);

    // Fix Leaflet marker icons
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
        iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
    });
    
    // Export map globally
    window.map = map;

    /** Bottom-right attribution: org title (settings.topBarTitle); layer © credits follow after the separator */
    function escapeAttributionHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function updateMapOrgAttributionTitle(displayTitle) {
        if (!map || !map.attributionControl) return;
        var t =
            displayTitle != null && String(displayTitle).trim() !== '' ? String(displayTitle) : 'Locus';
        map.attributionControl.setPrefix(
            '<span class="map-org-attribution-title">' + escapeAttributionHtml(t) + '</span>'
        );
    }
    window.updateMapOrgAttributionTitle = updateMapOrgAttributionTitle;
    updateMapOrgAttributionTitle('Locus');

    // --- Debug: map zoom (local testing only; enable with window.ENABLE_MAP_ZOOM_DEBUG = true) ---
    if (window.ENABLE_MAP_ZOOM_DEBUG === true) {
        const zoomDebugCtrl = L.control({ position: 'bottomleft' });
        zoomDebugCtrl.onAdd = function () {
            const div = L.DomUtil.create('div', 'map-zoom-debug');
            div.style.cssText =
                'padding:4px 8px;background:rgba(0,0,0,0.7);color:var(--app-text-primary);font:12px ui-monospace,monospace;border-radius:4px;pointer-events:none;';
            div.textContent = 'Zoom: ' + map.getZoom();
            window._mapZoomDebugEl = div;
            return div;
        };
        zoomDebugCtrl.addTo(map);

        function syncMapZoomDebug() {
            const z = map.getZoom();
            const label = Number.isInteger(z) ? String(z) : z.toFixed(2);
            if (window._mapZoomDebugEl) {
                window._mapZoomDebugEl.textContent = 'Zoom: ' + label;
            }
            console.log('[map zoom]', label);
        }

        map.on('zoomend', syncMapZoomDebug);
        syncMapZoomDebug();
    }

    if (
        window.mapCountyCoverageModule &&
        typeof window.mapCountyCoverageModule.bindViewportTracking === 'function'
    ) {
        window.mapCountyCoverageModule.bindViewportTracking(map);
    }

    applyLeafletPerformancePreferences();
    initMapZoomHotkeys(map);
}

function shouldMapZoomHotkeysApply() {
    if (!window.map) return false;
    const el = document.activeElement;
    if (
        el &&
        (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT' ||
            el.isContentEditable)
    ) {
        return false;
    }
    if (window.drawingModule && window.drawingModule.currentDrawingMode) return false;
    if (window.measureModule && window.measureModule.measureMode) return false;
    if (window.mapQueryPolygonDrawing) return false;
    const photoModal = document.getElementById('photoViewerModal');
    if (photoModal && photoModal.classList.contains('show')) return false;
    if (document.querySelector('.guided-tour-root--active')) return false;
    return true;
}

function initMapZoomHotkeys(map) {
    document.addEventListener(
        'keydown',
        function (e) {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (!shouldMapZoomHotkeysApply()) return;
            const mapInstance = window.map || map;
            if (!mapInstance) return;
            const anim = getMapSetViewAnimationOptions();
            if (e.key === 'r' || e.key === 'R') {
                e.preventDefault();
                e.stopPropagation();
                const z = window.defaultZoom ?? window.MAP_CONFIG?.defaultZoom ?? 12;
                mapInstance.setZoom(z, anim);
            } else if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                e.stopPropagation();
                mapInstance.zoomIn(1, anim);
            } else if (e.key === '-') {
                e.preventDefault();
                e.stopPropagation();
                mapInstance.zoomOut(1, anim);
            }
        },
        true
    );
}

/**
 * Switch the active basemap by id (see BASEMAP_OPTIONS / window.mapLayers).
 * @param {string} basemapId
 */
function applyBasemap(basemapId) {
    const mapInstance = window.map;
    const layers = window.mapLayers;
    if (!mapInstance || !layers) return;

    const id = basemapId && layers[basemapId] ? basemapId : 'default';
    const newLayer = layers[id];
    if (!newLayer) return;

    Object.keys(layers).forEach(function (key) {
        const layer = layers[key];
        if (layer && mapInstance.hasLayer(layer)) {
            mapInstance.removeLayer(layer);
        }
    });

    newLayer.addTo(mapInstance);
    window.currentMapLayer = newLayer;

    const radios = window.basemapLayerRadios;
    if (radios) {
        Object.keys(radios).forEach(function (rid) {
            const radio = radios[rid];
            if (radio) radio.checked = rid === id;
        });
    }
}

/**
 * Options for setView / flyTo-style moves; respects profile "Enable map animations"
 * (default on when `window.enableAnimations` is undefined).
 * @param {number} [duration=0.5] duration when animations are on
 * @param {object} [extra] merged after base options
 */
function getMapSetViewAnimationOptions(duration, extra) {
    const animOn = window.enableAnimations !== false;
    const d = duration != null ? duration : 0.5;
    const base = animOn ? { animate: true, duration: d } : { animate: false };
    return Object.assign(base, extra || {});
}

/**
 * Apply tile fade / zoom animation / marker animation flags to the live map. Call after
 * `window.enableAnimations` changes. Improves panning when new tiles load (no fade) if disabled.
 */
function applyLeafletPerformancePreferences() {
    const m = window.map;
    if (!m || !m.options) return;
    const enable = window.enableAnimations !== false;
    m.options.zoomAnimation = enable;
    m.options.fadeAnimation = enable;
    m.options.markerZoomAnimation = enable;
}

// Export map and initMap globally
window.initMap = initMap;
window.applyBasemap = applyBasemap;
window.getMapSetViewAnimationOptions = getMapSetViewAnimationOptions;
window.applyLeafletPerformancePreferences = applyLeafletPerformancePreferences;

