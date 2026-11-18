/**
 * Time Warp panel: public catalog org only (shown as "Public data").
 * Zoom-16 gate for filters and public map search. Orthophoto tiles render at zoom 16+ (see aerialMaps.js).
 */

let panelEl = null;
let panelBackdropEl = null;
let panelFabEl = null;
/** Last for-view fetch key (org + rounded map bounds); refetch when panning changes bounds. */
let lastAerialForViewKey = null;
/** Cached auto-load result for a padded viewport. Reused while the visible viewport stays inside it. */
let aerialForViewCachedResult = null;
let aerialForViewRequestSeq = 0;
let aerialForViewAbortController = null;
/** Throttle for-view when the list is still empty (avoid hammering the API on every zoomend). */
let aerialForViewEmptyCooldownUntil = 0;
const AERIAL_FOR_VIEW_EMPTY_COOLDOWN_MS = 12000;
/** In-memory for-view cache TTL; cleared on page reload. */
const AERIAL_FOR_VIEW_CACHE_TTL_MS = 5 * 60 * 1000;
const AERIAL_FOR_VIEW_PAD_RATIO = 0.25;
let aerialZoomListenerBound = false;
let mobilePanelOpen = false;
/** Desktop side panel intentionally open; resize must not force-show when false. */
let timeWarpPanelLayoutOpen = false;
let resizeBound = false;
let aerialPanelResizeObserverBound = false;
/** @type {Map<number, boolean>} */
const checkedById = new Map();
/** Fractional timeline position (0 … len-1); crossfades opacity between adjacent captures. */
let timelineIndex = 0;
let timelineApplySeq = 0;
/** @type {Array<{id:number}>} */
let panelMaps = [];
/** @type {Set<number>} */
let favoriteIds = new Set();
/** Bottom-of-map capture-date slider when 2+ orthophotos are loaded. */
let droneTimelineBarEl = null;
let droneTimelineBarBound = false;
/** Bottom-of-map public catalog search bar (Public Data org). */
let publicSearchBarEl = null;
/** False until the user moves the bottom slider; until then all loaded orthophotos stay visible. */
let droneTimelineUserEngaged = false;
/** Bottom timeline bar: expandable map list open state. */
let droneTimelineListOpen = false;

const TIME_WARP_MIN_ZOOM = 16;
/** @type {'all'|'24h'|'7d'|'30d'|'custom'} */
let twPreset = 'all';
let timeWarpMoveBound = false;
/** @type {number|undefined} */
let timeWarpMapMoveDebounceT;
const TIME_WARP_MAP_MOVE_MS = 1000;
/** @type {'aerial'|'photos'} */
let activeTimeWarpTab = 'aerial';

/**
 * Aerial/Time-Warp: Enhanced is entitled. Legacy plus/max values normalize to Enhanced.
 * @returns {'basic'|'enhanced'}
 */
function isPublicCatalogTimeWarpMode() {
    return (
        typeof window.isCurrentOrgPublicCatalogViewer === 'function' &&
        window.isCurrentOrgPublicCatalogViewer()
    );
}

/** Enhanced orgs auto-load orthophotos at zoom 16+ without the Time Warp panel. */
function isOrgAerialAutoLoadEnabled() {
    return !isPublicCatalogTimeWarpMode() && getSubscriptionTier() === 'enhanced';
}

function applyTimeWarpPublicModeUi(isPublic) {
    const tabs = document.querySelector('.aerial-maps-panel-tabs');
    const body = document.getElementById('aerialMapsPanelBody');
    const viewportLbl = document.querySelector('.time-warp-viewport-label');
    const searchInput = document.getElementById('timeWarpSearch');
    const refreshBtn = document.getElementById('aerialMapsPanelRefresh');
    const titleBtn = document.getElementById('aerialMapsPanelToggle');
    const summary = document.getElementById('publicSearchResultSummary');
    const panelHint = document.getElementById('aerialMapsPanelHint');
    if (tabs) tabs.style.display = isPublic ? 'none' : '';
    if (body) body.style.display = isPublic ? 'none' : '';
    if (viewportLbl) viewportLbl.style.display = isPublic ? 'none' : '';
    if (searchInput) searchInput.style.display = isPublic ? 'none' : '';
    if (panelHint) panelHint.style.display = isPublic ? 'none' : '';
    if (refreshBtn) {
        refreshBtn.textContent = isPublic ? 'Search' : 'Refresh';
        refreshBtn.title = isPublic
            ? 'Search public data in the current map view'
            : 'Refresh aerial list for current view';
    }
    if (titleBtn) titleBtn.textContent = isPublic ? 'Public data' : 'Time Warp';
    if (summary) summary.hidden = !isPublic;
    if (isPublic) {
        mountPublicSearchControls();
    } else {
        unmountPublicSearchControls();
    }
    syncPublicTimeFrameUi();
    const ticketHubBtn = document.getElementById('ticketHubOpenButton');
    if (ticketHubBtn) ticketHubBtn.style.display = isPublic ? 'none' : '';
    const mapStatusFilters = document.getElementById('mapStatusFilters');
    if (mapStatusFilters) {
        mapStatusFilters.hidden = !!isPublic;
        mapStatusFilters.style.display = isPublic ? 'none' : '';
        if (isPublic && typeof window.closeMapStatusDropdowns === 'function') {
            window.closeMapStatusDropdowns();
        }
    }
    const sortLabel = document.querySelector('label[for="ticketListSort"]');
    const sortSelect = document.getElementById('ticketListSort');
    if (sortLabel) sortLabel.style.display = isPublic ? 'none' : '';
    if (sortSelect) sortSelect.style.display = isPublic ? 'none' : '';
    syncDesktopLeafletPush();
}

function getSubscriptionTier() {
    const orgId = window.orgSelectorModule && window.orgSelectorModule.getCurrentOrgId();
    const orgs = (window.orgSelectorModule && window.orgSelectorModule.getOrganizations()) || [];
    const org = orgs.find((o) => o.id === orgId);
    const raw = org && org.settings && org.settings.subscriptionTier;
    const t = raw ? String(raw).toLowerCase() : 'basic';
    if (t === 'plus' || t === 'max' || t === 'enhanced') return 'enhanced';
    return 'basic';
}

function getQueryOrgId() {
    return window.orgSelectorModule && window.orgSelectorModule.getCurrentOrgId();
}

/** Current Leaflet map extent as min/max lng/lat, or null if unavailable. */
function getMapViewBbox() {
    const map = window.map;
    if (!map || typeof map.getBounds !== 'function') return null;
    const b = map.getBounds();
    if (!b || (typeof b.isValid === 'function' && !b.isValid())) return null;
    return {
        minLng: b.getWest(),
        minLat: b.getSouth(),
        maxLng: b.getEast(),
        maxLat: b.getNorth(),
    };
}

function getAerialForViewCacheKey(orgId, zoom, mode) {
    if (orgId == null || zoom == null || !mode) return null;
    return [String(orgId), String(zoom), String(mode)].join('|');
}

function padBbox(bbox, ratio) {
    if (!bbox) return null;
    const lngSpan = Math.max(0, bbox.maxLng - bbox.minLng);
    const latSpan = Math.max(0, bbox.maxLat - bbox.minLat);
    const lngPad = lngSpan * ratio;
    const latPad = latSpan * ratio;
    return {
        minLng: bbox.minLng - lngPad,
        minLat: Math.max(-90, bbox.minLat - latPad),
        maxLng: bbox.maxLng + lngPad,
        maxLat: Math.min(90, bbox.maxLat + latPad),
    };
}

function bboxContainsBbox(container, inner) {
    if (!container || !inner) return false;
    return (
        inner.minLng >= container.minLng &&
        inner.maxLng <= container.maxLng &&
        inner.minLat >= container.minLat &&
        inner.maxLat <= container.maxLat
    );
}

function getAerialForViewRequestKey(orgId, zoom, bbox) {
    if (orgId == null || zoom == null || !bbox) return null;
    const round = (n) => Number(n).toFixed(5);
    return [
        String(orgId),
        String(zoom),
        round(bbox.minLng),
        round(bbox.minLat),
        round(bbox.maxLng),
        round(bbox.maxLat),
    ].join('|');
}

function isAerialForViewCacheFresh(cachedAt, now = Date.now()) {
    return Number.isFinite(cachedAt) && now - cachedAt < AERIAL_FOR_VIEW_CACHE_TTL_MS;
}

function clearAerialForViewCache() {
    lastAerialForViewKey = null;
    aerialForViewCachedResult = null;
    aerialForViewEmptyCooldownUntil = 0;
}

/** Drop stale for-view cache so newly synced orthophotos can be discovered without a reload. */
function expireAerialForViewCacheIfStale(now = Date.now()) {
    if (!aerialForViewCachedResult) return;
    if (!isAerialForViewCacheFresh(aerialForViewCachedResult.cachedAt, now)) {
        clearAerialForViewCache();
    }
}

async function apiFetchForView(opts) {
    const orgId = getQueryOrgId();
    if (!orgId || !window.authModule) throw new Error('No organization');
    const params = new URLSearchParams();
    params.set('organizationId', String(orgId));
    if (opts.zoom != null && !Number.isNaN(opts.zoom)) params.set('zoom', String(opts.zoom));
    if (opts.mode) params.set('mode', String(opts.mode));
    if (opts.bbox && Number.isFinite(opts.bbox.minLng)) {
        params.set(
            'bbox',
            [opts.bbox.minLng, opts.bbox.minLat, opts.bbox.maxLng, opts.bbox.maxLat].map((n) => String(n)).join(',')
        );
    }
    return window.authModule.apiRequest(`/api/data/aerial-maps/for-view?${params.toString()}`, opts.signal ? { signal: opts.signal } : {});
}

/** API query zoom: 16 only when map zoom allows. */
function getApiZoomForFetch(tier, mapZoom) {
    if (mapZoom >= TIME_WARP_MIN_ZOOM) return 16;
    return null;
}

