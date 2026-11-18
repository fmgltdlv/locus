/**
 * Shared hardware/browser back handling for high-traffic overlays and panels.
 * One history sentinel while any registered layer is open; back closes topmost layer.
 */
(function (global) {
    'use strict';

    /** @type {Array<{ id: string, isOpen: function(): boolean, onBack: function(*): void }>} */
    const entries = [];
    let historyArmed = false;
    let suppressNextPop = false;
    let listenersBound = false;

    function bindListeners() {
        if (listenersBound) return;
        listenersBound = true;
        global.addEventListener('popstate', onPopState);
    }

    function findEntryIndex(id) {
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].id === id) return i;
        }
        return -1;
    }

    function pruneClosedEntries() {
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (!entry.isOpen || !entry.isOpen()) {
                entries.splice(i, 1);
            }
        }
    }

    function anyEntryOpen() {
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.isOpen && entry.isOpen()) return true;
        }
        return false;
    }

    function syncHistoryArmed() {
        const shouldArm = anyEntryOpen();
        if (shouldArm && !historyArmed) {
            global.history.pushState({ uiBack: true }, '');
            historyArmed = true;
            return;
        }
        if (!shouldArm && historyArmed) {
            historyArmed = false;
            suppressNextPop = true;
            global.history.back();
        }
    }

    /** Re-push sentinel after popstate when a layer stays open (e.g. confirm cancelled). */
    function rearmAfterPopstate() {
        if (!anyEntryOpen()) {
            historyArmed = false;
            return;
        }
        if (!historyArmed) {
            global.history.pushState({ uiBack: true }, '');
            historyArmed = true;
        }
    }

    function onPopState() {
        if (suppressNextPop) {
            suppressNextPop = false;
            return;
        }
        historyArmed = false;
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (entry.isOpen && entry.isOpen()) {
                entry.onBack({ fromPopstate: true });
                return;
            }
        }
    }

    /**
     * @param {{ id: string, isOpen: function(): boolean, onBack: function(*): void }} spec
     */
    function register(spec) {
        if (!spec || !spec.id || typeof spec.isOpen !== 'function' || typeof spec.onBack !== 'function') {
            return;
        }
        bindListeners();
        pruneClosedEntries();
        const idx = findEntryIndex(spec.id);
        if (idx >= 0) {
            entries[idx] = {
                id: spec.id,
                isOpen: spec.isOpen,
                onBack: spec.onBack,
            };
        } else {
            entries.push({
                id: spec.id,
                isOpen: spec.isOpen,
                onBack: spec.onBack,
            });
        }
        syncHistoryArmed();
    }

    /**
     * @param {string} id
     * @param {{ fromPopstate?: boolean }} [opts]
     */
    function unregister(id, opts) {
        opts = opts || {};
        const idx = findEntryIndex(id);
        if (idx < 0) return;
        entries.splice(idx, 1);
        if (opts.fromPopstate) return;
        syncHistoryArmed();
    }

    function isRegistered(id) {
        return findEntryIndex(id) >= 0;
    }

    global.uiBackStack = {
        register: register,
        unregister: unregister,
        isRegistered: isRegistered,
        rearmAfterPopstate: rearmAfterPopstate,
    };
})(typeof window !== 'undefined' ? window : globalThis);
