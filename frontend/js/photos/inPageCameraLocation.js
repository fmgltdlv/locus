// In-page camera location: watchPosition (or reuse main-map live fix), device compass, bottom-left micromap.

const IPC_GEO_WATCH_OPTIONS = {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
};

let ipcLocActive = false;
/** @type {{ lat: number, lng: number, accuracy?: number, heading?: number, headingSource?: string, at: number } | null} */
let ipcLocFix = null;
let ipcLocGeoWatchId = null;
let ipcLocUsingSharedFix = false;
/** @type {(() => void) | null} */
let ipcLocUnsubscribeLiveFix = null;
/** @type {Set<(fix: object | null) => void>} */
const ipcLocFixListeners = new Set();

/** @type {ReturnType<typeof window.photoMicromap.create>|null} */
let ipcLocMicromapHandle = null;

function ipcLocNormalizeHeading(deg) {
    if (!isFinite(deg)) return null;
    let h = deg % 360;
    if (h < 0) h += 360;
    return h;
}

function ipcLocNotifyFixChange() {
    ipcLocFixListeners.forEach(function (cb) {
        try {
            cb(ipcLocFix);
        } catch (err) {
            console.warn('inPageCameraLocation fix listener failed:', err);
        }
    });
}

function ipcLocApplyFix(partial) {
    ipcLocFix = Object.assign({}, ipcLocFix || {}, partial, { at: Date.now() });
    ipcLocNotifyFixChange();
    ipcLocUpdateMicromap();
}

function ipcLocOnGeoPosition(pos) {
    if (!ipcLocActive || !pos || !pos.coords) return;
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    if (!isFinite(lat) || !isFinite(lng)) return;
    ipcLocApplyFix({ lat: lat, lng: lng, accuracy: pos.coords.accuracy });
}

function ipcLocStartOwnGeoWatch() {
    if (!navigator.geolocation || ipcLocGeoWatchId != null) return;
    ipcLocGeoWatchId = navigator.geolocation.watchPosition(
        ipcLocOnGeoPosition,
        function () {},
        IPC_GEO_WATCH_OPTIONS
    );
}

function ipcLocStopOwnGeoWatch() {
    if (ipcLocGeoWatchId != null && navigator.geolocation) {
        navigator.geolocation.clearWatch(ipcLocGeoWatchId);
        ipcLocGeoWatchId = null;
    }
}

function ipcLocTryUseSharedLiveFix() {
    if (typeof window.getUserLiveLocationFix !== 'function') return false;
    const shared = window.getUserLiveLocationFix();
    if (!shared || !isFinite(shared.lat) || !isFinite(shared.lng)) return false;

    ipcLocUsingSharedFix = true;
    ipcLocApplyFix({ lat: shared.lat, lng: shared.lng, accuracy: shared.accuracy });

    if (typeof window.subscribeUserLiveLocationFix === 'function') {
        ipcLocUnsubscribeLiveFix = window.subscribeUserLiveLocationFix(function (fix) {
            if (!ipcLocActive || !fix) return;
            ipcLocApplyFix({ lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy });
        });
    }
    return true;
}

function ipcLocOnDeviceOrientation(e) {
    if (!ipcLocActive) return;
    if (e.webkitCompassHeading != null && isFinite(e.webkitCompassHeading)) {
        const heading = ipcLocNormalizeHeading(e.webkitCompassHeading);
        if (heading != null) {
            ipcLocApplyFix({ heading: heading, headingSource: 'Compass' });
        }
        return;
    }
    if (!ipcLocCompassUsesAbsolute && e.alpha != null && isFinite(e.alpha)) {
        const heading = ipcLocNormalizeHeading(360 - e.alpha);
        if (heading != null) {
            ipcLocApplyFix({ heading: heading, headingSource: 'Compass' });
        }
    }
}

function ipcLocOnDeviceOrientationAbsolute(e) {
    if (!ipcLocActive || !ipcLocCompassUsesAbsolute) return;
    if (e.alpha != null && isFinite(e.alpha)) {
        const heading = ipcLocNormalizeHeading(360 - e.alpha);
        if (heading != null) {
            ipcLocApplyFix({ heading: heading, headingSource: 'Compass' });
        }
    }
}

let ipcLocCompassBound = false;
let ipcLocCompassUsesAbsolute = false;

function ipcLocStartCompass() {
    if (ipcLocCompassBound) return;
    ipcLocCompassUsesAbsolute = 'ondeviceorientationabsolute' in window;
    window.addEventListener('deviceorientation', ipcLocOnDeviceOrientation, true);
    if (ipcLocCompassUsesAbsolute) {
        window.addEventListener('deviceorientationabsolute', ipcLocOnDeviceOrientationAbsolute, true);
    }
    ipcLocCompassBound = true;
}

