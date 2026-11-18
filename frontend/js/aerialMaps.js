// Aerial maps module
/** Orthophoto tiles are not shown until map zoom >= this. */
const AERIAL_MIN_RENDER_ZOOM = 16;
let aerialFlyToSeq = 0;
let aerialFlyInProgressUntil = 0;
const AERIAL_FLY_GUARD_MS = 800;

function markAerialFlyInProgress(durationMs) {
    aerialFlyInProgressUntil = Date.now() + (durationMs != null ? durationMs : AERIAL_FLY_GUARD_MS);
}

function isAerialFlyInProgress() {
    return Date.now() < aerialFlyInProgressUntil;
}

/** Leaflet fit padding — modest insets; mobile reserves top launcher + bottom map tools. */
function getAerialFlyPadding() {
    const side = 50;
    let top = 50;
    let bottom = 50;
    const isMobile =
        typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
    if (isMobile) {
        top = 56;
        bottom = 108;
    }
    return {
        paddingTopLeft: L.point(side, top),
        paddingBottomRight: L.point(side, bottom),
    };
}

/**
 * Same center/zoom Leaflet fitBounds would use; clamp to tile render level when needed.
 * @returns {{ center: L.LatLng, zoom: number }}
 */
function resolveAerialFlyView(map, bounds, pad) {
    const fitOpts = {
        paddingTopLeft: pad.paddingTopLeft,
        paddingBottomRight: pad.paddingBottomRight,
    };
    let target = null;
    try {
        if (typeof map._getBoundsCenterZoom === 'function') {
            target = map._getBoundsCenterZoom(bounds, fitOpts);
        }
    } catch (_e) {
        /* ignore */
    }
    if (target && target.center && Number.isFinite(target.zoom) && target.zoom >= AERIAL_MIN_RENDER_ZOOM) {
        return { center: target.center, zoom: target.zoom };
    }
    return { center: bounds.getCenter(), zoom: AERIAL_MIN_RENDER_ZOOM };
}

function applyAerialFlyView(map, bounds, pad, panAnim) {
    const view = resolveAerialFlyView(map, bounds, pad);
    const durationMs =
        panAnim && panAnim.animate && panAnim.duration ? Math.round(Number(panAnim.duration) * 1000) + 200 : 0;
    if (durationMs > 0) markAerialFlyInProgress(durationMs);
    map.setView(view.center, view.zoom, panAnim);
}

/**
 * Smoothly fly to an aerial footprint: fit bounds when that keeps zoom >= tile render level,
 * otherwise center on the footprint at {@link AERIAL_MIN_RENDER_ZOOM}.
 * @param {L.LatLngBounds|null} bounds
 * @param {{ center?: L.LatLng }} [options]
 * @returns {boolean}
 */
function fitMapToAerialFootprint(bounds, options) {
    const map = window.map;
    if (!map) return false;

    const opts = options || {};
    const panAnim =
        typeof window.getMapSetViewAnimationOptions === 'function'
            ? window.getMapSetViewAnimationOptions(0.5)
            : { animate: true, duration: 0.5 };
    const flySeq = ++aerialFlyToSeq;

    const hasBounds = bounds && typeof bounds.isValid === 'function' && bounds.isValid();
    if (!hasBounds) {
        const center = opts.center;
        if (!center) return false;
        map.stop();
        markAerialFlyInProgress();
        map.setView(center, AERIAL_MIN_RENDER_ZOOM, panAnim);
        return true;
    }

    const runFly = () => {
        if (flySeq !== aerialFlyToSeq) return;
        if (typeof map.invalidateSize === 'function') {
            map.invalidateSize({ animate: false });
        }
        const pad = getAerialFlyPadding();
        map.stop();
        applyAerialFlyView(map, bounds, pad, panAnim);
    };

    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
        requestAnimationFrame(runFly);
        return true;
    }

    runFly();
    return true;
}

let savedAerialMaps = [];
let aerialMapLayers = new Map(); // Store Leaflet layers for each aerial map

/** Transparent 1px PNG — used for skipped tiles (no network fetch). */
const AERIAL_TRANSPARENT_TILE =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** @type {Map<string, Set<string>>} mapId -> loaded tile keys "z:x:y" */
const loadedAerialTilesByMapId = new Map();
/** @type {Array<{id}>} newest-first overlap stack for per-tile skip logic */
let aerialOverlapStack = [];
let aerialCoverageRefreshTimer = null;

function aerialTileKey(z, x, y) {
    return `${z}:${x}:${y}`;
}

function getLoadedAerialTileSet(mapId) {
    const key = normalizeAerialMapId(mapId);
    if (!loadedAerialTilesByMapId.has(key)) {
        loadedAerialTilesByMapId.set(key, new Set());
    }
    return loadedAerialTilesByMapId.get(key);
}

