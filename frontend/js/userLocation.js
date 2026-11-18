// User location tools: live GPS marker + tracking for the main map (desktop toolbar + mobile top-right).
// Right-click / long-press on the location icon opens a fan: My location vs inline address search.
// Tracking uses watchPosition + short follow pans + light dead reckoning between GPS fixes.

function mapSetViewAnimOpts() {
    return typeof window.getMapSetViewAnimationOptions === 'function'
        ? window.getMapSetViewAnimationOptions(0.5)
        : { animate: true, duration: 0.5 };
}

/** Snappy pan while following the user (shorter than general map setView animations). */
function mapFollowPanOpts() {
    if (window.enableAnimations === false) {
        return { animate: false };
    }
    return { animate: true, duration: 0.18, easeLinearity: 0.9 };
}

const LIVE_LOCATION_WATCH_OPTIONS = {
    enableHighAccuracy: true,
    // Allow slightly stale fixes so updates aren't blocked waiting for brand-new GPS samples.
    maximumAge: 1000,
    timeout: 15000,
};
const LIVE_LOCATION_DEAD_RECKON_HZ = 20;
const LIVE_LOCATION_DEAD_RECKON_MAX_DT_S = 3;
const LIVE_LOCATION_DEAD_RECKON_MIN_SPEED_MPS = 0.4;
const LOCATION_BTN_LOADING_HTML =
    '<span class="location-btn-loading-dots" aria-hidden="true"><span></span><span></span><span></span></span>';

let liveLocationWatchId = null;
let userLiveLocationMarker = null;
let userLiveLocationAccuracyCircle = null;
let mobileLiveLocationUiInitialized = false;
/** When false, ignore geolocation callbacks so a late fix cannot recreate the marker after Stop. */
let liveLocationMarkerSessionActive = false;
let followMeActive = false;
let followMeMapHandlersBound = false;
let annotatePanelEl = null;
let annotatePanelMapListenersBound = false;
let lastKnownUserLat = null;
let lastKnownUserLon = null;
let lastGpsFix = null;
let lastGpsFixAtMs = 0;
let deadReckonTimerId = null;
let awaitingFirstWatchFix = false;
let acquireFixLoadingWhich = null;
/** Temporary pin from location-icon address search (cleared on next search or GPS start). */
let userLocationSearchPin = null;
let locationFanRootEl = null;
let locationFanOpen = false;
/** @type {'desktop'|'mobile'|null} */
let locationFanWhich = null;
/** @type {object|null} */
let locationFanSelectedCounty = null;
/** @type {object[]} */
let locationFanSearchCounties = [];
let locationFanListenersBound = false;
let locationFanSearchInFlight = false;
let locationFanNeedsCountyPicker = false;
/** When true, search uses Photon/Nominatim (no addressSearch county in viewport). */
let locationFanGlobalGeocode = false;

/** @type {Set<(fix: { lat: number, lng: number, accuracy?: number, at: number }) => void>} */
const liveLocationFixSubscribers = new Set();

function notifyLiveLocationFixSubscribers() {
    if (!lastGpsFix) return;
    const fix = {
        lat: lastGpsFix.lat,
        lng: lastGpsFix.lon,
        accuracy: lastGpsFix.accuracy,
        at: lastGpsFixAtMs,
    };
    liveLocationFixSubscribers.forEach(function (cb) {
        try {
            cb(fix);
        } catch (err) {
            console.warn('Live location fix subscriber failed:', err);
        }
    });
}

function getUserLiveLocationFix() {
    if (!isUserLiveLocationActive() || !lastGpsFix) return null;
    return {
        lat: lastGpsFix.lat,
        lng: lastGpsFix.lon,
        accuracy: lastGpsFix.accuracy,
        at: lastGpsFixAtMs,
    };
}

/**
 * @param {(fix: { lat: number, lng: number, accuracy?: number, at: number }) => void} cb
 * @returns {() => void} unsubscribe
 */
function subscribeUserLiveLocationFix(cb) {
    if (typeof cb !== 'function') return function () {};
    liveLocationFixSubscribers.add(cb);
    return function () {
        liveLocationFixSubscribers.delete(cb);
    };
}

function getDefaultFollowMePref() {
    // Default ON unless the user explicitly turns it off in Settings.
    if (!window.userPreferences || window.userPreferences.defaultFollowMe === undefined) {
        return true;
    }
    return window.userPreferences.defaultFollowMe !== false;
}

function isUserLiveLocationActive() {
    return liveLocationWatchId !== null;
}

function getUserLiveLocationDivIcon() {
    return L.divIcon({
        className: 'user-live-location-marker-wrapper user-live-location-marker-wrapper--interactive',
        html: '<div class="user-live-location-marker"><span class="user-live-location-pulse-ring"></span><span class="user-live-location-dot"></span></div>',
        iconSize: [36, 36],
        iconAnchor: [18, 18],
    });
}

