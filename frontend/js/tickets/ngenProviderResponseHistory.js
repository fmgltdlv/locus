/**
 * Lazy nGen GetNotificationResponseHistoryAsync for popup / hub operator comments.
 * Dedupes in-flight POSTs per orgId:ticketNumber (full + per-authority share one base key).
 */
(function (global) {
    'use strict';

    const SYNC_LANE_POSR_PUBLIC = 'posr_public';

    /** @type {Map<string, Promise<object|null>>} */
    const inFlightPromises = new Map();

    function isNvPublicImportTicket(ticket) {
        if (!ticket) return false;
        const src = ticket.source != null ? String(ticket.source).trim() : '';
        if (src === 'nv_api' || src === 'nv_api_cache') return true;
        const lane = ticket.syncLane != null ? String(ticket.syncLane).trim().toLowerCase() : '';
        return lane === SYNC_LANE_POSR_PUBLIC;
    }

    function isNgenTicket(ticket) {
        if (!ticket) return false;
        return (
            (typeof global.isNgenPrimarySyncedTicket === 'function' && global.isNgenPrimarySyncedTicket(ticket)) ||
            (ticket.ngenJobNumber != null && String(ticket.ngenJobNumber).trim() !== '')
        );
    }

    /** Resolvable nGen enquiry/job id — required before auto history POST. */
    function resolveTicketNgenJobNumber(ticket) {
        if (!ticket) return null;
        if (typeof global.getUsanEnquiryIdFromTicket === 'function') {
            const fromUtil = global.getUsanEnquiryIdFromTicket(ticket);
            if (fromUtil != null && String(fromUtil).trim() !== '') {
                const n = Number(String(fromUtil).trim());
                if (Number.isFinite(n)) return n;
            }
        }
        for (const key of ['ngenJobNumber', 'providerJobNumber', 'jobNumber']) {
            if (ticket[key] == null || String(ticket[key]).trim() === '') continue;
            const n = Number(String(ticket[key]).trim());
            if (Number.isFinite(n)) return n;
        }
        return null;
    }

    function operatorResponseRows(ticket) {
        const mod = global.ticketsModule;
        if (mod && typeof mod.ticketOperatorResponseRowsForDisplay === 'function') {
            return mod.ticketOperatorResponseRowsForDisplay(ticket) || [];
        }
        return Array.isArray(ticket && ticket.operatorResponses) ? ticket.operatorResponses : [];
    }

    /** Authority ids from operator rows (stable order for request bodies). */
    function collectOperatorAuthorityIds(ticket) {
        const ids = [];
        const seen = new Set();
        const rows = operatorResponseRows(ticket);
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (!r || r.authorityId == null) continue;
            const aid = String(r.authorityId).trim();
            if (!aid || seen.has(aid)) continue;
            seen.add(aid);
            ids.push(aid);
        }
        return ids;
    }

    /** At least one operator row with authorityId — required before USAN history fetch. */
    function ticketHasOperatorAuthoritiesForHistory(ticket) {
        return collectOperatorAuthorityIds(ticket).length > 0;
    }

    /** Operator rows hydrated enough to attempt history (fixes early fetch before db-detail). */
    function ticketOperatorAuthoritiesReady(ticket) {
        if (!ticket) return false;
        const mod = global.ticketsModule;
        if (mod && typeof mod.canShowTicketOperatorResponsesNow === 'function') {
            if (!mod.canShowTicketOperatorResponsesNow(ticket)) return false;
        }
        return ticketHasOperatorAuthoritiesForHistory(ticket);
    }

    function isTechReadOnlyOrgUser() {
        return (
            global.authModule &&
            typeof global.authModule.isTechInCurrentOrg === 'function' &&
            global.authModule.isTechInCurrentOrg()
        );
    }

    function isHistoryFetchForbiddenError(err) {
        if (!err) return false;
        const status = err.status != null ? Number(err.status) : err.statusCode != null ? Number(err.statusCode) : NaN;
        if (status === 403 || status === 401) return true;
        const msg = err.message != null ? String(err.message).toLowerCase() : '';
        return msg.includes('403') || msg.includes('forbidden') || msg.includes('access denied');
    }

    /** Expected not-ready / credentials messages — do not spam console or retry in a loop. */
    function isHistoryFetchExpectedUnavailableError(err) {
        if (!err) return false;
        const status = err.status != null ? Number(err.status) : err.statusCode != null ? Number(err.statusCode) : NaN;
        const msg = err.message != null ? String(err.message).toLowerCase() : '';
        const code =
            err.errorCode != null
                ? String(err.errorCode)
                : err.code != null
                  ? String(err.code)
                  : err.error != null
                    ? String(err.error)
                    : '';
        if (code === 'NGEN_HISTORY_CREDENTIALS_MISSING' || msg.includes('ngen_history_credentials_missing')) {
            return true;
        }
        if (status !== 400 && status !== 200) return false;
        return (
            msg.includes('no ngen job number') ||
            msg.includes('no utility authority') ||
            msg.includes('ticket history is unavailable')
        );
    }

    function markTicketHistoryUnavailable(tn, ticket) {
        const updated = setProviderHistoryStatusOnTicket(tn, 'unavailable');
        if (!updated && ticket) ticket.ngenResponseHistoryStatus = 'unavailable';
        return updated || ticket;
    }

    function ticketHasCachedProviderHistory(ticket) {
        const history = ticket && (ticket.providerResponseHistory || ticket.ngenResponseHistory);
        const utils =
            history && history.normalized && Array.isArray(history.normalized.utilities)
                ? history.normalized.utilities
                : null;
        return !!(utils && utils.length > 0);
    }

    function ticketPoolsForHistoryStatus() {
        return [
            global.ORG_TICKETS,
            global.HUB_RECENTLY_OPENED_TICKETS,
            global.HUB_EXPIRED_TICKETS,
            global.HUB_COMBINED_TICKETS,
            global.HUB_ACTIVE_TICKETS,
        ];
    }

    function findTicketInOrgList(tn) {
        const needle = tn != null ? String(tn).trim() : '';
        if (!needle) return null;
        const pools = ticketPoolsForHistoryStatus();
        for (let i = 0; i < pools.length; i++) {
            const list = pools[i];
            if (!Array.isArray(list)) continue;
            const found = list.find(
                (t) => t && t.ticketNumber != null && String(t.ticketNumber).trim() === needle
            );
            if (found) return found;
        }
        return null;
    }

    function setProviderHistoryStatusOnTicket(tn, status) {
        const needle = tn != null ? String(tn).trim() : '';
        if (!needle) return null;
        let found = null;
        const pools = ticketPoolsForHistoryStatus();
        for (let i = 0; i < pools.length; i++) {
            const list = pools[i];
            if (!Array.isArray(list)) continue;
            const idx = list.findIndex(
                (t) => t && t.ticketNumber != null && String(t.ticketNumber).trim() === needle
            );
            if (idx < 0) continue;
            list[idx] = { ...list[idx], ngenResponseHistoryStatus: status };
            found = list[idx];
        }
        return found;
    }

    /**
     * After db-detail hydrate: clear stale loading when D1 cache is on the ticket.
     * @param {object|null|undefined} ticket
     */
    function syncProviderHistoryStatusFromHydratedTicket(ticket) {
        if (!ticket || ticket.ticketNumber == null) return ticket;
        const tn = String(ticket.ticketNumber).trim();
        if (!tn || !ticketHasCachedProviderHistory(ticket)) return ticket;

        const tipsApi = global.ngenHistoryTips;
        const history = ticket.providerResponseHistory || ticket.ngenResponseHistory;
        const tipsMatch =
            history &&
            tipsApi &&
            typeof tipsApi.ngenResponseHistoryTipsMatchTicket === 'function' &&
            tipsApi.ngenResponseHistoryTipsMatchTicket(
                history,
                ticket.operatorResponses,
                ticket.ticketNumberFull || ticket.ticketNumber
            );

        const baseKey = baseHistoryCacheKey(ticket);
        const fetchInFlight = inFlightPromises.has(baseKey);

        if (tipsMatch || !fetchInFlight || ticket.ngenResponseHistoryStatus === 'loading') {
            const updated = setProviderHistoryStatusOnTicket(tn, 'loaded');
            return updated || ticket;
        }
        return ticket;
    }

    /**
     * True when USAN notification history should be fetched (tips stale or missing).
     * @param {object|null|undefined} ticket
     * @returns {boolean}
     */
    function ticketNeedsNgenProviderHistoryFetch(ticket) {
        if (!ticket || ticket.ticketNumber == null || String(ticket.ticketNumber).trim() === '') return false;
        if (!global.authModule || !global.authModule.isAuthenticated()) return false;
        if (isNvPublicImportTicket(ticket)) return false;
        if (!isNgenTicket(ticket)) return false;
        // syncLane alone is not enough — USAN history needs a resolvable enquiry id.
        if (resolveTicketNgenJobNumber(ticket) == null) return false;
        if (!ticketOperatorAuthoritiesReady(ticket)) return false;
        if (isTechReadOnlyOrgUser()) return false;
        // Soft-skip / hard-fail: wait for a later refresh to replace the ticket object.
        const status = ticket.ngenResponseHistoryStatus;
        if (status === 'unavailable' || status === 'error') return false;
        // Prevent hub/popup redraw → schedule → redraw loops while a POST is already running.
        if (status === 'loading') return false;
        if (anyInFlightHistoryPromiseForTicket(ticket)) return false;

        const history = ticket.providerResponseHistory || ticket.ngenResponseHistory;
        const tipsApi = global.ngenHistoryTips;
        if (
            history &&
            tipsApi &&
            typeof tipsApi.ngenResponseHistoryTipsMatchTicket === 'function' &&
            tipsApi.ngenResponseHistoryTipsMatchTicket(
                history,
                ticket.operatorResponses,
                ticket.ticketNumberFull || ticket.ticketNumber
            )
        ) {
            return false;
        }
        return true;
    }

    function isNgenProviderResponseHistoryLoadPending(ticket) {
        if (!ticket || ticket.ngenResponseHistoryStatus !== 'loading') return false;
        if (ticketHasCachedProviderHistory(ticket)) return false;
        return true;
    }

    function baseHistoryCacheKey(ticket) {
        const refreshCtx =
            typeof global.getTicketRefreshRequestContext === 'function'
                ? global.getTicketRefreshRequestContext(ticket)
                : { organizationId: null };
        const orgId = refreshCtx.organizationId != null ? refreshCtx.organizationId : '';
        const tn = ticket && ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
        return `${orgId}:${tn}`;
    }

    function historyCacheKey(ticket, authorityIds) {
        const base = baseHistoryCacheKey(ticket);
        const aids =
            authorityIds && authorityIds.length
                ? authorityIds
                      .map((a) => String(a).trim())
                      .filter(Boolean)
                      .sort()
                      .join(',')
                : '';
        return aids ? `${base}:aids=${aids}` : base;
    }

    function mergeHistoryOntoTicket(tn, ticket, history) {
        const needle = tn != null ? String(tn).trim() : '';
        const patch = {
            ...(history ? { ngenResponseHistory: history, providerResponseHistory: history } : {}),
            ngenResponseHistoryStatus: 'loaded',
        };
        let found = null;
        if (needle) {
            const pools = ticketPoolsForHistoryStatus();
            for (let i = 0; i < pools.length; i++) {
                const list = pools[i];
                if (!Array.isArray(list)) continue;
                const idx = list.findIndex(
                    (t) => t && t.ticketNumber != null && String(t.ticketNumber).trim() === needle
                );
                if (idx < 0) continue;
                list[idx] = { ...list[idx], ...patch };
                found = list[idx];
            }
        }
        if (found) return found;
        if (ticket) {
            if (history) {
                ticket.ngenResponseHistory = history;
                ticket.providerResponseHistory = history;
            }
            ticket.ngenResponseHistoryStatus = 'loaded';
        }
        return ticket;
    }

    function markTicketHistoryLoading(ticket) {
        if (!ticket || ticket.ticketNumber == null) return;
        const tn = String(ticket.ticketNumber).trim();
        if (ticketHasCachedProviderHistory(ticket)) return;
        const updated = setProviderHistoryStatusOnTicket(tn, 'loading');
        if (!updated) ticket.ngenResponseHistoryStatus = 'loading';
    }

    function ticketNumberFromHistoryCacheKey(key) {
        const withoutAids = String(key || '').split(':aids=')[0];
        const colon = withoutAids.indexOf(':');
        return colon >= 0 ? withoutAids.slice(colon + 1) : withoutAids;
    }

    function anyInFlightHistoryPromiseForTicket(ticket) {
        const tn = ticket && ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
        if (!tn) return false;
        if (resolveInFlightHistoryPromise(ticket, null)) return true;
        for (const key of inFlightPromises.keys()) {
            if (ticketNumberFromHistoryCacheKey(key) === tn) return true;
        }
        return false;
    }

    function resolveInFlightHistoryPromise(ticket, authorityIds) {
        const baseKey = baseHistoryCacheKey(ticket);
        if (inFlightPromises.has(baseKey)) {
            return inFlightPromises.get(baseKey);
        }
        if (authorityIds && authorityIds.length) {
            const partialKey = historyCacheKey(ticket, authorityIds);
            if (inFlightPromises.has(partialKey)) {
                return inFlightPromises.get(partialKey);
            }
        }
        const tn = ticket && ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
        if (tn) {
            for (const [key, promise] of inFlightPromises) {
                if (ticketNumberFromHistoryCacheKey(key) === tn) return promise;
            }
        }
        return null;
    }

    /**
     * POST /tickets/:tn/ngen-notification-history (deduped).
     * @param {object} ticket
     * @param {{ authorityIds?: string[], silent?: boolean, _deferredRetry?: boolean }} [opts]
     * @returns {Promise<object|null>}
     */
    async function ensureNgenProviderResponseHistoryLoaded(ticket, opts) {
        const options = opts || {};
        if (!ticket || ticket.ticketNumber == null) return ticket;
        const tn = String(ticket.ticketNumber).trim();
        if (!tn) return ticket;

        const authorityIds =
            options.authorityIds && options.authorityIds.length
                ? options.authorityIds.map((a) => String(a).trim()).filter(Boolean)
                : null;

        // Background schedule gates on ticketOperatorAuthoritiesReady; explicit callers
        // (e.g. History modal) may POST without client-side authorityIds — server resolves from D1.

        if (isTechReadOnlyOrgUser()) {
            if (ticketHasCachedProviderHistory(ticket)) {
                setProviderHistoryStatusOnTicket(tn, 'loaded');
            }
            return findTicketInOrgList(tn) || ticket;
        }

        const tipsApi = global.ngenHistoryTips;
        const existing = ticket.providerResponseHistory || ticket.ngenResponseHistory;

        if (
            !authorityIds &&
            existing &&
            tipsApi &&
            typeof tipsApi.ngenResponseHistoryTipsMatchTicket === 'function' &&
            tipsApi.ngenResponseHistoryTipsMatchTicket(
                existing,
                ticket.operatorResponses,
                ticket.ticketNumberFull || ticket.ticketNumber
            )
        ) {
            setProviderHistoryStatusOnTicket(tn, 'loaded');
            return findTicketInOrgList(tn) || ticket;
        }

        if (!global.authModule || !global.authModule.isAuthenticated()) return ticket;

        const inFlight = resolveInFlightHistoryPromise(ticket, authorityIds);
        if (inFlight) {
            return inFlight;
        }

        const cacheKey = historyCacheKey(ticket, authorityIds);

        const refreshCtx =
            typeof global.getTicketRefreshRequestContext === 'function'
                ? global.getTicketRefreshRequestContext(ticket)
                : { organizationId: null, viewerOrganizationId: null };
        const jobNum = resolveTicketNgenJobNumber(ticket);
        // On deferred retry after lite-persist race, send authority ids so the server can
        // fetch even when D1 operator tips are still empty.
        const authorityIdsForBody =
            authorityIds && authorityIds.length
                ? authorityIds
                : options._deferredRetry
                  ? collectOperatorAuthorityIds(ticket)
                  : null;
        const body = {
            ...(refreshCtx.organizationId != null ? { organizationId: refreshCtx.organizationId } : {}),
            ...(refreshCtx.viewerOrganizationId != null ? { viewerOrganizationId: refreshCtx.viewerOrganizationId } : {}),
            ...(jobNum != null ? { ngenJobNumber: jobNum } : {}),
            ...(authorityIdsForBody && authorityIdsForBody.length ? { authorityIds: authorityIdsForBody } : {}),
        };

        // Register before any redraw: hub renderHubDetail re-schedules history, and that
        // re-entry must see this promise or it stacks until Maximum call stack size exceeded.
        let settleInFlight;
        const promise = new Promise((resolve, reject) => {
            settleInFlight = { resolve, reject };
        });
        inFlightPromises.set(cacheKey, promise);
        if (cacheKey !== baseHistoryCacheKey(ticket)) {
            inFlightPromises.set(baseHistoryCacheKey(ticket), promise);
        }
        markTicketHistoryLoading(ticket);

        void (async () => {
            /** @type {{ ticket: object, opts: object }|null} */
            let deferredRetry = null;
            let result = findTicketInOrgList(tn) || ticket;
            try {
                const res = await global.authModule.apiRequest(
                    `tickets/${encodeURIComponent(tn)}/ngen-notification-history`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    }
                );
                if (res && res.skipped) {
                    const live = findTicketInOrgList(tn) || ticket;
                    const clientReady =
                        resolveTicketNgenJobNumber(live) != null && collectOperatorAuthorityIds(live).length > 0;
                    if (clientReady && !options._deferredRetry) {
                        deferredRetry = {
                            ticket: live,
                            opts: {
                                ...options,
                                _deferredRetry: true,
                                silent: true,
                                authorityIds: collectOperatorAuthorityIds(live),
                            },
                        };
                    } else {
                        markTicketHistoryUnavailable(tn, live);
                    }
                    result = findTicketInOrgList(tn) || live;
                } else {
                    const history = res && res.ngenResponseHistory;
                    const updated = mergeHistoryOntoTicket(tn, ticket, history);
                    if (!options.silent && typeof global.redrawOpenTicketDetailViewsForTicket === 'function') {
                        global.redrawOpenTicketDetailViewsForTicket(updated || ticket);
                    }
                    result = updated || ticket;
                }
            } catch (e) {
                const live = findTicketInOrgList(tn) || ticket;
                if (isHistoryFetchForbiddenError(e)) {
                    if (ticketHasCachedProviderHistory(live)) {
                        setProviderHistoryStatusOnTicket(tn, 'loaded');
                    } else {
                        setProviderHistoryStatusOnTicket(tn, 'cached_only');
                    }
                } else if (isHistoryFetchExpectedUnavailableError(e)) {
                    const clientReady =
                        resolveTicketNgenJobNumber(live) != null && collectOperatorAuthorityIds(live).length > 0;
                    if (clientReady && !options._deferredRetry) {
                        deferredRetry = {
                            ticket: live,
                            opts: {
                                ...options,
                                _deferredRetry: true,
                                silent: true,
                                authorityIds: collectOperatorAuthorityIds(live),
                            },
                        };
                    } else {
                        markTicketHistoryUnavailable(tn, live);
                    }
                } else if (live && live.ngenResponseHistoryStatus === 'loading') {
                    setProviderHistoryStatusOnTicket(tn, 'error');
                    if (live === ticket || !findTicketInOrgList(tn)) {
                        ticket.ngenResponseHistoryStatus = 'error';
                    }
                }
                if (
                    !options.silent &&
                    !isHistoryFetchForbiddenError(e) &&
                    !isHistoryFetchExpectedUnavailableError(e)
                ) {
                    console.warn('[ngenProviderResponseHistory] load failed:', e && e.message ? e.message : e);
                }
                result = findTicketInOrgList(tn) || ticket;
            } finally {
                // Keep the in-flight entry during deferred retry delay so hub redraw cannot stack another POST.
                if (!deferredRetry) {
                    inFlightPromises.delete(cacheKey);
                    inFlightPromises.delete(baseHistoryCacheKey(ticket));
                }
            }
            if (deferredRetry) {
                try {
                    await new Promise((r) => setTimeout(r, 1500));
                } finally {
                    inFlightPromises.delete(cacheKey);
                    inFlightPromises.delete(baseHistoryCacheKey(ticket));
                }
                settleInFlight.resolve(
                    await ensureNgenProviderResponseHistoryLoaded(deferredRetry.ticket, deferredRetry.opts)
                );
                return;
            }
            settleInFlight.resolve(result);
        })().catch((e) => {
            settleInFlight.reject(e);
        });

        return promise;
    }

    /**
     * Background fetch when tips are stale (popup / hub open).
     * @param {object} ticket
     */
    function scheduleNgenProviderResponseHistoryIfNeeded(ticket) {
        if (!ticketNeedsNgenProviderHistoryFetch(ticket)) return;
        void ensureNgenProviderResponseHistoryLoaded(ticket, { silent: false });
    }

    /**
     * Fetch one utility when operator detail opens and notes are still missing.
     * @param {object} ticket
     * @param {object} response
     * @returns {Promise<object|null>}
     */
    async function ensureNgenProviderResponseHistoryForOperator(ticket, response) {
        if (!ticket || !response) return ticket;
        const aid = response.authorityId != null ? String(response.authorityId).trim() : '';
        if (!aid) {
            if (typeof console !== 'undefined' && typeof console.warn === 'function') {
                const isDev =
                    (global.location && global.location.hostname === 'localhost') ||
                    global.APP_ENV === 'development' ||
                    global.APP_ENV === 'staging';
                if (isDev) {
                    console.warn('[ngenProviderResponseHistory] operator row missing authorityId', {
                        ticketNumber: ticket.ticketNumber,
                        operatorName: response.operatorName || response.stationCode,
                    });
                }
            }
            return ticket;
        }
        if (typeof global.resolveOperatorResponseComments === 'function') {
            const resolved = global.resolveOperatorResponseComments(ticket, response);
            if (resolved && resolved.providerNotes) return ticket;
        }
        return ensureNgenProviderResponseHistoryLoaded(ticket, { authorityIds: [aid], silent: false });
    }

    global.ticketNeedsNgenProviderHistoryFetch = ticketNeedsNgenProviderHistoryFetch;
    global.ticketOperatorAuthoritiesReady = ticketOperatorAuthoritiesReady;
    global.isNgenProviderResponseHistoryLoadPending = isNgenProviderResponseHistoryLoadPending;
    global.ensureNgenProviderResponseHistoryLoaded = ensureNgenProviderResponseHistoryLoaded;
    global.scheduleNgenProviderResponseHistoryIfNeeded = scheduleNgenProviderResponseHistoryIfNeeded;
    global.ensureNgenProviderResponseHistoryForOperator = ensureNgenProviderResponseHistoryForOperator;
    global.syncProviderHistoryStatusFromHydratedTicket = syncProviderHistoryStatusFromHydratedTicket;
})(typeof window !== 'undefined' ? window : globalThis);