function hasMooreCoverage(mapId, z, x, y) {
    const tiles = loadedAerialTilesByMapId.get(normalizeAerialMapId(mapId));
    if (!tiles || tiles.size === 0) return false;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (!tiles.has(aerialTileKey(z, x + dx, y + dy))) return false;
        }
    }
    return true;
}

function isTileCoveredByNewer(mapId, z, x, y) {
    const myId = normalizeAerialMapId(mapId);
    const myIdx = aerialOverlapStack.findIndex((m) => normalizeAerialMapId(m.id) === myId);
    if (myIdx <= 0) return false;
    for (let i = 0; i < myIdx; i++) {
        const newerId = normalizeAerialMapId(aerialOverlapStack[i].id);
        if (hasMooreCoverage(newerId, z, x, y)) return true;
    }
    return false;
}

function markAerialTileLoaded(mapId, z, x, y) {
    getLoadedAerialTileSet(mapId).add(aerialTileKey(z, x, y));
    scheduleOlderAerialLayerRefresh(mapId);
}

function pruneAerialTileCoverage(mapId) {
    loadedAerialTilesByMapId.delete(normalizeAerialMapId(mapId));
}

function clearAerialTileCoverage() {
    loadedAerialTilesByMapId.clear();
    aerialOverlapStack = [];
}

function setAerialOverlapStack(mapsNewestFirst) {
    aerialOverlapStack = Array.isArray(mapsNewestFirst) ? mapsNewestFirst.slice() : [];
}

function clearAerialOverlapStack() {
    aerialOverlapStack = [];
}

function scheduleOlderAerialLayerRefresh(sourceMapId) {
    if (aerialCoverageRefreshTimer != null) return;
    aerialCoverageRefreshTimer = setTimeout(() => {
        aerialCoverageRefreshTimer = null;
        refreshOlderAerialLayers(sourceMapId);
    }, 50);
}

function refreshOlderAerialLayers(sourceMapId) {
    const srcId = normalizeAerialMapId(sourceMapId);
    let startIdx = aerialOverlapStack.findIndex((m) => normalizeAerialMapId(m.id) === srcId);
    if (startIdx < 0) startIdx = -1;
    const map = window.map;
    if (!map) return;
    for (let i = startIdx + 1; i < aerialOverlapStack.length; i++) {
        const olderId = normalizeAerialMapId(aerialOverlapStack[i].id);
        const layer = aerialMapLayers.get(olderId);
        if (layer && layer.options && layer.options.skipWhenCovered && map.hasLayer(layer)) {
            if (typeof layer.redraw === 'function') {
                layer.redraw();
            }
        }
    }
}

function isAerialTileLoadSuccess(layer, tile) {
    if (!tile || !tile.src) return false;
    const errUrl = layer.options && layer.options.errorTileUrl;
    if (errUrl && tile.src === errUrl) return false;
    if (tile.naturalWidth === 0 || tile.naturalHeight === 0) return false;
    return true;
}

const AerialCoverageTileLayer = L.TileLayer.extend({
    createTile: function (coords, done) {
        const mapId = this.options.aerialMapId;
        if (
            this.options.skipWhenCovered &&
            mapId &&
            isTileCoveredByNewer(mapId, coords.z, coords.x, coords.y)
        ) {
            const tile = document.createElement('img');
            tile.src = AERIAL_TRANSPARENT_TILE;
            tile.className = 'leaflet-tile aerial-coverage-skipped';
            requestAnimationFrame(() => done(null, tile));
            return tile;
        }
        return L.TileLayer.prototype.createTile.call(this, coords, done);
    },
    _tileReady: function (err, tile, coords) {
        if (!err && tile && this.options.aerialMapId && isAerialTileLoadSuccess(this, tile)) {
            markAerialTileLoaded(this.options.aerialMapId, coords.z, coords.x, coords.y);
        }
        L.TileLayer.prototype._tileReady.call(this, err, tile, coords);
    },
});

function normalizeAerialMapId(mapId) {
    return mapId != null ? String(mapId) : '';
}
/** Master toggle: hide all loaded drone/orthophoto layers (layer manager “Drone Maps” checkbox). */
let droneMapsOverlayEnabled = true;
/** User wants this aerial on the map when zoom allows (layer may be off-map when zoom < AERIAL_MIN_RENDER_ZOOM). */
const aerialLayerDesiredOnMap = new Map();

let aerialLayersZoomListenerBound = false;

function ensureAerialLayersZoomListener() {
    const map = window.map;
    if (!map || aerialLayersZoomListenerBound) return;
    aerialLayersZoomListenerBound = true;
    map.on('zoomend', syncAerialLayersForZoom);
}

