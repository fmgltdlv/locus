/**
 * Tracks user interaction for pausing background polls during inactivity.
 */
(function (global) {
    'use strict';

    var INACTIVITY_MS = 15 * 60 * 1000;
    var lastInteractionAt = Date.now();
    var initialized = false;
    var resumeListeners = [];

    function isActive(thresholdMs) {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            return false;
        }
        var threshold = thresholdMs != null ? thresholdMs : INACTIVITY_MS;
        return Date.now() - lastInteractionAt < threshold;
    }

    function notifyResume() {
        for (var i = 0; i < resumeListeners.length; i++) {
            try {
                resumeListeners[i]();
            } catch (e) {
                console.warn('[userActivity] resume listener failed:', e.message || e);
            }
        }
    }

    function recordInteraction() {
        var wasActive = isActive();
        lastInteractionAt = Date.now();
        if (!wasActive) {
            notifyResume();
        }
    }

    function onResume(fn) {
        if (typeof fn === 'function') {
            resumeListeners.push(fn);
        }
    }

    function init() {
        if (initialized) return;
        initialized = true;

        var events = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'];
        for (var i = 0; i < events.length; i++) {
            document.addEventListener(events[i], recordInteraction, { passive: true, capture: true });
        }

        // Always notify resume on tab return. While hidden, isActive() is false and
        // pollers clear their timers; recordInteraction() alone skips notifyResume
        // when the 15-minute interaction clock still looks "active".
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                lastInteractionAt = Date.now();
                notifyResume();
            }
        });

        window.addEventListener('focus', recordInteraction);
    }

    global.userActivity = {
        INACTIVITY_MS: INACTIVITY_MS,
        isActive: isActive,
        recordInteraction: recordInteraction,
        onResume: onResume,
        init: init,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(typeof window !== 'undefined' ? window : globalThis);
