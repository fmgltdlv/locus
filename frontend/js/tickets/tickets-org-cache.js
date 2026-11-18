/**
 * tickets-org-cache.js — split from tickets-operations-photos.js (Phase F1).
 * Ticket refresh helpers, org cache TTL, hub expired/active/combined slices.
 * Globals: same window/function names as before (IIFE bundle).
 */
function getTicketsRefreshOrgId() {
    if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
        const id = window.orgSelectorModule.getCurrentOrgId();
        if (id != null && id !== '') {
            const n = parseInt(String(id), 10);
            if (Number.isFinite(n)) return n;
        }
    }
    const u = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
    return u && u.organizationId != null ? u.organizationId : null;
}

/**
 * POST /tickets/refresh body: owner org for shared tickets + viewer org for partnership auth.
 * @param {object|string|undefined} ticketOrNumber
 * @returns {{ organizationId: number|null, viewerOrganizationId: number|null }}
 */
function getTicketRefreshRequestContext(ticketOrNumber) {
    const viewerOrgId = getTicketsRefreshOrgId();
    let ticket = ticketOrNumber;
    if (ticket != null && typeof ticket !== 'object') {
        const tn = String(ticketOrNumber).trim();
        ticket =
            (window.__FEED_HUB_DETAIL_TICKET &&
            window.__FEED_HUB_DETAIL_TICKET.ticketNumber != null &&
            String(window.__FEED_HUB_DETAIL_TICKET.ticketNumber).trim() === tn
                ? window.__FEED_HUB_DETAIL_TICKET
                : null) ||
            (window.ORG_TICKETS || []).find(
                (t) => t && t.ticketNumber != null && String(t.ticketNumber).trim() === tn
            );
    }
    let ownerOrgId = viewerOrgId;
    if (ticket && ticket.shared) {
        const fromShared =
            ticket.sharedFromOrganizationId != null && ticket.sharedFromOrganizationId !== ''
                ? ticket.sharedFromOrganizationId
                : null;
        const fromOrg =
            ticket.organizationId != null && ticket.organizationId !== '' ? ticket.organizationId : null;
        ownerOrgId = fromShared != null ? fromShared : fromOrg != null ? fromOrg : viewerOrgId;
        if (ownerOrgId != null && ownerOrgId !== '') {
            const n = parseInt(String(ownerOrgId), 10);
            ownerOrgId = Number.isFinite(n) ? n : viewerOrgId;
        }
    } else if (
        ticket &&
        (ticket.__feedWorkspaceView ||
            (window.orgSelectorModule &&
                typeof window.orgSelectorModule.canUseCurrentDevTicketHub === 'function' &&
                window.orgSelectorModule.canUseCurrentDevTicketHub())) &&
        ticket.organizationId != null &&
        ticket.organizationId !== ''
    ) {
        const n = parseInt(String(ticket.organizationId), 10);
        if (Number.isFinite(n)) ownerOrgId = n;
    }
    return {
        organizationId: ownerOrgId,
        viewerOrganizationId: viewerOrgId,
    };
}

window.getTicketRefreshRequestContext = getTicketRefreshRequestContext;

