// Tickets module - Ticket management and rendering

// Store ticket map layers: { polygon, marker } (811 bubble when zoom < TICKET_POLYGON_MIN_ZOOM)
let ticketMapEntries = [];
let ticketLayerGroup = null; // Layer group for ticket polygons (and high-zoom loading spinners)
// 811 point markers live here so large active sets cluster instead of dropping thousands of icons.
let ticketMarkerClusterGroup = null;
let selectedTicketId = null;
let shouldAutoZoomToAllTickets = true; // Only auto-zoom on initial load
const selectedTicketRefreshLoadingTickets = new Set();
const ticketOperatorResponsesLoadInFlight = new Set();
/** One forced lite refresh per ticket when indexed counts imply rows but D1 is empty. */
const ticketOperatorResponsesCountsForceAttempted = new Set();

/** At zoom >= this value, show full ticket polygons; below it, show 811 point markers only. */
const TICKET_POLYGON_MIN_ZOOM = 16;
/** Preferred zoom when opening a ticket if geometry fits in the visible map viewport. */
const TICKET_OPEN_ZOOM_PREFERRED = 20;
/** Floor zoom when opening a ticket (matches polygon visibility threshold). */
const TICKET_OPEN_ZOOM_MIN = TICKET_POLYGON_MIN_ZOOM;
/** Extra feet beyond viewport edges when prefetching ticket polygons (tune 500 → 1000 if needed). */
const TICKET_POLYGON_BACKFILL_BUFFER_FT = 500;
/** At zoom >= this value, ticket polygon fill is fully transparent (outline only). */
const TICKET_POLYGON_FILL_TRANSPARENT_MIN_ZOOM = 21;
const DEFAULT_TICKET_PER_REFRESH_LOCK_MS = 2 * 60 * 1000;
/** Client lock window for per-ticket detail refresh; matches Worker `getTicketDetailCoopLockMs` (wrangler `TICKET_DETAIL_COOP_LOCK_MS`, loaded via `loadPublicWorkerConfig`). */
function getTicketPerRefreshLockMs() {
    const w = typeof window !== 'undefined' && window.LOCUS_TICKET_DETAIL_COOP_LOCK_MS;
    const n = typeof w === 'number' ? w : parseInt(String(w != null ? w : ''), 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TICKET_PER_REFRESH_LOCK_MS;
}

/** True when per-ticket nGen full detail was refreshed within the cooperative lock window (mirrors Worker lite refresh skip). */
function isTicketResponsesLockoutFresh(ticket) {
    if (!ticket || ticket.ngenSearchStub) return false;
    const at = ticket.ngenFullDetailRefreshedAt;
    if (at == null || typeof at !== 'string' || !at.trim()) return false;
    const ts = Date.parse(at);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < getTicketPerRefreshLockMs();
}

function isNvPublicImportTicketClient(ticket) {
    if (!ticket) return false;
    const src = ticket.source != null ? String(ticket.source).trim() : '';
    if (src === 'nv_api' || src === 'nv_api_cache') return true;
    const lane = ticket.syncLane != null ? String(ticket.syncLane).trim().toLowerCase() : '';
    return lane === 'posr_public';
}

/** Rows for popup/hub tables: operatorResponses, else stationDetails fallback. */
function ticketOperatorResponseRowsForDisplay(ticket) {
    if (!ticket || typeof ticket !== 'object') return [];
    const responses = Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses : [];
    const revMod = window.operatorResponseRevisionModule;
    const filtered =
        revMod && typeof revMod.filterOperatorResponsesForCurrentRevision === 'function'
            ? revMod.filterOperatorResponsesForCurrentRevision(ticket, responses)
            : responses;
    if (filtered.length > 0) return filtered;
    const current =
        revMod && typeof revMod.resolveTicketCurrentRevisionForOperatorFilter === 'function'
            ? revMod.resolveTicketCurrentRevisionForOperatorFilter(ticket)
            : '';
    if (
        current &&
        responses.some(function (r) {
            const snap =
                r && r.ticketRevisionSnapshot != null ? String(r.ticketRevisionSnapshot).trim() : '';
            return (
                snap &&
                revMod &&
                typeof revMod.revisionsMatch === 'function' &&
                !revMod.revisionsMatch(snap, current)
            );
        })
    ) {
        return [];
    }
    const details = Array.isArray(ticket.stationDetails) ? ticket.stationDetails : [];
    if (details.length === 0) return [];
    return details.map((d, index) => ({
        id: `detail-${index}`,
        stationCode: d.code || d.stationCode || d.operatorCode || null,
        operatorCode: d.code || d.stationCode || d.operatorCode || null,
        operatorName: d.name || d.operatorName || null,
        statusCode: d.responseCode != null ? d.responseCode : d.statusCode,
        respondedAt: d.responseDate || d.respondedAt || null,
        comment: d.comment || null,
        operatorStatus: d.operatorStatus || null,
    }));
}

function hasCompletedTicketOperatorResponsesHydration(ticket) {
    if (ticket && ticket.posrPortalDetailsOnly === true) {
        return true;
    }
    return !!(ticket && ticket.hasFullDetail === true);
}

/**
 * True when operator rows are safe to paint (in memory or after D1 hydrate).
 * Do not treat cooperative-lock freshness alone as ready: slim list rows keep
 * `ngenFullDetailRefreshedAt` but strip `operatorResponses`, which would skip hydrate forever.
 */
function canShowTicketOperatorResponsesNow(ticket) {
    if (!ticket) return false;
    if (ticket.posrPortalDetailsOnly === true) return true;
    if (ticketOperatorResponseRowsForDisplay(ticket).length > 0) return true;
    // POSR tickets always have utilities; empty rows mean fetch is still required.
    if (isNvPublicImportTicketClient(ticket)) return false;
    if (hasCompletedTicketOperatorResponsesHydration(ticket)) return true;
    return false;
}

/** Never paint an empty operator table while detail is still loading or a fetch is in flight. */
function shouldDeferPosrOperatorResponsesEmptyState(ticket) {
    if (!ticket) return false;
    if (ticket.posrPortalDetailsOnly === true) return false;
    if (ticketOperatorResponseRowsForDisplay(ticket).length > 0) return false;
    const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    const loadStillRunning =
        !!(tn && ticketOperatorResponsesLoadInFlight.has(tn)) ||
        !!(tn && selectedTicketRefreshLoadingTickets.has(tn)) ||
        !!(
            tn &&
            typeof window.isTicketPopupDetailRefreshPending === 'function' &&
            window.isTicketPopupDetailRefreshPending(tn)
        );
    // POSR tickets always have utilities; empty rows mean fetch is still required — but only
    // while hydrate/refresh can still run. After a completed load, show empty rather than spin forever.
    if (isNvPublicImportTicketClient(ticket)) {
        if (!hasCompletedTicketOperatorResponsesHydration(ticket)) return true;
        return loadStillRunning;
    }
    const mod = window.ticketImporterModule;
    const isStub =
        ticket.ngenSearchStub === true ||
        (mod && typeof mod.inferNgenSearchStubFromTicket === 'function' && mod.inferNgenSearchStubFromTicket(ticket));
    if (isStub) return true;
    if (!hasCompletedTicketOperatorResponsesHydration(ticket)) return true;
    const progress = getTicketResponseProgress(ticket);
    if (progress && progress.source === 'ngen' && progress.received != null && progress.received > 0) {
        // Counts say rows should exist but D1 is empty. Keep the spinner only while a
        // hydrate/refresh is actually running — not after it finished with no rows
        // (e.g. nGen credentials missing, or expired ticket that cannot re-fetch).
        return loadStillRunning;
    }
    return false;
}
/** Same sync arrows as Ticket hub list sync control (`#ticketHubUsanPollRefreshBtn` in `index.html`). */
const TICKET_HUB_SYNC_ICON_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M3 21v-5h5"></path></svg>';
let ticketMapZoomListenerAttached = false;
/** True while automatic list sync runs. */
let ticketListUsanSyncBusy = false;
/** Separate indicator for local merge/status and photo-intersection recompute work. */
let ticketListDataBusyReasons = new Set();
/** While summary pages stream in, raw loaded count for progressive sidebar label. */
let ticketListProgressiveLoadedCount = null;
let ticketPhotoIntersectionRefreshTimer = null;
let ticketPhotoIntersectionFollowupTimer = null;
const TICKET_PHOTO_INTERSECTION_REFRESH_DELAY_MS = 2500;
const TICKET_PHOTO_INTERSECTION_FOLLOWUP_DELAY_MS = 6500;

function isTicketListUsanSyncBusy() {
    return ticketListUsanSyncBusy;
}

function setTicketListUsanSyncing(busy) {
    ticketListUsanSyncBusy = !!busy;
}

function setTicketListDataUpdating(reason, busy) {
    const key = String(reason || 'data');
    if (busy) ticketListDataBusyReasons.add(key);
    else ticketListDataBusyReasons.delete(key);
    if (!busy && key === 'summary-load') {
        ticketListProgressiveLoadedCount = null;
        if (typeof clearTicketListFrozenDisplayOrder === 'function') clearTicketListFrozenDisplayOrder();
        if (typeof resetTicketListVirtualSliceCache === 'function') resetTicketListVirtualSliceCache();
        if (typeof renderTicketList === 'function') renderTicketList();
    }
    const el = document.getElementById('ticketListDataSpinner');
    if (el) el.style.display = ticketListDataBusyReasons.size > 0 ? 'inline-block' : 'none';
}

function setTicketListProgressiveLoadedCount(count) {
    ticketListProgressiveLoadedCount =
        count != null && Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : null;
}

function getTicketListProgressiveLoadedCount() {
    return ticketListProgressiveLoadedCount;
}

function isTicketListSummaryLoadBusy() {
    return ticketListDataBusyReasons.has('summary-load');
}

function ticketPolygonMatchesPhotoPoint(ticket, photoPoint) {
    if (!ticket || !ticket.polygon || !photoPoint) return false;
    try {
        const coords = ticket.polygon.coordinates[0].map((c) => [c[1], c[0]]);
        const ticketPolygon = L.polygon(coords);
        const tqm = window.tableQueriesModule;
        const bufferM = tqm?.TICKET_PHOTO_SEARCH_BUFFER_METERS;
        if (bufferM != null && typeof tqm.polygonBoundsContainsPointWithBuffer === 'function') {
            return tqm.polygonBoundsContainsPointWithBuffer(ticketPolygon, photoPoint, bufferM);
        }
        return ticketPolygon.getBounds().contains(photoPoint);
    } catch (_) {
        return false;
    }
}

function recomputeCachedTicketStatusesAfterPhotoChange(photoLat, photoLng, opts) {
    if (!window.ORG_TICKETS || !window.ticketImporterModule) return;
    const requirePointMatch = opts && opts.requirePointMatch === true;
    const photoPoint =
        photoLat !== null && photoLat !== undefined && photoLng !== null && photoLng !== undefined
            ? L.latLng(photoLat, photoLng)
            : null;
    let changed = false;
    (window.ORG_TICKETS || []).forEach((ticket) => {
        if (!ticket || !ticket.polygon) return;
        if (requirePointMatch && photoPoint && !ticketPolygonMatchesPhotoPoint(ticket, photoPoint)) return;
        const prevStatus = ticket.status;
        applyTicketStatusFromImporter(ticket);
        if (ticket.status !== prevStatus) changed = true;
    });
    if (changed) {
        renderTickets();
        renderTicketList();
        if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
            window.ticketHubModule.redrawIfOpen();
        }
        const selected = (window.ORG_TICKETS || []).find((ticket) => ticketIdEquals(selectedTicketId, ticket.id));
        if (selected && typeof showTicketPopup === 'function') {
            showTicketPopup(selected);
        }
    }
}

function refreshOpenTicketPopupAfterPhotoChange(opts) {
    const options = opts || {};
    const popup = document.getElementById('ticketPopup');
    if (!popup || !popup.classList.contains('show')) return;

    const popupTicketId = popup.getAttribute('data-popup-ticket-id');
    const ticketId = popupTicketId || selectedTicketId;
    const selected = (window.ORG_TICKETS || []).find((ticket) => ticketIdEquals(ticket.id, ticketId));
    if (!selected || typeof showTicketPopup !== 'function') return;

    const photoPoint =
        options.lat !== null &&
        options.lat !== undefined &&
        options.lng !== null &&
        options.lng !== undefined
            ? L.latLng(options.lat, options.lng)
            : null;
    if (
        options.requirePointMatch === true &&
        photoPoint &&
        typeof ticketPolygonMatchesPhotoPoint === 'function' &&
        !ticketPolygonMatchesPhotoPoint(selected, photoPoint)
    ) {
        return;
    }
    if (selected.ticketPhotoStats && typeof selected.ticketPhotoStats === 'object') {
        selected.ticketPhotoStats.stale = true;
    }
    showTicketPopup(selected);
}

function scheduleTicketPhotoIntersectionRefresh() {
    // ticket_photo_stats removed — photo changes no longer refresh workflow status
}

/**
 * True when POST /tickets/usan-poll actually created or merged at least one ticket (list row) on the server.
 * @param {object|null|undefined} r
 * @returns {boolean}
 */
function usanPollResultTouchedTickets(r) {
    if (!r || typeof r !== 'object') return false;
    if (r.skipped === true) return false;
    const nImp = Number(r.importedCount);
    const nRef = Number(r.refreshedExistingCount);
    if (Number.isFinite(nImp) && nImp > 0) return true;
    if (Number.isFinite(nRef) && nRef > 0) return true;
    if (Array.isArray(r.imported) && r.imported.length > 0) return true;
    if (Array.isArray(r.refreshedExisting) && r.refreshedExisting.length > 0) return true;
    return false;
}

/**
 * POST incremental list poll (not full range), then reload tickets when the poll changed rows.
 * Tech may trigger poll (org-wide sync); ticket UI visibility stays project-filtered.
 * No-op for no hub access / no org / offline / public catalog.
 */
async function runIncrementalUsanListSyncChain() {
    if (!window.authModule || !window.authModule.isAuthenticated()) return;
    if (window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline()) return;
    // Documentation feed workspace never has a USAN account — do not POST usan-poll.
    if (
        (window.orgSelectorModule &&
            typeof window.orgSelectorModule.canUseCurrentDevTicketHub === 'function' &&
            window.orgSelectorModule.canUseCurrentDevTicketHub()) ||
        (typeof window.isCurrentOrgDevTicketHub === 'function' && window.isCurrentOrgDevTicketHub())
    ) {
        return;
    }
    if (
        typeof window.isCurrentOrgPublicCatalogViewer === 'function' &&
        window.isCurrentOrgPublicCatalogViewer()
    ) {
        return;
    }
    if (
        window.ticketHubModule &&
        typeof window.ticketHubModule.canAccessTicketHub === 'function' &&
        !window.ticketHubModule.canAccessTicketHub()
    ) {
        return;
    }
    const orgId = getTicketsRefreshOrgId();
    if (orgId == null || orgId === '') return;

    setTicketListUsanSyncing(true);
    let syncResult = null;
    try {
        syncResult = await window.authModule.apiRequest('tickets/usan-poll', {
            method: 'POST',
            body: JSON.stringify({ organizationId: orgId }),
        });
    } catch (e) {
        console.warn('[tickets] incremental list sync:', e.message || e);
    } finally {
        setTicketListUsanSyncing(false);
    }
    if (syncResult && syncResult.skipped === true) {
        return;
    }
    if (!usanPollResultTouchedTickets(syncResult)) {
        return;
    }
    try {
        await loadTicketsForCurrentOrg({ forceRefresh: true });
    } catch (e2) {
        console.warn('[tickets] load after list sync', e2);
    }
}