function removeUserLiveLocationLayers() {
    if (!window.map) return;
    hideAnnotatePanel();
    if (userLiveLocationMarker) {
        if (window.map.hasLayer(userLiveLocationMarker)) {
            window.map.removeLayer(userLiveLocationMarker);
        }
        userLiveLocationMarker = null;
    }
    if (userLiveLocationAccuracyCircle) {
        if (window.map.hasLayer(userLiveLocationAccuracyCircle)) {
            window.map.removeLayer(userLiveLocationAccuracyCircle);
        }
        userLiveLocationAccuracyCircle = null;
    }
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {{ accuracyMeters?: number, updateAccuracyCircle?: boolean, panFollow?: boolean }} [options]
 */
function updateLiveLocationMarker(lat, lon, options) {
    if (!window.map || !liveLocationMarkerSessionActive) return;
    const opts = options || {};
    lastKnownUserLat = lat;
    lastKnownUserLon = lon;
    const latlng = L.latLng(lat, lon);

    if (opts.updateAccuracyCircle !== false) {
        if (userLiveLocationAccuracyCircle) {
            window.map.removeLayer(userLiveLocationAccuracyCircle);
            userLiveLocationAccuracyCircle = null;
        }
        const accuracyMeters = opts.accuracyMeters;
        if (typeof accuracyMeters === 'number' && accuracyMeters > 0 && isFinite(accuracyMeters)) {
            userLiveLocationAccuracyCircle = L.circle(latlng, {
                radius: accuracyMeters,
                color: 'var(--app-accent)',
                fillColor: 'var(--app-accent)',
                fillOpacity: 0.12,
                weight: 1,
                opacity: 0.45,
            }).addTo(window.map);
        }
    }

    if (userLiveLocationMarker) {
        userLiveLocationMarker.setLatLng(latlng);
    } else {
        userLiveLocationMarker = L.marker(latlng, {
            icon: getUserLiveLocationDivIcon(),
            zIndexOffset: 1200,
        }).addTo(window.map);
        userLiveLocationMarker.on('click', onUserLiveLocationMarkerClick);
    }

    if (annotatePanelEl && !annotatePanelEl.hidden) {
        positionAnnotatePanel();
    }

    if (opts.panFollow) {
        const drawingActive = !!(window.drawingModule && window.drawingModule.currentDrawingMode);
        if (followMeActive && !drawingActive) {
            window.map.panTo(latlng, mapFollowPanOpts());
        }
    }
}

function clearLiveLocationWatch() {
    if (liveLocationWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(liveLocationWatchId);
        liveLocationWatchId = null;
    }
    stopDeadReckonLoop();
    awaitingFirstWatchFix = false;
    acquireFixLoadingWhich = null;
    lastGpsFix = null;
    lastGpsFixAtMs = 0;
}

function clearLiveLocationWatchKeepLoading() {
    if (liveLocationWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(liveLocationWatchId);
        liveLocationWatchId = null;
    }
    stopDeadReckonLoop();
    lastGpsFix = null;
    lastGpsFixAtMs = 0;
}

function setLocationToolActive(active) {
    const desktopBtn = document.getElementById('mapLocationTool');
    const mobileBtn = document.getElementById('mobileLocationButton');
    if (desktopBtn) desktopBtn.classList.toggle('map-toolbar-btn--active', !!active);
    if (mobileBtn) mobileBtn.classList.toggle('map-tools-mobile-top-right-btn--active', !!active);
}

function setFollowMeActive(active) {
    followMeActive = !!active;
}

function bindFollowMeMapHandlers() {
    if (followMeMapHandlersBound || !window.map) return;
    followMeMapHandlersBound = true;
    window.map.on('dragstart', function () {
        if (followMeActive) {
            setFollowMeActive(false);
        }
    });
}

function ensureLocationAddPointButtons() {
    function bindAddPoint(btn) {
        if (!btn || btn.dataset.locationAddPointBound) return;
        btn.dataset.locationAddPointBound = '1';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            addDrawingPointAtCurrentLocation();
        });
    }

    const desktopLocation = document.getElementById('mapLocationTool');
    if (desktopLocation && desktopLocation.parentElement) {
        let desktopBtn = document.getElementById('desktopLocationAddPointBtn');
        if (!desktopBtn) {
            desktopBtn = document.createElement('button');
            desktopBtn.type = 'button';
            desktopBtn.id = 'desktopLocationAddPointBtn';
            desktopBtn.className = 'location-add-point-btn map-toolbar-btn';
            desktopBtn.hidden = true;
            desktopBtn.title = 'Add point at your location';
            desktopBtn.setAttribute('aria-label', 'Add point at your location');
            desktopBtn.textContent = 'Add point';
            desktopLocation.insertAdjacentElement('afterend', desktopBtn);
        }
        bindAddPoint(desktopBtn);
    }

    const mobileLocation = document.getElementById('mobileLocationButton');
    if (mobileLocation && mobileLocation.parentElement) {
        let mobileBtn = document.getElementById('mobileLocationAddPointBtn');
        if (!mobileBtn) {
            mobileBtn = document.createElement('button');
            mobileBtn.type = 'button';
            mobileBtn.id = 'mobileLocationAddPointBtn';
            mobileBtn.className = 'location-add-point-btn map-tools-mobile-top-right-btn location-add-point-btn--mobile';
            mobileBtn.hidden = true;
            mobileBtn.title = 'Add point at your location';
            mobileBtn.setAttribute('aria-label', 'Add point at your location');
            mobileBtn.textContent = 'Add point';
            mobileLocation.insertAdjacentElement('afterend', mobileBtn);
        }
        bindAddPoint(mobileBtn);
    }
}

function hideLocationAddPointButton() {
    const desktopBtn = document.getElementById('desktopLocationAddPointBtn');
    const mobileBtn = document.getElementById('mobileLocationAddPointBtn');
    if (desktopBtn) {
        desktopBtn.hidden = true;
        desktopBtn.setAttribute('aria-hidden', 'true');
    }
    if (mobileBtn) {
        mobileBtn.hidden = true;
        mobileBtn.setAttribute('aria-hidden', 'true');
    }
}