// Refresh ticket from external services and map/public fallback data.
async function refreshTicketFrom811(ticketNumber, opts) {
    const popupOpen = !!(opts && opts.popupOpen);
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        if (!popupOpen) {
            await appAlert('You must be signed in to refresh ticket data.');
        }
        return;
    }
    const tn = String(ticketNumber || '').trim();
    const forceRefresh = !!(opts && opts.forceRefresh);
    if (
        !forceRefresh &&
        window.ticketsModule &&
        typeof window.ticketsModule.isTicketPopupOpenRefreshCoopLocked === 'function'
    ) {
        const liveTicket =
            typeof window.ticketsModule.resolveLiveTicketForRefresh === 'function'
                ? window.ticketsModule.resolveLiveTicketForRefresh({ ticketNumber: tn })
                : (window.ORG_TICKETS || []).find(
                      (t) => t && t.ticketNumber != null && String(t.ticketNumber).trim() === tn
                  ) || null;
        if (liveTicket && window.ticketsModule.isTicketPopupOpenRefreshCoopLocked(liveTicket)) {
            return;
        }
    }
    if (window.ticketsModule && typeof window.ticketsModule.setTicketSelectionRefreshLoading === 'function') {
        window.ticketsModule.setTicketSelectionRefreshLoading(tn, true);
    }
    const btn = document.querySelector('.ticket-refresh-811-button');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.innerHTML = '<span style="font-size: 1.05rem; line-height: 1;" aria-hidden="true">...</span>';
    }
    try {
        const refreshCtx = getTicketRefreshRequestContext(ticketNumber);
        const res = await window.authModule.apiRequest(`${window.authModule.API_BASE}/tickets/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticketNumber,
                refreshMode: 'lite',
                ...(forceRefresh ? { forceRefresh: true } : {}),
                ...(popupOpen ? { popupOpen: true } : {}),
                ...(refreshCtx.organizationId != null ? { organizationId: refreshCtx.organizationId } : {}),
                ...(refreshCtx.viewerOrganizationId != null
                    ? { viewerOrganizationId: refreshCtx.viewerOrganizationId }
                    : {}),
            })
        });
        const updated = res.ticket;
        if (!updated) {
            if (!popupOpen) {
                await appAlert('Refresh succeeded but no ticket data returned.');
            }
            return;
        }
        // Replace full ticket from server (polygon, dates, stations, history, operator responses, etc.)
        let ticketForPopup = updated;
        let previousTicket = null;
        if (window.ORG_TICKETS) {
            const tn = String(ticketNumber).trim();
            let idx = window.ORG_TICKETS.findIndex(t => String(t.ticketNumber) === tn);
            if (idx < 0) {
                const base = tn.split('-')[0];
                idx = window.ORG_TICKETS.findIndex(t => String(t.ticketNumber).split('-')[0] === base);
            }
            if (idx >= 0) {
                previousTicket = window.ORG_TICKETS[idx];
                window.ORG_TICKETS[idx] = updated;
                ticketForPopup = window.ORG_TICKETS[idx];
            } else {
                window.ORG_TICKETS.push(updated);
                ticketForPopup = updated;
            }
            if (ticketForPopup) {
                applyTicketStatusFromImporter(ticketForPopup);
            }
        }
        applyTicketMapRenderAfterDataUpdate(previousTicket, ticketForPopup);
        renderTicketList();
        const popup = document.getElementById('ticketPopup');
        const aboveHub = !!(popup && popup.classList.contains('ticket-popup--above-hub'));
        const popupShowsTicket =
            popup &&
            ticketForPopup &&
            ticketForPopup.id != null &&
            String(popup.getAttribute('data-popup-ticket-id')) === String(ticketForPopup.id);
        if (popupShowsTicket && typeof patchOpenTicketPopupDetail === 'function') {
            patchOpenTicketPopupDetail(ticketForPopup);
        } else {
            showTicketPopup(ticketForPopup, { skipDetailHydrate: true, allowOverTicketHub: aboveHub });
        }
        const cacheOrgId =
            refreshCtx.viewerOrganizationId != null ? refreshCtx.viewerOrganizationId : getTicketsRefreshOrgId();
        refreshTicketsOrgCacheSnapshot(cacheOrgId);
        if (
            window.ticketDocumentPackFlow &&
            typeof window.ticketDocumentPackFlow.prefetchCurrentConfirmation === 'function'
        ) {
            void window.ticketDocumentPackFlow.prefetchCurrentConfirmation(ticketForPopup || updated);
        }
    } catch (error) {
        console.error('Error refreshing ticket from 811:', error);
        // Auto refresh on popup open should not block the UI with alerts (e.g. missing nGen credentials).
        if (!popupOpen) {
            await appAlert(`Failed to refresh 811 data: ${error.message || error}`);
        }
    } finally {
        if (window.ticketsModule && typeof window.ticketsModule.setTicketSelectionRefreshLoading === 'function') {
            window.ticketsModule.setTicketSelectionRefreshLoading(tn, false);
        }
        if (btn) {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.innerHTML = originalHtml;
        }
    }
}

window.refreshTicketFrom811 = refreshTicketFrom811;

/** In-memory ticket list by org; TTL matches ticket detail refresh lock (see {@link getTicketPerRefreshLockMs} in tickets-core.js, `TICKET_DETAIL_COOP_LOCK_MS` / GET /api/public-config). */
const ticketsByOrgCache = new Map();
/** @type {Map<string, Promise<void>>} */
const ticketsLoadInFlight = new Map();
/** @type {Map<string, number>} orgKey -> timestamp of last successful full pagination */
const lastTicketsFullLoadAt = new Map();

/** Same window as ticket detail refresh skip so one config drives both. */
function getTicketsOrgCacheTtlMs() {
    if (typeof getTicketPerRefreshLockMs === 'function') {
        const n = getTicketPerRefreshLockMs();
        if (Number.isFinite(n) && n > 0) return n;
    }
    return 2 * 60 * 1000;
}

function ticketsOrgCacheKey(orgId) {
    return orgId != null && orgId !== '' ? String(orgId) : '_none';
}

/** Stable merge key for list/map dedupe (id preferred, else base ticket number). */
function ticketListMergeKey(ticket) {
    if (!ticket) return '';
    if (ticket.id != null && String(ticket.id).trim() !== '') return `id:${String(ticket.id)}`;
    const mod = window.ticketImporterModule;
    const base =
        mod && typeof mod.normalizeTicketBase === 'function'
            ? mod.normalizeTicketBase(ticket.ticketNumber || '')
            : String(ticket.ticketNumber || '').split('-')[0];
    const trimmed = base != null ? String(base).trim() : '';
    return trimmed ? `tn:${trimmed}` : '';
}

/** Keep POSR/manual import rows visible when a concurrent summary reload has not caught up yet. */
function mergeImportedTicketsIntoOrgList(importedTickets) {
    if (!Array.isArray(importedTickets) || importedTickets.length === 0) return;
    if (!window.ORG_TICKETS) window.ORG_TICKETS = [];
    const keys = new Set(window.ORG_TICKETS.map(ticketListMergeKey).filter(Boolean));
    importedTickets.forEach((ticket) => {
        if (!ticket) return;
        const key = ticketListMergeKey(ticket);
        if (!key || keys.has(key)) return;
        if (typeof applyTicketStatusFromImporter === 'function') {
            applyTicketStatusFromImporter(ticket);
        }
        window.ORG_TICKETS.push(ticket);
        keys.add(key);
    });
}

/**
 * Timestamp (ms) of the last successful full active-ticket pagination for an org.
 * Used by appResume.js for foreground stale refresh (15 min threshold).
 * @param {number|string|null|undefined} orgId
 * @returns {number|null}
 */
function getLastTicketsFullLoadAtForOrg(orgId) {
    const ts = lastTicketsFullLoadAt.get(ticketsOrgCacheKey(orgId));
    return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
}

function cloneForTicketsOrgCache(value) {
    try {
        return structuredClone(value);
    } catch (_) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (e2) {
            return value;
        }
    }
}

function clearTicketsOrgCache() {
    ticketsByOrgCache.clear();
    lastTicketsFullLoadAt.clear();
}

/**
 * Drop cached ticket list for one org (e.g. after import, delete, or hub refresh).
 * @param {number|string|null|undefined} orgId
 */
function invalidateTicketsOrgCache(orgId) {
    const key = ticketsOrgCacheKey(orgId);
    ticketsByOrgCache.delete(key);
    lastTicketsFullLoadAt.delete(key);
}

function areTicketsFreshForOrg(orgId) {
    if (window._LAST_TICKETS_LOAD_ORG_ID !== orgId) return false;
    if (!window.ORG_TICKETS || window.ORG_TICKETS.length === 0) return false;
    return !!getFreshTicketsOrgCache(orgId);
}

function isTicketsLoadInFlightForOrg(orgId) {
    return ticketsLoadInFlight.has(ticketsOrgCacheKey(orgId));
}

function awaitTicketsLoadForOrg(orgId) {
    const key = ticketsOrgCacheKey(orgId);
    const pending = ticketsLoadInFlight.get(key);
    return pending || Promise.resolve();
}

function liveExpiringSoonDaysForOrgCache() {
    const mod = window.workflowAckComplianceModule;
    if (mod && typeof mod.getCurrentOrgWorkflowAckPolicy === 'function') {
        const n = Number(mod.getCurrentOrgWorkflowAckPolicy().expiringSoonDays);
        if (Number.isFinite(n)) return n;
    }
    return 5;
}

function getFreshTicketsOrgCache(orgId) {
    const key = ticketsOrgCacheKey(orgId);
    const entry = ticketsByOrgCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.loadedAt > getTicketsOrgCacheTtlMs()) {
        ticketsByOrgCache.delete(key);
        return null;
    }
    if (
        entry.expiringSoonDays != null &&
        Number(entry.expiringSoonDays) !== liveExpiringSoonDaysForOrgCache()
    ) {
        ticketsByOrgCache.delete(key);
        return null;
    }
    return entry;
}

function putTicketsOrgCache(orgId, tickets, hubUsernames) {
    ticketsByOrgCache.set(ticketsOrgCacheKey(orgId), {
        loadedAt: Date.now(),
        tickets: cloneForTicketsOrgCache(tickets),
        hubUsernames: Array.isArray(hubUsernames) ? cloneForTicketsOrgCache(hubUsernames) : [],
        expiringSoonDays: liveExpiringSoonDaysForOrgCache(),
    });
    if (window.offlineTickets && typeof window.offlineTickets.persistTicketsOrgSnapshot === 'function') {
        void window.offlineTickets.persistTicketsOrgSnapshot(orgId, tickets, hubUsernames);
    }
}

const HUB_TICKET_PAGE_LIMIT = 50;
const SIDEBAR_TICKET_PAGE_LIMIT = 500;

function hubExpiredTicketsCacheKey(orgId, range) {
    return `${orgId}|${range.dateField}|${range.from}|${range.to}`;
}

function hubExpiredTicketsAllInRangeCacheKey(orgId, range) {
    return `${hubExpiredTicketsCacheKey(orgId, range)}|all`;
}

function hubActiveTicketsCacheKey(orgId) {
    return orgId != null && orgId !== '' ? String(orgId) : '_none';
}

function hubCombinedTicketsCacheKey(orgId, range) {
    return `${hubActiveTicketsCacheKey(orgId)}|${range.dateField}|${range.from}|${range.to}`;
}

function clearHubExpiredTickets() {
    window.HUB_EXPIRED_TICKETS = [];
    window.HUB_EXPIRED_TICKETS_META = null;
    window.HUB_EXPIRED_IN_RANGE_COUNT = null;
    window.HUB_EXPIRED_LOADING = false;
}

function clearHubActiveTickets() {
    window.HUB_ACTIVE_TICKETS = [];
    window.HUB_ACTIVE_TICKETS_META = null;
    window.HUB_ACTIVE_LOADING = false;
}

function clearHubCombinedTickets() {
    window.HUB_COMBINED_TICKETS = [];
    window.HUB_COMBINED_TICKETS_META = null;
    window.HUB_COMBINED_LOADING = false;
}

function clearHubTicketSlices() {
    clearHubActiveTickets();
    clearHubExpiredTickets();
    clearHubCombinedTickets();
    if (typeof clearHubRecentlyOpenedTickets === 'function') {
        clearHubRecentlyOpenedTickets();
    } else {
        window.HUB_RECENTLY_OPENED_TICKETS = [];
    }
    window.HUB_FILTERED_STAT_META = null;
}

function getHubTicketLoadOrgId() {
    return window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
        ? window.orgSelectorModule.getCurrentOrgId()
        : window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId;
}

function normalizeHubTicketPageLimit(value, maxCap) {
    const cap =
        Number.isFinite(maxCap) && maxCap > 0 ? Math.floor(maxCap) : HUB_TICKET_PAGE_LIMIT;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return cap;
    return Math.max(1, Math.min(cap, Math.floor(n)));
}

function mergeHubTicketSummaryPage(list, existingTickets) {
    const source = Array.isArray(list) ? list : [];
    const cacheMap =
        typeof indexTicketsForSummaryMerge === 'function'
            ? indexTicketsForSummaryMerge(existingTickets || [])
            : new Map();
    return source.map((summary) => {
        const prev =
            typeof findCachedTicketForSummary === 'function'
                ? findCachedTicketForSummary(summary, cacheMap)
                : cacheMap.get(String(summary && summary.id));
        return prev && typeof mergeSummaryIntoCachedTicket === 'function'
            ? mergeSummaryIntoCachedTicket(prev, summary)
            : summary;
    });
}

function stampExpiredListScopeOnTickets(tickets) {
    (tickets || []).forEach((t) => {
        if (!t || typeof t !== 'object') return;
        t.listScope = 'expired';
        t.computedWorkflowStatus = 'EXPIRED';
        t.status = 'EXPIRED';
        t.workflowStatus = 'EXPIRED';
    });
}

async function fetchHubTicketSummaryPage(kind, orgId, opts) {
    const options = opts || {};
    const limit = normalizeHubTicketPageLimit(options.limit, options.maxLimit);
    let url;
    if (kind === 'expired') {
        const range = options.range;
        url = orgId
            ? `${window.authModule.API_BASE}/tickets?organizationId=${encodeURIComponent(orgId)}&summary=1&expiredOnly=1&dateField=${encodeURIComponent(range.dateField)}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&limit=${limit}`
            : `${window.authModule.API_BASE}/tickets?summary=1&expiredOnly=1&dateField=${encodeURIComponent(range.dateField)}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&limit=${limit}`;
    } else {
        url = orgId
            ? `${window.authModule.API_BASE}/tickets?organizationId=${encodeURIComponent(orgId)}&summary=1&activeOnly=1&limit=${limit}`
            : `${window.authModule.API_BASE}/tickets?includeShared=1&summary=1&activeOnly=1&limit=${limit}`;
    }
    if (options.cursor) url += `&cursor=${encodeURIComponent(options.cursor)}`;
    const raw = await window.authModule.apiRequest(url);
    let list = raw && typeof raw === 'object' && Array.isArray(raw.tickets) ? raw.tickets : [];
    if (window.authModule.isTechInCurrentOrg && window.authModule.isTechInCurrentOrg()) {
        list = list.filter((t) => !t || !t.shared);
    }
    const existing = Array.isArray(options.existingTickets) ? options.existingTickets : [];
    const merged = mergeHubTicketSummaryPage(list, existing);
    if (kind === 'expired') {
        stampExpiredListScopeOnTickets(merged);
    }
    return {
        tickets: merged,
        hasMore: !!(raw && raw.hasMore),
        nextCursor: raw && raw.nextCursor ? String(raw.nextCursor) : null,
    };
}

async function loadHubExpiredInRangeCount(orgId, range) {
    if (!orgId || !range || !window.authModule) return null;
    try {
        const exp = await window.authModule.apiRequest(
            `${window.authModule.API_BASE}/tickets/expired-count?organizationId=${encodeURIComponent(orgId)}&dateField=${encodeURIComponent(range.dateField)}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
        );
        return exp && typeof exp.expiredCount === 'number' && Number.isFinite(exp.expiredCount)
            ? exp.expiredCount
            : null;
    } catch (_e) {
        return null;
    }
}