/** Selection refresh: POST /tickets/refresh with skipPacEnrichment (lite path). The Worker may skip nGen work when `ngenFullDetailRefreshedAt` is within the ticket detail lock; duration from wrangler `TICKET_DETAIL_COOP_LOCK_MS` (see GET /api/public-config). Shows lightweight per-ticket loading UI while this request is in flight. */
async function refreshTicketLiteForSelection(ticketNumber, opts) {
    if (!ticketNumber || !window.authModule || !window.authModule.isAuthenticated()) return;
    const tn = String(ticketNumber).trim();
    const forceRefresh = !!(opts && opts.forceRefresh);
    const ticket =
        opts && opts.ticket
            ? opts.ticket
            : (window.ORG_TICKETS || []).find(
                  (t) => t && t.ticketNumber != null && String(t.ticketNumber).trim() === tn
              );
    const refreshCtx =
        typeof window.getTicketRefreshRequestContext === 'function'
            ? window.getTicketRefreshRequestContext(ticket || tn)
            : { organizationId: getTicketsRefreshOrgId(), viewerOrganizationId: getTicketsRefreshOrgId() };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20000);
    setSelectedTicketRefreshLoading(tn, true);
    if (typeof window.notifyTicketPopupDetailRefreshPending === 'function') {
        window.notifyTicketPopupDetailRefreshPending(tn, 1);
    }
    try {
        const res = await window.authModule.apiRequest('tickets/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticketNumber: tn,
                skipPacEnrichment: true,
                refreshMode: 'lite',
                ...(forceRefresh ? { forceRefresh: true } : {}),
                ...(refreshCtx.organizationId != null ? { organizationId: refreshCtx.organizationId } : {}),
                ...(refreshCtx.viewerOrganizationId != null
                    ? { viewerOrganizationId: refreshCtx.viewerOrganizationId }
                    : {}),
            }),
            signal: controller.signal,
        });
        const updated = res && res.ticket;
        if (!updated) return;
        const previousTicket =
            ticket ||
            (window.ORG_TICKETS || []).find(
                (t) => t && t.ticketNumber != null && String(t.ticketNumber).trim() === tn
            );
        const refreshed = upsertRefreshedTicketIntoLocalCollections(updated);
        const list = window.ORG_TICKETS || [];
        const live = list.find((x) => ticketIdEquals(x.id, updated.id)) || refreshed;
        applyTicketMapRenderAfterDataUpdate(previousTicket, live);
        renderTicketList();
        if (ticketIdEquals(selectedTicketId, updated.id)) {
            // skipDetailHydrate: refresh already ran; avoid re-kicking ensure/refresh loops.
            showTicketPopup(live, { skipDetailHydrate: true });
        }
        if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
            window.ticketHubModule.redrawIfOpen();
        }
        if (window.ticketsModule && typeof window.ticketsModule.refreshTicketsOrgCacheSnapshot === 'function') {
            const cacheOrgId =
                refreshCtx.viewerOrganizationId != null ? refreshCtx.viewerOrganizationId : getTicketsRefreshOrgId();
            window.ticketsModule.refreshTicketsOrgCacheSnapshot(cacheOrgId);
        }
        if (
            window.ticketDocumentPackFlow &&
            typeof window.ticketDocumentPackFlow.prefetchCurrentConfirmation === 'function'
        ) {
            void window.ticketDocumentPackFlow.prefetchCurrentConfirmation(refreshed || updated);
        }
    } catch (e) {
        if (e.name !== 'AbortError') console.warn('[tickets] selection refresh', e.message || e);
    } finally {
        clearTimeout(t);
        setSelectedTicketRefreshLoading(tn, false);
        if (typeof window.notifyTicketPopupDetailRefreshPending === 'function') {
            window.notifyTicketPopupDetailRefreshPending(tn, -1);
        }
    }
}

function isTicketOperatorResponsesLoadInFlight(ticketNumber) {
    const tn = ticketNumber != null ? String(ticketNumber).trim() : '';
    return !!(tn && ticketOperatorResponsesLoadInFlight.has(tn));
}

/** True while operator responses are not lockout-fresh and a hydrate/refresh is still running. */
function isTicketOperatorResponsesLoadPending(ticket) {
    if (!ticket) return false;
    if (shouldDeferPosrOperatorResponsesEmptyState(ticket)) return true;
    if (canShowTicketOperatorResponsesNow(ticket)) return false;
    const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    if (!tn) return false;
    if (ticketOperatorResponsesLoadInFlight.has(tn)) return true;
    if (selectedTicketRefreshLoadingTickets.has(tn)) return true;
    if (
        typeof window.isTicketPopupDetailRefreshPending === 'function' &&
        window.isTicketPopupDetailRefreshPending(tn)
    ) {
        return true;
    }
    return false;
}

/** @type {Map<string, Promise<object|null>>} */
const dbDetailHydratePromises = new Map();

/** Session pool for tickets opened outside default hub slices (e.g. expired from project detail). */
if (!Array.isArray(window.HUB_RECENTLY_OPENED_TICKETS)) {
    window.HUB_RECENTLY_OPENED_TICKETS = [];
}

function clearHubRecentlyOpenedTickets() {
    window.HUB_RECENTLY_OPENED_TICKETS = [];
}

function parkTicketInRecentlyOpened(ticket) {
    if (!ticket) return null;
    if (!Array.isArray(window.HUB_RECENTLY_OPENED_TICKETS)) {
        window.HUB_RECENTLY_OPENED_TICKETS = [];
    }
    return upsertRefreshedTicketIntoList(window.HUB_RECENTLY_OPENED_TICKETS, ticket, {
        addIfMissing: true,
    });
}

function findTicketInRecentlyOpened(ticketId, ticketNumber) {
    const list = window.HUB_RECENTLY_OPENED_TICKETS;
    if (!Array.isArray(list) || !list.length) return null;
    const tn = ticketNumber != null && String(ticketNumber).trim() !== '' ? String(ticketNumber).trim() : '';
    return (
        list.find(
            (t) =>
                t &&
                ((ticketId != null && t.id != null && String(t.id) === String(ticketId)) ||
                    (tn && String(t.ticketNumber).trim() === tn))
        ) || null
    );
}

/** True when a ticket should not be inserted as a new active ORG_TICKETS row. */
function ticketShouldSkipActiveOrgInsert(ticket) {
    if (!ticket) return true;
    if (ticket.listScope === 'expired' || ticket.hubListScope === 'expired') return true;
    const status =
        typeof getTicketWorkflowStatusForMap === 'function'
            ? getTicketWorkflowStatusForMap(ticket)
            : ticket.status != null
              ? String(ticket.status).toUpperCase()
              : '';
    if (status === 'EXPIRED' || status === 'CANCELLED') return true;
    if (typeof isInactiveWorkflowStatus === 'function' && isInactiveWorkflowStatus(status)) return true;
    const exp =
        ticket.expiresAt ||
        ticket.ticketExpirationDate ||
        ticket.ticket_expires_at ||
        ticket.endTime ||
        null;
    if (exp && typeof isTicketExpired === 'function' && isTicketExpired(exp)) return true;
    return false;
}

/**
 * Resolve a ticket for hub/popup open: memory pools first, else D1 db-detail hydrate.
 * Parks hydrated tickets in HUB_RECENTLY_OPENED_TICKETS so findTicketForHub can resolve them
 * without mutating paginated expired slices or polluting active ORG_TICKETS.
 *
 * @param {{ ticketId?: *, ticketNumber?: *, summary?: object, sessionOnly?: boolean }} args
 *   sessionOnly: park the ticket for this browser session and do not insert a missing row into the active org list.
 * @returns {Promise<object|null>}
 */
async function resolveTicketForOpen(args) {
    const a = args || {};
    const sessionOnly = a.sessionOnly === true;
    const summary = a.summary && typeof a.summary === 'object' ? a.summary : null;
    const ticketId = a.ticketId != null ? a.ticketId : summary && summary.id != null ? summary.id : null;
    const ticketNumberRaw =
        a.ticketNumber != null
            ? a.ticketNumber
            : summary && summary.ticketNumber != null
              ? summary.ticketNumber
              : null;
    const ticketNumber =
        ticketNumberRaw != null && String(ticketNumberRaw).trim() !== ''
            ? String(ticketNumberRaw).trim()
            : '';

    const fromLive = findLiveTicketInLocalCollections({
        id: ticketId,
        ticketNumber: ticketNumber || undefined,
    });
    // Slim / previously parked tickets may be in memory without operator rows. Re-hydrate
    // from D1 when responses are not ready yet (common for expired project opens).
    if (
        fromLive &&
        canShowTicketOperatorResponsesNow(fromLive) &&
        !shouldDeferPosrOperatorResponsesEmptyState(fromLive)
    ) {
        return fromLive;
    }

    if (!ticketNumber) return fromLive || null;

    const stub = Object.assign({}, summary || {}, fromLive || {}, {
        id:
            (fromLive && fromLive.id != null
                ? fromLive.id
                : ticketId != null
                  ? ticketId
                  : summary && summary.id) || undefined,
        ticketNumber,
    });
    const hydrated = await hydrateTicketFromDbDetail(stub, {
        addToOrgIfMissing: sessionOnly ? false : !ticketShouldSkipActiveOrgInsert(stub),
        parkInRecentlyOpened: true,
        sessionOnly,
    });
    // Transient db-detail failures should not hide a usable in-memory pool ticket
    // (e.g. slim expired row already found from Projects / hub slices).
    if (!hydrated) return fromLive || null;
    return findTicketInRecentlyOpened(hydrated.id, hydrated.ticketNumber) || hydrated;
}

/** Fast path: hydrate popup/hub from D1 without external POSR/nGen refresh. */
async function hydrateTicketFromDbDetail(ticket, hydrateOpts) {
    if (
        !ticket ||
        !ticket.ticketNumber ||
        !window.authModule ||
        !window.authModule.isAuthenticated() ||
        typeof window.authModule.apiRequest !== 'function'
    ) {
        return null;
    }
    const opts = hydrateOpts || {};
    const tn = String(ticket.ticketNumber).trim();
    const refreshCtx =
        typeof window.getTicketRefreshRequestContext === 'function'
            ? window.getTicketRefreshRequestContext(ticket)
            : { organizationId: getTicketsRefreshOrgId(), viewerOrganizationId: getTicketsRefreshOrgId() };
    const orgId = refreshCtx.organizationId != null ? refreshCtx.organizationId : getTicketsRefreshOrgId();
    if (!tn || orgId == null || orgId === '') return null;
    const cacheKey = `${orgId}:${tn}`;
    if (dbDetailHydratePromises.has(cacheKey)) {
        return dbDetailHydratePromises.get(cacheKey);
    }
    const skipUiRefresh = opts.skipUiRefresh === true;
    const promise = (async () => {
        if (!skipUiRefresh && typeof window.notifyTicketPopupDetailRefreshPending === 'function') {
            window.notifyTicketPopupDetailRefreshPending(tn, 1);
        }
        try {
            const res = await window.authModule.apiRequest(
                `tickets/db-detail?organizationId=${encodeURIComponent(orgId)}&ticketNumber=${encodeURIComponent(tn)}&include=providerHistory`
            );
            const updated = res && res.ticket;
            if (!updated) return null;
            const previousTicket = findLiveTicketInLocalCollections(ticket) || ticket;
            const sessionOnly = opts.sessionOnly === true;
            const skipOrgInsert = sessionOnly || ticketShouldSkipActiveOrgInsert(updated);
            const addToOrgIfMissing = sessionOnly
                ? false
                : opts.addToOrgIfMissing != null
                  ? !!opts.addToOrgIfMissing && !skipOrgInsert
                  : !skipOrgInsert;
            const hydrated = sessionOnly
                ? null
                : upsertRefreshedTicketIntoLocalCollections(updated, {
                      addToOrgIfMissing,
                  });
            const parked =
                opts.parkInRecentlyOpened === true || skipOrgInsert
                    ? parkTicketInRecentlyOpened(hydrated || updated)
                    : null;
            if (typeof window.syncProviderHistoryStatusFromHydratedTicket === 'function') {
                window.syncProviderHistoryStatusFromHydratedTicket(hydrated || updated);
            }
            const result = parked || hydrated || updated;
            if (!skipUiRefresh) {
                applyTicketMapRenderAfterDataUpdate(previousTicket, result);
                if (!sessionOnly) renderTicketList();
                if (!sessionOnly && window.ticketsModule && typeof window.ticketsModule.refreshTicketsOrgCacheSnapshot === 'function') {
                    const cacheOrgId =
                        refreshCtx.viewerOrganizationId != null ? refreshCtx.viewerOrganizationId : orgId;
                    window.ticketsModule.refreshTicketsOrgCacheSnapshot(cacheOrgId);
                }
                redrawOpenTicketDetailViewsForTicket(result);
            }
            return result;
        } catch (e) {
            console.warn('[tickets] db detail hydrate:', e.message || e);
            return null;
        } finally {
            dbDetailHydratePromises.delete(cacheKey);
            if (!skipUiRefresh && typeof window.notifyTicketPopupDetailRefreshPending === 'function') {
                window.notifyTicketPopupDetailRefreshPending(tn, -1);
            }
        }
    })();
    dbDetailHydratePromises.set(cacheKey, promise);
    return promise;
}

let redrawOpenTicketDetailViewsDepth = 0;
function redrawOpenTicketDetailViewsForTicket(ticket) {
    if (!ticket) return;
    const ackModal = document.getElementById('workflowAckModal');
    if (ackModal && ackModal.style.display && ackModal.style.display !== 'none') return;
    if (redrawOpenTicketDetailViewsDepth > 0) return;
    redrawOpenTicketDetailViewsDepth += 1;
    try {
        redrawOpenTicketDetailViewsForTicketInner(ticket);
    } finally {
        redrawOpenTicketDetailViewsDepth -= 1;
    }
}
function redrawOpenTicketDetailViewsForTicketInner(ticket) {
    const popup = document.getElementById('ticketPopup');
    if (
        popup &&
        popup.classList.contains('show') &&
        ticket.id != null &&
        String(popup.getAttribute('data-popup-ticket-id')) === String(ticket.id)
    ) {
        const live = findLiveTicketInLocalCollections(ticket) || ticket;
        if (typeof window.patchOpenTicketPopupDetail === 'function') {
            window.patchOpenTicketPopupDetail(live);
        } else if (typeof window.showTicketPopup === 'function') {
            const aboveHub = popup.classList.contains('ticket-popup--above-hub');
            void window.showTicketPopup(live, { skipDetailHydrate: true, allowOverTicketHub: aboveHub });
        }
    }
    if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
        window.ticketHubModule.redrawIfOpen();
    }
}
window.redrawOpenTicketDetailViewsForTicket = redrawOpenTicketDetailViewsForTicket;

/**
 * DB hydrate first, then lite nGen refresh when rows are still empty.
 * Cooperative lock skips redundant nGen calls unless indexed counts imply responses should exist
 * (empty D1 after a recent stamp would otherwise leave the hub on a spinner forever).
 * Force-on-counts runs at most once per ticket per page session so missing/invalid nGen
 * credentials cannot loop forever.
 */
