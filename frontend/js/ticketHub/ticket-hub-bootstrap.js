    'use strict';

    const TICKET_HUB_BACK_ID = 'ticketHub';

    function isTicketHubPanelOpen() {
        const win = document.getElementById('ticketHubWindow');
        return !!(win && win.classList.contains('show'));
    }

    function registerTicketHubBack() {
        if (!window.uiBackStack) return;
        window.uiBackStack.register({
            id: TICKET_HUB_BACK_ID,
            isOpen: isTicketHubPanelOpen,
            onBack: function () {
                closeTicketHubWindow({ fromBack: true });
            },
        });
    }

    function unregisterTicketHubBack(fromBack) {
        if (!window.uiBackStack || !window.uiBackStack.isRegistered(TICKET_HUB_BACK_ID)) return;
        window.uiBackStack.unregister(TICKET_HUB_BACK_ID, fromBack ? { fromPopstate: true } : undefined);
    }

    /**
     * @param {{ skipPacPoll?: boolean, skipServerTicketLoad?: boolean, reopenFromPolygonDraw?: boolean, mobileFull?: boolean }} [opts]
     */
    async function openTicketHubWindow(opts) {
        const o = opts || {};
        let skipPacPoll = o.skipPacPoll === true;
        let skipServerTicketLoad = o.skipServerTicketLoad === true;
        const reopenFromPolygonDraw = o.reopenFromPolygonDraw === true;
        const mobileFull = o.mobileFull === true;
        if (reopenFromPolygonDraw) {
            hubSuppressOutsideCloseUntil = Date.now() + 900;
        }
        if (!isTicketHubAccessible()) {
            if (typeof window.appAlert === 'function') window.appAlert('Ticket hub is not available for your role.');
            return;
        }
        if (typeof window.closeAllCircleMenus === 'function') window.closeAllCircleMenus();
        if (typeof window.closeMapTopLeftLauncher === 'function') window.closeMapTopLeftLauncher();
        if (typeof window.closeMapTopLeftStatFilterMenu === 'function') {
            window.closeMapTopLeftStatFilterMenu();
        }
        const win = document.getElementById('ticketHubWindow');
        if (!win) return;
        hideTicketHubDetailModal();
        if (isTicketHubMobile()) {
            clearHubWindowInlineLayout(win);
            if (mobileFull) {
                applyTicketHubMobileFullOpenState(win);
            } else {
                applyTicketHubMobileOpenState(win);
            }
        } else {
            clearHubWindowInlineLayout(win);
            applyTicketHubSplitFromProfile();
        }
        win.classList.add('show');
        registerTicketHubBack();
        if (typeof window.enterFeedHubMode === 'function') {
            const feedActive = await window.enterFeedHubMode();
            if (feedActive) {
                if (typeof window.syncDataWindowStackAboveHub === 'function') {
                    window.syncDataWindowStackAboveHub();
                }
                if (!isTicketHubMobile()) {
                    if (window.ticketHubDockModule && typeof window.ticketHubDockModule.onHubOpened === 'function') {
                        window.ticketHubDockModule.onHubOpened();
                    }
                }
                setTicketHubLoadingOverlay(false);
                return;
            }
        }
        if (typeof window.syncTicketHubMobileHeightToggle === 'function') {
            window.syncTicketHubMobileHeightToggle();
        }
        if (typeof window.resetTicketHubSectionOnOpen === 'function') {
            window.resetTicketHubSectionOnOpen();
        }
        if (typeof window.initTicketHubSections === 'function') {
            window.initTicketHubSections();
        }
        if (typeof window.refreshTechVisibleTicketNumbers === 'function') {
            void window.refreshTechVisibleTicketNumbers().then(function () {
                if (typeof window.renderHubTable === 'function') window.renderHubTable();
                if (typeof window.renderTickets === 'function') window.renderTickets();
            });
        }
        if (typeof window.refreshProjectAssignmentIndex === 'function') {
            void window.refreshProjectAssignmentIndex({ force: true }).then(function () {
                if (typeof window.renderHubTable === 'function') window.renderHubTable();
                if (typeof window.renderTicketList === 'function') window.renderTicketList();
            });
        }
        if (typeof window.syncDataWindowStackAboveHub === 'function') {
            window.syncDataWindowStackAboveHub();
        }
        if (typeof window.relocateTicketHubFiltersPack === 'function') window.relocateTicketHubFiltersPack();
        if (!isTicketHubMobile()) {
            if (window.ticketHubDockModule && typeof window.ticketHubDockModule.onHubOpened === 'function') {
                window.ticketHubDockModule.onHubOpened();
            }
        }
        await populateHubAssigneeFilter();

        const hubOrgIdEarly =
            typeof getHubOrganizationId === 'function' ? getHubOrganizationId() : null;
        const tm = window.ticketsModule;
        const hubLoadInFlight =
            tm && typeof tm.isTicketsLoadInFlightForOrg === 'function' && hubOrgIdEarly != null
                ? tm.isTicketsLoadInFlightForOrg(hubOrgIdEarly)
                : false;
        const hubTicketsFresh =
            tm && typeof tm.areTicketsFreshForOrg === 'function' && hubOrgIdEarly != null
                ? tm.areTicketsFreshForOrg(hubOrgIdEarly)
                : false;
        if (!skipServerTicketLoad && (hubLoadInFlight || hubTicketsFresh)) {
            skipServerTicketLoad = true;
        }

        const showTicketLoadOverlay = !skipServerTicketLoad;
        if (showTicketLoadOverlay) {
            setTicketHubLoadingOverlay(true);
        }

        let orgId = null;
        try {
            if (
                hubLoadInFlight &&
                tm &&
                typeof tm.awaitTicketsLoadForOrg === 'function' &&
                hubOrgIdEarly != null
            ) {
                try {
                    await tm.awaitTicketsLoadForOrg(hubOrgIdEarly);
                } catch (e) {
                    console.warn('Ticket hub: await in-flight ticket load', e);
                }
            } else if (
                !skipServerTicketLoad &&
                tm &&
                typeof tm.loadTicketsForCurrentOrg === 'function'
            ) {
                try {
                    await tm.loadTicketsForCurrentOrg();
                } catch (e) {
                    console.warn('Ticket hub: refresh tickets', e);
                }
            }
            orgId = getHubOrganizationId();
            if (orgId != null && orgId !== '') {
                const n = parseInt(String(orgId), 10);
                if (Number.isFinite(n)) orgId = n;
            }
            // After an org switch we already reset filters and wrote defaults; do not reload
            // sticky per-org KV state (that was undoing the reset).
            const skipStateRestore = window.__ticketHubSkipNextStateRestore === true;
            if (skipStateRestore) {
                window.__ticketHubSkipNextStateRestore = false;
            }
            if (
                !reopenFromPolygonDraw &&
                !skipStateRestore &&
                window.authModule &&
                orgId != null &&
                orgId !== '' &&
                canPersistHubStateForCurrentOrg()
            ) {
                try {
                    const hubData = await window.authModule.apiRequest(
                        'users/me/ticket-hub-state?organizationId=' + encodeURIComponent(String(orgId))
                    );
                    if (hubData && hubData.state && typeof hubData.state === 'object') {
                        const s = hubData.state;
                        const assignEl = document.getElementById('ticketHubAssigneeFilter');
                        if (s.assignee != null && assignEl) {
                            const opt = [].find.call(
                                assignEl.options,
                                function (o) {
                                    return o.value === String(s.assignee);
                                }
                            );
                            if (opt) assignEl.value = String(s.assignee);
                        }
                        const timeframeTypeEl = document.getElementById('ticketHubTimeframeType');
                        if (s.timeframeType != null && timeframeTypeEl) {
                            const ttv = String(s.timeframeType);
                            if (['job_start', 'legal_start', 'expiration'].includes(ttv)) timeframeTypeEl.value = ttv;
                        }
                        const timeframeEl = document.getElementById('ticketHubTimeframe');
                        if (s.timeframe != null && timeframeEl) {
                            const opt = [].find.call(timeframeEl.options, function (o) {
                                return o.value === String(s.timeframe);
                            });
                            if (opt) timeframeEl.value = String(s.timeframe);
                        }
                        const fromEl = document.getElementById('ticketHubFromDate');
                        if (s.fromDate != null && fromEl) fromEl.value = String(s.fromDate);
                        const toEl = document.getElementById('ticketHubToDate');
                        if (s.toDate != null && toEl) toEl.value = String(s.toDate);
                        syncHubFilterControls({ skipMobileConstraints: true });
                        const ownerOrgEl = document.getElementById('ticketHubOwnerOrgFilter');
                        if (s.ownerOrg != null && ownerOrgEl) {
                            const opt = [].find.call(ownerOrgEl.options, function (o) {
                                return o.value === String(s.ownerOrg);
                            });
                            if (opt) ownerOrgEl.value = String(s.ownerOrg);
                        }
                        const submittedByEl = document.getElementById('ticketHubSubmittedByFilter');
                        if (s.submittedBy != null && submittedByEl) {
                            const submittedVal = String(s.submittedBy);
                            if (typeof ensureHubSubmittedByFilterOption === 'function') {
                                ensureHubSubmittedByFilterOption(submittedByEl, submittedVal);
                            }
                            const submittedOpt = [].find.call(submittedByEl.options, function (o) {
                                return o.value === submittedVal;
                            });
                            if (submittedOpt) submittedByEl.value = submittedVal;
                        }
                        const sortEl = document.getElementById('ticketHubListSort');
                        if (sortEl) {
                            const normalizedSort =
                                typeof normalizeHubListSort === 'function'
                                    ? normalizeHubListSort(s.listSort)
                                    : s.listSort === 'expiring_latest'
                                      ? 'expiring_latest'
                                      : 'expiring_soonest';
                            sortEl.value = normalizedSort;
                        }
                        if (typeof isTicketHubMobile === 'function' && isTicketHubMobile()) {
                            if (typeof clampMobileHubAdvancedFilterValues === 'function') {
                                clampMobileHubAdvancedFilterValues();
                            }
                            if (typeof collapseHubMobileAdvancedFilters === 'function') {
                                collapseHubMobileAdvancedFilters();
                            }
                        }
                        syncHubFilterControls();
                    }
                } catch (e) {
                    /* 503 or offline */
                }
            }
        } finally {
            if (showTicketLoadOverlay) {
                setTicketHubLoadingOverlay(false);
            }
        }

        if (
            skipPacPoll &&
            !skipServerTicketLoad &&
            window.ticketsModule &&
            typeof window.ticketsModule.loadTicketsForCurrentOrg === 'function'
        ) {
            try {
                await window.ticketsModule.loadTicketsForCurrentOrg({ forceRefresh: true });
            } catch (e) {
                console.warn('Ticket hub: reload without list sync', e);
            }
        }

        if (!reopenFromPolygonDraw) {
            const hubSearchEl = document.getElementById('ticketHubSearch');
            if (hubSearchEl) hubSearchEl.value = '';
        }
        if (typeof window.onTicketHubFilterChange === 'function') {
            window.onTicketHubFilterChange();
        } else {
            refreshTicketHubWindow();
            if (window.renderTickets) window.renderTickets();
        }
        if (typeof window.rememberTicketHubPersistedBaselineFromDom === 'function') {
            window.rememberTicketHubPersistedBaselineFromDom();
        }
        if (hubSearchPolygonGeo) {
            rebuildHubSearchPolygonLeaflet();
            syncHubSearchPolygonMapLayer();
        }
        updateHubSearchPolygonButtons();
        if (window.renderTickets) window.renderTickets();
        if (window.innerWidth > 768) {
            initHubResize();
            initHubSplitResize();
        }
        initHubTableColumnResize();
        if (window.ticketHubDockModule && typeof window.ticketHubDockModule.init === 'function') {
            window.ticketHubDockModule.init();
        }

        const runPacPollAsync =
            !skipPacPoll &&
            !(window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline()) &&
            orgId != null &&
            orgId !== '' &&
            !(
                typeof window.isCurrentOrgPublicCatalogViewer === 'function' &&
                window.isCurrentOrgPublicCatalogViewer()
            ) &&
            window.authModule &&
            window.ticketsModule &&
            typeof window.ticketsModule.loadTicketsForCurrentOrg === 'function' &&
            (typeof window.ticketsModule.isTicketListUsanSyncBusy !== 'function' ||
                !window.ticketsModule.isTicketListUsanSyncBusy());

        if (runPacPollAsync) {
            if (typeof window.setTicketHubTitleUsanPollIndicator === 'function') {
                window.setTicketHubTitleUsanPollIndicator(true);
            }
            if (typeof window.ticketsModule.setTicketListUsanSyncing === 'function') {
                window.ticketsModule.setTicketListUsanSyncing(true);
            }
            void (async () => {
                let hubListPollResult = null;
                try {
                    hubListPollResult = await window.authModule.apiRequest('tickets/usan-poll', {
                        method: 'POST',
                        body: JSON.stringify({ organizationId: orgId }),
                    });
                } catch (e) {
                    console.warn('Ticket hub: incremental list sync', e);
                } finally {
                    if (typeof window.setTicketHubTitleUsanPollIndicator === 'function') {
                        window.setTicketHubTitleUsanPollIndicator(false);
                    }
                    if (typeof window.ticketsModule.setTicketListUsanSyncing === 'function') {
                        window.ticketsModule.setTicketListUsanSyncing(false);
                    }
                }
                const pollTouched =
                    window.ticketsModule.usanPollResultTouchedTickets &&
                    window.ticketsModule.usanPollResultTouchedTickets(hubListPollResult);
                // Only reload when the poll actually changed rows — not on credential/config 400s (POSR-only orgs).
                if (pollTouched === true) {
                    try {
                        await window.ticketsModule.loadTicketsForCurrentOrg({ forceRefresh: true });
                    } catch (e2) {
                        console.warn('Ticket hub: reload after list sync', e2);
                    }
                }
                const winStill = document.getElementById('ticketHubWindow');
                if (!winStill || !winStill.classList.contains('show')) return;
                if (typeof window.onTicketHubFilterChange === 'function') {
                    window.onTicketHubFilterChange();
                } else {
                    refreshTicketHubWindow();
                    if (window.renderTickets) window.renderTickets();
                }
                if (typeof window.syncTicketHubRenewButtonVisibility === 'function') {
                    window.syncTicketHubRenewButtonVisibility();
                }
                if (typeof window.syncTicketHubBulkDeleteVisibility === 'function') {
                    window.syncTicketHubBulkDeleteVisibility();
                }
                if (typeof window.syncTicketHubAnalyticsTabVisibility === 'function') {
                    window.syncTicketHubAnalyticsTabVisibility();
                }
            })();
        }
        if (typeof window.syncTicketHubRenewButtonVisibility === 'function') {
            window.syncTicketHubRenewButtonVisibility();
        }
        if (typeof window.syncTicketHubBulkDeleteVisibility === 'function') {
            window.syncTicketHubBulkDeleteVisibility();
        }
        if (typeof window.syncTicketHubAnalyticsTabVisibility === 'function') {
            window.syncTicketHubAnalyticsTabVisibility();
        }
    }

    function ensureDesktopTicketHubOpen(opts) {
        if (typeof isTicketHubMobile === 'function' && isTicketHubMobile()) return Promise.resolve();
        if (
            typeof window.isCurrentOrgPublicCatalogViewer === 'function' &&
            window.isCurrentOrgPublicCatalogViewer()
        ) {
            return Promise.resolve();
        }
        const win = document.getElementById('ticketHubWindow');
        if (win && win.classList.contains('show')) {
            if (window.ticketHubDockModule && typeof window.ticketHubDockModule.onHubOpened === 'function') {
                window.ticketHubDockModule.onHubOpened();
            }
            return Promise.resolve();
        }
        if (typeof window.openTicketHubWindow === 'function') {
            return window.openTicketHubWindow(opts || { skipPacPoll: true, skipServerTicketLoad: true });
        }
        return Promise.resolve();
    }

    function toggleTicketHubWindow() {
        if (typeof isTicketHubMobile === 'function' && isTicketHubMobile() && isTicketHubPanelOpen()) {
            closeTicketHubWindow();
            return;
        }
        void openTicketHubWindow();
    }

    function closeTicketHubWindow(opts) {
        const options = opts || {};
        if (
            !options.force &&
            typeof isTicketHubMobile === 'function' &&
            !isTicketHubMobile()
        ) {
            return;
        }
        if (
            !options.skipPersist &&
            typeof window.flushTicketHubPersistedStateIfNeeded === 'function'
        ) {
            void window.flushTicketHubPersistedStateIfNeeded();
        }
        cancelHubPolygonDrawingIfDrawing();
        closeTicketHistoryModal();
        closeTicketHubMockModal();
        if (typeof window.closeAllCircleMenus === 'function') window.closeAllCircleMenus();
        if (typeof window.closeMapTopLeftLauncher === 'function') window.closeMapTopLeftLauncher();
        hideTicketHubDetailModal();
        if (typeof window.closeTicketHubCreateMenuModal === 'function') {
            window.closeTicketHubCreateMenuModal();
        }
        if (typeof window.closeTicketHubProjectDetailModal === 'function') {
            window.closeTicketHubProjectDetailModal();
        }
        if (typeof window.closeTicketHubFiltersModal === 'function') window.closeTicketHubFiltersModal();
        if (typeof window.closeTicketHubSearchModal === 'function') window.closeTicketHubSearchModal();
        if (typeof window.setTicketHubTitleUsanPollIndicator === 'function') {
            window.setTicketHubTitleUsanPollIndicator(false);
        }
        const win = document.getElementById('ticketHubWindow');
        if (win) {
            clearTicketHubMobileCloseState(win);
            win.classList.remove('show');
        }
        if (window.ticketHubDockModule && typeof window.ticketHubDockModule.onHubClosed === 'function') {
            window.ticketHubDockModule.onHubClosed();
        }
        if (typeof window.syncDataWindowStackAboveHub === 'function') {
            window.syncDataWindowStackAboveHub();
        }
        if (!options.preserveSelection) {
            selectedHubTicketId = null;
            hubPendingOpen = null;
        }
        hubBulkSelectedIds.clear();
        if (window.renderTickets) window.renderTickets();
        unregisterTicketHubBack(options.fromBack);
    }

    /**
     * @param {{ preserveImportedTickets?: object[] }} [opts]
     *   When Sync/import just created rows, pin them so a stale lean-list GET cannot hide them.
     */
    async function refreshTicketHubFromServer(opts) {
        if (!isTicketHubAccessible()) return;
        const preserve =
            opts && Array.isArray(opts.preserveImportedTickets) ? opts.preserveImportedTickets : null;
        if (window.ticketsModule && typeof window.ticketsModule.loadTicketsForCurrentOrg === 'function') {
            await window.ticketsModule.loadTicketsForCurrentOrg({
                forceRefresh: true,
                ...(preserve && preserve.length > 0 ? { preserveImportedTickets: preserve } : {}),
            });
        }
        if (window.renderTicketList) window.renderTicketList();
        if (window.renderTickets) window.renderTickets();
        await populateHubAssigneeFilter();
        if (typeof window.refreshProjectAssignmentIndex === 'function') {
            await window.refreshProjectAssignmentIndex({ force: true });
        }
        // forceRefresh clears hub slices (expired/combined/recently-opened); reload before paint
        // so Sync matches filter-change behavior and does not leave Expired/Total empty.
        try {
            if (
                window.ticketsModule &&
                typeof window.ticketsModule.loadHubTicketSliceForCurrentFilters === 'function'
            ) {
                await window.ticketsModule.loadHubTicketSliceForCurrentFilters({
                    pageDirection: 'first',
                    forceRefresh: true,
                });
            }
        } catch (e) {
            console.error('Ticket hub: reload slices after server refresh', e);
        }
        if (window.ticketsModule && typeof window.ticketsModule.hydrateHubTicketJobNames === 'function') {
            try {
                await window.ticketsModule.hydrateHubTicketJobNames();
            } catch (_e) {
                /* hydrateHubTicketJobNames already logs */
            }
        }
        refreshTicketHubWindow();
    }

    /**
     * Human-readable summary for the USAN list-sync result dialog.
     * @param {object|null|undefined} data
     * @returns {{ title: string, message: string }}
     */
    function formatUsanPollSyncSummary(data) {
        if (data && data.skipped) {
            if (data.reason === 'no_master_account') {
                return {
                    title: 'USAN account needed',
                    message: 'Add a USAN master account in Provider Accounts to sync tickets.',
                };
            }
            return {
                title: 'Sync skipped',
                message:
                    data.reason === 'poll_in_progress'
                        ? 'Another sync is already running. Try again in a moment.'
                        : `Sync was skipped (${data.reason || 'unknown reason'}).`,
            };
        }

        const imported = data && data.importedCount != null ? Number(data.importedCount) : 0;
        const refreshed = data && data.refreshedExistingCount != null ? Number(data.refreshedExistingCount) : 0;
        const newCount = Number.isFinite(imported) && imported > 0 ? imported : 0;
        const updatedCount = Number.isFinite(refreshed) && refreshed > 0 ? refreshed : 0;

        if (newCount === 0 && updatedCount === 0) {
            return { title: 'Sync complete', message: 'No new ticket updates' };
        }

        return {
            title: 'Sync complete',
            message: `${updatedCount} tickets updated. ${newCount} New tickets`,
        };
    }

    /**
     * POST /tickets/usan-poll — external SearchCurrentUserEnquiries, then import new request numbers.
     * Uses the org's last successful list-sync timestamp, capped to a 30-day lookback.
     */
    /**
     * @param {{ silent?: boolean }} [opts]
     */
    async function reloadTicketsFromUsanList(opts) {
        if (!isTicketHubAccessible()) return;
        if (!window.authModule) return;
        if (
            typeof window.isCurrentOrgPublicCatalogViewer === 'function' &&
            window.isCurrentOrgPublicCatalogViewer()
        ) {
            return;
        }
        if (window.offlineModule && window.offlineModule.guardOfflineAction && window.offlineModule.guardOfflineAction('Sync requires an internet connection.')) {
            return;
        }
        const silent = opts && opts.silent === true;
        let orgId = getHubOrganizationId();
        if (orgId != null && orgId !== '') {
            const n = parseInt(String(orgId), 10);
            if (Number.isFinite(n)) orgId = n;
        }
        if (orgId == null || orgId === '') {
            if (typeof window.appAlert === 'function') await window.appAlert('Select an organization first.');
            return;
        }
        const btn = document.getElementById('ticketHubUsanPollRefreshBtn');
        if (btn) {
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
        }
        try {
            const body = { organizationId: orgId, manual: true };
            /** @type {object} */
            let data;
            const streamPoll =
                typeof window.authModule.usanPollStream === 'function'
                    ? window.authModule.usanPollStream
                    : null;
            if (streamPoll) {
                data = await streamPoll('tickets/usan-poll', body);
            } else {
                data = await window.authModule.apiRequest('tickets/usan-poll', {
                    method: 'POST',
                    body: JSON.stringify(body),
                });
            }
            const summary = formatUsanPollSyncSummary(data);
            const pollTouched =
                window.ticketsModule &&
                window.ticketsModule.usanPollResultTouchedTickets &&
                window.ticketsModule.usanPollResultTouchedTickets(data);
            if (pollTouched) {
                const hubOrgNum = orgId != null && orgId !== '' ? Number(orgId) : NaN;
                const pinnedImports = Array.isArray(data && data.imported)
                    ? data.imported.filter(function (t) {
                          if (!t) return false;
                          if (t.organizationId == null || t.organizationId === '') return true;
                          if (!Number.isFinite(hubOrgNum)) return true;
                          return Number(t.organizationId) === hubOrgNum;
                      })
                    : [];
                await refreshTicketHubFromServer(
                    pinnedImports.length > 0 ? { preserveImportedTickets: pinnedImports } : undefined
                );
            } else {
                refreshTicketHubWindow();
                if (window.renderTickets) window.renderTickets();
                if (window.renderTicketList) window.renderTicketList();
            }
            if (!silent) {
                if (data && data.skipped === true && data.reason === 'no_master_account') {
                    if (typeof window.showToast === 'function') {
                        window.showToast(
                            'Add a USAN master account in Provider Accounts to sync tickets.',
                            'error'
                        );
                    } else if (typeof window.appAlert === 'function') {
                        await window.appAlert(summary.message, { title: summary.title });
                    }
                } else if (typeof window.appAlert === 'function') {
                    await window.appAlert(summary.message, { title: summary.title });
                }
            }
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            if (!silent && typeof window.appAlert === 'function') await window.appAlert(msg);
            else console.error(e);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.removeAttribute('aria-busy');
            }
        }
    }

    /**
     * Merge refreshed ticket from POST /tickets/refresh into the in-memory list and redraw the hub.
     * Keeps hub selection in sync when the server preserves ticket row id (or when we match by ticket number).
     * @param {object} ticket
     * @param {HTMLElement|null} triggerBtn
     * @param {{ silent?: boolean }} [opts] - When silent, no per-ticket alerts; returns `{ ok, message? }`.
     * @returns {Promise<{ ok: boolean, message?: string }|undefined>}
     */
    async function refreshHubTicketDetail(ticket, triggerBtn, opts) {
        const silent = opts && opts.silent === true;
        if (!isTicketHubAccessible()) {
            return silent ? { ok: false, message: 'Ticket hub is not available.' } : undefined;
        }
        if (!window.authModule || !ticket || ticket.ticketNumber == null || String(ticket.ticketNumber).trim() === '') {
            return silent ? { ok: false, message: 'Missing ticket or ticket number.' } : undefined;
        }
        let orgId = getTicketHubApiOrganizationId(ticket);
        if (orgId != null && orgId !== '') {
            const n = parseInt(String(orgId), 10);
            if (Number.isFinite(n)) orgId = n;
        }
        if (orgId == null || orgId === '') {
            if (!silent && typeof window.appAlert === 'function') await window.appAlert('Select an organization first.');
            return silent ? { ok: false, message: 'Select an organization first.' } : undefined;
        }
        const prevSelId = selectedHubTicketId;
        const tnRefresh = String(ticket.ticketNumber).trim();
        const forceRefresh = !!(opts && opts.forceRefresh);
        const popupOpen = !!(opts && opts.popupOpen);
        if (
            !forceRefresh &&
            window.ticketsModule &&
            typeof window.ticketsModule.isTicketPopupOpenRefreshCoopLocked === 'function' &&
            window.ticketsModule.isTicketPopupOpenRefreshCoopLocked(ticket)
        ) {
            return silent ? { ok: true } : undefined;
        }
        if (window.ticketsModule && typeof window.ticketsModule.setTicketSelectionRefreshLoading === 'function') {
            window.ticketsModule.setTicketSelectionRefreshLoading(tnRefresh, true);
        }
        if (triggerBtn && triggerBtn.closest) {
            triggerBtn.disabled = true;
            triggerBtn.setAttribute('aria-busy', 'true');
        }
        try {
            const refreshCtx =
                typeof window.getTicketRefreshRequestContext === 'function'
                    ? window.getTicketRefreshRequestContext(ticket)
                    : { organizationId: orgId, viewerOrganizationId: orgId };
            const data = await window.authModule.apiRequest('tickets/refresh', {
                method: 'POST',
                body: JSON.stringify({
                    ticketNumber: String(ticket.ticketNumber).trim(),
                    refreshMode: 'lite',
                    ...(forceRefresh ? { forceRefresh: true } : {}),
                    ...(popupOpen ? { popupOpen: true } : {}),
                    organizationId: refreshCtx.organizationId != null ? refreshCtx.organizationId : orgId,
                    ...(refreshCtx.viewerOrganizationId != null
                        ? { viewerOrganizationId: refreshCtx.viewerOrganizationId }
                        : {}),
                })
            });
            const fresh = data && data.ticket;
            if (!fresh) {
                const m = 'Refresh returned no ticket data.';
                if (!silent && typeof window.appAlert === 'function') await window.appAlert(m);
                return silent ? { ok: false, message: m } : undefined;
            }
            if (typeof upsertRefreshedTicketIntoLocalCollections === 'function') {
                upsertRefreshedTicketIntoLocalCollections(fresh);
            } else {
                const list = window.ORG_TICKETS || [];
                const idx = list.findIndex(
                    t =>
                        idsMatch(t.id, ticket.id) ||
                        String(t.ticketNumber) === String(fresh.ticketNumber) ||
                        String(t.ticketNumber) === String(ticket.ticketNumber)
                );
                if (idx >= 0) {
                    list[idx] = fresh;
                    if (window.ticketsModule && typeof window.ticketsModule.applyTicketStatusFromImporter === 'function') {
                        window.ticketsModule.applyTicketStatusFromImporter(list[idx]);
                    }
                } else {
                    list.push(fresh);
                    if (window.ticketsModule && typeof window.ticketsModule.applyTicketStatusFromImporter === 'function') {
                        window.ticketsModule.applyTicketStatusFromImporter(list[list.length - 1]);
                    }
                }
            }
            if (idsMatch(prevSelId, ticket.id) || idsMatch(prevSelId, fresh.id)) {
                selectedHubTicketId = fresh.id;
            }
            redrawIfOpen();
            if (window.renderTickets) window.renderTickets();
            if (window.renderTicketList) window.renderTicketList();
            if (window.ticketsModule && typeof window.ticketsModule.refreshTicketsOrgCacheSnapshot === 'function') {
                window.ticketsModule.refreshTicketsOrgCacheSnapshot(orgId);
            }
            return silent ? { ok: true } : undefined;
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            if (!silent && typeof window.appAlert === 'function') await window.appAlert(msg);
            else console.error(e);
            return silent ? { ok: false, message: msg } : undefined;
        } finally {
            if (window.ticketsModule && typeof window.ticketsModule.setTicketSelectionRefreshLoading === 'function') {
                window.ticketsModule.setTicketSelectionRefreshLoading(tnRefresh, false);
            }
            if (triggerBtn && triggerBtn.closest) {
                triggerBtn.disabled = false;
                triggerBtn.removeAttribute('aria-busy');
            }
        }
    }

    /**
     * POST /tickets/refresh for each selected non-shared ticket (sequential). Checkbox selection only.
     * @param {Set<string>|Iterable<string>} selectedIds - Hub row ids (`hubBulkSelectedIds`).
     * @param {HTMLButtonElement|null} triggerBtn
     */
    async function refreshHubTicketsBulk(selectedIds, triggerBtn) {
        if (!isTicketHubAccessible()) return;
        const ids = selectedIds && typeof selectedIds.size === 'number' ? Array.from(selectedIds) : Array.from(selectedIds || []);
        if (ids.length === 0) {
            if (typeof window.appAlert === 'function') void window.appAlert('Select at least one ticket using the checkboxes.');
            return;
        }
        const tickets = ids.map(id => findTicketForHub(id)).filter(Boolean);
        const refreshable = tickets.filter(
            t =>
                t.ticketNumber != null &&
                String(t.ticketNumber).trim() !== '' &&
                !isHubTicketExternalForOrg(t)
        );
        if (refreshable.length === 0) {
            if (typeof window.appAlert === 'function') {
                let msg = 'No matching tickets for the selection.';
                if (tickets.length > 0) {
                    const allExternal = tickets.every(t => t && isHubTicketExternalForOrg(t));
                    const allMissingNum = tickets.every(
                        t => !t || t.ticketNumber == null || String(t.ticketNumber).trim() === ''
                    );
                    if (allExternal) {
                        msg =
                            'External tickets cannot be bulk-refreshed here. Use single-ticket refresh in hub detail or the map popup.';
                    } else if (allMissingNum) {
                        msg = 'Selected tickets need a ticket number to refresh.';
                    } else {
                        msg = 'None of the selected tickets can be refreshed (external or missing ticket number).';
                    }
                }
                void window.appAlert(msg);
            }
            return;
        }
        const skippedShared = tickets.length - refreshable.length;
        if (triggerBtn) {
            triggerBtn.disabled = true;
            triggerBtn.setAttribute('aria-busy', 'true');
        }
        const failures = [];
        try {
            for (let i = 0; i < refreshable.length; i++) {
                const t = refreshable[i];
                const res = await refreshHubTicketDetail(t, null, { silent: true });
                if (res && res.ok === false && res.message) {
                    failures.push(`${t.ticketNumber || t.id}: ${res.message}`);
                }
            }
        } finally {
            if (triggerBtn) {
                triggerBtn.disabled = false;
                triggerBtn.removeAttribute('aria-busy');
            }
        }
        const okCount = refreshable.length - failures.length;
        let summary = `Refreshed ${okCount} of ${refreshable.length} ticket(s).`;
        if (skippedShared > 0) summary += ` Skipped ${skippedShared} shared ticket(s).`;
        if (failures.length > 0) {
            summary += '\n\nFailed:\n' + failures.slice(0, 10).join('\n');
            if (failures.length > 10) summary += '\n—';
        }
        if (typeof window.appAlert === 'function') await window.appAlert(summary);
    }

    window.openTicketHubWindow = openTicketHubWindow;
    window.toggleTicketHubWindow = toggleTicketHubWindow;
    window.closeTicketHubWindow = closeTicketHubWindow;
    window.ensureDesktopTicketHubOpen = ensureDesktopTicketHubOpen;
    window.closeTicketHubDetailModal = closeTicketHubDetailModal;
    window.reloadTicketsFromUsanList = reloadTicketsFromUsanList;
    window.onTicketHubFilterChange = onHubFilterChange;
    window.clearTicketHubSearchPolygon = clearTicketHubSearchPolygon;

    window.ticketHubModule = {
        open: openTicketHubWindow,
        toggle: toggleTicketHubWindow,
        close: closeTicketHubWindow,
        refresh: refreshTicketHubFromServer,
        reloadFromUsanList: reloadTicketsFromUsanList,
        reloadFromPacweb: reloadTicketsFromUsanList,
        refreshTicketDetail: refreshHubTicketDetail,
        renderDetail: renderHubDetail,
        selectRow: hubSelectRow,
        beginPendingOpen: beginHubPendingOpen,
        failPendingOpen: failHubPendingOpen,
        clearPendingOpen: clearHubPendingOpen,
        selectFeedTicketDetail: hubSelectFeedTicketDetail,
        handleTicketDeleted: handleTicketDeleted,
        redrawIfOpen: redrawIfOpen,
        clearSearchPolygon: clearTicketHubSearchPolygon,
        cancelPolygonDrawingIfActive: cancelHubPolygonDrawingIfDrawing,
        /** Same ticket set as the hub table (for map while hub is open). */
        getFilteredTicketsForMap: function () {
            return typeof window.getFilteredTicketsForHub === 'function' ? window.getFilteredTicketsForHub() : [];
        },
        resetFilters: function () {
            if (typeof window.resetTicketHubFilters === 'function') window.resetTicketHubFilters();
        },
        canAccessTicketHub: isTicketHubAccessible,
        isHubTicketExternalForOrg,
        recordView: recordTicketHubView
    };

    (function initHubStatClicks() {
        const statsEl = document.getElementById('ticketHubStats');
        if (statsEl) statsEl.addEventListener('click', onHubStatCardClick);
        const mapStatsEl = document.getElementById('mapStatusFiltersStats');
        if (mapStatsEl) {
            mapStatsEl.addEventListener('click', onHubStatCardClick);
            mapStatsEl.addEventListener('contextmenu', onHubStatCardContextMenu);
        }
        const fanCardsEl = document.getElementById('mapTopLeftStatFilterCards');
        if (fanCardsEl) {
            fanCardsEl.addEventListener('click', onHubStatCardClick);
            fanCardsEl.addEventListener('contextmenu', onHubStatCardContextMenu);
            fanCardsEl.addEventListener('pointerdown', onHubStatCardPointerDown);
            fanCardsEl.addEventListener('pointermove', onHubStatCardPointerMove);
            fanCardsEl.addEventListener('pointerup', onHubStatCardPointerUp);
            fanCardsEl.addEventListener('pointercancel', onHubStatCardPointerCancel);
        }
    })();

    (function initMapStatusBarControls() {
        const filtersBtn = document.getElementById('mapStatusFiltersBtn');
        if (filtersBtn) {
            filtersBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (typeof window.toggleMapStatusDropdown === 'function') {
                    window.toggleMapStatusDropdown('filters');
                }
            });
        }
        const bar = document.getElementById('mapStatusFilters');
        if (bar) {
            // Clicks inside the bar/dropdowns should not close the open dropdown.
            bar.addEventListener('click', function (e) {
                e.stopPropagation();
            });
        }
        document.addEventListener('click', function () {
            if (typeof window.closeMapStatusDropdowns === 'function') window.closeMapStatusDropdowns();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (typeof window.closeMapStatusDropdowns === 'function') window.closeMapStatusDropdowns();
        });
        let relocateTimer = null;
        window.addEventListener('resize', function () {
            if (relocateTimer) clearTimeout(relocateTimer);
            relocateTimer = setTimeout(function () {
                if (typeof window.closeMapStatusDropdowns === 'function') window.closeMapStatusDropdowns();
                if (typeof window.relocateTicketHubFilterControls === 'function') {
                    window.relocateTicketHubFilterControls();
                }
                if (typeof window.syncHubMobileFilterConstraints === 'function') {
                    window.syncHubMobileFilterConstraints();
                }
            }, 150);
        });
    })();

    (function initTicketHubMapAreaButtons() {
        const draw = document.getElementById('ticketHubDrawSearchArea');
        const clearBtn = document.getElementById('ticketHubClearSearchArea');
        if (draw) draw.addEventListener('click', startTicketHubPolygonDrawing);
        if (clearBtn) clearBtn.addEventListener('click', clearTicketHubSearchPolygon);
    })();

    if (
        window.ticketHubColumnRegistry &&
        typeof window.ticketHubColumnRegistry.initPicker === 'function'
    ) {
        window.ticketHubColumnRegistry.initPicker();
    }

    (function initTicketHubMobileControls() {
        const heightGrab = document.getElementById('ticketHubMobileHeightGrab');
        if (heightGrab && !heightGrab.dataset.bound) {
            heightGrab.dataset.bound = '1';
            heightGrab.addEventListener('click', function (e) {
                e.stopPropagation();
                if (typeof window.toggleTicketHubMobileHeight === 'function') {
                    window.toggleTicketHubMobileHeight();
                }
            });
        }
        const advancedToggle = document.getElementById('ticketHubFiltersAdvancedToggle');
        if (advancedToggle && !advancedToggle.dataset.bound) {
            advancedToggle.dataset.bound = '1';
            advancedToggle.addEventListener('click', function (e) {
                e.stopPropagation();
                if (typeof window.toggleHubMobileAdvancedFilters === 'function') {
                    window.toggleHubMobileAdvancedFilters();
                }
            });
        }
        if (typeof window.syncHubMobileFilterConstraints === 'function') {
            window.syncHubMobileFilterConstraints();
        }
        /* MOBILE_HUB_DETAIL_SHEET_DISABLED — set TICKET_HUB_MOBILE_DETAIL_SHEET_ENABLED = true to restore.
        const detailHeightToggle = document.getElementById('ticketHubDetailMobileHeightToggle');
        if (detailHeightToggle && !detailHeightToggle.dataset.bound) {
            detailHeightToggle.dataset.bound = '1';
            detailHeightToggle.addEventListener('click', function (e) {
                e.stopPropagation();
                if (typeof window.toggleTicketHubDetailMobileHeight === 'function') {
                    window.toggleTicketHubDetailMobileHeight();
                }
            });
        }
        */
    })();

    /* MOBILE_HUB_DETAIL_SHEET_DISABLED — set TICKET_HUB_MOBILE_DETAIL_SHEET_ENABLED = true to restore.
    (function initTicketHubDetailModalBackdrop() {
        const modal = document.getElementById('ticketHubDetailModal');
        if (!modal || modal.dataset.backdropInit) return;
        modal.dataset.backdropInit = '1';
        const backdrop = modal.querySelector('.ticket-hub-detail-modal-backdrop');
        if (backdrop) {
            backdrop.addEventListener('click', function () {
                closeTicketHubDetailModal();
            });
        }
    })();
    */

    function syncTicketHubRenewButtonVisibility() {
        const renew = document.getElementById('ticketHubBulkRenew');
        if (!renew) return;
        const show =
            typeof window.isTicketRenewalHubEnabled === 'function' && window.isTicketRenewalHubEnabled();
        renew.hidden = !show;
    }
    window.syncTicketHubRenewButtonVisibility = syncTicketHubRenewButtonVisibility;

    function syncTicketHubBulkDeleteVisibility() {
        const del = document.getElementById('ticketHubBulkDelete');
        if (!del) return;
        const show = window.authModule && window.authModule.isDev && window.authModule.isDev();
        del.hidden = !show;
    }
    window.syncTicketHubBulkDeleteVisibility = syncTicketHubBulkDeleteVisibility;

    (function initTicketHubBulkBar() {
        const hubWin = document.getElementById('ticketHubWindow');
        if (hubWin && !hubWin.dataset.bulkChangeBound) {
            hubWin.dataset.bulkChangeBound = '1';
            hubWin.addEventListener('change', function (e) {
                const input = e.target;
                if (!input || input.tagName !== 'INPUT' || input.type !== 'checkbox') return;
                if (input.classList.contains('ticket-hub-bulk-select-all')) {
                    e.stopPropagation();
                    const filtered = getFilteredTicketsForHub();
                    const selectable = hubBulkSelectableTickets(filtered);
                    if (input.checked) {
                        selectable.forEach(t => hubBulkSelectedIds.add(String(t.id)));
                    } else {
                        selectable.forEach(t => hubBulkSelectedIds.delete(String(t.id)));
                    }
                    renderHubTable();
                    updateTicketHubBulkBar();
                    return;
                }
                if (!input.classList.contains('ticket-hub-bulk-cb')) return;
                const ticketId = input.getAttribute('data-ticket-id');
                if (!ticketId) return;
                e.stopPropagation();
                if (input.checked) hubBulkSelectedIds.add(String(ticketId));
                else hubBulkSelectedIds.delete(String(ticketId));
                updateTicketHubBulkBar();
                syncHubBulkSelectAllCheckbox();
            });
        }
        const clearBtn = document.getElementById('ticketHubBulkClear');
        if (clearBtn) {
            clearBtn.addEventListener('click', function (e) {
                e.preventDefault();
                hubBulkSelectedIds.clear();
                renderHubTable();
                updateTicketHubBulkBar();
            });
        }
        const renew = document.getElementById('ticketHubBulkRenew');
        if (renew) {
            renew.addEventListener('click', function (e) {
                e.preventDefault();
                if (hubBulkSelectedIds.size === 0) {
                    if (typeof window.appAlert === 'function') void window.appAlert('Select at least one ticket using the checkboxes.');
                    return;
                }
                void openTicketHubBulkRenewWithFreshPaintChoice(Array.from(hubBulkSelectedIds));
            });
        }
        const siteDoc = document.getElementById('ticketHubBulkSiteDoc');
        if (siteDoc) {
            siteDoc.addEventListener('click', function (e) {
                e.preventDefault();
                if (hubBulkSelectedIds.size === 0) {
                    if (typeof window.appAlert === 'function') void window.appAlert('Select at least one ticket using the checkboxes.');
                    return;
                }
                void requestHubBulkSiteDocumentation(Array.from(hubBulkSelectedIds), siteDoc);
            });
        }
        const bulkRefresh = document.getElementById('ticketHubBulkRefresh');
        if (bulkRefresh) {
            bulkRefresh.addEventListener('click', function (e) {
                e.preventDefault();
                if (hubBulkSelectedIds.size === 0) {
                    if (typeof window.appAlert === 'function') void window.appAlert('Select at least one ticket using the checkboxes.');
                    return;
                }
                void refreshHubTicketsBulk(hubBulkSelectedIds, bulkRefresh);
            });
        }
        const bulkDelete = document.getElementById('ticketHubBulkDelete');
        if (bulkDelete) {
            bulkDelete.addEventListener('click', function (e) {
                e.preventDefault();
                if (hubBulkSelectedIds.size === 0) {
                    if (typeof window.appAlert === 'function') void window.appAlert('Select at least one ticket using the checkboxes.');
                    return;
                }
                void deleteHubBulkSelectedTickets(Array.from(hubBulkSelectedIds), bulkDelete);
            });
        }
        syncTicketHubBulkDeleteVisibility();
        if (typeof window.syncTicketHubAnalyticsTabVisibility === 'function') {
            window.syncTicketHubAnalyticsTabVisibility();
        }
    })();

    /** Shared with map sidebar ticket popup (`js/tickets/`) for operator directory phones. */
    window.operatorDirectoryPhones = {
        extractPhoneNumbersFromNameWithPhones,
        findDirectoryEntryForResponse: findHubDirectoryEntryForResponse,
        loadDirectoryMap: loadHubOperatorDirectoryMap
    };
    /** Same operator response + directory modal as Ticket Hub (station code / name links). */
    window.openHubOperatorResponseDetailModal = openHubOperatorResponseDetailModal;
    /** Response code description + date modal (map ticket popup response code links). */
    window.openHubResponseCodeDetailModal = openHubResponseCodeDetailModal;
    /** Per-operator status explanation modal (status indicator clicks). */
    window.openOperatorResponseStatusModal = openOperatorResponseStatusModal;

    let hubLayoutResizeTimer;
    window.addEventListener('resize', function () {
        clearTimeout(hubLayoutResizeTimer);
        hubLayoutResizeTimer = setTimeout(function () {
            // Compact chip labels change at 1180; phone table cols / column picker at 768.
            if (typeof window.renderHubStats === 'function') window.renderHubStats();
            syncTicketHubOpenForViewport();
            const win = document.getElementById('ticketHubWindow');
            if (!win || !win.classList.contains('show')) return;
            if (typeof window.relocateTicketHubFiltersPack === 'function') window.relocateTicketHubFiltersPack();
            renderHubTable();
            renderHubDetail();
        }, 200);
    });

    function syncTicketHubOpenForViewport() {
        if (typeof isTicketHubMobile === 'function' && isTicketHubMobile()) {
            const win = document.getElementById('ticketHubWindow');
            if (
                win &&
                win.classList.contains('show') &&
                !win.classList.contains('ticket-hub-mobile-halfway') &&
                !win.classList.contains('ticket-hub-mobile-full')
            ) {
                closeTicketHubWindow({ skipPersist: true });
            }
            return;
        }
        if (typeof window.ensureDesktopTicketHubOpen === 'function') {
            void window.ensureDesktopTicketHubOpen();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', syncTicketHubOpenForViewport);
    } else {
        syncTicketHubOpenForViewport();
    }

