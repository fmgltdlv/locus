/**
 * Offline cache TTL constants (milliseconds).
 */
(function () {
    'use strict';

    var MS_PER_HOUR = 60 * 60 * 1000;
    var MS_PER_DAY = 24 * MS_PER_HOUR;

    var TICKET_TTL_MS = 7 * MS_PER_DAY;
    var PHOTO_TTL_MS = 14 * MS_PER_DAY;
    var USAN_DOC_TTL_MS = 30 * MS_PER_DAY;
    var MAP_WORKSPACE_TTL_MS = 24 * MS_PER_HOUR;
    var AERIAL_TILE_TTL_MS = 24 * MS_PER_HOUR;

    var MAP_WORKSPACE_META_KEY = 'mapWorkspaceCacheMeta';

    function isExpired(cachedAt, ttlMs) {
        if (cachedAt == null || !Number.isFinite(cachedAt)) return true;
        return Date.now() - cachedAt >= ttlMs;
    }

    function readMapWorkspaceMeta() {
        try {
            var raw = localStorage.getItem(MAP_WORKSPACE_META_KEY);
            if (!raw) return { orgs: {} };
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return { orgs: {} };
            if (!parsed.orgs || typeof parsed.orgs !== 'object') parsed.orgs = {};
            return parsed;
        } catch (_e) {
            return { orgs: {} };
        }
    }

    function writeMapWorkspaceMeta(meta) {
        try {
            localStorage.setItem(MAP_WORKSPACE_META_KEY, JSON.stringify(meta));
        } catch (_e) {
            /* non-fatal */
        }
    }

    function touchMapWorkspaceCache(orgId) {
        if (orgId == null || orgId === '') return;
        var meta = readMapWorkspaceMeta();
        meta.orgs[String(orgId)] = { cachedAt: Date.now() };
        writeMapWorkspaceMeta(meta);
    }

    function isMapWorkspaceCacheFresh(orgId) {
        if (orgId == null || orgId === '') return false;
        var meta = readMapWorkspaceMeta();
        var row = meta.orgs[String(orgId)];
        if (!row || row.cachedAt == null) return false;
        return !isExpired(row.cachedAt, MAP_WORKSPACE_TTL_MS);
    }

    function clearMapWorkspaceCacheMeta(orgId) {
        if (orgId == null || orgId === '') return;
        var meta = readMapWorkspaceMeta();
        delete meta.orgs[String(orgId)];
        writeMapWorkspaceMeta(meta);
    }

    window.offlineCacheTtl = {
        TICKET_TTL_MS: TICKET_TTL_MS,
        PHOTO_TTL_MS: PHOTO_TTL_MS,
        USAN_DOC_TTL_MS: USAN_DOC_TTL_MS,
        MAP_WORKSPACE_TTL_MS: MAP_WORKSPACE_TTL_MS,
        AERIAL_TILE_TTL_MS: AERIAL_TILE_TTL_MS,
        isExpired: isExpired,
        touchMapWorkspaceCache: touchMapWorkspaceCache,
        isMapWorkspaceCacheFresh: isMapWorkspaceCacheFresh,
        clearMapWorkspaceCacheMeta: clearMapWorkspaceCacheMeta,
    };
})();
