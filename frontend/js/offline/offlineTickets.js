/**
 * Durable ticket list cache (IndexedDB mirror of ticketsByOrgCache) + per-base polygon cache.
 */
(function () {
    'use strict';

    function isOfflineOrNetworkFailure(err) {
        var conn = window.offlineConnectivity;
        if (conn && !conn.isOnline()) return true;
        return !!(conn && conn.isNetworkError && conn.isNetworkError(err));
    }

    function normalizeTicketBaseForPolygon(ticketNumber) {
        var tn = ticketNumber != null ? String(ticketNumber).trim() : '';
        if (!tn) return '';
        var mod = window.ticketImporterModule;
        if (mod && typeof mod.normalizeTicketBase === 'function') {
            return String(mod.normalizeTicketBase(tn) || tn.split('-')[0]).trim();
        }
        return tn.split('-')[0];
    }

    /** Strip GeoJSON from list snapshot — polygons live in ticketPolygons store. */
    function leanTicketsForIdbSnapshot(tickets) {
        if (!Array.isArray(tickets)) return [];
        return tickets.map(function (t) {
            if (!t || typeof t !== 'object') return t;
            var copy = Object.assign({}, t);
            delete copy.polygon;
            return copy;
        });
    }

    async function persistTicketsOrgSnapshot(orgId, tickets, hubUsernames) {
        if (!window.offlineStore) return;
        var payload = {
            loadedAt: Date.now(),
            tickets: leanTicketsForIdbSnapshot(tickets),
            hubUsernames: Array.isArray(hubUsernames) ? hubUsernames : [],
        };
        try {
            await window.offlineStore.putTicketsByOrg(orgId, payload);
        } catch (e) {
            console.warn('[offlineTickets] persist:', e.message || e);
        }
    }

    async function loadTicketsOrgFromIdb(orgId) {
        if (!window.offlineStore) return null;
        try {
            return await window.offlineStore.getTicketsByOrg(orgId);
        } catch (e) {
            console.warn('[offlineTickets] load:', e.message || e);
            return null;
        }
    }

    async function persistTicketPolygon(orgId, ticketNumber, polygon, extra) {
        if (!window.offlineStore || !polygon) return;
        var base = normalizeTicketBaseForPolygon(ticketNumber);
        if (!base) return;
        try {
            await window.offlineStore.putTicketPolygon(orgId, base, {
                polygon: polygon,
                bbox: extra && extra.bbox ? extra.bbox : null,
                pin: extra && extra.pin ? extra.pin : null,
                ticketNumber: ticketNumber != null ? String(ticketNumber) : null,
            });
        } catch (e) {
            console.warn('[offlineTickets] persist polygon:', e.message || e);
        }
    }

    async function loadTicketPolygonFromIdb(orgId, ticketNumber) {
        if (!window.offlineStore) return null;
        var base = normalizeTicketBaseForPolygon(ticketNumber);
        if (!base) return null;
        try {
            return await window.offlineStore.getTicketPolygon(orgId, base);
        } catch (e) {
            console.warn('[offlineTickets] load polygon:', e.message || e);
            return null;
        }
    }

    async function hydrateOrgTicketsFromIdb(orgId) {
        var entry = await loadTicketsOrgFromIdb(orgId);
        if (!entry || !Array.isArray(entry.tickets) || !entry.tickets.length) return false;
        if (!window.ORG_TICKETS) window.ORG_TICKETS = [];
        window.ORG_TICKETS.length = 0;
        window.ORG_TICKETS.push.apply(window.ORG_TICKETS, entry.tickets);
        window.TICKET_HUB_ORG_USERNAMES = Array.isArray(entry.hubUsernames) ? entry.hubUsernames : [];
        window._offlineDataLoaded = true;
        window._LAST_TICKETS_LOAD_ORG_ID = orgId;
        if (window.ticketsModule) {
            if (window.ticketsModule.renderTickets) window.ticketsModule.renderTickets();
            if (window.ticketsModule.updateTicketsLayerControl) window.ticketsModule.updateTicketsLayerControl();
            if (window.ticketsModule.renderTicketList) window.ticketsModule.renderTicketList();
        }
        return true;
    }

    async function mergeAssignedDetailsIntoOrgTickets(orgId) {
        if (!window.offlineStore || !window.ORG_TICKETS) return;
        var user = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
        var userId = user && user.id;
        if (userId == null) return;
        var isTech =
            window.authModule &&
            typeof window.authModule.isTechInCurrentOrg === 'function' &&
            window.authModule.isTechInCurrentOrg();
        for (var i = 0; i < window.ORG_TICKETS.length; i++) {
            var t = window.ORG_TICKETS[i];
            if (!t) continue;
            if (isTech) {
                if (
                    typeof window.isTicketVisibleToTechClient !== 'function' ||
                    !window.isTicketVisibleToTechClient(t)
                ) {
                    continue;
                }
            }
            var tn = t.ticketNumber != null ? String(t.ticketNumber).trim() : '';
            if (!tn) continue;
            try {
                var row = await window.offlineStore.getAssignedTicketDetail(orgId, tn);
                if (row && row.ticket && typeof window.upsertRefreshedTicketIntoLocalCollections === 'function') {
                    window.upsertRefreshedTicketIntoLocalCollections(row.ticket);
                }
            } catch (_e) {
                /* per-ticket */
            }
        }
    }

    /** Paint-only freshness for online IDB hydrate (15 min). */
    function isIdbLeanListFreshForPaint(entry) {
        if (!entry || !Array.isArray(entry.tickets) || !entry.tickets.length) return false;
        var loadedAt = entry.loadedAt;
        if (loadedAt == null || !Number.isFinite(loadedAt)) return false;
        return Date.now() - loadedAt <= 15 * 60 * 1000;
    }

    window.offlineTickets = {
        isOfflineOrNetworkFailure: isOfflineOrNetworkFailure,
        persistTicketsOrgSnapshot: persistTicketsOrgSnapshot,
        loadTicketsOrgFromIdb: loadTicketsOrgFromIdb,
        hydrateOrgTicketsFromIdb: hydrateOrgTicketsFromIdb,
        mergeAssignedDetailsIntoOrgTickets: mergeAssignedDetailsIntoOrgTickets,
        persistTicketPolygon: persistTicketPolygon,
        loadTicketPolygonFromIdb: loadTicketPolygonFromIdb,
        normalizeTicketBaseForPolygon: normalizeTicketBaseForPolygon,
        isIdbLeanListFreshForPaint: isIdbLeanListFreshForPaint,
    };
})();
