/**
 * tickets-load.js — split from tickets-operations-photos.js (Phase F1).
 * loadTicketsForCurrentOrg and map zoom-to-tickets.
 * Globals: same window/function names as before (IIFE bundle).
 */
async function loadTicketsForCurrentOrgCore(opts) {
    const options = opts || {};
    const preserveSelection = options.preserveSelection === true;
    const forceRefresh = options.forceRefresh === true;
    const popup = document.getElementById('ticketPopup');
    const popupTicketId = popup ? popup.getAttribute('data-popup-ticket-id') : null;
    const popupWasOpen = !!(popup && popup.classList.contains('show') && popupTicketId);
    const previousSelectedId = selectedTicketId;
    const photoPoint =
        options.photoLat !== null &&
        options.photoLat !== undefined &&
        options.photoLng !== null &&
        options.photoLng !== undefined
            ? L.latLng(options.photoLat, options.photoLng)
            : null;
    const orgId = window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
        ? window.orgSelectorModule.getCurrentOrgId()
        : (window.authModule && window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId);
    if (typeof window.clearTechVisibleTicketNumbersCache === 'function') {
        window.clearTechVisibleTicketNumbersCache();
    }
    if (typeof window.clearProjectAssignmentIndex === 'function') {
        window.clearProjectAssignmentIndex();
    }

    const isFeedWorkspace =
        window.orgSelectorModule &&
        typeof window.orgSelectorModule.canUseCurrentDevTicketHub === 'function' &&
        window.orgSelectorModule.canUseCurrentDevTicketHub();

    // Documentation feed workspace: no tickets / USAN account — skip list + count storm.
    // Map jobs come from GET /api/feed/map-markers; hub from GET /api/feed/service-requests.
    if (isFeedWorkspace) {
        if (typeof clearHubTicketSlices === 'function') clearHubTicketSlices();
        clearTicketsOrgCache();
        if (window.ORG_TICKETS) window.ORG_TICKETS.length = 0;
        window.TICKET_HUB_ORG_USERNAMES = [];
        window.TICKETS_EXPIRED_DB_COUNT = 0;
        window.TICKETS_CANCELLED_DB_COUNT = 0;
        window._LAST_TICKETS_LOAD_ORG_ID = orgId;
        if (typeof setTicketListDataUpdating === 'function') setTicketListDataUpdating('summary-load', false);
        if (typeof renderTickets === 'function') renderTickets();
        if (typeof updateTicketsLayerControl === 'function') updateTicketsLayerControl();
        if (typeof renderTicketList === 'function') renderTicketList();
        // Clear map/hub Active/Expired counts from the previous contractor org.
        // This path skips the normal ticket-list redraw that would call renderHubStats.
        if (typeof window.renderHubStats === 'function') {
            window.renderHubStats();
        }
        if (typeof options.onListDisplayReady === 'function') {
            try {
                options.onListDisplayReady();
            } catch (readyErr) {
                console.warn('[tickets] onListDisplayReady:', readyErr);
            }
        }
        return;
    }

    // Assignment index is org-scoped — warm in background so ticket list is not blocked.
    if (typeof window.refreshProjectAssignmentIndex === 'function') {
        void window.refreshProjectAssignmentIndex({ force: true }).catch(function () {
            /* ignore */
        });
    }
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        clearTicketsOrgCache();
        if (window.ORG_TICKETS) window.ORG_TICKETS.length = 0;
        window.TICKETS_EXPIRED_DB_COUNT = null;
        window.TICKETS_CANCELLED_DB_COUNT = null;
        if (window.ticketsModule) {
            window.ticketsModule.renderTickets();
            if (window.ticketsModule.updateTicketsLayerControl) window.ticketsModule.updateTicketsLayerControl();
            if (window.ticketsModule.renderTicketList) window.ticketsModule.renderTicketList();
        }
        return;
    }

    let renderedCachedSnapshot = false;
    let listDisplayReadyNotified = false;
    const notifyListDisplayReady = () => {
        if (listDisplayReadyNotified) return;
        listDisplayReadyNotified = true;
        if (typeof options.onListDisplayReady === 'function') {
            try {
                options.onListDisplayReady();
            } catch (readyErr) {
                console.warn('[tickets] onListDisplayReady:', readyErr);
            }
        }
    };
    if (typeof setTicketListDataUpdating === 'function') setTicketListDataUpdating('summary-load', true);
    try {
        const selectionToRestore = preserveSelection ? (previousSelectedId || popupTicketId) : null;

        const applySelectionRenderAndMaybePopup = () => {
            let restoredTicket = null;
            if (selectionToRestore != null) {
                restoredTicket =
                    window.ORG_TICKETS.find((t) => ticketIdEquals(t.id, selectionToRestore)) ||
                    (window.HUB_ACTIVE_TICKETS || []).find((t) => ticketIdEquals(t.id, selectionToRestore)) ||
                    (window.HUB_EXPIRED_TICKETS || []).find((t) => ticketIdEquals(t.id, selectionToRestore));
                selectedTicketId = restoredTicket ? restoredTicket.id : null;
            } else {
                selectedTicketId = null;
            }
            renderTickets();
            updateTicketsLayerControl();
            renderTicketList();
            notifyListDisplayReady();
            if (options.refreshOpenPopup && popupWasOpen && restoredTicket && typeof showTicketPopup === 'function') {
                const shouldRefreshPopup =
                    !options.requirePointMatch ||
                    !photoPoint ||
                    (typeof ticketPolygonMatchesPhotoPoint === 'function' &&
                        ticketPolygonMatchesPhotoPoint(restoredTicket, photoPoint));
                if (shouldRefreshPopup) {
                    showTicketPopup(restoredTicket);
                }
            }
        };

        const offlineAtStart =
            window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline();
        if (offlineAtStart && !forceRefresh && window.offlineTickets) {
            const hydrated = await window.offlineTickets.hydrateOrgTicketsFromIdb(orgId);
            if (hydrated) {
                if (typeof window.offlineTickets.mergeAssignedDetailsIntoOrgTickets === 'function') {
                    await window.offlineTickets.mergeAssignedDetailsIntoOrgTickets(orgId);
                }
                await finishTicketsLoadFromMemory(applySelectionRenderAndMaybePopup);
                return;
            }
        }

        if (forceRefresh || window._LAST_TICKETS_LOAD_ORG_ID !== orgId) {
            clearHubTicketSlices();
            window._LAST_TICKETS_LOAD_ORG_ID = orgId;
        }
        if (typeof clearProgressiveTicketListLoadState === 'function') {
            clearProgressiveTicketListLoadState();
        }
        if (!forceRefresh) {
            const cached = getFreshTicketsOrgCache(orgId);
            if (cached && Array.isArray(cached.tickets)) {
                const hub = cloneForTicketsOrgCache(cached.hubUsernames);
                window.TICKET_HUB_ORG_USERNAMES = Array.isArray(hub) ? hub : [];
                const tickets = cloneForTicketsOrgCache(cached.tickets);
                if (!window.ORG_TICKETS) window.ORG_TICKETS = [];
                window.ORG_TICKETS.length = 0;
                window.ORG_TICKETS.push(...(Array.isArray(tickets) ? tickets : []));
                if (typeof ensureTicketStatusForMap === 'function') {
                    window.ORG_TICKETS.forEach((t) => ensureTicketStatusForMap(t));
                }
                if (typeof window.refreshTechVisibleTicketNumbers === 'function') {
                    try {
                        await window.refreshTechVisibleTicketNumbers();
                    } catch (_e) {
                        /* ignore */
                    }
                }
                if (typeof window.refreshProjectAssignmentIndex === 'function') {
                    void window.refreshProjectAssignmentIndex({ force: true }).catch(function () {
                        /* ignore */
                    });
                }
                applySelectionRenderAndMaybePopup();
                renderedCachedSnapshot = true;
                const hubWin = document.getElementById('ticketHubWindow');
                if (hubWin && hubWin.classList.contains('show')) {
                    void loadHubTicketSliceForCurrentFilters().catch((e) => {
                        console.warn('[tickets] cached hub slice refresh:', e.message || e);
                    });
                }
                if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
                    window.ticketHubModule.redrawIfOpen();
                }
            } else if (
                window.offlineTickets &&
                typeof window.offlineTickets.loadTicketsOrgFromIdb === 'function' &&
                typeof window.offlineTickets.isIdbLeanListFreshForPaint === 'function'
            ) {
                try {
                    const idbEntry = await window.offlineTickets.loadTicketsOrgFromIdb(orgId);
                    if (window.offlineTickets.isIdbLeanListFreshForPaint(idbEntry)) {
                        if (!window.ORG_TICKETS) window.ORG_TICKETS = [];
                        window.ORG_TICKETS.length = 0;
                        window.ORG_TICKETS.push(...idbEntry.tickets);
                        window.TICKET_HUB_ORG_USERNAMES = Array.isArray(idbEntry.hubUsernames)
                            ? idbEntry.hubUsernames
                            : [];
                        if (typeof ensureTicketStatusForMap === 'function') {
                            window.ORG_TICKETS.forEach((t) => ensureTicketStatusForMap(t));
                        }
                        if (typeof window.refreshTechVisibleTicketNumbers === 'function') {
                            try {
                                await window.refreshTechVisibleTicketNumbers();
                            } catch (_e) {
                                /* ignore */
                            }
                        }
                        if (typeof window.refreshProjectAssignmentIndex === 'function') {
                            void window.refreshProjectAssignmentIndex({ force: true }).catch(function () {
                                /* ignore */
                            });
                        }
                        applySelectionRenderAndMaybePopup();
                        renderedCachedSnapshot = true;
                        if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
                            window.ticketHubModule.redrawIfOpen();
                        }
                    }
                } catch (idbPaintErr) {
                    console.warn('[tickets] online IDB lean paint:', idbPaintErr.message || idbPaintErr);
                }
            }
        }

        if (!forceRefresh && areTicketsFreshForOrg(orgId)) {
            await finishTicketsLoadFromMemory(applySelectionRenderAndMaybePopup);
            // Hub count chips are secondary — fetch after paint so they do not starve the list GET under rate limits.
            if (orgId) {
                void (async () => {
                    try {
                        const [ctx, exp, cancelled] = await Promise.all([
                            window.authModule.apiRequest(
                                `${window.authModule.API_BASE}/tickets/lodged-by-context?organizationId=${orgId}`
                            ),
                            window.authModule.apiRequest(
                                `${window.authModule.API_BASE}/tickets/expired-count?organizationId=${orgId}`
                            ),
                            window.authModule.apiRequest(
                                `${window.authModule.API_BASE}/tickets/cancelled-count?organizationId=${orgId}`
                            ),
                        ]);
                        window.TICKET_HUB_ORG_USERNAMES =
                            ctx && Array.isArray(ctx.orgUsernames) ? ctx.orgUsernames : [];
                        window.TICKETS_EXPIRED_DB_COUNT =
                            exp && typeof exp.expiredCount === 'number' && Number.isFinite(exp.expiredCount)
                                ? exp.expiredCount
                                : null;
                        window.TICKETS_CANCELLED_DB_COUNT =
                            cancelled &&
                            typeof cancelled.cancelledCount === 'number' &&
                            Number.isFinite(cancelled.cancelledCount)
                                ? cancelled.cancelledCount
                                : null;
                        if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
                            window.ticketHubModule.redrawIfOpen();
                        } else if (typeof window.renderHubStats === 'function') {
                            window.renderHubStats();
                        }
                    } catch (ctxErr) {
                        console.warn('lodged-by-context / expired-count / cancelled-count (fresh skip):', ctxErr);
                    }
                })();
            }
            return;
        }

        const buildActiveTicketsUrl = (cursor) => {
            const base = orgId
                ? `${window.authModule.API_BASE}/tickets?organizationId=${orgId}&summary=1&limit=${SIDEBAR_TICKET_PAGE_LIMIT}&activeOnly=1`
                : `${window.authModule.API_BASE}/tickets?includeShared=1&summary=1&limit=${SIDEBAR_TICKET_PAGE_LIMIT}&activeOnly=1`;
            return cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
        };
        let ctxUsernames = [];
        window.TICKETS_EXPIRED_DB_COUNT = null;
        window.TICKETS_CANCELLED_DB_COUNT = null;
        window.TICKET_HUB_ORG_USERNAMES = ctxUsernames;

        if (!window.ORG_TICKETS) window.ORG_TICKETS = [];
        // Merge each page against the detail cached before this load (preserves history/photos on summary rows).
        const previousTickets = window.ORG_TICKETS.slice();
        const cacheMap =
            typeof indexTicketsForSummaryMerge === 'function'
                ? indexTicketsForSummaryMerge(previousTickets)
                : new Map(previousTickets.map((t) => [String(t && t.id), t]));
        const isTechViewer = !!(window.authModule.isTechInCurrentOrg && window.authModule.isTechInCurrentOrg());
        const mergeActivePage = (list) =>
            list.map((summary) => {
                const prev =
                    typeof findCachedTicketForSummary === 'function'
                        ? findCachedTicketForSummary(summary, cacheMap)
                        : cacheMap.get(String(summary && summary.id));
                return prev && typeof mergeSummaryIntoCachedTicket === 'function'
                    ? mergeSummaryIntoCachedTicket(prev, summary)
                    : summary;
            });

        // Page through ALL active tickets (server clamps page size to 500). Safety bound avoids runaway loops.
        const ACTIVE_TICKET_PAGE_MAX = 40;
        const accumulatedActive = [];
        let activeCursor = null;
        let activePageNum = 0;
        do {
            const raw = await window.authModule.apiRequest(buildActiveTicketsUrl(activeCursor));
            let list = [];
            if (raw && typeof raw === 'object' && raw.listMode === 'summary' && Array.isArray(raw.tickets)) {
                list = raw.tickets;
            } else if (Array.isArray(raw)) {
                list = raw;
            }
            if (isTechViewer) {
                list = list.filter((t) => !t || !t.shared);
            }
            const beforeLen = accumulatedActive.length;
            const mergedPage = mergeActivePage(list);
            accumulatedActive.push(...mergedPage);
            const newTickets = accumulatedActive.slice(beforeLen);
            // Progressive feedback: update the (virtualized) sidebar list as pages stream in.
            window.ORG_TICKETS.length = 0;
            window.ORG_TICKETS.push(...accumulatedActive);
            if (typeof ensureTicketStatusForMap === 'function') {
                window.ORG_TICKETS.forEach((t) => ensureTicketStatusForMap(t));
            }
            if (typeof setTicketListProgressiveLoadedCount === 'function') {
                setTicketListProgressiveLoadedCount(accumulatedActive.length);
            }
            if (beforeLen === 0) {
                renderTickets();
                updateTicketsLayerControl();
                notifyListDisplayReady();
            } else if (typeof scheduleAppendTicketsToMap === 'function') {
                scheduleAppendTicketsToMap(newTickets);
            }
            renderTicketList();

            activePageNum += 1;
            const hasMore = !!(raw && typeof raw === 'object' && raw.hasMore);
            let nextCursor = hasMore && raw && raw.nextCursor ? String(raw.nextCursor) : null;
            if (nextCursor && activePageNum >= ACTIVE_TICKET_PAGE_MAX) {
                console.warn(
                    `[tickets] active ticket load hit safety cap of ${ACTIVE_TICKET_PAGE_MAX} pages; stopping with ${accumulatedActive.length} tickets.`
                );
                nextCursor = null;
            }
            if (typeof options.onBootProgress === 'function') {
                try {
                    options.onBootProgress({
                        loadedCount: accumulatedActive.length,
                        pageNum: activePageNum,
                        hasMore: !!nextCursor,
                    });
                } catch (bootProgErr) {
                    console.warn('[tickets] onBootProgress:', bootProgErr);
                }
            }
            activeCursor = nextCursor;
        } while (activeCursor);

        if (typeof options.onBootProgress === 'function' && activePageNum === 0) {
            try {
                options.onBootProgress({
                    loadedCount: accumulatedActive.length,
                    pageNum: 0,
                    hasMore: false,
                });
            } catch (bootProgErr) {
                console.warn('[tickets] onBootProgress:', bootProgErr);
            }
        }

        if (window.ORG_TICKETS && typeof ensureTicketStatusForMap === 'function') {
            window.ORG_TICKETS.forEach((t) => ensureTicketStatusForMap(t));
        }

        // Hub counts after the list GET — avoids starving /tickets under Cloudflare rate limits (browser shows CORS).
        if (orgId) {
            try {
                const [ctx, exp, cancelled] = await Promise.all([
                    window.authModule.apiRequest(
                        `${window.authModule.API_BASE}/tickets/lodged-by-context?organizationId=${orgId}`
                    ),
                    window.authModule.apiRequest(
                        `${window.authModule.API_BASE}/tickets/expired-count?organizationId=${orgId}`
                    ),
                    window.authModule.apiRequest(
                        `${window.authModule.API_BASE}/tickets/cancelled-count?organizationId=${orgId}`
                    ),
                ]);
                ctxUsernames = ctx && Array.isArray(ctx.orgUsernames) ? ctx.orgUsernames : [];
                window.TICKETS_EXPIRED_DB_COUNT =
                    exp && typeof exp.expiredCount === 'number' && Number.isFinite(exp.expiredCount)
                        ? exp.expiredCount
                        : null;
                window.TICKETS_CANCELLED_DB_COUNT =
                    cancelled &&
                    typeof cancelled.cancelledCount === 'number' &&
                    Number.isFinite(cancelled.cancelledCount)
                        ? cancelled.cancelledCount
                        : null;
            } catch (ctxErr) {
                console.warn('lodged-by-context / expired-count / cancelled-count:', ctxErr);
            }
        }
        window.TICKET_HUB_ORG_USERNAMES = ctxUsernames;

        const pinnedImports = options.preserveImportedTickets;
        if (Array.isArray(pinnedImports) && pinnedImports.length > 0) {
            mergeImportedTicketsIntoOrgList(pinnedImports);
        }
        putTicketsOrgCache(orgId, window.ORG_TICKETS, window.TICKET_HUB_ORG_USERNAMES);
        lastTicketsFullLoadAt.set(ticketsOrgCacheKey(orgId), Date.now());
        await finishTicketsLoadFromMemory(applySelectionRenderAndMaybePopup);
    } catch (err) {
        console.error('? Error loading tickets for organization:', err);
        if (
            window.offlineTickets &&
            typeof window.offlineTickets.isOfflineOrNetworkFailure === 'function' &&
            window.offlineTickets.isOfflineOrNetworkFailure(err)
        ) {
            const hydrated = await window.offlineTickets.hydrateOrgTicketsFromIdb(orgId);
            if (hydrated) {
                if (typeof window.offlineTickets.mergeAssignedDetailsIntoOrgTickets === 'function') {
                    await window.offlineTickets.mergeAssignedDetailsIntoOrgTickets(orgId);
                }
                await finishTicketsLoadFromMemory(applySelectionRenderAndMaybePopup);
                return;
            }
        }
        if (renderedCachedSnapshot) return;
        if (window.ORG_TICKETS) window.ORG_TICKETS.length = 0;
        window.TICKETS_EXPIRED_DB_COUNT = null;
        window.TICKETS_CANCELLED_DB_COUNT = null;
        if (!preserveSelection) selectedTicketId = null;
        renderTickets();
        updateTicketsLayerControl();
        renderTicketList();
        notifyListDisplayReady();
    } finally {
        if (typeof setTicketListDataUpdating === 'function') setTicketListDataUpdating('summary-load', false);
        notifyListDisplayReady();
    }
}

