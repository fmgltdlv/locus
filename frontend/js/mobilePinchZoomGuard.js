/* Mobile page pinch-zoom guard — strict (default) or hybrid (user opt-in). Map uses Leaflet only. */
(function () {
    'use strict';

    var VIEWPORT_SCALABLE = 'width=device-width, initial-scale=1.0';
    var VIEWPORT_LOCKED =
        'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no';

    var IN_APP_ZOOM_SELECTORS = [
        '.leaflet-container',
        '.ticket-hub-pdf-modal-scroll',
        '[data-allow-pinch-zoom]',
    ];

    var listenersBound = false;
    var savedViewportContent = null;
    var currentMode = 'off';

    function isCoarsePointer() {
        return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    }

    function getPolicy() {
        return document.documentElement.getAttribute('data-pinch-zoom-policy');
    }

    function readPreference() {
        try {
            var userRaw = localStorage.getItem('currentUser');
            if (!userRaw) return false;
            var user = JSON.parse(userRaw);
            if (!user || !user.id) return false;
            var profileRaw = localStorage.getItem('userProfile_user_' + user.id);
            if (!profileRaw) return false;
            var profile = JSON.parse(profileRaw);
            return !!(profile && profile.allowPinchZoom === true);
        } catch (_e) {
            return false;
        }
    }

    function isInsideSelector(target, selector) {
        if (!target || typeof target.closest !== 'function') return false;
        return !!target.closest(selector);
    }

    function isInsideInAppZoomZone(target) {
        for (var i = 0; i < IN_APP_ZOOM_SELECTORS.length; i++) {
            if (isInsideSelector(target, IN_APP_ZOOM_SELECTORS[i])) return true;
        }
        return false;
    }

    function isOnMapSurface(target) {
        return isInsideSelector(target, '.leaflet-container');
    }

    function shouldBlockMultiTouch(e) {
        if (currentMode === 'off' || !isCoarsePointer()) return false;

        var target = e.target;
        if (isInsideInAppZoomZone(target)) return false;

        if (currentMode === 'strict') return true;
        if (currentMode === 'hybrid') return isOnMapSurface(target);
        return false;
    }

    function shouldBlockWheel(e) {
        if (!e.ctrlKey || currentMode === 'off' || !isCoarsePointer()) return false;
        if (currentMode === 'hybrid') return isOnMapSurface(e.target);
        if (currentMode === 'strict') return !isInsideInAppZoomZone(e.target);
        return false;
    }

    function onTouchMove(e) {
        if (e.touches.length < 2) return;
        if (shouldBlockMultiTouch(e)) e.preventDefault();
    }

    function onGesture(e) {
        if (shouldBlockMultiTouch(e)) e.preventDefault();
    }

    function onWheel(e) {
        if (shouldBlockWheel(e)) e.preventDefault();
    }

    function bindListeners() {
        if (listenersBound) return;
        listenersBound = true;
        document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
        document.addEventListener('gesturestart', onGesture, { passive: false, capture: true });
        document.addEventListener('gesturechange', onGesture, { passive: false, capture: true });
        document.addEventListener('gestureend', onGesture, { passive: false, capture: true });
        document.addEventListener('wheel', onWheel, { passive: false, capture: true });
    }

    function unbindListeners() {
        if (!listenersBound) return;
        listenersBound = false;
        document.removeEventListener('touchmove', onTouchMove, { capture: true });
        document.removeEventListener('gesturestart', onGesture, { capture: true });
        document.removeEventListener('gesturechange', onGesture, { capture: true });
        document.removeEventListener('gestureend', onGesture, { capture: true });
        document.removeEventListener('wheel', onWheel, { capture: true });
    }

    function lockViewport() {
        var meta = document.querySelector('meta[name="viewport"]');
        if (!meta) return;
        if (savedViewportContent === null) {
            savedViewportContent = meta.getAttribute('content') || VIEWPORT_SCALABLE;
        }
        meta.setAttribute('content', VIEWPORT_LOCKED);
    }

    function unlockViewport() {
        var meta = document.querySelector('meta[name="viewport"]');
        if (!meta) return;
        meta.setAttribute('content', savedViewportContent !== null ? savedViewportContent : VIEWPORT_SCALABLE);
    }

    function off() {
        currentMode = 'off';
        unbindListeners();
        unlockViewport();
        delete document.documentElement.dataset.pinchGuard;
    }

    function apply(allowPinchZoom) {
        if (getPolicy() !== 'user-pref') {
            off();
            return;
        }
        if (!isCoarsePointer()) {
            off();
            return;
        }

        if (allowPinchZoom === true) {
            currentMode = 'hybrid';
            unlockViewport();
            document.documentElement.dataset.pinchGuard = 'hybrid';
            bindListeners();
            return;
        }

        currentMode = 'strict';
        lockViewport();
        document.documentElement.dataset.pinchGuard = 'strict';
        bindListeners();
    }

    function init() {
        if (getPolicy() !== 'user-pref') return;
        apply(readPreference());
    }

    window.mobilePinchZoomGuard = {
        apply: apply,
        readPreference: readPreference,
        off: off,
        isActive: function () {
            return currentMode !== 'off';
        },
        getMode: function () {
            return currentMode;
        },
    };

    init();
})();
