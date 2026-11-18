/**
 * Online/offline connectivity state for PWA offline mode.
 */
(function () {
    'use strict';

    var online = typeof navigator === 'undefined' || navigator.onLine !== false;
    var listeners = [];

    function isOnline() {
        return online;
    }

    function isNetworkError(err) {
        if (!err) return false;
        if (err.name === 'TypeError' && /fetch|network|Failed to fetch/i.test(String(err.message || ''))) {
            return true;
        }
        if (err.status == null && err.message && /network|offline|fetch/i.test(String(err.message))) {
            return true;
        }
        return false;
    }

    function notify() {
        for (var i = 0; i < listeners.length; i++) {
            try {
                listeners[i](online);
            } catch (_e) {
                /* non-fatal */
            }
        }
        if (window.offlineUi && typeof window.offlineUi.refreshBanner === 'function') {
            window.offlineUi.refreshBanner();
        }
    }

    function onConnectivityChange(cb) {
        if (typeof cb !== 'function') return function () {};
        listeners.push(cb);
        return function () {
            listeners = listeners.filter(function (fn) {
                return fn !== cb;
            });
        };
    }

    function setOnlineState(next) {
        var was = online;
        online = !!next;
        if (was !== online) notify();
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('online', function () {
            setOnlineState(true);
            if (window.offlineSync && typeof window.offlineSync.flushAllOutboxes === 'function') {
                void window.offlineSync.flushAllOutboxes();
            }
        });
        window.addEventListener('offline', function () {
            setOnlineState(false);
        });
    }

    window.offlineConnectivity = {
        isOnline: isOnline,
        isNetworkError: isNetworkError,
        onConnectivityChange: onConnectivityChange,
    };
})();