function applyHubActivePageToState(pageEntry, cacheKey, orgId) {
    const tickets = pageEntry && Array.isArray(pageEntry.tickets) ? pageEntry.tickets : [];
    if (!window.HUB_ACTIVE_TICKETS) window.HUB_ACTIVE_TICKETS = [];
    window.HUB_ACTIVE_TICKETS.length = 0;
    window.HUB_ACTIVE_TICKETS.push(...tickets);
    if (typeof reapplyTicketStatusesForLoadedCollections === 'function') {
        reapplyTicketStatusesForLoadedCollections();
    }
    const priorMeta = window.HUB_ACTIVE_TICKETS_META || {};
    window.HUB_ACTIVE_TICKETS_META = {
        cacheKey,
        orgId,
        pageIndex: pageEntry.pageIndex,
        hasMore: !!pageEntry.hasMore,
        nextCursor: pageEntry.nextCursor || null,
        pageCache: pageEntry.pageCache || priorMeta.pageCache || {},
        pageSize: HUB_TICKET_PAGE_LIMIT,
    };
}

/**
 * Paginated active rows for Ticket Hub (GET /tickets?activeOnly=1&summary=1).
 * @param {{ pageDirection?: 'first'|'next'|'prev', forceRefresh?: boolean }} [opts]
 */