function showLocationAddPointButton() {
    ensureLocationAddPointButtons();
    const desktopBtn = document.getElementById('desktopLocationAddPointBtn');
    const mobileBtn = document.getElementById('mobileLocationAddPointBtn');
    if (desktopBtn) {
        desktopBtn.hidden = false;
        desktopBtn.removeAttribute('aria-hidden');
    }
    if (mobileBtn) {
        mobileBtn.hidden = false;
        mobileBtn.removeAttribute('aria-hidden');
    }
}

function addDrawingPointAtCurrentLocation() {
    if (lastKnownUserLat == null || lastKnownUserLon == null) return;
    const drawing = window.drawingModule;
    if (!drawing || typeof drawing.appendDrawingPoint !== 'function') return;
    drawing.appendDrawingPoint(L.latLng(lastKnownUserLat, lastKnownUserLon));
}

function ensureAnnotatePanel() {
    if (annotatePanelEl) return annotatePanelEl;
    const mapRoot = document.querySelector('.map-container') || document.getElementById('map');
    if (!mapRoot) return null;

    annotatePanelEl = document.createElement('div');
    annotatePanelEl.id = 'userLocationAnnotatePanel';
    annotatePanelEl.className = 'user-location-annotate-panel';
    annotatePanelEl.hidden = true;
    annotatePanelEl.setAttribute('role', 'menu');
    annotatePanelEl.setAttribute('aria-label', 'Annotate at your location');
    annotatePanelEl.innerHTML =
        '<div class="user-location-annotate-panel-inner">' +
        '<button type="button" class="user-location-annotate-panel-btn" data-annotate-mode="point">Point</button>' +
        '<button type="button" class="user-location-annotate-panel-btn" data-annotate-mode="line">Line</button>' +
        '<button type="button" class="user-location-annotate-panel-btn" data-annotate-mode="polygon">Polygon</button>' +
        '</div>' +
        '<span class="user-location-annotate-panel-tail" aria-hidden="true"></span>';

    annotatePanelEl.querySelectorAll('[data-annotate-mode]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            L.DomEvent.stop(e);
            const mode = btn.getAttribute('data-annotate-mode');
            hideAnnotatePanel();
            if (lastKnownUserLat == null || lastKnownUserLon == null) return;
            if (window.annotationsModule && typeof window.annotationsModule.annotateAtUserLocation === 'function') {
                window.annotationsModule.annotateAtUserLocation(lastKnownUserLat, lastKnownUserLon, mode);
            }
        });
    });

    annotatePanelEl.addEventListener('click', function (e) {
        L.DomEvent.stopPropagation(e);
    });

    mapRoot.appendChild(annotatePanelEl);
    return annotatePanelEl;
}

function bindAnnotatePanelMapListeners() {
    if (annotatePanelMapListenersBound || !window.map) return;
    annotatePanelMapListenersBound = true;
    const hide = function () {
        hideAnnotatePanel();
    };
    window.map.on('move zoom resize', positionAnnotatePanel);
    window.map.on('click', hide);
    document.addEventListener('click', function (e) {
        if (!annotatePanelEl || annotatePanelEl.hidden) return;
        if (annotatePanelEl.contains(e.target)) return;
        if (userLiveLocationMarker && userLiveLocationMarker.getElement &&
            userLiveLocationMarker.getElement() && userLiveLocationMarker.getElement().contains(e.target)) {
            return;
        }
        hideAnnotatePanel();
    });
}

function positionAnnotatePanel() {
    if (!annotatePanelEl || annotatePanelEl.hidden || !userLiveLocationMarker || !window.map) return;
    const mapRoot = annotatePanelEl.offsetParent || annotatePanelEl.parentElement;
    if (!mapRoot) return;
    const rootRect = mapRoot.getBoundingClientRect();
    const markerEl = userLiveLocationMarker.getElement && userLiveLocationMarker.getElement();
    if (!markerEl) return;
    const markerRect = markerEl.getBoundingClientRect();
    const panelWidth = annotatePanelEl.offsetWidth || annotatePanelEl.getBoundingClientRect().width;
    const panelHeight = annotatePanelEl.offsetHeight || annotatePanelEl.getBoundingClientRect().height;
    const left = markerRect.left - rootRect.left + markerRect.width / 2 - panelWidth / 2;
    const top = markerRect.top - rootRect.top - panelHeight - 10;
    annotatePanelEl.style.left = Math.round(left) + 'px';
    annotatePanelEl.style.top = Math.round(Math.max(8, top)) + 'px';
}

function showAnnotatePanel() {
    const panel = ensureAnnotatePanel();
    if (!panel || lastKnownUserLat == null || lastKnownUserLon == null) return;
    bindAnnotatePanelMapListeners();
    panel.hidden = false;
    positionAnnotatePanel();
    requestAnimationFrame(positionAnnotatePanel);
}

function hideAnnotatePanel() {
    if (annotatePanelEl) annotatePanelEl.hidden = true;
}

function onUserLiveLocationMarkerClick(e) {
    if (typeof L !== 'undefined' && L.DomEvent) {
        L.DomEvent.stopPropagation(e);
    }
    if (!liveLocationMarkerSessionActive) return;
    if (annotatePanelEl && !annotatePanelEl.hidden) {
        hideAnnotatePanel();
        return;
    }
    showAnnotatePanel();
}