/**
 * Orthophoto overlays must be removed below min zoom (Leaflet minZoom alone does not always match
 * when layers are added/removed programmatically). Re-applies when zoom is high enough and the user still wants the layer.
 */
function syncAerialLayersForZoom() {
    const map = window.map;
    if (!map) return;

    const z = map.getZoom();
    if (z < AERIAL_MIN_RENDER_ZOOM) {
        aerialMapLayers.forEach((layer) => {
            if (map.hasLayer(layer)) map.removeLayer(layer);
        });
        return;
    }

    if (!droneMapsOverlayEnabled) {
        aerialMapLayers.forEach((layer) => {
            if (map.hasLayer(layer)) map.removeLayer(layer);
        });
        return;
    }

    aerialMapLayers.forEach((layer, mapId) => {
        const want = aerialLayerDesiredOnMap.get(mapId) !== false;
        if (want) {
            if (!map.hasLayer(layer)) map.addLayer(layer);
        } else if (map.hasLayer(layer)) {
            map.removeLayer(layer);
        }
    });
}

function setAerialLayerDesiredOnMap(mapId, want) {
    const key = normalizeAerialMapId(mapId);
    if (!key) return;
    aerialLayerDesiredOnMap.set(key, !!want);
    ensureAerialLayersZoomListener();
    syncAerialLayersForZoom();
}

/** When catalog row has no stored native zoom (legacy rows), use a wide conservative range. */
const AERIAL_TMS_FALLBACK_MIN_ZOOM =
    (window.mapAerialTileLayer && window.mapAerialTileLayer.AERIAL_TMS_FALLBACK_MIN_ZOOM) || 5;
const AERIAL_TMS_FALLBACK_MAX_ZOOM =
    (window.mapAerialTileLayer && window.mapAerialTileLayer.AERIAL_TMS_FALLBACK_MAX_ZOOM) || 22;

/** Native TMS zoom from API/DB fields (parsed once when the map was added to the catalog). */
function nativeZoomFromAerialMap(aerialMap) {
    if (window.mapAerialTileLayer && typeof window.mapAerialTileLayer.nativeZoomFromAerialMap === 'function') {
        return window.mapAerialTileLayer.nativeZoomFromAerialMap(aerialMap);
    }
    const minZ = aerialMap && aerialMap.minNativeZoom != null ? Number(aerialMap.minNativeZoom) : NaN;
    const maxZ = aerialMap && aerialMap.maxNativeZoom != null ? Number(aerialMap.maxNativeZoom) : NaN;
    if (Number.isFinite(minZ) && Number.isFinite(maxZ)) {
        return { minNativeZoom: Math.min(minZ, maxZ), maxNativeZoom: Math.max(minZ, maxZ) };
    }
    return { minNativeZoom: AERIAL_TMS_FALLBACK_MIN_ZOOM, maxNativeZoom: AERIAL_TMS_FALLBACK_MAX_ZOOM };
}

// Get current org from org selector (avoid naming getCurrentOrgId to prevent recursion with global)
function getSelectedOrgIdForAerialMaps() {
    if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
        return window.orgSelectorModule.getCurrentOrgId() || null;
    }
    if (window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        return user.organizationId || null;
    }
    return null;
}

function getSubscriptionTierForSelectedOrg() {
    const orgId = getSelectedOrgIdForAerialMaps();
    const orgs = (window.orgSelectorModule && window.orgSelectorModule.getOrganizations()) || [];
    const org = orgs.find((o) => o.id === orgId);
    const raw = org && org.settings && org.settings.subscriptionTier;
    const t = raw ? String(raw).toLowerCase() : 'basic';
    if (t === 'plus' || t === 'max' || t === 'enhanced') return 'enhanced';
    return 'basic';
}

function notifyPanelFavoriteIdsFromSavedMaps() {
    const maps = savedAerialMaps;
    if (window.aerialMapPanelModule && typeof window.aerialMapPanelModule.setFavoriteIdsFromSavedMaps === 'function') {
        window.aerialMapPanelModule.setFavoriteIdsFromSavedMaps(maps);
    }
}

/** Clear client cache after org change (no GET); Time Warp stars sync on next `loadSavedAerialMaps`. */
function clearSavedAerialMapsCache() {
    savedAerialMaps.length = 0;
    notifyPanelFavoriteIdsFromSavedMaps();
}

