    'use strict';

    /**
     * Mobile ticket hub uses the map popup for row detail (`hubSelectRow` → `showTicketPopup`).
     * Set to `true` to restore the mobile hub detail bottom sheet (`#ticketHubDetailModal`).
     */
    const TICKET_HUB_MOBILE_DETAIL_SHEET_ENABLED = false;

    const TICKET_HUB_DETAIL_BACK_ID = 'ticketHubDetail';
    const TICKET_HUB_FILTERS_BACK_ID = 'ticketHubFilters';
    const HUB_DETAIL_SHEET_CLOSE_MS = 320;
    let hubDetailSheetCloseTimer = null;
    let hubDetailRenderDepth = 0;

    function isTicketHubDetailModalOpenForBack() {
        const modal = document.getElementById('ticketHubDetailModal');
        return !!(modal && modal.classList.contains('ticket-hub-detail-modal-open'));
    }

    function isTicketHubFiltersModalOpenForBack() {
        const modal = document.getElementById('ticketHubFiltersModal');
        return !!(modal && modal.classList.contains('ticket-hub-detail-modal-open'));
    }

    function registerTicketHubDetailBack() {
        if (!window.uiBackStack) return;
        window.uiBackStack.register({
            id: TICKET_HUB_DETAIL_BACK_ID,
            isOpen: isTicketHubDetailModalOpenForBack,
            onBack: function () {
                dismissTicketHubDetailModal({ fromBack: true });
            },
        });
    }

    function unregisterTicketHubDetailBack(fromBack) {
        if (!window.uiBackStack || !window.uiBackStack.isRegistered(TICKET_HUB_DETAIL_BACK_ID)) return;
        window.uiBackStack.unregister(TICKET_HUB_DETAIL_BACK_ID, fromBack ? { fromPopstate: true } : undefined);
    }

    function registerTicketHubFiltersBack() {
        if (!window.uiBackStack) return;
        window.uiBackStack.register({
            id: TICKET_HUB_FILTERS_BACK_ID,
            isOpen: isTicketHubFiltersModalOpenForBack,
            onBack: function () {
                closeTicketHubFiltersModal({ fromBack: true });
            },
        });
    }

    function unregisterTicketHubFiltersBack(fromBack) {
        if (!window.uiBackStack || !window.uiBackStack.isRegistered(TICKET_HUB_FILTERS_BACK_ID)) return;
        window.uiBackStack.unregister(TICKET_HUB_FILTERS_BACK_ID, fromBack ? { fromPopstate: true } : undefined);
    }

    /** Active mode is fully in memory (ORG_TICKETS, all active tickets), so the hub table paginates client-side. */
    const HUB_ACTIVE_PAGE_SIZE = 50;
    let hubActiveClientPage = 1;
    /** Filter/search/sort signature for the active page; when it changes we reset to page 1. */
    let hubActiveClientPageKey = null;

    function hubUsesActiveClientPaging() {
        return typeof hubListPagerMode === 'function' && hubListPagerMode() === 'active';
    }

    function getHubTicketsPoolForFilter() {
        if (typeof hubStatusFilterIsExpiredOnly === 'function' && hubStatusFilterIsExpiredOnly()) {
            return Array.isArray(window.HUB_EXPIRED_TICKETS) ? window.HUB_EXPIRED_TICKETS.slice() : [];
        }
        if (typeof hubListPagerMode === 'function' && hubListPagerMode() === 'combined') {
            return Array.isArray(window.HUB_COMBINED_TICKETS) ? window.HUB_COMBINED_TICKETS.slice() : [];
        }
        if (typeof hubStatusFilterNeedsActiveFetch === 'function' && hubStatusFilterNeedsActiveFetch()) {
            const active = Array.isArray(window.ORG_TICKETS) ? window.ORG_TICKETS.slice() : [];
            if (
                typeof hubStatusFilterIncludesExpired === 'function' &&
                hubStatusFilterIncludesExpired()
            ) {
                const expired = Array.isArray(window.HUB_EXPIRED_TICKETS)
                    ? window.HUB_EXPIRED_TICKETS.slice()
                    : [];
                if (expired.length === 0) return active;
                return dedupeHubTicketsByBase(active.concat(expired));
            }
            return active;
        }
        return [];
    }

    /**
     * Ticket opened from Enter when it was not in the filtered list.
     * Memory only for this page visit — not written into the org ticket list.
     */
    let hubDirectSearchHit = null;
    let hubDirectSearchHitStatusKey = '';
    let hubDirectSearchInFlight = false;

    function hubStatusFiltersKey() {
        return Array.from(hubStatusFilters || []).sort().join(',');
    }

    function clearHubDirectSearchHit() {
        hubDirectSearchHit = null;
        hubDirectSearchHitStatusKey = '';
    }

    /** Keep the Enter lookup as a list line until the search text or status filter changes. */
    function withHubDirectSearchHit(list, omit) {
        const hit = hubDirectSearchHit;
        if (!hit) return list;
        const q = getHubSearch();
        if (!q || hubDirectSearchHitStatusKey !== hubStatusFiltersKey() || !hubSearchMatchesTicketNumber(hit, q)) {
            clearHubDirectSearchHit();
            return list;
        }
        if (typeof window.isTicketVisibleToTechClient === 'function' && !window.isTicketVisibleToTechClient(hit)) {
            clearHubDirectSearchHit();
            return list;
        }
        if (omit) return list;
        const already = (list || []).some((t) => t && idsMatch(t.id, hit.id));
        if (already) return list;
        return [hit].concat(list || []);
    }

    /** True when the search text is contained in this ticket's number (or its base number). */
    function hubSearchMatchesTicketNumber(ticket, q) {
        if (!ticket || !q) return false;
        const query = String(q).trim().toLowerCase();
        if (!query) return false;
        const tn = String(ticket.ticketNumber || '').toLowerCase();
        if (tn.includes(query)) return true;
        const base = String(normalizeHubTicketBase(ticket.ticketNumber) || '').toLowerCase();
        return !!(base && base.includes(query));
    }

    function hubSearchQueryLooksLikeTicketNumber(q) {
        return /^\d{8,}(?:-\d+)?$/.test(String(q || '').trim());
    }

    function getFilteredTicketsForHub(opts) {
        const omitDirectSearchHit = !!(opts && opts.omitDirectSearchHit);
        recalcAllTicketStatuses();
        const tickets = getHubTicketsPoolForFilter();
        const assignF = getHubAssigneeFilter();
        const submittedByF = getHubSubmittedByFilter();
        const orgScope = getHubOrgScopeFilter();
        const timeframe = getHubTimeframeFilter();
        const ownerOrg = getHubOwnerOrgFilter();
        const typeFilters = getHubTicketTypeFilters();
        const enquiryFilters = getHubEnquiryStatusFilters();
        const q = getHubSearch();

        const useDrawnAreaFilter = !!hubSearchPolygonLeaflet;
        const filtered = tickets.filter(
            t =>
                matchesHubOrgScope(t, orgScope) &&
                matchesHubTimeframe(t, timeframe) &&
                matchesHubOwnerOrgFilter(t, ownerOrg) &&
                matchesHubStatusFilters(t, hubStatusFilters) &&
                matchesAssigneeFilter(t, assignF) &&
                matchesHubSubmittedByFilter(t, submittedByF) &&
                matchesHubTicketTypeFilters(t, typeFilters) &&
                matchesHubEnquiryStatusFilters(t, enquiryFilters) &&
                matchesHubSearch(t, q) &&
                (!useDrawnAreaFilter || ticketOverlapsHubSearchPolygon(t, hubSearchPolygonLeaflet)) &&
                (typeof window.isTicketVisibleToTechClient !== 'function' ||
                    window.isTicketVisibleToTechClient(t))
        );

        const deduped = dedupeHubTicketsByBase(filtered);
        const sortEl = document.getElementById('ticketHubListSort');
        const rawSort = sortEl && sortEl.value != null ? String(sortEl.value) : 'expiring_soonest';
        const tm = window.ticketsModule;
        const sortMode =
            typeof normalizeHubListSort === 'function'
                ? normalizeHubListSort(rawSort)
                : rawSort === 'expiring_latest'
                  ? 'expiring_latest'
                  : 'expiring_soonest';
        if (sortEl && sortEl.value !== sortMode) sortEl.value = sortMode;
        const compareHubTickets = (a, b) => {
            if (tm && typeof tm.compareTicketsForListSort === 'function') {
                return tm.compareTicketsForListSort(a, b, sortMode, normalizeHubTicketBase);
            }
            return String(normalizeHubTicketBase(a.ticketNumber || '')).localeCompare(
                String(normalizeHubTicketBase(b.ticketNumber || ''))
            );
        };
        if (typeof hubListPagerMode === 'function' && hubListPagerMode() === 'combined') {
            const activeBucket = [];
            const expiredBucket = [];
            deduped.forEach((ticket) => {
                if (typeof hubTicketIsInactive === 'function' && hubTicketIsInactive(ticket)) {
                    expiredBucket.push(ticket);
                } else {
                    activeBucket.push(ticket);
                }
            });
            activeBucket.sort(compareHubTickets);
            expiredBucket.sort(compareHubTickets);
            return withHubDirectSearchHit(activeBucket.concat(expiredBucket), omitDirectSearchHit);
        }
        deduped.sort(compareHubTickets);
        return withHubDirectSearchHit(deduped, omitDirectSearchHit);
    }

    function hubTicketRowRefreshSpinnerHtml(ticket) {
        if (
            !window.ticketsModule ||
            typeof window.ticketsModule.ticketSelectionRefreshLoading !== 'function' ||
            !window.ticketsModule.ticketSelectionRefreshLoading(ticket)
        ) {
            return '';
        }
        return ` <span class="ticket-list-sync-spinner" title="Refreshing ticket${window.TICKET_HUB_TEXT.ELLIPSIS}" aria-label="Refreshing ticket"></span>`;
    }

    function computeStats(tickets) {
        const stats = {
            total: tickets.length,
            active: 0,
            ready: 0,
            notReady: 0,
            actionRequired: 0,
            expiringSoon: 0,
            expired: 0,
            cancelled: 0,
            assigned: 0,
            unassigned: 0,
            sharedPartnerActive: 0
        };
        tickets.forEach(t => {
            const status =
                typeof getHubEffectiveStatus === 'function' ? getHubEffectiveStatus(t) : t && t.status;
            const inactive =
                window.ticketsModule && typeof window.ticketsModule.isInactiveWorkflowStatus === 'function'
                    ? window.ticketsModule.isInactiveWorkflowStatus(status)
                    : status === 'EXPIRED' || status === 'CANCELLED';
            if (!inactive) stats.active++;
            if (t && t.shared && !inactive) stats.sharedPartnerActive++;
            if (status === 'READY') stats.ready++;
            else if (status === 'NOT_READY') stats.notReady++;
            else if (status === 'ACTION_REQUIRED') stats.actionRequired++;
            else if (status === 'EXPIRING_SOON') stats.expiringSoon++;
            else if (status === 'EXPIRED') stats.expired++;
            else if (status === 'CANCELLED') stats.cancelled++;
            const myId = getHubCurrentUserId();
            if (myId != null && isAssignedToUser(t, myId)) stats.assigned++;
            else if (!hasAnyAssignee(t)) stats.unassigned++;
        });
        stats.incomplete = stats.notReady + stats.actionRequired;
        return stats;
    }

    const HUB_STAT_SYMBOL_COLORS = {
        active: 'var(--app-accent)',
        ready: 'var(--app-success)',
        incomplete: '#eab308',
        not_ready: 'var(--app-danger)',
        action_required: '#facc15',
        expiring_soon: 'var(--app-danger)',
        expired: '#6b7280',
        cancelled: '#9ca3af',
        total: 'var(--app-text-secondary)',
        shared_partner: '#8b5cf6',
        assigned: '#3b82f6',
        unassigned: '#94a3b8',
        filtered: 'var(--app-accent)',
    };

    function hubStatSymbolColor(action, opts) {
        if (opts && opts.symbolColor) return opts.symbolColor;
        if (action && HUB_STAT_SYMBOL_COLORS[action]) return HUB_STAT_SYMBOL_COLORS[action];
        return 'var(--app-text-secondary)';
    }

    function hubStatCardHtml(action, label, value, opts) {
        opts = opts || {};
        const clickable = action ? ' ticket-hub-stat-clickable' : '';
        const active = opts.active ? ' ticket-hub-stat-card-active' : '';
        const extra = opts.extraClass || '';
        const valueStyle = opts.valueStyle ? ` style="${opts.valueStyle}"` : '';
        const data = action ? ` data-hub-stat-action="${action}"` : '';
        const hintBase =
            opts.titleHint != null && opts.titleHint !== false
                ? String(opts.titleHint)
                : action
                  ? 'Click to toggle. Multiple statuses combine (OR).'
                  : '';
        let hint = hintBase;
        if (opts.resetZoomHint && action) {
            const holdHint =
                (typeof isTicketHubMobile === 'function' && isTicketHubMobile()) ||
                (typeof window.matchMedia === 'function' &&
                    window.matchMedia('(max-width: 768px)').matches);
            const zoomHint = holdHint
                ? 'Press and hold for Reset zoom.'
                : 'Right-click for Reset zoom.';
            hint = hint ? hint.replace(/\.\s*$/, '') + '. ' + zoomHint : zoomHint;
        }
        const useCompactLabel =
            ((typeof isTicketHubMobile === 'function' && isTicketHubMobile()) ||
                (typeof isTicketHubCompactStats === 'function' && isTicketHubCompactStats())) &&
            opts.mobileLabel != null &&
            opts.mobileLabel !== '';
        const displayLabel = useCompactLabel ? String(opts.mobileLabel) : label;
        if (useCompactLabel && displayLabel !== label) {
            hint = hint ? `${label}. ${hint}` : label;
        }
        const titleAttr =
            hint && opts.titleAttr !== false ? ` title="${hubEscapeHtml(hint)}"` : '';
        const symbolColor = hubStatSymbolColor(action, opts);
        const symbol = `<span class="ticket-hub-stat-symbol" aria-hidden="true"></span>`;
        return (
            `<div class="ticket-hub-stat-card${clickable}${active}${extra}" style="--stat-symbol-color:${symbolColor}"${data}${titleAttr}>` +
            symbol +
            `<span class="ticket-hub-stat-label">${displayLabel}</span>` +
            `<span class="ticket-hub-stat-value"${valueStyle}>${value}</span>` +
            '</div>'
        );
    }

    function isHubListFilteredBeyondDefaults() {
        if (getHubSearch()) return true;
        if (getHubAssigneeFilter() !== 'all') return true;
        if (getHubSubmittedByFilter() !== 'all') return true;
        if (hubPartnerSharedFilter) return true;
        if (getHubTimeframeFilter() !== 'all') return true;
        if (typeof getHubTimeframeFieldType === 'function' && getHubTimeframeFieldType() !== 'expiration') return true;
        if (getHubOwnerOrgFilter() !== 'all') return true;
        if (typeof getHubTicketTypeFilters === 'function' && getHubTicketTypeFilters().size > 0) return true;
        if (typeof getHubEnquiryStatusFilters === 'function' && getHubEnquiryStatusFilters().size > 0) return true;
        const sortEl = document.getElementById('ticketHubListSort');
        const rawSort = sortEl && sortEl.value != null ? String(sortEl.value) : 'expiring_soonest';
        const sortVal =
            typeof normalizeHubListSort === 'function' ? normalizeHubListSort(rawSort) : rawSort;
        if (sortVal !== 'expiring_soonest') return true;
        if (!(hubStatusFilters.size === 1 && hubStatusFilters.has('ACTIVE'))) return true;
        if (hubSearchPolygonLeaflet) return true;
        return false;
    }

    function getHubFilteredStatModeMeta() {
        const mode = typeof hubListPagerMode === 'function' ? hubListPagerMode() : 'active';
        if (mode === 'expired') return { mode, meta: window.HUB_EXPIRED_TICKETS_META || null };
        if (mode === 'combined') return { mode, meta: window.HUB_COMBINED_TICKETS_META || null };
        return { mode, meta: window.HUB_ACTIVE_TICKETS_META || null };
    }

    function getHubFilteredStatKey() {
        const modeMeta = getHubFilteredStatModeMeta();
        const sortEl = document.getElementById('ticketHubListSort');
        const fromEl = document.getElementById('ticketHubFromDate');
        const toEl = document.getElementById('ticketHubToDate');
        const statusKey = Array.from(hubStatusFilters || []).sort().join(',');
        const typeKey =
            typeof getHubTicketTypeFilters === 'function'
                ? Array.from(getHubTicketTypeFilters()).sort().join(',')
                : '';
        const enquiryKey =
            typeof getHubEnquiryStatusFilters === 'function'
                ? Array.from(getHubEnquiryStatusFilters()).sort().join(',')
                : '';
        const polygonKey = hubSearchPolygonGeo ? JSON.stringify(hubSearchPolygonGeo) : '';
        return [
            modeMeta.mode,
            statusKey,
            typeKey,
            enquiryKey,
            getHubSearch(),
            getHubAssigneeFilter(),
            getHubSubmittedByFilter(),
            getHubOrgScopeFilter(),
            getHubTimeframeFilter(),
            typeof getHubTimeframeFieldType === 'function' ? getHubTimeframeFieldType() : 'expiration',
            getHubOwnerOrgFilter(),
            typeof normalizeHubListSort === 'function'
                ? normalizeHubListSort(sortEl && sortEl.value)
                : sortEl && sortEl.value != null
                  ? String(sortEl.value)
                  : 'expiring_soonest',
            fromEl && fromEl.value ? String(fromEl.value) : '',
            toEl && toEl.value ? String(toEl.value) : '',
            polygonKey,
        ].join('|');
    }

    function getHubFilteredStatValue(filtered, stats) {
        const modeMeta = getHubFilteredStatModeMeta();
        const pageIndex = modeMeta.meta && modeMeta.meta.pageIndex != null ? Number(modeMeta.meta.pageIndex) : 1;
        const key = getHubFilteredStatKey();
        const prior = window.HUB_FILTERED_STAT_META;
        if (prior && prior.key === key && Number.isFinite(pageIndex) && pageIndex > 1) {
            return prior.value;
        }

        let value = filtered && typeof filtered.length === 'number' ? filtered.length : 0;
        const hasNoExtraClientFilters =
            !getHubSearch() &&
            getHubAssigneeFilter() === 'all' &&
            getHubSubmittedByFilter() === 'all' &&
            getHubOrgScopeFilter() === 'all' &&
            getHubOwnerOrgFilter() === 'all' &&
            !(typeof getHubTicketTypeFilters === 'function' && getHubTicketTypeFilters().size > 0) &&
            !(typeof getHubEnquiryStatusFilters === 'function' && getHubEnquiryStatusFilters().size > 0) &&
            !hubSearchPolygonLeaflet;

        if (hasNoExtraClientFilters) {
            if (modeMeta.mode === 'combined') {
                const expiredInRange =
                    typeof window.HUB_EXPIRED_IN_RANGE_COUNT === 'number' &&
                    Number.isFinite(window.HUB_EXPIRED_IN_RANGE_COUNT)
                        ? window.HUB_EXPIRED_IN_RANGE_COUNT
                        : null;
                if (expiredInRange != null && stats && typeof stats.active === 'number') {
                    value = stats.active + expiredInRange;
                }
            } else if (modeMeta.mode === 'expired') {
                const expiredInRange =
                    typeof window.HUB_EXPIRED_IN_RANGE_COUNT === 'number' &&
                    Number.isFinite(window.HUB_EXPIRED_IN_RANGE_COUNT)
                        ? window.HUB_EXPIRED_IN_RANGE_COUNT
                        : null;
                if (expiredInRange != null) value = expiredInRange;
            } else if (
                hubStatusFilters &&
                stats &&
                hubStatusFilters.size === 2 &&
                hubStatusFilters.has('NOT_READY') &&
                hubStatusFilters.has('ACTION_REQUIRED')
            ) {
                value = (stats.notReady || 0) + (stats.actionRequired || 0);
            } else if (hubStatusFilters && hubStatusFilters.size === 1 && stats) {
                if (hubStatusFilters.has('ACTIVE')) value = stats.active;
                else if (hubStatusFilters.has('READY')) value = stats.ready;
                else if (hubStatusFilters.has('NOT_READY')) value = stats.notReady;
                else if (hubStatusFilters.has('ACTION_REQUIRED')) value = stats.actionRequired;
                else if (hubStatusFilters.has('EXPIRING_SOON')) value = stats.expiringSoon;
                else if (hubStatusFilters.has('CANCELLED')) {
                    const cancelledFromDb =
                        typeof window.TICKETS_CANCELLED_DB_COUNT === 'number' &&
                        Number.isFinite(window.TICKETS_CANCELLED_DB_COUNT)
                            ? window.TICKETS_CANCELLED_DB_COUNT
                            : null;
                    value = cancelledFromDb != null ? cancelledFromDb : stats.cancelled;
                }
            }
        }

        window.HUB_FILTERED_STAT_META = { key, value };
        return value;
    }

    /**
     * Tiered stat cards. Primary row (status filters) is always visible; Total plus secondary
     * row sit after the expand toggle and hide when collapsed.
     */
    function buildHubStatTiers(ctx) {
        const s = ctx.stats;
        const assignF = ctx.assignF;
        const filteredDisplay = ctx.filteredDisplay;
        const resetZoomHint = !!(ctx && ctx.resetZoomHint);
        const cardOpts = function (o) {
            const opts = Object.assign({}, o || {});
            if (resetZoomHint) opts.resetZoomHint = true;
            return opts;
        };

        const statusActive = val => hubStatusFilters.has(val) && assignF === 'all';
        const incompleteActive =
            assignF === 'all' &&
            hubStatusFilters.has('NOT_READY') &&
            hubStatusFilters.has('ACTION_REQUIRED');
        const totalActive =
            assignF === 'all' &&
            (hubStatusFilters.size === 0 || (hubStatusFilters.size === 1 && hubStatusFilters.has('ALL')));
        const assignActive = val => {
            if (val === 'assigned') return hubAssigneeFilterIsCurrentUser(assignF);
            return assignF === val;
        };

        const expiredFromDb = ctx.expiredFromDb;
        const expiredDisplay = ctx.expiredDisplay;
        const cancelledFromDb = ctx.cancelledFromDb;
        const cancelledDisplay = ctx.cancelledDisplay;
        const totalDisplay = ctx.totalDisplay;
        const totalTitleHint = ctx.totalTitleHint;
        const secondaryClass = ' ticket-hub-stat-secondary';

        const total = hubStatCardHtml('total', 'Total', totalDisplay, cardOpts({
            active: totalActive,
            titleHint: totalTitleHint,
            extraClass: secondaryClass,
        }));

        const primary = [
            hubStatCardHtml('active', 'Live', s.active, cardOpts({
                active: statusActive('ACTIVE'),
                extraClass: ' ticket-hub-stat--live',
            })),
            hubStatCardHtml('ready', 'Complete', s.ready, cardOpts({
                active: statusActive('READY'),
                extraClass: ' ticket-hub-stat--complete',
                valueStyle: 'color:var(--app-success)',
            })),
            hubStatCardHtml('incomplete', 'Incomplete', s.incomplete, cardOpts({
                active: incompleteActive,
                extraClass: ' ticket-hub-stat--incomplete',
                titleHint:
                    'Not Ready and Review Required combined. Click to toggle. Multiple statuses combine (OR).',
                valueStyle: 'color:#ca8a04',
            })),
            hubStatCardHtml('expiring_soon', 'Expiring', s.expiringSoon, cardOpts({
                active: statusActive('EXPIRING_SOON'),
                extraClass: ' ticket-hub-stat--expiring',
                valueStyle: 'color:var(--app-danger)',
            })),
        ];

        const secondary = [];
        if (s.sharedPartnerActive > 0) {
            secondary.push(
                hubStatCardHtml('shared_partner', 'External', s.sharedPartnerActive, cardOpts({
                    active: getHubOrgScopeFilter() === 'shared_partner',
                    extraClass: secondaryClass,
                    titleHint:
                        'Active tickets shared from a partner organization (not in-org external imports). Click to toggle filter.',
                }))
            );
        }
        secondary.push(
            hubStatCardHtml(null, 'Filtered', filteredDisplay, cardOpts({
                active: isHubListFilteredBeyondDefaults(),
                extraClass: ' ticket-hub-stat-filtered' + secondaryClass,
                symbolColor: 'var(--app-accent)',
                titleHint:
                    `Count of tickets matching current hub filters. This stays tied to the applied filters while paging; the map/table still use the current visible page while Ticket hub is open. Not a button ${window.TICKET_HUB_TEXT.EM_DASH} use Filters to change criteria.`
            }))
        );
        secondary.push(
            hubStatCardHtml('expired', 'Expired', expiredDisplay, cardOpts({
                active: statusActive('EXPIRED'),
                valueStyle: 'color:#6b7280',
                extraClass: secondaryClass,
                titleHint:
                    expiredFromDb != null
                        ? `Total expired tickets in the database for the currently selected organization. Click to load expired tickets for the current date range.`
                        : undefined
            }))
        );
        secondary.push(
            hubStatCardHtml('cancelled', 'Cancelled', cancelledDisplay, cardOpts({
                active: statusActive('CANCELLED'),
                valueStyle: 'color:#6b7280',
                extraClass: secondaryClass,
                titleHint:
                    cancelledFromDb != null
                        ? `Cancelled tickets that are not yet expired for the currently selected organization. Cancelled tickets past expiry are counted under Expired. Click to filter by cancelled status.`
                        : undefined
            }))
        );
        secondary.push(
            hubStatCardHtml('assigned', 'Assigned to me', s.assigned, cardOpts({
                active: assignActive('assigned'),
                mobileLabel: 'My Tix',
                extraClass: secondaryClass,
                titleHint:
                    'Tickets in open projects where you are on the project crew (clears status filters to All)'
            }))
        );
        secondary.push(
            hubStatCardHtml('unassigned', 'Unassigned', s.unassigned, cardOpts({
                active: assignActive('unassigned'),
                extraClass: secondaryClass,
                titleHint:
                    'Tickets not covered by any open project crew (clears status filters to All)'
            }))
        );

        return { total, primary, secondary };
    }

    function shouldShowMapStatusFilters() {
        return false;
    }

    function getHubStatRenderContext() {
        recalcAllTicketStatuses();
        const all = dedupeHubTicketsByBase(window.ORG_TICKETS || []);
        const s = computeStats(all);
        const assignF = getHubAssigneeFilter();
        const filtered = getFilteredTicketsForHub();
        const filteredDisplay = getHubFilteredStatValue(filtered, s);
        const expiredFromDb =
            typeof window.TICKETS_EXPIRED_DB_COUNT === 'number' && Number.isFinite(window.TICKETS_EXPIRED_DB_COUNT)
                ? window.TICKETS_EXPIRED_DB_COUNT
                : null;
        const expiredDisplay = expiredFromDb != null ? expiredFromDb : s.expired;
        const cancelledFromDb =
            typeof window.TICKETS_CANCELLED_DB_COUNT === 'number' && Number.isFinite(window.TICKETS_CANCELLED_DB_COUNT)
                ? window.TICKETS_CANCELLED_DB_COUNT
                : null;
        const cancelledDisplay = cancelledFromDb != null ? cancelledFromDb : s.cancelled;
        const totalDisplay = expiredFromDb != null ? s.total + expiredFromDb : s.total;
        const totalTitleHint =
            expiredFromDb != null
                ? `Tickets in this scope: ${s.total} in the current list (deduped by request #) plus ${expiredFromDb} expired row(s) in the database. Click to toggle.`
                : undefined;
        return {
            stats: s,
            assignF,
            filteredDisplay,
            expiredFromDb,
            expiredDisplay,
            cancelledFromDb,
            cancelledDisplay,
            totalDisplay,
            totalTitleHint,
        };
    }

    let hubStatsExpanded = (function () {
        try {
            return window.sessionStorage.getItem('ticketHubStatsExpanded') === '1';
        } catch (e) {
            return false;
        }
    })();

    function setHubStatsExpanded(expanded) {
        hubStatsExpanded = !!expanded;
        try {
            window.sessionStorage.setItem('ticketHubStatsExpanded', hubStatsExpanded ? '1' : '0');
        } catch (e) {
            /* sessionStorage unavailable */
        }
        renderHubStats();
    }

    function hubStatsTieredHtml(tiers) {
        const expandTitle = hubStatsExpanded ? 'Fewer stats' : 'More stats';
        const mobile = typeof isTicketHubMobile === 'function' && isTicketHubMobile();
        const expandIcon = mobile
            ? hubStatsExpanded
                ? '◂'
                : '▸'
            : hubStatsExpanded
              ? '▴'
              : '▾';
        const expandBtn =
            `<button type="button" class="map-status-stats-expand" aria-expanded="${hubStatsExpanded ? 'true' : 'false'}" title="${expandTitle}" aria-label="${expandTitle}"><span class="map-status-stats-expand-icon" aria-hidden="true">${expandIcon}</span></button>`;
        return (
            '<div class="ticket-hub-stats-primary-row">' +
            tiers.primary.join('') +
            '</div>' +
            expandBtn +
            '<div class="ticket-hub-stats-extra-row">' +
            tiers.total +
            tiers.secondary.join('') +
            '</div>'
        );
    }

    function shouldShowMapTopLeftActiveStatBubble() {
        if (typeof isTicketHubMobile !== 'function' || !isTicketHubMobile()) return false;
        if (
            typeof window.isCurrentOrgPublicCatalogViewer === 'function' &&
            window.isCurrentOrgPublicCatalogViewer()
        ) {
            return false;
        }
        const hubBtn = document.getElementById('ticketHubOpenButton');
        if (hubBtn && hubBtn.hidden) return false;
        return true;
    }

    function isMapTopLeftTicketsBubbleStatusFiltered() {
        // Default field view is Active-only; highlight when status filters diverge from that.
        return !(hubStatusFilters && hubStatusFilters.size === 1 && hubStatusFilters.has('ACTIVE'));
    }

    function syncMapTopLeftActiveStatBubble(ctx) {
        const el = document.getElementById('mapTopLeftActiveStatBubble');
        if (!el) return;
        const show = shouldShowMapTopLeftActiveStatBubble();
        if (!show) {
            el.hidden = true;
            el.classList.remove('map-top-left-active-stat-bubble--filtered');
            if (typeof window.closeMapTopLeftStatFilterMenu === 'function') {
                window.closeMapTopLeftStatFilterMenu();
            }
            return;
        }
        const feedMode =
            typeof window.isTicketHubFeedMode === 'function' && window.isTicketHubFeedMode();
        const labelEl = el.querySelector('.map-top-left-active-stat-label');
        const valueEl = el.querySelector('.map-top-left-active-stat-value');
        if (feedMode) {
            if (labelEl) labelEl.textContent = 'Feed';
            let openCount = 0;
            if (
                window.feedMapLayerModule &&
                typeof window.feedMapLayerModule.getFeedOpenCount === 'function'
            ) {
                const n = window.feedMapLayerModule.getFeedOpenCount();
                openCount = n != null && Number.isFinite(Number(n)) ? Number(n) : 0;
            }
            if (valueEl) valueEl.textContent = String(openCount);
            el.classList.remove('map-top-left-active-stat-bubble--filtered');
            el.title = 'Feed — tap to open';
            el.setAttribute('aria-label', 'Feed — tap to open');
            el.hidden = false;
            return;
        }
        const renderCtx = ctx || getHubStatRenderContext();
        if (labelEl) labelEl.textContent = 'Tickets';
        if (valueEl && renderCtx && renderCtx.stats) {
            valueEl.textContent = String(renderCtx.stats.active);
        }
        el.classList.toggle(
            'map-top-left-active-stat-bubble--filtered',
            isMapTopLeftTicketsBubbleStatusFiltered()
        );
        el.title = 'Tickets — tap to open, press and hold for filters';
        el.setAttribute('aria-label', 'Tickets — tap to open, press and hold for filters');
        el.hidden = false;
    }

    /** Primary status chips for the mobile map long-press fan (no secondary / expand). */
    function hubStatsPrimaryFanHtml(tiers) {
        if (!tiers || !Array.isArray(tiers.primary)) return '';
        return tiers.primary.join('');
    }

    function syncMapTopLeftStatFilterFan(ctx) {
        const cards = document.getElementById('mapTopLeftStatFilterCards');
        if (!cards) return;
        const show = shouldShowMapTopLeftActiveStatBubble();
        if (!show) {
            cards.innerHTML = '';
            if (typeof window.closeMapTopLeftStatFilterMenu === 'function') {
                window.closeMapTopLeftStatFilterMenu();
            }
            return;
        }
        const renderCtx = ctx || getHubStatRenderContext();
        const tiers = buildHubStatTiers(Object.assign({}, renderCtx, { resetZoomHint: true }));
        cards.innerHTML = hubStatsPrimaryFanHtml(tiers);
    }

    function getMapStatusActionBtns() {
        return document.querySelector('#mapStatusFilters .map-status-action-btns');
    }

    function getMapStatusFiltersBarMain() {
        return (
            document.querySelector('#mapStatusFilters .map-status-filters-bar-main') ||
            document.querySelector('#mapStatusFilters .map-status-filters-bar')
        );
    }

    /** Keep search + nested USAN status out of #mapStatusFiltersStats before innerHTML wipes them. */
    function parkMapStatusActionBtns() {
        const row = getMapStatusFiltersBarMain();
        const actionBtns = getMapStatusActionBtns();
        const mapContainer = document.getElementById('mapStatusFiltersStats');
        if (!row || !actionBtns) return actionBtns;
        if (actionBtns.parentElement === mapContainer || actionBtns.parentElement !== row) {
            row.insertBefore(actionBtns, mapContainer || row.firstChild);
        }
        ensureMapStatusActionBtnsLayout(actionBtns);
        return actionBtns;
    }

    /** Row layout for search + USAN; enforced in JS so stale cached CSS cannot stack them vertically. */
    function ensureMapStatusActionBtnsLayout(actionBtns) {
        const el = actionBtns || getMapStatusActionBtns();
        if (!el) return;
        el.style.display = 'flex';
        el.style.flexDirection = 'row';
    }

    /** Place search (+ nested USAN status) in the stats grid so they share primary-row height. */
    function placeMapStatusActionBtnsInStats(mapContainer) {
        const actionBtns = parkMapStatusActionBtns();
        if (!mapContainer || !actionBtns) return;
        mapContainer.insertBefore(actionBtns, mapContainer.firstChild);
    }

    function renderHubStats() {
        const hubContainer = document.getElementById('ticketHubStats');
        const mapContainer = document.getElementById('mapStatusFiltersStats');
        const mapWrap = document.getElementById('mapStatusFilters');
        const fanCards = document.getElementById('mapTopLeftStatFilterCards');
        if (!hubContainer && !mapContainer && !fanCards) return;

        // Feed workspace owns #ticketHubStats (Ready/Not ready per contractor). Never paint
        // the previous org's ticket Active/Expired counts over it.
        if (typeof window.isTicketHubFeedMode === 'function' && window.isTicketHubFeedMode()) {
            if (
                window.ticketHubFeedModule &&
                typeof window.ticketHubFeedModule.renderFeedStats === 'function'
            ) {
                window.ticketHubFeedModule.renderFeedStats();
            }
            if (mapContainer) {
                parkMapStatusActionBtns();
                mapContainer.innerHTML = '';
                mapContainer.classList.remove('map-status-stats-collapsed', 'map-status-stats-expanded');
            }
            if (mapWrap) {
                mapWrap.hidden = true;
                mapWrap.style.display = 'none';
                if (typeof window.closeMapStatusDropdowns === 'function') {
                    window.closeMapStatusDropdowns();
                }
            }
            if (fanCards) fanCards.innerHTML = '';
            syncMapStatusActionButtons();
            syncMapTopLeftActiveStatBubble();
            if (typeof window.closeMapTopLeftStatFilterMenu === 'function') {
                window.closeMapTopLeftStatFilterMenu();
            }
            relocateTicketHubSearchField();
            return;
        }

        const showMapStatusBar = shouldShowMapStatusFilters();
        const ctx = getHubStatRenderContext();
        const tiers = buildHubStatTiers(ctx);
        const tieredHtml = hubStatsTieredHtml(tiers);
        const mobile = typeof isTicketHubMobile === 'function' && isTicketHubMobile();
        const hubWin = document.getElementById('ticketHubWindow');
        const hubOpen = !!(hubWin && hubWin.classList.contains('show'));

        if (hubContainer) {
            if (mobile) {
                // Primary filters live on the map Tickets bubble fan; secondary stats are desktop-only.
                hubContainer.innerHTML = '';
                hubContainer.classList.remove('map-status-stats-collapsed', 'map-status-stats-expanded');
                hubContainer.classList.add('ticket-hub-stats--collapsed');
                hubContainer.setAttribute('aria-hidden', 'true');
                hubContainer.hidden = true;
            } else {
                hubContainer.hidden = false;
                hubContainer.innerHTML = tieredHtml;
                hubContainer.classList.toggle('map-status-stats-collapsed', !hubStatsExpanded);
                hubContainer.classList.toggle('map-status-stats-expanded', hubStatsExpanded);
                hubContainer.classList.remove('ticket-hub-stats--collapsed');
                hubContainer.removeAttribute('aria-hidden');
            }
        }

        if (mapContainer) {
            parkMapStatusActionBtns();
            if (showMapStatusBar && !mobile && !hubOpen) {
                const mapTiers = buildHubStatTiers(Object.assign({}, ctx, { resetZoomHint: true }));
                mapContainer.innerHTML = hubStatsTieredHtml(mapTiers);
                placeMapStatusActionBtnsInStats(mapContainer);
                mapContainer.classList.toggle('map-status-stats-collapsed', !hubStatsExpanded);
                mapContainer.classList.toggle('map-status-stats-expanded', hubStatsExpanded);
            } else {
                mapContainer.innerHTML = '';
                mapContainer.classList.remove('map-status-stats-collapsed', 'map-status-stats-expanded');
                if (showMapStatusBar && !mobile && hubOpen) {
                    placeMapStatusActionBtnsInStats(mapContainer);
                }
            }
        }
        if (mapWrap) {
            const showBar = showMapStatusBar && !mobile;
            mapWrap.hidden = !showBar;
            mapWrap.style.display = showBar ? '' : 'none';
            if (!showBar && typeof window.closeMapStatusDropdowns === 'function') {
                window.closeMapStatusDropdowns();
            }
        }
        syncMapStatusActionButtons();
        syncMapTopLeftActiveStatBubble(ctx);
        syncMapTopLeftStatFilterFan(ctx);
        if (mapContainer && showMapStatusBar && !mobile) {
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(function () {
                    syncMapStatusStatsOverlayScroll(mapContainer);
                });
            } else {
                syncMapStatusStatsOverlayScroll(mapContainer);
            }
        }
        relocateTicketHubSearchField();
    }

    function onHubStatCardClick(e) {
        if (Date.now() < suppressHubStatClickUntil) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (typeof hideHubStatResetZoomMenu === 'function') hideHubStatResetZoomMenu();
        const fromEl = clickTargetElement(e);
        const expandBtn = fromEl && fromEl.closest ? fromEl.closest('.map-status-stats-expand') : null;
        if (expandBtn) {
            e.stopPropagation();
            setHubStatsExpanded(!hubStatsExpanded);
            return;
        }
        const card = fromEl && fromEl.closest ? fromEl.closest('[data-hub-stat-action]') : null;
        if (!card) {
            e.stopPropagation();
            return;
        }
        e.stopPropagation();
        const action = card.getAttribute('data-hub-stat-action');
        const assignEl = document.getElementById('ticketHubAssigneeFilter');
        const statusMap = {
            total: 'ALL',
            active: 'ACTIVE',
            ready: 'READY',
            expiring_soon: 'EXPIRING_SOON',
            expired: 'EXPIRED',
            cancelled: 'CANCELLED'
        };
        if (action === 'incomplete') {
            hubStatusFilters.delete('ALL');
            hubStatusFilters.delete('ACTIVE');
            const bothOn = hubStatusFilters.has('NOT_READY') && hubStatusFilters.has('ACTION_REQUIRED');
            if (bothOn) {
                hubStatusFilters.delete('NOT_READY');
                hubStatusFilters.delete('ACTION_REQUIRED');
            } else {
                hubStatusFilters.add('NOT_READY');
                hubStatusFilters.add('ACTION_REQUIRED');
            }
            if (hubStatusFilters.size === 0) hubStatusFilters.add('ALL');
            if (assignEl) assignEl.value = 'all';
            onHubFilterChange();
            return;
        }
        if (statusMap[action]) {
            const key = statusMap[action];
            /** Status bubbles (Complete, Incomplete, Expiring, etc.) combine with OR; Live and Total are exclusive. */
            const comboStatusKeys = new Set([
                'READY',
                'NOT_READY',
                'ACTION_REQUIRED',
                'EXPIRING_SOON',
                'EXPIRED',
                'CANCELLED',
            ]);
            if (key === 'ALL') {
                hubStatusFilters = new Set(['ALL']);
            } else if (key === 'ACTIVE') {
                if (hubStatusFilters.size === 1 && hubStatusFilters.has('ACTIVE')) {
                    hubStatusFilters = new Set(['ALL']);
                } else {
                    hubStatusFilters = new Set(['ACTIVE']);
                }
            } else if (comboStatusKeys.has(key)) {
                hubStatusFilters.delete('ALL');
                hubStatusFilters.delete('ACTIVE');
                if (hubStatusFilters.has(key)) {
                    hubStatusFilters.delete(key);
                } else {
                    hubStatusFilters.add(key);
                }
                if (hubStatusFilters.size === 0) {
                    hubStatusFilters.add('ALL');
                }
            }
            if (assignEl) assignEl.value = 'all';
            onHubFilterChange();
            return;
        }
        if (action === 'assigned') {
            hubStatusFilters = new Set(['ALL']);
            const myId = getHubCurrentUserId();
            if (assignEl && myId != null) {
                const myIdStr = String(myId);
                if (hubAssigneeFilterIsCurrentUser(assignEl.value)) {
                    assignEl.value = 'all';
                } else {
                    ensureHubAssigneeFilterOptionForUserId(myId);
                    assignEl.value = myIdStr;
                }
            }
            onHubFilterChange();
            return;
        }
        if (action === 'unassigned') {
            hubStatusFilters = new Set(['ALL']);
            if (assignEl) assignEl.value = 'unassigned';
            onHubFilterChange();
            return;
        }
        if (action === 'shared_partner') {
            hubPartnerSharedFilter = !hubPartnerSharedFilter;
            if (assignEl) assignEl.value = 'all';
            onHubFilterChange();
        }
    }

    const HUB_STAT_ACTION_TO_STATUS = {
        total: 'ALL',
        active: 'ACTIVE',
        ready: 'READY',
        not_ready: 'NOT_READY',
        action_required: 'ACTION_REQUIRED',
        expiring_soon: 'EXPIRING_SOON',
        expired: 'EXPIRED',
        cancelled: 'CANCELLED',
    };

    let hubStatResetZoomMenuEl = null;
    let hubStatResetZoomPendingAction = null;
    let hubStatResetZoomOutsideBound = false;
    let hubStatResetZoomKeyBound = false;
    let suppressHubStatResetZoomActivateUntil = 0;

    const HUB_STAT_LONG_PRESS_MS = 500;
    const HUB_STAT_LONG_PRESS_MOVE_PX = 12;
    let hubStatLongPressState = null;
    let suppressHubStatClickUntil = 0;

    function clearHubStatLongPressState() {
        if (hubStatLongPressState && hubStatLongPressState.timer) {
            clearTimeout(hubStatLongPressState.timer);
        }
        hubStatLongPressState = null;
    }

    function ticketsPoolForHubStatZoom() {
        const active = Array.isArray(window.ORG_TICKETS) ? window.ORG_TICKETS : [];
        const expired = Array.isArray(window.HUB_EXPIRED_TICKETS) ? window.HUB_EXPIRED_TICKETS : [];
        if (!expired.length) return active.slice();
        if (typeof dedupeHubTicketsByBase === 'function') {
            return dedupeHubTicketsByBase(active.concat(expired));
        }
        return active.concat(expired);
    }

    function hubStatTicketsHaveMapGeometry(tickets) {
        if (!Array.isArray(tickets) || !tickets.length) return false;
        return tickets.some((ticket) => {
            if (ticket && ticket.polygon) return true;
            return !!(
                ticket &&
                ticket.stubMapPin &&
                Number.isFinite(Number(ticket.stubMapPin.lat)) &&
                Number.isFinite(Number(ticket.stubMapPin.lng))
            );
        });
    }

    function ticketsForHubStatAction(action) {
        const list = ticketsPoolForHubStatZoom();
        if (!action || !list.length) return [];

        if (action === 'incomplete') {
            return list.filter(
                (t) =>
                    typeof matchesSingleHubStatusFilter === 'function' &&
                    (matchesSingleHubStatusFilter(t, 'NOT_READY') ||
                        matchesSingleHubStatusFilter(t, 'ACTION_REQUIRED'))
            );
        }
        if (HUB_STAT_ACTION_TO_STATUS[action]) {
            const key = HUB_STAT_ACTION_TO_STATUS[action];
            return list.filter(
                (t) => typeof matchesSingleHubStatusFilter === 'function' && matchesSingleHubStatusFilter(t, key)
            );
        }
        if (action === 'assigned') {
            const myId = typeof getHubCurrentUserId === 'function' ? getHubCurrentUserId() : null;
            return list.filter(
                (t) => myId != null && typeof isAssignedToUser === 'function' && isAssignedToUser(t, myId)
            );
        }
        if (action === 'unassigned') {
            return list.filter((t) => typeof hasAnyAssignee === 'function' && !hasAnyAssignee(t));
        }
        if (action === 'shared_partner') {
            return list.filter((t) => {
                if (!t || !t.shared) return false;
                if (typeof hubTicketIsInactive === 'function' && hubTicketIsInactive(t)) return false;
                return true;
            });
        }
        return [];
    }

    function ensureHubStatResetZoomMenu() {
        if (hubStatResetZoomMenuEl && hubStatResetZoomMenuEl.isConnected) return hubStatResetZoomMenuEl;
        const el = document.createElement('div');
        el.id = 'hubStatResetZoomMenu';
        el.className = 'hub-stat-reset-zoom-menu';
        el.hidden = true;
        el.setAttribute('role', 'menu');
        el.innerHTML =
            '<button type="button" class="hub-stat-reset-zoom-btn" role="menuitem">Reset zoom</button>';
        const btn = el.querySelector('.hub-stat-reset-zoom-btn');
        if (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                // Long-press can release on top of the newly shown button; require a fresh tap.
                if (Date.now() < suppressHubStatResetZoomActivateUntil) return;
                const action = hubStatResetZoomPendingAction;
                hideHubStatResetZoomMenu();
                if (!action) return;
                const matched = ticketsForHubStatAction(action);
                const tm = window.ticketsModule;
                if (tm && typeof tm.fitMapToTickets === 'function') {
                    tm.fitMapToTickets(matched);
                } else if (typeof fitMapToTickets === 'function') {
                    fitMapToTickets(matched);
                }
            });
        }
        document.body.appendChild(el);
        hubStatResetZoomMenuEl = el;
        return el;
    }

    function hideHubStatResetZoomMenu() {
        hubStatResetZoomPendingAction = null;
        suppressHubStatClickUntil = 0;
        suppressHubStatResetZoomActivateUntil = 0;
        const el = hubStatResetZoomMenuEl;
        if (el) {
            el.hidden = true;
            el.removeAttribute('data-hub-stat-action');
        }
        if (hubStatResetZoomOutsideBound) {
            document.removeEventListener('pointerdown', onHubStatResetZoomOutside, true);
            hubStatResetZoomOutsideBound = false;
        }
        if (hubStatResetZoomKeyBound) {
            document.removeEventListener('keydown', onHubStatResetZoomKeydown, true);
            hubStatResetZoomKeyBound = false;
        }
    }

    function onHubStatResetZoomOutside(e) {
        const el = hubStatResetZoomMenuEl;
        const t = e && e.target;
        if (el && t && el.contains(t)) return;
        hideHubStatResetZoomMenu();
    }

    function onHubStatResetZoomKeydown(e) {
        if (e && e.key === 'Escape') {
            e.preventDefault();
            hideHubStatResetZoomMenu();
        }
    }

    function showHubStatResetZoomMenu(opts) {
        opts = opts || {};
        const action = opts.action;
        if (!action) return false;
        const matched = ticketsForHubStatAction(action);
        if (!matched.length || !hubStatTicketsHaveMapGeometry(matched)) return false;

        const el = ensureHubStatResetZoomMenu();
        hubStatResetZoomPendingAction = action;
        el.setAttribute('data-hub-stat-action', action);
        el.hidden = false;

        const pad = 8;
        const x = Number(opts.clientX) || 0;
        const y = Number(opts.clientY) || 0;
        el.style.left = '0px';
        el.style.top = '0px';
        const rect = el.getBoundingClientRect();
        let left = x + 4;
        let top = y + 4;
        if (left + rect.width + pad > window.innerWidth) {
            left = Math.max(pad, x - rect.width - 4);
        }
        if (top + rect.height + pad > window.innerHeight) {
            top = Math.max(pad, y - rect.height - 4);
        }
        el.style.left = `${Math.max(pad, left)}px`;
        el.style.top = `${Math.max(pad, top)}px`;

        if (!hubStatResetZoomOutsideBound) {
            // Defer so the opening contextmenu/pointerdown does not immediately dismiss.
            setTimeout(function () {
                if (el.hidden) return;
                document.addEventListener('pointerdown', onHubStatResetZoomOutside, true);
                hubStatResetZoomOutsideBound = true;
            }, 0);
        }
        if (!hubStatResetZoomKeyBound) {
            document.addEventListener('keydown', onHubStatResetZoomKeydown, true);
            hubStatResetZoomKeyBound = true;
        }
        return true;
    }

    function onHubStatCardContextMenu(e) {
        const fromEl = clickTargetElement(e);
        const card = fromEl && fromEl.closest ? fromEl.closest('[data-hub-stat-action]') : null;
        if (!card) return;
        const action = card.getAttribute('data-hub-stat-action');
        if (!action) return;
        const matched = ticketsForHubStatAction(action);
        if (!matched.length || !hubStatTicketsHaveMapGeometry(matched)) return;
        e.preventDefault();
        e.stopPropagation();
        // Long-press already opened the menu; still block the browser callout.
        if (Date.now() < suppressHubStatClickUntil) return;
        // Touch-generated contextmenu often follows with a synthetic card click.
        suppressHubStatClickUntil = Date.now() + 800;
        const shown = showHubStatResetZoomMenu({
            action,
            clientX: e.clientX,
            clientY: e.clientY,
        });
        if (!shown) {
            suppressHubStatClickUntil = 0;
        }
    }

    /** Touch/pen long-press on mobile fan cards — same Reset zoom menu as desktop right-click. */
    function onHubStatCardPointerDown(e) {
        if (e.pointerType === 'mouse') return;
        if (e.button != null && e.button !== 0) return;
        const fromEl = clickTargetElement(e);
        const card = fromEl && fromEl.closest ? fromEl.closest('[data-hub-stat-action]') : null;
        if (!card) return;
        const action = card.getAttribute('data-hub-stat-action');
        if (!action) return;
        const matched = ticketsForHubStatAction(action);
        if (!matched.length || !hubStatTicketsHaveMapGeometry(matched)) return;

        clearHubStatLongPressState();
        const startX = e.clientX;
        const startY = e.clientY;
        hubStatLongPressState = {
            pointerId: e.pointerId,
            action: action,
            card: card,
            startX: startX,
            startY: startY,
            clientX: startX,
            clientY: startY,
            fired: false,
            timer: setTimeout(function () {
                if (!hubStatLongPressState) return;
                hubStatLongPressState.fired = true;
                suppressHubStatClickUntil = Date.now() + 800;
                suppressHubStatResetZoomActivateUntil = Date.now() + 800;
                const shown = showHubStatResetZoomMenu({
                    action: hubStatLongPressState.action,
                    clientX: hubStatLongPressState.clientX,
                    clientY: hubStatLongPressState.clientY,
                });
                if (!shown) {
                    suppressHubStatClickUntil = 0;
                    suppressHubStatResetZoomActivateUntil = 0;
                } else if (navigator.vibrate) {
                    try {
                        navigator.vibrate(10);
                    } catch (_) {
                        /* ignore */
                    }
                }
            }, HUB_STAT_LONG_PRESS_MS),
        };
        try {
            card.setPointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
    }

    function onHubStatCardPointerMove(e) {
        if (!hubStatLongPressState || hubStatLongPressState.pointerId !== e.pointerId) return;
        hubStatLongPressState.clientX = e.clientX;
        hubStatLongPressState.clientY = e.clientY;
        const dx = e.clientX - hubStatLongPressState.startX;
        const dy = e.clientY - hubStatLongPressState.startY;
        if (Math.hypot(dx, dy) > HUB_STAT_LONG_PRESS_MOVE_PX) {
            clearHubStatLongPressState();
        }
    }

    function onHubStatCardPointerUp(e) {
        if (!hubStatLongPressState || hubStatLongPressState.pointerId !== e.pointerId) return;
        const fired = hubStatLongPressState.fired;
        clearHubStatLongPressState();
        if (fired) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    function onHubStatCardPointerCancel(e) {
        if (!hubStatLongPressState || hubStatLongPressState.pointerId !== e.pointerId) return;
        clearHubStatLongPressState();
    }

    function getHubEffectiveStatus(ticket) {
        if (!ticket || typeof ticket !== 'object') return '';
        const tm = window.ticketsModule;
        if (tm && typeof tm.getTicketWorkflowStatusForMap === 'function') {
            return tm.getTicketWorkflowStatusForMap(ticket);
        }
        return (
            ticket.status ||
            ticket.computedWorkflowStatus ||
            ticket.workflowStatus ||
            ticket.workflow_status ||
            ''
        );
    }

    function statusBadgeClass(status) {
        switch (status) {
            case 'READY': return 'ready';
            case 'NOT_READY': return 'not-ready';
            case 'ACTION_REQUIRED': return 'action-required';
            case 'EXPIRING_SOON': return 'expiring-soon';
            case 'EXPIRED': return 'expired';
            case 'CANCELLED': return 'cancelled';
            default: return 'expired';
        }
    }

    function hubStatusPlainLabel(status) {
        if (status == null || status === '') return 'Unknown';
        return typeof window.formatWorkflowStatusDisplay === 'function'
            ? window.formatWorkflowStatusDisplay(status)
            : String(status).replace(/_/g, ' ');
    }

    function pruneHubBulkSelection(filtered) {
        const keep = new Set((filtered || []).map(t => String(t.id)));
        for (const id of [...hubBulkSelectedIds]) {
            if (!keep.has(String(id))) hubBulkSelectedIds.delete(id);
            else {
                const t = findTicketForHub(id);
                if (t && !isHubTicketBulkSelectable(t)) hubBulkSelectedIds.delete(id);
            }
        }
    }

    function hubBulkSelectableTickets(tickets) {
        return (tickets || []).filter(t => t && isHubTicketBulkSelectable(t));
    }

    function updateTicketHubBulkBar() {
        const bar = document.getElementById('ticketHubBulkBar');
        const label = document.getElementById('ticketHubBulkBarLabel');
        if (!bar || !label) return;
        if (!hubBulkColumnEnabled()) {
            hubBulkSelectedIds.clear();
            bar.setAttribute('hidden', '');
            return;
        }
        const n = hubBulkSelectedIds.size;
        if (n === 0) {
            bar.setAttribute('hidden', '');
            return;
        }
        bar.removeAttribute('hidden');
        label.textContent = n === 1 ? '1 ticket selected' : `${n} tickets selected`;
        if (typeof window.syncTicketHubRenewButtonVisibility === 'function') {
            window.syncTicketHubRenewButtonVisibility();
        }
        if (typeof window.syncTicketHubBulkDeleteVisibility === 'function') {
            window.syncTicketHubBulkDeleteVisibility();
        }
    }

    function syncHubBulkSelectAllCheckbox() {
        const win = document.getElementById('ticketHubWindow');
        if (!win) return;
        const headBoxes = win.querySelectorAll('.ticket-hub-bulk-select-all');
        if (headBoxes.length === 0) return;
        const filtered = getFilteredTicketsForHub();
        const selectable = hubBulkSelectableTickets(filtered);
        const ids = selectable.map(t => String(t.id));
        const inCount = ids.filter(id => hubBulkSelectedIds.has(id)).length;
        const state = ids.length === 0 ? false : inCount === 0 ? false : inCount === ids.length ? true : 'indeterminate';
        headBoxes.forEach(el => {
            if (state === 'indeterminate') {
                el.checked = false;
                el.indeterminate = true;
            } else {
                el.indeterminate = false;
                el.checked = state;
            }
        });
    }

    function renderHubTable() {
        const tbody = document.getElementById('ticketHubTableBody');
        const empty = document.getElementById('ticketHubTableEmpty');
        const headRow = document.getElementById('ticketHubTableHeadRow');
        if (!tbody) return;

        const narrowTable = hubTableUsesPhoneColumns();
        if (headRow) {
            headRow.innerHTML = narrowTable
                ? getHubTableHeadMobileHtml()
                : getHubTableHeadDesktopHtml();
        }
        applyHubTableColumnWidths(parseHubTableColWidthsFromStorage());

        const filtered = getFilteredTicketsForHub();
        pruneHubBulkSelection(filtered);

        // Active mode: paginate the in-memory set client-side so we never render thousands of rows at once.
        let displayRows = filtered;
        if (hubUsesActiveClientPaging()) {
            const key = getHubFilteredStatKey();
            if (key !== hubActiveClientPageKey) {
                hubActiveClientPageKey = key;
                hubActiveClientPage = 1;
            }
            const totalPages = Math.max(1, Math.ceil(filtered.length / HUB_ACTIVE_PAGE_SIZE));
            if (hubActiveClientPage > totalPages) hubActiveClientPage = totalPages;
            if (hubActiveClientPage < 1) hubActiveClientPage = 1;
            const start = (hubActiveClientPage - 1) * HUB_ACTIVE_PAGE_SIZE;
            displayRows = filtered.slice(start, start + HUB_ACTIVE_PAGE_SIZE);
        }

        if (filtered.length === 0) {
            tbody.innerHTML = '';
            if (empty) {
                empty.style.display = 'block';
                if (window.HUB_EXPIRED_LOADING || window.HUB_ACTIVE_LOADING) {
                    empty.textContent = `Loading tickets${window.TICKET_HUB_TEXT.ELLIPSIS}`;
                } else if (
                    typeof hubStatusFilterNeedsExpiredFetch === 'function' &&
                    hubStatusFilterNeedsExpiredFetch()
                ) {
                    const desc =
                        typeof formatHubExpiredRangeDescription === 'function'
                            ? formatHubExpiredRangeDescription()
                            : null;
                    const windowPhrase = desc && desc.windowPhrase ? desc.windowPhrase : 'the last 14 days';
                    empty.textContent = `No expired tickets in ${windowPhrase}. Use filters to search back further.`;
                } else {
                    empty.textContent = 'No tickets match your filters.';
                }
            }
            updateTicketHubBulkBar();
            renderHubExpiredListChrome(filtered);
            return;
        }
        if (empty) empty.style.display = 'none';

        const bulkEnabled = hubBulkColumnEnabled();
        const colReg = window.ticketHubColumnRegistry;
        tbody.innerHTML = displayRows
            .map(ticket => {
                const sel = idsMatch(ticket.id, selectedHubTicketId) ? 'ticket-hub-row-selected' : '';
                const idStr = String(ticket.id);
                const bulkSelectable = bulkEnabled && isHubTicketBulkSelectable(ticket);
                const bulkChecked = bulkSelectable && hubBulkSelectedIds.has(idStr) ? ' checked' : '';
                const bulkCell = !bulkEnabled
                    ? ''
                    : bulkSelectable
                      ? `<td class="ticket-hub-td-bulk" data-stop-row-select="1">${
                            typeof window.appCheckboxHtml === 'function'
                                ? window.appCheckboxHtml(
                                      `data-ticket-id="${hubEscapeHtml(
                                          idStr
                                      )}"${bulkChecked} aria-label="Select for bulk actions" title="Select for bulk actions"`,
                                      { wrapperClass: 'app-checkbox--table', inputClass: 'ticket-hub-bulk-cb' }
                                  )
                                : `<input type="checkbox" class="ticket-hub-bulk-cb" data-ticket-id="${hubEscapeHtml(
                                      idStr
                                  )}"${bulkChecked} aria-label="Select for bulk actions" title="Select for bulk actions" />`
                        }</td>`
                      : `<td class="ticket-hub-td-bulk" data-stop-row-select="1" aria-hidden="true"></td>`;
                const status = getHubEffectiveStatus(ticket);
                const statusCls = statusBadgeClass(status);
                const stLabel = hubStatusPlainLabel(status);
                const stEsc = hubEscapeHtml(stLabel);
                const rowStatusClass = `ticket-hub-row-status-${statusCls}`;
                let dataCells = '';
                if (colReg && typeof colReg.visibleColumnIds === 'function' && typeof colReg.renderCellHtml === 'function') {
                    dataCells = colReg.visibleColumnIds().map(function (colId) {
                        return colReg.renderCellHtml(ticket, colId);
                    }).join('');
                } else {
                    const colRegSubline =
                        window.ticketHubColumnRegistry &&
                        typeof window.ticketHubColumnRegistry.renderHubTicketIdentitySublineHtml === 'function'
                            ? window.ticketHubColumnRegistry.renderHubTicketIdentitySublineHtml(ticket)
                            : '';
                    const jobNameRaw = hubMappedField(ticket, 'jobName', ticket.jobName);
                    const jobNameDisp =
                        jobNameRaw != null && String(jobNameRaw).trim() !== '' ? String(jobNameRaw).trim() : '';
                    const addrFull = String(
                        hubMappedField(ticket, 'digSiteAddress', ticket.address, ticket.locationSummary) || ''
                    ).trim();
                    let subline = colRegSubline;
                    if (!subline && (addrFull || jobNameDisp)) {
                        const parts = [];
                        if (addrFull) parts.push(`<span class="ticket-hub-ticket-subline-address">${hubEscapeHtml(addrFull)}</span>`);
                        if (addrFull && jobNameDisp) {
                            parts.push('<span class="ticket-hub-ticket-subline-sep" aria-hidden="true">·</span>');
                        }
                        if (jobNameDisp) parts.push(`<span class="ticket-hub-ticket-subline-job">${hubEscapeHtml(jobNameDisp)}</span>`);
                        const title = [addrFull, jobNameDisp].filter(Boolean).join(' · ');
                        subline = `<div class="ticket-hub-ticket-subline" title="${hubEscapeHtml(title)}">${parts.join('')}</div>`;
                    }
                    dataCells =
                        `<td class="ticket-hub-td-num ticket-hub-td-num-rev ticket-hub-td-num--stacked" data-hub-col-key="ticket">` +
                        `<div class="ticket-hub-ticket-identity">${formatTicketNumberCellHtml(ticket)}${hubTicketRowRefreshSpinnerHtml(ticket)}${subline}</div>` +
                        '</td>';
                }
                return `
                <tr class="ticket-hub-row ${rowStatusClass} ${sel}" data-ticket-id="${hubEscapeHtml(String(ticket.id))}" title="${stEsc}">
                    ${bulkCell}
                    ${dataCells}
                </tr>`;
            })
            .join('');

        displayRows.forEach((ticket, index) => {
            const row = tbody.children[index];
            if (!row) return;
            row.addEventListener('click', function (e) {
                const fromEl = clickTargetElement(e);
                if (fromEl && fromEl.closest && fromEl.closest('[data-stop-row-select]')) return;
                e.stopPropagation();
                hubSelectRow(ticket.id);
            });
        });

        updateTicketHubBulkBar();
        syncHubBulkSelectAllCheckbox();
        renderHubExpiredListChrome(filtered);
    }

    const HUB_TABLE_COL_LAYOUT = {
        desktop: [
            { key: 'bulk', resizable: false },
            { key: 'ticket', resizable: true, minPx: 80 },
            { key: 'jobName', resizable: true, minPx: 64 },
            { key: 'address', resizable: true, minPx: 80 },
        ],
        mobile: [
            { key: 'bulk', resizable: false },
            { key: 'ticket', resizable: true, minPx: 72 },
        ],
    };

    function hubTableUsesPhoneColumns() {
        if (
            window.ticketHubColumnRegistry &&
            typeof window.ticketHubColumnRegistry.isNarrowTable === 'function'
        ) {
            return window.ticketHubColumnRegistry.isNarrowTable();
        }
        return typeof isTicketHubMobile === 'function' ? isTicketHubMobile() : window.innerWidth <= 768;
    }

    function getHubTableColumnLayout() {
        if (window.ticketHubColumnRegistry && typeof window.ticketHubColumnRegistry.getColumnLayout === 'function') {
            return window.ticketHubColumnRegistry.getColumnLayout();
        }
        const narrow = hubTableUsesPhoneColumns();
        const base = narrow ? HUB_TABLE_COL_LAYOUT.mobile : HUB_TABLE_COL_LAYOUT.desktop;
        if (hubBulkColumnEnabled()) return base;
        return base.filter((col) => col.key !== 'bulk');
    }

    function getHubTableEl() {
        return document.querySelector('#ticketHubWindow .ticket-hub-table');
    }

    function ensureHubTableColgroup() {
        const table = getHubTableEl();
        if (!table) return null;
        let cg = table.querySelector('colgroup');
        if (!cg) {
            cg = document.createElement('colgroup');
            table.insertBefore(cg, table.firstChild);
        }
        const layout = getHubTableColumnLayout();
        const existingKeys = Array.from(cg.querySelectorAll('col[data-hub-col-key]')).map((c) =>
            c.getAttribute('data-hub-col-key')
        );
        const nextKeys = layout.map((col) => col.key);
        const keysMatch =
            existingKeys.length === nextKeys.length &&
            existingKeys.every((k, i) => k === nextKeys[i]);
        if (!keysMatch) {
            cg.innerHTML = layout.map((col) => `<col data-hub-col-key="${col.key}" />`).join('');
        }
        return cg;
    }

    function getHubColElements() {
        const table = getHubTableEl();
        if (!table) return [];
        return Array.from(table.querySelectorAll('colgroup col[data-hub-col-key]'));
    }

    function parseHubTableColWidthsFromStorage() {
        try {
            const profileData = JSON.parse(localStorage.getItem(getProfileStorageKey()) || '{}');
            const saved = profileData.ticketHubTableColWidths;
            if (saved && typeof saved === 'object') return saved;
        } catch (_e) {
            /* ignore */
        }
        return {};
    }

    function saveHubTableColWidths(allWidths) {
        try {
            const key = getProfileStorageKey();
            const profileData = JSON.parse(localStorage.getItem(key) || '{}');
            profileData.ticketHubTableColWidths = allWidths;
            localStorage.setItem(key, JSON.stringify(profileData));
            if (typeof window.schedulePersistUserUiPreferencesToServer === 'function') {
                window.schedulePersistUserUiPreferencesToServer();
            }
        } catch (e) {
            console.error(e);
        }
    }

    function readHubColWidthsPx() {
        const layout = getHubTableColumnLayout();
        const cols = getHubColElements();
        const result = {};
        layout.forEach((def, i) => {
            if (!def.resizable) return;
            const col = cols[i];
            if (!col) return;
            const w = col.getBoundingClientRect().width;
            if (w > 0) result[def.key] = Math.round(w);
        });
        return result;
    }

    function setHubColPairWidths(leftKey, leftPx, rightKey, rightPx) {
        const table = getHubTableEl();
        if (!table) return;
        ensureHubTableColgroup();
        const layout = getHubTableColumnLayout();
        const cols = getHubColElements();
        const leftIdx = layout.findIndex((c) => c.key === leftKey);
        const rightIdx = layout.findIndex((c) => c.key === rightKey);
        if (leftIdx < 0 || rightIdx < 0) return;
        if (cols[leftIdx]) cols[leftIdx].style.width = Math.round(leftPx) + 'px';
        if (cols[rightIdx]) cols[rightIdx].style.width = Math.round(rightPx) + 'px';
        table.classList.add('ticket-hub-table--custom-cols');
    }

    function applyHubTableColumnWidths(savedWidths) {
        const table = getHubTableEl();
        if (!table) return;
        ensureHubTableColgroup();
        const layout = getHubTableColumnLayout();
        const mode = hubTableUsesPhoneColumns() ? 'mobile' : 'desktop';
        const modeWidths = savedWidths && savedWidths[mode] ? savedWidths[mode] : null;
        const cols = getHubColElements();
        let applied = false;
        // Drop legacy "assignees" widths from older layouts so they cannot skew new columns.
        if (modeWidths && modeWidths.assignees != null) {
            delete modeWidths.assignees;
        }

        layout.forEach((def, i) => {
            const col = cols[i];
            if (!col) return;
            if (!def.resizable) {
                col.style.width = '';
                return;
            }
            const w = modeWidths && modeWidths[def.key];
            if (w != null && Number.isFinite(Number(w)) && Number(w) >= def.minPx) {
                col.style.width = Math.round(Number(w)) + 'px';
                applied = true;
            } else {
                col.style.width = '';
            }
        });

        if (applied) table.classList.add('ticket-hub-table--custom-cols');
        else table.classList.remove('ticket-hub-table--custom-cols');
    }

    function initHubTableColumnResize() {
        const scroll = document.querySelector('#ticketHubWindow .ticket-hub-table-scroll');
        if (!scroll || scroll.dataset.hubColResizeInit) return;
        scroll.dataset.hubColResizeInit = '1';

        scroll.addEventListener('mousedown', function (e) {
            const fromEl = clickTargetElement(e);
            if (
                !fromEl ||
                !fromEl.classList ||
                !fromEl.classList.contains('ticket-hub-col-resize-handle')
            ) {
                return;
            }
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const colKey = fromEl.getAttribute('data-hub-col-key');
            const layout = getHubTableColumnLayout();
            const colIdx = layout.findIndex((c) => c.key === colKey);
            if (colIdx < 0 || colIdx >= layout.length - 1) return;
            const leftDef = layout[colIdx];
            const rightDef = layout[colIdx + 1];
            if (!leftDef.resizable || !rightDef.resizable) return;

            ensureHubTableColgroup();
            const cols = getHubColElements();
            const leftCol = cols[colIdx];
            const rightCol = cols[colIdx + 1];
            if (!leftCol || !rightCol) return;

            hubColDragging = true;
            hubColResizeStart = {
                x: e.clientX,
                leftKey: leftDef.key,
                rightKey: rightDef.key,
                leftWidth: leftCol.getBoundingClientRect().width,
                rightWidth: rightCol.getBoundingClientRect().width,
                leftMin: leftDef.minPx,
                rightMin: rightDef.minPx,
            };
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
        });

        document.addEventListener('mousemove', function hubColMove(e) {
            if (!hubColDragging) return;
            const delta = e.clientX - hubColResizeStart.x;
            let newLeft = hubColResizeStart.leftWidth + delta;
            let newRight = hubColResizeStart.rightWidth - delta;

            if (newLeft < hubColResizeStart.leftMin) {
                const overflow = hubColResizeStart.leftMin - newLeft;
                newLeft = hubColResizeStart.leftMin;
                newRight -= overflow;
            }
            if (newRight < hubColResizeStart.rightMin) {
                const overflow = hubColResizeStart.rightMin - newRight;
                newRight = hubColResizeStart.rightMin;
                newLeft -= overflow;
            }
            if (newLeft < hubColResizeStart.leftMin) newLeft = hubColResizeStart.leftMin;
            if (newRight < hubColResizeStart.rightMin) newRight = hubColResizeStart.rightMin;

            setHubColPairWidths(
                hubColResizeStart.leftKey,
                newLeft,
                hubColResizeStart.rightKey,
                newRight
            );
        });

        document.addEventListener('mouseup', function hubColUp() {
            if (!hubColDragging) return;
            hubColDragging = false;
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            hubSuppressOutsideCloseUntil = Date.now() + 400;

            const saved = parseHubTableColWidthsFromStorage();
            const mode = hubTableUsesPhoneColumns() ? 'mobile' : 'desktop';
            saved[mode] = readHubColWidthsPx();
            saveHubTableColWidths(saved);
        });
    }

    function renderHubExpiredListChrome(filtered) {
        const footer = document.getElementById('ticketHubExpiredFooter');
        const pager = document.getElementById('ticketHubExpiredPager');
        const prevBtn = document.getElementById('ticketHubExpiredPrev');
        const nextBtn = document.getElementById('ticketHubExpiredNext');
        const pageLabel = document.getElementById('ticketHubExpiredPageLabel');
        const rangeEl = document.getElementById('ticketHubPagerRange');
        const pagesEl = document.getElementById('ticketHubPagerPages');
        const expiredOnly =
            typeof hubStatusFilterIsExpiredOnly === 'function' && hubStatusFilterIsExpiredOnly();
        const pagerMode =
            typeof hubListPagerMode === 'function' ? hubListPagerMode() : expiredOnly ? 'expired' : 'active';
        const combinedMode = pagerMode === 'combined';
        const meta =
            pagerMode === 'expired'
                ? window.HUB_EXPIRED_TICKETS_META
                : combinedMode
                  ? window.HUB_COMBINED_TICKETS_META
                  : window.HUB_ACTIVE_TICKETS_META;
        const loading =
            pagerMode === 'expired'
                ? !!window.HUB_EXPIRED_LOADING
                : combinedMode
                  ? !!window.HUB_COMBINED_LOADING
                  : !!window.HUB_ACTIVE_LOADING;
        function hubPagerVisiblePages(current, totalPages) {
            if (totalPages <= 7) {
                const all = [];
                for (let i = 1; i <= totalPages; i++) all.push(i);
                return all;
            }
            let start = Math.max(2, current - 1);
            let end = Math.min(totalPages - 1, current + 1);
            if (current <= 3) {
                start = 2;
                end = 4;
            }
            if (current >= totalPages - 2) {
                start = totalPages - 3;
                end = totalPages - 1;
            }
            const out = [1];
            if (start > 2) out.push('ellipsis');
            for (let i = start; i <= end; i++) out.push(i);
            if (end < totalPages - 1) out.push('ellipsis');
            out.push(totalPages);
            return out;
        }

        function renderActivePageButtons(current, totalPages) {
            if (!pagesEl) return;
            pagesEl.innerHTML = hubPagerVisiblePages(current, totalPages)
                .map(function (item) {
                    if (item === 'ellipsis') {
                        return '<span class="ticket-hub-pager-ellipsis" aria-hidden="true">…</span>';
                    }
                    const currentCls = item === current ? ' is-current' : '';
                    const aria = item === current ? ' aria-current="page"' : '';
                    return (
                        '<button type="button" class="ticket-hub-page-btn' +
                        currentCls +
                        '" data-hub-page="' +
                        item +
                        '"' +
                        aria +
                        '>' +
                        item +
                        '</button>'
                    );
                })
                .join('');
        }

        if (pagerMode === 'active') {
            // Client-side pagination over the full in-memory active set: real total page count is known.
            const total = filtered && typeof filtered.length === 'number' ? filtered.length : 0;
            const totalPages = Math.max(1, Math.ceil(total / HUB_ACTIVE_PAGE_SIZE));
            if (hubActiveClientPage > totalPages) hubActiveClientPage = totalPages;
            if (hubActiveClientPage < 1) hubActiveClientPage = 1;
            const idx = hubActiveClientPage;
            if (pager) pager.hidden = !(total > 0);
            if (prevBtn) prevBtn.disabled = idx <= 1;
            if (nextBtn) nextBtn.disabled = idx >= totalPages;
            if (pageLabel) {
                pageLabel.hidden = true;
                pageLabel.textContent = '';
            }
            if (pagesEl) pagesEl.hidden = false;
            renderActivePageButtons(idx, totalPages);
            if (rangeEl) {
                if (total > 0) {
                    const start = (idx - 1) * HUB_ACTIVE_PAGE_SIZE + 1;
                    const end = Math.min(idx * HUB_ACTIVE_PAGE_SIZE, total);
                    rangeEl.hidden = false;
                    rangeEl.textContent = start + '–' + end + ' of ' + total;
                } else {
                    rangeEl.hidden = true;
                    rangeEl.textContent = '';
                }
            }
        } else {
            // Expired/combined use server cursor pagination: total page count is unknown.
            const pageIndex = meta && meta.pageIndex != null ? Number(meta.pageIndex) : 1;
            if (pager) {
                const showPager =
                    loading || (meta && (pageIndex > 1 || meta.hasMore)) || (filtered && filtered.length > 0);
                pager.hidden = !showPager;
            }
            if (prevBtn) {
                prevBtn.disabled = loading || !meta || pageIndex <= 1;
            }
            if (nextBtn) {
                nextBtn.disabled = loading || !meta || !meta.hasMore;
            }
            if (pagesEl) {
                pagesEl.hidden = true;
                pagesEl.innerHTML = '';
            }
            if (rangeEl) {
                rangeEl.hidden = true;
                rangeEl.textContent = '';
            }
            if (pageLabel) {
                pageLabel.hidden = false;
                pageLabel.textContent = loading
                    ? window.TICKET_HUB_TEXT.ELLIPSIS
                    : `Page ${Number.isFinite(pageIndex) && pageIndex > 0 ? pageIndex : 1}`;
            }
        }

        if (!footer) return;
        if (!expiredOnly && !combinedMode) {
            footer.hidden = true;
            footer.textContent = '';
            return;
        }
        if (loading) {
            footer.hidden = false;
            footer.textContent = combinedMode
                ? `Loading tickets${window.TICKET_HUB_TEXT.ELLIPSIS}`
                : `Loading expired tickets${window.TICKET_HUB_TEXT.ELLIPSIS}`;
            return;
        }
        const desc =
            typeof formatHubExpiredRangeDescription === 'function'
                ? formatHubExpiredRangeDescription()
                : null;
        const windowPhrase = desc && desc.windowPhrase ? desc.windowPhrase : 'the last 14 days';
        const fieldPhrase = desc && desc.fieldPhrase ? desc.fieldPhrase : 'expired';
        let note;
        if (combinedMode) {
            if (!meta || meta.hasMore) {
                footer.hidden = true;
                footer.textContent = '';
                return;
            }
            note = `Showing all active tickets plus expired tickets in ${windowPhrase}. Use filters to search back further.`;
        } else if (fieldPhrase === 'expired') {
            note = `This list only includes tickets that expired in ${windowPhrase}. Use filters to search back further.`;
        } else {
            note = `This list only includes tickets ${fieldPhrase} in ${windowPhrase}. Use filters to search back further.`;
        }
        if (
            typeof window.HUB_EXPIRED_IN_RANGE_COUNT === 'number' &&
            Number.isFinite(window.HUB_EXPIRED_IN_RANGE_COUNT) &&
            filtered &&
            filtered.length >= 0
        ) {
            note += ` (${window.HUB_EXPIRED_IN_RANGE_COUNT} in range)`;
        }
        footer.hidden = false;
        footer.textContent = note;
    }

    async function populateHubAssigneeFilter() {
        const select = document.getElementById('ticketHubAssigneeFilter');
        if (!select || !window.authModule) return;
        const current = select.value;
        select.innerHTML =
            '<option value="all">All assignees</option><option value="assigned">Anyone assigned</option><option value="unassigned">Unassigned only</option>';
        try {
            const orgId =
                window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
                    ? window.orgSelectorModule.getCurrentOrgId()
                    : window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId;
            if (!orgId) return;
            const users = await window.authModule.apiRequest(
                `${window.authModule.API_BASE}/users?organizationId=${orgId}`
            );
            const list = Array.isArray(users) ? users : [];
            list.forEach(u => {
                const opt = document.createElement('option');
                opt.value = String(u.id);
                opt.textContent = u.full_name || u.username || `User ${u.id}`;
                select.appendChild(opt);
            });
        } catch (e) {
            console.error('Ticket hub: load users for assignee filter', e);
        }
        if (current && Array.from(select.options).some(o => o.value === current)) select.value = current;
    }

    function buildTicketHubDetailInnerHtml(ticket) {
        const projectsBlock =
            typeof window.buildTicketHubProjectsFieldBlockHtml === 'function'
                ? window.buildTicketHubProjectsFieldBlockHtml(ticket)
                : '';

        const partsTitle = parseTicketNumberPartsClient(ticket);
        const titleNum = partsTitle.baseNumber || ticket.ticketNumber || '';
        const revForTitle = revisionLabelForTicket(ticket);

        const hubExternal =
            typeof isHubTicketExternalForOrg === 'function' && isHubTicketExternalForOrg(ticket);

        const hubActionsHtml =
            window.ticketActionsMenu &&
            typeof window.ticketActionsMenu.buildTicketDetailToolbarHtml === 'function'
                ? window.ticketActionsMenu.buildTicketDetailToolbarHtml(ticket, { context: 'hub' })
                : '';

        const tabStatuses =
            typeof window.getTicketDetailTabStatuses === 'function'
                ? window.getTicketDetailTabStatuses(ticket)
                : {};
        const tabCounts =
            typeof window.getTicketDetailTabCounts === 'function'
                ? window.getTicketDetailTabCounts(ticket)
                : {};
        const defaultTab = 'responses';
        const detailsTabHtml = `<div class="ticket-hub-detail-grid">${buildTicketHubFullDetailGridHtml(ticket, '', { omitPhotos: true, projectsBlock })}</div>${buildTicketHubReportedEventsSectionHtml(ticket)}`;
        const responsesTabHtml = buildHubOperatorResponsesHtml(ticket, false, { forTabs: true });
        const notesReadOnly =
            typeof window.ticketNotesReadOnlyForTicket === 'function' &&
            window.ticketNotesReadOnlyForTicket(ticket);
        const notesTabHtml =
            typeof window.buildTicketNotesPanelShellHtml === 'function'
                ? window.buildTicketNotesPanelShellHtml(ticket, { readOnly: notesReadOnly })
                : '<p class="ticket-notes-empty">Notes unavailable.</p>';
        const tabsHtml =
            typeof window.buildTicketDetailTabsHtml === 'function'
                ? window.buildTicketDetailTabsHtml({
                      detailsHtml: detailsTabHtml,
                      responsesHtml: responsesTabHtml,
                      notesHtml: notesTabHtml,
                      tabStatuses,
                      tabCounts,
                      defaultTab,
                  })
                : detailsTabHtml + responsesTabHtml;
        const sharedBadge = getHubExternalBadgeHtml(ticket);
        const hubStatusBadgeHtml =
            window.workflowAckModule &&
            typeof window.workflowAckModule.buildWorkflowStatusBadgeHtml === 'function'
                ? window.workflowAckModule.buildWorkflowStatusBadgeHtml(ticket, {
                      context: 'hub',
                      externalForOrg: hubExternal,
                      status: getHubEffectiveStatus(ticket),
                      variant: 'indicator',
                  })
                : `<span class="ticket-card-status ${statusBadgeClass(getHubEffectiveStatus(ticket))}">${hubEscapeHtml(hubStatusPlainLabel(getHubEffectiveStatus(ticket)))}</span>`;
        const jobNameRaw = hubMappedField(ticket, 'jobName', ticket.jobName);
        const jobNameDisp =
            jobNameRaw != null && String(jobNameRaw).trim() !== '' ? String(jobNameRaw).trim() : '';
        const addrFull = String(
            hubMappedField(ticket, 'digSiteAddress', ticket.address, ticket.locationSummary) || ''
        ).trim();
        const placeLine = [addrFull, jobNameDisp].filter(Boolean).join(' · ');
        const titleRevHero =
            revForTitle != null && String(revForTitle).trim() !== ''
                ? `<span class="ticket-hub-tn-rev">-${hubEscapeHtml(String(revForTitle).trim())}</span>`
                : '';

        return `
            <div class="ticket-hub-detail-header">
                <div class="ticket-hub-detail-header-main">
                    <p class="ticket-hub-detail-kicker">Locate ticket</p>
                    <button type="button" class="ticket-hub-detail-title ticket-hub-detail-title-link ticket-hub-id-hero" data-hub-action="usan-portal"><span class="ticket-hub-tn-base">${hubEscapeHtml(titleNum)}</span>${titleRevHero}${sharedBadge}</button>
                    ${placeLine ? `<p class="ticket-hub-detail-place">${hubEscapeHtml(placeLine)}</p>` : ''}
                </div>
                <div class="ticket-hub-detail-header-side">
                    ${hubStatusBadgeHtml}
                    <button type="button" class="ticket-hub-detail-close" data-hub-action="hub-close-detail" title="Close ticket" aria-label="Close ticket">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
            </div>
            ${buildTicketHubDetailPeopleBlockHtml(ticket)}
            ${hubActionsHtml}
            ${tabsHtml}
        `;
    }

    function hubAssigneeInitials(name) {
        const s = String(name || '').trim();
        if (!s) return '?';
        const parts = s.split(/\s+/).filter(Boolean);
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }

    function buildTicketHubDetailPeopleBlockHtml(ticket) {
        const users =
            typeof window.getProjectAssigneesForTicket === 'function'
                ? window.getProjectAssigneesForTicket(ticket) || []
                : [];
        const shown = users.slice(0, 3);
        const extra = users.length - shown.length;
        const faces = shown
            .map(function (a) {
                const name =
                    a && (a.userName || a.full_name || a.username)
                        ? String(a.userName || a.full_name || a.username).trim()
                        : a && a.userId != null
                          ? 'User #' + a.userId
                          : 'User';
                return `<span class="ticket-hub-detail-face" title="${hubEscapeHtml(name)}">${hubEscapeHtml(hubAssigneeInitials(name))}</span>`;
            })
            .join('');
        const extraHtml =
            extra > 0 ? `<span class="ticket-hub-detail-face ticket-hub-detail-face--more">+${extra}</span>` : '';
        const emptyHtml = users.length
            ? ''
            : '<span class="ticket-hub-detail-people-empty">No one assigned</span>';
        return `<div class="ticket-hub-detail-people">
            <div class="ticket-hub-detail-people-faces">${faces}${extraHtml}${emptyHtml}</div>
            <button type="button" class="ticket-hub-action-btn ticket-hub-detail-assign-btn" data-hub-action="hub-assign-people" title="Assign people on the project for this ticket">Assign</button>
        </div>`;
    }

    function wireTicketHubDetailAssigneeBtn(_container, _ticket) {
        /* Assignment is opened from data-hub-action="hub-assign-people". */
    }

    function closeTicketHubDetailSheet() {
        if (isTicketHubMobile()) return;
        selectedHubTicketId = null;
        hubPendingOpen = null;
        renderHubDetail();
        if (typeof renderHubTable === 'function') renderHubTable();
    }

    function wireTicketHubDetailProjectsField(container, ticket) {
        if (typeof window.wireTicketHubProjectsField === 'function') {
            window.wireTicketHubProjectsField(container, ticket);
        }
    }

    function wireTicketHubCollapsibleSections(container) {
        if (!container) return;
        container.querySelectorAll('[data-ticket-hub-collapsible]').forEach(section => {
            const toggle = section.querySelector('[data-ticket-hub-collapse-toggle]');
            if (!toggle || toggle.dataset.ticketHubCollapseInit) return;
            toggle.dataset.ticketHubCollapseInit = '1';
            toggle.setAttribute('aria-expanded', section.classList.contains('collapsed') ? 'false' : 'true');
            toggle.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                section.classList.toggle('collapsed');
                toggle.setAttribute('aria-expanded', section.classList.contains('collapsed') ? 'false' : 'true');
            });
        });
    }

    /* --- Mobile hub detail bottom sheet (disabled; popup-only). Set TICKET_HUB_MOBILE_DETAIL_SHEET_ENABLED = true to restore. --- */
    function applyTicketHubDetailSheetMobileHeight(sheet, mode) {
        if (!TICKET_HUB_MOBILE_DETAIL_SHEET_ENABLED) return;
        if (!sheet) return;
        const full = mode === 'full';
        sheet.classList.remove('ticket-hub-detail-mobile-halfway', 'ticket-hub-detail-mobile-full');
        sheet.classList.add(full ? 'ticket-hub-detail-mobile-full' : 'ticket-hub-detail-mobile-halfway');
        sheet.style.height = full ? '100dvh' : '50dvh';
        sheet.style.maxHeight = full ? '100dvh' : '50dvh';
    }

    function clearTicketHubDetailSheetMobileHeight(sheet) {
        if (!TICKET_HUB_MOBILE_DETAIL_SHEET_ENABLED) return;
        if (!sheet) return;
        sheet.classList.remove('ticket-hub-detail-mobile-halfway', 'ticket-hub-detail-mobile-full');
        sheet.style.height = '';
        sheet.style.maxHeight = '';
    }

    function syncTicketHubDetailMobileHeightToggle() {
        if (!TICKET_HUB_MOBILE_DETAIL_SHEET_ENABLED) return;
        const btn = document.getElementById('ticketHubDetailMobileHeightToggle');
        const modal = document.getElementById('ticketHubDetailModal');
        if (!btn || !modal) return;
        const sheet = modal.querySelector('.ticket-hub-detail-modal-sheet');
        if (!sheet || !isTicketHubMobile() || !modal.classList.contains('ticket-hub-detail-modal-open')) {
            btn.hidden = true;
            return;
        }
        btn.hidden = false;
        const isFull = sheet.classList.contains('ticket-hub-detail-mobile-full');
        const label = isFull ? 'Collapse to half screen' : 'Expand to full screen';
        btn.setAttribute('aria-label', label);
        btn.title = label;
    }

    function toggleTicketHubDetailMobileHeight() {
        if (!TICKET_HUB_MOBILE_DETAIL_SHEET_ENABLED) return;
        const modal = document.getElementById('ticketHubDetailModal');
        if (!modal || !isTicketHubMobile()) return;
        const sheet = modal.querySelector('.ticket-hub-detail-modal-sheet');
        if (!sheet) return;
        const toFull = !sheet.classList.contains('ticket-hub-detail-mobile-full');
        applyTicketHubDetailSheetMobileHeight(sheet, toFull ? 'full' : 'half');
        syncTicketHubDetailMobileHeightToggle();
    }

    /** Mobile hub row select uses the map popup; avoid stacking the hub detail sheet on redraw/refresh. */
    function hubMobileUsesTicketPopupForSelection(ticket) {
        if (!TICKET_HUB_MOBILE_DETAIL_SHEET_ENABLED) return true;
        if (!isTicketHubMobile() || !ticket || selectedHubTicketId == null) return false;
        if (!idsMatch(selectedHubTicketId, ticket.id)) return false;
        const hubWin = document.getElementById('ticketHubWindow');
        if (!hubWin || !hubWin.classList.contains('show')) return false;
        const popup = document.getElementById('ticketPopup');
        return !!(popup && popup.classList.contains('ticket-popup--above-hub'));
    }

    function openTicketHubDetailModal() {
        if (isTicketHubMobile() && !TICKET_HUB_MOBILE_DETAIL_SHEET_ENABLED) return;
        const modal = document.getElementById('ticketHubDetailModal');
        if (!modal) return;
        const sheet = modal.querySelector('.ticket-hub-detail-modal-sheet');
        if (sheet && isTicketHubMobile()) {
            // Always open at half height; use the header expand control for full screen.
            applyTicketHubDetailSheetMobileHeight(sheet, 'half');
        }
        modal.classList.add('ticket-hub-detail-modal-open');
        modal.setAttribute('aria-hidden', 'false');
        syncTicketHubDetailMobileHeightToggle();
        registerTicketHubDetailBack();
    }
    /* --- end mobile hub detail bottom sheet --- */

    /** Hide sheet DOM only (internal). Does not clear list selection. */
    function hideTicketHubDetailModal(opts) {
        const options = opts || {};
        closeHubOperatorResponseDetailModal();
        closeHubResponseCodeDetailModal();
        const modal = document.getElementById('ticketHubDetailModal');
        if (!modal) return;
        modal.classList.remove('ticket-hub-detail-modal-open');
        modal.setAttribute('aria-hidden', 'true');
        const inner = document.getElementById('ticketHubDetailModalInner');
        if (inner) inner.innerHTML = '';
        const sheet = modal.querySelector('.ticket-hub-detail-modal-sheet');
        clearTicketHubDetailSheetMobileHeight(sheet);
        syncTicketHubDetailMobileHeightToggle();
        unregisterTicketHubDetailBack(options.fromBack);
    }

    /**
     * Desktop: reuse #ticketHubSearch under Ticket Hub status counts.
     * Mobile: keep search in the existing Search & filters sheet (do not stack it on the map fan).
     */
    function relocateTicketHubSearchField() {
        const wrap = document.getElementById('ticketHubSearchWrap');
        const host = document.getElementById('ticketHubStatsSearchHost');
        const pack = document.getElementById('ticketHubFiltersPack');
        if (!wrap) return;
        const mobile = typeof isTicketHubMobile === 'function' && isTicketHubMobile();
        const feedMode =
            typeof window.isTicketHubFeedMode === 'function' && window.isTicketHubFeedMode();
        const hubWin = document.getElementById('ticketHubWindow');
        const hubOpen = !!(hubWin && hubWin.classList.contains('show'));
        const showUnderHubStats = !mobile && !feedMode && hubOpen && host;
        if (showUnderHubStats) {
            if (wrap.parentElement !== host) host.appendChild(wrap);
            host.hidden = false;
            return;
        }
        if (host) {
            host.hidden = true;
        }
        if (pack && wrap.parentElement !== pack) {
            pack.insertBefore(wrap, pack.firstChild);
        }
    }

    /**
     * Search + filter controls live in #ticketHubFiltersPack inside the Ticket Hub filters modal.
     */
    function relocateTicketHubFilterControls() {
        const pack = document.getElementById('ticketHubFiltersPack');
        const modalBody = document.getElementById('ticketHubFiltersModalBody');

        if (pack && modalBody && pack.parentElement !== modalBody) {
            modalBody.appendChild(pack);
        }
        relocateTicketHubSearchField();
        if (typeof syncHubMobileFilterConstraints === 'function') {
            syncHubMobileFilterConstraints();
        }
    }

    /** Back-compat alias: callers expect the filters pack to be relocated to its current home. */
    function relocateTicketHubFiltersPack() {
        relocateTicketHubFilterControls();
    }

    function syncFilterOverlayScroll(root) {
        const mod = window.overlayScrollModule;
        if (!mod || typeof mod.ensureOverlayScroll !== 'function' || !root) return;
        mod.ensureOverlayScroll(root);
    }

    function syncMapStatusStatsOverlayScroll(mapContainer) {
        if (!mapContainer) return;
        const primaryRow = mapContainer.querySelector('.ticket-hub-stats-primary-row');
        if (primaryRow) {
            primaryRow.classList.add('app-overlay-scroll-x');
        }
        syncFilterOverlayScroll(mapContainer);
    }

    /** Reflect active search/filter state on the status-bar and Ticket Hub toolbar icon buttons. */
    function syncMapStatusActionButtons() {
        const hasActive = isHubListFilteredBeyondDefaults();
        const filtersBtn = document.getElementById('mapStatusFiltersBtn');
        if (filtersBtn) {
            filtersBtn.classList.toggle('map-status-action-btn--active', hasActive);
        }
        const hubFiltersBtn = document.getElementById('ticketHubFiltersOpenBtn');
        if (hubFiltersBtn) {
            hubFiltersBtn.classList.toggle('ticket-hub-toolbar-action-btn--active', hasActive);
        }
    }

    function getMapStatusDropdown() {
        return document.getElementById('mapStatusFiltersDropdown');
    }

    function getMapStatusButton() {
        return document.getElementById('mapStatusFiltersBtn');
    }

    function closeMapStatusDropdowns() {
        const dd = getMapStatusDropdown();
        const btn = getMapStatusButton();
        if (dd) dd.hidden = true;
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    /** Focus the text search field so the user can type immediately. */
    function primeTicketHubSearchInput() {
        const focusSearch = function () {
            const input = document.getElementById('ticketHubSearch');
            if (!input) return;
            const wrap = document.getElementById('ticketHubSearchWrap');
            if (wrap && typeof wrap.scrollIntoView === 'function') {
                try {
                    wrap.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                } catch (_) {
                    wrap.scrollIntoView();
                }
            }
            try {
                input.focus({ preventScroll: true });
            } catch (_) {
                input.focus();
            }
            // Select existing query so the next keystroke replaces it.
            if (typeof input.select === 'function' && String(input.value || '').length > 0) {
                input.select();
            }
        };
        // Sync focus keeps the mobile keyboard tied to the click gesture.
        focusSearch();
        // Re-run after paint in case relocate/layout moved the input.
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
                requestAnimationFrame(focusSearch);
            });
        } else {
            setTimeout(focusSearch, 0);
        }
    }

    function toggleMapStatusDropdown(which) {
        // `which` kept for callers; search now lives inside the filters dropdown.
        if (which && which !== 'filters' && which !== 'search') return;
        if (typeof window.ensureMapHubOverlaysOnBody === 'function') {
            window.ensureMapHubOverlaysOnBody();
        }
        const dd = getMapStatusDropdown();
        const btn = getMapStatusButton();
        if (!dd) return;
        const willOpen = dd.hidden;
        dd.hidden = !willOpen;
        if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (willOpen) {
            relocateTicketHubFilterControls();
            syncHubFilterControls();
            primeTicketHubSearchInput();
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(function () {
                    syncFilterOverlayScroll(dd);
                });
            } else {
                syncFilterOverlayScroll(dd);
            }
        }
    }

    /** Search now lives in filters; keep stubs for older callers. */
    function closeTicketHubSearchModal() {}

    function openTicketHubSearchModal() {
        openTicketHubFiltersModal();
    }

    function clearTicketHubSearch() {
        const searchEl = document.getElementById('ticketHubSearch');
        if (searchEl) searchEl.value = '';
        if (typeof window.onTicketHubFilterChange === 'function') window.onTicketHubFilterChange();
    }

    function closeTicketHubFiltersModal(opts) {
        const o = opts || {};
        const modal = document.getElementById('ticketHubFiltersModal');
        if (!modal) return;
        modal.classList.remove('ticket-hub-detail-modal-open');
        modal.setAttribute('aria-hidden', 'true');
        const openBtn = document.getElementById('ticketHubFiltersOpenBtn');
        if (openBtn) openBtn.setAttribute('aria-expanded', 'false');
        unregisterTicketHubFiltersBack(o.fromBack);
        if (o.restoreDetail === false) return;
        // MOBILE_HUB_DETAIL_SHEET_DISABLED: if (wasOpen && isTicketHubMobile() && selectedHubTicketId) renderHubDetail();
    }

    /** Mobile filters sheet: close filters + hub so the map shows current filter results. */
    function viewMapFromTicketHubFilters() {
        closeTicketHubFiltersModal();
        if (typeof window.closeTicketHubWindow === 'function') {
            window.closeTicketHubWindow();
        }
    }

    function openTicketHubFiltersModal() {
        relocateTicketHubFilterControls();
        const win = document.getElementById('ticketHubWindow');
        if (!win || !win.classList.contains('show')) {
            if (
                typeof isTicketHubMobile === 'function' &&
                !isTicketHubMobile() &&
                typeof window.ensureDesktopTicketHubOpen === 'function'
            ) {
                void Promise.resolve(window.ensureDesktopTicketHubOpen()).then(function () {
                    openTicketHubFiltersModal();
                });
            }
            return;
        }
        const modal = document.getElementById('ticketHubFiltersModal');
        if (!modal) return;
        hideTicketHubDetailModal();
        modal.classList.add('ticket-hub-detail-modal-open');
        modal.setAttribute('aria-hidden', 'false');
        const openBtn = document.getElementById('ticketHubFiltersOpenBtn');
        if (openBtn) openBtn.setAttribute('aria-expanded', 'true');
        registerTicketHubFiltersBack();
        syncHubFilterControls();
        primeTicketHubSearchInput();
        const filtersBody = document.getElementById('ticketHubFiltersModalBody');
        if (filtersBody) {
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(function () {
                    syncFilterOverlayScroll(filtersBody);
                });
            } else {
                syncFilterOverlayScroll(filtersBody);
            }
        }
    }

    /**
     * User closed the mobile detail sheet (X, backdrop). Clear selection so filter/stat
     * changes do not immediately reopen the same ticket.
     */
    function dismissTicketHubDetailModal(opts) {
        const options = opts || {};
        hideTicketHubDetailModal({ fromBack: options.fromBack });
        if (TICKET_HUB_MOBILE_DETAIL_SHEET_ENABLED && isTicketHubMobile()) {
            selectedHubTicketId = null;
            renderHubTable();
        }
    }

    function closeTicketHubDetailModal() {
        dismissTicketHubDetailModal();
    }

    function wireTicketHubDetailTabs(container, ticket) {
        if (!container || typeof window.wireTicketDetailTabs !== 'function') return;
        window.wireTicketDetailTabs(container, {
            onTabChange(tabId) {
                if (tabId !== 'notes') return;
                const notesPanel = container.querySelector('[data-ticket-detail-panel="notes"]');
                if (!notesPanel) return;
                if (typeof window.wireTicketNotesPanel === 'function') {
                    window.wireTicketNotesPanel(notesPanel, ticket);
                }
                if (notesPanel.dataset.ticketNotesLoaded === '1') return;
                notesPanel.dataset.ticketNotesLoaded = '1';
                if (typeof window.loadTicketNotesForPanel === 'function') {
                    void window.loadTicketNotesForPanel(ticket, notesPanel);
                }
            },
        });
    }

    function hubNeedsFreshOperatorResponses(ticket) {
        if (!ticket || !ticket.ticketNumber || !window.ticketsModule) return false;
        // canShow can be true after db-detail (hasFullDetail) even while the UI still
        // defers an empty table (POSR / nGen counts). Must still kick ensure in that case.
        if (
            typeof window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState === 'function' &&
            window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState(ticket)
        ) {
            return true;
        }
        return (
            typeof window.ticketsModule.canShowTicketOperatorResponsesNow === 'function' &&
            !window.ticketsModule.canShowTicketOperatorResponsesNow(ticket)
        );
    }

    function scheduleHubDetailAuxiliaryLoad(container, ticket) {
        if (!container || !ticket) return;
        const ticketIdKey = ticket.id != null ? String(ticket.id) : '';
        // History fetch is background-only. Do not redraw from this path; a start-of-fetch
        // redraw used to re-enter hub detail until Maximum call stack size exceeded.
        if (typeof window.scheduleNgenProviderResponseHistoryIfNeeded === 'function') {
            window.scheduleNgenProviderResponseHistoryIfNeeded(ticket);
        }
        void Promise.resolve().then(() => {
            if (typeof window.fetchTicketNotesReviewStatus !== 'function') return;
            void window.fetchTicketNotesReviewStatus(ticket).then(() => {
                const hubBody =
                    container.querySelector('.ticket-hub-detail-body-wrap') ||
                    container.closest('.ticket-hub-detail-body-wrap') ||
                    container;
                if (!hubBody || hubBody.getAttribute('data-hub-detail-ticket-id') !== ticketIdKey) return;
                if (typeof window.updateTicketDetailTabDot === 'function') {
                    window.updateTicketDetailTabDot(
                        hubBody,
                        'notes',
                        ticket.notesReviewRequired ? 'action-required' : null
                    );
                }
            });
        });
    }

    function syncHubDetailSplitVisible(showDetailPanel) {
        if (typeof isTicketHubMobile === 'function' && isTicketHubMobile()) return;
        const split = document.getElementById('ticketHubSplit');
        const panel = document.getElementById('ticketHubDetail');
        const resizer = document.getElementById('ticketHubSplitResizer');
        const hub = document.getElementById('ticketHubWindow');
        if (split) {
            split.classList.add('ticket-hub-split--no-detail');
        }
        if (resizer) {
            resizer.hidden = true;
        }
        if (!panel) return;
        panel.classList.add('ticket-hub-detail-panel--sheet');
        if (hubDetailSheetCloseTimer) {
            clearTimeout(hubDetailSheetCloseTimer);
            hubDetailSheetCloseTimer = null;
        }
        if (showDetailPanel) {
            if (hub) hub.classList.add('ticket-hub-window--sheet-open');
            panel.hidden = false;
            panel.setAttribute('aria-hidden', 'false');
            panel.classList.remove('ticket-hub-detail-panel--closing');
            if (!panel.classList.contains('ticket-hub-detail-panel--open')) {
                panel.classList.remove('ticket-hub-detail-panel--open');
                void panel.offsetWidth;
                requestAnimationFrame(function () {
                    panel.classList.add('ticket-hub-detail-panel--open');
                });
            }
            return;
        }
        if (hub) hub.classList.remove('ticket-hub-window--sheet-open');
        if (panel.hidden || !panel.classList.contains('ticket-hub-detail-panel--open')) {
            panel.classList.remove('ticket-hub-detail-panel--open', 'ticket-hub-detail-panel--closing');
            panel.hidden = true;
            panel.setAttribute('aria-hidden', 'true');
            return;
        }
        panel.classList.remove('ticket-hub-detail-panel--open');
        panel.classList.add('ticket-hub-detail-panel--closing');
        panel.setAttribute('aria-hidden', 'true');
        hubDetailSheetCloseTimer = setTimeout(function () {
            hubDetailSheetCloseTimer = null;
            panel.classList.remove('ticket-hub-detail-panel--closing');
            panel.hidden = true;
            panel.onclick = null;
            panel.innerHTML = '';
        }, HUB_DETAIL_SHEET_CLOSE_MS);
    }

    function renderHubDetail() {
        const ackModal = document.getElementById('workflowAckModal');
        if (ackModal && ackModal.style.display && ackModal.style.display !== 'none') return;
        if (hubDetailRenderDepth > 0) return;
        hubDetailRenderDepth += 1;
        try {
            renderHubDetailInner();
        } finally {
            hubDetailRenderDepth -= 1;
        }
    }

    function renderHubDetailInner() {
        const panel = document.getElementById('ticketHubDetail');
        const modalInner = document.getElementById('ticketHubDetailModalInner');
        const mobile = isTicketHubMobile();
        const ticket = findTicketForHub(selectedHubTicketId);
        const pending =
            hubPendingOpen &&
            selectedHubTicketId != null &&
            idsMatch(hubPendingOpen.ticketId, selectedHubTicketId)
                ? hubPendingOpen
                : null;

        function syncHubSidebarExpanded(_expanded) {
            if (
                window.ticketHubDockModule &&
                typeof window.ticketHubDockModule.setExpanded === 'function'
            ) {
                window.ticketHubDockModule.setExpanded(false);
            }
        }

        if (!ticket) {
            if (pending) {
                syncHubDetailSplitVisible(true);
                if (panel) {
                    panel.onclick = null;
                    if (pending.error) {
                        const errLabel =
                            pending.ticketNumber != null && String(pending.ticketNumber).trim() !== ''
                                ? String(pending.ticketNumber).trim()
                                : '';
                        panel.innerHTML = `<div class="ticket-hub-detail-empty">${
                            errLabel
                                ? `Could not load ticket ${hubEscapeHtml(errLabel)}.`
                                : 'Could not load this ticket.'
                        }</div>`;
                    } else {
                        panel.innerHTML = `<div class="ticket-hub-detail-empty" aria-busy="true">${typeof window.getAppLoaderHtml === 'function' ? window.getAppLoaderHtml() : '<div class="app-loading-indicator" role="status" aria-label="Loading"></div>'}<p class="ticket-hub-loading-text">Loading ticket${window.TICKET_HUB_TEXT.ELLIPSIS}</p></div>`;
                    }
                }
                hideTicketHubDetailModal();
                syncHubSidebarExpanded(true);
                return;
            }
            selectedHubTicketId = null;
            syncHubDetailSplitVisible(false);
            hideTicketHubDetailModal();
            syncHubSidebarExpanded(false);
            renderHubTable();
            return;
        }

        if (pending && !pending.error) {
            hubPendingOpen = null;
        }

        const refreshBusy =
            window.ticketsModule &&
            typeof window.ticketsModule.ticketSelectionRefreshLoading === 'function' &&
            window.ticketsModule.ticketSelectionRefreshLoading(ticket);
        const detailInner = buildTicketHubDetailInnerHtml(ticket);
        const refreshLockHtml = refreshBusy
            ? `<div class="ticket-hub-detail-refresh-lock" aria-busy="true" aria-live="polite"><div class="ticket-hub-detail-refresh-inner">${typeof window.getAppLoaderHtml === 'function' ? window.getAppLoaderHtml() : '<div class="app-loading-indicator" role="status" aria-label="Loading"></div>'}<p class="ticket-hub-loading-text">Refreshing ticket${window.TICKET_HUB_TEXT.ELLIPSIS}</p></div></div>`
            : '';
        const html = `<div class="ticket-hub-detail-body-wrap" data-hub-detail-ticket-id="${ticket.id != null ? String(ticket.id) : ''}">${detailInner}${refreshLockHtml}</div>`;

        if (mobile && modalInner) {
            // MOBILE_HUB_DETAIL_SHEET_DISABLED — mobile hub uses map popup only; see TICKET_HUB_MOBILE_DETAIL_SHEET_ENABLED.
            hideTicketHubDetailModal();
            return;
            /*
            if (hubMobileUsesTicketPopupForSelection(ticket)) {
                hideTicketHubDetailModal();
                return;
            }
            closeTicketHubFiltersModal({ restoreDetail: false });
            closeTicketHubSearchModal({ restoreDetail: false });
            if (panel) {
                panel.onclick = null;
                panel.innerHTML = '';
            }
            modalInner.innerHTML = html;
            bindHubDetailPanelActions(modalInner, ticket);
            wireTicketHubDetailAssigneeBtn(modalInner, ticket);
            wireTicketHubDetailProjectsField(modalInner, ticket);
            wireTicketHubCollapsibleSections(modalInner);
            wireTicketHubDetailTabs(modalInner, ticket);
            injectHubAuxiliaryDetailData(modalInner, ticket);
            scheduleHubDetailAuxiliaryLoad(modalInner, ticket);
            openTicketHubDetailModal();
            const titleEl = document.getElementById('ticketHubDetailModalTitle');
            if (titleEl) titleEl.textContent = 'Ticket details';
            */
        } else {
            hideTicketHubDetailModal();
            if (!panel) return;
            syncHubDetailSplitVisible(true);
            panel.innerHTML = html;
            bindHubDetailPanelActions(panel, ticket);
            wireTicketHubDetailAssigneeBtn(panel, ticket);
            wireTicketHubDetailProjectsField(panel, ticket);
            wireTicketHubCollapsibleSections(panel);
            wireTicketHubDetailTabs(panel, ticket);
            injectHubAuxiliaryDetailData(panel, ticket);
            scheduleHubDetailAuxiliaryLoad(panel, ticket);
        }
        syncHubSidebarExpanded(true);
    }

    function beginHubPendingOpen(ticketId, meta) {
        const m = meta || {};
        hubPendingOpen = {
            ticketId,
            ticketNumber: m.ticketNumber != null ? m.ticketNumber : null,
            error: null,
        };
        selectedHubTicketId = ticketId;
        renderHubDetail();
        if (typeof renderHubTable === 'function') renderHubTable();
    }

    function failHubPendingOpen(ticketId, message) {
        const prevNumber =
            hubPendingOpen && idsMatch(hubPendingOpen.ticketId, ticketId)
                ? hubPendingOpen.ticketNumber
                : null;
        hubPendingOpen = {
            ticketId,
            ticketNumber: prevNumber,
            error: message || 'load_failed',
        };
        selectedHubTicketId = ticketId;
        renderHubDetail();
    }

    function clearHubPendingOpen(ticketId) {
        if (ticketId != null && hubPendingOpen && !idsMatch(hubPendingOpen.ticketId, ticketId)) {
            return;
        }
        hubPendingOpen = null;
    }

    function maybeRefreshHubTicketResponses(ticket, prevId, ticketId) {
        if (
            ticket &&
            !idsMatch(prevId, ticketId) &&
            hubNeedsFreshOperatorResponses(ticket) &&
            window.ticketsModule &&
            typeof window.ticketsModule.ensureTicketOperatorResponsesLoaded === 'function'
        ) {
            void window.ticketsModule.ensureTicketOperatorResponsesLoaded(ticket.ticketNumber, { ticket });
        }
    }

    function hubSelectRow(ticketId, opts) {
        const rowOpts = opts || {};
        const prevId = selectedHubTicketId;
        const ticket = findTicketForHub(ticketId);
        const feedMode =
            typeof window.isTicketHubFeedMode === 'function' && window.isTicketHubFeedMode();
        if (isTicketHubMobile() && ticket) {
            selectedHubTicketId = ticketId;
            hideTicketHubDetailModal();
            if (typeof window.closeTicketHubWindow === 'function') {
                window.closeTicketHubWindow({ preserveSelection: true });
            }
            if (typeof window.showTicketPopup === 'function') {
                const mobileHeight =
                    rowOpts.mobileHeight === 'full' || rowOpts.mobileHeight === 'half'
                        ? rowOpts.mobileHeight
                        : 'half';
                void window.showTicketPopup(ticket, {
                    mobileHeight,
                    skipDetailHydrate: !!(ticket && ticket.__feedWorkspaceView),
                });
            }
            if (
                isTicketHubAccessible() &&
                !idsMatch(prevId, ticketId) &&
                !isHubTicketExternalForOrg(ticket)
            ) {
                void recordTicketHubView(ticket);
            }
            if (!(ticket && ticket.__feedWorkspaceView)) {
                maybeRefreshHubTicketResponses(ticket, prevId, ticketId);
            }
            if (typeof window.panMapToTicketAboveBottomChrome === 'function') {
                window.panMapToTicketAboveBottomChrome(ticket);
            }
            return;
        }
        if (typeof window.hideTicketPopupKeepSelection === 'function') {
            window.hideTicketPopupKeepSelection();
        }
        selectedHubTicketId = ticketId;
        // Feed queue owns the table DOM — do not replace it with the normal ticket table.
        if (!feedMode) renderHubTable();
        renderHubDetail();
        if (
            ticket &&
            isTicketHubAccessible() &&
            !idsMatch(prevId, ticketId) &&
            !isHubTicketExternalForOrg(ticket)
        ) {
            void recordTicketHubView(ticket);
        }
        if (!(ticket && ticket.__feedWorkspaceView)) {
            maybeRefreshHubTicketResponses(ticket, prevId, ticketId);
            maybeRefreshHubTicketFullDetailFromNgen(ticket, prevId, ticketId);
        }
        if (ticket && typeof window.panMapToTicketAboveBottomChrome === 'function') {
            window.panMapToTicketAboveBottomChrome(ticket);
        }
    }

    /**
     * Documentation feed: show owner-org ticket in the hub detail panel (desktop)
     * or map popup (mobile), without wiping the feed SR table.
     */
    function hubSelectFeedTicketDetail(ticket) {
        if (!ticket || ticket.id == null) return;
        window.__FEED_HUB_DETAIL_TICKET = ticket;
        hubSelectRow(ticket.id);
    }

    function maybeRefreshHubTicketFullDetailFromNgen(ticket, prevId, ticketId) {
        if (
            !ticket ||
            !window.ticketsModule ||
            typeof window.ticketsModule.ticketMayAutoRefreshOnPopupOpen !== 'function' ||
            !window.ticketsModule.ticketMayAutoRefreshOnPopupOpen(ticket) ||
            !window.ticketHubModule ||
            typeof window.ticketHubModule.refreshTicketDetail !== 'function'
        ) {
            return;
        }
        void window.ticketHubModule.refreshTicketDetail(ticket, null, { silent: true, forceRefresh: false, popupOpen: true });
    }

    function refreshTicketHubWindow() {
        if (typeof window.isTicketHubFeedMode === 'function' && window.isTicketHubFeedMode()) {
            if (
                window.ticketHubFeedModule &&
                typeof window.ticketHubFeedModule.loadFeedHubQueue === 'function'
            ) {
                void window.ticketHubFeedModule.loadFeedHubQueue(true);
            }
            return;
        }
        syncHubFilterControls();
        renderHubStats();
        renderHubTable();
        renderHubDetail();
    }

    function handleTicketDeleted(ticketId) {
        if (idsMatch(selectedHubTicketId, ticketId)) {
            selectedHubTicketId = null;
            hubPendingOpen = null;
        }
        hubBulkSelectedIds.delete(String(ticketId));
        refreshTicketHubWindow();
        if (typeof window.redrawTicketHubComplianceIfOpen === 'function') {
            window.redrawTicketHubComplianceIfOpen();
        }
    }

    function redrawIfOpen() {
        if (typeof window.isTicketHubFeedMode === 'function' && window.isTicketHubFeedMode()) {
            // Keep feed Ready/Not ready stats; do not rebuild from leftover ORG_TICKETS.
            // Use renderHubStats so the map status bar is cleared/hidden too.
            renderHubStats();
            return;
        }
        renderHubStats();
        const win = document.getElementById('ticketHubWindow');
        if (!win || !win.classList.contains('show')) return;
        syncHubFilterControls();
        renderHubTable();
        renderHubDetail();
        if (typeof window.redrawTicketHubComplianceIfOpen === 'function') {
            window.redrawTicketHubComplianceIfOpen();
        }
        if (typeof window.redrawTicketHubAnalyticsIfOpen === 'function') {
            window.redrawTicketHubAnalyticsIfOpen();
        }
    }

    let hubStateSaveTimer = null;

    /** Last successful PUT body `{ organizationId, state }`; cleared when org context changes. */
    let ticketHubPersistLastBodyJson = null;
    /** Org id matching `ticketHubPersistLastBodyJson`, or last baseline snapshot org. */
    let ticketHubPersistLastOrgId = null;

    function canPersistHubStateForCurrentOrg() {
        const orgId = getHubOrganizationId();
        if (orgId == null || orgId === '') return false;
        const m = window.authModule;
        const currentUser = m && typeof m.getCurrentUser === 'function' ? m.getCurrentUser() : null;
        if (!currentUser) return false;
        if (currentUser.role === 'dev') return true;
        const ids = currentUser.organizationIds || [];
        return ids.map(Number).includes(Number(orgId));
    }

    function collectTicketHubPersistedState() {
        const searchEl = document.getElementById('ticketHubSearch');
        const assignEl = document.getElementById('ticketHubAssigneeFilter');
        const timeframeEl = document.getElementById('ticketHubTimeframe');
        const timeframeTypeEl = document.getElementById('ticketHubTimeframeType');
        const fromEl = document.getElementById('ticketHubFromDate');
        const toEl = document.getElementById('ticketHubToDate');
        const ownerOrgEl = document.getElementById('ticketHubOwnerOrgFilter');
        const submittedByEl = document.getElementById('ticketHubSubmittedByFilter');
        const sortEl = document.getElementById('ticketHubListSort');
        return {
            search: searchEl && searchEl.value != null ? String(searchEl.value) : '',
            assignee: assignEl && assignEl.value != null ? String(assignEl.value) : '',
            submittedBy: submittedByEl && submittedByEl.value != null ? String(submittedByEl.value) : 'all',
            timeframeType:
                timeframeTypeEl && timeframeTypeEl.value != null ? String(timeframeTypeEl.value) : 'expiration',
            timeframe: timeframeEl && timeframeEl.value != null ? String(timeframeEl.value) : 'all',
            fromDate: fromEl && fromEl.value != null ? String(fromEl.value) : '',
            toDate: toEl && toEl.value != null ? String(toEl.value) : '',
            ownerOrg: ownerOrgEl && ownerOrgEl.value != null ? String(ownerOrgEl.value) : 'all',
            listSort:
                typeof normalizeHubListSort === 'function'
                    ? normalizeHubListSort(sortEl && sortEl.value)
                    : sortEl && sortEl.value != null
                      ? String(sortEl.value)
                      : 'expiring_soonest',
        };
    }

    function buildTicketHubPersistRequestBody(orgNumeric) {
        return { organizationId: orgNumeric, state: collectTicketHubPersistedState() };
    }

    /**
     * Mark current DOM-backed hub filters as already persisted so we skip redundant PUTs
     * (opening the hub triggers a synthetic filter refresh that would otherwise save).
     */
    function rememberTicketHubPersistedBaselineFromDom() {
        if (hubStateSaveTimer) {
            clearTimeout(hubStateSaveTimer);
            hubStateSaveTimer = null;
        }
        if (!canPersistHubStateForCurrentOrg() || !window.authModule) {
            ticketHubPersistLastOrgId = null;
            ticketHubPersistLastBodyJson = null;
            return;
        }
        const orgId = getHubOrganizationId();
        if (orgId == null) return;
        const n = parseInt(String(orgId), 10);
        if (!Number.isFinite(n)) return;
        ticketHubPersistLastOrgId = n;
        ticketHubPersistLastBodyJson = JSON.stringify(buildTicketHubPersistRequestBody(n));
    }

    /**
     * @param {boolean} [keepalive] - use fetch keepalive during page unload where supported.
     */
    function persistTicketHubStateIfChanged(keepalive) {
        if (!canPersistHubStateForCurrentOrg() || !window.authModule) {
            return Promise.resolve(false);
        }
        const orgId = getHubOrganizationId();
        if (orgId == null) return Promise.resolve(false);
        const n = parseInt(String(orgId), 10);
        if (!Number.isFinite(n)) return Promise.resolve(false);
        if (ticketHubPersistLastOrgId !== null && ticketHubPersistLastOrgId !== n) {
            ticketHubPersistLastBodyJson = null;
        }
        const bodyJson = JSON.stringify(buildTicketHubPersistRequestBody(n));
        if (bodyJson === ticketHubPersistLastBodyJson) return Promise.resolve(false);
        return window.authModule
            .apiRequest('users/me/ticket-hub-state', {
                method: 'PUT',
                body: bodyJson,
                keepalive: keepalive === true,
            })
            .then(function () {
                ticketHubPersistLastBodyJson = bodyJson;
                ticketHubPersistLastOrgId = n;
                return true;
            })
            .catch(function () {
                /* KV optional */
            });
    }

    function scheduleSaveTicketHubStateToServer() {
        if (hubStateSaveTimer) clearTimeout(hubStateSaveTimer);
        hubStateSaveTimer = setTimeout(function saveHub() {
            hubStateSaveTimer = null;
            void persistTicketHubStateIfChanged(false);
        }, 1500);
    }

    async function onHubFilterChange() {
        syncHubFilterControls();
        scheduleSaveTicketHubStateToServer();
        try {
            if (window.ticketsModule && typeof window.ticketsModule.loadHubTicketSliceForCurrentFilters === 'function') {
                await window.ticketsModule.loadHubTicketSliceForCurrentFilters({ pageDirection: 'first', forceRefresh: true });
            } else if (typeof hubStatusFilterNeedsExpiredFetch === 'function' && hubStatusFilterNeedsExpiredFetch()) {
                if (window.ticketsModule && typeof window.ticketsModule.loadExpiredTicketsForHub === 'function') {
                    await window.ticketsModule.loadExpiredTicketsForHub({ pageDirection: 'first', forceRefresh: true });
                }
            } else if (window.ticketsModule && typeof window.ticketsModule.clearHubTicketSlices === 'function') {
                window.ticketsModule.clearHubTicketSlices();
            } else if (window.ticketsModule && typeof window.ticketsModule.clearHubExpiredTickets === 'function') {
                window.ticketsModule.clearHubExpiredTickets();
            }
        } catch (e) {
            console.error('Ticket hub: load ticket slice', e);
        }
        if (window.ticketsModule && typeof window.ticketsModule.hydrateHubTicketJobNames === 'function') {
            try {
                await window.ticketsModule.hydrateHubTicketJobNames();
            } catch (_e) {
                /* hydrateHubTicketJobNames already logs */
            }
        }
        refreshTicketHubWindow();
        if (window.renderTickets) window.renderTickets();
        if (
            window.ticketsModule &&
            typeof window.ticketsModule.scheduleViewportPolygonBackfillForVisibleTickets === 'function'
        ) {
            window.ticketsModule.scheduleViewportPolygonBackfillForVisibleTickets();
        }
    }

    /**
     * Restore hub list/map filters to defaults (Active-only status, cleared search, no polygon, etc.).
     * @param {{ forOrgSwitch?: boolean }} [opts]
     *   forOrgSwitch: clear in-memory + DOM, skip debounced save races, immediately persist
     *   defaults for the new org, and skip the next hub-open restore so sticky KV state cannot
     *   undo the reset.
     */
    function resetTicketHubFilters(opts) {
        const options = opts || {};
        const forOrgSwitch = options.forOrgSwitch === true;

        const searchEl = document.getElementById('ticketHubSearch');
        if (searchEl) searchEl.value = '';
        const assignEl = document.getElementById('ticketHubAssigneeFilter');
        if (assignEl) assignEl.value = 'all';
        const submittedByEl = document.getElementById('ticketHubSubmittedByFilter');
        if (submittedByEl) submittedByEl.value = 'all';
        hubPartnerSharedFilter = false;
        const tftEl = document.getElementById('ticketHubTimeframeType');
        if (tftEl) tftEl.value = 'expiration';
        const tfEl = document.getElementById('ticketHubTimeframe');
        if (tfEl) tfEl.value = 'all';
        const fromEl = document.getElementById('ticketHubFromDate');
        const toEl = document.getElementById('ticketHubToDate');
        if (fromEl) fromEl.value = '';
        if (toEl) toEl.value = '';
        const ownerEl = document.getElementById('ticketHubOwnerOrgFilter');
        if (ownerEl) ownerEl.value = 'all';
        const sortEl = document.getElementById('ticketHubListSort');
        if (sortEl) sortEl.value = 'expiring_soonest';
        if (typeof clearHubTicketTypeAndEnquiryFilters === 'function') {
            clearHubTicketTypeAndEnquiryFilters();
        }
        clearHubDirectSearchHit();
        hubStatusFilters = new Set(['ACTIVE']);
        if (typeof window.collapseHubMobileAdvancedFilters === 'function') {
            window.collapseHubMobileAdvancedFilters();
        }
        syncHubFilterControls();
        clearTicketHubSearchPolygon();
        if (window.ticketsModule && typeof window.ticketsModule.clearHubTicketSlices === 'function') {
            window.ticketsModule.clearHubTicketSlices();
        } else if (window.ticketsModule && typeof window.ticketsModule.clearHubExpiredTickets === 'function') {
            window.ticketsModule.clearHubExpiredTickets();
        }

        if (forOrgSwitch) {
            // Cancel any pending save of pre-switch filters, then write cleared defaults now
            // so a fast Ticket Hub reopen cannot reload sticky per-org KV state.
            if (hubStateSaveTimer) {
                clearTimeout(hubStateSaveTimer);
                hubStateSaveTimer = null;
            }
            ticketHubPersistLastBodyJson = null;
            window.__ticketHubSkipNextStateRestore = true;
            void persistTicketHubStateIfChanged(false).then(function () {
                rememberTicketHubPersistedBaselineFromDom();
            });
            if (typeof window.renderHubStats === 'function') window.renderHubStats();
            if (window.renderTickets) window.renderTickets();
            return;
        }

        onHubFilterChange();
    }

    function getHubWindowViewportLimits() {
        const vw = typeof window !== 'undefined' ? window.innerWidth || 0 : 0;
        const vh = typeof window !== 'undefined' ? window.innerHeight || 0 : 0;
        const maxWidth = Math.max(320, vw - HUB_WINDOW_VIEWPORT_GUTTER * 2);
        const maxHeight = Math.max(280, vh - HUB_WINDOW_VIEWPORT_GUTTER * 2);
        return {
            gutter: HUB_WINDOW_VIEWPORT_GUTTER,
            minWidth: Math.min(HUB_WINDOW_MIN_WIDTH, maxWidth),
            minHeight: Math.min(HUB_WINDOW_MIN_HEIGHT, maxHeight),
            maxWidth: Math.min(HUB_WINDOW_MAX_WIDTH, maxWidth),
            maxHeight: Math.min(HUB_WINDOW_MAX_HEIGHT, maxHeight)
        };
    }

    function clampHubWindowToViewport(el) {
        if (!el || isTicketHubMobile()) return;
        if (el.classList.contains('ticket-hub-window--dock-left')) return;
        const limits = getHubWindowViewportLimits();
        const rect = el.getBoundingClientRect();
        const styleWidth = parseFloat(el.style.width || '');
        const styleHeight = parseFloat(el.style.height || '');
        const width = Math.max(limits.minWidth, Math.min(limits.maxWidth, styleWidth || rect.width || limits.maxWidth));
        const height = Math.max(limits.minHeight, Math.min(limits.maxHeight, styleHeight || rect.height || limits.maxHeight));
        el.style.width = width + 'px';
        el.style.height = height + 'px';

        const centered =
            (!el.style.left && !el.style.top) ||
            (el.style.transform === 'translate(-50%, -50%)' &&
                (!el.style.left || el.style.left === '50%') &&
                (!el.style.top || el.style.top === '50%'));
        if (centered) return;

        const left = parseFloat(el.style.left || '');
        const top = parseFloat(el.style.top || '');
        if (Number.isNaN(left) || Number.isNaN(top)) {
            el.style.left = Math.max(limits.gutter, (window.innerWidth - width) / 2) + 'px';
            el.style.top = Math.max(limits.gutter, (window.innerHeight - height) / 2) + 'px';
            el.style.transform = 'none';
            return;
        }

        const maxLeft = Math.max(limits.gutter, window.innerWidth - width - limits.gutter);
        const maxTop = Math.max(limits.gutter, window.innerHeight - height - limits.gutter);
        el.style.left = Math.max(limits.gutter, Math.min(maxLeft, left)) + 'px';
        el.style.top = Math.max(limits.gutter, Math.min(maxTop, top)) + 'px';
        el.style.transform = 'none';
    }

    function saveHubDimensions(el) {
        try {
            if (!el || !el.classList || !el.classList.contains('show')) return;
            clampHubWindowToViewport(el);
            const profileData = JSON.parse(localStorage.getItem(getProfileStorageKey()) || '{}');
            const rect = el.getBoundingClientRect();
            profileData.ticketHubWindowWidth = rect.width;
            profileData.ticketHubWindowHeight = rect.height;
            profileData.ticketHubWindowLeft = el.style.left || null;
            profileData.ticketHubWindowTop = el.style.top || null;
            profileData.ticketHubWindowTransform = el.style.transform || null;
            localStorage.setItem(getProfileStorageKey(), JSON.stringify(profileData));
            if (typeof window.schedulePersistUserUiPreferencesToServer === 'function') {
                window.schedulePersistUserUiPreferencesToServer();
            }
        } catch (e) {
            console.error(e);
        }
    }

    function parseHubSplitListPercentFromStorage() {
        try {
            const profileData = JSON.parse(localStorage.getItem(getProfileStorageKey()) || '{}');
            if (profileData.ticketHubSplitListPercent != null) {
                const n = parseFloat(profileData.ticketHubSplitListPercent);
                if (!Number.isNaN(n)) {
                    return Math.max(HUB_SPLIT_MIN_PCT, Math.min(HUB_SPLIT_MAX_PCT, n));
                }
            }
        } catch (e) {
            /* ignore */
        }
        // Narrow desktop default: more list room (Address column omitted).
        if (
            typeof isTicketHubNarrowTable === 'function' &&
            isTicketHubNarrowTable() &&
            typeof isTicketHubMobile === 'function' &&
            !isTicketHubMobile()
        ) {
            return 68;
        }
        return 55;
    }

    function applyTicketHubSplitFromProfile() {
        const split = document.getElementById('ticketHubSplit');
        const resizer = document.getElementById('ticketHubSplitResizer');
        if (!split) return;
        const pct = parseHubSplitListPercentFromStorage();
        split.style.setProperty('--ticket-hub-list-pct', String(pct));
        if (resizer) {
            resizer.setAttribute('aria-valuenow', String(Math.round(pct * 10) / 10));
        }
    }

    function saveTicketHubSplitPercent(pct) {
        try {
            const key = getProfileStorageKey();
            const profileData = JSON.parse(localStorage.getItem(key) || '{}');
            profileData.ticketHubSplitListPercent = pct;
            localStorage.setItem(key, JSON.stringify(profileData));
            if (typeof window.schedulePersistUserUiPreferencesToServer === 'function') {
                window.schedulePersistUserUiPreferencesToServer();
            }
        } catch (e) {
            console.error(e);
        }
    }

    function initHubSplitResize() {
        const split = document.getElementById('ticketHubSplit');
        const resizer = document.getElementById('ticketHubSplitResizer');
        if (!split || !resizer || split.dataset.hubSplitResizeInit) return;
        if (isTicketHubMobile()) return;
        split.dataset.hubSplitResizeInit = '1';

        function readSplitPct() {
            const raw = getComputedStyle(split).getPropertyValue('--ticket-hub-list-pct').trim();
            const n = parseFloat(raw || '55');
            return Number.isNaN(n) ? 55 : n;
        }

        resizer.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            hubSplitDragging = true;
            hubSplitStart = {
                x: e.clientX,
                pct: readSplitPct()
            };
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
        });

        resizer.addEventListener('keydown', function (e) {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            let pct = readSplitPct();
            const step = e.shiftKey ? 5 : 2;
            pct = e.key === 'ArrowLeft' ? pct - step : pct + step;
            pct = Math.max(HUB_SPLIT_MIN_PCT, Math.min(HUB_SPLIT_MAX_PCT, pct));
            pct = Math.round(pct * 10) / 10;
            split.style.setProperty('--ticket-hub-list-pct', String(pct));
            resizer.setAttribute('aria-valuenow', String(pct));
            saveTicketHubSplitPercent(pct);
        });

        document.addEventListener('mousemove', function hubSplitMove(e) {
            if (!hubSplitDragging) return;
            const rect = split.getBoundingClientRect();
            const w = rect.width;
            if (w < 1) return;
            const delta = e.clientX - hubSplitStart.x;
            const deltaPct = (delta / w) * 100;
            let pct = hubSplitStart.pct + deltaPct;
            pct = Math.max(HUB_SPLIT_MIN_PCT, Math.min(HUB_SPLIT_MAX_PCT, pct));
            split.style.setProperty('--ticket-hub-list-pct', String(pct));
            resizer.setAttribute('aria-valuenow', String(Math.round(pct * 10) / 10));
        });

        document.addEventListener('mouseup', function hubSplitUp() {
            if (!hubSplitDragging) return;
            hubSplitDragging = false;
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            const pct = Math.round(readSplitPct() * 10) / 10;
            saveTicketHubSplitPercent(pct);
            resizer.setAttribute('aria-valuenow', String(pct));
            hubSuppressOutsideCloseUntil = Date.now() + 400;
        });
    }

    function loadHubDimensions(el) {
        try {
            if (!el || isTicketHubMobile()) return;
            if (el.classList.contains('ticket-hub-window--dock-left')) return;
            const profileData = JSON.parse(localStorage.getItem(getProfileStorageKey()) || '{}');
            if (profileData.ticketHubWindowWidth && profileData.ticketHubWindowHeight) {
                const limits = getHubWindowViewportLimits();
                const width = Math.max(limits.minWidth, Math.min(limits.maxWidth, profileData.ticketHubWindowWidth));
                const height = Math.max(limits.minHeight, Math.min(limits.maxHeight, profileData.ticketHubWindowHeight));
                el.style.width = width + 'px';
                el.style.height = height + 'px';
                if (profileData.ticketHubWindowLeft && profileData.ticketHubWindowTop) {
                    el.style.left = profileData.ticketHubWindowLeft;
                    el.style.top = profileData.ticketHubWindowTop;
                    el.style.transform = profileData.ticketHubWindowTransform || 'none';
                } else {
                    el.style.left = '';
                    el.style.top = '';
                    el.style.transform = 'translate(-50%, -50%)';
                }
            }
        } catch (e) {
            console.error(e);
        }
    }

    function closeTicketHubOnOutsideClick(e) {
        if (typeof isTicketHubMobile === 'function' && !isTicketHubMobile()) return;
        const win = document.getElementById('ticketHubWindow');
        if (!win || !win.classList.contains('show')) return;
        if (Date.now() < hubSuppressOutsideCloseUntil) return;
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        const fromEl = clickTargetElement(e);
        const startedInsideHub =
            path.includes(win) || (e.target && win.contains(e.target));
        const keepOpenSel =
            '[onclick*="openTicketHubWindow"], [onclick*="toggleTicketHubWindow"], #ticketHubOpenButton, #mapTopLeftActiveStatBubble, .map-top-left-stat-filter-menu, .map-top-left-menu-fab, #mapTopLeftMenuBubbles, .map-tools-mobile-bubble, .leaflet-control, .modal-overlay, #dataWindow, .ticket-popup, .ticket-history-modal-overlay, .ticket-history-detail-overlay, .ticket-hub-pdf-modal-overlay, .ticket-hub-op-detail-overlay, .ticket-hub-mock-modal-overlay, #ticketHubFiltersModal, #ticketHubDetailModal';
        if (
            startedInsideHub ||
            (fromEl && fromEl.closest && fromEl.closest(keepOpenSel)) ||
            document.getElementById('ticketHubOperatorResponseDetailModal') ||
            document.getElementById('ticketHubResponseCodeDetailModal')
        ) {
            return;
        }
        if (
            window.ticketHubDockModule &&
            typeof window.ticketHubDockModule.shouldKeepOpenOnMapClick === 'function' &&
            window.ticketHubDockModule.shouldKeepOpenOnMapClick()
        ) {
            return;
        }
        if (typeof window.closeTicketHubWindow === 'function') {
            window.closeTicketHubWindow();
        }
    }

    function initHubResize() {
        const win = document.getElementById('ticketHubWindow');
        const top = win && win.querySelector('#ticketHubResizeHandleTop, .ticket-hub-resize-top');
        if (!win || !top || win.dataset.hubResizeInit) return;
        win.dataset.hubResizeInit = '1';
        top.addEventListener('mousedown', function (e) {
            e.stopPropagation();
            if (
                win.classList.contains('ticket-hub-window--dock-left') ||
                win.classList.contains('ticket-hub-window--dock-right') ||
                win.classList.contains('ticket-hub-window--dock-minimized')
            ) {
                return;
            }
            hubResizing = true;
            hubResizeType = 'top';
            const rect = win.getBoundingClientRect();
            hubResizeStart = {
                x: e.clientX,
                y: e.clientY,
                width: rect.width,
                height: rect.height,
                left: rect.left,
                top: rect.top
            };
            win.classList.add('resizing');
            document.body.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', function (e) {
            if (!hubResizing || hubResizeType !== 'top') return;
            const deltaY = hubResizeStart.y - e.clientY;
            const limits = getHubWindowViewportLimits();
            const h = Math.max(limits.minHeight, Math.min(limits.maxHeight, hubResizeStart.height + deltaY));
            win.style.height = h + 'px';
            win.style.maxHeight = h + 'px';
            // Top-anchored (float): keep the bottom edge fixed while the top follows the pointer.
            if (win.classList.contains('ticket-hub-window--dock-float') || win.style.top) {
                const newTop = hubResizeStart.top + (hubResizeStart.height - h);
                const maxTop = Math.max(limits.gutter, window.innerHeight - h - limits.gutter);
                win.style.top = Math.max(limits.gutter, Math.min(maxTop, newTop)) + 'px';
                win.style.bottom = 'auto';
            }
        });
        document.addEventListener('mouseup', function () {
            if (!hubResizing || hubResizeType !== 'top') return;
            hubResizing = false;
            hubResizeType = null;
            win.classList.remove('resizing');
            document.body.style.userSelect = '';
            if (
                win.classList.contains('ticket-hub-window--dock-float') &&
                typeof saveHubDimensions === 'function'
            ) {
                saveHubDimensions(win);
            }
            hubSuppressOutsideCloseUntil = Date.now() + 500;
        });
    }

    function clearHubWindowInlineLayout(win) {
        win.style.width = '';
        win.style.height = '';
        win.style.left = '';
        win.style.top = '';
        win.style.transform = '';
        win.style.minWidth = '';
        win.style.minHeight = '';
        win.style.maxWidth = '';
        win.style.maxHeight = '';
    }

    function syncTicketHubStatsVisibilityForMobile() {
        const stats = document.getElementById('ticketHubStats');
        if (!stats || !isTicketHubMobile()) return;
        // Mobile hub no longer shows status filter bubbles (map Tickets fan owns them).
        stats.innerHTML = '';
        stats.classList.add('ticket-hub-stats--collapsed');
        stats.setAttribute('aria-hidden', 'true');
        stats.hidden = true;
    }

    function syncTicketHubMobileHeightToggle() {
        const grab = document.getElementById('ticketHubMobileHeightGrab');
        const win = document.getElementById('ticketHubWindow');
        if (!grab || !win) return;
        if (!isTicketHubMobile() || !win.classList.contains('show')) {
            grab.hidden = true;
            return;
        }
        grab.hidden = false;
        const isFull = win.classList.contains('ticket-hub-mobile-full');
        const label = isFull ? 'Collapse Ticket Hub height' : 'Expand Ticket Hub height';
        grab.setAttribute('aria-label', label);
        grab.title = label;
        grab.classList.toggle('ticket-hub-mobile-height-grab--full', isFull);
    }

    function applyTicketHubMobileOpenState(win) {
        if (!win || !isTicketHubMobile()) return;
        win.classList.add('ticket-hub-mobile-halfway');
        win.classList.remove('ticket-hub-mobile-full');
        syncTicketHubStatsVisibilityForMobile();
    }

    function applyTicketHubMobileFullOpenState(win) {
        if (!win || !isTicketHubMobile()) return;
        win.classList.remove('ticket-hub-mobile-halfway');
        win.classList.add('ticket-hub-mobile-full');
        syncTicketHubStatsVisibilityForMobile();
    }

    function clearTicketHubMobileCloseState(win) {
        if (!win) return;
        win.classList.remove('ticket-hub-mobile-halfway', 'ticket-hub-mobile-full', 'resizing');
        const stats = document.getElementById('ticketHubStats');
        if (stats) {
            stats.innerHTML = '';
            stats.classList.add('ticket-hub-stats--collapsed');
            stats.setAttribute('aria-hidden', 'true');
            stats.hidden = true;
        }
        const grab = document.getElementById('ticketHubMobileHeightGrab');
        if (grab) {
            grab.hidden = true;
            grab.classList.remove('ticket-hub-mobile-height-grab--full');
        }
    }

    function toggleTicketHubMobileHeight() {
        const win = document.getElementById('ticketHubWindow');
        if (!win || !isTicketHubMobile()) return;
        const toFull = win.classList.contains('ticket-hub-mobile-halfway');
        if (toFull) {
            win.classList.remove('ticket-hub-mobile-halfway');
            win.classList.add('ticket-hub-mobile-full');
        } else {
            win.classList.remove('ticket-hub-mobile-full');
            win.classList.add('ticket-hub-mobile-halfway');
        }
        syncTicketHubStatsVisibilityForMobile();
        syncTicketHubMobileHeightToggle();
    }

    function setTicketHubLoadingOverlay(on) {
        const overlay = document.getElementById('ticketHubLoadingOverlay');
        if (!overlay) return;
        overlay.style.display = on ? 'flex' : 'none';
        overlay.setAttribute('aria-busy', on ? 'true' : 'false');
    }

    function setTicketHubTitleUsanPollIndicator() {
        /* USAN activity indicator removed. */
    }

    function openHubTicketFromSearchMatch(ticket, opts) {
        if (!ticket) return;
        const preferPopup = !!(opts && opts.preferPopup);
        const ticketId = ticket.id;
        const hubWin = document.getElementById('ticketHubWindow');
        const hubOpen = hubWin && hubWin.classList.contains('show');

        if (hubOpen && ticketId != null) {
            if (typeof window.setTicketHubActiveSection === 'function') {
                window.setTicketHubActiveSection('tickets');
            }
            hubSelectRow(ticketId, { mobileHeight: 'full' });
            return;
        }
        if (preferPopup && typeof window.showTicketPopup === 'function') {
            void window.showTicketPopup(ticket, { mobileHeight: 'full', skipDetailHydrate: true });
            return;
        }
        if (ticketId != null && typeof window.selectTicket === 'function') {
            window.selectTicket(ticketId);
            return;
        }
        if (typeof window.showTicketPopup === 'function') {
            void window.showTicketPopup(ticket, { mobileHeight: 'full' });
        }
    }

    async function openHubTicketFromSearchEnter() {
        if (hubDirectSearchInFlight) return;
        const q = getHubSearch();
        if (!q) return;

        const filtered = getFilteredTicketsForHub({ omitDirectSearchHit: true });
        if (filtered.length > 1) return;
        if (filtered.length === 1) {
            clearHubDirectSearchHit();
            openHubTicketFromSearchMatch(filtered[0]);
            closeMapStatusDropdowns();
            closeTicketHubSearchModal();
            resetTicketHubFilters();
            return;
        }
        if (
            hubDirectSearchHit &&
            hubSearchMatchesTicketNumber(hubDirectSearchHit, q) &&
            hubDirectSearchHitStatusKey === hubStatusFiltersKey()
        ) {
            openHubTicketFromSearchMatch(hubDirectSearchHit, { preferPopup: true });
            closeMapStatusDropdowns();
            closeTicketHubSearchModal();
            return;
        }
        if (!hubSearchQueryLooksLikeTicketNumber(q)) return;

        const tm = window.ticketsModule;
        if (!tm || typeof tm.resolveTicketForOpen !== 'function') return;

        const statusKeyAtStart = hubStatusFiltersKey();
        hubDirectSearchInFlight = true;
        try {
            const ticket = await tm.resolveTicketForOpen({ ticketNumber: q, sessionOnly: true });
            if (getHubSearch() !== q || hubStatusFiltersKey() !== statusKeyAtStart) return;
            if (!ticket) {
                if (typeof window.appAlert === 'function') {
                    void window.appAlert('No ticket found for ' + q + '.');
                }
                return;
            }
            if (
                typeof window.isTicketVisibleToTechClient === 'function' &&
                !window.isTicketVisibleToTechClient(ticket)
            ) {
                if (typeof window.appAlert === 'function') {
                    void window.appAlert('No ticket found for ' + q + '.');
                }
                return;
            }
            hubDirectSearchHit = ticket;
            hubDirectSearchHitStatusKey = statusKeyAtStart;
            openHubTicketFromSearchMatch(ticket, { preferPopup: true });
            closeMapStatusDropdowns();
            closeTicketHubSearchModal();
            if (typeof renderHubTable === 'function') renderHubTable();
            if (typeof renderHubStats === 'function') renderHubStats();
            if (typeof window.renderTickets === 'function') window.renderTickets();
        } finally {
            hubDirectSearchInFlight = false;
        }
    }

    function initTicketHubSearchEnterKey() {
        const input = document.getElementById('ticketHubSearch');
        if (!input || input.dataset.enterOpenBound) return;
        input.dataset.enterOpenBound = '1';
        input.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            openHubTicketFromSearchEnter();
        });
    }

    (function initTicketHubFiltersSheetAndMapToggle() {
        initTicketHubSearchEnterKey();
        const filtersModal = document.getElementById('ticketHubFiltersModal');
        if (filtersModal && !filtersModal.dataset.backdropInit) {
            filtersModal.dataset.backdropInit = '1';
            const backdrop = filtersModal.querySelector('.ticket-hub-detail-modal-backdrop');
            if (backdrop) {
                backdrop.addEventListener('click', function () {
                    closeTicketHubFiltersModal();
                });
            }
        }
        if (!window.__ticketHubFiltersEscapeInit) {
            window.__ticketHubFiltersEscapeInit = true;
            document.addEventListener('keydown', function (e) {
                if (e.key !== 'Escape') return;
                const fm = document.getElementById('ticketHubFiltersModal');
                if (!fm || !fm.classList.contains('ticket-hub-detail-modal-open')) return;
                closeTicketHubFiltersModal();
            });
        }
        if (!window.__ticketHubMobileMapDismissInit) {
            window.__ticketHubMobileMapDismissInit = true;
            document.addEventListener('pointerdown', closeTicketHubOnOutsideClick, true);
        }
        relocateTicketHubFiltersPack();
    })();

    window.setTicketHubLoadingOverlay = setTicketHubLoadingOverlay;
    window.setTicketHubTitleUsanPollIndicator = setTicketHubTitleUsanPollIndicator;
    window.renderHubStats = renderHubStats;
    window.parkMapStatusActionBtns = parkMapStatusActionBtns;
    window.syncMapTopLeftActiveStatBubble = syncMapTopLeftActiveStatBubble;
    window.renderHubTable = renderHubTable;
    window.toggleTicketHubMobileHeight = toggleTicketHubMobileHeight;
    window.syncTicketHubMobileHeightToggle = syncTicketHubMobileHeightToggle;
    window.toggleTicketHubDetailMobileHeight = toggleTicketHubDetailMobileHeight;
    window.syncTicketHubDetailMobileHeightToggle = syncTicketHubDetailMobileHeightToggle;
    window.applyTicketHubMobileOpenState = applyTicketHubMobileOpenState;
    window.applyTicketHubMobileFullOpenState = applyTicketHubMobileFullOpenState;
    window.clearTicketHubMobileCloseState = clearTicketHubMobileCloseState;
    window.relocateTicketHubFiltersPack = relocateTicketHubFiltersPack;
    window.relocateTicketHubFilterControls = relocateTicketHubFilterControls;
    window.toggleMapStatusDropdown = toggleMapStatusDropdown;
    window.closeMapStatusDropdowns = closeMapStatusDropdowns;
    window.openTicketHubFiltersModal = openTicketHubFiltersModal;
    window.closeTicketHubDetailSheet = closeTicketHubDetailSheet;
    window.closeTicketHubFiltersModal = closeTicketHubFiltersModal;
    window.openTicketHubSearchModal = openTicketHubSearchModal;
    window.closeTicketHubSearchModal = closeTicketHubSearchModal;
    window.clearTicketHubSearch = clearTicketHubSearch;
    window.resetTicketHubFilters = resetTicketHubFilters;
    window.viewMapFromTicketHubFilters = viewMapFromTicketHubFilters;
    window.getFilteredTicketsForHub = getFilteredTicketsForHub;
    window.rememberTicketHubPersistedBaselineFromDom = rememberTicketHubPersistedBaselineFromDom;
    window.flushTicketHubPersistedStateIfNeeded = function () {
        if (hubStateSaveTimer) {
            clearTimeout(hubStateSaveTimer);
            hubStateSaveTimer = null;
        }
        return persistTicketHubStateIfChanged(false);
    };

    (function initTicketHubPersistedStateUnloadFlush() {
        if (window.__ticketHubPersistPagehideFlush) return;
        window.__ticketHubPersistPagehideFlush = true;
        window.addEventListener('pagehide', function () {
            if (hubStateSaveTimer) {
                clearTimeout(hubStateSaveTimer);
                hubStateSaveTimer = null;
            }
            void persistTicketHubStateIfChanged(true);
        });
    })();

    function scrollTicketHubListToTop() {
        const scrollEl = document.querySelector('#ticketHubWindow .ticket-hub-table-scroll');
        if (window.overlayScrollModule && typeof window.overlayScrollModule.scrollToTop === 'function') {
            window.overlayScrollModule.scrollToTop(scrollEl);
            return;
        }
        if (scrollEl) {
            scrollEl.scrollTop = 0;
            scrollEl.scrollLeft = 0;
        }
    }

    function hubExpiredPagerNavigate(pageDirection) {
        if (hubUsesActiveClientPaging()) {
            // Active mode paginates the in-memory set; no server round-trip needed.
            const filtered = getFilteredTicketsForHub();
            const total = filtered ? filtered.length : 0;
            const totalPages = Math.max(1, Math.ceil(total / HUB_ACTIVE_PAGE_SIZE));
            if (pageDirection === 'next') {
                hubActiveClientPage = Math.min(totalPages, hubActiveClientPage + 1);
            } else if (pageDirection === 'prev') {
                hubActiveClientPage = Math.max(1, hubActiveClientPage - 1);
            } else if (typeof pageDirection === 'number' && Number.isFinite(pageDirection)) {
                hubActiveClientPage = Math.min(totalPages, Math.max(1, pageDirection));
            }
            renderHubTable();
            scrollTicketHubListToTop();
            return;
        }
        const loadFn =
            window.ticketsModule &&
            typeof window.ticketsModule.loadHubTicketSliceForCurrentFilters === 'function'
                ? window.ticketsModule.loadHubTicketSliceForCurrentFilters.bind(window.ticketsModule)
                : window.ticketsModule &&
                    typeof window.ticketsModule.loadExpiredTicketsForHub === 'function'
                  ? window.ticketsModule.loadExpiredTicketsForHub.bind(window.ticketsModule)
                  : null;
        if (!loadFn) return;
        void loadFn({ pageDirection }).then(function () {
            refreshTicketHubWindow();
            if (window.renderTickets) window.renderTickets();
            scrollTicketHubListToTop();
        });
    }

    (function initTicketHubExpiredPager() {
        const pager = document.getElementById('ticketHubExpiredPager');
        const prevBtn = document.getElementById('ticketHubExpiredPrev');
        const nextBtn = document.getElementById('ticketHubExpiredNext');
        if (!prevBtn || !nextBtn || prevBtn.dataset.bound === '1') return;
        prevBtn.dataset.bound = '1';
        nextBtn.dataset.bound = '1';
        prevBtn.addEventListener('click', function () {
            hubExpiredPagerNavigate('prev');
        });
        nextBtn.addEventListener('click', function () {
            hubExpiredPagerNavigate('next');
        });
        if (pager && pager.dataset.pagesBound !== '1') {
            pager.dataset.pagesBound = '1';
            pager.addEventListener('click', function (e) {
                const btn = e.target && e.target.closest ? e.target.closest('[data-hub-page]') : null;
                if (!btn || !pager.contains(btn)) return;
                const page = Number(btn.getAttribute('data-hub-page'));
                if (!Number.isFinite(page)) return;
                hubExpiredPagerNavigate(page);
            });
        }
    })();