function stopDeadReckonLoop() {
    if (deadReckonTimerId !== null) {
        clearInterval(deadReckonTimerId);
        deadReckonTimerId = null;
    }
}

function startDeadReckonLoop() {
    stopDeadReckonLoop();
    deadReckonTimerId = setInterval(tickDeadReckoning, 1000 / LIVE_LOCATION_DEAD_RECKON_HZ);
}

function tickDeadReckoning() {
    if (!liveLocationMarkerSessionActive || !lastGpsFix || !window.map) return;
    const speed = lastGpsFix.speed;
    const heading = lastGpsFix.heading;
    if (speed == null || !isFinite(speed) || speed < LIVE_LOCATION_DEAD_RECKON_MIN_SPEED_MPS) return;
    if (heading == null || !isFinite(heading)) return;

    let dt = (Date.now() - lastGpsFixAtMs) / 1000;
    if (dt <= 0) return;
    if (dt > LIVE_LOCATION_DEAD_RECKON_MAX_DT_S) dt = LIVE_LOCATION_DEAD_RECKON_MAX_DT_S;

    const rad = (heading * Math.PI) / 180;
    const dist = speed * dt;
    const lat1 = (lastGpsFix.lat * Math.PI) / 180;
    const lng1 = (lastGpsFix.lon * Math.PI) / 180;
    const R = 6371000;
    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(dist / R) +
            Math.cos(lat1) * Math.sin(dist / R) * Math.cos(rad)
    );
    const lng2 =
        lng1 +
        Math.atan2(
            Math.sin(rad) * Math.sin(dist / R) * Math.cos(lat1),
            Math.cos(dist / R) - Math.sin(lat1) * Math.sin(lat2)
        );

    updateLiveLocationMarker((lat2 * 180) / Math.PI, (lng2 * 180) / Math.PI, {
        updateAccuracyCircle: false,
        panFollow: true,
    });
    notifyLiveLocationFixSubscribers();
}

function onLiveLocationWatchSuccess(position) {
    if (!liveLocationMarkerSessionActive && !awaitingFirstWatchFix) return;
    if (!window.map) return;

    const coords = position.coords;
    const lat = coords.latitude;
    const lon = coords.longitude;
    const acc = coords.accuracy;
    const now = Date.now();

    lastGpsFix = {
        lat: lat,
        lon: lon,
        accuracy: acc,
        speed: coords.speed,
        heading: coords.heading,
    };
    lastGpsFixAtMs = now;

    if (awaitingFirstWatchFix) {
        awaitingFirstWatchFix = false;
        const which = acquireFixLoadingWhich;
        acquireFixLoadingWhich = null;
        if (which) setLocationLoadingUI(which, false);

        liveLocationMarkerSessionActive = true;
        setFollowMeActive(getDefaultFollowMePref());
        updateLiveLocationMarker(lat, lon, {
            accuracyMeters: acc,
            updateAccuracyCircle: true,
            panFollow: false,
        });
        window.map.setView([lat, lon], 15, mapSetViewAnimOpts());
        setLocationToolActive(true);
        startDeadReckonLoop();
        notifyLiveLocationFixSubscribers();
        return;
    }

    if (!liveLocationMarkerSessionActive) return;
    updateLiveLocationMarker(lat, lon, {
        accuracyMeters: acc,
        updateAccuracyCircle: true,
        panFollow: true,
    });
    notifyLiveLocationFixSubscribers();
}

function onLiveLocationWatchError(error) {
    if (awaitingFirstWatchFix) {
        const which = acquireFixLoadingWhich;
        awaitingFirstWatchFix = false;
        acquireFixLoadingWhich = null;
        clearLiveLocationWatch();
        liveLocationMarkerSessionActive = false;
        if (which) setLocationLoadingUI(which, false);
        void appAlert('Unable to get your location: ' + (error && error.message ? error.message : 'unknown error'));
        return;
    }
    console.warn('Live location update failed:', error && error.message ? error.message : error);
}

function startLiveLocationWatch() {
    if (!navigator.geolocation || !window.map) return;
    clearLiveLocationWatchKeepLoading();
    bindFollowMeMapHandlers();
    awaitingFirstWatchFix = true;
    liveLocationWatchId = navigator.geolocation.watchPosition(
        onLiveLocationWatchSuccess,
        onLiveLocationWatchError,
        LIVE_LOCATION_WATCH_OPTIONS
    );
}

function stopMobileLiveLocation() {
    liveLocationMarkerSessionActive = false;
    setFollowMeActive(false);
    if (acquireFixLoadingWhich) {
        setLocationLoadingUI(acquireFixLoadingWhich, false);
    }
    clearLiveLocationWatch();
    removeUserLiveLocationLayers();
    hideLocationAddPointButton();
    setLocationToolActive(false);
    lastKnownUserLat = null;
    lastKnownUserLon = null;
}

function setLocationLoadingUI(which, visible) {
    const isDesktop = which === 'desktop';
    const btn = document.getElementById(isDesktop ? 'mapLocationTool' : 'mobileLocationButton');
    if (!btn) return;
    if (visible) {
        if (!btn.dataset.locationIconHtml) {
            btn.dataset.locationIconHtml = btn.innerHTML;
        }
        btn.innerHTML = LOCATION_BTN_LOADING_HTML;
        btn.classList.add('location-btn--loading');
        // Keep clickable so the user can cancel while acquiring a fix.
        btn.setAttribute('aria-busy', 'true');
    } else {
        if (btn.dataset.locationIconHtml) {
            btn.innerHTML = btn.dataset.locationIconHtml;
        }
        btn.classList.remove('location-btn--loading');
        btn.removeAttribute('aria-busy');
    }
}