async function ensureTicketOperatorResponsesLoaded(ticketNumber, opts) {
    const tn = String(ticketNumber || '').trim();
    if (!tn || !window.authModule || !window.authModule.isAuthenticated()) return;
    if (ticketOperatorResponsesLoadInFlight.has(tn)) return;
    ticketOperatorResponsesLoadInFlight.add(tn);
    const initialTicket =
        (opts && opts.ticket) || findLiveTicketInLocalCollections({ ticketNumber: tn });
    try {
        await hydrateTicketFromDbDetail(initialTicket);
        const live = findLiveTicketInLocalCollections({ ticketNumber: tn }) || initialTicket;
        const displayRows = ticketOperatorResponseRowsForDisplay(live);
        if (live && displayRows.length === 0) {
            if (live && live.posrPortalDetailsOnly === true) {
                /* Portal-only import: no USAN operator fetch */
            } else if (isNvPublicImportTicketClient(live)) {
                await refreshTicketLiteForSelection(tn, {
                    ticket: live,
                    forceRefresh: true,
                });
            } else {
                const progress = getTicketResponseProgress(live);
                const countsImplyResponses =
                    progress &&
                    progress.source === 'ngen' &&
                    progress.received != null &&
                    progress.received > 0;
                const lockoutFresh = isTicketResponsesLockoutFresh(live);
                // db-detail sets hasFullDetail even when operator rows are empty, so do not gate on it.
                if (!lockoutFresh) {
                    await refreshTicketLiteForSelection(tn, {
                        ticket: live,
                        forceRefresh: !!countsImplyResponses,
                    });
                } else if (
                    countsImplyResponses &&
                    !ticketOperatorResponsesCountsForceAttempted.has(tn)
                ) {
                    ticketOperatorResponsesCountsForceAttempted.add(tn);
                    await refreshTicketLiteForSelection(tn, {
                        ticket: live,
                        forceRefresh: true,
                    });
                }
            }
        }
    } catch (e) {
        console.warn('[tickets] ensure operator responses:', e.message || e);
    } finally {
        ticketOperatorResponsesLoadInFlight.delete(tn);
        let live = findLiveTicketInLocalCollections({ ticketNumber: tn }) || initialTicket;
        // Expired/project tickets must stay current in the session pool after lite refresh.
        if (live && ticketShouldSkipActiveOrgInsert(live)) {
            live = parkTicketInRecentlyOpened(live) || live;
        }
        if (typeof window.scheduleNgenProviderResponseHistoryIfNeeded === 'function') {
            window.scheduleNgenProviderResponseHistoryIfNeeded(live);
        }
        redrawOpenTicketDetailViewsForTicket(live);
    }
}

function getEffectiveTimeWarpConstraints() {
    const mod = window.aerialMapPanelModule;
    if (mod && typeof mod.getTimeWarpConstraints === 'function') {
        return mod.getTimeWarpConstraints();
    }
    return null;
}

/** Canonical time for Time Warp: work start, else created, else updated. */
function getTicketTimeWarpMs(ticket) {
    if (!ticket) return null;
    const candidates = [ticket.startTime, ticket.createdAt, ticket.updatedAt];
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!c) continue;
        const t = new Date(c).getTime();
        if (!Number.isNaN(t)) return t;
    }
    return null;
}

function timeWarpFilterActive(c) {
    if (!c || !c.zoomOk) return false;
    if (c.timeActive) return true;
    if (c.search && String(c.search).trim()) return true;
    if (c.viewportOnly && c.viewportBounds) return true;
    return false;
}

function ticketPassesTimeWarp(ticket) {
    const c = getEffectiveTimeWarpConstraints();
    if (!timeWarpFilterActive(c)) return true;

    if (c.timeActive && c.startMs != null && c.endMs != null) {
        const ms = getTicketTimeWarpMs(ticket);
        if (ms != null && (ms < c.startMs || ms > c.endMs)) return false;
    }

    if (c.viewportOnly && c.viewportBounds && ticket.polygon) {
        try {
            const layer = L.geoJSON(ticket.polygon);
            const b = layer.getBounds();
            if (b && typeof b.isValid === 'function' && b.isValid() && !c.viewportBounds.intersects(b)) return false;
        } catch (_) {
            /* ignore */
        }
    }

    if (c.search && String(c.search).trim()) {
        const q = String(c.search).trim().toLowerCase();
        const num = (ticket.ticketNumber || '').toLowerCase();
        const loc = (ticket.locationSummary || '').toLowerCase();
        const wd = (ticket.workDescription || '').toLowerCase();
        if (!num.includes(q) && !loc.includes(q) && !wd.includes(q)) return false;
    }

    return true;
}

// Ticket List Panel state
let ticketListSearch = '';
let ticketListStatusFilter = 'ACTIVE';
let ticketListDateRangeFilter = '7d';
let ticketListDateRangeOrgId = null;
/** @type {'status' | 'expiring_soonest' | 'expiring_latest' | 'starting_soonest' | 'starting_latest'} */
let ticketListSort = 'status';

const TICKET_LIST_SORT_OPTIONS = [
    'status',
    'expiring_soonest',
    'expiring_latest',
    'starting_soonest',
    'starting_latest'
];

function normalizeTicketListSort(value) {
    if (value && TICKET_LIST_SORT_OPTIONS.includes(value)) return value;
    return 'status';
}

/** Sidebar filter only — expired tickets are listed in Ticket hub. */
const SIDEBAR_TICKET_STATUS_OPTIONS = [
    'ACTIVE',
    'ALL',
    'ASSIGNED',
    'READY',
    'NOT_READY',
    'ACTION_REQUIRED',
    'EXPIRING_SOON',
    'EXTERNAL_ONLY',
    'ACTIVE_INTERNAL'
];

function normalizeSidebarTicketStatusFilter(value) {
    if (value && SIDEBAR_TICKET_STATUS_OPTIONS.includes(value)) return value;
    return 'ACTIVE';
}

function normalizeSidebarTicketDateRange(value) {
    const v = String(value || '').toLowerCase();
    if (v === '7d' || v === '14d' || v === '30d' || v === 'all') return v;
    return '7d';
}

function currentOrgUsesDevHubSidebarDateRange() {
    const mod = window.orgSelectorModule;
    return !!(mod && typeof mod.canUseCurrentDevTicketHub === 'function' && mod.canUseCurrentDevTicketHub());
}

function syncSidebarTicketDateRangeControl() {
    const wrap = document.getElementById('ticketSidebarDateRangeWrap');
    const select = document.getElementById('ticketSidebarDateRange');
    const enabled = currentOrgUsesDevHubSidebarDateRange();
    if (wrap) wrap.hidden = !enabled;
    if (!enabled) {
        ticketListDateRangeOrgId = null;
        return;
    }
    const orgId =
        window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
            ? window.orgSelectorModule.getCurrentOrgId()
            : null;
    if (ticketListDateRangeOrgId !== orgId) {
        ticketListDateRangeFilter = '7d';
        ticketListDateRangeOrgId = orgId;
    }
    ticketListDateRangeFilter = normalizeSidebarTicketDateRange(ticketListDateRangeFilter);
    if (select) select.value = ticketListDateRangeFilter;
}

/** Clear sidebar ticket list filters when switching organizations (mirrors hub reset). */
function resetSidebarTicketListFiltersForOrgSwitch() {
    ticketListSearch = '';
    ticketListStatusFilter = 'ACTIVE';
    ticketListSort = 'status';
    ticketListDateRangeFilter = '7d';
    ticketListDateRangeOrgId = null;
    const searchInput = document.getElementById('ticketSearchInput');
    if (searchInput) searchInput.value = '';
    const statusFilter = document.getElementById('ticketStatusFilter');
    if (statusFilter) statusFilter.value = 'ACTIVE';
    const sortFilter = document.getElementById('ticketListSort');
    if (sortFilter) sortFilter.value = 'status';
    const dateRangeFilter = document.getElementById('ticketSidebarDateRange');
    if (dateRangeFilter) dateRangeFilter.value = '7d';
    syncSidebarTicketDateRangeControl();
}

function matchesSidebarTicketDateRange(ticket) {
    if (!currentOrgUsesDevHubSidebarDateRange()) return true;
    const range = normalizeSidebarTicketDateRange(ticketListDateRangeFilter);
    if (range === 'all') return true;
    const days = parseInt(range, 10);
    if (!Number.isFinite(days) || days <= 0) return true;
    const ms = getTicketTimeWarpMs(ticket);
    if (ms == null) return false;
    return ms >= Date.now() - days * 24 * 60 * 60 * 1000;
}

/** When assignees modal is open, which ticket number it refers to (for refresh after PATCH). */
let ticketAssigneesModalTicketNumber = null;

/** Compare ticket ids — API/DB often use numbers; JSON may deserialize as string */
function ticketIdEquals(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return String(a) === String(b);
}

function escapeHtmlTicketUi(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Company that owns the ticket row (partner label when shared; current org from selector otherwise). */
function getTicketOrganizationDisplayName(ticket) {
    if (!ticket) return '—';
    if (ticket.shared) {
        return ticket.sharedSourceLabel != null && String(ticket.sharedSourceLabel).trim() !== ''
            ? String(ticket.sharedSourceLabel).trim()
            : 'Partner organization';
    }
    const orgs =
        window.orgSelectorModule && typeof window.orgSelectorModule.getOrganizations === 'function'
            ? window.orgSelectorModule.getOrganizations()
            : [];
    const oid = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    if (oid == null) return '—';
    const match = orgs.find(o => Number(o.id) === Number(oid));
    if (match && match.name) return String(match.name);
    return '—';
}

function getTicketAssignedUsers(ticket) {
    if (!ticket) return [];
    if (typeof window.getProjectAssigneesForTicket === 'function') {
        return window.getProjectAssigneesForTicket(ticket);
    }
    return [];
}

function ticketIsAssignedToUser(ticket, userId) {
    if (userId == null) return false;
    const normalizedUserId = parseInt(userId, 10);
    if (Number.isNaN(normalizedUserId)) return false;
    if (typeof window.ticketIsAssignedToUserViaProject === 'function') {
        return window.ticketIsAssignedToUserViaProject(ticket, normalizedUserId);
    }
    return getTicketAssignedUsers(ticket).some(a => a.userId === normalizedUserId);
}

/** External = shared-in or lodged-by mismatch. Internal = lodged by org provider account and not shared. */
function hasTicketLodgedByContext() {
    const set = window.TICKET_HUB_ORG_USERNAMES;
    return Array.isArray(set) && set.length > 0;
}

function ticketIsExplicitExternalImportForOrg(ticket) {
    if (!ticket || ticket.externalImportedToOrg == null) return false;
    const v = ticket.externalImportedToOrg;
    if (v === true || v === 1) return true;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        return s === 'true' || s === '1' || s === 'yes';
    }
    return false;
}

function ticketLodgedByMatchesOrgProviderAccount(ticket) {
    const set = window.TICKET_HUB_ORG_USERNAMES;
    if (!ticket || !Array.isArray(set) || set.length === 0) return false;
    const lb = ticket.lodgedByUserName != null ? String(ticket.lodgedByUserName).trim().toLowerCase() : '';
    if (!lb) return false;
    for (let i = 0; i < set.length; i++) {
        const u = String(set[i] || '').trim().toLowerCase();
        if (!u) continue;
        if (lb === u) return true;
        const li = lb.indexOf('@') >= 0 ? lb.split('@')[0] : lb;
        const ui = u.indexOf('@') >= 0 ? u.split('@')[0] : u;
        if (li.length >= 3 && ui.length >= 3 && li === ui) return true;
    }
    return false;
}

function ticketIsInternalOrg(ticket) {
    if (!ticket || ticket.shared) return false;
    if (ticketIsExplicitExternalImportForOrg(ticket)) return false;
    if (!hasTicketLodgedByContext()) return true; // Legacy fallback until context is available
    return ticketLodgedByMatchesOrgProviderAccount(ticket);
}

function ticketIsExternalOrg(ticket) {
    if (!ticket) return false;
    if (ticket.__feedWorkspaceView) return true;
    if (ticket.shared) return true;
    if (ticketIsExplicitExternalImportForOrg(ticket)) return true;
    if (!hasTicketLodgedByContext()) return false; // Legacy fallback until context is available
    return !ticketLodgedByMatchesOrgProviderAccount(ticket);
}

/** Expired and cancelled tickets are excluded from Active sidebar/hub views. */
function isInactiveWorkflowStatus(status) {
    return status === 'EXPIRED' || status === 'CANCELLED';
}

function matchesSidebarTicketListStatusFilter(ticket, filter) {
    if (!ticket) return false;
    const external = ticketIsExternalOrg(ticket);
    if (filter === 'EXTERNAL_ONLY') {
        return external && !isInactiveWorkflowStatus(ticket.status);
    }
    if (filter === 'ACTIVE_INTERNAL') {
        return ticketIsInternalOrg(ticket) && !isInactiveWorkflowStatus(ticket.status);
    }
    if (filter === 'ALL') {
        return !isInactiveWorkflowStatus(ticket.status);
    }
    if (filter === 'ACTIVE') {
        return !isInactiveWorkflowStatus(ticket.status);
    }
    if (filter === 'ASSIGNED') {
        const currentUser = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
        const myId = currentUser && currentUser.id;
        const isTech =
            window.authModule &&
            typeof window.authModule.isTechInCurrentOrg === 'function' &&
            window.authModule.isTechInCurrentOrg();
        if (isTech && typeof isTicketVisibleToTechClient === 'function') {
            return !isInactiveWorkflowStatus(ticket.status) && isTicketVisibleToTechClient(ticket);
        }
        return !isInactiveWorkflowStatus(ticket.status) && ticketIsAssignedToUser(ticket, myId);
    }
    return ticket.status === filter;
}

/** While drawing or measuring, ticket shapes must not capture clicks (map tools need the tap). */
function shouldBlockTicketMapInteraction() {
    if (window.drawingModule && window.drawingModule.currentDrawingMode) return true;
    if (window.measureModule && window.measureModule.measureMode) return true;
    if (typeof window.measureMode !== 'undefined' && window.measureMode) return true;
    if (window.mapQueryPolygonDrawing) return true;
    if (window.photoLocationTagMode) return true;
    if (window.eventLocationDrawing) return true;
    if (window.documentsModule && window.documentsModule.documentLocationMode) return true;
    return false;
}

function applyInteractiveToLeafletLayer(layer, interactive) {
    if (!layer) return;
    if (typeof layer.setStyle === 'function') {
        try {
            layer.setStyle({ interactive: interactive });
            return;
        } catch (err) {
            /* Marker may not support setStyle in some builds */
        }
    }
    layer.options.interactive = interactive;
    if (typeof layer._updateInteractive === 'function') {
        layer._updateInteractive();
    } else if (layer._icon) {
        if (interactive) L.DomUtil.addClass(layer._icon, 'leaflet-interactive');
        else L.DomUtil.removeClass(layer._icon, 'leaflet-interactive');
    }
}

/** Walk nested groups (MultiPolygon, etc.) and set interactive on every path/marker. */
function applyInteractiveToLeafletLayerTree(layer, interactive) {
    if (!layer) return;
    if (typeof layer.eachLayer === 'function') {
        layer.eachLayer(function (sub) {
            applyInteractiveToLeafletLayerTree(sub, interactive);
        });
    }
    applyInteractiveToLeafletLayer(layer, interactive);
}