function toDatetimeLocalValue(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeWarpFilterActive(c) {
    if (!c || !c.zoomOk) return false;
    if (c.timeActive) return true;
    if (c.search && String(c.search).trim()) return true;
    if (c.viewportOnly && c.viewportBounds) return true;
    return false;
}

function getTimeWarpConstraints() {
    const inactive = {
        zoomOk: false,
        timeActive: false,
        startMs: null,
        endMs: null,
        viewportBounds: null,
        viewportOnly: false,
        search: '',
    };
    if (!isPublicCatalogTimeWarpMode()) {
        return inactive;
    }
    const map = window.map;
    const zoomOk = !!(map && typeof map.getZoom === 'function' && map.getZoom() >= TIME_WARP_MIN_ZOOM);
    if (!zoomOk) {
        return inactive;
    }
    const fromEl = document.getElementById('timeWarpFrom');
    const toEl = document.getElementById('timeWarpTo');
    const viewportCb = document.getElementById('timeWarpViewportOnly');
    const searchEl = document.getElementById('timeWarpSearch');
    const viewportOnly = !!(viewportCb && viewportCb.checked);
    const search = searchEl ? String(searchEl.value || '').trim() : '';
    let timeActive = twPreset !== 'all';
    let startMs = null;
    let endMs = null;
    if (timeActive && fromEl && toEl && fromEl.value && toEl.value) {
        startMs = new Date(fromEl.value).getTime();
        endMs = new Date(toEl.value).getTime();
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
            timeActive = false;
            startMs = null;
            endMs = null;
        }
    } else if (timeActive && (!fromEl || !toEl || !fromEl.value || !toEl.value)) {
        timeActive = false;
    }
    let viewportBounds = null;
    if (viewportOnly && map) {
        viewportBounds = map.getBounds();
    }
    return { zoomOk: true, timeActive, startMs, endMs, viewportBounds, viewportOnly, search };
}

function aerialMapTimeMs(m) {
    if (!m) return null;
    const s = m.capturedAt || m.createdAt;
    if (!s) return null;
    const t = new Date(s).getTime();
    return Number.isNaN(t) ? null : t;
}

function getAerialLatLngBounds(m) {
    if (!m || !m.boundingBox) return null;
    try {
        const gj = L.geoJSON(m.boundingBox);
        const b = gj.getBounds();
        if (b && typeof b.isValid === 'function' && b.isValid()) return b;
    } catch (_) {
        /* ignore */
    }
    return null;
}

function findAerialMapById(mapId) {
    const id = Number(mapId);
    if (!Number.isFinite(id)) return null;
    return getActiveTimelineMaps().find((m) => m.id === id) || null;
}

/** Fit the main Leaflet map to an aerial map footprint. */
function zoomToAerialMap(mapId) {
    const m = findAerialMapById(mapId);
    if (!m || !window.map) return;
    const b = getAerialLatLngBounds(m);
    if (!b || !b.isValid()) {
        if (window.appAlert) void appAlert('This aerial map has no footprint to zoom to.');
        return;
    }
    const fit =
        window.aerialMapsModule && typeof window.aerialMapsModule.fitMapToAerialFootprint === 'function'
            ? window.aerialMapsModule.fitMapToAerialFootprint
            : null;
    if (fit && fit(b)) return;
    window.map.fitBounds(b, { padding: [50, 50], animate: true, duration: 0.5 });
}

/** @deprecated Use zoomToAerialMap — kept for internal callers. */
function zoomMainMapToPanelAerial(mapId) {
    zoomToAerialMap(mapId);
}

function aerialPassesTimeWarp(m) {
    const c = getTimeWarpConstraints();
    if (!timeWarpFilterActive(c)) return true;
    if (c.timeActive && c.startMs != null && c.endMs != null) {
        const ms = aerialMapTimeMs(m);
        if (ms != null && (ms < c.startMs || ms > c.endMs)) return false;
    }
    if (c.viewportOnly && c.viewportBounds && m) {
        const ab = getAerialLatLngBounds(m);
        if (ab && ab.isValid() && !c.viewportBounds.intersects(ab)) return false;
    }
    if (c.search && String(c.search).trim()) {
        const q = String(c.search).trim().toLowerCase();
        const name = (m.name || '').toLowerCase();
        if (!name.includes(q)) return false;
    }
    return true;
}

function setTimeWarpPreset(preset) {
    twPreset = preset;
    const fromEl = document.getElementById('timeWarpFrom');
    const toEl = document.getElementById('timeWarpTo');
    if (!fromEl || !toEl) return;
    const now = Date.now();
    if (preset === 'all') {
        fromEl.value = '';
        toEl.value = '';
    } else if (preset === '24h') {
        fromEl.value = toDatetimeLocalValue(new Date(now - 24 * 60 * 60 * 1000));
        toEl.value = toDatetimeLocalValue(new Date(now));
    } else if (preset === '7d') {
        fromEl.value = toDatetimeLocalValue(new Date(now - 7 * 24 * 60 * 60 * 1000));
        toEl.value = toDatetimeLocalValue(new Date(now));
    } else if (preset === '30d') {
        fromEl.value = toDatetimeLocalValue(new Date(now - 30 * 24 * 60 * 60 * 1000));
        toEl.value = toDatetimeLocalValue(new Date(now));
    } else if (preset === 'custom') {
        syncPublicTimeFrameUi();
        void refreshTimeWarpOnMap();
        return;
    }
    syncPublicTimeFrameUi();
    void refreshTimeWarpOnMap();
}

function syncPublicTimeFrameUi() {
    const customRange = document.getElementById('timeWarpCustomRange');
    const isPublic = isPublicCatalogTimeWarpMode();
    if (customRange) {
        customRange.hidden = isPublic ? twPreset !== 'custom' : false;
    }
    const presetMap = {
        timeWarpPresetAll: 'all',
        timeWarpPreset24h: '24h',
        timeWarpPreset7d: '7d',
        timeWarpPreset30d: '30d',
        timeWarpPresetCustom: 'custom',
    };
    Object.entries(presetMap).forEach(([id, preset]) => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.toggle('time-warp-preset-btn--active', twPreset === preset);
    });
    if (publicSearchBarEl) {
        publicSearchBarEl.classList.toggle('public-search-bar--custom-open', isPublic && twPreset === 'custom');
    }
    syncPublicSearchBarReserve();
}

function updateTimeWarpUiState() {
    const map = window.map;
    const flying =
        window.aerialMapsModule &&
        typeof window.aerialMapsModule.isAerialFlyInProgress === 'function' &&
        window.aerialMapsModule.isAerialFlyInProgress();
    const zOk = flying || (map && map.getZoom() >= TIME_WARP_MIN_ZOOM);
    const hint = document.getElementById('timeWarpZoomHint');
    const refreshBtn = document.getElementById('aerialMapsPanelRefresh');
    const isPublic = isPublicCatalogTimeWarpMode();
    if (hint) {
        hint.textContent = zOk
            ? ''
            : `Zoom to level ${TIME_WARP_MIN_ZOOM}+ to ${isPublic ? 'search public data' : 'use Time Warp filters'}.`;
        hint.style.display = zOk ? 'none' : 'block';
    }
    if (refreshBtn) refreshBtn.disabled = !zOk;
    [
        'timeWarpFrom',
        'timeWarpTo',
        'timeWarpViewportOnly',
        'timeWarpSearch',
        'timeWarpPresetAll',
        'timeWarpPreset24h',
        'timeWarpPreset7d',
        'timeWarpPreset30d',
        'timeWarpPresetCustom',
    ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = !zOk;
    });
}

/**
 * @param {{ aerialListShowAllFromRefresh?: boolean }} [opts] When true, aerial list shows every map from panelMaps (ignore Time Warp row filters) — used after manual Refresh.
 */
async function refreshTimeWarpOnMap(opts) {
    if (isPublicCatalogTimeWarpMode()) {
        updateTimeWarpUiState();
        return;
    }
    if (isOrgAerialAutoLoadEnabled()) {
        await applyAerialMapsForViewport();
    }
    if (window.photosModule && typeof window.photosModule.reloadPhotosOnMap === 'function') {
        window.photosModule.reloadPhotosOnMap();
    }
    if (window.photoMapLoaderModule && typeof window.photoMapLoaderModule.scheduleFetchPhotoMapForViewport === 'function') {
        window.photoMapLoaderModule.scheduleFetchPhotoMapForViewport(true);
    }
}

function resetTimeWarpForm() {
    twPreset = 'all';
    const fromEl = document.getElementById('timeWarpFrom');
    const toEl = document.getElementById('timeWarpTo');
    const vs = document.getElementById('timeWarpViewportOnly');
    const se = document.getElementById('timeWarpSearch');
    if (fromEl) fromEl.value = '';
    if (toEl) toEl.value = '';
    if (vs) vs.checked = false;
    if (se) se.value = '';
    syncPublicTimeFrameUi();
}

function switchTimeWarpTab(which) {
    activeTimeWarpTab = which;
    const tabA = document.getElementById('timeWarpTabAerial');
    const tabP = document.getElementById('timeWarpTabPhotos');
    const panelA = document.getElementById('timeWarpPanelAerial');
    const panelP = document.getElementById('timeWarpPanelPhotos');
    const aerial = which === 'aerial';
    if (tabA) {
        tabA.setAttribute('aria-selected', aerial ? 'true' : 'false');
        tabA.classList.toggle('aerial-maps-panel-tab--active', aerial);
    }
    if (tabP) {
        tabP.setAttribute('aria-selected', aerial ? 'false' : 'true');
        tabP.classList.toggle('aerial-maps-panel-tab--active', !aerial);
    }
    if (panelA) {
        panelA.hidden = !aerial;
        panelA.setAttribute('aria-hidden', aerial ? 'false' : 'true');
    }
    if (panelP) {
        panelP.hidden = aerial;
        panelP.setAttribute('aria-hidden', aerial ? 'true' : 'false');
    }
    if (which === 'photos') {
        renderTimeWarpPhotosList();
    }
    syncDesktopLeafletPush();
}

function ensureTimeWarpMoveListener() {
    if (!window.map || timeWarpMoveBound) return;
    timeWarpMoveBound = true;
    window.map.on('moveend', () => {
        const cb = document.getElementById('timeWarpViewportOnly');
        if (cb && cb.checked) void refreshTimeWarpOnMap();
        if (timeWarpMapMoveDebounceT) {
            clearTimeout(timeWarpMapMoveDebounceT);
        }
        timeWarpMapMoveDebounceT = window.setTimeout(() => {
            timeWarpMapMoveDebounceT = undefined;
            if (isPublicCatalogTimeWarpMode()) return;
            if (!isOrgAerialAutoLoadEnabled() || !window.map) {
                return;
            }
            void (async () => {
                if (!isDroneTimelineZoomEligible()) {
                    await applyAerialMapsForViewport();
                    return;
                }
                const changed = await syncAerialViewForZoom();
                if (!changed) {
                    await applyAerialMapsForViewport();
                }
            })();
        }, TIME_WARP_MAP_MOVE_MS);
    });
}