function ipcLocStopCompass() {
    if (!ipcLocCompassBound) return;
    window.removeEventListener('deviceorientation', ipcLocOnDeviceOrientation, true);
    if (ipcLocCompassUsesAbsolute) {
        window.removeEventListener('deviceorientationabsolute', ipcLocOnDeviceOrientationAbsolute, true);
    }
    ipcLocCompassBound = false;
}

function ipcLocDestroyMicromap() {
    if (ipcLocMicromapHandle) {
        ipcLocMicromapHandle.destroy();
        ipcLocMicromapHandle = null;
    }

    const wrap = document.getElementById('inPageCameraMicromap');
    const mapEl = document.getElementById('inPageCameraMicromapMap');
    if (wrap) {
        wrap.hidden = true;
        wrap.setAttribute('aria-hidden', 'true');
    }
    if (mapEl) {
        mapEl.innerHTML = '';
    }
}

function ipcLocGetMicromapMapEl() {
    return document.getElementById('inPageCameraMicromapMap');
}

/** Prefer live GPS, else fall back to the main map center so the micromap shows immediately. */
function ipcLocSeedFixFromApp() {
    if (ipcLocTryUseSharedLiveFix()) return true;
    if (window.map && typeof window.map.getCenter === 'function') {
        try {
            const c = window.map.getCenter();
            if (c && isFinite(c.lat) && isFinite(c.lng)) {
                ipcLocApplyFix({ lat: c.lat, lng: c.lng });
                return true;
            }
        } catch (_) {
            /* ignore */
        }
    }
    return false;
}

function ipcLocUpdateMicromap() {
    const wrap = document.getElementById('inPageCameraMicromap');
    if (!wrap) return;

    const micromap = window.photoMicromap;

    if (!ipcLocActive) {
        wrap.hidden = true;
        wrap.setAttribute('aria-hidden', 'true');
        return;
    }

    if (!ipcLocFix || !isFinite(ipcLocFix.lat) || !isFinite(ipcLocFix.lng)) {
        wrap.hidden = false;
        wrap.removeAttribute('hidden');
        wrap.setAttribute('aria-hidden', 'false');
        return;
    }

    wrap.hidden = false;
    wrap.removeAttribute('hidden');
    wrap.setAttribute('aria-hidden', 'false');

    if (!micromap || typeof micromap.create !== 'function' || typeof L === 'undefined') {
        return;
    }

    const fix = {
        lat: ipcLocFix.lat,
        lng: ipcLocFix.lng,
        heading: ipcLocFix.heading,
        accuracy: ipcLocFix.accuracy,
    };

    if (ipcLocMicromapHandle) {
        ipcLocMicromapHandle.update(fix);
        ipcLocMicromapHandle.invalidateSize();
    } else {
        const mapEl = ipcLocGetMicromapMapEl();
        if (!mapEl) return;
        ipcLocMicromapHandle = micromap.create(mapEl, fix);
    }
}

async function ipcLocRequestCompassPermission() {
    if (
        typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
        try {
            const result = await DeviceOrientationEvent.requestPermission();
            return result === 'granted';
        } catch (_) {
            return false;
        }
    }
    return true;
}

function ipcLocStart() {
    ipcLocStop();
    ipcLocActive = true;
    ipcLocFix = null;

    ipcLocSeedFixFromApp();
    if (!ipcLocUsingSharedFix) {
        ipcLocStartOwnGeoWatch();
    }
    ipcLocStartCompass();
    ipcLocNotifyFixChange();
    ipcLocUpdateMicromap();
}

function ipcLocStop() {
    ipcLocActive = false;
    ipcLocStopOwnGeoWatch();
    ipcLocStopCompass();

    if (typeof ipcLocUnsubscribeLiveFix === 'function') {
        ipcLocUnsubscribeLiveFix();
    }
    ipcLocUnsubscribeLiveFix = null;
    ipcLocUsingSharedFix = false;

    ipcLocDestroyMicromap();
    ipcLocFix = null;
    ipcLocNotifyFixChange();
}

function ipcLocGetFix() {
    if (!ipcLocFix) return null;
    return {
        lat: ipcLocFix.lat,
        lng: ipcLocFix.lng,
        accuracy: ipcLocFix.accuracy,
        heading: ipcLocFix.heading,
        headingSource: ipcLocFix.headingSource,
        at: ipcLocFix.at,
    };
}

function ipcLocOnFixChange(cb) {
    if (typeof cb !== 'function') return function () {};
    ipcLocFixListeners.add(cb);
    return function () {
        ipcLocFixListeners.delete(cb);
    };
}

if (typeof window !== 'undefined') {
    window.inPageCameraLocation = {
        start: ipcLocStart,
        stop: ipcLocStop,
        getFix: ipcLocGetFix,
        onFixChange: ipcLocOnFixChange,
        requestCompassPermission: ipcLocRequestCompassPermission,
        refreshMicromap: ipcLocUpdateMicromap,
    };
}