function clearUserLocationSearchPin() {
    if (userLocationSearchPin && window.map && window.map.hasLayer(userLocationSearchPin)) {
        window.map.removeLayer(userLocationSearchPin);
    }
    userLocationSearchPin = null;
}

function centerMapOnSearchResult(lat, lon) {
    if (!window.map || typeof L === 'undefined' || !isFinite(lat) || !isFinite(lon)) return;
    clearUserLocationSearchPin();
    userLocationSearchPin = L.marker([lat, lon], {
        icon: L.divIcon({
            className: 'search-marker',
            html:
                '<div style="background-color: var(--app-accent); width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
        }),
        zIndexOffset: 1100,
    }).addTo(window.map);
    window.map.setView([lat, lon], 17, mapSetViewAnimOpts());
}

function countySupportsAddressSearch(county) {
    return !!(county && Array.isArray(county.features) && county.features.indexOf('addressSearch') !== -1);
}

/**
 * Counties in viewport that support address search.
 * @returns {Promise<object[]>}
 */
async function getAddressSearchCountiesInViewport() {
    const coverage = window.mapCountyCoverageModule;
    const map = window.map;
    if (!coverage || !map || typeof coverage.countiesForBounds !== 'function') {
        return [];
    }
    const inViewport = await coverage.countiesForBounds(map.getBounds());
    return (inViewport || []).filter(countySupportsAddressSearch);
}

/**
 * Default county when unambiguous; null when user must pick from chips.
 * @returns {Promise<{ counties: object[], selected: object|null, needsPicker: boolean }>}
 */
async function resolveLocationFanSearchCountyState() {
    const counties = await getAddressSearchCountiesInViewport();
    if (counties.length === 0) {
        return { counties: [], selected: null, needsPicker: false };
    }
    if (counties.length === 1) {
        return { counties: counties, selected: counties[0], needsPicker: false };
    }
    const coverage = window.mapCountyCoverageModule;
    const map = window.map;
    if (coverage && map && typeof coverage.resolveSearchCounty === 'function') {
        const atCenter = await coverage.resolveSearchCounty(map);
        if (atCenter && countySupportsAddressSearch(atCenter)) {
            return { counties: counties, selected: atCenter, needsPicker: false };
        }
    }
    return { counties: counties, selected: null, needsPicker: true };
}

function getLocationFanTriggerButton() {
    if (locationFanWhich === 'mobile') {
        return document.getElementById('mobileLocationButton');
    }
    return document.getElementById('mapLocationTool');
}

function positionLocationFanAnchor() {
    if (!locationFanRootEl) return;
    const anchor = locationFanRootEl.querySelector('.location-fan-anchor');
    const trigger = getLocationFanTriggerButton();
    if (!anchor || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 8;
    anchor.style.top = rect.top + 'px';
    anchor.style.right = window.innerWidth - rect.right + 'px';
    anchor.style.left = 'auto';
    anchor.style.bottom = 'auto';
    const searchOpen = locationFanRootEl.classList.contains('location-fan-root--search-open');
    if (searchOpen) {
        anchor.style.maxHeight = '';
        anchor.style.overflowY = 'visible';
    } else {
        anchor.style.maxHeight =
            'calc(100vh - ' + Math.max(rect.top, gap) + 'px - env(safe-area-inset-top, 0px))';
        anchor.style.overflowY = 'auto';
    }
}

function renderLocationFanCountyChips() {
    if (!locationFanRootEl) return;
    const chipsWrap = locationFanRootEl.querySelector('[data-location-fan-county-chips]');
    if (!chipsWrap) return;
    chipsWrap.innerHTML = '';
    if (locationFanSearchCounties.length <= 1 || !locationFanNeedsCountyPicker) {
        chipsWrap.hidden = true;
        return;
    }
    chipsWrap.hidden = false;
    locationFanSearchCounties.forEach(function (county) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'location-fan-county-chip';
        if (locationFanSelectedCounty && locationFanSelectedCounty.id === county.id) {
            chip.classList.add('location-fan-county-chip--active');
        }
        chip.textContent = county.label || county.id;
        chip.addEventListener('click', function (e) {
            e.stopPropagation();
            locationFanSelectedCounty = county;
            locationFanNeedsCountyPicker = false;
            setLocationFanSearchHint('');
            renderLocationFanCountyChips();
            const input = locationFanRootEl.querySelector('[data-location-fan-search-input]');
            if (input) input.focus();
        });
        chipsWrap.appendChild(chip);
    });
}

function setLocationFanSearchHint(message) {
    if (!locationFanRootEl) return;
    const hint = locationFanRootEl.querySelector('[data-location-fan-search-hint]');
    const inputWrap = locationFanRootEl.querySelector('[data-location-fan-search-input-wrap]');
    if (!hint) return;
    if (message) {
        hint.textContent = message;
        hint.hidden = false;
        if (inputWrap) inputWrap.hidden = true;
    } else {
        hint.hidden = true;
        hint.textContent = '';
        if (inputWrap) inputWrap.hidden = false;
    }
}

function clearLocationFanSuggestions() {
    if (!locationFanRootEl) return;
    const suggestions = locationFanRootEl.querySelector('[data-location-fan-suggestions]');
    if (suggestions) {
        suggestions.innerHTML = '';
        suggestions.classList.remove('show');
    }
}