function wireTimeWarpControls() {
    document.getElementById('timeWarpPresetAll')?.addEventListener('click', () => setTimeWarpPreset('all'));
    document.getElementById('timeWarpPreset24h')?.addEventListener('click', () => setTimeWarpPreset('24h'));
    document.getElementById('timeWarpPreset7d')?.addEventListener('click', () => setTimeWarpPreset('7d'));
    document.getElementById('timeWarpPreset30d')?.addEventListener('click', () => setTimeWarpPreset('30d'));
    document.getElementById('timeWarpPresetCustom')?.addEventListener('click', () => setTimeWarpPreset('custom'));
    document.getElementById('timeWarpFrom')?.addEventListener('change', () => {
        twPreset = 'custom';
        syncPublicTimeFrameUi();
        void refreshTimeWarpOnMap();
    });
    document.getElementById('timeWarpTo')?.addEventListener('change', () => {
        twPreset = 'custom';
        syncPublicTimeFrameUi();
        void refreshTimeWarpOnMap();
    });
    document.getElementById('timeWarpViewportOnly')?.addEventListener('change', () => void refreshTimeWarpOnMap());
    document.getElementById('timeWarpSearch')?.addEventListener('input', () => void refreshTimeWarpOnMap());

    document.getElementById('timeWarpTabAerial')?.addEventListener('click', () => switchTimeWarpTab('aerial'));
    document.getElementById('timeWarpTabPhotos')?.addEventListener('click', () => switchTimeWarpTab('photos'));
}

async function refreshManageDataAerialList() {
    try {
        if (
            window.dataWindowModule &&
            window.dataWindowModule.currentDataView === 'aerialmaps' &&
            window.aerialMapsModule &&
            typeof window.aerialMapsModule.loadSavedAerialMaps === 'function'
        ) {
            await window.aerialMapsModule.loadSavedAerialMaps();
        }
        if (
            window.dataTableRendererModule &&
            typeof window.dataTableRendererModule.renderDataTable === 'function' &&
            window.dataWindowModule &&
            window.dataWindowModule.currentDataView === 'aerialmaps'
        ) {
            window.dataTableRendererModule.renderDataTable();
        }
    } catch (e) {
        console.error('refreshManageDataAerialList:', e);
    }
}

function isMobileAerialLayout() {
    return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
}

function getMapContainerEl() {
    return document.querySelector('.map-container');
}

function syncDesktopLeafletPush() {
    const container = getMapContainerEl();
    if (!container) return;

    const clear = () => {
        container.style.removeProperty('--aerial-panel-leaflet-push');
        if (window.map && typeof window.map.invalidateSize === 'function') {
            requestAnimationFrame(() => window.map.invalidateSize({ animate: false }));
        }
    };

    if (isMobileAerialLayout()) {
        clear();
        return;
    }

    // Reserve space so Leaflet top-right controls sit below the public-data panel when open.
    const panel = document.getElementById('aerialMapsPanel');
    if (!panel) {
        clear();
        return;
    }

    if (panel.style.display === 'none' || getComputedStyle(panel).display === 'none') {
        clear();
        return;
    }

    const apply = () => {
        const h = panel.offsetHeight;
        if (!h) {
            clear();
            return;
        }
        const gap = 8;
        container.style.setProperty('--aerial-panel-leaflet-push', `${Math.round(h + gap)}px`);
        if (window.map && typeof window.map.invalidateSize === 'function') {
            requestAnimationFrame(() => window.map.invalidateSize({ animate: false }));
        }
    };

    requestAnimationFrame(() => requestAnimationFrame(apply));
}

function sortMapsByCapture(maps) {
    return (maps || []).slice().sort((a, b) => {
        const ta = new Date(a.capturedAt || a.createdAt || 0).getTime();
        const tb = new Date(b.capturedAt || b.createdAt || 0).getTime();
        return ta - tb;
    });
}

function getSortedCheckedMaps() {
    let maps = sortMapsByCapture(panelMaps.filter((m) => checkedById.get(m.id) !== false));
    const c = getTimeWarpConstraints();
    if (timeWarpFilterActive(c)) {
        maps = maps.filter((m) => aerialPassesTimeWarp(m));
    }
    return maps;
}

function getActiveTimelineMaps() {
    if (isPublicCatalogTimeWarpMode()) {
        return sortMapsByCapture(window.PUBLIC_MAP_AERIAL || []);
    }
    return getSortedCheckedMaps();
}

function formatAerialCaptureLabel(m) {
    if (!m) return '—';
    const cap = m.capturedAt || m.createdAt;
    if (typeof window.formatRecordedDateTime === 'function') {
        return window.formatRecordedDateTime(cap, '—');
    }
    return '—';
}

function parseTimelinePosition(value, maxIdx) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(Math.max(0, n), maxIdx);
}

function getTimelineBlend(position, len) {
    if (len <= 1) return { lowerIdx: 0, upperIdx: 0, blend: 0 };
    const clamped = Math.min(Math.max(0, position), len - 1);
    const lowerIdx = Math.floor(clamped);
    const upperIdx = Math.min(lowerIdx + 1, len - 1);
    return { lowerIdx, upperIdx, blend: clamped - lowerIdx };
}

function formatTimelineBlendLabel(sorted, position) {
    const { lowerIdx, upperIdx, blend } = getTimelineBlend(position, sorted.length);
    const a = formatAerialCaptureLabel(sorted[lowerIdx]);
    if (lowerIdx === upperIdx || blend < 0.01) return a;
    const b = formatAerialCaptureLabel(sorted[upperIdx]);
    if (blend > 0.99) return b;
    return `${a} → ${b}`;
}

function formatTimelinePositionText(position, len) {
    const { lowerIdx, upperIdx, blend } = getTimelineBlend(position, len);
    if (blend > 0.01 && blend < 0.99 && lowerIdx !== upperIdx) {
        return `${lowerIdx + 1} ↔ ${upperIdx + 1}`;
    }
    const snapped = Math.round(position);
    const idx = Math.min(Math.max(0, snapped), len - 1);
    return `${idx + 1} / ${len}`;
}

function clampTimelinePosition(len) {
    const maxIdx = Math.max(0, len - 1);
    timelineIndex = parseTimelinePosition(timelineIndex, maxIdx);
}

function isTimelineViewEnabled() {
    const sorted = getActiveTimelineMaps();
    if (sorted.length < 2) return false;
    if (isPublicCatalogTimeWarpMode()) return droneTimelineUserEngaged;
    const cb = document.getElementById('aerialMapsTimelineEnable');
    if (cb) return !!cb.checked;
    return droneTimelineUserEngaged;
}

function setDroneTimelineEngaged(engaged) {
    droneTimelineUserEngaged = !!engaged;
    if (droneTimelineBarEl) {
        droneTimelineBarEl.classList.toggle('drone-maps-timeline-bar--engaged', engaged);
    }
    const cb = document.getElementById('aerialMapsTimelineEnable');
    if (cb && !isPublicCatalogTimeWarpMode()) {
        cb.checked = !!engaged;
    }
}

function engageTimelineAtIndex(index, opts) {
    const snap = !opts || opts.snap !== false;
    const sorted = getActiveTimelineMaps();
    if (sorted.length < 2) return;
    const maxIdx = sorted.length - 1;
    timelineIndex = snap ? Math.min(Math.max(0, Math.round(index)), maxIdx) : parseTimelinePosition(index, maxIdx);
    setDroneTimelineEngaged(true);
    updateTimelineDateLabel(sorted);
    updateBottomTimelineControls(sorted);
    if (isPublicCatalogTimeWarpMode()) {
        void applyPublicSearchAerialTimeline();
    } else {
        void applyTimelineVisibility();
    }
}

function focusTimelineOnAerialMap(mapId) {
    const sorted = getActiveTimelineMaps();
    const idx = sorted.findIndex((m) => m.id === Number(mapId));
    if (idx < 0) {
        zoomToAerialMap(mapId);
        return;
    }
    engageTimelineAtIndex(idx, { snap: true });
    zoomToAerialMap(mapId);
}

function toggleDroneTimelineList(open) {
    const next = open != null ? !!open : !droneTimelineListOpen;
    droneTimelineListOpen = next;
    if (droneTimelineBarEl) {
        droneTimelineBarEl.classList.toggle('drone-maps-timeline-bar--list-open', next);
    }
    const toggle = document.getElementById('droneMapsTimelineListToggle');
    const list = document.getElementById('droneMapsTimelineList');
    if (toggle) toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (list) list.hidden = !next;
}

function renderBottomTimelineList(sorted) {
    const list = document.getElementById('droneMapsTimelineList');
    const toggle = document.getElementById('droneMapsTimelineListToggle');
    const maps = sorted || getActiveTimelineMaps();
    const len = maps.length;
    if (toggle) toggle.textContent = `Maps (${len})`;
    if (!list) return;

    list.innerHTML = '';
    if (!shouldShowDroneTimelineBar(maps)) return;

    const activeIdx = droneTimelineUserEngaged
        ? Math.min(Math.max(0, Math.round(timelineIndex)), len - 1)
        : -1;

    maps.forEach((m, i) => {
        const li = document.createElement('li');
        li.className = 'drone-maps-timeline-bar__list-row';
        li.setAttribute('role', 'button');
        li.setAttribute('tabindex', '0');
        if (i === activeIdx) {
            li.classList.add('drone-maps-timeline-bar__list-row--active');
            li.setAttribute('aria-current', 'true');
        }
        li.setAttribute('data-map-id', String(m.id));
        const cap = m.capturedAt || m.createdAt || '—';
        const name = (m.name || 'Map').replace(/</g, '&lt;');
        li.innerHTML = `
            <span class="drone-maps-timeline-bar__list-date">${String(cap).slice(0, 10)}</span>
            <span class="drone-maps-timeline-bar__list-name">${name}</span>
        `;
        list.appendChild(li);
    });

    if (activeIdx >= 0) {
        const activeRow = list.querySelector('.drone-maps-timeline-bar__list-row--active');
        if (activeRow && typeof activeRow.scrollIntoView === 'function') {
            activeRow.scrollIntoView({ block: 'nearest' });
        }
    }
}