// Load favorited aerial maps for Manage Data. Always request from API; server returns [] for Basic tier.
// (Do not gate on client subscriptionTier — org settings in the selector can be stale vs the server.)
async function loadSavedAerialMaps() {
    const orgId = getSelectedOrgIdForAerialMaps();
    if (!orgId) {
        savedAerialMaps.length = 0;
        notifyPanelFavoriteIdsFromSavedMaps();
        return savedAerialMaps;
    }
    try {
        savedAerialMaps.length = 0;
        const res = await window.authModule.apiRequest(`/api/data/aerial-favorites?organizationId=${orgId}`);
        const maps = res && res.maps ? res.maps : [];
        if (Array.isArray(maps)) savedAerialMaps.push(...maps);
        notifyPanelFavoriteIdsFromSavedMaps();
        return savedAerialMaps;
    } catch (error) {
        console.error('Error loading aerial map favorites:', error);
        savedAerialMaps.length = 0;
        notifyPanelFavoriteIdsFromSavedMaps();
    }
    return savedAerialMaps;
}

const AERIAL_ACCESSIBLE_MAX_BBOX_MILES = 5;
const AERIAL_ACCESSIBLE_PAGE_SIZE = 20;
const METERS_PER_MILE = 1609.344;

let accessibleAerialMaps = [];
let accessibleAerialSearchBbox = null;
let accessibleAerialPagination = { page: 1, total: 0, totalPages: 0, pageSize: AERIAL_ACCESSIBLE_PAGE_SIZE };
let accessibleAerialBboxPreviewLayer = null;
let accessibleAerialBboxDrawActive = false;

function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function bboxFromLatLngPair(a, b) {
    const minLat = Math.min(a.lat, b.lat);
    const maxLat = Math.max(a.lat, b.lat);
    const minLng = Math.min(a.lng, b.lng);
    const maxLng = Math.max(a.lng, b.lng);
    return { minLng, minLat, maxLng, maxLat };
}

function validateAccessibleBboxClient(bbox) {
    if (!bbox || bbox.minLng >= bbox.maxLng || bbox.minLat >= bbox.maxLat) {
        return { ok: false, message: 'Draw a valid search rectangle on the map.' };
    }
    const maxM = AERIAL_ACCESSIBLE_MAX_BBOX_MILES * METERS_PER_MILE;
    const ns = haversineMeters(bbox.minLat, bbox.minLng, bbox.maxLat, bbox.minLng);
    const ew = haversineMeters(bbox.minLat, bbox.minLng, bbox.minLat, bbox.maxLng);
    if (ns > maxM || ew > maxM) {
        return {
            ok: false,
            message: `Search area cannot exceed ${AERIAL_ACCESSIBLE_MAX_BBOX_MILES} miles north–south or east–west.`,
        };
    }
    return { ok: true };
}

function bboxToQueryString(bbox) {
    return [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat].map((n) => String(n)).join(',');
}

function clearAccessibleAerialBboxPreview() {
    const map = window.map;
    if (accessibleAerialBboxPreviewLayer && map) {
        map.removeLayer(accessibleAerialBboxPreviewLayer);
    }
    accessibleAerialBboxPreviewLayer = null;
}

function showAccessibleAerialBboxPreview(bbox) {
    const map = window.map;
    if (!map || !bbox) return;
    clearAccessibleAerialBboxPreview();
    const bounds = L.latLngBounds([
        [bbox.minLat, bbox.minLng],
        [bbox.maxLat, bbox.maxLng],
    ]);
    accessibleAerialBboxPreviewLayer = L.rectangle(bounds, {
        color: 'var(--app-accent)',
        weight: 2,
        fillColor: 'var(--app-accent)',
        fillOpacity: 0.12,
        dashArray: '6, 4',
    }).addTo(map);
}

function getAccessibleAerialStatusText() {
    if (!accessibleAerialSearchBbox) {
        return `Draw a search rectangle on the map (max ${AERIAL_ACCESSIBLE_MAX_BBOX_MILES}×${AERIAL_ACCESSIBLE_MAX_BBOX_MILES} miles).`;
    }
    const total = accessibleAerialPagination?.total ?? 0;
    return `Showing ${total} accessible aerial map${total === 1 ? '' : 's'} in search area.`;
}

function syncAccessibleAerialToolbar() {
    const bar = document.getElementById('dataAerialBboxToolbar');
    const status = document.getElementById('dataAerialBboxStatus');
    const drawBtn = document.getElementById('dataAerialBboxDrawBtn');
    const clearBtn = document.getElementById('dataAerialBboxClearBtn');
    const view = window.dataWindowModule?.currentDataView;
    const dataWindow = document.getElementById('dataWindow');
    const dataWindowOpen = !!dataWindow?.classList.contains('show');
    const showAerialContext = view === 'aerialmaps' && dataWindowOpen;
    const hasBbox = !!accessibleAerialSearchBbox;

    if (bar) {
        bar.style.display = showAerialContext ? 'flex' : 'none';
    }
    if (status) {
        status.textContent = getAccessibleAerialStatusText();
    }
    if (drawBtn) {
        drawBtn.style.display = hasBbox ? 'none' : '';
    }
    if (clearBtn) {
        clearBtn.style.display = hasBbox ? '' : 'none';
    }

    if (showAerialContext && hasBbox) {
        showAccessibleAerialBboxPreview(accessibleAerialSearchBbox);
    } else {
        clearAccessibleAerialBboxPreview();
    }
}