function setLocationFanSearchLoading(loading) {
    if (!locationFanRootEl) return;
    const input = locationFanRootEl.querySelector('[data-location-fan-search-input]');
    const loadingEl = locationFanRootEl.querySelector('[data-location-fan-search-loading]');
    const suggestions = locationFanRootEl.querySelector('[data-location-fan-suggestions]');
    if (input) {
        input.disabled = !!loading;
        if (loading) input.setAttribute('aria-busy', 'true');
        else input.removeAttribute('aria-busy');
    }
    if (loadingEl) {
        if (loading) loadingEl.removeAttribute('hidden');
        else loadingEl.setAttribute('hidden', '');
    }
    if (loading && suggestions) {
        suggestions.innerHTML = '';
        suggestions.classList.remove('show');
    }
}

function applyLocationFanSearchSelection(sel) {
    const lat = parseFloat(sel.lat);
    const lon = parseFloat(sel.lon);
    if (!isFinite(lat) || !isFinite(lon)) return;
    if (isUserLiveLocationActive() || awaitingFirstWatchFix) {
        stopMobileLiveLocation();
    }
    centerMapOnSearchResult(lat, lon);
    closeUserLocationFan();
}

async function runLocationFanSearchQuery() {
    const geo = window.geocodeSearchModule;
    if (!locationFanRootEl || !geo) return;
    const input = locationFanRootEl.querySelector('[data-location-fan-search-input]');
    const suggestions = locationFanRootEl.querySelector('[data-location-fan-suggestions]');
    if (!input || !suggestions) return;

    const minLen = typeof geo.MIN_QUERY_LENGTH === 'number' ? geo.MIN_QUERY_LENGTH : 3;
    const q = String(input.value || '').trim();
    clearLocationFanSuggestions();
    if (q.length < minLen) {
        geo.showGeocodeMessage(
            suggestions,
            'Enter at least ' + minLen + ' characters, then press Enter.',
            'var(--app-text-secondary)'
        );
        return;
    }
    if (locationFanSearchInFlight) return;
    const fetchSuggestions =
        typeof geo.fetchMapToolbarAddressSuggestions === 'function'
            ? geo.fetchMapToolbarAddressSuggestions.bind(geo)
            : null;
    if (!fetchSuggestions) {
        geo.showGeocodeMessage(suggestions, 'Address search is not available.', 'var(--app-danger)');
        return;
    }
    locationFanSearchInFlight = true;
    setLocationFanSearchLoading(true);
    try {
        const countyState = await resolveLocationFanSearchCountyState();
        locationFanSearchCounties = countyState.counties;
        if (!countyState.counties.length) {
            locationFanGlobalGeocode = true;
            locationFanNeedsCountyPicker = false;
        } else {
            locationFanGlobalGeocode = false;
            locationFanNeedsCountyPicker = countyState.needsPicker;
            if (countyState.needsPicker) {
                if (!locationFanSelectedCounty) {
                    geo.showGeocodeMessage(suggestions, 'Choose a county to search.', 'var(--app-text-secondary)');
                    return;
                }
            } else {
                locationFanSelectedCounty = countyState.selected;
            }
        }
        if (!locationFanGlobalGeocode && !locationFanSelectedCounty) {
            geo.showGeocodeMessage(suggestions, 'Choose a county to search.', 'var(--app-text-secondary)');
            return;
        }
        const countyForFetch = locationFanGlobalGeocode ? null : locationFanSelectedCounty;
        const results = await fetchSuggestions(q, 8, window.map, countyForFetch);
        if (!results || !results.length) {
            geo.showGeocodeMessage(suggestions, 'No results found.', 'var(--app-text-secondary)');
            return;
        }
        if (results.length === 1) {
            const item = results[0];
            const displayName = geo.geocodeResultDisplayName(item);
            const lat = parseFloat(item.lat);
            const lon = parseFloat(item.lon);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                applyLocationFanSearchSelection({ displayName: displayName, lat: lat, lon: lon, raw: item });
                return;
            }
        }
        geo.renderGeocodeSuggestionList(suggestions, results, applyLocationFanSearchSelection);
    } catch (err) {
        console.warn('Location address search failed:', err);
        geo.showGeocodeMessage(
            suggestions,
            'Error searching for address. Please try again.',
            'var(--app-danger)'
        );
    } finally {
        locationFanSearchInFlight = false;
        setLocationFanSearchLoading(false);
    }
}

async function openLocationFanSearchPanel() {
    if (!locationFanRootEl) return;
    const panel = locationFanRootEl.querySelector('[data-location-fan-search-panel]');
    if (panel) panel.hidden = false;
    locationFanRootEl.classList.add('location-fan-root--search-open');
    positionLocationFanAnchor();
    clearLocationFanSuggestions();
    setLocationFanSearchHint('');
    locationFanSelectedCounty = null;
    locationFanSearchCounties = [];
    locationFanNeedsCountyPicker = false;
    locationFanGlobalGeocode = false;

    const state = await resolveLocationFanSearchCountyState();
    locationFanSearchCounties = state.counties;
    locationFanSelectedCounty = state.selected;
    locationFanNeedsCountyPicker = state.needsPicker;

    if (!state.counties.length) {
        locationFanGlobalGeocode = true;
        renderLocationFanCountyChips();
        const inputGlobal = locationFanRootEl.querySelector('[data-location-fan-search-input]');
        if (inputGlobal && !inputGlobal.disabled) {
            inputGlobal.value = '';
            inputGlobal.focus();
        }
        return;
    }
    if (state.needsPicker) {
        setLocationFanSearchHint('Choose a county, then search.');
    }
    renderLocationFanCountyChips();

    const input = locationFanRootEl.querySelector('[data-location-fan-search-input]');
    if (input && !input.disabled) {
        input.value = '';
        input.focus();
    }
}