function syncTicketLayerPointerInteraction() {
    const interactive = !shouldBlockTicketMapInteraction();
    ticketMapEntries.forEach(({ polygon, marker, popupContent, isPublicCatalogTicket }) => {
        if (polygon) {
            if (typeof polygon.setStyle === 'function') {
                try {
                    polygon.setStyle({ interactive: interactive });
                } catch (err) {
                    /* fall through */
                }
            }
            if (typeof polygon.eachLayer === 'function') {
                polygon.eachLayer(function (sub) {
                    applyInteractiveToLeafletLayerTree(sub, interactive);
                });
            }
            if (popupContent && isPublicCatalogTicket) {
                if (!interactive) {
                    polygon.unbindPopup();
                } else if (typeof polygon.getPopup === 'function' && !polygon.getPopup()) {
                    polygon.bindPopup(popupContent);
                }
            } else if (typeof polygon.unbindPopup === 'function') {
                polygon.unbindPopup();
            }
        }
        applyInteractiveToLeafletLayer(marker, interactive);
        if (marker && popupContent && isPublicCatalogTicket) {
            if (!interactive) {
                marker.unbindPopup();
            } else if (typeof marker.getPopup === 'function' && !marker.getPopup()) {
                marker.bindPopup(popupContent);
            }
        } else if (marker && typeof marker.unbindPopup === 'function') {
            marker.unbindPopup();
        }
    });
}

/** When a map tool is active, ignore ticket clicks and forward to the map so tools receive the click. */
function onTicketShapeClickWhileToolActive(e) {
    if (!shouldBlockTicketMapInteraction()) return false;
    if (window.map) {
        window.map.fire('click', e);
    }
    return true;
}

function formatAssigneeCountLabel(count) {
    const n = typeof count === 'number' ? count : parseInt(count, 10);
    if (Number.isNaN(n) || n < 0) return '0 Users';
    if (n === 1) return '1 User';
    return `${n} Users`;
}

/**
 * Merge PATCH ticket JSON into local ticket. Omitted keys (cleared on server) must not be left
 * from the previous object — e.g. empty assignees removes keys from JSON, so spread alone keeps stale data.
 */
function mergeTicketFromServerPatch(prev, updated) {
    if (!prev || !updated) return updated || prev;
    const merged = { ...prev, ...updated };
    if (!Object.prototype.hasOwnProperty.call(updated, 'assignedToUsers')) {
        delete merged.assignedToUsers;
    }
    if (!Object.prototype.hasOwnProperty.call(updated, 'assignedToUserId')) {
        delete merged.assignedToUserId;
        delete merged.assignedToUserName;
    }
    if (updated.ngenSearchStub !== true) {
        delete merged.ngenSearchStub;
    }
    if (updated.stubMapPin == null) {
        delete merged.stubMapPin;
    }
    return merged;
}

function upsertRefreshedTicketIntoList(list, updated, options) {
    if (!Array.isArray(list) || !updated) return null;
    const opts = options || {};
    const idx = list.findIndex(
        (x) =>
            String(x.ticketNumber) === String(updated.ticketNumber) ||
            (x.id != null && updated.id != null && String(x.id) === String(updated.id))
    );
    if (idx < 0) {
        if (!opts.addIfMissing) return null;
        list.push(updated);
        const added = list[list.length - 1];
        applyTicketStatusFromImporter(added);
        return added;
    }
    list[idx] = mergeTicketFromServerPatch(list[idx], updated);
    applyTicketStatusFromImporter(list[idx]);
    return list[idx];
}

function upsertRefreshedTicketIntoLocalCollections(updated, upsertOpts) {
    // Viewport polygon backfill emits geometry-only stubs (polygonOnly:true) carrying a
    // polygon/bbox/pin but NO lifecycle or expiration fields. Those must only enrich rows that
    // already exist — never be added to ORG_TICKETS. Otherwise an expired ticket that lives only
    // in the hub collections gets injected into the active list as a fieldless stub, which then
    // resolves to NOT_READY (inflating the Not Ready stat) until the popup hydrates it.
    const opts = upsertOpts || {};
    const isPolygonOnlyStub = !!(updated && updated.polygonOnly === true);
    let addToOrgIfMissing = !isPolygonOnlyStub;
    if (opts.addToOrgIfMissing != null) {
        addToOrgIfMissing = !!opts.addToOrgIfMissing && !isPolygonOnlyStub;
    } else if (!isPolygonOnlyStub && ticketShouldSkipActiveOrgInsert(updated)) {
        addToOrgIfMissing = false;
    }
    const primary = upsertRefreshedTicketIntoList(window.ORG_TICKETS || [], updated, {
        addIfMissing: addToOrgIfMissing,
    });
    upsertRefreshedTicketIntoList(window.HUB_ACTIVE_TICKETS || [], updated);
    upsertRefreshedTicketIntoList(window.HUB_COMBINED_TICKETS || [], updated);
    upsertRefreshedTicketIntoList(window.HUB_EXPIRED_TICKETS || [], updated);
    // Expired/project opens live in this session pool; refresh must update it or
    // findLiveTicketInLocalCollections / findTicketForHub keep returning a stale empty copy.
    upsertRefreshedTicketIntoList(window.HUB_RECENTLY_OPENED_TICKETS || [], updated, {
        addIfMissing: false,
    });
    return primary || findTicketInRecentlyOpened(updated.id, updated.ticketNumber) || updated;
}

/** Resolve the freshest in-memory copy of a ticket across hub slices and ORG_TICKETS. */
function findLiveTicketInLocalCollections(ticket) {
    if (!ticket) return null;
    const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    const pools = [
        window.HUB_RECENTLY_OPENED_TICKETS,
        window.HUB_EXPIRED_TICKETS,
        window.HUB_COMBINED_TICKETS,
        window.HUB_ACTIVE_TICKETS,
        window.ORG_TICKETS,
    ];
    for (let i = 0; i < pools.length; i++) {
        const list = pools[i];
        if (!Array.isArray(list)) continue;
        const found = list.find(
            (x) =>
                (tn && String(x.ticketNumber).trim() === tn) ||
                (x.id != null && ticket.id != null && String(x.id) === String(ticket.id))
        );
        if (found) return found;
    }
    return null;
}

const TICKET_SUMMARY_RETAINED_DETAIL_KEYS = [
    'operatorResponses',
    'stationCodes',
    'stationDetails',
    'history',
    'ngenResponseHistory',
    'providerResponseHistory',
    'polygon',
    'ngenFullDetailRefreshedAt',
    'ticketPhotoStats',
    'hasFullDetail',
    'jobName',
    'ngenUserReference',
    'providerUserReference',
];
function normalizeTicketNumberBaseForMerge(ticketNumber) {
    const tn = ticketNumber != null ? String(ticketNumber).trim() : '';
    if (!tn) return '';
    const mod = window.ticketImporterModule;
    if (mod && typeof mod.normalizeTicketBase === 'function') {
        return String(mod.normalizeTicketBase(tn) || tn.split('-')[0]).trim();
    }
    return tn.split('-')[0];
}

function ticketCacheKeyCandidates(ticket) {
    const keys = [];
    if (!ticket) return keys;
    if (ticket.id != null) keys.push(`id:${String(ticket.id)}`);
    if (ticket.ticketNumber != null) keys.push(`tn:${String(ticket.ticketNumber).trim()}`);
    const base = normalizeTicketNumberBaseForMerge(ticket.ticketNumber);
    if (base) keys.push(`base:${base}`);
    return keys;
}

function indexTicketsForSummaryMerge(tickets) {
    const map = new Map();
    (tickets || []).forEach((ticket) => {
        ticketCacheKeyCandidates(ticket).forEach((key) => {
            if (key && !map.has(key)) map.set(key, ticket);
        });
    });
    return map;
}

function findCachedTicketForSummary(summary, cacheMap) {
    for (const key of ticketCacheKeyCandidates(summary)) {
        if (cacheMap.has(key)) return cacheMap.get(key);
    }
    return null;
}

function hasHydratedTicketDetail(ticket) {
    if (!ticket || typeof ticket !== 'object') return false;
    if (Array.isArray(ticket.operatorResponses) && ticket.operatorResponses.length > 0) return true;
    if (Array.isArray(ticket.history) && ticket.history.length > 0) return true;
    if (ticketHasDisplayablePolygon(ticket) && ticket.listSummary !== true) return true;
    return false;
}

function summaryCountsDriftFromCachedRows(prev, summary) {
    if (!prev || !summary || !Array.isArray(prev.operatorResponses) || prev.operatorResponses.length === 0) return false;
    const received = normalizeTicketResponseCount(summary.ngenReceivedResponseCount);
    const required = normalizeTicketResponseCount(summary.ngenRequiredResponseCount);
    if (received != null && received !== prev.operatorResponses.length) return true;
    if (required != null && Array.isArray(prev.stationCodes) && prev.stationCodes.length > 0 && required !== prev.stationCodes.length) {
        return true;
    }
    const prevReceived = normalizeTicketResponseCount(prev.ngenReceivedResponseCount);
    const prevRequired = normalizeTicketResponseCount(prev.ngenRequiredResponseCount);
    if (received != null && prevReceived != null && received !== prevReceived) return true;
    if (required != null && prevRequired != null && required !== prevRequired) return true;
    return false;
}

function clearStaleStructuredTicketRows(ticket) {
    if (!ticket || typeof ticket !== 'object') return;
    delete ticket.operatorResponses;
    delete ticket.stationCodes;
    delete ticket.stationDetails;
    delete ticket.history;
    delete ticket.ngenResponseHistory;
    delete ticket.providerResponseHistory;
}

function mergeSummaryIntoCachedTicket(prev, summary) {
    if (!prev || !summary) return summary || prev;
    const prevHasDetail = hasHydratedTicketDetail(prev);
    const merged = prevHasDetail ? { ...prev, ...summary } : { ...summary };
    TICKET_SUMMARY_RETAINED_DETAIL_KEYS.forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(summary, key) && Object.prototype.hasOwnProperty.call(prev, key)) {
            merged[key] = prev[key];
        }
    });
    if (summaryCountsDriftFromCachedRows(prev, summary)) {
        /* Drop stale structured rows when nGen/POSR counts moved but the summary payload did not
         * include a fresh operatorResponses array (thin/incremental summary). When the server sent
         * full rows, never delete them — clearing here would wipe the new data we just spread onto
         * merged (e.g. after PUT override + list reload). Slim list rows never ship operatorResponses
         * (stripSlimSummaryTicketForClient), so skip clearing when listSummary is intentional. */
        const summaryHasOperatorRows =
            Array.isArray(summary.operatorResponses) && summary.operatorResponses.length > 0;
        const summaryIsSlimListRow = summary.listSummary === true;
        if (!summaryHasOperatorRows && !summaryIsSlimListRow) {
            clearStaleStructuredTicketRows(merged);
        }
    }
    if (hasHydratedTicketDetail(merged)) {
        merged.listSummary = false;
        merged.hasFullDetail = true;
        if (prevHasDetail) {
            delete merged.ngenSearchStub;
        }
    }
    // Expired-list membership / stamped EXPIRED must win over a hydrated prev that still looks NOT_READY.
    const summaryExpired =
        summary.listScope === 'expired' ||
        summary.hubListScope === 'expired' ||
        String(summary.computedWorkflowStatus || '').toUpperCase() === 'EXPIRED' ||
        String(summary.status || '').toUpperCase() === 'EXPIRED';
    if (summaryExpired) {
        merged.listScope = 'expired';
        merged.computedWorkflowStatus = 'EXPIRED';
        merged.status = 'EXPIRED';
        merged.workflowStatus = 'EXPIRED';
    }
    return merged;
}

function getFirstPolygonRingFirstLatLng(geometry) {
    if (!geometry || !geometry.coordinates) return null;
    let ring;
    if (geometry.type === 'Polygon' && geometry.coordinates[0]) {
        ring = geometry.coordinates[0];
    } else if (geometry.type === 'MultiPolygon' && geometry.coordinates[0] && geometry.coordinates[0][0]) {
        ring = geometry.coordinates[0][0];
    } else {
        return null;
    }
    if (!ring || ring.length === 0) return null;
    const pt = ring[0];
    if (!pt || pt.length < 2) return null;
    return L.latLng(pt[1], pt[0]);
}

function normalizeTicketResponseCount(value) {
    if (value == null || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, n) : null;
}

function getTicketResponseProgress(ticket) {
    const operatorRows = Array.isArray(ticket && ticket.operatorResponses) ? ticket.operatorResponses.length : 0;
    const outstandingRows = Array.isArray(ticket && ticket.outstandingOperators) ? ticket.outstandingOperators.length : 0;
    if (!ticket || typeof ticket !== 'object') {
        return {
            source: 'operatorRows',
            required: 0,
            received: 0,
            outstanding: 0,
            complete: true,
            label: '0',
        };
    }

    const required = normalizeTicketResponseCount(ticket.ngenRequiredResponseCount);
    const received = normalizeTicketResponseCount(ticket.ngenReceivedResponseCount);
    if (required != null || received != null) {
        const displayReceived = received != null ? received : 0;
        const outstanding = required != null && received != null ? Math.max(0, required - received) : null;
        return {
            source: 'ngen',
            required,
            received: displayReceived,
            outstanding,
            complete: required != null && received != null ? displayReceived >= required : null,
            label: required != null ? `${displayReceived}/${required}` : String(displayReceived),
        };
    }

    return {
        source: 'operatorRows',
        required: operatorRows,
        received: operatorRows,
        outstanding: outstandingRows,
        complete: outstandingRows === 0,
        label: String(operatorRows),
    };
}

/**
 * Single source of truth: recompute ticket.status and outstandingOperators from importer rules
 * (expiration, operator responses, photos). Not stored in the DB — derived on load and whenever
 * the UI refreshes (e.g. renderTickets after loadTicketsForCurrentOrg).
 */
/** Recompute workflow status on every in-memory ticket pool (after summary load). */
function reapplyTicketStatusesForLoadedCollections() {
    const seen = new Set();
    const pools = [
        window.ORG_TICKETS,
        window.HUB_ACTIVE_TICKETS,
        window.HUB_COMBINED_TICKETS,
        window.HUB_EXPIRED_TICKETS,
    ];
    pools.forEach((list) => {
        (list || []).forEach((ticket) => {
            if (!ticket || ticket.id == null) return;
            const key = String(ticket.id);
            if (seen.has(key)) return;
            seen.add(key);
            applyTicketStatusFromImporter(ticket);
        });
    });
}

function applyTicketStatusFromImporter(ticket) {
    if (!ticket) return;
    const mod = window.ticketImporterModule;
    if (mod && typeof mod.resolveTicketLifecycleStatus === 'function') {
        const lifecycle = mod.resolveTicketLifecycleStatus(ticket);
        if (lifecycle) {
            ticket.status = lifecycle;
            ticket.workflowStatus = lifecycle;
            ticket.computedWorkflowStatus = lifecycle;
            return;
        }
    }
    if (ticket.computedWorkflowStatus) {
        ticket.status = ticket.computedWorkflowStatus;
        ticket.workflowStatus = ticket.computedWorkflowStatus;
        return;
    }
    if (mod && mod.calculateTicketStatus) {
        const expirationDate =
            typeof mod.getTicketExpirationDateForStatus === 'function'
                ? mod.getTicketExpirationDateForStatus(ticket)
                : ticket.endTime;
        ticket.status = mod.calculateTicketStatus(
            ticket.operatorResponses || [],
            ticket.ticketNumber,
            expirationDate,
            ticket.polygon,
            ticket.stationCodes || [],
            ticket
        );
    }
}

