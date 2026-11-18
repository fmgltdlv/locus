/**
 * Per-user create-ticket wizard shared-step presets.
 * Stored under ui-preferences.createTicketSharedPresets (+ localStorage cache).
 */
(function (global) {
    'use strict';

    const MAX_PRESETS = 10;
    const MAX_NAME_LEN = 60;
    const STORAGE_BASE = 'createTicketSharedPresets';

    const FIELD_KEYS = [
        'jobName',
        'ticketType',
        'workCategoryId',
        'workActivityId',
        'excavationMethod',
        'horizontalBoring',
        'explosives',
        'streetSidewalkParkstrip',
        'permitExcavation',
        'areaPreMarked',
        'startDateYmd',
        'startTimeHm',
        'projectOwnerTypeId',
        'projectOwnerAuthId',
        'principalName',
        'principalMobile',
    ];

    function emptyBlob() {
        return { version: 1, presets: [] };
    }

    function storageKey() {
        if (typeof global.getUserStorageKey === 'function') {
            return global.getUserStorageKey(STORAGE_BASE);
        }
        const user =
            global.authModule && typeof global.authModule.getCurrentUser === 'function'
                ? global.authModule.getCurrentUser()
                : null;
        if (user && user.id) return STORAGE_BASE + '_user_' + user.id;
        return STORAGE_BASE;
    }

    function normalizeBlob(raw) {
        if (typeof global.getCreateTicketSharedPresetsFromStorage === 'function' && raw == null) {
            return global.getCreateTicketSharedPresetsFromStorage();
        }
        const empty = emptyBlob();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
        const list = Array.isArray(raw.presets) ? raw.presets : [];
        return {
            version: 1,
            presets: list.filter(function (p) {
                return p && typeof p === 'object' && !Array.isArray(p) && p.id != null && p.name != null;
            }),
        };
    }

    function readLocal() {
        if (typeof global.getCreateTicketSharedPresetsFromStorage === 'function') {
            return global.getCreateTicketSharedPresetsFromStorage();
        }
        try {
            return normalizeBlob(JSON.parse(localStorage.getItem(storageKey()) || '{}'));
        } catch (e) {
            return emptyBlob();
        }
    }

    function writeLocal(blob) {
        const normalized = normalizeBlob(blob);
        if (typeof global.setCreateTicketSharedPresetsInStorage === 'function') {
            return global.setCreateTicketSharedPresetsInStorage(normalized);
        }
        try {
            localStorage.setItem(storageKey(), JSON.stringify(normalized));
        } catch (e) {
            /* ignore */
        }
        return normalized;
    }

    function cloneFields(shared) {
        const out = {};
        FIELD_KEYS.forEach(function (k) {
            const v = shared && shared[k] != null ? shared[k] : '';
            out[k] = typeof v === 'string' ? v : String(v);
        });
        return out;
    }

    function newId() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return global.crypto.randomUUID();
        }
        return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }

    function normalizeName(name) {
        return String(name || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, MAX_NAME_LEN);
    }

    function nameKey(name) {
        return normalizeName(name).toLowerCase();
    }

    function listPresets() {
        return readLocal().presets.slice().sort(function (a, b) {
            return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
        });
    }

    function getById(id) {
        const sid = String(id || '');
        if (!sid) return null;
        const found = readLocal().presets.find(function (p) {
            return String(p.id) === sid;
        });
        return found || null;
    }

    async function fetchServerPreferences() {
        if (!global.authModule || !global.authModule.isAuthenticated()) return null;
        const res = await global.authModule.apiRequest(
            global.authModule.API_BASE + '/users/me/ui-preferences'
        );
        const prefs = res && res.preferences;
        if (prefs && typeof prefs === 'object' && !Array.isArray(prefs)) return prefs;
        return {};
    }

    async function persistBlob(blob) {
        const normalized = writeLocal(blob);
        if (!global.authModule || !global.authModule.isAuthenticated()) {
            return normalized;
        }
        let prefs = {};
        try {
            prefs = (await fetchServerPreferences()) || {};
        } catch (e) {
            console.warn('[createTicketWizardPresets] load prefs before save', e);
            prefs = {};
        }
        if (typeof global.getUserProfile === 'function') {
            prefs.userProfile = global.getUserProfile();
        } else if (!prefs.userProfile || typeof prefs.userProfile !== 'object') {
            prefs.userProfile = prefs.userProfile || {};
        }
        if (typeof global.getTicketPopupDimensionsFromStorage !== 'function') {
            /* keep server ticketPopupDimensions if present */
        } else {
            /* not exported — preserve server value */
        }
        try {
            const ticketKey =
                typeof global.getUserStorageKey === 'function'
                    ? global.getUserStorageKey('ticketPopupDimensions')
                    : 'ticketPopupDimensions';
            const localTicket = JSON.parse(localStorage.getItem(ticketKey) || '{}');
            if (localTicket && typeof localTicket === 'object') {
                prefs.ticketPopupDimensions = localTicket;
            }
        } catch (e) {
            /* keep existing prefs.ticketPopupDimensions */
        }
        prefs.createTicketSharedPresets = normalized;
        await global.authModule.apiRequest(global.authModule.API_BASE + '/users/me/ui-preferences', {
            method: 'PUT',
            body: JSON.stringify({ preferences: prefs }),
        });
        return normalized;
    }

    function assertCanAdd(name, excludeId) {
        const n = normalizeName(name);
        if (!n) {
            const err = new Error('Enter a preset name.');
            err.code = 'NAME_REQUIRED';
            throw err;
        }
        const blob = readLocal();
        const key = nameKey(n);
        const dup = blob.presets.some(function (p) {
            if (excludeId && String(p.id) === String(excludeId)) return false;
            return nameKey(p.name) === key;
        });
        if (dup) {
            const err = new Error('A preset with that name already exists.');
            err.code = 'NAME_DUPLICATE';
            throw err;
        }
        return n;
    }

    async function saveNew(name, sharedFields) {
        const blob = readLocal();
        if (blob.presets.length >= MAX_PRESETS) {
            const err = new Error(
                'You can save up to ' + MAX_PRESETS + ' presets. Delete one before saving another.'
            );
            err.code = 'MAX_PRESETS';
            throw err;
        }
        const n = assertCanAdd(name);
        const preset = {
            id: newId(),
            name: n,
            updatedAt: new Date().toISOString(),
            fields: cloneFields(sharedFields),
        };
        blob.presets.push(preset);
        await persistBlob(blob);
        return preset;
    }

    async function updateFields(id, sharedFields) {
        const blob = readLocal();
        const idx = blob.presets.findIndex(function (p) {
            return String(p.id) === String(id);
        });
        if (idx < 0) {
            const err = new Error('Preset not found.');
            err.code = 'NOT_FOUND';
            throw err;
        }
        blob.presets[idx] = Object.assign({}, blob.presets[idx], {
            updatedAt: new Date().toISOString(),
            fields: cloneFields(sharedFields),
        });
        await persistBlob(blob);
        return blob.presets[idx];
    }

    async function rename(id, name) {
        const n = assertCanAdd(name, id);
        const blob = readLocal();
        const idx = blob.presets.findIndex(function (p) {
            return String(p.id) === String(id);
        });
        if (idx < 0) {
            const err = new Error('Preset not found.');
            err.code = 'NOT_FOUND';
            throw err;
        }
        blob.presets[idx] = Object.assign({}, blob.presets[idx], {
            name: n,
            updatedAt: new Date().toISOString(),
        });
        await persistBlob(blob);
        return blob.presets[idx];
    }

    async function remove(id) {
        const blob = readLocal();
        const next = blob.presets.filter(function (p) {
            return String(p.id) !== String(id);
        });
        if (next.length === blob.presets.length) {
            const err = new Error('Preset not found.');
            err.code = 'NOT_FOUND';
            throw err;
        }
        blob.presets = next;
        await persistBlob(blob);
        return true;
    }

    function atCapacity() {
        return readLocal().presets.length >= MAX_PRESETS;
    }

    global.createTicketWizardPresetsApi = {
        MAX_PRESETS: MAX_PRESETS,
        FIELD_KEYS: FIELD_KEYS,
        listPresets: listPresets,
        getById: getById,
        saveNew: saveNew,
        updateFields: updateFields,
        rename: rename,
        remove: remove,
        atCapacity: atCapacity,
        cloneFields: cloneFields,
        getStorageBlob: readLocal,
        normalizeName: normalizeName,
    };
})(typeof window !== 'undefined' ? window : globalThis);