function clearAccessibleAerialCatalog() {
    accessibleAerialMaps.length = 0;
    accessibleAerialSearchBbox = null;
    accessibleAerialPagination = { page: 1, total: 0, totalPages: 0, pageSize: AERIAL_ACCESSIBLE_PAGE_SIZE };
    clearAccessibleAerialBboxPreview();
    syncAccessibleAerialToolbar();
}

async function loadAccessibleAerialMaps(opts = {}) {
    const orgId = getSelectedOrgIdForAerialMaps();
    const bbox = opts.bbox || accessibleAerialSearchBbox;
    const page = opts.page != null ? Number(opts.page) : accessibleAerialPagination.page || 1;
    if (!orgId) {
        clearAccessibleAerialCatalog();
        return accessibleAerialMaps;
    }
    if (!bbox) {
        accessibleAerialMaps.length = 0;
        accessibleAerialPagination = { page: 1, total: 0, totalPages: 0, pageSize: AERIAL_ACCESSIBLE_PAGE_SIZE };
        syncAccessibleAerialToolbar();
        return accessibleAerialMaps;
    }
    const check = validateAccessibleBboxClient(bbox);
    if (!check.ok) {
        if (window.appAlert) void appAlert(check.message);
        return accessibleAerialMaps;
    }
    try {
        const params = new URLSearchParams({
            organizationId: String(orgId),
            bbox: bboxToQueryString(bbox),
            page: String(Math.max(1, page)),
            pageSize: String(AERIAL_ACCESSIBLE_PAGE_SIZE),
        });
        const res = await window.authModule.apiRequest(`/api/data/aerial-maps/accessible?${params.toString()}`);
        accessibleAerialMaps.length = 0;
        if (res && Array.isArray(res.maps)) accessibleAerialMaps.push(...res.maps);
        accessibleAerialSearchBbox = res && res.bbox ? res.bbox : bbox;
        accessibleAerialPagination = {
            page: res?.page || page,
            total: res?.total ?? 0,
            totalPages: res?.totalPages ?? 0,
            pageSize: res?.pageSize || AERIAL_ACCESSIBLE_PAGE_SIZE,
        };
        showAccessibleAerialBboxPreview(accessibleAerialSearchBbox);
        syncAccessibleAerialToolbar();
        if (window.syncDataFilterContextBanner) window.syncDataFilterContextBanner();
        return accessibleAerialMaps;
    } catch (error) {
        console.error('Error loading accessible aerial maps:', error);
        accessibleAerialMaps.length = 0;
        if (window.appAlert) void appAlert(error.message || 'Failed to load aerial maps');
        return accessibleAerialMaps;
    }
}

async function setAccessibleCatalogPage(page) {
    const next = Math.max(1, Number(page) || 1);
    if (!accessibleAerialSearchBbox) return;
    await loadAccessibleAerialMaps({ page: next });
    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
    if (window.dataHubPaginationModule?.scrollDataHubListToTop) {
        window.dataHubPaginationModule.scrollDataHubListToTop();
    }
}

function findAerialMapById(mapId) {
    const id = typeof mapId === 'string' ? parseInt(mapId, 10) : mapId;
    const fromCatalog = accessibleAerialMaps.find((m) => m.id === id || String(m.id) === String(mapId));
    if (fromCatalog) return fromCatalog;
    return savedAerialMaps.find((m) => m.id === id || String(m.id) === String(mapId)) || null;
}