async function loadActiveTicketsForHub(opts) {
    const options = opts || {};
    const pageDirection =
        options.pageDirection === 'next' || options.pageDirection === 'prev'
            ? options.pageDirection
            : 'first';
    const forceRefresh = options.forceRefresh === true;
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        clearHubActiveTickets();
        return;
    }
    if (typeof window.hubStatusFilterNeedsActiveFetch === 'function' && !window.hubStatusFilterNeedsActiveFetch()) {
        clearHubActiveTickets();
        return;
    }
    const orgId =
        window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
            ? window.orgSelectorModule.getCurrentOrgId()
            : window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId;
    const cacheKey = hubActiveTicketsCacheKey(orgId);
    const meta = window.HUB_ACTIVE_TICKETS_META;
    const sameContext = meta && meta.cacheKey === cacheKey;
    let pageIndex = 1;
    let pageCache = sameContext && meta.pageCache && typeof meta.pageCache === 'object' ? { ...meta.pageCache } : {};

    if (pageDirection === 'next' && sameContext && meta.pageIndex >= 1) {
        pageIndex = meta.pageIndex + 1;
        if (pageCache[String(pageIndex)]) {
            applyHubActivePageToState({ ...pageCache[String(pageIndex)], pageIndex, pageCache }, cacheKey, orgId);
            return;
        }
    } else if (pageDirection === 'prev' && sameContext && meta.pageIndex > 1) {
        pageIndex = meta.pageIndex - 1;
        if (pageCache[String(pageIndex)]) {
            applyHubActivePageToState({ ...pageCache[String(pageIndex)], pageIndex, pageCache }, cacheKey, orgId);
            return;
        }
    } else if (!forceRefresh && pageDirection === 'first' && sameContext && pageCache['1']) {
        applyHubActivePageToState({ ...pageCache['1'], pageIndex: 1, pageCache }, cacheKey, orgId);
        return;
    } else {
        pageIndex = 1;
        pageCache = {};
    }

    window.HUB_ACTIVE_LOADING = true;
    if (typeof setTicketListDataUpdating === 'function') setTicketListDataUpdating('active-load', true);
    try {
        let cursor = null;
        if (pageDirection === 'next' && sameContext && meta.nextCursor) {
            cursor = meta.nextCursor;
        } else if (pageDirection === 'prev' && pageIndex > 1) {
            const prevEntry = pageCache[String(pageIndex)];
            if (prevEntry && prevEntry.requestCursor != null) {
                cursor = prevEntry.requestCursor;
            } else if (pageCache[String(pageIndex - 1)] && pageCache[String(pageIndex - 1)].nextCursor) {
                cursor = pageCache[String(pageIndex - 1)].nextCursor;
            }
        }
        let url = orgId
            ? `${window.authModule.API_BASE}/tickets?organizationId=${encodeURIComponent(orgId)}&summary=1&activeOnly=1&limit=${HUB_TICKET_PAGE_LIMIT}`
            : `${window.authModule.API_BASE}/tickets?includeShared=1&summary=1&activeOnly=1&limit=${HUB_TICKET_PAGE_LIMIT}`;
        if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
        const raw = await window.authModule.apiRequest(url);
        let list = [];
        if (raw && typeof raw === 'object' && Array.isArray(raw.tickets)) {
            list = raw.tickets;
        }
        if (window.authModule.isTechInCurrentOrg && window.authModule.isTechInCurrentOrg()) {
            list = list.filter((t) => !t || !t.shared);
        }
        const cacheMap =
            typeof indexTicketsForSummaryMerge === 'function'
                ? indexTicketsForSummaryMerge(window.HUB_ACTIVE_TICKETS || [])
                : new Map();
        const mergedList = list.map((summary) => {
            const prev =
                typeof findCachedTicketForSummary === 'function'
                    ? findCachedTicketForSummary(summary, cacheMap)
                    : cacheMap.get(String(summary && summary.id));
            return prev && typeof mergeSummaryIntoCachedTicket === 'function'
                ? mergeSummaryIntoCachedTicket(prev, summary)
                : summary;
        });
        const nextCursor = raw && raw.nextCursor ? String(raw.nextCursor) : null;
        const hasMore = !!(raw && raw.hasMore);
        pageCache[String(pageIndex)] = {
            tickets: mergedList,
            hasMore,
            nextCursor,
            requestCursor: cursor,
        };
        applyHubActivePageToState(
            {
                tickets: mergedList,
                pageIndex,
                hasMore,
                nextCursor,
                pageCache,
            },
            cacheKey,
            orgId
        );
    } catch (err) {
        console.error('Error loading active tickets for hub:', err);
        if (pageDirection === 'first') clearHubActiveTickets();
    } finally {
        window.HUB_ACTIVE_LOADING = false;
        if (typeof setTicketListDataUpdating === 'function') setTicketListDataUpdating('active-load', false);
    }
}