async function loadTicketsForCurrentOrg(opts) {
    const options = opts || {};
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        return loadTicketsForCurrentOrgCore(options);
    }
    const orgId =
        window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
            ? window.orgSelectorModule.getCurrentOrgId()
            : window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId;
    const orgKey = ticketsOrgCacheKey(orgId);
    const inFlight = ticketsLoadInFlight.get(orgKey);
    if (inFlight) {
        try {
            await inFlight;
        } catch (_) {
            /* prior load failed; start a fresh attempt below */
        }
    }
    if (!options.forceRefresh && ticketsLoadInFlight.has(orgKey)) {
        return ticketsLoadInFlight.get(orgKey);
    }
    const loadPromise = loadTicketsForCurrentOrgCore(options);
    ticketsLoadInFlight.set(orgKey, loadPromise);
    try {
        await loadPromise;
    } finally {
        if (ticketsLoadInFlight.get(orgKey) === loadPromise) {
            ticketsLoadInFlight.delete(orgKey);
        }
    }
}

// Update tickets layer toolbar toggle
function updateTicketsLayerControl() {
    const map = window.map;
    if (!map || !window.layerControlPanel || !window.mapOverlayTogglesModule) return;

    // Ensure ticketLayerGroup exists (create if it doesn't)
    if (!ticketLayerGroup) {
        if (!map.getPane('ticketPane')) {
            map.createPane('ticketPane');
        }
        const ticketPaneElCtl = map.getPane('ticketPane');
        if (ticketPaneElCtl) ticketPaneElCtl.style.zIndex = '380';
        ticketLayerGroup = L.layerGroup();
        ticketLayerGroup.addTo(map);
        ensureTicketMapZoomListener();
    }
    ensureTicketMarkerClusterGroup(map);

    const toggles = window.mapOverlayTogglesModule;

    function setTicketsLayerVisible(visible) {
        if (!map) return;
        if (visible) {
            map.addLayer(ticketLayerGroup);
            if (ticketMarkerClusterGroup) map.addLayer(ticketMarkerClusterGroup);
        } else {
            map.removeLayer(ticketLayerGroup);
            if (ticketMarkerClusterGroup) map.removeLayer(ticketMarkerClusterGroup);
        }
        toggles.syncMapOverlayToggle('tickets', visible);
    }

    toggles.createMapOverlayToggle({
        id: 'tickets',
        label: 'Tickets',
        getActive: function () {
            return !!(ticketLayerGroup && map.hasLayer(ticketLayerGroup));
        },
        onToggle: setTicketsLayerVisible,
    });

    toggles.syncMapOverlayToggle(
        'tickets',
        !!(ticketLayerGroup && map.hasLayer(ticketLayerGroup))
    );
}