function startAccessibleAerialBboxDraw(wasDataWindowOpen) {
    const map = window.map;
    if (!map || accessibleAerialBboxDrawActive) return;

    if (window.measureModule?.cancelMeasureMode) window.measureModule.cancelMeasureMode();
    if (window.photosModule?.cancelPhotoUpload) window.photosModule.cancelPhotoUpload();
    if (window.drawingModule?.cancelDrawingMode) window.drawingModule.cancelDrawingMode();

    let cornerA = null;
    const drawLayer = L.layerGroup().addTo(map);
    accessibleAerialBboxDrawActive = true;
    map.getContainer().style.cursor = 'crosshair';

    function cleanup() {
        map.off('click', clickHandler);
        window.removeEventListener('keydown', cancelHandler);
        map.removeLayer(drawLayer);
        map.getContainer().style.cursor = '';
        accessibleAerialBboxDrawActive = false;
    }

    async function finishWithCorners(a, b) {
        cleanup();
        const bbox = bboxFromLatLngPair(a, b);
        const check = validateAccessibleBboxClient(bbox);
        if (!check.ok) {
            if (window.appAlert) await appAlert(check.message);
            if (wasDataWindowOpen && window.openDataWindow) window.openDataWindow('aerialmaps');
            return;
        }
        accessibleAerialSearchBbox = bbox;
        showAccessibleAerialBboxPreview(bbox);
        syncAccessibleAerialToolbar();
        if (window.dataWindowModule?.setDataHubBusy) {
            window.dataWindowModule.setDataHubBusy(true, 'Loading aerial maps…');
        }
        try {
            await loadAccessibleAerialMaps({ bbox, page: 1 });
            if (window.dataTableRendererModule?.renderDataTable) {
                window.dataTableRendererModule.renderDataTable();
            }
        } finally {
            if (window.dataWindowModule?.setDataHubBusy) {
                window.dataWindowModule.setDataHubBusy(false);
            }
        }
        if (wasDataWindowOpen && window.openDataWindow) {
            setTimeout(() => window.openDataWindow('aerialmaps'), 100);
        }
    }

    function clickHandler(e) {
        L.DomEvent.stopPropagation(e);
        if (!cornerA) {
            cornerA = e.latlng;
            L.marker(cornerA, {
                icon: L.divIcon({
                    className: 'query-marker',
                    html: '<div style="background:var(--app-accent);width:12px;height:12px;border-radius:50%;border:2px solid #fff;"></div>',
                    iconSize: [12, 12],
                    iconAnchor: [6, 6],
                }),
            }).addTo(drawLayer);
            return;
        }
        const rect = L.rectangle(L.latLngBounds(cornerA, e.latlng), {
            color: 'var(--app-accent)',
            weight: 2,
            fillOpacity: 0.15,
        });
        drawLayer.addLayer(rect);
        void finishWithCorners(cornerA, e.latlng);
    }

    function cancelHandler(e) {
        if (e.key !== 'Escape') return;
        cleanup();
        if (wasDataWindowOpen && window.openDataWindow) window.openDataWindow('aerialmaps');
    }

    if (window.closeDataWindow) window.closeDataWindow();
    map.on('click', clickHandler);
    window.addEventListener('keydown', cancelHandler);
}

function clearAccessibleAerialSearchArea() {
    clearAccessibleAerialCatalog();
    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
    if (window.syncDataFilterContextBanner) window.syncDataFilterContextBanner();
}