/**
 * After hub expired/combined loads: stamp matching ORG_TICKETS rows as EXPIRED so the
 * Not Ready / Active stat cards (which count ORG_TICKETS only) drop them without opening a popup.
 * @param {object[]} expiredTickets
 */
function syncExpiredLifecycleIntoOrgTickets(expiredTickets) {
    const source = Array.isArray(expiredTickets) ? expiredTickets : [];
    if (source.length === 0 || !Array.isArray(window.ORG_TICKETS) || window.ORG_TICKETS.length === 0) {
        return;
    }
    const byId = new Map();
    const byTn = new Map();
    source.forEach((t) => {
        if (!t || typeof t !== 'object') return;
        if (t.id != null) byId.set(String(t.id), t);
        const tn = t.ticketNumber != null ? String(t.ticketNumber).trim() : '';
        if (tn) byTn.set(tn, t);
    });
    if (byId.size === 0 && byTn.size === 0) return;
    window.ORG_TICKETS.forEach((orgT) => {
        if (!orgT) return;
        const match =
            (orgT.id != null && byId.get(String(orgT.id))) ||
            (orgT.ticketNumber != null && byTn.get(String(orgT.ticketNumber).trim())) ||
            null;
        if (!match) return;
        if (match.ticketExpirationDate != null && match.ticketExpirationDate !== '') {
            orgT.ticketExpirationDate = match.ticketExpirationDate;
        }
        if (match.endTime != null && match.endTime !== '' && orgT.endTime == null) {
            orgT.endTime = match.endTime;
        }
        if (match.workExpirationDate != null && match.workExpirationDate !== '') {
            orgT.workExpirationDate = match.workExpirationDate;
        }
        orgT.listScope = 'expired';
        orgT.status = 'EXPIRED';
        orgT.workflowStatus = 'EXPIRED';
        orgT.computedWorkflowStatus = 'EXPIRED';
    });
}

/** Work end for UI — same fields as status (endTime or API work expiration). */
function getTicketExpirationForDisplay(ticket) {
    if (!ticket) return null;
    if (window.ticketImporterModule && typeof window.ticketImporterModule.getTicketExpirationDateForStatus === 'function') {
        return window.ticketImporterModule.getTicketExpirationDateForStatus(ticket);
    }
    return ticket.endTime;
}

function ticketDateMsForSort(value) {
    if (value == null || value === '') return null;
    const d = new Date(value);
    const t = d.getTime();
    return Number.isFinite(t) ? t : null;
}

function getTicketExpirationMsForSort(ticket) {
    if (!ticket) return null;
    const end = getTicketExpirationForDisplay(ticket);
    const raw = end != null && end !== '' ? end : ticket.endTime;
    return ticketDateMsForSort(raw);
}

function getTicketStartMsForSort(ticket) {
    if (!ticket) return null;
    return ticketDateMsForSort(ticket.startTime);
}

/**
 * Comparator for sidebar + Ticket Hub ticket lists.
 * @param {object} a
 * @param {object} b
 * @param {string} sortMode normalized mode from {@link normalizeTicketListSort}
 * @param {(tn: string) => string} [normalizeBaseFn] ticket # base for tie-break
 */
function compareTicketsForListSort(a, b, sortMode, normalizeBaseFn) {
    const mode = normalizeTicketListSort(sortMode);
    const nb =
        normalizeBaseFn ||
        function (tn) {
            return String(tn || '').split('-')[0];
        };
    const tieBreak = () =>
        String(nb(a.ticketNumber || '')).localeCompare(String(nb(b.ticketNumber || '')));

    if (mode === 'status') {
        const STATUS_PRIORITY_LIST = {
            EXPIRING_SOON: 0,
            NOT_READY: 1,
            ACTION_REQUIRED: 2,
            READY: 3,
            EXPIRED: 4,
            CANCELLED: 4
        };
        const pa =
            STATUS_PRIORITY_LIST[a.status] !== undefined ? STATUS_PRIORITY_LIST[a.status] : 999;
        const pb =
            STATUS_PRIORITY_LIST[b.status] !== undefined ? STATUS_PRIORITY_LIST[b.status] : 999;
        if (pa !== pb) return pa - pb;
        return tieBreak();
    }

    const INF = Number.MAX_SAFE_INTEGER;
    const NINF = Number.MIN_SAFE_INTEGER;

    if (mode === 'expiring_soonest') {
        const ma = getTicketExpirationMsForSort(a);
        const mb = getTicketExpirationMsForSort(b);
        const va = ma == null ? INF : ma;
        const vb = mb == null ? INF : mb;
        if (va !== vb) return va - vb;
        return tieBreak();
    }
    if (mode === 'expiring_latest') {
        const ma = getTicketExpirationMsForSort(a);
        const mb = getTicketExpirationMsForSort(b);
        const va = ma == null ? NINF : ma;
        const vb = mb == null ? NINF : mb;
        if (va !== vb) return vb - va;
        return tieBreak();
    }
    if (mode === 'starting_soonest') {
        const ma = getTicketStartMsForSort(a);
        const mb = getTicketStartMsForSort(b);
        const va = ma == null ? INF : ma;
        const vb = mb == null ? INF : mb;
        if (va !== vb) return va - vb;
        return tieBreak();
    }
    if (mode === 'starting_latest') {
        const ma = getTicketStartMsForSort(a);
        const mb = getTicketStartMsForSort(b);
        const va = ma == null ? NINF : ma;
        const vb = mb == null ? NINF : mb;
        if (va !== vb) return vb - va;
        return tieBreak();
    }

    return tieBreak();
}

/**
 * User-visible label for workflow status codes (underscores ? spaces; ACTION_REQUIRED ? REVIEW REQUIRED).
 * @param {string} [status]
 * @returns {string}
 */
function formatWorkflowStatusDisplay(status) {
    if (status === 'ACTION_REQUIRED') return 'REVIEW REQUIRED';
    return String(status || '').replace(/_/g, ' ');
}
window.formatWorkflowStatusDisplay = formatWorkflowStatusDisplay;

/**
 * Workflow status for map colors and popups — matches hub table ({@link getHubEffectiveStatus}).
 * Prefers lifecycle (EXPIRED/CANCELLED) and server `computedWorkflowStatus` over a stale
 * client `status` left on summary rows until full detail is opened.
 * @param {object} [ticket]
 * @returns {string}
 */
function getTicketWorkflowStatusForMap(ticket) {
    if (!ticket || typeof ticket !== 'object') return '';
    const mod = window.ticketImporterModule;
    if (mod && typeof mod.resolveTicketLifecycleStatus === 'function') {
        const lifecycle = mod.resolveTicketLifecycleStatus(ticket);
        if (lifecycle) {
            ticket.status = lifecycle;
            ticket.workflowStatus = lifecycle;
            ticket.computedWorkflowStatus = lifecycle;
            return lifecycle;
        }
    }
    const raw =
        ticket.computedWorkflowStatus ||
        ticket.status ||
        ticket.workflowStatus ||
        ticket.workflow_status ||
        '';
    const s = String(raw || '').trim();
    if (!s) return '';
    if (s === 'REVIEW REQUIRED' || s.toUpperCase() === 'REVIEW REQUIRED') return 'ACTION_REQUIRED';
    const normalized = s.toUpperCase().replace(/\s+/g, '_');
    if (ticket.listSummary === true && ticket.computedWorkflowStatus && ticket.status !== normalized) {
        ticket.status = normalized;
        ticket.workflowStatus = normalized;
    }
    return normalized;
}

/** Map marker / polygon fill color for a workflow status code. */
function workflowStatusToMapColor(status) {
    if (window.mapIcons && typeof window.mapIcons.ticketMapPinColor === 'function') {
        return window.mapIcons.ticketMapPinColor(status);
    }
    switch (status) {
        case 'READY':
            return 'var(--app-success)';
        case 'NOT_READY':
            return 'var(--app-danger)';
        case 'ACTION_REQUIRED':
            return '#facc15';
        case 'EXPIRING_SOON':
            return '#f59e0b';
        case 'EXPIRED':
        case 'CANCELLED':
            return '#6b7280';
        default:
            return '#888888';
    }
}
window.workflowStatusToMapColor = workflowStatusToMapColor;

/** Map marker / polygon fill — matches ticket map pin colors. */
function ticketStatusToMapColor(ticket) {
    return workflowStatusToMapColor(getTicketWorkflowStatusForMap(ticket));
}

/** Same polygon presence check as map rendering (GeoJSON-ish or coordinates array). */
function ticketHasDisplayablePolygon(ticket) {
    const p = ticket && ticket.polygon;
    return !!(
        p &&
        typeof p === 'object' &&
        (p.type === 'Polygon' ||
            p.type === 'MultiPolygon' ||
            p.type === 'Feature' ||
            p.type === 'FeatureCollection' ||
            (Array.isArray(p.coordinates) && p.coordinates.length > 0))
    );
}

/**
 * Stub/map pin position used when there is no polygon (same as renderTickets marker source).
 * Falls back to bbox center when stubMapPin was never stored (lean list synthesis).
 * @returns {L.LatLng|null}
 */
function ticketMapAnchorLatLng(ticket) {
    if (!ticket) return null;
    if (ticket.stubMapPin && Number.isFinite(Number(ticket.stubMapPin.lat)) && Number.isFinite(Number(ticket.stubMapPin.lng))) {
        return L.latLng(Number(ticket.stubMapPin.lat), Number(ticket.stubMapPin.lng));
    }
    if (ticketHasDisplayablePolygon(ticket)) {
        return getFirstPolygonRingFirstLatLng(ticket.polygon);
    }
    const box = ticket.bbox && typeof ticket.bbox === 'object' ? ticket.bbox : null;
    if (box) {
        const minLat = Number(box.minLat);
        const maxLat = Number(box.maxLat);
        const minLng = Number(box.minLng);
        const maxLng = Number(box.maxLng);
        if (
            Number.isFinite(minLat) &&
            Number.isFinite(maxLat) &&
            Number.isFinite(minLng) &&
            Number.isFinite(maxLng)
        ) {
            return L.latLng((minLat + maxLat) / 2, (minLng + maxLng) / 2);
        }
    }
    return null;
}

/**
 * Tickets currently eligible for map layers (hub filters when Ticket hub is accessible, else sidebar filters; dedupe; time warp).
 * Matches the list `renderTickets` iterates (before per-ticket geometry).
 * @returns {object[]}
 */
function ensureTicketStatusForMap(ticket) {
    if (!ticket) return;
    if (typeof applyTicketStatusFromImporter === 'function') {
        applyTicketStatusFromImporter(ticket);
    }
}

function getMapTicketsForMapLayers() {
    // Public catalog area search stores tickets in PUBLIC_MAP_TICKETS, not ORG_TICKETS.
    // Hub filtering must not run first or map layers stay empty after a public search.
    if (typeof window.isCurrentOrgPublicCatalogViewer === 'function' && window.isCurrentOrgPublicCatalogViewer()) {
        const publicTickets = window.PUBLIC_MAP_TICKETS || [];
        publicTickets.forEach((ticket) => ensureTicketStatusForMap(ticket));
        return publicTickets.filter((ticket) => ticketPassesTimeWarp(ticket));
    }

    const hubAccessible =
        typeof window.ticketHubModule !== 'undefined' &&
        window.ticketHubModule &&
        typeof window.ticketHubModule.canAccessTicketHub === 'function' &&
        window.ticketHubModule.canAccessTicketHub();
    if (hubAccessible && typeof window.getFilteredTicketsForHub === 'function') {
        try {
            const hubList = window.getFilteredTicketsForHub();
            if (Array.isArray(hubList)) {
                hubList.forEach((ticket) => ensureTicketStatusForMap(ticket));
                return hubList.filter((ticket) => ticketPassesTimeWarp(ticket));
            }
        } catch (e) {
            console.warn('[tickets] hub map ticket filter', e);
            return [];
        }
    }

    const allTickets = window.ORG_TICKETS || [];
    allTickets.forEach((ticket) => ensureTicketStatusForMap(ticket));

    const filteredTickets = allTickets.filter(
        (ticket) =>
            matchesSidebarTicketListStatusFilter(ticket, ticketListStatusFilter) &&
            matchesSidebarTicketListSearch(ticket, ticketListSearch) &&
            isTicketVisibleToTechClient(ticket)
    );

    const mapMod = window.ticketImporterModule;
    const mapTickets =
        mapMod && typeof mapMod.dedupeTicketsByBase === 'function'
            ? mapMod.dedupeTicketsByBase(filteredTickets)
            : filteredTickets;

    return mapTickets.filter((ticket) => ticketPassesTimeWarp(ticket));
}

/** @type {Set<string>|null} */
let techVisibleTicketNumbers = null;
/** @type {Promise<Set<string>>|null} */
let techVisibleTicketNumbersPromise = null;
let techVisibleTicketNumbersOrgId = null;

function isTechTicketViewer() {
    return !!(
        window.authModule &&
        typeof window.authModule.isTechInCurrentOrg === 'function' &&
        window.authModule.isTechInCurrentOrg()
    );
}

function clearTechVisibleTicketNumbersCache() {
    techVisibleTicketNumbers = null;
    techVisibleTicketNumbersPromise = null;
    techVisibleTicketNumbersOrgId = null;
}

function mergeTechVisibleTicketsFromProjectDetail(detail) {
    if (!isTechTicketViewer() || !detail || !Array.isArray(detail.tickets)) return;
    if (!(techVisibleTicketNumbers instanceof Set)) techVisibleTicketNumbers = new Set();
    detail.tickets.forEach((t) => {
        const tn = t && t.ticketNumber != null ? String(t.ticketNumber).trim() : '';
        if (!tn) return;
        techVisibleTicketNumbers.add(tn);
        const base = tn.split('-')[0];
        if (base) techVisibleTicketNumbers.add(base);
    });
}

window.mergeTechVisibleTicketsFromProjectDetail = mergeTechVisibleTicketsFromProjectDetail;

/**
 * Tech UI visibility: org-owned, non-expired, in an open assigned project.
 * Non-tech always returns true.
 * @param {object} ticket
 * @returns {boolean}
 */
function isTicketVisibleToTechClient(ticket) {
    if (!isTechTicketViewer()) return true;
    if (!ticket || ticket.shared) return false;
    if (typeof ensureTicketStatusForMap === 'function') {
        ensureTicketStatusForMap(ticket);
    }
    const status = getTicketWorkflowStatusForMap(ticket);
    if (status === 'EXPIRED' || status === 'CANCELLED') return false;
    if (typeof isInactiveWorkflowStatus === 'function' && isInactiveWorkflowStatus(status)) return false;
    const exp =
        ticket.expiresAt ||
        ticket.ticketExpirationDate ||
        ticket.ticket_expires_at ||
        ticket.endTime ||
        null;
    if (exp) {
        const parsed = new Date(exp);
        if (!Number.isNaN(parsed.getTime()) && parsed.getTime() < Date.now()) return false;
    }
    if (!(techVisibleTicketNumbers instanceof Set)) return false;
    const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    if (!tn) return false;
    if (techVisibleTicketNumbers.has(tn)) return true;
    const base = tn.split('-')[0];
    return !!(base && techVisibleTicketNumbers.has(base));
}