/** Fit the map to polygons / stub pins for the given tickets. Returns true if bounds were applied. */
function fitMapToTickets(tickets) {
    const map = window.map;
    if (!map || typeof L === 'undefined' || !L.latLngBounds) return false;
    const list = Array.isArray(tickets) ? tickets : [];
    if (list.length === 0) return false;

    const bounds = L.latLngBounds([]);
    list.forEach((ticket) => {
        if (ticket && ticket.polygon) {
            try {
                const layer = L.geoJSON(ticket.polygon);
                const layerBounds = layer.getBounds();
                if (layerBounds && layerBounds.isValid()) {
                    bounds.extend(layerBounds);
                }
            } catch (_) {
                /* skip invalid polygon */
            }
        } else if (
            ticket &&
            ticket.stubMapPin &&
            Number.isFinite(Number(ticket.stubMapPin.lat)) &&
            Number.isFinite(Number(ticket.stubMapPin.lng))
        ) {
            bounds.extend([Number(ticket.stubMapPin.lat), Number(ticket.stubMapPin.lng)]);
        }
    });

    if (!bounds.isValid()) return false;
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
    return true;
}

// Zoom to all tickets (active only — exclude EXPIRED/CANCELLED from initial bbox)
function zoomToAllTickets() {
    const map = window.map;
    if (!map || !ticketLayerGroup) return;

    const allTickets = window.ORG_TICKETS || [];
    if (allTickets.length === 0) return;

    const activeTickets = allTickets.filter((ticket) => {
        if (!ticket) return false;
        const status =
            typeof getTicketWorkflowStatusForMap === 'function'
                ? getTicketWorkflowStatusForMap(ticket)
                : ticket.status;
        if (typeof isInactiveWorkflowStatus === 'function') {
            return !isInactiveWorkflowStatus(status);
        }
        return status !== 'EXPIRED' && status !== 'CANCELLED';
    });
    if (activeTickets.length === 0) {
        shouldAutoZoomToAllTickets = false;
        return;
    }

    fitMapToTickets(activeTickets);
    shouldAutoZoomToAllTickets = false;
}