function showLocationFanBubbles() {
    if (!locationFanRootEl) return;
    locationFanRootEl.classList.remove('location-fan-root--search-open');
    const panel = locationFanRootEl.querySelector('[data-location-fan-search-panel]');
    if (panel) panel.hidden = true;
    clearLocationFanSuggestions();
    setLocationFanSearchHint('');
    positionLocationFanAnchor();
}

function closeUserLocationFan() {
    if (!locationFanRootEl) return;
    setLocationFanSearchLoading(false);
    locationFanOpen = false;
    locationFanWhich = null;
    locationFanSelectedCounty = null;
    locationFanSearchCounties = [];
    locationFanNeedsCountyPicker = false;
    locationFanGlobalGeocode = false;
    locationFanRootEl.hidden = true;
    locationFanRootEl.classList.remove('location-fan-root--open', 'location-fan-root--search-open');
    clearLocationFanSuggestions();
}

function ensureLocationFanDom() {
    if (locationFanRootEl) return locationFanRootEl;
    const mapRoot = document.querySelector('.map-container') || document.getElementById('map');
    if (!mapRoot) return null;

    locationFanRootEl = document.createElement('div');
    locationFanRootEl.id = 'userLocationFanRoot';
    locationFanRootEl.className = 'location-fan-root';
    locationFanRootEl.hidden = true;
    locationFanRootEl.setAttribute('role', 'dialog');
    locationFanRootEl.setAttribute('aria-label', 'Location options');
    locationFanRootEl.innerHTML =
        '<div class="location-fan-backdrop" data-location-fan-backdrop></div>' +
        '<div class="location-fan-anchor">' +
        '<div class="location-fan-bubbles">' +
        '<button type="button" class="location-fan-bubble" data-location-fan="search">' +
        '<span class="location-fan-bubble-label">Search address</span>' +
        '<span class="location-fan-bubble-icon" aria-hidden="true">⌕</span>' +
        '</button>' +
        '<button type="button" class="location-fan-bubble" data-location-fan="gps">' +
        '<span class="location-fan-bubble-label">My location</span>' +
        '<span class="location-fan-bubble-icon" aria-hidden="true">◎</span>' +
        '</button>' +
        '</div>' +
        '<div class="location-fan-search" data-location-fan-search-panel hidden>' +
        '<p class="location-fan-search-title">Search address</p>' +
        '<p class="location-fan-search-hint" data-location-fan-search-hint hidden></p>' +
        '<div class="location-fan-county-chips" data-location-fan-county-chips hidden></div>' +
        '<div class="address-search-container location-fan-search-input-wrap" data-location-fan-search-input-wrap>' +
        '<input type="search" class="address-input" data-location-fan-search-input ' +
        'placeholder="Address or intersection" autocomplete="off" enterkeyhint="search" />' +
        '<div class="location-loading-indicator location-fan-search-loading" data-location-fan-search-loading hidden>' +
        '<span class="location-loading-spinner" aria-hidden="true"></span>' +
        '<span>Searching for address…</span>' +
        '</div>' +
        '<div class="address-suggestions" data-location-fan-suggestions></div>' +
        '</div>' +
        '</div>' +
        '</div>';

    mapRoot.appendChild(locationFanRootEl);

    const backdrop = locationFanRootEl.querySelector('[data-location-fan-backdrop]');
    if (backdrop) {
        backdrop.addEventListener('click', function () {
            closeUserLocationFan();
        });
    }

    locationFanRootEl.querySelectorAll('[data-location-fan]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const action = btn.getAttribute('data-location-fan');
            if (action === 'gps') {
                ensureGpsFromSourceMenu(locationFanWhich || 'desktop');
                closeUserLocationFan();
                return;
            }
            if (action === 'search') {
                const panel = locationFanRootEl.querySelector('[data-location-fan-search-panel]');
                if (panel) panel.hidden = false;
                void openLocationFanSearchPanel();
            }
        });
    });

    const searchPanel = locationFanRootEl.querySelector('[data-location-fan-search-panel]');
    if (searchPanel) {
        searchPanel.addEventListener('click', function (e) {
            e.stopPropagation();
        });
    }

    const input = locationFanRootEl.querySelector('[data-location-fan-search-input]');
    if (input) {
        input.addEventListener('input', function () {
            clearLocationFanSuggestions();
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                void runLocationFanSearchQuery();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                if (locationFanRootEl.classList.contains('location-fan-root--search-open')) {
                    showLocationFanBubbles();
                    const panel = locationFanRootEl.querySelector('[data-location-fan-search-panel]');
                    if (panel) panel.hidden = true;
                } else {
                    closeUserLocationFan();
                }
            }
        });
    }

    if (!locationFanListenersBound) {
        locationFanListenersBound = true;
        document.addEventListener('keydown', function (e) {
            if (!locationFanOpen || e.key !== 'Escape') return;
            if (locationFanRootEl && locationFanRootEl.classList.contains('location-fan-root--search-open')) {
                e.preventDefault();
                showLocationFanBubbles();
                const panel = locationFanRootEl.querySelector('[data-location-fan-search-panel]');
                if (panel) panel.hidden = true;
                return;
            }
            e.preventDefault();
            closeUserLocationFan();
        });
        window.addEventListener('resize', function () {
            if (locationFanOpen) positionLocationFanAnchor();
        });
        window.addEventListener(
            'scroll',
            function () {
                if (locationFanOpen) positionLocationFanAnchor();
            },
            true
        );
    }

    return locationFanRootEl;
}