function applyHubCombinedPageToState(pageEntry, cacheKey, orgId, range) {
    const tickets = pageEntry && Array.isArray(pageEntry.tickets) ? pageEntry.tickets : [];
    if (!window.HUB_COMBINED_TICKETS) window.HUB_COMBINED_TICKETS = [];
    window.HUB_COMBINED_TICKETS.length = 0;
    window.HUB_COMBINED_TICKETS.push(...tickets);
    // Re-stamp expired membership after merge/cache so badges never stay NOT_READY until popup open.
    const expiredInCombined = [];
    window.HUB_COMBINED_TICKETS.forEach((t) => {
        if (!t || typeof t !== 'object') return;
        let isExpired =
            t.listScope === 'expired' ||
            t.hubListScope === 'expired' ||
            t.computedWorkflowStatus === 'EXPIRED' ||
            t.status === 'EXPIRED';
        if (!isExpired && window.ticketImporterModule && typeof window.ticketImporterModule.resolveTicketLifecycleStatus === 'function') {
            isExpired = window.ticketImporterModule.resolveTicketLifecycleStatus(t) === 'EXPIRED';
        }
        if (!isExpired) return;
        t.listScope = 'expired';
        t.computedWorkflowStatus = 'EXPIRED';
        t.status = 'EXPIRED';
        t.workflowStatus = 'EXPIRED';
        expiredInCombined.push(t);
    });
    if (typeof syncExpiredLifecycleIntoOrgTickets === 'function') {
        syncExpiredLifecycleIntoOrgTickets(expiredInCombined);
    }
    if (typeof reapplyTicketStatusesForLoadedCollections === 'function') {
        reapplyTicketStatusesForLoadedCollections();
    }
    if (typeof window.renderHubStats === 'function') {
        window.renderHubStats();
    }
    const priorMeta = window.HUB_COMBINED_TICKETS_META || {};
    window.HUB_COMBINED_TICKETS_META = {
        cacheKey,
        orgId,
        from: range.from,
        to: range.to,
        dateField: range.dateField,
        pageIndex: pageEntry.pageIndex,
        hasMore: !!pageEntry.hasMore,
        activeNextCursor: pageEntry.activeNextCursor || null,
        activeExhausted: pageEntry.activeExhausted === true,
        expiredNextCursor: pageEntry.expiredNextCursor || null,
        expiredExhausted: pageEntry.expiredExhausted === true,
        pageCache: pageEntry.pageCache || priorMeta.pageCache || {},
        pageSize: HUB_TICKET_PAGE_LIMIT,
    };
}

/**
 * Combined Ticket Hub Total page: active bucket first, then expired rows inside the selected expired range.
 * @param {{ pageDirection?: 'first'|'next'|'prev', forceRefresh?: boolean }} [opts]
 */
async function loadCombinedTicketsForHub(opts) {
    const options = opts || {};
    const pageDirection =
        options.pageDirection === 'next' || options.pageDirection === 'prev'
            ? options.pageDirection
            : 'first';
    const forceRefresh = options.forceRefresh === true;
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        clearHubCombinedTickets();
        return;
    }
    if (typeof window.hubListPagerMode === 'function' && window.hubListPagerMode() !== 'combined') {
        clearHubCombinedTickets();
        return;
    }
    if (typeof window.resolveHubExpiredDateRange !== 'function') return;

    const range = window.resolveHubExpiredDateRange();
    const orgId = getHubTicketLoadOrgId();
    const cacheKey = hubCombinedTicketsCacheKey(orgId, range);
    const meta = window.HUB_COMBINED_TICKETS_META;
    const sameContext = meta && meta.cacheKey === cacheKey;
    let pageIndex = 1;
    let pageCache = sameContext && meta.pageCache && typeof meta.pageCache === 'object' ? { ...meta.pageCache } : {};

    if (pageDirection === 'next' && sameContext && meta.pageIndex >= 1) {
        pageIndex = meta.pageIndex + 1;
        if (pageCache[String(pageIndex)]) {
            applyHubCombinedPageToState(
                { ...pageCache[String(pageIndex)], pageIndex, pageCache },
                cacheKey,
                orgId,
                range
            );
            return;
        }
    } else if (pageDirection === 'prev' && sameContext && meta.pageIndex > 1) {
        pageIndex = meta.pageIndex - 1;
        if (pageCache[String(pageIndex)]) {
            applyHubCombinedPageToState(
                { ...pageCache[String(pageIndex)], pageIndex, pageCache },
                cacheKey,
                orgId,
                range
            );
            return;
        }
    } else if (!forceRefresh && pageDirection === 'first' && sameContext && pageCache['1']) {
        applyHubCombinedPageToState({ ...pageCache['1'], pageIndex: 1, pageCache }, cacheKey, orgId, range);
        return;
    } else {
        pageIndex = 1;
        pageCache = {};
    }

    const previousEntry = pageIndex > 1 ? pageCache[String(pageIndex - 1)] : null;
    if (pageIndex > 1 && !previousEntry) return;

    let activeNextCursor = previousEntry ? previousEntry.activeNextCursor || null : null;
    let activeExhausted = previousEntry ? previousEntry.activeExhausted === true : false;
    let expiredNextCursor = previousEntry ? previousEntry.expiredNextCursor || null : null;
    let expiredExhausted = previousEntry ? previousEntry.expiredExhausted === true : false;
    let fetchedExpiredRows = false;
    const tickets = [];

    window.HUB_COMBINED_LOADING = true;
    if (typeof setTicketListDataUpdating === 'function') setTicketListDataUpdating('combined-load', true);
    try {
        if (pageIndex === 1) {
            window.HUB_EXPIRED_IN_RANGE_COUNT = await loadHubExpiredInRangeCount(orgId, range);
        }
        const existingTicketsForMerge = []
            .concat(window.HUB_COMBINED_TICKETS || [])
            .concat(window.HUB_ACTIVE_TICKETS || [])
            .concat(window.HUB_EXPIRED_TICKETS || []);

        let guard = 0;
        while (tickets.length < HUB_TICKET_PAGE_LIMIT && !activeExhausted && guard < 20) {
            guard += 1;
            const remaining = HUB_TICKET_PAGE_LIMIT - tickets.length;
            const page = await fetchHubTicketSummaryPage('active', orgId, {
                limit: remaining,
                cursor: activeNextCursor,
                existingTickets: existingTicketsForMerge.concat(tickets),
            });
            tickets.push(...page.tickets);
            activeNextCursor = page.nextCursor || null;
            activeExhausted = !page.hasMore || !activeNextCursor;
            if (page.tickets.length === 0 && !page.hasMore) break;
        }

        guard = 0;
        while (
            tickets.length < HUB_TICKET_PAGE_LIMIT &&
            activeExhausted &&
            !expiredExhausted &&
            guard < 20
        ) {
            guard += 1;
            fetchedExpiredRows = true;
            const remaining = HUB_TICKET_PAGE_LIMIT - tickets.length;
            const page = await fetchHubTicketSummaryPage('expired', orgId, {
                limit: remaining,
                cursor: expiredNextCursor,
                range,
                existingTickets: existingTicketsForMerge.concat(tickets),
            });
            tickets.push(...page.tickets);
            expiredNextCursor = page.nextCursor || null;
            expiredExhausted = !page.hasMore || !expiredNextCursor;
            if (page.tickets.length === 0 && !page.hasMore) break;
        }

        if (
            tickets.length >= HUB_TICKET_PAGE_LIMIT &&
            activeExhausted &&
            !fetchedExpiredRows &&
            typeof window.HUB_EXPIRED_IN_RANGE_COUNT === 'number' &&
            Number.isFinite(window.HUB_EXPIRED_IN_RANGE_COUNT)
        ) {
            expiredExhausted = window.HUB_EXPIRED_IN_RANGE_COUNT <= 0;
        }

        const hasMore = !activeExhausted || !expiredExhausted;
        pageCache[String(pageIndex)] = {
            tickets,
            hasMore,
            activeNextCursor,
            activeExhausted,
            expiredNextCursor,
            expiredExhausted,
        };
        applyHubCombinedPageToState(
            {
                tickets,
                pageIndex,
                hasMore,
                activeNextCursor,
                activeExhausted,
                expiredNextCursor,
                expiredExhausted,
                pageCache,
            },
            cacheKey,
            orgId,
            range
        );
    } catch (err) {
        console.error('Error loading combined tickets for hub:', err);
        if (pageDirection === 'first') clearHubCombinedTickets();
    } finally {
        window.HUB_COMBINED_LOADING = false;
        if (typeof setTicketListDataUpdating === 'function') setTicketListDataUpdating('combined-load', false);
    }
}