function techVisibilityApiBase() {
    let orgId = null;
    if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
        orgId = window.orgSelectorModule.getCurrentOrgId();
    } else if (window.authModule && window.authModule.getCurrentUser) {
        const u = window.authModule.getCurrentUser();
        orgId = u && u.organizationId;
    }
    const base = window.authModule && window.authModule.API_BASE ? window.authModule.API_BASE : '';
    const q = orgId != null ? `?organizationId=${encodeURIComponent(String(orgId))}` : '';
    return { base, q, orgId };
}

/**
 * Build Set of ticket numbers visible to the current tech from assigned open projects.
 * @returns {Promise<Set<string>>}
 */
async function refreshTechVisibleTicketNumbers() {
    if (!isTechTicketViewer()) {
        clearTechVisibleTicketNumbersCache();
        return new Set();
    }
    const api = techVisibilityApiBase();
    if (!api.orgId || !window.authModule || !window.authModule.apiRequest) {
        techVisibleTicketNumbers = new Set();
        return techVisibleTicketNumbers;
    }
    if (
        techVisibleTicketNumbersPromise &&
        techVisibleTicketNumbersOrgId != null &&
        String(techVisibleTicketNumbersOrgId) === String(api.orgId)
    ) {
        return techVisibleTicketNumbersPromise;
    }
    techVisibleTicketNumbersOrgId = api.orgId;
    techVisibleTicketNumbersPromise = (async () => {
        const visible = new Set();
        try {
            const listData = await window.authModule.apiRequest(
                `${api.base}/tickets/job-projects${api.q}${api.q ? '&' : '?'}status=open`
            );
            const projects = Array.isArray(listData && listData.projects) ? listData.projects : [];
            const details = await Promise.all(
                projects.map(async (p) => {
                    const key = p && p.jobNameKey != null ? String(p.jobNameKey).trim() : '';
                    if (!key) return null;
                    try {
                        return await window.authModule.apiRequest(
                            `${api.base}/tickets/job-projects/${encodeURIComponent(key)}${api.q}`
                        );
                    } catch (_e) {
                        return null;
                    }
                })
            );
            details.forEach((detail) => {
                if (!detail || !Array.isArray(detail.tickets)) return;
                detail.tickets.forEach((t) => {
                    const tn = t && t.ticketNumber != null ? String(t.ticketNumber).trim() : '';
                    if (!tn) return;
                    visible.add(tn);
                    const base = tn.split('-')[0];
                    if (base) visible.add(base);
                });
            });
        } catch (e) {
            console.warn('[tickets] tech project visibility refresh failed', e);
        }
        techVisibleTicketNumbers = visible;
        return visible;
    })();
    try {
        return await techVisibleTicketNumbersPromise;
    } finally {
        techVisibleTicketNumbersPromise = null;
    }
}

window.isTicketVisibleToTechClient = isTicketVisibleToTechClient;
window.refreshTechVisibleTicketNumbers = refreshTechVisibleTicketNumbers;
window.clearTechVisibleTicketNumbersCache = clearTechVisibleTicketNumbersCache;

function ticketIndexedLatLngBounds(ticket) {
    if (!ticket || typeof ticket !== 'object') return null;
    const box = ticket.bbox && typeof ticket.bbox === 'object' ? ticket.bbox : null;
    const minLat = box && box.minLat != null ? Number(box.minLat) : Number(ticket.min_lat);
    const maxLat = box && box.maxLat != null ? Number(box.maxLat) : Number(ticket.max_lat);
    const minLng = box && box.minLng != null ? Number(box.minLng) : Number(ticket.min_lng);
    const maxLng = box && box.maxLng != null ? Number(box.maxLng) : Number(ticket.max_lng);
    if (
        !Number.isFinite(minLat) ||
        !Number.isFinite(maxLat) ||
        !Number.isFinite(minLng) ||
        !Number.isFinite(maxLng)
    ) {
        return null;
    }
    try {
        const bounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
        return bounds && typeof bounds.isValid === 'function' && bounds.isValid() ? bounds : null;
    } catch (_) {
        return null;
    }
}

function ticketIntersectsMapBounds(ticket, bounds) {
    if (!ticket || !bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) return false;
    if (ticketHasDisplayablePolygon(ticket)) {
        try {
            const layer = L.geoJSON(ticket.polygon);
            const b = layer.getBounds();
            return !!(b && typeof b.isValid === 'function' && b.isValid() && bounds.intersects(b));
        } catch (_) {
            /* fall through to indexed bbox / marker anchor */
        }
    }
    const indexedBounds = ticketIndexedLatLngBounds(ticket);
    if (indexedBounds && bounds.intersects(indexedBounds)) return true;
    const ll = ticketMapAnchorLatLng(ticket);
    return !!(ll && bounds.contains(ll));
}

function padLatLngBoundsByFeet(bounds, feet) {
    if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) return bounds;
    const meters = feet * 0.3048;
    const center = bounds.getCenter();
    const latPad = meters / 111320;
    const cosLat = Math.cos((center.lat * Math.PI) / 180);
    const lngPad = meters / (111320 * Math.max(Math.abs(cosLat), 0.01));
    return L.latLngBounds(
        [bounds.getSouth() - latPad, bounds.getWest() - lngPad],
        [bounds.getNorth() + latPad, bounds.getEast() + lngPad]
    );
}

function getPolygonBackfillBounds(baseBounds) {
    return padLatLngBoundsByFeet(baseBounds, TICKET_POLYGON_BACKFILL_BUFFER_FT);
}

/** Center for hub-focus neighborhood prefetch (polygon → bbox → pin). */
function getTicketFocusCenterLatLng(ticket) {
    if (!ticket) return null;
    if (ticketHasDisplayablePolygon(ticket)) {
        try {
            const layer = L.geoJSON(ticket.polygon);
            const b = layer.getBounds();
            if (b && typeof b.isValid === 'function' && b.isValid()) return b.getCenter();
        } catch (_e) {
            /* fall through */
        }
    }
    const indexed = ticketIndexedLatLngBounds(ticket);
    if (indexed) return indexed.getCenter();
    return ticketMapAnchorLatLng(ticket);
}

/**
 * Lat/lng bounds for the map container at a fixed zoom centered on a point (without moving the map).
 * @param {L.Map} map
 * @param {L.LatLng} centerLatLng
 * @param {number} zoom
 * @param {{ sidePad?: number, topPad?: number }} [options]
 */
function getMapLatLngBoundsAtZoom(map, centerLatLng, zoom, options) {
    if (!map || !centerLatLng) return null;
    const size = map.getSize();
    if (!size || size.x <= 0 || size.y <= 0) return null;
    const padOpts = getTicketOpenMapPadding(map, options || {});
    const w = Math.max(1, size.x - padOpts.paddingTopLeft.x - padOpts.paddingBottomRight.x);
    const h = Math.max(1, size.y - padOpts.paddingTopLeft.y - padOpts.paddingBottomRight.y);
    const cp = map.project(centerLatLng, zoom);
    const cx = cp.x + (padOpts.paddingTopLeft.x - padOpts.paddingBottomRight.x) / 2;
    const cy = cp.y + (padOpts.paddingTopLeft.y - padOpts.paddingBottomRight.y) / 2;
    const centerPt = L.point(cx, cy);
    const half = L.point(w / 2, h / 2);
    try {
        const bounds = L.latLngBounds(
            map.unproject(centerPt.clone().subtract(half), zoom),
            map.unproject(centerPt.clone().add(half), zoom)
        );
        return bounds && typeof bounds.isValid === 'function' && bounds.isValid() ? bounds : null;
    } catch (_e) {
        return null;
    }
}

/**
 * @param {L.LatLngBounds} bounds already padded if desired
 * @param {{ allowRetry?: boolean, alwaysIncludeTicket?: object|null }} [opts]
 */
function buildPolygonBackfillQueueFromBounds(bounds, opts) {
    const options = opts || {};
    if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) return [];

    const seen = new Set();
    const queue = [];

    function tryAdd(ticket, forceInclude) {
        if (!ticket) return;
        const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
        if (!tn || seen.has(tn)) return;
        if (ticketHasDisplayablePolygon(ticket)) return;
        if (!forceInclude && !ticketIntersectsMapBounds(ticket, bounds)) return;
        if (viewportPolygonBackfillBusyTickets.has(tn)) return;
        if (!options.allowRetry && viewportPolygonBackfillAttemptedTickets.has(tn)) return;
        const live = findLiveTicketInLocalCollections(ticket);
        if (live && ticketHasDisplayablePolygon(live)) return;
        seen.add(tn);
        queue.push({ ticket, live, ticketNumber: tn });
    }

    getMapTicketsForMapLayers().forEach((t) => tryAdd(t));
    if (options.alwaysIncludeTicket) tryAdd(options.alwaysIncludeTicket, true);

    return queue;
}

function hasTicketInCurrentMapView() {
    const map = window.map;
    if (!map || typeof map.getBounds !== 'function') return false;
    const bounds = map.getBounds();
    if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) return false;
    return getMapTicketsForMapLayers().some((ticket) => ticketIntersectsMapBounds(ticket, bounds));
}

let viewportPolygonBackfillTimer = null;
let viewportPolygonBackfillRunning = false;
/** In-flight / recently done ticket numbers to avoid duplicate refresh calls. */
const viewportPolygonBackfillBusyTickets = new Set();
const viewportPolygonBackfillLoadingTickets = new Set();
const viewportPolygonBackfillAttemptedTickets = new Set();
const VIEWPORT_POLYGON_BACKFILL_DEBOUNCE_MS = 450;
const VIEWPORT_POLYGON_BACKFILL_CONCURRENCY = 6;

function ticketPolygonBackfillLoading(ticket) {
    const tn = ticket && ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    return !!(tn && viewportPolygonBackfillLoadingTickets.has(tn));
}

/** True while an in-view ticket still lacks polygon and backfill has not finished or timed out. */
function ticketPolygonBackfillUnsettled(ticket) {
    if (ticketHasDisplayablePolygon(ticket)) return false;
    const tn = ticket && ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    if (!tn) return true;
    if (viewportPolygonBackfillLoadingTickets.has(tn)) return true;
    if (viewportPolygonBackfillBusyTickets.has(tn)) return true;
    if (!viewportPolygonBackfillAttemptedTickets.has(tn)) return true;
    return false;
}

function ticketSelectionRefreshLoading(ticket) {
    const tn = ticket && ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    return !!(tn && selectedTicketRefreshLoadingTickets.has(tn));
}

function setSelectedTicketRefreshLoading(ticketNumber, busy) {
    const tn = ticketNumber != null ? String(ticketNumber).trim() : '';
    if (!tn) return;
    if (busy) selectedTicketRefreshLoadingTickets.add(tn);
    else selectedTicketRefreshLoadingTickets.delete(tn);
    if (
        isTicketDetailPopupOpen() &&
        window.ticketsModule &&
        typeof window.ticketsModule.syncTicketMapEntryRefreshLoading === 'function'
    ) {
        window.ticketsModule.syncTicketMapEntryRefreshLoading(tn);
    } else if (typeof renderTickets === 'function') {
        renderTickets();
    }
    if (typeof renderTicketList === 'function') {
        renderTicketList();
    }
    if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
        window.ticketHubModule.redrawIfOpen();
    }
    if (typeof window.syncTicketPopupRefreshLockForDisplayedTicket === 'function') {
        window.syncTicketPopupRefreshLockForDisplayedTicket();
    }
}

function scheduleViewportPolygonBackfillForVisibleTickets() {
    if (typeof window.isCurrentOrgPublicCatalogViewer === 'function' && window.isCurrentOrgPublicCatalogViewer()) {
        return;
    }
    const map = window.map;
    if (!map || map.getZoom() < TICKET_POLYGON_MIN_ZOOM) return;
    if (viewportPolygonBackfillTimer) clearTimeout(viewportPolygonBackfillTimer);
    viewportPolygonBackfillTimer = setTimeout(() => {
        viewportPolygonBackfillTimer = null;
        void runViewportPolygonBackfillForVisibleTickets();
    }, VIEWPORT_POLYGON_BACKFILL_DEBOUNCE_MS);
}

/**
 * Fetch polygons for a pre-built queue: IDB → POST /tickets/polygons → polygon-backfill.
 * Each polygon is merged and drawn on the map as soon as it is available (fade-in).
 * @param {Array<{ ticket: object, live?: object, ticketNumber: string }>} queue
 */