function updateTimelineDateLabel(sorted) {
    const el = document.getElementById('aerialMapsTimelineDate');
    const range = document.getElementById('aerialMapsTimeline');
    if (!el) return;

    if (!isTimelineViewEnabled()) {
        el.textContent = '';
        if (range) range.removeAttribute('aria-valuetext');
        return;
    }
    if (!sorted || sorted.length === 0) {
        el.textContent = '';
        if (range) range.removeAttribute('aria-valuetext');
        return;
    }
    const text = formatTimelineBlendLabel(sorted, timelineIndex);
    el.textContent = text;
    if (range) range.setAttribute('aria-valuetext', text);
}

function syncDroneMapsTimelineBarPush(_show) {
    /* Bar is centered between sidebar and attribution insets; attribution stays flush bottom-right. */
}

function isDroneTimelineZoomEligible() {
    const map = window.map;
    if (
        window.aerialMapsModule &&
        typeof window.aerialMapsModule.isAerialFlyInProgress === 'function' &&
        window.aerialMapsModule.isAerialFlyInProgress()
    ) {
        return true;
    }
    return !!(map && typeof map.getZoom === 'function' && map.getZoom() >= TIME_WARP_MIN_ZOOM);
}

function shouldShowDroneTimelineBar(sorted) {
    const len = sorted ? sorted.length : 0;
    return isDroneTimelineZoomEligible() && len >= 2;
}

function hideDroneMapsTimelineBar() {
    if (!droneTimelineBarEl) return;
    droneTimelineBarEl.hidden = true;
    droneTimelineBarEl.classList.remove('drone-maps-timeline-bar--visible');
    droneTimelineBarEl.classList.remove('drone-maps-timeline-bar--engaged');
    droneTimelineBarEl.classList.remove('drone-maps-timeline-bar--list-open');
    toggleDroneTimelineList(false);
    syncDroneMapsTimelineBarPush(false);
}

function ensurePublicSearchBar() {
    if (publicSearchBarEl) return publicSearchBarEl;
    const mapRoot = document.querySelector('.map-container');
    if (!mapRoot) return null;

    publicSearchBarEl = document.createElement('div');
    publicSearchBarEl.id = 'publicSearchBar';
    publicSearchBarEl.className = 'public-search-bar';
    publicSearchBarEl.setAttribute('aria-label', 'Public data search');
    publicSearchBarEl.hidden = true;
    publicSearchBarEl.innerHTML = `
        <div class="public-search-bar__inner">
            <div class="public-search-bar__header">
                <span class="public-search-bar__title">Public data</span>
                <div class="public-search-bar__presets" id="publicSearchBarPresetsHost"></div>
                <div class="public-search-bar__header-actions" id="publicSearchBarHeaderActions"></div>
            </div>
            <div class="public-search-bar__body" id="publicSearchBarBody"></div>
            <div class="public-search-bar__timeline" id="publicSearchBarTimelineHost"></div>
        </div>
    `;
    mapRoot.appendChild(publicSearchBarEl);
    return publicSearchBarEl;
}

function syncPublicSearchBarMapClass(show) {
    const mapRoot = getMapContainerEl();
    if (!mapRoot) return;
    mapRoot.classList.toggle('map-container--public-search-bar', !!show);
    if (!show) {
        mapRoot.classList.remove('map-container--public-search-custom-open', 'map-container--public-search-has-timeline');
        return;
    }
    syncPublicSearchBarReserve();
}

function syncPublicSearchBarReserve() {
    const mapRoot = getMapContainerEl();
    if (!mapRoot || !publicSearchBarEl) return;
    mapRoot.classList.toggle(
        'map-container--public-search-custom-open',
        publicSearchBarEl.classList.contains('public-search-bar--custom-open')
    );
    mapRoot.classList.toggle(
        'map-container--public-search-has-timeline',
        publicSearchBarEl.classList.contains('public-search-bar--has-timeline')
    );
}

function mountDroneTimelineInPublicBar() {
    if (!isPublicCatalogTimeWarpMode()) return;
    const host = document.getElementById('publicSearchBarTimelineHost');
    const bar = ensureDroneMapsTimelineBar();
    if (!host || !bar) return;
    if (bar.parentElement !== host) {
        host.appendChild(bar);
    }
    bar.classList.add('drone-maps-timeline-bar--embedded');
}

function unmountDroneTimelineFromPublicBar() {
    const bar = droneTimelineBarEl;
    const mapRoot = document.querySelector('.map-container');
    if (!bar || !mapRoot) return;
    if (bar.parentElement !== mapRoot) {
        mapRoot.appendChild(bar);
    }
    bar.classList.remove('drone-maps-timeline-bar--embedded');
}

function restorePublicSearchToolbarChildren() {
    const toolbar = document.getElementById('timeWarpToolbar');
    const panel = document.getElementById('aerialMapsPanel');
    if (!toolbar || !panel) return;

    const hint = document.getElementById('timeWarpZoomHint');
    const presets = document.querySelector('.time-warp-presets');
    const customRange = document.getElementById('timeWarpCustomRange');
    const viewportLbl = document.querySelector('.time-warp-viewport-label');
    const searchInput = document.getElementById('timeWarpSearch');
    const summary = document.getElementById('publicSearchResultSummary');

    const ordered = [hint, presets, customRange, viewportLbl, searchInput, summary];
    ordered.forEach((el) => {
        if (el && el.parentElement !== toolbar) {
            toolbar.appendChild(el);
        }
    });

    if (toolbar.parentElement !== panel) {
        const tabs = panel.querySelector('.aerial-maps-panel-tabs');
        if (tabs) {
            panel.insertBefore(toolbar, tabs);
        } else {
            panel.appendChild(toolbar);
        }
    }
}

function mountPublicSearchControls() {
    ensurePanelDom();
    const bar = ensurePublicSearchBar();
    if (!bar) return;

    const refreshBtn = document.getElementById('aerialMapsPanelRefresh');
    const toolbar = document.getElementById('timeWarpToolbar');
    const presets = toolbar?.querySelector('.time-warp-presets');
    const hint = document.getElementById('timeWarpZoomHint');
    const customRange = document.getElementById('timeWarpCustomRange');
    const summary = document.getElementById('publicSearchResultSummary');
    const actionsHost = document.getElementById('publicSearchBarHeaderActions');
    const presetsHost = document.getElementById('publicSearchBarPresetsHost');
    const bodyHost = document.getElementById('publicSearchBarBody');

    if (refreshBtn && actionsHost && refreshBtn.parentElement !== actionsHost) {
        actionsHost.appendChild(refreshBtn);
    }
    if (presets && presetsHost && presets.parentElement !== presetsHost) {
        presetsHost.appendChild(presets);
    }
    if (bodyHost) {
        if (hint && hint.parentElement !== bodyHost) bodyHost.appendChild(hint);
        if (customRange && customRange.parentElement !== bodyHost) bodyHost.appendChild(customRange);
        if (summary && summary.parentElement !== bodyHost) bodyHost.appendChild(summary);
    }

    bar.hidden = false;
    bar.classList.add('public-search-bar--visible');
    syncPublicSearchBarMapClass(true);
    mountDroneTimelineInPublicBar();
    syncPublicTimeFrameUi();

    if (panelEl) panelEl.style.display = 'none';
    if (panelFabEl) panelFabEl.style.display = 'none';
    if (panelBackdropEl) panelBackdropEl.style.display = 'none';
    closeMobileAerialPanel();
    updateBottomTimelineControls(getActiveTimelineMaps());
    syncDesktopLeafletPush();
}

function unmountPublicSearchControls() {
    hideDroneMapsTimelineBar();
    if (!publicSearchBarEl) return;

    const refreshBtn = document.getElementById('aerialMapsPanelRefresh');
    const panel = document.getElementById('aerialMapsPanel');
    const headerActions = panel?.querySelector('.aerial-maps-panel-header-actions');

    restorePublicSearchToolbarChildren();

    if (refreshBtn && headerActions && refreshBtn.parentElement !== headerActions) {
        const minimizeBtn = document.getElementById('aerialMapsPanelMinimize');
        if (minimizeBtn && minimizeBtn.parentElement === headerActions) {
            headerActions.insertBefore(refreshBtn, minimizeBtn);
        } else {
            headerActions.appendChild(refreshBtn);
        }
    }

    unmountDroneTimelineFromPublicBar();

    publicSearchBarEl.hidden = true;
    publicSearchBarEl.classList.remove('public-search-bar--visible', 'public-search-bar--custom-open', 'public-search-bar--has-timeline');
    syncPublicSearchBarMapClass(false);
    syncDesktopLeafletPush();
}

function showAllDroneMapsOnTimeline() {
    setDroneTimelineEngaged(false);
    const sorted = getActiveTimelineMaps();
    updateTimelineDateLabel(sorted);
    updateBottomTimelineControls(sorted);
    if (isPublicCatalogTimeWarpMode()) {
        void applyPublicSearchAerialTimeline();
    } else {
        void applyAerialMapsForViewport();
    }
}