async function loadHubTicketSliceForCurrentFilters(opts) {
    if (typeof window.hubStatusFilterIsExpiredOnly === 'function' && window.hubStatusFilterIsExpiredOnly()) {
        clearHubActiveTickets();
        clearHubCombinedTickets();
        return loadExpiredTicketsForHub(opts);
    }
    if (typeof window.hubListPagerMode === 'function' && window.hubListPagerMode() === 'combined') {
        clearHubActiveTickets();
        clearHubExpiredTickets();
        return loadCombinedTicketsForHub(opts);
    }
    if (typeof window.hubStatusFilterNeedsActiveFetch === 'function' && window.hubStatusFilterNeedsActiveFetch()) {
        clearHubActiveTickets();
        clearHubCombinedTickets();
        if (
            typeof window.hubStatusFilterIncludesExpired === 'function' &&
            window.hubStatusFilterIncludesExpired()
        ) {
            return loadExpiredTicketsForHubAllInRange(opts);
        }
        clearHubExpiredTickets();
        return;
    }
    clearHubTicketSlices();
}

/**
 * Load every expired row in the hub timeframe window (for ACTIVE+EXPIRED and similar multi-select filters).
 * Active rows stay in ORG_TICKETS; the hub merges both pools client-side.
 * @param {{ forceRefresh?: boolean }} [opts]
 */
async function loadExpiredTicketsForHubAllInRange(opts) {
    const options = opts || {};
    const forceRefresh = options.forceRefresh === true;
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        clearHubExpiredTickets();
        return;
    }
    if (
        typeof window.hubStatusFilterIncludesExpired !== 'function' ||
        !window.hubStatusFilterIncludesExpired() ||
        (typeof window.hubStatusFilterIsExpiredOnly === 'function' && window.hubStatusFilterIsExpiredOnly())
    ) {
        clearHubExpiredTickets();
        return;
    }
    if (typeof window.resolveHubExpiredDateRange !== 'function') return;

    const range = window.resolveHubExpiredDateRange();
    const orgId = getHubTicketLoadOrgId();
    const cacheKey = hubExpiredTicketsAllInRangeCacheKey(orgId, range);
    const meta = window.HUB_EXPIRED_TICKETS_META;
    if (
        !forceRefresh &&
        meta &&
        meta.cacheKey === cacheKey &&
        meta.loadMode === 'all' &&
        Array.isArray(window.HUB_EXPIRED_TICKETS)
    ) {
        return;
    }

    window.HUB_EXPIRED_LOADING = true;
    if (typeof setTicketListDataUpdating === 'function') setTicketListDataUpdating('expired-load', true);
    try {
        const existingTicketsForMerge = (window.HUB_EXPIRED_TICKETS || []).slice();
        const accumulated = [];
        let cursor = null;
        let pageNum = 0;
        const EXPIRED_SLICE_PAGE_MAX = 40;
        do {
            const page = await fetchHubTicketSummaryPage('expired', orgId, {
                limit: SIDEBAR_TICKET_PAGE_LIMIT,
                maxLimit: SIDEBAR_TICKET_PAGE_LIMIT,
                cursor,
                range,
                existingTickets: existingTicketsForMerge.concat(accumulated),
            });
            accumulated.push(...page.tickets);
            pageNum += 1;
            let nextCursor = page.hasMore && page.nextCursor ? page.nextCursor : null;
            if (nextCursor && pageNum >= EXPIRED_SLICE_PAGE_MAX) {
                console.warn(
                    `[tickets] expired slice load hit safety cap of ${EXPIRED_SLICE_PAGE_MAX} pages; stopping with ${accumulated.length} tickets.`
                );
                nextCursor = null;
            }
            cursor = nextCursor;
        } while (cursor);

        if (!window.HUB_EXPIRED_TICKETS) window.HUB_EXPIRED_TICKETS = [];
        window.HUB_EXPIRED_TICKETS.length = 0;
        accumulated.forEach((t) => {
            if (!t || typeof t !== 'object') return;
            t.listScope = 'expired';
            t.computedWorkflowStatus = 'EXPIRED';
            t.status = 'EXPIRED';
            t.workflowStatus = 'EXPIRED';
        });
        window.HUB_EXPIRED_TICKETS.push(...accumulated);
        if (typeof syncExpiredLifecycleIntoOrgTickets === 'function') {
            syncExpiredLifecycleIntoOrgTickets(window.HUB_EXPIRED_TICKETS);
        }
        if (typeof reapplyTicketStatusesForLoadedCollections === 'function') {
            reapplyTicketStatusesForLoadedCollections();
        }
        window.HUB_EXPIRED_TICKETS_META = {
            cacheKey,
            orgId,
            from: range.from,
            to: range.to,
            dateField: range.dateField,
            loadMode: 'all',
            pageIndex: 1,
            hasMore: false,
            nextCursor: null,
            pageCache: {},
            pageSize: accumulated.length,
        };

        if (orgId) {
            window.HUB_EXPIRED_IN_RANGE_COUNT = await loadHubExpiredInRangeCount(orgId, range);
        }
    } catch (err) {
        console.error('Error loading expired tickets for hub slice:', err);
        clearHubExpiredTickets();
    } finally {
        window.HUB_EXPIRED_LOADING = false;
        if (typeof setTicketListDataUpdating === 'function') setTicketListDataUpdating('expired-load', false);
        if (
            window.ticketsModule &&
            typeof window.ticketsModule.scheduleViewportPolygonBackfillForVisibleTickets === 'function'
        ) {
            window.ticketsModule.scheduleViewportPolygonBackfillForVisibleTickets();
        }
    }
}