async function fetchTicketPolygonsForQueue(queue) {
    if (!queue || queue.length === 0) return;
    if (!window.authModule || !window.authModule.isAuthenticated()) return;
    if (typeof window.authModule.apiRequest !== 'function') return;

    const cacheOrgId = getTicketsRefreshOrgId();
    let appliedCount = 0;

    function clearPolygonBackfillLoading(ticketNumber) {
        const tn = ticketNumber != null ? String(ticketNumber).trim() : '';
        if (!tn) return;
        viewportPolygonBackfillLoadingTickets.delete(tn);
        viewportPolygonBackfillBusyTickets.delete(tn);
    }

    function applyPolygonBackfillResult(updated) {
        if (!updated) return false;
        const hydrated = upsertRefreshedTicketIntoLocalCollections(updated);
        const live =
            hydrated ||
            findLiveTicketInLocalCollections(updated) ||
            (updated.ticketNumber != null ? findLiveTicketInLocalCollections({ ticketNumber: updated.ticketNumber }) : null);
        const tn =
            updated.ticketNumber != null
                ? String(updated.ticketNumber).trim()
                : live && live.ticketNumber != null
                  ? String(live.ticketNumber).trim()
                  : '';
        clearPolygonBackfillLoading(tn);
        if (live && ticketHasDisplayablePolygon(live)) {
            if (
                window.ticketsModule &&
                typeof window.ticketsModule.applyTicketPolygonBackfillToMap === 'function'
            ) {
                window.ticketsModule.applyTicketPolygonBackfillToMap(live);
            } else if (typeof applyTicketPolygonBackfillToMap === 'function') {
                applyTicketPolygonBackfillToMap(live);
            }
            appliedCount += 1;
            return true;
        }
        return false;
    }

    const stillNeedServer = [];

    for (const item of queue) {
        const tn = item.ticketNumber;
        try {
            if (
                window.offlineTickets &&
                typeof window.offlineTickets.loadTicketPolygonFromIdb === 'function' &&
                cacheOrgId != null
            ) {
                const idbRow = await window.offlineTickets.loadTicketPolygonFromIdb(cacheOrgId, tn);
                if (idbRow && idbRow.polygon && ticketHasDisplayablePolygon({ polygon: idbRow.polygon })) {
                    applyPolygonBackfillResult({
                        ticketNumber: tn,
                        polygon: idbRow.polygon,
                        polygonOnly: true,
                        ...(idbRow.bbox ? { bbox: idbRow.bbox } : {}),
                    });
                    continue;
                }
            }
        } catch (idbErr) {
            console.warn('[tickets] IDB polygon', tn, idbErr.message || idbErr);
        }
        stillNeedServer.push(item);
    }

    const needsBackfill = [];
    if (stillNeedServer.length > 0) {
        const ticketForCtx = stillNeedServer[0].live || stillNeedServer[0].ticket;
        const refreshCtx =
            typeof window.getTicketRefreshRequestContext === 'function'
                ? window.getTicketRefreshRequestContext(ticketForCtx || stillNeedServer[0].ticketNumber)
                : {
                      organizationId: getTicketsRefreshOrgId(),
                      viewerOrganizationId: getTicketsRefreshOrgId(),
                  };
        const numbers = stillNeedServer.map((i) => i.ticketNumber);
        const BATCH = 100;
        for (let i = 0; i < numbers.length; i += BATCH) {
            const chunk = numbers.slice(i, i + BATCH);
            chunk.forEach((tn) => viewportPolygonBackfillBusyTickets.add(tn));
            try {
                const res = await window.authModule.apiRequest('tickets/polygons', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ticketNumbers: chunk,
                        ...(refreshCtx.organizationId != null
                            ? { organizationId: refreshCtx.organizationId }
                            : {}),
                        ...(refreshCtx.viewerOrganizationId != null
                            ? { viewerOrganizationId: refreshCtx.viewerOrganizationId }
                            : {}),
                    }),
                });
                const polys = res && Array.isArray(res.polygons) ? res.polygons : [];
                const returned = new Set();
                for (const p of polys) {
                    if (!p || !ticketHasDisplayablePolygon(p)) continue;
                    const ptn = p.ticketNumber != null ? String(p.ticketNumber).trim() : '';
                    if (ptn) returned.add(ptn);
                    applyPolygonBackfillResult({
                        ticketNumber: p.ticketNumber,
                        polygon: p.polygon,
                        polygonOnly: true,
                        ...(p.bbox ? { bbox: p.bbox } : {}),
                        ...(p.pin ? { stubMapPin: p.pin } : {}),
                    });
                    if (
                        window.offlineTickets &&
                        typeof window.offlineTickets.persistTicketPolygon === 'function' &&
                        cacheOrgId != null
                    ) {
                        void window.offlineTickets.persistTicketPolygon(
                            cacheOrgId,
                            p.ticketNumber,
                            p.polygon,
                            { bbox: p.bbox, pin: p.pin }
                        );
                    }
                }
                const nbRaw = res && Array.isArray(res.needsBackfill) ? res.needsBackfill : [];
                const nb = nbRaw.map((x) => String(x || '').trim()).filter(Boolean);
                needsBackfill.push(...nb);
                chunk.forEach((tn) => {
                    if (returned.has(tn) || nb.includes(tn)) return;
                    viewportPolygonBackfillAttemptedTickets.add(tn);
                    clearPolygonBackfillLoading(tn);
                });
            } catch (e) {
                chunk.forEach((tn) => {
                    viewportPolygonBackfillAttemptedTickets.add(tn);
                    clearPolygonBackfillLoading(tn);
                });
                console.warn('[tickets] batch polygons', e.message || e);
            } finally {
                chunk.forEach((tn) => {
                    viewportPolygonBackfillBusyTickets.delete(tn);
                });
            }
        }
    }

    const backfillQueue = needsBackfill
        .map((tn) => String(tn || '').trim())
        .filter(Boolean)
        .filter((tn) => !viewportPolygonBackfillAttemptedTickets.has(tn));

    if (backfillQueue.length > 0) {
        let nextIndex = 0;
        async function runNextPolygonBackfill() {
            const tn = backfillQueue[nextIndex++];
            if (!tn) return;
            const item =
                queue.find((q) => q.ticketNumber === tn) || { ticketNumber: tn, ticket: { ticketNumber: tn } };
            const live = item.live || findLiveTicketInLocalCollections({ ticketNumber: tn });
            const ticketForCtx = live || item.ticket;
            const refreshCtx =
                typeof window.getTicketRefreshRequestContext === 'function'
                    ? window.getTicketRefreshRequestContext(ticketForCtx || tn)
                    : {
                          organizationId: getTicketsRefreshOrgId(),
                          viewerOrganizationId: getTicketsRefreshOrgId(),
                      };
            viewportPolygonBackfillBusyTickets.add(tn);
            viewportPolygonBackfillLoadingTickets.add(tn);
            try {
                const body = {
                    ticketNumber: tn,
                    ...(refreshCtx.organizationId != null ? { organizationId: refreshCtx.organizationId } : {}),
                    ...(refreshCtx.viewerOrganizationId != null
                        ? { viewerOrganizationId: refreshCtx.viewerOrganizationId }
                        : {}),
                };
                const res = await window.authModule.apiRequest('tickets/polygon-backfill', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                const updated = res && res.ticket;
                if (updated) {
                    if (applyPolygonBackfillResult(updated)) {
                        if (
                            updated.polygon &&
                            window.offlineTickets &&
                            typeof window.offlineTickets.persistTicketPolygon === 'function' &&
                            cacheOrgId != null
                        ) {
                            void window.offlineTickets.persistTicketPolygon(
                                cacheOrgId,
                                updated.ticketNumber || tn,
                                updated.polygon,
                                { bbox: updated.bbox }
                            );
                        }
                    } else if (!ticketHasDisplayablePolygon(updated)) {
                        viewportPolygonBackfillAttemptedTickets.add(tn);
                        clearPolygonBackfillLoading(tn);
                    }
                } else {
                    viewportPolygonBackfillAttemptedTickets.add(tn);
                    clearPolygonBackfillLoading(tn);
                }
            } catch (e) {
                viewportPolygonBackfillAttemptedTickets.add(tn);
                clearPolygonBackfillLoading(tn);
                console.warn('[tickets] viewport polygon backfill', tn, e.message || e);
            } finally {
                viewportPolygonBackfillBusyTickets.delete(tn);
            }
        }
        const workerCount = Math.min(VIEWPORT_POLYGON_BACKFILL_CONCURRENCY, backfillQueue.length);
        await Promise.all(
            Array.from({ length: workerCount }, async () => {
                while (nextIndex < backfillQueue.length) {
                    await runNextPolygonBackfill();
                }
            })
        );
    }

    queue.forEach((item) => clearPolygonBackfillLoading(item.ticketNumber));

    if (appliedCount > 0) {
        if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
            window.ticketHubModule.redrawIfOpen();
        }
        if (
            window.photoMapLoaderModule &&
            typeof window.photoMapLoaderModule.scheduleFetchPhotoMapForViewport === 'function'
        ) {
            window.photoMapLoaderModule.scheduleFetchPhotoMapForViewport(true);
        }
        if (window.ticketsModule && typeof window.ticketsModule.refreshTicketsOrgCacheSnapshot === 'function') {
            window.ticketsModule.refreshTicketsOrgCacheSnapshot(cacheOrgId);
        }
    }
}

/** Hub focus: prefetch polygons for zoom-16 neighborhood (+ buffer) around the focused ticket. */
async function ensureFocusNeighborhoodPolygonsLoaded(focusTicket) {
    if (!focusTicket) return;
    if (typeof window.isCurrentOrgPublicCatalogViewer === 'function' && window.isCurrentOrgPublicCatalogViewer()) {
        return;
    }
    if (!window.authModule || !window.authModule.isAuthenticated()) return;
    if (typeof window.authModule.apiRequest !== 'function') return;

    const map = window.map;
    if (!map) return;

    const center = getTicketFocusCenterLatLng(focusTicket);
    if (!center) return;

    const baseBounds = getMapLatLngBoundsAtZoom(map, center, TICKET_POLYGON_MIN_ZOOM);
    if (!baseBounds) return;

    const bounds = getPolygonBackfillBounds(baseBounds);
    const queue = buildPolygonBackfillQueueFromBounds(bounds, {
        allowRetry: true,
        alwaysIncludeTicket: focusTicket,
    });
    if (queue.length === 0) return;

    queue.forEach((item) => viewportPolygonBackfillAttemptedTickets.delete(item.ticketNumber));
    queue.forEach((item) => viewportPolygonBackfillLoadingTickets.add(item.ticketNumber));
    renderTickets();

    await fetchTicketPolygonsForQueue(queue);
}

/**
 * At polygon zoom (≥16), load dig-site geometry for viewport tickets missing polygons:
 * memory → IDB → POST /tickets/polygons (server cache/D1) → polygon-backfill when needed.
 */
async function runViewportPolygonBackfillForVisibleTickets() {
    if (viewportPolygonBackfillRunning) return;
    if (!window.authModule || !window.authModule.isAuthenticated()) return;
    if (typeof window.authModule.apiRequest !== 'function') return;

    const map = window.map;
    if (!map || map.getZoom() < TICKET_POLYGON_MIN_ZOOM) return;

    const bounds = map.getBounds();
    if (!bounds || !bounds.isValid()) return;

    const paddedBounds = getPolygonBackfillBounds(bounds);
    const queue = buildPolygonBackfillQueueFromBounds(paddedBounds, { allowRetry: false });
    if (queue.length === 0) return;

    queue.forEach((item) => viewportPolygonBackfillLoadingTickets.add(item.ticketNumber));
    renderTickets();

    viewportPolygonBackfillRunning = true;
    try {
        await fetchTicketPolygonsForQueue(queue);
    } finally {
        viewportPolygonBackfillRunning = false;
        queue.forEach((item) => viewportPolygonBackfillLoadingTickets.delete(item.ticketNumber));
    }
}

let ticketMapViewportRefreshTimer = null;
const TICKET_MAP_VIEWPORT_REFRESH_DEBOUNCE_MS = 150;
/** Defer full map layer teardown until after the ticket popup slide animation (0.3s). */
const TICKET_POPUP_OPEN_RENDER_DEFER_MS = 320;

function isTicketDetailPopupOpen() {
    const popup = document.getElementById('ticketPopup');
    if (!popup || !popup.classList.contains('show')) return false;
    const id = popup.getAttribute('data-popup-ticket-id');
    return id != null && String(id).trim() !== '';
}

function ticketPolygonGeometryKey(ticket) {
    if (!ticket || !ticket.polygon) return '';
    try {
        return JSON.stringify(ticket.polygon);
    } catch (_e) {
        return '';
    }
}

/** Avoid full `renderTickets()` teardown while the popup is open unless polygon geometry changed. */
function applyTicketMapRenderAfterDataUpdate(previousTicket, updatedTicket) {
    const prevKey = ticketPolygonGeometryKey(previousTicket);
    const nextKey = ticketPolygonGeometryKey(updatedTicket);
    const geometryChanged = prevKey !== nextKey;
    const popupOpen = isTicketDetailPopupOpen();

    const runRender = () => {
        renderTickets();
        updateTicketsLayerControl();
    };

    if (popupOpen && !geometryChanged) {
        const mod = window.ticketsModule;
        if (mod && typeof mod.refreshTicketMapSelectionVisuals === 'function') {
            mod.refreshTicketMapSelectionVisuals();
        }
        return;
    }

    if (popupOpen && geometryChanged) {
        setTimeout(runRender, TICKET_POPUP_OPEN_RENDER_DEFER_MS);
        return;
    }

    runRender();
}

function scheduleTicketMapViewportRender() {
    const map = window.map;
    if (!map || map.getZoom() < TICKET_POLYGON_MIN_ZOOM) return;
    if (isTicketDetailPopupOpen()) return;
    if (
        window.ticketsModule &&
        typeof window.ticketsModule.isOverlappingTicketPickerOpen === 'function' &&
        window.ticketsModule.isOverlappingTicketPickerOpen()
    ) {
        return;
    }
    if (ticketMapViewportRefreshTimer) clearTimeout(ticketMapViewportRefreshTimer);
    ticketMapViewportRefreshTimer = setTimeout(() => {
        ticketMapViewportRefreshTimer = null;
        if (typeof renderTickets === 'function') {
            renderTickets();
        }
    }, TICKET_MAP_VIEWPORT_REFRESH_DEBOUNCE_MS);
}

function onTicketLayerMapZoomEnd() {
    const map = window.map;
    syncTicketMapZoomMode();
    scheduleViewportPolygonBackfillForVisibleTickets();
    if (!map) return;
    if (
        map.getZoom() >= TICKET_POLYGON_MIN_ZOOM &&
        typeof syncTicketMapPolygonFillForZoom === 'function'
    ) {
        syncTicketMapPolygonFillForZoom();
    }
    // Below polygon zoom, re-render the full ticket set (clusters/pins). Viewport culling at
    // zoom 16+ can clear ticketMapEntries; zooming back out must restore all markers.
    if (map.getZoom() < TICKET_POLYGON_MIN_ZOOM) {
        if (
            window.ticketsModule &&
            typeof window.ticketsModule.isOverlappingTicketPickerOpen === 'function' &&
            window.ticketsModule.isOverlappingTicketPickerOpen()
        ) {
            return;
        }
        if (typeof renderTickets === 'function') {
            renderTickets();
        }
        return;
    }
    scheduleTicketMapViewportRender();
}

function onTicketLayerMapMoveEnd() {
    if (!window.map || window.map.getZoom() < TICKET_POLYGON_MIN_ZOOM) return;
    scheduleViewportPolygonBackfillForVisibleTickets();
    scheduleTicketMapViewportRender();
}

/**
 * Lazily create (and add to the map) the cluster group that holds the 811 point markers.
 * Falls back to a plain layer group when leaflet.markercluster is unavailable, so markers still render.
 */
function ensureTicketMarkerClusterGroup(map) {
    if (ticketMarkerClusterGroup || !map || typeof L === 'undefined') return ticketMarkerClusterGroup;
    if (!map.getPane('ticketPane')) {
        map.createPane('ticketPane');
        const paneEl = map.getPane('ticketPane');
        if (paneEl) paneEl.style.zIndex = '380';
    }
    ticketMarkerClusterGroup =
        typeof L.markerClusterGroup === 'function'
            ? L.markerClusterGroup({
                  clusterPane: 'ticketPane',
                  maxClusterRadius: 50,
                  showCoverageOnHover: false,
                  zoomToBoundsOnClick: true,
                  spiderfyOnMaxZoom: false,
                  chunkedLoading: true,
                  disableClusteringAtZoom: TICKET_POLYGON_MIN_ZOOM,
              })
            : L.layerGroup();
    ticketMarkerClusterGroup.addTo(map);
    return ticketMarkerClusterGroup;
}

/** Group the 811 point markers are added to (cluster group when available, else the polygon group). */
function getTicketMarkerGroup() {
    return ticketMarkerClusterGroup || ticketLayerGroup;
}

function syncTicketMapZoomMode() {
    const map = window.map;
    if (!map || !ticketLayerGroup) return;
    const markerGroup = getTicketMarkerGroup();
    const showPolygon = map.getZoom() >= TICKET_POLYGON_MIN_ZOOM;
    ticketMapEntries.forEach(({ polygon, marker }) => {
        if (polygon && marker) {
            if (showPolygon) {
                if (markerGroup.hasLayer(marker)) markerGroup.removeLayer(marker);
                if (!ticketLayerGroup.hasLayer(polygon)) ticketLayerGroup.addLayer(polygon);
            } else {
                if (ticketLayerGroup.hasLayer(polygon)) ticketLayerGroup.removeLayer(polygon);
                if (!markerGroup.hasLayer(marker)) markerGroup.addLayer(marker);
            }
        } else if (polygon && !marker) {
            if (!ticketLayerGroup.hasLayer(polygon)) ticketLayerGroup.addLayer(polygon);
        } else if (marker && !polygon) {
            if (!markerGroup.hasLayer(marker)) markerGroup.addLayer(marker);
        }
    });
}

function isLeafletMapInstance(map) {
    return !!(map && typeof map.on === 'function' && typeof map.getContainer === 'function');
}

function ensureTicketMapZoomListener() {
    const map = window.map;
    if (!isLeafletMapInstance(map) || ticketMapZoomListenerAttached) return;
    ticketMapZoomListenerAttached = true;
    map.on('zoomend', onTicketLayerMapZoomEnd);
    map.on('moveend', onTicketLayerMapMoveEnd);
}