function ensureDroneMapsTimelineBar() {
    if (droneTimelineBarEl) return droneTimelineBarEl;
    const mapRoot = document.querySelector('.map-container');
    if (!mapRoot) return null;

    droneTimelineBarEl = document.createElement('div');
    droneTimelineBarEl.id = 'droneMapsTimelineBar';
    droneTimelineBarEl.className = 'drone-maps-timeline-bar';
    droneTimelineBarEl.setAttribute('aria-label', 'Drone imagery timeline');
    droneTimelineBarEl.hidden = true;
    droneTimelineBarEl.innerHTML = `
        <div class="drone-maps-timeline-bar__inner">
            <div class="drone-maps-timeline-bar__header">
                <span class="drone-maps-timeline-bar__title">Drone imagery</span>
                <button type="button" id="droneMapsTimelineListToggle" class="drone-maps-timeline-bar__list-toggle" aria-expanded="false" aria-controls="droneMapsTimelineList" hidden>Maps (0)</button>
                <span id="droneMapsTimelineDate" class="drone-maps-timeline-bar__date" aria-live="polite"></span>
                <span id="droneMapsTimelinePosition" class="drone-maps-timeline-bar__position"></span>
                <button type="button" id="droneMapsTimelineShowAll" class="drone-maps-timeline-bar__show-all" hidden>Show all</button>
            </div>
            <ul id="droneMapsTimelineList" class="drone-maps-timeline-bar__list" hidden></ul>
            <input type="range" id="droneMapsTimelineRange" class="drone-maps-timeline-bar__range app-themed-range-input"
                min="0" max="0" value="0" step="any" aria-label="Select capture date" />
        </div>
    `;
    mapRoot.appendChild(droneTimelineBarEl);

    if (!droneTimelineBarBound) {
        droneTimelineBarBound = true;
        const onBottomTimelineInteract = (e) => {
            if (!droneTimelineUserEngaged) {
                setDroneTimelineEngaged(true);
            }
            const sorted = getActiveTimelineMaps();
            const maxIdx = Math.max(0, sorted.length - 1);
            timelineIndex = parseTimelinePosition(e.target.value, maxIdx);
            updateTimelineDateLabel(sorted);
            updateBottomTimelineControls(sorted);
            if (isPublicCatalogTimeWarpMode()) {
                void applyPublicSearchAerialTimeline();
            } else {
                void applyTimelineVisibility();
            }
        };
        document.getElementById('droneMapsTimelineRange')?.addEventListener('input', onBottomTimelineInteract);
        document.getElementById('droneMapsTimelineRange')?.addEventListener('change', onBottomTimelineInteract);
        document.getElementById('droneMapsTimelineShowAll')?.addEventListener('click', () => {
            showAllDroneMapsOnTimeline();
        });
        document.getElementById('droneMapsTimelineListToggle')?.addEventListener('click', () => {
            toggleDroneTimelineList();
        });
        document.getElementById('droneMapsTimelineList')?.addEventListener('click', (e) => {
            const row = e.target.closest('.drone-maps-timeline-bar__list-row');
            if (!row) return;
            const mapId = parseInt(row.getAttribute('data-map-id'), 10);
            if (Number.isNaN(mapId)) return;
            focusTimelineOnAerialMap(mapId);
        });
        document.getElementById('droneMapsTimelineList')?.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const row = e.target.closest('.drone-maps-timeline-bar__list-row');
            if (!row) return;
            e.preventDefault();
            const mapId = parseInt(row.getAttribute('data-map-id'), 10);
            if (Number.isNaN(mapId)) return;
            focusTimelineOnAerialMap(mapId);
        });
    }
    return droneTimelineBarEl;
}

function updateBottomTimelineControls(sorted) {
    if (isPublicCatalogTimeWarpMode()) {
        mountDroneTimelineInPublicBar();
    }
    const bar = ensureDroneMapsTimelineBar();
    if (!bar) return;

    const maps = sorted || getActiveTimelineMaps();
    const len = maps.length;
    const show = shouldShowDroneTimelineBar(maps);
    bar.hidden = !show;
    bar.classList.toggle('drone-maps-timeline-bar--visible', show);
    syncDroneMapsTimelineBarPush(show);

    if (publicSearchBarEl) {
        publicSearchBarEl.classList.toggle('public-search-bar--has-timeline', isPublicCatalogTimeWarpMode() && show);
    }
    syncPublicSearchBarReserve();

    const range = document.getElementById('droneMapsTimelineRange');
    const dateEl = document.getElementById('droneMapsTimelineDate');
    const posEl = document.getElementById('droneMapsTimelinePosition');
    const showAllBtn = document.getElementById('droneMapsTimelineShowAll');
    const listToggle = document.getElementById('droneMapsTimelineListToggle');
    if (!range) return;

    if (!show) {
        range.disabled = true;
        if (dateEl) dateEl.textContent = '';
        if (posEl) posEl.textContent = '';
        if (showAllBtn) showAllBtn.hidden = true;
        if (listToggle) listToggle.hidden = true;
        toggleDroneTimelineList(false);
        return;
    }

    if (listToggle) listToggle.hidden = false;

    const maxIdx = len - 1;
    clampTimelinePosition(len);

    range.min = '0';
    range.max = String(maxIdx);
    range.step = 'any';
    range.disabled = false;
    range.value = String(timelineIndex);

    const label = formatTimelineBlendLabel(maps, timelineIndex);
    if (!droneTimelineUserEngaged) {
        const oldest = formatAerialCaptureLabel(maps[0]);
        const newest = formatAerialCaptureLabel(maps[len - 1]);
        if (dateEl) {
            dateEl.textContent = oldest === newest ? oldest : `${oldest} – ${newest}`;
        }
        if (posEl) posEl.textContent = `All (${len})`;
        if (showAllBtn) showAllBtn.hidden = true;
        range.setAttribute(
            'aria-valuetext',
            `All ${len} captures shown. Slide to view one at a time.`
        );
        bar.classList.remove('drone-maps-timeline-bar--engaged');
        renderBottomTimelineList(maps);
        return;
    }

    bar.classList.add('drone-maps-timeline-bar--engaged');
    if (dateEl) dateEl.textContent = label;
    if (posEl) posEl.textContent = formatTimelinePositionText(timelineIndex, len);
    if (showAllBtn) showAllBtn.hidden = false;
    range.setAttribute('aria-valuetext', label);
    renderBottomTimelineList(maps);
}

function syncTimelineRange() {
    const sorted = getSortedCheckedMaps();
    const range = document.getElementById('aerialMapsTimeline');
    const enableCb = document.getElementById('aerialMapsTimelineEnable');
    const len = sorted.length;

    if (enableCb) {
        enableCb.disabled = len === 0;
        if (len === 0) enableCb.checked = false;
    }

    if (len === 0) timelineIndex = 0;

    const timelineOn = isTimelineViewEnabled();
    if (range) {
        if (!timelineOn || len === 0) {
            range.min = '0';
            range.max = '0';
            range.step = 'any';
            range.value = '0';
            range.disabled = true;
        } else {
            const maxIdx = len - 1;
            range.min = '0';
            range.max = String(maxIdx);
            range.step = 'any';
            range.disabled = false;
            clampTimelinePosition(len);
            range.value = String(timelineIndex);
        }
    }

    updateTimelineDateLabel(sorted);
    updateBottomTimelineControls(sorted);
    return sorted;
}

function ensurePanelDom() {
    if (panelEl) return panelEl;
    const appRoot = document.querySelector('.map-app-container');
    const mapRoot = document.querySelector('.map-container') || appRoot;
    if (!mapRoot) return null;
    const overlayParent = appRoot || mapRoot;

    panelBackdropEl = document.createElement('div');
    panelBackdropEl.id = 'aerialMapsPanelBackdrop';
    panelBackdropEl.className = 'aerial-maps-panel-backdrop';
    panelBackdropEl.setAttribute('aria-hidden', 'true');
    panelBackdropEl.addEventListener('click', () => closeMobileAerialPanel());
    overlayParent.appendChild(panelBackdropEl);

    panelFabEl = document.createElement('button');
    panelFabEl.type = 'button';
    panelFabEl.id = 'aerialMapsPanelFab';
    panelFabEl.className = 'aerial-maps-panel-fab time-warp-panel-fab';
    panelFabEl.setAttribute('aria-label', 'Open Time Warp panel');
    panelFabEl.setAttribute('title', 'Time Warp');
    panelFabEl.innerHTML = `
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9"/>
            <path d="M12 7v5l3 2"/>
        </svg>
    `;
    panelFabEl.addEventListener('click', () => {
        if (isMobileAerialLayout()) openMobileAerialPanel();
    });
    mapRoot.appendChild(panelFabEl);

    panelEl = document.createElement('div');
    panelEl.id = 'aerialMapsPanel';
    panelEl.className = 'aerial-maps-panel time-warp-panel';
    panelEl.setAttribute('aria-label', 'Time Warp');
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-modal', 'false');
    panelEl.innerHTML = `
        <div class="aerial-maps-panel-header">
            <button type="button" class="aerial-maps-panel-toggle" id="aerialMapsPanelToggle" aria-expanded="true" title="Time Warp">Time Warp</button>
            <div class="aerial-maps-panel-header-actions">
                <button type="button" class="aerial-maps-panel-refresh" id="aerialMapsPanelRefresh" title="Refresh aerial list for current view">Refresh</button>
                <button type="button" class="aerial-maps-panel-minimize" id="aerialMapsPanelMinimize" aria-label="Minimize panel" title="Minimize">▼</button>
                <button type="button" class="aerial-maps-panel-close" id="aerialMapsPanelClose" aria-label="Close Time Warp">&times;</button>
            </div>
        </div>
        <div class="aerial-maps-panel-toolbar" id="timeWarpToolbar">
            <div class="time-warp-zoom-hint" id="timeWarpZoomHint" style="display:none;"></div>
            <div class="time-warp-presets">
                <button type="button" class="time-warp-preset-btn" id="timeWarpPresetAll">All</button>
                <button type="button" class="time-warp-preset-btn" id="timeWarpPreset24h">24h</button>
                <button type="button" class="time-warp-preset-btn" id="timeWarpPreset7d">7d</button>
                <button type="button" class="time-warp-preset-btn" id="timeWarpPreset30d">30d</button>
                <button type="button" class="time-warp-preset-btn" id="timeWarpPresetCustom">Custom</button>
            </div>
            <div class="time-warp-custom-range" id="timeWarpCustomRange" hidden>
                <div class="time-warp-datetime-row">
                    <label class="time-warp-datetime-label">From <input type="datetime-local" id="timeWarpFrom" /></label>
                    <label class="time-warp-datetime-label">To <input type="datetime-local" id="timeWarpTo" /></label>
                </div>
            </div>
            <label class="time-warp-viewport-label"><input type="checkbox" id="timeWarpViewportOnly" /> Visible map only</label>
            <input type="search" id="timeWarpSearch" class="time-warp-search" placeholder="Quick search…" autocomplete="off" />
            <div id="publicSearchResultSummary" class="public-search-result-summary" hidden></div>
        </div>
        <div class="aerial-maps-panel-tabs" role="tablist" aria-label="Time Warp sections">
            <button type="button" role="tab" class="aerial-maps-panel-tab aerial-maps-panel-tab--active" id="timeWarpTabAerial" aria-selected="true" aria-controls="timeWarpPanelAerial">Aerial maps</button>
            <button type="button" role="tab" class="aerial-maps-panel-tab" id="timeWarpTabPhotos" aria-selected="false" aria-controls="timeWarpPanelPhotos">Photos</button>
        </div>
        <div class="aerial-maps-panel-body aerial-maps-panel-body--tabs" id="aerialMapsPanelBody">
            <div class="aerial-maps-panel-tabpanel" id="timeWarpPanelAerial" role="tabpanel" aria-labelledby="timeWarpTabAerial">
                <div class="aerial-maps-panel-hint" id="aerialMapsPanelHint"></div>
                <div class="aerial-maps-panel-list-scroll app-overlay-scroll">
                    <ul class="aerial-maps-panel-list" id="aerialMapsPanelList"></ul>
                </div>
                <div class="aerial-maps-panel-timeline-wrap">
                    <label class="aerial-maps-panel-timeline-enable">
                        <input type="checkbox" id="aerialMapsTimelineEnable" />
                        <span>Enable timeline</span>
                    </label>
                    <label class="aerial-maps-panel-timeline-label" for="aerialMapsTimeline">Timeline</label>
                    <div id="aerialMapsTimelineDate" class="aerial-maps-panel-timeline-date" aria-live="polite"></div>
                    <input type="range" id="aerialMapsTimeline" class="aerial-maps-panel-timeline app-themed-range-input" min="0" max="0" value="0" step="any" disabled />
                </div>
            </div>
            <div class="aerial-maps-panel-tabpanel" id="timeWarpPanelPhotos" role="tabpanel" aria-labelledby="timeWarpTabPhotos" hidden aria-hidden="true">
                <div class="aerial-maps-panel-hint" id="timeWarpPhotosPanelHint"></div>
                <div class="aerial-maps-panel-list-scroll app-overlay-scroll">
                    <ul class="aerial-maps-panel-list" id="timeWarpPhotosList"></ul>
                </div>
            </div>
        </div>
    `;
    overlayParent.appendChild(panelEl);

    if (!aerialPanelResizeObserverBound && typeof ResizeObserver !== 'undefined') {
        aerialPanelResizeObserverBound = true;
        new ResizeObserver(() => syncDesktopLeafletPush()).observe(panelEl);
    }

    document.getElementById('aerialMapsPanelClose').addEventListener('click', () => closeMobileAerialPanel());

    document.getElementById('aerialMapsPanelToggle').addEventListener('click', () => {
        if (isMobileAerialLayout()) return;
        if (panelEl && panelEl.classList.contains('aerial-maps-panel--minimized')) {
            panelEl.classList.remove('aerial-maps-panel--minimized');
            updateMinimizeButtonUi();
        }
    });

    document.getElementById('aerialMapsPanelMinimize').addEventListener('click', () => {
        if (isMobileAerialLayout()) return;
        if (panelEl) {
            panelEl.classList.toggle('aerial-maps-panel--minimized');
            updateMinimizeButtonUi();
        }
    });

    document.getElementById('aerialMapsPanelRefresh').addEventListener('click', () => {
        void refreshPanelFetch();
    });

    document.getElementById('aerialMapsTimeline').addEventListener('input', (e) => {
        const sorted = getSortedCheckedMaps();
        const maxIdx = Math.max(0, sorted.length - 1);
        timelineIndex = parseTimelinePosition(e.target.value, maxIdx);
        updateTimelineDateLabel(sorted);
        updateBottomTimelineControls(sorted);
        void applyTimelineVisibility();
    });

    document.getElementById('aerialMapsTimelineEnable')?.addEventListener('change', () => {
        void applyTimelineVisibility();
    });

    document.getElementById('aerialMapsPanelList')?.addEventListener('click', (e) => {
        if (e.target.closest('.aerial-maps-panel-fav')) return;
        if (e.target.closest('.aerial-maps-panel-cb') || e.target.closest('.aerial-maps-panel-row-label')) return;
        const row = e.target.closest('.aerial-maps-panel-row');
        if (!row) return;
        const mapId = parseInt(row.getAttribute('data-map-id'), 10);
        if (Number.isNaN(mapId)) return;
        focusTimelineOnAerialMap(mapId);
    });

    document.getElementById('timeWarpPhotosList')?.addEventListener('click', (e) => {
        const row = e.target.closest('.time-warp-photo-row');
        if (!row) return;
        const id = row.getAttribute('data-photo-id');
        if (id && typeof window.zoomToPhoto === 'function') {
            window.zoomToPhoto(id);
        }
    });

    wireTimeWarpControls();
    switchTimeWarpTab('aerial');
    syncPublicTimeFrameUi();

    if (!resizeBound) {
        resizeBound = true;
        window.addEventListener('resize', () => {
            if (!panelEl) return;
            if (isPublicCatalogTimeWarpMode()) {
                applyTimeWarpPanelLayout(true);
                return;
            }
            if (!timeWarpPanelLayoutOpen && !mobilePanelOpen) return;
            applyTimeWarpPanelLayout(true);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !mobilePanelOpen || !isMobileAerialLayout()) return;
            closeMobileAerialPanel();
        });
    }

    updateMinimizeButtonUi();
    if (window.overlayScrollModule?.attachOverlayScrollAll) {
        window.overlayScrollModule.attachOverlayScrollAll('#aerialMapsPanel .app-overlay-scroll');
    }
    return panelEl;
}