function applyHubExpiredPageToState(pageEntry, cacheKey, orgId, range) {
    const tickets = pageEntry && Array.isArray(pageEntry.tickets) ? pageEntry.tickets : [];
    tickets.forEach((t) => {
        if (!t || typeof t !== 'object') return;
        t.listScope = 'expired';
        t.computedWorkflowStatus = 'EXPIRED';
        t.status = 'EXPIRED';
        t.workflowStatus = 'EXPIRED';
    });
    if (!window.HUB_EXPIRED_TICKETS) window.HUB_EXPIRED_TICKETS = [];
    window.HUB_EXPIRED_TICKETS.length = 0;
    window.HUB_EXPIRED_TICKETS.push(...tickets);
    if (typeof syncExpiredLifecycleIntoOrgTickets === 'function') {
        syncExpiredLifecycleIntoOrgTickets(window.HUB_EXPIRED_TICKETS);
    }
    if (typeof reapplyTicketStatusesForLoadedCollections === 'function') {
        reapplyTicketStatusesForLoadedCollections();
    }
    if (typeof window.renderHubStats === 'function') {
        window.renderHubStats();
    }
    const priorMeta = window.HUB_EXPIRED_TICKETS_META || {};
    window.HUB_EXPIRED_TICKETS_META = {
        cacheKey,
        orgId,
        from: range.from,
        to: range.to,
        dateField: range.dateField,
        pageIndex: pageEntry.pageIndex,
        hasMore: !!pageEntry.hasMore,
        nextCursor: pageEntry.nextCursor || null,
        pageCache: pageEntry.pageCache || priorMeta.pageCache || {},
        pageSize: HUB_TICKET_PAGE_LIMIT,
    };
}

/**
 * Date-bounded expired rows for Ticket Hub (GET /tickets?expiredOnly=1).
 * @param {{ pageDirection?: 'first'|'next'|'prev', forceRefresh?: boolean }} [opts]
 */