/**
 * Dismiss the fixed ticket details panel only when the user clicks the map surface — not
 * overlays (controls, other markers/popups, interactive layers). Ticket shapes stop propagation
 * separately so selecting a ticket does not immediately fire this handler.
 */
function ensureTicketPopupMapBackgroundDismiss() {
    const map = window.map;
    if (!isLeafletMapInstance(map) || map._ticketPopupMapDismissWired) return;
    map._ticketPopupMapDismissWired = true;
    map.on('click', function (e) {
        const popupEl = document.getElementById('ticketPopup');
        if (!popupEl || !popupEl.classList.contains('show')) return;
        const oe = e.originalEvent;
        const t = oe && oe.target;
        if (!t || typeof t.closest !== 'function') return;
        const mapContainer = map.getContainer();
        if (!mapContainer.contains(t)) return;
        if (t.closest('.leaflet-control')) return;
        if (t.closest('.leaflet-popup')) return;
        if (t.closest('.leaflet-interactive')) return;
        if (typeof window.closeTicketPopup === 'function') {
            window.closeTicketPopup();
        }
    });
}

/** Same gates as POST /tickets/refresh from the map popup (signed in + ticket number; Tech allowed). */
function userMayRefreshTicketFrom811(ticket) {
    if (!ticket || !window.authModule || !window.authModule.isAuthenticated()) return false;
    const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    return !!tn;
}

const USAN_TICKET_ACTION_FLAG_KEYS = [
    'canBeRemark',
    'canBeAmended',
    'canBeRenewal',
    'canBeFollowUp',
    'canBeDisputed',
    'canBeNoResponse',
];

function ticketUsanActionFlagsAreMissing(ticket) {
    if (!ticket || typeof ticket !== 'object') return true;
    return !USAN_TICKET_ACTION_FLAG_KEYS.some(function (key) {
        const v = ticket[key];
        if (v !== undefined && v !== null) return true;
        const snake =
            key === 'canBeRemark'
                ? ticket.can_be_remark
                : key === 'canBeAmended'
                  ? ticket.can_be_amended
                  : key === 'canBeRenewal'
                    ? ticket.can_be_renewal
                    : key === 'canBeFollowUp'
                      ? ticket.can_be_follow_up
                      : key === 'canBeDisputed'
                        ? ticket.can_be_disputed
                        : key === 'canBeNoResponse'
                          ? ticket.can_be_no_response
                          : undefined;
        return snake !== undefined && snake !== null;
    });
}

/**
 * True when the ticket likely still has list/stub data and needs a full nGen enquiry refresh
 * (canBe* flags, operator rows, response counts).
 */
function ticketNeedsNgenFullDetailRefresh(ticket) {
    if (!userMayRefreshTicketFrom811(ticket)) return false;
    if (ticket.shared) return false;
    const mod = window.ticketImporterModule;
    const isStub =
        ticket.ngenSearchStub === true ||
        (mod && typeof mod.inferNgenSearchStubFromTicket === 'function' && mod.inferNgenSearchStubFromTicket(ticket));
    if (isStub) return true;
    if (ticket.hasFullDetail === true && ticket.ngenFullDetailRefreshedAt) return false;
    if (ticket.hasFullDetail !== true) return true;
    if (ticketUsanActionFlagsAreMissing(ticket)) return true;
    return false;
}

/** Client cooperative lock: skip popup-open auto refresh when recently refreshed or already in flight. */
function isTicketPopupOpenRefreshCoopLocked(ticket) {
    if (!ticket) return true;
    if (isTicketResponsesLockoutFresh(ticket)) return true;
    const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    if (tn && selectedTicketRefreshLoadingTickets.has(tn)) return true;
    return false;
}

function isTicketRefreshInFlight(ticketNumber) {
    const tn = ticketNumber != null ? String(ticketNumber).trim() : '';
    return !!(tn && selectedTicketRefreshLoadingTickets.has(tn));
}

function resolveLiveTicketForRefresh(ticket) {
    if (!ticket) return null;
    const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    if (!tn) return ticket;
    const fromList =
        (window.ORG_TICKETS || []).find((t) => t && t.ticketNumber != null && String(t.ticketNumber).trim() === tn) ||
        null;
    return fromList || ticket;
}

/** Popup-open path: always refresh unless signed out or per-ticket cooperative / in-flight lock. */
function ticketMayAutoRefreshOnPopupOpen(ticket) {
    if (!window.authModule || !window.authModule.isAuthenticated()) return false;
    if (ticket && ticket.__feedWorkspaceView) return false;
    const live = resolveLiveTicketForRefresh(ticket);
    if (!live || !live.ticketNumber || !String(live.ticketNumber).trim()) return false;
    if (live && live.posrPortalDetailsOnly === true) return false;
    return !isTicketPopupOpenRefreshCoopLocked(live);
}

function isProviderImportedTicket(ticket) {
    if (!ticket || ticket.source === 'nv_api') return false;
    const legacyCreatedBySource = 'pac' + 'web';
    const legacyDetailsSource = 'ng' + 'en_enquiry_search';
    const legacyListSource = 'pac' + 'web_list';
    if (ticket.createdBySource === 'source' || ticket.createdBySource === legacyCreatedBySource) return true;
    if (ticket.ticketDetailsSource === 'provider_enquiry_search' || ticket.ticketDetailsSource === legacyDetailsSource) return true;
    if (ticket.source === 'source_list' || ticket.source === legacyListSource) return true;
    return false;
}

/** Matches Worker `ticketSyncLane.SYNC_LANE_NGEN_PRIMARY` (indexed `tickets.sync_lane`). */
const SYNC_LANE_NGEN_PRIMARY = 'ngen_primary';

/**
 * USAN/nGen list poll and enquiry merge (not public POSR lane). API list/detail shapes expose
 * `syncLane` and indexed nGen columns, not legacy `source` / `ticketDetailsSource` JSON keys.
 */
function isNgenPrimarySyncedTicket(ticket) {
    if (!ticket) return false;
    const lane = ticket.syncLane != null ? String(ticket.syncLane).trim().toLowerCase() : '';
    if (lane === SYNC_LANE_NGEN_PRIMARY) return true;
    if (lane !== '') return false;
    if (ticket.ngenJobNumber != null && String(ticket.ngenJobNumber).trim() !== '') return true;
    const req = ticket.ngenRequiredResponseCount;
    const rec = ticket.ngenReceivedResponseCount;
    if (req != null && String(req).trim() !== '') return true;
    if (rec != null && String(rec).trim() !== '') return true;
    return false;
}

/** Title for map popup header refresh control. */
function ticketMapPopupRefreshTitle(ticket) {
    if (isNgenPrimarySyncedTicket(ticket)) {
        return 'Refresh ticket from nGen';
    }
    if (ticket && (ticket.source === 'nv_api' || ticket.source === 'nv_api_cache')) {
        return 'Update ticket from public source and map';
    }
    return 'Refresh via external source; falls back to public source when needed';
}

/** Map ticket popup: show refresh when the user may POST /tickets/refresh for this ticket. */
function ticketMapPopupMayRefresh811(ticket) {
    if (!userMayRefreshTicketFrom811(ticket)) return false;
    if (ticket && ticket.posrPortalDetailsOnly === true) return false;
    if (ticket && ticket.crossOrgCacheFromNgenPrimary === true) return true;
    if (ticket && ticket.source === 'nv_api_cache' && isNgenPrimarySyncedTicket(ticket)) return true;
    if (isNvPublicImportTicketClient(ticket)) return false;
    return true;
}

// Mobile viewport check (matches CSS breakpoint)
function isMobileView() {
    return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
}

/**
 * Padding for ticket-open map fit: top half of the map viewport (mobile and desktop).
 * @returns {{ paddingTopLeft: L.Point, paddingBottomRight: L.Point }}
 */
function getTicketOpenMapPadding(map, options) {
    const opts = options || {};
    const sidePad = opts.sidePad != null ? opts.sidePad : 50;
    const topPad = opts.topPad != null ? opts.topPad : 50;
    const mapH = map.getSize().y;
    const bottomPad = Math.max(sidePad, Math.ceil(mapH / 2));

    return {
        paddingTopLeft: L.point(sidePad, topPad),
        paddingBottomRight: L.point(sidePad, bottomPad),
    };
}

function ticketAnchorBoundsForOpenFit(latlng, delta) {
    const d = delta != null ? delta : 0.0005;
    return L.latLngBounds([latlng.lat - d, latlng.lng - d], [latlng.lat + d, latlng.lng + d]);
}

/**
 * Fit ticket geometry when opening: zoom 20 down to 16 until bounds fit the visible map area.
 * @param {L.Map} map
 * @param {L.LatLngBounds} bounds
 * @param {{ sidePad?: number, topPad?: number, delayMs?: number }} [options]
 */
function fitTicketBoundsForOpen(map, bounds, options) {
    const opts = options || {};
    const delayMs = opts.delayMs != null ? opts.delayMs : TICKET_POPUP_OPEN_RENDER_DEFER_MS;
    const run = () => {
        if (!bounds || typeof bounds.isValid !== 'function' || !bounds.isValid()) return;

        const padOpts = getTicketOpenMapPadding(map, opts);
        const panAnim =
            typeof window.getMapSetViewAnimationOptions === 'function'
                ? window.getMapSetViewAnimationOptions(0.5)
                : { animate: true, duration: 0.5 };

        map.stop();

        let rawZoom = TICKET_OPEN_ZOOM_MIN;
        try {
            const z = map.getBoundsZoom(bounds, true, padOpts);
            if (Number.isFinite(z)) rawZoom = z;
        } catch (_e) {
            /* ignore */
        }

        if (rawZoom < TICKET_OPEN_ZOOM_MIN) {
            if (map.getZoom() !== TICKET_OPEN_ZOOM_MIN) {
                map.setZoom(TICKET_OPEN_ZOOM_MIN, panAnim);
            }
            map.panInsideBounds(bounds, Object.assign({}, padOpts, panAnim));
            return;
        }

        const z = Math.min(TICKET_OPEN_ZOOM_PREFERRED, Math.max(TICKET_OPEN_ZOOM_MIN, rawZoom));
        // fitBounds honors padding so geometry centers in the top-half viewport (not the full map).
        map.fitBounds(bounds, Object.assign({}, padOpts, { maxZoom: z }, panAnim));
    };
    setTimeout(run, delayMs);
}

/** @deprecated Use fitTicketBoundsForOpen — thin wrapper for existing call sites. */
function fitBoundsForTicketAboveDetailsPanel(map, bounds, options) {
    fitTicketBoundsForOpen(map, bounds, options);
}

/** @deprecated Use fitTicketBoundsForOpen — thin wrapper for existing call sites. */
function fitBoundsForTicketInMapTopHalf(map, bounds, options) {
    fitTicketBoundsForOpen(map, bounds, options);
}

/**
 * Pan/fit map to a ticket (hub row select or map pick while hub is open).
 * @param {object} ticket
 * @param {{ sidePad?: number, topPad?: number, delayMs?: number }} [options]
 */
function panMapToTicketAboveBottomChrome(ticket, options) {
    const map = window.map;
    if (!map || !ticket) return;

    void ensureFocusNeighborhoodPolygonsLoaded(ticket);

    if (ticket.id != null) {
        selectedTicketId = ticket.id;
        if (
            window.ticketsModule &&
            typeof window.ticketsModule.applyTicketMapSelectionUiUpdate === 'function'
        ) {
            window.ticketsModule.applyTicketMapSelectionUiUpdate();
        } else if (typeof renderTickets === 'function') {
            renderTickets();
        }
    }

    let bounds = null;
    if (ticket.polygon) {
        try {
            const layer = L.geoJSON(ticket.polygon);
            const b = layer.getBounds();
            if (b.isValid()) bounds = b;
        } catch (_e) {
            /* invalid geometry */
        }
    }

    if (!bounds) {
        const ll = ticketMapAnchorLatLng(ticket);
        if (ll) bounds = ticketAnchorBoundsForOpenFit(ll);
    }
    if (!bounds) return;

    map.stop();
    fitTicketBoundsForOpen(map, bounds, options);
}

window.panMapToTicketAboveBottomChrome = panMapToTicketAboveBottomChrome;

// Check and update tickets after photo changes (only for ACTION_REQUIRED tickets automatically)
function checkTicketsAfterPhotoChange(photoLat, photoLng, opts) {
    const requirePointMatch = !opts || opts.requirePointMatch !== false;
    recomputeCachedTicketStatusesAfterPhotoChange(photoLat, photoLng, { requirePointMatch });
    if (typeof renderTicketList === 'function') {
        renderTicketList();
    }
    if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
        window.ticketHubModule.redrawIfOpen();
    }
    const selected = (window.ORG_TICKETS || []).find((ticket) => ticketIdEquals(selectedTicketId, ticket.id));
    if (selected && typeof showTicketPopup === 'function') {
        showTicketPopup(selected);
    }
}

/**
 * Mark cached server photo-intersection stats stale on every ticket this photo could affect:
 * the explicitly associated ticket (if any) plus all tickets whose polygon matches the photo GPS point.
 */
function invalidateTicketPhotoIntersectionsForPhoto(photo) {
    if (!photo) return;
    const assocId =
        photo.associatedTicketId != null
            ? photo.associatedTicketId
            : photo.exifData && photo.exifData.associatedTicketId != null
              ? photo.exifData.associatedTicketId
              : null;
    const lat = photo.latlng && Number.isFinite(Number(photo.latlng.lat)) ? Number(photo.latlng.lat) : null;
    const lng = photo.latlng && Number.isFinite(Number(photo.latlng.lng)) ? Number(photo.latlng.lng) : null;
    const photoPoint = lat != null && lng != null ? L.latLng(lat, lng) : null;
    (window.ORG_TICKETS || []).forEach((ticket) => {
        if (!ticket) return;
        const matchesAssoc = assocId != null && ticketIdEquals(ticket.id, assocId);
        const matchesPoint = !!(photoPoint && ticket.polygon && ticketPolygonMatchesPhotoPoint(ticket, photoPoint));
        if (!matchesAssoc && !matchesPoint) return;
        ['ticketPhotoStats'].forEach((key) => {
            if (ticket[key] && typeof ticket[key] === 'object') ticket[key].stale = true;
        });
    });
}

/**
 * Full ticket UI + server sync after a photo is uploaded or deleted. Invalidates cached
 * intersections, recomputes statuses (all tickets), redraws hub/list, refreshes the open
 * popup, and schedules the delayed server intersection refresh.
 */
function refreshTicketUiAfterPhotoChange(photo, reason) {
    const lat = photo && photo.latlng && Number.isFinite(Number(photo.latlng.lat)) ? Number(photo.latlng.lat) : null;
    const lng = photo && photo.latlng && Number.isFinite(Number(photo.latlng.lng)) ? Number(photo.latlng.lng) : null;
    invalidateTicketPhotoIntersectionsForPhoto(photo);
    checkTicketsAfterPhotoChange(lat, lng, { requirePointMatch: false });
    scheduleTicketPhotoIntersectionRefresh(reason || 'photo-change', {
        lat,
        lng,
        requirePointMatch: false,
        recomputeLocalStatus: false,
    });
    refreshOpenTicketPopupAfterPhotoChange({ lat, lng });
}