// Add new aerial map
async function addAerialMap(url, organizationId) {
    try {
        const body = { url };
        if (organizationId) {
            body.organizationId = organizationId;
        }
        
        const newMap = await window.authModule.apiRequest('/api/data/aerial-maps', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        
        // Normalize the response to match GET endpoint format
        const normalizedMap = {
            id: newMap.id,
            name: newMap.name,
            url: newMap.url,
            boundingBox: newMap.boundingBox,
            minNativeZoom: newMap.minNativeZoom,
            maxNativeZoom: newMap.maxNativeZoom,
            createdAt: newMap.createdAt || newMap.created_at,
            addedBy: newMap.addedBy || window.authModule.getCurrentUser()?.username
        };
        
        return normalizedMap;
    } catch (error) {
        console.error('Error adding aerial map:', error);
        throw error;
    }
}

// Delete aerial map
async function deleteAerialMap(mapId) {
    try {
        await window.authModule.apiRequest(`/api/data/aerial-maps/${mapId}`, {
            method: 'DELETE'
        });
        
        // Remove from map if loaded
        removeAerialMapFromMap(mapId);
        // Update array in place
        const index = savedAerialMaps.findIndex(map => map.id === mapId);
        if (index >= 0) {
            savedAerialMaps.splice(index, 1);
        }
        notifyPanelFavoriteIdsFromSavedMaps();
        return true;
    } catch (error) {
        console.error('Error deleting aerial map:', error);
        throw error;
    }
}

// Load aerial map on the map using Tileset (TMS)
// options.skipFitBounds: do not fly map to footprint (batch / panel loads)
// options.silent: no duplicate-layer alert
// options.skipWhenCovered: skip tile fetches where a newer orthophoto has full 3x3 coverage
async function loadAerialMapOnMap(aerialMap, options = {}) {
    if (!window.map) {
        console.error('Map not initialized');
        return;
    }
    
    const mapId = normalizeAerialMapId(aerialMap.id);
    if (!mapId) return;

    const skipWhenCovered = !!options.skipWhenCovered;

    // Check if already loaded
    if (aerialMapLayers.has(mapId)) {
        const existingLayer = aerialMapLayers.get(mapId);
        if (existingLayer.options) {
            const prevSkip = !!existingLayer.options.skipWhenCovered;
            existingLayer.options.skipWhenCovered = skipWhenCovered;
            if (prevSkip !== skipWhenCovered && window.map.hasLayer(existingLayer) && typeof existingLayer.redraw === 'function') {
                existingLayer.redraw();
            }
        }
        aerialLayerDesiredOnMap.set(mapId, true);
        ensureAerialLayersZoomListener();
        if (window.map.hasLayer(existingLayer)) {
            if (!options.silent) void appAlert('Aerial map is already loaded on the map');
            return;
        }
        syncAerialLayersForZoom();
        return;
    }
    
    try {
        if (!aerialMap.url.includes('tilemapresource.xml') && !aerialMap.url.includes('orthophoto_tiles')) {
            void appAlert(
                'Unsupported aerial map URL. Use a TMS tileset URL that includes tilemapresource.xml or orthophoto_tiles.'
            );
            return;
        }

        // Aerial tiles sit below ticket polygons (ticketPane 380) so locate boundaries stay visible on imagery.
        if (!window.map.getPane('aerialMapPane')) {
            const aerialMapPane = window.map.createPane('aerialMapPane');
            aerialMapPane.style.zIndex = '350';
        }

        const helper = window.mapAerialTileLayer;
        let layer;
        let tileBounds = null;
        if (helper && typeof helper.createAerialTileLayer === 'function') {
            const created = helper.createAerialTileLayer(aerialMap, {
                LayerClass: AerialCoverageTileLayer,
                layerOptions: {
                    skipWhenCovered: skipWhenCovered,
                    aerialMapId: mapId,
                },
            });
            if (!created) {
                void appAlert(
                    'Unsupported aerial map URL. Use a TMS tileset URL that includes tilemapresource.xml or orthophoto_tiles.'
                );
                return;
            }
            layer = created.layer;
            tileBounds = created.tileBounds;
        } else {
            const baseUrl = aerialMap.url.replace('/tilemapresource.xml', '');
            const tileUrlTemplate = `${baseUrl}/{z}/{x}/{y}.png`;
            const { minNativeZoom, maxNativeZoom } = nativeZoomFromAerialMap(aerialMap);
            if (aerialMap.boundingBox && aerialMap.boundingBox.coordinates) {
                const coords = aerialMap.boundingBox.coordinates[0];
                tileBounds = L.latLngBounds(coords.map((coord) => [coord[1], coord[0]]));
            }
            const layerOptions = {
                attribution: '',
                tms: true,
                minNativeZoom,
                maxNativeZoom,
                minZoom: Math.max(AERIAL_MIN_RENDER_ZOOM, minNativeZoom),
                maxZoom: 24,
                opacity: 1.0,
                className: 'aerial-map-tile-layer',
                pane: 'aerialMapPane',
                errorTileUrl:
                    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                bounds: tileBounds,
                keepBuffer: 3,
                updateWhenIdle: true,
                updateWhenZooming: false,
                updateInterval: 200,
                fadeAnimation: false,
                zIndex: 100,
                aerialMapId: mapId,
                skipWhenCovered: skipWhenCovered,
            };
            layer = new AerialCoverageTileLayer(tileUrlTemplate, layerOptions);
        }

        aerialMapLayers.set(mapId, layer);
        aerialLayerDesiredOnMap.set(mapId, true);

        ensureAerialLayersZoomListener();
        syncAerialLayersForZoom();

        if (!options.skipFitBounds && tileBounds) {
            fitMapToAerialFootprint(tileBounds);
        }
        
        // Add CSS to prevent green tint (if not already added)
        if (helper && typeof helper.ensureAerialMapStyles === 'function') {
            helper.ensureAerialMapStyles();
        }
        if (!document.getElementById('aerial-map-styles')) {
            const style = document.createElement('style');
            style.id = 'aerial-map-styles';
            style.textContent = `
                .aerial-map-tile-layer img {
                    filter: none !important;
                    -webkit-filter: none !important;
                }
                .leaflet-tile-container img {
                    image-rendering: -webkit-optimize-contrast;
                    image-rendering: crisp-edges;
                }
            `;
            document.head.appendChild(style);
        }

        updateDroneMapsLayerControl();
    } catch (error) {
        console.error('Error loading aerial map on map:', error);
        void appAlert('Error loading aerial map: ' + error.message);
    }
}

// Clear all aerial map layers from map (e.g. when switching organization)
function clearAllAerialMapsFromMap() {
    if (!window.map) return;
    const mapIds = Array.from(aerialMapLayers.keys());
    mapIds.forEach(mapId => removeAerialMapFromMap(mapId));
    clearAerialTileCoverage();
}

// Remove aerial map from map
function removeAerialMapFromMap(mapId) {
    const key = normalizeAerialMapId(mapId);
    if (!key) return;
    aerialLayerDesiredOnMap.delete(key);
    pruneAerialTileCoverage(key);
    const layer = aerialMapLayers.get(key);
    if (layer && window.map) {
        window.map.removeLayer(layer);
        aerialMapLayers.delete(key);
    }
}

function setAerialMapOpacity(mapId, opacity) {
    const key = normalizeAerialMapId(mapId);
    if (!key) return;
    const layer = aerialMapLayers.get(key);
    if (layer && typeof layer.setOpacity === 'function') {
        layer.setOpacity(Math.min(1, Math.max(0, opacity)));
    }
}

// Toggle aerial map visibility
function toggleAerialMapVisibility(mapId) {
    const key = normalizeAerialMapId(mapId);
    if (!key) return;
    const layer = aerialMapLayers.get(key);
    if (!layer || !window.map) return;
    const wasWanted = aerialLayerDesiredOnMap.get(key) !== false;
    setAerialLayerDesiredOnMap(key, !wasWanted);
}

function setDroneMapsOverlayEnabled(on) {
    droneMapsOverlayEnabled = !!on;
    syncAerialLayersForZoom();
    if (window.mapOverlayTogglesModule) {
        window.mapOverlayTogglesModule.syncMapOverlayToggle('drone-maps', droneMapsOverlayEnabled);
    }
}

function getDroneMapsOverlayEnabled() {
    return droneMapsOverlayEnabled;
}

function zoomToLoadedDroneMapsBounds() {
    const map = window.map;
    if (!map || aerialMapLayers.size === 0) return;
    const b = L.latLngBounds();
    let any = false;
    aerialMapLayers.forEach((layer) => {
        if (!layer) return;
        if (typeof layer.getBounds === 'function') {
            try {
                const lb = layer.getBounds();
                if (lb && typeof lb.isValid === 'function' && lb.isValid()) {
                    b.extend(lb);
                    any = true;
                }
            } catch (_) {
                /* ignore */
            }
        } else if (layer.options && layer.options.bounds) {
            b.extend(layer.options.bounds);
            any = true;
        }
    });
    if (any) {
        map.fitBounds(b, { padding: [50, 50] });
    }
}

/**
 * Drone Maps toolbar overlay toggle (with Tickets, Photos).
 */
function updateDroneMapsLayerControl() {
    if (window.CORE_PRODUCT === true) return;
    const map = window.map;
    if (!map || !window.layerControlPanel || !window.mapOverlayTogglesModule) return;

    const toggles = window.mapOverlayTogglesModule;
    toggles.createMapOverlayToggle({
        id: 'drone-maps',
        label: 'Drone Maps',
        getActive: function () {
            return droneMapsOverlayEnabled;
        },
        onToggle: function (active) {
            setDroneMapsOverlayEnabled(active);
        },
    });
    toggles.syncMapOverlayToggle('drone-maps', droneMapsOverlayEnabled);
}

// Export
window.aerialMapsModule = {
    savedAerialMaps,
    accessibleAerialMaps,
    get accessibleAerialSearchBbox() {
        return accessibleAerialSearchBbox;
    },
    get accessibleAerialPagination() {
        return accessibleAerialPagination;
    },
    aerialMapLayers,
    loadSavedAerialMaps,
    loadAccessibleAerialMaps,
    setAccessibleCatalogPage,
    clearAccessibleAerialCatalog,
    clearAccessibleAerialSearchArea,
    startAccessibleAerialBboxDraw,
    syncAccessibleAerialToolbar,
    findAerialMapById,
    clearSavedAerialMapsCache,
    getSubscriptionTierForSelectedOrg,
    addAerialMap,
    deleteAerialMap,
    loadAerialMapOnMap,
    removeAerialMapFromMap,
    setAerialMapOpacity,
    clearAllAerialMapsFromMap,
    toggleAerialMapVisibility,
    setAerialLayerDesiredOnMap,
    setDroneMapsOverlayEnabled,
    getDroneMapsOverlayEnabled,
    updateDroneMapsLayerControl,
    zoomToLoadedDroneMapsBounds,
    fitMapToAerialFootprint,
    isAerialFlyInProgress,
    AERIAL_MIN_RENDER_ZOOM,
    setAerialOverlapStack,
    clearAerialOverlapStack,
    clearAerialTileCoverage,
};