async function loadExpiredTicketsForHub(opts) {
    const options = opts || {};
    const pageDirection =
        options.pageDirection === 'next' || options.pageDirection === 'prev'
            ? options.pageDirection
            : 'first';
    const forceRefresh = options.forceRefresh === true;
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        clearHubExpiredTickets();
        return;
    }
    if (typeof window.hubStatusFilterIsExpiredOnly === 'function' && !window.hubStatusFilterIsExpiredOnly()) {
        clearHubExpiredTickets();
        return;
    }
    if (typeof window.resolveHubExpiredDateRange !== 'function') return;
    const range = window.resolveHubExpiredDateRange();
    const orgId =
        window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
            ? window.orgSelectorModule.getCurrentOrgId()
            : window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId;
    const cacheKey = hubExpiredTicketsCacheKey(orgId, range);
    const meta = window.HUB_EXPIRED_TICKETS_META;
    const sameContext = meta && meta.cacheKey === cacheKey;
    let pageIndex = 1;
    let pageCache = sameContext && meta.pageCache && typeof meta.pageCache === 'object' ? { ...meta.pageCache } : {};

    if (pageDirection === 'next' && sameContext && meta.pageIndex >= 1) {
        pageIndex = meta.pageIndex + 1;
        if (pageCache[String(pageIndex)]) {
            applyHubExpiredPageToState(
                { ...pageCache[String(pageIndex)], pageIndex, pageCache },
                cacheKey,
                orgId,
                range
            );
            return;
        }
    } else if (pageDirection === 'prev' && sameContext && meta.pageIndex > 1) {
        pageIndex = meta.pageIndex - 1;
        if (pageCache[String(pageIndex)]) {
            applyHubExpiredPageToState(
                { ...pageCache[String(pageIndex)], pageIndex, pageCache },
                cacheKey,
                orgId,
                range
            );
            return;
        }
    } else if (!forceRefresh && pageDirection === 'first' && sameContext && pageCache['1']) {
        applyHubExpiredPageToState({ ...pageCache['1'], pageIndex: 1, pageCache }, cacheKey, orgId, range);
        return;
    } else {
        pageIndex = 1;
        pageCache = {};
    }

    window.HUB_EXPIRED_LOADING = true;
    if (typeof setTicketListDataUpdating === 'function') setTicketListDataUpdating('expired-load', true);
    try {
        let cursor = null;
        if (pageDirection === 'next' && sameContext && meta.nextCursor) {
            cursor = meta.nextCursor;
        } else if (pageDirection === 'prev' && pageIndex > 1) {
            const prevEntry = pageCache[String(pageIndex)];
            if (prevEntry && prevEntry.requestCursor != null) {
                cursor = prevEntry.requestCursor;
            } else if (pageCache[String(pageIndex - 1)] && pageCache[String(pageIndex - 1)].nextCursor) {
                cursor = pageCache[String(pageIndex - 1)].nextCursor;
            }
        }
        let url = orgId
            ? `${window.authModule.API_BASE}/tickets?organizationId=${encodeURIComponent(orgId)}&summary=1&expiredOnly=1&dateField=${encodeURIComponent(range.dateField)}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&limit=${HUB_TICKET_PAGE_LIMIT}`
            : `${window.authModule.API_BASE}/tickets?summary=1&expiredOnly=1&dateField=${encodeURIComponent(range.dateField)}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&limit=${HUB_TICKET_PAGE_LIMIT}`;
        if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
        const raw = await window.authModule.apiRequest(url);
        let list = [];
        if (raw && typeof raw === 'object' && Array.isArray(raw.tickets)) {
            list = raw.tickets;
        }
        if (window.authModule.isTechInCurrentOrg && window.authModule.isTechInCurrentOrg()) {
            list = list.filter((t) => !t || !t.shared);
        }
        const cacheMap =
            typeof indexTicketsForSummaryMerge === 'function'
                ? indexTicketsForSummaryMerge(window.HUB_EXPIRED_TICKETS || [])
                : new Map();
        const mergedList = list.map((summary) => {
            const prev =
                typeof findCachedTicketForSummary === 'function'
                    ? findCachedTicketForSummary(summary, cacheMap)
                    : cacheMap.get(String(summary && summary.id));
            return prev && typeof mergeSummaryIntoCachedTicket === 'function'
                ? mergeSummaryIntoCachedTicket(prev, summary)
                : summary;
        });
        const nextCursor = raw && raw.nextCursor ? String(raw.nextCursor) : null;
        const hasMore = !!(raw && raw.hasMore);
        pageCache[String(pageIndex)] = {
            tickets: mergedList,
            hasMore,
            nextCursor,
            requestCursor: cursor,
        };
        applyHubExpiredPageToState(
            {
                tickets: mergedList,
                pageIndex,
                hasMore,
                nextCursor,
                pageCache,
            },
            cacheKey,
            orgId,
            range
        );
        if (orgId && pageIndex === 1) {
            try {
                const exp = await window.authModule.apiRequest(
                    `${window.authModule.API_BASE}/tickets/expired-count?organizationId=${encodeURIComponent(orgId)}&dateField=${encodeURIComponent(range.dateField)}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
                );
                window.HUB_EXPIRED_IN_RANGE_COUNT =
                    exp && typeof exp.expiredCount === 'number' && Number.isFinite(exp.expiredCount)
                        ? exp.expiredCount
                        : null;
            } catch (_e) {
                window.HUB_EXPIRED_IN_RANGE_COUNT = null;
            }
        }
    } catch (err) {
        console.error('Error loading expired tickets for hub:', err);
        if (pageDirection === 'first') clearHubExpiredTickets();
    } finally {
        window.HUB_EXPIRED_LOADING = false;
        if (typeof setTicketListDataUpdating === 'function') setTicketListDataUpdating('expired-load', false);
        if (
            window.ticketsModule &&
            typeof window.ticketsModule.scheduleViewportPolygonBackfillForVisibleTickets === 'function'
        ) {
            window.ticketsModule.scheduleViewportPolygonBackfillForVisibleTickets();
        }
    }
}

/** Rewrite the cached ticket list for an org from current `ORG_TICKETS` (after deletes, 811 refresh, etc.). */
function refreshTicketsOrgCacheSnapshot(orgIdOverride) {
    if (!window.authModule || !window.authModule.isAuthenticated()) return;
    const orgId =
        orgIdOverride != null && orgIdOverride !== ''
            ? orgIdOverride
            : window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
              ? window.orgSelectorModule.getCurrentOrgId()
              : window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId;
    putTicketsOrgCache(orgId, window.ORG_TICKETS || [], window.TICKET_HUB_ORG_USERNAMES || []);
}

async function finishTicketsLoadFromMemory(applySelectionRenderAndMaybePopup) {
    if (typeof reapplyTicketStatusesForLoadedCollections === 'function') {
        reapplyTicketStatusesForLoadedCollections();
    }
    if (typeof window.refreshTechVisibleTicketNumbers === 'function') {
        try {
            await window.refreshTechVisibleTicketNumbers();
        } catch (_e) {
            /* ignore */
        }
    }
    if (typeof window.refreshProjectAssignmentIndex === 'function') {
        try {
            await window.refreshProjectAssignmentIndex({ force: true });
        } catch (_e) {
            /* ignore */
        }
    }
    applySelectionRenderAndMaybePopup();
    const hubWin = document.getElementById('ticketHubWindow');
    if (hubWin && hubWin.classList.contains('show')) {
        void loadHubTicketSliceForCurrentFilters()
            .then(() => {
                if (typeof hydrateHubTicketJobNames === 'function') {
                    return hydrateHubTicketJobNames();
                }
                return undefined;
            })
            .catch((e) => {
                console.warn('[tickets] hub slice after load:', e.message || e);
            });
    }
    if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
        window.ticketHubModule.redrawIfOpen();
    }
}

async function hydrateHubTicketJobNames(explicitOrgId) {
    const orgId =
        explicitOrgId != null
            ? explicitOrgId
            : window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
              ? window.orgSelectorModule.getCurrentOrgId()
              : null;
    if (orgId == null || !window.authModule || !window.authModule.apiRequest) return;
    try {
        const data = await window.authModule.apiRequest(
            `${window.authModule.API_BASE}/tickets/hub-job-fields?organizationId=${encodeURIComponent(String(orgId))}`
        );
        const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
        if (!jobs.length) return;
        const byNumber = new Map();
        jobs.forEach((row) => {
            if (!row || !row.ticketNumber) return;
            const job = row.ngenUserReference || row.jobName || '';
            if (!job) return;
            byNumber.set(String(row.ticketNumber).trim(), job);
        });
        [window.ORG_TICKETS, window.HUB_ACTIVE_TICKETS, window.HUB_EXPIRED_TICKETS, window.HUB_COMBINED_TICKETS].forEach(
            (list) => {
                if (!Array.isArray(list)) return;
                list.forEach((ticket) => {
                    if (!ticket || !ticket.ticketNumber) return;
                    const job = byNumber.get(String(ticket.ticketNumber).trim());
                    if (job) {
                        ticket.ngenUserReference = job;
                        ticket.jobName = job;
                    }
                });
            }
        );
        if (typeof window.renderHubTable === 'function') window.renderHubTable();
    } catch (e) {
        console.warn('[tickets] hydrateHubTicketJobNames:', e.message || e);
    }
}

// Load tickets for the currently selected organization (e.g. when switching org)