function updateMinimizeButtonUi() {
    const panel = document.getElementById('aerialMapsPanel');
    const btn = document.getElementById('aerialMapsPanelMinimize');
    const titleBtn = document.getElementById('aerialMapsPanelToggle');
    if (!panel || !btn) return;
    const min = panel.classList.contains('aerial-maps-panel--minimized');
    btn.setAttribute('aria-label', min ? 'Expand panel' : 'Minimize panel');
    btn.setAttribute('title', min ? 'Expand' : 'Minimize');
    btn.textContent = min ? '▲' : '▼';
    if (titleBtn) {
        titleBtn.setAttribute('aria-expanded', min ? 'false' : 'true');
        titleBtn.title = min ? 'Expand panel' : 'Time Warp';
    }
    syncDesktopLeafletPush();
}

function openMobileAerialPanel() {
    if (!isMobileAerialLayout()) return;
    mobilePanelOpen = true;
    if (panelEl) {
        panelEl.classList.add('aerial-maps-panel--open');
        panelEl.setAttribute('aria-modal', 'true');
    }
    if (panelBackdropEl) {
        panelBackdropEl.classList.add('aerial-maps-panel-backdrop--visible');
        panelBackdropEl.setAttribute('aria-hidden', 'false');
    }
    try {
        document.getElementById('aerialMapsPanelClose')?.focus();
    } catch (_) {
        /* ignore */
    }
}

function closeMobileAerialPanel() {
    mobilePanelOpen = false;
    if (panelEl) {
        panelEl.classList.remove('aerial-maps-panel--open');
        panelEl.setAttribute('aria-modal', 'false');
    }
    if (panelBackdropEl) {
        panelBackdropEl.classList.remove('aerial-maps-panel-backdrop--visible');
        panelBackdropEl.setAttribute('aria-hidden', 'true');
    }
    try {
        panelFabEl?.focus();
    } catch (_) {
        /* ignore */
    }
}

function applyTimeWarpPanelLayout(showPanel) {
    ensurePanelDom();
    if (!panelEl || !panelFabEl || !panelBackdropEl) return;

    if (isPublicCatalogTimeWarpMode()) {
        if (showPanel) {
            mountPublicSearchControls();
        } else {
            unmountPublicSearchControls();
        }
        return;
    }

    if (!showPanel) {
        panelEl.style.display = 'none';
        panelFabEl.style.display = 'none';
        panelBackdropEl.style.display = 'none';
        closeMobileAerialPanel();
        syncDesktopLeafletPush();
        return;
    }

    if (isMobileAerialLayout()) {
        panelEl.classList.remove('aerial-maps-panel--minimized');
        panelFabEl.style.removeProperty('display');
        panelBackdropEl.style.removeProperty('display');
        panelEl.style.removeProperty('display');
        if (!mobilePanelOpen) {
            panelEl.classList.remove('aerial-maps-panel--open');
            panelBackdropEl.classList.remove('aerial-maps-panel-backdrop--visible');
            panelBackdropEl.setAttribute('aria-hidden', 'true');
        }
        updateMinimizeButtonUi();
        syncDesktopLeafletPush();
    } else {
        panelFabEl.style.display = 'none';
        panelBackdropEl.style.display = 'none';
        closeMobileAerialPanel();
        panelEl.style.removeProperty('display');
        panelEl.classList.remove('aerial-maps-panel--open');
        updateMinimizeButtonUi();
        syncDesktopLeafletPush();
    }
}

function setPanelVisible(show) {
    timeWarpPanelLayoutOpen = !!show;
    if (!show && !panelEl && !isPublicCatalogTimeWarpMode()) return;
    const el = ensurePanelDom();
    if (!el && !isPublicCatalogTimeWarpMode()) return;
    if (isPublicCatalogTimeWarpMode()) {
        if (show) {
            mountPublicSearchControls();
        } else {
            unmountPublicSearchControls();
        }
        return;
    }
    if (!show) {
        el.style.display = 'none';
        if (panelFabEl) panelFabEl.style.display = 'none';
        if (panelBackdropEl) panelBackdropEl.style.display = 'none';
        closeMobileAerialPanel();
        syncDesktopLeafletPush();
        return;
    }
    applyTimeWarpPanelLayout(true);
}

function clearTimeWarpAerialState(clearLayers) {
    clearAerialForViewCache();
    aerialForViewRequestSeq += 1;
    if (aerialForViewAbortController) {
        aerialForViewAbortController.abort();
        aerialForViewAbortController = null;
    }
    panelMaps = [];
    checkedById.clear();
    favoriteIds = new Set();
    timelineIndex = 0;
    droneTimelineUserEngaged = false;
    hideDroneMapsTimelineBar();
    if (clearLayers && window.aerialMapsModule && window.aerialMapsModule.clearAllAerialMapsFromMap) {
        window.aerialMapsModule.clearAllAerialMapsFromMap();
    }
}

/** Stars reflect Manage Data favorites (`savedAerialMaps`), synced after `loadSavedAerialMaps`, not on every for-view. */
function setFavoriteIdsFromSavedMaps(maps) {
    favoriteIds = new Set((maps || []).map((m) => m.id));
    const list = document.getElementById('aerialMapsPanelList');
    if (list) renderPanelList();
}

function syncFavoriteIdsFromSavedModule() {
    const maps = (window.aerialMapsModule && window.aerialMapsModule.savedAerialMaps) || [];
    setFavoriteIdsFromSavedMaps(maps);
}

