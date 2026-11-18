    'use strict';

    function closeTicketHubMockModal() {
        const el = document.getElementById('ticketHubMockActionModal');
        if (el) el.remove();
    }

    /**
     * Bulk renew / remark from Ticket Hub selection.
     * Fresh-paint choice is asked by the Renew selected click handler before calling this.
     * @param {'renew' | 'remark'} mode
     * @param {Array<string|number>} ticketIds
     */
    function openTicketHubMockActionModal(mode, ticketIds) {
        const list = (ticketIds || [])
            .map(id => findTicketForHub(id))
            .filter(t => t && !isHubTicketExternalForOrg(t));
        if (list.length === 0) {
            if (typeof window.appAlert === 'function') void window.appAlert('No tickets to include.');
            return;
        }
        if (mode === 'remark') {
            const useApi =
                typeof window.isTicketRenewalHubEnabled === 'function' &&
                window.isTicketRenewalHubEnabled() &&
                window.ticketRemarkBulkFlow &&
                typeof window.ticketRemarkBulkFlow.openBulkRemarkFromTickets === 'function';
            if (useApi) {
                window.ticketRemarkBulkFlow.openBulkRemarkFromTickets(list);
                return;
            }
            if (typeof window.appAlert === 'function') {
                void window.appAlert('Bulk remark is not available yet.');
            }
            return;
        }
        if (mode === 'renew') {
            const useApi =
                typeof window.isTicketRenewalHubEnabled === 'function' &&
                window.isTicketRenewalHubEnabled() &&
                window.ticketRenewalBulkFlow &&
                typeof window.ticketRenewalBulkFlow.openBulkRenewalFromTickets === 'function';
            if (useApi) {
                window.ticketRenewalBulkFlow.openBulkRenewalFromTickets(list);
                return;
            }
            const flow =
                typeof window !== 'undefined' &&
                window.renewalUxMockFlow &&
                typeof window.renewalUxMockFlow.openBulkRenewalMockTickets === 'function'
                    ? window.renewalUxMockFlow
                    : null;
            if (flow) {
                flow.openBulkRenewalMockTickets(list);
                return;
            }
            if (typeof window.appAlert === 'function') void window.appAlert('Renew preview is not loaded yet.');
            return;
        }
    }

    /**
     * Ask fresh-paint vs renew, then open the matching bulk flow.
     * @param {Array<string|number>} ticketIds
     */
    async function openTicketHubBulkRenewWithFreshPaintChoice(ticketIds) {
        const ids = ticketIds || [];
        if (ids.length === 0) {
            if (typeof window.appAlert === 'function') {
                void window.appAlert('Select at least one ticket using the checkboxes.');
            }
            return;
        }
        let choice = 'renew';
        if (typeof window.appChoice === 'function') {
            const picked = await window.appChoice(
                'Do these tickets need fresh paint (remark / re-mark)?\n\n' +
                    'Yes — remark only tickets that can be remarked.\n' +
                    'No — renew / refresh only tickets that can be renewed.',
                {
                    title: 'Fresh paint needed?',
                    choices: [
                        { id: 'fresh_paint', label: 'Yes, fresh paint', variant: 'primary' },
                        { id: 'renew', label: 'No, renew', variant: 'secondary' },
                    ],
                    cancelText: 'Cancel',
                }
            );
            if (picked == null) return;
            choice = picked;
        } else if (typeof window.appConfirm === 'function') {
            const yes = await window.appConfirm(
                'Do these tickets need fresh paint (remark)?\n\nOK = yes (remark). Cancel = no (renew).',
                {
                    title: 'Fresh paint needed?',
                    confirmText: 'Yes, fresh paint',
                    cancelText: 'No, renew',
                }
            );
            choice = yes ? 'fresh_paint' : 'renew';
        }
        if (choice === 'fresh_paint') {
            openTicketHubMockActionModal('remark', ids);
        } else {
            openTicketHubMockActionModal('renew', ids);
        }
    }

    function setHubActionBusy(button, isBusy) {
        if (button && typeof button.disabled !== 'undefined') {
            button.disabled = Boolean(isBusy);
        }
    }

    async function requestHubBulkSiteDocumentation(ticketIds, button) {
        const list = (ticketIds || [])
            .map(id => findTicketForHub(id))
            .filter(t => t && !isHubTicketExternalForOrg(t));
        if (list.length === 0) {
            if (typeof window.appAlert === 'function') await window.appAlert('Select at least one ticket using the checkboxes.');
            return;
        }
        if (typeof window.openServiceRequestModal === 'function') {
            window.openServiceRequestModal(list);
            return;
        }
        if (typeof window.requestSiteDocumentationForTickets === 'function') {
            window.requestSiteDocumentationForTickets(list);
            return;
        }
        if (typeof window.appAlert === 'function') {
            await window.appAlert('Service requests are not available yet. Please try again after the page finishes loading.');
        }
    }

    async function deleteHubBulkSelectedTickets(ticketIds, button) {
        if (!window.authModule || !window.authModule.isDev()) {
            if (typeof window.appAlert === 'function') await window.appAlert('Only developers can delete tickets.');
            return;
        }
        const list = (ticketIds || [])
            .map(id => findTicketForHub(id))
            .filter(t => t && isHubTicketBulkSelectable(t));
        if (list.length === 0) {
            if (typeof window.appAlert === 'function') {
                await window.appAlert('Select at least one editable ticket using the checkboxes.');
            }
            return;
        }
        const confirmMsg =
            list.length === 1
                ? `Are you sure you want to delete ticket #${list[0].ticketNumber}? This action cannot be undone.`
                : `Are you sure you want to delete ${list.length} tickets? This action cannot be undone.`;
        if (typeof window.appConfirm !== 'function' || !(await window.appConfirm(confirmMsg))) {
            return;
        }

        setHubActionBusy(button, true);
        let succeeded = 0;
        let failed = 0;
        try {
            for (let i = 0; i < list.length; i++) {
                const t = list[i];
                if (typeof window.deleteTicket !== 'function') {
                    failed++;
                    continue;
                }
                const ok = await window.deleteTicket(
                    t.ticketNumber,
                    getTicketHubApiOrganizationId(t),
                    t.id,
                    { skipConfirm: true, skipSuccessAlert: true }
                );
                if (ok) succeeded++;
                else failed++;
            }
            hubBulkSelectedIds.clear();
            if (typeof updateTicketHubBulkBar === 'function') updateTicketHubBulkBar();
            if (typeof window.appAlert === 'function') {
                const msg =
                    failed > 0
                        ? `Deleted ${succeeded} ticket(s). ${failed} could not be deleted.`
                        : `Deleted ${succeeded} ticket(s).`;
                await window.appAlert(msg);
            }
        } finally {
            setHubActionBusy(button, false);
        }
    }

    async function openHubTicketPeopleAssignment(ticket) {
        if (!ticket) return;
        let resolved = null;
        if (typeof window.resolveTicketProjectJobKey === 'function') {
            try {
                resolved = await window.resolveTicketProjectJobKey(ticket);
            } catch (err) {
                console.warn('Ticket hub: resolve project for assignees', err);
            }
        }
        const jobKey = resolved && resolved.jobNameKey ? String(resolved.jobNameKey).trim() : '';
        if (jobKey && typeof window.openProjectAssigneesModal === 'function') {
            const assignees =
                typeof window.getProjectAssigneesForTicket === 'function'
                    ? window.getProjectAssigneesForTicket(ticket)
                    : [];
            await window.openProjectAssigneesModal({
                jobNameKey: jobKey,
                jobName: resolved && resolved.jobName != null ? resolved.jobName : '',
                assignees,
            });
            return;
        }
        const projectsBtn = document.getElementById('ticketHubDetailProjectsBtn');
        if (projectsBtn) {
            projectsBtn.click();
            return;
        }
        if (typeof window.openTicketProjectsModal === 'function' && ticket.ticketNumber) {
            void window.openTicketProjectsModal(ticket.ticketNumber);
        }
    }

    function bindHubDetailPanelActions(panel, ticket) {
        panel.onclick = function (e) {
            if (panel.classList && panel.classList.contains('ticket-hub-op-detail-panel')) {
                e.stopPropagation();
            }
            const btn = hubActionButtonFromEvent(e, panel);
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            const action = btn.getAttribute('data-hub-action');
            if (
                window.ticketActionsMenu &&
                typeof window.ticketActionsMenu.closeOpenMenu === 'function'
            ) {
                window.ticketActionsMenu.closeOpenMenu();
            }
            if (action === 'op-detail') {
                const idx = parseInt(btn.getAttribute('data-resp-index'), 10);
                if (!Number.isNaN(idx)) {
                    openHubOperatorResponseDetailModal(ticket, idx);
                }
                return;
            }
            if (action === 'op-status-detail') {
                const idx = parseInt(btn.getAttribute('data-resp-index'), 10);
                if (!Number.isNaN(idx)) {
                    if (typeof openOperatorResponseStatusModal === 'function') {
                        openOperatorResponseStatusModal(ticket, idx);
                    }
                }
                return;
            }
            if (action === 'resp-code-detail') {
                const idx = parseInt(btn.getAttribute('data-resp-index'), 10);
                if (!Number.isNaN(idx)) {
                    openHubResponseCodeDetailModal(ticket, idx);
                }
                return;
            }
            if (action === 'events') {
                if (window.CORE_PRODUCT === true) return;
                if (window.openDataWindowForTicket) {
                    window.openDataWindowForTicket(ticket.id, ticket.ticketNumber);
                }
                return;
            }
            if (action === 'ticket-history') {
                openTicketHistoryModal(ticket);
                return;
            }
            if (action === 'hub-open-project') {
                if (typeof window.openTicketProjectInHub === 'function') {
                    void window.openTicketProjectInHub(ticket);
                }
                return;
            }
            if (action === 'hub-close-detail') {
                if (typeof window.closeTicketHubDetailSheet === 'function') {
                    window.closeTicketHubDetailSheet();
                }
                return;
            }
            if (action === 'hub-assign-people') {
                void openHubTicketPeopleAssignment(ticket);
                return;
            }
            if (action === 'usan-portal') {
                if (typeof window.openUsanNgenPortalForTicket === 'function') {
                    window.openUsanNgenPortalForTicket(ticket);
                }
                return;
            }
            if (action === 'check-posr') {
                if (typeof window.openPosrSearchAndCopy811Ticket === 'function') {
                    void window.openPosrSearchAndCopy811Ticket(ticket);
                }
                return;
            }
            if (action === 'hub-photo-view') {
                if (typeof showTicketPhotos === 'function') {
                    void showTicketPhotos(ticket.id, ticket.ticketNumber);
                }
                return;
            }
            if (action === 'hub-renew') {
                const useApi =
                    typeof window.isTicketRenewalHubEnabled === 'function' &&
                    window.isTicketRenewalHubEnabled() &&
                    window.ticketRenewalBulkFlow &&
                    typeof window.ticketRenewalBulkFlow.openBulkRenewalFromTickets === 'function';
                if (useApi) {
                    window.ticketRenewalBulkFlow.openBulkRenewalFromTickets([ticket]);
                    return;
                }
                openTicketHubMockActionModal('renew', [ticket.id]);
                return;
            }
            if (action === 'hub-remark') {
                if (
                    window.ticketRemarkFlow &&
                    typeof window.ticketRemarkFlow.openRemarkFromTicket === 'function'
                ) {
                    window.ticketRemarkFlow.openRemarkFromTicket(ticket);
                }
                return;
            }
            if (action === 'hub-show-on-map') {
                if (typeof window.panMapToTicketAboveBottomChrome === 'function') {
                    window.panMapToTicketAboveBottomChrome(ticket);
                }
                return;
            }
            if (action === 'hub-document-pack') {
                if (
                    window.ticketDocumentPackFlow &&
                    typeof window.ticketDocumentPackFlow.openTicketDocumentPackViewer === 'function'
                ) {
                    void window.ticketDocumentPackFlow.openTicketDocumentPackViewer(ticket, btn);
                }
                return;
            }
            if (action === 'hub-report-event') {
                if (typeof window.reportEventForTicket !== 'function') return;
                setHubActionBusy(btn, true);
                void window
                    .reportEventForTicket(ticket, { skipTicketPopup: true })
                    .then(ok => {
                        if (
                            ok &&
                            window.ticketHubModule &&
                            typeof window.ticketHubModule.renderDetail === 'function'
                        ) {
                            void window.ticketHubModule.renderDetail();
                        }
                    })
                    .finally(() => setHubActionBusy(btn, false));
                return;
            }
            if (action === 'hub-request-services') {
                if (typeof window.openServiceRequestModal === 'function') {
                    window.openServiceRequestModal([ticket]);
                    return;
                }
                if (typeof window.requestSiteDocumentationForTicket === 'function') {
                    window.requestSiteDocumentationForTicket(ticket);
                }
                return;
            }
            if (action === 'hub-workflow-ready') {
                if (window.workflowAckModule && typeof window.workflowAckModule.openWorkflowAckModal === 'function') {
                    window.workflowAckModule.openWorkflowAckModal(ticket);
                }
                return;
            }
            if (action === 'hub-workflow-revert-ack') {
                if (window.workflowAckModule && typeof window.workflowAckModule.revertWorkflowAck === 'function') {
                    void window.workflowAckModule.revertWorkflowAck(ticket);
                }
                return;
            }
        };
        panel.onkeydown = function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const el = e.target;
            if (!el || !el.getAttribute || el.getAttribute('role') !== 'button') return;
            if (!el.hasAttribute('data-hub-action')) return;
            if (!panel.contains(el)) return;
            e.preventDefault();
            el.click();
        };
        if (
            window.ticketActionsMenu &&
            typeof window.ticketActionsMenu.wireTicketActionsMenu === 'function'
        ) {
            window.ticketActionsMenu.wireTicketActionsMenu(panel, ticket);
        }
    }

    function getProfileStorageKey() {
        let storageKey = 'userProfile';
        if (window.authModule && window.authModule.isAuthenticated()) {
            const user = window.authModule.getCurrentUser();
            if (user && user.id) storageKey = `userProfile_user_${user.id}`;
        }
        return storageKey;
    }

    function recalcAllTicketStatuses() {
        const seen = new Set();
        const tickets = [];
        (window.ORG_TICKETS || []).forEach((ticket) => {
            const id = String(ticket && ticket.id);
            if (!seen.has(id)) {
                seen.add(id);
                tickets.push(ticket);
            }
        });
        (window.HUB_EXPIRED_TICKETS || []).forEach((ticket) => {
            const id = String(ticket && ticket.id);
            if (!seen.has(id)) {
                seen.add(id);
                tickets.push(ticket);
            }
        });
        (window.HUB_ACTIVE_TICKETS || []).forEach((ticket) => {
            const id = String(ticket && ticket.id);
            if (!seen.has(id)) {
                seen.add(id);
                tickets.push(ticket);
            }
        });
        (window.HUB_COMBINED_TICKETS || []).forEach((ticket) => {
            const id = String(ticket && ticket.id);
            if (!seen.has(id)) {
                seen.add(id);
                tickets.push(ticket);
            }
        });
        const apply = window.ticketsModule && window.ticketsModule.applyTicketStatusFromImporter;
        tickets.forEach((ticket) => {
            if (typeof apply === 'function') {
                apply(ticket);
            } else if (ticket.computedWorkflowStatus) {
                ticket.status = ticket.computedWorkflowStatus;
                ticket.workflowStatus = ticket.computedWorkflowStatus;
            }
        });
    }

    function getHubCurrentUserId() {
        const currentUser =
            window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
        const myId = currentUser && currentUser.id;
        if (myId == null) return null;
        const parsed = parseInt(myId, 10);
        return Number.isNaN(parsed) ? null : parsed;
    }

    function getHubAssigneeFilter() {
        const el = document.getElementById('ticketHubAssigneeFilter');
        return el ? el.value : 'all';
    }

    function hubAssigneeFilterIsCurrentUser(filterVal) {
        const myId = getHubCurrentUserId();
        if (myId == null || filterVal == null || filterVal === '') return false;
        return String(filterVal) === String(myId);
    }

    function ensureHubAssigneeFilterOptionForUserId(userId) {
        const select = document.getElementById('ticketHubAssigneeFilter');
        if (!select || userId == null) return;
        const idStr = String(userId);
        if (Array.from(select.options).some(o => o.value === idStr)) return;
        const currentUser =
            window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
        const opt = document.createElement('option');
        opt.value = idStr;
        opt.textContent =
            currentUser && String(currentUser.id) === idStr
                ? currentUser.full_name || currentUser.username || `User ${idStr}`
                : `User ${idStr}`;
        select.appendChild(opt);
    }

    function getHubOrgScopeFilter() {
        if (hubPartnerSharedFilter) return 'shared_partner';
        return 'all';
    }

    /** Selected ticket-type values; empty Set = no type restriction. */
    function getHubTicketTypeFilters() {
        const selected = new Set();
        const el = document.getElementById('ticketHubTicketTypeFilter');
        if (!el) return selected;
        const v = String(el.value || 'all');
        if (v && v !== 'all') selected.add(v);
        return selected;
    }

    /** Selected enquiry-status values; empty Set = no enquiry restriction. */
    function getHubEnquiryStatusFilters() {
        const selected = new Set();
        const el = document.getElementById('ticketHubEnquiryStatusFilter');
        if (!el) return selected;
        const v = String(el.value || 'all');
        if (v && v !== 'all') selected.add(v);
        return selected;
    }

    /**
     * Canonical ticket type for hub filters (no default to Normal on empty/unknown).
     * @returns {'Normal'|'Short'|'Emergency'|null}
     */
    function normalizeHubTicketTypeForFilter(raw) {
        if (raw == null || String(raw).trim() === '') return null;
        const t = String(raw).trim();
        if (/^normal$/i.test(t)) return 'Normal';
        if (/^short$/i.test(t)) return 'Short';
        if (/^emergency$/i.test(t)) return 'Emergency';
        return null;
    }

    /**
     * Canonical enquiry-status key for hub filters.
     * @returns {'new'|'remark'|'renew'|'amendment'|'damaged'|'exposed'|'cancelled'|'other'|null}
     */
    function normalizeHubEnquiryStatusForFilter(raw) {
        if (raw == null || String(raw).trim() === '') return null;
        const u = String(raw).trim().toUpperCase();
        if (u === 'NEW') return 'new';
        if (u === 'REMK' || u === 'REMARK') return 'remark';
        if (u === 'RNEW' || u === 'RENEW') return 'renew';
        if (u === 'AMND' || u === 'AMENDMENT' || u === 'AMEND') return 'amendment';
        if (u === 'DMGE' || u === 'DAMAGE' || u === 'DAMAGED') return 'damaged';
        if (u === 'EXPD' || u === 'EXPOSED') return 'exposed';
        if (u === 'CNCL' || u === 'CANCELLED' || u === 'CANCELED' || u === 'CANCEL') return 'cancelled';
        return 'other';
    }

    function pickHubTicketTypeRaw(ticket) {
        if (!ticket) return null;
        const dm = window.ticketHubDisplayMap;
        if (dm && typeof dm.pickTicketField === 'function') {
            const fromMap = dm.pickTicketField(ticket, 'providerTicketType');
            if (fromMap != null && String(fromMap).trim() !== '') return fromMap;
        }
        return (
            ticket.providerTicketType ??
            ticket.ngenTicketType ??
            ticket.portalTicketType ??
            ticket.ticketType ??
            null
        );
    }

    function pickHubEnquiryStatusRaw(ticket) {
        if (!ticket) return null;
        if (typeof getNgenEnquiryStatus === 'function') {
            const fromAck = getNgenEnquiryStatus(ticket);
            if (fromAck != null && String(fromAck).trim() !== '') return fromAck;
        }
        return (
            ticket.providerEnquiryStatus ??
            ticket.ngenEnquiryStatus ??
            ticket.currentNgenEnquiryStatus ??
            ticket.current_ngen_enquiry_status ??
            ticket.ngen_enquiry_status ??
            null
        );
    }

    /** OR within selected types; empty Set = pass-through. */
    function matchesHubTicketTypeFilters(ticket, filters) {
        if (!filters || filters.size === 0) return true;
        const canon = normalizeHubTicketTypeForFilter(pickHubTicketTypeRaw(ticket));
        return canon != null && filters.has(canon);
    }

    /** OR within selected enquiry statuses; empty Set = pass-through. */
    function matchesHubEnquiryStatusFilters(ticket, filters) {
        if (!filters || filters.size === 0) return true;
        const canon = normalizeHubEnquiryStatusForFilter(pickHubEnquiryStatusRaw(ticket));
        return canon != null && filters.has(canon);
    }

    function clearHubTicketTypeAndEnquiryFilters() {
        ['ticketHubTicketTypeFilter', 'ticketHubEnquiryStatusFilter'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = 'all';
        });
    }

    const HUB_EXPIRED_RANGE_MAX_DAYS = 366;

    function parseHubTimeframeDays(timeframe) {
        if (!timeframe || timeframe === 'all') return null;
        if (timeframe === 'custom') return null;
        const days = parseInt(String(timeframe), 10);
        return Number.isFinite(days) && days > 0 ? days : null;
    }

    function getHubTimeframeFilter() {
        const el = document.getElementById('ticketHubTimeframe');
        const v = el ? String(el.value || 'all') : 'all';
        return ['all', '7d', '14d', '30d', '90d', '365d', 'custom'].includes(v) ? v : 'all';
    }

    /** Which date field {@link matchesHubTimeframe} uses with the Timeframe range. */
    function getHubTimeframeFieldType() {
        const el = document.getElementById('ticketHubTimeframeType');
        const v = el ? String(el.value || 'expiration') : 'expiration';
        return ['expiration', 'job_start', 'legal_start'].includes(v) ? v : 'expiration';
    }

    /** Hub list sort — expiration timescale only (sidebar keeps broader shared modes). */
    function normalizeHubListSort(value) {
        const v = value != null ? String(value) : '';
        return v === 'expiring_latest' ? 'expiring_latest' : 'expiring_soonest';
    }

    function updateHubTimeframeCustomVisibility() {
        const wrap = document.getElementById('ticketHubCustomDateFields');
        if (wrap) wrap.hidden = getHubTimeframeFilter() !== 'custom';
    }

    const HUB_MOBILE_TIMEFRAME_MAX = '30d';
    const HUB_MOBILE_EXTENDED_TIMEFRAMES = new Set(['90d', '365d', 'custom']);
    let hubMobileAdvancedOpen = false;
    let wasHubMobileFilterView = null;

    function isHubMobileFilterView() {
        return typeof isTicketHubMobile === 'function' && isTicketHubMobile();
    }

    function clampMobileHubAdvancedFilterValues() {
        const assignEl = document.getElementById('ticketHubAssigneeFilter');
        if (assignEl) assignEl.value = 'all';
        const submittedByEl = document.getElementById('ticketHubSubmittedByFilter');
        if (submittedByEl) submittedByEl.value = 'all';
        clearHubTicketTypeAndEnquiryFilters();
        const tfEl = document.getElementById('ticketHubTimeframe');
        if (tfEl && HUB_MOBILE_EXTENDED_TIMEFRAMES.has(String(tfEl.value || ''))) {
            tfEl.value = HUB_MOBILE_TIMEFRAME_MAX;
        }
        const fromEl = document.getElementById('ticketHubFromDate');
        const toEl = document.getElementById('ticketHubToDate');
        if (fromEl) fromEl.value = '';
        if (toEl) toEl.value = '';
    }

    function syncHubMobileTimeframeOptionVisibility() {
        const tfEl = document.getElementById('ticketHubTimeframe');
        if (!tfEl) return;
        const mobile = isHubMobileFilterView();
        const showExtended = !mobile || hubMobileAdvancedOpen;
        tfEl.querySelectorAll('[data-hub-mobile-extended]').forEach(function (opt) {
            opt.hidden = mobile && !showExtended;
        });
    }

    function setHubMobileAdvancedOpen(open) {
        hubMobileAdvancedOpen = !!open;
        const wrap = document.getElementById('ticketHubFiltersAdvanced');
        const body = document.getElementById('ticketHubFiltersAdvancedBody');
        const toggle = document.getElementById('ticketHubFiltersAdvancedToggle');
        if (wrap) wrap.classList.toggle('ticket-hub-filters-advanced--open', hubMobileAdvancedOpen);
        if (body) body.hidden = isHubMobileFilterView() && !hubMobileAdvancedOpen;
        if (toggle) {
            toggle.setAttribute('aria-expanded', hubMobileAdvancedOpen ? 'true' : 'false');
            toggle.textContent = hubMobileAdvancedOpen ? 'Hide advanced filters' : 'Advanced filters';
        }
        syncHubMobileTimeframeOptionVisibility();
        updateHubTimeframeCustomVisibility();
    }

    function toggleHubMobileAdvancedFilters() {
        if (!isHubMobileFilterView()) return;
        const next = !hubMobileAdvancedOpen;
        if (!next) {
            clampMobileHubAdvancedFilterValues();
            if (typeof window.onTicketHubFilterChange === 'function') {
                window.onTicketHubFilterChange();
            }
        }
        setHubMobileAdvancedOpen(next);
    }

    function collapseHubMobileAdvancedFilters() {
        if (!hubMobileAdvancedOpen) {
            syncHubMobileTimeframeOptionVisibility();
            updateHubTimeframeCustomVisibility();
            return;
        }
        setHubMobileAdvancedOpen(false);
    }

    function syncHubMobileFilterConstraints() {
        const mobile = isHubMobileFilterView();
        const pack = document.getElementById('ticketHubFiltersPack');
        const advancedWrap = document.getElementById('ticketHubFiltersAdvanced');
        const toggle = document.getElementById('ticketHubFiltersAdvancedToggle');
        const body = document.getElementById('ticketHubFiltersAdvancedBody');

        if (pack) pack.classList.toggle('ticket-hub-filters-pack--mobile', mobile);
        if (advancedWrap) {
            advancedWrap.classList.toggle('ticket-hub-filters-advanced--desktop', !mobile);
        }
        if (toggle) toggle.hidden = !mobile;

        if (wasHubMobileFilterView !== mobile) {
            if (mobile) {
                hubMobileAdvancedOpen = false;
                clampMobileHubAdvancedFilterValues();
            } else {
                hubMobileAdvancedOpen = false;
            }
            wasHubMobileFilterView = mobile;
            if (mobile && typeof window.onTicketHubFilterChange === 'function') {
                window.onTicketHubFilterChange();
            }
        }

        if (mobile) {
            setHubMobileAdvancedOpen(hubMobileAdvancedOpen);
        } else {
            if (body) body.hidden = false;
            syncHubMobileTimeframeOptionVisibility();
            updateHubTimeframeCustomVisibility();
        }
    }

    function parseHubDateStart(value) {
        if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())) return null;
        if (typeof window.pacificYmdHmToUtcMs === 'function') {
            return window.pacificYmdHmToUtcMs(String(value).trim(), 0, 0, 0);
        }
        return null;
    }

    function parseHubDateEnd(value) {
        if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())) return null;
        if (typeof window.pacificYmdHmToUtcMs === 'function') {
            return window.pacificYmdHmToUtcMs(String(value).trim(), 23, 59, 59) + 999;
        }
        return null;
    }

    function parseHubComparableDateMs(value) {
        if (value == null || value === '') return null;
        const d =
            typeof window.parseInstantForDisplay === 'function'
                ? window.parseInstantForDisplay(value)
                : new Date(value);
        if (!d || Number.isNaN(d.getTime())) return null;
        return d.getTime();
    }

    /**
     * Single instant on the ticket used for hub timeframe filtering (custom or last-N-days).
     * @param {'expiration'|'job_start'|'legal_start'} fieldType
     */
    function getHubTicketTimeframeCompareMs(ticket, fieldType) {
        if (!ticket) return null;
        if (fieldType === 'expiration') {
            let end = null;
            if (
                window.ticketImporterModule &&
                typeof window.ticketImporterModule.getTicketExpirationDateForStatus === 'function'
            ) {
                end = window.ticketImporterModule.getTicketExpirationDateForStatus(ticket);
            }
            if (end == null || end === '') end = ticket.endTime;
            return parseHubComparableDateMs(end);
        }
        if (fieldType === 'legal_start') {
            const raw = hubMappedField(ticket, 'legalStartDate', ticket.legalStartDate, ticket.workLegalStartDate);
            return parseHubComparableDateMs(raw);
        }
        /* job_start — work start, else created/updated (matches prior hub + Time Warp style) */
        const candidates = [ticket.startTime, ticket.createdAt, ticket.updatedAt];
        for (let i = 0; i < candidates.length; i++) {
            const ms = parseHubComparableDateMs(candidates[i]);
            if (ms != null) return ms;
        }
        return null;
    }

    function matchesHubTimeframe(ticket, timeframe) {
        if (!timeframe || timeframe === 'all') return true;
        if (typeof hubStatusFilterIsExpiredOnly === 'function' && hubStatusFilterIsExpiredOnly()) {
            return true;
        }
        const ms = getHubTicketTimeframeCompareMs(ticket, getHubTimeframeFieldType());
        if (ms == null) return false;
        if (timeframe === 'custom') {
            const fromEl = document.getElementById('ticketHubFromDate');
            const toEl = document.getElementById('ticketHubToDate');
            const startMs = parseHubDateStart(fromEl && fromEl.value);
            const endMs = parseHubDateEnd(toEl && toEl.value);
            if (startMs != null && ms < startMs) return false;
            if (endMs != null && ms > endMs) return false;
            return true;
        }
        const days = parseHubTimeframeDays(timeframe);
        if (days == null) return true;
        if (typeof window.addPacificYmdDays === 'function' && typeof window.pacificYmdHmToUtcMs === 'function') {
            const fromYmd = window.addPacificYmdDays(formatHubDateIsoLocal(new Date()), -(days - 1));
            return ms >= window.pacificYmdHmToUtcMs(fromYmd, 0, 0, 0);
        }
        return ms >= Date.now() - days * 24 * 60 * 60 * 1000;
    }

    function formatHubDateIsoLocal(d) {
        if (typeof window.getPacificYmd === 'function') {
            return window.getPacificYmd(d || new Date());
        }
        const dt = d || new Date();
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const day = String(dt.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function hubPacificDaysAgoYmd(daysBack) {
        const todayYmd = formatHubDateIsoLocal(new Date());
        if (typeof window.addPacificYmdDays === 'function') {
            return window.addPacificYmdDays(todayYmd, -daysBack);
        }
        const start = new Date();
        start.setDate(start.getDate() - daysBack);
        return formatHubDateIsoLocal(start);
    }

    /**
     * Calendar range for GET /tickets?expiredOnly=1 (hub server fetch).
     * Uses the selected Timeframe type (expiration / job start / legal start).
     * Timeframe "all" uses the full hub expired window ({@link HUB_EXPIRED_RANGE_MAX_DAYS} days).
     * @returns {{ from: string, to: string, dateField: 'expiration'|'job_start'|'legal_start' }}
     */
    function resolveHubExpiredDateRange() {
        const timeframe = getHubTimeframeFilter();
        const dateField = getHubTimeframeFieldType();
        const today = new Date();
        let to = formatHubDateIsoLocal(today);
        let from;
        if (timeframe === 'all') {
            from = hubPacificDaysAgoYmd(HUB_EXPIRED_RANGE_MAX_DAYS - 1);
        } else if (timeframe === 'custom') {
            const fromEl = document.getElementById('ticketHubFromDate');
            const toEl = document.getElementById('ticketHubToDate');
            from = fromEl && fromEl.value ? String(fromEl.value).trim() : '';
            if (toEl && toEl.value) to = String(toEl.value).trim();
            if (!from) {
                from = hubPacificDaysAgoYmd(HUB_EXPIRED_RANGE_MAX_DAYS - 1);
            }
        } else {
            const days = parseHubTimeframeDays(timeframe);
            const d = days != null ? days : 14;
            from = hubPacificDaysAgoYmd(d - 1);
        }
        return { from, to, dateField };
    }

    /** True when EXPIRED is among the selected status filters (sole or combined with others). */
    function hubStatusFilterIncludesExpired() {
        return !!(hubStatusFilters && hubStatusFilters.has('EXPIRED'));
    }

    /** True when hub shows the expired paginated list (sole EXPIRED status filter). */
    function hubStatusFilterNeedsExpiredFetch() {
        return hubStatusFilterIsExpiredOnly();
    }

    function hubStatusFilterIsExpiredOnly() {
        return !!(hubStatusFilters && hubStatusFilters.size === 1 && hubStatusFilters.has('EXPIRED'));
    }

    function hubStatusFilterIsCombinedTotal() {
        return !!(hubStatusFilters && (hubStatusFilters.size === 0 || hubStatusFilters.has('ALL')));
    }

    /** True when hub shows the active paginated list (default and non-expired status filters). */
    function hubStatusFilterNeedsActiveFetch() {
        return !hubStatusFilterIsExpiredOnly() && !hubStatusFilterIsCombinedTotal();
    }

    /** @returns {'active'|'expired'|'combined'} */
    function hubListPagerMode() {
        if (hubStatusFilterIsExpiredOnly()) return 'expired';
        if (hubStatusFilterIsCombinedTotal()) return 'combined';
        return 'active';
    }

    /** Human-readable window for expired-only list footer. */
    function formatHubExpiredRangeDescription() {
        const timeframe = getHubTimeframeFilter();
        const range = resolveHubExpiredDateRange();
        const dateField = range.dateField;
        let windowPhrase;
        if (timeframe === 'all') {
            windowPhrase = `the last ${HUB_EXPIRED_RANGE_MAX_DAYS} days`;
        } else if (timeframe === 'custom') {
            windowPhrase = `${range.from} through ${range.to}`;
        } else {
            const days = parseHubTimeframeDays(timeframe);
            windowPhrase = days != null ? `the last ${days} days` : 'the selected date range';
        }
        let fieldPhrase = 'expired';
        if (dateField === 'job_start') fieldPhrase = 'with job start';
        else if (dateField === 'legal_start') fieldPhrase = 'with legal start';
        else if (dateField === 'expiration') fieldPhrase = 'by expiration date';
        return { windowPhrase, fieldPhrase, dateField, range };
    }

    function getTicketOwnerOrgId(ticket) {
        if (!ticket) return null;
        if (ticket.organizationId != null && ticket.organizationId !== '') return Number(ticket.organizationId);
        if (ticket.sharedFromOrganizationId != null && ticket.sharedFromOrganizationId !== '') {
            return Number(ticket.sharedFromOrganizationId);
        }
        const hubOrgId = getHubOrganizationId();
        return hubOrgId != null && hubOrgId !== '' ? Number(hubOrgId) : null;
    }

    function getOwnerOrgLabel(orgId) {
        const orgs =
            window.orgSelectorModule && typeof window.orgSelectorModule.getOrganizations === 'function'
                ? window.orgSelectorModule.getOrganizations()
                : [];
        const match = Array.isArray(orgs) ? orgs.find(o => Number(o.id) === Number(orgId)) : null;
        return (match && (match.name || match.publicCatalogDisplayName)) || `Org ${orgId}`;
    }

    function populateHubOwnerOrgFilter() {
        const field = document.getElementById('ticketHubOwnerOrgField');
        const select = document.getElementById('ticketHubOwnerOrgFilter');
        if (!field || !select) return;
        const ownerIds = Array.from(
            new Set(
                (window.ORG_TICKETS || [])
                    .map(getTicketOwnerOrgId)
                    .filter(id => id != null && Number.isFinite(Number(id)))
                    .map(id => Number(id))
            )
        ).sort((a, b) => String(getOwnerOrgLabel(a)).localeCompare(String(getOwnerOrgLabel(b))));
        const shouldShow = ownerIds.length > 1;
        field.hidden = !shouldShow;
        if (!shouldShow) {
            select.value = 'all';
            return;
        }
        const current = select.value || 'all';
        select.innerHTML = '<option value="all">All owner orgs</option>';
        ownerIds.forEach(orgId => {
            const opt = document.createElement('option');
            opt.value = String(orgId);
            opt.textContent = getOwnerOrgLabel(orgId);
            select.appendChild(opt);
        });
        select.value = Array.from(select.options).some(o => o.value === current) ? current : 'all';
    }

    function getHubOwnerOrgFilter() {
        const field = document.getElementById('ticketHubOwnerOrgField');
        if (field && field.hidden) return 'all';
        const el = document.getElementById('ticketHubOwnerOrgFilter');
        return el && el.value ? String(el.value) : 'all';
    }

    function matchesHubOwnerOrgFilter(ticket, ownerFilter) {
        if (!ownerFilter || ownerFilter === 'all') return true;
        const ownerId = getTicketOwnerOrgId(ticket);
        return ownerId != null && Number(ownerId) === Number(ownerFilter);
    }

    function normalizeSubmitterToken(value) {
        if (value == null) return '';
        return String(value).trim().toLowerCase();
    }

    function submitterTokensMatch(a, b) {
        const na = normalizeSubmitterToken(a);
        const nb = normalizeSubmitterToken(b);
        if (!na || !nb) return false;
        if (na === nb) return true;
        const la = na.indexOf('@') >= 0 ? na.split('@')[0] : na;
        const lb = nb.indexOf('@') >= 0 ? nb.split('@')[0] : nb;
        return la.length >= 3 && lb.length >= 3 && la === lb;
    }

    function ticketOriginalLodgedByUserName(ticket) {
        if (!ticket || ticket.originalLodgedByUserName == null) return '';
        return String(ticket.originalLodgedByUserName).trim();
    }

    function getHubSubmittedByFilter() {
        const el = document.getElementById('ticketHubSubmittedByFilter');
        return el && el.value ? String(el.value) : 'all';
    }

    function matchesHubSubmittedByFilter(ticket, filterVal) {
        if (!filterVal || filterVal === 'all') return true;
        const orig = ticketOriginalLodgedByUserName(ticket);
        if (filterVal === '__blank__') return orig === '';
        return submitterTokensMatch(orig, filterVal);
    }

    function getHubSubmitterFilterTicketPool() {
        const pools = [];
        if (typeof getHubTicketsPoolForFilter === 'function') {
            try {
                const fromFilter = getHubTicketsPoolForFilter();
                if (Array.isArray(fromFilter)) pools.push(...fromFilter);
            } catch (_) {
                /* fall through */
            }
        }
        if (Array.isArray(window.ORG_TICKETS)) pools.push(...window.ORG_TICKETS);
        if (Array.isArray(window.HUB_EXPIRED_TICKETS)) pools.push(...window.HUB_EXPIRED_TICKETS);
        if (Array.isArray(window.HUB_COMBINED_TICKETS)) pools.push(...window.HUB_COMBINED_TICKETS);
        const seen = new Set();
        const out = [];
        pools.forEach(t => {
            if (!t) return;
            const id = t.id != null ? String(t.id) : '';
            const dedupeKey = id || String(t.ticketNumber || '');
            if (!dedupeKey || seen.has(dedupeKey)) return;
            seen.add(dedupeKey);
            out.push(t);
        });
        return out;
    }

    function ensureHubSubmittedByFilterOption(select, value) {
        if (!select || value == null || value === '' || value === 'all') return;
        const val = String(value);
        if (Array.from(select.options).some(o => o.value === val)) return;
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val === '__blank__' ? 'Unknown / blank' : val;
        const blankOpt = select.querySelector('option[value="__blank__"]');
        if (blankOpt && blankOpt.nextSibling) {
            select.insertBefore(opt, blankOpt.nextSibling);
        } else if (select.options.length > 0) {
            select.insertBefore(opt, select.options[1] || null);
        } else {
            select.appendChild(opt);
        }
    }

    function populateHubSubmittedByFilter() {
        const select = document.getElementById('ticketHubSubmittedByFilter');
        if (!select) return;
        const current = select.value || 'all';
        const tickets = getHubSubmitterFilterTicketPool();
        const byKey = new Map();
        let hasBlank = false;
        tickets.forEach(t => {
            const raw = ticketOriginalLodgedByUserName(t);
            if (!raw) {
                hasBlank = true;
                return;
            }
            const key = normalizeSubmitterToken(raw);
            if (!key) {
                hasBlank = true;
                return;
            }
            if (!byKey.has(key)) byKey.set(key, raw);
        });
        select.innerHTML = '<option value="all">All submitters</option>';
        if (hasBlank) {
            const blankOpt = document.createElement('option');
            blankOpt.value = '__blank__';
            blankOpt.textContent = 'Unknown / blank';
            select.appendChild(blankOpt);
        }
        Array.from(byKey.entries())
            .sort((a, b) => String(a[1]).localeCompare(String(b[1]), undefined, { sensitivity: 'base' }))
            .forEach(([, label]) => {
                const opt = document.createElement('option');
                opt.value = label;
                opt.textContent = label;
                select.appendChild(opt);
            });
        ensureHubSubmittedByFilterOption(select, current);
        select.value =
            current && Array.from(select.options).some(o => o.value === current) ? current : 'all';
    }

    function syncHubFilterControls(opts) {
        updateHubTimeframeCustomVisibility();
        populateHubOwnerOrgFilter();
        populateHubSubmittedByFilter();
        if (!(opts && opts.skipMobileConstraints)) {
            syncHubMobileFilterConstraints();
        }
    }

    /** External = shared-in or lodged-by mismatch. Internal = lodged by org provider account and not shared. */
    function matchesHubOrgScope(ticket, scope) {
        if (!scope || scope === 'all') return true;
        if (scope === 'external') return isHubTicketExternalForOrg(ticket);
        if (scope === 'shared_partner') return !!(ticket && ticket.shared);
        if (scope === 'active_internal') {
            const inactive =
                window.ticketsModule && typeof window.ticketsModule.isInactiveWorkflowStatus === 'function'
                    ? window.ticketsModule.isInactiveWorkflowStatus(ticket.status)
                    : ticket.status === 'EXPIRED' || ticket.status === 'CANCELLED';
            return isHubTicketInternalForOrg(ticket) && !inactive;
        }
        return true;
    }

    function getHubSearch() {
        const el = document.getElementById('ticketHubSearch');
        return el ? el.value.trim().toLowerCase() : '';
    }

    function hubTicketIsInactive(ticket) {
        const status =
            typeof getHubEffectiveStatus === 'function' ? getHubEffectiveStatus(ticket) : ticket && ticket.status;
        if (window.ticketsModule && typeof window.ticketsModule.isInactiveWorkflowStatus === 'function') {
            return window.ticketsModule.isInactiveWorkflowStatus(status);
        }
        return status === 'EXPIRED' || status === 'CANCELLED';
    }

    function matchesSingleHubStatusFilter(ticket, filterVal) {
        if (filterVal === 'ALL') return true;
        if (filterVal === 'ACTIVE') return !hubTicketIsInactive(ticket);
        if (filterVal === 'ASSIGNED') {
            const currentUser = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
            const myId = currentUser && currentUser.id;
            return !hubTicketIsInactive(ticket) && isAssignedToUser(ticket, myId);
        }
        const status =
            typeof getHubEffectiveStatus === 'function' ? getHubEffectiveStatus(ticket) : ticket && ticket.status;
        return status === filterVal;
    }

    /** OR semantics: ticket matches if it matches any selected filter. Empty set shows all. */
    function matchesHubStatusFilters(ticket, filters) {
        if (!filters || filters.size === 0) return true;
        if (filters.has('ALL')) return true;
        for (const f of filters) {
            if (matchesSingleHubStatusFilter(ticket, f)) return true;
        }
        return false;
    }

    function matchesAssigneeFilter(ticket, filterVal) {
        if (!filterVal || filterVal === 'all') return true;
        if (filterVal === 'unassigned') return !hasAnyAssignee(ticket);
        if (filterVal === 'assigned') return hasAnyAssignee(ticket);
        const uid = parseInt(filterVal, 10);
        if (isNaN(uid)) return true;
        return isAssignedToUser(ticket, uid);
    }

    function matchesHubSearch(ticket, q) {
        if (!q) return true;
        const tn = (ticket.ticketNumber || '').toLowerCase();
        if (tn.includes(q)) return true;
        const base = normalizeHubTicketBase(ticket.ticketNumber).toLowerCase();
        if (base && base.includes(q)) return true;
        const fields = [
            ticket.locationSummary,
            ticket.workDescription,
            ticket.address,
            ticket.workActivity,
            ticket.workType,
            hubMappedField(ticket, 'digSiteAddress', ticket.address, ticket.locationSummary),
            hubMappedField(ticket, 'jobName', ticket.jobName),
        ];
        return fields.some(f => f && String(f).toLowerCase().includes(q));
    }

    function rebuildHubSearchPolygonLeaflet() {
        hubSearchPolygonLeaflet = null;
        if (
            !hubSearchPolygonGeo ||
            hubSearchPolygonGeo.type !== 'Polygon' ||
            !hubSearchPolygonGeo.coordinates ||
            !hubSearchPolygonGeo.coordinates[0]
        ) {
            return;
        }
        try {
            const ring = hubSearchPolygonGeo.coordinates[0];
            const latlngs = ring.map(c => L.latLng(c[1], c[0]));
            hubSearchPolygonLeaflet = L.polygon(latlngs);
        } catch (e) {
            hubSearchPolygonLeaflet = null;
        }
    }

    function syncHubSearchPolygonMapLayer() {
        const map = window.map;
        if (hubSearchPolygonMapLayer && map) {
            try {
                map.removeLayer(hubSearchPolygonMapLayer);
            } catch (e) {
                /* ignore */
            }
            hubSearchPolygonMapLayer = null;
        }
        if (!hubSearchPolygonGeo || !map) return;
        try {
            const ring = hubSearchPolygonGeo.coordinates[0];
            const latlngs = ring.map(c => [c[1], c[0]]);
            hubSearchPolygonMapLayer = L.polygon(latlngs, {
                color: '#a78bfa',
                weight: 2,
                fill: false,
                className: 'ticket-hub-search-polygon-layer',
                pane: 'overlayPane'
            }).addTo(map);
        } catch (e) {
            hubSearchPolygonMapLayer = null;
        }
    }

    function ticketOverlapsHubSearchPolygon(ticket, queryLeafletPolygon) {
        if (!queryLeafletPolygon || !ticket || !ticket.polygon) return false;
        const tqm = window.tableQueriesModule;
        if (!tqm || typeof tqm.documentIntersectsPolygon !== 'function' || typeof tqm.isPointInPolygon !== 'function') {
            return true;
        }
        const geo = ticket.polygon;
        try {
            if (geo.type === 'Polygon') {
                if (tqm.documentIntersectsPolygon(geo, queryLeafletPolygon)) return true;
            } else if (geo.type === 'MultiPolygon') {
                for (let i = 0; i < geo.coordinates.length; i++) {
                    const part = { type: 'Polygon', coordinates: geo.coordinates[i] };
                    if (tqm.documentIntersectsPolygon(part, queryLeafletPolygon)) return true;
                }
            } else {
                return false;
            }
            const gj = L.geoJSON(geo);
            const qRing = queryLeafletPolygon.getLatLngs()[0];
            let inside = false;
            gj.eachLayer(function (lay) {
                if (inside || !(lay instanceof L.Polygon)) return;
                for (let i = 0; i < qRing.length; i++) {
                    const p = qRing[i];
                    if (lay.getBounds().contains(p) && tqm.isPointInPolygon(p, lay)) {
                        inside = true;
                        break;
                    }
                }
            });
            return inside;
        } catch (e) {
            return false;
        }
    }

    function updateHubSearchPolygonButtons() {
        const clearBtn = document.getElementById('ticketHubClearSearchArea');
        if (clearBtn) clearBtn.disabled = !hubSearchPolygonGeo;
    }

    function clearTicketHubSearchPolygon() {
        hubSearchPolygonGeo = null;
        hubSearchPolygonLeaflet = null;
        if (hubSearchPolygonMapLayer && window.map) {
            try {
                window.map.removeLayer(hubSearchPolygonMapLayer);
            } catch (e) {
                /* ignore */
            }
        }
        hubSearchPolygonMapLayer = null;
        updateHubSearchPolygonButtons();
        onHubFilterChange();
    }

    function syncHubPolygonDrawMapTools() {
        if (typeof window.syncMapToolActionVisibility === 'function') {
            window.syncMapToolActionVisibility();
        }
    }

    function isTicketHubSearchPolygonDrawingActive() {
        return typeof hubPolygonDrawingCleanup === 'function';
    }

    function finishTicketHubSearchPolygonDrawingIfActive() {
        if (typeof hubPolygonDrawingFinish !== 'function') return;
        const fn = hubPolygonDrawingFinish;
        void Promise.resolve()
            .then(function () {
                return fn();
            })
            .catch(function (err) {
                console.error('Ticket hub: finish search-area from strip', err);
            });
    }

    function cancelHubPolygonDrawingIfDrawing() {
        if (typeof hubPolygonDrawingCleanup === 'function') {
            try {
                hubPolygonDrawingCleanup();
            } catch (e) {
                /* ignore */
            }
            hubPolygonDrawingCleanup = null;
            hubPolygonDrawingFinish = null;
            syncHubPolygonDrawMapTools();
        }
    }

    function startTicketHubPolygonDrawing() {
        if (!isTicketHubAccessible()) {
            if (typeof window.appAlert === 'function') window.appAlert('Ticket hub is not available for your role.');
            return;
        }
        const map = window.map;
        if (!map) {
            if (typeof window.appAlert === 'function') window.appAlert('Map is not ready.');
            return;
        }
        if (typeof window.createTicketWizardCancelPolygonDrawingIfActive === 'function') {
            window.createTicketWizardCancelPolygonDrawingIfActive();
        }
        cancelHubPolygonDrawingIfDrawing();
        if (window.measureModule && window.measureModule.cancelMeasureMode) {
            window.measureModule.cancelMeasureMode();
        }
        if (window.drawingModule && window.drawingModule.cancelDrawingMode) {
            window.drawingModule.cancelDrawingMode();
        }
        if (window.photosModule && window.photosModule.cancelPhotoUpload) {
            window.photosModule.cancelPhotoUpload();
        }

        hubTempClosedForPolygonDraw = false;
        if (window.closeTicketHubWindow) {
            window.closeTicketHubWindow();
            hubTempClosedForPolygonDraw = true;
        }

        let queryPoints = [];
        const queryLayer = L.layerGroup().addTo(map);
        window.mapQueryPolygonDrawing = true;
        map.getContainer().style.cursor = 'crosshair';
        syncHubPolygonDrawMapTools();

        let cancelHandler = null;
        let hubSearchPolygonFinishing = false;

        async function finishTicketHubPolygon() {
            if (hubSearchPolygonFinishing) return;
            if (queryPoints.length < 3) {
                if (typeof window.appAlert === 'function') window.appAlert('A polygon needs at least 3 points.');
                return;
            }
            hubSearchPolygonFinishing = true;
            hubPolygonDrawingFinish = null;
            const coords = queryPoints.map(p => [p.lng, p.lat]);
            coords.push(coords[0]);
            hubSearchPolygonGeo = {
                type: 'Polygon',
                coordinates: [coords]
            };
            hubStatusFilters = new Set(['ALL']);
            const assignEl = document.getElementById('ticketHubAssigneeFilter');
            if (assignEl) assignEl.value = 'all';

            rebuildHubSearchPolygonLeaflet();
            map.off('click', queryClickHandler);
            if (cancelHandler) window.removeEventListener('keydown', cancelHandler);
            map.removeLayer(queryLayer);
            map.getContainer().style.cursor = '';
            window.mapQueryPolygonDrawing = false;
            hubPolygonDrawingCleanup = null;
            hubPolygonDrawingFinish = null;
            hubTempClosedForPolygonDraw = false;
            syncHubPolygonDrawMapTools();

            syncHubSearchPolygonMapLayer();
            updateHubSearchPolygonButtons();

            const reopenOpts = { skipPacPoll: true, skipServerTicketLoad: true, reopenFromPolygonDraw: true };
            if (window.openTicketHubWindow) {
                try {
                    await window.openTicketHubWindow(reopenOpts);
                } catch (err) {
                    console.warn('Ticket hub: reopen after polygon draw', err);
                }
                const win = document.getElementById('ticketHubWindow');
                if (win && !win.classList.contains('show')) {
                    hubSuppressOutsideCloseUntil = Date.now() + 900;
                    win.classList.add('show');
                    if (typeof window.relocateTicketHubFiltersPack === 'function') window.relocateTicketHubFiltersPack();
                    if (typeof window.onTicketHubFilterChange === 'function') window.onTicketHubFilterChange();
                    if (window.renderTickets) window.renderTickets();
                }
            } else {
                onHubFilterChange();
            }
        }

        const queryClickHandler = function (e) {
            L.DomEvent.stopPropagation(e);
            queryPoints.push(e.latlng);
            queryLayer.clearLayers();
            queryPoints.forEach((point, index) => {
                const isLast = index === queryPoints.length - 1;
                const marker = L.marker(point, {
                    icon: L.divIcon({
                        className: 'query-marker',
                        html:
                            '<div style="background-color: ' +
                            (isLast ? 'var(--app-success)' : 'var(--app-accent)') +
                            '; width: ' +
                            (isLast ? '20' : '12') +
                            'px; height: ' +
                            (isLast ? '20' : '12') +
                            'px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: ' +
                            (isLast ? '12' : '0') +
                            'px; font-weight: bold; cursor: ' +
                            (isLast ? 'pointer' : 'default') +
                            ';">' +
                            (isLast ? window.TICKET_HUB_TEXT.CHECK : '') +
                            '</div>',
                        iconSize: [isLast ? 20 : 12, isLast ? 20 : 12],
                        iconAnchor: [isLast ? 10 : 6, isLast ? 10 : 6]
                    })
                });
                if (isLast) {
                    marker.on('click', function () {
                        finishTicketHubPolygon().catch(function (err) {
                            console.error('Ticket hub: finish polygon', err);
                        });
                    });
                }
                queryLayer.addLayer(marker);
            });
            if (queryPoints.length >= 2) {
                const poly = L.polygon(
                    queryPoints.map(p => [p.lat, p.lng]),
                    {
                        color: '#a78bfa',
                        weight: 3,
                        fill: false,
                        dashArray: '5, 5'
                    }
                );
                queryLayer.addLayer(poly);
            }
        };

        cancelHandler = function (e) {
            if (e.key === 'Escape') {
                map.off('click', queryClickHandler);
                window.removeEventListener('keydown', cancelHandler);
                map.removeLayer(queryLayer);
                map.getContainer().style.cursor = '';
                window.mapQueryPolygonDrawing = false;
                hubPolygonDrawingCleanup = null;
                hubPolygonDrawingFinish = null;
                syncHubPolygonDrawMapTools();
                if (hubTempClosedForPolygonDraw && window.openTicketHubWindow) {
                    hubTempClosedForPolygonDraw = false;
                    void window.openTicketHubWindow({
                        skipPacPoll: true,
                        skipServerTicketLoad: true,
                        reopenFromPolygonDraw: true
                    });
                }
            }
        };

        hubPolygonDrawingCleanup = function () {
            map.off('click', queryClickHandler);
            if (cancelHandler) window.removeEventListener('keydown', cancelHandler);
            try {
                map.removeLayer(queryLayer);
            } catch (e) {
                /* ignore */
            }
            map.getContainer().style.cursor = '';
            window.mapQueryPolygonDrawing = false;
            if (hubTempClosedForPolygonDraw && window.openTicketHubWindow) {
                hubTempClosedForPolygonDraw = false;
                void window.openTicketHubWindow({
                    skipPacPoll: true,
                    skipServerTicketLoad: true,
                    reopenFromPolygonDraw: true
                });
            }
            hubPolygonDrawingFinish = null;
            syncHubPolygonDrawMapTools();
        };

        hubPolygonDrawingFinish = finishTicketHubPolygon;
        map.on('click', queryClickHandler);
        window.addEventListener('keydown', cancelHandler);
    }

    window.resolveHubExpiredDateRange = resolveHubExpiredDateRange;
    window.getHubTimeframeFieldType = getHubTimeframeFieldType;
    window.normalizeHubListSort = normalizeHubListSort;
    window.syncHubMobileFilterConstraints = syncHubMobileFilterConstraints;
    window.toggleHubMobileAdvancedFilters = toggleHubMobileAdvancedFilters;
    window.collapseHubMobileAdvancedFilters = collapseHubMobileAdvancedFilters;
    window.clampMobileHubAdvancedFilterValues = clampMobileHubAdvancedFilterValues;
    window.hubStatusFilterIncludesExpired = hubStatusFilterIncludesExpired;
    window.hubStatusFilterNeedsExpiredFetch = hubStatusFilterNeedsExpiredFetch;
    window.hubStatusFilterNeedsActiveFetch = hubStatusFilterNeedsActiveFetch;
    window.hubStatusFilterIsExpiredOnly = hubStatusFilterIsExpiredOnly;
    window.hubStatusFilterIsCombinedTotal = hubStatusFilterIsCombinedTotal;
    window.hubListPagerMode = hubListPagerMode;
    window.formatHubExpiredRangeDescription = formatHubExpiredRangeDescription;
    window.isTicketHubSearchPolygonDrawingActive = isTicketHubSearchPolygonDrawingActive;
    window.finishTicketHubSearchPolygonDrawingIfActive = finishTicketHubSearchPolygonDrawingIfActive;