/**
 * Right-click / long-press on the location icon: fan with My location vs Search address.
 * @param {'desktop'|'mobile'} [which]
 */
function showUserLocationSourceMenu(which) {
    const root = ensureLocationFanDom();
    if (!root) return;
    const trigger = which === 'mobile' ? document.getElementById('mobileLocationButton') : document.getElementById('mapLocationTool');
    if (!trigger) return;

    if (locationFanOpen) {
        closeUserLocationFan();
        return;
    }

    locationFanWhich = which === 'mobile' ? 'mobile' : 'desktop';
    locationFanOpen = true;
    showLocationFanBubbles();
    const panel = root.querySelector('[data-location-fan-search-panel]');
    if (panel) panel.hidden = true;
    root.hidden = false;
    requestAnimationFrame(function () {
        root.classList.add('location-fan-root--open');
        positionLocationFanAnchor();
    });
}

function openUserLocationFan(which) {
    showUserLocationSourceMenu(which);
}

/** Fan path: start GPS if idle; if already tracking, keep session and recenter. Never stops GPS. */
function ensureGpsFromSourceMenu(which) {
    clearUserLocationSearchPin();
    if (isUserLiveLocationActive() || awaitingFirstWatchFix) {
        if (lastKnownUserLat != null && lastKnownUserLon != null && window.map) {
            const zoom = Math.max(window.map.getZoom() || 15, 15);
            window.map.setView([lastKnownUserLat, lastKnownUserLon], zoom, mapSetViewAnimOpts());
            if (getDefaultFollowMePref()) {
                setFollowMeActive(true);
            }
        }
        return;
    }
    acquireFixAndTrack(which === 'mobile' ? 'mobile' : 'desktop');
}

function acquireFixAndTrack(which) {
    if (!navigator.geolocation) {
        void appAlert('Geolocation is not supported by your browser');
        return;
    }
    if (!window.map) {
        void appAlert('Map is not ready');
        return;
    }

    clearUserLocationSearchPin();
    stopMobileLiveLocation();
    acquireFixLoadingWhich = which;
    setLocationLoadingUI(which, true);
    startLiveLocationWatch();
}

/** One-shot: center map on current GPS fix without starting live tracking. */
function centerMapOnCurrentLocationOnce(callbacks) {
    callbacks = callbacks || {};
    if (!navigator.geolocation) {
        if (typeof callbacks.onError === 'function') {
            callbacks.onError(new Error('Geolocation is not supported by your browser'));
        }
        return;
    }
    if (!window.map) {
        if (typeof callbacks.onError === 'function') {
            callbacks.onError(new Error('Map is not ready'));
        }
        return;
    }
    navigator.geolocation.getCurrentPosition(
        function (position) {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            if (!callbacks.skipMapPan) {
                const zoom = callbacks.zoom != null ? callbacks.zoom : 17;
                window.map.setView([lat, lon], zoom, mapSetViewAnimOpts());
            }
            if (typeof callbacks.onSuccess === 'function') {
                callbacks.onSuccess({
                    lat: lat,
                    lon: lon,
                    accuracy: position.coords.accuracy,
                });
            }
        },
        function (error) {
            const msg = error && error.message ? error.message : 'Unable to get location';
            if (typeof callbacks.onError === 'function') {
                callbacks.onError(new Error(msg));
            }
        },
        {
            enableHighAccuracy: true,
            maximumAge: 60000,
            timeout: 15000,
        }
    );
}

/** Mobile top-right control: jump to current location and keep tracking. */
function useCurrentLocationMobile() {
    acquireFixAndTrack('mobile');
}

/** Desktop toolbar toggle: first click starts live tracking, second click stops. */
function toggleUserLocationTracking() {
    if (isUserLiveLocationActive() || awaitingFirstWatchFix) {
        stopMobileLiveLocation();
        return;
    }
    acquireFixAndTrack('desktop');
}

function initMobileLiveLocationUI() {
    if (mobileLiveLocationUiInitialized) return;
    mobileLiveLocationUiInitialized = true;
    window.addEventListener('pagehide', stopMobileLiveLocation);
}

window.centerMapOnCurrentLocationOnce = centerMapOnCurrentLocationOnce;
window.toggleUserLocationTracking = toggleUserLocationTracking;
window.useCurrentLocationMobile = useCurrentLocationMobile;
window.stopMobileLiveLocation = stopMobileLiveLocation;
window.isUserLiveLocationActive = isUserLiveLocationActive;
window.initMobileLiveLocationUI = initMobileLiveLocationUI;
window.showLocationAddPointButton = showLocationAddPointButton;
window.hideLocationAddPointButton = hideLocationAddPointButton;
window.showUserLocationSourceMenu = showUserLocationSourceMenu;
window.openUserLocationFan = openUserLocationFan;
window.closeUserLocationFan = closeUserLocationFan;
window.getUserLiveLocationFix = getUserLiveLocationFix;
window.subscribeUserLiveLocationFix = subscribeUserLiveLocationFix;