function renderTimeWarpPhotosList() {
    const list = document.getElementById('timeWarpPhotosList');
    const hint = document.getElementById('timeWarpPhotosPanelHint');
    if (!list) return;
    const photos = (window.photosModule && window.photosModule.savedPhotos) || [];
    const pass = window.photosModule && window.photosModule.passesTimeWarpFilter;
    const c = getTimeWarpConstraints();
    list.innerHTML = '';
    if (!c.zoomOk) {
        if (hint) {
            hint.textContent = `Zoom to level ${TIME_WARP_MIN_ZOOM}+ to use the photos list.`;
            hint.style.removeProperty('display');
        }
        return;
    }
    if (hint) {
        hint.textContent = 'Click a row to move the map to that photo. Same filters as the map apply.';
        hint.style.removeProperty('display');
    }
    let count = 0;
    photos.forEach((p) => {
        if (pass && !pass(p)) return;
        if (!p.latlng || !(p.imageUrl || p.fileId)) return;
        count += 1;
        const li = document.createElement('li');
        li.className = 'aerial-maps-panel-row time-warp-photo-row';
        li.setAttribute('data-photo-id', String(p.id));
        li.setAttribute('title', 'Click to move the map to this photo');
        const name = (p.fileName || 'Photo').replace(/</g, '&lt;');
        const created = p.createdAt ? String(p.createdAt).slice(0, 10) : '—';
        li.innerHTML = `<span class="aerial-maps-panel-name">${name}</span><span class="aerial-maps-panel-date">${created}</span>`;
        list.appendChild(li);
    });
    if (count === 0 && hint) {
        hint.textContent = 'No photos match the current filters, or there are no geotagged photos yet.';
    }
    syncDesktopLeafletPush();
}

/**
 * @param {{ showAllAerialRows?: boolean }} [opts] If true, list every `panelMaps` row (bypasses Time Warp row filter). Used right after a manual Refresh.
 */
function renderPanelList(opts) {
    const list = document.getElementById('aerialMapsPanelList');
    const hint = document.getElementById('aerialMapsPanelHint');
    if (!list || !hint) return;

    hint.textContent =
        'List loads at zoom 16+. Auto-load shows orthophotos for tickets in the current view. Refresh shows orthophotos that overlap the current view, even without tickets.';

    list.innerHTML = '';
    const cList = getTimeWarpConstraints();
    const showAllAerial = !!(opts && opts.showAllAerialRows);
    const filterAerial = !showAllAerial && timeWarpFilterActive(cList);
    panelMaps.forEach((m) => {
        if (filterAerial && !aerialPassesTimeWarp(m)) return;
        const id = m.id;
        const checked = checkedById.has(id) ? checkedById.get(id) : true;
        const fav = favoriteIds.has(id);
        const cap = m.capturedAt || m.createdAt || '—';
        const li = document.createElement('li');
        li.className = 'aerial-maps-panel-row';
        li.setAttribute('data-map-id', String(id));
        li.setAttribute('title', 'Click name or date to zoom the map to this aerial map');
        li.innerHTML = `
            <label class="aerial-maps-panel-row-label">
                <input type="checkbox" class="aerial-maps-panel-cb" data-map-id="${id}" ${checked ? 'checked' : ''} />
            </label>
            <span class="aerial-maps-panel-name">${(m.name || 'Map').replace(/</g, '&lt;')}</span>
            <span class="aerial-maps-panel-date">${String(cap).slice(0, 10)}</span>
            <button type="button" class="aerial-maps-panel-fav" data-map-id="${id}" title="${fav ? 'Remove favorite' : 'Add favorite'}" aria-pressed="${fav}">${fav ? '★' : '☆'}</button>
        `;
        list.appendChild(li);
    });

    list.querySelectorAll('.aerial-maps-panel-cb').forEach((cb) => {
        cb.addEventListener('change', (e) => {
            const mapId = parseInt(e.target.getAttribute('data-map-id'), 10);
            checkedById.set(mapId, e.target.checked);
            void applyTimelineVisibility();
        });
    });

    list.querySelectorAll('.aerial-maps-panel-fav').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            const mapId = parseInt(e.target.getAttribute('data-map-id'), 10);
            const isFav = favoriteIds.has(mapId);
            try {
                if (isFav) {
                    await window.authModule.apiRequest(`/api/data/aerial-favorites/${mapId}?organizationId=${getQueryOrgId()}`, {
                        method: 'DELETE',
                    });
                    favoriteIds.delete(mapId);
                } else {
                    await window.authModule.apiRequest(
                        `/api/data/aerial-favorites?organizationId=${encodeURIComponent(String(getQueryOrgId()))}`,
                        {
                            method: 'POST',
                            body: JSON.stringify({ aerialMapId: mapId }),
                        }
                    );
                    favoriteIds.add(mapId);
                }
                renderPanelList();
                await refreshManageDataAerialList();
            } catch (err) {
                console.error(err);
                if (window.appAlert) void appAlert(err.message || 'Favorite failed');
            }
        });
    });

    syncTimelineRange();

    syncDesktopLeafletPush();
}

async function applyAerialMapsForViewport() {
    if (!isDroneTimelineZoomEligible()) {
        const mod = window.aerialMapsModule;
        if (mod && typeof mod.removeAerialMapFromMap === 'function') {
            panelMaps.forEach((m) => mod.removeAerialMapFromMap(m.id));
        }
        updateBottomTimelineControls(getSortedCheckedMaps());
        return;
    }
    await applyTimelineVisibility();
}

function getAerialMapLayer(mod, mapId) {
    if (!mod || !mod.aerialMapLayers) return null;
    const key = mapId != null ? String(mapId) : '';
    return mod.aerialMapLayers.get(key) || mod.aerialMapLayers.get(mapId) || null;
}

function setAerialMapLayerZIndex(mod, mapId, z) {
    const layer = getAerialMapLayer(mod, mapId);
    if (!layer) return;
    if (typeof layer.setZIndex === 'function') {
        layer.setZIndex(z);
    } else if (layer.options) {
        layer.options.zIndex = z;
    }
}

/** Show-all mode: load newest orthophoto first; older layers skip tiles covered by newer 3x3 neighborhoods. */
async function loadShowAllAerialMaps(sortedOldestFirst, mod, applySeq) {
    const newestFirst = sortedOldestFirst.slice().reverse();
    const baseZ = 100;
    const multi = newestFirst.length >= 2;
    if (mod.setAerialOverlapStack) {
        mod.setAerialOverlapStack(newestFirst);
    }
    for (const map of newestFirst) {
        const skipWhenCovered = multi && map.id !== newestFirst[0].id;
        if (mod.loadAerialMapOnMap) {
            await mod.loadAerialMapOnMap(map, { skipFitBounds: true, silent: true, skipWhenCovered });
        }
        if (applySeq != null && applySeq !== timelineApplySeq) return false;
        if (mod.setAerialMapOpacity) {
            mod.setAerialMapOpacity(map.id, 1);
        }
        const zIdx = sortedOldestFirst.findIndex((m) => m.id === map.id);
        setAerialMapLayerZIndex(mod, map.id, baseZ + zIdx * 2);
    }
    return true;
}

async function applyPublicSearchAerialTimeline() {
    const applySeq = ++timelineApplySeq;
    const allMaps = window.PUBLIC_MAP_AERIAL || [];
    const sorted = getActiveTimelineMaps();
    const mod = window.aerialMapsModule;
    if (!mod || !window.map) return;

    if (!isTimelineViewEnabled()) {
        if (!(await loadShowAllAerialMaps(sorted, mod, applySeq))) return;
        for (const m of allMaps) {
            if (!sorted.some((s) => s.id === m.id) && mod.removeAerialMapFromMap) {
                mod.removeAerialMapFromMap(m.id);
            }
        }
        return;
    }

    if (mod.clearAerialTileCoverage) mod.clearAerialTileCoverage();

    if (sorted.length === 0) return;

    const { lowerIdx, upperIdx, blend } = getTimelineBlend(timelineIndex, sorted.length);
    const keepIds = new Set([sorted[lowerIdx].id, sorted[upperIdx].id]);

    for (const m of allMaps) {
        if (!mod.removeAerialMapFromMap) continue;
        if (!keepIds.has(m.id)) {
            mod.removeAerialMapFromMap(m.id);
        }
    }

    const lowerMap = sorted[lowerIdx];
    const upperMap = sorted[upperIdx];
    const baseZ = 100;

    if (mod.loadAerialMapOnMap) {
        await mod.loadAerialMapOnMap(lowerMap, { skipFitBounds: true, silent: true, skipWhenCovered: false });
    }
    if (applySeq !== timelineApplySeq) return;

    if (lowerIdx !== upperIdx && mod.loadAerialMapOnMap) {
        await mod.loadAerialMapOnMap(upperMap, { skipFitBounds: true, silent: true, skipWhenCovered: false });
    }
    if (applySeq !== timelineApplySeq) return;

    const lowerOpacity = lowerIdx === upperIdx ? 1 : 1 - blend;
    const upperOpacity = lowerIdx === upperIdx ? 1 : blend;

    if (mod.setAerialMapOpacity) {
        mod.setAerialMapOpacity(lowerMap.id, lowerOpacity);
        if (lowerIdx !== upperIdx) {
            mod.setAerialMapOpacity(upperMap.id, upperOpacity);
        }
    }

    setAerialMapLayerZIndex(mod, lowerMap.id, baseZ + lowerIdx * 2);
    if (lowerIdx !== upperIdx) {
        setAerialMapLayerZIndex(mod, upperMap.id, baseZ + upperIdx * 2);
    }
}

function syncPublicAerialTimeline() {
    if (!isPublicCatalogTimeWarpMode()) return;
    mountDroneTimelineInPublicBar();
    const maps = getActiveTimelineMaps();
    if (maps.length < 2) {
        droneTimelineUserEngaged = false;
    }
    clampTimelinePosition(maps.length);
    updateBottomTimelineControls(maps);
    void applyPublicSearchAerialTimeline();
}

