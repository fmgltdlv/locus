// Reported Events (DIRT) — server-backed list with optional one-time localStorage migration.

(function () {
    let cache = [];
    /** @type {number | null} */
    let cacheOrgId = null;

    function getOrgId() {
        if (typeof window.getCurrentOrgId === 'function') {
            const v = window.getCurrentOrgId();
            return v != null && v !== '' ? Number(v) : null;
        }
        const u = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
        return u && u.organizationId != null ? Number(u.organizationId) : null;
    }

    async function migrateLocalStorageOnce(orgId) {
        const flagKey = `dirtReportsMigratedToApi:${orgId}`;
        try {
            if (localStorage.getItem(flagKey)) return;
            const raw = JSON.parse(localStorage.getItem('dirtReports') || '[]');
            const mine = raw.filter((r) => Number(r.organizationId) === Number(orgId));
            if (!mine.length) {
                localStorage.setItem(flagKey, '1');
                return;
            }
            for (const r of mine) {
                const legacyId = r.id != null ? String(r.id) : null;
                try {
                    await window.authModule.apiRequest('data/reported-events', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            ...r,
                            organizationId: orgId,
                            clientLegacyId: legacyId && legacyId.startsWith('event-') ? legacyId : undefined,
                        }),
                    });
                } catch (e) {
                    const st = e && e.status;
                    if (st === 409) continue;
                    console.warn('[reportedEventsStore] migrate row:', e);
                }
            }
            localStorage.setItem(flagKey, '1');
        } catch (e) {
            console.warn('[reportedEventsStore] migrate:', e);
        }
    }

    async function fetchFromApi(orgId) {
        const res = await window.authModule.apiRequest(
            `data/reported-events?organizationId=${encodeURIComponent(String(orgId))}`
        );
        if (getOrgId() !== orgId) {
            return cache;
        }
        const events = res && Array.isArray(res.events) ? res.events : [];
        cache = events;
        cacheOrgId = orgId;
        notifyDraftCountChanged();
        return cache;
    }

    function notifyDraftCountChanged() {
        if (typeof window.applyDataHubDraftBadge === 'function') {
            window.applyDataHubDraftBadge();
        }
    }

    function countDrafts() {
        const orgId = getOrgId();
        if (orgId !== cacheOrgId) return 0;
        let n = 0;
        for (let i = 0; i < cache.length; i++) {
            if (cache[i] && cache[i].isDraft === true) n += 1;
        }
        return n;
    }

    async function ensureLoaded() {
        const orgId = getOrgId();
        if (!orgId || !window.authModule || !window.authModule.isAuthenticated()) {
            cache = [];
            cacheOrgId = null;
            notifyDraftCountChanged();
            return [];
        }
        if (cacheOrgId === orgId) {
            return cache;
        }
        await migrateLocalStorageOnce(orgId);
        return fetchFromApi(orgId);
    }

    function invalidate() {
        cache = [];
        cacheOrgId = null;
    }

    function hasFreshCache() {
        const orgId = getOrgId();
        return orgId != null && orgId === cacheOrgId;
    }

    function getReportsForCurrentOrg() {
        const orgId = getOrgId();
        if (orgId !== cacheOrgId) return [];
        return cache.slice();
    }

    window.reportedEventsStore = {
        ensureLoaded,
        invalidate,
        getReportsForCurrentOrg,
        countDrafts,
        hasFreshCache,
    };
})();