async function applyTimelineVisibility() {
    if (isPublicCatalogTimeWarpMode()) {
        return applyPublicSearchAerialTimeline();
    }
    const applySeq = ++timelineApplySeq;
    const sorted = syncTimelineRange();
    const mod = window.aerialMapsModule;
    if (!mod || !window.map) return;

    if (!isTimelineViewEnabled()) {
        for (const m of panelMaps) {
            if (checkedById.get(m.id) === false && mod.removeAerialMapFromMap) {
                mod.removeAerialMapFromMap(m.id);
            }
        }
        const sortedChecked = getSortedCheckedMaps();
        if (!(await loadShowAllAerialMaps(sortedChecked, mod, applySeq))) return;
        return;
    }

    if (mod.clearAerialTileCoverage) mod.clearAerialTileCoverage();

    if (sorted.length === 0) return;

    const { lowerIdx, upperIdx, blend } = getTimelineBlend(timelineIndex, sorted.length);
    const keepIds = new Set([sorted[lowerIdx].id, sorted[upperIdx].id]);

    for (const m of panelMaps) {
        if (!mod.removeAerialMapFromMap) continue;
        if (checkedById.get(m.id) === false) {
            mod.removeAerialMapFromMap(m.id);
            continue;
        }
        if (!keepIds.has(m.id)) {
            mod.removeAerialMapFromMap(m.id);
        }
    }

    const lowerMap = sorted[lowerIdx];
    const upperMap = sorted[upperIdx];
    const baseZ = 100;

    if (mod.loadAerialMapOnMap) {
        await mod.loadAerialMapOnMap(lowerMap, { skipFitBounds: true, silent: true, skipWhenCovered: false });
    }
    if (applySeq !== timelineApplySeq) return;

    if (lowerIdx !== upperIdx && mod.loadAerialMapOnMap) {
        await mod.loadAerialMapOnMap(upperMap, { skipFitBounds: true, silent: true, skipWhenCovered: false });
    }
    if (applySeq !== timelineApplySeq) return;

    const lowerOpacity = lowerIdx === upperIdx ? 1 : 1 - blend;
    const upperOpacity = lowerIdx === upperIdx ? 1 : blend;

    if (mod.setAerialMapOpacity) {
        mod.setAerialMapOpacity(lowerMap.id, lowerOpacity);
        if (lowerIdx !== upperIdx) {
            mod.setAerialMapOpacity(upperMap.id, upperOpacity);
        }
    }

    setAerialMapLayerZIndex(mod, lowerMap.id, baseZ + lowerIdx * 2);
    if (lowerIdx !== upperIdx) {
        setAerialMapLayerZIndex(mod, upperMap.id, baseZ + upperIdx * 2);
    }
}

function replacePanelMaps(maps) {
    const nextMaps = Array.isArray(maps) ? maps : [];
    const nextIds = new Set(nextMaps.map((m) => m.id));
    const prevIds = new Set(panelMaps.map((m) => m.id));
    const idsChanged =
        nextIds.size !== prevIds.size || [...nextIds].some((id) => !prevIds.has(id));
    const mod = window.aerialMapsModule;
    if (mod && typeof mod.removeAerialMapFromMap === 'function') {
        panelMaps.forEach((m) => {
            if (!nextIds.has(m.id)) mod.removeAerialMapFromMap(m.id);
        });
    }
    panelMaps = nextMaps;
    panelMaps.forEach((m) => {
        if (!checkedById.has(m.id)) checkedById.set(m.id, true);
    });

    const sorted = sortMapsByCapture(panelMaps);
    if (sorted.length < 2) {
        timelineIndex = 0;
        droneTimelineUserEngaged = false;
    } else if (idsChanged) {
        timelineIndex = sorted.length - 1;
        droneTimelineUserEngaged = false;
    } else if (timelineIndex > sorted.length - 1) {
        timelineIndex = sorted.length - 1;
    }
}

async function refreshPanelFetch() {
    if (!isPublicCatalogTimeWarpMode()) {
        return;
    }
    if (typeof window.searchPublicDataInMapArea === 'function') {
        await window.searchPublicDataInMapArea();
    }
}

function ensureAerialZoomListener() {
    if (!window.map || aerialZoomListenerBound) return;
    aerialZoomListenerBound = true;
    window.map.on('zoomend', () => {
        void (async () => {
            const changed = await syncAerialViewForZoom();
            if (isPublicCatalogTimeWarpMode()) {
                updateTimeWarpUiState();
                if (!changed) await refreshTimeWarpOnMap();
                return;
            }
            if (!changed) {
                await applyAerialMapsForViewport();
            }
        })();
    });
}

function invalidateAerialViewCache() {
    clearAerialForViewCache();
    aerialForViewRequestSeq += 1;
    if (aerialForViewAbortController) {
        aerialForViewAbortController.abort();
        aerialForViewAbortController = null;
    }
}

/**
 * After org tickets are loaded, allow one more for-view attempt if the first pass was empty
 * (e.g. zoom gate or empty cooldown) without forcing a refetch when imagery was already found.
 */
function prepareAerialViewRefetchAfterTickets() {
    clearAerialForViewCache();
}

function hasVisibleTicketForAerialFetch() {
    const mod = window.ticketsModule;
    if (mod && typeof mod.hasTicketInCurrentMapView === 'function') {
        return mod.hasTicketInCurrentMapView();
    }
    return true;
}

/**
 * Fetches for-view maps for the current org and viewport (Enhanced tier, zoom 16+).
 * @returns {Promise<boolean>} true if a new network result was applied
 */
async function syncAerialViewForZoom() {
    if (isPublicCatalogTimeWarpMode() || !isOrgAerialAutoLoadEnabled()) {
        return false;
    }
    const orgId = getQueryOrgId();
    if (!orgId) return false;
    if (!window.map || !window.authModule) return false;

    const tier = getSubscriptionTier();
    if (tier !== 'enhanced') return false;

    const z = window.map.getZoom();
    const apiZoom = getApiZoomForFetch(tier, z);
    if (apiZoom === null) return false;

    const viewBbox = getMapViewBbox();
    if (!viewBbox) return false;

    if (!hasVisibleTicketForAerialFetch()) {
        aerialForViewRequestSeq += 1;
        if (aerialForViewAbortController) {
            aerialForViewAbortController.abort();
            aerialForViewAbortController = null;
        }
        clearAerialForViewCache();
        return false;
    }

    const cacheKey = getAerialForViewCacheKey(orgId, apiZoom, 'auto');
    if (!cacheKey) return false;

    const now = Date.now();
    expireAerialForViewCacheIfStale(now);
    if (
        aerialForViewCachedResult &&
        isAerialForViewCacheFresh(aerialForViewCachedResult.cachedAt, now) &&
        aerialForViewCachedResult.key === cacheKey &&
        bboxContainsBbox(aerialForViewCachedResult.paddedBbox, viewBbox)
    ) {
        aerialForViewRequestSeq += 1;
        if (aerialForViewAbortController) {
            aerialForViewAbortController.abort();
            aerialForViewAbortController = null;
        }
        replacePanelMaps(aerialForViewCachedResult.maps || []);
        await applyAerialMapsForViewport();
        return true;
    }

    const fetchBbox = padBbox(viewBbox, AERIAL_FOR_VIEW_PAD_RATIO) || viewBbox;
    const requestKey = getAerialForViewRequestKey(orgId, apiZoom, fetchBbox);
    if (!requestKey) return false;

    const requestCacheFresh =
        aerialForViewCachedResult && isAerialForViewCacheFresh(aerialForViewCachedResult.cachedAt, now);
    if (lastAerialForViewKey === requestKey && panelMaps.length > 0 && requestCacheFresh) {
        return false;
    }
    if (
        lastAerialForViewKey === requestKey &&
        panelMaps.length === 0 &&
        now < aerialForViewEmptyCooldownUntil &&
        requestCacheFresh
    ) {
        return false;
    }

    const requestSeq = ++aerialForViewRequestSeq;
    if (aerialForViewAbortController) {
        aerialForViewAbortController.abort();
    }
    aerialForViewAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

    try {
        const res = await apiFetchForView({
            zoom: apiZoom,
            bbox: fetchBbox,
            mode: 'auto',
            signal: aerialForViewAbortController ? aerialForViewAbortController.signal : undefined,
        });
        if (requestSeq !== aerialForViewRequestSeq) return false;
        const maps = res.maps || [];
        lastAerialForViewKey = requestKey;
        aerialForViewCachedResult = {
            key: cacheKey,
            paddedBbox: fetchBbox,
            maps,
            cachedAt: now,
        };
        if (maps.length === 0) {
            aerialForViewEmptyCooldownUntil = now + AERIAL_FOR_VIEW_EMPTY_COOLDOWN_MS;
        }

        replacePanelMaps(maps);
        syncFavoriteIdsFromSavedModule();
        timelineIndex = 0;
        await applyAerialMapsForViewport();
        return true;
    } catch (e) {
        if (e && e.name === 'AbortError') return false;
        console.error('Aerial auto-load:', e);
        return false;
    } finally {
        if (requestSeq === aerialForViewRequestSeq) {
            aerialForViewAbortController = null;
        }
    }
}

function initAerialMapPanel() {
    if (!window.map) return;

    if (isPublicCatalogTimeWarpMode()) {
        clearTimeWarpAerialState(true);
        ensurePanelDom();
        applyTimeWarpPublicModeUi(true);
        ensureAerialZoomListener();
        updateTimeWarpUiState();
        return;
    }

    applyTimeWarpPublicModeUi(false);
    clearTimeWarpAerialState(true);
    setPanelVisible(false);

    if (isOrgAerialAutoLoadEnabled()) {
        ensureAerialZoomListener();
        ensureTimeWarpMoveListener();
        void (async () => {
            const changed = await syncAerialViewForZoom();
            if (!changed) await applyAerialMapsForViewport();
        })();
    }
}

/** Sync Time Warp / public-search chrome to the current org immediately on org switch (before ticket reload). */
function syncTimeWarpModeUiEarly() {
    timeWarpPanelLayoutOpen = false;
    mobilePanelOpen = false;
    if (isPublicCatalogTimeWarpMode()) {
        if (window.map) {
            ensurePanelDom();
            applyTimeWarpPublicModeUi(true);
        }
        return;
    }
    applyTimeWarpPublicModeUi(false);
    setPanelVisible(false);
}

function onOrgChanged() {
    timeWarpPanelLayoutOpen = false;
    mobilePanelOpen = false;
    clearTimeWarpAerialState(true);
    resetTimeWarpForm();
    initAerialMapPanel();
}

function initWhenMapReady() {
    if (window.CORE_PRODUCT === true) return;
    if (!window.map) return;
    initAerialMapPanel();
}

window.aerialMapPanelModule = {
    getSubscriptionTier,
    initWhenMapReady,
    onOrgChanged,
    syncTimeWarpModeUiEarly,
    refreshPanelFetch,
    apiFetchForView,
    syncAerialViewForZoom,
    getTimeWarpConstraints,
    refreshTimeWarpOnMap,
    updateTimeWarpUiState,
    invalidateAerialViewCache,
    prepareAerialViewRefetchAfterTickets,
    setFavoriteIdsFromSavedMaps,
    syncPublicAerialTimeline,
};
